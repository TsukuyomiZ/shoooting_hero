// node test/gaia.js
// 2026-11-04：莫利亞森林第 11 關的主題王「大地祭壇」的大地之母・蓋亞（規則在 shared/maps/gaia.js、數字在 config.GAIA / WEAPONS.gaiaCrush / gaiaSmite）：
// 地圖（只有主題排得到、地形炸不壞、每一層都跳得到：真的物理）、血量照第 11 關 ×1.9 與人數、瘴氣（第 1 輪、花數、回合開始 +3 層、免疫）、
// 撿花（路線碰到就撿、AI 代打走路也撿、收滿祭壇淨化：瘴氣散、中毒歸零（上限不回來）、回 10%、蓋亞暈眩一回合；3 輪後重放瘴氣、舊的花消失）、
// 捏碎（只打中間那一欄、往離開祭壇的方向飛、客戶端重播一致）/ 天罰（一整邊）/ 巨拳・同罰（圈裡的人平分、客戶端重播一致）/ 自然・淨化（只淨化她自己、回 5%）、
// 暴走（50% 門檻、瘴氣永久 1 層、不再淨化）、最後之光（傳送到祭壇、花數、收花兩輪、枯萎、護盾、誅滅、最後之光那幾回合不放捏碎、再數 5 輪）、
// 快照重建、裁判流程與紀錄（每一招、撿花、回合開始的瘴氣、開場的第一招）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { runConfig } from '../shared/game/stage-rules.js';
import { themeLevels, openThemes } from '../shared/game/themes.js';
import { Entity } from '../shared/physics/entities.js';
import { standY } from '../shared/maps/guardian.js';
import {
  GAIA_ID, WITHER_TEXT, gaiaOf, slopeY, stackSharers, zoneOf, inShield, inLightWindow, lightStatus, flowerCenter, touchFlowers, applyGaiaPickup, planGaiaNext,
} from '../shared/maps/gaia.js';
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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

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

// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原
function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, structuredClone(CONFIG[k])]));
  const apply = (dst, src) => { for (const [k, v] of Object.entries(src)) { if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') apply(dst[k], v); else dst[k] = v; } };
  for (const [k, v] of Object.entries(patch)) apply(CONFIG[k], v);
  const restore = () => { for (const [k, v] of Object.entries(saved)) { for (const key of Object.keys(CONFIG[k])) delete CONFIG[k][key]; Object.assign(CONFIG[k], v); } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}
const BASE = {
  ENEMY: { damageMult: 0.7, lateFromStage: 6, damageMultLate: 1 },
  RUN: { stageCount: 10, bossStages: [5, 10], bossHpPerStage: 0.15 },
  PLAYER: { hp: 150, stamina: 200, moveSpeed: 130, jumpSpeed: 380, moveCost: 45, jumpCost: 30 },
  GRAVITY: undefined,
  FEVER: { inBoss: false }, POISON: { pctPerStack: 1, persist: true },
  WATER: { damagePct: 30, enemiesDrown: true, safeMargin: 10 },
  GAIA: {
    hp: 500, hw: 90, h: 190, weights: { crush: 30, smite: 30, stack: 25, cleanse: 15 }, stackRadius: 80, fogEvery: 3, fogPoison: 3, ragePoison: 1,
    flowers: { 1: 2, 2: 2, 3: 2, 4: 3 }, lightFlowers: { 1: 2, 2: 4, 3: 4, 4: 6 }, purifyHealPct: 10, cleanseHealPct: 5,
    ragePct: 50, lightEvery: 5, lightCollectRounds: 2,
  },
  WEAPONS: { gaiaCrush: { damage: 10, knockback: 500 }, gaiaSmite: { damage: 9, knockback: 100 }, gaiaStack: { damage: 20, knockback: 0 } },
};
delete BASE.GRAVITY;
const base = (fn) => withConfig(BASE, fn);
const STAGE = { stage: 5, stageCount: 10, isBoss: true, type: 'boss', levelId: 'gaiaSanctum', levelName: '大地祭壇', cards: {} };
// 第 5 關（敵人傷害 ×0.7、血量只吃人數）；第 11 關的倍率另外測
const make = (n = 2, opts = {}) => new Match({ levelId: 'gaiaSanctum', players: mkPlayers(n), seed: 1, stage: 5, ...opts });
const tough = (m, hp = 5000) => { for (const p of m.players) { p.hp = p.maxHp = hp; } };
// 第 round 輪她的回合
const turnAt = (m, round) => { m.round = round; return m.mechanic.aiTurn(m, gaiaOf(m)); };
const steps = (r) => r.steps.map(s => s.action);
const pick = (m) => J({ ...m.mechState, def: undefined });
const def = () => LEVELS.gaiaSanctum.mechanic;
// 把 p 放到 x 那一行站得住的地方（離 refY 最近）
const place = (m, p, x, refY) => {
  const y = standY(m, p, x, refY);
  assert(y !== null, `no standing spot at ${x},${refY}`);
  Object.assign(p, { x, y, vx: 0, vy: 0, onGround: true, moveDir: 0 });
};
// 站在花上（腳底在花的那一行的斜坡表面）的路線：從旁邊 30px 走過去
const walkOnto = (m, p, f) => {
  const s = m.mechState.def.slopes[f.slope];
  const out = s.x0 < s.x1 ? -1 : 1;   // 往外（牆）那邊
  place(m, p, f.x + out * 30, f.y);
  const x0 = p.x, y0 = p.y;
  place(m, p, f.x, f.y);
  return m.mechanic.moved(m, p, x0, y0, p.x, p.y);
};

// ---------------- 地圖 ----------------

await test('地圖：大地祭壇是 Boss 池但只有主題排得到（themeOnly：一般冒險的 Boss 池不變）；莫利亞森林開放、第 11 關就是它；地形全部炸不壞（斜坡 hard、中間三層可穿透）；底下是有毒的水', () => base(() => {
  const L = LEVELS.gaiaSanctum;
  assert(L.name === '大地祭壇' && L.pool === 'boss' && L.themeOnly === true && L.mechanic.type === 'gaia', 'level');
  assert(!levelsInPool('boss').includes('gaiaSanctum') && levelsInPool('boss').join() === 'treeGarden,jungleSerpent,scorpionDen,prisonYard,spiderNest', 'normal boss pool ' + levelsInPool('boss'));
  assert(J(themeLevels('moria', 11)) === J(['gaiaSanctum']) && openThemes().includes('moria'), 'theme open');
  assert(L.polygons.length === 0 && L.hardPolygons.length === 6 && L.platforms.length === 3 && L.enemySpawns.length === 0, 'terrain');
  assert(Array.isArray(L.waterColors) && L.waterColors.length === 2, 'water colors');
  // 斜坡：外側貼牆、往中間斜下來，內側的高度 = 同一層平台；右邊是左邊的鏡像
  const D = def();
  D.slopes.forEach((s, k) => {
    const t = D.tiers[k % 3];
    assert(s.y1 === t.y && s.y1 > s.y0 && (k < 3 ? s.x0 === 0 && s.x1 < t.x0 : s.x0 === 1024 && s.x1 > t.x1), 'slope ' + k + ' ' + J(s));
    if (k >= 3) assert(s.x1 === 1024 - D.slopes[k - 3].x1 && s.y0 === D.slopes[k - 3].y0, 'mirror ' + k);
  });
  assert(D.tiers[0].x0 > D.tiers[1].x0 && D.tiers[1].x0 > D.tiers[2].x0 && D.tiers[1].y - D.tiers[0].y === 70 && D.tiers[2].y - D.tiers[1].y === 70, 'tiers');
  // 炸不壞：一發大砲打在斜坡、平台上，地形不變
  const m = make(1);
  const mask = Buffer.from(m.terrain.mask);
  m.terrain.carve(150, slopeY(D.slopes[1], 150), 60);
  m.terrain.carve(512, 515, 60);
  assert(Buffer.compare(mask, Buffer.from(m.terrain.mask)) === 0, 'indestructible');
  return { slopes: D.slopes.slice(0, 3).map(s => [s.x1, s.y1]), tiers: D.tiers.map(t => [t.x0, t.x1, t.y]) };
}));

await test('蓋亞：臉在背景正上方（固定、Boss、打得到、不在牆裡），血量 = 500 × Boss 倍率（第 11 關 ×1.9、每多一人 +50%）；50% 門檻；大家開場站在祭壇那一層；開場就抽好第一招', () => base(() => {
  const out = {};
  for (const n of [1, 2, 3, 4]) {
    const m = new Match({ levelId: 'gaiaSanctum', players: mkPlayers(n), seed: n, stage: 11, config: runConfig({ theme: 'moria' }) });
    const g = gaiaOf(m);
    const want = Math.round(500 * 1.9 * (1 + 0.5 * (n - 1)));
    assert(g.maxHp === want && g.hp === want, `${n}p hp ${g.maxHp} vs ${want}`);
    assert(g.hpFloor === Math.round(want / 2), 'floor 50%');
    out[n] = want;
    if (n !== 2) continue;
    assert(m.entities[m.entities.length - 1] === g && g.id === GAIA_ID && g.name === '大地之母・蓋亞' && g.kind === 'gaia', 'gaia last');
    assert(g.boss && g.fixed && !g.intangible && !g.noTurn && g.team === 'enemies', 'flags');
    assert(g.x === 512 && g.y === 330 && g.hw === 90 && g.h === 190, 'face box ' + J([g.x, g.y, g.hw, g.h]));
    for (const p of m.players) assert(p.onGround && near(p.y, 510, 2) && p.x > 382 && p.x < 642 && inShield(m.mechState.def, p), `${p.id} on the altar tier ${p.x},${p.y}`);
    const S = m.mechState;
    assert(S.next && ['crush', 'smite', 'stack', 'cleanse'].includes(S.next.action), 'planned ' + J(S.next));
    assert(S.fog === false && S.nextFog === 1 && S.rage === false && S.lightAt === null && S.light === null && S.flowers.length === 0, 'fresh state');
  }
  return out;
}));

// ---------------- 真的物理：每一層都跳得到 ----------------

// 這張地圖用真的 Entity / Terrain 跑：從 (x, refY) 附近站好，往 dir 走（0 = 不走），第 jump 幀起跳（null = 不跳）、走 release 幀就放開方向鍵；
// 落地（離開地面又站穩）之後回傳站在哪（slope k / tier k / water）
function surfaceOf(D, e) {
  for (let k = 0; k < D.slopes.length; k++) {
    const s = D.slopes[k];
    const lo = Math.min(s.x0, s.x1) - (s.x0 < s.x1 ? 0 : 8), hi = Math.max(s.x0, s.x1) + (s.x0 < s.x1 ? 8 : 0);
    if (e.x >= lo && e.x <= hi && Math.abs(e.y - slopeY(s, Math.max(Math.min(e.x, Math.max(s.x0, s.x1)), Math.min(s.x0, s.x1)))) < 9) return 'S' + k;
  }
  for (let k = 0; k < D.tiers.length; k++) {
    const t = D.tiers[k];
    if (e.x >= t.x0 - 7 && e.x <= t.x1 + 7 && Math.abs(e.y - (t.y - 1)) < 3) return 'T' + k;
  }
  return e.y > CONFIG.WATER_LEVEL - 20 ? 'water' : `?${Math.round(e.x)},${Math.round(e.y)}`;
}
function hop(m, x, refY, dir, jump, release) {
  const e = new Entity({ ...CONFIG.PLAYER, id: 'probe', team: 'players', x, y: refY - 1, hp: 100, stamina: 9999 });
  const world = { ...m.world, entities: [] };
  e.y = standY(m, e, x, refY - 1);
  assert(e.y !== null, `probe stands at ${x},${refY}`);
  for (let i = 0; i < 5; i++) e.update(CONFIG.FIXED_DT, world);
  const from = surfaceOf(m.mechState.def, e);
  let air = false;
  for (let f = 0; f < 300; f++) {
    e.moveDir = f < release ? dir : 0;
    if (f === jump) e.wantJump = true;
    e.update(CONFIG.FIXED_DT, world);
    if (e.waterFalls > 0) return { from, to: 'water' };
    if (!e.onGround) air = true;
    else if (air) return { from, to: surfaceOf(m.mechState.def, e), x: Math.round(e.x), y: Math.round(e.y) };
  }
  return { from, to: 'stuck' };
}
// 找一個做得到的操作（起跳時按著方向，放開的時機試幾種；walk = 不跳、走出邊緣再放開）
function reach(m, x, refY, dir, want, { walk = false } = {}) {
  const releases = walk ? [2, 4, 6, 8, 10, 12, 15, 20] : [9999, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
  for (const r of releases) {
    const o = hop(m, x, refY, dir, walk ? null : (dir === 0 ? 0 : 0), r);
    if (o.to === want) return { r, ...o };
  }
  return null;
}

await test('真的物理：每一層都跳得到（沒有二段跳）——斜坡內側 ↔ 同一層的中間平台（左右兩邊）、下層 → 祭壇 → 上層往上跳穿過平台、上層 → 祭壇 → 下層走出邊緣掉下去；斜坡從內側走到牆邊再走回來不會掉下去', () => base(() => {
  const m = make(1);
  const D = m.mechState.def;
  const used = {};
  for (const side of [0, 1]) {
    const toward = side ? -1 : 1;   // 往中間
    for (let k = 0; k < 3; k++) {
      const s = D.slopes[side * 3 + k], t = D.tiers[k];
      const S = 'S' + (side * 3 + k), T = 'T' + k;
      const a = reach(m, s.x1 - toward * 2, s.y1, toward, T);
      assert(a && a.from === S, `${S} → ${T}: ${J(hop(m, s.x1 - toward * 2, s.y1, toward, 0, 9999))}`);
      const edge = side ? t.x1 - 3 : t.x0 + 3;
      const b = reach(m, edge, t.y, -toward, S);
      assert(b && b.from === T, `${T} → ${S}: ${J(hop(m, edge, t.y, -toward, 0, 9999))}`);
      used[`${S}>${T}`] = a.r;
      used[`${T}>${S}`] = b.r;
      // 沿著斜坡走：從內側走到牆邊（不掉下去），再走回內側
      const e = new Entity({ ...CONFIG.PLAYER, id: 'walker', team: 'players', x: s.x1 - toward * 4, y: 0, hp: 100, stamina: 9999 });
      e.y = standY(m, e, e.x, s.y1 - 1);
      const world = { ...m.world, entities: [] };
      e.moveDir = -toward;
      for (let f = 0; f < 200; f++) e.update(CONFIG.FIXED_DT, world);
      assert(surfaceOf(D, e) === S && Math.abs(e.x - s.x0) < 12, `${S}: walked to the wall ${e.x},${e.y}`);
      e.moveDir = toward;
      for (let f = 0; f < 200 && Math.abs(e.x - s.x1) > 10; f++) e.update(CONFIG.FIXED_DT, world);
      assert(surfaceOf(D, e) === S && Math.abs(e.x - s.x1) <= 10, `${S}: walked back ${e.x},${e.y}`);
    }
  }
  // 中間：從下面那層（站在上面那層的正下方）原地往上跳，穿過可穿透的平台站上去
  for (const [k, up] of [[2, 1], [1, 0]]) {
    const o = hop(m, 512 - 60, D.tiers[k].y, 0, 0, 0);
    assert(o.from === 'T' + k && o.to === 'T' + up, `T${k} jump up → ${J(o)}`);
  }
  // 往下：走出邊緣、馬上放開方向鍵，掉到下面那層（左右兩邊）
  for (const [k, down] of [[0, 1], [1, 2]]) {
    for (const dir of [-1, 1]) {
      const t = D.tiers[k];
      const o = reach(m, dir < 0 ? t.x0 + 3 : t.x1 - 3, t.y, dir, 'T' + down, { walk: true });
      assert(o && o.from === 'T' + k, `T${k} walk off ${dir} → T${down}`);
      used[`T${k}>T${down}${dir < 0 ? 'L' : 'R'}`] = o.r;
    }
  }
  return used;
}));

// ---------------- 瘴氣與花 ----------------

await test('瘴氣：第 1 輪她的回合就放；花開在不同的斜坡上（斜坡的 20% ~ 80%、腳底在斜坡表面）：1 ~ 3 人 2 朵、4 人 3 朵；之後每 3 輪', () => base(() => {
  const out = {};
  for (const n of [1, 2, 3, 4]) {
    const m = make(n, { seed: 10 + n });
    tough(m);
    const r = turnAt(m, 1);
    const S = m.mechState;
    assert(steps(r)[0] === 'fog' && steps(r).length === 2, 'fog then a move ' + steps(r));
    const fog = r.steps[0];
    const want = n === 4 ? 3 : 2;
    assert(S.fog && S.nextFog === 4 && S.flowers.length === want && S.need === want && S.orbs === 0, `${n}p: ${S.flowers.length} flowers`);
    assert(J(fog.flowers) === J(S.flowers.map(f => f.id)) && fog.need === want && J(fog.blooms) === J(S.flowers) && J(fog.vanished) === '[]', 'step fields');
    assert(new Set(S.flowers.map(f => f.slope)).size === want, 'distinct slopes ' + J(S.flowers));
    for (const f of S.flowers) {
      const s = S.def.slopes[f.slope];
      const t = (f.x - s.x0) / (s.x1 - s.x0);
      assert(t >= 0.2 - 0.01 && t <= 0.8 + 0.01 && Math.abs(f.y - slopeY(s, f.x)) <= 0.5, 'on the slope ' + J(f));
    }
    out[n] = S.flowers.map(f => f.slope).join('');
    // 第 2、3 輪不放；第 4 輪再放（每 3 輪）
    assert(!steps(turnAt(m, 2)).includes('fog') && !steps(turnAt(m, 3)).includes('fog') && steps(turnAt(m, 4))[0] === 'fog' && S.nextFog === 7, 'every 3 rounds');
  }
  return out;
}));

await test('瘴氣：玩家回合開始（中毒結算之後）+3 層、fx gaiaFog（新的層數下一回合才咬人）；金剛不壞免疫（fx immune）；蓋亞自己的回合不加；沒瘴氣不加', () => base(() => {
  const m = make(2);
  tough(m);
  const [p1, p2] = m.players;
  const g = gaiaOf(m);
  let fx = m.turnStartEffects(p1);
  assert(p1.poison === 0 && !fx.some(f => f.type === 'gaiaFog'), 'no fog yet');
  turnAt(m, 1);
  p2.mods.statusImmune = 1;
  fx = m.turnStartEffects(p1);
  assert(p1.poison === 3 && J(fx) === J([{ type: 'gaiaFog', id: 'p1', stacks: 3, total: 3 }]), 'fog +3 ' + J(fx));
  const hp = p1.hp;
  fx = m.turnStartEffects(p1);
  assert(p1.poison === 6 && fx[0].type === 'poison' && fx[0].stacks === 3 && p1.hp < hp && fx[1].type === 'gaiaFog' && fx[1].total === 6, 'ticks next turn ' + J(fx));
  fx = m.turnStartEffects(p2);
  assert(p2.poison === 0 && J(fx) === J([{ type: 'gaiaFog', id: 'p2', immune: true }]), 'immune ' + J(fx));
  fx = m.turnStartEffects(g);
  assert(g.poison === 0 && fx.length === 0, 'not on her');
  return { p1: p1.poison };
}));

await test('撿花：身體碰到花的路線就撿到（變成光球、祭壇 +1），沒碰到不撿；一段路碰到兩朵一次撿；AI 代打走路（simulateWalk）也撿得到；客戶端照 pickup 套出一樣的狀態', () => base(() => {
  const m = make(2, { seed: 3 });
  tough(m);
  const [p1, p2] = m.players;
  withConfig({ GAIA: { flowers: { 2: 3 } } }, () => turnAt(m, 1));
  const S = m.mechState;
  const cm = make(2, { seed: 3 });
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  assert(pick(cm) === pick(m), 'snapshot');
  const [f1, f2, f3] = S.flowers;
  // 沒碰到：在別的斜坡上走
  const other = S.def.slopes.findIndex((s, k) => !S.flowers.some(f => f.slope === k));
  const os = S.def.slopes[other];
  place(m, p1, Math.round((os.x0 + os.x1) / 2), slopeY(os, (os.x0 + os.x1) / 2));
  assert(m.mechanic.moved(m, p1, p1.x - 20, p1.y, p1.x, p1.y) === null, 'no flower there');
  // 碰到第一朵
  const fx = walkOnto(m, p1, f1);
  assert(fx && fx.type === 'gaiaFlower' && fx.id === 'p1' && J(fx.flowers) === J([f1.id]) && fx.orbs === 1 && fx.need === 3 && !fx.purify, 'picked ' + J(fx));
  assert(S.orbs === 1 && !S.flowers.some(f => f.id === f1.id) && S.fog, 'state');
  applyGaiaPickup(cm, JSON.parse(J(fx)));
  assert(pick(cm) === pick(m), 'client applies the pickup');
  // 碰到兩朵（路線穿過兩朵的中心）
  const c2 = flowerCenter(f2), c3 = flowerCenter(f3);
  assert(J(touchFlowers(m, p2, c2.x, c2.y + p2.h / 2, c3.x, c3.y + p2.h / 2)) === J([f2.id, f3.id]), 'touchFlowers only looks');
  assert(S.flowers.length === 2, 'touchFlowers does not pick');
  // AI 代打走路：站在花外側 40px，往花走
  const m2 = make(2, { seed: 3 });
  tough(m2);
  turnAt(m2, 1);
  const g1 = m2.mechState.flowers[0];
  const s1 = m2.mechState.def.slopes[g1.slope];
  const dir = s1.x0 < s1.x1 ? 1 : -1;   // 往中間（花在外側那邊）
  const w = m2.players[0];
  place(m2, w, g1.x - dir * 40, g1.y);
  const walk = m2.simulateWalk(w, dir, 60);
  const got = walk.pickups.find(pk => pk.type === 'gaiaFlower');
  assert(got && J(got.flowers) === J([g1.id]) && got.f > 0 && Number.isFinite(got.hp), 'AI walk picks ' + J(walk.pickups));
  return { picked: fx.flowers, walk: got.f };
}));

await test('祭壇淨化：光球收滿 → 瘴氣散、花清掉、活著的玩家中毒層數歸零（被鎖住的上限不回來）、回 10% 最大血量（heals）、蓋亞下一回合只有暈眩（下一招照舊留著、瘴氣照原本的輪數）；客戶端照 pickup 套出一樣的狀態', () => base(() => {
  const m = make(2, { seed: 4 });
  const [p1, p2] = m.players;
  turnAt(m, 1);
  const S = m.mechState;
  const cm = make(2, { seed: 4 });
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  for (const p of [p1, p2]) { p.poison = 7; p.poisonLock = 20; p.maxHp = 130; p.hp = 60; }
  for (const p of cm.players) { p.poison = 7; p.poisonLock = 20; p.maxHp = 130; p.hp = 60; }
  const [f1, f2] = S.flowers;
  const a = walkOnto(m, p1, f1);
  assert(a.orbs === 1 && !a.purify && S.fog, 'first orb');
  const b = walkOnto(m, p2, f2);
  assert(b.purify === true && b.orbs === 2 && b.need === 2 && J(b.cured) === '["p1","p2"]', 'purify ' + J(b));
  assert(J(b.heals) === J([{ id: 'p1', heal: 13, hp: 73 }, { id: 'p2', heal: 13, hp: 73 }]), 'heals 10% ' + J(b.heals));
  assert(!S.fog && S.flowers.length === 0 && S.orbs === 0 && S.need === 0 && S.stunned && S.nextFog === 4, 'state ' + pick(m));
  assert([p1, p2].every(p => p.poison === 0 && p.poisonLock === 20 && p.maxHp === 130 && p.hp === 73), 'poison cleared, lock kept');
  for (const fx of [a, b]) applyGaiaPickup(cm, JSON.parse(J({ ...fx, hp: m.byId(fx.id).hp })));
  assert(pick(cm) === pick(m) && cm.players.every(p => p.poison === 0 && p.hp === 73), 'client ' + pick(cm));
  // 淨化之後回合開始不再加中毒
  assert(!m.turnStartEffects(p1).some(f => f.type === 'gaiaFog'), 'fog gone');
  // 她的下一回合：只有暈眩，下一招不變
  const plan = J(S.next);
  const r = turnAt(m, 2);
  assert(J(steps(r)) === '["stunned"]' && r.steps[0].still && r.steps[0].cast === CONFIG.GAIA.cast.stunned, 'stunned ' + steps(r));
  assert(J(r.next) === plan && J(S.next) === plan && !S.stunned, 'plan kept');
  // 第 3 輪照預定的出招（還沒到瘴氣）、第 4 輪瘴氣回來
  assert(!steps(turnAt(m, 3)).includes('fog') && steps(turnAt(m, 4))[0] === 'fog' && S.fog, 'fog back on schedule');
  return { heals: b.heals };
}));

await test('瘴氣重放：祭壇沒收滿、3 輪後她的回合又放 → 舊的花消失（vanished）、祭壇歸零、重新開花；暈眩剛好卡到放瘴氣的那一回合 → 下一回合才放', () => base(() => {
  const m = make(2, { seed: 5 });
  tough(m);
  turnAt(m, 1);
  const S = m.mechState;
  const [f1, f2] = S.flowers;
  walkOnto(m, m.players[0], f1);
  assert(S.orbs === 1 && S.flowers.length === 1, 'one orb');
  turnAt(m, 2);
  turnAt(m, 3);
  const r = turnAt(m, 4);
  const fog = r.steps[0];
  assert(fog.action === 'fog' && J(fog.vanished) === J([f2.id]) && S.orbs === 0 && S.need === 2 && S.flowers.length === 2 && !S.flowers.some(f => f.id === f2.id), 'refog ' + J(fog));
  // 暈眩卡到第 7 輪：第 7 輪只有暈眩，第 8 輪放瘴氣
  S.stunned = true;
  turnAt(m, 5);
  assert(!S.stunned, 'stun spent on 5');
  S.stunned = true;
  assert(J(steps(turnAt(m, 7))) === '["stunned"]' && S.nextFog === 7, 'stunned on fog turn');
  assert(steps(turnAt(m, 8))[0] === 'fog' && S.nextFog === 11, 'fog the turn after');
  return { vanished: fog.vanished };
}));

// ---------------- 招式 ----------------

await test('巨掌・捏碎：只打身體碰到中間那一欄的人（斜坡上的不會），每人 10 × 開場人數 × 敵人傷害倍率、往離開祭壇的方向擊退（祭壇左邊往左、右邊往右，往上彈一點）；客戶端重播一致', () => base(() => {
  const m = make(3, { seed: 6 });
  tough(m);
  const [p1, p2, p3] = m.players;
  const D = m.mechState.def;
  place(m, p1, 440, 510);   // 祭壇左邊
  place(m, p2, 600, 440);   // 上層右邊
  place(m, p3, 150, slopeY(D.slopes[1], 150));   // 左中斜坡
  m.settle(60);
  const cm = make(3, { seed: 6 });
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  const hp = m.players.map(p => p.hp);
  m.mechState.next = { action: 'crush' };
  const r = turnAt(m, 2);
  const st = r.steps.find(s => s.action === 'crush');
  assert(st && J(st.targetIds) === '["p1","p2"]' && J(st.dirs) === '[-1,1]' && st.shot && st.shot.weapon === 'gaiaCrush', 'crush ' + J({ t: st && st.targetIds, d: st && st.dirs }));
  const W = CONFIG.WEAPONS.gaiaCrush;
  const want = W.damage * 3 * m.damageMult(gaiaOf(m), W) * m.feverMult();   // 每人 10 × 開場 3 人
  assert(st.dmg === 30, 'logged team-scaled damage ' + st.dmg);
  const hits = st.shot.events.filter(ev => ev.target);
  assert(J(hits.map(h => h.target).sort()) === '["p1","p2"]' && hits.every(h => h.damages.length === 1 && h.damages[0].dmg === Math.round(want)), 'damage ' + want + ' ' + J(hits.map(h => h.damages)));
  assert(near(want, 21, 1e-9) && p3.hp === hp[2], 'slope player untouched; 10 × 3 人 × 0.7');
  const kick = {};
  replayChecked(cm, JSON.parse(J(st.shot)), 'crush', { event: (ev) => { if (ev.target) kick[ev.target] = { vx: cm.byId(ev.target).vx, vy: cm.byId(ev.target).vy }; } });
  assert(kick.p1.vx === -500 && kick.p2.vx === 500 && near(kick.p1.vy, -175, 1e-9) && near(kick.p2.vy, -175, 1e-9), 'knocked away from the altar ' + J(kick));
  cm.applyEntities(st.shot.results);
  for (const p of m.players) { const c = cm.byId(p.id); assert(near(c.x, p.x, 1e-6) && near(c.y, p.y, 1e-6) && c.hp === p.hp, `${p.id} replay`); }
  assert(p1.x < 440 && p2.x > 600, 'flew outward ' + J([p1.x, p2.x]));
  // 正好在祭壇正上方：隨機一邊
  const m2 = make(1, { seed: 7 });
  tough(m2);
  place(m2, m2.players[0], 512, 510);
  m2.mechState.next = { action: 'crush' };
  const st2 = turnAt(m2, 2).steps.find(s => s.action === 'crush');
  assert(st2.dirs.length === 1 && Math.abs(st2.dirs[0]) === 1, 'random side at the altar ' + J(st2.dirs));
  return { landed: m.players.map(p => [p.id, Math.round(p.x), Math.round(p.y), p.waterFalls]) };
}));

await test('神掌・天罰：預定的那一邊整片（三道斜坡；中間那一欄的人不會），每人 9 × 開場人數 × 敵人傷害倍率、往牆那邊推一點；範圍裡沒人就空拍（still）', () => base(() => {
  const m = make(4, { seed: 8 });
  tough(m);
  const [p1, p2, p3, p4] = m.players;
  const D = m.mechState.def;
  place(m, p1, 120, slopeY(D.slopes[0], 120));
  place(m, p2, 200, slopeY(D.slopes[2], 200));
  place(m, p3, 500, 510);
  place(m, p4, 900, slopeY(D.slopes[4], 900));
  m.settle(60);
  const hp = m.players.map(p => p.hp);
  const x0 = [p1.x, p2.x];
  m.mechState.next = { action: 'smite', side: -1 };
  const st = turnAt(m, 2).steps.find(s => s.action === 'smite');
  assert(st.side === -1 && J(st.targetIds) === '["p1","p2"]' && J(st.dirs) === '[-1,-1]' && st.shot.weapon === 'gaiaSmite', 'smite ' + J(st.targetIds));
  const W = CONFIG.WEAPONS.gaiaSmite;
  const want = W.damage * 4 * m.damageMult(gaiaOf(m), W) * m.feverMult();   // 每人 9 × 開場 4 人
  assert(st.dmg === 36, 'logged team-scaled damage ' + st.dmg);
  assert(near(hp[0] - p1.hp, Math.round(want)) && near(hp[1] - p2.hp, Math.round(want)) && p3.hp === hp[2] && p4.hp === hp[3], 'damage ' + want);
  assert(p1.x < x0[0] && p2.x < x0[1], 'pushed toward the wall');
  assert(J(zoneOf(D, { action: 'smite', side: 1 })) === J({ x0: D.column.x1, x1: 1024 }) && J(zoneOf(D, { action: 'crush' })) === J({ x0: D.column.x0, x1: D.column.x1 }), 'zones');
  // 右邊沒人（p4 移到中間）：空拍
  place(m, p4, 520, 510);
  m.settle(60);
  m.mechState.next = { action: 'smite', side: 1 };
  const st2 = turnAt(m, 3).steps.find(s => s.action === 'smite');
  assert(st2.side === 1 && J(st2.targetIds) === '[]' && st2.still && !st2.shot, 'whiff');
  return { dmg: want };
}));

await test('巨拳・同罰：鎖定的人身邊 80px（身體中心）以內的活著的玩家平分總傷害 20 × 開場人數（每人 round(總 / 人數) × 敵人傷害倍率），圈外的不受影響、不擊退；記 targetId / targetIds / dmg / total；客戶端重播一致；剛好 80px 算、81px 不算', () => base(() => {
  const m = make(3, { seed: 15 });
  tough(m);
  const [p1, p2, p3] = m.players;
  const D = m.mechState.def;
  place(m, p1, 440, 510);
  place(m, p2, 480, 510);   // 離 p1 40px：一起分擔
  place(m, p3, 150, slopeY(D.slopes[1], 150));   // 斜坡上：不受影響
  m.settle(60);
  assert(J(stackSharers(m, p1).map(e => e.id)) === '["p1","p2"]', 'sharers ' + J(stackSharers(m, p1).map(e => e.id)));
  const cm = make(3, { seed: 15 });
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  const hp = m.players.map(p => p.hp), xs = m.players.map(p => p.x);
  m.mechState.next = { action: 'stack', targetId: 'p1' };
  const st = turnAt(m, 2).steps.find(s => s.action === 'stack');
  assert(st && st.targetId === 'p1' && J(st.targetIds) === '["p1","p2"]' && st.total === 60 && st.dmg === 30 && st.cast === CONFIG.GAIA.cast.stack && st.shot && st.shot.weapon === 'gaiaStack', 'stack ' + J({ ...st, shot: undefined }));
  const want = Math.round(30 * m.damageMult(gaiaOf(m), CONFIG.WEAPONS.gaiaStack) * m.feverMult());
  assert(want === 21 && hp[0] - p1.hp === want && hp[1] - p2.hp === want && p3.hp === hp[2], 'split ' + J([hp[0] - p1.hp, hp[1] - p2.hp, hp[2] - p3.hp]));
  assert(near(p1.x, xs[0]) && near(p2.x, xs[1]), 'no knockback');
  const hits = st.shot.events.filter(ev => ev.target);
  assert(J(hits.map(h => h.target).sort()) === '["p1","p2"]' && hits.every(h => h.damages.length === 1 && h.damages[0].dmg === want), 'one fist each ' + J(hits.map(h => h.damages)));
  replayChecked(cm, JSON.parse(J(st.shot)), 'stack');
  cm.applyEntities(st.shot.results);
  for (const p of m.players) { const c = cm.byId(p.id); assert(near(c.x, p.x, 1e-6) && near(c.y, p.y, 1e-6) && c.hp === p.hp, `${p.id} replay`); }
  // 邊界：剛好 80px 算、81px 不算
  place(m, p2, 520, 510);
  m.settle(60);
  assert(near(p2.cx - p1.cx, 80) && J(stackSharers(m, p1).map(e => e.id)) === '["p1","p2"]', '80px is inside ' + (p2.cx - p1.cx));
  place(m, p2, 521, 510);
  m.settle(60);
  assert(J(stackSharers(m, p1).map(e => e.id)) === '["p1"]', '81px is outside');
  return { each: want, total: st.total };
}));

await test('巨拳・同罰：一個人扛 = 全部總傷害（2 人 = 40）；三人擠在一起 = 各 round(60 / 3)；目標倒下了就重抽（不會對死人放）；最後之光那幾回合照樣會抽到、照樣放', () => base(() => {
  const m = make(2, { seed: 16 });
  tough(m);
  const [p1, p2] = m.players;
  const D = m.mechState.def;
  place(m, p1, 440, 510);
  place(m, p2, 900, slopeY(D.slopes[4], 900));
  m.settle(60);
  const hp = p1.hp;
  m.mechState.next = { action: 'stack', targetId: 'p1' };
  const st = turnAt(m, 2).steps.find(s => s.action === 'stack');
  assert(J(st.targetIds) === '["p1"]' && st.dmg === 40 && st.total === 40 && hp - p1.hp === Math.round(40 * 0.7) && p2.hp === 5000, 'alone takes it all ' + J({ ...st, shot: undefined }));
  const m3 = make(3, { seed: 17 });
  tough(m3);
  m3.players.forEach((p, i) => place(m3, p, 450 + i * 30, 510));
  m3.settle(60);
  m3.mechState.next = { action: 'stack', targetId: 'p2' };
  const st3 = turnAt(m3, 2).steps.find(s => s.action === 'stack');
  assert(st3.targetIds.length === 3 && st3.dmg === 20 && m3.players.every(p => p.hp === 5000 - 14), 'three share ' + J(m3.players.map(p => p.hp)));
  // 目標倒下了：招式不變、換一個活著的目標（11-05：以前整個重抽，可能出沒預警過的捏碎 / 天罰）
  p1.die('hit');
  for (let k = 0; k < 20; k++) {
    m.mechState.next = { action: 'stack', targetId: 'p1' };
    const r = turnAt(m, 3 + k);
    assert(!r.steps.some(x => x.targetId === 'p1' || (x.targetIds || []).includes('p1')), 'never on the dead ' + J(steps(r)));
    const moves = r.steps.filter(x => ['crush', 'smite', 'stack', 'cleanse'].includes(x.action));
    assert(moves.length === 1 && moves[0].action === 'stack' && moves[0].targetId === 'p2', 'still stack, on the living ' + J(steps(r)));
    if (r.next && r.next.action === 'stack') assert(r.next.targetId === 'p2', 'planned on the living');
  }
  // 最後之光那幾回合：抽得到、放得出來
  const L = raged(2, 41);
  let n = 0;
  for (let k = 0; k < 200; k++) { L.round = 5 + (k % 4); const p = planGaiaNext(L); if (p.action === 'stack') { n++; assert(typeof p.targetId === 'string', 'target'); } }
  assert(n > 0, 'stack planned in the light window');
  turnAt(L, 6);
  L.mechState.next = { action: 'stack', targetId: 'p1' };
  const r7 = turnAt(L, 7);
  assert(inLightWindow(L.mechState, 7) && steps(r7).includes('stack'), 'stack in the window ' + steps(r7));
  return { stackPlanned: n };
}));

await test('自然・淨化（11-04 改）：沒有目標（next 不帶 targetId）；清掉她自己的負面狀態（中毒層數、燃燒、流血、糾纏；被鎖住的上限不回來），固定回 5% 最大血量（沒有負面狀態也回、滿血不回）；玩家的負面狀態不動、沒有傷害', () => base(() => {
  const m = make(2, { seed: 9 });
  tough(m);
  const [p1] = m.players;
  const g = gaiaOf(m);
  g.hp = 100;
  Object.assign(g, { poison: 5, poisonLock: 30, burn: 4, bleed: 0, entangle: 0 });
  Object.assign(p1, { poison: 5, burn: 2 });
  const hp = p1.hp;
  m.mechState.next = { action: 'cleanse' };
  const st = turnAt(m, 2).steps.find(s => s.action === 'cleanse');
  assert(st && !('targetId' in st) && J(st.cleared) === '["poison","burn"]' && st.still, 'cleanse ' + J({ ...st, still: undefined }));
  const want = Math.floor(g.maxHp * 0.05);
  assert(st.heal === want && g.hp === 100 + want && st.hp === g.hp, `heal ${st.heal} vs ${want}`);
  assert(g.poison === 0 && g.burn === 0 && g.poisonLock === 30, 'her statuses cleared, lock kept');
  assert(p1.poison === 5 && p1.burn === 2 && p1.hp === hp, 'players untouched');
  // 什麼都沒有：清掉 0 種，照樣回 5%（不到 1 點的零頭留到下一次，同 match.heal）
  m.mechState.next = { action: 'cleanse' };
  const st2 = turnAt(m, 3).steps.find(s => s.action === 'cleanse');
  assert(J(st2.cleared) === '[]' && st.heal + st2.heal === Math.floor(g.maxHp * 0.05 * 2), 'still heals (fractions carry over) ' + J({ ...st2, still: undefined }));
  // 滿血：回 0；糾纏也清
  g.hp = g.maxHp;
  g.entangle = 2;
  m.mechState.next = { action: 'cleanse' };
  const st3 = turnAt(m, 4).steps.find(s => s.action === 'cleanse');
  assert(J(st3.cleared) === '["entangle"]' && st3.heal === 0 && g.entangle === 0, 'full hp ' + J({ ...st3, still: undefined }));
  // 抽到的淨化不帶目標
  let n = 0;
  for (let k = 0; k < 200; k++) { const p = planGaiaNext(m); if (p.action === 'cleanse') { n++; assert(J(p) === '{"action":"cleanse"}', 'no target ' + J(p)); } }
  assert(n > 0, 'cleanse planned');
  return { heal: st.heal };
}));

// ---------------- 暴走 ----------------

await test('暴走：血量停在 50% 等她的回合 → 第一招 rage（門檻拿掉、瘴氣永久、花清掉、5 輪後最後之光），照樣出招；之後回合開始 +1 層；撿花不會淨化；暈眩那一回合先暈完，下一回合才暴走', () => base(() => {
  const m = make(2, { seed: 11 });
  tough(m);
  const g = gaiaOf(m);
  turnAt(m, 1);
  const S = m.mechState;
  g.takeDamage(99999);
  assert(g.alive && g.hp === g.hpFloor && g.hp === Math.round(g.maxHp / 2), 'held at 50%: ' + g.hp);
  S.stunned = true;
  assert(J(steps(turnAt(m, 2))) === '["stunned"]' && !S.rage, 'stun first');
  const r = turnAt(m, 3);
  assert(steps(r)[0] === 'rage' && steps(r).length === 2 && ['crush', 'smite', 'stack', 'cleanse'].includes(steps(r)[1]), 'rage + move ' + steps(r));
  const rage = r.steps[0];
  assert(S.rage && S.fog && S.flowers.length === 0 && S.orbs === 0 && !S.stunned && S.lightAt === 8 && rage.lightAt === 8 && rage.vanished.length === 2 && g.hpFloor === 0, 'rage state ' + pick(m));
  g.takeDamage(10);
  assert(g.hp === Math.round(g.maxHp / 2) - 10, 'floor gone');
  const p = m.players[0];
  const fx = m.turnStartEffects(p);
  assert(J(fx.filter(f => f.type === 'gaiaFog')) === J([{ type: 'gaiaFog', id: 'p1', stacks: 1, total: 1 }]), 'rage fog 1 ' + J(fx));
  // 第 4 ~ 7 輪：沒有瘴氣重放、沒有最後之光
  for (let k = 4; k <= 7; k++) assert(!steps(turnAt(m, k)).some(a => ['fog', 'light', 'rage'].includes(a)), 'quiet ' + k);
  // 撿到花（硬塞一朵）也不會淨化、不會暈眩
  S.flowers = [{ id: 'flowerX', slope: 0, x: 140, y: Math.round(slopeY(S.def.slopes[0], 140)) }];
  const pk = walkOnto(m, p, S.flowers[0]);
  assert(pk && !pk.purify && S.fog && !S.stunned, 'no purify in rage ' + J(pk));
  assert(J(lightStatus(m)) === J({ countdown: 8 - m.round }), 'countdown ' + J(lightStatus(m)));
  return { lightAt: S.lightAt };
}));

// ---------------- 最後之光 ----------------

// 暴走過、最後之光在第 L = 6 輪的一場（玩家散在兩邊的斜坡上）
function raged(n, seed = 12) {
  const m = make(n, { seed });
  tough(m);
  const g = gaiaOf(m);
  g.takeDamage(99999);
  turnAt(m, 1);
  assert(m.mechState.rage && m.mechState.lightAt === 6, 'raged');
  for (let k = 2; k <= 5; k++) turnAt(m, k);
  const D = m.mechState.def;
  m.players.forEach((p, i) => { const s = D.slopes[i % 6]; const x = Math.round(s.x0 + (s.x1 - s.x0) * 0.5); place(m, p, x, slopeY(s, x)); });
  m.settle(60);
  return m;
}

await test('最後之光：第 L 輪（暴走 + 5）她的回合把活著的人傳送到祭壇那一層（在護盾的範圍裡）、在不同的斜坡上開花（1 / 2 / 3 / 4 人 = 2 / 4 / 4 / 6 朵）；倒下的人不算', () => base(() => {
  const out = {};
  for (const n of [1, 2, 3, 4]) {
    const m = raged(n, 20 + n);
    const S = m.mechState;
    const r = turnAt(m, 6);
    assert(steps(r)[0] === 'light' && steps(r).length === 2, 'light + move ' + steps(r));
    const st = r.steps[0];
    const want = { 1: 2, 2: 4, 3: 4, 4: 6 }[n];
    assert(S.light && S.light.at === 6 && S.light.need === want && S.light.got === 0 && !S.light.shield && S.flowers.length === want, `${n}p light ` + J(S.light));
    assert(new Set(S.flowers.map(f => f.slope)).size === want && st.need === want && J(st.flowers) === J(S.flowers.map(f => f.id)), 'distinct slopes');
    assert(J(st.targetIds) === J(m.players.map(p => p.id)) && st.spots.length === n, 'teleported ' + J(st.spots));
    assert(J(st.toX) === J(st.spots.map(s => Math.round(s.x))) && J(st.fromY) === J(st.spots.map(s => Math.round(s.y0))) && J(st.slopes) === J(S.flowers.map(f => f.slope)) && J(st.flowerX) === J(S.flowers.map(f => f.x)), 'positions as scalar arrays ' + J(st));
    for (const p of m.players) assert(inShield(S.def, p) && p.onGround && near(p.y, 510, 2), `${p.id} on the altar ${p.x},${p.y}`);
    out[n] = st.spots.map(s => s.x).join('/');
  }
  // 倒下的人不算：4 人倒一個 = 3 人 → 4 朵
  const m = raged(4, 30);
  m.players[3].die('hit');
  turnAt(m, 6);
  assert(m.mechState.light.need === 4 && m.mechState.flowers.length === 4, 'dead do not count');
  return out;
}));

// 11-05 審查抓到的：最後之光那一回合先傳送（固定站位 430 / 475 / 550 / 595）再出招，同罰以前照傳送後的站位算分擔的人，
// 玩家回合照集合圈站好的反而被打得更重。現在照傳送前（玩家回合看到的）算
await test('最後之光那一回合預定同罰：分擔的人照傳送前（玩家回合照集合圈站好）的位置算，跟玩家回合看到的 stackSharers 一樣；拳頭落在他們傳送後的頭上', () => base(() => {
  const out = {};
  for (const [tag, xs, target] of [['all4', [100, 130, 160, 190], 'p1'], ['p4+p3', [100, 130, 160, 190], 'p4'], ['apart', [100, 800, 130, 900], 'p1']]) {
    const m = raged(4, 31);
    const D = m.mechState.def;
    m.players.forEach((p, i) => { const s = D.slopes[xs[i] < 512 ? 0 : 3]; place(m, p, xs[i], slopeY(s, xs[i])); });
    m.settle(60);
    m.mechState.next = { action: 'stack', targetId: target };
    const want = stackSharers(m, m.byId(target)).map(e => e.id);
    const hp = m.players.map(p => p.hp);
    const r = turnAt(m, 6);
    assert(J(steps(r)) === '["light","stack"]', tag + ' light then stack ' + steps(r));
    const st = r.steps[1];
    assert(J(st.targetIds) === J(want) && st.targetId === target && st.dmg === Math.round(80 / want.length), `${tag}: sharers as seen before the teleport ${J(want)} vs ${J(st.targetIds)}`);
    m.players.forEach((p, i) => {
      const lost = hp[i] - p.hp;
      assert(want.includes(p.id) ? lost === Math.round(Math.round(80 / want.length) * 0.7) : lost === 0, `${tag} ${p.id} lost ${lost}`);
      assert(inShield(D, p), `${tag} ${p.id} still on the altar`);
    });
    out[tag] = want.join('/');
  }
  return out;
}));

await test('最後之光沒收齊：第 L+2 輪她的回合剩下的花枯萎（wither，left）；第 L+3 輪誅滅：沒有護盾 → 全員死亡（剩下的血全算承受傷害、不吃無敵）→ 輸；最後之光那幾回合不放捏碎', () => base(() => {
  const m = raged(2);
  const S = m.mechState;
  const [p1] = m.players;
  turnAt(m, 6);
  walkOnto(m, p1, S.flowers[0]);
  assert(S.light.got === 1 && S.flowers.length === 3, 'one picked');
  assert(J(lightStatus(m)) === J({ phase: 'collect', judgeIn: 3, got: 1, need: 4, shield: false, withered: false }), 'status ' + J(lightStatus(m)));
  m.mechState.next = { action: 'crush' };
  const r7 = turnAt(m, 7);
  assert(!steps(r7).includes('wither') && !steps(r7).includes('crush'), 'L+1: no wither, no crush ' + steps(r7));
  // 第 L+2 輪玩家的回合照樣在收花（她的回合才枯萎）：HUD 不能提早說枯萎了
  m.round = 8;
  assert(J(lightStatus(m)) === J({ phase: 'collect', judgeIn: 1, got: 1, need: 4, shield: false, withered: false }), 'L+2 players still collect ' + J(lightStatus(m)));
  m.mechState.next = { action: 'crush' };
  const r8 = turnAt(m, 8);
  assert(steps(r8)[0] === 'wither' && r8.steps[0].left === 3 && r8.steps[0].vanished.length === 3 && !steps(r8).includes('crush'), 'wither ' + steps(r8));
  assert(S.flowers.length === 0 && S.light.withered && !S.light.shield, 'withered');
  assert(lightStatus(m).phase === 'return' && lightStatus(m).judgeIn === 1, 'status after wither');
  assert(WITHER_TEXT === '因為自然的力量枯萎了', 'banner text');
  for (const p of m.players) p.shield = 3;   // 無敵也擋不住
  const hp = m.players.map(p => p.hp);
  m.mechState.next = { action: 'crush' };
  m.round = 9;
  assert(inLightWindow(S, 9) && !inLightWindow(S, 10) && inLightWindow(S, 6) && !inLightWindow(S, 5), 'window L..L+3');
  const r9 = turnAt(m, 9);
  assert(J(steps(r9)) === '["judgement"]', 'judgement only (nobody left) ' + steps(r9));
  const j = r9.steps[0];
  assert(j.shield === false && J(j.killed) === '["p1","p2"]' && J(j.saved) === '[]' && j.lightAt === 14, 'killed ' + J(j));
  assert(m.players.every((p, i) => !p.alive && p.deathCause === 'judged' && p.taken >= hp[i]), 'dead, hp counted as taken');
  assert(m.result() === 'lose' && r9.next === null, 'lose');
  // 那幾回合抽招也不抽捏碎（第 L-1 ~ L+2 輪抽的 = 第 L ~ L+3 回合用的）
  const m2 = raged(2, 40);
  const S2 = m2.mechState;
  for (let k = 0; k < 300; k++) {
    m2.round = 5 + (k % 4);
    assert(planGaiaNext(m2).action !== 'crush', 'no crush planned for turn ' + (m2.round + 1));
  }
  m2.round = 9;
  let crush = 0;
  for (let k = 0; k < 100; k++) crush += planGaiaNext(m2).action === 'crush' ? 1 : 0;
  assert(crush > 0 && S2.lightAt === 6, 'crush again after the window');
  return { judged: j.killed };
}));

await test('最後之光收齊：最後一朵撿到的那一下護盾張開（pickup shield）、不會枯萎；誅滅只殺護盾外的人、裡面的中毒層數歸零；之後再數 5 輪、照樣出招；客戶端照 pickup 套出一樣的狀態', () => base(() => {
  const m = raged(3);
  const S = m.mechState;
  const [p1, p2, p3] = m.players;
  turnAt(m, 6);
  const cm = make(3, { seed: 12 });
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  const flowers = S.flowers.slice();
  const fxs = flowers.map((f, i) => walkOnto(m, m.players[i % 3], f));
  assert(fxs.slice(0, -1).every(fx => fx.light && !fx.shield) && fxs.at(-1).shield === true && fxs.at(-1).orbs === 4 && S.light.shield, 'shield on the last ' + J(fxs.at(-1)));
  for (const fx of fxs) applyGaiaPickup(cm, JSON.parse(J(fx)));
  assert(J(cm.mechState.light) === J(S.light) && J(cm.mechState.flowers) === '[]', 'client light ' + J(cm.mechState.light));
  turnAt(m, 7);
  const r8 = turnAt(m, 8);
  assert(!steps(r8).includes('wither') && lightStatus(m).phase === 'return', 'no wither');
  // 回到祭壇：p1 站在祭壇那一層、p2 站在祭壇那一層的右邊緣（身體一半在平台外面：照樣算在護盾裡），p3 留在斜坡上
  place(m, p1, 450, 510);
  place(m, p2, 647, 510);
  place(m, p3, 100, slopeY(S.def.slopes[0], 100));
  p1.poison = 9;
  p2.poison = 0;
  m.settle(60);
  assert(p2.onGround && near(p2.y, 510, 2) && p2.x > S.def.shield.x1 && inShield(S.def, p2), 'standing on the C2 edge is inside ' + J([p2.x, p2.y]));
  const q = make(1);
  place(q, q.players[0], 378, 510);
  q.settle(60);
  assert(q.players[0].onGround && q.players[0].x < S.def.shield.x0 && inShield(S.def, q.players[0]), 'left C2 edge is inside too ' + J([q.players[0].x, q.players[0].y]));
  // 淨化的目標（p3）被誅滅了 → 重抽；誅滅那一回合（L+3）還在最後之光那幾回合裡：權重只剩捏碎也不抽捏碎
  S.next = { action: 'cleanse', targetId: 'p3' };
  const hx = p1.x;
  const r9 = withConfig({ GAIA: { weights: { crush: 100, smite: 0, cleanse: 0 } } }, () => turnAt(m, 9));
  const j = r9.steps[0];
  assert(j.action === 'judgement' && j.shield && J(j.killed) === '["p3"]' && J(j.saved) === '["p1","p2"]' && J(j.cured) === '["p1"]', 'judgement ' + J(j));
  assert(p1.alive && p2.alive && !p3.alive && p1.poison === 0, 'survivors');
  assert(steps(r9).length === 2 && steps(r9)[1] !== 'crush' && near(p1.x, hx),'no crush on the judgement turn ' + steps(r9));
  assert(S.light === null && S.lightAt === 14 && S.flowers.length === 0, 'next cycle ' + steps(r9));
  assert(J(lightStatus(m)) === J({ countdown: 5 }), 'countdown again');
  assert(m.result() === null, 'still fighting');
  return { saved: j.saved };
}));

// ---------------- 快照 ----------------

await test('快照重建：瘴氣 / 花 / 祭壇的光球 / 暈眩、暴走後的最後之光（花、收了幾朵）套到新的對戰 → 狀態一樣、門檻照狀態重算（暴走前 50%、暴走後 0）；只帶 items 的不動', () => base(() => {
  const m = make(2, { seed: 13 });
  tough(m);
  turnAt(m, 1);
  walkOnto(m, m.players[0], m.mechState.flowers[0]);
  const c1 = make(2, { seed: 99 });
  c1.applySnapshot(JSON.parse(J(m.snapshot())));
  assert(pick(c1) === pick(m) && gaiaOf(c1).hpFloor === gaiaOf(m).hpFloor && gaiaOf(c1).hpFloor > 0, 'phase 1 ' + pick(c1));
  const m2 = raged(2, 14);
  turnAt(m2, 6);
  walkOnto(m2, m2.players[0], m2.mechState.flowers[0]);
  const c2 = make(2, { seed: 98 });
  c2.applySnapshot(JSON.parse(J(m2.snapshot())));
  assert(pick(c2) === pick(m2) && gaiaOf(c2).hpFloor === 0, 'light ' + pick(c2));
  const before = pick(c2);
  c2.mechanic.restore(c2, { items: [] });
  assert(pick(c2) === before, 'items-only snapshot leaves it alone');
  return { light: m2.mechState.light };
}));

// ---------------- 裁判 ----------------

await test('裁判：開場的第一招記在 battle.start（next；天罰帶 nextSide、同罰帶 nextTarget）；走到花上記 pickup（祭壇淨化帶 purify / heals），廣播 pickup', () => base(() => {
  const out = {};
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'gaiaSanctum', players, seed, stage: 5 });
    const io = new FakeIo();
    new Referee({ match: m, humans: players, io, stageInfo: STAGE }).start();
    const bs = io.records.find(r => r.ev === 'battle.start');
    const plan = m.mechState.next;
    assert(bs.next === plan.action && (bs.nextSide ?? null) === (plan.side ?? null) && (bs.nextTarget ?? null) === (plan.targetId ?? null), 'battle.start ' + J(bs));
    out[seed] = plan.side ? `${plan.action}${plan.side}` : plan.action;
  }
  // 人在操作：走到花上
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'gaiaSanctum', players, seed: 2, stage: 5 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: STAGE });
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 100);
  assert(ref.currentId === 'p1', 'p1 first ' + ref.currentId);
  // 伺服器這邊先開兩朵花（假裝瘴氣放過了），p1 走到第一朵、p2 那朵直接給他一起撿（一段路碰到兩朵）
  const S = m.mechState;
  const D = S.def;
  const sl = D.slopes[1];
  const p1 = m.byId('p1');
  const xs = [Math.round(sl.x1 - 20), Math.round(sl.x1 - 45)];
  S.fog = true;
  S.need = 2;
  S.flowers = xs.map((x, i) => ({ id: `flowerT${i}`, slope: 1, x, y: Math.round(slopeY(sl, x)) }));
  place(m, p1, sl.x1 - 6, sl.y1);
  const yTo = standY(m, p1, xs[1] - 10, slopeY(sl, xs[1] - 10));
  ref.handle('p1', { t: 'move', x: xs[1] - 10, y: yTo, facing: -1, stamina: 150, vy: 0 });
  const rec = io.records.find(r => r.ev === 'pickup');
  assert(rec && rec.type === 'gaiaFlower' && rec.pid === 'p1' && J(rec.flowers) === '["flowerT0","flowerT1"]' && rec.purify === true && rec.heals.length === 2, 'pickup logged ' + J(rec));
  const msg = io.log.find(x => x.t === 'pickup');
  assert(msg && msg.purify && J(msg.flowers) === J(rec.flowers) && Number.isFinite(msg.hp), 'broadcast');
  assert(!S.fog && S.stunned, 'purified');
  return out;
}));

await test('裁判：全員 AI 代打打一整場（中途讓她暈一次、打到暴走）不出錯；每一招都廣播（帶 state）也都記 ai.turn（純量欄位：killed、vanished、cleared、side…）；回合開始的瘴氣記在 turn.start 的 fx；最後之光沒人收花 → 枯萎 → 誅滅全滅 → 輸', () => withConfig({ ...BASE, POISON: { pctPerStack: 0, persist: true } }, () => {
  const out = {};
  const seen = new Set();
  for (const [n, seed] of [[2, 1], [3, 2], [1, 3]]) {
    const players = mkPlayers(n);
    const m = new Match({ levelId: 'gaiaSanctum', players, seed, stage: 5 });
    for (const p of m.players) { p.hp = p.maxHp = 5000; }
    const g = gaiaOf(m);
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: STAGE });
    ref.start();
    for (const p of players) ref.setConnected(p.id, false);
    let herTurns = 0;
    for (let k = 0; k < 6000 && ref.phase !== 'over'; k++) {
      io.advance(500);
      const t = io.log.filter(x => x.t === 'aiTurn' && x.boss).length;
      if (t !== herTurns) {
        herTurns = t;
        if (t === 1) m.mechState.stunned = true;   // 第 2 回合暈眩
        if (t === 4 && !m.mechState.rage) g.takeDamage(99999);   // 停在門檻，第 5 回合暴走
      }
      if (m.mechState.rage) g.hpFloor = Math.max(g.hpFloor, 1);   // 別被 AI 打死（要看到誅滅）
    }
    assert(ref.phase === 'over', `${n}p#${seed} finished`);
    const turns = io.log.filter(x => x.t === 'aiTurn' && x.boss);
    for (const t of turns) {
      assert(t.boss.state && typeof t.boss.state.fog === 'boolean' && Array.isArray(t.boss.state.flowers), 'state rides along');
      for (const st of t.boss.steps) {
        seen.add(st.action);
        assert(st.shot || st.still, 'every step has shot or still: ' + st.action);
      }
    }
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.boss);
    assert(recs.length === turns.length && recs.every((r, i) => J(r.boss.map(x => x.action)) === J(turns[i].boss.steps.map(st => st.action))), 'logged');
    const all = recs.flatMap(r => r.boss);
    const judge = all.find(x => x.action === 'judgement');
    assert(judge && judge.shield === false && judge.killed.length === n && Array.isArray(judge.saved), 'judgement logged ' + J(judge));
    const wither = all.find(x => x.action === 'wither');
    assert(wither && wither.left > 0 && Array.isArray(wither.vanished), 'wither logged ' + J(wither));
    const fog = all.find(x => x.action === 'fog');
    assert(fog && Array.isArray(fog.flowers) && fog.flowers.every(id => typeof id === 'string') && !('blooms' in fog), 'fog logged (ids only) ' + J(fog));
    // 花開在哪（第幾道斜坡、x、y）與傳送（從哪到哪）攤成純量的陣列記著
    for (const x of [fog, all.find(a => a.action === 'light')]) {
      assert(x && [x.slopes, x.flowerX, x.flowerY].every(a => Array.isArray(a) && a.length === x.flowers.length && a.every(Number.isFinite)), 'bloom positions logged ' + J(x));
    }
    const light = all.find(x => x.action === 'light');
    assert(light && light.targetIds.length === n && !('spots' in light), 'light logged ' + J(light));
    assert([light.fromX, light.fromY, light.toX, light.toY].every(a => Array.isArray(a) && a.length === n && a.every(Number.isFinite)), 'teleport logged ' + J(light));
    assert(light.toY.every(y => Math.abs(y - 510) <= 2), 'teleported onto the altar tier ' + J(light.toY));
    for (const x of all.filter(a => a.action === 'smite')) assert(x.side === 1 || x.side === -1, 'smite side logged');
    for (const x of all.filter(a => a.action === 'cleanse')) assert(!('targetId' in x) && Array.isArray(x.cleared) && Number.isFinite(x.heal) && Number.isFinite(x.hp), 'cleanse logged ' + J(x));
    for (const x of all.filter(a => a.action === 'stack')) {
      assert(typeof x.targetId === 'string' && Array.isArray(x.targetIds) && x.targetIds.includes(x.targetId) && Number.isFinite(x.dmg) && x.total === 20 * n && !('shot' in x), 'stack logged ' + J(x));
    }
    for (const r of recs.filter(r => r.next === 'stack')) assert(typeof r.nextTarget === 'string', 'stack target logged as nextTarget ' + J(r));
    assert(recs.every(r => r.next === null || typeof r.next === 'string') && recs.some(r => typeof r.next === 'string'), 'next logged');
    const fogFx = io.records.filter(r => r.ev === 'turn.start' && Array.isArray(r.fx) && r.fx.some(f => f.type === 'gaiaFog'));
    assert(fogFx.length > 0, 'fog stacks logged at turn start');
    assert(io.log.find(x => x.t === 'gameOver').result === 'lose', 'lost to the judgement');
    out[`${n}p#${seed}`] = { round: m.round, turns: turns.length };
  }
  for (const a of ['fog', 'stunned', 'rage', 'light', 'wither', 'judgement', 'stack']) assert(seen.has(a), 'seen ' + a + ': ' + [...seen]);
  assert(['crush', 'smite', 'cleanse'].filter(a => seen.has(a)).length >= 2, 'moves seen ' + [...seen]);
  return { ...out, seen: [...seen].sort() };
}));

// ---------------- 真的 GameView（客戶端的地圖畫面 client/map-views/gaia.js）----------------
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

await test('真的 GameView：全員 AI 代打打一整場（每幀 update + render；中途讓她暈一次、打到暴走）：沒有腳本錯誤；每一種招式都播得到（捏碎 / 天罰的擊退照事件重播）；橫幅照抄「因為自然的力量枯萎了」；播完客戶端的狀態（mechState、角色位置 / 血量 / 死活）跟伺服器一樣；Boss 曲借古樹的', () => withConfig({ ...BASE, POISON: { pctPerStack: 0, persist: true } }, () => {
  const seen = new Set();
  const out = {};
  for (const [n, seed] of [[2, 1], [3, 2]]) {
    const players = mkPlayers(n);
    const m = new Match({ levelId: 'gaiaSanctum', players, seed, stage: 5 });
    for (const p of m.players) { p.hp = p.maxHp = 5000; }
    const g = gaiaOf(m);
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: STAGE });
    ref.start();
    const view = new GameView(fakeCanvas());
    const tracks = [];
    view.music = { play(t) { tracks.push(t); }, setRate() {} };
    view.myId = 'p1';
    view.transport = { send() {} };
    const banners = [];
    const showBanner = view.showBanner.bind(view);
    view.showBanner = (str, color, ...rest) => { banners.push(str); return showBanner(str, color, ...rest); };
    const all = [];
    const feed = () => { for (const msg of io.log.splice(0)) { all.push(msg); view.onMessage(msg); } };
    feed();
    assert(view.mapView.type === 'gaia', 'gaia view');
    for (const p of players) ref.setConnected(p.id, false);
    const err = console.error;
    const errors = [];
    console.error = (...a) => errors.push(a.join(' '));
    let herTurns = 0, hands = 0, hud = 0;
    try {
      for (let k = 0; k < 6000 && ref.phase !== 'over'; k++) {
        io.advance(250);
        for (const t of io.log.filter(x => x.t === 'aiTurn' && x.boss)) t.boss.steps.forEach(st => seen.add(st.action));
        const t = io.records.filter(r => r.ev === 'ai.turn' && r.boss).length;
        if (t !== herTurns) {
          herTurns = t;
          if (t === 1) m.mechState.stunned = true;
          if (t === 4 && !m.mechState.rage) g.takeDamage(99999);
        }
        if (m.mechState.rage) g.hpFloor = Math.max(g.hpFloor, 1);
        feed();
        for (let f = 0; f < 15; f++) {
          view.update(CONFIG.FIXED_DT);
          view.render();
          const c = view.mapCtx;
          if (c.state.hands.L && c.state.hands.R) hands++;
          const lines = view.mapView.hud(c, ['x', '#fff']);
          if (view.match.byId('gaia').alive && /^蓋亞 \d+ \/ \d+/.test(lines[1] ? lines[1][0] : '')) hud++;
        }
      }
      feed();
      for (let f = 0; f < 3000 && (view.script || view.queue.length); f++) view.update(CONFIG.FIXED_DT);
    } finally { console.error = err; }
    assert(!errors.length, 'script errors ' + errors[0]);
    assert(ref.phase === 'over' && all.find(x => x.t === 'gameOver').result === 'lose', `${n}p#${seed}: lost to the judgement`);
    assert(hands > 0 && hud > 0, `hands ${hands} / hud ${hud}`);
    assert(pick(view.match) === pick(m), 'mechState synced:\n' + pick(view.match) + '\n' + pick(m));
    for (const e of m.entities) {
      const v = view.match.byId(e.id);
      assert(v && v.alive === e.alive && (!e.alive || (Math.abs(v.x - e.x) < 0.01 && Math.abs(v.y - e.y) < 0.01 && v.hp === e.hp)), `${e.id} synced: ${J(v && [v.x, v.y, v.hp, v.alive])} vs ${J([e.x, e.y, e.hp, e.alive])}`);
    }
    assert(banners.includes(WITHER_TEXT) && banners.includes('最後之光！') && banners.includes('大地之母暴走！') && banners.includes('瘴氣瀰漫！'), 'banners ' + J([...new Set(banners)]));
    assert(tracks.filter(Boolean).every(t => t === 'tree') && tracks.includes('tree'), 'boss music ' + [...new Set(tracks)]);
    out[`${n}p#${seed}`] = { turns: herTurns, banners: banners.length };
  }
  for (const a of ['fog', 'stunned', 'rage', 'light', 'wither', 'judgement', 'stack']) assert(seen.has(a), 'played ' + a + ': ' + [...seen]);
  assert(['crush', 'smite', 'cleanse'].filter(a => seen.has(a)).length >= 2, 'moves ' + [...seen]);
  return { ...out, seen: [...seen].sort() };
}));

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
