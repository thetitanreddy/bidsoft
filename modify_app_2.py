import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update mountAdmin
admin_regex = re.compile(r'(<div id="adminLotForm".*?<button class="btn" id="addLotBtn">Add Product</button>\s*</div>)', re.DOTALL)
admin_new = r'\1\n    <div id="adminLotList" class="panel" style="margin-bottom:20px; display:none;"></div>'
content = admin_regex.sub(admin_new, content)

# 2. Update wireAdminLotForm to also render the list
wire_admin_form_regex = re.compile(r'(function wireAdminLotForm\(s\) \{.*?\n\})', re.DOTALL)
def replace_wire_admin(m):
    original = m.group(1)
    addition = '''
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
'''
    return original[:-1] + addition + '}'

content = wire_admin_form_regex.sub(replace_wire_admin, content)


# 3. Update wireAdminControls to add clearBidsBtn
controls_regex = re.compile(r'(<button class="btn ghost" id="resetBtn">Reset everything</button>)')
controls_new = r'\1\n        <button class="btn ghost" id="clearBidsBtn" style="margin-left:10px;">Clear Ledger & Bids</button>'
content = controls_regex.sub(controls_new, content)

controls_wire_regex = re.compile(r'(const rb = document\.getElementById\(\'resetBtn\'\);\s*if \(rb\) rb\.onclick = resetSession;)')
controls_wire_new = r'\1\n    const cl = document.getElementById(\'clearBidsBtn\');\n    if (cl) cl.onclick = clearBidsSession;'
content = controls_wire_regex.sub(controls_wire_new, content)

# 4. Add clearBidsSession function
reset_session_regex = re.compile(r'(async function resetSession\(\) \{.*?\n\})', re.DOTALL)
reset_session_new = r'\1\nasync function clearBidsSession() {\n  await mutate(s => {\n    s.bids = [];\n    s.history = [];\n    if (s.lots) s.lots.forEach(l => { l.value = 0; l.leader = null; });\n    return s;\n  });\n  toast(\'Ledger and bids cleared.\');\n}'
content = reset_session_regex.sub(reset_session_new, content)

# 5. Update renderBidder for Prominent Winner Display
render_bidder_grid_else_regex = re.compile(r'(grid\.innerHTML = `\s*<div class="stage" style="grid-column: 1 / -1">.*?</div>\s*`;)', re.DOTALL)

prominent_winner_logic = '''
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
'''

content = render_bidder_grid_else_regex.sub(prominent_winner_logic.strip(), content)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
