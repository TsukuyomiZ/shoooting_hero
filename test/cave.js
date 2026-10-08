// node test/cave.js
// 2026-10-08：新地圖「岩穴」（洞穴地形：鐘乳石、火把照明）、新敵人蝙蝠（聲波）、小心擊發的樹枝改成擋玩家的子彈。
// 地圖池與站位（蝙蝠飄在岩台上方、只有出生點的火把亮著）、蝙蝠（飄著不動、不會被擊退、只用聲波、照狙擊槍的打法、擊退 120）、
// 鐘乳石（直擊 / 爆炸碰到就整根掉下來、砸到人 30、砸到隊友 ×誤傷、落地就碎、炸不壞）、火把（打在旁邊 / 飛過去 / 走過去點燃，只有玩家方）、
// 快照重建、客戶端照事件重播一致（含半路才出現的鐘乳石）、裁判流程與紀錄、真的 GameView 播一段（含遮光）；
// 小心擊發：玩家的子彈打不穿樹枝（直線打不到狙擊手、拋物線落在樹枝上炸得到），狙擊手的子彈照樣穿過樹枝
import { CONFIG } from '../shared/config.js';
import { LEVELS, levelsInPool } from '../shared/level.js';
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { planShot, lineBlocker } from '../shared/ai.js';
import { simulateShot } from '../shared/weapons.js';
import { STALACTITE, PLATFORM, HARD } from '../shared/terrain.js';
import { TORCH_H } from '../shared/cave.js';
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
  SNIPER: { hp: 30, sniperSpread: 3, moveChance: 0, weapons: ['sniper'] },
  BAT: { hp: 45, fixed: true, hw: 14, h: 22, sniperSpread: 3, sniperChance: 1, moveChance: 0, weapons: ['sonic'] },
  CAVE: { torchReach: 24, torchPass: 10 },
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
  assert(J(m.mechState.lit) === J([true, false, false]), 'only the spawn torch is lit: ' + J(m.mechState.lit));
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

await test('蝙蝠的 AI：每回合都用聲波、不走動；不加誤差時打得到每個出生點的玩家；聲波的擊退 120（比狙擊槍大）', () => base(() => {
  const m = make('cave', 4, { seed: 3 });
  for (const b of bats(m)) {
    for (let k = 0; k < 6; k++) {
      const plan = m.planAiTurn(b);
      assert(!plan.walk && plan.plan && plan.plan.weapon === 'sonic', 'sonic, no walking: ' + J(plan));
    }
    for (const p of m.players) assert(lineBlocker(m.world, b, p) === null, `${b.name} sees ${p.id} through the ledge`);
  }
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

await test('火把：玩家的砲彈打在旁邊、子彈從旁邊飛過去、走過去碰到都會點燃；敵人的攻擊不會；點燃之後一直亮著', () => base(() => {
  // 子彈從火把旁邊飛過去（岩台上的火把：子彈穿過岩台，所以只能靠飛過去點）
  const m = make('cave', 1);
  const p = m.byId('p1');
  const t2 = LEVELS.cave.mechanic.torches[2];
  const shot = m.resolveShot(p, 'sniper', angleTo(p, t2.x, t2.y - TORCH_H + 4), 100);
  const pass = shot.events.find(ev => ev.type === 'pass');
  assert(pass && J(pass.lights) === '[2]' && m.mechState.lit[2], 'a sniper shot past the ledge torch lights it: ' + J(shot.events));
  const c = make('cave', 1);
  replayInto(c, shot, 'pass');
  assertSame(m, c, 'pass');
  // 打在旁邊：直接用一下爆炸（地上那支）
  const m2 = make('cave', 1);
  const t1 = LEVELS.cave.mechanic.torches[1];
  const ev = m2.resolveHit(m2.byId('p1'), CONFIG.WEAPONS.cannon, { ignore: new Set(), owner: m2.byId('p1') }, 0,
    { type: 'terrain', x: t1.x + 50, y: t1.y + 2 }, 1, 0);
  assert(J(ev.lights) === '[1]' && m2.mechState.lit[1], 'a blast next to it lights it: ' + J(ev));
  // 敵人：蝙蝠的聲波從火把旁邊飛過去、打在旁邊都不會點燃
  const m3 = make('cave', 1);
  const b = bats(m3)[0];
  const shot3 = m3.resolveShot(b, 'sonic', angleTo(b, t1.x, t1.y - TORCH_H + 4), 100);
  const ev3 = m3.resolveHit(b, CONFIG.WEAPONS.sonic, { ignore: new Set(), owner: b }, 0, { type: 'terrain', x: t1.x, y: t1.y + 1 }, 1, 0);
  assert(!shot3.events.some(e => e.lights) && !ev3.lights && J(m3.mechState.lit) === J([true, false, false]), 'enemies do not light torches');
  // 走過去：位置回報的路上碰到（伺服器的 pickup）；已經亮了就不會再撿一次
  const m4 = make('cave', 1);
  const q = m4.byId('p1');
  let got = null;
  for (let x = q.x + 20; x < 760 && !got; x += 20) got = m4.applyPositionReport(q, { x, y: q.y, facing: 1, stamina: 200 }).pickup;
  assert(got && got.type === 'torch' && got.torch === 1 && m4.mechState.lit[1], 'walking past lights it: ' + J(got));
  const back = m4.applyPositionReport(q, { x: q.x - 20, y: q.y, facing: -1, stamina: 200 });
  assert(back.ok && !back.pickup, 'no second pickup');
}));

await test('快照：亮著的火把、掉下來的鐘乳石，重連時照快照重建（地形遮罩一樣）；掉下來的不會因為重建地形又長回去', () => base(() => {
  const m = make('cave', 2);
  const p = m.byId('p1');
  const s = m.terrain.stalactites[3];
  m.resolveShot(p, 'sniper', angleTo(p, s.tip.x + 1, s.tip.y - 14), 100);
  m.resolveShot(p, 'cannon', 50, 60);
  m.mechState.lit[1] = true;
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(snap.torches) === J([true, true, false]) && J(snap.fallen) === '[3]', 'snapshot: ' + J({ torches: snap.torches, fallen: snap.fallen }));
  const c = make('cave', 2);
  c.applySnapshot(snap);
  assertSame(m, c, 'snapshot');
  c.applySnapshot(snap);   // 再套一次（地形照洞重建）：掉下來的還是不在
  assertSame(m, c, 'snapshot twice');
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

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
