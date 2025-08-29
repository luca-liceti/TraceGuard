// TraceGuard Enhanced Popup (v4 – with profile management and activity logs)
const SALT_KEY = 'tg_salt';
const ENTRIES_KEY = 'tg_entries';
const PROFILE_KEY = 'tg_known_pii';
const LOGS_KEY = 'tg_usage_logs';
const PBKDF_ITER = 200000;

/////  storage helpers
const storageGet = (keys) => new Promise(res => chrome.storage.local.get(keys, res));
const storageSet = (obj) => new Promise(res => chrome.storage.local.set(obj, res));
const storageRemove = (key) => new Promise(res => chrome.storage.local.remove(key, res));

/////  crypto helpers
function bufToB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64) {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr.buffer;
}
async function genSalt() {
  const s = crypto.getRandomValues(new Uint8Array(16));
  return bufToB64(s.buffer);
}
async function getOrCreateSalt() {
  const r = await storageGet([SALT_KEY]);
  if (r[SALT_KEY]) return r[SALT_KEY];
  const s = await genSalt();
  await storageSet({ [SALT_KEY]: s });
  return s;
}
async function deriveKey(password) {
  const saltB64 = await getOrCreateSalt();
  const salt = new Uint8Array(atob(saltB64).split('').map(c => c.charCodeAt(0)));
  const enc = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function encryptJSON(obj, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { iv: bufToB64(iv.buffer), ct: bufToB64(ct) };
}
async function decryptJSON(payloadB64, key) {
  const ivBuf = b64ToBuf(payloadB64.iv);
  const ctBuf = b64ToBuf(payloadB64.ct);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ctBuf);
  return JSON.parse(new TextDecoder().decode(plain));
}
async function sha256Hex(msg) {
  const buf = new TextEncoder().encode(msg);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/////  UI refs
const masterInput = document.getElementById('master');
const confirmInput = document.getElementById('confirm');
const authBtn = document.getElementById('authBtn');
const lockTitle = document.getElementById('lockTitle');
const lockNowBtn = document.getElementById('lockNowBtn');
const entryForm = document.getElementById('entryForm');
const valueInput = document.getElementById('value');
const entriesList = document.getElementById('entriesList');
const searchInput = document.getElementById('search');
const typeSelect = document.getElementById('type');

// Profile management refs
const profileForm = document.getElementById('profileForm');
const profileTypeSelect = document.getElementById('profileType');
const profileValueInput = document.getElementById('profileValue');
const profileList = document.getElementById('profileList');

// Logs refs
const logsList = document.getElementById('logsList');
const logSearchInput = document.getElementById('logSearch');

let MASTER_KEY = null;
let IS_CREATED = false;

// Input validation for numeric-only fields
const numericTypes = ['phone', 'ssn', 'credit'];

// Tab management
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabId = btn.dataset.tab;
    switchTab(tabId);
  });
});

function switchTab(tabId) {
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Update tab content
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === tabId + 'Tab');
  });

  // Load data for the selected tab
  if (tabId === 'profile') {
    refreshProfileEntries();
  } else if (tabId === 'logs') {
    refreshLogs();
  } else if (tabId === 'manual') {
    refreshEntries();
  }
}

function setUnlocked(unlocked) {
  const lockPanel = document.getElementById('lockPanel');
  const mainUI = document.getElementById('mainUI');
  const lockedMessage = document.getElementById('lockedMessage');
  const lockBtn = document.getElementById('lockNowBtn');

  if (unlocked) {
    lockPanel.style.display = 'none';
    mainUI.classList.remove('hidden');
    lockedMessage.classList.add('hidden');
    lockBtn.style.display = IS_CREATED ? 'block' : 'none';

    // Notify content scripts about unlock status
    chrome.runtime.sendMessage({
      type: 'statusChanged',
      unlocked: true
    });

    // Refresh current tab
    const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
    switchTab(activeTab);
  } else {
    lockPanel.style.display = IS_CREATED ? 'block' : 'block';
    mainUI.classList.add('hidden');
    lockedMessage.classList.toggle('hidden', !IS_CREATED);
    lockBtn.style.display = 'none';

    // Notify content scripts about lock status
    chrome.runtime.sendMessage({
      type: 'statusChanged',
      unlocked: false
    });
  }
}

// Handle input validation for numeric fields
function setupInputValidation(typeSelect, valueInput) {
  typeSelect.addEventListener('change', () => {
    const selectedType = typeSelect.value;
    if (numericTypes.includes(selectedType)) {
      valueInput.type = 'tel';
      valueInput.addEventListener('input', enforceNumericInput);
    } else {
      valueInput.type = 'text';
      valueInput.removeEventListener('input', enforceNumericInput);
    }

    const placeholders = {
      'email': 'Enter email address',
      'phone': 'Enter phone number',
      'address': 'Enter full address',
      'ssn': 'Enter SSN',
      'credit': 'Enter credit card number',
      'license': 'Enter driver license number',
      'passport': 'Enter passport number'
    };
    valueInput.placeholder = placeholders[selectedType] || 'Enter value';
  });
}

function enforceNumericInput(e) {
  e.target.value = e.target.value.replace(/[^0-9]/g, '');
}

// Setup validation for both forms
setupInputValidation(typeSelect, valueInput);
setupInputValidation(profileTypeSelect, profileValueInput);

/////  Auth flow
authBtn.addEventListener('click', async () => {
  const pw = masterInput.value.trim();
  const confirm = confirmInput.value.trim();

  const { masterHash } = await chrome.storage.local.get(['masterHash']);

  if (!masterHash) {
    // CREATE MODE
    if (!pw) return alert('Password cannot be empty');
    if (pw !== confirm) return alert('Passwords do not match');
    if (pw.length < 6) return alert('Password must be at least 6 characters');

    const hash = await sha256Hex(pw);
    MASTER_KEY = await deriveKey(pw);
    await chrome.storage.local.set({ masterHash: hash, locked: false });
    IS_CREATED = true;

    document.getElementById('lockPanel').style.display = 'none';
    setUnlocked(true);
  } else {
    // UNLOCK MODE
    if ((await sha256Hex(pw)) !== masterHash) return alert('Incorrect password');
    MASTER_KEY = await deriveKey(pw);
    await chrome.storage.local.set({ locked: false });
    IS_CREATED = true;
    setUnlocked(true);
  }

  masterInput.value = '';
  confirmInput.value = '';
});

lockNowBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ locked: true });
  MASTER_KEY = null;
  IS_CREATED = true;

  lockTitle.textContent = 'Enter Password';
  confirmInput.parentElement.style.display = 'none';
  authBtn.textContent = 'Unlock';
  masterInput.value = '';

  setUnlocked(false);
});

document.getElementById('clearForm').addEventListener('click', () => {
  valueInput.value = '';
});

document.getElementById('clearProfileForm').addEventListener('click', () => {
  profileValueInput.value = '';
});

/////  Manual Entry (original functionality)
entryForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!MASTER_KEY) {
    alert('Session expired. Please unlock the vault again.');
    await chrome.storage.local.set({ locked: true });
    setUnlocked(false);
    return;
  }

  const raw = valueInput.value.trim();
  if (!raw) return alert('Please enter a value');

  const type = typeSelect.value;
  const h = await sha256Hex(raw);

  let short = createShortDisplay(raw, type);

  let domain = 'unknown';
  try {
    const tabs = await new Promise(res => chrome.tabs.query({ active: true, currentWindow: true }, res));
    domain = new URL(tabs[0]?.url || '').hostname || 'unknown';
  } catch { domain = 'unknown'; }

  const payloadObj = { hash: h, type, fullHint: short, ts: Date.now(), site: domain, originalValue: raw };
  const enc = await encryptJSON(payloadObj, MASTER_KEY);
  const store = await storageGet([ENTRIES_KEY]);
  const arr = store[ENTRIES_KEY] || [];
  arr.push({ payload: enc, meta: { type, short, site: domain, ts: payloadObj.ts } });
  await storageSet({ [ENTRIES_KEY]: arr });
  valueInput.value = '';
  await refreshEntries();
  // Update detection hashes so content scripts can match typed values by hash
  try {
    const detectStore = await storageGet(['tg_detection_hashes']);
    const detectArr = detectStore['tg_detection_hashes'] || [];
    if (!detectArr.some(d => d.hash === h)) {
      detectArr.push({ hash: h, type, shortDisplay: short });
      await storageSet({ 'tg_detection_hashes': detectArr });
      chrome.runtime.sendMessage({ type: 'detectionUpdated' });
    }
  } catch (err) {
    console.error('Error updating detection hashes:', err);
  }
});

/////  Profile Management
profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!MASTER_KEY) {
    alert('Session expired. Please unlock the vault again.');
    return;
  }

  const raw = profileValueInput.value.trim();
  if (!raw) return alert('Please enter a value');

  const type = profileTypeSelect.value;

  // Validation
  if (!isValidPII(raw, type)) {
    return alert('Please enter a valid ' + type);
  }

  const short = createShortDisplay(raw, type);

  // Add to profile (unencrypted for detection)
  const store = await storageGet([PROFILE_KEY]);
  const profile = store[PROFILE_KEY] || [];

  // Check for duplicates
  if (profile.some(entry => entry.value === raw && entry.type === type)) {
    return alert('This information is already in your profile');
  }

  profile.push({
    type,
    value: raw,
    shortDisplay: short,
    addedAt: Date.now()
  });

  await storageSet({ [PROFILE_KEY]: profile });
  profileValueInput.value = '';
  await refreshProfileEntries();

  // Notify content scripts to reload known entries
  chrome.runtime.sendMessage({
    type: 'statusChanged',
    unlocked: true
  });
  // Also add detection hash for this profile entry to allow detection while locked
  try {
    const h = await sha256Hex(raw);
    const detectStore = await storageGet(['tg_detection_hashes']);
    const detectArr = detectStore['tg_detection_hashes'] || [];
    if (!detectArr.some(d => d.hash === h)) {
      detectArr.push({ hash: h, type, shortDisplay: short });
      await storageSet({ 'tg_detection_hashes': detectArr });
      chrome.runtime.sendMessage({ type: 'detectionUpdated' });
    }
  } catch (err) {
    console.error('Error updating detection hashes for profile entry:', err);
  }
});

function isValidPII(value, type) {
  const patterns = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    phone: /^[\+]?[\(\)\-\s\d]{10,15}$/,
    ssn: /^\d{3}-?\d{2}-?\d{4}$/,
    credit: /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/
  };

  if (patterns[type]) {
    return patterns[type].test(value);
  }
  return value.length >= 3; // Basic validation for other types
}

function createShortDisplay(raw, type) {
  switch (type) {
    case 'phone':
    case 'ssn':
    case 'credit':
      return '••••' + raw.slice(-4);
    case 'email':
      const atIndex = raw.indexOf('@');
      if (atIndex > 0) {
        return raw.charAt(0) + '••••@' + raw.split('@')[1];
      } else {
        return raw.slice(0, 2) + '••••';
      }
    default:
      return raw.split(' ').slice(0, 2).join(' ') + ' …';
  }
}

/////  Remove functions
async function removeEntry(idx) {
  const store = await storageGet([ENTRIES_KEY]);
  const arr = store[ENTRIES_KEY] || [];
  arr.splice(idx, 1);
  await storageSet({ [ENTRIES_KEY]: arr });
  await refreshEntries();
}

async function removeProfileEntry(idx) {
  const store = await storageGet([PROFILE_KEY]);
  const arr = store[PROFILE_KEY] || [];
  // compute hash for removed profile entry and remove from detection index
  const removed = arr.splice(idx, 1)[0];
  await storageSet({ [PROFILE_KEY]: arr });
  await refreshProfileEntries();

  try {
    const h = await sha256Hex(removed.value);
    const detectStore = await storageGet(['tg_detection_hashes']);
    let detectArr = detectStore['tg_detection_hashes'] || [];
    detectArr = detectArr.filter(d => d.hash !== h);
    await storageSet({ 'tg_detection_hashes': detectArr });
    chrome.runtime.sendMessage({ type: 'detectionUpdated' });
  } catch (err) {
    console.error('Error removing detection hash for profile entry:', err);
  }
  // Notify content scripts about lock/state change
  chrome.runtime.sendMessage({ type: 'statusChanged', unlocked: true });
}

/////  Render functions
async function refreshEntries() {
  entriesList.innerHTML = '';
  const store = await storageGet([ENTRIES_KEY]);
  const arr = store[ENTRIES_KEY] || [];

  if (arr.length === 0) {
    entriesList.innerHTML = '<div class="empty-state">No entries saved yet</div>';
    return;
  }

  for (let i = 0; i < arr.length; i++) {
    let dec;
    try {
      dec = await decryptJSON(arr[i].payload, MASTER_KEY);
    } catch {
      continue;
    }

    const card = document.createElement('div');
    card.className = 'entry-card';
    card.innerHTML = `
      <div class="entry-info">
        <div><strong>${dec.type.charAt(0).toUpperCase() + dec.type.slice(1).toLowerCase()}</strong> • ${arr[i].meta.short}</div>
        <div class="small">site: ${arr[i].meta.site} • ${new Date(arr[i].meta.ts).toLocaleString()}</div>
      </div>
      <button class="remove danger">Remove</button>`;
    card.querySelector('.remove').onclick = () => removeEntry(i);
    entriesList.appendChild(card);
  }
}

async function refreshProfileEntries() {
  profileList.innerHTML = '';
  const store = await storageGet([PROFILE_KEY]);
  const profile = store[PROFILE_KEY] || [];

  if (profile.length === 0) {
    profileList.innerHTML = '<div class="empty-state">No profile entries yet</div>';
    return;
  }

  profile.forEach((entry, idx) => {
    const card = document.createElement('div');
    card.className = 'entry-card profile-entry';
    card.innerHTML = `
      <div class="entry-info">
        <div><strong>${entry.type.charAt(0).toUpperCase() + entry.type.slice(1).toLowerCase()}</strong> • ${entry.shortDisplay}</div>
        <div class="small">Added: ${new Date(entry.addedAt).toLocaleString()}</div>
      </div>
      <button class="remove">Remove</button>`;
    card.querySelector('.remove').onclick = () => removeProfileEntry(idx);
    profileList.appendChild(card);
  });
}

async function refreshLogs() {
  logsList.innerHTML = '';
  const store = await storageGet([LOGS_KEY]);
  const logs = store[LOGS_KEY] || [];

  if (logs.length === 0) {
    logsList.innerHTML = '<div class="empty-state">No activity logs yet</div>';
    return;
  }

  // Sort logs by timestamp (newest first)
  logs.sort((a, b) => b.timestamp - a.timestamp);

  logs.forEach(log => {
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    logEntry.innerHTML = `
      <div class="log-header">
        <span class="log-type">${log.type}</span>
        <span class="log-time">${new Date(log.timestamp).toLocaleString()}</span>
      </div>
      <div class="log-site">${log.site}</div>
      <div class="log-details">
        Used: ${log.shortDisplay} • Field: ${log.fieldContext?.label || log.fieldContext?.placeholder || 'Unknown field'}
      </div>
    `;
    logsList.appendChild(logEntry);
  });
}

/////  Search functionality
searchInput.addEventListener('input', async (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    await refreshEntries();
    return;
  }

  const store = await storageGet([ENTRIES_KEY]);
  const arr = store[ENTRIES_KEY] || [];
  const filtered = arr.map((it, idx) => ({ it, idx }))
    .filter(({ it }) => {
      const m = it.meta || {};
      return m.type.toLowerCase().includes(q) ||
        m.short.toLowerCase().includes(q) ||
        m.site.toLowerCase().includes(q);
    });

  entriesList.innerHTML = '';

  if (filtered.length === 0) {
    entriesList.innerHTML = '<div class="empty-state">No matching entries found</div>';
    return;
  }

  for (const { it, idx } of filtered) {
    const card = document.createElement('div');
    card.className = 'entry-card';
    card.innerHTML = `
      <div class="entry-info">
        <div><strong>${it.meta.type.charAt(0).toUpperCase() + it.meta.type.slice(1).toLowerCase()}</strong> • ${it.meta.short}</div>
        <div class="small">site: ${it.meta.site} • ${new Date(it.meta.ts).toLocaleString()}</div>
      </div>
      <button class="remove danger">Remove</button>`;
    card.querySelector('.remove').onclick = () => removeEntry(idx);
    entriesList.appendChild(card);
  }
});

logSearchInput.addEventListener('input', async (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) {
    await refreshLogs();
    return;
  }

  const store = await storageGet([LOGS_KEY]);
  const logs = store[LOGS_KEY] || [];
  const filtered = logs.filter(log =>
    log.site.toLowerCase().includes(q) ||
    log.type.toLowerCase().includes(q) ||
    (log.fieldContext?.label || '').toLowerCase().includes(q)
  );

  logsList.innerHTML = '';

  if (filtered.length === 0) {
    logsList.innerHTML = '<div class="empty-state">No matching logs found</div>';
    return;
  }

  filtered.sort((a, b) => b.timestamp - a.timestamp);

  filtered.forEach(log => {
    const logEntry = document.createElement('div');
    logEntry.className = 'log-entry';
    logEntry.innerHTML = `
      <div class="log-header">
        <span class="log-type">${log.type}</span>
        <span class="log-time">${new Date(log.timestamp).toLocaleString()}</span>
      </div>
      <div class="log-site">${log.site}</div>
      <div class="log-details">
        Used: ${log.shortDisplay} • Field: ${log.fieldContext?.label || log.fieldContext?.placeholder || 'Unknown field'}
      </div>
    `;
    logsList.appendChild(logEntry);
  });
});

// Clear logs functionality
document.getElementById('clearLogs').addEventListener('click', async () => {
  if (confirm('Are you sure you want to clear all activity logs?')) {
    await storageSet({ [LOGS_KEY]: [] });
    await refreshLogs();
    
    // Refresh badges
    chrome.runtime.sendMessage({ type: 'refreshBadges' });
  }
});

// Handle Enter key on password inputs
masterInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    if (!IS_CREATED && confirmInput.style.display !== 'none') {
      confirmInput.focus();
    } else {
      authBtn.click();
    }
  }
});

confirmInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    authBtn.click();
  }
});

/////  Init
(async function init() {
  const { locked, masterHash } = await chrome.storage.local.get(['locked', 'masterHash']);

  if (masterHash) {
    IS_CREATED = true;
    const confirmContainer = document.getElementById('confirmContainer');
    confirmContainer.style.display = 'none';

    if (locked === false) {
      lockTitle.textContent = 'Enter Password';
      authBtn.textContent = 'Unlock';

      try {
        const testData = await chrome.storage.local.get([ENTRIES_KEY]);
        setUnlocked(true);
        return;
      } catch {
        // Fall through to show unlock
      }
    }

    lockTitle.textContent = 'Enter Password';
    authBtn.textContent = 'Unlock';
    setUnlocked(false);

  } else {
    IS_CREATED = false;
    lockTitle.textContent = 'Create Master Password';
    const confirmContainer = document.getElementById('confirmContainer');
    confirmContainer.style.display = 'block';
    authBtn.textContent = 'Create Password';
    setUnlocked(false);
  }
})();