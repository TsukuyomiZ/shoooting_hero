// 著火（飛行物穿過場上的火）：共同設定，伺服器結算、客戶端重播都照這裡（2026-10-22 使用者：「子彈穿過火把會附上火的特效，
// 然後會有燃燒效果」「敵人射出的子彈穿過火把也會燃燒，這是共同設定」「之後可能有不同火把、或不是火把的其他物件產生著火的反應」）。
//
// - 火源（FireSource）：場上會讓飛行物著火的東西。{ x0, y0, x1, y1, r, burn }：一段線段加上半徑（膠囊形；一個點就是兩端一樣），
//   burn = 從它這裡著火之後，打中的人附加幾層燃燒。火源由地圖機制的 fireSources(match, owner) 給（見 shared/maps/mechanics/index.js），
//   例如洞穴的火把（shared/maps/cave.js 的 caveFireSources：亮著的火把，每支可以有自己的 burn）。
//   新的一種會讓子彈著火的東西 = 地圖機制回傳它的火源就好，這裡、Match、volley、畫面都不用改
// - 誰會著火：每一方都一樣（玩家、敵人）。哪些火源對誰算數由給火源的那一方決定（例如洞穴：熄著的火把只有玩家的子彈算——
//   玩家的子彈飛過去就把它點燃了，敵人的點不燃）。帶不了火的：武器寫 noFire（水、沿地面跑的震波、吼聲、蜘蛛女王的毒液）、
//   用身體撞過去的招式（bodyHit：飛行物就是攻擊者的身體）、半路才出現的飛行物（掉下來的鐘乳石、吊燈）
// - 穿過：飛行物這一幀走的那一段（飛過去：出發點到這一幀結束；撞到東西的那一幀：出發點到撞擊點）離火源的線段
//   r + 飛行物判定半徑以內
// - 火的大小：一次穿過好幾個火源取最大的；已經著火的只有穿過更大的火才換成那個大小（不疊加：同一支火把連著好幾幀都在旁邊也只算一次）
// - 時機與同步：飛過去的那一幀寫成 pass 事件、撞到東西那一幀穿過的在結算傷害之前就著火、寫在那個撞擊事件上（Match.resolvePass / resolveHit）。
//   事件帶 ignite = 新的燃燒層數；伺服器與客戶端套用事件時都照 applyIgnite 設飛行物的 fire（shared/physics/volley.js 的迴圈），
//   之後一直燒到這顆結束（彈射、穿透、迴力鏢回程都還燒著）
// - 燃燒：著火的飛行物打中的人，除了這一波本來的燃燒（燃燒子彈等牌）再加 fire 層（burnOf，Match.resolveHit → applyExplosion）。
//   燃燒只上對方的人（隊友不會燒到）、免疫異常狀態的不上；之後怎麼扣血、怎麼甩掉照燃燒狀態（CONFIG.EQUIP.burn）
//
// 畫面：著火的飛行物拖火舌（client/render.js 的 drawFire）、噴火星（GameView.fireEmbers）、著火的那一下竄出一團火（GameView.showShotEvent）

/**
 * @typedef {object} FireSource
 * @property {number} x0 @property {number} y0 @property {number} x1 @property {number} y1  線段的兩端（一個點 = 兩端一樣）
 * @property {number} r     離線段多近算穿過（再加上飛行物的判定半徑）
 * @property {number} burn  從這裡著火之後，打中的人附加幾層燃燒
 */

/** 這顆飛行物帶得了火嗎：武器寫 noFire、用身體撞的招式（bodyHit）、半路才出現的（p.added）都不行 */
export function canCatchFire(weapon, p) {
  return !!weapon && !weapon.noFire && !weapon.bodyHit && !p.added;
}

/**
 * 飛行物這一段路 seg（x0, y0 → x1, y1，r = 判定半徑）有沒有穿過火源 src：兩段線段的距離 ≤ src.r + seg.r
 * @param {{x0: number, y0: number, x1: number, y1: number, r?: number}} seg
 * @param {FireSource} src
 */
export function passesFire(seg, src) {
  const reach = src.r + (seg.r || 0);
  // 先用外框排除（每顆飛行物每一幀都會問）
  if (Math.max(seg.x0, seg.x1) < Math.min(src.x0, src.x1) - reach || Math.min(seg.x0, seg.x1) > Math.max(src.x0, src.x1) + reach) return false;
  if (Math.max(seg.y0, seg.y1) < Math.min(src.y0, src.y1) - reach || Math.min(seg.y0, seg.y1) > Math.max(src.y0, src.y1) + reach) return false;
  return segmentDistance(seg.x0, seg.y0, seg.x1, seg.y1, src.x0, src.y0, src.x1, src.y1) <= reach;
}

/**
 * 飛行物 p 這一段路 seg 穿過的火源讓它著火（或換成更大的火）：回傳新的燃燒層數；沒有著火 / 沒有比現在大 = 0。
 * 只問、不改：p.fire 由套用事件的地方設（applyIgnite），伺服器、客戶端同一個時間點
 * @param {import('../game/match.js').Match} match
 * @param {import('./entities.js').Entity|null} owner  射手（哪些火源算數由地圖機制照他決定）
 * @param {object} weapon  這顆飛行物的武器（CONFIG.WEAPONS 的那一項）
 * @param {{fire?: number, added?: boolean}} p
 * @param {{x0: number, y0: number, x1: number, y1: number, r?: number}} seg
 */
export function catchFire(match, owner, weapon, p, seg) {
  if (!canCatchFire(weapon, p)) return 0;
  const now = p.fire || 0;
  let best = now;
  for (const src of match.mechanic.fireSources(match, owner)) {
    if (src.burn > best && passesFire(seg, src)) best = src.burn;
  }
  return best > now ? best : 0;
}

/** 套用一個 Volley 事件帶的著火（伺服器與客戶端重播共用，見 shared/physics/volley.js） */
export function applyIgnite(p, ev) {
  if (ev.ignite > 0) p.fire = ev.ignite;
}

/** 這顆飛行物這一下打中的人要附加幾層燃燒：這一波本來的 burn + 它的火（ignite = 這一下才著火的，還沒套到 p.fire 上） */
export function burnOf(burn, p, ignite = 0) {
  return burn + (ignite > 0 ? ignite : p.fire || 0);
}

// 線段 a（ax0, ay0 → ax1, ay1）與線段 b 之間最近的距離：相交 = 0，不然是四個端點到另一段的距離取最小
function segmentDistance(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
  if (segmentsCross(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1)) return 0;
  return Math.min(
    pointToSegment(ax0, ay0, bx0, by0, bx1, by1), pointToSegment(ax1, ay1, bx0, by0, bx1, by1),
    pointToSegment(bx0, by0, ax0, ay0, ax1, ay1), pointToSegment(bx1, by1, ax0, ay0, ax1, ay1),
  );
}

function pointToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  const ex = px - (x0 + dx * t), ey = py - (y0 + dy * t);
  return Math.sqrt(ex * ex + ey * ey);
}

// 兩段線段交叉：兩段各自的兩端分在對方的兩側（只碰到端點、共線的不算，那些由 segmentDistance 的端點距離算到 0）
function segmentsCross(ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) {
  const d1 = cross(bx0, by0, bx1, by1, ax0, ay0), d2 = cross(bx0, by0, bx1, by1, ax1, ay1);
  const d3 = cross(ax0, ay0, ax1, ay1, bx0, by0), d4 = cross(ax0, ay0, ax1, ay1, bx1, by1);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

const cross = (x0, y0, x1, y1, px, py) => (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
