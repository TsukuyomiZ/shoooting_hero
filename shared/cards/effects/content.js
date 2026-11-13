// 知足：每受到一次治療（急救槍、恩賜之杖、地圖上的回血…真的回到血才算；吸血不算，見 Match.heal 的 kind），武器傷害 +healedDamagePct%，
// 最多 +healedDamageMaxPct%（2026-11-10 使用者）。層數是這個效果自己的角色狀態 healedStacks（同步欄位 hl），每關從 0 開始（同被虐體質）
export const content = {
  id: 'content',
  keys: {
    healedDamagePct: '每受到一次治療（吸血不算），武器傷害 +N%（每關重算）',
    healedDamageMaxPct: '上面「受到治療」加成的上限 %',
  },
  state: { healedStacks: { wire: 'hl', after: 'vn' } },
  damageState: (e) => Math.min(e.mods.healedDamageMaxPct, e.healedStacks * e.mods.healedDamagePct),
  // 層數只疊到剛好達到上限（不會一直往上加）
  onHealed(match, e) {
    const m = e.mods;
    if (m.healedDamagePct > 0) e.healedStacks = Math.min(Math.max(0, Math.ceil(m.healedDamageMaxPct / m.healedDamagePct)), e.healedStacks + 1);
  },
  // 開火紀錄：跟磨刀霍霍 / 越戰越強 / 被虐體質記在同一組 stacks
  shotLog: { group: 'stacks', field: 'healed', value: (e) => e.healedStacks, on: (e) => e.mods.healedDamagePct > 0 },
  chipOrder: 350,
  chip: (e) => (e.mods.healedDamagePct > 0
    ? [`知足 +${Math.min(e.mods.healedDamageMaxPct, e.healedStacks * e.mods.healedDamagePct)}%`, '#86efac'] : null),
  // 層數多了（被治療到）：在他身上飄一下現在的加成
  watchFx(e, before) {
    if (!(e.mods.healedDamagePct > 0) || !(e.healedStacks > before.healedStacks)) return null;
    return [['float', e.id, `知足 +${Math.min(e.mods.healedDamageMaxPct, e.healedStacks * e.mods.healedDamagePct)}%`, '#86efac', 15]];
  },
};
