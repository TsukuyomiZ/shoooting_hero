// node test/volley.js
// shared/volley.js（一波的重播 / 結算）的合約：出發那一幀就撞到的事件（貼臉開火）、負向測試（reach 檢查真的會抓到錯）、
// 沉降剛好 S 幀（不符記在 settle）、drift（不認得的角色 / 跳過的事件 / 輪不到的事件）、F+S = 0、格式壞掉當場丟 TypeError、不改 shot、tick 只步進一次，
// 以及真的 client/game-view.js（在 Node 裡載入）播一發 / AI 一發：每個 update 剛好一次 match.step、總共 F+S+24 個 update
import { CONFIG } from '../shared/config.js';
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { baseStats, derivePlayerStats } from '../shared/cards.js';
import { replayVolley } from '../shared/volley.js';
import { replayChecked, reachAndCatch } from './replay-check.js';

// 客戶端模組一載入就碰 window / document / localStorage（音效）；GameView 建構時要 canvas：給最小的假物件（同 new-maps.js）
const fakeCtx = () => new Proxy({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const fakeCanvas = () => ({ width: 1024, height: 768, style: {}, getContext: fakeCtx, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }) });
globalThis.window ??= { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document ??= { addEventListener() {}, hidden: false, createElement: fakeCanvas };
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { GameView } = await import('../client/game-view.js');

CONFIG.ENEMY.damageMult = 1;
CONFIG.ENEMY.damageMultLate = 1;

const results = [];
function test(name, fn) {
  try {
    const info = fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${info ? '  ' + JSON.stringify(info) : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const J = (x) => JSON.parse(JSON.stringify(x));
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const throws = (fn, Type, re) => { try { fn(); } catch (e) { assert(e instanceof Type && (!re || re.test(e.message)), `wrong error: ${e && e.constructor.name} ${e && e.message}`); return e.message; } throw new Error('did not throw'); };

function matchWith(effects = {}, { players = 1, levelId = 'level1', seed = 1, weapons = ['cannon', 'sniper', 'boomerang', 'plasma'], hp = 300 } = {}) {
  const stats = baseStats();
  for (const [k, v] of Object.entries(effects)) stats[k] += v;
  const d = derivePlayerStats(stats);
  const carry = {};
  for (let i = 1; i <= players; i++) carry['p' + i] = { hp, maxHp: hp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed, size: d.size, mods: d.mods, weapons };
  return new Match({ levelId, players: mkPlayers(players), seed, carry });
}
const clientOf = (m) => { const cm = new Match({ levelId: m.levelId, players: mkPlayers(m.players.length), seed: m.seed, carry: m.carry, stage: m.stage }); cm.applySnapshot(J(m.snapshot())); return cm; };
// 伺服器開一槍，回傳 { m, cm（開火前的客戶端）, shot（走過 JSON） }
function fire(weapon, angle, power, opts = {}) {
  const m = matchWith(opts.fx, opts);
  if (opts.setup) opts.setup(m);
  const cm = clientOf(m);
  const shot = J(m.resolveShot(m.players[0], weapon, angle, power));
  return { m, cm, shot };
}
const sameResults = (cm, shot, label) => {
  for (const s of shot.results) {
    const e = cm.byId(s.id);
    assert(e && e.x === s.x && e.y === s.y && e.hp === s.hp && e.alive === s.alive, `${label}: ${s.id} client ${e && [e.x, e.y, e.hp, e.alive]} vs server ${[s.x, s.y, s.hp, s.alive]}`);
  }
};

// ---------- 貼臉開火：出發那一幀就撞到 ----------

test('貼臉開火：出發那一幀的事件（f === spawn）照樣套上（大砲 / 狙擊 / 等離子三發 / 迴力鏢），drift 是空的、結果一致', () => {
  const out = {};
  for (const w of ['cannon', 'sniper', 'plasma', 'boomerang']) {
    // 腹背受敵、3 人：往前下方打，砲口前面不到一幀的飛行距離就是隊友 / 地面
    let found = null;
    for (const a of [-20, -30, -45, -60, -90]) {
      const r = fire(w, a, w === 'sniper' ? 35 : 75, { levelId: 'flanked', players: 3 });
      const spawnHits = r.shot.events.filter(ev => ev.f === r.shot.projectiles[ev.p].spawn);
      if (spawnHits.length) { found = { ...r, a, spawnHits }; break; }
    }
    assert(found, `${w}: no angle produced a spawn-frame event`);
    const seen = [];
    replayChecked(found.cm, found.shot, w, { event: (ev, p, made) => { if (ev.f === found.shot.projectiles[ev.p].spawn) seen.push([ev.type, made.before.state]); } });
    assert(seen.length === found.spawnHits.length && seen.every(([, st]) => st === 'flying'), `${w}: spawn-frame events applied ${JSON.stringify(seen)}`);
    sameResults(found.cm, found.shot, w);
    out[w] = `${found.a}° ${found.spawnHits.map(e => `#${e.p}f${e.f}:${e.type}`).join(' ')}`;
  }
  // 貼著敵人開火（敵人站在砲口前）：第一幀就打中角色
  const r = fire('sniper', 0, 100, { setup: (m) => { const p = m.players[0], e = m.enemies[0]; e.x = p.x + 30; e.y = p.y; e.vx = e.vy = 0; m.settle(120); p.facing = 1; } });
  const hit = r.shot.events[0];
  assert(hit.f === 1 && hit.target === 'e1', 'point-blank enemy hit on frame 1: ' + JSON.stringify(hit).slice(0, 120));
  replayChecked(r.cm, r.shot, 'point-blank enemy');
  sameResults(r.cm, r.shot, 'point-blank enemy');
  out.enemy = `${hit.type}@f${hit.f}`;
  return out;
});

// ---------- 負向：檢查真的會抓到錯 ----------

test('負向：把 payload 的初速改掉（vx +15%），reach 檢查一定會抓到；迴力鏢 catch 的位置差 0.001px 也抓得到', () => {
  const { cm, shot } = fire('cannon', 20, 60);
  const bad = J(shot);
  bad.projectiles[0].vx *= 1.15;
  const msg = throws(() => replayChecked(cm, bad, 'perturbed'), Error, /px from the server event/);
  const b = fire('boomerang', 0, 50, { setup: (m) => { m.enemies[0].x = m.players[0].x + 160; m.settle(200); } });
  const ev = b.shot.events.find(e => e.type === 'catch');
  assert(ev, 'boomerang got caught: ' + b.shot.events.map(e => e.type));
  const bad2 = J(b.shot);
  bad2.events.find(e => e.type === 'catch').x += 0.001;
  const msg2 = throws(() => replayChecked(b.cm, bad2, 'catch'), Error, /return path/);
  return { reach: msg.slice(0, 70), catch: msg2.slice(0, 60) };
});

// ---------- 沉降 ----------

test('沉降剛好 S 幀：第 S 幀才第一次站穩；S 少一幀 / 多一幀都記進 settle（不進 drift）；到上限 360 還沒站穩不算', () => {
  const { cm, shot } = fire('cannon', 20, 60);
  const F = shot.flightFrames, S = shot.settleFrames;
  const steps = [];
  const step = cm.step.bind(cm);
  cm.step = (dt) => { step(dt); steps.push(cm.isSettled()); };
  const run = replayVolley(cm, shot);
  let ticks = 0;
  for (const t of run.frames()) { ticks++; assert(t.frames === 1 && typeof t.step === 'function', 'tick shape'); }
  assert(ticks === F + S && steps.length === F + S && !run.drift.length && run.settle === null, `ticks ${ticks}, steps ${steps.length}, F+S ${F + S}, drift ${run.drift}, settle ${run.settle}`);
  assert(steps[F + S - 1] && !steps.slice(F, F + S - 1).some(Boolean), 'first settled exactly at the last settle step');
  const drifts = {};
  for (const d of [-1, 1]) {
    const r2 = fire('cannon', 20, 60);
    const s2 = J(r2.shot); s2.settleFrames += d;
    const run2 = replayVolley(r2.cm, s2);
    const drift2 = run2.run();
    drifts[d] = run2.settle;
    assert(/settle: server/.test(drifts[d]) && !drift2.length, `S${d > 0 ? '+' : ''}${d}: settle ${drifts[d]}, drift ${drift2}`);
  }
  // 360 = 伺服器沉降的上限：還沒站穩也算數；360 以前就站穩了還是不符
  const r3 = fire('cannon', 20, 60);
  r3.cm.isSettled = () => false;
  const s3 = J(r3.shot); s3.settleFrames = 360;
  const run3 = replayVolley(r3.cm, s3);
  run3.run();
  const r4 = fire('cannon', 20, 60);
  r4.cm.isSettled = () => false;
  const run4 = replayVolley(r4.cm, r4.shot);
  run4.run();
  assert(run3.settle === null && /never/.test(run4.settle), `cap: ${run3.settle} / ${run4.settle}`);
  return { F, S, minus1: drifts[-1], plus1: drifts[1] };
});

// ---------- drift ----------

test('drift：不認得的 ents id、飛行物已經結束後的事件、輪不到的事件（f > F / 不存在的飛行物）、飛行結束還沒結束的飛行物', () => {
  const { m, shot } = fire('cannon', 20, 60);
  const withEnts = shot.events.find(e => e.ents);
  assert(withEnts, 'a hit with ents');
  const cases = {
    ghost: (s) => { s.events.find(e => e.ents).ents[0].id = 'ghost'; },
    afterDone: (s) => { const e = s.events[s.events.length - 1]; s.events.push({ ...e, type: 'out' }); },
    late: (s) => { s.events.push({ f: s.flightFrames + 5, p: 0, type: 'out', x: 0, y: 0 }); },
    noProj: (s) => { s.events.push({ f: 1, p: 7, type: 'out', x: 0, y: 0 }); },
    stillLive: (s) => { s.events = s.events.filter(e => e.p !== 0); },
  };
  const out = {};
  for (const [k, mut] of Object.entries(cases)) {
    const s = J(shot); mut(s);
    const cm = clientOf(m);   // m 已經結算過，但 drift 只看結構，起點不重要
    let lastFrameLive = null;
    const drift = replayVolley(cm, s).run({ frame: (live) => { lastFrameLive = live.length; } });
    out[k] = drift.join(' | ');
    assert(out[k], `${k}: no drift`);
    if (k === 'stillLive') assert(lastFrameLive === 0 && /still live/.test(out[k]), 'frame hook fires once more with the emptied list');
  }
  assert(/unknown id ghost/.test(out.ghost) && /skipped: projectile done/.test(out.afterDone) && /never reached/.test(out.late) && /never reached/.test(out.noProj), JSON.stringify(out));
  return out;
});

// ---------- F+S = 0、格式、不改 shot、tick ----------

test('F+S = 0：一個 tick 都沒有、射手照樣擺好（第一個 next()）；未知武器回傳 null、什麼都沒碰', () => {
  const m = matchWith();
  const cm = clientOf(m);
  const p = cm.players[0];
  const shot = { kind: 'weapon', actorId: 'p1', weapon: 'cannon', angle: 30, power: 50, facing: -1, actor: { x: p.x + 3, y: p.y - 2, vy: 0 }, projectiles: [], events: [], flightFrames: 0, settleFrames: 0, results: [] };
  const run = replayVolley(cm, shot);
  assert(p.x !== shot.actor.x, 'pure until started');
  const g = run.frames();
  assert(p.x !== shot.actor.x, 'frames() itself does not place');
  const r = g.next();
  assert(r.done && p.x === shot.actor.x && p.y === shot.actor.y && p.facing === -1 && p.aimPower === 50 && !run.drift.length, 'placed on the first next(), no ticks');
  throws(() => run.frames(), Error, /只能跑一次/);
  const before = J(cm.snapshot());
  assert(replayVolley(cm, {}) === null && replayVolley(cm, { weapon: 'laser', events: 'bad' }) === null && JSON.stringify(cm.snapshot()) === JSON.stringify(before), 'unknown weapon → null, untouched');
  return { placed: [p.x, p.y] };
});

test('格式壞掉：replayVolley 呼叫的當下就丟 TypeError（不是播到一半）', () => {
  const { cm, shot } = fire('cannon', 20, 60);
  const bad = {
    eventsNull: { events: null }, projsObj: { projectiles: {} }, nanSettle: { settleFrames: NaN }, negFlight: { flightFrames: -1 },
    fracSettle: { settleFrames: 1.5 }, strFlight: { flightFrames: '12' }, nullEvent: { events: [null] }, nullProj: { projectiles: [null] },
  };
  const out = {};
  for (const [k, patch] of Object.entries(bad)) out[k] = throws(() => replayVolley(cm, { ...J(shot), ...patch }), TypeError, /^replayVolley:/).slice(14, 40);
  return out;
});

test('不改 shot（JSON 前後一樣）；每個 tick 是新物件、step() 重複呼叫只步進一次、宿主先 step 了模組就不再 step；live 是同一個陣列、飛完清空', () => {
  const { cm, shot } = fire('plasma', 30, 45);
  const j0 = JSON.stringify(shot);
  let steps = 0;
  const step = cm.step.bind(cm);
  cm.step = (dt) => { assert(dt === CONFIG.FIXED_DT, 'fixed dt'); steps++; step(dt); };
  const run = replayVolley(cm, shot);
  const live = run.live;
  const ticks = new Set();
  let maxLive = 0, n = 0;
  for (const t of run.frames({ frame: (l) => { assert(l === live, 'same array'); maxLive = Math.max(maxLive, l.length); } })) {
    assert(!ticks.has(t), 'fresh tick');
    ticks.add(t);
    const s0 = steps;
    if (n++ % 2 === 0) { t.step(); t.step(); t.step(); assert(steps === s0 + 1, 'idempotent'); }
  }
  assert(steps === shot.flightFrames + shot.settleFrames && run.live === live && live.length === 0 && maxLive === 3, `steps ${steps}, maxLive ${maxLive}`);
  assert(JSON.stringify(shot) === j0, 'shot mutated');
  return { steps, maxLive };
});

// ---------- 真的 GameView ----------

// 在 Node 裡建一個真的 GameView（假 canvas），餵裁判的訊息、一個 update 一個 update 推進。
// 每個 update 記：開始時手上是不是 tick（重播一波的幀）、這個 update 裡 match.step 被呼叫幾次
function makeView() {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  return view;
}
function drive(view, max = 3000) {
  const log = [];
  const m = view.match;
  let calls = 0;
  const own = Object.hasOwn(m, 'step'), prev = m.step;   // 呼叫端可能已經包過一層（記軌跡）
  const step = prev.bind(m);
  m.step = (dt) => { calls++; step(dt); };
  while (view.script && log.length < max) {
    const tick = !!(view.wait && view.wait.step);
    const c0 = calls;
    view.update(CONFIG.FIXED_DT);
    log.push({ tick, steps: calls - c0 });
  }
  if (own) m.step = prev;
  else delete m.step;   // 回到 Match.prototype.step
  return log;
}

// 假的 io（假時鐘）：裁判廣播的訊息照順序收著（走過 JSON），advance 推進時間跑排程
const fakeIo = () => ({ t: 0, timers: [], log: [], seq: 0,
  broadcast(msg) { this.log.push(J(msg)); }, schedule(fn, ms) { const h = { at: this.t + ms, fn, id: this.seq++ }; this.timers.push(h); return h; },
  cancel(h) { this.timers = this.timers.filter(x => x !== h); }, now() { return this.t; },
  advance(ms) { const end = this.t + ms; for (;;) { this.timers.sort((a, b) => a.at - b.at || a.id - b.id); const n = this.timers[0]; if (!n || n.at > end) break; this.timers.shift(); this.t = n.at; n.fn(); } this.t = end; },
  take(t) { return this.log.filter(x => x.t === t); } });

test('真的 GameView（client/game-view.js 在 Node 載入）：玩家開一槍、AI 開一槍，重播的每個 update 剛好一次 match.step、其他 update 一次都沒有，總共 F+S+24 個 update', () => {
  const players = mkPlayers(1);
  const m = matchWith({}, { players: 1, hp: 300 });
  const io = fakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const view = makeView();
  for (const msg of io.log.splice(0)) view.onMessage(msg);
  io.advance(2500);
  assert(ref.currentId === 'p1', 'p1 turn');
  for (const msg of io.log.splice(0)) view.onMessage(msg);
  drive(view);
  // 伺服器開火時記射手每一幀的位置；客戶端 GameView 播的時候也記：要一模一樣
  const serverTrace = [], clientTrace = [];
  const sstep = m.step.bind(m);
  m.step = (dt) => { sstep(dt); const a = m.byId('p1'); serverTrace.push(a.x, a.y); };
  const p1 = m.byId('p1');
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 40, power: 55, x: p1.x, y: p1.y, vy: 0, facing: 1, stamina: p1.stamina });
  m.step = sstep;
  const shotMsg = io.take('shot')[0];
  assert(shotMsg, 'shot broadcast');
  const cstep = view.match.step.bind(view.match);
  view.match.step = (dt) => { cstep(dt); const a = view.match.byId('p1'); clientTrace.push(a.x, a.y); };
  const counts = { launch: 0, events: 0 };
  const sl = view.showLaunch, se = view.showShotEvent;
  view.showLaunch = function (...a) { counts.launch++; return sl.apply(this, a); };
  view.showShotEvent = function (...a) { counts.events++; return se.apply(this, a); };
  io.log.length = 0;
  view.onMessage(shotMsg);
  const F = shotMsg.flightFrames, S = shotMsg.settleFrames;
  const log = drive(view);
  delete view.match.step;
  const tickUpdates = log.filter(u => u.tick);
  assert(tickUpdates.length === F + S && tickUpdates.every(u => u.steps === 1), `shot: ${tickUpdates.length} tick updates (F+S ${F + S}), steps ${[...new Set(tickUpdates.map(u => u.steps))]}`);
  assert(log.filter(u => !u.tick).every(u => u.steps === 0), 'non-volley updates never call match.step');
  assert(log.length === F + S + 24, `shot: ${log.length} updates, expected ${F + S + 24}`);
  assert(serverTrace.length === clientTrace.length && serverTrace.every((v, i) => v === clientTrace[i]), `shooter trajectory differs (server ${serverTrace.length / 2}, GameView ${clientTrace.length / 2})`);
  assert(counts.launch === shotMsg.projectiles.length && counts.events === shotMsg.events.length, 'hooks: ' + JSON.stringify(counts));
  // AI 的一發：aiThink（42）→ 走路 → aiAim（54）的 update 是 GameView 自己的物理（不經過 match.step），接著 F+S 個重播的 update、最後 24
  let ai = null;
  for (let k = 0; k < 400 && !ai; k++) {
    io.advance(100);
    for (const msg of io.log.splice(0)) {
      if (msg.t === 'aiTurn' && msg.shot) ai = msg;
      else if (!ai) { view.onMessage(msg); drive(view); }
    }
  }
  assert(ai, 'an AI shot');
  view.onMessage(ai);
  const log2 = drive(view);
  const F2 = ai.shot.flightFrames, S2 = ai.shot.settleFrames;
  const pre = Math.round(CONFIG.TIMING.aiThink * 60) + (ai.walk ? ai.walk.frames : 0) + Math.round(CONFIG.TIMING.aiAim * 60);
  const t2 = log2.filter(u => u.tick);
  assert(t2.length === F2 + S2 && t2.every(u => u.steps === 1) && log2.filter(u => !u.tick).every(u => u.steps === 0), `aiTurn: ${t2.length} tick updates vs F+S ${F2 + S2}`);
  assert(log2.length === pre + F2 + S2 + 24, `aiTurn: ${log2.length} updates, expected ${pre} + ${F2 + S2} + 24`);
  assert(log2.slice(pre, pre + F2 + S2).every(u => u.tick), 'the volley updates are contiguous right after aiAim');
  return { shot: { F, S, updates: log.length }, aiTurn: { actor: ai.actorId, pre, F: F2, S: S2, updates: log2.length } };
});

test('重播中收到隊友的 move：先收著（隊友照物理跑、不插值），套完伺服器結果才套最新的那筆；重播到一半丟錯也會馬上套上', () => {
  const m = matchWith({}, { players: 2, hp: 300 });
  const io = fakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(2), io });
  ref.start();
  const view = makeView();
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); drive(view); };
  feed();
  io.advance(2500);
  feed();
  assert(ref.currentId === 'p1', 'p1 turn');
  const fire = (id) => {
    const a = m.byId(id);
    ref.handle(id, { t: 'fire', weapon: 'cannon', angle: 40, power: 55, x: a.x, y: a.y, vy: 0, facing: 1, stamina: a.stamina });
    const shot = io.log.find(x => x.t === 'shot');
    io.log.length = 0;
    view.onMessage(shot);
    return shot;
  };
  // p1（自己）開火；重播第 5 幀收到 p2 的兩筆 move：重播期間都不套，播完只套最新那筆
  fire('p1');
  const p2 = view.match.byId('p2');
  let n = 0, last = null, leaked = false;
  while (view.script && view.wait && view.wait.step) {
    if (n === 5) {
      view.onMessage({ t: 'move', id: 'p2', x: p2.x + 10, y: p2.y, facing: -1 });
      last = { x: p2.x + 20, y: p2.y };
      view.onMessage({ t: 'move', id: 'p2', ...last, facing: -1 });
    }
    if (p2.netTarget) leaked = true;
    view.update(CONFIG.FIXED_DT);
    n++;
  }
  assert(n > 5 && !leaked, `held during the replay (${n} volley updates)`);
  assert(p2.netTarget && p2.netTarget.x === last.x && p2.netTarget.y === last.y && p2.facing === -1, 'latest move applied after results: ' + JSON.stringify(p2.netTarget));
  assert(!view.holdMoves && view.heldMoves.size === 0, 'nothing left held');
  drive(view);
  // 輪到 p2 開火，重播到一半畫面掛勾丟錯：收著的 move 不會卡住
  for (let k = 0; k < 400 && ref.currentId !== 'p2'; k++) { io.advance(100); feed(); }
  assert(ref.currentId === 'p2', 'p2 turn');
  feed();
  fire('p2');
  const err = console.error;
  console.error = () => {};
  const show = view.showShotEvent;
  view.showShotEvent = () => { throw new Error('boom'); };
  let held = false;
  try {
    while (view.script && view.wait && view.wait.step) {
      view.onMessage({ t: 'move', id: 'p2', x: 123, y: 45 });
      held ||= view.heldMoves.size > 0;
      view.update(CONFIG.FIXED_DT);
    }
  } finally { console.error = err; view.showShotEvent = show; }
  assert(held && !view.holdMoves && view.heldMoves.size === 0 && p2.netTarget && p2.netTarget.x === 123, 'flushed after the throw: ' + JSON.stringify(p2.netTarget));
  return { volleyUpdates: n, applied: p2.netTarget };
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
