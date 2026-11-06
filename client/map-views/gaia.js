import { CONFIG } from '../../shared/core/config.js';
import {
  GAIA_ID, GAIA_NAME, WITHER_TEXT, GAIA_ACTION_NAMES as N, FLOWER_R, FLOWER_LIFT, STACK_DROP, gaiaState, gaiaOf, zoneOf, flowerCenter, touchFlowers,
  stackSharers, applyGaiaPickup, lightStatus, restoreGaia,
} from '../../shared/maps/gaia.js';

// 主題王「大地祭壇」的地圖畫面：背景正上方大地之母・蓋亞的臉（打得到的那個角色；暴走時臉上裂開紅光、暈眩時眼睛轉圈）、
// 左右兩隻飄在空中的巨大石手（照預定的下一招擺姿勢：捏碎 = 兩手平舉到中間那一欄的高度握拳、天罰 = 那一邊的手掌高舉攤平、
// 同罰 = 目標那一邊的手握成拳頭、一直跟在他頭上、淨化 = 兩手在下巴底下捧著綠光；菁英之路只看得到這個）、
// 一般難度另外畫警示（紅色警示帶 / 同罰的集合圈：圈裡的人一起分擔）、
// 瘴氣（整個畫面的紫色薄霧 + 飄散的紫色粉塵）、自然之花（金色發光的花）→ 撿到變成光球飛進祭壇、祭壇上的光球凹槽、
// 祭壇淨化的金光、最後之光（大家被傳送到祭壇、開花、收齊張開金色護盾、枯萎的橫幅）、誅滅（全畫面的白金色光）、各招的動畫腳本。
// 規則在 shared/maps/gaia.js；掛勾的說明見 index.js
const FPS = 60;
const W = CONFIG.WORLD_W;
const WATER = CONFIG.WATER_LEVEL;
const BAND_TOP = 356;      // 警示帶從多高開始畫（上面那道斜坡的外側 370 再往上一點；臉在上面，不蓋到）
const ORB_FLIGHT = 0.75;   // 光球從花飛到祭壇的秒數
const BLOOM = 0.55;        // 花開出來的秒數
const WILT = 0.9;          // 花枯萎 / 消失的秒數
const CLAP_AT = 0.9;       // 捏碎的預兆播到幾成時兩手合起來
const SLAM_AT = 0.9;       // 天罰的預兆播到幾成時手掌拍下去
const HOLD = 0.35;         // 合起來 / 拍下去之後停幾秒才收回去
const JUDGE_AT = 0.82;     // 誅滅的預兆播到幾成時光落下來
const FIST_HOVER = 40;     // 同罰的拳頭（指節的底）停在目標頭頂上多高（血條、名字再上面）
const FIST_WINDUP = 0.6;   // 同罰的預兆播到幾成時拳頭舉到最高（之後蓄力發抖，出招時砸下去）
const ABSORB_AT = 0.8;     // 淨化的預兆播到幾成時綠色光球被吸回臉上（她回血）
const COLOR = {
  crush: '#f87171', smite: '#fbbf24', stack: '#fb923c', cleanse: '#4ade80', rage: '#ef4444', light: '#fde68a', judgement: '#fef3c7', fog: '#c084fc', calm: '#a3e635',
};
const ALTAR_COLOR = { orb: '#fde047', light: '#fffbeb' };

// 手的姿勢（左手的座標；右手照畫面中線鏡像）：x / y = 手腕、rot = 手指往中間轉幾度（0 = 朝上）、curl = 握起來的程度、s = 大小、glow = 掌心的光
const POSE = {
  rest: { x: 72, y: 332, rot: 0.35, curl: 0.25, s: 1, glow: 0.15 },
  crush: { x: 262, y: 330, rot: 1.45, curl: 0.6, s: 1, glow: 0.75 },
  smite: { x: 150, y: 272, rot: 1.65, curl: 0, s: 1.1, glow: 0.85 },
  cleanse: { x: 436, y: 394, rot: 0.85, curl: 0.55, s: 0.8, glow: 0.85 },
  dizzy: { x: 58, y: 300, rot: 2.75, curl: 0.1, s: 0.95, glow: 0 },
  raise: { x: 290, y: 318, rot: 0.25, curl: 0, s: 1.05, glow: 0.9 },   // 右手的指尖也不伸進右上的隊伍名單
};
const FIELDS = ['x', 'y', 'rot', 'curl', 's', 'glow'];

export const gaia = {
  type: 'gaia',

  // 這一場的畫面狀態：
  //   fx         蓋亞出招的動畫 { action, k（預兆播到幾成）, t（預兆播了幾秒）, cast, step, phase: 'cast' | 'act', at（出招之後幾秒）}（回合播完就清掉）
  //   hands      兩隻手現在畫在哪 { L, R }（update 每一步往該擺的姿勢靠過去；出招時直接照動畫的時間軸）
  //   fog        瘴氣畫多濃（0 ~ 1，update 慢慢靠過去：散掉 / 起霧都是淡入淡出）；dome = 護盾畫多亮（同上）
  //   blooms     花開出來的時刻（花的 id → c.time），沒有 = 一直都在（重連、快照）
  //   orbs       飛向祭壇的光球 [{ x0, y0, t0, light }]；predicted = 自己的畫面先撿起來的花（伺服器的 pickup 來了不再飛一次）；
  //              predictedPurify = 自己先撿的那一下收滿祭壇、本地已經先淨化（自己回過血了，伺服器的 pickup 不再加一次）
  //   wilts      正在枯萎 / 消失的花 [{ x, y, t0 }]；purify = 祭壇淨化的光（{ t0, need }：光球飛到之前凹槽照收滿的畫）
  //   flash      全畫面的閃光 { t0, dur, rgb, a }（祭壇淨化的金光、誅滅的白光）
  create: (match) => {
    const S = gaiaState(match);
    return {
      fx: null, hands: {}, fog: S && S.fog ? (S.rage ? 1 : 0.8) : 0, dome: S && S.light && S.light.shield ? 1 : 0,
      blooms: new Map(), orbs: [], predicted: new Set(), predictedPurify: false, wilts: [], purify: null, flash: null,
    };
  },

  musicTrack: () => 'tree',   // 先借用古樹之庭的 Boss 曲（森林、大地）；之後可以換專屬的

  turnScript: gaiaTurnScript,
  abortScript(c) { c.state.fx = null; },   // 播到一半丟掉：舉起的手、預兆不要一直留著
  onDeath: onGaiaDeath,

  // 每一步：出招之後的計時、瘴氣 / 護盾的濃淡、兩隻手的位置、光球飛到祭壇、粉塵與花的光點（畫圖只讀這些）
  update(c, dt) {
    const s = c.state;
    const S = gaiaState(c.match);
    if (!S) return;
    if (s.fx && s.fx.phase === 'act') s.fx.at += dt;
    s.fog += ((S.fog ? (S.rage ? 1 : 0.8) : 0) - s.fog) * (1 - Math.exp(-dt * 2.5));
    s.dome += ((S.light && S.light.shield ? 1 : 0) - s.dome) * (1 - Math.exp(-dt * 4));
    for (const side of [-1, 1]) {
      const key = side < 0 ? 'L' : 'R';
      const want = handTarget(c, side);
      const cur = s.hands[key];
      if (!cur || want.snap) { s.hands[key] = want; continue; }
      const k = 1 - Math.exp(-dt * (want.fist ? 14 : 7));   // 同罰的拳頭緊跟著目標
      for (const f of FIELDS) cur[f] += (want[f] - cur[f]) * k;
      cur.color = want.color;
      cur.fist = want.fist;
    }
    // 光球飛到祭壇：亮一下
    for (const o of s.orbs) {
      if (o.landed || c.time - o.t0 < ORB_FLIGHT) continue;
      o.landed = true;
      const a = S.def.altar;
      c.fx.particles(a.x, a.y - 30, 10, { speed: 90, life: 0.6, size: 2.5, color: o.light ? ALTAR_COLOR.light : ALTAR_COLOR.orb, gravity: -40 });
      c.fx.sound('chime', { x: a.x });
    }
    s.orbs = s.orbs.filter(o => c.time - o.t0 < ORB_FLIGHT + 0.05);
    s.wilts = s.wilts.filter(w => c.time - w.t0 < WILT);
    if (s.flash && c.time - s.flash.t0 > s.flash.dur) s.flash = null;
    if (s.purify && c.time - s.purify.t0 > 1.4) s.purify = null;
    for (const id of [...s.blooms.keys()]) if (!S.flowers.some(f => f.id === id)) s.blooms.delete(id);
    // 瘴氣的紫色粉塵：整個畫面隨機冒出來、慢慢飄（越濃越多；暴走後混一點紅）
    if (s.fog > 0.05 && Math.random() < dt * 16 * s.fog) {
      const red = S.rage && Math.random() < 0.3;
      c.fx.particle({
        x: Math.random() * W, y: 90 + Math.random() * (WATER - 90), vx: 8 + Math.random() * 22, vy: -6 + Math.random() * 12,
        life: 2.6, maxLife: 2.6, size: 2.5 + Math.random() * 4, color: red ? 'rgba(239,68,68,0.32)' : Math.random() < 0.5 ? 'rgba(147,51,234,0.35)' : 'rgba(192,132,252,0.28)', gravity: -4,
      });
    }
    // 自然之花的金色光點
    for (const f of S.flowers) {
      if (Math.random() > dt * 4) continue;
      const p = flowerCenter(f);
      c.fx.particle({ x: p.x + (Math.random() - 0.5) * 20, y: p.y + (Math.random() - 0.5) * 10, vx: 0, vy: -24 - Math.random() * 16, life: 0.9, maxLife: 0.9, size: 1.6, color: '#fde68a', gravity: -10 });
    }
    // 暴走：臉上的裂縫冒出紅色的火星
    const g = gaiaOf(c.match);
    if (g && g.alive && S.rage && Math.random() < dt * 6) {
      c.fx.particle({ x: g.x + (Math.random() - 0.5) * g.hw * 1.6, y: g.y - Math.random() * g.h * 0.9, vx: (Math.random() - 0.5) * 20, vy: -30 - Math.random() * 30, life: 0.8, maxLife: 0.8, size: 1.8, color: Math.random() < 0.5 ? '#ef4444' : '#fca5a5', gravity: -20 });
    }
  },

  // 她的血量停在 50%（等輪到她暴走）：多打的不算，飄「鎖血」（這一下還上了燃燒 / 中毒 / 流血的照一般的接著飄）
  showDamage(c, e, d) {
    if (e.id !== GAIA_ID || d.dmg > 0 || d.blocked || d.friendly || !e.alive || e.hp > e.hpFloor) return false;
    c.fx.float(e, '鎖血', '#9ca3af', 15);
    return !(d.burn || d.poison || d.bleed || d.immune);
  },

  // 捏碎 / 天罰的震波打到人：揚起一團土；同罰的拳砸在頭上：碎石、震一下
  showEvent(c, ev) {
    if (!ev.target) return;
    const p = c.projectiles.find(q => q.i === ev.p);
    const id = p && p.weapon && p.weapon.id;
    if (id === 'gaiaStack') {
      c.fx.shake(7);
      c.fx.sound('stomp', { x: ev.x, vol: 0.8 });
      c.fx.particles(ev.x, ev.y, 16, { speed: 170, life: 0.6, size: 3.5, color: '#78716c', gravity: 600 });
      c.fx.particles(ev.x, ev.y, 6, { speed: 90, life: 0.5, size: 2.5, color: COLOR.stack, gravity: 200 });
      return;
    }
    if (id !== 'gaiaCrush' && id !== 'gaiaSmite') return;
    c.fx.particles(ev.x, ev.y, 14, { speed: 160, life: 0.6, size: 3.5, color: '#a16207', gravity: 600 });
    c.fx.particles(ev.x, ev.y, 6, { speed: 90, life: 0.5, size: 2.5, color: id === 'gaiaCrush' ? '#fca5a5' : '#fde68a', gravity: 200 });
  },

  // 回合開始在瘴氣裡：加了幾層中毒（免疫的人飄「免疫」）
  statusFx(c, e, fx) {
    if (fx.type !== 'gaiaFog') return;
    if (fx.immune) { c.fx.float(e, '瘴氣：免疫', '#fde68a', 14); return; }
    if (Number.isFinite(fx.total)) e.poison = fx.total;
    c.fx.float(e, `瘴氣 中毒 +${fx.stacks}`, '#c084fc', 14);
    c.fx.particles(e.cx, e.cy, 10, { speed: 60, life: 0.8, size: 3, color: '#9333ea', gravity: -60 });
  },

  // 撿到自然之花（伺服器廣播的 pickup、AI 代打走路的 pickups）：花變成光球飛進祭壇（自己先撿過的不再飛一次），
  // 照伺服器的結果套（祭壇的光球數、淨化：大家的中毒歸零、回血 / 最後之光：護盾）。
  // 自己的血量照本地的加上回的血（伺服器的 hp 是撿的那一刻，之後本地可能已經掉過水）
  onPickup(c, e, msg, self) {
    if (msg.type !== 'gaiaFlower') return;
    const S = gaiaState(c.match);
    if (!S) return;
    const ids = msg.flowers || [];
    for (const id of ids) {
      const f = S.flowers.find(q => q.id === id);
      if (f && !c.state.predicted.has(id)) launchOrb(c, f, !!msg.light);
      c.state.predicted.delete(id);
    }
    const before = e.hp;
    applyGaiaPickup(c.match, msg);
    const b = self && (msg.heals || []).find(h => h.id === e.id);   // 自己回的血（本地先淨化過了 = 已經加過，照本地的）
    if (b && e.alive) e.hp = c.state.predictedPurify ? before : Math.min(e.maxHp, before + (b.heal || 0));
    if (msg.purify || !c.state.predicted.size) c.state.predictedPurify = false;
    if (msg.purify) purifyFx(c, msg);
    else if (msg.shield) {
      c.fx.banner('祭壇的護盾張開了！', '#fde68a');
      c.fx.sound('purify', { x: S.def.altar.x });
    } else {
      c.fx.float(e, msg.light ? `自然之花 ${msg.orbs} / ${msg.need}` : `光球 ${msg.orbs} / ${msg.need}`, '#fde68a', 15);
    }
  },

  // 自己的回合本地走了一幀：碰到花就先撿起來（花不見、光球飛出去），馬上回報位置（伺服器檢查的線段就停在花上，一定也會判到；
  // 祭壇的光球數、淨化 / 護盾照伺服器之後的 pickup 套）
  predictMove(c, me, px, py) {
    const S = gaiaState(c.match);
    if (!S || !S.flowers.length) return false;
    const ids = touchFlowers(c.match, me, px, py, me.x, me.y).filter(id => !c.state.predicted.has(id));
    if (!ids.length) return false;
    for (const id of ids) {
      c.state.predicted.add(id);
      const f = S.flowers.find(q => q.id === id);
      if (f) launchOrb(c, f, !!S.light);
    }
    S.flowers = S.flowers.filter(f => !ids.includes(f.id));
    // 這一下收滿祭壇（還沒確認的也算）：自己先在本地淨化（中毒歸零、回血，跟伺服器同一套）——之後在本地掉水才會照淨化之後的血量算，
    // 跟伺服器一樣（伺服器先淨化、才判落水）。之後的 pickup 不再幫自己回一次血（predictedPurify）
    if (!S.light && !S.rage && S.fog && !c.state.predictedPurify && S.orbs + c.state.predicted.size >= S.need) {
      c.state.predictedPurify = true;
      me.poison = 0;
      c.match.heal(me, me.maxHp * CONFIG.GAIA.purifyHealPct / 100);
    }
    return true;
  },

  // 地形之後、角色之前：臉後面的土與樹根、警示帶 / 同罰的集合圈（一般難度）、祭壇、花、兩隻手（同罰的拳頭畫在角色之後，見 drawShade）
  drawScene(ctx, c) {
    const S = gaiaState(c.match);
    if (!S) return;
    const g = gaiaOf(c.match);
    drawMane(ctx, c, g, S);
    drawWarning(ctx, c, S, g);
    drawStackHint(ctx, c, S, g);
    drawAltar(ctx, c, S);
    for (const w of c.state.wilts) drawFlower(ctx, w.x, w.y, 1, c.time, Math.min(1, (c.time - w.t0) / WILT));
    for (const f of S.flowers) {
      const t0 = c.state.blooms.get(f.id);
      const k = t0 === undefined ? 1 : Math.max(0, Math.min(1, (c.time - t0) / BLOOM));
      if (k > 0) drawFlower(ctx, f.x, f.y, ease(k), c.time + f.x * 0.01, 0);
    }
    const dead = !g || !g.alive;
    for (const side of [-1, 1]) {
      const h = c.state.hands[side < 0 ? 'L' : 'R'] || handTarget(c, side);
      if (!h.fist) drawHand(ctx, h, side, c.time, dead);
    }
  },

  // 臉在最後面（被打的人、飛過去的人畫在前面）
  drawEntityFirst: (c, e) => e.id === GAIA_ID,

  // 倒下的臉留在背景（石化、眼睛闔上），不淡出
  drawEntityBare(ctx, c, e) {
    if (e.id !== GAIA_ID || e.alive) return false;
    drawFace(ctx, c, e, false, true);
    return true;
  },

  drawEntity(ctx, c, e, hurt) {
    if (e.id !== GAIA_ID) return false;
    drawFace(ctx, c, e, hurt, false);
    return 'body';
  },

  hpBar: (c, e) => (e.id === GAIA_ID ? { w: 160, h: 8 } : null),

  drawProjectile(ctx, c, p) {
    const id = p.weapon.id;
    if (id === 'gaiaStack') {   // 同罰：往下砸的石拳，上面拖著幾道速度線
      ctx.save();
      ctx.strokeStyle = hexA(COLOR.stack, 0.55);
      ctx.lineWidth = 2;
      for (const dx of [-16, 0, 16]) { ctx.beginPath(); ctx.moveTo(p.x + dx, p.y - 34); ctx.lineTo(p.x + dx, p.y - 70); ctx.stroke(); }
      ctx.restore();
      drawFist(ctx, p.x, p.y, 0.55, COLOR.stack, 1, false, false);
      return true;
    }
    if (id !== 'gaiaCrush' && id !== 'gaiaSmite') return false;
    drawShock(ctx, p, id === 'gaiaCrush' ? COLOR.crush : COLOR.smite);
    return true;
  },

  // 角色畫完之後（瞄準線、飛行物、特效、飄字畫在上面）：瘴氣的薄霧、護盾、同罰的拳頭（在目標頭上，不被臉擋住）、淨化的綠色光球、
  // 飛向祭壇的光球、誅滅的光、全畫面的閃光
  shaded: () => true,
  drawShade(ctx, c) {
    const S = gaiaState(c.match);
    if (!S) return;
    drawFog(ctx, c, S);
    drawDome(ctx, c, S);
    const g = gaiaOf(c.match);
    for (const side of [-1, 1]) {
      const h = c.state.hands[side < 0 ? 'L' : 'R'] || handTarget(c, side);
      if (h.fist) drawFist(ctx, h.x, h.y, h.s, h.color, h.glow, !g || !g.alive, true, c.time);
    }
    drawCleanseOrb(ctx, c);
    for (const o of c.state.orbs) drawOrb(ctx, c, S, o);
    drawJudgeLight(ctx, c);
    const fl = c.state.flash;
    if (fl && c.time >= fl.t0) {
      const k = (c.time - fl.t0) / fl.dur;
      ctx.save();
      ctx.fillStyle = `rgba(${fl.rgb},${Math.max(0, (1 - k) * fl.a)})`;
      ctx.fillRect(0, 0, W, CONFIG.WORLD_H);
      ctx.restore();
    }
  },

  // 隊伍名單下面：蓋亞的血量、下一招（一般難度帶打哪一邊 / 同罰鎖定誰）、瘴氣與祭壇 / 最後之光的倒數與現在該做什麼
  hud(c, line) {
    const lines = [line];
    const S = gaiaState(c.match);
    const e = gaiaOf(c.match);
    if (!S || !e || !e.alive) return lines;
    lines.push([`蓋亞 ${e.hp} / ${e.maxHp}${S.rage ? '（暴走）' : ''}`, '#fca5a5']);
    if (S.stunned) lines.push(['蓋亞暈眩中：下一回合不動', '#fde68a']);
    else if (!S.rage && e.hpFloor > 0 && e.hp <= e.hpFloor) lines.push(['下一招：大地之母暴走', '#ef4444']);
    else if (S.next && S.next.action) lines.push([`下一招：${nextLabel(c, S.next)}`, '#fdba74']);
    const st = statusLine(c, S);
    if (st) lines.push(st);
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 蓋亞的回合：一步一步照順序播（預兆 → 出招（捏碎 / 天罰照 shotScript 重播擊退）→ 校正成伺服器結果），全部播完照伺服器帶來的狀態對齊
function* gaiaTurnScript(c, msg) {
  const match = c.match;
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* stepScript(c, step);
  c.state.fx = null;
  if (msg.boss.state) restoreGaia(match, { gaia: msg.boss.state });
  else if (gaiaState(match) && msg.boss.next !== undefined) gaiaState(match).next = msg.boss.next;
}

const ease = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const lerp = (a, b, k) => a + (b - a) * k;

function* stepScript(c, b) {
  const match = c.match;
  const cast = Math.max(1, Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS));
  const fx = c.state.fx = { action: b.action, k: 0, t: 0, cast: cast / FPS, step: b, phase: 'cast', at: 0 };
  announce(c, b);
  for (let i = 0; i < cast; i++) {
    fx.k = i / cast;
    fx.t = i / FPS;
    castFrame(c, b, i, cast);
    yield { frames: 1 };
  }
  fx.k = 1;
  fx.phase = 'act';
  if (b.shot) yield* c.shotScript(b.shot);
  else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: Math.round(CONFIG.TIMING.settleDelay * FPS * 0.5) };
  }
}

// 招式的橫幅
function announce(c, b) {
  const target = b.targetId ? c.match.byId(b.targetId) : null;
  switch (b.action) {
    case 'fog': c.fx.banner('瘴氣瀰漫！', COLOR.fog); break;
    case 'stunned': c.fx.banner('大地之母暈眩了！', '#fde68a'); break;
    case 'rage': c.fx.banner('大地之母暴走！', COLOR.rage); break;
    case 'light': c.fx.banner('最後之光！', COLOR.light); break;
    case 'wither': c.fx.banner(WITHER_TEXT, '#d6d3d1'); break;
    case 'judgement': c.fx.banner('誅滅！', COLOR.judgement); break;
    case 'idle': c.fx.banner(`大地之母${N.idle}中…`, '#e9d5ff'); break;
    case 'smite': c.fx.banner(`大地之母：${N.smite}（${b.side < 0 ? '左側' : '右側'}）！`, '#fdba74'); break;
    default: c.fx.banner(`大地之母：${N[b.action] || b.action}${target ? ` → ${target.name}` : ''}！`, b.action === 'cleanse' ? '#86efac' : '#fca5a5');
  }
}

// 預兆每一幀（招式的結果在預兆播完才照伺服器的套上；花、瘴氣、暴走這些狀態在動畫的那一刻先套，回合播完照伺服器的狀態對齊）
function castFrame(c, b, i, cast) {
  const match = c.match;
  const S = gaiaState(match);
  const g = gaiaOf(match);
  if (!S) return;
  const k = i / cast;
  const at = (q) => i === Math.round(cast * q);
  const m = mouthOf(g);
  switch (b.action) {
    case 'fog':
      if (i === 0) { vanish(c, b.vanished); c.fx.sound('gust', { x: m.x }); }
      if (i % 3 === 0 && k < 0.75) {
        const a = Math.PI * (0.15 + 0.7 * ((i * 37) % 100) / 100);
        c.fx.particle({ x: m.x, y: m.y, vx: Math.cos(a) * 140 * (i % 2 ? 1 : -1), vy: Math.sin(a) * 60, life: 1.4, maxLife: 1.4, size: 5, color: 'rgba(147,51,234,0.45)', gravity: -10 });
      }
      if (at(0.6)) {
        const blooms = (b.blooms || []).map(f => ({ ...f }));
        Object.assign(S, { fog: true, nextFog: b.nextFog ?? S.nextFog, orbs: 0, need: b.need ?? blooms.length, flowers: blooms });
        for (const f of blooms) c.state.blooms.set(f.id, c.time);
        c.fx.sound('twinkle', { x: W / 2 });
      }
      break;
    case 'stunned':
      if (i === 0 && g) { c.fx.float(g, '暈眩中…', '#fde68a', 16); c.fx.sound('fizzle', { x: g.x }); }
      break;
    case 'rage':
      if (i === 0) c.fx.sound('quake', { x: W / 2 });
      if (i % 8 === 0) c.fx.shake(6);
      if (g && i % 2 === 0) c.fx.particle({ x: g.x + (Math.random() - 0.5) * g.hw * 2, y: g.y - Math.random() * g.h, vx: (Math.random() - 0.5) * 60, vy: -60, life: 0.8, maxLife: 0.8, size: 2.5, color: '#ef4444', gravity: -40 });
      if (at(0.5)) {
        vanish(c, b.vanished);
        Object.assign(S, { rage: true, fog: true, flowers: [], orbs: 0, need: 0, stunned: false, lightAt: b.lightAt ?? S.lightAt });
        if (g) g.hpFloor = 0;
        c.fx.shake(18);
        c.fx.sound('roar', { x: W / 2 });
        c.state.flash = { t0: c.time, dur: 0.6, rgb: '239,68,68', a: 0.35 };
      }
      break;
    case 'light':
      if (i === 0) c.fx.sound('purify', { x: W / 2 });
      if (at(0.35)) {
        teleport(c, b.spots || []);
        c.state.flash = { t0: c.time, dur: 0.8, rgb: '253,230,138', a: 0.45 };
      }
      if (at(0.6)) {
        const blooms = (b.blooms || []).map(f => ({ ...f }));
        S.flowers = blooms;
        S.light = { at: match.round, need: b.need ?? blooms.length, got: 0, shield: false, withered: false };
        for (const f of blooms) c.state.blooms.set(f.id, c.time);
        c.fx.sound('twinkle', { x: W / 2 });
      }
      break;
    case 'wither':
      if (i === 0) {
        vanish(c, b.vanished || S.flowers.map(f => f.id));
        if (S.light) S.light.withered = true;
        c.fx.sound('fizzle', { x: W / 2 });
      }
      break;
    case 'judgement':
      if (i === 0) c.fx.sound('quake', { x: W / 2 });
      if (g && i % 2 === 0 && k < JUDGE_AT) {   // 光往她的眼睛聚過去
        const a = (i * 2.4) % (Math.PI * 2), r = 160;
        const e = eyesOf(g);
        c.fx.particle({ x: e.x + Math.cos(a) * r, y: e.y + Math.sin(a) * r * 0.6, vx: -Math.cos(a) * r * 1.4, vy: -Math.sin(a) * r * 0.8, life: 0.7, maxLife: 0.7, size: 2.2, color: '#fef3c7', gravity: 0 });
      }
      if (at(JUDGE_AT)) judgeImpact(c, b);
      break;
    case 'crush':
      if (i === 0) c.fx.sound('heave', { x: W / 2 });
      if (at(CLAP_AT)) {
        const a = S.def.altar;
        c.fx.shake(16);
        c.fx.sound('clap', { x: a.x });
        c.fx.particles(a.x, a.y - 10, 22, { speed: 240, life: 0.7, size: 3.5, color: '#a8a29e', gravity: 600 });
        c.fx.particles(a.x, a.y - 10, 10, { speed: 120, life: 0.5, size: 3, color: COLOR.crush, gravity: 200 });
      }
      break;
    case 'smite':
      if (i === 0) c.fx.sound('heave', { x: b.side < 0 ? 150 : W - 150 });
      if (at(SLAM_AT)) {
        const z = zoneOf(S.def, { action: 'smite', side: b.side });
        c.fx.shake(14);
        c.fx.sound('stomp', { x: (z.x0 + z.x1) / 2 });
        for (const s of S.def.slopes.filter(q => (q.x0 < q.x1 ? -1 : 1) === b.side)) {
          for (let q = 0; q <= 4; q++) {
            const x = lerp(s.x0, s.x1, 0.1 + q * 0.2), y = lerp(s.y0, s.y1, 0.1 + q * 0.2);
            c.fx.particles(x, y, 4, { speed: 150, life: 0.6, size: 3, color: q % 2 ? '#a8a29e' : '#fde68a', gravity: 600 });
          }
        }
      }
      break;
    case 'stack':
      if (i === 0) c.fx.sound('heave', { x: W / 2 });
      if (at(FIST_WINDUP)) c.fx.sound('roar', { x: W / 2, vol: 0.5 });
      break;
    case 'cleanse':
      if (i === 0) c.fx.sound('charm', { x: m.x });
      if (at(ABSORB_AT)) cleanseImpact(c, b);
      break;
    default:
  }
}

// 這幾朵花消失（瘴氣重放、暴走、枯萎）：照原本的位置播枯萎
function vanish(c, ids) {
  const S = gaiaState(c.match);
  if (!S || !ids || !ids.length) return;
  for (const f of S.flowers) if (ids.includes(f.id)) c.state.wilts.push({ x: f.x, y: f.y, t0: c.time });
  S.flowers = S.flowers.filter(f => !ids.includes(f.id));
}

// 最後之光：活著的人傳送到祭壇那一層（伺服器的 spots：從哪裡到哪裡）
function teleport(c, spots) {
  for (const sp of spots) {
    const e = c.match.byId(sp.id);
    if (!e || !e.alive) continue;
    c.fx.particles(e.cx, e.cy, 14, { speed: 110, life: 0.6, size: 3, color: COLOR.light, gravity: -80 });
    e.letGoVine();
    Object.assign(e, { x: sp.x, y: sp.y, vx: 0, vy: 0, onGround: true, moveDir: 0 });
    c.fx.particles(e.cx, e.cy, 16, { speed: 90, life: 0.7, size: 3, color: '#fffbeb', gravity: -60 });
  }
}

// 誅滅的光落下來：護盾外的人倒下（伺服器的 killed）、裡面的人中毒層數歸零，全畫面白光
function judgeImpact(c, b) {
  const S = gaiaState(c.match);
  for (const id of b.killed || []) {
    const e = c.match.byId(id);
    if (!e || !e.alive) continue;
    c.fx.particles(e.cx, e.cy, 24, { speed: 180, life: 1, size: 3.5, color: '#fef3c7', gravity: -100 });
    e.die('judged');
  }
  for (const id of b.saved || []) {
    const e = c.match.byId(id);
    if (e) c.fx.float(e, '護盾守住了！', '#fde68a', 15);
  }
  for (const id of b.cured || []) {
    const e = c.match.byId(id);
    if (e) e.poison = 0;
  }
  if (S) Object.assign(S, { light: null, flowers: [], lightAt: b.lightAt ?? S.lightAt });
  c.state.flash = { t0: c.time, dur: 1.4, rgb: '255,251,235', a: 0.9 };
  c.fx.shake(24);
  c.fx.sound('judge', { x: W / 2 });
  const n = (b.killed || []).length;
  c.fx.banner(b.shield ? (n ? `誅滅！護盾外的 ${n} 人倒下了` : '護盾擋下了誅滅！') : '沒有護盾……全員誅滅', b.shield && !n ? '#fde68a' : '#fef3c7');
}

// 淨化的綠色光球吸回她臉上：她自己的負面狀態清掉（飄出清掉了哪些）、臉上一圈綠光、飄回了多少血（血量照伺服器的結果，still 播完再對齊）
const STATUS_NAMES = { poison: '中毒', burn: '燃燒', bleed: '流血', entangle: '糾纏' };
function cleanseImpact(c, b) {
  const g = gaiaOf(c.match);
  const cleared = b.cleared || [];
  if (!g) return;
  Object.assign(g, { poison: 0, burn: 0, burnFrac: 0, bleed: 0, bleedFrac: 0, entangle: 0 });
  if (Number.isFinite(b.hp) && g.alive) g.hp = b.hp;
  const e = eyesOf(g);
  c.fx.particles(e.x, e.y + 20, 22, { speed: 130, life: 0.8, size: 3, color: COLOR.cleanse, gravity: -60 });
  if (cleared.length) c.fx.float(g, `淨化：${cleared.map(k => STATUS_NAMES[k] || k).join('・')}`, '#86efac', 15);
  if (b.heal > 0) c.fx.float(g, `+${b.heal}`, '#4ade80');
  c.fx.sound('purify', { x: g.x, vol: 0.6 });
}

// 撿到的花變成光球飛向祭壇
function launchOrb(c, f, light) {
  const p = flowerCenter(f);
  c.state.orbs.push({ x0: p.x, y0: p.y, t0: c.time, light });
  c.fx.particles(p.x, p.y, 10, { speed: 90, life: 0.5, size: 2.5, color: '#fde68a', gravity: -60 });
  c.fx.sound('chime', { x: p.x, vol: 0.7 });
}

// 祭壇淨化：光球飛到祭壇時整個畫面一道金光；大家回血、解毒的飄字
function purifyFx(c, msg) {
  const t0 = c.time + ORB_FLIGHT * 0.8;
  c.state.purify = { t0, need: msg.need | 0 };
  c.state.flash = { t0, dur: 1.1, rgb: '253,230,138', a: 0.55 };
  c.fx.banner('祭壇淨化！瘴氣散去了', '#fde68a');
  c.fx.sound('purify', { x: W / 2 });
  const cured = msg.cured || [];
  for (const b of msg.heals || []) {
    const e = c.match.byId(b.id);
    if (!e) continue;
    if (b.heal > 0) c.fx.float(e, `+${b.heal}`, '#4ade80');
    if (cured.includes(b.id)) c.fx.float(e, '解毒', '#e9d5ff', 15);
    c.fx.particles(e.cx, e.cy, 12, { speed: 80, life: 0.8, size: 3, color: '#fde68a', gravity: -80 });
  }
}

// 倒下：蓋亞（橫幅、碎石）、被誅滅的人（只飄字：誅滅的橫幅已經寫了幾個人）
function onGaiaDeath(c, e) {
  if (e.id === GAIA_ID) {
    c.fx.banner(`${GAIA_NAME}倒下了！`, '#86efac');
    c.fx.shake(16);
    c.fx.sound('quake', { x: e.x });
    c.fx.particles(e.x, e.cy, 36, { speed: 220, life: 1.2, size: 4, color: '#78716c', gravity: 450 });
    c.fx.particles(e.x, e.cy, 20, { speed: 140, life: 1.4, size: 3, color: '#86efac', gravity: -40 });
    return true;
  }
  if (e.deathCause === 'judged') {
    c.fx.float(e, '被誅滅了', '#fef3c7', 16);
    return true;
  }
  return false;
}

// ---------- 手的姿勢 ----------

// side 那隻手（-1 = 左、1 = 右）該擺的姿勢：出招的動畫 > 暈眩 > 預定的下一招 > 平常。snap = 照動畫的時間軸直接放（不慢慢靠過去）
function handTarget(c, side) {
  const S = gaiaState(c.match);
  const g = gaiaOf(c.match);
  const fx = c.state.fx;
  const pose = (p, color, o = {}) => {
    const q = { ...p, ...o };
    return { ...q, x: side < 0 ? q.x : W - q.x, color: color || COLOR.calm, snap: !!o.snap };
  };
  if (!g || !g.alive || !S) return pose(POSE.dizzy, null, { glow: 0 });
  if (fx) {
    switch (fx.action) {
      case 'crush': return crushHand(S, fx, pose);
      case 'smite': return fx.step.side === side ? smiteHand(fx, pose) : pose(POSE.rest);
      case 'stack': return stackHand(c, fx.step.targetId, side, pose, fx);
      case 'cleanse': return pose(POSE.cleanse, COLOR.cleanse);
      case 'stunned': return pose(POSE.dizzy);
      case 'rage': case 'light': case 'judgement': return pose(POSE.raise, COLOR[fx.action], { glow: 0.5 + 0.5 * fx.k });
      case 'fog': return pose(POSE.raise, COLOR.fog, { y: 300, rot: 0.6 });
      default: return pose(POSE.rest);
    }
  }
  if (S.stunned) return pose(POSE.dizzy);
  const next = S.next;
  if (next && next.action === 'crush') return pose(POSE.crush, COLOR.crush);
  if (next && next.action === 'smite') return next.side === side ? pose(POSE.smite, COLOR.smite) : pose(POSE.rest);
  if (next && next.action === 'stack') return stackHand(c, next.targetId, side, pose, null);
  if (next && next.action === 'cleanse') return pose(POSE.cleanse, COLOR.cleanse);
  return pose(S.rage ? { ...POSE.rest, glow: 0.5 } : POSE.rest, S.rage ? COLOR.rage : null);
}

const mix = (a, b, k) => Object.fromEntries(FIELDS.map(f => [f, lerp(a[f], b[f], k)]));

// 捏碎：兩手先往外拉開、降到中間那一欄的高度，再往中間合起來（CLAP_AT 那一刻合上），出招之後停一下才收回去
function crushHand(S, fx, pose) {
  const col = S.def.column;
  const reach = 158;   // 手腕到指尖（s = 1.5）
  const wide = { x: col.x0 - reach - 30, y: 500, rot: Math.PI / 2, curl: 0.15, s: 1.5, glow: 1 };
  const shut = { x: W / 2 - reach, y: 500, rot: Math.PI / 2, curl: 0, s: 1.5, glow: 1 };
  if (fx.phase === 'act') return fx.at < HOLD ? pose(shut, COLOR.crush, { snap: true }) : pose(POSE.crush, COLOR.crush);
  const A = 0.55;
  if (fx.k < A) return pose(mix(POSE.crush, wide, ease(fx.k / A)), COLOR.crush, { snap: true });
  return pose(mix(wide, shut, Math.min(1, ((fx.k - A) / (CLAP_AT - A)) ** 2)), COLOR.crush, { snap: true });
}

// 天罰：那一邊的手掌舉高、攤平，SLAM_AT 那一刻整片拍在三道斜坡上，停一下才收回去
function smiteHand(fx, pose) {
  const up = { x: 120, y: 256, rot: Math.PI / 2 + 0.1, curl: 0, s: 1.3, glow: 1 };
  const down = { x: 40, y: 470, rot: Math.PI / 2 + 0.15, curl: 0, s: 2, glow: 1 };
  if (fx.phase === 'act') return fx.at < HOLD ? pose(down, COLOR.smite, { snap: true }) : pose(POSE.smite, COLOR.smite);
  const A = 0.6;
  if (fx.k < A) return pose(mix(POSE.smite, up, ease(fx.k / A)), COLOR.smite, { snap: true });
  return pose(mix(up, down, Math.min(1, ((fx.k - A) / (SLAM_AT - A)) ** 2)), COLOR.smite, { snap: true });
}

/**
 * 同罰：目標在畫面哪一半就用那一邊的手，握成拳頭停在他頭上（x / y = 指節的底，fist = 畫成拳頭，見 drawFist），一直跟著他；另一隻手平常的姿勢。
 * 出招（fx）：預兆的前 FIST_WINDUP 舉高蓄力、之後在最高點發抖；出招那一刻砸到他頭上（同一時間每個分擔的人頭上各落下一記拳 = 飛行物），停一下才收回去。
 * 目標不在了（倒下、找不到）= 兩手平常的姿勢
 */
function stackHand(c, targetId, side, pose, fx) {
  const t = targetId ? c.match.byId(targetId) : null;
  if (!t || !t.alive) return pose(POSE.rest);
  const mySide = t.cx < W / 2 ? -1 : 1;
  if (mySide !== side) return pose(POSE.rest);
  const head = t.y - t.h;
  let y = head - FIST_HOVER + Math.sin(c.time * 3) * 3, x = t.cx, glow = 0.7, snap = false;
  if (fx && fx.phase === 'cast') {
    const up = ease(Math.min(1, fx.k / FIST_WINDUP));
    y = head - FIST_HOVER - 50 * up;
    if (fx.k > FIST_WINDUP) x += Math.sin(fx.t * 70) * 2.5;   // 蓄力發抖
    glow = 0.7 + 0.3 * up;
    snap = true;
  } else if (fx && fx.phase === 'act') {
    if (fx.at >= HOLD) return pose(POSE.rest);
    y = head;
    glow = 1;
    snap = true;
  }
  // pose 照左手寫、右手鏡像：右手先鏡像回來，畫出來才會在 x
  return pose({ x: side < 0 ? x : W - x, y, rot: 0, curl: 1, s: 1, glow }, COLOR.stack, { fist: true, snap });
}

// ---------- HUD ----------

// 下一招：一般難度帶打哪裡（天罰的左右、同罰鎖定誰）；菁英之路不寫是哪一招（U：只看得到手的姿勢，自己看手判斷）
function nextLabel(c, next) {
  const name = N[next.action] || next.action;
  if (c.rangeHints === false) return '看她的手勢';
  if (next.action === 'crush') return `${name}（中間一欄）`;
  if (next.action === 'smite') return `${name}（${next.side < 0 ? '左側' : '右側'}）`;
  if (next.action === 'stack') {
    const who = c.match.byId(next.targetId);
    // 目標倒下了：拳頭與集合圈也不畫了（stackHand / drawStackHint），她的回合換一個活著的目標（見 shared/maps/gaia.js 的 moveStep）
    if (!who || !who.alive) return `${name}（目標倒下，換人）`;
    return `${name} → ${who.name}`;   // 名單框放不下更多字；要靠過去分擔看集合圈
  }
  return name;
}

// 瘴氣 / 祭壇（暴走前）、最後之光的倒數與現在該做什麼（暴走後）
function statusLine(c, S) {
  const L = lightStatus(c.match);
  if (L) {
    if (L.countdown !== undefined) return [`最後之光：${L.countdown > 0 ? `${L.countdown} 輪後` : '這一輪！'}`, '#fde68a'];
    const when = L.judgeIn > 0 ? `${L.judgeIn} 輪後誅滅` : '這一輪誅滅';
    if (L.phase === 'collect') return [`收花 ${L.got} / ${L.need}・${when}`, '#fde68a'];
    if (L.shield) return [`回到祭壇的護盾裡！${when}`, '#fde68a'];
    return [`花枯萎了：${when}`, '#fca5a5'];
  }
  if (S.rage) return null;
  if (S.fog) return [`祭壇光球 ${S.orbs} / ${S.need}（淨化瘴氣）`, '#e9d5ff'];
  const n = S.nextFog - c.match.round;
  return [n > 0 ? `瘴氣：${n} 輪後再起` : '瘴氣：這一輪再起', '#c4b5fd'];
}

// ---------- 繪圖 ----------

// 嘴巴 / 眼睛在哪（世界座標；照臉的判定縮放）
function faceScale(e) { return { sx: e.hw / 90, sy: e.h / 190, cx: e.x, cy: e.y - e.h / 2 }; }
function mouthOf(e) {
  if (!e) return { x: W / 2, y: 290 };
  const f = faceScale(e);
  return { x: f.cx, y: f.cy + 54 * f.sy };
}
function eyesOf(e) {
  const f = faceScale(e);
  return { x: f.cx, y: f.cy - 15 * f.sy };
}

// 嘴巴張多開、嘴裡發什麼光（出招的預兆）
function mouthOpen(c) {
  const fx = c.state.fx;
  if (!fx) return { o: 0, color: null };
  const k = fx.k;
  switch (fx.action) {
    case 'fog': return { o: Math.sin(Math.min(1, k / 0.8) * Math.PI), color: COLOR.fog };
    case 'cleanse': return { o: fx.phase === 'cast' ? Math.min(0.7, k / 0.25 * 0.7) * (k > 0.8 ? (1 - k) / 0.2 : 1) : 0, color: COLOR.cleanse };
    case 'judgement': return { o: Math.min(1, k * 1.4), color: COLOR.judgement };
    case 'rage': return { o: Math.sin(k * Math.PI), color: COLOR.rage };
    case 'light': return { o: 0.45 * Math.sin(k * Math.PI), color: COLOR.light };
    case 'stunned': return { o: 0.25, color: null };
    default: return { o: 0, color: null };
  }
}

// 臉後面：一大團土與岩石、頭頂的樹冠與葉子、兩側垂下來的樹根（跟臉一起是背景；倒下了變灰）
function drawMane(ctx, c, g, S) {
  if (!g) return;
  const f = faceScale(g);
  const dead = !g.alive;
  ctx.save();
  ctx.translate(f.cx, f.cy);
  ctx.scale(f.sx, f.sy);
  // 後面的光環（暴走 = 紅、平常 = 淡綠；倒下了沒有）
  if (!dead) {
    const r = 175 + Math.sin(c.time * 1.3) * 6;
    const halo = ctx.createRadialGradient(0, -10, 60, 0, -10, r);
    halo.addColorStop(0, S.rage ? 'rgba(239,68,68,0.22)' : 'rgba(163,230,53,0.16)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, -10, r, 0, Math.PI * 2); ctx.fill();
  }
  // 兩側垂下來的樹根（頭髮）
  ctx.lineCap = 'round';
  for (let k = 0; k < 9; k++) {
    for (const s of [-1, 1]) {
      const x0 = s * (78 + k * 6), y0 = -60 + k * 12;
      const sway = Math.sin(c.time * 0.9 + k * 0.7 + s) * 6;
      ctx.strokeStyle = dead ? '#44403c' : k % 2 ? '#4a3524' : '#3a2a1b';
      ctx.lineWidth = 7 - k * 0.4;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x0 + s * (20 + k * 3), y0 + 70, x0 + s * (10 + k * 4) + sway, y0 + 120 + k * 8); ctx.stroke();
    }
  }
  // 土與岩石的頭
  ctx.fillStyle = dead ? '#3f3a36' : '#3b2a1c';
  ctx.beginPath(); ctx.ellipse(0, -18, 128, 116, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = dead ? '#4a4540' : '#4a3626';
  for (const [x, y, r] of [[-100, -40, 26], [96, -30, 30], [-60, -100, 30], [64, -98, 26], [0, -118, 22]]) {
    ctx.beginPath(); ctx.ellipse(x, y, r * 1.2, r, 0.3, 0, Math.PI * 2); ctx.fill();
  }
  // 頭頂的樹冠
  for (let k = 0; k < 11; k++) {
    const a = Math.PI * (1.08 + k * 0.084);
    const x = Math.cos(a) * 118, y = -18 + Math.sin(a) * 112;
    ctx.fillStyle = dead ? '#57534e' : k % 2 ? '#2f5d34' : '#3f7a3c';
    ctx.beginPath(); ctx.ellipse(x, y - 8, 22, 14, a + Math.PI / 2, 0, Math.PI * 2); ctx.fill();
    if (!dead && k % 3 === 0) {   // 小花
      ctx.fillStyle = '#fde68a';
      ctx.beginPath(); ctx.arc(x, y - 14, 3, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

// 臉（判定的範圍：x ± hw、腳底 = 下巴）：石頭與泥土的臉、青苔、裂縫（暴走 = 發紅光）、厚重的眉骨、發光的眼睛（看著現在輪到的人；
// 暴走 = 紅、最後之光 / 誅滅 = 金、暈眩 = 轉圈、倒下 = 闔上）、鼻樑、嘴巴（出招時張開發光）、下巴垂下來的根鬚
function drawFace(ctx, c, e, hurt, dead) {
  const S = gaiaState(c.match);
  const f = faceScale(e);
  const fx = c.state.fx;
  const rage = !!(S && S.rage) && !dead;
  const dizzy = !dead && ((S && S.stunned) || (fx && fx.action === 'stunned'));
  const gold = !dead && fx && (fx.action === 'light' || fx.action === 'judgement');
  ctx.save();
  ctx.translate(f.cx, f.cy);
  ctx.scale(f.sx, f.sy);
  const outline = () => {
    ctx.beginPath();
    ctx.moveTo(0, -95);
    ctx.bezierCurveTo(58, -97, 92, -62, 90, -12);
    ctx.bezierCurveTo(88, 34, 72, 70, 42, 86);
    ctx.quadraticCurveTo(0, 104, -42, 86);
    ctx.bezierCurveTo(-72, 70, -88, 34, -90, -12);
    ctx.bezierCurveTo(-92, -62, -58, -97, 0, -95);
    ctx.closePath();
  };
  // 臉
  const skin = ctx.createLinearGradient(0, -95, 0, 95);
  skin.addColorStop(0, dead ? '#78716c' : '#8f7656');
  skin.addColorStop(1, dead ? '#57534e' : '#5c4731');
  ctx.fillStyle = skin;
  outline(); ctx.fill();
  ctx.strokeStyle = dead ? '#3f3a36' : '#3b2a1c';
  ctx.lineWidth = 4;
  ctx.stroke();
  // 青苔
  ctx.fillStyle = dead ? 'rgba(87,83,78,0.6)' : 'rgba(74,124,60,0.75)';
  for (const [x, y, rx, ry] of [[-22, -78, 26, 9], [28, -82, 20, 7], [-64, 18, 14, 22], [66, 8, 12, 20], [-30, 82, 18, 6]]) {
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  }
  // 裂縫（暴走：底下一層紅光）
  const cracks = [[[-50, -88], [-38, -62], [-46, -44]], [[60, -70], [48, -52], [56, -38]], [[-80, 10], [-62, 26], [-70, 46]], [[78, 20], [64, 34], [70, 56]], [[10, -95], [4, -70]]];
  const crackPath = () => { ctx.beginPath(); for (const pts of cracks) { ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); } };
  if (rage) {
    ctx.strokeStyle = `rgba(239,68,68,${0.45 + 0.2 * Math.sin(c.time * 5)})`;
    ctx.lineWidth = 7;
    crackPath(); ctx.stroke();
    ctx.strokeStyle = '#fecaca';
    ctx.lineWidth = 2;
  } else {
    ctx.strokeStyle = dead ? '#292524' : 'rgba(41,28,18,0.8)';
    ctx.lineWidth = 2;
  }
  crackPath(); ctx.stroke();
  // 眉骨（暴走時往中間壓下來）
  ctx.fillStyle = dead ? '#57534e' : '#6b5338';
  for (const s of [-1, 1]) {
    const inner = rage ? -26 : -36;
    ctx.beginPath();
    ctx.moveTo(s * 72, -38); ctx.lineTo(s * 14, inner); ctx.lineTo(s * 14, inner + 9); ctx.lineTo(s * 72, -28);
    ctx.closePath(); ctx.fill();
  }
  // 眼睛：眼窩、發光的眼珠（看著現在輪到的人）
  const cur = c.match.byId(c.currentId);
  const look = cur && cur !== e ? { x: Math.max(-1, Math.min(1, (cur.x - e.x) / 380)) * 6, y: Math.max(-1, Math.min(1, (cur.cy - f.cy) / 380)) * 4 } : { x: 0, y: 0 };
  const eyeColor = rage ? '#f87171' : gold ? '#fde68a' : '#86efac';
  for (const s of [-1, 1]) {
    const ex = s * 40, ey = -15;
    ctx.fillStyle = '#1c140c';
    ctx.beginPath(); ctx.ellipse(ex, ey, 24, 14, 0, 0, Math.PI * 2); ctx.fill();
    if (dead) {
      ctx.strokeStyle = '#a8a29e';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(ex - 16, ey); ctx.quadraticCurveTo(ex, ey + 6, ex + 16, ey); ctx.stroke();
      continue;
    }
    if (dizzy) {   // 轉圈圈
      ctx.strokeStyle = '#fde68a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 5; a += 0.3) {
        const r = a * 1.6, aa = a + c.time * 6 * s;
        const px = ex + Math.cos(aa) * r, py = ey + Math.sin(aa) * r * 0.6;
        if (a) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
      continue;
    }
    const bright = fx && fx.phase === 'cast' ? 1 : 0.7 + 0.15 * Math.sin(c.time * 2);
    const glow = ctx.createRadialGradient(ex + look.x, ey + look.y, 0, ex + look.x, ey + look.y, 26);
    glow.addColorStop(0, hexA(eyeColor, 0.9 * bright));
    glow.addColorStop(1, hexA(eyeColor, 0));
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(ex + look.x, ey + look.y, 26, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = hurt ? '#ffffff' : eyeColor;
    ctx.beginPath(); ctx.arc(ex + look.x, ey + look.y, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f0fdf4';
    ctx.beginPath(); ctx.arc(ex + look.x - 2, ey + look.y - 2, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  // 鼻樑
  ctx.strokeStyle = dead ? '#3f3a36' : '#4a3626';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(-4, -26); ctx.quadraticCurveTo(-12, 10, -14, 26); ctx.quadraticCurveTo(0, 34, 14, 26); ctx.stroke();
  // 嘴巴
  const mo = dead ? { o: 0, color: null } : mouthOpen(c);
  if (mo.o > 0.03) {
    ctx.fillStyle = '#140c06';
    ctx.beginPath(); ctx.ellipse(0, 54, 34, 4 + mo.o * 18, 0, 0, Math.PI * 2); ctx.fill();
    if (mo.color) {
      const g = ctx.createRadialGradient(0, 54, 0, 0, 54, 30);
      g.addColorStop(0, hexA(mo.color, 0.9 * mo.o));
      g.addColorStop(1, hexA(mo.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 54, 34, 4 + mo.o * 18, 0, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    ctx.strokeStyle = dead ? '#292524' : '#2a1d12';
    ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(-38, rage ? 56 : 50); ctx.quadraticCurveTo(0, rage ? 48 : 58, 38, rage ? 56 : 50); ctx.stroke();
  }
  // 下巴的根鬚
  ctx.strokeStyle = dead ? '#44403c' : '#4a3524';
  ctx.lineWidth = 3;
  for (let k = -3; k <= 3; k++) {
    const x0 = k * 11, sway = dead ? 0 : Math.sin(c.time * 1.4 + k) * 4;
    ctx.beginPath(); ctx.moveTo(x0, 92 - Math.abs(k) * 2); ctx.quadraticCurveTo(x0 + sway, 112, x0 + sway * 1.5, 122 + (k % 2) * 8); ctx.stroke();
  }
  // 剛被打到：整張臉閃白
  if (hurt && !dead) {
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    outline(); ctx.fill();
  }
  // 暈眩：頭上轉圈的星星
  if (dizzy) {
    for (let k = 0; k < 3; k++) {
      const a = c.time * 3 + k * Math.PI * 2 / 3;
      drawStar(ctx, Math.cos(a) * 70, -108 + Math.sin(a) * 12, 7, '#fde047');
    }
  }
  ctx.restore();
}

// '#rrggbb' + 透明度 → rgba()
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

function drawStar(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
    if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath(); ctx.fill();
}

// 一隻石手（h = 姿勢；side -1 = 左手、1 = 右手鏡像）：手腕垂著幾條樹根、掌心正對畫面、四根手指 + 拇指（curl 越大越像握拳）、
// 掌心的符文照 glow 發光（顏色 = 這一招的顏色）
function drawHand(ctx, h, side, t, dead) {
  ctx.save();
  ctx.translate(h.x, h.y);
  ctx.scale(side < 0 ? 1 : -1, 1);
  ctx.rotate(h.rot);
  ctx.scale(h.s, h.s);
  const glow = dead ? 0 : h.glow;
  if (glow > 0.05) {
    const g = ctx.createRadialGradient(0, -50, 0, 0, -50, 90);
    g.addColorStop(0, hexA(h.color, 0.32 * glow));
    g.addColorStop(1, hexA(h.color, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, -50, 90, 0, Math.PI * 2); ctx.fill();
  }
  const stone = dead ? '#57534e' : '#7a6248', edge = dead ? '#3f3a36' : '#3e2f20';
  ctx.lineCap = 'round';
  // 手腕的樹根
  ctx.strokeStyle = dead ? '#44403c' : '#4a3524';
  ctx.lineWidth = 3;
  for (const k of [-16, -4, 8, 20]) {
    const w = dead ? 0 : Math.sin(t * 1.8 + k) * 5;
    ctx.beginPath(); ctx.moveTo(k, -2); ctx.quadraticCurveTo(k + w, 16, k + w * 1.6, 28 + (Math.abs(k) % 12)); ctx.stroke();
  }
  // 手指：先畫深色的邊、再畫石頭的顏色
  const curl = Math.max(0, Math.min(1, h.curl));
  const fingers = [[-24, 40], [-8, 47], [8, 45], [24, 38]];
  const thumb = [[28, -16], [46, -36], [52 - curl * 16, -54 + curl * 24]];
  const bones = fingers.map(([x, L]) => {
    const kn = -58 - L * 0.55 * (1 - curl * 0.35);
    return [[x, -56], [x, kn], [x * (1 - curl * 0.2), kn - L * 0.45 * (1 - curl * 0.75)]];
  });
  for (const [width, color] of [[16, edge], [12, stone]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    for (const pts of [...bones, thumb]) {
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
  }
  // 掌心
  ctx.fillStyle = stone;
  ctx.strokeStyle = edge;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-30, 0); ctx.lineTo(-34, -50); ctx.quadraticCurveTo(-33, -63, -20, -63);
  ctx.lineTo(20, -63); ctx.quadraticCurveTo(33, -63, 34, -50); ctx.lineTo(30, 0); ctx.quadraticCurveTo(0, 8, -30, 0);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // 青苔、裂縫
  ctx.fillStyle = dead ? 'rgba(87,83,78,0.7)' : 'rgba(74,124,60,0.8)';
  ctx.beginPath(); ctx.ellipse(-14, -56, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(18, -8, 8, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-22, -10); ctx.lineTo(-12, -22); ctx.lineTo(-16, -34); ctx.stroke();
  // 掌心的符文
  if (!dead) {
    ctx.strokeStyle = hexA(h.color, 0.35 + 0.6 * glow);
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0, -30, 11, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -41); ctx.lineTo(0, -19); ctx.moveTo(-9, -24); ctx.lineTo(9, -36); ctx.stroke();
  }
  ctx.restore();
}

// 一般難度：預定的捏碎 / 天罰打的範圍畫紅色的警示帶（出招的預兆時快閃；箭頭 = 被推的方向）。菁英之路不畫（只看手的姿勢）
function drawWarning(ctx, c, S, g) {
  if (c.rangeHints === false || !g || !g.alive) return;
  const fx = c.state.fx;
  let plan = null, casting = false;
  if (fx && (fx.action === 'crush' || fx.action === 'smite' || fx.action === 'stack' || fx.action === 'cleanse')) {
    if (fx.phase === 'cast' && (fx.action === 'crush' || fx.action === 'smite')) { plan = { action: fx.action, side: fx.step.side }; casting = true; }
  } else if (!S.stunned) plan = S.next;
  const z = zoneOf(S.def, plan);
  if (!z) return;
  const a = casting ? 0.3 + 0.16 * Math.sin(fx.t * 18) : 0.15 + 0.06 * Math.sin(c.time * 3);
  ctx.save();
  ctx.fillStyle = `rgba(239,68,68,${a})`;
  ctx.fillRect(z.x0, BAND_TOP, z.x1 - z.x0, WATER - BAND_TOP);
  ctx.strokeStyle = `rgba(254,202,202,${casting ? 0.9 : 0.6})`;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  for (const x of [z.x0, z.x1]) if (x > 0 && x < W) { ctx.beginPath(); ctx.moveTo(x, BAND_TOP); ctx.lineTo(x, WATER); ctx.stroke(); }
  ctx.setLineDash([]);
  // 往哪邊推：捏碎 = 離開祭壇（兩邊往外）；天罰 = 往牆那邊
  ctx.fillStyle = `rgba(254,226,226,${casting ? 0.85 : 0.55})`;
  const ax = S.def.altar.x;
  const drift = (c.time * 30) % 24;
  for (const y of [400, 470, 540, 610]) {
    if (plan.action === 'crush') {
      for (const s of [-1, 1]) chevron(ctx, ax + s * (40 + drift), y, s);
    } else {
      const mid = (z.x0 + z.x1) / 2;
      chevron(ctx, mid + plan.side * drift, y, plan.side);
    }
  }
  ctx.restore();
}

function chevron(ctx, x, y, dir) {
  ctx.beginPath();
  ctx.moveTo(x - dir * 6, y - 9); ctx.lineTo(x + dir * 6, y); ctx.lineTo(x - dir * 6, y + 9);
  ctx.lineTo(x - dir * 2, y); ctx.closePath(); ctx.fill();
}

// 祭壇（中間那層的正中央）：石台、上面一排凹槽（要收幾顆 = 幾個；收到的發光，最後之光是白金色）、收得越滿頂上的光越亮
function drawAltar(ctx, c, S) {
  const a = S.def.altar;
  const s = c.state;
  const light = !!S.light;
  const flying = s.orbs.filter(o => !o.landed && o.light === light).length;
  let need = light ? S.light.need : S.need;
  let got = light ? S.light.got : S.orbs;
  if (!light && s.purify && c.time < s.purify.t0 + 1.2) { need = s.purify.need; got = need; }   // 淨化：凹槽照收滿的畫到光散掉
  const lit = Math.max(0, Math.min(need, got - flying));
  ctx.save();
  // 頂上的光
  const ratio = need ? lit / need : 0;
  if (ratio > 0 || (light && S.light.shield)) {
    const r = 14 + 22 * ratio;
    const g = ctx.createRadialGradient(a.x, a.y - 38, 0, a.x, a.y - 38, r);
    g.addColorStop(0, light ? 'rgba(255,251,235,0.85)' : 'rgba(253,224,71,0.8)');
    g.addColorStop(1, 'rgba(253,224,71,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(a.x, a.y - 38, r, 0, Math.PI * 2); ctx.fill();
  }
  // 石台：底座、柱子、盆
  ctx.fillStyle = '#57534e';
  ctx.fillRect(a.x - 34, a.y - 7, 68, 7);
  ctx.fillStyle = '#78716c';
  ctx.fillRect(a.x - 15, a.y - 26, 30, 19);
  ctx.fillStyle = '#a8a29e';
  ctx.beginPath(); ctx.moveTo(a.x - 32, a.y - 34); ctx.lineTo(a.x + 32, a.y - 34); ctx.lineTo(a.x + 22, a.y - 25); ctx.lineTo(a.x - 22, a.y - 25); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(74,124,60,0.8)';
  ctx.beginPath(); ctx.ellipse(a.x - 22, a.y - 6, 10, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#44403c';
  ctx.lineWidth = 1;
  ctx.strokeRect(a.x - 15, a.y - 26, 30, 19);
  // 凹槽
  const gap = 9.5, x0 = a.x - (need - 1) * gap / 2;
  for (let k = 0; k < need; k++) {
    const x = x0 + k * gap, y = a.y - 30;
    ctx.fillStyle = '#1c1917';
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    if (k < lit) {
      ctx.fillStyle = light ? ALTAR_COLOR.light : ALTAR_COLOR.orb;
      ctx.beginPath(); ctx.arc(x, y, 3 + 0.5 * Math.sin(c.time * 6 + k), 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

// 自然之花（腳底 (x, y) = 斜坡表面）：發光的金色花、花莖、兩片葉子；s = 開到多大、wilt = 枯萎的進度（0 = 好好的、1 = 不見了）
function drawFlower(ctx, x, y, s, t, wilt) {
  const cy = y - FLOWER_LIFT;
  ctx.save();
  ctx.globalAlpha *= 1 - wilt;
  if (!wilt) {
    const r = (FLOWER_R + 10 + Math.sin(t * 3) * 3) * s;
    const g = ctx.createRadialGradient(x, cy, 0, x, cy, r);
    g.addColorStop(0, 'rgba(254,240,138,0.7)');
    g.addColorStop(1, 'rgba(254,240,138,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, cy, r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = wilt ? '#78716c' : '#4d7c0f';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x - 2, y - 6, x, cy + wilt * 6); ctx.stroke();
  ctx.fillStyle = wilt ? '#78716c' : '#65a30d';
  ctx.beginPath(); ctx.ellipse(x - 4, y - 4, 4, 2, -0.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x + 4, y - 5, 4, 2, 0.5, 0, Math.PI * 2); ctx.fill();
  const py = cy + wilt * 6;
  ctx.fillStyle = wilt ? '#a8a29e' : '#fde047';
  for (let k = 0; k < 6; k++) {
    const a = k * Math.PI / 3 + (wilt ? 0 : t * 0.6) + wilt * 0.8;
    const droop = wilt * 4;
    ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * 5.5 * s, py + Math.sin(a) * 5.5 * s + droop, 4 * s, 2.6 * s, a, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = wilt ? '#78716c' : '#fff7ed';
  ctx.beginPath(); ctx.arc(x, py, 2.8 * s, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 飛向祭壇的光球（弧線、後面拖著光點）
function drawOrb(ctx, c, S, o) {
  const k = Math.min(1, (c.time - o.t0) / ORB_FLIGHT);
  if (k >= 1) return;
  const a = S.def.altar;
  const at = (q) => ({ x: lerp(o.x0, a.x, ease(q)), y: lerp(o.y0, a.y - 34, ease(q)) - Math.sin(q * Math.PI) * 90 });
  const color = o.light ? ALTAR_COLOR.light : ALTAR_COLOR.orb;
  ctx.save();
  for (let i = 1; i <= 5; i++) {
    const p = at(Math.max(0, k - i * 0.04));
    ctx.fillStyle = hexA(color, 0.5 - i * 0.08);
    ctx.beginPath(); ctx.arc(p.x, p.y, 5 - i * 0.6, 0, Math.PI * 2); ctx.fill();
  }
  const p = at(k);
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 16);
  g.addColorStop(0, hexA(color, 0.95));
  g.addColorStop(1, hexA(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(p.x, p.y, 16, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 瘴氣：整個畫面一層紫色的薄霧（越往下越濃），幾團慢慢飄的霧；暴走時帶一點紅
function drawFog(ctx, c, S) {
  const d = c.state.fog;
  if (d < 0.02) return;
  ctx.save();
  const g = ctx.createLinearGradient(0, 0, 0, CONFIG.WORLD_H);
  g.addColorStop(0, `rgba(88,28,135,${0.06 * d})`);
  g.addColorStop(0.7, `rgba(107,33,168,${0.13 * d})`);
  g.addColorStop(1, `rgba(59,7,100,${0.2 * d})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, CONFIG.WORLD_H);
  for (let k = 0; k < 7; k++) {
    const x = ((k * 173 + c.time * (12 + k * 3)) % (W + 300)) - 150, y = 180 + (k * 71) % 420;
    const r = 90 + (k % 3) * 30;
    const wisp = ctx.createRadialGradient(x, y, 0, x, y, r);
    wisp.addColorStop(0, S.rage && k % 2 ? `rgba(185,28,28,${0.08 * d})` : `rgba(168,85,247,${0.1 * d})`);
    wisp.addColorStop(1, 'rgba(168,85,247,0)');
    ctx.fillStyle = wisp;
    ctx.beginPath(); ctx.ellipse(x, y, r * 1.6, r * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// 祭壇的金色護盾（最後之光收齊了）：罩住祭壇那一層的半圓，表面一圈一圈的光紋
function drawDome(ctx, c, S) {
  const d = c.state.dome;
  if (d < 0.02) return;
  const b = S.def.shield, a = S.def.altar;
  // 左右照護盾的範圍（inShield：身體碰到就算，所以多畫半個身體）；上緣壓在上面那一層平台（y 440）底下，站上去的人不會看起來在護盾裡
  const rx = (b.x1 - b.x0) / 2 + 9, ry = 60;
  ctx.save();
  const g = ctx.createRadialGradient(a.x, a.y, ry * 0.3, a.x, a.y, rx);
  g.addColorStop(0, `rgba(254,243,199,${0.05 * d})`);
  g.addColorStop(1, `rgba(253,230,138,${0.2 * d})`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(a.x, a.y, rx, ry, 0, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = `rgba(253,230,138,${(0.6 + 0.25 * Math.sin(c.time * 4)) * d})`;
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(a.x, a.y, rx, ry, 0, Math.PI, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1;
  for (let k = 1; k <= 3; k++) {
    const q = ((k / 3 + c.time * 0.25) % 1);
    ctx.strokeStyle = `rgba(254,249,195,${0.35 * (1 - q) * d})`;
    ctx.beginPath(); ctx.ellipse(a.x, a.y, rx * q, ry * q, 0, Math.PI, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

// 淨化的綠色光球（11-04 改：只淨化她自己）：預兆的前 45% 在嘴邊聚起來，之後往上飄、縮小，ABSORB_AT 那一刻吸回臉上；
// 吸回去之後臉上一圈綠光慢慢淡掉（回血）
function drawCleanseOrb(ctx, c) {
  const fx = c.state.fx;
  if (!fx || fx.action !== 'cleanse') return;
  const g = gaiaOf(c.match);
  if (!g) return;
  const m = mouthOf(g), e = eyesOf(g);
  const F = 0.45;
  ctx.save();
  if (fx.phase === 'cast' && fx.k < ABSORB_AT) {
    let x = m.x, y = m.y, r;
    if (fx.k < F) r = 6 + 16 * ease(fx.k / F);
    else {
      const q = ease((fx.k - F) / (ABSORB_AT - F));
      x = m.x + Math.sin(q * Math.PI) * 26;
      y = lerp(m.y, e.y + 10, q);
      r = 22 - 12 * q;
    }
    const gl = ctx.createRadialGradient(x, y, 0, x, y, r);
    gl.addColorStop(0, 'rgba(220,252,231,0.95)');
    gl.addColorStop(0.5, 'rgba(74,222,128,0.6)');
    gl.addColorStop(1, 'rgba(74,222,128,0)');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  } else {
    const since = fx.phase === 'cast' ? (fx.k - ABSORB_AT) * fx.cast : (1 - ABSORB_AT) * fx.cast + fx.at;
    const a = Math.max(0, 1 - since / 0.9);
    if (a > 0) {
      const cy = g.y - g.h / 2, r = g.hw * 1.3;
      const gl = ctx.createRadialGradient(g.x, cy, r * 0.2, g.x, cy, r);
      gl.addColorStop(0, `rgba(134,239,172,${0.45 * a})`);
      gl.addColorStop(1, 'rgba(74,222,128,0)');
      ctx.fillStyle = gl;
      ctx.beginPath(); ctx.arc(g.x, cy, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

/**
 * 一般難度：同罰的集合圈（預定的目標身上、出招時快閃）——半徑 stackRadius 的圈（圈裡的人一起分擔）、往圈裡指的箭頭、
 * 「集合分擔」與現在圈裡幾個人；圈裡的人腳下亮一圈。出招時標的是伺服器算好的分擔的人（step.targetIds）。菁英之路不畫（只看得到拳頭）
 */
function drawStackHint(ctx, c, S, g) {
  if (c.rangeHints === false || !g || !g.alive) return;
  const fx = c.state.fx;
  let id = null, ids = null, casting = false;
  if (fx && fx.action === 'stack') { if (fx.phase === 'cast') { id = fx.step.targetId; ids = fx.step.targetIds || []; casting = true; } }
  else if (!S.stunned && S.next && S.next.action === 'stack') id = S.next.targetId;
  const t = id ? c.match.byId(id) : null;
  if (!t || !t.alive) return;
  const sharers = ids ? ids.map(k => c.match.byId(k)).filter(Boolean) : stackSharers(c.match, t);
  const R = CONFIG.GAIA.stackRadius;
  const pulse = casting ? 0.5 + 0.5 * Math.sin(fx.t * 16) : 0.5 + 0.5 * Math.sin(c.time * 3);
  ctx.save();
  ctx.fillStyle = `rgba(251,146,60,${0.08 + 0.06 * pulse})`;
  ctx.beginPath(); ctx.arc(t.cx, t.cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = `rgba(254,215,170,${casting ? 0.95 : 0.75})`;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([10, 6]);
  ctx.beginPath(); ctx.arc(t.cx, t.cy, R, -c.time * 0.8, -c.time * 0.8 + Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  // 往圈裡指的箭頭（四個方向，慢慢往中間縮）
  ctx.fillStyle = `rgba(255,237,213,${casting ? 0.9 : 0.7})`;
  const d = R + 16 - ((c.time * 18) % 12);
  for (let k = 0; k < 4; k++) {
    const a = k * Math.PI / 2 + Math.PI / 4;
    ctx.save();
    ctx.translate(t.cx + Math.cos(a) * d, t.cy + Math.sin(a) * d);
    ctx.rotate(a + Math.PI);
    ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-6, -8); ctx.lineTo(-2, 0); ctx.lineTo(-6, 8); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  // 圈裡的人腳下亮一圈
  for (const e of sharers) {
    if (!e.alive) continue;
    ctx.strokeStyle = `rgba(253,186,116,${0.6 + 0.35 * pulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(e.x, e.y, e.hw + 6, 5, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.font = 'bold 13px "Microsoft JhengHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(28,25,23,0.85)';
  const label = `集合分擔（${sharers.length} 人）`;
  ctx.strokeText(label, t.cx, t.cy + R + 12);
  ctx.fillStyle = '#fed7aa';
  ctx.fillText(label, t.cx, t.cy + R + 12);
  ctx.restore();
}

/**
 * 同罰的石拳（拳頭朝下；(x, y) = 指節的底）：往上接著手臂（越上面越淡）、四個指節、拇指橫在前面、手背上的符文照 glow 發光。
 * arm = 畫手臂（她的手；飛行物的拳影不畫）
 */
function drawFist(ctx, x, y, s, color, glow, dead, arm, t = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  const stone = dead ? '#57534e' : '#7a6248', edge = dead ? '#3f3a36' : '#3e2f20';
  const gl = dead ? 0 : glow;
  if (gl > 0.05) {
    const g = ctx.createRadialGradient(0, -38, 0, 0, -38, 80);
    g.addColorStop(0, hexA(color, 0.35 * gl));
    g.addColorStop(1, hexA(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, -38, 80, 0, Math.PI * 2); ctx.fill();
  }
  if (arm) {
    const g = ctx.createLinearGradient(0, -150, 0, -60);
    g.addColorStop(0, 'rgba(122,98,72,0)');
    g.addColorStop(1, stone);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(-26, -62); ctx.lineTo(-20, -150); ctx.lineTo(20, -150); ctx.lineTo(26, -62); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = dead ? '#44403c' : '#4a3524';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    for (const k of [-22, 22]) {   // 手腕垂下來的樹根
      const w = dead ? 0 : Math.sin(t * 1.8 + k) * 4;
      ctx.beginPath(); ctx.moveTo(k, -70); ctx.quadraticCurveTo(k * 1.4 + w, -50, k * 1.6 + w * 1.5, -34); ctx.stroke();
    }
  }
  // 拳頭本體
  ctx.fillStyle = stone;
  ctx.strokeStyle = edge;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-38, -66); ctx.lineTo(38, -66); ctx.quadraticCurveTo(46, -66, 46, -54); ctx.lineTo(44, -16);
  ctx.lineTo(-44, -16); ctx.lineTo(-46, -54); ctx.quadraticCurveTo(-46, -66, -38, -66);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // 四個指節
  for (const kx of [-30, -10, 10, 30]) {
    ctx.beginPath(); ctx.ellipse(kx, -12, 11, 12, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // 拇指橫在前面
  ctx.beginPath();
  ctx.moveTo(-44, -44); ctx.quadraticCurveTo(-10, -50, 8, -36); ctx.quadraticCurveTo(10, -26, -2, -26); ctx.quadraticCurveTo(-24, -30, -44, -28);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // 青苔、手背的符文
  ctx.fillStyle = dead ? 'rgba(87,83,78,0.7)' : 'rgba(74,124,60,0.8)';
  ctx.beginPath(); ctx.ellipse(-24, -60, 12, 4, 0, 0, Math.PI * 2); ctx.fill();
  if (!dead) {
    ctx.strokeStyle = hexA(color, 0.35 + 0.6 * gl);
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(24, -46, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(24, -54); ctx.lineTo(24, -38); ctx.stroke();
  }
  ctx.restore();
}

// 誅滅的預兆：整個畫面慢慢變亮、她的眼睛射出光柱照著每個人（護盾外的人）
function drawJudgeLight(ctx, c) {
  const fx = c.state.fx;
  if (!fx || fx.action !== 'judgement' || fx.phase !== 'cast' || fx.k >= JUDGE_AT) return;
  const g = gaiaOf(c.match);
  if (!g) return;
  const k = fx.k / JUDGE_AT;
  ctx.save();
  ctx.fillStyle = `rgba(255,251,235,${0.28 * k * k})`;
  ctx.fillRect(0, 0, W, CONFIG.WORLD_H);
  const e = eyesOf(g);
  ctx.strokeStyle = `rgba(254,243,199,${0.25 + 0.5 * k})`;
  ctx.lineWidth = 1 + 3 * k;
  for (const p of c.match.players) {
    if (!p.alive) continue;
    ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(p.cx, p.cy); ctx.stroke();
  }
  ctx.restore();
}

// 捏碎 / 天罰的震波（飛行物）：往前一圈圈的弧
function drawShock(ctx, p, color) {
  const dir = p.vx >= 0 ? 1 : -1;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(dir, 1);
  ctx.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    ctx.strokeStyle = hexA(color, 0.85 - k * 0.25);
    ctx.lineWidth = 4 - k;
    ctx.beginPath(); ctx.arc(-k * 9, 0, 16 + k * 7, -0.9, 0.9); ctx.stroke();
  }
  ctx.restore();
}
