import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { buildCave, torchLevel, shadowMult } from './cave.js';
import { bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// Boss 關「巨蠍巢穴」的洞穴巨蠍（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/scorpion.js。這張地圖也是洞穴（鐘乳石、火把、陰影，規則在 cave.js），
// 這一場的狀態 match.mechState = 洞穴的狀態（def、lit、fallen）+ 會不會颳風（windy）+ 巨蠍現在在第幾個洞（hole）、面向哪邊（facing）、
// 出洞了沒（out）、暈眩中（stunned）。
//
// - 牆上三個洞（level.mechanic.holes，背景，人走得過去），每個洞旁邊一支火把（holes[i].torch，三支在不同高度）。
//   多人時會颳風（level.mechanic.windy 且不是單人）：每一輪開始火把全部被吹熄（規則在 cave.js），只有這一輪點燃的亮著；單人照一般洞穴（三輪燒完）。
// - 巨蠍有兩種狀態（2026-10-12 使用者改版）：
//     躲著（out = false）：縮在洞的深處，畫面上只有洞穴中間一對發紅的雙眼；三個部位碰不到（Entity.intangible：子彈穿過、炸不到、AI 不瞄）
//     出洞（out = true）：整隻在洞口，三個部位打得到
// - 三個部位是三個固定不動的角色（boss、fixed），各有自己的血量（SCORPION.hp，照 Boss 的倍率放大），打到哪個扣哪個：
//     背甲（身體，最大塊、橢圓）、巨鉗（頭前面的鉗子，低）、毒針（尾巴頂端，最小、最高）。三個都擊破 = 打倒（沒有另外的本體血量）。
//   巨蠍的回合由還沒擊破的第一個部位代表（照 PARTS 的順序；其他部位 noTurn，見 syncLead）。
// - 被火光逼出來（revealIfLit，單人多人都一樣）：巨蠍躲著的那個洞的火把亮著 → 出洞（打得到）並暈眩。判定的時間點：
//     玩家點燃火把的當下（這一輪亮著，牠這一輪的回合就是暈眩）；
//     每一輪開始、這一輪的火把算好之後（多人颳風吹熄、單人變暗 / 燒完之後）還亮著——牠上一輪鑽進一個火把亮著的洞，要到這時候才算
//     （2026-10-13 使用者：「先計算這回合火把是不是亮著，再算是否判定成暈眩」：不會出現暈眩了火把卻是暗的）。
//   伺服器與客戶端照同一個條件各自推，不另外廣播
// - 巨蠍的回合（resolveScorpionTurn）：
//     暈眩中 → 什麼都不做（stunned），留在洞口
//     出洞（暈眩醒來）→ 震擊周圍（shock：從洞口中間往兩邊衝到洞口邊，打站在洞口前面地上的人、往外推，WEAPONS.scorpionBurst）
//                     + 還沒擊破的部位各出一招（照 ATTACKS 的順序）→ 鑽地（burrow）換到別的洞（隨機，不會是同一個）躲著、面向玩家那邊
//                     （那個洞的火把下一輪開始還亮著的話，那時候才被逼出來、暈眩）
//         一回合最多動三次，每擊破一個部位就永久少一次、那一招不會再出
//         （使用者：「每擊破一個部位就會停止行動，不然蠍子一回合會動三次」→ 永久少一次）
//           巨鉗 → 巨鉗夾擊（pinch）：夾 SCORPION.pinchReach 內離鉗子最近的玩家；範圍裡沒人 = 撲空（snap）
//           背甲 → 甲殼地鳴（quake）：震波貼著地面往兩邊跑到地圖邊，只打腳踩在地上的人
//           毒針 → 毒刺（sting）：每位活著的玩家各射一發（直線、穿過地形、上毒）
//     躲著 → 不出來，只從洞裡射毒刺（hidden：從雙眼那裡、每位玩家各一發）；毒針被擊破了就什麼都不做（lurk）
//     玩家全倒就停（後面的招都不出）
// - 巨蠍出洞時的攻擊不吃洞穴的陰影加成（暈眩是給玩家的獎勵，醒來那一回合火把常常剛被吹熄，不該變成懲罰；使用者 10-12）
// - 洞頂的鐘乳石照洞穴的規則：被打到 / 炸到就掉下來，砸到下面出洞的部位（毒針最高，先砸到它；躲著的碰不到）

export const SCORPION_NAME = '洞穴巨蠍';

export const SCORPION_ACTION_NAMES = {
  pinch: '巨鉗夾擊',
  snap: '巨鉗撲空',
  quake: '甲殼地鳴',
  sting: '毒刺',
  burrow: '鑽地換洞',
  lurk: '躲在暗處',
  stunned: '暈眩中',
  shock: '震擊周圍',
};

// 三個部位（陣列順序 = 角色排在 entities 的順序 = 誰代表巨蠍輪回合）。short = 畫面 / 橫幅上的短名
export const PARTS = [
  { key: 'shell', id: 'scorpionShell', name: '巨蠍・背甲', short: '背甲', action: 'quake' },
  { key: 'pincer', id: 'scorpionPincer', name: '巨蠍・巨鉗', short: '巨鉗', action: 'pinch' },
  { key: 'stinger', id: 'scorpionStinger', name: '巨蠍・毒針', short: '毒針', action: 'sting' },
];
const PART_BY_KEY = Object.fromEntries(PARTS.map(P => [P.key, P]));

// 一回合出招的順序：先夾、再震、最後射
export const ATTACKS = ['pincer', 'shell', 'stinger'];

// 部位的判定（相對於洞口中間 ax、地面 gy、面向 f）：中心 x = ax + f × dx，腳底 y = gy - lift，半寬 hw、高 h。
// 畫面（client/map-views/scorpion.js）照同一組數字畫身體、鉗子、尾巴
export const BODY = {
  shell: { dx: -8, hw: 70, h: 58, lift: -2, shape: 'ellipse' },   // 身體：橢圓，下緣貼著地面
  pincer: { dx: 84, hw: 28, h: 48, lift: -2 },                     // 頭前面的一對鉗子（到洞口邊為止）
  stinger: { dx: -4, hw: 15, h: 30, lift: 212 },                   // 尾巴翹起來捲到背上方的毒針
};

// 第 i 個洞的洞口中間
export const holeX = (def, i) => (def.holes[i].x0 + def.holes[i].x1) / 2;

// 部位 key 在第 hole 個洞、面向 facing 時的判定框 { x, y（腳底）, hw, h, shape }
export function partBox(def, hole, facing, key) {
  const B = BODY[key];
  return { x: holeX(def, hole) + facing * B.dx, y: def.ground - B.lift, hw: B.hw, h: B.h, shape: B.shape || null };
}

// 躲著的時候雙眼在洞的哪裡（洞穴中間：洞口中間、洞頂到地面的一半）。從暗處射的毒刺也從這裡出發
export function lurkPoint(def, hole) {
  return { x: holeX(def, hole), y: (def.holes[hole].top + def.ground) / 2 };
}

// 這一場巨蠍的狀態（match.mechState）。別張地圖（沒有 hole 或沒有洞穴的 lit）當作沒有巨蠍
const scorpionState = (match) => (match.mechState && Array.isArray(match.mechState.lit) && 'hole' in match.mechState ? match.mechState : null);

/** 第 hole 個洞的火把亮著嗎（亮度 > 0；變暗了也算）：亮著巨蠍才會衝出來 */
export function holeLit(match, hole) {
  const S = scorpionState(match);
  const t = S && S.def.holes[hole] ? S.def.holes[hole].torch : null;
  return Number.isInteger(t) && torchLevel(match, t) > 0;
}

/** 出洞 / 躲著：狀態跟三個部位碰不碰得到（Entity.intangible）一起改。伺服器出招、客戶端播動畫、快照都用這個 */
export function setOut(match, out) {
  const S = scorpionState(match);
  if (!S) return;
  S.out = !!out;
  for (const P of PARTS) {
    const e = match.byId(P.id);
    if (e) e.intangible = !S.out;
  }
}

/** 這一關是不是單人（只有 1 位玩家） */
export const isSolo = (match) => match.players.length <= 1;

/**
 * 攻擊者這一下的傷害倍率（地圖機制的 attackMult）：照洞穴的陰影規則（暗處的敵人 +30%），
 * 但巨蠍出洞的攻擊不吃陰影加成——只有被火光逼出來（獎勵：暈眩）才會出洞，醒來那一回合火把常常剛被風吹熄（多人）/ 變暗，
 * 照陰影規則反而變成懲罰（2026-10-12 使用者）。躲在暗處射的毒刺照樣有加成
 */
export function scorpionAttackMult(match, attacker, weapon) {
  const S = scorpionState(match);
  if (S && S.out && isScorpionPart(attacker)) return 1;
  return shadowMult(match, attacker, weapon);
}

/**
 * 被火光逼出來：巨蠍躲著、而牠那個洞的火把亮著 → 馬上出洞並暈眩（單人多人都一樣）。回傳有沒有這次被逼出來。
 * 火把點燃的當下（伺服器：打到 / 飛過 / 走過火把之後；客戶端：照事件點燃火把之後、伺服器廣播的 pickup 之後）、
 * 每一輪開始（伺服器：地圖機制的 roundStart，火把照新的輪數算好之後；客戶端：看到輪數變了）都呼叫，兩邊照同一個條件各自推
 */
export function revealIfLit(match) {
  const S = scorpionState(match);
  if (!S || S.out || !holeLit(match, S.hole)) return false;
  setOut(match, true);
  S.stunned = true;
  return true;
}

/** 部位的角色（key = 'shell' | 'pincer' | 'stinger'） */
export const partOf = (match, key) => match.byId(PART_BY_KEY[key].id);

/** 這個角色是不是巨蠍的部位 */
export const isScorpionPart = (e) => !!e && PARTS.some(P => P.id === e.id);

/** 還沒擊破的部位有幾個 = 巨蠍每回合出幾招 */
export function actionsPerTurn(match) {
  return PARTS.reduce((n, P) => { const e = match.byId(P.id); return n + (e && e.alive ? 1 : 0); }, 0);
}

// 面向哪邊：活著的玩家平均在洞口的哪一邊（剛好在正中間 / 沒人就照 keep）
function faceToward(match, def, hole, keep) {
  const alive = match.players.filter(e => e.alive);
  if (!alive.length) return keep;
  const avg = alive.reduce((s, e) => s + e.x, 0) / alive.length;
  const ax = holeX(def, hole);
  return avg > ax ? 1 : avg < ax ? -1 : keep;
}

// 建立巨蠍的三個部位（關卡的敵人之後），回傳這一場的狀態（洞穴的狀態 + 會不會颳風（多人才颳）+ 在哪個洞、面向、一開始躲著）。
// hpScale = Boss 的血量倍率（關卡規則的 bossHp：每多一位玩家 +50%，第二個王關以後再放大，見 shared/game/stage-rules.js）
export function buildScorpion(match, hpScale) {
  const def = match.level.mechanic;
  const hole = Number.isInteger(def.start) ? def.start : def.holes.length - 1;
  const facing = faceToward(match, def, hole, -1);
  const state = { ...buildCave(match), windy: !!def.windy && !isSolo(match), hole, facing, out: false, stunned: false };
  for (const P of PARTS) {
    const b = partBox(def, hole, facing, P.key);
    match.entities.push(new Entity({
      ...CONFIG.ENEMY, id: P.id, name: P.name, team: 'enemies', controller: 'ai', slot: 0, facing,
      x: b.x, y: b.y, hw: b.hw, h: b.h, shape: b.shape, boss: true, fixed: true, part: P.key,
      hp: Math.round(CONFIG.SCORPION.hp[P.key] * hpScale), intangible: true,
    }));
  }
  syncLead(match);
  return state;
}

// 誰代表巨蠍輪回合：還沒擊破的第一個部位（照 PARTS 的順序），其他部位不會輪到。
// 開場、每次有部位被擊破之後（地圖機制的 cascade）都重新指定，所以背甲被打掉之後換巨鉗輪。可以重複呼叫
export function syncLead(match) {
  let lead = null;
  for (const P of PARTS) {
    const e = match.byId(P.id);
    if (!e) continue;
    e.noTurn = !!lead || !e.alive;
    if (!lead && e.alive) lead = e;
  }
  return lead;
}

// 把三個部位（含已經擊破的：畫面照背甲的位置畫整隻）搬到第 hole 個洞、面向 facing
function placeParts(match, hole, facing) {
  const def = match.mechState.def;
  for (const P of PARTS) {
    const e = match.byId(P.id);
    if (!e) continue;
    const b = partBox(def, hole, facing, P.key);
    e.x = b.x;
    e.y = b.y;
    e.facing = facing;
    e.vx = 0;
    e.vy = 0;
  }
}

// 鉗子尖（巨鉗夾擊從這裡出發、夾得到的範圍從這裡量）
export function clawPoint(pincer) {
  return { x: pincer.x + pincer.facing * pincer.hw, y: pincer.cy };
}

// 毒針尖（出洞時毒刺從這裡射出去）：毒針往前、往下彎
export function needlePoint(stinger) {
  return { x: stinger.x + stinger.facing * (stinger.hw + 6), y: stinger.y + 6 };
}

// 巨蠍的回合：暈眩中 → 什麼都不做；出洞（暈眩醒來）→ 震擊周圍、還沒擊破的部位各出一招、鑽地換到別的洞；
// 躲著 → 只從洞裡射毒刺。全部結算好，回傳 { steps, next: null }
// （格式同其他 Boss：每一招帶 shot 或 still；cast = 這一招預兆動畫的秒數，裁判照它算時間）。玩家全倒就停（後面的招都不出）
export function resolveScorpionTurn(match, actor) {
  const S = scorpionState(match);
  if (!S) return { steps: [{ action: 'idle', still: stillResult(match) }], next: null };
  const C = CONFIG.SCORPION.cast;
  const anyone = () => match.players.some(e => e.alive);
  if (S.stunned) {
    S.stunned = false;
    return { steps: [{ action: 'stunned', hole: S.hole, cast: C.attack, still: stillResult(match) }], next: null };
  }
  if (S.out) {
    const steps = [{ action: 'shock', hole: S.hole, cast: C.attack, shot: emergeShot(match, actor) }];
    for (const key of ATTACKS) {
      const part = partOf(match, key);
      if (!part || !part.alive || !anyone()) continue;
      steps.push({ ...attackStep(match, part, key), cast: C.attack });
    }
    if (anyone()) steps.push(burrowStep(match));
    return { steps, next: null };
  }
  const stinger = partOf(match, 'stinger');
  const step = stinger && stinger.alive && anyone()
    ? { action: 'sting', hidden: true, shot: stingShot(match, stinger, lurkPoint(S.def, S.hole)) }
    : { action: 'lurk', hole: S.hole, still: stillResult(match) };
  return { steps: [{ ...step, cast: C.attack }], next: null };
}

// 毒刺：從 from（出洞 = 毒針尖、躲著 = 洞穴中間的雙眼）往每位活著的玩家各射一發，一發接一發（直線、穿過地形、上毒）
function stingShot(match, stinger, from) {
  const weapon = CONFIG.WEAPONS.scorpionSting;
  const projs = match.players.filter(e => e.alive).map((target, k) => {
    const p = aimedProjectile(stinger, weapon, from, target);
    p.spawn = 1 + k * 5;
    return p;
  });
  return bossShot(match, stinger, weapon, projs, match.mechState.facing);
}

// 震擊周圍（暈眩醒來）：從洞口中間（地面上方一點）往左、往右各一道，衝到洞口邊就停（range）；兩道共用「打過誰」，每人最多挨一次
function emergeShot(match, owner) {
  const S = match.mechState;
  const weapon = CONFIG.WEAPONS.scorpionBurst;
  const lane = emergeLane(S.def, S.hole);
  const hitOnce = new Set();
  const projs = [-1, 1].map(dir => {
    const p = bossProjectile(owner, weapon, lane.x, lane.y, dir * weapon.speed, 0);
    p.range = lane.half;
    p.ignore = hitOnce;
    return p;
  });
  return bossShot(match, owner, weapon, projs, S.facing);
}

// 震擊周圍的範圍（伺服器與畫面共用）：從洞口中間 x、高度 y（地面上方一個判定半徑），往兩邊各跑 half px
// （跑到洞口邊再扣掉判定半徑：碰得到身體跟洞口重疊的人，洞口外面的碰不到）
export function emergeLane(def, hole) {
  const H = def.holes[hole];
  const r = CONFIG.WEAPONS.scorpionBurst.hitRadius;
  return { x: holeX(def, hole), y: def.ground - r, half: Math.max(0, (H.x1 - H.x0) / 2 - r) };
}

function attackStep(match, part, key) {
  const S = match.mechState;
  if (key === 'pincer') {
    const claw = clawPoint(part);
    const reach = CONFIG.SCORPION.pinchReach;
    let target = null, best = Infinity;
    for (const e of match.players) {
      if (!e.alive) continue;
      const d = Math.hypot(e.cx - claw.x, e.cy - claw.y);
      if (d <= reach && d < best) { best = d; target = e; }
    }
    if (!target) return { action: 'snap', still: stillResult(match) };
    const weapon = CONFIG.WEAPONS.scorpionPinch;
    return { action: 'pinch', targetId: target.id, shot: bossShot(match, part, weapon, [aimedProjectile(part, weapon, claw, target)], S.facing) };
  }
  if (key === 'shell') {
    // 從身體中間往兩邊（洞口背景，人走得進巨蠍身體下面：那裡的人也會被震到）；兩道共用「打過誰」
    const weapon = CONFIG.WEAPONS.scorpionQuake;
    const y = S.def.ground - 4;
    const hitOnce = new Set();
    const projs = [-1, 1].map(dir => {
      const p = bossProjectile(part, weapon, part.x, y, dir * weapon.speed, 0);
      p.ignore = hitOnce;
      return p;
    });
    return { action: 'quake', shot: bossShot(match, part, weapon, projs, S.facing) };
  }
  // 毒針：每位玩家各一發
  return { action: 'sting', shot: stingShot(match, part, needlePoint(part)) };
}

// 從 from 直線飛向目標身體中間的一顆
function aimedProjectile(owner, weapon, from, target) {
  const dx = target.cx - from.x, dy = target.cy - from.y;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  return bossProjectile(owner, weapon, from.x, from.y, dx / d * weapon.speed, dy / d * weapon.speed);
}

// 鑽地換洞：隨機挑別的洞（不會是同一個），面向玩家那邊，三個部位搬過去、躲著（那個洞的火把亮不亮，下一輪開始才算）
function burrowStep(match) {
  const S = match.mechState;
  const from = S.hole;
  const to = match.rng.pick(S.def.holes.map((h, i) => i).filter(i => i !== from));
  S.facing = faceToward(match, S.def, to, S.facing);
  S.hole = to;
  placeParts(match, to, S.facing);
  setOut(match, false);
  return { action: 'burrow', from, to, facing: S.facing, cast: CONFIG.SCORPION.cast.burrow, still: stillResult(match) };
}

// 快照：在哪個洞、面向、出洞了沒、暈眩中（部位的位置跟著角色狀態走）
export function scorpionSnapshot(match) {
  const S = match.mechState;
  return { scorpionHole: S.hole, scorpionFacing: S.facing, scorpionOut: S.out, scorpionStunned: S.stunned };
}

// 套用快照：只帶一部分欄位時沒帶的不動
export function restoreScorpion(match, s) {
  const S = scorpionState(match);
  if (!S) return;
  if (Number.isInteger(s.scorpionHole)) S.hole = s.scorpionHole;
  if (s.scorpionFacing === 1 || s.scorpionFacing === -1) S.facing = s.scorpionFacing;
  if (typeof s.scorpionOut === 'boolean') setOut(match, s.scorpionOut);
  if (typeof s.scorpionStunned === 'boolean') S.stunned = s.scorpionStunned;
}
