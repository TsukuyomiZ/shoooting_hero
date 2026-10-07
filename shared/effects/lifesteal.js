// 傷害吸血：對敵人造成傷害的 N% 回復自己（不足 1 點的會累積，見 Match.heal）。
// 狀態列的「吸血」顯示實際的總數：吸血槽的所有效果加起來（含孤狼傳說），跟 Match 結算用的是同一個 Match.lifestealOf；
// 沒有這張牌、但總數 > 0（例如只有孤狼傳說而且正在生效）也會顯示
export const lifesteal = {
  id: 'lifesteal',
  keys: { lifestealPct: '傷害吸血：對敵人造成傷害的 N% 回復自己' },
  lifesteal: (e) => e.mods.lifestealPct,
  chipOrder: 40,
  chip(e, c) {
    const pct = c.match.lifestealOf(e);
    return pct > 0 ? [`吸血 ${pct}%`, '#fb7185'] : null;
  },
};
