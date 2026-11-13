// 血量上限 +N：這一關的上限 = 基礎血量 + N；拿到牌的當下同時補等量的血（run.js / versus.js 照上限多了多少補：不是治療，不吃治療效率）
export const maxHp = {
  id: 'maxHp',
  keys: { maxHp: '血量上限 +N（同時回 N 血）' },
  stat: (stats, P) => ['maxHp', Math.max(1, Math.round(P.hp + stats.maxHp))],
};
