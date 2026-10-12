// 立刻回血上限的 N%（上限照套完這張牌之後的新上限算）
export const healPct = {
  id: 'healPct',
  keys: { healPct: { desc: '立刻回血，上限的 N%', instant: true } },
  healNow: (now, max) => max * now.healPct / 100,
};
