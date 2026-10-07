// 噬魂者：每擊殺一個敵人，武器傷害再 +N%（整場冒險累積；燒死、炸進水裡也算）。
// 累積的 % 是這個效果自己的角色狀態 soulPct：同步欄位 soul（開火結果也帶），整場冒險帶著走（carry）
export const soul = {
  id: 'soul',
  keys: { killDamagePct: '每擊殺一個敵人，武器傷害再 +N%（整場冒險累積）' },
  state: { soulPct: { wire: 'soul', after: 'shield', carry: true, shot: true } },
  damage: (e) => e.soulPct,
  // fx = 燒死（回合結束）時的 fx 清單：另外記一筆 soul，客戶端飄「噬魂 N%」
  onKill(match, e, killed, fx) {
    if (killed.length && e.mods.killDamagePct > 0) {
      e.soulPct += killed.length * e.mods.killDamagePct;
      if (fx) fx.push({ type: 'soul', id: e.id, soul: e.soulPct });
    }
  },
  chipOrder: 20,
  chip: (e) => (e.soulPct > 0 ? [`噬魂 +${e.soulPct}%`, '#c084fc'] : null),
  killFloat: (e, shot) => (e.mods.killDamagePct > 0 ? [[`噬魂 +${shot.kills.length * e.mods.killDamagePct}%`, '#c084fc']] : []),
  turnFx: (fx) => (fx.type === 'soul' ? [['float', fx.id, `噬魂 ${fx.soul}%`, '#c084fc']] : null),
};
