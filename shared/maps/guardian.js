import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { clamp } from '../core/utils.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// 菁英關「大樹守衛」（森林）的守衛（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/guardian.js。這一場的狀態 match.mechState = { def, next }（next = 預定的下一招）。
//
// - 守衛站在大樹前面（level.mechanic.guardian），是有重力的一般角色：會被擊退、會掉進坑裡（地面底下是炸不壞的樹根，坑挖不到水裡）。
//   血量 GUARDIAN.hp，跟一般敵人一樣依人數、關數放大（菁英關不是 Boss 關：不算首領，弒神者對他沒用）。打倒他 = 過關。
// - 下一招是事先抽好的（next：開場一次、之後每次用掉就再抽，權重 GUARDIAN.weights），玩家回合畫面上會標出來：
//     衝鋒（charge）：衝向離他最近的玩家（出招當下），貼著地面直直衝過去，撞到第一個玩家就停在那裡（WEAPONS.guardianCharge）；
//                     前面的地勢高過他腳下 CLIMB px（樹根坡）或到了地圖邊也停（沒撞到人）。坑洞直接衝過去
//     舉盾（shield）：一抽到就舉盾、面向離他最近的玩家（next.facing），舉著的時候受到的傷害 -GUARDIAN.shieldCut%（mechanic 的 defenseMult）；
//                     輪到他時（這一輪的最後）盾擊盾牌前方的玩家（WEAPONS.guardianBash，往前推 GUARDIAN.bashReach），之後盾放下（除非又抽到舉盾）
//     躍擊（leap）：一抽到就鎖定離他最遠的玩家「當下」站的地方（next.x / next.y，警示範圍畫在那裡）；輪到他時跳到那裡，
//                   落地往兩邊震開（WEAPONS.guardianLeap，各 GUARDIAN.leapZone px）：還站在警示範圍裡的玩家受傷，提早走開就躲得掉
// - 衝鋒、躍擊的傷害看距離（出招當下他離目標 / 落地點多遠，見 strikeDamage），每一招用一份改了 damage 的武器結算（id 不變，客戶端照 id 畫）

export const GUARDIAN_ACTION_NAMES = {
  charge: '衝鋒',
  shield: '舉盾',
  bash: '盾擊',
  leap: '躍擊',
  idle: '戒備',
};

const CLIMB = 8;         // 衝鋒：前面的地勢比腳下高出這麼多 px 就撞停（地面的小起伏、坑的邊緣不算）
const LEAP_LIFT = 16;    // 躍擊的震波離地多高（判定半徑 hitRadius 往上下各涵蓋一段：落地點附近站在小坡、坑邊的人也打得到）
const SPOT_REACH = 60;   // 躍擊的落地點：鎖定的位置站不下守衛時，左右最多挪多遠找站得住的地方
const SPOT_RISE = 80;    // 同上，上下找多遠

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

// 衝鋒 / 躍擊的傷害：離 d px，near 以內是 damage、far 以上是 damageFar，中間照比例
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

// 躍擊要跳去哪裡：離守衛最遠的活著的玩家現在站的地方（一樣遠時排前面的先）。沒有人 = null
export function leapSpot(match, g) {
  let target = null, best = -1;
  for (const e of match.players) {
    if (!e.alive) continue;
    const d = (e.cx - g.cx) * (e.cx - g.cx) + (e.cy - g.cy) * (e.cy - g.cy);
    if (d > best) { best = d; target = e; }
  }
  if (!target) return null;
  const spot = standSpot(match, g, target.x, target.y);
  return spot && { x: spot.x, y: spot.y, targetId: target.id };
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

// 抽下一招（開場、每次出完招之後）。舉盾：馬上舉起來、面向離他最近的玩家；躍擊：鎖定最遠的玩家現在站的地方
export function planGuardianNext(match) {
  const S = guardianState(match);
  if (!S) return null;
  const g = match.byId('guardian');
  const W = CONFIG.GUARDIAN.weights;
  const action = weightedPick(match.rng, [['charge', W.charge], ['shield', W.shield], ['leap', W.leap]]) || 'charge';
  S.next = { action };
  if (!g || !g.alive) return S.next;
  if (action === 'shield') {
    const near = nearestPlayerAt(match, g.cx, g.cy);
    g.facing = near && near.x !== g.x ? (near.x > g.x ? 1 : -1) : g.facing;
    S.next = { action, facing: g.facing };
  } else if (action === 'leap') {
    const spot = leapSpot(match, g);
    S.next = spot ? { action, ...spot } : { action: 'charge' };
  }
  return S.next;
}

// 輪到守衛：出預定的那一招並直接結算好，再抽下一招。回傳 { steps: [招式], next }（格式同 Boss）
export function resolveGuardianTurn(match, g) {
  const S = guardianState(match);
  const plan = (S && S.next) || planGuardianNext(match) || { action: 'charge' };
  const step = plan.action === 'leap' ? leapStep(match, g, plan)
    : plan.action === 'shield' ? bashStep(match, g, plan)
      : chargeStep(match, g);
  planGuardianNext(match);
  // 下一招抽到舉盾會馬上轉向（面向最近的人）：最後的校正帶著新的方向，客戶端播完這一招就轉過去
  const res = step.shot || step.still;
  if (res) res.results = match.entities.map(e => e.toState());
  return { steps: [step], next: S && S.next ? { ...S.next } : null };
}

// 衝鋒往 dir 最多跑得了多遠（px，整數）：前面的地勢高過腳下 CLIMB px（樹根坡）、或到了地圖邊就停
export function chargeRun(match, g, dir) {
  const t = match.terrain;
  const lo = g.hw, hi = t.maxX - g.hw;
  let n = 0;
  for (let x = g.x + dir; x >= lo && x <= hi && !g.collides(t, x, g.y - CLIMB); x += dir) n++;
  return n;
}

// 衝鋒：飛行物就是守衛自己（從身體中間出發、判定半徑 = 半寬），撞到第一個玩家（照理是目標）就停；
// 沒撞到人就跑到 chargeRun 的盡頭（range）。跑完把守衛放到停下的地方（那一行站得住的高度，坑裡就站在坑底）
function chargeStep(match, g) {
  const G = CONFIG.GUARDIAN;
  const target = nearestPlayerAt(match, g.cx, g.cy);
  if (!target) return { action: 'idle', still: stillResult(match) };
  const W = CONFIG.WEAPONS.guardianCharge;
  const dir = target.x > g.x ? 1 : target.x < g.x ? -1 : g.facing;
  g.facing = dir;
  const dist = Math.hypot(target.cx - g.cx, target.cy - g.cy);
  const weapon = { ...W, damage: strikeDamage(W, dist) };
  const info = { action: 'charge', targetId: target.id, dmg: r1(weapon.damage), dist: Math.round(dist), cast: G.cast.charge };
  const run = chargeRun(match, g, dir);
  if (run < 1) return { ...info, blocked: true, still: stillResult(match) };   // 貼著樹根：衝不出去
  const x0 = g.x, y0 = g.y;
  const p = bossProjectile(g, weapon, x0, g.cy, dir * W.speed, 0);
  p.range = run;
  const shot = bossShot(match, g, weapon, [p], dir);
  const end = shot.events.find(ev => ev.p === 0 && ev.type !== 'pass');
  const len = end && end.type !== 'range' ? clamp(Math.abs(end.x - x0), 0, run) : run;
  const x = x0 + dir * len;
  const y = standY(match, g, x, y0);
  g.x = x;
  g.y = y ?? y0;
  g.vx = 0;
  g.vy = 0;
  g.onGround = y !== null;
  shot.results = match.entities.map(e => e.toState());   // 守衛停下來的位置要進最後的校正
  return { ...info, ...(end && end.target ? { hit: end.target } : {}), shot };
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

const r1 = (v) => Math.round(v * 10) / 10;
