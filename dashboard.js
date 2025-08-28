// TraceGuard Dashboard JavaScript
const ENTRIES_KEY = 'tg_entries';
const SALT_KEY = 'tg_salt';

function renderLogs(filter = '') {
  chrome.storage.local.get([ENTRIES_KEY, 'locked'], (result) => {
    const arr = result[ENTRIES_KEY] || [];
    const list = document.getElementById('log-list');
    list.innerHTML = '';

    if (arr.length === 0) {
      list.innerHTML = '<div class="empty-state">No entries found</div>';
      return;
    }

    arr.forEach((item, idx) => {
      // For dashboard, we show metadata only since we don't have the master key
      const meta = item.meta || {};
      
      if (!filter || meta.type === filter) {
        const div = document.createElement('div');
        div.className = 'entry';
        div.innerHTML = `
          <span><strong>${meta.site || 'Unknown Site'}</strong> — ${(meta.type || 'Unknown Type').charAt(0).toUpperCase() + (meta.type || 'Unknown Type').slice(1).toLowerCase()} — ${meta.short || 'Data'} (${new Date(meta.ts || Date.now()).toLocaleString()})</span>
          <button class="remove danger" data-index="${idx}">Delete</button>`;
        
        const removeBtn = div.querySelector('.remove');
        removeBtn.onclick = async () => {
          if (confirm('Are you sure you want to delete this entry?')) {
            arr.splice(idx, 1);
            await chrome.storage.local.set({ [ENTRIES_KEY]: arr });
            renderLogs(filter);
          }
        };
        
        list.appendChild(div);
      }
    });
  });
}

// Filter functionality
document.getElementById('filter').addEventListener('change', (e) => {
  renderLogs(e.target.value);
});

// Lock dashboard functionality
document.getElementById('lockDashBtn').addEventListener('click', async () => {
  await chrome.storage.local.set({ locked: true });
  alert('Vault has been locked. Please refresh this page to continue.');
  location.reload();
});

// Reset all data functionality
document.getElementById('resetAll').addEventListener('click', async () => {
  const confirmMessage = '⚠️ WARNING: This will permanently delete ALL stored data including your master password and all encrypted entries.\n\nThis action cannot be undone. Are you sure you want to continue?';
  
  if (!confirm(confirmMessage)) return;
  
  const finalConfirm = 'Type "DELETE ALL" to confirm permanent data deletion:';
  const userInput = prompt(finalConfirm);
  
  if (userInput !== 'DELETE ALL') {
    alert('Data deletion cancelled.');
    return;
  }
  
  try {
    await chrome.storage.local.clear();
    alert('All data has been permanently deleted. The extension will need to be set up again.');
    location.reload();
  } catch (error) {
    alert('Error clearing data: ' + error.message);
  }
});

// Check authentication status on load
chrome.storage.local.get(['locked', 'masterHash'], (result) => {
  const isLocked = result.locked !== false;
  const hasPassword = !!result.masterHash;
  
  if (!hasPassword) {
    document.body.innerHTML = `
      <div style="text-align: center; padding: 40px;">
        <h1>TraceGuard Dashboard</h1>
        <p>No master password found. Please set up the extension first by using the popup interface.</p>
        <button onclick="chrome.tabs.create({url: chrome.runtime.getURL('popup.html')})">
          Open Extension Setup
        </button>
      </div>
    `;
    return;
  }
  
  if (isLocked) {
    document.body.innerHTML = `
      <div style="text-align: center; padding: 40px;">
        <h1>TraceGuard Dashboard</h1>
        <p>Vault is locked. Please unlock using the extension popup first.</p>
        <button onclick="location.reload()">Refresh</button>
      </div>
    `;
    return;
  }
  
  // Initialize dashboard if authenticated
  renderLogs();
});

// Add CSS for empty state
const style = document.createElement('style');
style.textContent = `
  .empty-state {
    text-align: center;
    color: var(--muted);
    font-style: italic;
    padding: 20px;
  }
  
  .entry {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px;
    border-bottom: 1px solid var(--border, #e5e5e7);
    margin-bottom: 8px;
  }
  
  .entry:last-child {
    border-bottom: none;
  }
  
  .remove.danger {
    background: var(--danger, #ff3b30);
    color: white;
    border: none;
    padding: 6px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }
  
  .remove.danger:hover {
    opacity: 0.8;
  }
`;
document.head.appendChild(style);