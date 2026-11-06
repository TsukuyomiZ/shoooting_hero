import { CONFIG } from '../core/config.js';
import { clamp } from '../core/utils.js';
import { simulateShot, shotTraits, blastRadius, shotRange } from '../physics/weapons.js';

// 砲口到目標中心的直線上，第一個擋住的東西：'terrain'（地形）、擋在中間的角色，或 null（沒被擋住）。
// 自己人的子彈穿得過的角色（蜂巢、蜜蜂，allyPass）不擋同隊的視線；地形照這一隊的子彈撞不撞得到算（別隊的掩體平台也擋，見 Terrain.blocksShot）
export function lineBlocker(world, shooter, target) {
  const m = shooter.muzzle();
  const tx = target.cx, ty = target.cy;
  const dist = Math.hypot(tx - m.x, ty - m.y);
  const steps = Math.ceil(dist / 2);
  for (let i = 1; i <= steps; i++) {
    const x = m.x + (tx - m.x) * i / steps;
    const y = m.y + (ty - m.y) * i / steps;
    // 子彈從下面打得穿的地形（大地祭壇的斜坡）：往上的直線穿過去，跟飛行物同一條規則（Terrain.shotPasses；直線的方向不變）
    if (world.terrain.blocksShot(x, y, shooter.team) &&
        !world.terrain.shotPasses(x, y, m.x + (tx - m.x) * (i - 1) / steps, m.y + (ty - m.y) * (i - 1) / steps, ty - m.y)) return 'terrain';
    for (const e of world.entities) {
      // 目標關著的人（囚籠裡、被熊抱住的隊友）站在它裡面：不算擋住（要救的就是他）
      if (!e.alive || e === shooter || e === target || (e.allyPass && e.team === shooter.team) || (target.heldId && e.id === target.heldId)) continue;
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
// 直線武器（狙擊槍；蝙蝠的聲波照狙擊槍的打法；飛鏢有一點重力但幾乎是直線；高壓水炮、西洋刺劍只打得到射程內的）
const LINE_PREFERENCE = ['sniper', 'sonic', 'darts', 'waterCannon', 'rapier'];

// 幫 shooter 規劃一發：對敵隊試射找最接近的角度/力量，再加上誤差。只用 weapons 裡有的武器（預設 = 武器欄；
// 射過飛鏢的回合被代打只能用飛鏢）。敵人回合、以及斷線玩家的 AI 代打都用這個。回傳 { weapon, angle, power, facing, targetId } 或 null。
// 瞄準誤差 / 狙擊機率用敵人自己的設定（shooter.ai），代打的玩家沒有就用 CONFIG.ENEMY
export function planShot(world, shooter, rng, weapons = shooter.weapons) {
  const T = targeting(world, shooter, weapons);
  return T ? aimShot(world, shooter, rng, T) : null;
}

// shooter 現在開不開得了火：有目標，但只有直線武器而且每個人都被自己人擋住（或在射程外）= false（planShot 會不開火）。
// 不用亂數（敵人走動挑終點時用，見 ai-move.js：別走到自己或同伴打不到人的地方）
export function canFire(world, shooter, weapons = shooter.weapons) {
  return targeting(world, shooter, weapons) !== null;
}

// 這一發要打誰：{ avoid, arcId, lineId, inReach, pool }；沒有目標、或只有直線武器而打得到的都被自己人擋住 → null
function targeting(world, shooter, weapons) {
  // 已經閉上的古樹之口不用再打（張著的嘴「血量」是 1，七成機率會被當成最好打的目標，等於 AI 會優先把嘴打閉）；
  // 蜂巢不打（打一下就放出一隻蜜蜂，斷線代打的玩家去戳它只會害到隊伍）；分身（decoy，例如調皮妖精的）也不打（打到會爆炸）
  const avoid = (e) => e.kind === 'hive' || e.decoy;
  const targets = world.entities.filter(e => e.alive && !e.intangible && e.team !== shooter.team && !(e.closeOnHit && e.closedTurns > 0) && !avoid(e));
  if (!targets.length) return null;
  const arcId = ARC_PREFERENCE.find(id => weapons.includes(id));
  // AI 一回合只射一發：有拋射武器時不拿一回合可以射好幾次的武器（飛鏢）只丟一支
  const lineId = LINE_PREFERENCE.find(id => weapons.includes(id) && !(arcId && CONFIG.WEAPONS[id].shotsPerTurn > 1));
  // 直線武器的射程（高壓水炮 300px；其他不限）：砲口到目標中心超過就打不到。
  // 會爆開一大片的直線武器（高壓水炮）：目標旁邊有自己人（含自己）或蜂巢會被波及就不用它（狙擊槍那種小爆炸照舊不管）
  const lineW = lineId ? CONFIG.WEAPONS[lineId] : null;
  const lineReach = lineW ? shotRange(lineW, 100) : Infinity;
  const lineSplash = lineW && lineW.radius > 10 ? blastRadius(shooter, lineW) + 20 : 0;
  const m0 = shooter.muzzle();
  const inReach = (t) => (lineReach === Infinity || Math.hypot(t.cx - m0.x, t.cy - m0.y) <= lineReach - 8) &&
    (!lineSplash || !world.entities.some(f => f.alive && (f.team === shooter.team || avoid(f)) && Math.hypot(f.cx - t.cx, f.cy - t.cy) < lineSplash));
  // 只有狙擊槍（狙擊手；蝙蝠的聲波也一樣）：直線打得到的人優先；都被擋住的話，挑被地形（或其他敵方）擋住的隨便打一槍，
  // 但不隔著自己人開槍（大亂鬥的平地上，排在後面的狙擊手會打到前面的同伴）——每個人都被自己人擋住就不開火。射程外 / 會波及自己人的不算
  let pool = targets;
  if (!arcId && lineId) {
    const inRange = targets.filter(inReach);
    const blockers = inRange.map(t => lineBlocker(world, shooter, t));
    const visible = inRange.filter((t, i) => blockers[i] === null);
    pool = visible.length ? visible : inRange.filter((t, i) => blockers[i] === 'terrain' || blockers[i].team !== shooter.team);
    if (!pool.length) return null;
  }
  return { avoid, arcId, lineId, inReach, pool };
}

// AI 會拿哪一把（照一般 AI 的偏好：拋射武器優先，沒有才用直線武器）；都沒有 = null
export function preferredWeapon(shooter, weapons = shooter.weapons) {
  return ARC_PREFERENCE.find(id => weapons.includes(id)) || LINE_PREFERENCE.find(id => weapons.includes(id)) || null;
}

// 指定目標、指定武器的一發（地圖機制接手玩家的回合用，例如調皮妖精的魅惑：打隊友）：不管敵我、不避開自己人。
// hit = true：瞄著 target 打；false：打偏——拋射武器瞄在 target 左或右 miss px 的地方（落點不會直接打在他身上），
// 直線武器把角度往上或往下偏開（經過他的時候離他身體中心約 miss px）。error = true：再加上一般 AI 的瞄準誤差（shooter.ai，沒有就 CONFIG.ENEMY）。
// 直線武器（LINE_PREFERENCE）照直線瞄，其他照拋射掃描角度 × 力量。回傳 { weapon, angle, power, facing, targetId }；沒有這把武器 / 沒有目標 = null
export function planShotAt(world, shooter, rng, target, weaponId, { hit = true, miss = 130, error = false } = {}) {
  const weapon = CONFIG.WEAPONS[weaponId];
  if (!weapon || !target) return null;
  const ai = shooter.ai || CONFIG.ENEMY;
  const noise = (a) => (error ? (rng.float() * 2 - 1) * a : 0);
  if (LINE_PREFERENCE.includes(weaponId)) {
    const m = shooter.muzzle();
    let angle = Math.atan2(-(target.cy - m.y), target.cx - m.x) * 180 / Math.PI;
    if (!hit) angle += (rng.chance(0.5) ? -1 : 1) * Math.atan2(miss, Math.max(1, Math.hypot(target.cx - m.x, target.cy - m.y))) * 180 / Math.PI;
    return { weapon: weaponId, angle: angle + noise(ai.sniperSpread ?? 1.2), power: 100, facing: target.cx >= shooter.cx ? 1 : -1, targetId: target.id };
  }
  const tx = hit ? target.cx : target.cx + (rng.chance(0.5) ? -1 : 1) * miss;
  const ty = target.cy;
  const facing = tx >= shooter.cx ? 1 : -1;
  const traits = shotTraits(shooter, weaponId);
  let best = null;
  for (let a = 10; a <= 85; a += 5) {
    const angle = facing > 0 ? a : 180 - a;
    for (let power = 15; power <= 100; power += 5) {
      const r = simulateShot(world, shooter, weapon, angle, power, 6, 0, traits);
      const onTarget = r.hit.type === 'entity' && r.hit.entity === target;
      let score;
      if (hit) score = onTarget ? 0 : Math.hypot(r.hit.x - tx, r.hit.y - ty);
      else score = onTarget ? 5000 : Math.hypot(r.hit.x - tx, r.hit.y - ty);
      if (!onTarget && r.hit.type !== 'terrain' && r.hit.type !== 'entity') score += 400;
      if (!best || score < best.score) best = { score, angle, power };
    }
  }
  return { weapon: weaponId, angle: best.angle + noise(ai.aimError.angle), power: clamp(best.power + noise(ai.aimError.power), 10, 100), facing, targetId: target.id };
}

// planShot 的後半：從 pool 挑目標、瞄準（targeting 算好的武器與目標）
function aimShot(world, shooter, rng, { avoid, arcId, lineId, inReach, pool }) {
  // 有隊友（或自己）被關在囚籠裡、被熊抱住（處刑監獄）：先打破籠子 / 打熊救人；不然七成機率打血最少的，三成隨機
  const rescue = pool.find(e => e.heldId && world.entities.some(f => f.id === e.heldId && f.alive && f.team === shooter.team));
  const target = rescue || (rng.chance(0.7)
    ? pool.reduce((a, b) => (b.hp < a.hp ? b : a))
    : rng.pick(pool));
  const facing = target.cx >= shooter.cx ? 1 : -1;
  const ai = shooter.ai || CONFIG.ENEMY;
  const err = ai.aimError;
  const noise = (a) => (rng.float() * 2 - 1) * a;

  // 有直線視野時，有機率直接用狙擊槍（沒有能拋射的武器就只能用狙擊槍 / 聲波）
  if (lineId && (!arcId || (hasLineOfSight(world, shooter, target) && inReach(target) && rng.chance(ai.sniperChance)))) {
    const m = shooter.muzzle();
    const angle = Math.atan2(-(target.cy - m.y), target.cx - m.x) * 180 / Math.PI + noise(ai.sniperSpread ?? 1.2);
    return { weapon: lineId, angle, power: 100, facing, targetId: target.id };
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
  let clean = null;   // 不會打到 / 炸到自己人（含自己）的落點裡最好的那一發
  for (let a = 15; a <= 85; a += 5) {
    const angle = facing > 0 ? a : 180 - a;
    for (let power = 15; power <= 100; power += 5) {
      const r = simulateShot(world, shooter, weapon, angle, power, 6, 0, traits);
      let score;
      let hurtsFriends = false;
      if (r.hit.type === 'entity' && r.hit.entity === target) {
        score = 0;
      } else if (r.hit.type === 'entity' && (r.hit.entity.team === shooter.team || avoid(r.hit.entity))) {
        score = 5000;
        hurtsFriends = r.hit.entity.team === shooter.team;
      } else {
        score = Math.hypot(r.hit.x - target.cx, r.hit.y - target.cy);
        if (r.hit.type !== 'terrain' && r.hit.type !== 'entity') score += 400;
        // 會炸到隊友的落點扣分（穿過自己人、又不爆炸的武器——樹妖的長矛——不用管）
        if (!(weapon.passAllies && !weapon.radius)) {
          for (const f of friends) {
            if (Math.hypot(r.hit.x - f.cx, r.hit.y - f.cy) < reach) { score += 800; hurtsFriends = true; }
          }
        }
      }
      // 爆炸會波及蜂巢的落點也扣分（直接打中目標也一樣：目標就在蜂巢旁邊時寧可換個打法）
      if (score < 5000 && weapon.radius > 0) {
        for (const s of shunned) if (s.distanceTo(r.hit.x, r.hit.y) < reach) score += 800;
      }
      if (!best || score < best.score) best = { score, angle, power, hurtsFriends };
      if (!hurtsFriends && (!clean || score < clean.score)) clean = { score, angle, power };
    }
  }
  if (!best) return null;
  // 玩家角色（斷線代打、勝者為王的電腦玩家）：最好的那一發會打到 / 炸到自己人（例如跟隊友一起被打進坑裡，每個角度都落在自己腳邊）
  // → 改用不會炸到自己人的那一發；都會的話看得到目標就用直線武器，不然這回合不開火（敵人照舊）
  if (shooter.isPlayer && best.hurtsFriends) {
    if (clean) best = clean;
    else if (lineId && hasLineOfSight(world, shooter, target) && inReach(target)) {
      const m = shooter.muzzle();
      const angle = Math.atan2(-(target.cy - m.y), target.cx - m.x) * 180 / Math.PI + noise(ai.sniperSpread ?? 1.2);
      return { weapon: lineId, angle, power: 100, facing, targetId: target.id };
    } else return null;
  }
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
