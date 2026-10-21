import { archPath } from './draw.js';

// 地圖上純裝飾的圖案（關卡的 decor，不影響物理）：先畫成圖。back 畫在水之後、地形之前；front 畫在地形之後、角色之前。
// 大樹（樹影重重、小心擊發、大樹守衛）：trunk = 樹幹多邊形（前一半左邊由下往上、後一半右邊由上往下），canopy = 樹冠一團團的葉子 [x, y, 半徑]，
// twigs = 樹枝上長出來的小枝條 [x, y, dx, dy]（從 (x, y) 長到 (x + dx, y + dy)，末端一片葉子）；
// canopyFront = 蓋在地形上面的樹冠（小心擊發的樹幹是地形，樹冠要畫在它前面才看得到）。
// 牆上的洞（巨蠍巢穴）：burrows = [{ x0, x1, top, bottom, lean }]（洞口左右、洞頂、洞底（藏在地面後面）、洞頂往左右偏多少）
// 監獄（處刑監獄）：pillars = 柱子的 x（柱子之間是石拱）、windows = 高窗 [{ x, y（窗洞上半圓的圓心）}]（透進斜斜的月光）、
// banner = 旗幟 { x, y0, y1 }、cells = 牢房 [{ x0, x1, top, bottom, numeral }]（只畫裡面與石框、門楣、編號牌；欄杆與還關著的猛獸由地圖畫面畫）、
// scaffold = 處刑台 { x0, y（台面）, posts（支柱的 x）, block（砍頭木樁的 x）}（台面本身是地形；支柱在後面、木樁在前面）
export function buildDecor(decor, W, H) {
  const layer = () => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  };
  const back = layer();
  const ctx = back.getContext('2d');
  if (decor.trunk) drawTrunk(ctx, decor.trunk);
  if (decor.canopy) drawCanopy(ctx, decor.canopy);
  if (decor.twigs) drawTwigs(ctx, decor.twigs);
  if (decor.burrows) drawBurrows(ctx, decor.burrows);
  if (decor.pillars) drawPrisonWall(ctx, decor, W);
  for (const cell of decor.cells || []) drawCell(ctx, cell);
  if (decor.scaffold) drawScaffoldPosts(ctx, decor.scaffold);
  let front = null;
  if (decor.canopyFront || decor.scaffold) {
    front = layer();
    if (decor.canopyFront) drawCanopy(front.getContext('2d'), decor.canopyFront);
    if (decor.scaffold) drawChoppingBlock(front.getContext('2d'), decor.scaffold);
  }
  return { back, front };
}

// ---------- 監獄 ----------

const hash2 = (x, y) => {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const ellipse = (ctx, x, y, rx, ry) => { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); };

// 監獄的牆：柱子之間的石拱（拱頂）、高窗（夜空、月亮、鐵條、斜斜的月光）、柱子（一塊塊的大石頭，上面柱頭、下面柱基）、處刑官的旗幟
function drawPrisonWall(ctx, decor, W) {
  const ps = [-200, ...decor.pillars, W + 200];
  for (let k = 0; k + 1 < ps.length; k++) {
    const x0 = ps[k], x1 = ps[k + 1], mx = (x0 + x1) / 2;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#22232b';
    ctx.lineWidth = 20;
    ctx.beginPath(); ctx.moveTo(x0, 150); ctx.quadraticCurveTo(mx, -36, x1, 150); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, 140); ctx.quadraticCurveTo(mx, -46, x1, 140); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';   // 拱石的接縫
    ctx.lineWidth = 1.5;
    for (let s = 0.1; s < 1; s += 0.1) {
      const bx = (1 - s) * (1 - s) * x0 + 2 * s * (1 - s) * mx + s * s * x1;
      const by = (1 - s) * (1 - s) * 150 + 2 * s * (1 - s) * -36 + s * s * 150;
      ctx.beginPath(); ctx.moveTo(bx, by - 10); ctx.lineTo(bx, by + 10); ctx.stroke();
    }
  }
  (decor.windows || []).forEach((wd, k) => drawWindow(ctx, wd.x, wd.y, k === 0));
  for (const px of decor.pillars) drawPillar(ctx, px);
  if (decor.banner) drawBanner(ctx, decor.banner);
}

function drawWindow(ctx, x, y, moon) {
  const shaft = ctx.createLinearGradient(x, y, x + 160, 580);
  shaft.addColorStop(0, 'rgba(165,200,255,0.10)');
  shaft.addColorStop(1, 'rgba(165,200,255,0)');
  ctx.fillStyle = shaft;
  ctx.beginPath(); ctx.moveTo(x - 18, y + 20); ctx.lineTo(x + 18, y + 10); ctx.lineTo(x + 210, 580); ctx.lineTo(x + 100, 580); ctx.closePath(); ctx.fill();
  ctx.save();
  ctx.beginPath(); ctx.moveTo(x - 20, y + 34); ctx.lineTo(x - 20, y); ctx.arc(x, y, 20, Math.PI, 0); ctx.lineTo(x + 20, y + 34); ctx.closePath();
  const sky = ctx.createLinearGradient(0, y - 20, 0, y + 34);
  sky.addColorStop(0, '#22406b');
  sky.addColorStop(1, '#0f1d33');
  ctx.fillStyle = sky; ctx.fill();
  ctx.strokeStyle = '#45464f'; ctx.lineWidth = 6; ctx.stroke();
  ctx.clip();
  if (moon) {   // 彎月
    ctx.fillStyle = '#e8edf5'; ellipse(ctx, x + 8, y - 4, 8, 8); ctx.fill();
    ctx.fillStyle = '#22406b'; ellipse(ctx, x + 12, y - 7, 7, 7); ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  for (const [sx, sy] of [[-12, -10], [10, 14], [-6, 20]]) ctx.fillRect(x + sx, y + sy, 1.2, 1.2);
  ctx.restore();
  ctx.strokeStyle = '#1b1c22'; ctx.lineWidth = 3.5;
  for (const bx of [-10, 0, 10]) { ctx.beginPath(); ctx.moveTo(x + bx, y - 22); ctx.lineTo(x + bx, y + 34); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(x - 20, y + 10); ctx.lineTo(x + 20, y + 10); ctx.stroke();
}

function drawPillar(ctx, cx) {
  const w = 36, x0 = cx - w / 2;
  for (let k = 0, y = 34; y < 580; k++, y += 30) {
    const v = 52 + hash2(cx, k) * 14;
    ctx.fillStyle = `rgb(${v},${v},${v + 9})`;
    ctx.fillRect(x0 + 1, y + 1, w - 2, 28);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(x0 + 1, y + 1, 4, 28);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x0 + w - 7, y + 1, 6, 28);
  }
  ctx.fillStyle = '#3d3e48';   // 柱頭、柱基
  ctx.fillRect(x0 - 6, 30, w + 12, 14);
  ctx.fillRect(x0 - 6, 562, w + 12, 18);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x0 - 6, 30, w + 12, 2);
  ctx.fillRect(x0 - 6, 562, w + 12, 2);
}

// 處刑官的旗幟：深紅布、金邊、一把斧頭的圖案，下面剪成燕尾
function drawBanner(ctx, b) {
  const { x, y0, y1 } = b, hw = 34;
  ctx.save();
  ctx.fillStyle = '#5b0f14';
  ctx.beginPath();
  ctx.moveTo(x - hw, y0); ctx.lineTo(x + hw, y0); ctx.lineTo(x + hw, y1); ctx.lineTo(x, y1 - 22); ctx.lineTo(x - hw, y1); ctx.closePath();
  ctx.fill();
  const g = ctx.createLinearGradient(x - hw, 0, x + hw, 0);   // 布的皺摺
  g.addColorStop(0, 'rgba(0,0,0,0.35)'); g.addColorStop(0.3, 'rgba(255,255,255,0.05)'); g.addColorStop(0.55, 'rgba(0,0,0,0.2)');
  g.addColorStop(0.8, 'rgba(255,255,255,0.04)'); g.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = '#8a6a1c'; ctx.lineWidth = 3; ctx.stroke();
  ctx.translate(x, (y0 + y1) / 2 - 14);
  ctx.fillStyle = '#16120f';
  ctx.fillRect(-2, -34, 4, 62);
  ctx.beginPath(); ctx.moveTo(2, -30); ctx.quadraticCurveTo(26, -32, 24, -6); ctx.quadraticCurveTo(14, -12, 2, -10); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-2, -30); ctx.quadraticCurveTo(-26, -32, -24, -6); ctx.quadraticCurveTo(-14, -12, -2, -10); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#3f2a17';   // 掛桿
  ctx.fillRect(x - hw - 8, y0 - 5, 2 * hw + 16, 6);
  ctx.fillStyle = '#8a6a1c';
  ellipse(ctx, x - hw - 9, y0 - 2, 4, 4); ctx.fill();
  ellipse(ctx, x + hw + 9, y0 - 2, 4, 4); ctx.fill();
}

// 鐵鍊（直的、一節一節），open = 末端掛一個打開的鐐銬
function drawChainDecor(ctx, x, y0, len, sway) {
  ctx.save();
  ctx.lineCap = 'round';
  for (let k = 0, y = y0; y < y0 + len; k++, y += 7) {
    const dx = sway * ((y - y0) / len) ** 2;
    ctx.strokeStyle = '#4b505a';
    ctx.lineWidth = 2;
    if (k % 2) { ctx.beginPath(); ctx.moveTo(x + dx, y - 1); ctx.lineTo(x + dx, y + 8); ctx.stroke(); }
    else { ellipse(ctx, x + dx, y + 3.5, 2.8, 4.5); ctx.stroke(); }
  }
  ctx.strokeStyle = '#5b606b';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(x + sway, y0 + len + 6, 7, -0.3, Math.PI + 0.9); ctx.stroke();
  ctx.restore();
}

// 牢房（牆上凹進去的一間）的裡面：深色的磚、地上一圈冷冷的微光、刻在牆上的正字、牆上的鐐銬、稻草、水碗與骨頭；外面一圈石框、門楣、編號牌
function drawCell(ctx, cell) {
  const { x0, x1, top, bottom } = cell, w = x1 - x0, mid = (x0 + x1) / 2;
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, top, w, bottom - top); ctx.clip();
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, '#08080b');
  g.addColorStop(1, '#25242d');
  ctx.fillStyle = g;
  ctx.fillRect(x0, top, w, bottom - top);
  const lit = ctx.createRadialGradient(mid, bottom - 30, 10, mid, bottom - 30, w * 0.6);
  lit.addColorStop(0, 'rgba(150,160,190,0.16)');
  lit.addColorStop(1, 'rgba(150,160,190,0)');
  ctx.fillStyle = lit;
  ctx.fillRect(x0, top, w, bottom - top);
  for (let row = 0, y = top + 4; y < bottom; row++, y += 18) {
    const off = row % 2 ? 19 : 0;
    for (let x = x0 - off; x < x1; x += 38) {
      ctx.fillStyle = `rgba(70,70,84,${0.08 + hash2(Math.round(x) + 900, row) * 0.08})`;
      ctx.fillRect(x + 1.5, y + 1.5, 35, 15);
    }
  }
  ctx.strokeStyle = 'rgba(210,210,220,0.22)';   // 正字
  ctx.lineWidth = 1.2;
  for (let gi = 0; gi < 2; gi++) {
    const gx = x0 + 14 + gi * 16, gy = top + 30;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.moveTo(gx + k * 3, gy); ctx.lineTo(gx + k * 3, gy + 12); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(gx - 2, gy + 10); ctx.lineTo(gx + 11, gy + 2); ctx.stroke();
  }
  ctx.fillStyle = '#2d3038';   // 牆上的鐐銬
  ctx.fillRect(x1 - 30, top + 40, 8, 8);
  drawChainDecor(ctx, x1 - 26, top + 48, 30, 6);
  for (let k = 0; k < 60; k++) {   // 稻草
    const sx = x0 + 4 + hash2(k, top + x0) * (w - 8), sy = bottom - 1 - hash2(k, 3) * 7, a = (hash2(k, 9) - 0.5) * 1.2;
    ctx.strokeStyle = `rgba(${170 + hash2(k, 5) * 50},${140 + hash2(k, 6) * 40},70,0.6)`;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(a) * 9, sy - Math.abs(Math.sin(a)) * 4 - 1); ctx.stroke();
  }
  ctx.fillStyle = '#4a4744';   // 水碗
  ctx.beginPath(); ctx.ellipse(x0 + 24, bottom - 4, 9, 5, 0, 0, Math.PI); ctx.fill();
  ctx.fillStyle = '#d6d0c4';   // 骨頭
  ctx.fillRect(x1 - 50, bottom - 5, 16, 3);
  for (const bx of [x1 - 50, x1 - 34]) { ellipse(ctx, bx, bottom - 6, 2.4, 2.4); ctx.fill(); ellipse(ctx, bx, bottom - 2.5, 2.4, 2.4); ctx.fill(); }
  const sh = ctx.createLinearGradient(0, top, 0, top + 50);
  sh.addColorStop(0, 'rgba(0,0,0,0.7)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sh;
  ctx.fillRect(x0, top, w, 50);
  ctx.restore();
  ctx.strokeStyle = '#3a3b45';
  ctx.lineWidth = 10;
  ctx.strokeRect(x0 - 5, top - 5, w + 10, bottom - top + 10);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 - 9, top - 9, w + 18, bottom - top + 18);
  ctx.fillStyle = '#44454f';   // 門楣
  ctx.fillRect(x0 - 14, top - 26, w + 28, 18);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x0 - 14, top - 26, w + 28, 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  for (let x = x0 + 20; x < x1; x += 52) ctx.fillRect(x, top - 26, 2, 18);
  ctx.fillStyle = '#6b4e12';   // 編號牌
  ctx.beginPath(); ctx.roundRect(mid - 18, top - 30, 36, 22, 3); ctx.fill();
  ctx.strokeStyle = '#a07a1f'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#1c1408';
  ctx.font = 'bold 14px "Times New Roman", serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(cell.numeral || '', mid, top - 18.5);
}

// 處刑台的支柱（台面以下到地面，鐵箍）與兩根斜撐（台面本身是地形）
function drawScaffoldPosts(ctx, p) {
  ctx.save();
  for (const x of p.posts) {
    ctx.fillStyle = '#4a2f1a';
    ctx.fillRect(x - 6, p.y + 18, 12, 580 - p.y - 18);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(x - 6, p.y + 18, 2, 580 - p.y - 18);
    ctx.fillStyle = '#2b2b30';
    for (const y of [p.y + 40, 540]) ctx.fillRect(x - 7, y, 14, 4);
  }
  ctx.strokeStyle = '#3f2816';
  ctx.lineWidth = 7;
  const [a, b] = p.posts;
  ctx.beginPath(); ctx.moveTo(a, p.y + 90); ctx.lineTo(a + 34, p.y + 18); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(b, p.y + 90); ctx.lineTo(b - 34, p.y + 18); ctx.stroke();
  ctx.restore();
}

// 台上砍頭的木樁：年輪、砍痕、血跡
function drawChoppingBlock(ctx, p) {
  const x = p.block, y = p.y;
  ctx.save();
  ctx.fillStyle = '#5d3b20';
  ctx.fillRect(x - 18, y - 22, 36, 22);
  ctx.fillStyle = '#8a5d36';
  ellipse(ctx, x, y - 22, 18, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(60,36,16,0.8)'; ctx.lineWidth = 1;
  ellipse(ctx, x, y - 22, 11, 3); ctx.stroke();
  ellipse(ctx, x, y - 22, 5, 1.5); ctx.stroke();
  ctx.fillStyle = 'rgba(127,29,29,0.75)';
  ellipse(ctx, x + 6, y - 21, 6, 2); ctx.fill();
  ctx.fillRect(x + 9, y - 21, 2.5, 9);
  ctx.strokeStyle = 'rgba(30,18,8,0.8)'; ctx.lineWidth = 1.5;
  for (const dx of [-10, -4]) { ctx.beginPath(); ctx.moveTo(x + dx, y - 24); ctx.lineTo(x + dx + 3, y - 18); ctx.stroke(); }
  ctx.restore();
}

// 小枝條：一小段彎彎的細枝，末端一片葉子（中間一條葉脈）
function drawTwigs(ctx, twigs) {
  for (const [x, y, dx, dy] of twigs) {
    const ex = x + dx, ey = y + dy;
    ctx.strokeStyle = '#4a311e';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + dx * 0.2, y + dy * 0.7, ex, ey); ctx.stroke();
    const a = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate(ex, ey);
    ctx.rotate(a);
    ctx.fillStyle = '#3f8f3a';
    ctx.beginPath(); ctx.ellipse(5, 0, 6, 3.4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(16,50,20,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(10, 0); ctx.stroke();
    ctx.restore();
  }
}

// 牆上的洞：拱形的洞口，裡面越深越黑，外面一圈岩石的邊、洞頂一點碎石的陰影
function drawBurrows(ctx, holes) {
  for (const h of holes) {
    const { x0, x1, top, bottom } = h;
    const w = x1 - x0;
    const peak = (x0 + x1) / 2 + (h.lean || 0);
    ctx.save();
    archPath(ctx, h);
    const g = ctx.createRadialGradient(peak, bottom - (bottom - top) * 0.35, 8, peak, bottom - (bottom - top) * 0.35, w * 0.75);
    g.addColorStop(0, '#020103');
    g.addColorStop(0.7, '#0c0810');
    g.addColorStop(1, '#1c1620');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = '#4a4550';
    ctx.lineWidth = 9;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(140,132,146,0.35)';   // 岩石邊上的亮面
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.clip();
    const sh = ctx.createLinearGradient(0, top, 0, top + 60);   // 洞頂往裡面的陰影
    sh.addColorStop(0, 'rgba(0,0,0,0.6)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(x0, top, w, 60);
    ctx.restore();
  }
}

function polyPath(ctx, poly) {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
}

// 樹幹：中間亮、兩側暗，順著樹幹收窄的樹皮紋，上半段被樹冠遮成陰影
function drawTrunk(ctx, poly) {
  const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  ctx.save();
  polyPath(ctx, poly);
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, '#24170e');
  g.addColorStop(0.35, '#5a3b24');
  g.addColorStop(0.55, '#4a311e');
  g.addColorStop(1, '#1e130b');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.clip();
  // 樹皮紋：從頂端的寬度一路對到底部的寬度
  const half = poly.length / 2;
  const topL = poly[half - 1][0], topR = poly[half][0], botL = poly[0][0], botR = poly[poly.length - 1][0];
  ctx.strokeStyle = 'rgba(20,12,6,0.45)';
  ctx.lineWidth = 2;
  for (let k = 1; k < 9; k++) {
    const t = k / 9;
    const xt = topL + (topR - topL) * t, xb = botL + (botR - botL) * t;
    ctx.beginPath();
    ctx.moveTo(xt, y0);
    ctx.bezierCurveTo(xt + (k % 2 ? 6 : -6), y0 + (y1 - y0) * 0.35, xb + (k % 2 ? -8 : 8), y0 + (y1 - y0) * 0.7, xb, y1);
    ctx.stroke();
  }
  // 樹冠底下的陰影
  const shade = ctx.createLinearGradient(0, y0, 0, y0 + 220);
  shade.addColorStop(0, 'rgba(8,16,10,0.85)');
  shade.addColorStop(1, 'rgba(8,16,10,0)');
  ctx.fillStyle = shade;
  ctx.fillRect(x0, y0, x1 - x0, 220);
  ctx.restore();
}

// 樹冠：深色的底、一團團有立體感的葉子、亮面、葉片的斑點，越往下越暗（讓樹枝和狙擊手看得清楚）
function drawCanopy(ctx, clumps) {
  ctx.fillStyle = '#0d2414';
  for (const [x, y, r] of clumps) { ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.fill(); }
  for (const [x, y, r] of clumps) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.1, x, y, r);
    g.addColorStop(0, '#3f7a35');
    g.addColorStop(0.7, '#25552a');
    g.addColorStop(1, '#173d1f');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // 葉片斑點（固定的偽亂數，每次畫出來都一樣）
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const [x, y, r] of clumps) {
    for (let k = 0; k < r * 0.9; k++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.9;
      const lx = x + Math.cos(a) * d, ly = y + Math.sin(a) * d;
      const up = Math.sin(a) < 0;   // 上半部的葉子比較亮
      ctx.fillStyle = up && rnd() < 0.6 ? 'rgba(140,190,90,0.35)' : 'rgba(8,30,14,0.4)';
      ctx.beginPath(); ctx.ellipse(lx, ly, 4, 2.2, rnd() * Math.PI, 0, Math.PI * 2); ctx.fill();
    }
  }
  // 底部的陰影：clip 在樹冠的範圍裡
  const top = Math.min(...clumps.map(([, y, r]) => y - r)), bottom = Math.max(...clumps.map(([, y, r]) => y + r + 5));
  ctx.save();
  ctx.beginPath();
  for (const [x, y, r] of clumps) { ctx.moveTo(x + r + 5, y); ctx.arc(x, y, r + 5, 0, Math.PI * 2); }
  ctx.clip();
  const shade = ctx.createLinearGradient(0, top, 0, bottom);
  shade.addColorStop(0, 'rgba(6,18,10,0)');
  shade.addColorStop(0.5, 'rgba(6,18,10,0.15)');
  shade.addColorStop(1, 'rgba(6,18,10,0.6)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, top, ctx.canvas.width, bottom - top);
  ctx.restore();
}
