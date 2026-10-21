// node test/difficulty.js
// 2026-10-19：難度「菁英之路」（開房 / 單人練習時選，一整場冒險都一樣；設定 config.DIFFICULTY，換算在 shared/game/stage-rules.js 的 difficultyConfig）。
// 難度的設定（認得的 key、亂送的當一般、一般原封不動、不改全域 CONFIG）、菁英之路的關卡種類（第 2、3、4、7、8、9 關是菁英關）、
// 敵人傷害整場不打折（含菁英怪與 Boss）、大廳的說明文字、一整場冒險（每關的關卡規則、菁英池輪流、開場 / 結束的訊息與紀錄帶難度、每個菁英關都有獎勵）、
// 伺服器的房間（建房帶難度、房間 / 大廳列表帶難度、開始的冒險用那個難度、紀錄）、客戶端的難度名字
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/core/config.js';
import { Match } from '../shared/game/match.js';
import { Run } from '../shared/game/run.js';
import { stageRules, stageType, difficultyOf, difficultyConfig, difficultyDesc } from '../shared/game/stage-rules.js';
import { levelsInPool } from '../shared/maps/level.js';
import { validateCards } from '../shared/cards/cards.js';
import { RoomManager } from '../server/rooms.js';
import { difficultyName } from '../client/stage-look.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARDS = validateCards(JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/cards/cards.json'), 'utf8')));
const results = [];
async function test(name, fn) {
  try {
    const info = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${info ? '  ' + JSON.stringify(info) : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const J = JSON.stringify;
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));

class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.records = []; this.seq = 0; }
  broadcast(msg) { this.log.push(JSON.parse(J(msg))); }
  record(ev, data) { this.records.push({ ev, ...JSON.parse(J(data)) }); }
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
}

// 測試自己的一份設定（使用者在 config 調了也不影響）：10 關、第 5、10 關 Boss、一般難度第 3、8 關菁英、前 5 關 7 折；菁英之路照使用者定的
const T = {
  ...CONFIG,
  RUN: { ...CONFIG.RUN, stageCount: 10, bossStages: [5, 10], eliteStages: [3, 8] },
  ENEMY: { ...CONFIG.ENEMY, damageMult: 0.7, lateFromStage: 6, damageMultLate: 1 },
  DIFFICULTY: { normal: { name: '一般' }, elite: { name: '菁英之路', eliteStages: [2, 3, 4, 7, 8, 9], enemyDamage: 1 } },
};
const types = (c) => Array.from({ length: 10 }, (_, i) => stageType(i + 1, c)).join();
const damages = (c, pool = 'normal') => Array.from({ length: 10 }, (_, i) => stageRules({ stage: i + 1, pool }, c).enemyDamage).join();

await test('config：菁英之路是使用者定的（菁英關第 2、3、4、7、8、9 關、敵人傷害整場不打折），一般沒有蓋掉任何東西', () => {
  const D = CONFIG.DIFFICULTY;
  assert(J(Object.keys(D)) === J(['normal', 'elite']) && D.normal.name === '一般' && D.elite.name === '菁英之路', 'keys / names ' + J(D));
  assert(J(D.elite.eliteStages) === J([2, 3, 4, 7, 8, 9]) && D.elite.enemyDamage === 1, 'elite road ' + J(D.elite));
  assert(J(D.normal) === J({ name: '一般' }), 'normal overrides nothing');
});

await test('difficultyOf：認得的 key 照用；沒給、不認得、不是字串、原型上的名字都當一般（亂送的物件不會丟錯）', () => {
  assert(difficultyOf('elite', T) === 'elite' && difficultyOf('normal', T) === 'normal', 'known');
  const junk = [undefined, null, '', 'hard', 'ELITE', 1, true, ['elite'], { toString: 0 }, { toString: () => 'elite' }, '__proto__', 'toString', 'constructor'];
  for (const v of junk) assert(difficultyOf(v, T) === 'normal', 'junk → normal: ' + J(v));
  assert(difficultyOf('elite', { ...T, DIFFICULTY: undefined }) === 'normal', 'no DIFFICULTY table');
});

await test('difficultyConfig：一般原封不動（同一個物件）；菁英之路換掉菁英關與敵人傷害倍率、其他照舊，不改傳進來的設定', () => {
  const before = J(T);
  assert(difficultyConfig('normal', T) === T && difficultyConfig('nope', T) === T, 'normal is the same object');
  const c = difficultyConfig('elite', T);
  assert(c !== T && J(T) === before, 'a new object, input untouched');
  assert(J(c.RUN.eliteStages) === J([2, 3, 4, 7, 8, 9]) && J(c.RUN.bossStages) === J([5, 10]) && c.RUN.stageCount === 10 && c.RUN.enemyHpPerStage === T.RUN.enemyHpPerStage, 'RUN ' + J(c.RUN));
  assert(c.ENEMY.damageMult === 1 && c.ENEMY.hp === T.ENEMY.hp && c.FEVER === T.FEVER && c.WEAPONS === T.WEAPONS, 'ENEMY / rest');
  c.RUN.eliteStages.push(10);
  assert(J(T.DIFFICULTY.elite.eliteStages) === J([2, 3, 4, 7, 8, 9]), 'copies the stage list');
  // 預設讀全域 CONFIG，也不改它
  const g = J({ e: CONFIG.RUN.eliteStages, d: CONFIG.ENEMY.damageMult, l: CONFIG.ENEMY.lateFromStage });
  difficultyConfig('elite');
  assert(J({ e: CONFIG.RUN.eliteStages, d: CONFIG.ENEMY.damageMult, l: CONFIG.ENEMY.lateFromStage }) === g, 'global CONFIG untouched');
});

await test('關卡種類：一般 = 第 3、8 關菁英；菁英之路 = 第 2、3、4、7、8、9 關菁英（只剩第 1、6 關是小關），Boss 關照舊', () => {
  assert(types(T) === 'normal,normal,elite,normal,boss,normal,normal,elite,normal,boss', 'normal ' + types(T));
  const e = difficultyConfig('elite', T);
  assert(types(e) === 'normal,elite,elite,elite,boss,normal,elite,elite,elite,boss', 'elite road ' + types(e));
  // 菁英關排到 Boss 關的那一關照樣算 Boss 關
  const over = difficultyConfig('elite', { ...T, DIFFICULTY: { elite: { eliteStages: [4, 5] } } });
  assert(stageType(5, over) === 'boss' && stageType(4, over) === 'elite', 'boss wins');
  return { elite: types(e) };
});

await test('敵人傷害倍率：一般前 5 關 ×0.7（含菁英、Boss）；菁英之路每一關都是 ×1（小怪、菁英、Boss 都不打折）；血量、狂熱照舊', () => {
  assert(damages(T) === '0.7,0.7,0.7,0.7,0.7,1,1,1,1,1', 'normal ' + damages(T));
  const e = difficultyConfig('elite', T);
  for (const pool of ['normal', 'elite', 'boss']) assert(damages(e, pool) === '1,1,1,1,1,1,1,1,1,1', `elite road ${pool}: ` + damages(e, pool));
  for (const [stage, pool, players] of [[1, 'normal', 1], [3, 'elite', 2], [5, 'boss', 4], [9, 'elite', 3]]) {
    const a = stageRules({ stage, pool, players }, T), b = stageRules({ stage, pool, players }, e);
    assert(a.enemyHp === b.enemyHp && a.bossHp === b.bossHp && a.feverEvery === b.feverEvery && a.feverPct === b.feverPct, `stage ${stage}: only the damage differs`);
  }
});

await test('大廳的難度說明照實際的設定寫：一般「第 3、8 關」「第 1 ~ 5 關打 7 折」、菁英之路「第 2 ~ 4、7 ~ 9 關」「整場不打折」', () => {
  const n = difficultyDesc('normal', T), e = difficultyDesc('elite', T);
  assert(n === '菁英關：第 3、8 關　敵人傷害：第 1 ~ 5 關打 7 折', 'normal ' + n);
  assert(e === '菁英關：第 2 ~ 4、7 ~ 9 關　敵人傷害：整場不打折', 'elite ' + e);
  const odd = { ...T, RUN: { ...T.RUN, eliteStages: [] }, ENEMY: { ...T.ENEMY, damageMult: 0.75, lateFromStage: 0 } };
  assert(difficultyDesc('normal', odd) === '菁英關：沒有　敵人傷害：整場打 7.5 折', 'other numbers ' + difficultyDesc('normal', odd));
  // 客戶端顯示的名字
  assert(difficultyName('elite') === '菁英之路' && difficultyName('normal') === '一般' && difficultyName({ toString: 0 }) === '一般', 'client names');
  return { normal: n, elite: e };
});

// 一整場冒險（全員 AI 代打、每關一開打就把敵人全部打倒、選第一張牌），回傳每關的關卡、關卡規則
function playRun(difficulty, seed = 3) {
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(2), seed, io, cards: CARDS.cards, config: T, difficulty });
  run.start();
  const stages = [];
  let guard = 0;
  while (run.phase !== 'over' && guard++ < 1000) {
    io.advance(200);
    if (run.phase === 'battle' && run.referee.phase === 'turn') {
      if (!stages.length || stages.at(-1).stage !== run.stage) {
        const m = run.match;
        stages.push({ stage: run.stage, level: m.levelId, type: run.stageType, dmg: m.rules.enemyDamage, enemy: m.damageMult(m.enemies[0], CONFIG.WEAPONS.cannon) });
      }
      for (const e of run.match.enemies) e.die('hit');
      io.advance(31_000);
    }
    if (run.phase === 'pick') {
      for (const id of ['p1', 'p2']) run.handle(id, { t: 'pick', cardId: run.offers[id][0].id });
      io.advance(CONFIG.RUN.pickTime * 1000 + 100);
    }
  }
  return { io, run, stages };
}

await test('一整場菁英之路：第 2、3、4、7、8、9 關從菁英池抽（兩張輪著打、不會連續同一張）、每一關敵人傷害 ×1；開場的 stageInfo、runOver、run.over 紀錄都帶難度；每個菁英關打完都有稀有度獎勵', () => {
  const elitePool = levelsInPool('elite');
  const out = [];
  for (const seed of [3, 4, 5, 6]) {
    const { io, run, stages } = playRun('elite', seed);
    assert(run.phase === 'over' && run.result === 'win' && run.difficulty === 'elite', 'won ' + run.result);
    assert(stages.map(s => s.type).join() === 'normal,elite,elite,elite,boss,normal,elite,elite,elite,boss', 'types ' + stages.map(s => s.type));
    const elites = stages.filter(s => s.type === 'elite').map(s => s.level);
    assert(elites.every(id => elitePool.includes(id)) && new Set(elites).size === elitePool.length, 'elite maps ' + elites);
    for (let i = 1; i < stages.length; i++) assert(stages[i].level !== stages[i - 1].level, `no back-to-back repeat: ${stages[i - 1].level} → ${stages[i].level}`);
    // 敵人實際的倍率 = 關卡規則 × 地圖（洞穴的陰影 ×1.3），不會比 1 小
    assert(stages.every(s => s.dmg === 1 && s.enemy >= 1), 'no damage cut: ' + J(stages.map(s => [s.stage, s.dmg, s.enemy])));
    const starts = io.take('start');
    assert(starts.length === 10 && starts.every(s => s.stageInfo.difficulty === 'elite'), 'stageInfo.difficulty');
    assert(io.take('runOver')[0].difficulty === 'elite' && io.records.find(r => r.ev === 'run.over').difficulty === 'elite', 'runOver / run.over');
    const bonus = io.take('stageClear').filter(m => m.bonus).map(m => m.stage).join();
    assert(bonus === '2,3,4,7,8,9', 'bonus after every elite stage: ' + bonus);
    out.push(elites.join('/'));
  }
  return { elites: out };
});

await test('一般難度的冒險照舊：第 3、8 關菁英、前 5 關（含第 5 關 Boss）×0.7、之後 ×1；沒給難度 / 亂給的都是一般', () => {
  for (const difficulty of [undefined, 'normal', 'nope', { toString: 0 }]) {
    const { io, run, stages } = playRun(difficulty);
    assert(run.difficulty === 'normal' && run.result === 'win', 'normal run ' + J(difficulty));
    assert(stages.map(s => s.type).join() === 'normal,normal,elite,normal,boss,normal,normal,elite,normal,boss', 'types');
    assert(stages.map(s => s.dmg).join() === '0.7,0.7,0.7,0.7,0.7,1,1,1,1,1', 'damage ' + stages.map(s => s.dmg));
    assert(io.take('start').every(s => s.stageInfo.difficulty === 'normal'), 'stageInfo says normal');
  }
});

await test('Match 照難度的設定結算：同一發敵人的砲彈，菁英之路第 1 關的傷害是一般的 1 / 0.7 倍', () => {
  const dmgAt = (difficulty) => {
    const m = new Match({ levelId: 'level1', players: mkPlayers(1), seed: 1, stage: 1, config: difficultyConfig(difficulty, T) });
    const p = m.players[0], e = m.enemies[0];
    const hp = p.hp;
    m.applyExplosion(p.x, p.cy, CONFIG.WEAPONS.cannon, e, p);
    return hp - p.hp;
  };
  const n = dmgAt('normal'), e = dmgAt('elite');
  assert(n > 0 && Math.abs(e * 0.7 - n) <= 1, `normal ${n} vs elite ${e}`);
  return { normal: n, elite: e };
});

// ---- 伺服器的房間 ----
function manager() {
  const lines = [];
  const mgr = new RoomManager({ log: { write: (e) => lines.push(e) } });
  const conn = () => {
    const sent = [];
    const c = mgr.onConnection({ readyState: 1, send: (d) => sent.push(JSON.parse(d)), close() {} }, { ip: '1.2.3.4' });
    c.sent = sent;
    return c;
  };
  return { mgr, lines, conn };
}

await test('房間：建房帶 difficulty（不認得的當一般）→ 房間的 lobby、大廳列表、room.create 紀錄都帶難度；開始的冒險用那個難度（room.start 也記）', () => {
  const { mgr, lines, conn } = manager();
  const watcher = conn();
  mgr.onMessage(watcher, { t: 'hello', name: '看' });
  mgr.onMessage(watcher, { t: 'browse', on: true });
  const made = {};
  for (const [name, difficulty] of [['甲', 'elite'], ['乙', undefined], ['丙', { toString: 0 }], ['丁', 'hard']]) {
    const c = conn();
    mgr.onMessage(c, { t: 'hello', name });
    mgr.onMessage(c, { t: 'create', name, difficulty });
    const lobby = c.sent.filter(m => m.t === 'lobby').at(-1);
    made[name] = { c, lobby };
  }
  assert(made.甲.lobby.difficulty === 'elite' && ['乙', '丙', '丁'].every(n => made[n].lobby.difficulty === 'normal'), 'lobby ' + J(Object.values(made).map(x => x.lobby.difficulty)));
  const list = watcher.sent.filter(m => m.t === 'rooms').at(-1).rooms;
  assert(list.length === 4 && list.find(r => r.host === '甲').difficulty === 'elite' && list.filter(r => r.difficulty === 'normal').length === 3, 'rooms ' + J(list));
  const creates = lines.filter(l => l.ev === 'room.create');
  assert(J(creates.map(l => l.difficulty)) === J(['elite', 'normal', 'normal', 'normal']), 'room.create ' + J(creates));
  // 甲開始：冒險用菁英之路
  const a = made.甲.c;
  mgr.onMessage(a, { t: 'ready', ready: true });
  mgr.onMessage(a, { t: 'start' });
  const room = a.room;
  try {
    assert(room.started && room.run.difficulty === 'elite' && room.run.stageType === 'normal' && stageType(2, room.run.config) === 'elite', 'run difficulty');
    assert(room.run.match.rules.enemyDamage === 1, 'stage 1 damage ' + room.run.match.rules.enemyDamage);
    const start = a.sent.find(m => m.t === 'start');
    assert(start && start.stageInfo.difficulty === 'elite', 'start.stageInfo ' + J(start && start.stageInfo));
    assert(lines.find(l => l.ev === 'room.start').difficulty === 'elite', 'room.start logged');
  } finally {
    for (const r of [...mgr.rooms.values()]) mgr.destroyRoom(r, 'shutdown');
  }
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
