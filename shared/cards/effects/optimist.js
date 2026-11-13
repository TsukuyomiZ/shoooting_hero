import { CONFIG } from '../../core/config.js';

// 樂觀：血量在上限的 EQUIP.optimist.hpPct% 以上（含）時，武器傷害 +N%（看結算那一下的血量，同全力一擊看那一下的體力）。
// 牌上另外的治療效率由 healRecvPct 給（見 heal-boost.js）（2026-11-10 使用者）
const healthy = (e) => e.hp * 100 >= e.maxHp * CONFIG.EQUIP.optimist.hpPct;

export const optimist = {
  id: 'optimist',
  keys: { healthyDamagePct: '血量不低於上限的一定比例時（見 config 的 EQUIP.optimist），武器傷害 +N%' },
  damageState: (e) => (healthy(e) ? e.mods.healthyDamagePct : 0),
  chipOrder: 360,
  // 沒生效（血量太低）時用灰色標出來
  chip(e) {
    const pct = e.mods.healthyDamagePct;
    if (!(pct > 0)) return null;
    return healthy(e) ? [`樂觀 +${pct}%`, '#fde68a'] : [`樂觀（血量低於 ${CONFIG.EQUIP.optimist.hpPct}%）`, '#64748b'];
  },
};
