import {
  GAIA_ID, buildGaia, planGaiaNext, resolveGaiaTurn, pickFlowers, fogTurnStart, gaiaSnapshot, restoreGaia,
  gaiaOf, resolveGaiaInterject, gaiaHazardStart, gaiaHazardStep, syncGaiaMarks,
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

  // 輪到蓋亞：出招並直接結算好，最後指名下一組
  aiTurn(match, actor) {
    return actor.id === GAIA_ID ? resolveGaiaTurn(match, actor) : null;
  },

  // 被指名的人倒下了就清掉（勝負判定前、一波結算完都會叫）
  cascade(match) {
    syncGaiaMarks(match);
  },

  // 被指名的人回合開始：腳下那一片開始震（大地・脈動）/ 石頭手冒出來（大地之手・攫取），delay 秒後發動
  hazardStart(match, e, now) {
    return gaiaHazardStart(match, e, now);
  },
  hazardStep(match, now, flush, active) {
    return gaiaHazardStep(match, now, flush, active);
  },

  // 插話的是蓋亞（3 人以上，連續 2 位玩家之後）：指名剩下還沒輪到的人；祭壇淨化讓她暈眩、還沒暈完就不插話
  interjector(match) {
    const g = gaiaOf(match);
    return g && g.alive ? g : null;
  },
  interject(match, boss, afterId) {
    return resolveGaiaInterject(match, boss, afterId);
  },

  // 整包放在 gaia 一個欄位（預定的下一招、瘴氣、花、祭壇、暈眩、暴走、最後之光、被指名的人）
  snapshot(match) {
    return gaiaSnapshot(match);
  },

  restore(match, s) {
    restoreGaia(match, s);
  },
};
