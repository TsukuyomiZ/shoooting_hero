// 醫療包：隊友（不含自己）立刻各回血 N。大家的牌都套完才算（選牌的第二輪）；倒下的人不回（下一關本來就會復活）
export const allyHeal = {
  id: 'allyHeal',
  keys: { allyHeal: { desc: '隊友（不含自己）立刻各回血 N', instant: true, teamOnly: true } },
  // [回血的人, 每位隊友回多少]
  picked(p, now, pool) { if (now.allyHeal > 0) (pool.allyHeals ||= []).push([p.id, now.allyHeal]); },
  healFromTeammates: (pool, p) => (pool.allyHeals || []).reduce((s, [from, n]) => s + (from === p.id ? 0 : n), 0),
};
