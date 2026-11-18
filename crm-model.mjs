'use strict';

const stages = [
  {id:'new',name:'Лид',color:'sprout'},
  {id:'missed',name:'НДЗ',color:'moss'},
  {id:'missed2',name:'НДЗ 2',color:'fern'},
  {id:'substitution',name:'Подменка',color:'sage'},
  {id:'talking',name:'Переговоры',color:'jade'},
  {id:'success',name:'Анкета',color:'mint'},
  {id:'ticket',name:'Билет',color:'sprout'},
  {id:'preparing',name:'Готовится к отправке',color:'sage'},
  {id:'travel',name:'В пути',color:'fern'},
  {id:'signing',name:'На подписании',color:'jade'},
  {id:'won',name:'Сделка успешна',color:'canopy'}
];
const archivedStage = {id:'declined',name:'Отказ',color:'archive-tone'};
const stageById = Object.fromEntries([...stages,archivedStage].map(stage => [stage.id,stage]));
const fields = [
  {id:'name', label:'ФИО / имя', aliases:['фио','ф и о','фамилия имя отчество','фио кандидата','фио соискателя','имя','имя кандидата','имя соискателя','имя откликнувшегося','кандидат','соискатель','applicant','candidate','name','full name','full_name']},
  {id:'phone', label:'Телефон', aliases:['телефон','номер','номер телефона','номер кандидата','телефон кандидата','телефон соискателя','контактный телефон','мобильный телефон','мобильный','контакт','контакты','phone','phone number','phone_number','tel']},
  {id:'job', label:'Вакансия / объявление', aliases:['вакансия','название вакансии','название объявления','заголовок объявления','объявление','название','должность','наименование вакансии','позиция','vacancy','job','title','ad title','ad_title']},
  {id:'date', label:'Дата отклика', aliases:['дата','дата отклика','время отклика','дата и время отклика','дата создания','дата создания отклика','дата получения','отклик от','created at','created_at','date','response date']},
  {id:'sourceId', label:'ID отклика', aliases:['id отклика','ид отклика','номер отклика','идентификатор отклика','id заявки','id','response id','response_id','application id','application_id']},
  {id:'adId', label:'ID объявления', aliases:['id объявления','ид объявления','номер объявления','id вакансии','vacancy id','ad id','ad_id','item_id']}
];
const asText = value => String(value ?? '').trim();
const clean = value => asText(value).toLowerCase().replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const digits = value => asText(value).replace(/\D/g,'');
function phoneKey(value) {
  const number = digits(asText(value).replace(/\s+(?:доб\.?|ext\.?|#)\s*\d+$/i,''));
  if(number.length === 10) return '7' + number;
  if(number.length === 11 && number.startsWith('8')) return '7' + number.slice(1);
  return number;
}
function identityKeys(contact) {
  const phone = phoneKey(contact.phone);
  const keys = new Set();
  if(phone.length >= 7) keys.add('phone:' + phone);
  if(contact.sourceId) keys.add('id:' + clean(contact.sourceId));
  for(const key of contact.responseKeys ?? []) if(key.startsWith('id:')) keys.add(key);
  const name = clean(contact.name);
  if(name) {
    const date = responseDate(contact.date);
    const job = clean(contact.adId || contact.job);
    keys.add('row:' + JSON.stringify([name,job,date ? localDay(date) : clean(contact.date)]));
    if(date && contact.adId && contact.job) keys.add('row:' + JSON.stringify([name,clean(contact.job),localDay(date)]));
  }
  return keys;
}
function candidateIndex(contacts) {
  const indexes = new Map();
  function add(contact) {
    for(const key of identityKeys(contact)) {
      if(!indexes.has(key)) indexes.set(key,new Set());
      indexes.get(key).add(contact.id);
    }
  }
  for(const contact of contacts) add(contact);
  return {
    add,
    find(incoming,records) {
      const incomingPhone = phoneKey(incoming.phone);
      for(const key of identityKeys(incoming)) {
        const matches = [];
        for(const id of indexes.get(key) ?? []) {
          const record = records.get(id);
          if(!record) continue;
          const savedPhone = phoneKey(record.phone);
          if(key.startsWith('row:')) {
            if(incomingPhone.length >= 7 && savedPhone.length >= 7 && incomingPhone !== savedPhone) continue;
            if(incoming.sourceId && record.sourceId && clean(incoming.sourceId) !== clean(record.sourceId)) continue;
          }
          matches.push(record);
        }
        if(matches.length === 1 || (matches.length > 1 && !key.startsWith('row:'))) return matches[0];
      }
      return null;
    }
  };
}
function responseDate(value) {
  const text = asText(value);
  if(!text) return null;
  const ru = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  const parts = ru ? [ru[3],ru[2],ru[1],ru[4],ru[5],ru[6]] : iso?.slice(1);
  if(parts) return new Date(Number(parts[0]),Number(parts[1])-1,Number(parts[2]),Number(parts[3] || 0),Number(parts[4] || 0),Number(parts[5] || 0));
  const date = /^\d{4}-\d{2}-\d{2}T/.test(text) ? new Date(text) : null;
  return Number.isFinite(date?.valueOf()) ? date : null;
}
function localDay(date=new Date()) {
  return [date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
}
function calendarDays(from,to) {
  const day = date => Date.UTC(date.getFullYear(),date.getMonth(),date.getDate());
  return Math.max(0,(day(to)-day(from))/86400000);
}
function firstResponse(contact) {
  const first = responseDate(contact.firstResponseDate);
  const current = responseDate(contact.date);
  if(first && current) return first < current ? first : current;
  return first || current;
}
function previousResponseDate(contact) {
  let first = responseDate(contact.date);
  for(const event of contact.events ?? []) {
    const date = responseDate(event.date);
    if(date && (!first || date < first)) first = date;
  }
  for(const key of contact.responseKeys ?? []) {
    if(!key.startsWith('[')) continue;
    try {
      const [value] = JSON.parse(key.replace(/#\d+$/,''));
      if(typeof value !== 'number') continue;
      const date = new Date(value);
      if(Number.isFinite(date.valueOf()) && (!first || date < first)) first = date;
    } catch {}
  }
  return first?.toISOString() ?? '';
}
function leadAge(contact,now=new Date()) {
  const response = firstResponse(contact);
  const creation = contact.events?.find(event => event.kind === 'import')?.at ?? contact.updatedAt;
  const origin = response || new Date(creation);
  if(!Number.isFinite(origin.valueOf())) return null;
  return {days:calendarDays(origin,now),origin,response:Boolean(response)};
}
function candidateAge(contact,now=new Date()) {
  for(const [label,raw] of contact.extra ?? []) {
    if(['дата рождения','дата рождения кандидата','дата рождения соискателя','birth date','birthday','date of birth'].includes(clean(label))) {
      const birthday = responseDate(/^\d{5}$/.test(raw) ? sheetDate(Number(raw),false) : raw);
      if(birthday && birthday <= now) {
        const birthdayThisYear = new Date(now.getFullYear(),birthday.getMonth(),birthday.getDate());
        if(birthday.getMonth() === 1 && birthday.getDate() === 29 && birthdayThisYear.getMonth() !== 1) birthdayThisYear.setDate(0);
        const years = now.getFullYear() - birthday.getFullYear() - (now < birthdayThisYear ? 1 : 0);
        if(years <= 120) return years;
      }
    }
  }
  for(const [label,raw] of contact.extra ?? []) {
    if(!['возраст','возраст кандидата','возраст соискателя','возраст лет','полных лет','age'].includes(clean(label))) continue;
    const years = /^\s*(\d{1,3})(?:\s*(?:год|года|лет))?\s*$/i.exec(raw)?.[1];
    if(years && Number(years) <= 120) return Number(years);
  }
  return null;
}
function responseSignature(contact) {
  if(contact.sourceId) return 'id:' + clean(contact.sourceId);
  const date = responseDate(contact.date);
  return JSON.stringify([date ? date.valueOf() : clean(contact.date),clean(contact.adId || contact.job)]);
}
function mergeResponse(current,incoming) {
  const oldDate = responseDate(current.date);
  const newDate = responseDate(incoming.date);
  const older = oldDate && newDate && newDate < oldDate;
  const merged = {...current};
  const first = firstResponse(current);
  if(newDate && (!first || newDate < first)) merged.firstResponseDate = incoming.date;
  for(const key of ['name','phone','job','date','sourceId','adId']) {
    if(incoming[key] && (!older || !merged[key])) merged[key] = incoming[key];
  }
  const extra = new Map(current.extra);
  for(const [key,value] of incoming.extra) {
    if(!older || !extra.has(key)) extra.set(key,value);
  }
  merged.extra = [...extra];
  return merged;
}


const uid = () => globalThis.crypto.randomUUID();
function hydrateContact(contact) {
  return {
    ...contact, status:contact.status === 'working' ? 'talking' : contact.status,
    attempts:contact.attempts ?? 0, reminder:contact.reminder ?? null, events:contact.events ?? [],
    firstResponseDate:contact.firstResponseDate ?? previousResponseDate(contact),
    responseKeys:contact.responseKeys ?? [responseSignature(contact)]
  };
}
function addEvent(contact,event) {
  return {...contact,events:[...contact.events,event],updatedAt:event.at};
}

function planImport(records,{contacts,skipped=0,file,sheet='',restore=false,source='avito-file'}) {
  const result = {added:0,duplicates:0,updated:0,skipped};
  const writes = [];
  const existing = new Map(records.map(contact => [contact.id,hydrateContact(contact)]));
  const identities = candidateIndex(existing.values());
  const now = Date.now();
  const occurrences = new Map();
  for(const [position,incoming] of contacts.entries()) {
    const current = (restore && existing.get(incoming.id)) || identities.find(incoming,existing);
    const signature = responseSignature(incoming);
    const occurrenceKey = JSON.stringify([identityKeys(incoming).values().next().value,signature]);
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey,occurrence);
    const responseKey = occurrence > 1 && !incoming.sourceId ? signature + '#' + occurrence : signature;
    let contact;
    if(current) {
      if(restore) {
        if(incoming.updatedAt <= current.updatedAt) { result.duplicates++; continue; }
        contact = {...incoming,id:current.id};
        result.updated++;
      } else {
        result.duplicates++;
        const merged = mergeResponse(current,incoming);
        const fieldsChanged = ['name','phone','job','date','firstResponseDate','sourceId','adId','extra'].some(field =>
          JSON.stringify(current[field]) !== JSON.stringify(merged[field]));
        const repeatedResponse = !current.responseKeys.includes(responseKey);
        if(!fieldsChanged && !repeatedResponse) continue;
        if(repeatedResponse) {
          merged.responseKeys = [...current.responseKeys,responseKey];
          contact = addEvent(merged,{kind:'repeat',at:now,job:incoming.job,date:incoming.date});
        } else {
          contact = addEvent(merged,{kind:'refresh',at:now,job:incoming.job});
        }
        result.updated++;
      }
    } else {
      contact = restore ? incoming : {
        ...incoming,id:uid(),status:'new',note:'',attempts:0,reminder:null,source,firstResponseDate:incoming.date,
        updatedAt:now - position,responseKeys:[responseKey],events:[{kind:'import',at:now,job:incoming.job}]
      };
      result.added++;
    }
    writes.push(contact);
    existing.set(contact.id,contact);
    identities.add(contact);
  }
  return {writes,result,entry:{id:uid(),at:now,file,sheet,restore,source,...result}};
}

const noAnswer = status => ['missed','missed2'].includes(status);
const callbackAllowed = status => noAnswer(status) || status === 'talking';
const callResult = status => callbackAllowed(status);
const isOverdue = (contact,now=Date.now()) => callbackAllowed(contact.status) && Boolean(contact.reminder && contact.reminder <= now);
function patchContact(record,change) {
  const at = Date.now();
  const contact = hydrateContact(record);
  const status = change.status ?? contact.status;
  const reminder = callbackAllowed(status) ? (change.reminder === undefined ? contact.reminder : change.reminder) : null;
  const note = change.note ?? contact.note;
  const moved = status !== contact.status;
  const recordCall = change.kind === 'call' || (moved && callResult(status));
  const events = [];
  if(change.kind === 'dial') events.push({kind:'dial',at});
  else if(recordCall) events.push({kind:'call',at,status,note:change.note || ''});
  if(moved && status === archivedStage.id) events.push({kind:'archive',at});
  else if(moved && contact.status === archivedStage.id) events.push({kind:'restore',at,status});
  else if(moved && (!recordCall || !callResult(status))) events.push({kind:'status',at,status});
  if((change.kind === 'note' || note !== contact.note) && !recordCall) events.push({kind:'note',at,note});
  if(reminder !== contact.reminder) events.push({kind:'reminder',at,reminder});
  if(!events.length) return contact;
  const attempts = contact.attempts + (recordCall && noAnswer(status) ? 1 : 0);
  const history = contact.note && !contact.events.some(event => event.note === contact.note)
    ? [...contact.events,{kind:'note',at:contact.updatedAt,note:contact.note}] : contact.events;
  return {...contact,status,reminder,note,attempts,updatedAt:at,events:[...history,...events]};
}

const validTime = time => typeof time === 'number' && Number.isFinite(new Date(time).valueOf());
function readBackup(data) {
  if(data?.format !== 'otklik-crm' || data.version !== 1 || !Array.isArray(data.contacts) || !Array.isArray(data.imports)) {
    throw new Error('Выберите JSON-копию, скачанную из CRM «Земля».');
  }
  const contacts = data.contacts.map(contact => {
    if(!contact || typeof contact.id !== 'string' || !contact.id || typeof contact.name !== 'string' || typeof contact.phone !== 'string' ||
       typeof contact.status !== 'string' || (!Object.hasOwn(stageById,contact.status) && contact.status !== 'working') || !validTime(contact.updatedAt) ||
       !Array.isArray(contact.extra) || !contact.extra.every(item => Array.isArray(item) && item.length === 2 && item.every(value => typeof value === 'string'))) {
      throw new Error('В копии есть повреждённая карточка.');
    }
    const events = (contact.events ?? []);
    if(!Array.isArray(events) || !events.every(event => event && typeof event.kind === 'string' && validTime(event.at) &&
      (event.reminder == null || validTime(event.reminder)))) throw new Error('В копии повреждена история действий.');
    const attempts = contact.attempts ?? 0;
    const reminder = contact.reminder ?? null;
    if(!Number.isSafeInteger(attempts) || attempts < 0 || (reminder !== null && !validTime(reminder))) {
      throw new Error('В копии повреждены данные перезвона.');
    }
    const responseKeys = (contact.responseKeys ?? [responseSignature(contact)]);
    if(!Array.isArray(responseKeys) || !responseKeys.length || !responseKeys.every(value => typeof value === 'string')) {
      throw new Error('В копии повреждены данные об откликах.');
    }
    const {id,name,phone,status,updatedAt,extra} = contact;
    return {id,name,phone,status:status === 'working' ? 'talking' : status,updatedAt,extra,attempts,reminder,events,responseKeys:[...new Set(responseKeys)],source:asText(contact.source),job:asText(contact.job),date:asText(contact.date),firstResponseDate:asText(contact.firstResponseDate) || previousResponseDate(contact),
      sourceId:asText(contact.sourceId),adId:asText(contact.adId),note:asText(contact.note)};
  });
  const logs = data.imports.map(log => {
    if(!log || typeof log.id !== 'string' || !validTime(log.at) ||
       ![log.added,log.duplicates,log.skipped,log.updated].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('В копии повреждена история импорта.');
    }
    const {id,at,added,duplicates,skipped,updated} = log;
    return {id,at,added,duplicates,skipped,updated,file:asText(log.file),sheet:asText(log.sheet),restore:Boolean(log.restore)};
  });
  return {contacts,logs};
}

export { stageById, planImport, patchContact, readBackup };