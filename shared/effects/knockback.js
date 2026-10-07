// 擊退力道 +N%（無差別轟炸也吃）
export const knockback = {
  id: 'knockback',
  keys: { knockbackPct: '擊退力道 +N%' },
  knockback: (e) => e.mods.knockbackPct,
};
