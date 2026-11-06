// node test/monkey.js
// 2026-11-03：菁英關「頑皮猴王」（森林，莫利亞森林的菁英池）。
// 關卡（菁英池、三個水坑、高樹枝 / 低樹枝、猴王 fixed、血量照一般敵人放大）、接住（從身邊飛過去才接、會打中他的不接、狙擊槍接不到、
// 手上最多 3 顆、生氣了範圍變大、只接玩家的）、打中拿著砲彈的他（手上的砲彈在他身上炸開、算打中的人的）、
// 他的回合（丟回去給開槍的人：原本武器的傷害、偏 0 ~ 60；開槍的人倒下就丟掉；椰子 / 香蕉皮；盪到另一根樹枝）、
// 香蕉皮（踩到滑 150、站在上面一走就滑、原地 / 跳過去不算、滑行中跳不起來、不丟在有人站的地方、被炸掉）、滑行沒滑完不算站穩、套用伺服器狀態就停、AI 代打走路滑完（含滑進水坑、客戶端重播一樣）、客戶端重播一致、快照 / 重連、裁判（AI 代打走路踩到香蕉皮）、真的 GameView
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { MONKEY_ID, monkeyOf, snatch, touchPeel, catchRadius, perchSpot, applyPeelPickup } from '../shared/maps/monkey.js';
import { replayChecked } from './replay-check.js';

const results = [];
async function test(name, fn) {
  try {
    const info = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${info ? '  ' + JSON.stringify(info) : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const J = JSON.stringify;

class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.records = []; this.seq = 0; }
  broadcast(msg) { this.log.push(JSON.parse(J(msg))); }
  record(ev, data) { this.records.push({ ev, ...JSON.parse(J(data)) }); }
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
}
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const make = (n = 1, opts = {}) => new Match({ levelId: 'forestMonkey', players: mkPlayers(n), seed: 1, stage: 3, ...opts });
// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原
function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, { ...CONFIG[k] }]));
  for (const [k, v] of Object.entries(patch)) Object.assign(CONFIG[k], v);
  const restore = () => { for (const [k, v] of Object.entries(saved)) { for (const key of Object.keys(CONFIG[k])) if (!(key in v)) delete CONFIG[k][key]; Object.assign(CONFIG[k], v); } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}
const MONKEY = {
  hp: 200, catchRadius: 100, angryRadius: 150, angryPct: 0.4, maxHeld: 3,
  catchable: ['cannon', 'plasma', 'darts', 'bombard', 'boomerang'], weights: { coconut: 60, peel: 40 },
  throwError: 60, coconutError: 30, maxPeels: 3, peelGap: [40, 90], slip: 150,
  cast: { throw: 0.7, coconut: 0.9, peel: 0.9, swing: 1.0 },
};
const BASE = {
  ENEMY: { hp: 45, damageMult: 0.7, lateFromStage: 6, damageMultLate: 1 },
  RUN: { stageCount: 10, bossStages: [5, 10], eliteStages: [3, 8], enemyHpPerStage: 0.15 },
  MONKEY,
  PLAYER: { hp: 150, stamina: 200 }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180, gravity: 600 },
    sniper: { ...CONFIG.WEAPONS.sniper },
    plasma: { ...CONFIG.WEAPONS.plasma },
    monkeyCoconut: { ...CONFIG.WEAPONS.monkeyCoconut, damage: 12, radius: 24, knockback: 90, gravity: 600 },
    monkeyThrow: { ...CONFIG.WEAPONS.monkeyThrow },
  },
};
const base = (fn, extra = {}) => {
  const patch = { ...BASE };
  for (const [k, v] of Object.entries(extra)) patch[k] = { ...(BASE[k] || {}), ...v };
  return withConfig(patch, fn);
};
const only = (action) => ({ MONKEY: { ...MONKEY, weights: { coconut: 0, peel: 0, [action]: 1 } } });
// 把角色放到 (x, y) 正下方站好
function placeOn(m, e, x, y = 500) {
  e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.onGround = false;
  for (let i = 0; i < 400 && !e.onGround; i++) e.update(CONFIG.FIXED_DT, m.world);
  e.safeX = e.x; e.safeY = e.y;
}
// 開一槍（直接結算），客戶端從開槍前的快照照事件重播，結果跟伺服器一樣（含手上的砲彈、香蕉皮）
function fire(m, shooter, weapon, angle, power) {
  const before = JSON.parse(J(m.snapshot()));
  const shot = m.resolveShot(shooter, weapon, angle, power);
  const c = make(m.players.length, { seed: m.seed });
  c.applySnapshot(before);
  const copy = JSON.parse(J(shot));
  replayChecked(c, copy, 'player shot');
  c.applyEntities(copy.results);
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), 'shot replay differs');
  assert(J(c.mechState.held) === J(m.mechState.held) && J(c.mechState.peels) === J(m.mechState.peels) && c.mechState.angry === m.mechState.angry,
    'client mech state ' + J([c.mechState.held, m.mechState.held, c.mechState.peels, m.mechState.peels]));
  return shot;
}
// 從出生點掃角度 × 力量，找第一發符合 pred(shot, m) 的（每一發都在新的一場打）。回傳 { angle, power }
function findShot(n, weapon, pred, setup = () => {}) {
  for (let a = 20; a <= 85; a += 1) {
    for (let pw = 30; pw <= 100; pw += 2) {
      const m = make(n);
      setup(m);
      const shot = m.resolveShot(m.players[0], weapon, a, pw);
      if (pred(shot, m)) return { angle: a, power: pw };
    }
  }
  return null;
}
const snatched = (shot) => shot.events.some(ev => ev.type === 'snatch');
const hitMonkey = (shot) => shot.events.some(ev => ev.target === MONKEY_ID);
// 讓猴王出一回合（不經過裁判），客戶端從出招前的快照照事件一招一招重播、套結果，跟伺服器一樣
function monkeyTurn(m) {
  const before = JSON.parse(J(m.snapshot()));
  const r = m.mechanic.aiTurn(m, monkeyOf(m));
  const c = make(m.players.length, { seed: m.seed });
  c.applySnapshot(before);
  for (const st of r.steps) {
    if (st.shot) {
      const shot = JSON.parse(J(st.shot));
      replayChecked(c, shot, st.action);
      c.applyEntities(shot.results);
    } else c.applyEntities(JSON.parse(J(st.still.results)));
  }
  const label = r.steps.map(st => st.action).join('+');
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${label}: entities differ`);
  return r.steps;
}
const stageInfo = () => ({ stage: 3, stageCount: 10, isBoss: false, type: 'elite', difficulty: 'normal', levelId: 'forestMonkey', levelName: '頑皮猴王', cards: {} });

// ---------------- 關卡、猴王 ----------------

await test('關卡：菁英池（莫利亞森林的菁英清單裡）、地圖機制 monkey、泥水坑的顏色；三個水坑（坑底在水面下、坑口 80 寬跳得過去）；三根高樹枝跳不上去、兩根低樹枝跳得上去；猴王 fixed 站在第 start 根樹枝的中間，血量 200 × 一般敵人的倍率', () => base(() => {
  const L = LEVELS.forestMonkey;
  assert(levelsInPool('elite').includes('forestMonkey') && !levelsInPool('normal').includes('forestMonkey') && L.name === '頑皮猴王' && L.theme === 'forest', 'pool');
  assert(CONFIG.THEMES.moria.maps.elite.includes('forestMonkey') && L.mechanic.type === 'monkey' && L.waterColors.length === 3, 'level');
  const m = make(2);
  const t = m.terrain;
  for (const x of [336, 593, 836]) assert(!t.isSolid(x, CONFIG.WATER_LEVEL - 2) && !t.isSolid(x, 580), 'pool at ' + x);
  for (const x of [200, 470, 700, 980]) assert(t.isSolid(x, 590), 'ground at ' + x);
  const jump = CONFIG.PLAYER.jumpSpeed * CONFIG.PLAYER.jumpSpeed / (2 * CONFIG.GRAVITY);
  assert(L.mechanic.perches.every(p => 576 - p.y > jump + 100), 'perches out of reach');
  const low = L.platforms.slice(3);
  assert(low.length === 2 && low.every(poly => 576 - poly[0][1] < jump), 'low branches reachable ' + low.map(p => p[0][1]));
  const g = monkeyOf(m);
  const at = perchSpot(L.mechanic.perches[L.mechanic.start]);
  assert(g && g.fixed && g.team === 'enemies' && g.x === at.x && g.y === at.y && g.kind === 'monkey', 'monkey ' + J([g.x, g.y]));
  const solo = make(1);
  assert(monkeyOf(solo).maxHp >= 200 && monkeyOf(solo).maxHp < g.maxHp, 'hp scales ' + [monkeyOf(solo).maxHp, g.maxHp]);
  assert(m.players.every(p => p.onGround && p.alive), 'players stand');
  return { hp: [monkeyOf(solo).maxHp, g.maxHp] };
}));

await test('接住（snatch 的判定）：玩家的、能接的武器、這一幀在範圍內而且已經過了最靠近的那一點、飛下去不會打中他 → 接住；還在靠近、範圍外、狙擊槍、敵人的、手上滿了、會繞回來打中他 → 不接；生氣了範圍 150', () => base(() => {
  const m = make(2);
  const g = monkeyOf(m);
  const p1 = m.players[0];
  const seg = (d0, d1, weapon = 'cannon', ahead = null) => ({ x0: g.cx - d0, y0: g.cy, x1: g.cx - d1, y1: g.cy, r: 6, weapon, ahead: () => ahead });
  const S = m.mechState;
  const reset = () => { S.held = []; };
  assert(snatch(m, p1, seg(60, 70)) && J(S.held) === J([{ w: 'cannon', by: 'p1' }]), 'receding inside → caught');
  reset();
  assert(snatch(m, p1, seg(80, 70)) === null, 'approaching → not yet');
  assert(snatch(m, p1, seg(110, 120)) === null, 'outside → no');
  assert(snatch(m, p1, seg(60, 70, 'sniper')) === null, 'sniper → no');
  assert(snatch(m, g, seg(60, 70)) === null, "enemy's → no");
  assert(snatch(m, p1, seg(60, 70, 'cannon', { type: 'entity', entity: g })) === null, 'would hit him later → no');
  S.held = [{ w: 'cannon', by: 'p2' }, { w: 'cannon', by: 'p2' }, { w: 'cannon', by: 'p2' }];
  assert(snatch(m, p1, seg(60, 70)) === null, 'full → no');
  reset();
  assert(catchRadius(S) === 100 && snatch(m, p1, seg(120, 130)) === null, 'normal radius');
  S.angry = true;
  assert(catchRadius(S) === 150 && snatch(m, p1, seg(120, 130)), 'angry radius');
  for (const w of ['plasma', 'darts', 'bombard', 'boomerang']) { reset(); assert(snatch(m, p1, seg(60, 70, w)), w); }
}));

await test('接住（真的開一槍）：大砲從他身邊飛過去 → 事件 snatch、飛行物到此為止（沒有爆炸、沒挖地）、手上多一顆（誰的）、他沒扣血；直擊照常打中；客戶端重播一致', () => base(() => {
  const near = findShot(2, 'cannon', (s) => snatched(s));
  assert(near, 'some shot passes near him');
  const m = make(2);
  const g = monkeyOf(m);
  const hp0 = g.hp, holes0 = m.terrain.holes.length;
  const shot = fire(m, m.players[0], 'cannon', near.angle, near.power);
  const ev = shot.events.find(e => e.type === 'snatch');
  assert(ev && J(ev.monkeyCatch) === J({ w: 'cannon', by: 'p1' }) && !shot.events.some(e => e.type === 'explode'), 'snatched ' + J(shot.events.map(e => e.type)));
  assert(Math.hypot(ev.x - g.cx, ev.y - g.cy) <= 100 && g.hp === hp0 && m.terrain.holes.length === holes0 && J(m.mechState.held) === J([{ w: 'cannon', by: 'p1' }]), 'held');
  assert(shot.hit.type === 'snatch' && shot.hitEnemy === false, 'summary ' + J(shot.hit));
  const direct = findShot(2, 'cannon', (s) => hitMonkey(s));
  assert(direct, 'some shot hits him');
  const m2 = make(2);
  const s2 = fire(m2, m2.players[0], 'cannon', direct.angle, direct.power);
  assert(!snatched(s2) && monkeyOf(m2).hp < monkeyOf(m2).maxHp && !m2.mechState.held.length, 'direct hit');
  return { near, direct };
}));

await test('打中拿著砲彈的猴王：手上的砲彈全部在他身上炸開（照原本的武器、算打中他的人的：傷害、統計）、手上清空、事件帶 monkey.burst；沒拿砲彈就只有那一下；客戶端重播一致', () => base(() => {
  const direct = findShot(2, 'cannon', (s) => hitMonkey(s));
  const plain = make(2);
  const d0 = fire(plain, plain.players[0], 'cannon', direct.angle, direct.power);
  const lost0 = monkeyOf(plain).maxHp - monkeyOf(plain).hp;
  const m = make(2);
  m.mechState.held = [{ w: 'cannon', by: 'p2' }, { w: 'plasma', by: 'p1' }];
  const shot = fire(m, m.players[0], 'cannon', direct.angle, direct.power);
  const g = monkeyOf(m);
  const lost = g.maxHp - g.hp;
  const ev = shot.events.find(e => e.monkey && e.monkey.burst);
  assert(ev && J(ev.monkey.burst) === J(['cannon', 'plasma']) && !m.mechState.held.length && ev.monkey.dmg > 0, 'burst ' + J(shot.events.map(e => e.monkey)));
  const mult = m.damageMult(m.players[0], CONFIG.WEAPONS.cannon);
  const extra = Math.round((CONFIG.WEAPONS.cannon.damage + CONFIG.WEAPONS.plasma.damage) * mult);
  assert(Math.abs(lost - lost0 - extra) <= 2 && Math.abs(ev.monkey.dmg - (lost - lost0)) <= 1, `extra damage ${lost - lost0} vs ${extra} / ${ev.monkey.dmg}`);
  assert(m.players[0].dealt === lost && plain.players[0].dealt === lost0, 'credited to the shooter ' + [m.players[0].dealt, lost]);
  assert(!d0.events.some(e => e.monkey), 'no burst without shells');
  return { lost0, lost };
}));

await test('生氣：血量掉到 40% 以下 → angry（事件帶 monkey.angry、接住範圍 150），之後一直生氣', () => base(() => {
  const direct = findShot(2, 'cannon', (s) => hitMonkey(s));
  const m = make(2);
  const g = monkeyOf(m);
  g.hp = Math.floor(g.maxHp * 0.4) + 5;
  const shot = fire(m, m.players[0], 'cannon', direct.angle, direct.power);
  assert(m.mechState.angry && shot.events.some(e => e.monkey && e.monkey.angry) && catchRadius(m.mechState) === 150, 'angry');
}));

// ---------------- 他的回合 ----------------

await test('他的回合：手上的砲彈一顆一顆丟回給開槍的人（原本武器的傷害、瞄他身體中心左右偏 0 ~ 60）、開槍的人倒下了那顆丟掉；接著出一招；最後盪到另一根樹枝；客戶端重播一致', () => base(() => {
  const offs = [];
  const perches = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const m = make(3, { seed });
    const S = m.mechState;
    S.held = [{ w: 'cannon', by: 'p1' }, { w: 'plasma', by: 'p2' }, { w: 'cannon', by: 'p3' }];
    m.byId('p3').die('hit');
    const from = S.perch;
    const pos = Object.fromEntries(m.players.map(p => [p.id, p.cx]));
    const steps = monkeyTurn(m);
    const acts = steps.map(s => s.action);
    assert(J(acts.slice(0, 3)) === J(['throw', 'throw', 'drop']) && ['coconut', 'peel'].includes(acts[3]) && acts[4] === 'swing' && acts.length === 5, 'order ' + J(acts));
    assert(steps[0].targetId === 'p1' && steps[0].w === 'cannon' && steps[0].dmg === CONFIG.WEAPONS.cannon.damage, 'cannon back to p1');
    assert(steps[1].targetId === 'p2' && steps[1].w === 'plasma' && steps[1].dmg === CONFIG.WEAPONS.plasma.damage, 'plasma back to p2');
    for (const s of steps.slice(0, 2)) offs.push(Math.abs(s.aim.x - pos[s.targetId]));
    assert(S.perch !== from && !S.held.length && steps[4].perch === S.perch, 'swung ' + [from, S.perch]);
    perches.add(S.perch);
  }
  assert(offs.every(o => o <= 60.1) && offs.some(o => o > 10), 'aim offsets ' + offs.map(Math.round));
  return { offs: offs.map(Math.round), perches: [...perches] };
}));

await test('椰子砸：12 × 開場人數 × 敵人倍率、拋向隨機一名玩家（偏 0 ~ 30）；香蕉皮：丟在玩家左右 40 ~ 90 的地上（站得住的地方）、場上最多 3 張（滿了改丟椰子）', () => base(() => {
  const m = make(2, { seed: 2 });
  const steps = withConfig(only('coconut'), () => monkeyTurn(m));
  const co = steps.find(s => s.action === 'coconut');
  assert(co && co.dmg === 24, 'coconut dmg ' + (co && co.dmg));
  const m2 = make(2, { seed: 3 });
  const placed = [];
  for (let k = 0; k < 4; k++) {
    const st = withConfig(only('peel'), () => monkeyTurn(m2));
    placed.push(st.find(s => s.action === 'peel' || s.action === 'coconut').action);
  }
  assert(J(placed) === J(['peel', 'peel', 'peel', 'coconut']) && m2.mechState.peels.length === 3, 'max 3 ' + J(placed));
  for (const q of m2.mechState.peels) {
    const p = m2.players.find(e => Math.abs(Math.abs(q.x - e.x) - 65) <= 26);
    assert(p && p.canStandAt(m2.terrain, q.x, q.y), 'peel near a player, on the ground ' + J(q));
  }
  return { peels: m2.mechState.peels };
}));

// ---------------- 香蕉皮 ----------------

await test('香蕉皮：走路踩到（位置回報）→ pickup（type peel、方向）、香蕉皮消失、往走的方向滑 150 左右；站在上面（被炸過去、跳上去的）一走就滑、原地 / 跳過去（腳不在地上）不算；滑行中跳不起來；被爆炸炸到消失（事件帶 peelGone）', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 60);
  const S = m.mechState;
  S.peels = [{ id: 'peel1', x: 90, y: Math.round(p.y) }];
  const r = m.applyPositionReport(p, { x: 100, y: p.y, facing: 1 });
  assert(r.ok && r.pickup && r.pickup.type === 'peel' && r.pickup.peel === 'peel1' && r.pickup.dir === 1 && !S.peels.length && p.slide === 150 && p.slideDir === 1, 'slip ' + J(r.pickup));
  const x0 = p.x;
  for (let i = 0; i < 120; i++) p.update(CONFIG.FIXED_DT, m.world);
  assert(Math.abs(p.x - x0 - 150) <= 1 && p.slide === 0 && p.waterFalls === 0, 'slid ' + Math.round(p.x - x0));
  // 滑進水坑：落水（扣 30%、回到最後站穩的地方）。從地面上（低樹枝底下）出發
  placeOn(m, p, 200, 560);
  const hp0 = p.hp;
  S.peels = [{ id: 'peel2', x: 230, y: Math.round(p.y) }];
  assert(m.applyPositionReport(p, { x: 240, y: p.y, facing: 1 }).pickup, 'stepped');
  for (let i = 0; i < 120; i++) p.update(CONFIG.FIXED_DT, m.world);
  assert(p.waterFalls === 1 && p.hp < hp0 && p.slide === 0 && p.x <= 300, 'slid into the pool ' + J([p.waterFalls, p.hp, p.x]));
  // 站在上面：原地（直直落下）不算，一走就滑（往走的方向）
  const m2 = make(1);
  const q = m2.players[0];
  placeOn(m2, q, 150, 560);   // 地面上（低樹枝底下）
  m2.mechState.peels = [{ id: 'peel1', x: 152, y: Math.round(q.y) }];
  assert(touchPeel(m2, q, q.x, q.y - 20, q.x, q.y) === null, 'landing straight down');
  assert(touchPeel(m2, q, q.x, q.y, q.x - 2, q.y) && q.slide === 150 && q.slideDir === -1, 'standing on it, then a step');
  // 滑行中跳不起來
  const y0 = q.y, xs = q.x;
  q.wantJump = true;
  for (let i = 0; i < 60; i++) q.update(CONFIG.FIXED_DT, m2.world);
  assert(Math.abs(q.y - y0) < 2 && Math.abs(xs - q.x) > 60, 'no jump while sliding ' + J([q.y, y0, q.x, xs]));
  placeOn(m2, q, 150);
  q.slide = 0;
  // 跳過去
  m2.mechState.peels = [{ id: 'peel2', x: 200, y: Math.round(q.y) }];
  assert(touchPeel(m2, q, q.x, q.y - 30, q.x + 80, q.y - 30) === null, 'jumped over');
  assert(touchPeel(m2, q, q.x, q.y, q.x + 80, q.y) && q.slide === 150, 'walked over');
  // 被炸掉
  const m3 = make(1);
  const peelX = 470;
  m3.mechState.peels = [{ id: 'peel9', x: peelX, y: 576 }];
  const hit = findShot(1, 'cannon', (s) => s.events.some(e => e.peelGone), (mm) => { mm.mechState.peels = [{ id: 'peel9', x: peelX, y: 576 }]; });
  assert(hit, 'some shot lands on the peel');
  const shot = fire(m3, m3.players[0], 'cannon', hit.angle, hit.power);
  assert(shot.events.some(e => J(e.peelGone) === J(['peel9'])) && !m3.mechState.peels.length, 'blown away');
  return { slid: Math.round(p.x - x0) };
}));

await test('滑行沒滑完不算站穩（settle 會滑完、滑進水坑照樣落水）；套用伺服器的狀態（applyState）就停下', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 200, 560);
  m.mechState.peels = [{ id: 'peel1', x: 230, y: Math.round(p.y) }];
  assert(m.applyPositionReport(p, { x: 240, y: p.y, facing: 1 }).pickup && p.slide > 0 && !m.isSettled(), 'sliding = not settled');
  m.settle(360);
  assert(p.slide === 0 && p.waterFalls === 1 && m.isSettled(), 'settle finishes the slide (into the pool) ' + J([p.slide, p.waterFalls, p.x]));
  const m2 = make(1);
  const q = m2.players[0];
  placeOn(m2, q, 60);
  q.slide = 120;
  q.slideDir = 1;
  q.applyState(q.toState());
  const x0 = q.x;
  for (let i = 0; i < 30; i++) q.update(CONFIG.FIXED_DT, m2.world);
  assert(q.slide === 0 && Math.abs(q.x - x0) < 0.01, 'applyState stops a slide');
}));

await test('猴王的接住：迴力鏢去程穿過他之後不接（這一趟已經打中了）；燃燒把他燒到 40% 以下也算生氣（範圍 150）', () => base(() => {
  const near = (mm) => placeOn(mm, mm.players[0], 400, 560);   // 迴力鏢射程有限：站近一點
  const pierced = findShot(2, 'boomerang', (s) => s.events.some(e => e.type === 'pierce' && e.target === MONKEY_ID), near);
  assert(pierced, 'some boomerang passes through him');
  const m = make(2);
  near(m);
  const shot = fire(m, m.players[0], 'boomerang', pierced.angle, pierced.power);
  const k = shot.events.findIndex(e => e.type === 'pierce' && e.target === MONKEY_ID);
  const sn = shot.events.findIndex(e => e.type === 'snatch');
  assert(sn < 0 || sn < k, 'not caught after hitting him ' + J(shot.events.map(e => e.type)));
  const m2 = make(2);
  const g = monkeyOf(m2);
  g.hp = Math.floor(g.maxHp * 0.4) + 1;
  g.burn = 20;
  g.burnSource = 'p1';
  m2.endTurn(g);
  assert(g.hp < g.maxHp * 0.4 && !m2.mechState.angry && catchRadius(m2.mechState, g) === 150, 'burnt below 40% ' + J([g.hp, g.maxHp]));
  return { pierced };
}, { WEAPONS: { boomerang: { ...CONFIG.WEAPONS.boomerang } } }));

await test('香蕉皮不丟在有人站的地方', () => base(() => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const m = make(4, { seed });
    for (let k = 0; k < 3; k++) withConfig(only('peel'), () => monkeyTurn(m));
    for (const q of m.mechState.peels) assert(!m.players.some(p => p.alive && Math.abs(p.x - q.x) <= p.hw && Math.abs(p.y - q.y) <= 4), 'peel under a player ' + J(q));
  }
}));

await test('AI 代打走路踩到香蕉皮：simulateWalk 的 pickups 帶 peel（第幾幀）、踩到就放開方向鍵、在 fall 幀裡滑完（滑進水坑也是）；客戶端照 walk 重播一樣；開火時停下（vx 歸零）', () => base(() => {
  for (const [x, peel] of [[150, 175], [200, 225], [60, 80]]) {
    const m = make(1);
    const p = m.players[0];
    placeOn(m, p, x, x === 150 ? 500 : 560);
    m.mechState.peels = [{ id: 'peelW', x: peel, y: Math.round(p.y) }];
    const before = JSON.parse(J(m.snapshot()));
    const w = m.simulateWalk(p, 1, 60);
    assert(p.slide === 0 && (p.onGround || !p.alive), 'slide finished ' + J([x, p.slide, p.onGround]));
    // 客戶端：照 walkScript 一樣，按著方向走 frames 幀、放開再 fall 幀；撿到的那一幀之後套 pickup（滑出去）
    const c = make(1);
    c.applySnapshot(before);
    const e = c.players[0];
    const total = w.frames + w.fall;
    let k = 0;
    e.moveDir = 1;
    for (let f = 1; f <= total; f++) {
      if (f > w.frames) e.moveDir = 0;
      c.step(CONFIG.FIXED_DT);
      while (k < w.pickups.length && w.pickups[k].f <= f) { applyPeelPickup(c, e, w.pickups[k], true); k++; }
    }
    e.moveDir = 0;
    assert(Math.abs(e.x - p.x) < 1e-6 && Math.abs(e.y - p.y) < 1e-6 && e.waterFalls === p.waterFalls && e.hp === p.hp, 'client replay ' + J([x, e.x, p.x, e.waterFalls, p.waterFalls]));
    for (let i = 0; i < 60; i++) c.step(CONFIG.FIXED_DT);   // 客戶端的瞄準等待（aiAim）：不會再動
    assert(Math.abs(e.x - p.x) < 0.5 && e.waterFalls === p.waterFalls, 'still during the aim pause');
  }
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 150);
  m.mechState.peels = [{ id: 'peel1', x: 175, y: Math.round(p.y) }];
  const w = m.simulateWalk(p, 1, 40);
  const pk = w.pickups.find(x => x.type === 'peel');
  assert(pk && pk.f > 0 && pk.dir === 1 && !m.mechState.peels.length, 'pickup ' + J(w.pickups));
  assert(p.x > 175 + 40, 'slid during the walk ' + Math.round(p.x));
  return { f: pk.f, x: Math.round(p.x) };
}));

await test('還在滑的時候開火：停下來（vx、slide 歸零）', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 150);
  p.vx = 300;   // 還在滑的時候開火：停下來（客戶端重播擺射手時一律從站著不動開始）
  p.slide = 100;
  const shot = m.resolveShot(p, 'sniper', 170, 50);
  assert(Math.abs(p.x - shot.actor.x) < 1 && p.slide === 0, 'fire resets vx ' + [p.x, shot.actor.x]);
}));

// ---------------- 快照 ----------------

await test('快照 / 重連：樹枝、手上的砲彈、香蕉皮、生氣、流水號照快照；只帶一部分欄位不動', () => base(() => {
  const m = make(2);
  Object.assign(m.mechState, { perch: 2, held: [{ w: 'cannon', by: 'p2' }], peels: [{ id: 'peel4', x: 200, y: 576 }], seq: 4, angry: true });
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(snap.monkey) === J({ perch: 2, angry: true, seq: 4, held: [{ w: 'cannon', by: 'p2' }], peels: [{ id: 'peel4', x: 200, y: 576 }] }), 'snapshot ' + J(snap.monkey));
  const c = make(2);
  c.applySnapshot(snap);
  const S = c.mechState;
  assert(S.perch === 2 && S.angry && S.seq === 4 && J(S.held) === J(snap.monkey.held) && J(S.peels) === J(snap.monkey.peels), 'restored');
  c.mechanic.restore(c, { items: [] });
  assert(S.perch === 2 && S.peels.length === 1, 'partial untouched');
}));

// ---------------- 裁判 ----------------

await test('裁判：全員 AI 代打打幾輪（2 人）：猴王每回合最後都盪樹枝、接住過砲彈也丟回去過、椰子與香蕉皮都出現；沒有丟錯', () => base(() => {
  const seen = new Set();
  let snatches = 0;
  for (const seed of [1, 2, 3]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'forestMonkey', players, seed, stage: 3 });
    for (const p of m.players) { p.hp = p.maxHp = 4000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
    ref.start();
    for (const p of players) ref.setConnected(p.id, false);
    for (let k = 0; k < 300 && ref.phase !== 'over'; k++) io.advance(500);
    const turns = io.log.filter(x => x.t === 'aiTurn' && x.actorId === MONKEY_ID);
    assert(turns.length >= 5, `seed ${seed}: turns ${turns.length}`);
    for (const t of turns) {
      const st = t.boss.steps;
      assert(st[st.length - 1].action === 'swing' && st.every(s => s.cast > 0 && (s.shot || s.still)), 'ends with a swing ' + J(st.map(s => s.action)));
      st.forEach(s => seen.add(s.action));
    }
    snatches += io.log.filter(x => x.t === 'aiTurn' && x.shot).reduce((n, x) => n + x.shot.events.filter(e => e.type === 'snatch').length, 0);
    ref.stop();
  }
  assert(seen.has('coconut') && seen.has('peel') && snatches > 0 && seen.has('throw'), 'seen ' + [...seen] + ' snatches ' + snatches);
  return { seen: [...seen], snatches };
}));

// ---------------- 真的 GameView ----------------
const fakeCtx2d = () => new Proxy({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const fakeCanvas = () => ({ width: 1024, height: 768, style: {}, getContext: fakeCtx2d, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }) });
globalThis.window ??= { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document ??= { addEventListener() {}, hidden: false, createElement: fakeCanvas };
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { GameView } = await import('../client/game-view.js');
function mkView(myId = 'p1') {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = myId;
  view.transport = { send() {} };
  return view;
}

await test('真的 GameView：猴王從開場播幾輪（全員 AI 代打；每幀 update + render）：沒有腳本錯誤；猴王的位置、血量、手上的砲彈、香蕉皮、玩家跟伺服器一樣；菁英關橫幅；HUD', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'forestMonkey', players, seed: 2, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 5000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  const view = mkView();
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  assert(view.mapView.type === 'monkey' && view.banner && view.banner.text === '菁英關：頑皮猴王', 'elite banner: ' + J(view.banner && view.banner.text));
  for (const p of players) ref.setConnected(p.id, false);
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Set();
  try {
    for (let k = 0; k < 400 && ref.phase !== 'over'; k++) {
      io.advance(250);
      for (const t of io.log.filter(x => x.t === 'aiTurn' && x.actorId === MONKEY_ID)) t.boss.steps.forEach(st => seen.add(st.action));
      feed();
      for (let f = 0; f < 15; f++) { view.update(CONFIG.FIXED_DT); view.render(); }
      if (seen.has('throw') && seen.has('peel') && seen.has('coconut') && k > 80) break;
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
    view.render();
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(seen.has('swing') && seen.has('throw'), 'played: ' + [...seen]);
  const S = view.match.mechState, T = m.mechState;
  assert(J(S.held) === J(T.held) && J(S.peels) === J(T.peels) && S.perch === T.perch && S.angry === T.angry, 'mech state synced ' + J([S.held, T.held, S.peels, T.peels, S.perch, T.perch]));
  const g = (mm) => { const e = monkeyOf(mm); return [e.x, e.y, e.hp, e.alive]; };
  assert(J(g(view.match)) === J(g(m)), 'monkey synced ' + J([g(view.match), g(m)]));
  assert(view.match.players.every(p => p.hp === m.byId(p.id).hp && Math.abs(p.x - m.byId(p.id).x) < 0.01), 'players synced');
  const hud = view.mapView.hud(view.mapCtx, ['x', '#fff']);
  if (monkeyOf(m).alive) assert(/^頑皮猴王 \d+ \/ \d+$/.test(hud[1][0]), 'hud ' + J(hud));
  return { moves: [...seen] };
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
