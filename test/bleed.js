// node test/bleed.js
// 流血（2026-10-14 使用者：「每一層流血，移動時都會扣除 0.01% 的血量，回合結束時移除」）：不分地圖的角色狀態（跟燃燒、中毒一樣，不是效果）。
// - 扣血的算法：每層每 px 扣最大血量 BLEED.pctPerPx%（照現在的上限）、小數累積、不閃白、死因 bleed、算進承受傷害；
//   哪些移動算（走路的水平距離含跳在空中按方向、爬藤蔓的上下距離、飄移的直線距離），哪些不算（擊退、跳起來 / 掉下去、走不動）
// - 命中時上層數（武器的 bleed）：誤傷、無敵、連結分到的那份、打倒的不上；傷害 0 也上；層數一直疊；同步欄位 bl 的位置、快照把小數歸零
// - 只在自己的回合結束時止血（fx、turn.end 紀錄、turnFx 的快照）；別人的回合結束不清；beginTurn 把這回合扣的歸零
// - 行動玩家回報的 hp：只在流血時收、只減不加、亂送的不收、位置被擋下也收、在落水 / 撿道具之前（淹不淹死跟他畫面上一樣）；
//   走路 / 開火時流血倒下 → turn.skip bleed（紀錄、慢動作補記 bleed、沒有射出去）；轉給別人的 move 在他流血時帶 hp
// - 流血扣的血與倒下算流血來源的（dealt、擊殺）：位置回報、AI 走路 / 飄移倒下；算到擊殺時的效果（例如噬魂者）照燒死那樣記（killedBy、fx）、飄字
// - 流血又落水的那一次回報：move / fire 紀錄的 hp 是落水之前的；斷線代打的玩家不會被 AI 走到流血倒下
// - 一波裡上的層數重播一致；真的 GameView：自己走路流血倒下送一次 hp 0 的 move、不能再動、「失血倒下」不顯示「跳過」；
//   別人看到的血量照轉來的 move、飄「-N」（畫面落後時也照順序，不被舊快照蓋回去）；命中的「流血 +N」、止血的「止血」；
//   AI 走路 / 蝙蝠飄移途中倒下在同一個地方倒下；自己的回合時間到就停下（不再流血），本地倒下又被伺服器的快照救回來時乾乾淨淨
// 武器測試自己掛兩把（複製狙擊槍 / 大砲加上 bleed，跑完拿掉；真的武器的數值使用者會調，西洋刺劍見 test/cards-1014.js）。血量、流血的設定都自己設（不受 config 影響）
import { CONFIG } from '../shared/core/config.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { Entity } from '../shared/physics/entities.js';
import { turnFxOps } from '../shared/cards/effects/index.js';
import { replayChecked } from './replay-check.js';

CONFIG.ENEMY.damageMult = 1;   // 照武器原本的傷害算
CONFIG.ENEMY.damageMultLate = 1;
CONFIG.BLEED.pctPerPx = 0.01;
// 測試用的武器（不吃 config 裡真的武器的數值）：直線的刺擊與會爆炸的砲彈
CONFIG.WEAPONS.testStab = { ...CONFIG.WEAPONS.sniper, id: 'testStab', name: '測試刺擊', bleed: 5 };
CONFIG.WEAPONS.testBlast = { ...CONFIG.WEAPONS.cannon, id: 'testBlast', name: '測試流血砲', bleed: 3 };

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
const STEP = CONFIG.FIXED_DT;
const close = (a, b) => Math.abs(a - b) < 1e-6;

class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.records = []; this.seq = 0; }
  broadcast(msg, exceptId) { this.log.push({ ...JSON.parse(J(msg)), _except: exceptId, at: this.t }); }
  record(ev, data) { this.records.push({ ev, ...data }); }
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
  recs(ev) { return this.records.filter(r => r.ev === ev); }
}
const until = (io, pred, max = 120_000) => { const s = io.t; while (!pred() && io.t - s < max) io.advance(50); return pred(); };
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
// 所有角色的血量自己設（不吃 config 的血量）
function mkMatch(levelId = 'level1', { players = 2, hp = 1000, seed = 1 } = {}) {
  const m = new Match({ levelId, players: mkPlayers(players), seed });
  for (const e of m.entities) { e.hp = e.maxHp = hp; }
  return m;
}
// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原
function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, { ...CONFIG[k] }]));
  for (const [k, v] of Object.entries(patch)) Object.assign(CONFIG[k], v);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) Object.assign(CONFIG[k], v); }
}
// 一回合輪到 p1 的裁判（敵人只發呆，不會把人打進水裡 / 改到血量）
function refAtP1(m, players = mkPlayers(m.players.length)) {
  m.planAiTurn = () => ({ walk: null, plan: null });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  return { io, ref };
}

await test('扣血的算法：每層每 px 扣最大血量 0.01%（5 層、150 血走 100px = 7.5 → 扣 7、留 0.5），小數累積；照現在的上限算；不閃白、算承受傷害；扣到 0 倒下（死因 bleed）', () => {
  const e = new Entity({ id: 'x', team: 'players', x: 100, y: 100, hp: 150, stamina: 100 });
  assert(e.bleedFor(100) === 0 && e.hp === 150, 'no stacks → nothing');
  e.bleed = 5;
  assert(e.bleedFor(100) === 7 && e.hp === 143 && close(e.bleedFrac, 0.5), `first 100px: hp ${e.hp} frac ${e.bleedFrac}`);
  assert(e.bleedFor(100) === 8 && e.hp === 135 && close(e.bleedFrac, 0), `second 100px: hp ${e.hp} frac ${e.bleedFrac}`);
  assert(e.taken === 15 && e.bledThisTurn === 15 && e.hurtTimer === 0, `taken ${e.taken} bled ${e.bledThisTurn} hurt ${e.hurtTimer}`);
  for (let i = 0; i < 13; i++) e.bleedFor(1);   // 每 px 0.075：13px = 0.975，還不到 1 點
  assert(e.hp === 135 && close(e.bleedFrac, 0.975), 'fractions add up: ' + e.bleedFrac);
  e.bleedFor(1);
  assert(e.hp === 134 && close(e.bleedFrac, 0.05), 'the 14th px crosses a whole point');
  e.maxHp = 100;   // 被中毒鎖住的上限：照現在的上限算
  e.bleedFrac = 0;
  assert(e.bleedFor(100) === 5 && e.hp === 129, 'uses the current max hp');
  assert(e.bleedFor(0) === 0 && e.bleedFor(-5) === 0 && e.bleedFor(NaN) === 0, 'no distance → nothing');
  e.hp = 3;
  e.bleed = 1000;
  const n = e.bleedFor(50);
  assert(n === 3 && e.hp === 0 && !e.alive && e.deathCause === 'bleed' && e.bledThisTurn === 24 && e.taken === 24, `death: ${J({ n, hp: e.hp, cause: e.deathCause, bled: e.bledThisTurn })}`);
  assert(e.bleedFor(50) === 0, 'dead → nothing');
  return { bled: e.bledThisTurn };
});

await test('哪些移動算：走路的水平距離（含跳在空中按方向）、爬藤蔓的上下距離；不算：站著跳、往下掉、被擊退、走不動（頂到邊）。流血不改變走到哪裡', () => {
  const m = mkMatch('level1', { players: 2, hp: 1000 });
  const [p, q] = m.players;
  for (const e of [p, q]) { e.x = 120; e.y = 300; e.stamina = e.maxStamina = 5000; }
  m.settle(600);
  p.bleed = 10;   // 1000 血：每 px 1 點
  const k = 10 * 0.0001 * 1000;
  const run = (n, setup) => { for (const e of [p, q]) setup(e); for (let i = 0; i < n; i++) { p.update(STEP, m.world); q.update(STEP, m.world); } };
  // 走路
  const x0 = p.x;
  run(40, (e) => { e.moveDir = 1; });
  const walked = Math.abs(p.x - x0);
  assert(walked > 60 && p.x === q.x && p.y === q.y, `walks the same as without bleeding: ${p.x} vs ${q.x}`);
  assert(close(p.bledThisTurn + p.bleedFrac, k * walked) && p.hp === 1000 - p.bledThisTurn && q.hp === 1000, `walk: bled ${p.bledThisTurn} + ${p.bleedFrac} for ${walked}px`);
  // 站著跳、落地（垂直移動不算）
  let b = p.bledThisTurn + p.bleedFrac;
  run(1, (e) => { e.moveDir = 0; e.wantJump = true; });
  run(90, () => {});
  assert(p.onGround && close(p.bledThisTurn + p.bleedFrac, b), 'jumping straight up and landing costs nothing');
  // 跳起來在空中按方向：照水平距離扣
  b = p.bledThisTurn + p.bleedFrac;
  let xa = p.x;
  run(1, (e) => { e.moveDir = 1; e.wantJump = true; });
  run(20, () => {});
  assert(!p.onGround && close(p.bledThisTurn + p.bleedFrac - b, k * Math.abs(p.x - xa)), 'air control counts the horizontal distance');
  run(90, (e) => { e.moveDir = 0; });
  // 被擊退、往下掉
  b = p.bledThisTurn + p.bleedFrac;
  xa = p.x;
  p.knockBack(1, -0.3, 250);
  run(90, () => {});
  assert(Math.abs(p.x - xa) > 10 && close(p.bledThisTurn + p.bleedFrac, b), 'knockback flight costs nothing');
  // 頂到地圖的邊：按著方向但走不動
  p.x = p.hw; p.y = 300; p.vy = 0;
  run(120, (e) => { e.moveDir = 0; });
  b = p.bledThisTurn + p.bleedFrac;
  run(30, (e) => { e.moveDir = -1; });
  assert(p.x === p.hw && close(p.bledThisTurn + p.bleedFrac, b), 'pushing against the edge costs nothing');
  // 爬藤蔓（叢林巨蟒）：上下的距離
  const j = mkMatch('jungleSerpent', { players: 1, hp: 1000 });
  const v = j.terrain.vines[0];
  const c = j.players[0];
  c.bleed = 10;
  c.x = v.x; c.y = 420; c.vy = 0; c.onGround = false; c.stamina = c.maxStamina = 5000;
  c.vineDir = -1;
  c.update(STEP, j.world);
  assert(c.onVine === 0, 'grabbed the vine');
  const y0 = c.y, bv = c.bledThisTurn + c.bleedFrac;
  for (let i = 0; i < 30; i++) c.update(STEP, j.world);
  const climbed = y0 - c.y;
  assert(c.onVine === 0 && climbed > 30 && close(c.bledThisTurn + c.bleedFrac - bv, k * climbed), `climbing: ${climbed}px, bled ${c.bledThisTurn + c.bleedFrac - bv}`);
  c.vineDir = 0;
  const bh = c.bledThisTurn + c.bleedFrac;
  for (let i = 0; i < 30; i++) c.update(STEP, j.world);
  assert(close(c.bledThisTurn + c.bleedFrac, bh), 'hanging still costs nothing');
  return { walked: Math.round(walked), climbed: Math.round(climbed) };
});

await test('走路流血扣到倒下：當下那一幀就停住（死因 bleed、放開方向鍵），不會再往前走或掉下去', () => {
  const m = mkMatch('level1', { players: 1, hp: 100 });
  const p = m.players[0];
  p.stamina = p.maxStamina = 5000;
  p.bleed = 200;   // 100 血、200 層：每 px 2 點；先扣成 5 血 → 走兩三步就倒下
  p.hp = 5;
  p.moveDir = 1;
  let n = 0;
  while (p.alive && n < 200) { p.update(STEP, m.world); n++; }
  const x = p.x, y = p.y;
  for (let i = 0; i < 30; i++) p.update(STEP, m.world);
  assert(!p.alive && p.deathCause === 'bleed' && p.moveDir === 0 && p.hp === 0 && p.x === x && p.y === y, `died after ${n} frames at ${x}`);
  // 跳在空中按方向、這一步扣到倒下：這一幀就停在那裡（不再往下掉、不會在倒下的這一幀掉進水裡）
  const q = mkMatch('level1', { players: 1, hp: 100 }).players[0];
  q.x = 440; q.y = 600; q.vy = 300; q.onGround = false; q.stamina = 100;
  q.bleed = 200; q.hp = 1; q.moveDir = 1;
  const y0 = q.y;
  q.update(STEP, { terrain: mkMatch('level1', { players: 1 }).terrain });
  assert(!q.alive && q.deathCause === 'bleed' && q.y === y0 && q.waterFalls === 0, `mid-air death frame: y ${q.y} vs ${y0}`);
  return { frames: n };
});

await test('命中時上層數（武器的 bleed）：記下流血來源、傷害清單帶 bleed、層數一直疊；傷害 0 也上；誤傷、無敵擋下、連結分到的那份、打倒的都不上', () => {
  const m = mkMatch('level1', { players: 2, hp: 1000 });
  const [p1, p2] = m.players;
  const e1 = m.byId('e1');
  const W = CONFIG.WEAPONS.testStab;
  let d = m.applyExplosion(p1.cx, p1.cy, W, e1, p1, { directOnly: true });
  assert(p1.bleed === 5 && p1.bleedSource === 'e1' && d[0].bleed === 5 && d[0].dmg > 0, 'enemy stab: ' + J(d));
  m.applyExplosion(p1.cx, p1.cy, W, e1, p1, { directOnly: true });
  assert(p1.bleed === 10, 'stacks add up: ' + p1.bleed);
  // 隊友誤傷：不上
  d = m.applyExplosion(p2.cx, p2.cy, W, p1, p2, { directOnly: true });
  assert(p2.bleed === 0 && d[0].friendly && !d[0].bleed, 'friendly fire: ' + J(d));
  // 傷害 0 的攻擊也上
  const zero = { ...W, damage: 0 };
  d = m.applyExplosion(e1.cx, e1.cy, zero, p1, e1, { directOnly: true });
  assert(e1.bleed === 5 && e1.bleedSource === 'p1' && d[0].dmg === 0 && d[0].bleed === 5, 'zero damage still bleeds: ' + J(d));
  // 無敵擋下：不上（無敵用掉）
  p2.shield = 1;
  d = m.applyExplosion(p2.cx, p2.cy, W, e1, p2, { directOnly: true });
  assert(p2.bleed === 0 && p2.shield === 0 && d[0].blocked && !d[0].bleed, 'shield: ' + J(d));
  // 攜手之伴：被打的人上流血，分到那份的不上
  p1.links = ['p2']; p2.links = ['p1'];
  p1.bleed = 0;
  d = m.applyExplosion(p1.cx, p1.cy, W, e1, p1, { directOnly: true });
  const share = d.find(x => x.shared === 'p1');
  assert(p1.bleed === 5 && p2.bleed === 0 && share && share.dmg > 0 && !share.bleed, 'link share: ' + J(d));
  // 一下打倒：不上
  e1.hp = 1;
  e1.bleed = 0;
  d = m.applyExplosion(e1.cx, e1.cy, W, p1, e1, { directOnly: true });
  assert(!e1.alive && e1.bleed === 0 && !d[0].bleed, 'killed by the hit: ' + J(d));
  // 爆炸波及的也上（不是直擊）
  const e2 = m.byId('e2');
  d = m.applyExplosion(e2.x + 15, e2.y - 2, CONFIG.WEAPONS.testBlast, p1, null, {});
  assert(e2.bleed === 3 && d.find(x => x.id === 'e2').bleed === 3, 'splash: ' + J(d));
  return { stacks: p1.bleed };
});

await test('同步：bl 排在 lk 後面（toState）、ps 後面（toEventState）；applyState / applyEventState 套 bl（沒帶不動）；套快照把流血的小數歸零', () => {
  const m = mkMatch();
  const p = m.players[0];
  p.bleed = 7;
  p.bleedFrac = 0.6;
  const s = p.toState();
  const keys = Object.keys(s);
  assert(keys.indexOf('bl') === keys.indexOf('lk') + 1 && s.bl === 7, 'toState: ' + keys);
  const ev = p.toEventState();
  const ek = Object.keys(ev);
  assert(ek.indexOf('bl') === ek.indexOf('ps') + 1 && ev.bl === 7, 'toEventState: ' + ek);
  const q = m.players[1];
  q.bleedFrac = 0.9;
  q.applyState(s);
  assert(q.bleed === 7 && q.bleedFrac === 0, `applyState: ${q.bleed} frac ${q.bleedFrac}`);
  q.applyState({ ...s, bl: undefined });
  assert(q.bleed === 7, 'missing bl leaves it alone');
  q.applyEventState({ ...ev, bl: 3 });
  assert(q.bleed === 3, 'applyEventState');
  assert(!('bleedFrac' in s) && !('bleedSource' in s) && !Object.keys(s).some(k => /bled/.test(k)), 'fractions / source / per-turn total are not synced');
  return { keys: keys.length };
});

await test('止血：只在流血的人自己的回合結束時（fx { type: bleed, id, stacks, dmg }，turn.end 有記、turnFx 的快照 bl = 0）；別人的回合結束不清；beginTurn 把這回合流血扣的歸零', () => {
  const m = mkMatch();
  const [p1, p2] = m.players;
  p1.bleed = 4; p1.bledThisTurn = 9; p1.bleedFrac = 0.3;
  p2.bleed = 6;
  const fx = m.endTurn(p1);
  const f = fx.find(x => x.type === 'bleed');
  assert(f && f.id === 'p1' && f.stacks === 4 && f.dmg === 9 && p1.bleed === 0 && p1.bleedFrac === 0, 'own turn end: ' + J(fx));
  assert(p2.bleed === 6 && !m.endTurn(m.byId('e1')).some(x => x.type === 'bleed') && p2.bleed === 6, 'other turn ends leave it');
  assert(!m.endTurn(p1).some(x => x.type === 'bleed'), 'nothing to stop → no fx');
  m.beginTurn(p2);
  assert(p2.bledThisTurn === 0 && p2.bleed === 6, 'beginTurn resets the per-turn total only');
  // 回合結束先被燒死：層數照樣清掉，但不飄「止血」
  p2.burn = 100000; p2.hp = 1; p2.burnFrac = 0;
  const burnt = m.endTurn(p2);
  assert(!p2.alive && burnt.some(x => x.type === 'burn') && !burnt.some(x => x.type === 'bleed') && p2.bleed === 0, 'burnt to death first: ' + J(burnt));
  // 裁判：p1 帶著流血走一段、開火，回合結束止血
  const n = mkMatch();
  n.byId('p1').bleed = 3;
  const { io, ref } = refAtP1(n);
  const a = n.byId('p1');
  ref.handle('p1', { t: 'move', x: a.x + 10, y: a.y, facing: 1, stamina: a.stamina, hp: a.hp - 2 });
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 80, power: 20, x: a.x, y: a.y, facing: 1, stamina: a.stamina });
  assert(until(io, () => io.take('turnFx').length > 0), 'turnFx');
  const tf = io.take('turnFx')[0];
  const end = io.recs('turn.end')[0];
  assert(tf.fx.some(x => x.type === 'bleed' && x.id === 'p1' && x.stacks === 3 && x.dmg === 2) && tf.entities.find(s => s.id === 'p1').bl === 0, 'turnFx: ' + J(tf.fx));
  assert(end.fx.some(x => x.type === 'bleed' && x.dmg === 2), 'turn.end log: ' + J(end));
  return { fx: f };
});

await test('位置回報的 hp：只在流血時收、只減不加、四捨五入、亂送的不收；位置被擋下也照收；扣的算這回合流血扣的與承受傷害；扣到 0 就倒在回報的地方（不撿、不落水）', () => {
  const m = mkMatch('level1', { players: 1, hp: 1000 });
  const p = m.players[0];
  const at = (dx, extra) => m.applyPositionReport(p, { x: p.x + dx, y: p.y, facing: 1, stamina: p.stamina, ...extra });
  let r = at(2, { hp: 900 });
  assert(r.ok && r.bled === 0 && p.hp === 1000, 'not bleeding → hp ignored');
  p.bleed = 2;
  r = at(2, { hp: 990.4 });
  assert(r.ok && r.bled === 10 && p.hp === 990 && p.bledThisTurn === 10 && p.taken === 10, 'bleeding → accepted: ' + J(r));
  r = at(2, { hp: 999 });
  assert(r.bled === 0 && p.hp === 990, 'never goes up');
  for (const hp of [NaN, '5', null, { big: 1 }, [3], Infinity, undefined]) {
    r = at(1, { hp });
    assert(r.ok && r.bled === 0 && p.hp === 990, 'junk hp ignored: ' + J(hp));
  }
  const x0 = p.x;
  r = m.applyPositionReport(p, { x: p.x + 600, y: p.y, facing: 1, stamina: p.stamina, hp: 980 });
  assert(!r.ok && r.bled === 10 && p.hp === 980 && p.x === x0, 'rejected position, hp still taken: ' + J(r));
  r = at(3, { hp: -40 });
  assert(r.ok && r.bled === 980 && !p.alive && p.deathCause === 'bleed' && p.x === x0 + 3 && !r.water && !r.pickup, 'bled out where he reported: ' + J(r));
  // 掉進水的回報：倒下之後不落水
  const w = mkMatch('level1', { players: 1, hp: 1000 });
  const q = w.players[0];
  q.bleed = 1;
  q.x = 360;   // 崖邊（回報的位置離這裡不到 400px，收得下）
  const safe = { x: q.x, y: q.y };
  r = w.applyPositionReport(q, { x: 440, y: 700, facing: 1, stamina: q.stamina, hp: 0, safe });
  assert(r.ok && !q.alive && q.deathCause === 'bleed' && !r.water && q.waterFalls === 0 && q.taken === 1000, 'bled out above the water: no splash ' + J(r));
  return { hp: p.hp };
});

await test('落水那次回報帶落水之前的血量：伺服器先照它扣流血、再扣同樣的落水傷害——客戶端走路流血之後掉水淹死，伺服器也淹死（只看舊的血量會撐住）', () => withConfig({ WATER: { damagePct: 30, enemiesDrown: true, safeMargin: 10 } }, () => {
  const out = [];
  for (const [hp0, wantDead] of [[320, true], [420, false]]) {
    const ms = mkMatch('level1', { players: 1, hp: 1000 });
    const mc = mkMatch('level1', { players: 1, hp: 1000 });
    const ps = ms.players[0], pc = mc.players[0];
    for (const [m, e] of [[ms, ps], [mc, pc]]) { e.x = 330; e.y = 300; e.stamina = e.maxStamina = 5000; m.settle(600); e.hp = hp0; e.bleed = 10; }
    // 客戶端：本地物理往右走下崖、掉進水裡；每 6 幀回報一次（帶 hp），掉水的那一次照 reportWater 帶 splash 的 hp
    pc.moveDir = 1;
    let f = 0, report = null;
    while (pc.waterFalls === 0 && f < 400) {
      pc.update(STEP, mc.world);
      f++;
      if (pc.waterFalls > 0) {
        const s = pc.splash;
        report = ms.applyPositionReport(ps, { x: s.x, y: s.y, facing: pc.facing, stamina: pc.stamina, safe: { x: s.sx, y: s.sy }, hp: s.hp });
      } else if (f % 6 === 0) {
        ms.applyPositionReport(ps, { x: pc.x, y: pc.y, vy: pc.vy, facing: pc.facing, stamina: pc.stamina, hp: pc.hp });
      }
    }
    assert(report && report.water, `${hp0}: fell in the water`);
    assert(pc.splash.hp < hp0 && pc.splash.hp > 300 === !wantDead, `${hp0}: client bled to ${pc.splash.hp} before the water`);
    assert(ps.hp === pc.hp && ps.alive === pc.alive && pc.alive === !wantDead && ps.deathCause === pc.deathCause, `${hp0}: server hp ${ps.hp} ${ps.alive} vs client ${pc.hp} ${pc.alive}`);
    out.push({ hp0, before: pc.splash.hp, after: pc.hp, alive: pc.alive });
  }
  return out;
}));

await test('裁判：走路時回報流血扣的血 → move 紀錄帶 hp / bled、轉給別人的 move 帶 hp（沒在流血就不帶）；扣到倒下 → turn.skip bleed（changes 有 died: bleed、慢動作補記 why bleed），不能再操作', () => {
  const m = mkMatch('level1', { players: 2, hp: 1000 });
  const { io, ref } = refAtP1(m);
  const p = m.byId('p1');
  const mv = (extra) => ref.handle('p1', { t: 'move', x: p.x + 2, y: p.y, facing: 1, stamina: p.stamina, ...extra });
  mv({ hp: 950 });
  let relay = io.take('move').at(-1);
  assert(p.hp === 1000 && !('hp' in relay) && !('hp' in io.recs('move').at(-1)), 'not bleeding: hp ignored, not relayed');
  p.bleed = 4;
  mv({ hp: 990 });
  relay = io.take('move').at(-1);
  const rec = io.recs('move').at(-1);
  assert(relay.hp === 990 && relay._except === 'p1' && rec.hp === 990 && rec.bled === 10, `relayed / logged: ${J(relay)} ${J(rec)}`);
  mv({ hp: 990 });
  assert(!('bled' in io.recs('move').at(-1)) && io.take('move').at(-1).hp === 990, 'nothing new bled → no bled in the log, still relays hp');
  ref.handle('p1', { t: 'slow', on: true });
  mv({ hp: 0 });
  const skip = io.take('skip').at(-1);
  const ts = io.recs('turn.skip').at(-1);
  const slow = io.recs('slowmo').at(-1);
  assert(!p.alive && p.deathCause === 'bleed' && skip && skip.reason === 'bleed' && skip.actorId === 'p1', 'skip(bleed): ' + J(skip));
  assert(ts.reason === 'bleed' && ts.changes.some(c => c.id === 'p1' && c.died === 'bleed' && c.hp[0] === 990 && c.hp[1] === 0), 'turn.skip log: ' + J(ts));
  assert(slow && slow.on === false && slow.auto && slow.why === 'bleed', 'slowmo closed: ' + J(slow));
  assert(io.recs('move').at(-1).bled === 990 && io.take('move').at(-1).hp === 990, 'the lethal move is logged, not relayed (the skip snapshot carries the death)');
  assert(ref.phase === 'resolving', 'turn over: ' + ref.phase);
  // 位置被擋下的那一筆把他扣到倒下：一樣結束這回合（move.reject 帶 hp / bled）
  const m2 = mkMatch('level1', { players: 2, hp: 1000 });
  const r2 = refAtP1(m2);
  const q = m2.byId('p1');
  q.bleed = 1;
  r2.ref.handle('p1', { t: 'move', x: q.x + 900, y: q.y, facing: 1, stamina: q.stamina, hp: 0 });
  const rej = r2.io.recs('move.reject').at(-1);
  assert(!q.alive && rej && rej.bled === 1000 && rej.hp === 0 && r2.io.take('skip').at(-1).reason === 'bleed', 'rejected + bled out: ' + J(rej));
  return { skip: skip.reason };
});

await test('裁判：開火那一刻回報的血量把他扣到倒下 → 這一發沒射出去，turn.skip bleed（fire 紀錄帶 hp / bled）；沒倒下照常開火（shot.actor.hp 是扣完的）', () => {
  const m = mkMatch('level1', { players: 2, hp: 1000 });
  const { io, ref } = refAtP1(m);
  const p = m.byId('p1');
  p.bleed = 2;
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: p.x, y: p.y, facing: 1, stamina: p.stamina, hp: 0 });
  const fire = io.recs('fire').at(-1);
  assert(!p.alive && p.deathCause === 'bleed' && !io.take('shot').length && io.take('skip').at(-1).reason === 'bleed', 'no shot, skip(bleed)');
  assert(fire && fire.bled === 1000 && fire.hp === 0 && io.recs('turn.skip').at(-1).reason === 'bleed', 'fire log: ' + J(fire));
  const m2 = mkMatch('level1', { players: 2, hp: 1000 });
  const r2 = refAtP1(m2);
  const q = m2.byId('p1');
  q.bleed = 2;
  r2.ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 80, power: 20, x: q.x, y: q.y, facing: 1, stamina: q.stamina, hp: 977 });
  const shot = r2.io.take('shot').at(-1);
  assert(q.alive && shot && shot.actor.hp === 977 && r2.io.recs('fire').at(-1).bled === 23, 'fires with the bled hp: ' + J(shot && shot.actor));
  // 出手的位置在水裡、淹死（不是流血倒下）：照舊是 water
  withConfig({ WATER: { damagePct: 30, enemiesDrown: true, safeMargin: 10 } }, () => {
    const m3 = mkMatch('level1', { players: 2, hp: 1000 });
    const r3 = refAtP1(m3);
    const w = m3.byId('p1');
    w.x = 360; w.hp = 200; w.bleed = 2;
    r3.ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: 440, y: 700, facing: 1, stamina: w.stamina, hp: 190 });
    assert(!w.alive && w.deathCause === 'water' && r3.io.take('skip').at(-1).reason === 'water' && !r3.io.take('shot').length, 'drowned firing: skip(water)');
  });
  return { fired: !!shot };
});

await test('裁判：同一次回報流血又掉進水裡（走進水裡 / 在水裡開火、撐住了）：move / fire 紀錄的 hp 是流血扣完、落水之前的，落水扣的另外記在 water', () => withConfig({ WATER: { damagePct: 30, enemiesDrown: true, safeMargin: 10 } }, () => {
  const out = {};
  for (const t of ['move', 'fire']) {
    const m = mkMatch('level1', { players: 2, hp: 1000 });
    const { io, ref } = refAtP1(m);
    const p = m.byId('p1');
    p.x = 360;   // 崖邊（下面在水裡的回報離這裡不到 400px，收得下）
    p.bleed = 5;
    const at = { x: 440, y: 700, facing: 1, stamina: p.stamina, hp: 990 };   // 流血扣了 10、接著掉進水裡（扣最大血量 30% = 300）
    ref.handle('p1', t === 'move' ? { t, ...at, safe: { x: p.x, y: p.y } } : { t, weapon: 'cannon', angle: 45, power: 50, ...at });
    const rec = io.recs(t).at(-1), water = io.recs('water').at(-1);
    assert(p.alive && water && water.dmg === 300 && water.hp === 690 && p.hp === 690, `${t}: fell in the water and survived ${J(water)}`);
    assert(rec && rec.bled === 10 && rec.hp === 990, `${t} record: hp after the bleed, before the water ${J(rec)}`);
    out[t] = { hp: rec.hp, water: water.hp };
  }
  return out;
}));

await test('流血來源：流血扣的血算他造成的傷害（打敵方才算），扣到倒下算他的擊殺——行動玩家的位置回報、AI 走路、蝙蝠飄移', () => withConfig({
  ENEMY: { moveChance: 1 }, BAT: { moveChance: 1 },
  AI_MOVE: { dist: [30, 80], minDist: 20, maxFrames: 90, keepDir: 0.65, edge: 8, maxDrop: 40, allyGap: 56, glideTries: 12, takeoverChance: 0.6 },
}, () => {
  // 位置回報：敵人讓玩家流血
  const m = mkMatch('level1', { players: 1, hp: 1000 });
  const p = m.players[0], e1 = m.byId('e1');
  m.applyExplosion(p.cx, p.cy, CONFIG.WEAPONS.testStab, e1, p, { directOnly: true });
  const dealt0 = e1.dealt;
  m.applyPositionReport(p, { x: p.x + 2, y: p.y, facing: 1, stamina: p.stamina, hp: p.hp - 12 });
  assert(e1.dealt === dealt0 + 12, `dealt ${e1.dealt - dealt0}`);
  m.applyPositionReport(p, { x: p.x + 2, y: p.y, facing: 1, stamina: p.stamina, hp: 0 });
  assert(!p.alive && e1.kills === 1, 'the bleed death is the source\'s kill: ' + e1.kills);
  // AI 走路：玩家讓敵人流血，敵人走一段扣血、扣到倒下
  const out = { walkDied: 0, walkLost: 0, glideDied: 0 };
  for (let seed = 1; seed <= 8; seed++) {
    for (const stacks of [30, 400]) {
      const n = mkMatch('level1', { players: 1, hp: 100, seed });
      const a = n.players[0], e = n.byId('e1');
      n.beginTurn(e);
      e.bleed = stacks;
      e.bleedSource = 'p1';
      const d0 = a.dealt;
      const r = n.planAiTurn(e);
      if (!r.walk) continue;
      assert(a.dealt - d0 === e.bledThisTurn && e.bledThisTurn > 0, `seed ${seed}/${stacks}: dealt ${a.dealt - d0} vs bled ${e.bledThisTurn}`);
      if (e.alive) { out.walkLost++; assert(r.plan, `seed ${seed}: survived → still plans a shot`); }
      else {
        out.walkDied++;
        assert(e.deathCause === 'bleed' && !r.plan && !r.boss && a.kills === 1, `seed ${seed}: died walking → no shot, kill to p1 (${a.kills})`);
      }
    }
    // 蝙蝠（岩穴）：照飄的直線距離扣（10 層、1000 血：每 px 1 點）
    const g = mkMatch('cave', { players: 1, hp: 1000, seed });
    const gb = g.enemies.find(x => x.kind === 'bat');
    g.beginTurn(gb);
    gb.bleed = 10;
    const rg = g.planAiTurn(gb);
    if (rg.glide) {
      out.glides = (out.glides || 0) + 1;
      assert(gb.alive && close(gb.bledThisTurn + gb.bleedFrac, Math.hypot(rg.glide.dx, rg.glide.dy)), `bat seed ${seed}: bled ${gb.bledThisTurn + gb.bleedFrac} for ${J(rg.glide)}`);
    }
    // 蝙蝠：扣到倒下就不開火
    const c = mkMatch('cave', { players: 1, hp: 100, seed });
    const a = c.players[0], bat = c.enemies.find(x => x.kind === 'bat');
    c.beginTurn(bat);
    bat.bleed = 2000;
    bat.bleedSource = 'p1';
    const r = c.planAiTurn(bat);
    if (r.glide && !bat.alive) {
      out.glideDied++;
      assert(bat.deathCause === 'bleed' && !r.plan && a.kills === 1 && a.dealt === bat.bledThisTurn, `bat seed ${seed}: ${J({ kills: a.kills, dealt: a.dealt })}`);
    }
  }
  assert(out.walkDied >= 2 && out.walkLost >= 2 && out.glideDied >= 2 && out.glides >= 3, 'not enough cases: ' + J(out));
  return out;
}));

await test('斷線代打的玩家在流血：AI 不選試走時會流血扣到倒下（或只剩 1 點）的停點——走短一點，或這回合乾脆不走，一定活著開火（敵人照走，途中倒下見上一個測試）', () => withConfig({
  AI_MOVE: { dist: [30, 80], minDist: 20, maxFrames: 90, keepDir: 0.65, edge: 8, maxDrop: 40, allyGap: 56, glideTries: 12, takeoverChance: 1 },
}, () => {
  const out = { walked: 0, still: 0, minHp: Infinity };
  for (let seed = 1; seed <= 60; seed++) {
    // 150 血、20 層：每 px 0.3 點；剩 10 血 → 走 33px 就倒下（想走 30~80px）
    const m = mkMatch('level1', { players: 2, hp: 150, seed });
    const p = m.players[0];
    m.settle(600);
    m.beginTurn(p);
    p.hp = 10;
    p.bleed = 20;
    const r = m.planAiTurn(p);
    assert(p.alive && r.plan && (p.hp === 10 || p.hp > 1), `seed ${seed}: ${J({ alive: p.alive, hp: p.hp, walk: r.walk, plan: !!r.plan })}`);
    if (r.walk) { out.walked++; out.minHp = Math.min(out.minHp, p.hp); } else out.still++;
  }
  assert(out.walked >= 10 && out.minHp < 10, 'still walks (a shorter cut) when a safe one exists: ' + J(out));
  // 每 px 扣 30 點：走哪一段都會倒下 → 這回合不走，站著開火
  for (let seed = 1; seed <= 20; seed++) {
    const m = mkMatch('level1', { players: 2, hp: 150, seed });
    const p = m.players[0];
    m.settle(600);
    m.beginTurn(p);
    p.hp = 20;
    p.bleed = 2000;
    const x0 = p.x;
    const r = m.planAiTurn(p);
    assert(!r.walk && p.alive && p.hp === 20 && p.x === x0 && r.plan, `seed ${seed}: every cut kills him → stays put ${J({ walk: r.walk, hp: p.hp })}`);
  }
  return out;
}));

await test('一波裡上的層數重播一致：玩家用會流血的武器打敵人，事件帶 bleed 與受影響角色的 bl，客戶端照事件重播到結果之前就跟伺服器一樣', () => {
  const out = [];
  for (const wid of ['testStab', 'testBlast']) {
    const m = mkMatch('level1', { players: 2, hp: 1000 });
    const [p1, p2] = m.players, e1 = m.byId('e1');
    p2.x = 320; e1.x = 220;
    m.settle(600);
    const snap = JSON.parse(J(m.snapshot()));
    const mz = p1.muzzle();
    const angle = Math.atan2(-(e1.cy - mz.y), e1.cx - mz.x) * 180 / Math.PI;
    const shot = JSON.parse(J(m.resolveShot(p1, wid, angle, wid === 'testStab' ? 100 : 45)));
    const ev = shot.events.find(x => x.damages && x.damages.some(d => d.id === 'e1'));
    if (wid === 'testStab') assert(ev && ev.damages.find(d => d.id === 'e1').bleed === 5 && ev.ents.find(s => s.id === 'e1').bl === 5, 'stab event: ' + J(ev));
    const c = new Match({ levelId: 'level1', players: mkPlayers(2), seed: 1 });
    c.applySnapshot(snap);
    replayChecked(c, shot, wid);
    for (const e of m.entities) {
      const ce = c.byId(e.id);
      assert(ce.bleed === e.bleed && ce.hp === e.hp && ce.alive === e.alive, `${wid} ${e.id}: client bleed ${ce.bleed} hp ${ce.hp} vs server ${e.bleed} ${e.hp}`);
    }
    out.push({ wid, e1: e1.bleed });
  }
  assert(out.every(o => o.e1 > 0), 'the enemy was hit: ' + J(out));
  return out;
});

// ---- 真的 GameView（Node 裡、假 canvas；同 test/map-views.js）----
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
function newView(myId) {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = myId;
  view.transport = { send() {} };
  view.banners = [];
  const show = view.showBanner.bind(view);
  view.showBanner = (str, ...rest) => { view.banners.push(str); show(str, ...rest); };
  return view;
}
// 伺服器廣播的訊息交給畫面（exceptId 是他自己的就不給）
const feed = (view, msgs) => { for (const { _except, at, ...msg } of msgs) if (_except !== view.myId) view.onMessage(JSON.parse(J(msg))); };
const idle = (view) => !view.script && !view.queue.length;
const drain = (view, n = 3000) => { for (let f = 0; f < n && !idle(view); f++) { view.update(STEP); view.render(); } };

await test('真的 GameView：自己的回合走路流血——邊走邊飄「-N」、滴血，伺服器收到的血量跟畫面一樣；扣到倒下馬上送一次 hp 0 的 move、不能再動，「失血倒下了」、沒有「跳過」；別人的畫面照轉來的 move 顯示血量與「-N」', () => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'level1', players, seed: 1 });
  for (const e of m.entities) { e.hp = e.maxHp = 300; e.maxStamina = 5000; }
  m.byId('p1').bleed = 50;   // 300 血：每 px 1.5 點 → 走 200px 倒下（還沒走到崖邊）
  m.planAiTurn = () => ({ walk: null, plan: null });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  const me = newView('p1'), other = newView('p2');
  const sent = [];
  me.transport = { send: (msg) => { sent.push(JSON.parse(J(msg))); ref.handle('p1', JSON.parse(J(msg))); } };
  ref.start();
  let k = 0;
  const pump = () => { const msgs = io.log.splice(0); feed(me, msgs); feed(other, msgs); };
  assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  pump();
  drain(me); drain(other);
  assert(me.canAct && me.me.bleed === 50, 'my turn, bleeding: ' + J({ canAct: me.canAct, bl: me.me.bleed }));
  me.keys.KeyD = true;
  const mine = me.me, seen = other.match.byId('p1');
  let floats = 0, drips = 0, deadAt = -1, seenFloats = 0, seenMin = Infinity;
  for (k = 0; k < 400 && deadAt < 0; k++) {
    me.update(STEP); me.render();
    other.update(STEP); other.render();
    pump();
    floats = Math.max(floats, me.floatTexts.filter(f => /^-\d+$/.test(f.text) && f.color === '#ef4444').length);
    drips = Math.max(drips, me.particles.filter(p => p.color === '#dc2626').length);
    seenFloats = Math.max(seenFloats, other.floatTexts.filter(f => f.id === 'p1' && /^-\d+$/.test(f.text)).length);
    if (seen.alive) seenMin = Math.min(seenMin, seen.hp);
    if (!mine.alive) deadAt = k;
    else if (sent.length) assert(m.byId('p1').hp === sent.at(-1).hp, `frame ${k}: server hp ${m.byId('p1').hp} vs reported ${sent.at(-1).hp}`);
  }
  assert(deadAt > 0 && mine.deathCause === 'bleed' && floats > 0 && drips > 0, `died at frame ${deadAt}: floats ${floats}, drips ${drips}`);
  const after = sent.filter(s => s.hp === 0);
  assert(after.length === 1 && sent.at(-1).hp === 0 && !me.canAct, 'one final move with hp 0: ' + J(sent.slice(-3)));
  for (let f = 0; f < 60; f++) { me.update(STEP); other.update(STEP); pump(); }
  assert(sent.filter(s => s.hp === 0).length === 1 && sent.at(-1).hp === 0, 'nothing sent after the death');
  const sp = m.byId('p1');
  assert(!sp.alive && sp.deathCause === 'bleed' && io.recs('turn.skip').at(-1).reason === 'bleed', 'server: bled out, skip(bleed)');
  drain(me); drain(other);
  assert(me.banners.includes('P1 失血倒下了！') && !me.banners.some(b => /跳過/.test(b)), 'my banners: ' + me.banners);
  assert(!seen.alive && other.banners.includes('P1 失血倒下了！') && !other.banners.some(b => /跳過/.test(b)), 'their banners: ' + other.banners);
  assert(seenFloats > 0 && seenMin < 300, `the other screen followed the relayed hp: lowest ${seenMin}, floats ${seenFloats}`);
  return { frames: deadAt, sent: sent.length };
});

await test('真的 GameView：流血走下崖（空中還按著方向，一路扣血）掉進水裡：reportWater 帶落水之前的血量，伺服器扣完落水跟畫面上一模一樣，回合繼續', () => withConfig({ WATER: { damagePct: 30, enemiesDrown: true, safeMargin: 10 } }, () => {
  const players = mkPlayers(1);
  // 走得慢（40px/s）：從崖邊掉下去的途中只往前飄 30px 左右，一定掉進水裡（不會落到對面）
  const m = new Match({ levelId: 'level1', players, seed: 1, carry: { p1: { hp: 1000, maxHp: 1000, maxStamina: 5000, moveSpeed: 40 } } });
  for (const e of m.enemies) { e.hp = e.maxHp = 1000; }
  const p = m.byId('p1');
  p.x = 330; p.y = 300;
  m.settle(600);
  p.bleed = 50;   // 1000 血：每 px 5 點
  m.planAiTurn = () => ({ walk: null, plan: null });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  const me = newView('p1');
  const sent = [];
  me.transport = { send: (msg) => { sent.push(JSON.parse(J(msg))); ref.handle('p1', JSON.parse(J(msg))); } };
  ref.start();
  assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  feed(me, io.log.splice(0));
  drain(me);
  const mine = me.me;
  assert(me.canAct && mine.bleed === 50 && mine.moveSpeed === 40, 'ready');
  me.keys.KeyD = true;
  for (let k = 0; k < 600 && mine.waterFalls === 0; k++) { me.update(STEP); feed(me, io.log.splice(0)); }
  const w = sent.find(s => s.safe);
  const sp = m.byId('p1');
  assert(mine.waterFalls === 1 && mine.alive && w && w.hp === mine.splash.hp && w.hp === mine.hp + mine.splash.dmg, 'water report: ' + J({ w, splash: mine.splash, hp: mine.hp }));
  const lastWalk = sent.filter(s => !s.safe).at(-1);
  assert(lastWalk.hp > w.hp, `still bleeding right up to the splash (last move ${lastWalk.hp}, splash ${w.hp})`);
  assert(sp.alive && sp.hp === mine.hp && sp.waterFalls === 1 && ref.phase === 'turn', `server hp ${sp.hp} vs client ${mine.hp}`);
  return { before: w.hp, after: mine.hp };
}));

await test('真的 GameView：別人的 move 帶 hp 就照著顯示（少掉的飄「-N」、滴血），沒帶就不動；命中的「流血 +N」；回合結束的「止血」', () => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'level1', players, seed: 1 });
  for (const e of m.entities) { e.hp = e.maxHp = 1000; }
  const [p1, p2] = m.players, e1 = m.byId('e1');
  p2.x = 320; e1.x = 220;
  m.settle(600);
  p1.weapons.push('testStab');
  p1.bleed = 2;
  m.planAiTurn = () => ({ walk: null, plan: null });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  const other = newView('p2');
  ref.start();
  assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  feed(other, io.log.splice(0));
  drain(other);
  const seen = other.match.byId('p1');
  other.onMessage({ t: 'move', id: 'p1', x: seen.x + 1, y: seen.y, facing: 1, stamina: 100 });
  assert(seen.hp === 1000, 'a move without hp leaves it alone');
  ref.handle('p1', { t: 'move', x: p1.x + 3, y: p1.y, facing: 1, stamina: p1.stamina, hp: 993 });
  feed(other, io.log.splice(0));
  assert(seen.hp === 993, 'observer hp follows the relayed move: ' + seen.hp);
  for (let f = 0; f < 40; f++) other.update(STEP);
  assert(other.floatTexts.some(f => f.text === '-7' && f.color === '#ef4444'), 'floats -7: ' + J(other.floatTexts.map(f => f.text)));
  const mz = p1.muzzle();
  const angle = Math.atan2(-(e1.cy - mz.y), e1.cx - mz.x) * 180 / Math.PI;
  ref.handle('p1', { t: 'fire', weapon: 'testStab', angle, power: 100, x: p1.x, y: p1.y, facing: 1, stamina: p1.stamina, hp: 993 });
  assert(e1.bleed === 5, 'the stab bled e1');
  assert(until(io, () => io.take('turnFx').length > 0), 'turn end');
  const texts = [];
  const float = other.floatText.bind(other);
  other.floatText = (e, str, ...rest) => { texts.push(`${e.id}:${str}`); float(e, str, ...rest); };
  feed(other, io.log.splice(0));
  drain(other);
  assert(texts.includes('e1:流血 +5') && texts.includes('p1:止血'), 'floats: ' + texts);
  assert(seen.bleed === 0 && other.match.byId('e1').bleed === 5, 'stacks after the turn');
  return { texts };
});

await test('真的 GameView：AI 走路 / 蝙蝠飄移途中流血倒下（伺服器不讓他開火、出招），客戶端照 aiTurn 播到同一個地方、同一刻倒下，「失血倒下了」', () => withConfig({
  ENEMY: { moveChance: 1 }, BAT: { moveChance: 1 },
  AI_MOVE: { dist: [30, 80], minDist: 20, maxFrames: 90, keepDir: 0.65, edge: 8, maxDrop: 40, allyGap: 56, glideTries: 12, takeoverChance: 0.6 },
}, () => {
  const out = { walk: 0, glide: 0 };
  for (const [levelId, seed] of [['level1', 1], ['level2', 2], ['cave', 3], ['cave', 4]]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId, players, seed });
    for (const p of m.players) { p.hp = p.maxHp = 3000; }
    for (const e of m.enemies) e.bleedSource = 'p1';
    const begin = m.beginTurn.bind(m);
    m.beginTurn = (e) => { begin(e); if (e.team === 'enemies') e.bleed = 400; };   // 敵人：走 / 飄 25px 左右就倒下
    const caps = [];
    const plan = m.planAiTurn.bind(m);
    m.planAiTurn = (actor, w) => { const r = plan(actor, w); caps.push({ id: actor.id, x: actor.x, y: actor.y, alive: actor.alive }); return r; };
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io });
    const view = newView('p1');
    ref.start();
    for (const p of players) ref.setConnected(p.id, false);
    for (let k = 0; k < 400 && ref.phase !== 'over' && caps.length < 10; k++) io.advance(250);
    io.advance(60_000);
    let i = 0;
    for (const { _except, at, ...msg } of io.log) {
      view.onMessage(JSON.parse(J(msg)));
      drain(view);
      for (let f = 0; f < 3; f++) view.update(STEP);   // 飄移的最後一幀（腳本裡扣血）倒下的，下一步 update 才播倒下
      if (msg.t !== 'aiTurn') continue;
      const cap = caps[i++];
      if (cap.alive) continue;
      const e = view.match.byId(msg.actorId);
      assert(!msg.shot && !msg.boss && !e.alive && e.deathCause === 'bleed' && e.x === cap.x && e.y === cap.y,
        `${levelId}/${seed} ${msg.actorId}: client ${J({ alive: e.alive, cause: e.deathCause, x: e.x, y: e.y })} vs server ${J(cap)}`);
      assert(view.banners.includes(`${e.name} 失血倒下了！`), `${levelId}/${seed}: banner ${view.banners.slice(-3)}`);
      if (msg.glide) out.glide++; else out.walk++;
    }
  }
  assert(out.walk >= 2 && out.glide >= 1, 'not enough deaths on the way: ' + J(out));
  return out;
}));

// 效果的 fx 在客戶端該飄的字（跟回合結束的 turnFx 同一套：turnFxOps 的 float 動作），寫成「id:文字」
const fxFloats = (match, list) => list.flatMap(f => (turnFxOps(f, match.byId(f.id)) || []).filter(op => op[0] === 'float').map(op => `${op[1]}:${op[2]}`));

await test('流血扣到倒下算到流血來源的擊殺：擊殺的效果（例如噬魂者）照燒死那樣記、飄字——ai.turn 帶 killedBy 與 fx、aiTurn 帶 fx，客戶端走完照效果飄字；行動玩家流血倒下的 turn.skip 帶 killedBy（有 fx 的話 skip 也帶、照樣飄）', () => withConfig({
  ENEMY: { moveChance: 1 },
  AI_MOVE: { dist: [30, 80], minDist: 20, maxFrames: 90, keepDir: 0.65, edge: 8, maxDrop: 40, allyGap: 56, glideTries: 12, takeoverChance: 0.6 },
}, () => {
  // AI 走路：p1（噬魂者，數值自己設）讓敵人流血，敵人在自己的回合走到倒下
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'level1', players, seed: 3 });
  for (const e of m.entities) { e.hp = e.maxHp = 300; }
  const p1 = m.byId('p1');
  p1.mods.killDamagePct = 5;
  for (const e of m.enemies) e.bleedSource = 'p1';
  const begin = m.beginTurn.bind(m);
  m.beginTurn = (e) => { begin(e); if (e.team === 'enemies') e.bleed = 400; };   // 300 血：每 px 12 點，走兩三步就倒下
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  ref.setConnected('p1', false);   // p1 也交給 AI（不用等他）
  for (let k = 0; k < 400 && ref.phase !== 'over' && m.enemies.some(e => e.alive); k++) io.advance(250);
  io.advance(10_000);
  const recs = io.recs('ai.turn').filter(r => r.died === 'bleed');
  const msgs = io.take('aiTurn').filter(x => x.fx);
  assert(recs.length >= 1 && recs.every(r => r.killedBy === 'p1' && r.fx && r.fx.some(f => f.id === 'p1')), 'ai.turn: ' + J(recs));
  assert(msgs.length === recs.length && msgs.every((x, i) => J(x.fx) === J(recs[i].fx) && !x.shot), 'aiTurn carries the same fx: ' + J(msgs.map(x => x.fx)));
  const view = newView('p2');
  const texts = [];
  const float = view.floatText.bind(view);
  view.floatText = (e, str, ...rest) => { texts.push(`${e.id}:${str}`); float(e, str, ...rest); };
  for (const { _except, at, ...msg } of io.log) { view.onMessage(JSON.parse(J(msg))); drain(view); }
  const want = msgs.flatMap(x => fxFloats(view.match, x.fx));
  assert(want.length >= recs.length && want.every(w => texts.includes(w)), `client floats ${J(texts.filter(t => t.startsWith('p1:')))} vs ${J(want)}`);

  // 行動玩家走路流血扣到倒下：turn.skip 帶 killedBy（流血來源）。平常的敵人沒有擊殺的效果 → 不帶 fx
  const plain = mkMatch('level1', { players: 2, hp: 1000 });
  const r1 = refAtP1(plain);
  const a = plain.byId('p1');
  a.bleed = 3;
  a.bleedSource = 'e2';
  r1.ref.handle('p1', { t: 'move', x: a.x + 2, y: a.y, facing: 1, stamina: a.stamina, hp: 0 });
  const ts1 = r1.io.recs('turn.skip').at(-1);
  assert(!a.alive && ts1.reason === 'bleed' && ts1.killedBy === 'e2' && plain.byId('e2').kills === 1 && !('fx' in ts1) && !('fx' in r1.io.take('skip').at(-1)), 'turn.skip: ' + J(ts1));
  // 敵人不會有噬魂者——這裡硬塞給 e1，只為了走一遍 fx 的路：turn.skip 記著、skip 帶著、客戶端照樣飄
  const h = mkMatch('level1', { players: 2, hp: 1000 });
  const r2 = refAtP1(h);
  const q = h.byId('p1'), e1 = h.byId('e1');
  q.bleed = 3;
  q.bleedSource = 'e1';
  e1.mods.killDamagePct = 5;
  const other = newView('p2');
  feed(other, r2.io.log.splice(0));
  drain(other);
  const t2 = [];
  const f2 = other.floatText.bind(other);
  other.floatText = (e, str, ...rest) => { t2.push(`${e.id}:${str}`); f2(e, str, ...rest); };
  r2.ref.handle('p1', { t: 'move', x: q.x + 2, y: q.y, facing: 1, stamina: q.stamina, hp: 0 });
  const ts = r2.io.recs('turn.skip').at(-1), skip = r2.io.take('skip').at(-1);
  assert(!q.alive && ts.reason === 'bleed' && ts.killedBy === 'e1' && ts.fx && ts.fx.some(f => f.id === 'e1'), 'turn.skip: ' + J(ts));
  assert(J(skip.fx) === J(ts.fx), 'skip carries the fx: ' + J(skip));
  feed(other, r2.io.log.splice(0));
  drain(other);
  const want2 = fxFloats(other.match, ts.fx);
  assert(want2.length && want2.every(w => t2.includes(w)), `skip floats ${J(t2)} vs ${J(want2)}`);
  return { aiKills: recs.length, floats: want.slice(0, 3) };
}));

await test('真的 GameView：畫面落後（分頁在背景、前面的事件還沒播完）時，別人的 move 帶的血量照順序排進佇列——之後才播的他的 turn（舊快照）不會把血量蓋回去，飄的「-N」加起來剛好是真的流血', () => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'level1', players, seed: 1 });
  for (const e of m.entities) { e.hp = e.maxHp = 1000; e.maxStamina = 5000; }
  m.planAiTurn = () => ({ walk: null, plan: null });   // 敵人只發呆（AI 回合的腳本照樣要播 aiThink 那麼久）
  const begin = m.beginTurn.bind(m);
  m.beginTurn = (e) => { begin(e); if (e.id === 'p1' && e.turnCount === 2) e.bleed = 10; };   // 第二個回合帶著流血（1000 血：每 px 1 點）
  const tt = CONFIG.TURN_TIME;
  CONFIG.TURN_TIME = 5;   // 第一輪兩個人都等到超時
  try {
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io });
    const me = newView('p1'), other = newView('p2');
    me.transport = { send: (msg) => ref.handle('p1', JSON.parse(J(msg))) };
    ref.start();
    assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1' && m.byId('p1').turnCount === 2), 'p1 second turn');
    const msgs = io.log.splice(0);
    feed(me, msgs);
    drain(me);
    feed(other, msgs);   // 別人的畫面：訊息都收到了、一幀都還沒播（還卡在敵人的 AI 回合）
    assert(me.canAct && me.me.bleed === 10, 'my second turn, bleeding');
    assert(other.script && other.queue.some(x => x.t === 'turn' && x.actorId === 'p1'), 'the observer is behind: ' + other.queue.map(x => x.t));
    const p = m.byId('p1'), seen = other.match.byId('p1');
    const hp0 = p.hp;
    me.keys.KeyD = true;
    for (let f = 0; f < 40; f++) { me.update(STEP); feed(other, io.log.splice(0)); }
    me.keys.KeyD = false;
    for (let f = 0; f < 10; f++) { me.update(STEP); feed(other, io.log.splice(0)); }
    const lost = hp0 - p.hp;
    assert(lost > 20 && me.me.hp === p.hp, `walked and bled: ${lost}`);
    const texts = [];
    const float = other.floatText.bind(other);
    other.floatText = (e, str, color, ...rest) => { if (e.id === 'p1' && color === '#ef4444' && /^-\d+$/.test(str)) texts.push(str); float(e, str, color, ...rest); };
    drain(other);
    for (let f = 0; f < 60; f++) other.update(STEP);
    assert(seen.hp === p.hp, `observer ${seen.hp} vs server ${p.hp} after catching up`);
    const floated = texts.reduce((s, x) => s - Number(x), 0);
    assert(floated === lost, `floats ${texts} add up to ${floated}, real loss ${lost}`);
    // 跟上了之後（佇列是空的）再走一段：馬上照著顯示、只飄新扣的
    const hp1 = p.hp;
    me.keys.KeyD = true;
    for (let f = 0; f < 10; f++) { me.update(STEP); feed(other, io.log.splice(0)); other.update(STEP); }
    me.keys.KeyD = false;
    assert(p.hp < hp1 && seen.hp === p.hp, `live again: observer ${seen.hp} vs server ${p.hp}`);
    for (let f = 0; f < 60; f++) other.update(STEP);
    assert(texts.reduce((s, x) => s - Number(x), 0) === hp0 - p.hp, `floats ${texts} vs total loss ${hp0 - p.hp}`);
    return { lost: hp0 - p.hp, floats: texts };
  } finally {
    CONFIG.TURN_TIME = tt;
  }
});

// ---- 自己的回合時間到的競賽：伺服器先超時（之後收到的 move 都擋掉），skip 照延遲才到畫面 ----
// 假時鐘：performance.now = 伺服器的時間（io.t），回合 1 秒；訊息照 ctx.lat(msg) 毫秒的延遲、照順序送到畫面。
// p1 1000 血、1 層流血（每 px 0.1 點）、移動速度 130：一直按著 D 走 → 每秒扣 13 點。走到畫面上出現「時間到！」之後再 0.5 秒，交給 fn(ctx)
function deadlineRace({ hp, lat }, fn) {
  const tt = CONFIG.TURN_TIME;
  const realNow = Object.getOwnPropertyDescriptor(performance, 'now');
  const io = new FakeIo();
  CONFIG.TURN_TIME = 1;
  performance.now = () => io.t;
  try {
    const players = mkPlayers(1);
    const m = new Match({ levelId: 'level1', players, seed: 1, carry: { p1: { hp: 1000, maxHp: 1000, maxStamina: 5000, moveSpeed: 130 } } });
    for (const e of m.enemies) { e.hp = e.maxHp = 1000; }
    const p = m.byId('p1');
    p.hp = hp;
    p.bleed = 1;
    m.planAiTurn = () => ({ walk: null, plan: null });
    const ref = new Referee({ match: m, humans: players, io });
    const view = newView('p1');
    const sent = [];
    view.transport = { send: (msg) => { sent.push({ ...JSON.parse(J(msg)), at: io.t }); ref.handle('p1', JSON.parse(J(msg))); } };
    const pending = [];
    const ctx = { m, io, ref, view, sent, lat, trace: [] };
    ctx.frame = () => {
      io.advance(1000 / 60);
      pending.push(...io.log.splice(0));
      while (pending.length && io.t >= pending[0].at + ctx.lat(pending[0])) {
        const { _except, at, ...msg } = pending.shift();
        if (_except !== 'p1') view.onMessage(JSON.parse(J(msg)));
      }
      view.update(STEP);
      if (view.me) ctx.trace.push({ t: io.t, x: view.me.x, hp: view.me.hp, alive: view.me.alive, canAct: view.canAct });
    };
    ref.start();
    assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn on the server');
    ctx.serverDeadline = ref.deadline;
    view.keys.KeyD = true;
    for (let f = 0; f < 300 && !(ctx.skipAt !== undefined && io.t > ctx.skipAt + 500); f++) {
      ctx.frame();
      if (ctx.deadline === undefined && view.canAct) { ctx.deadline = view.deadline; ctx.x0 = view.me.x; }
      if (ctx.skipAt === undefined && view.banners.includes('時間到！')) ctx.skipAt = io.t;
    }
    assert(ctx.deadline !== undefined && ctx.skipAt !== undefined && io.recs('turn.skip').at(-1).reason === 'timeout', 'my turn started and timed out');
    return fn(ctx);
  } finally {
    CONFIG.TURN_TIME = tt;
    if (realNow) Object.defineProperty(performance, 'now', realNow);
    else delete performance.now;
  }
}

await test('真的 GameView：自己的回合在畫面上時間到了就停下（不能再動、不再走路流血），還沒回報的位置 / 血量馬上補送——伺服器超時的 skip 晚到也不會先在畫面上流血倒下', () => deadlineRace({
  hp: 16, lat: (msg) => (msg.t === 'skip' ? 400 : 0),   // 回合的訊息馬上到、超時的 skip 晚 0.4 秒（照舊走下去會再扣 5 點以上 → 倒下）
}, ({ m, view, sent, trace, serverDeadline, deadline, skipAt, x0 }) => {
  const sp = m.byId('p1');
  const stop = trace.find(s => s.t >= deadline);
  const window = trace.filter(s => s.t >= deadline && s.t < skipAt);
  assert(deadline >= serverDeadline && skipAt > deadline + 200 && window.length >= 10, J({ serverDeadline, deadline, skipAt }));
  assert(stop.x - x0 > 100 && stop.hp < 16 && stop.hp > 0, `walked and bled up to the deadline: ${J(stop)} from x ${x0}`);
  assert(window.every(s => !s.canAct && s.alive && s.x === stop.x && s.hp === stop.hp), 'stopped at the deadline: ' + J(window.slice(0, 3)));
  // 停下的那一幀馬上補送一筆（不等每秒 10 次的節流），之後不再送
  const moves = sent.filter(s => s.t === 'move');
  const last = moves.at(-1);
  assert(moves.filter(s => s.at >= deadline).length === 1 && last.at === stop.t && last.x === stop.x && last.hp === stop.hp, 'the last report is where he stopped: ' + J({ last, stop }));
  assert(trace.every(s => s.alive) && !view.banners.some(b => /失血/.test(b)), 'never bled out on the screen: ' + view.banners);
  assert(view.me.alive && view.me.hp === sp.hp && !view.canAct, `after the skip: ${view.me.hp} vs server ${sp.hp}`);
  return { stopHp: stop.hp, server: sp.hp, window: window.length };
}));

await test('真的 GameView：伺服器已經超時、自己的畫面才流血倒下（回報 hp 0 的 move 被擋掉）——skip 的快照把他救回來時乾乾淨淨：活著、血量跟伺服器一樣、沒有死因、橫幅換成「時間到！」，下一個回合照常能動', () => deadlineRace({
  hp: 11, lat: () => 300,   // 每則訊息都晚 0.3 秒到：畫面上的回合比伺服器晚開始、晚結束
}, (ctx) => {
  const { m, io, view, sent, trace, serverDeadline, skipAt } = ctx;
  const sp = m.byId('p1'), me = view.me;
  const died = trace.find(s => !s.alive);
  assert(died && died.t > serverDeadline && died.t < skipAt && sent.some(s => s.t === 'move' && s.hp === 0), 'bled out on the screen after the server timed out: ' + J(died));
  assert(io.recs('action.ignored').some(r => r.t === 'move' && r.reason === 'phase:resolving') && sp.alive && sp.hp > 0, 'the server never saw it');
  assert(view.banners.includes('P1 失血倒下了！'), 'the local death was shown: ' + view.banners);
  assert(me.alive && me.hp === sp.hp && me.deathCause === null && !view.look(me).deathHandled, `revived by the skip: ${J({ alive: me.alive, hp: me.hp, cause: me.deathCause })} vs server ${sp.hp}`);
  assert(view.banner && view.banner.text === '時間到！' && !view.canAct, 'banner: ' + (view.banner && view.banner.text));
  // 下一個回合：照常能動（流血在回合結束時止住了）
  ctx.lat = () => 0;
  for (let f = 0; f < 1500 && !view.canAct; f++) ctx.frame();
  const hp = me.hp, x = me.x;
  for (let f = 0; f < 10; f++) ctx.frame();
  assert(view.canAct && me.alive && me.bleed === 0 && me.x > x + 10 && me.hp === hp, `next turn: ${J({ canAct: view.canAct, bl: me.bleed, dx: me.x - x, hp: me.hp })}`);
  return { revivedHp: sp.hp };
}));

await test('選牌畫面：武器牌的武器會上流血時補一行流血的說明（看武器的 bleed，不看說明文字）；其他牌不補', async () => {
  const els = {};
  const root = { querySelector: (sel) => (els[sel] ||= { addEventListener() {}, textContent: '' }) };
  const { CardsUi } = await import('../client/cards-ui.js');
  const ui = new CardsUi(root, () => {});
  ui.renderNotes([{ id: 'a', weapon: 'testStab' }, { id: 'b', weapon: 'cannon' }]);
  const note = els['#cards-note'].textContent;
  assert(/流血/.test(note) && note.includes(`${CONFIG.BLEED.pctPerPx}%`), 'note: ' + note);
  ui.renderNotes([{ id: 'b', weapon: 'cannon' }, { id: 'c', effects: { damagePct: 5 } }]);
  assert(!/流血/.test(els['#cards-note'].textContent), 'no bleed weapon → no note');
  return { note };
});

delete CONFIG.WEAPONS.testStab;
delete CONFIG.WEAPONS.testBlast;
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
