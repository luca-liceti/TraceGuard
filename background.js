// Ensure vault is locked once per browser start
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ locked: true });
});