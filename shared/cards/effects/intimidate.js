import { CONFIG } from '../../core/config.js';

// 威嚇：離自己 EQUIP.intimidate.range 以內的敵人，受到自己的傷害 +nearDamagePct%、對自己造成的傷害 -nearArmorPct%。
// 距離 = 從自己的身體中心量到對方身體最近的邊（Entity.distanceTo），看傷害結算那一下雙方站在哪。
// 用身體撞人的招式（武器的 bodyHit，例如大樹守衛衝鋒、蜜蜂螫擊）結算時攻擊者的 Entity 還在出發點：改量撞上那一下的位置
// c.at（Match.applyExplosion 給的：攻擊者的身體 = 中心 (at.x, at.y)、半徑 at.r 的圓）
// 傷害走 damageTarget 槽（c.target = 被打的人）；減傷走 armor 槽（c.attacker = 這一下的攻擊者；狀態列的「減傷」不帶攻擊者，所以不算這個）。
// 自己的回合畫一圈淡淡的範圍（aura）
const inRange = (d) => d <= CONFIG.EQUIP.intimidate.range;
// 自己 e 打 target：自己的身體中心（撞人時在 at）到 target 的身體
const nearTarget = (e, target, at) => inRange(target.distanceTo(at ? at.x : e.cx, at ? at.y : e.cy));
// attacker 打自己 e：自己的身體中心到 attacker 的身體（撞人時是 at 那個圓）
const nearAttacker = (e, attacker, at) => {
  if (!at) return inRange(attacker.distanceTo(e.cx, e.cy));
  const dx = e.cx - at.x, dy = e.cy - at.y;
  return inRange(Math.max(0, Math.sqrt(dx * dx + dy * dy) - at.r));
};

export const intimidate = {
  id: 'intimidate',
  keys: {
    nearDamagePct: '離自己一定距離以內的敵人受到自己的傷害 +N%',
    nearArmorPct: '離自己一定距離以內的敵人對自己造成的傷害 -N%',
  },
  damageTarget: (e, c) => (c.target && c.target.team !== e.team && nearTarget(e, c.target, c.at) ? e.mods.nearDamagePct : 0),
  armor: (e, c) => (c.attacker && c.attacker.team !== e.team && nearAttacker(e, c.attacker, c.at) ? e.mods.nearArmorPct : 0),
  aura: (e) => (e.mods.nearDamagePct > 0 || e.mods.nearArmorPct > 0 ? { r: CONFIG.EQUIP.intimidate.range, color: '#fca5a5' } : null),
  chipOrder: 300,
  chip: (e) => (e.mods.nearDamagePct > 0 || e.mods.nearArmorPct > 0 ? [`威嚇 ${CONFIG.EQUIP.intimidate.range}`, '#fca5a5'] : null),
};
