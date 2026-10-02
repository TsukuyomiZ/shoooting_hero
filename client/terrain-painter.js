import { HARD, PLATFORM } from '../shared/terrain.js';

// 把地形遮罩畫成圖：草皮、土壤、坑洞焦黑邊、樹皮（古樹）、平台。只在地形改變時重繪（爆炸時只重繪局部）。
export class TerrainPainter {
  // opts.platformStyle：平台的畫法（預設 = 長青苔的石頭；'wood' = 樹枝）
  constructor(terrain, opts = {}) {
    this.terrain = terrain;
    this.platformStyle = opts.platformStyle || 'stone';
    this.withered = false;   // 古樹倒下：樹皮變成枯灰色
    this.canvas = document.createElement('canvas');
    this.canvas.width = terrain.w;
    this.canvas.height = terrain.h;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(terrain.w, terrain.h);
    this.version = -1;
    this.sync();
  }

  // 地形版本變了（開場、重連整份重建）就整張重畫
  sync() {
    if (this.version === this.terrain.version) return;
    this.paintRect(0, 0, this.terrain.w - 1, this.terrain.h - 1);
    this.version = this.terrain.version;
  }

  setWithered(v) {
    if (this.withered === v) return;
    this.withered = v;
    this.paintRect(0, 0, this.terrain.w - 1, this.terrain.h - 1);
  }

  // 爆炸後只重畫受影響的矩形
  repaintRect(r, margin = 14) {
    const t = this.terrain;
    this.paintRect(
      Math.max(0, r.x0 - margin), Math.max(0, r.y0 - margin),
      Math.min(t.w - 1, r.x1 + margin), Math.min(t.h - 1, r.y1 + margin),
    );
    this.version = t.version;
  }

  paintRect(x0, y0, x1, y1) {
    const { w, h, mask, holes } = this.terrain;
    const d = this.img.data;
    const near = holes.filter(hh => hh.x + hh.r + 9 >= x0 && hh.x - hh.r - 9 <= x1 && hh.y + hh.r + 9 >= y0 && hh.y - hh.r - 9 <= y1);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const i = py * w + px;
        const o = i * 4;
        if (!mask[i]) { d[o + 3] = 0; continue; }
        const n = hash(px, py);
        if (mask[i] === HARD) { this.paintBark(d, o, px, py, i, near); continue; }
        if (mask[i] === PLATFORM) { this.paintPlatform(d, o, px, py, i, n); continue; }

        let scorched = false;
        for (const hh of near) {
          const dx = px + 0.5 - hh.x, dy = py + 0.5 - hh.y;
          if (dx * dx + dy * dy <= (hh.r + 8) * (hh.r + 8)) { scorched = true; break; }
        }
        let grass = false;
        if (!scorched) {
          for (let k = 1; k <= 8; k++) {
            if (py - k < 0 || !mask[(py - k) * w + px]) { grass = true; break; }
          }
        }
        let edge = false;
        if (!scorched && !grass) {
          for (let k = 1; k <= 2; k++) {
            if (px - k < 0 || !mask[i - k] || px + k >= w || !mask[i + k] || py + k >= h || !mask[(py + k) * w + px]) { edge = true; break; }
          }
        }

        let r, g, b;
        if (scorched) { r = 42 + n * 16; g = 30 + n * 10; b = 20 + n * 8; }
        else if (grass) { r = 70 + n * 25; g = 165 + n * 25; b = 70 + n * 15; }
        else {
          r = 123 + (n - 0.5) * 30; g = 79 + (n - 0.5) * 20; b = 46 + (n - 0.5) * 16;
          if (edge) { r *= 0.62; g *= 0.62; b *= 0.62; }
        }
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    this.ctx.putImageData(this.img, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  }

  // 平台（不可破壞、子彈穿得過）：頂端一層草皮，身體是長青苔的石頭、稍微透明，不會留下焦痕
  paintPlatform(d, o, px, py, i, n) {
    if (this.platformStyle === 'wood') { this.paintBranch(d, o, px, py, i, n); return; }
    if (this.platformStyle === 'vine') { this.paintVineBridge(d, o, px, py, i, n); return; }
    const { w, h, mask } = this.terrain;
    let top = 0;
    while (top < 6 && py - top - 1 >= 0 && mask[i - (top + 1) * w] === PLATFORM) top++;
    let r, g, b, a = 255;
    if (top < 5) { r = 78 + n * 25; g = 172 + n * 25; b = 74 + n * 15; }
    else {
      const moss = hash(px >> 2, py >> 2) > 0.62;
      r = moss ? 70 + n * 20 : 104 + n * 22; g = moss ? 112 + n * 20 : 100 + n * 18; b = moss ? 60 + n * 12 : 88 + n * 16;
      const bottom = py + 2 >= h || mask[i + 2 * w] !== PLATFORM || mask[i - 2] !== PLATFORM || mask[i + 2] !== PLATFORM;
      if (bottom) { r *= 0.6; g *= 0.6; b *= 0.6; }
      a = 215;
    }
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
  }

  // 樹枝平台（platformStyle: 'wood'）：頂面一條亮色的木頭，下面是橫向木紋的樹皮，下緣加深
  paintBranch(d, o, px, py, i, n) {
    const { w, h, mask } = this.terrain;
    let top = 0;
    while (top < 3 && py - top - 1 >= 0 && mask[i - (top + 1) * w] === PLATFORM) top++;
    const bottom = py + 2 >= h || mask[i + 2 * w] !== PLATFORM;
    const grain = hash(px >> 4, py);
    let k = (0.82 + 0.3 * grain) * (0.92 + 0.16 * n);
    if ((py + (px >> 5)) % 5 === 0) k *= 0.75;   // 橫向的木紋
    if (top < 2) k = 1.3 + 0.1 * n;              // 頂面被踩亮的那層
    else if (bottom) k *= 0.55;
    d[o] = 118 * k; d[o + 1] = 80 * k; d[o + 2] = 48 * k; d[o + 3] = 255;
  }

  // 藤蔓橋（platformStyle: 'vine'）：好幾股藤蔓斜斜地絞在一起，頂面一層被踩亮的綠，下緣加深，偶爾冒出一片葉子
  paintVineBridge(d, o, px, py, i, n) {
    const { w, h, mask } = this.terrain;
    let top = 0;
    while (top < 3 && py - top - 1 >= 0 && mask[i - (top + 1) * w] === PLATFORM) top++;
    const bottom = py + 2 >= h || mask[i + 2 * w] !== PLATFORM;
    const strand = (px + py * 2) % 14;               // 斜的股
    let r = 74, g = 104, b = 38;
    if (strand < 2) { r = 40; g = 58; b = 22; }       // 股與股之間的縫
    else if (strand < 7) { r = 96; g = 128; b = 48; }
    else { r = 112; g = 88; b = 46; }                // 夾在中間的褐色老藤
    let k = 0.86 + 0.24 * n;
    if (top < 2) { r = 120; g = 170; b = 70; k = 1 + 0.1 * n; }
    else if (bottom) k *= 0.55;
    if (!bottom && top >= 2 && hash(px >> 3, py >> 2) > 0.93) { r = 132; g = 190; b = 72; }   // 葉子
    d[o] = r * k; d[o + 1] = g * k; d[o + 2] = b * k; d[o + 3] = 255;
  }

  // 樹皮：順著樹幹往右上斜的溝紋 + 細長的木紋，表面邊緣加深；被炸過的地方留下焦痕
  paintBark(d, o, px, py, i, near) {
    const { w, h, mask } = this.terrain;
    const grain = hash(px, py >> 3);
    const patch = hash(px >> 3, py >> 5);
    const groove = (px + (py >> 1)) % 11 < 2;
    let k = (0.8 + 0.3 * grain) * (0.9 + 0.2 * patch) * (groove ? 0.62 : 1);
    let edge = false;
    for (let s = 1; s <= 3 && !edge; s++) {
      if (px - s < 0 || !mask[i - s] || py - s < 0 || !mask[i - s * w] || (py + s < h && !mask[i + s * w])) edge = true;
    }
    if (edge) k *= 0.55;
    for (const hh of near) {
      const dx = px + 0.5 - hh.x, dy = py + 0.5 - hh.y;
      if (dx * dx + dy * dy <= (hh.r + 4) * (hh.r + 4)) { k *= 0.6; break; }
    }
    let r = 104 * k, g = 72 * k, b = 46 * k;
    if (this.withered) { const avg = (r + g + b) / 3; r = g = b = avg * 0.95; }
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }
}

// 穩定的雜訊：同一個像素永遠同一個值，重繪不會閃
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = ((h ^ (h >>> 13)) * 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
