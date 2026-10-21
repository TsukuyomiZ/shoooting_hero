import { CONFIG } from '../../shared/core/config.js';
import { SWORDSMAN_ACTION_NAMES, qiBand } from '../../shared/maps/swordsman.js';
import { nearestPlayerAt } from '../../shared/maps/mechanics/common.js';

// 菁英關「流浪劍士」的地圖畫面：劍士回合的動畫腳本（照伺服器廣播的招式播：一閃 = 握刀柄蓄力、一揮，線從刀口劃出去，刀光沿著每一道線一起斬過去；
// 格擋架勢 = 刀舉在身前；反擊的一閃 = 一道線對準第一個打中他的人、比較快；拔刀 = 一道刀氣直線飛向目標）、
// 劍士（斗笠、黑色長大衣、紅領帶、藍色的獨眼、身上冒黑煙，一手刀一手刀鞘）與招式的繪圖、預定一閃 / 拔刀時一直握著刀柄（一抽到就擺；一閃蹲低一點）、
// 預定一閃的預警線（對每一位玩家各一道，虛線 + 打得到的寬度；只有一般難度畫，c.rangeHints）、
// 劍氣：浮在右邊還沒出發的（旁邊標出發的順序，最前面的那一道最亮）、玩家回合裡慢慢往左飛的那一道（hazard：照真實時間飛，伺服器的 hazard 訊息校正位置）、
// 回合收尾時一口氣掃完剩下那段（turnVolley）、飛完馬上再揮一輪（劍士揮三刀、月牙飛到右邊浮著）；格擋時被打中冒火花、倒下的特效。
// 規則在 shared/maps/swordsman.js；掛勾的說明見 index.js
const FPS = 60;
const COAT = '#15171e', COAT_EDGE = '#9ca3af', PANTS = '#1f2230', SHIRT = '#e5e7eb', TIE = '#b91c1c', STRAW = '#a38b5d', STRAW_DARK = '#6b5a3a';
const BLADE = '#e2e8f0', QI = '125,211,252', EYE = '96,165,250';
const DRAW_IN = 0.3;        // 抽到一閃 / 拔刀之後幾秒擺好握刀柄的架勢（秒）
const PARRY_IN = 0.25;      // 擺格擋架勢要幾秒（秒，畫面）
const IAI_SHAKE = 0.3;      // 一閃出刀前最後這麼久（秒）在發抖蓄力（反擊的一閃）
const TRACE = [0.5, 0.85];  // 一閃：播到這幾成之間線從刀口一路劃出去（之前握刀柄蓄力），預兆播完一起斬下去
const SWINGS = [0.1, 0.35, 0.6];      // 再揮一輪劍氣：揮三刀的時間點（秒），每一刀飛出一道月牙
const RECAST = 0.9;         // 再揮一輪劍氣的動作多久（秒）
const CRESCENT_FLY = 0.3;   // 月牙飛到右邊浮著的地方要幾秒
const FLASH = 0.5;          // 一閃斬下去的刀光留在線上多久（秒）
const BURST = 0.45;         // 劍氣發動時右邊那一排亮一下多久（秒）
const DRAW_AT = 0.8;        // 拔刀的預兆播到幾成時拔出去

export const swordsman = {
  type: 'swordsman',

  // 這一場的畫面狀態：
  //   fx         劍士出招的預兆 { action, t, phase: 'cast' | 'act', step, cast, draw0 }（劍士回合播完就清掉；draw0 = 開始出招時拔刀架勢擺到哪裡）
  //   draw       預定一閃 / 拔刀時握刀柄架勢的程度（0..1，update 照遊戲時間推進）
  //   parry      格擋架勢的程度（0..1，update 推進；機制狀態 mechState.parry 在不在決定往哪邊走）
  //   crescents  劍氣揮出去、還在往右邊飛的月牙 [{ x0, y0, x1, y1, t, idx }]（飛到就浮在那一排：推進 mechState.qi）
  //   flash      一閃斬下去的刀光 { lines: [[x0, y0, x1, y1]…], t }；burst = 劍氣出發時右邊那一排亮一下 { row, t }
  //   recast     劍氣飛完、再揮一輪的動作 { t, rows, sent }（sent = 已經揮出去幾道）
  // 正在飛的那一道劍氣在機制狀態 mechState.flying（{ row, x, speed, x0, t0 }：x0 / t0 = 從哪裡、真實時間幾秒（c.clock()）出發，update 照真實時間算 x）；
  // 預定一閃的預警線在 mechState.next.lines（伺服器抽到的時候劃好的，跟著 boss.next / 快照來）
  create: () => ({ fx: null, draw: 0, parry: 0, crescents: [], flash: null, burst: null, recast: null }),

  turnScript: swordsmanTurnScript,
  // 播到一半丟掉：出招的姿勢、還在飛的月牙（直接浮到定位：伺服器那邊已經揮出去了）、刀光都清掉
  abortScript(c) {
    finishRecast(c);
    landCrescents(c);
    c.state.fx = null;
    c.state.flash = null;
  },
  onDeath: onSwordsmanDeath,

  // 架勢照遊戲時間推進（預定一閃 / 拔刀 → 握刀柄、格擋中 → 舉刀），月牙往右邊飛、刀光 / 出發的亮光淡掉、再揮一輪的動作；
  // 正在飛的劍氣照真實時間往左（c.clock()：卡頓、自己開著慢動作也跟伺服器一樣快）。畫圖只讀狀態
  update(c, dt) {
    const st = c.state;
    const S = c.match.mechState;
    const g = c.match.byId('swordsman');
    const alive = !!(g && g.alive);
    const plan = !st.fx && alive && S && S.next && !S.parry ? S.next.action : null;
    const grip = plan === 'iai' || plan === 'draw';
    if (grip && st.draw === 0) c.fx.sound('step', { x: g.x });
    st.draw = grip ? Math.min(1, st.draw + dt / DRAW_IN) : 0;
    st.parry = alive && S && S.parry ? Math.min(1, st.parry + dt / PARRY_IN) : Math.max(0, st.parry - dt / PARRY_IN);
    const F = S && S.flying;
    if (F) {
      if (!Number.isFinite(F.t0)) { F.x0 = F.x; F.t0 = c.clock(); }   // 重連時快照給的（只有 x）：從現在這裡接著飛
      F.x = Math.max(0, F.x0 - F.speed * Math.max(0, c.clock() - F.t0));
    }
    if (st.recast) {
      st.recast.t += dt;
      while (g && st.recast.sent < st.recast.rows.length && st.recast.t >= SWINGS[Math.min(st.recast.sent, SWINGS.length - 1)]) {
        launchCrescent(c, g, st.recast.rows[st.recast.sent++]);
      }
      if (st.recast.t >= RECAST) finishRecast(c);
    }
    for (const m of st.crescents) m.t += dt / CRESCENT_FLY;
    while (st.crescents.length && st.crescents[0].t >= 1) landCrescent(c, st.crescents.shift());
    if (st.flash && (st.flash.t += dt) >= FLASH) st.flash = null;
    if (st.burst && (st.burst.t += dt) >= BURST) st.burst = null;
  },

  // 回合收尾時劍氣還沒飛完（伺服器的 hazardFinish）：慢慢飛的那一道換成重播的飛行物（drawProjectile 畫），一口氣掃完剩下那段；飛完再揮一輪的話接著演
  turnVolley(c, shot) {
    if (shot.kind !== 'swordQi') return null;
    const S = c.match.mechState;
    if (S) S.flying = null;
    syncQi(c, shot.hover, shot.recast);
    return { banner: (name) => `${name}的劍氣一口氣斬過！`, color: '#7dd3fc' };
  },

  // 玩家回合裡的危險物（伺服器的 hazard*：劍氣）。msg.start（跟著 turn 來）——劍氣出發（浮著的換成剩下的、那一排右邊亮一下、開始往左飛，
  // 從收到 turn 的時刻 msg.recvAt 算）。
  // 伺服器的 hazard——畫面的部分收到就演（early：GameView 收到的那一刻，佇列前面可能還在播這個回合的開火 / AI 代打；照順序套用時再叫一次就不重演）：
  // 劍氣的位置往伺服器那邊校正（只往前：畫面晚到的就追上）、飛完就收掉（再揮一輪的話接著演）；
  // 照順序套用時（early false，扣血與飄字 GameView 剛處理完）：打到的人身上噴碎光
  hazard(c, msg, early = false) {
    const S = c.match.mechState;
    if (!S) return;
    const at = Number.isFinite(msg.recvAt) ? msg.recvAt : c.clock();
    if (msg.start) {
      const h = msg.start;
      if (h.kind === 'swordsman' && h.qi) launchQi(c, h.qi, at);
      return;
    }
    if (msg.kind !== 'swordsman') return;
    if (!msg.shown) {
      msg.shown = true;
      const q = msg.qi;
      const F = S.flying;
      if (q && F && Number.isFinite(q.x) && Number.isFinite(F.t0)) {   // 伺服器說收到這則時它在 q.x：畫面比它慢的話追上（只往前調）
        F.t0 = Math.min(F.t0, at - (F.x0 - q.x) / F.speed);
      }
      if (q && q.done) {
        S.flying = null;
        syncQi(c, q.hover, q.recast);
      }
    }
    if (early) return;
    for (const d of msg.damages || []) {
      const e = c.match.byId(d.id);
      if (e && d.dmg > 0) c.fx.particles(e.x, e.cy, 10, { speed: 200, life: 0.4, size: 2.5, color: '#e0f2fe', gravity: 300 });
    }
    if (msg.damages && msg.damages.length) c.fx.shake(5);
  },

  // 一閃 / 劍氣 / 拔刀砍到人：刀光的碎屑；格擋中被玩家打中：刀上冒火花（機制狀態的次數照伺服器的規則跟著數）
  showEvent(c, ev) {
    const p = c.projectiles.find(q => q.i === ev.p);
    const id = p && p.weapon && p.weapon.id;
    if ((id === 'swordsmanIai' || id === 'swordsmanQi' || id === 'swordsmanDraw') && ev.damages && ev.damages.some(d => d.dmg > 0)) {
      c.fx.shake(id === 'swordsmanQi' ? 4 : 6);
      c.fx.particles(ev.x, ev.y, 10, { speed: 200, life: 0.4, size: 2.5, color: id === 'swordsmanQi' ? '#bae6fd' : '#f1f5f9', gravity: 300 });
    }
    const g = c.match.byId('swordsman');
    const S = c.match.mechState;
    if (g && S && S.parry && ev.damages && ev.damages.some(d => d.id === g.id && d.dmg > 0 && !d.friendly)) {
      S.parry.hits++;
      c.fx.sound('clang', { x: g.x });
      c.fx.particles(g.x + g.facing * 14, g.cy - 6, 9, { speed: 170, life: 0.35, size: 2.5, color: '#fde68a', gravity: 300 });
    }
  },

  // 劍士：自己畫身體（含影子；不畫一般的武器），血條、名字照一般的畫
  drawEntity(ctx, c, e, hurt) {
    if (e.part !== 'swordsman') return false;
    drawSwordsman(ctx, c, e, hurt);
    return 'body';
  },
  hpBar: (c, e) => (e.part === 'swordsman' ? { w: 100, h: 8 } : null),

  drawProjectile(ctx, c, p) {
    const id = p.weapon.id;
    if (id === 'swordsmanIai') { drawIaiEdge(ctx, c, p); return true; }
    if (id === 'swordsmanQi') { drawQiWave(ctx, c, p); return true; }
    if (id === 'swordsmanDraw') { drawDrawWave(ctx, p); return true; }
    return false;
  },

  // 地上的東西（角色之前畫）：一閃的線（預定時的預警線、出招時正在劃的）、斬下去的刀光、浮在右邊還沒發動的劍氣、發動時的亮光、還在飛的月牙
  drawScene(ctx, c) {
    drawIaiLines(ctx, c);
    drawSlashFlash(ctx, c);
    drawQiHover(ctx, c);
    drawQiFlying(ctx, c);
    drawQiBurst(ctx, c);
    for (const m of c.state.crescents) drawCrescent(ctx, m);
  },

  // 一般那一行（敵人剩餘）+ 劍士的血量、預定的下一招各一行；擺著格擋架勢再一行（減傷）
  hud(c, line) {
    const lines = [line];
    const e = c.match.byId('swordsman');
    const S = c.match.mechState;
    if (e && e.alive && S) {
      lines.push([`流浪劍士 ${e.hp} / ${e.maxHp}`, '#fca5a5']);
      if (S.next) lines.push([`下一招：${SWORDSMAN_ACTION_NAMES[S.next.action] || S.next.action}`, '#fca5a5']);
      if (S.parry) lines.push([`格擋架勢（減傷 ${CONFIG.SWORDSMAN.parryCut}%）`, '#93c5fd']);
    }
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 劍士的回合（走完之後）：上一回合的格擋架勢到這裡放下（同伺服器），轉向——第一招是一閃（反擊 / 預定的）就照它出刀的方向
// （預定的一閃照預警線，預警線從那邊的刀口出發；不先轉向最近的人再轉回來），不然轉向最近的人；一招一招照順序播（反擊的一閃 → 預定的那一招），
// 全部播完才換上伺服器預定的下一招（msg.boss.next）
function* swordsmanTurnScript(c, msg) {
  const S = c.match.mechState;
  const g = c.match.byId(msg.actorId);
  if (S) S.parry = null;
  const first = msg.boss.steps[0];
  if (g && first && first.action === 'iai' && (first.facing === 1 || first.facing === -1)) g.facing = first.facing;
  else if (g) {
    const near = nearestPlayerAt(c.match, g.cx, g.cy);
    if (near && near.x !== g.x) g.facing = near.x > g.x ? 1 : -1;
  }
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* stepScript(c, msg.actorId, step);
  c.state.fx = null;
  if (S && msg.boss.next !== undefined) S.next = msg.boss.next ? { ...msg.boss.next } : null;
}

// 一招：預兆（一閃：蹲低握著刀柄，播到 TRACE 一揮、每一道線從刀口一路劃出去（反擊的一閃：握刀柄發抖）；
// 格擋：把刀舉到身前；拔刀：握著刀柄、轉向目標）→ 出招（照 shotScript 重播；一閃：一聲「鏘」、每一道線一起一道白光）→ 校正
function* stepScript(c, id, b) {
  const match = c.match;
  const g = match.byId(id);
  const S = match.mechState;
  const cast = Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS);
  const fx = c.state.fx = { action: b.action, t: 0, phase: 'cast', step: b, cast: cast / FPS, draw0: c.state.draw, trace: 0 };
  const target = b.targetId ? match.byId(b.targetId) : null;
  const lines = iaiLinesOf(b);
  if (g && b.action === 'iai' && (b.facing === 1 || b.facing === -1)) g.facing = b.facing;   // 同伺服器：照預警線出刀的方向
  else if (g && b.action === 'draw' && target && target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
  const N = SWORDSMAN_ACTION_NAMES;
  const foe = b.counter && Array.isArray(b.targetIds) ? match.byId(b.targetIds[0]) : null;   // 反擊：對準第一個打中他的人
  if (b.action === 'iai') c.fx.banner(b.counter ? `流浪劍士：反擊・${N.iai}！${foe ? ` → ${foe.name}` : ''}` : `流浪劍士：${N.iai}！`, '#e0f2fe');
  else if (b.action === 'parry') c.fx.banner(`流浪劍士：${N.parry}`, '#93c5fd');
  else if (b.action === 'draw') c.fx.banner(`流浪劍士：${N.draw}！`, '#e0f2fe');
  else c.fx.banner(`流浪劍士${N.idle}中`, '#e9d5ff');

  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    if (g && b.action === 'iai' && i === 0 && b.counter) {   // 反擊：眼睛一亮
      c.fx.particles(g.x + g.facing * 4, g.y - g.h * 0.84, 6, { speed: 80, life: 0.3, size: 2, color: '#93c5fd', gravity: 0 });
    }
    if (g && b.action === 'iai' && b.counter && i >= cast - IAI_SHAKE * FPS && i % 6 === 0) {   // 反擊蓄力：腳邊揚起一點塵土
      c.fx.particles(g.x - g.facing * 6, g.y - 1, 2, { speed: 60, life: 0.35, size: 2, color: '#a8a29e', gravity: 400 });
    }
    if (g && b.action === 'iai' && lines.length) {   // 一揮（破風聲），每一道線從刀口一路劃出去
      const k = (i / cast - TRACE[0]) / (TRACE[1] - TRACE[0]);
      if (i === Math.round(cast * TRACE[0])) c.fx.sound('heave', { x: g.x });
      fx.trace = Math.max(0, Math.min(1, k));
    }
    if (g && b.action === 'parry' && i === Math.round(cast * 0.6)) c.fx.sound('clang', { x: g.x, vol: 0.6 });
    yield { frames: 1 };
  }
  fx.phase = 'act';
  if (b.shot) {
    if (b.action === 'iai' && g && lines.length) {   // 一閃：一聲「鏘」、畫面一震，刀光沿著每一道線飛過去、留一道白光
      c.state.flash = { lines: lines.map(L => [L.x0, L.y0, L.x1, L.y1]), t: 0 };
      c.fx.sound('iai', { x: g.x });
      c.fx.shake(8);
    }
    if (b.action === 'draw' && g) {   // 拔刀：一聲「鏘」，刀氣從他身上飛出去
      c.fx.sound('iai', { x: g.x, vol: 0.8 });
      c.fx.shake(4);
    }
    yield* c.shotScript(b.shot);
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
  if (b.action === 'parry' && S) S.parry = { hits: 0, need: b.need, by: [] };
}

// 一閃的線（招式的 lines = [[x0, y0, x1, y1]…]）→ [{ x0, y0, x1, y1 }]；不是一閃 / 沒有 = []
function iaiLinesOf(b) {
  if (!b || b.action !== 'iai' || !Array.isArray(b.lines)) return [];
  return b.lines.filter(L => Array.isArray(L) && L.length === 4).map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1 }));
}

// 劍氣出發（玩家的回合開始）：q = { row, x, speed, hover }，at = 收到的時刻（真實時間）
function launchQi(c, q, at) {
  const S = c.match.mechState;
  S.flying = { row: q.row, x: q.x, speed: q.speed, x0: q.x, t0: at };
  if (Array.isArray(q.hover)) {   // 浮著的照伺服器的：還在揮 / 還在飛的月牙先收尾（不然落地時又推一次，浮著的會多出來）
    finishRecast(c);
    landCrescents(c);
    S.qi = q.hover.slice();
  }
  const band = qiBand(c.match, q.row);
  if (band) {
    c.state.burst = { row: q.row, t: 0 };
    c.fx.sound('iai', { x: band.qx, vol: 0.6 });
    c.fx.particles(band.qx, band.y, 12, { speed: 160, life: 0.45, size: 2.5, color: '#bae6fd', gravity: 100 });
  }
}

// 揮出一道月牙：從刀尖飛到地圖右邊第 idx 排的高度浮著（qiBand 的 qx）
function launchCrescent(c, g, idx) {
  const band = qiBand(c.match, idx);
  if (!band) return;
  c.fx.sound('heave', { x: g.x, vol: 0.7 });
  c.state.crescents.push({ x0: g.x + g.facing * 20, y0: g.y - g.h * 0.6, x1: band.qx, y1: band.y, t: 0, idx });
}

// 月牙飛到了：右邊多一道浮著的劍氣（接在還沒發動的後面）
function landCrescent(c, m) {
  const S = c.match.mechState;
  if (S) S.qi.push(m.idx);
  c.fx.particles(m.x1, m.y1, 8, { speed: 120, life: 0.4, size: 2, color: '#bae6fd', gravity: 100 });
}
function landCrescents(c) {
  while (c.state.crescents.length) landCrescent(c, c.state.crescents.shift());
}

// 浮著的劍氣照伺服器的（hover）；剛再揮一輪的（recast）先拿掉，照劍士揮刀的動作一道一道飛過去才浮上去（landCrescent 照順序推回來）
function syncQi(c, hover, recastRows) {
  const S = c.match.mechState;
  if (!S || !Array.isArray(hover)) return;
  finishRecast(c);
  landCrescents(c);
  const recast = Array.isArray(recastRows) ? recastRows : [];
  S.qi = hover.slice(0, hover.length - recast.length);
  const g = c.match.byId('swordsman');
  if (!recast.length) return;
  if (!g || !g.alive) { S.qi.push(...recast); return; }
  c.state.recast = { t: 0, rows: recast.slice(), sent: 0 };
  c.fx.banner('流浪劍士揮出新的劍氣！', '#7dd3fc');
}

// 再揮一輪的動作播完（或被打斷）：還沒揮出去的直接飛過去
function finishRecast(c) {
  const R = c.state.recast;
  if (!R) return;
  c.state.recast = null;
  const g = c.match.byId('swordsman');
  while (R.sent < R.rows.length) {
    const idx = R.rows[R.sent++];
    if (g) launchCrescent(c, g, idx);
    else if (c.match.mechState) c.match.mechState.qi.push(idx);
  }
}

// 劍士倒下：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
function onSwordsmanDeath(c, e) {
  if (e.part !== 'swordsman') return false;
  const S = c.match.mechState;   // 劍氣都跟著消失（伺服器不會再出手）；預警線看劍士活著才畫
  if (S) { S.flying = null; S.qi = []; }
  c.state.recast = null;
  c.state.crescents = [];
  c.fx.banner('流浪劍士倒下了！', '#c084fc');
  c.fx.shake(10);
  c.fx.sound('clang', { x: e.x });
  c.fx.particles(e.x, e.cy, 28, { speed: 150, life: 1.3, size: 4, color: '#18181b', gravity: -40 });
  c.fx.particles(e.x, e.cy - 20, 10, { speed: 120, life: 0.8, size: 2.5, color: '#93c5fd', gravity: 0 });
  return true;
}

// ---------- 姿勢 ----------

// 現在的姿勢：lean = 上半身往前傾（弧度）、crouch = 蹲低（0..1）、blade = 刀的握法、shake = 蓄力發抖、glow = 眼睛多亮（0..1）
//   idle  = 刀尖朝前下方垂著、刀鞘在後手；draw = 刀收在鞘裡、刀鞘橫在腰間、前手握著刀柄（拔刀的架勢）；
//   flash = 拔刀斬過去之後刀往前平伸；parry = 刀斜斜舉在身前（刀尖朝上）；swing = 揮劍氣（刀照揮到哪裡轉）
function poseOf(c, e) {
  const st = c.state;
  const fx = st.fx;
  if (fx && fx.action === 'iai') {
    const aim = aimAngle(e, iaiLinesOf(fx.step));
    if (fx.phase === 'cast' && (fx.step.counter || fx.t < fx.cast * TRACE[0])) {   // 握著刀柄蓄力（反擊：最後發抖）
      const k = Math.min(1, (fx.draw0 || 0) + fx.t / Math.max(0.05, fx.cast * 0.35));
      return { lean: 0.22 * k, crouch: 0.1 * k, blade: 'draw', draw: k, shake: !!fx.step.counter && fx.t >= fx.cast - IAI_SHAKE, glow: 0.6 + 0.4 * k };
    }
    return { lean: 0.25, crouch: 0.06, blade: 'swing', angle: aim, glow: 1 };   // 一揮之後：刀指著軌跡的方向
  }
  if (fx && fx.action === 'draw') {   // 拔刀：握著刀柄（預兆），拔出去之後刀指著目標
    if (fx.phase === 'cast') {
      const k = Math.min(1, (fx.draw0 || 0) + fx.t / Math.max(0.05, fx.cast * 0.35));
      return { lean: 0.1 * k, crouch: 0.04 * k, blade: 'draw', draw: k, shake: fx.t >= fx.cast * DRAW_AT, glow: 0.6 + 0.4 * k };
    }
    const t = c.match.byId(fx.step.targetId);
    const f = e.facing || -1;
    const angle = t ? Math.atan2(t.cy - (e.y - e.h * 0.6), (t.x - e.x) * f || 1) : 0;
    return { lean: 0.2, crouch: 0.04, blade: 'swing', angle: Math.max(-1.3, Math.min(1.3, angle)), glow: 1 };
  }
  if (fx && fx.action === 'parry' && fx.phase === 'cast') return { lean: -0.05, crouch: 0.05, blade: 'parry', parry: Math.min(1, fx.t / (fx.cast * 0.6)), glow: 0.6 };
  if (!fx && st.recast) {   // 再揮一輪劍氣：一刀往下劈、一刀往上撩，揮三刀
    const t = st.recast.t;
    const swing = SWINGS.reduce((a, s) => (t >= s - 0.06 ? a + 1 : a), 0);
    const local = Math.max(0, Math.min(1, (t - (SWINGS[Math.max(0, swing - 1)] - 0.06)) / 0.12));
    const up = swing % 2 === 1;
    const angle = swing === 0 ? -1.2 : up ? -1.2 + 2.4 * local : 1.2 - 2.4 * local;
    return { lean: 0.15, crouch: 0.04, blade: 'swing', angle, glow: 0.8 };
  }
  if (st.parry > 0) return { lean: -0.05, crouch: 0.05 * st.parry, blade: 'parry', parry: st.parry, glow: 0.6 };
  if (st.draw > 0) {   // 預定一閃：蹲低握著刀柄；預定拔刀：站著握刀柄
    const k = 1 - (1 - st.draw) * (1 - st.draw);
    const low = !(c.match.mechState && c.match.mechState.next && c.match.mechState.next.action === 'draw');
    return { lean: (low ? 0.18 : 0.08) * k, crouch: (low ? 0.08 : 0.03) * k, blade: 'draw', draw: k, glow: 0.5 + 0.3 * k };
  }
  return { lean: 0, crouch: 0, blade: 'idle', glow: 0.45 };
}

// 刀指著一閃的線的方向（好幾道就指著平均的方向；身體座標的角度：0 = 正前方、正的往下；太陡的夾到 ±1.3）
function aimAngle(e, lines) {
  const f = e.facing || -1;
  let sx = 0, sy = 0;
  for (const L of lines) {
    const dx = (L.x1 - L.x0) * f, dy = L.y1 - L.y0;
    const d = Math.hypot(dx, dy) || 1;
    sx += dx / d; sy += dy / d;
  }
  if (!lines.length || (sx === 0 && sy === 0)) return 0;
  return Math.max(-1.3, Math.min(1.3, Math.atan2(sy, sx || 1e-6)));
}

// ---------- 繪圖 ----------

// 流浪劍士（照使用者給的圖）：大斗笠蓋住臉、斗笠底下透出一隻發藍光的眼睛，黑色長大衣（灰白滾邊）、白襯衫紅領帶，
// 前手一把武士刀、後手黑色刀鞘，全身冒著一縷一縷的黑煙。面向右的身體座標（腳底中心是原點、身高 64）
function drawSwordsman(ctx, c, e, hurt) {
  const pose = poseOf(c, e);
  const f = e.facing || -1;
  const s = e.h / 64;
  const t = c.time;
  const fill = (col) => (hurt ? '#ffffff' : col);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';   // 腳下的影子
  ctx.beginPath(); ctx.ellipse(e.x, e.y + 1, e.hw + 6, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.translate(e.x + (pose.shake ? Math.sin(t * 70) * 1.2 : 0), e.y);
  ctx.scale(s * f, s * (1 - pose.crouch));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (!hurt) drawSmoke(ctx, t, 1);   // 身後的黑煙
  // 腿（大衣下襬底下露出來的西裝褲、皮鞋；蹲低時兩腳張開一點）
  const spread = 2 * (pose.crouch / 0.1);
  ctx.fillStyle = fill(PANTS);
  ctx.fillRect(-6 - spread, -22, 4.5, 21);
  ctx.fillRect(1.5 + spread, -22, 4.5, 21);
  ctx.fillStyle = fill('#0a0a0a');
  ctx.beginPath(); ctx.ellipse(-3.5 - spread, -1.5, 4.5, 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(5 + spread, -1.5, 4.8, 2, 0, 0, Math.PI * 2); ctx.fill();
  // 上半身以腰為支點往前傾
  ctx.translate(0, -22);
  ctx.rotate(pose.lean);
  ctx.translate(0, 22);
  // 後手的刀鞘（拔刀的架勢：橫在腰間；其他時候斜斜往後下方垂著）
  if (pose.blade !== 'draw') drawSheath(ctx, -6, -31, 2.25, hurt, false);
  // 大衣：肩膀往下張開到小腿，下襬破破爛爛、隨風擺
  ctx.fillStyle = fill(COAT);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-9, -47);
  ctx.lineTo(9, -47);
  ctx.quadraticCurveTo(12, -34, 13, -13);
  for (let k = 0; k <= 6; k++) {   // 下襬：鋸齒一樣的破邊，照時間擺動
    const x = 13 - k * (27 / 6);
    const y = -12 + (k % 2 ? 3 : 0) + Math.sin(t * 4 + k * 1.3) * 1.2;
    ctx.lineTo(x - Math.sin(t * 3 + k) * 0.8, y);
  }
  ctx.quadraticCurveTo(-12, -34, -9, -47);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  if (!hurt) {
    ctx.strokeStyle = 'rgba(156,163,175,0.75)';   // 大衣的灰白滾邊
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-6.5, -44); ctx.quadraticCurveTo(-9, -30, -9.5, -13); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(9.5, -43); ctx.quadraticCurveTo(11.5, -30, 12, -14); ctx.stroke();
    ctx.fillStyle = '#2a2d36';   // 背心
    ctx.beginPath(); ctx.moveTo(2, -45.5); ctx.lineTo(8, -45.5); ctx.lineTo(8.5, -24); ctx.lineTo(3, -24); ctx.closePath(); ctx.fill();
    ctx.fillStyle = SHIRT;       // 襯衫領口
    ctx.beginPath(); ctx.moveTo(3, -46.5); ctx.lineTo(8.5, -46.5); ctx.lineTo(5.8, -40.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = TIE;         // 紅領帶
    ctx.beginPath(); ctx.moveTo(5, -44); ctx.lineTo(6.6, -44); ctx.lineTo(7, -33); ctx.lineTo(5.8, -31.5); ctx.lineTo(4.6, -33); ctx.closePath(); ctx.fill();
  }
  // 頭（幾乎都被斗笠遮住）、斗笠底下的藍色獨眼
  ctx.fillStyle = fill('#111114');
  ctx.beginPath(); ctx.ellipse(1.5, -51, 5, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  if (!hurt) {
    const glow = pose.glow * (0.85 + 0.15 * Math.sin(t * 5));
    const g = ctx.createRadialGradient(4.6, -51.2, 0, 4.6, -51.2, 7);
    g.addColorStop(0, `rgba(${EYE},${0.9 * glow})`);
    g.addColorStop(1, `rgba(${EYE},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(4.6, -51.2, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = `rgba(219,234,254,${0.6 + 0.4 * glow})`;
    ctx.beginPath(); ctx.ellipse(4.6, -51.2, 1.8, 1.1, 0, 0, Math.PI * 2); ctx.fill();
  }
  // 斗笠：寬大的圓錐，草編的放射紋、邊緣有點破
  ctx.fillStyle = fill(STRAW);
  ctx.strokeStyle = fill(STRAW_DARK);
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(-19, -54.5);
  ctx.quadraticCurveTo(-6, -62, 0, -68);
  ctx.quadraticCurveTo(6, -62, 19, -54.5);
  ctx.quadraticCurveTo(10, -52.5, 0, -53);
  ctx.quadraticCurveTo(-10, -52.5, -19, -54.5);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  if (!hurt) {
    ctx.strokeStyle = 'rgba(80,64,36,0.55)';
    ctx.lineWidth = 0.8;
    for (const bx of [-13, -7, -2, 3, 8, 14]) { ctx.beginPath(); ctx.moveTo(0, -67); ctx.lineTo(bx, -53.5); ctx.stroke(); }
    drawSmoke(ctx, t + 1.7, 0.6, -16, -54);   // 斗笠邊緣也冒煙
  }
  // 前手與刀
  drawBlade(ctx, pose, hurt, t);
  ctx.restore();
}

// 前手、武士刀（與拔刀架勢時橫在腰間的刀鞘）。身體座標（面向右）
function drawBlade(ctx, pose, hurt, t) {
  const arm = () => { ctx.strokeStyle = hurt ? '#fff' : COAT; ctx.lineWidth = 4.5; };
  if (pose.blade === 'draw') {   // 刀收在鞘裡、刀鞘橫在腰間（鞘口朝前），前手握住刀柄、後手按著鞘口
    drawSheath(ctx, -14, -27, -0.08, hurt, true);
    arm();
    ctx.beginPath(); ctx.moveTo(6, -44); ctx.quadraticCurveTo(14, -36, 17, -30); ctx.stroke();   // 前手伸到刀柄
    drawKatana(ctx, 12, -28.5, -0.08, 0, hurt);   // 只露出刀柄
    return;
  }
  let hx, hy, angle;
  if (pose.blade === 'flash') { hx = 18; hy = -38; angle = -0.08; }
  else if (pose.blade === 'parry') { const k = pose.parry ?? 1; hx = 9 + 3 * k; hy = -32 - 4 * k; angle = 1.15 + (-1.25 - 1.15) * k; }
  else if (pose.blade === 'swing') { hx = 13; hy = -38; angle = pose.angle; }
  else { hx = 10; hy = -29 + Math.sin(t * 1.5) * 0.4; angle = 1.1; }
  arm();
  ctx.beginPath(); ctx.moveTo(6, -44); ctx.quadraticCurveTo(hx - 2, -38, hx, hy); ctx.stroke();   // 前手
  drawKatana(ctx, hx, hy, angle, 38, hurt);
  if (pose.blade === 'flash' && !hurt) {   // 刀身的殘光
    ctx.strokeStyle = 'rgba(224,242,254,0.35)';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(hx, hy + 8); ctx.lineTo(hx + 40, hy + 3); ctx.stroke();
  }
}

// 武士刀：握的地方在 (hx, hy)，往 angle 的方向（弧度，0 = 正前方、正的往下）伸出 len px 的刀身（len 0 = 收在鞘裡只畫刀柄）
function drawKatana(ctx, hx, hy, angle, len, hurt) {
  const ux = Math.cos(angle), uy = Math.sin(angle);
  ctx.strokeStyle = hurt ? '#ddd' : '#1c1917';   // 刀柄（往後 8 px）
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(hx - ux * 8, hy - uy * 8); ctx.lineTo(hx + ux * 2, hy + uy * 2); ctx.stroke();
  ctx.fillStyle = hurt ? '#fff' : '#a16207';    // 護手
  ctx.beginPath(); ctx.ellipse(hx + ux * 2.5, hy + uy * 2.5, 1.4, 3.2, angle, 0, Math.PI * 2); ctx.fill();
  if (!(len > 0)) return;
  ctx.strokeStyle = hurt ? '#fff' : BLADE;       // 刀身：微微彎的細長一條，刀尖收尖
  ctx.lineWidth = 2.2;
  const bx = hx + ux * len, by = hy + uy * len;
  ctx.beginPath();
  ctx.moveTo(hx + ux * 3, hy + uy * 3);
  ctx.quadraticCurveTo(hx + ux * len * 0.6 - uy * 2.5, hy + uy * len * 0.6 + ux * 2.5, bx, by);
  ctx.stroke();
  if (!hurt) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';   // 刀刃的反光
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(hx + ux * 8, hy + uy * 8); ctx.lineTo(hx + ux * len * 0.8, hy + uy * len * 0.8); ctx.stroke();
  }
}

// 黑色刀鞘：從 (x, y) 往 angle 的方向 30 px（level = 橫在腰間：鞘口在前面那一端）
function drawSheath(ctx, x, y, angle, hurt, level) {
  const len = level ? 30 : 32;
  const ux = Math.cos(angle), uy = Math.sin(angle);
  ctx.strokeStyle = hurt ? '#eee' : '#0c0a09';
  ctx.lineWidth = 3.4;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + ux * len, y + uy * len); ctx.stroke();
  ctx.strokeStyle = hurt ? '#fff' : '#a16207';   // 鞘口的金屬環
  ctx.lineWidth = 3.6;
  const ex = level ? x + ux * (len - 2) : x + ux * 2, ey = level ? y + uy * (len - 2) : y + uy * 2;
  ctx.beginPath(); ctx.moveTo(ex - ux, ey - uy); ctx.lineTo(ex + ux, ey + uy); ctx.stroke();
}

// 一縷一縷往上飄的黑煙（照時間扭動；畫法而已，不是粒子）。k = 濃淡，(ox, oy) = 從哪裡冒出來（預設 = 肩膀與背後）
function drawSmoke(ctx, t, k, ox = null, oy = null) {
  const roots = ox === null ? [[-10, -42], [-12, -30], [9, -46], [-6, -20]] : [[ox, oy], [-ox, oy]];
  ctx.save();
  ctx.strokeStyle = `rgba(9,9,11,${0.5 * k})`;
  for (let i = 0; i < roots.length; i++) {
    const [rx, ry] = roots[i];
    const ph = t * 1.6 + i * 2.1;
    const side = rx < 0 ? -1 : 1;
    ctx.lineWidth = 1.8 - i * 0.25;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.bezierCurveTo(rx + side * (6 + Math.sin(ph) * 3), ry - 6, rx + side * (2 + Math.cos(ph * 1.3) * 5), ry - 12, rx + side * (9 + Math.sin(ph * 0.8) * 4), ry - 18 - Math.sin(ph) * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// 一閃的線：預定一閃的預警線（劍士活著、一般難度：每一道一條虛線＋淡紅帶 = 打得到的寬度，一閃一閃；他的回合出招、線開始劃之前也還在）；
// 出招的時候（他的回合，兩種難度都畫——是招式本身）：每一道從刀口劃到 fx.trace 那裡（前端一點白光），劃完到斬下去之前是實線
function drawIaiLines(ctx, c) {
  const S = c.match.mechState;
  const g = c.match.byId('swordsman');
  if (!g || !g.alive || !S) return;
  const fx = c.state.fx;
  const casting = !!(fx && fx.action === 'iai');
  const tracing = casting && fx.phase === 'cast' && fx.trace > 0;   // 出招：線正在劃 / 劃好了
  const r = CONFIG.WEAPONS.swordsmanIai.hitRadius;
  ctx.save();
  if (tracing) {
    for (const L of iaiLinesOf(fx.step)) {
      const x = L.x0 + (L.x1 - L.x0) * fx.trace, y = L.y0 + (L.y1 - L.y0) * fx.trace;
      ctx.strokeStyle = 'rgba(239,68,68,0.28)';
      ctx.lineWidth = r * 2;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(L.x0, L.y0); ctx.lineTo(x, y); ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.strokeStyle = 'rgba(254,226,226,0.95)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(L.x0, L.y0); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  const plan = S.next && S.next.action === 'iai' && Array.isArray(S.next.lines) ? S.next.lines : null;
  if (plan && c.rangeHints && !tracing && !(casting && fx.phase === 'act')) {   // 出招一開始（還在握刀柄）照樣看得到
    const pulse = 0.7 + 0.3 * Math.sin(c.time * 5);
    for (const L of plan) {
      ctx.strokeStyle = `rgba(239,68,68,${0.16 * pulse})`;   // 打得到的寬度（淡淡的紅帶）
      ctx.lineWidth = r * 2;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(L.x0, L.y0); ctx.lineTo(L.x1, L.y1); ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.setLineDash([10, 7]);
      ctx.strokeStyle = `rgba(254,128,128,${0.75 * pulse})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(L.x0, L.y0); ctx.lineTo(L.x1, L.y1); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

// 一閃斬下去的刀光：沿著每一道線一道白光（外面一圈淡藍），慢慢淡掉
function drawSlashFlash(ctx, c) {
  const F = c.state.flash;
  if (!F) return;
  const a = 1 - F.t / FLASH;
  ctx.save();
  ctx.lineCap = 'round';
  for (const [x0, y0, x1, y1] of F.lines) {
    ctx.strokeStyle = `rgba(${QI},${0.3 * a})`;
    ctx.lineWidth = 14;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${0.95 * a})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.restore();
}

// 一閃的刀光（飛行物）：從它那一道線的起點（刀口）飛到現在的位置，拖一道白光、前端最亮（第 i 顆 = 招式的第 i 道線）
function drawIaiEdge(ctx, c, p) {
  const fx = c.state.fx;
  const L = fx ? iaiLinesOf(fx.step)[p.i] : null;
  const x0 = L ? L.x0 : p.x, y0 = L ? L.y0 : p.y;
  ctx.save();
  const grad = ctx.createLinearGradient(x0, y0, p.x, p.y);
  grad.addColorStop(0, `rgba(${QI},0.05)`);
  grad.addColorStop(1, 'rgba(255,255,255,0.95)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(p.x, p.y); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 半月形的劍氣（凸的那邊朝 dir：往左飛 = 「(」，照使用者的草圖）：圓心在 (x, y)、半徑 r（高 = 2r），a = 不透明度。外面一圈淡淡的藍光
function halfMoon(ctx, x, y, r, dir, a) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir, 1);
  ctx.fillStyle = `rgba(${QI},${0.22 * a})`;
  ctx.beginPath(); ctx.ellipse(r * 0.15, 0, r * 0.75, r * 1.15, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `rgba(240,249,255,${0.95 * a})`;
  ctx.strokeStyle = `rgba(${QI},${a})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(-r * 0.2, 0, r, -Math.PI * 0.45, Math.PI * 0.45);              // 外緣（凸的那邊）
  ctx.arc(-r * 0.75, 0, r * 0.88, Math.PI * 0.4, -Math.PI * 0.4, true);  // 內緣
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
}

// 劍氣發動：半月形的劍氣往左直線飛過整排，後面拖一道漸淡的光（從右邊出發的地方拖過來）
function drawQiWave(ctx, c, p) {
  const dir = p.vx >= 0 ? 1 : -1;
  const r = (p.weapon.hitRadius || 18) + 3;
  const tail = Math.min(220, Math.abs(c.match.terrain.maxX - p.x));
  ctx.save();
  const grad = ctx.createLinearGradient(p.x, 0, p.x - dir * tail, 0);
  grad.addColorStop(0, `rgba(${QI},0.45)`);
  grad.addColorStop(1, `rgba(${QI},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(Math.min(p.x, p.x - dir * tail), p.y - r * 0.55, tail, r * 1.1);
  ctx.restore();
  halfMoon(ctx, p.x, p.y, r, dir, 1);
}

// 玩家回合裡慢慢往左飛的那一道：半月形的劍氣、後面拖一道漸淡的光（從右邊出發的地方拖過來）
function drawQiFlying(ctx, c) {
  const g = c.match.byId('swordsman');
  if (!g || !g.alive) return;
  const F = c.match.mechState && c.match.mechState.flying;
  const band = F && qiBand(c.match, F.row);
  if (!band) return;
  const r = CONFIG.WEAPONS.swordsmanQi.hitRadius + 3;
  const tail = Math.min(260, band.qx - F.x);
  if (tail > 0) {
    ctx.save();
    const grad = ctx.createLinearGradient(F.x, 0, F.x + tail, 0);
    grad.addColorStop(0, `rgba(${QI},0.45)`);
    grad.addColorStop(1, `rgba(${QI},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(F.x, band.y - r * 0.55, tail, r * 1.1);
    ctx.restore();
  }
  halfMoon(ctx, F.x, band.y, r, -1, 0.9 + 0.1 * Math.sin(c.time * 12));
}

// 還沒發動的劍氣：浮在地圖右邊那一排的高度（上下輕輕晃），照發動的順序：最先發動的最亮、晃得最快，其他的淡一點；左邊一個小數字 = 第幾個發動
function drawQiHover(ctx, c) {
  const S = c.match.mechState;
  const g = c.match.byId('swordsman');
  if (!S || !S.qi.length || !g || !g.alive) return;
  S.qi.forEach((idx, k) => {
    const band = qiBand(c.match, idx);
    if (!band) return;
    const first = k === 0;
    const pulse = first ? 0.8 + 0.2 * Math.sin(c.time * 9) : 0.55 + 0.1 * Math.sin(c.time * 3 + k);
    const y = band.y + Math.sin(c.time * (first ? 4 : 2) + idx) * 2;
    halfMoon(ctx, band.qx, y, CONFIG.WEAPONS.swordsmanQi.hitRadius + 3, -1, pulse);
    ctx.save();
    ctx.fillStyle = `rgba(224,242,254,${0.5 + 0.45 * pulse})`;
    ctx.font = `bold ${first ? 14 : 12}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(String(k + 1), band.qx - 30, y + 5);
    ctx.restore();
  });
}

// 劍氣發動的那一排：右邊出發的地方亮一下（往外散開的藍光）
function drawQiBurst(ctx, c) {
  const B = c.state.burst;
  const band = B && qiBand(c.match, B.row);
  if (!band) return;
  const k = B.t / BURST;
  ctx.save();
  ctx.fillStyle = `rgba(${QI},${0.4 * (1 - k)})`;
  ctx.beginPath(); ctx.ellipse(band.qx, band.y, 18 + 30 * k, 22 + 16 * k, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 揮出去、飛向右邊的月牙：沿著一道往上拱的弧線飛，邊飛邊轉，最後停成「(」
function drawCrescent(ctx, m) {
  const k = Math.min(1, m.t);
  const x = m.x0 + (m.x1 - m.x0) * k;
  const y = m.y0 + (m.y1 - m.y0) * k - 50 * 4 * k * (1 - k);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((1 - k) * Math.PI * 2);
  halfMoon(ctx, 0, 0, 12 + 9 * k, -1, 0.95);
  ctx.restore();
}

// 拔刀的刀氣：沿著飛的方向一道小月牙，後面拖一小段白光
function drawDrawWave(ctx, p) {
  const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
  const ux = p.vx / sp, uy = p.vy / sp;
  ctx.save();
  ctx.strokeStyle = 'rgba(240,249,255,0.5)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(p.x - ux * 46, p.y - uy * 46); ctx.lineTo(p.x, p.y); ctx.stroke();
  ctx.translate(p.x, p.y);
  ctx.rotate(Math.atan2(uy, ux));
  halfMoon(ctx, 0, 0, 13, 1, 1);
  ctx.restore();
}
