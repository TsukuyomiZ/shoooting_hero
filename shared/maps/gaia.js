import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { clamp } from '../core/utils.js';
import { weightedPick, bossProjectile, bossShot, stillResult } from './mechanics/common.js';
import { standY } from './guardian.js';
import {
  freshMarks, markStep as markStepOf, syncMarks, marksHazardStart, marksHazardStep, marksSnapshot, restoreMarks, perPlayer, hitOn,
} from './marks.js';

const r1 = (v) => Math.round(v * 10) / 10;

// 主題王「大地祭壇」的大地之母・蓋亞（莫利亞森林第 11 關；伺服器與客戶端共用：出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/gaia.js。數字見 config.GAIA / WEAPONS.gaiaCrush / gaiaSmite / gaiaStack。
// 這一場的狀態 match.mechState（欄位順序固定，test/mechanics.js 釘著）：
//   def（關卡的 mechanic）、hpScale（王的血量倍率）、next（預定的下一招 { action: 'crush' | 'smite' | 'stack' | 'cleanse', side?（天罰）, targetId?（同罰）}，玩家回合畫面上看得到）、
//   fog（瘴氣在不在）、nextFog（第幾輪她的回合要放下一次瘴氣）、orbs / need（祭壇收了幾顆光球 / 要收幾顆）、
//   flowers（場上的自然之花 [{ id, slope: 開在第幾道斜坡（0 ~ 5，見關卡的 slopes）, x, y: 腳底 = 斜坡表面 }]）、
//   stunned（祭壇淨化了：她下一回合暈眩、什麼都不做）、rage（暴走了沒）、lightAt（暴走後第幾輪她的回合放最後之光；沒暴走 = null）、
//   light（最後之光進行中 { at: 放的那一輪, need: 要收幾朵, got: 收了幾朵, shield: 祭壇的護盾張開了沒, withered: 花枯萎了沒 }，沒有 = null）、seq（流水號）、
//   marks / bound / zone / tick（指名，見 shared/maps/marks.js；蓋亞的兩招都不綁人，bound 一直是空的）
//
// 2026-11-04 使用者定的規則（U）與我補的詮釋：
// - 一輪裡玩家先、蓋亞最後（她排在角色陣列最後）。「她的第 N 回合」= 第 N 輪（match.round）。客戶端不跑 roundStart：畫面要的都在狀態裡
//   （快照、她的回合播完的 boss.state、撿花的 pickup、回合開始的 fx）或推得出來（match.round）
// - 瘴氣（U）：第 1 輪她的回合就放、之後每 fogEvery 輪（她的回合到了 nextFog 就放：祭壇沒收滿、瘴氣還在也照樣重放）：
//   舊的花消失、祭壇收的光球歸零（U：不保留），照活著的人數（flowers）在不同的斜坡上各開一朵花（斜坡的 20% ~ 80% 之間）。
//   瘴氣是全畫面的（U）：玩家回合開始 +fogPoison 層中毒（暴走後 ragePoison 層；免疫異常狀態的人不上）。
//   中毒在回合開始先結算、才輪到這裡加層數，所以新加的層數下一個自己的回合開始才咬人
// - 自然之花：玩家走路 / 跳 / 被擊退飛過去（位置回報之間的路線、AI 代打的每一幀）身體碰到花就撿到，變成一顆光球飛進祭壇。
//   收滿了（orbs >= need）馬上祭壇淨化：瘴氣散去、花清掉、活著的玩家中毒層數歸零（被鎖住的血量上限不回來，我提、使用者接受）、
//   回 purifyHealPct% 最大血量，蓋亞下一回合暈眩（只有暈眩，不放瘴氣、不出招）。下一次瘴氣照原本的輪數（剛好暈眩就再下一回合）
// - 招式（每回合一招，事先抽好 = next，權重 weights）：
//     巨掌・捏碎 crush：中間那一整欄（三層平台）的人都被打到，往離開祭壇的方向擊退（正好在祭壇正上方的隨機一邊）
//     神掌・天罰 smite：左邊或右邊整片（三道斜坡；抽招的時候就決定哪一邊）的人都被打到，往外（牆那邊）推一點
//     巨拳・同罰 stack（11-04 U：「拳頭鎖定在一個玩家頭上、要有聚攏提示、讓玩家一起分擔傷害」）：抽招的時候就鎖定隨機一名活著的玩家，
//                         玩家回合拳頭一直跟在他頭上（一般難度另外畫集合圈）。她的回合：身體中心離他的身體中心 stackRadius 以內的活著的玩家
//                         （他自己一定算）平分總傷害 gaiaDamage(gaiaStack)：每人 round(總傷害 / 人數)，再吃一般的敵人傷害倍率；不擊退（我補的）。
//                         最後之光那幾回合照樣會放（只有捏碎不放）；放最後之光的那一回合，分擔的人照傳送前的位置算（11-05 我補的）
//     自然・淨化 cleanse（11-04 U 改：只淨化她自己、會回血）：綠色光球在她嘴邊聚起來、吸回臉上，移除她自己的負面狀態（中毒層數、燃燒、流血、糾纏；
//                         被中毒鎖住的上限不回來，同玩家的祭壇淨化，我補的），固定回 cleanseHealPct% 最大血量（我補的：沒有負面狀態也回）。不碰玩家、沒有傷害
//   出招的時候預定的不能用了（最後之光那幾回合預定了捏碎）就重抽；同罰的目標倒下了只換目標、招式不變（11-05 我補的：不會出沒預警過的捏碎 / 天罰）
// - 血量 ragePct% 以下暴走（血量先停在門檻，輪到她才宣告，同蜘蛛女王）：瘴氣永久不散（祭壇不再淨化、不再暈眩她）、花清掉、
//   之後的回合開始每次 +ragePoison 層（U 方案 A）。暴走那一回合照樣出招。暈眩的那一回合先暈完，下一回合才暴走（我補的）
// - 最後之光 → 誅滅（U）：暴走後第 lightEvery 輪她的回合（L = lightAt）放最後之光：活著的人全部傳送到祭壇那一層、
//   照活著的人數（lightFlowers）在不同的斜坡上開花。第 L+1、L+2 輪玩家收花，收齊了祭壇張開金色護盾；
//   第 L+2 輪她的回合還沒收齊 → 剩下的花「因為自然的力量枯萎了」。第 L+3 輪玩家回到祭壇，她的回合誅滅：
//   不在護盾裡的人直接死亡（不吃無敵、減傷、免疫，剩下的血全算承受傷害；沒有護盾 = 全滅），在裡面的中毒層數歸零（U 方案 A）。
//   之後再數 lightEvery 輪。最後之光那幾回合（她的第 L ~ L+3 回合）不放捏碎（U）
// - 指名 / 插話行動（2026-11-10 U 選的兩招：大地・脈動、大地之手・攫取；規則見檔案後面「指名 / 插話」與 config.GAIA.marks）：
//   她每個回合（暈眩那一回合除外）的最後指名下一組；3 人以上連續 2 位玩家之後插話。暴走、最後之光照樣（U）。
//   祭壇淨化：還沒輪到的指名取消、暈眩完之前不插話（我補的）

export const GAIA_ID = 'gaia';
export const GAIA_NAME = '大地之母・蓋亞';
export const WITHER_TEXT = '因為自然的力量枯萎了';   // (U) 花沒收齊、枯萎時的橫幅（照抄）

export const GAIA_ACTION_NAMES = {
  fog: '瘴氣瀰漫',
  stunned: '暈眩',
  rage: '大地之母暴走',
  light: '最後之光',
  wither: '自然之花枯萎',
  judgement: '誅滅',
  crush: '巨掌・捏碎',
  smite: '神掌・天罰',
  stack: '巨拳・同罰',
  cleanse: '自然・淨化',
  mark: '大地的注視',
  idle: '沉睡',
};

export const FLOWER_R = 14;      // 花的判定半徑（身體碰到這個圓就撿到）
export const FLOWER_LIFT = 12;   // 花的中心在斜坡表面上面幾 px（花的 y 是腳底 = 表面）
export const STACK_DROP = 90;    // 我抓的：同罰的拳從分擔的人頭頂上多高落下來（px；畫面的拳也從這裡砸下去）
const FLOWER_SPAN = [0.2, 0.8];  // 花開在斜坡的哪一段（從外側量；不貼著牆、不在內側端點上）
const NEGATIVE = ['poison', 'burn', 'bleed', 'entangle'];   // 自然・淨化移除她自己的哪些負面狀態（照這個順序記）

// 這一場的狀態（match.mechState）。別張地圖當作沒有
export const gaiaState = (match) => (match.mechState && match.mechState.def && match.mechState.def.type === 'gaia' ? match.mechState : null);
export const gaiaOf = (match) => match.byId(GAIA_ID);

// 建立蓋亞的臉（關卡的敵人之後），回傳這一場的狀態。手只是畫面，不是角色
export function buildGaia(match, { bossScale }) {
  const def = match.level.mechanic;
  const C = CONFIG.GAIA;
  const g = new Entity({
    ...CONFIG.ENEMY, id: GAIA_ID, name: GAIA_NAME, team: 'enemies', controller: 'ai', slot: 0, facing: -1, kind: 'gaia',
    x: def.face.x, y: def.face.y, hw: C.hw, h: C.h, hp: Math.round(C.hp * bossScale), boss: true, fixed: true, weapons: ['gaiaSmite'],
  });
  match.entities.push(g);
  const S = {
    def, hpScale: bossScale, next: null, fog: false, nextFog: 1, orbs: 0, need: 0, flowers: [], stunned: false,
    rage: false, lightAt: null, light: null, seq: 0, ...freshMarks(),
  };
  g.hpFloor = floorHp(g, S);
  return S;
}

// 暴走的門檻（暴走過了 = 0）：血量停在這裡，等輪到她宣告暴走
function floorHp(e, S) {
  if (S && S.rage) return 0;
  return Math.round((e.maxHp + e.poisonLock) * CONFIG.GAIA.ragePct / 100);
}

// ---------- 地形的幾何（規則與畫面共用）----------

/** 斜坡 s（關卡的 slopes 其中一道）在 x 那裡的表面高度 */
export function slopeY(s, x) {
  return s.y0 + (s.y1 - s.y0) * (x - s.x0) / (s.x1 - s.x0);
}

/**
 * 一招打的範圍（左右，整個畫面高度都算）：捏碎 = 中間那一欄、天罰 = 那一欄的左邊（side -1）/ 右邊（side 1）整片。
 * def = 關卡的 mechanic（match.mechState.def）；別的招 = null。畫面的警示帶也照這個畫
 */
export function zoneOf(def, plan) {
  if (!def || !plan) return null;
  const c = def.column;
  if (plan.action === 'crush') return { x0: c.x0, x1: c.x1 };
  if (plan.action === 'smite' && plan.side === -1) return { x0: 0, x1: c.x0 };
  if (plan.action === 'smite' && plan.side === 1) return { x0: c.x1, x1: CONFIG.WORLD_W };
  return null;
}

/** 角色 e 的身體（左右）碰到範圍 z 沒有 */
export const inZone = (e, z) => !!z && e.x + e.hw > z.x0 && e.x - e.hw < z.x1;

/** 這一招會打到的人：活著、身體碰到範圍的玩家（照玩家的順序） */
export function zoneTargets(match, plan) {
  const S = gaiaState(match);
  const z = S ? zoneOf(S.def, plan) : null;
  return z ? match.players.filter(e => e.alive && inZone(e, z)) : [];
}

/** 同罰的分擔範圍：身體中心離 t 的身體中心 stackRadius 以內（含邊上） */
export const inStack = (t, e) => Math.hypot(e.cx - t.cx, e.cy - t.cy) <= CONFIG.GAIA.stackRadius;

/** 同罰會一起分擔的人：活著、在目標 t 的分擔範圍裡的玩家（照玩家的順序；t 自己一定算）。畫面的集合圈標誰在裡面也照這個 */
export function stackSharers(match, t) {
  if (!t || !t.alive) return [];
  return match.players.filter(e => e.alive && (e === t || inStack(t, e)));
}

/**
 * 在誅滅的護盾裡：腳底貼著祭壇那一層的頂面、身體（左右）碰到護盾的範圍（站在平台邊緣、身體一半在外面的也算：
 * 站得在祭壇那一層就在裡面，畫面的金色護盾也照這個範圍畫）。def = 關卡的 mechanic
 */
export function inShield(def, e) {
  const b = def.shield;
  return e.x + e.hw > b.x0 && e.x - e.hw < b.x1 && e.y >= b.y0 && e.y <= b.y1;
}

/** 最後之光在第 at 輪放的話，第幾輪她的回合誅滅（收花 lightCollectRounds 輪、再一輪回到祭壇 = L+3） */
export const judgeRound = (at) => at + CONFIG.GAIA.lightCollectRounds + 1;

/** 她的第 turn 回合在不在最後之光那幾回合裡（L ~ 誅滅那一回合 = L+3：不放捏碎） */
export function inLightWindow(S, turn) {
  if (!S || !S.rage) return false;
  const L = S.light ? S.light.at : S.lightAt;
  return L !== null && L !== undefined && turn >= L && turn <= judgeRound(L);
}

/**
 * 最後之光的進度（HUD 寫倒數 / 現在該做什麼）：沒暴走 = null；
 * 還沒放 = { countdown: 還有幾輪（0 = 這一輪她的回合就放）}；
 * 放了 = { phase: 'collect' 收花 / 'return' 回到祭壇（收齊了或枯萎了）, judgeIn: 還有幾輪誅滅（0 = 這一輪她的回合）, got, need, shield, withered }
 */
export function lightStatus(match) {
  const S = gaiaState(match);
  if (!S || !S.rage) return null;
  const R = match.round;
  if (!S.light) return S.lightAt === null ? null : { countdown: Math.max(0, S.lightAt - R) };
  const L = S.light;
  // 收花到第 L+2 輪為止（含：那一輪玩家照樣撿得到，她的回合才枯萎）
  const collecting = !L.shield && !L.withered && R <= L.at + CONFIG.GAIA.lightCollectRounds;
  return { phase: collecting ? 'collect' : 'return', judgeIn: Math.max(0, judgeRound(L.at) - R), got: L.got, need: L.need, shield: L.shield, withered: L.withered };
}

// ---------- 自然之花 ----------

/** 花的中心（畫面畫花、判定撿到都照這個） */
export const flowerCenter = (f) => ({ x: f.x, y: f.y - FLOWER_LIFT });

// 腳底在 (x, y) 的身體（e 的大小）碰到花 f 沒有：身體的矩形離花的中心不到 FLOWER_R
function touches(e, x, y, f) {
  const c = flowerCenter(f);
  const dx = Math.max(x - e.hw - c.x, 0, c.x - (x + e.hw));
  const dy = Math.max(y - e.h - c.y, 0, c.y - y);
  return dx * dx + dy * dy <= FLOWER_R * FLOWER_R;
}

/**
 * 玩家 e 從 (x0, y0) 走到 (x1, y1)（每 4px 檢查一次，終點一定檢查）路上碰到的花（id，照碰到的順序）。只看、不改狀態
 * （客戶端想先在自己的畫面上撿也用這個）
 */
export function touchFlowers(match, e, x0, y0, x1, y1) {
  const S = gaiaState(match);
  if (!S || !S.flowers.length || !e.isPlayer || !e.alive) return [];
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4));
  const got = [];
  for (let k = 0; k <= n && got.length < S.flowers.length; k++) {
    const px = x0 + (x1 - x0) * k / n, py = y0 + (y1 - y0) * k / n;
    for (const f of S.flowers) if (!got.includes(f.id) && touches(e, px, py, f)) got.push(f.id);
  }
  return got;
}

/**
 * 玩家走路（地圖機制的 moved：位置回報之間的路線 / AI 代打的每一幀）：碰到的花撿起來變成光球飛進祭壇。
 * 平常（瘴氣）：祭壇收滿了馬上淨化。最後之光：收齊了護盾張開。
 * 回傳 pickup fx（裁判廣播、記 pickup；客戶端照它套，見 applyGaiaPickup）：
 *   { type: 'gaiaFlower', id: 撿的人, flowers: [撿到的花 id], orbs: 祭壇現在收了幾顆, need: 要收幾顆,
 *     light?: true（最後之光的花）, shield?: true（這一下收齊、護盾張開）,
 *     purify?: true（這一下收滿、祭壇淨化）, cured?: [中毒層數清掉的人], heals?: [{ id, heal, hp }] }；沒碰到 = null
 */
export function pickFlowers(match, e, x0, y0, x1, y1) {
  const S = gaiaState(match);
  const got = touchFlowers(match, e, x0, y0, x1, y1);
  if (!S || !got.length) return null;
  S.flowers = S.flowers.filter(f => !got.includes(f.id));
  if (S.light) {
    S.light.got += got.length;
    const fx = { type: 'gaiaFlower', id: e.id, flowers: got, light: true, orbs: S.light.got, need: S.light.need };
    if (!S.light.shield && S.light.got >= S.light.need) {
      S.light.shield = true;
      fx.shield = true;
    }
    return fx;
  }
  S.orbs += got.length;
  const fx = { type: 'gaiaFlower', id: e.id, flowers: got, orbs: S.orbs, need: S.need };
  if (!S.rage && S.fog && S.orbs >= S.need) Object.assign(fx, purify(match));
  return fx;
}

// 祭壇淨化：瘴氣散去、花清掉、祭壇歸零；活著的玩家中毒層數歸零（上限不回來）、回 purifyHealPct% 最大血量；蓋亞下一回合暈眩
function purify(match) {
  const S = gaiaState(match);
  S.fog = false;
  S.flowers = [];
  S.orbs = 0;
  S.need = 0;
  S.stunned = true;
  S.marks = {};   // 還沒輪到的指名一起取消（我補的；正在冒的那一招照樣發動）
  const cured = [], heals = [];
  for (const e of match.players) {
    if (!e.alive) continue;
    if (e.poison > 0) cured.push(e.id);
    e.poison = 0;
    const heal = match.heal(e, e.maxHp * CONFIG.GAIA.purifyHealPct / 100);
    heals.push({ id: e.id, heal, hp: e.hp });
  }
  return { purify: true, cured, heals };
}

/**
 * 客戶端收到撿花（pickup 訊息 / AI 代打走路的 pickups）：照伺服器的結果套（花消失、祭壇的光球數、淨化 / 護盾）。
 * 淨化時活著的玩家中毒層數歸零、血量照 heals（撿的人自己的血量裁判另外帶在訊息上）。重複套同一個也一樣
 */
export function applyGaiaPickup(match, msg) {
  const S = gaiaState(match);
  if (!S || !msg) return;
  const ids = msg.flowers || [];
  S.flowers = S.flowers.filter(f => !ids.includes(f.id));
  if (msg.light) {
    if (S.light) {
      S.light.got = msg.orbs | 0;
      if (msg.shield) S.light.shield = true;
    }
    return;
  }
  S.orbs = msg.orbs | 0;
  S.need = msg.need | 0;
  if (!msg.purify) return;
  Object.assign(S, { fog: false, flowers: [], orbs: 0, need: 0, stunned: true, marks: {} });
  for (const p of match.players) if (p.alive) p.poison = 0;
  for (const h of msg.heals || []) {
    const p = match.byId(h.id);
    if (p && p.alive && Number.isFinite(h.hp)) p.hp = h.hp;
  }
}

// 照活著的人數查表（flowers / lightFlowers），最少 1、最多 6（斜坡只有 6 道，一道一朵）
function flowerCount(match, table) {
  const n = match.players.filter(e => e.alive).length;
  const want = table[n] ?? table[Math.max(...Object.keys(table).map(Number))];
  return Math.max(1, Math.min(want | 0, 6));
}

// 在 count 道不同的斜坡上各開一朵花（斜坡隨機挑、x 在那一道的 20% ~ 80% 之間隨機，match.rng）。回傳新開的花
function spawnFlowers(match, count) {
  const S = gaiaState(match);
  const slopes = S.def.slopes;
  const idx = slopes.map((s, k) => k);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = match.rng.int(0, i);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, count).sort((a, b) => a - b).map(k => {
    const s = slopes[k];
    const t = FLOWER_SPAN[0] + (FLOWER_SPAN[1] - FLOWER_SPAN[0]) * match.rng.float();
    const x = Math.round(s.x0 + (s.x1 - s.x0) * t);
    return { id: `flower${++S.seq}`, slope: k, x, y: Math.round(slopeY(s, x)) };
  });
}

// ---------- 瘴氣（回合開始）----------

/**
 * 玩家的回合開始（地圖機制的 turnStart，中毒結算之後）：瘴氣還在就 +fogPoison 層（暴走後 ragePoison 層）。
 * fx：{ type: 'gaiaFog', id, stacks: 這次加的, total: 現在幾層 }；免疫異常狀態的人 { type: 'gaiaFog', id, immune: true }
 */
export function fogTurnStart(match, e, fx) {
  const S = gaiaState(match);
  if (!S || !S.fog || !e.isPlayer || !e.alive) return;
  if (match.immuneTo(e)) { fx.push({ type: 'gaiaFog', id: e.id, immune: true }); return; }
  const stacks = S.rage ? CONFIG.GAIA.ragePoison : CONFIG.GAIA.fogPoison;
  e.poison += stacks;
  fx.push({ type: 'gaiaFog', id: e.id, stacks, total: e.poison });
}

// ---------- 她的回合 ----------

// 抽一招（match.rng）：捏碎 / 天罰（順便抽左右）/ 同罰（順便抽鎖定誰）/ 淨化照權重；noCrush = 最後之光那幾回合（不放捏碎）
function rollPlan(match, noCrush) {
  const W = CONFIG.GAIA.weights;
  const alive = match.players.filter(e => e.alive);
  const action = weightedPick(match.rng, [
    ['crush', noCrush ? 0 : W.crush],
    ['smite', W.smite],
    ['stack', alive.length ? W.stack : 0],
    ['cleanse', W.cleanse],
  ]) || 'smite';
  if (action === 'smite') return { action, side: match.rng.int(0, 1) ? 1 : -1 };
  if (action === 'stack') return { action, targetId: match.rng.pick(alive).id };
  return { action };
}

/** 抽蓋亞的下一招（開場、每次出完招之後）：給她的下一回合（第 match.round + 1 輪）用，最後之光那幾回合不抽捏碎 */
export function planGaiaNext(match) {
  const S = gaiaState(match);
  if (!S) return null;
  const g = gaiaOf(match);
  if (!g || !g.alive || !match.players.some(e => e.alive)) return (S.next = null);
  return (S.next = rollPlan(match, inLightWindow(S, match.round + 1)));
}

// 招式做完之後：這一步的結果照現在的場面重算（客戶端播完這一步就套這一份）
function done(match, step) {
  const res = step.shot || step.still;
  if (res) res.results = match.entities.map(e => e.toState());
  return step;
}

/**
 * 輪到蓋亞（第 match.round 輪）：暈眩 → 只有暈眩；不然（血量到門檻 → 暴走）→（沒暴走：瘴氣到了就放）/（暴走：誅滅 / 枯萎 / 最後之光）
 * → 預定的那一招 → 抽下一招。回傳 { steps: [招式…], next, state }（格式同 Boss；state = 整回合播完客戶端對齊用）
 */
export function resolveGaiaTurn(match, g) {
  const S = gaiaState(match);
  const C = CONFIG.GAIA;
  const R = match.round;
  const steps = [];
  const anyone = () => match.players.some(e => e.alive);
  // 這一回合在不在最後之光那幾回合裡（不放捏碎）：先算好——誅滅會把 light 清掉、lightAt 改成下一次，之後再算就不在了
  const noCrush = inLightWindow(S, R);
  let stackPre = null;
  if (S.stunned) {
    S.stunned = false;
    steps.push(done(match, { action: 'stunned', cast: C.cast.stunned, still: stillResult(match) }));
    return finish(match, steps, false);
  }
  if (!S.rage && g.hp <= floorHp(g, S)) steps.push(rageStep(match, g));
  if (!S.rage) {
    if (R >= S.nextFog) steps.push(fogStep(match));
  } else {
    if (S.light && R >= judgeRound(S.light.at)) steps.push(judgementStep(match));
    else if (S.light && R >= S.light.at + C.lightCollectRounds && !S.light.shield && !S.light.withered) steps.push(witherStep(match));
    if (!S.light && S.lightAt !== null && R >= S.lightAt && anyone()) {
      // 預定同罰：分擔的人照傳送前（玩家回合照集合圈站好的位置）先算好，不然傳送到固定站位之後才算、玩家回合看到的集合圈等於假的（11-05 我抓的）
      stackPre = plannedSharers(match);
      steps.push(lightStep(match));
    }
  }
  if (anyone()) steps.push(moveStep(match, g, noCrush, stackPre));
  if (!steps.length) steps.push(done(match, { action: 'idle', cast: C.cast.idle, still: stillResult(match) }));
  return finish(match, steps, true);
}

// 收尾：抽下一招，最後指名下一組（暈眩的那一回合都不做：預定的照舊留著）
function finish(match, steps, replan) {
  const S = gaiaState(match);
  if (replan) {
    planGaiaNext(match);
    const mark = gaiaMarkStep(match, GAIA_ID);
    if (mark) steps.push(mark);
  }
  return { steps, next: S.next ? { ...S.next } : null, state: gaiaSnapshot(match).gaia };
}

// 瘴氣：舊的花消失、祭壇歸零，照活著的人數在不同的斜坡上開花；下一次在 fogEvery 輪後
function fogStep(match) {
  const S = gaiaState(match);
  const vanished = S.flowers.map(f => f.id);
  const blooms = spawnFlowers(match, flowerCount(match, CONFIG.GAIA.flowers));
  Object.assign(S, { fog: true, nextFog: match.round + CONFIG.GAIA.fogEvery, flowers: blooms, orbs: 0, need: blooms.length });
  return done(match, {
    action: 'fog', flowers: blooms.map(f => f.id), vanished, need: S.need, nextFog: S.nextFog, ...bloomLog(blooms),
    blooms: blooms.map(f => ({ ...f })), cast: CONFIG.GAIA.cast.fog, still: stillResult(match),
  });
}

// 紀錄只收純量 / 純量的陣列（裁判的 ai.turn）：花開在哪裡另外照 flowers 的順序攤成陣列（第幾道斜坡、x、y）
const bloomLog = (blooms) => ({ slopes: blooms.map(f => f.slope), flowerX: blooms.map(f => f.x), flowerY: blooms.map(f => f.y) });

// 暴走：門檻拿掉、瘴氣永久不散、花與祭壇清掉、不再暈眩；lightEvery 輪後放最後之光
function rageStep(match, g) {
  const S = gaiaState(match);
  const vanished = S.flowers.map(f => f.id);
  Object.assign(S, { rage: true, fog: true, flowers: [], orbs: 0, need: 0, stunned: false, lightAt: match.round + CONFIG.GAIA.lightEvery });
  g.hpFloor = 0;
  return done(match, { action: 'rage', lightAt: S.lightAt, vanished, cast: CONFIG.GAIA.cast.rage, still: stillResult(match) });
}

/**
 * 把活著的玩家照順序傳送到祭壇那一層（def.lightSpots 的 x，腳底照那裡站得住的高度）：放開藤蔓、停下來站好。
 * 回傳 [{ id, x0, y0, x, y }]（從哪裡到哪裡）
 */
function teleportToAltar(match) {
  const S = gaiaState(match);
  const tier = S.def.tiers[1];
  const spots = S.def.lightSpots;
  return match.players.filter(e => e.alive).map((p, k) => {
    const x0 = p.x, y0 = p.y;
    const x = spots[k % spots.length];
    p.letGoVine();
    p.x = x;
    p.y = standY(match, p, x, tier.y - 1) ?? tier.y - 1;
    p.vx = 0;
    p.vy = 0;
    p.onGround = true;
    p.moveDir = 0;
    p.slide = 0;
    return { id: p.id, x0, y0, x: p.x, y: p.y };
  });
}

// 最後之光：大家傳送到祭壇那一層，照活著的人數在不同的斜坡上開花（收花兩輪）
function lightStep(match) {
  const S = gaiaState(match);
  const spots = teleportToAltar(match);
  const blooms = spawnFlowers(match, flowerCount(match, CONFIG.GAIA.lightFlowers));
  S.flowers = blooms;
  S.light = { at: match.round, need: blooms.length, got: 0, shield: false, withered: false };
  return done(match, {
    action: 'light', targetIds: spots.map(s => s.id), flowers: blooms.map(f => f.id), need: blooms.length, ...bloomLog(blooms),
    // 紀錄用：每個人從哪裡傳送到哪裡（照 targetIds 的順序，四捨五入到 px）
    fromX: spots.map(s => Math.round(s.x0)), fromY: spots.map(s => Math.round(s.y0)), toX: spots.map(s => Math.round(s.x)), toY: spots.map(s => Math.round(s.y)),
    spots, blooms: blooms.map(f => ({ ...f })), cast: CONFIG.GAIA.cast.light, still: stillResult(match),
  });
}

// 花沒收齊：剩下的「因為自然的力量枯萎了」（沒有護盾，誅滅會全滅）
function witherStep(match) {
  const S = gaiaState(match);
  const vanished = S.flowers.map(f => f.id);
  S.flowers = [];
  S.light.withered = true;
  return done(match, { action: 'wither', left: vanished.length, vanished, cast: CONFIG.GAIA.cast.wither, still: stillResult(match) });
}

// 誅滅：不在護盾裡的人直接死亡（不吃無敵、減傷、免疫，剩下的血全算承受傷害），在裡面的中毒層數歸零；lightEvery 輪後再放最後之光
function judgementStep(match) {
  const S = gaiaState(match);
  const shield = !!S.light.shield;
  const killed = [], saved = [], cured = [];
  for (const p of match.players) {
    if (!p.alive) continue;
    if (shield && inShield(S.def, p)) {
      saved.push(p.id);
      if (p.poison > 0) cured.push(p.id);
      p.poison = 0;
    } else {
      p.taken += p.hp;
      p.die('judged');
      killed.push(p.id);
    }
  }
  S.light = null;
  S.flowers = [];
  S.lightAt = match.round + CONFIG.GAIA.lightEvery;
  return done(match, { action: 'judgement', shield, killed, saved, cured, lightAt: S.lightAt, cast: CONFIG.GAIA.cast.judgement, still: stillResult(match) });
}

// 預定的是同罰、目標還活著：現在會一起分擔的人的 id（照玩家的順序）；不然 null
function plannedSharers(match) {
  const plan = gaiaState(match).next;
  if (!plan || plan.action !== 'stack') return null;
  const t = match.players.find(e => e.id === plan.targetId && e.alive);
  return t ? stackSharers(match, t).map(e => e.id) : null;
}

// 這一回合的招：照預定的（不能用了就重抽：最後之光那幾回合抽到捏碎…）。
// 同罰的目標在玩家回合裡倒下了：招式不變、從活著的玩家裡換一個目標（11-05 我補的：整個重抽可能抽到沒預警過的捏碎 / 天罰，把人甩進毒水）。
// noCrush = 這一回合在最後之光那幾回合裡（resolveGaiaTurn 在誅滅之前先算好的）；
// stackPre = 最後之光傳送之前先算好的同罰分擔名單（見 resolveGaiaTurn；沒傳送 = null，照現在的位置算）
function moveStep(match, g, noCrush, stackPre = null) {
  const S = gaiaState(match);
  let plan = S.next || {};
  if (plan.action === 'stack') {
    const alive = match.players.filter(e => e.alive);
    const target = alive.find(e => e.id === plan.targetId);
    if (!target) {
      plan = { action: 'stack', targetId: match.rng.pick(alive).id };   // moveStep 只在有人活著時才跑
      stackPre = null;
    }
    return stackStep(match, g, match.byId(plan.targetId), stackPre);
  }
  const ok = (plan.action === 'crush' && !noCrush) ||
    (plan.action === 'smite' && (plan.side === 1 || plan.side === -1)) ||
    plan.action === 'cleanse';
  if (!ok) plan = rollPlan(match, noCrush);
  if (plan.action === 'cleanse') return cleanseStep(match, g);
  if (plan.action === 'stack') return stackStep(match, g, match.byId(plan.targetId));
  return slamStep(match, g, plan);
}

/**
 * 捏碎 / 天罰的傷害、同罰的總傷害（還沒乘敵人倍率）：武器的 damage（每一名開場玩家多少）× 開場的玩家數（含之後倒下的，同大樹遊俠 / 調皮妖精）。
 * 使用者 11-04：傷害照人數放大、不寫死（寫死的話人少很難打）
 */
export function gaiaDamage(match, weapon) {
  return weapon.damage * Math.max(1, match.players.length);
}

/**
 * 捏碎 / 天罰：範圍裡的每個人各一道震波（WEAPONS.gaiaCrush / gaiaSmite），從他靠祭壇（中間）的那一側、他身體中心的高度出發，
 * 水平往外衝向他（穿過地形、只撞得到他）：撞擊點跟身體中心一樣高 → 擊退水平往外、往上彈一點（客戶端照事件重播飛出去，可能被甩進毒水）。
 * 往哪一邊：捏碎看他在祭壇的哪一邊（正好在祭壇正上方的隨機一邊）、天罰就是那一邊（往牆那邊）。
 * 回傳 { action, side?（天罰）, targetIds, dirs（每個人被推的方向，照 targetIds）, cast, shot | still（範圍裡沒有人）}
 */
function slamStep(match, g, plan) {
  const S = gaiaState(match);
  const crush = plan.action === 'crush';
  const base = crush ? CONFIG.WEAPONS.gaiaCrush : CONFIG.WEAPONS.gaiaSmite;
  const W = { ...base, damage: gaiaDamage(match, base) };
  const ax = S.def.altar.x;
  const targets = zoneTargets(match, plan);
  const dirs = targets.map(t => (!crush ? plan.side : t.x > ax ? 1 : t.x < ax ? -1 : (match.rng.int(0, 1) ? 1 : -1)));
  const info = { action: plan.action, ...(crush ? {} : { side: plan.side }), targetIds: targets.map(t => t.id), dirs, dmg: W.damage, cast: CONFIG.GAIA.cast[plan.action] };
  if (!targets.length) return done(match, { ...info, still: stillResult(match) });
  const projs = targets.map((t, k) => {
    const dir = dirs[k];
    const p = bossProjectile(g, W, t.cx - dir * (t.hw + 14), t.cy, dir * W.speed, 0);
    for (const e of match.entities) if (e !== t) p.ignore.add(e);
    p.stopAt = t;
    return p;
  });
  return done(match, { ...info, shot: bossShot(match, g, W, projs, -1) });
}

/**
 * 巨拳・同罰：鎖定的人 t 與他身邊 stackRadius 以內的活著的玩家（stackSharers）平分總傷害 gaiaDamage(gaiaStack)（每人 round(總傷害 / 人數)，
 * 再吃一般的敵人傷害倍率；不擊退）。每個分擔的人頭上各落下一記拳（垂直往下、穿過地形、只撞得到他）；客戶端照事件重播。
 * 回傳 { action, targetId, targetIds（分擔的人，照玩家的順序）, dmg（每人，還沒乘敵人倍率）, total, cast, shot }
 */
function stackStep(match, g, t, pre = null) {
  const base = CONFIG.WEAPONS.gaiaStack;
  const total = gaiaDamage(match, base);
  // pre = 傳送前先算好的分擔名單（最後之光那一回合）：照那份、拳頭落在他們傳送後的頭上；不然照現在的位置
  const sharers = pre ? match.players.filter(e => e.alive && (e === t || pre.includes(e.id))) : stackSharers(match, t);
  const each = Math.round(total / sharers.length);
  const W = { ...base, damage: each };
  const info = { action: 'stack', targetId: t.id, targetIds: sharers.map(e => e.id), dmg: each, total, cast: CONFIG.GAIA.cast.stack };
  const projs = sharers.map(e => {
    const p = bossProjectile(g, W, e.cx, e.y - e.h - STACK_DROP, 0, W.speed);
    for (const o of match.entities) if (o !== e) p.ignore.add(o);
    p.stopAt = e;
    return p;
  });
  return done(match, { ...info, shot: bossShot(match, g, W, projs, -1) });
}

// 自然・淨化（11-04 U：只淨化她自己、會回血）：移除她自己的負面狀態（中毒層數、燃燒、流血、糾纏；被鎖住的上限不回來，同玩家的祭壇淨化），
// 固定回 cleanseHealPct% 最大血量（沒有負面狀態也回）。不碰玩家、沒有傷害
function cleanseStep(match, e) {
  const cleared = NEGATIVE.filter(k => e[k] > 0);
  Object.assign(e, { poison: 0, burn: 0, burnFrac: 0, bleed: 0, bleedFrac: 0, entangle: 0 });
  const heal = match.heal(e, e.maxHp * CONFIG.GAIA.cleanseHealPct / 100);
  return done(match, { action: 'cleanse', cleared, heal, hp: e.hp, cast: CONFIG.GAIA.cast.cleanse, still: stillResult(match) });
}

// ---------- 指名 / 插話（2026-11-10，通用的流程在 shared/maps/marks.js；數字見 config.GAIA.marks）----------

/**
 * 場上踩得住的每一片：六道斜坡（surf 0 ~ 5，關卡的 slopes）、中間三層平台（surf 6 ~ 8，關卡的 tiers）。
 * 每片 { surf, x0, y0, x1, y1 }（平台 y0 = y1），表面高度照 slopeY
 */
export function surfacesOf(def) {
  const n = def.slopes.length;
  return [
    ...def.slopes.map((s, i) => ({ surf: i, x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 })),
    ...def.tiers.map((t, i) => ({ surf: n + i, x0: t.x0, y0: t.y, x1: t.x1, y1: t.y })),
  ];
}

/** 腳底踩在 s 那一片上（左右在那一片的範圍裡、腳底離表面 tol 以內）。p 只用 x / y / hw */
export function footOn(s, p, tol = CONFIG.GAIA.marks.footTol) {
  const lo = Math.min(s.x0, s.x1), hi = Math.max(s.x0, s.x1);
  if (p.x < lo - p.hw || p.x > hi + p.hw) return false;
  return Math.abs(p.y - slopeY(s, clamp(p.x, lo, hi))) <= tol;
}

/** p 現在腳下是哪一片（踩著的；都沒踩著就找正下方最近的那一片）；都沒有 = null */
function surfaceUnder(def, p) {
  const all = surfacesOf(def);
  const on = all.filter(s => footOn(s, p)).sort((a, b) => Math.abs(p.y - slopeY(a, p.x)) - Math.abs(p.y - slopeY(b, p.x)))[0];
  if (on) return on;
  let best = null, gap = Infinity;
  for (const s of all) {
    if (p.x < Math.min(s.x0, s.x1) || p.x > Math.max(s.x0, s.x1)) continue;
    const d = slopeY(s, p.x) - p.y;
    if (d >= -CONFIG.GAIA.marks.footTol && d < gap) { best = s; gap = d; }
  }
  return best;
}

/**
 * 大地之手要把 p 丟到哪裡：隨機另一道斜坡（不是他回合開始時踩的那一道；站在平台上 = 六道都可以），
 * x 在那一道的 20% ~ 80% 之間（同開花的範圍），腳底照那裡站得住的高度。回傳 { x, y, slope }
 */
function throwSpot(match, def, p, from) {
  const choices = def.slopes.map((s, i) => i).filter(i => !from || i !== from.surf);
  const k = match.rng.pick(choices);
  const s = def.slopes[k];
  const t = FLOWER_SPAN[0] + (FLOWER_SPAN[1] - FLOWER_SPAN[0]) * match.rng.float();
  const x = Math.round(s.x0 + (s.x1 - s.x0) * t);
  const y = standY(match, p, x, slopeY(s, x) - 1) ?? Math.round(slopeY(s, x)) - 1;
  return { x, y, slope: k };
}

/** 石頭手抓不抓得到 p：左右重疊、腳底沒高過手、身體沒在它底下（同古樹尖刺的判定） */
export function inHand(z, p) {
  return Math.abs(p.x - z.x) < z.w / 2 + p.hw && p.y > z.y - z.h && p.y - p.h < z.y + 6;
}

/**
 * 蓋亞的指名（spec 的欄位見 marks.js）：
 *   quake 大地・脈動：範圍 = 回合開始時腳下那一片 { surf, x0, y0, x1, y1 }（找不到 surf = -1，打不到人）；
 *                     發動那一刻腳還踩在那一片上（站得住、離表面 footTol 以內）就中
 *   grab 大地之手・攫取：範圍 = 回合開始時腳底那一塊 { x, y, w, h }，丟到哪裡回合開始就抽好（tx, ty, ts = 第幾道斜坡，客戶端中了才畫）
 */
export const GAIA_MARKS = {
  state: gaiaState,
  boss: (match) => gaiaOf(match),
  config: () => CONFIG.GAIA.marks,
  zone: (match, e, kind) => {
    const S = gaiaState(match);
    const M = CONFIG.GAIA.marks;
    const under = surfaceUnder(S.def, e);
    if (kind === 'quake') return under ? { ...under } : { surf: -1, x0: r1(e.x), y0: r1(e.y), x1: r1(e.x), y1: r1(e.y) };
    const to = throwSpot(match, S.def, e, under);
    return { x: r1(e.x), y: r1(e.y), w: M.zoneW, h: M.grabH, tx: to.x, ty: r1(to.y), ts: to.slope };
  },
  hits: (z, p, match) => (z.kind === 'quake'
    ? z.surf >= 0 && footOn(z, p) && p.standing(match.terrain, p.x, p.y)
    : inHand(z, p)),
  binds: () => false,
  strike: (match, z, p, boss) => hitOn(match, p, perPlayer(match, z.kind === 'quake' ? CONFIG.WEAPONS.gaiaQuake : CONFIG.WEAPONS.gaiaGrab), boss),
  squeeze: () => [],
  moveTo: (match, z) => (z.kind === 'grab' ? { x: z.tx, y: z.ty } : null),
};

export const GAIA_MARK_NAMES = { quake: '大地・脈動', grab: '大地之手・攫取' };

// 指名下一組（見 marks.js 的 markStep）：回傳 { action: 'mark', targetIds, kinds, cast, still }，沒有人可以指名 = null
export const gaiaMarkStep = (match, afterId) => markStepOf(match, GAIA_MARKS, afterId);
export const syncGaiaMarks = (match) => syncMarks(match, GAIA_MARKS);
export const gaiaHazardStart = (match, e, now) => marksHazardStart(match, GAIA_MARKS, e, now);
export const gaiaHazardStep = (match, now, flush = false, active = true) => marksHazardStep(match, GAIA_MARKS, now, flush, active);

/**
 * 插話行動（3 人以上，連續 2 位玩家之後；見 Match.interjectBefore）：指名剩下還沒輪到的人。
 * 祭壇淨化讓她暈眩、還沒輪到她（S.stunned）就不插話（我補的：「一輪不能行動」連插話也算）。沒有人可以指名 = null（裁判直接換下一位）
 */
export function resolveGaiaInterject(match, g, afterId) {
  const S = gaiaState(match);
  if (!S || S.stunned || !g || !g.alive) return null;
  const mark = gaiaMarkStep(match, afterId);
  return mark ? { steps: [mark], next: S.next ? { ...S.next } : null } : null;
}

// ---------- 快照 ----------

export function gaiaSnapshot(match) {
  const S = match.mechState;
  return {
    gaia: {
      next: S.next ? { ...S.next } : null, fog: S.fog, nextFog: S.nextFog, orbs: S.orbs, need: S.need,
      flowers: S.flowers.map(f => ({ ...f })), stunned: S.stunned, rage: S.rage, lightAt: S.lightAt,
      light: S.light ? { ...S.light } : null, seq: S.seq, marks: marksSnapshot(S).marks,
    },
  };
}

// 套用快照（地形之後、角色狀態之前）。只帶一部分欄位（客戶端收到 turn / turnFx 時只帶 { items }）→ 不動。暴走的門檻照狀態重算
export function restoreGaia(match, s) {
  const S = gaiaState(match);
  const P = s && s.gaia;
  if (!S || !P) return;
  Object.assign(S, {
    next: P.next ? { ...P.next } : null, fog: !!P.fog, nextFog: P.nextFog | 0, orbs: P.orbs | 0, need: P.need | 0,
    flowers: (P.flowers || []).map(f => ({ ...f })), stunned: !!P.stunned, rage: !!P.rage,
    lightAt: Number.isFinite(P.lightAt) ? P.lightAt : null, light: P.light ? { ...P.light } : null, seq: P.seq | 0,
  });
  restoreMarks(match, GAIA_MARKS, P.marks, undefined);   // 指名（沒帶 = 不動；蓋亞不綁人）
  const g = gaiaOf(match);
  if (g) g.hpFloor = floorHp(g, S);
}
