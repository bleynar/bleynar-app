(() => {
  'use strict';
  const counter = document.querySelector('footer .visit-count');
  if (location.origin !== 'https://bleynar.github.io' ||
      !/^\/bleynar-app\/(?:news\/)?(?:index\.html)?$/.test(location.pathname)) return;
  const visitTotals = counter?.querySelector('[data-visit-totals]') || counter;

  const endpoint = 'https://bleynar-download-stats.fabulousonyx.chatgpt.site/visits';
  const network = { mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' };
  const numbers = new Intl.NumberFormat('ru-RU');
  let busy = false;

  function storedVisitor() {
    return new Promise(resolve => {
      const open = indexedDB.open('bleynar-site-visits', 1);
      const timeout = setTimeout(() => resolve(null), 2000);
      function finish(value) { clearTimeout(timeout); resolve(value); }
      // The database creation transaction runs once even when two tabs open together.
      open.onupgradeneeded = () => {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
        open.result.createObjectStore('state').put(id, 'visitor');
      };
      open.onerror = open.onblocked = () => finish(null);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction('state').objectStore('state').get('visitor');
        read.onsuccess = () => finish(read.result);
        read.onerror = () => finish(null);
        db.close();
      };
    });
  }

  function totals(visitor) {
    const options = { ...network, signal: window.AbortSignal?.timeout?.(7000) };
    if (visitor) {
      options.method = 'POST';
      options.body = new URLSearchParams({ visitor });
      options.keepalive = true;
    }
    return fetch(endpoint, options);
  }

  async function refresh() {
    if (busy || document.visibilityState !== 'visible' || document.prerendering) return;
    busy = true;
    try {
      let visitor;
      if (navigator.doNotTrack !== '1' && window.doNotTrack !== '1' && !navigator.globalPrivacyControl) {
        visitor = await storedVisitor().catch(() => null);
      }
      if (document.visibilityState !== 'visible') return;
      let response;
      if (visitor) response = await totals(visitor).catch(() => null);
      if (!counter) return;
      if (!response?.ok) response = await totals();
      if (!response.ok) return;
      const { total, day } = await response.json();
      if (!Number.isSafeInteger(total) || !Number.isSafeInteger(day) || day < 0 || total < day) return;
      visitTotals.textContent = numbers.format(total) + ' · ' + numbers.format(day);
      counter.hidden = false;
    } catch { /* Keep the last real figures until the connection returns. */ }
    finally { busy = false; }
  }

  document.addEventListener('visibilitychange', refresh);
  document.addEventListener('prerenderingchange', refresh);
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
  window.addEventListener('online', refresh);
  refresh();
})();
