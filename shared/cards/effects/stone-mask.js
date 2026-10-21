// 石假面：自己的回合結束時（額外回合也算）扣目前血量的 maskDrainPct%（四捨五入），最多扣到剩 1 血、不會因此倒下。
// 直接扣（不吃狂熱、減傷，無敵也擋不住）、算進承受傷害，但不算「受到攻擊」（被虐體質不疊層）。吸血另外由牌上的 lifestealPct 給。
// fx 的 stoneMask 給客戶端飄字（turn.end 的紀錄也有）
export const stoneMask = {
  id: 'stoneMask',
  keys: { maskDrainPct: '自己的回合結束時扣目前血量的 N%（不會因此倒下）' },
  turnEnd(match, e, fx) {
    const pct = e.mods.maskDrainPct;
    if (!(pct > 0) || !e.alive) return;
    const n = Math.min(e.hp - 1, Math.round(e.hp * pct / 100));
    if (n > 0) {
      e.takeDamage(n);
      fx.push({ type: 'stoneMask', id: e.id, dmg: n });
    }
  },
  chipOrder: 330,
  chip: (e) => (e.mods.maskDrainPct > 0 ? [`石假面 每回合 -${e.mods.maskDrainPct}%`, '#a8a29e'] : null),
  turnFx(fx) {
    if (fx.type !== 'stoneMask') return null;
    return [
      ['float', fx.id, `-${fx.dmg} 石假面`, '#a8a29e'],
      ['particles', fx.id, 10, { speed: 70, life: 0.6, size: 3, color: '#78716c', gravity: 300 }],
    ];
  },
};
