import { CONFIG } from '../core/config.js';
import { makeProjectile } from './projectile.js';
import { effectSum, effectAny } from '../cards/effects/index.js';

// 飛行物的形狀在 projectile.js（效果也要建飛行物，放這裡會變成循環 import），這裡照樣匯出
export { makeProjectile };

// 能放進武器欄的武器（裝備產生的攻擊，例如轟炸飛彈，與 Boss / 樹妖專用的攻擊、地形掉下來的鐘乳石不算）
export function isEquippable(id) {
  const w = CONFIG.WEAPONS[id];
  return !!w && !w.fromEquip && !w.enemyOnly && !w.hazard;
}

// 依角度與力量算出初速度：有 speedPerPower 的武器（大砲等拋射武器）看力量，其他用固定的 speed（狙擊槍、飛鏢…）
export function launchVelocity(weapon, angleDeg, power) {
  const rad = angleDeg * Math.PI / 180;
  const speed = weapon.speedPerPower !== undefined
    ? weapon.minSpeed + power * weapon.speedPerPower
    : weapon.speed;
  return { vx: Math.cos(rad) * speed, vy: -Math.sin(rad) * speed };
}

// 這一發最長飛多遠（飛過的路徑長度，px）：看力量的 rangeMin + 力量 × rangePerPower（迴力鏢：到了就折返），
// 或固定的 range（高壓水炮：到了就消散）；都沒有 = 不限。開火結算、AI 試射、瞄準預覽都照這個設 p.range
export function shotRange(weapon, power) {
  if (weapon.rangePerPower !== undefined) return weapon.rangeMin + power * weapon.rangePerPower;
  return weapon.range ?? Infinity;
}

// 後座力（例如高壓水炮）：開火的當下射手被往射擊的反方向推 recoil（跟被擊退同一套，見 Entity.knockBack）。
// vx / vy = 這一發的初速（伺服器算的、跟著 shot 送給客戶端的同一組數字）；水平速度從 0 算起（重播擺射手時也是 0），兩邊結果一致
export function applyRecoil(actor, weapon, vx, vy) {
  if (!(weapon.recoil > 0) || actor.fixed) return;
  const sp = Math.sqrt(vx * vx + vy * vy);
  if (!(sp > 0)) return;
  actor.vx = 0;
  actor.knockBack(-vx / sp, -vy / sp, weapon.recoil);
}

// 效果給這把武器的飛行物特性：在地形上彈射幾次（例如哈哈子彈、蹦蹦炸彈）、穿透角色（例如高倍率望遠鏡），見 shared/cards/effects/ 的 bounces / pierce。
// 伺服器結算、瞄準預覽、AI 試射都照這個，三邊才一致
export function shotTraits(owner, weaponId) {
  const m = owner && owner.mods;
  if (!m) return { bounces: 0, pierce: false };
  const c = { weaponId };
  return { bounces: effectSum('bounces', owner, c), pierce: effectAny('pierce', owner, c) };
}

// 爆炸半徑：武器的半徑 × 效果的加成（radius 槽，最小 0.2 倍；沒有攻擊者 = 原本的半徑）。
// Match 的挖地形與波及範圍、AI 判斷會不會炸到隊友 / 蜂巢都照這個
export function blastRadius(owner, weapon) {
  const pct = owner ? effectSum('radius', owner, { weaponId: weapon.id }) : 0;
  return weapon.radius * Math.max(0.2, 1 + pct / 100);
}

// 這顆飛行物撞不撞得到 e（不看位置）：倒下的、已經穿透過 / 不會再撞到的（p.ignore）、自己人的子彈會穿過去的都不算
function canHit(p, e) {
  if (!e.alive || p.ignore.has(e) || (p.passAllies && e !== p.owner && e.team === p.owner.team)) return false;
  if (e.allyPass && p.owner && e !== p.owner && e.team === p.owner.team) return false;   // 蜂巢、蜜蜂：自己人的子彈穿過去
  return true;
}

// 讓飛行物前進 dt 秒（每 2px 一個子步避免穿透）。回傳撞擊事件或 null；
// 撞擊事件的 px/py 是撞到前最後一個不在實心裡的位置（彈射用）。
// 飛過的路徑長度記在 p.dist，到了 p.range（見 shotRange）就回傳 range（迴力鏢折返、高壓水炮消散）。
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
    // 平台是別隊的掩體時（小心擊發的樹枝）平台也擋，見 Terrain.blocksShot
    if (!p.passTerrain && world.terrain.blocksShot(p.x, p.y, p.owner && p.owner.team)) return { type: 'terrain', x: p.x, y: p.y, px, py };

    for (const e of world.entities) {
      if (!canHit(p, e)) continue;
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
    if (p.range < Infinity) {   // 有最長路徑的（迴力鏢、高壓水炮）：這一個子步之後到了就停
      p.dist += Math.sqrt((p.x - px) * (p.x - px) + (p.y - py) * (p.y - py));
      if (p.dist >= p.range) return { type: 'range', x: p.x, y: p.y, px, py };
    }
  }
  return null;
}

// 撞到東西之後怎麼辦（伺服器結算與瞄準預覽共用同一套規則）：
//   end = 落水 / 飛出場外 / 飛到最長路徑（高壓水炮消散）；return = 迴力鏢折返（到了最長路徑，或先撞到地形 / 落水 / 飛出場外）；
//   pierce = 穿過角色繼續飛（迴力鏢一律穿過）；bounce = 在地形上彈射；explode = 爆炸
export function hitAction(p, hit) {
  if (p.boomerang) return hit.type === 'entity' ? 'pierce' : 'return';
  if (hit.type === 'water' || hit.type === 'out' || hit.type === 'range') return 'end';
  if (hit.type === 'entity') return p.pierce ? 'pierce' : 'explode';
  return p.bouncesLeft > 0 ? 'bounce' : 'explode';
}

// 迴力鏢回程：這一幀從 (x0, y0) 走到現在的位置（stepReturn 之後），路上碰到的角色，照碰到的順序（每 2px 檢查一次）。
// 不看地形（原路走回來）；自己、隊友、這一趟（回程）已經打過的（p.ignore）不算。只有伺服器呼叫：客戶端照事件播
export function sweepReturn(world, p, x0, y0) {
  const dx = p.x - x0, dy = p.y - y0;
  const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / 2));
  const hits = [];
  const seen = new Set();
  for (let k = 0; k <= n; k++) {
    const x = x0 + dx * k / n, y = y0 + dy * k / n;
    for (const e of world.entities) {
      if (e === p.owner || seen.has(e) || !canHit(p, e) || !e.containsPoint(x, y, p.hitRadius)) continue;
      seen.add(e);
      hits.push({ type: 'entity', x, y, px: x, py: y, entity: e });
    }
  }
  return hits;
}

// 彈射：用撞擊點附近的實心像素估計地表法線（從實心的重心指向外），速度對法線鏡射，
// 並退回撞到前的位置。只用加減乘除、比較與開根號，伺服器與瀏覽器結果一致。
// 「實心」照飛行物撞到的那一套（Terrain.blocksShot：別隊的掩體平台也算）
export function bounceProjectile(terrain, p, hit) {
  const team = p.owner && p.owner.team;
  const solid = (x, y) => terrain.blocksShot(x, y, team);
  const R = 10;
  let sx = 0, sy = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy <= R * R && solid(hit.x + dx, hit.y + dy)) { sx += dx; sy += dy; }
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
    const vBlocked = solid(hit.px, hit.y);
    const hBlocked = solid(hit.x, hit.py);
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
  p.range = shotRange(weapon, power);
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

// 直線武器的瞄準線：照同一套規則（穿透角色、在地形上彈射、最長路徑）走到停下為止。
// 回傳折線 points（起點、每個彈射點、終點；有一點重力的（飛鏢）每 2 幀多一個點，線才會跟著往下彎）、彈射點 bounced 與穿透點 pierced。
// 只看不改世界。
export function traceShot(world, owner, weapon, angleDeg, power, { bounces = 0, pierce = false } = {}, maxTime = 2) {
  const m = owner.muzzle();
  const v = launchVelocity(weapon, angleDeg, power);
  const p = makeProjectile(owner, weapon, m.x, m.y, v.vx, v.vy);
  p.bouncesLeft = bounces;
  p.pierce = pierce;
  p.range = shotRange(weapon, power);
  const points = [{ x: m.x, y: m.y }];
  const pierced = [];
  const bounced = [];
  const dt = CONFIG.FIXED_DT;
  let frame = 0;
  while (p.age < maxTime) {
    const hit = advanceProjectile(world, p, dt);
    frame++;
    if (!hit) {
      if (p.gravity > 0 && frame % 2 === 0) points.push({ x: p.x, y: p.y });
      continue;
    }
    const act = hitAction(p, hit);
    if (act === 'pierce') { p.ignore.add(hit.entity); pierced.push({ x: hit.x, y: hit.y }); continue; }
    if (act === 'bounce') {
      bounceProjectile(world.terrain, p, hit);
      points.push({ x: p.x, y: p.y });
      bounced.push({ x: p.x, y: p.y });
      continue;
    }
    points.push({ x: hit.x, y: hit.y });
    return { points, pierced, bounced, hit };
  }
  points.push({ x: p.x, y: p.y });
  return { points, pierced, bounced, hit: { type: 'timeout', x: p.x, y: p.y } };
}

// 自己瞄準時的預覽（client/render.js 畫，測試也拿它驗）：照效果給的特性（shotTraits）算。
// 看力量的拋射武器（有 speedPerPower：大砲、迴力鏢…）只給前 PREVIEW.dots 個點（kind 'arc'，只給方向提示；效果的 previewFull（全知之眼）就給到落點）；
// 速度固定的武器（狙擊槍、飛鏢、高壓水炮）給完整路線（kind 'line'，含彈射點、穿透點，停在最長路徑）
export function aimPreview(world, owner, weapon, angleDeg, power) {
  const traits = shotTraits(owner, weapon.id);
  if (weapon.speedPerPower !== undefined) {
    const pv = CONFIG.PREVIEW;
    if (owner.mods && effectAny('previewFull', owner, { weaponId: weapon.id })) {   // 畫完整條拋物線，最後一點是落點（full = true）
      const r = simulateShot(world, owner, weapon, angleDeg, power, 6, pv.framesPerDot, traits);
      return { kind: 'arc', full: true, ...r, points: [...r.points, { x: r.hit.x, y: r.hit.y }] };
    }
    return { kind: 'arc', ...simulateShot(world, owner, weapon, angleDeg, power, pv.dots * pv.framesPerDot / 60, pv.framesPerDot, traits) };
  }
  return { kind: 'line', ...traceShot(world, owner, weapon, angleDeg, power, traits) };
}
