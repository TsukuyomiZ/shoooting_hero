// 跳躍力 +N%（最低 0.2 倍）
export const jumpSpeed = {
  id: 'jumpSpeed',
  keys: { jumpSpeedPct: '跳躍力 +N%' },
  stat: (stats, P) => ['jumpSpeed', P.jumpSpeed * Math.max(0.2, 1 + stats.jumpSpeedPct / 100)],
};
