// node test/weapons-1008.js
// 2026-10-08 武器改版：無差別轟炸不破壞地形、迴力鏢飛到最遠才折返（去回都打路上的敵人、回到角色身上）、
// 新武器飛鏢（綠，一回合三次）與高壓水炮（白，射程 300、擊退強、有後座力）。
// 血量一律自己設（不受 config 影響），武器數值照 config 現在的設定算；裁判的飛鏢回合流程在別的測試
import fs from 'node:fs';
import { CONFIG } from '../shared/config.js';
import { Match } from '../shared/match.js';
import { Entity } from '../shared/entities.js';
import { Rng } from '../shared/rng.js';
import { planShot } from '../shared/ai.js';
import { validateCards, baseStats, derivePlayerStats } from '../shared/cards.js';
import { replayVolley } from '../shared/volley.js';
import {
  isEquippable, launchVelocity, shotRange, makeProjectile, advanceProjectile, simulateShot, aimPreview, applyRecoil, blastRadius,
} from '../shared/weapons.js';

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
const J = (x) => JSON.parse(JSON.stringify(x));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// 伺服器的載入流程（server/rooms.js 的 loadCards：每次開局重新讀 cards.json，警告印在 console.warn）。
// 載入時先把 console 收起來，只留給下面的測試檢查
const loaderOut = { warns: [], logs: [] };
let loaded;
{
  const { warn, log } = console;
  console.warn = (...a) => loaderOut.warns.push(a.join(' '));
  console.log = (...a) => loaderOut.logs.push(a.join(' '));
  try {
    const { loadCards } = await import('../server/rooms.js');
    loaded = loadCards();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

const W = CONFIG.WEAPONS;
const B = W.boomerang, WC = W.waterCannon, D = W.darts;
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));

// p1 帶某些效果、某些武器的測試戰鬥；所有人血量拉到 hp
function matchWith(effects = {}, { players = 1, levelId = 'level1', seed = 1, weapons, hp = 5000 } = {}) {
  const stats = baseStats();
  for (const [k, v] of Object.entries(effects)) stats[k] += v;
  const d = derivePlayerStats(stats);
  const carry = { p1: { hp, maxHp: hp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed, size: d.size, mods: d.mods, weapons } };
  const m = new Match({ levelId, players: mkPlayers(players), seed, carry });
  for (const e of m.entities) { e.maxHp = hp; e.hp = hp; }
  return m;
}
// 把角色放到 x 的地面上
function placeAt(m, e, x) { e.x = x; e.y = 300; e.vx = 0; e.vy = 0; m.settle(600); }
// 從 shooter 的砲口直直瞄準 target 的中心
const aimAt = (shooter, target) => {
  const mz = shooter.muzzle();
  return Math.atan2(-(target.cy - mz.y), target.cx - mz.x) * 180 / Math.PI;
};
const maskOf = (m) => Buffer.from(m.terrain.mask);
const sameMask = (a, m) => Buffer.compare(a, maskOf(m)) === 0;
const brief = (s) => s.events.map(e => `${e.type}${e.on ? ':' + e.on : ''}${e.target ? '>' + e.target : ''}@f${e.f}`).join(' ');
// 這一發所有事件裡 id 被扣的血（含友傷、分攤）
const damageTo = (shot, id) => shot.events.reduce((n, ev) => n + (ev.damages || []).filter(d => d.id === id).reduce((s, d) => s + d.dmg, 0), 0);

// 從砲口照同一組初速只跑運動學（不做碰撞、不算路徑長），量到事件 ev 那一點為止飛過的路徑長：
// 前 f - 1 幀每幀的弦長加總，再加上第 f 幀出發點到事件位置（伺服器停在那一幀的某個子步）。要在開火之前量砲口
function flownLength(muzzle, shooter, weapon, angle, power, ev) {
  const v = launchVelocity(weapon, angle, power);
  const q = makeProjectile(shooter, weapon, muzzle.x, muzzle.y, v.vx, v.vy);
  let len = 0, x = q.x, y = q.y;
  for (let f = 1; f < ev.f; f++) {
    advanceProjectile(null, q, CONFIG.FIXED_DT);
    len += Math.hypot(q.x - x, q.y - y);
    x = q.x;
    y = q.y;
  }
  return len + Math.hypot(ev.x - x, ev.y - y);
}

// 開火那一刻（後座力套上之後、第一次物理步進之前）射手的狀態：把 match.step 包一層，第一次呼叫時先記下來
function fireAndPeek(m, e, fire) {
  let first = null;
  const step = m.step;
  m.step = function (dt) {
    if (!first) first = { x: e.x, y: e.y, vx: e.vx, vy: e.vy, onVine: e.onVine };
    return step.call(this, dt);
  };
  try {
    return { shot: fire(), first };
  } finally {
    delete m.step;   // 回到 Match.prototype.step
  }
}

// 客戶端：同一個 seed 建一場，套上伺服器開火前的快照（同 test/volley.js）
const clientOf = (m) => {
  const cm = new Match({ levelId: m.levelId, players: mkPlayers(m.players.length), seed: m.seed, carry: m.carry, stage: m.stage });
  cm.applySnapshot(J(m.snapshot()));
  return cm;
};

// ---------- 迴力鏢 ----------

test('迴力鏢：沒打到東西時飛到最長路徑（rangeMin + 力量 × rangePerPower）才折返（on = range），原路飛回手上；不挖地形', () => {
  const lens = {};
  for (const [angle, power] of [[70, 20], [70, 60], [80, 100]]) {
    const m = matchWith({}, { weapons: ['boomerang'] });
    const p = m.players[0];
    const mz = p.muzzle();
    const mask = maskOf(m);
    const want = B.rangeMin + power * B.rangePerPower;
    assert(shotRange(B, power) === want, `shotRange(${power}) = ${shotRange(B, power)}, want ${want}`);
    const shot = m.resolveShot(p, 'boomerang', angle, power);
    assert(brief(shot).replace(/@f\d+/g, '') === 'return:range catch', `${angle}°/${power}: ${brief(shot)}`);
    const ret = shot.events[0];
    const len = flownLength(mz, p, B, angle, power, ret);
    // 伺服器每 2px 一個子步，飛過 range 的那一個子步就折返：路徑長落在 [range, range + 2) 裡（這裡量的是弦長，差不到 0.5px）
    assert(len >= want - 0.5 && len <= want + 2.5, `power ${power}: turned around after ${len.toFixed(2)}px, want ≈ ${want}`);
    assert(shot.hit.type === 'range' && shot.hit.x === ret.x && shot.hit.y === ret.y, 'summary = where it turned: ' + JSON.stringify(shot.hit));
    const c = shot.events[1];
    assert(c.f > ret.f && c.x === mz.x && c.y === mz.y, `caught at the hand ${JSON.stringify(c)} vs ${JSON.stringify(mz)}`);
    assert(m.terrain.holes.length === 0 && sameMask(mask, m), 'boomerang does not dig');
    lens[power] = +len.toFixed(2);
  }
  return lens;
});

test('迴力鏢：先撞到地形就提早折返（不帶 on）；落水（on = water）、飛出場外（on = out）也折返，最後都回到手上；hit.type 照折返的原因', () => {
  // 往前下方丟：還沒飛到最長路徑就打到腳前的地面
  const t = matchWith({}, { weapons: ['boomerang'] });
  const tp = t.players[0], tmz = tp.muzzle();
  const mask = maskOf(t);
  const ts = t.resolveShot(tp, 'boomerang', -30, 30);
  const tr = ts.events[0];
  assert(brief(ts).replace(/@f\d+/g, '') === 'return catch' && !('on' in tr), 'terrain: ' + brief(ts));
  const tlen = flownLength(tmz, tp, B, -30, 30, tr);
  assert(tlen < shotRange(B, 30) - 50, `turned around early on the ground (${tlen.toFixed(1)}px of ${shotRange(B, 30)})`);
  assert(t.terrain.isSolid(tr.x, tr.y), 'the turn point is in the ground');
  assert(ts.hit.type === 'terrain', 'hit.type terrain: ' + ts.hit.type);
  assert(ts.events[1].x === tmz.x && ts.events[1].y === tmz.y, 'caught at the hand');
  assert(t.terrain.holes.length === 0 && sameMask(mask, t), 'no hole where it hit the ground');

  // 叢林巨蟒的藤蔓橋（子彈穿得過，下面全是水）上往正下方丟：還沒飛到最長路徑就落水
  const w = matchWith({}, { levelId: 'jungleSerpent', weapons: ['boomerang'] });
  const wp = w.players[0], wmz = wp.muzzle();
  const ws = w.resolveShot(wp, 'boomerang', -90, 10);
  const wr = ws.events[0];
  assert(brief(ws).replace(/@f\d+/g, '') === 'return:water catch', 'water: ' + brief(ws));
  assert(wr.y > CONFIG.WATER_LEVEL && flownLength(wmz, wp, B, -90, 10, wr) < shotRange(B, 10), 'fell in the water before the max range');
  assert(ws.hit.type === 'water', 'hit.type water: ' + ws.hit.type);
  const wc = ws.events[1];
  assert(wc.x === wmz.x && wc.y === wmz.y && wp.hp === wp.maxHp, 'still caught (thrower did not fall in): ' + JSON.stringify(wc));

  // 往左飛出場外
  const o = matchWith({}, { weapons: ['boomerang'] });
  const op = o.players[0], omz = op.muzzle();
  const os = o.resolveShot(op, 'boomerang', 180, 100);
  assert(brief(os).replace(/@f\d+/g, '') === 'return:out catch' && os.events[0].x < -80, 'out: ' + brief(os));
  assert(os.hit.type === 'out' && os.events[1].x === omz.x && os.events[1].y === omz.y, 'out → caught');
  return { terrain: +tlen.toFixed(1), water: brief(ws), out: brief(os) };
});

test('迴力鏢：去程穿過兩個敵人、回程再打一次（每人每趟剛好一次，共 25 × 2）；站在路上的隊友完全不受影響', () => {
  const setup = () => {
    const m = matchWith({}, { weapons: ['boomerang'], players: 2 });
    const [p1, p2] = m.players, [e1, e2] = m.enemies;
    placeAt(m, p2, p1.x + 35);   // 隊友站在丟的人跟敵人中間
    placeAt(m, e1, p1.x + 70);
    placeAt(m, e2, p1.x + 140);
    return m;
  };
  const m = setup();
  const [p1, p2] = m.players, [e1, e2] = m.enemies;
  const mz = p1.muzzle();
  const mask = maskOf(m);
  const shot = m.resolveShot(p1, 'boomerang', 10, 50);
  const seq = shot.events.map(ev => (ev.type === 'pierce' ? ev.target : ev.type + (ev.on ? ':' + ev.on : '')));
  assert(seq.join() === 'e1,e2,return:range,e2,e1,catch', 'outbound e1 → e2, turn at max range, back e2 → e1, caught: ' + brief(shot));
  for (const ev of shot.events.filter(ev => ev.type === 'pierce')) {
    assert(ev.damages.length === 1 && ev.damages[0].id === ev.target && ev.damages[0].dmg === B.damage && !ev.damages[0].friendly,
      `each pass = one direct hit of ${B.damage}: ${JSON.stringify(ev.damages)}`);
  }
  assert(e1.maxHp - e1.hp === 2 * B.damage && e2.maxHp - e2.hp === 2 * B.damage, `two hits each: e1 -${e1.maxHp - e1.hp}, e2 -${e2.maxHp - e2.hp}`);
  assert(damageTo(shot, 'p2') === 0 && p2.hp === p2.maxHp, 'teammate on the path untouched');
  assert(damageTo(shot, 'p1') === 0 && p1.hp === p1.maxHp, 'thrower untouched');
  const c = shot.events.at(-1);
  assert(c.x === mz.x && c.y === mz.y, 'back in the thrower\'s hand');
  assert(m.terrain.holes.length === 0 && sameMask(mask, m), 'no holes');
  assert(shot.hit.type === 'range' && shot.hitEnemy === true, 'summary: turned at max range, hit an enemy');

  // 對照：隊友真的站在路上（關掉穿過隊友的話就會被打到）
  const saved = B.passAllies;
  B.passAllies = false;
  try {
    const c2 = setup();
    const s2 = c2.resolveShot(c2.players[0], 'boomerang', 10, 50);
    assert(damageTo(s2, 'p2') > 0, 'control: without passAllies the teammate would be hit: ' + brief(s2));
  } finally {
    B.passAllies = saved;
  }
  return { seq: seq.join(' ') };
});

test('迴力鏢：往正上方丟，回程從頭頂穿回手上也不會打到自己（站著丟、在空中丟都一樣）', () => {
  const out = {};
  for (const air of [false, true]) {
    const m = matchWith({}, { weapons: ['boomerang'] });
    const p = m.players[0];
    if (air) { p.y -= 60; p.vy = 0; p.onGround = false; }
    const mz = p.muzzle();
    const shot = m.resolveShot(p, 'boomerang', 90, 20);
    const ret = shot.events.find(ev => ev.type === 'return');
    assert(ret && ret.on === 'range' && ret.y < mz.y - 50, 'turned around above the head: ' + brief(shot));
    assert(shot.events.at(-1).type === 'catch', 'caught: ' + brief(shot));
    assert(!shot.events.some(ev => ev.damages) && p.hp === p.maxHp, `thrower never hit: ${brief(shot)} hp ${p.hp}`);
    if (air) assert(shot.events.at(-1).y > mz.y + 30, 'thrower had fallen: the boomerang homed down into him');
    out[air ? 'air' : 'ground'] = brief(shot);
  }
  return out;
});

test('迴力鏢：AI 試射（simulateShot）停在最長路徑（hit.type range），跟開火結算的折返點一模一樣；撞到地面的照樣是 terrain', () => {
  const out = [];
  for (const [angle, power] of [[70, 20], [60, 40], [80, 100]]) {
    const a = matchWith({}, { weapons: ['boomerang'] });
    const sim = simulateShot(a.world, a.players[0], B, angle, power);
    const b = matchWith({}, { weapons: ['boomerang'] });
    const ret = b.resolveShot(b.players[0], 'boomerang', angle, power).events[0];
    assert(sim.hit.type === 'range', `${angle}°/${power}: simulateShot ends with ${sim.hit.type}`);
    assert(sim.hit.x === ret.x && sim.hit.y === ret.y, `same turn point: sim ${sim.hit.x},${sim.hit.y} vs shot ${ret.x},${ret.y}`);
    out.push(sim.frames);
  }
  const g = matchWith({}, { weapons: ['boomerang'] });
  assert(simulateShot(g.world, g.players[0], B, -30, 30).hit.type === 'terrain', 'into the ground → terrain');
  return { frames: out };
});

// ---------- 高壓水炮 ----------

test('高壓水炮：射程（300）以外的敵人打不到：只有一個 range 事件、沒有傷害、不挖地形', () => {
  const m = matchWith({}, { weapons: ['waterCannon'] });
  const p = m.players[0], e1 = m.enemies[0];
  const mz = p.muzzle();
  assert(Math.hypot(e1.cx - mz.x, e1.cy - mz.y) > WC.range + 50, 'e1 starts out of range');
  const mask = maskOf(m);
  const shot = m.resolveShot(p, 'waterCannon', aimAt(p, e1), 100);
  assert(shot.events.length === 1 && shot.events[0].type === 'range', 'single range event: ' + brief(shot));
  const ev = shot.events[0];
  const d = Math.hypot(ev.x - mz.x, ev.y - mz.y);
  assert(d >= WC.range && d < WC.range + 2, `fizzled after ${d.toFixed(2)}px (range ${WC.range})`);
  assert(!ev.damages && !ev.carve && !ev.blast && e1.hp === e1.maxHp, 'no damage, no blast');
  assert(m.terrain.holes.length === 0 && sameMask(mask, m), 'no holes');
  assert(shot.hit.type === 'range' && shot.hitEnemy === false, 'summary: range, missed');
  return { fizzledAt: +d.toFixed(2) };
});

test('高壓水炮：射程內直擊 40、範圍 40 內的第二個敵人吃到較少的波及；擊退比狙擊槍大；不挖地形（blast = 40、沒有 carve）', () => {
  const setup = (weapon) => {
    const m = matchWith({}, { weapons: [weapon] });
    placeAt(m, m.enemies[0], m.players[0].x + 150);
    placeAt(m, m.enemies[1], m.players[0].x + 175);
    return m;
  };
  const m = setup('waterCannon');
  const p = m.players[0], [e1, e2] = m.enemies;
  const mask = maskOf(m);
  const shot = m.resolveShot(p, 'waterCannon', aimAt(p, e1), 100);
  assert(shot.events.length === 1 && shot.events[0].type === 'explode' && shot.events[0].target === 'e1', 'direct hit on e1: ' + brief(shot));
  const ev = shot.events[0];
  assert(ev.blast === WC.radius && ev.blast === blastRadius(p, WC) && !('carve' in ev), 'blast 40, no carve: ' + JSON.stringify({ blast: ev.blast, carve: ev.carve }));
  assert(m.terrain.holes.length === 0 && sameMask(mask, m), 'terrain untouched');
  const d1 = ev.damages.find(d => d.id === 'e1'), d2 = ev.damages.find(d => d.id === 'e2');
  assert(d1 && d1.dmg === WC.damage && e1.maxHp - e1.hp === WC.damage, `direct ${WC.damage}: ${JSON.stringify(d1)}`);
  assert(d2 && d2.dmg > 0 && d2.dmg < WC.damage && e2.maxHp - e2.hp === d2.dmg, 'splash on e2, reduced: ' + JSON.stringify(d2));
  assert(shot.hit.type === 'entity' && shot.hit.entityId === 'e1', 'summary');

  // 同一個位置用狙擊槍直擊：擊退照武器的 knockback 成比例（初速從 0 開始、方向一樣）
  const s = setup('sniper');
  const ss = s.resolveShot(s.players[0], 'sniper', aimAt(s.players[0], s.enemies[0]), 100);
  const vxW = ev.ents.find(q => q.id === 'e1').vx, vxS = ss.events[0].ents.find(q => q.id === 'e1').vx;
  assert(vxW > vxS && vxS > 0, `water cannon knocks harder: ${vxW} vs sniper ${vxS}`);
  assert(near(vxW / vxS, WC.knockback / W.sniper.knockback, 0.01), `knockback ratio ${vxW / vxS} vs ${WC.knockback / W.sniper.knockback}`);
  return { direct: d1.dmg, splash: d2.dmg, kbVx: +vxW.toFixed(1), sniperVx: +vxS.toFixed(1) };
});

test('高壓水炮：後座力把射手往射擊的反方向推（面向左右都一樣）、往上彈；開火的 actor 帶的是推之前的狀態；狙擊槍沒有後座力', () => {
  const out = {};
  for (const [angle, dir] of [[0, 1], [180, -1], [20, 1], [160, -1]]) {
    const m = matchWith({}, { weapons: ['waterCannon', 'sniper'] });
    const p = m.players[0];
    placeAt(m, p, 150);
    const x0 = p.x, vy0 = p.vy;
    const { shot, first } = fireAndPeek(m, p, () => m.resolveShot(p, 'waterCannon', angle, 100));
    const v = launchVelocity(WC, angle, 100);
    const sp = Math.hypot(v.vx, v.vy);
    // 跟被擊退同一套（Entity.knockBack）：水平從 0 開始往反方向 recoil，垂直一律往上
    assert(near(first.vx, -v.vx / sp * WC.recoil), `${angle}°: vx ${first.vx} want ${-v.vx / sp * WC.recoil}`);
    assert(near(first.vy, Math.min(vy0, 0) - Math.abs(v.vy / sp) * WC.recoil * 0.6 - WC.recoil * 0.35), `${angle}°: vy ${first.vy}`);
    assert(first.vy < 0 && Math.sign(first.vx) === -dir, `${angle}°: pushed back and up (${first.vx}, ${first.vy})`);
    assert(p.facing === dir, 'facing follows the shot');
    assert(dir > 0 ? p.x < x0 - 5 : p.x > x0 + 5, `${angle}°: slid opposite to the shot: ${x0} → ${p.x}`);
    assert(shot.actor.x === x0 && shot.actor.vy === vy0, 'the shot payload carries the pre-recoil state (the replay applies it once)');
    out[angle] = +(p.x - x0).toFixed(1);
  }
  const s = matchWith({}, { weapons: ['sniper'] });
  const sp1 = s.players[0];
  placeAt(s, sp1, 150);
  const sx0 = sp1.x;
  const { first: sf } = fireAndPeek(s, sp1, () => s.resolveShot(sp1, 'sniper', 0, 100));
  assert(sf.vx === 0 && sp1.x === sx0, `sniper: no recoil (vx ${sf.vx}, x ${sx0} → ${sp1.x})`);
  return out;
});

test('高壓水炮：抓著藤蔓開炮會被後座力打下藤蔓（狙擊槍不會）；固定不動的角色（fixed）沒有後座力', () => {
  const m = matchWith({}, { levelId: 'jungleSerpent', weapons: ['waterCannon', 'sniper'] });
  const p = m.players[0];
  assert(m.terrain.vines.length > 0, 'the jungle level has vines');
  const v = m.terrain.vines[0];
  p.x = v.x; p.y = 400; p.vx = p.vy = 0; p.onVine = 0; p.onGround = false;
  assert(p.canHangAt(m.terrain, 0, p.x, p.y), 'can hang there');
  m.resolveShot(p, 'sniper', 0, 100);
  assert(p.onVine === 0 && p.y === 400, `sniper from the vine: still hanging (vine ${p.onVine}, y ${p.y})`);
  const { first } = fireAndPeek(m, p, () => m.resolveShot(p, 'waterCannon', 0, 100));
  assert(first.onVine === -1, 'let go of the vine the moment it fired');
  assert(p.onVine === -1 && p.y > 450 && p.onGround, `knocked off and landed below (vine ${p.onVine}, y ${p.y.toFixed(1)})`);

  // fixed：不受重力、不會被擊退，也不會被後座力推
  const f = matchWith({}, { weapons: ['waterCannon'] });
  const fp = f.players[0];
  fp.fixed = true;
  const fx0 = fp.x, fy0 = fp.y;
  const { first: ff } = fireAndPeek(f, fp, () => f.resolveShot(fp, 'waterCannon', 0, 100));
  assert(ff.vx === 0 && ff.vy === 0 && fp.x === fx0 && fp.y === fy0, `fixed shooter did not move (${ff.vx}, ${ff.vy}; ${fp.x}, ${fp.y})`);
  const e = new Entity({ id: 't', name: 't', team: 'enemies', x: 100, y: 100, hp: 10, fixed: true });
  applyRecoil(e, WC, 2400, 0);
  assert(e.vx === 0 && e.vy === 0, 'applyRecoil leaves fixed entities alone');
  const free = new Entity({ id: 'u', name: 'u', team: 'players', x: 100, y: 100, hp: 10 });
  applyRecoil(free, W.sniper, 2400, 0);
  assert(free.vx === 0 && free.vy === 0, 'weapons without recoil do nothing');
  applyRecoil(free, WC, 2400, 0);
  assert(free.vx === -WC.recoil && free.vy < 0, `a free entity is pushed: ${free.vx}, ${free.vy}`);
  return { landedY: +p.y.toFixed(1) };
});

test('高壓水炮：瞄準預覽是直線（kind line），停在射程 300 的地方（hit.type range），跟力量無關', () => {
  const m = matchWith({}, { weapons: ['waterCannon'] });
  const p = m.players[0];
  const mz = p.muzzle();
  const pre = aimPreview(m.world, p, WC, 30, 100);
  assert(pre.kind === 'line' && pre.hit.type === 'range', `line ending at range: ${pre.kind} ${pre.hit.type}`);
  assert(pre.points[0].x === mz.x && pre.points[0].y === mz.y, 'starts at the muzzle');
  const end = pre.points.at(-1);
  const d = Math.hypot(end.x - mz.x, end.y - mz.y);
  assert(d >= WC.range && d < WC.range + 2, `ends ${d.toFixed(2)}px from the muzzle`);
  assert(pre.points.length === 2 && pre.bounced.length === 0 && pre.pierced.length === 0, 'a straight line: ' + pre.points.length);
  const low = aimPreview(m.world, p, WC, 30, 10);
  assert(low.points.at(-1).x === end.x && low.points.at(-1).y === end.y, 'power does not change the range');
  return { length: +d.toFixed(2) };
});

// ---------- 無差別轟炸 ----------

test('無差別轟炸：不挖地形（沒有坑、遮罩不變，爆炸事件帶 blast、沒有 carve），傷害照舊：直擊 50 × 攻擊者的加成', () => {
  const m = matchWith({}, { players: 2 });
  const mask = maskOf(m);
  const s = m.resolveBombard(m.players[0]);
  const booms = s.events.filter(ev => ev.type === 'explode');
  assert(booms.length >= 5, 'several missiles exploded: ' + booms.length);
  assert(booms.every(ev => ev.blast === blastRadius(m.players[0], W.bombard) && !('carve' in ev)), 'every explosion: blast, no carve');
  assert(m.terrain.holes.length === 0 && sameMask(mask, m), `terrain untouched (holes ${m.terrain.holes.length})`);
  assert(s.events.some(ev => ev.damages && ev.damages.some(d => d.dmg > 0)), 'still deals damage');

  // 直擊：先空跑一次拿到落點（同 seed 落點一樣），把 e1 擺到最近的那一發底下
  const dry = matchWith();
  const xs = dry.resolveBombard(dry.players[0]).projectiles.map(q => q.x);
  const e1x = dry.enemies[0].x;
  const x = xs.reduce((a, b) => (Math.abs(b - e1x) < Math.abs(a - e1x) ? b : a));
  const out = {};
  for (const pct of [0, 20]) {
    const h = matchWith(pct ? { damagePct: pct } : {});
    placeAt(h, h.enemies[0], x);
    const hs = h.resolveBombard(h.players[0]);
    assert(hs.projectiles.map(q => q.x).join() === xs.join(), 'same drop points');
    const direct = hs.events.find(ev => ev.target === 'e1');
    assert(direct && direct.type === 'explode' && direct.blast && !direct.carve, 'e1 took a direct hit: ' + brief(hs));
    const want = Math.round(W.bombard.damage * (1 + pct / 100));
    const got = direct.damages.find(d => d.id === 'e1').dmg;
    assert(got === want && h.enemies[0].maxHp - h.enemies[0].hp === want, `damagePct ${pct}: direct ${got}, want ${want}`);
    assert(h.terrain.holes.length === 0, 'no holes');
    out[pct] = got;
  }
  return out;
});

// ---------- 飛鏢 ----------

test('飛鏢：初速固定 2400（力量 10 跟 100 一樣），有一點重力（往下彎一點點）；傷害 10、不挖地形；飛鏢與高壓水炮都能裝備', () => {
  for (const a of [0, 30, -45, 135]) {
    const lo = launchVelocity(D, a, 10), hi = launchVelocity(D, a, 100);
    assert(lo.vx === hi.vx && lo.vy === hi.vy, `${a}°: power changes the dart speed`);
    assert(near(Math.hypot(lo.vx, lo.vy), D.speed) && D.speed === 2400, `${a}°: |v| = ${Math.hypot(lo.vx, lo.vy)}`);
  }
  assert(isEquippable('darts') && isEquippable('waterCannon'), 'equippable');
  const eq = matchWith({}, { weapons: ['darts', 'waterCannon', 'cannon'] });
  assert(eq.players[0].weapons.join() === 'darts,waterCannon,cannon', 'loadout kept: ' + eq.players[0].weapons);

  // 水平射向遠處的 e1：打中的點比砲口低一點點，剛好是 ½ g t²
  const m = matchWith({}, { weapons: ['darts'] });
  const p = m.players[0], e1 = m.enemies[0];
  const mz = p.muzzle();
  const mask = maskOf(m);
  const shot = m.resolveShot(p, 'darts', 0, 10);
  const ev = shot.events[0];
  assert(shot.events.length === 1 && ev.type === 'explode' && ev.target === 'e1', 'hit e1: ' + brief(shot));
  const t = (ev.x - mz.x) / D.speed;
  const drop = ev.y - mz.y;
  assert(drop > 0 && near(drop, 0.5 * D.gravity * t * t, 0.05), `drop ${drop} vs ½gt² ${0.5 * D.gravity * t * t}`);
  assert(drop < 0.02 * (ev.x - mz.x), `only slightly (${drop.toFixed(2)}px over ${(ev.x - mz.x).toFixed(0)}px)`);
  assert(ev.damages.length === 1 && ev.damages[0].dmg === D.damage && e1.maxHp - e1.hp === D.damage, 'one target, 10 damage: ' + JSON.stringify(ev.damages));
  assert(!ev.carve && !ev.blast && m.terrain.holes.length === 0 && sameMask(mask, m), 'no blast, no holes');
  return { flew: +(ev.x - mz.x).toFixed(1), drop: +drop.toFixed(3) };
});

test('飛鏢：瞄準預覽是完整路線（kind line），沒有彈射點，中間每 2 幀一個點、照拋物線往下彎；狙擊槍的預覽還是兩點直線', () => {
  const m = matchWith({}, { weapons: ['darts'] });
  const p = m.players[0];
  const mz = p.muzzle();
  const pre = aimPreview(m.world, p, D, 0, 50);
  assert(pre.kind === 'line' && pre.bounced.length === 0, `line without bounce points: ${pre.kind} ${JSON.stringify(pre.bounced)}`);
  assert(pre.points.length > 2, 'curve points: ' + pre.points.length);
  assert(pre.points[0].x === mz.x && pre.points[0].y === mz.y, 'starts at the muzzle');
  let prevDrop = -1;
  for (const q of pre.points.slice(1)) {
    const t = (q.x - mz.x) / D.speed;
    const drop = q.y - mz.y;
    assert(near(drop, 0.5 * D.gravity * t * t, 0.05), `point (${q.x.toFixed(1)}, ${q.y.toFixed(3)}) off the parabola`);
    assert(drop > prevDrop, 'keeps bending down');
    prevDrop = drop;
  }
  const mid = pre.points.slice(1, -1);
  assert(mid.every((q, i) => near(q.x - mz.x, D.speed * 2 * (i + 1) / 60, 1e-6)), 'one point every 2 frames');
  const end = pre.points.at(-1);
  assert(pre.hit.type === 'entity' && end.x === pre.hit.x && end.y === pre.hit.y, 'ends where it hits');
  const hi = aimPreview(m.world, p, D, 0, 100);
  assert(JSON.stringify(hi.points) === JSON.stringify(pre.points), 'power does not matter');
  const sn = aimPreview(m.world, p, W.sniper, 0, 100);
  assert(sn.kind === 'line' && sn.points.length === 2, 'sniper (no gravity): just the two ends, ' + sn.points.length);
  return { points: pre.points.length };
});

// ---------- AI ----------

test('AI：只能用飛鏢時用飛鏢直直瞄準（力量無關）；只能用高壓水炮時射程外的敵人不打（null）、射程內才打', () => {
  const m = matchWith();
  const p = m.players[0];
  const mz = p.muzzle();
  const spread = (p.ai || CONFIG.ENEMY).sniperSpread ?? 1.2;
  for (let seed = 1; seed <= 6; seed++) {
    const plan = planShot(m.world, p, new Rng(seed), ['darts']);
    assert(plan && plan.weapon === 'darts', `seed ${seed}: ${JSON.stringify(plan)}`);
    const t = m.byId(plan.targetId);
    assert(t && t.team === 'enemies' && Math.abs(plan.angle - aimAt(p, t)) <= spread + 1e-9, `seed ${seed}: aims at ${plan.targetId}`);
  }
  assert(m.enemies.every(e => Math.hypot(e.cx - mz.x, e.cy - mz.y) > WC.range), 'every enemy starts beyond 300px');
  for (let seed = 1; seed <= 6; seed++) {
    assert(planShot(m.world, p, new Rng(seed), ['waterCannon']) === null, `seed ${seed}: nothing in range → no plan`);
    const both = planShot(m.world, p, new Rng(seed), ['cannon', 'waterCannon']);
    assert(both && both.weapon === 'cannon', `seed ${seed}: out of range → lob the cannon: ${JSON.stringify(both)}`);
  }
  placeAt(m, m.enemies[0], p.x + 170);
  for (let seed = 1; seed <= 6; seed++) {
    const plan = planShot(m.world, p, new Rng(seed), ['waterCannon']);
    assert(plan && plan.weapon === 'waterCannon' && plan.targetId === 'e1', `seed ${seed}: shoots the one in range: ${JSON.stringify(plan)}`);
    assert(Math.abs(plan.angle - aimAt(p, m.enemies[0])) <= spread + 1e-9, 'aims straight at it');
  }
});

test('AI：原本的武器欄（大砲 + 狙擊槍）規劃跟以前一樣：不給第 4 個參數 = 武器欄；多帶飛鏢 / 高壓水炮還是狙擊槍優先', () => {
  const m = matchWith();
  const p = m.players[0];
  const seen = new Set();
  for (const shooter of [p, ...m.enemies]) {
    for (let seed = 1; seed <= 10; seed++) {
      const base = JSON.stringify(planShot(m.world, shooter, new Rng(seed)));
      const alts = [shooter.weapons, ['cannon', 'sniper', 'darts'], ['cannon', 'sniper', 'waterCannon'], ['darts', 'cannon', 'sniper']];
      for (const ws of alts) {
        const got = JSON.stringify(planShot(m.world, shooter, new Rng(seed), ws));
        assert(got === base, `${shooter.id} seed ${seed} ${ws}: ${got} vs ${base}`);
      }
      seen.add(JSON.parse(base).weapon);
    }
  }
  assert([...seen].every(w => w === 'cannon' || w === 'sniper'), 'default loadout only uses cannon / sniper: ' + [...seen]);
  // Match.planAiTurn：不給武器 = 給 null = 武器欄（兩場一樣的對戰，亂數一樣）
  const a = matchWith(), b = matchWith();
  const pa = a.planAiTurn(a.enemies[0]), pb = b.planAiTurn(b.enemies[0], null);
  assert(JSON.stringify(pa) === JSON.stringify(pb), 'planAiTurn(actor) === planAiTurn(actor, null)');
  return { weapons: [...seen] };
});

test('AI 代打一回合只射一發：有拋射武器時不拿飛鏢只丟一支；高壓水炮不打旁邊有隊友（或自己）會被波及的目標', () => {
  const m = matchWith({}, { players: 2 });
  const [p, p2] = m.players;
  p.ai = { ...CONFIG.ENEMY, sniperChance: 1 };   // 有視線就一定走直線那一支：飛鏢沒被選到只會是因為有大砲
  placeAt(m, p2, 30);
  placeAt(m, m.enemies[0], p.x + 170);
  const near = m.enemies[0];
  for (let seed = 1; seed <= 8; seed++) {
    const ctl = planShot(m.world, p, new Rng(seed), ['cannon', 'sniper']);
    assert(ctl && ctl.weapon === 'sniper', `seed ${seed}: control — the line branch is taken: ${JSON.stringify(ctl)}`);
    const plan = planShot(m.world, p, new Rng(seed), ['cannon', 'darts']);
    assert(plan && plan.weapon === 'cannon', `seed ${seed}: cannon over a single dart: ${JSON.stringify(plan)}`);
    const only = planShot(m.world, p, new Rng(seed), ['darts']);
    assert(only && only.weapon === 'darts', `seed ${seed}: darts only (locked) still throws: ${JSON.stringify(only)}`);
  }
  // 隊友站在射程內的目標旁邊：水炮會波及他 → 不打（只剩這個目標在射程內 = 不開火），隊友走開就打
  for (let seed = 1; seed <= 6; seed++) assert(planShot(m.world, p, new Rng(seed), ['waterCannon']).targetId === near.id, `seed ${seed}: control — water cannon at ${near.id}`);
  placeAt(m, p2, near.x + 20);
  for (let seed = 1; seed <= 6; seed++) {
    assert(planShot(m.world, p, new Rng(seed), ['waterCannon']) === null, `seed ${seed}: teammate beside the target → no water cannon`);
  }
  // 目標貼著自己：自己會被波及 → 也不打
  placeAt(m, p2, 30);
  placeAt(m, near, p.x + 40);
  for (let seed = 1; seed <= 6; seed++) {
    assert(planShot(m.world, p, new Rng(seed), ['waterCannon']) === null, `seed ${seed}: target right next to the shooter → no water cannon`);
  }
});

// ---------- 牌庫 ----------

test('牌庫：伺服器的載入流程讀 cards.json 沒有警告；飛鏢（綠）、高壓水炮（白）兩張武器牌，說明的數字跟 config 一致', () => {
  assert(loaderOut.warns.length === 0, 'loader warnings: ' + loaderOut.warns.join('; '));
  assert(Array.isArray(loaded) && loaded.length > 0 && loaderOut.logs.some(l => l.includes(String(loaded.length))), 'loaded: ' + loaderOut.logs.join('; '));
  const raw = JSON.parse(fs.readFileSync(new URL('../shared/cards.json', import.meta.url), 'utf8'));
  const { warnings } = validateCards(raw);
  assert(warnings.length === 0, warnings.join('; '));
  const byId = (id) => loaded.find(c => c.id === id);
  const darts = byId('darts'), wc = byId('water_cannon');
  assert(darts && darts.rarity === 'green' && darts.weapon === 'darts', 'darts card: ' + JSON.stringify(darts));
  assert(wc && wc.rarity === 'white' && wc.weapon === 'waterCannon', 'water cannon card: ' + JSON.stringify(wc));
  const ZH = ['零', '一', '二', '三', '四', '五'];
  const n = D.shotsPerTurn;
  assert(n === 3, 'three darts a turn');
  assert(darts.desc.includes(`傷害 ${D.damage}`) && (darts.desc.includes(`${ZH[n]}次`) || darts.desc.includes(`${n} 次`)), 'darts desc: ' + darts.desc);
  assert(wc.desc.includes(String(WC.range)) && wc.desc.includes(`傷害 ${WC.damage}`) && wc.desc.includes(`範圍 ${WC.radius}`), 'water cannon desc: ' + wc.desc);
  return { cards: loaded.length };
});

// ---------- 重播 ----------

test('重播：高壓水炮的後座力、迴力鏢去回穿透，客戶端照事件重播（shared/volley.js）跟伺服器位元級一致', () => {
  const cases = {
    waterCannon: (m) => { placeAt(m, m.enemies[0], m.players[0].x + 150); placeAt(m, m.enemies[1], m.players[0].x + 175); return [aimAt(m.players[0], m.enemies[0]), 100]; },
    waterCannonLeft: (m) => { placeAt(m, m.players[0], 250); return [180, 100]; },
    // 在空中（往上跳的途中）開炮：payload 的 vy 是推之前的，重播擺好之後照同一套推一次
    waterCannonAir: (m) => { const p = m.players[0]; placeAt(m, p, 200); p.y -= 40; p.vy = -200; p.onGround = false; return [-20, 100]; },
    // 掛在藤蔓上開炮：重播先照 payload 掛上去，再被後座力打下來
    waterCannonVine: (m) => { const p = m.players[0], v = m.terrain.vines[0]; p.x = v.x; p.y = 400; p.vx = p.vy = 0; p.onVine = 0; p.onGround = false; return [0, 100]; },
    boomerang: (m) => { placeAt(m, m.enemies[0], m.players[0].x + 70); placeAt(m, m.enemies[1], m.players[0].x + 140); return [10, 50]; },
  };
  const out = {};
  for (const [name, setup] of Object.entries(cases)) {
    const weapon = name.startsWith('waterCannon') ? 'waterCannon' : 'boomerang';
    const m = matchWith({}, { weapons: [weapon], levelId: name === 'waterCannonVine' ? 'jungleSerpent' : 'level1' });
    const [angle, power] = setup(m);
    const cm = clientOf(m);
    const shot = J(m.resolveShot(m.players[0], weapon, angle, power));
    const run = replayVolley(cm, shot);
    const drift = run.run();
    assert(drift.length === 0, `${name}: drift ${drift.join('; ')}`);
    assert(!run.settle, `${name}: ${run.settle}`);
    for (const s of shot.results) {
      const e = cm.byId(s.id);
      assert(e.x === s.x && e.y === s.y && e.hp === s.hp, `${name}: ${s.id} client ${[e.x, e.y, e.hp]} vs server ${[s.x, s.y, s.hp]}`);
    }
    const a = shot.results.find(s => s.id === 'p1');
    if (weapon === 'waterCannon') assert(a.x !== shot.actor.x, `${name}: the shooter did slide (${shot.actor.x} → ${a.x})`);
    if (name === 'waterCannonVine') assert(shot.actor.vn === 0 && cm.byId('p1').onVine === -1, 'fired from the vine, knocked off on both sides');
    out[name] = brief(shot);
  }
  return out;
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
