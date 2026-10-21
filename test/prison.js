// node test/prison.js
// 2026-10-19：Boss 關「處刑監獄」的處刑官（hp 400、菜刀丟擲、訓獸者皮鞭、處刑者囚籠 → 斷頭台、80 / 60 / 40% 跳上處刑台打開牢房、
// 召喚獸全倒 → 哭兩回合 → 暴怒流星錘）與三隻猛獸（惡狼撕咬先咬流血的人、棕熊熊掌拍擊 / 護主、劍齒虎標記血最少的人 → 飛撲（路上的人先被撲到、吃掉流血層數））、
// 天花板的吊燈（打下來砸人、砸到敵人暈眩一回合）。
// 地圖（Boss 池、地面與天花板炸不壞、處刑台跳不上去）、血量門檻（停在門檻、等他的回合跳上去）、在台上打不到、放出來的猛獸這一輪不動、
// 猛獸倒下 → 跳下來、皮鞭（-20、最多剩 1 血、下一次攻擊 ×1.3、不疊加、用掉就沒了）、
// 囚籠（血量 40 × 人數、關在他站的地方、走不動 / 跳不起來 / 不會被擊退、自己往哪裡射都打在籠子上而且傷不到自己、隊友打破就放出來、撐過 3 輪 → 處刑（拖到斷頭台、一定砍中）、
// 無敵擋得住、被關的人倒下籠子跟著消失、場上最多一個）、熊護主（擋到囚籠靠玩家那邊、受傷 ×0.7 到牠下一回合）、
// 虎（標記血最少的人、路上的人先被撲到、流血每層 +2 並吃掉）、哭（×1.5、不行動、兩回合）→ 暴怒（紅眼 + 流星錘 50、擊退 200）、
// 吊燈（打到 / 炸到就掉、砸到猛獸暈眩、暈眩的回合不動）、客戶端照事件重播一致、快照重建、裁判流程與紀錄、真的 GameView 播一段
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { makeProjectile } from '../shared/physics/weapons.js';
import { cageRoundsLeft, pounceTarget, lowestPlayer, biteTarget, prisonState } from '../shared/maps/prison.js';
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
  PLAYER: { hp: 150 }, FEVER: { inBoss: false }, BLEED: { pctPerPx: 0.01 },
  EXECUTIONER: {
    hp: 400, hw: 34, h: 96, phases: [80, 60, 40], whipDamage: 20, whipPct: 30, cageHpPerPlayer: 40, cageRounds: 3, cryTurns: 2, cryDamagePct: 50,
    weights: { cleaver: 40, whip: 30, cage: 30 }, rageWeights: { flail: 50, cleaver: 30, cage: 20 },
  },
  WOLF: { hp: 150 }, BEAR: { hp: 200, guardCut: 30 }, TIGER: { hp: 250, bleedBonus: 2 },
  WEAPONS: {
    execCleaver: { damage: 20, bleed: 10 }, execFlail: { damage: 50, knockback: 200 }, chandelier: { damage: 60 },
    wolfBite: { damage: 30, bleed: 10 }, bearSwipe: { damage: 35, knockback: 250 }, tigerPounce: { damage: 45 },
  },
};
const base = (fn) => withConfig(BASE, fn);
// 第 5 關（第一個 Boss 關：敵人傷害 ×0.7、血量只吃人數）
const make = (n = 2, opts = {}) => new Match({ levelId: 'prisonYard', players: mkPlayers(n), seed: 1, stage: 5, ...opts });
const bossOf = (m) => m.byId('executioner');
const turn = (m, e) => m.mechanic.aiTurn(m, e);
const tough = (m, hp = 5000) => { for (const p of m.players) { p.hp = p.maxHp = hp; } };
const steps = (r) => r.steps.map(s => s.action);
// 王的血量打到第 k 個門檻（直接扣，跟被打到一樣：停在門檻）
function hitBoss(m, dmg) {
  const b = bossOf(m);
  return b.takeDamage(dmg);
}
// 讓王放出第 k 隻（0 = 狼）：血量打到門檻、輪到他
function releaseNext(m) {
  hitBoss(m, 99999);
  return turn(m, bossOf(m));
}

await test('地圖：處刑監獄在 Boss 池；處刑官從最右邊出場站在地上（血量照 Boss 的倍率、門檻 80%）、開場就抽好第一招（有目標）；地面 / 天花板炸不壞、處刑台是可穿透平台（比地面高 208：玩家跳不上去）；四盞吊燈', () => base(() => {
  assert(levelsInPool('boss').includes('prisonYard') && LEVELS.prisonYard.mechanic.type === 'prison', 'boss pool');
  const m = make(2);
  const b = bossOf(m);
  const scale = 1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER;
  assert(b.alive && b.boss && b.hp === Math.round(400 * scale) && b.hpFloor === Math.round(400 * scale * 0.8), `hp ${b.hp} floor ${b.hpFloor}`);
  assert(b.x > 900 && b.onGround && Math.abs(b.y - 580) < 2 && !b.intangible, `boss at ${b.x}, ${b.y}`);
  const S = m.mechState;
  assert(S.next && ['cleaver', 'cage'].includes(S.next.action) && m.players.some(p => p.id === S.next.targetId), 'opening plan ' + J(S.next));
  const t = m.terrain;
  const before = t.mask.slice();
  t.carve(500, 580, 40);
  assert(t.mask.every((v, i) => v === before[i]), 'the floor does not carve');
  const plat = LEVELS.prisonYard.platforms[0];
  assert(580 - plat[0][1] === 208 && CONFIG.PLAYER.jumpSpeed ** 2 / (2 * CONFIG.GRAVITY) < 208, 'players cannot jump onto the scaffold');
  assert(t.stalactites.length === 4, 'four chandeliers');
  return { hp: b.hp, floor: b.hpFloor, first: S.next };
}));

await test('血量門檻：打到 80% 就停住（多打的不算）；輪到他時跳上處刑台（打不到：直擊、波及都碰不到）、打開牢房 I 放出惡狼（這一輪不動、照王的倍率），門檻換成 60%，同一回合照樣出一招', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  const dealt = hitBoss(m, 99999);
  assert(b.hp === b.hpFloor && dealt === b.maxHp - b.hpFloor && b.alive, `stops at the floor: ${b.hp}`);
  assert(hitBoss(m, 50) === 0, 'more damage is wasted');
  const r = turn(m, b);
  assert(steps(r)[0] === 'release' && r.steps.length === 2 && ['cleaver', 'cage', 'whip'].includes(steps(r)[1]), 'release + an action: ' + steps(r));
  const rel = r.steps[0];
  assert(rel.cell === 0 && rel.spawns.length === 1 && rel.spawns[0].id === 'wolf', 'cell I, the wolf');
  assert(b.intangible && m.mechState.up && near(b.x, LEVELS.prisonYard.mechanic.perch.x) && b.y < 380 && b.onGround, `on the scaffold ${b.x}, ${b.y}`);
  const wolf = m.byId('wolf');
  const scale = 1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER;
  assert(wolf && wolf.alive && wolf.dormant && wolf.hp === Math.round(150 * scale), `wolf ${wolf && wolf.hp}`);
  assert(b.hpFloor === Math.round(b.maxHp * 0.6), 'next floor 60%');
  // 在台上：直擊 / 爆炸都碰不到
  const dm = m.applyExplosion(b.x, b.cy, CONFIG.WEAPONS.cannon, m.players[0], b);
  assert(!dm.some(d => d.id === b.id), 'intangible on the scaffold');
  assert(m.nextActor('executioner').id === 'p1' || m.nextActor('executioner').dormant === false, 'the dormant wolf waits for the next round');
  return { release: rel.spawns[0], action: steps(r)[1] };
}));

await test('惡狼撕咬：先咬有流血的人（層數最多的；都沒有就最近的），30 × 0.7 + 10 層流血，停在被咬的人旁邊；客戶端照事件重播一致', () => base(() => {
  const m = make(3);
  tough(m);
  releaseNext(m);
  const wolf = m.byId('wolf');
  wolf.dormant = false;
  const [p1, p2, p3] = m.players;
  assert(biteTarget(m, wolf).id === p3.id || biteTarget(m, wolf) === m.players.reduce((a, e) => (Math.abs(e.x - wolf.x) < Math.abs(a.x - wolf.x) ? e : a)), 'nearest when nobody bleeds');
  p1.bleed = 4; p2.bleed = 9;
  assert(biteTarget(m, wolf).id === 'p2', 'the one bleeding the most');
  const cm = make(3);
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  const hp0 = p2.hp;
  const r = turn(m, wolf);
  const st = r.steps[0];
  assert(st.action === 'bite' && st.targetId === 'p2', 'bites p2: ' + J(st.action));
  assert(hp0 - p2.hp === Math.round(30 * 0.7) && p2.bleed === 19, `dmg ${hp0 - p2.hp}, bleed ${p2.bleed}`);
  assert(Math.abs(wolf.x - p2.x) < 80 && wolf.onGround, `wolf beside p2: ${wolf.x} vs ${p2.x}`);
  replayChecked(cm, st.shot, 'bite');
  return { dmg: hp0 - p2.hp, wolfX: Math.round(wolf.x) };
}));

await test('放出來的猛獸倒下 → 輪到王時跳下處刑台（打得到了）；再打到 60% → 跳上去打開牢房 II（棕熊），40% → 牢房 III（劍齒虎）；三隻都倒下 → 跳下來坐在地上哭', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  releaseNext(m);
  m.byId('wolf').die('hit');
  let r = turn(m, b);
  assert(steps(r)[0] === 'descend' && !b.intangible && !m.mechState.up && b.x > 930 && b.y > 570, 'descends: ' + steps(r));
  r = releaseNext(m);
  assert(steps(r)[0] === 'release' && r.steps[0].spawns[0].id === 'bear' && m.byId('bear'), 'bear out');
  m.byId('bear').die('hit');
  turn(m, b);
  r = releaseNext(m);
  assert(r.steps[0].spawns[0].id === 'tiger' && b.hpFloor === 0, 'tiger out, no more floors');
  m.byId('tiger').die('hit');
  r = turn(m, b);
  assert(J(steps(r)) === J(['descend', 'cry']) && m.mechState.mood === 'cry', 'descends and cries: ' + steps(r));
  return { released: m.mechState.released };
}));

await test('哭：受到的傷害 ×1.5、自己的回合什麼都不做（兩回合）→ 暴怒站起來 + 流星錘（隨機一人 50 × 0.7、擊退 200）；之後照暴怒的招式（沒有皮鞭）', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  for (let k = 0; k < 3; k++) { releaseNext(m); m.enemies.filter(e => e.alive && e !== b).forEach(e => e.die('hit')); }
  let r = turn(m, b);
  assert(J(steps(r)) === J(['descend', 'cry']), 'first cry ' + steps(r));
  const hp0 = b.hp;
  const dm = m.applyExplosion(b.x, b.cy, { ...CONFIG.WEAPONS.sniper, damage: 20, radius: 0 }, m.players[0], b, { directOnly: true });
  assert(dm.find(d => d.id === b.id).dmg === 30 && hp0 - b.hp === 30, 'x1.5 while crying: ' + J(dm));
  r = turn(m, b);
  assert(J(steps(r)) === J(['cry']) && r.next.action === 'rage', 'second cry, rage next');
  const before = new Map(m.players.map(p => [p.id, { hp: p.hp, x: p.x }]));
  r = turn(m, b);
  assert(J(steps(r)) === J(['rage', 'flail']) && m.mechState.mood === 'rage', 'rage + flail ' + steps(r));
  const t = m.byId(r.steps[1].targetId);
  assert(before.get(t.id).hp - t.hp === Math.round(50 * 0.7), 'flail dmg ' + (before.get(t.id).hp - t.hp));
  assert(Math.abs(t.x - before.get(t.id).x) > 40, 'knocked back');
  for (let k = 0; k < 30; k++) {
    m.round++;
    const rr = turn(m, b);
    assert(rr.steps.every(s => ['flail', 'cleaver', 'cage', 'execute'].includes(s.action)), 'rage moves ' + steps(rr));
    for (const e of m.enemies) if (e.kind === 'cage' && e.alive) e.die('hit');
    m.result();
  }
  return { rageNext: r.next };
}));

await test('訓獸者皮鞭：打自己的猛獸 -20（最多剩 1 血、打不死），牠下一次攻擊 ×1.3（不疊加），用掉就沒了', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  releaseNext(m);
  const wolf = m.byId('wolf');
  wolf.dormant = false;
  m.mechState.next = { action: 'whip', targetId: 'wolf' };
  const hp0 = wolf.hp;
  let r = turn(m, b);
  assert(steps(r)[0] === 'whip' && r.steps[0].dmg === 20 && wolf.hp === hp0 - 20 && m.mechState.whip === 'wolf', 'whip -20');
  m.mechState.next = { action: 'whip', targetId: 'wolf' };
  turn(m, b);
  assert(m.mechanic.attackMult(m, wolf) === 1.3, 'x1.3, not stacked');
  wolf.hp = 5;
  m.mechState.next = { action: 'whip', targetId: 'wolf' };
  r = turn(m, b);
  assert(wolf.alive && wolf.hp === 1 && r.steps[0].dmg === 4, 'cannot kill: ' + wolf.hp);
  wolf.hp = 200;
  const p = biteTarget(m, wolf);
  const php = p.hp;
  turn(m, wolf);
  assert(php - p.hp === Math.round(30 * 0.7 * 1.3), 'buffed bite ' + (php - p.hp));
  assert(m.mechState.whip === null && m.mechanic.attackMult(m, wolf) === 1, 'used up');
  return { buffed: php - p.hp };
}));

await test('處刑者囚籠：關在他站的地方（比他大一圈）；血量 40 × 人數；走不動、跳不起來、不會被擊退；自己往哪裡射（往前、往上、往後）都一出砲口就打在籠子上，自己不會被炸到；場上最多一個', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  m.mechState.next = { action: 'cage', targetId: 'p1' };
  const r = turn(m, b);
  const cage = m.enemies.find(e => e.kind === 'cage');
  const p1 = m.byId('p1');
  assert(steps(r)[0] === 'cage' && cage && cage.alive && cage.hp === 40 * 2 && cage.heldId === 'p1', 'cage ' + J(cage && cage.toState()));
  assert(Math.abs(cage.x - p1.x) < 1e-9 && cage.hw > p1.hw && cage.h > p1.h && p1.held, 'around p1, held');
  assert(cage.optional && cage.noTurn && cage.noKill && cage.fixed, 'optional, no turn, no kill, fixed');
  const x0 = p1.x;
  p1.moveDir = 1; p1.wantJump = true;
  for (let i = 0; i < 30; i++) m.step();
  assert(p1.x === x0 && p1.onGround, 'cannot walk or jump');
  p1.moveDir = 0;
  m.applyExplosion(p1.x - 20, p1.cy, { ...CONFIG.WEAPONS.cannon, damage: 1 }, m.byId('p2'), null);
  for (let i = 0; i < 30; i++) m.step();
  assert(Math.abs(p1.x - x0) < 1e-9, 'no knockback in the cage');
  // 自己開槍：往哪裡射都打在籠子上（第一個事件就是籠子），籠子扣武器的傷害，自己的血不變
  const hits = [];
  for (const [w, angle] of [['sniper', 0], ['sniper', 90], ['cannon', 150]]) {
    const hpc = cage.hp, hp1 = p1.hp;
    const shot = m.resolveShot(p1, w, angle, 60);
    const first = shot.events[0];
    assert(first && first.target === cage.id && first.f <= 2, `${w} ${angle}°: hits the cage at once: ` + J(shot.events.map(ev => [ev.f, ev.target || ev.type])));
    assert(hpc - cage.hp === CONFIG.WEAPONS[w].damage && p1.hp === hp1 && !(first.damages || []).some(d => d.id === p1.id), `${w} ${angle}°: cage -${hpc - cage.hp}, p1 ${hp1} → ${p1.hp}`);
    hits.push(hpc - cage.hp);
  }
  assert(Math.abs(p1.x - x0) < 1e-9 && p1.held, 'still in place');
  m.mechState.next = { action: 'cage', targetId: 'p2' };
  const r2 = turn(m, b);
  assert(steps(r2)[0] !== 'cage' && m.enemies.filter(e => e.kind === 'cage').length === 1, 'one cage at a time: ' + steps(r2));
  return { cageHp: cage.hp, hits };
}));

await test('囚籠：隊友打破 → 放出來（一波結算完就能走）；撐過 3 輪還關著 → 王的回合直接處刑（拖到斷頭台、一定砍中、秒殺）；神佑之石的無敵擋得住；被關的人倒下 → 籠子跟著消失', () => base(() => {
  // 打破
  let m = make(2);
  tough(m);
  m.mechState.next = { action: 'cage', targetId: 'p1' };
  turn(m, bossOf(m));
  let cage = m.enemies.find(e => e.kind === 'cage');
  m.applyExplosion(cage.x, cage.cy, { ...CONFIG.WEAPONS.sniper, damage: 9999, radius: 0 }, m.byId('p2'), cage, { directOnly: true });
  m.result();
  assert(!cage.alive && !m.byId('p1').held && !m.mechState.cage, 'broken → free');
  // 到期處刑
  m = make(2);
  tough(m);
  const b = bossOf(m);
  m.round = 3;
  m.mechState.next = { action: 'cage', targetId: 'p1' };
  turn(m, b);
  assert(cageRoundsLeft(m) === 3, 'left this round ' + cageRoundsLeft(m));
  m.round = 4;
  assert(cageRoundsLeft(m) === 3, 'next round: 3 left');
  let r = turn(m, b);
  assert(!steps(r).includes('execute') && r.next.action !== 'execute', 'one round in: not yet');
  m.round = 5;
  assert(cageRoundsLeft(m) === 2, 'two left');
  r = turn(m, b);
  assert(!steps(r).includes('execute') && r.next.action === 'execute' && r.next.targetId === 'p1', 'two rounds in: not yet; next = execute');
  m.round = 6;
  assert(cageRoundsLeft(m) === 1, 'last round');
  const cm = make(2);
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  r = turn(m, b);
  const ex = r.steps.find(s => s.action === 'execute');
  const p1 = m.byId('p1');
  const G = LEVELS.prisonYard.mechanic.guillotine;
  assert(ex && J(steps(r)) === J(['execute']) && !p1.alive && near(p1.x, G.x), 'executed at the guillotine: ' + J(steps(r)));
  assert(!m.enemies.some(e => e.kind === 'cage' && e.alive) && !m.mechState.cage, 'cage gone');
  const cp = cm.byId('p1');   // 客戶端：擺到斷頭台下再重播
  Object.assign(cp, { x: ex.x, y: ex.y, vx: 0, vy: 0, onGround: true });
  cm.byId(cm.mechState.cage.id).die('open');
  replayChecked(cm, ex.shot, 'execute');
  // 無敵
  m = make(2);
  tough(m);
  m.round = 1;
  m.mechState.next = { action: 'cage', targetId: 'p1' };
  turn(m, bossOf(m));
  m.round = 4;
  m.byId('p1').shield = 1;
  r = turn(m, bossOf(m));
  assert(steps(r)[0] === 'execute' && m.byId('p1').alive && m.byId('p1').shield === 0, 'shield blocks the blade');
  // 被關的人倒下
  m = make(2);
  tough(m);
  m.mechState.next = { action: 'cage', targetId: 'p2' };
  turn(m, bossOf(m));
  cage = m.enemies.find(e => e.kind === 'cage');
  m.byId('p2').die('hit');
  m.result();
  assert(!cage.alive && cage.deathCause === 'open' && !m.mechState.cage, 'cage vanishes with its prisoner');
  return { executed: ex.targetId };
}));

await test('棕熊護主：場上有囚籠 → 走到囚籠靠玩家那一邊擋著；到牠下一回合為止受傷 ×0.7；熊掌拍擊打最近的人（35 × 0.7、擊退）', () => base(() => {
  const m = make(3);
  tough(m);
  const b = bossOf(m);
  releaseNext(m); m.byId('wolf').die('hit'); turn(m, b);
  releaseNext(m);
  const bear = m.byId('bear');
  bear.dormant = false;
  for (const e of m.enemies) if (e.kind === 'cage' && e.alive) e.die('open');
  m.result();
  m.mechState.next = { action: 'cage', targetId: 'p3' };
  m.byId('p3').x = 600; m.settle(200);
  turn(m, b);
  const cage = m.enemies.find(e => e.kind === 'cage' && e.alive);
  assert(cage && cage.heldId === 'p3', 'p3 caged at 600');
  m.mechState.beastNext.bear = { action: 'guard' };
  const r = turn(m, bear);
  assert(r.steps[0].action === 'guard' && m.mechState.guard === 'bear', 'guard');
  assert(bear.x < cage.x && Math.abs(bear.x - cage.x) < cage.hw + bear.hw + 10, `between the players and the cage: bear ${bear.x}, cage ${cage.x}`);
  assert(m.mechanic.defenseMult(m, bear) === 0.7, 'x0.7');
  m.mechState.beastNext.bear = { action: 'swipe' };
  const t = m.players.filter(p => p.alive).reduce((a, e) => (Math.hypot(e.cx - bear.cx, e.cy - bear.cy) < Math.hypot(a.cx - bear.cx, a.cy - bear.cy) ? e : a));
  const hp0 = t.hp, x0 = t.x;
  const r2 = turn(m, bear);
  assert(r2.steps[0].action === 'swipe' && r2.steps[0].targetId === t.id && hp0 - t.hp === Math.round(35 * 0.7), 'swipe nearest ' + J([r2.steps[0].targetId, hp0 - t.hp]));
  assert(m.mechState.guard === null, 'guard over');
  assert(t.held ? t.x === x0 : Math.abs(t.x - x0) > 40, `knocked back unless caged (${t.id} held ${t.held})`);
  return { bearX: Math.round(bear.x), cageX: Math.round(cage.x) };
}));

await test('劍齒虎：一放出來就標記血最少的人；飛撲時路上第一個人先被撲到（替他擋）；吃掉流血層數每層 +2；被標記的人倒下了改撲現在血最少的', () => base(() => {
  const m = make(3);
  tough(m);
  const b = bossOf(m);
  for (let k = 0; k < 2; k++) { releaseNext(m); m.enemies.filter(e => e.alive && e !== b && e.kind !== 'cage').forEach(e => e.die('hit')); turn(m, b); }
  const [p1, p2, p3] = m.players;
  p1.hp = 100; p2.hp = 4000; p3.hp = 4000;
  releaseNext(m);
  const tiger = m.byId('tiger');
  tiger.dormant = false;
  assert(m.mechState.beastNext.tiger.targetId === 'p1' && lowestPlayer(m).id === 'p1', 'marks the lowest: ' + J(m.mechState.beastNext.tiger));
  // p2 站在虎跟 p1 中間
  p1.x = 200; p2.x = 500; m.settle(200);
  p2.bleed = 5;
  const cm = make(3);
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  const hp2 = p2.hp, hp1 = p1.hp;
  const r = turn(m, tiger);
  const st = r.steps[0];
  assert(st.action === 'pounce' && st.targetId === 'p2' && st.markedId === 'p1' && st.eaten === 5, 'p2 blocks: ' + J({ t: st.targetId, m: st.markedId, e: st.eaten }));
  assert(hp2 - p2.hp === Math.round((45 + 5 * 2) * 0.7) && p2.bleed === 0 && p1.hp === hp1, `dmg ${hp2 - p2.hp}, bleed ${p2.bleed}`);
  replayChecked(cm, st.shot, 'pounce');
  p1.die('hit');
  assert(pounceTarget(m, { action: 'pounce', targetId: 'p1' }).id === lowestPlayer(m).id, 'falls back to the lowest');
  return { dmg: hp2 - p2.hp };
}));

await test('吊燈：打到就整盞掉下來，砸到下面的猛獸 60 × 攻擊者倍率、暈眩一回合（事件帶 stuns）；暈眩的回合不動、之後恢復；客戶端重播照樣掉下來、記下暈眩', () => base(() => {
  const m = make(2);
  tough(m);
  releaseNext(m);
  const wolf = m.byId('wolf');
  wolf.hp = 5000;
  const k = m.terrain.stalactites.findIndex(s => Math.abs(s.tip.x - wolf.x) < 30);
  assert(k >= 0, 'a chandelier over the wolf');
  const cm = make(2);
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  const p1 = m.byId('p1');
  const tip = m.terrain.stalactites[k].tip;
  const W = CONFIG.WEAPONS.sniper;
  const proj = makeProjectile(p1, W, tip.x, tip.y + 40, 0, -900);
  proj.spawn = 1;
  const hp0 = wolf.hp;
  const shot = { kind: 'weapon', actorId: p1.id, weapon: W.id, angle: 90, power: 50, facing: 1, actor: { x: p1.x, y: p1.y, vy: 0 }, ...m.resolveVolley(p1, W, [proj], 0) };
  const fall = shot.events.find(ev => (ev.falls || []).includes(k));
  const hit = shot.events.find(ev => ev.stuns && ev.stuns.includes('wolf'));
  assert(fall && hit && m.terrain.fallen.has(k), 'falls and stuns: ' + J(shot.events.map(ev => [ev.type, ev.falls, ev.stuns])));
  assert(hp0 - wolf.hp === 60, 'chandelier dmg ' + (hp0 - wolf.hp));
  assert(m.mechState.stuns.includes('wolf'), 'stun recorded');
  replayChecked(cm, shot, 'chandelier');
  assert(cm.terrain.fallen.has(k) && cm.mechState.stuns.includes('wolf'), 'client replays the fall and the stun');
  wolf.dormant = false;
  let r = turn(m, wolf);
  assert(r.steps[0].action === 'stunned' && !m.mechState.stuns.includes('wolf'), 'stunned turn');
  r = turn(m, wolf);
  assert(r.steps[0].action === 'bite', 'back to biting');
  return { k };
}));

await test('快照：放出來的猛獸、囚籠、王在不在台上、預定的招式、暈眩、掉下來的吊燈都重建得回來（新的 Match 套快照 = 一模一樣）', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  releaseNext(m);
  m.mechState.next = { action: 'cage', targetId: 'p2' };
  turn(m, b);
  m.terrain.dropStalactite(2); m.mechState.fallen.push(2);
  m.mechState.stuns.push('wolf');
  m.mechState.whip = 'wolf';
  const snap = JSON.parse(J(m.snapshot()));
  const cm = make(2);
  cm.applySnapshot(snap);
  const pick = (x) => { const { def, ...rest } = x.mechState; return J(rest); };
  assert(pick(cm) === pick(m), 'mechState: ' + pick(cm) + ' vs ' + pick(m));
  assert(cm.byId('wolf') && cm.enemies.some(e => e.kind === 'cage' && e.alive) && cm.byId('executioner').intangible, 'entities');
  assert(cm.entities.every(e => e.held === m.byId(e.id).held && e.intangible === m.byId(e.id).intangible) && cm.players.some(p => p.held), 'flags: ' + J(cm.entities.map(e => [e.id, e.held, e.intangible])));
  assert(cm.terrain.fallen.has(2), 'fallen chandelier');
  assert(J(cm.entities.map(e => e.id)) === J(m.entities.map(e => e.id)), 'same entity order');
  return { ids: cm.entities.map(e => e.id) };
}));

const LONG = { EXECUTIONER: { cageRounds: 60 }, BLEED: { pctPerPx: 0.001 } };
await test('裁判：全員 AI 代打打一整場（1 / 2 人、幾個種子；囚籠不處刑、流血少一點，才打得到最後）不出錯；王 / 猛獸的回合廣播帶每一招與狀態（state），紀錄 ai.turn 帶每一招、next；放猛獸的那一招記 spawns', () => base(() => withConfig(LONG, () => {
  const out = {};
  const seen = new Set();
  for (const [n, seed] of [[1, 1], [2, 2], [2, 3], [1, 4]]) {
    const players = mkPlayers(n);
    const m = new Match({ levelId: 'prisonYard', players, seed, stage: 5 });
    for (const p of m.players) { p.hp = p.maxHp = 3000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 5, stageCount: 10, isBoss: true, type: 'boss', levelId: 'prisonYard', levelName: '處刑監獄', cards: {} } });
    ref.start();
    for (const p of players) ref.setConnected(p.id, false);
    for (let k = 0; k < 4000 && ref.phase !== 'over'; k++) io.advance(500);
    const turns = io.log.filter(x => x.t === 'aiTurn' && x.boss);
    for (const t of turns) {
      assert(t.boss.state && typeof t.boss.state.released === 'number', 'state rides along');
      t.boss.steps.forEach(st => seen.add(st.action));
    }
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.boss);
    assert(recs.length === turns.length && recs.every((r, i) => J(r.boss.map(x => x.action)) === J(turns[i].boss.steps.map(st => st.action))), 'logged');
    const rel = recs.flatMap(r => r.boss).filter(x => x.action === 'release');
    assert(rel.every(x => Array.isArray(x.spawns) && x.spawns.length === 1), 'release logs spawns');
    out[`${n}p#${seed}`] = { result: ref.phase === 'over' ? io.log.find(x => x.t === 'gameOver').result : 'running', released: m.mechState.released, turns: turns.length };
  }
  assert(['release', 'descend', 'cleaver', 'cage', 'bite', 'swipe', 'pounce'].every(a => seen.has(a)), 'moves seen: ' + [...seen]);
  return { ...out, seen: [...seen].sort() };
})));

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

await test('真的 GameView：全員 AI 代打打一整場（每幀 update + render；囚籠不處刑）：沒有腳本錯誤；放猛獸、跳上跳下、囚籠都播得到；播完客戶端的狀態（mechState、角色位置 / 血量、碰不碰得到、被關住）跟伺服器一樣', () => base(() => withConfig(LONG, () => {
  const seen = new Set();
  const out = {};
  for (const seed of [2, 5]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'prisonYard', players, seed, stage: 5 });
    for (const p of m.players) { p.hp = p.maxHp = 2500; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 5, stageCount: 10, isBoss: true, type: 'boss', levelId: 'prisonYard', levelName: '處刑監獄', cards: {} } });
    ref.start();
    const view = new GameView(fakeCanvas());
    const tracks = [];
    view.music = { play(t) { tracks.push(t); }, setRate() {} };
    view.myId = 'p1';
    view.transport = { send() {} };
    const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
    feed();
    assert(view.mapView.type === 'prison', 'prison view');
    for (const p of players) ref.setConnected(p.id, false);
    const err = console.error;
    const errors = [];
    console.error = (...a) => errors.push(a.join(' '));
    let hiddenRun = false, airborne = false, hudOk = false;
    try {
      for (let k = 0; k < 3000 && ref.phase !== 'over'; k++) {
        io.advance(250);
        for (const t of io.log.filter(x => x.t === 'aiTurn' && x.boss)) t.boss.steps.forEach(st => seen.add(st.action));
        feed();
        for (let f = 0; f < 15; f++) {
          view.update(CONFIG.FIXED_DT);
          view.render();
          const c = view.mapCtx;
          if (c.state.running && view.mapView.drawEntityBare(fakeCtx2d(), c, view.match.byId(c.state.running))) hiddenRun = true;
          const b = view.match.byId('executioner');
          if (c.state.fx && (c.state.fx.action === 'release' || c.state.fx.action === 'descend') && view.mapView.drawEntityBare(fakeCtx2d(), c, b)) airborne = true;
          const hud = view.mapView.hud(c, ['x', '#fff']);
          if (b.alive && /^處刑官 \d+ \/ \d+/.test(hud[1][0]) && /^下一招：/.test(hud[2] ? hud[2][0] : '')) hudOk = true;
        }
      }
      feed();
      for (let f = 0; f < 2400; f++) view.update(CONFIG.FIXED_DT);
    } finally { console.error = err; }
    assert(!errors.length, 'script errors ' + errors[0]);
    assert(hiddenRun && airborne && hudOk, `running hidden ${hiddenRun} / airborne ${airborne} / hud ${hudOk}`);
    const pick = (x) => { const { def, ...rest } = x.mechState; return J(rest); };
    assert(pick(view.match) === pick(m), 'mechState synced:\n' + pick(view.match) + '\n' + pick(m));
    for (const e of m.entities) {
      const v = view.match.byId(e.id);
      assert(v && v.alive === e.alive && (!e.alive || (Math.abs(v.x - e.x) < 0.01 && Math.abs(v.y - e.y) < 0.01 && v.hp === e.hp)), `${e.id} synced: ${J(v && [v.x, v.y, v.hp, v.alive])} vs ${J([e.x, e.y, e.hp, e.alive])}`);
      assert(!v || (v.intangible === e.intangible && v.held === e.held), `${e.id} flags`);
    }
    assert(tracks.filter(Boolean).every(t => t === 'scorpion'), 'boss music ' + [...new Set(tracks)]);
    out[seed] = ref.phase === 'over' ? 'over' : 'running';
  }
  assert(['release', 'descend', 'cage', 'bite'].every(a => seen.has(a)), 'played: ' + [...seen]);
  return { ...out, seen: [...seen].sort() };
})));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
