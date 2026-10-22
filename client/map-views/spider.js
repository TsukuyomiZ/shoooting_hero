import { CONFIG } from '../../shared/core/config.js';
import { inShadow } from '../../shared/maps/cave.js';
import {
  QUEEN_NAME, QUEEN_ID, SPIDER_ACTION_NAMES as N, spiderState, queenOf, isEgg, isWeb, isSpiderling, syncQueen, syncWebs, setMode,
  spawnEgg, spawnWeb, spawnSpiderling, applyWebPickup, touchWeb, fangsOf, restoreSpider,
} from '../../shared/maps/spider.js';
import { text } from '../draw.js';
import { cave, drawShade as drawCaveShade } from './cave.js';

// Boss 關「蜘蛛巢穴」的地圖畫面：洞穴的部分（火把、照明、掉下來的鐘乳石）沿用 cave.js，加上蜘蛛女王（懸吊在天上的蜘蛛絲、被燒到掉下來、
// 爬回去、躲在背景只剩陰影與紅眼）、蛛卵（倒數幾回合孵化）、蜘蛛網（黏住的人身上纏著絲）、小蜘蛛、各招的動畫腳本與飛行物。
// 暗的地方看不清楚：女王的紅眼、蛛卵與網的輪廓淡淡畫在遮光上面（知道要打哪裡）。規則在 shared/maps/spider.js；掛勾的說明見 index.js
const FPS = 60;
const CEILING = 36;                                        // 蜘蛛絲從多高垂下來
const SHIFT = { drop: 0.55, climb: 0.9, hide: 0.7, emerge: 0.7 };   // 女王掉下來 / 爬回去 / 退到背景 / 從背景回來的動畫秒數
const ART_H = 52;                                          // 女王畫法的原始身高（小蜘蛛照自己的身高等比縮小）
const SILK = 'rgba(241,245,249,A)';
const silk = (a) => SILK.replace('A', a);

export const spider = {
  ...cave,
  type: 'spider',

  // 這一場的畫面狀態：洞穴的（爆炸閃光、火把點燃）+
  //   fx       女王 / 小蜘蛛出招的預兆 { action, t, cast, step, actorId, phase }（回合播完就清掉）
  //   running  正在撲過去的女王 / 小蜘蛛 id（飛行物就是牠，見 drawProjectile），角色本身先不畫
  //   shift    女王換狀態的動畫 { kind: 'drop' | 'climb' | 'hide' | 'emerge', x0, y0, t, dur }（終點 = 她現在的位置）
  //   throws   飛過去的蛋 / 網（只是動畫）[{ kind, x0, y0, x1, y1, k }]；silkLines = 吐絲的絲 { x0, y0, ids, k }
  create: (match) => ({ ...cave.create(match), fx: null, running: null, shift: null, throws: [], silkLines: null }),

  musicTrack: () => 'scorpion',   // 先借用巨蠍的 Boss 曲（洞穴、陰暗）；之後可以換專屬的

  turnScript: spiderTurnScript,
  abortScript(c) { Object.assign(c.state, { fx: null, running: null, throws: [], silkLines: null }); },
  onDeath: onSpiderDeath,

  // 每一步：洞穴的（閃光、火星、熄掉的火把冒煙）+ 女王的狀態、被黏住的人跟場面對齊（跟伺服器同一個條件；
  // 平常在重播到那一下就推了（showEvent 畫動畫），這裡是保險）。播她的回合的時候不推：一招播到一半的場面還沒對齊，播完照伺服器的狀態對齊
  update(c, dt) {
    cave.update(c, dt);
    if (!c.state.fx) {
      const change = syncQueen(c.match);
      if (change) startShift(c, change);
      syncWebs(c.match);
    }
    const sh = c.state.shift;
    if (sh) {
      sh.t += dt;
      if (sh.t >= sh.dur) c.state.shift = null;
    }
    for (const e of c.match.entities) {   // 燒著的蛋冒火星
      if (!e.alive || !(e.burn > 0) || !isEgg(e) || Math.random() > dt * 8) continue;
      c.fx.particle({ x: e.x + (Math.random() - 0.5) * e.hw * 1.6, y: e.y - Math.random() * e.h, vx: (Math.random() - 0.5) * 20, vy: -50 - Math.random() * 40,
        life: 0.6, maxLife: 0.6, size: 1.8, color: Math.random() < 0.5 ? '#fb923c' : '#fde68a', gravity: -20 });
    }
  },

  // 洞穴的（鐘乳石掉下來、火把點燃、閃光）+ 這一下讓女王換了狀態（被燒到掉下來 / 最後一顆蛋破了從背景回來；狀態在重播的 replayEvent 已經推過了）、
  // 毒液 / 撲咬打到人
  showEvent(c, ev, made) {
    cave.showEvent(c, ev, made);
    if (ev.queen) startShift(c, ev.queen);
    const p = c.projectiles.find(q => q.i === ev.p);
    const id = p && p.weapon && p.weapon.id;
    if (!ev.target) return;
    if (id === 'spiderVenom') {
      c.fx.particles(ev.x, ev.y, 14, { speed: 150, life: 0.6, size: 2.8, color: '#a3e635', gravity: 300 });
      c.fx.sound('plop', { x: ev.x });
    } else if (id === 'spiderBite') { c.fx.shake(9); c.fx.sound('stab', { x: ev.x }); }
    else if (id === 'spiderlingBite') { c.fx.shake(4); c.fx.sound('stab', { x: ev.x }); }
  },

  // 女王在自己的回合結束時燃燒結算完沒了 → 爬回天上（伺服器 turnEnd 的 fx）。狀態先照它換（接著的 update 才不會再推一次、從終點重新開始）
  turnFx(c, e, fx) {
    if (fx.type !== 'queen') return false;
    setMode(c.match, fx.to);
    startShift(c, fx);
    return true;
  },

  // 女王的血量停在 50%（等輪到她蛻皮、召喚蛛卵）：多打的不算，飄「鎖血」。這一下還上了燃燒 / 中毒 / 流血（或被免疫）的話照一般的接著飄
  // （傷害 0 不會飄「-0」）
  showDamage(c, e, d) {
    if (e.id !== QUEEN_ID || d.dmg > 0 || d.blocked || d.friendly || !e.alive || e.hp > e.hpFloor) return false;
    c.fx.float(e, '鎖血', '#9ca3af', 15);
    return !(d.burn || d.poison || d.bleed || d.immune);
  },

  // 玩家走路踩進蜘蛛網（伺服器廣播的 pickup；自己的在本地 predictMove 已經黏住了）、點燃火把（洞穴的）
  onPickup(c, e, msg, self) {
    if (msg.type === 'torch') { cave.onPickup(c, e, msg, self); return; }
    if (msg.type !== 'web') return;
    if (Number.isInteger(msg.torch)) cave.onPickup(c, e, { type: 'torch', id: msg.id, torch: msg.torch }, self);
    const S = spiderState(c.match);
    const was = !!(S && S.stuck[e.id]);
    applyWebPickup(c.match, msg);
    if (!was) caughtFx(c, e);
  },

  // 自己的回合本地走了一幀：踩進網（或站在網裡開始動）就馬上黏住、回報位置（伺服器照同一段路判，一定也會判到）
  predictMove(c, me, px, py) {
    if (!touchWeb(c.match, me, px, py, me.x, me.y)) return false;
    syncWebs(c.match);
    caughtFx(c, me);
    return true;
  },

  // 地形之後、角色之前：洞穴的火把、角落的蜘蛛網裝飾、女王的蜘蛛絲、躲在背景的女王（陰影）、吐出去的絲、飛過去的蛋 / 網
  drawScene(ctx, c) {
    cave.drawScene(ctx, c);
    drawCornerWebs(ctx);
    const q = queenOf(c.match);
    const S = spiderState(c.match);
    if (q && q.alive && S) {
      const at = queenAt(c, q);
      if (at.thread) drawThread(ctx, at.x - q.facing * 16, at.y - 50, at.thread);
      if (at.shadow >= 1) drawQueen(ctx, at.x, at.y, q.facing, c.time, 1, { shadow: 1 });   // 換狀態途中的由 drawEntityBare 畫
    }
    drawSilk(ctx, c);
    for (const t of c.state.throws) drawThrow(ctx, c, t);
  },

  // 蛋、網畫在其他角色前面（被蓋在下面）
  drawEntityFirst: (c, e) => isEgg(e) || isWeb(e),

  // 撲過去的女王 / 小蜘蛛（飛行物畫成牠）、換狀態中的女王（照動畫的位置畫）、躲在背景的女王（drawScene 畫成陰影）：一般的身體、血條、名字都不畫
  drawEntityBare(ctx, c, e) {
    if (c.state.running && e.id === c.state.running) return true;
    if (e.id !== QUEEN_ID || !e.alive) return false;
    const at = queenAt(c, e);
    if (at.shadow >= 1) return true;
    if (!at.moving) return false;
    drawQueen(ctx, at.x, at.y, e.facing, c.time, 1, { shadow: at.shadow, legsUp: at.kind === 'drop' });
    return true;
  },

  drawEntity(ctx, c, e, hurt) {
    if (e.id === QUEEN_ID) {
      drawQueen(ctx, e.x, e.y, e.facing, c.time, 1, { hurt, casting: castingNow(c, e) });
      return 'body';
    }
    if (isSpiderling(e)) {
      drawQueen(ctx, e.x, e.y, e.facing, c.time + e.x * 0.01, e.h / ART_H, { hurt, small: true });
      return 'body';
    }
    if (isEgg(e)) { drawEgg(ctx, c, e, hurt); return 'whole'; }
    if (isWeb(e)) { drawWeb(ctx, c, e, hurt); return 'whole'; }
    return false;
  },

  hpBar: (c, e) => (e.id === QUEEN_ID ? { w: 100, h: 8 } : isSpiderling(e) ? { w: 40, h: 5 } : null),

  // 洞穴的（掉下來的鐘乳石）+ 毒液、撲過去的女王 / 小蜘蛛
  drawProjectile(ctx, c, p) {
    if (cave.drawProjectile(ctx, c, p)) return true;
    const id = p.weapon.id;
    if (id === 'spiderVenom') { drawVenom(ctx, p); return true; }
    if (id === 'spiderBite' || id === 'spiderlingBite') {
      const e = c.match.byId(c.state.running);
      if (e) {
        const s = id === 'spiderBite' ? 1 : e.h / ART_H;
        drawQueen(ctx, p.x, p.y + e.h / 2, p.vx >= 0 ? 1 : -1, c.time, s, { small: id !== 'spiderBite', leap: true });
      }
      return true;
    }
    return false;
  },

  // 遮光（洞穴的；女王、蛋、網不畫陰影紅光）之後：女王的紅眼與蜘蛛絲的輪廓、蛋與網的輪廓（暗的地方也知道要打哪裡）、被黏住的人身上的絲
  drawShade(ctx, c) {
    drawCaveShade(ctx, c, (e) => e.id !== QUEEN_ID && !isEgg(e) && !isWeb(e));
    drawGhosts(ctx, c);
    drawQueenEyes(ctx, c);
    drawWraps(ctx, c);
  },

  // 洞穴那一行（敵人剩餘、火把）+ 女王的血量與狀態、下一招、蛛卵幾回合孵化、現在輪到的人被網黏住
  hud(c, line) {
    const lines = cave.hud(c, line);
    const match = c.match;
    const S = spiderState(match);
    const e = queenOf(match);
    if (!S || !e || !e.alive) return lines;
    const tag = S.mode === 'ground' ? '（在地上）' : S.mode === 'hide' ? '（躲在暗處）' : '';   // 一行放得下（名單框不要變太長，會蓋到右上的女王）
    lines.push([`${QUEEN_NAME} ${e.hp} / ${e.maxHp}${tag}`, '#fca5a5']);
    if (!S.cleansed && e.hpFloor > 0 && e.hp <= e.hpFloor) lines.push(['下一招：蛻去負面狀態＋召喚蛛卵', '#c084fc']);   // 血量到 50% 了：輪到她先做這個
    else if (S.mode === 'ground') lines.push(['下一招：撲咬（在地上只會撲咬）', '#fb923c']);
    else if (S.next && S.next.action) {
      const who = S.next.targetId ? match.byId(S.next.targetId) : null;
      lines.push([`下一招：${N[S.next.action] || S.next.action}${who ? ` → ${who.name}` : ''}`, '#fdba74']);
    }
    const eggs = S.eggs.filter(g => { const e = match.byId(g.id); return e && e.alive; });
    if (eggs.length) {
      const soon = Math.min(...eggs.map(g => g.left));
      lines.push([`蛛卵 ×${eggs.length}（${soon <= 1 ? '下一回合孵化！' : `${soon} 回合後孵化`}）`, '#fde68a']);
    }
    const cur = match.byId(c.currentId);
    if (cur && cur.alive && S.stuck[cur.id]) lines.push([`${cur.name} 被網黏住：射破才能動`, '#e5e7eb']);
    return lines;
  },
};

// ---------- 動畫腳本 ----------

// 女王 / 小蜘蛛的回合：一招一招照順序播（預兆 → 出招（照 shotScript 重播）→ 校正成伺服器結果），全部播完照伺服器帶來的狀態對齊
function* spiderTurnScript(c, msg) {
  const match = c.match;
  const actor = match.byId(msg.actorId);
  yield { frames: Math.round(CONFIG.TIMING.aiThink * FPS) };
  for (const step of msg.boss.steps) yield* stepScript(c, actor, step);
  Object.assign(c.state, { fx: null, throws: [], silkLines: null });
  if (msg.boss.state) restoreSpider(match, { spider: msg.boss.state });
}

const ease = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const lerp = (a, b, k) => a + (b - a) * k;

function* stepScript(c, actor, b) {
  const match = c.match;
  const cast = Math.max(1, Math.round((b.cast ?? CONFIG.TIMING.bossCast) * FPS));
  const fx = c.state.fx = { action: b.action, t: 0, cast: cast / FPS, step: b, actorId: actor ? actor.id : null, phase: 'cast' };
  announce(c, actor, b);
  for (let i = 0; i < cast; i++) {
    fx.t = i / FPS;
    castFrame(c, actor, b, i, cast);
    yield { frames: 1 };
  }
  fx.phase = 'act';
  c.state.throws = [];
  c.state.silkLines = null;
  if (b.shot && b.action === 'bite') yield* lungeScript(c, actor, b);
  else if (b.shot) yield* c.shotScript(b.shot);
  else if (b.still) {
    yield { until: () => match.isSettled(), max: b.still.settleFrames + 60 };
    match.applyEntities(b.still.results);
    yield { frames: Math.round(CONFIG.TIMING.settleDelay * FPS * 0.5) };
  }
  if (b.queen) {   // 這一招讓女王換了狀態（蛻皮後爬回天上、下完蛋退到背景、蛋孵化 / 燒光了從背景回來）：位置已經照結果套好
    setMode(match, b.queen.to);
    startShift(c, b.queen);
  }
}

// 招式的橫幅
function announce(c, actor, b) {
  const target = b.targetId ? c.match.byId(b.targetId) : null;
  const to = target ? ` → ${target.name}` : '';
  const who = actor ? actor.name : QUEEN_NAME;
  switch (b.action) {
    case 'burn': c.fx.banner('蛛卵燒起來了！', '#fb923c'); break;
    case 'hatch': c.fx.banner(`蛛卵孵化了！爬出 ${(b.spawns || []).length} 隻小蜘蛛`, '#fca5a5'); break;
    case 'cleanse': c.fx.banner(`${QUEEN_NAME}蛻去了身上的負面狀態！`, '#c084fc'); break;
    case 'regen': c.fx.banner(`${QUEEN_NAME}在暗處休養…`, '#e9d5ff'); break;
    case 'summon': c.fx.banner(`${QUEEN_NAME}：${N.summon}${b.forced ? '（被逼急了）' : ''}！`, '#f87171'); break;
    case 'idle': c.fx.banner(`${who}${N.idle}中`, '#e9d5ff'); break;
    default: c.fx.banner(`${who}：${N[b.action] || b.action}${to}！`, '#fca5a5');
  }
}

// 預兆每一幀：蛋燒、孵化、蛻皮、回血、吐絲、下蛋、撲網……（招式的結果在預兆播完才照伺服器的套上）
function castFrame(c, actor, b, i, cast) {
  const match = c.match;
  const k = i / cast;
  const at = (q) => i === Math.round(cast * q);
  const q = queenOf(match);
  switch (b.action) {
    case 'burn':
      if (i === 0) {
        for (const { id, dmg } of b.burns || []) {
          const e = match.byId(id);
          if (!e) continue;
          c.fx.float(e, `-${dmg} 燃燒`, '#fb923c');
          c.fx.particles(e.x, e.y - e.h / 2, 12, { speed: 80, life: 0.7, size: 3.5, color: '#f97316', gravity: -160 });
        }
        c.fx.sound('ignite', { x: CONFIG.WORLD_W / 2 });
      }
      break;
    case 'hatch':
      for (const s of b.spawns || []) {
        const egg = match.byId(s.egg);
        if (egg && i % 6 === 0 && k < 0.8) c.fx.particle({ x: egg.x + (Math.random() - 0.5) * 16, y: egg.y - 10, vx: (Math.random() - 0.5) * 40, vy: -40, life: 0.4, maxLife: 0.4, size: 2, color: '#fef3c7', gravity: 300 });
        if (at(0.8)) {
          if (egg) egg.die('hatch');
          const e = match.byId(s.id) || spawnSpiderling(match, s);
          c.fx.particles(s.x, s.y - 10, 16, { speed: 140, life: 0.6, size: 3, color: '#fef3c7', gravity: 500 });
          c.fx.float(e, '孵化了！', '#fca5a5', 15);
        }
      }
      if (at(0.8)) c.fx.sound('crack', { x: CONFIG.WORLD_W / 2 });
      break;
    case 'cleanse':
      if (q && i % 3 === 0) c.fx.particle({ x: q.x + (Math.random() - 0.5) * 80, y: q.y - Math.random() * q.h, vx: 0, vy: -50, life: 0.7, maxLife: 0.7, size: 2.5, color: '#c084fc', gravity: -30 });
      if (q && at(0.85)) { c.fx.float(q, '移除所有負面狀態', '#c084fc', 16); c.fx.sound('roar', { x: q.x }); c.fx.shake(6); }
      break;
    case 'regen':
      if (q && i === 0 && b.heal > 0) c.fx.float(q, `+${b.heal}`, '#86efac');
      break;
    case 'silk': {
      if (!q) break;
      const o = fangsOf(q);
      c.state.silkLines = { x0: o.x, y0: o.y, ids: [...(b.targetIds || []), ...(b.immune || [])], k: ease(k / 0.6) };
      if (i === 0) c.fx.sound('gust', { x: o.x });
      if (at(0.6)) {
        for (const id of b.targetIds || []) { const e = match.byId(id); if (e) c.fx.float(e, `糾纏！體力消耗 +${CONFIG.ENTANGLE.staminaPct}%`, '#e5e7eb', 15); }
        for (const id of b.immune || []) { const e = match.byId(id); if (e) c.fx.float(e, '免疫', '#fde68a', 15); }
      }
      break;
    }
    case 'summon': {
      if (!q) break;
      const o = fangsOf(q);
      c.state.throws = k < 0.8 ? (b.spawns || []).map(s => ({ kind: 'egg', x0: o.x, y0: o.y, x1: s.x, y1: s.y, k: ease(k / 0.8) })) : [];
      if (i === 0) c.fx.sound('heave', { x: o.x });
      if (at(0.8)) {
        for (const s of b.spawns || []) {
          if (!match.byId(s.id)) spawnEgg(match, s);
          c.fx.particles(s.x, s.y - 8, 8, { speed: 90, life: 0.5, size: 2.5, color: '#e7e5e4', gravity: 400 });
        }
        c.fx.sound('plop', { x: CONFIG.WORLD_W / 2 });
      }
      break;
    }
    case 'web': {
      const spec = (b.spawns || [])[0];
      if (!q || !spec) break;
      const o = fangsOf(q);
      c.state.throws = k < 0.75 ? [{ kind: 'web', x0: o.x, y0: o.y, x1: b.x, y1: b.y - CONFIG.SPIDER_WEB.h / 2, k: ease(k / 0.75) }] : [];
      if (i === 0) c.fx.sound('heave', { x: o.x });
      if (at(0.75)) {
        if (!match.byId(spec.id)) spawnWeb(match, spec);
        for (const pid of b.caught || []) {
          applyWebPickup(match, { id: pid, web: spec.id, x: b.x });
          const p = match.byId(pid);
          if (p) caughtFx(c, p);
        }
        c.fx.sound('plop', { x: b.x });
        c.fx.particles(b.x, b.y - 20, 10, { speed: 90, life: 0.5, size: 2, color: '#f1f5f9', gravity: 200 });
      }
      break;
    }
    case 'venom':
      if (q && at(0.7)) c.fx.sound('dart', { x: q.x });
      break;
    case 'bite':
      if (actor && i === 0) c.fx.sound('heave', { x: actor.x });
      break;
    default:
  }
}

// 撲過去的那段：飛行物畫成女王 / 小蜘蛛，角色本身先不畫（running）。飛行物一消失就放到伺服器算好的位置、畫回來
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

// 女王換了狀態（change = syncQueen 回傳的 { from, to, x0, y0 }）：照它播掉下來 / 爬回去 / 退到背景 / 回來的動畫、飄字
function startShift(c, change) {
  const q = queenOf(c.match);
  if (!q) return;
  const kind = change.to === 'ground' ? 'drop' : change.to === 'hide' ? 'hide' : change.from === 'hide' ? 'emerge' : 'climb';
  c.state.shift = { kind, x0: change.x0, y0: change.y0, t: 0, dur: SHIFT[kind] };
  if (kind === 'drop') {
    c.fx.banner(`${QUEEN_NAME}被燒得掉下來了！`, '#fb923c');
    c.fx.sound('crack', { x: change.x0 });
  } else if (kind === 'climb') {
    c.fx.float(q, '爬回天上了', '#e9d5ff', 15);
    c.fx.sound('heave', { x: q.x });
  } else if (kind === 'hide') {
    c.fx.float(q, '退到暗處守著蛛卵', '#e9d5ff', 15);
  } else {
    c.fx.banner(`蛛卵沒了，${QUEEN_NAME}從暗處回來了！`, '#fca5a5');
  }
}

// 女王現在畫在哪：{ x, y, thread（蜘蛛絲畫多淡，0 = 不畫）, shadow（0 = 一般、1 = 只剩背景的陰影）, moving（正在換狀態）, kind }
function queenAt(c, q) {
  const S = spiderState(c.match);
  const sh = c.state.shift;
  const mode = S ? S.mode : 'hang';
  const out = { x: q.x, y: q.y, thread: mode === 'ground' ? 0 : 1, shadow: mode === 'hide' ? 1 : 0, moving: false, kind: null };
  if (!sh) return out;
  const k = Math.min(1, sh.t / sh.dur);
  out.moving = true;
  out.kind = sh.kind;
  if (sh.kind === 'drop') {   // 絲斷掉，直直掉下去（越掉越快）
    out.x = lerp(sh.x0, q.x, k);
    out.y = lerp(sh.y0, q.y, k * k);
    out.thread = 0;
  } else if (sh.kind === 'climb') {   // 沿著絲爬回去
    out.x = lerp(sh.x0, q.x, ease(k));
    out.y = lerp(sh.y0, q.y, ease(k));
    out.thread = 1;
  } else if (sh.kind === 'hide') {
    out.shadow = k;
  } else {
    out.shadow = 1 - k;
  }
  return out;
}

// 女王正在出招（身體微微發亮、腳張開）
function castingNow(c, e) {
  const fx = c.state.fx;
  return !!(fx && fx.actorId === e.id && fx.phase === 'cast');
}

// 被網黏住：飄字、一點絲屑
function caughtFx(c, e) {
  c.fx.float(e, '被蜘蛛網黏住了！', '#e5e7eb', 16);
  c.fx.particles(e.x, e.y - e.h / 2, 10, { speed: 70, life: 0.5, size: 2, color: '#f1f5f9', gravity: 150 });
  c.fx.sound('plop', { x: e.x });
}

// 倒下：女王（橫幅）、蛋（破掉噴出黃色的汁；孵化 / 女王倒下跟著消失的不另外演）、網（被射破，黏住的人掙脫）、小蜘蛛（一般的）
function onSpiderDeath(c, e) {
  if (e.id === QUEEN_ID) {
    c.fx.banner(`${QUEEN_NAME}倒下了！`, '#f87171');
    c.fx.shake(14);
    c.fx.sound('crack', { x: e.x });
    c.fx.particles(e.x, e.cy, 30, { speed: 200, life: 1.1, size: 4, color: '#2a1430', gravity: 450 });
    c.fx.particles(e.x, e.cy - 10, 14, { speed: 140, life: 1.2, size: 3, color: '#a3e635', gravity: 300 });
    return true;
  }
  if (isEgg(e)) {
    if (e.deathCause !== 'hatch' && e.deathCause !== 'wither') {
      c.fx.float(e, '蛛卵破了！', '#fde68a', 15);
      c.fx.particles(e.x, e.y - 10, 16, { speed: 150, life: 0.6, size: 3, color: '#d9f99d', gravity: 500 });
      c.fx.sound('plop', { x: e.x });
    }
    return true;
  }
  if (isWeb(e)) {
    if (e.deathCause !== 'wither') {
      c.fx.particles(e.x, e.y - e.h / 2, 18, { speed: 160, life: 0.6, size: 2, color: '#f1f5f9', gravity: 200 });
      c.fx.sound('fizzle', { x: e.x });
      const held = e.heldId ? c.match.byId(e.heldId) : null;
      c.fx.float(held && held.alive ? held : e, held && held.alive ? '掙脫了！' : '網破了！', '#86efac', 15);
    }
    return true;
  }
  if (isSpiderling(e) && e.deathCause === 'wither') return true;
  return false;
}

// ---------- 繪圖 ----------

// 蜘蛛（女王 / 小蜘蛛共用；腳底在 (x, y)、面向 f、整隻縮放 s）：後面那排腳、腹部（女王背上有紅色沙漏紋）、頭胸部、一圈紅眼、螯牙、前面那排腳。
// o.shadow = 退到背景的程度（0 ~ 1：越來越暗、越來越透明，只剩輪廓）、o.hurt = 剛被打到（閃白）、o.leap = 撲過去（腳往後收）、
// o.legsUp = 掉下來（腳往上張）、o.small = 小蜘蛛（沒有沙漏紋、顏色淡一點）、o.casting = 出招的預兆（腳張開、眼睛更亮）
function drawQueen(ctx, x, y, f, t, s, o = {}) {
  const shadow = o.shadow || 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(f * s, s);
  ctx.globalAlpha *= 1 - shadow * 0.45;
  const dark = (hex, alt) => (o.hurt ? '#ffffff' : shadow > 0.5 ? alt : hex);
  const body = dark(o.small ? '#3b2436' : '#2a1430', '#0c0710');
  const edge = dark(o.small ? '#6b4a62' : '#5b2b52', '#1a1020');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const legs = [   // [接在身上的點, 膝蓋, 腳尖]（面向右的座標，腳底 y = 0）
    [[24, -28], [54, -54], [74, 0]],
    [[20, -26], [40, -60], [48, 0]],
    [[14, -26], [-6, -62], [-14, 0]],
    [[10, -28], [-30, -54], [-48, 0]],
  ];
  const drawLegs = (back) => {
    ctx.strokeStyle = back ? dark('#160a18', '#050307') : edge;
    ctx.lineWidth = back ? 4.5 : 5;
    legs.forEach(([a, kn, ft], i) => {
      const wob = Math.sin(t * 3 + i * 1.4 + (back ? 1 : 0)) * 2;
      const spread = o.casting ? 6 : 0;
      let kx = kn[0] + (back ? 4 : 0), ky = kn[1] + wob - spread;
      let fx = ft[0] + (back ? 6 : 0) + Math.sign(ft[0]) * spread, fy = ft[1] - (back ? 3 : 0);
      if (o.leap) { kx *= 0.7; fx = fx * 0.55 - 14; fy = -10; }
      if (o.legsUp) { ky -= 18; fy = -44 + i * 4; }
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    });
  };
  drawLegs(true);
  // 腹部
  ctx.fillStyle = body;
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(-16, -30, 32, 25, -0.12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (!o.small && !o.hurt && shadow < 0.5) {   // 背上的紅色沙漏紋
    ctx.fillStyle = '#b91c1c';
    ctx.beginPath(); ctx.moveTo(-26, -46); ctx.lineTo(-10, -46); ctx.lineTo(-18, -32); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-26, -18); ctx.lineTo(-10, -18); ctx.lineTo(-18, -30); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.ellipse(-22, -42, 18, 7, -0.2, 0, Math.PI * 2); ctx.fill();
  }
  // 頭胸部
  ctx.fillStyle = body;
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(22, -26, 19, 15, 0.1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // 螯牙
  ctx.strokeStyle = dark('#d6d3d1', '#1a1020');
  ctx.lineWidth = 2.5;
  for (const dy of [-4, 3]) { ctx.beginPath(); ctx.moveTo(36, -18 + dy); ctx.quadraticCurveTo(44, -14 + dy, 40, -8 + dy); ctx.stroke(); }
  // 眼睛（遮光上面另外畫發光的那一層，見 drawQueenEyes）
  if (!o.hurt && shadow < 1) {
    ctx.fillStyle = o.casting ? '#fecaca' : '#ef4444';
    for (const [ex, ey, r] of [[30, -32, 2.6], [34, -28, 2.2], [26, -34, 2], [36, -33, 1.6], [28, -28, 1.6], [32, -36, 1.4]]) {
      ctx.beginPath(); ctx.arc(ex, ey, r, 0, Math.PI * 2); ctx.fill();
    }
  }
  drawLegs(false);
  ctx.restore();
}

// 女王的眼睛在哪（世界座標）：照 queenAt 的位置、面向
function eyesOf(c, q) {
  const at = queenAt(c, q);
  return { x: at.x + q.facing * 31, y: at.y - 32, shadow: at.shadow };
}

// 女王的紅眼（畫在遮光上面，暗的地方也看得到她在哪）：站在陰影裡（傷害加成）時紅光更大、會呼吸；出招時更亮。躲在背景只剩這一對眼睛
function drawQueenEyes(ctx, c) {
  const q = queenOf(c.match);
  if (!q || !q.alive || c.state.running === q.id) return;
  const E = eyesOf(c, q);
  const dark = inShadow(c.match, q.cx, q.cy);
  const casting = castingNow(c, q);
  const r = (dark ? 16 : 10) + (casting ? 6 : 0) + Math.sin(c.time * (dark ? 4 : 2)) * 2;
  const g = ctx.createRadialGradient(E.x, E.y, 0, E.x, E.y, r);
  g.addColorStop(0, `rgba(254,202,202,${casting ? 0.85 : 0.6})`);
  g.addColorStop(0.4, `rgba(239,68,68,${dark ? 0.45 : 0.28})`);
  g.addColorStop(1, 'rgba(239,68,68,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(E.x, E.y, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fca5a5';
  for (const [dx, dy] of [[-3, -1], [2, 1], [-1, 4]]) { ctx.beginPath(); ctx.arc(E.x + dx * q.facing, E.y + dy, 1.8, 0, Math.PI * 2); ctx.fill(); }
}

// 遮光上面淡淡的輪廓：女王的蜘蛛絲、蛋、網（暗的地方也知道要打哪裡；照得到的地方本來就看得到，疊上去也不明顯）
function drawGhosts(ctx, c) {
  const q = queenOf(c.match);
  ctx.save();
  if (q && q.alive) {
    const at = queenAt(c, q);
    if (at.thread) {
      ctx.strokeStyle = silk(0.22 * at.thread);
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(at.x - q.facing * 16, CEILING); ctx.lineTo(at.x - q.facing * 16, at.y - q.h + 6); ctx.stroke();
    }
  }
  for (const e of c.match.entities) {
    if (!e.alive) continue;
    if (isEgg(e)) {
      ctx.strokeStyle = 'rgba(254,243,199,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(e.x, e.y - e.h / 2, e.hw, e.h / 2, 0, 0, Math.PI * 2); ctx.stroke();
    } else if (isWeb(e)) {
      ctx.globalAlpha = 0.3;
      webLines(ctx, e.x, e.y - e.h / 2, e.hw, e.h / 2, 'rgba(241,245,249,1)', 1);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

// 被網黏住的人：身上纏著幾圈絲（畫在遮光上面）
function drawWraps(ctx, c) {
  const S = spiderState(c.match);
  if (!S) return;
  ctx.save();
  ctx.strokeStyle = silk(0.75);
  ctx.lineWidth = 1.4;
  for (const pid of Object.keys(S.stuck)) {
    const p = c.match.byId(pid);
    if (!p || !p.alive) continue;
    for (let k = 0; k < 4; k++) {
      const y = p.y - 4 - k * (p.h - 6) / 3;
      const wob = Math.sin(c.time * 2 + k) * 1.5;
      ctx.beginPath(); ctx.moveTo(p.x - p.hw - 4, y + 3 + wob); ctx.quadraticCurveTo(p.x, y - 4, p.x + p.hw + 4, y + 2 - wob); ctx.stroke();
    }
  }
  ctx.restore();
}

// 懸吊的蜘蛛絲：從天花板垂到女王的背上（x = 腹部的中間、yTop = 腹部頂端）
function drawThread(ctx, x, yTop, alpha) {
  ctx.save();
  ctx.strokeStyle = silk(0.55 * alpha);
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x, CEILING); ctx.lineTo(x, yTop); ctx.stroke();
  ctx.restore();
}

// 蛋的血量旁的燃燒層數：一小簇火 + 數字
function drawBurnTag(ctx, x, y, stacks) {
  ctx.fillStyle = '#f97316';
  ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.quadraticCurveTo(x + 4, y - 1, x + 2.5, y + 2); ctx.quadraticCurveTo(x, y + 4, x - 2.5, y + 2); ctx.quadraticCurveTo(x - 4, y - 1, x, y - 6); ctx.fill();
  text(ctx, String(stacks), x + 5, y + 4, { size: 10, bold: true, color: '#fdba74', outline: 'rgba(0,0,0,0.9)' });
}

// 吐絲：從口器往每個人射出去的絲（照預兆的進度伸長）
function drawSilk(ctx, c) {
  const L = c.state.silkLines;
  if (!L) return;
  ctx.save();
  ctx.strokeStyle = silk(0.8);
  ctx.lineWidth = 1.6;
  for (const id of L.ids) {
    const e = c.match.byId(id);
    if (!e) continue;
    const x1 = lerp(L.x0, e.cx, L.k), y1 = lerp(L.y0, e.cy, L.k);
    ctx.beginPath(); ctx.moveTo(L.x0, L.y0); ctx.quadraticCurveTo((L.x0 + x1) / 2, Math.max(L.y0, y1) + 30, x1, y1); ctx.stroke();
  }
  ctx.restore();
}

// 飛過去的蛋（一顆白色的卵囊）/ 網（一團捲起來的絲）：拋物線
function drawThrow(ctx, c, t) {
  const x = lerp(t.x0, t.x1, t.k), y = lerp(t.y0, t.y1, t.k) - Math.sin(t.k * Math.PI) * 70;
  ctx.save();
  ctx.strokeStyle = silk(0.4);
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(t.x0, t.y0); ctx.lineTo(x, y); ctx.stroke();
  if (t.kind === 'egg') {
    ctx.fillStyle = '#f5f5f4';
    ctx.beginPath(); ctx.ellipse(x, y, 9, 11, 0, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.strokeStyle = silk(0.9);
    ctx.lineWidth = 1.4;
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(x, y, 5 + k * 3, c.time * 6 + k, c.time * 6 + k + 4.5); ctx.stroke(); }
  }
  ctx.restore();
}

// 蛛卵：白色的卵囊（裹著絲，裡面隱約三顆卵），快孵化時會抖、裂開；上面一排血量小點、幾回合孵化；燒著的話身上有火
function drawEgg(ctx, c, e, hurt) {
  const S = spiderState(c.match);
  const g = S ? S.eggs.find(q => q.id === e.id) : null;
  const left = g ? g.left : CONFIG.SPIDER_EGG.hatchTurns;
  const shake = left <= 1 ? Math.sin(c.time * 30) * 1.2 : 0;
  const cx = e.x + shake, cy = e.y - e.h / 2;
  ctx.save();
  ctx.fillStyle = hurt ? '#ffffff' : '#e7e5e4';
  ctx.strokeStyle = '#a8a29e';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.ellipse(cx, cy, e.hw, e.h / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(253,230,138,0.55)';
  for (const [dx, dy] of [[-5, 3], [5, 2], [0, -5]]) { ctx.beginPath(); ctx.arc(cx + dx, cy + dy, 4, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = silk(0.7);
  ctx.lineWidth = 1;
  for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(cx - e.hw, cy + k * 6); ctx.quadraticCurveTo(cx, cy + k * 6 - 6, cx + e.hw, cy + k * 6); ctx.stroke(); }
  if (left <= 1) {   // 裂縫
    ctx.strokeStyle = '#57534e';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(cx - 3, cy - 10); ctx.lineTo(cx + 1, cy - 4); ctx.lineTo(cx - 2, cy + 1); ctx.lineTo(cx + 3, cy + 6); ctx.stroke();
  }
  if (e.burn > 0) drawFlames(ctx, c, cx, e.y, e.hw);
  if (e.alive) {   // 血量畫成一排小點（3 點血：每被打一下少一顆）
    const n = Math.max(1, e.maxHp), gap = 8, w = gap * (n - 1) + 6, x = e.x - w / 2, y = e.y - e.h - 9;
    for (let k = 0; k < n; k++) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath(); ctx.arc(x + 3 + k * gap, y + 2, 3.4, 0, Math.PI * 2); ctx.fill();
      if (k < e.hp) { ctx.fillStyle = '#fde68a'; ctx.beginPath(); ctx.arc(x + 3 + k * gap, y + 2, 2.4, 0, Math.PI * 2); ctx.fill(); }
    }
    text(ctx, String(left), e.x, y - 4, { size: 12, bold: true, align: 'center', color: left <= 1 ? '#f87171' : '#fde68a', outline: 'rgba(0,0,0,0.9)' });
    if (e.burn > 0) drawBurnTag(ctx, x + w + 6, y + 2, e.burn);
  }
  ctx.restore();
}

// 蜘蛛網：放射狀的絲 + 一圈圈的橫絲（畫在網的範圍裡，底部貼著地面 / 岩台）。被打到一下就破，不畫血條
function drawWeb(ctx, c, e, hurt) {
  ctx.save();
  webLines(ctx, e.x, e.y - e.h / 2, e.hw, e.h / 2, hurt ? '#ffffff' : 'rgba(241,245,249,0.8)', hurt ? 2 : 1.3);
  ctx.restore();
}

// 一張網的線（中心 (cx, cy)、半寬 rx、半高 ry）
function webLines(ctx, cx, cy, rx, ry, color, width) {
  const spokes = 8;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  const pt = (a, r) => [cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r];
  for (let i = 0; i < spokes; i++) {
    const [x, y] = pt(i * Math.PI * 2 / spokes, 1);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
  }
  for (const r of [0.35, 0.65, 0.95]) {
    ctx.beginPath();
    for (let i = 0; i <= spokes; i++) {
      const [x, y] = pt(i * Math.PI * 2 / spokes, r);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
}

// 燒著的蛋：底部幾簇晃動的小火
function drawFlames(ctx, c, x, y, hw) {
  for (let k = -1; k <= 1; k++) {
    const fx = x + k * hw * 0.6, hgt = 10 + Math.sin(c.time * 11 + k * 2) * 3;
    ctx.fillStyle = 'rgba(251,146,60,0.85)';
    ctx.beginPath(); ctx.moveTo(fx - 4, y); ctx.quadraticCurveTo(fx - 5, y - hgt * 0.5, fx, y - hgt); ctx.quadraticCurveTo(fx + 5, y - hgt * 0.5, fx + 4, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(254,240,138,0.9)';
    ctx.beginPath(); ctx.ellipse(fx, y - hgt * 0.3, 1.8, 3.5, 0, 0, Math.PI * 2); ctx.fill();
  }
}

// 角落的舊蜘蛛網（純裝飾）：左上、右上的天花板角落
function drawCornerWebs(ctx) {
  ctx.save();
  for (const [x, y, dir] of [[0, 34, 1], [CONFIG.WORLD_W, 34, -1]]) {
    ctx.strokeStyle = 'rgba(214,211,209,0.22)';
    ctx.lineWidth = 1;
    const R = 90;
    for (let i = 0; i <= 5; i++) {
      const a = i / 5 * Math.PI / 2;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dir * Math.cos(a) * R, y + Math.sin(a) * R); ctx.stroke();
    }
    for (const r of [25, 48, 70, 88]) {
      ctx.beginPath();
      for (let i = 0; i <= 5; i++) {
        const a = i / 5 * Math.PI / 2;
        const px = x + dir * Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

// 毒液：一團綠色的毒，後面拖著滴下來的毒
function drawVenom(ctx, p) {
  for (let i = 0; i < p.trail.length; i += 2) {
    const t = p.trail[i], k = i / p.trail.length;
    ctx.fillStyle = `rgba(163,230,53,${k * 0.45})`;
    ctx.beginPath(); ctx.arc(t.x, t.y, 2 + k * 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#84cc16';
  ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = 'rgba(236,252,203,0.8)';
  ctx.beginPath(); ctx.arc(p.x - 2, p.y - 2, 2.5, 0, Math.PI * 2); ctx.fill();
}
