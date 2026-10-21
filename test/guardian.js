// node test/guardian.js
// 2026-10-13：菁英關「大樹守衛」（森林）；2026-10-14 改版（大樹改為背景、守衛從最右邊出場、衝鋒 / 躍擊改版）。
// 地圖（菁英池、大樹只是裝飾：樹幹不是地形、人走得過去；整片地面炸不壞（2026-10-19）、守衛從最右邊出場）、
// 守衛（有重力、血量照一般敵人放大、下一招事先抽好）、
// 衝鋒（抽到時標記最遠的人、衝向被標記的人（就算他已經不是最遠的）、他倒下了改衝當下最遠的、路上的人一起撞開（每人一次）、
//       撞到目標就停在他旁邊、傷害固定 40（×0.7）、往前撞飛、目標後面的人沒事、坑洞直接衝過去、目標在坑裡 → 衝到他那一行為止）、
// 舉盾（一抽到就舉起來、面向最近的人、受到的傷害 -30%、輪到他時盾擊盾牌前方範圍裡的人、背後 / 範圍外的不會被打到、出完盾放下）、
// 躍擊（抽到時隨機鎖定一個活著的人的位置、跳到那裡、警示範圍裡的人受傷、走開就躲得掉、傷害看距離 50 → 70、落地點被炸掉就落到坑底；
//       落地之後接橫劈（一回合兩招）：範圍（slashBand）裡的人受傷 30（×0.7）、5 層流血、每人一次、範圍外的沒事）、
// 客戶端照事件重播一致（兩招照順序）、快照重建、裁判流程與紀錄（nextTarget）、
// 真的 GameView 播一段（衝鋒的標記與路線、HUD 的目標名字、警示範圍、橫劈的橫幅 / 刀光（沒有範圍提示）、跳在空中 / 衝出去時角色不畫）、
// 起手動作（衝鋒前人立踏地、躍擊前深蹲蓄力）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { strikeDamage, planGuardianNext, leapBand, bashBand, slashBand, chargeTarget, chargeLane, offChargeLane, shieldUp } from '../shared/maps/guardian.js';
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
const make = (n = 1, opts = {}) => new Match({ levelId: 'forestGuard', players: mkPlayers(n), seed: 1, stage: 3, ...opts });
// 2026-10-19 起大樹守衛的地面炸不壞（不會有坑）；衝鋒 / 躍擊碰到坑的處理是通用的，用一份挖得動的地形測（改版前的：土 + 地底炸不壞的樹根）
const GL = LEVELS.forestGuard;
LEVELS.forestGuardSoft = { ...GL, pool: 'test', polygons: GL.hardPolygons, hardPolygons: [[[0, 626], [1024, 626], [1024, 768], [0, 768]]], hardLook: undefined };
const makeSoft = (n = 1, opts = {}) => make(n, { levelId: 'forestGuardSoft', ...opts });
// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原
function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, { ...CONFIG[k] }]));
  for (const [k, v] of Object.entries(patch)) Object.assign(CONFIG[k], v);
  const restore = () => { for (const [k, v] of Object.entries(saved)) Object.assign(CONFIG[k], v); };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}
const BASE = {
  ENEMY: { hp: 45, damageMult: 0.7, lateFromStage: 6, damageMultLate: 1 },
  RUN: { stageCount: 10, bossStages: [5, 10], eliteStages: [3, 8], enemyHpPerStage: 0.15 },
  GUARDIAN: {
    hp: 200, weights: { charge: 40, shield: 30, leap: 30 }, near: 80, far: 560, shieldCut: 30, bashReach: 60, leapZone: 20, slashReach: 70,
    cast: { charge: 0.8, bash: 0.8, leap: 1.4, slash: 0.5 },
  },
  PLAYER: { hp: 150 }, WATER: { damagePct: 30, enemiesDrown: true }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  BLEED: { pctPerPx: 0.01 },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180 },
    guardianCharge: { ...CONFIG.WEAPONS.guardianCharge, damage: 40, damageFar: undefined, knockback: 120, speed: 760, hitRadius: 18 },
    guardianBash: { ...CONFIG.WEAPONS.guardianBash, damage: 45, knockback: 200, speed: 900, hitRadius: 16 },
    guardianLeap: { ...CONFIG.WEAPONS.guardianLeap, damage: 50, damageFar: 70, knockback: 160, speed: 900, hitRadius: 20 },
    guardianSlash: { ...CONFIG.WEAPONS.guardianSlash, damage: 30, bleed: 5, knockback: 80, speed: 900, hitRadius: 20 },
  },
};
const base = (fn, extra = {}) => {
  const patch = { ...BASE };
  for (const [k, v] of Object.entries(extra)) patch[k] = { ...(BASE[k] || {}), ...v };
  return withConfig(patch, fn);
};
const only = (action) => ({ GUARDIAN: { weights: { charge: 0, shield: 0, leap: 0, [action]: 1 } } });
// 把角色放到 (x, y) 正下方站好
function placeOn(m, e, x, y = 500) {
  e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.onGround = false;
  for (let i = 0; i < 400 && !e.onGround; i++) e.update(CONFIG.FIXED_DT, m.world);
  e.safeX = e.x; e.safeY = e.y;
}
// 站在地上（照物理的規則：斜坡、坑底身體外側先碰到也算）
const standing = (m, e) => e.standing(m.terrain, e.x, e.y) && !e.collides(m.terrain, e.x, e.y);
// 離守衛最遠的活著的玩家（測試自己算，不用規則檔的）
const farthest = (m) => {
  const g = m.byId('guardian');
  const d = (e) => (e.cx - g.cx) ** 2 + (e.cy - g.cy) ** 2;
  return m.players.filter(e => e.alive).reduce((a, e) => (!a || d(e) > d(a) ? e : a), null);
};
// 躍擊：抽到時鎖定 id 這個人（把 rng 的 pick 換成挑他；抽招式的 float 照用）
function planLeapOn(m, id) {
  const pick = m.rng.pick;
  m.rng.pick = (arr) => arr.find(e => e.id === id);
  m.mechState.next = null;
  try { base(() => planGuardianNext(m), only('leap')); } finally { m.rng.pick = pick; }
  return { ...m.mechState.next };
}
// 照預定的招式讓守衛出一回合（不經過裁判），順便讓客戶端從出招前的快照照事件一招一招重播、套結果，跟伺服器一樣
function guardTurn(m, plan) {
  if (plan) m.mechState.next = plan;
  const before = JSON.parse(J(m.snapshot()));
  const g = m.byId('guardian');
  const r = m.planAiTurn(g).boss;
  const c = make(m.players.length, { seed: m.seed, levelId: m.levelId });
  c.applySnapshot(before);
  for (const st of r.steps) {
    if (st.shot) {
      const shot = JSON.parse(J(st.shot));
      replayChecked(c, shot, st.action);
      c.applyEntities(shot.results);
    } else {
      c.applyEntities(JSON.parse(J(st.still.results)));
    }
  }
  const label = r.steps.map(st => st.action).join('+');
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(c.terrain.mask)) === 0, `${label}: terrain differs`);
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${label}: entities differ`);
  const entries = (st) => (st.shot ? st.shot.events.flatMap(ev => ev.damages || []) : []);
  const sum = (steps, id) => steps.flatMap(entries).filter(d => d.id === id).reduce((s, d) => s + d.dmg, 0);
  return {
    st: r.steps[0], steps: r.steps, next: r.next, entries,
    dmg: (id) => sum(r.steps, id),
    dmgIn: (action, id) => sum(r.steps.filter(st => st.action === action), id),
  };
}
const dmgOf = (m, weaponId, d) => Math.round(strikeDamage(CONFIG.WEAPONS[weaponId], d) * m.rules.enemyDamage);
const flat = (m, weaponId) => Math.round(CONFIG.WEAPONS[weaponId].damage * m.rules.enemyDamage);
const lean = (st) => ({ ...st, shot: undefined, still: undefined });

// ---------------- 地圖 ----------------

await test('地圖：大樹守衛在菁英池（森林）、守衛排最後、有重力、不是首領、血量照一般敵人放大、從最右邊出場站在地上（血條在畫面裡）；開場就抽好第一招', () => base(() => {
  const L = LEVELS.forestGuard;
  assert(L.name === '大樹守衛' && L.pool === 'elite' && L.theme === 'forest' && L.mechanic.type === 'guardian', 'level');
  assert(levelsInPool('elite').includes('forestGuard') && !levelsInPool('normal').includes('forestGuard'), 'elite pool');
  const out = {};
  for (const n of [1, 2, 4]) {
    const m = make(n);
    const g = m.byId('guardian');
    assert(m.entities[m.entities.length - 1] === g && m.enemies.length === 1, 'guardian last, the only enemy');
    assert(!g.fixed && !g.boss && !g.optional && g.part === 'guardian' && g.name === '大樹守衛', 'flags');
    assert(g.hp === Math.round(200 * m.rules.enemyHp) && g.hp === g.maxHp, `hp ${g.hp} vs ${200 * m.rules.enemyHp}`);
    assert(standing(m, g) && g.x > 940 && g.x + 50 <= m.terrain.maxX && g.facing === -1, `stands at the far right: ${g.x},${g.y}`);
    assert(m.players.every(p => standing(m, p) && p.x < g.x), 'players on the ground to the left');
    const next = m.mechState.next;
    assert(next && ['charge', 'shield', 'leap'].includes(next.action), 'first move planned: ' + J(next));
    if (next.action !== 'shield') assert(m.players.some(p => p.id === next.targetId), 'charge / leap carries a target: ' + J(next));
    out[n] = [g.hp, next.action];
  }
  return out;
}));

await test('地圖：大樹只是背景（樹幹、樹冠是 decor，地形裡沒有）：地面以上沒有任何實心地形、子彈 / 人都穿得過；樹幹的圖照 drawTrunk 的格式（左半由下往上、右半由上往下）', () => base(() => {
  const L = LEVELS.forestGuard;
  assert(!L.polygons.length && L.hardPolygons.length === 1 && L.hardLook === 'ground', 'the whole ground is hard, drawn as ground: ' + J([L.polygons, L.hardLook]));
  const ground = Math.min(...L.hardPolygons[0].map(([, y]) => y));
  assert(ground >= 576 && L.hardPolygons[0].some(([x, y]) => x === 0 && y === 768) && L.hardPolygons[0].some(([x, y]) => x === 1024 && y === 768), 'ground from y≈578 to the bottom: ' + J(L.hardPolygons));
  const T = L.decor.trunk;
  assert(Array.isArray(T) && T.length === 32 && T.every(([, y]) => y <= 580), 'trunk outline, bottom hidden under the ground');
  assert(T[15][1] === Math.min(...T.map(p => p[1])) || T[16][1] === Math.min(...T.map(p => p[1])), 'half split lands on the top of the trunk');
  assert(T.slice(0, 16).every((p, i) => i === 0 || p[1] <= T[i - 1][1]) && T.slice(16).every((p, i) => i === 0 || p[1] >= T[16 + i - 1][1]), 'left half goes up, right half comes down');
  assert(Array.isArray(L.decor.canopy) && L.decor.canopy.length > 10 && !L.decor.canopyFront, 'canopy drawn behind (back layer)');
  const m = make(1);
  let hard = 0;
  for (let y = 0; y < ground - 1; y += 2) for (let x = 0; x < m.terrain.maxX; x += 2) if (m.terrain.isSolid(x, y)) hard++;
  assert(hard === 0, `solid pixels above the ground: ${hard}`);
  assert(!m.terrain.isSolid(700, 400) && !m.terrain.isSolid(650, 530) && !m.terrain.isSolid(760, 300) && !m.terrain.isSolid(900, 560), 'trunk is not terrain');
  // 一個人從樹前面一直往右走：穿過原本樹幹的地方，一路都在地面上
  const p = m.players[0];
  placeOn(m, p, 500);
  p.stamina = p.maxStamina = 99999;
  p.moveDir = 1;
  let top = p.y;
  for (let i = 0; i < 260; i++) { p.update(CONFIG.FIXED_DT, m.world); top = Math.min(top, p.y); }
  assert(p.x > 800 && top > 570, `walked through the trunk on the ground: x ${p.x.toFixed(1)}, top ${top.toFixed(1)}`);
  return { walkedTo: Math.round(p.x) };
}));

await test('地形：整片地面炸不壞（2026-10-19）——挖得動地形的爆炸（大砲直接打在地上）打不出坑，地形一格都沒變；站在落點的人照樣站在地面上', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 300);
  const y0 = p.y;
  const before = Buffer.from(m.terrain.mask);
  for (let k = 0; k < 6; k++) m.terrain.carve(300, 590 + k * 15, 42);   // 一路往下挖
  const shot = m.resolveShot(p, 'cannon', 90, 5);   // 大砲往正上方輕輕打，落回自己腳邊
  assert(shot.events.some(ev => ev.carve), 'the shell digs (on a soft map it would make a crater): ' + J(shot.events.map(ev => ev.type)));
  assert(Buffer.compare(before, Buffer.from(m.terrain.mask)) === 0, 'terrain unchanged');
  m.settle();
  assert(p.alive && standing(m, p) && Math.abs(p.y - y0) < 1 && p.waterFalls === 0, `still on the ground: ${p.y} (was ${y0})`);
  return { y: p.y };
}));

// ---------------- 衝鋒 ----------------

await test('衝鋒：一抽到就標記離他最遠的玩家（next.targetId）', () => base(() => {
  const out = [];
  for (const xs of [[300, 60, 500], [80, 400, 250], [600, 700, 150]]) {
    const m = make(3);
    m.players.forEach((p, i) => placeOn(m, p, xs[i]));
    m.mechState.next = null;
    base(() => planGuardianNext(m), only('charge'));
    const want = farthest(m);
    assert(J(m.mechState.next) === J({ action: 'charge', targetId: want.id }), `marked the farthest ${want.id}: ` + J(m.mechState.next));
    out.push(want.id);
  }
  // 最遠的人倒下了就標記下一個最遠的
  const m = make(3);
  m.players.forEach((p, i) => placeOn(m, p, [300, 60, 500][i]));
  m.byId('p2').die('hit');
  m.mechState.next = null;
  base(() => planGuardianNext(m), only('charge'));
  assert(m.mechState.next.targetId === 'p1', 'skips the dead: ' + J(m.mechState.next));
  return out;
}));

await test('衝鋒：衝向被標記的人（就算他已經不是最遠的）、路上的人一起撞開（每人一次）、撞到目標就停在他旁邊；傷害固定 40（×0.7）、往前撞飛、目標後面的人沒事；客戶端重播一致', () => base(() => {
  const m = make(3);
  const g = m.byId('guardian');
  const [p1, p2, p3] = m.players;
  placeOn(m, p1, 600);   // 路上
  placeOn(m, p2, 300);   // 被標記的人
  placeOn(m, p3, 120);   // 目標後面（比目標還遠）
  const x1 = p1.x, x2 = p2.x, x3 = p3.x;
  assert(farthest(m) === p3, 'p3 is the farthest now');
  const t = guardTurn(m, { action: 'charge', targetId: 'p2' });
  assert(t.steps.length === 1 && t.st.action === 'charge' && t.st.targetId === 'p2' && t.st.hit === 'p2' && t.st.through === 'p1', 'charged the marked one through p1: ' + J(lean(t.st)));
  assert(t.st.dmg === 40 && Number.isFinite(t.st.dist) && t.st.cast === 0.8, 'logged dmg / dist / cast');
  const want = flat(m, 'guardianCharge');
  assert(want === 28 && t.dmg('p1') === want && t.dmg('p2') === want && t.dmg('p3') === 0, `damage ${t.dmg('p1')} / ${t.dmg('p2')} / ${t.dmg('p3')} (want ${want})`);
  const evs = t.st.shot.events.filter(ev => ev.p === 0 && ev.target);
  assert(J(evs.map(ev => [ev.type, ev.target])) === J([['pierce', 'p1'], ['explode', 'p2']]), 'pierce p1, stop at p2: ' + J(evs.map(ev => [ev.type, ev.target])));
  assert(t.entries(t.st).filter(d => d.id === 'p1').length === 1, 'p1 hit once');
  assert(p1.x < x1 - 10 && p2.x < x2 - 10 && Math.abs(p3.x - x3) < 0.5, `knocked forward: ${p1.x - x1} / ${p2.x - x2} / ${p3.x - x3}`);
  assert(Math.abs(g.x - (x2 + p2.hw + g.hw)) <= 3 && standing(m, g) && g.facing === -1, `stopped next to where p2 stood: ${g.x} (p2 was at ${x2})`);
  return { dmg: want, stop: Math.round(g.x) };
}));

await test('衝鋒：被標記的人倒下了 → 改衝現在離他最遠的（畫面的標記也照 chargeTarget）', () => base(() => {
  const m = make(3);
  const g = m.byId('guardian');
  const [p1, p2, p3] = m.players;
  placeOn(m, p1, 450);
  placeOn(m, p2, 250);
  placeOn(m, p3, 80);
  const plan = { action: 'charge', targetId: 'p3' };
  assert(chargeTarget(m, g, plan) === p3, 'marked one while alive');
  p3.die('hit');
  assert(chargeTarget(m, g, plan) === p2 && chargeTarget(m, g, { action: 'charge' }) === p2, 'falls back to the farthest alive');
  // 路線（畫面照它畫）：守衛身體中間到目標身體靠他這一邊的邊緣、衝鋒撞得到的高度
  const lane = chargeLane(g, p2);
  assert(lane.dir === -1 && lane.x0 === p2.x + p2.hw && lane.x1 === g.x && lane.top === g.cy - 18 && lane.bottom === g.cy + 18, 'lane ' + J(lane));
  const t = guardTurn(m, plan);
  assert(t.st.targetId === 'p2' && t.st.hit === 'p2' && t.st.through === 'p1', 'charged p2: ' + J(lean(t.st)));
  assert(t.dmg('p1') === flat(m, 'guardianCharge') && t.dmg('p2') === flat(m, 'guardianCharge') && t.dmg('p3') === 0, 'damage');
  return { stop: Math.round(g.x) };
}));

await test('衝鋒 / 躍擊的傷害：衝鋒固定（貼著、很遠都是 40 × 0.7），躍擊照距離（near 以內最低、far 以上最高、中間照比例）', () => base(() => {
  const L = CONFIG.WEAPONS.guardianLeap;
  const vals = [0, 80, 320, 560, 900].map(d => strikeDamage(L, d));
  assert(J(vals) === J([50, 50, 60, 70, 70]), 'leap scale ' + J(vals));
  const out = {};
  for (const x of [null, 60]) {
    const m = make(1);
    const g = m.byId('guardian'), p = m.players[0];
    placeOn(m, p, x ?? g.x - 50);
    const t = guardTurn(m, { action: 'charge', targetId: 'p1' });
    assert(t.st.hit === 'p1' && t.dmg('p1') === Math.round(40 * 0.7), `charge ${x ?? 'near'}: ${t.dmg('p1')}`);
    out[x ?? 'near'] = t.dmg('p1');
  }
  return { leap: vals, charge: out };
}));

await test('衝鋒：中間有坑 → 直接衝過去、停在目標旁邊；目標在坑裡（比衝鋒低、撞不到）→ 衝到他那一行為止（不撞到人）', () => base(() => {
  const m = makeSoft(1);
  const g = m.byId('guardian'), q = m.players[0];
  placeOn(m, q, 300);
  m.terrain.carve(650, 590, 40);
  const t = guardTurn(m, { action: 'charge', targetId: 'p1' });
  assert(t.st.hit === 'p1' && standing(m, g) && Math.abs(g.x - (300 + q.hw + g.hw)) <= 3, 'charged across the pit: ' + g.x);
  // 目標在坑裡
  const m2 = makeSoft(1);
  const g2 = m2.byId('guardian'), q2 = m2.players[0];
  for (let k = 0; k < 4; k++) m2.terrain.carve(400, 590 + k * 12, 40);
  placeOn(m2, q2, 400);
  assert(q2.y - q2.h > g2.cy + 18, `p1 sits below the lane: ${q2.y}`);
  const hp = q2.hp;
  const t2 = guardTurn(m2, { action: 'charge', targetId: 'p1' });
  assert(t2.st.targetId === 'p1' && !t2.st.hit && q2.hp === hp && t2.dmg('p1') === 0, 'did not touch p1: ' + J(lean(t2.st)));
  assert(Math.abs(g2.x - q2.x) <= 1 && standing(m2, g2), `ran to p1's column: ${g2.x} vs ${q2.x}`);
  return { acrossPit: Math.round(g.x), pitColumn: Math.round(g2.x) };
}));

// 固定 seed 的亂數（mulberry32）
const seeded = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

await test('衝鋒：背後的人（貼在他背上、站在他腳邊靠後面）撞不到、不會被往後撞飛；目標貼在他前面時，目標後面的人也撞不到；路上的人照樣撞開', () => base(() => {
  // 守衛在出場的地方往左衝：p1 貼在他背上（身體重疊 8 px）、p2 站在他腳邊靠後面（身體中間在他身體中間後面 5 px）、p3 在路上、p4 是目標
  const m = make(4);
  const g = m.byId('guardian');
  const [p1, p2, p3, p4] = m.players;
  placeOn(m, g, 966);
  placeOn(m, p1, g.x + g.hw + p1.hw - 8);
  placeOn(m, p2, g.x + 5);
  placeOn(m, p3, 600);
  placeOn(m, p4, 150);
  const was = [p1, p2, p3].map(p => ({ x: p.x, hp: p.hp }));
  const t = guardTurn(m, { action: 'charge', targetId: 'p4' });
  assert(t.st.hit === 'p4' && t.st.through === 'p3', 'only p3 on the way: ' + J(lean(t.st)));
  assert(t.dmg('p1') === 0 && t.dmg('p2') === 0 && p1.hp === was[0].hp && p2.hp === was[1].hp, `the ones behind him are not hit: ${t.dmg('p1')} / ${t.dmg('p2')}`);
  assert(Math.abs(p1.x - was[0].x) < 0.5 && Math.abs(p2.x - was[1].x) < 0.5, `nor knocked backwards: ${p1.x - was[0].x} / ${p2.x - was[1].x}`);
  assert(t.dmg('p3') === flat(m, 'guardianCharge') && p3.x < was[2].x - 10, 'p3 on the way: hit and knocked forward');
  // 目標貼在他前面（身體跟他重疊），q1 在目標後面（也碰得到守衛的身體）：撞到目標就停，q1 沒事
  const m2 = make(2);
  const g2 = m2.byId('guardian');
  const [q1, q2] = m2.players;
  placeOn(m2, g2, 173);
  placeOn(m2, q2, 177);
  placeOn(m2, q1, 199);
  const hp1 = q1.hp, x1 = q1.x;
  const t2 = guardTurn(m2, { action: 'charge', targetId: 'p2' });
  assert(t2.st.hit === 'p2' && !t2.st.through && t2.dmg('p2') === flat(m2, 'guardianCharge'), 'stopped at the target: ' + J(lean(t2.st)));
  assert(t2.dmg('p1') === 0 && q1.hp === hp1 && Math.abs(q1.x - x1) < 0.5, `the one beyond the target is not hit: ${t2.dmg('p1')} / ${q1.x - x1}`);
  // 跟他疊在一起、身體中間在他前半身的人（還碰不到他身體的前緣）：在路線上，照樣被撞開
  const m3 = make(2);
  const g3 = m3.byId('guardian');
  const [r1, r2] = m3.players;
  placeOn(m3, g3, 700);
  placeOn(m3, r1, g3.x - 5);
  placeOn(m3, r2, 200);
  const t3 = guardTurn(m3, { action: 'charge', targetId: 'p2' });
  assert(t3.st.through === 'p1' && t3.dmg('p1') === flat(m3, 'guardianCharge'), 'the one in his front half is on the path: ' + J(lean(t3.st)));
  // 路線的規則本身：背後 = 身體中間沒有在他身體中間的前面；目標後面 = 靠守衛這一邊的邊緣比目標的還遠（不是量到目標的身體中間）
  const L = chargeLane(g3, r2);
  const at = (x) => ({ x, hw: 9 });
  assert(offChargeLane(L, at(g3.x)) && offChargeLane(L, at(g3.x + 1)) && !offChargeLane(L, at(g3.x - 1)), 'behind = centre not ahead of his centre');
  assert(!offChargeLane(L, at(r2.x + 2 * r2.hw)) && !offChargeLane(L, at(r2.x)) && offChargeLane(L, at(r2.x - 0.5)) && offChargeLane(L, at(r2.x - 3)),
    'beyond = near edge farther than the target near edge (overlapping the far side of the target is beyond)');
  return { through: t.st.through, beyond: t2.dmg('p1'), frontHalf: t3.st.through };
}));

await test('衝鋒：亂數擺位（有人貼著守衛、站在他前後）：被撞到的人身體都碰到畫面上的路線（chargeLane 的左右範圍與高度）', () => base(() => {
  const rnd = seeded(1014);
  let hits = 0, near = 0;
  for (let k = 0; k < 150; k++) {
    const m = make(3, { seed: 50 + k });
    const g = m.byId('guardian');
    placeOn(m, g, 200 + rnd() * 760);
    const [a, b, c] = m.players;
    placeOn(m, a, g.x + (rnd() * 2 - 1) * 40);   // 貼著守衛（前面、後面都有）
    placeOn(m, b, 20 + rnd() * 980);
    placeOn(m, c, 20 + rnd() * 980);
    const target = [b, c, a][Math.floor(rnd() * 3)];
    if (target.x === g.x) continue;
    const lane = chargeLane(g, target);
    const pre = new Map(m.players.map(p => [p.id, { x: p.x, y: p.y }]));
    const t = guardTurn(m, { action: 'charge', targetId: target.id });
    for (const d of t.steps.flatMap(t.entries)) {
      const p = m.byId(d.id), s = pre.get(d.id);
      hits++;
      if (p === a) near++;
      assert(s.x + p.hw >= lane.x0 && s.x - p.hw <= lane.x1 && s.y >= lane.top && s.y - p.h <= lane.bottom,
        `layout ${k}: ${d.id} at ${s.x.toFixed(1)} was hit outside the lane ${J(lane)} (guardian at ${g.x})`);
    }
  }
  assert(hits > 100 && near > 10, `enough hits to mean something: ${hits} (next to him ${near})`);
  return { hits, near };
}));

await test('衝鋒停在坑裡的斜坡 / 坑邊（停下的地方是小數、那一行站不住）：守衛一定站穩（不懸空、不卡進地形），客戶端套上結果再跑一秒物理位置不變', () => base(() => {
  // 套上結果的客戶端跑一秒物理（下一個玩家回合的畫面就是這樣）：伺服器的守衛要在同一個地方
  const check = (m, label) => {
    const g = m.byId('guardian');
    assert(g.onGround && standing(m, g), `${label}: guardian stands at ${g.x}, ${g.y} (onGround ${g.onGround}, collides ${g.collides(m.terrain, g.x, g.y)})`);
    const c = make(m.players.length, { seed: m.seed, levelId: m.levelId });
    c.applySnapshot(JSON.parse(J(m.snapshot())));
    const cg = c.byId('guardian');
    for (let i = 0; i < 60; i++) cg.update(CONFIG.FIXED_DT, c.world);
    assert(cg.x === g.x && cg.y === g.y && cg.onGround, `${label}: a client running physics moves him: ${cg.x}, ${cg.y} vs ${g.x}, ${g.y}`);
  };
  // 審查找到的兩個：目標站在坑裡、守衛衝到他那一行（坑的斜坡上）；目標站在坑邊、守衛撞到他停在坑邊
  const fixed = [
    { craters: [[575.3, 583.6, 46.8]], g: 966, at: [544.75, 300] },
    { craters: [[87, 588, 31], [185, 586, 34]], g: 765, at: [47] },
  ];
  for (const [i, f] of fixed.entries()) {
    const m = makeSoft(f.at.length);
    for (const cr of f.craters) m.terrain.carve(...cr);
    placeOn(m, m.byId('guardian'), f.g);
    m.players.forEach((p, j) => placeOn(m, p, f.at[j]));
    const t = guardTurn(m, { action: 'charge', targetId: 'p1' });
    assert(t.st.action === 'charge' && !t.st.blocked, `fixed ${i}: charged: ` + J(lean(t.st)));
    check(m, `fixed ${i}`);
  }
  // 亂數：一到三個坑、目標站在坑裡或坑邊（小數的位置）
  const rnd = seeded(1410);
  let n = 0;
  for (let k = 0; k < 400; k++) {
    const m = makeSoft(2, { seed: 100 + k });
    const craters = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => [80 + rnd() * 700, 575 + rnd() * 30, 20 + rnd() * 40]);
    for (const cr of craters) m.terrain.carve(...cr);
    const g = m.byId('guardian');
    placeOn(m, g, 966);
    const [cx, , r] = craters[0];
    placeOn(m, m.players[0], cx + (rnd() - 0.5) * r * 2.4);
    placeOn(m, m.players[1], 200 + rnd() * 700);
    if (!m.players[0].alive || !m.players[1].alive) continue;
    const t = guardTurn(m, { action: 'charge', targetId: 'p1' });
    if (t.st.action !== 'charge' || t.st.blocked) continue;
    check(m, `layout ${k} ${J(craters)}`);
    n++;
  }
  assert(n > 300, 'charges checked: ' + n);
  return { charges: n };
}));

// ---------------- 舉盾 ----------------

await test('舉盾：一抽到就面向最近的人舉起來，舉著時受到的傷害 ×0.7；輪到他盾擊盾牌前方的人（背後、範圍外的沒事）、往前推；出完盾放下（下一招衝鋒標記最遠的人）', () => base(() => {
  const m = make(3);
  const g = m.byId('guardian');
  const [p1, p2, p3] = m.players;
  placeOn(m, p1, g.x - 40);            // 盾牌前方
  placeOn(m, p2, g.x + 34);            // 背後
  const band = bashBand(g, -1);
  placeOn(m, p3, band.x0 - p3.hw - 4);   // 盾擊範圍外一點點
  m.mechState.next = null;
  base(() => planGuardianNext(m), only('shield'));
  assert(J(m.mechState.next) === J({ action: 'shield', facing: 1 }) && g.facing === 1, 'faces the nearest (p2 behind): ' + J(m.mechState.next));
  m.mechState.next = { action: 'shield', facing: -1 };
  g.facing = -1;
  assert(shieldUp(m), 'shield up');
  // 受到的傷害 ×0.7（大砲直擊 30 → 21）
  const cannon = CONFIG.WEAPONS.cannon;
  const hp0 = g.hp;
  const hit = m.applyExplosion(g.x, g.cy, cannon, p1, g).find(d => d.id === 'guardian');
  assert(hit.dmg === 21 && g.hp === hp0 - 21, 'shielded damage ' + hit.dmg);
  g.hp = hp0;
  const x1 = p1.x;
  const t = base(() => guardTurn(m), only('charge'));
  assert(t.st.action === 'bash' && t.st.facing === -1 && t.steps.length === 1, 'bash step');
  assert(t.dmg('p1') === Math.round(45 * 0.7) && t.dmg('p2') === 0 && t.dmg('p3') === 0, `bash hits only the one in front: ${t.dmg('p1')} / ${t.dmg('p2')} / ${t.dmg('p3')}`);
  assert(p1.x < x1 - 10, 'pushed forward');
  assert(t.next.action === 'charge' && t.next.targetId === farthest(m).id && !shieldUp(m), 'shield lowered, charge marks the farthest: ' + J(t.next));
  const plain = m.applyExplosion(g.x, g.cy, cannon, p1, g).find(d => d.id === 'guardian');
  assert(plain.dmg === 30, 'full damage after lowering ' + plain.dmg);
  return { shielded: hit.dmg, bash: t.dmg('p1') };
}));

await test('盾擊範圍（bashBand，畫面照它畫）：身體碰到範圍就被打到、差一點就沒事', () => base(() => {
  const out = {};
  for (const [inside, off] of [[true, 3], [false, -3]]) {
    const m = make(1);
    const g = m.byId('guardian'), p = m.players[0];
    const band = bashBand(g, -1);
    placeOn(m, p, band.x0 - p.hw + off);
    const t = guardTurn(m, { action: 'shield', facing: -1 });
    assert((t.dmg('p1') > 0) === inside, `body ${off > 0 ? 'inside' : 'outside'} by ${Math.abs(off)}px → ${t.dmg('p1')}`);
    out[inside ? 'in' : 'out'] = t.dmg('p1');
  }
  return out;
}));

// ---------------- 躍擊 + 橫劈 ----------------

await test('躍擊：抽到時隨機鎖定一個活著的玩家站的地方（match.rng；每個人都抽得到，倒下的不會被抽到；同一個種子抽到同一個）', () => base(() => {
  const picked = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    const runOnce = () => {
      const m = make(3, { seed });
      m.players.forEach((p, i) => placeOn(m, p, [80, 300, 500][i]));
      m.mechState.next = null;
      base(() => planGuardianNext(m), only('leap'));
      return [m, m.mechState.next];
    };
    const [m, plan] = runOnce();
    const t = m.byId(plan.targetId);
    assert(plan.action === 'leap' && t && Math.abs(plan.x - t.x) <= 2 && Number.isFinite(plan.y), `seed ${seed}: ` + J(plan));
    assert(J(runOnce()[1]) === J(plan), `seed ${seed}: deterministic`);
    picked.add(plan.targetId);
  }
  assert(J([...picked].sort()) === J(['p1', 'p2', 'p3']), 'everyone gets picked: ' + [...picked]);
  // 倒下的不算：抽的時候只從活著的人裡面抽
  const m = make(3);
  m.players.forEach((p, i) => placeOn(m, p, [80, 300, 500][i]));
  m.byId('p2').die('hit');
  let pool = null;
  const pick = m.rng.pick;
  m.rng.pick = (arr) => { pool = arr.map(e => e.id); return pick.call(m.rng, arr); };
  m.mechState.next = null;
  base(() => planGuardianNext(m), only('leap'));
  assert(J(pool) === J(['p1', 'p3']) && m.mechState.next.targetId !== 'p2', 'alive only: ' + J(pool));
  return { picked: [...picked] };
}));

await test('躍擊 + 橫劈：一回合兩招（leap → slash，各帶 cast）；落地震波打警示範圍裡的人（照距離 50 → 70，×0.7），接著橫劈打 slashBand 裡的人 30（×0.7）+ 5 層流血、每人一次；範圍外的沒事；客戶端兩招照順序重播一致', () => base(() => {
  const m = make(4);
  const g = m.byId('guardian');
  const [p1, p2, p3, p4] = m.players;
  placeOn(m, p1, 300);
  const plan = planLeapOn(m, 'p1');
  assert(plan.action === 'leap' && plan.targetId === 'p1' && Math.abs(plan.x - p1.x) <= 2, 'locked onto p1: ' + J(plan));
  const band = leapBand(plan);
  const sband = slashBand(plan.x, plan.y - g.h / 2);
  assert(sband.x1 - plan.x === 90 && plan.x - sband.x0 === 90 && sband.top === plan.y - g.h / 2 - 20, 'slash band ' + J(sband));
  placeOn(m, p2, band.x1 + p2.hw - 4);     // 身體還碰到震波的範圍（被震開之後還在橫劈的範圍裡）
  placeOn(m, p3, sband.x0 - p3.hw + 4);    // 震波範圍外、橫劈範圍裡（另一邊）
  placeOn(m, p4, sband.x1 + p4.hw + 6);    // 都在範圍外
  const x0 = g.x, y0 = g.y;
  const d = Math.hypot(plan.x - x0, plan.y - y0);
  const t = guardTurn(m);
  assert(J(t.steps.map(st => [st.action, st.cast])) === J([['leap', 1.4], ['slash', 0.5]]), 'two steps ' + J(t.steps.map(lean)));
  const [lp, sl] = t.steps;
  assert(lp.x === plan.x && lp.y === plan.y && lp.x0 === x0 && lp.y0 === y0, 'leap step ' + J(lean(lp)));
  const want = dmgOf(m, 'guardianLeap', d);
  const ld = ['p1', 'p2', 'p3', 'p4'].map(id => t.dmgIn('leap', id));
  assert(J(ld) === J([want, want, 0, 0]), `leap hits in the band: ${J(ld)} (want ${want})`);
  const sw = flat(m, 'guardianSlash');
  const sd = ['p1', 'p2', 'p3', 'p4'].map(id => t.dmgIn('slash', id));
  assert(sw === 21 && J(sd) === J([sw, sw, sw, 0]), `slash hits in its band: ${J(sd)} (want ${sw})`);
  const slashHits = t.entries(sl).filter(e => e.dmg > 0);
  assert(slashHits.length === 3 && new Set(slashHits.map(e => e.id)).size === 3 && slashHits.every(e => e.bleed === 5), 'each hit once, 5 bleed: ' + J(slashHits));
  assert(!t.entries(sl).some(e => e.id === 'guardian') && !t.entries(lp).some(e => e.id === 'guardian'), 'never hits himself');
  assert(J(m.players.map(p => p.bleed)) === J([5, 5, 5, 0]), 'bleed stacks ' + J(m.players.map(p => p.bleed)));
  assert(sl.shot.weapon === 'guardianSlash' && sl.shot.projectiles.length === 2 && sl.shot.projectiles.every(s => s.x === plan.x && s.y === plan.y - g.h / 2), 'two waves from his body centre');
  assert(g.x === plan.x && standing(m, g) && lp.shot.facing === sl.shot.facing, `landed on the spot: ${g.x},${g.y}`);
  // 前一招的校正是它自己結算完的樣子（還沒被橫劈打到）：客戶端播橫劈之前先套這一份
  const before = lp.shot.results.find(s => s.id === 'p3');
  assert(before.hp === p3.maxHp && !before.bl, 'leap results are from before the slash: ' + J(before));
  return { leap: want, slash: sw, dist: Math.round(d) };
}));

await test('橫劈：往兩邊的兩道共用「打過誰」——站在他正中間（兩道都碰得到）的人只挨一次', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 300);
  const plan = planLeapOn(m, 'p1');
  p.shield = 1;   // 落地的震波被無敵擋掉（不會被震開），人還站在落地點正中間
  const t = guardTurn(m);
  const [lp, sl] = t.steps;
  assert(t.entries(lp).some(e => e.id === 'p1' && e.blocked) && Math.abs(p.x - plan.x) < 3, 'leap blocked, still at the centre');
  const hits = t.entries(sl).filter(e => e.id === 'p1');
  assert(hits.length === 1 && hits[0].dmg === flat(m, 'guardianSlash') && p.bleed === 5, 'hit once: ' + J(hits));
  return { hits: hits.length };
}));

// （同一道橫劈先穿過別人的話會多飛一小步（穿透的那一個子步不算進路徑長度，跟盾擊、其他穿透的招式一樣），所以鎖定的人先走開，兩邊各只有一個人）
await test('橫劈範圍（slashBand，畫面照它畫）：兩邊都是身體碰到範圍就被打到、差一點就沒事', () => base(() => {
  const out = {};
  for (const [inside, off] of [[true, 3], [false, -3]]) {
    const m = make(3);
    const g = m.byId('guardian');
    const [p1, p2, p3] = m.players;
    placeOn(m, p1, 400);
    const plan = planLeapOn(m, 'p1');
    placeOn(m, p1, 750);   // 鎖定的人走開
    const band = slashBand(plan.x, plan.y - g.h / 2);
    placeOn(m, p2, band.x1 + p2.hw - off);
    placeOn(m, p3, band.x0 - p3.hw + off);
    const t = guardTurn(m);
    assert(t.dmgIn('leap', 'p2') === 0 && t.dmgIn('leap', 'p3') === 0, 'outside the landing shockwave');
    for (const id of ['p2', 'p3']) assert((t.dmgIn('slash', id) > 0) === inside, `${id} ${inside ? 'inside' : 'outside'} by 3px → ${t.dmgIn('slash', id)}`);
    out[inside ? 'in' : 'out'] = [t.dmgIn('slash', 'p2'), t.dmgIn('slash', 'p3')];
  }
  return out;
}));

await test('躍擊：警示出來之後走開就躲得掉（他照樣跳到預定的地方、橫劈也揮空）；落地點被炸成坑 → 落到坑底，坑裡的人照樣被打到', () => base(() => {
  const m = make(2);
  const g = m.byId('guardian');
  const [p1, p2] = m.players;
  placeOn(m, p1, 60);
  placeOn(m, p2, 400);
  const plan = planLeapOn(m, 'p1');
  placeOn(m, p1, 200);   // 走開
  const t = guardTurn(m);
  assert(t.steps.length === 2 && t.dmg('p1') === 0 && t.dmg('p2') === 0 && g.x === plan.x && p1.bleed === 0, 'dodged; he still landed on the plan');
  // 坑（挖得動的地形）
  const m2 = makeSoft(1);
  const g2 = m2.byId('guardian'), q = m2.players[0];
  placeOn(m2, q, 120);
  const plan2 = planLeapOn(m2, 'p1');
  m2.terrain.carve(plan2.x, plan2.y + 4, 36);
  placeOn(m2, q, plan2.x);
  const t2 = guardTurn(m2);
  assert(t2.st.y > plan2.y + 10 && standing(m2, g2) && t2.dmgIn('leap', 'p1') > 0, `landed in the pit: ${t2.st.y} (plan ${plan2.y}), hit ${t2.dmgIn('leap', 'p1')}`);
  return { pit: t2.st.y };
}));

await test('躍擊：落地震波把最後一個人打倒 → 不接橫劈（一招）；找不到落地點的躍擊改成衝鋒（標記最遠的人）', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 300);
  planLeapOn(m, 'p1');
  p.hp = 1;
  const t = guardTurn(m);
  assert(!p.alive && J(t.steps.map(st => st.action)) === J(['leap']), 'no slash when nobody is left: ' + J(t.steps.map(st => st.action)));
  // 落地點站不下（整片挖掉、沒有地方站）：改衝鋒
  const m2 = make(2);
  m2.players.forEach((q, i) => placeOn(m2, q, [100, 400][i]));
  const pick = m2.rng.pick;
  m2.rng.pick = () => ({ x: -500, y: -500, id: 'nobody' });   // 抽到的人站在畫面上方很遠（附近都站不下守衛）
  m2.mechState.next = null;
  base(() => planGuardianNext(m2), only('leap'));
  m2.rng.pick = pick;
  assert(J(m2.mechState.next) === J({ action: 'charge', targetId: 'p1' }), 'fallback charge marks the farthest: ' + J(m2.mechState.next));
}));

// ---------------- 同步 ----------------

await test('快照：預定的下一招（guardianNext，含衝鋒標記的人）重建得回來；別的地圖不帶這個欄位', () => base(() => {
  const m = make(2);
  for (const plan of [{ action: 'leap', x: 90, y: 577, targetId: 'p1' }, { action: 'shield', facing: 1 }, { action: 'charge', targetId: 'p2' }, { action: 'charge' }]) {
    m.mechState.next = plan;
    const snap = JSON.parse(J(m.snapshot()));
    assert(J(snap.guardianNext) === J(plan), 'snapshot ' + J(snap.guardianNext));
    const c = make(2, { seed: 99 });
    c.applySnapshot(snap);
    assert(J(c.mechState.next) === J(plan) && J(c.snapshot()) === J(snap), 'restored ' + J(c.mechState.next));
  }
  const other = new Match({ levelId: 'depths', players: mkPlayers(1), seed: 1 });
  assert(!('guardianNext' in other.snapshot()), 'only this map');
}));

// ---------------- 裁判 ----------------

await test('裁判：全員 AI 代打打幾輪；守衛每回合一招（衝鋒 / 盾擊），躍擊的回合兩招（躍擊 → 橫劈）；廣播帶 cast 與預定的下一招，紀錄 ai.turn 帶每一招、next 與 nextTarget', () => base(() => {
  const out = {};
  const seen = new Set();
  for (const seed of [1, 2, 3, 4]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'forestGuard', players, seed, stage: 3 });
    for (const p of m.players) { p.hp = p.maxHp = 4000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 3, stageCount: 10, isBoss: false, type: 'elite', levelId: 'forestGuard', levelName: '大樹守衛', cards: {} } });
    ref.start();
    for (const p of players) ref.setConnected(p.id, false);
    for (let k = 0; k < 400 && ref.phase !== 'over'; k++) io.advance(500);
    const turns = io.log.filter(x => x.t === 'aiTurn' && x.actorId === 'guardian');
    assert(turns.length >= 5, `seed ${seed}: guardian turns ${turns.length}`);
    for (const t of turns) {
      const steps = t.boss.steps;
      const acts = steps.map(st => st.action);
      const ok = J(acts) === J(['leap', 'slash']) || (steps.length === 1 && ['charge', 'bash'].includes(acts[0]));
      assert(ok && steps.every(st => st.cast > 0 && st.shot), 'steps ' + J(steps.map(lean)));
      const next = t.boss.next;
      assert(next && ['charge', 'shield', 'leap'].includes(next.action), 'next ' + J(next));
      if (next.action !== 'shield') assert(players.some(p => p.id === next.targetId), 'next carries the target ' + J(next));
      acts.forEach(a => seen.add(a));
    }
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.actor === 'guardian');
    assert(recs.length === turns.length && recs.every((r, i) => J(r.boss.map(b => b.action)) === J(turns[i].boss.steps.map(st => st.action)) && r.next === turns[i].boss.next.action), 'logged');
    assert(recs.every((r, i) => r.nextTarget === turns[i].boss.next.targetId), 'nextTarget logged');
    assert(recs.flatMap(r => r.boss).filter(b => b.action !== 'bash').every(b => Number.isFinite(b.dmg)), 'charge / leap / slash log dmg');
    assert(recs.flatMap(r => r.boss).filter(b => b.action === 'charge' || b.action === 'leap').every(b => Number.isFinite(b.dist)), 'charge / leap log dist');
    out[seed] = turns.map(t => t.boss.steps.map(st => st.action[0]).join('')).join(' ');
  }
  assert(['charge', 'bash', 'leap', 'slash'].every(a => seen.has(a)), 'all moves: ' + [...seen]);
  return out;
}));

await test('裁判：開場就抽好的第一招記在 battle.start（next / nextTarget，同 ai.turn）；被標記的人在守衛出手前倒下、改衝別人時，紀錄也查得到原本標記的是誰', () => base(() => {
  const out = {};
  for (const action of ['charge', 'leap', 'shield']) {
    const players = mkPlayers(2);
    const m = base(() => new Match({ levelId: 'forestGuard', players, seed: 1, stage: 3 }), only(action));
    const plan = m.mechState.next;
    assert(plan && plan.action === action && (action === 'shield' || players.some(p => p.id === plan.targetId)), 'opening plan ' + J(plan));
    const io = new FakeIo();
    new Referee({ match: m, humans: players, io }).start();
    const bs = io.records.find(r => r.ev === 'battle.start');
    assert(bs.next === action && bs.nextTarget === plan.targetId && !('nextLedge' in bs) && !('nextSeal' in bs), `battle.start logs the opening ${action}: ` + J({ next: bs.next, nextTarget: bs.nextTarget }));
    assert(action !== 'shield' || !('nextTarget' in bs), 'a raised shield marks nobody');
    out[action] = bs.nextTarget ?? null;
  }
  // 衝鋒標記的人倒下了：守衛改衝另一個人（ai.turn 的 targetId），battle.start 還記著原本標記的那個
  const players = mkPlayers(2);
  const m = base(() => new Match({ levelId: 'forestGuard', players, seed: 1, stage: 3 }), only('charge'));
  const marked = m.mechState.next.targetId;
  const other = players.find(p => p.id !== marked).id;
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  m.byId(marked).die('hit');
  base(() => ref.runAiTurn(m.byId('guardian')), only('charge'));
  const rec = io.records.find(r => r.ev === 'ai.turn' && r.actor === 'guardian');
  assert(rec && rec.boss[0].action === 'charge' && rec.boss[0].targetId === other, 'charged the other one: ' + J(rec && rec.boss));
  assert(io.records.find(r => r.ev === 'battle.start').nextTarget === marked, 'battle.start still names the marked one');
  return { ...out, marked, charged: other };
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

// 記下畫了什麼（fillRect / arc / strokeRect 的參數，四捨五入）
function spyCtx() {
  const calls = { fillRect: [], arc: [], strokeRect: [], rotate: [], translate: [], lineTo: [], scale: [] };
  const inner = fakeCtx2d();
  const fine = (k) => k === 'rotate' || k === 'translate';   // 角度、位移記到小數兩位，其他四捨五入
  const ctx = new Proxy(inner, { get: (t, k) => (k in calls ? (...a) => calls[k].push(a.map(v => (fine(k) ? Math.round(v * 100) / 100 : Math.round(v)))) : t[k]) });
  return { ctx, calls };
}

await test('真的 GameView：大樹守衛從開場播到衝鋒、盾擊、躍擊 + 橫劈（全員 AI 代打；每幀 update + render）：衝鋒的標記與路線、HUD 的目標名字、躍擊警示（不含橫劈範圍）、橫劈的橫幅與刀光（沒有範圍框）、下一招跟伺服器一樣、跳在空中 / 衝出去時角色不畫、菁英關橫幅與音樂', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'forestGuard', players, seed: 5, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 5000; }
  m.mechState.next = null;
  base(() => planGuardianNext(m), only('leap'));
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 3, stageCount: 10, isBoss: false, type: 'elite', levelId: 'forestGuard', levelName: '大樹守衛', cards: {} } });
  ref.start();
  const view = new GameView(fakeCanvas());
  const tracks = [];
  view.music = { play(t) { tracks.push(t); }, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  assert(view.mapView.type === 'guardian' && view.banner && view.banner.text === '菁英關：大樹守衛', 'elite banner: ' + J(view.banner && view.banner.text));
  assert(J(view.match.mechState.next) === J(m.mechState.next) && view.match.mechState.next.action === 'leap', 'client has the leap plan');
  const vg = view.match.byId('guardian');
  // 玩家回合：落地範圍畫在預定的地方；落地後橫劈的範圍不畫（2026-10-19 取消橫劈的提示範圍）
  const leapPlan = m.mechState.next;
  const band = leapBand(leapPlan);
  const sband = slashBand(leapPlan.x, leapPlan.y - vg.h / 2);
  let s = spyCtx();
  view.mapView.drawScene(s.ctx, view.mapCtx);
  assert(s.calls.fillRect.some(r => r[0] === Math.round(band.x0) && r[2] === Math.round(band.x1 - band.x0)), 'leap band drawn at the plan');
  const outlines = (calls, band) => calls.strokeRect.some(r => Math.abs(r[0] - (band.x0 + 0.5)) < 1 && Math.abs(r[2] - (band.x1 - band.x0 - 1)) < 1);
  assert(!outlines(s.calls, sband) && !s.calls.strokeRect.length, 'no slash reach with the leap warning: ' + J(s.calls.strokeRect));
  let hud = view.mapView.hud(view.mapCtx, ['x', '#fff']);
  // 血量、下一招各一行（接在同一行會超出右上的名單框），顏色一樣
  assert(hud.length === 3 && /^大樹守衛 \d+ \/ \d+$/.test(hud[1][0]) && hud[2][0] === '下一招：躍擊' && hud[1][1] === hud[2][1], 'hud ' + J(hud));
  // 預定衝鋒：目標身上的準星（圓心在他身體中間）、守衛到他那一行的路線；HUD 帶他的名字
  const chargeMarked = () => {
    const S = view.match.mechState;
    const t = chargeTarget(view.match, vg, S.next);
    const lane = chargeLane(vg, t);
    const r = Math.max(t.h, 2 * t.hw) * 0.75 + 6;
    const sp = spyCtx();
    view.mapView.drawScene(sp.ctx, view.mapCtx);
    const ring = sp.calls.arc.some(a => a[0] === Math.round(t.x) && a[1] === Math.round(t.cy) && a[2] === Math.round(r));
    const laneDrawn = sp.calls.fillRect.some(f => f[0] === Math.round(lane.x0) && f[1] === Math.round(lane.top) && f[2] === Math.round(lane.x1 - lane.x0));
    const h = view.mapView.hud(view.mapCtx, ['x', '#fff']);
    return ring && laneDrawn && h[2][0] === `下一招：衝鋒 → ${t.name}` ? t.id : null;
  };
  const saved = view.match.mechState.next;
  view.match.mechState.next = { action: 'charge', targetId: 'p2' };
  assert(chargeMarked() === 'p2', 'charge mark on p2');
  view.match.byId('p2').alive = false;   // 被標記的人倒下了：標記改到現在最遠的人身上（同伺服器的 chargeTarget）
  assert(chargeMarked() === 'p1', 'charge mark falls back to p1');
  view.match.byId('p2').alive = true;
  view.match.mechState.next = saved;
  s = spyCtx();
  view.mapView.drawScene(s.ctx, view.mapCtx);
  assert(!s.calls.arc.length, 'no charge mark while the plan is a leap');
  for (const p of players) ref.setConnected(p.id, false);
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Set();
  let hiddenAir = false, hiddenRun = false, slashCast = false, slashDrawn = false, slashBanner = false, slashZone = false, syncedMark = null;
  try {
    for (let k = 0; k < 900 && ref.phase !== 'over'; k++) {
      io.advance(250);
      for (const t of io.log.filter(x => x.t === 'aiTurn' && x.actorId === 'guardian')) t.boss.steps.forEach(st => seen.add(st.action));
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        const fx = view.mapCtx.state.fx;
        if (fx && fx.action === 'leap' && fx.phase === 'cast' && fx.t > 0.5 && view.mapView.drawEntityBare(fakeCtx2d(), view.mapCtx, vg)) hiddenAir = true;
        if (view.mapCtx.state.running && view.mapView.drawEntityBare(fakeCtx2d(), view.mapCtx, vg)) hiddenRun = true;
        if (fx && fx.action === 'slash' && fx.phase === 'cast') {
          slashCast = true;
          if (view.banner && view.banner.text === '大樹守衛：橫劈！') slashBanner = true;
          const sp = spyCtx();
          view.mapView.drawScene(sp.ctx, view.mapCtx);
          if (outlines(sp.calls, slashBand(vg.x, vg.cy)) || sp.calls.strokeRect.length) slashZone = true;
        }
        for (const p of view.mapCtx.projectiles) {
          if (p.weapon.id !== 'guardianSlash') continue;
          const sp = spyCtx();
          if (view.mapView.drawProjectile(sp.ctx, view.mapCtx, p) && sp.calls.arc.length === 2) slashDrawn = true;
        }
        // 伺服器抽到的衝鋒（玩家回合）：客戶端的標記畫在伺服器標記的人身上
        const next = view.match.mechState.next;
        if (!fx && next && next.action === 'charge' && next.targetId && J(next) === J(m.mechState.next) && view.match.byId(next.targetId).alive) {
          if (chargeMarked() === next.targetId) syncedMark = next.targetId;
        }
      }
      if (['charge', 'bash', 'leap', 'slash'].every(a => seen.has(a)) && hiddenRun && slashDrawn && syncedMark) break;
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(['charge', 'bash', 'leap', 'slash'].every(a => seen.has(a)), 'played all moves: ' + [...seen]);
  assert(hiddenAir && hiddenRun, `hidden while airborne ${hiddenAir} / running ${hiddenRun}`);
  assert(slashCast && slashBanner && slashDrawn, `slash played: cast ${slashCast} / banner ${slashBanner} / drawn ${slashDrawn}`);
  assert(!slashZone, 'no slash range drawn while he winds up the slash');
  assert(syncedMark, 'charge mark drawn on the server-marked player');
  assert(J(view.match.mechState.next) === J(m.mechState.next), 'next synced: ' + J([view.match.mechState.next, m.mechState.next]));
  const sg = m.byId('guardian');
  assert(Math.abs(vg.x - sg.x) < 0.01 && Math.abs(vg.y - sg.y) < 0.01 && vg.facing === sg.facing && vg.hp === sg.hp, `guardian synced: ${J([vg.x, vg.y, vg.facing, vg.hp])} vs ${J([sg.x, sg.y, sg.facing, sg.hp])}`);
  assert(view.match.players.every(p => p.bleed === m.byId(p.id).bleed && p.hp === m.byId(p.id).hp), 'players synced (hp, bleed): ' + J(view.match.players.map(p => [p.hp, p.bleed, m.byId(p.id).hp, m.byId(p.id).bleed])));
  assert(tracks.filter(Boolean).every(t => t === 'normal' || t === 'fever') && tracks.includes('normal'), 'elite plays the normal music: ' + [...new Set(tracks)]);
  return { actions: [...seen], marked: syncedMark, time: Math.round(view.time) };
}));

await test('起手動作（2026-10-19）：一抽到衝鋒就人立（往後仰、前腳抬起、面向要衝的人），整個玩家回合維持著；輪到他時停一下 → 前腳踏地（畫面一震、踏地聲）→ 壓低身子刨地；一抽到躍擊就深蹲（腿彎、身體下沉、面向落地點），整個玩家回合蹲著；輪到他時蹲著發抖、起跳', () => base(() => {
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'forestGuard', players, seed: 5, stage: 3 });
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 3, stageCount: 10, isBoss: false, type: 'elite', levelId: 'forestGuard', levelName: '大樹守衛', cards: {} } });
  ref.start();
  for (const msg of io.log.splice(0)) view.onMessage(msg);
  const c = view.mapCtx, g = view.match.byId('guardian');
  const at = (action, k, cast) => { c.state.fx = { action, t: k * cast, phase: 'cast', targetId: 'p1', step: { action, x0: g.x, y0: g.y, x: g.x - 300, y: g.y }, cast }; };
  const draw = () => { const sp = spyCtx(); view.mapView.drawEntity(sp.ctx, c, g, false); return sp.calls; };
  const tilt = (calls) => calls.rotate[0][0];   // 第一次轉 = 人立往後仰（沒人立就是往前傾 lean）
  const out = {};
  const sounds = [];
  let shook = 0;
  c.fx = { ...c.fx, sound: (n) => sounds.push(n), shake: (a) => { shook = Math.max(shook, a); }, banner() {}, particles() {}, particle() {} };
  const S = view.match.mechState;
  const tick = (secs) => { for (let i = 0; i < Math.round(secs * 60); i++) view.mapView.update(c, CONFIG.FIXED_DT); };
  // 預定舉盾：不人立
  c.state.fx = null;
  S.next = { action: 'shield', facing: -1 };
  tick(0.5);
  assert(c.state.rear === 0 && tilt(draw()) > -0.05 && !sounds.length, 'no rearing while the plan is a shield');
  // 一抽到衝鋒：REAR_RISE 秒內抬到最高（抬起來那一下出聲一次），之後一直人立著；面向要衝的人（就算在他背後）
  S.next = { action: 'charge', targetId: 'p1' };
  tick(0.1);
  const rising = tilt(draw());
  tick(3);
  const held = draw();
  assert(c.state.rear === 1 && rising < 0 && rising > -0.45 && tilt(held) <= -0.45 && held.rotate.some(r => r[0] < -1.4), `rears up when the charge is planned: ${rising} → ${tilt(held)}`);
  assert(J(sounds) === J(['heave']), 'one heave when he rears up: ' + J(sounds));
  const p1 = view.match.byId('p1');
  const px = p1.x;
  assert(draw().scale[0][0] === -1, 'faces p1 on his left');
  p1.x = g.x + 30;
  assert(draw().scale[0][0] === 1, 'turns to face the marked player behind him');
  p1.x = px;
  // 輪到他（腳本開始出招）：已經人立著就不再抬一次，停一下 → 踏地 → 往前傾刨地（照 config 的 cast；時間點是幾成）
  const cc = CONFIG.GUARDIAN.cast.charge;
  const castAt = (k, rear0) => { at('charge', k, cc); c.state.fx.rear0 = rear0; return draw(); };
  const start = tilt(castAt(0.02, 1)), hold = tilt(castAt(0.3, 1)), stomp = tilt(castAt(0.43, 1)), paw = castAt(0.9, 1);
  assert(start === -0.5 && hold === -0.5 && stomp > -0.5 && stomp < 0 && tilt(paw) > 0.2, `holds, stomps, leans in: ${start} → ${hold} → ${stomp} → ${tilt(paw)}`);
  // 還沒人立就出招（例如剛重連）：出招的前一段才抬起來
  const late = tilt(castAt(0.02, 0));
  assert(late > -0.1 && late < 0 && tilt(castAt(0.3, 0)) < -0.45, 'rears up during the cast if he was not up yet: ' + late);
  out.rear = hold;
  // 躍擊：一抽到就蹲下去（腰以上往下沉 ~12 px、腿彎起來；蹲下去那一下出聲一次），整個玩家回合蹲著、面向落地點；預定別招就站起來
  const dropOf = (calls) => Math.max(0, ...calls.translate.filter(t => t[0] === 0).map(t => t[1]));
  const bare = () => view.mapView.drawEntityBare(fakeCtx2d(), c, g);
  c.state.fx = null;
  sounds.length = 0;
  S.next = { action: 'leap', x: g.x + 30, y: g.y, targetId: 'p1' };   // 落地點在他背後（右邊）
  tick(0.1);
  const sinking = dropOf(draw());
  tick(3);
  const crouched = draw();
  const drop = dropOf(crouched);
  assert(c.state.rear === 0 && c.state.squat === 1 && sinking > 0 && sinking < drop && drop >= 11 && crouched.lineTo.length >= 4 && !bare(),
    `squats when the leap is planned: ${sinking} → ${drop}, bent legs ${crouched.lineTo.length}`);
  assert(J(sounds) === J(['step']), 'one step when he squats: ' + J(sounds));
  assert(crouched.scale[0][0] === 1, 'faces the landing spot behind him');
  S.next = { action: 'leap', x: g.x - 300, y: g.y, targetId: 'p1' };
  assert(draw().scale[0][0] === -1, 'faces the landing spot on his left');
  S.next = { action: 'shield', facing: -1 };
  tick(0.05);
  assert(c.state.squat === 0 && dropOf(draw()) === 0, 'stands up when the plan changes');
  // 輪到他：已經蹲著就一直蹲著（不會先站起來再蹲），起跳前在地上、起跳後在空中；還沒蹲下（剛重連）的話起跳前才蹲下去
  const cl = CONFIG.GUARDIAN.cast.leap;
  const leapAt = (k, squat0) => { at('leap', k, cl); c.state.fx.squat0 = squat0; return draw(); };
  const kept = dropOf(leapAt(0.02, 1)), late0 = dropOf(leapAt(0.02, 0)), late1 = dropOf(leapAt(0.18, 0));
  assert(kept === 12 && late0 < 4 && late1 === 12 && !bare(), `cast from the held squat ${kept}; not crouched yet: ${late0} → ${late1}`);
  at('leap', 0.3, cl);
  assert(bare(), 'airborne after takeoff');
  out.squat = drop;
  // 腳本：已經擺好架勢（預定衝鋒 / 躍擊的玩家回合）→ 不再出擺架勢的聲音；腳本開始就交出架勢的程度（出招中不再推進 state.rear / squat）。
  // 衝鋒：踏地那一下畫面一震、踏地聲；躍擊：起跳的聲音
  const chargeStep = { action: 'charge', cast: cc, targetId: 'p1' };
  const leapStep = { action: 'leap', cast: cl, targetId: 'p1', x0: g.x, y0: g.y, x: g.x - 300, y: g.y };
  const runScript = (step) => {
    sounds.length = 0;
    shook = 0;
    const script = view.mapView.turnScript(c, { actorId: 'guardian', boss: { steps: [step] } });
    let got = null;
    for (let i = 0; i < 400; i++) {
      if (script.next().done) break;
      if (!got && c.state.fx) got = { rear0: c.state.fx.rear0, squat0: c.state.fx.squat0 };
      view.mapView.update(c, CONFIG.FIXED_DT);
    }
    c.state.fx = null;
    return got;
  };
  c.state.fx = null;
  S.next = { action: 'charge', targetId: 'p1' };
  tick(1);
  const r0 = runScript(chargeStep);
  assert(r0.rear0 === 1 && !sounds.includes('heave') && sounds.includes('stomp') && shook >= 6, 'stomp from the held rear: ' + J({ r0, sounds, shook }));
  c.state.rear = 0;
  S.next = { action: 'shield', facing: -1 };
  const r1 = runScript(chargeStep);
  assert(r1.rear0 === 0 && sounds[0] === 'heave' && sounds.includes('stomp'), 'rears up in the cast when he was not up: ' + J({ r1, sounds }));
  S.next = { action: 'leap', x: g.x - 300, y: g.y, targetId: 'p1' };
  tick(1);
  const l0 = runScript(leapStep);
  assert(l0.squat0 === 1 && J(sounds) === J(['heave']), 'takes off from the held squat (no second crouch sound): ' + J({ l0, sounds }));
  c.state.squat = 0;
  S.next = { action: 'shield', facing: -1 };
  const l1 = runScript(leapStep);
  assert(l1.squat0 === 0 && J(sounds) === J(['step', 'heave']), 'crouches in the cast when he was not down: ' + J({ l1, sounds }));
  ref.stop();
  return out;
}));

await test('菁英之路（2026-10-19）：大樹守衛的躍擊、衝鋒不畫提示範圍（警示光柱、衝鋒的路線與準星，玩家回合與出招時都不畫）；盾擊範圍、HUD 的下一招照舊；一般難度照畫', () => base(() => {
  const out = {};
  for (const difficulty of ['elite', 'normal']) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'forestGuard', players, seed: 5, stage: 3 });
    const view = new GameView(fakeCanvas());
    view.music = { play() {}, setRate() {} };
    view.myId = 'p1';
    view.transport = { send() {} };
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 3, stageCount: 10, isBoss: false, type: 'elite', difficulty, levelId: 'forestGuard', levelName: '大樹守衛', cards: {} } });
    ref.start();
    for (const msg of io.log.splice(0)) view.onMessage(msg);
    const c = view.mapCtx, g = view.match.byId('guardian'), S = view.match.mechState;
    const hints = difficulty !== 'elite';
    assert(c.rangeHints === hints, `${difficulty}: c.rangeHints ${c.rangeHints}`);
    const scene = () => { const sp = spyCtx(); view.mapView.drawScene(sp.ctx, c); return sp.calls; };
    const marks = (calls) => calls.fillRect.length + calls.arc.length;
    const p1 = view.match.byId('p1');
    S.next = { action: 'leap', x: p1.x, y: p1.y, targetId: 'p1' };
    const leapPlan = marks(scene());
    c.state.fx = { action: 'leap', t: 0.1, phase: 'cast', cast: 1.65, targetId: 'p1', step: { action: 'leap', x0: g.x, y0: g.y, x: p1.x, y: p1.y } };
    const leapCast = marks(scene());
    c.state.fx = null;
    S.next = { action: 'charge', targetId: 'p1' };
    const chargePlan = marks(scene());
    c.state.fx = { action: 'charge', t: 0.1, phase: 'cast', cast: 1, targetId: 'p1', step: { action: 'charge' } };
    const chargeCast = marks(scene());
    c.state.fx = null;
    S.next = { action: 'shield', facing: -1 };
    const bash = scene().strokeRect.length;
    const hud = view.mapView.hud(c, ['x', '#fff']);
    S.next = { action: 'charge', targetId: 'p1' };
    const hudCharge = view.mapView.hud(c, ['x', '#fff']);
    const counts = [leapPlan, leapCast, chargePlan, chargeCast];
    assert(hints ? counts.every(n => n > 0) : counts.every(n => n === 0), `${difficulty}: range hints ${J(counts)}`);
    assert(bash === 1 && hud[2][0] === `下一招：舉盾（減傷 ${CONFIG.GUARDIAN.shieldCut}%）` && hudCharge[2][0] === `下一招：衝鋒 → ${p1.name}`, `${difficulty}: bash zone / hud kept ${J([bash, hud[2], hudCharge[2]])}`);
    ref.stop();
    out[difficulty] = counts;
  }
  return out;
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
