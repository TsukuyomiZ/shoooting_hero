// node test/new-maps.js
// 2026-10-05 的三張小地圖：腹背受敵（中間石柱 + 左右砲兵）、大亂鬥（平地 + 右邊三個隨機種類的敵人）、
// 小心擊發（大樹的樹枝上兩個狙擊手 + 樹枝最左邊的蜂巢 / 蜜蜂）。
// 地圖池與站位、砲兵（只用大砲、不走動、打得到石柱）、隨機種類（同 seed 一樣、名字照種類）、狙擊手不隔著自己人開槍、
// 蜂巢（不管怎麼打都 -1、每次一隻蜜蜂、敵人打不到、最多 HIVE.hp 隻、不算擊殺）、狙擊手全倒就過關、
// 蜜蜂（待機一回合 → 螫最近的玩家：傷害 + 中毒、螫完就死；diesOnSting 關掉時每回合螫、停在旁邊）、快照重建、客戶端重播一致、裁判流程與紀錄
import { CONFIG } from '../shared/config.js';
import { LEVELS, levelsInPool } from '../shared/level.js';
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { planShot, hasLineOfSight, lineBlocker } from '../shared/ai.js';
import { replayChecked } from './replay-check.js';
import { replayVolley } from '../shared/volley.js';
import { spawnBee } from '../shared/hive.js';
import { Rng } from '../shared/rng.js';
import { PLATFORM, SOIL } from '../shared/terrain.js';
// 客戶端的地圖畫面不碰瀏覽器（音效走特效出口），不用假的 window / document 就能載入
import { mapViewFor } from '../client/map-views/index.js';
import { addBees } from '../client/map-views/hive.js';

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
  constructor() { this.t = 0; this.timers = []; this.log = []; this.records = []; this.seq = 0; }
  broadcast(msg) { this.log.push(msg); }
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
const make = (levelId, n = 1, opts = {}) => new Match({ levelId, players: mkPlayers(n), seed: 1, ...opts });
// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原
function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, { ...CONFIG[k] }]));
  for (const [k, v] of Object.entries(patch)) Object.assign(CONFIG[k], v);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) Object.assign(CONFIG[k], v); }
}
const BASE = {
  ENEMY: { hp: 45, damageMult: 0.7, lateFromStage: 6, damageMultLate: 1, aimError: { angle: 5, power: 10 }, moveChance: 0.6 },
  SNIPER: { hp: 30, sniperSpread: 3, moveChance: 0, weapons: ['sniper'] },
  ARTILLERY: { hp: 45, aimError: { angle: 5, power: 10 }, moveChance: 0, sniperChance: 0, weapons: ['cannon'], mods: { knockbackPct: -50 } },
  HIVE: { hp: 5 }, BEE: { hp: 30, waitTurns: 1, diesOnSting: true }, PLAYER: { hp: 150 },
  POISON: { pctPerStack: 1, persist: true }, WATER: { damagePct: 30, enemiesDrown: true },
  FEVER: { everyRounds: 10, damagePct: 50 },
  // 武器整個換成這裡的版本（withConfig 是淺層的：跑完換回原本的物件）
  WEAPONS: {
    beeSting: { ...CONFIG.WEAPONS.beeSting, damage: 15, poison: 10, knockback: 40, radius: 0, passTerrain: true, passAllies: true },
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180 },
    sniper: { ...CONFIG.WEAPONS.sniper, damage: 15, radius: 10 },
    plasma: { ...CONFIG.WEAPONS.plasma, radius: 30, volley: 3 },
  },
};
// extra 照區塊合併到 BASE 上（只蓋寫到的欄位）；TURN_TIME 是單一個數字，另外存 / 還原
const base = (fn, extra = {}) => {
  const patch = { ...BASE };
  for (const [k, v] of Object.entries(extra)) patch[k] = { ...(BASE[k] || {}), ...v };
  const turnTime = CONFIG.TURN_TIME;
  CONFIG.TURN_TIME = 30;
  try { return withConfig(patch, fn); } finally { CONFIG.TURN_TIME = turnTime; }
};
// 砲口正對目標中心的角度（不加誤差）
const exactAngle = (s, t) => { const m = s.muzzle(); return Math.atan2(-(t.cy - m.y), t.cx - m.x) * 180 / Math.PI; };
// 把角色放到 (x, y) 附近站好
function placeOn(m, e, x, y) {
  e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.onGround = false;
  for (let i = 0; i < 400 && !e.onGround; i++) e.update(CONFIG.FIXED_DT, m.world);
  e.safeX = e.x; e.safeY = e.y;
}
const bees = (m) => m.entities.filter(e => e.kind === 'bee');
// 角色腳下撐著他的是不是這種地形（跟 Entity.groundBelow 一樣看左、中、右三點，腳下 2px 內）
const standsOn = (t, e, value) => [e.x - e.hw + 3, e.x, e.x + e.hw - 3].some(x => [1, 2, 3].some(k => t.at(x, e.y + k) === value));
const hiveHp = (m) => m.byId('hive').hp;

// 重播後（還沒套伺服器結果之前）每個角色都跟伺服器的結果一樣。蜜蜂螫完停的位置、螫完力竭死掉只靠結果校正（不在飛行事件裡），不比
function assertReplayMatches(cm, shot, label) {
  for (const r of shot.results) {
    const c = cm.byId(r.id);
    assert(c, `${label}: client is missing ${r.id}`);
    const skipPos = c.kind === 'bee';
    const skipLife = c.kind === 'bee' && r.cause === 'sting';
    assert((skipLife || (c.hp === r.hp && c.alive === r.alive)) && (skipPos || (c.x === r.x && c.y === r.y)),
      `${label}: ${r.id} client ${c.x},${c.y},${c.hp},${c.alive} vs server ${r.x},${r.y},${r.hp},${r.alive}`);
  }
}

// ---------------- 地圖池 ----------------

test('三張新地圖都在一般地圖池（腹背受敵 / 大亂鬥 / 小心擊發），Boss 池不變', () => {
  const normal = levelsInPool('normal');
  for (const [id, name] of [['flanked', '腹背受敵'], ['brawl', '大亂鬥'], ['beehive', '小心擊發']]) {
    assert(normal.includes(id) && LEVELS[id].name === name, `${id} ${LEVELS[id] && LEVELS[id].name}`);
  }
  assert(levelsInPool('boss').join() === 'treeGarden,jungleSerpent', 'boss pool ' + levelsInPool('boss'));
  return { normal };
});

// ---------------- 腹背受敵 ----------------

test('腹背受敵：4 位玩家都站在中間石柱頂上；左右台地各一個砲兵（只有大砲、不走動、面向石柱），沒人掉水', () => base(() => {
  const m = make('flanked', 4);
  const t = m.terrain;
  for (const p of m.players) {
    assert(p.alive && p.onGround && p.waterFalls === 0, `${p.id} stands`);
    assert(standsOn(t, p, SOIL) && p.x > 428 && p.x < 566 && p.y < 300, `${p.id} on the pillar (${p.x}, ${p.y})`);
  }
  const [a, b] = m.enemies;
  assert(m.enemies.length === 2 && a.x < 280 && b.x > 740, `one artillery per side: ${m.enemies.map(e => e.x)}`);
  for (const e of m.enemies) {
    assert(e.kind === 'artillery' && e.name.startsWith('砲兵'), `${e.id} kind ${e.kind} ${e.name}`);
    assert(e.weapons.join() === 'cannon' && e.weapon === 'cannon', `${e.id} weapons ${e.weapons}`);
    assert(e.ai && e.ai.moveChance === 0 && e.ai.sniperChance === 0, `${e.id} ai ${JSON.stringify(e.ai)}`);
    assert(e.alive && e.onGround && standsOn(t, e, SOIL) && e.y > 440, `${e.id} on a plateau (${e.x}, ${e.y})`);
  }
  assert(a.facing === 1 && b.facing === -1, 'both face the pillar');
  // 石柱跟兩邊台地之間隔著水
  for (const x of [340, 650]) assert(!t.isSolid(x, CONFIG.WATER_LEVEL - 2), `water gap at x=${x}`);
  // 血量：ARTILLERY.hp 依人數 / 關數放大（2 人第 3 關）
  const duo = make('flanked', 2, { stage: 3 });
  const want = Math.round(45 * (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER) * (1 + CONFIG.RUN.enemyHpPerStage * 2));
  assert(duo.enemies.every(e => e.hp === want && e.maxHp === want), `scaled hp ${duo.enemies.map(e => e.hp)} vs ${want}`);
  return { players: m.players.map(p => [p.x, p.y]), artillery: m.enemies.map(e => [e.x, e.y]), duoStage3Hp: want };
}));

test('砲兵的 AI：每回合都用大砲、不走動；不加誤差時兩邊都打得到石柱頂上的人', () => base(() => {
  let hits = 0, n = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const m = make('flanked', 2, { seed });
    const e = m.enemies[seed % 2];
    const x0 = e.x;
    const { walk, plan } = m.planAiTurn(e);
    assert(walk === null && e.x === x0, `seed ${seed}: artillery walked`);
    assert(plan && plan.weapon === 'cannon', `seed ${seed}: plan ${JSON.stringify(plan)}`);
    n++;
  }
  withConfig({ ARTILLERY: { aimError: { angle: 0, power: 0 } } }, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const m = make('flanked', 2, { seed });
      const e = m.enemies[seed % 2];
      const plan = planShot(m.world, e, new Rng(seed));
      const before = m.players.map(p => p.hp);
      m.resolveShot(e, plan.weapon, plan.angle, plan.power);
      if (m.players.some((p, i) => p.hp < before[i])) hits++;
    }
  });
  assert(hits >= 16, `exact artillery shots should mostly hurt someone on the pillar: ${hits}/20`);
  return { plans: n, exactHits: `${hits}/20` };
}));

// ---------------- 大亂鬥 ----------------

test('大亂鬥：玩家在左邊、三個敵人在最右邊；種類每一場隨機（一般 / 狙擊手 / 砲兵都會出現），同一個 seed 抽到的一樣、名字照種類取', () => base(() => {
  const LABEL = { normal: '敵人', sniper: '狙擊手', artillery: '砲兵' };   // 寫死在測試裡，不拿程式自己的表來比
  const seen = new Set();
  const combos = new Set();
  for (let seed = 1; seed <= 80; seed++) {
    const m = make('brawl', 2, { seed });
    const again = make('brawl', 2, { seed });   // 客戶端用同一個 seed 建的 Match：種類、名字、位置都要一樣
    assert(m.enemies.length === 3, `seed ${seed}: ${m.enemies.length} enemies`);
    const sig = (mm) => mm.enemies.map(e => `${e.kind}|${e.name}|${e.x}|${e.hp}`).join(',');
    assert(sig(m) === sig(again), `seed ${seed}: not deterministic`);
    combos.add(m.enemies.map(e => e.kind || 'normal').join(','));
    m.enemies.forEach((e, i) => {
      const kind = e.kind || 'normal';
      seen.add(kind);
      assert(['normal', 'sniper', 'artillery'].includes(kind), `seed ${seed}: kind ${kind}`);
      assert(e.name === `${LABEL[kind]} ${'ABC'[i]}`, `seed ${seed}: name ${e.name} for ${kind}`);
      const def = kind === 'normal' ? CONFIG.ENEMY : kind === 'sniper' ? CONFIG.SNIPER : CONFIG.ARTILLERY;
      assert(e.hp === Math.round(def.hp * (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER)), `seed ${seed}: ${e.id} hp ${e.hp}`);
      const spawn = LEVELS.brawl.enemySpawns[i];
      assert(Math.abs(e.x - spawn.x) <= LEVELS.brawl.randomEnemies.jitter, `seed ${seed}: ${e.id} x ${e.x}`);
      assert(e.alive && e.onGround && e.x > 740 && standsOn(m.terrain, e, SOIL), `seed ${seed}: ${e.id} stands at (${e.x}, ${e.y})`);
    });
    assert(m.players.every(p => p.onGround && p.x < 240), `seed ${seed}: players on the left`);
  }
  assert(seen.size === 3, 'every kind shows up: ' + [...seen]);
  assert(combos.size >= 8, 'kinds are picked per slot, not one roll for all: ' + combos.size);
  return { kinds: [...seen], combos: combos.size };
}));

test('只有狙擊槍的射手不隔著自己人開槍：排在同伴後面的狙擊手不開火，前面的同伴倒下才開火（大亂鬥的平地）', () => base(() => {
  LEVELS.__brawlFixed = {
    ...LEVELS.brawl, pool: 'test',
    enemySpawns: [{ x: 780, y: 530, name: '敵人 A' }, { x: 870, y: 530, name: '狙擊手 B', type: 'sniper' }],
  };
  try {
    const rng = new Rng(3);
    for (let seed = 1; seed <= 20; seed++) {
      const m = new Match({ levelId: '__brawlFixed', players: mkPlayers(2), seed });
      const [front, sniper] = m.enemies;
      assert(m.players.every(p => !hasLineOfSight(m.world, sniper, p)), `seed ${seed}: precondition — the front enemy blocks the sniper`);
      assert(planShot(m.world, sniper, rng) === null, `seed ${seed}: sniper fired through its ally`);
      const turn = m.planAiTurn(sniper);
      assert(turn.plan === null && turn.walk === null, `seed ${seed}: AI turn ${JSON.stringify(turn.plan)}`);
      front.die('hit');
      const plan = planShot(m.world, sniper, rng);
      assert(plan && plan.weapon === 'sniper', `seed ${seed}: clear line → shoots`);
    }
    // 裁判流程：狙擊手不開火的回合照樣跑得完（aiTurn 的 shot 是 null）
    const m = new Match({ levelId: '__brawlFixed', players: mkPlayers(1), seed: 5 });
    const io = new FakeIo();
    let over = null;
    const ref = new Referee({ match: m, humans: mkPlayers(1), io, onGameOver: (r) => { over = r; } });
    ref.start();
    io.advance(200_000);
    const sniperTurns = io.take('aiTurn').filter(a => a.actorId === 'e2');
    assert(sniperTurns.length >= 2 && sniperTurns.every(a => a.shot === null), 'held-fire turns: ' + sniperTurns.length);
    assert(io.records.some(r => r.ev === 'ai.turn' && r.actor === 'e2' && r.noShot), 'held fire is logged as noShot');
    return { heldTurns: sniperTurns.length, over };
  } finally {
    delete LEVELS.__brawlFixed;
  }
}, { ENEMY: { moveChance: 0 } }));

// ---------------- 小心擊發 ----------------

test('小心擊發：玩家在左邊地面；兩個狙擊手站在樹枝右側；蜂巢掛在樹枝最左邊下面；樹幹、樹枝炸不壞', () => base(() => {
  const m = make('beehive', 4);
  const t = m.terrain;
  const branch = LEVELS.beehive.platforms[0];
  const bx0 = Math.min(...branch.map(p => p[0])), top = branch[0][1];
  for (const p of m.players) {
    assert(p.alive && p.onGround && p.waterFalls === 0 && standsOn(t, p, SOIL) && p.x < 300, `${p.id} on the ground (${p.x}, ${p.y})`);
  }
  const snipers = m.enemies.filter(e => e.kind === 'sniper');
  assert(snipers.length === 2, 'two snipers');
  const hive = m.byId('hive');
  for (const s of snipers) {
    assert(s.alive && s.onGround && t.at(s.x, s.y + 1) === PLATFORM && s.y === top - 1, `${s.id} stands on the branch (${s.x}, ${s.y})`);
    assert(s.x > hive.x + 200, `${s.id} is on the right side of the branch`);
  }
  assert(hive && hive.kind === 'hive' && hive.fixed && hive.noTurn && hive.optional && hive.hp === 5 && hive.maxHp === 5, 'hive entity');
  assert(hive.x - hive.hw - bx0 < 40 && hive.y - hive.h >= top, `hive hangs under the left end of the branch (${hive.x}, ${hive.y})`);
  for (let i = 0; i < 120; i++) m.step();
  assert(hive.y === LEVELS.beehive.mechanic.y, 'hive does not fall');
  // 樹幹（樹皮）與樹枝炸不壞；地面炸得掉
  t.carve(900, 300, 40);
  t.carve(600, top + 5, 40);
  assert(t.isHard(900, 300) && t.isPlatform(600, top + 5) && !t.isSolid(600, top + 5), 'trunk and branch survive blasts');
  t.carve(300, 600, 20);
  assert(!t.isSolid(300, 600), 'ground is destructible');
  // 往右走會被樹幹擋住（樹根那一小段爬得上去），碰不到狙擊手
  const p = m.players[0];
  placeOn(m, p, 700, 560);
  p.stamina = 1e9; p.moveDir = 1;
  for (let i = 0; i < 600; i++) m.step();
  p.moveDir = 0;
  assert(p.x < 850 && p.y > 400, `blocked by the trunk at (${p.x}, ${p.y})`);
  return { snipers: snipers.map(s => [s.x, s.y]), hive: [hive.x, hive.y], stopAt: [Math.round(p.x), Math.round(p.y)] };
}));

test('射界：兩個狙擊手對每個出生點都有直線視野，正中間的一槍直接打中那位玩家（不會打到同伴、蜂巢）', () => base(() => {
  let shots = 0;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 4; j++) {
      const m = make('beehive', 4);
      const s = m.enemies[i], p = m.players[j];
      assert(hasLineOfSight(m.world, s, p), `${s.id} sees ${p.id}`);
      const r = m.resolveShot(s, 'sniper', exactAngle(s, p), 100);
      assert(r.hit.entityId === p.id, `${s.id} → ${p.id} hit ${r.hit.type} ${r.hit.entityId}`);
      assert(m.enemies.every(e => e.hp === e.maxHp) && bees(m).length === 0, `${s.id} → ${p.id} hurt an ally / the hive`);
      shots++;
    }
  }
  return { shots };
}));

test('蜂巢：不管什麼武器、直擊或波及、傷害加成多高都只扣 1，每被打一次就飛出一隻蜜蜂（出生資料寫在事件裡）', () => base(() => {
  // 狙擊槍直擊（從地上斜斜往上打）
  const m = make('beehive', 2);
  const [p1, p2] = m.players;
  const hive = m.byId('hive');
  const r1 = m.resolveShot(p1, 'sniper', exactAngle(p1, hive), 100);
  const ev = r1.events.find(e => e.bees);
  assert(r1.hit.entityId === 'hive' && hive.hp === 4, `sniper hit → hp ${hive.hp}`);
  assert(ev && ev.bees.length === 1 && ev.bees[0].id === 'b1', 'event carries the new bee: ' + JSON.stringify(ev && ev.bees));
  const d = ev.damages.find(x => x.id === 'hive');
  assert(d && d.dmg === 1 && d.hive && !d.friendly, 'damage entry: ' + JSON.stringify(d));
  const b1 = m.byId('b1');
  const spot = LEVELS.beehive.mechanic.beeSpots[0];
  assert(b1 && b1.kind === 'bee' && b1.alive && b1.fixed && b1.optional && b1.x === spot.x && b1.y === spot.y, 'bee at the first spot');
  assert(b1.hp === Math.round(30 * (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER)) && b1.waitTurns === 1, `bee hp ${b1.hp} wait ${b1.waitTurns}`);
  assert(r1.results.some(s => s.id === 'b1' && s.wt === 1), 'shot results include the bee');
  assert(r1.hitEnemy === true, 'hitting the hive counts as a hit');
  assert(r1.kills.length === 0 && p1.kills === 0, 'no kill');
  // 大砲：直擊與波及都只扣 1；武器傷害 +500% 也一樣
  p2.mods.damagePct = 500;
  placeOn(m, p2, hive.x, 560);
  m.resolveShot(p2, 'cannon', 90, 80);   // 正下方往上打：砲彈往上飛撞到蜂巢
  assert(hive.hp === 3 && bees(m).length === 2, `cannon direct → hp ${hive.hp}, bees ${bees(m).length}`);
  const dmgs = m.applyExplosion(hive.x - hive.hw - 25, hive.cy, CONFIG.WEAPONS.cannon, p2, null);
  assert(hive.hp === 2 && bees(m).length === 3 && dmgs.find(x => x.id === 'hive').dmg === 1, `splash → hp ${hive.hp}`);
  // 不會燃燒、中毒、被擊退
  p2.mods.burnStacks = 3;
  m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.cannon, p2, hive, { burn: 3 });
  assert(hive.hp === 1 && hive.burn === 0 && hive.poison === 0 && hive.vx === 0 && hive.vy === 0, 'no burn / knockback');
  // 最後一下打掉蜂巢：也飛出一隻（最多 HIVE.hp 隻）；之後就打不到了
  m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.sniper, p1, hive);
  assert(!hive.alive && hive.hp === 0 && bees(m).length === 5, `destroyed → bees ${bees(m).length}`);
  const before = p1.kills;
  m.creditKills(p1, [hive]);
  assert(p1.kills === before, 'destroying the hive is not a kill');
  m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.cannon, p1, null);
  assert(bees(m).length === 5, 'a dead hive releases no more bees');
  // 活著的蜜蜂各停一個位置（被波及打死的蜜蜂空出來的位置，下一隻會補上）
  const alive = bees(m).filter(b => b.alive);
  const spots = new Set(alive.map(b => `${b.x},${b.y}`));
  assert(alive.length >= 1 && spots.size === alive.length, 'live bees at distinct spots: ' + alive.map(b => [b.id, b.x, b.y]));
  assert(m.result() === null, 'snipers are still alive');
  return { bees: bees(m).map(b => [b.id, b.x, b.y]) };
}));

test('蜂巢：等離子三發都打到 = 扣 3、飛出 3 隻；敵人的子彈穿過蜂巢與蜜蜂、爆炸也傷不到它們（不會放蜜蜂）', () => base(() => {
  const m = make('beehive', 1);
  const p = m.players[0];
  const hive = m.byId('hive');
  p.weapons = ['cannon', 'sniper', 'plasma'];
  placeOn(m, p, hive.x, 560);
  const r = m.resolveShot(p, 'plasma', 90, 80);
  assert(hive.hp === 2 && bees(m).length === 3, `plasma ×3 → hp ${hive.hp}, bees ${bees(m).length}`);
  const perEvent = r.events.filter(e => e.bees).map(e => e.bees.map(b => b.id).join('+')).join('|');
  assert(perEvent === 'b1|b2|b3', 'each event carries only its own new bee: ' + perEvent);
  // 敵人的爆炸：蜂巢與蜜蜂都不受影響
  const s = m.enemies[0];
  const b = bees(m)[0];
  const dm = m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.cannon, s, null);
  assert(hive.hp === 2 && bees(m).length === 3 && !dm.some(x => x.id === 'hive'), 'enemy blast does not touch the hive');
  b.hp = b.maxHp;
  const hp0 = b.hp;
  m.applyExplosion(b.cx, b.cy, CONFIG.WEAPONS.sniper, s, b);
  const ff = Math.round(CONFIG.WEAPONS.sniper.damage * 1 * (CONFIG.ENEMY.damageMult * 1) * CONFIG.FRIENDLY_FIRE);
  assert(b.hp === hp0 - ff && bees(m).length === 3, `an enemy blast on a bee is plain friendly fire: ${hp0} → ${b.hp} (want -${ff})`);
  // 敵人的子彈直直穿過蜂巢（自己人穿得過），蜂巢不扣血
  const m2 = make('beehive', 1);
  const h2 = m2.byId('hive');
  const sn = m2.enemies[0];
  const ang = exactAngle(sn, h2);
  const shot = m2.resolveShot(sn, 'sniper', ang, 100);
  assert(h2.hp === 5 && bees(m2).length === 0 && shot.hit.entityId !== 'hive', `enemy bullet passes the hive: ${shot.hit.type} ${shot.hit.entityId}`);
  // 放過蜜蜂之後，別的開火事件不會再帶舊的蜜蜂資料
  const later = m.resolveShot(s, 'sniper', exactAngle(s, p), 100);
  assert(later.events.every(e => !e.bees), 'a later shot carries no stale bees');
  return { plasmaHits: 3 };
}));

test('過關：狙擊手全倒就贏（蜂巢、蜜蜂還在也一樣）；玩家全倒還是輸', () => base(() => {
  const m = make('beehive', 1);
  const p = m.players[0];
  m.resolveShot(p, 'sniper', exactAngle(p, m.byId('hive')), 100);
  assert(bees(m).length === 1 && m.result() === null, 'one bee, battle goes on');
  const snipers = m.enemies.filter(e => e.kind === 'sniper');
  snipers[0].die('hit');
  assert(m.result() === null, 'one sniper left');
  snipers[1].die('hit');
  assert(m.result() === 'win', 'all snipers down → win with hive / bee alive: ' + m.result());
  assert(m.enemies.filter(e => !e.optional).every(e => e.kind === 'sniper'), 'only snipers are required');
  // 玩家全倒還是輸
  const m2 = make('beehive', 1);
  m2.players[0].die('hit');
  assert(m2.result() === 'lose', 'lose');
}));

test('蜜蜂（diesOnSting 關掉）：飛出來後第一個回合待機，之後每個回合衝向最近的玩家：傷害（×敵人倍率）+ 10 層中毒，螫完停在他旁邊', () => base(() => {
  const m = make('beehive', 2);
  const [p1, p2] = m.players;
  const hive = m.byId('hive');
  m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.sniper, p1, hive);
  const b = m.byId('b1');
  placeOn(m, p1, 120, 560);
  placeOn(m, p2, 420, 560);   // 離蜜蜂比較近
  const t1 = m.planAiTurn(b);
  assert(t1.boss && t1.boss.steps.length === 1 && t1.boss.steps[0].action === 'wait' && t1.boss.steps[0].still, 'first turn waits: ' + JSON.stringify(t1.boss.steps[0].action));
  assert(b.waitTurns === 0 && p2.hp === 150 && t1.boss.steps[0].still.results.some(s => s.id === 'b1' && s.wt === 0), 'wait counter synced');
  const want = Math.round(CONFIG.WEAPONS.beeSting.damage * (CONFIG.ENEMY.damageMult * 1));
  const t2 = m.planAiTurn(b);
  const st = t2.boss.steps[0];
  assert(st.action === 'sting' && st.targetId === 'p2' && st.shot && st.shot.kind === 'boss' && st.shot.weapon === 'beeSting', 'second turn stings the nearest: ' + JSON.stringify({ a: st.action, t: st.targetId }));
  assert(p2.hp === 150 - want && p2.poison === 10 && p1.hp === 150 && p1.poison === 0, `p2 hp ${p2.hp} (want ${150 - want}) poison ${p2.poison}`);
  // 停在 p2 身體旁邊（從右上方衝過來 → 停在右邊、胸口高度），不蓋到他頭上的名字 / 血條
  assert(b.x - p2.x > 30 && b.x - p2.x < 100 && Math.abs(b.cy - p2.cy) <= 60 && b.y - b.h > p2.y - p2.h - 40,
    `bee hovers beside p2: bee (${b.x}, ${b.y}) p2 (${p2.x}, ${p2.y})`);
  const res = st.shot.results.find(s => s.id === 'b1');
  assert(res.x === b.x && res.y === b.y && res.alive, 'shot results carry where the bee stopped');
  // 下一回合再螫（換成離牠最近的那位）
  placeOn(m, p1, b.x + 5, 560);
  placeOn(m, p2, 60, 560);
  const t3 = m.planAiTurn(b);
  assert(t3.boss.steps[0].action === 'sting' && t3.boss.steps[0].targetId === 'p1' && p1.poison === 10, 'stings again, nearest first');
  // 神佑之石的無敵擋得住（傷害與中毒都沒有）
  p1.shield = 1;
  placeOn(m, p2, 30, 560);
  m.planAiTurn(b);
  assert(p1.poison === 10 && p1.shield === 0, 'shield blocks the sting and its poison');
  // 中毒在自己的回合開始結算（一般關卡也一樣）
  const fx = m.turnStartEffects(p2);
  assert(fx.some(f => f.type === 'poison' && f.stacks === 10), 'poison ticks at p2 turn start');
  // 牠是打得到的敵人：狙擊槍打得死
  m.applyExplosion(b.cx, b.cy, CONFIG.WEAPONS.cannon, p2, b);
  assert(b.hp < b.maxHp, 'bee takes damage');
  return { stingDmg: want };
}, { BEE: { diesOnSting: false } }));

test('蜜蜂：螫一次就死（diesOnSting，預設）；沒有玩家活著時發呆；待機回合數照 BEE.waitTurns', () => base(() => {
  withConfig({ BEE: { diesOnSting: true, waitTurns: 0 } }, () => {
    const m = make('beehive', 1);
    const p = m.players[0];
    const hive = m.byId('hive');
    m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.sniper, p, hive);
    const b = m.byId('b1');
    assert(b.waitTurns === 0, 'waitTurns 0');
    const t = m.planAiTurn(b);
    assert(t.boss.steps[0].action === 'sting' && !b.alive && b.deathCause === 'sting' && p.poison === 10, 'stings once and dies');
    assert(t.boss.steps[0].shot.results.find(s => s.id === 'b1').alive === false, 'results show it dead');
  });
  withConfig({ BEE: { waitTurns: 2, diesOnSting: false } }, () => {
    const m = make('beehive', 1);
    const p = m.players[0];
    const hive = m.byId('hive');
    m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.sniper, p, hive);
    const b = m.byId('b1');
    const acts = [m.planAiTurn(b), m.planAiTurn(b), m.planAiTurn(b)].map(t => t.boss.steps[0].action);
    assert(acts.join() === 'wait,wait,sting', 'waitTurns 2: ' + acts);
    p.die('hit');
    assert(m.planAiTurn(b).boss.steps[0].action === 'idle', 'nobody to sting → idle');
  });
}));

test('蜜蜂的血量依人數 / 關數放大（跟一般敵人一樣）；蜂巢固定 HIVE.hp', () => base(() => {
  const m = make('beehive', 3, { stage: 4 });
  const hive = m.byId('hive');
  assert(hive.hp === 5, 'hive hp is not scaled');
  m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.sniper, m.players[0], hive);
  const want = Math.round(30 * (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER * 2) * (1 + CONFIG.RUN.enemyHpPerStage * 3));
  assert(m.byId('b1').hp === want, `bee hp ${m.byId('b1').hp} vs ${want}`);
  return { beeHp: want };
}));

test('斷線代打的 AI 不打蜂巢：目標不會是蜂巢；加上真的瞄準誤差（±5° / ±10）也不會打到或炸到它', () => base(() => {
  let n = 0, cannon = 0;
  for (const players of [1, 2]) {
    for (let seed = 1; seed <= 150; seed++) {
      const m = make('beehive', players, { seed });
      const p = m.players[seed % players];
      const { plan } = m.planAiTurn(p);   // 代打的玩家照 CONFIG.ENEMY 的誤差與狙擊機率
      assert(plan && plan.targetId !== 'hive', `${players}p seed ${seed}: targets ${plan && plan.targetId}`);
      if (plan.weapon === 'cannon') cannon++;
      m.resolveShot(p, plan.weapon, plan.angle, plan.power);
      assert(m.byId('hive').hp === 5 && bees(m).length === 0, `${players}p seed ${seed}: the AI poked the hive with ${plan.weapon} ${plan.angle.toFixed(1)}° / ${plan.power.toFixed(1)}`);
      n++;
    }
  }
  assert(cannon > 50, 'enough cannon plans to matter: ' + cannon);
  // 唯一的目標就在蜂巢正下方：直接打中牠會炸到蜂巢，寧可打歪一點（只有大砲、不加誤差）
  withConfig({ ENEMY: { aimError: { angle: 0, power: 0 } } }, () => {
    for (let seed = 1; seed <= 10; seed++) {
      const m = make('beehive', 1, { seed });
      const p = m.players[0];
      const hive = m.byId('hive');
      p.weapons = ['cannon'];
      for (const s of m.enemies.filter(e => e.kind === 'sniper')) s.die('hit');
      spawnBee(m, { id: 'bx', name: '蜜蜂 X', x: hive.x, y: hive.y + 42, hp: 30, wait: 1 });
      const plan = planShot(m.world, p, new Rng(seed));
      assert(plan && plan.targetId === 'bx', 'targets the bee');
      m.resolveShot(p, plan.weapon, plan.angle, plan.power);
      assert(hive.hp === 5 && bees(m).length === 1, `seed ${seed}: the cannon splashed the hive`);
    }
  });
  // 只剩蜂巢以外的目標都倒了（不會發生，過關了）——只剩蜜蜂時會打蜜蜂
  const m = make('beehive', 1);
  const p = m.players[0];
  m.applyExplosion(m.byId('hive').x, m.byId('hive').cy, CONFIG.WEAPONS.sniper, p, m.byId('hive'));
  for (const s of m.enemies.filter(e => e.kind === 'sniper')) s.die('hit');
  const plan = planShot(m.world, p, new Rng(1));
  assert(plan && plan.targetId === 'b1', 'targets the bee: ' + (plan && plan.targetId));
  return { plans: n };
}));

test('快照：放出來的蜜蜂（含位置、血量、待機次數、死活）重連時照 bees 重建；蜂巢的血量也同步', () => base(() => {
  const m = make('beehive', 2, { seed: 7 });
  const [p1, p2] = m.players;
  const hive = m.byId('hive');
  for (let k = 0; k < 3; k++) m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.sniper, p1, hive);
  m.planAiTurn(m.byId('b1'));   // b1 待機完
  m.planAiTurn(m.byId('b1'));   // b1 螫人、移動
  m.byId('b2').die('hit');
  const snap = JSON.parse(JSON.stringify(m.snapshot()));
  assert(snap.bees.length === 3, 'snapshot lists every bee spec');
  const c = new Match({ levelId: 'beehive', players: mkPlayers(2), seed: 7 });
  c.applySnapshot(snap);
  for (const id of ['hive', 'b1', 'b2', 'b3', 'p1', 'p2']) {
    const a = m.byId(id), b = c.byId(id);
    assert(b && a.hp === b.hp && a.alive === b.alive && a.x === b.x && a.y === b.y && a.waitTurns === b.waitTurns && a.poison === b.poison,
      `${id}: server ${a.x},${a.y},${a.hp},${a.alive},${a.waitTurns} vs client ${b && [b.x, b.y, b.hp, b.alive, b.waitTurns]}`);
  }
  assert(c.byId('b1').kind === 'bee' && c.byId('b1').fixed && c.byId('b1').optional, 'rebuilt as a bee');
  assert(c.entities.map(e => e.id).join() === m.entities.map(e => e.id).join(), 'same turn order');
  return { entities: c.entities.map(e => e.id) };
}));

test('客戶端照事件重播（只跑運動學）跟伺服器一致：打到蜂巢飛出蜜蜂的一槍、等離子三發、蜜蜂的衝刺螫擊', () => base(() => {
  // 1) 狙擊槍打蜂巢
  const sm = make('beehive', 2, { seed: 11 });
  const cm = make('beehive', 2, { seed: 11 });
  cm.applySnapshot(JSON.parse(JSON.stringify(sm.snapshot())));
  const p = sm.players[0];
  const shot = JSON.parse(JSON.stringify(sm.resolveShot(p, 'sniper', exactAngle(p, sm.byId('hive')), 100)));
  replayChecked(cm, shot, 'sniper→hive');
  assertReplayMatches(cm, shot, 'sniper→hive');
  assert(cm.byId('b1') && cm.byId('hive').hp === 4, 'client spawned the bee from the event');
  cm.applyEntities(shot.results);
  // 2) 等離子三發（後面兩發從射手當下的砲口出發）
  const q = sm.players[1], cq = cm.players[1];
  q.weapons = ['cannon', 'sniper', 'plasma']; cq.weapons = q.weapons.slice();
  placeOn(sm, q, sm.byId('hive').x, 560);
  cm.applySnapshot(JSON.parse(JSON.stringify(sm.snapshot())));
  const shot2 = JSON.parse(JSON.stringify(sm.resolveShot(q, 'plasma', 90, 80)));
  replayChecked(cm, shot2, 'plasma→hive');
  assertReplayMatches(cm, shot2, 'plasma→hive');
  cm.applyEntities(shot2.results);
  assert(bees(cm).length === bees(sm).length && bees(sm).length >= 3 && cm.byId('hive').hp === sm.byId('hive').hp,
    `client bees ${bees(cm).length} hive ${cm.byId('hive').hp} vs server ${bees(sm).length} / ${sm.byId('hive').hp}`);
  // 3) 蜜蜂待機、衝刺螫擊（擊退落地也要一樣）
  const b = sm.byId('b1');
  const wait = JSON.parse(JSON.stringify(sm.planAiTurn(b)));
  cm.applyEntities(wait.boss.steps[0].still.results);
  const sting = JSON.parse(JSON.stringify(sm.planAiTurn(b))).boss.steps[0];
  assert(sting.action === 'sting', 'stings');
  replayChecked(cm, sting.shot, 'sting');
  assertReplayMatches(cm, sting.shot, 'sting');
  cm.applyEntities(sting.shot.results);
  const cb = cm.byId('b1');
  assert(cb.x === b.x && cb.y === b.y && cb.waitTurns === 0, 'bee position after the results');
  return { frames: [shot.flightFrames, shot2.flightFrames, sting.shot.flightFrames] };
}));

test('裁判流程：玩家打到蜂巢 → 同一輪蜜蜂在狙擊手之後待機 → 下一輪衝刺螫擊；紀錄有蜜蜂出現與牠的招式', () => base(() => {
  const m = make('beehive', 1, { seed: 3 });
  const io = new FakeIo();
  let over = null;
  const ref = new Referee({ match: m, humans: mkPlayers(1), io, onGameOver: (r) => { over = r; } });
  ref.start();
  io.advance(2000);
  const turn = io.take('turn')[0];
  assert(turn && turn.actorId === 'p1' && !turn.ai, 'p1 turn first');
  const p1 = m.byId('p1');
  ref.handle('p1', { t: 'fire', weapon: 'sniper', angle: exactAngle(p1, m.byId('hive')), power: 100, x: p1.x, y: p1.y, facing: 1, stamina: p1.stamina });
  const shot = io.take('shot')[0];
  assert(shot && shot.events.some(e => e.bees && e.bees[0].id === 'b1'), 'shot message carries the bee');
  const round1 = ref.round;
  for (let n = 0; n < 400 && io.take('aiTurn').filter(a => a.actorId === 'b1').length < 2; n++) io.advance(1000);
  const beeTurns = io.take('aiTurn').filter(a => a.actorId === 'b1');
  assert(beeTurns.length >= 2, 'bee took turns: ' + beeTurns.length);
  assert(beeTurns[0].boss.steps[0].action === 'wait' && beeTurns[1].boss.steps[0].action === 'sting', 'wait, then sting: ' + beeTurns.map(t => t.boss.steps[0].action));
  const beeTurnMsgs = io.take('turn').filter(t => t.actorId === 'b1');
  assert(beeTurnMsgs[0].round === round1 && beeTurnMsgs[1].round === round1 + 1, `bee turns in rounds ${beeTurnMsgs.map(t => t.round)} (fired in ${round1})`);
  // 回合順序：同一輪裡蜜蜂排在狙擊手後面
  const order = io.take('turn').filter(t => t.round === round1).map(t => t.actorId);
  assert(order.join() === 'p1,e1,e2,b1', 'round order ' + order);
  assert(m.byId('p1').poison >= 10, 'p1 got stung');
  // 螫一次就死（預設）：之後不會再輪到牠
  const bee = m.byId('b1');
  assert(!bee.alive && bee.deathCause === 'sting', 'the bee died after its sting: ' + bee.deathCause);
  io.advance(120_000);
  assert(io.take('aiTurn').filter(a => a.actorId === 'b1').length === 2 && io.take('turn').filter(t => t.actorId === 'b1').length === 2, 'no more bee turns after it died');
  // 紀錄：開火的 shot 記到蜜蜂出現（spawned）、蜜蜂的 ai.turn 記招式與目標
  const shotRec = io.records.find(r => r.ev === 'shot' && r.pid === 'p1');
  assert(shotRec && shotRec.changes.some(c => c.id === 'b1' && c.spawned) && shotRec.changes.some(c => c.id === 'hive' && c.hp[0] === 5 && c.hp[1] === 4), 'shot log: ' + JSON.stringify(shotRec && shotRec.changes));
  const beeRecs = io.records.filter(r => r.ev === 'ai.turn' && r.actor === 'b1');
  assert(beeRecs[0].boss[0].action === 'wait' && beeRecs[1].boss[0].action === 'sting' && beeRecs[1].boss[0].targetId === 'p1', 'bee ai.turn log: ' + JSON.stringify(beeRecs.map(r => r.boss)));
  const start = io.records.find(r => r.ev === 'battle.start');
  assert(start.entities.some(e => e.id === 'hive' && e.kind === 'hive' && e.hp === 5), 'battle.start logs the hive');
  return { beeTurns: beeTurns.length, over };
}));

test('裁判流程跑得完：三張地圖玩家都不動（超時），敵人每回合照規矩行動，最後全滅結束', () => base(() => {
  const out = {};
  for (const levelId of ['flanked', 'brawl', 'beehive']) {
    for (const seed of [2, 9]) {
      const m = make(levelId, 2, { seed });
      const io = new FakeIo();
      let over = null;
      const ref = new Referee({ match: m, humans: mkPlayers(2), io, onGameOver: (r) => { over = r; } });
      ref.start();
      const start = io.t;
      while (!over && io.t - start < 20_000_000) io.advance(500);
      assert(over === 'lose', `${levelId}/${seed}: ended with ${over}`);
      const ai = io.take('aiTurn');
      assert(ai.length >= 2 && ai.every(a => a.walk === null || m.byId(a.actorId).kind === null), `${levelId}/${seed}: only ordinary enemies walk`);
      if (levelId === 'flanked') assert(ai.every(a => a.shot && a.shot.weapon === 'cannon'), 'artillery always fires the cannon');
      if (levelId === 'beehive') assert(bees(m).length === 0 && m.byId('hive').hp === 5, 'nobody touched the hive');
      out[`${levelId}/${seed}`] = ref.round;
    }
  }
  return out;
}));

test('腹背受敵：砲兵的擊退只有一半（ARTILLERY.mods）；站在中間兩個出生點被兩邊砲兵正面打中也不會掉下水，擊退調回原本的就會', () => base(() => {
  const m0 = make('flanked', 1);
  assert(m0.enemies.every(e => e.mods.knockbackPct === -50), 'artillery mods: ' + m0.enemies.map(e => e.mods.knockbackPct));
  // 兩邊砲兵各對 (x) 開一發不加誤差的大砲，回傳 [打中的次數, 掉水的次數]
  const volley = (xs) => {
    let hurt = 0, falls = 0;
    for (const x of xs) {
      for (let side = 0; side < 2; side++) {
        const m = make('flanked', 1, { seed: 7 });
        const p = m.players[0];
        placeOn(m, p, x, 250);
        const e = m.enemies[side];
        const plan = planShot(m.world, e, new Rng(1));
        const hp0 = p.hp;
        m.resolveShot(e, plan.weapon, plan.angle, plan.power);
        if (p.hp < hp0) hurt++;
        if (p.waterFalls) falls++;
      }
    }
    return [hurt, falls];
  };
  return withConfig({ ARTILLERY: { aimError: { angle: 0, power: 0 } } }, () => {
    const [hurt, falls] = volley([480, 505]);
    assert(hurt === 4 && falls === 0, `center spawns: hurt ${hurt}/4, fell ${falls}`);
    const full = withConfig({ ARTILLERY: { mods: { knockbackPct: 0 } } }, () => volley([455, 480, 505, 530]));
    assert(full[1] >= 2, 'with full knockback the same shots knock players into the water: ' + full);
    return { half: [hurt, falls], full };
  });
}));

test('自己人穿得過的蜜蜂不擋狙擊手的視線：蜜蜂停在射線上，狙擊手照樣瞄那位玩家、子彈穿過蜜蜂', () => base(() => {
  const m = make('beehive', 1);
  const p = m.players[0], s = m.enemies[0];
  const hive = m.byId('hive');
  m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.sniper, p, hive);
  const b = m.byId('b1');
  const mz = s.muzzle();
  const mx = (mz.x + p.cx) / 2, my = (mz.y + p.cy) / 2;
  b.x = mx; b.y = my + b.h / 2;
  assert(b.containsPoint(mx, my), 'precondition: the bee sits on the sniper line');
  assert(lineBlocker(m.world, s, p) === null && hasLineOfSight(m.world, s, p), 'the bee does not block its own team');
  const plan = planShot(m.world, s, new Rng(1));
  assert(plan && plan.weapon === 'sniper' && plan.targetId === p.id, 'the sniper still aims at the player: ' + JSON.stringify(plan));
  const hp0 = b.hp;
  const shot = m.resolveShot(s, 'sniper', exactAngle(s, p), 100);
  assert(shot.hit.entityId === p.id && b.hp === hp0, `the bullet passes the bee: ${shot.hit.type} ${shot.hit.entityId}`);
}));

test('蜜蜂穿過地形：躲進坑裡的玩家一樣會被螫到；螫完不會停進土裡', () => base(() => {
  const m = make('beehive', 1);
  const p = m.players[0];
  const hive = m.byId('hive');
  for (let y = 566; y <= 626; y += 6) m.terrain.carve(150, y, 16);
  placeOn(m, p, 150, 600);
  assert(p.y > 610 && p.y < CONFIG.WATER_LEVEL && p.waterFalls === 0, 'precondition: p1 is down in the shaft at y=' + p.y);
  m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.sniper, p, hive);
  const b = m.byId('b1');
  assert(lineBlocker(m.world, b, p) === 'terrain', 'precondition: ground between the bee and p1');
  m.planAiTurn(b);   // 待機
  const st = m.planAiTurn(b).boss.steps[0];
  assert(st.action === 'sting' && st.shot.hit.entityId === p.id && p.poison === 10, `stung through the ground: ${st.shot.hit.type} ${st.shot.hit.entityId}`);
  assert(!m.terrain.isSolid(b.x, b.cy) && !m.terrain.isSolid(b.x, b.y - 1), `the bee hovers in the open: (${b.x}, ${b.y})`);
  return { bee: [b.x, b.y] };
}));

test('（diesOnSting 關掉）好幾隻蜜蜂螫同一個人：停的位置互相錯開（名字 + 血條不重疊：左右差 48 或上下差 52），也不會停進地形裡', () => base(() => {
  const out = {};
  for (const n of [1, 4]) {
    const m = make('beehive', n, { seed: 5 });
    const p = m.players[0];
    const hive = m.byId('hive');
    for (let k = 0; k < 5; k++) m.applyExplosion(hive.x, hive.cy, CONFIG.WEAPONS.sniper, p, hive);
    const bs = bees(m);
    assert(bs.length === 5, 'five bees');
    for (let round = 0; round < 3; round++) for (const b of bs) if (b.alive) m.planAiTurn(b);
    const alive = bs.filter(b => b.alive);
    for (let i = 0; i < alive.length; i++) {
      assert(!m.terrain.isSolid(alive[i].x, alive[i].cy) && !m.terrain.isSolid(alive[i].x, alive[i].y - 1), `${alive[i].id} inside terrain`);
      for (let j = i + 1; j < alive.length; j++) {
        const dx = Math.abs(alive[i].x - alive[j].x), dy = Math.abs(alive[i].y - alive[j].y);
        assert(dx >= 48 - 1e-9 || dy >= 52 - 1e-9, `${n}p: ${alive[i].id} and ${alive[j].id} overlap (dx ${dx.toFixed(1)}, dy ${dy.toFixed(1)})`);
      }
    }
    out[`${n}p`] = alive.map(b => [Math.round(b.x), Math.round(b.y)]);
  }
  return out;
}, { BEE: { diesOnSting: false } }));

test('同一發先放出蜜蜂、又把牠打死（無差別轟炸）：算擊殺（噬魂者也加），紀錄標 spawned + died', () => base(() => {
  let found = 0;
  for (let seed = 1; seed <= 40 && found < 3; seed++) {
    const m = make('beehive', 1, { seed });
    const p = m.players[0];
    p.mods.bombard = 1;
    p.mods.killDamagePct = 5;
    placeOn(m, p, 700, 560);
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: mkPlayers(1), io });
    ref.start();
    io.advance(2000);   // 第一個回合是 p1：回合開始先轟炸
    const shot = io.take('shot').find(s => s.kind === 'bombard');
    assert(shot, `seed ${seed}: bombard shot`);
    const spawned = shot.events.flatMap(e => e.bees || []).map(b => b.id);
    const deadNew = spawned.filter(id => !m.byId(id).alive);
    if (!deadNew.length) continue;
    found++;
    for (const id of deadNew) assert(shot.kills.includes(id), `seed ${seed}: ${id} killed in the same volley is credited: ${shot.kills}`);
    assert(p.kills === shot.kills.length && p.soulPct === p.kills * 5, `seed ${seed}: kills ${p.kills} soul ${p.soulPct}`);
    const rec = io.records.find(r => r.ev === 'shot' && r.kind === 'bombard');
    for (const id of deadNew) {
      assert(rec.changes.some(c => c.id === id && c.spawned && c.died), `seed ${seed}: log marks ${id} spawned + died: ` + JSON.stringify(rec.changes));
    }
  }
  assert(found >= 1, 'no seed produced a same-volley bee kill');
  return { seedsWithSameVolleyKills: found };
}));

test('客戶端：蜜蜂的回合腳本（待機套用結果；衝刺時角色本身不畫、飛行物一消失就出現在停的位置）；重複的出生資料不會建兩次；螫完力竭不播「被擊倒」', () => base(() => {
  const sm = make('beehive', 1, { seed: 2 });
  const cm = make('beehive', 1, { seed: 2 });
  const p = sm.players[0], hive = sm.byId('hive');
  const r = sm.resolveShot(p, 'sniper', exactAngle(p, hive), 100);
  const specs = JSON.parse(JSON.stringify(r.events.find(e => e.bees).bees));
  const floats = [];
  // 小心擊發的地圖畫面（client/map-views/hive.js）；c = 掛勾拿到的那一小塊 GameView，特效出口記下橫幅與飄字
  const hv = mapViewFor(cm);
  assert(hv.type === 'hive', 'hive map view: ' + hv.type);
  const c = {
    match: cm, time: 0, currentId: null, projectiles: [], banner: null, state: hv.create(cm),
    fx: {
      particles() {}, particle() {}, sound() {}, shake() {}, splash() {}, wither() {},
      banner(t) { c.banner = t; }, float(e, t) { floats.push([e.id, t]); },
    },
    // shotScript：真的照事件重播（shared/volley.js，跟 game-view.js 同一份；畫面掛勾都不給）→ 套伺服器結果 → 等 24 幀（跟 game-view.js 的順序一樣）。
    // 這裡沒有人代步進：模組在每次 next() 自己跑 match.step
    *shotScript(shot, extra = {}) {
      const run = replayVolley(cm, shot);
      if (!run) return;
      this.projectiles = run.live;
      yield* run.frames(extra);
      this.projectiles = [];
      assert(!run.drift.length, 'sting replay drift: ' + run.drift.join('; '));
      cm.applyEntities(shot.results);
      yield { frames: 24 };
    },
  };
  // 衝出去的蜜蜂（角色本身不畫）：記在地圖畫面自己的狀態裡，不在 Entity 上
  const charging = (e) => !!(c.state.bees.get(e.id) || {}).charging;
  addBees(c, specs);
  addBees(c, specs);
  assert(bees(cm).length === 1 && floats.filter(f => f[1] === '蜜蜂飛出來了！').length === 1, 'bee built once from the spec');
  const cb = cm.byId('b1'), sb = sm.byId('b1');
  assert(cb.x === sb.x && cb.y === sb.y && cb.hp === sb.hp && cb.waitTurns === sb.waitTurns, 'client bee = server bee');
  const play = (boss, onStep = () => {}) => {
    const g = hv.turnScript(c, { actorId: 'b1', boss: JSON.parse(JSON.stringify(boss)) });
    for (let it = g.next(); !it.done; it = g.next()) onStep();
  };
  play(sm.planAiTurn(sb).boss);
  assert(cb.waitTurns === 0 && /蓄勢待發/.test(c.banner), 'wait step applied: wt ' + cb.waitTurns + ' ' + c.banner);
  const sting = sm.planAiTurn(sb).boss;
  assert(sting.steps[0].action === 'sting', 'sting');
  const states = [];
  play(sting, () => {
    const flying = c.projectiles.length > 0;
    const at = cb.x === sb.x && cb.y === sb.y;
    const s = `${flying ? 'fly' : 'still'}:${charging(cb) ? 'hidden' : 'shown'}:${at ? 'hover' : 'origin'}`;
    if (states.at(-1) !== s) states.push(s);
  });
  // 預兆時在原地 → 衝出去（角色不畫）→ 飛行物一消失就出現在停的位置（不用等後面的落地等待）
  assert(states.join() === 'still:shown:origin,fly:hidden:origin,still:shown:hover', 'charging / hover sequence: ' + states);
  assert(!charging(cb) && cb.x === sb.x && cb.y === sb.y && /衝刺螫擊/.test(c.banner), 'ends shown at the hover spot');
  assert(!('charging' in cb) && !('windup' in cb) && !('windDir' in cb), 'no view-only fields on the bee entity');
  // 死亡的處理：螫完力竭（diesOnSting）不播被擊倒的橫幅；打掉蜂巢有自己的橫幅；被打死的蜜蜂照一般規則
  cb.deathCause = 'sting';
  assert(hv.onDeath(c, cb) === true && floats.some(f => f[0] === 'b1' && f[1] === '螫完力竭'), 'sting death handled');
  cb.deathCause = 'hit';
  assert(hv.onDeath(c, cb) === false, 'a bee shot dead uses the normal banner');
  assert(hv.onDeath(c, cm.byId('hive')) === true && /蜂巢/.test(c.banner), 'hive banner');
  return { states };
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
