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
  alter table orders add column if not exists provider text; alter table orders add column if not exists usd_cents int;
  create table if not exists codes(code text primary key, coins int not null, used_by int, used_at timestamptz, created_by int, created timestamptz default now());`);
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
const OWNER = (process.env.OWNER_USER || '').trim().toLowerCase(); // اسم حساب المالك (يظهر له تبويب الأكواد)
const isOwner = u => !!OWNER && u.name_lower === OWNER;
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

app.post('/api/register', guard(10), w(async (req, res) => {
  const { name = '', password = '', email = '' } = req.body || {};
  const n = String(name).trim(), e = String(email).trim().toLowerCase();
  if (!/^[\p{L}\p{N}_ ]{2,12}$/u.test(n) || n.startsWith('__')) return res.status(400).json({ error: 'bad_name' });
  if (String(password).length < 6 || String(password).length > 100) return res.status(400).json({ error: 'bad_password' });
  if (e && (e.length > 100 || !/^\S+@\S+\.\S+$/.test(e))) return res.status(400).json({ error: 'bad_email' });
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = await q('insert into users(name,name_lower,email,salt,hash,state) values($1,$2,$3,$4,$5,$6) returning id', [n, n.toLowerCase(), e || null, salt, await hash(password, salt), DEF()]);
    res.json({ token: await newSession(r.rows[0].id), name: n, state: DEF() });
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
  res.json({ token: await newSession(u.id), name: u.name, state: u.state, owner: isOwner(u) });
}));
app.post('/api/logout', authm, w(async (req, res) => { await q('delete from sessions where token=$1', [(req.headers.authorization || '').slice(7)]); res.json({ ok: 1 }); }));
app.get('/api/me', authm, (req, res) => res.json({ name: req.u.name, state: req.u.state, now: Date.now(), owner: isOwner(req.u) }));

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
app.post('/api/run/end', ...act(60, (st, req) => ({ reward: L.runEnd(st, runOf(req), (req.body || {}).score, Date.now(), (req.body || {}).bags) })));
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
  const code = 'GIFT-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  await q('insert into codes(code,coins,created_by) values($1,$2,$3)', [code, coins, req.u.id]);
  res.json({ code });
}));
app.post('/api/redeem', ...act(10, async (st, req) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  const r = await q('update codes set used_by=$1, used_at=now() where code=$2 and used_by is null returning coins', [req.u.id, code]);
  if (!r.rows[0]) { const ex = await q('select 1 from codes where code=$1', [code]); throw new L.Bad(ex.rows[0] ? 'used' : 'invalid'); }
  st.coins = (st.coins || 0) + r.rows[0].coins; return { coins: r.rows[0].coins };
}));
app.post('/api/admin/code', guard(10), w(async (req, res) => {
  if (!process.env.ADMIN_KEY || !sameSig(req.get('x-admin-key'), process.env.ADMIN_KEY)) return res.sendStatus(403);
  const coins = +(req.body || {}).coins, n = Math.min(+(req.body || {}).count || 1, 100);
  if (!(coins > 0 && coins <= 100000)) return res.status(400).json({ error: 'bad_amount' });
  const codes = [];
  for (let i = 0; i < n; i++) { const c = 'FREE-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6); await q('insert into codes(code,coins) values($1,$2)', [c, coins]); codes.push(c); }
  res.json({ codes });
}));

// ===== لوحة المالك: حساب المالك (OWNER_USER) + مفتاح الأدمن (ADMIN_KEY) معاً =====
const ownerOnly = (req, res, next) => (isOwner(req.u) && process.env.ADMIN_KEY && sameSig(req.get('x-admin-key'), process.env.ADMIN_KEY)) ? next() : res.status(403).json({ error: 'forbidden' });
const AMOUNTS = [50, 100, 200, 500, 1000, 2000, 5000];
app.post('/api/owner/code', authm, ownerOnly, guard(30), w(async (req, res) => {
  const coins = +(req.body || {}).coins, n = Math.min(Math.max(+(req.body || {}).count || 1, 1), 50);
  if (!AMOUNTS.includes(coins)) return res.status(400).json({ error: 'bad_amount' });
  const codes = [];
  for (let i = 0; i < n; i++) { const c = 'GIFT-' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6); await q('insert into codes(code,coins,created_by) values($1,$2,$3)', [c, coins, req.u.id]); codes.push(c); }
  res.json({ codes });
}));
app.get('/api/owner/codes', authm, ownerOnly, guard(60), w(async (req, res) => {
  const r = await q('select c.code, c.coins, c.created, u.name as used_name from codes c left join users u on u.id=c.used_by order by c.created desc limit 200');
  res.json({ codes: r.rows });
}));

// ===== الدفع: Chargily (بطاقات جزائرية) + Lemon Squeezy (بطاقات دولية / PayPal) =====
const CK = process.env.CHARGILY_SECRET_KEY, CG_TEST = process.env.CHARGILY_MODE !== 'live';
const LK = process.env.LEMONSQUEEZY_API_KEY, LS_STORE = process.env.LEMONSQUEEZY_STORE_ID, LS_VARIANT = process.env.LEMONSQUEEZY_VARIANT_ID,
  LS_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET, LS_TEST = process.env.LEMONSQUEEZY_TEST_MODE !== '0';
const RATE = +process.env.DZD_PER_USD || 135, BASE = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const have = { cg: !!(CK && BASE), ls: !!(LK && LS_STORE && LS_VARIANT && LS_SECRET && BASE) };
const PRICE = { // الأسعار بالدولار (مصدر الحقيقة هنا في السيرفر)
  coins: { 300: .99, 700: 2.49, 1200: 4.99, 2000: 7.99, 5000: 14.99 },
  offer: { 0: 4.99, 1: 8.99, 2: 12.99 } };
app.get('/api/pay/providers', (_, res) => res.json(have));

app.post('/api/pay/checkout', authm, guard(10), w(async (req, res) => {
  const { kind, item } = req.body || {}; let p = (req.body || {}).provider;
  const usd = PRICE[kind] && PRICE[kind][item];
  if (!usd) return res.status(400).json({ error: 'bad_item' });
  if (!have[p]) p = have.cg ? 'cg' : have.ls ? 'ls' : null;
  if (!p) return res.status(503).json({ error: 'payments_disabled' });
  if (kind === 'offer') { const ob = (req.u.state || {}).ob || []; if (ob.includes(+item) || (+item > 0 && !ob.includes(+item - 1))) return res.status(400).json({ error: 'offer_locked' }); }
  const dzd = Math.max(1, Math.round(usd * RATE)), cents = Math.round(usd * 100);
  const o = await q('insert into orders(user_id,kind,item,amount,provider,usd_cents) values($1,$2,$3,$4,$5,$6) returning id', [req.u.id, kind, +item, dzd, p, cents]);
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

async function deliverOrder(o) { await tx(o.user_id, st => L.deliver(CAT, st, o)); } // يُستدعى مرة وحدة لكل طلب مدفوع

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

const PORT = process.env.PORT || 3000;
init().then(() => app.listen(PORT, () => console.log('listening ' + PORT))).catch(e => { console.error('DB init failed', e); process.exit(1); });
