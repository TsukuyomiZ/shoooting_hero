import { CONFIG } from '../../shared/core/config.js';
import { GUARDIAN_ACTION_NAMES, leapBand, bashBand, chargeTarget, chargeLane, shieldUp } from '../../shared/maps/guardian.js';

// 菁英關「大樹守衛」的地圖畫面：守衛回合的動畫腳本（照伺服器廣播的招式播；衝鋒：踏地衝出去、躍擊：發抖蓄力起跳）、守衛 / 衝鋒 / 盾擊 / 躍擊震波 / 橫劈的繪圖、
// 預定衝鋒時一直人立著、預定躍擊時一直蹲著（一抽到就擺出架勢）、預定衝鋒的標記（目標身上的準星 + 衝鋒的路線）、預定躍擊的警示範圍、舉盾時盾牌前方的盾擊範圍（淡淡的）、倒下的特效。
// 橫劈沒有範圍提示（2026-10-19 使用者：取消）；菁英之路（c.rangeHints false）連躍擊的警示、衝鋒的路線與準星都不畫。
// 規則在 shared/maps/guardian.js；掛勾的說明見 index.js
const FPS = 60;
const BARK = '#6b4a2b', BARK_DARK = '#3f2a17', WOOD = '#8b5e34', MOSS = '#4d7c0f', LEAF = '#65a30d', LEAF_LIGHT = '#84cc16', GOLD = '#d4a017';
// 預兆的時間點都是「播到幾成」（照招式的 cast 秒數，config.GUARDIAN.cast 改長改短都一樣好看）
// 衝鋒的起手（2026-10-19 使用者：像馬人立一樣把腳舉起來，而且是「決定要衝鋒的時候」就進入）：一抽到衝鋒（預定的下一招）就往後仰、
// 前腳高高抬起（REAR_RISE 秒抬到最高，update 推進 state.rear），整個玩家回合都人立著；輪到他時在最高點再停一下 → 前腳重重踏下（塵土、畫面一震）→ 壓低身子刨地
const REAR_RISE = 0.35;     // 抽到衝鋒之後幾秒抬到最高（秒）
const REAR_HOLD = 0.35;     // 輪到他時：停在最高點到這裡（還沒人立的話，這段時間抬起來）
const REAR_STOMP = 0.47;    // 踏回地上（之後到衝出去都在刨地）
const REAR_TILT = 0.5;      // 人立時整個人以後腳跟為支點往後仰多少（弧度）
// 躍擊的起手（2026-10-19 使用者：先蹲下，而且「一決定就蹲著等」）：一抽到躍擊（預定的下一招）就深深蹲下（SQUAT_SINK 秒蹲到最低，update 推進 state.squat），
// 整個玩家回合都蹲著（面向落地點）；輪到他時蹲著發抖蓄力，播到 LEAP_AT 起跳，剩下的預兆時間都在空中
const SQUAT_SINK = 0.35;    // 抽到躍擊之後幾秒蹲到最低（秒）
const LEAP_AT = 0.22;       // 輪到他時：播到這裡起跳（還沒蹲下的話，這段時間的前六成蹲下去）
const LEAP_SHAKE = 0.24;    // 起跳前最後這麼久（秒）在發抖
const SQUAT_DROP = 12;      // 蹲到最低時身體往下沉幾 px（腿彎起來、兩腳張開，膝蓋往前頂出身體外）
const BASH_AT = 0.8;        // 盾擊的預兆播到幾成時把盾撞出去
const SLASH_AT = 0.7;       // 橫劈的預兆播到幾成時揮出去（之前是把長矛往後收）

export const guardian = {
  type: 'guardian',

  // 這一場的畫面狀態：
  //   fx       守衛出招的預兆 { action, t, phase: 'cast' | 'act', targetId, step, cast, rear0, squat0 }（守衛回合播完就清掉；
  //            rear0 / squat0 = 開始出招時人立 / 蹲下到哪裡）
  //   running  衝鋒衝出去了：飛行物本身就是他（見 drawProjectile），角色先不畫
  //   rear     預定衝鋒時人立的程度（0..1，update 照遊戲時間推進；出招時交給 fx.rear0）
  //   squat    預定躍擊時蹲下的程度（0..1，同上；出招時交給 fx.squat0）
  create: () => ({ fx: null, running: false, rear: 0, squat: 0 }),

  turnScript: guardianTurnScript,
  abortScript(c) { c.state.fx = null; c.state.running = false; },   // 播到一半丟掉：跳在半空中、衝出去（不畫）不要一直留著
  onDeath: onGuardianDeath,

  // 衝鋒時腳下揚起塵土（照遊戲時間，每秒 40 顆）；還沒輪到他出招時擺出預定那一招的架勢、一直維持：
  // 衝鋒 = 人立起來（抬起來的那一下出聲）、躍擊 = 蹲下去（蹲下去的那一下出聲）。畫圖只讀狀態
  update(c, dt) {
    for (const p of c.projectiles) if (p.weapon && p.weapon.id === 'guardianCharge') chargeDust(c, p);
    const g = c.match.byId('guardian');
    const S = c.match.mechState;
    const plan = !c.state.fx && g && g.alive && S && S.next ? S.next.action : null;
    if (plan === 'charge' && c.state.rear === 0) c.fx.sound('heave', { x: g.x });
    if (plan === 'leap' && c.state.squat === 0) c.fx.sound('step', { x: g.x });
    c.state.rear = plan === 'charge' ? Math.min(1, c.state.rear + dt / REAR_RISE) : 0;
    c.state.squat = plan === 'leap' ? Math.min(1, c.state.squat + dt / SQUAT_SINK) : 0;
  },

  // 衝鋒撞到人（路上撞開的震小一點、撞到目標停下的震大一點）、盾擊 / 躍擊打到人：木屑與塵土；橫劈掃到人：刀光的碎屑；舉盾時被打到：盾牌上冒火星
  showEvent(c, ev, made) {
    const p = c.projectiles.find(q => q.i === ev.p);
    const id = p && p.weapon && p.weapon.id;
    if (id === 'guardianCharge' && ev.target && ev.type === 'pierce') {
      c.fx.shake(5);
      c.fx.sound('thunk', { x: ev.x });
      c.fx.particles(ev.x, ev.y, 8, { speed: 160, life: 0.5, size: 3, color: '#a16207', gravity: 600 });
    } else if (id === 'guardianCharge' && ev.target) {
      c.fx.shake(10);
      c.fx.sound('stomp', { x: ev.x });
      c.fx.particles(ev.x, ev.y, 16, { speed: 200, life: 0.6, size: 3.5, color: '#a16207', gravity: 600 });
    } else if (id === 'guardianSlash' && ev.damages) {
      c.fx.shake(4);
      c.fx.particles(ev.x, ev.y, 10, { speed: 190, life: 0.4, size: 2.5, color: '#e7e5e4', gravity: 300 });
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
    if (id === 'guardianSlash') { drawSlashArc(ctx, p); return true; }
    return false;
  },

  // 地上的提示（角色之前畫）：預定衝鋒的目標與路線、預定躍擊的落地範圍、舉盾時盾牌前方的盾擊範圍（橫劈不畫範圍）
  drawScene(ctx, c) {
    if (c.rangeHints !== false) {   // 菁英之路：躍擊、衝鋒不畫提示範圍
      drawChargeMark(ctx, c);
      drawLeapWarning(ctx, c);
    }
    drawBashZone(ctx, c);
  },

  // 一般那一行（敵人剩餘）+ 守衛的血量、預定的下一招（衝鋒帶要衝向誰）另起一行（接在同一行會超出右上的名單框）
  hud(c, line) {
    const lines = [line];
    const e = c.match.byId('guardian');
    const next = c.match.mechState && c.match.mechState.next;
    if (e && e.alive) {
      const color = next && next.action === 'leap' ? '#fdba74' : '#fca5a5';
      lines.push([`大樹守衛 ${e.hp} / ${e.maxHp}`, color]);
      const name = next ? GUARDIAN_ACTION_NAMES[next.action] || next.action : '';
      const target = next && next.action === 'charge' ? chargeTarget(c.match, e, next) : null;
      const extra = next && next.action === 'shield' ? `（減傷 ${CONFIG.GUARDIAN.shieldCut}%）` : target ? ` → ${target.name}` : '';
      if (name) lines.push([`下一招：${name}${extra}`, color]);
    }
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 守衛的回合：預兆（衝鋒：人立、前腳踏地、壓低身子刨地；盾擊：盾往後收再撞出去；躍擊：深蹲發抖蓄力、跳起來沿弧線飛到落地點；橫劈：長矛往後收再掃出去）
// → 出招（照 shotScript 重播）→ 校正成伺服器結果。躍擊的回合有兩招（落地之後接橫劈），一招一招照順序播。
// 全部播完才換上伺服器預定的下一招（msg.boss.next）：躍擊的警示留到真的落地，舉盾的話照預定的方向轉過去
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
  const fx = c.state.fx = { action: b.action, t: 0, phase: 'cast', targetId: b.targetId ?? null, step: b, cast: cast / FPS, rear0: c.state.rear, squat0: c.state.squat };
  const N = GUARDIAN_ACTION_NAMES;
  if (b.action === 'charge') c.fx.banner(`大樹守衛：${N.charge}${target ? ` → ${target.name}` : ''}！`, '#fca5a5');
  else if (b.action === 'bash') c.fx.banner(`大樹守衛：${N.bash}！`, '#fde68a');
  else if (b.action === 'leap') c.fx.banner(`大樹守衛：${N.leap}！`, '#fdba74');
  else if (b.action === 'slash') c.fx.banner(`大樹守衛：${N.slash}！`, '#fca5a5');
  else c.fx.banner(`大樹守衛${N.idle}中`, '#e9d5ff');
  if (g && b.action === 'charge' && target && target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
  if (g && b.action === 'bash' && (b.facing === 1 || b.facing === -1)) g.facing = b.facing;
  const takeoff = Math.round(cast * LEAP_AT);
  const stomp = Math.round(cast * REAR_STOMP);
  const bash = Math.round(cast * BASH_AT);
  const slash = Math.round(cast * SLASH_AT);
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    if (g && b.action === 'charge' && i === 0 && fx.rear0 < 0.5) c.fx.sound('heave', { x: g.x });   // 還沒人立（例如剛重連）：現在才抬起來
    if (g && b.action === 'charge' && i === stomp) {   // 前腳踏回地上：塵土往兩邊噴、畫面一震
      c.fx.shake(6);
      c.fx.sound('stomp', { x: g.x });
      c.fx.particles(g.x + g.facing * 8, g.y - 2, 12, { speed: 150, life: 0.5, size: 3, color: '#a8a29e', gravity: 600 });
    }
    if (g && b.action === 'charge' && i > stomp && (i - stomp) % 10 === 0) {   // 刨地：後腳揚起塵土
      c.fx.particles(g.x - g.facing * (g.hw - 2), g.y - 2, 4, { speed: 90, life: 0.4, size: 2.5, color: '#a8a29e', gravity: 500 });
      if (i - stomp === 10) c.fx.sound('step', { x: g.x });
    }
    if (g && b.action === 'leap' && i === 0 && fx.squat0 < 0.5) c.fx.sound('step', { x: g.x });   // 還沒蹲下（例如剛重連）：現在才蹲下去
    if (g && b.action === 'leap' && i < takeoff && i >= takeoff - LEAP_SHAKE * FPS && i % 6 === 0) {   // 發抖蓄力：腳邊冒一點塵土
      c.fx.particles(g.x + (i % 12 ? 1 : -1) * g.hw * 0.7, g.y - 1, 2, { speed: 60, life: 0.35, size: 2, color: '#a8a29e', gravity: 400 });
    }
    if (g && b.action === 'bash' && i === bash) c.fx.sound('thunk', { x: g.x });
    if (g && b.action === 'slash' && i === slash) {   // 揮出去：破風聲、腳下掃起一圈落葉
      c.fx.sound('heave', { x: g.x });
      c.fx.particles(g.x, g.y - 4, 10, { speed: 150, life: 0.5, size: 2.5, color: LEAF, gravity: 300 });
    }
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

// 躍擊跳在半空中的位置（預兆蹲完（播到 LEAP_AT）之後，沿弧線從起跳點飛到落地點；最後三成往下俯衝）；不在空中回傳 null
function airborne(c, e) {
  const fx = c.state.fx;
  if (!fx || fx.action !== 'leap' || fx.phase !== 'cast') return null;
  const up = fx.cast * LEAP_AT;
  if (fx.t < up) return null;
  const b = fx.step;
  if (!Number.isFinite(b.x0) || !Number.isFinite(b.x)) return null;
  const k = Math.min(1, (fx.t - up) / Math.max(0.1, fx.cast - up));
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

// 出招的姿勢（畫守衛用）：lean = 往前傾（弧度）、crouch = 整個人壓扁一點（0..1）、shield = 盾的位置、spear = 長矛的方向、run = 跑步中、
// rear = 人立的程度（0..1：以後腳跟為支點往後仰、前腳抬起來）、squat = 深蹲的程度（0..1：腿彎起來、身體往下沉）、shake = 蓄力發抖
// （橫劈：預兆的前 SLASH_AT 收矛，之後到掃完都是平平掃出去的樣子）
// facing = 畫的時候面向哪邊（預定衝鋒：轉向要衝的人；預定 / 出招中的躍擊：轉向落地點；不給 = 角色自己的 facing）
function poseOf(c, at, e) {
  if (at && at.run) return { lean: 0.28, crouch: 0.04, shield: 'forward', spear: 'back', run: true };
  if (at && at.air) return at.air === 'dive' ? { lean: 0, crouch: 0, shield: 'side', spear: 'down' } : { lean: -0.12, crouch: 0, shield: 'side', spear: 'up', stretch: true };
  const fx = c.state.fx;
  if (!fx && c.state.rear > 0) {   // 預定衝鋒：人立著等（前腳在空中微微踢動），面向要衝的人
    const t = chargeTarget(c.match, e, c.match.mechState.next);
    const facing = t && t.x !== e.x ? (t.x > e.x ? 1 : -1) : undefined;
    return { lean: 0, crouch: 0, shield: 'rear', spear: 'high', rear: easeOut(c.state.rear) * (0.95 + 0.05 * Math.sin(c.time * 3)), facing };
  }
  if (!fx && c.state.squat > 0) {   // 預定躍擊：蹲著等（微微起伏），面向落地點
    const k = easeOut(c.state.squat);
    return { lean: 0.22 * k, crouch: 0.04 * k, shield: 'tuck', spear: 'up', squat: k * (0.96 + 0.04 * Math.sin(c.time * 2.5)), facing: facingTo(e, c.match.mechState.next.x) };
  }
  if (fx && fx.phase === 'cast') {
    if (fx.action === 'charge') {
      const k = fx.t / fx.cast;
      if (k < REAR_STOMP) return { lean: 0, crouch: 0, shield: 'rear', spear: 'high', rear: rearOf(k, fx.rear0 || 0) };
      return { lean: 0.24 * Math.min(1, (fx.t - fx.cast * REAR_STOMP) / 0.2), crouch: 0.08, shield: 'forward', spear: 'back', paw: true };
    }
    if (fx.action === 'bash') return fx.t < fx.cast * BASH_AT ? { lean: -0.08, crouch: 0.05, shield: 'pull', spear: 'back' } : { lean: 0.2, crouch: 0.05, shield: 'bash', spear: 'back' };
    if (fx.action === 'leap') {   // 從 squat0（出招前已經蹲到哪裡，平常是 1）蹲到最低（還沒蹲的話在起跳前的前六成蹲下去），蹲著發抖蓄力
      const up = fx.cast * LEAP_AT, s0 = fx.squat0 || 0;
      const k = s0 + (1 - s0) * easeOut(Math.min(1, fx.t / Math.max(0.05, up * 0.6)));
      return { lean: 0.22 * k, crouch: 0.04 * k, shield: 'tuck', spear: 'up', squat: k, shake: fx.t >= up - LEAP_SHAKE, facing: facingTo(e, fx.step && fx.step.x) };
    }
    if (fx.action === 'slash') return fx.t < fx.cast * SLASH_AT ? { lean: -0.1, crouch: 0.1, shield: 'side', spear: 'back' } : { lean: 0.18, crouch: 0.08, shield: 'side', spear: 'level' };
  }
  if (fx && fx.phase === 'act' && fx.action === 'bash') return { lean: 0.2, crouch: 0.05, shield: 'bash', spear: 'back' };
  if (fx && fx.phase === 'act' && fx.action === 'slash') return { lean: 0.18, crouch: 0.08, shield: 'side', spear: 'level' };
  return { lean: 0, crouch: shieldUp(c.match) ? 0.06 : 0, shield: shieldUp(c.match) ? 'raised' : 'side', spear: 'up' };
}

// 盾的位置（面向右的身體座標）。rear = 人立時盾舉到胸口以上（不擋住抬起來的前腳）、tuck = 深蹲時盾收到胸前（露出彎起來的膝蓋）
const SHIELD_AT = { side: [12, -27, 0.9], raised: [18, -36, 1.15], forward: [17, -30, 1.05], pull: [9, -33, 1.1], bash: [25, -33, 1.15], rear: [13, -47, 0.95], tuck: [10, -38, 0.85] };

const easeOut = (k) => 1 - (1 - k) * (1 - k);
// 從 e 看 x 在哪一邊（1 / -1）；x 不是數字、就在他腳下 = undefined（照角色自己的 facing）
const facingTo = (e, x) => (Number.isFinite(x) && x !== e.x ? (x > e.x ? 1 : -1) : undefined);
// 衝鋒出招播到 k 成（0..REAR_STOMP）時人立的程度：從 r0（出招前已經人立到哪裡，平常是 1）抬到最高、停著 → 重重踏下去（先慢後快）
function rearOf(k, r0) {
  if (k < REAR_HOLD) return r0 + (1 - r0) * easeOut(k / REAR_HOLD);
  const d = Math.min(1, (k - REAR_HOLD) / (REAR_STOMP - REAR_HOLD));
  return 1 - d * d;
}

// ---------- 繪圖 ----------

// 大樹守衛：樹皮鎧甲的戰士（身上長青苔、頭盔頂一叢葉子、面罩縫透出黃光），前手一面木盾（金邊、葉子紋），後手一根長矛。
// at = 不畫在角色的位置（衝鋒中的飛行物、躍擊的半空中）：{ x, y, facing, run | air }
function drawGuardian(ctx, c, e, hurt, at) {
  const x = at ? at.x : e.x, y = at ? at.y : e.y;
  const pose = poseOf(c, at, e);
  const f = at ? at.facing : pose.facing || e.facing;
  const s = e.h / 58;
  const fill = (col) => (hurt ? '#ffffff' : col);
  if (!at || !at.air) {   // 腳下的影子（跳在空中就沒有）
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(x, y + 1, e.hw + 5, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save();
  ctx.translate(x + (pose.shake ? Math.sin(c.time * 70) * 1.2 : 0), y);   // 蓄力發抖（只是畫法，照時間晃）
  ctx.scale(s * f, s * (1 - pose.crouch) * (pose.stretch ? 1.06 : 1));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const outline = 'rgba(0,0,0,0.55)';
  const rear = pose.rear || 0, squat = pose.squat || 0;
  if (rear) {   // 人立：整個人以後腳跟為支點往後仰
    ctx.translate(-11, 0);
    ctx.rotate(-REAR_TILT * rear);
    ctx.translate(11, 0);
  }
  // 腿（跑步時前後擺；人立時前腳抬起來；深蹲時兩腳彎起來）
  const swing = pose.run ? Math.sin(c.time * 22) * 6 : pose.paw ? Math.max(0, Math.sin(c.time * 14)) * -3 : 0;
  ctx.fillStyle = fill(BARK_DARK);
  if (squat) {
    drawBentLeg(ctx, -5.5, -5.5 - 4 * squat, squat, fill(BARK_DARK));   // 兩腳往前後張開
    drawBentLeg(ctx, 5.5, 5.5 + 5 * squat, squat, fill(BARK_DARK));
  } else {
    ctx.fillRect(-9 - swing * 0.5, -20, 7, 18);
    ctx.fillRect(-11 - swing * 0.5, -4, 11, 4);
    if (rear) drawRaisedLeg(ctx, rear);
    else { ctx.fillRect(2 + swing * 0.5, -20, 7, 18); ctx.fillRect(1 + swing * 0.5, -4, 12, 4); }
  }
  ctx.translate(0, SQUAT_DROP * squat);   // 深蹲：腰以上往下沉
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
  drawShield(ctx, sx, sy, sk, hurt, pose.shield === 'raised' || pose.shield === 'bash' || pose.shield === 'rear');
  ctx.restore();
}

// 長矛：up = 直直拿著（矛尖朝上）、back = 斜斜往後夾著（衝鋒、盾擊、橫劈收矛）、down = 矛尖朝下（躍擊俯衝）、level = 往前平平掃出去（橫劈）、
// high = 高高舉起、矛尖斜斜指向前上方（衝鋒起手的人立）
function drawSpear(ctx, dir, hurt) {
  const pts = dir === 'down' ? [[2, -50], [2, 16]] : dir === 'back' ? [[-4, -34], [-30, -58]]
    : dir === 'level' ? [[-16, -32], [34, -30]] : dir === 'high' ? [[-16, -22], [14, -80]] : [[-12, -4], [-10, -78]];
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

// 人立時抬起來的前腳（面向右的身體座標，髖關節在 (5.5, -20)）：大腿往前抬到快水平、小腿往下垂、腳掌朝前（rear = 0..1）
function drawRaisedLeg(ctx, rear) {
  ctx.save();
  ctx.translate(5.5, -20);
  ctx.rotate(-1.65 * rear);    // 大腿往前抬（超過水平一點）
  ctx.fillRect(-3.5, 0, 7, 10);
  ctx.translate(0, 9);
  ctx.rotate(1.3 * rear);      // 膝蓋彎下來，小腿往下垂
  ctx.fillRect(-3.5, 0, 7, 9);
  ctx.fillRect(-4.5, 7, 12, 4);
  ctx.restore();
}

// 深蹲時彎起來的腿（髖關節在 (hx, -20 + 下沉)，腳踝在 (ax, -3)，膝蓋往前頂出去）：粗線畫大腿、小腿，再一塊腳掌
function drawBentLeg(ctx, hx, ax, squat, color) {
  const hy = -20 + SQUAT_DROP * squat, ay = -3, seg = 10;
  const d = Math.hypot(ax - hx, ay - hy);
  const kx = (hx + ax) / 2 + Math.sqrt(Math.max(0, seg * seg - d * d / 4)), ky = (hy + ay) / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 7;
  ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.lineTo(ax, ay); ctx.stroke();
  ctx.restore();
  ctx.fillRect(ax - 5.5, -4, 12, 4);
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

// 橫劈：往兩邊掃出去的一道月牙形刀光（凸的那邊朝前）
function drawSlashArc(ctx, p) {
  const dir = p.vx >= 0 ? 1 : -1;
  const r = p.weapon.hitRadius || 20;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(dir, 1);
  ctx.fillStyle = 'rgba(245,245,244,0.85)';
  ctx.strokeStyle = 'rgba(254,202,202,0.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(-r * 0.6, 0, r, -Math.PI * 0.42, Math.PI * 0.42);         // 外緣
  ctx.arc(-r, 0, r * 0.9, Math.PI * 0.4, -Math.PI * 0.4, true);      // 內緣
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

// 預定衝鋒（玩家回合）或衝鋒的預兆：要衝向的人身上一圈轉動的準星，加上守衛到他那一行淡淡的路線（上下兩條虛線 = 撞得到的高度，
// 路線上的人也會被撞到）。目標照 chargeTarget（被標記的人倒下了就換成現在最遠的）。預兆時閃得比較快
function drawChargeMark(ctx, c) {
  const g = c.match.byId('guardian');
  if (!g || !g.alive) return;
  const S = c.match.mechState;
  const fx = c.state.fx;
  const casting = fx && fx.action === 'charge' && fx.phase === 'cast';
  const t = casting ? c.match.byId(fx.targetId) : (!fx && S && S.next && S.next.action === 'charge' ? chargeTarget(c.match, g, S.next) : null);
  if (!t || !t.alive) return;
  const lane = chargeLane(g, t);
  const pulse = casting ? 0.6 + 0.4 * Math.sin(c.time * 22) : 0.6 + 0.25 * Math.sin(c.time * 4);
  ctx.save();
  ctx.fillStyle = `rgba(239,68,68,${0.1 * pulse})`;
  ctx.fillRect(lane.x0, lane.top, lane.x1 - lane.x0, lane.bottom - lane.top);
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = `rgba(248,113,113,${0.45 * pulse})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(lane.x0, lane.top); ctx.lineTo(lane.x1, lane.top);
  ctx.moveTo(lane.x0, lane.bottom); ctx.lineTo(lane.x1, lane.bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  const r = Math.max(t.h, 2 * t.hw) * 0.75 + 6;   // 準星：身體外面一圈 + 四個轉動的刻度
  ctx.strokeStyle = `rgba(248,113,113,${pulse})`;
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(t.x, t.cy, r, 0, Math.PI * 2); ctx.stroke();
  const spin = c.time * 1.5;
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const a = spin + k * Math.PI / 2, ux = Math.cos(a), uy = Math.sin(a);
    ctx.moveTo(t.x + ux * (r - 6), t.cy + uy * (r - 6));
    ctx.lineTo(t.x + ux * (r + 7), t.cy + uy * (r + 7));
  }
  ctx.stroke();
  ctx.restore();
}

// 預定躍擊（玩家回合）或正在躍擊的預兆：落地點上方一道往下變紅的光柱（寬 = 打得到的範圍，身體碰到就會被打到）、
// 底下一段實心的範圍、地上的準星、光柱頂端往下指的箭頭（名字、血條、瞄準的角度框都在人頭上，箭頭放得比它們高）。
// 落地之後接著的橫劈不畫範圍（2026-10-19 使用者：取消橫劈的提示範圍）。預兆時閃得比較快
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
