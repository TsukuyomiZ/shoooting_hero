// node test/snake-boss.js
// Boss 關「叢林巨蟒」的規則測試：地圖（藤蔓橋、橋的盡頭是水、巨蟒的橢圓判定）、藤蔓（抓、爬、放手、跳開、被打下來、伺服器檢查回報）、
// 中毒（上毒、無敵擋、連結不分、自己的回合開始結算 + 生命鎖、被毒倒）、蛇血（每 N% 掉一瓶、走過去喝 / 回合開始站在上面、解毒 + 解鎖 + 回血）、
// 四種招式（權重、預定下一招、衝撞範圍、噴灑每人最多一次、震擊只打站在橋上的人並往巨蟒甩、撕咬最近的人）、
// 客戶端重播一致、裁判流程、客戶端警示帶、確定性
import { CONFIG } from '../shared/config.js';
import { LEVELS, levelsInPool } from '../shared/level.js';
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { Rng } from '../shared/rng.js';
import { planShot } from '../shared/ai.js';
import { replayChecked } from './replay-check.js';
import { VINE_HAND, poisonTick } from '../shared/entities.js';
import { chargeLane, resolveSnakeTurn, rollSnakeAction, planSnakeNext, nearestPlayer, snakeDrops, pickupAlong } from '../shared/snake-boss.js';
import { snakeTurnScript, drawSnakeScene } from '../client/snake-boss-view.js';

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
function advanceUntil(io, pred, maxMs = 300_000) {
  const start = io.t;
  while (io.t - start < maxMs) {
    io.advance(100);
    if (pred()) return true;
  }
  return false;
}

const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const mult = () => CONFIG.ENEMY.damageMult;   // 第一輪的倍率：測試的巨蟒都建在第 5 關（第一個王關）
const enemyDmg = (w) => Math.round(CONFIG.WEAPONS[w].damage * mult());
// 叢林巨蟒的測試戰鬥：玩家血量自己設（不受 config 影響），巨蟒血量照 config
function jungle(n = 1, { seed = 1, hp = 5000 } = {}) {
  const m = new Match({ levelId: 'jungleSerpent', players: mkPlayers(n), seed, stage: 5 });
  for (const p of m.players) { p.hp = p.maxHp = hp; }
  return m;
}
const bridgeY = (m) => m.snake.def.bridge.y;
// 站到橋上 x 處
function placeOn(m, e, x) { e.x = x; e.y = bridgeY(m) - 30; e.vx = e.vy = 0; e.letGoVine(); e.vineRegrab = 0; m.settle(600); e.safeX = e.x; e.safeY = e.y; }
// 掛在第 i 條藤蔓上，腳底在 y
function hang(m, e, i, y) {
  const v = m.terrain.vines[i];
  e.x = v.x; e.y = y; e.vx = e.vy = 0; e.onVine = i; e.onGround = false;
  assert(e.canHangAt(m.terrain, i, e.x, e.y), `can hang on vine ${i} at y ${y}`);
}
const hangRange = (m, e, i) => { const v = m.terrain.vines[i]; return { lo: v.top + e.h - VINE_HAND, hi: v.bottom + e.h - VINE_HAND }; };
function withPoison(patch, fn) {
  const P = CONFIG.POISON;
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, P[k]]));
  Object.assign(P, patch);
  try { return fn(); } finally { Object.assign(P, saved); }
}
function withSnake(patch, fn) {
  const T = CONFIG.SNAKE_BOSS;
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, T[k]]));
  Object.assign(T, patch);
  try { return fn(); } finally { Object.assign(T, saved); }
}
// 讓巨蟒出指定的招式，回傳那一招
function forced(m, action) {
  m.snake.next = { action };
  return resolveSnakeTurn(m, m.byId('snake')).steps[0];
}
const stepN = (m, n) => { for (let i = 0; i < n; i++) m.step(); };


function recordingCtx() {
  const calls = [];
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : (k === 'createLinearGradient' || k === 'createRadialGradient') ? () => grad
      : (...args) => { calls.push({ fn: k, style: o.fillStyle, args }); }),
  });
  return { ctx, calls };
}
const redBands = (calls) => calls.filter(c => c.fn === 'fillRect' && String(c.style).startsWith('rgba(239,68,68')).map(c => c.args.map(v => Math.round(v)).join());

// ---------------------------------------------------------------------------

test('地圖：在 Boss 池裡；藤蔓橋炸不壞、子彈穿得過、站得住；走過橋的盡頭會掉進水裡；巨蟒的頭是橢圓判定；血量只吃人數放大', () => {
  assert(levelsInPool('boss').includes('jungleSerpent') && LEVELS.jungleSerpent.name === '叢林巨蟒', 'boss pool');
  const m = jungle(4);
  const t = m.terrain;
  const y = bridgeY(m);
  assert(m.players.every(p => p.onGround && Math.abs(p.y - (y - 1)) <= 1), 'players spawn on the bridge: ' + m.players.map(p => p.y));
  assert(t.isPlatform(300, y + 4) && !t.isSolid(300, y + 4), 'bridge is a pass-through platform');
  t.carve(300, y + 4, 40);
  assert(t.isPlatform(300, y + 4), 'bridge survives explosions');
  assert(!t.isSolid(300, 600) && !t.isPlatform(300, 600), 'nothing under the bridge (water)');
  // 走過橋的盡頭：掉進水裡（扣血、回到最後站穩的地方）
  const p = m.players[0];
  placeOn(m, p, 560);
  p.stamina = 1e9;
  p.moveDir = 1;
  for (let i = 0; i < 240 && p.waterFalls === 0; i++) m.step();
  p.moveDir = 0;
  assert(p.waterFalls === 1 && p.x <= m.snake.def.bridge.x1 + p.hw, 'walked off the end into the water: wf ' + p.waterFalls + ' x ' + p.x);
  assert(p.x <= t.maxX - p.hw, 'cannot walk past maxX');
  // 巨蟒：橢圓判定——嘴前打得到，矩形的角落打不到
  const s = m.byId('snake');
  assert(s.shape === 'ellipse' && s.fixed && s.boss, 'snake head');
  assert(s.containsPoint(s.x - s.hw + 2, s.cy) && !s.containsPoint(s.x - s.hw + 10, s.y - s.h + 10), 'ellipse, not the bounding box');
  assert(s.distanceTo(s.x - s.hw - 20, s.cy) > 19 && s.distanceTo(s.x - s.hw - 20, s.cy) < 21 && s.distanceTo(s.x, s.cy) === 0, 'distance to the ellipse');
  const scale = 1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER * 3;
  assert(s.maxHp === Math.round(CONFIG.SNAKE_BOSS.hp * scale), 'hp scales with players only: ' + s.maxHp);
  const one = new Match({ levelId: 'jungleSerpent', players: mkPlayers(1), seed: 1, stage: 5 });
  assert(one.byId('snake').maxHp === CONFIG.SNAKE_BOSS.hp, 'solo hp');
  assert(m.feverAt(11) === 0 && m.feverAt(31) === 0, 'no fever in the boss stage');
  return { snakeHp4p: s.maxHp };
});

test('藤蔓：站在橋上搆不到；按住 W 跳起來就抓住；往上爬耗體力、到上端停；回合外（hangDrain 關）放開不動不耗體力、沒體力也掛著', () => {
  const m = jungle(1);
  const p = m.players[0];
  const v = m.terrain.vines[0];
  const { lo, hi } = hangRange(m, p, 0);
  placeOn(m, p, v.x - 3);
  p.vineDir = -1;
  stepN(m, 30);
  assert(p.onVine === -1 && p.onGround, 'cannot grab while standing on the bridge');
  p.wantJump = true;
  let n = 0;
  while (p.onVine < 0 && n++ < 60) m.step();
  assert(p.onVine === 0 && p.x === v.x && p.y <= hi && p.y >= lo && p.vy === 0, `grabbed while jumping (W held): vine ${p.onVine} x ${p.x} y ${p.y}`);
  const y0 = p.y, st0 = p.stamina;
  stepN(m, 60);
  assert(Math.abs((y0 - p.y) - p.vineSpeed) < 2, 'climbs vineSpeed px/s: ' + (y0 - p.y));
  assert(Math.abs((st0 - p.stamina) - p.moveCost) < 1, 'costs moveCost stamina per second: ' + (st0 - p.stamina));
  p.vineDir = 0;
  const y1 = p.y, st1 = p.stamina;
  stepN(m, 120);
  assert(p.y === y1 && p.stamina === st1 && p.onVine === 0 && m.isSettled(), 'not in my turn (hangDrain off): hangs still for free (and counts as settled)');
  p.stamina = 1e9;
  p.vineDir = -1;
  stepN(m, 600);
  assert(Math.abs(p.y - lo) < 1e-9 && p.onVine === 0, 'stops at the top: ' + p.y + ' vs ' + lo);
  assert(p.y - p.h >= m.terrain.vines[0].top - VINE_HAND, 'hands at the top end');
  p.stamina = 0;
  p.vineDir = 1;
  stepN(m, 30);
  assert(p.y === lo && p.onVine === 0, 'no stamina: just hangs');
  return { reach: { lo, hi } };
});

test('藤蔓：自己的回合（hangDrain）掛著也耗 vineHangCost 體力、用完就鬆手掉下去，沒體力也抓不住；回合外免費一直掛著；慢動作時重抓冷卻照遊戲時間算', () => {
  const m = jungle(1);
  const p = m.players[0];
  const { hi } = hangRange(m, p, 1);
  assert(p.vineHangCost === CONFIG.PLAYER.vineHangCost && p.vineHangCost > 0, 'players get vineHangCost: ' + p.vineHangCost);
  hang(m, p, 1, hi - 30);
  p.hangDrain = true;
  p.stamina = 100;
  stepN(m, 60);
  assert(p.onVine === 1 && Math.abs((100 - p.stamina) - p.vineHangCost) < 0.5, 'my turn: hanging drains vineHangCost per second: ' + p.stamina);
  const st = p.stamina;
  p.vineDir = -1;
  stepN(m, 30);
  p.vineDir = 0;
  assert(Math.abs((st - p.stamina) - p.moveCost / 2) < 0.5, 'climbing costs moveCost only (not plus the hang cost): ' + (st - p.stamina));
  // 體力用完：鬆手掉下去；按著 W 也抓不回去，一路掉回橋上
  stepN(m, Math.ceil(p.stamina / p.vineHangCost * 60) + 2);
  assert(p.onVine === -1 && p.stamina === 0, 'lets go when stamina runs out: vine ' + p.onVine + ' stamina ' + p.stamina);
  // （抓了又在同一幀鬆手的話 onVine 看不出來，但每抓一次 vy 就歸零、會一頓一頓地慢慢飄下去：所以檢查是不是一路自由落體）
  p.vineDir = -1;
  let regrabbed = false, braked = false, prevVy = p.vy;
  for (let i = 0; i < 180 && !p.onGround; i++) {
    m.step();
    if (p.onVine >= 0) regrabbed = true;
    if (!p.onGround && p.vy < prevVy) braked = true;
    prevVy = p.vy;
  }
  p.vineDir = 0;
  assert(!regrabbed && !braked && p.onGround && Math.abs(p.y - bridgeY(m)) <= 1, `cannot grab with no stamina in my turn (free fall: ${!braked}); lands on the bridge: ${p.y}`);
  // 回合外（回合結束還掛著）：不耗體力，沒體力也一直掛著
  hang(m, p, 1, hi - 30);
  p.hangDrain = false;
  p.stamina = 40;
  stepN(m, 300);
  assert(p.onVine === 1 && p.stamina === 40 && m.isSettled(), 'outside my turn: no drain');
  p.stamina = 0;
  stepN(m, 300);
  assert(p.onVine === 1 && m.isSettled(), 'outside my turn: hangs with no stamina');
  // 慢動作（每一步的 dt 只有 0.3 倍）：按著 W 跳開，重抓冷卻一樣是 15 個固定步長那麼久的遊戲時間
  hang(m, p, 1, hi - 30);
  p.hangDrain = true;
  p.stamina = 100;
  p.vineDir = -1;
  p.wantJump = true;
  const k = 0.3;
  let n = 0;
  p.update(CONFIG.FIXED_DT * k, m.world);
  assert(p.onVine === -1 && p.vy < 0 && p.midJump, 'jumped off (counts as a jump for slow-mo)');
  while (p.onVine < 0 && n++ < 200) p.update(CONFIG.FIXED_DT * k, m.world);
  p.vineDir = 0;
  assert(p.onVine === 1 && n * k >= 13 && n * k <= 16, 'slow-mo regrab after the same game time: ' + n + ' small steps');
  assert(!p.midJump && !p.jumped, 'grabbing the vine ends the jump');
  return { hangCost: p.vineHangCost, slowRegrabSteps: n };
});

test('藤蔓：S 往下爬到手滑過下端就掉回橋上；A / D 放手；空白鍵跳開（按著 W 也不會馬上抓回去）；被擊退就被打下來', () => {
  const m = jungle(1);
  const p = m.players[0];
  const v = m.terrain.vines[1];
  const { hi } = hangRange(m, p, 1);
  hang(m, p, 1, hi - 20);
  p.stamina = 1e9;
  p.vineDir = 1;
  let n = 0;
  while (p.onVine >= 0 && n++ < 120) m.step();
  assert(p.onVine === -1 && n < 120, 'lets go past the bottom end');
  p.vineDir = 0;
  m.settle(300);
  assert(p.onGround && Math.abs(p.y - bridgeY(m)) <= 1, 'lands on the bridge: ' + p.y);
  // A / D
  hang(m, p, 1, hi - 30);
  p.moveDir = 1;
  m.step();
  assert(p.onVine === -1, 'A / D lets go');
  p.moveDir = 0;
  m.settle(300);
  assert(p.onGround, 'fell to the bridge');
  // 空白鍵：跟站在地上一樣起跳（耗跳躍體力），按著 W 的話冷卻過後才會再抓
  hang(m, p, 1, hi - 30);
  p.stamina = 100;
  p.vineDir = -1;
  p.wantJump = true;
  m.step();
  assert(p.onVine === -1 && p.vy < 0 && p.stamina === 100 - p.jumpCost, 'jumped off the vine: vy ' + p.vy + ' stamina ' + p.stamina);
  const regrabbed = [];
  for (let i = 0; i < 40; i++) { m.step(); if (p.onVine >= 0) { regrabbed.push(i); break; } }
  assert(regrabbed.length && regrabbed[0] >= 13, 'regrab only after the cooldown: ' + regrabbed);
  // 被擊退：放手
  p.vineDir = 0;
  hang(m, p, 1, hi - 30);
  m.applyExplosion(p.cx - 30, p.cy, CONFIG.WEAPONS.cannon, m.byId('snake'), null);
  assert(p.onVine === -1 && p.vx > 0, 'knocked off the vine');
  // 沒有 vineSpeed 的角色（敵人）抓不了
  const s = m.byId('snake');
  assert(s.vineSpeed === 0 && !s.canHangAt(m.terrain, 1, v.x, hi), 'enemies cannot climb');
  return { regrabFrame: regrabbed[0] };
});

test('裁判：回報位置帶 vine，掛得上去才算；掛著超時 → 伺服器讓他繼續掛著（不會掉下去）；亂報的 vine 不算，超時就掉回橋上', () => {
  const run = (report) => {
    const m = jungle(1);
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: mkPlayers(1), io });
    ref.start();
    assert(advanceUntil(io, () => ref.phase === 'turn'), 'p1 turn');
    const p = m.byId('p1');
    ref.handle('p1', { t: 'move', facing: 1, stamina: p.stamina, vy: 0, ...report });
    const onVine = p.onVine;
    io.advance(CONFIG.TURN_TIME * 1000 + 50);
    const skip = io.take('skip').at(-1);
    return { onVine, s: skip.entities.find(e => e.id === 'p1'), move: io.take('move').at(-1) };
  };
  const v = LEVELS.jungleSerpent.vines[0];
  const ok = run({ x: v.x, y: 400, vine: 0 });
  assert(ok.onVine === 0 && ok.s.vn === 0 && ok.s.y === 400 && ok.s.x === v.x, 'still hanging after the timeout: ' + JSON.stringify(ok.s));
  assert(ok.move && ok.move.vine === 0, 'move broadcast carries the vine');
  const off = run({ x: v.x + 12, y: 400, vine: 0 });   // 離藤蔓太遠：不算抓著
  assert(off.onVine === -1 && off.s.vn === -1 && Math.abs(off.s.y - (LEVELS.jungleSerpent.mechanic.bridge.y - 1)) <= 1, 'bogus vine report falls to the bridge: ' + JSON.stringify(off.s));
  const low = run({ x: v.x, y: v.bottom + 40, vine: 0 });   // 手已經在藤蔓下端下面
  assert(low.onVine === -1, 'hands below the vine end do not count');
  return { hangY: ok.s.y };
});

test('掛在藤蔓上開火：shot.actor 帶 vn，射手照樣掛著；客戶端照事件重播結果一樣', () => {
  const m = jungle(1, { seed: 3 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  ref.start();
  assert(advanceUntil(io, () => ref.phase === 'turn'), 'p1 turn');
  const v = m.terrain.vines[2];
  hang(m, m.byId('p1'), 2, 420);   // 先爬上去（回報一次跑太遠會被當成瞬移）
  const before = JSON.parse(JSON.stringify(m.snapshot()));
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 20, power: 60, x: v.x, y: 420, vy: 0, facing: 1, stamina: 200, vine: 2 });
  const shot = io.take('shot').at(-1);
  assert(shot && shot.actor.vn === 2 && shot.actor.x === v.x && shot.actor.y === 420, 'shot actor on the vine: ' + JSON.stringify(shot && shot.actor));
  const srv = shot.results.find(s => s.id === 'p1');
  assert(srv.vn === 2 && srv.y === 420, 'shooter still hanging after the shot: ' + JSON.stringify(srv));
  const cm = new Match({ levelId: 'jungleSerpent', players: mkPlayers(1), seed: m.seed, stage: 5 });
  cm.applySnapshot(before);
  for (const e of cm.players) { e.maxHp = m.byId(e.id).maxHp; }
  replayChecked(cm, JSON.parse(JSON.stringify(shot)), 'vine shot');
  for (const s of shot.results) {
    const e = cm.byId(s.id);
    assert(e.x === s.x && e.y === s.y && e.hp === s.hp && e.onVine === s.vn, `${s.id}: client ${e.x},${e.y},${e.hp},${e.onVine} vs server ${s.x},${s.y},${s.hp},${s.vn}`);
  }
  return { events: shot.events.map(e => e.type) };
});

test('中毒：巨蟒的攻擊上毒（傷害 0 也上），無敵整下擋掉，攜手之伴只分傷害不分毒；毒只在自己的回合開始時結算', () => {
  const m = jungle(2, { hp: 150 });
  const [p1, p2] = m.players;
  const s = m.byId('snake');
  const W = CONFIG.WEAPONS;
  let d = m.applyExplosion(p1.cx, p1.cy, W.snakeVenom, s, p1);
  assert(p1.poison === W.snakeVenom.poison && d[0].poison === W.snakeVenom.poison && p1.hp === 150 - Math.round(W.snakeVenom.damage * mult()), 'venom: stacks, no damage');
  m.applyExplosion(p1.cx, p1.cy, W.snakeCharge, s, p1, { directOnly: true });
  assert(p1.poison === W.snakeVenom.poison + W.snakeCharge.poison, 'stacks add up: ' + p1.poison);
  p2.shield = 1;
  d = m.applyExplosion(p2.cx, p2.cy, W.snakeBite, s, p2);
  assert(p2.poison === 0 && p2.hp === 150 && d[0].blocked && p2.shield === 0, 'shield blocks the whole hit');
  // 攜手之伴：傷害照常分，毒只上給被咬的人
  p1.links = [p2.id]; p2.links = [p1.id];
  const hp2 = p2.hp;
  m.applyExplosion(p2.cx, p2.cy, W.snakeBite, s, p2);
  assert(p2.poison === W.snakeBite.poison && p1.poison === W.snakeVenom.poison + W.snakeCharge.poison, 'poison is not shared');
  assert(p2.hp < hp2 && (W.snakeBite.damage * mult() < 3 || p1.hp < 150), 'damage is still shared');
  // 回合結束（別人的回合、自己的回合結束）都不會結算
  m.endTurn(p1);
  m.endTurn(s);
  assert(p1.poison === 13 && p1.poisonLock === 0, 'not settled at turn end');
  return { p1: p1.poison, p2: p2.poison };
});

test('中毒結算：每層扣最大血量 1%（照現在的上限），上限鎖住一樣多；層數不會自己消失，下個回合照鎖住後的上限再扣一次；回血到不了被鎖住的部分', () => withPoison({ persist: true }, () => {
  const m = jungle(1, { hp: 150 });
  const p = m.players[0];
  p.poison = 10;
  let fx = m.turnStartEffects(p);
  const want = Math.round(10 * CONFIG.POISON.pctPerStack / 100 * 150);
  assert(p.hp === 150 - want && p.maxHp === 150 - want && p.poisonLock === want && p.poison === 10, `first tick: ${p.hp}/${p.maxHp} lock ${p.poisonLock} stacks ${p.poison}`);
  assert(fx.length === 1 && fx[0].type === 'poison' && fx[0].stacks === 10 && fx[0].dmg === want && fx[0].lock === want && !fx[0].died && fx[0].left === 10, 'fx ' + JSON.stringify(fx));
  m.turnStartEffects(p);   // 沒有新的毒：還是同樣 10 層
  const want2 = Math.round(10 * CONFIG.POISON.pctPerStack / 100 * (150 - want));
  assert(p.poisonLock === want + want2 && p.maxHp === 150 - want - want2 && p.hp === p.maxHp && p.poison === 10, 'second tick uses the locked max: ' + p.maxHp);
  p.poison = 0;
  assert(m.turnStartEffects(p).length === 0, 'nothing to settle without stacks');
  m.heal(p, 1000);
  assert(p.hp === p.maxHp && p.maxHp + p.poisonLock === 150, 'heals stop at the locked max');
  // 狀態同步帶著層數與生命鎖
  p.poison = 4;
  const st = p.toState();
  assert(st.ps === 4 && st.lk === p.poisonLock && st.mhp === p.maxHp, 'toState carries ps / lk / mhp');
  const c = jungle(1);
  c.players[0].applyState(JSON.parse(JSON.stringify(st)));
  assert(c.players[0].poison === 4 && c.players[0].poisonLock === p.poisonLock && c.players[0].maxHp === p.maxHp, 'applyState restores them');
  // 血不夠扣就毒倒（不鎖）
  p.hp = 3; p.poison = 30;
  fx = m.turnStartEffects(p);
  assert(!p.alive && fx[0].died && fx[0].lock === 0, 'poisoned to death: ' + JSON.stringify(fx));
  // persist 關掉 = 舊規則：結算完就歸零
  withPoison({ persist: false }, () => {
    const q = jungle(1, { hp: 150 }).players[0];
    q.poison = 10;
    poisonTick(q);
    assert(q.poison === 0 && q.poisonLock === want, 'persist false clears after the tick');
  });
  return { first: want, second: want2 };
}));

test('裁判：回合開始先結算中毒（turn 帶 fx 與 lk）；被毒倒的人這回合不開始（廣播 turnFx）、直接換下一位；全隊被毒倒就輸', () => {
  const m = jungle(2, { hp: 100 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(2), io });
  m.byId('p1').poison = 10;
  m.byId('p2').hp = 5; m.byId('p2').poison = 20;
  ref.start();
  assert(advanceUntil(io, () => io.take('turn').length >= 1), 'first turn');
  const t1 = io.take('turn')[0];
  const s1 = t1.entities.find(e => e.id === 'p1');
  assert(t1.actorId === 'p1' && t1.fx.some(f => f.type === 'poison' && f.dmg === 10) && s1.hp === 90 && s1.mhp === 90 && s1.lk === 10 && s1.ps === (CONFIG.POISON.persist ? 10 : 0), 'p1 settles at turn start: ' + JSON.stringify(t1.fx));
  ref.handle('p1', { t: 'fire', weapon: 'sniper', angle: 80, power: 100, x: m.byId('p1').x, y: m.byId('p1').y, facing: 1, stamina: 0 });
  assert(advanceUntil(io, () => io.take('turnFx').some(f => f.actorId === 'p2')), 'p2 turnFx');
  const tf = io.take('turnFx').find(f => f.actorId === 'p2');
  assert(tf.fx.some(f => f.type === 'poison' && f.died) && !tf.entities.find(e => e.id === 'p2').alive, 'p2 poisoned to death at turn start');
  assert(!io.take('turn').some(t => t.actorId === 'p2'), 'no turn for p2');
  assert(advanceUntil(io, () => io.take('aiTurn').length >= 1), 'snake turn next');
  assert(io.take('aiTurn')[0].actorId === 'snake', 'the snake acts after p2 dropped');
  // 單人被毒倒 → 輸
  const solo = jungle(1, { hp: 10 });
  const io2 = new FakeIo();
  const r2 = new Referee({ match: solo, humans: mkPlayers(1), io: io2 });
  solo.byId('p1').poison = 100;
  r2.start();
  assert(advanceUntil(io2, () => r2.phase === 'over'), 'game over');
  assert(io2.take('gameOver')[0].result === 'lose' && !io2.take('turn').length, 'lose without a turn');
  return { p1: s1.hp + '/' + s1.mhp };
});

test('蛇血：巨蟒每受到最大血量 10% 的傷害掉一瓶（一下打很多一次掉好幾瓶），落在橋上的範圍裡；倒下就不掉；被燒到跨門檻也會掉', () => withSnake({ bloodEveryPct: 10 }, () => {
  const m = jungle(2, { seed: 5 });
  const s = m.byId('snake');
  const tenth = s.maxHp / 10;
  s.takeDamage(Math.ceil(tenth) - 1);
  assert(snakeDrops(m).length === 0, 'just under 10%: nothing');
  s.takeDamage(1);
  const d1 = snakeDrops(m);
  assert(d1.length === 1 && m.items.length === 1, 'first bottle at 10%');
  s.takeDamage(Math.ceil(tenth * 2.5));
  const d2 = snakeDrops(m);
  assert(d2.length === 2 && m.items.length === 3, 'big hit drops two: ' + d2.length);
  const [x0, x1] = m.snake.def.bloodX;
  assert(m.items.every(it => it.type === 'snakeBlood' && it.x >= x0 && it.x <= x1 && it.y === bridgeY(m)), 'on the bridge: ' + JSON.stringify(m.items));
  assert(new Set(m.items.map(it => it.id)).size === 3, 'unique ids');
  // 開火打到巨蟒：事件帶 drops
  const p1 = m.players[0];
  placeOn(m, m.players[1], 20);   // 隊友站到後面，別擋在彈道上
  p1.mods.damagePct = 2000;
  const mz = p1.muzzle();
  const ang = Math.atan2(-(s.cy - mz.y), s.x - s.hw + 10 - mz.x) * 180 / Math.PI;
  const shot = m.resolveShot(p1, 'sniper', ang, 100);
  const hit = shot.events.find(e => e.target === 'snake');
  const lost = s.maxHp - s.hp;
  assert(hit && hit.drops && hit.drops.length === Math.floor(lost * 10 / s.maxHp) - 3, 'shot event carries the drops: ' + JSON.stringify(hit && hit.drops));
  // 燒到跨門檻：回合結束的 fx
  const m2 = jungle(1, { seed: 6 });
  const s2 = m2.byId('snake');
  s2.burn = 1e6;
  const fx = m2.endTurn(s2);
  assert(fx.some(f => f.type === 'drops' && f.items.length >= 1) || !s2.alive, 'burn drops: ' + JSON.stringify(fx));
  // 倒下：不掉
  const m3 = jungle(1);
  const s3 = m3.byId('snake');
  s3.takeDamage(s3.hp);
  assert(snakeDrops(m3).length === 0 && m3.items.length === 0, 'no drops once dead');
  return { items: m.items.length };
}));

test('蛇血：自己的回合走過去就喝掉——先解開生命鎖、再回 30 血（10/50(100) → 40/100），全員收到 pickup；滿血又沒被鎖住就不撿；回合開始站在上面也會喝', () => withSnake({ bloodHeal: 30 }, () => {
  const m = jungle(1, { hp: 100 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  ref.start();
  assert(advanceUntil(io, () => ref.phase === 'turn'), 'p1 turn');
  const p = m.byId('p1');
  placeOn(m, p, 360);
  m.items.push({ id: 'a9', type: 'snakeBlood', x: 400, y: bridgeY(m) });
  // 滿血、沒被鎖：走過去不撿
  ref.handle('p1', { t: 'move', x: 440, y: p.y, vy: 0, facing: 1, stamina: p.stamina });
  assert(m.items.length === 1 && !io.take('pickup').length, 'full hp, no lock: walks over it');
  // 被鎖 50（10/50，原本 100）：走回去經過就喝
  p.hp = 10; p.maxHp = 50; p.poisonLock = 50;
  ref.handle('p1', { t: 'move', x: 360, y: p.y, vy: 0, facing: -1, stamina: p.stamina });
  const pk = io.take('pickup');
  assert(pk.length === 1 && pk[0].id === 'p1' && pk[0].item === 'a9' && pk[0].unlocked === 50 && pk[0].heal === 30 && pk[0].mhp === 100 && pk[0].lk === 0 && pk[0].hp === 40 && pk[0]._except === undefined, 'pickup broadcast to everyone: ' + JSON.stringify(pk));
  assert(p.hp === 40 && p.maxHp === 100 && p.poisonLock === 0 && m.items.length === 0, 'unlocked, then +30');
  // 回合開始時站在蛇血上
  const m2 = jungle(1, { hp: 100 });
  const p2 = m2.players[0];
  placeOn(m2, p2, 420);
  m2.items.push({ id: 'a1', type: 'snakeBlood', x: 424, y: bridgeY(m2) });
  p2.poison = 10;
  const fx = m2.turnStartEffects(p2);
  assert(fx.map(f => f.type).join() === 'poison,snakeBlood' && p2.maxHp === 100 && p2.hp === 100 && fx[1].heal === 10 && m2.items.length === 0, 'settle then drink (heal capped at the max): ' + JSON.stringify(fx));
  // 快照帶著場上的蛇血
  m2.items.push({ id: 'a2', type: 'snakeBlood', x: 333, y: bridgeY(m2) });
  const c = jungle(1);
  c.applySnapshot(JSON.parse(JSON.stringify(m2.snapshot())));
  assert(c.items.length === 1 && c.items[0].id === 'a2' && c.items[0].x === 333, 'snapshot items');
  // 沒被鎖住、但血沒滿：也會撿來回血
  const m3 = jungle(1, { hp: 100 });
  const p3 = m3.players[0];
  placeOn(m3, p3, 420);
  m3.items.push({ id: 'a3', type: 'snakeBlood', x: 424, y: bridgeY(m3) });
  p3.hp = 50;
  const fx3 = m3.turnStartEffects(p3);
  assert(fx3.length === 1 && fx3[0].heal === 30 && fx3[0].unlocked === 0 && p3.hp === 80 && p3.maxHp === 100 && !m3.items.length, 'damaged, unlocked: drinks for the heal');
  // 滿血、還沒被鎖，但身上有毒：也會撿來解毒
  m3.items.push({ id: 'a4', type: 'snakeBlood', x: 424, y: bridgeY(m3) });
  p3.hp = p3.maxHp; p3.poison = 5;
  const got = pickupAlong(m3, p3, p3.x - 2, p3.y, p3.x, p3.y);
  assert(got && got.cured === 5 && p3.poison === 0 && !m3.items.length, 'poisoned at full hp: drinks to cure');
  return { pickup: pk[0] };
}));

test('權重：45 / 25 / 10 / 20；開場（大家落地後）就預定第一招，快照帶著，客戶端照快照套用；每出一招就重新預定（aiTurn 的 boss.next）', () => withSnake({ weights: { charge: 45, spray: 25, quake: 10, bite: 20 } }, () => {
  const m = jungle(1, { seed: 9 });
  const count = { charge: 0, spray: 0, quake: 0, bite: 0 };
  const N = 8000;
  for (let i = 0; i < N; i++) count[rollSnakeAction(m)]++;
  const want = { charge: 45, spray: 25, quake: 10, bite: 20 };
  for (const k of Object.keys(want)) assert(Math.abs(count[k] / N * 100 - want[k]) < 2.5, `${k}: ${(count[k] / N * 100).toFixed(1)}%`);
  const m2 = jungle(2, { seed: 4 });
  assert(m2.snake.next && ['charge', 'spray', 'quake', 'bite'].includes(m2.snake.next.action), 'planned at start');
  m2.snake.next = { action: 'quake' };
  const c = new Match({ levelId: 'jungleSerpent', players: mkPlayers(2), seed: m2.seed, stage: 5 });
  c.applySnapshot(JSON.parse(JSON.stringify(m2.snapshot())));
  assert(c.snake.next.action === 'quake', 'snapshot snakeNext');
  const r = resolveSnakeTurn(m2, m2.byId('snake'));
  assert(r.steps.length === 1 && r.steps[0].action === 'quake' && r.next.action === m2.snake.next.action, 'used the plan, planned the next');
  const off = withSnake({ weights: { charge: 0, spray: 0, quake: 0, bite: 0 } }, () => rollSnakeAction(m2));
  assert(off === 'idle', 'all-zero weights = idle');
  return Object.fromEntries(Object.entries(count).map(([k, v]) => [k, +(v / N * 100).toFixed(1)]));
}));

test('巨蟒衝撞：範圍 = 頭的上緣到水面（chargeLane）；橋上、藤蔓下段的人受到 30 傷害（× 敵人倍率）+ 3 層毒（被撞下藤蔓），爬到範圍上面的人沒事；不打自己', () => {
  const m = jungle(3, { seed: 2, hp: 150 });
  const [p1, p2, p3] = m.players;
  const lane = chargeLane(m);
  placeOn(m, p1, 100);
  const r1 = hangRange(m, p2, 1);
  hang(m, p2, 1, r1.hi);                   // 抓在藤蔓最下面：腳在範圍裡
  assert(p2.y > lane.top, 'p2 inside the lane');
  hang(m, p3, 0, Math.floor(lane.top) - 2);   // 腳在範圍上緣上面
  const b = forced(m, 'charge');
  const W = CONFIG.WEAPONS.snakeCharge;
  const hits = b.shot.events.filter(e => e.target).map(e => e.target).sort();
  assert(hits.join() === 'p1,p2', 'hits p1 and p2 only: ' + hits);
  assert(p1.poison === W.poison && p2.poison === W.poison && p3.poison === 0, 'poison 3: ' + [p1.poison, p2.poison, p3.poison]);
  assert(p1.hp === 150 - Math.round(W.damage * mult()) && p3.hp === 150, 'damage per config');
  assert(p2.onVine === -1 && p3.onVine === 0, 'p2 knocked off the vine, p3 still hanging');
  assert(!b.shot.events.some(e => e.target === 'snake'), 'does not hit itself');
  assert(lane.top === m.byId('snake').y - m.byId('snake').h && lane.x1 === m.byId('snake').x - m.byId('snake').hw, 'lane = head height, from the snout');
  return { lane: [lane.top, lane.bottom, lane.x1] };
});

test('毒液噴灑：從嘴巴往左上散射 count 顆（拋物線、穿過藤蔓橋掉進水裡），同一次噴灑每人最多中一次（10 層）', () => {
  let hitPlayers = 0, globs = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const m = jungle(4, { seed, hp: 150 });
    placeOn(m, m.players[0], 80);
    placeOn(m, m.players[1], 260);
    placeOn(m, m.players[2], 440);
    hang(m, m.players[3], 1, 420);
    const b = forced(m, 'spray');
    globs = b.shot.projectiles.length;
    assert(globs === CONFIG.SNAKE_BOSS.spray.count, 'glob count');
    assert(b.shot.projectiles.every(p => p.vx < 0 && p.vy < 0), 'all launched up-left');
    assert(!b.shot.events.some(e => e.type === 'terrain' || e.target === 'snake'), 'no terrain hits (passes the bridge), no self hits');
    for (const p of m.players) {
      assert(p.poison === 0 || p.poison === CONFIG.WEAPONS.snakeVenom.poison, `${p.id} at most one hit: ${p.poison}`);
      const hits = b.shot.events.filter(e => e.target === p.id).length;
      assert(hits <= 1, `${p.id} hit ${hits} times`);
      if (p.poison) hitPlayers++;
    }
  }
  assert(hitPlayers > 10 && hitPlayers < 90, 'spray hits a fair share: ' + hitPlayers + '/100');
  return { globs, hitPlayers: hitPlayers + '/100' };
});

test('大地震擊：只打站在橋上的人（50 × 敵人倍率），往巨蟒的方向擊退（knockback）；離巨蟒近的被甩下水、遠的留在橋上；掛在藤蔓上的沒事', () => {
  const m = jungle(3, { seed: 8, hp: 150 });
  const [p1, p2, p3] = m.players;
  placeOn(m, p1, 60);
  placeOn(m, p2, 480);
  hang(m, p3, 0, 450);
  const b = forced(m, 'quake');
  const evs = b.shot.events.filter(e => e.target);
  assert(evs.map(e => e.target).sort().join() === 'p1,p2', 'only bridge standers: ' + evs.map(e => e.target));
  for (const ev of evs) {
    const s = ev.ents.find(x => x.id === ev.target);
    assert(Math.abs(s.vx - CONFIG.WEAPONS.snakeQuake.knockback) < 1 && s.vy < 0, `${ev.target} pushed toward the snake: vx ${s.vx}`);
    assert(ev.damages[0].dmg === enemyDmg('snakeQuake'), 'quake damage ' + ev.damages[0].dmg);
  }
  assert(p2.waterFalls === 1 && p1.waterFalls === 0 && p1.onGround, `p2 into the water, p1 stays: ${p2.waterFalls} ${p1.waterFalls}`);
  assert(p2.hp === 150 - enemyDmg('snakeQuake') - Math.round(150 * CONFIG.WATER.damagePct / 100), 'water damage on top: ' + p2.hp);
  assert(p1.x > 60, 'p1 slid toward the snake');
  assert(p3.hp === 150 && p3.onVine === 0, 'hanging player untouched');
  return { p1x: Math.round(p1.x) };
});

test('劇毒撕咬：咬離嘴巴最近的玩家（15 × 敵人倍率 + 10 層毒），藤蔓上的也咬得到（被咬下來）；沒有活著的玩家就發呆', () => {
  const m = jungle(2, { seed: 3, hp: 150 });
  const [p1, p2] = m.players;
  placeOn(m, p1, 100);
  placeOn(m, p2, 420);
  assert(nearestPlayer(m) === p2, 'nearest is p2');
  const b = forced(m, 'bite');
  assert(b.targetId === 'p2' && p2.poison === CONFIG.WEAPONS.snakeBite.poison && p2.hp === 150 - enemyDmg('snakeBite') && p1.poison === 0, 'bites p2: ' + JSON.stringify(b.shot.events));
  hang(m, p1, 2, 430);
  assert(nearestPlayer(m) === p1, 'the vine near the snake is closest');
  const b2 = forced(m, 'bite');
  assert(b2.targetId === 'p1' && p1.poison === 10 && p1.onVine === -1, 'bites the hanging player off the vine');
  for (const p of m.players) p.die('hit');
  const b3 = forced(m, 'bite');
  assert(b3.action === 'idle' && b3.still, 'idle without targets');
  return { first: b.targetId, second: b2.targetId };
});

test('客戶端照事件重播四種招式（擊退、落水、被撞下藤蔓、上毒），結果跟伺服器位元級一致', () => {
  const out = {};
  for (const action of ['charge', 'spray', 'quake', 'bite']) {
    const m = jungle(4, { seed: 31, hp: 150 });
    placeOn(m, m.players[0], 90);
    placeOn(m, m.players[1], 500);
    hang(m, m.players[2], 1, 480);
    hang(m, m.players[3], 2, 400);
    m.players[1].hp = 20;
    const snap = JSON.parse(JSON.stringify(m.snapshot()));
    const b = JSON.parse(JSON.stringify(forced(m, action)));
    const cm = new Match({ levelId: 'jungleSerpent', players: mkPlayers(4), seed: m.seed, stage: 5 });
    cm.applySnapshot(snap);
    replayChecked(cm, b.shot, action);
    for (const s of b.shot.results) {
      const e = cm.byId(s.id);
      const same = e.x === s.x && e.y === s.y && e.hp === s.hp && e.alive === s.alive && e.onVine === s.vn && e.poison === s.ps && e.waterFalls === s.wf;
      assert(same, `${action}: ${s.id} client ${[e.x, e.y, e.hp, e.alive, e.onVine, e.poison, e.waterFalls]} vs server ${[s.x, s.y, s.hp, s.alive, s.vn, s.ps, s.wf]}`);
    }
    out[action] = b.shot.events.map(e => e.type + (e.target ? ':' + e.target : '')).join(' ');
  }
  return out;
});

test('裁判：巨蟒的回合廣播 aiTurn（boss.steps 一招 + shot、boss.next），等動畫播完才換人；打倒巨蟒就過關', () => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'jungleSerpent', players, seed: 17, stage: 5 });
  for (const p of m.players) { p.hp = p.maxHp = 100000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const at = new Map();
  const broadcast = io.broadcast.bind(io);
  io.broadcast = (msg, ex) => { broadcast(msg, ex); at.set(io.log.at(-1), io.t); };
  assert(advanceUntil(io, () => io.take('aiTurn').length >= 4, 1_200_000), 'four snake turns');
  const T = CONFIG.TIMING;
  for (const a of io.take('aiTurn').slice(0, -1)) {   // 最後一個的下一回合還沒到
    assert(a.actorId === 'snake' && a.boss && a.boss.steps.length === 1 && a.boss.next && a.boss.next.action, 'snake turn shape');
    const st = a.boss.steps[0];
    const secs = T.aiThink + T.bossCast + (st.shot ? st.shot.flightFrames + st.shot.settleFrames : st.still.settleFrames) / 60 + T.afterShotPad;
    const next = io.log.slice(io.log.indexOf(a) + 1).find(x => x.t === 'turn' || x.t === 'turnFx' || x.t === 'gameOver');
    assert(next && Math.abs(at.get(next) - at.get(a) - secs * 1000) <= 2, `waits for the animation: ${next && at.get(next) - at.get(a)} vs ${secs * 1000}`);
  }
  // 打倒巨蟒 → 過關
  m.byId('snake').hp = 1;
  assert(advanceUntil(io, () => ref.phase === 'turn'), 'a player turn');
  const a = m.byId(ref.currentId);
  placeOn(m, a, 200);
  for (const q of m.players) if (q !== a) placeOn(m, q, 40);   // 隊友站到後面，別擋在彈道上
  const s = m.byId('snake');
  const mz = a.muzzle();
  const ang = Math.atan2(-(s.cy - mz.y), s.x - s.hw + 10 - mz.x) * 180 / Math.PI;
  const nShots = io.take('shot').length;
  ref.handle(a.id, { t: 'fire', weapon: 'sniper', angle: ang, power: 100, x: a.x, y: a.y, facing: 1, stamina: a.stamina });
  const killShot = io.take('shot')[nShots];
  assert(killShot && killShot.events.some(e => e.target === 'snake'), 'hit the snake: ' + JSON.stringify(killShot && killShot.events).slice(0, 300));
  assert(advanceUntil(io, () => ref.phase === 'over'), 'over');
  assert(io.take('gameOver')[0].result === 'win', 'win');
  return { actions: io.take('aiTurn').map(x => x.boss.steps[0].action) };
});

test('客戶端：預定衝撞時一直畫出警示帶（範圍 = chargeLane 到水面）；其他招式不畫；巨蟒出衝撞時預兆快閃、衝出去後不畫；預定等巨蟒回合播完才換', () => {
  const m = jungle(1, { seed: 4 });
  const view = { match: m, time: 1.3, snakeFx: null, particles: [], projectiles: [], shake: 0,
    showBanner() {}, spawnParticles() {}, floatText() {}, splash() {}, *shotScript() { yield { frames: 1 }; } };
  const draw = () => { const r = recordingCtx(); drawSnakeScene(r.ctx, view); return r; };
  const lane = chargeLane(m);
  const rect = [lane.x0, lane.top, lane.x1 - lane.x0, CONFIG.WATER_LEVEL - lane.top].map(v => Math.round(v)).join();
  m.snake.next = { action: 'charge' };
  const r = draw();
  assert(redBands(r.calls).join('|') === rect, 'steady band: ' + redBands(r.calls) + ' vs ' + rect);
  const dash = r.calls.filter(c => c.fn === 'setLineDash');
  assert(dash.length && dash.at(-1).args[0].length === 0, 'line dash reset');
  for (const action of ['spray', 'quake', 'bite', 'idle']) {
    m.snake.next = { action };
    assert(redBands(draw().calls).length === 0, 'no band for ' + action);
  }
  m.snake.next = { action: 'charge' };
  m.byId('snake').alive = false;
  assert(redBands(draw().calls).length === 0, 'no band once the snake is dead');
  m.byId('snake').alive = true;
  const msg = { actorId: 'snake', boss: { steps: [{ action: 'charge', shot: {} }], next: { action: 'bite' } } };
  const seen = [];
  const gen = snakeTurnScript(view, msg);
  for (let it = gen.next(); !it.done; it = gen.next()) {
    assert(m.snake.next.action === 'charge', 'old plan stays during the snake turn');
    const fx = view.snakeFx;
    const bands = redBands(draw().calls);
    const phase = !fx ? 'think' : fx.phase;
    assert(phase === 'act' ? bands.length === 0 : bands.join('|') === rect, `${phase}: ${bands}`);
    if (seen.at(-1) !== phase) seen.push(phase);
    view.time += 1 / 60;
  }
  assert(seen.join() === 'think,cast,act', 'phases ' + seen);
  assert(m.snake.next.action === 'bite' && redBands(draw().calls).length === 0, 'boss.next applied at the end');
  return { phases: seen };
});

test('確定性：同 seed 同輸入，叢林巨蟒整段流程的廣播完全一樣（含蛇血、中毒、斷線代打）', () => {
  const run = () => {
    const players = mkPlayers(3);
    const m = new Match({ levelId: 'jungleSerpent', players, seed: 77, stage: 5 });
    for (const p of m.players) { p.hp = p.maxHp = 1500; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io });
    ref.start();
    ref.setConnected('p2', false);
    let guard = 0;
    const rng = new Rng(7);
    while (ref.phase !== 'over' && guard++ < 2000) {
      io.advance(250);
      if (ref.phase === 'turn') {
        const a = m.byId(ref.currentId);
        if (m.items.length && a.poisonLock > 0) {   // 去喝蛇血
          const it = m.items[0];
          ref.handle(a.id, { t: 'move', x: it.x, y: a.y, vy: 0, facing: 1, stamina: a.stamina });
        }
        const plan = planShot(m.world, a, rng);
        if (plan) ref.handle(a.id, { t: 'fire', weapon: plan.weapon, angle: plan.angle, power: plan.power, x: a.x, y: a.y, facing: a.facing, stamina: a.stamina });
      }
      if (io.t > 60 * 60_000) break;
    }
    return JSON.stringify(io.log.map(({ _except, ...x }) => x));
  };
  const a = run(), b = run();
  assert(a === b, 'two runs differ');
  const log = JSON.parse(a);
  const acts = log.filter(x => x.t === 'aiTurn' && x.boss).map(x => x.boss.steps[0].action);
  return {
    bytes: a.length, snakeTurns: acts.length, kinds: [...new Set(acts)],
    pickups: log.filter(x => x.t === 'pickup').length,
    drops: log.filter(x => x.t === 'shot').reduce((n, s) => n + s.events.reduce((k, e) => k + (e.drops ? e.drops.length : 0), 0), 0),
    result: (log.find(x => x.t === 'gameOver') || {}).result || 'running',
  };
});

test('藤蔓（按鍵組合）：邊走邊跳、按著 W 就抓得住不會馬上掉；掛著時 A / D + 空白鍵同一幀 = 往那邊跳開；沒按 W / S 時 A / D 才放手', () => {
  const m = jungle(1);
  const p = m.players[0];
  const v = m.terrain.vines[0];
  placeOn(m, p, v.x - 30);
  p.stamina = 1e9;
  p.moveDir = 1;
  p.vineDir = -1;
  p.wantJump = true;
  let n = 0;
  while (p.onVine < 0 && n++ < 60) m.step();
  assert(p.onVine === 0 && p.x === v.x, 'grabbed while holding D + W: ' + p.onVine);
  stepN(m, 20);
  assert(p.onVine === 0, 'still hanging while D + W are held');
  // A / D + 空白鍵同一幀：跳開（耗跳躍體力、往上），不是直接掉下去
  p.vineDir = 0;
  p.stamina = 100;
  p.wantJump = true;
  m.step();
  assert(p.onVine === -1 && p.vy < 0 && p.stamina < 100 && p.stamina >= 100 - p.jumpCost - 3, 'jumped off with D held: vy ' + p.vy + ' stamina ' + p.stamina);
  // 沒按 W / S：A / D 放手
  p.moveDir = 0;
  m.settle(300);
  hang(m, p, 0, 420);
  p.moveDir = -1;
  m.step();
  assert(p.onVine === -1 && p.vy >= 0, 'A without W lets go');
  return { grabbedAfter: n };
});

test('藤蔓上端在上方 HUD 下面：爬到最上面時，頭上的角度框（y - h - 74）也不會跑進 HUD（y ≤ 78）', () => {
  const m = jungle(1);
  const p = m.players[0];
  for (let i = 0; i < m.terrain.vines.length; i++) {
    const { lo } = hangRange(m, p, i);
    assert(lo - p.h - 74 > 84, `vine ${i}: angle box top ${lo - p.h - 74}`);
  }
});

test('毒液噴灑：三條藤蔓的上段、橋上各處都有機會被噴到（沒有完全安全的地方）', () => {
  const spots = [];
  const m0 = jungle(1);
  for (let i = 0; i < m0.terrain.vines.length; i++) {
    const { lo, hi } = hangRange(m0, m0.players[0], i);
    spots.push({ vine: i, y: lo }, { vine: i, y: Math.round((lo + hi) / 2) });
  }
  for (const x of [40, 300, 560]) spots.push({ x });
  const hits = spots.map(() => 0);
  for (let seed = 1; seed <= 150; seed++) {
    const m = jungle(spots.length, { seed });
    spots.forEach((s, k) => { const p = m.players[k]; if (s.vine !== undefined) hang(m, p, s.vine, s.y); else placeOn(m, p, s.x); });
    forced(m, 'spray');
    m.players.forEach((p, k) => { if (p.poison) hits[k]++; });
  }
  const label = spots.map((s, k) => `${s.vine !== undefined ? `v${s.vine}@${s.y}` : `x${s.x}`}:${hits[k]}`);
  assert(hits.every(h => h > 0), 'every spot can be sprayed: ' + label);
  return label;
});

test('裁判：第一位玩家在自己的回合開始被毒倒，輪數不會跳號（下一位還是同一輪）；turnFx 帶 atStart 與輪數', () => {
  const m = jungle(2, { hp: 1000 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(2), io });
  m.snake.next = { action: 'quake' };
  ref.start();
  const seen = [];
  const broadcast = io.broadcast.bind(io);
  io.broadcast = (msg, ex) => {
    broadcast(msg, ex);
    if (msg.t === 'turn' && !msg.ai) seen.push(`${msg.actorId}@${msg.round}`);
    if (msg.t === 'aiTurn') seen.push(`snake@${ref.round}`);
    if (msg.t === 'turnFx' && msg.atStart) seen.push(`dead:${msg.actorId}@${msg.round}`);
    if (msg.t === 'aiTurn') { const p1 = m.byId('p1'); if (p1.alive) { p1.hp = 3; p1.poison = 50; } }   // 巨蟒的回合之後 p1 就會被毒倒
  };
  for (let k = 0; k < 6 && ref.phase !== 'over'; k++) {
    assert(advanceUntil(io, () => ref.phase === 'turn', 600_000), 'turn ' + k);
    const a = m.byId(ref.currentId);
    ref.handle(a.id, { t: 'fire', weapon: 'sniper', angle: 80, power: 100, x: a.x, y: a.y, facing: 1, stamina: 0 });
  }
  const dead = seen.find(s => s.startsWith('dead:'));
  assert(dead, 'p1 died at turn start: ' + seen);
  const r = Number(dead.split('@')[1]);
  const after = seen.slice(seen.indexOf(dead) + 1);
  assert(after[0] === `p2@${r}` && after[1] === `snake@${r}` && after[2] === `p2@${r + 1}`, 'round order: ' + seen.join(' '));
  return { seen: seen.join(' ') };
});

test('蛇血（客戶端預測）：客戶端照自己的路線逐幀判到蛇血、馬上回報位置 → 伺服器也判到，兩邊解開後的上限一樣', () => {
  const m = jungle(1, { hp: 100 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  ref.start();
  assert(advanceUntil(io, () => ref.phase === 'turn'), 'p1 turn');
  const p = m.byId('p1');
  placeOn(m, p, 300);
  p.hp = 30; p.maxHp = 60; p.poisonLock = 40;
  m.items.push({ id: 'a5', type: 'snakeBlood', x: 420, y: bridgeY(m) });
  // 客戶端：同樣的狀態，自己往右走（跳一下），逐幀檢查
  const cm = jungle(1);
  cm.applySnapshot(JSON.parse(JSON.stringify(m.snapshot())));
  const cp = cm.players[0];
  cp.applyState(p.toState());
  cp.moveDir = 1; cp.stamina = 1e9;
  let got = null, frames = 0, lastReport = { x: cp.x, y: cp.y };
  while (!got && frames++ < 200) {
    if (frames === 3) cp.wantJump = true;   // 跳一下、落地時正好落在蛇血上（路線是拋物線，不是直線）
    const px = cp.x, py = cp.y;
    cm.step();
    got = pickupAlong(cm, cp, px, py, cp.x, cp.y);
    if (frames % 6 === 0 && !got) {   // 平常 10Hz 回報
      ref.handle('p1', { t: 'move', x: cp.x, y: cp.y, vy: cp.vy, facing: 1, stamina: p.stamina });
      lastReport = { x: cp.x, y: cp.y };
    }
  }
  assert(got && got.item === 'a5', 'client predicted the drink');
  ref.handle('p1', { t: 'move', x: cp.x, y: cp.y, vy: cp.vy, facing: 1, stamina: p.stamina });   // 預測到就馬上回報
  const pk = io.take('pickup');
  assert(pk.length === 1 && pk[0].item === 'a5', 'server confirms the same bottle: ' + JSON.stringify(pk));
  assert(cp.maxHp === p.maxHp && cp.poisonLock === 0 && p.poisonLock === 0 && cp.maxHp === 100 && cp.hp === p.hp && p.hp === 30 + CONFIG.SNAKE_BOSS.bloodHeal, `same unlocked max and hp: client ${cp.hp}/${cp.maxHp} server ${p.hp}/${p.maxHp}`);
  return { frames, from: lastReport };
});

test('中毒不會自己解除：每個自己的回合開始都再扣一次、再被打中還會疊上去；喝蛇血才解毒（層數歸零 + 解鎖 + 回血），全員看到的層數一致', () => withPoison({ persist: true }, () => withSnake({ bloodHeal: 30 }, () => {
  const m = jungle(1, { hp: 200 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  const p = m.byId('p1');
  placeOn(m, p, 100);
  p.poison = 10;
  ref.start();
  const ticks = [];
  for (let k = 0; k < 3; k++) {
    const mine = () => io.take('turn').filter(x => x.actorId === 'p1');
    assert(advanceUntil(io, () => ref.phase === 'turn' && mine().length > k, 600_000), 'turn ' + k);
    const t = mine()[k];
    const fx = t.fx.find(f => f.type === 'poison');
    ticks.push(fx ? fx.stacks : 0);
    assert(t.entities.find(e => e.id === 'p1').ps === p.poison, 'turn snapshot carries the stacks');
    if (k < 2) ref.handle('p1', { t: 'fire', weapon: 'sniper', angle: 80, power: 100, x: p.x, y: p.y, facing: 1, stamina: 0 });
  }
  assert(ticks[0] === 10 && ticks.every((s, i) => !i || s >= ticks[i - 1]), 'stacks stay (and may grow from new hits): ' + ticks);
  // 喝蛇血：解毒
  const stacks = p.poison;
  m.items.push({ id: 'a7', type: 'snakeBlood', x: 140, y: bridgeY(m) });
  ref.handle('p1', { t: 'move', x: 160, y: p.y, vy: 0, facing: 1, stamina: p.stamina });
  const pk = io.take('pickup').at(-1);
  assert(pk && pk.cured === stacks && p.poison === 0 && p.poisonLock === 0, 'snake blood cures: ' + JSON.stringify(pk));
  const curedAt = io.log.length;
  ref.handle('p1', { t: 'fire', weapon: 'sniper', angle: 80, power: 100, x: p.x, y: p.y, facing: 1, stamina: 0 });
  const mineNow = () => io.take('turn').filter(x => x.actorId === 'p1');
  const n = mineNow().length;
  assert(advanceUntil(io, () => mineNow().length > n, 600_000), 'next turn');
  const next = mineNow()[n];
  // 解毒之後只剩新被打中的層數
  const fresh = io.log.slice(curedAt).filter(x => x.t === 'aiTurn').flatMap(x => x.boss.steps).flatMap(st => st.shot ? st.shot.events : [])
    .flatMap(ev => ev.damages || []).filter(d => d.id === 'p1' && d.poison).reduce((sum, d) => sum + d.poison, 0);
  const tick = next.fx.find(f => f.type === 'poison');
  assert((tick ? tick.stacks : 0) === fresh, `after the cure only new stacks tick: ${tick && tick.stacks} vs ${fresh}`);
  return { ticks, cured: stacks };
})));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
