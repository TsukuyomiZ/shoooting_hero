// 火焰彈：武器擊中的敵人附加 N 層燃燒（燃燒是角色的狀態，結算在 Match.burnTick；爆炸波及的也算）
export const burnHit = {
  id: 'burnHit',
  keys: { burnStacks: '武器擊中的敵人附加 N 層燃燒' },
  burnOnHit: (e) => e.mods.burnStacks,
};
