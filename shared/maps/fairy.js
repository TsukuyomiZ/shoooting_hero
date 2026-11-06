import { CONFIG } from '../core/config.js';
import { Entity } from '../physics/entities.js';
import { planShotAt, preferredWeapon } from '../ai/ai.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// 菁英關「調皮妖精」（森林）的妖精與分身（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。2026-11-03 使用者定的規則（數值見 config.FAIRY）。
// Match 什麼時候呼叫這些，見地圖機制 shared/maps/mechanics/fairy.js。這一場的狀態 match.mechState =
//   { def, whisper, lastWhisper, angry, revealed, charm, burnHold, fx }：
//   whisper     = 現在被咬耳朵的玩家（只有他的畫面看得到本尊；null = 沒有人：單人、她生氣了）；lastWhisper = 上一次咬耳朵的人（不連續同一人）
//   angry       = 血量掉到 FAIRY.angryPct 以下生氣了（不再咬耳朵，之後一直是 true）
//   revealed    = 本尊這一輪被打到過：分身都消失了、大家都看得到本尊（下次閃現就重來）
//   charm       = 被魅惑的玩家 { [playerId]: { armed（他自己的回合結束過了：下一個回合才接手）, used（這回合已經被接手了：回合結束就解除）} }
//   burnHold    = 本尊的燃燒先在閃現之前結算過了，層數先收著（回合結束的燃燒結算才不會再燒一次），她的回合結束再放回去（伺服器）
//   fx          = 這一下（一個飛行事件）剛發生、還沒附到事件上的：{ vanish（消失的分身）, blasts（爆炸的分身 { id, x, y, by, charm? }）, angry（剛生氣）, revealed（本尊剛現形）}
//                 （伺服器；eventExtras 拿走）
//
// - 妖精飄在空中（level.mechanic.fairy 的大小；不受重力、不會被擊退、不走動：fixed）。血量 FAIRY.hp，跟一般敵人一樣依人數、關數放大。打倒本尊 = 過關。
// - 分身（角色 kind 'fairyClone'，固定兩個：FAIRY_CLONE_IDS）：1 滴血、敵方的東西（她自己的攻擊穿過去）、不會輪到、不擋過關、打破不算擊殺、AI 不打（decoy）。
//   每次閃現都重新出現（倒下的復活回 1 滴血）
// - 閃現（blink）：每回合出完招之後（開場也一次），本尊和分身各飄到 roam 裡隨機的一點（彼此至少隔 blinkGap、離活著的玩家至少 playerGap），
//   哪一個是本尊也隨機。本尊的燃燒在閃現之前、舊的位置先結算（回合結束的燃燒飄字會洩漏本尊的新位置）；流血、糾纏在閃現時清掉
//   （她不會動，流血本來就扣不到；不然回合結束的「止血」「糾纏解除」也會飄在本尊身上）。
//   多人（開場超過 1 人）而且她還沒生氣：隨機挑一名活著的玩家咬耳朵（不連續同一人，只剩他一個就還是他）
// - 玩家（含效果的攻擊）打到分身：分身扣 1 倒下、在分身的位置爆炸（WEAPONS.fairyBlast，炸範圍內的玩家，含開槍的人；照爆炸距離遞減）。
//   多人的話開槍的人被魅惑（charm）：他的下一個回合由遊戲接手（takeover / aiShot），用他當下的武器打隨機一名活著的隊友，
//   FAIRY.charmHit 的機率瞄準他、其他的瞄在他旁邊打偏；沒有活著的隊友就不開火。開完（或沒開）這回合結束就解除（turnFx 帶 charmEnd）。
//   「下一個回合」= 他自己的回合結束過之後的那一回合（armed）：回合開始的無差別轟炸、飛鏢射到一半斷線打破的，都留到下一回合
//   分身爆炸、被爆炸炸到的傷害不算開槍的人造成的（傷害清單的 noCredit：結算統計、吸血、命中都不算）；爆炸的攻擊者是那個分身（看距離的效果，例如威嚇，量到分身）
// - 同一下（同一個爆炸 / 直擊）打到本尊又打到分身：只算本尊（分身直接消失、不爆炸、不魅惑）。
//   本尊被打到：分身全部消失（revealed），到她下次閃現前大家都看得到本尊。血量掉到 angryPct 以下：生氣，咬耳朵取消、之後不再咬
// - 她的招式（輪到她時抽，FAIRY.weights）：星屑彈 star（從本尊直直射向隨機一名玩家，穿過地形）／調包 swap（隨機兩名活著的玩家互換位置，
//   各受 WEAPONS.fairySwap 的傷害；只有一個人活著就改成星屑彈）。出完招再閃現
// - 傷害照開場人數（fairyDamage：武器的 damage × 開場玩家數，含之後倒下的），再吃一般的敵人傷害倍率

export const FAIRY_ID = 'fairy';
export const FAIRY_CLONE_IDS = ['fairyClone1', 'fairyClone2'];

export const FAIRY_ACTION_NAMES = {
  star: '星屑彈',
  swap: '調包',
  blink: '閃現',
  idle: '發呆',
};

// 這一場的狀態（match.mechState）。別張地圖當作沒有妖精
const fairyState = (match) => (match.mechState && match.mechState.def && match.mechState.def.type === 'fairy' ? match.mechState : null);

export const isClone = (e) => !!e && e.kind === 'fairyClone';
export const fairyOf = (match) => match.byId(FAIRY_ID);
export const clonesOf = (match) => FAIRY_CLONE_IDS.map(id => match.byId(id)).filter(Boolean);
// 多人模式（開場超過 1 人）：才有咬耳朵、魅惑
export const isMulti = (match) => match.players.length > 1;

// 建立妖精與兩個分身（都先站在 def.start；ready 再閃現一次），回傳這一場的狀態。hpScale = 一般敵人的血量倍率（人數 × 關數）
export function buildFairy(match, hpScale) {
  const def = match.level.mechanic;
  const f = def.fairy;
  const look = { ...CONFIG.ENEMY, name: '調皮妖精', team: 'enemies', controller: 'ai', slot: 0, facing: -1, x: def.start.x, y: def.start.y, hw: f.hw, h: f.h, fixed: true };
  match.entities.push(new Entity({ ...look, id: FAIRY_ID, hp: Math.round(CONFIG.FAIRY.hp * hpScale), part: 'fairy', kind: 'fairy', weapons: ['fairyStar'] }));
  for (const id of FAIRY_CLONE_IDS) {
    match.entities.push(new Entity({ ...look, id, hp: 1, kind: 'fairyClone', noTurn: true, optional: true, allyPass: true, noKill: true, decoy: true }));
  }
  return { def, whisper: null, lastWhisper: null, angry: false, revealed: false, charm: {}, burnHold: 0, fx: freshFx() };
}

const freshFx = () => ({ vanish: [], blasts: [], angry: false, revealed: false });

// 傷害照開場人數：武器的 damage（每人多少）× 開場的玩家數（含之後倒下的，同大樹遊俠）
export function fairyDamage(match, weapon) {
  return weapon.damage * Math.max(1, match.players.length);
}

// ---------- 閃現 ----------

// 三個落點（腳底，整數）：roam 裡隨機（match.rng），彼此至少隔 blinkGap、離活著的玩家（身體中心）至少 playerGap；
// 試 80 次排不下就不管玩家再試，還不行就平均排在 roam 的中線上
function blinkSpots(match, n) {
  const S = fairyState(match);
  const F = CONFIG.FAIRY;
  const r = S.def.roam;
  const h = S.def.fairy.h;
  const far = (pts, x, y, gap) => pts.every(p => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) >= gap * gap);
  const players = match.players.filter(e => e.alive);
  for (const avoidPlayers of [true, false]) {
    const pts = [];
    for (let tries = 0; tries < 80 && pts.length < n; tries++) {
      const x = Math.round(match.rng.range(r.x0, r.x1));
      const y = Math.round(match.rng.range(r.y0, r.y1));
      if (!far(pts, x, y, F.blinkGap)) continue;
      if (avoidPlayers && !players.every(p => (p.cx - x) * (p.cx - x) + (p.cy - (y - h / 2)) * (p.cy - (y - h / 2)) >= F.playerGap * F.playerGap)) continue;
      pts.push({ x, y });
    }
    if (pts.length === n) return pts;
  }
  return Array.from({ length: n }, (_, k) => ({ x: Math.round(r.x0 + (r.x1 - r.x0) * (k + 0.5) / n), y: Math.round((r.y0 + r.y1) / 2) }));
}

// 這次閃現要咬誰的耳朵：多人、還沒生氣才有；活著的玩家裡隨機，不連續同一人（只剩他一個就還是他）。沒有 = null
function pickWhisper(match) {
  const S = fairyState(match);
  if (!isMulti(match) || S.angry) return null;
  const alive = match.players.filter(e => e.alive);
  const pool = alive.length > 1 ? alive.filter(e => e.id !== S.lastWhisper) : alive;
  return pool.length ? match.rng.pick(pool).id : null;
}

/**
 * 閃現（開場、她每回合出完招之後）：本尊和分身各飄到一個新的落點（哪個是本尊隨機），分身復活回 1 滴血，各自轉向最近的玩家；
 * 重抽咬耳朵的人、分身重新出現（revealed 清掉）。回傳招式步驟 { action: 'blink', spots: [{ id, x, y, facing }]（本尊在哪一個也在裡面）, whisper, still }
 */
export function blinkStep(match) {
  const S = fairyState(match);
  const g = fairyOf(match);
  const ents = [g, ...clonesOf(match)].filter(Boolean);
  const pts = blinkSpots(match, ents.length);
  const order = ents.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = match.rng.int(0, i); [order[i], order[j]] = [order[j], order[i]]; }
  const spots = [];
  ents.forEach((e, k) => {
    const p = pts[order[k]];
    if (isClone(e) && g && g.alive) reviveClone(e);
    if (e.id === FAIRY_ID) { e.bleed = 0; e.bleedFrac = 0; e.entangle = 0; }   // 回合結束的「止血」「糾纏解除」才不會飄在本尊的新位置
    e.x = p.x;
    e.y = p.y;
    e.vx = 0;
    e.vy = 0;
    const near = nearestPlayerAt(match, e.cx, e.cy);
    if (near && near.x !== e.x) e.facing = near.x > e.x ? 1 : -1;
    spots.push({ id: e.id, x: e.x, y: e.y, facing: e.facing });
  });
  S.whisper = pickWhisper(match);
  if (S.whisper) S.lastWhisper = S.whisper;
  S.revealed = false;
  S.fx = freshFx();
  return { action: 'blink', spots, whisper: S.whisper, cast: CONFIG.FAIRY.cast.blink, still: stillResult(match) };
}

// 分身回到 1 滴血（倒下的復活）
function reviveClone(e) {
  e.alive = true;
  e.hp = 1;
  e.maxHp = 1;
  e.deathCause = null;
  e.deathTimer = 0;
  e.burn = 0;
}

// ---------- 她的回合 ----------

// 輪到妖精：抽一招出（星屑彈 / 調包），結算好之後閃現。回傳 { steps: [招式, 閃現], next: null }（格式同 Boss；她不預告下一招）
export function resolveFairyTurn(match, g) {
  const steps = [];
  if (g.alive && match.players.some(e => e.alive)) {
    const F = CONFIG.FAIRY;
    const alive = match.players.filter(e => e.alive);
    let action = weightedPick(match.rng, [['star', F.weights.star], ['swap', alive.length >= 2 ? F.weights.swap : 0]]) || 'star';
    const main = action === 'swap' ? swapStep(match, g) : starStep(match, g);
    steps.push(main);
    // 先校正成這一招的結果（跟客戶端播完這一招、套上 results 一樣），閃現的重播才從同一個狀態開始
    const res = main.shot || main.still;
    if (res) match.applyEntities(res.results);
    const burn = burnBeforeBlink(match, g);
    if (g.alive && match.players.some(e => e.alive)) steps.push({ ...blinkStep(match), ...(burn ? { burn } : {}) });
    else if (burn) steps.push({ action: 'idle', burn, still: stillResult(match) });
  }
  if (!steps.length) steps.push({ action: 'idle', still: stillResult(match) });
  const last = steps[steps.length - 1];
  const res = last.shot || last.still;
  if (res) res.results = match.entities.map(e => e.toState());
  return { steps, next: null };
}

// 本尊的燃燒在閃現之前、舊的位置先結算（Match.burnTick；燒死就不閃現），剩下的層數收進 burnHold（回合結束的燃燒結算看到 0，turnEnd 再放回去）。
// 回傳 { dmg, shaken }（畫面在舊的位置飄字）；沒在燒 = null。燒死的擊殺效果照 burnTick 算（飄字的 fx 不另外送）
function burnBeforeBlink(match, g) {
  const S = fairyState(match);
  if (!g.alive || !(g.burn > 0)) return null;
  const fx = [];
  match.burnTick(g, fx);
  const b = fx.find(f => f.type === 'burn' && f.id === g.id);
  S.burnHold = g.burn;
  g.burn = 0;
  return b ? { dmg: b.dmg, shaken: b.shaken } : null;
}

// 星屑彈：從本尊身體的中間直直射向隨機一名活著的玩家（穿過地形，一定飛得到他；路上擋著的隊友先中）
function starStep(match, g) {
  const alive = match.players.filter(e => e.alive);
  const target = alive.length ? match.rng.pick(alive) : null;
  if (!target) return { action: 'idle', still: stillResult(match) };
  if (target.x !== g.x) g.facing = target.x > g.x ? 1 : -1;
  const W = { ...CONFIG.WEAPONS.fairyStar, damage: fairyDamage(match, CONFIG.WEAPONS.fairyStar) };
  const dx = target.cx - g.cx, dy = target.cy - g.cy;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const p = bossProjectile(g, W, g.cx + g.facing * (g.hw + 2), g.cy, dx / len * W.speed, dy / len * W.speed);
  p.ignore.add(g);
  return { action: 'star', targetId: target.id, dmg: W.damage, facing: g.facing, cast: CONFIG.FAIRY.cast.star, shot: bossShot(match, g, W, [p], g.facing) };
}

// 調包：隨機兩名活著的玩家互換位置（抓著藤蔓的放手、速度歸零），各受 WEAPONS.fairySwap 的傷害（直接打在身上，不爆炸），再讓大家落地。
// ids = 換了誰、from = 兩人原本的位置（畫面照它畫兩邊的閃光）、damages = 兩人各扣多少（畫面飄字）
function swapStep(match, g) {
  const alive = match.players.filter(e => e.alive);
  const a = match.rng.pick(alive);
  const b = match.rng.pick(alive.filter(e => e !== a));
  const from = [[a.x, a.y], [b.x, b.y]];
  [a.x, a.y, b.x, b.y] = [b.x, b.y, a.x, a.y];
  for (const e of [a, b]) {
    e.vx = 0;
    e.vy = 0;
    e.onVine = -1;
    e.onGround = false;
  }
  const W = { ...CONFIG.WEAPONS.fairySwap, damage: fairyDamage(match, CONFIG.WEAPONS.fairySwap) };
  const damages = [];
  for (const e of [a, b]) if (e.alive) damages.push(...match.applyExplosion(e.x, e.cy, W, g, e, { directOnly: true }));
  return {
    action: 'swap', ids: [a.id, b.id], from, dmg: W.damage, damages: damages.map(d => ({ id: d.id, dmg: d.dmg, ...(d.blocked ? { blocked: true } : {}) })),
    facing: g.facing, cast: CONFIG.FAIRY.cast.swap, still: stillResult(match),
  };
}

// ---------- 被打到 ----------

// 同一下（一次 applyExplosion）裡碰到了什麼：key = 那一次的 later 陣列（每一下一份）
const blastOf = new WeakMap();
const infoOf = (later) => {
  let info = blastOf.get(later);
  if (!info) { info = { real: false }; blastOf.set(later, info); }
  return info;
};

/**
 * 爆炸 / 命中的第一步（地圖機制的 absorbHit，hit = { attacker, friendly, damages, later }）：
 * 本尊被玩家碰到 → 記下來（這一下打到的分身都只是消失），大家扣完血之後分身全部消失；本尊照一般的扣血（回傳 false）。
 * 分身：玩家方的攻擊扣 1 倒下、爆炸、魅惑開槍的人（大家扣完血之後，later）；她自己的攻擊碰不到。回傳 true = 這是分身（由這裡處理）
 */
export function hitFairy(match, e, { attacker, friendly, damages, later }) {
  const S = fairyState(match);
  if (!S) return false;
  const byPlayer = !!attacker && !friendly && attacker.team === 'players';
  if (e.id === FAIRY_ID) {
    if (byPlayer) {
      const info = infoOf(later);
      if (!info.real) later.push(() => reveal(match));
      info.real = true;
    }
    return false;
  }
  if (!isClone(e)) return false;
  if (!byPlayer) return true;
  const info = infoOf(later);
  const entry = { id: e.id, dmg: 0, friendly: false, noCredit: true };
  damages.push(entry);
  later.push(() => {
    if (info.real || !e.alive) return;   // 同一下打到了本尊：分身已經跟著消失了
    entry.dmg = e.takeDamage(e.hp);
    popClone(match, e, attacker, damages);
  });
  return true;
}

// 本尊被打到：分身全部消失（revealed），記進 fx.vanish（eventExtras 附在事件上給客戶端）
function reveal(match) {
  const S = fairyState(match);
  if (!S.revealed) S.fx.revealed = true;
  S.revealed = true;
  for (const c of clonesOf(match)) {
    if (!c.alive) continue;
    c.die('vanish');
    S.fx.vanish.push(c.id);
  }
}

// 分身被打破：在它的位置炸開（WEAPONS.fairyBlast × 開場人數，出手的算這個分身；只炸玩家），炸到的傷害接在這一下的傷害清單後面（noCredit：不算開槍的人的）。
// 多人的話開槍的人被魅惑（他還活著的話）
function popClone(match, c, attacker, damages) {
  const S = fairyState(match);
  const W = { ...CONFIG.WEAPONS.fairyBlast, damage: fairyDamage(match, CONFIG.WEAPONS.fairyBlast) };
  const exclude = new Set(match.entities.filter(f => f.team !== 'players'));
  const hurt = match.applyExplosion(c.cx, c.cy, W, c, null, { exclude });
  for (const d of hurt) damages.push({ ...d, noCredit: true });
  const charm = isMulti(match) && attacker.isPlayer && attacker.alive;
  if (charm) S.charm[attacker.id] = { armed: false, used: false };
  S.fx.blasts.push({ id: c.id, x: r1(c.cx), y: r1(c.cy), by: attacker.id, ...(charm ? { charm: attacker.id } : {}) });
}

// 本尊真的扣到血：掉到 angryPct 以下就生氣（咬耳朵取消、之後不再咬）
export function hurtFairy(match, e) {
  const S = fairyState(match);
  if (!S || e.id !== FAIRY_ID) return;
  if (!S.angry && e.hp < e.maxHp * CONFIG.FAIRY.angryPct) {
    S.angry = true;
    S.whisper = null;
    S.fx.angry = true;
  }
}

// 一個飛行事件的傷害結算完（eventExtras）：剛發生的分身消失 / 爆炸 / 魅惑 / 生氣 / 現形附在事件上 → { fairy: { vanish?, blasts?, angry?, revealed? } }；沒有 = {}
export function takeFx(match) {
  const S = fairyState(match);
  if (!S) return {};
  const { vanish, blasts, angry, revealed } = S.fx;
  S.fx = freshFx();
  if (!vanish.length && !blasts.length && !angry && !revealed) return {};
  return { fairy: { ...(vanish.length ? { vanish } : {}), ...(blasts.length ? { blasts } : {}), ...(angry ? { angry: true } : {}), ...(revealed ? { revealed: true } : {}) } };
}

/** 客戶端重播一個事件（replayEvent）：照伺服器附的分身消失、魅惑、生氣套到自己的狀態（分身打破的那一個照事件的角色狀態倒下） */
export function applyFairyFx(match, fx) {
  const S = fairyState(match);
  if (!S || !fx) return;
  for (const id of fx.vanish || []) {
    const c = match.byId(id);
    if (c && c.alive) c.die('vanish');
  }
  if (fx.revealed || (fx.vanish && fx.vanish.length)) S.revealed = true;
  for (const b of fx.blasts || []) if (b.charm) S.charm[b.charm] = { armed: false, used: false };
  if (fx.angry) { S.angry = true; S.whisper = null; }
}

/**
 * 一波結算完、勝負判定前（cascade，可以重複呼叫）：本尊倒下 → 分身一起消失；被魅惑的人倒下 → 解除
 */
export function syncFairy(match) {
  const S = fairyState(match);
  if (!S) return;
  const g = fairyOf(match);
  if (!g || !g.alive) for (const c of clonesOf(match)) if (c.alive) c.die('vanish');
  for (const pid of Object.keys(S.charm)) {
    const p = match.byId(pid);
    if (!p || !p.alive) delete S.charm[pid];
  }
}

// ---------- 魅惑：遊戲接手被魅惑的人的回合 ----------

// 玩家 e 的回合要不要由遊戲接手（地圖機制的 takeover，裁判在回合開始時問）：被魅惑了 → { reason: 'charm', label }，不然 null
export function charmTakeover(match, e) {
  const S = fairyState(match);
  const rec = S && e && e.alive ? S.charm[e.id] : null;
  if (!rec || !rec.armed) return null;
  return { reason: 'charm', label: '被魅惑了' };
}

/**
 * 被魅惑的人這一發（地圖機制的 aiShot，Match.planAiTurn 呼叫）：用他當下的武器打隨機一名活著的隊友，charmHit 的機率瞄準、其他的打偏。
 * 用掉了（used：這回合結束就解除）。回傳 { plan（null = 沒有活著的隊友，不開火）, info: { charm: true, targetId?, aimed? } }；
 * 沒被魅惑（或還沒 armed）→ 代打的玩家照 pickFairyShot（不知道本尊就在三個裡隨機挑），其他 null
 */
export function charmShot(match, actor) {
  const S = fairyState(match);
  const rec = S && S.charm[actor.id];
  if (!rec || !rec.armed) return pickFairyShot(match, actor);
  rec.used = true;
  const mates = match.players.filter(e => e.alive && e !== actor && e.team === actor.team);
  if (!mates.length) return { plan: null, info: { charm: true } };
  const target = match.rng.pick(mates);
  const aimed = match.rng.chance(CONFIG.FAIRY.charmHit);
  const plan = planShotAt(match.world, actor, match.rng, target, actor.weapon, { hit: aimed, miss: CONFIG.FAIRY.missOffset });
  return { plan, info: { charm: true, targetId: target.id, aimed } };
}

/**
 * 代打的玩家（斷線、電腦玩家）沒被魅惑時的這一發：他不知道哪個是本尊（不是被咬耳朵的人、本尊也還沒現形）就在活著的三個裡隨機挑一個打
 * （照一般 AI 的武器偏好與誤差；AI 只瞄本尊的話，大家看瞄準就知道哪個是真的）。他知道、或分身都不在了就照一般 AI（null）
 */
function pickFairyShot(match, actor) {
  const S = fairyState(match);
  if (!S || !actor.isPlayer || S.revealed || S.whisper === actor.id) return null;
  const pool = [fairyOf(match), ...clonesOf(match)].filter(e => e && e.alive);
  if (pool.length < 2) return null;
  const weapon = preferredWeapon(actor);
  if (!weapon) return null;
  const plan = planShotAt(match.world, actor, match.rng, match.rng.pick(pool), weapon, { error: true });
  return plan ? { plan, info: null } : null;
}

// 每個角色的回合結束（turnEnd，fx = 回合結束的效果）：被魅惑、這回合已經被接手過的人解除（推 charmEnd 給客戶端：畫面收掉愛心）；
// 這回合（或回合開始之前）才被魅惑的人 armed（下一個回合接手）。本尊：閃現前先結算過的燃燒層數放回去
export function endCharm(match, e, fx = []) {
  const S = fairyState(match);
  if (!S || !e) return;
  if (e.id === FAIRY_ID && S.burnHold > 0) {
    if (e.alive) e.burn = S.burnHold;
    S.burnHold = 0;
  }
  const rec = S.charm[e.id];
  if (!rec) return;
  if (rec.used) {
    delete S.charm[e.id];
    fx.push({ type: 'charmEnd', id: e.id });
  } else rec.armed = true;
}

// ---------- 快照 ----------

// 咬耳朵的人、生氣了沒、本尊現形了沒、被魅惑的人（包在 fairy 一個欄位裡；burnHold 只在她自己的回合裡有值，不帶）
export function fairySnapshot(match) {
  const S = match.mechState;
  const charm = {};
  for (const [pid, r] of Object.entries(S.charm)) charm[pid] = { armed: !!r.armed, used: !!r.used };
  return { fairy: { whisper: S.whisper, lastWhisper: S.lastWhisper, angry: S.angry, revealed: S.revealed, charm } };
}

// 套用快照（地形之後、角色狀態之前）。只帶一部分欄位（{ items }）→ 不動
export function restoreFairy(match, s) {
  const S = fairyState(match);
  const P = s && s.fairy;
  if (!S || !P) return;
  const charm = {};
  for (const [pid, r] of Object.entries(P.charm || {})) charm[pid] = { armed: !!(r && r.armed), used: !!(r && r.used) };
  Object.assign(S, {
    whisper: typeof P.whisper === 'string' ? P.whisper : null,
    lastWhisper: typeof P.lastWhisper === 'string' ? P.lastWhisper : null,
    angry: !!P.angry, revealed: !!P.revealed, charm,
  });
}

const r1 = (v) => Math.round(v * 10) / 10;
