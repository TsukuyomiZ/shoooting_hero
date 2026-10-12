// 蹦蹦炸彈：大砲砲彈碰到地形可以彈射 N 次
export const cannonBounce = {
  id: 'cannonBounce',
  keys: { cannonBounce: { desc: '大砲砲彈碰到地形可以彈射 N 次', weapon: 'cannon' } },
  bounces: (e) => e.mods.cannonBounce || 0,
};
