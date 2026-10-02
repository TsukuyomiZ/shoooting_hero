export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// 紀錄（LOG）裡放客戶端送來的值：字串截短、數字取到小數一位，其他（物件、陣列…）只記型別。
// 不能直接 String(v)：亂送的物件（例如 {"toString":0}）會讓 String() 丟錯，一行紀錄也不能無限長
export function logValue(v, max = 20) {
  if (typeof v === 'string') return v.slice(0, max);
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 10) / 10 : String(v);
  if (typeof v === 'boolean' || v === null || v === undefined) return v;
  return typeof v === 'object' ? (Array.isArray(v) ? 'array' : 'object') : typeof v;
}

// 角度插補（處理 -180~180 的環繞）
export function lerpAngle(a, b, t) {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
}

// 數學角度 (0=右, 90=上) → 相對於面向方向的顯示角度，例如面向左、往左上打 32° 就顯示 32°
export function displayAngle(e) {
  let a = e.facing > 0 ? e.aimAngle : 180 - e.aimAngle;
  a = ((a + 180) % 360 + 360) % 360 - 180;
  return Math.round(a);
}
