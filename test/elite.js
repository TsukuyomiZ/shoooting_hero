// node test/elite.js
// 2026-10-08：新的關卡種類「菁英關」與菁英關地圖「地心探險」（獨眼巨人）。
// 關卡種類（stageType：Boss 關優先、菁英關、小關）、一場冒險在第 3、8 關抽菁英池、開場 / 選牌 / 結束的訊息與紀錄帶種類、
// 打贏菁英關的選牌稀有度權重加成（只有那一次）、菁英關照小關的規則（血量、狂熱）；
// 獨眼巨人：站在最右邊的岩柱上（不會被擊退；每回合沿著岩柱走一段，走動在 test/enemy-move.js 測）、血量照一般敵人放大、
// 地圖（2026-10-19 縮小岩柱之間的距離與高低差：往右、往回都跳得過去）、排程照回合數（封左高台 → 封中岩柱 → 震盪獅吼，不用亂數）、
// 猛捶（照權重抽、鐘乳石掉光時變少；鐘乳石全部震下來、砸人不砸他自己、衝擊打站最多人的平台（平手挑離他近的、沒人就打自己那根）、只打那根上的人、往外推
// （站在靠他那一端邊上的人也往外推、不落水）、不打被封住 / 這回合要封的平台、只剩他那根時不放、警示帶畫在那根上）、
// 超巨石（形狀：頂到天花板、只填空的地方、側面站不住；壓死站在上面的人、壓碎鐘乳石、壓熄火把、鄰近岩柱邊上的人沒事、打不穿炸不壞）、
// 震盪獅吼（擊碎所有超巨石、沒有傷害、水平往外震退 400）、巨石投擲（每個活著的人各一顆、一定砸中（1 ~ 4 人、很多種子與站位）、離他近的先丟、
// 傷害 / 擊退 / 流血、不用亂數、算準的初速）、玩家打下來的鐘乳石砸得到他、快照重建（含封住的平台）、客戶端照事件重播一致、
// 裁判流程與紀錄（猛捶的 ledge / falls、巨石投擲的 targetIds、超巨石的 ledge / killed / rocks / torches、震盪獅吼的 shattered、nextLedge、nextSeal）、
// 真的 GameView 播一段（猛捶的警示帶、超巨石的 HUD / 警示 / 壓扁、震盪獅吼的擊碎 / 震退、巨石投擲的 HUD / 橫幅 / 準星）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { Run } from '../shared/game/run.js';
import { rarityWeights, drawOffers, validateCards } from '../shared/cards/cards.js';
import { Rng } from '../shared/core/rng.js';
import { stageType, isEliteStage, isBossStage, stageRules } from '../shared/game/stage-rules.js';
import { aimBoulder, exactLaunch, specialFor, planCyclopsNext, poundLane, pickPoundLedge, poundLedges, ledgeOf, boulderPoly, boulderSpan, crushedPlayers, sealLedge, shatterBoulders } from '../shared/maps/cyclops.js';
import { standingStalactites } from '../shared/maps/cave.js';
import { BOULDER } from '../shared/physics/terrain.js';
import { advanceProjectile } from '../shared/physics/weapons.js';
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
  CYCLOPS: { hp: 150, weights: { pound: 40, throw: 60 }, poundBareFactor: 0.5, throwGap: 6, sealEvery: 2, sealCast: 2.1, roarCast: 1.3 },
  // 陰影的傷害加成在 test/cave.js 測（含巨人）：這裡關掉，巨人的傷害照原本的數字
  CAVE: { torchReach: 24, torchPass: 10, torchRounds: 3, torchLight: 270, faintLight: 150, dimLight: 0.45, shadowDamagePct: 0 },
  PLAYER: { hp: 150 }, WATER: { damagePct: 30, enemiesDrown: true }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180 },
    sniper: { ...CONFIG.WEAPONS.sniper, damage: 15, radius: 10, knockback: 90 },
    stalactite: { ...CONFIG.WEAPONS.stalactite, damage: 30, radius: 0, gravity: 900, hitRadius: 14 },
    cyclopsShock: { ...CONFIG.WEAPONS.cyclopsShock, damage: 25, knockback: 150, radius: 0, gravity: 0, hitRadius: 8, pierce: true, passTerrain: true, passAllies: true },
    cyclopsRoar: { ...CONFIG.WEAPONS.cyclopsRoar, damage: 0, knockback: 400, radius: 0, gravity: 0, speed: 1500, hitRadius: 6, passTerrain: true, passAllies: true },
    cyclopsBoulder: { ...CONFIG.WEAPONS.cyclopsBoulder, damage: 30, bleed: 5, radius: 0, gravity: 600, knockback: 120, minSpeed: 250, speedPerPower: 6.5, hitRadius: 12 },
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
// 讓巨人出一回合（不經過裁判）：給 action 就照它（extra = { ledge: 猛捶打哪個平台, seal: 一般招式之後還要封哪個平台 }），不給就照排好的下一招
function cyclopsTurn(m, action, extra = {}) {
  if (action) m.mechState.next = { action, ...extra };
  return m.planAiTurn(m.byId('cyclops')).boss;
}
// 重播後地形遮罩、每個角色、洞穴 / 巨人的狀態（火把、掉下來的鐘乳石、封住的平台）都跟伺服器一樣
function assertSame(m, c, label) {
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(c.terrain.mask)) === 0, `${label}: terrain differs`);
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${label}: entities differ`);
  assert(J(m.mechState.lit) === J(c.mechState.lit) && J(m.mechState.fallen) === J(c.mechState.fallen), `${label}: cave state differs`);
  assert(J(m.mechState.sealed) === J(c.mechState.sealed), `${label}: sealed ledges differ`);
}

// ---------------- 關卡種類 ----------------

await test('關卡種類：第 3、8 關是菁英關、第 5、10 關是 Boss 關，其他是小關；跟 Boss 關重疊的算 Boss 關；地圖池 elite 有地心探險、大樹守衛', () => base(() => {
  const types = Array.from({ length: 10 }, (_, i) => stageType(i + 1));
  assert(types.join() === 'normal,normal,elite,normal,boss,normal,normal,elite,normal,boss', 'types ' + types);
  const overlap = { ...CONFIG, RUN: { ...CONFIG.RUN, eliteStages: [2, 5], bossStages: [5] } };
  assert(stageType(5, overlap) === 'boss' && !isEliteStage(5, overlap) && isBossStage(5, overlap) && stageType(2, overlap) === 'elite', 'boss wins over elite');
  assert(J(levelsInPool('elite')) === '["depths","forestGuard","wanderer","tenguPeak"]' && LEVELS.depths.name === '地心探險' && LEVELS.forestGuard.name === '大樹守衛' && LEVELS.wanderer.name === '流浪劍士' && LEVELS.tenguPeak.name === '天狗', 'elite pool ' + J(levelsInPool('elite')));
  for (const id of levelsInPool('elite')) assert(!levelsInPool('normal').includes(id) && !levelsInPool('boss').includes(id), id + ' only in the elite pool');
  // 菁英關照小關的規則：血量吃人數 × 關數、有狂熱
  const r = stageRules({ stage: 3, players: 2, pool: 'elite' });
  const n = stageRules({ stage: 3, players: 2, pool: 'normal' });
  assert(r.enemyHp === n.enemyHp && r.feverEvery === n.feverEvery && r.feverEvery > 0 && r.enemyDamage === n.enemyDamage, 'elite = normal rules');
  return { types };
}));

// ---------------- 冒險流程 ----------------

await test('一場冒險：第 3、8 關從菁英池各抽一張（兩張都打到、不重複）；開場的 stageInfo、stage.start 紀錄、picks（下一關）、stageClear（這一關 / 下一關 / 獎勵）、runOver 都帶關卡種類', () => base(() => {
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
  const elite = levelsInPool('elite');
  assert(elite.includes(ids[2]) && elite.includes(ids[7]) && ids[2] !== ids[7] && ids.filter(id => elite.includes(id)).length === 2, 'elite stages: ' + levels.join());
  assert(J(run.elitesUsed) === J([ids[2], ids[7]]), 'elitesUsed ' + J(run.elitesUsed));
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

await test('地心探險：玩家站在左邊高台、巨人站在右邊岩柱上（不會被擊退；走動另見 test/enemy-move.js）；三根岩柱中間是水；血量照一般敵人放大；開場就排好第一招（巨石投擲）', () => base(() => {
  for (const [n, stage] of [[1, 3], [3, 3], [2, 8]]) {
    const m = make(n, { stage });
    const cy = m.byId('cyclops');
    const L = LEVELS.depths.mechanic;
    assert(cy && cy.fixed && cy.part === 'cyclops' && cy.team === 'enemies' && !cy.optional && !cy.boss, 'cyclops entity');
    assert(cy.x === L.cyclops.x && cy.y === L.cyclops.y && m.terrain.isHard(cy.x, cy.y + 2), 'stands on his hard pillar');
    assert(cy.hp === Math.round(150 * m.rules.enemyHp) && cy.maxHp === cy.hp, `hp ${cy.hp} vs ${150 * m.rules.enemyHp}`);
    assert(J(Object.keys(m.mechState)) === '["def","lit","fallen","next","turns","sealed"]' && J(m.mechState.next) === '{"action":"throw"}', 'state + first move: ' + J(m.mechState.next));
    for (const p of m.players) assert(p.onGround && p.y <= L.ledges[0].y && p.x < L.ledges[0].x1, `${p.id} on the left plateau`);
    assert(m.terrain.stalactites.length === 5 && J(m.mechState.lit) === '[1,null,null]', 'five stalactites, spawn torch lit (round 1)');
  }
  // 中間的水：兩個缺口都掉得進水裡
  const m = make(1);
  for (const x of [366, 668]) assert(!m.terrain.isSolid(x, 600) && !m.terrain.isSolid(x, 200), `gap at ${x}`);
  const cy = m.byId('cyclops');
  const x0 = cy.x;
  m.applyExplosion(cy.x - 10, cy.cy, CONFIG.WEAPONS.cannon, m.byId('p1'), cy);
  for (let i = 0; i < 120; i++) m.step();
  assert(cy.x === x0 && cy.hp < cy.maxHp, 'a cannon hit hurts but does not move him');
}));

await test('岩柱之間縮小了（2026-10-19）：缺口 64px、每根低 40px——左高台 ⇄ 中岩柱 ⇄ 巨人的岩柱，往右、往回都跳得過去；岩柱的側面沒有站得住的地方', () => base(() => {
  const L = LEVELS.depths.mechanic.ledges;
  for (let i = 0; i + 1 < L.length; i++) {
    assert(L[i + 1].x0 - L[i].x1 === 64 && L[i + 1].y - L[i].y === 40, `gap ${i}: ${L[i + 1].x0 - L[i].x1} px wide, ${L[i + 1].y - L[i].y} px lower`);
  }
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
  const out = {
    leftToMid: jump(325, 290, 1), midToRight: jump(628, 330, 1),
    rightToMid: jump(712, 370, -1), midToLeft: jump(406, 330, -1),
  };
  const on = (r, i) => r && r !== 'water' && r.x >= L[i].x0 - 6 && r.x <= L[i].x1 + 6 && Math.abs(r.y - L[i].y) <= 6;
  assert(on(out.leftToMid, 1), 'left → middle: ' + J(out.leftToMid));
  assert(on(out.midToRight, 2), 'middle → right: ' + J(out.midToRight));
  assert(on(out.rightToMid, 1), 'right → middle (back up): ' + J(out.rightToMid));
  assert(on(out.midToLeft, 0), 'middle → left (back up): ' + J(out.midToLeft));
  // 岩柱的側面沒有站得住的地方：貼著每一面牆往下掉，一定掉進水裡
  const walls = { plateauRight: [344, 330], middleLeft: [388, 370], middleRight: [646, 370], rightLeft: [690, 410] };
  for (const [name, [x, y]] of Object.entries(walls)) {
    const m = make(1);
    const p = m.byId('p1');
    p.x = x; p.y = y; p.vx = 0; p.vy = 0; p.onGround = false;
    let fell = false;
    for (let i = 0; i < 300 && !fell; i++) { p.update(CONFIG.FIXED_DT, m.world); fell = p.waterFalls > 0; }
    assert(fell, `${name}: stuck on the wall at ${Math.round(p.x)},${Math.round(p.y)}`);
  }
  return out;
}));

await test('排程照他自己的回合數（不用亂數）：每 2 回合一次，封左高台 → 封中岩柱 → 震盪獅吼，輪完重來；sealEvery 0 = 從來沒有；震盪獅吼的回合沒有一般招式', () => base(() => {
  const m = make(1);
  const short = (sp) => (!sp ? '-' : sp.roar ? 'R' : 'S' + sp.seal);
  const seq = Array.from({ length: 13 }, (_, k) => short(specialFor(m, k + 1)));
  assert(J(seq) === J(['-', 'S0', '-', 'S1', '-', 'R', '-', 'S0', '-', 'S1', '-', 'R', '-']), 'sequence ' + J(seq));
  assert(withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, sealEvery: 0 } }, () => Array.from({ length: 8 }, (_, k) => specialFor(m, k + 1)).every(sp => sp === null)), 'sealEvery 0: never');
  assert(J(withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, sealEvery: 1 } }, () => [1, 2, 3, 4].map(n => short(specialFor(m, n))))) === '["S0","S1","R","S0"]', 'sealEvery 1');
  // 照排好的出（一般招式只丟巨石）：next 跟著回合數往下排
  const a = make(2, { seed: 8 });
  a.byId('cyclops').roam = null;
  const plan = (n) => (n.action === 'roar' ? 'R' : n.action[0].toUpperCase() + (Number.isInteger(n.seal) ? n.seal : ''));
  const plans = [];
  for (let k = 0; k < 6; k++) { plans.push(plan(a.mechState.next)); cyclopsTurn(a); }
  assert(J(plans) === J(['T', 'T0', 'T', 'T1', 'T', 'R']) && a.mechState.turns === 6 && plan(a.mechState.next) === 'T', 'played in order: ' + J(plans));
  return { seq: seq.join(' ') };
}, { CYCLOPS: { weights: { pound: 0, throw: 1 } } }));

// ---------------- 超巨石 ----------------

// 每一格現在是什麼（遮罩值）
const maskAt = (m, x, y) => m.terrain.at(x, y);

await test('超巨石的形狀：從平台頂面一路頂到天花板（中間沒有縫）、只填空的地方（土、天花板、鐘乳石以外都沒動）、兩側越往上越往外撐（貼著外側往下掉一定掉進水裡）；拿掉之後地形一模一樣', () => base(() => {
  const out = {};
  for (const i of [0, 1]) {
    const m = make(1);
    for (const k of standingStalactites(m)) m.terrain.dropStalactite(k);   // 先把鐘乳石拿掉，只看巨石
    const before = Buffer.from(m.terrain.mask);
    const L = LEVELS.depths.mechanic.ledges[i];
    const poly = boulderPoly(m, i), s = boulderSpan(m, i);
    m.terrain.addBoulder(poly);
    let filled = 0;
    for (let k = 0; k < before.length; k++) {
      if (before[k] === m.terrain.mask[k]) continue;
      assert(before[k] === 0 && m.terrain.mask[k] === BOULDER, `ledge ${i}: changed a non-empty pixel at ${k % 1024},${Math.floor(k / 1024)}`);
      filled++;
    }
    // 頂面以上、天花板以下，每一行都塞滿（平台的左右端之間）
    for (let x = Math.ceil(L.x0) + 1; x < L.x1 - 1; x += 3) {
      for (let y = 40; y < L.y; y++) assert(m.terrain.isSolid(x + 0.5, y + 0.5), `ledge ${i}: gap at ${x},${y} (${maskAt(m, x + 0.5, y + 0.5)})`);
    }
    // 兩側（地圖邊那側除外）：貼著外側往下掉，掉進水裡
    for (const side of L.x0 <= 0 ? [1] : [-1, 1]) {
      for (const y of [60, 160, 260]) {
        const mm = make(1);
        mm.terrain.addBoulder(poly);
        const p = mm.byId('p1');
        const edge = side > 0 ? s.x1 : s.x0;
        p.x = edge + side * (p.hw + 2); p.y = y; p.vx = 0; p.vy = 0; p.onGround = false;
        let fell = false;
        for (let f = 0; f < 400 && !fell; f++) { p.update(CONFIG.FIXED_DT, mm.world); fell = p.waterFalls > 0; }
        assert(fell, `ledge ${i}: stood on the boulder's ${side > 0 ? 'right' : 'left'} side at ${Math.round(p.x)},${Math.round(p.y)} (from y ${y})`);
      }
    }
    m.terrain.removeBoulder(poly);
    assert(Buffer.compare(before, Buffer.from(m.terrain.mask)) === 0, `ledge ${i}: removing it restores the mask`);
    out[i] = { span: [s.x0, s.x1], filled };
  }
  return out;
}));

await test('超巨石（有超巨石的回合）：先巨石投擲、再超巨石；封左高台——站在上面的人直接死亡（不吃無敵、減傷；剩下的血算承受傷害）、壓碎那一段的鐘乳石（不會掉下來）、壓熄火把；中岩柱上、高台邊外的人沒事；重播一致', () => base(() => {
  const setup = (mm) => {
    const [, p2, p3, p4] = mm.players;
    placeOn(mm, p2, 560, 330);     // 中岩柱
    placeOn(mm, p3, 860, 370);     // 巨人的岩柱
    placeOn(mm, p4, 330, 290);     // 高台右端的圓角上（身體還碰得到巨石那一段）
    mm.byId('cyclops').roam = null;
    mm.players[0].shield = 2;      // 無敵擋不住
  };
  const m = make(4, { seed: 3 });
  setup(m);
  const [p1, p2, p3, p4] = m.players;
  assert(J(crushedPlayers(m, 0).map(e => e.id)) === '["p1","p4"]', 'on the plateau: ' + J(crushedPlayers(m, 0).map(e => e.id)));
  m.mechState.turns = 1;   // 這是他的第 2 回合（第一次封左高台）
  const boss = cyclopsTurn(m, 'throw', { seal: 0 });
  assert(J(boss.steps.map(s => s.action)) === '["throw","seal"]', 'throw, then seal: ' + J(boss.steps.map(s => s.action)));
  const seal = boss.steps[1];
  const taken = [p1.taken, p4.taken], hpBefore = [seal.still.results.find(s => s.id === 'p1')];
  assert(seal.ledge === 0 && J(seal.killed) === '["p1","p4"]' && seal.cast === CONFIG.CYCLOPS.sealCast && seal.still, 'seal step: ' + J({ ledge: seal.ledge, killed: seal.killed, cast: seal.cast }));
  assert(!p1.alive && !p4.alive && p1.deathCause === 'crushed' && p4.deathCause === 'crushed' && p2.alive && p3.alive, 'crushed: ' + J(m.players.map(p => [p.id, p.alive, p.deathCause])));
  assert(p1.shield === 1, 'the throw before it used one charge, the seal ignored the other: ' + p1.shield);
  assert(J(seal.rocks) === '[0,1]' && m.terrain.fallen.has(0) && m.terrain.fallen.has(1) && J(m.mechState.fallen) === '[0,1]', 'two stalactites crushed: ' + J(seal.rocks));
  assert(J(seal.torches) === '[0]' && J(m.mechState.lit) === '[null,null,null]', 'spawn torch put out: ' + J(m.mechState.lit));
  assert(J(m.mechState.sealed) === '[0]' && maskAt(m, 100, 200) === BOULDER, 'sealed');
  assert(['throw', 'pound'].includes(boss.next.action) && !('seal' in boss.next) && m.mechState.turns === 2, 'next ' + J(boss.next));
  // 客戶端重播：投擲照 shotScript，超巨石照 sealLedge + killed
  const c = make(4, { seed: 3 });
  setup(c);
  const sent = JSON.parse(J(boss));
  replayChecked(c, sent.steps[0].shot, 'throw before seal');
  c.applyEntities(sent.steps[0].shot.results);
  for (const id of sent.steps[1].killed) c.byId(id).die('crushed');
  const r = sealLedge(c, sent.steps[1].ledge);
  assert(r && J(r.rocks) === J(seal.rocks) && J(r.torches) === J(seal.torches), 'client seals the same way: ' + J(r));
  c.applyEntities(sent.steps[1].still.results);
  assertSame(m, c, 'seal');
  assert(J(c.mechState.sealed) === '[0]', 'client sealed');
  // 已經封住了：再排到同一個平台就不丟（只有投擲）
  const again = cyclopsTurn(m, 'throw', { seal: 0 });
  assert(J(again.steps.map(s => s.action)) === '["throw"]', 'already sealed: ' + J(again.steps.map(s => s.action)));
  return { killed: seal.killed, rocks: seal.rocks, takenAdded: [p1.taken - taken[0], p4.taken - taken[1]], hp: hpBefore.length };
}));

await test('超巨石封中岩柱：站在中岩柱（頂面、坑裡）的人壓死，站在左高台右端、巨人岩柱左端邊上的人沒事；封住之後那一段站不上去、子彈打不穿也炸不壞', () => base(() => {
  const m = make(4, { seed: 2 });
  for (let k = 0; k < 5; k++) m.terrain.dropStalactite(k);
  const [p1, p2, p3, p4] = m.players;
  m.terrain.carve(520, 360, 30);
  placeOn(m, p1, 520, 350);       // 中岩柱的坑裡
  placeOn(m, p2, 630, 330);       // 中岩柱右端
  placeOn(m, p3, 338, 290);       // 左高台右端
  placeOn(m, p4, 696, 370);       // 巨人岩柱左端
  assert(p1.y > 345 && p3.onGround && p4.onGround, 'placed: ' + J(m.players.map(p => [Math.round(p.x), Math.round(p.y), p.onGround])));
  const step = cyclopsTurn(m, 'throw', { seal: 1 }).steps[1];
  assert(step && step.action === 'seal' && J(step.killed) === '["p1","p2"]', 'crushed on the middle pillar: ' + J(step && step.killed));
  assert(p3.alive && p4.alive, 'the neighbours are fine');
  // 從上面掉下來：落在巨石上方的天花板縫裡站不住（擠不進去），一路被擋在外面
  const s = boulderSpan(m, 1);
  for (const x of [s.x0 + 20, (s.x0 + s.x1) / 2, s.x1 - 20]) assert(m.terrain.isSolid(x, 45) && m.terrain.isSolid(x, LEVELS.depths.mechanic.ledges[1].y - 1), `solid column at ${x}`);
  // 砲彈打在巨石上：爆炸、不挖掉巨石
  const holes = m.terrain.holes.length;
  const rock = [];
  m.terrain.mask.forEach((v, k) => { if (v === BOULDER) rock.push(k); });
  const shot = m.resolveShot(p4, 'cannon', 170, 60);
  const hit = shot.events.find(ev => ev.type === 'explode');
  assert(hit && hit.x >= s.x0 - 15 && hit.x <= s.x1 + 15, 'the cannonball hits the boulder: ' + J(hit && [hit.x, hit.y]));
  const lost = rock.filter(k => m.terrain.mask[k] !== BOULDER);
  assert(m.terrain.holes.length > holes && !lost.length, `the boulder lost ${lost.length} pixels to ${m.terrain.holes.length - holes} craters`);
}));

// ---------------- 震盪獅吼 ----------------

await test('震盪獅吼：擊碎所有超巨石（地形回到封住之前，壓碎的鐘乳石不回來）、沒有傷害、每個人水平往外震退 400（巨人左邊的往左、右邊的往右）；不丟巨石；重播一致', () => base(() => {
  const setup = (mm) => {
    for (const i of [0, 1]) sealLedge(mm, i);
    const [p1, p2, p3] = mm.players;
    placeOn(mm, p1, 760, 370);
    placeOn(mm, p2, 905, 370);
    placeOn(mm, p3, 1005, 370);   // 在他身後
    mm.byId('cyclops').roam = null;
  };
  const m = make(3, { seed: 4 });
  const pristine = make(3, { seed: 4 });
  for (const k of [0, 1, 2]) pristine.terrain.dropStalactite(k);
  setup(m);
  m.mechState.turns = 5;   // 第 6 回合才是震盪獅吼（下一招接著排第 7 回合）
  assert(J(m.mechState.sealed) === '[0,1]', 'both sealed first');
  const hp = m.players.map(p => p.hp);
  const boss = cyclopsTurn(m, 'roar');
  assert(boss.steps.length === 1, 'one step');
  const st = boss.steps[0];
  assert(st.action === 'roar' && J(st.shattered) === '[0,1]' && st.cast === CONFIG.CYCLOPS.roarCast && st.shot.weapon === 'cyclopsRoar', 'roar step: ' + J({ action: st.action, shattered: st.shattered }));
  assert(J(st.targetIds) === '["p2","p3","p1"]' && st.shot.projectiles.length === 3, 'one wave each, nearest first: ' + J(st.targetIds));
  assert(J(m.mechState.sealed) === '[]' && Buffer.compare(Buffer.from(pristine.terrain.mask), Buffer.from(m.terrain.mask)) === 0, 'boulders gone, terrain as before');
  const hits = st.shot.events.filter(ev => ev.target);
  assert(J(hits.map(h => h.target).sort()) === '["p1","p2","p3"]' && hits.every(h => h.damages.every(d => d.dmg === 0)), 'everyone hit once, no damage: ' + J(hits.map(h => [h.target, h.damages])));
  // 擊退：水平 400（撞擊點跟身體中心一樣高）
  const c = make(3, { seed: 4 });
  setup(c);
  shatterBoulders(c);
  const kick = {};
  replayChecked(c, JSON.parse(J(st.shot)), 'roar', { event: (ev) => { if (ev.target) kick[ev.target] = { vx: c.byId(ev.target).vx, vy: c.byId(ev.target).vy }; } });
  assert(kick.p1.vx === -400 && kick.p2.vx === -400 && kick.p3.vx === 400 && Object.values(kick).every(k => Math.abs(k.vy + 140) < 1e-9), 'knocked 400 away from him: ' + J(kick));
  c.applyEntities(st.shot.results);
  assertSame(m, c, 'roar');
  // 沒有傷害：血量只會因為落水少（落水 30%）
  m.players.forEach((p, i) => {
    const water = p.waterFalls * Math.round(p.maxHp * 0.3);
    assert(p.hp === hp[i] - water, `${p.id}: hp ${hp[i]} → ${p.hp} (${p.waterFalls} splashes)`);
  });
  assert(m.byId('p3').waterFalls === 0 && m.byId('p3').x > 990, 'behind him: pushed into the wall, stays');
  assert(['throw', 'pound'].includes(boss.next.action) && !('seal' in boss.next), 'next ' + J(boss.next));
  return { landed: m.players.map(p => [p.id, Math.round(p.x), p.waterFalls]) };
}));

await test('一整輪（玩家都站在巨人的岩柱上、沒人走動）：第 2 回合封左高台、第 4 回合封中岩柱、第 6 回合震盪獅吼擊碎兩塊、第 8 回合又封左高台', () => base(() => {
  const m = make(2, { seed: 5 });
  for (const p of m.players) { p.hp = p.maxHp = 9000; }
  placeOn(m, m.players[0], 980, 370);
  placeOn(m, m.players[1], 1000, 370);
  const cy = m.byId('cyclops');
  cy.roam = null;
  const log = [];
  for (let n = 1; n <= 8; n++) {
    const boss = cyclopsTurn(m);
    log.push(boss.steps.map(s => s.action + (Number.isInteger(s.ledge) ? s.ledge : '') + (s.shattered ? '[' + s.shattered + ']' : '')).join('+') + ' ' + J(m.mechState.sealed));
  }
  assert(J(log) === J(['throw []', 'throw+seal0 [0]', 'throw [0]', 'throw+seal1 [0,1]', 'throw [0,1]', 'roar[0,1] []', 'throw []', 'throw+seal0 [0]']), 'cycle ' + J(log));
  assert(m.players.every(p => p.alive), 'nobody was on the sealed ledges');
  return { log };
}, { CYCLOPS: { weights: { pound: 0, throw: 1 } } }));

// ---------------- 猛捶 ----------------

await test('猛捶的權重：照權重抽（兩種都會出現）；鐘乳石掉光之後猛捶變少（poundBareFactor）；權重 0 的不會出現', () => base(() => {
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

await test('猛捶：天花板上的鐘乳石全部震下來（衝擊第一幀的事件帶 falls / adds）、砸到下面的玩家 30 × 敵人倍率、不會砸到巨人自己；再捶一次就沒有可以震的了', () => base(() => {
  const m = make(3, { seed: 4 });
  const cy = m.byId('cyclops');
  const p2 = m.byId('p2');
  const k0 = m.terrain.stalactites[0];
  assert(Math.abs(p2.x - k0.tip.x) < p2.hw + 14, 'P2 stands under the leftmost stalactite');
  const hp0 = p2.hp, cyHp = cy.hp;
  const boss = cyclopsTurn(m, 'pound', { ledge: 2 });   // 打他自己那根（衝擊碰不到高台上的人，只看鐘乳石）
  const step = boss.steps[0];
  assert(boss.steps.length === 1 && step.action === 'pound' && step.shot && step.shot.weapon === 'cyclopsShock' && step.shot.projectiles.length === 2, 'pound step: ' + J(step.action));
  const first = step.shot.events[0];
  assert(first.f === 1 && J(first.falls) === '[0,1,2,3,4]' && first.adds.length === 5 && first.adds.every(a => a.w === 'stalactite' && a.passAllies), 'all fall at once: ' + J(first));
  assert(m.terrain.fallen.size === 5 && J(m.mechState.fallen) === '[0,1,2,3,4]', 'removed from the mask');
  const rock = step.shot.events.find(ev => ev.target === 'p2');
  assert(rock && rock.damages[0].dmg === 30 * 0.7 && p2.hp === hp0 - 21, 'the rock hits P2 for 21: ' + J(rock));
  assert(cy.hp === cyHp && !step.shot.events.some(ev => ev.target === 'cyclops'), 'his own rocks do not hit him');
  const c = make(3, { seed: 4 });
  replayChecked(c, JSON.parse(J(step.shot)), 'pound');
  c.applyEntities(step.shot.results);
  assertSame(m, c, 'pound');
  const again = cyclopsTurn(m, 'pound', { ledge: 2 }).steps[0];
  assert(!again.shot.events.some(ev => ev.falls) && again.shot.events.every(ev => ev.type !== 'pass'), 'nothing left to shake');
  return { rockHitAt: rock.f };
}));

await test('猛捶的衝擊打他自己那根：從腳下往兩邊跑，只打站在巨人那根岩柱上的玩家（25 × 敵人倍率，往外推），中岩柱 / 左高台上的人不會被打到；跑到岩柱兩端就停', () => base(() => {
  const setup = (mm) => {
    for (let k = 0; k < 5; k++) mm.terrain.dropStalactite(k);   // 先把鐘乳石拿掉，只看衝擊
    placeOn(mm, mm.players[1], 560, 330);   // 中岩柱
    placeOn(mm, mm.players[2], 860, 370);   // 巨人的岩柱（巨人左邊）
  };
  const m = make(3, { seed: 2 });
  setup(m);
  const [p1, p2, p3] = m.players;
  assert(pickPoundLedge(m, m.byId('cyclops')) === 2, 'one each → his own pillar');
  const hp = m.players.map(p => p.hp);
  const step = cyclopsTurn(m, 'pound').steps[0];   // 沒預定平台：出招時照大家站的位置挑
  assert(step.ledge === 2 && step.shot.projectiles.length === 2, 'his own pillar, two waves: ' + J([step.ledge, step.shot.projectiles.length]));
  const hits = step.shot.events.filter(ev => ev.target);
  assert(hits.length === 1 && hits[0].target === 'p3' && hits[0].type === 'pierce', 'only P3: ' + J(hits.map(h => [h.target, h.type])));
  assert(hits[0].damages[0].dmg === Math.round(25 * 0.7) && p3.hp === hp[2] - hits[0].damages[0].dmg && p1.hp === hp[0] && p2.hp === hp[1], 'damage ' + J(m.players.map(p => p.hp)));
  const c = make(3, { seed: 2 });
  setup(c);
  let pushed = null;
  replayChecked(c, JSON.parse(J(step.shot)), 'shock', { event: (ev) => { if (ev.target === 'p3') pushed = c.byId('p3').vx; } });
  assert(pushed < -100, 'pushed away from him: vx ' + pushed);
  const lane = poundLane(m, 2);
  assert(lane.x0 === LEVELS.depths.mechanic.ledges[2].x0 && lane.y < LEVELS.depths.mechanic.ledges[2].y, 'lane on the ledge');
  const ends = step.shot.events.filter(ev => ev.type === 'range').map(ev => Math.round(ev.x)).sort((a, b) => a - b);
  assert(ends.length === 2 && Math.abs(ends[0] - lane.x0) <= 24 && Math.abs(ends[1] - lane.x1) <= 24, 'stops at the ledge ends: ' + ends);
  return { vx: Math.round(pushed), ends };
}));

await test('猛捶的衝擊：只打那根岩柱上的人——中岩柱炸出深坑、人站在衝擊的高度也打不到；站在巨人腳邊（兩道都碰得到）也只挨一次', () => base(() => {
  const setup = (mm) => {
    for (let k = 0; k < 5; k++) mm.terrain.dropStalactite(k);
    mm.terrain.carve(550, 356, 36);
    placeOn(mm, mm.players[1], 550, 360);
    placeOn(mm, mm.players[0], mm.byId('cyclops').x, 370);   // 跟巨人站在一起（兩道衝擊的出發點）
  };
  const m = make(2, { seed: 2 });
  setup(m);
  const [p1, p2] = m.players;
  const lane = poundLane(m, 2);
  assert(p2.y >= lane.y && p2.y - p2.h <= lane.y, `P2 stands at shock height in the crater: ${p2.y} (lane ${lane.y})`);
  assert(ledgeOf(m, p2) === -1 && ledgeOf(m, p1) === 2 && pickPoundLedge(m, m.byId('cyclops')) === 2, 'the crater does not count');
  const hp = [p1.hp, p2.hp];
  const step = cyclopsTurn(m, 'pound', { ledge: 2 }).steps[0];
  const hits = step.shot.events.filter(ev => ev.target);
  assert(!hits.some(h => h.target === 'p2') && p2.hp === hp[1], 'crater on the middle pillar is safe: ' + J(hits.map(h => [h.target, Math.round(h.x)])));
  assert(hits.filter(h => h.target === 'p1').length === 1 && p1.hp === hp[0] - Math.round(25 * 0.7), 'standing at his feet: hit once: ' + J(hits.map(h => h.target)));
  const c = make(2, { seed: 2 });
  setup(c);
  replayChecked(c, JSON.parse(J(step.shot)), 'shock at his feet');
  c.applyEntities(step.shot.results);
  assertSame(m, c, 'shock at his feet');
}));

await test('猛捶挑站最多人的平台（排到猛捶時就決定，存在 next.ledge）：平手挑離巨人近的、他自己那根最優先；倒下 / 半空中的人不算，都沒人就打自己那根', () => base(() => {
  const LEFT = null, MID = [560, 330], MID2 = [500, 330], RIGHT = [860, 370];
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
  const { m } = pick([LEFT, MID, MID2]);
  const pound = withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, weights: { pound: 1, throw: 0 } } }, () => planCyclopsNext(m));
  assert(J(pound) === '{"action":"pound","ledge":1}', 'planned: ' + J(pound));
  const thr = withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, weights: { pound: 0, throw: 1 } } }, () => planCyclopsNext(m));
  assert(J(thr) === '{"action":"throw"}', 'a throw has no ledge: ' + J(thr));
  const m0 = withConfig({ CYCLOPS: { ...CONFIG.CYCLOPS, weights: { pound: 1, throw: 0 } } }, () => make(2));
  assert(J(m0.mechState.next) === '{"action":"pound","ledge":0}', 'opening pound: ' + J(m0.mechState.next));
}));

await test('猛捶 × 超巨石（2026-10-19）：被封住的平台、這回合要被封住的平台都不打（人最多也不打）；剩下的只有他自己那根就不放猛捶（權重全給猛捶也改丟巨石）；擊碎之後又打得到', () => base(() => {
  const plan = (m, turns) => { m.mechState.turns = turns; return planCyclopsNext(m); };
  // 第 2 回合要封左高台：大家都在左高台也不打那裡（其他平台都沒人 → 他自己那根）
  const m = make(3, { seed: 3 });
  assert(J(poundLedges(m)) === '[0,1,2]' && J(poundLedges(m, 0)) === '[1,2]', 'candidates ' + J(poundLedges(m, 0)));
  assert(J(plan(m, 1)) === '{"action":"pound","ledge":2,"seal":0}', 'turn 2: ' + J(m.mechState.next));
  // 左高台封住了：兩個人在中岩柱 → 打中岩柱；第 3 回合（沒有超巨石）
  for (const p of m.players) placeOn(m, p, 560, 330);
  placeOn(m, m.players[2], 860, 370);
  sealLedge(m, 0);
  assert(J(poundLedges(m)) === '[1,2]', 'left sealed: ' + J(poundLedges(m)));
  assert(J(plan(m, 2)) === '{"action":"pound","ledge":1}', 'turn 3: ' + J(m.mechState.next));
  // 第 4 回合要封中岩柱：剩下的只有他自己那根 → 不放猛捶
  assert(J(poundLedges(m, 1)) === '[]' && J(plan(m, 3)) === '{"action":"throw","seal":1}', 'turn 4: ' + J(m.mechState.next));
  // 兩根都封住了（第 5 回合）：一樣不放
  for (const p of m.players.slice(0, 2)) placeOn(m, p, 900, 370);
  sealLedge(m, 1);
  assert(J(poundLedges(m)) === '[]' && J(plan(m, 4)) === '{"action":"throw"}', 'turn 5: ' + J(m.mechState.next));
  // 擊碎之後：又可以打左高台、中岩柱
  shatterBoulders(m);
  assert(J(poundLedges(m)) === '[0,1,2]' && plan(m, 6).action === 'pound', 'after the roar: ' + J(m.mechState.next));
  // 預定的猛捶打的平台後來被封住了（舊的預定）：出招時重挑；沒得挑就改丟巨石
  const s = make(2, { seed: 3 });
  placeOn(s, s.players[1], 560, 330);
  sealLedge(s, 0);
  assert(cyclopsTurn(s, 'pound', { ledge: 0 }).steps[0].ledge === 1, 'stale plan → re-picked');
  sealLedge(s, 1);
  assert(cyclopsTurn(s, 'pound', { ledge: 1 }).steps[0].action === 'throw', 'nothing to pound → throws instead');
}, { CYCLOPS: { weights: { pound: 1, throw: 0 } } }));

await test('猛捶 + 超巨石同一回合：先猛捶（打別的平台）、再封住；重播一致', () => base(() => {
  const setup = (mm) => {
    for (let k = 0; k < 5; k++) mm.terrain.dropStalactite(k);
    placeOn(mm, mm.players[1], 560, 330);   // P1 留在左高台（會被壓死），P2 在中岩柱（挨衝擊）
    mm.byId('cyclops').roam = null;
  };
  const m = make(2, { seed: 6 });
  setup(m);
  m.mechState.turns = 1;
  planCyclopsNext(m);
  assert(J(m.mechState.next) === '{"action":"pound","ledge":1,"seal":0}', 'planned ' + J(m.mechState.next));
  const boss = cyclopsTurn(m);
  assert(J(boss.steps.map(s => s.action + s.ledge)) === '["pound1","seal0"]', 'steps ' + J(boss.steps.map(s => s.action + s.ledge)));
  assert(shockHits(boss.steps[0].shot).map(h => h.target).join() === 'p2' && J(boss.steps[1].killed) === '["p1"]', 'shock on P2, P1 crushed');
  const c = make(2, { seed: 6 });
  setup(c);
  const sent = JSON.parse(J(boss));
  replayChecked(c, sent.steps[0].shot, 'pound then seal');
  c.applyEntities(sent.steps[0].shot.results);
  for (const id of sent.steps[1].killed) c.byId(id).die('crushed');
  sealLedge(c, sent.steps[1].ledge);
  c.applyEntities(sent.steps[1].still.results);
  assertSame(m, c, 'pound then seal');
}, { CYCLOPS: { weights: { pound: 1, throw: 0 } } }));

// 衝擊（猛捶那一波的第 0 顆、第 1 顆飛行物；震下來的鐘乳石排在後面）打到誰
function shockHits(shot) { return shot.events.filter(ev => ev.target && ev.p < shot.projectiles.length); }

await test('猛捶打別根平台（中岩柱）：衝擊從靠巨人那一端出發、一道跑到另一端就停；只打那根上的人（25 × 敵人倍率、各一次、往外推）；鐘乳石照樣全部震下來；重播一致', () => base(() => {
  const setup = (m) => { placeOn(m, m.players[1], 560, 330); placeOn(m, m.players[2], 620, 330); };
  const m = make(3, { seed: 2 });
  setup(m);
  assert(pickPoundLedge(m, m.byId('cyclops')) === 1, 'the middle pillar has the most');
  const lane = poundLane(m, 1), L = LEVELS.depths.mechanic.ledges[1];
  const step = cyclopsTurn(m, 'pound', { ledge: 1 }).steps[0];
  const shot = step.shot;
  const pr = shot.projectiles;
  const lead = pr[0].x - L.x1, hwMax = Math.max(...m.players.map(p => p.hw));
  assert(step.ledge === 1 && pr.length === 1 && lead >= hwMax + 8 && lead <= hwMax + 8 + 4 && pr[0].y === lane.y && pr[0].vx < 0 && pr[0].vy === 0, 'one wave from just past the near end: ' + J(pr));
  const end = shot.events.find(ev => ev.type === 'range' && ev.p === 0);
  assert(end && Math.abs(end.x - L.x0) <= 6, 'stops at the far end: ' + J(end && end.x));
  assert(J(shot.events[0].falls) === '[0,1,2,3,4]', 'stalactites still all fall: ' + J(shot.events[0]));
  const hits = shockHits(shot);
  assert(J(hits.map(h => h.target).sort()) === '["p2","p3"]' && hits.every(h => h.type === 'pierce' && h.damages[0].dmg === Math.round(25 * 0.7)), 'hits P2, P3 once each: ' + J(hits.map(h => [h.target, h.type])));
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
  const step = cyclopsTurn(m, 'pound').steps[0];
  const L = LEVELS.depths.mechanic.ledges[0];
  const pr = step.shot.projectiles;
  assert(step.ledge === 0 && pr.length === 1 && pr[0].x > L.x1 + m.players[0].hw + 8 && pr[0].vx < 0, 'plateau, one wave from just past its right end: ' + J(pr));
  const end = step.shot.events.find(ev => ev.type === 'range' && ev.p === 0);
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
  for (const [ledge, x, y] of [[0, 336, 290], [0, 339, 290], [1, 640, 330]]) {
    const label = `ledge ${ledge} x ${x}`;
    const setup = (mm) => { for (let k = 0; k < 5; k++) mm.terrain.dropStalactite(k); placeOn(mm, mm.players[0], x, y); };
    const m = make(1, { seed: 2 });
    setup(m);
    const p = m.players[0];
    const L = LEVELS.depths.mechanic.ledges[ledge];
    const x0 = p.x, hp = p.hp;
    assert(p.onGround && ledgeOf(m, p) === ledge && x0 > L.x1, `${label}: stands on the ledge past its near end: ` + J([ledgeOf(m, p), p.x, p.y, p.onGround]));
    const step = cyclopsTurn(m, 'pound', { ledge }).steps[0];
    const hits = shockHits(step.shot);
    assert(step.ledge === ledge && hits.length === 1 && hits[0].target === 'p1' && hits[0].x > x0, `${label}: hit once from his side: ` + J(hits.map(h => [h.target, h.x])));
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

// 巨石投擲的檢查（一波的結果）：每個活著的玩家剛好挨一顆、第 k 顆打的是 targetIds[k]（爆炸在他身上），沒有別的事件（沒落地、沒落水、沒打到巨人）。
// 回傳 { id: 那一顆的事件 }
function throwHits(m, step, label) {
  const alive = m.players.filter(p => p.alive || step.shot.events.some(ev => ev.target === p.id)).map(p => p.id);
  const shot = step.shot;
  assert(step.action === 'throw' && shot.weapon === 'cyclopsBoulder' && Array.isArray(step.targetIds), `${label}: throw step ` + J(step.action));
  assert(J([...step.targetIds].sort()) === J([...alive].sort()) && shot.projectiles.length === alive.length, `${label}: one boulder each: ${J(step.targetIds)} vs ${J(alive)}`);
  assert(shot.events.length === alive.length, `${label}: only the hits: ` + J(shot.events.map(ev => [ev.p, ev.type, ev.target])));
  const out = {};
  step.targetIds.forEach((id, k) => {
    const evs = shot.events.filter(ev => ev.target === id);
    assert(evs.length === 1 && evs[0].type === 'explode' && evs[0].p === k, `${label}: ${id} is hit exactly once by boulder #${k}: ` + J(evs.map(ev => [ev.p, ev.type])));
    out[id] = evs[0];
  });
  assert(!shot.events.some(ev => ev.target === 'cyclops'), `${label}: hit himself`);
  return out;
}
// 隨機站位（照 seed 決定：伺服器、客戶端兩份一樣）：先在岩柱上炸幾個坑，再把每個人丟到某根岩柱（含高台、他那根的腳邊 / 身後）上方落下站好。
// 落水的、沒站穩的重丟
function scatter(m, seed) {
  const rng = new Rng(seed);
  const L = LEVELS.depths.mechanic.ledges;
  const holes = rng.int(0, 4);
  for (let h = 0; h < holes; h++) {
    const l = L[rng.int(0, L.length - 1)];
    m.terrain.carve(rng.range(l.x0 + 20, l.x1 - 20), l.y + rng.range(5, 40), rng.range(18, 42));
  }
  for (const p of m.players) {
    let ok = false;
    for (let k = 0; k < 40 && !ok; k++) {
      const l = L[rng.int(0, L.length - 1)];
      placeOn(m, p, rng.range(Math.max(l.x0, 0) + 10, Math.min(l.x1, 1014) - 10), l.y - 40);
      ok = p.alive && p.onGround && p.waterFalls === 0 && p.canStandAt(m.terrain, p.x, p.y);
    }
    assert(ok, `seed ${seed}: could not place ${p.id}`);
  }
}

await test('巨石的初速（exactLaunch）：照 advanceProjectile 的子步算，飛剛好 N 幀之後就在目標點上（差不到 0.001 px）；只用連續的拋物線公式會差好幾 px', () => base(() => {
  const g = 600, dt = CONFIG.FIXED_DT;
  const fly = (x0, y0, vx, vy, N) => {
    const p = { x: x0, y: y0, vx, vy, gravity: g, age: 0 };
    for (let n = 0; n < N; n++) advanceProjectile(null, p, dt);
    return p;
  };
  let worst = 0, worstCont = 0;
  for (const [x0, y0] of [[955, 388.6], [880, 380]]) {
    for (const [X, Y] of [[60, 235], [300, 235], [560, 325], [830, 417], [1000, 417], [955, 417]]) {
      for (let N = 12; N <= 160; N += 7) {
        const v = exactLaunch(x0, y0, X, Y, N, g);
        const p = fly(x0, y0, v.vx, v.vy, N);
        worst = Math.max(worst, Math.hypot(p.x - X, p.y - Y));
        const T = N * dt;
        const q = fly(x0, y0, v.vx, (Y - y0 - g * T * T / 2) / T, N);
        worstCont = Math.max(worstCont, Math.hypot(q.x - X, q.y - Y));
      }
    }
  }
  assert(worst < 1e-3, 'exact launch error ' + worst);   // 子步數卡在邊界上的少數幾個會差到 1e-4 左右，其他都是 1e-10 以下
  assert(worstCont > 1, 'the continuous formula would be off: ' + worstCont);
  return { worst, worstCont: +worstCont.toFixed(2) };
}));

await test('巨石投擲：1 / 2 / 3 / 4 人各丟一顆（離他近的先丟、第 k 顆在第 1 + k × throwGap 幀出手），每顆只砸它瞄的那個人：30 × 敵人倍率、擊退 120（撞擊點 → 身體中心）、流血 5 層、不挖坑、不砸到巨人；重播一致（含流血層數）', () => base(() => {
  const SPOTS = { plateau: null, middle: [560, 330], left: [830, 370], behind: [1000, 370] };
  const out = {};
  for (const where of [['middle'], ['plateau', 'left'], ['plateau', 'middle', 'behind'], ['plateau', 'middle', 'left', 'behind']]) {
    const n = where.length;
    const setup = (mm) => { mm.players.forEach((p, i) => { if (SPOTS[where[i]]) placeOn(mm, p, ...SPOTS[where[i]]); }); mm.byId('cyclops').roam = null; };
    const m = make(n, { seed: 6 });
    setup(m);
    const cy = m.byId('cyclops');
    const holes = m.terrain.holes.length, cyHp = cy.hp;
    const hp = Object.fromEntries(m.players.map(p => [p.id, p.hp]));
    const d2 = (p) => (p.cx - cy.cx) ** 2 + (p.cy - cy.cy) ** 2;
    const nearFirst = [...m.players].sort((a, b) => d2(a) - d2(b)).map(p => p.id);
    const step = cyclopsTurn(m, 'throw').steps[0];
    const label = `${n}p ${where}`;
    assert(J(step.targetIds) === J(nearFirst), `${label}: nearest first: ${J(step.targetIds)} vs ${J(nearFirst)}`);
    assert(J(step.shot.projectiles.map(s => s.spawn)) === J(step.targetIds.map((_, k) => 1 + 6 * k)), `${label}: staggered spawns ` + J(step.shot.projectiles.map(s => s.spawn)));
    assert(step.shot.facing === (cy.cx <= m.byId(nearFirst[0]).cx ? 1 : -1) && cy.facing === step.shot.facing, `${label}: faces the first target`);
    const hits = throwHits(m, step, label);
    for (const [id, ev] of Object.entries(hits)) {
      const d = ev.damages.find(x => x.id === id);
      assert(d && d.dmg === 21 && d.bleed === 5 && m.byId(id).hp === hp[id] - 21 && m.byId(id).bleed === 5 && !ev.carve, `${label}: ${id} takes 21 + 5 bleed: ` + J(ev.damages));
    }
    assert(m.terrain.holes.length === holes && cy.hp === cyHp, `${label}: no crater, he is not hurt`);
    // 客戶端重播：擊退照撞擊點 → 身體中心 × 120；流血層數跟著事件同步（最後狀態一模一樣）
    const c = make(n, { seed: 6 });
    setup(c);
    const kick = {};
    replayChecked(c, JSON.parse(J(step.shot)), label, { event: (ev) => { if (ev.target) kick[ev.target] = { vx: c.byId(ev.target).vx, bl: c.byId(ev.target).bleed }; } });
    for (const [id, ev] of Object.entries(hits)) {
      const st = ev.ents.find(s => s.id === id);
      const dx = st.x - ev.x, dy = st.y - m.byId(id).h / 2 - ev.y, dd = Math.sqrt(dx * dx + dy * dy);
      assert(Math.abs(kick[id].vx - dx / dd * 120) < 1e-6 && kick[id].bl === 5, `${label}: ${id} knockback 120 along the hit, bleed synced: ${J(kick[id])} vs ${dx / dd * 120}`);
    }
    c.applyEntities(step.shot.results);
    assertSame(m, c, label);
    out[label] = step.targetIds.map(id => hits[id].f).join('/');
  }
  return out;
}));

await test('巨石投擲一定砸中：1 ~ 4 人 × 很多種子、隨機站位（岩柱上的坑、高台、中岩柱、他的岩柱上腳邊 / 身後），每個人都剛好挨一顆；地底封住的洞裡也砸得到（穿過地形）；重播一致', () => base(() => {
  let cases = 0, boulders = 0, through = 0;
  for (let n = 1; n <= 4; n++) {
    for (let seed = 1; seed <= 14; seed++) {
      const m = make(n, { seed });
      scatter(m, seed * 31 + n);
      const step = cyclopsTurn(m, 'throw').steps[0];
      throwHits(m, step, `${n}p seed ${seed}`);
      cases++;
      boulders += step.targetIds.length;
      const c = make(n, { seed });
      scatter(c, seed * 31 + n);
      replayChecked(c, JSON.parse(J(step.shot)), `${n}p seed ${seed}`);
      c.applyEntities(step.shot.results);
      assertSame(m, c, `${n}p seed ${seed}`);
    }
  }
  // 腳邊、身後、跟別人疊在一起、站在巨人身體裡的人（擠在一起：別人的身體擋不住這一顆，也不會多挨別人的）
  for (const xs of [[950, 955, 960, 1000], [940, 942, 944, 946], [600, 604, 830, 834]]) {
    const m = make(4, { seed: 3 });
    m.players.forEach((p, i) => placeOn(m, p, xs[i], xs[i] > 700 ? 370 : 330));
    throwHits(m, cyclopsTurn(m, 'throw').steps[0], 'crowd ' + xs);
  }
  // 地底封住的洞（上面還有 50px 的岩石）：乾淨的拋物線不存在 → 那一顆穿過地形，試飛確認砸得到；別人的照樣是乾淨的
  const m = make(2, { seed: 4 });
  m.terrain.carve(560, 420, 26);
  const [p1, p2] = m.players;
  placeOn(m, p2, 560, 425);
  assert(p2.onGround && p2.y > 400 && m.terrain.isSolid(560, 380), 'P2 is sealed in the pocket: ' + J([p2.x, p2.y]));
  const cy = m.byId('cyclops');
  const sealed = aimBoulder(m, cy, p2), open = aimBoulder(m, cy, p1);
  assert(sealed.passTerrain && sealed.hit && !open.passTerrain && open.hit, 'pocket → through terrain: ' + J({ sealed, open }));
  const step = cyclopsTurn(m, 'throw').steps[0];
  throwHits(m, step, 'pocket');
  through++;
  return { cases, boulders, through };
}));

await test('巨石投擲：腳邊 / 身後（他那根岩柱上、右邊）的人也有一條碰不到地形的拋物線（aimBoulder 試飛確認），巨石不會砸到巨人自己', () => base(() => {
  const out = {};
  for (const x of [800, 900, 950, 955, 960, 1000]) {   // 950 ~ 960 = 站在他腳邊（跟他的身體疊在一起）
    const m = make(1, { seed: 3 });
    const p = m.byId('p1');
    placeOn(m, p, x, 370);
    const cy = m.byId('cyclops');
    const a = aimBoulder(m, cy, p);
    assert(a.hit && !a.passTerrain && a.frames >= 12, `x ${x}: clean exact aim: ` + J(a));
    const hp = cy.hp;
    const step = cyclopsTurn(m, 'throw').steps[0];
    throwHits(m, step, `x ${x}`);
    assert(cy.hp === hp, `x ${x}: he is not hurt`);
    out[x] = { frames: a.frames, vx: Math.round(a.vx), vy: Math.round(a.vy) };
  }
  return out;
}));

await test('巨石投擲不用亂數：亂數走到哪裡都丟出一模一樣的巨石；出完招只為了排下一招（猛捶 / 巨石投擲）抽一個亂數', () => base(() => {
  const setup = (mm) => { placeOn(mm, mm.players[1], 560, 330); placeOn(mm, mm.players[2], 1000, 370); mm.byId('cyclops').roam = null; };
  const a = make(3, { seed: 8 }), b = make(3, { seed: 8 }), ref = make(3, { seed: 8 });
  for (const mm of [a, b, ref]) setup(mm);
  for (let k = 0; k < 7; k++) b.rng.float();   // b 的亂數先往前走幾步
  const sa = cyclopsTurn(a, 'throw').steps[0], sb = cyclopsTurn(b, 'throw').steps[0];
  assert(J(sa.targetIds) === J(sb.targetIds) && J(sa.shot) === J(sb.shot), 'same boulders whatever the rng state');
  ref.rng.float();   // 對照組：只抽排下一招的那一個
  assert(a.mechState.next.seal === 0 && a.rng.float() === ref.rng.float(), 'the turn drew one random number (the next move): ' + J(a.mechState.next));
}));

// ---------------- 快照 / 裁判 / 畫面 ----------------

await test('快照：預定的下一招（cyclopsNext）、被封住的平台（cyclopsSealed：超巨石照快照放回地形）、壓碎 / 掉下來的鐘乳石、火把、巨人的血量，重連時照快照重建；擊碎之後的快照也對', () => base(() => {
  const m = make(2, { seed: 5 });
  placeOn(m, m.players[0], 980, 370);
  placeOn(m, m.players[1], 1000, 370);
  m.terrain.carve(500, 345, 30);   // 封住之前炸的坑（在巨石底下）
  cyclopsTurn(m, 'throw', { seal: 1 });      // 封中岩柱
  m.terrain.carve(150, 300, 30);   // 封住之後炸的坑（巨石旁邊的土）
  m.mechState.lit[2] = 1;          // 第 1 輪點燃的
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(Object.keys(snap)) === J(['entities', 'holes', 'minions', 'treeNext', 'snakeNext', 'items', 'bees', 'torches', 'fallen', 'cyclopsNext', 'cyclopsSealed']), 'keys ' + Object.keys(snap));
  assert(J(snap.cyclopsSealed) === '[1]' && J(snap.cyclopsNext) === J(m.mechState.next), 'sealed + next in the snapshot');
  const c = make(2, { seed: 5 });
  c.applySnapshot(snap);
  assertSame(m, c, 'snapshot');
  assert(J(c.mechState.next) === J(m.mechState.next), 'next restored');
  // 已經有東西的客戶端再收到一次（例如重連）：一樣
  c.applySnapshot(JSON.parse(J(m.snapshot())));
  assertSame(m, c, 'snapshot twice');
  c.mechanic.restore(c, { items: [] });   // 客戶端收到 turn 只帶 items：別的不動
  assert(J(c.mechState.sealed) === '[1]' && c.terrain.at(500, 200) === BOULDER, 'partial restore leaves it alone');
  // 擊碎之後：快照沒有封住的平台，舊的客戶端（還有巨石）套上去就拿掉
  shatterBoulders(m);
  c.applySnapshot(JSON.parse(J(m.snapshot())));
  assertSame(m, c, 'after the roar');
  assert(c.terrain.at(500, 200) === 0, 'boulder gone on the client');
}));

await test('裁判流程：玩家都斷線（AI 代打）時一直打到結束；巨人的回合是 boss 招式：猛捶（ledge：不打封住 / 這回合要封的平台，只剩他那根時不放）/ 巨石投擲（targetIds）、有超巨石的回合多一招 seal（ledge、killed、rocks、torches）、震盪獅吼（shattered、targetIds）；預定的猛捶記 nextLedge、要丟超巨石的記 nextSeal', () => base(() => {
  const out = {};
  for (const seed of [2, 7, 11]) {
    const m = make(2, { seed });
    for (const p of m.players) { p.hp = p.maxHp = 4000; }
    placeOn(m, m.players[0], 980, 370);   // 待在巨人的岩柱上才撐得到震盪獅吼（AI 代打可能還是會走開）
    placeOn(m, m.players[1], 1000, 370);
    const io = new FakeIo();
    let over = null;
    const ref = new Referee({ match: m, humans: mkPlayers(2), io, onGameOver: (r) => { over = r; } });
    ref.start();
    for (const p of mkPlayers(2)) ref.setConnected(p.id, false);
    while (!over && io.t < 30_000_000) io.advance(500);
    assert(over === 'win' || over === 'lose', `${seed}: ended ${over}`);
    const turns = io.take('aiTurn').filter(t => t.actorId === 'cyclops');
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.actor === 'cyclops');
    assert(turns.length >= 2 && recs.length === turns.length, `${seed}: cyclops turns ${turns.length}`);
    const counts = { pound: 0, throw: 0, seal: 0, roar: 0 };
    let sealed = [];   // 照廣播一回合一回合推：那一回合開始時被封住的平台
    turns.forEach((t, i) => {
      const acts = t.boss.steps.map(s => s.action);
      const n = i + 1;
      const sp = specialFor(m, n);
      // 第 n 回合照排好的出：震盪獅吼的回合只有獅吼；其他回合一般招式（有超巨石的回合後面再接超巨石，一般招式把人全打倒了就沒有）
      if (sp && sp.roar) assert(J(acts) === '["roar"]', `turn ${n}: ${J(acts)} (roar turn)`);
      else assert(['pound', 'throw'].includes(acts[0]) && (acts.length === 1 || (acts[1] === 'seal' && sp && sp.seal === t.boss.steps[1].ledge)), `turn ${n}: ${J(acts)} vs ${J(sp)}`);
      const pound = t.boss.steps.find(st => st.action === 'pound');
      if (pound) {
        const thisSeal = sp && !sp.roar ? sp.seal : undefined;
        const open = [0, 1, 2].filter(k => !sealed.includes(k) && k !== thisSeal);
        assert(open.includes(pound.ledge) && open.some(k => k !== 2), `turn ${n}: pound on ledge ${pound.ledge}, sealed ${J(sealed)}, sealing ${thisSeal}`);
      }
      for (const st of t.boss.steps) {
        counts[st.action]++;
        if (st.action === 'seal') sealed.push(st.ledge);
        if (st.action === 'roar') sealed = [];
      }
      t.boss.steps.forEach((st, k) => {
        const lg = recs[i].boss[k];
        assert(lg && lg.action === st.action, `turn ${n} step ${k}: logged ${J(lg)}`);
        if (st.action === 'throw') assert(J(lg.targetIds) === J(st.targetIds) && st.targetIds.length === st.shot.projectiles.length, `turn ${n}: throw targets`);
        if (st.action === 'seal') {
          assert(Number.isInteger(st.ledge) && lg.ledge === st.ledge && J(lg.killed) === J(st.killed) && J(lg.rocks) === J(st.rocks) && J(lg.torches) === J(st.torches) && lg.cast === st.cast, `turn ${n}: seal logged ${J(lg)}`);
        }
        if (st.action === 'roar') assert(J(lg.shattered) === J(st.shattered) && J(lg.targetIds) === J(st.targetIds), `turn ${n}: roar logged ${J(lg)}`);
        if (st.action === 'pound') assert(lg.ledge === st.ledge && J(lg.falls) === J(st.shot.events.flatMap(ev => ev.falls || []).length ? st.shot.events.flatMap(ev => ev.falls || []) : undefined), `turn ${n}: pound logged ${J(lg)}`);
      });
      const next = t.boss.next;
      assert(recs[i].next === (next && next.action), `turn ${n}: next ${J(next)} / logged ${recs[i].next}`);
      if (next && Number.isInteger(next.seal)) assert(recs[i].nextSeal === next.seal, `turn ${n}: nextSeal`);
      else assert(!('nextSeal' in recs[i]), `turn ${n}: no nextSeal for ${J(next)}`);
      if (next && next.action === 'pound') assert(Number.isInteger(next.ledge) && recs[i].nextLedge === next.ledge, `turn ${n}: nextLedge`);
      else assert(!('nextLedge' in recs[i]), `turn ${n}: no nextLedge for ${J(next)}`);
    });
    // 壓死人：紀錄的 changes 裡也是 died: crushed
    for (const [i, t] of turns.entries()) {
      const seal = t.boss.steps.find(s => s.action === 'seal');
      for (const id of (seal && seal.killed) || []) assert(recs[i].changes.some(ch => ch.id === id && ch.died === 'crushed'), `turn ${i + 1}: ${id} crushed in changes`);
    }
    out[seed] = { over, cyclopsTurns: turns.length, ...counts };
  }
  assert(Object.values(out).some(o => o.seal > 0), 'some turn sealed a ledge: ' + J(out));
  assert(Object.values(out).some(o => o.pound > 0), 'some turn pounded: ' + J(out));
  return out;
}));

await test('裁判：開場就排好的第一招記在 battle.start（同 ai.turn）：猛捶帶 nextLedge、巨石投擲只有 next；sealEvery 1 時第一回合就要丟超巨石，記 nextSeal 0（猛捶就不打左高台）', () => base(() => {
  const out = {};
  for (const [action, every] of [['pound', 2], ['throw', 2], ['pound', 1], ['throw', 1]]) {
    const m = base(() => make(2), { CYCLOPS: { sealEvery: every, weights: { pound: action === 'pound' ? 1 : 0, throw: action === 'throw' ? 1 : 0 } } });
    const plan = m.mechState.next;
    const io = new FakeIo();
    new Referee({ match: m, humans: mkPlayers(2), io }).start();
    const bs = io.records.find(r => r.ev === 'battle.start');
    const label = `${action} / sealEvery ${every}`;
    assert(bs.next === action && !('nextTarget' in bs), `${label}: battle.start logs the opening move: ` + J(bs.next));
    assert(action === 'pound' ? bs.nextLedge === plan.ledge : !('nextLedge' in bs), `${label}: nextLedge ${bs.nextLedge}`);
    assert(every === 1 ? bs.nextSeal === 0 && plan.seal === 0 : !('nextSeal' in bs), `${label}: nextSeal ${bs.nextSeal}`);
    // 大家都在左高台：一般是打左高台，第一回合就要封左高台的話改打他自己那根（沒人站的平台一樣多，他那根優先）
    if (action === 'pound') assert(plan.ledge === (every === 1 ? 2 : 0), `${label}: pound ledge ${plan.ledge}`);
    out[label] = { nextLedge: bs.nextLedge ?? null, nextSeal: bs.nextSeal ?? null };
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

// 把伺服器的訊息餵給一個真的 GameView（每幀 update + render），回傳 { view, feed, run, msgs（餵過的訊息）}。run(until, maxMs) = 一直推進到 until() 成立
function liveView(m, players, io, ref, stageInfo = null) {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const msgs = [];   // 餵過的每一則訊息（feed 會清掉 io.log）
  const feed = () => { for (const msg of io.log.splice(0)) { msgs.push(msg); view.onMessage(msg); } };
  feed();
  const run = (until, maxMs = 300_000, step = 100) => {
    for (let t = 0; t < maxMs && !until() && ref.phase !== 'over'; t += step) {
      io.advance(step);
      feed();
      for (let f = 0; f < 6 && !until(); f++) { view.update(CONFIG.FIXED_DT); view.render(); }
    }
  };
  return { view, feed, run, msgs };
}
// drawShade 畫的字
const shadeTexts = (view) => {
  const out = [];
  const ctx = new Proxy(fakeCtx2d(), { get: (t, k) => (k === 'fillText' ? (s) => out.push(String(s)) : t[k]) });
  view.mapView.drawShade(ctx, view.mapCtx);
  return out;
};

await test('真的 GameView：地心探險從開場播到超巨石與震盪獅吼（玩家回合都超時跳過；每幀 update + render，含遮光）：客戶端的地形、封住的平台、鐘乳石、下一招跟伺服器一樣；菁英關的橫幅與音樂（洞穴的曲子）', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'depths', players, seed: 9, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 3000; }
  placeOn(m, m.byId('p1'), 980, 370);
  placeOn(m, m.byId('p2'), 1000, 370);
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 3, stageCount: 10, isBoss: false, type: 'elite', levelId: 'depths', levelName: '地心探險', cards: {} } });
  ref.start();
  const tracks = [];
  const { view, run, msgs } = liveView(m, players, io, ref);
  view.music = { play(t) { tracks.push(t); }, setRate() {} };
  assert(view.mapView.type === 'cyclops' && view.banner && view.banner.text === '菁英關：地心探險' && view.banner.sub, 'elite banner: ' + J(view.banner && view.banner.text));
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Set();
  let sealedOnClient = null;
  try {
    run(() => {
      for (const t of msgs.filter(x => x.t === 'aiTurn' && x.boss)) for (const s of t.boss.steps) seen.add(s.action);
      if (sealedOnClient === null && view.match.mechState.sealed.length === 2) sealedOnClient = J(m.mechState.sealed);
      return seen.has('roar') && !view.mapCtx.state.fx && view.match.mechState.sealed.length === 0 && !view.script && !view.queue.length;
    }, 2_000_000, 250);
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(seen.has('seal') && seen.has('roar') && seen.has('throw'), 'played: ' + [...seen]);
  assert(sealedOnClient !== null, 'the client had both ledges sealed at some point');
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(view.match.terrain.mask)) === 0, 'client terrain = server');
  assert(J(view.match.mechState.sealed) === J(m.mechState.sealed) && J(view.match.mechState.fallen) === J(m.mechState.fallen) && view.match.terrain.fallen.size === m.terrain.fallen.size, 'sealed / fallen synced');
  assert(J(view.match.mechState.next) === J(m.mechState.next), 'next synced: ' + J([view.match.mechState.next, m.mechState.next]));
  assert(tracks.filter(Boolean).every(t => t === 'cave' || t === 'caveFever') && tracks.includes('cave'), 'elite plays the cave music: ' + [...new Set(tracks)]);
  return { actions: [...seen], time: Math.round(view.time) };
}));

await test('真的 GameView：預定猛捶時，警示帶畫在預定的那個平台（next.ledge）上、HUD「下一招：猛捶」；巨人捶下去的預兆也畫在那一根，不是他自己那根', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'depths', players, seed: 9, stage: 3 });
  m.mechState.next = { action: 'pound', ledge: 1 };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const { view, run } = liveView(m, players, io, ref);
  // 記下警示帶（填滿的方塊）畫在哪
  const bands = () => {
    const rects = [];
    const ctx = new Proxy(fakeCtx2d(), { get: (t, k) => (k === 'fillRect' ? (...a) => rects.push(a.map(Math.round)) : t[k]) });
    view.mapView.drawShade(ctx, view.mapCtx);
    return rects;
  };
  const mid = poundLane(m, 1), own = poundLane(m, 2);
  const isBand = (r, lane) => r[0] === lane.x0 && r[1] === lane.top && r[2] === lane.x1 - lane.x0 && r[3] === lane.bottom - lane.top;
  assert(J(view.match.mechState.next) === '{"action":"pound","ledge":1}', 'client has the plan: ' + J(view.match.mechState.next));
  assert(view.mapView.hud(view.mapCtx, ['x', '#fff']).at(-1)[0] === '下一招：猛捶', 'hud');
  let r = bands();
  assert(r.some(x => isBand(x, mid)) && !r.some(x => isBand(x, own)), 'player turn: band on the middle pillar: ' + J(r));
  let casting = null;
  run(() => {
    const fx = view.mapCtx.state.fx;
    if (fx && fx.action === 'pound' && fx.phase === 'cast') casting = fx;
    return !!casting;
  });
  assert(casting && casting.ledge === 1, 'casting the planned pound: ' + J(casting));
  r = bands();
  assert(r.some(x => isBand(x, mid)) && !r.some(x => isBand(x, own)), 'cast: band on the middle pillar: ' + J(r));
}));

await test('真的 GameView：超巨石——玩家回合 HUD「下一招：巨石投擲（全員）」「＋超巨石：封住左高台」、要封的那一段畫著「超巨石」警示；砸下去之後警示不見、站在上面的人「被超巨石壓扁了！」（不畫屍體）、客戶端的地形跟伺服器一樣', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'depths', players, seed: 9, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 3000; }
  placeOn(m, m.byId('p2'), 980, 370);   // P1 留在左高台上
  m.mechState.next = { action: 'throw', seal: 0 };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const { view, run } = liveView(m, players, io, ref);
  const hud = view.mapView.hud(view.mapCtx, ['x', '#fff']);
  assert(hud.at(-2)[0] === '下一招：巨石投擲（全員）' && hud.at(-1)[0] === '＋超巨石：封住左高台' && hud.at(-1)[1] === hud.at(-2)[1], 'hud ' + J(hud));
  assert(shadeTexts(view).includes('超巨石'), 'warning drawn during the player turn');
  const banners = [];
  let landed = false;
  run(() => {
    if (view.banner && banners.at(-1) !== view.banner.text) banners.push(view.banner.text);
    landed = view.match.mechState.sealed.includes(0) && !view.script && !view.queue.length;
    return landed;
  });
  assert(landed, 'the seal landed on the client');
  assert(banners.includes('獨眼巨人：超巨石 → 封住左高台！') && banners.includes('P1 被超巨石壓扁了！'), 'banners ' + J(banners));
  const p1 = view.match.byId('p1');
  assert(!p1.alive && p1.deathCause === 'crushed' && view.mapView.drawEntityBare(null, view.mapCtx, p1) === true, 'P1 crushed and not drawn');
  assert(!shadeTexts(view).includes('超巨石'), 'no warning once sealed');
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(view.match.terrain.mask)) === 0, 'client terrain = server');
  return { banners: banners.filter(b => /超巨石/.test(b)) };
}));

await test('真的 GameView：震盪獅吼——玩家回合 HUD「下一招：震盪獅吼」；吼下去那一刻兩塊超巨石都擊碎（客戶端的地形跟伺服器一樣）、橫幅「獨眼巨人：震盪獅吼！」、被震到的人飄「震退！」；播完血量、位置跟伺服器一樣', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'depths', players, seed: 9, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 3000; }
  for (const i of [0, 1]) sealLedge(m, i);
  placeOn(m, m.byId('p1'), 900, 370);
  placeOn(m, m.byId('p2'), 1000, 370);
  m.mechState.turns = 5;
  m.mechState.next = { action: 'roar' };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const { view, run, msgs } = liveView(m, players, io, ref);
  assert(J(view.match.mechState.sealed) === '[0,1]', 'client starts with both boulders: ' + J(view.match.mechState.sealed));
  assert(view.mapView.hud(view.mapCtx, ['x', '#fff']).at(-1)[0] === '下一招：震盪獅吼', 'hud');
  const floats = [], banners = [];
  const floatText = view.floatText.bind(view);
  view.floatText = (e, s, ...rest) => { floats.push([e.id, s]); return floatText(e, s, ...rest); };
  let sent = null, done = false;
  run(() => {
    if (!sent) sent = msgs.find(x => x.t === 'aiTurn' && x.actorId === 'cyclops') || null;
    if (view.banner && banners.at(-1) !== view.banner.text) banners.push(view.banner.text);
    done = !!sent && view.match.mechState.sealed.length === 0 && !view.script && !view.queue.length;
    return done;
  });
  assert(done && sent.boss.steps[0].action === 'roar', 'roared: ' + J(sent && sent.boss.steps.map(s => s.action)));
  assert(banners.includes('獨眼巨人：震盪獅吼！'), 'banner ' + J(banners));
  assert(J(floats.filter(f => f[1] === '震退！').map(f => f[0]).sort()) === '["p1","p2"]', 'floats ' + J(floats));
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(view.match.terrain.mask)) === 0, 'client terrain = server');
  const want = sent.boss.steps[0].shot.results.filter(s => s.id.startsWith('p')).map(s => [s.id, s.hp, Math.round(s.x)]);
  const got = view.match.players.map(p => [p.id, p.hp, Math.round(p.x)]);
  assert(J(got) === J(want), 'client = server after the roar: ' + J({ got, want }));
  return { after: got };
}));

await test('真的 GameView：巨石投擲——預兆時橫幅「獨眼巨人：巨石投擲 → 全員！」、每個目標身上都有準星（丟出去之後就不畫）、眼睛盯著第一個目標（預兆時就轉向他）；播完客戶端的血量 / 流血 5 層跟伺服器一樣', () => base(() => {
  const players = mkPlayers(3);
  const m = new Match({ levelId: 'depths', players, seed: 9, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 3000; }
  placeOn(m, m.byId('p2'), 560, 330);
  placeOn(m, m.byId('p3'), 1000, 370);   // 他身後
  m.mechState.next = { action: 'throw' };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  const hud = view.mapView.hud(view.mapCtx, ['x', '#fff']);
  // 血量、下一招各一行（接在同一行會超出右上的名單框），顏色一樣
  assert(/^獨眼巨人 \d+ \/ \d+$/.test(hud.at(-2)[0]) && hud.at(-1)[0] === '下一招：巨石投擲（全員）' && hud.at(-1)[1] === hud.at(-2)[1], 'hud ' + J(hud));
  // drawShade 畫的圓（圓心、半徑都取整數）
  const arcs = () => {
    const out = [];
    const ctx = new Proxy(fakeCtx2d(), { get: (t, k) => (k === 'arc' ? (...a) => out.push(a.slice(0, 3).map(Math.round)) : t[k]) });
    view.mapView.drawShade(ctx, view.mapCtx);
    return out;
  };
  const ringOn = (list, t) => list.some(a => a[0] === Math.round(t.x) && a[1] === Math.round(t.cy) && a[2] === Math.round(Math.max(t.h, 2 * t.hw) * 0.75 + 6));
  assert(!view.match.players.some(t => ringOn(arcs(), t)), 'no reticles during the player turns');
  let sent = null, cast = null, flying = null, after = null;
  for (let k = 0; k < 9000 && !after && ref.phase !== 'over'; k++) {
    io.advance(100);
    if (!sent) sent = io.log.find(x => x.t === 'aiTurn' && x.actorId === 'cyclops') || null;
    feed();
    for (let f = 0; f < 6 && !after; f++) {
      view.update(CONFIG.FIXED_DT);
      view.render();
      const fx = view.mapCtx.state.fx;
      if (!cast && fx && fx.action === 'throw' && fx.phase === 'cast' && fx.t > 0.2) {
        const list = arcs();
        cast = { banner: view.banner && view.banner.text, rings: view.match.players.filter(t => ringOn(list, t)).map(t => t.id), targetId: fx.targetId, facing: view.match.byId('cyclops').facing };
      }
      if (cast && !flying && fx && fx.phase === 'act') flying = view.match.players.filter(t => ringOn(arcs(), t)).map(t => t.id);
      if (cast && !fx) after = view.match.players.map(p => ({ id: p.id, hp: p.hp, bl: p.bleed }));
    }
  }
  assert(sent && sent.boss.steps[0].action === 'throw', 'the cyclops threw: ' + J(sent && sent.boss.steps[0].action));
  const step = sent.boss.steps[0];
  assert(J([...step.targetIds].sort()) === '["p1","p2","p3"]' && step.targetIds[0] === 'p3', 'everyone, nearest (behind him) first: ' + J(step.targetIds));
  assert(cast && cast.banner === '獨眼巨人：巨石投擲 → 全員！', 'banner: ' + J(cast));
  assert(J(cast.rings.sort()) === '["p1","p2","p3"]', 'reticles on everyone during the cast: ' + J(cast.rings));
  assert(cast.targetId === step.targetIds[0], 'the eye looks at the first target: ' + cast.targetId);
  assert(step.shot.facing === 1 && cast.facing === 1, 'turns to the first target (behind him) already during the cast: ' + J([step.shot.facing, cast.facing]));
  assert(flying && !flying.length, 'no reticles once the boulders fly: ' + J(flying));
  // 播完：每個人的血量、流血層數跟伺服器那一招的結果一樣（流血 5 層）
  const want = step.shot.results.filter(s => s.id.startsWith('p')).map(s => ({ id: s.id, hp: s.hp, bl: s.bl }));
  assert(after && J(after) === J(want) && want.every(s => s.bl === 5 && s.hp < 3000), 'client = server after the throw: ' + J({ after, want }));
  return { targets: step.targetIds, hp: after.map(s => s.hp) };
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
