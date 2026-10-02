import { CONFIG } from './config.js';

// 能放進武器欄的武器（裝備產生的攻擊，例如轟炸飛彈，與 Boss / 樹妖專用的攻擊不算）
export function isEquippable(id) {
  const w = CONFIG.WEAPONS[id];
  return !!w && !w.fromEquip && !w.enemyOnly;
}

// 依角度與力量算出初速度
export function launchVelocity(weapon, angleDeg, power) {
  const rad = angleDeg * Math.PI / 180;
  const speed = weapon.gravity > 0
    ? weapon.minSpeed + power * weapon.speedPerPower
    : weapon.speed;
  return { vx: Math.cos(rad) * speed, vy: -Math.sin(rad) * speed };
}

// 牌給這把武器的飛行物特性：彈射次數（哈哈子彈 = 狙擊槍、蹦蹦炸彈 = 大砲）、穿透角色（高倍率望遠鏡）。
// 伺服器結算、瞄準預覽、AI 試射都照這個，三邊才一致
export function shotTraits(owner, weaponId) {
  const m = owner && owner.mods;
  if (!m) return { bounces: 0, pierce: false };
  if (weaponId === 'sniper') return { bounces: m.sniperBounce || 0, pierce: m.sniperPierce > 0 };
  if (weaponId === 'cannon') return { bounces: m.cannonBounce || 0, pierce: false };
  return { bounces: 0, pierce: false };
}

// 飛行物。伺服器結算、客戶端重播、瞄準預覽與 AI 模擬都用同一個形狀
export function makeProjectile(owner, weapon, x, y, vx, vy) {
  return {
    owner, weapon, x, y, vx, vy,
    gravity: weapon.gravity, hitRadius: weapon.hitRadius, age: 0,
    ignore: new Set(),              // 不會再撞到的角色（已經穿透過的、轟炸的持有者）
    bouncesLeft: 0,                 // 還能在地形上彈射幾次（哈哈子彈、蹦蹦炸彈）
    pierce: !!weapon.pierce,        // 穿透角色（高倍率望遠鏡、古樹的攻擊）
    passTerrain: !!weapon.passTerrain,  // 穿過地形（古樹的攻擊）
    passAllies: !!weapon.passAllies,    // 穿過射手的隊友（古樹與樹妖的攻擊不會打到自己人）
    boomerang: !!weapon.boomerang,  // 撞到東西後沿原路飛回來
    leftOwner: false,               // 已經離開過射手的身體（之後才打得到他）
  };
}

// 讓飛行物前進 dt 秒（每 2px 一個子步避免穿透）。回傳撞擊事件或 null；
// 撞擊事件的 px/py 是撞到前最後一個不在實心裡的位置（彈射用）。
// world 給 null 時只跑運動學、不做碰撞：客戶端重播用，撞到什麼、結果如何都照伺服器的事件。
// 飛行只用到加減乘除，所以在不同瀏覽器 / Node 上結果位元級一致。
export function advanceProjectile(world, p, dt) {
  const speed = Math.hypot(p.vx, p.vy);
  const sub = Math.max(1, Math.ceil(speed * dt / 2));
  const h = dt / sub;
  for (let i = 0; i < sub; i++) {
    const px = p.x, py = p.y;
    p.vy += p.gravity * h;
    p.x += p.vx * h;
    p.y += p.vy * h;
    p.age += h;
    if (!world) continue;

    if (p.y > CONFIG.WATER_LEVEL) return { type: 'water', x: p.x, y: p.y, px, py };
    if (p.x < -80 || p.x > world.w + 80 || p.y < -2500) return { type: 'out', x: p.x, y: p.y, px, py };
    if (!p.passTerrain && world.terrain.isSolid(p.x, p.y)) return { type: 'terrain', x: p.x, y: p.y, px, py };

    for (const e of world.entities) {
      if (!e.alive || p.ignore.has(e) || (p.passAllies && e !== p.owner && e.team === p.owner.team)) continue;
      if (e === p.owner) {
        // 剛出砲口不會打到自己；空中開火時射手跟著往上飛，所以還沒離開過他的身體也不算打到
        if (!p.leftOwner) {
          if (e.containsPoint(p.x, p.y, p.hitRadius)) continue;
          p.leftOwner = true;
        }
        if (p.age < 0.15) continue;
      }
      if (e.containsPoint(p.x, p.y, p.hitRadius)) {
        return { type: 'entity', x: p.x, y: p.y, px, py, entity: e };
      }
    }
  }
  return null;
}

// 撞到東西之後怎麼辦（伺服器結算與瞄準預覽共用同一套規則）：
//   end = 落水 / 飛出場外；return = 迴力鏢折返；pierce = 穿過角色繼續飛；bounce = 在地形上彈射；explode = 爆炸
export function hitAction(p, hit) {
  if (hit.type === 'water' || hit.type === 'out') return 'end';
  if (p.boomerang) return 'return';
  if (hit.type === 'entity') return p.pierce ? 'pierce' : 'explode';
  return p.bouncesLeft > 0 ? 'bounce' : 'explode';
}

// 彈射：用撞擊點附近的實心像素估計地表法線（從實心的重心指向外），速度對法線鏡射，
// 並退回撞到前的位置。只用加減乘除、比較與開根號，伺服器與瀏覽器結果一致。
export function bounceProjectile(terrain, p, hit) {
  const R = 10;
  let sx = 0, sy = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy <= R * R && terrain.isSolid(hit.x + dx, hit.y + dy)) { sx += dx; sy += dy; }
    }
  }
  let nx = -sx, ny = -sy;
  const len = Math.sqrt(nx * nx + ny * ny);
  let reflected = false;
  if (len > 1e-9) {
    nx /= len;
    ny /= len;
    // 接近水平的地面 / 垂直的牆：像素階梯會讓估出來的法線歪幾度（擦地射擊就會彈錯方向），直接對齊座標軸
    if (Math.abs(nx) < 0.2) { nx = 0; ny = Math.sign(ny); }
    else if (Math.abs(ny) < 0.2) { ny = 0; nx = Math.sign(nx); }
    const dot = p.vx * nx + p.vy * ny;
    if (dot < 0) {
      p.vx -= 2 * dot * nx;
      p.vy -= 2 * dot * ny;
      reflected = true;
    }
  }
  if (!reflected) {   // 估不出合理的法線（卡在角落、縫裡）：看是垂直還是水平方向撞進去的，就翻轉那個分量
    const vBlocked = terrain.isSolid(hit.px, hit.y);
    const hBlocked = terrain.isSolid(hit.x, hit.py);
    if (vBlocked || !hBlocked) p.vy = -p.vy;
    if (hBlocked || !vBlocked) p.vx = -p.vx;
  }
  p.x = hit.px;
  p.y = hit.py;
  p.bouncesLeft--;
}

// 迴力鏢回程：沿去程記錄的點（p.path）倒著走，每幀退 speed 個點；原路走完後直線飛向角色現在的手（home），
// 距離小於一步就算接住，回傳 true。角色站著丟的話 home 就是出發點，當場接住；在空中丟的話角色可能已經掉下去了。
// home 給 null（角色已經倒下）就停在出發點。
export function stepReturn(p, speed, home, homingSpeed = 24) {
  if (p.retIdx > 0) {
    p.retIdx -= speed;
    const pt = p.path[Math.max(0, p.retIdx)];
    p.x = pt.x;
    p.y = pt.y;
    if (p.retIdx > 0) return false;
  }
  if (!home) return true;
  const dx = home.x - p.x, dy = home.y - p.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= homingSpeed) { p.x = home.x; p.y = home.y; return true; }
  p.x += dx / d * homingSpeed;
  p.y += dy / d * homingSpeed;
  return false;
}

// 模擬一發完整彈道（AI 與預覽用）。recordEvery > 0 時每 N 幀記錄一個點。
// bounces = 在地形上還能彈射幾次（蹦蹦炸彈，見 shotTraits）：照結算的規則彈開後接著飛
export function simulateShot(world, owner, weapon, angleDeg, power, maxTime = 6, recordEvery = 0, { bounces = 0 } = {}) {
  const m = owner.muzzle();
  const v = launchVelocity(weapon, angleDeg, power);
  const p = makeProjectile(owner, weapon, m.x, m.y, v.vx, v.vy);
  p.bouncesLeft = bounces;
  const points = [];
  const dt = CONFIG.FIXED_DT;
  let frame = 0;
  let hit = null;
  while (p.age < maxTime) {
    hit = advanceProjectile(world, p, dt);
    frame++;
    if (hit && hitAction(p, hit) === 'bounce') { bounceProjectile(world.terrain, p, hit); hit = null; }
    if (hit) break;
    if (recordEvery && frame % recordEvery === 0) points.push({ x: p.x, y: p.y });
  }
  return { hit: hit || { type: 'timeout', x: p.x, y: p.y }, points, frames: frame };
}

// 直線武器的瞄準線：照同一套規則（穿透角色、在地形上彈射）走到停下為止。
// 回傳折線 points（起點、每個彈射點、終點）與穿透點 pierced。只看不改世界。
export function traceShot(world, owner, weapon, angleDeg, power, { bounces = 0, pierce = false } = {}, maxTime = 2) {
  const m = owner.muzzle();
  const v = launchVelocity(weapon, angleDeg, power);
  const p = makeProjectile(owner, weapon, m.x, m.y, v.vx, v.vy);
  p.bouncesLeft = bounces;
  p.pierce = pierce;
  const points = [{ x: m.x, y: m.y }];
  const pierced = [];
  const dt = CONFIG.FIXED_DT;
  while (p.age < maxTime) {
    const hit = advanceProjectile(world, p, dt);
    if (!hit) continue;
    const act = hitAction(p, hit);
    if (act === 'pierce') { p.ignore.add(hit.entity); pierced.push({ x: hit.x, y: hit.y }); continue; }
    if (act === 'bounce') { bounceProjectile(world.terrain, p, hit); points.push({ x: p.x, y: p.y }); continue; }
    points.push({ x: hit.x, y: hit.y });
    return { points, pierced, hit };
  }
  points.push({ x: p.x, y: p.y });
  return { points, pierced, hit: { type: 'timeout', x: p.x, y: p.y } };
}

// 自己瞄準時的預覽（client/render.js 畫，測試也拿它驗）：照牌給的特性（shotTraits）算。
// 拋射武器只給前 PREVIEW.dots 個點（kind 'arc'，大砲只給方向提示；有全知之眼就給到落點）；直線武器給完整路線（kind 'line'，含彈射點、穿透點）
export function aimPreview(world, owner, weapon, angleDeg, power) {
  const traits = shotTraits(owner, weapon.id);
  if (weapon.gravity > 0) {
    const pv = CONFIG.PREVIEW;
    if (owner.mods && owner.mods.fullArc > 0) {   // 全知之眼：畫完整條拋物線，最後一點是落點（full = true）
      const r = simulateShot(world, owner, weapon, angleDeg, power, 6, pv.framesPerDot, traits);
      return { kind: 'arc', full: true, ...r, points: [...r.points, { x: r.hit.x, y: r.hit.y }] };
    }
    return { kind: 'arc', ...simulateShot(world, owner, weapon, angleDeg, power, pv.dots * pv.framesPerDot / 60, pv.framesPerDot, traits) };
  }
  return { kind: 'line', ...traceShot(world, owner, weapon, angleDeg, power, traits) };
}
