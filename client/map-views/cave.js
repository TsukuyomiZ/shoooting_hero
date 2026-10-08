import { CONFIG } from '../../shared/config.js';
import { TORCH_H, flameOf, lightTorch } from '../../shared/cave.js';

// 洞穴（岩穴）的地圖畫面：火把、照明（洞裡很暗，只有火光、玩家身邊、爆炸的閃光照得到）、鐘乳石掉下來的演出。
// 規則在 shared/cave.js；掛勾的說明見 index.js
const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
// 照明半徑（px）：出生點那支微弱的火把、點燃的火把、玩家自己身邊（看得到自己的角色）、爆炸的閃光
const LIGHT = { faint: 150, torch: 270, player: 56, burst: 120 };
const DARK = 'rgba(5,4,10,0.92)';   // 照不到的地方（敵人、鐘乳石都幾乎看不見，但一樣打得到）
const BURST_LIFE = 0.55;            // 爆炸照亮周圍幾秒
const IGNITE_TIME = 0.6;            // 火把剛點燃時火光從小到大的時間

export const cave = {
  type: 'cave',

  // bursts = 爆炸的閃光 [{ x, y, t0 }]；ignite = 火把第幾支 → 點燃的時間（火光慢慢變大）
  create: () => ({ bursts: [], ignite: new Map() }),

  // 閃光過了就丟掉；點燃的火把偶爾飄出火星
  update(c, dt) {
    const s = c.state;
    s.bursts = s.bursts.filter(b => c.time - b.t0 < BURST_LIFE);
    const S = c.match && c.match.mechState;
    if (!S) return;
    S.def.torches.forEach((t, i) => {
      if (!S.lit[i] || Math.random() > dt * 3) return;
      const f = flameOf(t);
      c.fx.particle({ x: f.x + (Math.random() - 0.5) * 4, y: f.y - 6, vx: (Math.random() - 0.5) * 20, vy: -40 - Math.random() * 30,
        life: 0.7, maxLife: 0.7, size: 1.4, color: '#fdba74', gravity: -10 });
    });
  },

  // 這一下打下來的鐘乳石（地形重畫、碎石、裂開的聲音）、點燃的火把；有爆炸 / 打到東西就閃一下照亮周圍
  showEvent(c, ev, made) {
    const T = c.match.terrain;
    for (const k of ev.falls || []) {
      const s = T.stalactites[k];
      if (!s) continue;
      c.fx.repaint({ x0: s.x0, y0: s.y0, x1: s.x1, y1: s.tip.y });
      c.fx.sound('crack', { x: s.tip.x });
      c.fx.particles((s.x0 + s.x1) / 2, s.y0 + 14, 14, { speed: 110, life: 0.7, size: 3, color: '#a8a29e', gravity: 700 });
      c.fx.shake(4);
    }
    for (const i of ev.lights || []) ignite(c, i);
    if (ev.type === 'explode' || ev.type === 'bounce' || ev.type === 'pierce') c.state.bursts.push({ x: ev.x, y: ev.y, t0: c.time });
    if (ev.type === 'explode' && isRock(c, ev)) {   // 鐘乳石摔碎在地上 / 砸到人
      c.fx.particles(ev.x, ev.y, 16, { speed: 160, life: 0.6, size: 3, color: '#d6d3d1', gravity: 800 });
    }
  },

  // 玩家走過去點燃火把（伺服器廣播的 pickup，包括他自己）
  onPickup(c, e, msg) {
    if (msg.type !== 'torch') return;
    lightTorch(c.match, msg.torch);
    ignite(c, msg.torch);
  },

  drawScene: drawTorches,
  drawProjectile: drawFallingRock,

  // 洞裡是暗的：角色畫完之後蓋一層遮光（瞄準線、飛行物、特效、飄字畫在上面，看得到）
  shaded: () => true,
  drawShade,

  // 「敵人剩餘」同一行標點燃了幾支火把（名單框才不會變高，蓋到天花板的鐘乳石）
  hud(c, [label, color]) {
    const S = c.match.mechState;
    const lit = S ? S.lit.filter(Boolean).length : 0;
    return [[`${label}　火把 ${lit} / ${S ? S.lit.length : 0}`, color]];
  },
};

// 點燃第 i 支火把的演出（打到旁邊、走過去碰到都一樣）
function ignite(c, i) {
  const t = c.match.mechState.def.torches[i];
  if (!t) return;
  c.state.ignite.set(i, c.time);
  const f = flameOf(t);
  c.fx.sound('ignite', { x: f.x });
  c.fx.particles(f.x, f.y, 18, { speed: 90, life: 0.6, size: 3, color: '#fb923c', gravity: -120 });
  c.fx.float({ cx: f.x, y: t.y, h: TORCH_H + 10, id: `torch${i}` }, '火把點燃！', '#fdba74', 15);
}

// 這個事件是不是掉下來的鐘乳石（半路才出現的飛行物，見 shared/volley.js）
function isRock(c, ev) {
  const p = c.projectiles.find(q => q.i === ev.p);
  return !!(p && p.added && p.weapon.id === 'stalactite');
}

// ---------- 繪圖 ----------

// 火把：木柄 + 纏著布的頭；亮著的畫火焰（照明在 drawShade）
function drawTorches(ctx, c) {
  const S = c.match.mechState;
  if (!S) return;
  S.def.torches.forEach((t, i) => {
    ctx.save();
    ctx.fillStyle = '#5b3a1e';
    ctx.fillRect(t.x - 2, t.y - TORCH_H + 6, 4, TORCH_H - 6);
    ctx.fillStyle = '#3f2a17';
    ctx.fillRect(t.x - 5, t.y - 3, 10, 3);                       // 插在地上的底座
    ctx.fillStyle = S.lit[i] ? '#7c2d12' : '#44403c';
    ctx.beginPath(); ctx.ellipse(t.x, t.y - TORCH_H + 4, 4.5, 6, 0, 0, Math.PI * 2); ctx.fill();   // 布頭
    if (S.lit[i]) drawFlame(ctx, c, t, i);
    ctx.restore();
  });
}

function drawFlame(ctx, c, t, i) {
  const f = flameOf(t);
  const t0 = c.state.ignite.get(i);
  const grow = t0 === undefined ? 1 : Math.min(1, Math.max(0, (c.time - t0) / IGNITE_TIME));
  const k = (0.55 + 0.45 * grow) * (t.faint ? 0.75 : 1);
  const wob = Math.sin(c.time * 13 + i * 2.1) * 1.5;
  const hgt = (16 + Math.sin(c.time * 9 + i) * 2.5) * k;
  ctx.fillStyle = 'rgba(251,146,60,0.9)';
  ctx.beginPath();
  ctx.moveTo(f.x - 6 * k, f.y);
  ctx.quadraticCurveTo(f.x - 7 * k, f.y - hgt * 0.5, f.x + wob, f.y - hgt);
  ctx.quadraticCurveTo(f.x + 7 * k, f.y - hgt * 0.5, f.x + 6 * k, f.y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(254,240,138,0.95)';
  ctx.beginPath(); ctx.ellipse(f.x + wob * 0.4, f.y - hgt * 0.3, 3 * k, 6 * k, 0, 0, Math.PI * 2); ctx.fill();
}

// 掉下來的鐘乳石：照它原本的形狀畫，尖端在飛行物的位置
function drawFallingRock(ctx, c, p) {
  if (!p.added || p.weapon.id !== 'stalactite') return false;
  const s = c.match.terrain.stalactites[p.k];
  if (!s) return true;
  const dx = p.x - s.tip.x, dy = p.y - s.tip.y;
  ctx.save();
  ctx.translate(dx, dy);
  ctx.fillStyle = '#a8a29e';
  ctx.strokeStyle = '#57534e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  s.poly.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(87,83,78,0.6)';   // 直的紋路
  ctx.lineWidth = 1;
  for (const fx of [0.35, 0.6]) {
    const x = s.x0 + (s.x1 - s.x0) * fx;
    ctx.beginPath(); ctx.moveTo(x, s.y0 + 8); ctx.lineTo(s.tip.x + (x - s.tip.x) * 0.3, s.tip.y - 18); ctx.stroke();
  }
  ctx.restore();
  return true;
}

// 照明的光源：點燃的火把（出生點那支比較小、剛點燃的慢慢變大，會閃爍）、活著的玩家身邊、爆炸的閃光
function lightsOf(c) {
  const out = [];
  const S = c.match.mechState;
  S.def.torches.forEach((t, i) => {
    if (!S.lit[i]) return;
    const f = flameOf(t);
    const t0 = c.state.ignite.get(i);
    const grow = t0 === undefined ? 1 : Math.min(1, Math.max(0, (c.time - t0) / IGNITE_TIME));
    const flicker = 1 + 0.035 * Math.sin(c.time * 11 + i * 1.7) + 0.02 * Math.sin(c.time * 23 + i);
    out.push({ x: f.x, y: f.y - 6, r: (t.faint ? LIGHT.faint : LIGHT.torch) * (0.25 + 0.75 * grow) * flicker, warm: true });
  });
  for (const e of c.match.players) if (e.alive) out.push({ x: e.cx, y: e.cy, r: LIGHT.player });
  for (const b of c.state.bursts) {
    const age = (c.time - b.t0) / BURST_LIFE;
    if (age >= 0 && age < 1) out.push({ x: b.x, y: b.y, r: LIGHT.burst * (1 - age * age) });
  }
  return out;
}

// 遮光：整片暗下來，光源的地方挖出柔和的圓（destination-out），再在火把周圍疊一點暖色；
// 還沒點燃的火把淡淡地畫在遮光上面（知道要去點哪裡）
function drawShade(ctx, c) {
  const S = c.match && c.match.mechState;
  if (!S) return;
  const L = c.layer ? c.layer() : null;   // 遮光先畫在暫存畫布上（挖出光的圓），再整張疊上去
  if (!L || !L.ctx) return;
  const g = L.ctx;
  const lights = lightsOf(c);
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H);
  g.fillStyle = DARK;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'destination-out';
  for (const l of lights) {
    const grad = g.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.85)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(l.x, l.y, l.r, 0, Math.PI * 2); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  ctx.drawImage(L.canvas, 0, 0);
  for (const l of lights) {
    if (!l.warm) continue;
    const grad = ctx.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r * 0.8);
    grad.addColorStop(0, 'rgba(255,170,80,0.16)');
    grad.addColorStop(1, 'rgba(255,170,80,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(l.x, l.y, l.r * 0.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save();
  ctx.globalAlpha = 0.5;
  S.def.torches.forEach((t, i) => {
    if (S.lit[i]) return;
    ctx.fillStyle = '#78716c';
    ctx.fillRect(t.x - 2, t.y - TORCH_H + 6, 4, TORCH_H - 6);
    ctx.beginPath(); ctx.ellipse(t.x, t.y - TORCH_H + 4, 4.5, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(251,146,60,${0.5 + 0.3 * Math.sin(c.time * 3 + i)})`;   // 一點點餘燼
    ctx.beginPath(); ctx.arc(t.x, t.y - TORCH_H + 2, 1.6, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();
}
