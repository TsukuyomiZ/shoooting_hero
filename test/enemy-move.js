// node test/enemy-move.js
// 敵人走動（2026-10-08 使用者：所有敵人都要會走動，不然玩家永遠瞄同一個地方就好；規則在 shared/ai/ai-move.js）：
// - 每種敵人每回合都換位置：一般敵人 / 狙擊手 / 砲兵 / 樹妖走路，蝙蝠在空中飄，獨眼巨人沿著自己那根岩柱走（再出招）；
// - 很多個 seed 都不會走進水裡、走下樹枝 / 石柱 / 台地、走出活動範圍、碰到地形、走進別人身體裡；
// - 客戶端照 aiTurn 的 walk / glide 重播，走到的地方跟伺服器一模一樣；裁判等的時間有算進走動；ai.turn 紀錄有帶；
// - 走完還在半空中的放開方向鍵落到站穩（walk.fall）：連瞄準那段的物理也跑，客戶端開火前的位置跟伺服器的 shot.actor 一樣、站在地上；
// - 蝙蝠 / 獨眼巨人移動的距離也甩得掉燃燒；斷線代打走過火把 / 蛇血會點燃 / 喝到（pickups 的那一幀、紀錄、真的 GameView）；
// - 古樹、巨蟒、蜜蜂不走（有自己的動法）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { glideAt } from '../shared/ai/ai-move.js';
import { spawnTreant } from '../shared/maps/tree-boss.js';
import { PLATFORM } from '../shared/physics/terrain.js';

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

class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.records = []; this.seq = 0; }
  broadcast(msg) { this.log.push({ ...msg, at: this.t }); }
  record(ev, data) { this.records.push({ ev, ...data }); }
  schedule(fn, ms) { const h = { at: this.t + ms, fn, id: this.seq++ }; this.timers.push(h); return h; }
  cancel(h) { this.timers = this.timers.filter(x => x !== h); }
  now() { return this.t; }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const make = (levelId, n = 2, opts = {}) => new Match({ levelId, players: mkPlayers(n), seed: 1, ...opts });

// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原
function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, { ...CONFIG[k] }]));
  for (const [k, v] of Object.entries(patch)) Object.assign(CONFIG[k], v);
  try { return fn(); } finally { for (const [k, v] of Object.entries(saved)) Object.assign(CONFIG[k], v); }
}
const BASE = {
  AI_MOVE: { dist: [30, 80], minDist: 20, maxFrames: 90, keepDir: 0.65, edge: 8, maxDrop: 40, allyGap: 56, glideTries: 12, takeoverChance: 0.6 },
  ENEMY: { moveChance: 1 }, SNIPER: { moveChance: 1 }, ARTILLERY: { moveChance: 1 }, TREANT: { moveChance: 1 },
  BAT: { moveChance: 1, roam: { x: 120, y: 40, speed: 60 } },
  CYCLOPS: { walk: { speed: 50, edge: 4 } },
  PLAYER: { hp: 150 },
};
const base = (fn) => withConfig(BASE, fn);

// 一回合只走動、不開火（開火的擊退會把人推下去，那不是走路的錯）
function moveOnly(m, e) {
  const x0 = e.x, y0 = e.y;
  m.beginTurn(e);
  const r = m.planAiTurn(e);
  m.settle(300);
  return { r, d: Math.hypot(e.x - x0, e.y - y0) };
}
// 身體（加 pad）有沒有碰到任何地形（土、樹皮、平台、鐘乳石）
function touchesTerrain(t, e, x, y, pad) {
  for (let yy = y - e.h - pad; yy <= y + pad; yy += 2) {
    for (let xx = x - e.hw - pad; xx <= x + e.hw + pad; xx += 2) if (t.at(xx, yy) !== 0) return true;
  }
  return false;
}
// 敵人腳下踩的是哪一塊：樹枝（平台）用 x 範圍分；地面用出生時那一塊的 x 範圍（中間隔著水的小地圖）
const PLATFORM_MAPS = { grove: (x) => (x < 760 ? 0 : 1), beehive: () => 0 };

// ---------------- 走路 ----------------

test('走路的敵人（一般 / 狙擊手 / 砲兵）在每張小地圖、很多個 seed：每回合都換位置（多半走 minDist 以上），不會走進水裡、走下樹枝 / 石柱 / 台地', () => base(() => {
  const out = {};
  for (const levelId of ['level1', 'level2', 'level3', 'grove', 'flanked', 'brawl', 'beehive']) {
    let turns = 0, moved = 0, far = 0;
    const kinds = new Set();
    for (let seed = 1; seed <= 12; seed++) {
      const m = make(levelId, 2, { seed });
      const walkers = m.enemies.filter(e => !e.noTurn && !e.allyPass);
      const home = new Map(walkers.map(e => [e.id, { x: e.x, branch: PLATFORM_MAPS[levelId] ? PLATFORM_MAPS[levelId](e.x) : null, xs: new Set() }]));
      for (let round = 0; round < 6; round++) {
        for (const e of walkers) {
          const { r, d } = moveOnly(m, e);
          const h = home.get(e.id);
          kinds.add(e.kind || 'normal');
          turns++;
          if (d >= 1) moved++;
          if (d >= CONFIG.AI_MOVE.minDist) far++;
          h.xs.add(Math.round(e.x / 4));
          const at = `${levelId}/${seed} r${round} ${e.id}(${e.kind || 'normal'}) at (${e.x.toFixed(1)}, ${e.y.toFixed(1)})`;
          assert(!r.glide && (r.walk === null || (r.walk.frames > 0 && r.walk.frames <= CONFIG.AI_MOVE.maxFrames + 30)), `${at}: walk ${J(r.walk)}`);
          assert(e.alive && e.waterFalls === 0 && e.onGround && e.y < CONFIG.WATER_LEVEL - CONFIG.WATER.safeMargin, `${at}: walked into the water / fell`);
          if (h.branch !== null) {
            assert(m.terrain.at(e.x, e.y + 1) === PLATFORM && PLATFORM_MAPS[levelId](e.x) === h.branch, `${at}: walked off its branch`);
          }
          // 不走進別人身體裡（同伴另外至少隔開身體）
          for (const o of m.entities) {
            if (o === e || !o.alive || o.allyPass || !(o.y - o.h < e.y && e.y - e.h < o.y)) continue;
            assert(Math.abs(o.x - e.x) >= e.hw + o.hw, `${at}: walked into ${o.id} at ${o.x.toFixed(1)}`);
          }
        }
      }
      // 每隻敵人 6 回合至少換了 4 個不同的地方（玩家沒辦法一直瞄同一個點）
      for (const [id, h] of home) assert(h.xs.size >= 3, `${levelId}/${seed} ${id}: only ${h.xs.size} spots in 6 turns`);
    }
    // 樹影重重的左樹枝（約 100 px 走得到）站兩隻狙擊手，還要讓彼此的子彈打得到人：常常只能挪一小段
    const farRate = levelId === 'grove' ? 0.7 : 0.8;
    assert(moved >= turns * 0.95 && far >= turns * farRate, `${levelId}: moved ${moved}/${turns}, ≥ minDist ${far}/${turns}`);
    out[levelId] = { kinds: [...kinds].join(), moved: `${moved}/${turns}`, far: `${far}/${turns}` };
  }
  return out;
}));

test('走在窄的地方也不會掉下去：狙擊手放在樹枝兩端、砲兵放在台地的崖邊、一般敵人放在塔頂邊上，走幾回合都還站在上面', () => base(() => {
  const cases = [
    ['grove', 'e3', 818, 'sniper at the left end of branch 2'],
    ['grove', 'e3', 930, 'sniper near the right end of branch 2'],
    ['flanked', 'e1', 250, 'artillery at the cliff of the left plateau'],
    ['flanked', 'e2', 760, 'artillery at the cliff of the right plateau'],
    ['level2', 'e1', 445, 'enemy at the edge of tower A'],
  ];
  const out = [];
  for (const [levelId, id, x, label] of cases) {
    for (let seed = 1; seed <= 15; seed++) {
      const m = make(levelId, 1, { seed });
      const e = m.byId(id);
      e.x = x; e.y -= 20; e.onGround = false;
      m.settle(300);
      const before = PLATFORM_MAPS[levelId] ? PLATFORM_MAPS[levelId](e.x) : null;
      for (let k = 0; k < 4; k++) {
        moveOnly(m, e);
        assert(e.alive && e.waterFalls === 0 && e.onGround, `${label} seed ${seed}: fell (${e.x.toFixed(1)}, ${e.y.toFixed(1)})`);
        if (before !== null) assert(m.terrain.at(e.x, e.y + 1) === PLATFORM && PLATFORM_MAPS[levelId](e.x) === before, `${label} seed ${seed}: off the branch`);
      }
    }
    out.push(label);
  }
  return { cases: out.length };
}));

test('樹妖也走（走得慢，一回合最多 maxFrames 幀）：站在古樹前面的地上，碰不到樹幹（maxX）、不會走進別人身體裡', () => base(() => {
  let moved = 0, turns = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const m = make('treeGarden', 2, { seed });
    const trs = [[560, 'm1'], [515, 'm2'], [470, 'm3'], [425, 'm4']].map(([x, id]) => spawnTreant(m, { id, name: id, x, y: 540, hp: 100 }));
    m.settle(300);
    for (let round = 0; round < 5; round++) {
      for (const tr of trs) {
        const { r, d } = moveOnly(m, tr);
        turns++;
        if (d >= 1) moved++;
        assert(!r.boss && (!r.walk || r.walk.frames <= CONFIG.AI_MOVE.maxFrames + 30), `walk ${J(r.walk)}`);
        assert(d <= CONFIG.TREANT.moveSpeed * (r.walk ? r.walk.frames : 0) / 60 + 1, `treant too fast: ${d}`);
        assert(tr.alive && tr.onGround && tr.waterFalls === 0 && tr.x <= m.terrain.maxX - tr.hw, `${tr.id} at (${tr.x}, ${tr.y})`);
      }
    }
  }
  assert(moved >= turns * 0.9, `treants walk: ${moved}/${turns}`);
  return { moved: `${moved}/${turns}` };
}));

test('古樹、巨蟒、蜜蜂不走動（由地圖機制出招）；斷線代打的玩家照 takeoverChance 走', () => base(() => {
  const tree = make('treeGarden', 1);
  const eye = tree.byId('eye');
  const r1 = tree.planAiTurn(eye);
  assert(r1.boss && r1.walk === null && r1.glide === null, 'tree: ' + J({ walk: r1.walk, glide: r1.glide }));
  const snake = make('jungleSerpent', 1);
  const r2 = snake.planAiTurn(snake.byId('snake'));
  assert(r2.boss && r2.walk === null && r2.glide === null, 'snake');
  // 代打：takeoverChance 0 → 不走；1 → 走
  for (const [chance, want] of [[0, false], [1, true]]) {
    withConfig({ AI_MOVE: { takeoverChance: chance } }, () => {
      const m = make('level1', 1, { seed: 3 });
      const p = m.byId('p1');
      const { r } = moveOnly(m, p);
      assert(!!r.walk === want, `takeover chance ${chance}: walk ${J(r.walk)}`);
    });
  }
}));

// ---------------- 飄移 ----------------

test('蝙蝠在出生點周圍的框框裡飄：每回合都換位置，路上每一幀身體都不碰地形（岩台、鐘乳石、天花板），終點跟另一隻隔開 allyGap', () => base(() => {
  let turns = 0, far = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const m = make('cave', 2, { seed });
    const bats = m.enemies.filter(e => e.kind === 'bat');
    const spawn = new Map(bats.map(b => [b.id, { x: b.x, y: b.y, xs: new Set() }]));
    for (let round = 0; round < 6; round++) {
      for (const b of bats) {
        const x0 = b.x, y0 = b.y;
        const { r, d } = moveOnly(m, b);
        const s = spawn.get(b.id);
        const at = `seed ${seed} r${round} ${b.id}`;
        turns++;
        if (d >= CONFIG.AI_MOVE.minDist) far++;
        assert(!r.walk && r.glide && Number.isInteger(r.glide.dx) && Number.isInteger(r.glide.dy) && r.glide.frames > 0, `${at}: glide ${J(r.glide)}`);
        assert(b.x === x0 + r.glide.dx && b.y === y0 + r.glide.dy, `${at}: server put it at the end of the glide`);
        assert(Math.abs(b.x - s.x) <= 120 && Math.abs(b.y - s.y) <= 40 && b.y < 340, `${at}: left its box (${b.x}, ${b.y})`);
        for (let i = 1; i <= r.glide.frames; i++) {
          const p = glideAt(x0, y0, r.glide, i);
          assert(!touchesTerrain(m.terrain, b, p.x, p.y, 4), `${at}: frame ${i} touches terrain at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
        }
        const p = glideAt(x0, y0, r.glide, r.glide.frames);
        assert(p.x === b.x && p.y === b.y, `${at}: the last replayed frame lands exactly where the server put it`);
        for (const o of bats) if (o !== b) assert(Math.hypot(o.x - b.x, o.y - b.y) >= CONFIG.AI_MOVE.allyGap - 1e-9, `${at}: too close to ${o.id}`);
        s.xs.add(`${Math.round(b.x / 4)},${Math.round(b.y / 4)}`);
      }
    }
    for (const [id, s] of spawn) assert(s.xs.size >= 5, `seed ${seed} ${id}: only ${s.xs.size} spots in 6 turns`);
  }
  assert(far >= turns * 0.9, `bats glide at least minDist: ${far}/${turns}`);
  return { far: `${far}/${turns}` };
}));

test('獨眼巨人每回合先沿著自己那根岩柱走一段再出招：腳一直踩在岩柱頂上、不走進站在上面的玩家，招式從走到的地方出', () => base(() => {
  let turns = 0, far = 0;
  const ledge = { x0: 784, x1: 1024, y: LEVELS.depths.mechanic.cyclops.y };   // 岩柱平的頂面
  for (let seed = 1; seed <= 15; seed++) {
    const m = make('depths', 2, { seed });
    const cy = m.byId('cyclops');
    const p1 = m.byId('p1');
    if (seed % 3 === 0) {   // 有人站上他的岩柱
      p1.x = 860; p1.y = 400; p1.onGround = false;
      m.settle(300);
    }
    const xs = new Set();
    for (let round = 0; round < 6 && cy.alive && p1.alive; round++) {
      const x0 = cy.x;
      const before = m.players.filter(p => p.alive).map(p => ({ id: p.id, x: p.x, y: p.y, h: p.h, hw: p.hw }));   // 出招會把人打飛：比走路前的位置
      m.beginTurn(cy);
      const r = m.planAiTurn(cy);
      const at = `seed ${seed} r${round}`;
      turns++;
      assert(r.boss && r.walk === null && r.glide && r.glide.dy === 0, `${at}: ${J({ glide: r.glide, walk: r.walk })}`);
      if (Math.abs(r.glide.dx) >= CONFIG.AI_MOVE.minDist) far++;
      assert(cy.x === x0 + r.glide.dx && cy.y === ledge.y, `${at}: moved to ${cy.x}, ${cy.y}`);
      assert(cy.x - cy.hw >= ledge.x0 && cy.x + cy.hw <= ledge.x1 && m.terrain.isHard(cy.x - cy.hw, cy.y + 2) && m.terrain.isHard(cy.x + cy.hw - 1, cy.y + 2), `${at}: off his pillar at ${cy.x}`);
      for (let i = 1; i <= r.glide.frames; i++) {
        const gx = glideAt(x0, cy.y, r.glide, i).x;
        for (const p of before) {
          if (p.y > cy.y - cy.h && p.y - p.h < cy.y) assert(Math.abs(p.x - gx) >= p.hw + cy.hw, `${at}: walked into ${p.id}`);
        }
      }
      const shot = r.boss.steps[0].shot;
      if (shot) assert(shot.actor.x === cy.x, `${at}: the move starts from where he walked to`);
      xs.add(Math.round(cy.x / 4));
      m.settle(300);
    }
    assert(xs.size >= 3, `seed ${seed}: only ${xs.size} spots`);
  }
  assert(far >= turns * 0.8, `walks at least minDist: ${far}/${turns}`);
  return { far: `${far}/${turns}` };
}));

// ---------------- 裁判、重播 ----------------

// 跑一場（玩家都斷線、AI 代打），每次 AI 規劃前記下快照、規劃完記下行動者的位置；回傳 aiTurn 訊息與這些記錄
function refereeRun(levelId, seed, maxTurns = 14) {
  const players = mkPlayers(2);
  const m = new Match({ levelId, players, seed });
  for (const p of m.players) { p.hp = p.maxHp = 3000; }
  const caps = [];
  const plan = m.planAiTurn.bind(m);
  m.planAiTurn = (actor, w) => {
    const snap = JSON.parse(J(m.snapshot()));
    const r = plan(actor, w);
    caps.push({ actorId: actor.id, snap, x: actor.x, y: actor.y, vy: actor.vy, onGround: actor.onGround });
    return r;
  };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  for (const p of players) ref.setConnected(p.id, false);
  for (let k = 0; k < 4000 && ref.phase !== 'over' && caps.length < maxTurns; k++) io.advance(250);
  io.advance(60_000);   // 最後一個 AI 回合播完
  return { m, io, caps, players };
}

// 照客戶端的 aiTurnScript（client/game-view.js）播一則 aiTurn 到開火之前：伺服器規劃前的快照 → aiTurn 帶的角色狀態 →
// aiThink 那段也跑物理 → 走路（按著方向 frames 幀、放開再落 fall 幀）/ 飄移 → aim = 有開火的話，瞄準那段（aiAim）也跑物理。回傳客戶端的行動者。
// stopAt = 只走到走路的第幾幀就停（看撿到道具那一刻在哪裡）
function clientAiTurn(levelId, players, seed, cap, msg, aim = false, stopAt = Infinity) {
  const c = new Match({ levelId, players, seed });
  c.applySnapshot(JSON.parse(J(cap.snap)));
  c.applyEntities(JSON.parse(J(msg.entities)));
  const e = c.byId(msg.actorId);
  if (!msg.boss) for (let f = 0; f < Math.round(CONFIG.TIMING.aiThink * 60); f++) c.step();
  if (msg.walk) {
    e.moveDir = msg.walk.dir;
    for (let f = 1; f <= Math.min(stopAt, msg.walk.frames + msg.walk.fall); f++) {
      if (f > msg.walk.frames) e.moveDir = 0;
      c.step();
    }
    e.moveDir = 0;
    if (stopAt < Infinity) return e;
  }
  if (msg.glide) {
    const x0 = e.x, y0 = e.y;
    for (let f = 1; f <= msg.glide.frames; f++) { const p = glideAt(x0, y0, msg.glide, f); e.x = p.x; e.y = p.y; }
  }
  if (aim && msg.shot) for (let f = 0; f < Math.round(CONFIG.TIMING.aiAim * 60); f++) c.step();
  return e;
}

test('客戶端照 aiTurn 的 walk / glide 重播（先 aiThink 那段物理、再走 / 飄）：走到的地方跟伺服器一模一樣；裁判等的時間有算進走動；ai.turn 紀錄帶 walk / glide', () => base(() => {
  const out = {};
  for (const [levelId, seed] of [['flanked', 2], ['grove', 3], ['brawl', 4], ['cave', 5], ['depths', 6], ['level2', 7]]) {
    const { io, caps, players } = refereeRun(levelId, seed);
    const ai = io.log.filter(x => x.t === 'aiTurn');
    assert(ai.length === caps.length && ai.length >= 4, `${levelId}: ${ai.length} aiTurn vs ${caps.length} plans`);
    let walks = 0, glides = 0;
    ai.forEach((msg, i) => {
      const cap = caps[i];
      assert(cap.actorId === msg.actorId, `${levelId} #${i}: actor ${cap.actorId} vs ${msg.actorId}`);
      // 客戶端：同一張地圖、伺服器規劃前的快照 → aiTurn 帶的角色狀態 → aiThink 那段也跑物理 → 走路（含放開之後落地的 fall 幀）/ 飄移
      const e = clientAiTurn(levelId, players, seed, cap, msg);
      if (msg.walk) walks++;
      if (msg.glide) glides++;
      assert(e.x === cap.x && e.y === cap.y, `${levelId} #${i} ${msg.actorId}: client (${e.x}, ${e.y}) vs server (${cap.x}, ${cap.y}) ${J({ walk: msg.walk, glide: msg.glide })}`);
      // 裁判等的時間 ≥ 客戶端播這一段要的幀數（aiThink + 走 / 飄 + 瞄準 + 一波，或 Boss 的每一招）
      const next = io.log.slice(io.log.indexOf(msg) + 1).find(x => x.at > msg.at);   // 這一回合播完、裁判接著送的下一則
      const T = CONFIG.TIMING;
      const move = (msg.walk ? msg.walk.frames + msg.walk.fall : 0) + (msg.glide ? msg.glide.frames : 0);
      const act = msg.boss
        ? msg.boss.steps.reduce((s, st) => s + T.bossCast * 60 + (st.shot ? st.shot.flightFrames + st.shot.settleFrames : st.still.settleFrames), 0)
        : (msg.shot ? T.aiAim * 60 + msg.shot.flightFrames + msg.shot.settleFrames : 0);
      if (next) assert((next.at - msg.at) * 60 / 1000 >= T.aiThink * 60 + move + act - 1, `${levelId} #${i}: referee waited ${next.at - msg.at} ms for ${T.aiThink * 60 + move + act} frames`);
      // 紀錄
      const rec = io.records.filter(r => r.ev === 'ai.turn')[i];
      assert(rec && rec.actor === msg.actorId && J(rec.walk ?? null) === J(msg.walk ?? null) && J(rec.glide ?? null) === J(msg.glide ?? null), `${levelId} #${i}: ai.turn log ${J(rec && { walk: rec.walk, glide: rec.glide })} vs ${J({ walk: msg.walk, glide: msg.glide })}`);
    });
    const enemyTurns = ai.filter(a => !players.some(p => p.id === a.actorId) && (!a.boss || a.actorId === 'cyclops'));
    const movedTurns = enemyTurns.filter(a => (a.walk && a.walk.frames > 0) || (a.glide && a.glide.frames > 0)).length;
    assert(movedTurns >= enemyTurns.length * 0.85, `${levelId}: enemies moved in ${movedTurns}/${enemyTurns.length} turns`);
    out[levelId] = { aiTurns: ai.length, walks, glides };
  }
  return out;
}));

test('走完還在半空中（走下小台階、前面不安全或體力用完的那一刻腳還沒著地）就放開方向鍵落到站穩（walk.fall）：玩家都斷線、每張小地圖很多個 seed，' +
  '客戶端照 aiThink → 走 frames 幀 → 落 fall 幀 → 瞄準那段（aiAim）也跑物理，跟伺服器開火的位置（shot.actor；沒開火就比規劃完的位置）一模一樣，而且站在地上', () => base(() => {
  const out = { walks: 0, shots: 0, fall: { enemy: 0, takeover: 0 } };
  for (const levelId of Object.keys(LEVELS).filter(k => LEVELS[k].pool === 'normal')) {
    for (let seed = 1; seed <= 4; seed++) {
      const { io, caps, players } = refereeRun(levelId, seed);
      io.log.filter(x => x.t === 'aiTurn').forEach((msg, i) => {
        if (!msg.walk) return;
        const cap = caps[i];
        const at = `${levelId}/${seed} #${i} ${msg.actorId} ${J(msg.walk)}`;
        out.walks++;
        assert(Number.isInteger(msg.walk.fall) && msg.walk.fall >= 0, `${at}: fall`);
        if (msg.walk.fall) out.fall[players.some(p => p.id === msg.actorId) ? 'takeover' : 'enemy']++;
        assert(cap.onGround, `${at}: the server left him in the air (${cap.x}, ${cap.y}) vy ${cap.vy}`);   // 剛落地那一幀 vy 還沒歸零（下一幀才清），只看站穩
        const e = clientAiTurn(levelId, players, seed, cap, msg, true);
        const want = msg.shot ? msg.shot.actor : cap;
        if (msg.shot) {
          out.shots++;
          assert(want.x === cap.x && want.y === cap.y && want.vy === cap.vy, `${at}: fired from where he landed`);
        }
        assert(e.x === want.x && e.y === want.y && e.onGround, `${at}: client before the shot (${e.x}, ${e.y}) ground ${e.onGround} vs server (${want.x}, ${want.y})`);
      });
    }
  }
  // 沒有走完還在半空中的話，這個測試什麼都沒證明
  assert(out.fall.enemy > 0 && out.fall.takeover > 0, 'no walk ended in the air: ' + J(out));
  return out;
}));

test('燃燒：蝙蝠在空中飄、獨眼巨人沿著岩柱走的距離也算這回合的移動（跟走路一樣），回合結束照距離甩掉層數', () => base(() => withConfig({ EQUIP: { burn: { pctPerStack: 0.1, pxPerStack: 10, maxReducePerTurn: 3 } } }, () => {
  const out = {};
  for (const [levelId, pick] of [['cave', m => m.enemies.find(e => e.kind === 'bat')], ['depths', m => m.byId('cyclops')]]) {
    let shed = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const m = make(levelId, 2, { seed });
      const e = pick(m);
      m.beginTurn(e);
      e.burn = 5;
      e.burnFrac = 0;
      const r = m.planAiTurn(e);
      assert(r.glide, `${levelId}/${seed}: ${e.id} did not move`);
      const d = Math.hypot(r.glide.dx, r.glide.dy);
      assert(Math.abs(e.movedThisTurn - d) < 1e-9, `${levelId}/${seed}: moved ${e.movedThisTurn} vs glide ${d}`);
      const want = Math.min(5, 3, Math.floor(d / 10));
      const burn = m.endTurn(e).find(f => f.type === 'burn' && f.id === e.id);
      assert(burn && burn.shaken === want && e.burn === 5 - want, `${levelId}/${seed}: shook off ${burn && burn.shaken} of ${want} (glide ${d.toFixed(1)} px)`);
      if (want > 0) shed++;
    }
    assert(shed >= 5, `${levelId}: shed stacks in ${shed}/6 turns`);
    out[levelId] = shed;
  }
  return out;
})));

// 從快照照同樣的物理按著 dir 一幀一幀走（跟 simulateWalk 一樣：體力、前面不安全就停，停下來在空中就放開落地），每一幀問地圖機制的 moved：第一次撿到是第幾幀
function firstPickupFrame(levelId, snap, id, dir, maxFrames) {
  const c = make(levelId, 2);
  c.applySnapshot(JSON.parse(snap));
  const e = c.byId(id);
  e.moveDir = dir;
  for (let f = 1; f <= maxFrames + 60; f++) {
    if (f > maxFrames) e.moveDir = 0;
    const px = e.x, py = e.y;
    c.step();
    const fx = c.mechanic.moved(c, e, px, py, e.x, e.y);
    if (fx) return { f, fx };
  }
  return null;
}

test('斷線代打的玩家 AI 走路也撿道具（跟自己走過去一樣：地圖機制的 moved）：岩穴走過熄著的火把就點燃、叢林巨蟒走過蛇血就喝；pickups 的 f 就是碰到的那一幀；試走的分身、敵人不撿', () => base(() => {
  // 岩穴：地上那支（第 1 支，一開始熄著）的左邊往右走
  const m = make('cave', 2);
  const p = m.byId('p1');
  const torch = LEVELS.cave.mechanic.torches[1];
  p.x = torch.x - p.hw - 6 - 12; p.y = 560; p.onGround = false;
  m.settle(300);
  const snap = J(m.snapshot());
  const ghost = Object.assign(Object.create(Object.getPrototypeOf(p)), p);
  const dry = m.simulateWalk(ghost, 1, 30, true);
  assert(ghost.x > torch.x - p.hw && !dry.pickups.length && m.mechState.lit[1] === null, 'the ghost walked past it without lighting it: ' + J(m.mechState.lit));
  const w = m.simulateWalk(p, 1, 30);
  const want = firstPickupFrame('cave', snap, 'p1', 1, 30);
  assert(w.pickups.length === 1 && J(w.pickups[0]) === J({ f: want.f, ...want.fx, hp: p.hp, mhp: p.maxHp, lk: p.poisonLock }) && want.fx.torch === 1,
    'lit torch 1 at the frame he touched it: ' + J({ got: w.pickups, want }));
  assert(m.mechState.lit[1] === 1, 'server state: lit ' + J(m.mechState.lit));
  // 叢林巨蟒：蛇血在右邊（受傷、中毒才喝）
  const s = make('jungleSerpent', 2);
  const q = s.byId('p1');
  q.hp = q.maxHp - 60; q.poison = 2;
  s.mechState.items = [{ id: 'b1', type: 'snakeBlood', x: Math.round(q.x + 30), y: 544 }];
  const snap2 = J(s.snapshot());
  const w2 = s.simulateWalk(q, 1, 40);
  const want2 = firstPickupFrame('jungleSerpent', snap2, 'p1', 1, 40);
  assert(w2.pickups.length === 1 && w2.pickups[0].type === 'snakeBlood' && w2.pickups[0].item === 'b1' && w2.pickups[0].f === want2.f,
    'drank at the frame he touched it: ' + J({ got: w2.pickups, want: want2 }));
  assert(!s.mechState.items.length && q.poison === 0 && w2.pickups[0].hp === q.hp && w2.pickups[0].mhp === q.maxHp, 'server state after drinking');
  // 敵人（這裡把 p2 當成敵人）走過去不喝
  const s2 = make('jungleSerpent', 2);
  const z = s2.byId('p2');
  z.team = 'enemies'; z.hp = z.maxHp - 60;
  s2.mechState.items = [{ id: 'b2', type: 'snakeBlood', x: Math.round(z.x + 30), y: 544 }];
  const zx = z.x;
  const w3 = s2.simulateWalk(z, 1, 40);
  assert(z.x > zx + 30 && !w3.pickups.length && s2.mechState.items.length === 1, 'enemies walk over it without drinking: ' + J({ from: zx, to: z.x }));
  return { torchFrame: want.f, bloodFrame: want2.f };
}));

// ---------------- 真的 GameView（同 cave.js 的假物件：客戶端模組一載入就碰 window / document / localStorage） ----------------
const fakeCtx2d = () => new Proxy({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const fakeCanvas = () => ({ width: 1024, height: 768, style: {}, getContext: fakeCtx2d, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }) });
globalThis.window ??= { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document ??= { addEventListener() {}, hidden: false, createElement: fakeCanvas };
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { GameView } = await import('../client/game-view.js');

// P1 的回合一開始就斷線、AI 代打（setup 先把他擺好）；P2 的畫面是真的 GameView。回傳伺服器、aiTurn、紀錄、畫面在 pickup 那一刻 P1 的位置
function takeoverWithView(levelId, seed, setup) {
  const players = mkPlayers(2);
  const m = new Match({ levelId, players, seed });
  setup(m, m.byId('p1'), m.byId('p2'));
  m.settle(300);
  let cap = null;
  const plan = m.planAiTurn.bind(m);
  m.planAiTurn = (actor, w) => {
    const snap = JSON.parse(J(m.snapshot()));
    const r = plan(actor, w);
    cap ||= { snap };
    return r;
  };
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p2';
  view.transport = { send() {} };
  const seen = [];
  const onPickup = view.onPickup.bind(view);
  view.onPickup = (msg) => { const e = view.match.byId(msg.id); seen.push({ msg: J(msg), x: e.x, y: e.y }); onPickup(msg); };
  const sent = [];
  const feed = () => { for (const msg of io.log.splice(0)) { sent.push(msg); view.onMessage(msg); } };
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  try {
    ref.start();
    feed();
    for (let k = 0; k < 40 && !(ref.phase === 'turn' && ref.currentId === 'p1'); k++) { io.advance(250); feed(); for (let f = 0; f < 15; f++) view.update(CONFIG.FIXED_DT); }
    assert(ref.currentId === 'p1' && ref.phase === 'turn', 'p1 turn');
    ref.setConnected('p1', false);
    feed();
    for (let f = 0; f < 1200; f++) view.update(CONFIG.FIXED_DT);
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  const ai = sent.find(x => x.t === 'aiTurn');
  return { m, ai, cap, players, view, seen, records: io.records };
}

test('真的 GameView：斷線代打的玩家走過火把 / 蛇血，aiTurn 帶 pickups（撿到的那一幀 f），客戶端走到那一幀才套上（位置跟伺服器撿到時一樣）；也照自己走過去那樣記 pickup（takeover）', () => base(() => {
  const out = {};
  const cases = [
    // 岩穴：P1 在地上那支火把（熄著）左邊，P2 貼在他左邊（往左走不動）
    ['cave', (m, p1, p2) => {
      const t = LEVELS.cave.mechanic.torches[1];
      p1.x = t.x - p1.hw - 6 - 10; p1.y = 560; p1.onGround = false;
      p2.x = p1.x - p1.hw - p2.hw - 1; p2.y = 560; p2.onGround = false;
    }, (m) => m.mechState.lit[1] !== null, (m, v) => J(v.match.mechState.lit) === J(m.mechState.lit)],
    // 叢林巨蟒：P1 受傷又中毒，左右兩邊各一灘蛇血
    ['jungleSerpent', (m, p1) => {
      p1.x = 230; p1.hp = p1.maxHp - 60; p1.poison = 2;
      m.mechState.items = [{ id: 'b1', type: 'snakeBlood', x: 200, y: 544 }, { id: 'b2', type: 'snakeBlood', x: 260, y: 544 }];
    }, (m) => m.mechState.items.length === 1, (m, v) => J(v.match.mechState.items) === J(m.mechState.items) && v.match.byId('p1').poison === 0],
  ];
  for (const [levelId, setup, picked, same] of cases) {
    let hits = 0;
    for (let seed = 1; seed <= 6; seed++) {
      withConfig({ AI_MOVE: { takeoverChance: 1 } }, () => {
        const { m, ai, cap, players, view, seen, records } = takeoverWithView(levelId, seed, setup);
        const at = `${levelId}/${seed}`;
        assert(ai && ai.actorId === 'p1', `${at}: takeover`);
        const pks = ai.pickups || [];
        assert(picked(m) === (pks.length > 0), `${at}: server picked up ${picked(m)} vs aiTurn pickups ${J(pks)}`);
        if (!pks.length) return;
        hits++;
        // 紀錄：跟自己走過去一樣的 pickup（takeover、f），在 ai.turn 之前
        const recs = records.filter(r => r.ev === 'pickup');
        assert(recs.length === pks.length && recs.every((r, i) => r.pid === 'p1' && r.takeover && r.f === pks[i].f && r.type === pks[i].type), `${at}: pickup log ${J(recs)}`);
        assert(records.indexOf(recs[0]) < records.findIndex(r => r.ev === 'ai.turn'), `${at}: logged before ai.turn`);
        // 畫面：每個 pickup 都在走到第 f 幀時套上（那一刻的位置 = 照同樣的物理走 f 幀）
        assert(seen.length === pks.length, `${at}: client applied ${seen.length} of ${pks.length}`);
        pks.forEach((pk, i) => {
          const e = clientAiTurn(levelId, players, seed, cap, ai, false, pk.f);
          const { f, ...msg } = pk;
          assert(JSON.parse(seen[i].msg).type === msg.type && seen[i].x === e.x && seen[i].y === e.y, `${at}: applied at (${seen[i].x}, ${seen[i].y}) vs frame ${f} at (${e.x}, ${e.y})`);
        });
        assert(same(m, view), `${at}: client state = server`);
      });
    }
    assert(hits >= 3, `${levelId}: picked up in ${hits}/6 runs`);
    out[levelId] = hits;
  }
  return out;
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
