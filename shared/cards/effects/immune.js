// 金剛不壞：免疫所有異常狀態——被打中時該上的燃燒、中毒、流血都不上（Match.applyExplosion 的第 3 步問 immune 槽，
// 擋下的那一筆記 immune，客戶端飄「免疫」）。傷害、擊退照常
export const immune = {
  id: 'immune',
  keys: { statusImmune: '免疫所有異常狀態（燃燒、中毒、流血；填 1）' },
  immune: (e) => e.mods.statusImmune > 0,
  chipOrder: 320,
  chip: (e) => (e.mods.statusImmune > 0 ? ['免疫異常', '#e2e8f0'] : null),
};
