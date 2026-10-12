// 體型 +N%（碰撞框與外觀；角色那邊再夾在 0.5 ~ 2 倍，見 Entity）
export const size = {
  id: 'size',
  keys: { sizePct: '體型 +N%（越大越好被打中）' },
  stat: (stats) => ['size', 1 + stats.sizePct / 100],
};
