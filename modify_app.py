import re
import os

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Remove LOTS array
content = re.sub(r'const LOTS = \[\s*\[.*?\]\s*\];', '', content, flags=re.DOTALL)

# 2. Update emptyState and sanitizeState
empty_state_old = """function emptyState() {
  return {
    rev: 0, status: 'closed', lotIndex: -1, lot: null, value: 0, leader: null,
    bids: [], participants: {}, history: [], startedAt: null, closedAt: null, seq: 0
  };
}"""
empty_state_new = """function emptyState() {
  return {
    rev: 0, status: 'closed', lots: [],
    bids: [], participants: {}, history: [], startedAt: null, closedAt: null, seq: 0
  };
}"""
content = content.replace(empty_state_old, empty_state_new)

sanitize_old = """function sanitizeState(s) {
  if (!s) return emptyState();
  s.bids = s.bids || [];
  s.history = s.history || [];
  s.participants = s.participants || {};
  return s;
}"""
sanitize_new = """function sanitizeState(s) {
  if (!s) return emptyState();
  s.bids = s.bids || [];
  s.history = s.history || [];
  s.participants = s.participants || {};
  s.lots = s.lots || [];
  return s;
}"""
content = content.replace(sanitize_old, sanitize_new)

# 3. Update mergeStates
merge_old = """  const cur = bids.filter(b => b.lotIndex === out.lotIndex);
  if (cur.length) {
    const top = cur.reduce((m, b) => b.amount > m.amount ? b : m, cur[0]);
    if (top.amount >= (out.value || 0)) { out.value = top.amount; out.leader = top.user; }
  }"""
merge_new = """  if (out.lots) {
    out.lots.forEach(lot => {
      const cur = bids.filter(b => b.lotId === lot.id);
      if (cur.length) {
        const top = cur.reduce((m, b) => b.amount > m.amount ? b : m, cur[0]);
        if (top.amount >= (lot.value || 0)) { lot.value = top.amount; lot.leader = top.user; }
      }
    });
  }"""
content = content.replace(merge_old, merge_new)


# 4. Replace mountBidder to wireBidPanel
bidder_regex = re.compile(r'function mountBidder\(\) \{.*?(?=function mountAdmin\(\) \{)', re.DOTALL)
bidder_new = """function mountBidder() {
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

"""
content = bidder_regex.sub(bidder_new, content)

# 5. Replace mountAdmin
admin_regex = re.compile(r'function mountAdmin\(\) \{.*?(?=function wireAdminControls\(state\) \{)', re.DOTALL)
admin_new = """function mountAdmin() {
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
}

"""
content = admin_regex.sub(admin_new, content)


# 6. Replace wireAdminControls to resetSession
controls_regex = re.compile(r'function wireAdminControls\(state\) \{.*?(?=function topbar\(\) \{)', re.DOTALL)
controls_new = """function wireAdminControls(state) {
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
        <button class="btn ghost" id="resetBtn">Reset everything</button>`;
    }
    row._sig = sig;

    const cb = document.getElementById('closeBtn');
    if (cb) cb.onclick = closeSession;
    const ob = document.getElementById('openBtn');
    if (ob) ob.onclick = openSession;
    const rb = document.getElementById('resetBtn');
    if (rb) rb.onclick = resetSession;
  }
}

async function openSession() {
  await mutate(s => {
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
  await mutate(() => emptyState());
  await mutate(s => { s.participants[ME.name] = { name: ME.name, role: ME.role, lastSeen: now(), joinedAt: now() }; return s; });
  toast('Session reset.');
}

"""
content = controls_regex.sub(controls_new, content)

# 7. Replace renderBidder and renderAdmin
render_regex = re.compile(r'function renderBidder\(s\) \{.*?(?=function reportMarkup\(s\) \{)', re.DOTALL)
render_new = """function renderBidder(s) {
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
      grid.innerHTML = `
        <div class="stage" style="grid-column: 1 / -1">
          <div class="lot-tag">${s.status === 'closed' && s.history.length ? 'SALE CONCLUDED' : 'STANDBY'}</div>
          <div class="lot-title" style="font-style:normal;color:var(--cream-dim)">${s.history.length ? 'The gavel has fallen.' : 'The room awaits.'}</div>
          <div class="lot-blurb">${s.history.length ? 'Thank you for bidding. The Auctioneer holds the final record.' : 'No active products to bid on.'}</div>
          ${s.status === 'closed' && s.history.length ? '<div id="bidderResults"></div>' : ''}
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

"""
content = render_regex.sub(render_new, content)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
