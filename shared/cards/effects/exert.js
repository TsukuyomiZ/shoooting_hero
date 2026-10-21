// 全力一擊：體力越低，武器傷害越高——體力全滿 +exertMinPct%，體力用完 +exertMaxPct%，中間照剩下的體力比例。
// 看結算那一下的體力：伺服器的體力 = 這回合最後收下的回報（開火也帶體力，見 Match.applyPositionReport；只能減不能加），
// AI / 代打照模擬走路扣的；回合開始的轟炸時體力是滿的（給最低的那一檔）
const pctOf = (e) => {
  const m = e.mods;
  if (!(e.maxStamina > 0)) return 0;
  const left = Math.max(0, Math.min(1, e.stamina / e.maxStamina));
  return m.exertMinPct + (m.exertMaxPct - m.exertMinPct) * (1 - left);
};

export const exert = {
  id: 'exert',
  keys: {
    exertMinPct: '體力越低武器傷害越高：體力全滿時 +N%',
    exertMaxPct: '上面「體力越低」在體力用完時的 +%（中間照剩下的體力比例）',
  },
  damageState: pctOf,
  // 開火紀錄：開火那一刻算到的加成（看伺服器收下的體力）
  shotLog: { group: 'exert', field: 'pct', value: (e) => Math.round(pctOf(e) * 10) / 10, on: (e) => e.mods.exertMinPct > 0 || e.mods.exertMaxPct > 0 },
  chipOrder: 310,
  chip: (e) => (e.mods.exertMinPct > 0 || e.mods.exertMaxPct > 0 ? [`全力 +${Math.round(pctOf(e))}%`, '#fdba74'] : null),
};
