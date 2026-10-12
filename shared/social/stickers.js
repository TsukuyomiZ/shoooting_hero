// 反應貼圖：按下去會像彈幕一樣從畫面右邊飄到左邊，所有人都看得到
// 新增貼圖：圖檔放 assets/stickers/，在下面加一行（id 只能用英數字、- 和 _），改完要重啟伺服器
export const STICKERS = [
  { id: 'huh', label: '問號', src: 'assets/stickers/huh.webp' },
  { id: 'dog', label: '吉娃娃', src: 'assets/stickers/dog.webp' },
  { id: 'lol', label: '大笑', src: 'assets/stickers/lol.webp' },
];

// 洗版限制：每人 windowMs 內最多 count 張（伺服器擋，客戶端也照同一套規則先擋，自己才不會看到別人看不到的貼圖）
export const STICKER_LIMIT = { count: 4, windowMs: 3000 };

export const isSticker = (id) => STICKERS.some(s => s.id === id);

// times：這個人最近送出貼圖的時間（會被就地修剪）；回傳 true 表示這張可以送，並記下時間
export function allowSticker(times, now) {
  while (times.length && now - times[0] >= STICKER_LIMIT.windowMs) times.shift();
  if (times.length >= STICKER_LIMIT.count) return false;
  times.push(now);
  return true;
}
