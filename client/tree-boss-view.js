import { CONFIG } from '../shared/config.js';
import { spawnTreant, leafOrigin, trunkLane, TREE_ACTION_NAMES } from '../shared/tree-boss.js';
import { clamp } from '../shared/utils.js';
import { roundRect } from './draw.js';

// 古樹之庭的客戶端：古樹回合的動畫腳本（照伺服器廣播的招式播）與古樹 / 樹妖 / 招式的繪圖。
const FPS = 60;
const BARK = '#5b3d27';

// ---------- 動畫腳本 ----------

// 古樹的回合：依序播放每一招（多人召喚的回合是「召喚 → 攻擊」兩招）。
// 每一招：預兆（標出目標平面、張嘴、閉眼、聚集落葉）→ 出招（撞擊 / 落葉照 shotScript 重播）→ 校正成伺服器結果。
// view.treeFx 給畫面用：{ action, t, plane, targetId, seeds }。
// 全部播完才換上伺服器預定的下一招（msg.boss.next）：舊的撞擊預告留到真的撞下去，新的預告在古樹回合之後才出現
export function* treeTurnScript(view, msg) {
  const eye = view.match.byId(msg.actorId);
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* treeStepScript(view, eye, step);
  view.treeFx = null;
  if (view.match.tree && msg.boss.next !== undefined) view.match.tree.next = msg.boss.next;
}

function* treeStepScript(view, eye, b) {
  const match = view.match;
  const T = CONFIG.TIMING;
  const fx = view.treeFx = { action: b.action, t: 0, plane: b.plane ?? null, targetId: b.targetId ?? null, seeds: [] };
  const cast = Math.round(T.bossCast * FPS);
  const planes = match.tree ? match.tree.def.planes : [];
  const name = TREE_ACTION_NAMES[b.action] || '';
  switch (b.action) {
    case 'summon': {
      const spawns = b.spawns || [];
      view.showBanner(spawns.length > 1 ? `古樹：${name} ×${spawns.length}！` : `古樹：${name}！`, '#fca5a5');
      const mouth = match.byId('mouth');
      yield { frames: Math.round(cast * 0.5) };
      // 嘴巴吐出種子（召喚幾隻就吐幾顆），落地長出樹妖
      const from = mouth ? { x: mouth.x - mouth.hw * 0.5, y: mouth.cy } : { x: 0, y: 0 };
      fx.seeds = spawns.map(s => ({ from, to: { x: s.x, y: s.y }, t: 0 }));
      const flight = cast - Math.round(cast * 0.5);
      for (let i = 1; i <= flight; i++) { for (const sd of fx.seeds) sd.t = i / flight; yield { frames: 1 }; }
      fx.seeds = [];
      for (const s of spawns) {
        const e = spawnTreant(match, s);
        e.deathHandled = !e.alive;
        view.spawnParticles(e.x, e.y - 10, 18, { speed: 150, life: 0.7, size: 4, color: '#65a30d', gravity: 400 });
        view.spawnParticles(e.x, e.y - 10, 10, { speed: 90, life: 0.6, size: 3, color: '#a16207', gravity: 300 });
        view.floatText(e, '樹妖出現！', '#fca5a5', 16);
      }
      break;
    }
    case 'trunk': {
      const pl = planes[b.plane];
      view.showBanner(`古樹：${name} → ${pl ? pl.name : ''}！`, '#fdba74');
      for (let i = 0; i < cast; i++) {   // 地面震動、樹幹那一側落下木屑
        if (i % 6 === 0) {
          view.shake = Math.max(view.shake, 3);
          if (pl) view.spawnParticles(match.terrain.hardEdgeX(pl.y - 18), pl.y - 18 + (Math.random() - 0.5) * 40, 3, { speed: 80, life: 0.6, size: 3, color: '#8b5a2b', gravity: 500 });
        }
        yield { frames: 1 };
      }
      fx.plane = null;   // 預兆結束，接著是真的樹幹
      break;
    }
    case 'leaves': {
      const target = match.byId(b.targetId);
      view.showBanner(`古樹：${name} → ${target ? target.name : ''}！`, '#bef264');
      const o = eye ? leafOrigin(eye) : null;
      for (let i = 0; i < cast; i++) {   // 葉子往眼睛前面聚集
        if (o && i % 3 === 0) {
          const a = Math.random() * Math.PI * 2, r = 50 + Math.random() * 30;
          view.particles.push({ x: o.x + Math.cos(a) * r, y: o.y + Math.sin(a) * r, vx: -Math.cos(a) * r * 2, vy: -Math.sin(a) * r * 2, life: 0.45, maxLife: 0.45, size: 3, color: Math.random() < 0.5 ? '#84cc16' : '#4d7c0f', gravity: 0 });
        }
        yield { frames: 1 };
      }
      break;
    }
    case 'meditate': {
      view.showBanner(`古樹：${name}`, '#86efac');
      yield { frames: Math.round(cast * 0.6) };
      if (eye && b.heal > 0) {
        eye.hp = Math.min(eye.maxHp, eye.hp + b.heal);
        view.floatText(eye, `+${b.heal}`, '#4ade80');
        view.spawnParticles(eye.x, eye.cy, 16, { speed: 90, life: 0.8, size: 3, color: '#86efac', gravity: -80 });
      }
      yield { frames: cast - Math.round(cast * 0.6) };
      break;
    }
    default:
      view.showBanner(TREE_ACTION_NAMES.idle, '#d9f99d');
      yield { frames: cast };
  }

  if (b.shot) {
    yield* view.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: T.settleDelay * FPS * 0.5 };
  }
}

// 古樹相關的死亡：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
export function onTreeDeath(view, e) {
  if (e.part === 'eye') {
    view.showBanner('古樹倒下了！', '#fde047');
    view.shake = Math.max(view.shake, 14);
    view.spawnParticles(e.x, e.cy, 40, { speed: 260, life: 1.2, size: 4, color: '#65a30d', gravity: 250 });
    if (view.painter) view.painter.setWithered(true);
    return true;
  }
  if (e.part === 'mouth') {   // 嘴巴打不壞，只會跟著古樹一起枯萎
    view.spawnParticles(e.x, e.cy, 20, { speed: 160, life: 0.8, size: 3, color: '#8b5a2b', gravity: 400 });
    return true;
  }
  if (e.deathCause === 'wither') {   // 樹妖跟著古樹枯萎
    view.spawnParticles(e.x, e.cy, 14, { speed: 80, life: 1.0, size: 3, color: '#a3a3a3', gravity: 120 });
    return true;
  }
  return false;
}

// ---------- 繪圖 ----------

// 樹冠與垂下來的藤蔓（地形之後、角色之前畫）＋ 預定撞擊的警示帶 ＋ 招式的預兆（目標平面、種子）
export function drawTreeScene(ctx, view) {
  const match = view.match;
  if (!match || !match.tree) return;
  const withered = view.painter && view.painter.withered;
  // 樹冠：樹幹頂端一叢一叢的葉子
  const clumps = [[880, 10, 70], [960, 30, 80], [1010, -10, 60], [820, 40, 46], [930, 90, 50], [1000, 110, 44]];
  for (const [x, y, r] of clumps) {
    ctx.fillStyle = withered ? 'rgba(90,84,72,0.9)' : 'rgba(34,84,40,0.95)';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = withered ? 'rgba(120,112,98,0.6)' : 'rgba(74,140,60,0.7)';
    ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.6, 0, Math.PI * 2); ctx.fill();
  }
  // 藤蔓
  ctx.strokeStyle = withered ? 'rgba(110,100,90,0.8)' : 'rgba(52,110,48,0.9)';
  ctx.lineWidth = 3;
  for (const [x, len] of [[836, 120], [866, 70], [812, 60]]) {
    ctx.beginPath();
    ctx.moveTo(x, 30);
    ctx.quadraticCurveTo(x - 10 + Math.sin(view.time * 1.3 + x) * 4, 30 + len / 2, x - 4, 30 + len);
    ctx.stroke();
  }

  const fx = view.treeFx;
  // 預定的古樹撞擊：玩家 / 樹妖的回合一直標著那條橫掃範圍（慢慢呼吸），讓玩家有機會躲開。
  // 古樹自己出撞擊的時候改由下面的快閃接手（撞完、播完才換成下一個預告）
  const next = match.tree.next;
  const eye = match.byId('eye');
  if (next && next.action === 'trunk' && next.plane != null && eye && eye.alive && !withered && !(fx && fx.action === 'trunk')) {
    drawTrunkBand(ctx, match, next.plane, 0.26 + 0.08 * Math.sin(view.time * 3), 0.85);
  }
  if (!fx) return;
  fx.t += 1 / FPS;
  // 古樹撞擊：出招的預兆，同一條範圍快速閃紅
  if (fx.action === 'trunk' && fx.plane != null) drawTrunkBand(ctx, match, fx.plane, 0.32 + 0.16 * Math.sin(fx.t * 14), 1);
  // 士兵召喚：嘴巴吐出的種子（拋物線）
  for (const { from, to, t } of fx.seeds || []) {
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t - Math.sin(t * Math.PI) * 90;
    ctx.fillStyle = '#a16207';
    ctx.beginPath(); ctx.ellipse(x, y, 6, 8, t * 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#65a30d';
    ctx.beginPath(); ctx.ellipse(x + 3, y - 7, 3, 5, 0.6, 0, Math.PI * 2); ctx.fill();
  }
}

// 古樹撞擊的紅色警示帶：範圍跟伺服器的樹幹一樣（trunkLane），從樹皮表面到地圖左邊
function drawTrunkBand(ctx, match, planeIdx, alpha, lineAlpha) {
  const lane = trunkLane(match, planeIdx);
  const edge = (y) => match.terrain.hardEdgeX(y);
  ctx.fillStyle = `rgba(239,68,68,${alpha})`;
  ctx.fillRect(lane.x0, lane.top, lane.x1 - lane.x0, lane.bottom - lane.top);
  ctx.strokeStyle = `rgba(252,165,165,${lineAlpha})`;
  ctx.setLineDash([10, 8]);
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(lane.x0, lane.top); ctx.lineTo(edge(lane.top), lane.top); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(lane.x0, lane.bottom); ctx.lineTo(edge(lane.bottom), lane.bottom); ctx.stroke();
  ctx.setLineDash([]);
}

// 古樹身上的眼睛 / 嘴巴
export function drawTreePart(ctx, e, view) {
  if (e.part === 'eye') drawEye(ctx, e, view);
  else drawMouth(ctx, e, view);
}

function lookPoint(e, view) {
  const match = view.match;
  const fx = view.treeFx;
  const target = (fx && fx.targetId && match.byId(fx.targetId)) || (view.currentId && match.byId(view.currentId));
  if (target && target.team === 'players' && target.alive) return { x: target.cx, y: target.cy };
  const alive = match.players.filter(p => p.alive);
  if (!alive.length) return null;
  const near = alive.reduce((a, b) => (Math.hypot(b.cx - e.x, b.cy - e.cy) < Math.hypot(a.cx - e.x, a.cy - e.cy) ? b : a));
  return { x: near.cx, y: near.cy };
}

function drawEye(ctx, e, view) {
  const x = e.x, y = e.cy, r = e.hw;
  const fx = view.treeFx;
  const hurt = e.hurtTimer > 0;
  // 閉眼：死掉，或閉目養神的預兆
  const closing = fx && fx.action === 'meditate' ? clamp(fx.t * 3, 0, 1) : 0;
  const lid = e.alive ? closing : 1;

  // 眼窩
  ctx.fillStyle = 'rgba(30,18,10,0.85)';
  ctx.beginPath(); ctx.ellipse(x, y, r + 7, r + 5, 0, 0, Math.PI * 2); ctx.fill();
  // 眼白
  ctx.save();
  ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.92, 0, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = hurt ? '#ffffff' : (e.alive ? '#f3ecd2' : '#9ca3af');
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  // 血絲：血越少越多
  const dmg = 1 - e.hp / e.maxHp;
  if (e.alive && dmg > 0.3) {
    ctx.strokeStyle = `rgba(220,38,38,${Math.min(0.8, dmg)})`;
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 6; k++) {
      const a = k * 1.05 + 0.3;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      ctx.lineTo(x + Math.cos(a + 0.2) * r * 0.55, y + Math.sin(a + 0.2) * r * 0.55);
      ctx.stroke();
    }
  }
  // 瞳孔：看著目前的目標
  if (e.alive) {
    const lp = lookPoint(e, view);
    let ox = -6, oy = 2;
    if (lp) {
      const dx = lp.x - x, dy = lp.y - y, d = Math.hypot(dx, dy) || 1;
      ox = dx / d * 8; oy = dy / d * 8;
    }
    const glow = fx && fx.action === 'leaves' ? 0.5 + 0.5 * Math.sin(fx.t * 20) : 0;
    ctx.fillStyle = glow > 0 ? `rgb(${190 + glow * 60},${200 + glow * 40},40)` : '#b45309';
    ctx.beginPath(); ctx.arc(x + ox, y + oy, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#facc15';
    ctx.beginPath(); ctx.arc(x + ox, y + oy, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1c1917';
    ctx.beginPath(); ctx.ellipse(x + ox, y + oy, 2.6, 8, 0, 0, Math.PI * 2); ctx.fill();
  }
  // 眼皮（樹皮色，從上往下蓋）
  if (lid > 0) {
    ctx.fillStyle = BARK;
    ctx.fillRect(x - r, y - r, r * 2, r * 2 * lid);
    ctx.strokeStyle = '#2b1a0e';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - r, y - r + r * 2 * lid);
    ctx.quadraticCurveTo(x, y - r + r * 2 * lid + 6, x + r, y - r + r * 2 * lid);
    ctx.stroke();
  }
  ctx.restore();
  // 眼框紋路
  ctx.strokeStyle = '#2b1a0e';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(x, y, r + 2, r * 0.92 + 2, 0, 0, Math.PI * 2); ctx.stroke();
}

function drawMouth(ctx, e, view) {
  const x = e.x, y = e.cy, hw = e.hw;
  const fx = view.treeFx;
  if (!e.alive) { drawShutMouth(ctx, e, true); return; }   // 古樹倒下：縫死
  // 張開的程度：被打到就闔起來、古樹回合結束再慢慢張開；召喚時張大，平常慢慢呼吸（只影響畫面）
  const target = e.closedTurns > 0 ? 0 : (fx && fx.action === 'summon' ? 1.25 : 0.85 + 0.1 * Math.sin(view.time * 2.2));
  e.viewOpen = e.viewOpen === undefined ? target : e.viewOpen + (target - e.viewOpen) * 0.2;
  if (e.viewOpen < 0.12) { drawShutMouth(ctx, e, false); return; }
  const oh = e.h / 2 * e.viewOpen;
  ctx.fillStyle = '#2b1a0e';
  ctx.beginPath(); ctx.ellipse(x, y, hw + 6, oh + 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = e.hurtTimer > 0 ? '#fecaca' : '#3b0a0a';
  ctx.beginPath(); ctx.ellipse(x, y, hw, oh, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(248,113,113,0.35)';
  ctx.beginPath(); ctx.ellipse(x, y + oh * 0.35, hw * 0.6, oh * 0.35, 0, 0, Math.PI * 2); ctx.fill();
  // 木頭牙齒
  ctx.fillStyle = '#d6c7a1';
  for (let k = 0; k < 5; k++) {
    const tx = x - hw * 0.8 + k * hw * 0.4;
    ctx.beginPath(); ctx.moveTo(tx - 5, y - oh + 2); ctx.lineTo(tx + 5, y - oh + 2); ctx.lineTo(tx, y - oh + 12); ctx.closePath(); ctx.fill();
    if (k < 4) {
      const bx = tx + hw * 0.2;
      ctx.beginPath(); ctx.moveTo(bx - 5, y + oh - 2); ctx.lineTo(bx + 5, y + oh - 2); ctx.lineTo(bx, y + oh - 11); ctx.closePath(); ctx.fill();
    }
  }
}

// 閉著的嘴：凸起的樹皮嘴唇 + 一道縫。被打閉上時嘴唇緊抿、會抖一下；古樹倒下（dead）就變灰、縫死
function drawShutMouth(ctx, e, dead) {
  const hw = e.hw, y = e.cy;
  const x = e.x + (!dead && e.hurtTimer > 0 ? Math.sin(e.hurtTimer * 60) * 2 : 0);
  const seam = () => {
    ctx.beginPath();
    ctx.moveTo(x - hw, y);
    for (let k = 1; k <= 6; k++) ctx.lineTo(x - hw + k * hw / 3, y + (k % 2 ? 4 : -4));
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = dead ? '#8a8178' : '#9a7552';
  ctx.lineWidth = 12;
  seam(); ctx.stroke();
  ctx.strokeStyle = '#1c1008';
  ctx.lineWidth = 3;
  seam(); ctx.stroke();
  if (dead) {
    ctx.strokeStyle = '#e7dcc0';
    ctx.lineWidth = 2;
    for (let k = 0; k < 5; k++) {
      const sx = x - hw * 0.8 + k * hw * 0.4;
      ctx.beginPath(); ctx.moveTo(sx - 2, y - 9); ctx.lineTo(sx + 2, y + 9); ctx.stroke();
    }
  } else {   // 牙尖從縫裡露出一點
    ctx.fillStyle = '#d6c7a1';
    for (let k = 0; k < 4; k++) {
      const tx = x - hw * 0.6 + k * hw * 0.4;
      ctx.beginPath(); ctx.moveTo(tx - 3, y - 2); ctx.lineTo(tx + 3, y - 2); ctx.lineTo(tx, y + 4); ctx.closePath(); ctx.fill();
    }
  }
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
}

// 樹妖：身體用 config 的 TREANT.color，頭上一叢葉子
export function drawTreant(ctx, e, hurt) {
  const s = e.h / 30;
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.scale(s, s);
  ctx.fillStyle = hurt ? '#ffffff' : e.color;
  roundRect(ctx, -8, -24, 16, 24, 5); ctx.fill();
  ctx.strokeStyle = 'rgba(40,20,10,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-3, -22); ctx.lineTo(-4, -4); ctx.moveTo(3, -20); ctx.lineTo(4, -2); ctx.stroke();
  // 根腳
  ctx.fillStyle = hurt ? '#eee' : '#5b3d27';
  ctx.fillRect(-8, -3, 5, 3);
  ctx.fillRect(3, -3, 5, 3);
  // 葉冠
  ctx.fillStyle = hurt ? '#fff' : '#3f8f2f';
  for (const [dx, dy, r] of [[-6, -27, 6], [0, -31, 7], [6, -27, 6], [0, -24, 6]]) {
    ctx.beginPath(); ctx.arc(dx, dy, r, 0, Math.PI * 2); ctx.fill();
  }
  // 發光的眼睛
  ctx.fillStyle = '#fde047';
  ctx.beginPath(); ctx.arc(e.facing * 2 - 3, -17, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(e.facing * 2 + 3, -17, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 樹妖手上的長矛（在角色座標系裡、已經轉到瞄準角度）
export function drawSpearHeld(ctx) {
  ctx.fillStyle = '#7c5a3a';
  ctx.fillRect(-10, -1.5, 34, 3);
  ctx.fillStyle = '#d6d3d1';
  ctx.beginPath(); ctx.moveTo(24, -4); ctx.lineTo(33, 0); ctx.lineTo(24, 4); ctx.closePath(); ctx.fill();
}

// 古樹的招式與長矛。處理了就回傳 true
export function drawTreeProjectile(ctx, p, view) {
  const w = p.weapon;
  if (w.id === 'treeTrunk') {
    // 巨大樹幹：從樹幹表面一路伸到前端
    const r = w.hitRadius;
    const x1 = Math.max(p.x, view.match.terrain.hardEdgeX(p.y) + 10);
    const g = ctx.createLinearGradient(0, p.y - r, 0, p.y + r);
    g.addColorStop(0, '#8b5e3c');
    g.addColorStop(0.5, '#6b4423');
    g.addColorStop(1, '#3f2716');
    ctx.fillStyle = g;
    ctx.fillRect(p.x, p.y - r, x1 - p.x, r * 2);
    ctx.strokeStyle = 'rgba(30,18,8,0.5)';
    ctx.lineWidth = 2;
    for (let k = -1; k <= 1; k++) {
      ctx.beginPath(); ctx.moveTo(p.x + 10, p.y + k * r * 0.5); ctx.lineTo(x1, p.y + k * r * 0.5 + 2); ctx.stroke();
    }
    // 前端的年輪
    ctx.fillStyle = '#c9a26b';
    ctx.beginPath(); ctx.ellipse(p.x, p.y, r * 0.45, r, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#8b5e3c';
    ctx.lineWidth = 1.5;
    for (const k of [0.3, 0.6, 0.85]) { ctx.beginPath(); ctx.ellipse(p.x, p.y, r * 0.45 * k, r * k, 0, 0, Math.PI * 2); ctx.stroke(); }
    return true;
  }
  if (w.id === 'treeLeaf') {
    // 一團旋轉的葉子，後面拖著幾片
    for (let i = 0; i < p.trail.length; i += 2) {
      const t = p.trail[i], k = i / p.trail.length;
      drawLeaf(ctx, t.x + Math.sin(i * 1.7) * 9, t.y + Math.cos(i * 2.3) * 9, 5, p.spin + i, `rgba(132,204,22,${k * 0.7})`);
    }
    for (let k = 0; k < 9; k++) {
      const a = p.spin * 1.4 + k * Math.PI * 2 / 9;
      const rr = w.hitRadius * (0.7 + 0.6 * ((k % 3) / 2));
      drawLeaf(ctx, p.x + Math.cos(a) * rr, p.y + Math.sin(a) * rr, 8, a, k % 2 ? '#65a30d' : '#a3e635');
    }
    return true;
  }
  if (w.id === 'treeSpear') {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(p.vy, p.vx));
    ctx.translate(-24, 0);
    drawSpearHeld(ctx);
    ctx.restore();
    return true;
  }
  return false;
}

function drawLeaf(ctx, x, y, size, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-size, 0);
  ctx.quadraticCurveTo(0, -size * 0.8, size, 0);
  ctx.quadraticCurveTo(0, size * 0.8, -size, 0);
  ctx.fill();
  ctx.restore();
}

// 森林背景（古樹之庭）：深綠的天空、斜射的光、遠方的樹影
export function buildForestBackground(W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
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
