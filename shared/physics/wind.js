import { CONFIG } from '../core/config.js';

// 風向（共用機制，不屬於哪一張地圖；2026-10-20 跟著菁英關「天狗」做的）。
// 關卡寫 wind（true，或 { max } 改上限）就有風：每個回合開始時（裁判的 nextTurn，玩家、敵人的回合都算）重抽一次，
// 是 -max ~ +max 的整數（負的往左吹、正的往右吹、0 = 無風；伺服器抽，跟著 turn 訊息與快照給客戶端）。
// 這個回合射出去的飛行物多一個水平加速度（windAccel，px/s²）：飛行物建出來的時候照那時候的風算好、放在它身上（p.wind），
// 伺服器結算、客戶端重播（shot.projectiles 帶 wind）、瞄準預覽、AI 試射都照它飛，所以兩邊一樣、預覽也跟著彎。
// 吃不吃風看武器：windFactor（沒寫 = 有重力的拋物線武器吃 1、直線的（重力 0）不吃）。半路才出現的飛行物（掉下來的鐘乳石）不吃風。
// 地圖機制自己先解好軌跡的招式（例如獨眼巨人一定砸中的巨石）：要嘛照 match.wind 解（試射的飛行物也設 p.wind），要嘛武器寫 windFactor: 0

/** 這一關的風最大幾級：關卡沒寫 wind = 0（沒有風） */
export function windMaxOf(level) {
  const w = level && level.wind;
  if (!w) return 0;
  return Math.max(0, Math.round(w === true ? CONFIG.WIND.max : (w.max ?? CONFIG.WIND.max)));
}

/** 抽這個回合的風：-max ~ +max 的整數（rng.int 包含兩端）；沒有風 = 0、不抽亂數 */
export function rollWind(rng, max) {
  return max > 0 ? rng.int(-max, max) : 0;
}

/** 風對這把武器的飛行物的水平加速度（px/s²）：風的級數 × WIND.accel × windFactor */
export function windAccel(wind, weapon) {
  if (!wind || !weapon) return 0;
  const f = weapon.windFactor ?? (weapon.gravity > 0 ? 1 : 0);
  return wind * CONFIG.WIND.accel * f;
}
