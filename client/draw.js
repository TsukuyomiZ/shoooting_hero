// Canvas 繪圖小工具
export const FONT = '"Microsoft JhengHei", "Noto Sans TC", "PingFang TC", sans-serif';

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function text(ctx, str, x, y, o = {}) {
  ctx.save();
  ctx.font = `${o.bold ? 'bold ' : ''}${o.size || 14}px ${FONT}`;
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.baseline || 'alphabetic';
  if (o.outline) {
    ctx.lineWidth = o.outlineWidth || 3;
    ctx.strokeStyle = o.outline;
    ctx.lineJoin = 'round';
    ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = o.color || '#fff';
  ctx.fillText(str, x, y);
  ctx.restore();
}

// 血條：整條的長度 = 原本的上限（maxHp + 被中毒鎖住的 poisonLock），鎖住的那段在右邊畫成灰色
export function drawHpBar(ctx, x, y, w, h, e, fill, bg) {
  const lock = e.poisonLock || 0;
  const full = Math.max(1, e.maxHp + lock);
  drawBar(ctx, x, y, w, h, e.hp / full, fill, bg);
  if (lock <= 0) return;
  ctx.save();
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.clip();
  const gx = x + w * e.maxHp / full;
  ctx.fillStyle = '#6b7280';
  ctx.fillRect(gx, y, x + w - gx, h);
  ctx.strokeStyle = 'rgba(30,30,40,0.55)';   // 斜紋：一看就知道是「鎖住」不是「空的」
  ctx.lineWidth = 1;
  for (let sx = gx - h; sx < x + w; sx += 4) { ctx.beginPath(); ctx.moveTo(sx, y + h); ctx.lineTo(sx + h, y); ctx.stroke(); }
  ctx.restore();
}

export function drawBar(ctx, x, y, w, h, ratio, fill, bg) {
  ratio = Math.max(0, Math.min(1, ratio));
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = bg || 'rgba(0,0,0,0.6)';
  ctx.fill();
  if (ratio > 0) {
    roundRect(ctx, x, y, Math.max(h, w * ratio), h, h / 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();
}
