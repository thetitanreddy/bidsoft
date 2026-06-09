import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, onValue, set, get } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { getAuth, signInWithPopup, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// ============================================================
// FIREBASE CONFIGURATION
// (Keys are intentionally public for web apps)
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyD6MSpBcHkRqKPlKGlZ6cSjV_-Ml5xMBMs",
  authDomain: "bidsofts.firebaseapp.com",
  databaseURL: "https://bidsofts-default-rtdb.firebaseio.com",
  projectId: "bidsofts",
  storageBucket: "bidsofts.firebasestorage.app",
  messagingSenderId: "510637797990",
  appId: "1:510637797990:web:4c37789d361d16b24df3a7"
};

let appFirebase;
let db;
let auctionRef;
let auth;
let provider;

try {
  console.log("Initializing Firebase...");
  appFirebase = initializeApp(firebaseConfig);
  console.log("Getting Database & Auth...");
  db = getDatabase(appFirebase);
  auth = getAuth(appFirebase);
  provider = new GoogleAuthProvider();
  console.log("Setting Database Ref...");
  auctionRef = ref(db, 'auction_v1');
  console.log("Firebase initialized successfully");
} catch (e) {
  console.error("Failed to initialize Firebase", e);
}

const CCY = 'Φ';
const ONLINE_MS = 24000;
const HEARTBEAT_MS = 9000;
const MIN_WRITE_MS = 1600;

const LOTS = [
  ["The Last Echo of a Sunday Morning","Guaranteed never to have happened. Sold as heard."],
  ["One Carefully Folded Paradox","Opens into itself. Storage not recommended."],
  ["A Pocketful of Next Tuesday","Slightly used. Still ahead of you."],
  ["The Colour You See With Your Eyes Closed","Single edition. No two buyers agree on the shade."],
  ["Half an Inch of the Horizon","Measured at dusk. Authenticity certificate forthcoming, eventually."],
  ["The Pause Between Two Heartbeats","Acquired at great personal silence."],
  ["A Rumour That Never Quite Happened","Untraceable. Highly collectible."],
  ["The Smell of Rain Before It Falls","Bottled in advance. Do not inhale the future."],
  ["An Idea You Left at the Door","Found, but no longer remembered by its owner."],
  ["The Weight of an Empty Promise","Heavier than it looks. Comes with regret."],
  ["A Single Unspoken Word","Never said aloud. The bidding speaks for it."],
  ["The Shadow of a Round Number","Cast at noon. Slightly imaginary."]
];

let ME = { name:null, role:null };
let lastValue = -1;
let beatTimer = null;
let skeletonRole = null;

function emptyState(){
  return { rev:0, status:'closed', lotIndex:-1, lot:null, value:0, leader:null,
           bids:[], participants:{}, history:[], startedAt:null, closedAt:null, seq:0 };
}

function sanitizeState(s) {
  if (!s) return emptyState();
  s.bids = s.bids || [];
  s.history = s.history || [];
  s.participants = s.participants || {};
  return s;
}

let state = emptyState();
let localRev = 0;
let dirty = false;
let writing = false;
let flushTimer = null;
let nextWriteAt = 0;

function now(){ return Date.now(); }

async function loadState(){
  if (!auctionRef) return null;
  try{ 
    console.log("Fetching state from Firebase...");
    const snap = await Promise.race([
      get(auctionRef),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout: Could not connect to Firebase Realtime Database. Did you enable it in the Firebase Console?")), 5000))
    ]);
    console.log("Firebase state fetched successfully.");
    if(snap.exists()) return sanitizeState(snap.val()); 
  }
  catch(e){ 
    console.error("Firebase get error:", e); 
    throw e; 
  }
  return null;
}
async function saveState(s){
  if (!auctionRef) return 'err';
  try{ await set(auctionRef, s); return 'ok'; }
  catch(e){ return 'err'; }
}

async function mutate(fn){
  const res = fn(state);
  if(res===false) return state;
  if(res && typeof res==='object' && res!==state) state = res;
  dirty = true;
  renderFromState(state);
  scheduleFlush();
  return state;
}

function scheduleFlush(){
  if(flushTimer || !dirty) return;
  const wait = Math.max(0, nextWriteAt - now());
  flushTimer = setTimeout(async()=>{ flushTimer=null; await flush(); }, wait);
}

function mergeStates(remote, local){
  if(!remote) return local;
  const map=new Map(); const k=b=>b.user+'|'+b.ts+'|'+b.amount;
  (remote.bids||[]).forEach(b=>map.set(k(b),b));
  (local.bids||[]).forEach(b=>map.set(k(b),b));
  let bids=[...map.values()].sort((a,b)=>a.ts-b.ts);
  if(bids.length>300) bids=bids.slice(-300);
  const participants={...(remote.participants||{})};
  for(const [n,p] of Object.entries(local.participants||{}))
    if(!participants[n] || (p.lastSeen||0)>(participants[n].lastSeen||0)) participants[n]=p;
  const out={...local, bids, participants};
  const cur=bids.filter(b=>b.lotIndex===out.lotIndex);
  if(cur.length){ const top=cur.reduce((m,b)=>b.amount>m.amount?b:m,cur[0]);
    if(top.amount>=(out.value||0)){ out.value=top.amount; out.leader=top.user; } }
  return out;
}

async function flush(){
  if(writing || !dirty) return;
  writing=true; dirty=false;
  try{
    const remote=await loadState();
    const merged=mergeStates(remote, state);
    merged.rev=Math.max(remote?.rev||0, state.rev||0)+1;
    const r=await saveState(merged);
    if(r==='ok'){ state=merged; localRev=merged.rev; nextWriteAt=now()+MIN_WRITE_MS; renderFromState(state); }
    else { dirty=true; nextWriteAt=now()+1500; }
  }catch(e){ dirty=true; nextWriteAt=now()+1500; }
  finally{ writing=false; if(dirty) scheduleFlush(); }
}

function fmt(n){ return CCY + ' ' + Math.round(n).toLocaleString('en-US'); }
function paddleFor(name){ 
  if (!name) return 100;
  let h=0; for(const c of name) h=(h*31+c.charCodeAt(0))>>>0; return 100+(h%900); 
}
function initials(name){ return (name||'').trim().slice(0,2).toUpperCase(); }
function isOnline(p){ return p && (now()-p.lastSeen) < ONLINE_MS; }
function esc(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2200); }

export function initApp(role) {
    ME.role = role;
    renderEntry();
    
    if (auctionRef) {
        onValue(auctionRef, (snapshot) => {
            const remote = snapshot.val();
            if (!remote) return;
            if ((remote.rev||0) <= localRev) return;
            
            if (dirty || writing) {
                state = mergeStates(sanitizeState(remote), state);
            } else {
                state = sanitizeState(remote); 
            }
            
            localRev = Math.max(localRev, remote.rev||0);
            if (ME.name) {
                renderFromState(state);
            }
        });
    }

    window.addEventListener('beforeunload', ()=>{
        clearInterval(beatTimer);
        if(flushTimer){ clearTimeout(flushTimer); flushTimer=null; }
        if(ME.name && state){
            if(state.participants[ME.name]) state.participants[ME.name].lastSeen=0;
            state.rev=(state.rev||0)+1;
            saveState(state);
        }
    });
}

function renderEntry(){
  skeletonRole = null;
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="entry">
      <div class="seal"><span>Φ</span></div>
      <div class="kicker">Lot &nbsp;·&nbsp; Bid &nbsp;·&nbsp; Vanish</div>
      <h1>The Phantom <em>Auction</em></h1>
      <p class="sub">A live sale of things that do not exist. Bidders push the value upward in phantom credits; when the Auctioneer drops the gavel, the full session report is delivered to them.</p>
      <div class="card">
        <div class="err" id="err" style="margin-bottom: 15px"></div>
        <button class="btn" id="enterBtn" style="width:100%; display: flex; justify-content: center; align-items: center; gap: 10px;">
          <svg style="width:18px;height:18px" viewBox="0 0 24 24"><path fill="currentColor" d="M21.35,11.1H12.18V13.83H18.69C18.36,17.64 15.19,19.27 12.19,19.27C8.36,19.27 5,16.25 5,12C5,7.9 8.2,4.73 12.2,4.73C15.29,4.73 17.1,6.7 17.1,6.7L19,4.72C19,4.72 16.56,2 12.1,2C6.42,2 2.03,6.8 2.03,12C2.03,17.05 6.16,22 12.25,22C17.6,22 21.5,18.33 21.5,12.91C21.5,11.76 21.35,11.1 21.35,11.1V11.1Z" /></svg>
          Sign in with Google
        </button>
      </div>
    </div>`;

  const go = async ()=>{
    const errDiv = document.getElementById('err');
    errDiv.style.color = 'var(--crimson-bright)';
    try {
      console.log("Google Sign-In clicked");
      if(!auctionRef || !auth) { errDiv.textContent='Firebase not configured. Check console.'; return; }
      
      errDiv.textContent='Waiting for Google authentication...';
      const result = await signInWithPopup(auth, provider);
      const name = result.user.displayName;
      
      if(!name){ errDiv.textContent='Could not read your Google name.'; return; }
      ME.name = name;
      errDiv.textContent='Connecting to auction...';
      console.log("Calling joinSession for:", name);
      await joinSession();
    } catch(err) {
      console.error("Error in go():", err);
      if (err.code === 'auth/popup-closed-by-user') {
        errDiv.textContent='Sign-in cancelled.';
      } else {
        errDiv.textContent='Error joining: ' + err.message;
      }
    }
  };
  document.getElementById('enterBtn').onclick=go;
}

async function joinSession(){
  console.log("joinSession started");
  try {
    state = (await loadState()) || emptyState();
    console.log("Loaded remote state:", state);
    localRev = state.rev||0;
    await mutate(s=>{
      s.participants[ME.name] = { name:ME.name, role:ME.role, lastSeen:now(),
        joinedAt:(s.participants[ME.name]?.joinedAt)||now() };
      return s;
    });
    console.log("Participant added to state");
    startLoops();
    if(ME.role==='auctioneer') mountAdmin(); else mountBidder();
    console.log("Mounted skeleton");
    renderFromState(state);
    console.log("joinSession complete");
  } catch(err) {
    console.error("Critical error in joinSession:", err);
    throw err; // Pass to go() error handler
  }
}

function startLoops(){
  clearInterval(beatTimer);
  beatTimer = setInterval(heartbeat, HEARTBEAT_MS);
}
async function heartbeat(){
  await mutate(s=>{
    if(s.participants[ME.name]) s.participants[ME.name].lastSeen=now();
    else s.participants[ME.name]={name:ME.name,role:ME.role,lastSeen:now(),joinedAt:now()};
    return s;
  });
}

function mountBidder(){
  skeletonRole='bidder';
  const app=document.getElementById('app');
  app.innerHTML = `
    ${topbar()}
    <div class="stage" id="stage"></div>
    <div class="grid2">
      <div class="panel" id="bidPanel"></div>
      <div>
        <div class="panel" style="margin-bottom:20px">
          <div class="sectitle"><span>On the floor</span><span id="rosterCount"></span></div>
          <div class="roster" id="roster"></div>
        </div>
        <div class="panel">
          <div class="sectitle"><span>Bid feed</span><span id="bidCount"></span></div>
          <div class="feed" id="feed"></div>
        </div>
      </div>
    </div>`;
}

function bidPanelMarkup(open){
  if(!open){
    return `<h3>No sale is live</h3>
      <div class="ph">Bidding opens when a sale is running. Start one now to begin (or wait for the Auctioneer).</div>
      <button class="btn" id="startSale" style="width:100%;margin-bottom:10px;display:none;">▶ Start the bidding</button>
      <div class="hint">A lot will be drawn and you can begin placing bids.</div>`;
  }
  return `
    <h3>Raise the bid</h3>
    <div class="ph">You must exceed the current standing bid. Phantom credits only.</div>
    <div class="quickrow">
      <button class="chip" data-add="50">+50</button>
      <button class="chip" data-add="100">+100</button>
      <button class="chip" data-add="250">+250</button>
      <button class="chip" data-add="1000">+1,000</button>
      <button class="chip rng" data-rng="1">⚡ Random raise</button>
    </div>
    <div class="customrow">
      <input id="customBid" type="number" inputmode="numeric" placeholder="Name your figure…" />
      <button class="btn" id="placeBtn">Place Bid</button>
    </div>
    <div class="hint" id="bidHint"></div>`;
}

function wireBidPanel(snap){
  const open = snap.status==='open';
  const panel = document.getElementById('bidPanel');
  if(!panel) return;
  if(panel._open!==open){ panel.innerHTML=bidPanelMarkup(open); panel._open=open; }
  if(!open){
    const sb=document.getElementById('startSale');
    if(sb) sb.onclick=async()=>{ await openSession(); toast('Sale opened — place your bid!'); };
    return;
  }

  const place = async (amount)=>{
    amount = Math.round(Number(amount));
    if(!amount || amount<=0){ toast('Enter a valid amount.'); return; }
    let reject=null;
    await mutate(s=>{
      if(s.status!=='open'){ reject='closed'; return false; }
      if(amount<=s.value){ reject='low'; return false; }
      s.seq=(s.seq||0)+1;
      s.value=amount; s.leader=ME.name;
      s.bids.push({ id:s.seq, user:ME.name, paddle:paddleFor(ME.name), amount,
        lot:s.lot?.title||'—', lotIndex:s.lotIndex, ts:now() });
      if(s.bids.length>300) s.bids=s.bids.slice(-300);
      return s;
    });
    if(reject==='closed'){ toast('The sale just closed.'); }
    else if(reject==='low'){ toast('Outbid — raise higher.'); }
    else { const ci=document.getElementById('customBid'); if(ci) ci.value='';
      toast(`Bid placed — ${fmt(amount)}`); }
  };

  panel.querySelectorAll('.chip[data-add]').forEach(b=>{
    b.onclick=()=> place(state.value + Number(b.dataset.add)); });
  const rng = panel.querySelector('.chip[data-rng]');
  if(rng) rng.onclick=()=> place(state.value + 25 + Math.floor(Math.random()*975));

  const customBtn=document.getElementById('placeBtn');
  const customIn=document.getElementById('customBid');
  if(customBtn) customBtn.onclick=()=>place(customIn.value);
  if(customIn) customIn.addEventListener('keydown',e=>{ if(e.key==='Enter') place(customIn.value); });
}

function mountAdmin(){
  skeletonRole='auctioneer';
  const app=document.getElementById('app');
  app.innerHTML = `
    ${topbar()}
    <div class="ctrlrow" id="ctrlrow"></div>
    <div class="statgrid" id="statgrid"></div>
    <div id="reportSlot"></div>
    <div class="grid2">
      <div class="panel">
        <div class="sectitle"><span>Live ledger</span><span id="bidCount"></span></div>
        <div class="feed" id="feed" style="max-height:340px"></div>
      </div>
      <div class="panel">
        <div class="sectitle"><span>Participants</span><span id="rosterCount"></span></div>
        <div class="roster" id="roster"></div>
      </div>
    </div>`;
}

function wireAdminControls(state){
  const row=document.getElementById('ctrlrow');
  if(!row) return;
  const open = state.status==='open';
  const sig = open ? 'open' : 'closed';
  if(row._sig!==sig){
    if(open){
      row.innerHTML = `
        <button class="btn" id="nextLot">⟳ Next Lot</button>
        <button class="btn danger" id="closeBtn">⚖ Drop the Gavel — Close Session</button>`;
    } else {
      row.innerHTML = `
        <button class="btn" id="openBtn">▶ Open the Sale</button>
        <button class="btn ghost" id="resetBtn">Reset everything</button>`;
    }
    row._sig=sig;

    const nl=document.getElementById('nextLot');
    if(nl) nl.onclick=advanceLot;
    const cb=document.getElementById('closeBtn');
    if(cb) cb.onclick=closeSession;
    const ob=document.getElementById('openBtn');
    if(ob) ob.onclick=openSession;
    const rb=document.getElementById('resetBtn');
    if(rb) rb.onclick=resetSession;
  }
}

function pickLot(prevIndex){
  let i; do{ i=Math.floor(Math.random()*LOTS.length); } while(LOTS.length>1 && i===prevIndex);
  return { index:i, title:LOTS[i][0], blurb:LOTS[i][1] };
}
function finalizeLot(s){
  if(s.lot && s.leader){
    s.history.push({ lot:s.lot.title, winner:s.leader, value:s.value,
      bidCount:s.bids.filter(b=>b.lotIndex===s.lotIndex).length, closedAt:now() });
  } else if(s.lot){
    s.history.push({ lot:s.lot.title, winner:null, value:0, bidCount:0, closedAt:now() });
  }
}
async function openSession(){
  await mutate(s=>{
    const L=pickLot(-1);
    s.status='open'; s.startedAt=now(); s.closedAt=null;
    s.history=[]; s.bids=[]; s.value=0; s.leader=null;
    s.lotIndex=L.index; s.lot={title:L.title,blurb:L.blurb};
    return s;
  });
  toast('The sale is open.');
}
async function advanceLot(){
  await mutate(s=>{
    if(s.status!=='open') return s;
    finalizeLot(s);
    const L=pickLot(s.lotIndex);
    s.lotIndex=L.index; s.lot={title:L.title,blurb:L.blurb};
    s.value=0; s.leader=null;
    return s;
  });
  toast('Next lot on the block.');
}
async function closeSession(){
  await mutate(s=>{
    if(s.status==='open') finalizeLot(s);
    s.status='closed'; s.closedAt=now();
    s.lot=null; s.value=0; s.leader=null; s.lotIndex=-1;
    return s;
  });
  toast('Gavel dropped — session closed.');
}
async function resetSession(){
  await mutate(()=>emptyState());
  await mutate(s=>{ s.participants[ME.name]={name:ME.name,role:ME.role,lastSeen:now(),joinedAt:now()}; return s; });
  toast('Session reset.');
}

function topbar(){
  const adm = ME.role==='auctioneer';
  return `
    <div class="topbar">
      <div class="brand">
        <div class="mk"><span>Φ</span></div>
        <div><div class="bt">The Phantom Auction</div><div class="bs">Live Session</div></div>
      </div>
      <div class="who">
        <span class="status-pill" id="statusPill"><span class="dot"></span><span id="statusTxt">—</span></span>
        <span class="paddle">No. ${paddleFor(ME.name)}</span>
        <span>${esc(ME.name)}</span>
        <span class="badge ${adm?'adm':''}">${adm?'Auctioneer':'Bidder'}</span>
      </div>
    </div>`;
}

function renderFromState(s){
  if(!s){ return; }
  if(ME.role==='auctioneer' && skeletonRole!=='auctioneer') mountAdmin();
  if(ME.role==='bidder' && skeletonRole!=='bidder') mountBidder();

  updateStatusPill(s);
  if(ME.role==='bidder') renderBidder(s); else renderAdmin(s);
  renderRoster(s);
  renderFeed(s);
}

function updateStatusPill(s){
  const pill=document.getElementById('statusPill');
  const txt=document.getElementById('statusTxt');
  if(!pill) return;
  pill.classList.remove('live','closed');
  if(s.status==='open'){ pill.classList.add('live'); txt.textContent='Sale Live'; }
  else { pill.classList.add('closed'); txt.textContent='Closed'; }
}

function renderBidder(s){
  const stage=document.getElementById('stage');
  if(stage){
    if(s.status==='open' && s.lot){
      const struct = 'open|'+s.lotIndex+'|'+s.history.length;
      if(stage._struct!==struct){
        stage.innerHTML = `
          <div class="lot-tag">LOT ${String(s.history.length+1).padStart(2,'0')} · NOW SELLING</div>
          <div class="lot-title">${esc(s.lot.title)}</div>
          <div class="lot-blurb">${esc(s.lot.blurb)}</div>
          <div class="bigrow">
            <div><div class="biglabel">Standing bid</div><div class="bigval" id="bigVal">${fmt(s.value)}</div></div>
            <div><div class="biglabel">Held by</div><div id="heldBy"></div></div>
          </div>`;
        stage._struct=struct; lastValue=-1;
      }
      const bv=document.getElementById('bigVal');
      if(bv){
        bv.textContent=fmt(s.value);
        if(s.value>lastValue && lastValue>=0){ bv.classList.remove('bump'); void bv.offsetWidth; bv.classList.add('bump'); }
      }
      lastValue=s.value;
      const hb=document.getElementById('heldBy');
      if(hb) hb.innerHTML = s.leader
        ? `<span class="leadname">${esc(s.leader)}${s.leader===ME.name?' <span style="font-size:13px;color:var(--gold)">(you)</span>':''}</span>`
        : `<span class="leadname none">— awaiting first bid —</span>`;
    } else {
      const struct='closed|'+s.history.length;
      if(stage._struct!==struct){
        lastValue=-1;
        stage.innerHTML = `
          <div class="lot-tag">${s.status==='closed' && s.history.length? 'SALE CONCLUDED':'STANDBY'}</div>
          <div class="lot-title" style="font-style:normal;color:var(--cream-dim)">${s.history.length? 'The gavel has fallen.':'The room awaits.'}</div>
          <div class="lot-blurb">${s.history.length? 'Thank you for bidding. The Auctioneer holds the final record.':'No lot is currently on the block. Start a sale below, or wait for the Auctioneer.'}</div>`;
        if(s.status==='closed' && s.history.length) renderResultsForBidder(stage, s);
        stage._struct=struct;
      }
    }
  }
  wireBidPanel(s);
}

function renderResultsForBidder(stage, s){
  const rows = s.history.map(h=>`
    <tr class="${h.winner?'win':''}">
      <td>${esc(h.lot)}</td>
      <td>${h.winner?esc(h.winner):'<span style="color:var(--muted)">passed in</span>'}</td>
      <td class="num">${h.winner?fmt(h.value):'—'}</td>
    </tr>`).join('');
  stage.insertAdjacentHTML('beforeend', `
    <div class="ledger-title" style="margin-top:24px">Final results</div>
    <div class="scrollx"><table>
      <thead><tr><th>Lot</th><th>Winner</th><th style="text-align:right">Hammer</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`);
}

function renderAdmin(s){
  wireAdminControls(s);
  const sg=document.getElementById('statgrid');
  if(sg){
    const online=Object.values(s.participants).filter(p=>isOnline(p)&&p.role==='bidder').length;
    const total=s.bids.length;
    sg.innerHTML = `
      <div class="stat"><div class="sl">Now Selling</div><div class="sv sm">${s.lot?esc(s.lot.title):(s.status==='closed'?'— closed —':'— standby —')}</div></div>
      <div class="stat"><div class="sl">Standing Bid</div><div class="sv">${s.status==='open'?fmt(s.value):'—'}</div></div>
      <div class="stat"><div class="sl">Held By</div><div class="sv sm">${s.leader?esc(s.leader):'—'}</div></div>
      <div class="stat"><div class="sl">Bidders Online</div><div class="sv">${online}</div></div>
      <div class="stat"><div class="sl">Total Bids</div><div class="sv">${total}</div></div>
      <div class="stat"><div class="sl">Lots Sold</div><div class="sv">${s.history.filter(h=>h.winner).length}</div></div>`;
  }
  const slot=document.getElementById('reportSlot');
  if(slot){
    if(s.status==='closed' && s.history.length){ slot.innerHTML=reportMarkup(s); wireReport(s); }
    else if(slot._hadReport){ slot.innerHTML=''; }
    slot._hadReport = (s.status==='closed' && s.history.length>0);
  }
}

function reportMarkup(s){
  const winners=s.history.filter(h=>h.winner);
  const grand=winners.reduce((a,h)=>a+h.value,0);
  const topLot=winners.reduce((m,h)=>h.value>(m?.value||0)?h:m,null);
  const partList=Object.values(s.participants).filter(p=>p.role==='bidder');
  const dur = s.startedAt&&s.closedAt? Math.max(1,Math.round((s.closedAt-s.startedAt)/1000)) : 0;

  const lotRows=s.history.map((h,i)=>`
    <tr class="${h.winner?'win':''}">
      <td class="mono" style="color:var(--muted)">${String(i+1).padStart(2,'0')}</td>
      <td>${esc(h.lot)}</td>
      <td>${h.winner?esc(h.winner):'<span style="color:var(--muted)">passed in</span>'}</td>
      <td class="num">${h.bidCount}</td>
      <td class="num">${h.winner?fmt(h.value):'—'}</td>
    </tr>`).join('');

  const ledgerRows=[...s.bids].reverse().map(b=>`
    <tr>
      <td class="mono" style="color:var(--gold)">#${b.paddle}</td>
      <td>${esc(b.user)}</td>
      <td style="color:var(--cream-dim)">${esc(b.lot)}</td>
      <td class="num">${fmt(b.amount)}</td>
    </tr>`).join('') || `<tr><td colspan="4" style="color:var(--muted);font-style:italic">No bids were recorded.</td></tr>`;

  return `
  <div class="report" id="report">
    <div class="rh">
      <div class="stamp">SESSION REPORT · DELIVERED TO AUCTIONEER</div>
      <h2>Final Record of Sale</h2>
      <div class="rsub">Compiled ${new Date(s.closedAt||now()).toLocaleString()} · ${dur}s on the block · ${partList.length} bidders · ${s.bids.length} total bids</div>
    </div>

    <div class="statgrid" style="margin-bottom:8px">
      <div class="stat"><div class="sl">Grand Total (Hammer)</div><div class="sv">${fmt(grand)}</div></div>
      <div class="stat"><div class="sl">Lots Sold</div><div class="sv">${winners.length} / ${s.history.length}</div></div>
      <div class="stat"><div class="sl">Top Lot</div><div class="sv sm">${topLot?esc(topLot.lot):'—'}</div></div>
      <div class="stat"><div class="sl">Top Hammer</div><div class="sv">${topLot?fmt(topLot.value):'—'}</div></div>
    </div>

    <div class="ledger-title">Results by lot</div>
    <div class="scrollx"><table>
      <thead><tr><th>#</th><th>Lot</th><th>Winner</th><th style="text-align:right">Bids</th><th style="text-align:right">Hammer</th></tr></thead>
      <tbody>${lotRows}</tbody>
    </table></div>

    <div class="ledger-title">Full bid ledger</div>
    <div class="scrollx"><table>
      <thead><tr><th>Paddle</th><th>Bidder</th><th>Lot</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>${ledgerRows}</tbody>
    </table></div>

    <div class="ctrlrow" style="margin-top:22px;margin-bottom:0">
      <button class="btn" id="copyJson">⧉ Copy report (JSON)</button>
      <button class="btn ghost" id="dlJson">↓ Download report</button>
    </div>
  </div>`;
}

function buildReportData(s){
  const winners=s.history.filter(h=>h.winner);
  return {
    auction:'The Phantom Auction',
    closedAt:new Date(s.closedAt||now()).toISOString(),
    startedAt:s.startedAt?new Date(s.startedAt).toISOString():null,
    auctioneer:ME.name,
    bidders:Object.values(s.participants).filter(p=>p.role==='bidder').map(p=>({name:p.name,paddle:paddleFor(p.name)})),
    summary:{
      lotsOffered:s.history.length,
      lotsSold:winners.length,
      totalBids:s.bids.length,
      grandTotalHammer:winners.reduce((a,h)=>a+h.value,0),
      currency:'phantom-credits'
    },
    lots:s.history.map(h=>({lot:h.lot,winner:h.winner,hammer:h.value,bids:h.bidCount})),
    ledger:s.bids.map(b=>({paddle:b.paddle,bidder:b.user,lot:b.lot,amount:b.amount,at:new Date(b.ts).toISOString()}))
  };
}
function wireReport(s){
  const cj=document.getElementById('copyJson');
  const dj=document.getElementById('dlJson');
  const data=()=>JSON.stringify(buildReportData(s),null,2);
  if(cj) cj.onclick=async()=>{ try{ await navigator.clipboard.writeText(data()); toast('Report copied to clipboard.'); }catch{ toast('Copy blocked by browser.'); } };
  if(dj) dj.onclick=()=>{ const blob=new Blob([data()],{type:'application/json'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download='phantom-auction-report.json'; a.click(); URL.revokeObjectURL(a.href); toast('Report downloaded.'); };
}

function renderRoster(s){
  const r=document.getElementById('roster');
  const count=document.getElementById('rosterCount');
  if(!r) return;
  const people=Object.values(s.participants)
    .sort((a,b)=> (b.role==='auctioneer') - (a.role==='auctioneer') || a.joinedAt-b.joinedAt);
  const onlineCount=people.filter(isOnline).length;
  if(count) count.textContent=onlineCount+' online';
  const sig = people.map(p=>p.name+(isOnline(p)?'1':'0')+p.role).join('|');
  if(r._sig===sig) return;     
  r._sig=sig;
  r.innerHTML = people.map(p=>{
    const on=isOnline(p);
    const adm=p.role==='auctioneer';
    const you=p.name===ME.name;
    return `<div class="person ${you?'you':''}" style="${on?'':'opacity:.4'}">
      <div class="l">
        <div class="av ${adm?'adm-av':''}">${initials(p.name)}</div>
        <span class="nm">${esc(p.name)}${you?' (you)':''}</span>
        ${adm?'<span class="badge adm" style="font-size:9px">Gavel</span>':
          `<span class="paddle" style="font-size:10px;padding:2px 6px">#${paddleFor(p.name)}</span>`}
      </div>
      ${on?'<span class="live-dot" title="online"></span>':'<span style="font-size:10px;color:var(--muted)">away</span>'}
    </div>`;
  }).join('') || '<div class="empty">Nobody here yet.</div>';
}

function renderFeed(s){
  const feed=document.getElementById('feed');
  const count=document.getElementById('bidCount');
  if(!feed) return;
  if(count) count.textContent=s.bids.length+' bids';
  const lastId = s.bids.length? s.bids[s.bids.length-1].id : 0;
  const sig = s.bids.length+':'+lastId;
  if(feed._sig===sig) return;   
  feed._sig=sig;
  const recent=[...s.bids].slice(-40).reverse();
  if(!recent.length){ feed.innerHTML='<div class="empty">No bids yet — be the first to raise.</div>'; return; }
  feed.innerHTML = recent.map(b=>`
    <div class="bid">
      <div class="bn">
        <span class="pp">#${b.paddle}</span>
        <span class="nm">${esc(b.user)}${b.user===ME.name?' <span style="color:var(--gold);font-size:11px">(you)</span>':''}</span>
      </div>
      <div style="text-align:right">
        <div class="amt">${fmt(b.amount)}</div>
        <div class="lt">${esc(b.lot)}</div>
      </div>
    </div>`).join('');
}
