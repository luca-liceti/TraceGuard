// TraceGuard Background Script - Enhanced with Badge and Messaging
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ locked: true });
  clearAllBadges();
});

chrome.runtime.onInstalled.addListener(() => {
  clearAllBadges();
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'updateBadge') {
    updateBadgeForTab(sender.tab.id, message.count);
  } else if (message.type === 'statusChanged') {
    // Broadcast unlock status to all content scripts
    broadcastToAllTabs(message);
    if (!message.unlocked) {
      clearAllBadges();
    }
  } else if (message.type === 'refreshBadges') {
    refreshAllBadges();
  }
});

// Update badge for specific tab
function updateBadgeForTab(tabId, count) {
  if (count > 0) {
    chrome.action.setBadgeText({
      text: count.toString(),
      tabId: tabId
    });
    chrome.action.setBadgeBackgroundColor({
      color: '#ff3b30',
      tabId: tabId
    });
  } else {
    chrome.action.setBadgeText({
      text: '',
      tabId: tabId
    });
  }
}

// Clear badges on all tabs
async function clearAllBadges() {
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      chrome.action.setBadgeText({
        text: '',
        tabId: tab.id
      });
    });
  } catch (error) {
    console.error('Error clearing badges:', error);
  }
}

// Broadcast message to all tabs
async function broadcastToAllTabs(message) {
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Ignore errors for tabs that don't have content script
      });
    });
  } catch (error) {
    console.error('Error broadcasting message:', error);
  }
}

// Refresh badges on all tabs
async function refreshAllBadges() {
  try {
    const result = await chrome.storage.local.get(['tg_usage_logs']);
    const logs = result.tg_usage_logs || [];
    
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      if (tab.url && tab.url.startsWith('http')) {
        try {
          const hostname = new URL(tab.url).hostname;
          const count = logs.filter(log => log.site === hostname).length;
          updateBadgeForTab(tab.id, count);
        } catch (error) {
          // Ignore URL parsing errors
        }
      }
    });
  } catch (error) {
    console.error('Error refreshing badges:', error);
  }
}

// Handle tab updates to refresh badges
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && tab.url.startsWith('http')) {
    setTimeout(() => {
      chrome.storage.local.get(['tg_usage_logs', 'locked', 'masterHash'], (result) => {
        if (result.locked === false && result.masterHash) {
          try {
            const hostname = new URL(tab.url).hostname;
            const logs = result.tg_usage_logs || [];
            const count = logs.filter(log => log.site === hostname).length;
            updateBadgeForTab(tabId, count);
          } catch (error) {
            // Ignore URL parsing errors
          }
        }
      });
    }, 1000);
  }
});