// 傷害吸血：對敵人造成傷害的 N% 回復自己（不足 1 點的會累積，見 Match.heal）。
// 狀態列只顯示這張牌的 %（孤狼傳說的吸血另外顯示在孤狼那一格）
export const lifesteal = {
  id: 'lifesteal',
  keys: { lifestealPct: '傷害吸血：對敵人造成傷害的 N% 回復自己' },
  lifesteal: (e) => e.mods.lifestealPct,
  chipOrder: 40,
  chip: (e) => (e.mods.lifestealPct > 0 ? [`吸血 ${e.mods.lifestealPct}%`, '#fb7185'] : null),
};
