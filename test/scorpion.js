// node test/scorpion.js
// 2026-10-12：Boss 關「巨蠍巢穴」的洞穴巨蠍（同日改版：躲著 / 被火光逼出來暈眩 / 醒來出招、多人颳風）。
// 地圖（Boss 池、洞穴地形、三個洞、每個洞旁邊一支光圈比較大的火把（三種高度）、兩座岩台塔跳得上去、每個洞頂一根鐘乳石）、
// 三個部位（各自的血量、照 Boss 倍率放大、只有一個部位輪回合）、躲著碰不到（直擊、波及、鐘乳石、AI 都打不到）；
// 躲著的回合只從洞裡對每位玩家射毒刺（毒針擊破了就什麼都不做）；點亮牠那個洞的火把（打 / 飛過 / 走過，單人多人都一樣）→ 馬上出洞並暈眩；
// 暈眩的回合什麼都不做；醒來的回合：震擊周圍 + 還沒擊破的部位各出一招 + 鑽地換到別的洞（那個洞下一輪開始火把還亮著才又被逼出來）；
// 擊破部位永久少一招（換部位輪回合、三個都擊破 = 過關）、多人每一輪颳風吹熄火把（單人不吹）、一發狙擊點不完三支火把、
// 各招的範圍與目標、打下洞頂的鐘乳石砸出洞的毒針、陰影加成（出洞不吃）、快照、客戶端重播一致、裁判流程與紀錄、冒險抽得到、真的 GameView（多人 / 單人）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { Run } from '../shared/game/run.js';
import { validateCards } from '../shared/cards/cards.js';
import { PARTS, partBox, holeX, lurkPoint, syncLead, setOut, holeLit, revealIfLit } from '../shared/maps/scorpion.js';
import { torchLevel } from '../shared/maps/cave.js';
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
const make = (n = 1, opts = {}) => new Match({ levelId: 'scorpionDen', players: mkPlayers(n), seed: 1, stage: 5, ...opts });
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
  RUN: { stageCount: 10, bossStages: [5, 10], eliteStages: [3, 8], bossHpPerStage: 0.15 },
  SCORPION: { hp: { shell: 180, pincer: 140, stinger: 100 }, pinchReach: 260, cast: { emerge: 0.9, attack: 0.75, burrow: 0.9 } },
  // 陰影的加成另外測：這裡關掉，招式的傷害照原本的數字（× 敵人倍率 0.7）
  CAVE: { torchReach: 24, torchPass: 10, torchRounds: 3, torchLight: 270, faintLight: 150, dimLight: 0.45, shadowDamagePct: 0 },
  POISON: { pctPerStack: 1, persist: true },
  PLAYER: { hp: 150 }, WATER: { damagePct: 30, enemiesDrown: true }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180 },
    sniper: { ...CONFIG.WEAPONS.sniper, damage: 15, radius: 10, knockback: 90 },
    stalactite: { ...CONFIG.WEAPONS.stalactite, damage: 30, radius: 0, gravity: 900, hitRadius: 14 },
    scorpionBurst: { ...CONFIG.WEAPONS.scorpionBurst, damage: 25, knockback: 220, radius: 0, gravity: 0, hitRadius: 22, pierce: true, passTerrain: true, passAllies: true },
    scorpionPinch: { ...CONFIG.WEAPONS.scorpionPinch, damage: 30, knockback: 320, radius: 0, gravity: 0, passTerrain: true, passAllies: true },
    scorpionQuake: { ...CONFIG.WEAPONS.scorpionQuake, damage: 25, knockback: 160, radius: 0, gravity: 0, hitRadius: 6, pierce: true, passTerrain: true, passAllies: true },
    scorpionSting: { ...CONFIG.WEAPONS.scorpionSting, damage: 15, poison: 5, knockback: 60, radius: 0, gravity: 0, passTerrain: true, passAllies: true },
  },
};
const base = (fn, extra = {}) => {
  const patch = { ...BASE };
  for (const [k, v] of Object.entries(extra)) patch[k] = { ...(BASE[k] || {}), ...v };
  return withConfig(patch, fn);
};
const GROUND = LEVELS.scorpionDen.mechanic.ground;
const DMG = (w) => Math.round(CONFIG.WEAPONS[w].damage * 0.7);   // 第 5 關：敵人傷害 ×0.7（四捨五入扣血）
const angleTo = (s, x, y) => { const m = s.muzzle(); return Math.atan2(-(y - m.y), x - m.x) * 180 / Math.PI; };
// 把角色放到 (x, y) 附近站好
function placeOn(m, e, x, y = GROUND - 20) {
  e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.onGround = false;
  for (let i = 0; i < 400 && !e.onGround; i++) e.update(CONFIG.FIXED_DT, m.world);
  e.safeX = e.x; e.safeY = e.y;
}
const part = (m, key) => m.byId(PARTS.find(P => P.key === key).id);
const lead = (m) => m.enemies.find(e => e.alive && !e.noTurn);
// 讓巨蠍出一回合（不經過裁判）
const scorpionTurn = (m) => m.planAiTurn(lead(m)).boss;
const acts = (boss) => boss.steps.map(s => s.action);
const stepOf = (boss, action) => boss.steps.find(s => s.action === action);
const hitsOf = (step) => (step.shot ? step.shot.events.flatMap(ev => ev.damages || []) : []);
const kill = (m, key) => { part(m, key).takeDamage(99999); m.result(); };
// 點亮第 hole 個洞（預設：巨蠍現在在的那個）的火把（這一輪點燃的）
const light = (m, hole = m.mechState.hole) => { m.mechState.lit[m.mechState.def.holes[hole].torch] = Math.max(1, m.round); };
// 點亮巨蠍那個洞的火把把牠逼出來（暈眩）、過掉暈眩的回合，再讓牠出醒來的那一回合（震擊、各部位出招、鑽地換洞）
const wakeTurn = (m) => {
  light(m);
  revealIfLit(m);
  scorpionTurn(m);
  return scorpionTurn(m);
};
// 重播後地形遮罩、每個角色、洞穴 / 巨蠍的狀態都跟伺服器一樣
function assertSame(m, c, label) {
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(c.terrain.mask)) === 0, `${label}: terrain differs`);
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${label}: entities differ`);
  assert(J(m.mechState.lit) === J(c.mechState.lit) && J(m.mechState.fallen) === J(c.mechState.fallen), `${label}: cave state differs`);
  assert(m.mechState.hole === c.mechState.hole && m.mechState.facing === c.mechState.facing && m.mechState.out === c.mechState.out && m.mechState.stunned === c.mechState.stunned,
    `${label}: hole ${c.mechState.hole}/${c.mechState.out}/${c.mechState.stunned} vs ${m.mechState.hole}/${m.mechState.out}/${m.mechState.stunned}`);
  assert(J(m.entities.map(e => e.intangible)) === J(c.entities.map(e => e.intangible)), `${label}: intangible differs`);
}
// 從 P1 打一發狙擊、子彈從第 i 支火把旁邊飛過去（點燃）：回傳 shot（找不到 = null）。m 的輪數要先開好
function lightByShot(m, i) {
  const p = m.byId('p1');
  const t = m.mechState.def.torches[i];
  for (const dy of [10, 18, 26, 6, 30]) {
    const mm = make(m.players.length, { seed: m.seed });
    mm.round = m.round;
    for (const q of m.players) Object.assign(mm.byId(q.id), { x: q.x, y: q.y, safeX: q.x, safeY: q.y });
    const pp = mm.byId('p1');
    if (mm.resolveShot(pp, 'sniper', angleTo(pp, t.x, t.y - dy), 100).events.some(ev => (ev.lights || []).includes(i))) {
      return m.resolveShot(p, 'sniper', angleTo(p, t.x, t.y - dy), 100);
    }
  }
  return null;
}

// ---------------- 地圖 ----------------

await test('巨蠍巢穴：在 Boss 池、洞穴地形（地面整片、三個洞、每個洞旁邊一支熄著的火把（三種高度）、每個洞頂一根鐘乳石）；玩家在左邊地上；巨蠍躲在最右邊的洞、面向玩家；多人才颳風', () => base(() => {
  assert(levelsInPool('boss').includes('scorpionDen') && LEVELS.scorpionDen.name === '巨蠍巢穴' && LEVELS.scorpionDen.theme === 'cave', 'boss pool');
  const m = make(2);
  const S = m.mechState, def = S.def;
  assert(m.mechanic.type === 'scorpion' && J(Object.keys(S)) === '["def","lit","fallen","windy","hole","facing","out","stunned"]', 'state ' + Object.keys(S));
  assert(def.holes.length === 3 && S.hole === 2 && S.facing === -1 && S.out === false && S.stunned === false, `starts hidden in hole ${S.hole} facing ${S.facing}`);
  assert(S.windy === true && make(1).mechState.windy === false, 'windy only with more than one player');
  for (const p of m.players) assert(p.onGround && Math.abs(p.y - GROUND) <= 2 && p.x < 300, `${p.id} on the ground at the left: ${p.x},${p.y}`);
  for (let x = 2; x < CONFIG.WORLD_W; x += 20) assert(m.terrain.isSolid(x, GROUND + 10), `ground at ${x}`);
  for (const h of def.holes) assert(!m.terrain.isSolid((h.x0 + h.x1) / 2, GROUND - 30) && !m.terrain.isSolid((h.x0 + h.x1) / 2, h.top + 20), 'holes are background');
  // 每個洞旁邊一支火把（洞口左邊），一開始都熄著，光圈比一般的大（照得到整個洞）；三支在不同高度（地面 / A 塔高層 / B 塔低層），站得住
  assert(def.torches.length === 3 && J(S.lit) === '[null,null,null]', 'three dark torches: ' + J(S.lit));
  def.holes.forEach((h, i) => {
    const t = def.torches[h.torch];
    assert(h.torch === i && Math.abs(t.x - h.x0) < 30 && t.light > CONFIG.CAVE.torchLight, `torch ${i} beside hole ${i}: ${J(t)}`);
    assert(m.terrain.at(t.x, t.y + 1) && !m.terrain.isSolid(t.x, t.y - 6), `torch ${i} stands on the ground / a ledge: ${J(t)}`);
    assert(!holeLit(m, i), `hole ${i} dark`);
  });
  assert(new Set(def.torches.map(t => t.y)).size === 3, 'three different heights: ' + def.torches.map(t => t.y));
  light(m, 1);
  assert(holeLit(m, 1) && !holeLit(m, 0) && !holeLit(m, 2), 'each hole looks at its own torch');
  const T = m.terrain;
  assert(T.stalactites.length === 3, 'three stalactites');
  T.stalactites.forEach((s, k) => assert(s.tip.x === holeX(def, k) && s.tip.y < def.holes[k].top, `stalactite ${k} over hole ${k}: ${J(s.tip)}`));
  for (const P of PARTS) {
    const e = m.byId(P.id), b = partBox(def, 2, -1, P.key);
    assert(e && e.boss && e.fixed && e.team === 'enemies' && !e.optional && e.part === P.key && e.name === P.name, `${P.id} entity`);
    assert(e.x === b.x && e.y === b.y && e.hw === b.hw && e.h === b.h && e.facing === -1 && e.intangible, `${P.id} hidden at hole 2: ${e.x},${e.y}`);
  }
  assert(part(m, 'shell').shape === 'ellipse', 'the body is an ellipse');
  const H = def.holes[2];
  for (const P of PARTS) {
    const e = m.byId(P.id);
    assert(e.x - e.hw >= H.x0 && e.x + e.hw <= H.x1 && e.y - e.h > H.top, `${P.id} inside hole 2`);
  }
  const eye = lurkPoint(def, 2);
  assert(eye.x === holeX(def, 2) && eye.y > H.top && eye.y < GROUND, 'eyes in the middle of the hole');
}));

await test('三個部位的血量：背甲 / 巨鉗 / 毒針各自照 SCORPION.hp，照 Boss 的倍率放大（每多一人 +50%、第 10 關 ×1.75）', () => base(() => {
  const out = {};
  for (const [n, stage] of [[1, 5], [2, 5], [3, 10]]) {
    const m = make(n, { stage });
    for (const P of PARTS) {
      const e = m.byId(P.id);
      const want = Math.round(CONFIG.SCORPION.hp[P.key] * m.rules.bossHp);
      assert(e.hp === want && e.maxHp === want, `${n}p stage ${stage} ${P.key}: ${e.hp} vs ${want}`);
    }
    out[`${n}p@${stage}`] = PARTS.map(P => m.byId(P.id).hp).join('/');
  }
  return out;
}));

await test('跳得上岩台塔：地面 → 低層 → 高層（兩座塔都是）；從地面直接跳只到得了低層', () => base(() => {
  const jump = (x, y) => {
    const m = make(1);
    const p = m.byId('p1');
    placeOn(m, p, x, y);
    p.wantJump = true;
    let landed = null;
    for (let i = 0; i < 240 && !landed; i++) {
      m.step();
      if (i > 5 && p.onGround) landed = { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return landed;
  };
  const out = {};
  for (const [name, x] of [['A', 355], ['B', 669]]) {
    const up1 = jump(x - 50, GROUND - 20);
    assert(up1 && Math.abs(up1.y - 515) <= 2, `${name}: ground → low ledge: ${J(up1)}`);
    const up2 = jump(x, 515 - 10);
    assert(up2 && Math.abs(up2.y - 450) <= 2, `${name}: low → high ledge: ${J(up2)}`);
    const direct = jump(x, GROUND - 20);
    assert(direct && Math.abs(direct.y - 515) <= 2, `${name}: from the ground only the low ledge: ${J(direct)}`);
    out[name] = [up1.y, up2.y];
  }
  return out;
}));

// ---------------- 躲著 / 被火光逼出來 ----------------

await test('躲著碰不到：大砲直擊 / 爆炸波及、狙擊槍都穿過去，AI 代打也不瞄牠；出洞之後就打得到', () => base(() => {
  const m = make(1);
  const p = m.byId('p1');
  const shell = part(m, 'shell'), st = part(m, 'stinger');
  const hp = [shell.hp, st.hp];
  const d1 = m.applyExplosion(shell.x, shell.cy, CONFIG.WEAPONS.cannon, p, shell);
  const d2 = m.applyExplosion(st.x, st.cy, CONFIG.WEAPONS.cannon, p, null);
  assert(!d1.concat(d2).some(d => PARTS.some(P => P.id === d.id)) && shell.hp === hp[0] && st.hp === hp[1], 'no damage while hidden: ' + J(d1.concat(d2)));
  const shot = m.resolveShot(p, 'sniper', angleTo(p, shell.x, shell.cy), 100);
  assert(!shot.events.some(ev => ev.target && PARTS.some(P => P.id === ev.target)), 'a sniper shot passes through');
  assert(m.planAiTurn(p).plan === null, 'AI has nothing to aim at');
  setOut(m, true);
  assert(PARTS.every(P => !m.byId(P.id).intangible), 'tangible when out');
  const d3 = m.applyExplosion(shell.x, shell.cy, CONFIG.WEAPONS.cannon, p, shell);
  assert(d3.some(d => d.id === 'scorpionShell' && d.dmg > 0), 'hit when out: ' + J(d3));
  assert(m.planAiTurn(p).plan !== null, 'AI aims at it when out');
}));

await test('躲著的回合：不出來、不換洞，只從洞穴中間的雙眼那裡對每位玩家各射一發毒刺（15 × 0.7 + 中毒）；毒針被擊破了就什麼都不做', () => base(() => {
  const m = make(3);
  const [p1, p2, p3] = m.players;
  placeOn(m, p1, 600);
  placeOn(m, p2, 60);
  placeOn(m, p3, 355, 440);
  const boss = scorpionTurn(m);
  assert(J(acts(boss)) === '["sting"]' && boss.steps[0].hidden === true && boss.steps[0].cast === CONFIG.SCORPION.cast.attack, 'hidden sting only: ' + J(acts(boss)));
  const st = boss.steps[0];
  const eye = lurkPoint(m.mechState.def, 2);
  assert(st.shot.projectiles.length === 3 && st.shot.projectiles.every(q => q.x === eye.x && q.y === eye.y) && st.shot.actorId === 'scorpionStinger', 'one needle per player from the eyes');
  const hits = hitsOf(st);
  assert(J(hits.map(d => d.id).sort()) === '["p1","p2","p3"]' && hits.every(d => d.dmg === DMG('scorpionSting') && d.poison === 5), 'everyone stung once: ' + J(hits));
  assert(m.mechState.hole === 2 && m.mechState.out === false && part(m, 'shell').intangible, 'still hidden in hole 2');
  assert(J(acts(scorpionTurn(m))) === '["sting"]' && m.mechState.hole === 2, 'stays');
  kill(m, 'stinger');
  const lurk = scorpionTurn(m);
  assert(J(acts(lurk)) === '["lurk"]' && lurk.steps[0].still && !lurk.steps[0].shot, 'lurk: ' + J(lurk.steps));
}));

await test('被火光逼出來（單人、多人都一樣）：狙擊槍從巨蠍那個洞的火把旁邊飛過去（點燃）→ 牠馬上出洞（打得到）並暈眩；客戶端照事件推出一樣的狀態；點別的洞沒事', () => base(() => {
  const out = {};
  for (const n of [1, 2]) {
    const m = make(n);
    m.beginRound();
    if (n > 1) placeOn(m, m.byId('p2'), 20);   // 站到 P1 後面，不要擋子彈
    const shot = lightByShot(m, 2);
    assert(shot, `${n}p: a sniper line lights torch 2`);
    assert(m.mechState.out && m.mechState.stunned && PARTS.every(P => !m.byId(P.id).intangible) && m.mechState.hole === 2, `${n}p: revealed + stunned`);
    const c = make(n);
    c.round = m.round;
    if (n > 1) placeOn(c, c.byId('p2'), 20);
    replayChecked(c, JSON.parse(J(shot)), `${n}p reveal`);
    c.applyEntities(shot.results);
    assertSame(m, c, `${n}p reveal`);
    const o = make(n);
    o.beginRound();
    if (n > 1) placeOn(o, o.byId('p2'), 20);
    assert(lightByShot(o, 0) && !o.mechState.out && !o.mechState.stunned, `${n}p: another hole → nothing`);
    out[n] = 'ok';
  }
  return out;
}));

await test('被火光逼出來：走過去碰到巨蠍那個洞的火把（B 塔低層）也一樣（位置回報的 pickup）', () => base(() => {
  const m = make(2);
  m.beginRound();
  const p = m.byId('p1');
  placeOn(m, p, 700, 500);
  assert(Math.abs(p.y - 515) <= 2, 'P1 on the low ledge of tower B');
  const r = m.applyPositionReport(p, { x: 736, y: p.y, facing: 1 });
  assert(r.ok && r.pickup && r.pickup.type === 'torch' && r.pickup.torch === 2, 'pickup ' + J(r.pickup));
  assert(m.mechState.out && m.mechState.stunned, 'revealed + stunned');
}));

await test('暈眩的回合什麼都不做（不出招、不換洞、還在洞口）；醒來的回合：震擊周圍 → 巨鉗 → 背甲 → 毒刺 → 鑽地換到別的洞躲著（每招帶 cast、由那個部位出）；只有背甲輪回合', () => base(() => {
  const m = make(2);
  assert(m.nextActor('p2').id === 'scorpionShell' && m.nextActor('scorpionShell').id === 'p1', 'one scorpion turn per round');
  m.beginRound();
  light(m);
  assert(revealIfLit(m) && !revealIfLit(m), 'revealed once');
  const stun = scorpionTurn(m);
  assert(J(acts(stun)) === '["stunned"]' && stun.steps[0].still && !stun.steps[0].shot, 'stunned turn: ' + J(stun.steps));
  assert(m.mechState.out && !m.mechState.stunned && m.mechState.hole === 2, 'still out in hole 2');
  placeOn(m, m.byId('p1'), 650);
  const boss = scorpionTurn(m);
  assert(J(acts(boss)) === '["shock","pinch","quake","sting","burrow"]', 'wake turn: ' + acts(boss));
  const C = CONFIG.SCORPION.cast;
  assert(J(boss.steps.map(s => s.cast)) === J([C.attack, C.attack, C.attack, C.attack, C.burrow]), 'cast ' + boss.steps.map(s => s.cast));
  const owner = (a) => stepOf(boss, a).shot.actorId;
  assert(owner('shock') === 'scorpionShell' && owner('pinch') === 'scorpionPincer' && owner('quake') === 'scorpionShell' && owner('sting') === 'scorpionStinger', 'owners');
  assert(stepOf(boss, 'shock').shot.weapon === 'scorpionBurst' && !stepOf(boss, 'sting').hidden, 'shock = the burst; sting from the tail');
  const bur = stepOf(boss, 'burrow');
  assert(bur.to !== 2 && m.mechState.hole === bur.to && !m.mechState.out, 'burrowed into another hole, hidden');
  assert(J(acts(scorpionTurn(m))) === '["sting"]', 'then hidden stings');
}));

await test('鑽地換洞：別的洞（兩個都會出現）、面向玩家、部位搬過去；那個洞的火把還亮著就馬上又被逼出來、暈眩（revealed）', () => base(() => {
  const seen = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const m = make(2, { seed });
    for (const p of m.players) placeOn(m, p, 20 + Number(p.id.slice(1)) * 30);
    const boss = wakeTurn(m);
    const st = stepOf(boss, 'burrow');
    assert(st && st.from === 2 && st.to !== 2 && st.still, 'burrow: ' + J(st));
    seen.add(st.to);
    const def = m.mechState.def;
    const avg = m.players.reduce((s, p) => s + p.x, 0) / m.players.length;
    const want = avg > holeX(def, st.to) ? 1 : -1;
    assert(st.facing === want && m.mechState.facing === want, `faces the players: ${st.facing} vs ${want}`);
    for (const P of PARTS) {
      const r = st.still.results.find(s => s.id === P.id), b = partBox(def, st.to, want, P.key);
      assert(r.x === b.x && r.y === b.y, `${P.id} moved to hole ${st.to}`);
    }
  }
  assert(J([...seen].sort()) === '[0,1]', 'both other holes: ' + [...seen]);
  return { holes: [...seen] };
}));

await test('鑽進火把還亮著的洞：當下不算；下一輪開始、這一輪的火把算好之後還亮著才被逼出來暈眩（多人颳風吹熄了就不會；單人看火把燒完了沒）', () => base(() => {
  // 多人：這一輪點亮了另外兩個洞，牠醒來鑽過去 → 當下還是躲著；下一輪開始颳風吹熄 → 不會被逼出來（不會出現暈眩了火把卻是暗的）
  const m = make(2);
  m.beginRound();
  light(m, 0);
  light(m, 1);
  const st = stepOf(wakeTurn(m), 'burrow');
  assert(st && !st.revealed && !m.mechState.out && !m.mechState.stunned, 'not revealed when it burrows in: ' + J(st));
  assert(holeLit(m, st.to), 'the new hole is still lit this round');
  const fx = m.beginRound();
  assert(!holeLit(m, st.to) && !m.mechState.out && !fx.some(f => f.type === 'reveal'), 'multiplayer: the wind blew it out first → no reveal: ' + J(fx));
  assert(J(acts(scorpionTurn(m))) === '["sting"]', 'hidden sting');
  // 單人（不颳風）：火把下一輪還亮著 → 那時候被逼出來、暈眩（roundStart 的紀錄帶 reveal）
  const s = make(1);
  s.beginRound();
  light(s, 0);
  light(s, 1);
  const st1 = stepOf(wakeTurn(s), 'burrow');
  assert(!s.mechState.out, 'solo: not revealed when it burrows in');
  const sfx = s.beginRound();
  assert(holeLit(s, st1.to) && s.mechState.out && s.mechState.stunned && sfx.some(f => f.type === 'reveal' && f.hole === st1.to), 'solo: revealed at the round start: ' + J(sfx));
  assert(J(acts(scorpionTurn(s))) === '["stunned"]', 'stunned turn');
  // 單人：火把到下一輪就燒完了 → 不會被逼出來
  const t = make(1);
  t.beginRound();
  light(t, 0);
  light(t, 1);
  t.beginRound();
  t.beginRound();   // 第 1 輪點的火把：第 3 輪最暗，第 4 輪熄
  const st2 = stepOf(wakeTurn(t), 'burrow');
  assert(holeLit(t, st2.to) && !t.mechState.out, 'still lit (dim) when it burrows in');
  t.beginRound();
  assert(!holeLit(t, st2.to) && !t.mechState.out && !t.mechState.stunned, 'solo: the torch burnt out → no reveal');
}));

await test('擊破部位：每擊破一個每回合少一招（那一招之後不再出）；背甲倒了換巨鉗輪回合、巨鉗也倒了換毒針；三個都擊破 = 過關', () => base(() => {
  const moves = (m) => { setOut(m, false); return acts(wakeTurn(m)).filter(a => a !== 'shock' && a !== 'burrow'); };
  const m = make(2);
  placeOn(m, m.byId('p1'), 650);
  kill(m, 'shell');
  assert(m.result() === null && lead(m).id === 'scorpionPincer' && m.nextActor('p2').id === 'scorpionPincer', 'pincer leads after the shell breaks');
  let a = moves(m);
  assert(J(a) === '["pinch","sting"]' || J(a) === '["snap","sting"]', 'no quake: ' + a);
  kill(m, 'pincer');
  assert(lead(m).id === 'scorpionStinger', 'stinger leads');
  assert(J(moves(m)) === '["sting"]', 'only the sting');
  kill(m, 'stinger');
  assert(m.result() === 'win', 'all three broken = win');
  const n = make(2);
  placeOn(n, n.byId('p1'), 650);
  kill(n, 'stinger');
  assert(lead(n).id === 'scorpionShell' && J(moves(n)) === '["pinch","quake"]', 'no sting');
  syncLead(n); syncLead(n);
  assert(n.enemies.filter(e => e.alive && !e.noTurn).length === 1, 'exactly one part takes turns');
}));

// ---------------- 強風 / 火把 ----------------

await test('強風（多人）：每一輪開始火把全部被吹熄（這一輪點燃的才亮著），round.start 的紀錄帶 wind 與 torchOut；單人不颳風（火把照一般洞穴撐三輪）', () => base(() => {
  const m = make(2);
  m.beginRound();
  light(m, 0);
  light(m, 1);
  assert(torchLevel(m, 0) > 0 && holeLit(m, 1) && !holeLit(m, 2), 'lit this round');
  const fx = m.beginRound();
  assert(torchLevel(m, 0) === 0 && !holeLit(m, 1), 'blown out at the next round');
  assert(fx[0].type === 'wind' && J(fx.filter(f => f.type === 'torchOut').map(f => f.torch)) === '[0,1]', 'fx ' + J(fx));
  light(m, 2);
  assert(holeLit(m, 2), 'can light again in the new round');
  const s = make(1);
  s.beginRound();
  light(s, 0);
  const sfx = s.beginRound();
  assert(holeLit(s, 0) && torchLevel(s, 0) === 2 && !sfx.some(f => f.type === 'wind'), 'solo: no wind, the torch only dims: ' + J(sfx));
  s.beginRound();
  s.beginRound();
  assert(!holeLit(s, 0), 'solo: out after three rounds');
  return { fx: fx.map(f => f.type) };
}));

await test('火把在三種高度：一發狙擊最多只點亮兩支（從地面、岩台往各種角度射）', () => base(() => {
  let max = 0, shots = 0;
  const spots = [[80, GROUND - 20], [500, GROUND - 20], [900, GROUND - 20], [1000, GROUND - 20], [355, 440], [669, 505], [669, 440]];
  for (const [x, y] of spots) {
    for (let a = -70; a <= 250; a += 2) {
      const m = make(2);
      const p = m.byId('p1');
      placeOn(m, p, x, y);
      const shot = m.resolveShot(p, 'sniper', a, 100);
      max = Math.max(max, new Set(shot.events.flatMap(ev => ev.lights || [])).size);
      shots++;
    }
  }
  assert(max <= 2, 'one sniper shot lit ' + max + ' torches');
  return { shots, max };
}));

// ---------------- 招式 ----------------

await test('震擊周圍：只打站在那個洞口前面地上的人（25 × 0.7、各一次、往外推）；洞口外、岩台上（跟洞口重疊）的人打不到', () => base(() => {
  const m = make(4);
  const def = m.mechState.def, H = def.holes[2];
  const [p1, p2, p3, p4] = m.players;
  placeOn(m, p1, holeX(def, 2) - 30);
  placeOn(m, p2, H.x1 - 12);
  placeOn(m, p3, H.x1 + 40);
  placeOn(m, p4, 725, 500);
  assert(Math.abs(p4.y - 515) <= 2 && p4.onGround, 'P4 on the low ledge');
  const x2 = p2.x;
  const step = stepOf(wakeTurn(m), 'shock');
  assert(step.hole === 2 && step.shot.weapon === 'scorpionBurst' && step.shot.projectiles.length === 2, 'two bursts from hole 2');
  const hits = hitsOf(step);
  assert(J(hits.map(d => d.id).sort()) === '["p1","p2"]' && hits.every(d => d.dmg === DMG('scorpionBurst')), 'hits ' + J(hits));
  assert(step.shot.results.find(r => r.id === 'p2').x > x2 + 20, 'P2 pushed outward');
  return { hits: hits.map(d => d.id) };
}));

await test('巨鉗夾擊：夾 pinchReach 內離鉗子最近的人（30 × 0.7、往外甩得很遠）；範圍裡沒人就撲空（snap，不出飛行物）', () => base(() => {
  const m = make(2);
  const [p1, p2] = m.players;
  placeOn(m, p1, 640);
  placeOn(m, p2, 560);
  const x1 = p1.x;
  const step = stepOf(wakeTurn(m), 'pinch');
  assert(step && step.targetId === 'p1' && step.shot.weapon === 'scorpionPinch', 'pinches the nearest: ' + J(step && step.targetId));
  const hit = hitsOf(step);
  assert(hit.length === 1 && hit[0].id === 'p1' && hit[0].dmg === DMG('scorpionPinch'), 'pinch dmg ' + J(hit));
  assert(step.shot.results.find(r => r.id === 'p1').x < x1 - 60, 'P1 flung away from the claw');
  const n = make(2);
  for (const p of n.players) placeOn(n, p, 150 + Number(p.id.slice(1)) * 40);
  const snap = stepOf(wakeTurn(n), 'snap');
  assert(snap && snap.still && !snap.shot, 'snap');
}));

await test('甲殼地鳴：從身體中間沿地面往兩邊跑到地圖邊；地上的人不管多遠（含巨蠍身體底下）都被震到（25 × 0.7、各一次），站在岩台上的人不會', () => base(() => {
  const m = make(4);
  kill(m, 'pincer');
  const def = m.mechState.def;
  const [p1, p2, p3, p4] = m.players;
  placeOn(m, p1, 40);
  placeOn(m, p2, 1000);
  placeOn(m, p3, 355, 440);
  placeOn(m, p4, holeX(def, 2) + 10);
  assert(Math.abs(p3.y - 450) <= 2 && p3.onGround, 'P3 on the high ledge');
  const step = stepOf(wakeTurn(m), 'quake');
  assert(step && step.shot.weapon === 'scorpionQuake' && step.shot.projectiles.length === 2, 'two waves');
  const hits = hitsOf(step);
  assert(J(hits.map(d => d.id).sort()) === '["p1","p2","p4"]' && hits.every(d => d.dmg === DMG('scorpionQuake')), 'quake hits ' + J(hits));
  return { hits: hits.map(d => d.id) };
}, { WEAPONS: { ...BASE.WEAPONS, scorpionBurst: { ...BASE.WEAPONS.scorpionBurst, knockback: 0 } } }));

await test('出洞的毒刺：從尾巴的毒針對每位玩家各射一發（15 × 0.7 + 5 層中毒），穿過地形', () => base(() => {
  const m = make(3);
  const [p1, p2, p3] = m.players;
  placeOn(m, p1, 300);
  placeOn(m, p2, 60);
  placeOn(m, p3, 355, 440);
  const step = stepOf(wakeTurn(m), 'sting');
  assert(step && !step.hidden && step.shot.weapon === 'scorpionSting' && step.shot.projectiles.length === 3, 'three needles');
  const hits = hitsOf(step);
  assert(J(hits.map(d => d.id).sort()) === '["p1","p2","p3"]' && hits.every(d => d.dmg === DMG('scorpionSting') && d.poison === 5), 'sting ' + J(hits));
  assert(m.players.every(p => p.poison === 5), 'everyone poisoned');
}));

await test('洞頂的鐘乳石：巨蠍躲著時掉下來砸不到牠；出洞時先砸到毒針（30，玩家的攻擊）', () => base(() => {
  const s = (m) => m.terrain.stalactites[2];
  let dy = null;
  for (const d of [14, 20, 26, 32, 40, 50]) {
    const mm = make(1);
    const pp = mm.byId('p1');
    const sh = mm.resolveShot(pp, 'sniper', angleTo(pp, s(mm).tip.x, s(mm).tip.y - d), 100);
    if (sh.events.some(ev => ev.falls && ev.falls.includes(2))) { dy = d; break; }
  }
  assert(dy !== null, 'a sniper line from the spawn reaches the stalactite over hole 2');
  const drop = (out) => {
    const m = make(1);
    if (out) setOut(m, true);
    const p = m.byId('p1');
    const st = part(m, 'stinger');
    const hp = st.hp;
    const shot = m.resolveShot(p, 'sniper', angleTo(p, s(m).tip.x, s(m).tip.y - dy), 100);
    const rock = shot.events.find(ev => ev.p === 1 && ['explode', 'pierce', 'water', 'out'].includes(ev.type));
    return { m, shot, rock, lost: hp - st.hp };
  };
  const hidden = drop(false);
  assert(hidden.rock && !hidden.rock.target && hidden.lost === 0, 'hidden: the rock falls through: ' + J(hidden.rock));
  const out = drop(true);
  assert(out.rock && out.rock.target === 'scorpionStinger' && out.rock.damages[0].dmg === 30 && out.lost === 30, 'out: the rock hits the stinger: ' + J(out.rock));
  const c = make(1);
  setOut(c, true);
  replayChecked(c, JSON.parse(J(out.shot)), 'rock');
  c.applyEntities(out.shot.results);
  assertSame(out.m, c, 'rock');
}));

await test('陰影：躲在暗處射的毒刺 +30%（15 × 0.7 × 1.3）；醒來的回合（多人火把剛被風吹熄、牠在暗處）出洞的攻擊不吃加成（單人多人都是）', () => base(() => {
  const out = {};
  for (const n of [1, 2]) {
    const m = make(n);
    m.beginRound();
    for (const p of m.players) placeOn(m, p, holeX(m.mechState.def, 2) - 30 - Number(p.id.slice(1)) * 3);
    const dark = hitsOf(scorpionTurn(m).steps[0])[0].dmg;
    light(m);
    revealIfLit(m);
    scorpionTurn(m);   // 暈眩
    m.beginRound();
    if (n > 1) assert(!holeLit(m, 2), 'multiplayer: the wind blew the torch out');
    const shock = hitsOf(stepOf(scorpionTurn(m), 'shock'))[0].dmg;
    assert(dark === Math.round(15 * 0.7 * 1.3) && shock === Math.round(25 * 0.7), `${n}p: dark sting ${dark} / wake shock ${shock}`);
    out[n] = { dark, shock };
  }
  return out;
}, { CAVE: { shadowDamagePct: 30 } }));

// ---------------- 同步 ----------------

await test('快照：在哪個洞、面向、出洞了沒、暈眩中（部位碰不碰得到跟著）、部位的血量 / 位置、掉下來的鐘乳石、火把，重連時照快照重建；只帶 items 的部分還原不動', () => base(() => {
  const m = make(2, { seed: 7 });
  kill(m, 'pincer');
  m.terrain.dropStalactite(1);
  m.mechState.fallen.push(1);
  wakeTurn(m);   // 醒來出招、換洞（躲著）
  light(m);
  revealIfLit(m);   // 又被逼出來（暈眩中）
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(Object.keys(snap)) === J(['entities', 'holes', 'minions', 'treeNext', 'snakeNext', 'items', 'bees', 'torches', 'fallen', 'scorpionHole', 'scorpionFacing', 'scorpionOut', 'scorpionStunned']), 'keys ' + Object.keys(snap));
  assert(snap.scorpionOut === true && snap.scorpionStunned === true, 'out + stunned in the snapshot');
  const c = make(2, { seed: 7 });
  c.applySnapshot(snap);
  assertSame(m, c, 'snapshot');
  assert(!part(c, 'pincer').alive && c.result() === null && lead(c).id === 'scorpionShell' && !part(c, 'shell').intangible, 'restored: broken pincer, out');
  c.mechanic.restore(c, { items: [] });
  assertSame(m, c, 'partial restore');
}));

await test('客戶端照事件重播好幾回合（躲著射毒刺、被逼出來暈眩、醒來出招、鑽地換洞）跟伺服器一模一樣', () => base(() => {
  const out = [];
  for (const seed of [1, 2, 3]) {
    const setup = (mm) => {
      const [a, b, d] = mm.players;
      placeOn(mm, a, 640);
      placeOn(mm, b, 860);
      placeOn(mm, d, 355, 500);
    };
    const m = make(3, { seed });
    setup(m);
    const c = make(3, { seed });
    setup(c);
    const log = [];
    for (let turn = 0; turn < 5; turn++) {
      if (turn === 1) {   // 第二回合前有人點亮巨蠍那個洞：兩邊照同一個條件推（客戶端在套用點燃的那個事件之後）
        light(m); revealIfLit(m);
        light(c); revealIfLit(c);
      }
      const boss = JSON.parse(J(scorpionTurn(m)));
      for (const st of boss.steps) {
        // 客戶端照 map-views/scorpion.js 的順序改狀態
        if (st.action === 'stunned') c.mechState.stunned = false;
        if (st.action === 'burrow') { c.mechState.hole = st.to; c.mechState.facing = st.facing; setOut(c, false); }
        if (st.shot) {
          replayChecked(c, st.shot, `${seed}/${turn} ${st.action}`);
          c.applyEntities(st.shot.results);
        } else c.applyEntities(st.still.results);
      }
      assertSame(m, c, `seed ${seed} turn ${turn}`);
      log.push(acts(boss).join('>'));
    }
    out.push(log.join(' | '));
  }
  return out;
}));

await test('裁判流程：玩家都斷線（AI 代打）時一直打到結束；巨蠍的回合 = boss.steps（躲著：毒刺 / 躲在暗處；暈眩；醒來：震擊 + 最多三招 + 鑽地），紀錄帶每一招', () => base(() => {
  const out = {};
  const okTurn = (a) => {
    if (['["sting"]', '["lurk"]', '["stunned"]'].includes(J(a))) return true;
    const mid = a[a.length - 1] === 'burrow' ? a.slice(1, -1) : a.slice(1);
    return a[0] === 'shock' && mid.length <= 3 && mid.every(x => ['pinch', 'snap', 'quake', 'sting'].includes(x));
  };
  for (const seed of [2, 5]) {
    const m = make(2, { seed });
    m.mechState.lit = [1, 1, 1];
    revealIfLit(m);   // 開場就被逼出來（暈眩）：會醒來出招、會換洞
    const io = new FakeIo();
    let over = null;
    const ref = new Referee({ match: m, humans: mkPlayers(2), io, onGameOver: (r) => { over = r; } });
    ref.start();
    for (const p of mkPlayers(2)) ref.setConnected(p.id, false);
    while (!over && io.t < 30_000_000) io.advance(500);
    assert(over === 'win' || over === 'lose', `${seed}: ended ${over}`);
    const turns = io.take('aiTurn').filter(t => t.boss);
    assert(turns.length >= 2 && turns.every(t => PARTS.some(P => P.id === t.actorId)), 'scorpion turns');
    for (const t of turns) assert(okTurn(t.boss.steps.map(s => s.action)), 'turn ' + t.boss.steps.map(s => s.action));
    assert(turns[0].boss.steps[0].action === 'stunned' && turns.some(t => t.boss.steps[0].action === 'shock'), 'stunned, then woke up');
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.boss);
    assert(recs.length === turns.length && recs.every((r, i) => J(r.boss.map(s => s.action)) === J(turns[i].boss.steps.map(s => s.action))), 'logged every step');
    assert(recs.some(r => r.boss.some(s => s.action === 'burrow' && Number.isInteger(s.to))), 'burrow logs where it went');
    out[seed] = { over, turns: turns.length };
  }
  return out;
}));

// ---------------- 冒險 ----------------

await test('一場冒險：Boss 池有三隻王，第 5、10 關抽兩隻不一樣的；巨蠍巢穴抽得到', () => base(() => {
  const pool = levelsInPool('boss');
  assert(J(pool) === '["treeGarden","jungleSerpent","scorpionDen"]', 'pool ' + pool);
  const seen = new Set();
  for (let seed = 1; seed <= 30; seed++) {
    const run = new Run({ players: mkPlayers(1), seed, io: new FakeIo(), cards: CARDS.cards });
    run.stage = 5;
    const first = run.pickLevel();
    run.noteLevel(first);
    run.stage = 10;
    run.lastLevelId = 'level1';
    const second = run.pickLevel();
    assert(pool.includes(first) && pool.includes(second) && first !== second, `seed ${seed}: ${first} → ${second}`);
    seen.add(first);
    seen.add(second);
  }
  assert(seen.has('scorpionDen'), 'scorpion picked: ' + [...seen]);
  return { seen: [...seen] };
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

// 記下畫圖呼叫（只數次數）
const counting = () => {
  const calls = {};
  const ctx = new Proxy(fakeCtx2d(), { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { calls[k] = (calls[k] || 0) + 1; return t[k](...a); } : t[k]) });
  return { ctx, calls };
};
// 遮光上面畫了哪些字
const shadeTexts = (view) => {
  const texts = [];
  const ctx = new Proxy(fakeCtx2d(), { get: (t, k) => (k === 'fillText' ? (str) => texts.push(str) : t[k]) });
  view.mapView.drawShade(ctx, view.mapCtx);
  return texts;
};

await test('真的 GameView（多人）：開場被逼出來暈眩 → 醒來出招、換洞；新的一輪颳風（字幕）；客戶端的洞、出洞了沒、部位跟伺服器一樣；Boss 曲；躲著只畫雙眼、部位不畫陰影紅光', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'scorpionDen', players, seed: 9, stage: 5 });
  for (const p of m.players) { p.hp = p.maxHp = 3000; }
  m.mechState.lit = [1, 1, 1];
  revealIfLit(m);
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 5, stageCount: 10, isBoss: true, type: 'boss', levelId: 'scorpionDen', levelName: '巨蠍巢穴', cards: {} } });
  ref.start();
  for (const p of players) ref.setConnected(p.id, false);
  const view = new GameView(fakeCanvas());
  const tracks = [];
  view.music = { play(t) { tracks.push(t); }, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  assert(view.mapView.type === 'scorpion' && view.match.mechState.out && view.match.mechState.stunned && !view.mapCtx.state.rise, 'client starts out + stunned (no rise replay)');
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  let bossTurns = 0, sawDig = false, caption = false;
  try {
    for (let k = 0; k < 600 && ref.phase !== 'over' && !(sawDig && caption && bossTurns >= 3); k++) {
      io.advance(250);
      bossTurns += io.log.filter(x => x.t === 'aiTurn' && x.boss).length;
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        if (view.mapCtx.state.dig) sawDig = true;
        if (view.mapCtx.state.wind && shadeTexts(view).includes('颳起一陣強烈的風')) caption = true;
      }
    }
    io.advance(20_000);
    feed();
    for (let f = 0; f < 2400; f++) view.update(CONFIG.FIXED_DT);
    view.render();
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(bossTurns >= 2 && sawDig && caption, `played ${bossTurns} scorpion turns, dig ${sawDig}, wind caption ${caption}`);
  const S = view.match.mechState;
  assert(S.hole === m.mechState.hole && S.facing === m.mechState.facing && S.out === m.mechState.out && S.stunned === m.mechState.stunned, `hole ${S.hole}/${S.out} vs ${m.mechState.hole}/${m.mechState.out}`);
  for (const P of PARTS) {
    const a = view.match.byId(P.id), b = m.byId(P.id);
    assert(a.x === b.x && a.y === b.y && a.hp === b.hp && a.alive === b.alive && a.intangible === b.intangible, `${P.id} synced`);
  }
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(view.match.terrain.mask)) === 0, 'client terrain = server');
  assert(tracks.filter(Boolean).every(t => t === 'scorpion') && tracks.some(Boolean), 'boss music: ' + [...new Set(tracks)]);
  // 躲著：場景裡不畫身體；出洞：畫整隻
  setOut(view.match, false);
  const hidden = counting();
  view.mapView.drawScene(hidden.ctx, view.mapCtx);
  setOut(view.match, true);
  view.mapCtx.state.lastOut = true;
  const outC = counting();
  view.mapView.drawScene(outC.ctx, view.mapCtx);
  assert((outC.calls.arc || 0) > (hidden.calls.arc || 0) + 15, `body drawn only when out: arcs ${hidden.calls.arc || 0} → ${outC.calls.arc || 0}`);
  const grads = [];
  const ctx = new Proxy(fakeCtx2d(), { get: (t, k) => (k === 'createRadialGradient' ? (...a) => { grads.push(a.map(Math.round)); return { addColorStop() {} }; } : t[k]) });
  view.mapCtx.state.bursts = [];
  view.mapView.drawShade(ctx, view.mapCtx);
  const auraAt = (e) => grads.some(g => g[0] === Math.round(e.cx) && g[1] === Math.round(e.y - e.h * 0.68));
  assert(!PARTS.some(P => auraAt(view.match.byId(P.id))), 'no shadow aura on the scorpion parts');
  return { bossTurns, hole: m.mechState.hole };
}));

await test('真的 GameView（單人）：玩家一槍點亮巨蠍那個洞的火把 → 畫面上牠從地底升上來、頭上轉星星、暈眩的橫幅；牠的回合暈眩；之後醒來出招、換洞；單人不颳風', () => base(() => {
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'scorpionDen', players, seed: 4, stage: 5 });
  m.byId('p1').hp = m.byId('p1').maxHp = 3000;
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  const seen = { rise: false, stars: false, stunBanner: false, wind: false, actions: [] };
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const tick = (ms) => {
    for (let k = 0; k < ms / 250; k++) {
      io.advance(250);
      for (const x of io.log) if (x.t === 'aiTurn' && x.boss) seen.actions.push(x.boss.steps.map(s => s.action).join('>'));
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        const s = view.mapCtx.state, S = view.match.mechState;
        if (s.rise) seen.rise = true;
        if (S.stunned && S.out) seen.stars = true;
        if (view.banner && /暈眩/.test(view.banner.text)) seen.stunBanner = true;
        if (s.wind) seen.wind = true;
      }
    }
  };
  try {
    for (let k = 0; k < 40 && !(ref.phase === 'turn' && ref.currentId === 'p1'); k++) tick(250);
    assert(ref.currentId === 'p1', 'P1 turn');
    const p = m.byId('p1'), t = m.mechState.def.torches[2];
    let angle = null;
    for (const dy of [10, 18, 26, 6, 30]) {
      const mm = new Match({ levelId: 'scorpionDen', players, seed: 4, stage: 5 });
      mm.round = m.round;
      const pp = mm.byId('p1');
      Object.assign(pp, { x: p.x, y: p.y });
      const a = angleTo(pp, t.x, t.y - dy);
      if (mm.resolveShot(pp, 'sniper', a, 100).events.some(ev => (ev.lights || []).includes(2))) { angle = a; break; }
    }
    assert(angle !== null, 'found a lighting shot');
    ref.handle('p1', { t: 'fire', weapon: 'sniper', angle, power: 100, x: p.x, y: p.y, facing: 1, stamina: p.stamina });
    tick(6000);
    assert(view.match.mechState.out && seen.rise && seen.stars && seen.stunBanner, 'client saw the reveal: ' + J(seen));
    ref.setConnected('p1', false);
    for (let k = 0; k < 40 && !seen.actions.some(x => x.startsWith('shock')); k++) tick(1000);
    tick(15000);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(seen.actions[0] === 'stunned' && seen.actions.some(x => /^shock>.*>burrow$/.test(x)), 'scorpion turns: ' + J(seen.actions));
  assert(!seen.wind && !m.mechState.windy, 'no wind in solo');
  const S = view.match.mechState;
  assert(S.hole === m.mechState.hole && S.out === m.mechState.out && S.stunned === m.mechState.stunned, `client ${S.hole}/${S.out} vs server ${m.mechState.hole}/${m.mechState.out}`);
  return { actions: seen.actions.slice(0, 4) };
}));

await test('真的 GameView（單人）：巨蠍醒來鑽進火把還亮著的洞 → 下一輪開始客戶端照同一個條件推出牠被逼出來暈眩（飄字、不蓋掉回合的橫幅），狀態跟伺服器一樣', () => base(() => {
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'scorpionDen', players, seed: 4, stage: 5 });
  m.byId('p1').hp = m.byId('p1').maxHp = 3000;
  m.mechState.lit = [1, 1, 1];   // 第 1 輪點的：單人三輪才燒完
  revealIfLit(m);                // 開場就在第 2 個洞被逼出來（暈眩）
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  ref.setConnected('p1', false);
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  let roundReveal = false, sawRise = false, revealBanner = false;
  try {
    for (let k = 0; k < 400 && !roundReveal; k++) {
      io.advance(250);
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        if (view.mapCtx.state.rise) sawRise = true;
        if (view.banner && /被火光逼出洞外/.test(view.banner.text)) revealBanner = true;
      }
      roundReveal = io.records.some(r => r.ev === 'round.start' && (r.fx || []).some(f => f.type === 'reveal'));
    }
    for (let f = 0; f < 120; f++) { view.update(CONFIG.FIXED_DT); if (view.mapCtx.state.rise) sawRise = true; }
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(roundReveal, 'server revealed it at a round start');
  const S = view.match.mechState;
  assert(S.out && S.stunned && S.hole === m.mechState.hole && m.mechState.out && m.mechState.stunned, `client ${S.hole}/${S.out}/${S.stunned} vs server ${m.mechState.hole}/${m.mechState.out}/${m.mechState.stunned}`);
  assert(holeLit(view.match, S.hole), 'the torch of that hole is lit this round');
  assert(sawRise && !revealBanner, 'rose up with a float, the turn banner stays');
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
