(() => {
  'use strict';
  const service = 'https://bleynar-download-stats.fabulousonyx.chatgpt.site';
  const link = document.querySelector('[data-download]');
  const total = document.getElementById('download-total');
  const footerSlot = document.querySelector('[data-download-count]');
  const version = document.querySelector('[data-version]').textContent.trim();
  const checksum = document.getElementById('checksum').textContent.trim();
  const normalText = link.textContent;
  const network = { mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' };
  let dbPromise;
  let shownTotal = -1;
  let serviceAvailable;
  let busy = false;

  function showTotal(data) {
    if (!Number.isSafeInteger(data.unique) || data.unique < 0) throw new Error('Invalid total');
    shownTotal = Math.max(shownTotal, data.unique);
    total.textContent = shownTotal.toLocaleString('ru-RU');
    if (footerSlot) footerSlot.hidden = false;
  }

  async function refresh() {
    const controller = window.AbortController ? new AbortController() : null;
    const timeout = controller && setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(service + '/total', { ...network, signal: controller?.signal });
      if (!response.ok) throw new Error('Counter unavailable');
      showTotal(await response.json());
      serviceAvailable = true;
    } catch {
      serviceAvailable = false;
    } finally { clearTimeout(timeout); }
  }
  refresh();
  window.addEventListener('pageshow', event => { if (event.persisted) refresh(); });
  window.addEventListener('online', refresh);

  if (!window.indexedDB || !window.crypto?.subtle || !window.AbortController ||
      !URL.createObjectURL || !('download' in link) || navigator.globalPrivacyControl ||
      navigator.doNotTrack === '1') return;

  function database() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open('bleynar-downloads', 1);
        let abandoned = false;
        const timeout = setTimeout(() => {
          abandoned = true;
          reject(new Error('Browser storage unavailable'));
        }, 2000);
        request.onupgradeneeded = () => request.result.createObjectStore('state');
        request.onerror = () => { clearTimeout(timeout); reject(request.error); };
        request.onsuccess = () => {
          clearTimeout(timeout);
          const db = request.result;
          if (abandoned) { db.close(); return; }
          db.onversionchange = () => { db.close(); dbPromise = undefined; };
          resolve(db);
        };
      }).catch(error => { dbPromise = undefined; throw error; });
    }
    return dbPromise;
  }

  async function entry(key, update) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('state', update ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('state');
      const read = store.get(key);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || new Error('Storage unavailable'));
      read.onsuccess = () => {
        result = read.result;
        if (!update) return;
        const next = update(result);
        if (next !== result) {
          if (next === undefined) store.delete(key);
          else store.put(next, key);
          result = next;
        }
      };
    });
  }

  function hex(bytes) {
    return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
  }

  async function confirmDownload(receipt) {
    if (!receipt) return;
    try {
      if (Number(receipt.expires) > Date.now() / 1000) {
        const response = await fetch(service + '/confirm', {
          ...network, method: 'POST', body: new URLSearchParams(receipt), keepalive: true,
        });
        if (response.ok) showTotal(await response.json());
        else if (response.status !== 400 && response.status !== 403) return;
      }
      await entry('receipt', current => current?.proof === receipt.proof ? undefined : current);
    } catch { /* A later visit can retry the same receipt. */ }
  }
  entry('receipt').then(confirmDownload).catch(() => {});
  window.addEventListener('online', () => {
    entry('receipt').then(confirmDownload).catch(() => {});
  });

  async function fetchApk(browser) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(service + '/download', {
        ...network, method: 'POST', signal: controller.signal, body: new URLSearchParams({ browser, version }),
      });
      const expires = response.headers.get('X-Receipt-Expires');
      if (!response.ok || !/^\d+$/.test(expires)) throw new Error('Cannot download');
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), 180000);
      const bytes = await response.arrayBuffer();
      // The service appends a 32-byte receipt after streaming the official file.
      if (bytes.byteLength <= 32) throw new Error('Incomplete file');
      const file = new Uint8Array(bytes, 0, bytes.byteLength - 32);
      if (hex(await crypto.subtle.digest('SHA-256', file)) !== checksum) throw new Error('APK checksum mismatch');
      const proof = hex(new Uint8Array(bytes, file.byteLength));
      return {
        blob: new Blob([file], { type: 'application/vnd.android.package-archive' }),
        receipt: { browser, version, expires, proof },
      };
    } finally { clearTimeout(timer); }
  }

  function saveApk(blob) {
    const url = URL.createObjectURL(blob);
    const download = document.createElement('a');
    download.href = url;
    download.download = 'Bleynar-' + version + '.apk';
    download.hidden = true;
    document.body.appendChild(download);
    try { download.click(); }
    finally {
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  }

  link.addEventListener('click', async event => {
    if (serviceAvailable === false || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    link.setAttribute('aria-busy', 'true');
    link.textContent = 'Загружаем APK…';
    let result;
    try {
      // A read/write IDB transaction also serializes two tabs on their first download.
      const browser = await entry('browser', existing => existing || hex(crypto.getRandomValues(new Uint8Array(16))));
      result = await fetchApk(browser);
      saveApk(result.blob);
    } catch {
      window.location.assign(link.href);
      return;
    } finally {
      busy = false;
      link.textContent = normalText;
      link.removeAttribute('aria-busy');
    }
    try { await entry('receipt', () => result.receipt); } catch { /* Still try the confirmation now. */ }
    await confirmDownload(result.receipt);
  });
})();
