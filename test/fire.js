// node test/fire.js
// 2026-10-22：著火（shared/physics/fire.js）是共同設定、跟火把分開：任何一方的飛行物穿過場上的火源就著火，打中的對方附加火源的燃燒層數。
// 這裡測模組本身：穿過的判定（兩段線段的距離）、catchFire（誰會著火、取最大的火、只有更大的火才換、帶不了火的武器）、applyIgnite / burnOf；
// 以及「不是火把的火源」：在一般小關掛一個自訂的火源（地圖機制的 fireSources），玩家與敵人的子彈穿過它都會著火、打中對方上燃燒、
// 客戶端照事件重播一致（客戶端不用知道火源）；畫面：著火的飛行物就算是地圖畫面自己畫的招式也照樣畫火舌。
// 洞穴的火把（哪些火把對誰算數）在 test/cave.js
import { readFileSync } from 'fs';
import { CONFIG } from '../shared/core/config.js';
import { Match } from '../shared/game/match.js';
import { passesFire, catchFire, canCatchFire, applyIgnite, burnOf } from '../shared/physics/fire.js';
import { replayChecked } from './replay-check.js';

const fakeCtx = () => new Proxy({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const fakeCanvas = () => ({ width: 1024, height: 768, style: {}, getContext: fakeCtx, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }) });
globalThis.window ??= { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document ??= { addEventListener() {}, hidden: false, createElement: fakeCanvas };
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { GameView } = await import('../client/game-view.js');

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
const J = JSON.stringify;
const W = CONFIG.WEAPONS;
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const angleTo = (s, x, y) => { const m = s.muzzle(); return Math.atan2(-(y - m.y), x - m.x) * 180 / Math.PI; };

// ---------------- 判定 ----------------

test('穿過的判定：飛行物這一段離火源的線段 r + 判定半徑以內（交叉、擦過端點、平行經過、點狀的火源、這一幀沒動）', () => {
  const torch = { x0: 100, y0: 60, x1: 100, y1: 100, r: 10, burn: 20 };   // 直立的一段
  const seg = (x0, y0, x1, y1, r = 0) => ({ x0, y0, x1, y1, r });
  assert(passesFire(seg(50, 80, 150, 80), torch), 'crosses through the middle');
  assert(passesFire(seg(50, 50, 150, 50), torch) && !passesFire(seg(50, 49, 150, 49), torch), 'skims the top end: 10px yes, 11px no');
  assert(passesFire(seg(50, 49, 150, 49, 1), torch), 'the projectile radius counts too');
  assert(passesFire(seg(110, 0, 110, 200), torch) && !passesFire(seg(111, 0, 111, 200), torch), 'parallel at 10px yes, 11px no');
  assert(!passesFire(seg(0, 80, 80, 80), torch) && passesFire(seg(0, 80, 90, 80), torch), 'stops short (20px) / reaches within 10px');
  const dot = { x0: 300, y0: 300, x1: 300, y1: 300, r: 15, burn: 5 };   // 點狀的火源（兩端一樣）
  assert(passesFire(seg(280, 315, 320, 315), dot) && !passesFire(seg(280, 316, 320, 316), dot), 'a point source');
  assert(passesFire(seg(305, 305, 305, 305), dot) && !passesFire(seg(330, 300, 330, 300), dot), 'a projectile that did not move this frame');
  // 斜的兩段剛好交叉在中間、端點都離得很遠
  assert(passesFire(seg(0, 0, 400, 400), { x0: 0, y0: 400, x1: 400, y1: 0, r: 0 }), 'diagonal crossing with r 0');
});

test('catchFire：任何一方都會著火（哪些火源算數由地圖機制照射手決定）；取穿過的最大的火；已經著火的只有更大的火才換；帶不了火的不會', () => {
  const asked = [];
  const sources = [
    { x0: 100, y0: 60, x1: 100, y1: 100, r: 10, burn: 20 },
    { x0: 200, y0: 60, x1: 200, y1: 100, r: 10, burn: 35 },
    { x0: 900, y0: 60, x1: 900, y1: 100, r: 10, burn: 99 },   // 沒經過
  ];
  const match = { mechanic: { fireSources: (m, owner) => { asked.push(owner.id); return sources; } } };
  const seg = { x0: 0, y0: 80, x1: 300, y1: 80, r: 3 };
  const enemy = { id: 'e1', team: 'enemies' }, player = { id: 'p1', team: 'players' };
  assert(catchFire(match, enemy, W.sniper, {}, seg) === 35 && catchFire(match, player, W.sniper, {}, seg) === 35, 'both teams, the biggest fire passed');
  assert(J(asked) === '["e1","p1"]', 'the mechanic decides per shooter: ' + J(asked));
  assert(catchFire(match, player, W.sniper, {}, { ...seg, x1: 150 }) === 20, 'only the first one passed');
  assert(catchFire(match, player, W.sniper, { fire: 20 }, seg) === 35, 'a bigger fire upgrades');
  assert(catchFire(match, player, W.sniper, { fire: 35 }, seg) === 0 && catchFire(match, player, W.sniper, { fire: 50 }, seg) === 0, 'same or smaller: nothing new');
  assert(catchFire(match, player, W.sniper, {}, { ...seg, y0: 0, y1: 0 }) === 0, 'missed everything');
  for (const [w, p, why] of [[W.waterCannon, {}, 'noFire'], [W.cyclopsRoar, {}, 'noFire'], [W.beeSting, {}, 'bodyHit'], [W.stalactite, { added: true }, 'added']]) {
    assert(!canCatchFire(w, p) && catchFire(match, enemy, w, p, seg) === 0, `${w.id} (${why}) cannot carry fire`);
  }
  // 沒有火源的地圖（一般小關的地圖機制）：從來不會著火
  const plain = new Match({ levelId: 'level1', players: mkPlayers(1), seed: 1 });
  assert(J(plain.mechanic.fireSources(plain, plain.byId('p1'))) === '[]' && catchFire(plain, plain.byId('p1'), W.sniper, {}, seg) === 0, 'no sources on a plain map');
});

test('applyIgnite / burnOf：事件帶 ignite 才設 fire；打中時附加的燃燒 = 這一波的 burn + 火（這一下才著火的照 ignite）', () => {
  const p = { fire: 0 };
  applyIgnite(p, { type: 'pass' });
  assert(p.fire === 0, 'no ignite, no change');
  applyIgnite(p, { type: 'pass', ignite: 20 });
  assert(p.fire === 20, 'ignite sets fire');
  applyIgnite(p, { type: 'explode', ignite: 35 });
  assert(p.fire === 35, 'a bigger fire replaces it');
  assert(burnOf(30, { fire: 0 }) === 30 && burnOf(30, { fire: 20 }) === 50 && burnOf(0, { fire: 20 }, 35) === 35 && burnOf(5, {}, 0) === 5, 'burnOf');
});

test('架構：著火的規則跟火把分開——fire.js 不 import 任何東西、程式碼（註解除外）不提火把 / 洞穴 / 地圖機制的狀態；Match、volley 只透過 fire.js 著火，不直接碰火源', () => {
  const code = (f) => readFileSync(new URL(f, import.meta.url), 'utf8').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const fire = code('../shared/physics/fire.js');
  assert(!/^\s*import\s/m.test(fire), 'fire.js imports nothing');
  for (const w of ['torch', 'cave', 'mechState', 'lit', 'TORCH', 'CAVE', 'team']) assert(!new RegExp(`\\b${w}\\b`).test(fire), `fire.js mentions ${w}`);
  for (const f of ['../shared/game/match.js', '../shared/physics/volley.js']) {
    const src = code(f);
    assert(!/fireSources/.test(src), `${f} reads fire sources directly (go through catchFire)`);
    assert(!/torch/i.test(src), `${f} knows about torches`);
  }
});

// ---------------- 不是火把的火源（一般小關掛一個自訂的火源） ----------------

// 斷崖（level1）的半空中擺一個火盆（點狀的火源，r 12、burn 25）：地圖機制換成多一個 fireSources 的版本，其他照舊
function withBrazier(n = 1) {
  const m = new Match({ levelId: 'level1', players: mkPlayers(n), seed: 1 });
  const brazier = { x0: 470, y0: 330, x1: 470, y1: 330, r: 12, burn: 25 };
  m.mechanic = { ...m.mechanic, fireSources: () => [brazier] };
  return { m, brazier };
}

test('不是火把的火源：玩家的子彈穿過火盆著火、打中敵人附加 25 層；敵人的子彈穿過也會、打中玩家附加 25 層；客戶端（不知道有火盆）照事件重播一致', () => {
  const out = {};
  // 玩家 → 敵人 A（火盆擺在兩人中間的直線上）
  {
    const { m, brazier } = withBrazier(1);
    const p = m.byId('p1'), e = m.byId('e1');
    const mz = p.muzzle();
    brazier.x0 = brazier.x1 = (mz.x + e.cx) / 2;
    brazier.y0 = brazier.y1 = (mz.y + e.cy) / 2;
    const shot = m.resolveShot(p, 'sniper', angleTo(p, e.cx, e.cy), 100);
    const lit = shot.events.find(ev => ev.ignite);
    const hit = shot.events.find(ev => ev.target === 'e1');
    assert(lit && lit.type === 'pass' && lit.ignite === 25 && hit && hit.damages[0].burn === 25 && e.burn === 25, 'player shot: ' + J(shot.events));
    const c = new Match({ levelId: 'level1', players: mkPlayers(1), seed: 1 });
    replayChecked(c, JSON.parse(J(shot)), 'player brazier');
    c.applyEntities(shot.results);
    assert(J(c.entities.map(x => x.toState())) === J(m.entities.map(x => x.toState())), 'client state');
    out.player = lit.f;
  }
  // 敵人 A → P1
  {
    const { m, brazier } = withBrazier(1);
    const p = m.byId('p1'), e = m.byId('e1');
    const mz = e.muzzle();
    brazier.x0 = brazier.x1 = (mz.x + p.cx) / 2;
    brazier.y0 = brazier.y1 = (mz.y + p.cy) / 2;
    const shot = m.resolveShot(e, 'sniper', angleTo(e, p.cx, p.cy), 100);
    const hit = shot.events.find(ev => ev.target === 'p1');
    assert(shot.events.some(ev => ev.ignite === 25) && hit && hit.damages[0].burn === 25 && p.burn === 25 && p.burnSource === 'e1', 'enemy shot: ' + J(shot.events));
    const c = new Match({ levelId: 'level1', players: mkPlayers(1), seed: 1 });
    replayChecked(c, JSON.parse(J(shot)), 'enemy brazier');
    out.enemy = hit.f;
  }
  return out;
});

test('畫面：著火的飛行物就算是地圖畫面自己畫的招式（例如獨眼巨人的巨石）也畫火舌；沒著火的不畫', () => {
  const view = new GameView(fakeCanvas());
  const drawn = [];
  view.renderer.drawFire = (p) => drawn.push(p.weapon.id);
  view.mapView = { drawProjectile: () => true };   // 這顆由地圖畫面畫
  view.mapCtx = {};
  const proj = (w, fire) => ({ weapon: W[w], fire, x: 100, y: 100, vx: 300, vy: 0, x0: 0, y0: 100, trail: [{ x: 95, y: 100 }, { x: 100, y: 100 }], spin: 0 });
  view.projectiles = [proj('cyclopsBoulder', 20), proj('scorpionSting', 0)];
  view.renderer.drawProjectiles();
  assert(J(drawn) === '["cyclopsBoulder"]', 'flames drawn under the map-view projectile: ' + J(drawn));
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
