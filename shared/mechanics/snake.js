import { buildSnake, planSnakeNext, resolveSnakeTurn, snakeDrops, takeDrops, pickupAt, pickupAlong } from '../snake-boss.js';

// 叢林巨蟒的地圖機制：什麼時候、照什麼順序呼叫 snake-boss.js（規則本身在那裡）。
// 狀態在 match.snake；場上的蛇血在 match.items（Match 的快照照樣帶）。藤蔓是地形（level.vines），不在這裡
export const snake = {
  type: 'snake',

  // 巨蟒的頭：血量照 Boss 的倍率
  build(match, { bossScale }) {
    buildSnake(match, bossScale);
  },

  // 先抽第一招（抽到衝撞，第一個玩家回合就有警示帶）
  ready(match) {
    planSnakeNext(match);
  },

  // 位置回報：從上一個位置走到這裡的路上碰到蛇血就喝掉（在落水檢查之前：走進水裡的那一段也喝得到）
  moved(match, e, x0, y0, x, y) {
    return pickupAlong(match, e, x0, y0, x, y);
  },

  // 回合開始（中毒結算之後、回血之前）：人就站在蛇血上就喝掉（解毒、解開被鎖住的上限）
  turnStart(match, e, fx) {
    const drink = pickupAt(match, e);
    if (drink) fx.push(drink);
  },

  // 每個角色的回合結束（燃燒之後）：巨蟒被燒到跨過門檻也會掉蛇血
  turnEnd(match, e, fx) {
    const drops = snakeDrops(match);
    if (drops.length) fx.push({ type: 'drops', id: e.id, items: drops });
  },

  // 打到巨蟒跨過門檻：掉蛇血（會抽亂數，所以客戶端照事件帶的 drops 播，不自己抽）
  eventExtras(match) {
    const drops = snakeDrops(match);
    return drops.length ? { drops } : {};
  },

  replayEvent(match, ev) {
    return { items: takeDrops(match, ev.drops) };
  },

  // 輪到巨蟒：出預定的那一招並直接結算好
  aiTurn(match, actor) {
    return actor.part === 'snake' ? resolveSnakeTurn(match, actor) : null;
  },

  // 預定的下一招（衝撞要畫警示帶）
  snapshot(match) {
    return { snakeNext: match.snake.next ? { ...match.snake.next } : null };
  },

  restore(match, s) {
    if (s.snakeNext !== undefined) match.snake.next = s.snakeNext ? { ...s.snakeNext } : null;
  },
};
