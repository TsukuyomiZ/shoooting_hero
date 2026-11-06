// node test/gaia-slopes.js
// 2026-11-04：大地祭壇的斜坡「子彈從下面打得穿」（使用者同意的方向：子彈從下面穿過斜坡；level.js 的 passFromBelow、Terrain.shotPasses）。
// 上面那道斜坡原本是下面那道的天花板：站在中 / 下斜坡打不到背景上方蓋亞的臉（AI 15 發只中 0~2 發），還會變成打不完的僵局。
// 測：每道斜坡 / 每層平台的 AI 命中率（每道斜坡至少 5/15，沒標的版本照舊打不到）、從上面落下來照樣撞在斜坡表面、
// 從下面穿進去在裡面開始往下掉的不會在裡面爆炸、人照樣站得住走得過（遮罩一模一樣）、AI 的直線視野、客戶端重播一致、其他地圖完全不變
import { CONFIG } from '../shared/core/config.js';
import { LEVELS } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Terrain } from '../shared/physics/terrain.js';
import { Entity } from '../shared/physics/entities.js';
import { advanceProjectile, makeProjectile, simulateShot } from '../shared/physics/weapons.js';
import { planShot, hasLineOfSight } from '../shared/ai/ai.js';
import { standY } from '../shared/maps/guardian.js';
import { gaiaOf, slopeY } from '../shared/maps/gaia.js';
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
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));

// 對照組：同一張地圖、斜坡沒標 passFromBelow（陣列複製一份就沒有那個屬性了）= 改之前的樣子
const L = LEVELS.gaiaSanctum;
LEVELS.gaiaNoPass = { ...L, pool: 'test', hardPolygons: L.hardPolygons.map(poly => poly.map(pt => pt.slice())) };
const make = (levelId = 'gaiaSanctum', seed = 1, n = 1) => new Match({ levelId, players: mkPlayers(n), seed, stage: 5 });
const T = 18;   // 斜坡的厚度（level.js 的 GAIA_SLOPE_T）

// 把 p 放到 x 那一行站得住的地方（離 refY 最近）
const place = (m, p, x, refY) => {
  const y = standY(m, p, x, refY);
  assert(y !== null, `no standing spot at ${x},${refY}`);
  Object.assign(p, { x, y, vx: 0, vy: 0, onGround: true, moveDir: 0 });
};
// 每道斜坡的正中間、每層平台中間偏左 40 px（正中間是祭壇的正中央）
function spots(m) {
  const D = m.mechState.def;
  return [
    ...D.slopes.map((s, k) => ({ name: 'S' + k, x: (s.x0 + s.x1) / 2, y: slopeY(s, (s.x0 + s.x1) / 2) })),
    ...D.tiers.map((t, k) => ({ name: 'T' + k, x: (t.x0 + t.x1) / 2 - 40, y: t.y })),
  ];
}
// AI（代打的玩家）站在 spot 對蓋亞開一槍（planShot = planAiTurn 走完路之後規劃的那一發；不走路，量的就是這個位置），15 個 seed 打中幾發
function hitRate(levelId, k, seeds = 15) {
  let hits = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const m = make(levelId, seed);
    const p = m.players[0];
    const s = spots(m)[k];
    place(m, p, s.x, s.y);
    const g = gaiaOf(m);
    g.hp = g.maxHp = 99999;
    const plan = planShot(m.world, p, m.rng, p.weapons);
    if (!plan) continue;
    m.resolveShot(p, plan.weapon, plan.angle, plan.power);
    if (g.hp < 99999) hits++;
  }
  return hits;
}
// 一顆飛行物照 advanceProjectile 飛到撞到東西為止（沒有角色），途中的位置記在 path
function fly(m, x, y, vx, vy, weaponId = 'cannon') {
  const owner = m.players[0];
  const p = makeProjectile(owner, CONFIG.WEAPONS[weaponId], x, y, vx, vy);
  p.leftOwner = true;
  const world = { ...m.world, entities: [] };
  const path = [];
  for (let f = 0; f < 600; f++) {
    const hit = advanceProjectile(world, p, CONFIG.FIXED_DT);
    path.push({ x: p.x, y: p.y, vy: p.vy });
    if (hit) return { hit, path };
  }
  return { hit: null, path };
}

// ---------------- 命中率 ----------------

await test('命中率：AI 站在每道斜坡（左右各三）的正中間對蓋亞的臉開火，15 發至少中 5 發；中間三層照舊；沒標的對照組（改之前）站中 / 下斜坡幾乎打不到', () => {
  const names = spots(make()).map(s => s.name);
  const after = {}, before = {};
  names.forEach((name, k) => { after[name] = hitRate('gaiaSanctum', k); before[name] = hitRate('gaiaNoPass', k); });
  for (const name of names) assert(after[name] >= 5, `${name}: ${after[name]}/15 ` + J(after));
  // 對照組：中 / 下斜坡（S1 S2 S4 S5）被上面那道擋住
  for (const name of ['S1', 'S2', 'S4', 'S5']) assert(before[name] <= 2, `control ${name} should be blocked: ${before[name]}`);
  // 上斜坡、中間三層頭上沒有斜坡：改之前 / 之後一樣
  for (const name of ['S0', 'S3', 'T0', 'T1', 'T2']) assert(after[name] === before[name], `${name} unchanged ${before[name]} → ${after[name]}`);
  return { before, after };
});

// ---------------- 從上面落下來 / 從下面穿進去 ----------------

await test('從上面落下來：直直往下掉、斜斜落下的砲彈照樣撞在斜坡的表面（terrain，撞到前的位置在斜坡外面）；斜坡中間被往上的砲彈穿過的那段之後也一樣撞得到', () => {
  const m = make();
  const D = m.mechState.def;
  const out = [];
  for (const [k, s] of D.slopes.entries()) {
    const x = (s.x0 + s.x1) / 2;
    for (const vx of [0, 120, -120]) {
      const { hit } = fly(m, x, slopeY(s, x) - 60, vx, 50);
      assert(hit && hit.type === 'terrain', `slope ${k} vx ${vx}: ` + J(hit && hit.type));
      const top = slopeY(s, hit.x);
      assert(hit.y >= top - 1.5 && hit.y <= top + 3, `slope ${k} hits the top surface: y ${hit.y.toFixed(1)} vs ${top.toFixed(1)}`);
      assert(!m.terrain.blocksShot(hit.px, hit.py, 'players'), 'px/py outside the slab');
      out.push(Math.round(hit.y - top));
    }
  }
  // 往上穿過左上斜坡（從底下打上去），飛過最高點再落回同一道斜坡：從上面落下來，撞在表面
  const s0 = D.slopes[0];
  const r = fly(m, 150, slopeY(s0, 150) + T + 30, 0, -420);
  assert(r.path.some(q => m.terrain.underPassAt(q.x, q.y)), 'went through the slab on the way up');
  assert(r.hit && r.hit.type === 'terrain' && r.hit.y <= slopeY(s0, r.hit.x) + 3 && r.path.some(q => q.y < slopeY(s0, 150) - 10), 'came back down onto the top ' + J(r.hit && [r.hit.type, r.hit.y]));
  return { topOffsets: out, upDown: Math.round(r.hit.y) };
});

// 11-05 審查抓到的：斜坡表面往牆那邊升高（斜率 0.25），往牆那邊、往上的角度比斜坡平的子彈還在往上飛（vy < 0）卻是從上表面鑽進去，
// 以前會整個穿過去飛出場外。上斜坡頭上沒有別的斜坡，所以站在上斜坡朝牆開的每一發都要跟沒標的對照組一模一樣
await test('從上表面鑽進去（還在往上飛、比斜坡平）：站在左上 / 右上斜坡朝牆平射的砲彈 / 狙擊照樣撞在斜坡上，跟沒標的對照組一樣；貼著表面往上坡飛的也撞到', () => {
  const kinds = (levelId, x, angle, power) => {
    const m = make(levelId);
    const p = m.players[0];
    place(m, p, x, slopeY(m.mechState.def.slopes[x < 512 ? 0 : 3], x));
    return ['cannon', 'sniper'].map(w => {
      const r = simulateShot(m.world, p, CONFIG.WEAPONS[w], angle, power, 6, 1);
      return r.hit.type === 'entity' ? 'entity:' + r.hit.entity.id : `${r.hit.type}@${Math.round(r.hit.x)},${Math.round(r.hit.y)}`;
    });
  };
  let n = 0, terrainHits = 0;
  for (const [x, a0, a1] of [[200, 160, 178], [824, 2, 20]]) {
    for (let a = a0; a <= a1; a++) for (let power = 40; power <= 100; power += 10) {
      const a1r = kinds('gaiaSanctum', x, a, power), b = kinds('gaiaNoPass', x, a, power);
      assert(J(a1r) === J(b), `x ${x} angle ${a} power ${power}: ${J(a1r)} vs control ${J(b)}`);
      n++;
      if (a1r.some(k => k.startsWith('terrain'))) terrainHits++;
    }
  }
  assert(terrainHits > 10, 'some of them do hit the slope: ' + terrainHits);
  // 左中斜坡上方 2.5 px、往左（往牆）往上 2~6° 飛：撞在表面，不會鑽進斜坡裡
  const m = make();
  const s1 = m.mechState.def.slopes[1];
  for (const deg of [2, 4, 6]) {
    const rad = deg * Math.PI / 180, x = 216;
    const { hit } = fly(m, x, slopeY(s1, x) - 2.5, -600 * Math.cos(rad), -600 * Math.sin(rad), 'sniper');
    assert(hit && hit.type === 'terrain', `${deg}°: ` + J(hit && hit.type));
    const top = slopeY(s1, hit.x);
    assert(hit.y <= top + 3 && !m.terrain.underPassAt(hit.px, hit.py), `${deg}° hits the top surface: ${hit.y.toFixed(1)} vs ${top.toFixed(1)}`);
  }
  return { shots: n, terrainHits };
});

await test('從下面穿進去、在斜坡裡面開始往下掉：不會在裡面爆炸，穿出底下之後落到下面那道斜坡的表面', () => {
  const m = make();
  const D = m.mechState.def;
  const out = {};
  for (const k of [0, 3]) {   // 左上 / 右上斜坡（底下是左中 / 右中斜坡）
    const s = D.slopes[k], below = D.slopes[k + 1];
    const x = (s.x0 + s.x1) / 2;
    const bottom = slopeY(s, x) + T;
    // 底下 6 px 起飛、最高點大約在斜坡厚度的一半（h = vy² / 2g）
    const g = CONFIG.WEAPONS.cannon.gravity;
    const vy = -Math.sqrt(2 * g * (6 + T / 2));
    const r = fly(m, x, bottom + 6, 0, vy);
    const inside = r.path.filter(q => m.terrain.underPassAt(q.x, q.y));
    assert(inside.length > 0 && inside.some(q => q.vy > 0), 'turned around inside the slab: ' + inside.length);
    assert(r.hit && r.hit.type === 'terrain', 'hit ' + J(r.hit && r.hit.type));
    const upper = slopeY(s, r.hit.x);
    assert(!(r.hit.y > upper - 2 && r.hit.y < upper + T + 2), 'did not explode inside / under the upper slab: ' + r.hit.y.toFixed(1));
    const top = slopeY(below, r.hit.x);
    assert(r.hit.y >= top - 1.5 && r.hit.y <= top + 3, `landed on the slope below: ${r.hit.y.toFixed(1)} vs ${top.toFixed(1)}`);
    out[k] = { insideFrames: inside.length, landed: Math.round(r.hit.y) };
  }
  // 對照組（沒標）：同一發在斜坡底下就撞到了
  const c = make('gaiaNoPass');
  const s = c.mechState.def.slopes[0], x = (s.x0 + s.x1) / 2;
  const rc = fly(c, x, slopeY(s, x) + T + 6, 0, -Math.sqrt(2 * CONFIG.WEAPONS.cannon.gravity * (6 + T / 2)));
  assert(rc.hit.type === 'terrain' && rc.hit.y > slopeY(s, x) + T - 3, 'control explodes on the underside ' + rc.hit.y);
  return out;
});

// ---------------- 角色照舊 ----------------

await test('角色照舊：遮罩跟沒標的一模一樣（斜坡還是炸不壞的實心）、站得住、在斜坡上走來走去、從下面跳上去照樣撞頭', () => {
  const m = make(), c = make('gaiaNoPass');
  assert(Buffer.compare(Buffer.from(m.terrain.mask), Buffer.from(c.terrain.mask)) === 0, 'same mask');
  assert(m.terrain.underPass !== null && c.terrain.underPass === null, 'only the marked level has underPass');
  const D = m.mechState.def;
  const out = [];
  for (const s of D.slopes) {
    const x = (s.x0 + s.x1) / 2;
    const run = (mm) => {
      const e = new Entity({ ...CONFIG.PLAYER, id: 'probe', team: 'players', x, y: 0, hp: 100, stamina: 9999 });
      e.y = standY(mm, e, x, slopeY(s, x) - 1);
      assert(e.y !== null && e.canStandAt(mm.terrain, e.x, e.y), 'stands on the slope');
      const world = { ...mm.world, entities: [] };
      const trace = [];
      for (let f = 0; f < 80; f++) { e.moveDir = f < 40 ? 1 : -1; e.update(CONFIG.FIXED_DT, world); trace.push(e.x, e.y, e.onGround); }
      e.moveDir = 0;
      e.wantJump = true;
      for (let f = 0; f < 60; f++) { e.update(CONFIG.FIXED_DT, world); trace.push(e.x, e.y, e.onGround); }
      return trace;
    };
    const a = run(m), b = run(c);
    assert(J(a) === J(b), 'walk / jump identical on slope ' + J(s));
    out.push(Math.round(a[a.length - 2]));   // 跳完落地的高度
  }
  // 站在中斜坡底下（下斜坡上）往上跳：頭撞到中斜坡的底面，不會穿上去
  const s1 = D.slopes[1], s2 = D.slopes[2];
  const e = new Entity({ ...CONFIG.PLAYER, id: 'probe', team: 'players', x: 60, y: 0, hp: 100, stamina: 9999 });
  e.y = standY(m, e, 60, slopeY(s2, 60) - 1);
  const world = { ...m.world, entities: [] };
  e.wantJump = true;
  let top = e.y;
  for (let f = 0; f < 60; f++) { e.update(CONFIG.FIXED_DT, world); top = Math.min(top, e.y); }
  assert(top - e.h >= slopeY(s1, 60) + T - 2, `head stops under the slope above (${(top - e.h).toFixed(1)} vs ${slopeY(s1, 60) + T})`);
  return out;
});

// ---------------- AI 的直線視野 ----------------

await test('AI 的直線視野：站在中斜坡往上看臉，直線穿過上面那道斜坡（跟飛行物同一條規則）；沒標的對照組被擋住；往下看還是被擋', () => {
  const m = make(), c = make('gaiaNoPass');
  for (const mm of [m, c]) place(mm, mm.players[0], 150, slopeY(mm.mechState.def.slopes[1], 150));
  assert(hasLineOfSight(m.world, m.players[0], gaiaOf(m)), 'sees the face through the slope above');
  assert(!hasLineOfSight(c.world, c.players[0], gaiaOf(c)), 'control blocked');
  // 從上斜坡往下看站在下斜坡的人：中斜坡擋著（從上面下來）
  const m2 = make('gaiaSanctum', 1, 2);
  const [a, b] = m2.players;
  const D = m2.mechState.def;
  place(m2, a, 150, slopeY(D.slopes[0], 150));
  place(m2, b, 150, slopeY(D.slopes[2], 150));
  assert(!hasLineOfSight(m2.world, a, b), 'looking down through the middle slope is blocked');
});

// ---------------- 重播 ----------------

await test('客戶端重播：從左中 / 右中斜坡往上穿過斜坡打中臉的那一發，重播的位置、事件、血量都跟伺服器一樣', () => {
  const out = {};
  for (const k of [1, 4]) {
    const m = make('gaiaSanctum', 3);
    const p = m.players[0];
    const D = m.mechState.def;
    const s = D.slopes[k];
    place(m, p, (s.x0 + s.x1) / 2, slopeY(s, (s.x0 + s.x1) / 2));
    const g = gaiaOf(m);
    // 找一發會打中臉、而且路上穿過斜坡的
    let found = null;
    for (let a = 30; a <= 85 && !found; a += 5) {
      const angle = k < 3 ? a : 180 - a;
      for (let power = 30; power <= 100 && !found; power += 5) {
        const r = simulateShot(m.world, p, CONFIG.WEAPONS.cannon, angle, power, 6, 1);
        if (r.hit.type === 'entity' && r.hit.entity === g && r.points.some(q => m.terrain.underPassAt(q.x, q.y))) found = { angle, power };
      }
    }
    assert(found, 'a pass-through shot exists from slope ' + k);
    const cm = make('gaiaSanctum', 3);
    cm.applySnapshot(JSON.parse(J(m.snapshot())));
    const hp0 = g.hp;
    const shot = JSON.parse(J(m.resolveShot(p, 'cannon', found.angle, found.power)));
    assert(g.hp < hp0, 'face hit');
    assert(shot.events.some(ev => ev.target === g.id), 'event on the face');
    replayChecked(cm, shot, 'slope ' + k);
    cm.applyEntities(shot.results);
    for (const e of m.entities) { const ce = cm.byId(e.id); assert(ce && Math.abs(ce.x - e.x) < 1e-6 && Math.abs(ce.y - e.y) < 1e-6 && ce.hp === e.hp, `${e.id} replay`); }
    out[k] = { ...found, dmg: hp0 - g.hp };
  }
  return out;
});

// ---------------- 其他地圖不變 ----------------

await test('其他地圖：沒有任何一張標了 passFromBelow（underPass = null）；同一組開火在 level1 / cave / spiderNest 的結果跟把 shotPasses 拿掉時一模一樣', () => {
  for (const [id, lv] of Object.entries(LEVELS)) {
    if (id === 'gaiaSanctum') continue;
    const t = new Terrain(CONFIG.WORLD_W, CONFIG.WORLD_H, lv.polygons, { hard: lv.hardPolygons, platforms: lv.platforms, stalactites: lv.stalactites });
    assert(t.underPass === null, id + ' has underPass');
  }
  const shotsOf = (levelId) => {
    const m = make(levelId, 5, 2);
    const p = m.players[0];
    const out = [];
    for (const [angle, power] of [[45, 60], [70, 80], [20, 40], [135, 70], [85, 95]]) {
      const shot = m.resolveShot(p, 'cannon', angle, power);
      out.push(J(shot.events));
      m.settle(120);
    }
    return out;
  };
  const orig = Terrain.prototype.shotPasses;
  const res = {};
  for (const id of ['level1', 'cave', 'spiderNest']) {
    const a = shotsOf(id);
    Terrain.prototype.shotPasses = () => false;
    let b;
    try { b = shotsOf(id); } finally { Terrain.prototype.shotPasses = orig; }
    assert(J(a) === J(b), id + ' shot results changed');
    res[id] = a.length;
  }
  return res;
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
