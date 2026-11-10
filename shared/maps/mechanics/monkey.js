import {
  MONKEY_ID, buildMonkey, snatch, hitMonkey, hurtMonkey, takeFx, blastPeels, applyMonkeyEvent, resolveMonkeyTurn, touchPeel,
  monkeySnapshot, restoreMonkey,
} from '../monkey.js';

// 頑皮猴王（森林的菁英關）的地圖機制：猴王與香蕉皮的規則在 monkey.js。
// 狀態在 match.mechState（buildMonkey 建的：{ def, perch, held, peels, seq, angry, fx }，欄位見 monkey.js 開頭）
export const monkey = {
  type: 'monkey',

  // 猴王的血量照一般敵人的倍率（人數 × 關數）。回傳這一場的狀態
  build(match, { hpScale }) {
    return buildMonkey(match, hpScale);
  },

  // 玩家走路踩到香蕉皮：滑出去（裁判廣播成 pickup）
  moved(match, e, x0, y0, x, y) {
    return touchPeel(match, e, x0, y0, x, y);
  },

  // 從猴王身邊飛過去的砲彈被他接住（stop：飛行物到此為止）
  passed(match, owner, seg) {
    return snatch(match, owner, seg);
  },

  // 爆炸炸到的香蕉皮消失
  struck(match, owner, at) {
    return blastPeels(match, at);
  },

  // 打中拿著砲彈的猴王：手上的砲彈全部被打掉（不爆炸；他照一般的扣血）
  absorbHit(match, e, hit) {
    return hitMonkey(match, e, hit);
  },

  // 掉到 40% 以下 → 生氣（接住範圍變大）
  hurt(match, e) {
    hurtMonkey(match, e);
  },

  // 這一下手上的砲彈被打掉 / 生氣：附在事件上，客戶端照著套（接住、炸掉香蕉皮在 passed / struck 就附上了）
  eventExtras(match) {
    return takeFx(match);
  },
  replayEvent(match, ev) {
    applyMonkeyEvent(match, ev);
    return null;
  },

  // 輪到猴王：丟回去、椰子 / 香蕉皮、盪樹枝，直接結算好
  aiTurn(match, actor) {
    return actor.id === MONKEY_ID ? resolveMonkeyTurn(match, actor) : null;
  },

  snapshot(match) {
    return monkeySnapshot(match);
  },

  restore(match, s) {
    restoreMonkey(match, s);
  },
};
