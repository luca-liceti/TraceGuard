// TraceGuard Enhanced Dashboard JavaScript
const ENTRIES_KEY = 'tg_entries';
const PROFILE_KEY = 'tg_known_pii';
const LOGS_KEY = 'tg_usage_logs';
const SALT_KEY = 'tg_salt';

let allLogs = [];
let allEntries = [];
let allProfile = [];

// Tab management
document.querySelectorAll('.dashboard-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    switchTab(tabId);
  });
});

function switchTab(tabId) {
  // Update tab buttons
  document.querySelectorAll('.dashboard-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Update tab content
  document.querySelectorAll('.dashboard-content').forEach(content => {
    content.classList.toggle('active', content.id === tabId + 'Content');
  });

  // Load data for the selected tab
  if (tabId === 'logs') {
    renderLogs();
  } else if (tabId === 'entries') {
    renderEntries();
  } else if (tabId === 'profile') {
    renderProfile();
  }
}

// Load all data and update stats
async function loadAllData() {
  try {
    const result = await chrome.storage.local.get([ENTRIES_KEY, PROFILE_KEY, LOGS_KEY]);
    
    allEntries = result[ENTRIES_KEY] || [];
    allProfile = result[PROFILE_KEY] || [];
    allLogs = result[LOGS_KEY] || [];
    
    updateStats();
  } catch (error) {
    console.error('Error loading data:', error);
  }
}

function updateStats() {
  document.getElementById('totalEntries').textContent = allEntries.length;
  document.getElementById('profileEntries').textContent = allProfile.length;
  document.getElementById('totalLogs').textContent = allLogs.length;
  
  // Calculate unique sites
  const uniqueSites = new Set(allLogs.map(log => log.site)).size;
  document.getElementById('uniqueSites').textContent = uniqueSites;
}

// Render activity logs
function renderLogs(filter = {}) {
  const list = document.getElementById('log-list');
  list.innerHTML = '';

  let filteredLogs = [...allLogs];

  // Apply filters
  if (filter.type) {
    filteredLogs = filteredLogs.filter(log => log.type === filter.type);
  }
  if (filter.site) {
    filteredLogs = filteredLogs.filter(log => 
      log.site.toLowerCase().includes(filter.site.toLowerCase())
    );
  }

  if (filteredLogs.length === 0) {
    list.innerHTML = '<div class="empty-state">No activity logs found</div>';
    return;
  }

  // Sort by timestamp (newest first)
  filteredLogs.sort((a, b) => b.timestamp - a.timestamp);

  filteredLogs.forEach((log, idx) => {
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    
    const fieldInfo = log.fieldContext ? 
      `Field: ${log.fieldContext.label || log.fieldContext.placeholder || log.fieldContext.name || 'Unknown'}` : 
      'Field info not available';
    
    logEntry.innerHTML = `
      <div class="log-header">
        <span class="log-type">${log.type}</span>
        <span class="log-time">${new Date(log.timestamp).toLocaleString()}</span>
      </div>
      <div class="log-site">🌐 ${log.site}</div>
      <div class="log-details">
        <div><strong>Data used:</strong> ${log.shortDisplay}</div>
        <div><strong>${fieldInfo}</strong></div>
        <div><strong>Page:</strong> ${log.url || 'URL not recorded'}</div>
      </div>
    `;
    
    list.appendChild(logEntry);
  });
}

// Render manual entries
function renderEntries(filter = {}) {
  const list = document.getElementById('entries-list');
  list.innerHTML = '';

  let filteredEntries = [...allEntries];

  // Apply filters
  if (filter.type) {
    filteredEntries = filteredEntries.filter(entry => entry.meta?.type === filter.type);
  }
  if (filter.site) {
    filteredEntries = filteredEntries.filter(entry => 
      (entry.meta?.site || '').toLowerCase().includes(filter.site.toLowerCase())
    );
  }

  if (filteredEntries.length === 0) {
    list.innerHTML = '<div class="empty-state">No manual entries found</div>';
    return;
  }

  // Sort by timestamp (newest first)
  filteredEntries.sort((a, b) => (b.meta?.ts || 0) - (a.meta?.ts || 0));

  filteredEntries.forEach((entry, idx) => {
    const meta = entry.meta || {};
    const div = document.createElement('div');
    div.className = 'entry';
    
    div.innerHTML = `
      <div class="entry-content">
        <div class="entry-main">
          <strong>${(meta.type || 'Unknown Type').charAt(0).toUpperCase() + (meta.type || 'Unknown Type').slice(1).toLowerCase()}</strong> — ${meta.short || 'Data'}
        </div>
        <div class="entry-details">
          <div><strong>Site:</strong> ${meta.site || 'Unknown Site'}</div>
          <div><strong>Added:</strong> ${new Date(meta.ts || Date.now()).toLocaleString()}</div>
          <div><strong>Status:</strong> Encrypted and stored locally</div>
        </div>
      </div>
      <button class="remove danger" data-index="${idx}">Delete</button>
    `;
    
    const removeBtn = div.querySelector('.remove');
    removeBtn.onclick = async () => {
      if (confirm('Are you sure you want to delete this entry? This action cannot be undone.')) {
        allEntries.splice(idx, 1);
        await chrome.storage.local.set({ [ENTRIES_KEY]: allEntries });
        await loadAllData();
        renderEntries(filter);
      }
    };
    
    list.appendChild(div);
  });
}

// Render profile data
function renderProfile() {
  const list = document.getElementById('profile-list');
  list.innerHTML = '';

  if (allProfile.length === 0) {
    list.innerHTML = '<div class="empty-state">No profile information added yet</div>';
    return;
  }

  // Sort by timestamp (newest first)
  allProfile.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  allProfile.forEach((entry, idx) => {
    const div = document.createElement('div');
    div.className = 'entry';
    div.style.background = 'var(--success)';
    div.style.color = 'white';
    div.style.border = '1px solid var(--success)';
    
    div.innerHTML = `
      <div class="entry-content">
        <div class="entry-main">
          <strong>${entry.type.charAt(0).toUpperCase() + entry.type.slice(1).toLowerCase()}</strong> — ${entry.shortDisplay}
        </div>
        <div class="entry-details" style="color:rgba(255,255,255,0.8);">
          <div><strong>Added:</strong> ${new Date(entry.addedAt).toLocaleString()}</div>
          <div><strong>Status:</strong> Used for automatic detection on websites</div>
          <div><strong>Detection:</strong> ${allLogs.filter(log => log.value === entry.value).length} times detected</div>
        </div>
      </div>
      <button class="remove" style="background:rgba(255,255,255,0.2);color:white;" data-index="${idx}">Delete</button>
    `;
    
    const removeBtn = div.querySelector('.remove');
    removeBtn.onclick = async () => {
      if (confirm('Are you sure you want to delete this profile entry? It will no longer be detected on websites.')) {
        allProfile.splice(idx, 1);
        await chrome.storage.local.set({ [PROFILE_KEY]: allProfile });
        await loadAllData();
        renderProfile();
      }
    };
    
    list.appendChild(div);
  });
}

// Filter functionality for logs
document.getElementById('logTypeFilter').addEventListener('change', (e) => {
  const siteFilter = document.getElementById('logSiteFilter').value;
  renderLogs({ type: e.target.value, site: siteFilter });
});

document.getElementById('logSiteFilter').addEventListener('input', (e) => {
  const typeFilter = document.getElementById('logTypeFilter').value;
  renderLogs({ type: typeFilter, site: e.target.value });
});

document.getElementById('clearLogFilters').addEventListener('click', () => {
  document.getElementById('logTypeFilter').value = '';
  document.getElementById('logSiteFilter').value = '';
  renderLogs();
});

// Filter functionality for entries
document.getElementById('entryTypeFilter').addEventListener('change', (e) => {
  const siteFilter = document.getElementById('entrySiteFilter').value;
  renderEntries({ type: e.target.value, site: siteFilter });
});

document.getElementById('entrySiteFilter').addEventListener('input', (e) => {
  const typeFilter = document.getElementById('entryTypeFilter').value;
  renderEntries({ type: typeFilter, site: e.target.value });
});

document.getElementById('clearEntryFilters').addEventListener('click', () => {
  document.getElementById('entryTypeFilter').value = '';
  document.getElementById('entrySiteFilter').value = '';
  renderEntries();
});

// Clear all logs functionality
document.getElementById('clearAllLogs').addEventListener('click', async () => {
  const confirmMessage = '⚠️ This will permanently delete all activity logs. This action cannot be undone.\n\nAre you sure you want to continue?';
  
  if (!confirm(confirmMessage)) return;
  
  try {
    await chrome.storage.local.set({ [LOGS_KEY]: [] });
    await loadAllData();
    renderLogs();
    
    // Refresh badges in background script
    chrome.runtime.sendMessage({ type: 'refreshBadges' });
    
    alert('All activity logs have been cleared.');
  } catch (error) {
    alert('Error clearing logs: ' + error.message);
  }
});

// Lock dashboard functionality
document.getElementById('lockDashBtn').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ locked: true });
    
    // Notify content scripts
    chrome.runtime.sendMessage({
      type: 'statusChanged',
      unlocked: false
    });
    
    alert('Vault has been locked. Please refresh this page to continue.');
    location.reload();
  } catch (error) {
    alert('Error locking vault: ' + error.message);
  }
});

// Refresh button functionality
document.getElementById('refreshBtn').addEventListener('click', async () => {
  await loadAllData();
  
  // Re-render current tab
  const activeTab = document.querySelector('.dashboard-tab.active').dataset.tab;
  switchTab(activeTab);
  
  // Show success feedback
  const btn = document.getElementById('refreshBtn');
  const originalText = btn.textContent;
  btn.textContent = '✓ Refreshed';
  setTimeout(() => {
    btn.textContent = originalText;
  }, 1000);
});

// Reset all data functionality
document.getElementById('resetAll').addEventListener('click', async () => {
  const confirmMessage = '⚠️ WARNING: This will permanently delete ALL stored data including:\n\n• Your master password\n• All encrypted entries\n• Your profile information\n• All activity logs\n• All extension data\n\nThis action cannot be undone. Are you absolutely sure?';
  
  if (!confirm(confirmMessage)) return;
  
  const finalConfirm = 'Type "DELETE ALL DATA" to confirm permanent deletion:';
  const userInput = prompt(finalConfirm);
  
  if (userInput !== 'DELETE ALL DATA') {
    alert('Data deletion cancelled.');
    return;
  }
  
  try {
    await chrome.storage.local.clear();
    
    // Notify background script
    chrome.runtime.sendMessage({
      type: 'statusChanged',
      unlocked: false
    });
    
    alert('All data has been permanently deleted. The extension will need to be set up again.');
    location.reload();
  } catch (error) {
    alert('Error clearing data: ' + error.message);
  }
});

// Check authentication status on load
chrome.storage.local.get(['locked', 'masterHash'], async (result) => {
  const isLocked = result.locked !== false;
  const hasPassword = !!result.masterHash;
  
  if (!hasPassword) {
    document.body.innerHTML = `
      <div style="text-align: center; padding: 60px 20px; max-width: 500px; margin: 0 auto;">
        <h1 style="color: var(--accent); margin-bottom: 24px;">🔒 TraceGuard Dashboard</h1>
        <div style="background: var(--card); padding: 32px; border-radius: 12px; border: 1px solid var(--border);">
          <h2 style="margin-bottom: 16px; color: var(--text);">Setup Required</h2>
          <p style="color: var(--muted); margin-bottom: 24px; line-height: 1.5;">
            No master password found. Please set up the extension first by using the popup interface.
          </p>
          <button onclick="window.close()" style="background: var(--accent); color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; cursor: pointer;">
            Close Dashboard
          </button>
        </div>
      </div>
    `;
    return;
  }
  
  if (isLocked) {
    document.body.innerHTML = `
      <div style="text-align: center; padding: 60px 20px; max-width: 500px; margin: 0 auto;">
        <h1 style="color: var(--accent); margin-bottom: 24px;">🔒 TraceGuard Dashboard</h1>
        <div style="background: var(--card); padding: 32px; border-radius: 12px; border: 1px solid var(--border);">
          <h2 style="margin-bottom: 16px; color: var(--text);">Vault Locked</h2>
          <p style="color: var(--muted); margin-bottom: 24px; line-height: 1.5;">
            Please unlock the vault using the extension popup first, then refresh this page.
          </p>
          <button onclick="location.reload()" style="background: var(--accent); color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; cursor: pointer;">
            ↻ Refresh Page
          </button>
        </div>
      </div>
    `;
    return;
  }
  
  // Initialize dashboard if authenticated
  await loadAllData();
  renderLogs(); // Default to logs tab
});