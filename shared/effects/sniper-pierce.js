// 高倍率望遠鏡：狙擊槍子彈穿透角色
export const sniperPierce = {
  id: 'sniperPierce',
  keys: { sniperPierce: { desc: '狙擊槍子彈穿透角色（填 1）', weapon: 'sniper' } },
  pierce: (e) => e.mods.sniperPierce > 0,
};
