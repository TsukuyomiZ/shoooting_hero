// 可破壞地形：一張 Uint8Array 遮罩
//   0 = 空、1 = 土（可破壞）、2 = 樹皮（不可破壞，Boss 的樹幹）、
//   3 = 平台（不可破壞；子彈與身體都穿得過，只有從上面落下來時站得住——可以從下面跳上去）、
//   4 = 鐘乳石（洞穴天花板垂下來的；跟樹皮一樣擋子彈與身體、炸不壞，只會整根掉下來，見 dropStalactite 與 shared/cave.js）
// 自己做多邊形掃描填色與圓形挖洞，不依賴 canvas 反鋸齒，所以伺服器（Node）與每個瀏覽器算出來的結果完全一樣。
export const SOIL = 1;
export const HARD = 2;
export const PLATFORM = 3;
export const STALACTITE = 4;

export class Terrain {
  // opts.hard = 不可破壞的多邊形；opts.platforms = 可穿透的平台（頂面要是水平的）；
  // opts.maxX = 角色能走到的最右邊（古樹之庭：玩家碰不到樹幹）；
  // opts.vines = 可以攀爬的藤蔓 [{ x, top, bottom }]（不是遮罩的一部分，子彈與身體都穿得過，見 Entity.updateVine）；
  // opts.platformCover = 平台是這一隊的掩體（例如 'enemies'）：別隊的飛行物打不穿平台（撞到就爆炸），這一隊的照樣穿過（見 blocksShot）；
  // opts.stalactites = 鐘乳石的多邊形（尖端朝下，每根的 x 範圍不重疊）；掉下來的記在 fallen（第幾根）
  constructor(w, h, polygons, opts = {}) {
    this.w = w;
    this.h = h;
    this.polygons = polygons;
    this.hardPolygons = opts.hard || [];
    this.platformPolygons = opts.platforms || [];
    this.maxX = opts.maxX ?? w;
    this.vines = opts.vines || [];
    this.platformCover = opts.platformCover || null;
    // 每根鐘乳石：多邊形、x 範圍、尖端（最低的那一點，掉下來時從這裡開始落）
    this.stalactites = (opts.stalactites || []).map(poly => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, tip = poly[0];
      for (const p of poly) {
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]);
        if (p[1] > tip[1]) tip = p;
      }
      return { poly, x0, x1, y0, tip: { x: tip[0], y: tip[1] } };
    });
    this.fallen = new Set();
    this.mask = new Uint8Array(w * h);
    this.holes = [];          // 已挖過的洞 {x, y, r}，用來同步 / 重建
    this.version = 0;         // 每次改變 +1，讓畫面知道要重繪
    this.fillPolygons();
  }

  // 掃描線填色：像素中心 (x+0.5, y+0.5) 在多邊形內（even-odd）就是實體。平台、鐘乳石、樹皮依序蓋在土上面
  fillPolygons() {
    this.mask.fill(0);
    for (const poly of this.polygons) this.fillPolygon(poly, SOIL);
    for (const poly of this.platformPolygons) this.fillPolygon(poly, PLATFORM);
    this.stalactites.forEach((s, k) => { if (!this.fallen.has(k)) this.fillPolygon(s.poly, STALACTITE); });
    for (const poly of this.hardPolygons) this.fillPolygon(poly, HARD);
    this.version++;
  }

  // from 不是 null 時只改原本是 from 的像素（拿掉鐘乳石用：被天花板蓋住的那段還是天花板）
  fillPolygon(poly, value, from = null) {
    const { w, h, mask } = this;
    const xs = [];
    let minY = Infinity, maxY = -Infinity;
    for (const [, y] of poly) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(h - 1, Math.ceil(maxY));
    for (let py = y0; py <= y1; py++) {
      const yc = py + 0.5;
      xs.length = 0;
      for (let i = 0, n = poly.length; i < n; i++) {
        const [ax, ay] = poly[i];
        const [bx, by] = poly[(i + 1) % n];
        if (ay === by) continue;
        if ((yc >= ay && yc < by) || (yc >= by && yc < ay)) {
          xs.push(ax + (yc - ay) * (bx - ax) / (by - ay));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
        const xb = Math.min(w, Math.ceil(xs[k + 1] - 0.5));
        for (let px = xa; px < xb; px++) if (from === null || mask[py * w + px] === from) mask[py * w + px] = value;
      }
    }
  }

  at(x, y) {
    const px = Math.floor(x), py = Math.floor(y);
    if (px < 0 || px >= this.w || py < 0 || py >= this.h) return 0;
    return this.mask[py * this.w + px];
  }

  // 擋得住子彈與身體的地形（土、樹皮、鐘乳石）。平台不算：子彈穿得過，人也能從下面跳上去
  isSolid(x, y) {
    const v = this.at(x, y);
    return v === SOIL || v === HARD || v === STALACTITE;
  }

  // 擋得住 team 這一隊的飛行物：實心地形；平台是別隊的掩體（platformCover）時平台也擋（小心擊發的樹枝擋得住玩家的子彈）
  blocksShot(x, y, team) {
    const v = this.at(x, y);
    if (v === SOIL || v === HARD || v === STALACTITE) return true;
    return v === PLATFORM && this.platformCover !== null && team !== this.platformCover;
  }

  isHard(x, y) { return this.at(x, y) === HARD; }
  isPlatform(x, y) { return this.at(x, y) === PLATFORM; }

  // 腳底在 (x, y) 的角色，腳下那一格撐不撐得住他：實心地形一定撐得住；
  // 平台只有腳還在平台上面（腳底那一格不是平台）時才撐得住——從下面往上跳、或卡在平台裡的人會穿過去
  supports(x, y) {
    const below = this.at(x, y + 1);
    if (below === SOIL || below === HARD || below === STALACTITE) return true;
    return below === PLATFORM && this.at(x, y) !== PLATFORM;
  }

  // 從畫面上方落下的東西（無差別轟炸的飛彈）在 x 這一行的出發高度：畫面最上面是一層薄薄的天花板（樹皮 / 岩石，厚度不超過 maxDepth，
  // 例如洞穴的天花板）就從它下面出發（下面接著鐘乳石的話就從鐘乳石開始，馬上撞到它）；不然照 y 不變（一般地圖、整根樹幹的那幾行）
  skyStart(x, y, maxDepth = 80) {
    if (this.at(x, 0) !== HARD) return y;
    for (let py = 1; py <= maxDepth; py++) if (this.at(x, py) !== HARD) return Math.max(y, py + 0.5);
    return y;
  }

  // 這一列從左邊數過來第一個樹皮像素的 x（沒有就回傳 w）：古樹撞擊從樹幹表面伸出來用
  hardEdgeX(y) {
    const py = Math.floor(y);
    if (py < 0 || py >= this.h) return this.w;
    const row = py * this.w;
    for (let px = 0; px < this.w; px++) if (this.mask[row + px] === HARD) return px;
    return this.w;
  }

  // 挖出一個圓形坑（爆炸）；只挖得掉土，樹皮、平台、鐘乳石不會被挖掉。回傳受影響的矩形，供畫面局部重繪。
  carve(cx, cy, r) {
    const { w, h, mask } = this;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - cy;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - cx;
        const i = py * w + px;
        if (dx * dx + dy * dy <= r2 && mask[i] === SOIL) mask[i] = 0;
      }
    }
    this.holes.push({ x: cx, y: cy, r });
    this.version++;
    return { x0, y0, x1, y1 };
  }

  // (x, y) 這一格是第幾根鐘乳石（不是鐘乳石 = -1）
  stalactiteAt(x, y) {
    if (this.at(x, y) !== STALACTITE) return -1;
    return this.stalactites.findIndex((s, k) => !this.fallen.has(k) && x >= s.x0 && x <= s.x1);
  }

  // 第 k 根鐘乳石有沒有任何一格在圓 (cx, cy, r) 裡（爆炸波及到）
  stalactiteInCircle(k, cx, cy, r) {
    const s = this.stalactites[k];
    if (!s || this.fallen.has(k) || cx + r < s.x0 || cx - r > s.x1 || cy + r < s.y0 || cy - r > s.tip.y) return false;
    const x0 = Math.max(Math.floor(s.x0), Math.floor(cx - r)), x1 = Math.min(Math.ceil(s.x1), Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(this.h - 1, Math.ceil(cy + r));
    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - cy;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - cx;
        if (dx * dx + dy * dy <= r * r && this.at(px, py) === STALACTITE) return true;
      }
    }
    return false;
  }

  // 第 k 根鐘乳石整根掉下來：從遮罩拿掉（被天花板蓋住的那段還是天花板）。回傳要重畫的矩形；已經掉了回傳 null
  dropStalactite(k) {
    const s = this.stalactites[k];
    if (!s || this.fallen.has(k)) return null;
    this.fallen.add(k);
    this.fillPolygon(s.poly, 0, STALACTITE);
    this.version++;
    return {
      x0: Math.max(0, Math.floor(s.x0)), y0: Math.max(0, Math.floor(s.y0)),
      x1: Math.min(this.w - 1, Math.ceil(s.x1)), y1: Math.min(this.h - 1, Math.ceil(s.tip.y)),
    };
  }

  // 用一份洞的清單重建地形（新加入 / 重連時同步用）。已經掉下來的鐘乳石（fallen）不補回去；快照裡的 fallen 由地圖機制的 restore 套
  reset(holes = []) {
    this.holes = [];
    this.fillPolygons();
    for (const hole of holes) this.carve(hole.x, hole.y, hole.r);
  }
}
