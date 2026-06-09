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



let ME = { name: null, role: null };
let lastValue = -1;
let beatTimer = null;
let skeletonRole = null;

function emptyState() {
  return {
    rev: 0, clearSeq: 0, status: 'closed', lots: [],
    bids: [], participants: {}, history: [], startedAt: null, closedAt: null, seq: 0
  };
}

function sanitizeState(s) {
  if (!s) return emptyState();
  s.bids = s.bids || [];
  s.history = s.history || [];
  s.participants = s.participants || {};
  s.lots = s.lots || [];
  return s;
}

let state = emptyState();
let localRev = 0;
let dirty = false;
let writing = false;
let flushTimer = null;
let nextWriteAt = 0;

function now() { return Date.now(); }

async function loadState() {
  if (!auctionRef) return null;
  try {
    console.log("Fetching state from Firebase...");
    const snap = await Promise.race([
      get(auctionRef),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout: Could not connect to Firebase Realtime Database. Did you enable it in the Firebase Console?")), 5000))
    ]);
    console.log("Firebase state fetched successfully.");
    if (snap.exists()) return sanitizeState(snap.val());
  }
  catch (e) {
    console.error("Firebase get error:", e);
    throw e;
  }
  return null;
}
async function saveState(s) {
  if (!auctionRef) return 'err';
  try { await set(auctionRef, s); return 'ok'; }
  catch (e) { return 'err'; }
}

async function mutate(fn) {
  const res = fn(state);
  if (res === false) return state;
  if (res && typeof res === 'object' && res !== state) state = res;
  dirty = true;
  renderFromState(state);
  scheduleFlush();
  return state;
}

function scheduleFlush() {
  if (flushTimer || !dirty) return;
  const wait = Math.max(0, nextWriteAt - now());
  flushTimer = setTimeout(async () => { flushTimer = null; await flush(); }, wait);
}

function mergeStates(remote, local) {
  if (!remote) return local;

  const localCleared = (local.clearSeq || 0) > (remote.clearSeq || 0);
  let remoteBids = localCleared ? [] : (remote.bids || []);

  const map = new Map(); const k = b => b.user + '|' + b.ts + '|' + b.amount;
  remoteBids.forEach(b => map.set(k(b), b));
  (local.bids || []).forEach(b => map.set(k(b), b));
  let bids = [...map.values()].sort((a, b) => a.ts - b.ts);
  if (bids.length > 300) bids = bids.slice(-300);

  const participants = { ...(remote.participants || {}) };
  for (const [n, p] of Object.entries(local.participants || {}))
    if (!participants[n] || (p.lastSeen || 0) > (participants[n].lastSeen || 0)) participants[n] = p;

  const out = { ...remote, ...local, bids, participants };

  if (!localCleared) {
    const lotsMap = new Map();
    (remote.lots || []).forEach(l => lotsMap.set(l.id, l));
    (local.lots || []).forEach(l => lotsMap.set(l.id, l));
    out.lots = [...lotsMap.values()];
    const rHist = remote.history || [];
    const lHist = local.history || [];
    out.history = rHist.length > lHist.length ? rHist : lHist;
  } else {
    out.lots = [...(local.lots || [])];
    out.history = local.history || [];
  }

  if (out.lots) {
    out.lots.forEach(lot => {
      const cur = bids.filter(b => b.lotId === lot.id);
      if (cur.length) {
        const top = cur.reduce((m, b) => b.amount > m.amount ? b : m, cur[0]);
        lot.value = top.amount; lot.leader = top.user;
      } else {
        lot.value = 0; lot.leader = null;
      }
    });
  }
  return out;
}

async function flush() {
  if (writing || !dirty) return;
  writing = true; dirty = false;
  try {
    const remote = await loadState();
    const merged = mergeStates(remote, state);
    merged.rev = Math.max(remote?.rev || 0, state.rev || 0) + 1;
    const r = await saveState(merged);
    if (r === 'ok') { state = merged; localRev = merged.rev; nextWriteAt = now() + MIN_WRITE_MS; renderFromState(state); }
    else { dirty = true; nextWriteAt = now() + 1500; }
  } catch (e) { dirty = true; nextWriteAt = now() + 1500; }
  finally { writing = false; if (dirty) scheduleFlush(); }
}

function fmt(n) { return CCY + ' ' + Math.round(n).toLocaleString('en-US'); }
function paddleFor(name) {
  if (!name) return 100;
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 100 + (h % 900);
}
function initials(name) { return (name || '').trim().slice(0, 2).toUpperCase(); }
function isOnline(p) { return p && (now() - p.lastSeen) < ONLINE_MS; }
function esc(s) { return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200); }

export function initApp(role) {
  ME.role = role;
  renderEntry();

  if (auctionRef) {
    onValue(auctionRef, (snapshot) => {
      const remote = snapshot.val();
      if (!remote) return;
      if ((remote.rev || 0) <= localRev) return;

      if (dirty || writing) {
        state = mergeStates(sanitizeState(remote), state);
      } else {
        state = sanitizeState(remote);
      }

      localRev = Math.max(localRev, remote.rev || 0);
      if (ME.name) {
        renderFromState(state);
      }
    });
  }

  window.addEventListener('beforeunload', () => {
    clearInterval(beatTimer);
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (ME.name && state) {
      if (state.participants[ME.name]) state.participants[ME.name].lastSeen = 0;
      state.rev = (state.rev || 0) + 1;
      saveState(state);
    }
  });
}

function renderEntry() {
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

  const go = async () => {
    const errDiv = document.getElementById('err');
    errDiv.style.color = 'var(--crimson-bright)';
    try {
      console.log("Google Sign-In clicked");
      if (!auctionRef || !auth) { errDiv.textContent = 'Firebase not configured. Check console.'; return; }

      errDiv.textContent = 'Waiting for Google authentication...';
      const result = await signInWithPopup(auth, provider);
      const name = result.user.displayName;
      const email = result.user.email;

      if (!name) { errDiv.textContent = 'Could not read your Google name.'; return; }

      // Prevent random users from logging into the Admin page
      if (ME.role === 'auctioneer') {
        const ALLOWED_ADMINS = [
          'autcust@gmail.com', 'no-reply@mangiferaindia.com'// <-- UPDATE THIS WITH YOUR REAL EMAIL!
        ];
        if (!ALLOWED_ADMINS.includes(email)) {
          errDiv.textContent = 'Unauthorized: You do not have permission to run the auction.';
          return;
        }
      }

      ME.name = name;
      ME.email = email;
      errDiv.textContent = 'Connecting to auction...';
      console.log("Calling joinSession for:", name);
      await joinSession();
    } catch (err) {
      console.error("Error in go():", err);
      if (err.code === 'auth/popup-closed-by-user') {
        errDiv.textContent = 'Sign-in cancelled.';
      } else {
        errDiv.textContent = 'Error joining: ' + err.message;
      }
    }
  };
  document.getElementById('enterBtn').onclick = go;
}

async function joinSession() {
  console.log("joinSession started");
  try {
    state = (await loadState()) || emptyState();
    console.log("Loaded remote state:", state);
    localRev = state.rev || 0;
    await mutate(s => {
      s.participants[ME.name] = {
        name: ME.name, email: ME.email, role: ME.role, lastSeen: now(),
        joinedAt: (s.participants[ME.name]?.joinedAt) || now()
      };
      return s;
    });
    console.log("Participant added to state");
    startLoops();
    if (ME.role === 'auctioneer') mountAdmin(); else mountBidder();
    console.log("Mounted skeleton");
    renderFromState(state);
    console.log("joinSession complete");
  } catch (err) {
    console.error("Critical error in joinSession:", err);
    throw err; // Pass to go() error handler
  }
}

function startLoops() {
  clearInterval(beatTimer);
  beatTimer = setInterval(heartbeat, HEARTBEAT_MS);
}
async function heartbeat() {
  await mutate(s => {
    if (s.participants[ME.name]) s.participants[ME.name].lastSeen = now();
    else s.participants[ME.name] = { name: ME.name, email: ME.email, role: ME.role, lastSeen: now(), joinedAt: now() };
    return s;
  });
}

function mountBidder() {
  skeletonRole = 'bidder';
  const app = document.getElementById('app');
  app.innerHTML = `
    ${topbar()}
    <div class="catalog-grid" id="catalogGrid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px;"></div>
    <div class="grid2">
      <div>
        <div class="panel" style="margin-bottom:20px">
          <div class="sectitle"><span>On the floor</span><span id="rosterCount"></span></div>
          <div class="roster" id="roster"></div>
        </div>
      </div>
      <div class="panel">
        <div class="sectitle"><span>Bid feed</span><span id="bidCount"></span></div>
        <div class="feed" id="feed"></div>
      </div>
    </div>`;
}

async function placeBid(lotId, amount) {
  amount = Math.round(Number(amount));
  if (!amount || amount <= 0) { toast('Enter a valid amount.'); return; }
  let reject = null;
  await mutate(s => {
    if (s.status !== 'open') { reject = 'closed'; return false; }
    const lot = (s.lots || []).find(l => l.id === lotId);
    if (!lot) { reject = 'nolot'; return false; }
    if (amount <= (lot.value || 0)) { reject = 'low'; return false; }
    s.seq = (s.seq || 0) + 1;
    lot.value = amount; lot.leader = ME.name;
    s.bids.push({
      id: s.seq, user: ME.name, paddle: paddleFor(ME.name), amount,
      lot: lot.title, lotId: lot.id, ts: now()
    });
    if (s.bids.length > 300) s.bids = s.bids.slice(-300);
    return s;
  });
  if (reject === 'closed') { toast('The sale just closed.'); }
  else if (reject === 'low') { toast('Outbid — raise higher.'); }
  else if (reject === 'nolot') { toast('Product not found.'); }
  else {
    toast(`Bid placed — ${fmt(amount)}`);
  }
}

function mountAdmin() {
  skeletonRole = 'auctioneer';
  const app = document.getElementById('app');
  app.innerHTML = `
    ${topbar()}
    <div class="ctrlrow" id="ctrlrow"></div>
    <div id="adminLotForm" class="panel" style="margin-bottom:20px; display:none;">
       <h3>Add a Product to the Catalog</h3>
       <div class="grid2" style="margin-top: 15px; grid-template-columns: 1fr 1fr;">
         <div class="field"><label>Product Name</label><input id="newLotTitle" type="text" placeholder="e.g. A Vintage Clock"></div>
         <div class="field"><label>Photo URL</label><input id="newLotPhoto" type="text" placeholder="https://..."></div>
       </div>
       <div class="field"><label>Description</label><input id="newLotBlurb" type="text" placeholder="Short description"></div>
       <button class="btn" id="addLotBtn">Add Product</button>
    </div>
    <div id="adminLotList" class="panel" style="margin-bottom:20px; display:none;"></div>
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

function wireAdminLotForm(s) {
  const form = document.getElementById('adminLotForm');
  if (!form) return;
  form.style.display = s.status === 'open' ? 'none' : 'block';
  const btn = document.getElementById('addLotBtn');
  if (btn && !btn.onclick) {
    btn.onclick = async () => {
      const title = document.getElementById('newLotTitle').value;
      const blurb = document.getElementById('newLotBlurb').value;
      const photoUrl = document.getElementById('newLotPhoto').value;
      if (!title) return toast('Title required.');
      await mutate(state => {
        state.lots = state.lots || [];
        state.lots.push({
          id: 'lot_' + now() + Math.floor(Math.random()*1000),
          title, blurb, photoUrl, value: 0, leader: null
        });
        return state;
      });
      document.getElementById('newLotTitle').value = '';
      document.getElementById('newLotBlurb').value = '';
      document.getElementById('newLotPhoto').value = '';
      toast('Product added.');
    };
  }

  const listEl = document.getElementById('adminLotList');
  if (listEl) {
    listEl.style.display = s.status === 'open' ? 'none' : 'block';
    if (!s.lots || s.lots.length === 0) {
      listEl.innerHTML = '<div class="empty">No products added yet.</div>';
    } else {
      listEl.innerHTML = '<h3>Added Products (' + s.lots.length + ')</h3><div style="display:flex; flex-direction:column; gap:10px; margin-top:10px;">' + 
        s.lots.map(lot => `<div style="display:flex; align-items:center; gap:15px; background:var(--ink-2); padding:10px; border:1px solid var(--line); border-radius:6px;">
          ${lot.photoUrl ? `<div style="width:50px; height:50px; background-image:url('${esc(lot.photoUrl)}'); background-size:cover; border-radius:4px;"></div>` : ''}
          <div><div style="font-weight:bold; color:var(--cream);">${esc(lot.title)}</div><div style="font-size:12px; color:var(--muted);">${esc(lot.blurb)}</div></div>
        </div>`).join('') + 
        '</div>';
    }
  }
}

function wireAdminControls(state) {
  const row = document.getElementById('ctrlrow');
  if (!row) return;
  const open = state.status === 'open';
  const sig = open ? 'open' : 'closed';
  if (row._sig !== sig) {
    if (open) {
      row.innerHTML = `<button class="btn danger" id="closeBtn">⚖ Drop the Gavel — Close Session</button>`;
    } else {
      row.innerHTML = `
        <button class="btn" id="openBtn">▶ Open the Sale</button>
        <button class="btn ghost" id="resetBtn">Reset everything</button>
        <button class="btn ghost" id="clearBidsBtn" style="margin-left:10px;">Clear Ledger & Bids</button>`;
    }
    row._sig = sig;

    const cb = document.getElementById('closeBtn');
    if (cb) cb.onclick = closeSession;
    const ob = document.getElementById('openBtn');
    if (ob) ob.onclick = openSession;
    const rb = document.getElementById('resetBtn');
    if (rb) rb.onclick = resetSession;
    const cl = document.getElementById('clearBidsBtn');
    if (cl) cl.onclick = clearBidsSession;
  }
}

async function openSession() {
  await mutate(s => {
    s.clearSeq = (s.clearSeq || 0) + 1;
    s.status = 'open'; s.startedAt = now(); s.closedAt = null;
    s.history = []; s.bids = [];
    if (s.lots) s.lots.forEach(l => { l.value = 0; l.leader = null; });
    return s;
  });
  toast('The sale is open.');
}
async function closeSession() {
  await mutate(s => {
    if (s.status === 'open' && s.lots) {
      s.lots.forEach(lot => {
        if (lot.leader) {
          s.history.push({
            lot: lot.title, winner: lot.leader, value: lot.value,
            bidCount: s.bids.filter(b => b.lotId === lot.id).length, closedAt: now()
          });
        } else {
          s.history.push({ lot: lot.title, winner: null, value: 0, bidCount: 0, closedAt: now() });
        }
      });
    }
    s.status = 'closed'; s.closedAt = now();
    return s;
  });
  toast('Gavel dropped — session closed.');
}
async function resetSession() {
  await mutate(s => { 
    const c = (s.clearSeq || 0) + 1;
    const r = (s.rev || 0);
    const n = emptyState();
    n.clearSeq = c; n.rev = r;
    return n;
  });
  await mutate(s => { s.participants[ME.name] = { name: ME.name, role: ME.role, lastSeen: now(), joinedAt: now() }; return s; });
  toast('Session reset.');
}
async function clearBidsSession() {
  await mutate(s => {
    s.clearSeq = (s.clearSeq || 0) + 1;
    s.bids = [];
    s.history = [];
    if (s.lots) s.lots.forEach(l => { l.value = 0; l.leader = null; });
    return s;
  });
  toast('Ledger and bids cleared.');
}

function topbar() {
  const adm = ME.role === 'auctioneer';
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
        <span class="badge ${adm ? 'adm' : ''}">${adm ? 'Auctioneer' : 'Bidder'}</span>
      </div>
    </div>`;
}

function renderFromState(s) {
  if (!s) { return; }
  if (ME.role === 'auctioneer' && skeletonRole !== 'auctioneer') mountAdmin();
  if (ME.role === 'bidder' && skeletonRole !== 'bidder') mountBidder();

  updateStatusPill(s);
  if (ME.role === 'bidder') renderBidder(s); else renderAdmin(s);
  renderRoster(s);
  renderFeed(s);
}

function updateStatusPill(s) {
  const pill = document.getElementById('statusPill');
  const txt = document.getElementById('statusTxt');
  if (!pill) return;
  pill.classList.remove('live', 'closed');
  if (s.status === 'open') { pill.classList.add('live'); txt.textContent = 'Sale Live'; }
  else { pill.classList.add('closed'); txt.textContent = 'Closed'; }
}

function renderBidder(s) {
  const grid = document.getElementById('catalogGrid');
  if (grid) {
    if (s.status === 'open' && s.lots && s.lots.length > 0) {
      grid.innerHTML = s.lots.map(lot => `
        <div class="lot-card" style="background:linear-gradient(180deg,var(--panel),var(--panel-2)); border:1px solid var(--line); border-radius:10px; overflow:hidden; display:flex; flex-direction:column; box-shadow:var(--shadow);">
          ${lot.photoUrl ? `<div class="lot-photo" style="background-image:url('${esc(lot.photoUrl)}'); height:200px; background-size:cover; background-position:center; border-bottom:1px solid var(--line);"></div>` : ''}
          <div class="lot-details" style="padding:20px; flex:1; display:flex; flex-direction:column;">
             <div class="lot-title" style="font-size:24px; margin:0; line-height:1.2;">${esc(lot.title)}</div>
             <div class="lot-blurb" style="font-size:14px; margin:8px 0 16px; flex:1;">${esc(lot.blurb)}</div>
             <div class="bigrow" style="margin-top:0; padding-top:0; border:none; gap:10px; align-items: center;">
                <div style="flex:1"><div class="biglabel">Highest Bid</div><div class="bigval" style="font-size:24px;">${fmt(lot.value || 0)}</div></div>
                <div style="font-size:12px; color: var(--muted); text-align:right;">Held by:<br><span style="color:var(--cream); font-weight:600;">${lot.leader ? esc(lot.leader) : '—'}</span></div>
             </div>
             <div class="quickrow" style="margin-top:15px; margin-bottom:0;">
               <button class="chip bid-btn" data-lotid="${lot.id}" data-add="50">+50</button>
               <button class="chip bid-btn" data-lotid="${lot.id}" data-add="100">+100</button>
               <button class="chip bid-btn" data-lotid="${lot.id}" data-add="250">+250</button>
               <button class="chip rng bid-btn" data-lotid="${lot.id}" data-add="1000">+1k</button>
             </div>
          </div>
        </div>
      `).join('');

      grid.querySelectorAll('.bid-btn').forEach(btn => {
        btn.onclick = () => {
          const lotId = btn.dataset.lotid;
          const lot = s.lots.find(l => l.id === lotId);
          if (lot) placeBid(lotId, (lot.value || 0) + Number(btn.dataset.add));
        };
      });
    } else {
      const winnersList = (s.history || []).filter(h => h.winner).map(h => `
        <div style="background:var(--panel-2); border:1px solid var(--gold); border-radius:8px; padding:15px; margin-bottom:15px; box-shadow:0 10px 30px -10px rgba(205,163,90,0.3);">
          <div style="color:var(--gold-bright); font-size:32px; font-weight:700; font-family:'Cormorant Garamond',serif;">${esc(h.winner)}</div>
          <div style="color:var(--cream); font-size:16px;">won <i>${esc(h.lot)}</i> for ${fmt(h.value)}</div>
        </div>
      `).join('');
      const noWinners = `<div style="color:var(--muted); font-size:18px;">No items were sold.</div>`;

      grid.innerHTML = `
        <div class="stage" style="grid-column: 1 / -1; text-align:center;">
          <div class="lot-tag">${s.status === 'closed' && s.history.length ? 'SALE CONCLUDED' : 'STANDBY'}</div>
          <div class="lot-title" style="font-style:normal;color:var(--cream-dim)">${s.history.length ? 'The Final Records' : 'The room awaits.'}</div>
          <div class="lot-blurb" style="margin: 0 auto 30px;">${s.history.length ? 'The auction has ended. Congratulations to the highest bidders!' : 'No active products to bid on.'}</div>
          ${s.status === 'closed' && s.history.length ? `
            <div style="max-width: 600px; margin: 0 auto;">
              ${winnersList || noWinners}
            </div>
            <div id="bidderResults" style="margin-top: 40px; text-align:left;"></div>
          ` : ''}
        </div>
      `;
      if (s.status === 'closed' && s.history.length) renderResultsForBidder(document.getElementById('bidderResults'), s);
    }
  }
}

function renderResultsForBidder(container, s) {
  if (!container) return;
  const rows = s.history.map(h => `
    <tr class="${h.winner ? 'win' : ''}">
      <td>${esc(h.lot)}</td>
      <td>${h.winner ? esc(h.winner) : '<span style="color:var(--muted)">passed in</span>'}</td>
      <td class="num">${h.winner ? fmt(h.value) : '—'}</td>
    </tr>`).join('');
  container.innerHTML = `
    <div class="ledger-title" style="margin-top:24px">Final results</div>
    <div class="scrollx"><table>
      <thead><tr><th>Lot</th><th>Winner</th><th style="text-align:right">Hammer</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function renderAdmin(s) {
  wireAdminControls(s);
  wireAdminLotForm(s);
  const sg = document.getElementById('statgrid');
  if (sg) {
    const online = Object.values(s.participants).filter(p => isOnline(p) && p.role === 'bidder').length;
    const totalLots = s.lots ? s.lots.length : 0;
    const totalBids = s.bids.length;
    sg.innerHTML = `
      <div class="stat"><div class="sl">Status</div><div class="sv sm">${s.status === 'open' ? 'Live' : 'Closed'}</div></div>
      <div class="stat"><div class="sl">Total Lots</div><div class="sv">${totalLots}</div></div>
      <div class="stat"><div class="sl">Bidders Online</div><div class="sv">${online}</div></div>
      <div class="stat"><div class="sl">Total Bids</div><div class="sv">${totalBids}</div></div>
      <div class="stat"><div class="sl">Lots Sold</div><div class="sv">${s.history.filter(h => h.winner).length}</div></div>`;
  }
  const slot = document.getElementById('reportSlot');
  if (slot) {
    if (s.status === 'closed' && s.history.length) { slot.innerHTML = reportMarkup(s); wireReport(s); }
    else if (slot._hadReport) { slot.innerHTML = ''; }
    slot._hadReport = (s.status === 'closed' && s.history.length > 0);
  }
}

function reportMarkup(s) {
  const winners = s.history.filter(h => h.winner);
  const grand = winners.reduce((a, h) => a + h.value, 0);
  const topLot = winners.reduce((m, h) => h.value > (m?.value || 0) ? h : m, null);
  const partList = Object.values(s.participants).filter(p => p.role === 'bidder');
  const dur = s.startedAt && s.closedAt ? Math.max(1, Math.round((s.closedAt - s.startedAt) / 1000)) : 0;

  const lotRows = s.history.map((h, i) => `
    <tr class="${h.winner ? 'win' : ''}">
      <td class="mono" style="color:var(--muted)">${String(i + 1).padStart(2, '0')}</td>
      <td>${esc(h.lot)}</td>
      <td>${h.winner ? esc(h.winner) : '<span style="color:var(--muted)">passed in</span>'}</td>
      <td class="num">${h.bidCount}</td>
      <td class="num">${h.winner ? fmt(h.value) : '—'}</td>
    </tr>`).join('');

  const ledgerRows = [...s.bids].reverse().map(b => `
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
      <div class="rsub">Compiled ${new Date(s.closedAt || now()).toLocaleString()} · ${dur}s on the block · ${partList.length} bidders · ${s.bids.length} total bids</div>
    </div>

    <div class="statgrid" style="margin-bottom:8px">
      <div class="stat"><div class="sl">Grand Total (Hammer)</div><div class="sv">${fmt(grand)}</div></div>
      <div class="stat"><div class="sl">Lots Sold</div><div class="sv">${winners.length} / ${s.history.length}</div></div>
      <div class="stat"><div class="sl">Top Lot</div><div class="sv sm">${topLot ? esc(topLot.lot) : '—'}</div></div>
      <div class="stat"><div class="sl">Top Hammer</div><div class="sv">${topLot ? fmt(topLot.value) : '—'}</div></div>
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

function buildReportData(s) {
  const winners = s.history.filter(h => h.winner);
  return {
    auction: 'The Phantom Auction',
    closedAt: new Date(s.closedAt || now()).toISOString(),
    startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
    auctioneer: ME.name,
    bidders: Object.values(s.participants).filter(p => p.role === 'bidder').map(p => ({ name: p.name, email: p.email, paddle: paddleFor(p.name) })),
    summary: {
      lotsOffered: s.history.length,
      lotsSold: winners.length,
      totalBids: s.bids.length,
      grandTotalHammer: winners.reduce((a, h) => a + h.value, 0),
      currency: 'phantom-credits'
    },
    lots: s.history.map(h => ({ lot: h.lot, winner: h.winner, hammer: h.value, bids: h.bidCount })),
    ledger: s.bids.map(b => ({ paddle: b.paddle, bidder: b.user, lot: b.lot, amount: b.amount, at: new Date(b.ts).toISOString() }))
  };
}
function wireReport(s) {
  const cj = document.getElementById('copyJson');
  const dj = document.getElementById('dlJson');
  const data = () => JSON.stringify(buildReportData(s), null, 2);
  if (cj) cj.onclick = async () => { try { await navigator.clipboard.writeText(data()); toast('Report copied to clipboard.'); } catch { toast('Copy blocked by browser.'); } };
  if (dj) dj.onclick = () => {
    const blob = new Blob([data()], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = 'phantom-auction-report.json'; a.click(); URL.revokeObjectURL(a.href); toast('Report downloaded.');
  };
}

function renderRoster(s) {
  const r = document.getElementById('roster');
  const count = document.getElementById('rosterCount');
  if (!r) return;
  const people = Object.values(s.participants)
    .sort((a, b) => (b.role === 'auctioneer') - (a.role === 'auctioneer') || a.joinedAt - b.joinedAt);
  const onlineCount = people.filter(isOnline).length;
  if (count) count.textContent = onlineCount + ' online';
  const sig = people.map(p => p.name + (isOnline(p) ? '1' : '0') + p.role).join('|');
  if (r._sig === sig) return;
  r._sig = sig;
  r.innerHTML = people.map(p => {
    const on = isOnline(p);
    const adm = p.role === 'auctioneer';
    const you = p.name === ME.name;
    return `<div class="person ${you ? 'you' : ''}" style="${on ? '' : 'opacity:.4'}">
      <div class="l">
        <div class="av ${adm ? 'adm-av' : ''}">${initials(p.name)}</div>
        <span class="nm">${esc(p.name)}${you ? ' (you)' : ''}</span>
        ${adm ? '<span class="badge adm" style="font-size:9px">Gavel</span>' :
        `<span class="paddle" style="font-size:10px;padding:2px 6px">#${paddleFor(p.name)}</span>`}
      </div>
      ${on ? '<span class="live-dot" title="online"></span>' : '<span style="font-size:10px;color:var(--muted)">away</span>'}
    </div>`;
  }).join('') || '<div class="empty">Nobody here yet.</div>';
}

function renderFeed(s) {
  const feed = document.getElementById('feed');
  const count = document.getElementById('bidCount');
  if (!feed) return;
  if (count) count.textContent = s.bids.length + ' bids';
  const lastId = s.bids.length ? s.bids[s.bids.length - 1].id : 0;
  const sig = s.bids.length + ':' + lastId;
  if (feed._sig === sig) return;
  feed._sig = sig;
  const recent = [...s.bids].slice(-40).reverse();
  if (!recent.length) { feed.innerHTML = '<div class="empty">No bids yet — be the first to raise.</div>'; return; }
  feed.innerHTML = recent.map(b => `
    <div class="bid">
      <div class="bn">
        <span class="pp">#${b.paddle}</span>
        <span class="nm">${esc(b.user)}${b.user === ME.name ? ' <span style="color:var(--gold);font-size:11px">(you)</span>' : ''}</span>
      </div>
      <div style="text-align:right">
        <div class="amt">${fmt(b.amount)}</div>
        <div class="lt">${esc(b.lot)}</div>
      </div>
    </div>`).join('');
}
