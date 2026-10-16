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
  create table if not exists used_codes(hash text primary key, user_id int, coins int not null, used_at timestamptz default now());
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
const GIFT = L.loadBatches(path.join(__dirname, 'data', 'batches')); // بصمات أكواد الهدية (من الملفات اللي تحطها في data/batches)
console.log('gift codes loaded:', GIFT.size);
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
  res.json({ token: await newSession(u.id), name: u.name, state: u.state });
}));
app.post('/api/logout', authm, w(async (req, res) => { await q('delete from sessions where token=$1', [(req.headers.authorization || '').slice(7)]); res.json({ ok: 1 }); }));
app.get('/api/me', authm, w(async (req, res) => {
  const st = req.u.state || {}, ks = Object.keys(st.codes || {});
  if (ks.length) { const r = await q('select code from codes where code = any($1) and used_by is not null', [ks]); if (r.rows.length) { const s2 = { ...st, codes: { ...st.codes } }; for (const x of r.rows) delete s2.codes[x.code]; return res.json({ name: req.u.name, state: s2, now: Date.now() }); } }
  res.json({ name: req.u.name, state: st, now: Date.now() });
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
app.post('/api/redeem', ...act(10, async (st, req) => {
  const raw = String((req.body || {}).code || '').trim().toUpperCase();
  const c = L.normCode(raw);
  if (c) {
    const h = await L.hashCode(c), amt = GIFT.get(h);
    if (amt) {
      const r = await q('insert into used_codes(hash,user_id,coins) values($1,$2,$3) on conflict do nothing returning coins', [h, req.u.id, amt]);
      if (!r.rows[0]) throw new L.Bad('used');
      st.coins = (st.coins || 0) + amt; return { coins: amt };
    }
  }
  const key = c || raw;
  const r = await q('update codes set used_by=$1, used_at=now() where code=$2 and used_by is null returning coins', [req.u.id, key]);
  if (!r.rows[0]) { const ex = await q('select 1 from codes where code=$1', [key]); throw new L.Bad(ex.rows[0] ? 'used' : 'invalid'); }
  if (st.codes) delete st.codes[key];
  st.coins = (st.coins || 0) + r.rows[0].coins; return { coins: r.rows[0].coins };
}));

// ===== الدفع: Chargily (بطاقات جزائرية) + Lemon Squeezy (بطاقات دولية / PayPal) =====
const CK = process.env.CHARGILY_SECRET_KEY, CG_TEST = process.env.CHARGILY_MODE !== 'live';
const LK = process.env.LEMONSQUEEZY_API_KEY, LS_STORE = process.env.LEMONSQUEEZY_STORE_ID, LS_VARIANT = process.env.LEMONSQUEEZY_VARIANT_ID,
  LS_SECRET = process.env.LEMONSQUEEZY_WEBHOOK_SECRET, LS_TEST = process.env.LEMONSQUEEZY_TEST_MODE !== '0';
const RATE = +process.env.DZD_PER_USD || 135, BASE = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const have = { cg: !!(CK && BASE), ls: !!(LK && LS_STORE && LS_VARIANT && LS_SECRET && BASE) };
const PRICE = { // الأسعار بالدولار (مصدر الحقيقة هنا في السيرفر)
  coins: { 1500: .99, 3500: 2.49, 6500: 4.99, 9500: 7.99, 15000: 14.99 },
  gift: { 500: .59, 1500: 1.49, 5000: 4.99, 10000: 9.99, 25000: 24.99 }, // بطاقات الهدية (رمز تعطيه لأي أحد)
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

const GA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', newGift = () => { const r = Array.from(crypto.randomBytes(11), x => GA[x & 31]).join(''); return 'GIFT-' + r.slice(0, 4) + '-' + r.slice(4); };
async function deliverOrder(o) {
  if (o.kind === 'gift') { // بطاقة هدية: نصنع كود ونحطه في جدول أكواد اللاعب
    const code = newGift(); await q('insert into codes(code,coins,created_by) values($1,$2,$3)', [code, o.item, o.user_id]);
    await tx(o.user_id, st => { (st.codes = st.codes || {})[code] = o.item; }); return;
  }
  await tx(o.user_id, st => L.deliver(CAT, st, o));
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
const roomFor = () => { let r = ROOMS.find(x => x.peers.size < MAXP); if (!r) { r = { id: ROOMS.length + 1, seed: crypto.randomInt(1, 2147483647), peers: new Map() }; ROOMS.push(r); } return r; };
const FOODS = ['🍔', '🍉', '🍌', '🍇', '🍎'];
const infoOf = p => { const st = p.st || {}; return { id: p.id, name: p.name, flag: st.flag || 'DZ', skin: st.skin | 0, fk: st.fsk || '', lvl: L.lvOf(st.xp), av: String(st.av || '').slice(0, 4), bx: st.bs && Date.now() < st.bs.u ? st.bs.k : 0, x: Math.round(p.x), y: Math.round(p.y), dead: p.dead }; };
const bcast = (room, msg, except) => room.peers.forEach(p => { if (p !== except) p.sock.send(msg); });
function handleSock(sock) {
  let me = null, cnt = 0, t0 = Date.now();
  const timer = setTimeout(() => { if (!me) sock.close(); }, 5000);
  sock.onclose = () => { clearTimeout(timer); if (me) { me.room.peers.delete(me.id); PEERS.delete(me); bcast(me.room, { t: 'leave', id: me.id }); } };
  sock.onmsg = async raw => {
    if (Date.now() - t0 > 1000) { t0 = Date.now(); cnt = 0; } if (++cnt > 80) return sock.close();
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    try {
      if (m.t === 'hello') {
        if (me) return;
        const r = await q("select u.id,u.name,u.state from sessions s join users u on u.id=s.user_id where s.token=$1 and s.created > now() - interval '30 days'", [String(m.token || '')]);
        const u = r.rows[0]; if (!u) return sock.close();
        for (const p of PEERS) if (p.uid === u.id) p.sock.close(); // اتصال واحد لكل حساب
        const room = roomFor();
        me = { id: ++PID, uid: u.id, name: u.name, st: u.state, sock, room, x: 15000, y: 15000, a: 0, g: 0, sc: 0, b: 0, dead: true };
        room.peers.set(me.id, me); PEERS.add(me);
        sock.send({ t: 'welcome', id: me.id, seed: room.seed, peers: [...room.peers.values()].filter(p => p !== me).map(infoOf) });
        bcast(room, { t: 'join', p: infoOf(me) }, me); return;
      }
      if (!me) return;
      if (m.t === 's') { me.x = num(m.x, 0, 30000); me.y = num(m.y, 0, 30000); me.a = num(m.a, -10, 10); me.g = num(m.g, 0, 5000); me.sc = num(m.sc, 0, 1e6); me.b = m.b ? 1 : 0; }
      else if (m.t === 'eat') { const c = num(m.c, 0, 3599) | 0, k = num(m.k, 0, 15) | 0; bcast(me.room, { t: 'eat', c, k }, me); }
      else if (m.t === 'drop' && Array.isArray(m.items)) { const items = m.items.slice(0, 200).filter(i => Array.isArray(i) && FOODS.includes(i[2])).map(i => [num(i[0], 0, 30000), num(i[1], 0, 30000), i[2], num(i[3], 0, 10), num(i[4], 0, 10)]); if (items.length) bcast(me.room, { t: 'drop', items }, me); }
      else if (m.t === 'die') { if (me.dead) return; me.dead = true; bcast(me.room, { t: 'dead', id: me.id }, me); const k = me.room.peers.get(+m.by | 0); if (k && k !== me && !k.dead) k.sock.send({ t: 'kill', x: num(m.x, 0, 30000), y: num(m.y, 0, 30000), name: me.name }); }
      else if (m.t === 'alive') { if (!me.dead) return; const r = await q('select state from users where id=$1', [me.uid]); if (r.rows[0]) me.st = r.rows[0].state; me.dead = false; me.x = num(m.x, 0, 30000) || me.x; me.y = num(m.y, 0, 30000) || me.y; bcast(me.room, { t: 'join', p: infoOf(me) }, me); }
    } catch (e) { console.error('ws', e); }
  };
}
setInterval(() => { for (const room of ROOMS) { if (room.peers.size < 2) continue; const arr = [...room.peers.values()].filter(p => !p.dead).map(p => [p.id, Math.round(p.x), Math.round(p.y), +p.a.toFixed(2), Math.floor(p.g), Math.floor(p.sc), p.b]); bcast(room, { t: 'snap', p: arr }); } }, 100).unref();
setInterval(() => { for (const p of PEERS) { if (!p.sock.alive) p.sock.close(); else { p.sock.alive = false; p.sock.ping(); } } }, 25000).unref();
app.get('/api/online', (_, res) => res.json({ n: PEERS.size }));

const PORT = process.env.PORT || 3000;
init().then(() => server.listen(PORT, () => console.log('listening ' + PORT))).catch(e => { console.error('DB init failed', e); process.exit(1); });
