import { CONFIG } from '../../shared/core/config.js';
import { TENGU_ACTION_NAMES, featherSlot } from '../../shared/maps/tengu.js';

// 菁英關「天狗」的地圖畫面：天狗回合的動畫腳本（照伺服器廣播的招式播：羽刃 = 振翅飛到正中間的上方、羽毛一根一根展開；
// 風彈 = 舉起羽團扇蓄力、一搧射出去）、天狗（紅臉長鼻子、白色長髮、頭上黑色頭巾（頭襟）、白色山伏裝束配彩色梵天、背上一對黑色大翅膀、
// 手拿羽團扇、穿一齒高木屐，一直振翅飛著）、浮在他身邊的羽毛、玩家回合裡飛的羽毛（hazard：照真實時間飛，伺服器說打到 / 插地才收）、
// 插在地上的羽毛、回合收尾一口氣射完（turnVolley）、風彈與羽毛的畫法、隨著風飄的雲（看得出風往哪裡吹）、倒下的特效。
// 規則在 shared/maps/tengu.js；掛勾的說明見 index.js
const FPS = 60;
const FACE = '#c81e1e', FACE_DARK = '#8f1414', HAIR = '#f4f4f5', ROBE = '#f8fafc', ROBE_EDGE = '#cbd5e1', HAKAMA = '#e2e8f0';
const WING = '#111827', WING_HI = '#374151', FAN = '#3f6212', FAN_HI = '#65a30d', GETA = '#78350f';
const BONTEN = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6'];
const FLY_PART = 0.55;      // 羽刃：預兆播到這裡之前飛過去，之後羽毛一根一根展開
const SWING_AT = 0.75;      // 風彈：預兆播到這裡一搧（之前舉著扇子蓄力）
const STUCK_LIFE = 4;       // 插在地上的羽毛留幾秒（遊戲時間）

export const tengu = {
  type: 'tengu',

  // 這一場的畫面狀態：
  //   fx     天狗出招的預兆 { action, t, cast, step }（天狗回合播完就清掉）
  //   flap   振翅的時間（秒，update 推進；飛過去的時候翅膀拍得比較快）
  //   stuck  插在地上的羽毛 [{ id, x, y, angle, t }]（t = 插了幾秒，STUCK_LIFE 之後淡掉）
  //   cloud / streak  雲、風痕已經飄了多遠（update 照現在的風累加：換風的時候只改速度，雲不會跳）
  // 正在飛的羽毛在機制狀態 mechState.flying（[{ id, x0, y0, vx, vy, t0, x, y }]：x0 / y0 / t0 = 從哪裡、真實時間幾秒（c.clock()）出發，
  // update 照真實時間算 x / y；重連的快照只有 x / y / vx / vy：從現在這裡接著飛）；浮著幾根在 mechState.hover
  create: () => ({ fx: null, flap: 0, stuck: [], cloud: 0, streak: 0 }),

  turnScript: tenguTurnScript,
  abortScript(c) {
    c.state.fx = null;
  },
  onDeath: onTenguDeath,

  // 振翅、插在地上的羽毛淡掉；正在飛的羽毛照真實時間往前（c.clock()：卡頓、自己開著慢動作也跟伺服器一樣快），
  // 碰到地形就先插在地上（伺服器說打到人再改）。畫圖只讀狀態
  update(c, dt) {
    const st = c.state;
    const S = c.match.mechState;
    st.flap += dt * (st.fx && st.fx.action === 'feather' && st.fx.t < st.fx.cast * FLY_PART ? 2.2 : 1);
    const wind = c.match.wind || 0;
    st.cloud += (wind ? wind * 7 : 5) * dt;
    st.streak += wind * 30 * dt;
    for (const s of st.stuck) s.t += dt;
    while (st.stuck.length && st.stuck[0].t >= STUCK_LIFE) st.stuck.shift();
    if (!S || !Array.isArray(S.flying)) return;
    const now = c.clock();
    const team = 'enemies';
    for (let i = S.flying.length - 1; i >= 0; i--) {
      const f = S.flying[i];
      if (!Number.isFinite(f.t0)) {   // 重連時快照給的（x / y，還沒出發的多帶 wait）：從現在這裡接著飛 / 等 wait 秒再出發
        f.x0 = Number.isFinite(f.x0) ? f.x0 : f.x;
        f.y0 = Number.isFinite(f.y0) ? f.y0 : f.y;
        f.t0 = now + (Number.isFinite(f.wait) ? f.wait : 0);
      }
      if (now < f.t0) continue;
      if (!f.launched) {
        f.launched = true;
        c.fx.sound('feather', { x: f.x0, vol: 0.5 });
      }
      const t = now - f.t0;
      f.x = f.x0 + f.vx * t;
      f.y = f.y0 + f.vy * t;
      if (f.x < -20 || f.x > CONFIG.WORLD_W + 20 || f.y > CONFIG.WATER_LEVEL) { S.flying.splice(i, 1); continue; }
      if (c.match.terrain.blocksShot(f.x, f.y, team)) {   // 插在地上（伺服器的 hazard 之後會說是插地還是打到人）
        S.flying.splice(i, 1);
        st.stuck.push({ id: f.id, x: f.x, y: f.y, angle: Math.atan2(f.vy, f.vx), t: 0 });
        c.fx.particles(f.x, f.y, 4, { speed: 70, life: 0.35, size: 2, color: '#a8a29e', gravity: 300 });
      }
    }
  },

  // 回合收尾時羽毛還沒飛完（伺服器的 hazardFinish）：慢慢飛的那幾根換成重播的飛行物（drawProjectile 畫），一口氣射完
  turnVolley(c, shot) {
    if (shot.kind !== 'tenguFeather') return null;
    const S = c.match.mechState;
    if (S) {
      S.flying = [];
      if (Number.isFinite(shot.hover)) S.hover = shot.hover;
    }
    return { banner: (name) => `${name}的羽毛一口氣射下來！`, color: '#d4d4d8' };
  },

  // 玩家回合裡的羽毛（伺服器的 hazard*）。msg.start（跟著 turn 來）——這幾根從他身邊出發（各自晚 delay 秒），浮著的剩 hover 根；
  // 時間從收到 turn 的時刻 msg.recvAt 算。伺服器的 hazard——畫面的部分收到就演（early；照順序套用時再叫一次就不重演）：
  // 結束的羽毛（打到人 = 收掉、在那個人身上噴羽屑；插地 = 插在伺服器說的地方；飛出去 / 天狗倒下 = 收掉）；
  // 照順序套用時（early false，扣血與飄字 GameView 剛處理完）：畫面一震
  hazard(c, msg, early = false) {
    const S = c.match.mechState;
    if (!S) return;
    const at = Number.isFinite(msg.recvAt) ? msg.recvAt : c.clock();
    if (msg.start) {
      const h = msg.start;
      if (h.kind !== 'tengu') return;
      if (!Array.isArray(S.flying)) S.flying = [];
      for (const f of h.feathers || []) {
        S.flying.push({ id: f.id, x0: f.x0, y0: f.y0, vx: f.vx, vy: f.vy, t0: at + (f.delay || 0), x: f.x0, y: f.y0 });
      }
      if (Number.isFinite(h.hover)) S.hover = h.hover;
      return;
    }
    if (msg.kind !== 'tengu') return;
    // 天狗倒下、羽毛收掉（全部是 cancel）：等照順序套用（打倒他的那一槍還在播，不能先讓羽毛消失、洩漏結果）
    const cancelOnly = Array.isArray(msg.feathers) && msg.feathers.length > 0 && msg.feathers.every(e => e.end === 'cancel');
    if (early && cancelOnly) return;
    if (!msg.shown) {
      msg.shown = true;
      for (const end of msg.feathers || []) {
        const i = (S.flying || []).findIndex(f => f.id === end.id);
        const f = i >= 0 ? S.flying.splice(i, 1)[0] : null;
        const j = c.state.stuck.findIndex(s => s.id === end.id);
        const stuck = j >= 0 ? c.state.stuck[j] : null;
        const angle = f ? Math.atan2(f.vy, f.vx) : stuck ? stuck.angle : Math.PI / 2;
        if (end.end === 'ground') {
          if (stuck) { stuck.x = end.x; stuck.y = end.y; }
          else c.state.stuck.push({ id: end.id, x: end.x, y: end.y, angle, t: 0 });
        } else {
          if (stuck) c.state.stuck.splice(j, 1);   // 畫面先插在地上了，其實是打到人 / 被收掉
          if (end.end === 'hit') c.fx.particles(end.x, end.y, 9, { speed: 160, life: 0.45, size: 2.5, color: '#1f2937', gravity: 260 });
        }
      }
      if (Number.isFinite(msg.hover)) S.hover = msg.hover;
    }
    if (early) return;
    if (msg.damages && msg.damages.some(d => d.dmg > 0)) c.fx.shake(4);
  },

  // 風彈炸開：一圈綠白色的旋風碎屑；羽毛打到人：黑色羽屑
  showEvent(c, ev) {
    const p = c.projectiles.find(q => q.i === ev.p);
    const id = p && p.weapon && p.weapon.id;
    if (id === 'tenguGust' && (ev.type === 'explode' || ev.type === 'entity' || ev.type === 'terrain')) {
      c.fx.particles(ev.x, ev.y, 18, { speed: 260, life: 0.6, size: 3, color: '#a7f3d0', gravity: -40 });
      c.fx.sound('gust', { x: ev.x, vol: 0.7 });
    }
    if (id === 'tenguFeather' && ev.damages && ev.damages.some(d => d.dmg > 0)) {
      c.fx.particles(ev.x, ev.y, 9, { speed: 160, life: 0.45, size: 2.5, color: '#1f2937', gravity: 260 });
    }
  },

  drawEntity(ctx, c, e, hurt) {
    if (e.part !== 'tengu') return false;
    drawTengu(ctx, c, e, hurt);
    return 'body';
  },
  hpBar: (c, e) => (e.part === 'tengu' ? { w: 90, h: 8 } : null),

  drawProjectile(ctx, c, p) {
    const id = p.weapon.id;
    if (id === 'tenguFeather') { drawFeather(ctx, p.x, p.y, Math.atan2(p.vy, p.vx), 22, 1); return true; }
    if (id === 'tenguGust') { drawGust(ctx, p); return true; }
    return false;
  },

  // 地上的東西（角色之前畫）：隨著風飄的雲、插在地上的羽毛、浮在他身邊的羽毛（在他背後）、正在飛的羽毛
  drawScene(ctx, c) {
    drawClouds(ctx, c);
    for (const s of c.state.stuck) drawFeather(ctx, s.x - Math.cos(s.angle) * 7, s.y - Math.sin(s.angle) * 7, s.angle, 18, Math.min(1, (STUCK_LIFE - s.t) / 0.8));
    const g = c.match.byId('tengu');
    const S = c.match.mechState;
    if (!g || !g.alive || !S) return;
    const hover = Math.max(0, Math.min(CONFIG.TENGU.feathers, Math.floor(S.hover || 0)));
    for (let k = 0; k < hover; k++) {
      const s = featherSlot(g, k);
      const bob = Math.sin(c.time * 2.2 + k * 0.7) * 2;
      drawFeather(ctx, s.x + Math.cos(s.angle) * 6, s.y + Math.sin(s.angle) * 6 + bob, s.angle, 20, 0.95);
    }
    for (const f of S.flying || []) {
      if (!Number.isFinite(f.t0) || c.clock() < f.t0) {   // 還沒出發：在他身邊抖一下（要飛了）
        const shake = Math.sin(c.time * 40 + f.id) * 1.5;
        const x0 = Number.isFinite(f.x0) ? f.x0 : f.x, y0 = Number.isFinite(f.y0) ? f.y0 : f.y;
        drawFeather(ctx, x0 + shake, y0, Math.atan2(f.vy, f.vx), 20, 1);
        continue;
      }
      drawFeatherTrail(ctx, f);
      drawFeather(ctx, f.x, f.y, Math.atan2(f.vy, f.vx), 22, 1);
    }
  },

  // 一般那一行（敵人剩餘）+ 天狗的血量、預定的下一招、浮著幾根羽毛
  hud(c, line) {
    const lines = [line];
    const e = c.match.byId('tengu');
    const S = c.match.mechState;
    if (e && e.alive && S) {
      lines.push([`天狗 ${e.hp} / ${e.maxHp}`, '#fca5a5']);
      if (S.next) lines.push([`下一招：${TENGU_ACTION_NAMES[S.next.action] || S.next.action}`, '#fca5a5']);
      lines.push([`羽毛 ${S.hover} / ${CONFIG.TENGU.feathers}`, '#d4d4d8']);
    }
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 天狗的回合（飄完之後）：一招照順序播，全部播完才換上伺服器預定的下一招（msg.boss.next）
function* tenguTurnScript(c, msg) {
  const S = c.match.mechState;
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* stepScript(c, msg.actorId, step);
  c.state.fx = null;
  if (S && msg.boss.next !== undefined) S.next = msg.boss.next ? { ...msg.boss.next } : null;
}

// 一招：羽刃 = 振翅飛到正中間的上方（前 FLY_PART）、羽毛一根一根展開；風彈 = 舉起羽團扇、播到 SWING_AT 一搧，風彈照 shotScript 重播
function* stepScript(c, id, b) {
  const match = c.match;
  const g = match.byId(id);
  const S = match.mechState;
  const cast = Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS);
  const fx = c.state.fx = { action: b.action, t: 0, cast: cast / FPS, step: b };
  const N = TENGU_ACTION_NAMES;
  const target = b.targetId ? match.byId(b.targetId) : null;
  if (g && (b.facing === 1 || b.facing === -1)) g.facing = b.facing;
  if (b.action === 'feather') c.fx.banner(`天狗：${N.feather}！`, '#e4e4e7');
  else if (b.action === 'gust') c.fx.banner(`天狗：${N.gust}！${target ? ` → ${target.name}` : ''}`, '#a7f3d0');
  else c.fx.banner(`天狗${N.idle}中`, '#e9d5ff');

  const from = b.action === 'feather' && g ? { x: Number.isFinite(b.x0) ? b.x0 : g.x, y: Number.isFinite(b.y0) ? b.y0 : g.y } : null;
  const hover0 = b.action === 'feather' && S ? Math.max(0, (b.hover ?? CONFIG.TENGU.feathers) - (b.added ?? 0)) : 0;
  if (b.action === 'feather' && g) c.fx.sound('gust', { x: g.x, vol: 0.5 });
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    const k = i / cast;
    if (g && from && k <= FLY_PART) {   // 羽刃：飛過去（頭尾慢、中間快）
      const u = Math.min(1, k / FLY_PART);
      const s = u * u * (3 - 2 * u);
      g.x = from.x + (b.x - from.x) * s;
      g.y = from.y + (b.y - from.y) * s;
      if (i % 5 === 0) c.fx.particles(g.x - g.facing * 10, g.y - g.h * 0.6, 2, { speed: 40, life: 0.5, size: 2, color: '#d4d4d8', gravity: 0 });
    }
    if (g && from && S && k > FLY_PART) {   // 羽毛一根一根展開
      const u = (k - FLY_PART) / (1 - FLY_PART);
      const n = Math.min(b.hover, hover0 + Math.floor(u * (b.hover - hover0 + 1)));
      while (S.hover < n) {
        const s = featherSlot(g, S.hover);
        S.hover++;
        c.fx.particles(s.x, s.y, 3, { speed: 50, life: 0.3, size: 1.8, color: '#9ca3af', gravity: 0 });
        if (S.hover % 4 === 0) c.fx.sound('feather', { x: s.x, vol: 0.4 });
      }
    }
    if (g && b.action === 'gust') {
      if (i < cast * SWING_AT && i % 6 === 0) {   // 蓄力：扇子旁邊捲起小旋風
        const h = fanPoint(g, 'windup');
        c.fx.particles(h.x, h.y, 2, { speed: 60, life: 0.4, size: 2, color: '#a7f3d0', gravity: -20 });
      }
      if (i === Math.round(cast * SWING_AT)) c.fx.sound('gust', { x: g.x });
    }
    yield { frames: 1 };
  }
  fx.t = fx.cast;
  if (b.shot) {
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
  if (b.action === 'feather' && S && Number.isFinite(b.hover)) S.hover = b.hover;
}

// 天狗倒下：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
function onTenguDeath(c, e) {
  if (e.part !== 'tengu') return false;
  const S = c.match.mechState;   // 羽毛都跟著掉下來、收掉（伺服器不會再射）
  if (S) { S.flying = []; S.hover = 0; }
  c.fx.banner('天狗倒下了！', '#c084fc');
  c.fx.shake(10);
  c.fx.sound('gust', { x: e.x });
  c.fx.particles(e.x, e.cy, 30, { speed: 180, life: 1.4, size: 3.5, color: '#111827', gravity: 120 });
  c.fx.particles(e.x, e.cy - 20, 12, { speed: 140, life: 0.9, size: 2.5, color: '#f4f4f5', gravity: 60 });
  return true;
}

// ---------- 姿勢 ----------

// 現在拿扇子的樣子：idle（扇子垂在身前）、windup（風彈蓄力：扇子舉到頭後面）、swing（一搧之後往前揮出去）、spread（羽刃：雙手張開）
function fanPose(c) {
  const fx = c.state.fx;
  if (fx && fx.action === 'gust') return fx.t < fx.cast * SWING_AT ? 'windup' : 'swing';
  if (fx && fx.action === 'feather') return 'spread';
  return 'idle';
}

// 拿扇子那隻手的位置（世界座標；畫扇子、蓄力的旋風用）
function fanPoint(g, pose) {
  const f = g.facing || -1;
  const [hx, hy] = pose === 'windup' ? [-6, -62] : pose === 'swing' ? [22, -34] : pose === 'spread' ? [20, -44] : [12, -28];
  return { x: g.x + hx * f, y: g.y + hy * (g.h / 56) };
}

// ---------- 繪圖 ----------

// 天狗（面向右的身體座標：腳底中心是原點、身高 56）：背上一對黑色大翅膀（一直拍著）、白色山伏裝束（胸前四顆彩色梵天）、
// 白色寬褲、一齒高木屐（腳懸在空中）、紅臉長鼻子、白色長髮、額頭上黑色頭襟、手拿羽團扇。hurt = 剛被打到（畫成白色）
function drawTengu(ctx, c, e, hurt) {
  const f = e.facing || -1;
  const st = c.state;
  const sc = e.h / 56;
  const flap = Math.sin(st.flap * 7);
  const pose = fanPose(c);
  const col = (v) => (hurt ? '#ffffff' : v);
  ctx.save();
  ctx.translate(e.x, e.y + Math.sin(st.flap * 3.5) * 2);   // 飛著上下浮動
  ctx.scale(f * sc, sc);
  // 翅膀（後面那一隻大、前面那一隻小一點）
  drawWing(ctx, -4, -40, -2.35 + flap * 0.35, 1, col);
  drawWing(ctx, 2, -40, -0.95 - flap * 0.3, 0.8, col);
  // 腳：白色寬褲、懸著的一齒木屐
  ctx.fillStyle = col(HAKAMA);
  ctx.beginPath(); ctx.moveTo(-9, -22); ctx.lineTo(9, -22); ctx.lineTo(11, -8); ctx.lineTo(-11, -8); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = col(ROBE_EDGE); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(0, -8); ctx.stroke();
  for (const [lx, sw] of [[-5, 0.6], [5, -0.6]]) {
    const sx = lx + Math.sin(st.flap * 3 + sw) * 1.5;
    ctx.fillStyle = col('#e7c9a9');
    ctx.fillRect(sx - 2, -8, 4, 5);
    ctx.fillStyle = col(GETA);
    ctx.fillRect(sx - 5, -3, 10, 2.5);
    ctx.fillRect(sx - 1, -0.5, 2.5, 4);   // 一齒
  }
  // 身體：白色山伏裝束、胸前的梵天
  ctx.fillStyle = col(ROBE);
  ctx.beginPath(); ctx.moveTo(-10, -42); ctx.lineTo(10, -42); ctx.lineTo(12, -22); ctx.lineTo(-12, -22); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = col(ROBE_EDGE); ctx.lineWidth = 1.2; ctx.stroke();
  ctx.strokeStyle = col('#a16207'); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-9, -40); ctx.lineTo(8, -27); ctx.stroke();   // 結袈裟的帶子
  BONTEN.forEach((b, i) => {
    ctx.fillStyle = col(b);
    ctx.beginPath(); ctx.arc(-6 + i * 4.4, -37 + i * 3.3, 2.4, 0, Math.PI * 2); ctx.fill();
  });
  // 後手（另一邊張開 / 垂著）
  const spread = pose === 'spread';
  ctx.strokeStyle = col(ROBE); ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-6, -38); ctx.lineTo(spread ? -22 : -12, spread ? -46 : -26); ctx.stroke();
  // 頭：白色長髮（往後飄）、紅臉、長鼻子、白眉、頭襟
  ctx.fillStyle = col(HAIR);
  ctx.beginPath();
  ctx.moveTo(4, -56); ctx.quadraticCurveTo(-14, -58, -18, -38); ctx.quadraticCurveTo(-10, -42, -4, -40); ctx.quadraticCurveTo(-2, -48, 4, -56);
  ctx.fill();
  ctx.fillStyle = col(FACE);
  ctx.beginPath(); ctx.arc(3, -48, 8, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col(FACE_DARK);
  ctx.beginPath(); ctx.moveTo(9, -50); ctx.lineTo(25, -48.5); ctx.lineTo(9, -45); ctx.closePath(); ctx.fill();   // 長鼻子
  ctx.fillStyle = col(FACE);
  ctx.beginPath(); ctx.moveTo(9, -49.5); ctx.lineTo(24, -48.5); ctx.lineTo(9, -46.5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = col(HAIR);
  ctx.beginPath(); ctx.moveTo(1, -53); ctx.lineTo(10, -52); ctx.lineTo(9, -50.5); ctx.lineTo(2, -51); ctx.closePath(); ctx.fill();   // 白眉
  ctx.beginPath(); ctx.moveTo(-1, -43); ctx.quadraticCurveTo(6, -36, 10, -42); ctx.quadraticCurveTo(5, -40, -1, -43); ctx.fill();    // 白鬍子
  ctx.fillStyle = hurt ? '#fff' : '#fde047';
  ctx.beginPath(); ctx.arc(6.5, -49.5, 1.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(7, -49.5, 0.7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col('#111827');
  ctx.beginPath(); ctx.moveTo(-1, -57); ctx.lineTo(5, -60); ctx.lineTo(9, -57); ctx.lineTo(7, -54); ctx.lineTo(0, -54); ctx.closePath(); ctx.fill();   // 頭襟
  // 前手與羽團扇
  const [hx, hy] = pose === 'windup' ? [-6, -62] : pose === 'swing' ? [22, -34] : pose === 'spread' ? [20, -44] : [12, -28];
  ctx.strokeStyle = col(ROBE); ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(5, -38); ctx.lineTo(hx, hy); ctx.stroke();
  const fanAngle = pose === 'windup' ? -2.4 : pose === 'swing' ? 0.25 : pose === 'spread' ? -0.6 : -1.2;
  drawFan(ctx, hx, hy, fanAngle, col);
  ctx.restore();
}

// 一隻翅膀：從肩膀 (x, y) 往 rot 的方向張開，六根長羽毛排成扇形（越外面越長），k = 大小
function drawWing(ctx, x, y, rot, k, col) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  for (let i = 0; i < 6; i++) {
    const a = (i - 2.5) * 0.17;
    const len = (22 + i * 4) * k;
    ctx.save();
    ctx.rotate(a);
    ctx.fillStyle = col(i % 2 ? WING : WING_HI);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.5, -5 * k, len, 0);
    ctx.quadraticCurveTo(len * 0.5, 5 * k, 0, 0);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = col(WING);
  ctx.beginPath(); ctx.ellipse(8 * k, 0, 10 * k, 6 * k, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 羽團扇：手在 (x, y)、扇面往 angle 的方向（一片綠褐色的羽毛扇、中間一根扇骨、短短的握柄）
function drawFan(ctx, x, y, angle, col) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = col('#78350f'); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-3, 0); ctx.lineTo(6, 0); ctx.stroke();
  ctx.fillStyle = col(FAN);
  ctx.beginPath(); ctx.ellipse(15, 0, 10, 7.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = col(FAN_HI); ctx.lineWidth = 1;
  for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(24, i * 3); ctx.stroke(); }
  ctx.restore();
}

// 一根羽毛：根部在 (x, y)、往 angle 的方向、長 len、不透明度 a（黑色的羽片、淡灰的羽軸、尖端一點白）
function drawFeather(ctx, x, y, angle, len, a) {
  if (!(a > 0)) return;
  ctx.save();
  ctx.globalAlpha *= Math.min(1, a);
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = '#111827';
  ctx.strokeStyle = 'rgba(241,245,249,0.75)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-len * 0.5, 0);
  ctx.quadraticCurveTo(0, -len * 0.26, len * 0.5, 0);
  ctx.quadraticCurveTo(0, len * 0.26, -len * 0.5, 0);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = '#9ca3af'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(-len * 0.55, 0); ctx.lineTo(len * 0.5, 0); ctx.stroke();
  ctx.fillStyle = '#e5e7eb';
  ctx.beginPath(); ctx.arc(len * 0.45, 0, 1.4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 飛行中的羽毛後面一道淡淡的風痕
function drawFeatherTrail(ctx, f) {
  const sp = Math.hypot(f.vx, f.vy) || 1;
  const L = 34;
  ctx.save();
  const x0 = f.x - f.vx / sp * L, y0 = f.y - f.vy / sp * L;
  const grad = ctx.createLinearGradient(x0, y0, f.x, f.y);
  grad.addColorStop(0, 'rgba(229,231,235,0)');
  grad.addColorStop(1, 'rgba(229,231,235,0.55)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(f.x, f.y); ctx.stroke();
  ctx.restore();
}

// 風彈：一團綠白色的旋風（三道弧線一直轉）
function drawGust(ctx, p) {
  const t = p.age || 0;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.fillStyle = 'rgba(167,243,208,0.35)';
  ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(236,253,245,0.9)';
  ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(16,185,129,0.9)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const a = t * 12 + i * Math.PI * 2 / 3;
    ctx.beginPath(); ctx.arc(0, 0, 10, a, a + 1.6); ctx.stroke();
  }
  ctx.restore();
}

// 天上的雲：照現在的風往那邊飄（越強越快；無風就慢慢往右），看得出風往哪裡吹。位移照 update 累加的 c.state.cloud / streak
const CLOUDS = [[90, 72, 1], [420, 118, 0.8], [700, 60, 1.2], [960, 140, 0.7]];
function drawClouds(ctx, c) {
  const W = CONFIG.WORLD_W;
  const wind = c.match.wind || 0;
  ctx.save();
  for (const [x0, y, k] of CLOUDS) {
    const span = W + 240;
    const x = ((x0 + c.state.cloud * k) % span + span) % span - 120;
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    for (const [dx, dy, r] of [[0, 0, 26], [24, -8, 20], [-24, -4, 18], [44, 2, 16]]) {
      ctx.beginPath(); ctx.arc(x + dx * k, y + dy * k, r * k, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (Math.abs(wind) >= 4) {   // 風大：再加幾道風痕
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 6; i++) {
      const span = W + 200;
      const x = ((i * 190 + c.state.streak) % span + span) % span - 100;
      const y = 90 + i * 37;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.sign(wind) * 40, y); ctx.stroke();
    }
  }
  ctx.restore();
}
