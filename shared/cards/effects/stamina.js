// 體力上限 +N
export const stamina = {
  id: 'stamina',
  keys: { staminaMax: '體力上限 +N' },
  stat: (stats, P) => ['maxStamina', Math.round(P.stamina + stats.staminaMax)],
};
