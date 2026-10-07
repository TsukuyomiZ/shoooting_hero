import { CONFIG } from './config.js';
import { Entity } from './entities.js';
import { clamp } from './utils.js';
import { nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// 小關「小心擊發」的蜂巢與蜜蜂（伺服器與客戶端共用；蜜蜂的回合只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/mechanics/hive.js。這一場的狀態在 match.mechState（buildHive 建的那一份）。
//
// - 蜂巢：掛在樹枝最左邊下面，固定不動、不會輪到它（noTurn）。打不打都可以：狙擊手全倒就過關（蜂巢與蜜蜂是 optional）。
//   被玩家方攻擊到（直擊或爆炸波及；一顆飛行物算一次，等離子三發都打到 = 三次）就只扣 1，不管用什麼武器、傷害多高；
//   每被打到一次就飛出一隻蜜蜂（打掉蜂巢的那一下也會飛出來，所以最多 HIVE.hp 隻）。打掉蜂巢不算擊殺（noKill）。
//   不會燃燒、中毒、被擊退；敵人自己的子彈會穿過它（allyPass），不會讓它扣血、放蜜蜂。見 mechanics/hive.js 的 absorbHit
// - 蜜蜂：從蜂巢飛出來，停在 level.mechanic.beeSpots（找沒有蜜蜂停著的）。飛在空中（fixed：不受重力、不會被擊退、不會落水），
//   血量跟一般敵人一樣依人數、關數放大。剛飛出來後的第一個自己的回合先待機（BEE.waitTurns），
//   之後每個回合衝向離牠最近的玩家（直線、穿過地形；中間剛好有別的玩家就先螫到那個人）：beeSting 的傷害 + 中毒。
//   螫完停在被螫的人身體旁邊（不蓋到他的名字；好幾隻時互相錯開，見 hoverSpot），下一回合再衝（BEE.diesOnSting 打開的話螫完就死）
// - 蜜蜂的回合跟 Boss 一樣是 aiTurn 的 boss.steps（一招：wait / idle 帶 still、sting 帶 shot），裁判與客戶端共用同一套流程

export const BEE_ACTION_NAMES = {
  wait: '蓄勢待發',
  sting: '衝刺螫擊',
  idle: '嗡嗡地飛著',
};

// 建立蜂巢，回傳這一場蜂巢的狀態（地圖機制的 build 回傳給 Match，存成 match.mechState）。
// hpScale = 這一關一般敵人的血量倍率（人數 × 關數），蜜蜂照它放大；蜂巢本身固定 HIVE.hp
export function buildHive(match, hpScale) {
  const def = match.level.mechanic;
  // bees：放出來過的蜜蜂出生資料（重連時照著重建）；fresh：剛放出來、還沒寫進事件的
  const state = { def, hpScale, bees: [], seq: 0, fresh: [] };
  match.entities.push(new Entity({
    ...CONFIG.ENEMY, id: 'hive', name: '蜂巢', team: 'enemies', controller: 'ai', slot: 0, facing: -1, kind: 'hive',
    x: def.x, y: def.y, hw: def.hw, h: def.h, hp: CONFIG.HIVE.hp,
    fixed: true, noTurn: true, optional: true, allyPass: true, noKill: true,
  }));
  return state;
}

// 這一場蜂巢的狀態（match.mechState）。一般小關（null）、別張地圖的狀態（沒有 bees）都當作沒有蜂巢
const hiveState = (match) => (match.mechState && match.mechState.bees ? match.mechState : null);

// 蜂巢被玩家方打到一次（爆炸結算扣完所有人的血之後，見 mechanics/hive.js）：扣 1、放出一隻蜜蜂（打掉的那一下也放）。回傳實際扣的血
export function hitHive(match, hive) {
  const dmg = hive.takeDamage(1);
  if (hiveState(match)) releaseBee(match);
  return dmg;
}

// 放出一隻蜜蜂：停在第一個沒有蜜蜂停著的位置
function releaseBee(match) {
  const H = match.mechState;
  const n = ++H.seq;
  const spot = freeSpot(match, n);
  const spec = {
    id: `b${n}`, name: `蜜蜂 ${n}`, x: spot.x, y: spot.y,
    hp: Math.round(CONFIG.BEE.hp * H.hpScale), wait: CONFIG.BEE.waitTurns,
  };
  spawnBee(match, spec);
  H.fresh.push({ ...spec });
  return spec;
}

function freeSpot(match, n) {
  const spots = match.mechState.def.beeSpots;
  const bees = match.entities.filter(e => e.kind === 'bee' && e.alive);
  const free = spots.find(s => !bees.some(b => Math.abs(b.x - s.x) < 16 && Math.abs(b.y - s.y) < 16));
  if (free) return free;
  const s = spots[(n - 1) % spots.length];   // 每個位置都有蜜蜂停著：照順序疊上去，稍微錯開
  return { x: s.x + 8, y: s.y - 8 };
}

// 照出生資料建立一隻蜜蜂（伺服器放蜜蜂、客戶端照事件播、重連重建都用這個，所以雙方的角色一模一樣）
export function spawnBee(match, spec) {
  const e = new Entity({
    ...CONFIG.BEE, id: spec.id, name: spec.name, team: 'enemies', controller: 'ai', slot: 0, kind: 'bee', facing: -1,
    x: spec.x, y: spec.y, hp: spec.hp, waitTurns: spec.wait,
    fixed: true, optional: true, allyPass: true,
  });
  match.entities.push(e);
  const H = hiveState(match);
  if (H) H.bees.push({ ...spec });
  return e;
}

// 照事件帶來的出生資料（ev.bees）建出還沒有的蜜蜂：已經有同 id 的就跳過（重連時快照先建過）。回傳這次新建的角色。
// 客戶端重播（shared/volley.js 經地圖機制的 replayEvent）與重連（Match.applySnapshot）都用這個，建法只有一份
export function hatchBees(match, specs) {
  const made = [];
  for (const s of specs || []) if (!match.byId(s.id)) made.push(spawnBee(match, s));
  return made;
}

// 這一下剛放出來的蜜蜂（resolveHit 寫進事件給客戶端），拿出來就清掉
export function takeFreshBees(match) {
  const H = hiveState(match);
  if (!H || !H.fresh.length) return [];
  const out = H.fresh;
  H.fresh = [];
  return out;
}

// 蜜蜂的回合：還在待機就待機（次數 -1），不然衝向最近的玩家。回傳 { steps: [招式], next: null }（格式同 Boss）
export function resolveBeeTurn(match, bee) {
  if (bee.waitTurns > 0) {
    bee.waitTurns--;
    return { steps: [{ action: 'wait', still: stillResult(match) }], next: null };
  }
  const target = nearestPlayerAt(match, bee.cx, bee.cy);   // 離蜜蜂最近的活著的玩家（一樣近時排前面的先）
  if (!target) return { steps: [{ action: 'idle', still: stillResult(match) }], next: null };
  return { steps: [{ action: 'sting', targetId: target.id, shot: stingShot(match, bee, target) }], next: null };
}

// 螫完停的位置：被螫的人身體旁邊（從哪一側衝過來就停在哪一側、胸口的高度），不蓋到他頭上的名字和血條；
// 不出畫面、不進水、不跑進上方 HUD。好幾隻螫同一個人時不要疊在一起（蜜蜂頭上也有名字和血條）：
// 照順序試幾個位置（同一側再往外、往上，再換另一側），挑第一個跟其他活著的蜜蜂「名字 + 血條」不重疊的
const HOVER_SPOTS = [[42, 0], [42, -52], [90, 0], [90, -52], [-42, 0], [-42, -52], [-90, 0], [-90, -52], [42, -104], [-42, -104]];
const HOVER_DX = 48, HOVER_DY = 52;   // 兩隻蜜蜂左右差這麼多、或上下差這麼多，名字和血條就不會疊在一起
export function hoverSpot(match, bee, target, ux) {
  const side = ux > 0 ? -1 : 1;   // 往右衝過來 = 從左邊來，停在左邊
  const others = match.entities.filter(e => e.kind === 'bee' && e.alive && e !== bee);
  let first = null;
  for (const [dx, dy] of HOVER_SPOTS) {
    const spot = {
      x: clamp(target.x + side * dx, bee.hw, CONFIG.WORLD_W - bee.hw),
      y: clamp(target.cy + bee.h / 2 + dy, bee.h + 60, CONFIG.WATER_LEVEL - 20),
    };
    first = first || spot;
    // 不要停進土裡 / 樹幹裡（砲彈會先撞到地形）：身體中間、下緣都要在空中
    if (match.terrain.isSolid(spot.x, spot.y - bee.h / 2) || match.terrain.isSolid(spot.x, spot.y - 1)) continue;
    if (others.every(o => Math.abs(o.x - spot.x) >= HOVER_DX || Math.abs(o.y - spot.y) >= HOVER_DY)) return spot;
  }
  return first;   // 周圍都滿了（很多隻擠在牆角）：就停在第一個位置
}

// 衝刺螫擊：飛行物就是蜜蜂本身，從蜜蜂的中心直線衝向目標的中心（穿過地形與自己人）。
// 結果跟一般開火同樣格式（kind: 'boss'），客戶端用 shotScript 重播；飛完蜜蜂停到 hoverSpot（沒碰到人就回原地）
function stingShot(match, bee, target) {
  const weapon = CONFIG.WEAPONS.beeSting;
  const ox = bee.x, oy = bee.cy;
  const dx = target.cx - ox, dy = target.cy - oy;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / d, uy = dy / d;
  bee.facing = ux >= 0 ? 1 : -1;
  const shot = bossShot(match, bee, weapon, [bossProjectile(bee, weapon, ox, oy, ux * weapon.speed, uy * weapon.speed)], bee.facing);
  const hit = shot.events.find(ev => ev.target);
  const victim = hit && match.byId(hit.target);
  if (victim) {
    const spot = hoverSpot(match, bee, victim, ux);   // 被螫的人被擊退、落地之後的位置
    bee.x = spot.x;
    bee.y = spot.y;
    if (CONFIG.BEE.diesOnSting) bee.die('sting');
  }
  shot.results = match.entities.map(e => e.toState());   // 蜜蜂停下來的位置（或螫完死掉）要進最後的校正
  return shot;
}
