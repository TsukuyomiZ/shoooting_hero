import { buildGuardian, planGuardianNext, resolveGuardianTurn, guardianDefense } from '../guardian.js';

// 大樹守衛（森林的菁英關）的地圖機制：守衛的規則在 guardian.js。
// 狀態在 match.mechState（buildGuardian 建的：{ def, next }，next = 預定的下一招）
export const guardian = {
  type: 'guardian',

  // 守衛的血量照一般敵人的倍率（人數 × 關數）。回傳這一場的狀態
  build(match, { hpScale }) {
    return buildGuardian(match, hpScale);
  },

  // 先抽第一招（舉盾：一開場就舉著；躍擊：第一個玩家回合就標出落地的範圍）
  ready(match) {
    planGuardianNext(match);
  },

  // 舉盾的守衛受到的傷害變少
  defenseMult(match, e) {
    return guardianDefense(match, e);
  },

  // 輪到守衛：出預定的那一招並直接結算好
  aiTurn(match, actor) {
    return actor.part === 'guardian' ? resolveGuardianTurn(match, actor) : null;
  },

  // 預定的下一招（舉盾帶面向哪邊、躍擊帶落地點）
  snapshot(match) {
    const S = match.mechState;
    return { guardianNext: S.next ? { ...S.next } : null };
  },

  restore(match, s) {
    if (s.guardianNext !== undefined) match.mechState.next = s.guardianNext ? { ...s.guardianNext } : null;
  },
};
