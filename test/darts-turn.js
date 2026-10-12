// node test/darts-turn.js
// 飛鏢（一回合可以分開射三次的武器，shotsPerTurn）的回合流程：
// - 裁判：射完一支還有次數 → 同一回合接著繼續（resume；計時在飛行與結算時暫停）、這回合只能用飛鏢（換別把 / 開別把 → weaponLocked，
//   被擋下的開火不會移動他）、兩支之間照樣能移動（體力不回滿）、第三支結束回合、分出勝負 / 他倒下就不再繼續、超時、
//   飛行途中 / 接著的回合裡斷線 → AI 代打只能用飛鏢、重連的完整狀態帶鎖定、下一個回合（含時間扭曲的額外回合）鎖定清掉
// - 真的 client/game-view.js（在 Node 裡載入）：shot 後面緊接著 resume → 重播完才能動、截止時間從收到 resume 算、只能用飛鏢、下一個 turn 清掉鎖定
import { CONFIG } from '../shared/core/config.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { baseStats, derivePlayerStats } from '../shared/cards/cards.js';
import { planShot } from '../shared/ai/ai.js';
import { Rng } from '../shared/core/rng.js';

// 客戶端模組一載入就碰 window / document / localStorage（音效）；GameView 建構時要 canvas：給最小的假物件（同 volley.js）
const fakeCtx = () => new Proxy({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const fakeCanvas = () => ({ width: 1024, height: 768, style: {}, getContext: fakeCtx, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }) });
globalThis.window ??= { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document ??= { addEventListener() {}, hidden: false, createElement: fakeCanvas };
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { GameView } = await import('../client/game-view.js');

CONFIG.ENEMY.damageMult = 1;
CONFIG.ENEMY.damageMultLate = 1;

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
const J = (x) => JSON.parse(JSON.stringify(x));
const r1 = (n) => Math.round(n * 10) / 10;
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));

// 假的 io：虛擬時鐘，可以快轉；廣播走過 JSON（同網路），紀錄收在 records
class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.records = []; this.seq = 0; }
  broadcast(msg) { this.log.push(J(msg)); }
  record(ev, data) { this.records.push({ ev, at: this.t, ...data }); }
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
  take(type) { return this.log.filter(m => m.t === type); }
  recs(ev) { return this.records.filter(r => r.ev === ev); }
}
function advanceUntil(io, pred, maxMs = 300_000) {
  const start = io.t;
  while (io.t - start < maxMs) {
    io.advance(100);
    if (pred()) return true;
  }
  return false;
}

// p1 帶指定效果（直接加在 stats 上）、武器欄 weapons 的測試戰鬥；所有人血量拉到 hp，數字不受 config 的血量影響
function matchWith(effects = {}, { players = 1, levelId = 'level1', seed = 1, weapons = ['darts', 'cannon'], hp = 5000 } = {}) {
  const stats = baseStats();
  for (const [k, v] of Object.entries(effects)) stats[k] += v;
  const d = derivePlayerStats(stats);
  const carry = {};
  for (let i = 1; i <= players; i++) carry['p' + i] = { hp, maxHp: hp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed, size: d.size, mods: d.mods, weapons };
  const m = new Match({ levelId, players: mkPlayers(players), seed, carry });
  for (const e of m.entities) { e.maxHp = hp; e.hp = hp; }
  return m;
}
// 把角色放到 x 的地面上
function placeAt(m, e, x) { e.x = x; e.y = 300; e.vx = 0; e.vy = 0; m.settle(600); }
// 開好一場、走到 p1 的回合（人類、武器欄第一格是飛鏢）。兩人以上時 p2 站到 p1 背後（不然擋在 p1 與敵人中間：
// 代打的 AI 不隔著自己人開槍，飛鏢也會先射到他）
function dartTurn({ effects = {}, players = 1 } = {}) {
  const m = matchWith(effects, { players });
  if (players > 1) {
    const p2 = m.byId('p2');
    placeAt(m, p2, 30);
    assert(p2.alive && p2.onGround && p2.x < m.byId('p1').x, 'p2 stands behind p1');
  }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(players), io });
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000);
  const p1 = m.byId('p1');
  assert(ref.phase === 'turn' && ref.currentId === 'p1' && p1.weapon === 'darts', 'p1 human turn with darts in hand');
  return { m, io, ref, p1 };
}
// p1 從現在的位置射一支飛鏢（角度 0：level1 seed 1 正前方是 e1），回傳這一發的 shot 廣播
function fireDart(ref, io, p, extra = {}) {
  const n = io.take('shot').length;
  ref.handle(p.id, { t: 'fire', weapon: 'darts', angle: 0, power: 50, x: p.x, y: p.y, facing: 1, stamina: p.stamina, ...extra });
  const shots = io.take('shot');
  assert(shots.length === n + 1, 'dart fired: ' + JSON.stringify(io.recs('action.ignored').at(-1) || null));
  return shots.at(-1);
}
// 飛鏢結算完到回合接著繼續要等多久（ms；同裁判：(F+S)/60 + againPad，四捨五入到 ms）
const resumeDelayMs = (shot) => Math.round(((shot.flightFrames + shot.settleFrames) / 60 + CONFIG.TIMING.againPad) * 1000);
// 斷線代打的對照：沒有鎖定的話這位一定挑大砲（不靠 config 的狙擊機率，只用飛鏢就是鎖定的關係）；不走路
const cannonFirstAi = (p) => { p.ai = { ...CONFIG.ENEMY, sniperChance: 0, moveChance: 0 }; };

// ---------- 裁判 ----------

test('裁判：第一支飛鏢 → shot 帶 shotsLeft 2、結算中；(F+S)/60 + againPad 後同一回合接著繼續（resume：剩下的秒數 = 開火那一刻剩的，飛行不算），記 turn.resume', () => {
  const { m, io, ref, p1 } = dartTurn();
  io.advance(5000);   // 回合先用掉 5 秒
  const left = (ref.deadline - io.t) / 1000;
  const turns0 = p1.turnCount;
  const shot = fireDart(ref, io, p1);
  assert(shot.weapon === 'darts' && shot.shotsLeft === 2, 'shot broadcast carries shotsLeft 2: ' + shot.shotsLeft);
  assert(ref.phase === 'resolving' && ref.deadline === null && ref.lockWeapon === 'darts' && ref.shotsLeft === 2, `resolving: ${ref.phase} lock ${ref.lockWeapon} ${ref.shotsLeft}`);
  const sr = io.recs('shot').at(-1);
  assert(sr && sr.weapon === 'darts' && sr.shotsLeft === 2, 'shot record carries shotsLeft: ' + JSON.stringify(sr));
  const wait = resumeDelayMs(shot);
  io.advance(wait - 1);
  assert(ref.phase === 'resolving' && !io.take('resume').length && !io.recs('turn.resume').length, 'not resumed before (F+S)/60 + againPad');
  io.advance(1);
  const resumes = io.take('resume');
  assert(resumes.length === 1 && ref.phase === 'turn' && ref.currentId === 'p1', `resumed: ${resumes.length} ${ref.phase} ${ref.currentId}`);
  const r = resumes[0];
  assert(r.actorId === 'p1' && r.weapon === 'darts' && r.shotsLeft === 2, 'resume payload: ' + JSON.stringify({ ...r, entities: undefined }));
  assert(Math.abs(r.timeLeft - left) < 1e-9, `timer paused during the flight: timeLeft ${r.timeLeft} vs ${left} left at fire`);
  assert(Math.abs(ref.deadline - (io.t + left * 1000)) < 1e-6, 'deadline = now + the seconds left at fire');
  assert(Array.isArray(r.entities) && r.entities.length === m.entities.length && r.entities.some(e => e.id === 'p1' && e.x === p1.x && e.y === p1.y), 'resume carries the entities');
  const tr = io.recs('turn.resume');
  assert(tr.length === 1 && tr[0].actor === 'p1' && tr[0].pid === 'p1' && tr[0].weapon === 'darts' && tr[0].shotsLeft === 2 && tr[0].timeLeft === r1(left),
    'turn.resume record: ' + JSON.stringify(tr[0]));
  // 不是新的回合：沒有新的 turn、回合沒有結束、回合數沒加
  assert(io.take('turn').length === 1 && io.recs('turn.start').length === 1 && !io.recs('turn.end').length && p1.turnCount === turns0,
    `not a new turn: turns ${io.take('turn').length}, turn.end ${io.recs('turn.end').length}, turnCount ${p1.turnCount}`);
  return { F: shot.flightFrames, S: shot.settleFrames, waitMs: wait, timeLeft: r.timeLeft };
});

test('兩支之間：換別把 / 開別把 → action.ignored weaponLocked（被擋下的開火不會移動他）；可以移動、體力接著扣（不回滿）', () => {
  const { io, ref, p1 } = dartTurn();
  const max = p1.maxStamina;
  ref.handle('p1', { t: 'move', x: p1.x, y: p1.y, facing: 1, stamina: max - 20 });   // 第一支之前先花掉一點體力
  assert(p1.stamina === max - 20, 'stamina spent before the first dart');
  const shot = fireDart(ref, io, p1);
  io.advance(resumeDelayMs(shot));
  assert(ref.phase === 'turn' && ref.lockWeapon === 'darts', 'resumed');
  const rs = io.take('resume')[0].entities.find(e => e.id === 'p1');
  assert(p1.stamina === max - 20 && rs.stamina === max - 20, `stamina not refilled on resume: ${p1.stamina} / ${rs.stamina} (max ${max})`);
  // 換別把：擋下、記 weaponLocked，手上還是飛鏢、不廣播
  const nW = io.take('weapon').length;
  ref.handle('p1', { t: 'weapon', weapon: 'cannon' });
  const ig = io.recs('action.ignored').at(-1);
  assert(ig && ig.t === 'weapon' && ig.reason === 'weaponLocked' && ig.weapon === 'cannon', 'weapon switch ignored: ' + JSON.stringify(ig));
  assert(p1.weapon === 'darts' && io.take('weapon').length === nW, `still holding darts (${p1.weapon}), no weapon broadcast`);
  // 用別把開火（回報的位置也動了）：在位置回報之前就擋下，他沒被移動、沒有開火紀錄、沒有新的一發
  const x0 = p1.x, y0 = p1.y, f0 = p1.facing, nShots = io.take('shot').length, nFire = io.recs('fire').length;
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: x0 + 6, y: y0, facing: -f0, stamina: max - 40 });
  const ig2 = io.recs('action.ignored').at(-1);
  assert(ig2 && ig2.t === 'fire' && ig2.reason === 'weaponLocked' && ig2.weapon === 'cannon', 'cannon fire ignored: ' + JSON.stringify(ig2));
  assert(p1.x === x0 && p1.y === y0 && p1.facing === f0 && p1.stamina === max - 20, `rejected fire moved him: ${[p1.x, p1.y, p1.facing, p1.stamina]} vs ${[x0, y0, f0, max - 20]}`);
  assert(ref.phase === 'turn' && io.take('shot').length === nShots && io.recs('fire').length === nFire, 'no shot from the locked-out weapon');
  // 兩支之間照樣能走：收下、記 move、體力接著扣
  ref.handle('p1', { t: 'move', x: x0 + 6, y: y0, facing: 1, stamina: max - 30 });
  const mv = io.recs('move').at(-1);
  assert(mv && mv.x === r1(x0 + 6) && p1.x === x0 + 6 && p1.stamina === max - 30, `move between darts: ${JSON.stringify(mv)} stamina ${p1.stamina}`);
  // 下一支從新的位置射出
  const shot2 = fireDart(ref, io, p1);
  assert(shot2.shotsLeft === 1 && shot2.actor.x === x0 + 6 && p1.stamina <= max - 30, `second dart from the new spot: ${shot2.actor.x} shotsLeft ${shot2.shotsLeft}`);
  return { stamina: [max, max - 20, max - 30] };
});

test('第三支飛鏢結束回合（換下一位、不再 resume）；三支各算一次開火（shots +3）；下一個回合鎖定清掉，可以開大砲', () => {
  const { io, ref, p1 } = dartTurn();
  const shots0 = p1.shots;
  let last = null;
  for (let k = 1; k <= 3; k++) {
    last = fireDart(ref, io, p1);
    assert(last.shotsLeft === 3 - k && ref.shotsLeft === 3 - k, `dart ${k}: shotsLeft ${last.shotsLeft} / ${ref.shotsLeft}`);
    if (k < 3) {
      io.advance(resumeDelayMs(last));
      assert(ref.phase === 'turn' && io.take('resume').length === k, `resumed after dart ${k}`);
    }
  }
  const darts = p1.shots - shots0;
  assert(darts === 3, `each dart counts as a shot: ${darts}`);
  // 第三支之後不再接著：resume 的時間點還在結算中，接著照一般開火的節奏結束這回合
  io.advance(resumeDelayMs(last));
  assert(ref.phase === 'resolving' && io.take('resume').length === 2 && io.recs('turn.resume').length === 2, `no resume after the last dart (phase ${ref.phase})`);
  assert(advanceUntil(io, () => io.take('turn').length >= 2, 20_000), 'next turn');
  const next = io.take('turn')[1];
  const ends = io.recs('turn.end');
  assert(next.actorId === 'e1' && ends.length === 1 && ends[0].actor === 'p1', `turn ended → next actor: ${next.actorId}, turn.end ${JSON.stringify(ends.map(e => e.actor))}`);
  assert(ref.lockWeapon === null && ref.shotsLeft === null, 'lock cleared for the next actor');
  // p1 的下一個回合：沒有鎖定，可以開大砲
  assert(advanceUntil(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 again');
  const st = J(ref.statePayload());
  assert(st.lockWeapon === null && st.shotsLeft === null && ref.lockWeapon === null && ref.shotsLeft === null, 'next turn starts unlocked: ' + JSON.stringify([st.lockWeapon, st.shotsLeft]));
  const n = io.take('shot').length;
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: p1.x, y: p1.y, facing: 1, stamina: p1.stamina });
  const s = io.take('shot');
  assert(s.length === n + 1 && s.at(-1).weapon === 'cannon' && !('shotsLeft' in s.at(-1)) && ref.phase === 'resolving', 'cannon fires normally on the next turn: ' + JSON.stringify(io.recs('action.ignored').at(-1) || null));
  return { shots: darts, next: next.actorId };
});

test('resume 之後時間到 → turn.skip timeout：從 resume 起算剩下的秒數（原本的截止時間過了也還沒到）', () => {
  const { io, ref, p1 } = dartTurn();
  io.advance(5000);
  const orig = ref.deadline;
  const left = (orig - io.t) / 1000;
  const shot = fireDart(ref, io, p1);
  io.advance(resumeDelayMs(shot));
  assert(ref.phase === 'turn' && io.take('resume').length === 1, 'resumed');
  const tR = io.t;
  io.advance(left * 1000 - 1);
  assert(io.t > orig && ref.phase === 'turn' && !io.take('skip').length && !io.recs('turn.skip').length, `still the same turn past the original deadline (${orig} < ${io.t})`);
  io.advance(1);
  const skip = io.take('skip');
  const rec = io.recs('turn.skip');
  assert(skip.length === 1 && skip[0].actorId === 'p1' && skip[0].reason === 'timeout', 'skip broadcast: ' + JSON.stringify(skip.map(s => [s.actorId, s.reason])));
  assert(rec.length === 1 && rec[0].pid === 'p1' && rec[0].reason === 'timeout' && rec[0].at === tR + left * 1000, 'turn.skip timeout record: ' + JSON.stringify(rec[0]));
  return { resumedAt: tR, timeoutAt: rec[0].at, originalDeadline: orig };
});

test('飛鏢打倒最後一個敵人 → gameOver（win），不 resume；這一發之後他自己倒下了 → 不 resume，換下一位', () => {
  const { m, io, ref, p1 } = dartTurn();
  m.byId('e2').die('hit');
  m.byId('e1').hp = 1;
  const shot = fireDart(ref, io, p1);
  assert(shot.kills.includes('e1') && shot.shotsLeft === 2, 'the dart killed the last enemy: ' + JSON.stringify(shot.kills));
  io.advance(resumeDelayMs(shot));
  assert(!io.take('resume').length && !io.recs('turn.resume').length && ref.phase !== 'turn', 'no resume after the winning dart');
  assert(advanceUntil(io, () => io.take('gameOver').length > 0, 20_000), 'game over');
  assert(io.take('gameOver')[0].result === 'win' && ref.phase === 'over' && !io.take('resume').length, 'win');
  // 兩人：結算完他已經倒下（例如被自己的一發連帶、掉進水裡淹死）→ 不 resume，照平常結束這回合
  const b = dartTurn({ players: 2 });
  const s2 = fireDart(b.ref, b.io, b.p1);
  b.p1.die('hit');
  b.io.advance(resumeDelayMs(s2));
  assert(!b.io.take('resume').length && !b.io.recs('turn.resume').length, 'no resume for a dead thrower');
  assert(advanceUntil(b.io, () => b.io.take('turn').length >= 2, 20_000) && b.io.take('turn')[1].actorId === 'p2', 'next actor p2');
  assert(b.io.recs('turn.end').some(e => e.actor === 'p1' && e.alive === false), 'p1 turn ended');
  return { result: io.take('gameOver')[0].result };
});

test('飛行途中斷線 → 到了 resume 的時間改由 AI 代打：turn.takeover 帶 shotsLeft，代打只能用飛鏢（射一次就結束回合）', () => {
  const { m, io, ref, p1 } = dartTurn({ players: 2 });
  cannonFirstAi(p1);
  const shot = fireDart(ref, io, p1);
  ref.setConnected('p1', false);
  assert(ref.phase === 'resolving' && !io.recs('turn.takeover').length && !io.take('aiTurn').length, 'not taken over mid-flight');
  io.advance(resumeDelayMs(shot) - 1);
  assert(!io.recs('turn.takeover').length, 'not before the resume time');
  // 對照：沒有鎖定的話，同一個場面他會挑大砲
  const free = planShot(m.world, p1, new Rng(1), p1.weapons);
  assert(free && free.weapon === 'cannon', 'control: unlocked takeover would use the cannon: ' + JSON.stringify(free));
  io.advance(1);
  const tk = io.recs('turn.takeover');
  assert(tk.length === 1 && tk[0].pid === 'p1' && tk[0].shotsLeft === 2 && tk[0].alive === true, 'turn.takeover with shotsLeft: ' + JSON.stringify(tk[0]));
  assert(!io.take('resume').length && !io.recs('turn.resume').length, 'no resume for a disconnected thrower');
  const ai = io.take('aiTurn');
  assert(ai.length === 1 && ai[0].actorId === 'p1' && ai[0].shot && ai[0].shot.weapon === 'darts', 'takeover shot uses darts only: ' + JSON.stringify(ai.map(a => a.shot && a.shot.weapon)));
  const rec = io.recs('ai.turn').at(-1);
  assert(rec && rec.pid === 'p1' && rec.takeover === true && rec.weapon === 'darts', 'ai.turn record: ' + JSON.stringify(rec));
  // 代打射一次就結束這回合：換 p2，中間沒有再 resume
  assert(advanceUntil(io, () => io.take('turn').some(t => t.actorId === 'p2'), 20_000), 'next actor p2');
  assert(!io.take('resume').length && io.take('aiTurn').length === 1 && p1.shots === 2, `one takeover shot (shots ${p1.shots})`);
  return { takeover: tk[0].shotsLeft, aiWeapon: ai[0].shot.weapon };
});

test('resume 之後的回合：statePayload 帶 lockWeapon / shotsLeft；這時斷線 → 立刻 AI 代打（turn.takeover 帶 shotsLeft），也只能用飛鏢', () => {
  const { m, io, ref, p1 } = dartTurn({ players: 2 });
  cannonFirstAi(p1);
  io.advance(3000);
  const left = (ref.deadline - io.t) / 1000;
  const shot = fireDart(ref, io, p1);
  io.advance(resumeDelayMs(shot));
  assert(ref.phase === 'turn', 'resumed');
  const st = J(ref.statePayload());
  assert(st.phase === 'turn' && st.currentId === 'p1' && st.lockWeapon === 'darts' && st.shotsLeft === 2 && Math.abs(st.timeLeft - left) < 1e-6,
    'state payload: ' + JSON.stringify({ phase: st.phase, lockWeapon: st.lockWeapon, shotsLeft: st.shotsLeft, timeLeft: st.timeLeft }));
  const free = planShot(m.world, p1, new Rng(1), p1.weapons);
  assert(free && free.weapon === 'cannon', 'control: unlocked takeover would use the cannon');
  ref.setConnected('p1', false);
  const tk = io.recs('turn.takeover');
  assert(tk.length === 1 && tk[0].pid === 'p1' && tk[0].shotsLeft === 2, 'turn.takeover with shotsLeft: ' + JSON.stringify(tk[0]));
  const ai = io.take('aiTurn');
  assert(ai.length === 1 && ai[0].actorId === 'p1' && ai[0].shot && ai[0].shot.weapon === 'darts', 'takeover shot uses darts only: ' + JSON.stringify(ai.map(a => a.shot && a.shot.weapon)));
  assert(io.recs('ai.turn').at(-1).weapon === 'darts', 'ai.turn record weapon');
  return { timeLeft: st.timeLeft };
});

test('時間扭曲的額外回合：上一個回合射過飛鏢（超時結束），額外回合的鎖定是清掉的，可以開大砲', () => {
  const { io, ref, p1 } = dartTurn({ effects: { extraTurn: 1 } });
  const shot = fireDart(ref, io, p1);
  io.advance(resumeDelayMs(shot));
  assert(ref.phase === 'turn' && ref.lockWeapon === 'darts', 'resumed');
  assert(advanceUntil(io, () => io.take('turn').some(t => t.extra) && ref.phase === 'turn', 60_000), 'extra turn');
  const xt = io.take('turn').find(t => t.extra);
  assert(xt.actorId === 'p1' && ref.extraTurn && io.recs('turn.skip').some(s => s.pid === 'p1' && s.reason === 'timeout'), 'the dart turn timed out, then the extra turn');
  const st = J(ref.statePayload());
  assert(ref.lockWeapon === null && ref.shotsLeft === null && st.lockWeapon === null && st.shotsLeft === null, `extra turn unlocked: ${ref.lockWeapon} ${ref.shotsLeft}`);
  const n = io.take('shot').length;
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: p1.x, y: p1.y, facing: 1, stamina: p1.stamina });
  const s = io.take('shot');
  assert(s.length === n + 1 && s.at(-1).weapon === 'cannon' && !('shotsLeft' in s.at(-1)), 'cannon fires in the extra turn: ' + JSON.stringify(io.recs('action.ignored').at(-1) || null));
  return { extra: xt.actorId };
});

// ---------- 真的 GameView ----------

// 在 Node 裡建一個真的 GameView（假 canvas）。performance.now 換成假時鐘：每個 update 走 1/60 秒
let clock = 1000;
function makeView() {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.sent = [];
  view.transport = { send: (msg) => view.sent.push(J(msg)) };
  return view;
}
// 把畫面上排著的事件播完（每個 update 之後呼叫 onUpdate），回傳 update 的次數
function drive(view, onUpdate = null, max = 5000) {
  let n = 0;
  while (view.script && n < max) {
    clock += 1000 / 60;
    view.update(CONFIG.FIXED_DT);
    n++;
    if (onUpdate) onUpdate();
  }
  return n;
}
const sentOf = (view, t) => view.sent.filter(x => x.t === t);

test('真的 GameView：飛鏢的 shot 後面緊接著 resume → 重播完才能動、截止時間從收到 resume 算；只能用飛鏢（selectWeapon 擋、fire 一定送飛鏢、重連的 state 也帶鎖定）；下一個 turn 清掉鎖定', () => {
  const realNow = Object.getOwnPropertyDescriptor(performance, 'now');
  performance.now = () => clock;
  try {
    const m = matchWith({}, { players: 1 });
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: mkPlayers(1), io });
    ref.start();
    const view = makeView();
    const feed = (msgs) => { for (const x of msgs) view.onMessage(x); };
    feed(io.log.splice(0));
    io.advance(CONFIG.TIMING.startDelay * 1000);
    feed(io.log.splice(0));
    drive(view);
    assert(view.canAct && view.currentId === 'p1' && view.lockWeapon === null && view.me.weapon === 'darts', 'my turn, darts in hand, unlocked');

    // 第一支：畫面送 fire → 裁判結算、等飛行時間後 resume；畫面同時收到 shot 與 resume
    const me = view.me;
    me.aimAngle = 0; me.aimPower = 50;
    view.fire();
    const f1 = sentOf(view, 'fire').at(-1);
    assert(f1 && f1.weapon === 'darts' && !view.canAct && view.waiting, 'fire sent');
    ref.handle('p1', f1);
    const shot = io.take('shot').at(-1);
    io.advance(resumeDelayMs(shot));
    const resume = io.take('resume').at(-1);
    assert(shot && shot.shotsLeft === 2 && resume && resume.shotsLeft === 2 && ref.phase === 'turn', 'server resumed the turn');
    const st = J({ t: 'state', ...ref.statePayload() });   // 這時重連的人拿到的完整狀態（下面用另一個畫面驗）
    io.log.length = 0;
    const tRecv = clock;
    view.onMessage(shot);
    view.onMessage(resume);
    // resume 排在重播後面，還沒套上；鎖定由 shot 本身帶：重播中就換不了武器
    assert(!view.canAct && view.queue.some(x => x.t === 'resume'), 'resume waits behind the replay');
    assert(view.lockWeapon === 'darts' && view.shotsLeft === 2, `locked by the shot during the replay: ${view.lockWeapon} ${view.shotsLeft}`);
    const nW = sentOf(view, 'weapon').length;
    view.selectWeapon('cannon');
    assert(view.me.weapon === 'darts' && sentOf(view, 'weapon').length === nW, 'cannot switch to the cannon during the replay');
    const states = [];
    const n = drive(view, () => states.push({ script: !!view.script, canAct: view.canAct }));
    const F = shot.flightFrames, S = shot.settleFrames;
    assert(n >= F + S && states.filter(s => s.script).every(s => !s.canAct), `canAct stayed false during the replay (${n} updates, F+S ${F + S})`);
    assert(!states.at(-1).script && view.canAct && view.currentId === 'p1' && !view.waiting, 'can act right after the replay finished');
    assert(clock - tRecv >= (F + S) * 1000 / 60, 'the replay took time on the clock');
    assert(Math.abs(view.deadline - (tRecv + resume.timeLeft * 1000)) < 1e-6,
      `deadline counted from when resume arrived: ${view.deadline} vs ${tRecv + resume.timeLeft * 1000} (applied at ${clock})`);
    assert(view.lockWeapon === 'darts' && view.shotsLeft === 2, 'lock after resume');
    const deadlineFromRecv = Math.round(view.deadline - tRecv);
    // 自己的回合（鎖定中）：換大砲被擋（手上還是飛鏢、不送 weapon）；就算手上的武器被換掉了，fire 也一定送飛鏢
    view.selectWeapon('cannon');
    assert(view.me.weapon === 'darts' && sentOf(view, 'weapon').length === nW && view.hint, 'selectWeapon(cannon) refused on my locked turn');
    view.me.weapon = 'cannon';
    view.me.aimAngle = 0; view.me.aimPower = 50;
    view.fire();
    const f2 = sentOf(view, 'fire').at(-1);
    assert(f2 !== f1 && f2.weapon === 'darts' && view.me.weapon === 'darts', 'fire sends darts while locked: ' + (f2 && f2.weapon));

    // 重連：state 帶 lockWeapon / shotsLeft，新的畫面一樣鎖著
    const v2 = makeView();
    v2.onMessage(st);
    assert(v2.canAct && v2.lockWeapon === 'darts' && v2.shotsLeft === 2 && v2.me.weapon === 'darts', `reconnect restores the lock: ${v2.lockWeapon} ${v2.shotsLeft}`);
    v2.selectWeapon('cannon');
    assert(v2.me.weapon === 'darts' && !sentOf(v2, 'weapon').length, 'reconnected view refuses the cannon too');

    // 第二支 → resume（剩 1 次）→ 第三支 → 換下一位（e1 的 turn）：鎖定清掉
    ref.handle('p1', f2);
    const shot2 = io.take('shot').at(-1);
    io.advance(resumeDelayMs(shot2));
    feed(io.log.splice(0));
    drive(view);
    assert(view.canAct && view.lockWeapon === 'darts' && view.shotsLeft === 1, `second resume: ${view.shotsLeft}`);
    view.me.aimAngle = 0; view.me.aimPower = 50;
    view.fire();
    ref.handle('p1', sentOf(view, 'fire').at(-1));
    assert(io.take('shot').at(-1).shotsLeft === 0, 'third dart');
    assert(advanceUntil(io, () => io.take('turn').length > 0, 20_000), 'next turn on the server');
    const upTo = io.log.findIndex(x => x.t === 'turn');
    feed(io.log.slice(0, upTo + 1));
    drive(view);
    assert(view.currentId === 'e1' && !view.canAct && view.lockWeapon === null && view.shotsLeft === null, `turn clears the lock: ${view.currentId} ${view.lockWeapon} ${view.shotsLeft}`);
    return { replayUpdates: n, F, S, deadlineFromRecv };
  } finally {
    if (realNow) Object.defineProperty(performance, 'now', realNow);
    else delete performance.now;
  }
});

// 產品的 bug（2026-10-08 寫測試時發現，還沒修）：額外回合開始時的無差別轟炸（shotScript 的 look 分支：新的回合已經開始了）
// 沒有清掉上一個回合射完三支飛鏢留下的鎖定（shotsLeft 0），要等之後的 turn 才清；伺服器在 nextTurn 就清掉了。
// 結果：轟炸播放中按武器鍵預選大砲會被擋下，還提示「這回合只能用飛鏢」
test('真的 GameView：射完三支飛鏢後，時間扭曲額外回合開始時的無差別轟炸（已經是新的回合）不再鎖定飛鏢（伺服器在 nextTurn 就清掉了）', () => {
  const m = matchWith({ extraTurn: 1, bombard: 1 }, { players: 1 });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  ref.start();
  const view = makeView();
  const feedAll = () => { for (const x of io.log.splice(0)) view.onMessage(x); drive(view); };
  assert(advanceUntil(io, () => ref.phase === 'turn' && ref.currentId === 'p1', 20_000), 'p1 turn (after his bombard)');
  feedAll();
  const p1 = m.byId('p1');
  p1.bombardCd = 0;   // 無差別轟炸有冷卻（10-08）：直接當作冷卻好了，額外回合開始時才會再轟炸一次（這個測試要的情境）
  for (let k = 0; k < 3; k++) {
    ref.handle('p1', { t: 'fire', weapon: 'darts', angle: 0, power: 50, x: p1.x, y: p1.y, facing: 1, stamina: p1.stamina });
    assert(advanceUntil(io, () => ref.phase === 'turn', 20_000), `back to a turn after dart ${k + 1}`);
  }
  assert(ref.currentId === 'p1' && ref.extraTurn && ref.lockWeapon === null, 'server: the extra turn is unlocked');
  const msgs = io.log.splice(0);
  const iB = msgs.findIndex(x => x.t === 'shot' && x.kind === 'bombard');
  assert(iB > 0 && msgs.slice(iB + 1).some(x => x.t === 'turn' && x.extra), 'the extra turn starts with a bombard: ' + msgs.map(x => x.t).join());
  for (const x of msgs.slice(0, iB)) view.onMessage(x);
  drive(view);
  view.onMessage(msgs[iB]);   // 額外回合的轟炸開始播（turn 還在後面）
  for (let k = 0; k < 10; k++) view.update(CONFIG.FIXED_DT);
  assert(view.script && view.currentId === 'p1', 'replaying the extra-turn bombard');
  view.selectWeapon('cannon');
  assert(view.lockWeapon === null && view.me.weapon === 'cannon',
    `still locked from the previous turn during the new turn's bombard: lockWeapon ${view.lockWeapon}, shotsLeft ${view.shotsLeft}, selectWeapon(cannon) → ${view.me.weapon}${view.hint ? '（' + view.hint.text + '）' : ''}`);
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
