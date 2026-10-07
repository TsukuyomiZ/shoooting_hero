// 越戰越強：自己開的一槍打中敵人 +1 層「狂獵」，最多 hitMaxStacks 層；沒打中就歸零（打中的定義同磨刀霍霍）。
// 每層武器傷害 +hitDamagePct%。層數是這個效果自己的角色狀態 huntStacks（同步欄位 hu）
export const hunt = {
  id: 'hunt',
  keys: {
    hitDamagePct: '每次射擊打中敵人得到一層「狂獵」，每層武器傷害 +N%；沒打中就歸零',
    hitMaxStacks: '上面「狂獵」最多幾層',
  },
  state: { huntStacks: { wire: 'hu', after: 'vn' } },
  damageState: (e) => e.huntStacks * e.mods.hitDamagePct,
  afterShot(match, e, hit) {
    if (e.mods.hitDamagePct > 0) e.huntStacks = hit ? Math.min(e.mods.hitMaxStacks, e.huntStacks + 1) : 0;
  },
  shotLog: { group: 'stacks', field: 'hunt', value: (e) => e.huntStacks, on: (e) => e.mods.hitDamagePct > 0 },
  chipOrder: 230,
  chip: (e) => (e.mods.hitDamagePct > 0
    ? [`狂獵 ${e.huntStacks}/${e.mods.hitMaxStacks} · +${e.huntStacks * e.mods.hitDamagePct}%`, '#f87171'] : null),
  shotFloat: (e, before) => (e.mods.hitDamagePct > 0 && e.huntStacks !== before.huntStacks
    ? [[e.huntStacks ? `狂獵 ×${e.huntStacks}` : '狂獵 歸零', '#f87171']] : []),
};
