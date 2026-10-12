// تشغيل: node test.js  (بدون أي مكتبات)
const L = require('./logic'), cat = require('./catalog.json'), assert = require('assert');
const NOW = 1.7e12, fresh = () => ({ coins: 100, xp: 0, best: 0, tot: 0, own: [0] });
const thr = (f, code) => assert.throws(f, e => e instanceof L.Bad && e.message === code);
let n = 0; const t = (name, f) => { f(); n++; console.log('ok -', name); };

t('شراء سكن يخصم السعر ويضيفه', () => { const st = fresh(), i = cat.skins.findIndex((k, j) => k.p > 0 && !k.x && !k.L && L.skinPrice(cat, j, NOW) <= 100 * 99); st.coins = 99999; const p = L.skinPrice(cat, i, NOW); L.buy(cat, st, { kind: 'skin', id: i }, NOW); assert.equal(st.coins, 99999 - p); assert(st.own.includes(i)); });
t('لا يمكن شراء سكن مرتين', () => { const st = fresh(); st.coins = 1e6; L.buy(cat, st, { kind: 'skin', id: 1 }, NOW); thr(() => L.buy(cat, st, { kind: 'skin', id: 1 }, NOW), 'owned'); });
t('رصيد غير كافٍ', () => thr(() => L.buy(cat, fresh(), { kind: 'skin', id: 50 }, NOW), 'no_coins'));
t('سكنات العروض الحصرية لا تُشترى بالعملات', () => { const st = fresh(); st.coins = 1e9; thr(() => L.buy(cat, st, { kind: 'skin', id: 76 }, NOW), 'bad_item'); });
t('شواهد القبور الحصرية لا تُشترى', () => { const st = fresh(); st.coins = 1e9; const x = cat.graves.find(g => g.x); thr(() => L.buy(cat, st, { kind: 'grave', id: x.e }, NOW), 'bad_item'); });
t('تخفيض 15% لـ6 سكنات فقط', () => { const el = cat.skins.map((s, j) => j).filter(j => cat.skins[j].p > 0 && !cat.skins[j].x); let d = 0; for (const j of el) { const base = Math.round(cat.skins[j].p * (cat.skins[j].L ? 2.9 : 1.8) / 10) * 10; if (L.skinPrice(cat, j, NOW) !== base) d++; } assert(d >= 1 && d <= 6, 'discounted=' + d); });
t('علم دولة بـ50 ومرة وحدة', () => { const st = fresh(); L.buy(cat, st, { kind: 'flag', id: 'DZ' }, NOW); assert.equal(st.coins, 50); thr(() => L.buy(cat, st, { kind: 'flag', id: 'DZ' }, NOW), 'owned'); thr(() => L.buy(cat, st, { kind: 'flag', id: 'IL' }, NOW), 'bad_item'); });
t('معزز 24 ساعة ويتمدد', () => { const st = fresh(); st.coins = 500; L.buy(cat, st, { kind: 'booster', id: 0 }, NOW); const u1 = st.bs.u; assert.equal(u1, NOW + L.DAY); L.buy(cat, st, { kind: 'booster', id: 0 }, NOW + 1000); assert.equal(st.bs.u, u1 + L.DAY); });
t('الهدية اليومية مرة كل 24 ساعة', () => { const st = fresh(); L.daily(st, NOW); assert.equal(st.coins, 200); thr(() => L.daily(st, NOW + 1000), 'cooldown'); L.daily(st, NOW + L.DAY + 1); assert.equal(st.coins, 300); });
t('العجلة مرة باليوم والجائزة من القائمة', () => { const st = fresh(), i = L.spin(cat, st, NOW, .5); assert(cat.wp.includes(st.coins - 100)); assert(i >= 0 && i < 6); thr(() => L.spin(cat, st, NOW + 5, .1), 'cooldown'); });
t('نهاية الجولة: سقف النقاط حسب الوقت', () => { const st = fresh(), run = { t0: NOW, paid: 0 }; const r = L.runEnd(st, run, 9999999, NOW + 10000); assert.equal(r.score, 10 * 60 + 500); assert.equal(st.tot, r.score); });
t('نفس الجولة لا تُدفع مرتين', () => { const st = fresh(), run = { t0: NOW, paid: 0 }; L.runEnd(st, run, 400, NOW + 60000); const c = st.coins; const r2 = L.runEnd(st, run, 400, NOW + 61000); assert.equal(st.coins, c); assert.equal(r2.coins, 0); });
t('الإحياء: بالعملات 100 وحد أقصى 3', () => { const st = fresh(), run = { t0: NOW, paid: 0 }; L.runRevive(st, run, false); assert.equal(st.coins, 0); thr(() => L.runRevive(st, run, false), 'no_coins'); L.runRevive(st, run, true); L.runRevive(st, run, true); thr(() => L.runRevive(st, run, true), 'max_revives'); });
t('مكافأة ×2 مرة وحدة لكل موت', () => { const st = fresh(), run = { t0: NOW, paid: 0 }; L.runEnd(st, run, 400, NOW + 60000); const c = st.coins; L.runBonus(st, run); assert(st.coins > c); thr(() => L.runBonus(st, run), 'no_bonus'); });
t('المستوى يصعب وترقية تعطي 50 عملة', () => { assert.equal(L.nd(1), 200); const st = fresh(), run = { t0: 0, paid: 0 }; st.xp = 190; const r = L.runEnd(st, run, 20, 1e6); assert.equal(r.levelUp, 2); assert.equal(r.bonus, 50); });
t('العرض: يسلّم السكنات والعملات والقبور حسب الكتالوج', () => { const st = fresh(); L.deliver(cat, st, { kind: 'offer', item: 1 }); assert(cat.offers[1].sk.every(i => st.own.includes(i))); assert.equal(st.coins, 100 + cat.offers[1].c); assert.deepEqual(st.ob, [1]); });
t('الإعدادات: لا يمكن لبس شي غير مملوك أو تغيير العملات', () => { const st = fresh(); L.prefs(cat, st, { skin: 40, coins: 99999, fsk: 'DZ', gsel: '⚱️', ef: 3, flag: 'FR', av: '😎' }); assert.equal(st.coins, 100); assert.notEqual(st.skin, 40); assert(!st.fsk); assert.notEqual(st.gsel, '⚱️'); assert.notEqual(st.ef, 3); assert.equal(st.flag, 'FR'); });
console.log(n + ' tests passed');
