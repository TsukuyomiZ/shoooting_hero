import {
  FAIRY_ID, buildFairy, blinkStep, resolveFairyTurn, hitFairy, hurtFairy, takeFx, applyFairyFx, syncFairy,
  charmTakeover, charmShot, endCharm, fairySnapshot, restoreFairy,
} from '../fairy.js';

// 調皮妖精（森林的菁英關）的地圖機制：妖精、分身、咬耳朵、魅惑的規則在 fairy.js。
// 狀態在 match.mechState（buildFairy 建的：{ def, whisper, lastWhisper, angry, revealed, charm, fx }，欄位見 fairy.js 開頭）
export const fairy = {
  type: 'fairy',

  // 妖精的血量照一般敵人的倍率（人數 × 關數）。回傳這一場的狀態
  build(match, { hpScale }) {
    return buildFairy(match, hpScale);
  },

  // 開場先閃現一次（分身出現、挑第一個咬耳朵的人）
  ready(match) {
    blinkStep(match);
  },

  // 一波結算完：本尊倒下 → 分身一起消失；被魅惑的人倒下 → 解除（可以重複呼叫）
  cascade(match) {
    syncFairy(match);
  },

  // 被魅惑的人的回合由遊戲接手；代打的玩家不知道哪個是本尊就隨機挑一個打
  takeover(match, e) {
    return charmTakeover(match, e);
  },
  aiShot(match, actor) {
    return charmShot(match, actor);
  },

  // 被魅惑、這回合已經被接手過的人解除（charmEnd 給客戶端）；這回合才被魅惑的人下一回合接手；本尊的燃燒層數放回去
  turnEnd(match, e, fx) {
    endCharm(match, e, fx);
  },

  // 分身由這裡處理（打破 → 爆炸、魅惑）；本尊被碰到 → 分身消失
  absorbHit(match, e, hit) {
    return hitFairy(match, e, hit);
  },

  // 本尊掉到 40% 以下 → 生氣
  hurt(match, e) {
    hurtFairy(match, e);
  },

  // 這一下的分身消失 / 爆炸 / 魅惑 / 生氣：附在事件上，客戶端照著套
  eventExtras(match) {
    return takeFx(match);
  },
  replayEvent(match, ev) {
    applyFairyFx(match, ev.fairy);
    syncFairy(match);
    return null;
  },

  // 輪到本尊：出一招 + 閃現，直接結算好（分身不會輪到）
  aiTurn(match, actor) {
    return actor.id === FAIRY_ID ? resolveFairyTurn(match, actor) : null;
  },

  snapshot(match) {
    return fairySnapshot(match);
  },

  restore(match, s) {
    restoreFairy(match, s);
  },
};
