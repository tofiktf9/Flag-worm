'use strict';
// الزعيم: دودة عملاقة يتحكم فيها السيرفر. يموت بعد 12 ضربة (ضربة = رأسه يلمس جسم لاعب)، ويرجع بعد ساعة.
const WORLD = 30000, MAX_HP = 12, HIT_COOLDOWN = 1200, RESPAWN_MS = +process.env.BOSS_RESPAWN_MS || 3600000;
const REWARD = { final: 1000, xp: 2000, part: 150 };
function fresh(now, rnd = Math.random) {
  return { alive: true, hp: MAX_HP, max: MAX_HP, x: 3000 + rnd() * 24000, y: 3000 + rnd() * 24000, a: rnd() * Math.PI * 2, wa: 0, wu: 0, gr: 160, inv: 0, hitters: new Set(), respawnAt: 0, born: now };
}
function tick(b, peers, now, rnd = Math.random) { // كل 50 ملي ثانية (= 3 فريمات)
  if (!b.alive) return false;
  let tgt = null, best = 1500 * 1500;
  for (const p of peers) { if (p.dead) continue; const d = (p.x - b.x) ** 2 + (p.y - b.y) ** 2; if (d < best) { best = d; tgt = p; } }
  let ta;
  if (tgt) { const lead = Math.min(14, Math.sqrt(best) / 60); ta = Math.atan2(tgt.y + Math.sin(tgt.a) * lead * 7 - b.y, tgt.x + Math.cos(tgt.a) * lead * 7 - b.x); }
  else { if (now > b.wu) { b.wa = rnd() * Math.PI * 2; b.wu = now + 3000 + rnd() * 4000; } ta = b.wa; }
  if (b.x < 1800 || b.x > WORLD - 1800 || b.y < 1800 || b.y > WORLD - 1800) ta = Math.atan2(WORLD / 2 - b.y, WORLD / 2 - b.x);
  const d = ((ta - b.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI, turn = 0.05 * 3;
  b.a += Math.max(-turn, Math.min(turn, d));
  const sp = (tgt ? 2.7 : 2.1) * 3;
  b.x = Math.min(WORLD - 200, Math.max(200, b.x + Math.cos(b.a) * sp)); b.y = Math.min(WORLD - 200, Math.max(200, b.y + Math.sin(b.a) * sp));
  return true;
}
function hit(b, p, now) { // ضربة من لاعب: تنقبل لو الزعيم حي، ما هو في فترة الحماية، واللاعب قريب منه (لا يتجاوز 1600)
  if (!b.alive || now < b.inv) return { ok: false };
  if ((p.x - b.x) ** 2 + (p.y - b.y) ** 2 > 1600 * 1600) return { ok: false };
  if (now - (p.lastBossHit || 0) < 500) return { ok: false };
  p.lastBossHit = now; b.inv = now + HIT_COOLDOWN; b.hp--; b.hitters.add(p.uid);
  if (b.hp <= 0) { b.alive = false; b.respawnAt = now + RESPAWN_MS; return { ok: true, dead: true }; }
  return { ok: true, dead: false };
}
module.exports = { fresh, tick, hit, MAX_HP, RESPAWN_MS, REWARD, HIT_COOLDOWN };
