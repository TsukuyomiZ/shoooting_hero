import { CONFIG } from '../../shared/core/config.js';
import { text } from '../draw.js';
import {
  RANGER_ID, RANGER_ACTION_NAMES, isTrap, liveTraps, bowPoint, arrowLine, spawnTrap, syncTraps, touchTrap, applyTrapPickup, applyStruggle, alignTrapped,
} from '../../shared/maps/ranger.js';

// 菁英關「大樹遊俠」的地圖畫面：遊俠回合的動畫腳本（照伺服器廣播的招式播：林間穿梭 = 沿弧線跳到另一根樹枝；貫穿箭 = 拉弓瞄準、放箭；
// 箭雨 = 朝天拉弓連射，箭從天上落下；藤蔓陷阱 = 往地上撒種子，陷阱冒出來）、遊俠（綠色兜帽斗篷、褐色馬尾、背著箭袋、拿長弓）、
// 地上的藤蔓陷阱（還剩幾下用小點標出來）、被困住的人腳上纏著的藤蔓、貫穿箭標記的人（準星與預警線；菁英之路不畫）、箭的畫法、
// 踩到陷阱 / 連打掙脫的特效（自己被困住時畫面中間提示「連點 A/D 可逃脫！」）、倒下的特效。
// 貫穿箭（2026-11-03 使用者：要有拉弓的動作、箭看起來有力量）：舉弓 → 慢慢拉滿（身體往後仰、箭頭聚光、光點往箭頭收）→ 拉滿抖一下 → 放箭（弓弦一彈、閃光、震一下）；
// 飛出去的箭頭發光、拖一道亮的光痕、一路噴光屑，射穿人的時候炸開一圈光。規則在 shared/maps/ranger.js；掛勾的說明見 index.js
const FPS = 60;
const CLOAK = '#3f6212', CLOAK_DARK = '#284010', CLOAK_HI = '#65a30d', SKIN = '#f1c9a5', HAIR = '#7c4a1e';
const LEATHER = '#78350f', LEATHER_DARK = '#4a2108', BOW = '#a16207', STRING = '#fef3c7';
const VINE = '#3f7d1f', VINE_DARK = '#25521a', LEAF = '#65a30d', THORN = '#d9f99d';
const RELEASE_AT = 0.8;    // 貫穿箭 / 箭雨：預兆播到這裡放箭（之前拉弓蓄力）
const HOLD = 0.78;         // 貫穿箭：拉到這裡就拉滿了，之後抖著蓄力到放箭
const MAX_PULL = 16;       // 貫穿箭拉滿的時候弦往後拉多少（身體座標）
const STANCE_PULL = 12;    // 預定貫穿箭的架勢：弦先拉到這裡（她的回合再從這裡拉滿）
const RAIN_PULL = 10;      // 箭雨（架勢與出招）：弦拉多少
const GLOW = '#ecfccb', GLOW_RGB = '217,249,157';
const SOW_AT = 0.55;       // 藤蔓陷阱：預兆播到這裡陷阱冒出來

export const ranger = {
  type: 'ranger',

  // 這一場的畫面狀態：
  //   fx       遊俠出招的預兆 { action, t, cast, step, aim }（aim = 拉弓的方向（弧度）；遊俠回合播完就清掉）
  //   lastDir  自己被困住時上一下按的是哪一邊（-1 / 1；0 = 這回合還沒按：左右交替才算一下）
  //   sway     樹葉、藤蔓搖動的時間（秒）
  //   glints  放箭 / 射穿人的閃光 [{ x, y, t, r }]（t = 經過幾秒，r = 多大；update 推進、drawScene 畫）
  create: () => ({ fx: null, lastDir: 0, sway: 0, glints: [] }),

  turnScript: rangerTurnScript,
  abortScript(c) {
    c.state.fx = null;
  },
  onDeath: onRangerDeath,

  // 被困住的人跟場面對齊（倒下就放開；走不動、體力流失）；閃光淡掉；飛行中的貫穿箭一路噴光屑
  update(c, dt) {
    const st = c.state;
    st.sway += dt;
    for (const fl of st.glints) fl.t += dt;
    st.glints = st.glints.filter(fl => fl.t < 0.35);
    for (const p of c.projectiles) {
      if (!p.weapon || p.weapon.id !== 'rangerArrow' || p.state === 'done') continue;
      c.fx.particles(p.x, p.y, 3, { speed: 60, life: 0.45, size: 2.8, color: GLOW, gravity: 0 });
      c.fx.particles(p.x, p.y, 1, { speed: 120, life: 0.3, size: 2, color: '#ffffff', gravity: 0 });
    }
    syncTraps(c.match);
  },

  // 自己的回合本地走了一幀：踩進陷阱就先困住（馬上回報位置，伺服器那段路的終點就是陷阱）
  predictMove(c, me, px, py) {
    const fx = touchTrap(c.match, me, px, py, me.x, me.y);
    if (!fx) return false;
    c.state.lastDir = 0;
    caughtFx(c, me);
    return true;
  },

  // 伺服器說他踩到陷阱（自己的已經先困住了就不再演）
  onPickup(c, e, msg, self) {
    if (msg.type !== 'vine') return;
    const S = c.match.mechState;
    const already = !!(S && S.trapped[e.id]);
    applyTrapPickup(c.match, msg);
    if (!already) {
      if (self) c.state.lastDir = 0;
      caughtFx(c, e);
    }
  },

  // 自己被困住時按了一下 A / D：左右交替才算（同一邊連按、體力流光了都不算）
  struggle(c, me, dir) {
    const S = c.match.mechState;
    if (!S || !S.trapped[me.id] || me.stamina <= 0 || dir === c.state.lastDir) return false;
    c.state.lastDir = dir;
    c.fx.particles(me.x + dir * 8, me.y - 4, 3, { speed: 70, life: 0.3, size: 2, color: LEAF, gravity: 300 });
    return true;
  },

  // 伺服器的 struggle：連打數照伺服器的；掙脫了就放開、飄字
  onStruggle(c, e, msg) {
    applyStruggle(c.match, msg);
    if (msg.freed) {
      c.fx.float(e, '掙脫了！', '#bef264');
      c.fx.particles(e.x, e.y - 6, 16, { speed: 170, life: 0.6, size: 2.5, color: LEAF, gravity: 320 });
      c.fx.sound('snare', { x: e.x, vol: 0.6 });
    } else {
      c.fx.particles(e.x, e.y - 4, 2, { speed: 60, life: 0.25, size: 2, color: VINE, gravity: 300 });
    }
  },

  // 回合裡的事：msg.start = 玩家的回合開始（被困住的名單照伺服器的對齊、輪到的人連打數重算）；
  // 伺服器的 hazard = 剛踩到陷阱的人扣血（照順序套用時畫面一震）、被困住的人體力流光了（spent：體力條歸零）
  hazard(c, msg, early = false) {
    const S = c.match.mechState;
    if (!S) return;
    if (msg.start) {
      if (msg.start.kind !== 'ranger') return;
      c.state.lastDir = 0;
      alignTrapped(c.match, msg.start.held);
      const rec = msg.start.trapped && S.trapped[msg.start.trapped];
      if (rec) Object.assign(rec, { count: 0, last: 0 });
      return;
    }
    if (msg.kind !== 'ranger' || early) return;
    for (const id of msg.spent || []) {
      const e = c.match.byId(id);
      if (e) e.stamina = 0;
    }
    if (msg.damages && msg.damages.some(d => d.dmg > 0)) c.fx.shake(3);
  },

  // 貫穿箭射穿人 / 箭雨打中：綠色的碎葉；箭雨落地：一點塵土
  showEvent(c, ev) {
    const p = c.projectiles.find(q => q.i === ev.p);
    const id = p && p.weapon && p.weapon.id;
    if (id === 'rangerArrow' && ev.target) {   // 射穿人：一圈光 + 綠白色的光屑往外炸開
      c.fx.particles(ev.x, ev.y, 14, { speed: 260, life: 0.45, size: 2.6, color: GLOW, gravity: 0 });
      c.fx.particles(ev.x, ev.y, 8, { speed: 160, life: 0.5, size: 2.5, color: '#84cc16', gravity: 220 });
      c.state.glints.push({ x: ev.x, y: ev.y, t: 0, r: 30 });
      c.fx.shake(5);
    }
    if (id === 'rangerRain') {
      if (ev.target) c.fx.particles(ev.x, ev.y, 6, { speed: 140, life: 0.4, size: 2, color: '#ef4444', gravity: 300 });
      else if (ev.type === 'explode' || ev.type === 'terrain') c.fx.particles(ev.x, ev.y, 3, { speed: 60, life: 0.3, size: 2, color: '#a8a29e', gravity: 250 });
    }
  },

  drawEntityFirst: (c, e) => isTrap(e),
  drawEntity(ctx, c, e, hurt) {
    if (isTrap(e)) { drawTrap(ctx, c, e, hurt); return 'whole'; }
    if (e.part !== 'ranger') return false;
    drawRanger(ctx, c, e, hurt);
    return 'body';
  },
  hpBar: (c, e) => (e.part === 'ranger' ? { w: 90, h: 8 } : null),

  drawProjectile(ctx, c, p) {
    const id = p.weapon.id;
    if (id === 'rangerArrow') { drawPowerArrow(ctx, c, p); return true; }
    if (id === 'rangerRain') { drawArrow(ctx, p.x, p.y, Math.atan2(p.vy, p.vx), 20, false); return true; }
    return false;
  },

  // 角色之前：被困住的人腳上的藤蔓、貫穿箭標記的人（準星與從弓延伸出去的預警線；菁英之路不畫，出招時照樣畫）
  drawScene(ctx, c) {
    const S = c.match.mechState;
    if (!S) return;
    for (const pid of Object.keys(S.trapped)) {
      const p = c.match.byId(pid);
      if (p && p.alive) drawBinding(ctx, c, p);
    }
    drawPierceMark(ctx, c);
    drawFlashes(ctx, c);
    drawEscapeHint(ctx, c);
  },

  // 一般那一行（敵人剩餘）+ 遊俠的血量、預定的下一招（貫穿箭帶標記的人）、場上的陷阱、現在輪到的人被困住的話他要連打幾下
  hud(c, line) {
    const lines = [line];
    const e = c.match.byId(RANGER_ID);
    const S = c.match.mechState;
    if (e && e.alive && S) {
      lines.push([`大樹遊俠 ${e.hp} / ${e.maxHp}`, '#bef264']);
      if (S.next) {
        const marked = S.next.action === 'pierce' && S.next.targetId ? c.match.byId(S.next.targetId) : null;
        lines.push([`下一招：${RANGER_ACTION_NAMES[S.next.action] || S.next.action}${marked && marked.alive ? ` → ${marked.name}` : ''}`, '#bef264']);
      }
      const n = liveTraps(c.match).length;
      if (n) lines.push([`藤蔓陷阱 ${n} / ${CONFIG.RANGER.trap.max}`, '#a3e635']);
    }
    const cur = S && c.currentId ? c.match.byId(c.currentId) : null;
    const rec = cur && S.trapped[cur.id];
    if (rec) lines.push([`${cur.name} 連打 A/D 掙脫 ${rec.count}/${CONFIG.RANGER.trap.need}`, '#fde68a']);
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 遊俠的回合：預定的那一招 → 換樹枝，一招一招照順序播；全部播完才換上伺服器預定的下一招（msg.boss.next）
function* rangerTurnScript(c, msg) {
  const S = c.match.mechState;
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* stepScript(c, msg.actorId, step);
  c.state.fx = null;
  if (S && msg.boss.next !== undefined) S.next = msg.boss.next ? { ...msg.boss.next } : null;
}

function* stepScript(c, id, b) {
  const match = c.match;
  const g = match.byId(id);
  const S = match.mechState;
  const cast = Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS);
  const fx = c.state.fx = { action: b.action, t: 0, cast: cast / FPS, step: b, aim: g ? (g.facing < 0 ? Math.PI : 0) : 0 };
  const N = RANGER_ACTION_NAMES;
  const target = b.targetId ? match.byId(b.targetId) : null;
  if (g && (b.facing === 1 || b.facing === -1)) g.facing = b.facing;
  if (b.action === 'pierce') c.fx.banner(`大樹遊俠：${N.pierce}！${target ? ` → ${target.name}` : ''}`, '#bef264');
  else if (b.action === 'rain') c.fx.banner(`大樹遊俠：${N.rain}！`, '#d9f99d');
  else if (b.action === 'trap') c.fx.banner(`大樹遊俠：${N.trap}！`, '#a3e635');
  else if (b.action === 'idle') c.fx.banner(`大樹遊俠${N.idle}中`, '#e9d5ff');

  const from = b.action === 'hop' && g ? { x: Number.isFinite(b.x0) ? b.x0 : g.x, y: Number.isFinite(b.y0) ? b.y0 : g.y } : null;
  const lift = from ? Math.max(50, Math.min(150, Math.abs(b.x - from.x) * 0.35 + Math.max(0, from.y - b.y))) : 0;
  let sown = false;
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    const k = i / cast;
    if (g && from) {   // 林間穿梭：沿弧線跳過去（頭尾慢、中間快）
      const s = k * k * (3 - 2 * k);
      g.x = from.x + (b.x - from.x) * s;
      g.y = from.y + (b.y - from.y) * s - lift * 4 * s * (1 - s);
      if (i % 6 === 0) c.fx.particles(g.x, g.y - g.h * 0.5, 2, { speed: 40, life: 0.5, size: 2.2, color: LEAF, gravity: 120 });
      if (i === 0) c.fx.sound('snare', { x: g.x, vol: 0.3 });
    }
    if (g && b.action === 'pierce') {
      const bow = bowPoint(g);
      const aimAt = target && target.alive ? { x: target.cx, y: target.cy } : null;
      if (aimAt) fx.aim = Math.atan2(aimAt.y - bow.y, aimAt.x - bow.x);
      const tip = { x: bow.x + Math.cos(fx.aim) * 20, y: bow.y + Math.sin(fx.aim) * 20 };
      const draw = k / RELEASE_AT;   // 0 ~ 1：放箭之前拉到哪
      if (draw < 1 && i % 3 === 0) {   // 蓄力：光點從四周往箭頭收過去（越拉越多）
        const n = draw > HOLD ? 2 : 1;
        for (let q = 0; q < n; q++) {
          const ang = i * 2.399 + q * 1.7;   // 每一顆換個方向（黃金角）
          const r = 34 + (i % 5) * 4;
          const life = 0.3;
          c.fx.particle({ x: tip.x + Math.cos(ang) * r, y: tip.y + Math.sin(ang) * r, vx: -Math.cos(ang) * r / life, vy: -Math.sin(ang) * r / life, life, maxLife: life, size: 2, color: GLOW, gravity: 0 });
        }
      }
      if (i === Math.round(cast * RELEASE_AT)) {   // 放箭：弓弦一彈、閃光、震一下
        c.fx.sound('bow', { x: g.x, vol: 1 });
        c.fx.shake(4);
        c.state.glints.push({ x: tip.x, y: tip.y, t: 0, r: 24 });
        c.fx.particles(tip.x, tip.y, 12, { speed: 220, life: 0.3, size: 2.4, color: GLOW, gravity: 0 });
      }
    }
    if (g && b.action === 'rain') {
      fx.aim = -Math.PI / 2 + g.facing * 0.25;
      if (k >= RELEASE_AT && i % 4 === 0) {   // 朝天連射：箭往上飛出畫面
        const bow = bowPoint(g);
        c.fx.particle({ x: bow.x, y: bow.y, vx: g.facing * 60, vy: -900, life: 0.5, maxLife: 0.5, size: 2, color: '#d9f99d', gravity: 0 });
      }
      if (i === Math.round(cast * RELEASE_AT)) c.fx.sound('bow', { x: g.x });
    }
    if (b.action === 'trap' && !sown && k >= SOW_AT) {   // 陷阱冒出來
      sown = true;
      for (const spec of b.spawns || []) {
        if (!match.byId(spec.id)) spawnTrap(match, spec);
        c.fx.particles(spec.x, spec.y - 4, 10, { speed: 120, life: 0.5, size: 2.4, color: LEAF, gravity: 260 });
      }
      if ((b.spawns || []).length) c.fx.sound('snare', { x: (b.spawns[0] || {}).x, vol: 0.5 });
    }
    yield { frames: 1 };
  }
  fx.t = fx.cast;
  if (b.action === 'trap' && !sown) for (const spec of b.spawns || []) if (!match.byId(spec.id)) spawnTrap(match, spec);
  if (b.shot) {
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
  if (S && b.action === 'hop' && Number.isInteger(b.to)) S.perch = b.to;
  syncTraps(match);
}

// 遊俠倒下 / 陷阱破掉：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）。陷阱被踩到（trigger）的特效在困住的時候演過了
function onRangerDeath(c, e) {
  if (isTrap(e)) {
    if (e.deathCause !== 'trigger') {
      c.fx.particles(e.x, e.y - 4, 14, { speed: 150, life: 0.6, size: 2.5, color: VINE, gravity: 280 });
      c.fx.sound('snare', { x: e.x, vol: 0.4 });
    }
    return true;
  }
  if (e.part !== 'ranger') return false;
  c.fx.banner('大樹遊俠倒下了！', '#c084fc');
  c.fx.shake(8);
  c.fx.particles(e.x, e.cy, 28, { speed: 170, life: 1.3, size: 3, color: CLOAK_HI, gravity: 140 });
  c.fx.particles(e.x, e.cy - 10, 10, { speed: 120, life: 0.9, size: 2.5, color: '#fef3c7', gravity: 80 });
  return true;
}

// 踩到陷阱：藤蔓一下子纏上來；是自己的話畫面中間跳出橫幅，底下一直提示「連點 A/D 可逃脫！」（自己的回合裡，見 drawEscapeHint）
function caughtFx(c, e) {
  if (e.id === c.myId) c.fx.banner('被藤蔓困住了！', '#bef264');
  c.fx.float(e, '被藤蔓困住！', '#a3e635');
  c.fx.particles(e.x, e.y - 6, 14, { speed: 140, life: 0.5, size: 2.4, color: LEAF, gravity: 300 });
  c.fx.sound('snare', { x: e.x, vol: 0.7 });
}

// ---------- 繪圖 ----------

// 遊俠（面向右的身體座標：腳底中心是原點、身高 60）：綠色兜帽斗篷（下擺隨風擺）、褐色馬尾、背上的箭袋、皮革長靴、長弓。
// 預兆中照 fx.aim 拉弓（貫穿箭朝目標、箭雨朝天）；玩家回合裡照預定的下一招擺架勢（stanceOf：貫穿箭後腳往後踏、拉弓瞄準被標記的人，
// 箭雨弓朝上拉滿）；其他時候弓垂在身側。hurt = 剛被打到（畫成白色）
function drawRanger(ctx, c, e, hurt) {
  const f = e.facing || -1;
  const sc = e.h / 60;
  const fx = c.state.fx;
  const col = (v) => (hurt ? '#ffffff' : v);
  const sway = Math.sin(c.state.sway * 2.4) * 2;
  const stance = fx ? null : stanceOf(c, e);
  const act = fx ? fx.action : stance ? stance.action : null;
  const aiming = act === 'pierce' || act === 'rain';
  const drawing = aiming && (fx ? fx.t < fx.cast * RELEASE_AT : true);   // 弦上還搭著箭
  const pose = fx ? bowPose(fx) : stancePose(stance, c.state.sway);
  const aim = fx ? fx.aim : stance ? stance.aim : 0;
  ctx.save();
  ctx.translate(e.x + (pose.shake ? Math.sin(c.state.sway * 90) * pose.shake : 0), e.y);
  ctx.scale(f * sc, sc);
  ctx.rotate(-pose.lean);   // 拉弓時身體往後仰（腳底為軸）
  // 箭袋（背後）
  ctx.fillStyle = col(LEATHER);
  ctx.save(); ctx.translate(-8, -40); ctx.rotate(-0.35); ctx.fillRect(-4, -14, 8, 22); ctx.restore();
  ctx.strokeStyle = col('#fef3c7'); ctx.lineWidth = 1.5;
  for (const dx of [-2, 1, 4]) { ctx.beginPath(); ctx.moveTo(-12 + dx, -56); ctx.lineTo(-9 + dx, -50); ctx.stroke(); }
  // 斗篷下擺（後面）
  ctx.fillStyle = col(CLOAK_DARK);
  ctx.beginPath(); ctx.moveTo(-8, -44); ctx.quadraticCurveTo(-18 + sway, -20, -14 + sway, -12); ctx.lineTo(4, -16); ctx.closePath(); ctx.fill();
  // 腳：皮革長靴（[腰的 x, 腳底的 x]：貫穿箭後腳往後踏一大步、箭雨兩腳張開站穩）
  const legs = pose.stride === 'back' ? [[-3, -12], [3, 7]] : pose.stride === 'wide' ? [[-3, -7], [3, 7]] : [[-4, -4], [4, 4]];
  for (const [hip, foot] of legs) {
    ctx.strokeStyle = col('#57534e'); ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(hip, -20); ctx.lineTo(foot, -9); ctx.stroke();
    ctx.fillStyle = col(LEATHER_DARK); ctx.fillRect(foot - 3.5, -11, 7, 11);
  }
  // 身體：綠色上衣、腰帶
  ctx.fillStyle = col(CLOAK);
  ctx.beginPath(); ctx.moveTo(-8, -44); ctx.lineTo(8, -44); ctx.lineTo(10, -20); ctx.lineTo(-10, -20); ctx.closePath(); ctx.fill();
  ctx.fillStyle = col(LEATHER); ctx.fillRect(-10, -27, 20, 3.5);
  ctx.strokeStyle = col(LEATHER_DARK); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-7, -44); ctx.lineTo(7, -28); ctx.stroke();   // 箭袋的背帶
  // 頭：臉、褐色馬尾、綠色兜帽
  ctx.fillStyle = col(HAIR);
  ctx.beginPath(); ctx.moveTo(-6, -52); ctx.quadraticCurveTo(-16, -50 + sway * 0.5, -14, -38); ctx.quadraticCurveTo(-9, -44, -5, -47); ctx.closePath(); ctx.fill();
  ctx.fillStyle = col(SKIN);
  ctx.beginPath(); ctx.arc(2, -51, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col(CLOAK_HI);
  ctx.beginPath(); ctx.moveTo(-8, -50); ctx.quadraticCurveTo(-6, -62, 4, -61); ctx.quadraticCurveTo(10, -60, 9, -53); ctx.lineTo(4, -55); ctx.quadraticCurveTo(-2, -56, -8, -50); ctx.fill();
  ctx.fillStyle = hurt ? '#fff' : '#1f2937';
  ctx.beginPath(); ctx.arc(5.5, -51.5, 1.1, 0, Math.PI * 2); ctx.fill();
  // 弓：預兆中朝 fx.aim 拉滿（身體座標裡 x 往右是面向的那邊，所以角度照面向翻過來），其他時候垂在身側
  const shoulder = { x: 4, y: -40 };
  let a = 1.15;   // 垂著：往前下方
  if (aiming) {
    const wx = Math.cos(aim) * f, wy = Math.sin(aim);
    a = Math.atan2(wy, wx);
  }
  if (pose.recoil) a -= pose.recoil;   // 放箭：拿弓的手往上一彈
  const reach = 15 + pose.extend;     // 拉弓時手臂伸直
  const hx = shoulder.x + Math.cos(a) * reach, hy = shoulder.y + Math.sin(a) * reach;
  ctx.strokeStyle = col(CLOAK); ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(hx, hy); ctx.stroke();   // 拿弓的手
  const pull = drawing ? pose.pull : 0;
  drawBow(ctx, hx, hy, a, pull, col, pose.twang);
  if (drawing) {   // 拉弦的手（拉滿時拉到臉頰旁）與搭在弦上的箭；貫穿箭的箭頭聚光（越拉越亮）
    const sx = hx - Math.cos(a) * (pull + 3), sy = hy - Math.sin(a) * (pull + 3);
    ctx.strokeStyle = col(CLOAK); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(shoulder.x - 2, shoulder.y + 2); ctx.lineTo(sx, sy); ctx.stroke();
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(a);
    const L = 26 + pull * 0.4;
    ctx.strokeStyle = col('#a16207'); ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L, 0); ctx.stroke();
    if (pose.glow > 0 && !hurt) drawGlow(ctx, L + 3, 0, 6 + pose.glow * 10, pose.glow);
    ctx.fillStyle = col(pose.glow > 0.5 ? '#ffffff' : '#e5e7eb');
    ctx.beginPath(); ctx.moveTo(L, -2.8); ctx.lineTo(L + 6, 0); ctx.lineTo(L, 2.8); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

// 玩家回合裡的架勢（2026-11-03 使用者：一決定招式就要有相應的動作）：預定貫穿箭 / 箭雨、她不在出招時。
// 回傳 { action, aim（拉弓的方向，弧度）} 或 null。貫穿箭瞄著被標記的人現在的位置（他走到她背後就平舉朝前）；箭雨朝天（往前斜一點，同出招）
function stanceOf(c, e) {
  const S = c.match.mechState;
  if (!S || !S.next || !e.alive) return null;
  const f = e.facing || -1;
  if (S.next.action === 'rain') return { action: 'rain', aim: -Math.PI / 2 + f * 0.25 };
  if (S.next.action !== 'pierce') return null;
  const t = S.next.targetId ? c.match.byId(S.next.targetId) : null;
  const bow = bowPoint(e);
  const ahead = t && t.alive && (t.cx - e.x) * f > 0;
  return { action: 'pierce', aim: ahead ? Math.atan2(t.cy - bow.y, t.cx - bow.x) : (f > 0 ? 0 : Math.PI) };
}

// 架勢的拉弓姿勢（格式同 bowPose）：貫穿箭後腳往後踏、弦拉到 STANCE_PULL、身體往後仰一點、箭頭微微發光（一直脈動）；箭雨兩腳張開、弓朝上拉到 RAIN_PULL、上身往後仰
function stancePose(stance, t) {
  const none = { pull: 0, extend: 0, lean: 0, glow: 0, shake: 0, recoil: 0, twang: 0, stride: null };
  if (!stance) return none;
  if (stance.action === 'rain') return { ...none, pull: RAIN_PULL, extend: 3, lean: 0.12, stride: 'wide' };
  return { ...none, pull: STANCE_PULL, extend: 3, lean: 0.06, glow: 0.18 + 0.1 * Math.sin(t * 5), stride: 'back' };
}

// 出招時的拉弓姿勢（照預兆的進度）：pull = 弦拉開多少、extend = 手臂多伸出去、lean = 身體往後仰（弧度）、glow = 箭頭聚光（0 ~ 1）、
// shake = 拉滿時抖多大、recoil = 放箭時拿弓的手往上彈多少（弧度）、twang = 放箭後弓弦還在震（0 ~ 1）、stride = 腳怎麼站（見 drawRanger）。
// 從架勢接下去（玩家回合裡已經拉著弓了）：貫穿箭從 STANCE_PULL 慢慢拉滿（到 HOLD）→ 抖著蓄力 → 放箭；箭雨拉著 RAIN_PULL → 放箭
function bowPose(fx) {
  const none = { pull: 0, extend: 0, lean: 0, glow: 0, shake: 0, recoil: 0, twang: 0, stride: null };
  if (!fx || (fx.action !== 'pierce' && fx.action !== 'rain')) return none;
  const rel = fx.cast * RELEASE_AT;
  const u = Math.max(0, Math.min(1, fx.t / Math.max(0.01, rel)));
  const stride = fx.action === 'rain' ? 'wide' : 'back';
  if (fx.t >= rel) {   // 放箭之後
    const after = Math.min(1, (fx.t - rel) / Math.max(0.01, fx.cast - rel));
    return { ...none, extend: 3 * (1 - after), recoil: 0.35 * (1 - after) * (1 - after), twang: 1 - after, lean: (fx.action === 'rain' ? 0.12 : 0.1) * (1 - after), stride };
  }
  if (fx.action === 'rain') return { ...none, pull: RAIN_PULL, extend: 3, lean: 0.12, stride };
  const d = Math.min(1, u / HOLD);
  const ease = 1 - (1 - d) * (1 - d);
  const full = u >= HOLD;
  return {
    ...none, pull: STANCE_PULL + (MAX_PULL - STANCE_PULL) * ease, extend: 3, lean: 0.06 + 0.04 * ease,
    glow: 0.2 + d * 0.5 + (full ? 0.3 : 0), shake: full ? 0.8 : 0, stride,
  };
}

// 長弓：握把在 (x, y)、朝 angle 的方向，pull = 弦拉開多少（0 = 放鬆，拉得越開弓身越彎）、twang = 放箭後弓弦還在震（0 ~ 1）
function drawBow(ctx, x, y, angle, pull, col, twang = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const bend = 8 + pull * 0.35, tip = 20 - pull * 0.25;
  ctx.strokeStyle = col(BOW); ctx.lineWidth = 2.8;
  ctx.beginPath(); ctx.moveTo(-3 - pull * 0.15, -tip); ctx.quadraticCurveTo(bend, 0, -3 - pull * 0.15, tip); ctx.stroke();
  ctx.strokeStyle = col(STRING); ctx.lineWidth = 1;
  const wob = twang > 0 ? Math.sin(twang * 40) * 3 * twang : 0;
  ctx.beginPath(); ctx.moveTo(-3 - pull * 0.15, -tip); ctx.lineTo(-3 - pull + wob, 0); ctx.lineTo(-3 - pull * 0.15, tip); ctx.stroke();
  ctx.restore();
}

// 一團光：中間白、外面淡綠、邊緣透明（a = 亮度 0 ~ 1）
function drawGlow(ctx, x, y, r, a) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${0.9 * a})`);
  g.addColorStop(0.35, `rgba(${GLOW_RGB},${0.7 * a})`);
  g.addColorStop(1, `rgba(${GLOW_RGB},0)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 飛出去的貫穿箭：後面一道很長的光痕（外面淡綠、中間白）、箭身、發光的箭頭（一直脈動）
function drawPowerArrow(ctx, c, p) {
  const angle = Math.atan2(p.vy, p.vx);
  const len = 34;
  const pulse = 0.85 + 0.15 * Math.sin((c.state.sway || 0) * 30);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(angle);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [w, a, k] of [[16, 0.22, 6], [9, 0.4, 5], [4, 0.7, 4], [2, 1, 3]]) {
    const g = ctx.createLinearGradient(-len * k, 0, 0, 0);
    g.addColorStop(0, `rgba(${GLOW_RGB},0)`);
    g.addColorStop(1, w <= 2 ? `rgba(255,255,255,${a})` : `rgba(${GLOW_RGB},${a})`);
    ctx.strokeStyle = g; ctx.lineWidth = w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-len * k, 0); ctx.lineTo(0, 0); ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = '#a16207'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(-4, 0); ctx.stroke();
  ctx.fillStyle = '#84cc16';   // 箭羽
  ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(-len - 5, -4); ctx.lineTo(-len + 5, 0); ctx.lineTo(-len - 5, 4); ctx.closePath(); ctx.fill();
  drawGlow(ctx, 0, 0, 26 * pulse, 0.8);
  drawGlow(ctx, 0, 0, 12 * pulse, 1);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(3, 0); ctx.lineTo(-6, -3.5); ctx.lineTo(-6, 3.5); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// 放箭 / 射穿人的閃光：一圈很快往外擴、淡掉的光環（加上中間一團光）
function drawFlashes(ctx, c) {
  for (const fl of c.state.glints || []) {
    const u = fl.t / 0.35;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(${GLOW_RGB},${0.8 * (1 - u)})`;
    ctx.lineWidth = 3 * (1 - u) + 1;
    ctx.beginPath(); ctx.arc(fl.x, fl.y, fl.r * (0.3 + u), 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    drawGlow(ctx, fl.x, fl.y, fl.r * 0.8, 1 - u);
  }
}

// 自己被困住、輪到自己的時候：畫面中間（上面那條提示的區域，不擋戰場）一直提示要連點 A/D、還差幾下；體力流光了改提示等下一回合
function drawEscapeHint(ctx, c) {
  const S = c.match.mechState;
  const me = c.myId ? c.match.byId(c.myId) : null;
  if (!S || !me || !me.alive || c.currentId !== me.id) return;
  const rec = S.trapped[me.id];
  if (!rec) return;
  const out = me.stamina <= 0;
  const pulse = out ? 1 : 0.75 + 0.25 * Math.sin((c.state.sway || 0) * 8);
  ctx.save();
  ctx.globalAlpha = pulse;
  const msg = out ? '體力用光了，下一回合再掙脫' : `連點 A/D 可逃脫！（${rec.count} / ${CONFIG.RANGER.trap.need}）`;
  text(ctx, msg, CONFIG.WORLD_W / 2, 222, { size: 26, bold: true, align: 'center', color: out ? '#fca5a5' : '#bef264', outline: 'rgba(0,0,0,0.85)', outlineWidth: 5 });
  ctx.restore();
}

// 一支箭：箭頭在 (x, y)、朝 angle、長 len；trail = 後面拖一道淡淡的光（貫穿箭）
function drawArrow(ctx, x, y, angle, len, trail) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (trail) {
    const g = ctx.createLinearGradient(-len * 2.4, 0, 0, 0);
    g.addColorStop(0, 'rgba(190,242,100,0)');
    g.addColorStop(1, 'rgba(190,242,100,0.6)');
    ctx.strokeStyle = g; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-len * 2.4, 0); ctx.lineTo(0, 0); ctx.stroke();
  }
  ctx.strokeStyle = '#a16207'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(-3, 0); ctx.stroke();
  ctx.fillStyle = '#e5e7eb';
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(-6, -3); ctx.lineTo(-6, 3); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#84cc16';   // 箭羽
  ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(-len - 4, -3.5); ctx.lineTo(-len + 4, 0); ctx.lineTo(-len - 4, 3.5); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// 地上的藤蔓陷阱：一圈帶刺的藤蔓盤在地上，冒出幾片葉子；還剩幾下用小綠點標在上面
function drawTrap(ctx, c, e, hurt) {
  const t = c.state.sway || 0;
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath(); ctx.ellipse(0, 0, e.hw + 2, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    ctx.strokeStyle = hurt ? '#ffffff' : k % 2 ? VINE_DARK : VINE;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, -3 - k * 1.2, e.hw - k * 3, 4 - k * 0.6, 0, Math.PI * (0.1 + k * 0.3), Math.PI * (2.0 + k * 0.3));
    ctx.stroke();
  }
  ctx.fillStyle = THORN;
  for (let k = 0; k < 6; k++) {
    const a = k * Math.PI / 3 + 0.3;
    const px = Math.cos(a) * (e.hw - 2), py = -3 + Math.sin(a) * 4;
    ctx.beginPath(); ctx.moveTo(px, py - 3); ctx.lineTo(px - 1.2, py); ctx.lineTo(px + 1.2, py); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = hurt ? '#ffffff' : LEAF;
  for (const [lx, s] of [[-e.hw + 3, -1], [e.hw - 4, 1], [2, 1]]) {
    const wob = Math.sin(t * 3 + lx) * 0.2;
    ctx.save(); ctx.translate(lx, -5); ctx.rotate(s * (0.6 + wob));
    ctx.beginPath(); ctx.ellipse(0, -4, 2.4, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  const max = CONFIG.RANGER.trap.hp;
  for (let k = 0; k < max; k++) {
    ctx.fillStyle = k < e.hp ? '#bef264' : 'rgba(255,255,255,0.25)';
    ctx.beginPath(); ctx.arc((k - (max - 1) / 2) * 7, -14, 2.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// 被困住的人：腳邊盤著藤蔓、往上纏到小腿（一直輕輕扭動）
function drawBinding(ctx, c, p) {
  const t = c.state.sway || 0;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.lineCap = 'round';
  ctx.strokeStyle = VINE;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(0, -1, p.hw + 6, 4, 0, 0, Math.PI * 2); ctx.stroke();
  for (let k = 0; k < 4; k++) {
    const side = k % 2 ? 1 : -1;
    const wob = Math.sin(t * 4 + k) * 2;
    ctx.strokeStyle = k % 2 ? VINE_DARK : VINE;
    ctx.beginPath();
    ctx.moveTo(side * (p.hw + 4), -1);
    ctx.quadraticCurveTo(side * (p.hw - 2) + wob, -10 - k * 3, -side * 3, -14 - k * 4);
    ctx.stroke();
  }
  ctx.fillStyle = LEAF;
  ctx.beginPath(); ctx.ellipse(p.hw + 4, -6, 2.2, 4.5, 0.6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-p.hw - 3, -9, 2.2, 4.5, -0.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 貫穿箭標記的人：轉動的準星（貫穿箭的 HUD 一直寫著標記誰；準星與預警線照難度，菁英之路不畫）。
// 預警線從遊俠現在的弓、穿過他現在身體的中間延伸出去（輪到她時照那時候的位置射，所以跟著動）
function drawPierceMark(ctx, c) {
  const g = c.match.byId(RANGER_ID);
  const S = c.match.mechState;
  if (!g || !g.alive || !S) return;
  const fx = c.state.fx;
  const casting = fx && fx.action === 'pierce';
  if (c.rangeHints === false && !casting) return;
  const plan = casting ? fx.step : S.next;
  if (!plan || (!casting && plan.action !== 'pierce')) return;
  const t = casting ? c.match.byId(plan.targetId) : plan.targetId ? c.match.byId(plan.targetId) : null;
  if (!t || !t.alive) return;
  if (casting && fx.t >= fx.cast * RELEASE_AT) return;
  const time = c.state.sway || 0;
  ctx.save();
  const L = arrowLine(c.match, bowPoint(g), { x: t.cx, y: t.cy });
  const pulse = casting ? 0.5 + 0.5 * Math.sin(time * 18) : 0.5 + 0.5 * Math.sin(time * 4);
  ctx.strokeStyle = `rgba(190,242,100,${0.18 + 0.2 * pulse})`;
  ctx.lineWidth = CONFIG.WEAPONS.rangerArrow.hitRadius * 2;
  ctx.beginPath(); ctx.moveTo(L.x0, L.y0); ctx.lineTo(L.x1, L.y1); ctx.stroke();
  ctx.strokeStyle = 'rgba(217,249,157,0.8)'; ctx.lineWidth = 1.2; ctx.setLineDash([8, 6]);
  ctx.beginPath(); ctx.moveTo(L.x0, L.y0); ctx.lineTo(L.x1, L.y1); ctx.stroke();
  ctx.setLineDash([]);
  const r = Math.max(t.h, 2 * t.hw) * 0.75 + 6;
  ctx.translate(t.cx, t.cy);
  ctx.strokeStyle = '#bef264'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.rotate(time * (casting ? 6 : 1.5));
  for (let k = 0; k < 4; k++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath(); ctx.moveTo(r - 6, 0); ctx.lineTo(r + 6, 0); ctx.stroke();
  }
  ctx.restore();
}
