import { CONFIG } from '../../shared/core/config.js';
import { GUARDIAN_ACTION_NAMES, leapBand, bashBand, shieldUp } from '../../shared/maps/guardian.js';

// 菁英關「大樹守衛」的地圖畫面：守衛回合的動畫腳本（照伺服器廣播的招式播）、守衛 / 衝鋒 / 盾擊 / 躍擊震波的繪圖、
// 預定躍擊的警示範圍、舉盾時盾牌前方的盾擊範圍（淡淡的）、倒下的特效。規則在 shared/maps/guardian.js；掛勾的說明見 index.js
const FPS = 60;
const BARK = '#6b4a2b', BARK_DARK = '#3f2a17', WOOD = '#8b5e34', MOSS = '#4d7c0f', LEAF = '#65a30d', LEAF_LIGHT = '#84cc16', GOLD = '#d4a017';
const LEAP_CROUCH = 0.35;   // 躍擊的預兆：先蹲這麼久（秒）才跳起來，剩下的預兆時間都在空中
const BASH_AT = 0.8;        // 盾擊的預兆播到幾成時把盾撞出去

export const guardian = {
  type: 'guardian',

  // 這一場的畫面狀態：
  //   fx       守衛出招的預兆 { action, t, phase: 'cast' | 'act', targetId, step, cast }（守衛回合播完就清掉）
  //   running  衝鋒衝出去了：飛行物本身就是他（見 drawProjectile），角色先不畫
  create: () => ({ fx: null, running: false }),

  turnScript: guardianTurnScript,
  abortScript(c) { c.state.fx = null; c.state.running = false; },   // 播到一半丟掉：跳在半空中、衝出去（不畫）不要一直留著
  onDeath: onGuardianDeath,

  // 衝鋒時腳下揚起塵土（照遊戲時間，每秒 40 顆；畫圖只讀狀態）
  update(c) {
    for (const p of c.projectiles) if (p.weapon && p.weapon.id === 'guardianCharge') chargeDust(c, p);
  },

  // 衝鋒撞到人、盾擊 / 躍擊打到人：木屑與塵土；舉盾時被打到：盾牌上冒火星
  showEvent(c, ev, made) {
    const p = c.projectiles.find(q => q.i === ev.p);
    const id = p && p.weapon && p.weapon.id;
    if (id === 'guardianCharge' && ev.target) {
      c.fx.shake(10);
      c.fx.sound('stomp', { x: ev.x });
      c.fx.particles(ev.x, ev.y, 16, { speed: 200, life: 0.6, size: 3.5, color: '#a16207', gravity: 600 });
    } else if ((id === 'guardianBash' || id === 'guardianLeap') && ev.damages) {
      c.fx.particles(ev.x, ev.y, 10, { speed: 170, life: 0.5, size: 3, color: id === 'guardianBash' ? '#d4a017' : LEAF_LIGHT, gravity: 500 });
    }
    const g = c.match.byId('guardian');
    if (g && ev.damages && shieldUp(c.match) && ev.damages.some(d => d.id === g.id && d.dmg > 0)) {
      c.fx.particles(g.x + g.facing * (g.hw + 6), g.cy - 4, 8, { speed: 150, life: 0.35, size: 2.5, color: '#fde68a', gravity: 300 });
    }
  },

  // 衝鋒衝出去了（飛行物畫成他）、躍擊跳在半空中（自己照弧線畫）：一般的身體、血條、名字都不畫
  drawEntityBare(ctx, c, e) {
    if (e.part !== 'guardian') return false;
    if (c.state.running) return true;
    const air = airborne(c, e);
    if (!air) return false;
    drawGuardian(ctx, c, e, false, air);
    return true;
  },

  // 守衛：自己畫身體（含影子；不畫一般的武器），血條、名字照一般的畫
  drawEntity(ctx, c, e, hurt) {
    if (e.part !== 'guardian') return false;
    drawGuardian(ctx, c, e, hurt, null);
    return 'body';
  },
  hpBar: (c, e) => (e.part === 'guardian' ? { w: 100, h: 8 } : null),

  drawProjectile(ctx, c, p) {
    const id = p.weapon.id;
    if (id === 'guardianCharge') {
      const g = c.match.byId('guardian');
      if (g) drawGuardian(ctx, c, g, false, { x: p.x, y: p.y + g.h / 2, facing: p.vx >= 0 ? 1 : -1, run: true });
      return true;
    }
    if (id === 'guardianBash') { drawBashWave(ctx, p); return true; }
    if (id === 'guardianLeap') { drawLeapWave(ctx, p); return true; }
    return false;
  },

  // 地上的提示（角色之前畫）：預定躍擊的落地範圍、舉盾時盾牌前方的盾擊範圍
  drawScene(ctx, c) {
    drawLeapWarning(ctx, c);
    drawBashZone(ctx, c);
  },

  // 一般那一行（敵人剩餘）+ 守衛的血量與預定的下一招
  hud(c, line) {
    const lines = [line];
    const e = c.match.byId('guardian');
    const next = c.match.mechState && c.match.mechState.next;
    if (e && e.alive) {
      const name = next ? GUARDIAN_ACTION_NAMES[next.action] || next.action : '';
      const extra = next && next.action === 'shield' ? `（減傷 ${CONFIG.GUARDIAN.shieldCut}%）` : '';
      lines.push([`大樹守衛 ${e.hp} / ${e.maxHp}${name ? `　下一招：${name}${extra}` : ''}`, next && next.action === 'leap' ? '#fdba74' : '#fca5a5']);
    }
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 守衛的回合：預兆（衝鋒：壓低身子、刨地；盾擊：盾往後收再撞出去；躍擊：蹲下、跳起來沿弧線飛到落地點）→ 出招（照 shotScript 重播）
// → 校正成伺服器結果。全部播完才換上伺服器預定的下一招（msg.boss.next）：躍擊的警示留到真的落地，舉盾的話照預定的方向轉過去
function* guardianTurnScript(c, msg) {
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* guardianStepScript(c, msg.actorId, step);
  c.state.fx = null;
  const S = c.match.mechState;
  if (S && msg.boss.next !== undefined) {
    S.next = msg.boss.next;
    const g = c.match.byId(msg.actorId);
    if (g && S.next && S.next.action === 'shield' && (S.next.facing === 1 || S.next.facing === -1)) g.facing = S.next.facing;
  }
}

function* guardianStepScript(c, id, b) {
  const match = c.match;
  const g = match.byId(id);
  const cast = Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS);
  const target = b.targetId ? match.byId(b.targetId) : null;
  const fx = c.state.fx = { action: b.action, t: 0, phase: 'cast', targetId: b.targetId ?? null, step: b, cast: cast / FPS };
  const N = GUARDIAN_ACTION_NAMES;
  if (b.action === 'charge') c.fx.banner(`大樹守衛：${N.charge}${target ? ` → ${target.name}` : ''}！`, '#fca5a5');
  else if (b.action === 'bash') c.fx.banner(`大樹守衛：${N.bash}！`, '#fde68a');
  else if (b.action === 'leap') c.fx.banner(`大樹守衛：${N.leap}！`, '#fdba74');
  else c.fx.banner(`大樹守衛${N.idle}中`, '#e9d5ff');
  if (g && b.action === 'charge' && target && target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
  if (g && b.action === 'bash' && (b.facing === 1 || b.facing === -1)) g.facing = b.facing;
  const takeoff = Math.round(LEAP_CROUCH * FPS);
  const bash = Math.round(cast * BASH_AT);
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    if (g && b.action === 'charge' && i % 10 === 0) {   // 刨地：後腳揚起塵土
      c.fx.particles(g.x - g.facing * (g.hw - 2), g.y - 2, 4, { speed: 90, life: 0.4, size: 2.5, color: '#a8a29e', gravity: 500 });
      if (i === 0) c.fx.sound('step', { x: g.x });
    }
    if (g && b.action === 'bash' && i === bash) c.fx.sound('thunk', { x: g.x });
    if (g && b.action === 'leap' && i === takeoff) {   // 起跳：腳下噴一圈塵土
      c.fx.sound('heave', { x: g.x });
      c.fx.particles(g.x, g.y - 2, 14, { speed: 160, life: 0.5, size: 3, color: '#a8a29e', gravity: 600 });
    }
    yield { frames: 1 };
  }
  fx.phase = 'act';
  if (b.shot && b.action === 'charge') {
    yield* chargeScript(c, g, b);
  } else if (b.shot) {
    if (b.action === 'leap') {   // 落地：刺進地裡、整個畫面一震、葉子與泥土往兩邊噴
      c.fx.shake(14);
      c.fx.sound('stomp', { x: b.x });
      c.fx.particles(b.x, b.y - 2, 20, { speed: 220, life: 0.7, size: 3.5, color: '#78502e', gravity: 700 });
      c.fx.particles(b.x, b.y - 10, 12, { speed: 160, life: 0.9, size: 3, color: LEAF, gravity: 200 });
    }
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
}

// 衝鋒衝出去的那段：飛行物畫成守衛，角色本身先不畫（running）。飛行物一消失（撞到人 / 停下）就把他放到伺服器算好的停下位置、畫回來，
// 不用等 shotScript 後面的落地等待（被撞飛的人站穩要一陣子）。他停下的地方是站得住的高度，提早放過去不影響重播（角色之間不碰撞）
function* chargeScript(c, g, b) {
  const own = g ? b.shot.results.find(s => s.id === g.id) : null;
  let seen = false;
  const frame = (live) => {
    if (!g) return;
    if (live.some(p => p.weapon.id === 'guardianCharge')) { seen = true; c.state.running = true; }
    else if (seen && c.state.running) {
      c.state.running = false;
      if (own) { g.x = own.x; g.y = own.y; g.vx = 0; g.vy = 0; g.facing = own.facing; }
    }
  };
  try {
    yield* c.shotScript(b.shot, { frame });
  } finally {
    c.state.running = false;
  }
}

// 守衛倒下：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
function onGuardianDeath(c, e) {
  if (e.part !== 'guardian') return false;
  c.fx.banner('大樹守衛倒下了！', '#c084fc');
  c.fx.shake(12);
  c.fx.sound('stomp', { x: e.x });
  c.fx.particles(e.x, e.cy, 26, { speed: 200, life: 1.1, size: 4, color: BARK, gravity: 450 });
  c.fx.particles(e.x, e.cy - 10, 18, { speed: 140, life: 1.4, size: 3.5, color: LEAF, gravity: 150 });
  return true;
}

// ---------- 小工具 ----------

// 躍擊跳在半空中的位置（預兆蹲完之後，沿弧線從起跳點飛到落地點；最後三成往下俯衝）；不在空中回傳 null
function airborne(c, e) {
  const fx = c.state.fx;
  if (!fx || fx.action !== 'leap' || fx.phase !== 'cast' || fx.t < LEAP_CROUCH) return null;
  const b = fx.step;
  if (!Number.isFinite(b.x0) || !Number.isFinite(b.x)) return null;
  const k = Math.min(1, (fx.t - LEAP_CROUCH) / Math.max(0.1, fx.cast - LEAP_CROUCH));
  const base = b.y0 + (b.y - b.y0) * k;
  const top = Math.min(b.y0, b.y);
  const lift = Math.max(60, Math.min(240, top - 60 - e.h));   // 最高點不跑進上方 HUD
  const x = b.x0 + (b.x - b.x0) * k;
  const y = base - lift * 4 * k * (1 - k);
  const facing = b.x !== b.x0 ? (b.x > b.x0 ? 1 : -1) : e.facing;
  return { x, y, facing, air: k < 0.7 ? 'rise' : 'dive' };
}

// 衝鋒的塵土：每秒 40 顆（照遊戲時間，不照畫面更新次數；update 每一步呼叫）
function chargeDust(c, p) {
  const g = c.match.byId('guardian');
  if (!g) return;
  const tick = Math.floor(c.time * 40);
  if (tick === p.dustTick) return;
  p.dustTick = tick;
  const back = p.vx >= 0 ? -1 : 1;
  c.fx.particle({
    x: p.x + back * g.hw * 0.6, y: p.y + g.h / 2 - 2, vx: back * (40 + Math.random() * 60), vy: -60 - Math.random() * 80,
    life: 0.5, maxLife: 0.5, size: 3, color: Math.random() < 0.5 ? '#a8a29e' : '#78716c', gravity: 400,
  });
}

// 出招的姿勢（畫守衛用）：lean = 往前傾（弧度）、crouch = 蹲低（0..1）、shield = 盾的位置、spear = 長矛的方向、run = 跑步中
function poseOf(c, at) {
  if (at && at.run) return { lean: 0.28, crouch: 0.04, shield: 'forward', spear: 'back', run: true };
  if (at && at.air) return at.air === 'dive' ? { lean: 0, crouch: 0, shield: 'side', spear: 'down' } : { lean: -0.12, crouch: 0, shield: 'side', spear: 'up', stretch: true };
  const fx = c.state.fx;
  if (fx && fx.phase === 'cast') {
    if (fx.action === 'charge') return { lean: 0.24 * Math.min(1, fx.t / 0.3), crouch: 0.08, shield: 'forward', spear: 'back', paw: true };
    if (fx.action === 'bash') return fx.t < fx.cast * BASH_AT ? { lean: -0.08, crouch: 0.05, shield: 'pull', spear: 'back' } : { lean: 0.2, crouch: 0.05, shield: 'bash', spear: 'back' };
    if (fx.action === 'leap') return { lean: 0.05, crouch: 0.16 * Math.min(1, fx.t / LEAP_CROUCH), shield: 'side', spear: 'up' };
  }
  if (fx && fx.phase === 'act' && fx.action === 'bash') return { lean: 0.2, crouch: 0.05, shield: 'bash', spear: 'back' };
  return { lean: 0, crouch: shieldUp(c.match) ? 0.06 : 0, shield: shieldUp(c.match) ? 'raised' : 'side', spear: 'up' };
}

// 盾的位置（面向右的身體座標）
const SHIELD_AT = { side: [12, -27, 0.9], raised: [18, -36, 1.15], forward: [17, -30, 1.05], pull: [9, -33, 1.1], bash: [25, -33, 1.15] };

// ---------- 繪圖 ----------

// 大樹守衛：樹皮鎧甲的戰士（身上長青苔、頭盔頂一叢葉子、面罩縫透出黃光），前手一面木盾（金邊、葉子紋），後手一根長矛。
// at = 不畫在角色的位置（衝鋒中的飛行物、躍擊的半空中）：{ x, y, facing, run | air }
function drawGuardian(ctx, c, e, hurt, at) {
  const x = at ? at.x : e.x, y = at ? at.y : e.y;
  const f = at ? at.facing : e.facing;
  const s = e.h / 58;
  const pose = poseOf(c, at);
  const fill = (col) => (hurt ? '#ffffff' : col);
  if (!at || !at.air) {   // 腳下的影子（跳在空中就沒有）
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(x, y + 1, e.hw + 5, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s * f, s * (1 - pose.crouch) * (pose.stretch ? 1.06 : 1));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const outline = 'rgba(0,0,0,0.55)';
  // 腿（跑步時前後擺）
  const swing = pose.run ? Math.sin(c.time * 22) * 6 : pose.paw ? Math.max(0, Math.sin(c.time * 14)) * -3 : 0;
  ctx.fillStyle = fill(BARK_DARK);
  ctx.fillRect(-9 - swing * 0.5, -20, 7, 18);
  ctx.fillRect(2 + swing * 0.5, -20, 7, 18);
  ctx.fillRect(-11 - swing * 0.5, -4, 11, 4);
  ctx.fillRect(1 + swing * 0.5, -4, 12, 4);
  ctx.rotate(pose.lean);
  // 長矛（身體後面）
  drawSpear(ctx, pose.spear, hurt);
  // 身體：樹皮鎧甲
  ctx.fillStyle = fill(BARK);
  ctx.strokeStyle = outline;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-14, -18);
  ctx.lineTo(14, -18);
  ctx.quadraticCurveTo(16, -34, 12, -47);
  ctx.lineTo(-12, -47);
  ctx.quadraticCurveTo(-16, -34, -14, -18);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  if (!hurt) {
    ctx.strokeStyle = 'rgba(40,24,12,0.55)';   // 樹皮紋
    ctx.lineWidth = 1.2;
    for (const bx of [-8, -2, 5, 10]) { ctx.beginPath(); ctx.moveTo(bx, -45); ctx.quadraticCurveTo(bx + 2, -32, bx - 1, -20); ctx.stroke(); }
    ctx.fillStyle = MOSS;   // 肩上的青苔
    ctx.beginPath(); ctx.ellipse(-7, -46, 7, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(8, -45, 5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = fill(BARK_DARK);   // 腰帶 + 金扣
  ctx.fillRect(-14, -23, 28, 4);
  ctx.fillStyle = fill(GOLD);
  ctx.fillRect(4, -23.5, 5, 5);
  // 頭盔
  ctx.fillStyle = fill('#7c5a3a');
  ctx.strokeStyle = outline;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-9, -46); ctx.lineTo(-9, -55); ctx.quadraticCurveTo(0, -62, 9, -55); ctx.lineTo(10, -46); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = hurt ? '#ccc' : '#fde047';   // 面罩縫透出的光
  ctx.fillRect(1, -53, 9, 2.5);
  // 頭頂的葉子
  for (const [lx, ly, a] of [[-6, -60, -0.7], [0, -63, 0], [6, -60, 0.7]]) {
    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(a);
    ctx.fillStyle = fill(a ? LEAF : LEAF_LIGHT);
    ctx.beginPath(); ctx.ellipse(0, -4, 3, 7, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // 盾（前手）
  const [sx, sy, sk] = SHIELD_AT[pose.shield] || SHIELD_AT.side;
  ctx.strokeStyle = fill(BARK);
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(6, -40); ctx.lineTo(sx - 4, sy + 2); ctx.stroke();   // 手臂
  drawShield(ctx, sx, sy, sk, hurt, pose.shield === 'raised' || pose.shield === 'bash');
  ctx.restore();
}

// 長矛：up = 直直拿著（矛尖朝上）、back = 斜斜往後夾著（衝鋒、盾擊）、down = 矛尖朝下（躍擊俯衝）
function drawSpear(ctx, dir, hurt) {
  const pts = dir === 'down' ? [[2, -50], [2, 16]] : dir === 'back' ? [[-4, -34], [-30, -58]] : [[-12, -4], [-10, -78]];
  const [[ax, ay], [bx, by]] = pts;
  ctx.strokeStyle = hurt ? '#ddd' : '#5b3a1e';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  // 矛尖：一片石頭磨成的葉子
  const d = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / d, uy = (by - ay) / d;
  ctx.fillStyle = hurt ? '#fff' : '#a8a29e';
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(bx + ux * 12, by + uy * 12);
  ctx.lineTo(bx - uy * 4, by + ux * 4);
  ctx.lineTo(bx - ux * 2, by - uy * 2);
  ctx.lineTo(bx + uy * 4, by - ux * 4);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
}

// 木盾：橢圓（側面看過去），金屬邊、木板紋、中間一片葉子紋。glow = 舉起來 / 撞出去時邊緣亮一點
function drawShield(ctx, sx, sy, k, hurt, glow) {
  ctx.save();
  ctx.translate(sx, sy);
  ctx.scale(k, k);
  ctx.fillStyle = hurt ? '#fff' : WOOD;
  ctx.strokeStyle = hurt ? '#eee' : glow ? '#fcd34d' : GOLD;
  ctx.lineWidth = glow ? 3 : 2.2;
  ctx.beginPath(); ctx.ellipse(0, 0, 8, 17, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (!hurt) {
    ctx.strokeStyle = 'rgba(60,36,16,0.6)';
    ctx.lineWidth = 1;
    for (const py of [-8, 0, 8]) { ctx.beginPath(); ctx.moveTo(-7, py); ctx.lineTo(7, py); ctx.stroke(); }
    ctx.fillStyle = LEAF;
    ctx.beginPath(); ctx.ellipse(0, 0, 3, 6, 0.3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// 盾擊的衝擊：盾牌形狀的一道弧往前推
function drawBashWave(ctx, p) {
  const dir = p.vx >= 0 ? 1 : -1;
  ctx.save();
  ctx.strokeStyle = 'rgba(253,230,138,0.85)';
  ctx.lineWidth = 3;
  for (let k = 0; k < 3; k++) {
    ctx.globalAlpha = 1 - k * 0.3;
    ctx.beginPath(); ctx.ellipse(p.x - dir * k * 7, p.y, 6, 18 - k * 3, 0, -Math.PI / 2, Math.PI / 2, dir < 0); ctx.stroke();
  }
  ctx.restore();
}

// 躍擊落地的震波：貼著地往兩邊推的塵土
function drawLeapWave(ctx, p) {
  ctx.fillStyle = 'rgba(214,211,209,0.8)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 10, 12, 8, 0, Math.PI, 0); ctx.fill();
}

// 預定躍擊（玩家回合）或正在躍擊的預兆：落地點上方一道往下變紅的光柱（寬 = 打得到的範圍，身體碰到就會被打到）、
// 底下一段實心的範圍、地上的準星、光柱頂端往下指的箭頭（名字、血條、瞄準的角度框都在人頭上，箭頭放得比它們高）。預兆時閃得比較快
const BEAM = 240;   // 光柱多高（px）
function drawLeapWarning(ctx, c) {
  const S = c.match.mechState;
  const fx = c.state.fx;
  const casting = fx && fx.action === 'leap' && fx.phase === 'cast';
  const spot = casting ? fx.step : (!fx && S && S.next && S.next.action === 'leap' ? S.next : null);
  if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) return;
  const g = c.match.byId('guardian');
  if (!g || !g.alive) return;
  const band = leapBand(spot);
  const w = band.x1 - band.x0;
  const pulse = casting ? 0.6 + 0.4 * Math.sin(c.time * 22) : 0.6 + 0.25 * Math.sin(c.time * 4);
  const top = Math.max(60, spot.y - BEAM), low = spot.y - 46;
  ctx.save();
  const beam = ctx.createLinearGradient(0, top, 0, spot.y);
  beam.addColorStop(0, 'rgba(239,68,68,0)');
  beam.addColorStop(1, `rgba(239,68,68,${0.32 * pulse})`);
  ctx.fillStyle = beam;
  ctx.fillRect(band.x0, top, w, spot.y - top);
  ctx.fillStyle = `rgba(239,68,68,${0.22 * pulse})`;
  ctx.fillRect(band.x0, low, w, spot.y - low);
  ctx.strokeStyle = `rgba(248,113,113,${pulse})`;
  ctx.lineWidth = 2;
  ctx.beginPath();   // 光柱兩邊的線（往上淡掉）+ 底下那段的框
  ctx.moveTo(band.x0 + 1, low); ctx.lineTo(band.x0 + 1, spot.y); ctx.lineTo(band.x1 - 1, spot.y); ctx.lineTo(band.x1 - 1, low);
  ctx.stroke();
  for (const x of [band.x0 + 1, band.x1 - 1]) {
    const edge = ctx.createLinearGradient(0, top, 0, low);
    edge.addColorStop(0, 'rgba(248,113,113,0)');
    edge.addColorStop(1, `rgba(248,113,113,${pulse})`);
    ctx.strokeStyle = edge;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, low); ctx.stroke();
  }
  ctx.strokeStyle = `rgba(254,202,202,${pulse})`;   // 地上的準星
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(spot.x, spot.y - 1, w / 2 - 6, 5, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(spot.x - 8, spot.y - 1); ctx.lineTo(spot.x + 8, spot.y - 1); ctx.stroke();
  const bob = Math.sin(c.time * 5) * 5;   // 光柱頂端往下指的箭頭
  ctx.fillStyle = `rgba(248,113,113,${0.55 + pulse * 0.45})`;
  ctx.beginPath();
  ctx.moveTo(spot.x, top + 26 + bob);
  ctx.lineTo(spot.x - 11, top + 8 + bob);
  ctx.lineTo(spot.x + 11, top + 8 + bob);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// 舉盾（玩家回合）或盾擊的預兆：盾牌前方淡淡的盾擊範圍（虛線框）
function drawBashZone(ctx, c) {
  const g = c.match.byId('guardian');
  if (!g || !g.alive) return;
  const fx = c.state.fx;
  const casting = fx && fx.action === 'bash' && fx.phase === 'cast';
  if (!casting && !(shieldUp(c.match) && !fx)) return;
  const facing = casting ? (fx.step.facing || g.facing) : (c.match.mechState.next.facing || g.facing);
  const band = bashBand(g, facing);
  const a = casting ? 0.35 + 0.3 * Math.sin(c.time * 18) : 0.22;
  ctx.save();
  ctx.fillStyle = `rgba(253,230,138,${a * 0.35})`;
  ctx.fillRect(band.x0, band.top, band.x1 - band.x0, band.bottom - band.top);
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = `rgba(253,230,138,${a + 0.15})`;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(band.x0 + 0.5, band.top + 0.5, band.x1 - band.x0 - 1, band.bottom - band.top - 1);
  ctx.restore();
}
