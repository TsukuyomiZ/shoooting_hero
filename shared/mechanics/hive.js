import { buildHive, hitHive, takeFreshBees, hatchBees, resolveBeeTurn } from '../hive.js';

// 小心擊發的地圖機制：什麼時候、照什麼順序呼叫 hive.js（規則本身在那裡）。狀態在 match.mechState（buildHive 建的）
export const hive = {
  type: 'hive',

  // 蜂巢固定血量；放出來的蜜蜂跟一般敵人一樣照人數、關數放大（所以給的是一般敵人的 hpScale，不是 Boss 的）。
  // 回傳蜂巢的狀態（match.mechState）
  build(match, { hpScale }) {
    return buildHive(match, hpScale);
  },

  // 蜂巢：只有玩家方打得到；不管什麼武器、直擊或波及都只扣 1，每次放出一隻蜜蜂。
  // 扣血、放蜜蜂要等這一下所有人都扣完血（later）：新的蜜蜂在這一下之後才出現，不會被這一下打到
  absorbHit(match, e, { attacker, friendly, damages, later }) {
    if (e.kind !== 'hive') return false;
    if (attacker && !friendly) {
      const entry = { id: e.id, dmg: 0, friendly, hive: true };
      damages.push(entry);
      later.push(() => { entry.dmg = hitHive(match, e); });
    }
    return true;
  },

  // 打到蜂巢飛出來的蜜蜂（客戶端在這一幀照出生資料建出來）
  eventExtras(match) {
    const bees = takeFreshBees(match);
    return bees.length ? { bees } : {};
  },

  replayEvent(match, ev) {
    return { bees: hatchBees(match, ev.bees) };
  },

  // 輪到蜜蜂：待機或衝刺螫擊，直接結算好
  aiTurn(match, actor) {
    return actor.kind === 'bee' ? resolveBeeTurn(match, actor) : null;
  },

  // 蜂巢放出來過的蜜蜂（重連時先照這個重建，再套狀態）
  snapshot(match) {
    return { bees: match.mechState.bees.map(b => ({ ...b })) };
  },

  restore(match, s) {
    hatchBees(match, s.bees);
  },
};
