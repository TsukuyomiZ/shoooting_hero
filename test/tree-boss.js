// node test/tree-boss.js
// Boss 關「古樹之庭」的規則測試：地形（不可破壞的樹皮、碰不到樹幹）、血量放大、回合順序、四種招式、
// 召喚的優先權與上限、預定下一招（撞擊預告平面、召喚時保留、結算完才重新預定、快照同步、客戶端警示帶）、枯萎（通關）、燃燒、客戶端重播一致、重連重建樹妖、裁判流程、確定性
import { CONFIG } from '../shared/config.js';
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { Rng } from '../shared/rng.js';
import { planShot, hasLineOfSight } from '../shared/ai.js';
import { isEquippable } from '../shared/weapons.js';
import { replayChecked } from './replay-check.js';
import { validateCards } from '../shared/cards.js';
import { planeOf, planeCounts, chooseTreeAction, rollTreeAction, planTreeNext, resolveTreeTurn, spawnTreant, trunkLane } from '../shared/tree-boss.js';
import { mapViewFor } from '../client/map-views/index.js';

// 這裡的測試照武器原本傷害算敵人的攻擊；敵人傷害倍率（ENEMY.damageMult / damageMultLate）在 headless.js 另有專門測試
CONFIG.ENEMY.damageMult = 1;
CONFIG.ENEMY.damageMultLate = 1;

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
  broadcast(msg, exceptId) { this.log.push({ ...msg, _except: exceptId }); }
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
  clear() { this.log = []; }
}
function advanceUntil(io, pred, maxMs = 300_000) {
  const start = io.t;
  while (io.t - start < maxMs) {
    io.advance(100);
    if (pred()) return true;
  }
  return false;
}

const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
// 古樹之庭的測試戰鬥：玩家血量拉高（不受 config 影響），Boss 血量照 config
function garden(n = 1, { seed = 1, hp = 5000, stage = 6 } = {}) {
  const m = new Match({ levelId: 'treeGarden', players: mkPlayers(n), seed, stage });
  for (const p of m.players) { p.hp = p.maxHp = hp; }
  return m;
}
// 把角色放到某個平面上（x 處往下掉到地面）
function placeOn(m, e, x, y) { e.x = x; e.y = y; e.vx = 0; e.vy = 0; m.settle(600); }
const planeY = (m, i) => m.mechState.def.planes[i].y;
// 讓嘴巴閉上（直接呼叫 resolveTreeTurn 不會經過古樹的回合結束，所以會一直閉著）
function shutMouth(m) { m.byId('mouth').closedTurns = 1; }
// 暫時把權重改成只會出某一招（嘴巴要先閉上，不然召喚優先）
function force(action, fn) {
  const W = CONFIG.TREE_BOSS.weights;
  const saved = { ...W };
  for (const k of Object.keys(W)) W[k] = k === action ? 1 : 0;
  try { return fn(); } finally { Object.assign(W, saved); }
}
// 暫時改 TREE_BOSS 的設定（測機制用，不受使用者調 config 影響）
function withTree(patch, fn) {
  const T = CONFIG.TREE_BOSS;
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, T[k]]));
  Object.assign(T, patch);
  try { return fn(); } finally { Object.assign(T, saved); }
}
// 古樹出一個回合，回傳第一招（嘴巴閉著 / 單人時一回合就只有這一招）
function firstStep(m, eye) {
  const { steps } = resolveTreeTurn(m, eye);
  return steps[0];
}
// 暫時只會抽到某一招：照現在的站位重新預定下一招，再讓古樹出一個回合（嘴巴要先閉上，不然召喚優先）
function forcedStep(m, action) {
  return force(action, () => { planTreeNext(m, m.byId('eye')); return firstStep(m, m.byId('eye')); });
}


test('地圖：樹皮炸不掉、土炸得掉；角色走不過 maxX、碰不到樹幹；眼睛與嘴巴固定在樹上、半露在樹幹表面', () => {
  const m = garden(4);
  const t = m.terrain;
  const eye = m.byId('eye'), mouth = m.byId('mouth');
  assert(t.isHard(900, 300) && t.isHard(1000, 700), 'the tree is hard terrain');
  t.carve(900, 300, 60);
  assert(t.isHard(900, 300) && t.isSolid(900, 300), 'bark survives explosions');
  t.carve(300, 600, 20);
  assert(!t.isSolid(300, 600), 'soil is still destructible');
  // 眼睛 / 嘴巴左半邊露在外面、右半邊在樹皮裡（砲彈打得到）
  for (const e of [eye, mouth]) {
    assert(!t.isSolid(e.x - e.hw + 3, e.cy) && t.isSolid(e.x + e.hw - 3, e.cy), `${e.id} half embedded`);
  }
  // 開場：玩家分別站在各個平面上
  const planes = m.players.map(p => planeOf(m.mechState.def.planes, p));
  assert(planes.join() === '1,0,2,0' && m.players.every(p => p.onGround), 'spawn planes ' + planes);
  // 一直往右走：停在 maxX 前
  const p = m.players[1];
  placeOn(m, p, 500, 540);
  p.stamina = 1e9;
  p.moveDir = 1;
  for (let i = 0; i < 300; i++) m.step();
  p.moveDir = 0;
  assert(p.x <= m.level.maxX - p.hw && p.x > m.level.maxX - p.hw - 1 && p.x + p.hw < t.hardEdgeX(p.y - 5), 'blocked before the tree at x=' + p.x);
  assert(!m.applyPositionReport(p, { x: m.level.maxX, y: p.y, facing: 1, stamina: 0 }).ok, 'reported position past maxX is rejected');
  // 古樹的部位不受重力、不會被擊退
  const ey = eye.y;
  for (let i = 0; i < 120; i++) m.step();
  m.applyExplosion(eye.x - eye.hw, eye.cy, CONFIG.WEAPONS.cannon, p, null);
  m.settle(60);
  assert(eye.y === ey && eye.vx === 0 && eye.hp < eye.maxHp, 'eye stays put and takes splash damage');
  return { maxX: m.level.maxX, eyeHp: eye.hp };
});

test('平面一階一階跳得上去：地面 → 低台 → 中台 → 高台', () => {
  const m = garden(1);
  const p = m.players[0];
  const planes = m.mechState.def.planes;
  placeOn(m, p, 215, 540);   // 地面，低台右邊
  // 先跳，升到一半再往平台那邊移（太早往旁邊按，頭會撞到平台底部）
  const climb = (dir, want) => {
    p.stamina = p.maxStamina;
    p.wantJump = true;
    for (let i = 0; i < 90; i++) { p.moveDir = i >= 12 && i < 45 ? dir : 0; m.step(); }
    p.moveDir = 0;
    m.settle(120);
    return planeOf(planes, p) === want;
  };
  assert(planeOf(planes, p) === 0, 'start on the ground');
  assert(climb(-1, 1), 'jumped onto the low platform, at ' + p.x.toFixed(1) + ',' + p.y.toFixed(1));
  placeOn(m, p, 190, 480);
  assert(climb(1, 2), 'jumped onto the middle platform, at ' + p.x.toFixed(1) + ',' + p.y.toFixed(1));
  placeOn(m, p, 390, 420);
  assert(climb(1, 3), 'jumped onto the high platform, at ' + p.x.toFixed(1) + ',' + p.y.toFixed(1));
  return { top: { x: Math.round(p.x), y: Math.round(p.y) } };
});

test('血量：眼睛 / 樹妖照 config，每多一位玩家 +50%，不吃關數放大；玩家體力照 config', () => {
  const T = CONFIG.TREE_BOSS;
  for (const n of [1, 2, 4]) {
    const scale = 1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER * (n - 1);
    const m = garden(n, { stage: 6 });
    assert(m.byId('eye').maxHp === Math.round(T.eyeHp * scale), `${n}p eye hp`);
    assert(m.players.every(p => p.maxStamina === CONFIG.PLAYER.stamina && p.stamina === CONFIG.PLAYER.stamina), `${n}p stamina`);
    const b = firstStep(m, m.byId('eye'));
    assert(b.action === 'summon' && b.spawns.every(s => m.byId(s.id).maxHp === Math.round(CONFIG.TREANT.hp * scale)), `${n}p treant hp`);
  }
  const m = garden(1);
  const tr = m.byId(firstStep(m, m.byId('eye')).spawns[0].id);
  assert(tr.weapons.join() === 'treeSpear' && tr.moveSpeed === CONFIG.TREANT.moveSpeed && tr.ai.aimError === CONFIG.TREANT.aimError, 'treant uses TREANT config');
  assert(!isEquippable('treeSpear') && !isEquippable('treeTrunk') && !isEquippable('treeLeaf'), 'boss weapons are not equippable');
  assert(validateCards({ cards: [{ id: 'x', rarity: 'green', weapon: 'treeSpear' }] }).cards.length === 0, 'a card cannot hand out the spear');
});

test('回合順序：玩家 → 古樹之眼（嘴巴不會行動）→ 樹妖；剛召喚的樹妖下一輪才行動', () => withTree({ summonPerPlayer: 1, maxMinions: 4 }, () => {
  const m = garden(2);
  const order = [];
  let cur = null;
  for (let i = 0; i < 4; i++) { const a = m.nextActor(cur); order.push(a.id); cur = a.id; }
  assert(order.join() === 'p1,p2,eye,p1', 'order ' + order);
  const b = firstStep(m, m.byId('eye'));   // 古樹的回合召喚了 m1、m2（兩人 → 一次兩隻）
  assert(b.action === 'summon' && m.byId('m1').dormant && m.byId('m2').dormant, 'new treants are dormant');
  assert(m.nextActor('eye').id === 'p1', 'the new treants skip this round');
  const seq = [];
  cur = 'p1';   // 新的一輪已經從 p1 開始（繞回開頭時叫醒了樹妖）
  for (let i = 0; i < 5; i++) { const a = m.nextActor(cur); seq.push(a.id); cur = a.id; }
  assert(seq.join() === 'p2,eye,m1,m2,p1', 'next round the treants act after the tree: ' + seq);
  return { order, nextRound: seq };
}));

test('士兵召喚（單人）：嘴巴張著就一定召喚（最優先），一次 1 隻、只出這一招，樹妖滿了才改出別招；嘴巴閉著就不召喚', () => {
  const m = garden(1);
  const eye = m.byId('eye');
  const T = CONFIG.TREE_BOSS;
  eye.hp -= 100;   // 眼睛受傷也一樣是召喚優先
  const turns = [];
  for (let i = 0; i < T.maxMinions + 3; i++) turns.push(resolveTreeTurn(m, eye).steps);
  const acts = turns.map(s => s.map(x => x.action).join('+'));
  assert(acts.slice(0, T.maxMinions).every(a => a === 'summon') && acts.slice(T.maxMinions).every(a => !a.includes('summon')), 'one summon per turn until full: ' + acts);
  assert(turns.slice(0, T.maxMinions).every(s => s.length === 1 && s[0].spawns.length === 1), 'solo: 1 treant per summon, no extra attack');
  const minions = m.enemies.filter(e => e.minion);
  assert(minions.length === T.maxMinions && minions.every(e => e.onGround && e.alive), 'treants landed on the ground');
  assert(new Set(minions.map(e => e.x)).size === T.maxMinions, 'each treant has its own spot');
  minions[0].die('hit');
  assert(chooseTreeAction(m, eye) === 'summon', 're-summon when a treant dies');
  shutMouth(m);
  const after = [];
  for (let i = 0; i < 60; i++) after.push(chooseTreeAction(m, eye));
  assert(!after.includes('summon'), 'mouth closed → never summon');
  return { acts };
});

test('士兵召喚（多人）：一次召喚「玩家人數」隻（不超過上限），召喚的回合還會再出一招撞擊 / 落葉', () => withTree({ attackOnSummonMulti: true, summonPerPlayer: 1, maxMinions: 4, weights: { trunk: 40, leaves: 40, meditate: 10, idle: 0 } }, () => {
  const T = CONFIG.TREE_BOSS;
  const out = {};
  for (const n of [2, 3, 4]) {
    const m = garden(n, { seed: 40 + n });
    const eye = m.byId('eye');
    // 開場的預定照上面的權重（發呆 0、眼睛滿血不養神）一定是撞擊或落葉
    assert(['trunk', 'leaves'].includes(m.mechState.next.action), `${n}p: opening plan is an attack: ` + JSON.stringify(m.mechState.next));
    const first = resolveTreeTurn(m, eye).steps;
    assert(first[0].action === 'summon' && first[0].spawns.length === Math.min(n * T.summonPerPlayer, T.maxMinions), `${n}p: summons ${n}: ` + JSON.stringify(first[0].spawns));
    assert(first.length === 2 && ['trunk', 'leaves'].includes(first[1].action) && first[1].shot, `${n}p: plus an attack: ` + first.map(s => s.action));
    assert(m.enemies.filter(e => e.minion && e.alive).length === first[0].spawns.length && first[0].spawns.every(s => m.byId(s.id).dormant), 'all summoned, all dormant');
    // 攻擊是在召喚之後結算的：攻擊的結果裡已經有新的樹妖（而且沒被打到）
    assert(first[0].spawns.every(s => first[1].shot.results.some(r => r.id === s.id && r.alive && r.hp === m.byId(s.id).maxHp)), 'the attack resolves after the summon, treants untouched');
    const second = resolveTreeTurn(m, eye).steps;
    out[n] = [first, second].map(s => s.map(x => x.action + (x.spawns ? '×' + x.spawns.length : '')).join('+'));
    if (n * T.summonPerPlayer >= T.maxMinions) {
      assert(second[0].action !== 'summon' && second.length === 1, `${n}p: already full → a single normal action`);
    } else {
      assert(second[0].action === 'summon' && second[0].spawns.length === Math.min(n, T.maxMinions - n) && second.length === 2, `${n}p: tops up to the cap: ` + out[n]);
    }
  }
  // 兩個攻擊權重都是 0：召喚的回合就只召喚
  const z = garden(2, { seed: 3 });
  const W = T.weights, saved = { ...W };
  W.trunk = 0; W.leaves = 0;
  try {
    planTreeNext(z, z.byId('eye'));   // 照現在的權重重新預定（開場預定的是撞擊或落葉）
    assert(resolveTreeTurn(z, z.byId('eye')).steps.length === 1, 'no attack weights → summon only');
  } finally { Object.assign(W, saved); }
  // 上限比人數小：一次只召喚到上限為止（上限 2、三個人 → 2 隻）
  withTree({ maxMinions: 2 }, () => {
    const c = garden(3, { seed: 8 });
    const s = firstStep(c, c.byId('eye'));
    assert(s.action === 'summon' && s.spawns.length === 2 && c.enemies.filter(e => e.minion).length === 2, 'capped by maxMinions: ' + s.spawns.length);
  });
  // 關掉 attackOnSummonMulti：多人召喚的回合也只召喚
  const off = garden(2, { seed: 3 });
  assert(withTree({ attackOnSummonMulti: false }, () => resolveTreeTurn(off, off.byId('eye')).steps.length) === 1, 'attackOnSummonMulti off → summon only');
  return out;
}));

test('古樹撞擊：挑站最多玩家的平面橫掃，只打那個平面上的玩家（50 傷害、往左擊退），不打自己的樹妖', () => {
  const m = garden(4, { seed: 3 });
  shutMouth(m);
  const [p1, p2, p3, p4] = m.players;
  placeOn(m, p1, 100, 480);   // 低台
  placeOn(m, p2, 160, 480);   // 低台
  placeOn(m, p3, 300, 420);   // 中台
  placeOn(m, p4, 60, 560);    // 地面（在低台底下）
  spawnTreant(m, { id: 'm9', name: '樹妖 9', x: 300, y: 540, hp: 100 });
  m.settle(300);
  assert(planeCounts(m).join() === '1,2,1,0', 'counts ' + planeCounts(m));
  const b = forcedStep(m, 'trunk');
  assert(b.action === 'trunk' && b.plane === 1, 'trunk the low platform: ' + JSON.stringify({ a: b.action, p: b.plane }));
  const hitIds = b.shot.events.filter(e => e.type === 'pierce').map(e => e.target).sort();
  assert(hitIds.join() === 'p1,p2', 'only players on the low platform: ' + hitIds);
  const dmg = b.shot.events.flatMap(e => e.damages || []);
  assert(dmg.every(d => d.dmg === CONFIG.WEAPONS.treeTrunk.damage), 'trunk damage 50');
  const kb = b.shot.events.find(e => e.type === 'pierce').ents[0];
  assert(kb.vx < 0 && kb.vy < 0, 'knocked left and up');
  assert(m.byId('m9').hp === 100 && p3.hp === p3.maxHp && p4.hp === p4.maxHp, 'treant, middle and ground untouched');
  assert(m.terrain.holes.length === 0, 'the trunk does not dig');
  // 平手：隨機挑其中一個
  const tie = garden(2, { seed: 9 });
  shutMouth(tie);
  const picked = new Set();
  for (let i = 0; i < 40; i++) {
    for (const p of tie.players) { p.hp = p.maxHp; }
    placeOn(tie, tie.players[0], 110, 480);
    placeOn(tie, tie.players[1], 30, 560);
    picked.add(forcedStep(tie, 'trunk').plane);
  }
  assert([...picked].sort().join() === '0,1', 'tie between ground and low platform → both get picked: ' + [...picked]);
  return { plane: b.plane, hit: hitIds };
});

test('飛散落葉：打離古樹最近的玩家，直線穿過地形與角色（30 傷害）', () => {
  const m = garden(2, { seed: 5 });
  shutMouth(m);
  const [p1, p2] = m.players;
  placeOn(m, p1, 560, 350);   // 高台，離古樹最近
  placeOn(m, p2, 40, 560);    // 地面最左邊
  const b = forcedStep(m, 'leaves');
  assert(b.action === 'leaves' && b.targetId === 'p1', 'targets the nearest player: ' + b.targetId);
  const ev = b.shot.events;
  assert(ev[0].type === 'pierce' && ev[0].target === 'p1' && ev[0].damages[0].dmg === CONFIG.WEAPONS.treeLeaf.damage, 'hits p1 for 30');
  assert(['out', 'water'].includes(ev.at(-1).type) && !ev.some(e => e.type === 'explode'), 'passes through terrain: ' + ev.map(e => e.type));
  // 直線上有兩個玩家：都被穿過
  const line = garden(2, { seed: 5 });
  shutMouth(line);
  const eye = line.byId('eye');
  const [a, c] = line.players;
  placeOn(line, a, 560, 350);
  // c 放在同一直線更遠的地面上：從葉子出發點經過 a 的中心延長到地面
  const ox = eye.x - eye.hw - 10, oy = eye.cy;
  const k = (planeY(line, 0) - 15 - oy) / (a.cy - oy);
  placeOn(line, c, ox + (a.cx - ox) * k, 540);
  const r = forcedStep(line, 'leaves');
  const hits = r.shot.events.filter(e => e.type === 'pierce').map(e => e.target);
  assert(hits.join() === 'p1,p2', 'pierces both players on the line: ' + hits);
  return { events: ev.map(e => e.type), pierced: hits };
});

test('閉目養神：只有眼睛受過傷才會出現（權重 40:40:10），回復 100 × 人數倍率，不超過上限', () => {
  const T = CONFIG.TREE_BOSS;
  const m = garden(2, { seed: 11 });
  shutMouth(m);
  const eye = m.byId('eye');
  const count = (n) => { const c = { trunk: 0, leaves: 0, meditate: 0, idle: 0 }; for (let i = 0; i < n; i++) c[rollTreeAction(m, eye)]++; return c; };
  const full = count(3000);
  assert(full.meditate === 0 && Math.abs(full.trunk - full.leaves) < 300, 'undamaged: trunk / leaves only ' + JSON.stringify(full));
  eye.hp -= 1000;
  const hurt = count(9000);
  const expected = 9000 * T.weights.meditate / (T.weights.trunk + T.weights.leaves + T.weights.meditate + T.weights.idle);
  assert(Math.abs(hurt.meditate - expected) < expected * 0.2, 'damaged: meditate ≈ ' + Math.round(expected) + ' ' + JSON.stringify(hurt));
  const heal = Math.round(T.meditateHeal * (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER));
  let b = forcedStep(m, 'meditate');
  assert(b.action === 'meditate' && b.heal === heal, 'heals ' + heal + ', got ' + b.heal);
  eye.hp = eye.maxHp - 10;
  b = forcedStep(m, 'meditate');
  assert(b.heal === 10 && eye.hp === eye.maxHp, 'capped at max hp');
  assert(force('meditate', () => rollTreeAction(m, eye)) === 'idle', 'full hp: meditate is not an option (only idle left)');
  return { full, hurt };
});

test('古樹之眼倒下 → 嘴巴與樹妖一起枯萎 → 過關；眼睛在自己的回合結束被燒死也一樣', () => {
  const m = garden(1);
  const eye = m.byId('eye');
  const p1 = m.players[0];
  resolveTreeTurn(m, eye);   // 召喚一隻樹妖
  eye.hp = 1;
  placeOn(m, p1, 560, 350);
  // 往眼睛開一發狙擊
  const mz = p1.muzzle();
  const ang = Math.atan2(-(eye.cy - mz.y), eye.x - eye.hw + 4 - mz.x) * 180 / Math.PI;
  const shot = m.resolveShot(p1, 'sniper', ang, 100);
  assert(!eye.alive && shot.events.some(e => e.target === 'eye'), 'sniper killed the eye');
  assert(m.enemies.every(e => !e.alive) && m.byId('m1').deathCause === 'wither' && m.byId('mouth').deathCause === 'wither', 'everything withered');
  assert(shot.results.every(s => s.id === 'p1' || !s.alive), 'shot results already show the withering');
  assert(m.result() === 'win', 'win');

  const b = garden(1);
  const beye = b.byId('eye'), bmouth = b.byId('mouth');
  beye.hp = 1; beye.burn = 30; beye.burnSource = 'p1';
  bmouth.closedTurns = 1;
  const fx = b.endTurn(beye);
  assert(!beye.alive && fx.some(f => f.type === 'burn' && f.id === 'eye'), 'eye burned: ' + JSON.stringify(fx));
  assert(!fx.some(f => f.type === 'mouthOpen'), 'a dying tree does not reopen its mouth');
  assert(b.result() === 'win' && !bmouth.alive && bmouth.deathCause === 'wither', 'burned eye → tree withers → win');
  return { burnFx: fx.map(f => f.type + ':' + f.id) };
});

test('古樹之口（多人）：打不壞；被攻擊到（直擊或爆炸波及）就閉上，古樹那個回合不召喚，回合結束就張開', () => {
  const m = garden(2, { seed: 7 });
  const eye = m.byId('eye'), mouth = m.byId('mouth');
  const [p1, p2] = m.players;
  const w = CONFIG.WEAPONS;
  assert(mouth.closeOnHit === Math.max(1, CONFIG.TREE_BOSS.mouthClosedTurnsMulti), 'multiplayer close duration comes from config');
  mouth.closeOnHit = 1;   // 下面測「閉一個古樹回合」的機制（不受 config 調整影響）
  assert(mouth.closedTurns === 0 && chooseTreeAction(m, eye) === 'summon', 'starts open → summon');
  // 直擊：不扣血、不燒、不擊退，只會閉上；傷害清單標 closed
  const d1 = m.applyExplosion(mouth.cx, mouth.cy, w.cannon, p1, mouth, { burn: 30 });
  const md = d1.find(d => d.id === 'mouth');
  assert(md && md.closed && md.dmg === 0 && mouth.hp === mouth.maxHp && mouth.burn === 0 && mouth.alive, 'direct hit closes without damage: ' + JSON.stringify(md));
  assert(mouth.closedTurns === 1 && chooseTreeAction(m, eye) !== 'summon', 'closed → no summon');
  // 古樹的回合結束：張開（fx mouthOpen），下一回合又會召喚
  const fx = m.endTurn(eye);
  assert(fx.some(f => f.type === 'mouthOpen' && f.id === 'mouth') && mouth.closedTurns === 0, 'reopens at the end of the tree turn: ' + JSON.stringify(fx));
  assert(chooseTreeAction(m, eye) === 'summon', 'open again → summon');
  assert(!m.endTurn(eye).some(f => f.type === 'mouthOpen'), 'no reopen fx when it was already open');
  // 古樹這回合打死了最後一位玩家：已經輸了就不播「張開」（不然 turnFx 會把 gameOver 延後 fxDelay）
  const lost = garden(1);
  lost.byId('mouth').closedTurns = 1;
  lost.players[0].die('hit');
  assert(!lost.endTurn(lost.byId('eye')).some(f => f.type === 'mouthOpen'), 'no reopen once the game is lost');
  // 爆炸波及也算；大量傷害也打不死
  const near = m.applyExplosion(mouth.x - mouth.hw - 20, mouth.cy, w.cannon, p1, null);
  assert(near.some(d => d.id === 'mouth' && d.closed) && mouth.closedTurns === 1, 'splash closes it too');
  for (let i = 0; i < 50; i++) m.applyExplosion(mouth.cx, mouth.cy, w.plasma, p2, mouth);
  assert(mouth.alive && mouth.hp === mouth.maxHp && mouth.closedTurns === 1, 'cannot be destroyed, does not stack');
  // 裝備產生的攻擊（無差別轟炸）也算玩家的攻擊
  m.endTurn(eye);
  const bomb = m.applyExplosion(mouth.x - mouth.hw - 10, mouth.cy, w.bombard, p1, null);
  assert(bomb.some(d => d.id === 'mouth' && d.closed) && mouth.closedTurns === 1, 'bombard closes it');
  // 實際開火：從高台用狙擊打嘴巴 → 事件裡帶著嘴巴閉上的狀態；客戶端照事件重播，打中的那一幀就閉上
  m.endTurn(eye);
  placeOn(m, p1, 560, 350);
  const before = JSON.parse(JSON.stringify(m.snapshot()));
  assert(before.entities.find(s => s.id === 'mouth').closed === 0, 'open before the shot');
  const mz = p1.muzzle();
  const ang = Math.atan2(-(mouth.cy - mz.y), mouth.x - mouth.hw + 4 - mz.x) * 180 / Math.PI;
  const shot = JSON.parse(JSON.stringify(m.resolveShot(p1, 'sniper', ang, 100)));
  const hit = shot.events.find(e => e.target === 'mouth');
  assert(hit && hit.ents.find(s => s.id === 'mouth').closed === 1, 'event state carries closed: ' + JSON.stringify(shot.events).slice(0, 200));
  assert(shot.results.find(s => s.id === 'mouth').closed === 1 && m.snapshot().entities.find(s => s.id === 'mouth').closed === 1, 'snapshot carries closed');
  const cm = new Match({ levelId: 'treeGarden', players: mkPlayers(2), seed: m.seed, stage: 6 });
  cm.applySnapshot(before);
  assert(cm.byId('mouth').closedTurns === 0, 'client starts with an open mouth');
  replayChecked(cm, shot, 'mouth');   // 只套事件（applyEventState），還沒套最後的 results
  assert(cm.byId('mouth').closedTurns === 1, 'client closes the mouth from the hit event');
  // 重連：新的客戶端從快照拿到閉著的嘴巴
  const c = new Match({ levelId: 'treeGarden', players: mkPlayers(2), seed: m.seed, stage: 6 });
  c.applySnapshot(JSON.parse(JSON.stringify(m.snapshot())));
  assert(c.byId('mouth').closedTurns === 1, 'reconnect restores the closed mouth');
  // AI 代打：閉著的嘴不當目標；張著的嘴（血量 1）最常被選
  const rng = new Rng(2);
  for (let i = 0; i < 30; i++) assert(planShot(m.world, p2, rng).targetId !== 'mouth', 'closed mouth is not a target');
  m.endTurn(eye);
  let picks = 0;
  for (let i = 0; i < 30; i++) if (planShot(m.world, p2, rng).targetId === 'mouth') picks++;
  assert(picks >= 15, 'open mouth is the favourite target: ' + picks + '/30');
  // 樹妖的長矛（敵方自己人）打到嘴巴不會讓它閉上
  const tr = spawnTreant(m, { id: 'm7', name: '樹妖 7', x: 470, y: 540, hp: 100 });
  m.applyExplosion(mouth.cx, mouth.cy, w.treeSpear, tr, mouth);
  assert(mouth.closedTurns === 0, 'allies do not close it');
  return { aiPicksOpenMouth: picks };
});

test('古樹之口（單人）：閉上後多一回合冷卻——這一輪與下一輪的古樹回合都不召喚，第二個古樹回合結束才張開', () => {
  const m = garden(1, { seed: 12 });
  const eye = m.byId('eye'), mouth = m.byId('mouth');
  const p1 = m.players[0];
  assert(mouth.closeOnHit === Math.max(1, CONFIG.TREE_BOSS.mouthClosedTurnsSolo), 'solo close duration comes from config');
  mouth.closeOnHit = 2;   // 下面測「多一回合冷卻」的機制（不受 config 調整影響）
  m.applyExplosion(mouth.cx, mouth.cy, CONFIG.WEAPONS.cannon, p1, mouth);
  assert(mouth.closedTurns === 2, 'closed for two tree turns');
  // 第 1 個古樹回合：不召喚；回合結束還閉著（不播張開）
  assert(chooseTreeAction(m, eye) !== 'summon', 'tree turn 1: no summon');
  const fx1 = m.endTurn(eye);
  assert(!fx1.some(f => f.type === 'mouthOpen') && mouth.closedTurns === 1, 'still closed after tree turn 1: ' + JSON.stringify(fx1));
  // 下一輪玩家的回合：嘴巴還閉著，可以專心打眼睛；第 2 個古樹回合一樣不召喚
  assert(chooseTreeAction(m, eye) !== 'summon', 'tree turn 2: no summon');
  const fx2 = m.endTurn(eye);
  assert(fx2.some(f => f.type === 'mouthOpen') && mouth.closedTurns === 0, 'reopens after tree turn 2: ' + JSON.stringify(fx2));
  assert(chooseTreeAction(m, eye) === 'summon', 'tree turn 3: summon again');
  // 閉著的時候再打一次：重新算冷卻（回到 2）
  m.applyExplosion(mouth.cx, mouth.cy, CONFIG.WEAPONS.cannon, p1, mouth);
  m.endTurn(eye);
  m.applyExplosion(mouth.cx, mouth.cy, CONFIG.WEAPONS.cannon, p1, mouth);
  assert(mouth.closedTurns === 2, 'hitting a closed mouth refreshes the cooldown');
});

test('平台：炸不壞、子彈穿得過；人站得住、從下面跳得上去、橫著走穿得過，站在上面不會掉下去', () => {
  const m = garden(1, { seed: 3 });
  const t = m.terrain;
  const p = m.players[0];
  const planes = m.mechState.def.planes;
  const low = planes[1];
  // 地形格子：平台不是「實心」，但站得住
  assert(t.isPlatform(120, low.y + 3) && !t.isSolid(120, low.y + 3), 'platform cells are pass-through');
  t.carve(120, low.y + 10, 60);
  assert(t.isPlatform(120, low.y + 3) && t.isPlatform(60, low.y + 8), 'explosions do not carve platforms');
  // 子彈：從低台正下方往上打，穿過低台，最後打到別的地方
  const g = garden(1, { seed: 3 });
  const gp = g.players[0];
  placeOn(g, gp, 120, 560);   // 低台正下方的地面
  const up = g.resolveShot(gp, 'sniper', 90, 100);
  const end = up.events.at(-1);
  assert(end.y < low.y - 30 || end.type === 'out', 'sniper passes through the platform: ' + JSON.stringify(end));
  const lob = g.resolveShot(gp, 'cannon', 80, 40);   // 幾乎垂直往上的大砲：穿過低台，落回地面
  const boom = lob.events.find(e => e.type === 'explode');
  assert(boom && !(boom.x >= low.x0 && boom.x <= low.x1 && boom.y >= low.y - 2 && boom.y <= low.y + 30), 'cannon shell passes through the platform: ' + JSON.stringify(boom));
  assert(g.terrain.isPlatform(120, low.y + 3), 'platform intact after shots');
  // 站在平台上：放著不動不會掉下去
  placeOn(m, p, 120, 480);
  assert(planeOf(planes, p) === 1 && p.onGround && Math.abs(p.y - (low.y - 1)) < 1, 'standing on the low platform at y=' + p.y);
  for (let i = 0; i < 120; i++) m.step();
  assert(planeOf(planes, p) === 1 && p.onGround, 'still standing after 2s');
  // 在平台上左右走（不走出邊緣）：一直站在頂面，不會陷下去
  p.stamina = 1e9;
  const ys = new Set();
  for (const [dir, n] of [[1, 25], [-1, 50], [1, 25]]) {
    p.moveDir = dir;
    for (let i = 0; i < n; i++) { m.step(); ys.add(p.y); }
  }
  p.moveDir = 0;
  assert(planeOf(planes, p) === 1 && p.onGround && ys.size === 1, 'walking on the platform keeps you on top: ' + [...ys]);
  // AI 代打站在平台上也走得動（canWalk 把平台當地面）
  assert(p.canWalk(t, 1) && p.canWalk(t, -1), 'AI sees the platform as walkable');
  const onTop = (e) => planeOf(planes, e) === 1 && e.onGround && Math.abs(e.y - (low.y - 1)) < 1 && !t.isPlatform(e.x, e.y);
  // 從正下方垂直往上跳：穿過平台、落在平台頂面
  placeOn(m, p, 120, 560);
  assert(planeOf(planes, p) === 0, 'under the platform on the ground');
  p.stamina = p.maxStamina;
  p.wantJump = true;
  for (let i = 0; i < 90; i++) m.step();
  m.settle(120);
  assert(onTop(p), 'jumped straight up through the platform onto its top, y=' + p.y.toFixed(2));
  // 只往上衝到平台裡面（沒超過頂面）：掉回地面，不會卡在平台裡
  placeOn(m, p, 120, 560);
  p.vy = -300;   // 大約升高 50px：腳停在平台中間
  p.onGround = false;
  let peak = p.y;
  for (let i = 0; i < 300; i++) { m.step(); peak = Math.min(peak, p.y); if (i > 5 && p.onGround) break; }
  assert(peak > low.y && peak < low.y + 26, 'precondition: the rise peaks inside the platform, peak=' + peak.toFixed(1));
  assert(planeOf(planes, p) === 0 && p.onGround && p.y > 570 && !t.isPlatform(p.x, p.y), 'fell back through to the ground, y=' + p.y.toFixed(1));
  // 身體跟平台同高時橫著移動：直接穿過平台側面（只有頂面撐人）
  p.x = 215; p.y = low.y + 31; p.vx = 0; p.vy = 0;
  assert(t.isPlatform(195, low.y + 10) && p.y - p.h < low.y + 10, 'precondition: the body overlaps the platform band');
  assert(p.tryMove(t, -1, 40) && p.x === 175, 'moved through the side of the platform, x=' + p.x);
  // 在地面上橫著走：從平台底下穿過去
  placeOn(m, p, 20, 560);
  p.moveDir = 1;
  for (let i = 0; i < 120; i++) m.step();
  p.moveDir = 0;
  assert(p.x > 250 && planeOf(planes, p) === 0, 'walked under the low platform: x=' + p.x.toFixed(1));
  // 擊退把人往上撞穿平台：落下時站在頂面
  placeOn(m, p, 120, 560);
  p.vy = -420;
  p.onGround = false;
  m.settle(300);
  assert(onTop(p), 'knocked up through the platform lands on its top, y=' + p.y.toFixed(2));
  // AI 視線穿得過平台
  const s = garden(1, { seed: 3 });
  const tr = spawnTreant(s, { id: 'm1', name: '樹妖 1', x: 515, y: 540, hp: 100 });
  s.settle(300);
  placeOn(s, s.players[0], 520, 350);   // 高台上，樹妖正上方
  assert(planeOf(s.mechState.def.planes, s.players[0]) === 3 && s.terrain.isPlatform(517, 395), 'precondition: target on the high platform, platform between them');
  assert(hasLineOfSight(s.world, tr, s.players[0]), 'line of sight goes through the high platform');
  return { jumpLanding: Math.round(p.y) };
});

test('裁判：回報位置帶垂直速度 → 往上跳穿平台途中剛好超時，伺服器也讓他落在平台上（跟客戶端一樣）', () => {
  // 客戶端：從低台正下方往上跳，記下每一幀的狀態（跟 game-view 回報的內容一樣：x、y、vy）
  const cm = garden(1, { seed: 5 });
  const cp = cm.players[0];
  placeOn(cm, cp, 120, 560);
  cp.stamina = cp.maxStamina;
  cp.wantJump = true;
  const traj = [];
  for (let i = 0; i < 90; i++) { cm.step(); traj.push({ x: cp.x, y: cp.y, vy: cp.vy }); }
  const clientY = cp.y;
  assert(planeOf(cm.mechState.def.planes, cp) === 1, 'client lands on the low platform');
  const landings = [];
  for (const k of [2, 6, 10, 14, 20]) {   // 最後一次回報在上升途中的第 k 幀（腳還在平台下面或裡面）
    const m = new Match({ levelId: 'treeGarden', players: mkPlayers(1), seed: 5, stage: 6 });
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: mkPlayers(1), io });
    ref.start();
    assert(advanceUntil(io, () => ref.phase === 'turn'), 'p1 turn');
    const p = m.byId('p1');
    placeOn(m, p, 120, 560);
    const s = traj[k];
    ref.handle('p1', { t: 'move', x: s.x, y: s.y, vy: s.vy, facing: 1, stamina: p.stamina });
    assert(p.vy === s.vy, 'server keeps the reported vy');
    io.advance(CONFIG.TURN_TIME * 1000 + 50);   // 超時 → skip（伺服器從回報的狀態落地）
    const skip = io.take('skip').at(-1);
    assert(skip && skip.reason === 'timeout', 'timed out');
    const y = skip.entities.find(e => e.id === 'p1').y;
    landings.push(+y.toFixed(2));
    assert(Math.abs(y - clientY) < 1, `report at frame ${k} (y ${s.y.toFixed(1)}, vy ${s.vy.toFixed(0)}): server ${y.toFixed(2)} vs client ${clientY.toFixed(2)}`);
  }
  return { clientY: +clientY.toFixed(2), serverLandings: landings };
});

test('樹妖：用長矛（拋物線、不挖地、只打直接命中），瞄準誤差用 TREANT 的設定', () => {
  const m = garden(1, { seed: 4 });
  const p1 = m.players[0];
  placeOn(m, p1, 225, 540);
  const tr = spawnTreant(m, { id: 'm1', name: '樹妖 1', x: 470, y: 540, hp: 150 });
  m.settle(300);
  const rng = new Rng(3);
  const plan = planShot(m.world, tr, rng);
  assert(plan && plan.weapon === 'treeSpear' && plan.targetId === 'p1', 'plans a spear throw: ' + JSON.stringify(plan));
  // 沒有誤差時一定打得到（把誤差關掉重算）
  tr.ai = { ...tr.ai, aimError: { angle: 0, power: 0 } };
  const exact = planShot(m.world, tr, new Rng(3));
  const shot = m.resolveShot(tr, exact.weapon, exact.angle, exact.power);
  const hit = shot.events[0];
  assert(hit.target === 'p1' && hit.damages.length === 1 && hit.damages[0].dmg === CONFIG.WEAPONS.treeSpear.damage, 'spear hits for 25: ' + JSON.stringify(hit).slice(0, 160));
  assert(m.terrain.holes.length === 0, 'spears do not dig');
  const { walk } = m.planAiTurn(tr);
  assert(walk === null, 'treants never walk (moveChance 0)');

  // 四隻樹妖站成一排：最右邊那隻往左平射，長矛從同伴身上穿過去（不會誤傷自己人）
  const row = garden(1, { seed: 4 });
  const eye = row.byId('eye');
  for (let i = 0; i < CONFIG.TREE_BOSS.maxMinions; i++) resolveTreeTurn(row, eye);
  const [first, ...others] = row.enemies.filter(e => e.minion).sort((a, b) => b.x - a.x);
  const flat = row.resolveShot(first, 'treeSpear', 172, 70);
  assert(flat.events.every(e => !e.target || row.byId(e.target).team === 'players'), 'no ally hit: ' + flat.events.map(e => e.type + ':' + (e.target || '')));
  assert(others.every(e => e.hp === e.maxHp), 'allies untouched');
  // AI 規劃也知道可以從同伴頭上 / 身上丟過去：瞄得到玩家
  placeOn(row, row.players[0], 225, 540);
  const aim = planShot(row.world, first, new Rng(8));
  assert(aim && aim.weapon === 'treeSpear' && aim.targetId === row.players[0].id, 'rightmost treant still plans a throw');
  return { flat: flat.events.map(e => e.type) };
});

test('客戶端照事件重播古樹撞擊 / 飛散落葉，結果跟伺服器位元級一致；召喚用同一份資料重建出一樣的樹妖', () => {
  const out = {};
  for (const want of ['trunk', 'leaves']) {
    // 三個人擠在高台上（撞擊與落葉都打這裡），血量 60：有人被打死、有人被擊退
    const m = garden(3, { seed: 21, hp: 60 });
    shutMouth(m);
    m.players.forEach((p, i) => placeOn(m, p, 500 + i * 30, 350));
    m.players[1].hp = 40;
    const snap = JSON.parse(JSON.stringify(m.snapshot()));
    const b = forcedStep(m, want);
    assert(b.action === want, 'got ' + want);
    const cm = new Match({ levelId: 'treeGarden', players: mkPlayers(3), seed: m.seed, stage: 6 });
    for (const e of cm.players) { e.maxHp = 60; }
    cm.applySnapshot(snap);
    const shot = JSON.parse(JSON.stringify(b.shot));
    replayChecked(cm, shot, want);
    for (const s of shot.results) {
      const e = cm.byId(s.id);
      assert(e.x === s.x && e.y === s.y && e.hp === s.hp && e.alive === s.alive, `${want}: ${s.id} client ${e.x},${e.y},${e.hp},${e.alive} vs server ${s.x},${s.y},${s.hp},${s.alive}`);
    }
    out[want] = shot.events.map(e => e.type).join('>');
  }
  // 多人召喚的回合 = [召喚, 攻擊]：客戶端照 spawns 建樹妖、落地後跟伺服器一樣，接著重播攻擊也一樣
  // （設定與預定的落葉都寫死在這裡，不受使用者調 config 影響）
  const s = garden(2, { seed: 2, hp: 60 });
  s.mechState.next = { action: 'leaves' };
  const snap = s.snapshot();
  const { steps } = JSON.parse(JSON.stringify(withTree({ attackOnSummonMulti: true, summonPerPlayer: 1, maxMinions: 4 }, () => resolveTreeTurn(s, s.byId('eye')))));
  assert(steps.length === 2 && steps[0].action === 'summon' && steps[0].spawns.length === 2 && steps[1].shot, 'summon + attack: ' + steps.map(x => x.action));
  const c = new Match({ levelId: 'treeGarden', players: mkPlayers(2), seed: s.seed, stage: 6 });
  for (const e of c.players) { e.maxHp = 60; }
  c.applySnapshot(JSON.parse(JSON.stringify(snap)));
  const built = steps[0].spawns.map(spec => spawnTreant(c, spec));
  for (let n = 0; n < steps[0].still.settleFrames + 60; n++) { c.step(); if (c.isSettled()) break; }
  for (const e of built) {
    const srv = steps[0].still.results.find(r => r.id === e.id);
    assert(e.x === srv.x && e.y === srv.y && e.hp === srv.hp && e.maxHp === s.byId(e.id).maxHp, `client-built ${e.id} matches the server`);
  }
  c.applyEntities(steps[0].still.results);
  replayChecked(c, steps[1].shot, 'follow-up');
  for (const r of steps[1].shot.results) {
    const e = c.byId(r.id);
    assert(e && e.x === r.x && e.y === r.y && e.hp === r.hp && e.alive === r.alive, `follow-up ${steps[1].action}: ${r.id} client ${e && e.x},${e && e.y},${e && e.hp} vs server ${r.x},${r.y},${r.hp}`);
  }
  out.summon = steps[0].spawns.map(x => x.id).join(',') + ' then ' + steps[1].action;
  return out;
});

test('重連：快照帶著召喚過的樹妖（含已經死掉的），新的客戶端照著重建', () => withTree({ summonPerPlayer: 1, maxMinions: 4 }, () => {
  const m = garden(1);
  const eye = m.byId('eye');
  resolveTreeTurn(m, eye);
  resolveTreeTurn(m, eye);
  m.byId('m1').die('hit');
  const snap = JSON.parse(JSON.stringify(m.snapshot()));
  assert(snap.minions.map(x => x.id).join() === 'm1,m2', 'minions in snapshot');
  const multi = garden(3);
  resolveTreeTurn(multi, multi.byId('eye'));   // 三人：一次三隻
  assert(multi.snapshot().minions.map(x => x.id).join() === 'm1,m2,m3', 'a multi-treant summon is in the snapshot too');
  const c = new Match({ levelId: 'treeGarden', players: mkPlayers(1), seed: m.seed, stage: 6 });
  c.applySnapshot(snap);
  assert(c.byId('m1') && !c.byId('m1').alive && c.byId('m2').alive && c.byId('m2').x === m.byId('m2').x, 'rebuilt minions with their state');
  assert(c.entities.map(e => e.id).join() === m.entities.map(e => e.id).join(), 'same entity order');
  c.applySnapshot(snap);
  assert(c.entities.length === m.entities.length, 'applying the snapshot twice does not duplicate minions');
}));

test('裁判：古樹的回合廣播 aiTurn（boss.steps：招式 + shot / still），等每一招的動畫播完才換人；打倒古樹之眼就結束', () => withTree({ attackOnSummonMulti: true, summonPerPlayer: 1, maxMinions: 4, weights: { trunk: 40, leaves: 40, meditate: 10, idle: 0 } }, () => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'treeGarden', players, seed: 13, stage: 6 });
  for (const p of m.players) { p.hp = p.maxHp = 100000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const at = new Map();   // 廣播 → 當時的時間
  const broadcast = io.broadcast.bind(io);
  io.broadcast = (msg, ex) => { broadcast(msg, ex); at.set(io.log.at(-1), io.t); };
  // 兩人、玩家都超時 → 古樹連續出招：前 2 回合各召喚 2 隻（樹妖滿了）並附帶攻擊，之後一回合一招
  assert(advanceUntil(io, () => io.take('aiTurn').filter(a => a.boss).length >= 5, 1_200_000), 'five tree turns');
  const bossTurns = io.take('aiTurn').filter(a => a.boss);
  assert(bossTurns.every(a => a.actorId === 'eye' && a.walk === null && a.shot === null && a.boss.steps.length >= 1), 'tree turns come from the eye');
  const acts = bossTurns.map(a => a.boss.steps.map(s => s.action).join('+'));
  const summonTurns = Math.ceil(CONFIG.TREE_BOSS.maxMinions / (2 * CONFIG.TREE_BOSS.summonPerPlayer));
  assert(acts.slice(0, summonTurns).every(a => /^summon\+(trunk|leaves)$/.test(a)) && acts.slice(summonTurns).every(a => !a.includes('summon') && !a.includes('+')), 'summon+attack until full, then single actions: ' + acts);
  // 每個古樹回合都帶 boss.next（= 伺服器當時的預定）；不是召喚的那一招一定是上一個預定（第一個預定在 start 的快照裡）
  let plan = io.take('start')[0].snapshot.treeNext;
  assert(plan && plan.action, 'start snapshot carries the first plan');
  for (const a of bossTurns) {
    const exec = a.boss.steps.filter(st => st.action !== 'summon');
    assert(exec.length <= 1, 'at most one planned action per turn');
    if (exec.length) {
      assert(exec[0].action === plan.action && (plan.action !== 'trunk' || exec[0].plane === plan.plane), 'executes the previous plan: ' + JSON.stringify({ plan, got: exec[0].action, plane: exec[0].plane }));
    } else {
      assert(JSON.stringify(a.boss.next) === JSON.stringify(plan), 'a pure summon turn keeps the plan');
    }
    assert(a.boss.next && a.boss.next.action, 'boss.next present');
    plan = a.boss.next;
  }
  assert(JSON.stringify(plan) === JSON.stringify(m.mechState.next), 'the last boss.next is the server plan');
  const first = bossTurns[0].boss.steps;
  assert(first[0].spawns.map(s => s.id).join() === 'm1,m2' && first[0].still.results.some(s => s.id === 'm2') && first[1].shot, 'summon payload');
  const turnIds = io.take('turn').map(t => t.actorId);
  assert(!turnIds.includes('mouth'), 'the mouth never gets a turn');
  const i1 = turnIds.indexOf('m1');
  assert(i1 > 0 && turnIds.slice(0, i1).filter(id => id === 'eye').length === 2, 'm1 acts only from the next round: ' + turnIds.slice(0, i1 + 1).join(','));
  // 時間：古樹回合要等 aiThink + 每一招（bossCast + 動畫）+ 緩衝，下一位才開始
  const T = CONFIG.TIMING;
  for (const a of bossTurns.slice(0, -1)) {   // 最後一個還沒輪到下一位
    const idx = io.log.indexOf(a);
    const next = io.log.slice(idx + 1).find(x => x.t === 'turn' || x.t === 'turnFx' || x.t === 'gameOver');
    const steps = a.boss.steps.reduce((s, st) => s + T.bossCast + (st.shot ? st.shot.flightFrames + st.shot.settleFrames : st.still.settleFrames) / 60, 0);
    const want = (T.aiThink + steps + T.afterShotPad) * 1000;
    assert(next && Math.abs(at.get(next) - at.get(a) - want) <= 1, `${acts[bossTurns.indexOf(a)]}: waited ${at.get(next) - at.get(a)}ms, expected ${Math.round(want)}`);
  }

  // 眼睛被打倒 → gameOver win（嘴巴與樹妖枯萎）
  assert(advanceUntil(io, () => ref.phase === 'turn' && m.byId(ref.currentId).team === 'players'), 'back to a player');
  const p = m.byId(ref.currentId);
  const eye = m.byId('eye');
  eye.hp = 1;
  placeOn(m, p, 560, 350);   // 站到高台上，直線瞄眼睛露在外面的左半邊
  const mz = p.muzzle();
  const ang = Math.atan2(-(eye.cy - mz.y), eye.x - eye.hw + 4 - mz.x) * 180 / Math.PI;
  ref.handle(p.id, { t: 'fire', weapon: 'sniper', angle: ang, power: 100, x: p.x, y: p.y, facing: 1, stamina: 0 });
  assert(advanceUntil(io, () => ref.phase === 'over'), 'game over');
  const over = io.take('gameOver')[0];
  assert(over.result === 'win' && over.entities.filter(s => s.id !== 'p1' && s.id !== 'p2').every(s => !s.alive), 'win, everything on the tree is dead');
  return { actions: acts };
}));

// 裁判流程：p1 用狙擊打嘴巴（其他人超時），回傳古樹接下來每一個回合的招式與 turnFx
function mouthFlow(n, treeTurns) {
  const players = mkPlayers(n);
  const m = new Match({ levelId: 'treeGarden', players, seed: 31, stage: 6 });
  for (const p of m.players) { p.hp = p.maxHp = 100000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  const mouth = m.byId('mouth');
  assert(advanceUntil(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  const p = m.byId('p1');
  placeOn(m, p, 560, 350);
  const mz = p.muzzle();
  const ang = Math.atan2(-(mouth.cy - mz.y), mouth.x - mouth.hw + 4 - mz.x) * 180 / Math.PI;
  ref.handle('p1', { t: 'fire', weapon: 'sniper', angle: ang, power: 100, x: p.x, y: p.y, facing: 1, stamina: 0 });
  const shot = io.take('shot').at(-1);
  assert(shot.events.some(e => e.target === 'mouth' && e.damages.some(d => d.closed)) && mouth.closedTurns === mouth.closeOnHit, 'the shot closed the mouth');
  const turns = [];
  for (let k = 0; k < treeTurns; k++) {
    io.clear();
    // 等到古樹出完招、回合結束（turnFx）、下一位開始（古樹出招之後的第一個 turn）
    const done = () => {
      const i = io.log.findIndex(x => x.t === 'aiTurn' && x.boss);
      return i >= 0 && io.log.slice(i + 1).some(x => x.t === 'turn');
    };
    assert(advanceUntil(io, done), 'tree turn ' + (k + 1));
    const t = io.take('aiTurn').find(a => a.boss);
    const fx = io.take('turnFx').find(f => f.actorId === 'eye');
    turns.push({
      actions: t.boss.steps.map(s => s.action).join('+'),
      reopened: !!fx && fx.fx.some(f => f.type === 'mouthOpen'),
      closedAfter: mouth.closedTurns,
    });
  }
  return turns;
}

test('裁判（單人）：打到嘴巴 → 這一輪與下一輪的古樹回合都不召喚 → 第二個古樹回合結束廣播 mouthOpen → 第三個古樹回合召喚', () => withTree({ mouthClosedTurnsSolo: 2 }, () => {
  const t = mouthFlow(1, 3);
  assert(!t[0].actions.includes('summon') && !t[0].reopened && t[0].closedAfter === 1, 'tree turn 1: no summon, still closed: ' + JSON.stringify(t[0]));
  assert(!t[1].actions.includes('summon') && t[1].reopened && t[1].closedAfter === 0, 'tree turn 2: no summon, then reopens: ' + JSON.stringify(t[1]));
  assert(t[2].actions === 'summon', 'tree turn 3: summon: ' + JSON.stringify(t[2]));
  return t.map(x => x.actions);
}));

test('裁判（多人）：打到嘴巴 → 古樹那回合不召喚 → 回合結束廣播 mouthOpen → 下一回合召喚 2 隻並附帶攻擊', () => withTree({ mouthClosedTurnsMulti: 1, attackOnSummonMulti: true, weights: { trunk: 40, leaves: 40, meditate: 10, idle: 0 } }, () => {
  const t = mouthFlow(2, 2);
  assert(!t[0].actions.includes('summon') && t[0].reopened && t[0].closedAfter === 0, 'tree turn 1: no summon, then reopens: ' + JSON.stringify(t[0]));
  assert(/^summon\+(trunk|leaves)$/.test(t[1].actions), 'tree turn 2: summon + attack: ' + JSON.stringify(t[1]));
  return t.map(x => x.actions);
}));

test('預定下一招：開場（大家落地後）就決定好；快照帶著，新的客戶端（同 seed 先自己算一次）照快照套用', () => withTree({ weights: { trunk: 1, leaves: 1, meditate: 1, idle: 0 } }, () => {
  const m = garden(2, { seed: 4 });
  const next = m.mechState.next;
  assert(next && ['trunk', 'leaves'].includes(next.action), 'a fresh boss match already has a plan (full hp → no meditate): ' + JSON.stringify(next));
  assert(next.action !== 'trunk' || Number.isInteger(next.plane), 'a trunk plan has a plane');
  // 換成別的預定 → 快照 → 新的 Match（自己開場也算了一份）→ 套用後跟伺服器一樣
  m.mechState.next = { action: 'trunk', plane: 3 };
  const snap = JSON.parse(JSON.stringify(m.snapshot()));
  assert(snap.treeNext && snap.treeNext.action === 'trunk' && snap.treeNext.plane === 3, 'snapshot carries the plan: ' + JSON.stringify(snap.treeNext));
  const c = new Match({ levelId: 'treeGarden', players: mkPlayers(2), seed: m.seed, stage: 6 });
  c.applySnapshot(snap);
  assert(c.mechState.next.action === 'trunk' && c.mechState.next.plane === 3 && c.mechState.next !== snap.treeNext, 'applySnapshot restores the plan (as a copy)');
  // 開始的廣播（start）與重連（state）都帶著
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(2), io });
  ref.start();
  assert(io.take('start')[0].snapshot.treeNext.plane === 3 && ref.statePayload().snapshot.treeNext.plane === 3, 'start / state payloads carry the plan');
  // 一般關卡沒有古樹
  assert(new Match({ levelId: 'level1', players: mkPlayers(1), seed: 1 }).snapshot().treeNext === null, 'no tree → treeNext null');
  return { firstPlan: next };
}));

test('古樹撞擊（預告）：平面在預定的當下選好（當時人最多的），出招時照樣掃那個平面——躲開的人沒事、後來跑上去的人被打', () => {
  const m = garden(3, { seed: 3 });
  shutMouth(m);
  const eye = m.byId('eye');
  const [p1, p2, p3] = m.players;
  placeOn(m, p1, 100, 480);   // 低台
  placeOn(m, p2, 160, 480);   // 低台
  placeOn(m, p3, 300, 420);   // 中台
  const plan = force('trunk', () => planTreeNext(m, eye));
  assert(plan.action === 'trunk' && plan.plane === 1 && m.mechState.next === plan, 'planned on the busiest plane at plan time: ' + JSON.stringify(plan));
  // 玩家的回合：p1、p2 跑到中台（現在人最多的是中台），p3 跑到低台
  placeOn(m, p1, 280, 420);
  placeOn(m, p2, 350, 420);
  placeOn(m, p3, 120, 480);
  assert(planeCounts(m).join() === '0,1,2,0', 'moved: ' + planeCounts(m));
  const { steps, next } = resolveTreeTurn(m, eye);
  assert(steps.length === 1 && steps[0].action === 'trunk' && steps[0].plane === 1, 'still sweeps the planned plane: ' + JSON.stringify({ a: steps[0].action, p: steps[0].plane }));
  const hit = steps[0].shot.events.filter(e => e.type === 'pierce').map(e => e.target);
  assert(hit.join() === 'p3', 'only the player who moved onto the lane is hit: ' + hit);
  assert(p1.hp === p1.maxHp && p2.hp === p2.maxHp && p3.hp < p3.maxHp, 'the dodgers are untouched');
  // 掃的範圍：樹幹中心 = 平面 - 18、半徑 = hitRadius，從樹皮表面一路到 x = 0（客戶端的警示帶畫的是同一個 trunkLane）
  const lane = trunkLane(m, 1);
  const pr = steps[0].shot.projectiles[0];
  assert(lane.y === planeY(m, 1) - 18 && lane.half === CONFIG.WEAPONS.treeTrunk.hitRadius && lane.x0 === 0 && lane.x1 === m.terrain.hardEdgeX(lane.y), 'lane geometry: ' + JSON.stringify(lane));
  assert(pr.y === lane.y && pr.x === Math.min(lane.x1 + 30, CONFIG.WORLD_W) && pr.vx < 0, 'the trunk flies down the lane: ' + JSON.stringify(pr));
  assert(['out', 'water'].includes(steps[0].shot.events.at(-1).type), 'sweeps all the way off the map');
  // 用掉了 → 重新預定；回傳的 next 是 match.mechState.next 的複本
  assert(m.mechState.next !== plan && JSON.stringify(next) === JSON.stringify(m.mechState.next) && next !== m.mechState.next, 'replanned after use: ' + JSON.stringify(next));
  return { plan, hit };
});

test('預定下一招（單人）：召喚的回合不用掉預定的招式（預告一直留著），下一個不召喚的古樹回合才出', () => withTree({ maxMinions: 4, summonPerPlayer: 1 }, () => {
  const m = garden(1, { seed: 6 });
  const eye = m.byId('eye');
  placeOn(m, m.players[0], 300, 420);   // 中台
  const plan = force('trunk', () => planTreeNext(m, eye));
  const want = JSON.stringify(plan);
  for (let k = 0; k < 2; k++) {   // 連續兩個召喚回合都留著
    const t = resolveTreeTurn(m, eye);
    assert(t.steps.map(s => s.action).join() === 'summon', 'solo summon turn: ' + t.steps.map(s => s.action));
    assert(m.mechState.next === plan && JSON.stringify(t.next) === want, 'the plan waits: ' + JSON.stringify(t.next));
  }
  shutMouth(m);   // 玩家打閉了嘴巴 → 古樹出預定的撞擊
  const t = resolveTreeTurn(m, eye);
  assert(t.steps.length === 1 && t.steps[0].action === 'trunk' && t.steps[0].plane === plan.plane, 'fires the waiting plan: ' + JSON.stringify(t.steps.map(s => [s.action, s.plane])));
  assert(m.mechState.next !== plan, 'replanned');
  return { plan };
}));

test('預定下一招（多人）：召喚的回合把預定的撞擊 / 落葉接在召喚後面一起出並重新預定；預定閉目養神就留著', () => withTree({ attackOnSummonMulti: true, summonPerPlayer: 1, maxMinions: 4 }, () => {
  const m = garden(2, { seed: 7 });
  const eye = m.byId('eye');
  let plan = m.mechState.next = { action: 'leaves' };
  const t1 = resolveTreeTurn(m, eye);
  assert(t1.steps.map(s => s.action).join() === 'summon,leaves' && t1.steps[1].shot, 'summon + planned leaves: ' + t1.steps.map(s => s.action));
  assert(m.mechState.next !== plan && JSON.stringify(t1.next) === JSON.stringify(m.mechState.next), 'replanned');
  plan = m.mechState.next = { action: 'trunk', plane: 0 };
  const t2 = resolveTreeTurn(m, eye);
  assert(t2.steps.map(s => s.action).join() === 'summon,trunk' && t2.steps[1].plane === 0, 'summon + planned trunk on its plane: ' + JSON.stringify(t2.steps.map(s => [s.action, s.plane])));
  assert(m.mechState.next !== plan, 'replanned after the trunk');
  // 預定的是閉目養神：召喚的回合只召喚，預定留著；下一個不召喚的回合才回血
  const g = garden(2, { seed: 7 });
  const geye = g.byId('eye');
  geye.hp -= 60;
  const med = g.mechState.next = { action: 'meditate' };
  const t3 = resolveTreeTurn(g, geye);
  assert(t3.steps.map(s => s.action).join() === 'summon' && g.mechState.next === med && t3.next.action === 'meditate', 'meditate waits: ' + t3.steps.map(s => s.action));
  shutMouth(g);
  const t4 = resolveTreeTurn(g, geye);
  assert(t4.steps.length === 1 && t4.steps[0].action === 'meditate' && t4.steps[0].heal > 0 && g.mechState.next !== med, 'meditate fires on the next non-summon turn');
  return { t1: t1.steps.map(s => s.action), t2: t2.steps.map(s => s.action) };
}));

test('飛散落葉不預告：預定裡沒有目標，出招時才挑離古樹最近的玩家', () => {
  const m = garden(2, { seed: 5 });
  shutMouth(m);
  const eye = m.byId('eye');
  const [p1, p2] = m.players;
  placeOn(m, p1, 560, 350);   // 高台，離古樹最近
  placeOn(m, p2, 40, 560);    // 地面最左邊
  const plan = force('leaves', () => planTreeNext(m, eye));
  assert(plan.action === 'leaves' && Object.keys(plan).join() === 'action', 'no target in the plan: ' + JSON.stringify(plan));
  placeOn(m, p1, 100, 560);   // 換位置：現在 p2 離古樹最近
  placeOn(m, p2, 560, 350);
  const b = firstStep(m, eye);
  assert(b.action === 'leaves' && b.targetId === 'p2', 'target picked at execution time: ' + b.targetId);
  return { target: b.targetId };
});

test('重新預定在招式結算完之後：照擊退 / 擊倒之後還活著的人與站位選平面（單人回合與多人召喚 + 撞擊都一樣）', () => withTree({ attackOnSummonMulti: true, summonPerPlayer: 1, maxMinions: 4 }, () => {
  const out = {};
  for (const summon of [false, true]) {
    const m = garden(3, { seed: 11 });
    if (!summon) shutMouth(m);
    const eye = m.byId('eye');
    const [p1, p2, p3] = m.players;
    placeOn(m, p1, 100, 480);   // 低台
    placeOn(m, p2, 160, 480);   // 低台
    placeOn(m, p3, 300, 540);   // 地面
    p1.hp = 1; p2.hp = 1;       // 低台的兩個人一撞就倒（不吃 config 的傷害值）
    assert(planeCounts(m).join() === '1,2,0,0', 'counts ' + planeCounts(m));
    const plan = force('trunk', () => planTreeNext(m, eye));
    assert(plan.plane === 1, 'planned on the low platform');
    const { steps, next } = force('trunk', () => resolveTreeTurn(m, eye));
    const acts = steps.map(s => s.action).join('+');
    assert(acts === (summon ? 'summon+trunk' : 'trunk') && steps.at(-1).plane === 1, 'executed: ' + acts);
    assert(!p1.alive && !p2.alive && p3.alive, 'the low platform got wiped out');
    // 結算完才重新預定：低台已經沒有活人 → 改掃地面上的 p3
    assert(next.action === 'trunk' && next.plane === 0 && m.mechState.next.plane === 0, 'replanned from the survivors: ' + JSON.stringify(next));
    out[summon ? 'summon' : 'solo'] = next;
  }
  return out;
}));

// 錄下 canvas 呼叫的假 ctx（記下呼叫當時的 fillStyle）；redBands 挑出紅色警示帶的 fillRect
function recordingCtx() {
  const calls = [];
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (...args) => { calls.push({ fn: k, style: o.fillStyle, args }); }) });
  return { ctx, calls };
}
const redBands = (calls) => calls.filter(c => c.fn === 'fillRect' && String(c.style).startsWith('rgba(239,68,68')).map(c => c.args.join());
const laneRect = (m, i) => { const l = trunkLane(m, i); return [l.x0, l.top, l.x1 - l.x0, l.bottom - l.top].join(); };

test('客戶端：預定撞擊時一直畫出那條警示帶（範圍 = trunkLane）；落葉 / 養神 / 發呆不畫；古樹出撞擊時只畫快閃；預定等古樹回合播完才換', () => {
  const m = garden(2, { seed: 4 });
  const eye = m.byId('eye');
  // 古樹之庭的地圖畫面（client/map-views/tree.js）；c = 掛勾拿到的那一小塊 GameView（特效出口什麼都不做）
  const tv = mapViewFor(m);
  assert(tv.type === 'tree', 'tree map view: ' + tv.type);
  const c = { match: m, time: 1.3, currentId: null, projectiles: [], state: tv.create(m),
    fx: { particles() {}, particle() {}, sound() {}, banner() {}, float() {}, shake() {}, splash() {}, wither() {} },
    *shotScript() { yield { frames: 1 }; } };
  const draw = () => { const r = recordingCtx(); tv.drawScene(r.ctx, c); return r; };
  // 玩家 / 樹妖的回合：預定撞擊 → 畫一條，範圍跟伺服器的樹幹一樣；虛線用完要還原
  m.mechState.next = { action: 'trunk', plane: 1 };
  const r = draw();
  assert(redBands(r.calls).join('|') === laneRect(m, 1), 'steady band = trunkLane: ' + redBands(r.calls));
  const dash = r.calls.filter(x => x.fn === 'setLineDash');
  assert(dash.length && dash.at(-1).args[0].length === 0, 'line dash reset');
  for (const action of ['leaves', 'meditate', 'idle']) {
    m.mechState.next = { action };
    assert(redBands(draw().calls).length === 0, `no band for ${action}`);
  }
  m.mechState.next = { action: 'trunk', plane: 1 };
  c.state.withered = true;   // 古樹倒下過（onDeath 設的）
  assert(redBands(draw().calls).length === 0, 'no band once withered');
  c.state.withered = false;
  eye.alive = false;
  assert(redBands(draw().calls).length === 0, 'no band with the eye dead');
  eye.alive = true;
  // 古樹的回合播撞擊：預兆時只有快閃（在出招的平面）、樹幹飛出去時不畫；全部播完才換成 boss.next 的預告
  const msg = { actorId: 'eye', boss: { steps: [{ action: 'trunk', plane: 1, shot: {} }], next: { action: 'trunk', plane: 2 } } };
  const seen = [];
  const gen = tv.turnScript(c, msg);
  for (let it = gen.next(); !it.done; it = gen.next()) {
    assert(m.mechState.next.plane === 1, 'the old plan stays during the tree turn');
    const fx = c.state.fx;
    const bands = redBands(draw().calls);
    const phase = !fx ? 'think' : fx.plane != null ? 'cast' : 'flight';
    assert(phase === 'flight' ? bands.length === 0 : bands.join('|') === laneRect(m, 1), `${phase}: ` + bands);
    if (seen.at(-1) !== phase) seen.push(phase);
    c.time += 1 / 60;
  }
  assert(seen.join() === 'think,cast,flight', 'phases ' + seen);
  assert(m.mechState.next.action === 'trunk' && m.mechState.next.plane === 2, 'boss.next applied at the end');
  assert(redBands(draw().calls).join('|') === laneRect(m, 2), 'the new band appears after the tree turn');
  return { phases: seen };
});

test('確定性：同 seed 同輸入，古樹之庭整段流程的廣播完全一樣', () => {
  const run = () => {
    const players = mkPlayers(3);
    const m = new Match({ levelId: 'treeGarden', players, seed: 99, stage: 6 });
    for (const p of m.players) { p.hp = p.maxHp = 3000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io });
    ref.start();
    ref.setConnected('p2', false);   // 斷線代打也要能打古樹
    let guard = 0;
    const rng = new Rng(7);
    while (ref.phase !== 'over' && guard++ < 1500) {
      io.advance(250);
      if (ref.phase === 'turn') {
        const a = m.byId(ref.currentId);
        const plan = planShot(m.world, a, rng);
        if (plan) ref.handle(a.id, { t: 'fire', weapon: plan.weapon, angle: plan.angle, power: plan.power, x: a.x, y: a.y, facing: a.facing, stamina: a.stamina });
      }
      if (io.t > 40 * 60_000) break;
    }
    return JSON.stringify(io.log.map(({ _except, ...x }) => x));
  };
  const a = run(), b = run();
  assert(a === b, 'two runs differ');
  const log = JSON.parse(a);
  const acts = log.filter(x => x.t === 'aiTurn' && x.boss).flatMap(x => x.boss.steps.map(s => s.action));
  return { bytes: a.length, treeActions: acts.length, kinds: [...new Set(acts)], result: (log.find(x => x.t === 'gameOver') || {}).result || 'running' };
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
