import { CONFIG } from '../../shared/config.js';
import { spawnTreant, leafOrigin, trunkLane, TREE_ACTION_NAMES } from '../../shared/tree-boss.js';
import { clamp } from '../../shared/utils.js';
import { roundRect } from '../draw.js';
import { drawSpearHeld } from '../weapon-art.js';

// 古樹之庭的地圖畫面：古樹回合的動畫腳本（照伺服器廣播的招式播）、古樹倒下的特效、嘴巴被打閉上 / 又張開的飄字，
// 與古樹 / 樹妖 / 招式的繪圖。掛勾的說明見 index.js
const FPS = 60;
const BARK = '#5b3d27';

export const tree = {
  type: 'tree',

  // 這一場的畫面狀態：
  //   fx         古樹出招的預兆動畫 { action, t, plane, targetId, seeds }（古樹回合播完就清掉）
  //   withered   古樹倒下了（樹冠、藤蔓變灰；地形的樹皮由 fx.wither() 變灰）
  //   mouthOpen  嘴巴畫面上張開的程度（id → 數字，每畫一次往目標靠近一點）
  //   floated    這次被打閉上已經飄過「閉上了！」的嘴巴 id（又張開時清掉）
  create: () => ({ fx: null, withered: false, mouthOpen: new Map(), floated: new Set() }),

  musicTrack: () => 'tree',
  turnScript: treeTurnScript,
  onDeath: onTreeDeath,

  // 古樹之口被打到閉上（不扣血）
  showDamage(c, e, d) {
    if (!d.closed) return false;
    e.hurtTimer = 0.35;   // 閉著的嘴被打到會抖一下
    if (!c.state.floated.has(e.id)) c.fx.float(e, '閉上了！', '#fdba74');
    c.state.floated.add(e.id);
    c.fx.particles(e.cx, e.cy, 10, { speed: 120, life: 0.5, size: 3, color: '#8b5a2b', gravity: 300 });
    return true;
  },

  // 古樹之口撐過一回合，又張開了
  turnFx(c, e, fx) {
    if (fx.type !== 'mouthOpen') return false;
    c.fx.float(e, '張開了', '#fca5a5');
    c.state.floated.delete(e.id);
    return true;
  },

  drawScene: drawTreeScene,

  // 閉上的眼睛 / 嘴巴留在樹上（不淡出、沒有血條）
  drawEntityBare(ctx, c, e) {
    if (!e.part || e.alive) return false;
    drawTreePart(ctx, c, e);
    return true;
  },

  // 古樹之眼 / 古樹之口
  drawEntity(ctx, c, e) {
    if (!e.part) return false;
    drawTreePart(ctx, c, e);
    return 'body';
  },

  // 樹妖：影子、長矛照一般的畫，身體換成樹妖
  drawFigure(ctx, c, e, hurt) {
    if (!e.minion) return false;
    drawTreant(ctx, e, hurt);
    return true;
  },

  // 古樹之口打不壞：不畫血條（看畫面上張開或闔上）
  hpBar: (c, e) => (e.closeOnHit ? { hidden: true } : null),

  drawProjectile: drawTreeProjectile,

  // 隊伍名單下面：眼睛血量、場上的樹妖數（嘴巴的狀態不用文字提示，只看畫面上張開或闔上）
  hud(c) {
    const eye = c.match.byId('eye');
    const minions = c.match.enemies.filter(e => e.minion && e.alive).length;
    return [[`古樹之眼 ${eye.hp} / ${eye.maxHp}`, '#fca5a5'], [`樹妖 ×${minions}`, '#fdba74']];
  },
};

// ---------- 動畫腳本 ----------

// 古樹的回合：依序播放每一招（多人召喚的回合是「召喚 → 攻擊」兩招）。
// 每一招：預兆（標出目標平面、張嘴、閉眼、聚集落葉）→ 出招（撞擊 / 落葉照 shotScript 重播）→ 校正成伺服器結果。
// c.state.fx 給畫面用：{ action, t, plane, targetId, seeds }。
// 全部播完才換上伺服器預定的下一招（msg.boss.next）：舊的撞擊預告留到真的撞下去，新的預告在古樹回合之後才出現
function* treeTurnScript(c, msg) {
  const eye = c.match.byId(msg.actorId);
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* treeStepScript(c, eye, step);
  c.state.fx = null;
  if (c.match.tree && msg.boss.next !== undefined) c.match.tree.next = msg.boss.next;
}

function* treeStepScript(c, eye, b) {
  const match = c.match;
  const T = CONFIG.TIMING;
  const fx = c.state.fx = { action: b.action, t: 0, plane: b.plane ?? null, targetId: b.targetId ?? null, seeds: [] };
  const cast = Math.round(T.bossCast * FPS);
  const planes = match.tree ? match.tree.def.planes : [];
  const name = TREE_ACTION_NAMES[b.action] || '';
  switch (b.action) {
    case 'summon': {
      const spawns = b.spawns || [];
      c.fx.banner(spawns.length > 1 ? `古樹：${name} ×${spawns.length}！` : `古樹：${name}！`, '#fca5a5');
      const mouth = match.byId('mouth');
      yield { frames: Math.round(cast * 0.5) };
      // 嘴巴吐出種子（召喚幾隻就吐幾顆），落地長出樹妖
      const from = mouth ? { x: mouth.x - mouth.hw * 0.5, y: mouth.cy } : { x: 0, y: 0 };
      fx.seeds = spawns.map(s => ({ from, to: { x: s.x, y: s.y }, t: 0 }));
      const flight = cast - Math.round(cast * 0.5);
      for (let i = 1; i <= flight; i++) { for (const sd of fx.seeds) sd.t = i / flight; yield { frames: 1 }; }
      fx.seeds = [];
      for (const s of spawns) {
        const e = spawnTreant(match, s);   // 新的角色一定活著：GameView 之後看到牠倒下才播死亡特效
        c.fx.particles(e.x, e.y - 10, 18, { speed: 150, life: 0.7, size: 4, color: '#65a30d', gravity: 400 });
        c.fx.particles(e.x, e.y - 10, 10, { speed: 90, life: 0.6, size: 3, color: '#a16207', gravity: 300 });
        c.fx.float(e, '樹妖出現！', '#fca5a5', 16);
      }
      break;
    }
    case 'trunk': {
      const pl = planes[b.plane];
      c.fx.banner(`古樹：${name} → ${pl ? pl.name : ''}！`, '#fdba74');
      for (let i = 0; i < cast; i++) {   // 地面震動、樹幹那一側落下木屑
        if (i % 6 === 0) {
          c.fx.shake(3);
          if (pl) c.fx.particles(match.terrain.hardEdgeX(pl.y - 18), pl.y - 18 + (Math.random() - 0.5) * 40, 3, { speed: 80, life: 0.6, size: 3, color: '#8b5a2b', gravity: 500 });
        }
        yield { frames: 1 };
      }
      fx.plane = null;   // 預兆結束，接著是真的樹幹
      break;
    }
    case 'leaves': {
      const target = match.byId(b.targetId);
      c.fx.banner(`古樹：${name} → ${target ? target.name : ''}！`, '#bef264');
      const o = eye ? leafOrigin(eye) : null;
      for (let i = 0; i < cast; i++) {   // 葉子往眼睛前面聚集
        if (o && i % 3 === 0) {
          const a = Math.random() * Math.PI * 2, r = 50 + Math.random() * 30;
          c.fx.particle({ x: o.x + Math.cos(a) * r, y: o.y + Math.sin(a) * r, vx: -Math.cos(a) * r * 2, vy: -Math.sin(a) * r * 2, life: 0.45, maxLife: 0.45, size: 3, color: Math.random() < 0.5 ? '#84cc16' : '#4d7c0f', gravity: 0 });
        }
        yield { frames: 1 };
      }
      break;
    }
    case 'meditate': {
      c.fx.banner(`古樹：${name}`, '#86efac');
      yield { frames: Math.round(cast * 0.6) };
      if (eye && b.heal > 0) {
        eye.hp = Math.min(eye.maxHp, eye.hp + b.heal);
        c.fx.float(eye, `+${b.heal}`, '#4ade80');
        c.fx.particles(eye.x, eye.cy, 16, { speed: 90, life: 0.8, size: 3, color: '#86efac', gravity: -80 });
      }
      yield { frames: cast - Math.round(cast * 0.6) };
      break;
    }
    default:
      c.fx.banner(TREE_ACTION_NAMES.idle, '#d9f99d');
      yield { frames: cast };
  }

  if (b.shot) {
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: T.settleDelay * FPS * 0.5 };
  }
}

// 古樹相關的死亡：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
function onTreeDeath(c, e) {
  if (e.part === 'eye') {
    c.fx.banner('古樹倒下了！', '#fde047');
    c.fx.shake(14);
    c.fx.particles(e.x, e.cy, 40, { speed: 260, life: 1.2, size: 4, color: '#65a30d', gravity: 250 });
    c.state.withered = true;
    c.fx.wither();
    return true;
  }
  if (e.part === 'mouth') {   // 嘴巴打不壞，只會跟著古樹一起枯萎
    c.fx.particles(e.x, e.cy, 20, { speed: 160, life: 0.8, size: 3, color: '#8b5a2b', gravity: 400 });
    return true;
  }
  if (e.deathCause === 'wither') {   // 樹妖跟著古樹枯萎
    c.fx.particles(e.x, e.cy, 14, { speed: 80, life: 1.0, size: 3, color: '#a3a3a3', gravity: 120 });
    return true;
  }
  return false;
}

// ---------- 繪圖 ----------

// 樹冠與垂下來的藤蔓（地形之後、角色之前畫）＋ 預定撞擊的警示帶 ＋ 招式的預兆（目標平面、種子）
function drawTreeScene(ctx, c) {
  const match = c.match;
  if (!match || !match.tree) return;
  const withered = c.state.withered;
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
    ctx.quadraticCurveTo(x - 10 + Math.sin(c.time * 1.3 + x) * 4, 30 + len / 2, x - 4, 30 + len);
    ctx.stroke();
  }

  const fx = c.state.fx;
  // 預定的古樹撞擊：玩家 / 樹妖的回合一直標著那條橫掃範圍（慢慢呼吸），讓玩家有機會躲開。
  // 古樹自己出撞擊的時候改由下面的快閃接手（撞完、播完才換成下一個預告）
  const next = match.tree.next;
  const eye = match.byId('eye');
  if (next && next.action === 'trunk' && next.plane != null && eye && eye.alive && !withered && !(fx && fx.action === 'trunk')) {
    drawTrunkBand(ctx, match, next.plane, 0.26 + 0.08 * Math.sin(c.time * 3), 0.85);
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
function drawTreePart(ctx, c, e) {
  if (e.part === 'eye') drawEye(ctx, c, e);
  else drawMouth(ctx, c, e);
}

function lookPoint(c, e) {
  const match = c.match;
  const fx = c.state.fx;
  const target = (fx && fx.targetId && match.byId(fx.targetId)) || (c.currentId && match.byId(c.currentId));
  if (target && target.team === 'players' && target.alive) return { x: target.cx, y: target.cy };
  const alive = match.players.filter(p => p.alive);
  if (!alive.length) return null;
  const near = alive.reduce((a, b) => (Math.hypot(b.cx - e.x, b.cy - e.cy) < Math.hypot(a.cx - e.x, a.cy - e.cy) ? b : a));
  return { x: near.cx, y: near.cy };
}

function drawEye(ctx, c, e) {
  const x = e.x, y = e.cy, r = e.hw;
  const fx = c.state.fx;
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
    const lp = lookPoint(c, e);
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

function drawMouth(ctx, c, e) {
  const x = e.x, y = e.cy, hw = e.hw;
  const fx = c.state.fx;
  if (!e.alive) { drawShutMouth(ctx, e, true); return; }   // 古樹倒下：縫死
  // 張開的程度：被打到就闔起來、古樹回合結束再慢慢張開；召喚時張大，平常慢慢呼吸（只影響畫面）
  const target = e.closedTurns > 0 ? 0 : (fx && fx.action === 'summon' ? 1.25 : 0.85 + 0.1 * Math.sin(c.time * 2.2));
  const prev = c.state.mouthOpen.get(e.id);
  const open = prev === undefined ? target : prev + (target - prev) * 0.2;
  c.state.mouthOpen.set(e.id, open);
  if (open < 0.12) { drawShutMouth(ctx, e, false); return; }
  const oh = e.h / 2 * open;
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
function drawTreant(ctx, e, hurt) {
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

// 古樹的招式與長矛。處理了就回傳 true
function drawTreeProjectile(ctx, c, p) {
  const w = p.weapon;
  if (w.id === 'treeTrunk') {
    // 巨大樹幹：從樹幹表面一路伸到前端
    const r = w.hitRadius;
    const x1 = Math.max(p.x, c.match.terrain.hardEdgeX(p.y) + 10);
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
