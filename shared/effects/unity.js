// 團結力量大：場上每有一名活著的隊友，武器傷害 +N% / 受到的傷害 -N%（減傷只算自己）。
// c.allies = 活著的隊友數（減傷照這一下之前的場面，見 Match.applyExplosion）
export const unity = {
  id: 'unity',
  keys: {
    allyDamagePct: { desc: '場上每有一名活著的隊友，武器傷害 +N%', teamOnly: true },
    allyArmorPct: { desc: '場上每有一名活著的隊友，受到的傷害 -N%（只算自己）', teamOnly: true },
  },
  damageSituation: (e, c) => c.allies * e.mods.allyDamagePct,
  armor: (e, c) => c.allies * e.mods.allyArmorPct,
  chipOrder: 260,
  chip(e, c) {
    const m = e.mods;
    if (!(m.allyDamagePct > 0 || m.allyArmorPct > 0)) return null;
    const allies = c.match.alliesAlive(e);
    // 沒生效（沒有隊友）時用灰色標出來
    return allies > 0 ? [`團結 +${allies * m.allyDamagePct}% · 減傷 ${allies * m.allyArmorPct}%`, '#86efac'] : ['團結（沒有隊友）', '#64748b'];
  },
};
