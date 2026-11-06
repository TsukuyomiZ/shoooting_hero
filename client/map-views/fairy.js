import { CONFIG } from '../../shared/core/config.js';
import { text, roundRect } from '../draw.js';
import { FAIRY_ID, FAIRY_ACTION_NAMES, isClone, fairyOf, syncFairy } from '../../shared/maps/fairy.js';

// 菁英關「調皮妖精」的地圖畫面：妖精回合的動畫腳本（星屑彈 = 揮魔杖射出一顆星；調包 = 兩個人身上冒光、互換位置；
// 閃現 = 三個一起淡出、在新的地方淡入）、妖精（翅膀、粉紫色的裙子、拿著星星魔杖，飄在空中上下浮動）、
// 本尊與分身畫得一模一樣（血條都照本尊的血量畫）——只有被咬耳朵的人（S.whisper = 自己）看得到：本尊發金光、分身半透明；
// 咬耳朵的人頭上的耳朵圖示（大家都看得到）、被魅惑的人頭上轉圈的愛心、分身被打破的爆炸、分身消失的煙。規則在 shared/maps/fairy.js；掛勾的說明見 index.js
const FPS = 60;
const WING = 'rgba(207,250,254,0.55)', WING_EDGE = 'rgba(165,243,252,0.9)';
const DRESS = '#f0abfc', DRESS_DARK = '#c026d3', SKIN = '#fde2cf', HAIR = '#fde047', HAIR_DARK = '#eab308';
const STAR = '#fef9c3', SPARK = '#f5d0fe', HEART = '#f472b6';
const FADE_AT = 0.45;      // 閃現：預兆播到這裡三個都淡出不見、換到新的地方（之後淡入）

export const fairy = {
  type: 'fairy',

  // 這一場的畫面狀態：
  //   fx       妖精出招的預兆 { action, t, cast, step }（妖精回合播完就清掉）
  //   blink    閃現中 { t, cast }（三個一起淡出、淡入；null = 沒有）
  //   time     翅膀拍動、浮動的時間（秒）
  //   greeted  開場有沒有提示過「妖精在你耳邊說悄悄話」（開場的閃現在伺服器上，畫面要自己補一次）
  create: () => ({ fx: null, blink: null, time: 0, greeted: false }),

  turnScript: fairyTurnScript,
  abortScript(c) {
    c.state.fx = null;
    c.state.blink = null;
  },
  onDeath: onFairyDeath,

  update(c, dt) {
    const st = c.state;
    st.time += dt;
    for (const p of c.projectiles) {   // 飛行中的星屑彈一路掉亮粉
      if (!p.weapon || p.weapon.id !== 'fairyStar' || p.state === 'done') continue;
      c.fx.particles(p.x, p.y, 2, { speed: 50, life: 0.5, size: 2.2, color: SPARK, gravity: 40 });
    }
    const S = c.match.mechState;
    if (S && !st.greeted && c.myId) {
      st.greeted = true;
      if (S.whisper === c.myId) whisperFx(c);
    }
    syncFairy(c.match);
  },

  // 這一下打到本尊（分身消失）/ 打破了分身（爆炸、魅惑）/ 她生氣了
  showEvent(c, ev) {
    const p = c.projectiles.find(q => q.i === ev.p);
    if (p && p.weapon && p.weapon.id === 'fairyStar' && ev.target) {
      c.fx.particles(ev.x, ev.y, 14, { speed: 200, life: 0.5, size: 2.4, color: STAR, gravity: 60 });
    }
    const F = ev.fairy;
    if (!F) return;
    for (const id of F.vanish || []) {
      const e = c.match.byId(id);
      if (e) c.fx.particles(e.x, e.y - e.h / 2, 16, { speed: 90, life: 0.7, size: 3, color: 'rgba(233,213,255,0.8)', gravity: -40 });
    }
    if ((F.vanish || []).length) {
      c.fx.float(fairyOf(c.match) || c.match.byId(FAIRY_ID), '本尊！', '#fde047');
      c.fx.sound('twinkle', { x: (fairyOf(c.match) || {}).x });
    }
    for (const b of F.blasts || []) {
      c.fx.particles(b.x, b.y, 26, { speed: 260, life: 0.55, size: 3, color: SPARK, gravity: 80 });
      c.fx.particles(b.x, b.y, 10, { speed: 140, life: 0.7, size: 2.4, color: '#ffffff', gravity: 30 });
      c.fx.shake(6);
      c.fx.sound('pop', { x: b.x });
      if (b.charm) {
        const e = c.match.byId(b.charm);
        if (e) {
          c.fx.float(e, '被魅惑了！', HEART);
          c.fx.particles(e.x, e.y - e.h - 6, 8, { speed: 70, life: 0.8, size: 3, color: HEART, gravity: -60 });
          c.fx.sound('charm', { x: e.x });
        }
        if (b.charm === c.myId) c.fx.banner('你被魅惑了！下一回合會攻擊隊友', HEART);
      } else {
        const e = c.match.byId(b.id);   // 飄在分身自己身上（飄在本尊身上等於告訴大家本尊在哪）
        if (e) c.fx.float(e, '是分身！', SPARK);
      }
    }
    if (F.angry) c.fx.banner('調皮妖精生氣了！不再說悄悄話', '#fda4af');
  },

  // 分身被打到的那一筆（扣 1）不飄字（爆炸本身就看得出來）
  showDamage: (c, e) => isClone(e),

  // 回合結束：被魅惑的回合打完了 → 解除（收掉愛心）
  turnFx(c, e, fx) {
    if (fx.type !== 'charmEnd') return false;
    const S = c.match.mechState;
    if (S) delete S.charm[fx.id];
    if (e.alive) c.fx.float(e, '清醒了', '#e9d5ff', 14);
    return true;
  },

  drawEntity(ctx, c, e, hurt) {
    if (e.id !== FAIRY_ID && !isClone(e)) return false;
    drawFairyWhole(ctx, c, e, hurt);
    return 'whole';
  },

  drawProjectile(ctx, c, p) {
    if (p.weapon.id !== 'fairyStar') return false;
    drawStar(ctx, p.x, p.y, 8, c.state.time * 8, true);
    return true;
  },

  // 角色之前：咬耳朵的人頭上的耳朵、被魅惑的人頭上的愛心
  drawScene(ctx, c) {
    const S = c.match.mechState;
    if (!S) return;
    const t = c.state.time;
    if (S.whisper) {
      const p = c.match.byId(S.whisper);
      if (p && p.alive) drawEar(ctx, p.x, p.y - p.h - 40 + Math.sin(t * 3) * 2);
    }
    for (const pid of Object.keys(S.charm)) {
      const p = c.match.byId(pid);
      if (!p || !p.alive) continue;
      for (let k = 0; k < 3; k++) {
        const a = t * 2.4 + k * Math.PI * 2 / 3;
        drawHeart(ctx, p.x + Math.cos(a) * 16, p.y - p.h - 8 + Math.sin(a) * 5, 4.5);
      }
    }
  },

  // 一般那一行（敵人剩餘）+ 妖精的血量、誰被咬耳朵（生氣了就寫不再說悄悄話）、被魅惑的人
  hud(c, line) {
    const lines = [line];
    const e = fairyOf(c.match);
    const S = c.match.mechState;
    if (!e || !e.alive || !S) return lines;
    lines.push([`調皮妖精 ${e.hp} / ${e.maxHp}`, '#f5d0fe']);
    if (S.angry) lines.push(['妖精生氣了：不再咬耳朵', '#fda4af']);
    else if (S.whisper) {
      const p = c.match.byId(S.whisper);
      if (p) lines.push([`咬耳朵：${p.name}${p.id === c.myId ? '（你看得到本尊）' : ''}`, '#fde68a']);
    }
    for (const pid of Object.keys(S.charm)) {
      const p = c.match.byId(pid);
      if (p && p.alive) lines.push([`${p.name} 被魅惑了`, HEART]);
    }
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 妖精的回合：出一招 → 閃現，一招一招照順序播
function* fairyTurnScript(c, msg) {
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* stepScript(c, msg.actorId, step);
  c.state.fx = null;
  c.state.blink = null;
}

function* stepScript(c, id, b) {
  const match = c.match;
  const g = match.byId(id);
  const S = match.mechState;
  const cast = Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS);
  const fx = c.state.fx = { action: b.action, t: 0, cast: cast / FPS, step: b };
  const N = FAIRY_ACTION_NAMES;
  const target = b.targetId ? match.byId(b.targetId) : null;
  if (g && (b.facing === 1 || b.facing === -1)) g.facing = b.facing;
  const pair = b.action === 'swap' ? (b.ids || []).map(pid => match.byId(pid)).filter(Boolean) : [];
  if (b.action === 'star') c.fx.banner(`調皮妖精：${N.star}！${target ? ` → ${target.name}` : ''}`, '#f5d0fe');
  else if (b.action === 'swap') c.fx.banner(`調皮妖精：${N.swap}！${pair.length === 2 ? ` ${pair[0].name} ⇄ ${pair[1].name}` : ''}`, '#c4b5fd');
  else if (b.action === 'idle') c.fx.banner(`調皮妖精${N.idle}中`, '#e9d5ff');
  if (b.action !== 'idle') c.fx.sound('twinkle', { x: g ? g.x : 512, vol: b.action === 'blink' ? 0.5 : 0.8 });
  if (g && b.burn) {   // 本尊的燃燒在閃現之前（舊的位置）結算
    if (b.burn.dmg > 0) {
      g.hurtTimer = 0.35;
      c.fx.float(g, `-${b.burn.dmg} 燃燒`, '#fb923c');
      c.fx.particles(g.cx, g.cy, 12, { speed: 70, life: 0.7, size: 4, color: '#f97316', gravity: -160 });
    }
    if (b.burn.shaken > 0) c.fx.float(g, `甩掉 ${b.burn.shaken} 層燃燒`, '#fdba74', 14);
  }

  const spots = b.action === 'blink' ? b.spots || [] : [];
  if (spots.length) c.state.blink = { t: 0, cast: cast / FPS };
  let moved = false;
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    const k = i / cast;
    if (b.action === 'star' && g && i % 4 === 0) {   // 揮魔杖：杖頭聚一點亮粉
      const tip = wandTip(g, c.state.time);
      c.fx.particles(tip.x, tip.y, 1, { speed: 30, life: 0.4, size: 2, color: STAR, gravity: 0 });
    }
    if (b.action === 'swap' && i % 3 === 0) {   // 兩個人身上冒紫色的光
      for (const p of pair) c.fx.particles(p.x, p.y - p.h / 2, 2, { speed: 80, life: 0.5, size: 2.4, color: '#c4b5fd', gravity: -40 });
    }
    if (spots.length) {
      c.state.blink.t = i / FPS;
      if (!moved && k >= FADE_AT) {   // 淡出不見了：換到新的地方（分身重新出現）
        moved = true;
        for (const sp of spots) {
          const e = match.byId(sp.id);
          if (!e) continue;
          c.fx.particles(e.x, e.y - e.h / 2, 8, { speed: 70, life: 0.5, size: 2.4, color: SPARK, gravity: -30 });
          if (isClone(e) && !e.alive) { e.alive = true; e.hp = 1; e.deathCause = null; e.deathTimer = 0; }
          e.x = sp.x;
          e.y = sp.y;
          if (sp.facing === 1 || sp.facing === -1) e.facing = sp.facing;
        }
        if (S) {
          S.whisper = typeof b.whisper === 'string' ? b.whisper : null;
          if (S.whisper) S.lastWhisper = S.whisper;
          S.revealed = false;
        }
      }
    }
    yield { frames: 1 };
  }
  fx.t = fx.cast;
  if (b.shot) {
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    if (b.action === 'swap') {
      for (const p of pair) c.fx.particles(p.x, p.y - p.h / 2, 12, { speed: 120, life: 0.5, size: 2.4, color: '#c4b5fd', gravity: 0 });
      for (const d of b.damages || []) {
        const e = match.byId(d.id);
        if (e && d.dmg > 0) c.fx.float(e, `-${d.dmg}`, '#ff6b6b');
      }
      c.fx.shake(3);
    }
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
  c.state.blink = null;
  if (spots.length && S && S.whisper === c.myId) whisperFx(c);
  syncFairy(match);
}

// 被咬耳朵（自己）：橫幅提示
function whisperFx(c) {
  c.fx.banner('妖精在你耳邊說悄悄話：發光的才是本尊！', '#fde68a');
  c.fx.sound('twinkle', { vol: 0.6 });
}

// 妖精倒下 / 分身消失：回傳 true 表示處理過了（分身不播「被擊倒」橫幅）
function onFairyDeath(c, e) {
  if (isClone(e)) return true;
  if (e.id !== FAIRY_ID) return false;
  c.fx.banner('調皮妖精倒下了！', '#c084fc');
  c.fx.shake(8);
  c.fx.particles(e.x, e.y - e.h / 2, 30, { speed: 180, life: 1.2, size: 3, color: SPARK, gravity: 60 });
  c.fx.particles(e.x, e.y - e.h / 2, 12, { speed: 120, life: 1, size: 2.5, color: STAR, gravity: 20 });
  return true;
}

// ---------- 繪圖 ----------

// 這個角色在自己的畫面上看起來怎樣：本尊 / 分身一樣（看不出來）；被咬耳朵的人（還沒現形時）看得到本尊發光、分身半透明
function lookOf(c, e) {
  const S = c.match.mechState;
  const knows = !!S && !!c.myId && S.whisper === c.myId && !S.revealed;
  return { glow: knows && e.id === FAIRY_ID, faint: knows && isClone(e) };
}

// 血量比例（0 ~ 1）
const hpRatio = (e) => Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHp)));

// 浮動的高度（三個的節奏錯開，看起來不像同一個動畫）
const bobOf = (c, e) => Math.sin(c.state.time * 2.2 + (e.x * 0.013)) * 3;

// 魔杖的杖頭（世界座標）：拿在面向的那一邊
function wandTip(e, t) {
  const f = e.facing || -1;
  const sc = e.h / 34;
  return { x: e.x + f * 14 * sc, y: e.y - 30 * sc + Math.sin(t * 2.2) * 3 };
}

// 一整個妖精（身體、血條、名字都自己畫：分身的血條也照本尊的血量畫，才看不出來）。閃現中照進度淡出 / 淡入
function drawFairyWhole(ctx, c, e, hurt) {
  const look = lookOf(c, e);
  const bl = c.state.blink;
  let alpha = look.faint ? 0.4 : 1;
  if (bl && bl.cast > 0) {
    const k = bl.t / bl.cast;
    alpha *= k < FADE_AT ? 1 - k / FADE_AT : Math.min(1, (k - FADE_AT) / (1 - FADE_AT) * 1.5);
  }
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  const bob = bobOf(c, e);
  if (look.glow) {   // 被咬耳朵的人看到的本尊：一圈金光
    const r = 30 + Math.sin(c.state.time * 5) * 3;
    const gl = ctx.createRadialGradient(e.x, e.y - e.h / 2 + bob, 4, e.x, e.y - e.h / 2 + bob, r);
    gl.addColorStop(0, 'rgba(253,224,71,0.55)');
    gl.addColorStop(1, 'rgba(253,224,71,0)');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(e.x, e.y - e.h / 2 + bob, r, 0, Math.PI * 2); ctx.fill();
  }
  drawFairy(ctx, c, e, hurt, bob);
  // 血條 + 名字：照本尊的血量（本尊倒下了就照自己的）
  const g = fairyOf(c.match);
  const ratio = hpRatio(g && g.alive ? g : e);
  const bw = 70, bh = 7, by = e.y + bob - e.h - 16;
  if (e.alive) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, e.x - bw / 2, by, bw, bh, 3); ctx.fill();
    if (ratio > 0) {
      ctx.fillStyle = '#ef4444';
      roundRect(ctx, e.x - bw / 2, by, bw * ratio, bh, 3); ctx.fill();
    }
  }
  text(ctx, look.glow ? '調皮妖精（本尊）' : '調皮妖精', e.x, by - 4, { size: 12, bold: true, align: 'center', color: look.glow ? '#fde047' : '#ffd54f', outline: 'rgba(0,0,0,0.9)' });
  ctx.restore();
}

// 妖精本人（面向右的身體座標：腳底中心是原點、身高 34）：一對透明的翅膀（拍動）、粉紫色的花瓣裙、金色的長髮、拿著星星魔杖。hurt = 剛被打到（白色）
function drawFairy(ctx, c, e, hurt, bob) {
  const f = e.facing || -1;
  const sc = e.h / 34;
  const t = c.state.time;
  const col = (v) => (hurt ? '#ffffff' : v);
  const flap = Math.sin(t * 22 + e.x * 0.05);
  ctx.save();
  ctx.translate(e.x, e.y + bob);
  ctx.scale(f * sc, sc);
  // 翅膀（背後兩片，拍動時上下張合）
  for (const [dy, len, k] of [[-24, 16, 1], [-18, 12, 0.8]]) {
    ctx.save();
    ctx.translate(-3, dy);
    ctx.rotate(-0.5 - flap * 0.35 * k);
    ctx.fillStyle = hurt ? 'rgba(255,255,255,0.8)' : WING;
    ctx.strokeStyle = WING_EDGE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(-len * 0.5, 0, len * 0.6, len * 0.32, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // 腳（飄著：腳尖往下）
  ctx.strokeStyle = col(SKIN); ctx.lineWidth = 2.2; ctx.lineCap = 'round';
  for (const [x0, x1] of [[-2, -3], [2, 2]]) { ctx.beginPath(); ctx.moveTo(x0, -9); ctx.lineTo(x1, -1); ctx.stroke(); }
  // 花瓣裙
  ctx.fillStyle = col(DRESS_DARK);
  ctx.beginPath(); ctx.moveTo(-3, -20); ctx.lineTo(-9, -8); ctx.quadraticCurveTo(0, -5, 9, -8); ctx.lineTo(3, -20); ctx.closePath(); ctx.fill();
  ctx.fillStyle = col(DRESS);
  for (const dx of [-5, 0, 5]) { ctx.beginPath(); ctx.ellipse(dx, -10, 3.4, 4.2, dx * 0.08, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillRect(-3, -22, 6, 8);
  // 手臂（拿魔杖的那隻往前伸）
  ctx.strokeStyle = col(SKIN); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(1, -19); ctx.lineTo(9, -23); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-2, -19); ctx.lineTo(-6, -14); ctx.stroke();
  // 魔杖
  ctx.strokeStyle = col('#fef3c7'); ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(8, -22); ctx.lineTo(14, -30); ctx.stroke();
  ctx.restore();
  const tip = wandTip(e, t);
  drawStar(ctx, tip.x, tip.y + (bob - Math.sin(t * 2.2) * 3), 4, t * 3, false, hurt);
  ctx.save();
  ctx.translate(e.x, e.y + bob);
  ctx.scale(f * sc, sc);
  // 頭、頭髮
  ctx.fillStyle = col(HAIR_DARK);
  ctx.beginPath(); ctx.ellipse(-3, -26, 5, 7, 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col(SKIN);
  ctx.beginPath(); ctx.arc(0, -27, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = col(HAIR);
  ctx.beginPath(); ctx.arc(-0.5, -29, 5.4, Math.PI * 1.05, Math.PI * 2.05); ctx.fill();
  ctx.fillStyle = '#1f2937';
  ctx.beginPath(); ctx.arc(2.6, -27, 0.9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(244,114,182,0.7)';
  ctx.beginPath(); ctx.arc(3, -25.2, 1.1, 0, Math.PI * 2); ctx.fill();
  // 尖耳朵
  ctx.fillStyle = col(SKIN);
  ctx.beginPath(); ctx.moveTo(-3, -28); ctx.lineTo(-8, -31); ctx.lineTo(-3.5, -25.5); ctx.closePath(); ctx.fill();
  ctx.restore();
}

// 五角星（星屑彈、魔杖的杖頭）：glow = 外面一圈光暈
function drawStar(ctx, x, y, r, rot, glow, hurt = false) {
  ctx.save();
  ctx.translate(x, y);
  if (glow) {
    const g = ctx.createRadialGradient(0, 0, 1, 0, 0, r * 2.6);
    g.addColorStop(0, 'rgba(254,249,195,0.9)');
    g.addColorStop(1, 'rgba(245,208,254,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r * 2.6, 0, Math.PI * 2); ctx.fill();
  }
  ctx.rotate(rot);
  ctx.fillStyle = hurt ? '#ffffff' : STAR;
  ctx.strokeStyle = '#facc15'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const rr = k % 2 ? r * 0.45 : r;
    const a = -Math.PI / 2 + k * Math.PI / 5;
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

// 耳朵圖示（被咬耳朵的人頭上）：一隻耳朵 + 旁邊兩道小聲波
function drawEar(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fde2cf';
  ctx.strokeStyle = '#b45309'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.ellipse(-1, 0, 5, 7.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(-0.5, -0.5, 2.6, Math.PI * 0.8, Math.PI * 2.1); ctx.stroke();
  ctx.strokeStyle = '#fde68a'; ctx.lineWidth = 1.3;
  for (const r of [7, 10]) { ctx.beginPath(); ctx.arc(1, 0, r, -0.5, 0.5); ctx.stroke(); }
  ctx.restore();
}

// 愛心（被魅惑的人頭上轉圈）
function drawHeart(ctx, x, y, s) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 5, s / 5);
  ctx.fillStyle = HEART;
  ctx.beginPath();
  ctx.moveTo(0, 4);
  ctx.bezierCurveTo(-6, -1, -4, -6, 0, -3);
  ctx.bezierCurveTo(4, -6, 6, -1, 0, 4);
  ctx.fill();
  ctx.restore();
}
