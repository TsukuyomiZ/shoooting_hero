// 大砲爆炸半徑 +N%（挖地形與波及範圍都算；AI 判斷會不會炸到隊友 / 蜂巢也照這個，見 weapons.js blastRadius）
export const radius = {
  id: 'radius',
  keys: { radiusPct: { desc: '大砲爆炸半徑 +N%', weapon: 'cannon' } },
  // || 0：mods 不完整的物件（不是 Entity 的射手）當 0，同以前 AI 的寫法（Entity 的 mods 一定有這個 key）
  radius: (e) => e.mods.radiusPct || 0,
};
