// 關卡種類（shared/game/stage-rules.js 的 stageType：'normal' | 'elite' | 'boss'）在畫面上的名字與顏色：
// 開場橫幅、左上的關卡標籤、選牌畫面、結算畫面都照這個。伺服器的訊息帶 type（舊的只帶 isBoss 也認得）
export const STAGE_LOOK = {
  normal: { name: null, banner: '#fde047', hud: '#fff' },
  elite: { name: '菁英關', banner: '#c084fc', hud: '#e9d5ff' },
  boss: { name: 'Boss 關', banner: '#f87171', hud: '#fca5a5' },
};

// 訊息 / stageInfo 是哪一種關卡（type 沒帶的話看 isBoss）
export function stageTypeOf(info) {
  if (!info) return 'normal';
  if (Object.hasOwn(STAGE_LOOK, info.type)) return info.type;
  return info.isBoss ? 'boss' : 'normal';
}

export const stageLook = (info) => STAGE_LOOK[stageTypeOf(info)];
