// 祈願之杖：全隊（含自己）回復各自上限 N% 的血。大家的牌都套完才算（選牌的第二輪），每個人照自己新的上限；
// 同一輪好幾個人拿到就加起來（記在這一輪選牌共用的 pool.teamHealPct）
export const teamHeal = {
  id: 'teamHeal',
  keys: { teamHealPct: { desc: '全隊（含自己）立刻回復各自上限 N% 的血', instant: true } },
  picked(p, now, pool) { pool.teamHealPct = (pool.teamHealPct || 0) + now.teamHealPct; },
  healForTeam: (pool, p, max) => max * (pool.teamHealPct || 0) / 100,
};
