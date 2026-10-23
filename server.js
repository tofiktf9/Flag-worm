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
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, p) => { if (/\.html$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));

async function init0() {
  await q(`create table if not exists users(
    id serial primary key, name text not null, name_lower text unique not null, email text unique,
    salt text not null, hash text not null, state jsonb not null default '{}', upd bigint not null default 0, created timestamptz default now());
  create table if not exists sessions(token text primary key, user_id int references users(id) on delete cascade, created timestamptz default now());
  create table if not exists orders(id serial primary key, user_id int references users(id), kind text not null, item int not null, amount int not null, status text not null default 'pending', checkout_id text unique, created timestamptz default now(), paid_at timestamptz);
  alter table orders add column if not exists picks text; alter table orders add column if not exists provider text; alter table orders add column if not exists usd_cents int;
  create table if not exists used_codes(hash text primary key, user_id int, coins int not null, used_at timestamptz default now());
  create table if not exists codes(code text primary key, coins int not null, used_by int, used_at timestamptz, created_by int, created timestamptz default now());`);
  await q('create table if not exists weekly(week int not null, user_id int not null, score bigint not null default 0, primary key(week,user_id))');
  await q('create table if not exists weekly_paid(week int not null, user_id int not null, primary key(week,user_id))');
  const first = OWNER ? await q('select id from users where name_lower=$1', [OWNER]) : await q('select id from users order by id limit 1'); OWNER_ID = first.rows[0] ? first.rows[0].id : null;
  await q('alter table users add column if not exists pid int');
  const all = (await q('select id, pid from users order by id')).rows, ow = all.find(u => u.id === OWNER_ID);
  if (all.some(u => u.pid == null) || (ow && ow.pid !== 100001)) { let nx = 100002; for (const u of all) { u.pid = u.id === OWNER_ID ? 100001 : nx++; await q('update users set pid=$1 where id=$2', [u.pid, u.id]); } }
  for (const u of all) { UID2PID.set(u.id, u.pid); PID2UID.set(u.pid, u.id); }
  NEXT_PID = Math.max(100001, ...all.map(u => u.pid || 0)) + 1;
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
const GIFT = L.loadHashes(['/etc/secrets', path.join(__dirname, 'data', 'secret')]);
try { L.addHashModule(GIFT, require('./giftcodes')); } catch (e) { console.error('giftcodes.js غير موجود، ارفعه مع باقي الملفات:', e.message); } // بصمات أكواد الهدية الجاهزة
console.log('gift codes loaded:', GIFT.size);
const VERSION = '2026-10-21.4';
const KMS = +process.env.KING_PAY_MS || 60000, CHEST_T0 = +process.env.CHEST_FIRST_MS || 30000; // (للتجربة فقط: تقصير مدد الملك والصندوق الأول)
const OWNER = (process.env.OWNER_USER || '').trim().toLowerCase(); let OWNER_ID = null; // المالك: الحساب باسم OWNER_USER، وإذا ما حطيته فأول حساب انسجّل في اللعبة
const isOwner = u => !!u && OWNER_ID !== null && u.id === OWNER_ID;
const ownerSync = async u => { if (isOwner(u)) u.state = (await tx(u.id, st => { L.grantAll(CAT, st); })).state; return u; }; // المالك: كل شي مملوك + مميز دائماً
const withOw = (st, u, now) => { const s = { ...st, ow: isOwner(u) ? 1 : 0, pid: pidOf(u.id || 0) }; L.fixVip(CAT, s, now || Date.now()); return s; };
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
app.get('/api/status', (_, res) => res.json({ ok: true, version: VERSION, giftCodes: GIFT.size, boss: true })); // افتحه للتأكد إن قائمة الأكواد انحمّلت (لازم > 0)

app.post('/api/register', guard(10), w(async (req, res) => {
  const { name = '', password = '', email = '' } = req.body || {};
  const n = String(name).trim(), e = String(email).trim().toLowerCase();
  if (!/^[\p{L}\p{N}_ ]{2,12}$/u.test(n) || n.startsWith('__')) return res.status(400).json({ error: 'bad_name' });
  if (String(password).length < 6 || String(password).length > 100) return res.status(400).json({ error: 'bad_password' });
  if (e && (e.length > 100 || !/^\S+@\S+\.\S+$/.test(e))) return res.status(400).json({ error: 'bad_email' });
  const salt = crypto.randomBytes(16).toString('hex');
  try {
    const r = await q('insert into users(name,name_lower,email,salt,hash,state) values($1,$2,$3,$4,$5,$6) returning id', [n, n.toLowerCase(), e || null, salt, await hash(password, salt), DEF()]);
    const nid = r.rows[0].id; if (OWNER_ID === null && (!OWNER || n.toLowerCase() === OWNER)) OWNER_ID = nid;
    { const pv = nid === OWNER_ID ? 100001 : NEXT_PID++; await q('update users set pid=$1 where id=$2', [pv, nid]); UID2PID.set(nid, pv); PID2UID.set(pv, nid); }
    res.json({ token: await newSession(nid), name: n, state: withOw(DEF(), { id: nid, name_lower: n.toLowerCase() }) });
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
  res.json({ token: await newSession(u.id), name: u.name, state: withOw(u.state, u) });
}));
app.post('/api/logout', authm, w(async (req, res) => { await q('delete from sessions where token=$1', [(req.headers.authorization || '').slice(7)]); res.json({ ok: 1 }); }));
app.get('/api/me', authm, w(async (req, res) => {
  await ownerSync(req.u);
  const st = req.u.state || {}, ks = Object.keys(st.codes || {});
  if (ks.length) { const r = await q('select code from codes where code = any($1) and used_by is not null', [ks]); if (r.rows.length) { const s2 = { ...st, codes: { ...st.codes } }; for (const x of r.rows) delete s2.codes[x.code]; return res.json({ name: req.u.name, state: withOw(s2, req.u), now: Date.now() }); } }
  res.json({ name: req.u.name, state: withOw(st, req.u), now: Date.now() });
}));

// ===== الاقتصاد: كله هنا في السيرفر (العميل ما يقدر يعدّل العملات أو المشتريات) =====
app.put('/api/prefs', ...act(30, (st, req) => { L.prefs(CAT, st, req.body || {}); }));
app.post('/api/buy', ...act(30, (st, req) => { L.buy(CAT, st, req.body || {}, Date.now()); }));
app.post('/api/daily', ...act(10, (st, req) => ({ daily: L.daily(st, Date.now(), isOwner(req.u)) }))); // مكافأة الدخول اليومي (تقويم UTC)
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
app.post('/api/run/end', ...act(60, async (st, req) => { LBC.t = 0; const reward = L.runEnd(st, runOf(req), (req.body || {}).score, Date.now(), (req.body || {}).bags);
  if (reward.delta > 0) await q('insert into weekly(week,user_id,score) values($1,$2,$3) on conflict (week,user_id) do update set score = weekly.score + excluded.score', [L.weekOf(Date.now()), req.u.id, reward.delta]); // نقاط الأسبوع (من السيرفر فقط)
  return { reward }; })); // يحدّث المتصدرين فوراً
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

// ===== المواسم: ترتيب أسبوعي (النقاط محسوبة في السيرفر) ومكافآت وألقاب
const wkStart = wk => (wk * 7 - 3) * 864e5;
const rankIn = async (wk, score) => (await q('select count(*)::int as n from weekly where week=$1 and score>$2', [wk, score])).rows[0].n + 1;
app.get('/api/weekly', authm, w(async (req, res) => {
  const now = Date.now(), wk = L.weekOf(now), pw = wk - 1;
  const top = await q('select u.name, w.score from weekly w join users u on u.id=w.user_id where w.week=$1 order by w.score desc limit 20', [wk]);
  const mine = await q('select score from weekly where week=$1 and user_id=$2', [wk, req.u.id]);
  const me = mine.rows[0] ? { score: Number(mine.rows[0].score), rank: await rankIn(wk, mine.rows[0].score) } : { score: 0, rank: null };
  let prev = null; const pm = await q('select score from weekly where week=$1 and user_id=$2', [pw, req.u.id]);
  if (pm.rows[0]) { const rank = await rankIn(pw, pm.rows[0].score), paid = await q('select 1 from weekly_paid where week=$1 and user_id=$2', [pw, req.u.id]); prev = { week: pw, rank, score: Number(pm.rows[0].score), reward: L.seasonReward(rank), claimed: !!paid.rows[0] }; }
  res.json({ week: wk, left: wkStart(wk + 1) - now, rows: top.rows.map(r => ({ name: r.name, score: Number(r.score) })), me, prev, prizes: L.SEASON });
}));
app.post('/api/season/claim', ...act(5, async (st, req) => {
  const pw = L.weekOf(Date.now()) - 1, pm = await q('select score from weekly where week=$1 and user_id=$2', [pw, req.u.id]);
  if (!pm.rows[0]) throw new L.Bad('no_reward');
  const rank = await rankIn(pw, pm.rows[0].score); if (!L.seasonReward(rank)) throw new L.Bad('no_reward');
  const ins = await q('insert into weekly_paid(week,user_id) values($1,$2) on conflict do nothing returning week', [pw, req.u.id]); if (!ins.rows[0]) throw new L.Bad('claimed'); // مرة وحدة فقط
  const r = L.grantSeason(st, rank); return { season: { rank, coins: r.coins, title: r.title } };
}));
// ===== تغيير الاسم: الاسم لازم يكون غير مستخدم (فريد)، ومرة كل 24 ساعة (المالك بدون انتظار)
app.post('/api/rename', authm, guard(6), w(async (req, res) => {
  const n = String((req.body || {}).name || '').trim(), now = Date.now(), st = req.u.state || {};
  if (!/^[\p{L}\p{N}_ ]{2,12}$/u.test(n) || n.startsWith('__')) return res.status(400).json({ error: 'bad_name' });
  if (!isOwner(req.u) && st.rn && now - st.rn < 864e5) return res.status(429).json({ error: 'cooldown', left: st.rn + 864e5 - now });
  try { await q('update users set name=$1,name_lower=$2 where id=$3', [n, n.toLowerCase(), req.u.id]); }
  catch (err) { if (err.code === '23505') return res.status(409).json({ error: 'taken' }); throw err; }
  await tx(req.u.id, s => { s.rn = now; });
  for (const p of PEERS) if (p.uid === req.u.id) { p.name = n; bcast(p.room, { t: 'rename', id: p.id, name: n }); }
  LBC.t = 0; res.json({ name: n });
}));
app.get('/api/boss', (_, res) => { // حالة الزعيم لعدّاد اللوبي (الغرفة اللي يدخلها اللاعب الجديد)
  const r = ROOMS.find(x => x.peers.size < MAXP) || ROOMS[0], now = Date.now(), b = r && r.boss;
  res.json(b ? { alive: b.alive, hp: b.hp, max: b.max, left: b.alive ? 0 : Math.max(0, b.respawnAt - now) } : { alive: true, hp: BOSS.MAX_HP, max: BOSS.MAX_HP, left: 0 });
});
// ===== الأصدقاء + ملف اللاعب (معلومات عامة فقط، بدون عملات أو بيانات دفع)
const frInfo = (by, uid) => { const r = by.get(uid); if (!r) return null; const on = UONLINE.has(uid), s2 = r.state || {}; return { pid: pidOf(uid), name: r.name, on, ls: on ? Date.now() : (s2.ls || 0), av: s2.av || '' }; };
app.get('/api/friends', authm, guard(40), w(async (req, res) => {
  const st = req.u.state || {}, ids = [...new Set([...(st.fr || []), ...(st.fi || [])])]; const by = new Map();
  if (ids.length) for (const r of (await q('select id,name,state from users where id = any($1)', [ids])).rows) by.set(r.id, r);
  res.json({ friends: (st.fr || []).map(u => frInfo(by, u)).filter(Boolean), req: (st.fi || []).map(u => frInfo(by, u)).filter(Boolean) });
}));
app.post('/api/friends/add', authm, guard(12), w(async (req, res) => {
  const tu = uidOf((req.body || {}).pid); if (!(tu > 0)) throw new L.Bad('noid'); if (tu === req.u.id) throw new L.Bad('self');
  const ex = await q('select id,name from users where id=$1', [tu]); if (!ex.rows[0]) throw new L.Bad('noid');
  const a = await tx(req.u.id, st => (st.fi || []).includes(tu) ? (L.frAccept(st, tu), 'accepted') : (st.fr || []).includes(tu) ? 'already' : 'send');
  if (a.out === 'already') throw new L.Bad('already');
  if (a.out === 'accepted') { await tx(tu, s => { L.frAccept(s, req.u.id); }); sendU(tu, { t: 'frok', name: req.u.name }); return res.json({ friend: 'accepted' }); }
  const r = await tx(tu, s => L.frRequest(s, req.u.id)); if (r.out !== 'ok') throw new L.Bad(r.out === 'pending' ? 'pending' : r.out === 'already' ? 'already' : 'full');
  sendU(tu, { t: 'frreq', from: req.u.name, pid: pidOf(req.u.id) }); res.json({ friend: 'sent', name: ex.rows[0].name });
}));
app.post('/api/friends/answer', authm, guard(20), w(async (req, res) => {
  const tu = uidOf((req.body || {}).pid), ok = !!(req.body || {}).ok; if (!(tu > 0)) throw new L.Bad('noid');
  const a = await tx(req.u.id, st => { if (!(st.fi || []).includes(tu)) return 'none'; if (ok) L.frAccept(st, tu); else L.frDecline(st, tu); return 'ok'; });
  if (a.out === 'none') throw new L.Bad('none');
  if (ok) { await tx(tu, s => { L.frAccept(s, req.u.id); }); sendU(tu, { t: 'frok', name: req.u.name }); }
  res.json({ ok: true });
}));
app.post('/api/friends/remove', authm, guard(20), w(async (req, res) => {
  const tu = uidOf((req.body || {}).pid); if (!(tu > 0)) throw new L.Bad('noid');
  await tx(req.u.id, st => { L.frRemove(st, tu); }); await tx(tu, s => { L.frRemove(s, req.u.id); }); res.json({ ok: true });
}));
app.get('/api/profile/:pid', authm, guard(40), w(async (req, res) => {
  const uid = uidOf(req.params.pid); if (!(uid > 0)) throw new L.Bad('noid');
  const r = await q('select id,name,state,created from users where id=$1', [uid]); if (!r.rows[0]) throw new L.Bad('noid');
  const u = r.rows[0], st = u.state || {}, now = Date.now(), on = UONLINE.has(uid), sk = { ...st }; L.fixVip(CAT, sk, now); const S0 = L.statsOf(sk);
  res.json({ pid: pidOf(uid), name: u.name, pic: st.pic || '', av: st.av || '', created: u.created ? new Date(u.created).getTime() : 0, online: on, ls: on ? now : (st.ls || 0),
    lvl: uid === OWNER_ID ? 999 : L.lvOf(st.xp), vip: L.vipActive(st, now), tt: uid === OWNER_ID ? '👑 المالك' : (st.tt || ''), pa: st.pa || '', titles: st.titles || [], skin: sk.skin | 0, flag: st.flag || 'DZ',
    stats: { k: S0.k, w: S0.w, bs: S0.bs, pt: S0.pt, runs: S0.runs, kt: S0.kt, ch: S0.ch, bk: S0.bk }, ach: Object.keys(st.ach || {}).length, streak: st.sk || 0,
    own: st.own || [0], eo: st.eo || [], gown: st.gown || ['🪦'], fown: st.fown || [], ef: st.ef | 0, gsel: st.gsel || '🪦' });
}));
// ===== المالك: يصنع أكواد هدية (تشتغل أونلاين فوراً) ويشوف حالتها
app.post('/api/owner/codes', authm, guard(30), w(async (req, res) => {
  if (!isOwner(req.u)) return res.status(403).json({ error: 'forbidden' });
  const amount = Math.floor(+(req.body || {}).amount), count = Math.floor(+(req.body || {}).count);
  if (!(amount >= 1 && amount <= 1000000) || !(count >= 1 && count <= 200)) return res.status(400).json({ error: 'bad_item' });
  const out = []; let guardN = 0;
  while (out.length < count && guardN++ < count * 5) { const c = newGift(), r = await q('insert into codes(code,coins,created_by) values($1,$2,$3) on conflict do nothing returning code', [c, amount, req.u.id]); if (r.rows[0]) out.push(c); }
  res.json({ codes: out, amount });
}));
app.get('/api/owner/codes', authm, w(async (req, res) => {
  if (!isOwner(req.u)) return res.status(403).json({ error: 'forbidden' });
  const r = await q('select code,coins,used_by from codes where created_by=$1 order by created desc limit 100', [req.u.id]);
  res.json({ rows: r.rows.map(x => ({ code: x.code, coins: x.coins, used: !!x.used_by })), ready: GIFT.size, version: VERSION });
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
  offer: { 0: 2.49, 1: 5.99, 2: 7.49 } };
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
const BOSS = require('./boss');
const ROOMS = [], PEERS = new Set(), MAXP = +process.env.MAXP_ROOM || 40; let PID = 0;
const BOSS_SKIN = Math.max(0, CAT.skins.findIndex(k => k.boss));
const bossInfo = b => ({ id: 0, name: '👹 الزعيم', boss: 1, vip: 0, flag: 'DZ', skin: BOSS_SKIN, fk: '', lvl: 0, av: '', bx: 0, x: Math.round(b.x), y: Math.round(b.y), dead: false, hp: b.hp, max: b.max });
const bossState = (b, now) => ({ t: 'bs', alive: b.alive, hp: b.hp, max: b.max, left: b.alive ? 0 : Math.max(0, b.respawnAt - now) });
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
const roomFor = () => { let r = ROOMS.find(x => x.peers.size < MAXP); if (!r) { r = { id: ROOMS.length + 1, seed: crypto.randomInt(1, 2147483647), peers: new Map(), boss: BOSS.fresh(Date.now()), king: 0, kingAt: 0, rec: { ms: 0, name: '' }, chests: new Map(), nextChest: Date.now() + CHEST_T0, log: [], chat: [] }; ROOMS.push(r); } return r; };
const FOODS = ['🍔', '🍉', '🍌', '🍇', '🍎'];
const infoOf = p => { const st0 = p.st || {}, now = Date.now(), st = { ...st0 }; L.fixVip(CAT, st, now); return { id: p.id, name: p.name, vip: L.vipActive(st, now) ? 1 : 0, flag: st.flag || 'DZ', skin: st.skin | 0, fk: st.fsk || '', lvl: p.owner ? 999 : L.lvOf(st.xp), tt: p.owner ? '👑 المالك' : (st.tt && (st.titles || []).includes(st.tt) ? st.tt : ''), pid: pidOf(p.uid), gs: st.gsel || '🪦', cc: L.vipActive(st, now) && st.cc && st.cc[st.skin | 0] ? st.cc[st.skin | 0] : null, av: String(st.av || '').slice(0, 4), bx: st.bs && Date.now() < st.bs.u ? st.bs.k : 0, x: Math.round(p.x), y: Math.round(p.y), dead: p.dead }; };
const bcast = (room, msg, except) => room.peers.forEach(p => { if (p !== except) p.sock.send(msg); });
// ===== معرّف الحساب (ID = 100000 + رقم الحساب) + الدردشة + الفريق (Party) + الإيموجي
let NEXT_PID = 100002; const PIDB = 100000, UID2PID = new Map(), PID2UID = new Map(), pidOf = uid => UID2PID.get(uid) || (PIDB + uid), uidOf = pid => PID2UID.get(Math.floor(+pid)) || 0, UONLINE = new Map(), PARTIES = new Map(), UPARTY = new Map(); let PTID = 0;
const EMO = L.EMOJIS, expandEmo = s => s.replace(/:(\d{1,3}):/g, (m, n) => EMO[+n - 1] || m);
const sendU = (uid, o) => { const p = UONLINE.get(uid); if (p) p.sock.send(o); return !!p; };
const partyView = pt => ({ id: pt.id, leader: pidOf(pt.leader), members: pt.members.map(uid => { const o = UONLINE.get(uid); return { pid: pidOf(uid), name: o ? o.name : (pt.names.get(uid) || '؟'), on: !!o }; }) });
const partyPush = pt => { const v = { t: 'party', st: partyView(pt) }; for (const uid of pt.members) sendU(uid, v); };
function partyLeave(uid) { const id = UPARTY.get(uid); if (!id) return; const pt = PARTIES.get(id); UPARTY.delete(uid); sendU(uid, { t: 'party', st: null }); if (!pt) return; pt.members = pt.members.filter(x => x !== uid); if (!pt.members.length) { PARTIES.delete(id); return; } if (pt.leader === uid) pt.leader = pt.members[0]; partyPush(pt); }
function roomForUser(uid) { const id = UPARTY.get(uid), pt = id && PARTIES.get(id); if (pt) for (const mu of pt.members) { const o = UONLINE.get(mu); if (o && mu !== uid && o.room.peers.size < MAXP) return o.room; } return roomFor(); } // الفريق يلتقي في نفس الساحة
function chatOK(me, now) { me.ct = (me.ct || []).filter(t => now - t < 10000); if (me.ct.length >= 8 || now - (me.lastChat || 0) < 600) return false; me.ct.push(now); me.lastChat = now; return true; }
function partyAction(me, m) {
  const now = Date.now(), err = e => me.sock.send({ t: 'perr', e }), a = m.a, id0 = UPARTY.get(me.uid), pt = id0 && PARTIES.get(id0);
  if (a === 'create') { if (pt) return err('inparty'); const p = { id: ++PTID, leader: me.uid, members: [me.uid], names: new Map([[me.uid, me.name]]), inv: new Map() }; PARTIES.set(p.id, p); UPARTY.set(me.uid, p.id); partyPush(p); }
  else if (a === 'invite') { if (!pt) return err('noparty'); if (pt.leader !== me.uid) return err('notleader'); const tu = uidOf(m.pid); if (!(tu > 0)) return err('noid'); if (tu === me.uid) return err('self'); const o = UONLINE.get(tu); if (!o) return err('offline'); if (UPARTY.has(tu)) return err('busy'); if (pt.members.length >= 5) return err('full'); pt.inv.set(tu, now + 60000); o.sock.send({ t: 'pinvite', id: pt.id, from: me.name, fromPid: pidOf(me.uid) }); me.sock.send({ t: 'pinfo', e: 'sent', name: o.name }); }
  else if (a === 'accept') { const p = PARTIES.get(+m.id); if (!p || (p.inv.get(me.uid) || 0) < now) return err('expired'); if (pt) return err('inparty'); if (p.members.length >= 5) return err('full'); p.inv.delete(me.uid); p.members.push(me.uid); p.names.set(me.uid, me.name); UPARTY.set(me.uid, p.id); partyPush(p); me.sock.send({ t: 'regroup' }); }
  else if (a === 'decline') { const p = PARTIES.get(+m.id); if (p && p.inv.delete(me.uid)) sendU(p.leader, { t: 'pinfo', e: 'declined', name: me.name }); }
  else if (a === 'leave') partyLeave(me.uid);
  else if (a === 'kick') { if (!pt || pt.leader !== me.uid) return err('notleader'); const tu = uidOf(m.pid); if (tu === me.uid || !pt.members.includes(tu)) return err('noid'); partyLeave(tu); }
}
let CID = 0;
const ev = (room, o) => { const e = { t: 'ev', at: Date.now(), ...o }; room.log.push(e); if (room.log.length > 12) room.log.shift(); bcast(room, e); }; // سجل أحداث الساحة
function endReign(room, now) { const k = room.peers.get(room.king), ms = now - room.kingAt; if (k && ms > room.rec.ms && ms >= 120000) { room.rec = { ms, name: k.name }; ev(room, { k: 'record', a: k.name, m: Math.floor(ms / 60000) }); } }
function setKing(room, p, now) { room.king = p.id; room.kingAt = now; p.kAcc = 0; p.kReign = 0; p.kBonus = false; bcast(room, { t: 'king', id: p.id, name: p.name }); ev(room, { k: 'king', a: p.name }); }
function kingTick(room, now) { // ملك الساحة: أعلى نقاط (مسقوفة بالوقت من السيرفر) بشرط 300 نقطة، ويتغير لو تفوّق عليه لاعب بـ5%
  const live = [...room.peers.values()].filter(p => !p.dead && p.aliveAt);
  for (const p of live) p.ks = Math.min(p.sc | 0, Math.floor((now - p.aliveAt) / 1000 * 35) + 100);
  let best = null; for (const p of live) if (p.ks >= 300 && (!best || p.ks > best.ks)) best = p;
  const cur = room.king ? room.peers.get(room.king) : null, ok = cur && !cur.dead;
  if (room.king && !ok) { endReign(room, now); room.king = 0; bcast(room, { t: 'king', id: 0 }); }
  if (!room.king) { if (best) setKing(room, best, now); }
  else if (best && best.id !== room.king && best.ks > cur.ks * 1.05 + 20) { endReign(room, now); setKing(room, best, now); }
  const k = room.king ? room.peers.get(room.king) : null; if (!k) return;
  k.kingRunMs = (k.kingRunMs || 0) + 1000; k.kAcc = (k.kAcc || 0) + 1000;
  if (k.kAcc >= KMS) { k.kAcc -= KMS; k.kReign += KMS; const bonus = !k.kBonus && k.kReign >= KMS * 5; if (bonus) k.kBonus = true;
    tx(k.uid, st => { const a = L.kingPay(st, now, false), b = bonus ? L.kingPay(st, now, true) : 0; return { a, b, ach: L.checkAch(st, now) }; }).then(r => { k.sock.send({ t: 'kingpay', coins: r.out.a + r.out.b }); if (r.out.ach.length) k.sock.send({ t: 'ach', ids: r.out.ach }); }).catch(e => console.error('king', e)); }
}
function chestTick(room, now) {
  for (const [id, c] of room.chests) if (now > c.exp) { room.chests.delete(id); bcast(room, { t: 'chestgone', id }); }
  if (!room.peers.size || now < room.nextChest || room.chests.size >= 2) return;
  const c = { id: ++CID, x: Math.round(2500 + Math.random() * 15000), y: Math.round(2500 + Math.random() * 15000), kind: Math.random() < .3 ? 'cosmetic' : 'coins', amount: 80 + 40 * crypto.randomInt(0, 5), exp: now + 240000 };
  room.chests.set(c.id, c); room.nextChest = now + 90000 + Math.random() * 60000;
  bcast(room, { t: 'chest', id: c.id, x: c.x, y: c.y, kind: c.kind, left: 240000 }); ev(room, { k: 'chestnew' });
}
function handleSock(sock) {
  let me = null, cnt = 0, t0 = Date.now();
  const timer = setTimeout(() => { if (!me) sock.close(); }, 5000);
  sock.onclose = () => { clearTimeout(timer); if (me) { const now = Date.now(); if (me.room.king === me.id) { endReign(me.room, now); me.room.king = 0; bcast(me.room, { t: 'king', id: 0 }); } tx(me.uid, st => { st.ls = now; if (!me.dead && (me.kingRunMs || 0) >= KMS) { L.statsOf(st).w++; L.checkAch(st, now); } }).catch(() => {}); me.room.peers.delete(me.id); PEERS.delete(me); if (UONLINE.get(me.uid) === me) { UONLINE.delete(me.uid); const pid0 = UPARTY.get(me.uid), pt0 = pid0 && PARTIES.get(pid0); if (pt0) { partyPush(pt0); const tm = setTimeout(() => { if (pt0.members.every(u => !UONLINE.has(u))) { for (const u of pt0.members) UPARTY.delete(u); PARTIES.delete(pt0.id); } }, 300000); if (tm.unref) tm.unref(); } } bcast(me.room, { t: 'leave', id: me.id }); } };
  sock.onmsg = async raw => {
    if (Date.now() - t0 > 1000) { t0 = Date.now(); cnt = 0; } if (++cnt > 80) return sock.close();
    let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!m || typeof m !== 'object') return;
    try {
      if (m.t === 'hello') {
        if (me) return;
        const r = await q("select u.id,u.name,u.name_lower,u.state from sessions s join users u on u.id=s.user_id where s.token=$1 and s.created > now() - interval '30 days'", [String(m.token || '')]);
        const u = r.rows[0]; if (!u) return sock.close();
        await ownerSync(u);
        for (const p of PEERS) if (p.uid === u.id) p.sock.close(); // اتصال واحد لكل حساب
        const room = roomForUser(u.id);
        me = { id: ++PID, uid: u.id, name: u.name, owner: isOwner(u), st: u.state, sock, room, x: 10000, y: 10000, a: 0, g: 0, sc: 0, b: 0, dead: true };
        room.peers.set(me.id, me); PEERS.add(me); UONLINE.set(u.id, me); { const pid0 = UPARTY.get(u.id), pt0 = pid0 && PARTIES.get(pid0); if (pt0) partyPush(pt0); sock.send({ t: 'chatlog', list: room.chat.slice(-20) }); }
        sock.send({ t: 'welcome', id: me.id, seed: room.seed, peers: [...room.peers.values()].filter(p => p !== me).map(infoOf).concat(room.boss.alive ? [bossInfo(room.boss)] : []) });
        sock.send(bossState(room.boss, Date.now()));
        { const n = Date.now(); for (const c of room.chests.values()) sock.send({ t: 'chest', id: c.id, x: c.x, y: c.y, kind: c.kind, left: c.exp - n }); const kp = room.king && room.peers.get(room.king); if (kp) sock.send({ t: 'king', id: kp.id, name: kp.name }); sock.send({ t: 'evlog', list: room.log.slice(-8) }); }
        bcast(room, { t: 'join', p: infoOf(me) }, me); return;
      }
      if (!me) return;
      if (m.t === 's') { me.x = num(m.x, 0, 20000); me.y = num(m.y, 0, 20000); me.a = num(m.a, -10, 10); me.g = num(m.g, 0, 5000); me.sc = num(m.sc, 0, 1e6); me.b = m.b ? 1 : 0; }
      else if (m.t === 'eat') { const c = num(m.c, 0, 3599) | 0, k = num(m.k, 0, 15) | 0; bcast(me.room, { t: 'eat', c, k }, me); }
      else if (m.t === 'drop' && Array.isArray(m.items)) { const items = m.items.slice(0, 200).filter(i => Array.isArray(i) && FOODS.includes(i[2])).map(i => [num(i[0], 0, 20000), num(i[1], 0, 20000), i[2], num(i[3], 0, 10), num(i[4], 0, 10)]); if (items.length) bcast(me.room, { t: 'drop', items }, me); }
      else if (m.t === 'die') {
        if (me.dead) return; me.dead = true; const now = Date.now(), room = me.room, vx = num(m.x, 0, 20000), vy = num(m.y, 0, 20000);
        bcast(room, { t: 'dead', id: me.id }, me);
        if (room.king === me.id) { endReign(room, now); room.king = 0; bcast(room, { t: 'king', id: 0 }); }
        let byName = '', gs = '🪦'; const k = room.peers.get(+m.by | 0), b0 = room.boss;
        if (k && k !== me && !k.dead) {
          byName = k.name; gs = infoOf(k).gs; k.sock.send({ t: 'kill', x: vx, y: vy, name: me.name });
          k.kt = (k.kt || []).filter(t => now - t < 60000); const kv = k.kv || (k.kv = new Map()), near = (k.x - vx) ** 2 + (k.y - vy) ** 2 < 1200 * 1200;
          if (near && k.kt.length < 10 && now - (kv.get(me.uid) || 0) > 30000) { k.kt.push(now); kv.set(me.uid, now); // قتلة موثّقة: قريب، وبحد 10 بالدقيقة، ومو نفس الضحية خلال 30 ثانية
            tx(k.uid, st => { L.statsOf(st).k++; return { a: L.checkAch(st, now) }; }).then(r => { if (r.out.a.length) k.sock.send({ t: 'ach', ids: r.out.a }); }).catch(() => {}); }
        } else if (+m.by === 0 && b0.alive && Math.hypot(vx - b0.x, vy - b0.y) < 1800) byName = '👹 الزعيم';
        ev(room, { k: 'kill', a: byName, b: me.name, x: vx, y: vy, gs });
        const won = (me.kingRunMs || 0) >= KMS; me.sl = false; me.kingRunMs = 0;
        tx(me.uid, st => { const s = L.statsOf(st); s.d++; if (won) s.w++; return { a: L.checkAch(st, now) }; }).then(r => { if (r.out.a.length) me.sock.send({ t: 'ach', ids: r.out.a }); }).catch(() => {});
      }
      else if (m.t === 'chest') { // التقاط صندوق نادر: لازم يكون قريب منه، والأول يفوز
        const now = Date.now(), room = me.room, c = room.chests.get(+m.id | 0); if (me.dead || !c || now - (me.lastChest || 0) < 500) return; me.lastChest = now;
        if ((me.x - c.x) ** 2 + (me.y - c.y) ** 2 > 320 * 320) return;
        room.chests.delete(c.id); bcast(room, { t: 'chestgone', id: c.id });
        tx(me.uid, st => { const g = L.chestGrant(CAT, st, c.kind, c.amount, Math.random()); return { g, a: L.checkAch(st, now) }; }).then(r => { me.sock.send({ t: 'chestreward', ...r.out.g }); if (r.out.a.length) me.sock.send({ t: 'ach', ids: r.out.a }); ev(room, { k: 'chest', a: me.name, w: r.out.g.item ? 'شاهد قبر حصري ' + r.out.g.item : r.out.g.coins + ' 🪙' }); }).catch(e => console.error('chest', e));
      }
      else if (m.t === 'chat') {
        const now = Date.now(); if (!chatOK(me, now)) return me.sock.send({ t: 'chaterr', e: 'slow' });
        const text = expandEmo(String(m.text || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 140)); if (!text) return;
        const out = { t: 'chat', s: m.s, from: me.name, pid: pidOf(me.uid), text, at: now };
        if (m.s === 'room') { me.room.chat.push(out); if (me.room.chat.length > 30) me.room.chat.shift(); bcast(me.room, out); }
        else if (m.s === 'party') { const pt = PARTIES.get(UPARTY.get(me.uid)); if (!pt) return me.sock.send({ t: 'chaterr', e: 'noparty' }); for (const u of pt.members) sendU(u, out); }
        else if (m.s === 'dm') { const to = uidOf(m.to), o = UONLINE.get(to); if (!(to > 0) || !o) return me.sock.send({ t: 'chaterr', e: 'offline' }); if (o === me) return me.sock.send({ t: 'chaterr', e: 'self' }); o.sock.send(out); me.sock.send({ ...out, to: o.name, toPid: pidOf(to), mine: 1 }); }
      }
      else if (m.t === 'emote') { const n = Math.floor(+m.n), now = Date.now(); if (!(n >= 1 && n <= EMO.length) || now - (me.lastEmo || 0) < 1000) return; me.lastEmo = now; bcast(me.room, { t: 'emote', id: me.id, n }); }
      else if (m.t === 'party') partyAction(me, m);
      else if (m.t === 'skin') { // تغيير السكن أثناء اللعب (من الخزانة): نقرأ الحالة المحفوظة ونبثها
        const now = Date.now(); if (now - (me.lastSkin || 0) < 400) return; me.lastSkin = now;
        const r = await q('select state from users where id=$1', [me.uid]); if (!r.rows[0]) return; me.st = r.rows[0].state; const i = infoOf(me);
        bcast(me.room, { t: 'skin', id: me.id, skin: i.skin, fk: i.fk, cc: i.cc, tt: i.tt, gs: i.gs });
      }
      else if (m.t === 'bhit') { // ضربة على الزعيم (رأسه لمس جسم اللاعب)
        const room = me.room, b = room.boss, now = Date.now(); if (me.dead) return;
        const r = BOSS.hit(b, me, now); if (!r.ok) return;
        if (!r.dead) { bcast(room, { t: 'bhit', hp: b.hp, max: b.max, by: me.id }); return; }
        bcast(room, { t: 'bdead', x: Math.round(b.x), y: Math.round(b.y), by: me.id, name: me.name, left: BOSS.RESPAWN_MS });
        bcast(room, { t: 'leave', id: 0 }); bcast(room, bossState(b, now));
        me.sl = true; ev(room, { k: 'boss', a: me.name });
        for (const p of room.peers.values()) {
          if (!b.hitters.has(p.uid)) continue;
          const fin = p === me, coins = fin ? BOSS.REWARD.final : BOSS.REWARD.part, xp = fin ? BOSS.REWARD.xp : 0;
          tx(p.uid, st => { st.coins = (st.coins || 0) + coins; st.xp = (st.xp || 0) + xp; if (fin) L.statsOf(st).bk++; return { a: L.checkAch(st, now) }; }).then(r => { p.sock.send({ t: 'breward', coins, xp, final: fin }); if (r.out.a.length) p.sock.send({ t: 'ach', ids: r.out.a }); }).catch(e => console.error('boss reward', e));
          if (fin) q('insert into weekly(week,user_id,score) values($1,$2,$3) on conflict (week,user_id) do update set score = weekly.score + excluded.score', [L.weekOf(now), p.uid, 500]).catch(() => {});
        }
      }
      else if (m.t === 'alive') { if (!me.dead) return; const r = await q('select state from users where id=$1', [me.uid]); if (r.rows[0]) me.st = r.rows[0].state; me.dead = false; me.aliveAt = Date.now(); me.sc = 0; me.kingRunMs = 0; me.kAcc = 0; me.sl = false; me.x = num(m.x, 0, 20000) || me.x; me.y = num(m.y, 0, 20000) || me.y; bcast(me.room, { t: 'join', p: infoOf(me) }, me); }
    } catch (e) { console.error('ws', e); }
  };
}
let TICKN = 0;
setInterval(() => {
  const now = Date.now(); TICKN++;
  for (const room of ROOMS) {
    let b = room.boss;
    if (!b.alive && now >= b.respawnAt) { b = room.boss = BOSS.fresh(now); if (room.peers.size) { bcast(room, { t: 'join', p: bossInfo(b) }); bcast(room, bossState(b, now)); } continue; } // رجع الزعيم بعد ساعة
    if (!room.peers.size) continue;
    if (TICKN % 20 === 0) { kingTick(room, now); chestTick(room, now); }
    if (b.alive) BOSS.tick(b, [...room.peers.values()], now);
    if (TICKN % 100 === 0) bcast(room, bossState(b, now)); // مزامنة كل 5 ثواني
    const live = [...room.peers.values()].filter(p => !p.dead);
    if (live.length < 2 && !b.alive) continue;
    const arr = live.map(p => [p.id, Math.round(p.x), Math.round(p.y), +p.a.toFixed(2), Math.floor(p.g), Math.floor(p.sc), p.b, p.sl ? 1 : 0]);
    if (b.alive) arr.push([0, Math.round(b.x), Math.round(b.y), +b.a.toFixed(2), b.gr, 0, 0]);
    bcast(room, { t: 'snap', p: arr });
  }
}, 50).unref(); // 20 تحديث بالثانية
setInterval(() => { for (const p of PEERS) { if (!p.sock.alive) p.sock.close(); else { p.sock.alive = false; p.sock.ping(); } } }, 25000).unref();
app.get('/api/online', (_, res) => res.json({ n: PEERS.size }));

const PORT = process.env.PORT || 3000;
init().then(() => server.listen(PORT, () => console.log('listening ' + PORT))).catch(e => { console.error('DB init failed', e); process.exit(1); });
