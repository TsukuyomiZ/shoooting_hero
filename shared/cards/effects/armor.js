// 受到的傷害 -N%。
// 狀態列的「減傷」顯示實際的總數：減傷槽的所有效果加起來（含團結力量大，照現在活著的隊友數），跟 Match 結算用的是同一個 Match.armorOf；
// 沒有這張牌、但總數 > 0（例如只有團結力量大而且有隊友）也會顯示
export const armor = {
  id: 'armor',
  keys: { armorPct: '受到的傷害 -N%' },
  armor: (e) => e.mods.armorPct,
  chipOrder: 50,
  chip(e, c) {
    const pct = c.match.armorOf(e);
    return pct > 0 ? [`減傷 ${pct}%`, '#93c5fd'] : null;
  },
};
