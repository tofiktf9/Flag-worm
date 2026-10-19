const express = require('express'), crypto = require('crypto'), path = require('path'), { Pool } = require('pg');
const L = require('./logic'), CAT = require('./catalog.json');
const DB = process.env.DATABASE_URL;
const wantSsl = process.env.PGSSL ? process.env.PGSSL === '1' : !!DB && !/localhost|127\.0\.0\.1/.test(DB);
const mkPool = ssl => new Pool({ connectionString: DB, ssl: ssl ? { rejectUnauthorized: false } : false });
let pool = mkPool(wantSsl);
const q = (t, p) => pool.query(t, p);
const app = express();
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=15552000' }); next(); });
app.use(express.json({ limit: '1mb', verify: (req, res, buf) => { req.raw = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));

async function init0() {
  await q(`create table if not exists users(
    id serial primary key, name text not null, name_lower text unique not null, email text unique,
    salt text not null, hash text not null, state jsonb not null default '{}', upd bigint not null default 0, created timestamptz default now());
  create table if not exists sessions(token text primary key, user_id int references users(id) on delete cascade, created timestamptz default now());
  create table if not exists orders(id serial primary key, user_id int references users(id), kind text not null, item int not null, amount int not null, status text not null default 'pending', checkout_id text unique, created timestamptz default now(), paid_at timestamptz);
  alter table orders add column if not exists picks text; alter table orders add column if not exists provider text; alter table orders add column if not exists usd_cents int;
  create table if not exists used_codes(hash text primary key, user_id int, coins int not null, used_at timestamptz default now());
  create table if not exists codes(code text primary key, coins int not null, used_by int, used_at timestamptz, created_by int, created timestamptz default now());
  create table if not exists dms(id bigserial primary key, from_id int not null references users(id) on delete cascade, to_id int not null references users(id) on delete cascade, txt text not null, seen boolean not null default false, created timestamptz default now());
  create index if not exists dms_pair on dms(least(from_id,to_id), greatest(from_id,to_id), id);
  create index if not exists dms_to on dms(to_id, seen);
  create table if not exists boss_state(room int primary key, respawn bigint not null default 0);`);
}
async function init() { // لو السيرفر ما يدعم SSL (اتصال داخلي) نعيد المحاولة بدونه
  try { await init0(); } catch (e) { if (wantSsl && /does not support SSL/i.test(e.message)) { pool = mkPool(false); await init0(); } else throw e; }
}
// معالج للأخطاء: يمرّر next (مهم للـ middleware) ويحوّل أخطاء المنطق إلى 400
const w = f => (req, res, next) => f(req, res, next).catch(e => {
  if (e instanceof L.Bad) return res.status(400).json({ error: e.message });
  console.error(e); res.status(500).json({ error: 'server' });
});
const hash = (p, s) => new Promise((ok, no) => crypto.scrypt(p, s, 64, (e, k) => e ? no(e) : ok(k.toString('hex')))); // غير متزامن: ما يوقف السيرفر
const sameSig = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const rl = new Map();
const guard = (max, ms = 60000) => (req, res, next) => {
  const k = (req.u ? 'u' + req.u.id : req.ip) + req.path, n = Date.now(), a = (rl.get(k) || []).filter(t => n - t < ms); a.push(n); rl.set(k, a);
  if (rl.size > 20000) rl.clear();
  a.length > max ? res.status(429).json({ error: 'rate' }) : next();
};
const authm = w(async (req, res, next) => {
  const t = (req.headers.authorization || '').slice(7);
  const r = t && await q('select u.* from sessions s join users u on u.id=s.user_id where s.token=$1 and s.created > now() - interval \'30 days\'', [t]);
  if (!r || !r.rows[0]) return res.status(401).json({ error: 'auth' });
  req.u = r.rows[0]; next();
});
const newSession = async uid => { const t = crypto.randomBytes(32).toString('hex'); await q('insert into sessions(token,user_id) values($1,$2)', [t, uid]); return t; };
const GIFT = L.loadHashes(['/etc/secrets', path.join(__dirname, 'data', 'secret')]); // بصمات أكواد الهدية الجاهزة (Render Secret Files)
console.log('gift codes loaded:', GIFT.size);
const OWNER = (process.env.OWNER_USER || '').trim().toLowerCase(); // اسم حسابك: يطلع لك لفل 999 (لك أنت بس)
const isOwner = u => !!OWNER && u.name_lower === OWNER;
const ownerSync = async u => { if (isOwner(u)) u.state = (await tx(u.id, st => { L.grantAll(CAT, st); })).state; return u; }; // المالك: كل شي مملوك + مميز دائماً
const withOw = (st, u, now) => { const s = { ...st, ow: isOwner(u) ? 1 : 0 }; L.fixVip(CAT, s, now || Date.now()); return s; };
const DEF = () => ({ flag: 'DZ', skin: 0, own: [0], coins: 100, xp: 0, best: 0, tot: 0 });

// تحديث حالة اللاعب داخل معاملة مقفولة (يمنع السباق بين الطلبات)
async function tx(uid, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const r = await c.query('select state from users where id=$1 for update', [uid]);
    const st = r.rows[0].state || {};
    const out = await fn(st);
    await c.query('update users set state=$1, upd=$2 where id=$3', [JSON.stringify(st), Date.now(), uid]);
    await c.query('commit');
    return { state: st, out };
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}
const act = (max, fn) => [authm, guard(max), w(async (req, res) => { const { state, out } = await tx(req.u.id, st => fn(st, req)); res.json({ state, ...(out || {}) }); })];

app.get('/healthz', (_, res) => res.send('ok'));
app.get('/api/status', (_, res) => res.json({ ok: true, giftCodes: GIFT.size })); // افتحه للتأكد إن قائمة الأكواد انحمّلت (لازم > 0)

app.post('/api/register', guard(10), w(async (req, res) => {
  const { name = '', password = '', email = '' } = req.body || {};
  const n = String(name).trim(), e = String(email).trim().toLowerCase();
  if (!/^[\p{L}\p{N}_ ]{2,12}$/u.test(n) || n.startsWith('__')) return res.status(400).json({ error: 'bad_name' });
  if (String(password).length < 6 || String(password).length > 100) return res.status(400).json({ error: 'bad_password' });
  if (e && (e.length > 100 || !/^\S+@\S+\.\S+$/.test(e))) return res.status(400).json({ error: 'bad_email' });
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = await q('insert into users(name,name_lower,email,salt,hash,state) values($1,$2,$3,$4,$5,$6) returning id', [n, n.toLowerCase(), e || null, salt, await hash(password, salt), DEF()]);
    res.json({ token: await newSession(r.rows[0].id), id: r.rows[0].id, name: n, state: withOw(DEF(), { name_lower: n.toLowerCase() }) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: /email/.test(err.detail || '') ? 'email_taken' : 'name_taken' });
    throw err;
  }
}));
const fails = new Map(); // محاولات الدخول الفاشلة لكل حساب (يمنع تخمين كلمة السر)
app.post('/api/login', guard(10), w(async (req, res) => {
  const { name = '', password = '' } = req.body || {};
  const k = String(name).trim().toLowerCase().slice(0, 100), f = (fails.get(k) || []).filter(t => Date.now() - t < 9e5);
  if (f.length >= 8) return res.status(429).json({ error: 'rate' });
  const u = (await q('select * from users where name_lower=$1 or email=$1', [k])).rows[0];
  const hh = await hash(String(password).slice(0, 100), u ? u.salt : '0'.repeat(32)); // نفس الوقت حتى لو الحساب غير موجود
  if (!u || !sameSig(hh, u.hash)) { f.push(Date.now()); fails.set(k, f); if (fails.size > 20000) fails.clear(); return res.status(401).json({ error: 'bad_login' }); }
  fails.delete(k);
  await q("delete from sessions where created < now() - interval '30 days'");
  await ownerSync(u);
  res.json({ token: await newSession(u.id), id: u.id, name: u.name, state: withOw(u.state, u) });
}));
app.post('/api/logout', authm, w(async (req, res) => { await q('delete from sessions where token=$1', [(req.headers.authorization || '').slice(7)]); res.json({ ok: 1 }); }));
app.get('/api/me', authm, w(async (req, res) => {
  await ownerSync(req.u);
  const st = req.u.state || {}, ks = Object.keys(st.codes || {});
  if (ks.length) { const r = await q('select code from codes where code = any($1) and used_by is not null', [ks]); if (r.rows.length) { const s2 = { ...st, codes: { ...st.codes } }; for (const x of r.rows) delete s2.codes[x.code]; return res.json({ id: req.u.id, name: req.u.name, state: withOw(s2, req.u), now: Date.now() }); } }
  res.json({ id: req.u.id, name: req.u.name, state: withOw(st, req.u), now: Date.now() });
}));

// ===== الاقتصاد: كله هنا في السيرفر (العميل ما يقدر يعدّل العملات أو المشتريات) =====
app.put('/api/prefs', ...act(30, (st, req) => { L.prefs(CAT, st, req.body || {}); }));
app.post('/api/buy', ...act(30, (st, req) => { L.buy(CAT, st, req.body || {}, Date.now()); }));
app.post('/api/daily', ...act(10, st => { L.daily(st, Date.now()); }));
app.post('/api/spin', ...act(10, st => ({ i: L.spin(CAT, st, Date.now(), crypto.randomInt(0, 1e6) / 1e6) })));

const RUNS = new Map();
setInterval(() => { const n = Date.now(); for (const [k, v] of RUNS) if (n - v.t0 > 3 * 36e5) RUNS.delete(k); }, 6e5).unref();
const runOf = (req) => { const r = RUNS.get(String((req.body || {}).run)); if (!r || r.uid !== req.u.id) throw new L.Bad('no_run'); return r; };
app.post('/api/run/start', ...act(30, (st, req) => {
  for (const [k, v] of RUNS) if (v.uid === req.u.id) RUNS.delete(k);
  const id = crypto.randomBytes(12).toString('hex');
  RUNS.set(id, { uid: req.u.id, t0: Date.now(), paid: 0, revives: 0, lastCo: 0, bonusUsed: true });
  return { run: id };
}));
app.post('/api/run/end', ...act(60, (st, req) => { LBC.t = 0; return { reward: L.runEnd(st, runOf(req), (req.body || {}).score, Date.now(), (req.body || {}).bags) }; })); // يحدّث المتصدرين فوراً
app.post('/api/run/revive', ...act(30, (st, req) => { L.runRevive(st, runOf(req), !!(req.body || {}).free); }));
app.post('/api/run/bonus', ...act(30, (st, req) => { L.runBonus(st, runOf(req), Date.now()); }));

let LBC = { t: 0, rows: [] };
app.get('/api/leaderboard', w(async (_, res) => {
  if (Date.now() - LBC.t > 10000) {
    const r = await q(`select name, state->>'flag' as flag, state->>'av' as av, coalesce((state->>'tot')::bigint,0) as total from users order by total desc limit 50`);
    LBC = { t: Date.now(), rows: r.rows.map(x => ({ ...x, total: Number(x.total) })) };
  }
  res.json({ rows: LBC.rows });
}));

// رموز الهدية: استعمال مرة وحدة (الإنشاء المدفوع معطّل في الإنتاج)
app.post('/api/code/create', authm, guard(10), w(async (req, res) => {
  if (process.env.ALLOW_TEST_PURCHASES !== '1') return res.status(403).json({ error: 'payments_disabled' });
  const coins = [50, 100, 200, 500, 1000, 2000, 5000].includes(+req.body.coins) ? +req.body.coins : 0;
  if (!coins) return res.status(400).json({ error: 'bad_amount' });
  const code = 'GIFT-' + crypto.randomBytes(5).toString('hex').toUpperCase();
  await q('insert into codes(code,coins,created_by) values($1,$2,$3)', [code, coins, req.u.id]);
  res.json({ code });
}));
const bad = new Map(); // محاولات الكود الخاطئة (يمنع تخمين الأكواد)
const badN = (k, ms) => { const n = Date.now(), a = (bad.get(k) || []).filter(t => n - t < ms); bad.set(k, a); if (bad.size > 50000) bad.clear(); return a.length; };
const badAdd = (...ks) => ks.forEach(k => { const a = bad.get(k) || []; a.push(Date.now()); bad.set(k, a); });
app.post('/api/redeem', ...act(10, async (st, req) => {
  const raw = String((req.body || {}).code || '').trim().toUpperCase(), c = L.normCode(raw), key = c || raw, ku = 'u' + req.u.id, ki = 'i' + req.ip;
  if (badN(ku, 600000) >= 10 || badN(ki, 3600000) >= 30) throw new L.Bad('rate'); // 10 محاولات خاطئة بـ10 دقايق، أو 30 من نفس الشبكة بالساعة
  // 1) أكواد بطاقات الهدية المشتراة (محفوظة في القاعدة)
  const r = await q('update codes set used_by=$1, used_at=now() where code=$2 and used_by is null returning coins', [req.u.id, key]);
  if (r.rows[0]) { if (st.codes) delete st.codes[key]; st.coins = (st.coins || 0) + r.rows[0].coins; return { coins: r.rows[0].coins }; }
  const ex = await q('select 1 from codes where code=$1', [key]);
  if (ex.rows[0]) throw new L.Bad('used');
  // 2) الأكواد الجاهزة (ملفات txt اللي عندك): نقارن بصمتها بالقائمة السرّية
  if (c) {
    const h = await L.hashCode(c), amt = GIFT.get(h);
    if (amt) {
      const u = await q('insert into used_codes(hash,user_id,coins) values($1,$2,$3) on conflict do nothing returning coins', [h, req.u.id, amt]);
      if (!u.rows[0]) throw new L.Bad('used');
      st.coins = (st.coins || 0) + amt; return { coins: amt };
    }
  }
  if (c && GIFT.size === 0) throw new L.Bad('nocodes'); // قائمة الأكواد ما انحمّلت في السيرفر
  badAdd(ku, ki); throw new L.Bad('invalid');
}));

// ===== الدفع: Chargily (بطاقات جزائرية) + Lemon Squeezy (بطاقات دولية / PayPal) =====
const CK = process.env.CHARGILY_SECRET_KEY, CG_TEST = process.env.CHARGILY_MODE !== 'live';
const LK = process.env.LEMONSQUEEZY_API_KEY, LS_STORE = process.env.LEMONSQUEEZY_STORE_ID, LS_VARIANT = process.env.LEMONSQUEEZY_VARIANT_ID,
  LS_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET, LS_TEST = process.env.LEMONSQUEEZY_TEST_MODE !== '0';
const RATE = +process.env.DZD_PER_USD || 135, BASE = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const have = { cg: !!(CK && BASE), ls: !!(LK && LS_STORE && LS_VARIANT && LS_SECRET && BASE) };
const PRICE = { // الأسعار بالدولار (مصدر الحقيقة هنا في السيرفر)
  coins: { 1500: .99, 3500: 2.49, 6500: 4.99, 9500: 7.99, 15000: 14.99 },
  gift: { 500: .59, 1500: 1.49, 5000: 4.99, 10000: 9.99, 25000: 15.99 }, // بطاقات الهدية (رمز تعطيه لأي أحد)
  vip: { 1: .99, 7: 3.99, 30: 9.99, 90: 24.99 }, // اشتراك الحساب المميز (أيام)
  offer: { 0: 4.99, 1: 8.99, 2: 12.99 } };
app.get('/api/pay/providers', (_, res) => res.json(have));

app.post('/api/pay/checkout', authm, guard(10), w(async (req, res) => {
  const { kind, item } = req.body || {}; let p = (req.body || {}).provider;
  const usd = PRICE[kind] && PRICE[kind][item];
  if (!usd) return res.status(400).json({ error: 'bad_item' });
  if (!have[p]) p = have.cg ? 'cg' : have.ls ? 'ls' : null;
  if (!p) return res.status(503).json({ error: 'payments_disabled' });
  if (kind === 'offer') { const ob = (req.u.state || {}).ob || []; if (ob.includes(+item) || (+item > 0 && !ob.includes(+item - 1))) return res.status(400).json({ error: 'offer_locked' }); }
  const picks = kind === 'offer' ? L.cleanPicks(CAT, req.u.state || {}, +item, (req.body || {}).picks) : null; // لازم تختار العدد المطلوب من السكنات
  const dzd = Math.max(1, Math.round(usd * RATE)), cents = Math.round(usd * 100);
  const o = await q('insert into orders(user_id,kind,item,amount,provider,usd_cents,picks) values($1,$2,$3,$4,$5,$6,$7) returning id', [req.u.id, kind, +item, dzd, p, cents, picks ? JSON.stringify(picks) : null]);
  const oid = o.rows[0].id;
  if (p === 'cg') {
    const r = await fetch(`https://pay.chargily.net${CG_TEST ? '/test' : ''}/api/v2/checkouts`, { method: 'POST',
      headers: { Authorization: 'Bearer ' + CK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: dzd, currency: 'dzd', success_url: BASE + '/?paid=1', failure_url: BASE + '/?paid=0' }) });
    const j = await r.json().catch(() => ({}));
    if (!j.checkout_url || !j.id) { console.error('chargily', r.status, j); return res.status(502).json({ error: 'gateway' }); }
    await q('update orders set checkout_id=$1 where id=$2', [j.id, oid]);
    return res.json({ url: j.checkout_url });
  }
  const r = await fetch('https://api.lemonsqueezy.com/v1/checkouts', { method: 'POST',
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json', Authorization: 'Bearer ' + LK },
    body: JSON.stringify({ data: { type: 'checkouts', attributes: { custom_price: cents, test_mode: LS_TEST,
      product_options: { name: 'Flag Worm - ' + kind + ' ' + item, redirect_url: BASE + '/?paid=1' },
      checkout_data: { custom: { order: String(oid) } } },
      relationships: { store: { data: { type: 'stores', id: String(LS_STORE) } }, variant: { data: { type: 'variants', id: String(LS_VARIANT) } } } } }) });
  const j = await r.json().catch(() => ({})), url = j.data && j.data.attributes && j.data.attributes.url;
  if (!url) { console.error('lemon', r.status, JSON.stringify(j).slice(0, 500)); return res.status(502).json({ error: 'gateway' }); }
  res.json({ url });
}));

const GA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', newGift = () => { return 'GIFT-' + Array.from(crypto.randomBytes(6), x => GA[x & 31]).join(''); };
async function deliverOrder(o) {
  if (o.kind === 'gift') { // بطاقة هدية: نصنع كود ونحطه في جدول أكواد اللاعب
    const code = newGift(); await q('insert into codes(code,coins,created_by) values($1,$2,$3)', [code, o.item, o.user_id]);
    await tx(o.user_id, st => { (st.codes = st.codes || {})[code] = o.item; }); return;
  }
  await tx(o.user_id, st => L.deliver(CAT, st, { ...o, picks: o.picks ? JSON.parse(o.picks) : [] }));
} // يُستدعى مرة وحدة لكل طلب مدفوع

app.post('/api/pay/webhook', w(async (req, res) => { // Chargily
  const sig = req.get('signature');
  if (!sig || !req.raw || !CK) return res.sendStatus(400);
  if (!sameSig(sig, crypto.createHmac('sha256', CK).update(req.raw).digest('hex'))) return res.sendStatus(403);
  const ev = req.body || {};
  if (ev.type === 'checkout.paid' && ev.data && ev.data.id) {
    const r = await q("update orders set status='paid', paid_at=now() where checkout_id=$1 and provider='cg' and status='pending' and $2>=amount returning *", [ev.data.id, +ev.data.amount || 0]);
    if (r.rows[0]) await deliverOrder(r.rows[0]);
  }
  res.sendStatus(200);
}));
app.post('/api/pay/ls-webhook', w(async (req, res) => { // Lemon Squeezy
  const sig = req.get('x-signature');
  if (!sig || !req.raw || !LS_SECRET) return res.sendStatus(400);
  if (!sameSig(sig, crypto.createHmac('sha256', LS_SECRET).update(req.raw).digest('hex'))) return res.sendStatus(403);
  const ev = req.body || {}, m = ev.meta || {}, at = (ev.data || {}).attributes || {}, id = +((m.custom_data || {}).order);
  if (m.event_name === 'order_created' && id && at.status === 'paid' && at.currency === 'USD') {
    const r = await q("update orders set status='paid', paid_at=now() where id=$1 and provider='ls' and status='pending' and $2>=usd_cents returning *", [id, +at.total || 0]);
    if (r.rows[0]) await deliverOrder(r.rows[0]);
  }
  res.sendStatus(200);
}));

// ===== لعب جماعي أونلاين (WebSocket بدون مكتبات خارجية) =====
const http = require('http');
const server = http.createServer(app);
const ROOMS = [], PEERS = new Set(), MAXP = 40; let PID = 0;
const frame = (op, p) => { const n = p.length; let h; if (n < 126) h = Buffer.from([0x80 | op, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); } return Buffer.concat([h, p]); };
class Sock {
  constructor(s) { this.s = s; this.buf = Buffer.alloc(0); this.open = true; this.alive = true; s.on('data', d => this.data(d)); s.on('close', () => this.end()); s.on('error', () => this.end()); }
  send(o) { if (this.open) try { this.s.write(frame(1, Buffer.from(JSON.stringify(o)))); } catch (e) {} }
  ping() { if (this.open) try { this.s.write(frame(9, Buffer.alloc(0))); } catch (e) {} }
  close() { if (this.open) { try { this.s.write(frame(8, Buffer.alloc(0))); this.s.end(); } catch (e) {} this.end(); } }
  end() { if (this.open) { this.open = false; this.onclose && this.onclose(); } }
  data(d) {
    this.alive = true; this.buf = Buffer.concat([this.buf, d]); if (this.buf.length > 262144) return this.close();
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const op = b[0] & 15, masked = b[1] & 128; let len = b[1] & 127, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; } else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (len > 65536 || !masked) return this.close();
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), p = Buffer.from(b.subarray(off + 4, off + 4 + len)); for (let i = 0; i < len; i++) p[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) return this.close();
      if (op === 9) { try { this.s.write(frame(10, p)); } catch (e) {} } else if (op === 1 && this.onmsg) this.onmsg(p.toString());
    }
  }
}
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.url.split('?')[0] !== '/ws' || !key) return socket.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true); handleSock(new Sock(socket));
});
const num = (v, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; };
// ===== الزعيم: واحد لكل غرفة، في مربع وسط الخريطة. إذا انقتل يرجع بعد ساعة (الوقت محفوظ في القاعدة) =====
const BOSS = { HP: 1500, CX: 15000, CY: 15000, AR: 1800, RESPAWN: 36e5, LEN: 160 };
const bossSpawn = room => { room.boss = { alive: true, hp: BOSS.HP, x: BOSS.CX, y: BOSS.CY, a: 0, ta: 0, k: 0, stun: 0, dmg: new Map(), respawn: 0 }; };
const bossInfo = room => { const b = room.boss; return b ? { al: b.alive ? 1 : 0, hp: Math.max(0, Math.round(b.hp)), max: BOSS.HP, in: b.alive ? 0 : Math.max(0, b.respawn - Date.now()) } : null; };
async function bossLoad(room) {
  try { const r = await q('select respawn from boss_state where room=$1', [room.id]); const t = r.rows[0] ? +r.rows[0].respawn : 0;
    if (t > Date.now()) room.boss = { alive: false, hp: 0, respawn: t, dmg: new Map() }; else bossSpawn(room);
  } catch (e) { console.error('boss load', e); bossSpawn(room); }
  bcast(room, { t: 'boss', b: bossInfo(room) });
}
function bossTick(room) {
  const b = room.boss; if (!b) return;
  if (!b.alive) { if (Date.now() >= b.respawn) { bossSpawn(room); bcast(room, { t: 'boss', b: bossInfo(room), sp: 1 }); } return; }
  let t = null, td = 1e18; // يطارد أقرب لاعب داخل مربعه
  for (const p of room.peers.values()) { if (p.dead || Math.abs(p.x - BOSS.CX) > BOSS.AR + 300 || Math.abs(p.y - BOSS.CY) > BOSS.AR + 300) continue; const d = (p.x - b.x) ** 2 + (p.y - b.y) ** 2; if (d < td) { td = d; t = p; } }
  if (b.stun > 0) b.stun--;
  else if (t) b.ta = Math.atan2(t.y - b.y, t.x - b.x);
  else if (--b.k <= 0) { b.k = 20 + crypto.randomInt(0, 40); b.ta = b.a + (Math.random() - .5) * 2.4; }
  if (Math.abs(b.x - BOSS.CX) > BOSS.AR - 200 || Math.abs(b.y - BOSS.CY) > BOSS.AR - 200) b.ta = Math.atan2(BOSS.CY - b.y, BOSS.CX - b.x);
  const d = ((b.ta - b.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; b.a += Math.max(-.2, Math.min(.2, d));
  const sp = t && td < 9e5 ? 7.6 : 5.4; // أسرع شوي من اللاعب العادي وأبطأ من التسريع
  b.x = Math.min(BOSS.CX + BOSS.AR - 40, Math.max(BOSS.CX - BOSS.AR + 40, b.x + Math.cos(b.a) * sp));
  b.y = Math.min(BOSS.CY + BOSS.AR - 40, Math.max(BOSS.CY - BOSS.AR + 40, b.y + Math.sin(b.a) * sp));
}
async function bossKill(room, killer) {
  const b = room.boss; b.alive = false; b.hp = 0; b.respawn = Date.now() + BOSS.RESPAWN;
  q('insert into boss_state(room,respawn) values($1,$2) on conflict(room) do update set respawn=$2', [room.id, b.respawn]).catch(e => console.error('boss save', e));
  bcast(room, { t: 'boss', b: bossInfo(room), by: killer.name });
  const tot = [...b.dmg.values()].reduce((x, y) => x + y, 0) || 1;
  for (const [uid, d] of b.dmg) { // الجائزة: حسب الضرر، والقاتل ياخذ 500 زيادة
    const coins = Math.round(50 + 1950 * d / tot) + (uid === killer.uid ? 500 : 0);
    try { await tx(uid, st => { st.coins = (st.coins || 0) + coins; }); const p = peerOf(uid); if (p) p.sock.send({ t: 'breward', c: coins }); } catch (e) { console.error('boss reward', e); }
  }
  b.dmg = new Map();
}

// ===== البارتي (مجموعة أصحاب يشوفون مكان بعض ويتكلمون) =====
const PARTY = new Map(), PARTY_OF = new Map(), INV = new Map(), MAXPT = 6; let PTID = 0;
const peerOf = uid => { for (const p of PEERS) if (p.uid === uid) return p; return null; };
const clean = t => String(t || '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').trim().slice(0, 200);
function partySend(P) {
  const m = [...P.m].map(uid => { const p = peerOf(uid); return { uid, name: P.names.get(uid), on: p ? 1 : 0 }; });
  for (const uid of P.m) { const p = peerOf(uid); if (p) p.sock.send({ t: 'party', id: P.id, lead: P.lead, m }); }
}
function partyLeave(uid) {
  const P = PARTY.get(PARTY_OF.get(uid)); PARTY_OF.delete(uid); if (!P) return;
  P.m.delete(uid); const p = peerOf(uid); if (p) p.sock.send({ t: 'party', id: 0, m: [] });
  if (P.m.size < 2) { for (const u of P.m) { PARTY_OF.delete(u); const q2 = peerOf(u); if (q2) q2.sock.send({ t: 'party', id: 0, m: [], gone: 1 }); } PARTY.delete(P.id); return; }
  if (P.lead === uid) P.lead = [...P.m][0];
  partySend(P);
}
function partyJoin(inviter, me) {
  let P = PARTY.get(PARTY_OF.get(inviter.uid));
  if (P && P.m.has(me.uid)) return;
  if (P && P.m.size >= MAXPT) return me.sock.send({ t: 'sys', k: 'party_full' });
  if (PARTY_OF.has(me.uid)) partyLeave(me.uid);
  if (!P) { P = { id: ++PTID, lead: inviter.uid, m: new Set([inviter.uid]), names: new Map([[inviter.uid, inviter.name]]) }; PARTY.set(P.id, P); PARTY_OF.set(inviter.uid, P.id); }
  P.m.add(me.uid); P.names.set(me.uid, me.name); PARTY_OF.set(me.uid, P.id); partySend(P);
}

const roomFor = pref => {
  if (pref && pref.peers.size < MAXP) return pref;
  let r = ROOMS.find(x => x.peers.size < MAXP);
  if (!r) { r = { id: ROOMS.length + 1, seed: crypto.randomInt(1, 2147483647), peers: new Map(), log: [], boss: null }; ROOMS.push(r); bossLoad(r); }
  return r;
};
const FOODS = ['🍔', '🍉', '🍌', '🍇', '🍎'];
const infoOf = p => { const st0 = p.st || {}, now = Date.now(), st = { ...st0 }; L.fixVip(CAT, st, now); return { id: p.id, u: p.uid, name: p.name, vip: L.vipActive(st, now) ? 1 : 0, flag: st.flag || 'DZ', skin: st.skin | 0, fk: st.fsk || '', lvl: p.owner ? 999 : L.lvOf(st.xp), cc: L.vipActive(st, now) && st.cc && st.cc[st.skin | 0] ? st.cc[st.skin | 0] : null, av: String(st.av || '').slice(0, 4), bx: st.bs && Date.now() < st.bs.u ? st.bs.k : 0, x: Math.round(p.x), y: Math.round(p.y), dead: p.dead }; };
const bcast = (room, msg, except) => room.peers.forEach(p => { if (p !== except) p.sock.send(msg); });
function handleSock(sock) {
  let me = null, cnt = 0, t0 = Date.now(), lastChat = 0, lastEmo = 0, lastHit = 0;
  const timer = setTimeout(() => { if (!me) sock.close(); }, 5000);
  sock.onclose = () => { clearTimeout(timer); if (me) { me.room.peers.delete(me.id); PEERS.delete(me); bcast(me.room, { t: 'leave', id: me.id }); const P = PARTY.get(PARTY_OF.get(me.uid)); if (P) setTimeout(() => partySend(P), 50); } };
  sock.onmsg = async raw => {
    if (Date.now() - t0 > 1000) { t0 = Date.now(); cnt = 0; } if (++cnt > 80) return sock.close();
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    try {
      if (m.t === 'hello') {
        if (me) return;
        const r = await q("select u.id,u.name,u.name_lower,u.state from sessions s join users u on u.id=s.user_id where s.token=$1 and s.created > now() - interval '30 days'", [String(m.token || '')]);
        const u = r.rows[0]; if (!u) return sock.close();
        await ownerSync(u);
        for (const p of PEERS) if (p.uid === u.id) p.sock.close(); // اتصال واحد لكل حساب
        const P = PARTY.get(PARTY_OF.get(u.id)); let pref = null; // ندخلك نفس غرفة أصحابك في البارتي
        if (P) for (const uid of P.m) { const x = peerOf(uid); if (x && uid !== u.id) { pref = x.room; break; } }
        const room = roomFor(pref);
        me = { id: ++PID, uid: u.id, name: u.name, owner: isOwner(u), st: u.state, sock, room, x: 15000, y: 15000, a: 0, g: 0, sc: 0, b: 0, dead: true };
        room.peers.set(me.id, me); PEERS.add(me);
        sock.send({ t: 'welcome', id: me.id, uid: me.uid, seed: room.seed, peers: [...room.peers.values()].filter(p => p !== me).map(infoOf), boss: bossInfo(room), log: room.log });
        bcast(room, { t: 'join', p: infoOf(me) }, me);
        if (P) partySend(P); return;
      }
      if (!me) return;
      if (m.t === 's') { me.x = num(m.x, 0, 30000); me.y = num(m.y, 0, 30000); me.a = num(m.a, -10, 10); me.g = num(m.g, 0, 5000); me.sc = num(m.sc, 0, 1e6); me.b = m.b ? 1 : 0; }
      else if (m.t === 'eat') { const c = num(m.c, 0, 3599) | 0, k = num(m.k, 0, 15) | 0; bcast(me.room, { t: 'eat', c, k }, me); }
      else if (m.t === 'drop' && Array.isArray(m.items)) { const items = m.items.slice(0, 200).filter(i => Array.isArray(i) && FOODS.includes(i[2])).map(i => [num(i[0], 0, 30000), num(i[1], 0, 30000), i[2], num(i[3], 0, 10), num(i[4], 0, 10)]); if (items.length) bcast(me.room, { t: 'drop', items }, me); }
      else if (m.t === 'die') { if (me.dead) return; me.dead = true; bcast(me.room, { t: 'dead', id: me.id }, me); const k = me.room.peers.get(+m.by | 0); if (k && k !== me && !k.dead) k.sock.send({ t: 'kill', x: num(m.x, 0, 30000), y: num(m.y, 0, 30000), name: me.name }); }
      else if (m.t === 'alive') { if (!me.dead) return; const r = await q('select state from users where id=$1', [me.uid]); if (r.rows[0]) me.st = r.rows[0].state; me.dead = false; me.x = num(m.x, 0, 30000) || me.x; me.y = num(m.y, 0, 30000) || me.y; bcast(me.room, { t: 'join', p: infoOf(me) }, me); }
      else if (m.t === 'bhit') { // راس الزعيم صدم جسم اللاعب: ينقص من دمه
        const b = me.room.boss, now = Date.now(), g = num(m.g, 0, 5000);
        if (!b || !b.alive || me.dead || now - lastHit < 500) return;
        if (Math.hypot(me.x - b.x, me.y - b.y) > 7 * (12 + g) + 500) return;
        lastHit = now; const dmg = Math.round(10 + Math.min(30, g / 10));
        b.hp -= dmg; b.dmg.set(me.uid, (b.dmg.get(me.uid) || 0) + dmg); b.ta = b.a + Math.PI; b.stun = 12;
        bcast(me.room, { t: 'bhurt', id: me.id, d: dmg, hp: Math.max(0, b.hp) });
        if (b.hp <= 0) await bossKill(me.room, me);
      }
      else if (m.t === 'chat') { // دردشة عامة (الغرفة) أو دردشة البارتي
        const txt = clean(m.txt), now = Date.now(); if (!txt || now - lastChat < 700) return; lastChat = now;
        const msg = { t: 'chat', ch: m.ch === 'p' ? 'p' : 'g', uid: me.uid, name: me.name, f: (me.st || {}).flag || 'DZ', txt, ts: now };
        if (msg.ch === 'g') { me.room.log.push(msg); if (me.room.log.length > 30) me.room.log.shift(); bcast(me.room, msg); }
        else { const P = PARTY.get(PARTY_OF.get(me.uid)); if (!P) return sock.send({ t: 'sys', k: 'no_party' }); for (const uid of P.m) { const p = peerOf(uid); if (p) p.sock.send(msg); } }
      }
      else if (m.t === 'emo') { const e = num(m.e, 0, L.EMOJIS.length - 1) | 0, now = Date.now(); if (now - lastEmo < 800) return; lastEmo = now; bcast(me.room, { t: 'emo', id: me.id, e }); }
      else if (m.t === 'pinv') {
        const to = +m.to | 0, p = peerOf(to);
        if (to === me.uid) return;
        if (!p) return sock.send({ t: 'sys', k: 'offline' });
        const P = PARTY.get(PARTY_OF.get(me.uid));
        if (P && P.m.has(to)) return sock.send({ t: 'sys', k: 'already' });
        if (P && P.m.size >= MAXPT) return sock.send({ t: 'sys', k: 'party_full' });
        const a = INV.get(to) || new Map(); a.set(me.uid, Date.now()); INV.set(to, a); if (INV.size > 5000) INV.clear();
        p.sock.send({ t: 'pinv', from: me.uid, name: me.name }); sock.send({ t: 'sys', k: 'inv_sent', name: p.name });
      }
      else if (m.t === 'pacc') {
        const from = +m.from | 0, a = INV.get(me.uid), ts = a && a.get(from); if (a) a.delete(from);
        if (!ts || Date.now() - ts > 5 * 60000) return sock.send({ t: 'sys', k: 'inv_expired' });
        const p = peerOf(from); if (!p) return sock.send({ t: 'sys', k: 'offline' });
        partyJoin(p, me);
      }
      else if (m.t === 'pleave') partyLeave(me.uid);
    } catch (e) { console.error('ws', e); }
  };
}
setInterval(() => { for (const room of ROOMS) { if (!room.peers.size) continue; bossTick(room); const b = room.boss, arr = [...room.peers.values()].filter(p => !p.dead).map(p => [p.id, Math.round(p.x), Math.round(p.y), +p.a.toFixed(2), Math.floor(p.g), Math.floor(p.sc), p.b]); bcast(room, { t: 'snap', p: arr, b: b && b.alive ? [Math.round(b.x), Math.round(b.y), +b.a.toFixed(2), Math.max(0, Math.round(b.hp))] : null }); } }, 50).unref(); // 20 تحديث بالثانية
setInterval(() => { for (const P of PARTY.values()) { // مكان أعضاء البارتي (للخريطة الصغيرة) مرتين بالثانية
  const pos = []; for (const uid of P.m) { const p = peerOf(uid); if (p) pos.push([uid, Math.round(p.x), Math.round(p.y), p.dead ? 0 : 1, p.room.id]); }
  if (!pos.length) { for (const uid of P.m) PARTY_OF.delete(uid); PARTY.delete(P.id); continue; } // الكل طلع: نحذف البارتي
  for (const uid of P.m) { const p = peerOf(uid); if (p) p.sock.send({ t: 'ppos', m: pos }); }
} }, 500).unref();
setInterval(() => { for (const p of PEERS) { if (!p.sock.alive) p.sock.close(); else { p.sock.alive = false; p.sock.ping(); } } }, 25000).unref();

// ===== الرسائل الخاصة (بالـID تبع الحساب، تنحفظ في القاعدة وتوصل حتى لو صاحبك أوفلاين) =====
app.get('/api/user/:id', authm, guard(60), w(async (req, res) => {
  const r = await q("select id, name, state->>'flag' as flag from users where id=$1", [+req.params.id | 0]);
  if (!r.rows[0]) return res.status(404).json({ error: 'no_user' });
  res.json({ ...r.rows[0], on: peerOf(r.rows[0].id) ? 1 : 0 });
}));
app.get('/api/dm', authm, guard(60), w(async (req, res) => {
  const me = req.u.id;
  const r = await q(`select distinct on (o) o, txt, from_id, created, id from (select case when from_id=$1 then to_id else from_id end as o, txt, from_id, created, id from dms where from_id=$1 or to_id=$1) t order by o, id desc`, [me]);
  const ids = r.rows.map(x => x.o);
  const [nm, un] = await Promise.all([q("select id, name, state->>'flag' as flag from users where id = any($1)", [ids]), q('select from_id, count(*)::int n from dms where to_id=$1 and not seen group by from_id', [me])]);
  const N = new Map(nm.rows.map(x => [x.id, x])), U = new Map(un.rows.map(x => [x.from_id, x.n]));
  const rows = r.rows.filter(x => N.has(x.o)).sort((a, b) => b.id - a.id).slice(0, 50).map(x => ({ uid: x.o, name: N.get(x.o).name, flag: N.get(x.o).flag, txt: x.txt, mine: x.from_id === me ? 1 : 0, ts: +new Date(x.created), un: U.get(x.o) || 0, on: peerOf(x.o) ? 1 : 0 }));
  res.json({ rows });
}));
app.get('/api/dm/:id', authm, guard(120), w(async (req, res) => {
  const me = req.u.id, o = +req.params.id | 0;
  const r = await q('select from_id, txt, created from dms where (from_id=$1 and to_id=$2) or (from_id=$2 and to_id=$1) order by id desc limit 60', [me, o]);
  await q('update dms set seen=true where to_id=$1 and from_id=$2 and not seen', [me, o]);
  res.json({ rows: r.rows.reverse().map(x => ({ mine: x.from_id === me ? 1 : 0, txt: x.txt, ts: +new Date(x.created) })) });
}));
app.post('/api/dm/:id', authm, guard(20), w(async (req, res) => {
  const me = req.u, o = +req.params.id | 0, txt = clean((req.body || {}).txt);
  if (!txt) return res.status(400).json({ error: 'empty' });
  if (o === me.id) return res.status(400).json({ error: 'self' });
  const u = await q('select id from users where id=$1', [o]); if (!u.rows[0]) return res.status(404).json({ error: 'no_user' });
  const r = await q('insert into dms(from_id,to_id,txt) values($1,$2,$3) returning created', [me.id, o, txt]);
  const p = peerOf(o); if (p) p.sock.send({ t: 'dm', uid: me.id, name: me.name, f: (me.state || {}).flag || 'DZ', txt, ts: +new Date(r.rows[0].created) });
  res.json({ ok: 1 });
}));
app.get('/api/online', (_, res) => res.json({ n: PEERS.size }));

const PORT = process.env.PORT || 3000;
init().then(() => server.listen(PORT, () => console.log('listening ' + PORT))).catch(e => { console.error('DB init failed', e); process.exit(1); });
