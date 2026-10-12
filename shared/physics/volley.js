import { CONFIG } from '../core/config.js';
import { advanceProjectile, stepReturn, sweepReturn, makeProjectile, applyRecoil } from './weapons.js';

// 一波（Volley）：一次開火 / 轟炸 / Boss 招式的飛行物，從第 1 幀飛到全部結束，再沉降到大家站穩。
// 伺服器（runVolley）與客戶端重播（replayVolley）走同一個幀迴圈（loop），差別只在「撞到東西」那一步：
//   伺服器：advanceProjectile(world) 真的做碰撞 → match.resolveHit 結算，寫成事件
//   重播：advanceProjectile(null) 只跑運動學 → 照伺服器的事件校正位置、套用角色狀態 / 挖坑 / 地圖機制帶的（蛇血、蜜蜂）
// 飛行物的狀態機（transition）也只有這裡一份，兩邊共用。
//
// 每一幀的順序（兩邊一樣，伺服器 Match.runVolley 以前就是這樣）：
//   match.step(FIXED_DT) 一次 → 每顆飛行物照索引順序：出發（spawn === f）→ 回程 stepReturn / 飛行 advanceProjectile
//   → 這顆、這一幀的事件（照陣列順序）→ 沒事件又還在飛就記路徑 → 尾跡 / 旋轉 → 全部跑完後濾掉結束的（frame 掛勾）
//
// 半路才出現的飛行物（例如被打下來的鐘乳石）：事件帶 adds = [{ w: 武器 id, x, y, vx, vy, k?, passAllies? }]，兩邊都在套用那個事件時
// 接到飛行物清單的最後面（索引照順序往下排），下一幀出發；用它自己的武器結算（傷害、重力），不吃這一波的燃燒。
// 它們不在 shot.projectiles 裡（那是開火當下就有的）
//
// 飛過去（pass）：飛行物這一幀沒撞到東西，但地圖機制要它留下記號（例如玩家的子彈從火把旁邊飛過去 → 點燃）。
// 伺服器寫成一個 type 'pass' 的事件（位置 = 這一幀結束的位置），狀態機不變（繼續飛），客戶端照事件套用地圖機制帶的欄位

const FDT = CONFIG.FIXED_DT;
const SETTLE_CAP = 360;   // 伺服器沉降的上限幀數（Match.resolveVolley 一直是 360）；剛好到上限時客戶端不檢查有沒有站穩
const NONE = Object.freeze([]);
const PASS = Object.freeze({});

/**
 * 準備重播一波：照伺服器的事件逐幀重播（客戶端與測試用）。純函式：只讀 shot、什麼都不改；
 * 擺好射手、真正開始跑要等 frames() / run() 的第一個 next()。
 * @param {import('../game/match.js').Match} match  客戶端的 Match（用到 step、isSettled、byId、terrain、mechanic）
 * @param {object} shot  'shot' 訊息 / aiTurn.shot / Boss 招式的 b.shot（走過一趟 JSON 的）；唯讀，絕不修改
 * @returns {VolleyReplay|null}  只有 CONFIG.WEAPONS[shot.weapon] 不存在時回傳 null（什麼都沒碰）
 * @throws {TypeError} events / projectiles 不是陣列（或裡面有不是物件的）、flightFrames / settleFrames 不是 ≥ 0 的整數
 */
export function replayVolley(match, shot) {
  const weapon = shot ? CONFIG.WEAPONS[shot.weapon] : null;
  if (!weapon) return null;
  validate(shot);
  const live = [];
  const drift = [];
  const end = { settle: null };
  let started = false;
  const frames = (look) => {   // 呼叫的當下就檢查（不是等到第一個 next()）
    if (started) throw new Error('replayVolley: frames() / run() 只能跑一次');
    started = true;
    return replay(match, shot, weapon, live, drift, end, look || {});
  };
  return {
    live, drift, frames,
    get settle() { return end.settle; },
    run(look) { for (const _ of frames(look)) { /* 沒有人代步進：模組在下一次 next() 自己步進 */ } return drift; },
  };
}

/**
 * @typedef {object} VolleyReplay
 * @property {LiveProjectile[]} live  畫面用的飛行物清單：整段都是同一個陣列（原地更新，飛行結束清空）
 * @property {string[]} drift  跟伺服器結構上對不起來的地方（空的 = 一致）：跳過的事件、輪不到的事件、不認得的 ents id、飛行結束還沒結束的飛行物
 * @property {string|null} settle  跑完之後：客戶端不是剛好在第 S 幀第一次站穩就是說明，一致是 null。
 *   以前站在斜坡 / 坑底的角色會上下抖零點幾 px，從快照還原後站穩的那一幀會跟伺服器差一點（已修，見 Entity.standing）；
 *   正式遊戲照舊只拿 drift 警告，settle 只在測試檢查
 * @property {(look?: VolleyLook) => Generator<VolleyTick, void>} frames  逐幀推進（GameView 用）；只能跑一次
 * @property {(look?: VolleyLook) => string[]} run  一次跑完 frames()（測試用），回傳 drift
 *
 * @typedef {{frames: 1, step: () => void}} VolleyTick  每幀一個新的物件；step() 跑這一幀的 match.step(FIXED_DT)，重複呼叫沒有作用。
 *   宿主可以在自己的物理時間點呼叫 step()；沒呼叫的話模組在下一次 next() 自己呼叫。宿主拿著 tick 的那一次 update 不能再自己跑角色物理，
 *   也要原封不動往外傳（yield*），不能複製。
 *
 * @typedef {object} VolleyLook  畫面掛勾，每個都可以不給
 * @property {(p: LiveProjectile) => void} [spawn]  出發的那一幀：已經從砲口出發（follow）、已經在 live 裡
 * @property {(ev: object, p: LiveProjectile, made: ShotMade) => void} [event]  一個事件套用完之後（狀態機、挖坑、角色狀態、蛇血、蜜蜂都已經套上）
 * @property {(live: LiveProjectile[], f: number) => void} [frame]  每一個飛行幀濾掉結束的飛行物之後；飛行結束時 live 還有東西的話清空後再呼叫一次
 *
 * @typedef {object} ShotMade
 * @property {{x: number, y: number, vx: number, vy: number, state: string}} before  套用這個事件之前，客戶端自己推進到的飛行物狀態
 * @property {object|null} rect  terrain.carve 的結果（重畫用）；沒挖坑是 null
 * @property {object[]} items  這個事件新加進場上的道具（地圖機制的狀態裡的道具，目前只有巨蟒的蛇血）（複製出來的物件；畫面自己的動畫資料記在地圖畫面裡，不寫在上面）
 * @property {import('./entities.js').Entity[]} bees  這個事件新建出來的蜜蜂
 *
 * @typedef {object} LiveProjectile  唯讀（呼叫端可以加自己的欄位，例如 debrisTick）
 * @property {number} i  第幾顆（shot.projectiles 的索引）
 * @property {object} weapon  CONFIG.WEAPONS 的那一項
 * @property {number} x @property {number} y @property {number} vx @property {number} vy
 * @property {number} x0 @property {number} y0  出發點（payload 給的；巨蟒的頭照「往前移了多少」衝出去）
 * @property {{x: number, y: number}[]} trail  最近 18 個位置（事件之後才記）
 * @property {number} spin  每幀 +0.45
 * @property {'pending'|'flying'|'returning'|'done'} state
 * @property {boolean} [added]  半路才出現的（事件的 adds，例如被打下來的鐘乳石）；k = 第幾根（地圖畫面照它畫）
 */

/**
 * 伺服器結算一波（Match.resolveVolley 用）：碰撞 → match.resolveHit(owner, weapon, p, i, hit, f, burn) 結算並回傳事件；
 * 狀態機由這裡套用（resolveHit 不寫 p.state / retIdx）；超時的算飛出場外（out）；最後沉降到站穩（最多 360 幀）。
 * @param {import('../game/match.js').Match} match
 * @param {import('./entities.js').Entity} owner
 * @param {object} weapon  CONFIG.WEAPONS 的那一項
 * @param {object[]} projs  makeProjectile 做的飛行物（加上 spawn / follow）；會被改（state、path、retIdx…）
 * @param {number} burn
 * @returns {{events: object[], flightFrames: number, settleFrames: number}}
 */
export function runVolley(match, owner, weapon, projs, burn) {
  const events = [];
  for (const p of projs) p.state = 'pending';
  const maxFrames = Math.round(CONFIG.TIMING.maxShotSeconds * 60);
  const side = {
    get world() { return match.world; },
    more: (f) => f < maxFrames && projs.some(p => p.state !== 'done'),
    // 迴力鏢回程：這一幀路上碰到的敵人（sweepReturn，可能好幾個；沒有 = null）
    sweep(p, x0, y0) {
      const hits = sweepReturn(match.world, p, x0, y0);
      return hits.length ? hits : null;
    },
    events(p, i, f, hit, caught, x0, y0) {
      const out = [];
      if (Array.isArray(hit)) {   // 迴力鏢回程打到的（照碰到的順序），這一幀接住的話 catch 排在最後
        for (const h of hit) out.push(match.resolveHit(owner, weapon, p, i, h, f, burn));
        if (caught) out.push({ f, p: i, type: 'catch', x: p.x, y: p.y });
      } else {
        const ev = caught ? { f, p: i, type: 'catch', x: p.x, y: p.y }
          : hit ? match.resolveHit(owner, p.added ? p.weapon : weapon, p, i, hit, f, p.added ? 0 : burn)
            : p.added ? null : match.resolvePass(owner, p, i, f, x0, y0);
        if (ev) out.push(ev);
      }
      if (!out.length) return NONE;
      for (const ev of out) {
        events.push(ev);
        for (const a of ev.adds || NONE) {   // 半路才出現的飛行物（見最上面的說明）
          const q = makeProjectile(owner, CONFIG.WEAPONS[a.w], a.x, a.y, a.vx, a.vy);
          Object.assign(q, { spawn: f + 1, state: 'pending', added: true, k: a.k });
          // 穿過射手自己與他的隊友（例如獨眼巨人震下來的鐘乳石不會砸到他自己）。只有伺服器的碰撞用得到
          if (a.passAllies) { q.passAllies = true; q.ignore.add(owner); }
          projs.push(q);
        }
      }
      return out;
    },
    gate: () => PASS,
    flightDone(f) {   // 超時還沒結束的視為飛出場外；沒出發過的直接結束
      projs.forEach((p, i) => {
        if (p.state === 'flying' || p.state === 'returning') {
          const ev = { f, p: i, type: 'out', x: p.x, y: p.y };
          events.push(ev);
          transition(p, ev);
        } else p.state = 'done';
      });
    },
  };
  const flightFrames = drain(loop(match, owner, weapon, projs, side));
  const settleFrames = match.settle(SETTLE_CAP);
  return { events, flightFrames, settleFrames };
}

// ---------- 內部 ----------

// 飛行物的狀態機（唯一的一份）：bounce / pierce / pass 繼續飛（迴力鏢回程打到人也是 pierce）；return 開始沿原路回程；
// 其他（explode、water、out、range（飛到最長路徑消散）、catch）結束
function transition(p, ev) {
  switch (ev.type) {
    case 'bounce': case 'pierce': case 'pass': return;
    case 'return': p.state = 'returning'; p.retIdx = p.path.length; return;
    default: p.state = 'done';
  }
}

function tickOf(match) {
  let stepped = false;
  return { frames: 1, step() { if (stepped) return; stepped = true; match.step(FDT); } };
}

function drain(g) {
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

// 幀迴圈：兩邊共用。side = 伺服器 / 重播的那一半（沒給的成員就是沒事做）。回傳飛行幀數
function* loop(match, actor, weapon, projs, side) {
  const home = () => (actor && actor.alive ? actor.muzzle() : null);
  let f = 0;
  while (side.more(f)) {
    f++;
    const tick = tickOf(match);
    yield tick;
    tick.step();
    for (let i = 0; i < projs.length; i++) {
      const p = projs[i];
      if (p.state === 'pending' && p.spawn === f) {
        p.state = 'flying';
        if (p.follow && actor && actor.alive) { const mz = actor.muzzle(); p.x = mz.x; p.y = mz.y; }   // 從射手「現在」的砲口出發
        if (weapon.boomerang) p.path = [{ x: p.x, y: p.y }];
        if (side.launched) side.launched(p);
      }
      let hit = null, caught = false;
      const x0 = p.x, y0 = p.y;   // 這一幀出發的位置（飛過去的判定用）
      if (p.state === 'returning') {
        caught = stepReturn(p, weapon.returnSpeed || 1, home(), weapon.homingSpeed);
        if (side.sweep) hit = side.sweep(p, x0, y0);   // 伺服器：回程路上碰到的敵人（陣列）；客戶端照事件播
      } else if (p.state === 'flying') hit = advanceProjectile(side.world, p, FDT);
      else { if (side.idle) side.idle(p, i, f); continue; }
      const evs = side.events(p, i, f, hit, caught, x0, y0);
      for (const ev of evs) {
        const before = side.gate(p, ev, f);
        if (!before) continue;
        transition(p, ev);
        if (side.made) side.made(p, ev, before);
      }
      if (!evs.length && p.state === 'flying' && p.path) p.path.push({ x: p.x, y: p.y });
      if (side.moved) side.moved(p);
    }
    if (side.frameDone) side.frameDone(f);
  }
  if (side.flightDone) side.flightDone(f);
  return f;
}

function validate(shot) {
  const bad = (what) => { throw new TypeError('replayVolley: ' + what); };
  if (!Array.isArray(shot.projectiles)) bad('shot.projectiles 不是陣列');
  if (!Array.isArray(shot.events)) bad('shot.events 不是陣列');
  for (const k of ['flightFrames', 'settleFrames']) {
    if (!Number.isInteger(shot[k]) || shot[k] < 0) bad(`shot.${k} 要是 ≥ 0 的整數（拿到 ${shot[k]}）`);
  }
  for (const s of shot.projectiles) if (!s || typeof s !== 'object') bad('shot.projectiles 裡有不是物件的');
  for (const ev of shot.events) if (!ev || typeof ev !== 'object') bad('shot.events 裡有不是物件的');
}

// 射手放到伺服器認定的位置（可能在空中），砲口才會一致。payload 裡沒有的欄位不動
function place(a, shot) {
  const s = shot.actor;
  if (s.x !== undefined) a.x = s.x;
  if (s.y !== undefined) a.y = s.y;
  a.vx = 0;
  a.vy = s.vy || 0;
  if (s.sx !== undefined) { a.safeX = s.sx; a.safeY = s.sy; }   // 把自己摔進水裡時兩邊才會扣一樣的血、在同一個地方重生
  if (s.hp !== undefined) a.hp = s.hp;
  if (s.vn !== undefined) a.onVine = s.vn;   // 掛在藤蔓上開火：重播時不會掉下去
  a.vineDir = 0;
  a.moveDir = 0;
  a.wantJump = false;
  a.aiming = false;
  if (shot.facing !== undefined) a.facing = shot.facing;
  a.weapon = shot.weapon;
  if (shot.angle !== undefined) a.aimAngle = shot.angle;
  if (shot.power !== undefined) a.aimPower = Math.round(shot.power);
  // 後座力（高壓水炮）：伺服器在開火的當下照初速把射手往後推，這裡擺好之後照同一組數字推一次
  const p0 = shot.projectiles[0];
  if (p0) applyRecoil(a, CONFIG.WEAPONS[shot.weapon], p0.vx, p0.vy);
}

const where = (ev) => `#${ev.p} f${ev.f} ${ev.type}`;

function* replay(match, shot, weapon, live, drift, end, look) {
  const actor = match.byId(shot.actorId) || null;
  // 效果的攻擊（例如轟炸）不帶 shot.actor：射手不用擺位置
  if (actor && shot.actor && typeof shot.actor === 'object') place(actor, shot);
  const F = shot.flightFrames, S = shot.settleFrames;
  const projs = shot.projectiles.map((s, i) => ({
    i, weapon, x: s.x, y: s.y, x0: s.x, y0: s.y, vx: s.vx, vy: s.vy, gravity: weapon.gravity, age: 0,
    spawn: s.spawn, follow: !!s.follow, state: 'pending', path: null, retIdx: 0, trail: [], spin: 0,
  }));
  // 事件照 f → p 分桶（保留陣列順序）；unreached = 還沒輪到的（飛行結束還在的就是對不上）
  const byFrame = new Map();
  for (const ev of shot.events) {
    let byP = byFrame.get(ev.f);
    if (!byP) byFrame.set(ev.f, byP = new Map());
    if (!byP.has(ev.p)) byP.set(ev.p, []);
    byP.get(ev.p).push(ev);
  }
  const unreached = new Set(shot.events);
  const mine = (f, i) => { const byP = byFrame.get(f); return (byP && byP.get(i)) || NONE; };
  const side = {
    world: null,
    more: (f) => f < F,
    launched(p) { live.push(p); if (look.spawn) look.spawn(p); },
    idle(p, i, f) {   // 還沒出發 / 已經結束的飛行物：這一幀如果有它的事件就對不上
      for (const ev of mine(f, i)) { unreached.delete(ev); drift.push(`${where(ev)} skipped: projectile ${p.state}`); }
    },
    events: (p, i, f) => mine(f, i),
    gate(p, ev) {   // 走到這個事件的當下才看狀態（出發那一幀的事件也算得到）
      unreached.delete(ev);
      if (p.state !== 'flying' && p.state !== 'returning') { drift.push(`${where(ev)} skipped: projectile ${p.state}`); return null; }
      const before = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, state: p.state };
      // 迴力鏢回程打到人：回程照原路走（兩邊一樣、不停下來），事件的 x / y 是路上碰到的那一點，不校正
      if (p.state === 'returning' && ev.type === 'pierce') return before;
      p.x = ev.x;   // 伺服器停在撞擊的子步，客戶端跑完整幀：校正到撞擊點
      p.y = ev.y;
      if (ev.type === 'bounce' || ev.type === 'pierce') { p.vx = ev.vx; p.vy = ev.vy; }
      return before;
    },
    made(p, ev, before) {
      for (const a of ev.adds || NONE) {   // 半路才出現的飛行物（見最上面的說明）：跟伺服器一樣接在最後面
        const w = CONFIG.WEAPONS[a.w];
        if (!w) { drift.push(`${where(ev)} adds: unknown weapon ${a.w}`); continue; }
        projs.push({
          i: projs.length, weapon: w, x: a.x, y: a.y, x0: a.x, y0: a.y, vx: a.vx, vy: a.vy, gravity: w.gravity, age: 0,
          spawn: ev.f + 1, follow: false, state: 'pending', path: null, retIdx: 0, trail: [], spin: 0, added: true, k: a.k,
        });
      }
      const rect = ev.type === 'explode' && ev.carve ? match.terrain.carve(ev.carve.x, ev.carve.y, ev.carve.r) : null;
      for (const s of ev.ents || NONE) {
        const e = match.byId(s.id);
        if (e) e.applyEventState(s);
        else drift.push(`${where(ev)} ents: unknown id ${s.id}`);
      }
      // 地圖機制帶在事件上的：打到巨蟒跨過門檻掉的蛇血（items）、打到蜂巢飛出來的蜜蜂（bees）
      const { items, bees } = match.mechanic.replayEvent(match, ev);
      if (look.event) look.event(ev, p, { before, rect, items, bees });
    },
    moved(p) {
      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 18) p.trail.shift();
      p.spin += 0.45;
    },
    frameDone(f) {
      let w = 0;
      for (const p of live) if (p.state !== 'done') live[w++] = p;
      live.length = w;
      if (look.frame) look.frame(live, f);
    },
    flightDone(f) {
      const left = live.length;
      live.length = 0;
      if (left) {
        drift.push(`flight ended with ${left} projectile(s) still live`);
        if (look.frame) look.frame(live, f);
      }
      for (const ev of unreached) drift.push(`${where(ev)} never reached`);
    },
  };
  yield* loop(match, actor, weapon, projs, side);
  // 沉降：剛好 S 幀（伺服器 settle 跑到站穩為止，所以第 S 幀才第一次站穩；到上限 360 的除外）
  let firstSettled = 0;
  for (let n = 1; n <= S; n++) {
    const tick = tickOf(match);
    yield tick;
    tick.step();
    if (!firstSettled && match.isSettled()) firstSettled = n;
  }
  if (S > 0 && firstSettled !== S && !(S === SETTLE_CAP && !firstSettled)) {
    end.settle = `settle: server ${S} frames, client first settled at ${firstSettled || 'never'}`;
  }
}
