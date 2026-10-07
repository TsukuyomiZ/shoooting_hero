// 血量上限 +N：這一關的上限 = 基礎血量 + N；拿到牌的當下同時回等量的血（加進立即回血 heal，跟回血的牌一起算）
export const maxHp = {
  id: 'maxHp',
  keys: { maxHp: '血量上限 +N（同時回 N 血）' },
  stat: (stats, P) => ['maxHp', Math.max(1, Math.round(P.hp + stats.maxHp))],
  applied(now, v) { now.heal += v; },   // 加上限的牌同時補等量的血
};
