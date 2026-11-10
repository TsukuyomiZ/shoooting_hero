import { weightedPick, stillResult } from './mechanics/common.js';

// 指名（通用，2026-11-09 使用者：王不要站樁；古樹之庭先做、叢林巨蟒接著用，見 GLOSSARY.md 的「指名」）：
// 王每次行動的最後（自己的回合、插話行動，見 Match.interjectBefore）指名「接下來到它下一次行動之前會輪到的玩家」
// （Match.upcomingPlayers：活著、沒被綁著的），每人各抽一招存在 S.marks。被指名的人一定在中招之前輪到自己的回合：
// 回合一開始那一招的範圍（S.zone，照他回合開始時站的位置）出現，delay 秒後發動（伺服器多等 grace），那時身體還碰到才算中——
//   一般的招：中了就扣血 / 上狀態（spec.strike）
//   綁人的招（spec.binds）：綁住（S.bound，Entity.held：走不動、跳不起來、還能開火），綁住的那一下扣一次（spec.squeeze），
//     之後他還在操作的時候每 tick 秒一次（開火之後的結算不扣），之後每個自己的回合一開始也先扣一次；
//     只能自己的回合連打 A / D（左右交替）need 下掙脫，不扣體力
//   回合在發動之前就收尾（開火結算完、超時）：收尾時馬上發動（還站在那裡就中）
//
// 地圖機制的狀態（match.mechState）要有這四個欄位：marks { [pid]: kind }、bound { [pid]: { count（這回合連打了幾下）, last（上一下哪一邊）, n（這回合扣了第幾下）} }、
// zone（伺服器：這回合正在冒的那一招 { id, kind, fireAt, ...spec.zone 給的範圍 }）、tick（伺服器：綁著的人下一次扣血 { id, next, owed }）。
// 每張地圖一份 spec（見 tree-boss.js 的 TREE_MARKS、snake-boss.js 的 SNAKE_MARKS）：
//   state(match) → S | null              這一場的狀態（別張地圖 = null）
//   boss(match) → Entity | null          出手的王（倒下了就不再發動、不再扣）
//   config() → { weights, delay, delays?, grace, tick, need, cast }   數值（weights 全 0 = 不指名；delays = 每招自己的發動秒數，沒寫照 delay）
//   zone(match, e, kind) → object        回合開始：這一招的範圍（只放數字：原封不動傳給客戶端畫）
//   hits(zone, p, match) → boolean       發動那一刻碰不碰得到 p
//   binds(kind) → boolean                這一招中了是綁住
//   strike(match, zone, p, boss) → damages   不綁的招中了（自己呼叫 applyExplosion）
//   squeeze(match, p, rec, boss) → damages   綁著的人扣一次（rec.n = 這個回合第幾下，從 1 開始）
//   moveTo?(match, zone, p) → { x, y } | null   （可以不寫）不綁的招中了、他還活著：把他移到這裡（Match.relocate，例如蓋亞的大地之手），
//                                         hazard 帶 moved [{ id, x, y }] 給客戶端套

/** 這一招回合開始幾秒後發動：config().delays[kind]（每招自己的，例如巨蟒的突咬 2.5 秒）沒寫就照 config().delay */
export const delayOf = (M, kind) => (M.delays && Number.isFinite(M.delays[kind]) ? M.delays[kind] : M.delay);

/** 空的指名狀態（地圖機制的 build 接在自己的狀態裡） */
export const freshMarks = () => ({ marks: {}, bound: {}, zone: null, tick: null });

/**
 * 指名：afterId 之後、王下一次行動之前會輪到的玩家（沒被綁著的），每人各抽一招（config().weights）。
 * 回傳那一招 { action: 'mark', targetIds, kinds（跟 targetIds 一一對應）, cast, still }，沒有人可以指名 = null
 */
export function markStep(match, spec, afterId) {
  const S = spec.state(match);
  const M = spec.config();
  const options = Object.entries(M.weights);
  if (!S || !options.some(([, w]) => w > 0)) return null;
  const targets = match.upcomingPlayers(afterId).filter(p => !S.bound[p.id]);
  if (!targets.length) return null;
  const kinds = targets.map(p => {
    const kind = weightedPick(match.rng, options) || options[0][0];
    S.marks[p.id] = kind;
    return kind;
  });
  return { action: 'mark', targetIds: targets.map(p => p.id), kinds, cast: M.cast, still: stillResult(match) };
}

/**
 * 被綁著的人跟場面對齊：倒下了 → 放開（指名也清掉）；綁著的人走不動（Entity.held）。
 * 伺服器在一波結算完（cascade）、綁住 / 掙脫之後，客戶端在畫面每一步與快照之後都叫
 */
export function syncMarks(match, spec) {
  const S = spec.state(match);
  if (!S || !S.bound) return;
  for (const pid of Object.keys(S.bound)) { const p = match.byId(pid); if (!p || !p.alive) delete S.bound[pid]; }
  for (const pid of Object.keys(S.marks)) { const p = match.byId(pid); if (!p || !p.alive) delete S.marks[pid]; }
  for (const p of match.players) p.held = !!S.bound[p.id];
}

/**
 * 玩家 e 的回合開始（地圖機制的 hazardStart，now = 裁判的時鐘 ms）：被指名了 → 那一招的範圍出現（delay + grace 秒後判定）；
 * 被綁著 → 連打數、扣到第幾下重算，這回合一開始先扣一次（下一個 hazardStep）。
 * 回傳 { kind: 'marks', bound（現在被綁著的人：客戶端照這份對齊）, zone（{ ...spec.zone 的範圍, id, kind, delay }）, boundTurn（他被綁著）}，都沒有 = null
 */
export function marksHazardStart(match, spec, e, now) {
  const S = spec.state(match);
  if (!S || !S.bound) return null;
  S.zone = null;
  S.tick = null;
  const boss = spec.boss(match);
  if (!e || !e.isPlayer || !e.alive || !boss || !boss.alive) return null;
  const M = spec.config();
  const out = { kind: 'marks', bound: Object.keys(S.bound) };
  const kind = S.marks[e.id];
  if (kind) {
    delete S.marks[e.id];
    const zone = spec.zone(match, e, kind);
    const delay = delayOf(M, kind);
    S.zone = { ...zone, id: e.id, kind, fireAt: now + (delay + M.grace) * 1000 };
    out.zone = { ...zone, id: e.id, kind, delay };
  }
  const rec = S.bound[e.id];
  if (rec) {
    Object.assign(rec, { count: 0, last: 0, n: 0 });
    S.tick = { id: e.id, next: now, owed: true };
    out.boundTurn = e.id;
  }
  return out.zone || out.boundTurn || out.bound.length ? out : null;
}

/**
 * 推進到 now（地圖機制的 hazardStep）：時間到了（或回合要收尾 flush）那一招發動、判定中了沒；綁著的人扣血
 * （綁住的那一下、回合一開始各一次，之後 active（他還在操作）時每 tick 秒一次）。
 * 回傳 { kind: 'marks', damages, done（沒有要發動的、沒有綁著要扣的了）, notify,
 *   fired（{ ...範圍, id, kind, hit, active（發動的時候他還在操作：還沒開火、不是收尾）}：這一次發動的）, ticks（這一次扣了誰）, bound,
 *   moved（spec.moveTo 移走的人 [{ id, x, y }]，沒有就不帶）}
 */
export function marksHazardStep(match, spec, now, flush = false, active = true) {
  const S = spec.state(match);
  if (!S || !S.bound || (!S.zone && !S.tick)) return null;
  const boss = spec.boss(match);
  if (!boss || !boss.alive) {
    S.zone = null;
    S.tick = null;
    return { kind: 'marks', damages: [], done: true, notify: false };
  }
  const M = spec.config();
  const interval = M.tick * 1000;
  const damages = [];
  const ticks = [];
  const squeeze = (p) => {
    const rec = S.bound[p.id];
    rec.n = (rec.n || 0) + 1;
    damages.push(...spec.squeeze(match, p, rec, boss));
    ticks.push(p.id);
  };
  let fired = null;
  const moved = [];
  const z = S.zone;
  if (z && (flush || now >= z.fireAt)) {
    S.zone = null;
    const p = match.byId(z.id);
    const hit = !!p && p.alive && spec.hits(z, p, match);
    const { fireAt, ...where } = z;   // 給客戶端的：範圍（沒收到回合開始的話照這個補畫）+ 中了沒
    fired = { ...where, hit, active: !!active && !flush };
    if (hit && !spec.binds(z.kind)) {
      damages.push(...spec.strike(match, z, p, boss));
      const to = p.alive && spec.moveTo ? spec.moveTo(match, z, p) : null;
      if (to) {
        match.relocate(p, to.x, to.y);
        moved.push({ id: p.id, x: p.x, y: p.y });
      }
    }
    if (hit && spec.binds(z.kind)) {
      S.bound[p.id] = { count: 0, last: 0, n: 0 };
      p.moveDir = 0;
      p.wantJump = false;
      syncMarks(match, spec);
      squeeze(p);   // 綁住的那一下
      S.tick = p.alive ? { id: p.id, next: now + interval, owed: false } : null;
    }
  }
  const t = S.tick;
  if (t) {
    const p = match.byId(t.id);
    if (!p || !p.alive || !S.bound[t.id]) S.tick = null;
    else {
      if (t.owed) {   // 回合一開始的那一下（AI 代打馬上就開火了也照扣）
        t.owed = false;
        squeeze(p);
        t.next = now + interval;
      }
      if (flush || !p.alive) S.tick = null;   // 回合收尾：這回合不再扣
      else if (!active) t.next = Math.max(t.next, now);   // 開火之後的結算不扣（回到操作，例如飛鏢的下一支，接著扣）
      else while (now >= t.next && p.alive && S.bound[p.id]) { squeeze(p); t.next += interval; }
    }
  }
  syncMarks(match, spec);
  return {
    kind: 'marks', damages, done: !S.zone && !S.tick, notify: !!fired || ticks.length > 0,
    ...(fired ? { fired } : {}), ...(ticks.length ? { ticks } : {}), bound: Object.keys(S.bound), ...(moved.length ? { moved } : {}),
  };
}

/**
 * 被綁著的人掙扎一下（地圖機制的 struggle，dir = -1 / 1）：同一邊連按不算，算數的第 need 下掙脫（不扣體力）。
 * 回傳 { ok, reason, count, need, freed }；沒被綁著 = null
 */
export function marksStruggle(match, spec, e, dir) {
  const S = spec.state(match);
  const rec = S && S.bound && S.bound[e.id];
  if (!rec) return null;
  const need = spec.config().need;
  if (dir === rec.last) return { ok: false, reason: 'sameDir', count: rec.count, need };
  rec.last = dir;
  rec.count++;
  if (rec.count < need) return { ok: true, count: rec.count, need };
  delete S.bound[e.id];
  if (S.tick && S.tick.id === e.id) S.tick = null;
  syncMarks(match, spec);
  return { ok: true, count: need, need, freed: true };
}

// ---------- 快照 / 客戶端 ----------

/** 快照帶的：被指名的人、被綁著的人（連打數） */
export function marksSnapshot(S) {
  const bound = {};
  for (const [pid, r] of Object.entries(S.bound)) bound[pid] = { count: r.count, last: r.last };
  return { marks: { ...S.marks }, bound };
}

/** 套用快照（marks / bound 沒帶就不動） */
export function restoreMarks(match, spec, marks, bound) {
  const S = spec.state(match);
  if (!S) return;
  if (marks !== undefined) S.marks = { ...(marks || {}) };
  if (bound !== undefined) {
    S.bound = {};
    for (const [pid, r] of Object.entries(bound || {})) S.bound[pid] = { count: r.count | 0, last: r.last | 0, n: 0 };
  }
  syncMarks(match, spec);
}

/** 客戶端：玩家的回合開始 / 伺服器的 hazard 照伺服器的名單（bound = 現在被綁著的人）對齊 */
export function alignMarksBound(match, spec, bound) {
  const S = spec.state(match);
  if (!S || !S.bound || !Array.isArray(bound)) return;
  for (const pid of Object.keys(S.bound)) if (!bound.includes(pid)) delete S.bound[pid];
  for (const pid of bound) if (typeof pid === 'string' && !S.bound[pid]) S.bound[pid] = { count: 0, last: 0, n: 0 };
  syncMarks(match, spec);
}

/** 客戶端：伺服器的 struggle（連打數照伺服器的，掙脫了就放開）*/
export function applyMarksStruggle(match, spec, msg) {
  const S = spec.state(match);
  if (!S || !S.bound) return;
  const rec = S.bound[msg.id];
  if (msg.freed) delete S.bound[msg.id];
  else if (rec && Number.isFinite(msg.count)) rec.count = msg.count;
  syncMarks(match, spec);
}

/** 客戶端：發動的那一招綁住了他（伺服器的 hazard fired）*/
export function bindMarked(match, spec, id) {
  const S = spec.state(match);
  const p = match.byId(id);
  if (!S || !S.bound || !p || !p.alive) return;
  if (!S.bound[id]) S.bound[id] = { count: 0, last: 0, n: 0 };
  p.moveDir = 0;
  p.wantJump = false;
  syncMarks(match, spec);
}

/** 招式的傷害照開場人數：武器的 damage（每人多少）× 開場的玩家數（含之後倒下的，同大樹遊俠） */
export const perPlayer = (match, W, mult = 1) => ({ ...W, damage: W.damage * mult * Math.max(1, match.players.length) });

/** 直接打在 p 身上的一下（不擊退的招式：他正在自己的回合操作，伺服器不跑他的物理） */
export const hitOn = (match, p, W, boss) => match.applyExplosion(p.x, p.cy, W, boss, p, { directOnly: true });
