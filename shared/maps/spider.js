import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { buildCave } from './cave.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';
import { standSpot, standY } from './guardian.js';

// Boss 關「蜘蛛巢穴」的蜘蛛女王（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/spider.js。這張地圖也是洞穴（鐘乳石、火把、陰影，規則在 cave.js），
// 這一場的狀態 match.mechState = 洞穴的狀態（def、lit、fallen）+
//   hpScale（小蜘蛛的血量倍率 = 王的）、mode（女王現在 'hang' 懸吊在天上 / 'ground' 被燒到掉在地上 / 'hide' 躲在背景）、
//   cleansed（血量 50% 的那一次用過了）、next（掛在天上時預定的下一招）、eggs（場上的蛛卵 [{ id, left: 還要幾個女王的回合孵化 }]）、
//   stuck（玩家 id → 黏住他的那張網的 id）、spawned（下的蛋、放的網、孵出來的小蜘蛛的出生資料，重連時照著重建）、seq（流水號）
//
// 2026-10-22 使用者定的規則（數字見 config.SPIDER_QUEEN / SPIDER_EGG / SPIDER_WEB / SPIDERLING / ENTANGLE / WEAPONS.spider*）：
// - 女王 hp 400，一開始懸吊在右上角。招式：
//     蜘蛛吐絲：全體玩家「糾纏」三回合（體力消耗 +50%，金剛不壞免疫，見 ENTANGLE 與 Entity.staminaMult）
//     召喚蛛卵：照人數 ×1 在四周的岩台上下蛋；蛛卵 3 點血，武器打到只扣 1、燃燒 +100%（最少扣 1）（10-22 改，原本武器傷害 -90%），
//               三回合後孵出小蜘蛛（hp 80，撲咬 10 + 5 層中毒）
//               蛛卵還在的時候女王退到背景（陰影 + 紅眼；打不到），每回合回 1% 血
//     毒液注射：隨機一名玩家 10 層中毒、不扣血（10-22 使用者改：原本 10 傷害 + 20 層）
//     撲網：隨機在地圖上放蜘蛛網，碰到的玩家被黏住、不能移動，把網射破才放開；每回合都放兩張
//           （10-22 使用者改：被打到一下就破，原本網 hp 60、燃燒 +100%）
//     撲咬：30 + 10 層中毒（只有在地上才用）
// - 女王懸掛在天上，被燒到（身上有燃燒）就掉到地上、只能在地上走、只會撲咬；燃燒沒了就爬回天上
// - 血量一到 50% 以下：移除身上所有負面狀態、強制召喚蛛卵（一場一次）
// 我補的（使用者沒指定，回覆說明過）：
// - 女王的狀態只看場面推得出來（queenMode）：還有蛛卵 → 躲在背景；不然身上有燃燒 → 在地上；不然懸吊在天上。
//   兩邊照同一個條件各自推（syncQueen），掉下來 / 退到背景 / 回來的那一下（打中的那一下、蛋被打破的那一下）就換，同一波後面的砲彈照新的位置算
// - 一個回合：蛛卵燒起來 → 蛛卵倒數、孵化 →（血量到 50%：蛻皮（移除負面）+ 強制召喚蛛卵）/（在地上：撲咬）/
//   （躲在背景：回血 + 一招）/（掛在天上：一招）→ 不在地上的話放兩張網。主要的那一招事先抽好（next，HUD 上看得到）：
//   吐絲 / 召喚（蛛卵還在就不召喚）/ 毒液，權重見 SPIDER_QUEEN.weights
// - 燃燒在蛛卵上：蛋不會輪到、不會動（層數不掉），在每個女王的回合開始結算：
//     照一般燃燒的算法（每層扣最大血量 EQUIP.burn.pctPerStack%）+100%、最少扣 1（3 點血的蛋 = 每回合 1）
// - 蛛卵 / 網被武器打到（直擊、爆炸波及都算一次）由地圖機制處理（absorbHit，同蜂巢）：
//     蛋扣 SPIDER_EGG.hitDamage，這一下帶的燃燒照樣上；網一下就破（不管什麼武器、傷害多少，黏住的人放開）
// - 蛛卵的數量 = 活著的玩家人數（最多到巢的數量），血量 3（不吃王的倍率）；小蜘蛛照王的倍率；孵出來的那一輪不動
// - 網：每回合最多放到場上 maxWebs 張；放在地面 / 岩台的頂面，腳踩在網上（腳底跟網的底差不到 WEB_FEET）、身體碰到網就黏住
//   ——跳過去不會被黏到。黏到人的網會移到他身上包住他（之後他開火一出砲口就打在網上，自己的攻擊傷不到自己，同處刑監獄的囚籠）。
//   被黏住：Entity.held（走不動、跳不起來、不會被擊退），網被打破就放開
// - 女王撲咬 / 小蜘蛛撲咬：飛行物就是牠自己，直直撲向最近的人；女王撲完落在地上（只能在地上走），撲過去的距離算移動（甩掉燃燒層數）
// - 女王倒下 → 蛛卵、小蜘蛛、網全部跟著消失（同古樹的樹妖）

export const QUEEN_NAME = '蜘蛛女王';
export const QUEEN_ID = 'spiderQueen';

export const SPIDER_ACTION_NAMES = {
  silk: '蜘蛛吐絲',
  summon: '召喚蛛卵',
  venom: '毒液注射',
  web: '撲網',
  bite: '撲咬',
  cleanse: '蛻去負面狀態',
  hatch: '蛛卵孵化',
  regen: '在暗處休養',
  burn: '蛛卵燃燒',
  idle: '發呆',
};

const WEB_FEET = 8;   // 腳底離網的底多近算踩在網上（網只黏得到站在那一層的人：從上面跳過去不算）

// 這一場的狀態（match.mechState）。別張地圖當作沒有
export const spiderState = (match) => (match.mechState && match.mechState.def && match.mechState.def.type === 'spider' ? match.mechState : null);
export const queenOf = (match) => match.byId(QUEEN_ID);
export const isEgg = (e) => !!e && e.kind === 'spiderEgg';
export const isWeb = (e) => !!e && e.kind === 'spiderWeb';
export const isSpiderling = (e) => !!e && e.kind === 'spiderling';

// 建立蜘蛛女王（關卡的敵人之後），回傳這一場的狀態（洞穴的狀態 + 女王的）。bossScale = 王的血量倍率（人數 × 第幾個王關）：小蜘蛛也照這個
export function buildSpider(match, { bossScale }) {
  const def = match.level.mechanic;
  const Q = CONFIG.SPIDER_QUEEN;
  const q = new Entity({
    ...CONFIG.ENEMY, id: QUEEN_ID, name: QUEEN_NAME, team: 'enemies', controller: 'ai', slot: 0, facing: -1, kind: 'spiderQueen',
    x: def.hang.x, y: def.hang.y, hw: Q.hw, h: Q.h, hp: Math.round(Q.hp * bossScale), boss: true, fixed: true, weapons: ['spiderVenom'],
  });
  match.entities.push(q);
  q.hpFloor = floorHp(q);
  return { ...buildCave(match), hpScale: bossScale, mode: 'hang', cleansed: false, next: null, eggs: [], stuck: {}, spawned: [], seq: 0 };
}

// 50% 的門檻（用過了 = 0）：血量停在這裡，等輪到她蛻皮、召喚蛛卵
function floorHp(e, S = null) {
  if (S && S.cleansed) return 0;
  return Math.round((e.maxHp + e.poisonLock) * CONFIG.SPIDER_QUEEN.cleansePct / 100);
}

/** 場上還有蛛卵（活著的）嗎 */
export function eggsAlive(match) {
  return match.entities.some(e => isEgg(e) && e.alive);
}

/** 女王現在該是什麼狀態：還有蛛卵 → 躲在背景（hide）；不然身上有燃燒 → 掉在地上（ground）；不然懸吊在天上（hang） */
export function queenMode(match) {
  const S = spiderState(match);
  const q = queenOf(match);
  if (!S || !q || !q.alive) return S ? S.mode : 'hang';
  if (eggsAlive(match)) return 'hide';
  return q.burn > 0 ? 'ground' : 'hang';
}

/**
 * 女王的狀態跟場面對齊（兩邊照同一個條件各自推、可以重複呼叫、不抽亂數）：
 *   被燒到 → 從天上直直掉到地上（底下站得住的地方）；燃燒沒了 → 爬回懸吊的地方；有蛛卵 → 退到背景（懸吊的地方，打不到，Entity.intangible）；
 *   蛛卵都沒了 → 從背景回來（懸吊的地方，打得到）。
 * 伺服器：打到她 / 打破蛋的那一下（地圖機制的 eventExtras）、一波結算完（cascade）、她的回合結束燃燒結算之後（turnEnd）、她的回合裡每一步之後；
 * 客戶端：照事件重播到那一下（replayEvent）、畫面每一步（沒在播她的回合的時候）。
 * 回傳 { from, to, x0, y0, x, y }（從哪個狀態換到哪個、從哪裡到哪裡：畫面照它畫掉下來 / 爬上去），沒換 = null
 */
export function syncQueen(match) {
  const S = spiderState(match);
  const q = queenOf(match);
  if (!S || !q || !q.alive) return null;
  const want = queenMode(match);
  if (want === S.mode) return null;
  const from = S.mode, x0 = q.x, y0 = q.y;
  if (want === 'ground') {
    const spot = standSpot(match, q, q.x, S.def.ground) || { x: q.x, y: S.def.ground };
    q.x = spot.x;
    q.y = spot.y;
  } else {
    q.x = S.def.hang.x;
    q.y = S.def.hang.y;
    q.facing = -1;
  }
  q.vx = 0;
  q.vy = 0;
  setMode(match, want);
  return { from, to: want, x0, y0, x: q.x, y: q.y };
}

/** 女王的狀態跟她碰不碰得到（躲在背景 = Entity.intangible）一起改。快照也用這個 */
export function setMode(match, mode) {
  const S = spiderState(match);
  if (!S) return;
  S.mode = mode;
  const q = queenOf(match);
  if (q) q.intangible = mode === 'hide';
}

/**
 * 蛛卵被打到（地圖機制的 absorbHit，hit = { attacker, friendly, damages, later, burn }）：不管什麼武器、打多重、直擊還是波及，都只扣 SPIDER_EGG.hitDamage，
 * 這一下帶的燃燒（著火的子彈、燃燒子彈等牌）照樣上；不會被擊退。大家都扣完血才扣（later，同蜂巢）。回傳 true = 這是蛋（由這裡處理）
 */
export function hitEgg(match, e, { attacker, friendly, damages, later, burn = 0 }) {
  if (!isEgg(e)) return false;
  if (!attacker || friendly) return true;
  const entry = { id: e.id, dmg: 0, friendly };
  damages.push(entry);
  later.push(() => {
    entry.dmg = e.takeDamage(CONFIG.SPIDER_EGG.hitDamage);
    if (burn > 0 && e.alive) {
      e.burn += burn;
      e.burnSource = attacker.id;
      entry.burn = burn;
    }
  });
  return true;
}

/**
 * 蜘蛛網被打到（地圖機制的 absorbHit）：不管什麼武器、打多重、直擊還是波及，一下就破（2026-10-22 使用者）。
 * 大家都扣完血才破（later，同蛛卵）；黏住的人在這一下之後放開（eventExtras / replayEvent 的 syncWebs）。回傳 true = 這是網（由這裡處理）
 */
export function hitWeb(match, e, { attacker, friendly, damages, later }) {
  if (!isWeb(e)) return false;
  if (!attacker || friendly) return true;
  const entry = { id: e.id, dmg: 0, friendly };
  damages.push(entry);
  later.push(() => { entry.dmg = e.takeDamage(e.hp); });
  return true;
}

// ---------- 下的蛋、放的網、孵出來的小蜘蛛：伺服器出招、客戶端播動畫、重連重建都用這三個，雙方的角色一模一樣 ----------

export function spawnEgg(match, spec) {
  const C = CONFIG.SPIDER_EGG;
  const e = new Entity({
    ...CONFIG.ENEMY, id: spec.id, name: '蛛卵', team: 'enemies', controller: 'ai', slot: 0, kind: 'spiderEgg',
    x: spec.x, y: spec.y, hw: C.hw, h: C.h, hp: spec.hp, fixed: true, noTurn: true, optional: true, allyPass: true, noKill: true,
  });
  match.entities.push(e);
  const S = spiderState(match);
  if (S) {
    S.spawned.push({ type: 'egg', ...spec });
    if (!S.eggs.some(g => g.id === spec.id)) S.eggs.push({ id: spec.id, left: spec.left });
  }
  return e;
}

// 蜘蛛網：玩家方打得到（射破就放開）、敵人的攻擊穿過去，固定不動、不會輪到它、打破不算擊殺
export function spawnWeb(match, spec) {
  const C = CONFIG.SPIDER_WEB;
  const e = new Entity({
    ...CONFIG.ENEMY, id: spec.id, name: '蜘蛛網', team: 'enemies', controller: 'ai', slot: 0, kind: 'spiderWeb',
    x: spec.x, y: spec.y, hw: C.hw, h: C.h, hp: spec.hp, fixed: true, noTurn: true, optional: true, allyPass: true, noKill: true,
  });
  match.entities.push(e);
  const S = spiderState(match);
  if (S) S.spawned.push({ type: 'web', ...spec });
  return e;
}

export function spawnSpiderling(match, spec) {
  const C = CONFIG.SPIDERLING;
  const e = new Entity({
    ...CONFIG.ENEMY, id: spec.id, name: spec.name || '小蜘蛛', team: 'enemies', controller: 'ai', slot: 0, facing: -1, kind: 'spiderling',
    x: spec.x, y: spec.y, hw: C.hw, h: C.h, hp: spec.hp, weapons: ['spiderlingBite'],
  });
  match.entities.push(e);
  const S = spiderState(match);
  if (S) S.spawned.push({ type: 'spiderling', ...spec });
  return e;
}

// ---------- 蜘蛛網 ----------

// 腳底在 (x, y) 的人（半寬 hw）有沒有踩進網 w：腳底跟網的底差不到 WEB_FEET、身體跟網左右重疊
function inWeb(w, x, y, hw) {
  return Math.abs(y - w.y) <= WEB_FEET && Math.abs(x - w.x) < w.hw + hw - 2;
}

// 網 w 黏住玩家 p：記在 stuck；這張網還沒黏過人的話移到他身上包住他（之後他開火一出砲口就打在網上）
function catchIn(match, w, p) {
  const S = spiderState(match);
  if (!S.stuck[p.id]) {
    if (!Object.values(S.stuck).includes(w.id)) { w.x = p.x; w.heldId = p.id; }
    S.stuck[p.id] = w.id;
  }
  p.held = true;
  p.moveDir = 0;
  p.wantJump = false;
}

/**
 * 被黏住的人跟網對齊：網被打破了、被黏住的人倒下了 → 放開；被黏住的人走不動（Entity.held）。網記得它黏著誰（heldId，AI 先救人）。
 * 伺服器在每一波結算完（cascade）、放網 / 走路碰到網之後，客戶端在畫面每一步與快照之後都叫，兩邊照同一個條件各自推
 */
export function syncWebs(match) {
  const S = spiderState(match);
  if (!S) return;
  for (const [pid, wid] of Object.entries(S.stuck)) {
    const p = match.byId(pid), w = match.byId(wid);
    if (!p || !p.alive || !w || !w.alive) delete S.stuck[pid];
  }
  // 破掉的網留著最後黏住的人（畫面播「掙脫了！」要知道是誰）
  for (const e of match.entities) if (isWeb(e) && e.alive) e.heldId = Object.keys(S.stuck).find(pid => S.stuck[pid] === e.id) || null;
  for (const p of match.players) p.held = !!S.stuck[p.id];
}

/**
 * 玩家 e 從 (x0, y0) 走到 (x1, y1)（位置回報之間的路線 / 本地每一幀 / AI 代打的每一幀，每 4px 檢查一次，終點一定檢查）：踩進網就黏住。
 * 回傳 fx { type: 'web', id, web, x, y }（裁判廣播成 pickup；x / y = 網移過去的位置），沒碰到 / 已經被黏住了 = null
 */
export function touchWeb(match, e, x0, y0, x1, y1) {
  const S = spiderState(match);
  if (!S || e.team !== 'players' || !e.alive || S.stuck[e.id]) return null;
  const webs = match.entities.filter(w => isWeb(w) && w.alive);
  if (!webs.length) return null;
  const n = Math.max(1, Math.ceil(Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) / 4));
  for (let k = 0; k <= n; k++) {
    const px = x0 + (x1 - x0) * k / n, py = y0 + (y1 - y0) * k / n;
    const w = webs.find(q => inWeb(q, px, py, e.hw));
    if (w) {
      catchIn(match, w, e);
      return { type: 'web', id: e.id, web: w.id, x: w.x, y: w.y };
    }
  }
  return null;
}

/** 走路碰到網（伺服器廣播的 pickup / AI 代打的 pickups）：客戶端照著黏住（網的位置照伺服器的） */
export function applyWebPickup(match, msg) {
  const S = spiderState(match);
  const p = match.byId(msg.id), w = match.byId(msg.web);
  if (!S || !p || !w || !w.alive) return;
  catchIn(match, w, p);
  if (Number.isFinite(msg.x)) w.x = msg.x;   // 在 catchIn 之後：別人的畫面上他的位置還在插值，網照伺服器的位置
  syncWebs(match);
}

/** 被黏住的人自己的攻擊（打在網上的爆炸）傷不到他自己（地圖機制的 absorbHit：回傳 true = 這一下不算他） */
export function shieldsStuck(match, e, attacker) {
  const S = spiderState(match);
  return !!S && attacker === e && !!S.stuck[e.id];
}

// 網放得下的地方：照 webSpans 的長度抽一段、段裡隨機一個 x（match.rng），跟場上的網不重疊；腳底照那裡的地面（被炸過的地面往下找，
// 炸穿了找不到地面的地方不放：不然網浮在坑上、跳過去的人在半空中被黏住）。試 20 次都放不下 = null
function webSpot(match) {
  const S = spiderState(match);
  const C = CONFIG.SPIDER_WEB;
  const spans = S.def.webSpans.filter(s => s.x1 - s.x0 > C.hw * 2);
  const webs = match.entities.filter(w => isWeb(w) && w.alive);
  const probe = new Entity({ id: 'webProbe', team: 'enemies', x: 0, y: 0, hp: 1, stamina: 1, hw: 8, h: 20 });   // 找地面用（被炸過的地面往下找）
  for (let tries = 0; tries < 20 && spans.length; tries++) {
    const span = weightedPick(match.rng, spans.map((s, i) => [i, s.x1 - s.x0 - C.hw * 2]));
    const s = spans[span];
    const x = Math.round(s.x0 + C.hw + match.rng.float() * (s.x1 - s.x0 - C.hw * 2));
    const y = standY(match, probe, x, s.y);
    if (y === null) continue;
    if (webs.some(w => Math.abs(w.y - y) < C.h && Math.abs(w.x - x) < C.hw * 2)) continue;
    return { x, y };
  }
  return null;
}

// ---------- 蛛卵燒起來、孵化 ----------

// 蛛卵身上的燃燒：每個女王的回合開始結算（層數不會掉）。燒掉的血算點火的人造成的。回傳燒到的 [{ id, dmg }]
function burnEggs(match) {
  const out = [];
  for (const e of match.entities) {
    if (!e.alive || !(e.burn > 0) || !isEgg(e)) continue;
    const dmg = e.takeDamage(eggBurn(match, e));
    const igniter = match.byId(e.burnSource);
    if (igniter && igniter.team !== e.team) igniter.dealt += dmg;
    out.push({ id: e.id, dmg });
  }
  return out;
}

// 蛛卵一個女王回合燒掉多少：照一般燃燒的算法（每層扣最大血量 EQUIP.burn.pctPerStack%）+burnTakenPct%、最少 burnMin
function eggBurn(match, e) {
  const C = CONFIG.SPIDER_EGG;
  const raw = e.burn * CONFIG.EQUIP.burn.pctPerStack / 100 * e.maxHp * (1 + C.burnTakenPct / 100) * match.feverMult();
  return Math.max(C.burnMin, Math.round(raw));
}

// 蛛卵倒數（每個女王的回合少 1），到 0 的孵出小蜘蛛（蛋破掉、小蜘蛛站在那裡，這一輪不動）。回傳孵出來的出生資料
function hatchEggs(match) {
  const S = spiderState(match);
  const specs = [];
  for (const g of S.eggs) {
    const egg = match.byId(g.id);
    if (!egg || !egg.alive) continue;
    g.left--;
    if (g.left > 0) continue;
    egg.die('hatch');
    const n = ++S.seq;
    const spec = { id: `spiderling${n}`, name: `小蜘蛛 ${n}`, x: egg.x, y: egg.y, hp: Math.round(CONFIG.SPIDERLING.hp * S.hpScale), egg: egg.id };
    spawnSpiderling(match, spec).dormant = true;
    specs.push(spec);
  }
  S.eggs = S.eggs.filter(g => { const e = match.byId(g.id); return e && e.alive; });
  return specs;
}

// ---------- 女王的回合 ----------

// 隨機一個活著的玩家（match.rng）；沒有 = null
function randomPlayer(match) {
  const alive = match.players.filter(e => e.alive);
  return alive.length ? match.rng.pick(alive) : null;
}

// 吐絲吐得到誰：活著、沒有免疫（金剛不壞）、糾纏還沒滿的人
function silkTargets(match) {
  return match.players.filter(e => e.alive && !match.immuneTo(e) && e.entangle < CONFIG.ENTANGLE.turns);
}

// 空著的巢（沒有活著的蛋；蛋下在第幾個巢看它的出生資料）
function freeNests(match) {
  const S = spiderState(match);
  const taken = new Set(S.spawned.filter(s => s.type === 'egg' && match.entities.some(e => e.id === s.id && e.alive)).map(s => s.nest));
  return S.def.nests.map((n, k) => k).filter(k => !taken.has(k));
}

/**
 * 抽女王的下一招（開場、每次出完招之後）：吐絲 / 召喚蛛卵 / 毒液注射照權重（吐絲沒人吐得到、蛛卵還在 / 巢滿了就不抽那一招），
 * 毒液先隨機選好目標（targetId，玩家回合畫面上會標出來）。在地上的話不用抽（只會撲咬）
 */
export function planQueenNext(match) {
  const S = spiderState(match);
  if (!S) return null;
  const q = queenOf(match);
  if (!q || !q.alive) return (S.next = null);
  const W = CONFIG.SPIDER_QUEEN.weights;
  const action = weightedPick(match.rng, [
    ['silk', silkTargets(match).length ? W.silk : 0],
    ['summon', !eggsAlive(match) && freeNests(match).length ? W.summon : 0],
    ['venom', W.venom],
  ]) || 'venom';
  if (action !== 'venom') return (S.next = { action });
  const t = randomPlayer(match);
  return (S.next = t ? { action, targetId: t.id } : { action });
}

/**
 * 輪到女王：蛛卵 / 網燒起來 → 蛛卵孵化 → 這一回合的招（血量到 50% 先蛻皮 + 強制召喚；在地上撲咬；躲在背景回血 + 一招；掛在天上一招）
 * → 不在地上就放兩張網 → 抽下一招。回傳 { steps: [招式…], next, state }（格式同 Boss；state = 整回合播完客戶端對齊用）
 */
export function resolveQueenTurn(match, q) {
  const S = spiderState(match);
  const Q = CONFIG.SPIDER_QUEEN;
  const steps = [];
  const anyone = () => match.players.some(e => e.alive);
  const burns = burnEggs(match);
  if (burns.length) steps.push(withState(match, { action: 'burn', burns, cast: Q.cast.burn, still: stillResult(match) }));
  const hatched = hatchEggs(match);
  if (hatched.length) steps.push(withState(match, { action: 'hatch', spawns: hatched, cast: Q.cast.hatch, still: stillResult(match) }));
  if (!S.cleansed && q.hp <= floorHp(q, S)) {
    steps.push(cleanseStep(match, q));
    const summon = summonStep(match, q, true);
    if (summon) steps.push(summon);
  } else if (S.mode === 'ground') {
    const t = anyone() ? nearestPlayerAt(match, q.cx, q.cy) : null;
    if (t) steps.push(biteStep(match, q, t, CONFIG.WEAPONS.spiderBite, S.def.ground, Q.cast.bite, Q.biteBack));
  } else {
    if (S.mode === 'hide') steps.push(regenStep(match, q));
    if (anyone()) steps.push(...mainSteps(match, q));
  }
  if (S.mode !== 'ground') {
    for (let k = 0; k < Q.websPerTurn && anyone(); k++) {
      const step = webStep(match, q);
      if (step) steps.push(step);
    }
  }
  if (!steps.length) steps.push(withState(match, { action: 'idle', still: stillResult(match) }));
  planQueenNext(match);
  return { steps, next: S.next ? { ...S.next } : null, state: spiderSnapshot(match).spider };
}

// 招式做完之後的狀態（女王掉下來 / 爬上去 / 退到背景，網放開人）：每一步都對齊一次，照它重算這一步的結果（客戶端播完這一步就套這一份）。
// 換了狀態的話這一步帶 queen（畫面照它播動畫）與 queenTo（換成什麼，紀錄的 ai.turn 只記招式的純量欄位）
function withState(match, step) {
  const change = syncQueen(match);
  syncWebs(match);
  if (change) Object.assign(step, { queen: change, queenTo: change.to });
  const res = step.shot || step.still;
  if (res) res.results = match.entities.map(e => e.toState());
  return step;
}

// 這一回合的主要一招：照預定的（不能用了就重抽）
function mainSteps(match, q) {
  const S = spiderState(match);
  let plan = S.next || {};
  if (plan.action === 'summon' && (eggsAlive(match) || !freeNests(match).length)) plan = {};
  if (plan.action === 'silk' && !silkTargets(match).length) plan = {};
  if (!['silk', 'summon', 'venom'].includes(plan.action)) plan = planQueenNext(match) || {};
  if (plan.action === 'silk') return [silkStep(match, q)];
  if (plan.action === 'summon') { const s = summonStep(match, q, false); return s ? [s] : []; }
  const target = (plan.targetId && match.players.find(e => e.id === plan.targetId && e.alive)) || randomPlayer(match);
  return target ? [venomStep(match, q, target)] : [];
}

// 女王的口器（毒液、絲、網從這裡出去）：身體前端（面向那一邊）、偏下
export function fangsOf(q) {
  return { x: q.x + q.facing * (q.hw - 6), y: q.y - q.h * 0.3 };
}

// 蜘蛛吐絲：吐得到的人糾纏 ENTANGLE.turns 個自己的回合（補滿、不疊加）；免疫的人（金剛不壞）記 immune
function silkStep(match, q) {
  const targets = match.players.filter(e => e.alive);
  const hit = [], immune = [];
  for (const e of targets) {
    if (match.immuneTo(e)) { immune.push(e.id); continue; }
    e.entangle = CONFIG.ENTANGLE.turns;
    hit.push(e.id);
  }
  return withState(match, { action: 'silk', targetIds: hit, immune, cast: CONFIG.SPIDER_QUEEN.cast.silk, still: stillResult(match) });
}

// 召喚蛛卵：活著的玩家人數 × eggsPerPlayer 顆，隨機下在空著的巢（最多到巢的數量）。蛋下好女王就退到背景（syncQueen）。
// forced = 血量 50% 的那一次（強制召喚）
function summonStep(match, q, forced) {
  const S = spiderState(match);
  const C = CONFIG.SPIDER_EGG;
  const want = match.players.filter(e => e.alive).length * CONFIG.SPIDER_QUEEN.eggsPerPlayer;
  const nests = freeNests(match);
  const specs = [];
  while (specs.length < want && nests.length) {
    const k = nests.splice(match.rng.int(0, nests.length - 1), 1)[0];
    const nest = S.def.nests[k];
    const n = ++S.seq;
    const spec = { id: `egg${n}`, nest: k, x: nest.x, y: nest.y, hp: C.hp, left: C.hatchTurns };
    spawnEgg(match, spec);
    specs.push(spec);
  }
  if (!specs.length) return null;
  return withState(match, { action: 'summon', ...(forced ? { forced: true } : {}), spawns: specs, cast: CONFIG.SPIDER_QUEEN.cast.summon, still: stillResult(match) });
}

// 毒液注射：從口器直直射向 target（其他人都不會擋到，一定打中他），只上中毒（WEAPONS.spiderVenom 的傷害、擊退是 0）
function venomStep(match, q, target) {
  const W = CONFIG.WEAPONS.spiderVenom;
  if (target.x !== q.x) q.facing = target.x > q.x ? 1 : -1;
  const o = fangsOf(q);
  const dx = target.cx - o.x, dy = target.cy - o.y;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const p = bossProjectile(q, W, o.x, o.y, dx / d * W.speed, dy / d * W.speed);
  for (const e of match.entities) if (e !== target) p.ignore.add(e);
  p.stopAt = target;
  return withState(match, { action: 'venom', targetId: target.id, cast: CONFIG.SPIDER_QUEEN.cast.venom, shot: bossShot(match, q, W, [p], q.facing) });
}

// 撲網：隨機放一張網（場上滿 maxWebs 張就不放）；放下去的地方有人踩著就黏住他（網移到第一個人身上）。caught = 黏到的人
function webStep(match, q) {
  const S = spiderState(match);
  if (match.entities.filter(w => isWeb(w) && w.alive).length >= CONFIG.SPIDER_QUEEN.maxWebs) return null;
  const spot = webSpot(match);
  if (!spot) return null;
  const n = ++S.seq;
  const spec = { id: `web${n}`, x: spot.x, y: spot.y, hp: CONFIG.SPIDER_WEB.hp };
  const w = spawnWeb(match, spec);
  // 先看放下去的地方踩著哪些人，再一個個黏住（第一個黏住的會把網移到他身上：不能照移過去的網判下一個人）
  const caught = match.players.filter(p => p.alive && !S.stuck[p.id] && inWeb(w, p.x, p.y, p.hw)).map(p => p.id);
  for (const id of caught) catchIn(match, w, match.byId(id));
  return withState(match, { action: 'web', spawns: [spec], caught, x: w.x, y: w.y, cast: CONFIG.SPIDER_QUEEN.cast.web, still: stillResult(match) });
}

// 在暗處休養（躲在背景）：回 regenPct% 最大血量
function regenStep(match, e) {
  const heal = match.heal(e, e.maxHp * CONFIG.SPIDER_QUEEN.regenPct / 100);
  return withState(match, { action: 'regen', heal, cast: CONFIG.SPIDER_QUEEN.cast.regen, still: stillResult(match) });
}

// 血量到 50%（一場一次）：移除身上所有負面狀態（燃燒、中毒、流血、被中毒鎖住的上限），門檻拿掉；燃燒沒了就爬回天上（withState）
function cleanseStep(match, e) {
  const S = spiderState(match);
  const removed = { burn: e.burn, poison: e.poison, bleed: e.bleed, lock: e.poisonLock };
  e.burn = 0;
  e.poison = 0;
  e.bleed = 0;
  e.maxHp += e.poisonLock;
  e.poisonLock = 0;
  S.cleansed = true;
  e.hpFloor = 0;
  return withState(match, { action: 'cleanse', ...removed, cast: CONFIG.SPIDER_QUEEN.cast.cleanse, still: stillResult(match) });
}

/**
 * 撲咬（女王在地上 / 小蜘蛛）：飛行物就是牠自己（從身體中間出發、判定半徑 = 半寬），直直撲向 victim（其他人都不碰），
 * 撞到就停在他旁邊（被擊退之前的位置、靠牠這一邊）再往後跳開 back px，落在高度 refY 附近站得住的地方（女王 = 地面：只能在地上走；小蜘蛛 = 被咬的人那一層）。
 * 撲過去、跳回來的水平距離算這回合的移動（甩掉燃燒層數：女王咬完跳開，下一回合又撲過來，在地上一直有在動，燃燒才甩得掉）。x0 / y0 = 出發的位置
 */
function biteStep(match, e, victim, weapon, refY, cast, back = 0) {
  const dir = victim.x > e.x ? 1 : victim.x < e.x ? -1 : e.facing;
  e.facing = dir;
  const x0 = e.x, y0 = e.y;
  const dx = victim.cx - e.x, dy = victim.cy - e.cy;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const p = bossProjectile(e, weapon, e.x, e.cy, dx / d * weapon.speed, dy / d * weapon.speed);
  for (const f of match.entities) if (f !== victim) p.ignore.add(f);
  p.stopAt = victim;
  const shot = bossShot(match, e, weapon, [p], dir);
  const hit = shot.events.find(ev => ev.target === victim.id);
  const hx = hit ? hit.x : victim.x - dir * (victim.hw + e.hw);
  const spot = standSpot(match, e, hx - dir * back, refY) || { x: x0, y: y0 };
  e.x = spot.x;
  e.y = spot.y;
  e.vx = 0;
  e.vy = 0;
  e.onGround = true;
  e.movedThisTurn += Math.abs(hx - x0) + Math.abs(e.x - hx);
  return withState(match, { action: 'bite', targetId: victim.id, x0, y0, x: e.x, y: e.y, cast, shot });
}

/** 輪到小蜘蛛：撲向最近的人咬一口。回傳 { steps: [招式], next: null, state } */
export function resolveSpiderlingTurn(match, e) {
  const t = nearestPlayerAt(match, e.cx, e.cy);
  const C = CONFIG.SPIDERLING;
  const step = t ? biteStep(match, e, t, CONFIG.WEAPONS.spiderlingBite, t.y, C.cast) : withState(match, { action: 'idle', still: stillResult(match) });
  return { steps: [step], next: null, state: spiderSnapshot(match).spider };
}

/**
 * 女王倒下 → 蛛卵、小蜘蛛、網全部跟著消失（地圖機制的 cascade：勝負判定前、一波結算完；可以重複呼叫）。
 * 回傳 true = 這一次有東西消失
 */
export function witherNest(match) {
  const q = queenOf(match);
  if (!q || q.alive) return false;
  let any = false;
  for (const e of match.entities) {
    if (e.alive && (isEgg(e) || isWeb(e) || isSpiderling(e))) { e.die('wither'); any = true; }
  }
  syncWebs(match);
  return any;
}

/** 這一下有傷害的事件（地圖機制的 eventExtras）：女王被燒到掉下來 / 最後一顆蛋被打破、從背景回來、網被打破放開人。回傳 { queen }，沒換 = {} */
export function spiderEventExtras(match) {
  const change = syncQueen(match);
  syncWebs(match);
  return change ? { queen: change } : {};
}

// ---------- 快照 ----------

export function spiderSnapshot(match) {
  const S = match.mechState;
  return {
    spider: {
      mode: S.mode, cleansed: S.cleansed, next: S.next ? { ...S.next } : null, eggs: S.eggs.map(g => ({ ...g })),
      stuck: { ...S.stuck }, spawned: S.spawned.map(s => ({ ...s })), seq: S.seq,
    },
  };
}

// 套用快照（地形之後、角色狀態之前）：先建出快照裡有、這邊還沒有的蛋 / 網 / 小蜘蛛，再換成快照的狀態。
// 只帶一部分欄位（客戶端收到 turn / turnFx 時只帶 { items }）→ 不動
export function restoreSpider(match, s) {
  const S = spiderState(match);
  const P = s && s.spider;
  if (!S || !P) return;
  for (const spec of P.spawned || []) {
    if (match.byId(spec.id)) continue;
    const { type, ...rest } = spec;
    if (type === 'egg') spawnEgg(match, rest);
    else if (type === 'web') spawnWeb(match, rest);
    else spawnSpiderling(match, rest);
  }
  Object.assign(S, {
    cleansed: !!P.cleansed, next: P.next ? { ...P.next } : null, eggs: (P.eggs || []).map(g => ({ ...g })),
    stuck: { ...(P.stuck || {}) }, spawned: (P.spawned || []).map(x => ({ ...x })), seq: P.seq | 0,
  });
  setMode(match, P.mode || 'hang');
  syncWebs(match);
  const q = queenOf(match);
  if (q) q.hpFloor = floorHp(q, S);
}
