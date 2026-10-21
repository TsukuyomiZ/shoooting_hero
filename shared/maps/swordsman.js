import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// 菁英關「流浪劍士」（黃昏的荒原）的劍士（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/swordsman.js。這一場的狀態 match.mechState = { def, next, qi, parry, flying, roam }：
//   next   = 預定的下一招 { action: 'iai' | 'parry' | 'draw' }（開場一次、之後每回合出完招再抽，權重 SWORDSMAN.weights）；
//            一閃另外帶預警線 { facing, targetIds, lines: [{ targetId, x0, y0, x1, y1 }] }（抽到的那一刻對每一位活著的玩家各一道，見 aimLines）
//   qi     = 浮在地圖右邊、還沒出發的劍氣：在第幾排（def.rows 的索引：0 地面、1 低台、2 中台、3 頂台），照揮出去的順序（最前面的最先出發）
//   parry  = 格擋架勢 { hits, need, by }（他的回合擺出來、維持到他下一回合開始；hits = 這段時間被玩家打中幾次、by = 打中他的玩家 id，照第一次打中的先後）；沒擺 = null
//   flying = 正在飛的那一道劍氣 { row, x0, x, t0, speed, hit, turnId }（x = 上次判定到哪裡、t0 = 出發的時刻（裁判的時鐘，ms）、
//            hit = 這一道已經打過的人、turnId = 在誰的回合飛的）；沒有 = null
//   roam   = 劍士沿地面走的範圍（地圖機制 build 設的；預定一閃的時候拿掉，站著不走）
//
// - 劍士站在地面最右邊（level.mechanic.swordsman），不受重力、不會被擊退（fixed），每回合出招前沿著地面走一段
//   （SWORDSMAN.walk，左右範圍 def.roam：右下石台的右邊，見 shared/ai/ai-move.js 的 planGlide；預定一閃的時候不走）。
//   血量 SWORDSMAN.hp，跟一般敵人一樣依人數、關數放大（菁英關不是 Boss 關：不算首領）。打倒他 = 過關。
// - 劍氣（2026-10-19 使用者第三輪：一直都有，不是他的招式）：開場就揮出 qiCount 道半月形的劍氣（4 排裡隨機挑幾排、隨機順序），浮在地圖右邊那一排的高度；
//   每一位玩家的回合開始時，最前面的那一道出發，在這個回合裡**慢慢**往左飛過整排（SWORDSMAN.qiSpeed px/s）：
//   碰到那一排的玩家就打（WEAPONS.swordsmanQi，範圍見 qiBand；每人一次、不擊退），玩家看得到它飛過來、跳開 / 離開那一排就躲得掉。
//   回合在它飛完之前就結束（開火、超時、AI 代打），剩下的那一段在回合收尾時一口氣掃完（照回合結束時大家的位置）。
//   最後一道飛完的那一刻，馬上再揮出 qiCount 道（不佔他的回合）
// - 他自己的招式（下一招事先抽好，玩家回合 HUD 標出來）：
//     一閃（iai，2026-10-20 使用者第二次改版：回到他的回合出招、對每一位玩家各一道預警）：一抽到就擺出拔刀的架勢、站著不走，
//                  對每一位活著的玩家各劃一道預警線（aimLines / slashLine：從他的刀口直直指向那個人的身體中間，一路延伸到地圖邊 / 地面，斜的也可以；
//                  一般難度畫出來、菁英之路不畫——畫面的 c.rangeHints）。線劃好就不動了，玩家在自己的回合離開那條線就躲得掉；
//                  輪到他時沿著這幾道線一起斬下去（WEAPONS.swordsmanIai：刀光沿線飛到地圖邊，身體碰到線（判定半徑 hitRadius）的玩家都會被打；
//                  幾道共用「打過誰」，每人最多挨一刀；不擊退）
//     格擋架勢（parry）：輪到他時擺出來（刀舉在身前），維持到他下一回合開始：受到的傷害 -parryCut%（地圖機制的 defenseMult）；
//                  這段時間被玩家打中（真的扣到血的一下算一次，見 noteHit）的次數到 need = ceil(玩家人數 × parryPerPlayer) →
//                  他下一回合一開始先放一次一閃反擊（counter，2026-10-20 使用者：只對第一個打中他的玩家、沒有預警、馬上斬——一道線指向那個人現在的位置，
//                  線上的人照樣會被打；那個人已經倒下就換下一個打中他的，打中他的都倒下了就不反擊），再出預定的那一招（一回合兩招）
//     拔刀（draw，2026-10-20 使用者恢復，權重比一閃低）：原地拔刀，一道刀氣從他身上直線飛向目標（drawTarget：站在平台上的玩家優先、其中離他最近的），
//                  打第一個碰到的人（WEAPONS.swordsmanDraw：20、擊退 200，站在平台上的常常被打下去）

export const SWORDSMAN_ACTION_NAMES = {
  iai: '一閃',
  parry: '格擋架勢',
  draw: '拔刀',
  idle: '戒備',
};

const LIFT = 16;       // 劍氣的刀光離那一排的頂面多高（判定半徑往上下各涵蓋 hitRadius：站在那一排的人一定碰得到，上下一排的碰不到）
const QI_EDGE = 30;    // 劍氣從離地圖右邊多遠的地方出發（浮著的時候也畫在那裡；整個月牙都在畫面裡）

// 建立劍士（關卡的敵人之後），回傳這一場的狀態。hpScale = 一般敵人的血量倍率（人數 × 關數）。開場的劍氣在 ready 才揮（要抽亂數，等大家落地之後）
export function buildSwordsman(match, hpScale) {
  const def = match.level.mechanic;
  const s = def.swordsman;
  match.entities.push(new Entity({
    ...CONFIG.ENEMY, id: 'swordsman', name: '流浪劍士', team: 'enemies', controller: 'ai', slot: 0, facing: -1,
    x: s.x, y: s.y, hw: s.hw, h: s.h, hp: Math.round(CONFIG.SWORDSMAN.hp * hpScale),
    fixed: true, part: 'swordsman', weapons: ['swordsmanIai'],
  }));
  return { def, next: null, qi: [], parry: null, flying: null, roam: null };
}

// 這一場的狀態（match.mechState）。別張地圖當作沒有劍士
const swordsmanState = (match) => (match.mechState && match.mechState.def && match.mechState.def.type === 'swordsman' ? match.mechState : null);

// 格擋架勢要被打中幾次才會反擊：ceil(玩家人數 × parryPerPlayer)（人數 = 整隊開場的人數，含倒下的；1 ~ 2 人 1 次、3 ~ 4 人 2 次）
export function parryNeed(match) {
  return Math.max(1, Math.ceil(match.players.length * CONFIG.SWORDSMAN.parryPerPlayer));
}

// 受到的傷害倍率（地圖機制的 defenseMult）：擺著格擋架勢的劍士 ×(1 - parryCut%)，其他人 1
export function swordsmanDefense(match, e) {
  const S = swordsmanState(match);
  return e.part === 'swordsman' && S && S.parry ? Math.max(0, 1 - CONFIG.SWORDSMAN.parryCut / 100) : 1;
}

// 有人真的被扣了血（地圖機制的 hurt）：擺著格擋架勢的劍士被玩家打中 → 記一次（直擊、波及都算；燃燒、流血不是被打中，不算），
// 也記下是誰（第一次打中的先後；反擊的一閃打第一個）
export function noteHit(match, e, dmg, attacker) {
  const S = swordsmanState(match);
  if (!S || !S.parry || e.part !== 'swordsman' || !(dmg > 0) || !attacker || attacker.team === e.team) return;
  S.parry.hits++;
  if (!Array.isArray(S.parry.by)) S.parry.by = [];
  if (!S.parry.by.includes(attacker.id)) S.parry.by.push(attacker.id);
}

// 一排打得到的範圍（rowY = 那一排的頂面高度）：x0 ~ x1 = 整張地圖、身體碰到 top ~ bottom 就會被打到；y = 刀光的高度
function rowBand(match, rowY, weapon) {
  const r = weapon.hitRadius;
  const y = rowY - LIFT;
  return { x0: 0, x1: match.terrain.maxX, y, top: y - r, bottom: y + r };
}

// 第 i 排的劍氣打得到的範圍：整張地圖寬、那一排的頂面往上一個人高；qx = 劍氣浮著 / 出發的地方（地圖右邊）
export function qiBand(match, i) {
  const S = swordsmanState(match);
  const row = S && S.def.rows[i];
  if (!row) return null;
  return { ...rowBand(match, row.y, CONFIG.WEAPONS.swordsmanQi), qx: match.terrain.maxX - QI_EDGE };
}

// e 站在地面那一排（身體碰到地面上一個人高的範圍；拔刀挑目標用）
export function onGroundRow(match, e) {
  const S = swordsmanState(match);
  if (!S) return false;
  const band = rowBand(match, S.def.rows[0].y, CONFIG.WEAPONS.swordsmanQi);
  return e.y >= band.top && e.y - e.h <= band.bottom;
}

// 拔刀打誰：站在平台上（不在地面那一排）的活著的玩家優先，其中離劍士最近的；沒有就是離他最近的。沒有人 = null
export function drawTarget(match, g) {
  const alive = match.players.filter(e => e.alive);
  const up = alive.filter(e => !onGroundRow(match, e));
  const pool = up.length ? up : alive;
  let best = null, bd = Infinity;
  for (const e of pool) {
    const d = (e.cx - g.cx) * (e.cx - g.cx) + (e.cy - g.cy) * (e.cy - g.cy);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

// ---------- 一閃的線 ----------

// 刀口的位置（劍士面向那邊、胸口的高度）：一閃的線從這裡出發
export function bladePoint(g) {
  return { x: g.x + g.facing * g.hw, y: g.y - g.h * 0.55 };
}

// 一閃的一道線：從刀口直直指向目標的身體中間，延伸到地圖的邊（左右 0 ~ maxX、上面 0、下面到地面那一排的頂面）。
// 目標就在刀口上（極少見）：照他面向的方向水平劃出去。回傳 { x0, y0, x1, y1 }
export function slashLine(match, g, target) {
  const S = swordsmanState(match);
  const groundY = S ? S.def.rows[0].y : CONFIG.WORLD_H;
  const maxX = match.terrain.maxX;
  const o = bladePoint(g);
  let dx = target.cx - o.x, dy = target.cy - o.y;
  if (dx === 0 && dy === 0) { dx = g.facing || -1; dy = 0; }
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (maxX - o.x) / dx);
  if (dx < 0) t = Math.min(t, (0 - o.x) / dx);
  if (dy > 0) t = Math.min(t, (groundY - o.y) / dy);
  if (dy < 0) t = Math.min(t, (0 - o.y) / dy);
  t = Math.max(1, t);   // 至少劃到目標（目標一定在地圖裡）
  return { x0: o.x, y0: o.y, x1: o.x + dx * t, y1: o.y + dy * t };
}

// 一閃的線：對每一位活著的玩家各一道（從現在的刀口，照玩家的順序）。回傳 [{ targetId, x0, y0, x1, y1 }]
export function aimLines(match, g) {
  return match.players.filter(e => e.alive).map(e => ({ targetId: e.id, ...slashLine(match, g, e) }));
}

// 預定的下一招的複本（快照、廣播用；一閃的預警線也複製一份，不跟機制狀態共用）
export function copyPlan(next) {
  if (!next) return null;
  return Array.isArray(next.lines) ? { ...next, targetIds: next.lines.map(l => l.targetId), lines: next.lines.map(l => ({ ...l })) } : { ...next };
}

// 揮出一輪劍氣：4 排裡隨機挑 qiCount 排（match.rng 洗牌，洗出來的順序 = 出發的順序），接在浮著的後面。回傳揮出去的那幾排
export function castQi(match) {
  const S = swordsmanState(match);
  if (!S) return [];
  const n = S.def.rows.length;
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {   // Fisher–Yates（rng.int 包含兩端）
    const j = match.rng.int(0, i);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const rows = order.slice(0, Math.min(n, CONFIG.SWORDSMAN.qiCount));
  S.qi.push(...rows);
  return rows;
}

// 抽下一招（開場、每回合出完招之後）。抽到一閃：從現在的刀口對每一位活著的玩家各劃一道預警線（之後不再動），擺著架勢站著不走
// （預警線從刀口出發，走了就對不上；roam 拿掉，Match.planAiTurn 的飄移就不走）；其他招照常沿地面走
export function planSwordsmanNext(match) {
  const S = swordsmanState(match);
  if (!S) return null;
  const W = CONFIG.SWORDSMAN.weights;
  const action = weightedPick(match.rng, [['iai', W.iai], ['parry', W.parry], ['draw', W.draw || 0]]) || 'iai';
  const g = match.byId('swordsman');
  if (action === 'iai' && g && g.alive) {
    const lines = aimLines(match, g);
    S.next = { action, facing: g.facing, targetIds: lines.map(l => l.targetId), lines };
  } else {
    S.next = { action };
  }
  if (g) g.roam = action === 'iai' ? null : S.roam;
  return S.next;
}

// 輪到劍士（走完之後）：上一回合擺的格擋架勢到這裡結束——被打中的次數夠了就先一閃反擊；再出預定的那一招，再抽下一招。
// 回傳 { steps: [招式…], next }（格式同 Boss）
export function resolveSwordsmanTurn(match, g) {
  const S = swordsmanState(match);
  const near = nearestPlayerAt(match, g.cx, g.cy);
  if (near && near.x !== g.x) g.facing = near.x > g.x ? 1 : -1;   // 面向最近的人（走路會轉向走的方向）
  const steps = [];
  const parry = S && S.parry;
  if (S) S.parry = null;   // 架勢維持到他這一回合開始（反擊的一閃不吃減傷、不算次數）
  const foe = parry && parry.hits >= parry.need ? counterTarget(match, parry) : null;
  if (foe) {
    if (foe.x !== g.x) g.facing = foe.x > g.x ? 1 : -1;   // 轉向他（刀口在那一邊）
    const counter = iaiStep(match, g, [{ targetId: foe.id, ...slashLine(match, g, foe) }], { counter: true, hits: parry.hits, need: parry.need });
    steps.push(counter);
    // 先校正成反擊的結果（跟客戶端播完一招、套上 results 一樣：速度歸零），下一招的重播才從同一個狀態開始
    match.applyEntities(counter.shot.results);
  }
  if (g.alive && match.players.some(e => e.alive)) {
    const plan = (S && S.next) || planSwordsmanNext(match) || { action: 'iai' };
    const a = plan.action;
    if (a === 'iai') {
      if (plan.facing === 1 || plan.facing === -1) g.facing = plan.facing;   // 照預警線出刀：面向預定的時候那邊
      steps.push(iaiStep(match, g, Array.isArray(plan.lines) && plan.lines.length ? plan.lines : aimLines(match, g)));
    } else {
      steps.push(a === 'parry' ? parryStep(match) : drawStep(match, g));
    }
  }
  if (!steps.length) steps.push({ action: 'idle', still: stillResult(match) });
  planSwordsmanNext(match);
  return { steps, next: S ? copyPlan(S.next) : null };
}

// 格擋反擊打誰：打中他的玩家裡，最先打中、現在還活著的那一個；都倒下了（或沒有記錄）= null（不反擊）
export function counterTarget(match, parry) {
  for (const id of Array.isArray(parry.by) ? parry.by : []) {
    const e = match.byId(id);
    if (e && e.alive) return e;
  }
  return null;
}

// 一閃：沿著 lines（[{ targetId, x0, y0, x1, y1 }]）一起斬下去——每一道刀光從線的起點（刀口）飛到地圖邊，碰到的人都會被打；
// 幾道共用「打過誰」（站在刀口旁邊的人每一道都碰得到，也只挨一刀）。extra = 反擊的 { counter, hits, need }（紀錄用；反擊只有一道，對準第一個打中他的人）。
// 回傳的招式帶 targetIds（每一道對準誰）、lines（[x0, y0, x1, y1]，客戶端照它畫）、facing、dmg（武器傷害，還沒乘敵人倍率）
function iaiStep(match, g, lines, extra = {}) {
  if (!lines.length) return { action: 'idle', still: stillResult(match) };
  const W = CONFIG.WEAPONS.swordsmanIai;
  const hitOnce = new Set([g]);
  const projs = lines.map(L => {
    const dx = L.x1 - L.x0, dy = L.y1 - L.y0;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const p = bossProjectile(g, W, L.x0, L.y0, dx / len * W.speed, dy / len * W.speed);
    p.range = len;
    p.ignore = hitOnce;
    return p;
  });
  return {
    action: 'iai', ...extra, facing: g.facing, targetIds: lines.map(L => L.targetId), lines: lines.map(L => [L.x0, L.y0, L.x1, L.y1]),
    dmg: W.damage, cast: extra.counter ? CONFIG.SWORDSMAN.cast.counter : CONFIG.SWORDSMAN.cast.iai,
    shot: bossShot(match, g, W, projs, g.facing),
  };
}

// 格擋架勢：擺出來（減傷、開始數被打中幾次），維持到他下一回合開始
function parryStep(match) {
  const S = swordsmanState(match);
  const need = parryNeed(match);
  if (S) S.parry = { hits: 0, need, by: [] };
  return { action: 'parry', need, cast: CONFIG.SWORDSMAN.cast.parry, still: stillResult(match) };
}

// 拔刀：一道刀氣從劍士身上（胸口的高度）直線飛向目標的身體中間，打第一個碰到的人（不穿透、不挖地）
function drawStep(match, g) {
  const target = drawTarget(match, g);
  if (!target) return { action: 'idle', still: stillResult(match) };
  const W = CONFIG.WEAPONS.swordsmanDraw;
  if (target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
  const x0 = g.x + g.facing * g.hw, y0 = g.y - g.h * 0.55;
  const dx = target.cx - x0, dy = target.cy - y0;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const p = bossProjectile(g, W, x0, y0, dx / d * W.speed, dy / d * W.speed);
  p.ignore.add(g);
  return { action: 'draw', targetId: target.id, dmg: W.damage, cast: CONFIG.SWORDSMAN.cast.draw, shot: bossShot(match, g, W, [p], g.facing) };
}

// ---------- 玩家回合裡的危險物（地圖機制的 hazardStart / hazardStep / hazardFinish，裁判呼叫）：劍氣 ----------

// 玩家 e 的回合開始（開始計時之前；now = 裁判的時鐘，ms）：最前面那一道劍氣出發。
// 回傳給客戶端的資料 { kind: 'swordsman', qi: { row, x（出發的地方）, speed（px/s）, hover（還浮著的）} }；這回合沒有 = null
export function startHazards(match, e, now) {
  const S = swordsmanState(match);
  const g = match.byId('swordsman');
  if (!S || !e || e.team !== 'players' || !e.alive || !g || !g.alive) return null;
  if (S.flying || !S.qi.length) return null;
  const row = S.qi.shift();
  const band = qiBand(match, row);
  const speed = CONFIG.SWORDSMAN.qiSpeed;
  S.flying = { row, x0: band.qx, x: band.qx, t0: now, speed, hit: [], turnId: e.id };
  return { kind: 'swordsman', qi: { row, x: band.qx, speed, hover: S.qi.slice() } };
}

// 推進到 now：從上次判定到的地方（flying.x）掃到現在的位置，碰到那一排的玩家（還沒被這一道打過的）就打（照碰到的順序：靠右的先）；
// 飛到地圖左邊（或劍士已經倒下）= 這一道結束，浮著的都飛完了就馬上再揮一輪（castQi）。
// flush（回合要收尾了）：劍氣沒有要提早結算的（剩下那段由 finishHazards 一口氣掃完），照常推進。
// 回傳 { kind, damages（這一次打到的，同 applyExplosion）, done（這回合沒有還在動的了）, notify（有要告訴客戶端的事）,
//        qi: { row, x（現在的位置）, done, hover（還浮著的）, recast（剛再揮出的那幾排）} }；沒有在飛 = null
export function stepHazards(match, now, flush = false) {
  const S = swordsmanState(match);
  const F = S && S.flying;
  if (!F) return null;
  const g = match.byId('swordsman');
  const live = !!(g && g.alive);
  const damages = [];
  const W = CONFIG.WEAPONS.swordsmanQi;
  const band = qiBand(match, F.row);
  const prev = F.x;
  const x = Math.max(band.x0, F.x0 - F.speed * Math.max(0, now - F.t0) / 1000);
  const r = W.hitRadius;
  if (live && x < prev) {
    const hit = match.players
      .filter(e => e.alive && !F.hit.includes(e.id) && e.y >= band.top && e.y - e.h <= band.bottom
        && e.x - e.hw - r <= prev && e.x + e.hw + r >= x)
      .sort((a, b) => b.x - a.x);
    for (const e of hit) {
      F.hit.push(e.id);
      damages.push(...match.applyExplosion(Math.min(prev, e.x + e.hw + r), band.y, W, g, e, { directOnly: true }));
    }
  }
  F.x = x;
  const over = x <= band.x0 || !live;
  let recast = null;
  if (over) {
    S.flying = null;
    if (!S.qi.length && live) recast = castQi(match);
  }
  const qi = { row: F.row, x, done: over, hover: S.qi.slice(), ...(recast ? { recast } : {}) };
  return { kind: 'swordsman', damages, done: over, notify: damages.length > 0 || over, qi };
}

// 回合收尾時劍氣還在飛（回合在它飛完之前就結束了）：回傳結算剩下那一段的函式——從上次判定到的地方一口氣往左掃到地圖邊（照現在大家的位置；
// 這一道已經打過的人不再打）；回傳跟開火同樣格式的結果（kind: 'swordQi'、row、hover = 還浮著的、剛再揮出的 recast）。沒有在飛 = null
export function finishHazards(match) {
  const S = swordsmanState(match);
  const F = S && S.flying;
  const g = match.byId('swordsman');
  if (!F) return null;
  if (!g || !g.alive) { S.flying = null; return null; }
  return () => {
    const W = CONFIG.WEAPONS.swordsmanQi;
    const band = qiBand(match, F.row);
    const p = bossProjectile(g, W, F.x, band.y, -W.speed, 0);
    p.range = Math.max(1, F.x - band.x0);
    p.ignore.add(g);
    for (const id of F.hit) { const e = match.byId(id); if (e) p.ignore.add(e); }
    S.flying = null;
    const result = match.resolveVolley(g, W, [p], 0);
    const recast = !S.qi.length && g.alive ? castQi(match) : null;
    return {
      kind: 'swordQi', actorId: g.id, turnId: F.turnId, weapon: W.id, row: F.row, hover: S.qi.slice(), ...(recast ? { recast } : {}),
      ...result,
    };
  };
}

