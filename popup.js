// TraceGuard popup.js  (v3 – improved create/unlock flow)
const SALT_KEY   = 'tg_salt';
const ENTRIES_KEY= 'tg_entries';
const PBKDF_ITER = 200000;

/////  storage helpers
const storageGet   = (keys)=>new Promise(res=>chrome.storage.local.get(keys,res));
const storageSet   = (obj)=>new Promise(res=>chrome.storage.local.set(obj,res));
const storageRemove= (key)=>new Promise(res=>chrome.storage.local.remove(key,res));

/////  crypto helpers
function bufToB64(buf){
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64ToBuf(b64){
  const s=atob(b64);
  const arr=new Uint8Array(s.length);
  for(let i=0;i<s.length;i++) arr[i]=s.charCodeAt(i);
  return arr.buffer;
}
async function genSalt(){
  const s=crypto.getRandomValues(new Uint8Array(16));
  return bufToB64(s.buffer);
}
async function getOrCreateSalt(){
  const r=await storageGet([SALT_KEY]);
  if(r[SALT_KEY]) return r[SALT_KEY];
  const s=await genSalt();
  await storageSet({[SALT_KEY]:s});
  return s;
}
async function deriveKey(password){
  const saltB64=await getOrCreateSalt();
  const salt=new Uint8Array(atob(saltB64).split('').map(c=>c.charCodeAt(0)));
  const enc=new TextEncoder().encode(password);
  const baseKey=await crypto.subtle.importKey('raw',enc,'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'PBKDF2',salt,iterations:PBKDF_ITER,hash:'SHA-256'},
    baseKey,
    {name:'AES-GCM',length:256},
    false,
    ['encrypt','decrypt']
  );
}
async function encryptJSON(obj,key){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const encoded=new TextEncoder().encode(JSON.stringify(obj));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoded);
  return {iv:bufToB64(iv.buffer),ct:bufToB64(ct)};
}
async function decryptJSON(payloadB64,key){
  const ivBuf=b64ToBuf(payloadB64.iv);
  const ctBuf=b64ToBuf(payloadB64.ct);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:ivBuf},key,ctBuf);
  return JSON.parse(new TextDecoder().decode(plain));
}
async function sha256Hex(msg){
  const buf=new TextEncoder().encode(msg);
  const digest=await crypto.subtle.digest('SHA-256',buf);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

/////  UI refs
const masterInput = document.getElementById('master');
const confirmInput= document.getElementById('confirm');
const authBtn     = document.getElementById('authBtn');
const lockTitle   = document.getElementById('lockTitle');
const lockNowBtn  = document.getElementById('lockNowBtn');
const entryForm   = document.getElementById('entryForm');
const valueInput  = document.getElementById('value');
const entriesList = document.getElementById('entriesList');
const searchInput = document.getElementById('search');
const typeSelect  = document.getElementById('type');

let MASTER_KEY = null;
let IS_CREATED = false;
let SESSION_UNLOCKED = false; // Track session state in memory

// Input validation for numeric-only fields
const numericTypes = ['phone', 'ssn', 'credit'];

function setUnlocked(unlocked){
  const lockPanel = document.getElementById('lockPanel');
  const mainUI = document.getElementById('mainUI');
  const lockedMessage = document.getElementById('lockedMessage');
  const lockBtn = document.getElementById('lockNowBtn');
  
  if (unlocked) {
    // Show main interface, hide everything else
    lockPanel.style.display = 'none';
    mainUI.classList.remove('hidden');
    lockedMessage.classList.add('hidden');
    lockBtn.style.display = IS_CREATED ? 'block' : 'none';
  } else {
    // Show lock panel if password exists, otherwise show creation
    lockPanel.style.display = IS_CREATED ? 'block' : 'block';
    mainUI.classList.add('hidden');
    lockedMessage.classList.toggle('hidden', !IS_CREATED);
    lockBtn.style.display = 'none';
  }
}

// Handle input validation for numeric fields
typeSelect.addEventListener('change', () => {
  const selectedType = typeSelect.value;
  if (numericTypes.includes(selectedType)) {
    valueInput.type = 'tel';
    valueInput.addEventListener('input', enforceNumericInput);
  } else {
    valueInput.type = 'text';
    valueInput.removeEventListener('input', enforceNumericInput);
  }
  
  // Update placeholder based on type
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

function enforceNumericInput(e) {
  e.target.value = e.target.value.replace(/[^0-9]/g, '');
}

/////  Auth flow
authBtn.addEventListener('click', async () => {
  const pw      = masterInput.value.trim();
  const confirm = confirmInput.value.trim();

  const { masterHash } = await chrome.storage.local.get(['masterHash']);

  if (!masterHash) {
    // ---- CREATE MODE ----
    if (!pw) return alert('Password cannot be empty');
    if (pw !== confirm) return alert('Passwords do not match');
    if (pw.length < 6) return alert('Password must be at least 6 characters');
    
    const hash = await sha256Hex(pw);
    MASTER_KEY = await deriveKey(pw);
    await chrome.storage.local.set({ masterHash: hash, locked: false });
    IS_CREATED = true;
    
    // Hide password creation UI and show main interface
    document.getElementById('lockPanel').style.display = 'none';
    setUnlocked(true);
    await refreshEntries();
  } else {
    // ---- UNLOCK MODE ----
    if ((await sha256Hex(pw)) !== masterHash) return alert('Incorrect password');
    MASTER_KEY = await deriveKey(pw);
    await chrome.storage.local.set({ locked: false });
    IS_CREATED = true;
    setUnlocked(true);
    await refreshEntries();
  }
  
  // Clear inputs
  masterInput.value = '';
  confirmInput.value = '';
});

lockNowBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ locked: true });
  MASTER_KEY = null;
  IS_CREATED = true; // Keep this true since password still exists
  
  // Reset UI to show unlock screen
  lockTitle.textContent = 'Enter Password';
  confirmInput.parentElement.style.display = 'none';
  authBtn.textContent = 'Unlock';
  masterInput.value = '';
  
  setUnlocked(false);
});

document.getElementById('clearForm').addEventListener('click', () => {
  valueInput.value = '';
});

/////  Save entry
entryForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  
  // Check if we have the master key, if not we need to re-authenticate
  if(!MASTER_KEY) {
    alert('Session expired. Please unlock the vault again.');
    await chrome.storage.local.set({ locked: true });
    setUnlocked(false);
    return;
  }
  
  const raw=valueInput.value.trim(); 
  if(!raw) return alert('Please enter a value');
  
  const type=typeSelect.value;
  const h=await sha256Hex(raw);
  
  // Create appropriate short display based on type
  let short;
  switch(type) {
    case 'phone':
    case 'ssn':
    case 'credit':
      short = '••••' + raw.slice(-4);
      break;
    case 'email':
      const atIndex = raw.indexOf('@');
      if (atIndex > 0) {
        short = raw.charAt(0) + '••••@' + raw.split('@')[1];
      } else {
        short = raw.slice(0, 2) + '••••';
      }
      break;
    default:
      short = raw.split(' ').slice(0, 2).join(' ') + ' …';
  }
  
  let domain='unknown';
  try{
    const tabs=await new Promise(res=>chrome.tabs.query({active:true,currentWindow:true},res));
    domain=new URL(tabs[0]?.url||'').hostname||'unknown';
  }catch{domain='unknown';}
  
  const payloadObj={hash:h,type,fullHint:short,ts:Date.now(),site:domain,originalValue:raw};
  const enc=await encryptJSON(payloadObj, MASTER_KEY);
  const store=await storageGet([ENTRIES_KEY]);
  const arr=store[ENTRIES_KEY]||[];
  arr.push({payload:enc,meta:{type,short,site:domain,ts:payloadObj.ts}});
  await storageSet({[ENTRIES_KEY]:arr});
  valueInput.value='';
  await refreshEntries();
  
  // Also update detection hash index so content scripts can detect typed values
  try {
    const detectStore = await storageGet(['tg_detection_hashes']);
    const detectArr = detectStore['tg_detection_hashes'] || [];
    // Add record if not present
    if (!detectArr.some(d => d.hash === h)) {
      detectArr.push({ hash: h, type, shortDisplay: short });
      await storageSet({ 'tg_detection_hashes': detectArr });
      // Notify content scripts to reload detection hashes
      chrome.runtime.sendMessage({ type: 'detectionUpdated' });
    }
  } catch (err) {
    console.error('Error updating detection hashes:', err);
  }
});

/////  Remove entry
async function removeEntry(idx){
  const store=await storageGet([ENTRIES_KEY]);
  const arr=store[ENTRIES_KEY]||[];
  arr.splice(idx,1);
  await storageSet({[ENTRIES_KEY]:arr});
  await refreshEntries();
}

/////  Render list
async function refreshEntries(){
  entriesList.innerHTML='';
  const store=await storageGet([ENTRIES_KEY]);
  const arr=store[ENTRIES_KEY]||[];
  
  if (arr.length === 0) {
    entriesList.innerHTML = '<div class="empty-state">No entries saved yet</div>';
    return;
  }
  
  for(let i=0;i<arr.length;i++){
    let dec; 
    try{ 
      dec=await decryptJSON(arr[i].payload, MASTER_KEY); 
    } catch { 
      continue; 
    }
    
    const card=document.createElement('div'); 
    card.className='entry-card';
    card.innerHTML=`
      <div class="entry-info">
        <div><strong>${dec.type.charAt(0).toUpperCase() + dec.type.slice(1).toLowerCase()}</strong> • ${arr[i].meta.short}</div>
        <div class="small">site: ${arr[i].meta.site} • ${new Date(arr[i].meta.ts).toLocaleString()}</div>
      </div>
      <button class="remove danger">Remove</button>`;
    card.querySelector('.remove').onclick=()=>removeEntry(i);
    entriesList.appendChild(card);
  }
}

/////  Search
searchInput.addEventListener('input', async (e)=>{
  const q=e.target.value.trim().toLowerCase();
  if (!q) {
    await refreshEntries();
    return;
  }
  
  const store=await storageGet([ENTRIES_KEY]);
  const arr=store[ENTRIES_KEY]||[];
  const filtered=arr.map((it,idx)=>({it,idx}))
    .filter(({it})=>{
      const m=it.meta||{};
      return m.type.toLowerCase().includes(q) ||
        m.short.toLowerCase().includes(q) ||
        m.site.toLowerCase().includes(q);
    });
    
  entriesList.innerHTML='';
  
  if (filtered.length === 0) {
    entriesList.innerHTML = '<div class="empty-state">No matching entries found</div>';
    return;
  }
  
  for(const {it,idx} of filtered){
    const card=document.createElement('div'); 
    card.className='entry-card';
    card.innerHTML=`
      <div class="entry-info">
        <div><strong>${it.meta.type.charAt(0).toUpperCase() + it.meta.type.slice(1).toLowerCase()}</strong> • ${it.meta.short}</div>
        <div class="small">site: ${it.meta.site} • ${new Date(it.meta.ts).toLocaleString()}</div>
      </div>
      <button class="remove danger">Remove</button>`;
    card.querySelector('.remove').onclick=()=>removeEntry(idx);
    entriesList.appendChild(card);
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
(async function init(){
  const {locked, masterHash} = await chrome.storage.local.get(['locked', 'masterHash']);
  
  if (masterHash) {
    // Password exists - check if we need to unlock
    IS_CREATED = true;
    
    // Always hide confirm password for existing users
    const confirmContainer = document.getElementById('confirmContainer');
    confirmContainer.style.display = 'none';
    
    if (locked === false) {
      // Already unlocked in this session, go straight to main UI
      lockTitle.textContent = 'Enter Password';
      authBtn.textContent = 'Unlock';
      
      // Try to maintain session by checking if we can access stored data
      try {
        const testData = await chrome.storage.local.get([ENTRIES_KEY]);
        setUnlocked(true);
        await refreshEntries();
        return;
      } catch {
        // If we can't access data, fall through to show unlock
      }
    }
    
    // Show unlock UI
    lockTitle.textContent = 'Enter Password';
    authBtn.textContent = 'Unlock';
    setUnlocked(false);
    
  } else {
    // First time - show create UI
    IS_CREATED = false;
    lockTitle.textContent = 'Create Master Password';
    const confirmContainer = document.getElementById('confirmContainer');
    confirmContainer.style.display = 'block';
    authBtn.textContent = 'Create Password';
    setUnlocked(false);
  }
})();