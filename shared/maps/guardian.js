import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { clamp } from '../core/utils.js';
import { weightedPick, nearestPlayerAt, farthestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// 菁英關「大樹守衛」（森林）的守衛（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/guardian.js。這一場的狀態 match.mechState = { def, next }（next = 預定的下一招）。
//
// - 後面的大樹只是背景（子彈、角色都穿得過）。守衛從地圖最右邊出場（level.mechanic.guardian），是有重力的一般角色：會被擊退
//   （整片地面炸不壞（2026-10-19 起），不會有坑；下面衝鋒 / 落地碰到坑的處理是通用的，地形挖得動時才用得到）。
//   血量 GUARDIAN.hp，跟一般敵人一樣依人數、關數放大（菁英關不是 Boss 關：不算首領，弒神者對他沒用）。打倒他 = 過關。
// - 下一招是事先抽好的（next：開場一次、之後每次用掉就再抽，權重 GUARDIAN.weights），玩家回合畫面上會標出來：
//     衝鋒（charge）：一抽到就標記離他最遠的玩家（next.targetId）；輪到他時衝向被標記的人（那人倒下了就改衝當下最遠的，見 chargeTarget），
//                     貼著地面直直衝過去，路上的玩家一起撞開（穿透，每人一次；背後的、目標後面的撞不到，見 chargeLane），撞到被標記的人就停在他旁邊（WEAPONS.guardianCharge）；
//                     前面的地勢高過他腳下 CLIMB px（坑壁）或到了地圖邊也停。坑洞直接衝過去；目標在坑裡（比衝鋒的高度低、撞不到）就衝到他那一行為止
//     舉盾（shield）：一抽到就舉盾、面向離他最近的玩家（next.facing），舉著的時候受到的傷害 -GUARDIAN.shieldCut%（mechanic 的 defenseMult）；
//                     輪到他時（這一輪的最後）盾擊盾牌前方的玩家（WEAPONS.guardianBash，往前推 GUARDIAN.bashReach），之後盾放下（除非又抽到舉盾）
//     躍擊（leap）：一抽到就隨機鎖定一個玩家「當下」站的地方（next.x / next.y / targetId，警示範圍畫在那裡）；輪到他時跳到那裡，
//                   落地往兩邊震開（WEAPONS.guardianLeap，各 GUARDIAN.leapZone px）：還站在警示範圍裡的玩家受傷，提早走開就躲得掉；
//                   同一回合接著橫劈（slash，第二招）：從身體中間往兩邊各掃 GUARDIAN.slashReach px（WEAPONS.guardianSlash，見 slashBand），掃到的受傷並流血
// - 躍擊的傷害看距離（出招當下他離落地點多遠，見 strikeDamage），用一份改了 damage 的武器結算（id 不變，客戶端照 id 畫）；衝鋒、橫劈的傷害固定

export const GUARDIAN_ACTION_NAMES = {
  charge: '衝鋒',
  shield: '舉盾',
  bash: '盾擊',
  leap: '躍擊',
  slash: '橫劈',
  idle: '戒備',
};

const CLIMB = 8;         // 衝鋒：前面的地勢比腳下高出這麼多 px 就撞停（他在坑裡時的坑壁；地面的小起伏、往下的坑邊不算）
const LEAP_LIFT = 16;    // 躍擊的震波離地多高（判定半徑 hitRadius 往上下各涵蓋一段：落地點附近站在小坡、坑邊的人也打得到）
const SPOT_REACH = 60;   // 躍擊的落地點：鎖定的位置站不下守衛時，左右最多挪多遠找站得住的地方
const SPOT_RISE = 80;    // 同上，上下找多遠
const SETTLE_FRAMES = 360;   // 衝鋒停下的那一行站不住：照物理落下去最多跑幾幀（跟招式的沉降一樣）

// 建立守衛（關卡的敵人之後），回傳這一場的狀態。hpScale = 一般敵人的血量倍率（人數 × 關數）
export function buildGuardian(match, hpScale) {
  const def = match.level.mechanic;
  const g = def.guardian;
  match.entities.push(new Entity({
    ...CONFIG.ENEMY, id: 'guardian', name: '大樹守衛', team: 'enemies', controller: 'ai', slot: 0, facing: -1,
    x: g.x, y: g.y, hw: g.hw, h: g.h, hp: Math.round(CONFIG.GUARDIAN.hp * hpScale),
    part: 'guardian', weapons: ['guardianCharge'],
  }));
  return { def, next: null };
}

// 這一場的狀態（match.mechState）。別張地圖當作沒有守衛
const guardianState = (match) => (match.mechState && match.mechState.def && match.mechState.def.type === 'guardian' ? match.mechState : null);

// 盾舉著嗎（預定的下一招是舉盾 = 已經舉起來了）
export function shieldUp(match) {
  const S = guardianState(match);
  return !!(S && S.next && S.next.action === 'shield');
}

// 受到的傷害倍率（地圖機制的 defenseMult）：舉盾的守衛 ×(1 - shieldCut%)，其他人 1
export function guardianDefense(match, e) {
  return e.part === 'guardian' && shieldUp(match) ? Math.max(0, 1 - CONFIG.GUARDIAN.shieldCut / 100) : 1;
}

// 躍擊的傷害：離 d px，near 以內是 damage、far 以上是 damageFar，中間照比例（沒有 damageFar 的武器 = 固定 damage）
export function strikeDamage(weapon, d) {
  const G = CONFIG.GUARDIAN;
  const t = clamp((d - G.near) / Math.max(1, G.far - G.near), 0, 1);
  const far = weapon.damageFar ?? weapon.damage;
  return weapon.damage + (far - weapon.damage) * t;
}

// 守衛的腳底放在 x 這一行，站得住的高度（照物理的 Entity.standing：斜坡上身體外側先碰到坡也算，身體不卡進地形）裡離 refY 最近的；
// 這一行上下 SPOT_RISE 內都沒有 = null
export function standY(match, g, x, refY) {
  const t = match.terrain;
  const r = Math.round(refY);
  for (let k = 0; k <= SPOT_RISE; k++) {
    for (const y of k ? [r + k, r - k] : [r]) {
      if (y - g.h < 0 || y > CONFIG.WATER_LEVEL - CONFIG.WATER.safeMargin) continue;
      if (!g.collides(t, x, y) && g.standing(t, x, y)) return y;
    }
  }
  return null;
}

// 守衛站得下的地方：x 這一行站不下就往左右挪（最多 SPOT_REACH），回傳 { x, y }；都站不下 = null
export function standSpot(match, g, x, refY) {
  const lo = Math.ceil(g.hw), hi = Math.floor(match.terrain.maxX - g.hw);
  const x0 = clamp(Math.round(x), lo, hi);
  for (let d = 0; d <= SPOT_REACH; d += 2) {
    for (const sx of d ? [x0 - d, x0 + d] : [x0]) {
      if (sx < lo || sx > hi) continue;
      const y = standY(match, g, sx, refY);
      if (y !== null) return { x: sx, y };
    }
  }
  return null;
}

// 躍擊要跳去哪裡：隨機一個活著的玩家（match.rng）現在站的地方。沒有人、那裡附近站不下守衛 = null
export function leapSpot(match, g) {
  const alive = match.players.filter(e => e.alive);
  if (!alive.length) return null;
  const target = match.rng.pick(alive);
  const spot = standSpot(match, g, target.x, target.y);
  return spot && { x: spot.x, y: spot.y, targetId: target.id };
}

// 衝鋒要衝向誰：抽到時標記的那個人（plan.targetId）；他倒下了（或沒標記）就改成現在離守衛最遠的活著的玩家。沒有人 = null
// （出招與玩家回合畫面上的標記都照這個）
export function chargeTarget(match, g, plan) {
  const id = plan && plan.targetId;
  const marked = id ? match.players.find(e => e.id === id && e.alive) : null;
  return marked || farthestPlayerAt(match, g.cx, g.cy);
}

// 衝鋒的路線（畫面照它畫，衝鋒也照它決定撞得到誰）：守衛身體的中間（from；跟他疊在一起、站在他前半身的人也在路線上）到目標身體靠他這一邊的邊緣（to）；
// top ~ bottom = 衝鋒撞得到的高度。身體碰到這一段（也碰到這個高度）的人才會被撞到，見 offChargeLane
export function chargeLane(g, target) {
  const hr = CONFIG.WEAPONS.guardianCharge.hitRadius;
  const dir = target.x > g.x ? 1 : target.x < g.x ? -1 : g.facing;
  const a = g.x, b = target.x - dir * target.hw;
  return { x0: Math.min(a, b), x1: Math.max(a, b), top: g.cy - hr, bottom: g.cy + hr, dir, from: a, to: b };
}

// e 的身體不在衝鋒的路線上（只看左右）：身體中間不在守衛身體中間的前面（在他背後，例如貼在他背上、站在他腳邊靠後面；
// 跟他疊在一起、中間在他前半身的人還是會被撞到），或靠守衛這一邊的邊緣比目標的還遠（在目標後面：衝鋒撞到目標就停了）。
// 衝鋒出發前把這些人放進 p.ignore（目標自己不放）
export function offChargeLane(lane, e) {
  const d = lane.dir;
  return (e.x - lane.from) * d <= 0 || (e.x - d * e.hw - lane.to) * d > 0;
}

// 橫劈打得到的範圍（守衛站在 x、身體中間的高度 cy；畫面不畫範圍提示（2026-10-19 取消））：x0 ~ x1 = 身體碰到這段就會被打到；y = 橫劈的高度
export function slashBand(x, cy) {
  const W = CONFIG.WEAPONS.guardianSlash;
  const reach = CONFIG.GUARDIAN.slashReach + W.hitRadius;
  return { x0: x - reach, x1: x + reach, y: cy, top: cy - W.hitRadius, bottom: cy + W.hitRadius };
}

// 躍擊落地的震波打得到的範圍（警示範圍也照這個畫）：x0 ~ x1 = 身體碰到這段就會被打到；y = 震波的高度
export function leapBand(spot) {
  const W = CONFIG.WEAPONS.guardianLeap;
  const reach = CONFIG.GUARDIAN.leapZone + W.hitRadius;
  return { x0: spot.x - reach, x1: spot.x + reach, y: spot.y - LEAP_LIFT, top: spot.y - LEAP_LIFT - W.hitRadius, bottom: spot.y };
}

// 盾擊打得到的範圍（守衛站在 g、盾牌朝 facing）：x0 ~ x1 = 身體碰到這段就會被打到（畫面的盾擊範圍也照這個畫）
export function bashBand(g, facing) {
  const W = CONFIG.WEAPONS.guardianBash;
  const a = g.x + facing * (g.hw - W.hitRadius), b = g.x + facing * (g.hw + CONFIG.GUARDIAN.bashReach + W.hitRadius);
  return { x0: Math.min(a, b), x1: Math.max(a, b), top: g.cy - W.hitRadius, bottom: g.cy + W.hitRadius };
}

// 抽下一招（開場、每次出完招之後）。舉盾：馬上舉起來、面向離他最近的玩家；躍擊：隨機鎖定一個玩家現在站的地方（再抽一次 rng）；
// 衝鋒（躍擊找不到落地點也改衝鋒）：標記離他最遠的玩家（targetId）
export function planGuardianNext(match) {
  const S = guardianState(match);
  if (!S) return null;
  const g = match.byId('guardian');
  const W = CONFIG.GUARDIAN.weights;
  const action = weightedPick(match.rng, [['charge', W.charge], ['shield', W.shield], ['leap', W.leap]]) || 'charge';
  S.next = { action };
  if (!g || !g.alive) return S.next;
  let plan = null;
  if (action === 'shield') {
    const near = nearestPlayerAt(match, g.cx, g.cy);
    g.facing = near && near.x !== g.x ? (near.x > g.x ? 1 : -1) : g.facing;
    plan = { action, facing: g.facing };
  } else if (action === 'leap') {
    const spot = leapSpot(match, g);
    if (spot) plan = { action, ...spot };
  }
  if (!plan) {
    const far = farthestPlayerAt(match, g.cx, g.cy);
    plan = far ? { action: 'charge', targetId: far.id } : { action: 'charge' };
  }
  S.next = plan;
  return S.next;
}

// 輪到守衛：出預定的那一招並直接結算好（躍擊之後接著橫劈：一回合兩招），再抽下一招。回傳 { steps: [招式…], next }（格式同 Boss）
export function resolveGuardianTurn(match, g) {
  const S = guardianState(match);
  const plan = (S && S.next) || planGuardianNext(match) || { action: 'charge' };
  const main = plan.action === 'leap' ? leapStep(match, g, plan)
    : plan.action === 'shield' ? bashStep(match, g, plan)
      : chargeStep(match, g, plan);
  const steps = [main];
  if (main.action === 'leap' && g.alive && match.players.some(e => e.alive)) {
    // 先校正成躍擊的結果（跟客戶端播完躍擊、套上 results 一樣：速度歸零），橫劈的重播才從同一個狀態開始
    match.applyEntities(main.shot.results);
    steps.push(slashStep(match, g));
  }
  planGuardianNext(match);
  // 下一招抽到舉盾會馬上轉向（面向最近的人）：最後一招的校正帶著新的方向，客戶端整回合播完就轉過去。
  // 只改最後一招的：前面的招式（躍擊）的 results 是它自己結算完的樣子，客戶端播下一招之前先套那一份
  const last = steps[steps.length - 1];
  const res = last.shot || last.still;
  if (res) res.results = match.entities.map(e => e.toState());
  return { steps, next: S && S.next ? { ...S.next } : null };
}

// 衝鋒往 dir 最多跑得了多遠（px，整數）：前面的地勢高過腳下 CLIMB px（坑壁）、或到了地圖邊就停
export function chargeRun(match, g, dir) {
  const t = match.terrain;
  const lo = g.hw, hi = t.maxX - g.hw;
  let n = 0;
  for (let x = g.x + dir; x >= lo && x <= hi && !g.collides(t, x, g.y - CLIMB); x += dir) n++;
  return n;
}

// 衝鋒：飛行物就是守衛自己（從身體中間出發、判定半徑 = 半寬），路上的玩家穿過去（每人撞一次），撞到目標（p.stopAt）就停；
// 第一步就碰得到他整個身體，所以不在路線上的人（背後的、目標後面的，見 offChargeLane）先放進 p.ignore：撞得到的人 = 畫面上路線碰到的人。
// 最多跑到 chargeRun 的盡頭、也不超過目標那一行（目標在坑裡撞不到：衝到他頭上就停）。跑完把守衛放到停下的地方（那一行站得住的高度，坑裡就站在坑底；
// 那一行站不住就照物理落下去、挪到旁邊站得住的地方）。through = 路上一起被撞到的人（id 用逗號接起來，紀錄用）
function chargeStep(match, g, plan) {
  const G = CONFIG.GUARDIAN;
  const target = chargeTarget(match, g, plan);
  if (!target) return { action: 'idle', still: stillResult(match) };
  const W = CONFIG.WEAPONS.guardianCharge;
  const dir = target.x > g.x ? 1 : target.x < g.x ? -1 : g.facing;
  g.facing = dir;
  const dist = Math.hypot(target.cx - g.cx, target.cy - g.cy);
  const info = { action: 'charge', targetId: target.id, dmg: W.damage, dist: Math.round(dist), cast: G.cast.charge };
  const run = chargeRun(match, g, dir);
  if (run < 1) return { ...info, blocked: true, still: stillResult(match) };   // 貼著坑壁 / 地圖邊：衝不出去
  const x0 = g.x, y0 = g.y;
  const reach = Math.min(run, Math.max(1, Math.abs(target.x - x0)));
  const p = bossProjectile(g, W, x0, g.cy, dir * W.speed, 0);
  p.range = reach;
  p.stopAt = target;
  const lane = chargeLane(g, target);
  for (const e of match.entities) if (e !== g && e !== target && offChargeLane(lane, e)) p.ignore.add(e);
  const shot = bossShot(match, g, W, [p], dir);
  const end = shot.events.find(ev => ev.p === 0 && ev.type !== 'pass' && ev.type !== 'pierce');
  const len = end && end.type !== 'range' ? clamp(Math.abs(end.x - x0), 0, reach) : reach;
  const through = shot.events.filter(ev => ev.p === 0 && ev.type === 'pierce' && ev.target).map(ev => ev.target);
  const x = x0 + dir * len;
  const y = standY(match, g, x, y0);
  g.x = x;
  g.y = y ?? y0;
  g.vx = 0;
  g.vy = 0;
  g.onGround = y !== null;
  if (y === null) {
    // 那一行沒有站得住的整數高度（坑裡的斜坡、坑邊）：照物理讓他落下去，再挪到落點旁邊站得住的地方（standSpot；找不到就停在物理落下的地方）。
    // 不能留在半空中 / 卡在坑邊：客戶端下一個回合照樣跑物理會讓他掉下去，伺服器卻要等下一波才動，兩邊的位置就不一樣了
    for (let i = 0; i < SETTLE_FRAMES && !g.onGround; i++) g.update(CONFIG.FIXED_DT, match.world);
    const spot = standSpot(match, g, g.x, g.y);
    if (spot) { g.x = spot.x; g.y = spot.y; g.vy = 0; g.onGround = true; }
  }
  shot.results = match.entities.map(e => e.toState());   // 守衛停下來的位置要進最後的校正
  return { ...info, ...(end && end.target ? { hit: end.target } : {}), ...(through.length ? { through: through.join(',') } : {}), shot };
}

// 盾擊：從盾牌往前推（facing = 舉盾時面向的那邊），打這一段上的每個玩家（盾擊範圍見 bashBand）
function bashStep(match, g, plan) {
  const W = CONFIG.WEAPONS.guardianBash;
  const facing = plan.facing === 1 || plan.facing === -1 ? plan.facing : g.facing;
  g.facing = facing;
  const p = bossProjectile(g, W, g.x + facing * g.hw, g.cy, facing * W.speed, 0);
  p.range = CONFIG.GUARDIAN.bashReach;
  p.ignore.add(g);
  return { action: 'bash', facing, cast: CONFIG.GUARDIAN.cast.bash, shot: bossShot(match, g, W, [p], facing) };
}

// 躍擊：跳到預定的落地點（那裡被炸掉了就找附近站得住的地方），落地往兩邊震開；兩道共用「打過誰」（每人最多挨一次）。
// 守衛在結算之前就放到落地點（一波的 actor = 落地點：客戶端播完跳躍的預兆，重播一開始就把他擺過去）。
// x0 / y0 = 起跳的地方（畫面照它畫跳躍的弧線）
function leapStep(match, g, plan) {
  const G = CONFIG.GUARDIAN;
  const W = CONFIG.WEAPONS.guardianLeap;
  const x0 = g.x, y0 = g.y;
  const spot = (Number.isFinite(plan.x) && Number.isFinite(plan.y) && standSpot(match, g, plan.x, plan.y)) || { x: x0, y: y0 };
  const dist = Math.hypot(spot.x - x0, spot.y - y0);
  const weapon = { ...W, damage: strikeDamage(W, dist) };
  if (spot.x !== x0) g.facing = spot.x > x0 ? 1 : -1;
  g.x = spot.x;
  g.y = spot.y;
  g.vx = 0;
  g.vy = 0;
  g.onGround = true;
  const band = leapBand(spot);
  const hitOnce = new Set([g]);
  const projs = [-1, 1].map(dir => {
    const p = bossProjectile(g, weapon, spot.x, band.y, dir * W.speed, 0);
    p.range = G.leapZone;
    p.ignore = hitOnce;
    return p;
  });
  return {
    action: 'leap', x0, y0, x: spot.x, y: spot.y, dmg: r1(weapon.damage), dist: Math.round(dist), cast: G.cast.leap,
    shot: bossShot(match, g, weapon, projs, g.facing),
  };
}

// 橫劈（躍擊落地之後的第二招）：從身體中間往兩邊各掃 slashReach（範圍見 slashBand）；兩道共用「打過誰」（每人最多挨一次），掃到的人流血（武器的 bleed）
function slashStep(match, g) {
  const W = CONFIG.WEAPONS.guardianSlash;
  const band = slashBand(g.x, g.cy);
  const hitOnce = new Set([g]);
  const projs = [-1, 1].map(dir => {
    const p = bossProjectile(g, W, g.x, band.y, dir * W.speed, 0);
    p.range = CONFIG.GUARDIAN.slashReach;
    p.ignore = hitOnce;
    return p;
  });
  return { action: 'slash', dmg: W.damage, cast: CONFIG.GUARDIAN.cast.slash, shot: bossShot(match, g, W, projs, g.facing) };
}

const r1 = (v) => Math.round(v * 10) / 10;
