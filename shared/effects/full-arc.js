// 全知之眼：拋射武器（大砲等）的瞄準預覽畫出完整拋物線直到落點（只影響預覽，見 weapons.js aimPreview）
export const fullArc = {
  id: 'fullArc',
  keys: { fullArc: '拋射武器（大砲等）的瞄準預覽畫出完整拋物線直到落點（填 1）' },
  previewFull: (e) => e.mods.fullArc > 0,
  chipOrder: 210,
  chip: (e) => (e.mods.fullArc > 0 ? ['全知之眼', '#a5f3fc'] : null),
};
