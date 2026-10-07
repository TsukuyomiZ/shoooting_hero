// 穿甲燃燒彈：只有大砲擊中的敵人附加 N 層燃燒
export const cannonBurn = {
  id: 'cannonBurn',
  keys: { cannonBurnStacks: { desc: '大砲擊中的敵人附加 N 層燃燒', weapon: 'cannon' } },
  burnOnHit: (e) => e.mods.cannonBurnStacks,
};
