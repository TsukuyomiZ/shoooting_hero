// 受到的傷害 -N%（狀態列只顯示這張牌的 %，團結力量大的減傷另外顯示在團結那一格）
export const armor = {
  id: 'armor',
  keys: { armorPct: '受到的傷害 -N%' },
  armor: (e) => e.mods.armorPct,
  chipOrder: 50,
  chip: (e) => (e.mods.armorPct > 0 ? [`減傷 ${e.mods.armorPct}%`, '#93c5fd'] : null),
};
