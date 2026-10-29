import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';
import { standSpot, standY } from './guardian.js';

// Boss 關「處刑監獄」的處刑官與三隻猛獸（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/prison.js。這一場的狀態 match.mechState（buildPrison 建的那一份）：
//   def（關卡的 mechanic）、hpScale（猛獸的血量倍率 = 王的）、released（開了幾間牢房）、up（王在處刑台上）、
//   mood（'calm' 平常 / 'cry' 坐在地上哭 / 'rage' 暴怒）、cryLeft（還要哭幾個自己的回合）、next（王預定的下一招）、
//   beastNext（猛獸 id → 預定的下一招）、whip（被鞭過、下一次攻擊加成的猛獸 id）、sinner（罪人的玩家 id，見 pickSinner）、
//   hug（熊抱著人 { bearId, victimId, need（被打到多少放開）, dmg（抱著之後被打了多少） }，見 hugStep）、
//   stuns（被吊燈砸暈、下一個自己的回合不能動的角色 id）、cage（場上的囚籠 { id, prisonerId, round }）、
//   spawned（放出來的猛獸 / 召喚的囚籠的出生資料，重連時照著重建；猛獸的帶 round = 第幾輪放出來的）、seq（囚籠的流水號）、fallen（掉下來的吊燈）、
//   fury（處刑官被攻擊了幾次，見 furyExtras）
//
// 2026-10-19 使用者定的規則（數字見 config.EXECUTIONER / WOLF / BEAR / TIGER）：
// - 處刑官從最右邊出場。三招：菜刀丟擲（流血；本來丟一個人，每死一隻召喚獸多丟一個人，2026-10-22 使用者，見 cleaverCount）、
//   訓獸者皮鞭（打自己的召喚獸、讓牠下一次攻擊加成；不疊加、打不死）、
//   處刑者囚籠（場上最多一個；把人關起來，籠子有血量，隊友打破；被關的人照樣可以開火——往哪裡射都一出砲口就打在籠子上、自己的攻擊傷不到自己（2026-10-19 使用者）；撐過 cageRounds 輪還關著 → 召喚斷頭台、鎖鏈拖過去秒殺）
// - 血量到 phases（80 / 60 / 40%）就停住（hpFloor：多打的不算），不管是誰的回合馬上跳上右上的處刑台、打開下一間牢房（惡狼 → 棕熊 → 劍齒虎）；
//   跳上去之前先清掉自己身上所有的負面狀態（2026-10-28 使用者：原本要等輪到他才跳，見 syncRelease）。
//   在台上打不到（Entity.intangible），照樣出招；放出來的那隻一倒下就馬上跳下來（2026-10-22 使用者：原本要等輪到他才跳，見 syncPerch）
// - 處刑官每被攻擊（打中、扣到血）一次，武器傷害 +furyPct%，一直累積（2026-10-28 使用者，S.fury，見 furyExtras）
// - 三隻都倒下 → 坐在地上哭 cryTurns 個自己的回合（不行動，受到的傷害 +cryDamagePct%）→ 暴怒站起來（紅眼）、拿出流星錘
// - 罪人（2026-10-28 使用者）：開場隨機挑一個玩家，倒下（被處刑也算）才換人（S.sinner，見 pickSinner）。所有攻擊都先打罪人：
//   菜刀（丟好幾把時第一把丟罪人、再來被熊抱住的人，其他照舊隨機）、囚籠、流星錘、惡狼撕咬、棕熊熊掌拍擊與熊抱；
//   只有劍齒虎照舊撲所有流血的人（沒人流血才撲罪人）。處刑官的攻擊也先打被熊抱住的人（priorityPlayers）
// 我補的（使用者沒指定，回覆說明過）：
// - 王每一招都事先抽好（next，玩家回合畫面上標出來：菜刀 / 囚籠 / 流星錘要打誰）；權重 weights，暴怒後換 rageWeights（沒有召喚獸了，沒有皮鞭）
// - 囚籠到期的那一回合直接處刑（不出別的招）；哭的時候不處刑（籠子還在，隊友可以趁機打破）
// - 猛獸剛放出來的那一輪不動（dormant，同古樹的樹妖）。猛獸的招式（使用者採用我的建議）：
//     惡狼：撕咬，撲向罪人（沒有罪人才撲有流血的人：層數最多的；都沒有就最近的人）——只咬一個（2026-10-22 使用者：那時候菜刀也只丟一把）
//     棕熊：熊掌拍擊（撲向罪人、拍飛）/ 熊抱（2026-10-28 使用者採用我的建議，取代護主：衝到罪人身上抱住他，見 hugStep；
//       被抱的人走不動、開火打在熊身上，熊被打到最大血量的 hugBreakPct% 就放開，輪到牠時還抱著就重摔、甩出去；罪人被關在囚籠裡抱不到 → 改成熊掌拍擊他）
//     劍齒虎：輪到牠時撲咬所有有流血的玩家（2026-10-22 使用者；一個撲完再撲下一個，先撲近的，直直撲過去、路上的人擋不到）；
//       沒人流血就撲罪人（2026-10-28 使用者：原本是標記血最少的人；路上第一個人先被撲到，隊友可以擋）。吃掉被撲到的人的流血層數，每層再 +bleedBonus
// - 天花板的吊燈（關卡的 stalactites，跟洞穴的鐘乳石同一套地形）：打到 / 炸到鏈子或燈就掉下來（WEAPONS.chandelier），
//   砸到第一個角色，砸到敵人（猛獸、在地上的王）另外暈眩一回合（stuns）

export const EXEC_NAME = '處刑官';

export const EXEC_ACTION_NAMES = {
  cleaver: '菜刀丟擲',
  whip: '訓獸者皮鞭',
  cage: '處刑者囚籠',
  execute: '斷頭台處刑',
  release: '打開牢房',
  descend: '跳下處刑台',
  cry: '哭泣',
  rage: '暴怒',
  flail: '流星錘',
  stunned: '暈眩中',
  bite: '撕咬',
  swipe: '熊掌拍擊',
  hug: '熊抱',
  slam: '熊抱重摔',
  pounce: '飛撲',
  idle: '發呆',
};

// 三間牢房的猛獸（陣列順序 = 打開的順序 = 關卡 mechanic.cells 的順序）
export const BEASTS = [
  { kind: 'wolf', id: 'wolf', name: '惡狼', cfg: 'WOLF', weapon: 'wolfBite' },
  { kind: 'bear', id: 'bear', name: '棕熊', cfg: 'BEAR', weapon: 'bearSwipe' },
  { kind: 'tiger', id: 'tiger', name: '劍齒虎', cfg: 'TIGER', weapon: 'tigerPounce' },
];
const BEAST_BY_KIND = Object.fromEntries(BEASTS.map(B => [B.kind, B]));
export const isBeast = (e) => !!e && !!BEAST_BY_KIND[e.kind];
export const NUMERALS = ['I', 'II', 'III'];

const BLADE_DROP = 150;   // 鍘刀從被處刑的人腳底上面多高落下來（斷頭台的高度，畫面照它畫）

// 這一場的狀態（match.mechState）。別張地圖當作沒有
export const prisonState = (match) => (match.mechState && match.mechState.def && match.mechState.def.type === 'prison' ? match.mechState : null);
export const bossOf = (match) => match.byId('executioner');

// 建立處刑官（關卡的敵人之後），回傳這一場的狀態。bossScale = 王的血量倍率（人數 × 第幾個王關）：猛獸也照這個
// （跟古樹的樹妖一樣不吃小關的「每過一關」；血量見 config：使用者選的方案 A 300 / 90 / 120 / 150）。囚籠另外算（50 × 人數，見 cageStep）
export function buildPrison(match, { bossScale }) {
  const def = match.level.mechanic;
  const E = CONFIG.EXECUTIONER;
  const boss = new Entity({
    ...CONFIG.ENEMY, id: 'executioner', name: EXEC_NAME, team: 'enemies', controller: 'ai', slot: 0, facing: -1, kind: 'executioner',
    x: def.boss.x, y: def.boss.y, hw: E.hw, h: E.h, hp: Math.round(E.hp * bossScale), boss: true, weapons: ['execCleaver'],
  });
  match.entities.push(boss);
  boss.hpFloor = floorHp(boss, 0);
  return {
    def, hpScale: bossScale, released: 0, up: false, mood: 'calm', cryLeft: 0, next: null, beastNext: {}, whip: null, sinner: null, hug: null,
    stuns: [], cage: null, spawned: [], seq: 0, fallen: [], fury: 0,
  };
}

// 第 k 個門檻（打開第 k 間牢房）的血量；三間都開過 = 0（沒有門檻了）
function floorHp(e, k) {
  const pct = CONFIG.EXECUTIONER.phases[k];
  return Number.isFinite(pct) ? Math.round((e.maxHp + e.poisonLock) * pct / 100) : 0;
}

/** 王的血量到下一個門檻了（要打開下一間牢房）：血量停在那裡（多打的不算），馬上跳上去（見 syncRelease） */
export function atThreshold(match) {
  const S = prisonState(match);
  const boss = bossOf(match);
  return !!(S && boss && boss.alive && S.released < BEASTS.length && boss.hp <= floorHp(boss, S.released));
}

/** 上 / 下處刑台：狀態跟王碰不碰得到（Entity.intangible）一起改。伺服器出招、客戶端播動畫、快照都用這個 */
export function setUp(match, up) {
  const S = prisonState(match);
  if (!S) return;
  S.up = !!up;
  const boss = bossOf(match);
  if (boss) boss.intangible = S.up;
}

/** 現在放出來、還活著的猛獸（一次只會有一隻）；沒有 = null */
export function liveBeast(match) {
  return match.enemies.find(e => isBeast(e) && e.alive) || null;
}

/** 王的傷害倍率（地圖機制的 attackMult）：處刑官被打過幾下 × furyPct%（S.fury，見 furyExtras）；被皮鞭鞭過的猛獸這一下 +whipPct% */
export function prisonAttackMult(match, attacker) {
  const S = prisonState(match);
  if (!S || !attacker) return 1;
  if (attacker.kind === 'executioner') return 1 + (S.fury || 0) * CONFIG.EXECUTIONER.furyPct / 100;
  return S.whip === attacker.id ? 1 + CONFIG.EXECUTIONER.whipPct / 100 : 1;
}

/** 受到的傷害倍率（地圖機制的 defenseMult）：哭的王 +cryDamagePct% */
export function prisonDefense(match, e) {
  const S = prisonState(match);
  if (!S) return 1;
  if (e.kind === 'executioner' && S.mood === 'cry') return 1 + CONFIG.EXECUTIONER.cryDamagePct / 100;
  return 1;
}

// ---------- 罪人、熊抱（2026-10-28 使用者） ----------

/** 活著的罪人；沒有（還沒挑、倒下了還沒換）= null */
export function sinnerOf(match) {
  const S = prisonState(match);
  const e = S && S.sinner ? match.byId(S.sinner) : null;
  return e && e.alive ? e : null;
}

/** 被熊抱住、還活著的人；沒有 = null */
export function huggedOf(match) {
  const S = prisonState(match);
  const e = S && S.hug ? match.byId(S.hug.victimId) : null;
  return e && e.alive ? e : null;
}

/** 處刑官的攻擊先打的人（照順序）：罪人，再來被熊抱住的人（跟罪人不是同一個的話） */
export function priorityPlayers(match) {
  const out = [];
  const s = sinnerOf(match);
  if (s) out.push(s);
  const h = huggedOf(match);
  if (h && h !== s) out.push(h);
  return out;
}

/**
 * 罪人倒下了（或還沒挑）→ 隨機挑一個活著的玩家當罪人（match.rng，只有伺服器挑；2026-10-28 使用者：倒下才換）。
 * 開場（地圖機制的 ready）、每個人的回合結束（turnEnd，記進 turn.end 的 fx 給客戶端）、處刑官 / 猛獸的回合開始（保險：招式帶 sinnerId）叫。
 * 回傳 { id: 新的罪人, from?: 原本的 }，沒換 = null
 */
export function pickSinner(match) {
  const S = prisonState(match);
  if (!S || sinnerOf(match)) return null;
  const alive = match.players.filter(e => e.alive);
  if (!alive.length) return null;
  const from = S.sinner;
  S.sinner = match.rng.pick(alive).id;
  return { id: S.sinner, ...(from ? { from } : {}) };
}

// 熊放開之後退到被抱的人旁邊（抱的時候站在他身上；不退開的話他之後開火還是一出砲口就打在熊身上）：熊面向他，退到背後那一邊，站不下就換另一邊
function stepAside(match, bear, victim) {
  for (const side of [-bear.facing, bear.facing]) {
    const spot = standSpot(match, bear, victim.x + side * (victim.hw + bear.hw + 2), victim.y);
    if (!spot) continue;
    bear.x = spot.x;
    bear.y = spot.y;
    bear.vx = 0;
    bear.vy = 0;
    return;
  }
}

/**
 * 熊放開抱住的人：why = 'free' 被打到掙脫 / 'stun' 熊被吊燈砸暈 / 'cage' 處刑官把他關進囚籠 / 'dead' 熊或被抱的人倒下了。
 * 兩個都還活著的話熊退到旁邊（stepAside）。伺服器結算、客戶端重播都叫（兩邊照同一個條件算、不抽亂數）。
 * 回傳 { id: 熊, targetId: 被抱的人, why }，沒抱著 = null
 */
export function releaseHug(match, why) {
  const S = prisonState(match);
  if (!S || !S.hug) return null;
  const { bearId, victimId } = S.hug;
  S.hug = null;
  syncHolds(match);
  const bear = match.byId(bearId), victim = match.byId(victimId);
  if (bear && bear.alive && victim && victim.alive) stepAside(match, bear, victim);
  return { id: bearId, targetId: victimId, why };
}

// ---------- 放出來的角色（猛獸、囚籠）：伺服器出招、客戶端播動畫、重連重建都用這兩個，雙方的角色一模一樣 ----------

export function spawnBeast(match, spec) {
  const B = BEAST_BY_KIND[spec.kind];
  const C = CONFIG[B.cfg];
  const e = new Entity({
    ...CONFIG.ENEMY, id: spec.id, name: spec.name, team: 'enemies', controller: 'ai', slot: 0, facing: -1, kind: spec.kind,
    x: spec.x, y: spec.y, hw: C.hw, h: C.h, hp: spec.hp, weapons: [B.weapon],
  });
  match.entities.push(e);
  const S = prisonState(match);
  if (S) S.spawned.push({ type: 'beast', ...spec });
  return e;
}

// 囚籠：關住 prisonerId（走不動、跳不起來、不會被擊退，照樣可以開火：一出砲口就打在籠子上），玩家方打得到、敵人的攻擊穿過去，固定不動、不會輪到它、打破不算擊殺。
// 關的是被熊抱住的人 → 熊把他交出來（放開、退到旁邊；不然他開火會先打在熊身上，籠子打不破）
export function spawnCage(match, spec) {
  const S0 = prisonState(match);
  if (S0 && S0.hug && S0.hug.victimId === spec.prisonerId) releaseHug(match, 'cage');
  const e = new Entity({
    ...CONFIG.ENEMY, id: spec.id, name: '囚籠', team: 'enemies', controller: 'ai', slot: 0, kind: 'cage',
    x: spec.x, y: spec.y, hw: spec.hw, h: spec.h, hp: spec.hp, heldId: spec.prisonerId,
    fixed: true, noTurn: true, optional: true, allyPass: true, noKill: true,
  });
  match.entities.push(e);
  const S = prisonState(match);
  if (S) {
    S.spawned.push({ type: 'cage', ...spec });
    S.cage = { id: spec.id, prisonerId: spec.prisonerId, round: spec.round };
  }
  syncHolds(match);
  return e;
}

/**
 * 囚籠 / 熊抱跟被關住的人對齊：籠子被打破了、被關的人倒下了 → 籠子拿掉（被關的人倒下的話籠子跟著消失）；熊或被抱的人倒下了 → 放開（不退開）。
 * 被關住、被抱住的人走不動（Entity.held）；抱著人的熊也 held（不會被擊退離開他：他開火才會一直打在熊身上）、heldId = 抱著誰（AI 隊友先打熊救人）。
 * 伺服器在每一波結算完（地圖機制的 cascade）、客戶端在畫面每一步（update）與快照之後都叫，兩邊照同一個條件各自推（held 不在角色狀態裡同步）
 */
export function syncHolds(match) {
  const S = prisonState(match);
  if (!S) return;
  if (S.cage) {
    const cage = match.byId(S.cage.id);
    const prisoner = match.byId(S.cage.prisonerId);
    if (!cage || !cage.alive || !prisoner || !prisoner.alive) {
      if (cage && cage.alive) cage.die('open');
      S.cage = null;
    }
  }
  if (S.hug) {
    const bear = match.byId(S.hug.bearId), victim = match.byId(S.hug.victimId);
    if (!bear || !bear.alive || !victim || !victim.alive) S.hug = null;
  }
  for (const p of match.players) p.held = !!((S.cage && p.id === S.cage.prisonerId) || (S.hug && p.id === S.hug.victimId));
  for (const e of match.enemies) {
    if (!isBeast(e)) continue;
    const hugging = !!(S.hug && S.hug.bearId === e.id);
    e.held = hugging;
    e.heldId = hugging ? S.hug.victimId : null;
  }
}

/**
 * 放出來的猛獸倒下了 → 處刑官馬上跳下處刑台（2026-10-22 使用者：不等輪到他）：回到出生的地方、打得到了；
 * 三隻都倒下 → 坐在地上哭（cryTurns 個自己的回合，下一招 = 哭）；預定的下一招是鞭那隻猛獸的話作廢（輪到他時重抽，同以前）。
 * 血量已經到下一個門檻也照樣跳下來（接著馬上再跳上去打開下一間：同一個事件 / 回合結束的 syncRelease）。王倒下了就不動。
 * 兩邊照同一個條件各自推、可以重複呼叫、不抽亂數（客戶端的亂數跟伺服器不同步）：
 *   伺服器在打倒猛獸的那一下（地圖機制的 eventExtras：事件帶 descend，同一波後面的砲彈就打得到落地的他）、
 *   每一波結算完（cascade，保險：沒有事件就倒下的）與回合結束（turnEnd：猛獸在自己的回合結束被燒死）；
 *   客戶端照事件重播到那一下（replayPrison）、畫面每一步（保險，播出招動畫的時候除外，見 client/map-views/prison.js）。
 * 回傳 { x0, y0, x, y }（從哪裡跳到哪裡，畫面照它畫弧線、紀錄照它記；三隻都倒下再帶 cry: true），沒跳 = null
 */
export function syncPerch(match) {
  const S = prisonState(match);
  const boss = bossOf(match);
  if (!S || !S.up || !boss || !boss.alive || liveBeast(match)) return null;
  const x0 = boss.x, y0 = boss.y;
  placeBoss(match, boss, S.def.boss);
  setUp(match, false);
  boss.facing = -1;
  const cry = S.released >= BEASTS.length;
  if (cry) {
    S.mood = 'cry';
    S.cryLeft = CONFIG.EXECUTIONER.cryTurns;
    planExecNext(match);   // 哭的時候下一招就是哭（不抽亂數）
  } else if (S.next && S.next.action === 'whip') S.next = null;
  return { x0, y0, x: boss.x, y: boss.y, ...(cry ? { cry: true } : {}) };
}

// 處刑官身上的負面狀態（跳上處刑台之前先清掉，2026-10-28 使用者）：燃燒、流血、中毒、糾纏、被吊燈砸暈。回傳清掉了哪些（紀錄、畫面飄字用）
function cleanse(match, boss) {
  const S = prisonState(match);
  const cleared = [];
  if (boss.burn > 0) cleared.push('burn');
  if (boss.bleed > 0) cleared.push('bleed');
  if (boss.poison > 0) cleared.push('poison');
  if (boss.entangle > 0) cleared.push('entangle');
  Object.assign(boss, { burn: 0, burnFrac: 0, bleed: 0, bleedFrac: 0, poison: 0, entangle: 0 });
  const i = S.stuns.indexOf(boss.id);
  if (i >= 0) { S.stuns.splice(i, 1); cleared.push('stun'); }
  return cleared;
}

/**
 * 跳上處刑台、打開第 info.cell 間牢房（伺服器結算、客戶端重播都照這個，兩邊一模一樣）：先清掉負面狀態，再跳上去（已經在台上就不用跳），
 * 放出 info.spec 那隻猛獸（這一輪先不動：伺服器的 syncRelease 設 Entity.dormant，換輪時 Match.nextActor 叫醒；客戶端不會換輪，看 spec.round，見 sleeping）、
 * 血量的門檻換成下一個、猛獸的第一招 = info.plan（伺服器抽的；熊會抽亂數，客戶端照它）。
 * 回傳 { x0, y0, x, y, cleared, beast }（從哪裡跳到哪裡、清掉了哪些負面狀態、放出來的那隻）。已經放過了（重連的快照套過了）就不重複放
 */
export function applyRelease(match, info) {
  const S = prisonState(match);
  const boss = bossOf(match);
  if (!S || !boss || !info || !info.spec) return null;
  const cleared = cleanse(match, boss);
  const x0 = boss.x, y0 = boss.y;
  if (!S.up) { placeBoss(match, boss, S.def.perch); setUp(match, true); }
  boss.facing = -1;
  const beast = match.byId(info.spec.id) || spawnBeast(match, info.spec);
  S.released = Math.max(S.released, info.cell + 1);
  boss.hpFloor = floorHp(boss, S.released);
  if (info.plan) S.beastNext[beast.id] = { ...info.plan };
  return { x0, y0, x: boss.x, y: boss.y, cleared, beast };
}

/**
 * 血量到門檻了 → 不管是誰的回合，處刑官馬上跳上處刑台、放出下一隻猛獸（2026-10-28 使用者）。伺服器才叫（熊的第一招會抽亂數）：
 * 打到門檻的那一下（地圖機制的 eventExtras：事件帶 release，同一波後面的砲彈就打不到他了、打得到剛放出來的那隻）、
 * 回合結束（turnEnd：自己的回合結束被燒到門檻）；輪到他時還沒跳（照理不會發生）在他的回合補一招（不在 cascade 跳：客戶端看不到，見 mechanics/prison.js）。
 * 回傳 { cell, beast（種類）, x0, y0, x, y, spec（出生資料）, plan（第一招）, cleared? }（客戶端照 applyRelease 套、紀錄照它記），沒跳 = null
 */
export function syncRelease(match) {
  const S = prisonState(match);
  const boss = bossOf(match);
  if (!S || S.up || !boss || !boss.alive || !atThreshold(match)) return null;
  const k = S.released;
  const B = BEASTS[k];
  const cell = S.def.cells[k];
  const spec = { id: B.id, kind: B.kind, name: B.name, x: cell.x, y: S.def.ground, hp: Math.round(CONFIG[B.cfg].hp * S.hpScale), round: match.round };
  const r = applyRelease(match, { cell: k, spec });
  r.beast.dormant = true;   // 這一輪先不動（只有伺服器輪流出手）
  const plan = planBeast(match, r.beast);
  return { cell: k, beast: B.kind, x0: r.x0, y0: r.y0, x: r.x, y: r.y, spec, plan: plan ? { ...plan } : null, ...(r.cleared.length ? { cleared: r.cleared } : {}) };
}

/** 被關的人自己的攻擊（打在籠子上的爆炸）傷不到他自己（地圖機制的 absorbHit：回傳 true = 這一下不算他） */
export function shieldsPrisoner(e, attacker) {
  return !!e.held && attacker === e;
}

/** 還有幾輪可以救（這一輪也算）：關進去的那一輪、下一輪都是 cageRounds，之後每輪少 1；最後一輪輪到王時處刑。沒有囚籠 = null */
export function cageRoundsLeft(match) {
  const S = prisonState(match);
  if (!S || !S.cage) return null;
  const R = CONFIG.EXECUTIONER.cageRounds;
  return Math.max(0, Math.min(R, S.cage.round + R + 1 - Math.max(1, match.round)));
}

// 現在輪到王的話要不要處刑：囚籠撐過 cageRounds 輪了
function cageDue(match) {
  const S = prisonState(match);
  return !!(S && S.cage && Math.max(1, match.round) - S.cage.round >= CONFIG.EXECUTIONER.cageRounds);
}

// 被吊燈砸暈的角色：拿掉一次暈眩（輪到他時呼叫），回傳有沒有暈著
function consumeStun(S, id) {
  const i = S.stuns.indexOf(id);
  if (i < 0) return false;
  S.stuns.splice(i, 1);
  return true;
}

// ---------- 王的回合 ----------

// 隨機一個活著的玩家（match.rng）；沒有 = null
function randomPlayer(match) {
  const alive = match.players.filter(e => e.alive);
  return alive.length ? match.rng.pick(alive) : null;
}

/**
 * 菜刀這一招丟幾把（每把丟不同的人）：本來一把，每死一隻召喚獸多一把（2026-10-22 使用者）；最多活著的玩家數。
 * 死了幾隻 = 開過的牢房 − 還活著的那一隻。兩邊照同一份狀態算得出來（HUD 照它寫）
 */
export function cleaverCount(match) {
  const S = prisonState(match);
  const alive = match.players.filter(e => e.alive).length;
  const dead = S ? S.released - (liveBeast(match) ? 1 : 0) : 0;
  return Math.min(alive, 1 + Math.max(0, dead));
}

// 菜刀丟得到的、不用抽亂數就知道的那幾個（照出手的順序，最多 cleaverCount 個）：先打的人（罪人、被熊抱住的人，見 priorityPlayers），
// 再來預定的那幾個（plan.targetIds；還活著的、照順序）。兩邊照同一份狀態算得出來（HUD、劍齒虎的預告照它）
function knownCleaverTargets(match, plan) {
  const n = cleaverCount(match);
  const alive = match.players.filter(e => e.alive);
  const out = priorityPlayers(match).slice(0, n);
  for (const id of (plan && (plan.targetIds || (plan.targetId ? [plan.targetId] : []))) || []) {
    const e = alive.find(p => p.id === id);
    if (e && !out.includes(e) && out.length < n) out.push(e);
  }
  return out;
}

// 菜刀要丟誰（cleaverCount 個不同的人）：knownCleaverTargets，不夠的話（預定之後又死了召喚獸、預定的人倒下了）
// 從其他活著的人隨機補（match.rng，只有伺服器抽）。plan = null → 先打的人之外全部隨機（抽下一招的時候）
function cleaverTargets(match, plan) {
  const n = cleaverCount(match);
  const alive = match.players.filter(e => e.alive);
  const out = knownCleaverTargets(match, plan);
  while (out.length < n) {
    const rest = alive.filter(e => !out.includes(e));
    if (!rest.length) break;
    out.push(match.rng.pick(rest));
  }
  return out;
}

/** 畫面預告王預定的菜刀要丟誰：{ targets（知道的那幾個）, extra（丟的時候還要隨機補幾個） }（HUD、劍齒虎的預告） */
export function cleaverForecast(match) {
  const S = prisonState(match);
  const targets = knownCleaverTargets(match, S && S.next && S.next.action === 'cleaver' ? S.next : null);
  return { targets, extra: cleaverCount(match) - targets.length };
}

/** 只打一個人的招（囚籠、流星錘）要打誰：先打的人（罪人、被熊抱住的人），再來預定的那個人（還活著的話）；都沒有 = null（出招時隨機） */
export function singleTarget(match, plan) {
  const first = priorityPlayers(match)[0];
  if (first) return first;
  const id = plan && plan.targetId;
  return (id && match.players.find(e => e.id === id && e.alive)) || null;
}

// 照權重抽一招（菜刀 / 皮鞭 / 囚籠 / 流星錘；皮鞭要有活著的猛獸、囚籠要場上沒有）
function pickAction(match) {
  const S = prisonState(match);
  const W = S.mood === 'rage' ? CONFIG.EXECUTIONER.rageWeights : CONFIG.EXECUTIONER.weights;
  const opts = [['cleaver', W.cleaver], ['whip', liveBeast(match) ? W.whip : 0], ['cage', S.cage ? 0 : W.cage], ['flail', W.flail]];
  return weightedPick(match.rng, opts) || 'cleaver';
}

/**
 * 抽王的下一招（開場、每次出完招之後）：哭的時候 = 哭 / 暴怒；囚籠下一回合到期 = 處刑；
 * 不然照權重抽，要打人的（菜刀、囚籠、流星錘）先選好目標（targetId，玩家回合畫面上會標出來）：罪人先，其他隨機
 */
export function planExecNext(match) {
  const S = prisonState(match);
  if (!S) return null;
  const boss = bossOf(match);
  if (!boss || !boss.alive) return (S.next = null);
  if (S.mood === 'cry') return (S.next = { action: S.cryLeft > 0 ? 'cry' : 'rage' });
  if (S.cage && Math.max(1, match.round) + 1 - S.cage.round >= CONFIG.EXECUTIONER.cageRounds) {
    return (S.next = { action: 'execute', targetId: S.cage.prisonerId });
  }
  const action = pickAction(match);
  if (action === 'whip') {
    const b = liveBeast(match);
    return (S.next = { action, targetId: b.id });
  }
  if (action === 'cleaver') {   // 丟好幾個人：targetIds（照出手的順序），targetId = 第一個
    const ts = cleaverTargets(match, null);
    return (S.next = ts.length ? { action, targetId: ts[0].id, targetIds: ts.map(e => e.id) } : { action });
  }
  const t = singleTarget(match, null) || randomPlayer(match);
  return (S.next = t ? { action, targetId: t.id } : { action });
}

/**
 * 輪到王：暈著就什麼都不做；不然出這一回合的招（哭 / 暴怒 + 流星錘 / 處刑 / 預定的那一招），最後抽下一招。回傳 { steps: [招式…], next }（格式同 Boss）。
 * 跳上 / 跳下處刑台本來就不管是誰的回合馬上跳了（syncRelease / syncPerch）；輪到他時還在台上卻沒有猛獸、
 * 或血量到門檻還沒跳（照理都不會發生）才在這裡補一招跳下來 / 跳上去。
 * 罪人倒下了還沒換（照理回合結束就換了，見 pickSinner）也在這裡補挑：第一招帶 sinnerId（紀錄照它記）
 */
export function resolveExecTurn(match, boss) {
  const S = prisonState(match);
  const E = CONFIG.EXECUTIONER;
  const mark = pickSinner(match);
  const steps = [];
  if (consumeStun(S, boss.id)) {
    steps.push({ action: 'stunned', cast: E.cast.stunned, still: stillResult(match) });
  } else {
    const jump = syncPerch(match);
    if (jump) steps.push(descendStep(match, jump));
    if (!S.up && atThreshold(match)) steps.push(releaseStep(match, boss));
    if (match.players.some(e => e.alive)) steps.push(...actionSteps(match, boss));
  }
  if (mark && steps.length) steps[0].sinnerId = mark.id;
  planExecNext(match);
  const last = steps[steps.length - 1];
  const res = last && (last.shot || last.still);
  if (res) res.results = match.entities.map(e => e.toState());
  return { steps, next: S.next ? { ...S.next } : null, state: prisonSnapshot(match).prison };   // state：客戶端整回合播完照這一份對齊
}

// 這一回合的招：哭（不行動）/ 哭完了 → 暴怒站起來 + 流星錘 / 囚籠到期 → 處刑 / 預定的那一招（不能用了就重抽）
function actionSteps(match, boss) {
  const S = prisonState(match);
  const E = CONFIG.EXECUTIONER;
  if (S.mood === 'cry') {
    if (S.cryLeft > 0) {
      S.cryLeft--;
      return [{ action: 'cry', cast: E.cast.cry, still: stillResult(match) }];
    }
    S.mood = 'rage';
    const rage = { action: 'rage', cast: E.cast.rage, still: stillResult(match) };
    const t = singleTarget(match, null) || randomPlayer(match);
    return t ? [rage, throwStep(match, boss, [t], 'flail')] : [rage];
  }
  if (cageDue(match)) return [executeStep(match, boss)];
  const plan = S.next || {};
  let action = plan.action;
  if (action === 'whip' && !liveBeast(match)) action = null;
  if (action === 'cage' && S.cage) action = null;
  if (!['cleaver', 'whip', 'cage', 'flail'].includes(action)) action = pickAction(match);
  if (action === 'whip') return [whipStep(match, boss, liveBeast(match))];
  if (action === 'cleaver') {
    const ts = cleaverTargets(match, plan.action === 'cleaver' ? plan : null);
    return ts.length ? [throwStep(match, boss, ts, action)] : [{ action: 'idle', still: stillResult(match) }];
  }
  const target = singleTarget(match, plan.action === action ? plan : null) || randomPlayer(match);
  if (!target) return [{ action: 'idle', still: stillResult(match) }];
  if (action === 'cage') return [cageStep(match, boss, target)];
  return [throwStep(match, boss, [target], action)];
}

// 王站到 spot（處刑台上 / 出生的地方；spot.y = 那裡的地面，腳底放在站得住的高度，見 standY）
function placeBoss(match, boss, spot) {
  boss.x = spot.x;
  boss.y = standY(match, boss, spot.x, spot.y - 1) ?? spot.y - 1;
  boss.vx = 0;
  boss.vy = 0;
  boss.onGround = true;
}

// 他的回合補一招跳上處刑台、打開下一間牢房（syncRelease；照理血量一到門檻就跳了，見 resolveExecTurn）。
// x0 / y0 → x / y = 從哪裡跳到哪裡（畫面照它畫弧線）；spawns = 放出來的猛獸（客戶端照出生資料建）
function releaseStep(match, boss) {
  const { spec, plan, cleared, ...info } = syncRelease(match);
  return { action: 'release', ...info, ...(cleared ? { cleared } : {}), cast: CONFIG.EXECUTIONER.cast.release, spawns: [spec], still: stillResult(match) };
}

// 跳下處刑台這一招（syncPerch 已經跳下來了，jump = 它回傳的從哪裡跳到哪裡）
function descendStep(match, jump) {
  return { action: 'descend', ...jump, cast: CONFIG.EXECUTIONER.cast.descend, still: stillResult(match) };
}

// 出手的位置：面向那邊的手（肩膀的高度）
export function handOf(boss) {
  return { x: boss.x + boss.facing * (boss.hw + 4), y: boss.y - boss.h * 0.62 };
}

// 菜刀丟擲 / 流星錘：從手上直直丟向 targets 的每一個人（一人一把，其他人都不會擋到，一定打中他），
// 照順序每把間隔 cleaverGap 幀出手；面向第一個人。菜刀另外帶 targetIds（照出手的順序；紀錄照它記）
function throwStep(match, boss, targets, action) {
  const W = CONFIG.WEAPONS[action === 'flail' ? 'execFlail' : 'execCleaver'];
  const first = targets[0];
  if (first.x !== boss.x) boss.facing = first.x > boss.x ? 1 : -1;
  const o = handOf(boss);
  const projs = targets.map((target, k) => {
    const dx = target.cx - o.x, dy = target.cy - o.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const p = bossProjectile(boss, W, o.x, o.y, dx / d * W.speed, dy / d * W.speed);
    p.spawn = 1 + k * CONFIG.EXECUTIONER.cleaverGap;
    for (const e of match.entities) if (e !== target) p.ignore.add(e);
    p.stopAt = target;
    return p;
  });
  return {
    action, targetId: first.id, ...(action === 'cleaver' ? { targetIds: targets.map(e => e.id) } : {}),
    cast: CONFIG.EXECUTIONER.cast[action], shot: bossShot(match, boss, W, projs, boss.facing),
  };
}

// 訓獸者皮鞭：打自己的猛獸 whipDamage（打不死，最多剩 1 血），牠下一次攻擊 +whipPct%（不疊加：已經鞭過的再鞭一次也一樣）
function whipStep(match, boss, beast) {
  const S = prisonState(match);
  const before = beast.hp;
  beast.hp = Math.max(1, beast.hp - CONFIG.EXECUTIONER.whipDamage);
  S.whip = beast.id;
  return { action: 'whip', targetId: beast.id, dmg: before - beast.hp, cast: CONFIG.EXECUTIONER.cast.whip, still: stillResult(match) };
}

// 處刑者囚籠：把 target 關在他現在站的地方（籠子比他大一圈），血量 cageHpPerPlayer × 玩家人數（開場的人數，含倒下的；不吃王的倍率）。
// round = 第幾輪關進去的（撐過 cageRounds 輪還在就處刑）。他被熊抱著的話熊把他交出來（spawnCage）：freedId = 他（紀錄照它記）
function cageStep(match, boss, target) {
  const S = prisonState(match);
  const freed = !!(S.hug && S.hug.victimId === target.id);
  const n = ++S.seq;
  const spec = {
    id: `cage${n}`, x: target.x, y: target.y, hw: Math.round(target.hw + 9), h: Math.round(target.h + 14),
    hp: Math.round(CONFIG.EXECUTIONER.cageHpPerPlayer * match.players.length), prisonerId: target.id, round: Math.max(1, match.round),
  };
  spawnCage(match, spec);
  return {
    action: 'cage', targetId: target.id, ...(freed ? { freedId: target.id } : {}), cast: CONFIG.EXECUTIONER.cast.cage, spawns: [spec], still: stillResult(match),
  };
}

// 斷頭台處刑：鎖鏈把籠子裡的人拖到斷頭台（level.mechanic.guillotine），籠子打開，鍘刀從上面落下來（execBlade，一定砍中他）。
// 被關的人在結算之前就放到斷頭台下（客戶端播完拖過去的預兆，重播一開始就把他擺過去）。x0 / y0 = 從哪裡被拖過來
function executeStep(match, boss) {
  const S = prisonState(match);
  const cage = match.byId(S.cage.id);
  const p = match.byId(S.cage.prisonerId);
  const G = S.def.guillotine;
  const x0 = p.x, y0 = p.y;
  if (cage && cage.alive) cage.die('open');
  S.cage = null;
  syncHolds(match);
  p.x = G.x;
  p.y = standY(match, p, G.x, G.y) ?? G.y;
  p.vx = 0;
  p.vy = 0;
  p.onGround = true;
  p.moveDir = 0;
  const W = CONFIG.WEAPONS.execBlade;
  const blade = bossProjectile(boss, W, G.x, p.y - BLADE_DROP, 0, W.speed);
  for (const e of match.entities) if (e !== p) blade.ignore.add(e);
  blade.stopAt = p;
  return {
    action: 'execute', targetId: p.id, x0, y0, x: p.x, y: p.y, cast: CONFIG.EXECUTIONER.cast.execute,
    shot: bossShot(match, boss, W, [blade], boss.facing),
  };
}

/** 斷頭台的鍘刀從多高落下來（畫面畫斷頭台的高度用） */
export const bladeDrop = () => BLADE_DROP;

// ---------- 猛獸的回合 ----------

// 惡狼撕咬的目標：罪人；沒有罪人（照理不會）才咬有流血的人（層數最多的，一樣多時最近的），都沒有流血就最近的人
export function biteTarget(match, wolf) {
  const sinner = sinnerOf(match);
  if (sinner) return sinner;
  const alive = match.players.filter(e => e.alive);
  const bleeding = alive.filter(e => e.bleed > 0);
  const pool = bleeding.length ? bleeding : alive;
  let best = null, bestKey = null;
  for (const e of pool) {
    const d = Math.hypot(e.cx - wolf.cx, e.cy - wolf.cy);
    const key = [-e.bleed, d];
    if (!best || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = e; bestKey = key; }
  }
  return best;
}

// 血最少的人（一樣少時排前面的先）：沒有罪人時（照理不會）劍齒虎撲的人
export function lowestPlayer(match) {
  let best = null;
  for (const e of match.players) if (e.alive && (!best || e.hp < best.hp)) best = e;
  return best;
}

// 劍齒虎沒人流血時要撲誰：罪人（2026-10-28 使用者）；沒有罪人就預定的那個人，他也倒下了就改成現在血最少的人
export function pounceTarget(match, plan) {
  const sinner = sinnerOf(match);
  if (sinner) return sinner;
  const id = plan && plan.targetId;
  return (id && match.players.find(e => e.id === id && e.alive)) || lowestPlayer(match);
}

// 惡狼以外的猛獸（棕熊）要衝向誰：罪人；沒有罪人（照理不會）就最近的人
function beastTarget(match, e) {
  return sinnerOf(match) || nearestPlayerAt(match, e.cx, e.cy);
}

// 從 (x0, y0) 直直撲向 target 的中心、判定半徑 r：路上第一個碰到的玩家（照子彈前進的方式每 2px 看一次）；都沒碰到 = target
export function firstInPath(match, x0, y0, target, r) {
  const dx = target.cx - x0, dy = target.cy - y0;
  const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / 2));
  const alive = match.players.filter(e => e.alive);
  for (let k = 0; k <= n; k++) {
    const x = x0 + dx * k / n, y = y0 + dy * k / n;
    for (const e of alive) if (e.containsPoint(x, y, r)) return e;
  }
  return target;
}

/**
 * 抽猛獸的下一招（放出來時、每次出完招之後），寫進 beastNext（玩家回合畫面上標出來）。targetId = 現在的罪人（紀錄照它記；
 * 真的出手時照那時候的罪人）。熊抱著人 → 下一招就是重摔（輪到牠時還抱著的話）
 */
export function planBeast(match, e) {
  const S = prisonState(match);
  if (!S || !e || !e.alive) return null;
  const sinner = sinnerOf(match);
  const to = (t) => (t ? { targetId: t.id } : {});
  let plan;
  if (e.kind === 'wolf') plan = { action: 'bite', ...to(sinner) };
  else if (e.kind === 'bear') {
    if (S.hug && S.hug.bearId === e.id) plan = { action: 'slam', targetId: S.hug.victimId };
    else {
      const W = CONFIG.BEAR.weights;
      plan = { action: weightedPick(match.rng, [['swipe', W.swipe], ['hug', W.hug]]) || 'swipe', ...to(sinner) };
    }
  } else plan = { action: 'pounce', ...to(sinner || lowestPlayer(match)) };
  S.beastNext[e.id] = plan;
  return plan;
}

/**
 * 棕熊這一回合實際上要做什麼（兩邊照同一份狀態算：HUD 照它、伺服器照它出手）：還抱著人 → 重摔他；
 * 預定熊抱 → 抱罪人（罪人被關在囚籠裡抱不到 → 改成熊掌拍擊他）；其他 → 熊掌拍擊罪人（預定重摔、但人已經被救走了也是）。
 * 回傳 { action: 'slam' | 'hug' | 'swipe', target }，沒人可以打 = null
 */
export function bearMove(match, bear, plan) {
  const S = prisonState(match);
  if (S && S.hug && S.hug.bearId === bear.id) {
    const victim = huggedOf(match);
    if (victim) return { action: 'slam', target: victim };
  }
  const t = beastTarget(match, bear);
  if (!t) return null;
  return { action: plan && plan.action === 'hug' && !t.held ? 'hug' : 'swipe', target: t };
}

/**
 * 輪到猛獸：暈著就不動；不然出預定的那一招並直接結算好（劍齒虎一回合可能撲好幾個人 = 好幾招），再抽下一招。回傳 { steps: [招式…], next }。
 * 罪人倒下了還沒換（照理不會）先補挑：第一招帶 sinnerId
 */
export function resolveBeastTurn(match, e) {
  const S = prisonState(match);
  const C = CONFIG[BEAST_BY_KIND[e.kind].cfg];
  const mark = pickSinner(match);
  let steps;
  if (consumeStun(S, e.id)) steps = [{ action: 'stunned', cast: C.cast, still: stillResult(match) }];
  else {
    const plan = S.beastNext[e.id] || planBeast(match, e) || {};
    let step = null;
    if (e.kind === 'wolf') {
      const t = biteTarget(match, e);
      step = t ? lungeStep(match, e, t, 'wolfBite', 'bite') : null;
    } else if (e.kind === 'bear') {
      const mv = bearMove(match, e, plan);
      if (mv && mv.action === 'slam') step = slamStep(match, e, mv.target);
      else if (mv && mv.action === 'hug') step = hugStep(match, e, mv.target);
      else if (mv) step = lungeStep(match, e, mv.target, 'bearSwipe', 'swipe');
    }
    steps = e.kind === 'tiger' ? pounceSteps(match, e, plan) : step ? [step] : [];
    if (!steps.length) steps = [{ action: 'idle', still: stillResult(match) }];
    if (steps.some(st => st.shot) && S.whip === e.id) S.whip = null;   // 鞭出來的加成用在這一下了（劍齒虎撲好幾個人：只加在第一下；熊抱不打人，留給重摔）
  }
  if (mark) steps[0].sinnerId = mark.id;
  planBeast(match, e);
  const last = steps[steps.length - 1];
  const res = last.shot || last.still;
  res.results = match.entities.map(f => f.toState());
  return { steps, next: S.beastNext[e.id] ? { ...S.beastNext[e.id] } : null, state: prisonSnapshot(match).prison };
}

// 撲過去（撕咬 / 熊掌拍擊 / 飛撲）：飛行物就是猛獸自己（從身體中間出發、判定半徑 = 半寬），直直撲向 victim（其他人都不碰），
// 撞到就停在他旁邊（被擊退之前的位置、靠牠這一邊；被關在籠子裡的人就停在籠子外面；站不住的話照 standSpot 挪到旁邊站得住的地方）。x0 / y0 = 出發的位置
function lungeStep(match, e, victim, weaponId, action, weapon = CONFIG.WEAPONS[weaponId], extra = {}) {
  const dir = victim.x > e.x ? 1 : victim.x < e.x ? -1 : e.facing;
  e.facing = dir;
  const x0 = e.x, y0 = e.y;
  const ox = e.x, oy = e.cy;
  const dx = victim.cx - ox, dy = victim.cy - oy;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const p = bossProjectile(e, weapon, ox, oy, dx / d * weapon.speed, dy / d * weapon.speed);
  for (const f of match.entities) if (f !== victim) p.ignore.add(f);
  p.stopAt = victim;
  const shot = bossShot(match, e, weapon, [p], dir);
  const hit = shot.events.find(ev => ev.target === victim.id);
  const S = prisonState(match);
  const cage = S && S.cage && S.cage.prisonerId === victim.id ? match.byId(S.cage.id) : null;
  // 被關在籠子裡的人：停在籠子外面（不要站進籠子裡）
  const hx = cage && cage.alive ? cage.x - dir * (cage.hw + e.hw + 1) : hit ? hit.x : victim.x - dir * (victim.hw + e.hw);
  const spot = standSpot(match, e, hx, y0) || { x: x0, y: y0 };
  e.x = spot.x;
  e.y = spot.y;
  e.vx = 0;
  e.vy = 0;
  e.onGround = true;
  shot.results = match.entities.map(f => f.toState());   // 撲到之後的樣子（牠站到的位置）：客戶端撲完照這一份放（一回合撲好幾下時每一下都要對）
  const C = CONFIG[BEAST_BY_KIND[e.kind].cfg];
  return { action, targetId: victim.id, x0, y0, x: e.x, y: e.y, cast: C.cast, ...extra, shot };
}

/** 熊抱住人之後要被打多少才放開：牠最大血量的 hugBreakPct%（照血量倍率，人越多越多） */
export const hugNeed = (e) => Math.max(1, Math.round(e.maxHp * CONFIG.BEAR.hugBreakPct / 100));

// 熊抱：衝到 victim 身上抱住他（站在他身上：他開火一出砲口就打在熊身上，同被關在囚籠裡；走不動、跳不起來、不會被擊退），
// 熊也不會被擊退離開他（syncHolds）。被打到 need 就放開（hugExtras），輪到牠時還抱著就重摔（slamStep）。不打人，沒有飛行物：
// 畫面照 x0 / y0 → x / y 畫衝過去（facing = 面向他），抱住的狀態在預兆最後才套（同伺服器結算完的樣子）
function hugStep(match, bear, victim) {
  const S = prisonState(match);
  const x0 = bear.x, y0 = bear.y;
  if (victim.x !== bear.x) bear.facing = victim.x > bear.x ? 1 : -1;
  const spot = standSpot(match, bear, victim.x, victim.y) || { x: victim.x, y: victim.y };
  bear.x = spot.x;
  bear.y = spot.y;
  bear.vx = 0;
  bear.vy = 0;
  bear.onGround = true;
  S.hug = { bearId: bear.id, victimId: victim.id, need: hugNeed(bear), dmg: 0 };
  syncHolds(match);
  victim.vx = 0;
  victim.moveDir = 0;
  return { action: 'hug', targetId: victim.id, need: S.hug.need, x0, y0, x: bear.x, y: bear.y, facing: bear.facing, cast: CONFIG.BEAR.cast, still: stillResult(match) };
}

// 熊抱重摔：輪到熊時還抱著（沒被救出來）→ 先放開（被抱住的人不會被擊退，不先放開就甩不出去），再一把往熊面向的那邊斜斜往上甩出去
// （WEAPONS.bearSlam；飛行物從他身上出發，一定打中他）。熊站在原地
function slamStep(match, bear, victim) {
  const S = prisonState(match);
  S.hug = null;
  syncHolds(match);
  const W = CONFIG.WEAPONS.bearSlam;
  const f = bear.facing;
  const weapon = { ...W, knockDir: { x: f * 0.8, y: -0.6 } };
  const p = bossProjectile(bear, weapon, victim.cx - f * 2, victim.cy, f * W.speed, 0);
  for (const e of match.entities) if (e !== victim) p.ignore.add(e);
  p.stopAt = victim;
  const shot = bossShot(match, bear, weapon, [p], f);
  shot.results = match.entities.map(e => e.toState());
  return { action: 'slam', targetId: victim.id, cast: CONFIG.BEAR.cast, shot };
}

/** 劍齒虎這一回合要撲的人：所有有流血的活著的玩家（2026-10-22 使用者）；沒人流血 = 罪人（pounceTarget）。畫面的準星、HUD 照它 */
export function pounceTargets(match, plan) {
  const bleeding = match.players.filter(e => e.alive && e.bleed > 0);
  if (bleeding.length) return bleeding;
  const t = pounceTarget(match, plan);
  return t ? [t] : [];
}

// 剛放出來、這一輪還不動的猛獸（放出來那一輪：出生資料的 round 是現在這一輪）。兩邊都算得出來
// （Entity.dormant 只有伺服器換輪時會叫醒，客戶端不換輪，不能看它）
function sleeping(match, beast) {
  const S = prisonState(match);
  const spec = S && S.spawned.find(s => s.type === 'beast' && s.id === beast.id);
  return !!spec && Number.isFinite(spec.round) && spec.round === match.round;
}

/**
 * 畫面預告劍齒虎下一次會撲誰（準星、HUD）。一輪的順序固定是 玩家 → 處刑官 → 猛獸，流血在每個人自己的回合結束就止住、
 * 玩家身上的流血只會來自處刑官的菜刀：所以虎會撲的，是牠前面那一回合處刑官菜刀丟中的人，不是玩家回合裡正在流血的人。
 * execActed = 這一輪處刑官已經出完手了（或現在就是虎的回合）。回傳 { targets, extra, why }：
 *   why 'stunned'  虎被吊燈砸暈了，這一回合不撲（targets 空的）
 *   why 'bleeding' 處刑官出完手了（虎剛放出來、這一輪不動的除外）→ 照現在誰在流血（pounceTargets）
 *   why 'cleaver'  處刑官還沒出手、預定丟菜刀（沒被砸暈、沒在哭、囚籠沒到期）→ 菜刀要丟的人（罪人與預定的，見 cleaverForecast；extra = 丟的時候還要隨機補幾個）
 *   why 'marked'   其他 → 罪人（沒人會流血；pounceTarget）
 */
export function tigerForecast(match, execActed) {
  const S = prisonState(match);
  const tiger = match.byId('tiger');
  if (!S || !tiger || !tiger.alive) return { targets: [], extra: 0, why: null };
  if (S.stuns.includes(tiger.id)) return { targets: [], extra: 0, why: 'stunned' };
  const plan = S.beastNext[tiger.id];
  if (execActed && !sleeping(match, tiger)) {
    const ts = pounceTargets(match, plan);
    return { targets: ts, extra: 0, why: ts.some(e => e.bleed > 0) ? 'bleeding' : 'marked' };
  }
  const boss = bossOf(match);
  const nx = S.next;
  if (boss && boss.alive && nx && nx.action === 'cleaver' && !S.stuns.includes(boss.id) && S.mood !== 'cry' && !cageDue(match)) {
    return { ...cleaverForecast(match), why: 'cleaver' };
  }
  const t = pounceTarget(match, plan);
  return { targets: t ? [t] : [], extra: 0, why: 'marked' };
}

// 劍齒虎的回合：撲咬所有有流血的人（輪到牠那一刻有流血的；一個撲完再撲下一個，每次先撲離牠現在最近的），
// 直直撲過去、路上的人擋不到（大家都站在同一條地面上：撲完的人被擊退到下一個人前面，會一直擋到後面的人）；倒下了就跳過。
// 沒人流血就撲標記的人（只撲一個；路上第一個人先被撲到，隊友可以擋）。回傳每一撲一招
function pounceSteps(match, tiger, plan) {
  const S = prisonState(match);
  const left = pounceTargets(match, plan);
  const bleedingTurn = left.some(e => e.bleed > 0);
  const steps = [];
  while (left.length && tiger.alive) {
    let k = 0;
    for (let i = 1; i < left.length; i++) {
      const d = (e) => (e.cx - tiger.cx) * (e.cx - tiger.cx) + (e.cy - tiger.cy) * (e.cy - tiger.cy);
      if (d(left[i]) < d(left[k])) k = i;
    }
    const [target] = left.splice(k, 1);
    if (!target.alive) continue;
    steps.push(pounceStep(match, tiger, target, !bleedingTurn));
    if (S.whip === tiger.id) S.whip = null;   // 鞭出來的加成只加在第一撲
  }
  return steps;
}

// 飛撲：撲向 target（canBlock = 路上第一個玩家先被撲到，firstInPath；markedId = 本來要撲的人）。吃掉被撲到的人的流血層數，每層 +bleedBonus 傷害
function pounceStep(match, tiger, target, canBlock) {
  const W = CONFIG.WEAPONS.tigerPounce;
  const victim = canBlock ? firstInPath(match, tiger.x, tiger.cy, target, W.hitRadius) : target;
  const stacks = victim.bleed || 0;
  const weapon = stacks > 0 ? { ...W, damage: W.damage + stacks * CONFIG.TIGER.bleedBonus } : W;
  const step = lungeStep(match, tiger, victim, 'tigerPounce', 'pounce', weapon, {
    ...(victim !== target ? { markedId: target.id } : {}), ...(stacks > 0 ? { eaten: stacks } : {}),
  });
  const ev = step.shot.events.find(x => x.target === victim.id);
  const blocked = ev && ev.damages && ev.damages.some(dd => dd.id === victim.id && dd.blocked);
  if (stacks > 0 && victim.alive && !blocked) {   // 流血被吃掉了（無敵擋下這一下就沒吃到）
    victim.bleed = 0;
    step.shot.results = match.entities.map(f => f.toState());
  }
  return step;
}

// ---------- 吊燈（跟洞穴的鐘乳石同一套地形） ----------

/** 一顆飛行物撞到東西（地圖機制的 struck）：打到 / 炸到的吊燈掉下來（任何一方都會）。回傳 { falls, adds }，沒有 = null */
export function struckPrison(match, owner, at) {
  const S = prisonState(match);
  if (!S) return null;
  const T = match.terrain;
  const hitK = at.type === 'terrain' ? T.stalactiteAt(at.x, at.y) : -1;
  const falls = [], adds = [];
  for (let k = 0; k < T.stalactites.length; k++) {
    if (k !== hitK && !(at.blast > 0 && T.stalactiteInCircle(k, at.x, at.y, at.blast))) continue;
    if (!T.dropStalactite(k)) continue;
    S.fallen.push(k);
    falls.push(k);
    const tip = T.stalactites[k].tip;
    adds.push({ w: 'chandelier', k, x: tip.x, y: tip.y, vx: 0, vy: 0 });
  }
  return falls.length ? { falls, adds } : null;
}

/** 一個有傷害的事件（地圖機制的 eventExtras）：掉下來的吊燈砸到的敵人（真的扣到血的）暈眩一回合。回傳 { stuns }，沒有 = {} */
export function stunExtras(match, info) {
  const S = prisonState(match);
  if (!S || !info || info.weapon !== 'chandelier') return {};
  const stuns = [];
  for (const d of info.damages || []) {
    const e = match.byId(d.id);
    if (!e || e.team !== 'enemies' || e.noTurn || !(d.dmg > 0) || !e.alive) continue;
    if (!S.stuns.includes(e.id)) S.stuns.push(e.id);
    stuns.push(e.id);
  }
  return stuns.length ? { stuns } : {};
}

/** 一個有傷害的事件：處刑官被打中、扣到血了 → 他被打的次數 S.fury +1（武器傷害 +furyPct%，見 prisonAttackMult）。回傳 { fury: 打完之後的總次數 }，沒打到他 = {} */
function furyExtras(match, info) {
  const S = prisonState(match);
  const boss = bossOf(match);
  if (!S || !boss || !info) return {};
  const n = (info.damages || []).filter(d => d.id === boss.id && d.dmg > 0).length;
  if (!n) return {};
  S.fury = (S.fury || 0) + n;
  return { fury: S.fury };
}

/**
 * 一個有傷害的事件：熊抱著人的時候被打了多少（S.hug.dmg；被抱的人自己打的也算）→ 打到 need 就放開（退到旁邊）；
 * 熊、被抱的人倒下了也放開。回傳 { hugDmg?（打完之後的總數，客戶端直接照抄）, unhug?（releaseHug 的回傳） }，沒抱著 = {}
 */
function hugExtras(match, info) {
  const S = prisonState(match);
  if (!S || !S.hug || !info) return {};
  const out = {};
  const dmg = (info.damages || []).filter(d => d.id === S.hug.bearId && d.dmg > 0).reduce((s, d) => s + d.dmg, 0);
  if (dmg > 0) {
    S.hug.dmg += dmg;
    out.hugDmg = S.hug.dmg;
  }
  const bear = match.byId(S.hug.bearId), victim = match.byId(S.hug.victimId);
  if (!bear || !bear.alive || !victim || !victim.alive) out.unhug = releaseHug(match, 'dead');
  else if (S.hug.dmg >= S.hug.need) out.unhug = releaseHug(match, 'free');
  return out;
}

/**
 * 一個有傷害的事件（地圖機制的 eventExtras）：吊燈砸暈的（stunExtras；砸暈抱著人的熊 → 放開）、處刑官被打的次數（furyExtras）、
 * 熊被打了多少（hugExtras，打夠了放開）；
 * 這一下打倒了放出來的猛獸 → 處刑官馬上跳下處刑台（syncPerch；這一波後面的砲彈就打得到落地的他）；
 * 這一下把他打到門檻 → 馬上跳上處刑台放出下一隻（syncRelease；這一波後面的砲彈打不到他、打得到剛放出來的那隻）。
 * 回傳 { stuns?, fury?, hugDmg?, unhug?, descend?, release? }
 */
export function prisonEventExtras(match, info) {
  const S = prisonState(match);
  const out = { ...stunExtras(match, info), ...furyExtras(match, info) };
  const stunned = S && S.hug && out.stuns && out.stuns.includes(S.hug.bearId) ? releaseHug(match, 'stun') : null;
  Object.assign(out, hugExtras(match, info));
  if (stunned) out.unhug = stunned;
  const descend = syncPerch(match);
  if (descend) out.descend = descend;
  const release = syncRelease(match);
  if (release) out.release = release;
  return out;
}

/**
 * 客戶端照事件播（重播的 replayEvent）：伺服器在這一下掉下來的吊燈、砸暈的敵人、處刑官被打的次數（直接照伺服器的總數）、
 * 熊抱著人被打了多少（同上）、熊放開（同一個條件：退到旁邊）、
 * 跳下處刑台（這一下的角色狀態已經套過、猛獸倒下了）、跳上處刑台放出下一隻（照伺服器帶來的出生資料與第一招）。重連時快照已經套過的就跳過
 */
export function replayPrison(match, ev) {
  const S = prisonState(match);
  if (!S) return;
  for (const k of ev.falls || []) if (match.terrain.dropStalactite(k)) S.fallen.push(k);
  for (const id of ev.stuns || []) if (!S.stuns.includes(id)) S.stuns.push(id);
  if (Number.isFinite(ev.fury)) S.fury = ev.fury;
  if (Number.isFinite(ev.hugDmg) && S.hug) S.hug.dmg = ev.hugDmg;
  if (ev.unhug) releaseHug(match, ev.unhug.why);
  if (ev.descend) syncPerch(match);
  if (ev.release) applyRelease(match, ev.release);
}

// ---------- 快照 ----------

export function prisonSnapshot(match) {
  const S = match.mechState;
  const clone = (o) => (o ? { ...o } : null);
  return {
    prison: {
      released: S.released, up: S.up, mood: S.mood, cryLeft: S.cryLeft, next: clone(S.next),
      beastNext: Object.fromEntries(Object.entries(S.beastNext).map(([k, v]) => [k, clone(v)])),
      whip: S.whip, sinner: S.sinner, hug: clone(S.hug), stuns: S.stuns.slice(), cage: clone(S.cage),
      spawned: S.spawned.map(s => ({ ...s })), seq: S.seq, fallen: S.fallen.slice(), fury: S.fury || 0,
    },
  };
}

// 套用快照（地形之後、角色狀態之前）：先建出快照裡有、這邊還沒有的猛獸 / 囚籠，掉了的吊燈拿掉，再換成快照的狀態。
// 只帶一部分欄位（客戶端收到 turn / turnFx 時只帶 { items }）→ 不動
export function restorePrison(match, s) {
  const S = prisonState(match);
  const P = s && s.prison;
  if (!S || !P) return;
  for (const k of P.fallen || []) match.terrain.dropStalactite(k);
  for (const spec of P.spawned || []) {
    if (match.byId(spec.id)) continue;
    const { type, ...rest } = spec;
    if (type === 'cage') spawnCage(match, rest);
    else spawnBeast(match, rest);
  }
  Object.assign(S, {
    released: P.released, mood: P.mood, cryLeft: P.cryLeft, next: P.next ? { ...P.next } : null,
    beastNext: Object.fromEntries(Object.entries(P.beastNext || {}).map(([k, v]) => [k, v ? { ...v } : null])),
    whip: P.whip ?? null, sinner: P.sinner ?? null, hug: P.hug ? { ...P.hug } : null, stuns: (P.stuns || []).slice(), cage: P.cage ? { ...P.cage } : null,
    spawned: (P.spawned || []).map(x => ({ ...x })), seq: P.seq | 0, fallen: (P.fallen || []).slice(), fury: P.fury | 0,
  });
  setUp(match, P.up);
  syncHolds(match);
  const boss = bossOf(match);
  if (boss) boss.hpFloor = floorHp(boss, S.released);
}
