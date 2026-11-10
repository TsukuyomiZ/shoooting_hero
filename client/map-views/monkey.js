import { CONFIG } from '../../shared/core/config.js';
import { MONKEY_ID, MONKEY_ACTION_NAMES, monkeyOf, catchRadius, isAngry, touchPeel, applyPeelPickup } from '../../shared/maps/monkey.js';

// 菁英關「頑皮猴王」的地圖畫面：猴王回合的動畫腳本（丟回去 / 椰子 = 舉手一拋；香蕉皮 = 一片香蕉皮拋到地上；盪樹枝 = 抓著藤蔓盪到另一棵樹）、
// 猴王（棕色的毛、米色的臉和肚子、捲捲的尾巴、頭上一頂小金冠，蹲在樹枝上）、手上接住的砲彈（一顆顆浮在他頭上）、
// 接住範圍（他身邊一圈虛線，生氣了變橘色、變大）、地上的香蕉皮、踩到滑倒。規則在 shared/maps/monkey.js；掛勾的說明見 index.js
const FPS = 60;
const FUR = '#7a4a24', FUR_DARK = '#5a3418', FACE = '#e8c39a', CROWN = '#fbbf24';
const PEEL = '#f5d33f', PEEL_DARK = '#c9a227';
const SWING_SAG = 70;      // 盪樹枝：路線比兩端低多少（往下盪再上去）
const nameOf = (w) => (CONFIG.WEAPONS[w] ? CONFIG.WEAPONS[w].name : w);

export const monkey = {
  type: 'monkey',

  // 這一場的畫面狀態：
  //   fx      猴王出招的預兆 { action, t, cast, step }（他的回合播完就清掉）
  //   swing   盪樹枝中 { from, to, t, cast }（猴王照進度沿著往下凹的弧線移動；null = 沒有）
  //   toss    香蕉皮飛在空中 { from, to, t, cast }（null = 沒有）
  //   throwW  正在丟回去的那顆原本是什麼武器（畫飛行物用）
  //   peelAt  上一幀場上香蕉皮的位置 { id: { x, y } }（被炸掉的那一刻狀態裡已經沒有了，噴碎屑要知道在哪）
  //   time    動畫時間（秒）
  //   falling 被打掉、正在往下掉的砲彈 [{ w, x, y, vx, vy, t, spin }]（掉到地上冒一陣煙就沒了，只給畫面用）
  create: () => ({ fx: null, swing: null, toss: null, throwW: null, peelAt: {}, time: 0, falling: [] }),

  turnScript: monkeyTurnScript,
  abortScript(c) {
    Object.assign(c.state, { fx: null, swing: null, toss: null, throwW: null });
  },
  onDeath: onMonkeyDeath,

  update(c, dt) {
    const st = c.state;
    st.time += dt;
    const S = c.match.mechState;
    st.peelAt = {};
    for (const q of (S && S.peels) || []) st.peelAt[q.id] = { x: q.x, y: q.y };
    for (const p of c.projectiles) {   // 丟回去的砲彈一路冒一點香蕉黃的碎屑（看得出是猴王丟的）
      if (!p.weapon || p.weapon.id !== 'monkeyThrow' || p.state === 'done') continue;
      c.fx.particles(p.x, p.y, 1, { speed: 40, life: 0.35, size: 2, color: PEEL, gravity: 0 });
    }
    if (st.toss) st.toss.t += dt;
    // 被打掉的砲彈往下掉：碰到地（或掉了 1.2 秒）就冒一陣煙沒了
    for (const f of st.falling) {
      f.t += dt;
      f.vy += 900 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      if (!f.gone && (f.t > 1.2 || (f.vy > 0 && c.match.terrain.isSolid(Math.round(f.x), Math.round(f.y + 4))))) {
        f.gone = true;
        c.fx.particles(f.x, f.y, 8, { speed: 50, life: 0.7, size: 3, color: '#9ca3af', gravity: -60 });
      }
    }
    st.falling = st.falling.filter(f => !f.gone);
  },

  // 接住了 / 炸掉了香蕉皮 / 手上的砲彈被打掉 / 他生氣了
  showEvent(c, ev) {
    const g = monkeyOf(c.match);
    if (ev.type === 'snatch' && ev.monkeyCatch) {
      c.fx.particles(ev.x, ev.y, 10, { speed: 120, life: 0.35, size: 2.4, color: '#fde68a', gravity: 0 });
      if (g) c.fx.float(g, '接住了！', '#fde68a');
      c.fx.sound('snatch', { x: ev.x });
    }
    for (const id of ev.peelGone || []) {
      const q = c.state.peelAt[id];
      if (q) c.fx.particles(q.x, q.y - 2, 10, { speed: 110, life: 0.5, size: 2.4, color: PEEL, gravity: 400 });
    }
    const M = ev.monkey;
    if (M && M.knocked && g) {   // 手上的砲彈從頭上那一排噴開、往下掉（掉到地上冒煙沒了，不爆炸）
      const n = M.knocked.length;
      M.knocked.forEach((w, k) => {
        const side = n > 1 ? (k - (n - 1) / 2) / ((n - 1) / 2) : (Math.random() < 0.5 ? -1 : 1);
        c.state.falling.push({ w, x: g.x + (k - (n - 1) / 2) * 18, y: g.y - g.h - 50, vx: side * (60 + Math.random() * 50), vy: -160 - Math.random() * 60, t: 0, spin: Math.random() * 6 });
      });
      c.fx.particles(g.cx, g.y - g.h - 40, 10, { speed: 120, life: 0.4, size: 2.4, color: '#fde68a', gravity: 300 });
      c.fx.sound('pop', { x: g.x });
      c.fx.float(g, '砲彈掉了！', '#fde68a');
    }
    // 打掉與生氣可能同一下：併成一張橫幅，不然後面那張會蓋掉前面的
    const said = [];
    if (M && M.knocked && g) said.push([`打掉了猴王手上的 ${M.knocked.length} 顆砲彈！`, '#fde68a']);
    if (M && M.angry) said.push(['頑皮猴王生氣了！接住的範圍變大', '#fca5a5']);
    if (said.length) c.fx.banner(said.map(l => l[0]).join('　·　'), said[0][1]);
    if (M && M.angry) {
      c.fx.sound('ook', { x: g ? g.x : 512 });
    }
  },

  // 自己的回合本地走了一幀：踩到香蕉皮就先滑出去（馬上回報位置，伺服器那段路就會經過香蕉皮）
  predictMove(c, me, px, py) {
    if (!touchPeel(c.match, me, px, py, me.x, me.y)) return false;
    slipFx(c, me);
    return true;
  },

  // 伺服器說他踩到香蕉皮：AI 代打走路的重播（msg.f）要照樣滑出去；自己的已經在本地滑過了就不再演；別人自己走的照他的位置回報
  onPickup(c, e, msg, self) {
    if (msg.type !== 'peel') return;
    const replay = msg.f !== undefined;
    if (applyPeelPickup(c.match, e, msg, replay || self)) slipFx(c, e);
  },

  // 角色之前：地上的香蕉皮、猴王身邊的接住範圍（虛線圈）
  drawScene(ctx, c) {
    const S = c.match.mechState;
    if (!S) return;
    for (const q of S.peels) drawPeel(ctx, q.x, q.y);
    const g = monkeyOf(c.match);
    if (g && g.alive && !c.state.swing) {
      const R = catchRadius(S, g);
      ctx.save();
      ctx.setLineDash([6, 8]);
      ctx.lineDashOffset = -c.state.time * 12;
      ctx.strokeStyle = isAngry(S, g) ? 'rgba(251,146,60,0.55)' : 'rgba(253,230,138,0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(g.cx, g.cy, R, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    for (const f of c.state.falling) drawShell(ctx, f.w, f.x, f.y, Math.atan2(f.vy, f.vx), f.spin + f.t * 10);   // 被打掉、往下掉的砲彈
    if (c.state.toss) {   // 飛在空中的香蕉皮
      const tz = c.state.toss;
      const k = Math.min(1, tz.t / tz.cast);
      const x = tz.from.x + (tz.to.x - tz.from.x) * k;
      const y = tz.from.y + (tz.to.y - tz.from.y) * k - Math.sin(Math.PI * k) * 80;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(k * 12);
      drawPeel(ctx, 0, 4);
      ctx.restore();
    }
  },

  drawEntity(ctx, c, e, hurt) {
    if (e.id !== MONKEY_ID) return false;
    drawMonkey(ctx, c, e, hurt);
    drawHeld(ctx, c, e);
    return 'body';
  },

  drawProjectile(ctx, c, p) {
    if (p.weapon.id === 'monkeyCoconut') {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.spin);
      drawCoconut(ctx, 0, 0, p.weapon.shellRadius);
      ctx.restore();
      return true;
    }
    if (p.weapon.id === 'monkeyThrow') {
      drawShell(ctx, c.state.throwW || 'cannon', p.x, p.y, Math.atan2(p.vy, p.vx), p.spin);
      return true;
    }
    return false;
  },

  // 一般那一行（敵人剩餘）+ 猴王的血量、手上接住了幾顆、會丟回給誰、生氣了沒
  hud(c, line) {
    const lines = [line];
    const e = monkeyOf(c.match);
    const S = c.match.mechState;
    if (!e || !e.alive || !S) return lines;
    lines.push([`頑皮猴王 ${e.hp} / ${e.maxHp}`, '#fcd34d']);
    if (S.held.length) {   // 右上的名單很窄：一行幾顆、一行要丟回給誰（同一個人的併成 ×N）
      lines.push([`猴王手上 ${S.held.length} / ${CONFIG.MONKEY.maxHeld} 顆砲彈`, '#fde68a']);
      const count = new Map();
      for (const h of S.held) count.set(h.by, (count.get(h.by) || 0) + 1);
      const who = [...count].map(([id, n]) => { const p = c.match.byId(id); return `${p ? p.name : '?'}${n > 1 ? ' ×' + n : ''}`; });
      lines.push([`會丟回給：${who.join('、')}`, '#fde68a']);
    }
    if (isAngry(S, e)) lines.push(['猴王生氣了：接住範圍變大', '#fca5a5']);
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 猴王的回合：丟回去（一顆一顆）→ 椰子 / 香蕉皮 → 盪樹枝，照順序播
function* monkeyTurnScript(c, msg) {
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* stepScript(c, msg.actorId, step);
  const S = c.match.mechState;
  if (S) S.held = [];   // 伺服器一開始就清空了（丟掉的、丟不出去的都不留）
  Object.assign(c.state, { fx: null, swing: null, toss: null, throwW: null });
}

function* stepScript(c, id, b) {
  const match = c.match;
  const g = match.byId(id);
  const S = match.mechState;
  const cast = Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS);
  const fx = c.state.fx = { action: b.action, t: 0, cast: cast / FPS, step: b };
  const N = MONKEY_ACTION_NAMES;
  const target = b.targetId ? match.byId(b.targetId) : null;
  if (g && (b.facing === 1 || b.facing === -1)) g.facing = b.facing;
  if (b.action === 'throw' || b.action === 'drop') {
    if (S) {   // 手上那一顆拿出來
      const k = S.held.findIndex(h => h.w === b.w && h.by === b.by);
      if (k >= 0) S.held.splice(k, 1);
    }
    if (b.action === 'throw') c.fx.banner(`頑皮猴王：${N.throw}！${nameOf(b.w)}${target ? ` → ${target.name}` : ''}`, '#fde68a');
    c.state.throwW = b.w;
  } else if (b.action === 'coconut') c.fx.banner(`頑皮猴王：${N.coconut}！${target ? ` → ${target.name}` : ''}`, '#d6a36a');
  else if (b.action === 'peel') c.fx.banner(`頑皮猴王：${N.peel}！${target ? ` → ${target.name} 腳邊` : ''}`, PEEL);
  else if (b.action === 'idle') c.fx.banner(`頑皮猴王${N.idle}中`, '#e7d3b5');
  if (b.action === 'throw' || b.action === 'coconut' || b.action === 'peel' || b.action === 'swing') c.fx.sound('ook', { x: g ? g.x : 512, vol: 0.8 });
  if (b.action === 'peel' && b.peel && b.from) c.state.toss = { from: b.from, to: { x: b.peel.x, y: b.peel.y }, t: 0, cast: cast / FPS };
  if (b.action === 'swing' && g && b.from && b.to) c.state.swing = { from: b.from, to: b.to, t: 0, cast: cast / FPS };

  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    const sw = c.state.swing;
    if (sw && g) {   // 抓著藤蔓沿著往下凹的弧線盪過去
      const k = (i + 1) / cast;
      sw.t = k * sw.cast;
      g.x = sw.from.x + (sw.to.x - sw.from.x) * k;
      g.y = sw.from.y + (sw.to.y - sw.from.y) * k + Math.sin(Math.PI * k) * SWING_SAG;
      if (i % 5 === 0) c.fx.particles(g.x, g.y - g.h / 2, 1, { speed: 40, life: 0.6, size: 3, color: '#4f8a34', gravity: 200 });
    }
    yield { frames: 1 };
  }
  fx.t = fx.cast;
  if (b.action === 'peel' && b.peel && S) {   // 香蕉皮落地
    if (!S.peels.some(q => q.id === b.peel.id)) S.peels.push({ id: b.peel.id, x: b.peel.x, y: b.peel.y });
    c.fx.particles(b.peel.x, b.peel.y - 2, 6, { speed: 60, life: 0.3, size: 2, color: PEEL, gravity: 300 });
  }
  c.state.toss = null;
  if (b.action === 'swing' && g && b.to) {
    g.x = b.to.x;
    g.y = b.to.y;
    if (S && Number.isInteger(b.perch)) S.perch = b.perch;
  }
  c.state.swing = null;
  if (b.shot) {
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
  c.state.throwW = null;
}

// 踩到香蕉皮：飄字、滑音、腳邊噴一點香蕉皮的碎屑
function slipFx(c, e) {
  c.fx.float(e, '滑倒了！', PEEL);
  c.fx.sound('slip', { x: e.x });
  c.fx.particles(e.x, e.y - 2, 8, { speed: 90, life: 0.4, size: 2.2, color: PEEL, gravity: 300 });
}

// 猴王倒下：回傳 true 表示處理過了
function onMonkeyDeath(c, e) {
  if (e.id !== MONKEY_ID) return false;
  c.fx.banner('頑皮猴王倒下了！', '#fcd34d');
  c.fx.shake(8);
  c.fx.particles(e.x, e.y - e.h / 2, 30, { speed: 180, life: 1.2, size: 3, color: FUR, gravity: 200 });
  c.fx.particles(e.x, e.y - e.h / 2, 10, { speed: 140, life: 1, size: 3, color: PEEL, gravity: 200 });
  return true;
}

// ---------- 繪圖 ----------

// 猴王本人（面向右的身體座標：腳底中心是原點、身高 40）：蹲著、長尾巴捲在後面、小金冠。hurt = 剛被打到（白色）。
// 盪樹枝中：一隻手往上抓著藤蔓（從弧線上方的掛點拉下來）
function drawMonkey(ctx, c, e, hurt) {
  const f = e.facing || -1;
  const sc = e.h / 40;
  const t = c.state.time;
  const col = (v) => (hurt ? '#ffffff' : v);
  const sw = c.state.swing;
  if (sw) {   // 藤蔓：從兩棵樹中間上方的掛點拉到他的手
    const ax = (sw.from.x + sw.to.x) / 2, ay = Math.min(sw.from.y, sw.to.y) - 90;
    ctx.strokeStyle = '#3b6e2a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(e.x, e.y - e.h); ctx.stroke();
  }
  const breathe = Math.sin(t * 3) * 0.8;
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.scale(f * sc, sc);
  // 尾巴：從屁股往後繞一個捲
  ctx.strokeStyle = col(FUR_DARK); ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-8, -8);
  ctx.bezierCurveTo(-22, -6, -24, -26, -16, -30 + Math.sin(t * 2) * 2);
  ctx.bezierCurveTo(-10, -33, -9, -25, -14, -25);
  ctx.stroke();
  // 腳（蹲著）
  ctx.fillStyle = col(FUR_DARK);
  for (const dx of [-6, 5]) { ctx.beginPath(); ctx.ellipse(dx, -3, 5, 3.2, 0, 0, Math.PI * 2); ctx.fill(); }
  // 身體、肚子
  ctx.fillStyle = col(FUR);
  ctx.beginPath(); ctx.ellipse(0, -14 + breathe * 0.3, 10, 12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col(FACE);
  ctx.beginPath(); ctx.ellipse(2, -13 + breathe * 0.3, 5.5, 8, 0, 0, Math.PI * 2); ctx.fill();
  // 手臂：盪樹枝時一隻往上抓；平常一隻往前伸（接東西的樣子）
  ctx.strokeStyle = col(FUR); ctx.lineWidth = 3.4;
  ctx.beginPath(); ctx.moveTo(-5, -20); ctx.lineTo(-9, -10); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(5, -21);
  if (sw) ctx.lineTo(1, -40); else ctx.lineTo(13, -24 + Math.sin(t * 4) * 1.5);
  ctx.stroke();
  // 頭、耳朵、臉
  const hy = -30 + breathe * 0.4;
  ctx.fillStyle = col(FUR);
  for (const dx of [-8, 8]) { ctx.beginPath(); ctx.arc(dx, hy, 3.6, 0, Math.PI * 2); ctx.fill(); }
  ctx.beginPath(); ctx.arc(0, hy, 8.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col(FACE);
  ctx.beginPath(); ctx.ellipse(2, hy + 1.5, 6, 5.2, 0, 0, Math.PI * 2); ctx.fill();
  for (const dx of [-8, 8]) { ctx.beginPath(); ctx.arc(dx, hy, 1.8, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#1f1308';
  for (const dx of [0, 4.5]) { ctx.beginPath(); ctx.arc(dx, hy - 0.5, 1.1, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = '#1f1308'; ctx.lineWidth = 0.9;
  ctx.beginPath(); ctx.arc(2.5, hy + 3, 2.2, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  // 小金冠
  ctx.fillStyle = col(CROWN);
  ctx.beginPath();
  ctx.moveTo(-5, hy - 7); ctx.lineTo(-5, hy - 12); ctx.lineTo(-2.5, hy - 9.5); ctx.lineTo(0, hy - 13.5);
  ctx.lineTo(2.5, hy - 9.5); ctx.lineTo(5, hy - 12); ctx.lineTo(5, hy - 7); ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#ef4444';
  ctx.beginPath(); ctx.arc(0, hy - 8.5, 1.1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 手上接住的砲彈：一顆顆浮在他頭上（名字、血條的上面），排成一排慢慢晃（丟回去之前大家都看得到他拿了什麼）
function drawHeld(ctx, c, e) {
  const S = c.match.mechState;
  if (!S || !S.held.length || c.state.swing) return;
  const n = S.held.length;
  S.held.forEach((h, k) => {
    const x = e.x + (k - (n - 1) / 2) * 18;
    const y = e.y - e.h - 50 + Math.sin(c.state.time * 3 + k) * 2;   // 名字、血條的上面
    drawShell(ctx, h.w, x, y, -Math.PI / 2, c.state.time * 2 + k);
  });
}

// 一顆砲彈（照原本的武器 id 畫：大砲黑球、等離子青色光球、飛鏢、轟炸飛彈、迴力鏢），a = 朝向、spin = 旋轉（迴力鏢）
function drawShell(ctx, id, x, y, a, spin = 0) {
  const w = CONFIG.WEAPONS[id] || CONFIG.WEAPONS.cannon;
  ctx.save();
  ctx.translate(x, y);
  if (w.id === 'plasma') {
    ctx.fillStyle = 'rgba(34,211,238,0.35)';
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a5f3fc';
    ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
  } else if (w.id === 'darts') {
    ctx.rotate(a);
    ctx.strokeStyle = '#d6d3d1'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(3, 0); ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath(); ctx.moveTo(3, -2.2); ctx.lineTo(8, 0); ctx.lineTo(3, 2.2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#4ade80';
    ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-13, -4); ctx.lineTo(-11, 0); ctx.lineTo(-13, 4); ctx.closePath(); ctx.fill();
  } else if (w.id === 'bombard') {
    ctx.rotate(a);
    ctx.fillStyle = '#e11d48';
    ctx.beginPath(); ctx.moveTo(-9, -3.5); ctx.lineTo(5, -3.5); ctx.lineTo(10, 0); ctx.lineTo(5, 3.5); ctx.lineTo(-9, 3.5); ctx.closePath(); ctx.fill();
  } else if (w.id === 'boomerang') {
    ctx.rotate(spin);
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(-9, -5); ctx.lineTo(0, 3); ctx.lineTo(9, -5); ctx.stroke();
  } else {
    ctx.fillStyle = '#2b2b2b';
    ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath(); ctx.arc(-2, -2, 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// 椰子（飛行中）：棕色的球、三個深色的小洞、幾根纖維
function drawCoconut(ctx, x, y, r) {
  const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.2, x, y, r);
  g.addColorStop(0, '#a87442'); g.addColorStop(1, '#4e321a');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#2a1a0c';
  for (const [dx, dy] of [[-2.4, -1.5], [2.4, -1.5], [0, 2]]) { ctx.beginPath(); ctx.arc(x + dx, y + dy, 1.2, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = 'rgba(200,160,100,0.6)'; ctx.lineWidth = 0.8;
  for (const a of [0.4, 1.9, 3.5, 5]) { ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.lineTo(x + Math.cos(a) * (r + 3), y + Math.sin(a) * (r + 3)); ctx.stroke(); }
}

// 香蕉皮（腳底踩的那一點 x, y 在地面上）：中間一團、四片皮往外攤開
function drawPeel(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1.3, 1.3);
  for (const [a, len] of [[-2.6, 11], [-1.9, 9], [-1.2, 9], [-0.5, 11]]) {
    ctx.save();
    ctx.rotate(a + Math.PI / 2);
    ctx.fillStyle = PEEL;
    ctx.beginPath(); ctx.ellipse(0, -len / 2, 2.6, len / 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = PEEL_DARK; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = '#f8e7a0';
  ctx.beginPath(); ctx.ellipse(0, -3, 4.5, 3.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#6b4f1d';
  ctx.fillRect(-1, -8, 2, 3);
  ctx.restore();
}
