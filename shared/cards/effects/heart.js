// 人工心臟：倒下時當場以上限 revivePct% 的血復活，整場冒險只有一次（勝者為王 = 整場對戰一次）
// （2026-11-10 使用者：「死掉後立即觸發，只可觸發一次」；11-11 確認是整場一次，不是每關一次。復活的血量是我的詮釋）。
// 任何死法都算（被打、落水、燃燒、中毒、流血、處刑、誅滅…）：Entity.die 先問這個效果（revive），
// 救回來的時候負面狀態（燃燒、中毒、流血、糾纏）一起清掉、被中毒鎖住的上限不回來；淹死的回到最後站穩的地方（見 Entity.revive / fallInWater）。
// 用過了沒是這個效果自己的角色狀態 heartUsed（同步欄位 ht）：整場冒險帶著走（carry：一關打完收回玩家身上、下一關照它建角色；
// 勝者為王選牌前也先收回，見 Versus.syncFromMatch），用掉之後之後每一關都是「已用過」
export const heart = {
  id: 'heart',
  keys: { revivePct: '倒下時當場以上限 N% 的血復活（整場冒險只有一次）' },
  state: { heartUsed: { wire: 'ht', carry: true } },
  revive(e) {
    if (!(e.mods.revivePct > 0) || e.heartUsed) return 0;
    e.heartUsed = 1;
    return e.mods.revivePct;
  },
  chipOrder: 370,
  chip: (e) => (e.mods.revivePct > 0 ? (e.heartUsed ? ['人工心臟 已用過', '#64748b'] : ['人工心臟 待命', '#f87171']) : null),
  // 用掉了（不管是本地物理、重播還是套伺服器的狀態看到的）：復活的演出
  watchFx(e, before) {
    if (!e.heartUsed || before.heartUsed) return null;
    return [
      ['banner', `${e.name} 的人工心臟啟動：復活！`, '#f87171'],
      ['float', e.id, '復活！', '#fca5a5', 20],
      ['particles', e.id, 26, { speed: 160, life: 0.8, size: 3.5, color: '#f87171', gravity: -60 }],
    ];
  },
};
