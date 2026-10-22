// node test/prison.js
// 2026-10-19：Boss 關「處刑監獄」的處刑官（hp 400、菜刀丟擲（2026-10-22 起每死一隻召喚獸多丟一個人）、訓獸者皮鞭、處刑者囚籠 → 斷頭台、80 / 60 / 40% 跳上處刑台打開牢房、
// 召喚獸全倒 → 哭兩回合 → 暴怒流星錘）與三隻猛獸（惡狼撕咬先咬流血的人（只咬一個）、棕熊熊掌拍擊 / 護主、
// 劍齒虎撲咬所有流血的人（2026-10-22 起；沒人流血 → 撲標記的血最少的人，路上的人先被撲到）、吃掉流血層數）、
// 天花板的吊燈（打下來砸人、砸到敵人暈眩一回合）。
// 地圖（Boss 池、地面與天花板炸不壞、處刑台跳不上去）、血量門檻（停在門檻、等他的回合跳上去）、在台上打不到、放出來的猛獸這一輪不動、
// 猛獸一倒下就馬上跳下來（2026-10-22 起不等他的回合：被打死、回合結束被燒死都是；客戶端照同一個條件自己推、畫跳下來的弧線、紀錄記 descend）、
// 皮鞭（-20、最多剩 1 血、下一次攻擊 ×1.3、不疊加、用掉就沒了）、
// 囚籠（血量 40 × 人數、關在他站的地方、走不動 / 跳不起來 / 不會被擊退、自己往哪裡射都打在籠子上而且傷不到自己、隊友打破就放出來、撐過 3 輪 → 處刑（拖到斷頭台、一定砍中）、
// 無敵擋得住、被關的人倒下籠子跟著消失、場上最多一個）、熊護主（擋到囚籠靠玩家那邊、受傷 ×0.7 到牠下一回合）、
// 虎（流血的人全撲、直直撲過去；沒人流血撲標記血最少的人、路上的人先被撲到；流血每層 +2 並吃掉；皮鞭只加第一撲）、哭（×1.5、不行動、兩回合）→ 暴怒（紅眼 + 流星錘 50、擊退 200）、
// 吊燈（打到 / 炸到就掉、砸到猛獸暈眩、暈眩的回合不動）、客戶端照事件重播一致、快照重建、裁判流程與紀錄、真的 GameView 播一段
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { makeProjectile } from '../shared/physics/weapons.js';
import { cageRoundsLeft, pounceTarget, pounceTargets, cleaverCount, tigerForecast, lowestPlayer, biteTarget, prisonState, isBeast, planExecNext } from '../shared/maps/prison.js';
import { prison as prisonView } from '../client/map-views/prison.js';
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

// 處刑官站回出生的地方（地上、打得到）
const LANDING = LEVELS.prisonYard.mechanic.boss;
const isDown = (m) => { const b = bossOf(m); return !m.mechState.up && !b.intangible && near(b.x, LANDING.x) && Math.abs(b.y - LANDING.y) < 2 && b.onGround; };
const pick = (x) => { const { def, ...rest } = x.mechState; return J(rest); };

await test('放出來的猛獸一倒下（一波結算完 / 勝負判定前的連帶）→ 馬上跳下處刑台（打得到了），他的回合不用再跳；預定鞭牠的那一招作廢；再打到 60% → 從地上跳上去打開牢房 II（棕熊），40% → 牢房 III（劍齒虎）；三隻都倒下 → 馬上跳下來坐在地上哭（下一招 = 哭）', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  releaseNext(m);
  assert(m.mechState.up && b.intangible, 'up with the wolf');
  m.mechState.next = { action: 'whip', targetId: 'wolf' };
  m.byId('wolf').die('hit');
  assert(m.result() === null, 'not over');
  assert(isDown(m) && m.mechState.mood === 'calm', `down at once: ${b.x}, ${b.y}`);
  assert(m.mechState.next === null, 'whip on the dead wolf dropped: ' + J(m.mechState.next));
  const again = pick(m);
  m.result();
  assert(pick(m) === again, 'cascade again: nothing changes');
  let r = turn(m, b);
  assert(!steps(r).includes('descend') && !steps(r).includes('release'), 'no descend on his own turn: ' + steps(r));
  r = releaseNext(m);
  assert(steps(r)[0] === 'release' && r.steps[0].spawns[0].id === 'bear' && m.byId('bear') && near(r.steps[0].x0, LANDING.x), 'jumps up from the ground for the bear');
  m.byId('bear').die('hit');
  m.result();
  assert(isDown(m), 'down after the bear');
  r = releaseNext(m);
  assert(r.steps[0].spawns[0].id === 'tiger' && b.hpFloor === 0, 'tiger out, no more floors');
  m.byId('tiger').die('hit');
  m.result();
  assert(isDown(m) && m.mechState.mood === 'cry' && m.mechState.cryLeft === CONFIG.EXECUTIONER.cryTurns, 'cries at once: ' + J([m.mechState.mood, m.mechState.cryLeft]));
  assert(m.mechState.next && m.mechState.next.action === 'cry', 'next = cry: ' + J(m.mechState.next));
  r = turn(m, b);
  assert(J(steps(r)) === J(['cry']), 'his turn: just cry ' + steps(r));
  return { released: m.mechState.released, at: [Math.round(b.x), Math.round(b.y)] };
}));

await test('保險：輪到他時還在台上、沒有猛獸（照理不會發生：猛獸倒下時就跳了）→ 這一回合先補一招跳下處刑台；血量已經到下一個門檻 → 跳下來再跳上去打開下一間', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  releaseNext(m);
  m.byId('wolf').die('hit');   // 不叫 cascade
  let r = turn(m, b);
  assert(steps(r)[0] === 'descend' && isDown(m) && r.steps[0].x0 < LANDING.x, 'descend step: ' + steps(r));
  releaseNext(m);
  m.byId('bear').die('hit');
  hitBoss(m, 99999);
  r = turn(m, b);
  assert(J(steps(r).slice(0, 2)) === J(['descend', 'release']) && r.steps[1].spawns[0].id === 'tiger' && m.mechState.up, 'descend then release: ' + steps(r));
}));

await test('猛獸在自己的回合結束被燒死 → 回合結束的效果帶 descend（紀錄 turn.end 記得到），處刑官馬上跳下來', () => base(() => {
  const m = make(2);
  tough(m);
  releaseNext(m);
  const wolf = m.byId('wolf');
  wolf.hp = 1; wolf.burn = 100; wolf.movedThisTurn = 0;
  const fx = m.endTurn(wolf);
  assert(!wolf.alive && fx.some(f => f.type === 'burn'), 'burnt to death ' + J(fx));
  const d = fx.find(f => f.type === 'descend');
  assert(d && d.id === 'executioner' && d.x0 < d.x && isDown(m), 'descend fx ' + J(fx));
  m.result();
  assert(isDown(m), 'still down');
}));

await test('玩家一波打死猛獸：打倒牠的那一下就跳下來（事件帶 descend），同一波後面的砲彈打得到落地的他；角色狀態裡的處刑官在地上、紀錄記得到；客戶端重播到那一下就推出一樣的狀態；只有之前的快照 + 結果（沒看到重播）也推得出一樣的', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  releaseNext(m);
  const wolf = m.byId('wolf');
  wolf.hp = 1;
  const hp0 = b.hp;
  const snapUp = JSON.parse(J(m.snapshot()));
  const cm = make(2);
  cm.applySnapshot(snapUp);
  const p1 = m.byId('p1');
  const W = CONFIG.WEAPONS.sniper;
  const kill = makeProjectile(p1, W, wolf.cx, wolf.cy - 60, 0, 900);
  kill.spawn = 1;
  const after = makeProjectile(p1, W, LANDING.x, LANDING.y - b.h - 60, 0, 900);   // 第 20 幀才出現、正對他落地的地方往下打（在台上的話打不到）
  after.spawn = 20;
  const shot = JSON.parse(J({ kind: 'weapon', actorId: p1.id, weapon: W.id, angle: -90, power: 50, facing: 1, actor: { x: p1.x, y: p1.y, vy: 0 }, ...m.resolveVolley(p1, W, [kill, after], 0, true) }));
  assert(!wolf.alive && shot.kills.includes('wolf'), 'wolf shot dead ' + J(shot.kills));
  const ev = shot.events.find(e => e.descend);
  assert(ev && ev.damages.some(d => d.id === 'wolf') && near(ev.descend.x, b.x) && ev.descend.y0 < ev.descend.y && !shot.descend, 'descend on the killing event ' + J(ev && ev.descend));
  const hitAfter = shot.events.find(e => e.f > ev.f && (e.damages || []).some(d => d.id === 'executioner' && d.dmg > 0));
  assert(isDown(m) && hitAfter && b.hp < hp0, `the later shot hits him on the ground: ${hp0} -> ${b.hp}`);
  const rs = shot.results.find(s => s.id === 'executioner');
  assert(near(rs.x, b.x) && near(rs.y, b.y) && rs.hp === b.hp, 'results carry where he landed');
  replayChecked(cm, shot, 'kill the wolf');
  assert(isDown(cm) && cm.byId('executioner').hp === b.hp, 'client: down by the replay itself');
  cm.applyEntities(shot.results);
  assert(pick(cm) === pick(m), 'mechState ' + pick(cm) + ' vs ' + pick(m));
  assert(cm.entities.every(e => e.intangible === m.byId(e.id).intangible), 'intangible');
  const early = make(2);   // 只有開火前的快照 + 結果（例如重連時沒看到這一發的重播）：同一個條件推得出一樣的
  early.applySnapshot(snapUp);
  early.applyEntities(shot.results);
  early.mechanic.cascade(early);
  assert(pick(early) === pick(m) && isDown(early), 'derived from results: ' + pick(early));
  const rebuilt = make(2);
  rebuilt.applySnapshot(JSON.parse(J(m.snapshot())));
  assert(pick(rebuilt) === pick(m) && isDown(rebuilt), 'snapshot after the drop rebuilds');
  return { x: Math.round(b.x), y: Math.round(b.y), hp: [hp0, b.hp] };
}));

await test('王已經倒下了（在台上被燒死）、最後一隻猛獸才倒下 → 不搬、不哭，贏了', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  for (let k = 0; k < 2; k++) { releaseNext(m); m.enemies.filter(e => isBeast(e) && e.alive).forEach(e => e.die('hit')); m.result(); }
  releaseNext(m);
  const x0 = b.x, y0 = b.y;
  b.die('hit');
  m.byId('tiger').die('hit');
  assert(m.result() === 'win', 'win');
  assert(b.x === x0 && b.y === y0 && m.mechState.mood !== 'cry' && m.mechState.up, 'a dead boss does not move or cry');
}));

await test('哭：受到的傷害 ×1.5、自己的回合什麼都不做（兩回合）→ 暴怒站起來 + 流星錘（隨機一人 50 × 0.7、擊退 200）；之後照暴怒的招式（沒有皮鞭）', () => base(() => {
  const m = make(2);
  tough(m);
  const b = bossOf(m);
  for (let k = 0; k < 3; k++) { releaseNext(m); m.enemies.filter(e => e.alive && e !== b).forEach(e => e.die('hit')); m.result(); }
  let r = turn(m, b);
  assert(J(steps(r)) === J(['cry']), 'first cry ' + steps(r));
  const hp0 = b.hp;
  const dm = m.applyExplosion(b.x, b.cy, { ...CONFIG.WEAPONS.sniper, damage: 20, radius: 0 }, m.players[0], b, { directOnly: true });
  assert(dm.find(d => d.id === b.id).dmg === 30 && hp0 - b.hp === 30, 'x1.5 while crying: ' + J(dm));
  r = turn(m, b);
  assert(J(steps(r)) === J(['cry']) && r.next.action === 'rage', 'second cry, rage next');
  m.players.forEach((p, i) => { p.x = 400 + i * 80; });   // 站到場中間（貼著左邊的牆就飛不遠，看不出擊退）
  m.settle(200);
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

await test('菜刀丟擲：本來丟一個人，每死一隻召喚獸多丟一個人（不同的人、最多活著的人數）；抽下一招時就抽好要丟誰（targetIds），之後又死了召喚獸 → 丟的時候隨機補；每把 20 × 0.7 + 10 層流血、一定打中、間隔幾幀出手；客戶端重播一致；HUD 寫丟幾把、丟誰', () => base(() => {
  const m = make(4);
  tough(m);
  const b = bossOf(m);
  const S = m.mechState;
  const hud = () => prisonView.hud({ match: m }, ['x', '#fff']).map(l => l[0]).find(t => t.startsWith('下一招：'));
  const throwNow = (plan) => {
    for (const p of m.players) p.bleed = 0;
    for (const e of m.enemies) if (e.kind === 'cage' && e.alive) e.die('hit');
    m.result();
    S.next = plan;
    const hp = new Map(m.players.map(p => [p.id, p.hp]));
    const snap = JSON.parse(J(m.snapshot()));
    const r = turn(m, b);
    const st = r.steps.find(s => s.action === 'cleaver');
    assert(st, 'threw cleavers: ' + steps(r));
    const ids = st.targetIds;
    assert(ids[0] === st.targetId && new Set(ids).size === ids.length, 'distinct targets ' + J(ids));
    const W = CONFIG.WEAPONS.execCleaver;
    for (const p of m.players) {
      const hit = ids.includes(p.id);
      assert(hit ? hp.get(p.id) - p.hp === Math.round(W.damage * 0.7) && p.bleed === W.bleed : hp.get(p.id) === p.hp && !p.bleed, `${p.id} ${hit ? 'hit' : 'missed'}: ${hp.get(p.id) - p.hp} / ${p.bleed}`);
    }
    const spawns = st.shot.projectiles.map(q => q.spawn);
    assert(J(spawns) === J(ids.map((_, k) => 1 + k * CONFIG.EXECUTIONER.cleaverGap)), 'one after another ' + J(spawns));
    const cm = make(4);
    cm.applySnapshot(snap);
    replayChecked(cm, st.shot, 'cleavers');
    return ids;
  };
  assert(cleaverCount(m) === 1, 'nothing dead: one');
  releaseNext(m);
  assert(cleaverCount(m) === 1, 'wolf out: still one');
  let ids = throwNow({ action: 'cleaver', targetId: 'p3', targetIds: ['p3'] });
  assert(J(ids) === J(['p3']), 'one cleaver at the planned one ' + J(ids));
  m.byId('wolf').die('hit');
  m.result();
  assert(cleaverCount(m) === 2, 'wolf dead: two');
  S.next = { action: 'cleaver', targetId: 'p2', targetIds: ['p2'] };   // 狼倒下之前抽的（一把）
  assert(hud() === '下一招：菜刀丟擲 ×2 → P2＋隨機 1 人', 'hud ' + hud());
  ids = throwNow({ action: 'cleaver', targetId: 'p2', targetIds: ['p2'] });
  assert(ids.length === 2 && ids[0] === 'p2', 'planned one + a random one ' + J(ids));
  let plan = null;
  for (let k = 0; k < 60 && !plan; k++) { planExecNext(m); if (S.next.action === 'cleaver') plan = S.next; }
  assert(plan && plan.targetIds.length === 2 && plan.targetId === plan.targetIds[0] && new Set(plan.targetIds).size === 2, 'planned two ' + J(plan));
  assert(hud() === `下一招：菜刀丟擲 ×2 → ${plan.targetIds.map(id => m.byId(id).name).join('、')}`, 'hud ' + hud());
  releaseNext(m);
  m.byId('bear').die('hit');
  m.result();
  assert(cleaverCount(m) === 3, 'bear dead too: three');
  ids = throwNow({ action: 'cleaver', targetId: 'p1', targetIds: ['p1', 'p4', 'p2'] });
  assert(J(ids) === J(['p1', 'p4', 'p2']), 'three planned ' + J(ids));
  m.byId('p4').die('hit');
  ids = throwNow({ action: 'cleaver', targetId: 'p1', targetIds: ['p4', 'p1', 'p2'] });
  assert(ids.length === 3 && ids[0] === 'p1' && ids[1] === 'p2' && !ids.includes('p4'), 'a fallen one is replaced ' + J(ids));
  // 兩個人：最多兩把
  const m2 = make(2);
  tough(m2);
  for (let k = 0; k < 2; k++) { releaseNext(m2); m2.enemies.filter(e => isBeast(e) && e.alive).forEach(e => e.die('hit')); m2.result(); }
  assert(cleaverCount(m2) === 2, 'capped by players alive: ' + cleaverCount(m2));
  return { last: ids };
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

// 第三間牢房（劍齒虎）放出來、這一輪就輪到牠（三個人，p1 血最少）
function tigerOut(n = 3) {
  const m = make(n);
  tough(m);
  const b = bossOf(m);
  for (let k = 0; k < 2; k++) { releaseNext(m); m.enemies.filter(e => e.alive && e !== b && e.kind !== 'cage').forEach(e => e.die('hit')); m.result(); }
  for (const e of m.enemies) if (e.kind === 'cage' && e.alive) e.die('hit');
  m.result();
  m.players[0].hp = 100;
  releaseNext(m);
  for (const e of m.enemies) if (e.kind === 'cage' && e.alive) e.die('hit');
  m.result();
  for (const p of m.players) p.bleed = 0;
  const tiger = m.byId('tiger');
  tiger.dormant = false;
  return { m, tiger };
}

await test('劍齒虎（沒人流血）：一放出來就標記血最少的人、撲他一個；路上第一個人先被撲到（替他擋）；被標記的人倒下了改撲現在血最少的', () => base(() => {
  const { m, tiger } = tigerOut();
  const [p1, p2] = m.players;
  assert(m.mechState.beastNext.tiger.targetId === 'p1' && lowestPlayer(m).id === 'p1', 'marks the lowest: ' + J(m.mechState.beastNext.tiger));
  assert(J(pounceTargets(m, m.mechState.beastNext.tiger).map(e => e.id)) === J(['p1']), 'nobody bleeds: just the marked one');
  // p2 站在虎跟 p1 中間
  p1.x = 200; p2.x = 500; m.players[2].x = 120; m.settle(200);
  const cm = make(3);
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  const hp2 = p2.hp, hp1 = p1.hp;
  const r = turn(m, tiger);
  assert(r.steps.length === 1, 'one pounce: ' + steps(r));
  const st = r.steps[0];
  assert(st.action === 'pounce' && st.targetId === 'p2' && st.markedId === 'p1' && !st.eaten, 'p2 blocks: ' + J({ t: st.targetId, m: st.markedId, e: st.eaten }));
  assert(hp2 - p2.hp === Math.round(45 * 0.7) && p1.hp === hp1, `dmg ${hp2 - p2.hp}`);
  replayChecked(cm, st.shot, 'pounce');
  p1.die('hit');
  assert(pounceTarget(m, { action: 'pounce', targetId: 'p1' }).id === lowestPlayer(m).id, 'falls back to the lowest');
  return { dmg: hp2 - p2.hp };
}));

await test('劍齒虎（有人流血）：撲咬所有流血的人（一個撲完再撲下一個、先撲近的，直直撲過去、路上的人擋不到；標記的人沒流血就不撲他），每一撲吃掉那個人的流血層數、每層 +2；客戶端照每一撲重播一致；皮鞭的加成只加在第一撲', () => base(() => {
  const { m, tiger } = tigerOut(4);
  const [p1, p2, p3, p4] = m.players;
  p1.x = 40; p2.x = 200; p3.x = 480; p4.x = 760; tiger.x = 950; m.settle(200);
  p2.bleed = 5; p3.bleed = 3; p4.bleed = 2;
  assert(J(pounceTargets(m, m.mechState.beastNext.tiger).map(e => e.id)) === J(['p2', 'p3', 'p4']), 'all the bleeding ones');
  m.mechState.whip = 'tiger';
  const snap = JSON.parse(J(m.snapshot()));
  const hp = new Map(m.players.map(p => [p.id, p.hp]));
  const r = turn(m, tiger);
  assert(J(steps(r)) === J(['pounce', 'pounce', 'pounce']), 'three pounces: ' + steps(r));
  assert(J(r.steps.map(s => s.targetId)) === J(['p4', 'p3', 'p2']), 'nearest first: ' + J(r.steps.map(s => s.targetId)));
  const dmg = (id) => hp.get(id) - m.byId(id).hp;
  assert(dmg('p4') === Math.round((45 + 2 * 2) * 0.7 * 1.3) && dmg('p3') === Math.round((45 + 3 * 2) * 0.7) && dmg('p2') === Math.round((45 + 5 * 2) * 0.7) && dmg('p1') === 0,
    'dmg ' + J(m.players.map(p => [p.id, dmg(p.id)])));
  assert(m.players.every(p => !p.bleed) && J(r.steps.map(s => s.eaten)) === J([2, 3, 5]) && m.mechState.whip === null, 'bleed eaten, whip used');
  // 客戶端照每一撲重播（每一撲的結果帶撲完的位置與吃掉的流血）
  const cm = make(4);
  cm.applySnapshot(snap);
  for (const st of r.steps) {
    replayChecked(cm, st.shot, 'pounce ' + st.targetId);
    cm.applyEntities(st.shot.results);
    const t = cm.byId('tiger');
    assert(near(t.x, st.x) && near(t.y, st.y) && !cm.byId(st.targetId).bleed, 'after ' + st.targetId);
  }
  // 沒流血的人站在虎跟流血的人中間也擋不到
  const { m: m2, tiger: t2 } = tigerOut(3);
  const [q1, q2, q3] = m2.players;
  q1.x = 160; q2.x = 400; q3.x = 40; t2.x = 950; m2.settle(200);
  q1.bleed = 4;
  const hq2 = q2.hp;
  const r2 = turn(m2, t2);
  assert(r2.steps.length === 1 && r2.steps[0].targetId === 'p1' && !r2.steps[0].markedId && q2.hp === hq2 && !q1.bleed, 'straight to the bleeding one: ' + J(r2.steps.map(s => [s.targetId, s.markedId])));
  return { dmg: m.players.map(p => dmg(p.id)) };
}));

await test('劍齒虎的預告（準星、HUD）：玩家回合照處刑官預定的菜刀預告（正在流血的人到時候已經止血了，不算）、預定之後又死了召喚獸多的那幾把寫隨機；處刑官出完手 / 輪到虎才看現在誰在流血；預定的不是菜刀、處刑官被砸暈 → 標記的人；虎被砸暈 → 不撲；預告的就是虎真的撲的人', () => base(() => {
  const { m, tiger } = tigerOut(4);
  const b = bossOf(m);
  const S = m.mechState;
  const [p1] = m.players;
  const ids = (fc) => J(fc.targets.map(e => e.id));
  const hudLine = (currentId, state = {}) => prisonView.hud({ match: m, currentId, state }, ['x', '#fff']).map(l => l[0]).find(t => t.startsWith('劍齒虎：'));
  S.next = { action: 'cleaver', targetId: 'p2', targetIds: ['p2', 'p3', 'p4'] };
  p1.bleed = 5;   // 玩家回合裡正在流血：他自己的回合結束就止血了
  let fc = tigerForecast(m, false);
  assert(fc.why === 'cleaver' && ids(fc) === J(['p2', 'p3', 'p4']) && fc.extra === 0, 'players\' turn: the cleaver targets ' + J(fc));
  assert(hudLine('p1') === '劍齒虎：飛撲 → P2、P3、P4（菜刀砍到、流血的人全撲）', 'hud ' + hudLine('p1'));
  p1.bleed = 0;
  // 輪到處刑官、還沒出手：一樣照預定的菜刀
  assert(hudLine('executioner', { execDone: false }) === hudLine('p1'), 'exec turn, not yet thrown');
  const rb = turn(m, b);
  const st = rb.steps.find(s => s.action === 'cleaver');
  assert(st && J(st.targetIds) === J(['p2', 'p3', 'p4']), 'threw as planned ' + J(rb.steps.map(s => [s.action, s.targetIds])));
  fc = tigerForecast(m, true);
  assert(fc.why === 'bleeding' && ids(fc) === J(['p2', 'p3', 'p4']), 'after the throw: who bleeds ' + J(fc));
  assert(hudLine('executioner', { execDone: true }) === '劍齒虎：飛撲 → P2、P3、P4（流血的人全撲）' && hudLine('tiger') === hudLine('executioner', { execDone: true }), 'hud ' + hudLine('tiger'));
  const rt = turn(m, tiger);
  assert(J(rt.steps.map(s => s.targetId).sort()) === ids(fc), 'pounced exactly the forecast ' + J(rt.steps.map(s => s.targetId)));
  // 預定的不是菜刀 → 標記的人（血最少的 P1）
  S.next = { action: 'whip', targetId: 'tiger' };
  fc = tigerForecast(m, false);
  assert(fc.why === 'marked' && ids(fc) === J([lowestPlayer(m).id]), 'whip planned: the marked one ' + J(fc));
  assert(hudLine('p2') === `劍齒虎：飛撲 → ${lowestPlayer(m).name}（沒人流血：撲標記的人）`, 'hud ' + hudLine('p2'));
  // 處刑官被砸暈（這一回合不出招）→ 標記的人
  S.next = { action: 'cleaver', targetId: 'p2', targetIds: ['p2', 'p3', 'p4'] };
  S.stuns.push('executioner');
  assert(tigerForecast(m, false).why === 'marked', 'exec stunned');
  S.stuns = [];
  // 狼、熊倒下之前抽的菜刀（只有一把）：多的兩把丟的時候才隨機挑
  S.next = { action: 'cleaver', targetId: 'p3', targetIds: ['p3'] };
  fc = tigerForecast(m, false);
  assert(ids(fc) === J(['p3']) && fc.extra === 2 && hudLine('p1') === '劍齒虎：飛撲 → P3＋隨機 2 人（菜刀砍到、流血的人全撲）', 'top-up ' + hudLine('p1'));
  // 虎被吊燈砸暈：不撲
  S.stuns.push('tiger');
  assert(tigerForecast(m, false).why === 'stunned' && tigerForecast(m, false).targets.length === 0 && hudLine('p1') === '劍齒虎：暈眩中', 'tiger stunned ' + hudLine('p1'));
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
  assert(pick(cm) === pick(m), 'mechState: ' + pick(cm) + ' vs ' + pick(m));
  assert(cm.byId('wolf') && cm.enemies.some(e => e.kind === 'cage' && e.alive) && cm.byId('executioner').intangible, 'entities');
  assert(cm.entities.every(e => e.held === m.byId(e.id).held && e.intangible === m.byId(e.id).intangible) && cm.players.some(p => p.held), 'flags: ' + J(cm.entities.map(e => [e.id, e.held, e.intangible])));
  assert(cm.terrain.fallen.has(2), 'fallen chandelier');
  assert(J(cm.entities.map(e => e.id)) === J(m.entities.map(e => e.id)), 'same entity order');
  return { ids: cm.entities.map(e => e.id) };
}));

const LONG = { EXECUTIONER: { cageRounds: 60 }, BLEED: { pctPerPx: 0.001 } };
const BEAST_IDS = ['wolf', 'bear', 'tiger'];
// 每一則 turn（每個回合開始，含敵人的）：處刑官在台上（腳底比地面高很多）就一定有一隻活著的猛獸（猛獸倒下馬上跳下來，不會留到下一個回合）；
// 數台上 → 地上（他還活著）幾次 = 跳下來幾次。他的回合不會再有「跳下處刑台」這一招
function scanTurns(msgs) {
  let prevUp = false, drops = 0;
  for (const x of msgs) {
    if (x.t === 'aiTurn' && x.boss) for (const s of x.boss.steps) assert(s.action !== 'descend', 'descend is no longer a boss step');
    if (x.t !== 'turn') continue;
    const ex = x.entities.find(e => e.id === 'executioner');
    const live = x.entities.filter(e => BEAST_IDS.includes(e.id) && e.alive);
    const up = !!ex && ex.alive && ex.y < 450;
    assert(!up || live.length === 1, `turn of ${x.actorId}: up with ${live.length} live beasts`);
    if (prevUp && ex && ex.alive && !up) drops++;
    prevUp = up;
  }
  return drops;
}
// 紀錄裡的跳下處刑台：打死猛獸的那一發（shot / 代打的 ai.turn）帶 descend、猛獸被燒死的 turn.end 的 fx 帶 descend
const loggedDrops = (records) => records.filter(r => ((r.ev === 'shot' || r.ev === 'ai.turn') && r.descend) || (r.ev === 'turn.end' && (r.fx || []).some(f => f.type === 'descend'))).length;

await test('裁判：全員 AI 代打打一整場（1 / 2 人、幾個種子；囚籠不處刑、流血少一點，才打得到最後）不出錯；王 / 猛獸的回合廣播帶每一招與狀態（state），紀錄 ai.turn 帶每一招、next；放猛獸的那一招記 spawns；猛獸一倒下就跳下來（回合開始時不會在台上卻沒有猛獸），每一次都記進紀錄', () => base(() => withConfig(LONG, () => {
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
    const drops = scanTurns(io.log);
    const logged = loggedDrops(io.records);
    assert(drops >= Math.min(2, m.mechState.released) && logged === drops, `drops ${drops} / logged ${logged} / released ${m.mechState.released}`);
    out[`${n}p#${seed}`] = { result: ref.phase === 'over' ? io.log.find(x => x.t === 'gameOver').result : 'running', released: m.mechState.released, drops, turns: turns.length };
  }
  assert(['release', 'cleaver', 'cage', 'bite', 'swipe', 'pounce'].every(a => seen.has(a)), 'moves seen: ' + [...seen]);
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
    const all = [];
    const feed = () => { for (const msg of io.log.splice(0)) { all.push(msg); view.onMessage(msg); } };
    feed();
    assert(view.mapView.type === 'prison', 'prison view');
    for (const p of players) ref.setConnected(p.id, false);
    const err = console.error;
    const errors = [];
    console.error = (...a) => errors.push(a.join(' '));
    let hiddenRun = false, airborne = false, hudOk = false, hops = 0, idleUp = 0;
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
          const jumping = (c.state.fx && (c.state.fx.action === 'release' || c.state.fx.action === 'descend')) || c.state.hop;
          if (jumping && view.mapView.drawEntityBare(fakeCtx2d(), c, b)) airborne = true;
          if (c.state.hop && c.state.hop.t === CONFIG.FIXED_DT) hops++;   // 剛起跳（跳了一步）
          // 沒在播出招動畫的時候：客戶端也不會在台上卻沒有猛獸（猛獸倒下的那一步就跳了）
          if (!c.state.fx && b.alive && view.match.mechState.up && !view.match.enemies.some(e => isBeast(e) && e.alive)) idleUp++;
          const hud = view.mapView.hud(c, ['x', '#fff']);
          if (b.alive && /^處刑官 \d+ \/ \d+/.test(hud[1][0]) && /^下一招：/.test(hud[2] ? hud[2][0] : '')) hudOk = true;
        }
      }
      feed();
      for (let f = 0; f < 2400; f++) view.update(CONFIG.FIXED_DT);
    } finally { console.error = err; }
    assert(!errors.length, 'script errors ' + errors[0]);
    assert(hiddenRun && airborne && hudOk, `running hidden ${hiddenRun} / airborne ${airborne} / hud ${hudOk}`);
    assert(pick(view.match) === pick(m), 'mechState synced:\n' + pick(view.match) + '\n' + pick(m));
    for (const e of m.entities) {
      const v = view.match.byId(e.id);
      assert(v && v.alive === e.alive && (!e.alive || (Math.abs(v.x - e.x) < 0.01 && Math.abs(v.y - e.y) < 0.01 && v.hp === e.hp)), `${e.id} synced: ${J(v && [v.x, v.y, v.hp, v.alive])} vs ${J([e.x, e.y, e.hp, e.alive])}`);
      assert(!v || (v.intangible === e.intangible && v.held === e.held), `${e.id} flags`);
    }
    assert(tracks.filter(Boolean).every(t => t === 'scorpion'), 'boss music ' + [...new Set(tracks)]);
    const drops = scanTurns(all);
    assert(drops > 0 && hops === drops && idleUp === 0, `drops ${drops} / client hops ${hops} / idle up without a beast ${idleUp}`);
    out[seed] = { phase: ref.phase === 'over' ? 'over' : 'running', drops };
  }
  assert(['release', 'cage', 'bite'].every(a => seen.has(a)), 'played: ' + [...seen]);
  return { ...out, seen: [...seen].sort() };
})));

const STAGE = { stage: 5, stageCount: 10, isBoss: true, type: 'boss', levelId: 'prisonYard', levelName: '處刑監獄', cards: {} };
const newView = () => { const v = new GameView(fakeCanvas()); v.music = { play() {}, setRate() {} }; v.myId = 'p1'; v.transport = { send() {} }; return v; };
// 從射手的砲口瞄向 (x, y) 的角度
const angleTo = (s, x, y) => { const mz = s.muzzle(); return Math.atan2(-(y - mz.y), x - mz.x) * 180 / Math.PI; };

await test('真的 GameView（單人）：P1 一槍打死惡狼 → 客戶端在播這一發的時候就畫處刑官沿弧線跳下來（橫幅合成一行），播完（還沒輪到他）狀態跟伺服器一樣、打得到、HUD 不再寫在處刑台上', () => base(() => {
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'prisonYard', players, seed: 3, stage: 5 });
  tough(m);
  m.mechState.next = { action: 'cleaver', targetId: 'p1' };   // 不要關 P1（籠子會吃掉這一發）
  releaseNext(m);
  const wolf = m.byId('wolf');
  wolf.hp = 1;
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: STAGE });
  ref.start();
  const view = newView();
  const banners = [];
  const showBanner = view.showBanner.bind(view);
  view.showBanner = (text, color) => { banners.push(text); return showBanner(text, color); };
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  const drain = () => { for (let f = 0; f < 2400 && (view.script || view.queue.length); f++) { view.update(CONFIG.FIXED_DT); view.render(); } };
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  let server, sawAir = false, hopped = false;
  try {
    for (let k = 0; k < 40 && !(ref.phase === 'turn' && ref.currentId === 'p1'); k++) { io.advance(250); feed(); drain(); }
    feed(); drain();
    assert(ref.currentId === 'p1' && ref.phase === 'turn', 'P1 turn');
    assert(view.match.mechState.up && view.match.byId('executioner').intangible, 'client: up');
    const p = m.byId('p1');
    let angle = null;
    for (const dy of [0, -8, 8, -16, 16]) {
      const mm = new Match({ levelId: 'prisonYard', players, seed: 3, stage: 5 });
      mm.applySnapshot(JSON.parse(J(m.snapshot())));
      const a = angleTo(mm.byId('p1'), wolf.cx, wolf.cy + dy);
      mm.resolveShot(mm.byId('p1'), 'sniper', a, 100);
      if (!mm.byId('wolf').alive) { angle = a; break; }
    }
    assert(angle !== null, 'found a killing shot');
    ref.handle('p1', { t: 'fire', weapon: 'sniper', angle, power: 100, x: p.x, y: p.y, facing: p.facing, stamina: p.stamina });
    assert(!wolf.alive && isDown(m), 'server: wolf dead, boss down');
    server = { state: pick(m), x: bossOf(m).x, y: bossOf(m).y };
    const shotMsg = io.log.find(x => x.t === 'shot');
    const d = shotMsg && (shotMsg.events.find(ev => ev.descend) || {}).descend;
    assert(d && !io.log.some(x => x.t === 'aiTurn'), 'only the shot so far, its killing event carrying descend');
    assert(io.records.some(r => r.ev === 'shot' && r.descend && r.descend.x0 === d.x0 && r.descend.y0 === d.y0), 'logged with the shot');
    feed();
    for (let f = 0; f < 2400 && (view.script || view.queue.length); f++) {
      view.update(CONFIG.FIXED_DT); view.render();
      const c = view.mapCtx;
      if (c.state.hop) {
        hopped = true;
        if (view.mapView.drawEntityBare(fakeCtx2d(), c, view.match.byId('executioner'))) sawAir = true;
      }
    }
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(hopped && sawAir, `client hop ${hopped} / drawn in the air ${sawAir}`);
  assert(banners.includes('惡狼倒下了！處刑官跳下處刑台') && !banners.includes('惡狼倒下了！'), 'one combined banner: ' + J(banners));
  const vb = view.match.byId('executioner');
  assert(pick(view.match) === server.state, 'client mechState\n' + pick(view.match) + '\n' + server.state);
  assert(near(vb.x, server.x, 0.01) && near(vb.y, server.y, 0.01) && !vb.intangible, `client boss ${vb.x},${vb.y} vs ${server.x},${server.y}`);
  const hud = view.mapView.hud(view.mapCtx, ['x', '#fff']);
  assert(!/處刑台上/.test(hud[1][0]), 'hud ' + hud[1][0]);
  return { at: [Math.round(vb.x), Math.round(vb.y)] };
}));

await test('真的 GameView：惡狼在自己的回合結束被燒死 → turnFx 帶 descend，客戶端照它的起點（處刑台上）跳下來；播完狀態跟伺服器一樣', () => base(() => {
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'prisonYard', players, seed: 3, stage: 5 });
  tough(m);
  m.mechState.next = { action: 'cleaver', targetId: 'p1' };
  releaseNext(m);
  const wolf = m.byId('wolf');
  wolf.hp = 1; wolf.burn = 100; wolf.dormant = false;
  m.mechState.next = { action: 'cleaver', targetId: 'p1' };   // 王這一回合不鞭牠（鞭了也打不死，只是少一個變數）
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: STAGE });
  ref.start();
  const view = newView();
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  let fxMsg = null, hopStart = null, sawAir = false;
  try {
    // P1 不動（超時），輪到王、再輪到惡狼：牠的回合結束被燒死
    for (let k = 0; k < 400 && !fxMsg; k++) {
      io.advance(250);
      fxMsg = io.log.find(x => x.t === 'turnFx' && x.fx.some(f => f.type === 'descend')) || null;
      feed();
      for (let f = 0; f < 15; f++) view.update(CONFIG.FIXED_DT);
    }
    assert(fxMsg && !wolf.alive && isDown(m), 'server: burnt, down, turnFx carries descend');
    const rec = io.records.find(r => r.ev === 'turn.end' && (r.fx || []).some(f => f.type === 'descend'));
    assert(rec && rec.actor === 'wolf', 'logged in turn.end ' + J(rec && rec.fx));
    for (let f = 0; f < 600; f++) {
      view.update(CONFIG.FIXED_DT); view.render();
      const c = view.mapCtx;
      if (c.state.hop && !hopStart) hopStart = { x0: c.state.hop.x0, y0: c.state.hop.y0 };
      if (c.state.hop && view.mapView.drawEntityBare(fakeCtx2d(), c, view.match.byId('executioner'))) sawAir = true;
      if (!view.script && !view.queue.length && !c.state.hop && f > 60) break;
    }
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  const d = fxMsg.fx.find(f => f.type === 'descend');
  assert(hopStart && near(hopStart.x0, d.x0) && near(hopStart.y0, d.y0) && d.y0 < d.y && sawAir, 'hop from the scaffold ' + J({ hopStart, d, sawAir }));
  assert(pick(view.match) === pick(m), 'client mechState\n' + pick(view.match) + '\n' + pick(m));
  const vb = view.match.byId('executioner');
  assert(near(vb.x, bossOf(m).x, 0.01) && near(vb.y, bossOf(m).y, 0.01) && !vb.intangible, 'client boss down');
}));

const JUMP_UP = 0.52;   // 放猛獸那一招落在處刑台上（JUMP.release[1] = 0.5）之後
await test('真的 GameView：狼已經倒下、王從地上跳上去放棕熊 → 客戶端在預兆裡（落在處刑台上之後、棕熊出來之前那幾幀）不會被當成猛獸倒下又跳下來', () => base(() => {
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'prisonYard', players, seed: 3, stage: 5 });
  tough(m);
  releaseNext(m);
  m.byId('wolf').die('hit');
  m.result();
  hitBoss(m, 99999);
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: STAGE });
  ref.start();
  const view = newView();
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  ref.setConnected('p1', false);
  let landed = 0, dropped = 0;
  for (let k = 0; k < 200; k++) {
    io.advance(250); feed();
    for (let f = 0; f < 15; f++) {
      view.update(CONFIG.FIXED_DT);
      const c = view.mapCtx, fx = c.state.fx, S = view.match.mechState;
      if (fx && fx.action === 'release' && fx.phase === 'cast' && fx.t / fx.cast > JUMP_UP) { landed++; if (!S.up || c.state.hop) dropped++; }
    }
    if (m.byId('bear') && !view.script && !view.queue.length) break;
  }
  assert(m.byId('bear') && landed > 0 && dropped === 0, J({ landed, dropped }));
  assert(view.match.mechState.up && view.match.byId('executioner').intangible, 'up with the bear');
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
