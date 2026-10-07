// 雲霧之瓶：在空中可以再跳 N 次。角色物理每一幀直接讀 mods.extraJumps（Entity.jump / update / grabVine / fallInWater），
// 這裡只有說明與狀態列
export const extraJumps = {
  id: 'extraJumps',
  keys: { extraJumps: '在空中可以再跳 N 次（1 = 二段跳；每次一樣消耗跳躍體力，落地補滿）' },
  chipOrder: 70,
  chip: (e) => (e.mods.extraJumps > 0 ? [e.mods.extraJumps > 1 ? `${e.mods.extraJumps + 1} 段跳` : '二段跳', '#7dd3fc'] : null),
};
