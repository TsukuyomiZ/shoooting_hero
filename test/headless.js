// node test/headless.js
// 不用瀏覽器的規則 / 流程測試：地形遮罩、回合順序、誤傷、確定性、裁判流程、斷線代打、壓力測試
import { performance } from 'node:perf_hooks';
import { CONFIG } from '../shared/config.js';
import { LEVELS, levelsInPool } from '../shared/level.js';
import { Terrain } from '../shared/terrain.js';
import { Match, feverStacks } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { planShot } from '../shared/ai.js';
import { Rng } from '../shared/rng.js';

// 其他測試照武器原本傷害算敵人的攻擊；敵人傷害倍率（ENEMY.damageMult）有下面的專門測試
const ENEMY_DAMAGE_MULT = CONFIG.ENEMY.damageMult;
CONFIG.ENEMY.damageMult = 1;

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

// 假的 io：虛擬時鐘，可以快轉
class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.seq = 0; }
  broadcast(msg, exceptId) { this.log.push({ ...msg, _except: exceptId }); }
  schedule(fn, ms) { const h = { at: this.t + ms, fn, id: this.seq++ }; this.timers.push(h); return h; }
  cancel(h) { this.timers = this.timers.filter(x => x !== h); }
  now() { return this.t; }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
  take(type) { return this.log.filter(m => m.t === type); }
  clear() { this.log = []; }
}
function advanceUntil(io, pred, maxMs = 180_000) {
  const start = io.t;
  while (io.t - start < maxMs) {
    io.advance(100);
    if (pred()) return true;
  }
  return false;
}
function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));

test('地形遮罩與多邊形內外判定一致；挖洞、用洞清單重建都可重現', () => {
  const lvl = LEVELS.level1;
  const t = new Terrain(CONFIG.WORLD_W, CONFIG.WORLD_H, lvl.polygons);
  const rng = new Rng(1);
  let mismatch = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const x = rng.range(0, CONFIG.WORLD_W), y = rng.range(0, CONFIG.WORLD_H);
    const inside = lvl.polygons.some(p => pointInPoly(p, Math.floor(x) + 0.5, Math.floor(y) + 0.5));
    if (inside !== t.isSolid(x, y)) mismatch++;
  }
  assert(mismatch === 0, `mask/polygon mismatch ${mismatch}/${N}`);
  assert(t.isSolid(150, 500) && !t.isSolid(150, 400) && !t.isSolid(440, 600), 'basic solidity');
  t.carve(150, 440, 30);
  t.carve(560, 450, 20);
  assert(!t.isSolid(150, 445) && t.isSolid(150, 480), 'carve removes only the circle');
  const t2 = new Terrain(CONFIG.WORLD_W, CONFIG.WORLD_H, lvl.polygons);
  t2.reset(t.holes);
  assert(Buffer.compare(Buffer.from(t.mask), Buffer.from(t2.mask)) === 0, 'reset(holes) must reproduce the mask');
  return { sampled: N, holes: t.holes.length };
});

test('4 位玩家：回合順序 玩家1→4 → 敵人A→B，敵人血量每多一人 +70%，死者跳過', () => {
  const m = new Match({ players: mkPlayers(4), seed: 5 });
  const order = [];
  let cur = null;
  for (let i = 0; i < 6; i++) { const a = m.nextActor(cur); order.push(a.id); cur = a.id; }
  assert(order.join(',') === 'p1,p2,p3,p4,e1,e2', order.join(','));
  assert(m.nextActor('e2').id === 'p1', 'wraps to p1');
  const expected = Math.round(CONFIG.ENEMY.hp * (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER * 3));
  assert(m.enemies.every(e => e.maxHp === expected), 'enemy hp ' + m.enemies.map(e => e.maxHp));
  const solo = new Match({ players: mkPlayers(1), seed: 5 });
  assert(solo.enemies[0].maxHp === CONFIG.ENEMY.hp, 'solo enemy hp');
  m.byId('p2').die('hit');
  assert(m.nextActor('p1').id === 'p3', 'dead p2 skipped');
  assert(m.entities.every(e => e.onGround), 'everyone landed at start');
  return { order, enemyHp4p: expected };
});

test('隊友誤傷 ×0.6（含自己），打敵人全額', () => {
  const m = new Match({ players: mkPlayers(2), seed: 3 });
  for (const e of m.entities) e.hp = e.maxHp = 10000;   // 血量跟 config 無關，免得傷害被血量截斷
  const [p1, p2] = m.players;
  const e1 = m.enemies[0];
  const w = CONFIG.WEAPONS.cannon;
  const friendly = Math.round(w.damage * CONFIG.FRIENDLY_FIRE);
  const hpP2 = p2.hp, hpE1 = e1.hp, hpP1 = p1.hp;
  m.applyExplosion(p2.cx, p2.cy, w, p1, p2);
  assert(hpP2 - p2.hp === friendly, 'friendly dmg ' + (hpP2 - p2.hp));
  m.applyExplosion(e1.cx, e1.cy, w, p1, e1);
  assert(hpE1 - e1.hp === w.damage, 'enemy dmg ' + (hpE1 - e1.hp));
  m.applyExplosion(p1.cx, p1.cy, w, p1, p1);
  assert(hpP1 - p1.hp === friendly, 'self dmg ' + (hpP1 - p1.hp));
  return { friendly, enemy: w.damage };
});

test('同 seed 同輸入 → 兩場的所有結果與快照位元級一致', () => {
  const run = () => {
    const m = new Match({ players: mkPlayers(2), seed: 99 });
    const log = [];
    log.push(m.resolveShot(m.players[0], 'cannon', 40, 55));
    for (const e of m.enemies) {
      const { walk, plan } = m.planAiTurn(e);
      log.push({ walk, plan });
      if (plan) log.push(m.resolveShot(e, plan.weapon, plan.angle, plan.power));
    }
    log.push(m.resolveShot(m.players[1], 'sniper', 10, 100));
    return JSON.stringify({ log, snap: m.snapshot() });
  };
  const a = run(), b = run();
  assert(a === b, 'two runs differ');
  return { bytes: a.length };
});

test('裁判：人類回合等 fire、非行動者的訊息被忽略、超時跳過、敵人回合一次廣播腳本', () => {
  const players = mkPlayers(2);
  const m = new Match({ players, seed: 11 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  assert(io.take('start').length === 1 && io.take('start')[0].snapshot.entities.length === 4, 'start payload');
  io.advance(CONFIG.TIMING.startDelay * 1000);
  const turn = io.take('turn').at(-1);
  assert(turn && turn.actorId === 'p1' && turn.ai === false && turn.turnTime === CONFIG.TURN_TIME, 'first turn is p1');
  ref.handle('p2', { t: 'fire', weapon: 'cannon', angle: 45, power: 50 });
  assert(io.take('shot').length === 0, 'p2 fire must be ignored on p1 turn');
  const p1 = m.byId('p1');
  const plan = planShot(m.world, p1, new Rng(1));
  ref.handle('p1', { t: 'fire', weapon: plan.weapon, angle: plan.angle, power: plan.power, x: p1.x, y: p1.y, facing: 1, stamina: 200 });
  const shot = io.take('shot').at(-1);
  assert(shot && shot.actorId === 'p1' && shot.flightFrames > 0 && shot.results.length === 4, 'shot broadcast');
  assert(ref.phase === 'resolving', 'resolving after fire');
  assert(advanceUntil(io, () => io.take('turn').filter(t => t.actorId === 'p1').length >= 2), 'should come back to p1');
  const actors = io.take('turn').map(t => t.actorId);
  assert(actors.slice(0, 5).join(',') === 'p1,p2,e1,e2,p1', 'turn sequence ' + actors.join(','));
  assert(io.take('skip').some(s => s.actorId === 'p2' && s.reason === 'timeout'), 'p2 timeout skip');
  const ai = io.take('aiTurn');
  assert(ai.length === 2 && ai.every(a => Array.isArray(a.entities) && (a.shot === null || a.shot.results.length === 4)), 'aiTurn payloads');
  return { turns: actors.length, round: ref.round, gameSeconds: Math.round(io.t / 1000) };
});

test('斷線：輪到他時 AI 代打；輪到他當下斷線立刻代打；回線後恢復人類回合', () => {
  const players = mkPlayers(2);
  const m = new Match({ players, seed: 21 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  assert(advanceUntil(io, () => io.take('turn').some(t => t.actorId === 'p1' && !t.ai)), 'p1 turn');
  ref.setConnected('p2', false);
  assert(io.take('playerStatus').at(-1).connected === false, 'status broadcast');
  io.clear();
  assert(advanceUntil(io, () => io.take('turn').some(t => t.actorId === 'p2')), 'p2 turn');
  assert(io.take('turn').find(t => t.actorId === 'p2').ai === true, 'p2 turn should be AI');
  assert(io.take('aiTurn').some(a => a.actorId === 'p2'), 'aiTurn for p2');

  ref.setConnected('p2', true);
  io.clear();
  assert(advanceUntil(io, () => io.take('turn').some(t => t.actorId === 'p2')), 'p2 turn again');
  assert(io.take('turn').find(t => t.actorId === 'p2').ai === false, 'p2 human again after reconnect');

  io.clear();
  assert(advanceUntil(io, () => io.take('turn').some(t => t.actorId === 'p1' && !t.ai)), 'p1 turn again');
  const before = io.t;
  ref.setConnected('p1', false);
  assert(io.t === before && io.take('aiTurn').some(a => a.actorId === 'p1'), 'immediate AI takeover when the actor disconnects');
  const st = ref.statePayload();
  assert(st.snapshot && Array.isArray(st.snapshot.holes) && st.players.length === 2 && 'currentId' in st, 'statePayload shape');
  return { gameSeconds: Math.round(io.t / 1000), phase: ref.phase };
});

// 落水規則的測試不受使用者在 config 調的數值影響
function withWater(fn) {
  const saved = { ...CONFIG.WATER };
  Object.assign(CONFIG.WATER, { damagePct: 30, enemiesDrown: true, safeMargin: 10 });
  try { return fn(); } finally { Object.assign(CONFIG.WATER, saved); }
}
// x 這一行從上往下第一個站得住的腳底高度
function standY(e, terrain, x) {
  for (let y = 300; y < CONFIG.WATER_LEVEL; y++) if (e.canStandAt(terrain, x, y)) return y;
  return null;
}

test('位置回報檢查：瞬移 / 卡進地形 / 增加體力都被拒絕；走進水裡扣 30% 最大血量、回到最後站穩的地方，回合繼續（體力不回滿），血不夠才淹死', () => withWater(() => {
  const players = mkPlayers(1);
  const m = new Match({ players, seed: 2 });
  m.planAiTurn = () => ({ walk: null, plan: null });   // 敵人只發呆，免得把人打進水裡 / 改到血量
  const p1 = m.players[0];
  const x0 = p1.x, y0 = p1.y;
  assert(!m.setPlayerPosition(p1, 900, y0, 1, 100), 'teleport rejected');
  assert(!m.setPlayerPosition(p1, x0, y0 + 60, 1, 100), 'inside terrain rejected');
  p1.stamina = 50;
  assert(m.setPlayerPosition(p1, x0 + 5, y0, 1, 120) && p1.stamina === 50, 'stamina cannot increase');
  assert(m.setPlayerPosition(p1, x0 + 10, y0, -1, 20) && p1.stamina === 20 && p1.facing === -1, 'valid move accepted');
  p1.maxHp = p1.hp = 1000;   // 血量跟 config 無關

  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  io.advance(2000);
  const deadline = ref.deadline;
  ref.handle('p1', { t: 'move', x: x0, y: y0, facing: 1, stamina: 250 });   // 站在地上：記成最後站穩的地方
  ref.handle('p1', { t: 'move', x: 440, y: 480, facing: 1, stamina: 200 });
  assert(p1.x === 440 && p1.safeX === x0 && p1.safeY === y0, 'move over the gap accepted (in the air: not a safe spot)');
  io.clear();
  ref.handle('p1', { t: 'move', x: 440, y: 700, facing: 1, stamina: 180 });
  assert(p1.alive && p1.hp === 700, 'water costs 30% of max hp: ' + p1.hp);
  assert(p1.x === x0 && p1.y === y0 && p1.onGround && p1.vy === 0, `back where he last stood: ${p1.x},${p1.y}`);
  assert(p1.stamina === 180, 'stamina is not refilled: ' + p1.stamina);
  assert(ref.phase === 'turn' && ref.currentId === 'p1' && ref.deadline === deadline && !io.take('skip').length, 'the turn goes on (same deadline)');
  const w = io.take('water');
  assert(w.length === 1 && w[0]._except === 'p1' && w[0].id === 'p1' && w[0].splash.dmg === 300 && !w[0].splash.died && w[0].splash.x === 440 && w[0].splash.n === 1,
    'others get a water message (not the actor himself): ' + JSON.stringify(w));
  assert(w[0].state.x === x0 && w[0].state.y === y0 && w[0].state.hp === 700 && w[0].state.alive, 'water message carries the respawned state');
  assert(!io.take('move').length, 'the in-water position is not relayed as a move');

  // 還有體力：接著走、照常開火
  ref.handle('p1', { t: 'move', x: x0 + 10, y: y0, facing: 1, stamina: 150 });
  assert(p1.x === x0 + 10 && io.take('move').length === 1, 'keeps moving after the respawn');
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: p1.x, y: p1.y, vy: 0, facing: 1, stamina: 150 });
  assert(io.take('shot').some(sh => sh.actorId === 'p1'), 'can still fire after the respawn');

  // 下一次輪到他：剛好剩 30% → 扣完沒血，淹死，這回合才結束
  assert(advanceUntil(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn again');
  p1.hp = 300;
  io.clear();
  ref.handle('p1', { t: 'move', x: 440, y: 480, facing: 1, stamina: 100 });
  ref.handle('p1', { t: 'move', x: 440, y: 700, facing: 1, stamina: 100 });
  assert(!p1.alive && p1.deathCause === 'water' && p1.hp === 0, 'not enough hp → drowns');
  const skip = io.take('skip')[0];
  assert(skip && skip.reason === 'water' && skip.splashes[0].died && !io.take('water').length, 'drowning ends the turn: skip(water)');
  io.advance(5000);
  assert(io.take('gameOver').some(g => g.result === 'lose'), 'solo player drowned → lose');
}));

test('落水：扣最大血量 30%（不吃狂熱 / 減傷 / 無敵）；站的地方被炸掉就找最近站得住的地面；回報帶的站穩點要站得住才採用', () => withWater(() => {
  const m = matchWith({ armorPct: 50 }, { hp: 1000 });
  const p1 = m.players[0];
  const x0 = p1.x, y0 = p1.y;
  assert(p1.safeX === x0 && p1.safeY === y0, 'standing: the safe spot follows him');
  m.fever = 2;
  p1.shield = 1;
  const drop = () => { p1.x = 440; p1.y = 600; p1.vx = 0; p1.vy = 0; p1.onGround = false; m.settle(300); };   // 丟到斷崖之間的水面上空
  drop();
  assert(p1.alive && p1.hp === 700 && p1.shield === 1, `flat 30%, no fever / armor / shield: hp ${p1.hp}, shield ${p1.shield}`);
  assert(p1.x === x0 && p1.y === y0 && p1.onGround && p1.waterFalls === 1, `back on the exact spot: ${p1.x},${p1.y}`);
  assert(p1.splash && p1.splash.dmg === 300 && !p1.splash.died && p1.splash.x === 440, 'splash record for the view');

  // 站的地方一路被炸到水面以下：往旁邊找最近、高度最接近的地面
  for (let y = y0; y < 720; y += 20) m.terrain.carve(x0, y, 30);
  drop();
  assert(p1.alive && p1.hp === 400, 'second fall: another 30% → ' + p1.hp);
  assert(p1.canStandAt(m.terrain, p1.x, p1.y) && Math.abs(p1.x - x0) <= 45 && Math.abs(p1.y - y0) <= 5,
    `respawned on the nearest ground next to the crater: ${p1.x},${p1.y} (was ${x0},${y0})`);
  m.settle(60);
  assert(p1.alive && p1.hp === 400 && p1.onGround, 'stands there (does not fall in again)');

  // 剛好剩 30%：扣完就沒血 → 淹死
  p1.hp = 300;
  drop();
  assert(!p1.alive && p1.deathCause === 'water' && p1.hp === 0 && p1.splash.died, 'not enough hp → drowns');

  // 玩家回報自己掉進水裡時帶著客戶端記的站穩點：站得住就照用，在空中的不採用
  const m2 = matchWith({}, { hp: 1000 });
  const q = m2.players[0];
  const qx = q.x, qy = q.y;
  const tx = qx + 60, ty = standY(q, m2.terrain, tx);
  assert(m2.setPlayerPosition(q, 300, 400, 1, 100) && m2.setPlayerPosition(q, 440, 655, 1, 100, { x: tx, y: ty }), 'reports accepted');
  assert(q.hp === 700 && q.x === tx && q.y === ty, `client's safe spot used: ${q.x},${q.y} vs ${tx},${ty}`);
  assert(m2.setPlayerPosition(q, 300, 400, 1, 100) && m2.setPlayerPosition(q, 440, 655, 1, 100, { x: 440, y: 300 }), 'reports accepted');
  assert(q.hp === 400 && q.x === tx && q.y === ty, `a safe spot in the air is ignored: ${q.x},${q.y}`);
  // 沿著斜的崖壁掉下去，身體擦進牆裡一點：在水裡的回報照樣收（不然伺服器不知道他掉下去了，回合卡到超時）
  assert(q.collides(m2.terrain, 403, 660) && q.collides(m2.terrain, 403, 652), 'precondition: brushing the cliff wall (pushing up 8px does not free him)');
  assert(m2.setPlayerPosition(q, 300, 400, 1, 100) && m2.setPlayerPosition(q, 403, 660, 1, 100), 'in-water report overlapping a wall accepted');
  assert(q.hp === 100 && q.waterFalls === 3 && q.x === tx, 'fell in and respawned: hp ' + q.hp);

  // 敵人（含樹妖）落水一樣直接淹死，血再多也一樣；enemiesDrown 關掉就跟玩家一樣扣 30%
  const throwIn = (e) => { e.x = 440; e.y = 600; e.vx = 0; e.vy = 0; e.onGround = false; m2.settle(300); };
  const [e1, e2] = m2.enemies;
  throwIn(e1);
  assert(!e1.alive && e1.deathCause === 'water' && e1.splash.died && e1.splash.dmg === 1000, `enemy drowns at once (hp ${e1.hp}, ${e1.deathCause})`);
  CONFIG.WATER.enemiesDrown = false;
  throwIn(e2);
  assert(e2.alive && e2.hp === 700 && e2.waterFalls === 1, 'enemiesDrown: false → enemies take 30% like players: ' + e2.hp);
  // 落水次數跟著快照同步（客戶端用它判斷 skip / aiTurn 帶來的水花自己播過了沒）
  const c2 = new Match({ levelId: m2.levelId, players: mkPlayers(1), seed: m2.seed });
  c2.applySnapshot(JSON.parse(JSON.stringify(m2.snapshot())));
  assert(c2.byId(q.id).waterFalls === 3 && c2.byId(e2.id).waterFalls === 1, 'waterFalls synced by snapshot');
  return { respawn: [p1.splash.sx, p1.splash.sy] };
}));

test('落水重生點挑直線距離最近的：古樹之庭腳下被挖空時，旁邊的地面贏過正上方 200px 的高台', () => withWater(() => {
  const m = new Match({ levelId: 'treeGarden', players: mkPlayers(1), seed: 1 });
  const p = m.players[0];
  p.maxHp = p.hp = 1000;
  const x = 520;   // 高台（x 440~600、頂面 384）正下方的地面
  const gy = Array.from({ length: 120 }, (_, k) => 620 - k).find(y => p.canStandAt(m.terrain, x, y));
  assert(gy > 560, 'ground under the high platform: ' + gy);
  p.x = p.safeX = x; p.y = p.safeY = gy;
  for (let y = gy - 10; y < 720; y += 20) m.terrain.carve(x, y, 30);   // 站的地方一路挖到水裡
  p.vx = 0; p.vy = 0; p.onGround = false;
  m.settle(300);
  assert(p.alive && p.hp === 700 && p.waterFalls === 1, 'fell in once: ' + p.hp);
  assert(p.y > 560 && Math.abs(p.x - x) <= 45, `respawned on the ground beside the hole, not on the high platform: ${p.x},${p.y}`);
  return { respawn: [p.x, p.y] };
}));

test('斷線代打：跳到半空中斷線，伺服器先讓他落地（途中掉水的水花跟著 aiTurn），客戶端從靜止的狀態開始播、不會多掉一次', () => withWater(() => {
  const players = mkPlayers(2);
  const m = new Match({ players, seed: 2 });
  const p1 = m.players[0];
  p1.maxHp = p1.hp = 1000;
  const x0 = p1.x, y0 = p1.y;
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  io.advance(2000);
  assert(ref.currentId === 'p1' && ref.phase === 'turn', 'p1 turn');
  const snap0 = JSON.parse(JSON.stringify(m.snapshot()));   // 斷線前客戶端手上的狀態（地形還沒被炸過）
  ref.handle('p1', { t: 'move', x: 440, y: 470, vy: 200, facing: 1, stamina: 100 });   // 跳過斷崖、還在半空中
  io.clear();
  ref.setConnected('p1', false);
  const ai = io.take('aiTurn')[0];
  assert(ai && ai.actorId === 'p1', 'AI takes over at once');
  assert(ai.splashes.length === 1 && ai.splashes[0].id === 'p1' && ai.splashes[0].dmg === 300 && !ai.splashes[0].died, 'aiTurn carries the landing splash: ' + JSON.stringify(ai.splashes));
  const st = ai.entities.find(e => e.id === 'p1');
  assert(st.hp === 700 && st.x === x0 && st.y === y0 && st.wf === 1, `snapshot is the landed (respawned) state: ${st.x},${st.y} hp ${st.hp}`);

  // 照客戶端的 aiTurnScript：套快照 → aiThink 那段也跑物理（伺服器沒跑）→ 走路 → 重播開火。不能再多掉一次水
  const cm = new Match({ levelId: m.levelId, players, seed: m.seed });
  cm.applySnapshot(snap0);
  cm.applyEntities(JSON.parse(JSON.stringify(ai.entities)));
  const c1 = cm.byId('p1');
  for (let i = 0; i < Math.round(CONFIG.TIMING.aiThink * 60); i++) cm.step();
  assert(c1.waterFalls === 1 && c1.hp === 700, 'no extra fall during aiThink on the client: falls ' + c1.waterFalls + ', hp ' + c1.hp);
  if (ai.walk) { c1.moveDir = ai.walk.dir; for (let i = 0; i < ai.walk.frames; i++) cm.step(); c1.moveDir = 0; }
  if (ai.shot) {
    const shot = JSON.parse(JSON.stringify(ai.shot));
    replayLikeClient(cm, shot);
    const r = shot.results.find(e => e.id === 'p1');
    assert(c1.hp === r.hp && c1.alive === r.alive && c1.x === r.x && c1.y === r.y && c1.waterFalls === r.wf, `replay matches the server: client ${c1.x},${c1.y},${c1.hp} vs ${r.x},${r.y},${r.hp}`);
  }
  return { walk: !!ai.walk, shot: ai.shot && ai.shot.weapon };
}));

test('超時那一刻人在水面上空：伺服器落地途中掉進水裡，skip 帶著水花（客戶端沒有重播這段）', () => withWater(() => {
  const players = mkPlayers(1);
  const m = new Match({ players, seed: 2 });
  m.planAiTurn = () => ({ walk: null, plan: null });
  const p1 = m.players[0];
  p1.maxHp = p1.hp = 1000;
  const x0 = p1.x, y0 = p1.y;
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  io.advance(2000);
  ref.handle('p1', { t: 'move', x: 440, y: 480, vy: 0, facing: 1, stamina: 100 });
  io.clear();
  assert(advanceUntil(io, () => io.take('skip').length > 0), 'timeout skip');
  const skip = io.take('skip')[0];
  assert(skip.reason === 'timeout' && skip.splashes.length === 1 && skip.splashes[0].id === 'p1' && skip.splashes[0].dmg === 300,
    'skip carries the splash: ' + JSON.stringify(skip.splashes));
  assert(p1.alive && p1.hp === 700 && p1.x === x0 && p1.y === y0, `respawned where he last stood: ${p1.x},${p1.y}`);
}));

test('壓力：4 人（2 人斷線）打到結束，不能有例外，AI 規劃要快', () => {
  const players = mkPlayers(4);
  const m = new Match({ players, seed: 77 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  const rng = new Rng(5);
  ref.start();
  ref.setConnected('p3', false);
  ref.setConnected('p4', false);
  let humanShots = 0, guard = 0, maxPlanMs = 0;
  const wall = performance.now();
  while (ref.phase !== 'over' && guard++ < 20000) {
    io.advance(200);
    if (ref.phase === 'turn') {
      const a = m.byId(ref.currentId);
      const t0 = performance.now();
      const plan = rng.chance(0.7) ? planShot(m.world, a, rng) : { weapon: 'cannon', angle: rng.range(20, 160), power: rng.range(20, 100) };
      maxPlanMs = Math.max(maxPlanMs, performance.now() - t0);
      ref.handle(a.id, { t: 'fire', weapon: plan.weapon, angle: plan.angle, power: plan.power, x: a.x, y: a.y, facing: a.facing, stamina: a.stamina });
      humanShots++;
    }
  }
  assert(ref.phase === 'over', 'game should end, phase=' + ref.phase);
  assert(maxPlanMs < 150, 'planning too slow ' + maxPlanMs);
  const over = io.take('gameOver')[0];
  const shots = io.take('shot').length + io.take('aiTurn').filter(a => a.shot).length;
  return { result: over.result, humanShots, aiTurns: io.take('aiTurn').length, shots, rounds: ref.round, gameMinutes: +(io.t / 60000).toFixed(1), wallMs: Math.round(performance.now() - wall), maxPlanMs: +maxPlanMs.toFixed(1) };
});

// ---------- 肉鴿流程 ----------
import fs from 'node:fs';
import { Run } from '../shared/run.js';
import { validateCards, drawOffers, RARITIES } from '../shared/cards.js';
const CARDS = validateCards(JSON.parse(fs.readFileSync(new URL('../shared/cards.json', import.meta.url), 'utf8')));

test('牌庫 JSON 可載入且無警告；抽牌不重複、稀有度合法、unique 牌不會再出現', () => {
  assert(CARDS.warnings.length === 0, 'warnings: ' + CARDS.warnings.join('; '));
  assert(CARDS.cards.length >= 10, 'need sample cards');
  const rng = new Rng(9);
  const counts = { white: 0, green: 0, purple: 0, gold: 0 };
  for (let i = 0; i < 500; i++) {
    const offers = drawOffers(CARDS.cards, rng, 1, 3, []);
    assert(offers.length === 3 && new Set(offers.map(c => c.id)).size === 3, 'offers must be 3 distinct');
    for (const c of offers) { assert(RARITIES.includes(c.rarity)); counts[c.rarity]++; }
  }
  assert(counts.white > counts.green && counts.green > counts.purple && counts.purple > counts.gold, 'rarity distribution ' + JSON.stringify(counts));
  const uniq = CARDS.cards.find(c => c.unique);
  for (let i = 0; i < 300; i++) assert(!drawOffers(CARDS.cards, rng, 9, 3, [uniq.id]).some(c => c.id === uniq.id), 'unique card re-offered');
  const bad = validateCards({ cards: [{ id: 'x', rarity: 'blue' }, { id: 'y', rarity: 'gold', effects: { nope: 1, maxHp: 10 } }] });
  assert(bad.cards.length === 1 && bad.warnings.length === 2, 'bad cards should warn: ' + JSON.stringify(bad));
  return counts;
});

test('肉鴿流程：5 小關（地圖隨機不連續重複）→ 選牌帶加成 → Boss 關 → 通關', () => {
  const io = new FakeIo();
  const players = mkPlayers(2);
  const run = new Run({ players, seed: 3, io, cards: CARDS.cards });
  run.start();
  const levels = [];
  let guard = 0;
  while (run.phase !== 'over' && guard++ < 300) {
    io.advance(200);
    if (run.phase === 'battle' && run.referee.phase === 'turn') {
      const id = run.match.levelId + '#' + run.stage;
      if (levels.at(-1) !== id) levels.push(id);
      for (const e of run.match.enemies) e.die('hit');   // 作弊秒殺，讓超時觸發勝負判定
      io.advance(31_000);
    }
    if (run.phase === 'pick') {
      // 提早送的 pick 不會被接受（stageClear 之前）；p1 選第一張，p2 不選 → 超時隨機
      assert(io.take('stageClear').length >= 1, 'pick phase only after stageClear broadcast');
      run.handle('p1', { t: 'pick', cardId: run.offers.p1[0].id });
      io.advance(CONFIG.RUN.pickTime * 1000 + 100);
    }
  }
  assert(run.phase === 'over' && run.result === 'win', 'run should be won, phase=' + run.phase);
  const bossLevels = levelsInPool('boss');
  assert(bossLevels.includes('treeGarden') && bossLevels.includes('jungleSerpent'), 'boss pool ' + bossLevels);
  assert(levels.length === 6 && bossLevels.some(id => levels.at(-1).startsWith(id + '#6')), 'levels ' + levels.join(','));
  for (let i = 1; i < 5; i++) assert(levels[i].split('#')[0] !== levels[i - 1].split('#')[0], 'same map twice in a row: ' + levels.join(','));
  const p1 = run.players.get('p1'), p2 = run.players.get('p2');
  assert(p1.cards.length === 5 && p2.cards.length === 5, 'each player gets one card per cleared stage');
  const sc = io.take('stageClear');
  assert(sc.length === 5 && sc.every(m => m.offers.p1.length === 3 && m.offers.p2.length === 3), 'stageClear offers');
  const picks = io.take('picks');
  assert(picks.length === 5 && picks[0].summary.length === 2, 'picks summary');
  const bossStart = io.take('start').at(-1);
  // Boss 關從 Boss 池隨機抽（古樹之庭 / 叢林巨蟒），血量都只吃人數放大
  const tree = bossStart.levelId === 'treeGarden';
  const boss = bossStart.snapshot.entities.find(e => e.id === (tree ? 'eye' : 'snake'));
  const bossHp2p = Math.round((tree ? CONFIG.TREE_BOSS.eyeHp : CONFIG.SNAKE_BOSS.hp) * (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER));
  assert(bossStart.stageInfo.isBoss && bossLevels.includes(bossStart.levelId) && boss && boss.hp === bossHp2p, 'boss stage payload');
  assert(bossStart.carry.p1 && bossStart.carry.p1.maxHp >= CONFIG.PLAYER.hp, 'carry travels to boss stage');
  const over = io.take('runOver')[0];
  assert(over && over.result === 'win' && over.stage === 6, 'runOver payload');
  return { levels, p1Cards: p1.cards.map(c => c.id), p1MaxHp: bossStart.carry.p1.maxHp };
});

test('肉鴿流程：全隊倒下 → runOver lose；血量在關卡間帶著走，倒下者下一關復活', () => {
  const io = new FakeIo();
  const players = mkPlayers(2);
  const run = new Run({ players, seed: 8, io, cards: CARDS.cards });
  run.start();
  io.advance(2000);
  // 第一關：p2 死掉、p1 剩 100 血後勝利
  run.match.byId('p2').die('hit');
  run.match.byId('p1').hp = 100;
  for (const e of run.match.enemies) e.die('hit');
  io.advance(31_000);
  assert(run.phase === 'clear' || run.phase === 'pick', 'should be clearing, phase=' + run.phase);
  io.advance(3000);
  const hp1 = run.players.get('p1').hp;
  assert(hp1 === Math.round(100 + CONFIG.PLAYER.hp * CONFIG.RUN.healPctOnClear), 'heal on clear, hp=' + hp1);
  io.advance(CONFIG.RUN.pickTime * 1000 + 3000);   // 超時隨機選 → 下一關
  assert(run.stage === 2 && run.phase === 'battle', 'stage 2 should start, stage=' + run.stage + ' phase=' + run.phase);
  const p2e = run.match.byId('p2');
  assert(p2e.alive && p2e.hp === Math.round(p2e.maxHp * CONFIG.RUN.reviveHpPct), 'p2 revived at ' + p2e.hp + '/' + p2e.maxHp);
  // 第二關全滅
  io.advance(2000);
  for (const e of run.match.players) e.die('hit');
  io.advance(31_000);
  assert(run.phase === 'over' && run.result === 'lose', 'lose expected, phase=' + run.phase);
  assert(io.take('runOver').at(-1).result === 'lose');
  return { hpAfterClear: hp1, reviveHp: p2e.hp };
});

test('牌的加成會進戰鬥：大砲傷害 +%、爆炸半徑 +%、減傷 %', () => {
  const players = mkPlayers(2);
  const carry = {
    p1: { hp: 1300, maxHp: 1300, maxStamina: 200, moveSpeed: 130, jumpSpeed: 380, mods: { cannonDamagePct: 50, radiusPct: 20 } },
    p2: { hp: 1300, maxHp: 1300, maxStamina: 200, moveSpeed: 130, jumpSpeed: 380, mods: { armorPct: 50 } },
  };
  const m = new Match({ players, seed: 1, carry, stage: 3 });
  const w = CONFIG.WEAPONS.cannon;
  const [p1, p2] = m.players;
  const e1 = m.enemies[0];
  const expectedEnemyHp = Math.round(CONFIG.ENEMY.hp * (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER) * (1 + CONFIG.RUN.enemyHpPerStage * 2));
  assert(e1.maxHp === expectedEnemyHp, 'stage scaling ' + e1.maxHp + ' vs ' + expectedEnemyHp);
  e1.hp = e1.maxHp = 10000;   // 量傷害時不要被 config 的敵人血量截斷
  const hp0 = e1.hp;
  m.applyExplosion(e1.cx, e1.cy, w, p1, e1);
  assert(hp0 - e1.hp === Math.round(w.damage * 1.5), 'boosted cannon dmg ' + (hp0 - e1.hp));
  assert(Math.abs(m.explosionRadius(p1, w) - w.radius * 1.2) < 1e-9, 'radius pct');
  const hpP2 = p2.hp;
  m.applyExplosion(p2.cx, p2.cy, w, e1, p2);
  assert(hpP2 - p2.hp === Math.round(w.damage * 0.5), 'armor halves damage: ' + (hpP2 - p2.hp));
  return { enemyHpStage3: expectedEnemyHp };
});

// ---------- 武器欄與裝備效果 ----------
import { baseStats, derivePlayerStats, needsDiscard, equipWeapon } from '../shared/cards.js';
import { traceShot, advanceProjectile, stepReturn } from '../shared/weapons.js';

const cardById = (id) => CARDS.cards.find(c => c.id === id);
// p1 帶指定效果（直接加在 stats 上）的測試戰鬥；所有人血量拉到 hp，數字不受 config 的血量影響
function matchWith(effects = {}, { players = 1, levelId = 'level1', seed = 1, weapons, hp = 5000 } = {}) {
  const stats = baseStats();
  for (const [k, v] of Object.entries(effects)) stats[k] += v;
  const d = derivePlayerStats(stats);
  const carry = { p1: { hp, maxHp: hp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed, size: d.size, mods: d.mods, weapons } };
  const m = new Match({ levelId, players: mkPlayers(players), seed, carry });
  for (const e of m.entities) { e.maxHp = hp; e.hp = hp; }
  return m;
}
// 把角色放到 x 的地面上
function placeAt(m, e, x) { e.x = x; e.y = 300; e.vx = 0; e.vy = 0; m.settle(600); }
// 讓 Run 進入選牌階段並換成指定的牌（跳過戰鬥）
function toPickPhase(io, run, offersById) {
  for (const e of run.match.enemies) e.die('hit');
  assert(advanceUntil(io, () => run.phase === 'pick'), 'should reach pick phase');
  for (const [pid, ids] of Object.entries(offersById)) run.offers[pid] = ids.map(id => (typeof id === 'string' ? cardById(id) : id));
}

// 照 client/game-view.js 的 shotScript 在另一份 Match 上重播：每幀先跑角色物理，
// 飛行物只跑運動學，撞擊結果照伺服器的事件套用。回傳每顆飛行物的最終狀態
function replayLikeClient(cm, shot) {
  const weapon = CONFIG.WEAPONS[shot.weapon];
  if (shot.kind !== 'bombard') {
    const a = cm.byId(shot.actorId);
    a.x = shot.actor.x; a.y = shot.actor.y; a.vx = 0; a.vy = shot.actor.vy || 0;
    if (shot.actor.sx !== undefined) { a.safeX = shot.actor.sx; a.safeY = shot.actor.sy; }
    if (shot.actor.hp !== undefined) a.hp = shot.actor.hp;
  }
  const projs = shot.projectiles.map((s, i) => ({ i, x: s.x, y: s.y, vx: s.vx, vy: s.vy, gravity: weapon.gravity, age: 0, spawn: s.spawn, follow: !!s.follow, state: 'pending', path: null, retIdx: 0 }));
  for (let f = 1; f <= shot.flightFrames; f++) {
    cm.step();
    const evs = shot.events.filter(ev => ev.f === f);
    for (const p of projs) {
      if (p.state === 'pending' && p.spawn === f) {
        p.state = 'flying';
        const a = cm.byId(shot.actorId);
        if (p.follow && a && a.alive) { const mz = a.muzzle(); p.x = mz.x; p.y = mz.y; }
        if (weapon.boomerang) p.path = [{ x: p.x, y: p.y }];
      }
      if (p.state === 'returning') {
        const a = cm.byId(shot.actorId);
        stepReturn(p, weapon.returnSpeed || 1, a && a.alive ? a.muzzle() : null, weapon.homingSpeed);
      }
      else if (p.state === 'flying') advanceProjectile(null, p, CONFIG.FIXED_DT);
      else continue;
      const mine = evs.filter(ev => ev.p === p.i);
      if (mine.length && mine[0].type !== 'catch' && p.state === 'flying') {
        // 客戶端自己推進的位置，離伺服器的撞擊點不會超過一幀的飛行距離（出發點錯了就會差很多）
        const reach = Math.hypot(p.vx, p.vy) * CONFIG.FIXED_DT + 2;
        const off = Math.hypot(p.x - mine[0].x, p.y - mine[0].y);
        assert(off <= reach, `client projectile #${p.i} is ${off.toFixed(1)}px from the server event at f${f} (max ${reach.toFixed(1)})`);
      }
      for (const ev of mine) {
        if (ev.type === 'catch') assert(Math.abs(p.x - ev.x) < 1e-9 && Math.abs(p.y - ev.y) < 1e-9, 'client boomerang return path matches server');
        p.x = ev.x; p.y = ev.y;
        if (ev.vx !== undefined) { p.vx = ev.vx; p.vy = ev.vy; }
        if (ev.type === 'return') { p.state = 'returning'; p.retIdx = p.path.length; }
        else if (ev.type !== 'bounce' && ev.type !== 'pierce') p.state = 'done';
        if (ev.carve) cm.terrain.carve(ev.carve.x, ev.carve.y, ev.carve.r);
        for (const s of ev.ents || []) cm.byId(s.id).applyEventState(s);
      }
      if (!mine.length && p.state === 'flying' && p.path) p.path.push({ x: p.x, y: p.y });
    }
  }
  for (let n = 0; n < shot.settleFrames + 60; n++) { cm.step(); if (cm.isSettled()) break; }
  return projs;
}

test('武器牌：驗證武器 id；已有的武器不會再出；沒有那把武器時只對它有用的牌不出；武器欄滿要丟一把', () => {
  assert(cardById('boomerang').weapon === 'boomerang' && cardById('plasma').weapon === 'plasma', 'weapon cards loaded');
  assert(cardById('hd_scope').requires === 'sniper' && cardById('ap_rounds').requires === 'cannon' && cardById('war_drum').requires === null, 'weapon-only cards detected');
  const bad = validateCards({ cards: [{ id: 'w', rarity: 'green', weapon: 'bombard' }, { id: 'v', rarity: 'green', weapon: 'laser' }] });
  assert(bad.cards.length === 0 && bad.warnings.length === 2, 'unknown / non-equippable weapon rejected: ' + bad.warnings.join('; '));
  const rng = new Rng(4);
  for (let i = 0; i < 400; i++) {
    const a = drawOffers(CARDS.cards, rng, 9, 3, [], ['cannon', 'sniper', 'boomerang']);
    assert(!a.some(c => c.weapon === 'boomerang'), 'owned weapon offered again');
    const b = drawOffers(CARDS.cards, rng, 9, 3, [], ['cannon', 'boomerang', 'plasma']);
    assert(!b.some(c => c.requires === 'sniper'), 'sniper-only card offered without a sniper: ' + b.map(c => c.id));
  }
  const full = ['cannon', 'sniper', 'boomerang'];
  assert(!needsDiscard(['cannon', 'sniper'], cardById('plasma')) && needsDiscard(full, cardById('plasma')) && !needsDiscard(full, cardById('war_drum')), 'needsDiscard');
  assert(equipWeapon(['cannon', 'sniper'], cardById('plasma')).weapons.join() === 'cannon,sniper,plasma', 'third weapon goes to the empty slot');
  const sw = equipWeapon(full, cardById('plasma'), 'sniper');
  assert(sw.weapons.join() === 'cannon,plasma,boomerang' && sw.discarded === 'sniper', 'swap keeps slot order');
  assert(equipWeapon(full, cardById('plasma'), 'laser').weapons === full, 'invalid discard keeps the loadout');
});

test('肉鴿流程：第 3 把武器直接裝上；第 4 把一定要指定丟哪把；超時隨機不挑要丟武器的牌；武器欄帶進下一關', () => {
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(1), seed: 5, io, cards: CARDS.cards });
  run.start();
  io.advance(2000);
  toPickPhase(io, run, { p1: ['boomerang', 'war_drum'] });
  assert(io.take('stageClear').at(-1).weapons.p1.join() === 'cannon,sniper', 'stageClear carries loadout');
  run.handle('p1', { t: 'pick', cardId: 'boomerang' });
  assert(advanceUntil(io, () => run.phase === 'battle' && run.stage === 2), 'stage 2');
  assert(run.players.get('p1').weapons.join() === 'cannon,sniper,boomerang', 'boomerang equipped');
  assert(run.match.byId('p1').weapons.join() === 'cannon,sniper,boomerang', 'loadout carried into the match');

  io.advance(2000);
  const sniperCard = validateCards({ cards: [{ id: 'sniper_card', rarity: 'green', weapon: 'sniper' }] }).cards[0];
  toPickPhase(io, run, { p1: ['plasma', 'war_drum'] });
  run.handle('p1', { t: 'pick', cardId: 'plasma' });
  assert(!run.picks.p1, 'weapon pick without discard is refused when the loadout is full');
  run.handle('p1', { t: 'pick', cardId: 'plasma', discard: 'laser' });
  assert(!run.picks.p1, 'discarding a weapon you do not have is refused');
  run.handle('p1', { t: 'pick', cardId: 'plasma', discard: 'sniper' });
  assert(io.take('picked').some(x => x.playerId === 'p1' && x.cardId === 'plasma'), 'pick with discard accepted');
  assert(advanceUntil(io, () => run.phase === 'battle' && run.stage === 3), 'stage 3');
  assert(run.players.get('p1').weapons.join() === 'cannon,plasma,boomerang', 'plasma replaced the sniper in its slot');
  const picks = io.take('picks').at(-1).summary[0];
  assert(picks.discarded === 'sniper' && picks.weapons.join() === 'cannon,plasma,boomerang', 'picks summary');

  io.advance(2000);
  toPickPhase(io, run, { p1: [sniperCard, 'war_drum'] });
  io.advance(CONFIG.RUN.pickTime * 1000 + 100);   // 不選 → 隨機，不會挑要丟武器的那張
  assert(run.players.get('p1').cards.at(-1).id === 'war_drum', 'timeout pick avoided the discard card');
  assert(run.players.get('p1').weapons.join() === 'cannon,plasma,boomerang', 'loadout unchanged');
  return { weapons: run.players.get('p1').weapons };
});

test('裁判：只能用自己武器欄裡的武器開火 / 切換', () => {
  const m = matchWith({}, { weapons: ['boomerang', 'plasma'] });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000);
  const p1 = m.byId('p1');
  assert(p1.weapon === 'boomerang', 'first slot is in hand');
  ref.handle('p1', { t: 'weapon', weapon: 'sniper' });
  assert(p1.weapon === 'boomerang' && !io.take('weapon').length, 'switching to a weapon you do not have is ignored');
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: p1.x, y: p1.y, facing: 1, stamina: 100 });
  assert(!io.take('shot').length && ref.phase === 'turn', 'firing a weapon you do not have is ignored');
  ref.handle('p1', { t: 'fire', weapon: 'plasma', angle: 45, power: 50, x: p1.x, y: p1.y, facing: 1, stamina: 100 });
  assert(io.take('shot').length === 1, 'firing your own weapon works');
});

test('吸血、健壯藥丸減傷、弒神者、狂戰之斧（每回合 +1%，上限 10%）、噬魂者（擊殺累積、帶進下一關）', () => {
  const w = CONFIG.WEAPONS.cannon;
  const m = matchWith({ lifestealPct: 50 }, { players: 2 });
  const [p1, p2] = m.players;
  const e1 = m.enemies[0];
  p1.hp = 1000;
  const hit = m.applyExplosion(e1.cx, e1.cy, w, p1, e1);
  assert(m.lifesteal(p1, hit) === 15 && p1.hp === 1015, 'lifesteal 50% of 30 = 15, hp=' + p1.hp);
  assert(m.lifesteal(p1, m.applyExplosion(p2.cx, p2.cy, w, p1, p2)) === 0, 'no lifesteal from friendly fire');
  const small = matchWith({ lifestealPct: 3 });
  const s1 = small.players[0];
  s1.hp = 1000;
  let healed = 0;
  for (let i = 0; i < 10; i++) healed += small.lifesteal(s1, small.applyExplosion(small.enemies[0].cx, small.enemies[0].cy, w, s1, small.enemies[0]));
  assert(healed >= 8 && healed <= 9, '3% of 300 accumulates to ~9, got ' + healed);

  const a = matchWith({ armorPct: 5 });
  const hpA = a.players[0].hp;
  a.applyExplosion(a.players[0].cx, a.players[0].cy, w, a.enemies[0], a.players[0]);
  assert(hpA - a.players[0].hp === Math.round(w.damage * 0.95), 'armor 5%');

  const b = matchWith({ bossDamagePct: 100 }, { levelId: 'treeGarden' });   // enemies[0] = 古樹之眼
  const boss = b.enemies[0];
  const hpB = boss.hp;
  b.applyExplosion(boss.cx, boss.cy, w, b.players[0], boss);
  assert(hpB - boss.hp === w.damage * 2, 'godslayer doubles boss damage: ' + (hpB - boss.hp));

  const r = matchWith({ rampDamagePct: 1, rampDamageMaxPct: 10 });
  const rp = r.players[0];
  const ramp = [1, 5, 10, 30].map(n => { rp.turnCount = n; return r.rampBonus(rp); });
  assert(ramp.join() === '1,5,10,10', 'ramp ' + ramp);
  rp.turnCount = 5;
  assert(Math.abs(r.damageMult(rp, w) - 1.05) < 1e-12, 'ramp feeds the damage multiplier');

  const s = matchWith({ damagePct: 20, killDamagePct: 5 });
  const sp = s.players[0];
  for (const e of s.enemies) e.hp = 1;
  const before = s.entities.filter(e => e.alive);
  s.applyExplosion(s.enemies[0].cx, s.enemies[0].cy, w, sp, s.enemies[0]);
  assert(s.creditKills(sp, before).length === 1 && sp.soulPct === 5, 'soul eater +5% per kill');
  assert(Math.abs(s.damageMult(sp, w) - 1.25) < 1e-12, 'soul bonus stacks with damagePct');

  // 噬魂者的累積跨關保留
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(1), seed: 2, io, cards: CARDS.cards });
  run.start();
  io.advance(2000);
  run.match.byId('p1').soulPct = 15;
  toPickPhase(io, run, { p1: ['war_drum'] });
  assert(advanceUntil(io, () => run.phase === 'battle' && run.stage === 2), 'stage 2');
  assert(run.match.byId('p1').soulPct === 15, 'soul bonus carried into the next stage');
  return { ramp, healed };
});

test('哈哈子彈：狙擊槍打到地形彈射一次（預覽線跟實際一致）；高倍率望遠鏡：子彈穿透角色', () => {
  const plain = matchWith({});
  const ev0 = plain.resolveShot(plain.players[0], 'sniper', -15, 100).events;
  assert(ev0[0].type === 'explode' && !ev0[0].target, 'plain sniper explodes on the ground');

  const m = matchWith({ sniperBounce: 1 });
  const p1 = m.players[0];
  const tr = traceShot(m.world, p1, CONFIG.WEAPONS.sniper, -15, 100, { bounces: 1 });
  const shot = m.resolveShot(p1, 'sniper', -15, 100);
  const [bounce, last] = shot.events;
  assert(bounce.type === 'bounce' && bounce.vy < 0 && bounce.vx > 0, 'bounced upwards: ' + JSON.stringify(bounce));
  assert(shot.events.length === 2 && ['out', 'explode', 'water'].includes(last.type), 'one bounce, then stops: ' + shot.events.map(e => e.type));
  assert(tr.points.length === 3 && Math.abs(tr.points[1].x - bounce.x) < 1e-9 && Math.abs(tr.points[1].y - bounce.y) < 1e-9, 'aim preview shows the same bounce point');
  for (const ang of [-6, -10, -20, -45]) {   // 打地面（含擦地射擊）要往前上方彈，像素階梯不能把它彈回頭
    const g = matchWith({ sniperBounce: 1 });
    const ge = g.resolveShot(g.players[0], 'sniper', ang, 100).events[0];
    assert(ge.type === 'bounce' && ge.vy < 0 && ge.vx > 0, `angle ${ang}: bounce forward-up, got ${JSON.stringify(ge)}`);
  }
  const wall = matchWith({ sniperBounce: 1 });
  const we = wall.resolveShot(wall.players[0], 'sniper', -4, 100).events[0];   // 打到中間平台左側的垂直牆
  assert(we.type === 'bounce' && Math.abs(we.x - 488) < 3 && we.vx < 0, 'wall bounce goes back: ' + JSON.stringify(we));

  const pm = matchWith({ sniperPierce: 1, sniperDamagePct: 25 });
  const [e1, e2] = pm.enemies;
  placeAt(pm, e1, 200);
  placeAt(pm, e2, 260);
  const ps = pm.resolveShot(pm.players[0], 'sniper', 0, 100);
  const pierced = ps.events.filter(e => e.type === 'pierce').map(e => e.target);
  assert(pierced.join() === 'e1,e2', 'pierced both: ' + ps.events.map(e => e.type + ':' + (e.target || '')));
  const dmg = Math.round(CONFIG.WEAPONS.sniper.damage * 1.25);
  assert(e1.maxHp - e1.hp === dmg && e2.maxHp - e2.hp === dmg, `each pierced target takes ${dmg}`);

  const np = matchWith({});
  placeAt(np, np.enemies[0], 200);
  placeAt(np, np.enemies[1], 260);
  const ns = np.resolveShot(np.players[0], 'sniper', 0, 100);
  assert(ns.events[0].type === 'explode' && ns.events[0].target === 'e1' && np.enemies[1].hp === np.enemies[1].maxHp, 'without the scope the first target stops the bullet');
  return { bounceAt: { x: Math.round(bounce.x), y: Math.round(bounce.y) }, pierced };
});

test('等離子飛彈：同一條彈道連射三發；迴力鏢：命中後沿原路飛回手上，只打直接命中的角色、不挖地', () => {
  const m = matchWith({}, { weapons: ['plasma'] });
  const shot = m.resolveShot(m.players[0], 'plasma', 45, 40);
  const P = CONFIG.WEAPONS.plasma;
  assert(shot.projectiles.length === P.volley && shot.projectiles.map(p => p.spawn).join() === '1,11,21', 'three missiles, 10 frames apart');
  assert(shot.projectiles.every(p => p.x === shot.projectiles[0].x && p.vx === shot.projectiles[0].vx && p.vy === shot.projectiles[0].vy), 'same trajectory');
  const ends = shot.events.filter(e => ['explode', 'water', 'out'].includes(e.type));
  assert(ends.length === 3 && ends.every(e => e.type !== 'explode' || e.carve.r === P.radius), 'each missile ends, radius 30: ' + shot.events.map(e => e.type));

  const b = matchWith({}, { weapons: ['boomerang'] });
  const p1 = b.players[0];
  const muzzle = p1.muzzle();
  const bt = b.resolveShot(p1, 'boomerang', -30, 30);
  const types = bt.events.map(e => e.type);
  assert(types.join() === 'return,catch' && !bt.events[0].damages, 'hit the ground, came back without damage: ' + types);
  assert(b.terrain.holes.length === 0, 'boomerang does not dig');
  const c = bt.events[1];
  assert(Math.abs(c.x - muzzle.x) < 1e-9 && Math.abs(c.y - muzzle.y) < 1e-9, 'caught at the hand');
  assert(c.f > bt.events[0].f, 'return trip takes time');

  const h = matchWith({}, { weapons: ['boomerang'] });
  const e1 = h.enemies[0];
  placeAt(h, e1, 150);
  const hs = h.resolveShot(h.players[0], 'boomerang', 0, 50);
  const hitEv = hs.events[0];
  assert(hitEv.type === 'return' && hitEv.target === 'e1', 'boomerang hit e1: ' + JSON.stringify(hitEv).slice(0, 120));
  assert(hitEv.damages.length === 1 && hitEv.damages[0].dmg === CONFIG.WEAPONS.boomerang.damage, 'only the direct hit takes 25');
  assert(hitEv.ents.find(s => s.id === 'e1').vx > 0, 'knocked back');
  assert(hs.events.at(-1).type === 'catch', 'comes back after the hit');

  // 在空中丟：角色在迴力鏢飛回來之前就掉下去了，要追到他「現在」的手上接住，而不是停在出手的空中
  const air = matchWith({}, { weapons: ['boomerang'] });
  const ap = air.players[0];
  ap.y -= 70; ap.vy = 0;
  const fireMuzzle = ap.muzzle();
  const hands = [];
  const step = air.step.bind(air);
  air.step = (dt) => { step(dt); hands.push(ap.muzzle()); };
  const as = air.resolveShot(ap, 'boomerang', 20, 45);
  const ac = as.events.find(e => e.type === 'catch');
  assert(ac, 'boomerang came back: ' + as.events.map(e => e.type + '@' + e.f).join(' '));
  const hand = hands[ac.f - 1];
  assert(Math.abs(ac.x - hand.x) < 1e-9 && Math.abs(ac.y - hand.y) < 1e-9, `caught at the thrower's current hand: ${JSON.stringify(ac)} vs ${JSON.stringify(hand)}`);
  assert(ac.y > fireMuzzle.y + 30, `the thrower had fallen well below the throw point: catch y ${ac.y.toFixed(1)} vs throw y ${fireMuzzle.y.toFixed(1)}`);
  return { plasmaEnds: ends.map(e => e.type), boomerangFrames: hs.flightFrames };
});

test('燃燒：燃燒子彈 / 反裝甲子彈附加層數；回合結束依移動距離甩掉（每回合最多 10 層），剩下每層扣最大血量 0.1%', () => {
  const w = CONFIG.WEAPONS;
  const B = CONFIG.EQUIP.burn;
  const m = matchWith({ burnStacks: 30, cannonBurnStacks: 20 }, { players: 2, hp: 10000 });
  const [p1, p2] = m.players;
  const [e1, e2] = m.enemies;
  const d1 = m.applyExplosion(e1.cx, e1.cy, w.cannon, p1, e1, { burn: 50 });
  assert(e1.burn === 50 && e1.burnSource === 'p1' && d1.find(d => d.id === 'e1').burn === 50, 'cannon hit adds 30 + 20 stacks');
  m.applyExplosion(p2.cx, p2.cy, w.cannon, p1, p2, { burn: 50 });
  assert(p2.burn === 0, 'teammates do not burn');
  // 走了 55px → 甩掉 5 層，剩 45 層 × 每層 0.1% × 最大血量 10000 = 450 傷害
  e1.movedThisTurn = 55;
  const hp0 = e1.hp;
  const fx = m.endTurn(e1);
  const tick = Math.floor(45 * B.pctPerStack / 100 * e1.maxHp);
  assert(e1.burn === 45 && hp0 - e1.hp === tick, 'burn tick: stacks=' + e1.burn + ' dmg=' + (hp0 - e1.hp));
  assert(fx[0].type === 'burn' && fx[0].shaken === 5 && fx[0].dmg === tick, 'fx ' + JSON.stringify(fx));
  e1.movedThisTurn = 5000;
  m.endTurn(e1);
  assert(e1.burn === 45 - B.maxReducePerTurn, 'at most 10 stacks shaken per turn');
  // 實際開火：燃燒子彈讓每個被炸到的敵人都燒起來
  const s = matchWith({ burnStacks: 30 }, { weapons: ['plasma'], hp: 10000 });
  placeAt(s, s.enemies[0], 200);
  s.resolveShot(s.players[0], 'plasma', 0, 60);
  assert(s.enemies[0].burn > 0 && s.enemies[0].burn % 30 === 0, 'plasma hits apply burn, stacks=' + s.enemies[0].burn);
  // 燒死算擊殺（噬魂者）
  const k = matchWith({ killDamagePct: 5 });
  const ke = k.enemies[0];
  ke.hp = 1; ke.burn = 30; ke.burnSource = 'p1';
  const kfx = k.endTurn(ke);
  assert(!ke.alive && k.players[0].soulPct === 5 && kfx.some(f => f.type === 'soul'), 'burn kill credited to the burner');
  e2.burn = 0;
  assert(m.endTurn(e2).length === 0, 'no fx when not burning');
});

test('恩賜之杖每回合回血 1%；祈願之杖全隊回血 50%；胖老爹全家桶回血、移速 -1%、體型 +1%；體型會改變碰撞框', () => {
  const m = matchWith({ regenPct: 1 });
  const p1 = m.players[0];
  p1.hp = 1000;
  const fx = m.turnStartEffects(p1);
  assert(p1.hp === 1050 && fx[0].amount === 50, 'regen 1% of 5000');

  const st = baseStats();
  applyCardForTest(st, 'family_bucket');
  applyCardForTest(st, 'titan_frame');
  const d = derivePlayerStats(st);
  assert(Math.abs(d.size - 1.11) < 1e-12 && Math.abs(d.moveSpeed - CONFIG.PLAYER.moveSpeed * 0.99) < 1e-9, 'size / speed ' + JSON.stringify(d));
  const big = new Match({ players: mkPlayers(1), seed: 1, carry: { p1: { size: d.size } } }).players[0];
  assert(Math.abs(big.hw - 9 * 1.11) < 1e-9 && Math.abs(big.h - 30 * 1.11) < 1e-9, 'hitbox scaled');

  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(2), seed: 6, io, cards: CARDS.cards });
  run.start();
  io.advance(2000);
  run.match.byId('p1').hp = 20;
  run.match.byId('p2').hp = 30;
  toPickPhase(io, run, { p1: ['wish_staff'], p2: ['strong_head'] });
  run.handle('p1', { t: 'pick', cardId: 'wish_staff' });
  run.handle('p2', { t: 'pick', cardId: 'strong_head' });
  const P = CONFIG.PLAYER.hp;
  const clearHeal = Math.round(P * CONFIG.RUN.healPctOnClear);
  const team = cardById('wish_staff').effects.teamHealPct / 100, up = cardById('strong_head').effects.maxHp;   // 照牌庫現在的數值算
  const exp1 = Math.min(P, 20 + clearHeal + Math.round(P * team));
  const exp2 = Math.min(P + up, Math.round(30 + clearHeal + up + (P + up) * team));
  const sum = io.take('picks').at(-1).summary;
  assert(sum.find(s => s.playerId === 'p1').hp === exp1 && sum.find(s => s.playerId === 'p2').hp === exp2,
    `team heal uses each player's new max: ${JSON.stringify(sum)} expected ${exp1}/${exp2}`);
  return { p1: exp1, p2: exp2 };
});
function applyCardForTest(stats, id) {
  for (const [k, v] of Object.entries(cardById(id).effects)) if (k in stats) stats[k] += v;
}

test('神佑之石：持有者每過 3 回合，全隊獲得一次無敵，擋下下一次傷害（也不會被擊退）', () => {
  const w = CONFIG.WEAPONS.cannon;
  const m = matchWith({ teamShield: 1 }, { players: 2 });
  const [p1, p2] = m.players;
  const e1 = m.enemies[0];
  p1.turnCount = 2;
  assert(!m.endTurn(p1).length && p2.shield === 0, 'no shield after 2 turns');
  p1.turnCount = 3;
  const fx = m.endTurn(p1);
  assert(fx[0].type === 'shield' && fx[0].ids.join() === 'p1,p2' && p1.shield === 1 && p2.shield === 1 && e1.shield === 0, 'team shield after 3 turns');
  m.endTurn(p1);
  assert(p2.shield === 1, 'shield does not stack');
  const hp = p2.hp;
  const d = m.applyExplosion(p2.cx, p2.cy, w, e1, p2);
  assert(d[0].blocked && p2.hp === hp && p2.vx === 0 && p2.shield === 0, 'blocked hit: no damage, no knockback');
  m.applyExplosion(p2.cx, p2.cy, w, e1, p2);
  assert(p2.hp < hp, 'the next hit lands');
});

test('裁判：無差別轟炸在回合開始先播（持有者附近不落彈、炸不到自己、會波及隊友），播完才開始計時', () => {
  const m = matchWith({ bombard: 1 }, { players: 2 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(2), io });
  const [p1, p2] = m.players;
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000);
  const shot = io.take('shot')[0];
  assert(shot && shot.kind === 'bombard' && shot.actorId === 'p1', 'bombard shot at turn start');
  assert(!io.take('turn').length && ref.phase === 'resolving', 'turn has not started yet');
  const B = CONFIG.EQUIP.bombard;
  assert(shot.projectiles.length > 8 && shot.projectiles.every(p => Math.abs(p.x - p1.x) >= B.safeDist), 'no missile near the holder');
  assert(p1.hp === p1.maxHp, 'holder is not hurt');
  assert(p2.hp < p2.maxHp, 'teammate outside the safe zone is hit');
  assert(m.enemies.every(e => e.hp < e.maxHp), 'every enemy is hit');
  const secs = (shot.flightFrames + shot.settleFrames) / 60 + CONFIG.TIMING.afterShotPad;
  io.advance(secs * 1000 - 50);
  assert(!io.take('turn').length, 'turn waits for the bombard animation');
  io.advance(100);
  const turn = io.take('turn')[0];
  assert(turn && turn.actorId === 'p1' && !turn.ai && ref.phase === 'turn', 'then p1 turn starts');
  return { missiles: shot.projectiles.length, p2Dmg: p2.maxHp - p2.hp };
});

test('裁判：燃燒在敵人自己的回合結束時結算，廣播 turnFx 後才輪下一位；恩賜之杖在回合開始回血', () => {
  const m = matchWith({ regenPct: 1 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  const e1 = m.enemies[0];
  e1.burn = 30;
  m.players[0].hp = 1000;
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000);
  const t1 = io.take('turn')[0];
  assert(t1.actorId === 'p1' && t1.fx[0].type === 'heal' && t1.fx[0].amount === 50, 'regen fx on turn start: ' + JSON.stringify(t1.fx));
  io.advance(31_000);   // p1 超時 → e1 的 AI 回合
  assert(advanceUntil(io, () => io.take('turn').some(t => t.actorId === 'e2')), 'e2 turn after e1');
  const fx = io.take('turnFx')[0];
  assert(fx, 'turnFx broadcast');
  const burn = fx.fx.find(f => f.type === 'burn');
  assert(fx.actorId === 'e1' && burn && burn.id === 'e1', 'burn settled at the end of e1 turn: ' + JSON.stringify(fx.fx));
  const order = io.log.filter(x => ['aiTurn', 'turnFx', 'turn'].includes(x.t)).map(x => x.t + ':' + (x.actorId || ''));
  const i = order.indexOf('turnFx:e1');
  assert(order[i - 1] === 'aiTurn:e1' && order[i + 1] === 'turn:e2', 'order ' + order.join(' '));
  return { burn };
});

test('客戶端照事件重播（只跑運動學）的結果，跟伺服器結算位元級一致：大砲 / 彈射+穿透狙擊 / 等離子 / 迴力鏢 / 轟炸 / 落水重生', () => withWater(() => {
  const cases = [
    { name: 'cannon', fx: {}, weapons: undefined, fire: (m) => m.resolveShot(m.players[0], 'cannon', 40, 55) },
    { name: 'sniper', fx: { sniperBounce: 1, sniperPierce: 1 }, place: true, fire: (m) => m.resolveShot(m.players[0], 'sniper', -6, 100) },
    { name: 'plasma', fx: { burnStacks: 30, lifestealPct: 3 }, weapons: ['plasma'], fire: (m) => m.resolveShot(m.players[0], 'plasma', 30, 45) },
    { name: 'boomerang', fx: {}, weapons: ['boomerang'], place: true, fire: (m) => m.resolveShot(m.players[0], 'boomerang', 0, 50) },
    { name: 'bombard', fx: {}, players: 2, fire: (m) => m.resolveBombard(m.players[0]) },
    { name: 'airborne', fx: {}, fire: (m) => { const a = m.players[0]; a.y -= 70; a.vy = -120; return m.resolveShot(a, 'cannon', 50, 45); } },
    // 空中丟迴力鏢：回程時射手已經掉下去了，要追到他現在的手上
    { name: 'air-boomerang', fx: {}, weapons: ['boomerang'], fire: (m) => { const a = m.players[0]; a.y -= 70; a.vy = -200; return m.resolveShot(a, 'boomerang', -30, 30); } },
    // 起跳後馬上往上低吊（射手跟著往上飛）
    // （伺服器在玩家回合不推進別人，所以只讓射手自己跳一幀，跟實際流程一樣）
    { name: 'jump-lob', fx: {}, weapons: ['plasma'], fire: (m) => { const a = m.players[0]; a.stamina = a.maxStamina; a.wantJump = true; a.update(CONFIG.FIXED_DT, m.world); return m.resolveShot(a, 'plasma', 80, 15); } },
    // 隊友換過位置（站穩點只能從快照同步過去）、腳下被挖到水面以下 → 掉進水裡扣血，原本站的地方也沒了 → 兩邊找到同一個最近的地面重生
    { name: 'water-respawn', fx: {}, players: 2, setup: (m) => {
        const b = m.players[1];   // 像是自己走過去站好（不跑 settle：別人在斜坡上抖的那 1px 不在快照裡）
        b.x = b.safeX = 250;
        b.y = b.safeY = standY(b, m.terrain, 250);
        for (let y = b.y - 10; y < 720; y += 20) m.terrain.carve(b.x, y, 34);
      },
      fire: (m) => m.resolveShot(m.players[0], 'sniper', 80, 100) },
    // 敵人腳下被挖空 → 掉進水裡直接淹死（兩邊都要判定淹死）
    { name: 'water-enemy', fx: {}, setup: (m) => { const b = m.enemies[1]; for (let y = b.y - 10; y < 720; y += 20) m.terrain.carve(b.x, y, 34); },
      fire: (m) => m.resolveShot(m.players[0], 'sniper', 80, 100) },
    // 射手這回合走到別處站過（伺服器記的站穩點，客戶端不知道）再跳到坑上開火、掉進水裡：照 shot.actor 帶的站穩點重生
    { name: 'water-self', fx: {}, setup: (m) => { for (let y = 430; y < 720; y += 20) m.terrain.carve(220, y, 34); },
      fire: (m) => {
        const a = m.players[0];
        a.hp = 30;   // 伺服器上這回合已經掉過血（客戶端快照不知道）：重播要照 shot.actor 帶的血量
        m.setPlayerPosition(a, 150, standY(a, m.terrain, 150), 1, a.stamina);
        m.setPlayerPosition(a, 220, 380, 1, a.stamina);
        return m.resolveShot(a, 'sniper', 80, 100);
      } },
  ];
  // 記錄射手每一幀物理的位置：兩邊的軌跡要完全一樣（不只最後落地的位置）
  const traceSteps = (match, id, out) => {
    const step = match.step.bind(match);
    match.step = (dt) => { step(dt); const a = match.byId(id); out.push(a.x, a.y); };
  };
  const out = {};
  for (const c of cases) {
    const m = matchWith(c.fx, { players: c.players || 1, weapons: c.weapons, hp: 60 });
    if (c.place) { placeAt(m, m.enemies[0], 150); placeAt(m, m.enemies[1], 230); }
    if (c.setup) c.setup(m);
    const snap = m.snapshot();
    const cm = new Match({ levelId: m.levelId, players: mkPlayers(c.players || 1), seed: m.seed, carry: m.carry });
    cm.applySnapshot(snap);
    const serverTrace = [], clientTrace = [];
    // c.fire 裡開火前的準備動作（例如起跳那一幀）不算：開始結算時才掛上記錄
    for (const fn of ['resolveShot', 'resolveBombard']) {
      const orig = m[fn].bind(m);
      m[fn] = (...a) => { traceSteps(m, 'p1', serverTrace); return orig(...a); };
    }
    const shot = JSON.parse(JSON.stringify(c.fire(m)));   // 跟網路一樣走一趟 JSON
    traceSteps(cm, 'p1', clientTrace);
    replayLikeClient(cm, shot);
    for (const s of shot.results) {
      const e = cm.byId(s.id);
      assert(e.x === s.x && e.y === s.y && e.hp === s.hp && e.alive === s.alive, `${c.name}: ${s.id} client ${e.x},${e.y},${e.hp},${e.alive} vs server ${s.x},${s.y},${s.hp},${s.alive}`);
      assert(e.waterFalls === m.byId(s.id).waterFalls && e.safeX === s.sx && e.safeY === s.sy, `${c.name}: ${s.id} water falls / safe spot differ`);
    }
    if (c.name === 'water-respawn') {
      const b = m.players[1];
      assert(b.waterFalls === 1 && b.alive && b.hp === 60 - 18 && b.x !== snap.entities.find(s => s.id === b.id).x && b.canStandAt(m.terrain, b.x, b.y),
        `water-respawn: teammate fell in and respawned beside the hole (${b.waterFalls} falls, hp ${b.hp}, at ${b.x},${b.y})`);
    }
    if (c.name === 'water-enemy') {
      const b = m.enemies[1], cb = cm.byId(b.id);
      assert(!b.alive && b.deathCause === 'water' && !cb.alive && cb.deathCause === 'water', `water-enemy: enemy drowned on both sides (${b.alive}/${cb.alive})`);
    }
    if (c.name === 'water-self') {
      const a = m.players[0];
      assert(a.waterFalls === 1 && a.alive && a.hp === 30 - 18 && a.x === 150, `water-self: shooter respawned where he last stood on the server (${a.waterFalls} falls, at ${a.x},${a.y})`);
    }
    assert(serverTrace.length > 0 && serverTrace.length === clientTrace.length && serverTrace.every((v, i) => v === clientTrace[i]),
      `${c.name}: shooter trajectory differs (server ${serverTrace.length / 2} frames, client ${clientTrace.length / 2})`);
    assert(Buffer.compare(Buffer.from(cm.terrain.mask), Buffer.from(m.terrain.mask)) === 0, c.name + ': terrain differs');
    out[c.name] = shot.events.map(e => e.type).join('>');
  }
  return out;
}));

test('雲霧之瓶：空中可以再跳一次（一樣扣體力、落地補滿）；沒有這張牌不能二段跳', () => {
  const J = CONFIG.PLAYER.jumpCost;
  const apex = (m, p, jumpAtFrame) => {   // 起跳後在第 jumpAtFrame 幀再按一次跳，回傳最高點
    p.stamina = p.maxStamina;
    p.wantJump = true;
    let top = p.y;
    for (let f = 1; f < 200; f++) {
      if (f === jumpAtFrame) p.wantJump = true;
      m.step();
      top = Math.min(top, p.y);
      if (f > 2 && p.onGround) break;
    }
    return top;
  };
  const d = matchWith({ extraJumps: 1 });
  const p = d.players[0];
  const ground = p.y;
  p.stamina = p.maxStamina;
  p.wantJump = true; d.step();
  assert(!p.onGround && p.vy < 0 && p.stamina === p.maxStamina - J, 'ground jump costs stamina');
  for (let i = 0; i < 8; i++) d.step();
  p.wantJump = true; d.step();
  assert(p.vy < -p.jumpSpeed + 20 && p.stamina === p.maxStamina - 2 * J && p.airJumpsLeft === 0, 'air jump resets vy and costs stamina');
  const st = p.stamina, vy = p.vy;
  p.wantJump = true; d.step();
  assert(p.stamina === st && p.vy > vy, 'no third jump');
  for (let i = 0; i < 300 && !(p.onGround && p.vy === 0); i++) d.step();
  assert(p.onGround && p.airJumpsLeft === 1, 'air jumps refill on landing');
  p.stamina = J - 1;
  p.wantJump = true; d.step();
  assert(p.onGround && p.stamina === J - 1, 'no stamina, no jump');

  const single = matchWith({});
  const s = single.players[0];
  s.stamina = s.maxStamina;
  s.wantJump = true; single.step();
  for (let i = 0; i < 8; i++) single.step();
  const st2 = s.stamina;
  s.wantJump = true; single.step();
  assert(s.stamina === st2, 'without the card there is no air jump');

  const m1 = matchWith({});
  const y1 = m1.players[0].y;
  const high1 = y1 - apex(m1, m1.players[0], 0);
  const m2 = matchWith({ extraJumps: 1 });
  const y2 = m2.players[0].y;
  const high2 = y2 - apex(m2, m2.players[0], 20);
  assert(high1 > 40 && high2 > high1 * 1.5, `double jump goes higher: ${high2.toFixed(1)} vs ${high1.toFixed(1)}`);
  assert(ground === y1, 'same spawn');
  return { singleJump: Math.round(high1), doubleJump: Math.round(high2) };
});

test('空中開火：照回報的空中位置出手（不先落地）、帶著垂直速度落下；vy 會被夾在合理範圍', () => {
  const run = (vy) => {
    const m = matchWith({});
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: mkPlayers(1), io });
    ref.start();
    io.advance(CONFIG.TIMING.startDelay * 1000);
    const p1 = m.byId('p1');
    const air = p1.y - 60;
    ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 60, power: 40, x: p1.x, y: air, vy, facing: 1, stamina: 100 });
    return { shot: io.take('shot')[0], air, p1, ref };
  };
  const { shot, air, p1, ref } = run(-150);
  assert(shot && shot.actor.y === air && shot.actor.vy === -150, 'fired from the reported mid-air position: ' + JSON.stringify(shot && shot.actor));
  assert(shot.projectiles[0].y < air, 'muzzle is in the air too');
  const after = shot.results.find(s => s.id === 'p1');
  assert(after.y > air + 50 && p1.onGround, 'fell down and landed after the shot, y=' + after.y);
  assert(ref.phase === 'resolving', 'shot accepted');
  assert(run(-99999).shot.actor.vy === -CONFIG.PLAYER.jumpSpeed && run(99999).shot.actor.vy === 1400, 'vy clamped');
  assert(run(undefined).shot.actor.vy === 0, 'missing vy → 0');
  return { air: Math.round(air), landed: Math.round(after.y) };
});

test('空中開火不會一出手就炸到自己（射手跟著往上飛、子彈還沒離開身體時）', () => {
  const hits = [];
  for (const [w, ang, pow] of [['cannon', 75, 10], ['cannon', 80, 15], ['plasma', 90, 20], ['plasma', 80, 10], ['boomerang', 90, 10], ['boomerang', 75, 10]]) {
    for (const k of [1, 3, 6, 10]) {   // 起跳後第 k 幀開火（往上飛得最快的時候）
      const m = matchWith({}, { weapons: [w] });
      const p = m.players[0];
      p.stamina = p.maxStamina;
      p.wantJump = true;
      for (let i = 0; i < k; i++) m.step();
      const early = m.resolveShot(p, w, ang, pow).events.find(e => e.target === 'p1' && e.f <= 20);
      if (early) hits.push(`${w} ${ang}°/${pow} k=${k} f=${early.f}`);
    }
  }
  assert(!hits.length, 'self-hit right after firing mid-jump: ' + hits.join('; '));
  // 站著往正上方打，砲彈掉下來還是會打到自己（這是本來就有的規則）
  const g = matchWith({});
  assert(g.resolveShot(g.players[0], 'cannon', 90, 10).events[0].target === 'p1', 'a shell that comes back down still hits the shooter');
});

test('雲霧之瓶：站在斜坡的像素階梯上、或走下坡時起跳，二段跳也不會被吃掉', () => {
  const lost = [];
  const tryDouble = (m, p, label) => {
    p.stamina = p.maxStamina;
    p.wantJump = true;
    m.step();
    if (!(p.vy < 0)) { lost.push(label + ' (no first jump)'); return; }
    for (let i = 0; i < 15; i++) m.step();
    const st = p.stamina;
    p.wantJump = true;
    m.step();
    if (p.stamina !== st - p.jumpCost) lost.push(label);
  };
  for (const x of [112, 150, 300, 552]) {
    for (let phase = 0; phase < 24; phase++) {
      const m = matchWith({ extraJumps: 1 });
      const p = m.players[0];
      placeAt(m, p, x);
      for (let i = 0; i < phase; i++) m.step();
      tryDouble(m, p, `stand x=${x} phase=${phase}`);
    }
  }
  for (let phase = 0; phase < 90; phase++) {
    const m = matchWith({ extraJumps: 1 });
    const p = m.players[0];
    p.moveDir = 1;
    for (let i = 0; i < phase; i++) m.step();
    p.moveDir = 0;
    tryDouble(m, p, `walk phase=${phase}`);
  }
  // 二段跳落地前一幀（還沒 onGround、但腳下 3px 內有地）就按跳：算地面起跳，空中跳躍次數要補滿
  let landingCases = 0;
  for (let delay = 0; delay < 30; delay++) {
    const m = matchWith({ extraJumps: 1 });
    const p = m.players[0];
    p.maxStamina = p.stamina = 1000;
    p.wantJump = true; m.step();
    for (let i = 0; i < 10 + delay; i++) m.step();
    p.wantJump = true; m.step();   // 空中跳
    let f = 0;
    while (f++ < 200 && !(p.nearGround(m.terrain) && !p.onGround)) m.step();
    if (p.onGround || f >= 200) continue;
    landingCases++;
    p.wantJump = true; m.step();
    for (let i = 0; i < 12; i++) m.step();
    const st = p.stamina;
    p.wantJump = true; m.step();
    if (p.stamina !== st - p.jumpCost) lost.push(`landing-frame jump delay=${delay}`);
  }
  assert(landingCases > 0, 'no landing-frame case found');
  assert(!lost.length, `double jump lost ${lost.length}x: ` + lost.slice(0, 6).join('; '));
});

test('疊很多段跳也不會飛出畫面頂端（頭頂到 y=0 就停），伺服器照樣收得到那個位置', () => {
  const m = matchWith({ extraJumps: 5 });
  const p = m.players[0];
  p.jumpSpeed = 600;
  p.maxStamina = p.stamina = 1000;
  let top = p.y, topAt = null;
  for (let f = 0; f < 240; f++) {
    if (f % 12 === 0) p.wantJump = true;
    m.step();
    if (p.y < top) { top = p.y; topAt = { x: p.x, y: p.y }; }
  }
  assert(top < 100 && top - p.h >= 0, `climbed to ${top.toFixed(1)}, head ${(top - p.h).toFixed(1)}`);
  const s = matchWith({});
  const sp = s.players[0];
  sp.x = topAt.x; sp.y = topAt.y + 200;   // 前一次回報的位置在下面一點
  assert(s.setPlayerPosition(sp, topAt.x, topAt.y, 1, 100), 'server accepts the highest reachable position');
});

test('時間扭曲：普通回合結束後再給一個額外回合（不算新的一輪），之後冷卻 3 個普通回合', () => {
  const m = matchWith({ extraTurn: 1, damagePct: 15 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000);
  const p1e = m.byId('p1');
  ref.handle('p1', { t: 'move', x: p1e.x + 10, y: p1e.y, facing: 1, stamina: 40 });   // 第一個回合先花掉體力
  assert(p1e.stamina === 40 && p1e.turnCount === 1, 'spent stamina in the normal turn');
  assert(advanceUntil(io, () => io.take('turn').filter(t => t.actorId === 'p1').length >= 8, 1_500_000), 'enough p1 turns');
  const turns = io.take('turn').map(t => `${t.actorId}${t.extra ? '+' : ''}@${t.round}`);
  assert(turns.slice(0, 4).join() === 'p1@1,p1+@1,e1@1,e2@1', 'extra turn comes right after p1, same round: ' + turns.slice(0, 6).join());
  const mine = turns.filter(t => t.startsWith('p1'));
  const cd = CONFIG.EQUIP.extraTurnCooldown;
  const expected = ['p1@1', 'p1+@1'];
  for (let r = 2; r <= cd + 2; r++) expected.push(`p1@${r}`);
  expected.push(`p1+@${cd + 2}`);
  assert(mine.slice(0, expected.length).join() === expected.join(), `cooldown ${cd}: ${mine.join()} vs ${expected.join()}`);
  const fx = io.take('turnFx').filter(f => f.fx.some(x => x.type === 'extraTurn'));
  assert(fx.length >= 2 && fx.every(f => f.actorId === 'p1'), 'extraTurn fx broadcast');
  const extraTurn = io.take('turn').find(t => t.extra);
  const xs = extraTurn.entities.find(e => e.id === 'p1');
  assert(extraTurn.turnTime === CONFIG.TURN_TIME && !extraTurn.ai && xs.stamina === p1e.maxStamina && xs.turns === 2,
    `extra turn is a full turn (stamina refilled, turn counted): ${JSON.stringify({ stamina: xs.stamina, turns: xs.turns })}`);
  // 這一發已經打贏了：不給額外回合、也不播「再來一回合」
  const w = matchWith({ extraTurn: 1 });
  const wio = new FakeIo();
  const wref = new Referee({ match: w, humans: mkPlayers(1), io: wio });
  wref.start();
  wio.advance(CONFIG.TIMING.startDelay * 1000);
  for (const e of w.enemies) e.hp = 1;
  const wp = w.byId('p1');
  wref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: wp.x, y: wp.y, facing: 1, stamina: 100 });
  for (const e of w.enemies) e.die('hit');   // 不管打不打得中，結算完就當作全滅
  assert(advanceUntil(wio, () => wio.take('gameOver').length > 0), 'game over');
  assert(!wio.take('turnFx').some(f => f.fx.some(x => x.type === 'extraTurn')) && !wio.take('turn').some(t => t.extra), 'no extra turn after the winning shot');
  const noCard = matchWith({});
  const io2 = new FakeIo();
  new Referee({ match: noCard, humans: mkPlayers(1), io: io2 }).start();
  advanceUntil(io2, () => io2.take('turn').filter(t => t.actorId === 'p1').length >= 2, 300_000);
  assert(!io2.take('turn').some(t => t.extra), 'no extra turns without the card');
  return { order: mine.slice(0, expected.length) };
});

test('狂熱：每過 10 輪，所有角色（含敵人、誤傷、燃燒）的傷害 +50%，會疊加；裁判每輪更新、每關重算', () => {
  const saved = { ...CONFIG.FEVER };
  Object.assign(CONFIG.FEVER, { everyRounds: 10, damagePct: 50, inBoss: false });   // 測試不受使用者在 config 調的數值影響
  try {
    const stacks = [0, 1, 10, 11, 20, 21, 31].map(feverStacks);
    assert(stacks.join() === '0,0,0,1,1,2,3', 'stacks by round ' + stacks.join());
    CONFIG.FEVER.everyRounds = 0;   // 0 = 關掉狂熱（不能變成除以 0 的無限層）
    assert([11, 100].every(r => feverStacks(r) === 0), 'everyRounds 0 disables fever: ' + feverStacks(100));
    CONFIG.FEVER.everyRounds = 10;
    const w = CONFIG.WEAPONS.cannon;
    const m = matchWith({}, { players: 2, hp: 10000 });
    const [p1, p2] = m.players;
    const e1 = m.enemies[0];
    const hit = (target, attacker) => { const h = target.hp; m.applyExplosion(target.cx, target.cy, w, attacker, target); return h - target.hp; };
    assert(hit(e1, p1) === w.damage, 'no fever: base damage');
    m.fever = 1;
    assert(hit(e1, p1) === Math.round(w.damage * 1.5), 'fever 1: player → enemy +50%');
    assert(hit(p1, e1) === Math.round(w.damage * 1.5), 'fever 1: enemy → player +50%');
    assert(hit(p2, p1) === Math.round(w.damage * CONFIG.FRIENDLY_FIRE * 1.5), 'fever 1: friendly fire +50%');
    m.fever = 2;
    assert(hit(e1, p1) === Math.round(w.damage * 2), 'fever 2: +100% (additive stacking)');
    // 燃燒：45 層 × 0.1% × 10000 = 450，狂熱 1 層 → 675
    m.fever = 1;
    const B = CONFIG.EQUIP.burn;
    const e2 = m.enemies[1];
    e2.burn = 45; e2.burnFrac = 0; e2.movedThisTurn = 0;
    const hp0 = e2.hp;
    m.endTurn(e2);
    assert(hp0 - e2.hp === Math.floor(45 * B.pctPerStack / 100 * e2.maxHp * 1.5), 'burn tick with fever: ' + (hp0 - e2.hp));
    // 裁判：輪數一跨過門檻就更新 match.fever（第 1~10 輪 0 層、第 11 輪起 1 層）
    const rm = matchWith({});
    rm.planAiTurn = () => ({ walk: null, plan: null });   // 敵人只發呆：只是要快轉輪數，不能有人被打進水裡提早結束
    const io = new FakeIo();
    const feverAt = [];
    const broadcast = io.broadcast.bind(io);
    io.broadcast = (msg, ex) => { if (msg.t === 'turn') feverAt.push([msg.round, rm.fever]); broadcast(msg, ex); };
    const ref = new Referee({ match: rm, humans: mkPlayers(1), io });
    ref.start();
    assert(advanceUntil(io, () => ref.round >= 12, 3_000_000), 'reach round 12');
    const wrong = feverAt.filter(([r, f]) => f !== (r > 10 ? 1 : 0));
    assert(!wrong.length && feverAt.some(([r]) => r === 11), 'fever per round: ' + JSON.stringify(wrong.slice(0, 3)));
    const next = new Match({ players: mkPlayers(1), seed: 1 });
    assert(next.fever === 0, 'a new stage starts without fever');
    return { stacks };
  } finally {
    Object.assign(CONFIG.FEVER, saved);
  }
});

test('狂熱：Boss 關不套用（過了第 10 輪還是 0 層，古樹的攻擊照原本傷害）；FEVER.inBoss 打開才會套用', () => {
  const saved = { ...CONFIG.FEVER };
  Object.assign(CONFIG.FEVER, { everyRounds: 10, damagePct: 50, inBoss: false });
  try {
    const normal = matchWith({});
    const boss = matchWith({}, { levelId: 'treeGarden' });
    assert(boss.level.pool === 'boss' && normal.level.pool === 'normal', 'level pools');
    assert(normal.feverAt(11) === 1 && normal.feverAt(21) === 2, 'normal stage gets fever');
    assert([1, 10, 11, 21, 51].every(r => boss.feverAt(r) === 0), 'boss stage never gets fever');
    // 裁判實際跑到第 12 輪：Boss 關每個回合 match.fever 都是 0
    boss.planAiTurn = () => ({ walk: null, plan: null });   // 古樹 / 樹妖只發呆：只是要快轉輪數
    const io = new FakeIo();
    const feverAt = [];
    const broadcast = io.broadcast.bind(io);
    io.broadcast = (msg, ex) => { if (msg.t === 'turn') feverAt.push([msg.round, boss.fever]); broadcast(msg, ex); };
    const ref = new Referee({ match: boss, humans: mkPlayers(1), io });
    ref.start();
    assert(advanceUntil(io, () => ref.round >= 12, 3_000_000), 'reach round 12 in the boss stage');
    assert(feverAt.some(([r]) => r === 11) && feverAt.every(([, f]) => f === 0), 'boss fever per round: ' + JSON.stringify(feverAt.filter(([, f]) => f !== 0).slice(0, 3)));
    // 第 12 輪時古樹的落葉打玩家：照原本的傷害
    const leaf = CONFIG.WEAPONS.treeLeaf;
    const p1 = boss.players[0], eye = boss.byId('eye');
    const hp0 = p1.hp;
    boss.applyExplosion(p1.cx, p1.cy, leaf, eye, p1, { directOnly: true });
    assert(hp0 - p1.hp === leaf.damage, `boss leaf damage at round 12: ${hp0 - p1.hp} vs ${leaf.damage}`);
    CONFIG.FEVER.inBoss = true;
    assert(boss.feverAt(11) === 1, 'FEVER.inBoss = true turns it back on');
    return { bossRounds: ref.round };
  } finally {
    Object.assign(CONFIG.FEVER, saved);
  }
});

test('敵人傷害倍率：敵人打人 = 武器傷害 × ENEMY.damageMult（再吃狂熱）；玩家打敵人不受影響', () => {
  CONFIG.ENEMY.damageMult = ENEMY_DAMAGE_MULT;
  try {
    assert(ENEMY_DAMAGE_MULT === 0.7, 'config is 0.7: ' + ENEMY_DAMAGE_MULT);
    const w = CONFIG.WEAPONS.cannon;
    const m = matchWith({}, { players: 2, hp: 10000 });
    const [p1] = m.players;
    const e1 = m.enemies[0];
    const hit = (target, attacker) => { const h = target.hp; m.applyExplosion(target.cx, target.cy, w, attacker, target); return h - target.hp; };
    assert(hit(e1, p1) === w.damage, 'player → enemy unchanged');
    const d = hit(p1, e1);
    assert(d === Math.round(w.damage * 0.7), 'enemy → player ×0.7: ' + d);
    m.fever = 1;
    assert(hit(p1, e1) === Math.round(w.damage * (0.7 * 1.5)), 'fever stacks on top');
    return { cannon: w.damage, enemyHit: d };
  } finally { CONFIG.ENEMY.damageMult = 1; }
});

test('新武器與裝備也維持確定性：同 seed 同輸入兩次結果完全一樣', () => {
  const run = () => {
    const m = matchWith({ sniperBounce: 1, sniperPierce: 1, burnStacks: 30, lifestealPct: 5, bombard: 1, rampDamagePct: 1, rampDamageMaxPct: 10 }, { players: 2, weapons: ['sniper', 'plasma', 'boomerang'], hp: 200 });
    const p1 = m.players[0];
    const log = [];
    m.beginTurn(p1);
    log.push(m.resolveBombard(p1));
    log.push(m.resolveShot(p1, 'plasma', 35, 60));
    log.push(m.resolveShot(p1, 'sniper', -10, 100));
    log.push(m.resolveShot(p1, 'boomerang', 50, 70));
    for (const e of m.enemies) if (e.alive) log.push(m.endTurn(e), m.planAiTurn(e));
    return JSON.stringify({ log, snap: m.snapshot() });
  };
  const a = run(), b = run();
  assert(a === b, 'two runs differ');
  return { bytes: a.length };
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
