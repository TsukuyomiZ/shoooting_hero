import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';
import { exactLaunch } from './cyclops.js';

// 菁英關「頑皮猴王」（森林）的猴王與香蕉皮（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。2026-11-03 使用者定的規則（數值見 config.MONKEY）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/monkey.js。這一場的狀態 match.mechState =
//   { def, perch, held, peels, seq, angry, fx }：
//   perch  = 猴王現在待在第幾根樹枝（def.perches 的索引）
//   held   = 手上接住的砲彈 [{ w: 武器 id, by: 開槍的玩家 id }]（照接住的順序，最多 MONKEY.maxHeld 顆）
//   peels  = 場上的香蕉皮 [{ id, x, y（腳底踩的那一點：地面上）}]；seq = 下一張香蕉皮的流水號
//   angry  = 血量掉到 MONKEY.angryPct 以下生氣了（接住範圍變大，之後一直是 true）
//   fx     = 這一下（一個飛行事件）剛發生、還沒附到事件上的：{ burst（手上的砲彈在他身上爆炸：[武器 id…]）, burstDmg（炸了他多少）, angry（剛生氣）}（伺服器；eventExtras 拿走）
//
// - 猴王待在樹枝頂面的中間（level.mechanic.monkey 的大小；不受重力、不會被擊退、不走動：fixed）。血量 MONKEY.hp，跟一般敵人一樣依人數、關數放大。打倒他 = 過關。
// - 接住（地圖機制的 passed：飛行物這一幀沒撞到東西）：玩家方的飛行物（武器在 MONKEY.catchable 裡）這一幀離他身體中心不到接住範圍
//   （catchRadius，生氣後 angryRadius），而且已經過了最靠近他的那一點（這一幀比上一幀離他遠，或一樣遠）、照現在的樣子飛下去第一個撞到的不是他
//   → 被接住：飛行物到此為止（事件 type 'snatch'，不爆炸、不挖地），手上多一顆（held）。手上滿了就接不了。
//   會直接打中他的照常打中（還在靠近他的時候不接；飛過去之後繞回來會打中他的也不接）
// - 打中拿著砲彈的他（玩家方的攻擊碰到他，地圖機制的 absorbHit）：大家扣完血之後，手上的砲彈一顆一顆在他身上炸開
//   （照原本的武器，攻擊者 = 打中他的人：算他的傷害、吃他的加成；只炸猴王自己），手上清空
// - 他的回合：先把手上的砲彈一顆一顆丟回給各自開槍的人（WEAPONS.monkeyThrow 換成原本武器的傷害、爆炸範圍、擊退、挖不挖地；
//   拋物線瞄他身體中心左右偏 0 ~ throwError px 的那一點；開槍的人倒下了那顆就丟掉），再出一招（weights）：
//   coconut = 椰子砸（WEAPONS.monkeyCoconut × 開場人數，打隨機一名活著的玩家，偏 0 ~ coconutError px）、
//   peel = 香蕉皮（丟在隨機一名活著的玩家左邊或右邊 peelGap px 的地上；場上已經有 maxPeels 張、或兩邊都放不下就改丟椰子），
//   最後盪到另一根樹枝（不會留在同一根）
// - 香蕉皮（地圖機制的 moved：玩家走路的那一段路踩過香蕉皮的那一點）：往走的方向被迫滑 MONKEY.slip px（Entity.slide：貼著地形走、不耗體力），
//   香蕉皮消失。可能滑下平台、滑進水坑（落水照一般規則）。
//   被爆炸（不管誰的）炸到的香蕉皮消失（地圖機制的 struck）

export const MONKEY_ID = 'monkey';

export const MONKEY_ACTION_NAMES = {
  throw: '丟回去',
  drop: '丟掉',
  coconut: '椰子砸',
  peel: '香蕉皮',
  swing: '盪樹枝',
  idle: '發呆',
};

// 這一場的狀態（match.mechState）。別張地圖當作沒有猴王
const monkeyState = (match) => (match.mechState && match.mechState.def && match.mechState.def.type === 'monkey' ? match.mechState : null);

export const monkeyOf = (match) => match.byId(MONKEY_ID);

const freshFx = () => ({ burst: [], burstDmg: 0, angry: false });

// 樹枝上站的那一點（腳底，頂面的中間）
export const perchSpot = (perch) => ({ x: Math.round((perch.x0 + perch.x1) / 2), y: perch.y });

// 建立猴王（站在 def.start 那根樹枝上），回傳這一場的狀態。hpScale = 一般敵人的血量倍率（人數 × 關數）
export function buildMonkey(match, hpScale) {
  const def = match.level.mechanic;
  const at = perchSpot(def.perches[def.start]);
  match.entities.push(new Entity({
    ...CONFIG.ENEMY, id: MONKEY_ID, name: '頑皮猴王', team: 'enemies', controller: 'ai', slot: 0, facing: -1,
    x: at.x, y: at.y, hw: def.monkey.hw, h: def.monkey.h, fixed: true,
    hp: Math.round(CONFIG.MONKEY.hp * hpScale), part: 'monkey', kind: 'monkey', weapons: ['monkeyCoconut'],
  }));
  return { def, perch: def.start, held: [], peels: [], seq: 0, angry: false, fx: freshFx() };
}

// 生氣了沒：事件帶來的旗標，或血量已經在 angryPct 以下（燃燒等不經過 hurt 的扣血也算；血量兩邊同步，客戶端照樣推得出來）
export const isAngry = (S, e) => !!S && (S.angry || (!!e && e.alive && e.hp < e.maxHp * CONFIG.MONKEY.angryPct));
// 現在的接住範圍（生氣之後變大）
export const catchRadius = (S, g) => (isAngry(S, g) ? CONFIG.MONKEY.angryRadius : CONFIG.MONKEY.catchRadius);

// 傷害照開場人數：武器的 damage（每人多少）× 開場的玩家數（含之後倒下的，同調皮妖精）
export function monkeyDamage(match, weapon) {
  return weapon.damage * Math.max(1, match.players.length);
}

// ---------- 接住 ----------

/**
 * 一顆飛行物這一幀沒撞到東西（地圖機制的 passed，只在伺服器）：該被猴王接住就回傳 { stop: true, monkeyCatch: { w, by } }（飛行物到此為止），不然 null。
 * seg = { x0, y0, x1, y1, r, weapon, ahead() }：ahead() = 照現在的樣子飛下去第一個撞到的東西（見 Match.resolvePass），只有快接住時才問
 */
export function snatch(match, owner, seg) {
  const S = monkeyState(match);
  if (!S || !owner || owner.team !== 'players') return null;
  const M = CONFIG.MONKEY;
  if (S.held.length >= M.maxHeld || !M.catchable.includes(seg.weapon)) return null;
  const g = monkeyOf(match);
  if (!g || !g.alive) return null;
  if (seg.ignore && seg.ignore.has(g)) return null;   // 這一趟已經打中（穿過）他了，例如迴力鏢去程：不接
  const R = catchRadius(S, g);
  const d1 = (seg.x1 - g.cx) * (seg.x1 - g.cx) + (seg.y1 - g.cy) * (seg.y1 - g.cy);
  if (d1 > R * R) return null;
  const d0 = (seg.x0 - g.cx) * (seg.x0 - g.cx) + (seg.y0 - g.cy) * (seg.y0 - g.cy);
  if (d1 < d0) return null;   // 還在靠近他：等飛過最靠近的那一點（會打中他的就在那之前打中了）
  const next = seg.ahead();
  if (next && next.type === 'entity' && next.entity === g) return null;   // 飛過去之後會繞回來打中他
  const rec = { w: seg.weapon, by: owner.id };
  S.held.push(rec);
  return { stop: true, monkeyCatch: rec };
}

// ---------- 被打到 ----------

// 同一下（一次 applyExplosion）只炸一次：key = 那一次的 later 陣列
const burstFor = new WeakSet();

/**
 * 爆炸 / 命中的第一步（地圖機制的 absorbHit，hit = { attacker, friendly, damages, later }）：
 * 玩家方的攻擊碰到拿著砲彈的猴王 → 大家扣完血之後，手上的砲彈在他身上炸開（burstHeld）。猴王照一般的扣血（一律回傳 false）
 */
export function hitMonkey(match, e, { attacker, friendly, later }) {
  const S = monkeyState(match);
  if (!S || e.id !== MONKEY_ID || !S.held.length) return false;
  if (!attacker || friendly || attacker.team !== 'players' || burstFor.has(later)) return false;
  burstFor.add(later);
  later.push(() => burstHeld(match, e, attacker));
  return false;
}

// 手上的砲彈一顆一顆在猴王身上炸開：照原本的武器、攻擊者 = 打中他的人（算他的傷害、吃他的加成；統計在那幾次 applyExplosion 裡就算好了），只炸猴王自己。
// 不接進外面這一下的傷害清單（統計會算兩次）：炸了多少記在 fx.burstDmg，附在事件上給畫面飄字（猴王的血量照事件的角色狀態）。吸血不算這幾下
function burstHeld(match, g, attacker) {
  const S = monkeyState(match);
  const held = S.held;
  S.held = [];
  if (!held.length) return;
  for (const h of held) {
    if (!g.alive) break;
    const W = CONFIG.WEAPONS[h.w];
    if (W) for (const d of match.applyExplosion(g.cx, g.cy, W, attacker, g, { directOnly: true })) if (d.id === g.id) S.fx.burstDmg += d.dmg;
  }
  S.fx.burst.push(...held.map(h => h.w));
}

// 猴王真的扣到血：掉到 angryPct 以下就生氣（接住範圍變大）
export function hurtMonkey(match, e) {
  const S = monkeyState(match);
  if (!S || e.id !== MONKEY_ID) return;
  if (!S.angry && e.hp < e.maxHp * CONFIG.MONKEY.angryPct) {
    S.angry = true;
    S.fx.angry = true;
  }
}

// 一個飛行事件的傷害結算完（eventExtras）：剛炸開的手上砲彈（與炸了多少）/ 剛生氣附在事件上 → { monkey: { burst?, dmg?, angry? } }；沒有 = {}
export function takeFx(match) {
  const S = monkeyState(match);
  if (!S) return {};
  const { burst, burstDmg, angry } = S.fx;
  S.fx = freshFx();
  if (!burst.length && !angry) return {};
  return { monkey: { ...(burst.length ? { burst, dmg: Math.round(burstDmg * 10) / 10 } : {}), ...(angry ? { angry: true } : {}) } };
}

// 一顆飛行物爆炸了（地圖機制的 struck；at.blast = 爆炸半徑）：炸到的香蕉皮消失 → { peelGone: [id…] }，沒有 = null
export function blastPeels(match, at) {
  const S = monkeyState(match);
  if (!S || !(at.blast > 0) || !S.peels.length) return null;
  const R = at.blast + 6;
  const gone = S.peels.filter(q => (q.x - at.x) * (q.x - at.x) + (q.y - at.y) * (q.y - at.y) <= R * R).map(q => q.id);
  if (!gone.length) return null;
  S.peels = S.peels.filter(q => !gone.includes(q.id));
  return { peelGone: gone };
}

/** 客戶端重播一個事件（replayEvent）：照伺服器附的接住、炸掉的香蕉皮、手上的砲彈炸開、生氣套到自己的狀態 */
export function applyMonkeyEvent(match, ev) {
  const S = monkeyState(match);
  if (!S || !ev) return;
  if (ev.monkeyCatch) S.held.push({ w: ev.monkeyCatch.w, by: ev.monkeyCatch.by });
  if (ev.peelGone) S.peels = S.peels.filter(q => !ev.peelGone.includes(q.id));
  const fx = ev.monkey;
  if (fx && fx.burst) S.held = [];
  if (fx && fx.angry) S.angry = true;
}

// ---------- 他的回合 ----------

// 輪到猴王：手上的砲彈丟回去、出一招（椰子 / 香蕉皮）、盪到別根樹枝。回傳 { steps, next: null }（格式同 Boss；他不預告下一招）
export function resolveMonkeyTurn(match, g) {
  const S = monkeyState(match);
  const steps = [];
  // 每一步先校正成那一步的結果（跟客戶端播完、套上 results 一樣），下一步的重播才從同一個狀態開始
  const push = (step) => {
    steps.push(step);
    const res = step.shot || step.still;
    if (res) match.applyEntities(res.results);
  };
  const alive = () => g.alive && match.players.some(e => e.alive);
  if (alive()) {
    const held = S.held;
    S.held = [];
    for (const h of held) {
      if (!alive()) break;
      const target = match.byId(h.by);
      push(target && target.alive ? throwStep(match, g, h, target) : { action: 'drop', w: h.w, by: h.by, still: stillResult(match) });
    }
    if (alive()) {
      const M = CONFIG.MONKEY;
      const canPeel = S.peels.length < M.maxPeels;
      const action = weightedPick(match.rng, [['coconut', M.weights.coconut], ['peel', canPeel ? M.weights.peel : 0]]) || 'coconut';
      push((action === 'peel' && peelStep(match, g)) || coconutStep(match, g));
    }
    if (g.alive) push(swingStep(match, g));
  }
  if (!steps.length) steps.push({ action: 'idle', still: stillResult(match) });
  const last = steps[steps.length - 1];
  const res = last.shot || last.still;
  if (res) res.results = match.entities.map(e => e.toState());
  return { steps, next: null };
}

// 從 (x0, y0) 拋到 (X, Y) 的拋物線：頂點比兩端較高的那一端再高 LOB px（最高到 LOB_CEIL），照那條拋物線的飛行時間算出剛好飛到的初速（exactLaunch）
const LOB = 90, LOB_CEIL = 40;
function lob(x0, y0, X, Y, g) {
  const top = Math.max(LOB_CEIL, Math.min(y0, Y) - LOB);
  const frames = Math.max(12, Math.round((Math.sqrt(2 * Math.max(0, y0 - top) / g) + Math.sqrt(2 * Math.max(0, Y - top) / g)) / CONFIG.FIXED_DT));
  return exactLaunch(x0, y0, X, Y, frames, g);
}

// 手的位置（丟東西的起點）：身體上半、面向的那一邊
const handOf = (g) => ({ x: g.cx + g.facing * (g.hw + 4), y: g.y - g.h * 0.7 });

// 朝 target 拋一顆 W（瞄他身體中心左右偏 0 ~ err px 的那一點，偏哪邊隨機）。回傳 { shot, aim: { x, y } }
function lobAt(match, g, W, target, err) {
  if (target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
  const off = match.rng.range(0, err) * (match.rng.chance(0.5) ? 1 : -1);
  const X = target.cx + off, Y = target.cy;
  const h = handOf(g);
  const v = lob(h.x, h.y, X, Y, W.gravity);
  const p = bossProjectile(g, W, h.x, h.y, v.vx, v.vy);
  p.ignore.add(g);
  return { shot: bossShot(match, g, W, [p], g.facing), aim: { x: r1(X), y: r1(Y) } };
}

// 丟回去：接住的那顆照原本武器的傷害、爆炸範圍、擊退、挖不挖地，拋向開槍的人（偏 0 ~ throwError）
function throwStep(match, g, h, target) {
  const orig = CONFIG.WEAPONS[h.w];
  const W = { ...CONFIG.WEAPONS.monkeyThrow, damage: orig.damage, radius: orig.radius, knockback: orig.knockback, noCarve: !!orig.noCarve };
  const { shot, aim } = lobAt(match, g, W, target, CONFIG.MONKEY.throwError);
  return { action: 'throw', w: h.w, by: h.by, targetId: target.id, aim, dmg: W.damage, facing: g.facing, cast: CONFIG.MONKEY.cast.throw, shot };
}

// 椰子砸：隨機一名活著的玩家（WEAPONS.monkeyCoconut × 開場人數，偏 0 ~ coconutError）
function coconutStep(match, g) {
  const alive = match.players.filter(e => e.alive);
  if (!alive.length) return { action: 'idle', still: stillResult(match) };
  const target = match.rng.pick(alive);
  const W = { ...CONFIG.WEAPONS.monkeyCoconut, damage: monkeyDamage(match, CONFIG.WEAPONS.monkeyCoconut) };
  const { shot, aim } = lobAt(match, g, W, target, CONFIG.MONKEY.coconutError);
  return { action: 'coconut', targetId: target.id, aim, dmg: W.damage, facing: g.facing, cast: CONFIG.MONKEY.cast.coconut, shot };
}

// 香蕉皮放在 target 左邊或右邊 peelGap 的地上：x 那一行從他腳底上面 60 px 往下找第一個站得住的地方（離水面夠遠、身體不卡進地形），
// 離別張香蕉皮至少 30 px；兩邊都放不下 = null
function peelSpot(match, target) {
  const S = monkeyState(match);
  const [g0, g1] = CONFIG.MONKEY.peelGap;
  const gap = match.rng.range(g0, g1);
  const first = match.rng.chance(0.5) ? 1 : -1;
  for (const side of [first, -first]) {
    const x = Math.round(target.x + side * gap);
    for (let y = Math.round(target.y - 60); y <= target.y + 160; y++) {
      if (!target.canStandAt(match.terrain, x, y)) continue;
      if (S.peels.some(q => Math.abs(q.x - x) < 30 && Math.abs(q.y - y) < 30)) break;
      if (match.players.some(p => p.alive && onPeel({ x, y }, p.x, p.y, p.hw))) break;   // 不丟在有人站的地方（站在上面的一動就會滑）
      return { x, y };
    }
  }
  return null;
}

// 香蕉皮：丟在隨機一名活著的玩家旁邊的地上（放不下就 null，改丟椰子）。招式帶 peel = { id, x, y }、from = 從哪裡丟（手）
function peelStep(match, g) {
  const S = monkeyState(match);
  const alive = match.players.filter(e => e.alive);
  for (const target of shuffled(match, alive)) {
    const at = peelSpot(match, target);
    if (!at) continue;
    if (target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
    const peel = { id: `peel${++S.seq}`, x: at.x, y: at.y };
    S.peels.push(peel);
    const h = handOf(g);
    return { action: 'peel', targetId: target.id, peel, from: { x: r1(h.x), y: r1(h.y) }, facing: g.facing, cast: CONFIG.MONKEY.cast.peel, still: stillResult(match) };
  }
  return null;
}

// 盪樹枝：換到另一根（隨機），轉向最近的玩家
function swingStep(match, g) {
  const S = monkeyState(match);
  const perches = S.def.perches;
  const others = perches.map((_, i) => i).filter(i => i !== S.perch);
  const to = others.length ? match.rng.pick(others) : S.perch;
  const from = { x: g.x, y: g.y };
  const at = perchSpot(perches[to]);
  S.perch = to;
  Object.assign(g, { x: at.x, y: at.y, vx: 0, vy: 0 });
  const near = nearestPlayerAt(match, g.cx, g.cy);
  if (near && near.x !== g.x) g.facing = near.x > g.x ? 1 : -1;
  return { action: 'swing', perch: to, from, to: { x: g.x, y: g.y }, facing: g.facing, cast: CONFIG.MONKEY.cast.swing, still: stillResult(match) };
}

function shuffled(match, list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = match.rng.int(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- 香蕉皮 ----------

// 腳底在 (x, y) 的人踩不踩得到香蕉皮 q：身體寬度蓋住它、腳底跟它一樣高（差 4 px 內：跳過去的不算）
const onPeel = (q, x, y, hw) => Math.abs(x - q.x) <= hw && Math.abs(y - q.y) <= 4;

/**
 * 玩家走路（位置回報 / AI 代打走路 / 自己畫面的本地預判）從 (x0, y0) 走到 (x1, y1)（含起點）：路上踩到香蕉皮 → 往走的方向滑 slip px
 * （見最上面的說明），香蕉皮消失。回傳 { type: 'peel', id, peel, dir, x, y }（裁判廣播成 pickup），沒踩到 = null。
 * 原地不動 / 直直落下（x 沒變）不算；香蕉皮不會丟在有人站的地方（peelSpot），所以站在上面的只有自己走上去 / 被炸過去的，一走就滑。
 * 客戶端每一幀、伺服器每一份回報判的線段不一樣長，起點也算進來兩邊才會判到同一張
 */
export function touchPeel(match, e, x0, y0, x1, y1) {
  const S = monkeyState(match);
  if (!S || !S.peels.length || !e.isPlayer || !e.alive || x0 === x1) return null;
  const n = Math.max(1, Math.ceil(Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) / 4));
  for (let k = 0; k <= n; k++) {   // 從起點算起：站在上面（被炸過去、跳上去的）一走就滑
    const px = x0 + (x1 - x0) * k / n, py = y0 + (y1 - y0) * k / n;
    const q = S.peels.find(t => onPeel(t, px, py, e.hw));
    if (!q) continue;
    const dir = x1 > x0 ? 1 : -1;
    slipOn(match, e, q, dir);
    return { type: 'peel', id: e.id, peel: q.id, dir, x: q.x, y: q.y };
  }
  return null;
}

// 踩到香蕉皮 q：它消失，e 往 dir 滑出去（地上的滑行，見最上面的說明）
function slipOn(match, e, q, dir) {
  const S = monkeyState(match);
  S.peels = S.peels.filter(t => t !== q);
  e.slide = CONFIG.MONKEY.slip;
  e.slideDir = dir;
}

/**
 * 客戶端收到伺服器的 pickup（type 'peel'）：香蕉皮還在的話拿掉；slide = 要不要也讓 e 滑出去（AI 代打走路的重播、自己的本地預判沒判到的時候；
 * 別人自己走的照他的位置回報，不用滑）。回傳 true = 這張香蕉皮剛剛還在（第一次知道他踩到）
 */
export function applyPeelPickup(match, e, msg, slide) {
  const S = monkeyState(match);
  if (!S) return false;
  const q = S.peels.find(t => t.id === msg.peel);
  if (!q) return false;
  if (slide) slipOn(match, e, q, msg.dir);
  else S.peels = S.peels.filter(t => t !== q);
  return true;
}

// ---------- 快照 ----------

// 待在哪根樹枝、手上的砲彈、場上的香蕉皮、生氣了沒（包在 monkey 一個欄位裡）
export function monkeySnapshot(match) {
  const S = match.mechState;
  return {
    monkey: {
      perch: S.perch, angry: S.angry, seq: S.seq,
      held: S.held.map(h => ({ w: h.w, by: h.by })),
      peels: S.peels.map(q => ({ id: q.id, x: q.x, y: q.y })),
    },
  };
}

// 套用快照（地形之後、角色狀態之前）。只帶一部分欄位（{ items }）→ 不動
export function restoreMonkey(match, s) {
  const S = monkeyState(match);
  const P = s && s.monkey;
  if (!S || !P) return;
  Object.assign(S, {
    perch: Number.isInteger(P.perch) ? P.perch : S.perch,
    angry: !!P.angry,
    seq: Number.isInteger(P.seq) ? P.seq : S.seq,
    held: (P.held || []).filter(h => h && CONFIG.WEAPONS[h.w]).map(h => ({ w: h.w, by: h.by })),
    peels: (P.peels || []).filter(q => q && typeof q.id === 'string').map(q => ({ id: q.id, x: q.x, y: q.y })),
  });
}

const r1 = (v) => Math.round(v * 10) / 10;
