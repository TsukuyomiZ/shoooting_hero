import {
  buildPrison, planExecNext, shieldsPrisoner, resolveExecTurn, resolveBeastTurn, isBeast, syncCage, prisonAttackMult, prisonDefense,
  struckPrison, stunExtras, replayPrison, prisonSnapshot, restorePrison,
} from '../prison.js';

// 處刑監獄（Boss 關）的地圖機制：處刑官、三隻猛獸、囚籠、天花板的吊燈（規則在 prison.js）。
// 狀態在 match.mechState（buildPrison 建的，欄位見 prison.js 開頭）
export const prison = {
  type: 'prison',

  // 處刑官的血量照 Boss 的倍率；之後放出來的猛獸、囚籠照一般敵人的倍率（記在狀態的 hpScale）。回傳這一場的狀態
  build(match, scales) {
    return buildPrison(match, scales);
  },

  // 先抽王的第一招（要丟菜刀 / 關誰，第一個玩家回合就標出來）
  ready(match) {
    planExecNext(match);
  },

  // 一波結算完：囚籠被打破、被關的人倒下 → 放出來（可以重複呼叫）
  cascade(match) {
    syncCage(match);
  },

  // 被關在籠子裡的人開火一定打在籠子上：那一下的爆炸傷不到他自己（不扣血、不擊退）
  absorbHit(match, e, { attacker }) {
    return shieldsPrisoner(e, attacker);
  },

  // 被皮鞭鞭過的猛獸下一次攻擊加成
  attackMult(match, attacker) {
    return prisonAttackMult(match, attacker);
  },

  // 哭的處刑官受到的傷害變多、護主的熊變少
  defenseMult(match, e) {
    return prisonDefense(match, e);
  },

  // 打到 / 炸到天花板的吊燈就掉下來（接著飛的 adds）
  struck(match, owner, at) {
    return struckPrison(match, owner, at);
  },

  // 掉下來的吊燈砸到的敵人暈眩一回合（事件的 stuns）
  eventExtras(match, info) {
    return stunExtras(match, info);
  },

  replayEvent(match, ev) {
    replayPrison(match, ev);
    return null;
  },

  // 輪到處刑官 / 猛獸：出招並直接結算好（囚籠不會輪到）
  aiTurn(match, actor) {
    if (actor.kind === 'executioner') return resolveExecTurn(match, actor);
    if (isBeast(actor)) return resolveBeastTurn(match, actor);
    return null;
  },

  // 牢房開了幾間、王在不在台上、心情、預定的下一招、放出來的角色、囚籠、暈眩、掉下來的吊燈…（全部包在 prison 一個欄位裡）
  snapshot(match) {
    return prisonSnapshot(match);
  },

  restore(match, s) {
    restorePrison(match, s);
  },
};
