import { CONFIG } from './config.js';
import { Entity } from './entities.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// Boss 關「古樹之庭」的規則（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/mechanics/tree.js。
//
// - 古樹本身是地圖右邊不可破壞的樹皮地形，身上只有兩個打得到的部位（固定不動的角色）：
//     古樹之眼：本體，輪到古樹時由它出招。打倒 = 古樹倒下，嘴巴與樹妖一起枯萎 → 過關
//     古樹之口：不會輪到它、打不壞。被攻擊到（直擊或爆炸波及）就閉上，閉著的時候古樹不能召喚；
//              撐過幾個古樹回合才張開（見 hitMouth / reopenMouth）：
//              單人 mouthClosedTurnsSolo（2：下一輪也還閉著），多人 mouthClosedTurnsMulti（1：只擋下一個古樹回合）
// - 古樹的下一招是事先決定好的（match.tree.next = { action, plane? }，見 planTreeNext）：
//     開場（大家落地後）先決定一次，之後每次古樹回合用掉這一招，回合結束（擊退落地後）再決定下一招。
//     依 TREE_BOSS.weights 抽：古樹撞擊 / 飛散落葉 / 閉目養神（決定的當下眼睛受過傷才抽得到）/ 發呆
//     古樹撞擊在決定的當下就選好平面（站最多玩家的那個），客戶端在玩家回合就把那條橫掃範圍畫成紅色警示帶，
//       玩家可以趁自己的回合離開；出招時不管人在哪，一定掃那個平面。飛散落葉不預告，出招時才挑最近的玩家
// - 古樹的回合：
//     嘴巴還張著、場上樹妖沒滿 → 一定是「士兵召喚」（最優先、不在預定裡，出招當下才看嘴巴），
//       一次召喚「玩家人數 × summonPerPlayer」隻（不超過上限）。單人：預定的招式留著，等下一個不召喚的古樹回合再出；
//       多人：預定的是撞擊 / 落葉就接在召喚後面一起出（attackOnSummonMulti），是閉目養神 / 發呆就留著
//     否則就出預定的那一招
// - 剛召喚的樹妖這一輪先不動，下一輪才開始投擲長矛（見 Match.nextActor）
// - 古樹的攻擊只打玩家，不會打到自己的樹妖
// - 單人 / 多人以這一關的玩家人數判斷（1 人 = 單人）

export const TREE_ACTION_NAMES = {
  summon: '士兵召喚',
  trunk: '古樹撞擊',
  leaves: '飛散落葉',
  meditate: '閉目養神',
  idle: '古樹靜靜地看著你們',
};

// 建立古樹的兩個部位。hpScale = 血量倍率（每多一位玩家 +50%，第二個王關以後再乘 bossStageScale，見 match.js）；樹妖、閉目養神也照這個
export function buildTree(match, hpScale) {
  const T = CONFIG.TREE_BOSS;
  const def = match.level.mechanic;
  // minions：召喚過的樹妖出生資料（重連時照著重建）；next：預定的下一招（Match 開場落地後才決定）
  match.tree = { def, hpScale, minions: [], seq: 0, next: null };
  const part = (p, o) => new Entity({
    ...CONFIG.ENEMY, team: 'enemies', controller: 'ai', slot: 0, facing: -1,
    x: p.x, y: p.y + p.hh, hw: p.hw, h: p.hh * 2, boss: true, fixed: true, ...o,
  });
  match.entities.push(part(def.eye, { id: 'eye', name: '古樹之眼', part: 'eye', hp: Math.round(T.eyeHp * hpScale) }));
  // 嘴巴打不壞（血量只是佔位，不會被扣），只會被打到閉上；閉上要撐過幾個古樹回合依單人 / 多人而定
  const closeTurns = isSolo(match) ? T.mouthClosedTurnsSolo : T.mouthClosedTurnsMulti;
  match.entities.push(part(def.mouth, { id: 'mouth', name: '古樹之口', part: 'mouth', noTurn: true, closeOnHit: closeTurns, hp: 1 }));
}

// 這一關是不是單人（只有 1 位玩家）
export function isSolo(match) {
  return match.players.length <= 1;
}

// 嘴巴現在張著嗎（張著才會召喚樹妖）
export function mouthOpen(match) {
  const m = match.byId('mouth');
  return !!m && m.alive && m.closedTurns === 0;
}

// 古樹之口被打到（爆炸 / 命中結算的第一步，在無敵之前）：被敵方打到（直擊或波及）就閉上，撐過 closeOnHit 個古樹回合才張開。
// 打不壞、不會燒、不會中毒、不會被擊退；自己人打到沒事。回傳要放進傷害清單的那一筆（沒事 = null）
export function hitMouth(mouth, friendly) {
  if (friendly) return null;
  mouth.closedTurns = mouth.closeOnHit;
  mouth.hurtTimer = 0.35;
  return { id: mouth.id, dmg: 0, friendly, closed: true };
}

// 古樹（眼睛）的回合結束時：閉著的嘴巴撐過了這個回合，張開。fx 給客戶端播動畫
export function reopenMouth(match, fx) {
  const m = match.byId('mouth');
  if (!m || !m.alive || m.closedTurns <= 0) return;
  m.closedTurns--;
  if (m.closedTurns === 0) fx.push({ type: 'mouthOpen', id: m.id });
}

// 召喚一隻樹妖（伺服器出招、客戶端播動畫、重連重建都用這個，所以雙方的角色一模一樣）
export function spawnTreant(match, spec) {
  const e = new Entity({
    ...CONFIG.TREANT, id: spec.id, name: spec.name, team: 'enemies', controller: 'ai', slot: 0,
    x: spec.x, y: spec.y, facing: -1, hp: spec.hp, minion: true,
  });
  match.entities.push(e);
  if (match.tree) match.tree.minions.push(spec);
  return e;
}

// 古樹之眼倒下 → 嘴巴與樹妖一起枯萎。回傳這次枯萎的角色
export function witherTree(match) {
  if (!match.tree) return [];
  const eye = match.byId('eye');
  if (!eye || eye.alive) return [];
  const withered = match.enemies.filter(e => e.alive);
  for (const e of withered) e.die('wither');
  return withered;
}

// 角色站在哪個平面上（古樹撞擊用）：x 在平面範圍內、腳底離平面表面最近的那個
export function planeOf(planes, e) {
  let best = -1, bestD = Infinity;
  planes.forEach((pl, i) => {
    if (e.x < pl.x0 - e.hw || e.x > pl.x1 + e.hw) return;
    const d = Math.abs(e.y - pl.y);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// 每個平面上站了幾位活著的玩家
export function planeCounts(match) {
  const planes = match.tree.def.planes;
  const counts = planes.map(() => 0);
  for (const e of match.players) {
    if (!e.alive) continue;
    const i = planeOf(planes, e);
    if (i >= 0) counts[i]++;
  }
  return counts;
}

// 還能召喚樹妖的出生點（樹妖滿了、或每個出生點都有活著的樹妖就回傳 null）
function freeSpawn(match) {
  const alive = match.enemies.filter(e => e.minion && e.alive);
  if (alive.length >= CONFIG.TREE_BOSS.maxMinions) return null;
  return match.tree.def.minionSpawns.find(s => !alive.some(m => Math.abs(m.x - s.x) < 20)) || null;
}

// 古樹現在出招的話會不會召喚：嘴巴張著，而且還有空的出生點（樹妖沒滿）。畫面 HUD 也用這個
export function canSummon(match) {
  return mouthOpen(match) && !!freeSpawn(match);
}

// 依權重抽一招（不含召喚）：撞擊 / 落葉 / 閉目養神（眼睛受過傷才有）/ 發呆，權重全是 0 就發呆
export function rollTreeAction(match, eye) {
  const W = CONFIG.TREE_BOSS.weights;
  const options = [['trunk', W.trunk], ['leaves', W.leaves]];
  if (eye.hp < eye.maxHp) options.push(['meditate', W.meditate]);
  options.push(['idle', W.idle]);
  return weightedPick(match.rng, options) || 'idle';
}

// 站最多活著的玩家的平面（平手就隨機挑一個）
function busiestPlane(match) {
  const counts = planeCounts(match);
  const max = Math.max(...counts);
  const tied = counts.map((c, i) => (c === max ? i : -1)).filter(i => i >= 0);
  return tied.length > 1 ? match.rng.pick(tied) : tied[0];
}

// 預先決定古樹的下一招，存在 match.tree.next = { action, plane? }（plane 只有撞擊才有，是 def.planes 的索引）。
// 撞擊的平面在這時候就選好：照現在大家站的位置挑人最多的
export function planTreeNext(match, eye) {
  const action = rollTreeAction(match, eye);
  const next = { action };
  if (action === 'trunk') next.plane = busiestPlane(match);
  match.tree.next = next;
  return next;
}

// 這回合的主要招式：能召喚就召喚，不然就是預定的那一招（還沒預定就當場決定）
export function chooseTreeAction(match, eye) {
  if (canSummon(match)) return 'summon';
  return (match.tree.next || planTreeNext(match, eye)).action;
}

// 古樹的回合：出招並結算，回傳 { steps: [招式…], next }，steps 依序播放，next = 這回合結束後預定的下一招。
// 一般只有一招；多人召喚的回合可能是 [召喚, 預定的攻擊]。用掉了預定的招式，就在所有招式結算完（擊退落地）後再決定下一招。
// 每一招：
//   有飛行物的招式（撞擊、落葉）帶 shot（跟一般開火一樣的格式，kind: 'boss'）
//   其他招式（召喚、閉目養神、發呆）帶 still = { results, settleFrames }
export function resolveTreeTurn(match, eye) {
  const plan = match.tree.next || planTreeNext(match, eye);
  const steps = [];
  let used = false;
  if (canSummon(match)) {
    steps.push(resolveTreeAction(match, eye, { action: 'summon' }));
    // 多人：預定的撞擊 / 落葉接在召喚後面；閉目養神 / 發呆、或是單人，就留到下一個古樹回合
    if (!isSolo(match) && CONFIG.TREE_BOSS.attackOnSummonMulti && (plan.action === 'trunk' || plan.action === 'leaves')) {
      steps.push(resolveTreeAction(match, eye, plan));
      used = true;
    }
  } else {
    steps.push(resolveTreeAction(match, eye, plan));
    used = true;
  }
  if (used) planTreeNext(match, eye);
  return { steps, next: { ...match.tree.next } };
}

// 古樹撞擊的橫掃範圍：樹幹中心高度 y、半徑 half（上緣 top、下緣 bottom），從樹皮表面 x1 一路掃到 x0 = 0。
// 伺服器的樹幹（trunkShot）與客戶端的預告警示帶都用這個，兩邊才不會對不上
export function trunkLane(match, planeIdx) {
  const y = match.tree.def.planes[planeIdx].y - 18;   // 樹幹中心在站著的角色身體中間
  const half = CONFIG.WEAPONS.treeTrunk.hitRadius;
  return { y, half, top: y - half, bottom: y + half, x0: 0, x1: match.terrain.hardEdgeX(y) };
}

// 結算一招。plan = { action, plane? }（撞擊一定掃 plan.plane，不管玩家現在在哪）
function resolveTreeAction(match, eye, { action, plane }) {
  switch (action) {
    case 'summon': {   // 一次召喚「玩家人數 × summonPerPlayer」隻，出生點不夠 / 到上限就停
      const count = Math.max(1, Math.round(CONFIG.TREE_BOSS.summonPerPlayer * match.players.length));
      const spawns = [];
      for (let i = 0; i < count; i++) {
        const spot = freeSpawn(match);
        if (!spot) break;
        const n = ++match.tree.seq;
        const spec = { id: `m${n}`, name: `樹妖 ${n}`, x: spot.x, y: spot.y, hp: Math.round(CONFIG.TREANT.hp * match.tree.hpScale) };
        spawnTreant(match, spec).dormant = true;
        spawns.push(spec);
      }
      return { action, spawns, still: stillResult(match) };
    }
    case 'trunk':
      return { action, plane, shot: trunkShot(match, eye, plane) };
    case 'leaves': {
      const { x, y } = leafOrigin(eye);
      const target = nearestPlayerAt(match, x, y);
      if (!target) return { action: 'idle', still: stillResult(match) };
      return { action, targetId: target.id, shot: leafShot(match, eye, target) };
    }
    case 'meditate': {
      const heal = match.heal(eye, Math.round(CONFIG.TREE_BOSS.meditateHeal * match.tree.hpScale));
      return { action, heal, still: stillResult(match) };
    }
    default:
      return { action: 'idle', still: stillResult(match) };
  }
}

// 飛散落葉從眼睛左邊飛出來
export function leafOrigin(eye) {
  return { x: eye.x - eye.hw - 10, y: eye.cy };
}

// 古樹撞擊：巨大樹幹從樹幹表面伸出，在預定的平面高度往左橫掃整張地圖（範圍見 trunkLane）。
// 古樹的招式（撞擊、下面的落葉）都帶 passAllies：穿過眼、嘴、樹妖，只打玩家；結果跟一般開火同樣格式（見 mechanics/common.js 的 bossShot）
function trunkShot(match, eye, planeIdx) {
  const weapon = CONFIG.WEAPONS.treeTrunk;
  const { y, x1 } = trunkLane(match, planeIdx);
  const x = Math.min(x1 + 30, CONFIG.WORLD_W);
  return bossShot(match, eye, weapon, [bossProjectile(eye, weapon, x, y, -weapon.speed, 0)]);
}

// 飛散落葉：直線飛向目標，穿過地形與角色
function leafShot(match, eye, target) {
  const weapon = CONFIG.WEAPONS.treeLeaf;
  const o = leafOrigin(eye);
  const dx = target.cx - o.x, dy = target.cy - o.y;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  return bossShot(match, eye, weapon, [bossProjectile(eye, weapon, o.x, o.y, dx / d * weapon.speed, dy / d * weapon.speed)]);
}
