import { buildCave, struckCave, passCave, touchTorch, replayCave, caveSnapshot, restoreCave } from '../cave.js';

// 洞穴（岩穴）的地圖機制：什麼時候、照什麼順序呼叫 cave.js（規則本身在那裡）。狀態在 match.mechState（buildCave 建的）。
// 鐘乳石是地形（level.stalactites），掉下來的時機在這裡；火把亮了沒也是這裡的狀態，照明怎麼畫在 client/map-views/cave.js
export const cave = {
  type: 'cave',

  build(match) {
    return buildCave(match);
  },

  // 打到 / 炸到鐘乳石就掉下來（接著飛的 adds）、玩家方打在火把旁邊就點燃
  struck(match, owner, at) {
    return struckCave(match, owner, at);
  },

  // 玩家方的飛行物從火把旁邊飛過去就點燃（寫成 pass 事件）
  passed(match, owner, seg) {
    return passCave(match, owner, seg);
  },

  // 玩家走過去碰到火把就點燃（裁判廣播成 pickup）
  moved(match, e, x0, y0, x, y) {
    return touchTorch(match, e, x0, y0, x, y);
  },

  replayEvent(match, ev) {
    replayCave(match, ev);
    return null;
  },

  snapshot(match) {
    return caveSnapshot(match);
  },

  restore(match, s) {
    restoreCave(match, s);
  },
};
