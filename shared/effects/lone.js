// 孤狼傳說：場上沒有活著的隊友時（單人一直算），武器傷害 / 傷害吸血 +N%。
// c.allies = 活著的隊友數（吸血照打中之前的場面，見 Match.resolveHit）
export const lone = {
  id: 'lone',
  keys: {
    loneDamagePct: '場上沒有活著的隊友時（單人一直算），武器傷害 +N%',
    loneLifestealPct: '場上沒有活著的隊友時（單人一直算），傷害吸血 +N%',
  },
  damageSituation: (e, c) => (c.allies === 0 ? e.mods.loneDamagePct : 0),
  lifesteal: (e, c) => (c.allies === 0 ? e.mods.loneLifestealPct : 0),
  chipOrder: 250,
  chip(e, c) {
    const m = e.mods;
    if (!(m.loneDamagePct > 0 || m.loneLifestealPct > 0)) return null;
    // 沒生效（還有隊友）時用灰色標出來
    return c.match.alliesAlive(e) === 0 ? [`孤狼 +${m.loneDamagePct}% · 吸血 ${m.loneLifestealPct}%`, '#e2e8f0'] : ['孤狼（還有隊友）', '#64748b'];
  },
};
