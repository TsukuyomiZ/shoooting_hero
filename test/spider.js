// node test/spider.js
// 2026-10-22：Boss 關「蜘蛛巢穴」的蜘蛛女王（hp 400、一開始懸吊在右上角）：蜘蛛吐絲（全體糾纏三回合、體力消耗 +50%、金剛不壞免疫）、
// 召喚蛛卵（人數 × 1、下在岩台上；蛛卵還在 → 女王躲到背景打不到、每回合回 1%；蛛卵 3 點血、武器打到只扣 1、燃燒 +100% 最少扣 1、三回合後孵出小蜘蛛）、
// 毒液注射（隨機一人 10 層中毒、不扣血）、撲網（每回合兩張、碰到的人黏住不能動、射破才放開、網也怕火）、撲咬（在地上才用 30 + 10 層中毒）；
// 被燒到就掉到地上只會撲咬、燃燒沒了爬回天上；血量第一次到 50%：移除負面狀態 + 強制召喚蛛卵（一場一次）；女王倒下 → 蛋、網、小蜘蛛跟著消失。
// 地圖、各招、狀態對齊（伺服器 / 客戶端照同一個條件推）、客戶端照事件重播一致、快照重建、裁判流程與紀錄、真的 GameView 播一段（含本地走進網被黏住）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { makeProjectile } from '../shared/physics/weapons.js';
import { queenOf, isEgg, isWeb, isSpiderling, eggsAlive, spawnWeb } from '../shared/maps/spider.js';
import * as SPIDER from '../shared/maps/spider.js';
import * as CAVE_RULES from '../shared/maps/cave.js';
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
  PLAYER: { hp: 150, stamina: 200, moveCost: 45, jumpCost: 30 }, FEVER: { inBoss: false }, POISON: { pctPerStack: 1, persist: true },
  EQUIP: { burn: { pctPerStack: 0.1, pxPerStack: 10, maxReducePerTurn: 10 } },
  CAVE: { shadowDamagePct: 30, torchBurn: 20 },
  ENTANGLE: { turns: 3, staminaPct: 50 },
  SPIDER_QUEEN: {
    hp: 400, hw: 46, h: 52, regenPct: 1, cleansePct: 50, eggsPerPlayer: 1, websPerTurn: 2, maxWebs: 6, biteBack: 100,
    weights: { silk: 30, summon: 30, venom: 40 },
  },
  SPIDER_EGG: { hp: 3, hw: 14, h: 22, hitDamage: 1, burnTakenPct: 100, burnMin: 1, hatchTurns: 3 },
  SPIDER_WEB: { hp: 1, hw: 30, h: 44 },
  SPIDERLING: { hp: 80, hw: 16, h: 18 },
  WEAPONS: { spiderVenom: { damage: 0, poison: 10, knockback: 0, noFire: true }, spiderBite: { damage: 30, poison: 10 }, spiderlingBite: { damage: 10, poison: 5 } },
};
const base = (fn) => withConfig(BASE, fn);
const noWebs = (fn) => withConfig({ SPIDER_QUEEN: { websPerTurn: 0 } }, fn);
// 第 5 關（第一個 Boss 關：敵人傷害 ×0.7、血量只吃人數）
const make = (n = 2, opts = {}) => new Match({ levelId: 'spiderNest', players: mkPlayers(n), seed: 1, stage: 5, ...opts });
const turn = (m, e) => m.mechanic.aiTurn(m, e);
const tough = (m, hp = 5000) => { for (const p of m.players) { p.hp = p.maxHp = hp; } };
const steps = (r) => r.steps.map(s => s.action);
const inShadowOf = (m, e) => CAVE_RULES.inShadow(m, e.cx, e.cy);
const enemyHit = (m, attacker, W) => Math.round(W.damage * m.damageMult(attacker, W) * m.feverMult());
const pick = (m) => J({ ...m.mechState, def: undefined, lit: m.mechState.lit, fallen: m.mechState.fallen });
// 從 (x, y) 往下打的一發狙擊（spawn 1）：打在正下方的東西上
const dropShot = (m, owner, x, y, W = CONFIG.WEAPONS.sniper) => { const p = makeProjectile(owner, W, x, y, 0, 900); p.spawn = 1; return p; };
const volley = (m, owner, projs, burn = 0, W = projs[0].weapon) =>
  JSON.parse(J({ kind: 'weapon', actorId: owner.id, weapon: W.id, angle: -90, power: 50, facing: 1, actor: { x: owner.x, y: owner.y, vy: 0 }, ...m.resolveVolley(owner, W, projs, burn, true) }));

await test('地圖：蜘蛛巢穴在 Boss 池、洞穴地形（鐘乳石、火把：出生點微弱亮著、中間岩台熄著）；女王懸吊在右上角（固定、打得到、血量照 Boss 的倍率、門檻 50%），開場就抽好第一招；五塊岩台每層差 65px（跳得上去）、每塊岩台一個巢', () => base(() => {
  assert(levelsInPool('boss').includes('spiderNest') && LEVELS.spiderNest.mechanic.type === 'spider' && LEVELS.spiderNest.theme === 'cave', 'boss pool / cave');
  const m = make(2);
  const q = queenOf(m);
  const scale = 1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER;
  assert(q && q.boss && q.fixed && !q.intangible && q.hp === Math.round(400 * scale) && q.hpFloor === Math.round(400 * scale * 0.5), `queen hp ${q.hp} floor ${q.hpFloor}`);
  assert(q.x > 640 && q.y < 260 && m.mechState.mode === 'hang', `hanging top-right at ${q.x}, ${q.y}`);
  assert(m.mechState.next && ['silk', 'summon', 'venom'].includes(m.mechState.next.action), 'opening plan ' + J(m.mechState.next));
  const jump = CONFIG.PLAYER.jumpSpeed ** 2 / (2 * CONFIG.GRAVITY);
  const tops = [...new Set(LEVELS.spiderNest.platforms.map(p => p[0][1]))].sort((a, b) => b - a);
  assert(J(tops) === J([515, 450, 385]) && 580 - 515 < jump && 515 - 450 < jump && 450 - 385 < jump, 'tiers ' + J(tops));
  const T = m.terrain;
  for (const n of m.mechState.def.nests) assert(T.isPlatform(n.x, n.y + 2), `nest ${J(n)} sits on a ledge`);
  assert(T.stalactites.length === 3 && m.mechState.def.torches.length === 2 && m.mechState.lit[0] && !m.mechState.lit[1], 'cave bits');
  return { hp: q.hp, floor: q.hpFloor, first: m.mechState.next.action };
}));

await test('蜘蛛吐絲：全體玩家糾纏 3 個自己的回合（金剛不壞免疫，記 immune）；糾纏中走路 / 跳 / 掛藤蔓的體力消耗 ×1.5；再吐一次只補回 3、不疊加；自己的回合結束少 1，用完記 untangle', () => base(() => noWebs(() => {
  const m = make(3);
  tough(m);
  const [p1, p2, p3] = m.players;
  p3.mods.statusImmune = 1;
  const q = queenOf(m);
  m.mechState.next = { action: 'silk' };
  const r = turn(m, q);
  const st = r.steps.find(s => s.action === 'silk');
  assert(J(steps(r)) === J(['silk']) && J(st.targetIds) === J(['p1', 'p2']) && J(st.immune) === J(['p3']), 'silk ' + J(st));
  assert(p1.entangle === 3 && p2.entangle === 3 && p3.entangle === 0 && st.still.results.find(s => s.id === 'p1').eg === 3, 'entangled');
  // 體力：同一段路、同一次跳，糾纏的人多扣一半
  const walk = (e) => { e.stamina = e.maxStamina = 200; e.moveDir = 1; for (let f = 0; f < 30; f++) e.update(CONFIG.FIXED_DT, m.world); e.moveDir = 0; return 200 - e.stamina; };
  const a = walk(p1), b = walk(p3);
  assert(near(a, b * 1.5, 1e-6) && b > 0, `walk cost ${a} vs ${b}`);
  m.settle(200);
  p1.stamina = p3.stamina = 200;
  assert(p1.jump(m.terrain) && p3.jump(m.terrain) && near(200 - p1.stamina, 45) && near(200 - p3.stamina, 30), `jump cost ${200 - p1.stamina} / ${200 - p3.stamina}`);
  p1.stamina = 40;
  m.settle(200);
  assert(!p1.jump(m.terrain), 'cannot afford an entangled jump with 40 stamina');
  // 回合數：結束時少 1；再吐一次補回 3
  m.endTurn(p1);
  assert(p1.entangle === 2, 'one turn spent');
  m.mechState.next = { action: 'silk' };
  turn(m, q);
  assert(p1.entangle === 3, 'refreshed, not stacked: ' + p1.entangle);
  let fx = [];
  for (let k = 0; k < 3; k++) fx = m.endTurn(p1);
  assert(p1.entangle === 0 && fx.some(f => f.type === 'untangle' && f.id === 'p1') && near(p1.staminaMult, 1), 'untangled ' + J(fx));
  return { walk: [Math.round(a), Math.round(b)] };
})));

await test('召喚蛛卵：活著的玩家人數 × 1 顆、下在不同的巢；女王退到背景（打不到：直擊、波及都碰不到），每回合回 1% 血、照樣出招；蛛卵 3 點血，不管什麼武器、直擊還是波及都只扣 1（不會被擊退），著火的子彈照樣讓它燒起來；最後一顆蛋被打破的那一下她就回來（事件帶 queen，同一波後面的砲彈打得到她）', () => base(() => noWebs(() => {
  const m = make(3);
  tough(m);
  m.byId('p3').die('hit');
  const q = queenOf(m);
  m.mechState.next = { action: 'summon' };
  const r = turn(m, q);
  const st = r.steps.find(s => s.action === 'summon');
  const eggs = m.entities.filter(e => isEgg(e) && e.alive);
  assert(st && st.spawns.length === 2 && eggs.length === 2 && new Set(st.spawns.map(s => s.nest)).size === 2, 'two eggs on two nests ' + J(st && st.spawns));
  assert(eggs.every(e => e.hp === 3 && e.maxHp === 3 && e.fixed && e.noTurn && e.optional && e.noKill), 'egg flags');
  assert(m.mechState.mode === 'hide' && q.intangible && st.queen && st.queen.to === 'hide', 'hiding');
  assert(r.next && r.next.action !== 'summon', 'no summon planned while eggs are out: ' + J(r.next));
  const p1 = m.byId('p1');
  const hp0 = q.hp;
  m.applyExplosion(q.cx, q.cy, CONFIG.WEAPONS.cannon, p1, q);
  assert(q.hp === hp0, 'cannot be hit in the background');
  q.hp -= 100;
  const r2 = turn(m, q);
  const reg = r2.steps.find(s => s.action === 'regen');
  assert(reg && reg.heal === Math.round(q.maxHp * 0.01) && q.hp === hp0 - 100 + reg.heal && r2.steps.length === 2, 'regen + one move ' + J(steps(r2)));
  // 武器打蛋：不管多重、直擊還是波及都只扣 1；這一下帶的燃燒照樣上；算打的人造成的傷害
  const [e1, e2] = eggs;
  const W = CONFIG.WEAPONS.sniper;
  const dealt0 = p1.dealt;
  const d1 = m.applyExplosion(e1.cx, e1.cy, CONFIG.WEAPONS.bombard, p1, e1).find(x => x.id === e1.id);
  const x0 = e1.x;
  const d2 = m.applyExplosion(e1.x + e1.hw + 20, e1.cy, CONFIG.WEAPONS.cannon, p1, null, { burn: 20 }).find(x => x.id === e1.id);
  assert(d1.dmg === 1 && d2 && d2.dmg === 1 && e1.hp === 1 && e1.burn === 20 && d2.burn === 20 && e1.burnSource === 'p1' && near(e1.x, x0), `1 per hit (direct ${d1.dmg}, splash ${d2 && d2.dmg}), burning ${e1.burn}`);
  assert(p1.dealt - dealt0 === 2, 'credited to the shooter');
  e1.burn = 0;
  // 打破兩顆蛋：第二顆破的那一下她回來，後面那一發打得到她
  e1.hp = 1; e2.hp = 1;
  const shots = [dropShot(m, p1, e1.x, e1.y - 40), dropShot(m, p1, e2.x, e2.y - 40)];
  const late = makeProjectile(p1, W, q.x - 120, q.cy, 1500, 0);
  late.spawn = 25;
  const qhp = q.hp;
  const shot = volley(m, p1, [...shots, late], 0, W);
  const ev = shot.events.find(x => x.queen);
  assert(!eggsAlive(m) && ev && ev.queen.from === 'hide' && ev.queen.to === 'hang' && !q.intangible, 'back out ' + J(ev && ev.queen));
  assert(q.hp < qhp && shot.events.some(x => x.f > ev.f && (x.damages || []).some(dd => dd.id === q.id && dd.dmg > 0)), 'the later shot hits her');
  return { eggs: st.spawns.map(s => s.nest), regen: reg.heal };
})));

await test('蛛卵孵化 / 燃燒：三個女王的回合之後孵出小蜘蛛（hp 80 × 王的倍率、這一輪不動、只會撲咬 10 + 5 層中毒）；蛋身上的燃燒在每個女王的回合開始照一般的算法 +100%、最少扣 1（層數不掉）→ 被火打中一次（1）的蛋再燒兩回合，孵化前燒掉', () => base(() => noWebs(() => {
  const m = make(2);
  tough(m);
  const q = queenOf(m);
  m.mechState.next = { action: 'summon' };
  turn(m, q);
  const [burnt, live] = m.entities.filter(e => isEgg(e));
  const p1 = m.byId('p1');
  // 被著火的子彈打中一次：扣 1、燒起來
  m.applyExplosion(burnt.cx, burnt.cy, CONFIG.WEAPONS.sniper, p1, burnt, { burn: 20 });
  assert(burnt.hp === 2 && burnt.burn === 20, 'hit once by a burning shot');
  const dealt0 = p1.dealt;
  const t1 = turn(m, q);
  const b1 = t1.steps.find(s => s.action === 'burn');
  const raw = 20 * CONFIG.EQUIP.burn.pctPerStack / 100 * 3 * 2;   // 一般的算法：0.12 點 → 最少扣 1
  assert(raw < 1 && b1 && J(b1.burns) === J([{ id: burnt.id, dmg: 1 }]) && burnt.hp === 1 && burnt.burn === 20 && p1.dealt - dealt0 === 1, 'first burn ' + J(b1));
  turn(m, q);
  assert(!burnt.alive && live.alive && m.mechState.eggs.find(g => g.id === live.id).left === 1, 'burnt egg gone after two queen turns, before hatching');
  // 燃燒很多層：照一般的算法 +100%（3 點血的蛋 600 層 = 3.6 → 4，扣到 0）
  const big = withConfig({ SPIDER_EGG: { hp: 3 } }, () => {
    const mm = make(1);
    mm.mechState.next = { action: 'summon' };
    turn(mm, queenOf(mm));
    const egg = mm.entities.find(e => isEgg(e));
    egg.burn = 600;
    const tb = turn(mm, queenOf(mm)).steps.find(s => s.action === 'burn');
    return tb && tb.burns[0].dmg;
  });
  assert(big === 3, 'a huge burn takes the rest: ' + big);
  const t3 = turn(m, q);
  const h = t3.steps.find(s => s.action === 'hatch');
  const sl = m.entities.find(e => isSpiderling(e));
  const scale = 1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER;
  assert(h && h.spawns.length === 1 && !live.alive && live.deathCause === 'hatch' && sl && sl.alive && sl.hp === Math.round(80 * scale) && sl.dormant, 'hatched ' + J(h && h.spawns));
  assert(m.mechState.mode === 'hang' && !q.intangible && h.queen && h.queen.from === 'hide', 'queen back once the eggs are gone');
  // 輪到小蜘蛛：撲向最近的人
  sl.dormant = false;
  const victim = m.players.reduce((a, b) => (Math.hypot(b.cx - sl.cx, b.cy - sl.cy) < Math.hypot(a.cx - sl.cx, a.cy - sl.cy) ? b : a));
  const hp0 = victim.hp, ps0 = victim.poison;
  const W = CONFIG.WEAPONS.spiderlingBite;
  const want = enemyHit(m, sl, W);
  const rs = turn(m, sl);
  assert(J(steps(rs)) === J(['bite']) && rs.steps[0].targetId === victim.id && hp0 - victim.hp === want && victim.poison - ps0 === 5, `bite ${hp0 - victim.hp} (want ${want})`);
  assert(Math.hypot(sl.x - victim.x, sl.y - victim.y) < 80, 'landed next to the victim');
  return { burnTick: 1, spiderlingHp: sl.maxHp };
})));

await test('毒液注射：預定的那個人（其他人擋不到）只上 10 層中毒、不扣血、不被擊退（陰影加成也乘不出傷害）；金剛不壞連中毒都不上（immune）', () => base(() => noWebs(() => {
  const m = make(2);
  tough(m);
  const q = queenOf(m);
  const p2 = m.byId('p2');
  m.settle(120);
  const x0 = p2.x, y0 = p2.y;
  m.mechState.next = { action: 'venom', targetId: 'p2' };
  assert(inShadowOf(m, q), 'the queen is in the dark (the shadow bonus would apply)');
  const r = turn(m, q);
  const d1 = r.steps[0].shot.events.flatMap(e => e.damages || []).find(x => x.id === 'p2');
  assert(J(steps(r)) === J(['venom']) && r.steps[0].targetId === 'p2' && d1 && d1.dmg === 0 && d1.poison === 10, 'venom entry ' + J(d1));
  assert(p2.hp === p2.maxHp && p2.poison === 10 && near(p2.x, x0, 0.5) && near(p2.y, y0, 0.5), `no damage, no knockback: hp ${p2.hp}/${p2.maxHp} at ${p2.x},${p2.y}`);
  // 中毒照常在他自己的回合開始結算
  const fx = m.turnStartEffects(p2);
  assert(fx.some(f => f.type === 'poison' && f.stacks === 10) && p2.hp < p2.maxHp + p2.poisonLock, 'poison ticks on his turn ' + J(fx));
  p2.mods.statusImmune = 1;
  m.mechState.next = { action: 'venom', targetId: 'p2' };
  const r2 = turn(m, q);
  const d = r2.steps[0].shot.events.flatMap(e => e.damages || []).find(x => x.id === 'p2');
  assert(p2.poison === 10 && d.immune && d.dmg === 0, 'immune: no more poison');
  // 穿過亮著的火柱也不會著火（2026-10-22 使用者）：P1 站到火柱正左邊，毒液從女王那裡射過來一定穿過火焰
  p2.mods.statusImmune = 0;
  const pil = m.mechState.def.torches.findIndex(t => t.pillar);
  m.mechState.lit[pil] = Math.max(1, m.round);
  const T = m.mechState.def.torches[pil];
  const p1 = m.byId('p1');
  p1.x = T.x - 60; p1.y = T.y; p1.burn = 0;
  const fy = p1.cy;
  assert(fy >= CAVE_RULES.torchTop(T) && fy <= T.y, 'the line crosses the pillar fire span');
  const fm = makeProjectile(q, CONFIG.WEAPONS.spiderVenom, T.x + 80, fy, -900, 0);   // 水平穿過火柱，打在 P1 身上
  fm.spawn = 1;
  for (const e of m.entities) if (e !== p1) fm.ignore.add(e);
  fm.stopAt = p1;
  const shot = m.resolveVolley(q, CONFIG.WEAPONS.spiderVenom, [fm], 0);
  const crossed = CAVE_RULES.caveFireSources(m, q).some(s => s.x0 === T.x);
  assert(crossed && !shot.events.some(e => e.ignite > 0) && p1.burn === 0 && p1.poison > 0, 'venom through the lit pillar: poisoned, not burning ' + J(shot.events.map(e => [e.type, e.ignite || 0])));
  return { poison: 10 };
})));

await test('撲網：每回合放兩張（場上最多 6 張）、放在地面 / 岩台的頂面；放在人身上就黏住他（網移到他身上）；黏住的人走不動、跳不起來、不被擊退；走進網裡（位置回報）就黏住、從上面跳過去不會；他開火一出砲口就打在網上、一下就破、自己的爆炸傷不到自己；隊友打一下（直擊、爆炸波及都算）也破，黏住的人放開', () => base(() => {
  const m = make(2);
  tough(m);
  const q = queenOf(m);
  m.mechState.next = { action: 'venom', targetId: 'p1' };
  const r = turn(m, q);
  const webSteps = r.steps.filter(s => s.action === 'web');
  assert(webSteps.length === 2 && m.entities.filter(e => isWeb(e) && e.alive).length === 2, 'two webs ' + J(steps(r)));
  for (let k = 0; k < 4; k++) turn(m, q);
  const webs = m.entities.filter(e => isWeb(e) && e.alive);
  assert(webs.length === 6, 'capped at 6: ' + webs.length);
  const tops = new Set([580, 515, 450, 385]);
  assert(webs.every(w => [...tops].some(y => Math.abs(w.y - y) <= 3) && w.hp === 1 && w.fixed && w.noTurn && w.optional && w.allyPass), 'webs sit on surfaces ' + J(webs.map(w => [w.x, w.y])));
  // 清掉，重新放一張在 P1 腳下（rng 抽的地方不一定碰得到人：直接改網的位置測黏住的規則）
  for (const w of webs) w.die('wither');
  m.mechanic.cascade(m);
  const p1 = m.byId('p1'), p2 = m.byId('p2');
  m.mechState.next = { action: 'venom', targetId: 'p2' };
  // 放一張剛好在 P1 腳下：rng 換到抽中 P1 那一段（試幾個種子）
  let caught = null;
  for (let seed = 1; seed < 400 && !caught; seed++) {
    const mm = new Match({ levelId: 'spiderNest', players: mkPlayers(2), seed, stage: 5 });
    tough(mm);
    mm.mechState.next = { action: 'venom', targetId: 'p2' };
    const rr = turn(mm, queenOf(mm));
    const ws = rr.steps.find(s => s.action === 'web' && s.caught.length);
    if (ws) caught = { mm, ws };
  }
  assert(caught, 'some seed drops a web on a player');
  const { mm, ws } = caught;
  const pid = ws.caught[0];
  const pp = mm.byId(pid), web = mm.byId(ws.spawns[0].id);
  assert(pp.held && mm.mechState.stuck[pid] === web.id && near(web.x, pp.x) && web.heldId === pid && ws.x === web.x, 'stuck, wrapped ' + J({ held: pp.held, web: [web.x, web.y], p: [pp.x, pp.y] }));
  const x0 = pp.x;
  pp.stamina = 200; pp.moveDir = 1; pp.wantJump = true;
  for (let f = 0; f < 30; f++) pp.update(CONFIG.FIXED_DT, mm.world);
  pp.moveDir = 0;
  assert(near(pp.x, x0) && pp.stamina === 200 && pp.onGround, 'cannot walk or jump');
  mm.applyExplosion(pp.x + 20, pp.cy, CONFIG.WEAPONS.cannon, queenOf(mm), null);   // 敵人的爆炸（穿過網，網不會破）
  mm.settle(120);
  assert(near(pp.x, x0) && web.alive && pp.held, 'no knockback while stuck; enemy blasts leave the web alone');
  // 他自己開火（往右上）：一出砲口就打在網上、一下就破、傷不到自己
  const hp0 = pp.hp;
  const mz = pp.muzzle();
  const own = makeProjectile(pp, CONFIG.WEAPONS.cannon, mz.x, mz.y, 400, -400);
  own.spawn = 1;
  const s1 = volley(mm, pp, [own]);
  assert(s1.events[0].target === web.id && !web.alive && pp.hp === hp0, `own shot breaks the web first, not hurting himself (${hp0} -> ${pp.hp})`);
  assert(!pp.held && !mm.mechState.stuck[pid] && s1.events[0].damages.find(d => d.id === web.id).dmg === 1, 'web broken, free');
  // 走進網裡：位置回報（伺服器）黏住；從上面跳過去不會
  const spec = { id: 'webT', x: p2.x + 60, y: p2.y, hp: 60 };
  spawnWeb(m, spec);
  const wT = m.byId('webT');
  const over = m.applyPositionReport(p2, { x: p2.x + 60, y: p2.y - 50, facing: 1, stamina: 150 });
  assert(over.ok && !over.pickup && !p2.held, 'jumping over does not stick');
  m.applyPositionReport(p2, { x: p2.x - 60, y: 578, facing: 1, stamina: 150 });
  m.settle(60);
  const walkIn = m.applyPositionReport(p2, { x: wT.x - 20, y: p2.y, facing: 1, stamina: 140 });
  assert(walkIn.ok && walkIn.pickup && walkIn.pickup.type === 'web' && walkIn.pickup.web === 'webT' && p2.held && near(wT.x, p2.x), 'walked in: ' + J(walkIn.pickup));
  // 隊友的飛鏢（傷害最小的武器）直接打中也一下就破
  const p1w = m.byId('p1');
  const dart = makeProjectile(p1w, CONFIG.WEAPONS.darts, wT.x, wT.y - wT.h - 30, 0, 900);
  dart.spawn = 1;
  volley(m, p1w, [dart]);
  assert(!wT.alive && !p2.held && !m.mechState.stuck.p2, 'a dart breaks it, p2 free');
  // 爆炸只是波及到（沒有直擊）也破
  spawnWeb(m, { id: 'webS', x: 600, y: 580, hp: 1 });
  const wS = m.byId('webS');
  const dd = m.applyExplosion(wS.x + wS.hw + 30, 560, CONFIG.WEAPONS.cannon, p1w, null).find(x => x.id === 'webS');
  assert(dd && dd.dmg === 1 && !wS.alive, 'splash breaks it too');
  return { caughtSeed: mm.seed };
}));

await test('被燒到就掉下來：著火的子彈打中懸吊的女王 → 那一下就掉到正下方的地上（事件帶 queen：hang → ground）；在地上只會撲咬（撲向最近的人 30 × 倍率 + 10 層中毒、咬完往後跳開落在地上、不放網），撲過去、跳回來的距離甩掉燃燒層數（貼著人也一樣）；燃燒沒了 → 回合結束爬回天上（turnEnd 的 fx）', () => base(() => {
  const m = make(2);
  tough(m);
  const q = queenOf(m);
  const p1 = m.byId('p1');
  const W = CONFIG.WEAPONS.sniper;
  const fire = makeProjectile(p1, W, q.x - 140, q.cy, 1500, 0);
  fire.spawn = 1;
  const x0 = q.x;
  const shot = volley(m, p1, [fire], 20, W);
  const ev = shot.events.find(e => e.queen);
  assert(q.burn === 20 && ev && ev.queen.from === 'hang' && ev.queen.to === 'ground' && m.mechState.mode === 'ground', 'dropped ' + J(ev && ev.queen));
  assert(Math.abs(q.x - x0) <= 60 && Math.abs(q.y - 580) <= 3, `fell straight down to ${q.x}, ${q.y}`);
  const rs = shot.results.find(s => s.id === q.id);
  assert(near(rs.x, q.x) && near(rs.y, q.y), 'results carry where she landed');
  // 她的回合：只撲咬
  m.beginTurn(q);
  const victim = m.players.reduce((a, b) => (Math.hypot(b.cx - q.cx, b.cy - q.cy) < Math.hypot(a.cx - q.cx, a.cy - q.cy) ? b : a));
  const hp0 = victim.hp, ps0 = victim.poison;
  const BW = CONFIG.WEAPONS.spiderBite;
  const want = enemyHit(m, q, BW);
  const r = turn(m, q);
  assert(J(steps(r)) === J(['bite']) && r.steps[0].targetId === victim.id && hp0 - victim.hp === want && victim.poison - ps0 === 10, `bite ${hp0 - victim.hp} (want ${want}) ${J(steps(r))}`);
  assert(Math.abs(q.y - 580) <= 3 && q.movedThisTurn > 50, `on the ground at ${q.x}, ${q.y}, moved ${q.movedThisTurn}`);
  // 回合結束：甩掉燃燒（照移動距離，見 EQUIP.burn）、扣完血減半，還有就留在地上；燒完了爬回天上
  let fx = m.endTurn(q);
  const B = CONFIG.EQUIP.burn;
  const left = 20 - Math.min(20, B.maxReducePerTurn, Math.floor(q.movedThisTurn / B.pxPerStack));
  const want1 = Math.floor(left * (100 - B.fadePct) / 100);
  assert(want1 > 0 && q.burn === want1 && !fx.some(f => f.type === 'queen') && m.mechState.mode === 'ground', `still burning: ${q.burn} (want ${want1})`);
  let up = null, turns = 1;
  for (; turns < 12 && !up; turns++) {   // 撲過去的距離短的回合甩得少：直到燒完的那一回合才爬回去
    m.beginTurn(q);
    const rr = turn(m, q);
    assert(J(steps(rr)) === J(['bite']), 'still only biting on the ground');
    fx = m.endTurn(q);
    up = fx.find(f => f.type === 'queen');
    assert(!!up === (q.burn === 0), `climbs exactly when the burn is gone (burn ${q.burn})`);
  }
  assert(q.burn === 0 && up && up.from === 'ground' && up.to === 'hang' && m.mechState.mode === 'hang' && near(q.x, m.mechState.def.hang.x) && near(q.y, m.mechState.def.hang.y), 'climbed back ' + J(up));
  return { landed: [Math.round(rs.x), Math.round(rs.y)], bite: want, groundTurns: turns };
}));

await test('血量 50%：多打的不算（停在門檻）；輪到她：蛻皮（移除燃燒、中毒、流血、生命鎖；在地上就爬回去）+ 強制召喚蛛卵，一場只有一次', () => base(() => noWebs(() => {
  const m = make(2);
  tough(m);
  const q = queenOf(m);
  const floor = q.hpFloor;
  q.takeDamage(99999);
  assert(q.hp === floor && q.alive, `held at ${q.hp}`);
  q.burn = 15; q.poison = 4; q.bleed = 3; q.poisonLock = 10; q.maxHp -= 10;
  m.mechanic.cascade(m);   // 身上有燃燒：在地上
  assert(m.mechState.mode === 'ground', 'grounded by the burn');
  const max0 = q.maxHp;
  const r = turn(m, q);
  const cl = r.steps.find(s => s.action === 'cleanse');
  assert(J(steps(r)) === J(['cleanse', 'summon']) && r.steps[1].forced, 'cleanse + forced summon ' + J(steps(r)));
  assert(q.burn === 0 && q.poison === 0 && q.bleed === 0 && q.poisonLock === 0 && q.maxHp === max0 + 10 && cl.burn === 15, 'cleansed ' + J(cl));
  assert(cl.queen && cl.queen.from === 'ground' && cl.queen.to === 'hang', 'climbed back during the cleanse');
  assert(m.mechState.cleansed && q.hpFloor === 0 && m.mechState.mode === 'hide', 'once; hiding with the eggs');
  for (const e of m.entities) if (isEgg(e)) e.die('hit');
  m.mechanic.cascade(m);
  q.takeDamage(10);
  const r2 = turn(m, q);
  assert(!r2.steps.some(s => s.action === 'cleanse'), 'never again');
  return { floor };
})));

await test('女王倒下：蛛卵、小蜘蛛、網全部消失（被黏住的人放開）、這一關贏了', () => base(() => {
  const m = make(2);
  tough(m);
  const q = queenOf(m);
  m.mechState.next = { action: 'summon' };
  turn(m, q);
  for (let k = 0; k < 3; k++) turn(m, q);   // 孵出小蜘蛛、放一堆網
  const p1 = m.byId('p1');
  const web = m.entities.find(e => isWeb(e) && e.alive);
  m.mechState.stuck.p1 = web.id;
  m.mechanic.cascade(m);
  assert(p1.held, 'stuck');
  q.hpFloor = 0;
  q.takeDamage(99999);
  m.mechanic.cascade(m);
  const left = m.entities.filter(e => e.alive && (isEgg(e) || isWeb(e) || isSpiderling(e)));
  assert(!left.length && !p1.held && m.result() === 'win', 'withered: ' + left.map(e => e.id));
  return { gone: m.entities.filter(e => isEgg(e) || isWeb(e) || isSpiderling(e)).length };
}));

await test('客戶端照事件重播：著火的子彈打下女王（同一波後面的砲彈照落地的位置打）、打破最後一顆蛋（女王回來）——客戶端照同一個條件推出一樣的狀態、位置、碰不碰得到', () => base(() => {
  const m = make(2);
  tough(m);
  const q = queenOf(m);
  const p1 = m.byId('p1');
  const W = CONFIG.WEAPONS.sniper;
  // 1. 打下來
  let cm = make(2);
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  const fire = makeProjectile(p1, W, q.x - 140, q.cy, 1500, 0);
  fire.spawn = 1;
  const after = makeProjectile(p1, W, q.x, 400, 0, 900);   // 正對她落地的地方往下打
  after.spawn = 12;
  const shot = volley(m, p1, [fire, after], 20, W);
  assert(m.mechState.mode === 'ground' && shot.events.some(e => e.f >= 12 && (e.damages || []).some(d => d.id === q.id)), 'the later shot hit her on the ground');
  replayChecked(cm, shot, 'drop');
  assert(cm.mechState.mode === 'ground' && near(queenOf(cm).x, q.x) && near(queenOf(cm).y, q.y) && queenOf(cm).hp === q.hp, 'client dropped too');
  cm.applyEntities(shot.results);
  assert(pick(cm) === pick(m), 'mechState ' + pick(cm) + ' vs ' + pick(m));
  // 2. 蛋 → 退到背景 → 打破最後一顆（這一回合不放網：網剛好蓋在蛋上的話會先吃掉往下打的子彈）
  const m2 = make(2);
  m2.mechState.next = { action: 'summon' };
  noWebs(() => turn(m2, queenOf(m2)));
  tough(m2);
  const eggs = m2.entities.filter(e => isEgg(e));
  for (const e of eggs) e.hp = 1;
  cm = make(2);
  cm.applySnapshot(JSON.parse(J(m2.snapshot())));
  assert(cm.mechState.mode === 'hide' && queenOf(cm).intangible && cm.entities.filter(e => isEgg(e)).length === 2, 'client restored the eggs / hiding');
  const p = m2.byId('p1');
  const shot2 = volley(m2, p, eggs.map(e => dropShot(m2, p, e.x, e.y - 40)), 0, W);
  assert(m2.mechState.mode === 'hang' && shot2.events.some(e => e.queen), 'server: back out');
  replayChecked(cm, shot2, 'eggs');
  assert(cm.mechState.mode === 'hang' && !queenOf(cm).intangible, 'client: back out');
  cm.applyEntities(shot2.results);
  assert(pick(cm) === pick(m2), 'mechState ' + pick(cm) + ' vs ' + pick(m2));
  return { events: shot.events.length + shot2.events.length };
}));

await test('快照重建：下了蛋、放了網（黏住人）、孵出小蜘蛛之後，新的對戰套快照 → 同樣的角色（id、位置、血量）、被黏住的人、女王的狀態、蛋的倒數', () => base(() => {
  let found = null;
  for (let seed = 1; seed < 300 && !found; seed++) {
    const m = new Match({ levelId: 'spiderNest', players: mkPlayers(2), seed, stage: 5 });
    tough(m);
    const q = queenOf(m);
    m.mechState.next = { action: 'summon' };
    turn(m, q);
    turn(m, q);
    if (Object.keys(m.mechState.stuck).length) found = m;
  }
  assert(found, 'a seed with someone stuck');
  const m = found;
  const cm = make(2);
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  assert(J(cm.entities.map(e => e.id)) === J(m.entities.map(e => e.id)), 'same entities');
  for (const e of m.entities) {
    const c = cm.byId(e.id);
    assert(c.alive === e.alive && near(c.x, e.x) && near(c.y, e.y) && c.hp === e.hp && c.held === e.held && c.intangible === e.intangible && c.kind === e.kind, `${e.id} restored`);
  }
  assert(pick(cm) === pick(m), 'mechState ' + pick(cm) + ' vs ' + pick(m));
  return { seed: m.seed, stuck: m.mechState.stuck };
}));

await test('裁判：全員 AI 代打打一整場（1 / 2 / 4 人、幾個種子）不出錯；女王 / 小蜘蛛的回合廣播帶每一招與狀態（state），紀錄 ai.turn 帶每一招（下的蛋 / 放的網記 spawns 的 id）、next；女王的招都出現過', () => base(() => {
  const out = {};
  const seen = new Set();
  for (const [n, seed] of [[1, 1], [2, 2], [4, 3], [2, 5]]) {
    const players = mkPlayers(n);
    const m = new Match({ levelId: 'spiderNest', players, seed, stage: 5 });
    for (const p of m.players) { p.hp = p.maxHp = 3000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 5, stageCount: 10, isBoss: true, type: 'boss', levelId: 'spiderNest', levelName: '蜘蛛巢穴', cards: {} } });
    ref.start();
    for (const p of players) ref.setConnected(p.id, false);
    for (let k = 0; k < 3000 && ref.phase !== 'over'; k++) io.advance(500);
    const turns = io.log.filter(x => x.t === 'aiTurn' && x.boss);
    for (const t of turns) {
      assert(t.boss.state && typeof t.boss.state.mode === 'string', 'state rides along');
      t.boss.steps.forEach(st => seen.add(st.action));
    }
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.boss);
    assert(recs.length === turns.length && recs.every((r, i) => J(r.boss.map(x => x.action)) === J(turns[i].boss.steps.map(st => st.action))), 'logged');
    const spawned = recs.flatMap(r => r.boss).filter(x => x.action === 'summon' || x.action === 'web' || x.action === 'hatch');
    assert(spawned.every(x => Array.isArray(x.spawns) && x.spawns.every(id => typeof id === 'string')), 'spawns logged as ids');
    out[`${n}p#${seed}`] = { result: ref.phase === 'over' ? io.log.find(x => x.t === 'gameOver').result : 'running', round: m.round, turns: turns.length };
  }
  assert(['silk', 'summon', 'venom', 'web', 'hatch'].every(a => seen.has(a)), 'moves seen: ' + [...seen]);
  return { ...out, seen: [...seen].sort() };
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
const STAGE = { stage: 5, stageCount: 10, isBoss: true, type: 'boss', levelId: 'spiderNest', levelName: '蜘蛛巢穴', cards: {} };
const newView = (id = 'p1') => { const v = new GameView(fakeCanvas()); v.music = { play() {}, setRate() {} }; v.myId = id; v.transport = { send() {} }; return v; };

await test('真的 GameView：全員 AI 代打打一段（每幀 update + render）：沒有腳本錯誤；吐絲、下蛋、撲網、孵化都播得到；播完客戶端的狀態（mechState、角色位置 / 血量、碰不碰得到、被黏住）跟伺服器一樣', () => base(() => {
  const seen = new Set();
  const out = {};
  for (const seed of [2, 6]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'spiderNest', players, seed, stage: 5 });
    for (const p of m.players) { p.hp = p.maxHp = 3000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: STAGE });
    ref.start();
    const view = newView();
    const tracks = [];
    view.music = { play(t) { tracks.push(t); }, setRate() {} };
    const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
    feed();
    assert(view.mapView.type === 'spider', 'spider view');
    for (const p of players) ref.setConnected(p.id, false);
    const err = console.error;
    const errors = [];
    console.error = (...a) => errors.push(a.join(' '));
    let hud = false;
    try {
      for (let k = 0; k < 1600 && ref.phase !== 'over'; k++) {
        io.advance(250);
        for (const t of io.log.filter(x => x.t === 'aiTurn' && x.boss)) t.boss.steps.forEach(st => seen.add(st.action));
        feed();
        for (let f = 0; f < 15; f++) {
          view.update(CONFIG.FIXED_DT);
          view.render();
          const lines = view.mapView.hud(view.mapCtx, ['x', '#fff']);
          if (/^蜘蛛女王 \d+ \/ \d+$/.test((lines[1] || [''])[0])) hud = true;
        }
        if (m.round >= 14) break;
      }
      feed();
      for (let f = 0; f < 2400 && (view.script || view.queue.length); f++) { view.update(CONFIG.FIXED_DT); view.render(); }
      for (let f = 0; f < 120; f++) view.update(CONFIG.FIXED_DT);
    } finally { console.error = err; }
    assert(!errors.length, 'script errors ' + errors[0]);
    assert(hud, 'hud shows the queen');
    if (ref.phase !== 'over') {
      assert(pick(view.match) === pick(m), 'mechState synced:\n' + pick(view.match) + '\n' + pick(m));
      for (const e of m.entities) {
        const v = view.match.byId(e.id);
        assert(v && v.alive === e.alive && (!e.alive || (Math.abs(v.x - e.x) < 0.01 && Math.abs(v.y - e.y) < 0.01 && v.hp === e.hp)), `${e.id} synced: ${J(v && [v.x, v.y, v.hp, v.alive])} vs ${J([e.x, e.y, e.hp, e.alive])}`);
        assert(!v || (v.intangible === e.intangible && v.held === e.held && v.entangle === e.entangle), `${e.id} flags`);
      }
    }
    assert(tracks.filter(Boolean).every(t => t === 'scorpion'), 'boss music ' + [...new Set(tracks)]);
    out[seed] = { round: m.round, phase: ref.phase };
  }
  assert(['silk', 'summon', 'web', 'venom'].every(a => seen.has(a)), 'played: ' + [...seen]);
  return { ...out, seen: [...seen].sort() };
}));

await test('真的 GameView（單人）：P1 往右走進蜘蛛網 → 本地馬上黏住（停在網裡、馬上回報位置），伺服器也黏住、廣播 pickup；之後按著方向鍵也走不動；HUD 寫被網黏住', () => base(() => {
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'spiderNest', players, seed: 3, stage: 5 });
  tough(m);
  m.planAiTurn = () => ({ walk: null, plan: null });
  const p = m.byId('p1');
  spawnWeb(m, { id: 'webW', x: Math.round(p.x + 70), y: Math.round(p.y), hp: 60 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: STAGE });
  const me = newView('p1');
  const sent = [];
  me.transport = { send: (msg) => { sent.push(JSON.parse(J(msg))); ref.handle('p1', JSON.parse(J(msg))); } };
  ref.start();
  const feed = () => { for (const msg of io.log.splice(0)) me.onMessage(msg); };
  for (let k = 0; k < 40 && !(ref.phase === 'turn' && ref.currentId === 'p1'); k++) { io.advance(250); feed(); }
  for (let f = 0; f < 600 && (me.script || me.queue.length); f++) me.update(CONFIG.FIXED_DT);
  assert(me.canAct && me.match.byId('webW'), 'my turn, the web is on my screen');
  me.keys.KeyD = true;
  let stuckAt = -1;
  for (let f = 0; f < 200 && stuckAt < 0; f++) {
    me.update(CONFIG.FIXED_DT); me.render(); feed();
    if (me.me.held) stuckAt = f;
  }
  const mine = me.me;
  assert(stuckAt > 0 && me.match.mechState.stuck.p1 === 'webW', 'stuck locally at frame ' + stuckAt);
  const x0 = mine.x;
  for (let f = 0; f < 60; f++) { me.update(CONFIG.FIXED_DT); feed(); }
  assert(near(mine.x, x0), 'cannot walk any more');
  assert(p.held && m.mechState.stuck.p1 === 'webW' && near(m.byId('webW').x, p.x) && near(me.match.byId('webW').x, m.byId('webW').x), 'server stuck too, same web position');
  assert(io.records.some(r => r.ev === 'pickup' && r.type === 'web' && r.web === 'webW'), 'logged as a pickup');
  const lines = me.mapView.hud(me.mapCtx, ['x', '#fff']);
  assert(lines.some(l => /被網黏住/.test(l[0])), 'hud ' + J(lines));
  return { frame: stuckAt, sent: sent.length };
}));

await test('中間的火柱（2026-10-22 使用者：大型的火柱、點燃之後照亮整個空間、火焰大一點）：一開始熄著；點燃那一輪與暗一格時整個畫面都在光裡（女王沒有陰影加成），最暗那一格縮小；火焰本身也算點燃 / 著火的範圍（比一般火把高、寬）；走過去碰到也點燃', () => base(() => withConfig({ CAVE: { torchRounds: 3, dimLight: 0.45, torchPass: 10, torchReach: 24 } }, () => {
  const { torchLevel, inShadow, caveFireSources, passCave, touchTorch, torchTop } = CAVE_RULES;
  const m = make(1);
  tough(m);
  const S = m.mechState;
  const k = S.def.torches.findIndex(t => t.pillar);
  const t = S.def.torches[k];
  assert(k >= 0 && !S.lit[k] && t.x === 455 && t.y === 450, 'one pillar on the middle ledge, unlit');
  const q = queenOf(m);
  const corners = [[0, 34], [1023, 34], [0, 640], [1023, 640], [q.cx, q.cy]];
  assert(inShadow(m, q.cx, q.cy), 'dark before lighting it');
  // 玩家的子彈從火焰上半部飛過去（一般火把的高度碰不到的地方）就點燃
  const flameY = t.y - 44 - 25;
  assert(flameY < t.y - 34 - 10 && flameY >= torchTop(t), 'flame height counts');
  const p = m.byId('p1');
  const pass = passCave(m, p, { x0: t.x - 40, y0: flameY, x1: t.x + 40, y1: flameY, r: 3 });
  assert(pass && J(pass.lights) === J([k]) && torchLevel(m, k) === 3, 'lit by a shot through the flame ' + J(pass));
  for (const [x, y] of corners) assert(!inShadow(m, x, y), `lit at ${x},${y}`);
  const W = CONFIG.WEAPONS.spiderBite;
  assert(enemyHit(m, q, W) === Math.round(30 * 0.7), 'no shadow bonus for the queen while the pillar burns');
  m.round = 2;
  assert(torchLevel(m, k) === 2 && corners.every(([x, y]) => !inShadow(m, x, y)), 'still the whole screen one round later');
  m.round = 3;
  assert(torchLevel(m, k) === 1 && inShadow(m, 1023, 34), 'the dimmest step shrinks');
  m.round = 4;
  assert(torchLevel(m, k) === 0 && inShadow(m, q.cx, q.cy), 'burnt out');
  // 敵人的子彈穿過亮著的火柱也會著火（火源比一般火把大）；熄著的不算
  const src = caveFireSources(m, q);
  assert(!src.some(s => s.x0 === t.x), 'unlit: not a fire source for enemies');
  m.round = 5;
  S.lit[k] = 5;
  const src2 = caveFireSources(m, q).find(s => s.x0 === t.x);
  assert(src2 && src2.r === 18 && src2.y0 === torchTop(t), 'lit pillar is a big fire source ' + J(src2));
  // 走過去碰到（半寬比一般火把寬）
  S.lit[k] = null;
  const fx = touchTorch(m, p, t.x - 30, t.y, t.x - 20, t.y);
  assert(fx && fx.torch === k, 'touched from 20px away ' + J(fx));
  return { light: t.light, top: torchTop(t) };
})));

// ---------------- 審查抓到的（2026-10-22 多代理審查、各自驗證過） ----------------

await test('撲網放下去的那一刻：踩在網裡的人全部黏住、外面的不會（不照人的順序、不照第一個黏住後移過去的網判）；炸穿了找不到地面的地方不放網', () => base(() => {
  const m = make(3);
  tough(m);
  const S = m.mechState;
  const def = S.def;
  S.def = { ...def, webSpans: [{ x0: 520, x1: 581, y: 580 }] };   // 只剩一小段：網一定放在 x 550 左右
  const [p1, p2, p3] = m.players;
  p1.x = 520; p2.x = 580; p3.x = 488;
  m.settle(120);
  m.mechState.next = { action: 'silk' };
  const r = withConfig({ SPIDER_QUEEN: { websPerTurn: 1 } }, () => turn(m, queenOf(m)));
  const ws = r.steps.find(s => s.action === 'web');
  assert(ws && Math.abs(ws.spawns[0].x - 550) <= 1, 'placed at ~550: ' + J(ws && ws.spawns));
  assert(J(ws.caught) === J(['p1', 'p2']) && p1.held && p2.held && !p3.held, 'caught ' + J(ws.caught));
  // 找不到地面：整段炸穿 → 不放
  const m2 = make(1);
  m2.mechState.def = { ...def, webSpans: [{ x0: 700, x1: 820, y: 580 }] };
  for (let x = 680; x <= 840; x += 30) for (let y = 580; y <= 700; y += 30) m2.terrain.carve(x, y, 42);
  m2.mechState.next = { action: 'silk' };
  const r2 = turn(m2, queenOf(m2));
  assert(!r2.steps.some(s => s.action === 'web') && !m2.entities.some(e => isWeb(e)), 'no floating web: ' + J(steps(r2)));
  return { caught: ws.caught };
}));

await test('別人的畫面收到走進網的 pickup：網照伺服器的位置（不照自己畫面上還在插值的人）；網被射破之後還記得黏過誰（畫面播「掙脫了！」）', () => base(() => {
  const m = make(2);
  const p1 = m.byId('p1');
  spawnWeb(m, { id: 'webP', x: Math.round(p1.x + 40), y: Math.round(p1.y), hp: 60 });
  const { applyWebPickup, syncWebs } = SPIDER;
  p1.x -= 13;   // 這個畫面上他還沒走到（插值落後）
  applyWebPickup(m, { type: 'web', id: 'p1', web: 'webP', x: 134.5, y: p1.y });
  const w = m.byId('webP');
  assert(w.x === 134.5 && p1.held && m.mechState.stuck.p1 === 'webP', 'server position wins: ' + w.x);
  w.die('hit');
  syncWebs(m);
  assert(!p1.held && !m.mechState.stuck.p1 && w.heldId === 'p1', 'freed, the broken web remembers who it held: ' + w.heldId);
  return { x: w.x };
}));

await test('被網黏住 / 關在籠子裡的人開高壓水炮：沒有後座力（同擊退）', () => base(() => {
  const m = make(1);
  const p = m.byId('p1');
  spawnWeb(m, { id: 'webR', x: Math.round(p.x), y: Math.round(p.y), hp: 999 });
  SPIDER.applyWebPickup(m, { type: 'web', id: 'p1', web: 'webR', x: p.x, y: p.y });
  assert(p.held, 'stuck');
  const x0 = p.x, y0 = p.y;
  p.weapons = ['waterCannon'];
  m.resolveShot(p, 'waterCannon', 30, 80);
  assert(near(p.x, x0, 0.5) && near(p.y, y0, 0.5), `no recoil: ${p.x},${p.y} vs ${x0},${y0}`);
  return { recoil: CONFIG.WEAPONS.waterCannon.recoil };
}));

await test('紀錄：開場就抽好的第一招記在 battle.start（蜘蛛女王、處刑官的都包在機制的欄位裡，一樣找得到）', () => base(() => {
  const out = {};
  for (const levelId of ['spiderNest', 'prisonYard']) {
    const players = mkPlayers(2);
    const m = new Match({ levelId, players, seed: 4, stage: 5 });
    const io = new FakeIo();
    new Referee({ match: m, humans: players, io, stageInfo: { ...STAGE, levelId } }).start();
    const bs = io.records.find(r => r.ev === 'battle.start');
    const plan = m.mechState.next;
    assert(plan && bs.next === plan.action && (bs.nextTarget || null) === (plan.targetId || null), `${levelId}: ` + J({ next: bs.next, nextTarget: bs.nextTarget, plan }));
    out[levelId] = bs.next;
  }
  return out;
}));

await test('畫面：女王停在 50% 時 HUD 的下一招寫蛻皮 + 召喚；鎖血的那一下帶燃燒的話照樣飄「燃燒 +N」（showDamage 回 false）', () => base(() => {
  const m = make(1);
  const q = queenOf(m);
  q.takeDamage(99999);
  const v = newView();
  const players = mkPlayers(1);
  const io = new FakeIo();
  new Referee({ match: m, humans: players, io, stageInfo: STAGE }).start();
  for (const msg of io.log.splice(0)) v.onMessage(msg);
  const vq = v.match.byId('spiderQueen');
  vq.hp = vq.hpFloor;
  const lines = v.mapView.hud(v.mapCtx, ['x', '#fff']);
  assert(lines.some(l => l[0] === '下一招：蛻去負面狀態＋召喚蛛卵'), 'hud ' + J(lines));
  assert(v.mapView.showDamage(v.mapCtx, vq, { id: vq.id, dmg: 0, friendly: false }) === true, 'plain locked hit: handled');
  assert(v.mapView.showDamage(v.mapCtx, vq, { id: vq.id, dmg: 0, friendly: false, burn: 20 }) === false, 'locked hit with burn: generic floats too');
  return { floor: vq.hpFloor };
}));

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
