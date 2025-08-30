// TraceGuard Content Script - Form Detection and Monitoring
// This script runs in page context and:
// - loads detection hashes/profile entries from storage
// - monitors form inputs and submissions
// - matches typed/pasted values against known profile values or hash list
// - logs detections to extension storage and shows a transient UI notification
let isUnlocked = false;
let knownEntries = [];
let lastNotificationTime = {};
const NOTIFICATION_COOLDOWN = 5000; // 5 seconds between notifications for same field
let detectionHashes = []; // { hash, type, shortDisplay }

// Field patterns for detection
const FIELD_PATTERNS = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  phone: /^[\+]?[\(\)\-\s\d]{10,15}$/,
  ssn: /^\d{3}-?\d{2}-?\d{4}$/,
  credit: /^\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}$/
};

// Initialize
chrome.storage.local.get(['locked', 'masterHash'], (result) => {
  isUnlocked = result.locked === false && result.masterHash;
  // Always load detection hashes and start monitoring inputs so hash-based detection works even when locked
  loadDetectionHashes();
  initFormMonitoring();

  if (isUnlocked) {
    loadKnownEntries();
    updateBadge();
  }
});

// Listen for unlock status changes
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'statusChanged') {
    isUnlocked = message.unlocked;
    if (isUnlocked) {
      loadKnownEntries();
      updateBadge();
    } else {
      knownEntries = [];
    }
  } else if (message.type === 'detectionUpdated') {
    loadDetectionHashes();
  }
});

// loadKnownEntries: load unencrypted profile entries used for direct matching
async function loadKnownEntries() {
  try {
    const result = await chrome.storage.local.get(['tg_known_pii']);
    knownEntries = result.tg_known_pii || [];
  } catch (error) {
    console.error('Error loading known entries:', error);
  }
}

// loadDetectionHashes: load the list of stored detection hashes. These are
// sha256 hashes of profile values and are used for robust detection of
// typed values that may have formatting differences.
async function loadDetectionHashes() {
  try {
    const result = await chrome.storage.local.get(['tg_detection_hashes']);
    detectionHashes = result.tg_detection_hashes || [];
  } catch (error) {
    console.error('Error loading detection hashes:', error);
  }
}

// initFormMonitoring: attach listeners to the page to monitor input, paste,
// and submit events so we can detect PII being entered into forms.
function initFormMonitoring() {
  // Monitor input changes
  document.addEventListener('input', handleInputChange, true);

  // Monitor form submissions
  document.addEventListener('submit', handleFormSubmit, true);

  // Monitor paste events
  document.addEventListener('paste', handlePaste, true);
}

// Handle input changes
function handleInputChange(event) {
  if (!event.target.matches('input, textarea')) return;

  const value = event.target.value.trim();
  if (value.length < 3) return;

  debounce(() => checkForKnownPII(event.target, value), 500)();
}

// Handle paste events
function handlePaste(event) {
  if (!event.target.matches('input, textarea')) return;

  setTimeout(() => {
    const value = event.target.value.trim();
    if (value.length >= 3) {
      checkForKnownPII(event.target, value);
    }
  }, 100);
}

// checkForKnownPII: core detection logic. First tries plain-text matching
// against known profile entries (when unlocked). Then falls back to
// hash-based matching using detectionHashes.
async function checkForKnownPII(element, value) {
  // 1) If unlocked, check plain knownEntries first (profile entries)
  if (isUnlocked && knownEntries.length > 0) {
    const matches = knownEntries.filter(entry => {
      if (entry.value === value) return true;

      if (entry.type === 'phone') {
        const cleanInput = value.replace(/\D/g, '');
        const cleanStored = (entry.value || '').replace(/\D/g, '');
        return cleanInput === cleanStored && cleanInput.length >= 10;
      }

      if (entry.type === 'ssn') {
        const cleanInput = value.replace(/\D/g, '');
        const cleanStored = (entry.value || '').replace(/\D/g, '');
        return cleanInput === cleanStored && cleanInput.length === 9;
      }

      if (entry.type === 'credit') {
        const cleanInput = value.replace(/\D/g, '');
        const cleanStored = (entry.value || '').replace(/\D/g, '');
        return cleanInput === cleanStored && cleanInput.length >= 13;
      }

      return false;
    });

    if (matches.length > 0) {
      const match = matches[0];
      logPIIUsage(match, element);
      showNotification(match);
      return;
    }
  }

  // 2) Hash-based detection: compute SHA-256 of typed value and compare to detectionHashes
  if (detectionHashes.length > 0) {
    try {
      // Compute a few normalized variants to handle formatting differences
      const variants = [value, value.replace(/\D/g, ''), value.toLowerCase()];
      const hashes = await Promise.all(variants.map(v => sha256Hex(v)));
      const match = detectionHashes.find(e => hashes.includes(e.hash));
      if (match) {
        const matchMeta = match;
        const found = { type: matchMeta.type, value: matchMeta.hash, shortDisplay: matchMeta.shortDisplay };
        logPIIUsage(found, element);
        showNotification(found);
        return;
      }
    } catch (err) {
      console.error('Error computing hash for detection:', err);
    }
  }
}

// sha256Hex: helper used both for detection and for storing detection hashes
async function sha256Hex(msg) {
  const enc = new TextEncoder().encode(msg);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// logPIIUsage: record a detection to storage, include page/context info,
// and update the extension badge. Keeps logs capped to avoid unbounded growth.
async function logPIIUsage(match, element) {
  const log = {
    type: match.type,
    value: match.value,
    shortDisplay: match.shortDisplay,
    site: window.location.hostname,
    url: window.location.href,
    timestamp: Date.now(),
    fieldContext: getFieldContext(element)
  };
  
  // Save to logs
  const result = await chrome.storage.local.get(['tg_usage_logs']);
  const logs = result.tg_usage_logs || [];
  logs.push(log);
  
  // Keep only last 1000 logs
  if (logs.length > 1000) {
    logs.splice(0, logs.length - 1000);
  }
  
  await chrome.storage.local.set({ tg_usage_logs: logs });
  
  // Update badge
  updateBadge();
}

// getFieldContext: extract helpful metadata about the input field that triggered
// detection (label, placeholder, name/id) so the user can understand where
// the detection happened.
function getFieldContext(element) {
  const context = {
    tagName: element.tagName.toLowerCase(),
    type: element.type || '',
    name: element.name || '',
    id: element.id || '',
    placeholder: element.placeholder || '',
    label: ''
  };
  
  // Try to find associated label
  if (element.id) {
    const label = document.querySelector(`label[for="${element.id}"]`);
    if (label) context.label = label.textContent.trim();
  }
  
  // Try to find nearby label
  if (!context.label) {
    const parent = element.closest('div, p, li, td, th');
    if (parent) {
      const label = parent.querySelector('label');
      if (label) context.label = label.textContent.trim();
    }
  }
  
  return context;
}

// showNotification: small in-page visual that informs the user that the
// extension detected a profile value in a page field. This is transient.
async function showNotification(match) {
  const fieldKey = `${match.type}_${window.location.hostname}`;
  const now = Date.now();
  
  if (lastNotificationTime[fieldKey] && (now - lastNotificationTime[fieldKey]) < NOTIFICATION_COOLDOWN) {
    return;
  }
  
  lastNotificationTime[fieldKey] = now;
  
  // Check user settings to decide whether to show notifications
  try {
    const prefs = await chrome.storage.local.get(['tg_notify_new', 'tg_notify_repeat', 'tg_preserve_session']);
    const notifyNew = prefs.tg_notify_new !== false; // default true
    const notifyRepeat = prefs.tg_notify_repeat !== false; // default true

    // Determine whether this site has been seen before
    const store = await chrome.storage.local.get(['tg_usage_logs']);
    const logs = store.tg_usage_logs || [];
    const seenBefore = logs.some(l => l.site === window.location.hostname && l.type === match.type);

    if (!seenBefore && !notifyNew) return;
    if (seenBefore && !notifyRepeat) return;
  } catch (err) {
    // If prefs can't be read, fall back to showing notification
  }

  // Use a single shared notification element with class-based transitions
  let shared = document.getElementById('traceguard-notification');
  if (!shared) {
    shared = document.createElement('div');
    shared.id = 'traceguard-notification';
    shared.className = 'tg-notification';
    shared.setAttribute('role', 'status');
    shared.innerHTML = `<div class="tg-icon" aria-hidden="true">🔒</div><div class="tg-content"><div class="tg-title">TraceGuard</div><div class="tg-msg"></div></div>`;
    document.body.appendChild(shared);

    // Inject style once (theme-aware)
    const style = document.createElement('style');
    style.id = 'traceguard-notification-style';
    style.textContent = `
      .tg-notification{ position:fixed; top:18px; right:18px; padding:10px 12px; border-radius:10px; box-shadow:0 12px 30px rgba(0,0,0,0.18); z-index:100000; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:13px; max-width:360px; display:flex; gap:10px; align-items:center; transform:translateY(-8px) translateX(8px); opacity:0; transition:transform 320ms cubic-bezier(.2,.9,.2,1), opacity 240ms ease; }
      .tg-notification .tg-icon{ width:36px; height:36px; border-radius:8px; display:flex; align-items:center; justify-content:center; flex:0 0 36px; }
      .tg-notification .tg-content{ display:flex; flex-direction:column; gap:3px; }
      .tg-notification .tg-title{ font-weight:700; font-size:13px; }
      .tg-notification .tg-msg{ font-weight:500; font-size:13px; color:inherit; }
      .tg-notification.tg-show{ transform:translateY(0) translateX(0); opacity:1; }
      @media (prefers-color-scheme: light){ .tg-notification{ background:#fff; color:#0b0b0b; border:1px solid rgba(0,0,0,0.06);} .tg-notification .tg-icon{ background:#eef6ff; color:#0a66ff; } }
      @media (prefers-color-scheme: dark){ .tg-notification{ background:#1b1b1d; color:#eaeaec; border:1px solid rgba(255,255,255,0.04);} .tg-notification .tg-icon{ background:rgba(10,132,255,0.12); color:#0a84ff; } }
    `;
    document.head.appendChild(style);
  }

  const msg = shared.querySelector('.tg-msg');
  msg.textContent = `Detected: ${match.type.toUpperCase()} (${match.shortDisplay})`;
  shared.classList.add('tg-show');

  // Hide after a timeout
  setTimeout(() => { shared.classList.remove('tg-show'); }, 3200);
}

// updateBadge: compute the number of detections for the current site and
// notify the background script to update the extension action badge.
async function updateBadge() {
  try {
    const result = await chrome.storage.local.get(['tg_usage_logs']);
    const logs = result.tg_usage_logs || [];
    const siteCount = logs.filter(log => log.site === window.location.hostname).length;
    
    if (siteCount > 0) {
      chrome.runtime.sendMessage({
        type: 'updateBadge',
        count: siteCount
      });
    }
  } catch (error) {
    console.error('Error updating badge:', error);
  }
}

// debounce utility: common debounce function to avoid spamming detection checks
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Handle form submission logging
function handleFormSubmit(event) {
  if (!isUnlocked) return;
  
  const form = event.target;
  const inputs = form.querySelectorAll('input, textarea, select');
  
  inputs.forEach(input => {
    const value = input.value.trim();
    if (value.length >= 3) {
      checkForKnownPII(input, value);
    }
  });
}