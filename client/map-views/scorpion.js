import { CONFIG } from '../../shared/core/config.js';
import { inShadow, torchLight, torchLevel } from '../../shared/maps/cave.js';
import { SCORPION_NAME, SCORPION_ACTION_NAMES, PARTS, BODY, holeX, lurkPoint, setOut, revealIfLit, isScorpionPart, actionsPerTurn } from '../../shared/maps/scorpion.js';
import { archPath, text } from '../draw.js';
import { cave, drawShade as drawCaveShade } from './cave.js';

// Boss 關「巨蠍巢穴」的地圖畫面：洞穴的部分（火把、照明、掉下來的鐘乳石）沿用 cave.js（牆上的洞是關卡的裝飾 decor.burrows），
// 加上洞穴巨蠍：三個部位是三個角色，但不各自畫（drawEntityBare 一律跳過）：
//   出洞時整隻畫在場景裡（照背甲的位置；被擊破的部位畫成斷掉的樣子），躲著時只在洞穴中間畫一對發紅的雙眼（畫在遮光上面）；
//   火把亮著的洞整個照亮；被火光逼出來（從地底升上來、頭上轉星星）；回合的動畫腳本（暈眩 / 醒來震擊周圍、各部位出招、鑽進地底 → 新的洞只冒出雙眼 / 躲著從暗處射毒刺）、
//   招式的飛行物。規則在 shared/maps/scorpion.js；掛勾的說明見 index.js
const FPS = 60;
const CHITIN = '#3b2230', CHITIN_DARK = '#24141d', CHITIN_EDGE = '#6b3a4c', FLESH = '#9a3412';
const SINK = 270;          // 鑽地 / 從地底升上來時整隻往下沉多深（毒針也要沉到地面下）
const LUNGE = 14;          // 震擊周圍時往前撲多少
const EYE_GAP = 9;         // 躲著時兩隻眼睛隔多遠
const WIND = { text: '颳起一陣強烈的風', time: 3.2, y: 224 };   // 每一輪開始的強風：字幕（在橫幅下面一點）停多久

export const scorpion = {
  ...cave,
  type: 'scorpion',

  // 這一場的畫面狀態：洞穴的（爆炸閃光、火把點燃）+
  //   fx    巨蠍出招的預兆 { action, t, phase: 'cast' | 'act', targetId, hidden }（巨蠍回合播完就清掉）
  //   dig   鑽地換洞的動畫 { from: { ax, f }, toHole, k: 0..1 }（前半在原本的洞沉下去，後半新的洞的雙眼慢慢亮起來）
  //   rise  被火光逼出來、從地底升上來的動畫 { k: 0..1 }（洞穴中間的雙眼同時淡掉），update 照遊戲時間推進（鑽地的動畫播完才開始）
  //   lastOut  上一步看到的出洞了沒（看出「被逼出來」的那一刻）
  //   round / wind  上一步看到的輪數；強風的字幕 { t0 }（新的一輪開始時颳起來）
  create: (match) => ({ ...cave.create(match), fx: null, dig: null, rise: null,
    lastOut: !!(match.mechState && match.mechState.out), round: match.round, wind: null }),

  musicTrack: () => 'scorpion',   // 巨蠍的 Boss 曲（Boss 關沒有狂熱，不換）

  turnScript: scorpionTurnScript,
  abortScript(c) { c.state.fx = null; c.state.dig = null; c.state.rise = null; },
  onDeath: onPartBroken,

  // 每一步：洞穴的（閃光、火星、熄掉的火把冒煙）+ 地鳴 / 震擊周圍貼著地面揚起碎石、被火光逼出來、新的一輪的強風（畫圖只讀狀態）
  update(c, dt) {
    cave.update(c, dt);
    for (const p of c.projectiles) {
      if (p.weapon && (p.weapon.id === 'scorpionQuake' || p.weapon.id === 'scorpionBurst')) groundDebris(c, p);
    }
    const s = c.state, S = c.match.mechState;
    if (!S) return;
    if (c.match.round > s.round) {   // 新的一輪：一陣強風（多人才有；第一輪開打不算）；火把照這一輪算好之後還亮著 → 被逼出來（伺服器的 roundStart 同一個條件）
      if (s.round >= 1 && S.windy) gust(c);
      s.round = c.match.round;
      if (revealIfLit(c.match)) {
        reveal(c, true);
        s.lastOut = true;
      }
    }
    if (S.out !== s.lastOut) {   // 躲著 → 出洞：玩家點燃火把，被逼出來了
      if (S.out) reveal(c, false);
      s.lastOut = S.out;
    }
    if (s.rise && !s.dig) {
      s.rise.k += dt / CONFIG.SCORPION.cast.emerge;
      if (s.rise.k >= 1) s.rise = null;
    }
    if (s.wind && c.time - s.wind.t0 < 1.2 && Math.random() < dt * 40) {   // 風：一道道橫過畫面的灰白線
      c.fx.particle({ x: -20, y: 60 + Math.random() * 520, vx: 900 + Math.random() * 400, vy: (Math.random() - 0.5) * 40,
        life: 1.3, maxLife: 1.3, size: 1.6, color: 'rgba(214,211,209,0.55)', gravity: 0 });
    }
  },

  // 玩家走過去點燃火把（伺服器廣播的 pickup）：洞穴的 + 巨蠍躲的那個洞亮了就被逼出來
  onPickup(c, e, msg, self) {
    cave.onPickup(c, e, msg, self);
    if (msg.type === 'torch') revealIfLit(c.match);
  },

  // 洞穴的（鐘乳石掉下來、火把點燃、閃光）+ 夾到、刺到、衝到洞口邊
  showEvent(c, ev, made) {
    cave.showEvent(c, ev, made);
    const p = c.projectiles.find(q => q.i === ev.p);
    if (!p) return;
    const id = p.weapon.id;
    if (id === 'scorpionPinch' && ev.type === 'explode') {
      c.fx.particles(ev.x, ev.y, 14, { speed: 200, life: 0.5, size: 3, color: '#fca5a5', gravity: 600 });
      c.fx.sound('thunk', { x: ev.x });
      c.fx.shake(6);
    } else if (id === 'scorpionSting' && ev.type === 'explode') {
      c.fx.particles(ev.x, ev.y, 12, { speed: 140, life: 0.6, size: 2.5, color: '#a3e635', gravity: 300 });
    } else if (id === 'scorpionBurst' && ev.type === 'range') {
      c.fx.particles(ev.x, ev.y + 10, 10, { speed: 150, life: 0.6, size: 3, color: '#a8a29e', gravity: 700 });
    }
  },

  // 整隻巨蠍畫在場景裡（地形之後、角色之前：站在洞口前面的人畫在牠前面）
  drawScene(ctx, c) {
    cave.drawScene(ctx, c);
    drawScorpion(ctx, c);
  },
  drawEntityBare: (ctx, c, e) => isScorpionPart(e),

  // 洞穴的（掉下來的鐘乳石）+ 巨蠍的招式
  drawProjectile(ctx, c, p) {
    if (cave.drawProjectile(ctx, c, p)) return true;
    switch (p.weapon.id) {
      case 'scorpionBurst': drawBurst(ctx, p); return true;
      case 'scorpionPinch': drawFlyingClaw(ctx, p); return true;
      case 'scorpionQuake': drawQuake(ctx, p); return true;
      case 'scorpionSting': drawNeedle(ctx, p); return true;
      default: return false;
    }
  },

  // 遮光（洞穴的；巨蠍的部位不畫陰影紅光；火把亮著的洞整個照亮）之後：發紅的雙眼
  // （暗的地方也看得到牠在哪個洞；在陰影裡（傷害 +30%）時眼睛的紅光更大）
  drawShade(ctx, c) {
    drawCaveShade(ctx, c, (e) => !isScorpionPart(e), (g) => lightHoles(g, c));
    drawEyes(ctx, c);
    drawStun(ctx, c);
    drawWindCaption(ctx, c);
  },

  // 洞穴那一行（敵人剩餘、火把）+ 三個部位的血量、每回合動幾次
  hud(c, line) {
    const lines = cave.hud(c, line);
    const part = (k) => {
      const P = PARTS.find(q => q.key === k);
      const e = c.match.byId(P.id);
      return e && e.alive ? `${P.short} ${e.hp}/${e.maxHp}` : `${P.short} 已擊破`;
    };
    const n = actionsPerTurn(c.match);
    if (n > 0) {
      lines.push([`${part('pincer')}　${part('shell')}`, '#fca5a5']);
      lines.push([`${part('stinger')}　每回合動 ${n} 次`, '#fca5a5']);
    }
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 巨蠍的回合：每一招先播預兆，再照伺服器的結果重播（shotScript）或套用（still）：
//   暈眩（stunned）：頭上轉星星；震擊周圍（shock）：往前一撲、洞口塵土
//   部位出招：鉗子張開 / 背甲震動 / 尾巴往後拉；躲著射毒刺（hidden）：雙眼一亮；躲在暗處（lurk）：雙眼盯著
//   鑽地（burrow）：沉進地底，新的洞中間的雙眼慢慢亮起來（出洞 → 躲著；那個洞的火把下一輪開始還亮著才又被逼出來）
function* scorpionTurnScript(c, msg) {
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* stepScript(c, step);
  c.state.fx = null;
  c.state.dig = null;
}

function* stepScript(c, b) {
  const match = c.match;
  const S = match.mechState;
  const fx = c.state.fx = { action: b.action, t: 0, phase: 'cast', targetId: b.targetId ?? null, hidden: !!b.hidden };
  const cast = Math.max(1, Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS));
  const target = b.targetId ? match.byId(b.targetId) : null;
  const name = SCORPION_ACTION_NAMES[b.action] || b.action;
  if (b.action === 'burrow') c.fx.banner(`${SCORPION_NAME}鑽進地底…`, '#e9d5ff');
  else if (b.action === 'lurk') c.fx.banner(`${SCORPION_NAME}躲在暗處…`, '#e9d5ff');
  else if (b.action === 'stunned') c.fx.banner(`${SCORPION_NAME}暈眩中…`, '#fde68a');
  else c.fx.banner(`${SCORPION_NAME}：${name}${target ? ` → ${target.name}` : ''}！`, b.action === 'snap' ? '#e9d5ff' : '#fca5a5');
  const A = anchorOf(c);
  let dig = null;
  if (b.action === 'burrow' && A && S && Number.isInteger(b.to)) {
    dig = c.state.dig = { from: { ax: A.ax, f: A.f }, toHole: b.to, k: 0 };
  }
  const half = Math.floor(cast / 2);
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    if (dig) {
      dig.k = (i + 1) / cast;
      if (i === 0) c.fx.sound('stomp', { x: dig.from.ax });
      if (i < half && i % 4 === 0) {
        c.fx.particles(dig.from.ax + (Math.random() - 0.5) * 120, S.def.ground, 3, { speed: 120, life: 0.6, size: 3, color: '#a8a29e', gravity: 700 });
      }
    } else if (b.action === 'shock' && A) {   // 暈眩醒來：往前一撲、震擊周圍
      if (i % 8 === 0) c.fx.shake(3);
      if (i === cast - 6) {
        c.fx.shake(14);
        c.fx.sound('stomp', { x: A.ax });
        c.fx.particles(A.ax, A.gy - 10, 22, { speed: 220, life: 0.7, size: 3.5, color: '#a8a29e', gravity: 700 });
      }
    } else if (b.action === 'quake' && A && i === cast - 6) {
      c.fx.shake(12);
      c.fx.sound('stomp', { x: A.ax });
    } else if (b.action === 'sting' && A && i === cast - 6) {
      c.fx.sound('dart', { x: A.ax });
    } else if ((b.action === 'pinch' || b.action === 'snap') && A && i === cast - 6) {
      c.fx.sound('thunk', { x: A.ax + A.f * 100 });
    }
    yield { frames: 1 };
  }
  fx.phase = 'act';
  // 換洞 / 出洞的狀態照伺服器的招式改（三個部位碰不碰得到也一起改，見 shared/maps/scorpion.js 的 setOut）
  if (b.action === 'burrow' && S && Number.isInteger(b.to)) {
    S.hole = b.to;
    if (b.facing === 1 || b.facing === -1) S.facing = b.facing;
    setOut(match, false);
    c.state.lastOut = false;
  }
  if (b.action === 'stunned' && S) S.stunned = false;   // 暈眩的回合過了（伺服器出招時就清掉了）
  if (b.shot) {
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
  if (dig) c.state.dig = null;
}

// 巨蠍被火光逼出來了：從地底升上來（照遊戲時間）、震動；玩家點燃的當下放橫幅，
// 新的一輪開始時（牠上一輪鑽進火把還亮著的洞）飄字就好（不蓋掉「你的回合」那一張橫幅）
function reveal(c, atRoundStart) {
  const S = c.match.mechState;
  const ax = holeX(S.def, S.hole);   // 照狀態的洞（鑽過去的那一刻，角色的位置要等這一招結算完才搬過去）
  c.state.rise = { k: 0 };
  const text = `${SCORPION_NAME}被火光逼出洞外，暈眩了！`;
  const e = PARTS.map(P => c.match.byId(P.id)).find(q => q && q.alive);
  if (atRoundStart && e) c.fx.float(e, '被火光逼出來了！暈眩', '#fde68a', 18);
  else c.fx.banner(text, '#fde68a');
  c.fx.shake(10);
  c.fx.sound('stomp', { x: ax });
  c.fx.particles(ax, S.def.ground - 6, 22, { speed: 200, life: 0.8, size: 3.5, color: '#a8a29e', gravity: 700 });
}

// 新的一輪：一陣強風（火把在 cave.js 的 update 照亮度熄掉、冒煙）
function gust(c) {
  c.state.wind = { t0: c.time };
  c.fx.shake(3);
}

// 部位被擊破：碎片、震動、裂開的聲音；三個都擊破 = 巨蠍倒下。回傳 true（不播一般的「被擊倒」橫幅）
function onPartBroken(c, e) {
  if (!isScorpionPart(e)) return false;
  const P = PARTS.find(q => q.id === e.id);
  c.fx.shake(12);
  c.fx.sound('crack', { x: e.cx });
  c.fx.particles(e.cx, e.cy, 28, { speed: 220, life: 0.9, size: 3.5, color: e.part === 'stinger' ? '#a3e635' : CHITIN_EDGE, gravity: 600 });
  const left = actionsPerTurn(c.match);
  if (left === 0) c.fx.banner(`${SCORPION_NAME}倒下了！`, '#c084fc');
  else c.fx.banner(`${P.short}被擊破！巨蠍每回合少動一次（剩 ${left} 次）`, '#c084fc');
  return true;
}

// ---------- 小工具 ----------

// 巨蠍現在畫在哪：洞口中間 ax、面向 f、地面 gy（照背甲的位置推回去：部位的位置跟著伺服器的角色狀態走，重連也對得上）
function anchorOf(c) {
  const S = c.match && c.match.mechState;
  const shell = c.match && c.match.byId(PARTS[0].id);
  if (!S || !S.def || !shell) return null;
  const f = shell.facing === 1 ? 1 : -1;
  return { ax: shell.x - f * BODY.shell.dx, f, gy: S.def.ground };
}

// 這一刻的姿勢：身體畫不畫（body：出洞了、或正在升上來 / 沉下去）、位置（鑽地時照動畫）、往下沉多少、往前衝多少、
// 鉗子張多開、尾巴往後拉多少；洞穴中間的雙眼（lurk = 亮度 0..1、lurkHole = 哪個洞）
function poseOf(c) {
  const A = anchorOf(c);
  if (!A) return null;
  const S = c.match.mechState;
  const pose = { ax: A.ax, f: A.f, gy: A.gy, sink: 0, lunge: 0, open: 0.25, pull: 0, shudder: 0,
    body: !!S.out, lurk: S.out ? 0 : 1, lurkHole: S.hole };
  const dig = c.state.dig;
  if (dig) {   // 前半：在原本的洞沉下去；後半：身體不見了，新的洞中間的雙眼慢慢亮起來
    if (dig.k < 0.5) {
      Object.assign(pose, { ax: dig.from.ax, f: dig.from.f, sink: SINK * dig.k * 2, body: true, lurk: 0 });
    } else {
      Object.assign(pose, { body: false, lurk: (dig.k - 0.5) * 2, lurkHole: dig.toHole });
    }
    return pose;
  }
  const rise = c.state.rise;
  if (rise) {   // 從地底升上來，洞穴中間的雙眼同時淡掉
    pose.body = true;
    pose.sink = SINK * (1 - rise.k);
    pose.lurk = Math.max(0, 1 - rise.k * 2);
  }
  const fx = c.state.fx;
  if (!fx) {
    pose.open = 0.25 + 0.1 * Math.sin(c.time * 2);
    return pose;
  }
  const cast = CONFIG.SCORPION.cast;
  const k = (d) => Math.min(1, fx.t / Math.max(0.05, d));
  if (fx.action === 'shock') pose.lunge = LUNGE * (fx.phase === 'act' ? 1 : k(cast.attack));
  if (fx.action === 'pinch' || fx.action === 'snap') pose.open = fx.phase === 'act' ? 0 : 0.25 + 0.75 * k(cast.attack);
  if (fx.action === 'sting') pose.pull = fx.phase === 'act' ? -0.4 : k(cast.attack);
  if (fx.action === 'quake') pose.shudder = fx.phase === 'act' ? 0 : Math.sin(fx.t * 70) * 2.5 * k(cast.attack);
  return pose;
}

// 地鳴 / 震擊周圍貼著地面跑過去揚起的碎石：每秒 30 顆（照遊戲時間）
function groundDebris(c, p) {
  const tick = Math.floor(c.time * 30);
  if (tick === p.debrisTick) return;
  p.debrisTick = tick;
  c.fx.particle({ x: p.x, y: p.y + (p.weapon.id === 'scorpionBurst' ? 16 : 2), vx: (Math.random() - 0.5) * 140, vy: -110 - Math.random() * 150,
    life: 0.5, maxLife: 0.5, size: 3, color: Math.random() < 0.5 ? '#a8a29e' : '#57534e', gravity: 700 });
}

// 尾巴的那條曲線（巨蠍自己的座標：往前 = +x、往上 = -y，原點在洞口中間的地面）：從身體後端翹起來、捲到背上方的毒針
function tailPoint(t, pull) {
  const P0 = { x: -62, y: -40 }, P1 = { x: -128 - pull * 12, y: -110 }, P2 = { x: -96 - pull * 22, y: -262 + pull * 10 };
  const P3 = { x: BODY.stinger.dx - pull * 16, y: -BODY.stinger.lift - BODY.stinger.h / 2 + pull * 6 };
  const u = 1 - t;
  return {
    x: u * u * u * P0.x + 3 * u * u * t * P1.x + 3 * u * t * t * P2.x + t * t * t * P3.x,
    y: u * u * u * P0.y + 3 * u * u * t * P1.y + 3 * u * t * t * P2.y + t * t * t * P3.y,
  };
}

// ---------- 繪圖 ----------

// 整隻巨蠍（出洞了才畫）：腳、尾巴、身體（背甲）、頭、鉗子、毒針；被擊破的部位畫成斷掉 / 裂開的，剛被打到的部位閃白。
// 鑽地 / 升上來時往下沉（地面以下的不畫）
function drawScorpion(ctx, c) {
  const pose = poseOf(c);
  if (!pose || !pose.body) return;
  const part = (k) => c.match.byId(PARTS.find(q => q.key === k).id);
  const shell = part('shell'), pincer = part('pincer'), stinger = part('stinger');
  const broken = (e) => !e || !e.alive;
  const hurt = (e) => !!e && e.alive && e.hurtTimer > 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, CONFIG.WORLD_W, pose.gy + 3);
  ctx.clip();
  ctx.translate(pose.ax + pose.f * pose.lunge + pose.shudder, pose.gy + pose.sink);
  ctx.scale(pose.f, 1);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 腳：每邊四隻（後面那排暗一點）
  for (const [row, color] of [[-1, CHITIN_DARK], [1, CHITIN_EDGE]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    for (let i = 0; i < 4; i++) {
      const x = -48 + i * 24 + row * 4;
      const step = Math.sin(c.time * 3 + i * 1.3) * 1.5;
      ctx.beginPath();
      ctx.moveTo(x, -22);
      ctx.lineTo(x - 12 - row * 2, -44 + step);
      ctx.lineTo(x - 24 - row * 3, 0);
      ctx.stroke();
    }
  }

  // 尾巴：一節一節越來越細、互相疊著，接到毒針（毒針擊破了就斷在倒數第三節）
  const segs = 15;
  const last = broken(stinger) ? segs - 3 : segs;
  for (let i = 0; i <= last; i++) {
    const t = i / segs;
    const q = tailPoint(t, pose.pull);
    const r = 19 - t * 8;
    ctx.fillStyle = hurt(stinger) && i >= segs - 3 ? '#ffffff' : (i % 2 ? CHITIN : CHITIN_DARK);
    ctx.strokeStyle = CHITIN_EDGE;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  if (broken(stinger)) {   // 斷掉的尾巴尖：參差的斷口，滴著綠色的毒
    const q = tailPoint(last / segs, pose.pull);
    ctx.fillStyle = FLESH;
    ctx.beginPath();
    ctx.moveTo(q.x - 9, q.y + 2); ctx.lineTo(q.x - 4, q.y - 8); ctx.lineTo(q.x + 1, q.y - 2); ctx.lineTo(q.x + 6, q.y - 9); ctx.lineTo(q.x + 10, q.y + 1);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(163,230,53,0.8)';
    ctx.beginPath(); ctx.arc(q.x + 2, q.y + 12 + (c.time * 30) % 18, 2.2, 0, Math.PI * 2); ctx.fill();
  } else {   // 毒針：鼓起來的毒囊 + 往前往下彎的一根尖刺
    const q = tailPoint(1, pose.pull);
    ctx.fillStyle = hurt(stinger) ? '#ffffff' : '#5b2b40';
    ctx.strokeStyle = '#8b4a5e';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(q.x, q.y, 15, 12, 0.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = hurt(stinger) ? '#ffffff' : '#c8b8a6';
    ctx.strokeStyle = '#57534e';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(q.x + 9, q.y - 4); ctx.quadraticCurveTo(q.x + 20, q.y + 2, q.x + 19, q.y + 19); ctx.quadraticCurveTo(q.x + 12, q.y + 8, q.x + 5, q.y + 7); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = `rgba(163,230,53,${0.6 + 0.3 * Math.sin(c.time * 5)})`;   // 針尖的毒
    ctx.beginPath(); ctx.arc(q.x + 19, q.y + 20, 2.6, 0, Math.PI * 2); ctx.fill();
  }

  // 身體（背甲）：一片片的甲殼；擊破了就裂開、露出底下的肉
  const B = BODY.shell, by = -B.h / 2 + B.lift;
  ctx.fillStyle = hurt(shell) ? '#ffffff' : broken(shell) ? CHITIN_DARK : CHITIN;
  ctx.strokeStyle = CHITIN_EDGE;
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(B.dx, by, B.hw, B.h / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(15,6,10,0.7)';
  ctx.lineWidth = 2;
  for (let i = -2; i <= 2; i++) {   // 甲殼的接縫
    const x = B.dx + i * 24;
    ctx.beginPath(); ctx.moveTo(x, by - B.h / 2 * Math.sqrt(1 - (i * 24 / B.hw) ** 2) + 2); ctx.quadraticCurveTo(x + 6, by, x, by + B.h / 2 - 4); ctx.stroke();
  }
  if (broken(shell)) {
    ctx.fillStyle = FLESH;
    for (const [x, y] of [[-30, -36], [6, -42], [34, -30]]) {
      ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x - 2, y - 7); ctx.lineTo(x + 3, y - 1); ctx.lineTo(x + 9, y - 6); ctx.lineTo(x + 7, y + 5); ctx.lineTo(x - 6, y + 6); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = '#120a0e';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-50, -20); ctx.lineTo(-30, -36); ctx.lineTo(-12, -24); ctx.lineTo(6, -42); ctx.lineTo(20, -26); ctx.lineTo(34, -30); ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.07)';   // 甲殼的亮面
    ctx.beginPath(); ctx.ellipse(B.dx - 6, by - 12, B.hw * 0.7, 8, 0, 0, Math.PI * 2); ctx.fill();
  }

  // 頭
  ctx.fillStyle = hurt(shell) ? '#ffffff' : CHITIN;
  ctx.strokeStyle = CHITIN_EDGE;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(58, -26, 24, 20, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // 鉗子：後面那隻暗一點、高一點；擊破了就只剩斷掉的手臂
  const P = BODY.pincer;
  const PINCER_EDGE = '#8b4a5e';
  for (const [back, dy] of [[true, -16], [false, 0]]) {
    const color = hurt(pincer) ? '#ffffff' : back ? CHITIN_DARK : '#4a2a3a';
    const arm = () => { ctx.beginPath(); ctx.moveTo(66, -22 + dy); ctx.quadraticCurveTo(76, -48 + dy, 88, -30 + dy); ctx.stroke(); };
    ctx.strokeStyle = PINCER_EDGE;   // 手臂：先畫一圈邊再畫裡面
    ctx.lineWidth = 13;
    arm();
    ctx.strokeStyle = color;
    ctx.lineWidth = 9;
    arm();
    if (broken(pincer)) {   // 斷掉的手臂：參差的斷口
      ctx.fillStyle = FLESH;
      ctx.beginPath(); ctx.moveTo(83, -37 + dy); ctx.lineTo(93, -33 + dy); ctx.lineTo(88, -29 + dy); ctx.lineTo(94, -24 + dy); ctx.lineTo(84, -24 + dy); ctx.closePath(); ctx.fill();
      continue;
    }
    const tip = P.dx + P.hw, open = pose.open * 12;
    ctx.fillStyle = color;
    ctx.strokeStyle = PINCER_EDGE;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(91, -27 + dy, 15, 12, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();   // 鉗子的掌
    ctx.beginPath();   // 上顎（比較大、彎下來）
    ctx.moveTo(96, -38 + dy); ctx.quadraticCurveTo(tip, -42 + dy - open, tip + 2, -26 + dy - open * 0.5); ctx.quadraticCurveTo(tip - 8, -30 + dy - open * 0.5, 100, -27 + dy); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath();   // 下顎
    ctx.moveTo(98, -16 + dy); ctx.quadraticCurveTo(tip - 4, -12 + dy + open, tip - 2, -23 + dy + open * 0.5); ctx.quadraticCurveTo(tip - 10, -21 + dy + open * 0.5, 100, -24 + dy); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();

  // 部位的小血條（出洞站好才畫；暗的地方看不到，照得到才看得到；右上的名單一直都有血量）
  if (pose.sink === 0 && !c.state.dig) {
    for (const e of [pincer, shell, stinger]) {
      if (!e || !e.alive) continue;
      const w = 40, x = e.cx - w / 2, y = e.y - e.h - 10;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x, y, w, 4);
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(x, y, w * Math.max(0, e.hp) / Math.max(1, e.maxHp), 4);
    }
  }
}

// 發紅的雙眼（畫在遮光上面）：出洞時在頭上，躲著時在洞穴中間（暗的地方也看得到牠在哪個洞）。
// 站在陰影裡（傷害加成）時紅光更大、會呼吸；出招時更亮
function drawEyes(ctx, c) {
  if (actionsPerTurn(c.match) === 0) return;
  const pose = poseOf(c);
  if (!pose) return;
  const shell = c.match.byId(PARTS[0].id);
  const dark = shell ? inShadow(c.match, shell.cx, shell.cy) : true;
  const casting = !!c.state.fx;
  const eye = (x, y, alpha) => {
    const r = (dark ? 15 : 9) + (casting ? 5 : 0) + Math.sin(c.time * (dark ? 4 : 2)) * 2;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(254,202,202,${(casting ? 0.8 : 0.6) * alpha})`);
    g.addColorStop(0.4, `rgba(239,68,68,${(dark ? 0.4 : 0.25) * alpha})`);
    g.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(252,165,165,${alpha})`;
    ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
  };
  if (pose.body) {   // 頭上的眼睛（沉到地面下的不畫）
    const x0 = pose.ax + pose.f * pose.lunge;
    for (const [dx, dy] of [[64, -36], [73, -33]]) {
      const y = pose.gy + dy + pose.sink;
      if (y <= pose.gy - 4) eye(x0 + pose.f * dx, y, 1);
    }
  }
  if (pose.lurk > 0) {   // 躲著：洞穴中間一對眼睛，看著玩家那邊
    const p = lurkPoint(c.match.mechState.def, pose.lurkHole);
    const look = pose.f * 3;
    eye(p.x - EYE_GAP / 2 + look, p.y, pose.lurk);
    eye(p.x + EYE_GAP / 2 + look, p.y - 1, pose.lurk);
  }
}

// 火把亮著的洞整個照亮（遮光的暫存畫布上照洞口的形狀挖掉；亮度跟著那支火把畫面上的光圈變大 / 變暗 / 熄掉）
// 暈眩中（單人被火光逼出來）：頭上一圈轉來轉去的星星（畫在遮光上面，暗的地方也看得到）
function drawStun(ctx, c) {
  const S = c.match.mechState;
  if (!S || !S.stunned || !S.out || actionsPerTurn(c.match) === 0) return;
  const pose = poseOf(c);
  if (!pose || !pose.body) return;
  const cx = pose.ax + pose.f * 58, cy = pose.gy - 62 + pose.sink;
  if (cy > pose.gy - 20) return;
  ctx.save();
  for (let i = 0; i < 4; i++) {
    const a = c.time * 3 + i * Math.PI / 2;
    const x = cx + Math.cos(a) * 22, y = cy + Math.sin(a) * 7;
    ctx.fillStyle = `rgba(253,230,138,${0.65 + 0.35 * Math.sin(a)})`;
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {   // 五角星
      const r = k % 2 ? 2.4 : 5.5, t = -Math.PI / 2 + k * Math.PI / 5;
      if (k) ctx.lineTo(x + Math.cos(t) * r, y + Math.sin(t) * r); else ctx.moveTo(x + Math.cos(t) * r, y + Math.sin(t) * r);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// 強風的字幕：新的一輪開始時在橫幅下面一點淡入、停一下、淡出（不蓋到「你的回合」那一行，也不擋中下段的戰場）
function drawWindCaption(ctx, c) {
  const w = c.state.wind;
  if (!w) return;
  const t = c.time - w.t0;
  if (t < 0 || t > WIND.time) return;
  const a = Math.min(1, t / 0.3, (WIND.time - t) / 0.6);
  ctx.save();
  ctx.globalAlpha = Math.max(0, a);
  text(ctx, WIND.text, CONFIG.WORLD_W / 2, WIND.y, { size: 22, bold: true, align: 'center', color: '#e7e5e4', outline: 'rgba(0,0,0,0.85)', outlineWidth: 5 });
  ctx.restore();
}

function lightHoles(g, c) {
  const S = c.match.mechState;
  const burrows = c.match.level.decor && c.match.level.decor.burrows;
  if (!S || !burrows) return;
  S.def.holes.forEach((h, i) => {
    const t = S.def.torches[h.torch];
    if (!t || !burrows[i]) return;
    const full = torchLight(t, CONFIG.CAVE.torchRounds).r;
    const glow = c.state.glow.has(h.torch) ? c.state.glow.get(h.torch) : torchLight(t, torchLevel(c.match, h.torch)).r;
    const k = full > 0 ? Math.min(1, glow / full) : 0;
    if (k < 0.02) return;
    const b = burrows[i];
    const grad = g.createLinearGradient(0, b.top, 0, b.bottom);
    grad.addColorStop(0, `rgba(0,0,0,${0.7 * k})`);
    grad.addColorStop(1, `rgba(0,0,0,${0.95 * k})`);
    g.fillStyle = grad;
    archPath(g, b);
    g.fill();
  });
}

// 震擊周圍：貼著地面往外翻滾的一團塵土
function drawBurst(ctx, p) {
  for (let i = 0; i < p.trail.length; i += 2) {
    const t = p.trail[i], k = i / p.trail.length;
    ctx.fillStyle = `rgba(120,113,108,${k * 0.35})`;
    ctx.beginPath(); ctx.arc(t.x, t.y + 6, 6 + k * 12, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(168,162,158,0.85)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 20, 16, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(87,83,78,0.9)';
  for (const [dx, dy, r] of [[-8, 10, 5], [7, 6, 4], [0, -4, 4]]) { ctx.beginPath(); ctx.arc(p.x + dx, p.y + dy, r, 0, Math.PI * 2); ctx.fill(); }
}

// 巨鉗夾擊：一隻張開的鉗子順著飛的方向衝過去
function drawFlyingClaw(ctx, p) {
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(Math.atan2(p.vy, p.vx));
  ctx.strokeStyle = 'rgba(59,34,48,0.5)';
  ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(-40, 0); ctx.lineTo(-10, 0); ctx.stroke();   // 伸出去的手臂（殘影）
  ctx.fillStyle = CHITIN;
  ctx.strokeStyle = CHITIN_EDGE;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(-6, 0, 11, 9, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -6); ctx.quadraticCurveTo(14, -14, 18, -3); ctx.lineTo(4, -2); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 6); ctx.quadraticCurveTo(14, 14, 18, 3); ctx.lineTo(4, 2); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

// 甲殼地鳴：一圈圈往前推的震波（貼著地面）
function drawQuake(ctx, p) {
  for (let i = 0; i < p.trail.length; i += 3) {
    const t = p.trail[i], k = i / p.trail.length;
    ctx.strokeStyle = `rgba(214,211,209,${k * 0.6})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(t.x, t.y + 4, 10 + (1 - k) * 16, 6 + (1 - k) * 8, 0, Math.PI, 0); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(231,229,228,0.85)';
  ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 14, 10, 0, Math.PI, 0); ctx.fill();
}

// 毒刺：一根細長的針，後面拖著綠色的毒
function drawNeedle(ctx, p) {
  for (let i = 0; i < p.trail.length; i += 2) {
    const t = p.trail[i], k = i / p.trail.length;
    ctx.fillStyle = `rgba(132,204,22,${k * 0.4})`;
    ctx.beginPath(); ctx.arc(t.x, t.y, 1.5 + k * 2.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(Math.atan2(p.vy, p.vx));
  ctx.fillStyle = '#d6d3d1';
  ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-12, -3); ctx.lineTo(-12, 3); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#84cc16';
  ctx.beginPath(); ctx.arc(10, 0, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}
