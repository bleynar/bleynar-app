(() => {
  const hash = document.getElementById('checksum');
  const copy = document.getElementById('copy');
  const status = document.getElementById('copy-status');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(hash.textContent.trim());
      copy.textContent = 'Скопировано';
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(hash);
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Сумма выделена. Выберите «Копировать».';
    }
  });
})();
