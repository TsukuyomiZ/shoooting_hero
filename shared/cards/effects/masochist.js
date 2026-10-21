// 被虐體質：每受到一次攻擊傷害（真的扣到血：敵人的攻擊、誤傷、攜手之伴分到的那份都算；中毒、流血、燃燒、落水、石假面不算），
// 武器傷害 +hurtDamagePct%，最多 +hurtDamageMaxPct%。層數是這個效果自己的角色狀態 hurtStacks（同步欄位 hs），每關從 0 開始
export const masochist = {
  id: 'masochist',
  keys: {
    hurtDamagePct: '每受到一次攻擊傷害，武器傷害 +N%（每關重算）',
    hurtDamageMaxPct: '上面「受到攻擊」加成的上限 %',
  },
  state: { hurtStacks: { wire: 'hs', after: 'vn' } },
  damageState: (e) => Math.min(e.mods.hurtDamageMaxPct, e.hurtStacks * e.mods.hurtDamagePct),
  // 層數只疊到剛好達到上限（不會一直往上加）
  onHurt(match, e) {
    const m = e.mods;
    if (m.hurtDamagePct > 0) e.hurtStacks = Math.min(Math.max(0, Math.ceil(m.hurtDamageMaxPct / m.hurtDamagePct)), e.hurtStacks + 1);
  },
  // 開火紀錄：跟磨刀霍霍 / 越戰越強記在同一組 stacks
  shotLog: { group: 'stacks', field: 'hurt', value: (e) => e.hurtStacks, on: (e) => e.mods.hurtDamagePct > 0 },
  chipOrder: 290,
  chip: (e) => (e.mods.hurtDamagePct > 0
    ? [`受虐 +${Math.min(e.mods.hurtDamageMaxPct, e.hurtStacks * e.mods.hurtDamagePct)}%`, '#fb7185'] : null),
};
