import { CONFIG } from '../core/config.js';
import { clamp } from '../core/utils.js';

// 洞穴地形（地圖「岩穴」）的規則：鐘乳石與火把（伺服器與客戶端共用）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/cave.js。這一場的狀態在 match.mechState（buildCave 建的那一份）。
//
// - 鐘乳石：天花板垂下來的地形（level.stalactites，遮罩值 STALACTITE，見 terrain.js）。擋子彈、炸不壞；
//   被任何一方的飛行物打到（直擊那一根、或爆炸範圍碰到）就整根掉下來：從遮罩拿掉，變成一顆從尖端開始自由落下的飛行物
//   （WEAPONS.stalactite，事件的 adds，見 shared/physics/volley.js），砸到第一個角色（傷害算打下它的人的攻擊）或落地就碎掉
// - 火把：level.mechanic.torches = [{ x, y（底部，插在地上 / 平台上）, lit（一開始就亮著）, faint（光很微弱）, light（這支的光圈半徑，沒寫 = CAVE.torchLight）}]。
//   玩家方的攻擊打在火把旁邊（離火把 CAVE.torchReach px 內，爆炸的話再加上爆炸半徑）、或玩家自己走過去碰到，就點燃。
//   還亮著但已經變暗的也一樣：隨時都能補回最亮（2026-10-08 使用者：「隨時都能補滿，都沒被擊中才會慢慢熄掉」）。
//   火把會燒完：點燃 / 補滿的那一輪亮度 CAVE.torchRounds（3，最亮），之後每一輪開始暗一格（3 → 2 → 1），
//   一直沒人去點就 3 輪後熄滅（0）。一開始就亮著的火把算第 1 輪點燃的。
//   亮度不另外存：狀態記的是每支火把「第幾輪點燃的」，亮度照現在的輪數（match.round）推出來（torchLevel）——
//   伺服器、客戶端（照伺服器的訊息設輪數）、重連都算得一樣，變暗 / 熄滅不用另外廣播。
//   會颳風的對戰（狀態的 windy = true：巨蠍巢穴的多人）：每一輪開始一陣強風把火把全部吹熄，只有這一輪點燃的亮著
// - 陰影：不在任何一支亮著的火把的光圈裡（光圈半徑照亮度縮小，torchLight；畫面的照明也照這個畫）。
//   站在陰影裡的敵人造成的傷害 +CAVE.shadowDamagePct%（地圖機制的 attackMult：看結算傷害那一下他身體中心在不在陰影裡）。
//   照明是畫面（client/map-views/cave.js）：看不到的地方一樣打得到

export const TORCH_H = 34;   // 火把的高度（底部到火焰）

// 這一輪點燃的火把記成第幾輪：還沒開打（第 0 輪）算第 1 輪，第 1 輪才是最亮的
const litRound = (match) => Math.max(1, match.round);

// 第 i 支火把點得燃 / 補得滿嗎：這一輪還沒點過（熄著、或已經變暗）。這一輪點過的就是最亮了，
// 不再重複點（子彈每一幀都從旁邊飛過也只記一次事件）
const canLight = (match, S, i) => S.lit[i] !== litRound(match);

// 建立這一場洞穴的狀態（地圖機制的 build 回傳給 Match，存成 match.mechState）：
// lit = 每支火把第幾輪點燃的（null = 沒點過；燒完了也還記著，亮度照輪數推），fallen = 掉下來的鐘乳石（照掉的順序）
export function buildCave(match) {
  const def = match.level.mechanic;
  return { def, lit: (def.torches || []).map(t => (t.lit ? litRound(match) : null)), fallen: [] };
}

// 這一場洞穴的狀態（match.mechState）。一般小關（null）、別張地圖的狀態（沒有 lit）都當作沒有洞穴
const caveState = (match) => (match.mechState && Array.isArray(match.mechState.lit) ? match.mechState : null);

// 第 at 輪點燃的火把在第 round 輪的亮度：CAVE.torchRounds（點燃的那一輪）→ 每過一輪少 1 → 0 = 熄了（at 不是數字 = 沒點過，0）
function levelAt(at, round) {
  if (!Number.isFinite(at)) return 0;
  const R = CONFIG.CAVE.torchRounds;
  return clamp(R - Math.max(0, round - at), 0, R);
}

// 第 i 支火把在第 round 輪的亮度。會颳風的對戰（狀態的 windy，例如巨蠍巢穴的多人，見 scorpion.js 的 buildScorpion）：每一輪開始一陣強風把火把全部吹熄，
// 只有這一輪點燃的亮著（最亮）
function levelOf(S, i, round) {
  const at = S.lit[i];
  if (S.windy && at !== Math.max(1, round)) return 0;
  return levelAt(at, round);
}

// 第 i 支火把現在的亮度（0 = 熄著）：照 match.round 推。不是洞穴的地圖一律 0
export function torchLevel(match, i) {
  const S = caveState(match);
  return S ? levelOf(S, i, match.round) : 0;
}

// 火焰的位置
export const flameOf = (t) => ({ x: t.x, y: t.y - TORCH_H });

// 亮度 level 的火把光圈有多大（最亮 = 1）：最暗那一格 CAVE.dimLight，中間照比例；熄了 = 0
export function lightScale(level) {
  const C = CONFIG.CAVE;
  if (!(level > 0)) return 0;
  if (!(C.torchRounds > 1)) return 1;
  return Math.min(1, C.dimLight + (1 - C.dimLight) * (level - 1) / (C.torchRounds - 1));
}

// 火把 t 在亮度 level 時的光圈：圓心（火焰上方一點）、半徑（CAVE.torchLight，出生點那支微弱的 faintLight，
// 關卡給這支火把自己的 light 就照它，再照亮度縮小）。陰影的判定（inShadow）與畫面的照明（client/map-views/cave.js）都照這個
export function torchLight(t, level) {
  const f = flameOf(t);
  const r = t.faint ? CONFIG.CAVE.faintLight : t.light ?? CONFIG.CAVE.torchLight;
  return { x: f.x, y: f.y - 6, r: r * lightScale(level) };
}

// (x, y) 在不在陰影裡：洞穴裡、不在任何一支亮著的火把的光圈裡（光圈的邊上算照得到）。不是洞穴的地圖沒有陰影（false）
export function inShadow(match, x, y) {
  const S = caveState(match);
  if (!S) return false;
  return !S.def.torches.some((t, i) => {
    const L = torchLight(t, torchLevel(match, i));
    return L.r > 0 && (x - L.x) * (x - L.x) + (y - L.y) * (y - L.y) <= L.r * L.r;
  });
}

// 攻擊者這一下的傷害倍率（地圖機制的 attackMult）：敵人在陰影裡（結算傷害的這一下、身體中心）×(1 + CAVE.shadowDamagePct%)。
// 掉下來的鐘乳石不算（敵人打下來的也一樣：那是石頭砸人，不是他出手）；玩家方、沒有攻擊者、不是洞穴 = 1
export function shadowMult(match, attacker, weapon) {
  if (!attacker || attacker.team !== 'enemies' || (weapon && weapon.id === 'stalactite')) return 1;
  return inShadow(match, attacker.cx, attacker.cy) ? 1 + (CONFIG.CAVE.shadowDamagePct || 0) / 100 : 1;
}

// 新的一輪開始（地圖機制的 roundStart，輪數已經加過）：這一輪變暗 / 熄滅的火把推進 fx 給紀錄
// （{ type: 'torchDim' | 'torchOut', torch: 第幾支, light: 現在的亮度 }）。亮度照輪數推，狀態不用改
export function roundCave(match, fx) {
  const S = caveState(match);
  if (!S) return;
  S.lit.forEach((at, i) => {
    const now = levelOf(S, i, match.round);
    if (now < levelOf(S, i, match.round - 1)) fx.push({ type: now > 0 ? 'torchDim' : 'torchOut', torch: i, light: now });
  });
}

// (x, y) 離火把（底部到火焰的那一段）多遠
function torchDist(t, x, y) {
  const dx = x - t.x;
  const dy = y - clamp(y, t.y - TORCH_H, t.y);
  return Math.sqrt(dx * dx + dy * dy);
}

// 一顆飛行物撞到東西（地圖機制的 struck）：打到 / 炸到的鐘乳石掉下來、打在火把旁邊就點燃 / 補滿（只有玩家方）。
// 回傳要附在事件上的 { falls, adds, lights }（沒有的欄位不帶；什麼都沒有 = null）
export function struckCave(match, owner, at) {
  const S = caveState(match);
  if (!S) return null;
  const T = match.terrain;
  const hitK = at.type === 'terrain' ? T.stalactiteAt(at.x, at.y) : -1;
  const falls = [];
  for (let k = 0; k < T.stalactites.length; k++) {
    if (k === hitK || (at.blast > 0 && T.stalactiteInCircle(k, at.x, at.y, at.blast))) falls.push(k);
  }
  const { adds } = dropStalactites(match, falls);
  const lights = [];
  if (owner && owner.team === 'players') {
    S.def.torches.forEach((t, i) => {
      if (canLight(match, S, i) && torchDist(t, at.x, at.y) <= at.blast + CONFIG.CAVE.torchReach) {
        S.lit[i] = litRound(match);
        lights.push(i);
      }
    });
  }
  if (!falls.length && !lights.length) return null;
  return { ...(falls.length ? { falls, adds } : {}), ...(lights.length ? { lights } : {}) };
}

/// 第 ks 根鐘乳石掉下來（從地形拿掉、記進 fallen）：回傳要附在事件上的 { falls, adds }（adds = 從尖端開始落下的飛行物，見 shared/physics/volley.js）。
// passAllies = 掉下來的鐘乳石穿過打下它的那一隊（獨眼巨人自己震下來的不會砸到他）。已經掉了的跳過
export function dropStalactites(match, ks, { passAllies = false } = {}) {
  const S = match.mechState;
  const T = match.terrain;
  const falls = [], adds = [];
  for (const k of ks) {
    if (!T.dropStalactite(k)) continue;
    S.fallen.push(k);
    falls.push(k);
    const tip = T.stalactites[k].tip;
    adds.push({ w: 'stalactite', k, x: tip.x, y: tip.y, vx: 0, vy: 0, ...(passAllies ? { passAllies: true } : {}) });
  }
  return { falls, adds };
}

// 還沒掉下來的鐘乳石（第幾根）
export function standingStalactites(match) {
  const T = match.terrain;
  return T.stalactites.map((s, k) => k).filter(k => !T.fallen.has(k));
}

// 飛行物這一幀從 (x0, y0) 飛到 (x1, y1)、沒撞到東西（地圖機制的 passed）：玩家方的飛行物從火把旁邊飛過去
// （離火把 CAVE.torchPass + 飛行物的判定半徑以內）就點燃 / 補滿。回傳 { lights }，沒有 = null。每顆飛行物每一幀都會呼叫：先用外框排除
export function passCave(match, owner, seg) {
  const S = caveState(match);
  if (!S || !owner || owner.team !== 'players') return null;
  const reach = CONFIG.CAVE.torchPass + (seg.r || 0);
  const lights = [];
  S.def.torches.forEach((t, i) => {
    if (!canLight(match, S, i)) return;
    if (Math.max(seg.x0, seg.x1) < t.x - reach || Math.min(seg.x0, seg.x1) > t.x + reach) return;
    if (Math.max(seg.y0, seg.y1) < t.y - TORCH_H - reach || Math.min(seg.y0, seg.y1) > t.y + reach) return;
    const n = Math.max(1, Math.ceil(Math.sqrt((seg.x1 - seg.x0) * (seg.x1 - seg.x0) + (seg.y1 - seg.y0) * (seg.y1 - seg.y0)) / 2));
    for (let k = 0; k <= n; k++) {
      if (torchDist(t, seg.x0 + (seg.x1 - seg.x0) * k / n, seg.y0 + (seg.y1 - seg.y0) * k / n) <= reach) {
        S.lit[i] = litRound(match);
        lights.push(i);
        return;
      }
    }
  });
  return lights.length ? { lights } : null;
}

// 行動玩家從 (x0, y0) 走到 (x1, y1)（位置回報之間的路線，每 4px 檢查一次）：身體碰到火把就點燃 / 補滿。
// 回傳 fx { type: 'torch', id, torch }（裁判廣播成 pickup），沒碰到 = null
export function touchTorch(match, e, x0, y0, x1, y1) {
  const S = caveState(match);
  if (!S || e.team !== 'players' || !e.alive) return null;
  const n = Math.max(1, Math.ceil(Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) / 4));
  for (let k = 0; k <= n; k++) {
    const px = x0 + (x1 - x0) * k / n, py = y0 + (y1 - y0) * k / n;
    const i = S.def.torches.findIndex((t, j) =>
      canLight(match, S, j) && Math.abs(px - t.x) <= e.hw + 6 && py >= t.y - TORCH_H && py - e.h <= t.y);
    if (i >= 0) {
      S.lit[i] = litRound(match);
      return { type: 'torch', id: e.id, torch: i };
    }
  }
  return null;
}

// 客戶端照事件播（重播的 replayEvent）：伺服器在這一下掉下來的鐘乳石、點燃的火把（記成現在這一輪點燃的：
// 訊息照順序播，播到這一發時客戶端的輪數跟伺服器結算時一樣）。重連時快照已經套過的就跳過
export function replayCave(match, ev) {
  const S = caveState(match);
  if (!S) return;
  for (const k of ev.falls || []) {
    if (match.terrain.dropStalactite(k)) S.fallen.push(k);
  }
  for (const i of ev.lights || []) if (i >= 0 && i < S.lit.length) S.lit[i] = litRound(match);
}

// 走路點燃火把（伺服器廣播的 pickup，跟其他訊息照順序播）：客戶端照著點
export function lightTorch(match, i) {
  const S = caveState(match);
  if (S && i >= 0 && i < S.lit.length) S.lit[i] = litRound(match);
}

// 快照：每支火把第幾輪點燃的（null = 沒點過；亮度照狀態一起帶的輪數推）、掉下來的鐘乳石
export function caveSnapshot(match) {
  const S = match.mechState;
  return { torches: S.lit.slice(), fallen: S.fallen.slice() };
}

// 套用快照（地形已經照洞重建過）：火把換成快照的；快照裡掉了、這邊還沒掉的鐘乳石拿掉。只帶一部分欄位時沒帶的不動。
// 舊格式（每支 true / false = 亮了沒）：true 當作這一輪點燃的
export function restoreCave(match, s) {
  const S = match.mechState;
  if (Array.isArray(s.torches)) {
    S.lit = S.def.torches.map((t, i) => {
      const v = s.torches[i];
      return Number.isFinite(v) ? v : v === true ? litRound(match) : null;
    });
  }
  if (Array.isArray(s.fallen)) {
    for (const k of s.fallen) match.terrain.dropStalactite(k);
    S.fallen = s.fallen.slice();
  }
}
