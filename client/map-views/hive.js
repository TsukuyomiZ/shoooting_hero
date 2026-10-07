import { CONFIG } from '../../shared/config.js';
import { BEE_ACTION_NAMES } from '../../shared/hive.js';
import { text } from '../draw.js';

// 小關「小心擊發」的地圖畫面：蜜蜂回合的動畫腳本（照伺服器廣播的招式播）、蜜蜂飛出蜂巢、蜂巢 / 蜜蜂倒下，
// 以及蜂巢 / 蜜蜂 / 衝刺螫擊的繪圖。掛勾的說明見 index.js
const FPS = 60;
const HONEY = '#f59e0b', COMB = '#b45309', COMB_DARK = '#7c2d12';

export const hive = {
  type: 'hive',

  // 這一場的畫面狀態：bees = 蜜蜂 id → { dir, windup, charging }
  //   dir       預兆時往哪個方向縮（朝目標的單位向量；畫面用，不影響位置）
  //   windup    預兆的進度 0..1（越抖越快），出招前歸零
  //   charging  衝出去了：飛行物本身就是牠，角色先不畫
  create: () => ({ bees: new Map() }),

  turnScript: beeTurnScript,
  onDeath: onHiveDeath,

  // 播到一半丟掉：預兆的抖動、衝出去（角色不畫）不要一直留著
  abortScript(c) {
    for (const id of c.state.bees.keys()) {
      const rec = c.state.bees.get(id);
      rec.windup = 0;
      rec.charging = false;
    }
  },

  // 打到蜂巢：飛出蜜蜂
  showEvent(c, ev, made) {
    if (ev.bees) showBees(c, made.bees);
  },

  // 蜜蜂衝出去了：飛行物本身就是牠（見 drawProjectile），角色不畫
  drawEntityBare(ctx, c, e) {
    const r = c.state.bees.get(e.id);
    return !!(r && r.charging);
  },

  // 蜂巢：血量畫在下面（上面是樹枝），不會輪到它，不用行動標記 → 整個自己畫（'whole'）。
  // 蜜蜂：飛在空中，沒有影子、不拿武器
  drawEntity(ctx, c, e, hurt) {
    if (e.kind === 'hive') { drawHive(ctx, c, e, hurt); return 'whole'; }
    if (e.kind === 'bee') { drawBee(ctx, c, e, hurt); return 'body'; }
    return false;
  },

  drawProjectile: drawHiveProjectile,

  // 打不打都可以的蜂巢、蜜蜂不算在「敵人剩餘」裡；同一行另外標場上的蜜蜂數（名單框才不會蓋到樹枝上的狙擊手）
  hud(c, [label, color]) {
    const bees = c.match.enemies.filter(e => e.kind === 'bee' && e.alive).length;
    return [[`${label}　蜜蜂 ×${bees}`, color]];
  },
};

// 蜜蜂在畫面上的狀態（沒有就建一筆）
function beeView(c, bee) {
  let r = c.state.bees.get(bee.id);
  if (!r) c.state.bees.set(bee.id, r = { dir: null, windup: 0, charging: false });
  return r;
}

// ---------- 動畫腳本 ----------

// 蜜蜂的回合：一招（待機 / 衝刺螫擊），格式跟 Boss 一樣（msg.boss.steps）。
// 衝刺螫擊：先往後縮、抖一抖（預兆）→ 蜜蜂本身就是飛行物，照 shotScript 重播（這段時間角色本身不畫）→ 校正成伺服器結果（停在被螫的人旁邊）
function* beeTurnScript(c, msg) {
  const bee = c.match.byId(msg.actorId);
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* beeStepScript(c, bee, step);
}

function* beeStepScript(c, bee, b) {
  const match = c.match;
  const cast = Math.round(CONFIG.TIMING.bossCast * FPS);
  const target = b.targetId ? match.byId(b.targetId) : null;
  const name = bee ? bee.name : '蜜蜂';
  const rec = bee ? beeView(c, bee) : null;
  if (b.action === 'sting') c.fx.banner(`${name}：${BEE_ACTION_NAMES.sting}${target ? ` → ${target.name}` : ''}！`, '#fde047');
  else if (b.action === 'wait') c.fx.banner(`${name}：${BEE_ACTION_NAMES.wait}`, '#fef08a');
  else c.fx.banner(`${name} ${BEE_ACTION_NAMES.idle}`, '#fef08a');
  if (bee) {
    c.fx.sound('buzz', { x: bee.x, vol: b.action === 'sting' ? 1 : 0.6 });
    // 預兆：往目標的反方向縮回去、越抖越快（畫面用，不影響位置）
    if (target) {
      const dx = target.cx - bee.cx, dy = target.cy - bee.cy, d = Math.hypot(dx, dy) || 1;
      rec.dir = { x: dx / d, y: dy / d };
      bee.facing = dx >= 0 ? 1 : -1;
    }
  }
  for (let i = 0; i < cast; i++) {
    if (bee) rec.windup = b.action === 'sting' ? i / cast : 0;
    yield { frames: 1 };
  }
  if (bee) rec.windup = 0;
  if (b.shot) {
    // 衝出去的那段：飛行物畫成蜜蜂，角色本身先不畫（charging）。飛行物一消失（螫到人）就把蜜蜂放到伺服器算好的停留位置、畫回來，
    // 不用等 shotScript 後面的落地等待（那段要等被擊退的人站穩，蜜蜂會憑空消失快一秒）。蜜蜂固定在空中、客戶端不做碰撞，提早放過去不影響重播
    // 每個飛行幀結束（濾掉結束的飛行物之後）看一次：重播模組的 frame 掛勾，不用自己一步一步推 shotScript
    const own = bee ? b.shot.results.find(s => s.id === bee.id) : null;
    let seen = false;
    const frame = (live) => {
      if (!bee) return;
      if (live.some(p => p.weapon.id === 'beeSting')) { seen = true; rec.charging = true; }
      else if (seen && rec.charging) {
        rec.charging = false;
        if (own) { bee.x = own.x; bee.y = own.y; bee.facing = own.facing; }
      }
    };
    try {
      yield* c.shotScript(b.shot, { frame });
    } finally {
      if (bee) rec.charging = false;
    }
  } else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }
}

// 剛飛出來的蜜蜂（已經建好的角色；重播時由 shared/volley.js 建）：從蜂巢口噴出一點蜂蜜色的粒子、飄字、嗡嗡聲
function showBees(c, bees) {
  if (!bees || !bees.length) return;
  const hive = c.match.byId('hive');
  for (const e of bees) {
    if (hive) c.fx.particles(hive.x, hive.y - 6, 10, { speed: 90, life: 0.5, size: 3, color: HONEY, gravity: 200 });
    c.fx.float(e, '蜜蜂飛出來了！', '#fde047', 15);
  }
  c.fx.sound('buzz', { x: hive ? hive.x : 500 });
}

// 蜂巢 / 蜜蜂倒下：回傳 true 表示處理過了（不要再顯示一般的「被擊倒」橫幅）
function onHiveDeath(c, e) {
  if (e.kind === 'bee' && e.deathCause === 'sting') {   // BEE.diesOnSting：螫完自己死掉，不是被人打倒的
    c.fx.float(e, '螫完力竭', '#fef08a', 14);
    return true;
  }
  if (e.kind !== 'hive') return false;
  c.fx.banner('蜂巢被打掉了！', '#fdba74');
  c.fx.particles(e.x, e.cy, 24, { speed: 150, life: 0.9, size: 4, color: COMB, gravity: 600 });
  c.fx.particles(e.x, e.cy, 12, { speed: 80, life: 0.8, size: 3, color: HONEY, gravity: 400 });
  return true;
}

// ---------- 繪圖 ----------

// 一隻蜜蜂（面向 +x，中心在原點，s = 縮放）：條紋身體、尾針、翅膀拍動（flap = 時間相位）
function drawBeeShape(ctx, s, flap, hurt) {
  ctx.save();
  ctx.scale(s, s);
  // 翅膀（身體後面、上方，拍動時上下縮放）
  const k = 0.35 + 0.65 * Math.abs(Math.sin(flap));
  ctx.fillStyle = 'rgba(224,242,254,0.75)';
  ctx.strokeStyle = 'rgba(148,163,184,0.8)';
  ctx.lineWidth = 1;
  for (const [wx, ww] of [[-3, 7], [2, 6]]) {
    ctx.save(); ctx.translate(wx, -6); ctx.scale(1, k);
    ctx.beginPath(); ctx.ellipse(0, -5, ww * 0.6, ww, -0.35, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // 尾針
  ctx.fillStyle = '#1f1f1f';
  ctx.beginPath(); ctx.moveTo(-10, -1.5); ctx.lineTo(-15, 0); ctx.lineTo(-10, 1.5); ctx.closePath(); ctx.fill();
  // 身體：黃黑條紋
  ctx.save();
  ctx.beginPath(); ctx.ellipse(0, 0, 10.5, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = hurt ? '#ffffff' : '#facc15';
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = hurt ? '#ddd' : '#1c1917';
  for (const x of [-6.5, -1.5, 3.5]) ctx.fillRect(x, -8, 2.6, 16);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.ellipse(0, 0, 10.5, 7, 0, 0, Math.PI * 2); ctx.stroke();
  // 頭、眼睛、觸角
  ctx.fillStyle = hurt ? '#eee' : '#292524';
  ctx.beginPath(); ctx.arc(10, -1, 4.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fef3c7';
  ctx.beginPath(); ctx.arc(11.6, -2.2, 1.3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#292524';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(11, -4.5); ctx.quadraticCurveTo(13, -9, 16, -9); ctx.stroke();
  ctx.restore();
}

// 停在空中的蜜蜂：上下飄一點（只是畫面），衝刺前往後縮、抖動
function drawBee(ctx, c, e, hurt) {
  const t = c.time;
  const seed = e.id.charCodeAt(e.id.length - 1);
  const r = c.state.bees.get(e.id);
  const windup = r ? r.windup : 0;
  let x = e.x, y = e.cy + Math.sin(t * 5 + seed) * 2;
  if (windup > 0 && r.dir && e.alive) {
    x -= r.dir.x * 10 * windup + (Math.random() - 0.5) * 3 * windup;
    y -= r.dir.y * 10 * windup + (Math.random() - 0.5) * 3 * windup;
  }
  ctx.save();
  if (e.alive) {   // 正下方地上的小影子：看得出蜜蜂離地多高
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath(); ctx.ellipse(x, groundY(c, x, e.y), 7, 2, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.translate(x, y);
  ctx.scale(e.facing < 0 ? -1 : 1, 1);
  drawBeeShape(ctx, e.h / 18, t * (windup > 0 ? 70 : 38) + seed, hurt);
  ctx.restore();
}

// 蜜蜂正下方的地面高度（畫影子用；往下找最多 400px）
function groundY(c, x, y0) {
  const t = c.match.terrain;
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(t.h, y0 + 400); y += 2) if (t.isSolid(x, y)) return y;
  return CONFIG.WATER_LEVEL;
}

// 蜂巢：一條短短的柄掛在樹枝下面，一層一層的蜂巢、底下一個黑黑的洞口；被打掉幾下就裂幾道。
// 血量畫成底下一排小六角形（蜂巢掛在樹枝下面，上方畫血條會蓋到樹枝），名字跟在旁邊
function drawHive(ctx, c, e, hurt) {
  const x = e.x, top = e.y - e.h, bottom = e.y;
  const hw = e.hw;
  const sway = e.alive ? Math.sin(c.time * 1.3) * 0.03 : 0;
  ctx.save();
  ctx.translate(x, top - 6);
  ctx.rotate(sway);
  ctx.translate(-x, -(top - 6));
  // 柄
  ctx.strokeStyle = '#5b3d27';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x, top - 7); ctx.lineTo(x, top + 4); ctx.stroke();
  // 一層一層的蜂巢（由上往下，中間最寬）
  const layers = 5;
  for (let i = layers - 1; i >= 0; i--) {
    const k = i / (layers - 1);
    const ly = top + 4 + k * (e.h - 8);
    const w = hw * (0.55 + 0.45 * Math.sin(Math.PI * (0.2 + 0.8 * k)));
    ctx.fillStyle = hurt ? '#ffffff' : (i % 2 ? COMB : HONEY);
    ctx.beginPath(); ctx.ellipse(x, ly, w + 1, e.h / layers * 0.75, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(66,32,6,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  // 洞口
  ctx.fillStyle = '#1c0f05';
  ctx.beginPath(); ctx.ellipse(x - 2, bottom - 9, 4, 3, 0, 0, Math.PI * 2); ctx.fill();
  // 裂痕：少一滴血多一道
  const missing = Math.max(0, e.maxHp - e.hp);
  ctx.strokeStyle = COMB_DARK;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < missing; i++) {
    const cx = x + ((i * 7) % 15) - 7, cy = top + 9 + ((i * 11) % (e.h - 14));
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + 3, cy + 4); ctx.lineTo(cx + 1, cy + 7); ctx.lineTo(cx + 4, cy + 10); ctx.stroke();
  }
  ctx.restore();
  if (!e.alive) return;
  // 血量：一排小六角形
  const n = e.maxHp, r = 4, gap = 10;
  const x0 = x - (n - 1) * gap / 2, py = bottom + 9;
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 + k * Math.PI / 3;
      const px = x0 + i * gap + Math.cos(a) * r, qy = py + Math.sin(a) * r;
      if (k) ctx.lineTo(px, qy); else ctx.moveTo(px, qy);
    }
    ctx.closePath();
    ctx.fillStyle = i < e.hp ? HONEY : 'rgba(0,0,0,0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  text(ctx, e.name, x, py + 18, { size: 12, bold: true, align: 'center', color: '#ffd54f', outline: 'rgba(0,0,0,0.9)' });
}

// 衝刺螫擊的飛行物 = 蜜蜂本身：後面拖一串速度線
function drawHiveProjectile(ctx, c, p) {
  if (p.weapon.id !== 'beeSting') return false;
  for (let i = 0; i < p.trail.length; i += 2) {
    const t = p.trail[i], k = i / p.trail.length;
    ctx.fillStyle = `rgba(253,224,71,${k * 0.45})`;
    ctx.beginPath(); ctx.arc(t.x, t.y, 1.5 + k * 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.save();
  ctx.translate(p.x, p.y);
  const a = Math.atan2(p.vy, p.vx);
  if (p.vx < 0) { ctx.scale(-1, 1); ctx.rotate(Math.PI - a); } else ctx.rotate(a);
  drawBeeShape(ctx, 1, c.time * 80, false);
  ctx.restore();
  return true;
}
