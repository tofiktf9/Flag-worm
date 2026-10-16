// منطق الاقتصاد (دوال نقية بدون قاعدة بيانات) — السيرفر هو المرجع الوحيد لها
const crypto = require('crypto');
class Bad extends Error {}
const bad = c => new Bad(c);
const nd = l => l * l * 220 + 300; // الخبرة المطلوبة (أصعب)، وأعلى مستوى 999
const lvOf = xp => { let x = xp || 0, l = 1; while (l < 999 && x >= nd(l)) { x -= nd(l); l++; } return l; };
const WK = 168 * 36e5, DAY = 864e5;
const boostOf = (st, now) => (st.bs && now < st.bs.u ? st.bs.m : 0);
const pay = (st, n) => { if ((st.coins || 0) < n) throw bad('no_coins'); st.coins -= n; };

function skinPrice(cat, i, now) {
  const k = cat.skins[i]; if (!k || k.x || !(k.p > 0)) return null;
  let p = Math.round(k.p * (k.L ? 2.9 : 1.8) / 10) * 10;
  const w = Math.floor(now / WK), el = cat.skins.map((s, j) => j).filter(j => cat.skins[j].p > 0 && !cat.skins[j].x);
  if ([0, 1, 2, 3, 4, 5].map(j => el[(w * 13 + j * 17) % el.length]).includes(i)) p = Math.round(p * .85);
  return p;
}
function buy(cat, st, { kind, id }, now) {
  st.own = st.own || [0];
  if (kind === 'skin') { const i = +id, p = skinPrice(cat, i, now); if (p == null) throw bad('bad_item'); if (st.own.includes(i)) throw bad('owned'); pay(st, p); st.own.push(i); }
  else if (kind === 'flag') { if (!cat.flags.includes(id)) throw bad('bad_item'); st.fown = st.fown || []; if (st.fown.includes(id)) throw bad('owned'); pay(st, 50); st.fown.push(id); }
  else if (kind === 'grave') { const v = cat.graves.find(g => g.e === id); if (!v || v.x || !(v.p > 0)) throw bad('bad_item'); st.gown = st.gown || ['🪦']; if (st.gown.includes(id)) throw bad('owned'); pay(st, v.p); st.gown.push(id); }
  else if (kind === 'effect') { const i = +id; if (!(i >= 1 && i < cat.ep.length)) throw bad('bad_item'); st.eo = st.eo || []; if (st.eo.includes(i)) throw bad('owned'); pay(st, cat.ep[i]); st.eo.push(i); }
  else if (kind === 'booster') { const i = +id, b = cat.bo[i]; if (!b) throw bad('bad_item'); pay(st, b[1]); const same = st.bs && st.bs.k === i + 1 && st.bs.u > now; st.bs = { m: b[0] / 100, k: i + 1, u: (same ? st.bs.u : now) + DAY }; }
  else throw bad('bad_item');
}
function daily(st, now) { if (st.gt && now < st.gt) throw bad('cooldown'); st.coins = (st.coins || 0) + 100; st.gt = now + DAY; }
function spin(cat, st, now, r) {
  if (st.wt && now < st.wt) throw bad('cooldown');
  let x = r * 100, i = 0; while (i < cat.wp.length - 1 && x >= cat.ww[i]) { x -= cat.ww[i]; i++; }
  st.coins = (st.coins || 0) + cat.wp[i]; st.wt = now + WK; return i; // العجلة كل 168 ساعة
}
const MAX_RATE = 30, MAX_RUN_SCORE = 30000, MIN_RUN_SEC = 3, DAY_CAP = 6000, BAG_COINS = 5, BAG_EVERY = 6, FREE_REVIVES = 1, MAX_REVIVES_TOTAL = 3;
// سقف ما يُكسب من الجولات في 24 ساعة (يمنع مزارع النقاط والأكياس)
function dayRoom(st, now) { if (now > (st.rcT || 0)) { st.rcT = now + DAY; st.rcDay = 0; } return Math.max(0, DAY_CAP - (st.rcDay || 0)); }
function runEnd(st, run, score, now, bags) {
  const el = (now - run.t0) / 1000, ok = el >= MIN_RUN_SEC;
  const cap = ok ? Math.min(Math.floor(el * MAX_RATE) + 50, MAX_RUN_SCORE) : 0;
  const sc = Math.max(0, Math.min(Math.floor(+score || 0), cap)), delta = Math.max(0, sc - run.paid);
  run.paid += delta;
  const bagMax = ok ? Math.floor(el / BAG_EVERY) + 2 : 0, nb = Math.max(0, Math.min(Math.floor(+bags || 0), bagMax) - (run.bags || 0));
  run.bags = (run.bags || 0) + nb;
  const l0 = lvOf(st.xp), co = Math.floor(delta / 4), bagCo = nb * BAG_COINS, xp = Math.round(delta * (1 + boostOf(st, now) * 1.25));
  st.xp = (st.xp || 0) + xp; st.tot = (st.tot || 0) + delta;
  const l1 = lvOf(st.xp), bonus = 50 * (l1 - l0);
  const room = dayRoom(st, now), add = Math.min(co + bagCo + bonus, room);
  st.rcDay = (st.rcDay || 0) + add; st.coins = (st.coins || 0) + add;
  const record = sc > (st.best || 0); if (record) st.best = sc;
  run.lastCo = Math.min(co, add); run.bonusUsed = false;
  return { score: sc, coins: co, bagCo, xp, levelUp: l1 > l0 ? l1 : 0, bonus, record, capped: add < co + bagCo + bonus };
}
function runBonus(st, run, now) {
  if (!run.lastCo || run.bonusUsed) throw bad('no_bonus');
  const add = Math.min(run.lastCo, dayRoom(st, now || Date.now()));
  st.rcDay = (st.rcDay || 0) + add; st.coins = (st.coins || 0) + add; run.bonusUsed = true;
}
function runRevive(st, run, free) {
  if ((run.revives || 0) >= MAX_REVIVES_TOTAL) throw bad('max_revives');
  if (free) { if ((run.freeUsed || 0) >= FREE_REVIVES) throw bad('max_free'); run.freeUsed = (run.freeUsed || 0) + 1; }
  else pay(st, 100);
  run.revives = (run.revives || 0) + 1;
}
function prefs(cat, st, b) {
  if (typeof b.flag === 'string' && cat.flags.includes(b.flag)) st.flag = b.flag;
  if (typeof b.av === 'string') st.av = b.av.slice(0, 4);
  if (!b.pic) delete st.pic; else if (typeof b.pic === 'string' && b.pic.length < 60000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b.pic)) st.pic = b.pic;
  if (Number.isInteger(b.skin) && (st.own || [0]).includes(b.skin)) st.skin = b.skin;
  if (!b.fsk) st.fsk = ''; else if ((st.fown || []).includes(b.fsk)) st.fsk = b.fsk;
  if (typeof b.gsel === 'string' && (b.gsel === '🪦' || (st.gown || []).includes(b.gsel))) st.gsel = b.gsel;
  if (Number.isInteger(b.ef) && (b.ef === 0 || (st.eo || []).includes(b.ef))) st.ef = b.ef;
}
function deliver(cat, st, o) {
  if (o.kind === 'coins') st.coins = (st.coins || 0) + o.item;
  else if (o.kind === 'offer') {
    const of = cat.offers[o.item]; if (!of) throw bad('bad_item');
    st.ob = st.ob || []; if (st.ob.includes(o.item)) return false; st.ob.push(o.item);
    st.own = st.own || [0]; of.sk.forEach(i => { if (i >= 0 && !st.own.includes(i)) st.own.push(i); });
    st.coins = (st.coins || 0) + of.c; st.gown = st.gown || ['🪦']; of.g.forEach(e => { if (!st.gown.includes(e)) st.gown.push(e); });
  } else throw bad('bad_item');
}

// ===== أكواد الهدية: شكلها GIFT-XXXX-XXXXXXX. المولّد (ملف منفصل عندك) يطلع لك الأكواد + ملف بصمات (hash) تحطه في data/batches.
// السيرفر ما يعرف الأكواد نفسها، بس بصماتها، فما يحتاج أي مفتاح، وما أحد يقدر يصنع كود شغّال بدون ما يضيف بصمته لمستودعك.
const SALT = 'flag-worm-gift-v1', ITER = 150000;
const normCode = s => { const t = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); const m = /^GIFT([A-Z2-9]{4})([A-Z2-9]{7})$/.exec(t); return m ? 'GIFT-' + m[1] + '-' + m[2] : null; };
const hashCode = code => new Promise((ok, no) => crypto.pbkdf2(code, SALT, ITER, 32, 'sha256', (e, k) => e ? no(e) : ok(k.toString('hex'))));
function loadBatches(dir) {
  const fs = require('fs'), path = require('path'), map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); for (const c of (j.codes || [])) if (/^[0-9a-f]{64}$/.test(c.h) && Number.isInteger(c.a) && c.a >= 1 && c.a <= 100000) map.set(c.h, c.a); } catch (e) { console.error('bad batch file', f, e.message); }
  }
  return map;
}
module.exports = { normCode, hashCode, loadBatches, Bad, nd, lvOf, skinPrice, buy, daily, spin, runEnd, runBonus, runRevive, prefs, deliver, boostOf, DAY };
