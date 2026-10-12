// node test/cave.js
// 2026-10-08：新地圖「岩穴」（洞穴地形：鐘乳石、火把照明）、新敵人蝙蝠（聲波）、小心擊發的樹枝改成擋玩家的子彈。
// 地圖池與站位（蝙蝠飄在岩台上方、只有出生點的火把亮著）、蝙蝠（飄在空中、每回合在出生點附近飄一段（見 enemy-move.js）、不會被擊退、只用聲波、照狙擊槍的打法、擊退 120）、
// 鐘乳石（直擊 / 爆炸碰到就整根掉下來、砸到人 30、砸到隊友 ×誤傷、落地就碎、炸不壞）、火把（打在旁邊 / 飛過去 / 走過去點燃，只有玩家方）、
// 火把燒完（每過一輪暗一格、3 輪後熄滅、隨時都能補滿、round.start 的紀錄）、陰影（不在光圈裡的敵人傷害 ×1.3，含獨眼巨人）、
// 快照重建、客戶端照事件重播一致（含半路才出現的鐘乳石）、裁判流程與紀錄、真的 GameView 播一段（含遮光、照輪數變暗）、
// 火把的畫面（沒點過 / 燒完的飄「點燃」、變暗的飄「補滿」、補滿時火焰不會先變小）；
// 小心擊發：玩家的子彈打不穿樹枝（直線打不到狙擊手、拋物線落在樹枝上炸得到），狙擊手的子彈照樣穿過樹枝
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { planShot, lineBlocker } from '../shared/ai/ai.js';
import { simulateShot } from '../shared/physics/weapons.js';
import { STALACTITE, PLATFORM, HARD } from '../shared/physics/terrain.js';
import { TORCH_H, torchLevel, torchLight, lightTorch, inShadow } from '../shared/maps/cave.js';
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
  record(ev, data) { this.records.push({ ev, ...data }); }
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
}
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const make = (levelId = 'cave', n = 1, opts = {}) => new Match({ levelId, players: mkPlayers(n), seed: 1, ...opts });
// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原（WEAPONS 整個換成這裡的版本）
function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, { ...CONFIG[k] }]));
  for (const [k, v] of Object.entries(patch)) Object.assign(CONFIG[k], v);
  const turnTime = CONFIG.TURN_TIME;
  CONFIG.TURN_TIME = 30;
  const run = () => { for (const [k, v] of Object.entries(saved)) Object.assign(CONFIG[k], v); CONFIG.TURN_TIME = turnTime; };
  let out;
  try { out = fn(); } catch (e) { run(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(run);
  run();
  return out;
}
const BASE = {
  ENEMY: { hp: 45, damageMult: 0.7, lateFromStage: 6, damageMultLate: 1 },
  SNIPER: { hp: 30, sniperSpread: 3, moveChance: 1, weapons: ['sniper'] },
  BAT: { hp: 45, fixed: true, hw: 14, h: 22, sniperSpread: 3, sniperChance: 1, moveChance: 1, roam: { x: 120, y: 40, speed: 60 }, weapons: ['sonic'] },
  CAVE: { torchReach: 24, torchPass: 10, torchRounds: 3, torchLight: 270, faintLight: 150, dimLight: 0.45, shadowDamagePct: 30 },
  PLAYER: { hp: 150 }, WATER: { damagePct: 30, enemiesDrown: true }, FEVER: { everyRounds: 10, damagePct: 50 },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180 },
    sniper: { ...CONFIG.WEAPONS.sniper, damage: 15, radius: 10, knockback: 90 },
    sonic: { ...CONFIG.WEAPONS.sonic, damage: 15, radius: 10, gravity: 0, knockback: 120 },
    stalactite: { ...CONFIG.WEAPONS.stalactite, damage: 30, radius: 0, gravity: 900, hitRadius: 14 },
  },
};
const base = (fn) => withConfig(BASE, fn);
const angleTo = (s, x, y) => { const m = s.muzzle(); return Math.atan2(-(y - m.y), x - m.x) * 180 / Math.PI; };
const bats = (m) => m.entities.filter(e => e.kind === 'bat');
const stalPixels = (t, k) => {
  const s = t.stalactites[k];
  let n = 0;
  for (let y = Math.floor(s.y0); y <= s.tip.y; y++) for (let x = Math.floor(s.x0); x <= Math.ceil(s.x1); x++) if (t.at(x, y) === STALACTITE) n++;
  return n;
};
// 重播後地形遮罩、每個角色、火把 / 掉下來的鐘乳石都跟伺服器一樣
function assertSame(m, c, label) {
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(c.terrain.mask)) === 0, `${label}: terrain differs`);
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${label}: entities differ`);
  assert(J(m.mechState.lit) === J(c.mechState.lit) && J(m.mechState.fallen) === J(c.mechState.fallen), `${label}: cave state differs`);
}
// 照客戶端的方式重播一發（JSON 走過一趟）
function replayInto(c, shot, label) {
  replayChecked(c, JSON.parse(J(shot)), label);
}

// ---------------- 地圖 ----------------

await test('岩穴在一般地圖池；地面、天花板（炸不壞）、右側岩台（平台）、五根鐘乳石；只有出生點的火把亮著', () => base(() => {
  assert(levelsInPool('normal').includes('cave') && LEVELS.cave.name === '岩穴', 'cave in the normal pool');
  const m = make('cave', 4);
  const t = m.terrain;
  assert(t.stalactites.length === 5 && t.stalactites.every((s, k) => stalPixels(t, k) > 200), 'five stalactites in the mask');
  assert(t.at(500, 10) === HARD && t.at(800, 345) === PLATFORM, 'hard ceiling + rock ledge (platform)');
  assert(J(m.mechState.lit) === J([1, null, null]) && torchLevel(m, 0) === 3, 'only the spawn torch is lit (round 1, full): ' + J(m.mechState.lit));
  for (const p of m.players) assert(p.onGround && p.y > 560 && p.y < 590, `${p.id} stands on the floor: ${p.y}`);
  // 鐘乳石之間不重疊（stalactiteAt 照 x 範圍找）
  const xs = t.stalactites.map(s => [s.x0, s.x1]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < xs.length; i++) assert(xs[i][0] > xs[i - 1][1], 'stalactites overlap in x');
  return { stalactites: t.stalactites.map(s => s.tip) };
}));

await test('蝙蝠：岩台上方飄著兩隻（fixed：不會掉下來、不會被擊退）；血量照一般敵人放大；只有聲波', () => base(() => {
  for (const n of [1, 3]) {
    const m = make('cave', n);
    const bs = bats(m);
    assert(bs.length === 2, 'two bats');
    for (const b of bs) {
      assert(b.fixed && b.y === LEVELS.cave.enemySpawns.find(s => s.name === b.name).y && b.y < 340, `${b.name} floats above the ledge: ${b.y}`);
      assert(b.hp === Math.round(45 * (1 + 0.5 * (n - 1))) || b.hp === Math.round(45 * m.rules.enemyHp), `${b.name} hp ${b.hp}`);
      assert(J(b.weapons) === '["sonic"]' && b.weapons.every(w => !CONFIG.WEAPONS[w].gravity), 'sonic only');
    }
  }
  const m = make('cave', 1);
  const b = bats(m)[0];
  const x0 = b.x, y0 = b.y;
  m.applyExplosion(b.x - 5, b.cy, CONFIG.WEAPONS.cannon, m.byId('p1'), b);
  for (let i = 0; i < 120; i++) m.step();
  assert(b.x === x0 && b.y === y0 && b.hp < b.maxHp, 'a direct cannon hit hurts but does not move it');
}));

await test('蝙蝠的 AI：每回合先在空中飄一段（不走路）再用聲波；不加誤差時打得到每個出生點的玩家；聲波的擊退 120（比狙擊槍大）', () => base(() => {
  const roam = make('cave', 4, { seed: 3 });
  for (const b of bats(roam)) {
    for (let k = 0; k < 6; k++) {
      const x0 = b.x, y0 = b.y;
      const plan = roam.planAiTurn(b);
      assert(!plan.walk && plan.glide && b.x === x0 + plan.glide.dx && b.y === y0 + plan.glide.dy && plan.plan && plan.plan.weapon === 'sonic', 'glide, then sonic: ' + J(plan));
    }
  }
  const m = make('cave', 4, { seed: 3 });
  for (const b of bats(m)) for (const p of m.players) assert(lineBlocker(m.world, b, p) === null, `${b.name} sees ${p.id} through the ledge`);
  const shooter = bats(m)[0];
  const target = m.byId('p3');
  const shot = m.resolveShot(shooter, 'sonic', angleTo(shooter, target.cx, target.cy), 100);
  const hit = shot.events.find(ev => ev.target === 'p3');
  assert(hit && hit.damages[0].dmg === Math.round(15 * 0.7 * 100) / 100 || hit.damages[0].dmg > 0, 'the sonic hits P3: ' + J(shot.events));
  const c = make('cave', 4, { seed: 3 });
  replayInto(c, shot, 'sonic');
  assertSame(m, c, 'sonic');
  // 擊退：聲波 120、狙擊槍 90（同樣直擊，水平速度比例一樣）
  const kick = (weapon) => {
    const mm = make('cave', 1);
    const p = mm.byId('p1');
    mm.applyExplosion(p.cx + 4, p.cy, CONFIG.WEAPONS[weapon], bats(mm)[0], p);
    return Math.abs(p.vx);
  };
  assert(Math.abs(kick('sonic') / kick('sniper') - 120 / 90) < 1e-9, 'knockback 120 vs 90');
  return { kick: { sonic: kick('sonic'), sniper: kick('sniper') } };
}));

// ---------------- 鐘乳石 ----------------

await test('鐘乳石：狙擊槍打到就整根掉下來（從地形拿掉），砸到正下方的蝙蝠 30；客戶端照事件重播一模一樣（含半路才出現的那一顆）', () => base(() => {
  const m = make('cave', 1);
  const p = m.byId('p1');
  const s = m.terrain.stalactites[3];
  const bat = bats(m)[0];
  const hp0 = bat.hp;
  const shot = m.resolveShot(p, 'sniper', angleTo(p, s.tip.x + 1, s.tip.y - 14), 100);
  const first = shot.events[0];
  assert(first.type === 'explode' && J(first.falls) === '[3]' && first.adds.length === 1 && first.adds[0].w === 'stalactite', 'dropped: ' + J(first));
  assert(m.terrain.fallen.has(3) && stalPixels(m.terrain, 3) === 0, 'removed from the mask');
  const rock = shot.events.find(ev => ev.p === 1);
  assert(rock && rock.target === bat.id && rock.damages[0].dmg === 30 && bat.hp === hp0 - 30, 'the rock hits the bat for 30: ' + J(rock));
  assert(shot.hitEnemy === true && shot.projectiles.length === 1, 'counts as a hit; the rock is not in shot.projectiles');
  const c = make('cave', 1);
  replayInto(c, shot, 'stalactite');
  assertSame(m, c, 'stalactite');
  // 已經掉了：再打那個位置不會再掉
  const m2 = make('cave', 1);
  m2.resolveShot(m2.byId('p1'), 'sniper', angleTo(m2.byId('p1'), s.tip.x + 1, s.tip.y - 14), 100);
  const again = m2.resolveShot(m2.byId('p1'), 'sniper', angleTo(m2.byId('p1'), s.tip.x + 1, s.tip.y - 14), 100);
  assert(!again.events.some(ev => ev.falls && ev.falls.includes(3)), 'a fallen stalactite cannot fall again');
  return { rock: { f: rock.f, y: Math.round(rock.y) } };
}));

await test('鐘乳石：爆炸範圍碰到也會掉；炸不壞（坑挖不掉它）；砸到隊友 ×誤傷；沒砸到人就落地碎掉（不挖坑）', () => base(() => {
  // 爆炸範圍碰到：大砲打在鐘乳石旁邊的天花板上
  const m = make('cave', 3);
  const p1 = m.byId('p1');
  const s1 = m.terrain.stalactites[1];
  const ev = m.resolveHit(p1, CONFIG.WEAPONS.cannon, { ignore: new Set(), owner: p1 }, 0,
    { type: 'terrain', x: s1.x1 + 20, y: 36 }, 1, 0);
  assert(J(ev.falls) === '[1]', 'blast drops it: ' + J(ev));
  // 坑挖不掉：直接挖在鐘乳石上
  const m2 = make('cave', 1);
  const before = stalPixels(m2.terrain, 2);
  m2.terrain.carve(m2.terrain.stalactites[2].tip.x, m2.terrain.stalactites[2].tip.y - 30, 30);
  assert(stalPixels(m2.terrain, 2) === before, 'carving leaves it alone');
  // 隊友：P3 站在最左邊那根下面（出生點），P1 把它打下來
  const m3 = make('cave', 3);
  const a = m3.byId('p1'), v = m3.byId('p3');
  const s0 = m3.terrain.stalactites[0];
  assert(Math.abs(v.x - s0.tip.x) < v.hw + 14, 'P3 stands under the left stalactite');
  const hp = v.hp;
  const shot = m3.resolveShot(a, 'sniper', angleTo(a, s0.tip.x, s0.tip.y - 20), 100);
  const rock = shot.events.find(e => e.p === 1);
  assert(rock && rock.target === 'p3' && rock.damages[0].friendly && rock.damages[0].dmg === 30 * CONFIG.FRIENDLY_FIRE && v.hp === hp - 18,
    'friendly rock: ' + J(rock));
  const c3 = make('cave', 3);
  replayInto(c3, shot, 'friendly rock');
  assertSame(m3, c3, 'friendly rock');
  // 沒砸到人：落在地上（不挖坑、地形不變）
  const m4 = make('cave', 1);
  const q = m4.byId('p1');
  const s2 = m4.terrain.stalactites[2];
  const holes = m4.terrain.holes.length;
  const shot4 = m4.resolveShot(q, 'sniper', angleTo(q, s2.tip.x, s2.tip.y - 20), 100);
  const land = shot4.events.find(e => e.p === 1);
  assert(land && land.type === 'explode' && !land.target && !land.carve && land.y > 570 && m4.terrain.holes.length === holes + 1, 'lands on the floor: ' + J(land));
  return { friendly: rock.damages[0].dmg };
}));

// ---------------- 火把 ----------------

await test('火把：玩家的砲彈打在旁邊、子彈從旁邊飛過去、走過去碰到都會點燃（最亮）；敵人的攻擊不會', () => base(() => {
  // 子彈從火把旁邊飛過去（岩台上的火把：子彈穿過岩台，所以只能靠飛過去點）
  const m = make('cave', 1);
  const p = m.byId('p1');
  const t2 = LEVELS.cave.mechanic.torches[2];
  const shot = m.resolveShot(p, 'sniper', angleTo(p, t2.x, t2.y - TORCH_H + 4), 100);
  const pass = shot.events.find(ev => ev.type === 'pass');
  assert(pass && J(pass.lights) === '[2]' && torchLevel(m, 2) === 3, 'a sniper shot past the ledge torch lights it: ' + J(shot.events));
  const c = make('cave', 1);
  replayInto(c, shot, 'pass');
  assertSame(m, c, 'pass');
  // 打在旁邊：直接用一下爆炸（地上那支）
  const m2 = make('cave', 1);
  const t1 = LEVELS.cave.mechanic.torches[1];
  const ev = m2.resolveHit(m2.byId('p1'), CONFIG.WEAPONS.cannon, { ignore: new Set(), owner: m2.byId('p1') }, 0,
    { type: 'terrain', x: t1.x + 50, y: t1.y + 2 }, 1, 0);
  assert(J(ev.lights) === '[1]' && torchLevel(m2, 1) === 3, 'a blast next to it lights it: ' + J(ev));
  // 敵人：蝙蝠的聲波從火把旁邊飛過去、打在旁邊都不會點燃
  const m3 = make('cave', 1);
  const b = bats(m3)[0];
  const shot3 = m3.resolveShot(b, 'sonic', angleTo(b, t1.x, t1.y - TORCH_H + 4), 100);
  const ev3 = m3.resolveHit(b, CONFIG.WEAPONS.sonic, { ignore: new Set(), owner: b }, 0, { type: 'terrain', x: t1.x, y: t1.y + 1 }, 1, 0);
  assert(!shot3.events.some(e => e.lights) && !ev3.lights && J(m3.mechState.lit) === J([1, null, null]), 'enemies do not light torches');
  // 走過去：位置回報的路上碰到（伺服器的 pickup）；已經亮了就不會再撿一次
  const m4 = make('cave', 1);
  const q = m4.byId('p1');
  let got = null;
  for (let x = q.x + 20; x < 760 && !got; x += 20) got = m4.applyPositionReport(q, { x, y: q.y, facing: 1, stamina: 200 }).pickup;
  assert(got && got.type === 'torch' && got.torch === 1 && torchLevel(m4, 1) === 3, 'walking past lights it: ' + J(got));
  const back = m4.applyPositionReport(q, { x: q.x - 20, y: q.y, facing: -1, stamina: 200 });
  assert(back.ok && !back.pickup, 'no second pickup');
}));

// ---------------- 火把燒完、陰影 ----------------
const near = (a, b) => Math.abs(a - b) < 1e-12;
// 打在第 i 支火把旁邊的一下大砲（玩家方）
const blastNextTo = (m, i) => {
  const t = LEVELS[m.levelId].mechanic.torches[i];
  const p = m.byId('p1');
  return m.resolveHit(p, CONFIG.WEAPONS.cannon, { ignore: new Set(), owner: p }, 0, { type: 'terrain', x: t.x + 30, y: t.y + 2 }, 1, 0);
};

await test('火把會燒完：點燃的那一輪最亮（3），每過一輪暗一格、3 輪後熄滅（新的一輪記下 torchDim / torchOut）；光圈照亮度縮小；熄了可以再點，變暗了的打在旁邊 / 走過去補回最亮', () => base(() => {
  const m = make('cave', 1);
  const t0 = LEVELS.cave.mechanic.torches[0];
  const levels = [], fxs = [];
  for (let r = 1; r <= 5; r++) { fxs.push(m.beginRound()); levels.push(torchLevel(m, 0)); }
  assert(m.round === 5 && J(levels) === '[3,2,1,0,0]', 'the spawn torch (lit in round 1): ' + J(levels));
  assert(J(fxs) === J([[], [{ type: 'torchDim', torch: 0, light: 2 }], [{ type: 'torchDim', torch: 0, light: 1 }], [{ type: 'torchOut', torch: 0, light: 0 }], []]),
    'round fx: ' + J(fxs));
  const radius = [3, 2, 1, 0].map(lv => torchLight(t0, lv).r);
  assert(radius[0] === 150 && near(radius[1], 150 * 0.725) && near(radius[2], 150 * 0.45) && radius[3] === 0, 'faint torch radius by brightness: ' + J(radius));
  assert(torchLight(LEVELS.cave.mechanic.torches[1], 3).r === 270, 'a normal torch at full brightness');
  // 熄了：打在旁邊再點燃（記成第 5 輪點燃的，最亮），下一輪又暗一格
  const ev = blastNextTo(m, 0);
  assert(J(ev.lights) === '[0]' && m.mechState.lit[0] === 5 && torchLevel(m, 0) === 3, 're-lit: ' + J(ev.lights));
  assert(J(m.beginRound()) === J([{ type: 'torchDim', torch: 0, light: 2 }]) && torchLevel(m, 0) === 2, 'dims again');
  // 還亮著（暗了一格）：打在旁邊補回最亮（記成這一輪點燃的）；同一輪再打一次已經是最亮，不再記事件
  const ev2 = blastNextTo(m, 0);
  assert(J(ev2.lights) === '[0]' && m.mechState.lit[0] === 6 && torchLevel(m, 0) === 3, 'topped up by a blast: ' + J(ev2.lights));
  assert(!blastNextTo(m, 0).lights, 'already full this round: no second light event');
  // 下一輪又暗一格：走過去碰到也補回最亮（pickup），同一輪再碰一次不算
  assert(J(m.beginRound()) === J([{ type: 'torchDim', torch: 0, light: 2 }]) && torchLevel(m, 0) === 2, 'dims after the top-up');
  const p = m.byId('p1');
  const walk = m.applyPositionReport(p, { x: t0.x, y: p.y, facing: 1, stamina: 200 });
  assert(walk.pickup && walk.pickup.type === 'torch' && walk.pickup.torch === 0 && m.mechState.lit[0] === 7 && torchLevel(m, 0) === 3, 'topped up by walking: ' + J(walk.pickup));
  const again = m.applyPositionReport(p, { x: t0.x + 1, y: p.y, facing: 1, stamina: 199 });
  assert(!again.pickup, 'already full: walking past again does nothing');
  // 從沒點過的火把一直是 0，不會有 fx
  assert(torchLevel(m, 1) === 0 && torchLevel(m, 2) === 0, 'never lit');
  return { levels, radius: radius.map(r => Math.round(r)) };
}));

await test('陰影：不在任何亮著的火把光圈裡的敵人，傷害 ×1.3（跟敵人傷害倍率相乘、看結算那一下站的位置）；火把變暗光圈縮小就又暗了；玩家、掉下來的鐘乳石不算', () => base(() => {
  const m = make('cave', 1);
  const [a, b] = bats(m);
  const p = m.byId('p1');
  const W = CONFIG.WEAPONS;
  const L = torchLight(LEVELS.cave.mechanic.torches[2], 3);
  // 兩隻擺在岩台火把的右邊、跟火光一樣高：A 離火光 120（最暗那一格 121.5 也照得到），B 離 240（只有最亮那一輪照得到）
  a.x = L.x + 120; a.y = L.y + a.h / 2;
  b.x = L.x + 240; b.y = L.y + b.h / 2;
  const mult = (e) => m.damageMult(e, W.sonic);
  assert(inShadow(m, a.cx, a.cy) && inShadow(m, b.cx, b.cy) && near(mult(a), 0.7 * 1.3) && near(mult(b), 0.7 * 1.3), 'dark: 0.7 × 1.3 = ' + mult(a));
  assert(near(m.damageMult(a, W.stalactite), 0.7), 'a rock knocked down by a bat gets no shadow bonus');
  assert(m.damageMult(p, W.cannon) === 1 && m.damageMult(null, W.cannon) === 1, 'players (and no attacker) unaffected');
  const dmgFrom = (bat) => {   // 蝙蝠的聲波直擊 P1 扣多少
    const hp = p.hp;
    m.applyExplosion(p.cx, p.cy, W.sonic, bat, p);
    const d = hp - p.hp;
    p.hp = hp;
    return d;
  };
  const dark = dmgFrom(a);
  m.round = 1;
  lightTorch(m, 2);   // 第 1 輪點燃岩台的火把
  const seen = [];
  for (const r of [1, 2, 3, 4]) {
    m.round = r;
    seen.push([torchLevel(m, 2), inShadow(m, a.cx, a.cy), inShadow(m, b.cx, b.cy)]);
  }
  assert(J(seen) === J([[3, false, false], [2, false, true], [1, false, true], [0, true, true]]), 'level / A dark / B dark per round: ' + J(seen));
  m.round = 1;
  const lit = dmgFrom(a);
  assert(near(mult(a), 0.7) && dark === Math.round(15 * (0.7 * 1.3)) && lit === Math.round(15 * 0.7) && dark > lit, `sonic: dark ${dark} vs lit ${lit}`);
  // 結算那一下的位置：同一隻移到光圈外面就變暗
  a.x = L.x + 300;
  assert(near(mult(a), 0.7 * 1.3), 'moved out of the light');
  return { dark, lit, seen };
}));

await test('陰影（地心探險）：獨眼巨人站在陰影裡，招式傷害 ×1.3；點燃他旁邊那支火把就沒有；一般地圖沒有陰影', () => base(() => {
  const m = make('depths', 1);
  const cy = m.byId('cyclops');
  const W = CONFIG.WEAPONS;
  assert(inShadow(m, cy.cx, cy.cy) && near(m.damageMult(cy, W.cyclopsBoulder), 0.7 * 1.3) && near(m.damageMult(cy, W.cyclopsShock), 0.7 * 1.3), 'dark: ×1.3');
  assert(near(m.damageMult(cy, W.stalactite), 0.7), 'the rocks he shakes down: no bonus');
  lightTorch(m, 2);
  assert(!inShadow(m, cy.cx, cy.cy) && near(m.damageMult(cy, W.cyclopsBoulder), 0.7), 'lit torch next to him');
  const plain = make('level1', 1);
  const e = plain.enemies[0];
  assert(!inShadow(plain, e.cx, e.cy) && plain.damageMult(e, W.cannon) === plain.rules.enemyDamage, 'no shadow outside caves');
  assert(J(plain.beginRound()) === '[]' && plain.round === 1, 'no round fx outside caves');
}));

await test('快照：亮著的火把、掉下來的鐘乳石，重連時照快照重建（地形遮罩一樣）；掉下來的不會因為重建地形又長回去', () => base(() => {
  const m = make('cave', 2);
  const p = m.byId('p1');
  const s = m.terrain.stalactites[3];
  m.resolveShot(p, 'sniper', angleTo(p, s.tip.x + 1, s.tip.y - 14), 100);
  m.resolveShot(p, 'cannon', 50, 60);
  m.round = 3;
  lightTorch(m, 1);   // 第 3 輪點燃的
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(snap.torches) === J([1, 3, null]) && J(snap.fallen) === '[3]', 'snapshot: ' + J({ torches: snap.torches, fallen: snap.fallen }));
  const c = make('cave', 2);
  c.applySnapshot(snap);
  c.round = 3;   // 輪數跟快照一起來（重連的 state 帶 round）
  assertSame(m, c, 'snapshot');
  assert([0, 1, 2].every(i => torchLevel(c, i) === torchLevel(m, i)) && torchLevel(c, 0) === 1 && torchLevel(c, 1) === 3, 'same brightness');
  c.applySnapshot(snap);   // 再套一次（地形照洞重建）：掉下來的還是不在
  assertSame(m, c, 'snapshot twice');
  // 舊格式的快照（true / false = 亮了沒）：true 當作這一輪點燃的
  const old = make('cave', 2);
  old.round = 2;
  old.mechanic.restore(old, { torches: [true, false, true] });
  assert(J(old.mechState.lit) === J([2, null, 2]), 'old snapshot format: ' + J(old.mechState.lit));
}));

// ---------------- 裁判流程 ----------------

await test('裁判流程：玩家都不動（超時）時蝙蝠每回合用聲波，最後全滅；走過去點燃火把會廣播 pickup 並記 LOG', () => base(() => {
  const out = {};
  for (const seed of [2, 9]) {
    const m = make('cave', 2, { seed });
    const io = new FakeIo();
    let over = null;
    const ref = new Referee({ match: m, humans: mkPlayers(2), io, onGameOver: (r) => { over = r; } });
    ref.start();
    while (!over && io.t < 20_000_000) io.advance(500);
    assert(over === 'lose', `${seed}: ended with ${over}`);
    const ai = io.take('aiTurn');
    assert(ai.length >= 2 && ai.every(a => !a.walk && a.shot && a.shot.weapon === 'sonic'), 'bats always fire the sonic, never walk');
    const glides = ai.filter(a => a.glide && a.glide.frames > 0).length;
    assert(glides >= ai.length * 0.9, `bats glide (almost) every turn: ${glides}/${ai.length}`);
    out[seed] = ref.round;
  }
  // 走過去點燃（之後開火打下鐘乳石：紀錄）
  const m = make('cave', 1);
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 50);
  assert(ref.currentId === 'p1' && ref.phase === 'turn', 'P1 turn');
  const p = m.byId('p1');
  for (let x = p.x + 20; x <= 700; x += 20) ref.handle('p1', { t: 'move', x, y: p.y, facing: 1, stamina: 200 });
  const pk = io.take('pickup');
  assert(pk.length === 1 && pk[0].type === 'torch' && pk[0].torch === 1, 'pickup broadcast: ' + J(pk));
  assert(io.records.some(r => r.ev === 'pickup' && r.type === 'torch' && r.torch === 1), 'pickup logged');
  // 開火打下鐘乳石、子彈從岩台的火把旁邊飛過去：shot 的紀錄帶 falls / lights
  const s3 = m.terrain.stalactites[3];
  ref.handle('p1', { t: 'fire', weapon: 'sniper', angle: angleTo(p, s3.tip.x + 1, s3.tip.y - 14), power: 100, x: p.x, y: p.y, facing: 1, stamina: p.stamina });
  const rec = io.records.filter(r => r.ev === 'shot').pop();
  assert(rec && J(rec.falls) === '[3]' && !rec.lights, 'shot record has falls: ' + J(rec));
  return out;
}));

await test('無差別轟炸在洞穴裡：飛彈從天花板下面落下（不會全部炸在天花板上）、經過鐘乳石就把它打下來；重播一致；一般地圖的出發高度不變', () => base(() => {
  const out = {};
  for (const id of ['cave', 'depths']) {
    const m = make(id, 2);
    const shot = m.resolveBombard(m.byId('p1'));
    const ex = shot.events.filter(e => e.type === 'explode');
    assert(shot.projectiles.every(p => p.y > 30) && ex.filter(e => e.y > 100).length >= ex.length / 2, `${id}: missiles start under the ceiling: ` + J(shot.projectiles.map(p => Math.round(p.y))));
    assert(shot.events.some(e => e.damages && e.damages.length) && shot.events.some(e => e.falls), `${id}: hurts / drops stalactites`);
    const c = make(id, 2);
    replayInto(c, shot, `${id} bombard`);
    c.applyEntities(shot.results);
    assertSame(m, c, `${id} bombard`);
    out[id] = { explode: ex.length, falls: shot.events.flatMap(e => e.falls || []) };
  }
  for (const id of ['level1', 'beehive', 'treeGarden']) {
    const m = new Match({ levelId: id, players: mkPlayers(1), seed: 1, stage: LEVELS[id].pool === 'boss' ? 5 : 1 });
    const shot = m.resolveBombard(m.byId('p1'));
    assert(shot.projectiles.every(p => p.y === CONFIG.EQUIP.bombard.startY), `${id}: start height unchanged`);
  }
  return out;
}));

// ---------------- 小心擊發：樹枝是狙擊手的掩體 ----------------

await test('小心擊發：玩家的子彈打不穿樹枝（直線打不到狙擊手、撞到樹枝就爆炸），拋物線落在樹枝上炸得到；狙擊手的子彈照樣穿過樹枝打到玩家', () => base(() => {
  const m = make('beehive', 1);
  const p = m.byId('p1');
  const sn = m.byId('e1');
  assert(m.terrain.platformCover === 'enemies', 'branch is enemy cover');
  assert(lineBlocker(m.world, p, sn) === 'terrain' && lineBlocker(m.world, sn, p) === null, 'line of sight: blocked one way only');
  const hp = sn.hp;
  const shot = m.resolveShot(p, 'sniper', angleTo(p, sn.cx, sn.cy), 100);
  const ev = shot.events[0];
  assert(ev.type === 'explode' && !ev.target && ev.y > 244 && ev.y < 275 && sn.hp === hp, 'the bullet stops in the branch: ' + J(ev));
  // 拋物線：找一發落在狙擊手腳邊樹枝上的大砲
  let best = null;
  for (let a = 30; a <= 80; a++) for (let pw = 40; pw <= 100; pw++) {
    const r = simulateShot(m.world, p, CONFIG.WEAPONS.cannon, a, pw);
    if (r.hit.type === 'terrain' && Math.abs(r.hit.y - 246) < 4 && Math.abs(r.hit.x - sn.x) < 30) { best = { a, pw }; break; }
    if (best) break;
  }
  assert(best, 'a cannon lob lands on the branch next to the sniper');
  const m2 = make('beehive', 1);
  const lob = m2.resolveShot(m2.byId('p1'), 'cannon', best.a, best.pw);
  assert(lob.events.some(e => e.damages && e.damages.some(d => d.id === 'e1' && d.dmg > 0)), 'the blast on the branch hurts the sniper');
  const c2 = make('beehive', 1);
  replayInto(c2, lob, 'lob');
  // 狙擊手往下打：子彈穿過樹枝
  const m3 = make('beehive', 1);
  const s3 = m3.byId('e1'), p3 = m3.byId('p1');
  const down = m3.resolveShot(s3, 'sniper', angleTo(s3, p3.cx, p3.cy), 100);
  assert(down.events.some(e => e.target === 'p1'), 'sniper bullet passes the branch: ' + J(down.events));
  return { lob: best };
}));

await test('小心擊發：彈射的子彈（哈哈子彈）撞到樹枝也會彈開，伺服器與客戶端一致', () => base(() => {
  const m = make('beehive', 1);
  const p = m.byId('p1');
  p.mods.sniperBounce = 1;
  const sn = m.byId('e1');
  const shot = m.resolveShot(p, 'sniper', angleTo(p, sn.cx, sn.cy), 100);
  const c = make('beehive', 1);
  c.byId('p1').mods = { ...p.mods };
  replayInto(c, shot, 'bounce');
  assert(shot.events[0].type === 'bounce' && shot.events[0].y > 244 && shot.events[0].y < 275, 'bounced off the branch: ' + J(shot.events[0]));
  return { events: shot.events.map(e => e.type).join() };
}));

// ---------------- 真的 GameView ----------------
// 客戶端模組一載入就碰 window / document / localStorage（音效）：給最小的假物件（同 map-views.js）
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

await test('真的 GameView：岩穴從開場播一段（P1 先打下一根鐘乳石砸蝙蝠、再點燃岩台的火把，之後全員 AI 代打；每幀 update + render，含遮光）：客戶端的地形、火把跟伺服器一樣', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'cave', players, seed: 7 });
  for (const p of m.players) { p.hp = p.maxHp = 2000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  ref.setConnected('p2', false);
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  assert(view.mapView.type === 'cave' && view.mapView.shaded(view.mapCtx), 'cave map view, shaded');
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const plan = ['stalactite', 'torch'];
  let rocks = 0;
  try {
    for (let k = 0; k < 160 && ref.phase !== 'over'; k++) {
      io.advance(250);
      if (plan.length && ref.phase === 'turn' && ref.currentId === 'p1') {
        const p1 = m.byId('p1');
        const what = plan.shift();
        const [x, y] = what === 'stalactite' ? [m.terrain.stalactites[3].tip.x + 1, m.terrain.stalactites[3].tip.y - 14]
          : [LEVELS.cave.mechanic.torches[2].x, LEVELS.cave.mechanic.torches[2].y - TORCH_H + 4];
        ref.handle('p1', { t: 'fire', weapon: 'sniper', angle: angleTo(p1, x, y), power: 100, x: p1.x, y: p1.y, facing: p1.facing, stamina: p1.stamina });
        if (!plan.length) ref.setConnected('p1', false);
      }
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        if (view.projectiles.some(q => q.added)) rocks++;
      }
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);   // 最後一發還在播：播完再比
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(rocks > 0, 'the falling rock was drawn');
  assert(view.match.terrain.fallen.has(3) && J(view.match.mechState.fallen) === J(m.mechState.fallen), 'client fallen = server');
  assert(J(view.match.mechState.lit) === J(m.mechState.lit) && m.mechState.lit[2], 'client torches = server: ' + J(view.match.mechState.lit));
  { const a = m.terrain.mask, b = view.match.terrain.mask; const d = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d.push([i % 1024, Math.floor(i / 1024), a[i], b[i]]); assert(!d.length, 'client terrain = server: ' + d.length + ' ' + J(d.slice(0, 5)) + J(m.terrain.holes.length) + '/' + J(view.match.terrain.holes.length)); }
  return { rocksDrawnFrames: rocks, time: Math.round(view.time) };
}));

await test('裁判流程：每一輪記 round.start（出生點的火把第 2、3 輪 torchDim、第 4 輪 torchOut）；真的 GameView 照輪數算的亮度跟伺服器一樣，光圈縮掉、燒完那一刻飄「火把熄滅」', () => base(() => {
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'cave', players, seed: 4 });
  for (const p of m.players) { p.hp = p.maxHp = 5000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const texts = [];
  const floatText = view.floatText.bind(view);
  view.floatText = (e, str, ...rest) => { texts.push([view.match.round, str]); return floatText(e, str, ...rest); };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Map();   // 客戶端的輪數 → 那時候客戶端算的出生點火把亮度
  try {
    while (ref.round < 5 && ref.phase !== 'over' && io.t < 5_000_000) {   // 玩家一直不動（超時），蝙蝠每回合開火
      io.advance(250);
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        if (!seen.has(view.match.round)) seen.set(view.match.round, torchLevel(view.match, 0));
      }
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  const rs = io.records.filter(r => r.ev === 'round.start');
  assert(rs.map(r => r.round).join() === '1,2,3,4,5', 'one round.start per round: ' + J(rs));
  assert(J(rs.map(r => r.fx || [])) === J([[], [{ type: 'torchDim', torch: 0, light: 2 }], [{ type: 'torchDim', torch: 0, light: 1 }], [{ type: 'torchOut', torch: 0, light: 0 }], []]),
    'round fx: ' + J(rs.map(r => r.fx)));
  assert(view.match.round === m.round && [0, 1, 2].every(i => torchLevel(view.match, i) === torchLevel(m, i)), 'client brightness = server');
  assert(J([1, 2, 3, 4, 5].map(r => seen.get(r))) === '[3,2,1,0,0]', 'client brightness per round: ' + J([...seen]));
  assert(view.mapCtx.state.glow.get(0) < 1, 'the light shrank away: ' + view.mapCtx.state.glow.get(0));
  assert(J(texts.filter(([, s]) => s === '火把熄滅')) === J([[4, '火把熄滅']]), 'snuffed once, in round 4: ' + J(texts));
  return { rounds: m.round, frames: Math.round(view.time * 60) };
}));

// 岩穴的地圖畫面本身（真的 client/map-views/cave.js + 真的 Match，c 是假的：特效只記下來）
const { cave: caveView } = await import('../client/map-views/cave.js');

await test('火把的畫面：沒點過的、燒完的（剛熄光圈還沒縮完、或已經縮到 0）點了飄「火把點燃！」、光圈從 0 長大；變暗的補回最亮飄「火把補滿！」、光圈不歸零，火焰從現在的大小長回最大、不會先變小', () => base(() => {
  const m = make('cave', 1);
  m.round = 1;
  const calls = [];
  const fx = new Proxy({}, { get: (o, k) => (...args) => { calls.push([k, args]); } });
  const c = { match: m, time: 1, currentId: null, projectiles: [], state: caveView.create(m), fx, *shotScript() {} };
  const STEP = 1 / 60;
  const step = (n) => { for (let f = 0; f < n; f++) { c.time += STEP; caveView.update(c, STEP); } };
  const floats = () => calls.splice(0).filter(([k]) => k === 'float').map(([, a]) => `${a[0].id} ${a[1]}`);
  const glow = (i) => c.state.glow.get(i);
  const close = (a, b) => Math.abs(a - b) < 1e-6;
  // 第 i 支火把畫出來的火焰大小 k：火焰裡那顆亮黃色的橢圓（寬 3k、高 6k；布頭是 4.5 × 6）。沒畫火焰 = 0
  const flameK = (i) => {
    const t = LEVELS.cave.mechanic.torches[i];
    const got = [];
    const ctx = new Proxy({}, {
      get: (o, k) => (k === 'ellipse' ? (x, y, rx, ry) => { if (Math.abs(x - t.x) < 3 && close(ry, 2 * rx)) got.push(rx / 3); } : () => {}),
      set: () => true,
    });
    caveView.drawScene(ctx, c);
    return got.length ? got[0] : 0;
  };
  const faint = (i) => (LEVELS.cave.mechanic.torches[i].faint ? 0.75 : 1);
  const light = (i) => { const ev = { type: 'pass', lights: [i] }; m.mechanic.replayEvent(m, ev); caveView.showEvent(c, ev, {}); };   // 打 / 飛過去點燃
  const walk = (i) => caveView.onPickup(c, m.players[0], { type: 'torch', id: 'p1', torch: i });                                          // 走過去點燃
  // 補滿之後每一幀的火焰大小：一開始跟補滿前一樣大（不會先變小），之後只會變大，長到最亮的大小
  const growsFrom = (i, before, label) => {
    const ks = [flameK(i)];
    for (let f = 0; f < 50; f++) { step(1); ks.push(flameK(i)); }
    assert(close(ks[0], before) && ks.every((k, j) => !j || k >= ks[j - 1] - 1e-9) && close(ks[ks.length - 1], faint(i)),
      `${label}: the flame never shrinks: ${before.toFixed(4)} → ${J(ks.map(k => +k.toFixed(4)))}`);
  };
  step(30);
  floats();

  light(1);   // 第 1 輪：沒點過的
  assert(J(floats()) === J(['torch1 火把點燃！']) && glow(1) === 0 && close(flameK(1), 0.55), 'a never-lit torch lights: glow from 0, small flame');
  step(60);
  assert(close(flameK(1), 1) && glow(1) > 200, 'grown: ' + flameK(1) + ' / ' + glow(1));

  m.round = 2;   // 第 2 輪：兩支都變暗（亮度 2）
  step(90);
  const dim = 0.5 + 0.5 * (CONFIG.CAVE.dimLight + (1 - CONFIG.CAVE.dimLight) / 2);
  const k1 = flameK(1), g1 = glow(1);
  assert(close(k1, dim) && g1 > 1, 'dimmed: ' + k1);
  light(1);
  assert(J(floats()) === J(['torch1 火把補滿！']) && glow(1) === g1, 'a dimmed torch is topped up: the glow keeps its size');
  growsFrom(1, k1, 'topped up by a shot');
  assert(glow(1) > g1, 'the glow grows back');
  const k0 = flameK(0);
  walk(0);
  assert(J(floats()) === J(['torch0 火把補滿！']) && glow(0) > 1, 'the dimmed spawn torch is topped up by walking');
  growsFrom(0, k0, 'topped up by walking');

  m.round = 5;   // 第 5 輪：兩支都是第 2 輪點的，燒完了
  step(5);
  assert(J(floats().sort()) === J(['torch0 火把熄滅', 'torch1 火把熄滅']) && flameK(0) === 0 && glow(0) > 1, 'burned out, the glow still shrinking');
  walk(0);   // 剛熄、光圈還沒縮完就點
  assert(J(floats()) === J(['torch0 火把點燃！']) && glow(0) === 0 && close(flameK(0), 0.55 * faint(0)), 'a just-burned-out torch lights again (not a top-up)');
  step(600);   // 10 秒：光圈縮到 0（不是一直剩一點點）
  assert(glow(1) === 0, 'the burned-out glow snaps to 0: ' + glow(1));
  light(1);
  assert(J(floats()) === J(['torch1 火把點燃！']) && glow(1) === 0 && close(flameK(1), 0.55), 'a long-burned-out torch lights again');
  walk(2);
  assert(J(floats()) === J(['torch2 火把點燃！']) && glow(2) === 0, 'a never-lit torch lit by walking');
  return { dim: +dim.toFixed(4) };
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
