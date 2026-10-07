// 每回合秒數 +N（裁判算回合時間；目前沒有牌用它）
export const turnTime = {
  id: 'turnTime',
  keys: { turnTime: '每回合秒數 +N' },
  turnSecs: (e) => e.mods.turnTime,
};
