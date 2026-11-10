import { CONFIG } from '../../shared/core/config.js';
import { text } from '../draw.js';
import { alignMarksBound, applyMarksStruggle, bindMarked } from '../../shared/maps/marks.js';

// 指名的畫面（通用，古樹之庭 / 叢林巨蟒共用；規則見 shared/maps/marks.js）：
// 被指名、還沒輪到的人腳下的標記（菁英之路不畫，c.rangeHints）、回合開始那一招的範圍的記帳（c.state.zones）、
// 發動的那一刻（收到就演、照順序套用時不再演）、綁著的人的連打（左右交替）、自己被綁著時畫面中間的提示、HUD 那一行。
// 每張地圖自己畫範圍、發動、綁著的樣子（tree.js / snake.js），這裡只管共同的流程。
// 地圖畫面的 c.state 要有 zones（[]）與 lastDir（0）

// 真實時間（秒，跟伺服器的時鐘一起動：回合開始冒、發動的動畫照它）；測試的假畫面沒有 clock 就用畫面時間
export const clockOf = (c) => (typeof c.clock === 'function' ? c.clock() : c.time);

/**
 * 回合裡的事（地圖畫面的 hazard 掛勾轉過來）：msg.start = 玩家的回合開始（被綁著的名單照伺服器的對齊；被指名的人那一招的範圍出現 → on.zone(z)）；
 * 伺服器的 hazard（kind 'marks'）= 發動了（fired → on.fired(f)：收到的那一刻就演一次）、綁著的人扣血（照順序套用時 → on.ticks(ids)）
 */
export function marksHazard(c, spec, msg, early, on = {}) {
  const S = spec.state(c.match);
  if (!S || !S.bound) return;
  if (msg.start) {
    const st = msg.start;
    if (st.kind !== 'marks') return;
    alignMarksBound(c.match, spec, st.bound);
    if (st.boundTurn) {
      if (S.bound[st.boundTurn]) S.bound[st.boundTurn].count = 0;
      if (st.boundTurn === c.myId) c.state.lastDir = 0;
    }
    if (st.zone) {
      delete S.marks[st.zone.id];
      c.state.zones = c.state.zones.filter(z => z.id !== st.zone.id);
      const z = { ...st.zone, at: msg.recvAt ?? clockOf(c), fired: null };
      c.state.zones.push(z);
      if (on.zone) on.zone(z);
    }
    return;
  }
  if (msg.kind !== 'marks') return;
  if (msg.fired && !msg.shownFired) {
    msg.shownFired = true;
    const f = msg.fired;
    const now = clockOf(c);
    const z = c.state.zones.find(q => q.id === f.id && !q.fired);
    if (z) z.fired = { at: now, hit: f.hit };
    else c.state.zones.push({ ...f, at: now, delay: 0, fired: { at: now, hit: f.hit } });   // 沒收到回合開始：照發動帶的範圍補畫
    if (f.hit && spec.binds(f.kind)) {
      bindMarked(c.match, spec, f.id);
      if (f.id === c.myId) c.state.lastDir = 0;
    }
    if (on.fired) on.fired(f);
  }
  if (early) return;
  if (on.ticks && msg.ticks) on.ticks(msg.ticks);
  if (Array.isArray(msg.bound)) alignMarksBound(c.match, spec, msg.bound);
}

/** 發動完的範圍畫多久就收掉（update 呼叫；life = 發動之後還要畫幾秒） */
export function pruneZones(c, life) {
  const now = clockOf(c);
  c.state.zones = c.state.zones.filter(z => !z.fired || now - z.fired.at < life);
}

/** 自己被綁著時按了一下 A / D：左右交替才算（地圖畫面的 struggle 掛勾）。true = GameView 送 struggle 給伺服器 */
export function marksStruggleKey(c, spec, me, dir, color) {
  const S = spec.state(c.match);
  if (!S || !S.bound || !S.bound[me.id] || dir === c.state.lastDir) return false;
  c.state.lastDir = dir;
  c.fx.particles(me.x + dir * 8, me.y - 4, 3, { speed: 70, life: 0.3, size: 2, color, gravity: 300 });
  return true;
}

/** 伺服器的 struggle（地圖畫面的 onStruggle 掛勾）：連打數照伺服器的；掙脫了就放開、飄字 */
export function marksOnStruggle(c, spec, e, msg, colors) {
  applyMarksStruggle(c.match, spec, msg);
  if (msg.freed) {
    c.fx.float(e, '掙脫了！', '#bef264');
    c.fx.particles(e.x, e.y - 6, 16, { speed: 170, life: 0.6, size: 2.5, color: colors.main, gravity: 320 });
    c.fx.sound('snare', { x: e.x, vol: 0.6 });
  } else {
    c.fx.particles(e.x, e.y - 4, 2, { speed: 60, life: 0.25, size: 2, color: colors.bit, gravity: 300 });
  }
}

/**
 * 被指名、還沒輪到的人：腳下一圈淡淡的標記，慢慢轉（菁英之路不畫）。styleOf(kind) → { ring, dot, spiky }：
 * 圈的顏色、點的顏色、點是尖刺（三角形）還是圓點
 */
export function drawMarkSigils(ctx, c, S, styleOf) {
  if (!S || !S.marks || c.rangeHints === false) return;
  for (const [pid, kind] of Object.entries(S.marks)) {
    const p = c.match.byId(pid);
    if (!p || !p.alive) continue;
    const st = styleOf(kind);
    const spin = c.time * 0.8 + p.slot;
    const rx = p.hw + 12, ry = 4.5;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 0.65 + 0.2 * Math.sin(c.time * 3 + p.slot);
    ctx.strokeStyle = st.ring;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([5, 4]);
    ctx.lineDashOffset = -spin * 8;
    ctx.beginPath(); ctx.ellipse(0, -1, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = st.dot;
    for (let k = 0; k < 6; k++) {
      const ang = spin + k * Math.PI / 3;
      const x = Math.cos(ang) * rx, y = -1 + Math.sin(ang) * ry;
      if (st.spiky) { ctx.beginPath(); ctx.moveTo(x - 2, y); ctx.lineTo(x + 2, y); ctx.lineTo(x, y - 6); ctx.closePath(); ctx.fill(); }
      else { ctx.beginPath(); ctx.arc(x, y - 2, 1.8, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }
}

/** 自己被綁著、輪到自己的時候：畫面中間（上面那條提示的區域，不擋戰場）一直提示要連點 A/D、還差幾下 */
export function drawEscapeHint(ctx, c, S, need, color) {
  const me = c.myId ? c.match.byId(c.myId) : null;
  if (!S || !S.bound || !me || !me.alive || c.currentId !== me.id) return;
  const rec = S.bound[me.id];
  if (!rec) return;
  ctx.save();
  ctx.globalAlpha = 0.75 + 0.25 * Math.sin(c.time * 8);
  text(ctx, `連點 A/D 可逃脫！（${rec.count} / ${need}）`, CONFIG.WORLD_W / 2, 222,
    { size: 26, bold: true, align: 'center', color, outline: 'rgba(0,0,0,0.85)', outlineWidth: 5 });
  ctx.restore();
}

/** HUD 那一行：現在輪到的人被綁著的話他要連打幾下（沒有 = null） */
export function boundHudLine(c, S, need) {
  const cur = S && S.bound && c.currentId ? c.match.byId(c.currentId) : null;
  const rec = cur && S.bound[cur.id];
  return rec ? [`${cur.name} 連打 A/D 掙脫 ${rec.count}/${need}`, '#fde68a'] : null;
}
