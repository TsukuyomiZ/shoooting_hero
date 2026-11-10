import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// 菁英關「大樹遊俠」（森林）的遊俠與藤蔓陷阱（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。2026-11-02 使用者定的招式與數值（見 config.RANGER）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/ranger.js。這一場的狀態 match.mechState =
//   { def, next, perch, trapped, spawned, seq, lastHitBy, clock, pending }：
//   next      = 預定的下一招 { action: 'pierce' | 'rain' | 'trap', targetId（貫穿箭標記的人）}（開場一次、之後每回合出完招再抽）
//   perch     = 她現在站在第幾根樹枝（def.perches 的索引）
//   trapped   = 被藤蔓陷阱困住的玩家 { [playerId]: { count（這個回合連打了幾下）, last（上一下是哪一邊 -1 / 1，0 = 還沒按）,
//               at / st（伺服器：從什麼時刻（裁判時鐘 ms）、多少體力開始流失）} }
//   spawned   = 放過的陷阱 [{ id, x, y, hp }]（重連照它重建；破掉 / 觸發的照角色的狀態是倒下的）；seq = 陷阱的流水號
//   lastHitBy = 上一次打到她的玩家（林間穿梭：跳到離他最遠的樹枝；換完就清掉。只有伺服器在用）
//   clock     = 上次推進到裁判時鐘的幾 ms（回合中被困住的人從這時候開始算體力流失）；pending = 剛踩到陷阱、還沒扣血的人（hazardStep 扣，伺服器）
//
// - 遊俠站在樹枝上（level.mechanic.ranger 的大小、perches = 三根樹枝的頂面；不受重力、不會被擊退：fixed）。血量 RANGER.hp，跟一般敵人一樣依人數、關數放大。
//   打倒她 = 過關（陷阱不算敵人：不會輪到、打破不算擊殺、不擋過關）。
// - 每回合出完招之後換到另一根樹枝（林間穿梭，hop）：上一次打到她的人還活著就跳到離他最遠的那根，不然隨機挑另一根。
//   出完招才換（不是先換再射）：玩家回合裡她站的地方就是她下一次出招的地方，貫穿箭的預警線才準
// - 她的招式（伺服器先抽好下一招，玩家回合畫面上標出來；權重 RANGER.weights：貫穿箭 / 箭雨各半）：
//     貫穿箭（pierce）：一抽到就隨機標記一名玩家；輪到她時從弓上直直射向他（那人倒下了就改隨機一人），穿過地形，一定射得到他；
//                       同一條線上的人照箭飛過的順序都會被射穿，每多穿一人傷害再減半（WEAPONS.rangerArrow 的 pierceFalloff），最多 maxPierce 人
//     箭雨（rain）：用了馬上落下（不預告）：被困住的玩家優先（隨機挑一個），沒有就隨機一名玩家，以他為中心左右合計 rainWidth px 的箭從天上落下，
//                   一人最多中一支（WEAPONS.rangerRain，附加流血），碰到地面就停
// - 藤蔓陷阱（trap，2026-11-09 使用者：改成插話招）：3 人以上活著時在插話行動放（Match.interjectBefore，不算她的回合、不換樹枝）；
//   活著的玩家不到 3 人（不會插話）就在她自己的回合出完招之後順便放。在地面上隨機的地方放 trap.perCast 個
//   （場上最多 trap.max 個，滿了就不放、也不插話；離其他陷阱、玩家至少 trap.gap px）
// - 藤蔓陷阱（角色 kind 'vineTrap'，敵方的東西：敵人的攻擊穿過去）：觸發前玩家打到一下扣 1（不管什麼武器、直擊或波及），扣光就破；
//   玩家自己走路踩進去（位置回報 / AI 代打的每一步，見 touchTrap；跳過去、站著不動、被擊退停在上面再走開都不算）就觸發：陷阱消失、他被困住（Entity.held：走不動、跳不起來、
//   不會被擊退，還能開火），踩到的那一下受傷（WEAPONS.rangerTrap，在下一個 hazardStep 扣：踩死的話裁判才收得了這回合）。
//   陷阱有重力（不 fixed）：底下的地被炸掉就跟著落下去（不會浮在半空中踩不到），掉進水裡就沒了
// - 被困住的人只能在自己的回合連打 A / D（左右交替，同一邊連按不算）trap.need 下掙脫（客戶端的 struggle，見 struggle）；
//   從他的回合開始（回合中才被困住的從被困住起）體力每秒流失 trap.drain，流光了就掙脫不了（等下一回合，連打數重算）。其他方式都放不了他。
//   斷線由 AI 代打的人不會連打（一直困著，照樣開火）
// - 傷害照開場人數（rangerDamage：武器的 damage × 開場玩家數，含之後倒下的），再吃一般的敵人傷害倍率

export const RANGER_ID = 'ranger';

export const RANGER_ACTION_NAMES = {
  hop: '林間穿梭',
  pierce: '貫穿箭',
  rain: '箭雨',
  trap: '藤蔓陷阱',
  idle: '戒備',
};

const TRAP_FEET = 8;   // 腳底跟陷阱的底差不到這麼多才算踩進去（跳過去不算）

// 這一場的狀態（match.mechState）。別張地圖當作沒有遊俠
const rangerState = (match) => (match.mechState && match.mechState.def && match.mechState.def.type === 'ranger' ? match.mechState : null);

export const isTrap = (e) => !!e && e.kind === 'vineTrap';
const rangerOf = (match) => match.byId(RANGER_ID);

// 建立遊俠（站在 def.start 那根樹枝的中間；沒寫 = 第二根），回傳這一場的狀態。hpScale = 一般敵人的血量倍率（人數 × 關數）
export function buildRanger(match, hpScale) {
  const def = match.level.mechanic;
  const r = def.ranger;
  const perch = Number.isInteger(def.start) ? def.start : 1;
  const spot = perchMid(def.perches[perch]);
  match.entities.push(new Entity({
    ...CONFIG.ENEMY, id: RANGER_ID, name: '大樹遊俠', team: 'enemies', controller: 'ai', slot: 0, facing: -1,
    x: spot.x, y: spot.y, hw: r.hw, h: r.h, hp: Math.round(CONFIG.RANGER.hp * hpScale),
    fixed: true, part: 'ranger', weapons: ['rangerArrow'],
  }));
  return { def, next: null, perch, trapped: {}, spawned: [], seq: 0, lastHitBy: null, clock: 0, pending: [] };
}

// 樹枝上站得到的左右範圍（離尖端 perchPad.left、離根部（樹幹）perchPad.right；根部在左邊的樹枝反過來）
export function perchRange(p) {
  const pad = CONFIG.RANGER.perchPad;
  const [a, b] = p.root === 'left' ? [pad.right, pad.left] : [pad.left, pad.right];
  const x0 = p.x0 + a, x1 = p.x1 - b;
  return x1 > x0 ? { x0, x1 } : { x0: (p.x0 + p.x1) / 2, x1: (p.x0 + p.x1) / 2 };
}
const perchMid = (p) => { const r = perchRange(p); return { x: Math.round((r.x0 + r.x1) / 2), y: p.y }; };

// 傷害照開場人數：武器的 damage（每人多少）× 開場的玩家數（含之後倒下的，同天狗的風彈）
export function rangerDamage(match, weapon) {
  return weapon.damage * Math.max(1, match.players.length);
}

// 場上還在的陷阱
export const liveTraps = (match) => match.entities.filter(e => isTrap(e) && e.alive);

// 抽下一招（開場、每回合出完招之後）：貫穿箭 / 箭雨（藤蔓陷阱 2026-11-09 改成插話招，不在這裡抽）。貫穿箭：馬上隨機標記一名活著的玩家（targetId）
export function planRangerNext(match) {
  const S = rangerState(match);
  if (!S) return null;
  const R = CONFIG.RANGER;
  const action = weightedPick(match.rng, [['pierce', R.weights.pierce], ['rain', R.weights.rain]]) || 'pierce';
  S.next = { action };
  if (action === 'pierce') {
    const alive = match.players.filter(e => e.alive);
    if (alive.length) S.next.targetId = match.rng.pick(alive).id;
    // 一決定就轉向被標記的人、擺出拉弓的架勢（畫面照 next 畫；2026-11-03 使用者）：預警線從弓上拉出去才對得上
    const g = rangerOf(match);
    const t = S.next.targetId ? match.byId(S.next.targetId) : null;
    if (g && t && t.x !== g.x) g.facing = t.x > g.x ? 1 : -1;
  }
  return S.next;
}

// 貫穿箭要射誰：標記的那個人；他倒下了（或沒標記）就改隨機一名活著的玩家。沒有人 = null
export function pierceTarget(match, plan) {
  const id = plan && plan.targetId;
  const marked = id ? match.players.find(e => e.id === id && e.alive) : null;
  if (marked) return marked;
  const alive = match.players.filter(e => e.alive);
  return alive.length ? match.rng.pick(alive) : null;
}

// 弓的位置（箭從這裡出發；畫面也照它畫）
export function bowPoint(g) {
  return { x: g.x + g.facing * (g.hw + 4), y: g.y - g.h * 0.62 };
}

// 貫穿箭的路線（畫面的預警線、出招都照它）：從弓穿過目標身體的中間，一直延伸到地圖邊 / 水面
export function arrowLine(match, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len, uy = dy / len;
  const maxX = match.terrain.maxX;
  let t = Infinity;
  if (ux > 0) t = Math.min(t, (maxX - from.x) / ux);
  if (ux < 0) t = Math.min(t, -from.x / ux);
  if (uy > 0) t = Math.min(t, (CONFIG.WATER_LEVEL - from.y) / uy);
  if (uy < 0) t = Math.min(t, -from.y / uy);
  t = Math.max(len, Number.isFinite(t) ? t : len);
  return { x0: from.x, y0: from.y, x1: from.x + ux * t, y1: from.y + uy * t };
}

// 會不會有插話行動（活著的玩家超過 INTERJECT.after 位）：不會的話藤蔓陷阱在她自己的回合順便放
const interjects = (match) => match.players.filter(e => e.alive).length > CONFIG.INTERJECT.after;

// 輪到遊俠：出預定的那一招（貫穿箭 / 箭雨）並直接結算好；不會插話的時候（活著的玩家不到 3 人）順便放藤蔓陷阱；再換樹枝，再抽下一招。
// 回傳 { steps: [招式, (陷阱,) 換樹枝], next }（格式同 Boss）
export function resolveRangerTurn(match, g) {
  const S = rangerState(match);
  const steps = [];
  if (g.alive && match.players.some(e => e.alive)) {
    const plan = (S && S.next) || planRangerNext(match) || { action: 'pierce' };
    const main = plan.action === 'rain' ? rainStep(match, g) : pierceStep(match, g, plan);
    steps.push(main);
    // 先校正成這一招的結果（跟客戶端播完這一招、套上 results 一樣），換樹枝的重播才從同一個狀態開始
    const res = main.shot || main.still;
    if (res) match.applyEntities(res.results);
    // 2026-11-09 使用者：藤蔓陷阱改成插話招；不會插話的時候（1 ~ 2 人）回合結束順便放
    if (g.alive && match.players.some(e => e.alive) && !interjects(match)) {
      const trap = trapStep(match, g);
      if (trap) steps.push(trap);
    }
    if (g.alive && match.players.some(e => e.alive)) steps.push(hopStep(match, g));
  }
  if (!steps.length) steps.push({ action: 'idle', still: stillResult(match) });
  planRangerNext(match);
  syncTraps(match);
  const last = steps[steps.length - 1];
  const res = last.shot || last.still;
  if (res) res.results = match.entities.map(e => e.toState());
  return { steps, next: S && S.next ? { ...S.next } : null };
}

// 插話行動（3 人以上活著，連續 2 位玩家的回合之後）：放藤蔓陷阱（不換樹枝、不改預定的下一招）。場上滿了 / 放不下 = null（不插話）
export function resolveRangerInterject(match, g) {
  const S = rangerState(match);
  if (!S || !g.alive || !match.players.some(e => e.alive)) return null;
  const step = trapStep(match, g);
  if (!step) return null;
  syncTraps(match);
  return { steps: [step], next: S.next ? { ...S.next } : null };
}

// 林間穿梭：換到另一根樹枝（上一次打到她的人還活著 → 離他最遠的那根；不然隨機），樹枝上站哪裡隨機（match.rng）。
// from / to = 樹枝的索引，x0 / y0 = 從哪裡跳過去（畫面照它畫跳躍的弧線）
function hopStep(match, g) {
  const S = rangerState(match);
  const perches = S.def.perches;
  const from = S.perch;
  const others = perches.map((_, i) => i).filter(i => i !== from);
  const foe = S.lastHitBy ? match.players.find(e => e.id === S.lastHitBy && e.alive) : null;
  let to = others[0];
  if (foe) {
    let best = -1;
    for (const i of others) {
      const m = perchMid(perches[i]);
      const d = (m.x - foe.cx) * (m.x - foe.cx) + (m.y - foe.cy) * (m.y - foe.cy);
      if (d > best) { best = d; to = i; }
    }
  } else if (others.length) {
    to = match.rng.pick(others);
  }
  S.lastHitBy = null;
  const range = perchRange(perches[to]);
  const x0 = g.x, y0 = g.y;
  g.x = Math.round(range.x0 + match.rng.float() * (range.x1 - range.x0));
  g.y = perches[to].y;
  g.vx = 0;
  g.vy = 0;
  S.perch = to;
  const near = nearestPlayerAt(match, g.cx, g.cy);
  if (near && near.x !== g.x) g.facing = near.x > g.x ? 1 : -1;
  return {
    action: 'hop', from, to, x0, y0, x: g.x, y: g.y, facing: g.facing, ...(foe ? { away: foe.id } : {}),
    cast: CONFIG.RANGER.cast.hop, still: stillResult(match),
  };
}

// 貫穿箭：從弓直直射向目標（穿過地形，一定射得到他），路線上的人照順序都會被射穿（傷害逐人減半、最多 maxPierce 人，見 Match.resolveHit）。
// targetIds = 照順序被射到的人（紀錄、畫面用）
function pierceStep(match, g, plan) {
  const target = pierceTarget(match, plan);
  if (!target) return { action: 'idle', still: stillResult(match) };
  if (target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
  const W = { ...CONFIG.WEAPONS.rangerArrow, damage: rangerDamage(match, CONFIG.WEAPONS.rangerArrow) };
  const bow = bowPoint(g);
  const L = arrowLine(match, bow, { x: target.cx, y: target.cy });
  const len = Math.hypot(L.x1 - L.x0, L.y1 - L.y0) || 1;
  const p = bossProjectile(g, W, L.x0, L.y0, (L.x1 - L.x0) / len * W.speed, (L.y1 - L.y0) / len * W.speed);
  p.ignore.add(g);
  const shot = bossShot(match, g, W, [p], g.facing);
  const hits = shot.events.filter(ev => ev.p === 0 && ev.target && (ev.type === 'pierce' || ev.type === 'explode' || ev.type === 'entity')).map(ev => ev.target);
  return {
    action: 'pierce', targetId: target.id, targetIds: hits, dmg: W.damage, line: [r1(L.x0), r1(L.y0), r1(L.x1), r1(L.y1)],
    facing: g.facing, cast: CONFIG.RANGER.cast.pierce, shot,
  };
}

// 箭雨落在誰身上：被困住的玩家優先（隨機挑一個），沒有就隨機一名活著的玩家。沒有人 = null
export function rainTarget(match) {
  const S = rangerState(match);
  const alive = match.players.filter(e => e.alive);
  const held = S ? alive.filter(e => S.trapped[e.id]) : [];
  const pool = held.length ? held : alive;
  return pool.length ? match.rng.pick(pool) : null;
}

const RAIN_GAP = 10;   // 箭雨每支箭左右隔多遠（判定半徑 5：一個人站在範圍裡一定碰得到）

// 箭雨落下的範圍（以 x 為中心、左右合計 rainWidth）：每支箭的 x（畫面的範圍提示也照它）
export function rainXs(x) {
  const w = CONFIG.RANGER.rainWidth;
  const n = Math.max(1, Math.floor(w / RAIN_GAP) + 1);
  return Array.from({ length: n }, (_, k) => r1(x - w / 2 + k * (w / Math.max(1, n - 1))));
}

// 箭雨：從畫面頂端外面直直落下（一支接一支、順序打散），同一陣共用「打過誰」：一人最多中一支（附加流血），碰到地面就停
function rainStep(match, g) {
  const target = rainTarget(match);
  if (!target) return { action: 'idle', still: stillResult(match) };
  if (target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
  const W = { ...CONFIG.WEAPONS.rangerRain, damage: rangerDamage(match, CONFIG.WEAPONS.rangerRain) };
  const xs = rainXs(target.x);
  const hitOnce = new Set([g]);
  const projs = xs.map((x, k) => {
    const p = bossProjectile(g, W, x, -40, 0, W.speed);
    p.ignore = hitOnce;
    p.spawn = 1 + ((k * 7) % xs.length) * 2;
    return p;
  });
  return {
    action: 'rain', targetId: target.id, x: r1(target.x), held: !!(rangerState(match) && rangerState(match).trapped[target.id]),
    dmg: W.damage, facing: g.facing, cast: CONFIG.RANGER.cast.rain, shot: bossShot(match, g, W, projs, g.facing),
  };
}

// 藤蔓陷阱：在地面上隨機的地方放 perCast 個（場上最多 max 個）。spawns = 放下的陷阱（客戶端照它建出來）、xs = 放在哪（紀錄用）。
// 一個都放不下（滿了、找不到地方）= null
function trapStep(match, g) {
  const S = rangerState(match);
  const T = CONFIG.RANGER.trap;
  const n = Math.min(T.perCast, T.max - liveTraps(match).length);
  const spawns = [];
  for (let k = 0; k < n; k++) {
    const spot = trapSpot(match);
    if (!spot) break;
    const spec = { id: `vine${++S.seq}`, x: spot.x, y: spot.y, hp: T.hp };
    spawnTrap(match, spec);
    spawns.push(spec);
  }
  if (!spawns.length) return null;
  return { action: 'trap', spawns, xs: spawns.map(s => s.x), facing: g.facing, cast: CONFIG.RANGER.cast.trap, still: stillResult(match) };
}

// 陷阱放得下的地方：左右隨機一個 x（match.rng），放在那一行最上面的實心地面上（可穿透的樹枝不算；被炸穿到水面的地方不放），
// 離場上的陷阱、活著的玩家至少 trap.gap px。試 30 次都放不下 = null
function trapSpot(match) {
  const T = CONFIG.RANGER.trap;
  const t = match.terrain;
  const traps = liveTraps(match);
  for (let tries = 0; tries < 30; tries++) {
    const x = Math.round(match.rng.range(T.hw + 10, t.maxX - T.hw - 10));
    let y = null;
    for (let yy = 0; yy < CONFIG.WATER_LEVEL - CONFIG.WATER.safeMargin; yy++) if (t.isSolid(x, yy)) { y = yy; break; }
    if (y === null) continue;
    if (traps.some(q => Math.abs(q.x - x) < T.gap && Math.abs(q.y - y) < 60)) continue;
    if (match.players.some(p => p.alive && Math.abs(p.x - x) < T.gap && Math.abs(p.y - y) < 60)) continue;
    return { x, y };
  }
  return null;
}

// 建出一個陷阱（伺服器放陷阱、客戶端播動畫、重連重建都用這個，雙方的角色一模一樣）：敵方的東西（敵人的攻擊穿過去），
// 有重力（底下的地被炸掉就落下去）、不會被擊退（absorbHit 接走）、不會輪到它、不擋過關、打破不算擊殺
export function spawnTrap(match, spec) {
  const T = CONFIG.RANGER.trap;
  const e = new Entity({
    ...CONFIG.ENEMY, id: spec.id, name: '藤蔓陷阱', team: 'enemies', controller: 'ai', slot: 0, kind: 'vineTrap',
    x: spec.x, y: spec.y, hw: T.hw, h: T.h, hp: spec.hp, noTurn: true, optional: true, allyPass: true, noKill: true,
  });
  e.onGround = true;
  match.entities.push(e);
  const S = rangerState(match);
  if (S && !S.spawned.some(s => s.id === spec.id)) S.spawned.push({ ...spec });
  return e;
}

/**
 * 陷阱被打到（地圖機制的 absorbHit，hit = { attacker, friendly, damages, later }）：玩家方不管什麼武器、直擊還是波及都只扣 1，
 * 不燒、不擊退；敵人的攻擊（遊俠自己的）碰不到。大家都扣完血才扣（later，同蛛卵）。回傳 true = 這是陷阱（由這裡處理）
 */
export function hitTrap(match, e, { attacker, friendly, damages, later }) {
  if (!isTrap(e)) return false;
  if (!attacker || friendly) return true;
  const entry = { id: e.id, dmg: 0, friendly };
  damages.push(entry);
  later.push(() => { entry.dmg = e.takeDamage(1); });
  return true;
}

// 腳底在 (x, y) 的人（半寬 hw）有沒有踩進陷阱 q：腳底跟陷阱的底差不到 TRAP_FEET、身體跟陷阱左右重疊
function onTrap(q, x, y, hw) {
  return Math.abs(y - q.y) <= TRAP_FEET && Math.abs(x - q.x) < q.hw + hw - 2;
}

// 陷阱 q 困住玩家 p：陷阱消失（觸發了，之後打不到）、記在 trapped（體力從 at（裁判時鐘 ms，客戶端沒有）、他現在的體力開始流失）
function trigger(match, q, p, at) {
  const S = rangerState(match);
  if (q.alive) q.die('trigger');
  if (!S.trapped[p.id]) S.trapped[p.id] = { count: 0, last: 0, at, st: p.stamina, spent: false };
  p.moveDir = 0;
  p.wantJump = false;
  syncTraps(match);
}

/**
 * 玩家 e 從 (x0, y0) 走到 (x1, y1)（位置回報之間的路線 / 本地每一幀 / AI 代打的每一幀，每 4px 檢查一次，終點一定檢查）：踩進陷阱就被困住。
 * 要真的左右走動才算（站著不動、原地開火不算）；出發點就已經站在上面的陷阱（被擊退、地被炸掉落在上面）不算：走開不會觸發。
 * 回傳 fx { type: 'vine', id, trap, x, y }（裁判廣播成 pickup），沒碰到 / 已經被困住了 = null。扣血不在這裡（見 hazardStep）
 */
export function touchTrap(match, e, x0, y0, x1, y1) {
  const S = rangerState(match);
  if (!S || e.team !== 'players' || !e.alive || S.trapped[e.id] || x0 === x1) return null;
  const traps = liveTraps(match).filter(q => !onTrap(q, x0, y0, e.hw));
  if (!traps.length) return null;
  const n = Math.max(1, Math.ceil(Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) / 4));
  for (let k = 1; k <= n; k++) {
    const px = x0 + (x1 - x0) * k / n, py = y0 + (y1 - y0) * k / n;
    const q = traps.find(t => onTrap(t, px, py, e.hw));
    if (q) {
      trigger(match, q, e, S.clock);
      return { type: 'vine', id: e.id, trap: q.id, x: q.x, y: q.y };
    }
  }
  return null;
}

/** 踩到陷阱（伺服器廣播的 pickup / AI 代打的 pickups）：客戶端照著困住、陷阱消失 */
export function applyTrapPickup(match, msg) {
  const S = rangerState(match);
  const p = match.byId(msg.id), q = match.byId(msg.trap);
  if (!S || !p || !p.alive) return;
  if (q) trigger(match, q, p, null);
  else if (!S.trapped[p.id]) { S.trapped[p.id] = { count: 0, last: 0, at: null, st: p.stamina }; syncTraps(match); }
}

/**
 * 被困住的人跟場面對齊：倒下了 → 放開；被困住的人走不動（Entity.held）、自己的回合體力每秒流失（Entity.staminaDrain，客戶端照它扣）。
 * 伺服器在每一波結算完（cascade）、踩到陷阱、掙脫之後，客戶端在畫面每一步與快照之後都叫，兩邊照同一個條件各自推
 */
export function syncTraps(match) {
  const S = rangerState(match);
  if (!S) return;
  for (const pid of Object.keys(S.trapped)) {
    const p = match.byId(pid);
    if (!p || !p.alive) delete S.trapped[pid];
  }
  const drain = CONFIG.RANGER.trap.drain;
  for (const p of match.players) {
    const held = !!S.trapped[p.id];
    p.held = held;
    p.staminaDrain = held ? drain : 0;
  }
}

// ---------- 玩家回合（地圖機制的 hazardStart / hazardStep，裁判呼叫）：踩到陷阱的扣血、被困住的人開始流失體力 ----------

// 玩家 e 的回合開始（now = 裁判的時鐘 ms）：被困住的話連打數重算、體力從現在（回滿的體力）開始流失；別人的不流失（at = null）。
// 遊俠還活著的話回傳 { kind: 'ranger', held（現在被困住的人：客戶端照這份對齊，本地先困住、伺服器沒收到的會放開）, trapped（他被困住了才有）}
// （裁判每隔一小段時間叫 hazardStep：回合中踩到陷阱的扣血、被困住的人體力流失），不然 null
export function startTurn(match, e, now) {
  const S = rangerState(match);
  if (!S) return null;
  S.clock = now;
  for (const r of Object.values(S.trapped)) { r.at = null; r.spent = false; }
  if (!e || e.team !== 'players' || !e.alive) return null;
  const g = rangerOf(match);
  if (!g || !g.alive) return null;
  const rec = S.trapped[e.id];
  if (rec) Object.assign(rec, { count: 0, last: 0, at: now, st: e.stamina });
  return { kind: 'ranger', held: Object.keys(S.trapped), ...(rec ? { trapped: e.id } : {}) };
}

// 被困住的人到 now 為止還剩多少體力：從 at 起每秒 drain（多給 grace 秒：他的畫面晚一點才開始），只往下修（跟位置回報一樣）。
// 不是他的回合（at = null）就不扣。回傳剩下的體力
function drainTo(rec, e, now) {
  if (!Number.isFinite(rec.at)) return e.stamina;
  const T = CONFIG.RANGER.trap;
  const secs = Math.max(0, (now - rec.at) / 1000 - T.grace);
  e.stamina = Math.max(0, Math.min(e.stamina, rec.st - T.drain * secs));
  return e.stamina;
}

// 推進到 now：剛踩到陷阱的人扣血（WEAPONS.rangerTrap × 開場人數，再吃敵人倍率；遊俠已經倒下就不扣）、被困住的人體力流失
// （伺服器上的體力跟著扣：快照、飛鏢射完接著的回合都帶得到；流光的那一刻告訴客戶端，他的畫面卡頓扣得比較慢也會對上）。
// 回傳 { kind, damages, done, notify, trapIds（這一次扣血的人）, spent（這一次體力流光的人）}
export function stepTurn(match, now) {
  const S = rangerState(match);
  if (!S) return null;
  S.clock = now;
  const g = rangerOf(match);
  const damages = [];
  const ids = [];
  const spent = [];
  for (const [pid, rec] of Object.entries(S.trapped)) {
    const p = match.byId(pid);
    if (!p || !p.alive || !Number.isFinite(rec.at)) continue;
    if (drainTo(rec, p, now) <= 0 && !rec.spent) { rec.spent = true; spent.push(pid); }
  }
  if (S.pending.length && g && g.alive) {
    const W = { ...CONFIG.WEAPONS.rangerTrap, damage: rangerDamage(match, CONFIG.WEAPONS.rangerTrap) };
    for (const id of S.pending) {
      const e = match.byId(id);
      if (!e || !e.alive) continue;
      damages.push(...match.applyExplosion(e.x, e.cy, W, g, e, { directOnly: true }));
      ids.push(id);
    }
  }
  S.pending = [];
  return {
    kind: 'ranger', damages, done: !g || !g.alive, notify: damages.length > 0 || spent.length > 0,
    ...(ids.length ? { trapIds: ids } : {}), ...(spent.length ? { spent } : {}),
  };
}

/**
 * 被困住的人掙扎一下（地圖機制的 struggle，裁判收到客戶端的 struggle 呼叫；dir = -1 / 1，now = 裁判的時鐘 ms）：
 * 體力照「從 at 起每秒 drain」算（drainTo），流光了就不算；同一邊連按不算；算數的第 need 下掙脫。回傳 { ok, reason, count, need, freed }；沒被困住 = null
 */
export function struggle(match, e, dir, now) {
  const S = rangerState(match);
  const rec = S && S.trapped[e.id];
  if (!rec) return null;
  const T = CONFIG.RANGER.trap;
  if (!Number.isFinite(rec.at)) { rec.at = now; rec.st = e.stamina; }
  drainTo(rec, e, now);
  const base = { count: rec.count, need: T.need };
  if (e.stamina <= 0) return { ok: false, reason: 'noStamina', ...base };
  if (dir === rec.last) return { ok: false, reason: 'sameDir', ...base };
  rec.last = dir;
  rec.count++;
  if (rec.count < T.need) return { ok: true, count: rec.count, need: T.need };
  delete S.trapped[e.id];
  syncTraps(match);
  return { ok: true, count: T.need, need: T.need, freed: true };
}

/**
 * 客戶端：玩家的回合開始時照伺服器的名單（held = 現在被困住的人）對齊：本地先困住、伺服器卻沒收到的（例如回合剛結束才踩到）放開，
 * 伺服器有、這邊沒有的補上
 */
export function alignTrapped(match, held) {
  const S = rangerState(match);
  if (!S || !Array.isArray(held)) return;
  for (const pid of Object.keys(S.trapped)) if (!held.includes(pid)) delete S.trapped[pid];
  for (const pid of held) if (typeof pid === 'string' && !S.trapped[pid]) S.trapped[pid] = { count: 0, last: 0, at: null, st: null };
  syncTraps(match);
}

/** 客戶端收到伺服器的 struggle：連打數照伺服器的，掙脫了就放開 */
export function applyStruggle(match, msg) {
  const S = rangerState(match);
  if (!S) return;
  const rec = S.trapped[msg.id];
  if (msg.freed) delete S.trapped[msg.id];
  else if (rec && Number.isFinite(msg.count)) rec.count = msg.count;
  syncTraps(match);
}

// ---------- 快照 ----------

// 預定的下一招（rangerNext）+ 站在哪根樹枝、被困住的人（連打了幾下）、放過的陷阱（包在 ranger 一個欄位裡）
export function rangerSnapshot(match) {
  const S = match.mechState;
  const trapped = {};
  for (const [pid, r] of Object.entries(S.trapped)) trapped[pid] = { count: r.count, last: r.last };
  return {
    rangerNext: S.next ? { ...S.next } : null,
    ranger: { perch: S.perch, trapped, spawned: S.spawned.map(s => ({ ...s })), seq: S.seq },
  };
}

// 套用快照（地形之後、角色狀態之前）：先建出快照裡有、這邊還沒有的陷阱，再換成快照的狀態。只帶一部分欄位（{ items }）→ 不動
export function restoreRanger(match, s) {
  const S = rangerState(match);
  if (!S || !s) return;
  if (s.rangerNext !== undefined) S.next = s.rangerNext ? { ...s.rangerNext } : null;
  const P = s.ranger;
  if (!P) return;
  for (const spec of P.spawned || []) if (!match.byId(spec.id)) spawnTrap(match, spec);
  const trapped = {};
  for (const [pid, r] of Object.entries(P.trapped || {})) {
    const old = S.trapped[pid];
    trapped[pid] = { count: r.count | 0, last: r.last | 0, at: old ? old.at : null, st: old ? old.st : null };
  }
  Object.assign(S, {
    perch: Number.isInteger(P.perch) ? P.perch : S.perch, trapped,
    spawned: (P.spawned || []).map(x => ({ ...x })), seq: P.seq | 0,
  });
  syncTraps(match);
}

const r1 = (v) => Math.round(v * 10) / 10;
