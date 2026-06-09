import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update emptyState
content = content.replace("rev: 0, status: 'closed', lots: [],", "rev: 0, clearSeq: 0, status: 'closed', lots: [],")

# 2. Update mergeStates
merge_regex = re.compile(r'function mergeStates\(remote, local\) \{.*?\n\}', re.DOTALL)
merge_new = '''function mergeStates(remote, local) {
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
}'''

content = merge_regex.sub(merge_new.replace('\\', '\\\\'), content)

# 3. Update openSession
open_regex = re.compile(r'async function openSession\(\) \{\s*await mutate\(s => \{\s*s\.status = \'open\';')
content = open_regex.sub("async function openSession() {\\n  await mutate(s => {\\n    s.clearSeq = (s.clearSeq || 0) + 1;\\n    s.status = 'open';", content)

# 4. Update clearBidsSession
clear_regex = re.compile(r'async function clearBidsSession\(\) \{\s*await mutate\(s => \{\s*s\.bids = \[\];')
content = clear_regex.sub("async function clearBidsSession() {\\n  await mutate(s => {\\n    s.clearSeq = (s.clearSeq || 0) + 1;\\n    s.bids = [];", content)

# 5. Update resetSession
reset_regex = re.compile(r'async function resetSession\(\) \{\s*await mutate\(\(\) => emptyState\(\)\);\s*await mutate\(s => \{ s\.participants')
reset_new = '''async function resetSession() {
  await mutate(s => { 
    const c = (s.clearSeq || 0) + 1;
    const r = (s.rev || 0);
    const n = emptyState();
    n.clearSeq = c; n.rev = r;
    return n;
  });
  await mutate(s => { s.participants'''
content = reset_regex.sub(reset_new, content)

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
