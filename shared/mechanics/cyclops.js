import { cave } from './cave.js';
import { struckCave, passCave, caveSnapshot, restoreCave } from '../cave.js';
import { buildCyclops, planCyclopsNext, resolveCyclopsTurn, shakeStalactites, isShock } from '../cyclops.js';

// 地心探險（菁英關）的地圖機制：洞穴（鐘乳石、火把，沿用 mechanics/cave.js 的掛勾）+ 獨眼巨人（規則在 cyclops.js）。
// 狀態在 match.mechState（buildCyclops 建的：洞穴的狀態 + 預定的下一招 next）
export const cyclops = {
  ...cave,
  type: 'cyclops',

  // 巨人的血量照一般敵人的倍率（人數 × 關數）。回傳這一場的狀態
  build(match, { hpScale }) {
    return buildCyclops(match, hpScale);
  },

  // 先抽第一招（抽到猛捶，第一個玩家回合就標出會掉的鐘乳石與衝擊範圍）
  ready(match) {
    planCyclopsNext(match);
  },

  // 猛捶的衝擊一撞到人（第一幀就撞到）就把鐘乳石全部震下來；其他照洞穴的規則（打到 / 炸到鐘乳石、火把）
  struck(match, owner, at) {
    return isShock(at.weapon) ? shakeStalactites(match) : struckCave(match, owner, at);
  },

  // 猛捶的衝擊一出發（第一幀飛過去）就把鐘乳石全部震下來；其他照洞穴的規則（子彈從火把旁邊飛過去）
  passed(match, owner, seg) {
    return isShock(seg.weapon) ? shakeStalactites(match) : passCave(match, owner, seg);
  },

  // 輪到巨人：出預定的那一招並直接結算好
  aiTurn(match, actor) {
    return actor.part === 'cyclops' ? resolveCyclopsTurn(match, actor) : null;
  },

  // 洞穴的欄位（火把、掉下來的鐘乳石）+ 預定的下一招
  snapshot(match) {
    const S = match.mechState;
    return { ...caveSnapshot(match), cyclopsNext: S.next ? { ...S.next } : null };
  },

  restore(match, s) {
    restoreCave(match, s);
    if (s.cyclopsNext !== undefined) match.mechState.next = s.cyclopsNext ? { ...s.cyclopsNext } : null;
  },
};
