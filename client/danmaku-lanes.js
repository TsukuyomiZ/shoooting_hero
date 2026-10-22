import { CONFIG } from '../shared/core/config.js';

// 彈幕的三排軌道（client/stickers.js 用；反應貼圖和聊天的字共用）：每一排在哪裡、下一則放哪一排、什麼時候放。
// 純計算、不碰 DOM（Node 裡測得到，見 test/danmaku.js）。時間是 ms、寬度是 px（同一個畫面寬 W）。
// 三排都擠在頂部 HUD（左上回合資訊含狂熱標籤、上方武器 / 風向列）的正下方，不往下佔到中下段的戰場；
// 一則彈幕的高度寫在 css/style.css 的 .dm（比 LANE_PITCH 矮一點，排跟排之間留縫）
export const LANES = 3;
export const LANE_TOP = 112;      // 第一排的上緣（世界座標）
export const LANE_PITCH = 40;     // 排距（世界座標 px）

// 第 i 排的上緣，換成圖層高度的百分比（圖層跟 canvas 一樣是 4:3）
export const laneTopPct = (i) => (LANE_TOP + i * LANE_PITCH) / CONFIG.WORLD_H * 100;

// 每一則從畫面右邊外面飄到左邊外面，固定 flyMs 走完 W + w，所以越長的跑越快。
// 一排只要跟它最後放的那則 last = { at, w, v }（出場時間、寬、速度 px/ms）比，新的一則（寬 w）最早什麼時候能放進這排：
//   進場：前一則的尾巴已經離開右邊 gap 以上
//   不追撞：新的這則比較長（比較快）時，前一則完全飄出左邊之前，兩則之間一直留著 gap 以上
// 這排還沒放過 → -Infinity
export function laneReadyAt(last, w, W, flyMs, gap) {
  if (!last) return -Infinity;
  const enter = last.at + (last.w + gap) / last.v;
  const v = (W + w) / flyMs;
  const noCatch = last.at + flyMs - (W - gap) / v;
  return Math.max(enter, noCatch);
}

// lanes：每一排最後放的那則（沒放過是 null）。回傳 { lane, at }：最早能放的那一排與時間（不早於 now）；
// 好幾排現在都能放 → 挑最上面那排（下面的排只在上面忙的時候才用）
export function pickLane(lanes, now, w, W, flyMs, gap) {
  let lane = 0, at = Infinity;
  lanes.forEach((last, i) => {
    const t = Math.max(now, laneReadyAt(last, w, W, flyMs, gap));
    if (t < at) { lane = i; at = t; }
  });
  return { lane, at };
}
