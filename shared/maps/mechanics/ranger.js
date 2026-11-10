import {
  RANGER_ID, buildRanger, planRangerNext, resolveRangerTurn, resolveRangerInterject, syncTraps, touchTrap, hitTrap, startTurn, stepTurn, struggle,
  rangerSnapshot, restoreRanger,
} from '../ranger.js';

// 大樹遊俠（森林的菁英關）的地圖機制：遊俠與藤蔓陷阱的規則在 ranger.js。
// 狀態在 match.mechState（buildRanger 建的：{ def, next, perch, trapped, spawned, seq, lastHitBy, clock, pending }，欄位見 ranger.js 開頭）
export const ranger = {
  type: 'ranger',

  // 遊俠的血量照一般敵人的倍率（人數 × 關數）。回傳這一場的狀態
  build(match, { hpScale }) {
    return buildRanger(match, hpScale);
  },

  // 先抽第一招（貫穿箭要射誰，第一個玩家回合就標出來）
  ready(match) {
    planRangerNext(match);
  },

  // 一波結算完：被困住的人倒下了就放開（可以重複呼叫）
  cascade(match) {
    syncTraps(match);
  },

  // 玩家走路踩進陷阱：困住（裁判廣播成 pickup），扣血等下一個 hazardStep（踩死的話裁判才收得了這回合）
  moved(match, e, x0, y0, x, y) {
    const fx = touchTrap(match, e, x0, y0, x, y);
    if (fx) match.mechState.pending.push(e.id);
    return fx;
  },

  // 玩家的回合：被困住的人連打數重算、體力開始流失；回合中踩到陷阱的扣血
  hazardStart(match, e, now) {
    return startTurn(match, e, now);
  },
  hazardStep(match, now) {
    return stepTurn(match, now);
  },

  // 被困住的人連打 A / D 的其中一下
  struggle(match, e, dir, now) {
    return struggle(match, e, dir, now);
  },

  // 陷阱不管被什麼打到都只扣 1（遊俠自己的攻擊碰不到）
  absorbHit(match, e, hit) {
    return hitTrap(match, e, hit);
  },

  // 林間穿梭要躲誰：最後一個打到她的玩家（只算真的扣到血的）
  hurt(match, e, dmg, attacker) {
    if (e.id === RANGER_ID && dmg > 0 && attacker && attacker.team === 'players') match.mechState.lastHitBy = attacker.id;
  },

  // 這一下之後：被打倒的人放開
  eventExtras(match) {
    syncTraps(match);
    return {};
  },
  replayEvent(match) {
    syncTraps(match);
    return null;
  },

  // 輪到遊俠：預定的那一招（貫穿箭 / 箭雨）+（不會插話時順便放陷阱）+ 換樹枝，直接結算好（陷阱不會輪到）
  aiTurn(match, actor) {
    return actor.id === RANGER_ID ? resolveRangerTurn(match, actor) : null;
  },

  // 插話的是遊俠（3 人以上，連續 2 位玩家之後）：放藤蔓陷阱（2026-11-09 使用者）
  interjector(match) {
    const g = match.byId(RANGER_ID);
    return g && g.alive ? g : null;
  },
  interject(match, boss) {
    return resolveRangerInterject(match, boss);
  },

  snapshot(match) {
    return rangerSnapshot(match);
  },

  restore(match, s) {
    restoreRanger(match, s);
  },
};
