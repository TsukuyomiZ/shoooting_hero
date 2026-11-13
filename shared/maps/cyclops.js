import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { clamp } from '../core/utils.js';
import { makeProjectile, advanceProjectile } from '../physics/weapons.js';
import { buildCave, dropStalactites, standingStalactites } from './cave.js';
import { weightedPick, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// 菁英關「地心探險」的獨眼巨人（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/cyclops.js。這張地圖也是洞穴（鐘乳石、火把，規則在 cave.js），
// 這一場的狀態 match.mechState = 洞穴的狀態（def、lit、fallen）+ 巨人預定的下一招（next）、他出過幾回合（turns）、被超巨石封住的平台（sealed）。
//
// - 巨人站在最右邊的岩柱上（level.mechanic.cyclops），每回合出招前沿著這根岩柱的頂面走一段（CYCLOPS.walk，
//   shared/ai/ai-move.js 的 groundRoam / planGlide；不會走出這根岩柱），不會被擊退、不會落水（fixed）。打倒他 = 過關。
//   血量 CYCLOPS.hp，跟一般敵人一樣依人數、關數放大（菁英關不是 Boss 關：不算首領，弒神者對他沒用）。
// - 平台 = 關卡的 ledges（三根岩柱的頂面，由左到右；巨人站的那根寫在最後）。
// - 下一招是事先排好的（match.mechState.next：開場一次、之後每次用掉就再排，見 planCyclopsNext），玩家回合畫面上會標出來。
//   每回合一個一般招式（猛捶 / 巨石投擲，照權重 CYCLOPS.weights 抽）；另外照他自己的回合數（specialFor，不用亂數），
//   每 CYCLOPS.sealEvery 回合輪一次「超巨石封左高台 → 超巨石封中岩柱 → 震盪獅吼」：
//     猛捶（pound）：捶地，天花板上還在的鐘乳石「全部」震下來（砸到人照 WEAPONS.stalactite，穿過巨人自己），
//                    衝擊沿著「站最多人的那個平台」的頂面跑（poundLane），站在那上面的玩家再多吃一次 WEAPONS.cyclopsShock（往離他遠的那邊推，見 poundStart）。
//                    打哪一個在排到猛捶時就決定好（next.ledge，見 pickPoundLedge），警示帶畫在那上面，出招時不管人跑到哪都打那一個。
//                    被超巨石封住的、這回合要被超巨石封住的平台不算（見 poundLedges）；剩下的只有他自己那根的時候不放猛捶。
//                    鐘乳石掉光了之後，猛捶的權重剩 CYCLOPS.poundBareFactor 倍
//     巨石投擲（throw）：朝每一個活著的玩家各丟一顆巨石（WEAPONS.cyclopsBoulder，拋物線、砸中的人流血），一定砸中。
//                    離他近的先丟，一顆接一顆（每隔 CYCLOPS.throwGap 幀）；每顆只撞得到它瞄的那個人（ignore = 其他所有角色：
//                    不會砸到別人、不會被別人的身體擋住，也砸不到巨人自己）。瞄準沒有誤差、不用亂數（見 aimBoulder）
//     超巨石（seal）：一般招式之後「另外」再丟一顆（next.seal = 第幾個平台），由左往右封住一個平台（左高台 → 中岩柱）：
//                    從頂面一路頂到天花板的一大塊巨石（地形的 BOULDER，炸不壞，見 boulderPoly），
//                    身體碰到那一段的玩家直接死亡（見 crushedPlayers），壓在那一段的鐘乳石一起壓碎、火把壓熄（見 sealLedge）
//     震盪獅吼（roar）：前面的平台都封住了（大家只剩他的岩柱可以站）之後，下一次輪到超巨石時改放這招，佔掉那回合的一般招式：
//                    先擊碎所有超巨石（平台又通了），再朝每個玩家各一道震波（WEAPONS.cyclopsRoar：沒有傷害，水平往外震退）。
//                    之後從封左高台重新輪
// - 猛捶震下來的鐘乳石跟打下來的一樣，是猛捶那一波裡「半路才出現的飛行物」（事件的 falls / adds，見 shared/physics/volley.js）：
//   衝擊的第一個事件（飛過去的 pass，或第一幀就撞到人的 pierce）帶著，客戶端照事件重播
// - 2026-10-19 使用者改版：加上超巨石、震盪獅吼；猛捶先拿掉、同一天又加回來（不打封住 / 要被封住的平台、只剩最後一個平台時不放）

export const CYCLOPS_ACTION_NAMES = {
  pound: '猛捶',
  throw: '巨石投擲',
  seal: '超巨石',
  roar: '震盪獅吼',
  idle: '盯著你們',
};

const SHOCK = 'cyclopsShock';

// 建立巨人（關卡的敵人之後），回傳這一場的狀態（洞穴的狀態 + 預定的下一招、出過幾回合、被封住的平台）。hpScale = 一般敵人的血量倍率（人數 × 關數）
export function buildCyclops(match, hpScale) {
  const def = match.level.mechanic;
  const c = def.cyclops;
  const state = { ...buildCave(match), next: null, turns: 0, sealed: [] };
  match.entities.push(new Entity({
    ...CONFIG.ENEMY, id: 'cyclops', name: '獨眼巨人', team: 'enemies', controller: 'ai', slot: 0, facing: -1,
    x: c.x, y: c.y, hw: c.hw, h: c.h, hp: Math.round(CONFIG.CYCLOPS.hp * hpScale),
    fixed: true, part: 'cyclops', weapons: ['cyclopsBoulder'],
  }));
  return state;
}

// 這一場的狀態（match.mechState）。別張地圖（沒有 next 或沒有洞穴的 lit）當作沒有巨人
const cyclopsState = (match) => (match.mechState && Array.isArray(match.mechState.lit) && 'next' in match.mechState ? match.mechState : null);

// 三根岩柱的頂面 { x0, x1, y, name }（由左到右；巨人站的那根寫在最後）
const ledgesOf = (match) => match.level.mechanic.ledges;

// 超巨石封得住幾個平台：巨人站的最後一根以外的（由左往右封）
export const sealableCount = (match) => ledgesOf(match).length - 1;

// 平台的名字（畫面、橫幅用）
export const ledgeName = (match, i) => (ledgesOf(match)[i] && ledgesOf(match)[i].name) || `第 ${i + 1} 個平台`;

// 他自己的第 n 回合（從 1 數）除了一般招式之外的事：每 sealEvery 回合輪一次「封左高台 → 封中岩柱 → 震盪獅吼」：
// { seal: 要封的平台 } / { roar: true }；其他回合 = null。sealEvery 不是正數 = 從來沒有。不用亂數
export function specialFor(match, n) {
  const every = Math.round(CONFIG.CYCLOPS.sealEvery || 0);
  if (!(every > 0) || n % every !== 0) return null;
  const seals = sealableCount(match);
  const phase = (n / every - 1) % (seals + 1);
  return phase < seals ? { seal: phase } : { roar: true };
}

// 排下一招（開場、每次出完招之後），照他下一回合是第幾回合：
//   震盪獅吼的回合 = { action: 'roar' }（不抽一般招式）；
//   其他回合抽一般招式（weights：猛捶 / 巨石投擲；鐘乳石掉光了猛捶 × poundBareFactor；猛捶沒有平台可打 = 0）：
//   { action: 'throw' } / { action: 'pound', ledge: 打哪個平台（照現在大家站的位置挑）}，有超巨石的回合再帶 seal
export function planCyclopsNext(match) {
  const S = cyclopsState(match);
  if (!S) return null;
  const sp = specialFor(match, S.turns + 1);
  if (sp && sp.roar) return (S.next = { action: 'roar' });
  const seal = sp ? sp.seal : undefined;
  const ledges = poundLedges(match, seal);
  const W = CONFIG.CYCLOPS.weights;
  const bare = standingStalactites(match).length === 0;
  const pound = ledges.length ? Math.max(0, W.pound || 0) * (bare ? CONFIG.CYCLOPS.poundBareFactor : 1) : 0;
  const action = weightedPick(match.rng, [['pound', pound], ['throw', W.throw]]) || 'throw';
  const next = action === 'pound' ? { action, ledge: pickPoundLedge(match, match.byId('cyclops'), ledges) } : { action };
  if (Number.isInteger(seal)) next.seal = seal;
  return (S.next = next);
}

// 輪到巨人：出預定的那一招並直接結算好，再排下一招。回傳 { steps: [招式…], next }（格式同 Boss）。
// 有超巨石的回合是兩招：一般招式（猛捶 / 巨石投擲）、超巨石（一般招式把人全打倒了就不丟）
export function resolveCyclopsTurn(match, cy) {
  const S = cyclopsState(match);
  const plan = (S && S.next) || planCyclopsNext(match) || { action: 'throw' };
  if (S) S.turns++;
  const ledge = plan.action === 'pound' ? poundLedge(match, plan) : null;
  const steps = [plan.action === 'roar' ? roarStep(match, cy) : ledge !== null ? poundStep(match, cy, ledge) : throwStep(match, cy)];
  if (plan.action !== 'roar' && Number.isInteger(plan.seal) && match.players.some(e => e.alive)) {
    const seal = sealStep(match, cy, plan.seal);
    if (seal) steps.push(seal);
  }
  planCyclopsNext(match);
  return { steps, next: S && S.next ? { ...S.next } : null };
}

// ---------- 猛捶 ----------

// 猛捶打得到的平台（ledges 的索引）：被超巨石封住的、這回合要被超巨石封住的（seal）不算。
// 剩下的只有他自己那根（最後一根）= 不放猛捶，回傳 []
export function poundLedges(match, seal) {
  const S = cyclopsState(match);
  const last = ledgesOf(match).length - 1;
  const out = ledgesOf(match).map((_, i) => i).filter(i => !(S && S.sealed.includes(i)) && i !== seal);
  return out.some(i => i !== last) ? out : [];
}

// 猛捶的衝擊沿著第 i 個平台跑的那條線：頂面上方一點（腳踩在上面的人才碰得到；半空中、別的平台上的人碰不到）。
// x0 / x1 = 頂面的左右端（畫面的警示帶也照這個畫）
export function poundLane(match, i) {
  const L = ledgesOf(match)[i];
  return { y: L.y - 6, x0: L.x0, x1: L.x1, top: L.y - 34, bottom: L.y };
}

// 衝擊從哪裡出發：頂面上離巨人最近的那一點（他自己那根 = 他腳下，往兩邊跑；別根 = 靠他那一端，往另一端跑）。畫面的碎石照這個噴
export const poundOrigin = (lane, cy) => clamp(cy.x, lane.x0, lane.x1);

// 衝擊實際出發的那一點（伺服器算，客戶端照廣播的飛行物重播）：他自己那根 = poundOrigin（腳下）；
// 別根 = 靠他那一端再往他那邊多退一段（最胖的玩家半寬 + 衝擊的判定半徑 + 2）。腳在頂面的範圍內（含半個身寬）就算站在平台上，
// 身體中心可能超出那一端一點點：衝擊要從這種人靠巨人的那一側撞上去，擊退（撞擊點 → 身體中心）才會往外推，不會把人推回巨人那邊的水裡。
// 多跑的那一段在兩根岩柱中間的半空（沒有站得住人的地方），畫面也不畫（client/map-views/cyclops.js 的 laneAt）
export function poundStart(match, lane, cy) {
  const ox = poundOrigin(lane, cy);
  if (cy.x >= lane.x0 && cy.x <= lane.x1) return ox;
  const hw = match.players.reduce((w, e) => (e.alive ? Math.max(w, e.hw) : w), 0);
  const lead = hw + CONFIG.WEAPONS[SHOCK].hitRadius + 2;
  return cy.x > lane.x1 ? ox + lead : ox - lead;
}

// 角色站在哪個平台上（= 衝擊碰得到他）：腳在頂面的左右範圍內（含半個身寬）、身體碰得到衝擊那條線。
// 半空中、掉進深坑、在水裡的都不算（回傳 -1）
export function ledgeOf(match, e) {
  const r = CONFIG.WEAPONS[SHOCK].hitRadius;
  return ledgesOf(match).findIndex((L, i) => e.x >= L.x0 - e.hw && e.x <= L.x1 + e.hw && e.containsPoint(e.x, poundLane(match, i).y, r));
}

// 猛捶要打的平台（只在 ledges = 打得到的平台裡挑，見 poundLedges）：站最多活著的玩家的那個。
// 一樣多（包括都沒人站在平台上）就挑離巨人最近的，他自己那根最優先。不用亂數
export function pickPoundLedge(match, cy, ledges = poundLedges(match)) {
  const L = ledgesOf(match);
  const counts = L.map(() => 0);
  for (const e of match.players) {
    if (!e.alive) continue;
    const i = ledgeOf(match, e);
    if (i >= 0) counts[i]++;
  }
  const own = cy ? ledgeOf(match, cy) : -1;
  const home = own >= 0 ? own : L.length - 1;
  const cx = cy ? cy.x : L[home].x1;
  const gap = (i) => (i === home ? -1 : Math.max(0, L[i].x0 - cx, cx - L[i].x1));
  let best = null;
  for (const i of ledges) if (best === null || counts[i] > counts[best] || (counts[i] === counts[best] && gap(i) < gap(best))) best = i;
  return best;
}

// 預定的猛捶打哪個平台（畫面的警示帶、出招都用這個）：預定裡帶的 ledge（還打得到的話）；
// 沒帶 / 已經被封住了就照現在大家站的位置重挑；沒有平台可打回傳 null（改丟巨石）
export function poundLedge(match, plan) {
  const ledges = poundLedges(match, plan && plan.seal);
  const i = plan && plan.ledge;
  if (Number.isInteger(i) && ledges.includes(i)) return i;
  return ledges.length ? pickPoundLedge(match, match.byId('cyclops'), ledges) : null;
}

// 猛捶：衝擊從平台頂面上離巨人最近的那一點出發（poundStart），往左、往右跑到頂面的兩端就停（range：平台外面的人打不到）。
// 他自己那根 = 從他腳下往兩邊兩道；別根 = 從靠他那一端（再往他那邊退一點）往另一端一道，都往離他遠的方向推。
// 兩道共用「打過誰」：兩道都碰得到的人也只挨一次。step.ledge = 打的是哪個平台（ledges 的索引；紀錄、畫面都看這個）
function poundStep(match, cy, ledge) {
  const weapon = CONFIG.WEAPONS[SHOCK];
  const lane = poundLane(match, ledge);
  const ox = poundStart(match, lane, cy);
  const hitOnce = new Set();
  const projs = [];
  for (const dir of [-1, 1]) {
    const len = dir < 0 ? ox - lane.x0 : lane.x1 - ox;
    if (!(len > 0)) continue;
    const p = bossProjectile(cy, weapon, ox, lane.y, dir * weapon.speed, 0);
    p.range = len;
    p.ignore = hitOnce;
    projs.push(p);
  }
  return { action: 'pound', ledge, shot: bossShot(match, cy, weapon, projs, cy.facing) };
}

// 猛捶的衝擊一出發（第一個事件）就把天花板上還在的鐘乳石全部震下來：回傳 { falls, adds }（都掉光了 = null）。
// 掉下來的鐘乳石穿過巨人自己（他頭上那根不會砸到他）
export function shakeStalactites(match) {
  if (!cyclopsState(match)) return null;
  const ks = standingStalactites(match);
  if (!ks.length) return null;
  const r = dropStalactites(match, ks, { passAllies: true });
  return r.falls.length ? r : null;
}

// 地圖機制的 struck / passed 用：這是不是猛捶的衝擊
export const isShock = (weaponId) => weaponId === SHOCK;

// ---------- 超巨石 ----------

// 超巨石的形狀（伺服器、客戶端、重連都照這個算，一模一樣）：第 i 個平台頂面上的一大塊石頭，
//   底 = 平台的頂面（ledges[i].y，從 x0 到 x1；頂面要平，不能包到土，見 Terrain.addBoulder）、頂 = BOULDER_TOP（比天花板最低的地方還高：
//   只填空的像素，天花板不動，所以跟天花板之間沒有縫）、兩側越往上越往外撐（最多 BOULDER_FLARE px：側面往下內縮，不會有站得住的地方；
//   平台在地圖最左邊的那一側就是地圖邊）。由下往上的側面：[高度比例, 往外撐的比例]
const BOULDER_TOP = 28, BOULDER_FLARE = 16;
const BOULDER_SIDE = [[0, 0], [0.1, 0.22], [0.27, 0.38], [0.45, 0.6], [0.63, 0.72], [0.8, 0.9], [1, 1]];
export function boulderPoly(match, i) {
  const L = ledgesOf(match)[i];
  const W = match.terrain.w;
  const H = L.y - BOULDER_TOP;
  const right = BOULDER_SIDE.map(([h, k]) => [Math.min(W, L.x1 + BOULDER_FLARE * k), L.y - H * h]);
  const left = L.x0 <= 0
    ? [[0, BOULDER_TOP], [0, L.y]]
    : BOULDER_SIDE.map(([h, k]) => [Math.max(0, L.x0 - BOULDER_FLARE * k), L.y - H * h]).reverse();
  return [...right, ...left];
}

// 超巨石佔的左右範圍（多邊形的外框）：身體碰到這一段的玩家會被壓死
export function boulderSpan(match, i) {
  const poly = boulderPoly(match, i);
  return { x0: Math.min(...poly.map(p => p[0])), x1: Math.max(...poly.map(p => p[0])), y0: BOULDER_TOP, y1: ledgesOf(match)[i].y };
}

// 超巨石砸下去會壓死的玩家：活著、身體（左右）碰到那一段的（站在頂面上、躲在那根岩柱的坑裡都算；
// 大家都站好了才出招，所以碰到那一段的一定是站在那根岩柱上）。照玩家的順序
export function crushedPlayers(match, i) {
  const s = boulderSpan(match, i);
  return match.players.filter(e => e.alive && e.x + e.hw > s.x0 && e.x - e.hw < s.x1);
}

// 第 i 個平台被超巨石封住（伺服器結算、客戶端播到砸下去那一刻都呼叫這個，結果一樣）：
// 壓在那一段的鐘乳石壓碎（從地形拿掉、記進 fallen，不會掉下來砸人）、那一段的火把壓熄（lit = null）、巨石放進地形。
// 回傳 { rocks（壓碎的鐘乳石）, torches（壓熄的火把）, rect（要重畫的矩形）}；已經封住了 / 不是這張地圖回傳 null。
// 壓死人不在這裡（伺服器在 sealStep 先處理，客戶端照招式帶的 killed）
export function sealLedge(match, i) {
  const S = cyclopsState(match);
  if (!S || S.sealed.includes(i) || !(i >= 0 && i < sealableCount(match))) return null;
  const T = match.terrain;
  const s = boulderSpan(match, i);
  const rocks = standingStalactites(match).filter(k => T.stalactites[k].x1 > s.x0 && T.stalactites[k].x0 < s.x1);
  for (const k of rocks) { T.dropStalactite(k); S.fallen.push(k); }
  const torches = [];
  S.def.torches.forEach((t, j) => {
    if (t.x > s.x0 && t.x < s.x1 && S.lit[j] !== null) { S.lit[j] = null; torches.push(j); }
  });
  const rect = T.addBoulder(boulderPoly(match, i));
  S.sealed.push(i);
  return { rocks, torches, rect };
}

// 擊碎所有超巨石（震盪獅吼）：從地形拿掉，平台又通了（壓碎的鐘乳石、壓熄的火把不會回來）。
// 回傳 { shattered（照封住的順序）, rects（要重畫的矩形）}
export function shatterBoulders(match) {
  const S = cyclopsState(match);
  if (!S || !S.sealed.length) return { shattered: [], rects: [] };
  const shattered = S.sealed.slice();
  const rects = shattered.map(i => match.terrain.removeBoulder(boulderPoly(match, i)));
  S.sealed = [];
  return { shattered, rects };
}

// 套用快照的「被封住的平台」（地形已經照洞重建過，或還是原本那份）：先把這邊有的拿掉、再照快照放回去
// （重建過的地形本來就沒有巨石，拿掉是空操作）。壓碎的鐘乳石已經由洞穴的 restore 照 fallen 拿掉了
export function restoreSealed(match, list) {
  const S = cyclopsState(match);
  if (!S) return;
  for (const i of S.sealed) match.terrain.removeBoulder(boulderPoly(match, i));
  S.sealed = [];
  for (const i of list) {
    if (!(i >= 0 && i < sealableCount(match)) || S.sealed.includes(i)) continue;
    match.terrain.addBoulder(boulderPoly(match, i));
    S.sealed.push(i);
  }
}

// 超巨石那一招：先壓死碰到那一段的玩家（直接死亡：不吃無敵、減傷，剩下的血全算承受傷害），再封住平台（sealLedge），大家落地。
// 被壓到、當場被效果救回來的（例如人工心臟）不算壓死：封好之後放到最近站得住的地方（同落水的重生點），不會卡在石頭裡。
// 回傳 { action: 'seal', ledge, killed（壓死的玩家 id）, rocks, torches, cast, still }；已經封住了回傳 null
function sealStep(match, cy, i) {
  const S = cyclopsState(match);
  if (!S || S.sealed.includes(i) || !(i >= 0 && i < sealableCount(match))) return null;
  const crushed = crushedPlayers(match, i);
  for (const e of crushed) { e.taken += e.hp; e.die('crushed'); }
  const killed = crushed.filter(e => !e.alive);
  const { rocks, torches } = sealLedge(match, i);
  for (const e of crushed) {
    const spot = e.alive ? e.respawnSpot(match.terrain) : null;
    if (spot) Object.assign(e, { x: spot.x, y: spot.y, vx: 0, vy: 0, onVine: -1 });
  }
  return { action: 'seal', ledge: i, killed: killed.map(e => e.id), rocks, torches, cast: CONFIG.CYCLOPS.sealCast, still: stillResult(match) };
}

// ---------- 震盪獅吼 ----------

// 震盪獅吼：先擊碎所有超巨石，再朝每個活著的玩家各一道震波（WEAPONS.cyclopsRoar，沒有傷害）：從巨人身體中心的 x（往那個人那邊偏 1px 的反方向，
// 貼在他身上的人也是從他那一側被打到）、那個人身體中心的高度出發，水平衝向他（穿過地形、只撞得到他）。
// 撞擊點跟他的身體中心一樣高，擊退（撞擊點 → 身體中心）就是水平往外：在巨人左邊的往左、右邊的往右。
// 回傳 { action: 'roar', shattered（擊碎的超巨石是哪幾個平台的）, targetIds（照離他的遠近）, cast, shot }
function roarStep(match, cy) {
  const { shattered } = shatterBoulders(match);
  const targets = playersByDistance(match, cy);
  const weapon = CONFIG.WEAPONS.cyclopsRoar;
  const info = { action: 'roar', shattered, targetIds: targets.map(t => t.id), cast: CONFIG.CYCLOPS.roarCast };
  if (!targets.length) return { ...info, still: stillResult(match) };
  const projs = targets.map(t => {
    const dir = t.cx >= cy.cx ? 1 : -1;
    const p = bossProjectile(cy, weapon, cy.cx - dir, t.cy, dir * weapon.speed, 0);
    p.ignore = othersThan(match, t);
    return p;
  });
  return { ...info, shot: bossShot(match, cy, weapon, projs, cy.facing) };
}

// ---------- 巨石投擲 ----------

// 巨石投擲：朝每一個活著的玩家各丟一顆（離他近的先丟；一樣近的照玩家的順序），第 k 顆在第 1 + k × CYCLOPS.throwGap 幀出手。
// 面向第一個目標那邊。每顆照 aimBoulder 瞄（一定砸中），只撞得到它瞄的那個人。不用亂數。
// 回傳 { action: 'throw', targetIds（照出手的順序）, shot }。沒有目標（不會發生：玩家全倒就結束了）就發呆
function throwStep(match, cy) {
  const targets = playersByDistance(match, cy);
  if (!targets.length) return { action: 'idle', still: stillResult(match) };
  const weapon = CONFIG.WEAPONS.cyclopsBoulder;
  const facing = targets[0].cx >= cy.cx ? 1 : -1;
  cy.facing = facing;
  const m = cy.muzzle();
  const gap = Math.max(0, Math.round(CONFIG.CYCLOPS.throwGap || 0));
  const projs = targets.map((t, k) => {
    const aim = aimBoulder(match, cy, t, 1 + k * gap);
    const p = bossProjectile(cy, weapon, m.x, m.y, aim.vx, aim.vy);
    p.spawn = 1 + k * gap;
    p.ignore = othersThan(match, t);
    p.passTerrain = aim.passTerrain;
    return p;
  });
  return { action: 'throw', targetIds: targets.map(t => t.id), shot: bossShot(match, cy, weapon, projs, facing) };
}

// 活著的玩家，離巨人（身體中心）近的排前面；一樣近的照玩家的順序（sort 是穩定的）
function playersByDistance(match, cy) {
  const d2 = (e) => (e.cx - cy.cx) * (e.cx - cy.cx) + (e.cy - cy.cy) * (e.cy - cy.cy);
  return match.players.filter(e => e.alive).map(e => ({ e, d: d2(e) })).sort((a, b) => a.d - b.d).map(o => o.e);
}

// 巨石的 ignore：除了 target 以外的所有角色（包括巨人自己）。巨石只撞得到 target：不會砸到別人，也不會被別人的身體擋下來。
// 只在伺服器用：客戶端重播不做碰撞（撞到誰照伺服器的事件），所以不用送
const othersThan = (match, target) => new Set(match.entities.filter(e => e !== target));

// 巨石投擲的拋物線（只在伺服器算）：
//   THROW_LIFT       想要的頂點比兩端較高的那一端再高多少 px（照這個算出「最自然」的飛行幀數，從那裡開始試）
//   THROW_CEIL       頂點最高到哪（y；再上去就碰到天花板了：比這高的拋物線不試）
//   THROW_MIN_FRAMES 最少飛幾幀（再少就是直直射過去了）
const THROW_LIFT = 90, THROW_CEIL = 64, THROW_MIN_FRAMES = 12;

// 巨石剛好飛 N 幀（advanceProjectile 呼叫 N 次）之後落在 (X, Y) 的初速 { vx, vy }（g = 重力）。
// advanceProjectile 每一幀照那一幀開始時的速度切子步（約 2px 一步，半隱式歐拉法），N 幀之後剛好是
//   x = x0 + vx·T、y = y0 + vy·T + g·T²/2 + (g·dt²/2)·Σ 1/s_n（T = N·dt，s_n = 第 n 幀的子步數）；
// s_n 又看 vy，照這個式子代回去算幾次就不再變了（跟真的飛 N 幀的位置差不到 1e-10 px；
// 少數某一幀的子步數剛好卡在邊界上的，會在兩個解之間來回跳，差也不到 0.001 px）。
// 子步數跟 advanceProjectile 一樣用 Math.hypot 算：只在伺服器算，客戶端照廣播的初速重播、不重算
export function exactLaunch(x0, y0, X, Y, N, g) {
  const dt = CONFIG.FIXED_DT;
  const T = N * dt;
  const vx = (X - x0) / T;
  const base = Y - y0 - g * T * T / 2;
  let vy = base / T;
  for (let it = 0; it < 8; it++) {
    let inv = 0;
    for (let n = 0; n < N; n++) inv += 1 / Math.max(1, Math.ceil(Math.hypot(vx, vy + n * g * dt) * dt / 2));
    const next = (base - g * dt * dt / 2 * inv) / T;
    if (next === vy) break;
    vy = next;
  }
  return { vx, vy };
}

// 從 y0 拋到 Y、頂點在 ya（比兩端都高）的拋物線大約飛幾幀：上去的時間 + 下來的時間
const framesVia = (y0, Y, ya, g) => Math.round((Math.sqrt(2 * (y0 - ya) / g) + Math.sqrt(2 * (Y - ya) / g)) / CONFIG.FIXED_DT);

// 試飛：照真的 advanceProjectile 在真的地形上飛（ignore = 撞不到的角色），最多 frames 幀。第一個撞到的是 target 回傳 true
function dryRun(match, cy, weapon, target, ignore, m, v, passTerrain, frames) {
  const p = makeProjectile(cy, weapon, m.x, m.y, v.vx, v.vy);
  p.ignore = ignore;
  p.passTerrain = passTerrain;
  for (let f = 0; f < frames; f++) {
    const hit = advanceProjectile(match.world, p, CONFIG.FIXED_DT);
    if (hit) return hit.type === 'entity' && hit.entity === target;
  }
  return false;
}

// 瞄 target 的那一顆（從巨人的砲口出發、在一波的第 spawn 幀出手）：回傳 { vx, vy, frames, passTerrain, hit }。
// 先照想要的頂點（兩端較高的那一端再高 THROW_LIFT，最高到 THROW_CEIL）算出「最自然」的飛行幀數 pref，
// 從 pref 開始往兩邊一個一個試（pref、pref − 1、pref + 1、…）：照 exactLaunch 算出剛好飛那麼多幀砸到他身體中心的初速，
// 拿真的 advanceProjectile 在真的地形上試飛（只撞得到 target，見 othersThan），第一條撞到他的就用它。
// 不試的：出手比武器力量 100 的速度（minSpeed + 100 × speedPerPower）還快的（太平太快，像子彈）、頂點比 THROW_CEIL 還高的、
// 一波結束前（TIMING.maxShotSeconds）飛不到的。
// 每一條都被地形擋住（例如他躲在深坑裡、整條路都被鐘乳石擋住）就讓這顆穿過地形（passTerrain），從 pref 那條開始試飛確認。
// N 幀之後剛好在他身體中心、路上只撞得到他、不會落水或飛出場外（兩端都在場內、水面上，拋物線不會比兩端低），所以一定砸中；
// hit = 試飛確認砸中了（防呆：正常一定是 true）。一波裡角色都站好不動、巨石不挖地，試飛時不用推進別人。只在伺服器跑
export function aimBoulder(match, cy, target, spawn = 1) {
  const weapon = CONFIG.WEAPONS.cyclopsBoulder;
  const g = weapon.gravity;
  const m = cy.muzzle();
  const X = target.cx, Y = target.cy;
  const ignore = othersThan(match, target);
  const left = Math.round(CONFIG.TIMING.maxShotSeconds * 60) - spawn + 1;   // 一波結束前這顆還能飛幾幀（見 volley.js 的 maxFrames）
  const maxSpeed = weapon.minSpeed + 100 * weapon.speedPerPower;
  const top = Math.min(m.y, Y);
  const ceil = Math.min(top, THROW_CEIL);
  const hi = Math.min(left, g > 0 ? framesVia(m.y, Y, ceil, g) : left);
  const natural = g > 0
    ? framesVia(m.y, Y, Math.min(top, Math.max(THROW_CEIL, top - THROW_LIFT)), g)
    : Math.round(Math.hypot(X - m.x, Y - m.y) / maxSpeed / CONFIG.FIXED_DT);
  const pref = clamp(natural, THROW_MIN_FRAMES, Math.max(THROW_MIN_FRAMES, hi));
  const order = [];
  for (let d = 0; pref - d >= THROW_MIN_FRAMES || pref + d <= hi; d++) {
    for (const N of d ? [pref - d, pref + d] : [pref]) if (N >= THROW_MIN_FRAMES && N <= hi) order.push(N);
  }
  const launch = (N) => exactLaunch(m.x, m.y, X, Y, N, g);
  for (const N of order) {   // 乾淨的拋物線（碰不到地形）
    const v = launch(N);
    if (Math.sqrt(v.vx * v.vx + v.vy * v.vy) > maxSpeed) continue;
    if (dryRun(match, cy, weapon, target, ignore, m, v, false, left)) return { ...v, frames: N, passTerrain: false, hit: true };
  }
  for (const N of order) {   // 穿過地形
    const v = launch(N);
    if (dryRun(match, cy, weapon, target, ignore, m, v, true, left)) return { ...v, frames: N, passTerrain: true, hit: true };
  }
  return { ...launch(pref), frames: pref, passTerrain: true, hit: false };
}
