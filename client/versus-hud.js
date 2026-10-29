import { CONFIG } from '../shared/core/config.js';
import { roundRect, text } from './draw.js';

// 勝者為王（3v3 對戰）的 HUD：跟冒險不一樣的那幾樣（左上的標籤、右上兩隊的名單、選牌中的提示、勝負的蓋版）。
// Renderer 只在 view.versus 時呼叫這裡，冒險的畫法都留在 render.js。只讀畫面與場上的狀態，不改任何東西

// 兩隊的代表色（隊名、勝負的字）；角色本身的顏色照名單的 color（隊裡第幾位的深淺）
export const TEAM_ACCENT = { blue: '#60a5fa', red: '#f87171' };
const teamName = (t) => CONFIG.VERSUS.teamNames[t] || t;
const accent = (t) => TEAM_ACCENT[t] || '#e5e7eb';

// 左上的標籤（取代冒險的「第 x / y 關」）與顏色
export const versusLabel = (match) => `${CONFIG.VERSUS.name} · 第 ${match.round} 輪`;
export const VERSUS_LABEL_COLOR = '#fde68a';

// 選牌還剩幾秒（view.picking.until 是本地時間；過了就是 0）
export function pickSecsLeft(view) {
  const p = view.picking;
  return p && p.until ? Math.max(0, Math.ceil((p.until - performance.now()) / 1000)) : 0;
}

// 右上的名單：兩隊各一塊——隊名（自己那一隊標「我方」）、還站著幾個人，底下每個人一行（drawRow 跟冒險的同一套：名字、血條、牌 ×N）；
// lines = 地圖畫面給的幾行（對戰地圖目前沒有），接在最後面、最多 lineW 寬。框的位置、寬度、樣式、行距跟冒險的一樣，兩隊之間多空 GAP
export function drawVersusRoster(ctx, view, drawRow, lines, lineW) {
  const W = CONFIG.WORLD_W;
  const GAP = 6;
  const teams = CONFIG.VERSUS.teams.map(t => [t, view.match.players.filter(p => p.team === t)]);
  const rows = teams.reduce((n, [, ps]) => n + 1 + ps.length, 0) + lines.length;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  roundRect(ctx, W - 12 - 250, 12, 250, 12 + rows * 22 + GAP * (teams.length - 1), 10); ctx.fill();
  const mine = view.myTeam;
  let y = 34;
  teams.forEach(([t, ps], k) => {
    if (k) y += GAP;
    const alive = ps.filter(p => p.alive).length;
    text(ctx, `${teamName(t)}${t === mine ? '（我方）' : ''}`, W - 250, y, { size: 14, bold: true, color: accent(t) });
    // 靠右但讓開音量按鈕（settings-ui.js 的 BTN：名單框的標題列最右邊那一格）
    text(ctx, `存活 ${alive} / ${ps.length}`, W - 50, y, { size: 13, bold: true, align: 'right', color: alive ? '#e5e7eb' : '#9ca3af' });
    y += 22;
    for (const p of ps) { drawRow(p, y); y += 22; }
  });
  lines.forEach(([str, color], i) => text(ctx, str, W - 250, y + 2 + i * 22, { size: 13, bold: true, color, maxWidth: lineW }));
}

// 選牌中（戰鬥暫停）：開頭的橫幅播完之後，在橫幅的位置留一行小字，倒下的人（沒有牌可選）也看得到大家還在選、還剩幾秒
export function drawPickPause(ctx, view) {
  if (!view.picking || view.banner || view.result) return;
  text(ctx, `第 ${view.picking.round} 輪結束　大家選牌中…　${pickSecsLeft(view)} 秒`, CONFIG.WORLD_W / 2, 150, {
    size: 24, bold: true, align: 'center', color: VERSUS_LABEL_COLOR, outline: 'rgba(0,0,0,0.85)', outlineWidth: 5,
  });
}

// 勝負的字：winner = 贏的那一隊（'draw' / null = 平手）。照自己的隊伍寫勝利 / 落敗；自己沒有角色（觀戰）只寫哪一隊贏
export function versusResult(view, winner) {
  if (!winner || winner === 'draw') return { title: '平手', color: '#e5e7eb', sub: '兩隊最後的人同時倒下' };
  const sub = `${teamName(winner)}獲勝`;
  const team = view.myTeam;
  if (!team) return { title: sub, color: accent(winner), sub: '' };
  return winner === team ? { title: '勝利！', color: '#fde047', sub } : { title: '落敗…', color: '#f87171', sub };
}

// 勝負的蓋版：final = 整場結束（runOver：結算畫面隨後就到，多一行回大廳的提示）；不然是剛分出勝負（gameOver）
export function drawVersusOverlay(ctx, view, winner, round, final) {
  const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
  ctx.fillStyle = final ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, W, H);
  const r = versusResult(view, winner);
  text(ctx, r.title, W / 2, H / 2 - 30, { size: 64, bold: true, align: 'center', color: r.color, outline: 'rgba(0,0,0,0.9)', outlineWidth: 8 });
  text(ctx, [r.sub, `共 ${round} 輪`].filter(Boolean).join('　·　'), W / 2, H / 2 + 20, { size: 22, align: 'center', color: '#eee' });
  if (final) text(ctx, '按 R 或點擊畫面回到大廳', W / 2, H / 2 + 64, { size: 18, align: 'center', color: '#bbb' });
}
