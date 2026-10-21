import { CONFIG } from '../../shared/core/config.js';
import {
  EXEC_ACTION_NAMES as N, EXEC_NAME, BEASTS, NUMERALS, isBeast, prisonState, bossOf, setUp, spawnBeast, spawnCage, syncCage,
  cageRoundsLeft, handOf, pounceTarget, restorePrison, bladeDrop,
} from '../../shared/maps/prison.js';

// Boss 關「處刑監獄」的地圖畫面：處刑官與三隻猛獸回合的動畫（照伺服器廣播的招式播）、處刑官 / 猛獸 / 囚籠 / 斷頭台 / 吊燈的畫法、
// 牢房（欄杆、牢門打開、還關著的猛獸）、柱子上的火把、劍齒虎標記的獵物、被吊燈砸暈的星星、HUD 上的下一招。
// 規則在 shared/maps/prison.js；掛勾的說明見 index.js。整回合播完照伺服器帶來的狀態（msg.boss.state）對齊
const FPS = 60;
const OUT = 'rgba(0,0,0,0.55)';
const LUNGES = { bite: 'wolfBite', swipe: 'bearSwipe', pounce: 'tigerPounce' };
const ART_H = { executioner: 96, wolf: 40, bear: 60, tiger: 42 };   // 畫法的原始身高：照角色的身高 h 等比縮放
const BEAST_ART = { wolf: drawWolf, bear: drawBear, tiger: drawTiger };
const GLOW = { wolf: 'rgba(239,68,68,A)', bear: 'rgba(239,68,68,A)', tiger: 'rgba(190,242,100,A)' };
const TORCH_Y = 340;   // 柱子上火把的高度（只是裝飾）

export const prison = {
  type: 'prison',

  // 這一場的畫面狀態：
  //   fx         現在這一招的預兆 { action, t, cast, step, actorId, phase }（回合播完就清掉）
  //   running    正在撲過去的猛獸 id（飛行物就是牠，見 drawProjectile），角色本身先不畫
  //   doors      三間牢門打開了幾成（0 ~ 1，牢房開了就慢慢打開）
  //   cageDrop   正在從天而降的囚籠（出生資料 + k = 掉到幾成）
  //   guillotine 處刑時出現的斷頭台 { x, y, rise, dropped }；chain = 從王手上射出去的鎖鏈 { x0, y0, x1, y1, k }；whip = 皮鞭 { x0, y0, x1, y1, k }
  create: () => ({ fx: null, running: null, doors: [0, 0, 0], cageDrop: null, guillotine: null, chain: null, whip: null }),

  musicTrack: () => 'scorpion',   // 先借用巨蠍的 Boss 曲（陰暗、偷偷摸摸的）；之後可以換專屬的

  turnScript: prisonTurnScript,
  abortScript(c) {
    Object.assign(c.state, { fx: null, running: null, cageDrop: null, guillotine: null, chain: null, whip: null });
  },
  onDeath: onPrisonDeath,

  // 每一步：囚籠被打破 / 被關的人倒下 → 放出來（跟伺服器的 cascade 同一個條件）；牢門照開了幾間慢慢打開
  update(c, dt) {
    syncCage(c.match);
    const S = prisonState(c.match);
    if (!S) return;
    for (let k = 0; k < c.state.doors.length; k++) {
      if (k < S.released) c.state.doors[k] = Math.min(1, c.state.doors[k] + dt * 2.5);
    }
  },

  // 吊燈砸下來：鐵件與燭火四濺、畫面一震；砸暈的人飄字。撲到人、菜刀 / 流星錘 / 鍘刀打到人的特效
  showEvent(c, ev) {
    const p = c.projectiles.find(q => q.i === ev.p);
    const id = p && p.weapon && p.weapon.id;
    if (id === 'chandelier' && ev.type !== 'pass') {
      c.fx.shake(7);
      c.fx.sound('crack', { x: ev.x });
      c.fx.particles(ev.x, ev.y - 6, 16, { speed: 200, life: 0.6, size: 3, color: '#71717a', gravity: 700 });
      c.fx.particles(ev.x, ev.y - 10, 10, { speed: 140, life: 0.5, size: 2.5, color: '#fbbf24', gravity: 300 });
    }
    for (const sid of ev.stuns || []) {
      const e = c.match.byId(sid);
      if (e) c.fx.float(e, '暈眩！', '#fde68a', 16);
    }
    if (!ev.target) return;
    if (id === 'execFlail') { c.fx.shake(9); c.fx.sound('thunk', { x: ev.x }); }
    else if (id === 'execBlade') {
      c.fx.shake(14);
      c.fx.sound('crack', { x: ev.x });
      c.fx.particles(ev.x, ev.y, 14, { speed: 160, life: 0.5, size: 3, color: '#e2e8f0', gravity: 400 });
    } else if (id === 'execCleaver') c.fx.particles(ev.x, ev.y, 8, { speed: 140, life: 0.4, size: 2.5, color: '#cbd5e1', gravity: 400 });
    else if (id === 'bearSwipe') { c.fx.shake(10); c.fx.sound('stomp', { x: ev.x }); }
    else if (id === 'wolfBite' || id === 'tigerPounce') { c.fx.shake(6); c.fx.sound('stab', { x: ev.x }); }
  },

  // 處刑官的血量停在門檻（等輪到他跳上處刑台）：多打的不算，飄「鎖血」
  showDamage(c, e, d) {
    if (e.kind !== 'executioner' || d.dmg > 0 || d.blocked || d.friendly || !e.alive) return false;
    c.fx.float(e, '鎖血', '#9ca3af', 15);
    return true;
  },

  // 撲過去的猛獸（飛行物畫成牠）、跳上 / 跳下處刑台的處刑官（自己照弧線畫）：一般的身體、血條、名字都不畫
  drawEntityBare(ctx, c, e) {
    if (c.state.running && e.id === c.state.running) return true;
    const air = jumpAt(c, e);
    if (!air) return false;
    drawExecutioner(ctx, air.x, air.y, e.facing, c.time, e.h / ART_H.executioner, poseOf(c, e), false);
    return true;
  },

  drawEntity(ctx, c, e, hurt) {
    if (e.kind === 'executioner') {
      drawExecutioner(ctx, e.x, e.y, e.facing, c.time, e.h / ART_H.executioner, poseOf(c, e), hurt);
      return 'body';
    }
    if (isBeast(e)) {
      const S = prisonState(c.match);
      BEAST_ART[e.kind](ctx, e.x, e.y, e.facing, c.time + e.x * 0.01, e.h / ART_H[e.kind], { guard: !!(S && S.guard === e.id), whip: !!(S && S.whip === e.id) }, hurt);
      return 'body';
    }
    if (e.kind === 'cage') {
      drawCage(ctx, c, e, hurt);
      return 'whole';
    }
    return false;
  },

  hpBar: (c, e) => (e.kind === 'executioner' ? { w: 100, h: 8 } : isBeast(e) ? { w: 64, h: 6 } : null),

  drawProjectile(ctx, c, p) {
    const id = p.weapon.id;
    if (id === 'execCleaver') { drawCleaver(ctx, p.x, p.y, p.spin * 2.2); return true; }
    if (id === 'execFlail') { drawFlailShot(ctx, c, p); return true; }
    if (id === 'execBlade') { drawBlade(ctx, p.x, p.y + 4); return true; }
    if (id === 'chandelier') { drawFallingChandelier(ctx, c, p); return true; }
    const kind = Object.keys(LUNGES).find(k => LUNGES[k] === id);
    if (kind) {
      const e = c.match.byId(c.state.running);
      if (e && isBeast(e)) BEAST_ART[e.kind](ctx, p.x, p.y + e.h / 2, p.vx >= 0 ? 1 : -1, c.time, e.h / ART_H[e.kind], { leap: true }, false);
      return true;
    }
    return false;
  },

  // 地形之後、角色之前：火把、牢房（還關著的猛獸 + 欄杆 + 牢門）、吊燈、斷頭台、從天而降的囚籠、皮鞭 / 鎖鏈、劍齒虎標記的獵物、暈眩的星星
  drawScene(ctx, c) {
    const match = c.match;
    const S = prisonState(match);
    const decor = match.level.decor || {};
    for (const x of decor.pillars || []) drawTorch(ctx, x, TORCH_Y, c.time);
    (decor.cells || []).forEach((cell, k) => drawCellFront(ctx, c, cell, k, S));
    drawChandeliers(ctx, c);
    if (c.state.guillotine) drawGuillotine(ctx, c);
    if (c.state.cageDrop) drawCageShape(ctx, c.state.cageDrop.x, c.state.cageDrop.y - (1 - c.state.cageDrop.k) * 260, c.state.cageDrop.hw, c.state.cageDrop.h, c.time, false);
    if (c.state.whip) drawLash(ctx, c.state.whip, '#5b3a1e', 2.5, true);
    if (c.state.chain) drawLash(ctx, c.state.chain, '#6b7280', 3, false);
    drawTigerMark(ctx, c);
    if (S) for (const id of S.stuns) { const e = match.byId(id); if (e && e.alive) drawStars(ctx, e.x, e.y - e.h - 30, c.time); }
    for (const x of decor.pillars || []) drawTorchGlow(ctx, x, TORCH_Y, c.time);
  },

  // 一般那一行（敵人剩餘）+ 處刑官的血量、下一招、放出來的猛獸要做什麼、囚籠還剩幾回合
  hud(c, line) {
    const lines = [line];
    const match = c.match;
    const S = prisonState(match);
    const boss = bossOf(match);
    if (!S || !boss || !boss.alive) return lines;
    const tag = S.up ? '（在處刑台上，打不到）' : S.mood === 'cry' ? `（哭泣中，受傷 +${CONFIG.EXECUTIONER.cryDamagePct}%）` : S.mood === 'rage' ? '（暴怒）' : '';
    const e = boss;
    lines.push([`${EXEC_NAME} ${e.hp} / ${e.maxHp}${tag}`, '#fca5a5']);
    const nx = S.next;
    if (nx && nx.action) {
      const who = nx.targetId ? match.byId(nx.targetId) : null;
      const name = nx.action === 'cry' ? '哭泣' : N[nx.action] || nx.action;
      lines.push([`下一招：${name}${who ? ` → ${who.name}` : ''}`, nx.action === 'execute' ? '#f87171' : '#fdba74']);
    }
    const b = match.enemies.find(e => isBeast(e) && e.alive);
    if (b) {
      const plan = S.beastNext[b.id] || {};
      const t = b.kind === 'tiger' ? pounceTarget(match, plan) : null;
      const what = b.kind === 'wolf' ? '撕咬（先咬流血的人）' : b.kind === 'tiger' ? `飛撲${t ? ` → ${t.name}` : ''}` : N[plan.action] || '';
      lines.push([`${b.name}：${what}${S.whip === b.id ? '（攻擊 +30%）' : ''}`, '#fde68a']);
    }
    const left = cageRoundsLeft(match);
    if (left !== null && S.cage) {
      const p = match.byId(S.cage.prisonerId);
      lines.push([`囚籠：${p ? p.name : ''}（${left > 0 ? `還有 ${left} 回合` : '要處刑了'}）`, '#f87171']);
    }
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 處刑官 / 猛獸的回合：一招一招照順序播（預兆 → 出招（照 shotScript 重播）→ 校正成伺服器結果），全部播完照伺服器帶來的狀態對齊
function* prisonTurnScript(c, msg) {
  const match = c.match;
  const actor = match.byId(msg.actorId);
  const S = prisonState(match);
  if (S && actor && S.guard === actor.id) S.guard = null;   // 上一回合的護主到這裡為止（跟伺服器一樣）
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* stepScript(c, actor, step);
  Object.assign(c.state, { fx: null, guillotine: null, chain: null, whip: null, cageDrop: null });
  if (S && msg.boss.state) restorePrison(match, { prison: msg.boss.state });
}

const ease = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const lerp = (a, b, k) => a + (b - a) * k;

function* stepScript(c, actor, b) {
  const match = c.match;
  const S = prisonState(match);
  const cast = Math.max(1, Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS));
  const fx = c.state.fx = { action: b.action, t: 0, cast: cast / FPS, step: b, actorId: actor ? actor.id : null, phase: 'cast' };
  announce(c, actor, b);
  if (S && b.action === 'stunned' && actor) { const i = S.stuns.indexOf(actor.id); if (i >= 0) S.stuns.splice(i, 1); }
  if (S && b.action === 'cry') S.cryLeft = Math.max(0, S.cryLeft - 1);
  if (S && b.action === 'rage') S.mood = 'rage';
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    castFrame(c, actor, b, i, cast);
    yield { frames: 1 };
  }
  fx.phase = 'act';
  if (b.action === 'execute') placePrisoner(c, b);
  if (b.shot && LUNGES[b.action]) yield* lungeScript(c, actor, b);
  else if (b.shot) {
    yield* c.shotScript(b.shot);
    if (b.action === 'execute' && c.state.guillotine) c.state.guillotine.dropped = true;
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: Math.round(CONFIG.TIMING.settleDelay * FPS * 0.5) };
  }
  if (S && actor && LUNGES[b.action] && S.whip === actor.id) S.whip = null;   // 鞭出來的加成用掉了
}

// 招式的橫幅
function announce(c, actor, b) {
  const match = c.match;
  const target = b.targetId ? match.byId(b.targetId) : null;
  const to = target ? ` → ${target.name}` : '';
  const who = actor ? actor.name : '';
  switch (b.action) {
    case 'release': {
      const B = BEASTS[b.cell];
      c.fx.banner(`${EXEC_NAME}跳上處刑台！牢房 ${NUMERALS[b.cell]} 打開了：${B ? B.name : ''}！`, '#f87171');
      break;
    }
    case 'descend': c.fx.banner(`${EXEC_NAME}跳下處刑台`, '#fdba74'); break;
    case 'cry': c.fx.banner(`${EXEC_NAME}：嗚嗚……我的寶貝們都死了……`, '#93c5fd'); break;
    case 'rage': c.fx.banner(`${EXEC_NAME}暴怒了！拿出流星錘！`, '#ef4444'); break;
    case 'execute': c.fx.banner(`${EXEC_NAME}：${N.execute}${to}！`, '#ef4444'); break;
    case 'stunned': c.fx.banner(`${who}被吊燈砸暈了！`, '#fde68a'); break;
    case 'guard': c.fx.banner(`${who}：${N.guard}！`, '#fde68a'); break;
    case 'idle': c.fx.banner(`${who}${N.idle}中`, '#e9d5ff'); break;
    case 'pounce': {
      const marked = b.markedId ? match.byId(b.markedId) : null;
      c.fx.banner(`${who}：${N.pounce}${to}！${marked ? `（替 ${marked.name} 擋下）` : ''}`, '#fdba74');
      break;
    }
    default: c.fx.banner(`${who}：${N[b.action] || b.action}${to}！`, '#fca5a5');
  }
}

// 預兆每一幀：跳躍、牢門打開放出猛獸、哭、暴怒、皮鞭、囚籠落下、斷頭台與鎖鏈、熊走過去……
function castFrame(c, actor, b, i, cast) {
  const match = c.match;
  const S = prisonState(match);
  const k = i / cast;
  const at = (q) => i === Math.round(cast * q);
  switch (b.action) {
    case 'release': {
      if (i === 0) c.fx.sound('heave', { x: b.x0 });
      if (at(JUMP.release[1]) && actor) {   // 落在處刑台上
        actor.x = b.x; actor.y = b.y; actor.vx = 0; actor.vy = 0;
        setUp(match, true);
        c.fx.shake(8);
        c.fx.sound('stomp', { x: b.x });
        c.fx.particles(b.x, b.y - 2, 14, { speed: 150, life: 0.5, size: 3, color: '#a8a29e', gravity: 600 });
      }
      if (at(0.66)) {   // 牢門打開、猛獸衝出來
        for (const spec of b.spawns || []) {
          const e = match.byId(spec.id) || spawnBeast(match, spec);
          c.fx.particles(e.x, e.y - 10, 18, { speed: 160, life: 0.6, size: 3.5, color: '#78716c', gravity: 500 });
          c.fx.float(e, `${e.name}！`, '#fca5a5', 18);
          c.fx.sound('roar', { x: e.x });
          c.fx.shake(6);
        }
        if (S) S.released = Math.max(S.released, b.cell + 1);
      }
      break;
    }
    case 'descend': {
      if (i === 0) c.fx.sound('heave', { x: b.x0 });
      if (at(JUMP.descend[1]) && actor) {
        actor.x = b.x; actor.y = b.y; actor.vx = 0; actor.vy = 0;
        setUp(match, false);
        if (S && S.released >= BEASTS.length) { S.mood = 'cry'; S.cryLeft = CONFIG.EXECUTIONER.cryTurns; }
        c.fx.shake(10);
        c.fx.sound('stomp', { x: b.x });
        c.fx.particles(b.x, b.y - 2, 18, { speed: 170, life: 0.6, size: 3.5, color: '#a8a29e', gravity: 600 });
      }
      break;
    }
    case 'cry':
      if (actor && i % 7 === 0) {   // 眼洞流下來的眼淚
        const s = actor.h / ART_H.executioner;
        for (const ex of [6, 13]) {
          c.fx.particle({ x: actor.x + actor.facing * ex * s, y: actor.y - 76 * s, vx: actor.facing * (10 + Math.random() * 20), vy: -20, life: 0.7, maxLife: 0.7, size: 2.5, color: '#93c5fd', gravity: 500 });
        }
      }
      break;
    case 'rage':
      if (i % 10 === 0) c.fx.shake(5);
      if (i === 0 && actor) c.fx.sound('roar', { x: actor.x });
      if (actor && i % 4 === 0) c.fx.particle({ x: actor.x + (Math.random() - 0.5) * 50, y: actor.y - Math.random() * actor.h, vx: 0, vy: -60, life: 0.6, maxLife: 0.6, size: 3, color: '#ef4444', gravity: -40 });
      break;
    case 'cleaver': case 'flail':
      if (at(0.7) && actor) c.fx.sound('heave', { x: actor.x });
      break;
    case 'whip': {
      const beast = match.byId(b.targetId);
      if (!actor || !beast) break;
      const h = handOf(actor);
      c.state.whip = k >= 0.4 && k < 0.8 ? { x0: h.x, y0: h.y, x1: beast.x, y1: beast.cy, k: ease((k - 0.4) / 0.25) } : null;
      if (at(0.62)) {
        c.fx.sound('crack', { x: beast.x });
        c.fx.float(beast, `-${b.dmg}`, '#ffd166');
        c.fx.float(beast, `攻擊 +${CONFIG.EXECUTIONER.whipPct}%`, '#f87171', 16);
        c.fx.particles(beast.x, beast.cy, 8, { speed: 120, life: 0.4, size: 2.5, color: '#dc2626', gravity: 400 });
        if (S) S.whip = beast.id;
      }
      break;
    }
    case 'cage': {
      const spec = (b.spawns || [])[0];
      if (!spec) break;
      c.state.cageDrop = k < 0.7 ? { ...spec, k: ease(k / 0.7) } : null;
      if (at(0.7)) {
        if (!match.byId(spec.id)) spawnCage(match, spec);
        c.fx.shake(7);
        c.fx.sound('thunk', { x: spec.x });
        c.fx.particles(spec.x, spec.y - 2, 12, { speed: 140, life: 0.5, size: 3, color: '#a8a29e', gravity: 600 });
      }
      break;
    }
    case 'execute': executeFrame(c, actor, b, k, at); break;
    case 'guard':
      if (actor && k >= 0.15 && k <= 0.8) {   // 慢慢走到囚籠前面
        actor.x = lerp(b.x0, b.x, ease((k - 0.15) / 0.65));
        actor.y = lerp(b.y0, b.y, ease((k - 0.15) / 0.65));
        if (i % 12 === 0) c.fx.sound('step', { x: actor.x });
      }
      if (at(0.82) && actor) { actor.x = b.x; actor.y = b.y; c.fx.sound('roar', { x: actor.x }); if (S) S.guard = actor.id; }
      break;
    case 'bite': case 'swipe': case 'pounce':
      if (i === 0 && actor) c.fx.sound(actor.kind === 'bear' ? 'roar' : 'heave', { x: actor.x });
      break;
    default:
  }
}

// 處刑：斷頭台從地底冒出來（法陣）→ 鎖鏈射向囚籠 → 籠子被扯開、人被拖到斷頭台下 → 鍘刀落下（出招的 shotScript）
function executeFrame(c, actor, b, k, at) {
  const match = c.match;
  const S = prisonState(match);
  const G = S ? S.def.guillotine : { x: b.x, y: b.y };
  const p = match.byId(b.targetId);
  const g = c.state.guillotine || (c.state.guillotine = { x: G.x, y: G.y, rise: 0, dropped: false });
  g.rise = ease(k / 0.25);
  if (at(0) || at(0.12)) c.fx.sound('stomp', { x: G.x });
  if (!actor || !p) return;
  const h = handOf(actor);
  if (k >= 0.25 && k < 0.45) {
    const sx = lerp(b.x0, b.x, 0), sy = b.y0 - p.h / 2;
    c.state.chain = { x0: h.x, y0: h.y, x1: sx, y1: sy, k: ease((k - 0.25) / 0.2) };
  }
  if (at(0.45)) {   // 鎖鏈扯開籠子
    const cage = S && S.cage ? match.byId(S.cage.id) : null;
    if (cage && cage.alive) {
      c.fx.particles(cage.x, cage.cy, 14, { speed: 180, life: 0.6, size: 3, color: '#6b7280', gravity: 600 });
      cage.die('open');
    }
    if (S) S.cage = null;
    syncCage(match);
    c.fx.sound('crack', { x: p.x });
  }
  if (k >= 0.45 && k < 0.85) {   // 拖過去（腳離地一點）
    const q = ease((k - 0.45) / 0.4);
    p.x = lerp(b.x0, b.x, q);
    p.y = lerp(b.y0, b.y, q) - Math.sin(q * Math.PI) * 16;
    p.vx = 0; p.vy = 0;
    c.state.chain = { x0: h.x, y0: h.y, x1: p.x, y1: p.cy, k: 1 };
  }
  if (k >= 0.85) c.state.chain = null;
}

// 鍘刀落下之前：被處刑的人擺在斷頭台下（跟伺服器結算前一樣）
function placePrisoner(c, b) {
  const p = c.match.byId(b.targetId);
  if (!p) return;
  p.x = b.x; p.y = b.y; p.vx = 0; p.vy = 0; p.onGround = true; p.moveDir = 0;
  c.state.chain = null;
}

// 撲過去的那段：飛行物畫成猛獸，角色本身先不畫（running）。飛行物一消失就放到伺服器算好的位置、畫回來
function* lungeScript(c, e, b) {
  const own = e ? b.shot.results.find(s => s.id === e.id) : null;
  let seen = false;
  const frame = (live) => {
    if (!e) return;
    if (live.some(p => p.weapon.id === b.shot.weapon)) { seen = true; c.state.running = e.id; }
    else if (seen && c.state.running) {
      c.state.running = null;
      if (own) { e.x = own.x; e.y = own.y; e.vx = 0; e.vy = 0; e.facing = own.facing; }
    }
  };
  try {
    yield* c.shotScript(b.shot, { frame });
  } finally {
    c.state.running = null;
  }
}

// 跳上 / 跳下處刑台的時間（播到幾成起跳、幾成落地）
const JUMP = { release: [0.12, 0.5], descend: [0.1, 0.72] };

// 處刑官跳在半空中的位置（預兆裡、起跳到落地之間，沿弧線）；不在空中回傳 null
function jumpAt(c, e) {
  const fx = c.state.fx;
  if (!fx || fx.phase !== 'cast' || fx.actorId !== e.id || !JUMP[fx.action]) return null;
  const [a, z] = JUMP[fx.action];
  const k = fx.t / fx.cast;
  if (k < a || k >= z) return null;
  const b = fx.step;
  const q = (k - a) / (z - a);
  const top = Math.min(b.y0, b.y) - 90;
  const x = lerp(b.x0, b.x, q);
  const base = lerp(b.y0, b.y, q);
  return { x, y: base - (Math.min(b.y0, b.y) - top) * 4 * q * (1 - q) };
}

// 處刑官現在的樣子：坐在地上哭、暴怒（紅眼、手上的流星錘）、出招的起手
function poseOf(c, e) {
  const S = prisonState(c.match);
  const fx = c.state.fx;
  const mine = fx && fx.actorId === e.id && fx.phase === 'cast';
  const sit = !!(S && S.mood === 'cry') && !(mine && fx.action === 'rage' && fx.t / fx.cast > 0.3);
  return {
    sit,
    rage: !!(S && S.mood === 'rage') || !!(mine && fx.action === 'rage'),
    windup: mine && (fx.action === 'cleaver' || fx.action === 'flail') ? Math.min(1, fx.t / fx.cast / 0.7) : 0,
    crouch: mine && JUMP[fx.action] && fx.t / fx.cast < JUMP[fx.action][0] ? 1 : 0,
  };
}

// 倒下：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
function onPrisonDeath(c, e) {
  if (e.kind === 'executioner') {
    c.fx.banner(`${EXEC_NAME}倒下了！`, '#f87171');
    c.fx.shake(14);
    c.fx.sound('stomp', { x: e.x });
    c.fx.particles(e.x, e.cy, 28, { speed: 200, life: 1.1, size: 4, color: '#18161a', gravity: 450 });
    c.fx.particles(e.x, e.cy - 10, 14, { speed: 140, life: 1.2, size: 3.5, color: '#7f1d1d', gravity: 300 });
    return true;
  }
  if (isBeast(e)) {
    c.fx.banner(`${e.name}倒下了！`, '#fdba74');
    c.fx.shake(8);
    c.fx.particles(e.x, e.cy, 18, { speed: 160, life: 0.9, size: 3.5, color: e.kind === 'wolf' ? '#6b7280' : e.kind === 'bear' ? '#6f4326' : '#e0812a', gravity: 450 });
    return true;
  }
  if (e.kind === 'cage') {
    if (e.deathCause !== 'open') {
      c.fx.banner('囚籠被打破了！', '#86efac');
      c.fx.sound('crack', { x: e.x });
      c.fx.particles(e.x, e.cy, 18, { speed: 200, life: 0.7, size: 3, color: '#6b7280', gravity: 600 });
    }
    return true;
  }
  return false;
}

// ---------- 繪圖：場景 ----------

const ell = (ctx, x, y, rx, ry, rot = 0) => { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); };
const rr = (ctx, x, y, w, h, r) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); };
function fillStroke(ctx, fill, stroke = OUT, lw = 1.6) {
  ctx.fillStyle = fill; ctx.fill();
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
}
function thick(ctx, pts, w, color, out = OUT) {
  const path = () => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); };
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (out) { path(); ctx.strokeStyle = out; ctx.lineWidth = w + 3; ctx.stroke(); }
  path(); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke();
}
function shadow(ctx, x, y, rx) {
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ell(ctx, x, y + 1, rx, 4); ctx.fill();
}

// 柱子上的火把：鐵架、木柄、跳動的火焰（光暈另外畫，見 drawTorchGlow）
function drawTorch(ctx, x, y, t) {
  ctx.fillStyle = '#26282e';
  ctx.fillRect(x - 8, y + 6, 16, 5);
  ctx.fillRect(x - 2, y + 6, 4, 14);
  ctx.fillStyle = '#5b3a1e';
  ctx.beginPath(); ctx.moveTo(x - 4, y - 2); ctx.lineTo(x + 4, y - 2); ctx.lineTo(x + 2, y + 20); ctx.lineTo(x - 2, y + 20); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#3a2614';
  ctx.fillRect(x - 5, y - 4, 10, 4);
  const fl = 1 + Math.sin(t * 13 + x) * 0.12 + Math.sin(t * 7.3 + x * 0.3) * 0.08;
  const sway = Math.sin(t * 5 + x) * 1.5;
  for (const [col, sc] of [['#f97316', 1], ['#fbbf24', 0.66], ['#fef3c7', 0.33]]) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x - 7 * sc, y - 4);
    ctx.quadraticCurveTo(x - 8 * sc, y - 14 * fl * sc - 6, x + sway, y - 28 * fl * sc - 2);
    ctx.quadraticCurveTo(x + 8 * sc, y - 14 * fl * sc - 6, x + 7 * sc, y - 4);
    ctx.closePath(); ctx.fill();
  }
}

function drawTorchGlow(ctx, x, y, t, r = 150) {
  const fl = 1 + Math.sin(t * 9 + x) * 0.05;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y - 12, 4, x, y - 12, r * fl);
  g.addColorStop(0, 'rgba(255,170,80,0.26)');
  g.addColorStop(0.4, 'rgba(255,130,50,0.08)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - 12 - r, 2 * r, 2 * r);
  ctx.restore();
}

// 牢房的前面：還關著的猛獸（暗處只看得清楚發亮的眼睛）+ 鐵欄杆（中間一扇門，打開了就往鉸鏈那邊收起來）
function drawCellFront(ctx, c, cell, k, S) {
  const B = BEASTS[k];
  const caged = B && (!S || k >= S.released);
  let eye = null;
  if (caged) {
    const C = CONFIG[B.cfg];
    eye = BEAST_ART[B.kind](ctx, (cell.x0 + cell.x1) / 2 + 6, cell.bottom, -1, c.time + k, C.h / ART_H[B.kind], {}, false);
  }
  drawBars(ctx, cell, c.state.doors[k] || 0);
  if (eye) drawEyeGlow(ctx, eye, GLOW[B.kind], c.time);
}

function drawBars(ctx, cell, open) {
  const { x0, x1, top, bottom } = cell, mid = (x0 + x1) / 2;
  const doorL = mid - 30, doorR = mid + 30;
  const rails = [top + 5, top + (bottom - top) * 0.42, bottom - 5];
  const bar = (x) => {
    ctx.strokeStyle = '#1f2228'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.strokeStyle = 'rgba(150,156,170,0.55)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 1.2, top); ctx.lineTo(x - 1.2, bottom); ctx.stroke();
  };
  ctx.save();
  ctx.lineCap = 'butt';
  for (let x = x0 + 10; x < x1 - 4; x += 20) if (x < doorL - 6 || x > doorR + 6) bar(x);
  for (const y of rails) {   // 門兩邊的橫條
    for (const [a, z] of [[x0, doorL], [doorR, x1]]) {
      ctx.fillStyle = '#262a31'; ctx.fillRect(a, y - 3.5, z - a, 7);
      ctx.fillStyle = 'rgba(150,156,170,0.4)'; ctx.fillRect(a, y - 3.5, z - a, 1);
    }
  }
  for (const x of [doorL, doorR]) {   // 門框
    ctx.fillStyle = '#1f2228'; ctx.fillRect(x - 3.5, top, 7, bottom - top);
    ctx.fillStyle = 'rgba(150,156,170,0.45)'; ctx.fillRect(x - 3.5, top, 1.2, bottom - top);
  }
  // 門：打開的時候往左邊的鉸鏈收起來（看起來像往外轉開）
  const w = (doorR - doorL) * (1 - 0.85 * open);
  const dx = doorL;
  for (let j = 1; j < 3; j++) bar(dx + w * j / 3);
  for (const y of rails) { ctx.fillStyle = '#262a31'; ctx.fillRect(dx, y - 3.5, w, 7); }
  if (open < 0.5) {   // 鎖頭 + 掛著的大鎖
    const ly = rails[1] + 16, lx = dx + w;
    ctx.fillStyle = '#34373f'; rr(ctx, lx - 9, ly - 10, 18, 22, 2); ctx.fill();
    ctx.strokeStyle = '#a07a1f'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(lx + 10, ly + 14, 5, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = '#c99a2e'; rr(ctx, lx + 3, ly + 14, 14, 11, 2); ctx.fill();
  }
  ctx.fillStyle = '#3b3f48';   // 鉸鏈
  for (const y of [top + 24, bottom - 26]) ctx.fillRect(doorL - 6, y - 5, 12, 10);
  ctx.restore();
}

function drawEyeGlow(ctx, eye, color, t, r = 10) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const a = 0.55 + 0.25 * Math.sin(t * 3 + eye.x);
  const g = ctx.createRadialGradient(eye.x, eye.y, 0, eye.x, eye.y, r);
  g.addColorStop(0, color.replace('A', a.toFixed(2)));
  g.addColorStop(1, color.replace('A', '0'));
  ctx.fillStyle = g;
  ctx.fillRect(eye.x - r, eye.y - r, 2 * r, 2 * r);
  ctx.restore();
}

// 天花板的吊燈：一條鏈子吊著一圈鐵燭台（三根蠟燭、燭火跳動）。位置照地形的吊燈（stalactites）：鏈子從天花板到燭台、最低點在正中間
function drawChandelierAt(ctx, cx, ringY, chainTop, t, k) {
  ctx.save();
  ctx.lineCap = 'round';
  for (let y = chainTop, j = 0; y < ringY - 4; y += 7, j++) {
    ctx.strokeStyle = '#4b505a'; ctx.lineWidth = 2;
    if (j % 2) { ctx.beginPath(); ctx.moveTo(cx, y - 1); ctx.lineTo(cx, y + 8); ctx.stroke(); }
    else { ell(ctx, cx, y + 3.5, 2.6, 4.5); ctx.stroke(); }
  }
  ctx.strokeStyle = '#3f3f46'; ctx.lineWidth = 2;   // 吊臂
  ctx.beginPath(); ctx.moveTo(cx, ringY - 6); ctx.lineTo(cx - 20, ringY + 2); ctx.moveTo(cx, ringY - 6); ctx.lineTo(cx + 20, ringY + 2); ctx.stroke();
  ell(ctx, cx, ringY + 6, 25, 6); fillStroke(ctx, '#3f3f46', OUT, 1.5);   // 鐵圈
  ctx.fillStyle = '#27272a'; ell(ctx, cx, ringY + 5, 18, 3.5); ctx.fill();
  ctx.fillStyle = '#52525b';
  ctx.beginPath(); ctx.moveTo(cx - 6, ringY + 11); ctx.lineTo(cx + 6, ringY + 11); ctx.lineTo(cx, ringY + 22); ctx.closePath(); ctx.fill();   // 底下的尖
  for (const [dx, h] of [[-18, 10], [0, 13], [18, 10]]) {   // 蠟燭 + 燭火
    ctx.fillStyle = '#e7e5e4'; ctx.fillRect(cx + dx - 2.5, ringY + 2 - h, 5, h);
    const fl = 1 + Math.sin(t * 11 + dx + k) * 0.15;
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath(); ctx.ellipse(cx + dx, ringY - h - 2, 2.2, 4.2 * fl, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawChandeliers(ctx, c) {
  const T = c.match.terrain;
  T.stalactites.forEach((s, k) => {
    if (T.fallen.has(k)) return;
    drawChandelierAt(ctx, s.tip.x, s.tip.y - 26, 24, c.time, k);
    ctx.save();   // 燭光
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(s.tip.x, s.tip.y - 36, 2, s.tip.x, s.tip.y - 36, 60);
    g.addColorStop(0, 'rgba(255,200,120,0.22)');
    g.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = g;
    ctx.fillRect(s.tip.x - 60, s.tip.y - 96, 120, 120);
    ctx.restore();
  });
}

// 掉下來的吊燈：最低點在飛行物的位置，上面帶著一小段斷掉的鏈子
function drawFallingChandelier(ctx, c, p) {
  drawChandelierAt(ctx, p.x, p.y - 26, p.y - 70, c.time, p.k || 0);
}

// 斷頭台：兩根立柱、橫樑與滑輪、繩子、底下的木座與斜撐；從地底冒出來（rise）、地上一圈紅色法陣。鍘刀：還沒落下就吊在上面，落下來時是飛行物
function drawGuillotine(ctx, c) {
  const g = c.state.guillotine;
  const H = bladeDrop() + 6;
  const falling = c.projectiles.some(p => p.weapon && p.weapon.id === 'execBlade');
  drawSummonCircle(ctx, g.x, g.y, c.time, g.dropped ? 0.5 : 1);
  ctx.save();
  ctx.beginPath(); ctx.rect(g.x - 80, g.y - 260, 160, 260); ctx.clip();
  ctx.translate(g.x, g.y + (1 - g.rise) * (H + 20));
  const WOOD = '#6b4423', WOOD_D = '#3f2a17', WOOD_L = '#8b5e34';
  ctx.strokeStyle = WOOD_D; ctx.lineWidth = 5; ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(-30, -46); ctx.lineTo(-48, -8); ctx.moveTo(30, -46); ctx.lineTo(48, -8); ctx.stroke();
  rr(ctx, -52, -10, 104, 10, 2); fillStroke(ctx, WOOD_D);
  for (const px of [-32, 23]) {
    rr(ctx, px, -H, 9, H - 9, 1); fillStroke(ctx, WOOD);
    ctx.fillStyle = '#2b2b30';
    for (const by of [-H + 30, -62, -24]) ctx.fillRect(px - 1, by, 11, 4);
  }
  rr(ctx, -42, -H - 12, 84, 12, 2); fillStroke(ctx, WOOD_L);
  ell(ctx, 0, -H - 17, 5.5, 5.5); fillStroke(ctx, '#4b505a');
  ctx.strokeStyle = '#d6c29a'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(5, -H - 17); ctx.lineTo(36, -H + 8); ctx.lineTo(36, -70); ctx.stroke();
  ctx.restore();
  if (!falling) drawBlade(ctx, g.x, g.dropped ? g.y - 6 : g.y + (1 - g.rise) * (H + 20) - H + 44);
}

// 鍘刀（底下的刀鋒在 (x, y)）：上面一塊配重，斜刃
function drawBlade(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y);
  rr(ctx, -23, -44, 46, 14, 2); fillStroke(ctx, '#3a3c44');
  ctx.beginPath(); ctx.moveTo(-23, -30); ctx.lineTo(23, -30); ctx.lineTo(23, -18); ctx.lineTo(-23, -2); ctx.closePath();
  fillStroke(ctx, '#cbd5e1', OUT, 1.6);
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(22, -17.5); ctx.lineTo(-22, -2.5); ctx.stroke();
  ctx.restore();
}

function drawSummonCircle(ctx, x, y, t, a) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = a;
  ctx.strokeStyle = 'rgba(248,113,113,0.9)'; ctx.lineWidth = 2;
  ell(ctx, 0, 0, 54, 9); ctx.stroke();
  ctx.strokeStyle = 'rgba(248,113,113,0.6)'; ctx.lineWidth = 1.2;
  ell(ctx, 0, 0, 40, 6.5); ctx.stroke();
  ctx.strokeStyle = 'rgba(254,202,202,0.9)'; ctx.lineWidth = 1.6;
  for (let k = 0; k < 12; k++) {
    const ang = t * 1.2 + k * Math.PI / 6;
    const cx = Math.cos(ang) * 47, cy = Math.sin(ang) * 7.8;
    ctx.beginPath(); ctx.moveTo(cx - 2, cy - 2.5); ctx.lineTo(cx + 2, cy + 2.5); ctx.stroke();
  }
  ctx.restore();
}

// 皮鞭 / 鎖鏈：從 (x0, y0) 甩到 (x1, y1)，k = 伸出去幾成（皮鞭彎一點）
function drawLash(ctx, l, color, w, curve) {
  const x = lerp(l.x0, l.x1, l.k), y = lerp(l.y0, l.y1, l.k);
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
  if (!curve) ctx.setLineDash([5, 3]);
  ctx.beginPath(); ctx.moveTo(l.x0, l.y0);
  if (curve) ctx.quadraticCurveTo((l.x0 + x) / 2, Math.min(l.y0, y) - 50, x, y);
  else ctx.lineTo(x, y);
  ctx.stroke();
  ctx.restore();
}

// 劍齒虎標記的獵物（玩家回合、還沒撲出去）：目標身上一圈轉動的準星 + 虎到他那一條淡淡的虛線
function drawTigerMark(ctx, c) {
  const S = prisonState(c.match);
  const tiger = c.match.byId('tiger');
  if (!S || !tiger || !tiger.alive || (c.state.fx && c.state.fx.actorId === tiger.id && c.state.fx.phase === 'act')) return;
  const t = pounceTarget(c.match, S.beastNext[tiger.id]);
  if (!t) return;
  const pulse = 0.6 + 0.25 * Math.sin(c.time * 4);
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.strokeStyle = `rgba(253,186,116,${0.4 * pulse})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(tiger.x, tiger.cy); ctx.lineTo(t.x, t.cy); ctx.stroke();
  ctx.setLineDash([]);
  const r = Math.max(t.h, 2 * t.hw) * 0.75 + 6;
  ctx.strokeStyle = `rgba(251,146,60,${pulse})`;
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

// 暈眩：頭上轉圈的星星
function drawStars(ctx, x, y, t) {
  ctx.save();
  ctx.fillStyle = '#fde047';
  for (let k = 0; k < 3; k++) {
    const a = t * 4 + k * Math.PI * 2 / 3;
    const sx = x + Math.cos(a) * 16, sy = y + Math.sin(a) * 4;
    ctx.beginPath();
    for (let j = 0; j < 10; j++) {
      const r = j % 2 ? 2 : 5, b = j * Math.PI / 5 - Math.PI / 2;
      ctx.lineTo(sx + Math.cos(b) * r, sy + Math.sin(b) * r);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

// ---------- 繪圖：囚籠 ----------

// 囚籠：鐵條圍成的籠子（頂上一個吊環），底下自己的血條與還剩幾回合（不畫在頭上：被關的人的名字、血條在那裡）
function drawCage(ctx, c, e, hurt) {
  drawCageShape(ctx, e.x, e.y, e.hw, e.h, c.time, hurt);
  const w = 44, y = e.y + 6;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  rr(ctx, e.x - w / 2, y, w, 5, 2.5); ctx.fill();
  ctx.fillStyle = '#9ca3af';
  rr(ctx, e.x - w / 2, y, w * Math.max(0, e.hp) / Math.max(1, e.maxHp), 5, 2.5); ctx.fill();
  const left = cageRoundsLeft(c.match);
  if (left === null) return;
  ctx.save();
  ctx.font = 'bold 12px "Microsoft JhengHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  const s = left > 0 ? `還有 ${left} 回合` : '處刑！';
  const tx = Math.max(40, Math.min(CONFIG.WORLD_W - 40, e.x));   // 站在畫面邊上時字不要被切掉
  ctx.strokeText(s, tx, y + 19);
  ctx.fillStyle = left > 1 ? '#fde68a' : '#f87171';
  ctx.fillText(s, tx, y + 19);
  ctx.restore();
}

function drawCageShape(ctx, x, y, hw, h, t, hurt) {
  ctx.save();
  const iron = hurt ? '#e5e7eb' : '#2b2f36';
  ctx.strokeStyle = iron;
  ctx.lineWidth = 3;
  const top = y - h;
  for (let k = 0; k <= 4; k++) {
    const bx = x - hw + (2 * hw) * k / 4;
    ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx, top + 6); ctx.stroke();
  }
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(x - hw - 2, y - 1); ctx.lineTo(x + hw + 2, y - 1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - hw, top + 8); ctx.quadraticCurveTo(x, top - 8, x + hw, top + 8); ctx.stroke();
  ctx.strokeStyle = 'rgba(160,166,180,0.55)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x - hw + 1, top + 8); ctx.lineTo(x - hw + 1, y); ctx.stroke();
  ctx.strokeStyle = iron; ctx.lineWidth = 2.5;   // 頂上的吊環
  ctx.beginPath(); ctx.arc(x, top - 4, 5, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

// ---------- 繪圖：處刑官 ----------

// 肥胖的處刑官：黑色尖頂頭套（眼洞透出紅光、紅邊）、大肚子（縫過的刀疤）、皮圍裙（血跡）、斜背的皮帶、腰上一串牢房鑰匙、肩上扛著大斧頭。
// pose：sit = 坐在地上哭（整個人往下沉、眼淚的痕跡）、rage = 暴怒（紅眼發光、後手的鐵鍊末端變成流星錘）、windup = 丟東西的起手（0..1）、crouch = 起跳前蹲一下
function drawExecutioner(ctx, x, y, f, t, s, pose, hurt) {
  const SKIN = '#e9b48f', SKIN_D = '#b97659', LEATHER = '#5a3a26', STRAP = '#3b2416', IRON = '#9ca3af';
  const br = Math.sin(t * 2.2);
  shadow(ctx, x, y, 44 * s);
  ctx.save();
  if (hurt) ctx.filter = 'brightness(2.4)';
  ctx.translate(x, y);
  ctx.scale(s * f, s);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const sink = pose.sit ? 16 : pose.crouch ? 6 : 0;
  const sob = pose.sit ? Math.sin(t * 9) * 1.2 : 0;
  // 後面那隻手（垂著，拎著鐵鍊；暴怒時末端是流星錘）
  ctx.save();
  ctx.translate(0, sink + sob);
  thick(ctx, [[-24, -72], [-36, -58], [-36, -42]], 12, SKIN);
  ell(ctx, -36, -39, 6.5, 6.5); fillStroke(ctx, SKIN);
  if (pose.rage) {
    const sw = Math.sin(t * 5) * 6;
    thick(ctx, [[-36, -36], [-38 + sw * 0.5, -18], [-40 + sw, -2]], 2, '#6b7280', null);
    drawSpikeBall(ctx, -40 + sw, 6, 9);
  } else {
    ctx.strokeStyle = '#4b505a'; ctx.lineWidth = 2;
    for (let k = 0; k < 4; k++) { ell(ctx, -36 - k * 0.8, -30 + k * 7, 2.6, 4); ctx.stroke(); }
  }
  ctx.restore();
  // 腿 + 靴子（坐著的腳往前伸，畫在肚子前面，見下面）
  if (!pose.sit) {
    rr(ctx, -22, -28 + sink, 15, 22 - sink, 3); fillStroke(ctx, '#3f2c22');
    rr(ctx, 8, -28 + sink, 15, 22 - sink, 3); fillStroke(ctx, '#3f2c22');
    rr(ctx, -25, -9, 20, 9, 3); fillStroke(ctx, '#1f1a17');
    rr(ctx, 6, -9, 22, 9, 3); fillStroke(ctx, '#1f1a17');
  }
  ctx.translate(0, sink + sob);
  // 身體：上窄下寬的大肚子（呼吸時一脹一縮）
  ctx.save();
  ctx.translate(0, -24); ctx.scale(1 + br * 0.012, 1 + br * 0.018); ctx.translate(0, 24);
  ctx.beginPath();
  ctx.moveTo(-24, -78);
  ctx.bezierCurveTo(-40, -70, -46, -36, -28, -24);
  ctx.quadraticCurveTo(2, -14, 32, -24);
  ctx.bezierCurveTo(48, -36, 42, -70, 24, -78);
  ctx.quadraticCurveTo(0, -84, -24, -78);
  ctx.closePath();
  const g = ctx.createRadialGradient(8, -58, 4, 2, -50, 48);
  g.addColorStop(0, '#f6cfae'); g.addColorStop(0.6, SKIN); g.addColorStop(1, SKIN_D);
  fillStroke(ctx, g, OUT, 2);
  ctx.strokeStyle = 'rgba(120,60,40,0.5)'; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(-8, -66, 7, 0.3, Math.PI - 0.3); ctx.stroke();
  ctx.beginPath(); ctx.arc(12, -66, 7, 0.3, Math.PI - 0.3); ctx.stroke();
  ctx.beginPath(); ctx.arc(12, -44, 2.4, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#9b4a3a'; ctx.lineWidth = 1.6;   // 縫過的刀疤
  ctx.beginPath(); ctx.moveTo(-22, -60); ctx.lineTo(-6, -48); ctx.stroke();
  ctx.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const sx = -22 + k * 4, sy = -60 + k * 3;
    ctx.beginPath(); ctx.moveTo(sx - 1.5, sy + 2.2); ctx.lineTo(sx + 1.5, sy - 2.2); ctx.stroke();
  }
  ctx.beginPath();   // 皮革圍裙 + 血跡
  ctx.moveTo(-32, -38); ctx.lineTo(36, -38); ctx.lineTo(30, -12); ctx.quadraticCurveTo(2, -6, -26, -12); ctx.closePath();
  const ap = ctx.createLinearGradient(0, -38, 0, -8);
  ap.addColorStop(0, LEATHER); ap.addColorStop(1, '#3a2418');
  fillStroke(ctx, ap);
  ctx.fillStyle = 'rgba(127,29,29,0.75)';
  ell(ctx, 12, -26, 6, 4, 0.4); ctx.fill();
  ell(ctx, 20, -20, 3, 2.2); ctx.fill();
  ctx.fillRect(13, -24, 2, 8);
  ell(ctx, -12, -30, 3, 2); ctx.fill();
  ctx.strokeStyle = STRAP; ctx.lineWidth = 5;   // 斜背的皮帶
  ctx.beginPath(); ctx.moveTo(-20, -80); ctx.quadraticCurveTo(8, -62, 34, -42); ctx.stroke();
  ctx.fillStyle = '#d6d3d1';
  for (let k = 1; k < 7; k++) {
    const u = k / 7, bx = (1 - u) ** 2 * -20 + 2 * u * (1 - u) * 8 + u * u * 34, by = (1 - u) ** 2 * -80 + 2 * u * (1 - u) * -62 + u * u * -42;
    ell(ctx, bx, by, 1.1, 1.1); ctx.fill();
  }
  ctx.strokeStyle = '#2a1a12'; ctx.lineWidth = 6;   // 腰帶 + 鐵扣
  ctx.beginPath(); ctx.moveTo(-34, -40); ctx.quadraticCurveTo(2, -33, 38, -40); ctx.stroke();
  ctx.strokeStyle = IRON; ctx.lineWidth = 1.8;
  ctx.strokeRect(4, -41, 10, 8);
  ctx.restore();
  if (pose.sit) {   // 坐在地上：兩隻腳往前伸（從肚子底下伸出來，靴底朝前）
    ctx.save();
    ctx.translate(0, -sink - sob);
    rr(ctx, 6, -13, 34, 12, 4); fillStroke(ctx, '#3f2c22');
    rr(ctx, 36, -18, 11, 18, 3); fillStroke(ctx, '#1f1a17');
    rr(ctx, -8, -12, 30, 11, 4); fillStroke(ctx, '#3f2c22');
    rr(ctx, 18, -16, 10, 16, 3); fillStroke(ctx, '#1f1a17');
    ctx.restore();
  }
  ctx.strokeStyle = '#a8a29e'; ctx.lineWidth = 1.6;   // 腰帶上的三把牢房鑰匙
  ell(ctx, -18, -33, 5, 5); ctx.stroke();
  ctx.strokeStyle = '#d6a548'; ctx.lineWidth = 1.8;
  for (const [kx, ka] of [[-21, 0.25], [-18, 0], [-15, -0.25]]) {
    ctx.save(); ctx.translate(kx, -29); ctx.rotate(ka);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 11); ctx.lineTo(3, 11); ctx.moveTo(0, 8); ctx.lineTo(2.5, 8); ctx.stroke();
    ctx.restore();
  }
  // 斧頭：斧柄斜靠在肩上（丟東西的起手時往後仰一點）
  ctx.save();
  ctx.translate(20, -74); ctx.rotate(-0.35 * (pose.windup || 0)); ctx.translate(-20, 74);
  const B = [38, -28], T = [4, -124];
  thick(ctx, [B, T], 5, '#5b3a1e');
  ctx.translate(T[0], T[1]);
  ctx.rotate(Math.atan2(T[1] - B[1], T[0] - B[0]));
  ctx.beginPath();
  ctx.moveTo(-34, 2); ctx.lineTo(4, 2); ctx.lineTo(12, 20); ctx.quadraticCurveTo(-12, 46, -48, 32); ctx.closePath();
  const steel = ctx.createLinearGradient(0, 2, 0, 40);
  steel.addColorStop(0, '#6b7280'); steel.addColorStop(0.6, '#cbd5e1'); steel.addColorStop(1, '#e2e8f0');
  fillStroke(ctx, steel, OUT, 2);
  ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(10, 21); ctx.quadraticCurveTo(-12, 43, -45, 30.5); ctx.stroke();
  ctx.fillStyle = 'rgba(153,27,27,0.85)';
  ctx.beginPath(); ctx.moveTo(-6, 36); ctx.quadraticCurveTo(-14, 40, -22, 39); ctx.lineTo(-20, 34); ctx.quadraticCurveTo(-12, 34, -8, 31); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#374151';
  ctx.fillRect(-36, -4, 42, 7);
  ctx.restore();
  // 頭套：黑色尖頂（尖端往後垂）、蓋到肩膀，紅色滾邊，兩個眼洞透出紅光
  const sway = Math.sin(t * 1.6) * 1.2;
  ctx.beginPath();
  ctx.moveTo(-27, -74);
  ctx.quadraticCurveTo(0, -66, 27, -74);
  ctx.quadraticCurveTo(19, -82, 16, -92);
  ctx.quadraticCurveTo(13, -110, -3 + sway, -121);
  ctx.quadraticCurveTo(-10 + sway, -125, -13 + sway, -119);
  ctx.quadraticCurveTo(-15, -104, -17, -92);
  ctx.quadraticCurveTo(-19, -82, -27, -74);
  ctx.closePath();
  const hg = ctx.createLinearGradient(-20, 0, 20, 0);
  hg.addColorStop(0, '#0b0a0c'); hg.addColorStop(0.6, '#2a2630'); hg.addColorStop(1, '#18161a');
  fillStroke(ctx, hg, OUT, 2);
  ctx.strokeStyle = '#7f1d1d'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(-26, -74.5); ctx.quadraticCurveTo(0, -66.5, 26, -74.5); ctx.stroke();
  ctx.fillStyle = '#000';
  ell(ctx, 6, -96, 3.4, 2.4, -0.15); ctx.fill();
  ell(ctx, 13, -96.5, 2.7, 2.2, -0.15); ctx.fill();
  if (pose.rage) {   // 暴怒：眼睛發出紅光
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const eg = ctx.createRadialGradient(9.5, -96, 0, 9.5, -96, 16);
    eg.addColorStop(0, 'rgba(255,60,60,0.9)'); eg.addColorStop(1, 'rgba(255,0,0,0)');
    ctx.fillStyle = eg; ctx.fillRect(-8, -114, 36, 36);
    ctx.restore();
  }
  ctx.fillStyle = pose.rage ? '#fecaca' : '#ef4444';
  ell(ctx, 6.8, -96, pose.rage ? 1.9 : 1.4, pose.rage ? 1.6 : 1.2); ctx.fill();
  ell(ctx, 13.4, -96.5, pose.rage ? 1.7 : 1.2, pose.rage ? 1.5 : 1.1); ctx.fill();
  if (pose.sit) {   // 哭過的淚痕
    ctx.strokeStyle = 'rgba(147,197,253,0.8)'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(6.5, -94); ctx.lineTo(6, -86); ctx.moveTo(13.4, -94.5); ctx.lineTo(14, -87); ctx.stroke();
  }
  // 前面那隻手：抓著斧柄（護腕）
  thick(ctx, [[18, -74], [34, -64], [30, -54]], 12, SKIN);
  thick(ctx, [[33, -63], [31, -57]], 13, STRAP, null);
  ell(ctx, 30, -53, 6.5, 6.5); fillStroke(ctx, SKIN);
  ctx.restore();
}

function drawSpikeBall(ctx, x, y, r) {
  ctx.fillStyle = '#3f3f46';
  for (let k = 0; k < 8; k++) {
    const a = k * Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a - 0.3) * r, y + Math.sin(a - 0.3) * r);
    ctx.lineTo(x + Math.cos(a) * (r + 5), y + Math.sin(a) * (r + 5));
    ctx.lineTo(x + Math.cos(a + 0.3) * r, y + Math.sin(a + 0.3) * r);
    ctx.closePath(); ctx.fill();
  }
  ell(ctx, x, y, r, r); fillStroke(ctx, '#52525b');
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ell(ctx, x - r * 0.35, y - r * 0.35, r * 0.3, r * 0.3); ctx.fill();
}

// 菜刀（轉著飛）
function drawCleaver(ctx, x, y, a) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(a);
  ctx.fillStyle = '#5b3a1e';
  rr(ctx, -14, -2, 10, 4, 1.5); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-4, -7); ctx.lineTo(13, -7); ctx.lineTo(13, 6); ctx.lineTo(-4, 4); ctx.closePath();
  fillStroke(ctx, '#cbd5e1', OUT, 1.2);
  ctx.fillStyle = '#1f2937';
  ell(ctx, 8, -3.5, 1.5, 1.5); ctx.fill();
  ctx.restore();
}

// 流星錘飛出去：從處刑官的手拉出一條鐵鍊到錘頭
function drawFlailShot(ctx, c, p) {
  const boss = bossOf(c.match);
  if (boss) {
    const h = handOf(boss);
    ctx.save();
    ctx.strokeStyle = '#6b7280'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    ctx.restore();
  }
  drawSpikeBall(ctx, p.x, p.y, 10);
}

// ---------- 繪圖：三隻猛獸 ----------
// 都照「面向右」畫，再用 scale(f) 翻過去；回傳眼睛在畫面上的位置（關在籠子裡時，眼睛的光另外畫在欄杆前面）。
// pose：leap = 撲在半空中（身體往前伸）、guard = 熊護主（人立起來、前掌張開）、whip = 被鞭過（身上一圈紅光）

function beastBegin(ctx, x, y, f, s, pose, hurt, rx) {
  if (!pose.leap) shadow(ctx, x, y, rx * s);
  ctx.save();
  if (hurt) ctx.filter = 'brightness(2.4)';
  if (pose.whip) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y - 26 * s, 4, x, y - 26 * s, rx * s * 1.4);
    g.addColorStop(0, 'rgba(239,68,68,0.28)'); g.addColorStop(1, 'rgba(239,68,68,0)');
    ctx.fillStyle = g; ctx.fillRect(x - rx * s * 1.5, y - 26 * s - rx * s * 1.5, rx * s * 3, rx * s * 3);
    ctx.restore();
  }
  ctx.translate(x, y);
  ctx.scale(s * f, s);
  if (pose.leap) ctx.rotate(-0.12);
  ctx.lineJoin = 'round';
}

// 惡狼：瘦長的灰狼，背上的毛豎起來、齜牙、紅眼，脖子上一圈帶刺的鐵項圈（斷掉的鍊子垂著）
function drawWolf(ctx, x, y, f, t, s, pose = {}, hurt = false) {
  const FUR = '#6b7280', DARK = '#3f4651', LIGHT = '#a3aab5';
  const br = Math.sin(t * 3.2) * 0.8;
  beastBegin(ctx, x, y, f, s, pose, hurt, 34);
  const stretch = pose.leap ? 6 : 0;
  ctx.fillStyle = DARK;
  rr(ctx, -22 - stretch, -22, 6, 22, 2); ctx.fill();
  rr(ctx, 20 + stretch, -24, 6, 24, 2); ctx.fill();
  ctx.save();
  ctx.translate(-30, -30);
  ctx.rotate(0.65 + Math.sin(t * 2.4) * 0.12);
  ctx.beginPath(); ctx.moveTo(0, -3); ctx.quadraticCurveTo(-14, -8, -26, 2); ctx.quadraticCurveTo(-14, 8, 0, 4); ctx.closePath();
  fillStroke(ctx, FUR);
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(-32, -26);
  ctx.bezierCurveTo(-32, -38 - br, -10, -40 - br, 8, -38 - br);
  ctx.bezierCurveTo(20, -42, 28, -36, 28, -28);
  ctx.bezierCurveTo(28, -20, 20, -17, 12, -18);
  ctx.bezierCurveTo(-4, -14, -14, -20, -24, -18);
  ctx.bezierCurveTo(-32, -18, -34, -22, -32, -26);
  ctx.closePath();
  fillStroke(ctx, FUR);
  ctx.save(); ctx.clip();
  ctx.fillStyle = LIGHT; ell(ctx, 4, -14, 24, 6); ctx.fill();
  ctx.restore();
  ctx.fillStyle = DARK;
  for (let k = 0; k < 6; k++) {
    const bx = -20 + k * 6, by = -37 - br - (k > 2 ? 1.5 : 0);
    ctx.beginPath(); ctx.moveTo(bx - 3, by + 2); ctx.lineTo(bx + 1, by - 6); ctx.lineTo(bx + 3, by + 2); ctx.closePath(); ctx.fill();
  }
  ell(ctx, -22, -26, 10, 9); fillStroke(ctx, FUR);
  rr(ctx, -28 - stretch, -22, 6.5, 22, 2); fillStroke(ctx, FUR);
  rr(ctx, 14 + stretch, -26, 6.5, 26, 2); fillStroke(ctx, FUR);
  ctx.fillStyle = DARK;
  ell(ctx, -24 - stretch, -1.5, 5, 2.4); ctx.fill();
  ell(ctx, 18.5 + stretch, -1.5, 5, 2.4); ctx.fill();
  ell(ctx, 23, -36, 9, 11, -0.4); fillStroke(ctx, FUR);
  ctx.beginPath();
  ctx.moveTo(20, -44); ctx.quadraticCurveTo(28, -51, 37, -47); ctx.lineTo(50, -41); ctx.lineTo(52, -38); ctx.lineTo(46, -36); ctx.lineTo(36, -36);
  ctx.quadraticCurveTo(24, -32, 20, -44); ctx.closePath();
  fillStroke(ctx, FUR);
  ctx.beginPath(); ctx.moveTo(35, -35); ctx.lineTo(48, -35); ctx.lineTo(44, -30); ctx.lineTo(33, -31); ctx.closePath();
  fillStroke(ctx, DARK);
  ctx.fillStyle = '#7f1d1d';
  ctx.beginPath(); ctx.moveTo(37, -35); ctx.lineTo(46, -35); ctx.lineTo(43, -32); ctx.lineTo(36, -33); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#f5f5f4';
  for (const tx of [39, 42.5, 46]) { ctx.beginPath(); ctx.moveTo(tx - 1.3, -36); ctx.lineTo(tx + 1.3, -36); ctx.lineTo(tx, -33); ctx.closePath(); ctx.fill(); }
  ctx.fillStyle = '#111';
  ell(ctx, 51.5, -39.5, 1.8, 1.6); ctx.fill();
  for (const [ex, col] of [[25, DARK], [30, FUR]]) {
    ctx.beginPath(); ctx.moveTo(ex - 3, -46); ctx.lineTo(ex, -58); ctx.lineTo(ex + 4, -46); ctx.closePath();
    fillStroke(ctx, col);
  }
  ctx.fillStyle = '#fecaca';
  ctx.beginPath(); ctx.moveTo(33, -43); ctx.quadraticCurveTo(36, -46, 40, -43.5); ctx.quadraticCurveTo(36, -41.5, 33, -43); ctx.fill();
  ctx.fillStyle = '#dc2626';
  ell(ctx, 37, -43.6, 1.4, 1.4); ctx.fill();
  ctx.strokeStyle = DARK; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(32, -46.5); ctx.lineTo(40, -45); ctx.stroke();
  ctx.strokeStyle = '#2f343c'; ctx.lineWidth = 4.5;   // 帶刺的鐵項圈
  ctx.beginPath(); ctx.moveTo(15, -43); ctx.quadraticCurveTo(18, -34, 24, -28); ctx.stroke();
  ctx.fillStyle = '#9ca3af';
  for (const [sx, sy, a] of [[15.5, -42, -2.2], [17.5, -36, -2.6], [21, -31, -3]]) {
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(-1.6, 0); ctx.lineTo(0, -5); ctx.lineTo(1.6, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  return { x: x + f * 37 * s, y: y - 43.6 * s };
}

// 棕熊：圓滾滾的大塊頭、肩膀隆起、胸口一道月牙白毛、臉上三道爪痕，前腳銬著鐵鐐。護主時人立起來、前掌張開
function drawBear(ctx, x, y, f, t, s, pose = {}, hurt = false) {
  const FUR = '#6f4326', DARK = '#45291a', LIGHT = '#a26b43', MUZ = '#c4925e', CLAW = '#ede4d3';
  const br = Math.sin(t * 2) * 1;
  beastBegin(ctx, x, y, f, s, pose, hurt, 46);
  if (pose.guard) { ctx.translate(-26, 0); ctx.rotate(-0.38); ctx.translate(26, 0); }
  ctx.fillStyle = DARK;
  rr(ctx, -28, -26, 13, 26, 4); ctx.fill();
  rr(ctx, 18, -28, 13, 28, 4); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-42, -30);
  ctx.bezierCurveTo(-44, -52 - br, -22, -62 - br, 0, -58 - br);
  ctx.bezierCurveTo(14, -70 - br, 30, -64, 34, -50);
  ctx.bezierCurveTo(38, -38, 34, -24, 26, -20);
  ctx.bezierCurveTo(10, -14, -20, -14, -34, -18);
  ctx.bezierCurveTo(-42, -20, -43, -26, -42, -30);
  ctx.closePath();
  fillStroke(ctx, FUR);
  ctx.save(); ctx.clip();
  ctx.globalAlpha = 0.35; ctx.fillStyle = LIGHT; ell(ctx, 0, -60 - br, 30, 8, -0.1); ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = DARK; ctx.lineWidth = 1.2;
  for (let k = 0; k < 9; k++) { const fx = -34 + k * 7, fy = -46 + Math.abs(k - 5) * 1.5; ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + 3, fy + 5); ctx.stroke(); }
  ctx.restore();
  ctx.fillStyle = '#e7d3b0';
  ctx.beginPath(); ctx.moveTo(22, -44); ctx.quadraticCurveTo(28, -34, 34, -42); ctx.quadraticCurveTo(28, -38, 22, -44); ctx.fill();
  ell(ctx, -27, -34, 15, 15); fillStroke(ctx, FUR);
  rr(ctx, -36, -26, 15, 26, 5); fillStroke(ctx, FUR);
  if (pose.guard) { rr(ctx, 16, -52, 14, 30, 5); fillStroke(ctx, FUR); }   // 前掌舉起來
  else { rr(ctx, 14, -32, 15, 32, 5); fillStroke(ctx, FUR); }
  ctx.fillStyle = CLAW;
  for (const cx of [-22, -18.5, -15]) { ctx.beginPath(); ctx.moveTo(cx - 1.4, -2); ctx.lineTo(cx + 2.6, -0.5); ctx.lineTo(cx - 1.4, 0.5); ctx.closePath(); ctx.fill(); }
  const py = pose.guard ? -22 : 0;
  for (const cx of [28, 31.5, 35]) { ctx.beginPath(); ctx.moveTo(cx - 1.4, py - 2); ctx.lineTo(cx + 2.6, py - 0.5); ctx.lineTo(cx - 1.4, py + 0.5); ctx.closePath(); ctx.fill(); }
  ctx.fillStyle = '#3d424b';   // 鐵鐐
  ctx.fillRect(13, py - 13, 17, 6);
  ctx.save();
  ctx.translate(0, Math.sin(t * 2 + 1) * 0.8);
  for (const [ex, ey] of [[31, -59], [45, -60]]) {
    ell(ctx, ex, ey, 5.5, 5.5); fillStroke(ctx, FUR);
    ctx.fillStyle = DARK; ell(ctx, ex, ey, 2.8, 2.8); ctx.fill();
  }
  ell(ctx, 40, -46, 15, 14); fillStroke(ctx, FUR);
  ell(ctx, 52, -41, 10, 7.5); fillStroke(ctx, MUZ);
  ctx.fillStyle = '#16100c'; ell(ctx, 60, -44, 3.2, 2.4); ctx.fill();
  ctx.strokeStyle = '#2a1a10'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(49, -37); ctx.quadraticCurveTo(54, -35, 59, -38); ctx.stroke();
  ctx.fillStyle = '#f5f5f4';
  ctx.beginPath(); ctx.moveTo(54, -36.5); ctx.lineTo(56.5, -37); ctx.lineTo(55.5, -33); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ef4444'; ell(ctx, 44, -50, 1.8, 1.8); ctx.fill();
  ctx.strokeStyle = DARK; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(39, -54.5); ctx.lineTo(48, -51.5); ctx.stroke();
  ctx.strokeStyle = 'rgba(240,210,180,0.75)'; ctx.lineWidth = 1.2;
  for (const k of [0, 3, 6]) { ctx.beginPath(); ctx.moveTo(35 + k, -58); ctx.lineTo(40 + k, -45); ctx.stroke(); }
  ctx.restore();
  ctx.restore();
  return { x: x + f * 44 * s, y: y - 50 * s };
}

// 劍齒虎：長身的橘色大貓、黑色條紋、白肚子，兩根往下伸的長劍齒，綠黃色的豎瞳
function drawTiger(ctx, x, y, f, t, s, pose = {}, hurt = false) {
  const FUR = '#e0812a', DARK = '#9a4f12', BELLY = '#f7dcb0', STRIPE = '#1c1410';
  const br = Math.sin(t * 2.6) * 0.7;
  beastBegin(ctx, x, y, f, s, pose, hurt, 42);
  const stretch = pose.leap ? 8 : 0;
  ctx.fillStyle = DARK;
  rr(ctx, -30 - stretch, -22, 8, 22, 3); ctx.fill();
  rr(ctx, 20 + stretch, -24, 8, 24, 3); ctx.fill();
  const sw = Math.sin(t * 1.8) * 5;
  const tail = [[-36, -30], [-50, -40 + sw * 0.3], [-60, -34 + sw], [-62, -46 + sw]];
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(...tail[0]); ctx.bezierCurveTo(...tail[1], ...tail[2], ...tail[3]);
  ctx.strokeStyle = OUT; ctx.lineWidth = 8; ctx.stroke();
  ctx.strokeStyle = FUR; ctx.lineWidth = 5; ctx.stroke();
  ctx.strokeStyle = STRIPE; ctx.lineWidth = 5.2; ctx.setLineDash([2.5, 6]); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = STRIPE; ell(ctx, tail[3][0], tail[3][1], 3, 3); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-40, -28);
  ctx.bezierCurveTo(-40, -40 - br, -16, -42 - br, 4, -40 - br);
  ctx.bezierCurveTo(16, -43, 28, -40, 30, -32);
  ctx.bezierCurveTo(32, -22, 22, -17, 14, -18);
  ctx.bezierCurveTo(-6, -14, -24, -15, -34, -18);
  ctx.bezierCurveTo(-41, -20, -41, -24, -40, -28);
  ctx.closePath();
  fillStroke(ctx, FUR);
  ctx.save(); ctx.clip();
  ctx.fillStyle = BELLY; ell(ctx, 0, -14, 34, 6); ctx.fill();
  ctx.fillStyle = STRIPE;
  for (let k = 0; k < 7; k++) {
    const sx = -32 + k * 8.5;
    ctx.beginPath(); ctx.moveTo(sx - 2.2, -44); ctx.quadraticCurveTo(sx + 2, -34, sx - 3, -25); ctx.quadraticCurveTo(sx + 4.5, -34, sx + 2.2, -44); ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ell(ctx, -29, -28, 13, 11); fillStroke(ctx, FUR);
  rr(ctx, -35 - stretch, -22, 9, 22, 4); fillStroke(ctx, FUR);
  ell(ctx, 18, -30, 12, 12); fillStroke(ctx, FUR);
  rr(ctx, 13 + stretch, -26, 9, 26, 4); fillStroke(ctx, FUR);
  ctx.fillStyle = STRIPE;
  for (const [lx, ly] of [[-33, -14], [-33, -8], [15, -16], [15, -10]]) ctx.fillRect(lx, ly, 5, 1.8);
  ctx.fillStyle = BELLY;
  ell(ctx, -30 - stretch, -1.5, 6, 2.6); ctx.fill();
  ell(ctx, 18.5 + stretch, -1.5, 6, 2.6); ctx.fill();
  ell(ctx, 37, -38, 13, 11); fillStroke(ctx, FUR);
  for (const ex of [29, 36]) { ctx.beginPath(); ctx.moveTo(ex - 4, -45); ctx.quadraticCurveTo(ex - 2, -53, ex + 3, -47); ctx.closePath(); fillStroke(ctx, FUR); }
  ell(ctx, 36, -31, 10, 6); ctx.fillStyle = BELLY; ctx.fill();
  ell(ctx, 46, -34, 7.5, 5.5); fillStroke(ctx, BELLY);
  ctx.fillStyle = '#7c2d12';
  ctx.beginPath(); ctx.moveTo(50, -38.5); ctx.lineTo(54, -38.5); ctx.lineTo(52.5, -36); ctx.closePath(); ctx.fill();
  ctx.fillStyle = STRIPE;
  for (const [fx, fy] of [[30, -44], [34, -46], [27, -38]]) { ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx + 4, fy + 1.5); ctx.lineTo(fx, fy + 2.5); ctx.closePath(); ctx.fill(); }
  for (const [fx, col] of [[41, '#d6d3d1'], [44, '#fafaf9']]) {   // 劍齒
    ctx.beginPath(); ctx.moveTo(fx - 1.8, -31); ctx.quadraticCurveTo(fx - 1, -22, fx + 2, -14); ctx.quadraticCurveTo(fx + 2, -23, fx + 2, -31); ctx.closePath();
    fillStroke(ctx, col, OUT, 1);
  }
  ctx.fillStyle = '#d9f99d';
  ctx.beginPath(); ctx.moveTo(38, -40); ctx.quadraticCurveTo(41.5, -43, 45, -40.5); ctx.quadraticCurveTo(41.5, -38.5, 38, -40); ctx.fill();
  ctx.fillStyle = '#111'; ctx.fillRect(41, -42, 1.3, 3.2);
  ctx.strokeStyle = STRIPE; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(37, -43); ctx.lineTo(45, -42); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 0.8;
  for (const dy of [-1.5, 0.5, 2.5]) { ctx.beginPath(); ctx.moveTo(48, -33 + dy); ctx.lineTo(60, -34 + dy * 2); ctx.stroke(); }
  ctx.restore();
  return { x: x + f * 41.5 * s, y: y - 40.5 * s };
}
