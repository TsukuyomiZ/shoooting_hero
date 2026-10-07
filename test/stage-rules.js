// node test/stage-rules.js
// 關卡規則（shared/stage-rules.js）：從（第幾關、人數、地圖池）＋ 一份設定算出這一關的數字——敵人血量倍率（小關 / 王）、
// 敵人傷害倍率、狂熱（幾輪一層、每層幾 %、第幾輪幾層），以及哪幾關是王關；
// 設定可以換一份（Match / Run 收 config，建場時算一次，不讀也不改全域 CONFIG）；
// 狂熱只有一個主人（match.fever 由 match.round 推出，不能直接寫；裁判的輪數就是 match.round）；
// 架構檢查：關卡規則的設定只有 stage-rules.js 讀，沒有人自己算狂熱、寫 fever，客戶端不自己數輪
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/config.js';
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { Run } from '../shared/run.js';
import { stageRules, isBossStage } from '../shared/stage-rules.js';

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
const near = (a, b) => Math.abs(a - b) < 1e-9;
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
// 假的 io：虛擬時鐘，可以快轉
class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.seq = 0; }
  broadcast(msg) { this.log.push(msg); }
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

// 測試自己的一份設定（跟 config.js 的數字都不一樣，算錯地方一定看得出來）
const T = {
  ...CONFIG,
  ENEMY_HP_PER_EXTRA_PLAYER: 0.5,
  RUN: { ...CONFIG.RUN, stageCount: 7, enemyHpPerStage: 0.1, bossStages: [3, 6], bossHpPerStage: 0.2 },
  ENEMY: { ...CONFIG.ENEMY, damageMult: 0.5, lateFromStage: 4, damageMultLate: 0.8 },
  FEVER: { everyRounds: { 1: 5, 3: 4 }, damagePct: 20, inBoss: false },
};

test('stageRules 照設定算出這一關的數字：一般敵人 / 王的血量倍率、敵人傷害倍率、狂熱；isBossStage', () => {
  const small = stageRules({ stage: 3, players: 2, pool: 'normal' }, T);
  assert(near(small.enemyHp, 1.5 * 1.2), 'enemyHp = 人數 × 關數 ' + small.enemyHp);
  assert(near(small.bossHp, 1.5), '小關的 bossHp 只吃人數 ' + small.bossHp);
  assert(small.enemyDamage === 0.5 && small.feverEvery === 5 && small.feverPct === 20, J(small));
  assert([0, 1, 5, 6, 10, 11].map(small.feverAt).join() === '0,0,0,1,1,2', 'fever by round ' + [0, 1, 5, 6, 10, 11].map(small.feverAt));
  assert(stageRules({ stage: 1, players: 3, pool: 'normal' }, T).feverEvery === 4, '3 人照 3 那格');
  // 第二個王關：吃 bossHpPerStage（第 6 關 = 第一個王關 + 3）；敵人傷害換成 damageMultLate；王關沒有狂熱
  const boss = stageRules({ stage: 6, players: 3, pool: 'boss' }, T);
  assert(near(boss.bossHp, 2 * (1 + 0.2 * 3)) && near(boss.enemyHp, 2 * 1.5), `boss scales ${boss.bossHp} / ${boss.enemyHp}`);
  assert(boss.enemyDamage === 0.8 && boss.feverEvery === 0 && boss.feverAt(100) === 0, J(boss));
  assert(near(stageRules({ stage: 4, players: 1, pool: 'boss' }, T).bossHp, 1), '不是排定的王關（測試直接建的王地圖）照原本的血量');
  assert(stageRules({ stage: 6, players: 1, pool: 'boss' }, { ...T, FEVER: { ...T.FEVER, inBoss: true } }).feverAt(6) === 1, 'inBoss 打開王關也有狂熱');
  assert(isBossStage(3, T) && isBossStage(6, T) && !isBossStage(5, T), 'isBossStage 照設定');
  assert([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every(s => isBossStage(s) === CONFIG.RUN.bossStages.includes(s)), '不給設定 = config.js');
  // 不給參數：第 1 關、1 人、一般小關
  const d = stageRules();
  assert(d.stage === 1 && d.players === 1 && d.pool === 'normal' && d.enemyHp === 1, J(d));
  return { small: small.enemyHp, boss: boss.bossHp };
});

test('設定可以換一份：Match / Run 收 config 一路傳下去，建場時算一次；不讀也不改全域 CONFIG', () => {
  const before = J(CONFIG);
  const m = new Match({ levelId: 'level1', players: mkPlayers(2), seed: 1, stage: 3, config: T });
  assert(near(m.rules.enemyHp, 1.8) && m.rules.enemyDamage === 0.5 && m.rules.feverEvery === 5, J(m.rules));
  assert(m.enemies.every(e => e.maxHp === Math.round(CONFIG.ENEMY.hp * m.rules.enemyHp)), 'enemy hp ' + m.enemies.map(e => e.maxHp));
  assert(m.damageMult(m.enemies[0], CONFIG.WEAPONS.cannon) === 0.5, 'enemy damage from the given config');
  m.round = 6;
  assert(m.fever === 1 && near(m.feverMult(), 1.2), `fever ${m.fever} ×${m.feverMult()}`);
  // 王關：機制建的角色吃 bossHp
  const tree = new Match({ levelId: 'treeGarden', players: mkPlayers(3), seed: 1, stage: 6, config: T });
  assert(tree.byId('eye').maxHp === Math.round(CONFIG.TREE_BOSS.eyeHp * 3.2), 'eye hp ' + tree.byId('eye').maxHp);
  // 建好之後改全域 CONFIG 不影響這一場（一關的數字開場就定了）
  const saved = CONFIG.FEVER.damagePct;
  CONFIG.FEVER.damagePct = 999;
  try { assert(near(m.feverMult(), 1.2), 'rules are computed once'); } finally { CONFIG.FEVER.damagePct = saved; }
  // Run：總關數、哪幾關是王關照 config，每一關的 Match 也拿到同一份
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(1), seed: 2, io, cards: [], config: T });
  assert(run.stageCount === 7, 'stageCount ' + run.stageCount);
  run.start();
  assert(run.match && run.match.rules.enemyDamage === 0.5 && run.match.rules.feverEvery === 5, 'run passes config to the match: ' + J(run.match && run.match.rules));
  run.stage = 3;
  assert(run.isBoss, 'stage 3 is a boss stage in T');
  assert(J(CONFIG) === before, 'global CONFIG untouched');
  return { stageCount: run.stageCount };
});

test('狂熱只有一個主人：match.fever 由 match.round 推出、不能直接寫；裁判的輪數就是 match.round；新的一關從第 0 輪開始', () => {
  const m = new Match({ levelId: 'level1', players: mkPlayers(1), seed: 1, config: T });
  assert(m.round === 0 && m.fever === 0, 'starts at round 0');
  let threw = false;
  try { m.fever = 3; } catch (err) { threw = err instanceof TypeError; }
  assert(threw && m.fever === 0, 'writing match.fever throws (it is derived from the round)');
  m.planAiTurn = () => ({ walk: null, plan: null });   // 敵人只發呆：只是要快轉輪數
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  ref.start();
  const end = io.t + 3_000_000;
  while (m.round < 7 && io.t < end) io.advance(100);
  const turns = io.log.filter(x => x.t === 'turn');
  assert(m.round >= 7 && ref.round === m.round, `referee round ${ref.round} vs match ${m.round}`);
  assert(turns.every(t => t.round >= 1) && turns.some(t => t.round === 6), 'turn messages carry the round');
  assert(m.fever === Math.floor((m.round - 1) / 5) && m.fever >= 1, `fever follows the round: round ${m.round}, fever ${m.fever}`);
  return { round: m.round, fever: m.fever };
});

// ---- 架構檢查（讀原始碼）----
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// 拿掉註解（行號不變；網址裡的 // 不是註解）
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, '')).replace(/(?<!:)\/\/.*$/gm, '');
const jsFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true })
  .filter(f => f.endsWith('.js')).map(f => `${dir}/${f.split(path.sep).join('/')}`);
const scan = (files, re) => files.flatMap(f => codeOf(read(f)).split('\n').map((l, i) => [f, i + 1, l]).filter(([, , l]) => re.test(l)));
const show = (hits) => hits.map(([f, n, l]) => `        ${f}:${n}: ${l.trim()}`).join('\n');
const ALL = [...jsFiles('shared'), ...jsFiles('client'), ...jsFiles('server')];

test('架構檢查：關卡規則的設定（FEVER、RUN.bossStages / enemyHpPerStage / bossHpPerStage、ENEMY_HP_PER_EXTRA_PLAYER、ENEMY.damageMult / damageMultLate / lateFromStage）只有 shared/stage-rules.js 讀', () => {
  const RULE_CONFIG = /\bFEVER\b|\bbossStages\b|\benemyHpPerStage\b|\bbossHpPerStage\b|\bENEMY_HP_PER_EXTRA_PLAYER\b|\bdamageMultLate\b|\blateFromStage\b|\bENEMY\.damageMult\b/;
  const caught = ['CONFIG.FEVER.damagePct', 'CONFIG.RUN.bossStages.includes(s)', 'const { enemyHpPerStage } = CONFIG.RUN;', 'CONFIG.ENEMY.damageMult', 'R.bossHpPerStage', 'x * CONFIG.ENEMY_HP_PER_EXTRA_PLAYER', 'E.lateFromStage'];
  assert(caught.every(s => RULE_CONFIG.test(s)), 'the scan misses: ' + caught.filter(s => !RULE_CONFIG.test(s)));
  assert(!['this.match.fever', "'fever'", 'm.damageMult(p, w)', 'this.rules.enemyDamage', 'CONFIG.ENEMY.hp', 'isBossStage(stage + 1)'].some(s => RULE_CONFIG.test(s)), 'the scan flags ordinary code');
  const files = ALL.filter(f => f !== 'shared/config.js' && f !== 'shared/stage-rules.js');
  const hits = scan(files, RULE_CONFIG);
  assert(!hits.length, 'stage-rule config read outside shared/stage-rules.js:\n' + show(hits));
  return { files: files.length };
});

test('架構檢查：沒有人自己算狂熱或寫 fever（feverAt 只在 stage-rules.js / match.js），客戶端不自己數輪（不留 this.round / view.round）', () => {
  const FEVER_AT = /\bfeverAt\b/;
  const stray = scan(ALL.filter(f => f !== 'shared/stage-rules.js' && f !== 'shared/match.js'), FEVER_AT);
  assert(!stray.length, 'feverAt outside stage-rules.js / match.js:\n' + show(stray));
  const WRITE = /\.fever\s*(=(?!=)|\+\+|--|[-+*/]=)/;
  assert(['m.fever = 1;', 'this.match.fever=x', 'match.fever++', 'm.fever += 1'].every(s => WRITE.test(s)) && !['m.fever === 0', 'if (m.fever > 0)', 'const f = this.match.fever;'].some(s => WRITE.test(s)), 'the write scan');
  const writes = scan(ALL, WRITE);
  assert(!writes.length, 'writes match.fever:\n' + show(writes));
  const OWN_ROUND = /\b(this|view)\.round\b/;
  const own = scan(jsFiles('client'), OWN_ROUND);
  assert(!own.length, 'the client keeps its own round (use match.round):\n' + show(own));
  return { scanned: ALL.length };
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
