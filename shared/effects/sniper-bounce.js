// 哈哈子彈：狙擊槍子彈碰到地形可以彈射 N 次（伺服器、瞄準預覽、AI 都照 weapons.js shotTraits）
export const sniperBounce = {
  id: 'sniperBounce',
  keys: { sniperBounce: { desc: '狙擊槍子彈碰到地形可以彈射 N 次', weapon: 'sniper' } },
  bounces: (e) => e.mods.sniperBounce || 0,
};
