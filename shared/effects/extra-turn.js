import { CONFIG } from '../config.js';

// 時間扭曲：普通回合結束時冷卻好了就給一個額外回合（fx 的 extraTurn，裁判照 again 讓同一位再來一回合），
// 之後冷卻 EQUIP.extraTurnCooldown 個普通回合。額外回合（isExtra）本身不算冷卻、也不能再接額外回合；
// 這一發已經分出勝負就不給（不會有下一回合）。冷卻是這個效果自己的角色狀態 extraTurnCd（同步欄位 xcd）
export const extraTurn = {
  id: 'extraTurn',
  keys: { extraTurn: `自己的回合結束後再獲得一個額外回合（填 1；之後冷卻 ${CONFIG.EQUIP.extraTurnCooldown} 個回合）` },
  state: { extraTurnCd: { wire: 'xcd', after: 'turns' } },
  turnEnd(match, e, fx, isExtra) {
    if (e.mods.extraTurn > 0 && e.alive && !isExtra && !match.result()) {
      if (e.extraTurnCd > 0) {
        e.extraTurnCd--;
      } else {
        e.extraTurnCd = CONFIG.EQUIP.extraTurnCooldown;
        fx.push({ type: 'extraTurn', id: e.id });
      }
    }
  },
  again: (fx) => fx.type === 'extraTurn',
  chipOrder: 80,
  chip: (e) => (e.mods.extraTurn > 0 ? [e.extraTurnCd > 0 ? `時間扭曲 冷卻 ${e.extraTurnCd}` : '時間扭曲 就緒', '#c4b5fd'] : null),
  turnFx(fx, e) {
    if (fx.type !== 'extraTurn') return null;
    return [
      ['banner', `${e.name} 的時間扭曲：再來一回合！`, '#c4b5fd'],
      ['float', fx.id, '額外回合', '#c4b5fd'],
      ['particles', fx.id, 16, { speed: 120, life: 0.7, size: 3, color: '#c4b5fd', gravity: -30 }],
    ];
  },
};
