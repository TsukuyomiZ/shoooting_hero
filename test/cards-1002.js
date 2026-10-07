// node test/cards-1002.js
// 2026-10-02 新增的牌：嗨到最高點、全知之眼、磨刀霍霍、越戰越強。
// 血量一律自己設（不受 config 影響），數值照 cards.json / config 現在的設定算
import fs from 'node:fs';
import { CONFIG } from '../shared/config.js';
import { Match } from '../shared/match.js';
import { Entity } from '../shared/entities.js';
import { levelsInPool } from '../shared/level.js';
import { validateCards, baseStats, derivePlayerStats } from '../shared/cards.js';
import { simulateShot, aimPreview } from '../shared/weapons.js';

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

const CARDS = validateCards(JSON.parse(fs.readFileSync(new URL('../shared/cards.json', import.meta.url), 'utf8')));
const cardById = (id) => CARDS.cards.find(c => c.id === id);
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const W = CONFIG.WEAPONS;
const NEW = ['fever_high', 'all_seeing_eye', 'whetstone', 'battle_hardened'];
// 狂熱的測試設定（關卡規則讀的，見 shared/stage-rules.js）：每輪疊一層、每層 +50%，不受使用者調 config 影響。
// match.fever 由輪數推出：第 n 層 = 第 n + 1 輪
const FEVER_CFG = { ...CONFIG, FEVER: { everyRounds: 1, damagePct: 50, inBoss: false } };
const setFever = (m, n) => { m.round = n + 1; };

// p1 帶某張牌的效果的測試戰鬥；所有人血量拉到 hp
function matchWith(effects = {}, { players = 1, levelId = 'level1', seed = 1, hp = 5000, config = CONFIG } = {}) {
  const stats = baseStats();
  for (const [k, v] of Object.entries(effects)) stats[k] += v;
  const d = derivePlayerStats(stats);
  const carry = { p1: { hp, maxHp: hp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed, size: d.size, mods: d.mods } };
  const m = new Match({ levelId, players: mkPlayers(players), seed, carry, config });
  for (const e of m.entities) { e.maxHp = hp; e.hp = hp; }
  return m;
}
const withCard = (id, opts) => matchWith(cardById(id).effects, opts);

// 把 target 放到射手正右邊、用狙擊槍直直打過去（一定打中）；miss = 往正上方開（一定沒打中）
function shootAt(m, shooter, target) {
  target.x = shooter.x + 40; target.y = shooter.y; target.vx = 0; target.vy = 0;
  const mz = shooter.muzzle();
  const angle = Math.atan2(-(target.cy - mz.y), target.cx - mz.x) * 180 / Math.PI;
  return m.resolveShot(shooter, 'sniper', angle, 100);
}
const shootMiss = (m, shooter) => m.resolveShot(shooter, 'sniper', 90, 100);
// 打中的那一下扣了 target 多少血
function hitDamage(m, shooter, target) {
  const hp0 = target.hp;
  const shot = shootAt(m, shooter, target);
  assert(shot.hitEnemy, 'shootAt should hit');
  return hp0 - target.hp;
}

test('牌庫：四張新牌都通過驗證、稀有度與效果照使用者給的', () => {
  for (const id of NEW) assert(cardById(id), 'missing ' + id);
  const bad = CARDS.warnings.filter(w => NEW.some(id => w.includes(id)));
  assert(!bad.length, bad.join('; '));
  assert(cardById('fever_high').rarity === 'green' && cardById('fever_high').effects.feverDamagePct === 50);
  // 全知之眼：使用者 2026-10-05 從紫卡改成金卡
  assert(cardById('all_seeing_eye').rarity === 'gold' && cardById('all_seeing_eye').effects.damagePct === 20 && cardById('all_seeing_eye').effects.fullArc === 1);
  assert(cardById('whetstone').rarity === 'purple' && cardById('whetstone').effects.missDamagePct === 10 && cardById('whetstone').effects.missMaxStacks === 5);
  assert(cardById('battle_hardened').rarity === 'purple' && cardById('battle_hardened').effects.hitDamagePct === 10 && cardById('battle_hardened').effects.hitMaxStacks === 10);
});

test('嗨到最高點：狂熱生效時武器傷害 +50%（不隨狂熱層數加倍），沒狂熱時沒效果', () => {
  const m = withCard('fever_high', { config: FEVER_CFG });
  const p = m.players[0];
  const base = m.damageMult(p, W.cannon);
  assert(Math.abs(base - 1) < 1e-12, 'no fever → no bonus ' + base);
  setFever(m, 1);
  assert(Math.abs(m.damageMult(p, W.cannon) - 1.5) < 1e-12, 'fever 1 → ×1.5');
  setFever(m, 2);
  assert(Math.abs(m.damageMult(p, W.cannon) - 1.5) < 1e-12, 'fever 2 → still ×1.5 (fever itself handles stacking)');
  // 實際打一下：牌的 +50% 與狂熱本身的 +100% 相乘
  const e1 = m.enemies[0], hp0 = e1.hp;
  m.applyExplosion(e1.cx, e1.cy, W.cannon, p, e1);
  const want = Math.round(W.cannon.damage * 1.5 * (1 + 2 * FEVER_CFG.FEVER.damagePct / 100));
  assert(hp0 - e1.hp === want, `dmg ${hp0 - e1.hp} want ${want}`);
  // 轟炸不吃武器傷害加成
  assert(m.damageMult(p, W.bombard) === 1, 'bombard unaffected');
  // 沒這張牌的人在狂熱裡沒有額外加成
  const plain = matchWith({}, { config: FEVER_CFG });
  setFever(plain, 1);
  assert(Math.abs(plain.damageMult(plain.players[0], W.cannon) - 1) < 1e-12, 'plain player unaffected');
});

test('嗨到最高點：Boss 關沒有狂熱，所以不會生效', () => {
  const bossId = levelsInPool('boss')[0];
  assert(bossId, 'a boss level exists');
  const m = withCard('fever_high', { levelId: bossId, config: FEVER_CFG });
  m.round = 25;
  assert(m.fever === 0, 'boss has no fever');
  assert(Math.abs(m.damageMult(m.players[0], W.cannon) - 1) < 1e-12, 'no bonus in boss');
});

test('全知之眼：武器傷害 +20%，大砲預覽畫完整拋物線到落點；沒牌只畫前幾個點', () => {
  const m = withCard('all_seeing_eye');
  const p = m.players[0];
  assert(Math.abs(m.damageMult(p, W.cannon) - 1.2) < 1e-12, 'dmg +20%');
  const pre = aimPreview(m.world, p, W.cannon, 60, 60);
  const full = simulateShot(m.world, p, W.cannon, 60, 60, 6, CONFIG.PREVIEW.framesPerDot, { bounces: 0 });
  assert(pre.kind === 'arc' && pre.full, 'full arc');
  const end = pre.points.at(-1);
  assert(end.x === full.hit.x && end.y === full.hit.y && full.hit.type !== 'timeout', 'last point is the landing spot ' + JSON.stringify(full.hit));
  assert(pre.points.length > CONFIG.PREVIEW.dots * 3, `many dots (${pre.points.length})`);
  // 預覽的落點 = 真正開火時的第一個事件位置
  const shot = m.resolveShot(p, 'cannon', 60, 60);
  const ev = shot.events[0];
  assert(Math.hypot(ev.x - end.x, ev.y - end.y) < 0.001, `preview lands where the shot lands (${ev.x},${ev.y} vs ${end.x},${end.y})`);
  const plain = matchWith();
  const pp = aimPreview(plain.world, plain.players[0], W.cannon, 60, 60);
  assert(!pp.full && pp.points.length === CONFIG.PREVIEW.dots, 'without the card: only the first dots');
  // 直線武器（狙擊槍）本來就畫完整路線，不受影響
  assert(aimPreview(m.world, p, W.sniper, 10, 100).kind === 'line', 'sniper still a line');
  return { dots: pre.points.length };
});

test('磨刀霍霍：沒打中 +1 層準備（最多 5 層），每層 +10%；打中之後歸零', () => {
  const m = withCard('whetstone');
  const p = m.players[0], e1 = m.enemies[0];
  const d0 = hitDamage(m, p, e1);   // 0 層
  assert(p.readyStacks === 0, 'hit keeps it at 0');
  for (let i = 1; i <= 7; i++) {
    const s = shootMiss(m, p);
    assert(s.hitEnemy === false, 'miss');
    assert(p.readyStacks === Math.min(5, i), `after ${i} misses: ${p.readyStacks}`);
    assert(s.results.find(r => r.id === p.id).rd === p.readyStacks, 'results carry the updated stacks');
  }
  const d5 = hitDamage(m, p, e1);   // 開槍時 5 層 → +50%
  assert(d5 === Math.round(d0 * 1.5) || Math.abs(d5 - d0 * 1.5) <= 1, `5 stacks dmg ${d5} vs base ${d0}`);
  assert(p.readyStacks === 0, 'reset after a hit');
  shootMiss(m, p);
  assert(p.readyStacks === 1);
  return { d0, d5 };
});

test('越戰越強：打中 +1 層狂獵（最多 10 層），每層 +10%；沒打中歸零', () => {
  const m = withCard('battle_hardened');
  const p = m.players[0], e1 = m.enemies[0];
  const dmgs = [];
  for (let i = 1; i <= 12; i++) {
    dmgs.push(hitDamage(m, p, e1));
    assert(p.huntStacks === Math.min(10, i), `after ${i} hits: ${p.huntStacks}`);
  }
  const base = dmgs[0];
  assert(Math.abs(dmgs[1] - base * 1.1) <= 1, `1 stack ${dmgs[1]} vs ${base}`);
  assert(Math.abs(dmgs[10] - base * 2) <= 1 && dmgs[11] === dmgs[10], `capped at +100%: ${dmgs[10]}, ${dmgs[11]}`);
  shootMiss(m, p);
  assert(p.huntStacks === 0, 'reset after a miss');
  assert(hitDamage(m, p, e1) === base, 'back to base damage');
  return { base, max: dmgs[10] };
});

test('命中的定義：只打到隊友算沒命中；轟炸不算射擊；兩張牌可以同時帶', () => {
  const m = matchWith({ missDamagePct: 10, missMaxStacks: 5, hitDamagePct: 10, hitMaxStacks: 10 }, { players: 2 });
  const [p1, p2] = m.players;
  for (const e of m.enemies) { e.x = 50; e.y = 0; }   // 敵人都移到遠處（不會被波及）
  m.settle(360);
  hitDamage(m, p1, m.enemies[0]);
  assert(p1.huntStacks === 1 && p1.readyStacks === 0, 'hit');
  m.enemies[0].x = 50;
  m.settle(360);
  const s = shootAt(m, p1, p2);
  assert(s.events.some(ev => ev.damages && ev.damages.some(d => d.id === p2.id && d.dmg > 0)), 'teammate was actually hit');
  assert(s.hitEnemy === false && p1.huntStacks === 0 && p1.readyStacks === 1, `friendly-only = miss (hunt ${p1.huntStacks}, ready ${p1.readyStacks})`);
  const b = m.resolveBombard(p1);
  assert(b.hitEnemy === undefined && p1.readyStacks === 1, 'bombard does not touch the stacks');
});

test('層數同步：toState / applyState 帶 rd / hu，客戶端拿得到', () => {
  const m = withCard('whetstone');
  const p = m.players[0];
  shootMiss(m, p); shootMiss(m, p);
  const c = new Entity({ id: 'p1', name: 'x', team: 'players', x: 0, y: 0 });
  c.applyState(p.toState());
  assert(c.readyStacks === 2 && c.huntStacks === 0, 'synced');
  const snap = withCard('whetstone');
  snap.applySnapshot(m.snapshot());
  assert(snap.players[0].readyStacks === 2, 'snapshot carries it');
});

test('新牌也維持確定性：同 seed 同輸入兩次結果完全一樣', () => {
  const once = () => {
    const m = matchWith({ missDamagePct: 10, missMaxStacks: 5, hitDamagePct: 10, hitMaxStacks: 10, feverDamagePct: 50, fullArc: 1 }, { hp: 200, config: FEVER_CFG });
    setFever(m, 1);
    const log = [];
    log.push(m.resolveShot(m.players[0], 'cannon', 70, 30));
    log.push(m.resolveShot(m.players[0], 'cannon', 90, 20));
    log.push(m.resolveShot(m.players[0], 'sniper', 0, 100));
    return JSON.stringify({ log, snap: m.snapshot() });
  };
  assert(once() === once(), 'two runs differ');
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
