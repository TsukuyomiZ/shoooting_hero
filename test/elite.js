// node test/elite.js
// 2026-10-08：新的關卡種類「菁英關」與菁英關地圖「地心探險」（獨眼巨人）。
// 關卡種類（stageType：Boss 關優先、菁英關、小關）、一場冒險在第 3、8 關抽菁英池、開場 / 選牌 / 結束的訊息與紀錄帶種類、
// 打贏菁英關的選牌稀有度權重加成（只有那一次）、菁英關照小關的規則（血量、狂熱）；
// 獨眼巨人：站在最右邊的岩柱上不動、血量照一般敵人放大、下一招事先抽好（權重、鐘乳石掉光時猛捶變少）、
// 猛捶（鐘乳石全部震下來、砸人、不砸他自己、衝擊只打他那根岩柱上的人、往外推）、巨石投擲（打最近的人、傷害 / 擊退、誤差）、
// 玩家打下來的鐘乳石砸得到他、快照重建、客戶端照事件重播一致、裁判流程與紀錄、真的 GameView 播一段
import { CONFIG } from '../shared/config.js';
import { LEVELS, levelsInPool } from '../shared/level.js';
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { Run } from '../shared/run.js';
import { rarityWeights, drawOffers, validateCards } from '../shared/cards.js';
import { Rng } from '../shared/rng.js';
import { stageType, isEliteStage, isBossStage, stageRules } from '../shared/stage-rules.js';
import { aimBoulder, poundLane, planCyclopsNext } from '../shared/cyclops.js';
import { replayChecked } from './replay-check.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = validateCards(JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/cards.json'), 'utf8')));
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
  take(type) { return this.log.filter(m => m.t === type); }
}
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const make = (n = 1, opts = {}) => new Match({ levelId: 'depths', players: mkPlayers(n), seed: 1, ...opts });
// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原（WEAPONS 整個換成這裡的版本）
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
  ENEMY_HP_PER_EXTRA_PLAYER: undefined,
  RUN: { stageCount: 10, bossStages: [5, 10], eliteStages: [3, 8], enemyHpPerStage: 0.15, eliteRarityBonus: { white: 0, green: 10, purple: 5, gold: 1 } },
  CYCLOPS: { hp: 150, weights: { pound: 40, throw: 60 }, poundBareFactor: 0.5, aimError: { angle: 3, power: 6 } },
  CAVE: { torchReach: 24, torchPass: 10 },
  PLAYER: { hp: 150 }, WATER: { damagePct: 30, enemiesDrown: true }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180 },
    sniper: { ...CONFIG.WEAPONS.sniper, damage: 15, radius: 10, knockback: 90 },
    stalactite: { ...CONFIG.WEAPONS.stalactite, damage: 30, radius: 0, gravity: 900, hitRadius: 14 },
    cyclopsShock: { ...CONFIG.WEAPONS.cyclopsShock, damage: 25, knockback: 150, radius: 0, gravity: 0, hitRadius: 8, pierce: true, passTerrain: true, passAllies: true },
    cyclopsBoulder: { ...CONFIG.WEAPONS.cyclopsBoulder, damage: 40, radius: 0, gravity: 600, knockback: 120 },
  },
};
delete BASE.ENEMY_HP_PER_EXTRA_PLAYER;
const base = (fn, extra = {}) => {
  const patch = { ...BASE };
  for (const [k, v] of Object.entries(extra)) patch[k] = { ...(BASE[k] || {}), ...v };
  return withConfig(patch, fn);
};
const angleTo = (s, x, y) => { const m = s.muzzle(); return Math.atan2(-(y - m.y), x - m.x) * 180 / Math.PI; };
// 把角色放到 (x, y) 附近站好
function placeOn(m, e, x, y) {
  e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.onGround = false;
  for (let i = 0; i < 400 && !e.onGround; i++) e.update(CONFIG.FIXED_DT, m.world);
  e.safeX = e.x; e.safeY = e.y;
}
// 照預定的招式讓巨人出一招（不經過裁判）
function cyclopsTurn(m, action) {
  m.mechState.next = { action };
  return m.planAiTurn(m.byId('cyclops')).boss;
}
// 重播後地形遮罩、每個角色、洞穴 / 巨人的狀態都跟伺服器一樣
function assertSame(m, c, label) {
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(c.terrain.mask)) === 0, `${label}: terrain differs`);
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${label}: entities differ`);
  assert(J(m.mechState.lit) === J(c.mechState.lit) && J(m.mechState.fallen) === J(c.mechState.fallen), `${label}: cave state differs`);
}

// ---------------- 關卡種類 ----------------

await test('關卡種類：第 3、8 關是菁英關、第 5、10 關是 Boss 關，其他是小關；跟 Boss 關重疊的算 Boss 關；地圖池 elite 只有地心探險', () => base(() => {
  const types = Array.from({ length: 10 }, (_, i) => stageType(i + 1));
  assert(types.join() === 'normal,normal,elite,normal,boss,normal,normal,elite,normal,boss', 'types ' + types);
  const overlap = { ...CONFIG, RUN: { ...CONFIG.RUN, eliteStages: [2, 5], bossStages: [5] } };
  assert(stageType(5, overlap) === 'boss' && !isEliteStage(5, overlap) && isBossStage(5, overlap) && stageType(2, overlap) === 'elite', 'boss wins over elite');
  assert(J(levelsInPool('elite')) === '["depths"]' && LEVELS.depths.name === '地心探險', 'elite pool');
  assert(!levelsInPool('normal').includes('depths') && !levelsInPool('boss').includes('depths'), 'only in the elite pool');
  // 菁英關照小關的規則：血量吃人數 × 關數、有狂熱
  const r = stageRules({ stage: 3, players: 2, pool: 'elite' });
  const n = stageRules({ stage: 3, players: 2, pool: 'normal' });
  assert(r.enemyHp === n.enemyHp && r.feverEvery === n.feverEvery && r.feverEvery > 0 && r.enemyDamage === n.enemyDamage, 'elite = normal rules');
  return { types };
}));

// ---------------- 冒險流程 ----------------

await test('一場冒險：第 3、8 關打地心探險；開場的 stageInfo、stage.start 紀錄、picks（下一關）、stageClear（這一關 / 下一關 / 獎勵）、runOver 都帶關卡種類', () => base(() => {
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(2), seed: 3, io, cards: CARDS.cards });
  run.start();
  const levels = [];
  let guard = 0;
  while (run.phase !== 'over' && guard++ < 1000) {
    io.advance(200);
    if (run.phase === 'battle' && run.referee.phase === 'turn') {
      const id = run.match.levelId + '#' + run.stage;
      if (levels.at(-1) !== id) levels.push(id);
      for (const e of run.match.enemies) e.die('hit');
      io.advance(31_000);
    }
    if (run.phase === 'pick') {
      run.handle('p1', { t: 'pick', cardId: run.offers.p1[0].id });
      io.advance(CONFIG.RUN.pickTime * 1000 + 100);
    }
  }
  assert(run.phase === 'over' && run.result === 'win', 'won');
  const ids = levels.map(l => l.split('#')[0]);
  assert(ids[2] === 'depths' && ids[7] === 'depths' && ids.filter(id => id === 'depths').length === 2, 'elite stages: ' + levels.join());
  assert(J(run.elitesUsed) === '["depths","depths"]', 'elitesUsed ' + J(run.elitesUsed));
  const starts = io.take('start');
  assert(starts.map(s => s.stageInfo.type).join() === 'normal,normal,elite,normal,boss,normal,normal,elite,normal,boss', 'start types');
  assert(starts[2].stageInfo.isBoss === false && starts[4].stageInfo.isBoss === true, 'isBoss kept');
  const recs = io.records.filter(r => r.ev === 'stage.start');
  assert(recs.map(r => r.type).join() === starts.map(s => s.stageInfo.type).join(), 'stage.start logs the type');
  const picks = io.take('picks');
  assert(picks.map(p => p.nextType).join() === 'normal,elite,normal,boss,normal,normal,elite,normal,boss', 'picks.nextType ' + picks.map(p => p.nextType));
  const sc = io.take('stageClear');
  assert(sc[2].type === 'elite' && J(sc[2].bonus) === J(CONFIG.RUN.eliteRarityBonus) && sc[2].nextType === 'normal', 'elite stageClear: ' + J({ type: sc[2].type, bonus: sc[2].bonus }));
  assert(sc[1].nextType === 'elite' && sc[1].bonus === null && sc[3].nextType === 'boss', 'other stageClear');
  assert(sc.filter(m => m.bonus).length === 2 && sc[7].type === 'elite' && sc[7].bonus, 'bonus only after the two elite stages');
  const offers = io.records.filter(r => r.ev === 'pick.offer');
  assert(offers.filter(r => r.bonus).map(r => r.stage).join() === '3,8' && offers.every(r => !r.bonus || r.type === 'elite'), 'pick.offer logs the bonus');
  const over = io.take('runOver')[0];
  assert(over.type === 'boss', 'runOver.type ' + over.type);
  return { levels: ids.join() };
}));

await test('打贏菁英關的獎勵：綠 / 紫 / 金的機率各多 10 / 5 / 1 個百分點、從白卡扣（第 3、8 關都是，不會被稀釋）；抽出來的稀有牌真的比較多', () => base(() => {
  const share = (w) => { const t = Object.values(w).reduce((s, x) => s + x, 0); return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, 100 * v / t])); };
  const out = {};
  for (const stage of [3, 8]) {
    const s0 = share(rarityWeights(stage)), s1 = share(rarityWeights(stage, CONFIG.RUN.eliteRarityBonus));
    const d = Object.fromEntries(Object.keys(s0).map(k => [k, +(s1[k] - s0[k]).toFixed(6)]));
    assert(d.green === 10 && d.purple === 5 && d.gold === 1 && d.white === -16, `stage ${stage}: +${J(d)}`);
    out[stage] = d;
  }
  // 白卡不夠扣：照比例少加、白卡扣到 0，總權重不變，加成的稀有度一個都不會變少（第 12 關這種白卡快沒了的也一樣）
  for (const cfg of [{ rarityWeights: { white: 5, green: 50, purple: 40, gold: 5 } }, { stageCount: 20 }]) {
    withConfig({ RUN: { ...CONFIG.RUN, ...cfg } }, () => {
      for (const stage of [1, 10, 11, 12, 15]) {
        const a = rarityWeights(stage), b = rarityWeights(stage, CONFIG.RUN.eliteRarityBonus);
        const sa = share(a), sb = share(b);
        const tot = (o) => Object.values(o).reduce((s, x) => s + x, 0);
        assert(b.white >= 0 && Math.abs(tot(a) - tot(b)) < 1e-9, `stage ${stage}: total kept ${tot(a)} vs ${tot(b)}`);
        for (const r of ['green', 'purple', 'gold']) assert(sb[r] >= sa[r] - 1e-9, `stage ${stage} ${r}: ${sa[r]} → ${sb[r]}`);
      }
    });
  }
  const rareShare = (bonus) => {
    const rng = new Rng(7);
    let rare = 0, all = 0;
    for (let k = 0; k < 600; k++) {
      for (const c of drawOffers(CARDS.cards, rng, 3, 3, [], null, { rarityBonus: bonus })) { all++; if (c.rarity !== 'white') rare++; }
    }
    return rare / all;
  };
  const plain = rareShare(null), elite = rareShare(CONFIG.RUN.eliteRarityBonus);
  assert(elite > plain + 0.1, `rare share ${plain.toFixed(3)} → ${elite.toFixed(3)}`);
  return { pointsUp: out[3], rareShare: { normal: +plain.toFixed(3), elite: +elite.toFixed(3) } };
}));

// ---------------- 地心探險：地圖與巨人 ----------------

await test('地心探險：玩家站在左邊高台、巨人站在右邊岩柱上（不動、不會被擊退）；三根岩柱中間是水；血量照一般敵人放大；開場就抽好第一招', () => base(() => {
  for (const [n, stage] of [[1, 3], [3, 3], [2, 8]]) {
    const m = make(n, { stage });
    const cy = m.byId('cyclops');
    const L = LEVELS.depths.mechanic;
    assert(cy && cy.fixed && cy.part === 'cyclops' && cy.team === 'enemies' && !cy.optional && !cy.boss, 'cyclops entity');
    assert(cy.x === L.cyclops.x && cy.y === L.cyclops.y && m.terrain.isHard(cy.x, cy.y + 2), 'stands on his hard pillar');
    assert(cy.hp === Math.round(150 * m.rules.enemyHp) && cy.maxHp === cy.hp, `hp ${cy.hp} vs ${150 * m.rules.enemyHp}`);
    assert(J(Object.keys(m.mechState)) === '["def","lit","fallen","next"]' && ['pound', 'throw'].includes(m.mechState.next.action), 'state + first move');
    for (const p of m.players) assert(p.onGround && p.y < 260 && p.x < 330, `${p.id} on the left plateau`);
    assert(m.terrain.stalactites.length === 5 && J(m.mechState.lit) === '[true,false,false]', 'five stalactites, spawn torch lit');
  }
  // 中間的水：兩個缺口都掉得進水裡
  const m = make(1);
  for (const x of [390, 710]) assert(!m.terrain.isSolid(x, 600) && !m.terrain.isSolid(x, 200), `gap at ${x}`);
  const cy = m.byId('cyclops');
  const x0 = cy.x;
  m.applyExplosion(cy.x - 10, cy.cy, CONFIG.WEAPONS.cannon, m.byId('p1'), cy);
  for (let i = 0; i < 120; i++) m.step();
  assert(cy.x === x0 && cy.hp < cy.maxHp, 'a cannon hit hurts but does not move him');
}));

await test('跳得過去：左高台 → 中岩柱、中岩柱 → 巨人的岩柱（往右助跑跳）；往回跳不上去', () => base(() => {
  const jump = (fromX, fromY, dir) => {
    const m = make(1);
    const p = m.byId('p1');
    placeOn(m, p, fromX, fromY);
    p.moveDir = dir;
    p.wantJump = true;
    let landed = null;
    for (let i = 0; i < 240 && !landed; i++) {
      m.step();
      if (i > 5 && p.onGround) landed = { x: Math.round(p.x), y: Math.round(p.y) };
      if (p.waterFalls) return 'water';
    }
    return landed;
  };
  const a = jump(325, 240, 1), b = jump(646, 330, 1), back = jump(452, 330, -1);
  assert(a && a !== 'water' && a.x > 440 && a.y < 345, 'left → middle: ' + J(a));
  assert(b && b !== 'water' && b.x > 770 && b.y >= 430, 'middle → right: ' + J(b));
  assert(back === 'water' || (back && back.x > 440), 'cannot jump back up: ' + J(back));
  // 岩柱的側面沒有站得住的地方：貼著每一面牆往下掉，一定掉進水裡
  const walls = { plateauRight: [339, 280], middleLeft: [436, 360], middleRight: [658, 360], rightLeft: [762, 450] };
  for (const [name, [x, y]] of Object.entries(walls)) {
    const m = make(1);
    const p = m.byId('p1');
    p.x = x; p.y = y; p.vx = 0; p.vy = 0; p.onGround = false;
    let fell = false;
    for (let i = 0; i < 300 && !fell; i++) { p.update(CONFIG.FIXED_DT, m.world); fell = p.waterFalls > 0; }
    assert(fell, `${name}: stuck on the wall at ${Math.round(p.x)},${Math.round(p.y)}`);
  }
  return { a, b };
}));

await test('下一招：照權重抽（兩種都會出現）；鐘乳石掉光之後猛捶變少（poundBareFactor）；權重 0 的不會出現', () => base(() => {
  const count = (fallAll, factor) => withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, poundBareFactor: factor } }, () => {
    const m = make(1);
    if (fallAll) for (let k = 0; k < 5; k++) m.terrain.dropStalactite(k);
    let pound = 0;
    for (let i = 0; i < 2000; i++) if (planCyclopsNext(m).action === 'pound') pound++;
    return pound / 2000;
  });
  const full = count(false, 0.5), bare = count(true, 0.5), none = count(true, 0);
  assert(Math.abs(full - 0.4) < 0.04, 'pound ≈ 40%: ' + full);
  assert(Math.abs(bare - 0.2 / 0.8) < 0.04, 'bare pound ≈ 25%: ' + bare);
  assert(none === 0, 'factor 0 → never pound when bare');
  return { full, bare };
}));

// ---------------- 猛捶 ----------------

await test('猛捶：天花板上的鐘乳石全部震下來（衝擊第一幀的事件帶 falls / adds）、砸到下面的玩家 30 × 敵人倍率、不會砸到巨人自己；再捶一次就沒有可以震的了', () => base(() => {
  const m = make(3, { seed: 4 });
  const cy = m.byId('cyclops');
  const p2 = m.byId('p2');
  const k0 = m.terrain.stalactites[0];
  assert(Math.abs(p2.x - k0.tip.x) < p2.hw + 14, 'P2 stands under the leftmost stalactite');
  const hp0 = p2.hp, cyHp = cy.hp;
  const boss = cyclopsTurn(m, 'pound');
  const step = boss.steps[0];
  assert(step.action === 'pound' && step.shot && step.shot.weapon === 'cyclopsShock' && step.shot.projectiles.length === 2, 'pound step: ' + J(step.action));
  const first = step.shot.events[0];
  assert(first.f === 1 && J(first.falls) === '[0,1,2,3,4]' && first.adds.length === 5 && first.adds.every(a => a.w === 'stalactite' && a.passAllies), 'all fall at once: ' + J(first));
  assert(m.terrain.fallen.size === 5 && J(m.mechState.fallen) === '[0,1,2,3,4]', 'removed from the mask');
  const rock = step.shot.events.find(ev => ev.target === 'p2');
  assert(rock && rock.damages[0].dmg === 30 * 0.7 && p2.hp === hp0 - 21, 'the rock hits P2 for 21: ' + J(rock));
  assert(cy.hp === cyHp && !step.shot.events.some(ev => ev.target === 'cyclops'), 'his own rocks do not hit him');
  // 客戶端重播
  const c = make(3, { seed: 4 });
  c.mechState.next = { action: 'pound' };
  replayChecked(c, JSON.parse(J(step.shot)), 'pound');
  c.applyEntities(step.shot.results);
  assertSame(m, c, 'pound');
  // 再捶一次：沒有鐘乳石可以震了，只剩衝擊
  const again = cyclopsTurn(m, 'pound').steps[0];
  assert(!again.shot.events.some(ev => ev.falls) && again.shot.events.every(ev => ev.type !== 'pass'), 'nothing left to shake');
  return { rockHitAt: rock.f };
}));

await test('猛捶的衝擊：只打站在巨人那根岩柱上的玩家（25 × 敵人倍率，往外推），中岩柱 / 左高台上的人不會被打到', () => base(() => {
  const m = make(3, { seed: 2 });
  for (let k = 0; k < 5; k++) m.terrain.dropStalactite(k);   // 先把鐘乳石拿掉，只看衝擊
  const [p1, p2, p3] = m.players;
  placeOn(m, p2, 560, 330);   // 中岩柱
  placeOn(m, p3, 860, 420);   // 巨人的岩柱（巨人左邊）
  const hp = m.players.map(p => p.hp);
  const step = cyclopsTurn(m, 'pound').steps[0];
  const hits = step.shot.events.filter(ev => ev.target);
  assert(hits.length === 1 && hits[0].target === 'p3' && hits[0].type === 'pierce', 'only P3: ' + J(hits.map(h => [h.target, h.type])));
  assert(hits[0].damages[0].dmg === Math.round(25 * 0.7) && p3.hp === hp[2] - hits[0].damages[0].dmg && p1.hp === hp[0] && p2.hp === hp[1], 'damage ' + J(m.players.map(p => p.hp)));
  // 推往外（巨人在右邊 → 往左），擊退照 150
  const c = make(3, { seed: 2 });
  for (let k = 0; k < 5; k++) c.terrain.dropStalactite(k);
  placeOn(c, c.players[1], 560, 330);
  placeOn(c, c.players[2], 860, 420);
  c.mechState.next = { action: 'pound' };
  let pushed = null;
  replayChecked(c, JSON.parse(J(step.shot)), 'shock', { event: (ev) => { if (ev.target === 'p3') pushed = c.byId('p3').vx; } });
  assert(pushed < -100, 'pushed away from him: vx ' + pushed);
  const lane = poundLane(m);
  assert(lane.x0 === LEVELS.depths.mechanic.ledge.x0 && lane.y < LEVELS.depths.mechanic.ledge.y, 'lane on the ledge');
  // 衝擊跑到岩柱的兩端就停（range），不會穿過去打到別根岩柱上的人
  const ends = step.shot.events.filter(ev => ev.type === 'range').map(ev => Math.round(ev.x)).sort((a, b) => a - b);
  assert(ends.length === 2 && Math.abs(ends[0] - lane.x0) <= 24 && Math.abs(ends[1] - lane.x1) <= 24, 'stops at the ledge ends: ' + ends);
  return { vx: Math.round(pushed), ends };
}));

await test('猛捶的衝擊：只打他那根岩柱上的人——中岩柱炸出深坑、人站在衝擊的高度也打不到；站在巨人腳邊（兩道都碰得到）也只挨一次', () => base(() => {
  const m = make(2, { seed: 2 });
  for (let k = 0; k < 5; k++) m.terrain.dropStalactite(k);
  const [p1, p2] = m.players;
  m.terrain.carve(550, 360, 42);
  m.terrain.carve(550, 400, 42);
  placeOn(m, p2, 550, 380);
  assert(p2.y > 418 && p2.y < 464, 'P2 stands at shock height in the crater: ' + p2.y);
  placeOn(m, p1, m.byId('cyclops').x, 420);   // 跟巨人站在一起（兩道衝擊的出發點）
  const hp = [p1.hp, p2.hp];
  const step = cyclopsTurn(m, 'pound').steps[0];
  const hits = step.shot.events.filter(ev => ev.target);
  assert(!hits.some(h => h.target === 'p2') && p2.hp === hp[1], 'crater on the middle pillar is safe: ' + J(hits.map(h => [h.target, Math.round(h.x)])));
  assert(hits.filter(h => h.target === 'p1').length === 1 && p1.hp === hp[0] - Math.round(25 * 0.7), 'standing at his feet: hit once: ' + J(hits.map(h => h.target)));
  const c = make(2, { seed: 2 });
  for (let k = 0; k < 5; k++) c.terrain.dropStalactite(k);
  c.terrain.carve(550, 360, 42);
  c.terrain.carve(550, 400, 42);
  placeOn(c, c.players[1], 550, 380);
  placeOn(c, c.players[0], c.byId('cyclops').x, 420);
  c.mechState.next = { action: 'pound' };
  replayChecked(c, JSON.parse(J(step.shot)), 'shock at his feet');
  c.applyEntities(step.shot.results);
  assertSame(m, c, 'shock at his feet');
}));

await test('玩家打下巨人頭上的鐘乳石：砸到巨人 30（玩家的攻擊）；巨人的血量、擊殺照算', () => base(() => {
  const m = make(1);
  const p = m.byId('p1');
  const cy = m.byId('cyclops');
  const s = m.terrain.stalactites[4];
  const hp = cy.hp;
  let shot = null;
  for (const dy of [14, 20, 26, 32]) {   // 從左邊高台打得到那根的哪一段（天花板擋住的就換一段）
    const mm = make(1);
    const pp = mm.byId('p1');
    const sh = mm.resolveShot(pp, 'sniper', angleTo(pp, s.tip.x, s.tip.y - dy), 100);
    if (sh.events.some(ev => ev.falls && ev.falls.includes(4))) { shot = { dy }; break; }
  }
  assert(shot, 'some sniper line reaches the stalactite over him');
  const real = m.resolveShot(p, 'sniper', angleTo(p, s.tip.x, s.tip.y - shot.dy), 100);
  const rock = real.events.find(ev => ev.target === 'cyclops' && ev.p === 1);
  assert(rock && rock.damages[0].dmg === 30 && cy.hp === hp - 30, 'the rock hits him for 30: ' + J(rock));
  const c = make(1);
  replayChecked(c, JSON.parse(J(real)), 'player rock');
  c.applyEntities(real.results);
  assertSame(m, c, 'player rock');
}));

// ---------------- 巨石投擲 ----------------

await test('巨石投擲：瞄離巨人最近的玩家；不加誤差時一定砸得到（左高台、中岩柱都一樣），40 × 敵人倍率、擊退 120、不挖坑；重播一致', () => base(() => {
  const out = [];
  for (const where of ['plateau', 'middle']) {
    const m = make(2, { seed: 6 });
    const [p1, p2] = m.players;
    if (where === 'middle') placeOn(m, p1, 560, 330);
    const near = where === 'middle' ? p1 : p2;
    const holes = m.terrain.holes.length;
    const hp = near.hp;
    const boss = withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, aimError: { angle: 0, power: 0 } } }, () => cyclopsTurn(m, 'throw'));
    const step = boss.steps[0];
    assert(step.action === 'throw' && step.targetId === near.id && step.shot.weapon === 'cyclopsBoulder', `${where}: targets ${step.targetId}`);
    const hit = step.shot.events.find(ev => ev.target);
    assert(hit && hit.target === near.id && hit.damages[0].dmg === 40 * 0.7 && near.hp === hp - 28 && !hit.carve, `${where}: hits for 28: ` + J(hit));
    // 擊退 120：照撞擊點到身體中心的方向（水平分量 = 120 × 方向的 x）
    const st = hit.ents.find(s => s.id === near.id);
    const dx = st.x - hit.x, dy = st.y - near.h / 2 - hit.y, d = Math.sqrt(dx * dx + dy * dy);
    const wantVx = dx / d * 120;
    assert(m.terrain.holes.length === holes, 'no crater');
    const c = make(2, { seed: 6 });
    if (where === 'middle') placeOn(c, c.players[0], 560, 330);
    c.mechState.next = { action: 'throw' };
    let kick = null;
    replayChecked(c, JSON.parse(J(step.shot)), 'throw', { event: (ev) => { if (ev.target === near.id) kick = c.byId(near.id).vx; } });
    assert(Math.abs(kick - wantVx) < 1e-6 && kick < 0, `knockback 120 along the hit direction: vx ${kick} vs ${wantVx}`);
    out.push({ where, angle: Math.round(step.shot.angle), power: Math.round(step.shot.power) });
  }
  return out;
}));

await test('巨石投擲：腳邊 / 身後（他那根岩柱上、右邊）的人也砸得到，巨石不會砸到巨人自己', () => base(() => {
  const out = {};
  for (const x of [800, 900, 950, 955, 960, 1000]) {   // 950 ~ 960 = 站在他腳邊（只有幾乎垂直往上丟才砸得到）
    const m = make(1, { seed: 3 });
    const p = m.byId('p1');
    placeOn(m, p, x, 420);
    const cy = m.byId('cyclops');
    const a = aimBoulder(m, cy, p);
    assert(a.score === 0, `x ${x}: exact aim finds a hit: ` + J(a));
    const hp = cy.hp;
    const step = withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, aimError: { angle: 0, power: 0 } } }, () => cyclopsTurn(m, 'throw')).steps[0];
    assert(step.shot.events.some(ev => ev.target === 'p1') && !step.shot.events.some(ev => ev.target === 'cyclops') && cy.hp === hp, `x ${x}: hits P1, not himself`);
    out[x] = { angle: Math.round(a.angle), power: a.power };
  }
  // 加上誤差也不會砸到自己（往正上方丟的高拋也一樣）
  for (let seed = 1; seed <= 30; seed++) {
    const m = make(1, { seed });
    placeOn(m, m.byId('p1'), 900 + (seed % 5) * 20, 420);
    const step = cyclopsTurn(m, 'throw').steps[0];
    assert(!step.shot.events.some(ev => ev.target === 'cyclops'), `seed ${seed}: the boulder hit him`);
  }
  return out;
}));

await test('巨石投擲的瞄準誤差（CYCLOPS.aimError ±3° / ±6）：從出生點大約五、六成會砸中（不是每發都中，也不會幾乎都落空）', () => base(() => {
  let hits = 0, n = 0;
  for (const players of [1, 2, 4]) {
    for (let seed = 1; seed <= 30; seed++) {
      const m = make(players, { seed });
      const step = cyclopsTurn(m, 'throw').steps[0];
      n++;
      if (step.shot.events.some(ev => ev.target === step.targetId)) hits++;
    }
  }
  assert(hits / n > 0.35 && hits / n < 0.8, `hits ${hits}/${n}`);
  // 不加誤差的瞄準（aimBoulder）本身就打得到
  const m = make(1);
  const a = aimBoulder(m, m.byId('cyclops'), m.byId('p1'));
  assert(a.score === 0 && a.facing === -1 && a.angle > 90, 'exact aim: ' + J(a));
  return { hits: `${hits}/${n}` };
}));

// ---------------- 快照 / 裁判 / 畫面 ----------------

await test('快照：預定的下一招（cyclopsNext）、掉下來的鐘乳石、火把、巨人的血量，重連時照快照重建', () => base(() => {
  const m = make(2, { seed: 5 });
  cyclopsTurn(m, 'pound');
  m.mechState.lit[1] = true;
  m.mechState.next = { action: 'throw' };
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(Object.keys(snap)) === J(['entities', 'holes', 'minions', 'treeNext', 'snakeNext', 'items', 'bees', 'torches', 'fallen', 'cyclopsNext']), 'keys ' + Object.keys(snap));
  const c = make(2, { seed: 5 });
  c.applySnapshot(snap);
  assertSame(m, c, 'snapshot');
  assert(J(c.mechState.next) === '{"action":"throw"}', 'next restored');
  c.mechanic.restore(c, { items: [] });   // 客戶端收到 turn 只帶 items：別的不動
  assert(J(c.mechState.next) === '{"action":"throw"}' && c.terrain.fallen.size === 5, 'partial restore leaves it alone');
}));

await test('裁判流程：玩家都斷線（AI 代打）時一直打到結束；巨人的回合是 boss 招式（猛捶 / 巨石投擲），每一招的紀錄帶廣播裡那一招震下來的 falls', () => base(() => {
  const out = {};
  for (const seed of [2, 7, 11]) {
    const m = make(2, { seed });
    m.mechState.next = { action: 'pound' };   // 第一招一定是猛捶（紀錄一定有 falls 可以比）
    const io = new FakeIo();
    let over = null;
    const ref = new Referee({ match: m, humans: mkPlayers(2), io, onGameOver: (r) => { over = r; } });
    ref.start();
    for (const p of mkPlayers(2)) ref.setConnected(p.id, false);
    while (!over && io.t < 30_000_000) io.advance(500);
    assert(over === 'win' || over === 'lose', `${seed}: ended ${over}`);
    const turns = io.take('aiTurn').filter(t => t.actorId === 'cyclops');
    assert(turns.length >= 1 && turns.every(t => t.boss && t.boss.steps.length === 1 && ['pound', 'throw'].includes(t.boss.steps[0].action)), 'cyclops turns');
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.actor === 'cyclops');
    assert(recs.length === turns.length && recs.every(r => r.boss && r.boss[0].action && r.next), 'logged with next');
    const firstPound = recs.find(r => r.boss[0].action === 'pound');
    assert(firstPound && recs[0] === firstPound, 'the first cyclops move is the planned pound');
    // 每一招的紀錄：falls = 廣播的那一招裡所有事件的 falls（沒有就不帶）
    turns.forEach((t, i) => {
      const sent = t.boss.steps[0].shot.events.flatMap(ev => ev.falls || []);
      const logged = recs[i].boss[0].falls;
      assert(sent.length ? J(logged) === J(sent) : logged === undefined, `turn ${i}: logged ${J(logged)} vs sent ${J(sent)}`);
    });
    assert(J(firstPound.boss[0].falls) === J(turns[0].boss.steps[0].shot.events.flatMap(ev => ev.falls || [])) && firstPound.boss[0].falls.length > 0, 'first pound logs its falls');
    out[seed] = { over, cyclopsTurns: turns.length, pounds: recs.filter(r => r.boss[0].action === 'pound').length };
  }
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

await test('真的 GameView：地心探險從開場播到巨人猛捶與丟巨石（全員 AI 代打；每幀 update + render，含遮光）：客戶端的地形、鐘乳石、下一招跟伺服器一樣；菁英關的橫幅與音樂', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'depths', players, seed: 9, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 3000; }
  m.mechState.next = { action: 'pound' };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 3, stageCount: 10, isBoss: false, type: 'elite', levelId: 'depths', levelName: '地心探險', cards: {} } });
  ref.start();
  for (const p of players) ref.setConnected(p.id, false);
  const view = new GameView(fakeCanvas());
  const tracks = [];
  view.music = { play(t) { tracks.push(t); }, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  assert(view.mapView.type === 'cyclops' && view.banner && view.banner.text === '菁英關：地心探險' && view.banner.sub, 'elite banner: ' + J(view.banner && view.banner.text));
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Set();
  const intro = view.banner;
  let introGone = null, elapsed = 0;
  try {
    for (let k = 0; k < 220 && ref.phase !== 'over'; k++) {
      io.advance(250);
      for (const t of io.log.filter(x => x.t === 'aiTurn' && x.boss)) seen.add(t.boss.steps[0].action);
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        elapsed += CONFIG.FIXED_DT;
        if (introGone === null && view.banner !== intro) introGone = elapsed;
      }
      if (seen.has('pound') && seen.has('throw')) break;
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  // 菁英關的開場橫幅停滿 2.4 秒（第一個回合 1.5 秒就來了，它的橫幅排在後面）
  assert(introGone !== null && introGone >= intro.total - 0.05, `intro banner held ${introGone && introGone.toFixed(2)}s of ${intro.total}s`);
  assert(seen.has('pound'), 'played a pound: ' + [...seen]);
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(view.match.terrain.mask)) === 0, 'client terrain = server');
  assert(J(view.match.mechState.fallen) === J(m.mechState.fallen) && view.match.terrain.fallen.size === m.terrain.fallen.size, 'fallen synced');
  assert(J(view.match.mechState.next) === J(m.mechState.next), 'next synced: ' + J([view.match.mechState.next, m.mechState.next]));
  assert(tracks.filter(Boolean).every(t => t === 'normal' || t === 'fever') && tracks.some(Boolean), 'elite plays the small-stage music: ' + [...new Set(tracks)]);
  return { actions: [...seen], introHeld: +introGone.toFixed(2), time: Math.round(view.time) };
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
