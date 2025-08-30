// Settings page script
const keys = ['tg_notify_new', 'tg_notify_repeat', 'tg_truncate_urls', 'tg_preserve_session'];

async function storageGet(keysArr){ return new Promise(res=>chrome.storage.local.get(keysArr,res)); }
async function storageSet(obj){ return new Promise(res=>chrome.storage.local.set(obj,res)); }

window.addEventListener('DOMContentLoaded', async ()=>{
  const els = {
    notifyNew: document.getElementById('notifyNew'),
    notifyRepeat: document.getElementById('notifyRepeat'),
    truncateUrls: document.getElementById('truncateUrls'),
    preserveSession: document.getElementById('preserveSession')
  };

  const store = await storageGet(keys);
  els.notifyNew.checked = !!store['tg_notify_new'];
  els.notifyRepeat.checked = !!store['tg_notify_repeat'];
  els.truncateUrls.checked = store['tg_truncate_urls'] !== false; // default true
  els.preserveSession.checked = store['tg_preserve_session'] !== false; // default true

  document.getElementById('saveSettings').addEventListener('click', async ()=>{
    await storageSet({
      'tg_notify_new': els.notifyNew.checked,
      'tg_notify_repeat': els.notifyRepeat.checked,
      'tg_truncate_urls': els.truncateUrls.checked,
      'tg_preserve_session': els.preserveSession.checked
    });
    alert('Settings saved');
  });

  document.getElementById('closeBtn').addEventListener('click', ()=> window.close());
});
