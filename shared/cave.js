import { CONFIG } from './config.js';
import { clamp } from './utils.js';

// 洞穴地形（地圖「岩穴」）的規則：鐘乳石與火把（伺服器與客戶端共用）。
// Match 什麼時候呼叫這些，見地圖機制 shared/mechanics/cave.js。這一場的狀態在 match.mechState（buildCave 建的那一份）。
//
// - 鐘乳石：天花板垂下來的地形（level.stalactites，遮罩值 STALACTITE，見 terrain.js）。擋子彈、炸不壞；
//   被任何一方的飛行物打到（直擊那一根、或爆炸範圍碰到）就整根掉下來：從遮罩拿掉，變成一顆從尖端開始自由落下的飛行物
//   （WEAPONS.stalactite，事件的 adds，見 shared/volley.js），砸到第一個角色（傷害算打下它的人的攻擊）或落地就碎掉
// - 火把：level.mechanic.torches = [{ x, y（底部，插在地上 / 平台上）, lit（一開始就亮著）, faint（光很微弱）}]。
//   玩家方的攻擊打在火把旁邊（離火把 CAVE.torchReach px 內，爆炸的話再加上爆炸半徑）、或玩家自己走過去碰到，就點燃，之後一直亮著。
//   照明只是畫面（client/map-views/cave.js）：看不到的地方一樣打得到

export const TORCH_H = 34;   // 火把的高度（底部到火焰）

// 建立這一場洞穴的狀態（地圖機制的 build 回傳給 Match，存成 match.mechState）：
// lit = 每支火把亮了沒，fallen = 掉下來的鐘乳石（照掉的順序）
export function buildCave(match) {
  const def = match.level.mechanic;
  return { def, lit: (def.torches || []).map(t => !!t.lit), fallen: [] };
}

// 這一場洞穴的狀態（match.mechState）。一般小關（null）、別張地圖的狀態（沒有 lit）都當作沒有洞穴
const caveState = (match) => (match.mechState && Array.isArray(match.mechState.lit) ? match.mechState : null);

// 火焰的位置
export const flameOf = (t) => ({ x: t.x, y: t.y - TORCH_H });

// (x, y) 離火把（底部到火焰的那一段）多遠
function torchDist(t, x, y) {
  const dx = x - t.x;
  const dy = y - clamp(y, t.y - TORCH_H, t.y);
  return Math.sqrt(dx * dx + dy * dy);
}

// 一顆飛行物撞到東西（地圖機制的 struck）：打到 / 炸到的鐘乳石掉下來、打在火把旁邊就點燃（只有玩家方）。
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
      if (!S.lit[i] && torchDist(t, at.x, at.y) <= at.blast + CONFIG.CAVE.torchReach) {
        S.lit[i] = true;
        lights.push(i);
      }
    });
  }
  if (!falls.length && !lights.length) return null;
  return { ...(falls.length ? { falls, adds } : {}), ...(lights.length ? { lights } : {}) };
}

/// 第 ks 根鐘乳石掉下來（從地形拿掉、記進 fallen）：回傳要附在事件上的 { falls, adds }（adds = 從尖端開始落下的飛行物，見 shared/volley.js）。
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

// 飛行物這一幀從 (x0, y0) 飛到 (x1, y1)、沒撞到東西（地圖機制的 passed）：玩家方的飛行物從還沒亮的火把旁邊飛過去
// （離火把 CAVE.torchPass + 飛行物的判定半徑以內）就點燃。回傳 { lights }，沒有 = null。每顆飛行物每一幀都會呼叫：先用外框排除
export function passCave(match, owner, seg) {
  const S = caveState(match);
  if (!S || !owner || owner.team !== 'players') return null;
  const reach = CONFIG.CAVE.torchPass + (seg.r || 0);
  const lights = [];
  S.def.torches.forEach((t, i) => {
    if (S.lit[i]) return;
    if (Math.max(seg.x0, seg.x1) < t.x - reach || Math.min(seg.x0, seg.x1) > t.x + reach) return;
    if (Math.max(seg.y0, seg.y1) < t.y - TORCH_H - reach || Math.min(seg.y0, seg.y1) > t.y + reach) return;
    const n = Math.max(1, Math.ceil(Math.sqrt((seg.x1 - seg.x0) * (seg.x1 - seg.x0) + (seg.y1 - seg.y0) * (seg.y1 - seg.y0)) / 2));
    for (let k = 0; k <= n; k++) {
      if (torchDist(t, seg.x0 + (seg.x1 - seg.x0) * k / n, seg.y0 + (seg.y1 - seg.y0) * k / n) <= reach) {
        S.lit[i] = true;
        lights.push(i);
        return;
      }
    }
  });
  return lights.length ? { lights } : null;
}

// 行動玩家從 (x0, y0) 走到 (x1, y1)（位置回報之間的路線，每 4px 檢查一次）：身體碰到還沒亮的火把就點燃。
// 回傳 fx { type: 'torch', id, torch }（裁判廣播成 pickup），沒碰到 = null
export function touchTorch(match, e, x0, y0, x1, y1) {
  const S = caveState(match);
  if (!S || e.team !== 'players' || !e.alive) return null;
  const n = Math.max(1, Math.ceil(Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) / 4));
  for (let k = 0; k <= n; k++) {
    const px = x0 + (x1 - x0) * k / n, py = y0 + (y1 - y0) * k / n;
    const i = S.def.torches.findIndex((t, j) =>
      !S.lit[j] && Math.abs(px - t.x) <= e.hw + 6 && py >= t.y - TORCH_H && py - e.h <= t.y);
    if (i >= 0) {
      S.lit[i] = true;
      return { type: 'torch', id: e.id, torch: i };
    }
  }
  return null;
}

// 客戶端照事件播（重播的 replayEvent）：伺服器在這一下掉下來的鐘乳石、點燃的火把。重連時快照已經套過的就跳過
export function replayCave(match, ev) {
  const S = caveState(match);
  if (!S) return;
  for (const k of ev.falls || []) {
    if (match.terrain.dropStalactite(k)) S.fallen.push(k);
  }
  for (const i of ev.lights || []) if (i >= 0 && i < S.lit.length) S.lit[i] = true;
}

// 走路點燃火把（伺服器廣播的 pickup）：客戶端照著點
export function lightTorch(match, i) {
  const S = caveState(match);
  if (S && i >= 0 && i < S.lit.length) S.lit[i] = true;
}

// 快照：每支火把亮了沒、掉下來的鐘乳石
export function caveSnapshot(match) {
  const S = match.mechState;
  return { torches: S.lit.slice(), fallen: S.fallen.slice() };
}

// 套用快照（地形已經照洞重建過）：火把換成快照的；快照裡掉了、這邊還沒掉的鐘乳石拿掉。只帶一部分欄位時沒帶的不動
export function restoreCave(match, s) {
  const S = match.mechState;
  if (Array.isArray(s.torches)) S.lit = S.def.torches.map((t, i) => !!s.torches[i]);
  if (Array.isArray(s.fallen)) {
    for (const k of s.fallen) match.terrain.dropStalactite(k);
    S.fallen = s.fallen.slice();
  }
}
