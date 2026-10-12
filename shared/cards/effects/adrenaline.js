// 腎上腺素：下一關（只有那一關）武器傷害 +N% / 血量上限 +N。
// 選牌時先記在肉鴿流程的玩家身上（p.next），下一關開始變成生效中的 p.boost：上限加多少就同時回多少，
// 武器傷害放進 mods 的 stageDamagePct（不是牌的 key，由這裡每關重新給）；打完那一關就失效，超過原本上限的血由 run.js 扣掉
const ZERO = () => ({ damagePct: 0, maxHp: 0 });

export const adrenaline = {
  id: 'adrenaline',
  keys: {
    nextDamagePct: { desc: '下一關武器傷害 +N%（打完那一關就失效）', instant: true },
    nextMaxHp: { desc: '下一關血量上限 +N（開打時同時回 N 血；打完那一關就失效，超過原本上限的血會被扣掉）', instant: true },
  },
  extraMods: { stageDamagePct: '只在這一關有效的武器傷害加成（腎上腺素），由肉鴿流程每關重新給' },
  runInit(p) {
    p.next = ZERO();    // 下一關才生效的暫時加成
    p.boost = ZERO();   // 這一關正在生效的暫時加成（打完就失效）
  },
  picked(p, now) {
    p.next.damagePct += now.nextDamagePct;
    p.next.maxHp += now.nextMaxHp;
  },
  stageStart(p) {
    p.boost = p.next;
    p.next = ZERO();
    if (p.boost.maxHp > 0) p.hp += p.boost.maxHp;
  },
  carry(p, d) {
    d.maxHp += p.boost.maxHp;
    d.mods.stageDamagePct = p.boost.damagePct;
  },
  stageOver(p) { p.boost = ZERO(); },
  damageSituation: (e) => e.mods.stageDamagePct,
  chipOrder: 240,
  chip: (e) => (e.mods.stageDamagePct > 0 ? [`腎上腺素 +${e.mods.stageDamagePct}%（這一關）`, '#f472b6'] : null),
};
