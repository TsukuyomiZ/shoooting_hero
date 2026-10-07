// 狙擊槍傷害 +N%（只在用狙擊槍時算）
export const sniperDamage = {
  id: 'sniperDamage',
  keys: { sniperDamagePct: { desc: '狙擊槍傷害 +N%', weapon: 'sniper' } },
  damage: (e) => e.mods.sniperDamagePct,
};
