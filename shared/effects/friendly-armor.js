// 受到的隊友誤傷再 -N%（一般減傷之後另外乘）
export const friendlyArmor = {
  id: 'friendlyArmor',
  keys: { friendlyArmorPct: '受到的隊友誤傷再 -N%' },
  friendlyArmor: (e) => e.mods.friendlyArmorPct,
};
