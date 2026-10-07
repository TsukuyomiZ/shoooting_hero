// 磨刀霍霍：自己開的一槍沒打中敵人（直擊或波及到敵方都算打中，傷害 0 也算）+1 層「準備」，最多 missMaxStacks 層；打中就歸零。
// 每層武器傷害 +missDamagePct%。層數是這個效果自己的角色狀態 readyStacks（同步欄位 rd）
export const ready = {
  id: 'ready',
  keys: {
    missDamagePct: '每次射擊沒打中敵人得到一層「準備」，每層武器傷害 +N%；打中敵人就歸零',
    missMaxStacks: '上面「準備」最多幾層',
  },
  state: { readyStacks: { wire: 'rd', after: 'vn' } },
  damageState: (e) => e.readyStacks * e.mods.missDamagePct,
  afterShot(match, e, hit) {
    if (e.mods.missDamagePct > 0) e.readyStacks = hit ? 0 : Math.min(e.mods.missMaxStacks, e.readyStacks + 1);
  },
  // 開火紀錄：有磨刀霍霍或越戰越強就記 stacks: { ready, hunt }
  shotLog: { group: 'stacks', field: 'ready', value: (e) => e.readyStacks, on: (e) => e.mods.missDamagePct > 0 },
  chipOrder: 220,
  chip: (e) => (e.mods.missDamagePct > 0
    ? [`準備 ${e.readyStacks}/${e.mods.missMaxStacks} · +${e.readyStacks * e.mods.missDamagePct}%`, '#fcd34d'] : null),
  shotFloat: (e, before) => (e.mods.missDamagePct > 0 && e.readyStacks !== before.readyStacks
    ? [[e.readyStacks ? `準備 ×${e.readyStacks}` : '準備 歸零', '#fcd34d']] : []),
};
