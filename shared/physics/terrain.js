// 可破壞地形：一張 Uint8Array 遮罩
//   0 = 空、1 = 土（可破壞）、2 = 樹皮（不可破壞，Boss 的樹幹）、
//   3 = 平台（不可破壞；子彈與身體都穿得過，只有從上面落下來時站得住——可以從下面跳上去）、
//   4 = 鐘乳石（洞穴天花板垂下來的；跟樹皮一樣擋子彈與身體、炸不壞，只會整根掉下來，見 dropStalactite 與 shared/maps/cave.js）
//   5 = 巨石（對戰中才放上去的大石頭，例如獨眼巨人的超巨石；跟樹皮一樣擋子彈與身體、炸不壞，只會整塊拿掉，見 addBoulder / removeBoulder）
// 炸不壞的多邊形可以標成「子彈從下面打得穿」（passFromBelow，見 shotPasses；大地祭壇的斜坡）：遮罩照樣是樹皮，另外記在 underPass。
// 自己做多邊形掃描填色與圓形挖洞，不依賴 canvas 反鋸齒，所以伺服器（Node）與每個瀏覽器算出來的結果完全一樣。
export const SOIL = 1;
export const HARD = 2;
export const PLATFORM = 3;
export const STALACTITE = 4;
export const BOULDER = 5;

const SOLID = (v) => v === SOIL || v === HARD || v === STALACTITE || v === BOULDER;

// shotPasses「從底面進來」看上一個子步那一行往上幾 px（我抓的：子步最多 2 px、斜坡斜率 0.25，底面離上一個子步最多約 3 px；
// 從上面 / 旁邊進來的那一行往上是空的，上下兩道斜坡之間隔得比這遠很多）
const UNDER_REACH = 4;

export class Terrain {
  // opts.hard = 不可破壞的多邊形；opts.platforms = 可穿透的平台（頂面要是水平的）；
  // opts.maxX = 角色能走到的最右邊（古樹之庭：玩家碰不到樹幹）；
  // opts.vines = 可以攀爬的藤蔓 [{ x, top, bottom }]（不是遮罩的一部分，子彈與身體都穿得過，見 Entity.updateVine）；
  // opts.platformCover = 平台是這一隊的掩體（例如 'enemies'）：別隊的飛行物打不穿平台（撞到就爆炸），這一隊的照樣穿過（見 blocksShot）；
  // opts.stalactites = 鐘乳石的多邊形（尖端朝下，每根的 x 範圍不重疊）；掉下來的記在 fallen（第幾根）
  // opts.hard 裡帶 passFromBelow: true 的多邊形（陣列上的屬性，見 level.js 的 passFromBelow）= 子彈從下面打得穿：
  //   往上飛的飛行物穿過去、從上面落下來的照樣撞到（見 shotPasses）；角色照樣站得住、走得過、炸不壞（遮罩就是樹皮）
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
    // 子彈從下面打得穿的格子（1 = 是）：沒有這種多邊形 = null（其他地圖完全不碰）。樹皮挖不掉、不會變，建一次就好
    this.underPass = null;
    const under = this.hardPolygons.filter(poly => poly.passFromBelow);
    if (under.length) {
      this.underPass = new Uint8Array(w * h);
      for (const poly of under) this.fillPolygon(poly, 1, null, this.underPass);
    }
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
  // target = 填進哪一張遮罩（沒給 = 地形遮罩；underPass 用）
  fillPolygon(poly, value, from = null, target = this.mask) {
    const { w, h } = this;
    const mask = target;
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

  // 擋得住子彈與身體的地形（土、樹皮、鐘乳石、巨石）。平台不算：子彈穿得過，人也能從下面跳上去
  isSolid(x, y) {
    return SOLID(this.at(x, y));
  }

  // 擋得住 team 這一隊的飛行物：實心地形；平台是別隊的掩體（platformCover）時平台也擋（小心擊發的樹枝擋得住玩家的子彈）
  blocksShot(x, y, team) {
    const v = this.at(x, y);
    if (SOLID(v)) return true;
    return v === PLATFORM && this.platformCover !== null && team !== this.platformCover;
  }

  // 子彈從下面打得穿的地形（passFromBelow 的多邊形）：擋得住（blocksShot）的 (x, y) 這一格這一下放不放過去。
  // 從外面進來時往上飛（vy < 0）、而且是從底面進來的（上一個子步 (px, py) 在它底下：那一行往上 UNDER_REACH px 以內就是它）才放過去；
  // 上一個子步已經在裡面了也放過去（從下面穿進來、在裡面開始往下掉的，直到穿出去為止）；
  // 從上面落下來（從外面進來時 vy ≥ 0）、還在往上飛卻是從上表面 / 端面鑽進去的（往牆那邊、往上的角度比斜坡平的，11-05 我抓的）照樣撞到。
  // 只看位置與速度、不在飛行物上記狀態：伺服器、預覽、AI 試射算的都一樣
  shotPasses(x, y, px, py, vy) {
    if (!this.underPassAt(x, y)) return false;
    if (this.underPassAt(px, py)) return true;
    if (!(vy < 0)) return false;
    for (let k = 1; k <= UNDER_REACH; k++) if (this.underPassAt(px, py - k)) return true;
    return false;
  }

  underPassAt(x, y) {
    const u = this.underPass;
    if (u === null) return false;
    const px = Math.floor(x), py = Math.floor(y);
    if (px < 0 || px >= this.w || py < 0 || py >= this.h) return false;
    return u[py * this.w + px] === 1;
  }

  isHard(x, y) { return this.at(x, y) === HARD; }
  isPlatform(x, y) { return this.at(x, y) === PLATFORM; }

  // 腳底在 (x, y) 的角色，腳下那一格撐不撐得住他：實心地形一定撐得住；
  // 平台只有腳還在平台上面（腳底那一格不是平台）時才撐得住——從下面往上跳、或卡在平台裡的人會穿過去
  supports(x, y) {
    const below = this.at(x, y + 1);
    if (SOLID(below)) return true;
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

  // 放上一塊巨石（多邊形）：只填原本是空的像素（土、天花板、鐘乳石都不動），回傳要重畫的矩形。
  // 多邊形不要包到土：放上去之後才挖的坑會挖掉那些土，重建（reset 先挖洞、地圖機制再放巨石）時卻會被巨石填回去，兩邊就不一樣了
  addBoulder(poly) {
    this.fillPolygon(poly, BOULDER, 0);
    this.version++;
    return polyRect(this, poly);
  }

  // 拿掉一塊巨石（放的時候那個多邊形）：只清掉巨石的像素。回傳要重畫的矩形
  removeBoulder(poly) {
    this.fillPolygon(poly, 0, BOULDER);
    this.version++;
    return polyRect(this, poly);
  }

  // 用一份洞的清單重建地形（新加入 / 重連時同步用）。已經掉下來的鐘乳石（fallen）不補回去；快照裡的 fallen 由地圖機制的 restore 套。
  // 巨石不是關卡的地形：重建之後就沒了，由地圖機制的 restore 照快照再放回去
  reset(holes = []) {
    this.holes = [];
    this.fillPolygons();
    for (const hole of holes) this.carve(hole.x, hole.y, hole.r);
  }
}

// 多邊形的外框（夾在地圖範圍內）：重畫用的矩形 { x0, y0, x1, y1 }
function polyRect(t, poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return {
    x0: Math.max(0, Math.floor(x0)), y0: Math.max(0, Math.floor(y0)),
    x1: Math.min(t.w - 1, Math.ceil(x1)), y1: Math.min(t.h - 1, Math.ceil(y1)),
  };
}
