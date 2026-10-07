// 大砲傷害 +N%（weapon: 'cannon'：只在用大砲時算，見 index.js）
export const cannonDamage = {
  id: 'cannonDamage',
  keys: { cannonDamagePct: { desc: '大砲傷害 +N%', weapon: 'cannon' } },
  damage: (e) => e.mods.cannonDamagePct,
};
