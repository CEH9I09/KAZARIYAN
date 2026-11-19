(() => {
  'use strict';

  const key = 'zemlya.theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let selected = null;
  try { selected = localStorage.getItem(key); } catch {}

  function apply() {
    const dark = selected === 'dark' || (selected !== 'light' && system.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#171e19' : '#23382c';
    for(const button of document.querySelectorAll('[data-theme-switch]')) {
      button.setAttribute('aria-pressed', String(dark));
      button.title = dark ? 'Включить светлую тему' : 'Включить тёмную тему';
    }
  }

  apply();
  document.addEventListener('DOMContentLoaded',apply,{once:true});
  document.addEventListener('click',event => {
    if(!event.target.closest('[data-theme-switch]')) return;
    selected = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(key,selected); } catch {}
    apply();
  });
  system.addEventListener('change',apply);
  window.addEventListener('storage',event => {
    if(event.key !== key && event.key !== null) return;
    selected = event.newValue;
    apply();
  });
})();
