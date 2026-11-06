import { SOIL, HARD, PLATFORM, STALACTITE, BOULDER } from '../shared/physics/terrain.js';

// 把地形遮罩畫成圖：草皮、土壤、坑洞焦黑邊、樹皮（古樹）、平台、鐘乳石、巨石。只在地形改變時重繪（爆炸時只重繪局部）。
export class TerrainPainter {
  // opts.platformStyle：平台的畫法（預設 = 長青苔的石頭；'wood' = 樹枝、'vine' = 藤蔓橋、'rock' = 岩台、'plank' = 木板（處刑台）、'mushroom' = 蘑菇傘）
  // opts.style：土與實心地形的畫法（預設 = 草皮 + 土、樹皮；'cave' = 洞穴的岩土、岩石天花板；'prison' = 監獄的石板地、石頭天花板，吊燈不畫）
  // opts.hardLook：不可破壞的地形的畫法（預設 = 樹皮 / 岩石；'ground' = 跟土一樣畫草皮與土，只是不會有焦痕：炸不出坑）
  constructor(terrain, opts = {}) {
    this.terrain = terrain;
    this.platformStyle = opts.platformStyle || 'stone';
    this.style = opts.style || null;
    this.hardLook = opts.hardLook || null;
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
        if (this.style === 'prison') { this.paintPrison(d, o, px, py, i, n, near); continue; }
        const hard = mask[i] === HARD || mask[i] === BOULDER;   // 巨石（對戰中放上去的，例如超巨石）照炸不壞的岩石畫，地圖畫面再畫上它自己的樣子
        if (hard && this.hardLook !== 'ground') {
          if (this.style === 'cave') this.paintRock(d, o, px, py, i, n);
          else this.paintBark(d, o, px, py, i, near);
          continue;
        }
        if (mask[i] === PLATFORM) { this.paintPlatform(d, o, px, py, i, n); continue; }
        if (mask[i] === STALACTITE) { this.paintStalactite(d, o, px, py, i, n); continue; }
        if (this.style === 'cave') { this.paintCaveFloor(d, o, px, py, i, n, hard ? [] : near); continue; }

        let scorched = false;
        if (!hard) for (const hh of near) {
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
    if (this.platformStyle === 'rock') { this.paintLedge(d, o, px, py, i, n); return; }
    if (this.platformStyle === 'plank') { this.paintPlank(d, o, px, py, i, n); return; }
    if (this.platformStyle === 'mushroom') { this.paintMushroomCap(d, o, px, py, i, n); return; }
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

  // 蘑菇傘（platformStyle: 'mushroom'）：紅色的菇傘、一顆顆白斑點，頂面被踩亮，下緣一圈米色的菇褶（菇柄由 decor.mushrooms 畫）
  paintMushroomCap(d, o, px, py, i, n) {
    const { w, h, mask } = this.terrain;
    let top = 0;
    while (top < 3 && py - top - 1 >= 0 && mask[i - (top + 1) * w] === PLATFORM) top++;
    let below = 0;
    while (below < 4 && py + below + 1 < h && mask[i + (below + 1) * w] === PLATFORM) below++;
    let r = 196, g = 58, b = 48;
    const cx = (px >> 4) * 16 + 8 + Math.round((hash(px >> 4, py >> 4) - 0.5) * 6);
    const cy = (py >> 4) * 16 + 8;
    if (hash((px >> 4) + 7, py >> 4) > 0.45 && (px - cx) * (px - cx) + (py - cy) * (py - cy) < 12) { r = 246; g = 236; b = 222; }   // 白斑點
    let k = 0.9 + 0.16 * n;
    if (below < 3) { r = 232; g = 214; b = 180; k = 0.8 + 0.1 * n; }   // 菇褶
    else if (top < 2) k = 1.22 + 0.08 * n;
    d[o] = Math.min(255, r * k); d[o + 1] = Math.min(255, g * k); d[o + 2] = Math.min(255, b * k); d[o + 3] = 255;
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

  // 洞穴的地面（style 'cave'，可破壞的土）：灰褐色的岩土、一塊塊的碎石，表面一層淡淡的塵土（沒有草），邊緣加深；被炸過留下焦痕
  paintCaveFloor(d, o, px, py, i, n, near) {
    const { w, h, mask } = this.terrain;
    let scorched = false;
    for (const hh of near) {
      const dx = px + 0.5 - hh.x, dy = py + 0.5 - hh.y;
      if (dx * dx + dy * dy <= (hh.r + 8) * (hh.r + 8)) { scorched = true; break; }
    }
    let top = false;
    for (let k = 1; k <= 4 && !top; k++) if (py - k < 0 || !mask[(py - k) * w + px]) top = true;
    let edge = false;
    for (let k = 1; k <= 2 && !edge; k++) {
      if (px - k < 0 || !mask[i - k] || px + k >= w || !mask[i + k] || py + k >= h || !mask[(py + k) * w + px]) edge = true;
    }
    const pebble = hash(px >> 3, py >> 2) > 0.8;
    let r, g, b;
    if (scorched) { r = 34 + n * 14; g = 28 + n * 10; b = 24 + n * 8; }
    else if (top) { r = 128 + n * 20; g = 116 + n * 18; b = 100 + n * 16; }
    else {
      const k = pebble ? 1.18 : 1;
      r = (86 + (n - 0.5) * 24) * k; g = (76 + (n - 0.5) * 20) * k; b = (68 + (n - 0.5) * 18) * k;
      if (edge) { r *= 0.62; g *= 0.62; b *= 0.62; }
    }
    d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
  }

  // 洞穴的岩石（style 'cave' 的實心地形，例如天花板）：深灰的岩層，橫向的層理，靠近空氣的那一面加深
  paintRock(d, o, px, py, i, n) {
    const { w, h, mask } = this.terrain;
    const strata = hash(px >> 5, py >> 2);
    let k = (0.82 + 0.25 * strata) * (0.92 + 0.16 * n);
    if ((py + (px >> 4)) % 7 === 0) k *= 0.78;
    let edge = false;
    for (let s = 1; s <= 3 && !edge; s++) {
      if ((py + s < h && !mask[i + s * w]) || (px - s >= 0 && !mask[i - s]) || (px + s < w && !mask[i + s])) edge = true;
    }
    if (edge) k *= 0.6;
    d[o] = 66 * k; d[o + 1] = 60 * k; d[o + 2] = 58 * k; d[o + 3] = 255;
  }

  // 鐘乳石：淡色的石灰岩，直的紋路，兩側邊緣加深，越靠近尖端越亮（濕濕的）
  paintStalactite(d, o, px, py, i, n) {
    const { w, mask } = this.terrain;
    let edge = false;
    for (let s = 1; s <= 2 && !edge; s++) if (mask[i - s] !== STALACTITE || mask[i + s] !== STALACTITE) edge = true;
    const streak = hash(px, py >> 4) > 0.75 ? 0.82 : 1;
    let below = 0;
    while (below < 30 && mask[i + (below + 1) * w] === STALACTITE) below++;
    const wet = below < 12 ? 1.12 : 1;
    let k = (0.9 + 0.14 * n) * streak * wet;
    if (edge) k *= 0.62;
    d[o] = 168 * k; d[o + 1] = 158 * k; d[o + 2] = 144 * k; d[o + 3] = 255;
  }

  // 岩台（platformStyle: 'rock'）：頂面一條被踩亮的岩面，下面是粗糙的岩石，下緣加深
  paintLedge(d, o, px, py, i, n) {
    const { w, h, mask } = this.terrain;
    let top = 0;
    while (top < 3 && py - top - 1 >= 0 && mask[i - (top + 1) * w] === PLATFORM) top++;
    const bottom = py + 2 >= h || mask[i + 2 * w] !== PLATFORM;
    let k = (0.85 + 0.25 * hash(px >> 2, py >> 2)) * (0.92 + 0.16 * n);
    if (top < 2) k = 1.35 + 0.1 * n;
    else if (bottom) k *= 0.55;
    d[o] = 92 * k; d[o + 1] = 84 * k; d[o + 2] = 78 * k; d[o + 3] = 255;
  }

  // 監獄（style 'prison'，處刑監獄）：地面 = 頂面一層磨亮的石板、下面一層層錯開的石磚；天花板 = 大塊的暗石；
  // 平台照 platformStyle（處刑台的木板）；吊燈（STALACTITE）不畫——地圖畫面照它的形狀畫鏈子與燭台。可破壞的土（沒有用到）照石磚畫、被炸過的地方焦黑
  paintPrison(d, o, px, py, i, n, near) {
    const { w, h, mask } = this.terrain;
    const m = mask[i];
    if (m === STALACTITE) { d[o + 3] = 0; return; }
    if (m === PLATFORM) { this.paintPlatform(d, o, px, py, i, n); return; }
    let rgb;
    if (py < 200) {   // 天花板：大塊的石頭，靠近空氣的那一面加深
      const row = Math.floor(py / 16), off = row % 2 ? 26 : 0;
      if (py % 16 < 2 || (px + off) % 52 < 2) rgb = [18, 17, 22];
      else {
        let k = (0.8 + 0.3 * hash(Math.floor((px + off) / 52), row + 99)) * (0.92 + 0.16 * n);
        for (let s = 1; s <= 3; s++) if (py + s < h && !mask[i + s * w]) { k *= 0.6; break; }
        rgb = [54 * k, 52 * k, 62 * k];
      }
    } else {
      let top = 0;
      while (top < 6 && py - top - 1 >= 0 && mask[i - (top + 1) * w]) top++;
      let edge = false;
      for (let k = 1; k <= 2 && !edge; k++) {
        if (px - k < 0 || !mask[i - k] || px + k >= w || !mask[i + k] || py + k >= h || !mask[(py + k) * w + px]) edge = true;
      }
      if (top < 3) rgb = [128 + n * 14, 126 + n * 14, 136 + n * 14];   // 磨亮的石板面
      else if (top < 5) rgb = [40, 38, 46];                           // 石板底下的縫
      else {
        const row = Math.floor(py / 14), off = row % 2 ? 18 : 0;
        const yy = py % 14, xx = (px + off) % 36;
        if (yy < 2 || xx < 2) rgb = [30, 28, 34];                     // 灰泥
        else {
          let k = (0.8 + 0.32 * hash(Math.floor((px + off) / 36), row)) * (0.94 + 0.12 * n) * Math.max(0.5, 1 - (py - 590) / 320);
          if (yy < 4) k *= 1.12;                                      // 每塊磚的上緣亮一點
          if (edge) k *= 0.62;
          rgb = hash(px >> 2, py >> 2) > 0.93 ? [60 * k, 84 * k, 58 * k] : [76 * k, 74 * k, 86 * k];   // 偶爾一點青苔
        }
      }
      if (m === SOIL) {
        for (const hh of near) {
          const dx = px + 0.5 - hh.x, dy = py + 0.5 - hh.y;
          if (dx * dx + dy * dy <= (hh.r + 8) * (hh.r + 8)) { rgb = [34 + n * 14, 30 + n * 10, 30 + n * 8]; break; }
        }
      }
    }
    d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
  }

  // 木板平台（platformStyle: 'plank'，處刑台）：一片片直立的木板（板縫、木紋），頂面那根橫木被踩亮、下緣加深，上下各一排鐵釘
  paintPlank(d, o, px, py, i, n) {
    const { w, h, mask } = this.terrain;
    let top = 0;
    while (top < 30 && py - top - 1 >= 0 && mask[i - (top + 1) * w] === PLATFORM) top++;
    let below = 0;
    while (below < 30 && py + below + 1 < h && mask[i + (below + 1) * w] === PLATFORM) below++;
    const bx = Math.floor(px / 14);
    let k = (0.84 + 0.26 * hash(bx, 7)) * (0.92 + 0.16 * n);
    if ((py + bx * 3) % 6 === 0) k *= 0.86;   // 木紋
    if (px % 14 === 0) k *= 0.5;              // 板縫
    if (top < 2) k = 1.32 + 0.1 * n;          // 頂面被踩亮
    else if (top < 4) k *= 0.7;               // 頂面那根橫木的下緣
    else if (below < 2) k *= 0.5;
    if (px % 14 === 7 && (top === 6 || below === 3)) { d[o] = 150; d[o + 1] = 148; d[o + 2] = 156; d[o + 3] = 255; return; }   // 鐵釘
    d[o] = 120 * k; d[o + 1] = 82 * k; d[o + 2] = 48 * k; d[o + 3] = 255;
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
