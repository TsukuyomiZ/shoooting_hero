import { CONFIG } from '../config.js';

// 神佑之石：每過 EQUIP.shieldEveryTurns 個自己的回合（回合結束時），全隊活著的人獲得 N 次無敵。
// 無敵（shield）是角色的狀態：擋下一次傷害，見 Match.applyExplosion
export const teamShield = {
  id: 'teamShield',
  keys: { teamShield: `每過 ${CONFIG.EQUIP.shieldEveryTurns} 個自己的回合，全隊獲得 N 次無敵（擋下一次傷害）` },
  turnEnd(match, e, fx) {
    if (e.mods.teamShield > 0 && e.turnCount % CONFIG.EQUIP.shieldEveryTurns === 0) {
      const ids = [];
      for (const f of match.entities) {
        if (f.alive && f.team === e.team) { f.shield = Math.max(f.shield, e.mods.teamShield); ids.push(f.id); }
      }
      fx.push({ type: 'shield', id: e.id, ids });
    }
  },
  chipOrder: 100,
  chip: (e) => (e.mods.teamShield > 0
    ? [`神佑 ${e.turnCount % CONFIG.EQUIP.shieldEveryTurns}/${CONFIG.EQUIP.shieldEveryTurns}`, '#fde68a'] : null),
  turnFx(fx, e) {
    if (fx.type !== 'shield') return null;
    const ops = [['banner', `${e.name} 的神佑之石：全隊無敵一次`, '#fde68a']];
    for (const id of fx.ids) {
      ops.push(['float', id, '神佑！', '#fde68a'], ['particles', id, 14, { speed: 110, life: 0.6, size: 3, color: '#fde68a', gravity: -40 }]);
    }
    return ops;
  },
};
