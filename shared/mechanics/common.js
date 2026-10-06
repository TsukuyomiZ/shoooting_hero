import { makeProjectile } from '../weapons.js';

// 地圖機制共用的小工具（古樹、巨蟒、蜜蜂的出招都用這些）。
// 只依賴 weapons.js，不碰 match.js：tree-boss.js / snake-boss.js / hive.js 會 import 這裡，客戶端也會載入

// 依權重抽一個：options = [[id, 權重], …]（負的、沒寫的當 0）。權重全是 0 回傳 null
export function weightedPick(rng, options) {
  const total = options.reduce((s, [, w]) => s + Math.max(0, w || 0), 0);
  if (!(total > 0)) return null;
  let r = rng.float() * total;
  for (const [id, w] of options) {
    r -= Math.max(0, w || 0);
    if (r < 0) return id;
  }
  return options[options.length - 1][0];
}

// 離 (x, y) 最近的活著的玩家（一樣近時排前面的先）；一個都沒有回傳 null
export function nearestPlayerAt(match, x, y) {
  let target = null, best = Infinity;
  for (const e of match.players) {
    if (!e.alive) continue;
    const d = (e.cx - x) * (e.cx - x) + (e.cy - y) * (e.cy - y);
    if (d < best) { best = d; target = e; }
  }
  return target;
}

// 招式的飛行物：第 1 幀就出發（owner 的招式帶 passAllies 的話會穿過自己人）
export function bossProjectile(owner, weapon, x, y, vx, vy) {
  const p = makeProjectile(owner, weapon, x, y, vx, vy);
  p.spawn = 1;
  return p;
}

// 跟一般開火同樣格式的結果（kind: 'boss'），客戶端直接用 shotScript 重播。
// actor 就是出招的角色本身的位置；facing：古樹、巨蟒固定朝左（-1），蜜蜂照衝的方向
export function bossShot(match, owner, weapon, projs, facing = -1) {
  return {
    kind: 'boss', actorId: owner.id, weapon: weapon.id, angle: 180, power: 0, facing,
    actor: { x: owner.x, y: owner.y, vy: 0 },
    ...match.resolveVolley(owner, weapon, projs, 0),
  };
}

// 沒有飛行物的招式（召喚、閉目養神、待機、發呆）：讓大家落地（上限 360 幀，跟一波的沉降一樣），回傳最終狀態
export function stillResult(match) {
  const settleFrames = match.settle(360);
  return { results: match.entities.map(e => e.toState()), settleFrames };
}
