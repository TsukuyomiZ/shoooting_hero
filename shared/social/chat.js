// 聊天：遊戲中按 Enter 打字，送出的字跟反應貼圖走同一條彈幕軌道，所有人都看得到
// 伺服器和客戶端都用同一套整理規則與洗版限制（自己先播的字和別人收到的一模一樣，也不會看到別人看不到的訊息）

// 一則最多幾個字（用字元算，emoji 算一個）；彈幕太長會一直佔著軌道
export const CHAT_MAX = 30;

// 洗版限制：每人 windowMs 內最多 count 則
export const CHAT_LIMIT = { count: 3, windowMs: 4000 };

// 控制字元、零寬字元、換行 / 段落分隔、雙向文字覆寫（會把後面整串字倒過來）都換成空白
const STRIP = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

// 整理一則訊息：不是字串 → ''；去掉怪字元、連續空白縮成一個、頭尾空白去掉、超過 CHAT_MAX 個字就截斷
export function cleanChat(text) {
  if (typeof text !== 'string') return '';
  const s = text.slice(0, CHAT_MAX * 8).replace(STRIP, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, CHAT_MAX).join('').trim();
}

// times：這個人最近送出訊息的時間（會被就地修剪）；回傳 true 表示這則可以送，並記下時間
export function allowChat(times, now) {
  while (times.length && now - times[0] >= CHAT_LIMIT.windowMs) times.shift();
  if (times.length >= CHAT_LIMIT.count) return false;
  times.push(now);
  return true;
}
