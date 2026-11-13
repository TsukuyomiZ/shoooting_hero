// 治療效率（生命增幅器、樂觀）：受到的回血 +N%——吸血、治療（急救槍、恩賜之杖、選牌時的回血牌、地圖上的回血，例如大地祭壇的淨化）都算；
// 過關回血（關卡回復）、加上限同時補的血、下一關復活時的血不算（2026-11-10 使用者：「回血效率不會被關卡回復影響，只影響受到吸血、治療的」）。
// 戰鬥中照 Match.heal、選牌時照 run.js / versus.js 的 pickHeal 乘上去（兩邊都用 healMult 算倍率）
export const healBoost = {
  id: 'healBoost',
  keys: { healRecvPct: '受到的回血 +N%（吸血、治療都算；過關回血不算）' },
  healing: (e) => e.mods.healRecvPct,
  chipOrder: 340,
  // 狀態列顯示治療效率的總數（healing 槽所有效果加起來，跟結算用的同一個 Match.healingOf）
  chip(e, c) {
    const pct = c.match.healingOf(e);
    return pct > 0 ? [`治療效率 +${pct}%`, '#86efac'] : null;
  },
};
