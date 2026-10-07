// 立刻回血 N（選完牌的當下；對著套完牌的新上限，倒下的人不回）
export const heal = {
  id: 'heal',
  keys: { heal: { desc: '立刻回血 N', instant: true } },
  healNow: (now) => now.heal,
};
