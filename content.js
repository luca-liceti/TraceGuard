// TraceGuard Content Script - Form Detection and Monitoring
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

// Load known PII entries from storage
async function loadKnownEntries() {
  try {
    const result = await chrome.storage.local.get(['tg_known_pii']);
    knownEntries = result.tg_known_pii || [];
  } catch (error) {
    console.error('Error loading known entries:', error);
  }
}

// Load detection hashes used for hash-based matching
async function loadDetectionHashes() {
  try {
    const result = await chrome.storage.local.get(['tg_detection_hashes']);
    detectionHashes = result.tg_detection_hashes || [];
  } catch (error) {
    console.error('Error loading detection hashes:', error);
  }
}

// Initialize form monitoring
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

// Check if input matches known PII
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

// SHA-256 helper (returns hex string)
async function sha256Hex(msg) {
  const enc = new TextEncoder().encode(msg);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Log PII usage
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

// Get context about the form field
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

// Show notification
function showNotification(match) {
  const fieldKey = `${match.type}_${window.location.hostname}`;
  const now = Date.now();
  
  if (lastNotificationTime[fieldKey] && (now - lastNotificationTime[fieldKey]) < NOTIFICATION_COOLDOWN) {
    return;
  }
  
  lastNotificationTime[fieldKey] = now;
  
  // Create visual notification
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #007aff;
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 10000;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    max-width: 300px;
    animation: slideIn 0.3s ease;
  `;
  
  notification.innerHTML = `
    <strong>🔒 TraceGuard</strong><br>
    Detected: ${match.type.toUpperCase()} (${match.shortDisplay})
  `;
  
  // Add animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }
  `;
  document.head.appendChild(style);
  
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Update badge with site log count
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

// Debounce utility
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