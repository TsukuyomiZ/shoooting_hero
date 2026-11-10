// node test/ranger.js
// 2026-11-02：菁英關「大樹遊俠」（森林，莫利亞森林的菁英池）。
// 關卡（菁英池、三根樹枝、遊俠 fixed、血量照一般敵人放大、陷阱不擋過關）、林間穿梭（每回合換樹枝、被打過就跳到離他最遠的那根）、
// 貫穿箭（一定射到標記的人、穿過地形、同一條線上照順序每人減半、最多 maxPierce 人、傷害照開場人數）、
// 箭雨（被困住的優先、範圍約三人寬、一人只中一支、流血 4 層）、藤蔓陷阱（一次 2 個、上限 8、放在地面上離人遠一點、玩家打 2 下破、敵人打不到）、
// 踩到陷阱（位置回報 / pickup、跳過去不算、被困住 = 走不動跳不起來、還能開火、扣血在 hazard、AI 代打不走）、
// 連打掙脫（左右交替 10 下、同一邊不算、體力每秒 40 流光就不行、紀錄 struggle / action.ignored）、快照 / 重連、
// 客戶端重播一致、裁判全員 AI 代打、真的 GameView（全程沒有腳本錯誤、狀態跟伺服器一樣、HUD、自己的畫面體力流失、掙脫）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { planWalk } from '../shared/ai/ai-move.js';
import {
  RANGER_ID, bowPoint, arrowLine, spawnTrap, liveTraps, rangerDamage, perchRange, rainXs,
} from '../shared/maps/ranger.js';
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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

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
const make = (n = 1, opts = {}) => new Match({ levelId: 'forestRanger', players: mkPlayers(n), seed: 1, stage: 3, ...opts });
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
const RANGER = {
  hp: 200, weights: { pierce: 50, rain: 50 }, maxPierce: 4, pierceFalloff: 0.5, rainWidth: 100,
  trap: { perCast: 2, max: 8, hp: 2, need: 10, drain: 40, grace: 0.3, hw: 16, h: 8, gap: 60 },
  perchPad: { left: 18, right: 44 }, cast: { hop: 0.9, pierce: 1.2, rain: 1.0, trap: 0.9 },
};
const BASE = {
  ENEMY: { hp: 45, damageMult: 0.7, lateFromStage: 6, damageMultLate: 1 },
  RUN: { stageCount: 10, bossStages: [5, 10], eliteStages: [3, 8], enemyHpPerStage: 0.15 },
  RANGER,
  PLAYER: { hp: 150, stamina: 200 }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180, gravity: 600 },
    rangerArrow: { ...CONFIG.WEAPONS.rangerArrow, damage: 12, pierceFalloff: 0.5, maxPierce: 4, knockback: 0, speed: 1800, hitRadius: 8 },
    rangerRain: { ...CONFIG.WEAPONS.rangerRain, damage: 8, bleed: 4, knockback: 0, speed: 1300, hitRadius: 5 },
    rangerTrap: { ...CONFIG.WEAPONS.rangerTrap, damage: 5, knockback: 0 },
  },
};
const base = (fn, extra = {}) => {
  const patch = { ...BASE };
  for (const [k, v] of Object.entries(extra)) patch[k] = { ...(BASE[k] || {}), ...v };
  return withConfig(patch, fn);
};
const only = (action) => ({ RANGER: { ...RANGER, weights: { pierce: 0, rain: 0, trap: 0, [action]: 1 } } });
// 把角色放到 (x, y) 正下方站好
function placeOn(m, e, x, y = 500) {
  e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.onGround = false;
  for (let i = 0; i < 400 && !e.onGround; i++) e.update(CONFIG.FIXED_DT, m.world);
  e.safeX = e.x; e.safeY = e.y;
}
const groundAt = (m, x) => { for (let y = 0; y < CONFIG.WATER_LEVEL; y++) if (m.terrain.isSolid(x, y)) return y; return null; };
// 讓遊俠照預定的招式出一回合（不經過裁判），客戶端從出招前的快照照事件一招一招重播、套結果，跟伺服器一樣
function rangerTurn(m, plan) {
  if (plan) m.mechState.next = plan;
  const before = JSON.parse(J(m.snapshot()));
  const g = m.byId(RANGER_ID);
  const r = m.mechanic.aiTurn(m, g);
  const c = make(m.players.length, { seed: m.seed });
  for (const p of c.players) p.fixed = m.byId(p.id).fixed;
  c.applySnapshot(before);
  for (const st of r.steps) {
    if (st.action === 'trap') for (const spec of st.spawns) if (!c.byId(spec.id)) spawnTrap(c, spec);
    if (st.shot) {
      const shot = JSON.parse(J(st.shot));
      replayChecked(c, shot, st.action);
      c.applyEntities(shot.results);
    } else {
      c.applyEntities(JSON.parse(J(st.still.results)));
    }
  }
  const label = r.steps.map(st => st.action).join('+');
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${label}: entities differ`);
  const dmgs = r.steps.flatMap(st => (st.shot ? st.shot.events.flatMap(ev => ev.damages || []) : []));
  return { steps: r.steps, next: r.next, dmgs, main: r.steps[0], hop: r.steps.find(st => st.action === 'hop') };
}
const stageInfo = (difficulty = 'normal') => ({ stage: 3, stageCount: 10, isBoss: false, type: 'elite', difficulty, levelId: 'forestRanger', levelName: '大樹遊俠', cards: {} });

// ---------------- 關卡、遊俠 ----------------

await test('關卡：菁英池（不在小關 / Boss 池）、地圖機制 ranger、三根樹枝；遊俠站在第二根樹枝上（fixed，不受重力）、血量 200 × 一般敵人的倍率；開場就抽好第一招', () => base(() => {
  const L = LEVELS.forestRanger;
  assert(levelsInPool('elite').includes('forestRanger') && !levelsInPool('normal').includes('forestRanger') && L.name === '大樹遊俠' && L.theme === 'forest', 'pool');
  assert(L.mechanic.type === 'ranger' && L.mechanic.perches.length === 3 && J(L.platforms.map(p => p[0][1])) === J(L.mechanic.perches.map(p => p.y)), 'perches are the branch platforms');
  const out = {};
  for (const n of [1, 2, 4]) {
    const m = make(n);
    const g = m.byId(RANGER_ID);
    const scale = (1 + 0.5 * (n - 1)) * (1 + 0.15 * 2);
    assert(g.fixed && g.y === L.mechanic.perches[1].y && g.hp === Math.round(200 * scale), `n=${n}: ${g.hp} vs ${Math.round(200 * scale)}`);
    const r = perchRange(L.mechanic.perches[1]);
    assert(g.x >= r.x0 && g.x <= r.x1, 'stands on the branch');
    for (let i = 0; i < 60; i++) m.step();
    assert(g.y === L.mechanic.perches[1].y, 'does not fall');
    assert(m.mechState.next && ['pierce', 'rain', 'trap'].includes(m.mechState.next.action), 'opening plan');
    out[n] = g.hp;
  }
  return out;
}));

await test('林間穿梭：每回合出完招之後換到另一根樹枝（站在樹枝範圍裡）；上一次打到她的人還活著 → 跳到離他最遠的那根；客戶端重播一樣', () => base(() => {
  const m = make(2);
  const g = m.byId(RANGER_ID);
  const P = LEVELS.forestRanger.mechanic.perches;
  let perch = m.mechState.perch;
  for (let k = 0; k < 6; k++) {
    const { steps, hop } = rangerTurn(m, { action: 'rain' });
    // 2 人（不會插話）：招式 → 順便放陷阱（場上還放得下）→ 換樹枝
    assert(steps[steps.length - 1] === hop && steps[0].action === 'rain' && steps.slice(1, -1).every(st => st.action === 'trap'), 'attack first, then hop ' + J(steps.map(st => st.action)));
    assert(hop.action === 'hop' && hop.from === perch && hop.to !== perch && m.mechState.perch === hop.to, 'hops ' + J(hop));
    const r = perchRange(P[hop.to]);
    assert(g.y === P[hop.to].y && g.x >= r.x0 && g.x <= r.x1 && hop.x === g.x && hop.cast > 0, 'on the branch');
    perch = hop.to;
  }
  // 被 p1 打過：跳到離 p1 最遠的那根（p1 在最左邊 → 最右邊的那根，除非已經站在那裡）
  placeOn(m, m.players[0], 40, 540);
  for (const want of [2, 1]) {
    if (m.mechState.perch === want) { m.mechState.perch = 0; g.x = (P[0].x0 + P[0].x1) / 2; g.y = P[0].y; }
    m.mechanic.hurt(m, g, 10, m.players[0]);
    assert(m.mechState.lastHitBy === 'p1', 'remembers who hit her');
    const { hop } = rangerTurn(m, { action: 'rain' });
    const far = [0, 1, 2].filter(i => i !== hop.from).sort((a, b) => (P[b].x0 + P[b].x1) - (P[a].x0 + P[a].x1))[0];
    assert(hop.to === far && hop.away === 'p1' && m.mechState.lastHitBy === null, 'jumps away from p1 ' + J(hop));
  }
}));

await test('貫穿箭：同一條線上的四個人照箭飛過的順序都中，傷害 12 × 開場人數、每多穿一人減半（× 0.7 敵人倍率）；標記的人在第三個也一定中；maxPierce 2 → 只打到前兩個', () => base(() => {
  const shoot = (maxPierce) => base(() => {
    const m = make(4);
    const g = m.byId(RANGER_ID);
    const plan = { action: 'pierce', targetId: 'p3' };
    // 她從現在站的地方射（出完招才換樹枝）：四個人排在她弓的延長線上（固定在空中，不受重力）
    g.facing = -1;
    const ux = -0.8, uy = 0.6;
    const bow = bowPoint(g);
    m.players.forEach((p, i) => {
      const d = 90 + i * 70;
      p.fixed = true;
      p.x = bow.x + ux * d;
      p.y = bow.y + uy * d + p.h / 2;
      p.hp = p.maxHp = 1000;
    });
    return rangerTurn(m, plan);
  }, { WEAPONS: { ...BASE.WEAPONS, rangerArrow: { ...BASE.WEAPONS.rangerArrow, maxPierce } }, RANGER: { ...RANGER, maxPierce } });
  const four = shoot(4);
  const ids = four.main.targetIds;
  assert(four.main.action === 'pierce' && four.main.targetId === 'p3' && J(ids) === J(['p1', 'p2', 'p3', 'p4']), 'in order ' + J(four.main));
  const want = [48, 24, 12, 6].map(d => Math.round(d * 0.7));   // 傷害四捨五入成整數
  four.dmgs.forEach((d, i) => assert(d.dmg === want[i], `hit ${i}: ${d.dmg} vs ${want[i]}`));
  assert(four.main.dmg === 48 && four.dmgs.length === 4, 'base damage scales with the head count');
  const two = shoot(2);
  assert(J(two.main.targetIds) === J(['p1', 'p2']) && two.dmgs.length === 2, 'stops at maxPierce ' + J(two.main.targetIds));
  return { dmg: four.dmgs.map(d => Math.round(d.dmg * 10) / 10) };
}));

await test('貫穿箭一定射得到標記的人（穿過地形：他躲在地面底下的坑裡也一樣）；標記的人倒下了 → 改射其他活著的人', () => base(() => {
  const m = make(2);
  const [p1, p2] = m.players;
  placeOn(m, p1, 120, 540);
  placeOn(m, p2, 220, 540);
  m.terrain.carve(120, 560, 30);   // 挖個坑（他掉進坑裡、上面是地面的邊）
  placeOn(m, p1, 120, 560);
  const { main } = rangerTurn(m, { action: 'pierce', targetId: 'p1' });
  assert(main.targetIds.includes('p1'), 'hit the marked one ' + J(main.targetIds));
  p1.die('hit');
  const { main: again } = rangerTurn(m, { action: 'pierce', targetId: 'p1' });
  assert(again.targetId === 'p2' && again.targetIds.includes('p2'), 'falls back to someone alive ' + J(again));
}));

await test('箭雨：以目標為中心左右合計 100 px 的箭從天上落下，範圍裡的人一人只中一支（8 × 開場人數 × 0.7、流血 4 層），範圍外的不中；有人被困住就打他', () => base(() => {
  const m = make(3);
  const [p1, p2, p3] = m.players;
  for (const p of m.players) p.hp = p.maxHp = 1000;
  placeOn(m, p1, 300, 540);
  placeOn(m, p2, 330, 540);
  placeOn(m, p3, 520, 540);
  m.rng.pick = (arr) => arr.find(e => e.id === 'p1') || arr[0];
  const { main, dmgs } = rangerTurn(m, { action: 'rain' });
  const xs = rainXs(p1.x);
  assert(main.action === 'rain' && main.targetId === 'p1' && near(xs[xs.length - 1] - xs[0], 100), 'centered on p1 ' + J(main));
  const by = Object.fromEntries(dmgs.map(d => [d.id, d]));
  assert(by.p1 && by.p2 && !by.p3 && dmgs.filter(d => d.id === 'p1').length === 1 && dmgs.filter(d => d.id === 'p2').length === 1, 'who got hit ' + J(dmgs));
  assert(by.p1.dmg === Math.round(8 * 3 * 0.7) && by.p1.bleed === 4 && p1.bleed === 4 && p2.bleed === 4 && p3.bleed === 0, 'damage + bleed ' + J(by.p1));
  // p3 被困住 → 箭雨找他
  m.mechState.trapped.p3 = { count: 0, last: 0, at: 0, st: 200 };
  m.rng.pick = (arr) => arr[arr.length - 1];
  const { main: m2 } = rangerTurn(m, { action: 'rain' });
  assert(m2.targetId === 'p3' && m2.held === true, 'prefers the trapped one ' + J(m2));
}));

await test('藤蔓陷阱（2026-11-09 改成插話招）：插話放 2 個在地面上（離其他陷阱、玩家至少 gap，不換樹枝、不改預定的下一招）；場上 8 個就不放、不插話；她自己的回合只抽貫穿箭 / 箭雨；陷阱不擋過關、不會輪到', () => base(() => {
  const m = make(4);
  for (const p of m.players) placeOn(m, p, p.x, 540);
  const g = m.byId(RANGER_ID);
  const out = [];
  for (let k = 0; k < 4; k++) {
    const perch = m.mechState.perch, next = J(m.mechState.next);
    const it = m.mechanic.interject(m, g, 'p2');
    const main = it.steps[0];
    assert(it.steps.length === 1 && main.action === 'trap' && main.spawns.length === 2, 'two at a time ' + J(main));
    assert(m.mechState.perch === perch && J(it.next) === next, 'no hop, same plan');
    for (const s of main.spawns) {
      assert(groundAt(m, s.x) === s.y && s.hp === 2, 'on the ground ' + J(s));
      assert(m.players.every(p => Math.abs(p.x - s.x) >= 60), 'away from players');
      out.push(s.x);
    }
  }
  const traps = liveTraps(m);
  assert(traps.length === 8, 'eight ' + traps.length);
  for (const a of traps) for (const b of traps) if (a !== b) assert(Math.abs(a.x - b.x) >= 60, 'apart');
  assert(m.mechanic.interject(m, g, 'p2') === null, 'full: nothing to do, no interjection');
  for (let k = 0; k < 20; k++) {   // 她自己的回合只抽貫穿箭 / 箭雨
    m.mechanic.ready(m);
    assert(['pierce', 'rain'].includes(m.mechState.next.action), 'own turn: pierce or rain');
  }
  const { steps } = rangerTurn(m, { action: 'rain' });
  assert(!steps.some(st => st.action === 'trap'), '4 alive: no trap on her own turn ' + J(steps.map(st => st.action)));
  m.byId(RANGER_ID).die('hit');
  assert(m.result() === 'win', 'traps do not block the win: ' + m.result());
  return { xs: out };
}));

await test('陷阱被打：玩家的砲彈不管直擊或波及都只扣 1，2 下破（不算擊殺）；遊俠自己的箭雨穿過去打不到', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 60, 540);
  const y = groundAt(m, 400);
  const q = spawnTrap(m, { id: 'vine1', x: 400, y, hp: 2 });
  const W = CONFIG.WEAPONS.cannon;
  const d1 = m.applyExplosion(400, y - 2, W, p, q, {});
  assert(q.alive && q.hp === 1 && d1.find(d => d.id === 'vine1').dmg === 1, 'one hit: ' + J(d1));
  const d2 = m.applyExplosion(420, y - 2, W, p, null, {});   // 波及
  assert(!q.alive && d2.find(d => d.id === 'vine1').dmg === 1 && !p.kills, 'second hit breaks it');
  const q2 = spawnTrap(m, { id: 'vine2', x: 300, y: groundAt(m, 300), hp: 2 });
  const g = m.byId(RANGER_ID);
  m.applyExplosion(300, q2.y - 2, CONFIG.WEAPONS.rangerRain, g, q2, {});
  assert(q2.alive && q2.hp === 2, 'her own attacks do not touch it');
}));

await test('踩到陷阱：走過去（位置回報）→ pickup、陷阱消失、被困住（走不動、跳不起來、體力每秒 40 的流失標記），扣血等 hazardStep；跳過去不算；AI 代打的不走；還能開火', () => base(() => {
  const m = make(2);
  const p = m.players[0];
  placeOn(m, p, 250, 540);
  const y = groundAt(m, 330);
  spawnTrap(m, { id: 'vine1', x: 330, y, hp: 2 });
  // 跳過去：腳離地面很高的那一段不算
  const air = m.applyPositionReport(p, { x: 400, y: p.y - 60, facing: 1, stamina: 190 });
  assert(air.ok && !air.pickup && !m.mechState.trapped.p1, 'jumping over does not trigger');
  placeOn(m, p, 250, 540);
  const r = m.applyPositionReport(p, { x: 360, y: groundAt(m, 360), facing: 1, stamina: 180 });
  assert(r.ok && r.pickup && r.pickup.type === 'vine' && r.pickup.trap === 'vine1' && r.pickup.id === 'p1', 'pickup ' + J(r.pickup));
  assert(!m.byId('vine1').alive && m.byId('vine1').deathCause === 'trigger' && m.mechState.trapped.p1 && p.held && p.staminaDrain === 40, 'trapped');
  assert(p.hp === p.maxHp && J(m.mechState.pending) === J(['p1']), 'no damage yet (hazardStep)');
  const step = m.hazardStep(100);
  assert(step && step.damages.length === 1 && step.damages[0].dmg === 7 && J(step.trapIds) === J(['p1']) && p.hp === p.maxHp - 7, 'trap damage ' + J(step));
  // 走不動、跳不起來
  const x0 = p.x;
  p.moveDir = 1;
  p.wantJump = true;
  for (let i = 0; i < 30; i++) p.update(CONFIG.FIXED_DT, m.world);
  assert(p.x === x0 && p.onGround && p.stamina === 180, 'cannot walk or jump');
  // AI 代打：不走（照樣開火）
  m.rng.chance = () => true;
  assert(planWalk(m, p) === null, 'AI takeover does not walk');
  const shot = m.resolveShot(p, 'cannon', 30, 60);
  assert(shot && shot.events.length > 0, 'can still fire');
}));

await test('踩到陷阱要自己走進去：站著不動 / 原地開火的回報不算；被擊退停在陷阱上、之後走開也不算；從旁邊走進去才算', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  const y = groundAt(m, 300);
  spawnTrap(m, { id: 'vine1', x: 300, y, hp: 2 });
  placeOn(m, p, 300, 540);   // 被擊退停在陷阱上
  const still = m.applyPositionReport(p, { x: p.x, y: p.y, facing: 1, stamina: 190 });
  assert(still.ok && !still.pickup && !m.mechState.trapped.p1, 'standing still does not trigger');
  const away = m.applyPositionReport(p, { x: p.x + 60, y: groundAt(m, p.x + 60), facing: 1, stamina: 180 });
  assert(away.ok && !away.pickup && !p.held, 'walking off a trap you stood on does not trigger');
  const back = m.applyPositionReport(p, { x: 300, y: groundAt(m, 300), facing: -1, stamina: 170 });
  assert(back.pickup && back.pickup.trap === 'vine1' && p.held, 'walking into it does');
}));

await test('陷阱有重力：底下的地被炸掉就跟著落下去（還踩得到）；客戶端照一樣的物理落', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 60, 540);
  const q = spawnTrap(m, { id: 'vine1', x: 400, y: groundAt(m, 400), hp: 2 });
  const y0 = q.y;
  m.terrain.carve(400, y0 + 10, 30);
  for (let i = 0; i < 300; i++) m.step();
  assert(q.alive && q.y > y0 + 10 && Math.abs(q.y - groundAt(m, 400)) <= 8, 'fell with the ground (rests on the crater slope, within the 8 px step-on tolerance) ' + J([y0, q.y, groundAt(m, 400)]));
}));

await test('客戶端對齊：玩家回合開始的 hazard 帶伺服器的被困名單（held），本地先困住、伺服器沒收到的放開；伺服器有的補上', () => base(() => {
  const m = make(2);
  const S = m.mechState;
  S.trapped.p1 = { count: 2, last: 1, at: null, st: null };
  m.mechanic.cascade(m);
  assert(m.byId('p1').held, 'locally trapped');
  const startInfo = (() => {
    const srv = make(2);
    srv.mechState.trapped.p2 = { count: 0, last: 0, at: 0, st: 200 };
    return srv.hazardStart(srv.byId('p2'), 1000);
  })();
  assert(J(startInfo.held) === J(['p2']) && startInfo.trapped === 'p2', 'server tells who is trapped ' + J(startInfo));
  // 客戶端的地圖畫面照它對齊
  return import('../client/map-views/ranger.js').then(({ ranger: view }) => {
    const ctx = { match: m, state: view.create(m), fx: { particles() {}, particle() {}, sound() {}, banner() {}, float() {}, shake() {} }, clock: () => 0, rangeHints: true };
    view.hazard(ctx, { start: startInfo, recvAt: 0 });
    assert(!S.trapped.p1 && S.trapped.p2 && !m.byId('p1').held && m.byId('p2').held, 'aligned ' + J(Object.keys(S.trapped)));
  });
}));

// ---------------- 裁判：踩到、扣血、連打掙脫 ----------------

function rig(n = 2, setup = () => {}) {
  const players = mkPlayers(n);
  const m = new Match({ levelId: 'forestRanger', players, seed: 2, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 1000; }
  setup(m);
  m.mechState.next = { action: 'rain' };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  return { m, io, ref };
}
const myTurn = (io, id) => io.log.filter(x => x.t === 'turn' && x.actorId === id).at(-1);

await test('裁判：自己的回合走進陷阱 → pickup（紀錄）、下一個 hazard 扣血（紀錄 hazard、廣播）；連打：左右交替才算（同一邊 sameDir、方向亂送 badDir、沒被困 notTrapped 記 action.ignored），第 10 下掙脫（紀錄 struggle、廣播 freed）', () => base(() => {
  const { m, io, ref } = rig(2, (m) => {
    placeOn(m, m.players[0], 250, 540);
    placeOn(m, m.players[1], 120, 540);
    spawnTrap(m, { id: 'vine1', x: 330, y: groundAt(m, 330), hp: 2 });
  });
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  assert(myTurn(io, 'p1') && ref.currentId === 'p1', 'p1 turn');
  ref.handle('p1', { t: 'struggle', dir: 1 });
  assert(io.records.at(-1).ev === 'action.ignored' && io.records.at(-1).reason === 'notTrapped', 'not trapped');
  const p = m.players[0];
  ref.handle('p1', { t: 'move', x: 360, y: groundAt(m, 360), facing: 1, stamina: 190 });
  const pick = io.records.find(r => r.ev === 'pickup');
  assert(pick && pick.type === 'vine' && pick.trap === 'vine1' && io.log.some(x => x.t === 'pickup' && x.type === 'vine'), 'pickup logged + broadcast');
  io.advance(60);
  const hz = io.records.find(r => r.ev === 'hazard');
  assert(hz && hz.changes && io.log.some(x => x.t === 'hazard' && x.damages.length === 1) && near(p.hp, 1000 - 7), 'trap damage via hazard ' + J(hz));
  ref.handle('p1', { t: 'struggle', dir: 0 });
  ref.handle('p1', { t: 'struggle', dir: 'x' });
  assert(io.records.filter(r => r.ev === 'action.ignored' && r.reason === 'badDir').length === 2, 'bad dir');
  for (let k = 0; k < 9; k++) {
    ref.handle('p1', { t: 'struggle', dir: k % 2 ? -1 : 1 });
    if (k === 3) { ref.handle('p1', { t: 'struggle', dir: -1 }); assert(io.records.at(-1).reason === 'sameDir', 'same side twice'); }
  }
  const st = io.records.filter(r => r.ev === 'struggle');
  assert(st.length === 9 && st.at(-1).count === 9 && p.held, 'nine so far ' + J(st.map(r => r.count)));
  ref.handle('p1', { t: 'struggle', dir: -1 });
  const last = io.records.at(-1);
  assert(last.ev === 'struggle' && last.count === 10 && last.freed === true && !p.held && !m.mechState.trapped.p1 && p.staminaDrain === 0, 'freed ' + J(last));
  assert(io.log.some(x => x.t === 'struggle' && x.freed === true && x.id === 'p1'), 'broadcast freed');
  ref.handle('p1', { t: 'struggle', dir: -1 });
  assert(io.records.at(-1).reason === 'notTrapped', 'done');
  ref.stop();
}));

await test('裁判：被困住的人自己的回合一開始連打數歸零、體力從回滿開始每秒流失 40（多給 0.3 秒）：5.3 秒內還能按、之後 noStamina（下一回合再來）', () => base(() => {
  const { m, io, ref } = rig(2, (m) => {
    placeOn(m, m.players[0], 250, 540);
    m.mechState.trapped.p1 = { count: 7, last: 1, at: 0, st: 0 };
    m.mechanic.cascade(m);
  });
  ref.start();
  assert(m.players[0].held, 'held from the start');
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const turn = myTurn(io, 'p1');
  assert(turn && turn.hazard && turn.hazard.kind === 'ranger' && turn.hazard.trapped === 'p1', 'turn tells the client ' + J(turn && turn.hazard));
  assert(m.mechState.trapped.p1.count === 0 && m.mechState.trapped.p1.st === 200, 'reset at turn start');
  io.advance(2000);
  ref.handle('p1', { t: 'struggle', dir: 1 });
  const a = io.records.at(-1);
  assert(a.ev === 'struggle' && a.count === 1 && near(a.stamina, 200 - 40 * 1.7, 0.6), 'stamina by the clock ' + J(a));
  io.advance(1000);   // 3 s：伺服器上的體力跟著流失（hazardStep），快照帶得到
  assert(near(m.players[0].stamina, 200 - 40 * 2.7, 1.5), 'server stamina drains every tick ' + m.players[0].stamina);
  io.advance(2500);   // 5.5 s
  const spent = io.log.find(x => x.t === 'hazard' && Array.isArray(x.spent) && x.spent.includes('p1'));
  assert(spent && io.records.some(r => r.ev === 'hazard' && Array.isArray(r.spent)), 'tells the client when it runs out');
  ref.handle('p1', { t: 'struggle', dir: -1 });
  assert(io.records.at(-1).reason === 'noStamina' && m.players[0].stamina === 0 && m.players[0].held, 'out of stamina');
  const told = io.log.filter(x => x.t === 'struggle').at(-1);
  assert(told && told.freed === false && told.stamina === 0 && told.count === 1, 'rejected press is broadcast with the server stamina ' + J(told));
  ref.stop();
}));

// ---------------- 快照、整場 ----------------

await test('快照：預定的下一招、站哪根樹枝、被困住的人（連打數）、放過的陷阱（破掉的照角色狀態）；客戶端套上去建出一樣的陷阱、一樣困住（held）', () => base(() => {
  const m = make(2);
  for (const p of m.players) placeOn(m, p, p.x, 540);
  rangerTurn(m, { action: 'trap' });
  rangerTurn(m, { action: 'trap' });
  liveTraps(m)[0].die('hit');
  m.mechState.trapped.p2 = { count: 3, last: -1, at: 5, st: 120 };
  m.mechanic.cascade(m);
  const snap = JSON.parse(J(m.snapshot()));
  assert(snap.rangerNext && J(snap.rangerNext) === J(m.mechState.next) && snap.ranger.perch === m.mechState.perch && snap.ranger.spawned.length === 4, 'snapshot ' + J(snap.ranger));
  assert(J(snap.ranger.trapped) === J({ p2: { count: 3, last: -1 } }), 'trapped without server timing');
  const c = make(2);
  c.applySnapshot(snap);
  const traps = c.entities.filter(e => e.kind === 'vineTrap');
  assert(traps.length === 4 && traps.filter(e => e.alive).length === 3, 'traps rebuilt ' + traps.length);
  assert(c.byId('p2').held && !c.byId('p1').held && c.mechState.trapped.p2.count === 3 && J(c.mechState.next) === J(m.mechState.next), 'held + plan');
  c.mechanic.restore(c, { items: [] });
  assert(c.byId('p2').held && c.mechState.trapped.p2.count === 3, 'a partial snapshot leaves it alone');
}));

await test('裁判：全員 AI 代打打幾輪（2 人）；換樹枝 + 三招都出現、每回合 招式 →（順便放陷阱）→ hop；紀錄 ai.turn 帶招式、next、被標記的人；開場的第一招記在 battle.start；沒有丟錯', () => base(() => {
  const seen = new Set();
  const out = {};
  for (const seed of [1, 2, 3, 4]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'forestRanger', players, seed, stage: 3 });
    for (const p of m.players) { p.hp = p.maxHp = 4000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
    const opening = m.mechState.next.action;
    ref.start();
    assert(io.records.find(r => r.ev === 'battle.start').next === opening, 'battle.start logs the opening plan');
    for (const p of players) ref.setConnected(p.id, false);
    for (let k = 0; k < 400 && ref.phase !== 'over'; k++) io.advance(500);
    const turns = io.log.filter(x => x.t === 'aiTurn' && x.actorId === RANGER_ID);
    assert(turns.length >= 6, `seed ${seed}: turns ${turns.length}`);
    for (const t of turns) {
      const st = t.boss.steps;
      assert(['pierce', 'rain'].includes(st[0].action) && st[st.length - 1].action === 'hop' && st.slice(1, -1).every(s => s.action === 'trap')
        && st.length <= 3 && st.every(s => s.cast > 0 && (s.shot || s.still)), 'move + (trap) + hop ' + J(st.map(s => s.action)));
      for (const s of st) seen.add(s.action);
    }
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.actor === RANGER_ID);
    assert(recs.length === turns.length && recs.every((r, i) => r.boss[0].action === turns[i].boss.steps[0].action && r.next === turns[i].boss.next.action), 'logged');
    assert(recs.filter(r => r.next === 'pierce').every(r => typeof r.nextTarget === 'string'), 'pierce mark logged');
    out[seed] = turns.map(t => t.boss.steps[0].action[0]).join('');
    ref.stop();
  }
  assert(['pierce', 'rain', 'trap'].every(a => seen.has(a)), 'all moves ' + [...seen]);
  return out;
}));


await test('裁判（4 人）：P1 P2 → 遊俠插話（turn / aiTurn 帶 interject，放藤蔓陷阱、不換樹枝）→ P3 P4 → 遊俠（貫穿箭 / 箭雨 + 換樹枝，不放陷阱）；陷阱滿了就不插話', () => base(() => {
  const players = mkPlayers(4);
  const m = new Match({ levelId: 'forestRanger', players, seed: 2, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 4000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  for (const p of players) ref.setConnected(p.id, false);
  for (let k = 0; k < 120 && ref.phase !== 'over'; k++) io.advance(500);
  const turns = io.log.filter(x => x.t === 'turn').map(t => t.actorId + (t.interject ? '*' : ''));
  assert(J(turns.slice(0, 6)) === J(['p1', 'p2', 'ranger*', 'p3', 'p4', 'ranger']), J(turns.slice(0, 8)));
  const ai = io.log.filter(x => x.t === 'aiTurn' && x.actorId === RANGER_ID);
  const inter = ai.filter(t => t.interject), own = ai.filter(t => !t.interject);
  assert(inter.length && inter.every(t => J(t.boss.steps.map(s => s.action)) === J(['trap'])), 'interjections sow traps ' + J(inter.map(t => t.boss.steps.map(s => s.action))));
  assert(own.every(t => !t.boss.steps.some(s => s.action === 'trap') && t.boss.steps[t.boss.steps.length - 1].action === 'hop'), 'own turns: no traps');
  assert(liveTraps(m).length <= CONFIG.RANGER.trap.max, 'never over the cap');
  ref.stop();
  return { turns: turns.slice(0, 6), interjections: inter.length, traps: liveTraps(m).length };
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
function mkView() {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  return view;
}

await test('真的 GameView：遊俠從開場播到三招（全員 AI 代打；每幀 update + render）：沒有腳本錯誤；客戶端的機制狀態（下一招、樹枝、陷阱、被困住的人）與遊俠、玩家跟伺服器一樣；菁英關橫幅；HUD', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'forestRanger', players, seed: 3, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 5000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  const view = mkView();
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  assert(view.mapView.type === 'ranger' && view.banner && view.banner.text === '菁英關：大樹遊俠', 'elite banner: ' + J(view.banner && view.banner.text));
  for (const p of players) ref.setConnected(p.id, false);
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Set();
  try {
    for (let k = 0; k < 900 && ref.phase !== 'over'; k++) {
      io.advance(250);
      for (const t of io.log.filter(x => x.t === 'aiTurn' && x.actorId === RANGER_ID)) t.boss.steps.forEach(st => seen.add(st.action));
      feed();
      for (let f = 0; f < 15; f++) { view.update(CONFIG.FIXED_DT); view.render(); }
      if (['hop', 'pierce', 'rain', 'trap'].every(a => seen.has(a)) && k > 60) break;
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(['hop', 'pierce', 'rain', 'trap'].every(a => seen.has(a)), 'played all moves: ' + [...seen]);
  const S = view.match.mechState, T = m.mechState;
  assert(J(S.next) === J(T.next) && S.perch === T.perch && J(Object.keys(S.trapped)) === J(Object.keys(T.trapped)), 'mech state synced ' + J([S.next, S.perch, T.next, T.perch]));
  const traps = (mm) => mm.entities.filter(e => e.kind === 'vineTrap').map(e => [e.id, e.x, e.y, e.hp, e.alive]);
  assert(J(traps(view.match)) === J(traps(m)), 'traps synced ' + J([traps(view.match), traps(m)]));
  const vg = view.match.byId(RANGER_ID), sg = m.byId(RANGER_ID);
  assert(vg.x === sg.x && vg.y === sg.y && vg.hp === sg.hp, 'ranger synced ' + J([vg.x, vg.y, vg.hp, sg.x, sg.y, sg.hp]));
  assert(view.match.players.every(p => p.hp === m.byId(p.id).hp && p.held === m.byId(p.id).held), 'players synced');
  const hud = view.mapView.hud(view.mapCtx, ['x', '#fff']);
  if (sg.alive) assert(/^大樹遊俠 \d+ \/ \d+$/.test(hud[1][0]) && /^下一招：(貫穿箭|箭雨|藤蔓陷阱)/.test(hud[2][0]), 'hud ' + J(hud));
  return { moves: [...seen] };
}));

await test('真的 GameView：自己被困住 → 自己的回合體力照真實時間每秒流失 40；A / D 左右交替才送 struggle（同一邊不送）；伺服器說掙脫 → 放開、按著的 A / D 放掉', () => base(() => {
  const { m, io, ref } = rig(2, (m) => {
    placeOn(m, m.players[0], 250, 540);
    m.mechState.trapped.p1 = { count: 0, last: 0, at: 0, st: 200 };
  });
  ref.start();
  const view = mkView();
  const sent = [];
  view.transport = { send: (msg) => { sent.push(msg); ref.handle('p1', JSON.parse(J(msg))); } };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  feed();
  for (let f = 0; f < 3; f++) view.update(CONFIG.FIXED_DT);
  const me = view.match.byId('p1');
  assert(view.canAct && me.held && me.staminaDrain === 40, 'my trapped turn');
  const s0 = me.stamina;
  view.frame(0.5);
  assert(near(me.stamina, s0 - 20), 'drains by the real clock ' + me.stamina);
  // 按鍵：直接走 GameView 的掙扎（keydown 的那段）
  const press = (dir) => { if (view.canAct && !view.waiting && me.alive && me.held && view.mapView.struggle(view.mapCtx, me, dir)) view.transport.send({ t: 'struggle', dir }); };
  press(1); press(1); press(-1);
  assert(sent.length === 2 && sent[0].dir === 1 && sent[1].dir === -1, 'same side once ' + J(sent));
  for (let k = 0; k < 8; k++) press(k % 2 ? -1 : 1);
  view.keys.KeyA = true;
  view.keys.KeyD = true;
  feed();
  for (let f = 0; f < 5; f++) view.update(CONFIG.FIXED_DT);
  assert(!me.held && !view.match.mechState.trapped.p1 && !view.keys.KeyA && !view.keys.KeyD, 'freed + keys released');
  assert(!m.byId('p1').held, 'server freed too');
  ref.stop();
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
