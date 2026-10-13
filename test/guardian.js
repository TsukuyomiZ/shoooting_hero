// node test/guardian.js
// 2026-10-13：菁英關「大樹守衛」（森林）。地圖（菁英池、樹根坡走得上去一段、地底的樹根挖不穿、守衛站在樹前）、
// 守衛（有重力、血量照一般敵人放大、下一招事先抽好）、
// 衝鋒（打最近的人、撞到第一個人就停在他旁邊、傷害看距離 30 → 50、擊退、樹根坡擋得住、坑洞直接衝過去）、
// 舉盾（一抽到就舉起來、面向最近的人、受到的傷害 -30%、輪到他時盾擊盾牌前方範圍裡的人、背後 / 範圍外的不會被打到、出完盾放下）、
// 躍擊（抽到時鎖定最遠的人的位置、跳到那裡、警示範圍裡的人受傷、走開就躲得掉、傷害看距離 50 → 70、落地點被炸掉就落到坑底）、
// 客戶端照事件重播一致、快照重建、裁判流程與紀錄、真的 GameView 播一段（警示範圍、HUD、跳在空中 / 衝出去時角色不畫）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { HARD } from '../shared/physics/terrain.js';
import { strikeDamage, planGuardianNext, leapBand, bashBand, shieldUp, standY } from '../shared/maps/guardian.js';
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
  GUARDIAN: { hp: 200, weights: { charge: 40, shield: 30, leap: 30 }, near: 80, far: 560, shieldCut: 30, bashReach: 60, leapZone: 20, cast: { charge: 0.8, bash: 0.8, leap: 1.4 } },
  PLAYER: { hp: 150 }, WATER: { damagePct: 30, enemiesDrown: true }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180 },
    guardianCharge: { ...CONFIG.WEAPONS.guardianCharge, damage: 30, damageFar: 50, knockback: 120, speed: 760, hitRadius: 18 },
    guardianBash: { ...CONFIG.WEAPONS.guardianBash, damage: 45, knockback: 200, speed: 900, hitRadius: 16 },
    guardianLeap: { ...CONFIG.WEAPONS.guardianLeap, damage: 50, damageFar: 70, knockback: 160, speed: 900, hitRadius: 20 },
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
// 照預定的招式讓守衛出一招（不經過裁判），順便讓客戶端從出招前的快照照事件重播、套結果，跟伺服器一樣
function guardTurn(m, plan) {
  if (plan) m.mechState.next = plan;
  const before = JSON.parse(J(m.snapshot()));
  const g = m.byId('guardian');
  const r = m.planAiTurn(g).boss;
  const st = r.steps[0];
  if (st.shot) {
    const c = make(m.players.length, { seed: m.seed });
    c.applySnapshot(before);
    const shot = JSON.parse(J(st.shot));
    replayChecked(c, shot, st.action);
    c.applyEntities(shot.results);
    assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(c.terrain.mask)) === 0, `${st.action}: terrain differs`);
    assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${st.action}: entities differ`);
  }
  return { st, next: r.next, dmg: (id) => (st.shot ? st.shot.events.flatMap(ev => ev.damages || []).filter(d => d.id === id).reduce((s, d) => s + d.dmg, 0) : 0) };
}
const dmgOf = (m, weaponId, d) => Math.round(strikeDamage(CONFIG.WEAPONS[weaponId], d) * m.rules.enemyDamage);

// ---------------- 地圖 ----------------

await test('地圖：大樹守衛在菁英池（森林）、守衛排最後、有重力、不是首領、血量照一般敵人放大、站在樹前的地上；開場就抽好第一招', () => base(() => {
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
    assert(standing(m, g) && g.x < 536 && g.facing === -1, `stands in front of the tree: ${g.x},${g.y}`);
    assert(m.players.every(p => standing(m, p) && p.x < g.x), 'players on the ground to the left');
    assert(m.mechState.next && ['charge', 'shield', 'leap'].includes(m.mechState.next.action), 'first move planned: ' + J(m.mechState.next));
    out[n] = g.hp;
  }
  return out;
}));

await test('地形：樹根坡走得上去一段（到 y≈470），再上去太陡；地底的樹根炸不穿，坑最深到樹根，守衛 / 玩家掉進坑裡都不會落水', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 500);
  p.stamina = p.maxStamina = 99999;
  p.moveDir = 1;
  let top = p.y;
  for (let i = 0; i < 900; i++) { p.update(CONFIG.FIXED_DT, m.world); top = Math.min(top, p.y); }
  assert(top < 520 && top > 455 && p.x < 680, `climbed the roots to y ${top.toFixed(1)} (x ${p.x.toFixed(1)})`);
  // 同一個地方一直往下炸：挖到樹根就停
  for (let k = 0; k < 6; k++) m.terrain.carve(300, 590 + k * 15, 42);
  assert(m.terrain.at(300, 630) === HARD && m.terrain.at(300, 620) === 0, 'bedrock under the soil');
  const g = m.byId('guardian');
  placeOn(m, g, 300);
  placeOn(m, p, 330);
  assert(g.alive && p.alive && g.y <= 626 && p.y <= 626 && g.waterFalls === 0 && p.waterFalls === 0, `nobody drowns in the pit: ${g.y} ${p.y}`);
  return { rootTop: +top.toFixed(1), pit: g.y };
}));

// ---------------- 衝鋒 ----------------

await test('衝鋒：打最近的人、撞到就停在他旁邊（站在地上）；傷害照距離（30 → 50，再 ×0.7）、往前撞飛；別人沒事；客戶端重播一致', () => base(() => {
  const m = make(2);
  const g = m.byId('guardian');
  const [p1, p2] = m.players;
  placeOn(m, p1, 300);
  placeOn(m, p2, 60);
  const x1 = p1.x;
  const d = Math.hypot(p1.cx - g.cx, p1.cy - g.cy);
  const t = guardTurn(m, { action: 'charge' });
  assert(t.st.action === 'charge' && t.st.targetId === 'p1' && t.st.hit === 'p1', 'charged the nearest: ' + J({ ...t.st, shot: undefined }));
  assert(t.dmg('p1') === dmgOf(m, 'guardianCharge', d) && t.dmg('p2') === 0, `damage ${t.dmg('p1')} vs ${dmgOf(m, 'guardianCharge', d)}`);
  assert(p1.x < x1 - 10, 'knocked away from him');
  assert(Math.abs(g.x - (x1 + p1.hw + g.hw)) <= 3 && standing(m, g) && g.facing === -1, `stopped next to where p1 stood: ${g.x} (p1 was at ${x1})`);
  return { dmg: t.dmg('p1'), dist: Math.round(d), stop: Math.round(g.x) };
}));

await test('衝鋒 / 躍擊的傷害照距離：near 以內最低、far 以上最高、中間照比例', () => base(() => {
  const C = CONFIG.WEAPONS.guardianCharge, L = CONFIG.WEAPONS.guardianLeap;
  const vals = [0, 80, 320, 560, 900].map(d => [strikeDamage(C, d), strikeDamage(L, d)]);
  assert(J(vals) === J([[30, 50], [30, 50], [40, 60], [50, 70], [50, 70]]), 'scale ' + J(vals));
  // 真的出招：貼著的（near 以內）30 × 0.7；far 調小之後遠的 50 × 0.7
  const m = make(1);
  const g = m.byId('guardian'), p = m.players[0];
  placeOn(m, p, g.x - 50);
  const near = guardTurn(m, { action: 'charge' }).dmg('p1');
  assert(near === Math.round(30 * 0.7), 'near ' + near);
  return base(() => {
    const m2 = make(1);
    placeOn(m2, m2.players[0], 60);
    const far = guardTurn(m2, { action: 'charge' }).dmg('p1');
    assert(far === Math.round(50 * 0.7), 'far ' + far);
    return { vals, near, far };
  }, { GUARDIAN: { near: 80, far: 300 } });
}));

await test('衝鋒：目標站在樹根坡高處 → 撞到樹根停下（打不到）；中間有坑 → 直接衝過去、停在地上', () => base(() => {
  const m = make(2);
  const g = m.byId('guardian');
  const [p1, p2] = m.players;
  placeOn(m, p1, 650, 400);   // 樹根坡高處
  placeOn(m, p2, 20);
  assert(p1.y < 520, 'p1 up on the roots: ' + p1.y);
  const hp = p1.hp;
  const t = guardTurn(m, { action: 'charge' });
  assert(t.st.targetId === 'p1' && !t.st.hit && p1.hp === hp, 'blocked by the roots');
  assert(g.x > 470 && g.x < 560 && standing(m, g), 'stopped at the foot of the roots: ' + g.x);
  // 坑：守衛跟目標中間挖一個坑，照樣衝過去撞到
  const m2 = make(1);
  const g2 = m2.byId('guardian'), q = m2.players[0];
  placeOn(m2, q, 200);
  m2.terrain.carve(340, 590, 40);
  const t2 = guardTurn(m2, { action: 'charge' });
  assert(t2.st.hit === 'p1' && standing(m2, g2) && Math.abs(g2.x - (200 + q.hw + g2.hw)) <= 3, 'charged across the pit: ' + g2.x);
  return { blockedAt: Math.round(g.x), acrossPit: Math.round(g2.x) };
}));

// ---------------- 舉盾 ----------------

await test('舉盾：一抽到就面向最近的人舉起來，舉著時受到的傷害 ×0.7；輪到他盾擊盾牌前方的人（背後、範圍外的沒事）、往前推；出完盾放下', () => base(() => {
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
  assert(t.st.action === 'bash' && t.st.facing === -1, 'bash step');
  assert(t.dmg('p1') === Math.round(45 * 0.7) && t.dmg('p2') === 0 && t.dmg('p3') === 0, `bash hits only the one in front: ${t.dmg('p1')} / ${t.dmg('p2')} / ${t.dmg('p3')}`);
  assert(p1.x < x1 - 10, 'pushed forward');
  assert(J(t.next) === '{"action":"charge"}' && !shieldUp(m), 'shield lowered');
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

// ---------------- 躍擊 ----------------

await test('躍擊：抽到時鎖定最遠的人站的地方；輪到他跳過去，警示範圍（leapBand）裡的人受傷（照距離 50 → 70，×0.7）、範圍外的沒事；停在落地點', () => base(() => {
  const m = make(3);
  const g = m.byId('guardian');
  const [p1, p2, p3] = m.players;
  placeOn(m, p1, 80);
  placeOn(m, p2, 300);
  placeOn(m, p3, 380);
  m.mechState.next = null;
  base(() => planGuardianNext(m), only('leap'));
  const plan = m.mechState.next;
  assert(plan.action === 'leap' && plan.targetId === 'p1' && Math.abs(plan.x - p1.x) <= 2, 'locked onto the farthest: ' + J(plan));
  const band = leapBand(plan);
  placeOn(m, p2, band.x1 + p2.hw - 4);    // 身體還碰到範圍
  placeOn(m, p3, band.x1 + p3.hw + 6);    // 範圍外
  const x0 = g.x, y0 = g.y;
  const d = Math.hypot(plan.x - x0, plan.y - y0);
  const t = guardTurn(m);
  assert(t.st.action === 'leap' && t.st.x === plan.x && t.st.y === plan.y && t.st.x0 === x0 && t.st.y0 === y0, 'leap step ' + J({ ...t.st, shot: undefined }));
  const want = dmgOf(m, 'guardianLeap', d);
  assert(t.dmg('p1') === want && t.dmg('p2') === want && t.dmg('p3') === 0, `hits in the band: ${t.dmg('p1')} / ${t.dmg('p2')} / ${t.dmg('p3')} (want ${want})`);
  assert(g.x === plan.x && standing(m, g) && t.st.shot.facing === -1, `landed on the spot: ${g.x},${g.y} facing ${t.st.shot.facing}`);
  return { dmg: want, dist: Math.round(d) };
}));

await test('躍擊：警示出來之後走開就躲得掉（他照樣跳到預定的地方）；落地點被炸成坑 → 落到坑底，坑裡的人照樣被打到', () => base(() => {
  const m = make(2);
  const g = m.byId('guardian');
  const [p1, p2] = m.players;
  placeOn(m, p1, 60);
  placeOn(m, p2, 400);
  m.mechState.next = null;
  base(() => planGuardianNext(m), only('leap'));
  const plan = { ...m.mechState.next };
  placeOn(m, p1, 200);   // 走開
  const t = guardTurn(m);
  assert(t.dmg('p1') === 0 && t.dmg('p2') === 0 && g.x === plan.x, 'dodged; he still landed on the plan');
  // 坑
  const m2 = make(1);
  const g2 = m2.byId('guardian'), q = m2.players[0];
  placeOn(m2, q, 120);
  m2.mechState.next = null;
  base(() => planGuardianNext(m2), only('leap'));
  const plan2 = { ...m2.mechState.next };
  m2.terrain.carve(plan2.x, plan2.y + 4, 36);
  placeOn(m2, q, plan2.x);
  const t2 = guardTurn(m2);
  assert(t2.st.y > plan2.y + 10 && standing(m2, g2) && t2.dmg('p1') > 0, `landed in the pit: ${t2.st.y} (plan ${plan2.y}), hit ${t2.dmg('p1')}`);
  return { pit: t2.st.y };
}));

await test('躍擊：跳上樹根坡上的人（落地點找守衛站得下的地方）', () => base(() => {
  const m = make(1);
  const g = m.byId('guardian'), p = m.players[0];
  placeOn(m, p, 630, 400);
  placeOn(m, g, 100);
  m.mechState.next = null;
  base(() => planGuardianNext(m), only('leap'));
  const plan = m.mechState.next;
  assert(plan.action === 'leap' && standY(m, g, plan.x, plan.y) === plan.y && Math.abs(plan.x - p.x) <= 60, 'spot on the roots: ' + J(plan));
  const t = guardTurn(m);
  assert(t.dmg('p1') > 0 && standing(m, g) && g.y < 560, `hit on the roots ${t.dmg('p1')}, landed at ${g.x},${g.y} standing ${standing(m, g)}`);
  return { spot: [plan.x, plan.y] };
}));

// ---------------- 同步 ----------------

await test('快照：預定的下一招（guardianNext）重建得回來；別的地圖不帶這個欄位', () => base(() => {
  const m = make(2);
  for (const plan of [{ action: 'leap', x: 90, y: 577, targetId: 'p1' }, { action: 'shield', facing: 1 }, { action: 'charge' }]) {
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

await test('裁判：全員 AI 代打打幾輪；守衛每回合一招（衝鋒 / 盾擊 / 躍擊），廣播帶 cast 與預定的下一招，紀錄 ai.turn 帶招式與 next', () => base(() => {
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
      const st = t.boss.steps[0];
      assert(t.boss.steps.length === 1 && ['charge', 'bash', 'leap'].includes(st.action) && st.cast > 0, 'step ' + J({ ...st, shot: undefined, still: undefined }));
      assert(t.boss.next && ['charge', 'shield', 'leap'].includes(t.boss.next.action), 'next ' + J(t.boss.next));
      seen.add(st.action);
    }
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.actor === 'guardian');
    assert(recs.length === turns.length && recs.every((r, i) => r.boss[0].action === turns[i].boss.steps[0].action && r.next === turns[i].boss.next.action), 'logged');
    assert(recs.filter(r => r.boss[0].action !== 'bash').every(r => Number.isFinite(r.boss[0].dmg) && Number.isFinite(r.boss[0].dist)), 'charge / leap log dmg & dist');
    out[seed] = turns.map(t => t.boss.steps[0].action[0]).join('');
  }
  assert(['charge', 'bash', 'leap'].every(a => seen.has(a)), 'all three moves: ' + [...seen]);
  return out;
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

await test('真的 GameView：大樹守衛從開場播到衝鋒、盾擊、躍擊（全員 AI 代打；每幀 update + render）：下一招跟伺服器一樣、跳在空中 / 衝出去時角色不畫、菁英關橫幅與音樂、HUD', () => base(() => {
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
  // 玩家回合：落地範圍畫在預定的地方
  const fills = () => {
    const rects = [];
    const inner = fakeCtx2d();
    const ctx = new Proxy(inner, { get: (t, k) => (k === 'fillRect' ? (...a) => rects.push(a.map(Math.round)) : t[k]) });
    view.mapView.drawScene(ctx, view.mapCtx);
    return rects;
  };
  const band = leapBand(m.mechState.next);
  assert(fills().some(r => r[0] === Math.round(band.x0) && r[2] === Math.round(band.x1 - band.x0)), 'leap band drawn at the plan');
  const hud = view.mapView.hud(view.mapCtx, ['x', '#fff']);
  assert(hud.length === 2 && /^大樹守衛 \d+ \/ \d+　下一招：躍擊$/.test(hud[1][0]), 'hud ' + J(hud));
  for (const p of players) ref.setConnected(p.id, false);
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Set();
  let hiddenAir = false, hiddenRun = false;
  const g = view.match.byId('guardian');
  try {
    for (let k = 0; k < 600 && ref.phase !== 'over'; k++) {
      io.advance(250);
      for (const t of io.log.filter(x => x.t === 'aiTurn' && x.actorId === 'guardian')) seen.add(t.boss.steps[0].action);
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        const fx = view.mapCtx.state.fx;
        if (fx && fx.action === 'leap' && fx.phase === 'cast' && fx.t > 0.5 && view.mapView.drawEntityBare(fakeCtx2d(), view.mapCtx, g)) hiddenAir = true;
        if (view.mapCtx.state.running && view.mapView.drawEntityBare(fakeCtx2d(), view.mapCtx, g)) hiddenRun = true;
      }
      if (['charge', 'bash', 'leap'].every(a => seen.has(a)) && hiddenRun) break;
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(['charge', 'bash', 'leap'].every(a => seen.has(a)), 'played all three: ' + [...seen]);
  assert(hiddenAir && hiddenRun, `hidden while airborne ${hiddenAir} / running ${hiddenRun}`);
  assert(J(view.match.mechState.next) === J(m.mechState.next), 'next synced: ' + J([view.match.mechState.next, m.mechState.next]));
  const sg = m.byId('guardian');
  assert(Math.abs(g.x - sg.x) < 0.01 && Math.abs(g.y - sg.y) < 0.01 && g.facing === sg.facing && g.hp === sg.hp, `guardian synced: ${J([g.x, g.y, g.facing, g.hp])} vs ${J([sg.x, sg.y, sg.facing, sg.hp])}`);
  assert(tracks.filter(Boolean).every(t => t === 'normal' || t === 'fever') && tracks.includes('normal'), 'elite plays the normal music: ' + [...new Set(tracks)]);
  return { actions: [...seen], time: Math.round(view.time) };
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
