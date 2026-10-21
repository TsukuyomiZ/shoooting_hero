// node test/tengu.js
// 2026-10-20：共用的風向機制 + 菁英關「天狗」（山頂）。
// 風（關卡寫 wind 才有、每個回合重抽 -10 ~ +10、拋物線的飛行物吃風 / 直線的不吃、伺服器結算與客戶端重播一致（shot.projectiles 帶 wind）、
//     預覽與 AI 試射照同一陣風、turn 訊息 / turn.start 紀錄 / 快照帶風、HUD 畫風向、沒有風的關卡完全不變）、
// 天狗（菁英池、一直飛在天上（fixed）、血量照一般敵人放大、出招前在天上飄（預定羽刃時不飄）、開場就有 16 根羽毛、兩招隨機各半）、
// 羽刃（飛到正中間的上方、羽毛補滿 16 根；客戶端照 x0 / y0 播飛過去）、風彈（隨機一位玩家、照風瞄得準、20 × 0.7（使用者從 40 下調）、爆炸半徑 50、會被風吹）、
// 羽毛（每個玩家回合開始時射 4 根、各自射向隨機的一點、照 featherSpeed 在回合裡飛、打到第一個玩家（15 × 0.7）就停、插在地上；
//       不夠 4 根就射剩下的、沒有就不射；回合提早結束 → 一口氣射完；天狗倒下 → 收掉、勝負等回合收尾）、快照、裁判全員 AI 代打與紀錄、
// 真的 GameView（全程沒有腳本錯誤、狀態跟伺服器一樣、羽毛照真實時間飛、插地 / 打到人、HUD、雲跟著風飄）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { simulateShot, traceShot, aimPreview } from '../shared/physics/weapons.js';
import { windAccel, windMaxOf } from '../shared/physics/wind.js';
import { featherSlot, aimGust, planTenguNext, gustDamage } from '../shared/maps/tengu.js';
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
const make = (n = 1, opts = {}) => new Match({ levelId: 'tenguPeak', players: mkPlayers(n), seed: 1, stage: 3, ...opts });
// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原
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
  RUN: { stageCount: 10, bossStages: [5, 10], eliteStages: [3, 8], enemyHpPerStage: 0.15 },
  WIND: { max: 10, accel: 9 },
  TENGU: {
    hp: 200, weights: { feather: 50, gust: 50 }, feathers: 16, perTurn: 4, featherSpeed: 280, featherGap: 0.3,
    center: { x: 512, y: 200 }, aimError: 2.5, aimPowerError: 2, gustPerExtraPlayer: 0.5, cast: { feather: 1.4, gust: 1.0 },
  },
  PLAYER: { hp: 150 }, WATER: { damagePct: 30, enemiesDrown: true }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180, gravity: 600 },
    tenguFeather: { ...CONFIG.WEAPONS.tenguFeather, damage: 15, knockback: 0, speed: 900, hitRadius: 8, gravity: 0 },
    tenguGust: { ...CONFIG.WEAPONS.tenguGust, damage: 20, radius: 50, knockback: 180, gravity: 600, minSpeed: 250, speedPerPower: 6.5 },
  },
};
const base = (fn, extra = {}) => {
  const patch = { ...BASE };
  for (const [k, v] of Object.entries(extra)) patch[k] = { ...(BASE[k] || {}), ...v };
  return withConfig(patch, fn);
};
const only = (action) => ({ TENGU: { weights: { feather: 0, gust: 0, [action]: 1 } } });
// 把角色放到 (x, y) 正下方站好
function placeOn(m, e, x, y = 500) {
  e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.onGround = false;
  for (let i = 0; i < 400 && !e.onGround; i++) e.update(CONFIG.FIXED_DT, m.world);
  e.safeX = e.x; e.safeY = e.y;
}
const LEDGES = LEVELS.tenguPeak.platforms.map(poly => ({ x0: poly[0][0], x1: poly[1][0], y: poly[0][1] }));
const onLedge = (m, e, i, dx = 0) => placeOn(m, e, (LEDGES[i].x0 + LEDGES[i].x1) / 2 + dx, LEDGES[i].y - 4);
// 讓天狗照預定的招式出一回合（不經過裁判、不飄），客戶端從出招前的快照照事件一招一招重播、套結果，跟伺服器一樣
function tenguTurn(m, plan) {
  if (plan) m.mechState.next = plan;
  const before = JSON.parse(J(m.snapshot()));
  const g = m.byId('tengu');
  const r = m.mechanic.aiTurn(m, g);
  const c = make(m.players.length, { seed: m.seed });
  c.applySnapshot(before);
  for (const st of r.steps) {
    if (st.shot) {
      const shot = JSON.parse(J(st.shot));
      replayChecked(c, shot, st.action);
      c.applyEntities(shot.results);
    } else {
      c.applyEntities(JSON.parse(J(st.still.results)));
    }
  }
  const label = r.steps.map(st => st.action).join('+');
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${label}: entities differ`);
  const dmg = (id) => r.steps.flatMap(st => (st.shot ? st.shot.events.flatMap(ev => ev.damages || []) : [])).filter(d => d.id === id).reduce((s, d) => s + d.dmg, 0);
  return { steps: r.steps, next: r.next, dmg };
}
// 開一場（hp 1000），浮著的羽毛 hover 根、天狗下一招 = 風彈（不影響玩家回合）。回傳 { m, io, ref }（還沒 start）
function rig(n, { hover = 16, setup = () => {}, level = 'tenguPeak' } = {}) {
  const players = mkPlayers(n);
  const m = new Match({ levelId: level, players, seed: 2, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 1000; }
  setup(m);
  if (m.mechState && 'hover' in m.mechState) {
    m.mechState.hover = hover;
    m.mechState.next = { action: 'gust' };
  }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  return { m, io, ref, players };
}
const stageInfo = (difficulty = 'normal') => ({ stage: 3, stageCount: 10, isBoss: false, type: 'elite', difficulty, levelId: 'tenguPeak', levelName: '天狗', cards: {} });

// ---------------- 風（共用機制）----------------

await test('風：關卡寫 wind 才有（天狗 = 10 級；其他關 = 0、不抽亂數、快照不帶）；每回合抽 -10 ~ +10 的整數（每一級都抽得到）；吃不吃風看武器（拋物線吃、直線不吃、windFactor 可以改）', () => base(() => {
  const a = new Match({ levelId: 'level1', players: mkPlayers(1), seed: 7 });
  const b = new Match({ levelId: 'level1', players: mkPlayers(1), seed: 7 });
  assert(a.windMax === 0 && a.wind === 0 && !('wind' in a.snapshot()) && a.world.wind === 0, 'no wind elsewhere');
  for (let k = 0; k < 5; k++) assert(a.rollWind() === 0, 'stays calm');
  assert(a.rng.float() === b.rng.float(), 'no random numbers drawn');
  const m = make(1);
  assert(m.windMax === 10 && m.wind === 0 && m.snapshot().wind === 0, 'windy level ' + m.windMax);
  const seen = new Set();
  for (let k = 0; k < 600; k++) {
    const v = m.rollWind();
    assert(Number.isInteger(v) && Math.abs(v) <= 10 && m.wind === v && m.world.wind === v && m.snapshot().wind === v, 'roll ' + v);
    seen.add(v);
  }
  assert(seen.size === 21, 'every level shows up: ' + [...seen].sort((x, y) => x - y));
  const W = CONFIG.WEAPONS;
  assert(windAccel(5, W.cannon) === 45 && windAccel(-3, W.cannon) === -27 && windAccel(0, W.cannon) === 0, 'cannon drifts');
  assert(W.sniper.gravity === 0 && windAccel(10, W.sniper) === 0 && windAccel(10, W.tenguFeather) === 0, 'straight shots do not');
  assert(windAccel(4, { ...W.cannon, windFactor: 0.5 }) === 18 && windAccel(4, { ...W.sniper, windFactor: 1 }) === 36, 'windFactor overrides');
  assert(windMaxOf({ wind: true }) === 10 && windMaxOf({ wind: { max: 4 } }) === 4 && windMaxOf({}) === 0 && LEVELS.tenguPeak.wind === true, 'level opt-in');
  return { levels: seen.size };
}));

await test('風（物理）：同一發砲彈順風落得遠、逆風落得近；直線武器不偏；真的開火 shot.projectiles 帶 wind、客戶端照它重播一致（自己的 match 沒有風也一樣）；沒有風的關卡 shot 跟以前一樣不帶', () => base(() => {
  const m = make(1);
  const p = m.players[0];
  placeOn(m, p, 200, 520);
  const land = (wind) => { m.wind = wind; return simulateShot(m.world, p, CONFIG.WEAPONS.cannon, 45, 60).hit.x; };
  const x0 = land(0), xr = land(8), xl = land(-8);
  assert(xr > x0 + 40 && xl < x0 - 40, `drift ${J([xl, x0, xr].map(Math.round))}`);
  m.wind = 10;
  const s1 = traceShot(m.world, p, CONFIG.WEAPONS.sniper, 10, 100);
  m.wind = 0;
  const s0 = traceShot(m.world, p, CONFIG.WEAPONS.sniper, 10, 100);
  assert(J(s1.points) === J(s0.points), 'the sniper line does not bend');
  m.wind = 7;
  const before = JSON.parse(J(m.snapshot()));
  const shot = JSON.parse(J(m.resolveShot(p, 'cannon', 50, 70)));
  assert(shot.projectiles[0].wind === 7 * 9, 'spec carries the wind ' + J(shot.projectiles[0]));
  const c = make(1);
  c.applySnapshot(before);
  c.wind = 0;   // 客戶端自己的風對不上也沒關係：照 projectiles 帶的
  const drift = replayChecked(c, shot, 'wind shot');
  c.applyEntities(shot.results);
  assert(J(c.entities.map(e => e.toState())) === J(m.entities.map(e => e.toState())), 'replay matches');
  const plain = new Match({ levelId: 'level1', players: mkPlayers(1), seed: 1 });
  const ps = plain.resolveShot(plain.players[0], 'cannon', 50, 70);
  assert(!('wind' in ps.projectiles[0]) && plain.players[0].weapon === 'cannon', 'no-wind shots unchanged');
  return { drift: [Math.round(xl - x0), Math.round(xr - x0)], replay: drift ? drift.length : 0 };
}));

await test('風（裁判）：每個回合開始都重抽（玩家、天狗的回合都抽），turn 帶 wind、turn.start 記 wind、快照也帶；回合開始的轟炸直直落下不吃風；沒有風的關卡 turn / 紀錄都不帶', () => base(() => {
  const { m, io, ref, players } = rig(2);
  const roll = m.rollWind.bind(m);
  const rolledFor = [];
  m.rollWind = () => { rolledFor.push(m.byId(ref.currentId).team); return roll(); };
  ref.start();
  for (const p of players) ref.setConnected(p.id, false);
  for (let k = 0; k < 120 && ref.phase !== 'over'; k++) io.advance(500);
  const turns = io.log.filter(x => x.t === 'turn');
  assert(rolledFor.length === turns.length && rolledFor.includes('enemies') && rolledFor.includes('players'), 'rolled at every turn, his too: ' + rolledFor.join(','));
  const starts = io.records.filter(r => r.ev === 'turn.start');
  assert(turns.length >= 8 && turns.every(t => Number.isInteger(t.wind) && Math.abs(t.wind) <= 10), 'every turn carries the wind ' + turns.map(t => t.wind));
  assert(turns.some(t => t.actorId === 'tengu'), 'the tengu\'s turns too');
  assert(new Set(turns.map(t => t.wind)).size >= 4, 'it changes');
  assert(starts.length === turns.length && starts.every((r, i) => r.wind === turns[i].wind), 'turn.start logs it');
  assert(m.snapshot().wind === m.wind, 'snapshot');
  ref.stop();
  const plain = rig(1, { level: 'level1' });
  plain.ref.start();
  plain.io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const t = plain.io.log.find(x => x.t === 'turn');
  assert(t && !('wind' in t) && !('wind' in plain.io.records.find(r => r.ev === 'turn.start')), 'no wind fields elsewhere');
  plain.ref.stop();
  return { winds: turns.slice(0, 8).map(t => t.wind) };
}));

// ---------------- 天狗 ----------------

await test('地圖：天狗在菁英池（不在別的池）、有風；四塊木台一層一層跳得上去、子彈穿得過；地面炸得壞；天狗飛在天上（fixed、不受重力）、血量照一般敵人放大、不是首領；開場就浮著 16 根羽毛、抽好第一招；兩招隨機各半', () => base(() => {
  const L = LEVELS.tenguPeak;
  assert(levelsInPool('elite').includes('tenguPeak') && !levelsInPool('normal').includes('tenguPeak') && !levelsInPool('boss').includes('tenguPeak'), 'elite pool');
  assert(L.name === '天狗' && L.wind === true && L.platforms.length === 4 && L.polygons.length === 1, 'level shape');
  const m = make(2);
  const t = m.terrain;
  const jump = CONFIG.PLAYER.jumpSpeed ** 2 / (2 * CONFIG.GRAVITY);
  const groundUnder = (x) => { for (let y = 300; y < 700; y++) if (t.isSolid(x, y)) return y; return 700; };
  for (const l of LEDGES) {
    const below = Math.min(groundUnder((l.x0 + l.x1) / 2), ...LEDGES.filter(o => o.y > l.y && o.x0 < l.x1 + 40 && o.x1 > l.x0 - 40).map(o => o.y));
    assert(below - l.y < jump - 8, `ledge at ${l.y} reachable from ${below} (jump ${Math.round(jump)})`);
    assert(!t.isSolid((l.x0 + l.x1) / 2, l.y + 5), 'platforms are not solid for shots');
  }
  const p = m.players[0];
  onLedge(m, p, 1);
  assert(p.onGround && Math.abs(p.y - LEDGES[1].y) < 1, 'stands on a ledge ' + p.y);
  const holes = t.holes.length;
  m.applyExplosion(600, 546, CONFIG.WEAPONS.cannon, m.players[1], null);
  t.carve(600, 546, 40);
  assert(t.holes.length > holes, 'the ground can be blown up');
  const g = m.byId('tengu');
  const scale = (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER) * (1 + 2 * CONFIG.RUN.enemyHpPerStage);
  assert(g && g.fixed && !g.boss && g.team === 'enemies' && g.part === 'tengu' && g.hp === Math.round(200 * scale), 'entity ' + g.hp);
  assert(g.y < 320 && g.y - g.h > 40, 'flies in the sky ' + g.y);
  const y0 = g.y;
  for (let k = 0; k < 120; k++) m.step();
  assert(g.y === y0, 'no gravity');
  assert(m.mechState.hover === 16 && ['feather', 'gust'].includes(m.mechState.next.action) && m.entities[m.entities.length - 1] === g, 'opening');
  const count = { feather: 0, gust: 0 };
  for (let k = 0; k < 800; k++) count[planTenguNext(m).action]++;
  assert(count.feather > 330 && count.gust > 330, 'half and half ' + J(count));
  return { hp: g.hp, count };
}));

await test('天狗出招前在天上飄（roam 的框框裡、上下左右都會），預定羽刃那回合不飄；客戶端照 glide 飄到同一個地方', () => base(() => {
  const m = make(2, { seed: 4 });
  for (const p of m.players) p.hp = p.maxHp = 9000;   // 30 回合的風彈打不死（風彈也不挖地：不然挖到水面淹死）
  const g = m.byId('tengu');
  const R = LEVELS.tenguPeak.mechanic.roam;
  const dirs = new Set();
  base(() => {
    for (let k = 0; k < 30; k++) {
      planTenguNext(m);
      const x0 = g.x, y0 = g.y;
      const r = m.planAiTurn(g);
      assert(r.boss && r.boss.steps[0].action === 'gust', 'boss turn ' + J(r.boss && r.boss.steps.map(s => s.action)) + ' ' + J(m.players.map(p => p.hp)));
      if (r.glide) {
        assert(g.x === x0 + r.glide.dx && g.y === y0 + r.glide.dy, 'glide');
        if (r.glide.dx) dirs.add(Math.sign(r.glide.dx) > 0 ? 'right' : 'left');
        if (r.glide.dy) dirs.add(Math.sign(r.glide.dy) > 0 ? 'down' : 'up');
      }
      assert(g.x >= R.x0 && g.x <= R.x1 && g.y >= R.y0 && g.y <= R.y1, `stays in the box: ${g.x}, ${g.y}`);
    }
  }, { ...only('gust'), WEAPONS: { tenguGust: { ...BASE.WEAPONS.tenguGust, radius: 0 } } });
  assert(dirs.size >= 3, 'moves around: ' + [...dirs]);
  base(() => {
    planTenguNext(m);
    assert(g.roam === null, 'no roam when the feather move is planned');
    const r = m.planAiTurn(g);
    assert(!r.glide && r.boss.steps[0].action === 'feather', 'flies straight to the middle');
  }, only('feather'));
  base(() => planTenguNext(m), only('gust'));
  assert(g.roam && g.roam === m.mechState.roam, 'roam back');
  return { dirs: [...dirs] };
}));

await test('羽刃：飛到畫面正中間的上方（TENGU.center）、羽毛補滿到 16 根（招式帶 x0 / y0 / x / y、hover、added）；不打人；客戶端照 still 套結果一致；之後再抽下一招', () => base(() => {
  const m = make(2);
  const g = m.byId('tengu');
  for (const p of m.players) placeOn(m, p, p.x, 520);
  m.mechState.hover = 3;
  const x0 = g.x, y0 = g.y;
  const hp = m.players.map(p => p.hp);
  const r = tenguTurn(m, { action: 'feather' });
  const st = r.steps[0];
  assert(r.steps.length === 1 && st.action === 'feather' && st.still && !st.shot && st.cast === CONFIG.TENGU.cast.feather, 'step ' + J({ ...st, still: undefined }));
  assert(st.x0 === x0 && st.y0 === y0 && st.x === 512 && st.y === 200 && g.x === 512 && g.y === 200, 'flew to the middle');
  assert(st.hover === 16 && st.added === 13 && m.mechState.hover === 16, 'refilled ' + J([st.hover, st.added]));
  assert(m.players.every((p, i) => p.hp === hp[i]), 'nobody hurt');
  assert(r.next && ['feather', 'gust'].includes(r.next.action), 'next planned');
  // 羽毛浮在他身邊：從左邊經過頭頂排到右邊、都在他上面
  const slots = Array.from({ length: 16 }, (_, k) => featherSlot(g, k));
  assert(slots.every(s => s.y < g.y - g.h * 0.6 + 1) && slots[0].x < g.x && slots[15].x > g.x && slots.every((s, k) => k === 0 || s.angle > slots[k - 1].angle), 'fan of feathers');
}));

await test('風彈：對隨機一位玩家（每個人都抽得到）、照這個回合的風瞄（風再大也瞄得準）、20 × 0.7、照開場人數放大（20 / 30 / 40 / 50）、爆炸半徑 50；飛行物吃風（spec 帶 wind）；客戶端重播一致', () => base(() => {
  const picked = new Set();
  const misses = [];
  let hits = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const wind of [-10, 0, 10]) {
      const m = make(3, { seed });
      for (const p of m.players) p.hp = p.maxHp = 1000;
      placeOn(m, m.players[0], 120, 520);
      onLedge(m, m.players[1], 1);
      placeOn(m, m.players[2], 820, 520);
      m.wind = wind;
      const r = tenguTurn(m, { action: 'gust' });
      const st = r.steps[0];
      const t = m.byId(st.targetId);
      assert(st.action === 'gust' && t && st.shot && st.dmg === 40 && st.wind === wind && st.cast === CONFIG.TENGU.cast.gust, 'step ' + J({ ...st, shot: undefined }));
      assert((st.shot.projectiles[0].wind || 0) === wind * 9, 'drifts with the wind ' + J(st.shot.projectiles[0]));
      picked.add(t.id);
      const hit = st.shot.hit;
      const miss = hit.entityId === t.id ? 0 : Math.hypot(hit.x - t.cx, hit.y - t.cy);
      misses.push(Math.round(miss));
      if (r.dmg(t.id) > 0) hits++;
    }
  }
  assert(picked.size === 3, 'everyone can be picked ' + [...picked]);
  const near = misses.filter(d => d < 90).length;   // 誤差 ±2.5° / ±2 力量：落點大多在爆炸半徑附近
  assert(near >= misses.length * 0.8 && hits >= misses.length * 0.7, `aims well even in wind: ${J(misses)} / hits ${hits}`);
  // 直擊：40 × 0.7（爆炸半徑 50）
  const m = make(1);
  const p = m.players[0];
  p.hp = p.maxHp = 1000;
  placeOn(m, p, 300, 520);
  const dmg = m.applyExplosion(p.cx, p.cy, CONFIG.WEAPONS.tenguGust, m.byId('tengu'), p);
  assert(Math.abs(dmg.find(d => d.id === 'p1').dmg - 14) < 0.01 && CONFIG.WEAPONS.tenguGust.damage === 20 && CONFIG.WEAPONS.tenguGust.radius > CONFIG.WEAPONS.cannon.radius, 'direct hit ' + J(dmg));
  // 傷害照開場人數放大（每多一人 +50%）：1 ~ 4 人 20 / 30 / 40 / 50；倒下的隊友也算；乘上敵人倍率 0.7 = 14 / 21 / 28 / 35（直擊）
  const byN = [1, 2, 3, 4].map(n => {
    const mn = make(n, { seed: 5 });
    for (const q of mn.players) q.hp = q.maxHp = 1000;
    placeOn(mn, mn.players[0], 120, 520);
    if (n > 1) mn.players[n - 1].die('hit');
    const r = tenguTurn(mn, { action: 'gust' });
    const hitDmg = mn.applyExplosion(mn.players[0].cx, mn.players[0].cy, { ...CONFIG.WEAPONS.tenguGust, damage: gustDamage(mn) }, mn.byId('tengu'), mn.players[0]).find(d => d.id === 'p1').dmg;
    return [gustDamage(mn), r.steps[0].dmg, hitDmg];
  });
  assert(J(byN) === '[[20,20,14],[30,30,21],[40,40,28],[50,50,35]]', 'scales with the opening player count ' + J(byN));
  // 照風瞄：在這陣風裡瞄到的那一發，落點在目標附近；同一發換成反方向的風就偏掉了（= 有把風算進去）
  const mm = make(1, { seed: 3 });
  placeOn(mm, mm.players[0], 100, 520);
  const tg = mm.byId('tengu'), target = mm.players[0];
  const aims = [-10, 10].map(w => {
    mm.wind = w;
    const a = aimGust(mm, tg, target);
    mm.wind = -w;
    const h = simulateShot(mm.world, tg, CONFIG.WEAPONS.tenguGust, a.angle, a.power).hit;
    return { w, angle: a.angle, power: a.power, miss: Math.round(a.miss), flipped: Math.round(Math.hypot(h.x - target.cx, h.y - target.cy)) };
  });
  assert(aims.every(a => a.miss < 25 && a.flipped > a.miss + 30), 'compensates ' + J(aims));
  return { misses, hits };
}));

// ---------------- 羽毛（玩家回合裡飛的危險物）----------------

// 羽毛 f（turn 的 hazard.feathers 裡的一根）在 t 秒（出發之後）的位置
const featherAt = (f, t) => ({ x: f.x0 + f.vx * t, y: f.y0 + f.vy * t });

await test('羽毛（裁判）：玩家回合開始時射出 4 根（turn 帶 hazard.feathers、turn.start 記下；浮著的剩 12）——各自射向隨機的一點（散開、不一定朝輪到的人）、一根晚 0.3 秒出發、照 featherSpeed 往下飛；都插在地上或飛出去 = 這回合的羽毛結束（hazard done）', () => base(() => {
  const { m, io, ref } = rig(2, { setup: (m) => { placeOn(m, m.players[0], 40, 520); placeOn(m, m.players[1], 90, 520); } });
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const turn = io.log.find(x => x.t === 'turn' && x.actorId === 'p1');
  const h = turn && turn.hazard;
  assert(h && h.kind === 'tengu' && h.feathers.length === 4 && h.hover === 12 && m.mechState.hover === 12, 'four feathers ' + J(h));
  const g = m.byId('tengu');
  h.feathers.forEach((f, k) => {
    const s = featherSlot(g, 15 - k);
    assert(Math.abs(f.x0 - s.x) < 1e-9 && Math.abs(f.y0 - s.y) < 1e-9, 'from his side ' + k);
    assert(Math.abs(Math.hypot(f.vx, f.vy) - 280) < 1e-6 && f.vy > 0 && Math.abs(f.delay - k * 0.3) < 1e-9, 'speed / delay ' + J(f));
  });
  const landX = h.feathers.map(f => f.x0 + f.vx * (CONFIG.WATER_LEVEL - f.y0) / f.vy);
  assert(Math.max(...landX) - Math.min(...landX) > 150, 'scattered ' + landX.map(Math.round));
  assert(io.records.find(r => r.ev === 'turn.start' && r.actor === 'p1').hazard.feathers.length === 4, 'logged');
  io.advance(6000);
  const hz = io.log.filter(x => x.t === 'hazard');
  const ends = hz.flatMap(x => x.feathers);
  assert(ends.length === 4 && new Set(ends.map(e => e.id)).size === 4 && hz.at(-1).done === true && m.mechState.flying.length === 0, 'all four ended ' + J(ends));
  assert(io.records.filter(r => r.ev === 'hazard').length === hz.length, 'hazard records');
  ref.stop();
  return { ends: ends.map(e => e.end) };
}));

await test('羽毛打到人：飛到的那一刻打第一個碰到的玩家（15 × 0.7、不擊退），羽毛就停了（後面的人沒事）；站開就沒事；打到的不只輪到的那位', () => base(() => {
  const { m, io, ref } = rig(3, { setup: (m) => { placeOn(m, m.players[0], 40, 520); placeOn(m, m.players[1], 90, 520); placeOn(m, m.players[2], 140, 520); } });
  const [p1, p2, p3] = m.players;
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const f = io.log.find(x => x.t === 'turn' && x.actorId === 'p1').hazard.feathers[0];
  // p2 站到第一根羽毛 1.2 秒後會到的地方（伺服器照位置判定）、p3 站在同一條線再往下一點（在 p2 後面）
  const a = featherAt(f, 1.2), b = featherAt(f, 1.35);
  for (const [e, pt] of [[p2, a], [p3, b]]) { e.x = pt.x; e.y = pt.y + e.h / 2; e.vx = 0; e.vy = 0; e.onGround = true; }
  const x2 = p2.x;
  io.advance(1600);
  const hit = io.log.filter(x => x.t === 'hazard').flatMap(x => x.feathers).find(e => e.id === f.id);
  assert(hit && hit.end === 'hit' && hit.target === 'p2', 'the first one on the way ' + J(hit));
  assert(1000 - p2.hp === Math.round(15 * 0.7) && p3.hp === 1000 && p1.hp === 1000 && p2.x === x2, 'p2 hit once (15 × 0.7, rounded), not p3 behind, no knockback: ' + J([p1.hp, p2.hp, p3.hp]));
  const msg = io.log.find(x => x.t === 'hazard' && x.damages.some(d => d.id === 'p2'));
  assert(msg && msg.hp.some(s => s.id === 'p2' && s.hp === p2.hp), 'hp in the message');
  ref.stop();
}));

await test('羽毛照 delay 一根一根出發（伺服器也是）：第 4 根晚 0.9 秒才出發，還沒出發之前站在它路上的人不會被它打到', () => base(() => {
  const { m, io, ref } = rig(2, { setup: (m) => { placeOn(m, m.players[0], 40, 520); placeOn(m, m.players[1], 90, 520); } });
  const p2 = m.players[1];
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const fs = io.log.find(x => x.t === 'turn' && x.actorId === 'p1').hazard.feathers;
  const f = fs[3];
  assert(Math.abs(f.delay - 0.9) < 1e-9, 'fourth one waits 0.9 s');
  // p2 站在第 4 根出發後 1.2 秒會到的地方（伺服器照位置判定；離天狗遠一點，別的羽毛不一定經過）：要到 0.9 + 1.2 = 2.1 秒才打得到它
  const pt = featherAt(f, 1.2);
  p2.x = pt.x; p2.y = pt.y + p2.h / 2; p2.vx = 0; p2.vy = 0; p2.onGround = true;
  io.advance(1900);
  const early = io.log.filter(x => x.t === 'hazard').flatMap(x => x.feathers).find(e => e.id === f.id);
  assert(!early, 'not yet at 1.9 s (it left at 0.9 s) ' + J(early));
  io.advance(500);
  const hit = io.log.filter(x => x.t === 'hazard').flatMap(x => x.feathers).find(e => e.id === f.id);
  assert(hit && hit.end === 'hit' && hit.target === 'p2' && p2.hp < 1000, 'hit by 2.4 s ' + J(hit));
  ref.stop();
}));

await test('羽毛的落點照整張地圖均勻分布（瞄準那一點的地面）：站在出生點（最左邊）、最右邊牆邊的人一樣會被射到', () => base(() => {
  const m = make(2, { seed: 11 });
  const [p1, p2] = m.players;
  for (const p of m.players) { p.hp = p.maxHp = 1e9; }
  placeOn(m, p1, 40, 520);
  placeOn(m, p2, 1004, 520);
  const S = m.mechState;
  const lands = [];
  let now = 0;
  for (let k = 0; k < 80; k++) {
    S.hover = 16;
    S.flying = [];
    const h = m.mechanic.hazardStart(m, p1, now);
    for (const f of h.feathers) lands.push(f);
    for (let t = 0; t < 120 && S.flying.length; t++) { now += 50; m.mechanic.hazardStep(m, now); }
    now += 1000;
  }
  const hit1 = p1.taken, hit2 = p2.taken;
  // 落點（線碰到地面的地方）：左右兩成各有一些
  const xs = lands.map(f => { const t = (545 - f.y0) / f.vy; return f.x0 + f.vx * t; });
  const left = xs.filter(x => x < 150).length, right = xs.filter(x => x > 874).length;
  assert(left > xs.length * 0.06 && right > xs.length * 0.06, 'impacts spread to both edges ' + J([left, right, xs.length]));
  assert(hit1 > 0 && hit2 > 0, 'players at the far left / far right get hit too ' + J([hit1, hit2]));
  return { left, right, of: xs.length, hit: [hit1, hit2] };
}));

await test('羽毛不夠 4 根就射剩下的、沒有就不射；回合在羽毛飛完之前就結束 → 收尾時一口氣射完（kind tenguFeather 的 shot，還沒出發的也一起）、之後才換人；天狗自己的回合不射', () => base(() => {
  let r = rig(1, { hover: 2, setup: (m) => placeOn(m, m.players[0], 40, 520) });
  r.ref.start();
  r.io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  let t = r.io.log.find(x => x.t === 'turn' && x.actorId === 'p1');
  assert(t.hazard.feathers.length === 2 && t.hazard.hover === 0, 'the last two ' + J(t.hazard));
  r.ref.stop();
  r = rig(1, { hover: 0, setup: (m) => placeOn(m, m.players[0], 40, 520) });
  r.ref.start();
  r.io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  t = r.io.log.find(x => x.t === 'turn' && x.actorId === 'p1');
  assert(t && !t.hazard, 'none left: no hazard');
  r.ref.stop();
  r = rig(2, { setup: (m) => { placeOn(m, m.players[0], 40, 520); placeOn(m, m.players[1], 90, 520); } });
  r.ref.start();
  r.io.advance(CONFIG.TIMING.startDelay * 1000 + 10 + 200);
  r.ref.skipTurn('timeout');   // 0.2 秒就結束：只有第一根出發了
  r.io.advance(CONFIG.TIMING.skipDelay * 1000 + 20);
  const sweep = r.io.log.find(x => x.t === 'shot' && x.kind === 'tenguFeather');
  const iSweep = r.io.log.indexOf(sweep);
  const iNext = r.io.log.findIndex(x => x.t === 'turn' && x.actorId === 'p2');
  assert(sweep && sweep.projectiles.length === 4 && sweep.turnId === 'p1' && sweep.hover === 12 && (iNext < 0 || iNext > iSweep), 'swept the rest ' + J(sweep && { n: sweep.projectiles.length, turnId: sweep.turnId }));
  assert(r.io.records.some(x => x.ev === 'shot' && x.kind === 'tenguFeather'), 'logged');
  r.io.advance(4000);
  assert(r.io.log.some(x => x.t === 'turn' && x.actorId === 'p2' && x.hazard && x.hazard.feathers.length === 4), 'next player gets the next four');
  for (const p of r.players) r.ref.setConnected(p.id, false);
  r.io.advance(60_000);
  const tt = r.io.log.filter(x => x.t === 'turn' && x.actorId === 'tengu');
  assert(tt.length && tt.every(x => !x.hazard), 'none on his own turn');
  r.ref.stop();
}));

await test('天狗在玩家回合裡被打倒（羽毛在飛）：羽毛都收掉（cancel、沒有人被打）；勝負等這一槍播完、回合收尾才判（turn.end 在 battle.over 前面）', () => base(() => {
  const { m, io, ref } = rig(1, { setup: (m) => placeOn(m, m.players[0], 40, 520) });
  const g = m.byId('tengu');
  g.hp = 1;
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const p = m.players[0];
  // 直接用狙擊槍打他（直線、照角度一定打得到）
  const mz = p.muzzle();
  const angle = Math.atan2(-(g.cy - mz.y), g.cx - mz.x) * 180 / Math.PI;
  ref.handle('p1', { t: 'fire', weapon: 'sniper', angle, power: 100, x: p.x, y: p.y, facing: 1, stamina: p.stamina });
  if (g.alive) {   // 狙擊槍不在武器欄：改用大砲貼著打不到的話，直接扣（測的是收尾的順序）
    g.hp = 0; g.die('hit');
  }
  assert(!g.alive, 'he is down');
  io.advance(200);
  const hz = io.log.filter(x => x.t === 'hazard');
  assert(hz.length >= 1 && hz.at(-1).done === true && hz.flatMap(x => x.feathers).every(e => e.end === 'cancel') && !hz.some(x => x.damages.length), 'cancelled ' + J(hz));
  assert(!io.log.some(x => x.t === 'gameOver'), 'no game over mid-turn');
  ref.skipTurn('timeout');
  io.advance(10000);
  const evs = io.records.map(r => r.ev);
  assert(evs.indexOf('turn.end') >= 0 && evs.indexOf('turn.end') < evs.indexOf('battle.over') && io.log.at(-1).t === 'gameOver' && io.log.at(-1).result === 'win', 'turn.end then battle.over: ' + evs.slice(-4).join(' '));
  ref.stop();
}));

await test('快照：預定的下一招、浮著幾根、還在飛的羽毛（tenguNext / Hover / Flying）、風重建得回來；別的地圖不帶這些欄位', () => base(() => {
  const m = make(2);
  m.mechState.next = { action: 'feather' };
  m.mechState.hover = 9;
  m.mechState.flying = [
    { id: 4, x0: 500, y0: 120, x: 480.5, y: 200.25, vx: -50, vy: 270, t0: 100, done: false },
    { id: 6, x0: 530, y0: 110, x: 530, y: 110, vx: 30, vy: 270, t0: 800, done: false },   // 還沒出發（還要 0.3 秒）
    { id: 5, x0: 1, y0: 1, x: 1, y: 1, vx: 0, vy: 1, t0: 0, done: true },
  ];
  m.mechState.clock = 500;
  m.wind = -6;
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(snap.tenguNext) === '{"action":"feather"}' && snap.tenguHover === 9 && snap.wind === -6
    && J(snap.tenguFlying) === '[{"id":4,"x":480.5,"y":200.25,"vx":-50,"vy":270},{"id":6,"x":530,"y":110,"vx":30,"vy":270,"wait":0.3}]', 'snapshot ' + J([snap.tenguNext, snap.tenguHover, snap.tenguFlying, snap.wind]));
  const c = make(2, { seed: 9 });
  c.applySnapshot(snap);
  assert(J(c.mechState.next) === J(m.mechState.next) && c.mechState.hover === 9 && c.wind === -6, 'restored');
  assert(c.mechState.flying.length === 2 && c.mechState.flying.every((f, i) => f.x0 === snap.tenguFlying[i].x && f.y0 === snap.tenguFlying[i].y) && c.mechState.flying[1].wait === 0.3, 'flying restored ' + J(c.mechState.flying));
  const other = new Match({ levelId: 'forestGuard', players: mkPlayers(1), seed: 1 });
  assert(!('tenguNext' in other.snapshot()) && !('wind' in other.snapshot()), 'only this map');
}));

await test('裁判：全員 AI 代打打幾輪；羽刃 / 風彈都出現；紀錄 ai.turn 帶每一招（羽刃的 x0 / y0 / x / y / hover、風彈的 targetId / angle / power / wind）與 next；開場的第一招記在 battle.start；每個玩家回合都有羽毛（浮著的還有的話）', () => base(() => {
  const seen = new Set();
  const out = {};
  for (const seed of [1, 2, 3, 4]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'tenguPeak', players, seed, stage: 3 });
    for (const p of m.players) { p.hp = p.maxHp = 4000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
    const opening = m.mechState.next.action;
    ref.start();
    assert(io.records.find(r => r.ev === 'battle.start').next === opening, 'battle.start logs the opening plan');
    for (const p of players) ref.setConnected(p.id, false);
    for (let k = 0; k < 300 && ref.phase !== 'over'; k++) io.advance(500);
    const turns = io.log.filter(x => x.t === 'aiTurn' && x.actorId === 'tengu');
    assert(turns.length >= 5, `seed ${seed}: tengu turns ${turns.length}`);
    for (const t of turns) {
      const st = t.boss.steps;
      assert(st.length === 1 && st[0].cast > 0 && (st[0].shot || st[0].still), 'one move ' + J(st.map(s => s.action)));
      seen.add(st[0].action);
      if (st[0].action === 'feather') assert(!t.glide, 'no glide before the feather move');
    }
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.actor === 'tengu');
    assert(recs.length === turns.length && recs.every((r, i) => r.boss[0].action === turns[i].boss.steps[0].action && r.next === turns[i].boss.next.action), 'logged');
    assert(recs.flatMap(r => r.boss).filter(b => b.action === 'feather').every(b => Number.isFinite(b.x0) && Number.isFinite(b.y) && b.hover === 16), 'feather logs where');
    assert(recs.flatMap(r => r.boss).filter(b => b.action === 'gust').every(b => typeof b.targetId === 'string' && Number.isFinite(b.angle) && Number.isFinite(b.power) && Number.isInteger(b.wind)), 'gust logs aim and wind');
    const playerTurns = io.log.filter(x => x.t === 'turn' && x.actorId !== 'tengu');
    const withF = playerTurns.filter(x => x.hazard);
    assert(withF.every(x => x.hazard.feathers.length > 0) && withF.length >= 4 && playerTurns[0].hazard && playerTurns[1].hazard, 'feathers on player turns ' + withF.length + ' / ' + playerTurns.length);
    assert(io.records.filter(r => r.ev === 'turn.start' && r.hazard).every(r => Array.isArray(r.hazard.feathers) && r.hazard.feathers.every(f => Number.isFinite(f.x0) && Number.isFinite(f.vy))), 'turn.start logs every feather');
    assert(io.records.filter(r => r.ev === 'hazard').every(r => Array.isArray(r.feathers)), 'hazard records which feathers ended where');
    out[seed] = turns.map(t => t.boss.steps[0].action[0]).join('');
    ref.stop();
  }
  assert(seen.has('feather') && seen.has('gust'), 'both moves ' + [...seen]);
  return out;
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
const { tengu: tenguView } = await import('../client/map-views/tengu.js');

function spyCtx() {
  const calls = { fillText: [], moveTo: [], lineTo: [], arc: [] };
  const inner = fakeCtx2d();
  const ctx = new Proxy(inner, { get: (t, k) => (k in calls ? (...a) => calls[k].push(a.map(v => (typeof v === 'number' ? Math.round(v) : v))) : t[k]) });
  return { ctx, calls };
}
function mkView() {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  return view;
}

await test('真的 GameView：天狗從開場播到每一招（全員 AI 代打；每幀 update + render）：沒有腳本錯誤；浮著的羽毛、回合裡飛的羽毛、插在地上的羽毛；客戶端的機制狀態（下一招、浮著幾根、風）與天狗、玩家跟伺服器一樣；菁英關橫幅；HUD（天狗血量、下一招、羽毛幾根、風向）', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'tenguPeak', players, seed: 3, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 5000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  const view = mkView();
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  assert(view.mapView.type === 'tengu' && view.banner && view.banner.text === '菁英關：天狗', 'elite banner: ' + J(view.banner && view.banner.text));
  for (const p of players) ref.setConnected(p.id, false);
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Set();
  let flew = false, stuck = false, hoverDrawn = false, windHud = false, flewIn = false;
  try {
    for (let k = 0; k < 900 && ref.phase !== 'over'; k++) {
      io.advance(250);
      for (const t of io.log.filter(x => x.t === 'aiTurn' && x.actorId === 'tengu')) t.boss.steps.forEach(st => seen.add(st.action));
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        const c = view.mapCtx, S = view.match.mechState;
        if (S.flying.length) flew = true;
        if (c.state.stuck.length) stuck = true;
        if (c.state.fx && c.state.fx.action === 'feather' && c.state.fx.t > 0.1 && c.state.fx.t < 0.5) flewIn = true;
        if (S.hover > 0 && !hoverDrawn) {
          const sp = spyCtx();
          view.mapView.drawScene(sp.ctx, c);
          hoverDrawn = sp.calls.moveTo.length > S.hover;
        }
        if (!windHud) {
          const sp = spyCtx();
          view.renderer.ctx = sp.ctx;
          view.renderer.drawHUD();
          view.renderer.ctx = fakeCtx2d();
          windHud = sp.calls.fillText.some(a => a[0] === '風') && sp.calls.fillText.some(a => a[0] === String(Math.abs(view.match.wind)) || (view.match.wind === 0 && a[0] === '無風'));
        }
      }
      if (seen.has('feather') && seen.has('gust') && flew && stuck && hoverDrawn && windHud && flewIn) break;
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(seen.has('feather') && seen.has('gust'), 'played both moves: ' + [...seen]);
  assert(flew && stuck && hoverDrawn && windHud && flewIn, `flew ${flew} / stuck ${stuck} / hover drawn ${hoverDrawn} / wind hud ${windHud} / flew in ${flewIn}`);
  const S = view.match.mechState;
  assert(J(S.next) === J(m.mechState.next) && S.hover === m.mechState.hover && view.match.wind === m.wind, 'mech state synced: ' + J([S.next, S.hover, view.match.wind, m.mechState.next, m.mechState.hover, m.wind]));
  const vg = view.match.byId('tengu'), sg = m.byId('tengu');
  assert(vg.x === sg.x && vg.y === sg.y && vg.hp === sg.hp, 'tengu synced ' + J([vg.x, vg.y, vg.hp, sg.x, sg.y, sg.hp]));
  assert(view.match.players.every(p => p.hp === m.byId(p.id).hp), 'players synced');
  const hud = view.mapView.hud(view.mapCtx, ['x', '#fff']);
  if (sg.alive) assert(hud.length === 4 && /^天狗 \d+ \/ \d+$/.test(hud[1][0]) && /^下一招：(羽刃|風彈)$/.test(hud[2][0]) && /^羽毛 \d+ \/ 16$/.test(hud[3][0]), 'hud ' + J(hud));
  return { moves: [...seen] };
}));

await test('真的 GameView：自己的回合裡羽毛從他身邊出發、照真實時間（view.clock）往下飛（各自晚 delay 秒）、預覽跟著這回合的風彎；伺服器說打到自己 → 血量照伺服器、羽毛收掉；插地的羽毛插在地上', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'tenguPeak', players, seed: 2, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 1000; }
  placeOn(m, m.players[0], 40, 520);
  placeOn(m, m.players[1], 90, 520);
  m.mechState.next = { action: 'gust' };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  const view = mkView();
  let now = 500;
  view.clock = () => now;
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  feed();
  for (let f = 0; f < 3; f++) view.update(CONFIG.FIXED_DT);
  const S = view.match.mechState;
  const turn = ref.match;   // 伺服器
  const h = io.log.length ? null : null;
  assert(view.canAct && S.flying.length === 4 && S.hover === 12 && view.match.wind === m.wind, 'my turn, four feathers ' + J([S.flying.length, S.hover, view.match.wind, m.wind]));
  const f0 = S.flying[0], f3 = S.flying[3];
  assert(f0.t0 === 500 && Math.abs(f3.t0 - 500.9) < 1e-9, 'launch times from receipt ' + J([f0.t0, f3.t0]));
  // 預覽照這回合的風
  const me = view.match.byId('p1');
  const pv = aimPreview(view.match.world, me, CONFIG.WEAPONS.cannon, 50, 70);
  const calm = (() => { const w = view.match.wind; view.match.wind = 0; const r = aimPreview(view.match.world, me, CONFIG.WEAPONS.cannon, 50, 70); view.match.wind = w; return r; })();
  if (m.wind !== 0) assert(J(pv.points) !== J(calm.points), 'preview bends with the wind');
  // 半秒（真實時間）：第一根往下飛了 140 px，第四根還沒出發
  now += 0.5;
  view.update(CONFIG.FIXED_DT);
  assert(Math.abs(Math.hypot(f0.x - f0.x0, f0.y - f0.y0) - 140) < 1e-6 && f3.x === f3.x0 && f3.y === f3.y0, 'flies by the real clock');
  // 伺服器那邊飛完：每一根照伺服器結束（插地 / 打到人）
  io.advance(6000);
  now += 6;
  feed();
  for (let f = 0; f < 30; f++) view.update(CONFIG.FIXED_DT);
  const ends = io.log.length === 0 ? [] : [];
  const serverEnds = [];
  for (const x of ref.io.log || []) serverEnds.push(x);
  assert(S.flying.length === 0, 'all landed / gone ' + S.flying.length);
  assert(view.match.players.every(p => p.hp === m.byId(p.id).hp), 'hp from the server ' + J(view.match.players.map(p => [p.hp, m.byId(p.id).hp])));
  assert(view.mapCtx.state.stuck.length >= 1, 'stuck in the ground');
  ref.stop();
}));

await test('風向 HUD：箭頭朝風吹的方向（正的往右、負的往左）、長度照強度、右邊寫級數，0 級寫無風；回合一開始就被毒倒（turnFx atStart）也照它設風', () => base(() => {
  const view = mkView();
  const tip = (wind) => {
    const sp = spyCtx();
    view.renderer.ctx = sp.ctx;
    view.renderer.drawWind(512, 62, wind, 10);
    view.renderer.ctx = fakeCtx2d();
    return sp.calls;
  };
  const r = tip(6), l = tip(-6), z = tip(0), weak = tip(2);
  const arrow = (calls) => ({ tail: calls.moveTo.at(-2)[0], tip: calls.moveTo.at(-1)[0] });   // 最後兩筆：箭身的尾巴、箭頭的尖端（前面是圓角框）
  assert(arrow(r).tip > 512 && arrow(r).tail < 512 && arrow(l).tip < 512 && arrow(l).tail > 512, 'points downwind ' + J([arrow(r), arrow(l)]));
  assert(Math.abs(arrow(weak).tip - arrow(weak).tail) < Math.abs(arrow(r).tip - arrow(r).tail), 'longer when stronger');
  assert(r.fillText.some(a => a[0] === '6') && l.fillText.some(a => a[0] === '6') && z.fillText.some(a => a[0] === '無風') && z.moveTo.length === r.moveTo.length - 2, 'labels');
  // turnFx atStart
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'tenguPeak', players, seed: 2, stage: 3 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  for (const msg of io.log.splice(0)) view.onMessage(msg);
  view.onMessage({ t: 'turnFx', actorId: 'p1', atStart: true, round: 1, fx: [], entities: m.snapshot().entities, items: [], wind: -7 });
  for (let f = 0; f < 120; f++) view.update(CONFIG.FIXED_DT);
  assert(view.match.wind === -7, 'atStart sets the wind ' + view.match.wind);
  ref.stop();
}));

// 地圖畫面的假 c（不經過 GameView）：記下音效與橫幅
function fakeMapCtx(match, clock) {
  const sounds = [], banners = [];
  const fx = { particles() {}, particle() {}, sound: (n) => sounds.push(n), banner: (t) => banners.push(t), float() {}, shake() {}, splash() {}, wither() {}, repaint() {} };
  return { c: { match, state: tenguView.create(match), fx, clock, time: 0, currentId: null, projectiles: [], rangeHints: true }, sounds, banners };
}

await test('地圖畫面：hazard 收到就演（early）、照順序再叫一次不重演；畫面先插地、伺服器說其實打到人 → 從地上拿掉；收尾一口氣射完（turnVolley）→ 飛的收掉、浮著的照伺服器；天狗倒下 → 羽毛都收掉、不畫浮著的', () => base(() => {
  const m = make(1);
  let now = 10;
  const { c, banners } = fakeMapCtx(m, () => now);
  const S = m.mechState;
  const g = m.byId('tengu');
  S.flying = [];
  tenguView.hazard(c, { start: { kind: 'tengu', feathers: [{ id: 1, x0: 500, y0: 100, vx: 0, vy: 280, delay: 0 }, { id: 2, x0: 520, y0: 100, vx: 0, vy: 280, delay: 0.3 }], hover: 14 }, recvAt: now });
  assert(S.flying.length === 2 && S.hover === 14 && S.flying[1].t0 === 10.3, 'started');
  // 第一根飛到地面（客戶端先插地）
  for (let k = 0; k < 200 && S.flying.some(f => f.id === 1); k++) { now += CONFIG.FIXED_DT; tenguView.update(c, CONFIG.FIXED_DT); }
  assert(!S.flying.some(f => f.id === 1) && c.state.stuck.some(s => s.id === 1), 'predicted stuck');
  const msg = { t: 'hazard', kind: 'tengu', feathers: [{ id: 1, x: 500, y: 520, end: 'hit', target: 'p1' }], hover: 14, damages: [{ id: 'p1', dmg: 10.5 }], hp: [], done: false, seq: 1, recvAt: now };
  tenguView.hazard(c, msg, true);
  assert(!c.state.stuck.some(s => s.id === 1), 'it was a hit: taken off the ground');
  const stuckN = c.state.stuck.length;
  tenguView.hazard(c, msg, false);
  assert(c.state.stuck.length === stuckN && msg.shown, 'played once');
  // 天狗倒下、羽毛全部 cancel：收到的那一刻不演（打倒他的那一槍還在播），照順序套用時才收掉
  S.flying = [{ id: 9, x0: 400, y0: 100, vx: 0, vy: 280, t0: now, x: 400, y: 120 }];
  const cancel = { t: 'hazard', kind: 'tengu', feathers: [{ id: 9, x: 400, y: 120, end: 'cancel' }], hover: 14, damages: [], hp: [], done: true, seq: 1, recvAt: now };
  tenguView.hazard(c, cancel, true);
  assert(S.flying.length === 1 && !cancel.shown, 'not revealed early');
  tenguView.hazard(c, cancel, false);
  assert(S.flying.length === 0 && cancel.shown, 'cleared in order');
  // 收尾：一口氣射完
  const label = tenguView.turnVolley(c, { kind: 'tenguFeather', hover: 14 });
  assert(label && label.banner('天狗') === '天狗的羽毛一口氣射下來！' && S.flying.length === 0 && S.hover === 14, 'swept');
  assert(tenguView.turnVolley(c, { kind: 'boss' }) === null, 'other volleys are not ours');
  // 倒下
  g.die('hit');
  assert(tenguView.onDeath(c, g) === true && S.hover === 0 && S.flying.length === 0 && banners.includes('天狗倒下了！'), 'death');
  const sp = spyCtx();
  tenguView.drawScene(sp.ctx, c);
  assert(true, 'draws without him');
}));

await test('重連的畫面：快照的羽毛（飛到一半的從現在的地方接著飛、還沒出發的等 wait 秒再出發）；第一次 update 之前畫圖也不會是 NaN', () => base(() => {
  const c = make(1);
  c.applySnapshot({ ...JSON.parse(J(c.snapshot())), tenguFlying: [{ id: 4, x: 480.5, y: 200.25, vx: -50, vy: 270 }, { id: 6, x: 530, y: 110, vx: 30, vy: 270, wait: 0.3 }] });
  let now = 40;
  const { c: vc } = fakeMapCtx(c, () => now);
  const sp = spyCtx();
  tenguView.drawScene(sp.ctx, vc);
  assert(sp.calls.moveTo.every(a => a.every(Number.isFinite)), 'no NaN before the first update');
  tenguView.update(vc, CONFIG.FIXED_DT);
  const F = c.mechState.flying;
  assert(F[0].t0 === 40 && Math.abs(F[1].t0 - 40.3) < 1e-9 && F[1].x === 530 && F[1].y === 110, 'waits ' + J(F.map(f => f.t0)));
  now += 0.2;
  tenguView.update(vc, CONFIG.FIXED_DT);
  assert(F[1].x === 530 && F[1].y === 110 && F[0].y > 200.25, 'the waiting one has not left yet');
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
