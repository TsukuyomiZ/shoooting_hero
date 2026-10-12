import { CONFIG } from '../core/config.js';
import { canFire } from './ai.js';

// 敵人走動（2026-10-08 使用者：所有敵人都要會走動，不然玩家永遠瞄同一個地方就好）。只在伺服器算（AI 回合，Match.planAiTurn 呼叫），
// 客戶端照廣播重播。參數在 CONFIG.AI_MOVE；每種敵人走不走看自己的 moveChance。
//
// - 走路（一般敵人、狙擊手、砲兵、樹妖；斷線代打的玩家也是）：站在地上的角色往一個方向走一段（AI_MOVE.dist px，照自己的速度換成幾幀，
//   最多 maxFrames 幀），廣播 walk = { dir, frames, fall }，客戶端照樣按著方向走 frames 幀、再放開方向鍵跑 fall 幀
//   （停下來時還在半空中：剛走下小台階、前面不安全或體力用完的那一刻腳還沒著地，落到站穩為止；平常 0）——同一套物理，走到的地方一樣，
//   開火前一定站在地上。斷線代打的玩家路上碰到的道具（火把、蛇血）照地圖機制的 moved 撿，跟自己走過去一樣（見 Match.simulateWalk）。
//   每一幀走之前先看前面（canStep），不安全就停：前方那一行要有地面 / 平台、往下最多 maxDrop px、而且在水面上方
//   （不會走進水裡、走下懸崖、走出樹枝 / 石柱）；同一層的同伴（蜂巢、蜜蜂不算）中心要隔 allyGap px 以上；不會走進別人身體裡。
// - 飄移（fixed 的角色沒有物理：蝙蝠、獨眼巨人）：角色身上有 roam（活動範圍，見 roamAround / groundRoam）才會動。
//   直線挪到附近一點，廣播 glide = { dx, dy, frames }（dx、dy 是整數 px），伺服器直接放到終點，客戶端照 glideAt 逐幀內插、最後一幀剛好到終點。
//   路上每 2 px 檢查一次：身體（含 pad）不碰任何地形（含平台、鐘乳石）、不碰別的角色、在活動範圍裡；
//   走在地上的（巨人，roam.ground）只左右走，腳下兩邊一直都要踩著實心地形（走不出自己那根岩柱）。終點離同伴也要 allyGap 以上。
//
// 挑停在哪裡（越前面越優先）：
//   1. 站在那裡自己開得了火、本來開得了火的同伴也還開得了火（只有直線武器的狙擊手 / 蝙蝠不會走到被同伴擋住、或擋住同伴的地方，見 ai.js 的 canFire），
//      走得完想走的距離（沒有半路被邊緣 / 同伴擋下來：不會每次都停在同一個邊上），而且不是回到上一次出發的地方附近；
//   2. 同上但半路被擋下來、或回到附近（還是走得到 minDist）；3. 開得了火、走不到 minDist（窄的樹枝上走多少算多少）；
//   4. 會擋住同伴的射線（自己開得了火）：還是走（同伴自己的回合會再挪開）；
//   5. 每個停點自己都開不了火：原地開得了火就這回合不動，不然照樣走。
// 方向：走路與巨人多半沿著上一回合的方向（keepDir），那邊不夠好才回頭；走路兩邊都走不到 minDist（被同伴夾住）才放寬成只要不碰到同伴的身體。
// 蝙蝠隨機挑幾個方向（glideTries），第一個第 1 級的就用，不然用最好的。
// 這些記在角色身上（aiWalkDir、aiFrom），只有伺服器用，不同步

export const LAND_FRAMES = 30;   // 走滿了還在半空中（剛走下小台階）：最多再多走幾幀到落地（客戶端照總幀數重播）
export const FALL_FRAMES = 120;  // 走路停下來時還在半空中（前面不安全 / 體力用完 / 多走的幀數也用完）：放開方向鍵最多再落幾幀到站穩（walk.fall）
const WALK_CUTS = [1, 0.75, 0.5, 0.25];   // 走路試幾種長度（想走的幀數 × 這些）：走到底會擋到射線時，走短一點

// 角色 e 再往 dir 走一步安不安全（AI 走路每一幀都先問這個；客戶端不用：照伺服器算好的幀數重播）。
// allyGap = 這一步走完離前面的同伴至少要多遠（預設 AI_MOVE.allyGap；被夾住時 planWalk 放寬成只要不碰到身體）
export function canStep(match, e, dir, allyGap = CONFIG.AI_MOVE.allyGap) {
  const A = CONFIG.AI_MOVE;
  const t = match.terrain;
  const px = e.x + dir * (e.hw + A.edge);
  if (px < e.hw || px > t.maxX - e.hw) return false;
  // 前方那一行的地面：從腳底上方 climbMax（爬得上去的高度）往下找到 maxDrop
  let ground = null;
  for (let k = -e.climbMax; k <= A.maxDrop && ground === null; k++) {
    if (t.isSolid(px, e.y + k) || t.isPlatform(px, e.y + k)) ground = e.y + k;
  }
  if (ground === null || ground > CONFIG.WATER_LEVEL - CONFIG.WATER.safeMargin) return false;
  // 前面（同一層）有人：這一步走完同伴還隔 allyGap，其他人不要走進他身體裡
  const stride = e.moveSpeed * CONFIG.FIXED_DT;
  for (const o of match.entities) {
    if (o === e || o.id === e.id || !o.alive || o.allyPass) continue;
    const ahead = (o.x - e.x) * dir;
    if (ahead <= 0 || !(o.y - o.h < e.y && e.y - e.h < o.y)) continue;
    const body = e.hw + o.hw + 2;
    if (ahead - stride < (o.team === e.team ? Math.max(allyGap, body) : body)) return false;
  }
  return true;
}

// 走路：要走的話已經走完（match.simulateWalk 推進整場），回傳 { dir, frames, fall }（代打的玩家路上撿到道具再帶 pickups）；不走 / 走不動回傳 null
export function planWalk(match, actor) {
  const A = CONFIG.AI_MOVE;
  const rng = match.rng;
  if (!rng.chance(actor.ai ? actor.ai.moveChance : A.takeoverChance)) return null;
  if (actor.fixed || !(actor.moveSpeed > 0) || actor.onVine >= 0 || !actor.onGround) return null;
  const want = rng.range(A.dist[0], A.dist[1]);
  const frames = Math.max(1, Math.min(A.maxFrames, Math.round(want / actor.moveSpeed * 60)));
  const last = actor.aiWalkDir || 0;
  const first = last && rng.chance(A.keepDir) ? last : (rng.chance(0.5) ? -1 : 1);
  const goal = Math.min(A.minDist, want);
  const fire = fireCheck(match, actor);
  // 拿分身試走（只動分身自己，跟真的走一樣的物理與停下來的條件）：每個方向從最長的開始試，第 1 級的就是這個方向的停點；
  // 走到底會半路被擋下來（窄的石柱、樹枝）時，短一點的常常走得完 → 停在中間，不會每次都停在同一個邊上
  let pick = null;
  for (const gap of [A.allyGap, 0]) {
    for (const dir of [first, -first]) {
      for (const cut of WALK_CUTS) {
        const f = Math.max(1, Math.round(frames * cut));
        const g = ghostOf(actor);
        const n = match.simulateWalk(g, dir, f, true, gap).frames;
        const d = Math.abs(g.x - actor.x);
        if (d < 1) break;
        // n < f = 半路就被擋下來（走到邊上 / 同伴前面）
        pick = better(pick, { dir, f, gap, d, tier: tierOf(fire(g.x, g.y), d, goal, n < f) });
        if (pick.tier === 1) break;
      }
      if (pick && pick.tier === 1) break;
    }
    if (pick && pick.tier <= 2) break;   // 走得到 minDist（自己與同伴都開得了火）：不用放寬
  }
  if (!pick || (pick.tier === 5 && fire(actor.x, actor.y) < 2)) return null;
  const w = match.simulateWalk(actor, pick.dir, pick.f, false, pick.gap);
  actor.aiWalkDir = pick.dir;
  // pickups = 斷線代打的玩家路上撿到的道具（點燃火把、喝到蛇血），裁判拿出來另外廣播 / 記錄
  return w.frames > 0 ? { dir: pick.dir, frames: w.frames, fall: w.fall, ...(w.pickups.length ? { pickups: w.pickups } : {}) } : null;
}

// 飄移：要動的話已經放到終點，回傳 { dx, dy, frames }；沒有 roam / 不動 / 找不到地方回傳 null
export function planGlide(match, actor) {
  const R = actor.roam;
  if (!R || !actor.alive) return null;
  const A = CONFIG.AI_MOVE;
  const rng = match.rng;
  if (!rng.chance(R.chance ?? 1)) return null;
  const x0 = actor.x, y0 = actor.y;
  const want = rng.range(A.dist[0], A.dist[1]);
  const goal = Math.min(A.minDist, want);
  const from = actor.aiFrom;
  const fire = fireCheck(match, actor);
  // 沿著方向 (ux, uy) 走：路上每 2 px 都要可以，走到不行就停；從最遠的往回挑最好的停點 { dx, dy, d, tier }（整數 px）
  const reach = (ux, uy) => {
    const pts = [];
    let blocked = false;   // 半路就被擋下來（走到活動範圍的邊上、碰到地形 / 別人）
    for (let s = 2; s <= want; s += 2) {
      const dx = Math.round(ux * s), dy = Math.round(uy * s);
      if (!glideOk(match, actor, x0 + dx, y0 + dy)) { blocked = true; break; }
      if ((dx || dy) && allyRoom(match, actor, x0 + dx, y0 + dy)) pts.push({ dx, dy, d: Math.hypot(dx, dy) });
    }
    let best = null;
    for (let i = pts.length - 1; i >= 0 && !(best && best.tier === 1); i--) {
      const p = pts[i];
      const back = from && Math.hypot(x0 + p.dx - from.x, y0 + p.dy - from.y) < goal;
      const tier = tierOf(fire(x0 + p.dx, y0 + p.dy), p.d, goal, back || blocked);
      if (tier >= 4 && best && best.tier <= tier) continue;
      best = better(best, { ...p, tier });
    }
    return best;
  };
  let pick = null;
  if (R.ground) {
    // 走在地上：只左右。多半沿著上一回合的方向，那邊不夠好就回頭
    const last = actor.aiWalkDir || 0;
    const first = last && rng.chance(A.keepDir) ? last : (rng.chance(0.5) ? -1 : 1);
    pick = better(reach(first, 0), null);
    if (!pick || pick.tier > 1) pick = better(pick, reach(-first, 0));
  } else {
    // 飄在空中：隨機挑幾個方向，第一個第 1 級的就用，不然用最好的
    for (let k = 0; k < A.glideTries && !(pick && pick.tier === 1); k++) {
      const ang = rng.float() * Math.PI * 2;
      pick = better(pick, reach(Math.cos(ang), Math.sin(ang)));
    }
  }
  if (!pick || (pick.tier === 5 && fire(x0, y0) < 2)) return null;   // 四周都沒地方去（被夾住），或去哪裡都會擋到射線
  const frames = Math.max(1, Math.round(pick.d / R.speed * 60));
  actor.aiFrom = { x: x0, y: y0 };
  if (pick.dx) actor.aiWalkDir = actor.facing = Math.sign(pick.dx);
  actor.x = x0 + pick.dx;
  actor.y = y0 + pick.dy;
  actor.movedThisTurn += pick.d;   // 跟走路一樣算移動的距離（回合結束甩掉燃燒層數，見 Match.burnTick；只有伺服器算）
  return { dx: pick.dx, dy: pick.dy, frames };
}

// 飄移第 i 幀（1..frames）的位置：從 (x0, y0) 沿直線緩入緩出到 (x0 + dx, y0 + dy)，最後一幀剛好到終點（跟伺服器放的一樣）
export function glideAt(x0, y0, g, i) {
  const t = Math.min(1, i / g.frames);
  const s = t * t * (3 - 2 * t);
  return { x: x0 + g.dx * s, y: y0 + g.dy * s };
}

// 蝙蝠這種飄在空中的：出生點 (x, y) 周圍 ±def.roam.x / ±def.roam.y 的框框（Match 建敵人時呼叫；種類沒寫 roam = 不飄）
export function roamAround(def, x, y) {
  if (!def.roam) return null;
  return { x0: x - def.roam.x, x1: x + def.roam.x, y0: y - def.roam.y, y1: y + def.roam.y, speed: def.roam.speed, pad: def.roam.pad ?? 6, chance: def.moveChance ?? 0 };
}

// 站在地上、但沒有物理的（獨眼巨人）：沿著腳下的實心地形左右走，兩邊各留 w.edge px 不走到邊上（w = null 就不走）
export function groundRoam(w) {
  if (!w) return null;
  return { ground: true, x0: -Infinity, x1: Infinity, y0: -Infinity, y1: Infinity, speed: w.speed, edge: w.edge ?? 4, chance: w.chance ?? 1 };
}

// ---------- 小工具 ----------

// 兩個停點哪個好：級數小的贏（見檔案開頭），同級走得遠的贏；一樣就留先找到的
function better(a, b) {
  if (!a) return b;
  if (!b) return a;
  return b.tier < a.tier || (b.tier === a.tier && b.d > a.d) ? b : a;
}

// 停點的級數（見檔案開頭）：fire = fireCheck 的結果，d = 走多遠，worse = 半路被擋下來 / 回到上一次出發的地方附近
function tierOf(fire, d, goal, worse) {
  if (fire === 2) return 5;   // 自己開不了火
  if (fire === 1) return 4;   // 擋住本來開得了火的同伴
  return d < goal ? 3 : worse ? 2 : 1;
}

// 回傳 (x, y) → 角色站到那裡之後：0 = 自己開得了火、本來開得了火的同伴也都還開得了火；1 = 自己可以，但擋在同伴的射線上；
// 2 = 自己開不了火。暫時把角色放過去問 ai.js 的 canFire（不用亂數），問完放回來
function fireCheck(match, actor) {
  const world = match.world;
  const allies = match.entities.filter(o => o !== actor && o.alive && o.team === actor.team && !o.allyPass && !o.noTurn && canFire(world, o));
  return (x, y) => {
    const ox = actor.x, oy = actor.y;
    actor.x = x;
    actor.y = y;
    try {
      if (!canFire(world, actor)) return 2;
      return allies.every(o => canFire(world, o)) ? 0 : 1;
    } finally {
      actor.x = ox;
      actor.y = oy;
    }
  };
}

// 分身：同一個角色的淺層複本（試走用；物理只改它自己的欄位，不會動到本尊）
function ghostOf(e) {
  return Object.assign(Object.create(Object.getPrototypeOf(e)), e);
}

// 飄移的角色腳底放在 (x, y) 可不可以：在活動範圍、畫面裡、水面上；身體（加 pad）不碰任何地形；
// 走在地上的腳下兩邊（含 edge）都踩著實心地形、身體只檢查到腳底上面 2 px（站著的那一排本來就貼著地）；不碰別的角色
function glideOk(match, e, x, y) {
  const R = e.roam, t = match.terrain;
  if (x < R.x0 || x > R.x1 || y < R.y0 || y > R.y1) return false;
  if (x < e.hw || x > t.maxX - e.hw || y - e.h < 0 || y > CONFIG.WATER_LEVEL - CONFIG.WATER.safeMargin) return false;
  const pad = R.ground ? 0 : R.pad;
  const xa = x - e.hw - pad, xb = x + e.hw + pad, ya = y - e.h - pad, yb = R.ground ? y - 2 : y + pad;
  for (let yy = ya; ; yy = Math.min(yy + 3, yb)) {
    for (let xx = xa; ; xx = Math.min(xx + 3, xb)) {
      if (t.at(xx, yy) !== 0) return false;
      if (xx >= xb) break;
    }
    if (yy >= yb) break;
  }
  if (R.ground) {
    const fa = x - e.hw - R.edge, fb = x + e.hw + R.edge;
    for (let fx = fa; ; fx = Math.min(fx + 4, fb)) {
      if (!t.isSolid(fx, y + 1)) return false;
      if (fx >= fb) break;
    }
  }
  for (const o of match.entities) {
    if (o === e || o.id === e.id || !o.alive) continue;
    if (Math.abs(o.x - x) < o.hw + e.hw + 4 && o.y - o.h - 4 < y && y - e.h < o.y + 4) return false;
  }
  return true;
}

// 終點離同伴（蜂巢、蜜蜂不算）至少 allyGap
function allyRoom(match, e, x, y) {
  const gap = CONFIG.AI_MOVE.allyGap;
  return !match.entities.some(o => o !== e && o.id !== e.id && o.alive && o.team === e.team && !o.allyPass &&
    Math.hypot(o.x - x, (o.y - o.h / 2) - (y - e.h / 2)) < gap);
}
