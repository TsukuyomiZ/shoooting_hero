// 嗨到最高點：狂熱生效時（match.fever > 0；Boss 關沒有狂熱）武器傷害再 +N%。
// 狀態列照客戶端的輪數算狂熱（feverAt(round)），沒生效時用灰色
export const fever = {
  id: 'fever',
  keys: { feverDamagePct: '狂熱生效時（一般小關第 11 輪起；Boss 關沒有狂熱），武器傷害再 +N%' },
  damageState: (e, c) => (c.match.fever > 0 ? e.mods.feverDamagePct : 0),
  chipOrder: 200,
  chip(e, c) {
    const m = e.mods;
    if (!(m.feverDamagePct > 0)) return null;
    return c.match.feverAt(c.round) > 0 ? [`嗨到最高點 +${m.feverDamagePct}%`, '#f97316'] : ['嗨到最高點（狂熱時）', '#64748b'];
  },
};
