import { CONFIG } from './config.js';
import { clamp } from './utils.js';
import { simulateShot, shotTraits } from './weapons.js';

// 砲口到目標中心的直線是否沒被地形 / 其他角色擋住
export function hasLineOfSight(world, shooter, target) {
  const m = shooter.muzzle();
  const tx = target.cx, ty = target.cy;
  const dist = Math.hypot(tx - m.x, ty - m.y);
  const steps = Math.ceil(dist / 2);
  for (let i = 1; i <= steps; i++) {
    const x = m.x + (tx - m.x) * i / steps;
    const y = m.y + (ty - m.y) * i / steps;
    if (world.terrain.isSolid(x, y)) return false;
    for (const e of world.entities) {
      if (e.alive && e !== shooter && e !== target && e.containsPoint(x, y, 2)) return false;
    }
  }
  return true;
}

// 拋射武器的偏好順序（AI 從自己的武器欄挑第一把有的）
const ARC_PREFERENCE = ['plasma', 'cannon', 'boomerang', 'treeSpear'];

// 幫 shooter 規劃一發：對敵隊試射找最接近的角度/力量，再加上誤差。只用 shooter 武器欄裡有的武器。
// 敵人回合、以及斷線玩家的 AI 代打都用這個。回傳 { weapon, angle, power, facing, targetId } 或 null。
// 瞄準誤差 / 狙擊機率用敵人自己的設定（shooter.ai），代打的玩家沒有就用 CONFIG.ENEMY
export function planShot(world, shooter, rng) {
  // 已經閉上的古樹之口不用再打（張著的嘴「血量」是 1，七成機率會被當成最好打的目標，等於 AI 會優先把嘴打閉）
  const targets = world.entities.filter(e => e.alive && e.team !== shooter.team && !(e.closeOnHit && e.closedTurns > 0));
  if (!targets.length) return null;
  const arcId = ARC_PREFERENCE.find(id => shooter.weapons.includes(id));
  // 只有狙擊槍（狙擊手）：直線打得到的人優先，都被擋住才隨便挑
  let pool = targets;
  if (!arcId && shooter.weapons.includes('sniper')) {
    const visible = targets.filter(t => hasLineOfSight(world, shooter, t));
    if (visible.length) pool = visible;
  }
  // 七成機率打血最少的，三成隨機
  const target = rng.chance(0.7)
    ? pool.reduce((a, b) => (b.hp < a.hp ? b : a))
    : rng.pick(pool);
  const facing = target.cx >= shooter.cx ? 1 : -1;
  const ai = shooter.ai || CONFIG.ENEMY;
  const err = ai.aimError;
  const noise = (a) => (rng.float() * 2 - 1) * a;

  // 有直線視野時，有機率直接用狙擊槍（沒有能拋射的武器就只能用狙擊槍）
  if (shooter.weapons.includes('sniper') && (!arcId || (hasLineOfSight(world, shooter, target) && rng.chance(ai.sniperChance)))) {
    const m = shooter.muzzle();
    const angle = Math.atan2(-(target.cy - m.y), target.cx - m.x) * 180 / Math.PI + noise(ai.sniperSpread ?? 1.2);
    return { weapon: 'sniper', angle, power: 100, facing, targetId: target.id };
  }
  if (!arcId) return null;

  // 拋射武器：掃描角度 × 力量，找落點最接近目標、又不會炸到隊友的組合
  const weapon = CONFIG.WEAPONS[arcId];
  const traits = shotTraits(shooter, arcId);   // 代打的玩家有蹦蹦炸彈：試射也要照彈射後的落點算
  const friends = world.entities.filter(e => e.alive && e.team === shooter.team);
  let best = null;
  for (let a = 15; a <= 85; a += 5) {
    const angle = facing > 0 ? a : 180 - a;
    for (let power = 15; power <= 100; power += 5) {
      const r = simulateShot(world, shooter, weapon, angle, power, 6, 0, traits);
      let score;
      if (r.hit.type === 'entity' && r.hit.entity === target) {
        score = 0;
      } else if (r.hit.type === 'entity' && r.hit.entity.team === shooter.team) {
        score = 5000;
      } else {
        score = Math.hypot(r.hit.x - target.cx, r.hit.y - target.cy);
        if (r.hit.type !== 'terrain' && r.hit.type !== 'entity') score += 400;
        // 會炸到隊友的落點扣分（穿過自己人、又不爆炸的武器——樹妖的長矛——不用管）
        if (!(weapon.passAllies && !weapon.radius)) {
          for (const f of friends) {
            if (Math.hypot(r.hit.x - f.cx, r.hit.y - f.cy) < weapon.radius + 20) score += 800;
          }
        }
      }
      if (!best || score < best.score) best = { score, angle, power };
    }
  }
  if (!best) return null;
  return {
    weapon: arcId,
    angle: best.angle + noise(err.angle),
    power: clamp(best.power + noise(err.power), 10, 100),
    facing,
    targetId: target.id,
  };
}
