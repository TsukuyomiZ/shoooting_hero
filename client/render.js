import { CONFIG } from '../shared/config.js';
import { displayAngle, clamp } from '../shared/utils.js';
import { aimPreview } from '../shared/weapons.js';
import { roundRect, text, drawBar, drawHpBar, FONT } from './draw.js';
import { drawTreeScene, drawTreePart, drawTreant, drawSpearHeld, drawTreeProjectile, buildForestBackground } from './tree-boss-view.js';
import { buildDecor } from './decor.js';
import { drawSnakeScene, drawSnake, drawSnakeProjectile, drawPoisonMark, drawVineHands, buildJungleBackground } from './snake-boss-view.js';
export class Renderer {
  constructor(view, canvas) {
    this.view = view;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.backgrounds = { dusk: this.buildBackground() };   // 地圖主題 → 背景（第一次用到才畫）
    this.decors = new Map();                               // 關卡 id → 裝飾圖（level.decor，第一次用到才畫）
  }

  // 關卡的純裝飾圖案（例如樹影重重的大樹），沒有就回傳 null
  decor() {
    const match = this.view.match;
    if (!match || !match.level.decor) return null;
    if (!this.decors.has(match.levelId)) this.decors.set(match.levelId, buildDecor(match.level.decor, CONFIG.WORLD_W, CONFIG.WORLD_H));
    return this.decors.get(match.levelId);
  }

  background() {
    const theme = (this.view.match && this.view.match.level.theme) || 'dusk';
    if (!this.backgrounds[theme]) {
      this.backgrounds[theme] = theme === 'forest' ? buildForestBackground(CONFIG.WORLD_W, CONFIG.WORLD_H)
        : theme === 'jungle' ? buildJungleBackground(CONFIG.WORLD_W, CONFIG.WORLD_H) : this.backgrounds.dusk;
    }
    return this.backgrounds[theme];
  }

  // 靜態背景只畫一次：黃昏天空 + 太陽 + 遠山
  buildBackground() {
    const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#2b1e3f');
    sky.addColorStop(0.45, '#7a3f5c');
    sky.addColorStop(0.75, '#e0834a');
    sky.addColorStop(1, '#f3b06a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);
    const sun = ctx.createRadialGradient(780, 300, 10, 780, 300, 150);
    sun.addColorStop(0, 'rgba(255,235,180,0.95)');
    sun.addColorStop(0.3, 'rgba(255,190,120,0.5)');
    sun.addColorStop(1, 'rgba(255,150,100,0)');
    ctx.fillStyle = sun;
    ctx.beginPath(); ctx.arc(780, 300, 150, 0, Math.PI * 2); ctx.fill();
    const layers = [
      { color: 'rgba(60,30,60,0.55)', base: 520, amp: 120, seed: 3 },
      { color: 'rgba(40,20,45,0.75)', base: 600, amp: 90, seed: 7 },
    ];
    for (const L of layers) {
      ctx.fillStyle = L.color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 16) {
        ctx.lineTo(x, L.base - Math.abs(Math.sin(x * 0.011 * L.seed) * L.amp) - Math.abs(Math.sin(x * 0.037 + L.seed) * 25));
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fill();
    }
    return c;
  }

  draw() {
    const { ctx, view } = this;
    const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(this.background(), 0, 0);
    if (!view.match) { this.drawWater(); return; }
    ctx.save();
    if (view.shake > 0) ctx.translate((Math.random() - 0.5) * view.shake, (Math.random() - 0.5) * view.shake);
    this.drawWater();
    const decor = this.decor();
    if (decor) ctx.drawImage(decor, 0, 0);
    view.painter.sync();
    ctx.drawImage(view.painter.canvas, 0, 0);
    drawTreeScene(ctx, view);   // 古樹之庭：樹冠、預定撞擊的警示帶、出招預兆
    drawSnakeScene(ctx, view);  // 叢林巨蟒：藤蔓、水裡的蛇身、蛇血、預定衝撞的警示帶
    this.drawAim();
    // 巨蟒的頭先畫：被大地震擊甩到嘴前的人要畫在牠前面，不會像是鑽進牠的頭裡
    const ents = view.match.entities;
    for (const e of ents) if (e.part === 'snake') this.drawEntity(e);
    for (const e of ents) if (e.part !== 'snake') this.drawEntity(e);
    this.drawProjectiles();
    this.drawEffects();
    ctx.restore();
    this.drawHUD();
    this.drawBanner();
    this.drawHint();
    if (view.runOver) this.drawRunOverlay();
    else if (view.result) this.drawOverlay();
  }

  drawWater() {
    const { ctx, view } = this;
    const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H, y0 = CONFIG.WATER_LEVEL;
    const wave = (x) => y0 + Math.sin(x * 0.04 + view.time * 2.5) * 2.5;
    const g = ctx.createLinearGradient(0, y0, 0, H);
    g.addColorStop(0, '#4aa3ff');
    g.addColorStop(1, '#0b3d91');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, wave(x));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) (x === 0 ? ctx.moveTo(x, wave(x)) : ctx.lineTo(x, wave(x)));
    ctx.stroke();
  }

  drawWeapon(e) {
    const ctx = this.ctx;
    const w = CONFIG.WEAPONS[e.weapon] || CONFIG.WEAPONS.cannon;
    const s = e.h / 30;
    ctx.save();
    ctx.translate(e.x, e.y - e.h / 2);
    ctx.rotate(-e.aimAngle * Math.PI / 180);
    ctx.scale(s, s);
    if (w.id === 'cannon') {
      ctx.fillStyle = '#3a3a3a';
      roundRect(ctx, -4, -5, 26, 10, 3); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.fillRect(18, -6, 5, 12);
      ctx.fillStyle = '#555';
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
    } else if (w.id === 'boomerang') {
      ctx.fillStyle = '#7c5a3a';
      ctx.fillRect(0, -2, 12, 4);
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(10, -9); ctx.lineTo(18, 0); ctx.lineTo(10, 9); ctx.stroke();
    } else if (w.id === 'treeSpear') {
      drawSpearHeld(ctx);
    } else if (w.id === 'plasma') {
      ctx.fillStyle = '#334155';
      roundRect(ctx, -6, -5, 30, 10, 4); ctx.fill();
      ctx.fillStyle = '#0e7490';
      ctx.fillRect(3, -8, 9, 3);
      ctx.fillStyle = '#22d3ee';
      ctx.fillRect(22, -4, 4, 8);
    } else {
      ctx.fillStyle = '#4b5563';
      roundRect(ctx, -6, -2.5, 38, 5, 2); ctx.fill();
      ctx.fillStyle = '#1f2937';
      ctx.fillRect(6, -6, 12, 3);
      ctx.fillStyle = '#7c5a3a';
      roundRect(ctx, -8, -1, 10, 6, 2); ctx.fill();
    }
    ctx.restore();
  }

  drawEntity(e) {
    const { ctx, view } = this;
    if (e.part === 'snake' && !e.alive) { drawSnake(ctx, e, view); return; }   // 巨蟒沉進水裡
    if (e.part && !e.alive) { drawTreePart(ctx, e, view); return; }   // 閉上的眼睛 / 嘴巴留在樹上
    ctx.save();
    if (!e.alive) {
      const a = Math.max(0, 1 - e.deathTimer / 1.2);
      if (a <= 0) { ctx.restore(); return; }
      ctx.globalAlpha = a;
      if (e.deathCause === 'hit') ctx.translate(0, e.deathTimer * 40);
    }
    const x = e.x, y = e.y;
    const hurt = e.hurtTimer > 0;
    const isMe = e.id === view.myId;
    const s = e.h / 30;   // 體型牌會把角色放大，整體等比縮放

    if (e.part === 'snake') {
      drawSnake(ctx, e, view);      // 叢林巨蟒的頭
    } else if (e.part) {
      drawTreePart(ctx, e, view);   // 古樹之眼 / 古樹之口
    } else {
      if (e.onVine < 0) {           // 腳下的影子（掛在藤蔓上就沒有）
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath(); ctx.ellipse(x, y + 1, e.hw + 3, 3, 0, 0, Math.PI * 2); ctx.fill();
      }
      this.drawWeapon(e);
    }
    if (e.minion) {
      drawTreant(ctx, e, hurt);
    } else if (e.kind === 'sniper') {
      this.drawSniper(e, hurt);
    } else if (!e.part) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(s, s);
      ctx.fillStyle = hurt ? '#ffffff' : e.color;
      roundRect(ctx, -9, -19, 18, 18, 4); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.fillRect(-7, -3, 5, 3);
      ctx.fillRect(2, -3, 5, 3);
      ctx.fillStyle = hurt ? '#fff' : '#ffd9b3';
      ctx.beginPath(); ctx.arc(0, -25, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = hurt ? '#eee' : (e.isPlayer ? '#5b3a1a' : '#333');
      ctx.beginPath(); ctx.arc(0, -27, 9, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(e.facing * 4, -24, 1.7, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    if (e.onVine >= 0 && e.alive) drawVineHands(ctx, e);   // 抓著藤蔓：兩手往上握著

    // 血條 + 名字（＋ 你 / AI 標籤）。古樹之口打不壞，不畫血條、改標狀態。
    // 被中毒鎖住的上限畫成右邊一段灰色（整條 = 原本的上限）；巨蟒的血條比較長，每 10%（掉蛇血的門檻）一道刻度
    const snake = e.part === 'snake';
    const bw = snake ? 170 : e.boss ? 90 : 46, bh = snake ? 8 : 6, by = y - e.h - 16;
    if (!e.closeOnHit) {
      const full = Math.max(1, e.maxHp + e.poisonLock);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      roundRect(ctx, x - bw / 2, by, bw, bh, 3); ctx.fill();
      if (e.hp > 0) {
        ctx.fillStyle = e.isPlayer ? e.color : '#ef4444';
        roundRect(ctx, x - bw / 2, by, bw * e.hp / full, bh, 3); ctx.fill();
      }
      if (e.poisonLock > 0) {
        const gx = x - bw / 2 + bw * e.maxHp / full;
        ctx.fillStyle = '#6b7280';
        roundRect(ctx, gx, by, x + bw / 2 - gx, bh, 3); ctx.fill();
      }
      if (snake && CONFIG.SNAKE_BOSS.bloodEveryPct > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        for (let k = CONFIG.SNAKE_BOSS.bloodEveryPct; k < 100; k += CONFIG.SNAKE_BOSS.bloodEveryPct) ctx.fillRect(x - bw / 2 + bw * k / 100 - 0.5, by, 1, bh);
      }
    }
    let label = e.name;
    if (isMe) label += '（你）';
    else if (e.isPlayer && view.playerStatus.get(e.id) === false) label += '（AI）';
    text(ctx, label, x, by - 4, {
      size: 12, bold: true, align: 'center',
      color: e.isPlayer ? '#e8f4ff' : '#ffd54f', outline: 'rgba(0,0,0,0.9)',
    });
    if (e.alive && e.burn > 0) this.drawBurn(x + bw / 2 + 7, by + 3, e.burn);
    if (e.alive && e.poison > 0) drawPoisonMark(ctx, x + bw / 2 + 7 + (e.burn > 0 ? 26 : 0), by + 3, e.poison);   // 中毒層數（每個自己的回合開始都會結算，喝蛇血才解除）
    if (e.alive && view.match.linkPartners(e).length) this.drawLinkMark(x - bw / 2 - 9, by + 3);   // 攜手之伴：連結生效中
    if (e.alive && e.shield > 0) {   // 神佑之石的無敵護罩
      const r = Math.max(e.h, e.hw * 2) * 0.72 + 4;
      ctx.fillStyle = 'rgba(253,230,138,0.12)';
      ctx.strokeStyle = `rgba(253,230,138,${0.55 + 0.25 * Math.sin(view.time * 4)})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, e.cy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // 目前行動者標記（跳動的倒三角）
    if (view.currentId === e.id && e.alive && !view.result) {
      const ty = by - 22 + Math.sin(view.time * 6) * 3;
      ctx.fillStyle = e.isPlayer ? (isMe ? '#38bdf8' : '#86efac') : '#f87171';
      ctx.beginPath(); ctx.moveTo(x - 7, ty - 8); ctx.lineTo(x + 7, ty - 8); ctx.lineTo(x, ty); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // 狙擊手：吉利服的兜帽（插著葉子）、面罩、斜背帶；身上描深色邊，躲在樹冠裡也看得出輪廓
  drawSniper(e, hurt) {
    const ctx = this.ctx;
    const s = e.h / 30, f = e.facing;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.scale(s, s);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 2;
    ctx.fillStyle = hurt ? '#ffffff' : e.color;
    roundRect(ctx, -9, -19, 18, 18, 4); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = hurt ? '#ddd' : '#3b2a17';   // 斜背帶
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(-7 * f, -18); ctx.lineTo(7 * f, -3); ctx.stroke();
    ctx.fillStyle = '#1f1f1f';                     // 靴子
    ctx.fillRect(-7, -3, 5, 3);
    ctx.fillRect(2, -3, 5, 3);
    ctx.fillStyle = hurt ? '#fff' : '#e0b98f';     // 臉
    ctx.beginPath(); ctx.arc(0, -25, 8.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = hurt ? '#eee' : '#2f3d1c';     // 面罩（遮住下半張臉）
    ctx.beginPath(); ctx.arc(0, -25, 8.5, 0.15 * Math.PI, 0.85 * Math.PI); ctx.closePath(); ctx.fill();
    ctx.fillStyle = hurt ? '#eee' : '#3a4a22';     // 兜帽
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, -25, 10, Math.PI * 0.95, Math.PI * 2.05); ctx.lineTo(-10 * f, -18); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = hurt ? '#fff' : '#5f8a2e';     // 兜帽上的葉子
    for (const [dx, dy, a] of [[-7, -33, -0.6], [0, -36, 0], [6, -33, 0.6], [-10 * f, -27, -0.9 * f]]) {
      ctx.save(); ctx.translate(dx, dy); ctx.rotate(a);
      ctx.beginPath(); ctx.ellipse(0, 0, 2.2, 4.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#111';                        // 眼睛
    ctx.beginPath(); ctx.arc(f * 4, -26, 1.7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // 血條旁的燃燒標記：小火焰 + 層數
  drawBurn(fx, fy, stacks) {
    const ctx = this.ctx;
    const flame = (s, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(fx, fy - 7 * s);
      ctx.quadraticCurveTo(fx + 5 * s, fy - s, fx + 3 * s, fy + 3 * s);
      ctx.quadraticCurveTo(fx, fy + 6 * s, fx - 3 * s, fy + 3 * s);
      ctx.quadraticCurveTo(fx - 5 * s, fy - s, fx, fy - 7 * s);
      ctx.fill();
    };
    flame(1, '#f97316');
    flame(0.55, '#fde047');
    text(ctx, String(stacks), fx + 6, fy + 5, { size: 11, bold: true, color: '#fdba74', outline: 'rgba(0,0,0,0.9)' });
  }

  // 血條左邊的連結標記（攜手之伴）：兩個扣在一起的小環
  drawLinkMark(cx, cy) {
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    for (const dx of [-2.5, 2.5]) { ctx.beginPath(); ctx.ellipse(cx + dx, cy, 3.6, 2.6, 0, 0, Math.PI * 2); ctx.stroke(); }
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#f0abfc';
    for (const dx of [-2.5, 2.5]) { ctx.beginPath(); ctx.ellipse(cx + dx, cy, 3.6, 2.6, 0, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }

  // 自己的瞄準線 / 彈道預覽 / 角度框
  drawAim() {
    const { ctx, view } = this;
    const me = view.me;
    if (!me || !me.alive || !view.canAct) return;
    const weapon = CONFIG.WEAPONS[me.weapon];
    const m = me.muzzle();
    const world = view.match.world;

    if (me.aiming) {
      // 預覽照牌的特性算（哈哈子彈 / 蹦蹦炸彈的彈射、高倍率望遠鏡的穿透），見 shared/weapons.js aimPreview
      const pre = aimPreview(world, me, weapon, me.aimAngle, me.aimPower);
      if (pre.kind === 'arc') {
        pre.points.forEach((pt, i) => {
          ctx.fillStyle = `rgba(255,230,80,${1 - (i / Math.max(1, pre.points.length)) * 0.7})`;
          ctx.beginPath(); ctx.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2); ctx.fill();
        });
      } else {
        // 直線武器：完整瞄準線，有哈哈子彈就畫出彈射後的路線、有高倍率望遠鏡就標出穿透點
        const tr = pre;
        const end = tr.points[tr.points.length - 1];
        ctx.save();
        ctx.strokeStyle = 'rgba(255,80,80,0.8)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        tr.points.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(254,240,138,0.95)';
        for (const pt of tr.points.slice(1, -1)) {   // 彈射點
          ctx.beginPath(); ctx.moveTo(pt.x, pt.y - 5); ctx.lineTo(pt.x + 5, pt.y); ctx.lineTo(pt.x, pt.y + 5); ctx.lineTo(pt.x - 5, pt.y); ctx.closePath(); ctx.fill();
        }
        ctx.strokeStyle = 'rgba(255,80,80,0.95)';
        ctx.lineWidth = 2;
        for (const pt of tr.pierced) {               // 穿透點
          ctx.beginPath(); ctx.moveTo(pt.x - 5, pt.y - 5); ctx.lineTo(pt.x + 5, pt.y + 5); ctx.moveTo(pt.x + 5, pt.y - 5); ctx.lineTo(pt.x - 5, pt.y + 5); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(end.x, end.y, 7, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(end.x - 11, end.y); ctx.lineTo(end.x + 11, end.y);
        ctx.moveTo(end.x, end.y - 11); ctx.lineTo(end.x, end.y + 11);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(view.mouse.x, view.mouse.y); ctx.stroke();
      ctx.restore();
    }

    const lx = me.x, ly = me.y - me.h - 56;
    ctx.fillStyle = 'rgba(30,30,40,0.8)';
    roundRect(ctx, lx - 28, ly - 18, 56, 24, 6); ctx.fill();
    text(ctx, `${displayAngle(me)}°`, lx, ly, { size: 16, bold: true, align: 'center' });
  }

  drawTrail(p, rgb, maxAlpha, r0, r1) {
    const ctx = this.ctx;
    for (let i = 0; i < p.trail.length; i++) {
      const t = p.trail[i], k = i / p.trail.length;
      ctx.fillStyle = `rgba(${rgb},${k * maxAlpha})`;
      ctx.beginPath(); ctx.arc(t.x, t.y, r0 + k * r1, 0, Math.PI * 2); ctx.fill();
    }
  }

  drawProjectiles() {
    const { ctx, view } = this;
    for (const p of view.projectiles) {
      const w = p.weapon;
      if (drawTreeProjectile(ctx, p, view)) continue;   // 古樹撞擊 / 飛散落葉 / 長矛
      if (drawSnakeProjectile(ctx, p, view)) continue;  // 巨蟒的毒液 / 震波（衝撞、撕咬是頭本身）
      if (w.id === 'cannon') {
        this.drawTrail(p, '255,200,120', 0.5, 2, 3);
        ctx.fillStyle = w.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, w.shellRadius, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.arc(p.x - 2, p.y - 2, 2, 0, Math.PI * 2); ctx.fill();
      } else if (w.id === 'boomerang') {
        this.drawTrail(p, '251,191,36', 0.3, 1, 2);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        ctx.strokeStyle = w.color;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(-w.shellRadius, -5); ctx.lineTo(0, 3); ctx.lineTo(w.shellRadius, -5); ctx.stroke();
        ctx.restore();
      } else if (w.id === 'plasma') {
        this.drawTrail(p, '34,211,238', 0.55, 1.5, 3.5);
        ctx.fillStyle = 'rgba(34,211,238,0.35)';
        ctx.beginPath(); ctx.arc(p.x, p.y, w.shellRadius + 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#a5f3fc';
        ctx.beginPath(); ctx.arc(p.x, p.y, w.shellRadius, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
      } else if (w.id === 'bombard') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(Math.atan2(p.vy, p.vx));
        ctx.fillStyle = 'rgba(251,146,60,0.85)';
        ctx.beginPath(); ctx.moveTo(-8, -3); ctx.lineTo(-22 - Math.random() * 6, 0); ctx.lineTo(-8, 3); ctx.closePath(); ctx.fill();
        ctx.fillStyle = w.color;
        roundRect(ctx, -10, -3.5, 16, 7, 3); ctx.fill();
        ctx.fillStyle = '#fecdd3';
        ctx.beginPath(); ctx.moveTo(6, -3.5); ctx.lineTo(11, 0); ctx.lineTo(6, 3.5); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else {
        const len = 40;
        const sp = Math.hypot(p.vx, p.vy) || 1;
        ctx.save();
        ctx.strokeStyle = w.color;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx / sp * len, p.y - p.vy / sp * len);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  drawEffects() {
    const { ctx, view } = this;
    for (const f of view.flashes) {
      const t = f.life / f.maxLife;
      ctx.fillStyle = `rgba(${f.tint || '255,220,120'},${t * 0.8})`;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (1.3 - t * 0.3), 0, Math.PI * 2); ctx.fill();
    }
    for (const f of view.linkFlashes || []) {   // 攜手之伴分擔傷害：兩人之間閃一下
      const a = view.match.byId(f.a), b = view.match.byId(f.b);
      if (!a || !b) continue;
      ctx.save();
      ctx.strokeStyle = `rgba(240,171,252,${clamp(f.life / 0.45, 0, 1) * 0.7})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath(); ctx.moveTo(a.cx, a.cy); ctx.lineTo(b.cx, b.cy); ctx.stroke();
      ctx.restore();
    }
    for (const p of view.particles) {
      ctx.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const f of view.floatTexts) {
      ctx.globalAlpha = clamp(f.life, 0, 1);
      text(ctx, f.text, f.x, f.y, { size: f.size || 20, bold: true, align: 'center', color: f.color, outline: 'rgba(0,0,0,0.9)' });
    }
    ctx.globalAlpha = 1;
  }

  drawHUD() {
    const { ctx, view } = this;
    const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
    const me = view.me;
    const match = view.match;

    // 左上：關卡 / 回合資訊
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, 12, 12, 250, 66, 10); ctx.fill();
    const si = view.stageInfo;
    const stageLabel = si ? (si.isBoss ? 'Boss 關' : `第 ${si.stage} / ${si.stageCount - 1} 關`) : '';
    text(ctx, `${stageLabel}　第 ${view.round} 輪`, 24, 38, { size: 18, bold: true, color: si && si.isBoss ? '#fca5a5' : '#fff' });
    let sub = '', subColor = '#ddd';
    const actor = view.currentId ? match.byId(view.currentId) : null;
    if (view.canAct) {
      const left = view.deadline ? Math.max(0, Math.ceil((view.deadline - performance.now()) / 1000)) : 0;
      sub = `你的回合 · 剩餘 ${left} 秒`;
      subColor = left < 6 ? '#f87171' : '#7dd3fc';
    } else if (view.waiting) {
      sub = '等待伺服器結算…';
    } else if (actor) {
      sub = `${actor.name} 的回合`;
      subColor = actor.team === 'players' ? '#86efac' : '#fca5a5';
    }
    text(ctx, sub, 24, 64, { size: 15, color: subColor });
    const fever = match.feverAt(view.round);   // 狂熱：每過 N 輪，全體傷害再 +N%（Boss 關沒有）
    if (fever > 0) {
      const label = `狂熱　全體傷害 +${fever * CONFIG.FEVER.damagePct}%`;
      ctx.save();
      ctx.font = `bold 13px ${FONT}`;
      const w = ctx.measureText(label).width + 20;
      ctx.restore();
      ctx.fillStyle = 'rgba(60,20,0,0.75)';
      roundRect(ctx, 12, 84, w, 22, 11); ctx.fill();
      ctx.strokeStyle = '#fb923c';
      ctx.lineWidth = 1;
      ctx.stroke();
      text(ctx, label, 12 + w / 2, 100, { size: 13, bold: true, align: 'center', color: '#fdba74' });
    }

    // 上中：武器選擇（照自己的武器欄，最多 3 把）
    for (const b of view.weaponButtons()) {
      const w = CONFIG.WEAPONS[b.id];
      const sel = me && me.weapon === b.id;
      ctx.fillStyle = sel ? 'rgba(250,204,21,0.92)' : 'rgba(0,0,0,0.5)';
      roundRect(ctx, b.x, b.y, b.w, b.h, 8); ctx.fill();
      if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      text(ctx, `[${b.slot}] ${w.name}`, b.x + b.w / 2, b.y + 20, { size: 16, bold: true, align: 'center', color: sel ? '#1f1300' : '#fff' });
      text(ctx, w.desc, b.x + b.w / 2, b.y + 37, { size: 10, align: 'center', color: sel ? '#3b2a00' : '#bbb' });
    }

    // 右上：隊伍名單（含手牌數）+ 敵人
    const players = match.players;
    const enemiesAlive = match.enemies.filter(e => e.alive).length;
    const rosterH = 34 + players.length * 22 + (match.tree ? 44 : 22);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    roundRect(ctx, W - 12 - 250, 12, 250, rosterH, 10); ctx.fill();
    text(ctx, '隊伍', W - 250, 34, { size: 14, bold: true, color: '#9ec5ff' });
    players.forEach((p, i) => {
      const y = 56 + i * 22;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(W - 244, y - 5, 5, 0, Math.PI * 2); ctx.fill();
      let name = p.name;
      if (p.id === view.myId) name += '（你）';
      else if (view.playerStatus.get(p.id) === false) name += '（AI）';
      if (!p.alive) name += ' ✕';
      const cardCount = si && si.cards && si.cards[p.id] ? si.cards[p.id].length : 0;
      if (cardCount) name += `　牌×${cardCount}`;
      text(ctx, name, W - 232, y, { size: 13, color: p.alive ? '#fff' : '#888' });
      drawHpBar(ctx, W - 92, y - 12, 70, 10, p, p.color, '#222');   // 被中毒鎖住的上限是灰色
    });
    const ey = 56 + players.length * 22 + 2;
    if (match.tree) {   // 古樹之庭：眼睛血量、場上的樹妖數（嘴巴的狀態不用文字提示，只看畫面上張開或闔上）
      const eye = match.byId('eye');
      const minions = match.enemies.filter(e => e.minion && e.alive).length;
      text(ctx, `古樹之眼 ${eye.hp} / ${eye.maxHp}`, W - 250, ey, { size: 13, bold: true, color: '#fca5a5' });
      text(ctx, `樹妖 ×${minions}`, W - 250, ey + 22, { size: 13, bold: true, color: '#fdba74' });
    } else if (match.snake) {   // 叢林巨蟒：血量
      const s = match.byId('snake');
      text(ctx, `叢林巨蟒 ${s.hp} / ${s.maxHp}`, W - 250, ey, { size: 13, bold: true, color: '#fca5a5' });
    } else {
      text(ctx, `敵人剩餘 ${enemiesAlive} / ${match.enemies.length}`, W - 250, ey, { size: 13, bold: true, color: '#fca5a5' });
    }

    // 底部：自己的狀態
    const py = H - 96;
    ctx.fillStyle = 'rgba(10,10,20,0.62)';
    ctx.fillRect(0, py, W, 96);
    if (me) {
      text(ctx, '血量', 20, py + 30, { size: 15, bold: true, color: '#ff8a8a' });
      drawHpBar(ctx, 66, py + 16, 220, 18, me, '#e53935', '#3a0f0f');
      // 被中毒鎖住上限時：現在 / 鎖住後的上限（原本的上限）
      const hpLabel = me.poisonLock > 0 ? `${me.hp} / ${me.maxHp}（${me.maxHp + me.poisonLock}）` : `${me.hp} / ${me.maxHp}`;
      text(ctx, hpLabel, 176, py + 30, { size: 12, bold: true, align: 'center' });
      text(ctx, '體力', 20, py + 66, { size: 15, bold: true, color: '#9be59b' });
      drawBar(ctx, 66, py + 52, 220, 18, me.stamina / me.maxStamina, '#43a047', '#0f3a12');
      text(ctx, `${Math.round(me.stamina)} / ${me.maxStamina}`, 176, py + 66, { size: 12, bold: true, align: 'center' });

      const bx = 366, bw = 250;
      text(ctx, '力量', 320, py + 30, { size: 15, bold: true, color: '#ffd166' });
      drawBar(ctx, bx, py + 16, bw, 18, me.aimPower / 100, '#f59e0b', '#3a2a0f');
      for (let i = 0; i <= 10; i++) {
        const x = bx + bw * i / 10;
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillRect(x - 0.5, py + 36, 1, 5);
        text(ctx, String(i * 10), x, py + 52, { size: 10, align: 'center', color: '#ddd' });
      }
      text(ctx, `${me.aimPower}`, bx + bw + 30, py + 31, { size: 18, bold: true, align: 'center' });
      text(ctx, `角度 ${displayAngle(me)}°`, 320, py + 80, { size: 15, bold: true });
      text(ctx, `武器：${CONFIG.WEAPONS[me.weapon].name}`, 450, py + 80, { size: 15, bold: true, color: '#ffe066' });
      if (!me.onGround && me.alive) text(ctx, me.onVine >= 0 ? '（藤蔓上）' : '（空中）', 600, py + 80, { size: 13, color: me.onVine >= 0 ? '#86efac' : '#aaa' });
      this.drawBuffs(me, 12, py - 30);
    }
    const hints = [
      match.terrain.vines.length ? 'A / D 移動　空白鍵 跳躍　W / S 抓住、爬藤蔓（耗體力）' : 'A / D 移動　空白鍵 跳躍（動作會消耗體力）',
      '按住左鍵拖曳瞄準：方向=角度、距離=力量，放開發射',
      `1 / 2 / 3 切換武器　隊友誤傷 ×0.6　落水扣 ${CONFIG.WATER.damagePct}% 血`,
    ];
    hints.forEach((h, i) => text(ctx, h, W - 20, py + 28 + i * 22, { size: 11, align: 'right', color: '#ccc' }));
  }

  // 底部狀態列上方：自己身上正在生效的裝備效果
  drawBuffs(me, x, y) {
    const ctx = this.ctx;
    const m = me.mods;
    const chips = [];
    const ramp = this.view.match.rampBonus(me);
    if (ramp > 0) chips.push([`狂戰 +${ramp}%`, '#f87171']);
    if (me.soulPct > 0) chips.push([`噬魂 +${me.soulPct}%`, '#c084fc']);
    if (m.bossDamagePct > 0) chips.push([`弒神 +${m.bossDamagePct}%`, '#fbbf24']);
    if (m.lifestealPct > 0) chips.push([`吸血 ${m.lifestealPct}%`, '#fb7185']);
    if (m.armorPct > 0) chips.push([`減傷 ${m.armorPct}%`, '#93c5fd']);
    if (m.regenPct > 0) chips.push([`每回合回血 ${m.regenPct}%`, '#4ade80']);
    if (m.extraJumps > 0) chips.push([m.extraJumps > 1 ? `${m.extraJumps + 1} 段跳` : '二段跳', '#7dd3fc']);
    if (m.extraTurn > 0) chips.push([me.extraTurnCd > 0 ? `時間扭曲 冷卻 ${me.extraTurnCd}` : '時間扭曲 就緒', '#c4b5fd']);
    if (m.bombard > 0) chips.push(['無差別轟炸', '#fb7185']);
    if (m.teamShield > 0) chips.push([`神佑 ${me.turnCount % CONFIG.EQUIP.shieldEveryTurns}/${CONFIG.EQUIP.shieldEveryTurns}`, '#fde68a']);
    if (me.shield > 0) chips.push([`無敵 ×${me.shield}`, '#fde68a']);
    if (me.burn > 0) chips.push([`燃燒 ${me.burn} 層`, '#fb923c']);
    if (me.poison > 0) chips.push([`中毒 ${me.poison} 層`, '#c084fc']);
    if (me.poisonLock > 0) chips.push([`生命鎖 -${me.poisonLock}`, '#9ca3af']);
    if (m.stageDamagePct > 0) chips.push([`腎上腺素 +${m.stageDamagePct}%（這一關）`, '#f472b6']);
    // 看場上隊友的牌：沒生效時用灰色標出來
    const allies = this.view.match.alliesAlive(me);
    const DIM = '#64748b';
    if (m.loneDamagePct > 0 || m.loneLifestealPct > 0) {
      chips.push(allies === 0 ? [`孤狼 +${m.loneDamagePct}% · 吸血 ${m.loneLifestealPct}%`, '#e2e8f0'] : ['孤狼（還有隊友）', DIM]);
    }
    if (m.allyDamagePct > 0 || m.allyArmorPct > 0) {
      chips.push(allies > 0 ? [`團結 +${allies * m.allyDamagePct}% · 減傷 ${allies * m.allyArmorPct}%`, '#86efac'] : ['團結（沒有隊友）', DIM]);
    }
    if (me.links.length) {   // 攜手之伴（自己選的或被選的）：活著的才有在分，倒下的另外標
      const partners = this.view.match.linkPartners(me);
      const nameOf = (id) => { const q = this.view.match.byId(id); return q ? q.name : id; };
      const up = partners.map(q => q.name).join('、');
      const down = me.links.filter(id => !partners.some(q => q.id === id)).map(nameOf).join('、');
      chips.push(partners.length ? [`連結 ${up}${down ? `（${down} 倒下了）` : ''}`, '#f0abfc'] : [`連結（${down} 倒下了）`, DIM]);
    }
    for (const [label, color] of chips) {
      ctx.save();
      ctx.font = `bold 12px ${FONT}`;
      const w = ctx.measureText(label).width + 16;
      ctx.restore();
      ctx.fillStyle = 'rgba(10,10,20,0.7)';
      roundRect(ctx, x, y, w, 20, 10); ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      text(ctx, label, x + w / 2, y + 14, { size: 12, bold: true, align: 'center', color });
      x += w + 6;
    }
  }

  drawBanner() {
    const { ctx, view } = this;
    if (!view.banner) return;
    const b = view.banner;
    const a = clamp(Math.min(b.timer * 3, (b.total - b.timer) * 4), 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    text(ctx, b.text, CONFIG.WORLD_W / 2, 150, { size: 36, bold: true, align: 'center', color: b.color, outline: 'rgba(0,0,0,0.85)', outlineWidth: 6 });
    if (b.sub) text(ctx, b.sub, CONFIG.WORLD_W / 2, 188, { size: 24, bold: true, align: 'center', color: '#fb923c', outline: 'rgba(0,0,0,0.85)', outlineWidth: 5 });
    ctx.restore();
  }

  drawHint() {
    const { ctx, view } = this;
    if (!view.hint) return;
    ctx.save();
    ctx.globalAlpha = clamp(view.hint.timer * 2, 0, 1);
    text(ctx, view.hint.text, CONFIG.WORLD_W / 2, CONFIG.WORLD_H - 120, { size: 18, bold: true, align: 'center', color: '#fbbf24', outline: 'rgba(0,0,0,0.9)' });
    ctx.restore();
  }

  // 單關戰鬥結束（勝利後接著會跳選牌；失敗會接著跳冒險結束）
  drawOverlay() {
    const { ctx, view } = this;
    const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, W, H);
    const win = view.result === 'win';
    text(ctx, win ? '關卡通過！' : '戰敗…', W / 2, H / 2 - 30, { size: 64, bold: true, align: 'center', color: win ? '#fde047' : '#f87171', outline: 'rgba(0,0,0,0.9)', outlineWidth: 8 });
    text(ctx, win ? '準備選牌…' : '全隊都倒下了', W / 2, H / 2 + 20, { size: 22, align: 'center', color: '#eee' });
  }

  // 整場冒險結束
  drawRunOverlay() {
    const { ctx, view } = this;
    const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, W, H);
    const win = view.runOver.result === 'win';
    text(ctx, win ? '通關！' : '冒險結束', W / 2, H / 2 - 30, { size: 64, bold: true, align: 'center', color: win ? '#fde047' : '#f87171', outline: 'rgba(0,0,0,0.9)', outlineWidth: 8 });
    text(ctx, win ? '首領被擊敗了' : `倒在第 ${view.runOver.isBoss ? 'Boss' : view.runOver.stage} 關`, W / 2, H / 2 + 20, { size: 22, align: 'center', color: '#eee' });
    text(ctx, '按 R 或點擊畫面回到大廳', W / 2, H / 2 + 64, { size: 18, align: 'center', color: '#bbb' });
  }
}
