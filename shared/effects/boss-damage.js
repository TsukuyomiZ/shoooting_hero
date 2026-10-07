// 弒神者：對首領傷害 +N%。不在武器傷害加成裡、另外乘上去（所以無差別轟炸也吃，見 Match.applyExplosion）
export const bossDamage = {
  id: 'bossDamage',
  keys: { bossDamagePct: '對首領傷害 +N%' },
  damageBoss: (e) => e.mods.bossDamagePct,
  chipOrder: 30,
  chip: (e) => (e.mods.bossDamagePct > 0 ? [`弒神 +${e.mods.bossDamagePct}%`, '#fbbf24'] : null),
};
