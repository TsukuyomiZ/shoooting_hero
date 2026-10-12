// 狂戰之斧：自己的第 N 回合武器傷害 +rampDamagePct × N %，最多 rampDamageMaxPct（每關重算：turnCount 每關從 0 開始）
export function rampBonus(e) {
  const m = e.mods;
  if (!(m.rampDamagePct > 0)) return 0;
  const v = m.rampDamagePct * e.turnCount;
  return m.rampDamageMaxPct > 0 ? Math.min(m.rampDamageMaxPct, v) : v;
}

export const ramp = {
  id: 'ramp',
  keys: {
    rampDamagePct: '武器傷害每回合成長 N%（自己的第 1 回合 +N%、第 2 回合 +2N%…）',
    rampDamageMaxPct: '上面「每回合成長」的上限 %',
  },
  damage: (e) => rampBonus(e),
  chipOrder: 10,
  chip(e) {
    const bonus = rampBonus(e);
    return bonus > 0 ? [`狂戰 +${bonus}%`, '#f87171'] : null;
  },
};
