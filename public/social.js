// ===== الزعيم + الدردشة (عام / بارتي / خاص بالـID) + البارتي + الإيموجيات =====
// يشتغل فوق index.html ويستعمل متغيراته (G, S, WS, RM, TOKEN, wsSend, api, toast, esc, em, spr, FD, PX, W, c ...)
const EMJ = ['😀','😂','🤣','😍','😎','🥳','😭','😡','😱','🤔','😴','🤯','👍','👎','👏','🙏','💪','🔥','💯','❤️','💔','👑','💀','👻','🤡','🐍','🎉','⚔️','🛡️','🏃','🆘','👋','🤝','✌️','👀','🍔','💎','⭐','👹','🏆']; // نفس EMOJIS في logic.js
const EMD = ['👋','😂','👍','🔥','😡','🆘','🤝','👹','🏆']; // الترتيب الأصلي للأرقام 1-9
const BZ = { x: 15000, y: 15000, a: 1800, r: 34, len: 160, sp: 9 }; // نفس قيم BOSS في server.js
let MYWS = 0, MYID = 0, WSP = null;
const B = { al: 0, hp: 0, max: 0, until: 0, seg: null, x: 0, y: 0, a: 0, tx: 0, ty: 0, ta: 0, vx: 0, vy: 0, ts: 0, lh: 0, fx: [] };
const CH = { open: 0, tab: 'g', g: [], p: [], dm: {}, thr: [], cur: null, ug: 0, up: 0, ud: 0, sel: 0, who: null };
const PT = { id: 0, lead: 0, m: [] }, PPOS = {}, INVS = [], EMOB = {};
TM.pt = '🤝';
const typing = e => { const t = e.target; return !!t && (t.tagName == 'INPUT' || t.tagName == 'TEXTAREA'); };
const emoList = () => (Array.isArray(S.emo) && S.emo.length == 9 ? S.emo : EMD);
const ptHas = uid => !!PT.id && uid !== MYID && PT.m.some(x => x.uid === uid);
const tm = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const bossLeft = () => mmss(B.until - Date.now());

// ---------- الواجهة (تنضاف للصفحة) ----------
(function () {
  const st = document.createElement('style');
  st.textContent = `
#bossH{position:absolute;top:calc(10px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);background:rgba(0,0,0,.55);color:#fff;padding:6px 14px;border-radius:14px;font-weight:800;font-size:14px;pointer-events:none;white-space:nowrap;border:2px solid #3ddc84;display:none}
#bossH.dead{border-color:#ff4d6d}
#emb{position:absolute;top:calc(50px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);display:flex;gap:3px;direction:ltr}
#emb button,.eslots button{position:relative;width:34px;height:34px;padding:0;font-size:19px;background:rgba(0,0,0,.4)}
#emb i,.eslots i{position:absolute;top:0;left:3px;font-size:10px;font-style:normal;color:#ffd60a;font-weight:800}
#chbtn{position:absolute;right:14px;bottom:calc(250px + env(safe-area-inset-bottom,0px));width:54px;height:54px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:24px}
.bd{position:absolute;top:-4px;right:-4px;min-width:18px;height:18px;border-radius:9px;background:#ff4d6d;color:#fff;font-size:11px;font-style:normal;font-weight:800;display:none;align-items:center;justify-content:center;padding:0 4px;box-sizing:border-box}
#chtop{position:relative;border:0;color:inherit;font-size:16px}
#chlog{position:absolute;left:12px;bottom:calc(240px + env(safe-area-inset-bottom,0px));max-width:min(330px,62vw);pointer-events:none;color:#fff;font-size:14px;display:flex;flex-direction:column;gap:4px}
#chlog div{background:rgba(0,0,0,.5);padding:4px 10px;border-radius:10px;transition:opacity .6s}#chlog b{color:#ffd60a}#chlog .p b{color:#4cc9f0}
#chat{position:fixed;top:0;bottom:0;inset-inline-end:0;width:min(400px,100vw);z-index:7;background:var(--card);color:var(--ink);display:none;flex-direction:column;box-shadow:0 0 30px rgba(0,0,0,.5);font-family:Tajawal,Tahoma,sans-serif}
#chat .hd{display:flex;align-items:center;gap:8px;padding:12px 12px 6px}#chat .hd b{flex:1;font-size:18px}
#chat .hd button{background:var(--bg);padding:6px 10px;font-weight:800}
#chtabs{display:flex;gap:4px;padding:0 10px 8px}#chtabs button{flex:1;position:relative;padding:8px 2px;background:transparent;color:var(--mut);font-weight:800;font-size:14px}#chtabs button.on{background:var(--bg);color:var(--ac)}
#chb2{flex:1;overflow:auto;padding:0 10px;display:flex;flex-direction:column}
#chat .msgs{flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;padding:6px 0}
.cm{background:var(--bg);padding:7px 10px;border-radius:12px;word-break:break-word;font-size:15px}.cm i{float:left;font-size:11px;color:var(--mut);font-style:normal}
.cm.me{align-self:flex-end;background:rgba(46,196,182,.25)}.cm:not(.me){align-self:stretch}
.cu{cursor:pointer;color:var(--ac)}.cid{font-size:12px;color:var(--mut);direction:ltr;display:inline-block}
.emp{color:var(--mut);text-align:center;padding:18px 6px;font-size:14px;line-height:1.7}
.chw{display:flex;flex-wrap:wrap;align-items:center;gap:6px;background:var(--bg);border-radius:12px;padding:8px;margin:4px 0}.chw button,.chx{padding:6px 10px;font-weight:800;background:var(--ac);color:#14213d;font-size:13px}
.chw.inv{border:2px solid var(--ok)}.chx{display:block;width:100%;margin:8px 0;background:var(--bg);color:var(--ink)}
.chw input,#chbar input{font-size:15px;padding:8px;border-radius:10px}
.ptm .row{background:var(--bg);margin:4px 0;font-size:14px;flex-wrap:wrap}.ptm .row b{flex:1}
.thr{cursor:pointer;background:var(--bg);margin:4px 0}.thr small{display:block;color:var(--mut);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
.thr .n{background:#ff4d6d;color:#fff;border-radius:9px;padding:0 7px;font-size:12px}
#chbar{padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px));border-top:1px solid rgba(255,255,255,.08)}
#chem{display:flex;gap:2px;overflow-x:auto;padding-bottom:6px;direction:ltr}#chem button{position:relative;flex:0 0 auto;width:34px;height:34px;padding:0;font-size:19px;background:transparent}#chem i{position:absolute;top:0;left:2px;font-size:9px;font-style:normal;color:var(--ac);font-weight:800}
#chem .sep{flex:0 0 1px;background:var(--mut);opacity:.4;margin:4px}
#chbar form{display:flex;gap:6px}#chbar form button{padding:0 16px;background:var(--ok);color:#06231f;font-weight:800}
.eslots{display:grid;grid-template-columns:repeat(9,1fr);gap:4px;direction:ltr;margin:10px 0}.eslots button{width:auto;height:44px;font-size:22px;background:var(--bg)}.eslots button.on{outline:3px solid var(--ac)}
.egrid{display:grid;grid-template-columns:repeat(8,1fr);gap:4px;direction:ltr}.egrid button{height:40px;font-size:22px;background:var(--bg);padding:0}.egrid button.on{background:rgba(252,163,17,.35)}
#inv{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10;background:var(--card);color:var(--ink);border:2px solid var(--ok);border-radius:16px;padding:10px 14px;display:none;gap:8px;align-items:center;box-shadow:0 8px 30px rgba(0,0,0,.5);font-weight:800;max-width:94vw;flex-wrap:wrap;justify-content:center}
#inv button{padding:6px 12px;font-weight:800;background:var(--ok);color:#06231f}#inv button.no{background:var(--bg);color:var(--ink)}
#bossL{border:2px solid #3ddc84}#bossL.dead{border-color:#ff4d6d}#bossL .t{font-size:30px;font-weight:900;color:#ffd60a;direction:ltr;display:inline-block}
#myid{font-size:13px;color:var(--ok);cursor:pointer;margin-top:2px}`;
  document.head.appendChild(st);
  const g = $('#g');
  g.insertAdjacentHTML('beforeend', '<div id="bossH"></div><div id="emb"></div><div id="chlog"></div><button id="chbtn" onclick="chOpen()" aria-label="الدردشة">💬<i class="bd"></i></button>');
  document.body.insertAdjacentHTML('beforeend', `<div id="chat" role="dialog" aria-label="الدردشة"><div class="hd"><b>💬 الدردشة</b><span class="cid" title="معرّف حسابك">ID: <b id="chid" style="font-size:14px;color:var(--ok)">...</b></span><button onclick="idCopy()">📋</button><button onclick="chClose()" aria-label="إغلاق">✕</button></div>
<div id="chtabs"><button data-t="g" onclick="chTab('g')">🌍 عام<i class="bd"></i></button><button data-t="p" onclick="chTab('p')">🤝 البارتي<i class="bd"></i></button><button data-t="d" onclick="chTab('d')">✉️ خاص<i class="bd"></i></button><button data-t="e" onclick="chTab('e')">😀 ترتيب</button></div>
<div id="chb2"></div><div id="chbar"><div id="chem"></div><form onsubmit="chSend();return false"><input id="chi" maxlength="200" autocomplete="off" placeholder="اكتب رسالتك..." onkeydown="if(event.key=='Escape')chClose()"><button>إرسال</button></form></div></div>
<div id="inv"></div>`);
  const tb = document.createElement('button'); tb.className = 'pill'; tb.id = 'chtop'; tb.setAttribute('aria-label', 'الدردشة'); tb.innerHTML = '💬<i class="bd"></i>'; tb.onclick = () => chOpen();
  $('#top').insertBefore(tb, $('#top button.pill'));
  const bl = document.createElement('div'); bl.className = 'card'; bl.id = 'bossL'; bl.innerHTML = '👹 الزعيم: جاري الاتصال...'; $('#play').before(bl);
  $('#ac').insertAdjacentHTML('afterend', '<div id="myid" onclick="idCopy()"></div>');
  $('#chat').addEventListener('click', e => { const b = e.target.closest('.cu'); if (!b) return; const u = +b.dataset.u; if (u && u !== MYID) { CH.who = { uid: u, name: b.dataset.n }; chR(); } });
  $('#chi').addEventListener('keydown', e => e.stopPropagation());
})();

// ---------- الاتصال (WebSocket) مع إعادة الاتصال التلقائي ----------
wsConnect = function () {
  if (WS && WS.readyState == 1 && MYWS) return Promise.resolve(true);
  if (WSP) return WSP;
  WSP = new Promise(res => {
    let done = false, ws; const fin = v => { if (!done) { done = true; WSP = null; res(v); } };
    try { ws = WS = new WebSocket((location.protocol == 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch (e) { WSP = null; return res(false); }
    setTimeout(() => fin(false), 4000);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: TOKEN }));
    ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (e) { return; } wsMsg(m, fin); };
    ws.onclose = () => { if (WS !== ws) return; for (const k in RM) delete RM[k]; WS = null; MYWS = 0; fin(false); bossUi(); if (TOKEN) setTimeout(() => { if (TOKEN && !WS) wsConnect(); }, 3000); };
    ws.onerror = () => {};
  });
  return WSP;
};
const _wsMsg = wsMsg; wsMsg = function (m, fin) { try { socMsg(m); } catch (e) { console.error(e); } _wsMsg(m, fin); };
const _addPeer = addPeer; addPeer = function (p) { _addPeer(p); const r = RM[p.id]; if (r) { r.uid = p.u | 0; if (ptHas(r.uid)) r.team = 'pt'; } };
const _startS = startS; startS = function (n, st, own) { _startS(n, st, own); socBoot(); };
const _logout = logout; logout = function () { PT.id = 0; PT.m = []; INVS.length = 0; CH.g = []; CH.p = []; CH.dm = {}; CH.thr = []; CH.cur = null; CH.ug = CH.up = CH.ud = 0; MYID = 0; chClose(); invHide(); idUi(); _logout(); };
const _play1 = play1; play1 = function (m) { _play1(m); if (G && G.me && G.R && PT.id) G.me.team = 'pt'; emoBar(); };
function socBoot() { if (!Array.isArray(S.emo) || S.emo.length != 9) S.emo = EMD.slice(); emoBar(); wsConnect(); dmThreads(); }

const SYS = { inv_sent: '✅ انرسلت دعوة البارتي', offline: 'اللاعب مو أونلاين الحين', already: 'هو معك في البارتي من قبل', party_full: 'البارتي ممتلئ (6 لاعبين)', inv_expired: 'الدعوة انتهت', no_party: 'ما عندك بارتي' };
function socMsg(m) {
  if (m.t == 'welcome') { MYWS = m.id; MYID = m.uid; bossSet(m.boss); CH.g = (m.log || []).slice(); idUi(); chR(); if (G && G.run && G.R && G.me) wsSend({ t: 'alive', x: Math.round(G.me.x), y: Math.round(G.me.y) }); }
  else if (m.t == 'snap') bossSnap(m.b);
  else if (m.t == 'boss') { bossSet(m.b); if (m.by) toast('🏆 ' + m.by + ' قتل الزعيم! يرجع بعد ساعة'); if (m.sp) toast('👹 الزعيم رجع! روح لنص الخريطة (المربع الأخضر)'); }
  else if (m.t == 'bhurt') { B.hp = m.hp; if (B.seg) { if (G && G.rg) G.rg.push({ x: B.x, y: B.y, t: 0 }); B.fx.push({ x: B.x, y: B.y - 70, t: 45, v: m.d, me: m.id === MYWS }); } }
  else if (m.t == 'breward') { toast('💰 جائزة الزعيم +' + m.c + ' 🪙'); setTimeout(claim, 400); }
  else if (m.t == 'chat') {
    const p = m.ch == 'p', a = p ? CH.p : CH.g; a.push(m); if (a.length > 80) a.shift();
    if (CH.open && CH.tab == m.ch) chR(); else { if (p) CH.up++; else CH.ug++; chBadge(); }
    chLog(m);
  }
  else if (m.t == 'emo') EMOB[m.id] = { e: EMJ[m.e] || EMJ[0], t: Date.now() + 3000 };
  else if (m.t == 'pinv') { if (!INVS.some(v => v.from === m.from)) INVS.push({ from: m.from, name: m.name }); invShow(); chBadge(); if (CH.open && CH.tab == 'p') chR(); }
  else if (m.t == 'party') { const was = PT.id; PT.id = m.id; PT.lead = m.lead || 0; PT.m = m.m || []; if (m.gone || (was && !m.id)) toast('🤝 البارتي انتهى'); else if (!was && m.id) toast('🤝 دخلت البارتي!'); ptApply(); if (CH.open && CH.tab == 'p') chR(); }
  else if (m.t == 'ppos') { for (const a of m.m) PPOS[a[0]] = a; ptRefresh(); }
  else if (m.t == 'dm') {
    if (CH.open && CH.tab == 'd' && CH.cur && CH.cur.uid === m.uid) { (CH.dm[m.uid] = CH.dm[m.uid] || []).push({ mine: 0, txt: m.txt, ts: m.ts }); api('/api/dm/' + m.uid).catch(() => {}); chR(); }
    else { CH.ud++; chBadge(); toast('✉️ ' + m.name + ': ' + m.txt.slice(0, 60)); if (CH.open && CH.tab == 'd') dmThreads(); }
  }
  else if (m.t == 'sys') toast(SYS[m.k] || m.k);
}

// ---------- الزعيم ----------
function bossSet(b) { if (!b) return; B.max = b.max || B.max; B.hp = b.hp; B.until = Date.now() + (b.in || 0); if (b.al && !B.al) bossInit(BZ.x, BZ.y); if (!b.al) B.seg = null; B.al = b.al; bossUi(); }
function bossInit(x, y) { B.x = B.tx = x; B.y = B.ty = y; B.vx = B.vy = 0; B.ts = performance.now(); B.seg = Array.from({ length: BZ.len }, (_, i) => ({ x: x - i * BZ.sp, y })); }
function bossSnap(b) {
  if (!b) return; const now = performance.now();
  if (!B.al || !B.seg) { bossInit(b[0], b[1]); B.al = 1; B.max = B.max || 1500; bossUi(); }
  const dt = Math.max(1, (now - (B.ts || now - 50)) / 16.67); B.vx = (b[0] - B.tx) / dt; B.vy = (b[1] - B.ty) / dt; if (Math.hypot(B.vx, B.vy) > 40) B.vx = B.vy = 0;
  B.ts = now; B.tx = b[0]; B.ty = b[1]; B.ta = b[2]; B.hp = b[3];
}
function bossStep(dt) {
  const age = Math.min(6, (performance.now() - B.ts) / 16.67), px = B.tx + B.vx * age, py = B.ty + B.vy * age, k = Math.min(1, .3 * dt);
  B.x += (px - B.x) * k; B.y += (py - B.y) * k; if (Math.hypot(px - B.x, py - B.y) > 400) { B.x = px; B.y = py; }
  const d = ((B.ta - B.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI; B.a += d * Math.min(1, .3 * dt);
  const s = B.seg; s[0].x = B.x; s[0].y = B.y;
  for (let i = 1; i < s.length; i++) { const p = s[i - 1], q = s[i], dx = p.x - q.x, dy = p.y - q.y, dd = Math.hypot(dx, dy) || 1; if (dd > BZ.sp) { q.x = p.x - dx / dd * BZ.sp; q.y = p.y - dy / dd * BZ.sp; } }
}
// يرجع true إذا مات اللاعب (راسه لمس جسم الزعيم). وإذا راس الزعيم صدم جسم اللاعب: ينقص دم الزعيم
function bossLoop(dt) {
  if (!G.R || !B.al || !B.seg) return false;
  bossStep(dt);
  const me = G.me, r = rad(me), R = BZ.r, far = BZ.len * BZ.sp + 300;
  if (me.pw.shd > 0 || Math.abs(me.x - B.x) > far || Math.abs(me.y - B.y) > far) return false;
  for (let j = 2; j < B.seg.length; j += 2) { const q = B.seg[j]; if ((me.x - q.x) ** 2 + (me.y - q.y) ** 2 < (R + r * .5) ** 2) { die(me, B); return !G.run; } }
  const n = Date.now();
  if (n - B.lh > 550) for (let j = 3; j < me.seg.length; j += 2) { const q = me.seg[j]; if ((B.x - q.x) ** 2 + (B.y - q.y) ** 2 < (R * 1.1 + r) ** 2) { B.lh = n; wsSend({ t: 'bhit', g: Math.floor(me.gr) }); break; } }
  return false;
}
function bossDraw(vx, vy) {
  if (!B.max) return;
  const me = G.me, x0 = BZ.x - BZ.a, y0 = BZ.y - BZ.a, S2 = BZ.a * 2;
  if (Math.abs(me.x - BZ.x) < BZ.a + vx && Math.abs(me.y - BZ.y) < BZ.a + vy) {
    c.save(); c.textAlign = 'center';
    if (B.al) { // مربع أخضر = الزعيم موجود
      c.fillStyle = 'rgba(61,220,132,.05)'; c.fillRect(x0, y0, S2, S2);
      c.strokeStyle = 'rgba(61,220,132,.22)'; c.lineWidth = 44; c.strokeRect(x0, y0, S2, S2);
      c.strokeStyle = '#3ddc84'; c.lineWidth = 12; c.strokeRect(x0, y0, S2, S2);
      c.fillStyle = '#3ddc84'; c.font = '900 72px Tajawal,sans-serif'; c.fillText('👹 الزعيم موجود', BZ.x, y0 - 40);
    } else { // مقتول: عداد الساعة في نص المربع
      c.fillStyle = 'rgba(255,77,109,.04)'; c.fillRect(x0, y0, S2, S2);
      c.setLineDash([70, 45]); c.strokeStyle = 'rgba(255,77,109,.7)'; c.lineWidth = 10; c.strokeRect(x0, y0, S2, S2); c.setLineDash([]);
      c.globalAlpha = .2; c.drawImage(spr('👹'), BZ.x - 480, BZ.y - 500, 960, 960); c.globalAlpha = 1;
      c.fillStyle = '#fff'; c.font = '800 78px Tajawal,sans-serif'; c.fillText('⏳ الزعيم يرجع بعد', BZ.x, BZ.y - 170);
      c.fillStyle = '#ffd60a'; c.font = '900 260px Tajawal,sans-serif'; c.fillText(bossLeft(), BZ.x, BZ.y + 90);
    }
    c.restore();
  }
  if (!B.al || !B.seg || !G.R || Math.abs(B.x - me.x) > vx + 1600 || Math.abs(B.y - me.y) > vy + 1600) return;
  const s = B.seg, R = BZ.r, t = G.f, hr = R * 1.3;
  for (let i = s.length - 1; i > 0; i -= 2) { const q = s[i]; c.fillStyle = (i >> 2) % 2 ? '#7a0019' : '#c1121f'; c.beginPath(); c.arc(q.x, q.y, R, 0, 7); c.fill(); }
  c.fillStyle = '#1b0007';
  for (let i = 6; i < s.length - 2; i += 6) { const q = s[i], p = s[i - 1], an = Math.atan2(p.y - q.y, p.x - q.x), ca = Math.cos(an) * 10, sa = Math.sin(an) * 10;
    for (const sd of [-1, 1]) { const nx = Math.cos(an + sd * Math.PI / 2), ny = Math.sin(an + sd * Math.PI / 2); c.beginPath(); c.moveTo(q.x + nx * R * .8 + ca, q.y + ny * R * .8 + sa); c.lineTo(q.x + nx * R * 1.7, q.y + ny * R * 1.7); c.lineTo(q.x + nx * R * .8 - ca, q.y + ny * R * .8 - sa); c.fill(); } }
  const a = B.a;
  c.fillStyle = 'rgba(255,0,60,' + (.18 + .1 * Math.sin(t / 6)) + ')'; c.beginPath(); c.arc(B.x, B.y, hr + 20, 0, 7); c.fill();
  c.fillStyle = '#f1e3c8';
  for (const sd of [-1, 1]) { const b1 = a + sd * .9, b2 = a + sd * 1.5, tip = a + sd * 1.05; c.beginPath(); c.moveTo(B.x + Math.cos(b1) * hr * .9, B.y + Math.sin(b1) * hr * .9); c.lineTo(B.x + Math.cos(tip) * hr * 2 - Math.cos(a) * hr * .6, B.y + Math.sin(tip) * hr * 2 - Math.sin(a) * hr * .6); c.lineTo(B.x + Math.cos(b2) * hr * .9, B.y + Math.sin(b2) * hr * .9); c.fill(); }
  c.fillStyle = '#e5383b'; c.beginPath(); c.arc(B.x, B.y, hr, 0, 7); c.fill();
  for (const e of [-.5, .5]) { const ex = B.x + Math.cos(a + e) * hr * .55, ey = B.y + Math.sin(a + e) * hr * .55; c.fillStyle = '#ffd60a'; c.beginPath(); c.arc(ex, ey, hr * .26, 0, 7); c.fill(); c.fillStyle = '#000'; c.save(); c.translate(ex, ey); c.rotate(a); c.fillRect(-hr * .05, -hr * .2, hr * .1, hr * .4); c.restore(); }
  const bx0 = B.x - hr - 30, by0 = B.y - hr - 30; c.strokeStyle = '#3ddc84'; c.lineWidth = 5; c.strokeRect(bx0, by0, (hr + 30) * 2, (hr + 30) * 2); // مربع أخضر على الزعيم
  const bw = 320, bh = 18, bx = B.x - bw / 2, by = by0 - 40, f = Math.max(0, B.hp / (B.max || 1));
  c.fillStyle = 'rgba(0,0,0,.65)'; c.fillRect(bx - 3, by - 3, bw + 6, bh + 6); c.fillStyle = f > .5 ? '#3ddc84' : f > .2 ? '#ffd60a' : '#ff4d6d'; c.fillRect(bx, by, bw * f, bh);
  c.textAlign = 'center'; c.fillStyle = '#fff'; c.font = '900 26px Tajawal,sans-serif'; c.fillText('👹 الزعيم  ' + B.hp + ' / ' + B.max, B.x, by - 10);
  for (const x of B.fx) { x.t--; c.globalAlpha = Math.max(0, x.t / 45); c.fillStyle = x.me ? '#ffd60a' : '#ff8fa3'; c.font = '900 ' + (x.me ? 46 : 32) + 'px Tajawal,sans-serif'; c.fillText('-' + x.v, x.x, x.y - (45 - x.t) * 2); }
  c.globalAlpha = 1; B.fx = B.fx.filter(x => x.t > 0);
}
function bossUi() {
  const L = $('#bossL'), H = $('#bossH'), on = !!(WS && WS.readyState == 1 && MYWS);
  if (L) {
    L.classList.toggle('dead', on && !B.al);
    L.innerHTML = !on || !B.max ? '👹 <b>الزعيم</b> · جاري الاتصال بالسيرفر...' : B.al
      ? `<b style="color:#3ddc84">🟩 الزعيم موجود الحين!</b> ❤️ ${B.hp} / ${B.max}<div style="font-size:13px;color:var(--mut);margin-top:6px;line-height:1.7">روح لنص الخريطة (المربع الأخضر). خلّ <b>راس الزعيم يصدم جسمك</b> عشان ينقص دمه، وانتبه: لو راسك لمس جسمه تموت. اللي يقتله ياخذ +500 🪙 والكل ياخذ جائزة حسب ضرره.</div>`
      : `<b style="color:#ff4d6d">⏳ الزعيم مقتول</b> · يرجع بعد <span class="t">${bossLeft()}</span>`;
  }
  if (H) { const show = on && B.max && G && G.R; H.style.display = show ? 'block' : 'none'; if (show) { H.classList.toggle('dead', !B.al); H.textContent = B.al ? '👹 الزعيم موجود ❤️ ' + B.hp + '/' + B.max : '⏳ الزعيم يرجع بعد ' + bossLeft(); } }
}
setInterval(bossUi, 1000);

// ---------- الخريطة الصغيرة + أسهم أعضاء البارتي (تنرسم فوق اللعبة) ----------
function hudDraw(w, h) {
  if (!G.R) return;
  if (G.f % 10 == 0) bossUi();
  const P = PX, M = 150 * P, x0 = w - M - 14 * P, y0 = h - M - 84 * P, k = M / W, me = G.me;
  c.save(); c.fillStyle = 'rgba(0,0,0,.45)'; c.fillRect(x0, y0, M, M); c.strokeStyle = 'rgba(255,255,255,.3)'; c.lineWidth = P; c.strokeRect(x0, y0, M, M);
  if (B.max) {
    const bs = BZ.a * 2 * k; c.strokeStyle = B.al ? '#3ddc84' : '#ff4d6d'; c.lineWidth = 2 * P; c.strokeRect(x0 + (BZ.x - BZ.a) * k, y0 + (BZ.y - BZ.a) * k, bs, bs);
    c.textAlign = 'center';
    if (B.al && B.seg) { c.fillStyle = '#ff2d55'; c.beginPath(); c.arc(x0 + B.x * k, y0 + B.y * k, 3.5 * P, 0, 7); c.fill(); }
    else if (!B.al) { c.fillStyle = '#ffd60a'; c.font = '800 ' + (10 * P) + 'px Tajawal,sans-serif'; c.fillText(bossLeft(), x0 + BZ.x * k, y0 + BZ.y * k + 4 * P); }
  }
  c.textAlign = 'center'; c.font = '700 ' + (9 * P) + 'px Tajawal,sans-serif';
  for (const m of PT.m) { if (m.uid === MYID) continue; const p = PPOS[m.uid]; if (!p || !p[3]) continue; const px = x0 + p[1] * k, py = y0 + p[2] * k; c.fillStyle = '#4cc9f0'; c.beginPath(); c.arc(px, py, 3.5 * P, 0, 7); c.fill(); c.fillStyle = '#fff'; c.fillText(m.name, px, py - 5 * P); }
  c.fillStyle = '#fff'; c.beginPath(); c.arc(x0 + me.x * k, y0 + me.y * k, 4 * P, 0, 7); c.fill();
  // أسهم على أطراف الشاشة تدلّك على مكان أصحابك
  c.font = '800 ' + (12 * P) + 'px Tajawal,sans-serif';
  for (const m of PT.m) {
    if (m.uid === MYID) continue; const p = PPOS[m.uid]; if (!p || !p[3]) continue;
    const dx = p[1] - me.x, dy = p[2] - me.y, d = Math.hypot(dx, dy); if (d < 700) continue;
    const an = Math.atan2(dy, dx), R0 = Math.min(w, h) * .42, ax = w / 2 + Math.cos(an) * R0, ay = h / 2 + Math.sin(an) * R0;
    c.save(); c.translate(ax, ay); c.rotate(an); c.fillStyle = '#4cc9f0'; c.beginPath(); c.moveTo(16 * P, 0); c.lineTo(-8 * P, -10 * P); c.lineTo(-8 * P, 10 * P); c.fill(); c.restore();
    c.fillStyle = '#fff'; c.fillText('🤝 ' + m.name + ' · ' + (d / 1000).toFixed(1) + 'k', ax, ay - 16 * P);
  }
  c.restore();
}

// ---------- الإيموجي فوق الدودة ----------
function emoDraw(s, r) {
  const id = s === G.me ? MYWS : s.wsid, b = id && EMOB[id]; if (!b) return;
  const left = b.t - Date.now(); if (left <= 0) { delete EMOB[id]; return; }
  const z = 48 * Math.min(1, (3000 - left) / 180) + 4; c.globalAlpha = Math.min(1, left / 400);
  c.drawImage(spr(b.e), s.x - z / 2, s.y - r - 48 - z, z, z); c.globalAlpha = 1;
}
function emoSend(i) { if (!G || !G.run || !G.R) return; const e = EMJ.indexOf(emoList()[i]); if (e >= 0) wsSend({ t: 'emo', e }); }
function emoBar() { const e = $('#emb'); if (e) e.innerHTML = emoList().map((x, i) => `<button onclick="emoSend(${i})" aria-label="${i + 1}"><i>${i + 1}</i>${x}</button>`).join(''); emoStrip(); }
function emoStrip() { const e = $('#chem'); if (!e) return; const s = emoList(); e.innerHTML = s.map((x, i) => `<button type="button" onclick="emoIns('${x}')"><i>${i + 1}</i>${x}</button>`).join('') + '<span class="sep"></span>' + EMJ.filter(x => !s.includes(x)).map(x => `<button type="button" onclick="emoIns('${x}')">${x}</button>`).join(''); }
function emoIns(x) { const i = $('#chi'), p = i.selectionStart ?? i.value.length; i.value = (i.value.slice(0, p) + x + i.value.slice(i.selectionEnd ?? p)).slice(0, 200); i.focus(); try { i.setSelectionRange(p + x.length, p + x.length); } catch (e) {} }
function emoHtml() {
  const s = emoList();
  return `<div style="padding:4px 0"><b>😀 حط كل إيموجي على الرقم اللي تحبه</b><div class="emp" style="text-align:start;padding:6px 0">1) اختر الرقم &nbsp; 2) اختر الإيموجي اللي تبغاه فيه.<br>أثناء اللعب اضغط الرقم من 1 إلى 9 في الكيبورد (أو أزرار الإيموجي فوق الشاشة) ويطلع الإيموجي فوق دودتك ويشوفه الكل. نفس الترتيب يطلع في الدردشة.</div>
<div class="eslots">${s.map((e, i) => `<button class="${CH.sel == i ? 'on' : ''}" onclick="CH.sel=${i};chR()"><i>${i + 1}</i>${e}</button>`).join('')}</div>
<div class="egrid">${EMJ.map((e, i) => `<button onclick="emoPut(${i})" class="${s[CH.sel] == e ? 'on' : ''}">${e}</button>`).join('')}</div>
<button class="chx" onclick="emoReset()">↺ الترتيب الأصلي</button></div>`;
}
function emoPut(i) { const s = emoList().slice(), e = EMJ[i], j = s.indexOf(e); if (j >= 0 && j !== CH.sel) s[j] = s[CH.sel]; s[CH.sel] = e; S.emo = s; save(); toast('✅ ' + e + ' صار على رقم ' + (CH.sel + 1)); CH.sel = (CH.sel + 1) % 9; emoBar(); chR(); }
function emoReset() { S.emo = EMD.slice(); save(); CH.sel = 0; emoBar(); chR(); }

// ---------- لوحة الدردشة ----------
function chOpen(tab) { CH.open = 1; if (tab) CH.tab = tab; $('#chat').style.display = 'flex'; if (CH.tab == 'd' && !CH.cur) dmThreads(); chR(); if (innerWidth > 700) setTimeout(() => { const i = $('#chi'); if (i && $('#chbar').style.display != 'none') i.focus(); }, 60); }
function chClose() { CH.open = 0; const e = $('#chat'); if (e) e.style.display = 'none'; const a = document.activeElement; if (a && a.id == 'chi') a.blur(); }
function chTab(t) { CH.tab = t; CH.who = null; if (t == 'd') { CH.cur = null; dmThreads(); } chR(); }
function chBadge() {
  const n = { g: CH.ug, p: CH.up + INVS.length, d: CH.ud }, tot = Math.min(99, n.g + n.p + n.d);
  document.querySelectorAll('#chtop .bd,#chbtn .bd').forEach(e => { e.textContent = tot; e.style.display = tot ? 'flex' : 'none'; });
  document.querySelectorAll('#chtabs button').forEach(b => { const e = b.querySelector('.bd'); if (e) { const k = Math.min(99, n[b.dataset.t] || 0); e.textContent = k; e.style.display = k ? 'flex' : 'none'; } });
}
const msgs = (a, emp, dm) => '<div class="msgs">' + (a.length ? a.map(m => dm
  ? `<div class="cm ${m.mine ? 'me' : ''}"><i>${tm(m.ts)}</i>${esc(m.txt)}</div>`
  : `<div class="cm"><i>${tm(m.ts)}</i><b class="cu" data-u="${m.uid | 0}" data-n="${esc(m.name)}">${em(FD[m.f] ? m.f : 'DZ')} ${esc(m.name)}</b> <span class="cid">#${m.uid | 0}</span><div>${esc(m.txt)}</div></div>`).join('') : `<div class="emp">${emp}</div>`) + '</div>';
function chR() {
  const e = $('#chb2'); chBadge(); if (!e || !CH.open) return;
  if (CH.tab == 'g') CH.ug = 0; if (CH.tab == 'p') CH.up = 0;
  document.querySelectorAll('#chtabs button').forEach(b => b.classList.toggle('on', b.dataset.t == CH.tab));
  const who = CH.who ? `<div class="chw"><b>${esc(CH.who.name)}</b><span class="cid">#${CH.who.uid}</span><button onclick="dmOpen(CH.who.uid,CH.who.name)">✉️ رسالة خاصة</button><button onclick="ptInv(CH.who.uid)">🤝 دعوة للبارتي</button><button onclick="CH.who=null;chR()" style="background:var(--card);color:var(--ink)">✕</button></div>` : '';
  let h = '', inp = true;
  if (CH.tab == 'g') h = who + msgs(CH.g, 'هذي دردشة كل اللاعبين في السيرفر. قل هلا 👋<br>اضغط على اسم أي لاعب عشان ترسل له خاص أو تدعوه للبارتي.');
  else if (CH.tab == 'p') { h = who + ptHtml() + (PT.id ? msgs(CH.p, 'دردشة البارتي فاضية. رسائلها توصل لأصحابك بس.') : ''); inp = !!PT.id; }
  else if (CH.tab == 'd') {
    if (CH.cur) h = `<div class="chw"><button onclick="CH.cur=null;dmThreads();chR()" style="background:var(--card);color:var(--ink)">→ رجوع</button><b style="flex:1">${esc(CH.cur.name)} <span class="cid">#${CH.cur.uid}</span></b><button onclick="ptInv(CH.cur.uid)">🤝 دعوة</button></div>` + msgs(CH.dm[CH.cur.uid] || [], 'ابدأ المحادثة ✉️<br>الرسالة توصل حتى لو صاحبك أوفلاين.', 1);
    else { inp = false; h = dmList(); }
  }
  else { inp = false; h = emoHtml(); }
  e.innerHTML = h; $('#chbar').style.display = inp ? '' : 'none';
  const L = e.querySelector('.msgs'); if (L) L.scrollTop = L.scrollHeight;
  $('#chi').placeholder = CH.tab == 'p' ? 'رسالة للبارتي...' : CH.tab == 'd' ? 'رسالة خاصة...' : 'رسالة للكل...';
}
function chSend() {
  const i = $('#chi'), t = i.value.trim(); if (!t) return;
  if (CH.tab == 'd' && CH.cur) { const u = CH.cur.uid; api('/api/dm/' + u, 'POST', { txt: t }).then(() => { (CH.dm[u] = CH.dm[u] || []).push({ mine: 1, txt: t, ts: Date.now() }); chR(); }).catch(e => toast(e.message == 'rate' ? 'رسائل كثيرة، انتظر شوي' : 'ما انرسلت الرسالة')); }
  else { if (!WS || WS.readyState != 1) return toast('غير متصل بالسيرفر'); wsSend({ t: 'chat', ch: CH.tab == 'p' ? 'p' : 'g', txt: t }); }
  i.value = '';
}
function chLog(m) {
  const L = $('#chlog'); if (!L || !$('#g').classList.contains('on')) return;
  const d = document.createElement('div'); if (m.ch == 'p') d.className = 'p';
  d.innerHTML = (m.ch == 'p' ? '🤝 ' : '') + '<b>' + esc(m.name) + ':</b> ' + esc(m.txt); L.appendChild(d);
  while (L.children.length > 5) L.firstChild.remove();
  setTimeout(() => { d.style.opacity = 0; setTimeout(() => d.remove(), 700); }, 9000);
}

// ---------- معرّف الحساب (ID) ----------
function idUi() { const t = MYID ? '#' + MYID : '...'; const a = $('#chid'); if (a) a.textContent = t; const b = $('#myid'); if (b) b.textContent = MYID ? '🆔 معرّف حسابك: #' + MYID + ' (اضغط للنسخ) — عطه لأصحابك عشان يراسلونك ويدعونك للبارتي' : ''; }
function idCopy() { if (!MYID) return; const t = String(MYID); (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('📋 تم نسخ الـID: ' + t)).catch(() => toast('الـID حقك: ' + t)); }

// ---------- البارتي ----------
function ptApply() { for (const k in RM) RM[k].team = ptHas(RM[k].uid) ? 'pt' : ''; if (G && G.me && G.R) G.me.team = PT.id ? 'pt' : ''; }
const ARW = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
function ptWhere(m) {
  if (m.uid === MYID) return '📍 أنت'; if (!m.on) return '⚫ أوفلاين';
  const p = PPOS[m.uid]; if (!p || !p[3]) return '🟢 في القائمة';
  const cell = String.fromCharCode(65 + Math.min(9, Math.floor(p[1] / 3000))) + (1 + Math.min(9, Math.floor(p[2] / 3000)));
  if (G && G.run && G.me && G.R) { const dx = p[1] - G.me.x, dy = p[2] - G.me.y, d = Math.hypot(dx, dy); return '📍 ' + cell + ' · ' + (d / 1000).toFixed(1) + 'k ' + ARW[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8]; }
  return '📍 يلعب في ' + cell;
}
const ptRows = () => PT.m.map(m => `<div class="row"><span>${m.uid === PT.lead ? '👑' : '🐍'}</span><b class="cu" data-u="${m.uid}" data-n="${esc(m.name)}">${esc(m.name)}${m.uid === MYID ? ' (أنت)' : ''}</b><span class="cid">#${m.uid}</span><span>${ptWhere(m)}</span></div>`).join('');
function ptRefresh() { if (!CH.open || CH.tab != 'p') return; const e = $('#chb2 .ptm'); if (e) e.innerHTML = ptRows(); }
function ptHtml() {
  let h = INVS.map((v, i) => `<div class="chw inv">🤝 <b>${esc(v.name)}</b><span class="cid">#${v.from}</span> يدعوك للبارتي <button onclick="ptAcc(${i})">✅ قبول</button><button onclick="ptDec(${i})" style="background:var(--card);color:var(--ink)">✕</button></div>`).join('');
  h += `<div class="chw"><input id="pid" inputmode="numeric" maxlength="10" placeholder="ID صاحبك (مثل 12)" style="direction:ltr;flex:1;min-width:120px" onkeydown="event.stopPropagation();if(event.key=='Enter')ptInvBox()"><button onclick="ptInvBox()">🤝 دعوة</button></div>`;
  if (!PT.id) return h + '<div class="emp">ما عندك بارتي.<br>ادعُ صاحبك برقم الـID حقه. في البارتي تشوفون مكان بعض في الخريطة الصغيرة وأسهم على الشاشة، وما تقتلون بعض، ولكم دردشة خاصة فيكم.</div>';
  return h + `<div class="ptm">${ptRows()}</div><button class="chx" onclick="ptLeave()">🚪 اطلع من البارتي</button>`;
}
function ptInvBox() { const e = $('#pid'); ptInv(+String(e ? e.value : '').replace(/\D/g, '')); }
function ptInv(uid) { if (!uid) return toast('اكتب ID صحيح'); if (uid === MYID) return toast('هذا الـID حقك'); if (!WS || WS.readyState != 1) return toast('غير متصل بالسيرفر'); wsSend({ t: 'pinv', to: uid }); }
function ptAcc(i) { const v = INVS.splice(i, 1)[0]; if (v) wsSend({ t: 'pacc', from: v.from }); invShow(); chBadge(); if (CH.open) chR(); }
function ptDec(i) { INVS.splice(i, 1); invShow(); chBadge(); if (CH.open) chR(); }
function ptLeave() { wsSend({ t: 'pleave' }); }
function invShow() {
  const e = $('#inv'), v = INVS[0]; if (!v) return invHide();
  e.innerHTML = `🤝 <span>${esc(v.name)} <span class="cid">#${v.from}</span> يدعوك للبارتي</span><button onclick="ptAcc(0)">✅ قبول</button><button class="no" onclick="ptDec(0)">رفض</button>`;
  e.style.display = 'flex'; clearTimeout(invShow.t); invShow.t = setTimeout(invHide, 30000);
}
function invHide() { const e = $('#inv'); if (e) e.style.display = 'none'; }

// ---------- الرسائل الخاصة ----------
function dmList() {
  return `<div class="chw"><input id="did" inputmode="numeric" maxlength="10" placeholder="اكتب ID الحساب (مثل 12)" style="direction:ltr;flex:1;min-width:120px" onkeydown="event.stopPropagation();if(event.key=='Enter')dmStart()"><button onclick="dmStart()">✉️ ابدأ</button></div>`
    + (CH.thr.length ? CH.thr.map(t => `<div class="row thr" data-u="${t.uid | 0}" data-n="${esc(t.name)}" onclick="dmOpen(+this.dataset.u,this.dataset.n)"><span class="f">${em(FD[t.flag] ? t.flag : 'DZ')}</span><b>${esc(t.name)} <span class="cid">#${t.uid | 0}</span> ${t.on ? '🟢' : ''}<small>${t.mine ? 'أنت: ' : ''}${esc(t.txt)}</small></b>${t.un ? `<span class="n">${t.un}</span>` : ''}</div>`).join('')
      : '<div class="emp">ما عندك رسائل خاصة.<br>اكتب ID أي لاعب وابدأ المحادثة.</div>');
}
function dmStart() { const id = +String(($('#did') || {}).value || '').replace(/\D/g, ''); if (!id) return toast('اكتب ID صحيح'); if (id === MYID) return toast('هذا الـID حقك'); api('/api/user/' + id).then(u => dmOpen(u.id, u.name)).catch(() => toast('ما لقيت حساب بهذا الـID')); }
function dmOpen(uid, name) { uid = +uid; CH.tab = 'd'; CH.cur = { uid, name }; CH.who = null; if (!CH.open) chOpen('d'); else chR(); api('/api/dm/' + uid).then(j => { CH.dm[uid] = j.rows; if (CH.cur && CH.cur.uid === uid) chR(); dmThreads(); }).catch(() => {}); }
function dmThreads() { if (!TOKEN) return; api('/api/dm').then(j => { CH.thr = j.rows || []; CH.ud = CH.thr.reduce((a, t) => a + (t.un || 0), 0); if (CH.open && CH.tab == 'd' && !CH.cur) chR(); else chBadge(); }).catch(() => {}); }

// ---------- الكيبورد: Enter للدردشة، 1-9 للإيموجي، Esc يقفل ----------
function socKey(e) {
  if (e.code == 'Escape' && CH.open) { chClose(); return true; }
  if (!G || !G.run) return false;
  if (e.key == 'Enter') { chOpen(CH.tab == 'e' || (CH.tab == 'd' && !CH.cur) ? 'g' : CH.tab); setTimeout(() => { const i = $('#chi'); if (i) i.focus(); }, 60); e.preventDefault(); return true; }
  const m = /^(Digit|Numpad)([1-9])$/.exec(e.code); if (m) { emoSend(+m[2] - 1); return true; }
  return false;
}

// لو تسجيل الدخول التلقائي خلص قبل ما ينحمّل هذا الملف
if (TOKEN && typeof CUR !== 'undefined' && CUR) socBoot();
