import {
  buildTree, planTreeNext, witherTree, hitMouth, reopenMouth, resolveTreeTurn, spawnTreant,
  resolveTreeInterject, treeHazardStart, treeHazardStep, treeStruggle, syncBound,
} from '../tree-boss.js';

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

  // 古樹之眼倒下（包括回合結束被燒死）→ 嘴巴與樹妖一起枯萎；被綁著 / 被指名的人倒下了就放開。勝負判定前、一波結算完算擊殺前都會叫
  cascade(match) {
    witherTree(match);
    syncBound(match);
  },

  // 被指名的人回合開始：腳下冒出尖刺 / 藤蔓的那一塊；被綁著的人這回合先扣一次、連打數重算
  hazardStart(match, e, now) {
    return treeHazardStart(match, e, now);
  },
  hazardStep(match, now, flush, active) {
    return treeHazardStep(match, now, flush, active);
  },

  // 被藤蔓綁著的人連打 A / D 的其中一下
  struggle(match, e, dir) {
    return treeStruggle(match, e, dir);
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

  // 輪到古樹之眼：出預定的招式並直接結算好（樹妖走一般 AI），最後指名下一組
  aiTurn(match, actor) {
    return actor.part === 'eye' ? resolveTreeTurn(match, actor) : null;
  },

  // 插話的是古樹之眼（3 人以上，連續 2 位玩家之後）：指名剩下還沒輪到的人
  interjector(match) {
    const eye = match.byId('eye');
    return eye && eye.alive ? eye : null;
  },
  interject(match, boss, afterId) {
    return resolveTreeInterject(match, boss, afterId);
  },

  // 召喚出來的樹妖（重連時先照這個重建，再套狀態）、預定的下一招（客戶端照這個畫撞擊的預告）、被指名的人、被藤蔓綁著的人
  snapshot(match) {
    const T = match.mechState;
    const bound = {};
    for (const [pid, r] of Object.entries(T.bound)) bound[pid] = { count: r.count, last: r.last };
    return {
      minions: T.minions.slice(),
      treeNext: T.next ? { ...T.next } : null,
      treeMarks: { ...T.marks },
      treeBound: bound,
    };
  },

  restore(match, s) {
    const T = match.mechState;
    for (const spec of s.minions || []) if (!match.byId(spec.id)) spawnTreant(match, spec);
    if (s.treeNext !== undefined) T.next = s.treeNext ? { ...s.treeNext } : null;
    if (s.treeMarks !== undefined) T.marks = { ...(s.treeMarks || {}) };
    if (s.treeBound !== undefined) {
      T.bound = {};
      for (const [pid, r] of Object.entries(s.treeBound || {})) T.bound[pid] = { count: r.count | 0, last: r.last | 0 };
    }
    syncBound(match);
  },
};
