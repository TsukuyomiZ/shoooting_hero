// node test/grove.js
// 地圖「樹影重重」與狙擊手：地圖池、狙擊手的數值與站位、樹枝平台、射界（同伴不會擋到彼此）、
// 狙擊手的 AI（只用狙擊槍、不走動、誤差照 sniperSpread、先挑打得到的人）、裁判流程跑得完
import { CONFIG } from '../shared/config.js';
import { LEVELS, levelsInPool } from '../shared/level.js';
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { planShot, hasLineOfSight } from '../shared/ai.js';
import { Rng } from '../shared/rng.js';
import { PLATFORM, SOIL } from '../shared/terrain.js';

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
  broadcast(msg) { this.log.push(msg); }
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
const grove = (n = 1, opts = {}) => new Match({ levelId: 'grove', players: mkPlayers(n), seed: 1, ...opts });
// 狙擊手幾隻、站哪根樹枝都照關卡資料（使用者會自己改地圖，例如 4 隻改 3 隻）
const SNIPERS = LEVELS.grove.enemySpawns.filter(s => s.type === 'sniper').length;
const branchOf = (x) => (x < 760 ? 0 : 1);
// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原
function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, { ...CONFIG[k] }]));
  for (const [k, v] of Object.entries(patch)) Object.assign(CONFIG[k], v);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) Object.assign(CONFIG[k], v); }
}
// 砲口正對目標中心的角度（不加誤差）
const exactAngle = (s, t) => { const m = s.muzzle(); return Math.atan2(-(t.cy - m.y), t.cx - m.x) * 180 / Math.PI; };

test('樹影重重在一般地圖池；狙擊手（數量照關卡）：kind sniper、只有狙擊槍、血量照 SNIPER.hp 依人數 / 關數放大', () => withConfig(
  { SNIPER: { hp: 30 }, ENEMY: { hp: 45 } }, () => {
    assert(levelsInPool('normal').includes('grove') && LEVELS.grove.name === '樹影重重', 'grove is in the normal pool');
    const solo = grove(1);
    assert(SNIPERS >= 1 && solo.enemies.length === LEVELS.grove.enemySpawns.length && solo.enemies.length === SNIPERS, `${SNIPERS} snipers: ${solo.enemies.length}`);
    for (const s of solo.enemies) {
      assert(s.kind === 'sniper', `${s.id} kind ${s.kind}`);
      assert(s.weapons.length === 1 && s.weapons[0] === 'sniper' && s.weapon === 'sniper', `${s.id} weapons ${s.weapons}`);
      assert(s.hp === 30 && s.maxHp === 30, `${s.id} solo hp ${s.hp}`);
      assert(s.ai && s.ai.moveChance === 0, `${s.id} does not walk`);
    }
    // 2 人、第 3 關：30 × (1 + 0.5) × (1 + 0.15 × 2) = 58.5 → 59
    const duo = grove(2, { stage: 3 });
    const want = Math.round(30 * (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER) * (1 + CONFIG.RUN.enemyHpPerStage * 2));
    assert(duo.enemies.every(s => s.hp === want), `scaled hp ${duo.enemies.map(s => s.hp)} vs ${want}`);
    // 其他地圖的一般敵人不受影響
    const normal = new Match({ levelId: 'level1', players: mkPlayers(1), seed: 1 });
    assert(normal.enemies.every(e => e.kind === null && e.hp === 45 && e.weapons.includes('cannon')), 'ordinary enemies unchanged');
    return { soloHp: 30, duoStage3Hp: want };
  }));

test('關卡寫了不存在的敵人種類會直接報錯（不會默默變成一般敵人）', () => {
  LEVELS.__badType = { ...LEVELS.grove, enemySpawns: [{ x: 618, y: 150, name: 'X', type: 'snipr' }] };
  try {
    let err = null;
    try { new Match({ levelId: '__badType', players: mkPlayers(1), seed: 1 }); } catch (e) { err = e; }
    assert(err && /snipr/.test(err.message), 'unknown type throws: ' + (err && err.message));
  } finally {
    delete LEVELS.__badType;
  }
});

test('開場站位：玩家站在左側高地，狙擊手都站在樹枝上（每根幾隻照關卡），沒人掉水', () => {
  const m = grove(4);
  const t = m.terrain;
  for (const p of m.players) {
    assert(p.alive && p.onGround && p.waterFalls === 0, `${p.id} stands`);
    assert(t.at(p.x, p.y + 1) === SOIL && p.x < 330, `${p.id} on the left plateau (${p.x}, ${p.y})`);
  }
  const perBranch = [0, 0];
  for (const s of m.enemies) {
    assert(s.alive && s.onGround && s.waterFalls === 0, `${s.id} stands`);
    assert(t.at(s.x, s.y + 1) === PLATFORM, `${s.id} stands on a branch (${s.x}, ${s.y})`);
    perBranch[branchOf(s.x)]++;
  }
  const want = [0, 0];
  for (const s of LEVELS.grove.enemySpawns) want[branchOf(s.x)]++;
  assert(perBranch.join() === want.join(), `snipers per branch ${perBranch} vs level ${want}`);
  // 樹枝炸不壞、子彈穿得過；樹幹與樹冠只是裝飾（不是地形）
  t.carve(660, 190, 40);
  assert(t.isPlatform(660, 190) && !t.isSolid(660, 190), 'branch survives a blast and is not solid');
  assert(!t.isSolid(760, 400) && !t.isSolid(600, 100), 'trunk / canopy are decor only');
  return { snipers: m.enemies.map(s => [s.x, s.y]) };
});

test('射界：每個狙擊手對每個出生點都有直線視野，正中間的一槍直接打中那位玩家（不會先打到同伴）', () => {
  let shots = 0;
  for (let i = 0; i < SNIPERS; i++) {
    for (let j = 0; j < 4; j++) {
      const m = grove(4);
      const s = m.enemies[i], p = m.players[j];
      assert(hasLineOfSight(m.world, s, p), `${s.id} sees ${p.id}`);
      const r = m.resolveShot(s, 'sniper', exactAngle(s, p), 100);
      assert(r.hit.entityId === p.id, `${s.id} → ${p.id} hit ${r.hit.type} ${r.hit.entityId}`);
      assert(m.enemies.every(e => e.hp === e.maxHp), `${s.id} → ${p.id} hurt an ally`);
      shots++;
    }
  }
  return { shots };
});

test('狙擊手的 AI：只用狙擊槍、不走動，角度誤差在 ±sniperSpread 內（不是一般敵人的 1.2°）', () => withConfig(
  { SNIPER: { sniperSpread: 3 } }, () => {
    let maxErr = 0, n = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const m = grove(2, { seed });
      const s = m.enemies[seed % SNIPERS];
      const x0 = s.x;
      const { walk, plan } = m.planAiTurn(s);
      assert(walk === null && s.x === x0, `seed ${seed}: sniper walked`);
      assert(plan && plan.weapon === 'sniper' && plan.power === 100, `seed ${seed}: plan ${JSON.stringify(plan)}`);
      const err = Math.abs(plan.angle - exactAngle(s, m.byId(plan.targetId)));
      assert(err <= 3 + 1e-9, `seed ${seed}: error ${err}`);
      maxErr = Math.max(maxErr, err);
      n++;
    }
    assert(maxErr > 2, `spread looks like the default 1.2°: max ${maxErr}`);
    return { plans: n, maxErr: +maxErr.toFixed(2) };
  }));

test('只有狙擊槍的射手先挑打得到的人：躲進坑裡（血最少）的玩家不會被瞄；只剩他時才打他', () => {
  const setup = (seed) => {
    const m = grove(2, { seed });
    const [p1, p2] = m.players;
    for (const [x, y] of [[50, 550], [50, 585]]) m.terrain.carve(x, y, 34);
    p1.x = 50; p1.y = 500;
    m.settle(600);
    p1.hp = 10;   // 血最少：沒過濾的話七成會被挑
    return { m, p1, p2 };
  };
  const { m: m0, p1: hidden } = setup(1);
  assert(hidden.alive && m0.enemies.every(s => !hasLineOfSight(m0.world, s, hidden)), 'precondition: p1 is hidden from every sniper');
  const rng = new Rng(9);
  for (let seed = 1; seed <= 80; seed++) {
    const { m, p2 } = setup(seed);
    const plan = planShot(m.world, m.enemies[seed % SNIPERS], rng);
    assert(plan.targetId === p2.id, `seed ${seed}: aimed at the hidden player`);
  }
  const { m, p1, p2 } = setup(3);
  p2.die('hit');
  const plan = planShot(m.world, m.enemies[0], rng);
  assert(plan && plan.weapon === 'sniper' && plan.targetId === p1.id, 'nobody visible → still shoots the hidden one');
});

test('裁判流程：玩家都不動（超時），狙擊手每回合用狙擊槍、不走動，最後全滅結束', () => withConfig(
  { PLAYER: { hp: 150 }, SNIPER: { hp: 30, sniperSpread: 3 } }, () => {
    const m = grove(2, { seed: 4 });
    const io = new FakeIo();
    let over = null;
    const ref = new Referee({ match: m, humans: mkPlayers(2), io, onGameOver: (r) => { over = r; } });
    ref.start();
    const start = io.t;
    while (!over && io.t - start < 20_000_000) io.advance(500);
    assert(over === 'lose', 'game ended with ' + over);
    const ai = io.take('aiTurn');
    assert(ai.length >= 4, 'snipers took turns: ' + ai.length);
    assert(ai.every(a => a.walk === null && a.shot && a.shot.weapon === 'sniper'), 'every sniper turn is a sniper shot without walking');
    assert(m.enemies.every(s => s.alive && s.onGround), 'snipers are still on their branches');
    return { sniperTurns: ai.length, rounds: ref.round };
  }));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
