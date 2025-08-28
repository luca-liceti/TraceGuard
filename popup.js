// TraceGuard popup.js  (v3 – fixed create/unlock flow)
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

function setUnlocked(unlocked){
  document.getElementById('lockPanel').classList.toggle('hidden', unlocked);
  document.getElementById('mainUI').classList.toggle('hidden', !unlocked);
}

/////  Auth flow
authBtn.addEventListener('click', async () => {
  const pw      = masterInput.value.trim();
  const confirm = confirmInput.value.trim();

  const { masterHash } = await chrome.storage.local.get(['masterHash']);

  if (!masterHash) {
    // ---- CREATE MODE ----
    if (pw !== confirm) return alert('Passwords do not match');
    const hash = await sha256Hex(pw);
    await chrome.storage.local.set({ masterHash, locked: false });
    MASTER_KEY = await deriveKey(pw);
    setUnlocked(true);
    await refreshEntries();
  } else {
    // ---- UNLOCK MODE ----
    if ((await sha256Hex(pw)) !== masterHash) return alert('Wrong password');
    MASTER_KEY = await deriveKey(pw);
    await chrome.storage.local.set({ locked: false });
    setUnlocked(true);
    await refreshEntries();
  }
});

lockNowBtn.addEventListener('click', async () => {
  await chrome.storage.local.set({ locked: true });
  setUnlocked(false);
});

/////  Save entry
entryForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(!MASTER_KEY) return alert('Unlock first');
  const raw=valueInput.value.trim(); if(!raw) return;
  const type=typeSelect.value;
  const h=await sha256Hex(raw);
  const short=(type==='phone'||type==='credit')?'••••'+raw.slice(-4):raw.split(' ').slice(0,2).join(' ')+' …';
  let domain='unknown';
  try{
    const tabs=await new Promise(res=>chrome.tabs.query({active:true,currentWindow:true},res));
    domain=new URL(tabs[0]?.url||'').hostname||'unknown';
  }catch{domain='unknown';}
  const payloadObj={hash:h,type,fullHint:short,ts:Date.now(),site:domain};
  const enc=await encryptJSON(payloadObj, MASTER_KEY);
  const store=await storageGet([ENTRIES_KEY]);
  const arr=store[ENTRIES_KEY]||[];
  arr.push({payload:enc,meta:{type,short,site:domain,ts:payloadObj.ts}});
  await storageSet({[ENTRIES_KEY]:arr});
  valueInput.value='';
  await refreshEntries();
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
  for(let i=0;i<arr.length;i++){
    let dec; try{ dec=await decryptJSON(arr[i].payload, MASTER_KEY); }catch{ continue; }
    const card=document.createElement('div'); card.className='entry-card';
    card.innerHTML=`
      <div class="entry-info">
        <div><strong>${dec.type}</strong> • ${arr[i].meta.short}</div>
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
  const store=await storageGet([ENTRIES_KEY]);
  const arr=store[ENTRIES_KEY]||[];
  const filtered=arr.map((it,idx)=>({it,idx}))
    .filter(({it})=>{
      const m=it.meta||{};
      return !q ||
        m.type.toLowerCase().includes(q) ||
        m.short.toLowerCase().includes(q) ||
        m.site.toLowerCase().includes(q);
    });
  entriesList.innerHTML='';
  for(const {it,idx} of filtered){
    const card=document.createElement('div'); card.className='entry-card';
    card.innerHTML=`
      <div class="entry-info">
        <div><strong>${it.meta.type}</strong> • ${it.meta.short}</div>
        <div class="small">site: ${it.meta.site} • ${new Date(it.meta.ts).toLocaleString()}</div>
      </div>
      <button class="remove danger">Remove</button>`;
    card.querySelector('.remove').onclick=()=>removeEntry(idx);
    entriesList.appendChild(card);
  }
});

/////  Init
(async function init(){
  const {locked,masterHash}=await chrome.storage.local.get(['locked','masterHash']);
  if(masterHash){
    // already have a password → unlock UI
    lockTitle.textContent='Unlock Vault';
    confirmInput.parentElement.style.display='none';
    authBtn.textContent='Unlock';
  }
  setUnlocked(!(locked||locked===undefined));
})();