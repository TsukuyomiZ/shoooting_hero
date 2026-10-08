import { CONFIG } from '../../shared/config.js';
import { CYCLOPS_ACTION_NAMES, poundLane } from '../../shared/cyclops.js';
import { cave } from './cave.js';

// 菁英關「地心探險」的地圖畫面：洞穴的部分（火把、照明、掉下來的鐘乳石）沿用 cave.js，
// 加上獨眼巨人：回合的動畫腳本（照伺服器廣播的招式播）、身體 / 發光的獨眼 / 巨石 / 猛捶衝擊的繪圖、預定猛捶時的警示、倒下的特效。
// 規則在 shared/cyclops.js；掛勾的說明見 index.js
const FPS = 60;
const SKIN = '#b7794a', SKIN_DARK = '#7c4a26', HIDE = '#5b3a1e';
const SLAM_AT = 0.8;   // 猛捶的預兆播到幾成時拳頭砸下去

export const cyclops = {
  ...cave,
  type: 'cyclops',

  // 這一場的畫面狀態：洞穴的（爆炸閃光、火把點燃）+
  //   fx  巨人出招的預兆動畫 { action, t, phase: 'cast' | 'act', targetId }（巨人回合播完就清掉）
  create: (match) => ({ ...cave.create(match), fx: null }),

  turnScript: cyclopsTurnScript,
  abortScript(c) { c.state.fx = null; },   // 播到一半丟掉：舉起的手、巨石不要一直留著
  onDeath: onCyclopsDeath,

  // 每一步：洞穴的（閃光、火星）+ 猛捶的衝擊在岩柱上揚起碎石（畫圖只讀狀態，不在畫圖時做這些）
  update(c, dt) {
    cave.update(c, dt);
    const lane = laneOf(c);
    for (const p of c.projectiles) if (p.weapon && p.weapon.id === 'cyclopsShock' && lane && onLedge(lane, p.x)) shockDebris(c, p);
  },

  // 洞穴的（鐘乳石掉下來、火把點燃、閃光）+ 巨石砸碎
  showEvent(c, ev, made) {
    cave.showEvent(c, ev, made);
    const p = c.projectiles.find(q => q.i === ev.p);
    if (p && p.weapon.id === 'cyclopsBoulder' && ev.type === 'explode') {
      c.fx.particles(ev.x, ev.y, 18, { speed: 180, life: 0.7, size: 3.5, color: '#a8a29e', gravity: 800 });
    }
    if (p && p.weapon.id === 'cyclopsShock' && ev.type === 'range') {   // 衝擊跑到岩柱的盡頭：揚起一團碎石
      c.fx.particles(ev.x, ev.y + 4, 10, { speed: 140, life: 0.5, size: 3, color: '#a8a29e', gravity: 700 });
    }
  },

  // 巨人：自己畫身體（不畫影子、武器），血條、名字照一般的畫
  drawEntity(ctx, c, e, hurt) {
    if (e.part !== 'cyclops') return false;
    drawCyclops(ctx, c, e, hurt);
    return 'body';
  },
  hpBar: (c, e) => (e.part === 'cyclops' ? { w: 110, h: 8 } : null),

  // 洞穴的（掉下來的鐘乳石）+ 巨石、猛捶的衝擊
  drawProjectile(ctx, c, p) {
    if (cave.drawProjectile(ctx, c, p)) return true;
    if (p.weapon.id === 'cyclopsBoulder') { drawBoulder(ctx, p); return true; }
    if (p.weapon.id === 'cyclopsShock') { drawShock(ctx, c, p); return true; }
    return false;
  },

  // 遮光（洞穴的）之後：巨人發光的獨眼（暗的地方也看得到他在哪）、預定猛捶的警示（會掉的鐘乳石、岩柱上的衝擊範圍）
  drawShade(ctx, c) {
    cave.drawShade(ctx, c);
    drawPoundWarning(ctx, c);
    drawEyeGlow(ctx, c);
  },

  // 洞穴那一行（敵人剩餘、火把）+ 巨人的血量與預定的下一招
  hud(c, line) {
    const lines = cave.hud(c, line);
    const e = c.match.byId('cyclops');
    const next = c.match.mechState && c.match.mechState.next;
    if (e && e.alive) {
      const plan = next ? `　下一招：${CYCLOPS_ACTION_NAMES[next.action] || next.action}` : '';
      lines.push([`獨眼巨人 ${e.hp} / ${e.maxHp}${plan}`, next && next.action === 'pound' ? '#fdba74' : '#fca5a5']);
    }
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 巨人的回合：預兆（猛捶：雙手舉高再砸下去；巨石投擲：舉起巨石、眼睛盯著目標）→ 出招（照 shotScript 重播：
// 猛捶的衝擊沿著岩柱跑、鐘乳石全部掉下來；巨石沿拋物線飛）→ 校正成伺服器結果。
// 全部播完才換上伺服器預定的下一招（msg.boss.next）：猛捶的警示留到真的捶下去
function* cyclopsTurnScript(c, msg) {
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* cyclopsStepScript(c, step);
  c.state.fx = null;
  if (c.match.mechState && msg.boss.next !== undefined) c.match.mechState.next = msg.boss.next;
}

function* cyclopsStepScript(c, b) {
  const match = c.match;
  const fx = c.state.fx = { action: b.action, t: 0, phase: 'cast', targetId: b.targetId ?? null };
  const cast = Math.round(CONFIG.TIMING.bossCast * FPS);
  const target = b.targetId ? match.byId(b.targetId) : null;
  const cy = match.byId('cyclops');
  if (b.action === 'pound') c.fx.banner(`獨眼巨人：${CYCLOPS_ACTION_NAMES.pound}！`, '#fdba74');
  else if (b.action === 'throw') c.fx.banner(`獨眼巨人：${CYCLOPS_ACTION_NAMES.throw}${target ? ` → ${target.name}` : ''}！`, '#fca5a5');
  else c.fx.banner(`獨眼巨人${CYCLOPS_ACTION_NAMES.idle}`, '#e9d5ff');
  const slam = Math.round(cast * SLAM_AT);
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    if (b.action === 'pound' && i === slam && cy) {   // 拳頭砸在岩柱上：整個畫面震、碎石往兩邊噴
      c.fx.shake(16);
      c.fx.sound('stomp', { x: cy.x });
      c.fx.particles(cy.x - cy.hw, cy.y, 14, { speed: 200, life: 0.7, size: 3.5, color: '#a8a29e', gravity: 700 });
      c.fx.particles(cy.x + cy.hw, cy.y, 14, { speed: 200, life: 0.7, size: 3.5, color: '#78716c', gravity: 700 });
    }
    if (b.action === 'pound' && i > slam && i % 6 === 0) c.fx.shake(5);   // 捶完還在晃，天花板的鐘乳石要掉了
    if (b.action === 'throw' && i === cast - 8 && cy) c.fx.sound('heave', { x: cy.x });
    yield { frames: 1 };
  }
  fx.phase = 'act';
  if (b.shot) {
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
}

// 巨人倒下：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
function onCyclopsDeath(c, e) {
  if (e.part !== 'cyclops') return false;
  c.fx.banner('獨眼巨人倒下了！', '#c084fc');
  c.fx.shake(14);
  c.fx.sound('stomp', { x: e.x });
  c.fx.particles(e.x, e.cy, 36, { speed: 220, life: 1.1, size: 4, color: SKIN, gravity: 400 });
  return true;
}

// ---------- 小工具 ----------

function laneOf(c) {
  return c.match && c.match.level.mechanic && c.match.level.mechanic.ledge ? poundLane(c.match) : null;
}
const onLedge = (lane, x) => x >= lane.x0 && x <= lane.x1;

// 猛捶的衝擊揚起的碎石：每秒 30 顆（照遊戲時間，不照畫面更新次數；update 每一步呼叫）
function shockDebris(c, p) {
  const tick = Math.floor(c.time * 30);
  if (tick === p.debrisTick) return;
  p.debrisTick = tick;
  c.fx.particle({ x: p.x, y: p.y + 4, vx: (Math.random() - 0.5) * 140, vy: -110 - Math.random() * 150, life: 0.5, maxLife: 0.5, size: 3, color: Math.random() < 0.5 ? '#a8a29e' : '#57534e', gravity: 700 });
}

// 巨人看哪裡：出招的目標 → 現在行動的玩家 → 離他最近的玩家
function lookPoint(c, cy) {
  const match = c.match;
  const fx = c.state.fx;
  const target = (fx && fx.targetId && match.byId(fx.targetId)) || (c.currentId && match.byId(c.currentId));
  if (target && target.team === 'players' && target.alive) return { x: target.cx, y: target.cy };
  const alive = match.players.filter(p => p.alive);
  if (!alive.length) return null;
  const near = alive.reduce((a, b) => (Math.hypot(b.cx - cy.cx, b.cy - cy.cy) < Math.hypot(a.cx - cy.cx, a.cy - cy.cy) ? b : a));
  return { x: near.cx, y: near.cy };
}

// 眼睛的位置（身體座標換算成畫面座標）與瞳孔偏移
function eyeOf(c, e) {
  const s = e.h / 70;
  const ex = e.x + e.facing * 2 * s, ey = e.y - 58 * s;
  const look = lookPoint(c, e);
  let px = 0, py = 0;
  if (look) {
    const dx = look.x - ex, dy = look.y - ey, d = Math.hypot(dx, dy) || 1;
    px = dx / d * 3.2 * s;
    py = dy / d * 2.4 * s;
  }
  return { x: ex, y: ey, px, py, s };
}

// 出招的姿勢：0..1 = 手舉起來的程度（猛捶：舉高 → 砸下去；投擲：舉著巨石），slammed = 猛捶已經砸下去了
function poseOf(c) {
  const fx = c.state.fx;
  if (!fx) return { raise: 0, slammed: false, boulder: false };
  const cast = CONFIG.TIMING.bossCast;
  const k = Math.min(1, fx.t / (cast * SLAM_AT));
  if (fx.action === 'pound') {
    if (fx.phase === 'act' || fx.t >= cast * SLAM_AT) return { raise: 0, slammed: true, boulder: false };
    return { raise: k, slammed: false, boulder: false };
  }
  if (fx.action === 'throw') return { raise: fx.phase === 'act' ? 0.2 : Math.min(1, fx.t / (cast * 0.6)), slammed: false, boulder: fx.phase === 'cast' };
  return { raise: 0, slammed: false, boulder: false };
}

// ---------- 繪圖 ----------

// 獨眼巨人：駝背蹲著的大塊頭（草圖的樣子），粗手臂、獸皮腰布、一顆大眼睛（盯著目標），頭上一根短角
function drawCyclops(ctx, c, e, hurt) {
  const s = e.h / 70, f = e.facing;
  const pose = poseOf(c);
  const skin = hurt ? '#ffffff' : SKIN, dark = hurt ? '#e5e5e5' : SKIN_DARK;
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2;
  // 腿（蹲著）
  ctx.fillStyle = dark;
  ctx.beginPath(); ctx.ellipse(-11, -9, 9, 10, 0.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(11, -9, 9, 10, -0.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#3f2a17';
  ctx.fillRect(-21, -3, 16, 3);
  ctx.fillRect(5, -3, 16, 3);
  // 身體：往前駝
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.moveTo(-20, -16);
  ctx.quadraticCurveTo(-26, -40, -10 + f * 4, -52);
  ctx.quadraticCurveTo(8 + f * 6, -56, 20, -40);
  ctx.quadraticCurveTo(24, -24, 18, -14);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // 獸皮腰布
  ctx.fillStyle = hurt ? '#ddd' : HIDE;
  ctx.beginPath(); ctx.moveTo(-20, -20); ctx.lineTo(19, -20); ctx.lineTo(14, -9); ctx.lineTo(4, -13); ctx.lineTo(-6, -8); ctx.lineTo(-17, -12); ctx.closePath(); ctx.fill();
  // 手臂：照姿勢舉起來（猛捶雙手舉高，投擲舉起前面那隻手）
  const arm = (side, raise) => {
    const sx = side * 18, sy = -42;
    const hx = sx + side * (8 - raise * 4) + f * 6 * (1 - raise), hy = pose.slammed ? -4 : sy + 28 - raise * 70;
    ctx.strokeStyle = skin;
    ctx.lineWidth = 11;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(sx + side * 10, (sy + hy) / 2, hx, hy); ctx.stroke();
    ctx.fillStyle = dark;   // 拳頭
    ctx.beginPath(); ctx.arc(hx, hy, 7.5, 0, Math.PI * 2); ctx.fill();
    return { x: hx, y: hy };
  };
  const front = f, back = -f;
  const throwing = c.state.fx && c.state.fx.action === 'throw';
  arm(back, throwing ? 0 : pose.raise);
  const hand = arm(front, pose.raise);
  if (pose.boulder) {   // 舉在手上的巨石
    ctx.fillStyle = '#78716c';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(hand.x, hand.y - 12, 13, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // 頭：圓的，一根短角
  ctx.fillStyle = skin;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(f * 2, -57, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = hurt ? '#eee' : '#e7e5e4';
  ctx.beginPath(); ctx.moveTo(f * 2 - 3, -68); ctx.lineTo(f * 2, -78); ctx.lineTo(f * 2 + 3, -68); ctx.closePath(); ctx.fill();
  ctx.restore();
  // 眼睛（畫面座標；瞳孔看著目標）
  const eye = eyeOf(c, e);
  ctx.save();
  ctx.fillStyle = '#fefce8';
  ctx.beginPath(); ctx.ellipse(eye.x, eye.y, 7 * eye.s, 5.5 * eye.s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = hurt ? '#999' : '#b91c1c';
  ctx.beginPath(); ctx.arc(eye.x + eye.px, eye.y + eye.py, 3.2 * eye.s, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(eye.x + eye.px, eye.y + eye.py, 1.5 * eye.s, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = hurt ? '#ccc' : SKIN_DARK;   // 眉骨
  ctx.lineWidth = 3 * eye.s;
  ctx.beginPath(); ctx.moveTo(eye.x - 9 * eye.s, eye.y - 7 * eye.s); ctx.lineTo(eye.x + 9 * eye.s, eye.y - 6 * eye.s); ctx.stroke();
  ctx.restore();
}

// 發光的獨眼（畫在遮光上面：暗的地方也看得到他在哪；出招時更亮）
function drawEyeGlow(ctx, c) {
  const e = c.match.byId('cyclops');
  if (!e || !e.alive) return;
  const eye = eyeOf(c, e);
  const casting = !!c.state.fx;
  const r = (casting ? 26 : 16) + Math.sin(c.time * 3) * 2;
  const g = ctx.createRadialGradient(eye.x, eye.y, 0, eye.x, eye.y, r);
  g.addColorStop(0, `rgba(254,202,202,${casting ? 0.75 : 0.5})`);
  g.addColorStop(0.4, `rgba(239,68,68,${casting ? 0.4 : 0.22})`);
  g.addColorStop(1, 'rgba(239,68,68,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(eye.x, eye.y, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fca5a5';
  ctx.beginPath(); ctx.arc(eye.x + eye.px, eye.y + eye.py, 2.4 * eye.s, 0, Math.PI * 2); ctx.fill();
}

// 預定猛捶（玩家回合）或正在猛捶的預兆：還在的鐘乳石描紅框、往下畫一條會掉下去的虛線，巨人的岩柱頂面標出衝擊範圍。
// 畫在遮光上面（暗的地方也看得到）；預兆時閃得比較快
function drawPoundWarning(ctx, c) {
  const S = c.match.mechState;
  const fx = c.state.fx;
  const casting = fx && fx.action === 'pound' && fx.phase === 'cast';
  if (!casting && !(S && S.next && S.next.action === 'pound' && !fx)) return;
  const e = c.match.byId('cyclops');
  if (!e || !e.alive) return;
  const T = c.match.terrain;
  const pulse = casting ? 0.55 + 0.45 * Math.sin(c.time * 22) : 0.35 + 0.25 * Math.sin(c.time * 4);
  ctx.save();
  T.stalactites.forEach((s, k) => {
    if (T.fallen.has(k)) return;
    ctx.strokeStyle = `rgba(248,113,113,${pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.poly.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    let y = s.tip.y + 2;   // 會掉到哪：往下找到第一個擋得住的地方（或水面）
    while (y < CONFIG.WATER_LEVEL && !T.isSolid(s.tip.x, y)) y += 2;
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = `rgba(248,113,113,${pulse * 0.6})`;
    ctx.beginPath(); ctx.moveTo(s.tip.x, s.tip.y + 4); ctx.lineTo(s.tip.x, y); ctx.stroke();
    ctx.setLineDash([]);
  });
  const lane = poundLane(c.match);
  ctx.fillStyle = `rgba(251,146,60,${pulse * 0.35})`;
  ctx.fillRect(lane.x0, lane.top, lane.x1 - lane.x0, lane.bottom - lane.top);
  ctx.strokeStyle = `rgba(251,146,60,${pulse})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(lane.x0 + 1, lane.top, lane.x1 - lane.x0 - 2, lane.bottom - lane.top);
  ctx.restore();
}

// 巨石：滾動的石塊（不規則的多邊形）+ 一點揚起的粉塵
function drawBoulder(ctx, p) {
  const w = p.weapon;
  for (let i = 0; i < p.trail.length; i += 3) {
    const t = p.trail[i], k = i / p.trail.length;
    ctx.fillStyle = `rgba(168,162,158,${k * 0.35})`;
    ctx.beginPath(); ctx.arc(t.x, t.y, 2 + k * 4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.spin * 0.4);
  const r = w.shellRadius;
  ctx.fillStyle = w.color;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  const pts = [1, 0.85, 1.05, 0.9, 1, 0.8, 1.1, 0.9];
  pts.forEach((k, j) => {
    const a = j / pts.length * Math.PI * 2;
    const x = Math.cos(a) * r * k, y = Math.sin(a) * r * k;
    if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(41,37,36,0.6)';   // 裂紋
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-r * 0.4, -r * 0.3); ctx.lineTo(r * 0.1, r * 0.1); ctx.lineTo(r * 0.2, r * 0.5); ctx.stroke();
  ctx.restore();
}

// 猛捶的衝擊：一圈圈往前推的震波（跑到岩柱的盡頭就停：range，見 shared/cyclops.js 的 poundStep）
function drawShock(ctx, c, p) {
  const lane = laneOf(c);
  if (!lane || !onLedge(lane, p.x)) return;
  const dir = p.vx >= 0 ? 1 : -1;
  for (let i = 0; i < p.trail.length; i += 3) {
    const t = p.trail[i], k = i / p.trail.length;
    if (!onLedge(lane, t.x)) continue;
    ctx.strokeStyle = `rgba(214,211,209,${k * 0.6})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(t.x, t.y + 6, 10 + (1 - k) * 16, 6 + (1 - k) * 8, 0, Math.PI, 0); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(231,229,228,0.85)';
  ctx.beginPath(); ctx.ellipse(p.x + dir * 2, p.y + 6, 14, 10, 0, Math.PI, 0); ctx.fill();
}
