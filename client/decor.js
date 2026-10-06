// 地圖上純裝飾的圖案（關卡的 decor，不影響物理）：先畫成圖。back 畫在水之後、地形之前；front 畫在地形之後、角色之前。
// 大樹（樹影重重、小心擊發）：trunk = 樹幹多邊形，canopy = 樹冠一團團的葉子 [x, y, 半徑]，
// twigs = 樹枝上長出來的小枝條 [x, y, dx, dy]（從 (x, y) 長到 (x + dx, y + dy)，末端一片葉子）；
// canopyFront = 蓋在地形上面的樹冠（小心擊發的樹幹是地形，樹冠要畫在它前面才看得到）
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
  let front = null;
  if (decor.canopyFront) {
    front = layer();
    drawCanopy(front.getContext('2d'), decor.canopyFront);
  }
  return { back, front };
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
