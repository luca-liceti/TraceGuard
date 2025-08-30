// TraceGuard Enhanced Dashboard JavaScript - FIXED
// Responsibilities:
// - Load and render stored entries/profile/logs from chrome.storage.local
// - Provide filtering, deletion, and lightweight UI helpers for the dashboard
// - Coordinate detection-hash cleanup (kept conservative to avoid auto-deletes)
const ENTRIES_KEY = 'tg_entries';
const PROFILE_KEY = 'tg_known_pii';
const LOGS_KEY = 'tg_usage_logs';
const SALT_KEY = 'tg_salt';
const DETECTION_KEY = 'tg_detection_hashes';
const SETTINGS_KEYS = ['tg_notify_new','tg_notify_repeat','tg_truncate_urls','tg_preserve_session'];
const SITES_KEY = 'tg_sites';

let allLogs = [];
let allEntries = [];
let allProfile = [];

// Small helper to safely escape HTML when injecting strings
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Tab management: wire up tab buttons and show/hide the correct content pane
document.querySelectorAll('.dashboard-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    switchTab(tabId);
  });
});

// switchTab: show the requested tab's content and load its data
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
  } else if (tabId === 'sites') {
    renderSites();
  }
}

// renderSites: show known sites and allow the user to send a "delete my data"
// request. Sites are stored in chrome.storage.local under SITES_KEY as an
// array of { origin, contactUrl?, email? } objects. This UI only prepares the
// request; actual sending opens the contact page or a mailto: window.
async function renderSites() {
  const container = document.getElementById('sitesContent');
  container.innerHTML = '';

  const result = await chrome.storage.local.get([SITES_KEY]);
  const sites = result[SITES_KEY] || [];

  const panel = document.createElement('div');
  panel.className = 'tg-sites-panel';

  const list = document.createElement('div');
  list.className = 'tg-sites-list';

  // add-site form
  const form = document.createElement('div');
  form.style.display = 'grid';
  form.style.gridTemplateColumns = '1fr auto';
  form.style.gap = '8px';
  form.style.marginBottom = '10px';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'example.com or https://example.com';
  input.style.padding = '8px';
  input.style.borderRadius = '8px';
  input.style.border = '1px solid var(--border)';

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add Site';
  addBtn.addEventListener('click', async () => {
    const origin = input.value.trim();
    if (!origin) return alert('Please enter a site origin.');
    sites.push({ origin });
    await chrome.storage.local.set({ [SITES_KEY]: sites });
    input.value = '';
  renderSites();
  // best-effort contact discovery in background
  try { discoverContactsForSite(sites.length ? sites[sites.length-1] : { origin }); } catch (e) { /* ignore */ }
  });

  form.appendChild(input);
  form.appendChild(addBtn);
  panel.appendChild(form);

  if (sites.length === 0) {
    list.innerHTML = '<div class="empty-state">No sites configured for automated requests yet.</div>';
  } else {
    sites.forEach((s, idx) => {
      const row = document.createElement('div');
      row.className = 'tg-site-row';

      const origin = document.createElement('div');
      origin.className = 'site-origin';
      origin.textContent = s.origin || s.domain || 'Unknown';

      const actions = document.createElement('div');
      actions.className = 'site-actions';

      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open site';
      openBtn.addEventListener('click', () => {
        const url = s.origin.startsWith('http') ? s.origin : 'https://' + s.origin;
        window.open(url, '_blank');
      });

      const requestBtn = document.createElement('button');
      requestBtn.textContent = 'Send delete request';
      requestBtn.addEventListener('click', () => sendDeleteRequest(s));

      const removeBtn = document.createElement('button');
      removeBtn.textContent = 'Remove';
      removeBtn.style.borderColor = 'rgba(0,0,0,0.06)';
      removeBtn.addEventListener('click', async () => {
        if (!confirm('Remove this site from automated requests?')) return;
        sites.splice(idx, 1);
        await chrome.storage.local.set({ [SITES_KEY]: sites });
        renderSites();
      });

      actions.appendChild(openBtn);
      actions.appendChild(requestBtn);
      actions.appendChild(removeBtn);

      row.appendChild(origin);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  panel.appendChild(list);

  const note = document.createElement('div');
  note.className = 'tg-request-note';
  note.textContent = 'Tip: If a site provides a data request form or a dedicated privacy contact email this button will open it; otherwise you will be prompted to send an email.';
  panel.appendChild(note);

  container.appendChild(panel);
}

// discoverContactsForSite: best-effort contact discovery for a site origin.
// It attempts to fetch the site's HTML and look for mailto: links and
// likely contact/privacy pages. This will often be blocked by CORS when
// run from an extension page; calls are best-effort and fail gracefully.
async function discoverContactsForSite(siteObj) {
  if (!siteObj || !siteObj.origin) return;
  let origin = siteObj.origin;
  if (!origin.startsWith('http')) origin = 'https://' + origin;

  try {
    const resp = await fetch(origin, { method: 'GET', mode: 'cors' });
    if (!resp.ok) return;
    const text = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/html');

    // look for mailto links
    const mailto = doc.querySelector('a[href^="mailto:"]');
    if (mailto) {
      const mail = mailto.getAttribute('href').replace(/^mailto:/i, '').split('?')[0];
      siteObj.email = mail;
    }

    // look for explicit contact or privacy pages links
    const contactSel = 'a[href*="contact"], a[href*="privacy"], a[rel="author"]';
    const contact = doc.querySelector(contactSel);
    if (contact) {
      let href = contact.getAttribute('href');
      if (href && !href.startsWith('http')) {
        // make absolute
        const base = new URL(origin).origin;
        if (href.startsWith('/')) href = base + href;
        else href = base + '/' + href;
      }
      siteObj.contactUrl = href;
    }

    // persist discovered info back into storage (merge into tg_sites)
    const stored = await chrome.storage.local.get([SITES_KEY]);
    const sites = stored[SITES_KEY] || [];
    const idx = sites.findIndex(s => s.origin === siteObj.origin);
    if (idx !== -1) {
      sites[idx] = Object.assign({}, sites[idx], { email: siteObj.email, contactUrl: siteObj.contactUrl });
      await chrome.storage.local.set({ [SITES_KEY]: sites });
      // If Sites panel is visible, re-render to reflect newly discovered contact
      if (document.querySelector('.dashboard-tab.active')?.dataset.tab === 'sites') renderSites();
    }
  } catch (err) {
    // network errors or CORS; ignore silently
    return;
  }
}

// sendDeleteRequest: tries to open a contact URL if available, otherwise
// crafts a mailto: link prefilled with a short "delete my data" message.
function sendDeleteRequest(site) {
  // Prefer contact page if available
  if (site.contactUrl) {
    window.open(site.contactUrl, '_blank');
    return;
  }

  // If an email is present, open mailto. Otherwise craft a generic mailto
  const to = site.email || '';
  const subject = encodeURIComponent('Request to delete my personal data');
  const body = encodeURIComponent(`Hello,%0D%0A%0D%0AI'd like to request the deletion of my personal data associated with my account or activity on ${site.origin || site.domain || ''}. Please let me know what information you need to verify this request and how long the process will take.%0D%0A%0D%0AThank you.`);

  if (to) {
    window.location.href = `mailto:${to}?subject=${subject}&body=${body}`;
  } else {
    // fallback: open site's root and show instructions
    const url = site.origin && site.origin.startsWith('http') ? site.origin : ('https://' + (site.origin || site.domain || ''));
    // Open in a new tab and show alert with suggested message
    window.open(url, '_blank');
    alert('No contact email found for this site. Opened the site; please look for a privacy/contact page and send a request using this message:\n\n' + decodeURIComponent(body));
  }
}

// loadAllData: read entries/profile/logs from storage and update internal
// state variables (allEntries, allProfile, allLogs) and the stats UI
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

// updateStats: write counters (total entries, profile count, logs, unique sites)
function updateStats() {
  document.getElementById('totalEntries').textContent = allEntries.length;
  document.getElementById('profileEntries').textContent = allProfile.length;
  document.getElementById('totalLogs').textContent = allLogs.length;
  
  // Calculate unique sites
  const uniqueSites = new Set(allLogs.map(log => log.site)).size;
  document.getElementById('uniqueSites').textContent = uniqueSites;
}

// renderLogs: render the activity logs list. Accepts an optional filter
// object {type, site} to narrow results.
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
    
    const fieldInfo = (function(){
      if (!log.fieldContext) return 'Field info not available';
      const raw = log.fieldContext.label || log.fieldContext.placeholder || log.fieldContext.name || 'Unknown';
      return 'Field: ' + (raw.charAt(0).toUpperCase() + raw.slice(1));
    })();

    // Safe-escape helper
    function escapeHtml(s) {
      if (!s) return '';
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    const rawUrl = log.url || 'URL not recorded';
    const maxLen = 70;
    let urlHtml = escapeHtml(rawUrl);
    if (rawUrl.length > maxLen) {
      const short = escapeHtml(rawUrl.slice(0, maxLen) + '…');
      urlHtml = `${short} <a href="#" class="more-btn" data-full="${escapeHtml(rawUrl)}">More</a>`;
    }

  logEntry.innerHTML = `
      <div class="log-header">
        <span class="log-type">${escapeHtml(log.type)}</span>
        <span class="log-time">${new Date(log.timestamp).toLocaleString()}</span>
      </div>
      <div class="log-site">🌐 ${escapeHtml(log.site)}</div>
      <div class="log-details">
        <div><strong>Data used:</strong> ${escapeHtml(log.shortDisplay)}</div>
        <div><strong>${escapeHtml(fieldInfo)}</strong></div>
    <div class="page-row"><strong>Page:</strong> <span class="page-value">${urlHtml}</span></div>
      </div>
    `;
    
    list.appendChild(logEntry);

    // attach more-button behaviour: expand into a contained .full-url element
    const moreBtn = logEntry.querySelector('.more-btn');
    if (moreBtn) {
      moreBtn.addEventListener('click', (e) => {
        const full = e.currentTarget.getAttribute('data-full');
        const valueSpan = e.currentTarget.closest('.page-row')?.querySelector('.page-value') || e.currentTarget.parentElement;
        if (valueSpan) {
          valueSpan.innerHTML = `<span class="full-url">${escapeHtml(full)}</span> <a href="#" class="more-link">Less</a>`;
          const lessLink = valueSpan.querySelector('.more-link');
          lessLink.addEventListener('click', (ev) => { ev.preventDefault(); renderLogs(filter); });
        }
      });
    }
  });
}

// renderEntries: render manual (encrypted) entries metadata list. Shows
// short display + site + added timestamp. Deletion is explicit.
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
    const siteRaw = meta.site || 'Unknown Site';
    const siteDisplay = siteRaw.length > 40 ? escapeHtml(siteRaw.slice(0, 40) + '…') : escapeHtml(siteRaw);

    div.innerHTML = `
      <div class="entry-content">
        <div class="entry-main">
          <strong>${escapeHtml((meta.type || 'Unknown Type').charAt(0).toUpperCase() + (meta.type || 'Unknown Type').slice(1).toLowerCase())}</strong> — ${escapeHtml(meta.short || 'Data')}
        </div>
        <div class="entry-details">
          <div><strong>Site:</strong> ${siteDisplay}${siteRaw.length > 40 ? ' <a href="#" class="more-btn" data-full="' + escapeHtml(siteRaw) + '">More</a>' : ''}</div>
          <div><strong>Added:</strong> ${new Date(meta.ts || Date.now()).toLocaleString()}</div>
          <div><strong>Status:</strong> Encrypted and stored locally</div>
        </div>
      </div>
      <button class="remove danger" data-index="${idx}">Delete</button>
    `;
    
    const removeBtn = div.querySelector('.remove');
    removeBtn.onclick = async () => {
      if (confirm('Are you sure you want to delete this entry? This action cannot be undone.')) {
        // Find the original index in allEntries
        const originalIndex = allEntries.findIndex(e => 
          e.meta?.ts === entry.meta?.ts && 
          e.meta?.type === entry.meta?.type &&
          e.meta?.site === entry.meta?.site
        );
        
        if (originalIndex !== -1) {
          allEntries.splice(originalIndex, 1);
          await chrome.storage.local.set({ [ENTRIES_KEY]: allEntries });
          await cleanupDetectionHashes();
          await loadAllData();
          renderEntries(filter);
        }
      }
    };
    
    list.appendChild(div);
    // More button handler for site: keep expanded URL contained
    const moreBtn2 = div.querySelector('.more-btn');
    if (moreBtn2) {
      moreBtn2.addEventListener('click', (e) => {
        const full = e.currentTarget.getAttribute('data-full');
        const valueSpan = e.currentTarget.parentElement;
        if (valueSpan) {
          valueSpan.innerHTML = `<span class="full-url">${escapeHtml(full)}</span> <a href="#" class="more-link">Less</a>`;
          valueSpan.querySelector('.more-link').addEventListener('click', (ev) => { ev.preventDefault(); renderEntries(filter); });
        }
      });
    }
  });
}

// renderProfile: show profile entries used for automatic detection. Each
// profile entry includes detection statistics and a Delete button that
// only deletes when the user confirms.
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
    
    const fullValue = entry.value || '';
    const displayValue = fullValue.length > 48 ? (fullValue.slice(0, 48) + '…') : fullValue;

    div.innerHTML = `
      <div class="entry-content">
        <div class="entry-main">
          <strong>${entry.type.charAt(0).toUpperCase() + entry.type.slice(1).toLowerCase()}</strong> — ${entry.shortDisplay}
        </div>
        <div class="entry-details" style="color:rgba(255,255,255,0.8);">
          <div><strong>Added:</strong> ${new Date(entry.addedAt).toLocaleString()}</div>
          <div><strong>Status:</strong> Used for automatic detection on websites</div>
          <div><strong>Detection:</strong> ${allLogs.filter(log => log.value === entry.value).length} times detected</div>
          <div><strong>Value:</strong> ${escapeHtml(displayValue)}</div>
        </div>
      </div>
  <button class="remove profile-remove" data-index="${idx}">Delete</button>
    `;
    
    const removeBtn = div.querySelector('.remove');
    removeBtn.onclick = async () => {
      if (confirm('Are you sure you want to delete this profile entry? It will no longer be detected on websites.')) {
        allProfile.splice(idx, 1);
        await chrome.storage.local.set({ [PROFILE_KEY]: allProfile });
        await cleanupDetectionHashes();
        await loadAllData();
        renderProfile();
      }
    };
    
    list.appendChild(div);
  });
}

// cleanupDetectionHashes: this function would normally remove orphaned
// detection hashes. To avoid accidental automatic profile deletions we've
// left it as a safe no-op. Manual deletion remains via the UI.
async function cleanupDetectionHashes() {
  // Intentionally keep detection hashes unchanged here to avoid accidental
  // removal of detection rules. Profile entries should only be removed
  // via the explicit Delete button in the UI.
  try {
    // No-op: leave detection hashes intact. If you want cleanup later,
    // implement a careful offline verification that won't race with async calls.
    return;
  } catch (error) {
    console.error('Error in cleanupDetectionHashes (noop):', error);
  }
}

// sha256Hex: compute a hex SHA-256 digest for a string (used for detection hashes)
async function sha256Hex(msg) {
  const enc = new TextEncoder().encode(msg);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Expose a global refresh helper so any inline buttons or legacy scripts can
// request a refresh without reloading the page. It reloads data and re-renders
// the active tab, and falls back to a full reload if something goes wrong.
window.traceguardRefresh = async function traceguardRefresh() {
  try {
    await loadAllData();
    const activeTab = document.querySelector('.dashboard-tab.active')?.dataset.tab || 'logs';
    switchTab(activeTab);
  } catch (err) {
    console.error('traceguardRefresh failed, falling back to full reload:', err);
    try { location.reload(); } catch (e) { /* ignore */ }
  }
};

// Filter controls: wire UI inputs to the render functions
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

// Clear all logs functionality (explicit user action with confirmation)
document.getElementById('clearAllLogs').addEventListener('click', async () => {
  const confirmMessage = '⚠️ This will permanently delete all activity logs. This action cannot be undone.\n\nAre you sure you want to continue?';
  
  if (!confirm(confirmMessage)) return;
  
  try {
    await chrome.storage.local.set({ [LOGS_KEY]: [] });
    await loadAllData();
    renderLogs();
    
    alert('All activity logs have been cleared.');
  } catch (error) {
    alert('Error clearing logs: ' + error.message);
  }
});

// Lock dashboard functionality: set locked flag and reload
document.getElementById('lockDashBtn').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ locked: true });
    
    alert('Vault has been locked. Please refresh this page to continue.');
    location.reload();
  } catch (error) {
    alert('Error locking vault: ' + error.message);
  }
});

// FIXED: Refresh button functionality - removed chrome.runtime calls
// Refresh button removed from HTML; no handler required.

// Top-level settings button (Refresh and Sites top buttons removed)
const topSettings = document.getElementById('settingsBtn');
if (topSettings) topSettings.addEventListener('click', () => { showSettings(); });

// Initial load: read storage and render the default tab
document.addEventListener('DOMContentLoaded', async () => {
  await loadAllData();
  // ensure tabs DOM wiring: mark the first .dashboard-tab active if none
  const activeTab = document.querySelector('.dashboard-tab.active')?.dataset.tab || 'logs';
  switchTab(activeTab);

  // render settings body initially
  if (typeof renderSettings === 'function') renderSettings();
});
// Minimal refresh handler removed (Refresh button removed from UI)

// Note: Reset handler moved into the Settings modal (tg-reset-all). Old handler removed.

// Initial authentication check: ensure there's a master password and the
// vault is unlocked before loading dashboard data. If locked or missing
// master password we show a simple instruction card.
chrome.storage.local.get(['locked', 'masterHash'], async (result) => {
  const isLocked = result.locked !== false;
  const hasPassword = !!result.masterHash;
  
  if (!hasPassword) {
    document.body.innerHTML = `
      <div style="text-align: center; padding: 60px 20px; max-width: 500px; margin: 0 auto;">
  <h1 style="color: var(--accent); margin-bottom: 24px;">TraceGuard Dashboard</h1>
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
  <h1 style="color: var(--accent); margin-bottom: 24px;">TraceGuard Dashboard</h1>
        <div style="background: var(--card); padding: 32px; border-radius: 12px; border: 1px solid var(--border);">
          <h2 style="margin-bottom: 16px; color: var(--text);">Vault Locked</h2>
          <p style="color: var(--muted); margin-bottom: 24px; line-height: 1.5;">
            Please unlock the vault using the extension popup first, then refresh this page.
          </p>
          <button onclick="(window.traceguardRefresh && window.traceguardRefresh()) || location.reload()" style="background: var(--accent); color: white; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 600; cursor: pointer;">
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

// Settings modal wiring
const settingsModal = document.getElementById('tg-settings-modal');
const settingsBody = document.getElementById('tg-settings-body');
const settingsBtn = document.getElementById('settingsBtn');
const saveSettingsBtn = document.getElementById('tg-save-settings');
const closeSettingsBtn = document.getElementById('tg-close-settings');
const resetAllBtn = document.getElementById('tg-reset-all');

async function renderSettings() {
  try {
    const result = await chrome.storage.local.get(SETTINGS_KEYS);
    const notifyNew = result.tg_notify_new !== false; // default true
    const notifyRepeat = result.tg_notify_repeat !== false; // default true
    const truncate = result.tg_truncate_urls !== false; // default true
    const preserve = result.tg_preserve_session === true; // default false

    settingsBody.innerHTML = `
      <div class="tg-row">
        <div class="left">
          <div class="tg-title">Show notifications for new sites</div>
          <div class="tg-desc">Show a small notification the first time TraceGuard sees a website where your data was used.</div>
        </div>
        <div><input type="checkbox" class="tg-checkbox" id="s_notify_new" ${notifyNew ? 'checked' : ''}/></div>
      </div>
      <div class="tg-row">
        <div class="left">
          <div class="tg-title">Show notifications for repeat detections</div>
          <div class="tg-desc">Also show notifications when the same site is seen again for repeated detections.</div>
        </div>
        <div><input type="checkbox" class="tg-checkbox" id="s_notify_repeat" ${notifyRepeat ? 'checked' : ''}/></div>
      </div>
      <div class="tg-row">
        <div class="left">
          <div class="tg-title">Shorten long page links</div>
          <div class="tg-desc">Shorten very long page addresses in the logs and add a "More" button to see the full link.</div>
        </div>
        <div><input type="checkbox" class="tg-checkbox" id="s_truncate_urls" ${truncate ? 'checked' : ''}/></div>
      </div>
      <div class="tg-row">
        <div class="left">
          <div class="tg-title">Keep me signed in</div>
          <div class="tg-desc">If you enable this TraceGuard will try to stay unlocked between browser restarts.</div>
        </div>
        <div><input type="checkbox" class="tg-checkbox" id="s_preserve_session" ${preserve ? 'checked' : ''}/></div>
      </div>
    `;
  } catch (err) {
    settingsBody.textContent = 'Error loading settings.';
    console.error('renderSettings error:', err);
  }
}

function showSettings() {
  // Ensure modal backdrop is visible and appended to body so positioning is consistent
  if (settingsModal.parentElement !== document.body) document.body.appendChild(settingsModal);
  settingsModal.style.display = 'flex';
  renderSettings();
}

function hideSettings() {
  settingsModal.style.display = 'none';
  // If .tg-settings was moved to body, keep it there; just hide backdrop
}

// Keep modal centered on resize: briefly force reflow if visible
window.addEventListener('resize', () => {
  if (settingsModal && settingsModal.style && settingsModal.style.display === 'block') {
    // nudge reflow without flicker
    settingsModal.style.display = 'none';
    requestAnimationFrame(() => { settingsModal.style.display = 'block'; });
  }
});

settingsBtn.addEventListener('click', (e) => {
  e.preventDefault();
  showSettings();
});

closeSettingsBtn.addEventListener('click', (e) => {
  e.preventDefault();
  hideSettings();
});

saveSettingsBtn.addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const newSettings = {
      tg_notify_new: !!document.getElementById('s_notify_new').checked,
      tg_notify_repeat: !!document.getElementById('s_notify_repeat').checked,
      tg_truncate_urls: !!document.getElementById('s_truncate_urls').checked,
      tg_preserve_session: !!document.getElementById('s_preserve_session').checked,
    };
    await chrome.storage.local.set(newSettings);
    hideSettings();
    alert('Settings saved.');
  } catch (err) {
    alert('Error saving settings: ' + err.message);
  }
});

resetAllBtn.addEventListener('click', async () => {
  const confirmMessage = '⚠️ WARNING: This will permanently delete ALL stored data including:\n\n• Your master password\n• All encrypted entries\n• Your profile information\n• All activity logs\n• All extension data\n\nThis action cannot be undone. Are you absolutely sure?';
  if (!confirm(confirmMessage)) return;
  const finalConfirm = 'Type "DELETE ALL DATA" to confirm permanent deletion:';
  const userInput = prompt(finalConfirm);
  if (userInput !== 'DELETE ALL DATA') { alert('Data deletion cancelled.'); return; }
  try {
    await chrome.storage.local.clear();
    alert('All data has been permanently deleted. The extension will need to be set up again.');
    location.reload();
  } catch (error) {
    alert('Error clearing data: ' + error.message);
  }
});