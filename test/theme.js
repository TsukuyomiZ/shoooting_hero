// node test/theme.js
// 2026-11-02：主題副本（設定 config.THEMES，換算在 shared/game/stage-rules.js、每一關的地圖在 shared/game/themes.js）。第一個主題「莫利亞森林」：11 關、第 2、4、7、9 關菁英、第 5 關古樹之庭、第 10 關叢林巨蟒、
// 第 11 關主題王（2026-11-04 大地祭壇的大地之母・蓋亞做好了 → 開放；主題王沒排的話不開放）。主題的資料（每一關排得到的地圖、開放與否、亂送的 id）、
// 關卡設定（關數 / 菁英 / Boss 關換成主題的；菁英之路只留傷害不打折）、大廳的說明、一整場主題冒險（地圖只從主題的清單抽、王關固定、訊息與紀錄帶主題）、
// 主題王沒排時打到第 11 關會丟錯、伺服器的房間（沒開放的主題當一般冒險；開放了建房 / 列表 / 開始的冒險 / 紀錄都帶主題）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/core/config.js';
import { Run } from '../shared/game/run.js';
import { stageRules, stageType, runConfig, difficultyDesc, themeOf, themeDesc } from '../shared/game/stage-rules.js';
import { themeLevels, themeReady, openTheme, openThemes } from '../shared/game/themes.js';
import { LEVELS } from '../shared/maps/level.js';
import { validateCards } from '../shared/cards/cards.js';
import { RoomManager } from '../server/rooms.js';

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

// 測試自己的一份設定（使用者在 config 調了也不影響）：一般冒險 10 關、第 5、10 關 Boss、第 3、8 關菁英、前 5 關 7 折
const T = {
  ...CONFIG,
  RUN: { ...CONFIG.RUN, stageCount: 10, bossStages: [5, 10], eliteStages: [3, 8], bossHpPerStage: 0.15 },
  ENEMY: { ...CONFIG.ENEMY, damageMult: 0.7, lateFromStage: 6, damageMultLate: 1 },
  DIFFICULTY: { normal: { name: '一般' }, elite: { name: '菁英之路', eliteStages: [2, 3, 4, 7, 8, 9], enemyDamage: 1, rangeHints: false } },
};
const M = CONFIG.THEMES.moria;
const TYPES = 'normal,elite,normal,elite,boss,normal,elite,normal,elite,boss,boss';

// 暫時換掉第 11 關的主題王（null = 還沒排 → 主題不開放；不存在的 id），跑完還原
async function withFinale(levelId, fn) {
  const saved = M.bosses[11];
  M.bosses[11] = levelId;
  try { return await fn(); } finally { M.bosses[11] = saved; }
}

await test('莫利亞森林：11 關、第 2、4、7、9 關菁英（大樹守衛、大樹遊俠、調皮妖精、頑皮猴王）、第 5 關古樹之庭、第 10 關叢林巨蟒、小關只抽森林地圖；地圖都存在', () => {
  assert(M.name === '莫利亞森林' && M.stageCount === 11, 'name / stageCount');
  const c = runConfig({ theme: 'moria' }, T);
  assert(Array.from({ length: 11 }, (_, i) => stageType(i + 1, c)).join() === TYPES, 'types');
  assert(J(themeLevels('moria', 5)) === J(['treeGarden']) && J(themeLevels('moria', 10)) === J(['jungleSerpent']), 'bosses');
  for (const s of [2, 4, 7, 9]) assert(J(themeLevels('moria', s)) === J(['forestGuard', 'forestRanger', 'forestFairy', 'forestMonkey']), 'elite ' + s);
  for (const s of [1, 3, 6, 8]) {
    const list = themeLevels('moria', s);
    assert(list.length >= 4 && list.every(id => LEVELS[id] && LEVELS[id].theme === 'forest' && LEVELS[id].pool === 'normal'), 'normal ' + s + ' ' + J(list));
  }
  for (const id of ['fallenLog', 'treehouse']) assert(M.maps.normal.includes(id), 'new forest map ' + id);
  return { normal: M.maps.normal };
});

await test('開放：第 11 關的主題王 = 大地祭壇（蓋亞，Boss 池但只有主題排得到）→ themeReady、openTheme / openThemes 有它；主題王沒排 / 排了不存在的地圖就不開放；亂送的主題 id 都是 null', async () => {
  assert(M.bosses[11] === 'gaiaSanctum' && J(themeLevels('moria', 11)) === J(['gaiaSanctum']), 'finale ' + M.bosses[11]);
  assert(LEVELS.gaiaSanctum && LEVELS.gaiaSanctum.pool === 'boss' && LEVELS.gaiaSanctum.themeOnly === true, 'theme-only boss level');
  assert(themeReady('moria') && openTheme('moria') === 'moria' && openThemes().includes('moria'), 'open');
  await withFinale(null, () => {
    assert(J(themeLevels('moria', 11)) === '[]' && !themeReady('moria') && openTheme('moria') === null && !openThemes().includes('moria'), 'no finale → not open');
  });
  await withFinale('nope', () => assert(!themeReady('moria'), 'unknown level id is not ready'));
  for (const bad of [undefined, null, 'nope', 'toString', { toString: 0 }, ['moria'], 3]) {
    assert(themeOf(bad) === null && openTheme(bad) === null && !themeReady(bad) && J(themeLevels(bad, 1)) === '[]', 'bad id ' + J(bad));
  }
});

await test('關卡設定：主題蓋掉關數與菁英 / Boss 關的位置（不改原本那份設定）；菁英之路在主題裡只留傷害不打折、菁英關照主題；王的血量照主題的 Boss 關成長', () => {
  const n = runConfig({ theme: 'moria' }, T), e = runConfig({ difficulty: 'elite', theme: 'moria' }, T);
  assert(T.RUN.stageCount === 10 && J(T.RUN.eliteStages) === J([3, 8]), 'T untouched');
  assert(runConfig({}, T) === T && runConfig({ theme: 'nope' }, T) === T, 'no theme → same config');
  for (const c of [n, e]) {
    assert(c.RUN.stageCount === 11 && J(c.RUN.eliteStages) === J([2, 4, 7, 9]) && J(c.RUN.bossStages) === J([5, 10, 11]), 'stages ' + J(c.RUN));
  }
  const dmg = (c) => Array.from({ length: 11 }, (_, i) => stageRules({ stage: i + 1 }, c).enemyDamage).join();
  assert(dmg(n) === '0.7,0.7,0.7,0.7,0.7,1,1,1,1,1,1', 'normal damage ' + dmg(n));
  assert(dmg(e) === '1,1,1,1,1,1,1,1,1,1,1', 'elite road damage ' + dmg(e));
  const boss = (s) => Math.round(stageRules({ stage: s, pool: 'boss' }, n).bossHp * 100) / 100;
  assert(boss(5) === 1 && boss(10) === 1.75 && boss(11) === 1.9, `boss hp ${boss(5)} / ${boss(10)} / ${boss(11)}`);
  // 大廳的說明照主題的菁英關
  assert(difficultyDesc('normal', T, 'moria') === '菁英關：第 2、4、7、9 關　敵人傷害：第 1 ~ 5 關打 7 折', difficultyDesc('normal', T, 'moria'));
  assert(difficultyDesc('elite', T, 'moria') === '菁英關：第 2、4、7、9 關　敵人傷害：整場不打折', difficultyDesc('elite', T, 'moria'));
  assert(difficultyDesc('elite', T) === '菁英關：第 2 ~ 4、7 ~ 9 關　敵人傷害：整場不打折', 'no theme unchanged');
  assert(themeDesc('moria', T) === '莫利亞森林：11 關同一種地形，第 5、10 關 Boss，最後一關主題王' && themeDesc('nope', T) === '', themeDesc('moria', T));
});

// 一整場主題冒險（每關一開打就把敵人全部打倒、選第一張牌），回傳每關的關卡
function playRun({ difficulty = 'normal', seed = 3, players = 2 } = {}) {
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(players), seed, io, cards: CARDS.cards, config: T, difficulty, theme: 'moria' });
  run.start();
  const stages = [];
  let guard = 0;
  while (run.phase !== 'over' && guard++ < 1000) {
    io.advance(200);
    if (run.phase === 'battle' && run.referee.phase === 'turn') {
      if (!stages.length || stages.at(-1).stage !== run.stage) {
        stages.push({ stage: run.stage, level: run.match.levelId, type: run.stageType, dmg: run.match.rules.enemyDamage });
      }
      for (const e of run.match.enemies) e.die('hit');
      io.advance(31_000);
    }
    if (run.phase === 'pick') {
      for (const id of run.players.keys()) run.handle(id, { t: 'pick', cardId: run.offers[id][0].id });
      io.advance(CONFIG.RUN.pickTime * 1000 + 100);
    }
  }
  return { io, run, stages };
}

await test('一整場莫利亞森林：11 關照主題排、王關固定（第 11 關大地祭壇）、小關只抽主題的森林地圖（整場不重複）、四個菁英關四張菁英地圖各一次；stageInfo、runOver、紀錄都帶主題；菁英之路的菁英關不變', async () => {
  const out = [];
  {
    for (const [difficulty, seed] of [['normal', 3], ['normal', 4], ['elite', 5], ['elite', 6]]) {
      const { io, run, stages } = playRun({ difficulty, seed });
      assert(run.phase === 'over' && run.result === 'win' && run.theme === 'moria' && run.stageCount === 11, 'won ' + run.result);
      assert(stages.map(s => s.type).join() === TYPES, 'types ' + stages.map(s => s.type));
      assert(stages[4].level === 'treeGarden' && stages[9].level === 'jungleSerpent' && stages[10].level === 'gaiaSanctum', 'bosses ' + J(stages.map(s => s.level)));
      const elites = stages.filter(x => x.type === 'elite').map(s => s.level);
      assert(elites.every(id => M.maps.elite.includes(id)) && new Set(elites).size === 4, 'elite ' + elites);   // 四張菁英地圖、四個菁英關：各打一次
      for (const s of stages.filter(x => x.type === 'normal')) assert(M.maps.normal.includes(s.level), 'normal ' + s.level);
      const normals = stages.filter(x => x.type === 'normal').map(s => s.level);
      // 整場小關都不重複（2026-11-02 使用者）：4 個小關剛好 4 張森林小地圖各一次
      assert(new Set(normals).size === normals.length && normals.length === M.maps.normal.length, 'normal maps repeat: ' + normals);
      if (difficulty === 'elite') assert(stages.every(s => s.dmg === 1), 'elite road damage ' + J(stages.map(s => s.dmg)));
      const starts = io.take('start');
      assert(starts.length === 11 && starts.every(s => s.stageInfo.theme === 'moria' && s.stageInfo.stageCount === 11), 'stageInfo.theme');
      assert(io.take('runOver')[0].theme === 'moria' && io.take('runOver')[0].stageCount === 11, 'runOver');
      assert(io.records.filter(r => r.ev === 'stage.start').every(r => r.theme === 'moria'), 'stage.start logged');
      assert(io.records.find(r => r.ev === 'run.over').theme === 'moria', 'run.over logged');
      out.push(normals.join('/'));
    }
  }
  return { normals: out };
});

await test('第 11 關：打完第 10 關（叢林巨蟒）之後進大地祭壇（蓋亞的血量 × 第 11 關 1.9）；主題王沒排的話會丟錯（不會亂抽一張）；一般冒險（沒給主題）照舊 10 關、訊息不帶主題', async () => {
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(1), seed: 7, io, cards: CARDS.cards, config: T, theme: 'moria' });
  run.stage = 10;
  run.nextStage();
  assert(run.stage === 11 && run.match.levelId === 'gaiaSanctum' && run.isLastStage, 'stage 11 ' + run.match.levelId);
  assert(Math.round(run.match.rules.bossHp * 100) / 100 === 1.9 && run.match.byId('gaia').maxHp === Math.round(CONFIG.GAIA.hp * 1.9), 'boss hp ' + run.match.byId('gaia').maxHp);
  run.stop();
  await withFinale(null, () => {
    const closed = new Run({ players: mkPlayers(1), seed: 7, io: new FakeIo(), cards: CARDS.cards, config: T, theme: 'moria' });
    closed.stage = 10;
    let err = null;
    try { closed.nextStage(); } catch (e) { err = e; }
    assert(err && /莫利亞|moria/.test(err.message) && /11/.test(err.message), 'throws ' + (err && err.message));
  });
  const plain = new Run({ players: mkPlayers(1), seed: 7, io: new FakeIo(), cards: CARDS.cards, config: T });
  plain.start();
  assert(plain.theme === null && plain.stageCount === 10 && !('theme' in plain.stageInfo()), 'plain run');
  plain.stop();
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

await test('房間：主題沒開放時建主題副本的房間 = 一般冒險（不帶主題）；開放了 → lobby、大廳列表、room.create / room.start 紀錄帶主題，開始的冒險是 11 關、難度照選的', async () => {
  // 沒開放（暫時拿掉第 11 關的主題王）
  await withFinale(null, () => {
    const { mgr, lines, conn } = manager();
    const c = conn();
    mgr.onMessage(c, { t: 'hello', name: '甲' });
    mgr.onMessage(c, { t: 'create', name: '甲', mode: 'theme', theme: 'moria', difficulty: 'elite' });
    const lobby = c.sent.filter(m => m.t === 'lobby').at(-1);
    assert(!lobby.mode && !lobby.theme && lobby.difficulty === 'elite' && c.room.mode === 'coop' && c.room.theme === null, 'closed → coop ' + J(lobby));
    assert(!('theme' in lines.find(l => l.ev === 'room.create')), 'room.create without theme');
    for (const r of [...mgr.rooms.values()]) mgr.destroyRoom(r, 'shutdown');
  });
  // 開放了（第 11 關 = 大地祭壇）
  await withFinale('gaiaSanctum', () => {
    const { mgr, lines, conn } = manager();
    const watcher = conn();
    mgr.onMessage(watcher, { t: 'hello', name: '看' });
    mgr.onMessage(watcher, { t: 'browse', on: true });
    const a = conn();
    mgr.onMessage(a, { t: 'hello', name: '甲' });
    mgr.onMessage(a, { t: 'create', name: '甲', mode: 'theme', theme: 'moria', difficulty: 'elite' });
    const b = conn();
    mgr.onMessage(b, { t: 'hello', name: '乙' });
    mgr.onMessage(b, { t: 'create', name: '乙', mode: 'theme', theme: { toString: 0 } });
    try {
      const lobby = a.sent.filter(m => m.t === 'lobby').at(-1);
      assert(lobby.mode === 'theme' && lobby.theme === 'moria' && lobby.difficulty === 'elite', 'lobby ' + J(lobby));
      assert(b.room.mode === 'coop' && b.room.theme === null, 'bad theme → coop');
      const list = watcher.sent.filter(m => m.t === 'rooms').at(-1).rooms;
      const row = list.find(r => r.host === '甲');
      assert(row.mode === 'theme' && row.theme === 'moria' && !list.find(r => r.host === '乙').theme, 'rooms ' + J(list));
      const made = lines.find(l => l.ev === 'room.create');
      assert(made.mode === 'theme' && made.theme === 'moria', 'room.create ' + J(made));
      mgr.onMessage(a, { t: 'ready', ready: true });
      mgr.onMessage(a, { t: 'start' });
      const run = a.room.run;
      assert(run.theme === 'moria' && run.difficulty === 'elite' && run.stageCount === 11 && M.maps.normal.includes(run.match.levelId), 'run ' + run.match.levelId);
      const start = a.sent.find(m => m.t === 'start');
      assert(start.stageInfo.theme === 'moria' && start.stageInfo.stageCount === 11, 'start.stageInfo ' + J(start.stageInfo));
      const began = lines.find(l => l.ev === 'room.start');
      assert(began.mode === 'theme' && began.theme === 'moria', 'room.start ' + J(began));
    } finally {
      for (const r of [...mgr.rooms.values()]) mgr.destroyRoom(r, 'shutdown');
    }
  });
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
