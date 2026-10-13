import { CONFIG } from '../../shared/core/config.js';
import { TORCH_H, flameOf, lightTorch, torchLevel, torchLight, lightScale, inShadow } from '../../shared/maps/cave.js';

// 洞穴（岩穴）的地圖畫面：火把、照明（洞裡很暗，只有火光、玩家身邊、爆炸的閃光照得到）、鐘乳石掉下來的演出。
// 火把的亮度與光圈照 shared/maps/cave.js（每過一輪暗一格、3 輪後熄滅；亮度照 match.round 推，伺服器的陰影判定也是同一個光圈）。
// 規則在 shared/maps/cave.js；掛勾的說明見 index.js
const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
// 照明半徑（px）：玩家自己身邊（看得到自己的角色）、爆炸的閃光。火把的光圈在 shared/maps/cave.js（torchLight）
const LIGHT = { player: 56, burst: 120 };
const DARK = 'rgba(5,4,10,0.92)';   // 照不到的地方（敵人、鐘乳石都幾乎看不見，但一樣打得到）
const BURST_LIFE = 0.55;            // 爆炸照亮周圍幾秒
const IGNITE_TIME = 0.6;            // 火把剛點燃時火焰從小到大的時間
const IGNITE_FROM = 0.55;           // 剛點燃的火焰從最後大小的幾成開始長（補滿的從現在的大小開始，見 ignite）
const GLOW_RATE = 4;                // 畫面上的光圈每秒往該有的大小靠近多少（點燃時從 0 長大、變暗 / 熄滅時慢慢縮小）

export const cave = {
  type: 'cave',

  // bursts = 爆炸的閃光 [{ x, y, t0 }]；ignite = 火把第幾支 → { t0: 點燃 / 補滿的時間, from: 火焰從多大開始長（見 flameScale）}；
  // glow = 火把第幾支 → 畫面上的光圈半徑（照亮度慢慢變過去）；level = 上一步看到的每支火把亮度（看哪支剛燒完、點燃前亮不亮）
  create: () => ({ bursts: [], ignite: new Map(), glow: new Map(), level: null }),

  musicTrack: (c) => (c.match.fever > 0 ? 'caveFever' : 'cave'),   // 洞穴地圖的曲子，狂熱生效後換洞穴的狂熱版（地心探險沿用）

  // 閃光過了就丟掉；光圈照亮度慢慢變大 / 縮小，剛燒完的冒一陣煙；亮著的火把偶爾飄出火星（越暗越少）
  update(c, dt) {
    const s = c.state;
    s.bursts = s.bursts.filter(b => c.time - b.t0 < BURST_LIFE);
    const S = c.match && c.match.mechState;
    if (!S) return;
    const levels = S.def.torches.map((t, i) => torchLevel(c.match, i));
    S.def.torches.forEach((t, i) => {
      const lv = levels[i];
      const want = torchLight(t, lv).r;
      const g = s.glow.has(i) ? s.glow.get(i) : want;   // 第一次看到（開場、重連）：直接是該有的大小
      const next = g + (want - g) * Math.min(1, dt * GLOW_RATE);
      s.glow.set(i, want === 0 && next < 0.5 ? 0 : next);   // 熄了：縮到看不見就歸零（等比縮小永遠不會剛好到 0）
      if (s.level && s.level[i] > 0 && lv === 0) snuff(c, i);
      if (!lv || Math.random() > dt * 3 * lightScale(lv)) return;
      const f = flameOf(t);
      c.fx.particle({ x: f.x + (Math.random() - 0.5) * 4, y: f.y - 6, vx: (Math.random() - 0.5) * 20, vy: -40 - Math.random() * 30,
        life: 0.7, maxLife: 0.7, size: 1.4, color: '#fdba74', gravity: -10 });
    });
    s.level = levels;
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
    // 播到這裡 lit 已經照事件改成這一輪點燃的（replayCave）：點燃前的亮度看 update 上一步記下的
    for (const i of ev.lights || []) ignite(c, i, c.state.level ? c.state.level[i] || 0 : 0);
    if (ev.type === 'explode' || ev.type === 'bounce' || ev.type === 'pierce') c.state.bursts.push({ x: ev.x, y: ev.y, t0: c.time });
    if (ev.type === 'explode' && isRock(c, ev)) {   // 鐘乳石摔碎在地上 / 砸到人
      c.fx.particles(ev.x, ev.y, 16, { speed: 160, life: 0.6, size: 3, color: '#d6d3d1', gravity: 800 });
    }
  },

  // 玩家走過去點燃火把（伺服器廣播的 pickup，包括他自己）
  onPickup(c, e, msg) {
    if (msg.type !== 'torch') return;
    const was = torchLevel(c.match, msg.torch);
    lightTorch(c.match, msg.torch);
    ignite(c, msg.torch, was);
  },

  drawScene: drawTorches,
  drawProjectile: drawFallingRock,

  // 洞裡是暗的：角色畫完之後蓋一層遮光（瞄準線、飛行物、特效、飄字畫在上面，看得到）
  shaded: () => true,
  drawShade: (ctx, c) => drawShade(ctx, c),

  // 「敵人剩餘」同一行標亮著幾支火把（名單框才不會變高，蓋到天花板的鐘乳石）
  hud(c, [label, color]) {
    const S = c.match.mechState;
    const lit = S ? S.lit.filter((at, i) => torchLevel(c.match, i) > 0).length : 0;
    return [[`${label}　火把 ${lit} / ${S ? S.lit.length : 0}`, color]];
  },
};

// 點燃第 i 支火把的演出（打到旁邊、飛過去、走過去碰到都一樣）：光圈從 0 慢慢長大、火焰從小長大；
// 點燃前還亮著（was = 點燃前的亮度 > 0，變暗了）的是補滿：光圈、火焰都從現在的大小長回去（不會先變小）、飄「火把補滿！」。
// 燒完的（亮度 0，光圈可能還沒縮完）算重新點燃
function ignite(c, i, was) {
  const t = c.match.mechState.def.torches[i];
  if (!t) return;
  const refill = was > 0;
  const full = flameScale(c, i, torchLevel(c.match, i), null);
  const from = refill && full > 0 ? Math.min(1, flameScale(c, i, was) / full) : IGNITE_FROM;
  c.state.ignite.set(i, { t0: c.time, from });
  if (!refill) c.state.glow.set(i, 0);
  const f = flameOf(t);
  c.fx.sound('ignite', { x: f.x });
  c.fx.particles(f.x, f.y, 18, { speed: 90, life: 0.6, size: 3, color: '#fb923c', gravity: -120 });
  c.fx.float({ cx: f.x, y: t.y, h: TORCH_H + 10, id: `torch${i}` }, refill ? '火把補滿！' : '火把點燃！', '#fdba74', 15);
}

// 第 i 支火把燒完了（新的一輪開始、亮度掉到 0）：冒一陣煙、飄字（光圈在 update 裡慢慢縮掉）
function snuff(c, i) {
  const t = c.match.mechState.def.torches[i];
  if (!t) return;
  const f = flameOf(t);
  c.fx.particles(f.x, f.y - 4, 12, { speed: 40, life: 1.1, size: 3, color: '#78716c', gravity: -90 });
  c.fx.float({ cx: f.x, y: t.y, h: TORCH_H + 10, id: `torch${i}` }, '火把熄滅', '#a8a29e', 15);
}

// 這個事件是不是掉下來的鐘乳石（半路才出現的飛行物，見 shared/physics/volley.js）
function isRock(c, ev) {
  const p = c.projectiles.find(q => q.i === ev.p);
  return !!(p && p.added && p.weapon.id === 'stalactite');
}

// ---------- 繪圖 ----------

// 火把：木柄 + 纏著布的頭；亮著的畫火焰（越暗火焰越小；照明在 drawShade）
function drawTorches(ctx, c) {
  const S = c.match.mechState;
  if (!S) return;
  S.def.torches.forEach((t, i) => {
    const lv = torchLevel(c.match, i);
    ctx.save();
    ctx.fillStyle = '#5b3a1e';
    ctx.fillRect(t.x - 2, t.y - TORCH_H + 6, 4, TORCH_H - 6);
    ctx.fillStyle = '#3f2a17';
    ctx.fillRect(t.x - 5, t.y - 3, 10, 3);                       // 插在地上的底座
    ctx.fillStyle = lv > 0 ? '#7c2d12' : '#44403c';
    ctx.beginPath(); ctx.ellipse(t.x, t.y - TORCH_H + 4, 4.5, 6, 0, 0, Math.PI * 2); ctx.fill();   // 布頭
    if (lv > 0) drawFlame(ctx, c, t, i, lv);
    ctx.restore();
  });
}

// 火焰的大小（drawFlame 的倍率，不含出生點那支的 ×0.75）：剛點燃 / 補滿的 IGNITE_TIME 秒內從 ig.from 長到 1，再照亮度縮小。
// ig = 這支火把的點燃記錄（null = 長好了）
function flameScale(c, i, lv, ig = c.state.ignite.get(i)) {
  const grow = ig ? Math.min(1, Math.max(0, (c.time - ig.t0) / IGNITE_TIME)) : 1;
  const from = ig ? ig.from : 1;
  return (from + (1 - from) * grow) * (0.5 + 0.5 * lightScale(lv));
}

function drawFlame(ctx, c, t, i, lv) {
  const f = flameOf(t);
  const k = flameScale(c, i, lv) * (t.faint ? 0.75 : 1);
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

// 照明的光源：火把（光圈照 shared/maps/cave.js 的 torchLight：出生點那支比較小、越暗越小；畫面上照 update 算的 glow 慢慢變過去，會閃爍）、
// 活著的玩家身邊、爆炸的閃光
function lightsOf(c) {
  const out = [];
  const S = c.match.mechState;
  S.def.torches.forEach((t, i) => {
    const L = torchLight(t, torchLevel(c.match, i));
    const r = c.state.glow.has(i) ? c.state.glow.get(i) : L.r;
    if (!(r >= 1)) return;
    const flicker = 1 + 0.035 * Math.sin(c.time * 11 + i * 1.7) + 0.02 * Math.sin(c.time * 23 + i);
    out.push({ x: L.x, y: L.y, r: r * flicker, warm: true });
  });
  for (const e of c.match.players) if (e.alive) out.push({ x: e.cx, y: e.cy, r: LIGHT.player });
  for (const b of c.state.bursts) {
    const age = (c.time - b.t0) / BURST_LIFE;
    if (age >= 0 && age < 1) out.push({ x: b.x, y: b.y, r: LIGHT.burst * (1 - age * age) });
  }
  return out;
}

// 遮光：整片暗下來，光源的地方挖出柔和的圓（destination-out），再在火把周圍疊一點暖色；
// 熄著的火把淡淡地畫在遮光上面（知道要去點哪裡）；站在陰影裡的敵人（傷害加成）身上透出一圈紅光。
// aura(e) = 這個敵人要不要畫紅光（別的地圖畫面自己標陰影的，例如洞穴巨蠍只露發紅的雙眼）；
// more(g) = 額外的照明：在遮光的暫存畫布上用 destination-out 再挖掉一些地方（例如巨蠍巢穴：火把亮著的洞整個照亮）
export function drawShade(ctx, c, aura = () => true, more = null) {
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
  if (more) more(g);
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
    if (torchLevel(c.match, i) > 0) return;
    ctx.fillStyle = '#78716c';
    ctx.fillRect(t.x - 2, t.y - TORCH_H + 6, 4, TORCH_H - 6);
    ctx.beginPath(); ctx.ellipse(t.x, t.y - TORCH_H + 4, 4.5, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(251,146,60,${0.5 + 0.3 * Math.sin(c.time * 3 + i)})`;   // 一點點餘燼
    ctx.beginPath(); ctx.arc(t.x, t.y - TORCH_H + 2, 1.6, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();
  drawShadowAuras(ctx, c, aura);
}

// 站在陰影裡的敵人（造成的傷害 +CAVE.shadowDamagePct%，判定見 shared/maps/cave.js 的 inShadow）：上半身透出一圈會呼吸的紅光
function drawShadowAuras(ctx, c, aura) {
  const pulse = 0.28 + 0.1 * Math.sin(c.time * 4);
  for (const e of c.match.enemies) {
    if (!e.alive || !aura(e) || !inShadow(c.match, e.cx, e.cy)) continue;
    const x = e.cx, y = e.y - e.h * 0.68, r = Math.max(e.hw, 12) + 8;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(248,113,113,${pulse + 0.15})`);
    grad.addColorStop(0.5, `rgba(220,38,38,${pulse})`);
    grad.addColorStop(1, 'rgba(220,38,38,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
}
