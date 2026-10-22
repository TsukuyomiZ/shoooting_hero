// node test/danmaku.js
// 彈幕的三排軌道（client/danmaku-lanes.js；反應貼圖和聊天的字共用）：三排都在頂部 HUD 正下方、不往下佔到中下段的戰場、
// 排跟排不重疊（一則的高度照 css/style.css 的 .dm）；下一則放哪一排：同時來三則分到三排一起飄、好幾排空著放最上面那排、
// 三排都滿了等最早空出來的那排；同一排前後兩則從頭到尾不重疊（後面比較長、跑比較快的也追不上前面的）、照順序出場；
// client/stickers.js 用這套算法排，不自己另外排
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/core/config.js';
import { LANES, LANE_TOP, LANE_PITCH, laneTopPct, laneReadyAt, pickLane } from '../client/danmaku-lanes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function test(name, fn) {
  try {
    const info = fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${info ? '  ' + JSON.stringify(info) : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const J = JSON.stringify;

const HUD_BOTTOM = 106;   // client/render.js 的 drawHUD：最低的是左上的狂熱標籤（y 84、高 22）
const FLY = 5200, GAP = 24, W = 1000;   // 跟 client/stickers.js 一樣的飛行時間、間距；畫面寬隨便取一個

// 照 StickerUi.pump 的做法排：照進隊伍的順序一則一則放，每一則放進最早能放的那排
function schedule(items, lanes = Array(LANES).fill(null)) {
  let clock = 0;
  return items.map(({ t, w }, i) => {
    const { lane, at } = pickLane(lanes, Math.max(clock, t), w, W, FLY, GAP);
    clock = at;
    const v = (W + w) / FLY;
    lanes[lane] = { at, w, v };
    return { i, lane, at, w, v, t };
  });
}

// 同一排 a 先、b 後：b 出場到 a 完全飄出左邊之間，b 的頭跟 a 的尾巴最近的距離（取樣檢查，不靠算法自己的推導）
function closest(a, b) {
  const t0 = b.at, t1 = a.at + FLY;
  if (t1 <= t0) return Infinity;
  let min = Infinity;
  for (let k = 0; k <= 200; k++) {
    const t = t0 + (t1 - t0) * k / 200;
    const aRight = W + a.w - a.v * (t - a.at);
    const bLeft = W - b.v * (t - b.at);
    min = Math.min(min, bLeft - aRight);
  }
  return min;
}

function checkLanes(placed) {
  const byLane = new Map();
  for (const p of placed) {
    const prev = byLane.get(p.lane);
    if (prev) {
      const d = closest(prev, p);
      assert(d >= GAP - 1e-6, `第 ${p.lane} 排第 ${prev.i}、${p.i} 則重疊或太近（${d.toFixed(2)} px）：${J([prev, p])}`);
    }
    byLane.set(p.lane, p);
  }
}

// 固定種子的亂數（mulberry32）
function rng(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('三排都在頂部 HUD 正下方、不往下佔到中下段的戰場，排跟排不重疊', () => {
  assert(LANES === 3, `LANES = ${LANES}`);
  assert(LANE_TOP >= HUD_BOTTOM, `第一排（${LANE_TOP}）蓋到頂部 HUD（到 ${HUD_BOTTOM}）`);
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  const block = (sel) => {
    const m = css.match(new RegExp(`\\n${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`));
    assert(m, `css/style.css 找不到 ${sel}`);
    return m[1];
  };
  const cqw = (body, prop) => {
    const m = body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*([\\d.]+)cqw`));
    assert(m, `${prop} 不是 cqw：${body}`);
    return Number(m[1]) * CONFIG.WORLD_W / 100;   // 換成世界座標 px（圖層跟 canvas 一樣是 4:3）
  };
  const dm = block('.dm');
  assert(/box-sizing:\s*border-box/.test(dm), '.dm 要 border-box（上下 padding 不能把一則撐高）');
  const itemH = cqw(dm, 'height');
  assert(itemH < LANE_PITCH, `一則的高度 ${itemH.toFixed(1)} px 不比排距 ${LANE_PITCH} 矮，排跟排會黏在一起`);
  // 聊天 / 自己丟的（.dm.text、.dm.mine…）是同一個元素：不能另外改高度或盒子算法，把一則撐得比 .dm 高
  for (const [, sel, body] of css.matchAll(/\n(\.dm\.[\w.-]+) \{([^}]*)\}/g)) {
    assert(!/(?:^|[\s;])(?:min-|max-)?height:|box-sizing:/.test(body), `${sel} 另外改了高度 / box-sizing：${body.trim()}`);
  }
  const img = block('.dm img');
  assert(cqw(img, 'width') <= itemH && cqw(img, 'height') <= itemH, '貼圖比一排還高');
  assert(cqw(block('.dm-text'), 'font-size') <= itemH && cqw(block('.dm-name'), 'font-size') <= itemH, '字比一排還高');
  const bottom = LANE_TOP + (LANES - 1) * LANE_PITCH + itemH;
  assert(bottom <= CONFIG.WORLD_H / 3, `最下面那排到 y=${bottom.toFixed(0)}，超過畫面上方三分之一（${CONFIG.WORLD_H / 3}）`);
  for (let i = 0; i < LANES; i++) {
    const pct = laneTopPct(i);
    assert(Math.abs(pct - (LANE_TOP + i * LANE_PITCH) / CONFIG.WORLD_H * 100) < 1e-9, `laneTopPct(${i}) = ${pct}`);
  }
  return { tops: Array.from({ length: LANES }, (_, i) => LANE_TOP + i * LANE_PITCH), itemH: +itemH.toFixed(1), bottom: +bottom.toFixed(1) };
});

test('同時來三則：分到三排一起飄（由上往下），第四則才排隊', () => {
  const placed = schedule([300, 120, 450, 200].map(w => ({ t: 0, w })));
  assert(J(placed.slice(0, 3).map(p => [p.lane, p.at])) === J([[0, 0], [1, 0], [2, 0]]), J(placed));
  assert(placed[3].at > 0, `第四則沒有排隊：${J(placed[3])}`);
  checkLanes(placed);
});

test('好幾排都能放：放最上面那排；上面那排忙著才往下放', () => {
  assert(pickLane([null, null, null], 0, 100, W, FLY, GAP).lane === 0);
  const old = { at: 0, w: 100, v: (W + 100) / FLY };   // 早就飄完了
  assert(J(pickLane([old, null, null], 99999, 100, W, FLY, GAP)) === J({ lane: 0, at: 99999 }), '上面那排早就空了，不該往下放');
  const busy = { at: 1000, w: 300, v: (W + 300) / FLY };   // 剛出場
  assert(J(pickLane([busy, null, null], 1000, 100, W, FLY, GAP)) === J({ lane: 1, at: 1000 }), '第一排忙著就放第二排');
  assert(J(pickLane([busy, busy, old], 1000, 100, W, FLY, GAP)) === J({ lane: 2, at: 1000 }), '前兩排忙著就放第三排');
  // 一個人連丟：一則一則慢慢來（上一則已經整個進場）就一直用最上面那排
  const slow = schedule(Array.from({ length: 6 }, (_, i) => ({ t: i * 2000, w: 80 })));
  assert(slow.every(p => p.lane === 0 && p.at === p.t), J(slow));
});

test('三排都滿了：等最早空出來的那排（照順序出場）', () => {
  const placed = schedule([600, 100, 400, 100, 100].map(w => ({ t: 0, w })));
  const [, , , fourth, fifth] = placed;
  // 第二排的那則最短，最早空出來
  assert(fourth.lane === 1, `第四則該等第二排：${J(fourth)}`);
  const lanesAfter3 = [placed[0], placed[1], placed[2]].map(({ at, w, v }) => ({ at, w, v }));
  const expect = Math.min(...lanesAfter3.map(l => laneReadyAt(l, 100, W, FLY, GAP)));
  assert(Math.abs(fourth.at - expect) < 1e-9, `第四則 ${fourth.at}，該是 ${expect}`);
  assert(fifth.at >= fourth.at, '第五則比第四則早出場');
  checkLanes(placed);
  return { fourth: [fourth.lane, Math.round(fourth.at)], fifth: [fifth.lane, Math.round(fifth.at)] };
});

test('同一排：後面那則比較長（跑比較快）也追不上前面那則', () => {
  const short = { at: 0, w: 60, v: (W + 60) / FLY };   // 一張貼圖
  const longW = 700;                                   // 一句很長的話
  const enter = short.at + (short.w + GAP) / short.v;   // 只看「尾巴離開右邊」的話這時候就能放
  const lv = (W + longW) / FLY;
  const naive = closest(short, { at: enter, w: longW, v: lv });
  assert(naive < GAP, `這個例子本來就追不上，測不到東西（${naive}）`);
  const at = laneReadyAt(short, longW, W, FLY, GAP);
  assert(at > enter, `${at} <= ${enter}`);
  const d = closest(short, { at, w: longW, v: lv });
  assert(Math.abs(d - GAP) < 1e-6, `剛好留 ${GAP} px：${d}`);
  // 反過來（前長後短）只要尾巴離開右邊 gap 就能放
  const long = { at: 0, w: longW, v: lv };
  assert(Math.abs(laneReadyAt(long, 60, W, FLY, GAP) - (longW + GAP) / lv) < 1e-9);
});

test('隨機壓力：同一排從頭到尾不重疊、照順序出場、三排比一排快很多', () => {
  const rand = rng(20261022);
  let t = 0;
  const items = Array.from({ length: 400 }, () => {
    t += rand() < 0.3 ? 0 : rand() * 2000;   // 平均一秒多一則，有時候同時好幾則
    return { t, w: Math.round(40 + rand() * 660) };
  });
  const three = schedule(items);
  checkLanes(three);
  for (let i = 0; i < three.length; i++) {
    assert(three[i].at >= three[i].t, `第 ${i} 則比進隊伍還早出場`);
    if (i) assert(three[i].at >= three[i - 1].at, `第 ${i} 則插隊`);
  }
  const used = new Set(three.map(p => p.lane));
  assert(used.size === LANES, `只用到 ${[...used]}`);
  const one = schedule(items, [null]);
  checkLanes(one);
  const wait = (ps) => ps.reduce((s, p) => s + (p.at - p.t), 0) / ps.length;
  assert(wait(three) * 3 < wait(one), `三排平均等 ${wait(three)} ms、一排 ${wait(one)} ms`);
  return { avgWaitMs: { three: Math.round(wait(three)), one: Math.round(wait(one)) } };
});

test('client/stickers.js 用這套算法排（不自己另外排、不自己定軌道位置）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'client/stickers.js'), 'utf8');
  assert(/import \{[^}]*\bpickLane\b[^}]*\} from '\.\/danmaku-lanes\.js'/.test(src), '沒有從 danmaku-lanes.js 拿 pickLane');
  assert(/laneTopPct\(/.test(src) && /pickLane\(/.test(src), '沒用 laneTopPct / pickLane');
  assert(!/LANE_Y|laneFree|WORLD_H/.test(src), 'stickers.js 還留著自己的軌道位置 / 排法');
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
