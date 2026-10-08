import { CONFIG } from './config.js';
import { Entity } from './entities.js';
import { clamp } from './utils.js';
import { launchVelocity, simulateShot } from './weapons.js';
import { buildCave, dropStalactites, standingStalactites } from './cave.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// 菁英關「地心探險」的獨眼巨人（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/mechanics/cyclops.js。這張地圖也是洞穴（鐘乳石、火把，規則在 cave.js），
// 這一場的狀態 match.mechState = 洞穴的狀態（def、lit、fallen）+ 巨人預定的下一招（next）。
//
// - 巨人站在最右邊的岩柱上（level.mechanic.cyclops），不會動、不會被擊退、不會落水（fixed）。打倒他 = 過關。
//   血量 CYCLOPS.hp，跟一般敵人一樣依人數、關數放大（菁英關不是 Boss 關：不算首領，弒神者對他沒用）。
// - 下一招是事先抽好的（match.mechState.next：開場一次、之後每次用掉就再抽，權重 CYCLOPS.weights），玩家回合畫面上會標出來：
//     猛捶（pound）：捶地，天花板上還在的鐘乳石「全部」震下來（砸到人照 WEAPONS.stalactite，穿過巨人自己），
//                    衝擊沿著他那根岩柱的頂面往兩邊跑（poundLane），站在那根岩柱上的玩家再多吃一次 WEAPONS.cyclopsShock。
//                    鐘乳石掉光了之後，猛捶的權重剩 CYCLOPS.poundBareFactor 倍
//     巨石投擲（throw）：朝離巨人最近的玩家丟一顆巨石（WEAPONS.cyclopsBoulder，拋物線、只砸直接打到的人、砸不到他自己）。
//                    瞄準：掃角度 × 力量找砸得到目標的那一發（會被天花板、岩柱擋住的自己會避開），再加上 CYCLOPS.aimError 的誤差
// - 震下來的鐘乳石跟打下來的一樣，是猛捶那一波裡「半路才出現的飛行物」（事件的 falls / adds，見 shared/volley.js）：
//   衝擊的第一個事件（飛過去的 pass，或第一幀就撞到人的 pierce）帶著，客戶端照事件重播

export const CYCLOPS_ACTION_NAMES = {
  pound: '猛捶',
  throw: '巨石投擲',
  idle: '盯著你們',
};

const SHOCK = 'cyclopsShock';

// 建立巨人（關卡的敵人之後），回傳這一場的狀態（洞穴的狀態 + 預定的下一招）。hpScale = 一般敵人的血量倍率（人數 × 關數）
export function buildCyclops(match, hpScale) {
  const def = match.level.mechanic;
  const c = def.cyclops;
  const state = { ...buildCave(match), next: null };
  match.entities.push(new Entity({
    ...CONFIG.ENEMY, id: 'cyclops', name: '獨眼巨人', team: 'enemies', controller: 'ai', slot: 0, facing: -1,
    x: c.x, y: c.y, hw: c.hw, h: c.h, hp: Math.round(CONFIG.CYCLOPS.hp * hpScale),
    fixed: true, part: 'cyclops', weapons: ['cyclopsBoulder'],
  }));
  return state;
}

// 這一場的狀態（match.mechState）。別張地圖（沒有 next 或沒有洞穴的 lit）當作沒有巨人
const cyclopsState = (match) => (match.mechState && Array.isArray(match.mechState.lit) && 'next' in match.mechState ? match.mechState : null);

// 猛捶的衝擊跑的那條線：巨人那根岩柱的頂面上方一點（腳踩在上面的人才碰得到；半空中、別根岩柱上的人碰不到）。
// x0 / x1 = 岩柱頂面的左右端（畫面的警示帶也照這個畫）
export function poundLane(match) {
  const L = match.level.mechanic.ledge;
  return { y: L.y - 6, x0: L.x0, x1: L.x1, top: L.y - 34, bottom: L.y };
}

// 抽下一招（開場、每次出完招之後）
export function planCyclopsNext(match) {
  const S = cyclopsState(match);
  if (!S) return null;
  const W = CONFIG.CYCLOPS.weights;
  const bare = standingStalactites(match).length === 0;
  const pound = Math.max(0, W.pound || 0) * (bare ? CONFIG.CYCLOPS.poundBareFactor : 1);
  S.next = { action: weightedPick(match.rng, [['pound', pound], ['throw', W.throw]]) || 'throw' };
  return S.next;
}

// 輪到巨人：出預定的那一招並直接結算好，再抽下一招。回傳 { steps: [招式], next }（格式同 Boss）
export function resolveCyclopsTurn(match, cy) {
  const S = cyclopsState(match);
  const plan = (S && S.next) || planCyclopsNext(match) || { action: 'throw' };
  const step = plan.action === 'pound' ? poundStep(match, cy) : throwStep(match, cy);
  planCyclopsNext(match);
  return { steps: [step], next: S && S.next ? { ...S.next } : null };
}

// 猛捶：兩道衝擊從巨人腳下沿著岩柱頂面往左、往右跑，跑到岩柱的兩端就停（range：岩柱外面的人打不到）。
// 兩道共用「打過誰」：站在巨人腳邊、兩道都碰得到的人也只挨一次
function poundStep(match, cy) {
  const weapon = CONFIG.WEAPONS[SHOCK];
  const lane = poundLane(match);
  const hitOnce = new Set();
  const projs = [];
  for (const dir of [-1, 1]) {
    const len = dir < 0 ? cy.x - lane.x0 : lane.x1 - cy.x;
    if (!(len > 0)) continue;
    const p = bossProjectile(cy, weapon, cy.x, lane.y, dir * weapon.speed, 0);
    p.range = len;
    p.ignore = hitOnce;
    projs.push(p);
  }
  return { action: 'pound', shot: bossShot(match, cy, weapon, projs, cy.facing) };
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

// 巨石投擲：朝離巨人最近的玩家丟。沒有目標（不會發生：玩家全倒就結束了）就發呆
function throwStep(match, cy) {
  const target = nearestPlayerAt(match, cy.cx, cy.cy);
  if (!target) return { action: 'idle', still: stillResult(match) };
  const weapon = CONFIG.WEAPONS.cyclopsBoulder;
  const aim = aimBoulder(match, cy, target);
  const err = CONFIG.CYCLOPS.aimError || { angle: 0, power: 0 };
  const noise = (a) => (match.rng.float() * 2 - 1) * a;
  const angle = aim.angle + noise(err.angle);
  const power = clamp(aim.power + noise(err.power), 10, 100);
  cy.facing = aim.facing;
  const m = cy.muzzle();
  const v = launchVelocity(weapon, angle, power);
  const shot = bossShot(match, cy, weapon, [bossProjectile(cy, weapon, m.x, m.y, v.vx, v.vy)], aim.facing);
  shot.angle = angle;
  shot.power = power;
  return { action: 'throw', targetId: target.id, shot };
}

// 找砸得到 target 的角度 / 力量（不加誤差）：先每 5° / 5 力量粗掃（5° ~ 90°、力量 10 ~ 100：腳邊、身後的人也找得到），
// 再在最好的幾發附近每 1 細掃。分數 = 落點離目標中心多遠（直接砸到目標 = 0；掉進水裡 / 飛出去再多加 400）。
// 巨石砸不到巨人自己（passOwner），往正上方丟、落在他腳邊也行。只在伺服器跑
const COARSE_KEEP = 3;
export function aimBoulder(match, cy, target) {
  const weapon = CONFIG.WEAPONS.cyclopsBoulder;
  const facing = target.cx >= cy.cx ? 1 : -1;
  const world = match.world;
  const score = (a, power) => {
    const r = simulateShot(world, cy, weapon, facing > 0 ? a : 180 - a, power);
    if (r.hit.type === 'entity' && r.hit.entity === target) return 0;
    let s = Math.hypot(r.hit.x - target.cx, r.hit.y - target.cy);
    if (r.hit.type !== 'terrain' && r.hit.type !== 'entity') s += 400;
    return s;
  };
  let best = null;
  const tried = new Set();
  const tryOne = (a, power) => {
    if (a < 5 || a > 90 || power < 10 || power > 100 || tried.has(a * 1000 + power)) return null;
    tried.add(a * 1000 + power);
    const c = { s: score(a, power), a, power };
    if (!best || c.s < best.s) best = c;
    return c;
  };
  const coarse = [];
  for (let a = 5; a <= 90; a += 5) for (let power = 10; power <= 100; power += 5) coarse.push(tryOne(a, power));
  // 粗掃最好的幾發（同分照掃的順序）附近細掃；已經直接砸得到就不用再找
  const top = coarse.filter(Boolean).sort((x, y) => x.s - y.s).slice(0, COARSE_KEEP);
  for (const c of top) {
    if (best.s === 0) break;
    for (let da = -4; da <= 4; da++) for (let dp = -4; dp <= 4; dp++) tryOne(c.a + da, c.power + dp);
  }
  return { angle: facing > 0 ? best.a : 180 - best.a, power: best.power, facing, score: best.s };
}
