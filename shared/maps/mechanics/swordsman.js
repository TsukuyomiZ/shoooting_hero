import { CONFIG } from '../../core/config.js';
import { groundRoam } from '../../ai/ai-move.js';
import { buildSwordsman, planSwordsmanNext, resolveSwordsmanTurn, swordsmanDefense, noteHit, castQi, startHazards, stepHazards, finishHazards, copyPlan } from '../swordsman.js';

// 流浪劍士（黃昏荒原的菁英關）的地圖機制：劍士的規則在 swordsman.js。
// 狀態在 match.mechState（buildSwordsman 建的：{ def, next, qi, parry, flying, roam }，next = 預定的下一招（一閃帶預警線）、qi = 浮著的劍氣、
// parry = 格擋架勢、flying = 正在飛的那一道劍氣、roam = 沿地面走的範圍（預定一閃時不走））
// 格擋架勢的複本（打中他的人 by 也複製一份）
const copyParry = (p) => (p ? { ...p, by: Array.isArray(p.by) ? p.by.slice() : [] } : null);

export const swordsman = {
  type: 'swordsman',

  // 劍士的血量照一般敵人的倍率（人數 × 關數）。回傳這一場的狀態。
  // 劍士每回合出招前沿著地面走一段（SWORDSMAN.walk；左右範圍 def.roam，Match.planAiTurn 照 roam 走，見 ai-move.js）；
  // 範圍也記在狀態上（預定一閃的時候 planSwordsmanNext 把劍士身上的拿掉、之後再放回去）
  build(match, { hpScale }) {
    const state = buildSwordsman(match, hpScale);
    const g = match.byId('swordsman');
    const R = match.level.mechanic.roam;
    if (g) g.roam = state.roam = { ...groundRoam(CONFIG.SWORDSMAN.walk), ...(R ? { x0: R.x0, x1: R.x1 } : {}) };
    return state;
  },

  // 開場：先揮出第一輪劍氣（浮在右邊；這一輪不出在地面那一排），再抽第一招（一閃：第一個玩家回合就擺出拔刀的架勢、對每個人劃好預警線）
  ready(match) {
    castQi(match, { opening: true });
    planSwordsmanNext(match);
  },

  // 擺著格擋架勢的劍士受到的傷害變少
  defenseMult(match, e) {
    return swordsmanDefense(match, e);
  },

  // 擺著格擋架勢的劍士被打中：記次數（夠了下一回合先反擊）
  hurt(match, e, dmg, attacker) {
    noteHit(match, e, dmg, attacker);
  },

  // 玩家的回合開始：最前面那一道劍氣出發；回合中照時間推進、碰到人就打；回合收尾：劍氣剩下的一段一口氣掃完
  hazardStart(match, e, now) {
    return startHazards(match, e, now);
  },
  hazardStep(match, now, flush) {
    return stepHazards(match, now, flush);
  },
  hazardFinish(match) {
    return finishHazards(match);
  },

  // 輪到劍士：（反擊的一閃 +）預定的那一招（一閃 / 格擋 / 拔刀），直接結算好
  aiTurn(match, actor) {
    return actor.part === 'swordsman' ? resolveSwordsmanTurn(match, actor) : null;
  },

  // 預定的下一招（一閃帶預警線 facing / targetIds / lines）、浮著的劍氣（第幾排，照出發的順序）、格擋架勢（{ hits, need, by } 或 null；by = 打中他的玩家，反擊打第一個）、
  // 正在飛的劍氣（{ row, x, speed }：x = 伺服器上次判定到的地方，重連的畫面從那裡接著飛；沒有 = null）
  snapshot(match) {
    const S = match.mechState;
    const F = S.flying;
    return {
      swordsmanNext: copyPlan(S.next),
      swordsmanQi: S.qi.slice(),
      swordsmanParry: copyParry(S.parry),
      swordsmanFlying: F ? { row: F.row, x: F.x, speed: F.speed } : null,
    };
  },

  // 客戶端（重連、開場）：正在飛的劍氣只留畫面要的（判定只在伺服器）
  restore(match, s) {
    const S = match.mechState;
    if (s.swordsmanNext !== undefined) S.next = copyPlan(s.swordsmanNext);
    if (Array.isArray(s.swordsmanQi)) S.qi = s.swordsmanQi.slice();
    if (s.swordsmanParry !== undefined) S.parry = copyParry(s.swordsmanParry);
    if (s.swordsmanFlying !== undefined) S.flying = s.swordsmanFlying ? { ...s.swordsmanFlying } : null;
  },
};
