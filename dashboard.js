function renderLogs(filter = '') {
  chrome.storage.local.get([ENTRIES_KEY, 'locked'], (result) => {
    const arr = result[ENTRIES_KEY] || [];
    const list = document.getElementById('log-list');
    list.innerHTML = '';

    arr.forEach((item, idx) => {
      let decrypted;
      try {
        // Decrypt payload to show full value in dashboard
        const payload = item.payload;
        const iv = new Uint8Array(atob(payload.iv).split('').map(c=>c.charCodeAt(0)));
        const ct = new Uint8Array(atob(payload.ct).split('').map(c=>c.charCodeAt(0)));
        const keyMaterial = localStorage.getItem('tg_key'); // fallback; real key kept in popup memory
        // For demo we show meta only; full decrypt would need key re-derived after user re-auth
        decrypted = { type: item.meta.type, value: item.meta.fullHint };
      } catch { return; }

      if (!filter || item.meta.type === filter) {
        const div = document.createElement('div');
        div.className = 'entry';
        div.innerHTML = `
          <span><strong>${item.meta.site}</strong> — ${item.meta.type} — ${item.meta.short} (${new Date(item.meta.ts).toLocaleString()})</span>
          <button class="remove danger">Delete</button>`;
        div.querySelector('.remove').onclick = async () => {
          arr.splice(idx, 1);
          await chrome.storage.local.set({ [ENTRIES_KEY]: arr });
          renderLogs(filter);
        };
        list.appendChild(div);
      }
    });
  });
}

document.getElementById('filter').addEventListener('change', (e) => {
  renderLogs(e.target.value);
});

document.getElementById('lockDashBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ locked: true });
  location.reload(); // force auth prompt
});

document.getElementById('resetAll').addEventListener('click', async () => {
  if (!confirm('⚠️  This will permanently erase ALL stored data and salt. Continue?')) return;
  await chrome.storage.local.clear();
  alert('All data cleared. Reload the extension.');
  location.reload();
});

renderLogs();