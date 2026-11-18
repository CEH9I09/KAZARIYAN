import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { stageById, planImport, patchContact, readBackup } from './crm-model.mjs';

const html = readFileSync(new URL('./web/index.html', import.meta.url));
const lifetime = 12 * 60 * 60;
const bodyLimit = 24 * 1024 * 1024;
const derive = promisify(scrypt);
const random = (size = 32) => randomBytes(size).toString('base64url');
const sha = value => createHash('sha256').update(value).digest('hex');
const secureEqual = (left, right) => timingSafeEqual(Buffer.from(sha(left),'hex'),Buffer.from(sha(right),'hex'));
const brief = (value,size=600) => typeof value === 'string' ? value.trim().slice(0,size) : '';
const emailOf = value => brief(value,254).toLowerCase();
const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const goodPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128;
const dummySalt = random(16);

function passwordKey(password,salt) {
  return derive(password,salt,32,{N:131072,r:8,p:1,maxmem:145 * 1024 * 1024});
}
function error(status,message) {
  throw Object.assign(new Error(message),{status});
}
const defensiveHeaders = {
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',
  'Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};
function json(data,status=200,headers={}) {
  return new Response(JSON.stringify(data),{status,headers:{...defensiveHeaders,'Content-Type':'application/json; charset=utf-8',...headers}});
}
async function input(request) {
  if(!request.headers.get('content-type')?.startsWith('application/json')) error(415,'Ожидается JSON.');
  if(Number(request.headers.get('content-length')) > bodyLimit) error(413,'Файл слишком большой.');
  const reader = request.body?.getReader();
  if(!reader) error(400,'Пустой запрос.');
  const parts = [];
  let size = 0;
  for(;;) {
    const {done,value} = await reader.read();
    if(done) break;
    size += value.byteLength;
    if(size > bodyLimit) { await reader.cancel(); error(413,'Файл слишком большой.'); }
    parts.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(parts,size).toString());
    if(!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
    return body;
  } catch { error(400,'Не удалось прочитать запрос.'); }
}
function importedRow(row) {
  if(!row || typeof row !== 'object') error(400,'В файле есть некорректные строки.');
  const text = Object.fromEntries(['name','phone','job','date','sourceId','adId'].map(field => [field,brief(row[field])]));
  if(!text.name && !text.phone) error(400,'В строке отсутствуют имя и телефон.');
  const extra = Array.isArray(row.extra) ? row.extra.slice(0,100).filter(item => Array.isArray(item) && item.length===2)
    .map(([key,value]) => [brief(key,256),brief(value,4000)]) : [];
  return {...text,extra};
}
function parseImport(body) {
  if(!Array.isArray(body.contacts) || body.contacts.length > 25000) error(400,'Поддерживается до 25 000 строк за импорт.');
  let contacts, logs;
  if(body.restore === true) {
    try {
      const data = readBackup({format:'otklik-crm',version:1,contacts:body.contacts,imports:body.logs??[]});
      contacts = data.contacts;
      logs = data.logs;
    } catch { error(400,'Не удалось прочитать резервную копию.'); }
  } else contacts = body.contacts.map(importedRow);
  return {
    contacts,logs,restore:body.restore === true,file:brief(body.file,200),sheet:brief(body.sheet,120),
    skipped:Number.isSafeInteger(body.skipped) && body.skipped>=0 ? body.skipped : 0
  };
}

export function makeApp({ filename=':memory:', origin='http://127.0.0.1:3080', setupCode=random(20) }={}) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=4000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','staff')),
      salt TEXT NOT NULL, pass TEXT NOT NULL, temporary INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_owner ON accounts(role) WHERE role='owner';
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, assignee TEXT REFERENCES accounts(id), data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS contact_assignee ON contacts(assignee);
    CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS site_revision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO site_revision VALUES(1,0);
  `);
  const sql = query => db.prepare(query);
  const announce = sql('UPDATE site_revision SET revision=revision+1 WHERE id=1');
  const hasOwner = () => Boolean(sql("SELECT id FROM accounts WHERE role='owner'").get());
  const projection = account => ({id:account.id,name:account.name,email:account.email,role:account.role,temporary:Boolean(account.temporary)});
  const accountByEmail = sql('SELECT * FROM accounts WHERE email=?');
  const accountById = sql('SELECT * FROM accounts WHERE id=?');
  const cookieName = origin.startsWith('https:') ? '__Host-zemlya' : 'zemlya-local';
  const cookie = (token,age) => cookieName+'='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+age+(origin.startsWith('https:') ? '; Secure' : '');
  const decodeRow = row => ({...JSON.parse(row.data),assignee:row.assignee});
  const contactsAll = sql('SELECT * FROM contacts');
  const contactOne = sql('SELECT * FROM contacts WHERE id=?');
  const leadsOf = sql('SELECT * FROM contacts WHERE assignee=?');
  const put = sql('INSERT INTO contacts(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data');
  const update = sql('UPDATE contacts SET data=? WHERE id=?');
  const limits = new Map();
  let hashing = 0;
  function nearAuth(peer,task) {
    const now = Date.now();
    for(const [key,bucket] of limits) if(bucket.until <= now) limits.delete(key);
    const bucket = limits.get(peer) ?? {count:0,until:now+60000};
    if(bucket.count >= 8 || limits.size >= 10000 || hashing >= 2) error(429,'Слишком много попыток. Подождите минуту.');
    bucket.count++;
    limits.set(peer,bucket);
    hashing++;
    return Promise.resolve().then(task).finally(()=>{hashing--;});
  }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch(cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
  }
  function sessionToken(request) {
    const header = request.headers.get('cookie') ?? '';
    return header.split(';').map(value=>value.trim()).find(value=>value.startsWith(cookieName+'='))?.slice(cookieName.length+1) ?? '';
  }
  function accountFor(token) {
    if(!/^[\w-]{43}$/.test(token)) return null;
    return sql('SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.account WHERE s.token=? AND s.expires>? AND a.active=1').get(sha(token),Date.now());
  }
  function login(account) {
    const token = random();
    sql('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    sql('INSERT INTO sessions(token,account,expires) VALUES(?,?,?)').run(sha(token),account.id,Date.now()+lifetime*1000);
    return json({account:projection(account)},200,{'Set-Cookie':cookie(token,lifetime)});
  }
  function owner(account) {
    if(account.role !== 'owner') error(403,'Действие доступно администратору.');
  }
  function ownLead(account,id) {
    const row = contactOne.get(id);
    if(!row || (account.role !== 'owner' && row.assignee !== account.id)) error(404,'Карточка недоступна.');
    return row;
  }
  function addUser({name,email,role,salt,pass,temporary}) {
    if(accountByEmail.get(email)) error(409,'Этот логин уже занят.');
    const id = random(16);
    sql('INSERT INTO accounts(id,name,email,role,salt,pass,temporary) VALUES(?,?,?,?,?,?,?)').run(id,name,email,role,salt,pass,temporary);
    return accountById.get(id);
  }

  async function handle(request,peer='local') {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      if(path === '/' && method === 'GET') return new Response(html,{headers:{...defensiveHeaders,'Content-Type':'text/html; charset=utf-8'}});
      if(!path.startsWith('/api/')) return json({error:'Страница не найдена.'},404);
      if(method !== 'GET' && request.headers.get('origin') !== origin) error(403,'Откройте CRM по её рабочему адресу.');
      const token = sessionToken(request);
      const account = accountFor(token);
      if(method === 'GET' && path === '/api/session') return json({account:account ? projection(account) : null,setup:!hasOwner()});
      if(method === 'POST' && path === '/api/setup') {
        const body = await input(request);
        const name = brief(body.name,120);
        const email = emailOf(body.email);
        if(!name || !validEmail(email) || !goodPassword(body.password)) error(400,'Введите имя, почту и пароль от 12 символов.');
        if(hasOwner()) error(409,'Администратор уже настроен.');
        const salt = random(16);
        const pass = await nearAuth(peer,async () => {
          if(!secureEqual(brief(body.code,128),setupCode)) error(403,'Код настройки неверен.');
          return (await passwordKey(body.password,salt)).toString('hex');
        });
        const created = transaction(() => {
          if(hasOwner()) error(409,'Администратор уже настроен.');
          return addUser({name,email,role:'owner',salt,pass,temporary:0});
        });
        return login(created);
      }
      if(method === 'POST' && path === '/api/login') {
        const body = await input(request);
        const user = accountByEmail.get(emailOf(body.email));
        const valid = typeof body.password === 'string' && body.password.length <= 128;
        const matched = await nearAuth(peer,async () => {
          const actual = await passwordKey(valid ? body.password : '',user?.salt ?? dummySalt);
          return Boolean(valid && user?.active && timingSafeEqual(actual,Buffer.from(user.pass,'hex')));
        });
        const fresh = matched ? accountById.get(user.id) : null;
        if(!fresh?.active || fresh.pass!==user.pass) error(401,'Логин или пароль неверны.');
        return login(fresh);
      }
      if(!account) error(401,'Войдите в CRM.');
      if(method === 'POST' && path === '/api/logout') {
        sql('DELETE FROM sessions WHERE token=?').run(sha(token));
        return json({ok:true},200,{'Set-Cookie':cookie('',0)});
      }
      if(method === 'POST' && path === '/api/password') {
        const body = await input(request);
        if(!goodPassword(body.password) || typeof body.current !== 'string' || body.current.length>128 || body.password===body.current)
          error(400,'Новый пароль должен отличаться от старого и содержать от 12 до 128 символов.');
        const salt = random(16);
        const pass = await nearAuth(peer,async () => {
          const actual = await passwordKey(body.current,account.salt);
          if(!timingSafeEqual(actual,Buffer.from(account.pass,'hex'))) error(403,'Текущий пароль неверен.');
          return (await passwordKey(body.password,salt)).toString('hex');
        });
        transaction(() => {
          if(accountById.get(account.id).pass !== account.pass || !accountFor(token)) error(401,'Войдите в CRM ещё раз.');
          sql('UPDATE accounts SET salt=?,pass=?,temporary=0 WHERE id=?').run(salt,pass,account.id);
          sql('DELETE FROM sessions WHERE account=?').run(account.id);
        });
        return login(accountById.get(account.id));
      }
      if(account.temporary) error(403,'Установите свой пароль.');
      if(method === 'GET' && path === '/api/workspace') {
        const revision = sql('SELECT revision FROM site_revision WHERE id=1').get().revision;
        if(String(revision) === url.searchParams.get('since')) return json({revision});
        const isOwner = account.role === 'owner';
        const contacts = (isOwner ? contactsAll.all() : leadsOf.all(account.id)).map(decodeRow);
        const imports = isOwner ? sql('SELECT data FROM imports').all().map(row=>JSON.parse(row.data)) : [];
        const members = isOwner ? sql("SELECT id,name,email,active FROM accounts WHERE role='staff' ORDER BY name").all() : [];
        return json({revision,contacts,imports,members});
      }
      if(method === 'POST' && path === '/api/members') {
        owner(account);
        const body = await input(request);
        const name = brief(body.name,120);
        const email = emailOf(body.email);
        if(!name || !validEmail(email)) error(400,'Введите имя и адрес почты.');
        const temporaryPassword = random(18);
        const salt = random(16);
        const pass = await nearAuth(peer,async () => (await passwordKey(temporaryPassword,salt)).toString('hex'));
        if(!accountFor(token)) error(401,'Войдите в CRM ещё раз.');
        const created = transaction(() => {
          const row = addUser({name,email,role:'staff',salt,pass,temporary:1});
          announce.run();
          return row;
        });
        return json({member:projection(created),temporaryPassword},201);
      }
      const memberRoute = /^\/api\/members\/([\w-]{22})$/.exec(path);
      if(method === 'PATCH' && memberRoute) {
        owner(account);
        const id = memberRoute[1];
        const target = accountById.get(id);
        if(!target || target.role !== 'staff') error(404,'Сотрудник не найден.');
        const body = await input(request);
        if(!accountFor(token)) error(401,'Войдите в CRM ещё раз.');
        if(typeof body.active !== 'boolean') error(400,'Укажите доступ.');
        transaction(() => {
          sql('UPDATE accounts SET active=? WHERE id=?').run(Number(body.active),id);
          if(!body.active) sql('DELETE FROM sessions WHERE account=?').run(id);
          announce.run();
        });
        return json({ok:true});
      }
      if(method === 'POST' && path === '/api/import') {
        owner(account);
        const batch = parseImport(await input(request));
        if(!accountFor(token)) error(401,'Войдите в CRM ещё раз.');
        const result = transaction(() => {
          const {writes,result,entry} = planImport(contactsAll.all().map(decodeRow),batch);
          for(const lead of writes) put.run(lead.id,JSON.stringify(lead));
          const log = sql('INSERT OR IGNORE INTO imports VALUES(?,?)');
          for(const record of [...(batch.logs??[]),entry]) log.run(record.id,JSON.stringify(record));
          announce.run();
          return result;
        });
        return json(result);
      }
      if(method === 'POST' && path === '/api/assign') {
        owner(account);
        const body = await input(request);
        if(!Array.isArray(body.ids) || !body.ids.length || body.ids.length>5000 ||
          !body.ids.every(id=>typeof id==='string' && id.length<=120) || (body.assignee!==null && typeof body.assignee!=='string'))
          error(400,'Выберите карточки и сотрудника.');
        if(!accountFor(token)) error(401,'Войдите в CRM ещё раз.');
        const assignee = body.assignee === null ? null : accountById.get(body.assignee);
        if(body.assignee!==null && (!assignee || assignee.role!=='staff' || !assignee.active)) error(400,'Выберите активного сотрудника.');
        const changed = transaction(() => {
          let count=0;
          const assign = sql('UPDATE contacts SET assignee=?,data=? WHERE id=?');
          for(const id of new Set(body.ids)) {
            const row = ownLead(account,id);
            if(row.assignee === body.assignee) continue;
            const lead = decodeRow(row);
            const at = Date.now();
            lead.events.push({kind:'assignment',at,actor:account.name,assignee:assignee?.name??''});
            lead.updatedAt = at;
            assign.run(body.assignee,JSON.stringify(lead),id);
            count++;
          }
          if(count) announce.run();
          return count;
        });
        return json({changed});
      }
      const leadRoute = /^\/api\/leads\/([^/]+)$/.exec(path);
      if(method === 'PATCH' && leadRoute) {
        const id = decodeURIComponent(leadRoute[1]);
        if(id.length>120) error(404,'Карточка недоступна.');
        const change = await input(request);
        if(!accountFor(token)) error(401,'Войдите в CRM ещё раз.');
        if(!['call','dial','note','edit',undefined].includes(change.kind) ||
          (change.status !== undefined && !Object.hasOwn(stageById,change.status)) ||
          (change.note !== undefined && (typeof change.note!=='string' || change.note.length>3000)) ||
          (change.reminder != null && (!Number.isSafeInteger(change.reminder) || Math.abs(change.reminder)>8.64e15)))
          error(400,'Проверьте данные карточки.');
        transaction(() => {
          const lead = decodeRow(ownLead(account,id));
          const {kind,status,note,reminder} = change;
          const changed = patchContact(lead,{kind,status,note,reminder});
          for(const event of changed.events.slice(lead.events.length)) event.actor ??= account.name;
          update.run(JSON.stringify(changed),id);
          announce.run();
        });
        return json({ok:true});
      }
      return json({error:'Страница не найдена.'},404);
    } catch(cause) {
      if(cause.status) return json({error:cause.message},cause.status);
      console.error('Ошибка CRM:',cause.code ?? cause.name);
      return json({error:'Внутренняя ошибка. Попробуйте снова.'},500);
    }
  }
  return {handle,hasOwner,setupCode,close:()=>db.close()};
}

export function serve({host='127.0.0.1',port=3080,origin='http://127.0.0.1:'+port,filename}={}) {
  const url = new URL(origin);
  const loopback = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.origin!==origin || (!loopback && url.protocol!=='https:') ||
     (url.protocol==='http:' && !['127.0.0.1','::1','localhost'].includes(host))) {
    throw new Error('Для доступа с других устройств настройте HTTPS и ZEMLYA_ORIGIN.');
  }
  const database = resolve(filename ?? 'data/zemlya.sqlite');
  mkdirSync(dirname(database),{recursive:true,mode:0o700});
  process.umask(0o077);
  const app = makeApp({filename:database,origin});
  const http = createServer(async (req,res) => {
    try {
      const target = new URL(req.url,origin);
      if(target.origin!==origin) { res.writeHead(400); res.end(); return; }
      const init = {method:req.method,headers:req.headers};
      if(!['GET','HEAD'].includes(req.method)) Object.assign(init,{body:Readable.toWeb(req),duplex:'half'});
      const result = await app.handle(new Request(target,init),req.socket.remoteAddress??'local');
      res.writeHead(result.status,Object.fromEntries(result.headers));
      if(result.body) Readable.fromWeb(result.body).pipe(res); else res.end();
    } catch {
      if(!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  http.requestTimeout = 30000;
  http.listen(port,host,() => {
    console.log('Земля: ' + origin);
    if(!app.hasOwner()) console.log('Одноразовый код настройки администратора: ' + app.setupCode);
  });
  return {http,close:()=>{http.close();app.close();}};
}

if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  serve({host:process.env.ZEMLYA_HOST,port:Number(process.env.ZEMLYA_PORT??3080),
    origin:process.env.ZEMLYA_ORIGIN,filename:process.env.ZEMLYA_DB});
}
