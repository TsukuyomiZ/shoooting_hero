import {
  GAIA_ID, buildGaia, planGaiaNext, resolveGaiaTurn, pickFlowers, fogTurnStart, gaiaSnapshot, restoreGaia,
} from '../gaia.js';

// 大地祭壇（莫利亞森林的主題王）的地圖機制：大地之母・蓋亞的臉、瘴氣、自然之花與祭壇、最後之光 → 誅滅（規則在 gaia.js）。
// 狀態在 match.mechState（buildGaia 建的，欄位見 gaia.js 開頭）
export const gaia = {
  type: 'gaia',

  // 臉的血量照 Boss 的倍率（第 11 關 ×1.9、人數）。回傳這一場的狀態
  build(match, scales) {
    return buildGaia(match, scales);
  },

  // 先抽第一招（天罰打哪一邊、同罰鎖定誰，第一個玩家回合就標出來）
  ready(match) {
    planGaiaNext(match);
  },

  // 玩家走路碰到自然之花：撿起來飛進祭壇（收滿了祭壇淨化 / 最後之光收齊了張開護盾）。裁判廣播成 pickup
  moved(match, e, x0, y0, x, y) {
    return pickFlowers(match, e, x0, y0, x, y);
  },

  // 玩家的回合開始（中毒結算之後）：瘴氣還在就加中毒層數（記進 turn.start 的 fx，客戶端照它飄字）
  turnStart(match, e, fx) {
    fogTurnStart(match, e, fx);
  },

  // 輪到蓋亞：出招並直接結算好
  aiTurn(match, actor) {
    return actor.id === GAIA_ID ? resolveGaiaTurn(match, actor) : null;
  },

  // 整包放在 gaia 一個欄位（預定的下一招、瘴氣、花、祭壇、暈眩、暴走、最後之光）
  snapshot(match) {
    return gaiaSnapshot(match);
  },

  restore(match, s) {
    restoreGaia(match, s);
  },
};
