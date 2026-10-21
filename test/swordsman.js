// node test/swordsman.js
// 2026-10-19：菁英關「流浪劍士」（黃昏的荒原）；2026-10-20 一閃改了兩次（最後：回到他的回合斬、對每一位玩家各一道預警線）、拔刀恢復。
// 地圖（菁英池、整片地面炸不壞、五塊排成金字塔的可穿透浮石，一層一層跳得上去、劍氣的四排就是地面與三層浮石的頂面）、
// 劍士（fixed、血量照一般敵人放大、不是首領、站在地面最右邊、出招前沿地面走（不走到右下石台底下；預定一閃時不走）、開場就抽好第一招、
//       三招都抽得到、一閃最常見）、
// 一閃（抽到的那一刻對每一位活著的玩家各劃一道預警線——從刀口指向那個人、延伸到地圖邊 / 地面、斜的也可以；記在 next（快照、紀錄 nextTargets）；
//       輪到他時沿著這幾道線一起斬下去：之後走開的人躲得掉、走進線裡的人會被打；50 × 0.7、每人最多一刀、不擊退；客戶端重播一致）、
// 劍氣（一直都有、不是他的招式。開場就揮出 3 道（四排裡隨機 3 排）；每位玩家的回合開始時最前面那道出發，在回合裡照 qiSpeed 慢慢往左飛
//       （裁判每 50 ms 推進）：飛到人的那一刻才打——那一排的人都會被打、40 × 0.7、每人一次；離開那一排 / 跳過去就躲得掉；
//       回合提早結束 → 收尾時一口氣掃完剩下那段；被打倒 → 這回合結束；飛完馬上再揮一輪；AI 代打的回合也有、劍士的回合沒有）、
// 拔刀（刀氣直線飛向一人、站在平台上的優先、其中最近的；擊退 200；客戶端重播一致）、
// 格擋架勢（他的回合擺出來、減傷 50%、被玩家打中才算次數、記下是誰打中的、need = ceil(人數 × 0.5)；下一回合：次數夠 → 先反擊的一閃
//           （只對第一個打中他的玩家：一道線指向他現在的位置、沒有預警、馬上斬；他倒下換下一個打中他的，都倒下不反擊）再出預定的招，
//           不夠 → 只出預定的招；架勢到他的回合開始為止）、快照重建、裁判流程與紀錄、
// 真的 GameView 播一段（握刀柄的架勢、一閃的預警線（一般難度畫、菁英之路不畫）、出招時線從刀口劃出去、斬下去的白光、浮在右邊的劍氣、
// 回合裡飛的那一道（照真實時間、卡頓 / 慢動作也一樣快）、打到人的血量與飄字、HUD、客戶端的機制狀態跟伺服器一樣、危險物的畫面收到就演）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { qiBand, parryNeed, planSwordsmanNext, drawTarget, bladePoint, slashLine } from '../shared/maps/swordsman.js';
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
const make = (n = 1, opts = {}) => new Match({ levelId: 'wanderer', players: mkPlayers(n), seed: 1, stage: 3, ...opts });
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
  SWORDSMAN: {
    hp: 200, weights: { iai: 50, parry: 25, draw: 25 }, qiCount: 3, qiSpeed: 140, parryCut: 50, parryPerPlayer: 0.5,
    walk: { speed: 60, edge: 4 }, cast: { iai: 1.1, counter: 0.5, parry: 0.6, draw: 0.8 },
  },
  PLAYER: { hp: 150 }, WATER: { damagePct: 30, enemiesDrown: true }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180 },
    swordsmanIai: { ...CONFIG.WEAPONS.swordsmanIai, damage: 50, knockback: 0, speed: 2400, hitRadius: 14 },
    swordsmanQi: { ...CONFIG.WEAPONS.swordsmanQi, damage: 40, knockback: 0, speed: 1000, hitRadius: 18 },
    swordsmanDraw: { ...CONFIG.WEAPONS.swordsmanDraw, damage: 20, knockback: 200, speed: 1500, hitRadius: 10 },
  },
};
const base = (fn, extra = {}) => {
  const patch = { ...BASE };
  for (const [k, v] of Object.entries(extra)) patch[k] = { ...(BASE[k] || {}), ...v };
  return withConfig(patch, fn);
};
const only = (action) => ({ SWORDSMAN: { weights: { iai: 0, parry: 0, draw: 0, [action]: 1 } } });
// 五塊浮石的頂面（照平台多邊形的頭兩點）、劍氣的四排
const LEDGES = LEVELS.wanderer.platforms.map(poly => ({ x0: poly[0][0], x1: poly[1][0], y: poly[0][1] }));
const ROWS = LEVELS.wanderer.mechanic.rows;
// 把角色放到 (x, y) 正下方站好
function placeOn(m, e, x, y = 540) {
  e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.onGround = false;
  for (let i = 0; i < 400 && !e.onGround; i++) e.update(CONFIG.FIXED_DT, m.world);
  e.safeX = e.x; e.safeY = e.y;
}
// 站在第 i 個平台的中間（dx = 從中間往右挪多少）
const onLedge = (m, e, i, dx = 0) => placeOn(m, e, (LEDGES[i].x0 + LEDGES[i].x1) / 2 + dx, LEDGES[i].y - 4);
// 照預定的招式讓劍士出一回合（不經過裁判、不走路），順便讓客戶端從出招前的快照照事件一招一招重播、套結果，跟伺服器一樣
function swordTurn(m, plan) {
  if (plan) m.mechState.next = plan;
  const before = JSON.parse(J(m.snapshot()));
  const g = m.byId('swordsman');
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
// 線段 L（{x0,y0,x1,y1} 或 [x0,y0,x1,y1]）離點 (px, py) 多遠
function segDist(L, px, py) {
  const [x0, y0, x1, y1] = Array.isArray(L) ? L : [L.x0, L.y0, L.x1, L.y1];
  const dx = x1 - x0, dy = y1 - y0;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}
// 線 L（{x0,y0,x1,y1}）碰到誰（身體離線 r 以內的活著的玩家，沿線每 4 px 看一次；照碰到的先後）
function lineHits(m, L, r = 14) {
  const dx = L.x1 - L.x0, dy = L.y1 - L.y0;
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 4));
  const out = [];
  for (let k = 0; k <= n; k++) {
    const x = L.x0 + dx * k / n, y = L.y0 + dy * k / n;
    for (const e of m.players) if (e.alive && !out.includes(e) && e.containsPoint(x, y, r)) out.push(e);
  }
  return out;
}
// 好幾道線加起來碰到誰（id 排好）
const hitIds = (m, lines) => [...new Set(lines.flatMap(L => lineHits(m, L).map(e => e.id)))].sort();
// 開一場，劍氣 qi 照給的；劍士下一招是格擋（不打人）。回傳 { m, io, ref }（還沒 start）
function rig(n, { qi = [], setup = () => {} } = {}) {
  const players = mkPlayers(n);
  const m = new Match({ levelId: 'wanderer', players, seed: 2, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 1000; }
  setup(m);
  m.mechState.qi = qi.slice();
  m.mechState.next = { action: 'parry' };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  return { m, io, ref, players };
}

// ---------------- 地圖、劍士 ----------------

await test('地圖：流浪劍士在菁英池（不在別的池）；整片地面炸不壞（畫成一般的地面）；五塊浮石是可穿透平台、頂面平的、一層高 65 px（跳得上去）；劍氣的四排 = 地面與三層浮石的頂面', () => base(() => {
  const L = LEVELS.wanderer;
  assert(levelsInPool('elite').includes('wanderer') && !levelsInPool('normal').includes('wanderer') && !levelsInPool('boss').includes('wanderer'), 'elite pool');
  assert(L.name === '流浪劍士' && L.hardLook === 'ground' && !L.polygons.length && L.platforms.length === 5 && LEDGES.length === 5, 'level shape');
  const m = make(1);
  const t = m.terrain;
  // 炸不壞：大砲直接打在地上，地形一格都沒變
  const mask = Buffer.from(t.mask);
  m.applyExplosion(500, 581, CONFIG.WEAPONS.cannon, m.players[0], null);
  t.carve(500, 581, 40);
  assert(Buffer.compare(mask, Buffer.from(t.mask)) === 0, 'ground cannot be carved');
  L.platforms.forEach((poly, i) => {
    const top = poly.filter(([, y]) => y === LEDGES[i].y).map(([x]) => x);
    assert(J(top) === J([LEDGES[i].x0, LEDGES[i].x1]), `platform ${i} has a flat top: ${J(top)}`);
  });
  assert(J(ROWS.map(r => r.y)) === J([580, ...[...new Set(LEDGES.map(l => l.y))].sort((a, b) => b - a)]), 'rows = ground + stone tops: ' + J(ROWS));
  // 一層一層：地面 → 低台 → 中台 → 頂台每層 65 px，比跳躍的最高點（v² / 2g）低
  const jump = CONFIG.PLAYER.jumpSpeed ** 2 / (2 * CONFIG.GRAVITY);
  const tiers = [580, ...new Set(LEDGES.map(l => l.y))].sort((a, b) => b - a);
  for (let i = 1; i < tiers.length; i++) assert(tiers[i - 1] - tiers[i] < jump - 10, `tier ${tiers[i - 1]} → ${tiers[i]} reachable (jump ${jump})`);
  // 站得上去、子彈穿得過
  const p = m.players[0];
  onLedge(m, p, 2);
  assert(p.onGround && Math.abs(p.y - LEDGES[2].y) < 1, 'stands on the top stone: ' + p.y);
  assert(!t.isSolid(497, LEDGES[2].y + 5), 'platforms are not solid for shots');
  return { tiers, jump: Math.round(jump) };
}));

await test('劍士：fixed、不是首領、血量照一般敵人放大（第 3 關 2 人 = 200 × 1.5 × 1.3）、站在地面最右邊、血條在畫面裡；開場就抽好第一招；一閃 / 格擋 / 拔刀都抽得到、一閃最常見', () => base(() => {
  const m = make(2);
  const g = m.byId('swordsman');
  const scale = (1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER) * (1 + 2 * CONFIG.RUN.enemyHpPerStage);
  assert(g && g.fixed && !g.boss && g.team === 'enemies' && g.part === 'swordsman', 'entity');
  assert(g.hp === Math.round(200 * scale) && g.maxHp === g.hp, `hp ${g.hp} vs ${Math.round(200 * scale)}`);
  assert(g.y === 580 && g.x === 920 && g.x + 50 <= 1024, 'stands on the ground at the right');
  assert(m.entities[m.entities.length - 1] === g, 'last in turn order');
  assert(m.mechState.next && ['iai', 'parry', 'draw'].includes(m.mechState.next.action), 'opening plan ' + J(m.mechState.next));
  const count = { iai: 0, parry: 0, draw: 0 };
  for (let k = 0; k < 600; k++) count[planSwordsmanNext(m).action]++;
  assert(count.iai > count.parry && count.iai > count.draw && count.parry > 0 && count.draw > 0, 'all three, iai the most: ' + J(count));
  return { hp: g.hp, next: m.mechState.next.action, count };
}));

await test('劍士出招前沿著地面走：走完還站在地面上、在 roam 範圍裡（右下石台的右邊、不鑽到石台底下），客戶端照 glide 走到同一個地方', () => base(() => {
  const m = make(2, { seed: 4 });
  const g = m.byId('swordsman');
  const R = LEVELS.wanderer.mechanic.roam;
  const seen = new Set();
  for (let k = 0; k < 30; k++) {
    const x0 = g.x;
    const r = m.planAiTurn(g);
    assert(r.boss && r.boss.steps.length, 'boss turn');
    if (r.glide) {
      assert(r.glide.dy === 0 && g.x === x0 + r.glide.dx, 'walks on the ground only');
      seen.add(Math.sign(r.glide.dx));
    }
    assert(g.y === 580 && g.x >= R.x0 && g.x <= R.x1 && g.x - g.hw > LEDGES[4].x1, `stays in the roam: ${g.x}`);
  }
  assert(seen.size === 2, 'walks both ways: ' + [...seen]);
  return { x: g.x };
}, only('parry')));

// ---------------- 一閃（預定時劃預警線 → 他的回合沿線斬）----------------

await test('一閃（預定）：一抽到就對每一位活著的玩家各劃一道預警線——從刀口直直指向他的身體中間、延伸到地圖邊 / 地面（在平台上的人 → 斜的）；倒下的人沒有；記在 next（facing、targetIds、lines），快照帶著（複本）；預定一閃的時候站著不走', () => base(() => {
  const m = make(4, { seed: 2 });
  const g = m.byId('swordsman');
  const [p1, p2, p3, p4] = m.players;
  placeOn(m, p1, 300, 560);
  onLedge(m, p2, 2);
  onLedge(m, p3, 0);
  p4.die('hit');
  for (const p of [p1, p2, p3]) p.hp = p.maxHp = 1000;
  const hp = m.players.map(p => p.hp);
  const plan = base(() => planSwordsmanNext(m), only('iai'));
  assert(plan.action === 'iai' && plan.facing === g.facing && J(plan.targetIds) === '["p1","p2","p3"]' && plan.lines.length === 3, 'one line per living player ' + J(plan.targetIds));
  const o = bladePoint(g);
  const maxX = m.terrain.maxX;
  let diagonal = 0;
  plan.lines.forEach((L, i) => {
    const t = m.byId(L.targetId);
    assert(L.targetId === plan.targetIds[i] && J(L) === J({ targetId: t.id, ...slashLine(m, g, t) }), 'line = slashLine ' + J(L));
    assert(Math.abs(L.x0 - o.x) < 1e-9 && Math.abs(L.y0 - o.y) < 1e-9, 'starts at the blade');
    assert(segDist(L, t.cx, t.cy) < 1e-6, 'passes through the target');
    const onEdge = Math.abs(L.x1) < 1e-6 || Math.abs(L.x1 - maxX) < 1e-6 || Math.abs(L.y1) < 1e-6 || Math.abs(L.y1 - 580) < 1e-6;
    assert(onEdge && Math.hypot(L.x1 - L.x0, L.y1 - L.y0) >= Math.hypot(t.cx - L.x0, t.cy - L.y0), 'reaches the map edge: ' + J([L.x1, L.y1]));
    if (Math.abs(L.y1 - L.y0) > 40) diagonal++;
  });
  assert(diagonal >= 2, 'the ones on the stones are diagonal: ' + diagonal);
  assert(m.players.every((p, i) => p.hp === hp[i]), 'nobody hurt by the warning');
  // 快照：預定的一閃連線一起帶（改快照不會動到機制狀態）
  const snap = m.snapshot();
  assert(J(snap.swordsmanNext) === J(plan), 'snapshot carries the lines');
  snap.swordsmanNext.lines[0].x1 = -999;
  assert(m.mechState.next.lines[0].x1 !== -999, 'a copy');
  // 站著不走：預定一閃 → 劍士身上沒有 roam（飄移不動）；預定別的 → 放回去
  assert(g.roam === null, 'no roam while the iai is planned');
  base(() => {
    for (let k = 0; k < 8; k++) {
      const x0 = g.x;
      const r = m.planAiTurn(g);
      assert(!r.glide && g.x === x0 && r.boss.steps[0].action === 'iai', 'stands still and slashes: ' + J(r.glide));
    }
  }, only('iai'));
  base(() => planSwordsmanNext(m), only('parry'));
  assert(g.roam && g.roam === m.mechState.roam && Number.isFinite(g.roam.x0), 'roam back for the other moves');
  return { diagonal };
}));

await test('一閃（出招）：輪到他時沿著預定時劃好的線一起斬下去——之後走開的人躲得掉、走進線裡的人會被打；身體碰到線的人都被打、50 × 0.7、每人最多一刀（站在刀口旁邊、每一道都碰到的也一樣）、不擊退；客戶端照事件重播一致；斬完再抽下一招', () => base(() => {
  const m = make(4, { seed: 3 });
  const g = m.byId('swordsman');
  const [p1, p2, p3, p4] = m.players;
  for (const p of m.players) p.hp = p.maxHp = 1000;
  placeOn(m, p1, 300, 560);    // 地上
  onLedge(m, p2, 2);           // 頂台
  onLedge(m, p3, 0);           // 左下石台
  placeOn(m, p4, 650, 560);    // 地上
  const plan = base(() => planSwordsmanNext(m), only('iai'));
  const lines = plan.lines.map(L => ({ ...L }));
  // 玩家的回合裡：p2 走到沒有線的地方躲開、p3 從石台跳到地上（走進地上那幾道線）、p4 走到劍士身邊（刀口那裡，每一道線的起點都碰得到）
  const spots = [() => onLedge(m, p2, 1), () => onLedge(m, p2, 1, 30), () => onLedge(m, p2, 4), () => onLedge(m, p2, 0, -30), () => placeOn(m, p2, 40, 560)];
  const safe = spots.find(go => { go(); return !hitIds(m, lines).includes('p2'); });
  assert(safe, 'p2 found a spot off every line');
  placeOn(m, p3, 200, 560);
  placeOn(m, p4, g.x - g.hw - p4.hw - 1, 560);
  const want = hitIds(m, lines);
  const o = bladePoint(g);
  assert(want.includes('p1') && want.includes('p3') && want.includes('p4') && !want.includes('p2'), 'who is on the lines now: ' + J(want));
  assert(lines.every(L => lineHits(m, L).includes(p4)) && p4.containsPoint(o.x, o.y, 14), 'p4 touches every line at the blade');
  const xs = m.players.map(p => p.x);
  const r = swordTurn(m);
  const st = r.steps[0];
  assert(r.steps.length === 1 && st.action === 'iai' && !st.counter && st.shot && st.cast === CONFIG.SWORDSMAN.cast.iai && st.dmg === 50 && st.facing === plan.facing, 'the slash ' + J({ ...st, shot: undefined, lines: undefined }));
  assert(J(st.targetIds) === J(plan.targetIds) && J(st.lines) === J(lines.map(L => [L.x0, L.y0, L.x1, L.y1])), 'along the warned lines');
  const hit = [...new Set(st.shot.events.flatMap(ev => ev.damages || []).filter(d => d.dmg > 0).map(d => d.id))].sort();
  assert(J(hit) === J(want), `hits = the bodies on the lines ${J(hit)} vs ${J(want)}`);
  for (const id of want) assert(Math.abs(r.dmg(id) - 35) < 0.01, `${id} hit once: ${r.dmg(id)}`);
  assert(st.shot.events.filter(ev => ev.target === 'p4').length === 1, 'p4 only once');
  assert(r.dmg('p2') === 0 && m.players.every((p, i) => Math.abs(p.x - xs[i]) < 1e-6), 'p2 dodged, nobody knocked back');
  assert(m.mechState.next && m.mechState.next !== plan && r.next && r.next.action === m.mechState.next.action, 'planned again');
  return { hit };
}));

await test('格擋的反擊（2026-10-20 使用者：只對第一個打中他的玩家）：一道線對準那個人現在的位置、沒有預警、馬上斬——他一定被打到、線外的人沒事（線上的人照樣會被打）；他倒下了換下一個打中他的；打中他的都倒下了就不反擊；客戶端照事件重播一致；之後才出預定的招', () => base(() => {
  const out = {};
  for (const seed of [1, 2, 3]) {
    for (const firstDead of [false, true]) {
      const m = make(4, { seed });
      const g = m.byId('swordsman');
      for (const p of m.players) p.hp = p.maxHp = 1000;
      const [p1, p2, p3, p4] = m.players;
      placeOn(m, p1, 300, 560);
      onLedge(m, p2, 2);
      onLedge(m, p3, 0);
      p4.die('hit');
      m.mechState.qi = [];
      m.mechState.parry = { hits: 0, need: 2, by: [] };
      for (const who of [p2, p3, p2]) m.applyExplosion(g.x, g.cy, CONFIG.WEAPONS.cannon, who, g);   // p2 先打、p3 再打、p2 又打一次
      assert(m.mechState.parry.hits === 3 && J(m.mechState.parry.by) === '["p2","p3"]', 'who hit him, in order ' + J(m.mechState.parry));
      if (firstDead) p2.die('hit');
      const foe = firstDead ? 'p3' : 'p2';
      const r = swordTurn(m, { action: 'parry' });
      const c = r.steps[0];
      assert(r.steps.length === 2 && c.action === 'iai' && c.counter === true && c.hits === 3 && c.need === 2 && c.shot && c.cast === CONFIG.SWORDSMAN.cast.counter, 'counter ' + J({ ...c, shot: undefined }));
      assert(J(c.targetIds) === J([foe]) && c.lines.length === 1, 'one line at the first one who hit him ' + J(c.targetIds));
      const L = { x0: c.lines[0][0], y0: c.lines[0][1], x1: c.lines[0][2], y1: c.lines[0][3] };
      const o = bladePoint(g);
      assert(Math.abs(L.x0 - o.x) < 1e-9 && segDist(L, m.byId(foe).cx, m.byId(foe).cy) < 1e-6 && c.facing === g.facing, 'from the blade, through him');
      const hit = [...new Set(c.shot.events.flatMap(ev => ev.damages || []).filter(d => d.dmg > 0).map(d => d.id))].sort();
      assert(J(hit) === J(hitIds(m, [L])) && hit.includes(foe) && Math.abs(r.dmg(foe) - 35) < 0.01, `hits = the bodies on that line ${J(hit)}`);
      assert(r.steps[1].action === 'parry', 'then the plan');
      out[`${seed}${firstDead ? '/dead' : ''}`] = hit.join('+');
    }
  }
  // 打中他的都倒下了：不反擊，只出預定的招
  const m = make(3);
  for (const p of m.players) p.hp = p.maxHp = 1000;
  placeOn(m, m.players[0], 300, 560);
  m.players[2].die('hit');
  m.mechState.qi = [];
  m.mechState.parry = { hits: 2, need: 2, by: ['p3'] };
  const r = swordTurn(m, { action: 'parry' });
  assert(J(r.steps.map(s => s.action)) === '["parry"]' && m.players[0].hp === 1000, 'no counter: ' + J(r.steps.map(s => s.action)));
  return out;
}));

// ---------------- 劍氣（玩家回合裡慢慢飛的危險物）----------------

const QX = () => CONFIG.WORLD_W - 30;   // 劍氣浮著 / 出發的地方（地圖右邊；maxX = 畫面寬）
// 劍氣從出發到碰到 e 身體右邊要幾 ms（判定半徑 18）
const reachMs = (m, e) => (m.terrain.maxX - 30 - (e.x + e.hw + 18)) / CONFIG.SWORDSMAN.qiSpeed * 1000;

await test('劍氣：開場就揮出 3 道（四排裡不同的三排、隨機順序、同一個種子一樣）；不是劍士的招式（抽下一招抽不到）', () => base(() => {
  const orders = new Set();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const m = make(2, { seed });
    const qi = m.mechState.qi;
    assert(qi.length === 3 && new Set(qi).size === 3 && qi.every(i => i >= 0 && i < ROWS.length) && m.mechState.flying === null && !('slash' in m.mechState), 'opening qi ' + J(qi));
    assert(J(make(2, { seed }).mechState.qi) === J(qi), 'same seed, same rows');
    orders.add(J(qi));
  }
  assert(orders.size >= 4, 'random picks: ' + [...orders]);
  assert(!('qi' in CONFIG.SWORDSMAN.weights), 'qi is not one of his moves');
  return { orders: orders.size };
}));

await test('劍氣在玩家回合裡慢慢飛（裁判）：回合開始時最前面那道出發（turn 帶 hazard.qi、turn.start 記下），照 qiSpeed 往左飛；飛到人的那一刻才打——那一排的人都會被打（不只輪到的那位）、40 × 0.7、每人一次；飛到左邊 = 這道結束（hazard done、紀錄）', () => base(() => {
  const { m, io, ref } = rig(2, {
    qi: [0, 2, 3],
    setup: (m) => { placeOn(m, m.players[0], 300, 560); placeOn(m, m.players[1], 600, 560); },
  });
  const [p1, p2] = m.players;
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const turn = io.log.find(x => x.t === 'turn' && x.actorId === 'p1');
  const qx = QX();
  const hq = turn && turn.hazard && turn.hazard.qi;
  assert(turn.hazard.kind === 'swordsman' && hq && hq.row === 0 && hq.x === qx && hq.speed === CONFIG.SWORDSMAN.qiSpeed && J(hq.hover) === '[2,3]' && !turn.hazard.slash, 'turn carries the hazard ' + J(turn && turn.hazard));
  const ts = io.records.find(r => r.ev === 'turn.start' && r.actor === 'p1');
  assert(ts.hazard && ts.hazard.qi.row === 0 && ts.hazard.kind === 'swordsman', 'turn.start logs it ' + J(ts.hazard));
  assert(J(m.mechState.qi) === '[2,3]' && m.mechState.flying && m.mechState.flying.row === 0, 'flying');
  io.advance(reachMs(m, p2) - 200);
  assert(!io.log.some(x => x.t === 'hazard') && p2.hp === 1000, 'not there yet');
  io.advance(300);
  let hz = io.log.filter(x => x.t === 'hazard');
  assert(hz.length === 1 && J(hz[0].damages.map(d => d.id)) === '["p2"]' && Math.abs(hz[0].damages[0].dmg - 28) < 0.01 && hz[0].hp.length === 1 && J(['id', 'hp', 'alive', 'cause', 'shield'].map(k => hz[0].hp[0][k])) === J(['p2', p2.hp, true, null, 0]) && 'soul' in hz[0].hp[0] && hz[0].seq === turn.hazard.seq && !hz[0].done && !hz[0].qi.done, 'p2 hit when it arrives: ' + J(hz));
  assert(hz[0].qi.x < p2.x + p2.hw + 18 && hz[0].qi.x > p1.x + 30, 'position at the hit ' + hz[0].qi.x);
  io.advance(reachMs(m, p1) - reachMs(m, p2));
  hz = io.log.filter(x => x.t === 'hazard');
  assert(hz.length === 2 && J(hz[1].damages.map(d => d.id)) === '["p1"]' && p2.hp === 1000 - 28, 'then p1, p2 only once: ' + J(hz.map(h => h.damages)));
  io.advance(qx / CONFIG.SWORDSMAN.qiSpeed * 1000);
  hz = io.log.filter(x => x.t === 'hazard');
  assert(hz.length === 3 && hz[2].done === true && hz[2].qi.done && !hz[2].damages.length && J(hz[2].qi.hover) === '[2,3]' && !hz[2].qi.recast && m.mechState.flying === null, 'done ' + J(hz[2]));
  const recs = io.records.filter(r => r.ev === 'hazard');
  assert(recs.length === 3 && recs[0].changes.some(c => c.id === 'p2') && recs[0].turn === 'p1' && recs[0].kind === 'swordsman' && recs[2].done === true, 'logged ' + J(recs));
  assert(io.log.filter(x => x.t === 'turn').length === 1, 'still p1\'s turn');
  ref.stop();
  return { hits: hz.slice(0, 2).map(h => Math.round(h.qi.x)) };
}));

await test('劍氣躲得掉：飛到之前離開那一排（走上石台）、或飛過去的時候跳在那一排上面，就打不到；別排的人本來就打不到', () => base(() => {
  const out = {};
  for (const how of ['ledge', 'jump']) {
    const { m, io, ref } = rig(2, {
      qi: [0, 1, 2],
      setup: (m) => { placeOn(m, m.players[0], 300, 560); onLedge(m, m.players[1], 2); },
    });
    const [p1, p2] = m.players;
    ref.start();
    io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
    io.advance(reachMs(m, p1) - 500);
    if (how === 'ledge') onLedge(m, p1, 0);
    else p1.y -= 60;
    io.advance(1500);
    if (how === 'jump') p1.y += 60;
    io.advance(8000);
    const hz = io.log.filter(x => x.t === 'hazard');
    assert(hz.length === 1 && hz[0].done && !hz[0].damages.length && p1.hp === 1000 && p2.hp === 1000, `${how}: dodged ${J(hz)}`);
    ref.stop();
    out[how] = 'dodged';
  }
  return out;
}));

await test('回合在劍氣飛完之前就結束（超時 / 開火 / AI 代打）：收尾時從它飛到的地方一口氣往左掃完剩下那段（照那時候大家的位置；已經被這道打過的不再打），之後才是下一位；廣播 / 紀錄是 kind swordQi 的 shot', () => base(() => {
  const { m, io, ref } = rig(2, {
    qi: [0, 2, 3],
    setup: (m) => { placeOn(m, m.players[0], 300, 560); placeOn(m, m.players[1], 800, 560); },
  });
  const [p1, p2] = m.players;
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  io.advance(reachMs(m, p2) + 100);
  assert(io.log.filter(x => x.t === 'hazard').length === 1 && p2.hp === 1000 - 28, 'p2 hit in real time');
  ref.skipTurn('timeout');
  io.advance(CONFIG.TIMING.skipDelay * 1000 + 20);
  const shots = io.log.filter(x => x.t === 'shot');
  const s = shots[0];
  assert(shots.length === 1 && s.kind === 'swordQi' && s.actorId === 'swordsman' && s.turnId === 'p1' && s.row === 0 && J(s.hover) === '[2,3]', 'sweep shot ' + J(s && { ...s, events: undefined, results: undefined }));
  assert(s.projectiles[0].x < QX() && s.projectiles[0].x > p1.x + 40 && s.projectiles[0].vx < 0, 'from where it had got to: ' + s.projectiles[0].x);
  assert(J(s.events.flatMap(ev => ev.damages || []).map(d => d.id)) === '["p1"]' && p2.hp === 1000 - 28 && p1.hp === 1000 - 28, 'p1 swept, p2 not twice');
  const rec = io.records.find(r => r.ev === 'shot' && r.kind === 'swordQi');
  assert(rec && rec.actor === 'swordsman' && !('pid' in rec) && rec.turn === 'p1' && rec.row === 0, 'logged ' + J(rec));
  assert(m.mechState.flying === null && !io.log.some(x => x.t === 'turn' && x.actorId === 'p2'), 'next turn waits for the sweep');
  io.advance(10_000);
  const t2 = io.log.find(x => x.t === 'turn' && x.actorId === 'p2');
  assert(t2 && t2.hazard && t2.hazard.qi.row === 2 && J(t2.hazard.qi.hover) === '[3]', 'p2 gets the next one ' + J(t2 && t2.hazard));
  ref.stop();
  return { from: Math.round(s.projectiles[0].x) };
}));

await test('浮著的劍氣都飛完的那一刻馬上再揮一輪（3 道、四排裡不同的三排）：飛完的 hazard / 收尾的 shot 帶 recast，浮著的換成新的', () => base(() => {
  let r = rig(1, { qi: [3], setup: (m) => placeOn(m, m.players[0], 300, 560) });
  r.ref.start();
  r.io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  assert(r.m.mechState.qi.length === 0, 'the last one took off');
  r.io.advance(9000);
  const done = r.io.log.find(x => x.t === 'hazard' && x.done);
  const rc = done && done.qi.recast;
  assert(Array.isArray(rc) && rc.length === 3 && new Set(rc).size === 3 && J(done.qi.hover) === J(rc) && J(r.m.mechState.qi) === J(rc), 'recast on landing ' + J(done));
  assert(r.io.records.find(x => x.ev === 'hazard' && x.done).qi.recast.length === 3, 'logged');
  r.ref.stop();
  r = rig(1, { qi: [3], setup: (m) => placeOn(m, m.players[0], 300, 560) });
  r.ref.start();
  r.io.advance(CONFIG.TIMING.startDelay * 1000 + 500);
  r.ref.skipTurn('timeout');
  r.io.advance(CONFIG.TIMING.skipDelay * 1000 + 20);
  const sweep = r.io.log.find(x => x.t === 'shot' && x.kind === 'swordQi');
  assert(sweep && sweep.recast && sweep.recast.length === 3 && J(sweep.hover) === J(sweep.recast) && J(r.m.mechState.qi) === J(sweep.recast), 'recast after the sweep ' + J(sweep && sweep.recast));
  r.ref.stop();
  return { recast: rc };
}));

await test('被危險物（劍氣）打倒 → 這回合結束（skip hazard）、換下一位；玩家回合的 hazard 只有劍氣（一閃在他自己的回合斬）；斷線代打（AI）的玩家回合也有；劍士自己的回合沒有；無差別轟炸照舊在回合開始前先炸', () => base(() => {
  const { m, io, ref } = rig(2, {
    qi: [0, 1, 2],
    setup: (m) => {
      placeOn(m, m.players[0], 300, 560);
      m.players[0].hp = 20;
      onLedge(m, m.players[1], 0);
      m.players[1].mods.bombard = 1;
      m.players[1].bombardCd = 0;
    },
  });
  const [p1] = m.players;
  m.mechState.next = base(() => planSwordsmanNext(m), only('iai'));   // 預定一閃：玩家回合照樣沒有
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const t1 = io.log.find(x => x.t === 'turn' && x.actorId === 'p1');
  assert(t1.hazard && t1.hazard.qi && J(Object.keys(t1.hazard).filter(k => k !== 'seq').sort()) === '["kind","qi"]', 'only the crescent ' + J(t1.hazard));
  io.advance(reachMs(m, p1) + 200);   // 劍氣到了：p1 剩 20，28 打倒
  const skip = io.log.find(x => x.t === 'skip');
  assert(!p1.alive && skip && skip.actorId === 'p1' && skip.reason === 'hazard', 'skipped: ' + J(skip && skip.reason));
  assert(io.records.some(r => r.ev === 'turn.skip' && r.reason === 'hazard'), 'logged');
  ref.setConnected('p2', false);
  io.advance(15_000);
  const iBomb = io.log.findIndex(x => x.t === 'shot' && x.kind === 'bombard');
  const iTurn = io.log.findIndex(x => x.t === 'turn' && x.actorId === 'p2');
  assert(iBomb >= 0 && iTurn > iBomb && io.log[iTurn].ai === true && io.log[iTurn].hazard && io.log[iTurn].hazard.qi.row === 1, 'bombard first, then the AI turn with a hazard ' + J(io.log[iTurn] && io.log[iTurn].hazard));
  io.advance(30_000);
  const sw = io.log.find(x => x.t === 'turn' && x.actorId === 'swordsman');
  assert(sw && !sw.hazard, 'none on his own turn');
  ref.stop();
}));

// ---------------- 拔刀 ----------------

await test('拔刀：刀氣直線飛向一人——站在平台上的優先、其中離他最近的（大家都在地上就挑最近的）；打第一個碰到的人、20 × 0.7、擊退 200（站在石台邊上的被打下去）；客戶端重播一致', () => base(() => {
  const m = make(3);
  const g = m.byId('swordsman');
  const [p1, p2, p3] = m.players;
  placeOn(m, p1, 800, 560);   // 地上、離他最近
  onLedge(m, p2, 2, -36);     // 頂端石台靠左邊的邊上
  onLedge(m, p3, 0);          // 左下石台（比頂端遠）
  assert(drawTarget(m, g) === p2, 'platform players first, nearest of them: ' + drawTarget(m, g).id);
  const hp = m.players.map(p => p.hp);
  const y0 = p2.y;
  const r = swordTurn(m, { action: 'draw' });
  const st = r.steps[0];
  assert(r.steps.length === 1 && st.action === 'draw' && st.targetId === 'p2' && st.cast === CONFIG.SWORDSMAN.cast.draw && st.dmg === 20, 'draw step ' + J({ ...st, shot: undefined }));
  assert(Math.abs(r.dmg('p2') - 14) < 0.01 && p1.hp === hp[0] && p3.hp === hp[2], 'hits only the target: ' + J([r.dmg('p1'), r.dmg('p2'), r.dmg('p3')]));
  assert(st.shot.events.filter(ev => ev.target).length === 1, 'stops at the first one hit');
  assert(p2.y > y0 + 30 && p2.x < LEDGES[2].x0, `knocked off the stone: ${p2.x.toFixed(1)}, ${p2.y.toFixed(1)}`);
  const m2 = make(2);
  placeOn(m2, m2.players[0], 300, 560);
  placeOn(m2, m2.players[1], 700, 560);
  assert(drawTarget(m2, m2.byId('swordsman')).id === 'p2', 'nearest when nobody is up');
  return { knocked: [Math.round(p2.x), Math.round(p2.y)] };
}));

// ---------------- 格擋架勢 ----------------

await test('格擋架勢：要被打中幾次 = ceil(人數 × 0.5)（1 ~ 4 人：1、1、2、2）；擺出來之後受到的傷害 ×0.5、玩家打中才算次數（燃燒不算）、記下是誰打中的', () => base(() => {
  const needs = [1, 2, 3, 4].map(n => parryNeed(make(n)));
  assert(J(needs) === '[1,1,2,2]', 'need ' + J(needs));
  const m = make(2);
  const g = m.byId('swordsman');
  const r = swordTurn(m, { action: 'parry' });
  assert(r.steps.length === 1 && r.steps[0].action === 'parry' && r.steps[0].need === 1 && r.steps[0].still, 'parry step ' + J(r.steps[0].action));
  assert(J(m.mechState.parry) === '{"hits":0,"need":1,"by":[]}', 'stance ' + J(m.mechState.parry));
  const p = m.players[0];
  const hp0 = g.hp;
  m.applyExplosion(g.x, g.cy, CONFIG.WEAPONS.cannon, p, g);
  const taken = hp0 - g.hp;
  assert(Math.abs(taken - 30 * 0.5) < 0.6, 'halved: ' + taken);
  assert(m.mechState.parry.hits === 1 && J(m.mechState.parry.by) === '["p1"]', 'counted, and who ' + J(m.mechState.parry));
  m.applyExplosion(g.x, g.cy, CONFIG.WEAPONS.cannon, null, g);   // 沒有攻擊者（不是玩家打的）
  g.burn = 3; m.burnTick(g, []);                                   // 燃燒
  assert(m.mechState.parry.hits === 1 && J(m.mechState.parry.by) === '["p1"]', 'only player hits count: ' + J(m.mechState.parry));
  m.mechState.parry = null;
  const hp1 = g.hp;
  m.applyExplosion(g.x, g.cy, CONFIG.WEAPONS.cannon, p, g);
  assert(Math.abs(hp1 - g.hp - 30) < 0.6, 'full damage without the stance: ' + (hp1 - g.hp));
  return { needs, halved: taken };
}));

await test('格擋之後的回合：被打中次數夠 → 先放反擊的一閃再出預定的招（一回合兩招，客戶端照順序重播一致）；不夠 → 只出預定的招；架勢都放下；預定的一閃沿預警線斬', () => base(() => {
  const out = {};
  for (const [hits, plan] of [[2, 'iai'], [1, 'parry'], [5, 'parry'], [0, 'iai']]) {
    const m = make(3);
    placeOn(m, m.players[0], 300, 560);
    m.mechState.qi = [];
    m.mechState.parry = { hits, need: 2, by: hits ? ['p1'] : [] };
    const planned = plan === 'iai' ? base(() => planSwordsmanNext(m), only('iai')) : { action: plan };
    const r = swordTurn(m, planned);
    const acts = r.steps.map(s => s.action + (s.counter ? '!' : ''));
    if (hits >= 2) assert(J(acts) === J(['iai!', plan]) && r.steps[0].targetIds.every(id => r.dmg(id) > 0), 'counter first, then the plan: ' + J(acts));
    else assert(J(acts) === J([plan]), 'no counter: ' + J(acts));
    assert(plan === 'parry' ? m.mechState.parry && m.mechState.parry.hits === 0 : m.mechState.parry === null, 'stance after: ' + J(m.mechState.parry));
    if (plan === 'iai') assert(r.steps.at(-1).action === 'iai' && !r.steps.at(-1).counter && J(r.steps.at(-1).lines) === J(planned.lines.map(L => [L.x0, L.y0, L.x1, L.y1])), 'the planned iai slashes along its warning lines: ' + J(r.steps.at(-1).targetIds));
    out[`${hits}/${plan}`] = acts.join('+');
  }
  return out;
}));

// ---------------- 快照、裁判 ----------------

await test('快照：預定的下一招（一閃連預警線）、浮著的劍氣、格擋架勢、正在飛的那一道（swordsmanNext / Qi / Parry / Flying）重建得回來；別的地圖不帶這些欄位', () => base(() => {
  const m = make(2);
  const lines = [{ targetId: 'p1', x0: 905, y0: 545, x1: 0, y1: 560.5 }, { targetId: 'p2', x0: 905, y0: 545, x1: 0, y1: 155.5 }];
  m.mechState.next = { action: 'iai', facing: -1, targetIds: ['p1', 'p2'], lines };
  m.mechState.qi = [3, 1];
  m.mechState.parry = { hits: 1, need: 1, by: ['p2'] };
  m.mechState.flying = { row: 2, x0: 994, x: 512.5, t0: 100, speed: 140, hit: ['p1'], turnId: 'p1' };
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(snap.swordsmanNext) === J(m.mechState.next) && J(snap.swordsmanQi) === '[3,1]' && J(snap.swordsmanParry) === '{"hits":1,"need":1,"by":["p2"]}', 'snapshot ' + J([snap.swordsmanNext, snap.swordsmanQi, snap.swordsmanParry]));
  assert(J(snap.swordsmanFlying) === '{"row":2,"x":512.5,"speed":140}' && !('swordsmanSlash' in snap), 'flying ' + J(snap.swordsmanFlying));
  const c = make(2, { seed: 9 });
  c.applySnapshot(snap);
  assert(J(c.mechState.next) === J(m.mechState.next) && J(c.mechState.qi) === J(m.mechState.qi) && J(c.mechState.parry) === J(m.mechState.parry), 'restored');
  assert(c.mechState.next.lines !== snap.swordsmanNext.lines && c.mechState.parry.by !== snap.swordsmanParry.by, 'restored as a copy');
  assert(J(c.mechState.flying) === J(snap.swordsmanFlying), 'flying restored for drawing');
  c.applySnapshot({ ...snap, swordsmanParry: null, swordsmanFlying: null, swordsmanNext: { action: 'parry' } });
  assert(c.mechState.parry === null && c.mechState.flying === null && J(c.mechState.next) === '{"action":"parry"}', 'cleared by the snapshot');
  const other = new Match({ levelId: 'forestGuard', players: mkPlayers(1), seed: 1 });
  assert(!('swordsmanNext' in other.snapshot()), 'only this map');
}));

await test('裁判：全員 AI 代打打幾輪；一閃 / 格擋 / 拔刀 / 反擊都出現、反擊的一閃接在預定的招前面、只對一個人；預定一閃的那幾回合他站著不走；紀錄 ai.turn 帶每一招（一閃的 targetIds、格擋的 need、反擊的 counter / hits、拔刀的目標）與 next（一閃帶 nextTargets）；開場的第一招記在 battle.start；每個玩家回合劍氣都在飛（沒有一閃）', () => base(() => {
  const out = {};
  const seen = new Set();
  let counters = 0, stood = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'wanderer', players, seed, stage: 3 });
    for (const p of m.players) { p.hp = p.maxHp = 4000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: { stage: 3, stageCount: 10, isBoss: false, type: 'elite', levelId: 'wanderer', levelName: '流浪劍士', cards: {} } });
    const opening = m.mechState.next;
    ref.start();
    const bs = io.records.find(r => r.ev === 'battle.start');
    assert(bs.next === opening.action && (opening.action !== 'iai' || J(bs.nextTargets) === J(opening.targetIds)), 'battle.start logs the opening plan ' + J([bs.next, bs.nextTargets]));
    for (const p of players) ref.setConnected(p.id, false);
    for (let k = 0; k < 400 && ref.phase !== 'over'; k++) io.advance(500);
    const turns = io.log.filter(x => x.t === 'aiTurn' && x.actorId === 'swordsman');
    assert(turns.length >= 6, `seed ${seed}: swordsman turns ${turns.length}`);
    let plan = opening;
    for (const t of turns) {
      const steps = t.boss.steps;
      const acts = steps.map(st => st.action);
      assert(steps.every(st => st.cast > 0 && (st.shot || st.still)), 'cast + result');
      assert(acts.length === 1 || (acts.length === 2 && steps[0].counter === true && acts[0] === 'iai'), 'counter comes first: ' + J(acts));
      for (const st of steps) seen.add(st.counter ? 'counter' : st.action);
      if (steps[0].counter) counters++;
      const main = steps[steps.length - 1];
      assert(main.action === plan.action, `did what was planned: ${main.action} vs ${plan.action}`);
      if (plan.action === 'iai') {
        assert(!t.glide && J(main.lines) === J(plan.lines.map(L => [L.x0, L.y0, L.x1, L.y1])), 'stood still and slashed along the warned lines');
        stood++;
      }
      assert(t.boss.next && ['iai', 'parry', 'draw'].includes(t.boss.next.action), 'next ' + J(t.boss.next));
      assert(t.boss.next.action !== 'iai' || (t.boss.next.lines.length === t.boss.next.targetIds.length && t.boss.next.lines.length > 0), 'a planned iai carries its lines');
      plan = t.boss.next;
    }
    const recs = io.records.filter(r => r.ev === 'ai.turn' && r.actor === 'swordsman');
    assert(recs.length === turns.length && recs.every((r, i) => J(r.boss.map(b => b.action)) === J(turns[i].boss.steps.map(st => st.action)) && r.next === turns[i].boss.next.action), 'logged');
    assert(recs.every((r, i) => turns[i].boss.next.action !== 'iai' || J(r.nextTargets) === J(turns[i].boss.next.targetIds)), 'next iai logs nextTargets');
    assert(recs.flatMap(r => r.boss).filter(b => b.action === 'iai').every(b => Array.isArray(b.targetIds) && b.targetIds.length > 0 && b.dmg === 50 && !('lines' in b)), 'iai logs its targets');
    assert(recs.flatMap(r => r.boss).filter(b => b.action === 'parry').every(b => Number.isInteger(b.need)), 'parry logs need');
    assert(recs.flatMap(r => r.boss).filter(b => b.action === 'draw').every(b => typeof b.targetId === 'string'), 'draw logs the target');
    assert(recs.flatMap(r => r.boss).filter(b => b.counter).every(b => Number.isInteger(b.hits) && b.targetIds.length === 1), 'counter logs hits and its one target');
    const playerTurns = io.log.filter(x => x.t === 'turn' && x.actorId !== 'swordsman');
    assert(playerTurns.length && playerTurns.every(x => x.hazard && x.hazard.qi && !x.hazard.slash), 'every player turn has a crescent flying (and nothing else)');
    out[seed] = turns.map(t => t.boss.steps.map(st => (st.counter ? 'C' : st.action[0])).join('')).join(' ');
  }
  assert(['iai', 'parry', 'draw', 'counter'].every(a => seen.has(a)), 'all moves: ' + [...seen]);
  return { ...out, counters, stood };
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
const { swordsman: swordsmanView } = await import('../client/map-views/swordsman.js');
// 地圖畫面的假 c（不經過 GameView）：記下音效與橫幅
function fakeMapCtx(match, clock) {
  const sounds = [], banners = [];
  const fx = { particles() {}, particle() {}, sound: (n) => sounds.push(n), banner: (t) => banners.push(t), float() {}, shake() {}, splash() {}, wither() {}, repaint() {} };
  return { c: { match, state: swordsmanView.create(match), fx, clock, time: 0, currentId: null, projectiles: [], rangeHints: true }, sounds, banners };
}

// 記下畫了什麼（fillRect / strokeRect / fillText / moveTo / lineTo / setLineDash 的參數，數字四捨五入）
function spyCtx() {
  const calls = { fillRect: [], strokeRect: [], fillText: [], moveTo: [], lineTo: [], setLineDash: [] };
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
const stageInfo = (difficulty = 'normal') => ({ stage: 3, stageCount: 10, isBoss: false, type: 'elite', difficulty, levelId: 'wanderer', levelName: '流浪劍士', cards: {} });
// 畫面上有沒有畫這條線（moveTo 起點、lineTo 終點都對得上）
const drewLine = (calls, L) => calls.moveTo.some(a => a[0] === Math.round(L.x0) && a[1] === Math.round(L.y0)) && calls.lineTo.some(a => a[0] === Math.round(L.x1) && a[1] === Math.round(L.y1));
const dashed = (calls) => calls.setLineDash.some(a => Array.isArray(a[0]) && a[0].length > 0);

await test('真的 GameView：流浪劍士從開場播到每一招（全員 AI 代打；每幀 update + render）：沒有腳本錯誤；浮著的劍氣、回合裡飛的那一道、再揮一輪的月牙；一閃的預警線、出招時線劃出去、斬下去的白光；客戶端的機制狀態（下一招與預警線、劍氣、格擋）與劍士跟伺服器一樣；菁英關橫幅', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'wanderer', players, seed: 3, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 5000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  const view = mkView();
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  assert(view.mapView.type === 'swordsman' && view.banner && view.banner.text === '菁英關：流浪劍士', 'elite banner: ' + J(view.banner && view.banner.text));
  for (const p of players) ref.setConnected(p.id, false);
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Set();
  let marksDrawn = false, crescents = false, parryHud = false, flew = false, traced = false, kept = false, flashed = false;
  try {
    for (let k = 0; k < 1200 && ref.phase !== 'over'; k++) {
      io.advance(250);
      for (const t of io.log.filter(x => x.t === 'aiTurn' && x.actorId === 'swordsman')) t.boss.steps.forEach(st => seen.add(st.counter ? 'counter' : st.action));
      feed();
      for (let f = 0; f < 15; f++) {
        view.update(CONFIG.FIXED_DT);
        view.render();
        const c = view.mapCtx, S = view.match.mechState;
        if (c.state.crescents.length) crescents = true;
        if (S.flying) flew = true;
        if (c.state.fx && c.state.fx.action === 'iai' && !c.state.fx.step.counter && c.state.fx.trace > 0) traced = true;
        if (S.next && S.next.action === 'iai' && !c.state.fx && !kept) {
          const sp = spyCtx();
          view.mapView.drawScene(sp.ctx, c);
          kept = S.next.lines.every(L => drewLine(sp.calls, L));
        }
        if (c.state.flash && c.state.flash.lines.length) flashed = true;
        if (S.qi.length && !marksDrawn) {
          const sp = spyCtx();
          view.mapView.drawScene(sp.ctx, c);
          marksDrawn = sp.calls.fillText.some(a => a[0] === '1');
        }
        if (S.parry && view.mapView.hud(c, ['x', '#fff']).some(l => /^格擋架勢（減傷 50%）$/.test(l[0]))) parryHud = true;
      }
      if (['iai', 'parry', 'counter'].every(a => seen.has(a)) && marksDrawn && crescents && traced && kept && flashed && parryHud) break;
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(['iai', 'parry'].every(a => seen.has(a)), 'played all moves: ' + [...seen]);
  assert(crescents && marksDrawn && parryHud && flew, `recast crescents ${crescents} / marks ${marksDrawn} / parry hud ${parryHud} / flew ${flew}`);
  assert(traced && kept && flashed, `iai: traced ${traced} / warned ${kept} / flashed ${flashed}`);
  const S = view.match.mechState;
  assert(J(S.next) === J(m.mechState.next) && J(S.qi) === J(m.mechState.qi), 'mech state synced: ' + J([S.next, S.qi, m.mechState.next, m.mechState.qi]));
  assert(J(S.parry && S.parry.need) === J(m.mechState.parry && m.mechState.parry.need), 'parry synced: ' + J([S.parry, m.mechState.parry]));
  assert(!S.flying === !m.mechState.flying && (!S.flying || S.flying.row === m.mechState.flying.row), 'flying synced ' + J([S.flying, m.mechState.flying && m.mechState.flying.row]));
  const vg = view.match.byId('swordsman'), sg = m.byId('swordsman');
  assert(vg.x === sg.x && vg.y === sg.y && vg.hp === sg.hp && vg.facing === sg.facing, 'swordsman synced ' + J([vg.x, vg.hp, vg.facing, sg.x, sg.hp, sg.facing]));
  assert(view.match.players.every(p => p.hp === m.byId(p.id).hp), 'players synced');
  return { moves: [...seen] };
}));

await test('真的 GameView：自己的回合裡劍氣從右邊出發、照真實時間（view.clock）往左飛（畫面卡頓、開著慢動作也一樣快）；伺服器說打到自己 → 血量照伺服器、飄字、位置不被拉走；飛完收掉、再揮一輪的月牙飛到右邊浮著', () => base(() => {
  const players = mkPlayers(1);
  const m = new Match({ levelId: 'wanderer', players, seed: 2, stage: 3 });
  m.players[0].hp = m.players[0].maxHp = 1000;
  placeOn(m, m.players[0], 300, 560);
  m.mechState.qi = [0];
  m.mechState.next = { action: 'parry' };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  const view = mkView();
  let now = 1000;   // 真實時間（秒）：測試自己推
  view.clock = () => now;
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  const S = view.match.mechState;
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  feed();
  for (let f = 0; f < 5; f++) view.update(CONFIG.FIXED_DT);
  assert(view.canAct && S.flying && S.flying.row === 0 && S.qi.length === 0, 'my turn, the crescent took off ' + J(S.flying));
  // 一秒（真實時間）：一般速度 60 步、慢動作（timeScale 0.2）每步的 dt 縮小、卡頓（一秒只跑 3 步）——飛的距離都一樣
  const fly = (steps, dt) => { const x = S.flying.x; now += 1; for (let f = 0; f < steps; f++) view.update(dt); return x - S.flying.x; };
  const normal = fly(60, CONFIG.FIXED_DT);
  view.timeScale = 0.2;
  const slow = fly(60, CONFIG.FIXED_DT * 0.2);
  view.timeScale = 1;
  const laggy = fly(3, CONFIG.FIXED_DT);
  assert([normal, slow, laggy].every(d => Math.abs(d - 140) < 1e-6), `flies 140 px per real second: ${J([normal, slow, laggy])}`);
  assert(Math.abs(S.flying.x - (S.flying.x0 - 140 * 3)) < 1e-6, 'counted from receipt');
  // 劍氣打到我、飛完：血量照伺服器、飄字、位置是我自己的；收掉、馬上再揮一輪（月牙從劍士身上飛到右邊、浮上去）
  const me = view.match.byId('p1');
  me.x = 302;   // 我自己的畫面上動了一點（伺服器還沒收到）
  const floats = view.floatTexts.length;
  io.advance(reachMs(m, m.players[0]) + 9000);
  now += 9;
  feed();
  assert(me.hp === m.players[0].hp && me.hp === 1000 - 28 && me.x === 302 && view.floatTexts.length > floats, 'hp from the server, my position kept, a float: ' + J([me.hp, me.x]));
  for (let f = 0; f < 120; f++) view.update(CONFIG.FIXED_DT);
  assert(S.flying === null && J(S.qi) === J(m.mechState.qi) && S.qi.length === 3, 'done, recast landed ' + J([S.qi, m.mechState.qi]));
  ref.stop();
  return { normal: Math.round(normal), slow: Math.round(slow) };
}));

await test('一閃的線（畫面）：預定一閃的預警線——每一位玩家一道（虛線 + 打得到的寬度），一般難度畫、菁英之路不畫；出招時（兩種難度都畫）每一道從刀口一路劃出去、預警線收起來；斬下去每一道一道白光；反擊的一閃一樣劃出去；劍士倒下就不畫；HUD 兩行（血量、下一招）', () => base(() => {
  const out = {};
  for (const difficulty of ['normal', 'elite']) {
    const players = mkPlayers(2);
    const m = base(() => new Match({ levelId: 'wanderer', players, seed: 5, stage: 3 }), only('iai'));
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo(difficulty) });
    ref.start();
    const view = mkView();
    for (const msg of io.log.splice(0)) view.onMessage(msg);
    const c = view.mapCtx, S = view.match.mechState;
    assert(S.next.action === 'iai' && S.next.lines.length === 2 && J(S.next) === J(m.mechState.next), 'planned iai with a line each ' + J(S.next));
    for (let f = 0; f < 30; f++) view.update(CONFIG.FIXED_DT);
    assert(c.state.draw === 1, 'grip stance: ' + c.state.draw);
    const lines = S.next.lines;
    const arr = lines.map(L => [L.x0, L.y0, L.x1, L.y1]);
    let sp = spyCtx();
    view.mapView.drawScene(sp.ctx, c);
    const warned = lines.every(L => drewLine(sp.calls, L)) && dashed(sp.calls);
    const hidden = !lines.some(L => drewLine(sp.calls, L));
    // 出招：劃到一半（兩種難度都畫，預警線收起來）
    const half = (L) => ({ x0: L.x0, y0: L.y0, x1: L.x0 + (L.x1 - L.x0) * 0.5, y1: L.y0 + (L.y1 - L.y0) * 0.5 });
    c.state.fx = { action: 'iai', t: 0.8, phase: 'cast', cast: 1.1, step: { action: 'iai', lines: arr }, draw0: 1, trace: 0.5 };
    sp = spyCtx();
    view.mapView.drawScene(sp.ctx, c);
    const tracing = lines.every(L => drewLine(sp.calls, half(L))) && !dashed(sp.calls);
    // 出招一開始（還在握刀柄）：一般難度的預警線還在
    c.state.fx = { action: 'iai', t: 0.1, phase: 'cast', cast: 1.1, step: { action: 'iai', lines: arr }, draw0: 1, trace: 0 };
    sp = spyCtx();
    view.mapView.drawScene(sp.ctx, c);
    const gripWarn = lines.every(L => drewLine(sp.calls, L));
    // 反擊的一閃（一道線，對準第一個打中他的人）：一樣劃出去
    c.state.fx = { action: 'iai', t: 0.3, phase: 'cast', cast: 0.5, step: { action: 'iai', counter: true, targetIds: [lines[0].targetId], lines: [arr[0]] }, draw0: 0, trace: 0.5 };
    sp = spyCtx();
    view.mapView.drawScene(sp.ctx, c);
    const counter = drewLine(sp.calls, half(lines[0]));
    // 斬下去：每一道一道白光
    c.state.fx = null;
    c.state.flash = { lines: arr, t: 0 };
    sp = spyCtx();
    view.mapView.drawScene(sp.ctx, c);
    const flashed = lines.every(L => drewLine(sp.calls, L));
    c.state.flash = null;
    const hud = view.mapView.hud(c, ['x', '#fff']);
    assert(hud.length === 3 && /^流浪劍士 \d+ \/ \d+$/.test(hud[1][0]) && hud[2][0] === '下一招：一閃', 'hud ' + J(hud));
    // 劍士倒下：不畫預警線
    const g = view.match.byId('swordsman');
    g.die('hit');
    sp = spyCtx();
    view.mapView.drawScene(sp.ctx, c);
    const afterDeath = lines.some(L => drewLine(sp.calls, L));
    if (difficulty === 'normal') assert(warned && gripWarn, `normal: warned ${warned} / during the grip ${gripWarn}`);
    else assert(hidden, 'elite road: no warning lines');
    assert(tracing && counter && flashed && !afterDeath, `${difficulty}: tracing ${tracing} / counter ${counter} / flashed ${flashed} / after death ${afterDeath}`);
    ref.stop();
    out[difficulty] = difficulty === 'normal' ? 'warned' : 'hidden';
  }
  // 劍氣的範圍（qiBand）：整張地圖寬、低台上的人碰得到、底下地上的人碰不到；從地圖右邊出發
  const mm = make(1);
  const b = qiBand(mm, 1);
  assert(b.x0 === 0 && b.x1 === mm.terrain.maxX && b.qx === mm.terrain.maxX - 30 && b.bottom >= 515 && b.top < 515 - 30 && b.bottom < 580 - 30, 'qi band ' + J(b));
  return out;
}));

await test('一閃照預定的方向出刀：預定時大家都在左邊（面向左），之後有人繞到他背後（變成最近的）——伺服器照預定的方向斬（預警線從那邊的刀口出發、背後的人沒事）、客戶端一開始就面向那邊（不先轉向最近的人再轉回來）', () => base(() => {
  const m = make(2, { seed: 3 });
  const g = m.byId('swordsman');
  const [p1, p2] = m.players;
  for (const p of m.players) p.hp = p.maxHp = 1000;
  placeOn(m, p1, 300, 560);
  placeOn(m, p2, 600, 560);
  g.facing = -1;
  const plan = base(() => planSwordsmanNext(m), only('iai'));
  assert(plan.facing === -1, 'planned facing left');
  placeOn(m, p2, g.x + 40, 560);   // 繞到他背後
  const before = JSON.parse(J(m.snapshot()));
  const r = swordTurn(m);
  const st = r.steps[0];
  assert(st.action === 'iai' && st.facing === -1 && g.facing === -1, 'slashes the planned way: ' + J([st.facing, g.facing]));
  assert(Math.abs(r.dmg('p1') - 35) < 0.01 && r.dmg('p2') === 0, 'p1 on the line, p2 behind him: ' + J([r.dmg('p1'), r.dmg('p2')]));
  const cm = make(2, { seed: 3 });
  cm.applySnapshot(before);
  const { c } = fakeMapCtx(cm, () => 0);
  cm.byId('swordsman').facing = 1;   // 開場的狀態朝哪邊都一樣
  const it = swordsmanView.turnScript(c, { actorId: 'swordsman', boss: { steps: JSON.parse(J(r.steps)), next: r.next } });
  it.next();
  assert(cm.byId('swordsman').facing === -1, 'client faces the slash from the start: ' + cm.byId('swordsman').facing);
}));

// ---------------- 審查補的：劍士在玩家回合倒下、畫面收到就演、重揮的月牙、護盾 ----------------

await test('劍士在玩家回合裡被打倒（劍氣在飛）：劍氣收掉不再揮（hazard done、沒有人被打）；勝負等這一槍播完、回合收尾才判（turn.end 在 battle.over 前面）', () => base(() => {
  const { m, io, ref } = rig(1, { qi: [0, 2, 3], setup: (m) => placeOn(m, m.players[0], 860, 560) });
  const p = m.players[0];
  const g = m.byId('swordsman');
  g.hp = 1;
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const turn = io.log.find(x => x.t === 'turn' && x.actorId === 'p1');
  assert(turn.hazard.qi, 'qi flying ' + J(turn.hazard));
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 0, power: 40, x: p.x, y: p.y, facing: 1, stamina: p.stamina });
  assert(!g.alive && ref.phase === 'resolving', 'the shot killed him, still resolving');
  io.advance(300);
  const hz = io.log.filter(x => x.t === 'hazard');
  assert(hz.length === 1 && !hz[0].damages.length && hz[0].qi.done && !hz[0].qi.recast && hz[0].done === true, 'qi gone ' + J(hz));
  assert(ref.phase !== 'over' && !io.log.some(x => x.t === 'gameOver') && !io.records.some(r => r.ev === 'battle.over'), 'no game over while the shot is still playing');
  io.advance(10000);
  const evs = io.records.map(r => r.ev);
  const iEnd = evs.indexOf('turn.end'), iOver = evs.indexOf('battle.over');
  assert(iEnd >= 0 && iEnd < iOver && io.log.at(-1).t === 'gameOver' && io.log.at(-1).result === 'win', 'turn.end then battle.over: ' + evs.join(' '));
  assert(io.log.filter(x => x.t === 'hazard').length === 1, 'once');
  ref.stop();
}));


await test('地圖畫面：新回合的劍氣出發時，還在揮 / 還在飛的月牙先收尾（浮著的照伺服器的，不會多出來）；飛完的 hazard 叫兩次（收到就演 + 照順序）只演一次；劍士倒下 → 劍氣都收掉、預警線不畫', () => base(() => {
  const m = make(1);
  let now = 50;
  const { c, banners } = fakeMapCtx(m, () => now);
  const S = m.mechState;
  const step = (secs) => { for (let f = 0; f < Math.round(secs / CONFIG.FIXED_DT); f++) { now += CONFIG.FIXED_DT; swordsmanView.update(c, CONFIG.FIXED_DT); } };
  // 收尾的那一波把最後一道掃完、馬上再揮一輪三道：揮到一半（有的還在飛）下一位玩家的回合就開始了
  S.qi = []; S.flying = null;
  swordsmanView.turnVolley(c, { kind: 'swordQi', hover: [2, 0, 1], recast: [2, 0, 1] });
  step(0.4);
  assert(c.state.recast || c.state.crescents.length, 'mid-recast');
  swordsmanView.hazard(c, { start: { kind: 'swordsman', qi: { row: 2, x: QX(), speed: 200, hover: [0, 1] } }, recvAt: now });
  assert(J(S.qi) === '[0,1]' && !c.state.recast && !c.state.crescents.length && S.flying && S.flying.row === 2, 'hover from the server ' + J(S.qi));
  step(3);
  assert(J(S.qi) === '[0,1]', 'no phantom crescents landing later ' + J(S.qi));
  // 飛完、再揮一輪：收到就演（early）、照順序再叫一次不重演
  S.qi = [];
  const msg = { t: 'hazard', kind: 'swordsman', qi: { row: 2, x: 0, done: true, hover: [3, 1, 0], recast: [3, 1, 0] }, damages: [], done: true, hp: [], seq: 1, recvAt: now };
  const b0 = banners.length;
  swordsmanView.hazard(c, msg, true);
  const R = c.state.recast;
  assert(S.flying === null && R && J(R.rows) === '[3,1,0]' && banners.length === b0 + 1, 'recast at receipt');
  step(0.05);
  swordsmanView.hazard(c, msg, false);
  assert(c.state.recast === R && banners.length === b0 + 1, 'played once');
  step(2);
  assert(J(S.qi) === '[3,1,0]', 'landed once ' + J(S.qi));
  // 劍士倒下：劍氣都收掉；預定的一閃的預警線不畫
  const g = m.byId('swordsman');
  S.next = { action: 'iai', facing: -1, targetIds: ['p1'], lines: [{ targetId: 'p1', x0: 905, y0: 545, x1: 0, y1: 560 }] };
  let sp = spyCtx();
  swordsmanView.drawScene(sp.ctx, c);
  assert(drewLine(sp.calls, S.next.lines[0]), 'warned while alive');
  g.die('hit');
  assert(swordsmanView.onDeath(c, g) === true && S.flying === null && !S.qi.length && !c.state.recast && !c.state.crescents.length, 'cleared on death');
  sp = spyCtx();
  swordsmanView.drawScene(sp.ctx, c);
  assert(!drewLine(sp.calls, S.next.lines[0]), 'no warning after death');
}));

await test('真的 GameView：劍氣飛完、再揮一輪——就算佇列前面還在播這回合的開火，收到就演（劍氣收掉、揮刀）；血量與護盾照順序（開火播完才套），套用時不重演；護盾被劍氣打掉照伺服器', () => base(() => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'wanderer', players, seed: 2, stage: 3 });
  for (const p of m.players) p.hp = p.maxHp = 1000;
  placeOn(m, m.players[0], 300, 560);
  placeOn(m, m.players[1], 800, 560);
  m.players[1].shield = 1;
  m.mechState.qi = [0];
  m.mechState.next = { action: 'parry' };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  const view = mkView();
  let now = 1000;
  view.clock = () => now;
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  feed();
  for (let f = 0; f < 5; f++) view.update(CONFIG.FIXED_DT);
  const S = view.match.mechState;
  const st = view.mapCtx.state;
  const v2 = view.match.byId('p2');
  assert(view.canAct && S.flying && v2.shield === 1, 'my turn, qi flying ' + J(S.flying));
  const fxBanner = view.mapCtx.fx.banner;
  let recasts = 0;
  view.mapCtx.fx.banner = (t, col) => { if (/揮出新的劍氣/.test(t)) recasts++; return fxBanner(t, col); };
  const p1 = m.players[0];
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 80, power: 20, x: p1.x, y: p1.y, facing: 1, stamina: p1.stamina });
  io.advance(50);
  feed();   // 開火的重播開始播
  view.update(CONFIG.FIXED_DT);
  io.advance(1100);
  now += 1.15;
  const hits = io.log.filter(x => x.t === 'hazard' && x.damages.some(d => d.id === 'p2'));
  const done = io.log.find(x => x.t === 'hazard' && x.qi && x.qi.done);
  assert(hits.length === 1 && hits[0].damages.find(d => d.id === 'p2').blocked && hits[0].hp.find(h => h.id === 'p2').shield === 0 && m.players[1].shield === 0, 'server: the shield took it ' + J(hits));
  assert(done && done.qi.recast && done.qi.recast.length === 3, 'server: done and recast ' + J(done && done.qi));
  feed();
  assert(view.script || view.queue.length, 'the shot is still playing');
  assert(S.flying === null && st.recast && recasts === 1, 'recast at receipt, ahead of the queue');
  assert(v2.shield === 1, 'shield not applied yet (in order)');
  for (let f = 0; f < 900 && (view.script || view.queue.length); f++) view.update(CONFIG.FIXED_DT);
  assert(recasts === 1, 'not played twice: ' + recasts);
  assert(v2.shield === 0 && v2.hp === 1000, 'shield from the server, in order: ' + J([v2.shield, v2.hp]));
  ref.stop();
}, { SWORDSMAN: { qiSpeed: 1000 } }));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
