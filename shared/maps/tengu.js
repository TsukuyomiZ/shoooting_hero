import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { simulateShot, launchVelocity } from '../physics/weapons.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// 菁英關「天狗」（山頂）的天狗（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。2026-10-20 使用者定的招式。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/tengu.js。這一場的狀態 match.mechState = { def, next, hover, flying, flyingTurn, seq, roam }：
//   next   = 預定的下一招 { action: 'feather' | 'gust' }（開場一次、之後每回合出完招再抽，權重 TENGU.weights：隨機各半）
//   hover  = 浮在他身邊、還沒射出去的羽毛有幾根（0 ~ TENGU.feathers；開場就有一整輪）
//   flying = 這個玩家回合射出去、還在飛的羽毛 [{ id, x0, y0, vx, vy, t0, x, y, done }]（t0 = 出發的時刻（裁判的時鐘，ms）、x / y = 上次判定到哪裡）；
//            flyingTurn = 在誰的回合射的；seq = 羽毛的流水號；clock = 上次推進到裁判時鐘的幾 ms（快照算還沒出發的還要等多久）
//   roam   = 他在天上飄的範圍（地圖機制 build 設的；預定羽刃的時候拿掉：反正要飛到正中間）
//
// - 天狗一直飛在天上（level.mechanic.tengu；不受重力、不會被擊退：fixed），每回合出招前在 roam 的範圍裡飄一段（Match.planAiTurn 的 planGlide）。
//   血量 TENGU.hp，跟一般敵人一樣依人數、關數放大。打倒他 = 過關。這一關有風（共用的風向，見 shared/physics/wind.js），風彈與玩家的砲彈都會被吹偏。
// - 他的招式：
//     羽刃（feather）：飛到畫面正中間的上方（TENGU.center），把身邊浮著的羽毛補滿到 TENGU.feathers 根（使用者：16 根）
//     風彈（gust）：對隨機一位活著的玩家射一顆風彈（WEAPONS.tenguGust：20（使用者從 40 下調）、爆炸半徑 50，比大砲的 42 大一點；拋物線、會被風吹偏）。
//                  傷害照開場人數放大（gustDamage：每多一人 +TENGU.gustPerExtraPlayer，1 ~ 4 人 20 / 30 / 40 / 50；使用者 2026-10-21）。
//                  他會照這個回合的風瞄（aimGust：跟 AI 一樣試射挑最準的），再加一點誤差（TENGU.aimError 度、aimPowerError 力量）
// - 羽毛（使用者：每到玩家的回合就射 4 根、躲不躲得掉有運氣成分）：每一位玩家的回合開始時（回合開始的效果之後、開始計時之前），浮著的羽毛射出
//   TENGU.perTurn 根（不夠就全部），各自射向地圖上隨機的一點（左右整張地圖均勻挑、瞄準那裡的地面；全場亂射，不一定朝輪到的人；使用者選的），一根接一根（featherGap 秒），
//   在這個回合裡以 featherSpeed px/s 直線往下飛（地圖機制的 hazardStart / hazardStep / hazardFinish，跟流浪劍士的劍氣同一套）：
//   碰到第一個玩家就打他（WEAPONS.tenguFeather：15、不擊退，羽毛就停了）、碰到地形就插在地上；木台（可穿透平台）擋不住。
//   回合在羽毛飛完之前就結束（開火、超時、AI 代打），剩下的在回合收尾時一口氣射完（照那時候大家的位置）。天狗自己的回合不射

export const TENGU_ACTION_NAMES = {
  feather: '羽刃',
  gust: '風彈',
  idle: '盤旋',
};

const FEATHER_STEP = 4;   // 羽毛的判定：沿著這一段每隔幾 px 看一次（判定半徑 8 > 4 / 2，不會漏掉擦過的人）

// 建立天狗（關卡的敵人之後），回傳這一場的狀態。hpScale = 一般敵人的血量倍率（人數 × 關數）。開場的羽毛在 ready 才撒（等大家落地之後）
export function buildTengu(match, hpScale) {
  const def = match.level.mechanic;
  const s = def.tengu;
  match.entities.push(new Entity({
    ...CONFIG.ENEMY, id: 'tengu', name: '天狗', team: 'enemies', controller: 'ai', slot: 0, facing: -1,
    x: s.x, y: s.y, hw: s.hw, h: s.h, hp: Math.round(CONFIG.TENGU.hp * hpScale),
    fixed: true, part: 'tengu', weapons: ['tenguGust'],
  }));
  return { def, next: null, hover: 0, flying: [], flyingTurn: null, seq: 0, clock: 0, roam: null };
}

// 這一場的狀態（match.mechState）。別張地圖當作沒有天狗
const tenguState = (match) => (match.mechState && match.mechState.def && match.mechState.def.type === 'tengu' ? match.mechState : null);

// 浮著的第 k 根羽毛在哪（0 ~ feathers - 1；從左邊經過頭頂排到右邊，一根近一根遠）：{ x, y, angle（從胸口往外的方向）}。
// 伺服器（羽毛從這裡出發）與畫面（浮著的畫在這裡）共用
export function featherSlot(g, k) {
  const n = CONFIG.TENGU.feathers;
  const angle = Math.PI + (k + 0.5) * Math.PI / n;   // π（左）→ 1.5π（頭頂）→ 2π（右）：畫面座標 y 往下，sin 是負的 = 上面
  const r = 44 + (k % 2) * 14;
  const cx = g.x, cy = g.y - g.h * 0.6;
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r, angle };
}

// 抽下一招（開場、每回合出完招之後）。預定羽刃：天狗這回合不在天上飄（反正要飛到正中間）；風彈照常飄
export function planTenguNext(match) {
  const S = tenguState(match);
  if (!S) return null;
  const W = CONFIG.TENGU.weights;
  const action = weightedPick(match.rng, [['feather', W.feather], ['gust', W.gust]]) || 'gust';
  S.next = { action };
  const g = match.byId('tengu');
  if (g) g.roam = action === 'feather' ? null : S.roam;
  return S.next;
}

// 輪到天狗（飄完之後）：出預定的那一招，再抽下一招。回傳 { steps: [招式], next }（格式同 Boss）
export function resolveTenguTurn(match, g) {
  const S = tenguState(match);
  const steps = [];
  if (g.alive && match.players.some(e => e.alive)) {
    const plan = (S && S.next) || planTenguNext(match) || { action: 'gust' };
    steps.push(plan.action === 'feather' ? featherStep(match, g) : gustStep(match, g));
  }
  if (!steps.length) steps.push({ action: 'idle', still: stillResult(match) });
  planTenguNext(match);
  return { steps, next: S && S.next ? { ...S.next } : null };
}

// 羽刃：飛到正中間的上方，羽毛補滿。x0 / y0 = 從哪裡飛過去（客戶端照它畫飛過去的樣子）、hover = 補完幾根、added = 這次補了幾根
function featherStep(match, g) {
  const S = tenguState(match);
  const T = CONFIG.TENGU;
  const x0 = g.x, y0 = g.y;
  g.x = T.center.x;
  g.y = T.center.y;
  g.vx = 0;
  g.vy = 0;
  const near = nearestPlayerAt(match, g.cx, g.cy);
  if (near && near.x !== g.x) g.facing = near.x > g.x ? 1 : -1;
  const before = S ? S.hover : 0;
  if (S) S.hover = T.feathers;
  return {
    action: 'feather', x0, y0, x: g.x, y: g.y, hover: T.feathers, added: T.feathers - before, facing: g.facing,
    cast: T.cast.feather, still: stillResult(match),
  };
}

// 風彈的傷害（還沒乘敵人倍率）：武器傷害 × (1 + gustPerExtraPlayer × (開場人數 - 1))，四捨五入。
// 人數照開場算（含之後倒下的隊友，同一般敵人的血量倍率）：打到後面有人倒下，傷害也不會變小
export function gustDamage(match) {
  const n = Math.max(1, match.players.length);
  return Math.round(CONFIG.WEAPONS.tenguGust.damage * (1 + CONFIG.TENGU.gustPerExtraPlayer * (n - 1)));
}

// 風彈：隨機一位活著的玩家，照這個回合的風瞄（aimGust），加一點誤差射出去（傷害照開場人數放大，gustDamage）。
// 回傳的招式帶 targetId、angle / power（加了誤差之後的）、wind（這個回合的風）、dmg（照人數放大後的傷害，還沒乘敵人倍率）
function gustStep(match, g) {
  const alive = match.players.filter(e => e.alive);
  if (!alive.length) return { action: 'idle', still: stillResult(match) };
  const W = { ...CONFIG.WEAPONS.tenguGust, damage: gustDamage(match) };   // 同一把武器（重播照 id 畫），只換傷害
  const target = match.rng.pick(alive);
  if (target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
  const aim = aimGust(match, g, target);
  const err = CONFIG.TENGU.aimError;
  const angle = aim.angle + (match.rng.float() * 2 - 1) * err;
  const power = Math.max(0, Math.min(100, aim.power + (match.rng.float() * 2 - 1) * CONFIG.TENGU.aimPowerError));
  const m = g.muzzle();
  const v = launchVelocity(W, angle, power);
  const p = bossProjectile(g, W, m.x, m.y, v.vx, v.vy);
  return {
    action: 'gust', targetId: target.id, angle: r1(angle), power: r1(power), wind: match.wind, dmg: W.damage, facing: g.facing,
    cast: CONFIG.TENGU.cast.gust, shot: bossShot(match, g, W, [p], g.facing),
  };
}

// 風彈怎麼瞄：照這個回合的風試射（simulateShot 照 world.wind 偏），先掃一圈角度 × 幾種力量，挑落點離目標最近的，再在附近細找。
// 打得到目標本人 = 0 分；落水、飛出場外多扣 400。回傳 { angle, power, miss（落點離目標多遠）}
export function aimGust(match, g, target) {
  const W = CONFIG.WEAPONS.tenguGust;
  const world = match.world;
  const score = (angle, power) => {
    const r = simulateShot(world, g, W, angle, power, 6, 0);
    if (r.hit.type === 'entity' && r.hit.entity === target) return 0;
    let d = Math.hypot(r.hit.x - target.cx, r.hit.y - target.cy);
    if (r.hit.type !== 'terrain' && r.hit.type !== 'entity') d += 400;
    return d;
  };
  let best = null;
  const tryOne = (angle, power) => {
    const s = score(angle, power);
    if (!best || s < best.miss) best = { angle, power, miss: s };
  };
  for (let a = -180; a < 180; a += 4) for (const pw of [0, 15, 30, 45, 60, 80]) tryOne(a, pw);
  const { angle: a0, power: p0 } = best;
  for (let a = a0 - 4; a <= a0 + 4; a += 0.5) {
    for (let pw = Math.max(0, p0 - 10); pw <= Math.min(100, p0 + 10); pw += 2.5) tryOne(a, pw);
  }
  return best;
}

// ---------- 玩家回合裡的危險物（地圖機制的 hazardStart / hazardStep / hazardFinish，裁判呼叫）：羽毛 ----------

// 玩家 e 的回合開始（開始計時之前；now = 裁判的時鐘，ms）：浮著的羽毛射出 perTurn 根（從最後浮上去的那幾根開始），各自射向地圖上隨機的一點。
// 回傳給客戶端的資料 { kind: 'tengu', feathers: [{ id, x0, y0, vx, vy（px/s）, delay（秒，第幾根就晚幾個 featherGap 出發）}], hover（剩幾根浮著）}；
// 沒有羽毛 = null
export function startHazards(match, e, now) {
  const S = tenguState(match);
  const g = match.byId('tengu');
  if (!S || !e || e.team !== 'players' || !e.alive || !g || !g.alive) return null;
  if (S.flying.length || S.hover <= 0) return null;
  const T = CONFIG.TENGU;
  const n = Math.min(T.perTurn, S.hover);
  const maxX = match.terrain.maxX;
  const feathers = [];
  S.clock = now;
  for (let k = 0; k < n; k++) {
    const slot = featherSlot(g, S.hover - 1 - k);
    // 地圖上隨機的一點：左右整張地圖均勻挑 x，瞄準那裡的地面（groundBelow：木台擋不住，不算）——落點就是那一點，
    // 站在那裡的人身體擋在路上會先被打到；地圖兩邊（出生點、牆邊）也一樣打得到
    const tx = match.rng.range(10, maxX - 10);
    const dx = tx - slot.x, dy = groundBelow(match, tx, slot.y) - slot.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const delay = k * T.featherGap;
    const f = { id: ++S.seq, x0: slot.x, y0: slot.y, x: slot.x, y: slot.y, vx: dx / d * T.featherSpeed, vy: dy / d * T.featherSpeed, t0: now + delay * 1000, done: false };
    S.flying.push(f);
    feathers.push({ id: f.id, x0: f.x0, y0: f.y0, vx: f.vx, vy: f.vy, delay });
  }
  S.hover -= n;
  S.flyingTurn = e.id;
  return { kind: 'tengu', feathers, hover: S.hover };
}

// 推進到 now：每一根已經出發的羽毛從上次判定到的地方掃到現在的位置——碰到玩家（第一個）就打、碰到地形就插在地上、飛出地圖 / 掉到水面就沒了；
// 天狗已經倒下 = 全部收掉（cancel）。flush（回合要收尾了）照常推進，剩下的由 finishHazards 一口氣射完。
// 回傳 { kind, damages, done（這回合的羽毛都結束了）, notify, feathers: [{ id, x, y, end: 'hit' | 'ground' | 'out' | 'cancel', target? }]（這一次結束的）,
//        hover }；沒有在飛的 = null
export function stepHazards(match, now) {
  const S = tenguState(match);
  if (!S || !S.flying.length) return null;
  const g = match.byId('tengu');
  const live = !!(g && g.alive);
  const W = CONFIG.WEAPONS.tenguFeather;
  const damages = [];
  const ended = [];
  for (const f of S.flying) {
    if (f.done) continue;
    if (!live) {
      f.done = true;
      ended.push({ id: f.id, x: f.x, y: f.y, end: 'cancel' });
      continue;
    }
    if (now < f.t0) continue;
    const t = (now - f.t0) / 1000;
    const nx = f.x0 + f.vx * t, ny = f.y0 + f.vy * t;
    const hit = sweepFeather(match, f, nx, ny, W, g);
    if (!hit) { f.x = nx; f.y = ny; continue; }
    f.done = true;
    f.x = hit.x;
    f.y = hit.y;
    if (hit.e) damages.push(...match.applyExplosion(hit.x, hit.y, W, g, hit.e, { directOnly: true }));
    ended.push({ id: f.id, x: hit.x, y: hit.y, end: hit.e ? 'hit' : hit.end, ...(hit.e ? { target: hit.e.id } : {}) });
  }
  S.clock = now;
  const done = S.flying.every(f => f.done);
  if (done) S.flying = [];
  return { kind: 'tengu', damages, done, notify: damages.length > 0 || ended.length > 0, feathers: ended, hover: S.hover };
}

// x 這一直線上、從 y0 往下第一個實心地形的高度（可穿透的木台不算；到水面都沒有 = 水面）
function groundBelow(match, x, y0) {
  for (let y = Math.max(0, Math.floor(y0)); y < CONFIG.WATER_LEVEL; y += 2) if (match.terrain.isSolid(x, y)) return y;
  return CONFIG.WATER_LEVEL;
}

// 羽毛 f 從 (f.x, f.y) 飛到 (nx, ny) 這一段：第一個碰到的東西 { x, y, e }（玩家）/ { x, y, end: 'ground' | 'out' }；沒碰到 = null
function sweepFeather(match, f, nx, ny, W, g) {
  const dx = nx - f.x, dy = ny - f.y;
  const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / FEATHER_STEP));
  const maxX = match.terrain.maxX;
  for (let k = 1; k <= n; k++) {
    const x = f.x + dx * k / n, y = f.y + dy * k / n;
    if (x < 0 || x > maxX || y > CONFIG.WATER_LEVEL) return { x, y, end: 'out' };
    for (const e of match.players) if (e.alive && e.containsPoint(x, y, W.hitRadius)) return { x, y, e };
    if (match.terrain.blocksShot(x, y, g.team)) return { x, y, end: 'ground' };
  }
  return null;
}

// 回合收尾時還有羽毛沒飛完（還沒出發的也算）：回傳一口氣射完的函式——從它們現在的地方照原本的方向以 WEAPONS.tenguFeather.speed 飛
// （照那時候大家的位置；一根打一個人）；回傳跟開火同樣格式的結果（kind: 'tenguFeather'、turnId、hover）。沒有 = null
export function finishHazards(match) {
  const S = tenguState(match);
  if (!S) return null;
  const rest = S.flying.filter(f => !f.done);
  const g = match.byId('tengu');
  if (!rest.length || !g || !g.alive) { S.flying = []; return null; }
  return () => {
    const W = CONFIG.WEAPONS.tenguFeather;
    const projs = rest.map((f, k) => {
      const sp = Math.sqrt(f.vx * f.vx + f.vy * f.vy) || 1;
      const p = bossProjectile(g, W, f.x, f.y, f.vx / sp * W.speed, f.vy / sp * W.speed);
      p.spawn = 1 + k * 4;
      p.ignore.add(g);
      return p;
    });
    S.flying = [];
    const result = match.resolveVolley(g, W, projs, 0);
    return { kind: 'tenguFeather', actorId: g.id, turnId: S.flyingTurn, weapon: W.id, hover: S.hover, ...result };
  };
}

const r1 = (v) => Math.round(v * 10) / 10;
