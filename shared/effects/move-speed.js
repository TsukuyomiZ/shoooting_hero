// 移動速度 +N%（最慢 0.2 倍）
export const moveSpeed = {
  id: 'moveSpeed',
  keys: { moveSpeedPct: '移動速度 +N%' },
  stat: (stats, P) => ['moveSpeed', P.moveSpeed * Math.max(0.2, 1 + stats.moveSpeedPct / 100)],
};
