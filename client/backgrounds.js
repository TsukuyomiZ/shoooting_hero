// 地圖主題（level.theme）的靜態背景：每個主題只畫一次（Renderer.background 第一次用到才畫）。
// 主題跟地圖機制無關：森林（forest）是樹影重重、小心擊發、古樹之庭共用的；沒寫主題 = 黃昏（dusk）
export const BACKGROUNDS = {
  dusk: buildDuskBackground,
  forest: buildForestBackground,
  jungle: buildJungleBackground,
};

const canvasOf = (W, H) => {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  return c;
};

// 黃昏天空 + 太陽 + 遠山
function buildDuskBackground(W, H) {
  const c = canvasOf(W, H);
  const ctx = c.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#2b1e3f');
  sky.addColorStop(0.45, '#7a3f5c');
  sky.addColorStop(0.75, '#e0834a');
  sky.addColorStop(1, '#f3b06a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  const sun = ctx.createRadialGradient(780, 300, 10, 780, 300, 150);
  sun.addColorStop(0, 'rgba(255,235,180,0.95)');
  sun.addColorStop(0.3, 'rgba(255,190,120,0.5)');
  sun.addColorStop(1, 'rgba(255,150,100,0)');
  ctx.fillStyle = sun;
  ctx.beginPath(); ctx.arc(780, 300, 150, 0, Math.PI * 2); ctx.fill();
  const layers = [
    { color: 'rgba(60,30,60,0.55)', base: 520, amp: 120, seed: 3 },
    { color: 'rgba(40,20,45,0.75)', base: 600, amp: 90, seed: 7 },
  ];
  for (const L of layers) {
    ctx.fillStyle = L.color;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 16) {
      ctx.lineTo(x, L.base - Math.abs(Math.sin(x * 0.011 * L.seed) * L.amp) - Math.abs(Math.sin(x * 0.037 + L.seed) * 25));
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }
  return c;
}

// 森林：深綠的天空、斜射的光、遠方的樹影
function buildForestBackground(W, H) {
  const c = canvasOf(W, H);
  const ctx = c.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0d1f1c');
  sky.addColorStop(0.5, '#1f3d31');
  sky.addColorStop(0.8, '#4b6f45');
  sky.addColorStop(1, '#8aa45e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // 光束
  for (const [x, w] of [[160, 60], [330, 40], [520, 80], [700, 50]]) {
    const g = ctx.createLinearGradient(x, 0, x - 200, H);
    g.addColorStop(0, 'rgba(250,250,200,0.16)');
    g.addColorStop(1, 'rgba(250,250,200,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + w, 0); ctx.lineTo(x + w - 260, H); ctx.lineTo(x - 260, H); ctx.closePath(); ctx.fill();
  }
  // 遠方的樹影（兩層）
  const layers = [
    { color: 'rgba(20,48,36,0.55)', trunk: 'rgba(20,40,30,0.5)', base: 470, seed: 3 },
    { color: 'rgba(12,32,24,0.8)', trunk: 'rgba(12,28,20,0.75)', base: 540, seed: 7 },
  ];
  for (const L of layers) {
    for (let x = -20; x < W; x += 70 + ((x * L.seed) % 40)) {
      const h = 160 + Math.abs(Math.sin(x * 0.05 * L.seed)) * 120;
      ctx.fillStyle = L.trunk;
      ctx.fillRect(x - 6, L.base - h * 0.4, 12, H);
      ctx.fillStyle = L.color;
      ctx.beginPath(); ctx.ellipse(x, L.base - h * 0.55, 40 + (x % 20), h * 0.35, 0, 0, Math.PI * 2); ctx.fill();
    }
  }
  // 飄浮的光點
  for (let i = 0; i < 40; i++) {
    const x = (i * 263) % W, y = 80 + (i * 137) % (H - 250);
    ctx.fillStyle = `rgba(217,249,157,${0.15 + (i % 5) * 0.08})`;
    ctx.beginPath(); ctx.arc(x, y, 1.5 + (i % 3), 0, Math.PI * 2); ctx.fill();
  }
  return c;
}

// 叢林：深綠的樹海、垂下來的藤影、水面上的霧
function buildJungleBackground(W, H) {
  const c = canvasOf(W, H);
  const ctx = c.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#071a12');
  sky.addColorStop(0.45, '#123826');
  sky.addColorStop(0.8, '#2f5a36');
  sky.addColorStop(1, '#4f7a46');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);
  // 遠方的樹幹（兩層）與垂下來的藤影
  const layers = [
    { trunk: 'rgba(12,36,22,0.55)', leaf: 'rgba(20,56,32,0.55)', seed: 5 },
    { trunk: 'rgba(6,24,14,0.8)', leaf: 'rgba(10,38,22,0.75)', seed: 11 },
  ];
  for (const L of layers) {
    for (let x = -10; x < W; x += 90 + ((x * L.seed) % 50)) {
      const w = 14 + ((x * L.seed) % 18);
      ctx.fillStyle = L.trunk;
      ctx.fillRect(x - w / 2, 0, w, H);
      ctx.strokeStyle = L.leaf;
      ctx.lineWidth = 2;
      for (let k = 0; k < 2; k++) {
        const vx = x + 20 + k * 26, len = 160 + ((x + k * 37) % 220);
        ctx.beginPath(); ctx.moveTo(vx, 0); ctx.quadraticCurveTo(vx + 12, len / 2, vx - 4, len); ctx.stroke();
      }
    }
  }
  // 大片的葉子剪影（畫面兩側）
  ctx.fillStyle = 'rgba(8,30,16,0.85)';
  for (const [x, y, r, a] of [[30, 300, 90, 0.6], [-10, 470, 110, -0.3], [990, 260, 80, 2.4], [1020, 420, 100, 3.3], [520, 40, 70, 1.4]]) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(-r, 0); ctx.quadraticCurveTo(0, -r * 0.45, r, 0); ctx.quadraticCurveTo(0, r * 0.45, -r, 0); ctx.fill();
    ctx.restore();
  }
  // 水面上的霧
  const mist = ctx.createLinearGradient(0, 520, 0, 660);
  mist.addColorStop(0, 'rgba(200,230,200,0)');
  mist.addColorStop(1, 'rgba(200,230,200,0.22)');
  ctx.fillStyle = mist;
  ctx.fillRect(0, 520, W, 140);
  // 螢火蟲
  for (let i = 0; i < 36; i++) {
    const x = (i * 211) % W, y = 120 + (i * 149) % (H - 300);
    ctx.fillStyle = `rgba(217,249,157,${0.12 + (i % 5) * 0.07})`;
    ctx.beginPath(); ctx.arc(x, y, 1.4 + (i % 3), 0, Math.PI * 2); ctx.fill();
  }
  return c;
}
