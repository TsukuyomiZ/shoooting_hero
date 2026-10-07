import { buildTree, planTreeNext, witherTree, hitMouth, reopenMouth, resolveTreeTurn, spawnTreant } from '../tree-boss.js';

// 古樹之庭的地圖機制：什麼時候、照什麼順序呼叫 tree-boss.js（規則本身在那裡）。狀態在 match.mechState（buildTree 建的）
export const tree = {
  type: 'tree',

  // 眼睛、嘴巴：血量照 Boss 的倍率。回傳古樹的狀態（match.mechState）
  build(match, { bossScale }) {
    return buildTree(match, bossScale);
  },

  // 大家站好之後先決定古樹的第一招（撞擊要照站位選平面）。客戶端用同一個 seed 也會算一次，之後被伺服器的快照蓋掉
  ready(match) {
    planTreeNext(match, match.byId('eye'));
  },

  // 古樹之眼倒下（包括回合結束被燒死）→ 嘴巴與樹妖一起枯萎。勝負判定前、一波結算完算擊殺前都會叫
  cascade(match) {
    witherTree(match);
  },

  // 古樹（眼睛）的回合結束：被打到閉上的嘴巴撐過了這個回合，再張開（已經分出勝負就不播）
  turnEnd(match, e, fx) {
    if (e.part === 'eye' && e.alive && !match.result()) reopenMouth(match, fx);
  },

  // 古樹之口：打不壞、不會燒，被敵方打到（直擊或波及）就閉上；不管誰打到都不進後面的傷害、燃燒、擊退
  absorbHit(match, e, { friendly, damages }) {
    if (!e.closeOnHit) return false;
    const entry = hitMouth(e, friendly);
    if (entry) damages.push(entry);
    return true;
  },

  // 輪到古樹之眼：出預定的招式並直接結算好（樹妖走一般 AI）
  aiTurn(match, actor) {
    return actor.part === 'eye' ? resolveTreeTurn(match, actor) : null;
  },

  // 召喚出來的樹妖（重連時先照這個重建，再套狀態）、預定的下一招（客戶端照這個畫撞擊的預告）
  snapshot(match) {
    const T = match.mechState;
    return {
      minions: T.minions.slice(),
      treeNext: T.next ? { ...T.next } : null,
    };
  },

  restore(match, s) {
    for (const spec of s.minions || []) if (!match.byId(spec.id)) spawnTreant(match, spec);
    if (s.treeNext !== undefined) match.mechState.next = s.treeNext ? { ...s.treeNext } : null;
  },
};
