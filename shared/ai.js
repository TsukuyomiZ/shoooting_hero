import { CONFIG } from './config.js';
import { clamp } from './utils.js';
import { simulateShot, shotTraits, blastRadius } from './weapons.js';

// 砲口到目標中心的直線上，第一個擋住的東西：'terrain'（地形）、擋在中間的角色，或 null（沒被擋住）。
// 自己人的子彈穿得過的角色（蜂巢、蜜蜂，allyPass）不擋同隊的視線
export function lineBlocker(world, shooter, target) {
  const m = shooter.muzzle();
  const tx = target.cx, ty = target.cy;
  const dist = Math.hypot(tx - m.x, ty - m.y);
  const steps = Math.ceil(dist / 2);
  for (let i = 1; i <= steps; i++) {
    const x = m.x + (tx - m.x) * i / steps;
    const y = m.y + (ty - m.y) * i / steps;
    if (world.terrain.isSolid(x, y)) return 'terrain';
    for (const e of world.entities) {
      if (!e.alive || e === shooter || e === target || (e.allyPass && e.team === shooter.team)) continue;
      if (e.containsPoint(x, y, 2)) return e;
    }
  }
  return null;
}

// 砲口到目標中心的直線是否沒被地形 / 其他角色擋住
export function hasLineOfSight(world, shooter, target) {
  return lineBlocker(world, shooter, target) === null;
}

// 拋射武器的偏好順序（AI 從自己的武器欄挑第一把有的）
const ARC_PREFERENCE = ['plasma', 'cannon', 'boomerang', 'treeSpear'];

// 幫 shooter 規劃一發：對敵隊試射找最接近的角度/力量，再加上誤差。只用 shooter 武器欄裡有的武器。
// 敵人回合、以及斷線玩家的 AI 代打都用這個。回傳 { weapon, angle, power, facing, targetId } 或 null。
// 瞄準誤差 / 狙擊機率用敵人自己的設定（shooter.ai），代打的玩家沒有就用 CONFIG.ENEMY
export function planShot(world, shooter, rng) {
  // 已經閉上的古樹之口不用再打（張著的嘴「血量」是 1，七成機率會被當成最好打的目標，等於 AI 會優先把嘴打閉）；
  // 蜂巢不打（打一下就放出一隻蜜蜂，斷線代打的玩家去戳它只會害到隊伍）
  const avoid = (e) => e.kind === 'hive';
  const targets = world.entities.filter(e => e.alive && e.team !== shooter.team && !(e.closeOnHit && e.closedTurns > 0) && !avoid(e));
  if (!targets.length) return null;
  const arcId = ARC_PREFERENCE.find(id => shooter.weapons.includes(id));
  // 只有狙擊槍（狙擊手）：直線打得到的人優先；都被擋住的話，挑被地形（或其他敵方）擋住的隨便打一槍，
  // 但不隔著自己人開槍（大亂鬥的平地上，排在後面的狙擊手會打到前面的同伴）——每個人都被自己人擋住就不開火
  let pool = targets;
  if (!arcId && shooter.weapons.includes('sniper')) {
    const blockers = targets.map(t => lineBlocker(world, shooter, t));
    const visible = targets.filter((t, i) => blockers[i] === null);
    pool = visible.length ? visible : targets.filter((t, i) => blockers[i] === 'terrain' || blockers[i].team !== shooter.team);
    if (!pool.length) return null;
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
  const traits = shotTraits(shooter, arcId);   // 代打的玩家有彈射的效果（蹦蹦炸彈）：試射也要照彈射後的落點算
  const friends = world.entities.filter(e => e.alive && e.team === shooter.team);
  const shunned = world.entities.filter(e => e.alive && e.team !== shooter.team && avoid(e));   // 蜂巢：落點離它太近也扣分
  // 落點離隊友 / 蜂巢多近算會炸到：爆炸半徑（同一個 blastRadius：代打的玩家有半徑加成的牌也照算；敵人沒有，就是武器原本的半徑）+ 20
  const reach = blastRadius(shooter, weapon) + 20;
  let best = null;
  for (let a = 15; a <= 85; a += 5) {
    const angle = facing > 0 ? a : 180 - a;
    for (let power = 15; power <= 100; power += 5) {
      const r = simulateShot(world, shooter, weapon, angle, power, 6, 0, traits);
      let score;
      if (r.hit.type === 'entity' && r.hit.entity === target) {
        score = 0;
      } else if (r.hit.type === 'entity' && (r.hit.entity.team === shooter.team || avoid(r.hit.entity))) {
        score = 5000;
      } else {
        score = Math.hypot(r.hit.x - target.cx, r.hit.y - target.cy);
        if (r.hit.type !== 'terrain' && r.hit.type !== 'entity') score += 400;
        // 會炸到隊友的落點扣分（穿過自己人、又不爆炸的武器——樹妖的長矛——不用管）
        if (!(weapon.passAllies && !weapon.radius)) {
          for (const f of friends) {
            if (Math.hypot(r.hit.x - f.cx, r.hit.y - f.cy) < reach) score += 800;
          }
        }
      }
      // 爆炸會波及蜂巢的落點也扣分（直接打中目標也一樣：目標就在蜂巢旁邊時寧可換個打法）
      if (score < 5000 && weapon.radius > 0) {
        for (const s of shunned) if (s.distanceTo(r.hit.x, r.hit.y) < reach) score += 800;
      }
      if (!best || score < best.score) best = { score, angle, power };
    }
  }
  if (!best) return null;
  let angle = best.angle + noise(err.angle);
  let power = clamp(best.power + noise(err.power), 10, 100);
  // 蜂巢在場：上面只挑了「不加誤差」的那一發，加上誤差後常常會擦到蜂巢（拋物線往樹枝飛時就從它旁邊過）。
  // 加了誤差會打到 / 炸到蜂巢就重抽誤差（最多 6 次），都不行就用不加誤差的那一發。AI 只在伺服器跑，多抽幾次亂數不影響重播
  if (shunned.length) {
    // 爆炸範圍照 Match.explosionRadius / applyExplosion（同一個 blastRadius：吃效果的半徑加成，波及判定再 +6）
    const blast = weapon.radius > 0 ? blastRadius(shooter, weapon) + 6 : 0;
    const pokes = (a, pw) => {
      const r = simulateShot(world, shooter, weapon, a, pw, 6, 0, traits);
      return (r.hit.type === 'entity' && avoid(r.hit.entity)) || (blast > 0 && shunned.some(s => s.distanceTo(r.hit.x, r.hit.y) <= blast));
    };
    let ok = !pokes(angle, power);
    for (let k = 0; k < 6 && !ok; k++) {
      angle = best.angle + noise(err.angle);
      power = clamp(best.power + noise(err.power), 10, 100);
      ok = !pokes(angle, power);
    }
    if (!ok) { angle = best.angle; power = best.power; }
  }
  return { weapon: arcId, angle, power, facing, targetId: target.id };
}
