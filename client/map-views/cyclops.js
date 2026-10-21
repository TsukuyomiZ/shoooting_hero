import { CONFIG } from '../../shared/core/config.js';
import { CYCLOPS_ACTION_NAMES, boulderPoly, boulderSpan, ledgeName, poundLane, poundLedge, poundOrigin, sealLedge, shatterBoulders } from '../../shared/maps/cyclops.js';
import { cave, drawShade as caveShade } from './cave.js';

// 菁英關「地心探險」的地圖畫面：洞穴的部分（火把、照明、掉下來的鐘乳石）沿用 cave.js，
// 加上獨眼巨人：回合的動畫腳本（照伺服器廣播的招式播）、身體 / 發光的獨眼 / 巨石 / 猛捶衝擊的繪圖、預定猛捶時的警示、巨石投擲預兆時每個目標身上的準星、
// 超巨石（舉起來丟過去、砸下去封住平台、封住的巨石、玩家回合時要封的那一段先畫警示）、震盪獅吼（吸氣、震波、擊碎巨石）、倒下的特效。
// 規則在 shared/maps/cyclops.js；掛勾的說明見 index.js
const FPS = 60;
const SKIN = '#b7794a', SKIN_DARK = '#7c4a26', HIDE = '#5b3a1e';
const SLAM_AT = 0.8;      // 猛捶的預兆播到幾成時拳頭砸下去
const SEAL_LIFT = 0.45;   // 超巨石的動畫（CYCLOPS.sealCast）前幾成是舉起來，之後是飛過去
const ROCK_R = 44;        // 飛在空中的超巨石半徑

export const cyclops = {
  ...cave,
  type: 'cyclops',

  // 這一場的畫面狀態：洞穴的（爆炸閃光、火把點燃）+
  //   fx  巨人出招的動畫 { action, t（預兆播了幾秒）, at（出招之後幾秒）, phase: 'cast' | 'act', targetId, targetIds, ledge }（巨人回合播完就清掉）
  create: (match) => ({ ...cave.create(match), fx: null }),

  turnScript: cyclopsTurnScript,
  abortScript(c) { c.state.fx = null; },   // 播到一半丟掉：舉起的手、巨石不要一直留著
  onDeath: onCyclopsDeath,

  // 每一步：洞穴的（閃光、火星）+ 猛捶的衝擊在平台上揚起碎石 + 出招之後的計時（震盪獅吼的震波圈照這個畫）（畫圖只讀狀態，不在畫圖時做這些）
  update(c, dt) {
    cave.update(c, dt);
    for (const p of c.projectiles) if (p.weapon && p.weapon.id === 'cyclopsShock' && laneAt(c, p)) shockDebris(c, p);
    const fx = c.state.fx;
    if (fx && fx.phase === 'act') fx.at += dt;
  },

  // 洞穴的（鐘乳石掉下來、火把點燃、閃光）+ 巨石砸碎、猛捶的衝擊跑到盡頭、被震盪獅吼震退的人飄字
  showEvent(c, ev, made) {
    cave.showEvent(c, ev, made);
    const p = c.projectiles.find(q => q.i === ev.p);
    if (p && p.weapon.id === 'cyclopsBoulder' && ev.type === 'explode') {
      c.fx.particles(ev.x, ev.y, 18, { speed: 180, life: 0.7, size: 3.5, color: '#a8a29e', gravity: 800 });
    }
    if (p && p.weapon.id === 'cyclopsShock' && ev.type === 'range') {   // 衝擊跑到岩柱的盡頭：揚起一團碎石
      c.fx.particles(ev.x, ev.y + 4, 10, { speed: 140, life: 0.5, size: 3, color: '#a8a29e', gravity: 700 });
    }
    if (p && p.weapon.id === 'cyclopsRoar' && ev.target) {
      const e = c.match.byId(ev.target);
      if (e) c.fx.float(e, '震退！', '#fde68a', 16);
    }
  },

  // 被超巨石壓死的人不畫（埋在巨石底下）
  drawEntityBare: (ctx, c, e) => !e.alive && e.deathCause === 'crushed',

  // 巨人：自己畫身體（不畫影子、武器），血條、名字照一般的畫
  drawEntity(ctx, c, e, hurt) {
    if (e.part !== 'cyclops') return false;
    drawCyclops(ctx, c, e, hurt);
    return 'body';
  },
  hpBar: (c, e) => (e.part === 'cyclops' ? { w: 110, h: 8 } : null),

  // 洞穴的（火把）+ 封住平台的超巨石（在角色後面；暗的地方照遮光一樣看不太到，輪廓另外畫在遮光上面）
  drawScene(ctx, c) {
    cave.drawScene(ctx, c);
    const S = c.match.mechState;
    if (S && Array.isArray(S.sealed)) for (const i of S.sealed) drawSealed(ctx, c, i, 1);
  },

  // 洞穴的（掉下來的鐘乳石）+ 巨石、猛捶的衝擊、震盪獅吼的震波
  drawProjectile(ctx, c, p) {
    if (cave.drawProjectile(ctx, c, p)) return true;
    if (p.weapon.id === 'cyclopsBoulder') { drawBoulder(ctx, p); return true; }
    if (p.weapon.id === 'cyclopsShock') { drawShock(ctx, c, p); return true; }
    if (p.weapon.id === 'cyclopsRoar') { drawRoarWave(ctx, p); return true; }
    return false;
  },

  // 遮光（洞穴的）之後：封住的超巨石輪廓（暗的地方也看得到哪裡被封住）、預定猛捶的警示（會掉的鐘乳石、要打的平台）、要封的那一段的警示、震盪獅吼的預告（巨石的輪廓發光）、
  // 飛在空中的超巨石、震盪獅吼的震波圈、巨石投擲的預兆（每個目標身上的準星）、巨人發光的獨眼
  drawShade(ctx, c) {
    const S = c.match.mechState;
    caveShade(ctx, c, undefined, null, (i) => buried(c, i));   // 壓在超巨石底下的火把不畫
    if (S && Array.isArray(S.sealed)) for (const i of S.sealed) drawSealed(ctx, c, i, 0.45);
    drawPoundWarning(ctx, c);
    drawSealWarning(ctx, c);
    drawRoarWarning(ctx, c);
    drawFlyingRock(ctx, c);
    drawRoarRings(ctx, c);
    drawThrowMarks(ctx, c);
    drawEyeGlow(ctx, c);
  },

  // 洞穴那一行（敵人剩餘、火把）+ 巨人的血量、預定的下一招另起一行（巨石投擲是每個人各一顆：（全員）；接在同一行會超出右上的名單框），
  // 一般招式之後還要丟超巨石的再一行（封哪個平台）
  hud(c, line) {
    const lines = cave.hud(c, line);
    const e = c.match.byId('cyclops');
    const next = c.match.mechState && c.match.mechState.next;
    if (e && e.alive) {
      const big = next && (Number.isInteger(next.seal) || next.action === 'roar' || next.action === 'pound');
      const color = big ? '#fdba74' : '#fca5a5';
      lines.push([`獨眼巨人 ${e.hp} / ${e.maxHp}`, color]);
      if (next) lines.push([`下一招：${CYCLOPS_ACTION_NAMES[next.action] || next.action}${next.action === 'throw' ? '（全員）' : ''}`, color]);
      if (next && Number.isInteger(next.seal)) lines.push([`＋${CYCLOPS_ACTION_NAMES.seal}：封住${ledgeName(c.match, next.seal)}`, color]);
    }
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 巨人的回合：每一招照順序播（有超巨石的回合是一般招式（猛捶 / 巨石投擲）、超巨石兩招），全部播完才換上伺服器預定的下一招（msg.boss.next）：
// 猛捶的警示留到真的捶下去
function* cyclopsTurnScript(c, msg) {
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* cyclopsStepScript(c, step);
  c.state.fx = null;
  if (c.match.mechState && msg.boss.next !== undefined) c.match.mechState.next = msg.boss.next;
}

// 一招的預兆 + 出招（預兆秒數照招式帶的 cast，沒帶 = bossCast，跟裁判算的時間一樣）：
//   猛捶：雙手舉高再砸下去 → 照 shotScript 重播（衝擊沿著那個平台跑、鐘乳石全部掉下來）
//   巨石投擲：舉起巨石、眼睛盯著第一個目標、每個目標身上一個準星 → 照 shotScript 重播（一顆接一顆沿拋物線飛向每個人）
//   超巨石：雙手舉起一大塊石頭 → 丟出去、沿弧線飛到要封的平台上 → 砸下去（照伺服器的結果：壓死 killed 的人、sealLedge 封住）→ 大家落地
//   震盪獅吼：吸氣 → 吼（先擊碎所有超巨石，再照 shotScript 重播每個人的震波）
// fx.targetIds = 巨石投擲 / 震盪獅吼打的每個人（照出手的順序；準星用），fx.targetId = 眼睛盯著誰（第一個目標）
function* cyclopsStepScript(c, b) {
  const match = c.match;
  const targetIds = Array.isArray(b.targetIds) ? b.targetIds : [];
  const fx = c.state.fx = { action: b.action, t: 0, at: 0, phase: 'cast', targetId: b.targetId ?? targetIds[0] ?? null, targetIds, ledge: b.ledge ?? null };
  const cast = Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS);
  const cy = match.byId('cyclops');
  const far = b.action === 'pound' && cy ? farLane(c, cy, b) : null;   // 打的是別根平台：衝擊從那根靠他的一端冒出來
  if (b.action === 'pound') c.fx.banner(`獨眼巨人：${CYCLOPS_ACTION_NAMES.pound}！`, '#fdba74');
  else if (b.action === 'throw') c.fx.banner(`獨眼巨人：${CYCLOPS_ACTION_NAMES.throw} → 全員！`, '#fca5a5');
  else if (b.action === 'seal') c.fx.banner(`獨眼巨人：${CYCLOPS_ACTION_NAMES.seal} → 封住${ledgeName(match, b.ledge)}！`, '#fdba74');
  else if (b.action === 'roar') c.fx.banner(`獨眼巨人：${CYCLOPS_ACTION_NAMES.roar}！`, '#fde68a');
  else c.fx.banner(`獨眼巨人${CYCLOPS_ACTION_NAMES.idle}`, '#e9d5ff');
  // 巨石投擲：預兆時就轉向第一個目標那邊（舉巨石的是前面那隻手；出手時 shotScript 也是擺成這個方向）
  if (cy && b.action === 'throw' && b.shot && (b.shot.facing === 1 || b.shot.facing === -1)) cy.facing = b.shot.facing;
  if (cy && b.action === 'seal') cy.facing = -1;   // 平台都在他左邊
  const lift = Math.round(cast * SEAL_LIFT);
  const slam = Math.round(cast * SLAM_AT);
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    if (b.action === 'pound' && i === slam && cy) {   // 拳頭砸在岩柱上：整個畫面震、碎石往兩邊噴
      c.fx.shake(16);
      c.fx.sound('stomp', { x: cy.x });
      c.fx.particles(cy.x - cy.hw, cy.y, 14, { speed: 200, life: 0.7, size: 3.5, color: '#a8a29e', gravity: 700 });
      c.fx.particles(cy.x + cy.hw, cy.y, 14, { speed: 200, life: 0.7, size: 3.5, color: '#78716c', gravity: 700 });
      if (far) c.fx.particles(far.ox, far.lane.bottom, 18, { speed: 180, life: 0.7, size: 3.5, color: '#a8a29e', gravity: 700 });
    }
    if (b.action === 'pound' && i > slam && i % 6 === 0) c.fx.shake(5);   // 捶完還在晃，天花板的鐘乳石要掉了
    if (b.action === 'throw' && i === cast - 8 && cy) c.fx.sound('heave', { x: cy.x });
    if (b.action === 'seal' && cy) {
      if (i === 0) c.fx.sound('stomp', { x: cy.x, vol: 0.5 });   // 從地上扳起一大塊石頭
      if (i === lift) { c.fx.sound('heave', { x: cy.x }); c.fx.shake(6); }
    }
    if (b.action === 'roar' && cy && i % 10 === 0) c.fx.particles(cy.x - cy.facing * 40, cy.y - cy.h * 0.8, 2, { speed: 40, life: 0.5, size: 2, color: 'rgba(214,211,209,0.7)', gravity: -60 });   // 吸氣：灰塵往嘴邊飄
    yield { frames: 1 };
  }
  fx.phase = 'act';
  if (b.action === 'seal') sealImpact(c, b);
  if (b.action === 'roar') roarBlast(c, cy);
  if (b.shot) {
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
}

// 超巨石砸下去：壓死伺服器說的那幾個人、封住平台（跟伺服器同一個 sealLedge：壓碎鐘乳石、壓熄火把、巨石放進地形），重畫地形、震、揚起一大片塵土
function sealImpact(c, b) {
  const match = c.match;
  for (const id of b.killed || []) {
    const e = match.byId(id);
    if (e && e.alive) e.die('crushed');
  }
  const r = sealLedge(match, b.ledge);
  if (r) c.fx.repaint(r.rect);
  c.fx.shake(24);
  c.fx.sound('stomp', { x: (r ? (r.rect.x0 + r.rect.x1) / 2 : 512) });
  if (r && r.rocks.length) c.fx.sound('crack');
  const s = boulderSpan(match, b.ledge);
  for (let k = 0; k <= 8; k++) {
    const x = s.x0 + (s.x1 - s.x0) * k / 8;
    c.fx.particles(x, s.y1 - 4, 8, { speed: 220, life: 0.9, size: 4, color: k % 2 ? '#a8a29e' : '#78716c', gravity: 500 });
    c.fx.particles(x, s.y0 + (s.y1 - s.y0) * ((k * 37) % 100) / 100, 4, { speed: 120, life: 0.7, size: 6, color: 'rgba(168,162,158,0.6)', gravity: -30 });
  }
}

// 震盪獅吼：擊碎所有超巨石（跟伺服器同一個 shatterBoulders），重畫地形、碎石往外噴、整個畫面大震
function roarBlast(c, cy) {
  const match = c.match;
  const polys = (match.mechState.sealed || []).map(i => boulderPoly(match, i));
  const { rects } = shatterBoulders(match);
  for (const r of rects) c.fx.repaint(r);
  for (const poly of polys) {
    const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    for (let k = 0; k < 24; k++) {
      const x = x0 + (x1 - x0) * ((k * 7) % 24) / 23, y = y0 + (y1 - y0) * ((k * 11) % 24) / 23;
      c.fx.particles(x, y, 4, { speed: 260, life: 1, size: 5, color: k % 3 ? '#a8a29e' : '#57534e', gravity: 700 });
    }
  }
  if (polys.length) c.fx.sound('crack');
  c.fx.shake(20);
  c.fx.sound('roar', { x: cy ? cy.x : 512 });
}

// 巨人倒下 / 玩家被超巨石壓死：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
function onCyclopsDeath(c, e) {
  if (e.deathCause === 'crushed') {
    c.fx.banner(`${e.name} 被超巨石壓扁了！`, '#fca5a5');
    return true;
  }
  if (e.part !== 'cyclops') return false;
  c.fx.banner('獨眼巨人倒下了！', '#c084fc');
  c.fx.shake(14);
  c.fx.sound('stomp', { x: e.x });
  c.fx.particles(e.x, e.cy, 36, { speed: 220, life: 1.1, size: 4, color: SKIN, gravity: 400 });
  return true;
}

// ---------- 小工具 ----------

// 衝擊現在跑在哪個平台上（照它的高度與 x 對到 ledges 的哪一條線）；不在任何平台上回傳 null（跑出頭的那一點不畫）
function laneAt(c, p) {
  const ledges = c.match && c.match.level.mechanic && c.match.level.mechanic.ledges;
  if (!ledges) return null;
  for (let i = 0; i < ledges.length; i++) {
    const lane = poundLane(c.match, i);
    if (Math.abs(p.y - lane.y) < 1 && onLedge(lane, p.x)) return lane;
  }
  return null;
}
const onLedge = (lane, x) => x >= lane.x0 && x <= lane.x1;

// 這一招猛捶打的平台不是巨人自己站的那根：回傳 { lane, ox }（衝擊出發點），是他自己那根回傳 null
function farLane(c, cy, b) {
  const ledges = c.match.level.mechanic.ledges;
  if (!ledges || !Number.isInteger(b.ledge) || !ledges[b.ledge]) return null;
  const lane = poundLane(c.match, b.ledge);
  return onLedge(lane, cy.x) ? null : { lane, ox: poundOrigin(lane, cy) };
}

// 猛捶的衝擊揚起的碎石：每秒 30 顆（照遊戲時間，不照畫面更新次數；update 每一步呼叫）
function shockDebris(c, p) {
  const tick = Math.floor(c.time * 30);
  if (tick === p.debrisTick) return;
  p.debrisTick = tick;
  c.fx.particle({ x: p.x, y: p.y + 4, vx: (Math.random() - 0.5) * 140, vy: -110 - Math.random() * 150, life: 0.5, maxLife: 0.5, size: 3, color: Math.random() < 0.5 ? '#a8a29e' : '#57534e', gravity: 700 });
}

// 第 i 支火把壓在超巨石底下（在封住的那一段裡）
function buried(c, i) {
  const S = c.match.mechState;
  const t = S && S.def.torches[i];
  return !!t && Array.isArray(S.sealed) && S.sealed.some(k => { const s = boulderSpan(c.match, k); return t.x > s.x0 && t.x < s.x1; });
}

// 巨人看哪裡：出招的目標 → 要封的平台（超巨石）→ 現在行動的玩家 → 離他最近的玩家
function lookPoint(c, cy) {
  const match = c.match;
  const fx = c.state.fx;
  if (fx && fx.action === 'seal' && Number.isInteger(fx.ledge)) {
    const s = boulderSpan(match, fx.ledge);
    return { x: (s.x0 + s.x1) / 2, y: s.y1 - 20 };
  }
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

// 出招的姿勢：raise = 手舉起來的程度（0..1），slammed = 猛捶已經砸下去了，boulder = 手上舉著巨石，giant = 雙手舉著超巨石（0..1 = 舉起來的程度），
// both = 兩隻手一起舉，mouth = 嘴張多大（震盪獅吼）
function poseOf(c) {
  const fx = c.state.fx;
  const none = { raise: 0, slammed: false, boulder: false, giant: 0, both: false, mouth: 0 };
  if (!fx) return none;
  const cast = CONFIG.TIMING.bossCast;
  if (fx.action === 'pound') {
    if (fx.phase === 'act' || fx.t >= cast * SLAM_AT) return { ...none, slammed: true, both: true };
    return { ...none, raise: Math.min(1, fx.t / (cast * SLAM_AT)), both: true };
  }
  if (fx.action === 'throw') return { ...none, raise: fx.phase === 'act' ? 0.2 : Math.min(1, fx.t / (cast * 0.6)), boulder: fx.phase === 'cast' };
  if (fx.action === 'seal') {
    const lift = CONFIG.CYCLOPS.sealCast * SEAL_LIFT;
    if (fx.phase === 'cast' && fx.t < lift) { const k = Math.min(1, fx.t / lift); return { ...none, raise: k, giant: k, both: true }; }
    return { ...none, raise: 0.25, both: true };
  }
  if (fx.action === 'roar') {
    if (fx.phase === 'cast') return { ...none, raise: 0.35 * Math.min(1, fx.t / CONFIG.CYCLOPS.roarCast), both: true, mouth: 0.3 };
    return { ...none, raise: 0.5, both: true, mouth: fx.at < 0.9 ? 1 : Math.max(0, 1 - (fx.at - 0.9) * 2) };
  }
  return none;
}

// 飛在空中的超巨石現在在哪：從他舉起的雙手上方沿弧線飛到要封的平台中間（弧線頂點不碰天花板）；不在飛的時候回傳 null
function flyingRock(c) {
  const fx = c.state.fx;
  if (!fx || fx.action !== 'seal' || fx.phase !== 'cast' || !Number.isInteger(fx.ledge)) return null;
  const cast = CONFIG.CYCLOPS.sealCast, lift = cast * SEAL_LIFT;
  if (fx.t < lift) return null;
  const cy = c.match.byId('cyclops');
  if (!cy) return null;
  const k = Math.min(1, (fx.t - lift) / (cast - lift));
  const s = boulderSpan(c.match, fx.ledge);
  const x0 = cy.x, y0 = cy.y - cy.h - ROCK_R + 6;
  const x1 = (s.x0 + s.x1) / 2, y1 = s.y1 - ROCK_R;
  const top = Math.max(s.y0 + ROCK_R + 10, Math.min(y0, y1) - 150);
  const peak = Math.min(y0, y1) - top;
  return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k - 4 * peak * k * (1 - k), spin: k * 5, k };
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
  // 身體：往前駝（震盪獅吼吸氣時胸口鼓起來）
  const puff = pose.mouth > 0 ? 3 : 0;
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.moveTo(-20 - puff, -16);
  ctx.quadraticCurveTo(-26 - puff, -40, -10 + f * 4, -52 - puff);
  ctx.quadraticCurveTo(8 + f * 6, -56 - puff, 20 + puff, -40);
  ctx.quadraticCurveTo(24 + puff, -24, 18, -14);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  // 獸皮腰布
  ctx.fillStyle = hurt ? '#ddd' : HIDE;
  ctx.beginPath(); ctx.moveTo(-20, -20); ctx.lineTo(19, -20); ctx.lineTo(14, -9); ctx.lineTo(4, -13); ctx.lineTo(-6, -8); ctx.lineTo(-17, -12); ctx.closePath(); ctx.fill();
  // 手臂：照姿勢舉起來（投擲舉起前面那隻手；猛捶、超巨石、震盪獅吼雙手）
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
  arm(back, pose.both ? pose.raise : 0);
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
  if (pose.mouth > 0) {   // 張大的嘴（震盪獅吼）
    ctx.fillStyle = '#3b0d0d';
    ctx.beginPath(); ctx.ellipse(f * 3, -48, 4 + 3 * pose.mouth, 1.5 + 4 * pose.mouth, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // 雙手舉著的超巨石（舉起來的過程中從他背後升上來）
  if (pose.giant > 0) {
    const r = ROCK_R * (0.6 + 0.4 * pose.giant);
    drawRock(ctx, e.x, e.y - e.h - r + 6 + (1 - pose.giant) * 30, r, 0, hurt);
  }
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

// 一塊圓滾滾的大石頭（不規則的多邊形 + 裂紋）：巨人舉著的、飛在空中的超巨石
function drawRock(ctx, x, y, r, spin, hurt = false) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(spin);
  ctx.fillStyle = hurt ? '#e7e5e4' : '#78716c';
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  const pts = [1, 0.88, 1.04, 0.92, 1, 0.84, 1.08, 0.9, 0.98, 0.86];
  pts.forEach((k, j) => {
    const a = j / pts.length * Math.PI * 2;
    if (j) ctx.lineTo(Math.cos(a) * r * k, Math.sin(a) * r * k); else ctx.moveTo(Math.cos(a) * r * k, Math.sin(a) * r * k);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = 'rgba(214,211,209,0.25)';   // 亮面
  ctx.beginPath(); ctx.ellipse(-r * 0.3, -r * 0.35, r * 0.35, r * 0.22, -0.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(41,37,36,0.7)';   // 裂紋
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.1); ctx.lineTo(-r * 0.05, r * 0.15); ctx.lineTo(r * 0.1, r * 0.55); ctx.moveTo(-r * 0.05, r * 0.15); ctx.lineTo(r * 0.45, -r * 0.05); ctx.stroke();
  ctx.restore();
}

// 封住平台的超巨石：照地形的那個多邊形畫（上淺下深的岩石、幾道裂紋、亮面）。alpha < 1 = 畫在遮光上面的淡淡輪廓
function drawSealed(ctx, c, i, alpha) {
  const poly = boulderPoly(c.match, i);
  const s = boulderSpan(c.match, i);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  poly.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  const g = ctx.createLinearGradient(0, s.y0, 0, s.y1);
  g.addColorStop(0, '#57534e');
  g.addColorStop(0.5, '#78716c');
  g.addColorStop(1, '#44403c');
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(28,25,23,0.9)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.clip();
  // 裂紋與亮面：照巨石的大小擺（固定的比例，不用亂數）
  const w = s.x1 - s.x0, h = s.y1 - s.y0;
  const at = (fx, fy) => [s.x0 + w * fx, s.y0 + h * fy];
  ctx.strokeStyle = 'rgba(28,25,23,0.75)';
  ctx.lineWidth = 2.5;
  for (const crack of [[[0.2, 0.05], [0.28, 0.3], [0.22, 0.52], [0.34, 0.8]], [[0.62, 0.12], [0.55, 0.38], [0.68, 0.6], [0.6, 0.95]], [[0.28, 0.3], [0.45, 0.42], [0.55, 0.38]]]) {
    ctx.beginPath();
    crack.forEach(([fx, fy], j) => { const [x, y] = at(fx, fy); if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(231,229,228,0.12)';
  for (const [fx, fy, rx, ry] of [[0.35, 0.2, 0.18, 0.08], [0.75, 0.45, 0.12, 0.1], [0.3, 0.68, 0.14, 0.07]]) {
    const [x, y] = at(fx, fy);
    ctx.beginPath(); ctx.ellipse(x, y, w * rx, h * ry, -0.3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// 預定猛捶（玩家回合）或正在猛捶的預兆：還在的鐘乳石描紅框、往下畫一條會掉下去的虛線，要打的那個平台頂面標出衝擊範圍
// （預定的 next.ledge；正在捶的照那一招的 ledge）。畫在遮光上面（暗的地方也看得到）；預兆時閃得比較快
function drawPoundWarning(ctx, c) {
  const S = c.match.mechState;
  const fx = c.state.fx;
  const casting = fx && fx.action === 'pound' && fx.phase === 'cast';
  if (!casting && !(S && S.next && S.next.action === 'pound' && !fx)) return;
  const e = c.match.byId('cyclops');
  if (!e || !e.alive) return;
  const i = poundLedge(c.match, casting ? fx : S.next);
  if (i === null) return;
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
  const lane = poundLane(c.match, i);
  ctx.fillStyle = `rgba(251,146,60,${pulse * 0.35})`;
  ctx.fillRect(lane.x0, lane.top, lane.x1 - lane.x0, lane.bottom - lane.top);
  ctx.strokeStyle = `rgba(251,146,60,${pulse})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(lane.x0 + 1, lane.top, lane.x1 - lane.x0 - 2, lane.bottom - lane.top);
  ctx.restore();
}

// 要封的那一段（玩家回合：預定的下一招帶 seal；巨人回合播到那一招砸下去之前）：巨石會佔的範圍畫成閃爍的紅色、虛線輪廓，中間寫「超巨石」。
// 封住了就不畫（sealed 裡有了）。畫在遮光上面（暗的地方也看得到）；超巨石飛過來的時候閃得比較快
function drawSealWarning(ctx, c) {
  const S = c.match.mechState;
  const fx = c.state.fx;
  if (!S || !Array.isArray(S.sealed)) return;
  const casting = fx && fx.action === 'seal' && fx.phase === 'cast';
  const i = casting ? fx.ledge : (S.next && Number.isInteger(S.next.seal) ? S.next.seal : null);
  if (!Number.isInteger(i) || S.sealed.includes(i)) return;
  const e = c.match.byId('cyclops');
  if (!e || !e.alive) return;
  const poly = boulderPoly(c.match, i);
  const s = boulderSpan(c.match, i);
  const pulse = casting ? 0.55 + 0.45 * Math.sin(c.time * 18) : 0.35 + 0.25 * Math.sin(c.time * 4);
  ctx.save();
  ctx.beginPath();
  poly.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = `rgba(248,113,113,${pulse * 0.3})`;
  ctx.fill();
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = `rgba(248,113,113,${0.4 + pulse * 0.6})`;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = `rgba(254,202,202,${0.5 + pulse * 0.5})`;
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(CYCLOPS_ACTION_NAMES.seal, (s.x0 + s.x1) / 2, (s.y0 + s.y1) / 2);
  ctx.restore();
}

// 預定震盪獅吼（玩家回合、吸氣的時候）：封住的超巨石輪廓閃黃光（快被擊碎了）
function drawRoarWarning(ctx, c) {
  const S = c.match.mechState;
  const fx = c.state.fx;
  if (!S || !Array.isArray(S.sealed) || !S.sealed.length) return;
  const casting = fx && fx.action === 'roar' && fx.phase === 'cast';
  if (!casting && !(S.next && S.next.action === 'roar' && !fx)) return;
  const pulse = casting ? 0.55 + 0.45 * Math.sin(c.time * 22) : 0.35 + 0.25 * Math.sin(c.time * 4);
  ctx.save();
  ctx.strokeStyle = `rgba(253,224,71,${pulse})`;
  ctx.lineWidth = 3;
  for (const i of S.sealed) {
    ctx.beginPath();
    boulderPoly(c.match, i).forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

// 飛在空中的超巨石（畫在遮光上面：暗的地方也看得到它飛向哪裡）
function drawFlyingRock(ctx, c) {
  const r = flyingRock(c);
  if (r) drawRock(ctx, r.x, r.y, ROCK_R, r.spin);
}

// 震盪獅吼吼出去的那一下：從他的頭往外擴散的幾圈震波（畫在遮光上面），1.2 秒內淡掉
function drawRoarRings(ctx, c) {
  const fx = c.state.fx;
  if (!fx || fx.action !== 'roar' || fx.phase !== 'act' || fx.at > 1.2) return;
  const e = c.match.byId('cyclops');
  if (!e) return;
  const speed = CONFIG.WEAPONS.cyclopsRoar.speed;
  const x = e.x + e.facing * 3, y = e.y - e.h * 0.68;
  ctx.save();
  for (let k = 0; k < 4; k++) {
    const r = (fx.at - k * 0.08) * speed;
    if (r <= 0) continue;
    const a = Math.max(0, 1 - fx.at / 1.2) * (1 - k * 0.2);
    ctx.strokeStyle = `rgba(253,230,138,${a * 0.7})`;
    ctx.lineWidth = 6 - k;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

// 巨石投擲的預兆：每個目標（fx.targetIds，還活著的）身上一圈閃爍的準星 + 四個轉動的刻度（畫在遮光上面，暗的地方也看得到）。
// 只在預兆時畫：巨石丟出去之後就不畫了
function drawThrowMarks(ctx, c) {
  const fx = c.state.fx;
  if (!fx || fx.action !== 'throw' || fx.phase !== 'cast' || !fx.targetIds.length) return;
  const pulse = 0.6 + 0.4 * Math.sin(c.time * 22);
  const spin = c.time * 1.5;
  ctx.save();
  ctx.strokeStyle = `rgba(248,113,113,${pulse})`;
  ctx.lineWidth = 2.5;
  for (const id of fx.targetIds) {
    const t = c.match.byId(id);
    if (!t || !t.alive) continue;
    const r = Math.max(t.h, 2 * t.hw) * 0.75 + 6;
    ctx.beginPath(); ctx.arc(t.x, t.cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = spin + k * Math.PI / 2, ux = Math.cos(a), uy = Math.sin(a);
      ctx.moveTo(t.x + ux * (r - 6), t.cy + uy * (r - 6));
      ctx.lineTo(t.x + ux * (r + 7), t.cy + uy * (r + 7));
    }
    ctx.stroke();
  }
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

// 猛捶的衝擊：一圈圈往前推的震波（跑到平台的盡頭就停：range，見 shared/maps/cyclops.js 的 poundStep）
function drawShock(ctx, c, p) {
  const lane = laneAt(c, p);
  if (!lane) return;
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

// 震盪獅吼的震波（每個玩家一道，水平衝向他）：往前的三道弧，越後面越淡
function drawRoarWave(ctx, p) {
  const dir = p.vx >= 0 ? 1 : -1;
  ctx.save();
  for (let k = 0; k < 3; k++) {
    ctx.strokeStyle = `rgba(253,230,138,${0.75 - k * 0.22})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x - dir * k * 9, p.y, 10 + k * 3, dir > 0 ? -0.9 : Math.PI - 0.9, dir > 0 ? 0.9 : Math.PI + 0.9);
    ctx.stroke();
  }
  ctx.restore();
}
