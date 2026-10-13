// node test/elite.js
// 2026-10-08：新的關卡種類「菁英關」與菁英關地圖「地心探險」（獨眼巨人）。
// 關卡種類（stageType：Boss 關優先、菁英關、小關）、一場冒險在第 3、8 關抽菁英池、開場 / 選牌 / 結束的訊息與紀錄帶種類、
// 打贏菁英關的選牌稀有度權重加成（只有那一次）、菁英關照小關的規則（血量、狂熱）；
// 獨眼巨人：站在最右邊的岩柱上（不會被擊退；每回合沿著岩柱走一段，走動在 test/enemy-move.js 測）、血量照一般敵人放大、
// 下一招事先抽好（權重、鐘乳石掉光時猛捶變少）、
// 猛捶（鐘乳石全部震下來、砸人、不砸他自己、衝擊打站最多人的那根岩柱（平手挑離他近的、沒人就打自己那根）、只打那根上的人、往外推
// （站在靠他那一端邊上的人也往外推、不落水）、警示帶畫在那根上）、巨石投擲（打最近的人、傷害 / 擊退、誤差）、
// 玩家打下來的鐘乳石砸得到他、快照重建、客戶端照事件重播一致、裁判流程與紀錄（含猛捶的 ledge / nextLedge）、真的 GameView 播一段
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { Run } from '../shared/game/run.js';
import { rarityWeights, drawOffers, validateCards } from '../shared/cards/cards.js';
import { Rng } from '../shared/core/rng.js';
import { stageType, isEliteStage, isBossStage, stageRules } from '../shared/game/stage-rules.js';
import { aimBoulder, poundLane, planCyclopsNext, pickPoundLedge, ledgeOf } from '../shared/maps/cyclops.js';
import { replayChecked } from './replay-check.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = validateCards(JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/cards/cards.json'), 'utf8')));
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
  // 陰影的傷害加成在 test/cave.js 測（含巨人）：這裡關掉，巨人的傷害照原本的數字
  CAVE: { torchReach: 24, torchPass: 10, torchRounds: 3, torchLight: 270, faintLight: 150, dimLight: 0.45, shadowDamagePct: 0 },
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
// 照預定的招式讓巨人出一招（不經過裁判）。ledge = 猛捶打哪個平台（不給 = 出招時照大家站的位置挑）
function cyclopsTurn(m, action, ledge) {
  m.mechState.next = ledge === undefined ? { action } : { action, ledge };
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

await test('地心探險：玩家站在左邊高台、巨人站在右邊岩柱上（不會被擊退；走動另見 test/enemy-move.js）；三根岩柱中間是水；血量照一般敵人放大；開場就抽好第一招', () => base(() => {
  for (const [n, stage] of [[1, 3], [3, 3], [2, 8]]) {
    const m = make(n, { stage });
    const cy = m.byId('cyclops');
    const L = LEVELS.depths.mechanic;
    assert(cy && cy.fixed && cy.part === 'cyclops' && cy.team === 'enemies' && !cy.optional && !cy.boss, 'cyclops entity');
    assert(cy.x === L.cyclops.x && cy.y === L.cyclops.y && m.terrain.isHard(cy.x, cy.y + 2), 'stands on his hard pillar');
    assert(cy.hp === Math.round(150 * m.rules.enemyHp) && cy.maxHp === cy.hp, `hp ${cy.hp} vs ${150 * m.rules.enemyHp}`);
    assert(J(Object.keys(m.mechState)) === '["def","lit","fallen","next"]' && ['pound', 'throw'].includes(m.mechState.next.action), 'state + first move');
    for (const p of m.players) assert(p.onGround && p.y < 260 && p.x < 330, `${p.id} on the left plateau`);
    assert(m.terrain.stalactites.length === 5 && J(m.mechState.lit) === '[1,null,null]', 'five stalactites, spawn torch lit (round 1)');
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
  const boss = cyclopsTurn(m, 'pound', 2);   // 打他自己那根（衝擊碰不到高台上的人，只看鐘乳石）
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
  const again = cyclopsTurn(m, 'pound', 2).steps[0];
  assert(!again.shot.events.some(ev => ev.falls) && again.shot.events.every(ev => ev.type !== 'pass'), 'nothing left to shake');
  return { rockHitAt: rock.f };
}));

await test('猛捶的衝擊打他自己那根：從腳下往兩邊跑，只打站在巨人那根岩柱上的玩家（25 × 敵人倍率，往外推），中岩柱 / 左高台上的人不會被打到', () => base(() => {
  const m = make(3, { seed: 2 });
  for (let k = 0; k < 5; k++) m.terrain.dropStalactite(k);   // 先把鐘乳石拿掉，只看衝擊
  const [p1, p2, p3] = m.players;
  placeOn(m, p2, 560, 330);   // 中岩柱
  placeOn(m, p3, 860, 420);   // 巨人的岩柱（巨人左邊）
  assert(pickPoundLedge(m, m.byId('cyclops')) === 2, 'one each → his own pillar');
  const hp = m.players.map(p => p.hp);
  const step = cyclopsTurn(m, 'pound').steps[0];   // 沒預定平台：出招時照大家站的位置挑
  assert(step.ledge === 2 && step.shot.projectiles.length === 2, 'his own pillar, two waves: ' + J([step.ledge, step.shot.projectiles.length]));
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
  const lane = poundLane(m, 2);
  assert(lane.x0 === LEVELS.depths.mechanic.ledges[2].x0 && lane.y < LEVELS.depths.mechanic.ledges[2].y, 'lane on the ledge');
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
  // 坑裡的人碰不到衝擊，不算站在中岩柱上：挑的是他自己那根（P1 在上面）
  assert(ledgeOf(m, p2) === -1 && ledgeOf(m, p1) === 2 && pickPoundLedge(m, m.byId('cyclops')) === 2, 'the crater does not count');
  const hp = [p1.hp, p2.hp];
  const step = cyclopsTurn(m, 'pound', 2).steps[0];
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

await test('猛捶挑站最多人的平台（抽到猛捶時就決定，存在 next.ledge）：平手挑離巨人近的、他自己那根最優先；倒下 / 半空中的人不算，都沒人就打自己那根', () => base(() => {
  const LEFT = null, MID = [560, 330], MID2 = [500, 330], RIGHT = [860, 420];
  const pick = (spots, setup) => {
    const m = make(spots.length, { seed: 3 });
    m.players.forEach((p, i) => { if (spots[i]) placeOn(m, p, spots[i][0], spots[i][1]); });
    if (setup) setup(m);
    return { m, i: pickPoundLedge(m, m.byId('cyclops')) };
  };
  assert(pick([LEFT, LEFT, LEFT]).i === 0, 'everyone on the plateau → 0');
  assert(pick([LEFT, MID, MID2]).i === 1, '2 on the middle beat 1 on the plateau');
  assert(pick([LEFT, MID, RIGHT]).i === 2, '1 / 1 / 1 → his own pillar');
  assert(pick([LEFT, MID]).i === 1, 'plateau 1 = middle 1 → the one nearer to him');
  assert(pick([LEFT, LEFT, MID], (m) => { m.players[0].die('test'); m.players[1].die('test'); }).i === 1, 'the fallen do not count');
  assert(pick([LEFT, LEFT], (m) => { for (const p of m.players) { p.y = 120; p.onGround = false; } }).i === 2, 'nobody on a platform → his own pillar');
  // 抽到猛捶的當下就決定好（之後大家怎麼走都打那一根）；巨石投擲不帶平台
  const { m } = pick([LEFT, MID, MID2]);
  const pound = withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, weights: { pound: 1, throw: 0 } } }, () => planCyclopsNext(m));
  assert(J(pound) === '{"action":"pound","ledge":1}', 'planned: ' + J(pound));
  const thr = withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, weights: { pound: 0, throw: 1 } } }, () => planCyclopsNext(m));
  assert(J(thr) === '{"action":"throw"}', 'a throw has no ledge: ' + J(thr));
  // 開場（大家都在左高台）抽到猛捶 = 打左高台
  const m0 = withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, weights: { pound: 1, throw: 0 } } }, () => make(2));
  assert(J(m0.mechState.next) === '{"action":"pound","ledge":0}', 'opening pound: ' + J(m0.mechState.next));
}));

// 衝擊（猛捶那一波的第 0 顆、第 1 顆飛行物；震下來的鐘乳石排在後面）打到誰
const shockHits = (shot) => shot.events.filter(ev => ev.target && ev.p < shot.projectiles.length);

await test('猛捶打別根平台（中岩柱）：衝擊從靠巨人那一端出發、一道跑到另一端就停；只打那根上的人（25 × 敵人倍率、各一次、往外推）；鐘乳石照樣全部震下來；重播一致', () => base(() => {
  const setup = (m) => { placeOn(m, m.players[1], 560, 330); placeOn(m, m.players[2], 620, 330); };
  const m = make(3, { seed: 2 });
  setup(m);
  assert(pickPoundLedge(m, m.byId('cyclops')) === 1, 'the middle pillar has the most');
  const lane = poundLane(m, 1), L = LEVELS.depths.mechanic.ledges[1];
  const step = cyclopsTurn(m, 'pound', 1).steps[0];
  const shot = step.shot;
  const pr = shot.projectiles;
  // 從靠巨人那一端再往他那邊多退一點出發（最胖的玩家半寬 + 衝擊的判定半徑 8 以外，在兩根岩柱中間的半空）
  const lead = pr[0].x - L.x1, hwMax = Math.max(...m.players.map(p => p.hw));
  assert(step.ledge === 1 && pr.length === 1 && lead >= hwMax + 8 && lead <= hwMax + 8 + 4 && pr[0].y === lane.y && pr[0].vx < 0 && pr[0].vy === 0, 'one wave from just past the near end: ' + J(pr));
  const end = shot.events.find(ev => ev.type === 'range' && ev.p === 0);
  assert(end && Math.abs(end.x - L.x0) <= 6, 'stops at the far end: ' + J(end && end.x));
  assert(J(shot.events[0].falls) === '[0,1,2,3,4]', 'stalactites still all fall: ' + J(shot.events[0]));
  const hits = shockHits(shot);
  assert(J(hits.map(h => h.target).sort()) === '["p2","p3"]' && hits.every(h => h.type === 'pierce' && h.damages[0].dmg === Math.round(25 * 0.7)), 'hits P2, P3 once each: ' + J(hits.map(h => [h.target, h.type])));
  // 往外推（巨人在右邊 → 往左），重播一致
  const c = make(3, { seed: 2 });
  setup(c);
  const vx = {};
  replayChecked(c, JSON.parse(J(shot)), 'far shock', { event: (ev) => { if (ev.p === 0 && ev.target) vx[ev.target] = c.byId(ev.target).vx; } });
  assert(vx.p2 < -100 && vx.p3 < -100, 'pushed away from him: ' + J(vx));
  c.applyEntities(shot.results);
  assertSame(m, c, 'far shock');
  return { vx: Object.fromEntries(Object.entries(vx).map(([k, v]) => [k, Math.round(v)])), end: Math.round(end.x) };
}));

await test('猛捶打左高台（開場大家都在那）：衝擊從高台右端往左一路跑到底，四個人各挨一次；重播一致', () => base(() => {
  const m = make(4, { seed: 5 });
  for (let k = 0; k < 5; k++) m.terrain.dropStalactite(k);
  const step = cyclopsTurn(m, 'pound').steps[0];   // 沒預定平台：出招時挑（四個人都在高台）
  const L = LEVELS.depths.mechanic.ledges[0];
  const pr = step.shot.projectiles;
  assert(step.ledge === 0 && pr.length === 1 && pr[0].x > L.x1 + m.players[0].hw + 8 && pr[0].vx < 0, 'plateau, one wave from just past its right end: ' + J(pr));
  const end = step.shot.events.find(ev => ev.type === 'range' && ev.p === 0);
  // 每穿過一個人，那一個子步（約 2px）沒算進飛過的路徑（advanceProjectile），四個人 ≈ 多跑 8px
  assert(end && Math.abs(end.x - L.x0) <= 12, 'runs all the way to the left end: ' + J(end && end.x));
  const hits = shockHits(step.shot);
  assert(J(hits.map(h => h.target).sort()) === '["p1","p2","p3","p4"]', 'everyone once: ' + J(hits.map(h => h.target)));
  const c = make(4, { seed: 5 });
  for (let k = 0; k < 5; k++) c.terrain.dropStalactite(k);
  replayChecked(c, JSON.parse(J(step.shot)), 'plateau shock');
  c.applyEntities(step.shot.results);
  assertSame(m, c, 'plateau shock');
}));

await test('猛捶打別根平台：站在靠巨人那一端邊上（身體中心超出頂面一點點，也算站在上面）的人照樣往外（往左）推、不會被推回他那邊的水裡；擊退照撞擊點 → 身體中心、150；重播一致', () => base(() => {
  const out = {};
  for (const [ledge, x, y] of [[0, 326, 240], [0, 330, 240], [1, 650, 330]]) {
    const label = `ledge ${ledge} x ${x}`;
    const setup = (mm) => { for (let k = 0; k < 5; k++) mm.terrain.dropStalactite(k); placeOn(mm, mm.players[0], x, y); };
    const m = make(1, { seed: 2 });
    setup(m);
    const p = m.players[0];
    const L = LEVELS.depths.mechanic.ledges[ledge];
    const x0 = p.x, hp = p.hp;
    assert(p.onGround && ledgeOf(m, p) === ledge && x0 > L.x1, `${label}: stands on the ledge past its near end: ` + J([ledgeOf(m, p), p.x, p.y]));
    const step = cyclopsTurn(m, 'pound', ledge).steps[0];
    const hits = shockHits(step.shot);
    assert(step.ledge === ledge && hits.length === 1 && hits[0].target === 'p1' && hits[0].x > x0, `${label}: hit once from his side: ` + J(hits.map(h => [h.target, h.x])));
    // 擊退跟別的地方一樣：撞擊點 → 身體中心的方向 × 150（沒有另外改力道）
    const st = hits[0].ents.find(s => s.id === 'p1');
    const dx = st.x - hits[0].x, dy = st.y - p.h / 2 - hits[0].y, d = Math.sqrt(dx * dx + dy * dy);
    const c = make(1, { seed: 2 });
    setup(c);
    let kick = null;
    replayChecked(c, JSON.parse(J(step.shot)), label, { event: (ev) => { if (ev.p === 0 && ev.target === 'p1') kick = c.byId('p1').vx; } });
    assert(Math.abs(kick - dx / d * 150) < 1e-6 && kick < -50, `${label}: pushed left with knockback 150: vx ${kick} vs ${dx / d * 150}`);
    c.applyEntities(step.shot.results);
    assertSame(m, c, label);
    assert(p.alive && p.waterFalls === 0 && p.hp === hp - Math.round(25 * 0.7) && p.x < x0 && ledgeOf(m, p) === ledge,
      `${label}: no splash, lands back on the ledge: ` + J({ x: p.x, y: p.y, wf: p.waterFalls, hp: p.hp }));
    out[label] = { hitX: +hits[0].x.toFixed(1), vx: Math.round(kick), landed: Math.round(p.x) };
  }
  return out;
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
  m.mechState.lit[1] = 1;   // 第 1 輪點燃的
  m.mechState.next = { action: 'pound', ledge: 1 };
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(Object.keys(snap)) === J(['entities', 'holes', 'minions', 'treeNext', 'snakeNext', 'items', 'bees', 'torches', 'fallen', 'cyclopsNext']), 'keys ' + Object.keys(snap));
  const c = make(2, { seed: 5 });
  c.applySnapshot(snap);
  assertSame(m, c, 'snapshot');
  assert(J(c.mechState.next) === '{"action":"pound","ledge":1}', 'next (with the targeted ledge) restored');
  c.mechanic.restore(c, { items: [] });   // 客戶端收到 turn 只帶 items：別的不動
  assert(J(c.mechState.next) === '{"action":"pound","ledge":1}' && c.terrain.fallen.size === 5, 'partial restore leaves it alone');
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
    // 猛捶帶打的平台（廣播的那一招、紀錄都有）；預定的下一招是猛捶的話也帶（玩家回合的警示帶照這個畫，紀錄記在 nextLedge）
    let nextPounds = 0;
    turns.forEach((t, i) => {
      const st = t.boss.steps[0];
      if (st.action === 'pound') assert(Number.isInteger(st.ledge) && recs[i].boss[0].ledge === st.ledge, `turn ${i}: pound ledge ${st.ledge} / logged ${recs[i].boss[0].ledge}`);
      if (t.boss.next && t.boss.next.action === 'pound') {
        nextPounds++;
        assert(Number.isInteger(t.boss.next.ledge) && recs[i].nextLedge === t.boss.next.ledge, `turn ${i}: next pound ledge ${t.boss.next.ledge} / logged ${recs[i].nextLedge}`);
      } else assert(!('nextLedge' in recs[i]), `turn ${i}: a planned throw logs no nextLedge`);
    });
    const firstPound = recs.find(r => r.boss[0].action === 'pound');
    assert(firstPound && recs[0] === firstPound, 'the first cyclops move is the planned pound');
    // 每一招的紀錄：falls = 廣播的那一招裡所有事件的 falls（沒有就不帶）
    turns.forEach((t, i) => {
      const sent = t.boss.steps[0].shot.events.flatMap(ev => ev.falls || []);
      const logged = recs[i].boss[0].falls;
      assert(sent.length ? J(logged) === J(sent) : logged === undefined, `turn ${i}: logged ${J(logged)} vs sent ${J(sent)}`);
    });
    assert(J(firstPound.boss[0].falls) === J(turns[0].boss.steps[0].shot.events.flatMap(ev => ev.falls || [])) && firstPound.boss[0].falls.length > 0, 'first pound logs its falls');
    out[seed] = { over, cyclopsTurns: turns.length, pounds: recs.filter(r => r.boss[0].action === 'pound').length, nextPounds };
  }
  assert(Object.values(out).some(o => o.nextPounds > 0), 'some turn planned a pound next (nextLedge checked): ' + J(out));
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

await test('真的 GameView：地心探險從開場播到巨人猛捶與丟巨石（全員 AI 代打；每幀 update + render，含遮光）：客戶端的地形、鐘乳石、下一招跟伺服器一樣；菁英關的橫幅與音樂（洞穴的曲子）', () => base(() => {
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
  assert(tracks.filter(Boolean).every(t => t === 'cave' || t === 'caveFever') && tracks.includes('cave'), 'elite plays the cave music (cave fever version when fever kicks in): ' + [...new Set(tracks)]);
  return { actions: [...seen], introHeld: +introGone.toFixed(2), time: Math.round(view.time) };
}));

await test('真的 GameView：預定猛捶時，警示帶畫在預定的那個平台（next.ledge）上；巨人捶下去的預兆也畫在那一根，不是他自己那根', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'depths', players, seed: 9, stage: 3 });
  m.mechState.next = { action: 'pound', ledge: 1 };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  // 記下警示帶（填滿的方塊）畫在哪
  const bands = () => {
    const rects = [];
    const inner = fakeCtx2d();
    const ctx = new Proxy(inner, { get: (t, k) => (k === 'fillRect' ? (...a) => rects.push(a.map(Math.round)) : t[k]) });
    view.mapView.drawShade(ctx, view.mapCtx);
    return rects;
  };
  const mid = poundLane(m, 1), own = poundLane(m, 2);
  const isBand = (r, lane) => r[0] === lane.x0 && r[1] === lane.top && r[2] === lane.x1 - lane.x0 && r[3] === lane.bottom - lane.top;
  assert(J(view.match.mechState.next) === '{"action":"pound","ledge":1}', 'client has the plan: ' + J(view.match.mechState.next));
  let r = bands();
  assert(r.some(x => isBand(x, mid)) && !r.some(x => isBand(x, own)), 'player turn: band on the middle pillar: ' + J(r));
  // 玩家都斷線（AI 代打）一路播到巨人舉手（預兆）：警示帶還是那一根
  for (const p of players) ref.setConnected(p.id, false);
  let casting = null;
  for (let k = 0; k < 400 && !casting; k++) {
    io.advance(100);
    feed();
    for (let f = 0; f < 6 && !casting; f++) {
      view.update(CONFIG.FIXED_DT);
      const fx = view.mapCtx.state.fx;
      if (fx && fx.action === 'pound' && fx.phase === 'cast') casting = fx;
    }
  }
  assert(casting && casting.ledge === 1, 'casting the planned pound: ' + J(casting));
  r = bands();
  assert(r.some(x => isBand(x, mid)) && !r.some(x => isBand(x, own)), 'cast: band on the middle pillar: ' + J(r));
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
