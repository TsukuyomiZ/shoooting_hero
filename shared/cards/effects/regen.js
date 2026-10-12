// 恩賜之杖：自己的回合開始時回復上限 N% 的血（中毒結算、地圖機制之後；不足 1 點的會累積，見 Match.heal）。
// fx 的 heal 是一般的回血飄字（客戶端照 amount 飄 +N）
export const regen = {
  id: 'regen',
  keys: { regenPct: '自己的回合開始時回復上限 N% 的血' },
  turnStart(match, e, fx) {
    if (e.alive && e.mods.regenPct > 0) {
      const n = match.heal(e, e.maxHp * e.mods.regenPct / 100);
      if (n > 0) fx.push({ type: 'heal', id: e.id, amount: n });
    }
  },
  chipOrder: 60,
  chip: (e) => (e.mods.regenPct > 0 ? [`每回合回血 ${e.mods.regenPct}%`, '#4ade80'] : null),
};
