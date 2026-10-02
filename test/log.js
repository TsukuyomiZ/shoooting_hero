// node test/log.js
// 紀錄（LOG）：GameLog 的檔案格式（每行一筆 JSON、ts / ev / room 在前、資料蓋不掉 ts、一天一個檔、寫不進去不會當掉）；
// 肉鴿流程與裁判每一步都有紀錄（假時鐘跑：開始、回合、移動、換武器、開火與結果、不處理的訊息、超時、AI、斷線代打、選牌、全滅）；
// 伺服器收單人練習的紀錄（POST /log：只收認得的形狀、房號蓋成 SOLO-xxxx、太大 / 壞掉的拒收、關掉紀錄就不寫）。
// 血量一律自己設（不受 config 影響）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from '../shared/config.js';
import { Run } from '../shared/run.js';
import { validateCards, needsDiscard } from '../shared/cards.js';
import { GameLog } from '../server/logger.js';
import { createServer } from '../server/server.js';

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
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sh-log-'));
const readLines = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

// 跟其他測試一樣的假時鐘 io，多一個 record 收紀錄
class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.msgs = []; this.records = []; this.seq = 0; }
  broadcast(msg, exceptId) { this.msgs.push({ ...msg, _except: exceptId }); }
  schedule(fn, ms) { const h = { at: this.t + ms, fn, id: this.seq++ }; this.timers.push(h); return h; }
  cancel(h) { this.timers = this.timers.filter(x => x !== h); }
  now() { return this.t; }
  record(ev, data) {
    JSON.stringify(data);   // 紀錄一定要能序列化（伺服器要寫成一行 JSON）
    this.records.push({ ev, ...data });
  }
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
  evs(ev) { return this.records.filter(r => r.ev === ev); }
  last(ev) { return this.evs(ev).at(-1); }
}
function advanceUntil(io, pred, maxMs = 600_000) {
  const start = io.t;
  while (io.t - start < maxMs) {
    io.advance(100);
    if (pred()) return true;
  }
  return false;
}

const CARDS = validateCards(JSON.parse(fs.readFileSync(new URL('../shared/cards.json', import.meta.url), 'utf8'))).cards;
const BIG = 100_000;
// 開一關之後把所有人的血拉高，不會被一發打死、也不會因為 config 的血量設定提早結束
function beefUp(run) {
  for (const e of run.match.entities) { e.maxHp = BIG; e.hp = BIG; }
}

// ---------- GameLog ----------

await test('GameLog：每行一筆 JSON、ts / ev / room 排在最前面、資料裡的 ts 蓋不掉、room 沒有就不寫', () => {
  const dir = tmpDir();
  const log = new GameLog({ dir });
  log.write({ ev: 'room.create', room: 'ABCD', pid: 'x', ts: 'bogus', n: 1 }, new Date(2026, 9, 2, 9, 5, 7, 42));
  log.write({ ev: 'server.start', port: 1 }, new Date(2026, 9, 2, 9, 5, 8, 0));
  const file = path.join(dir, 'game-2026-10-02.log');
  assert(log.file === file, 'current file: ' + log.file);
  const [a, b] = readLines(file);
  assert(Object.keys(a).slice(0, 3).join() === 'ts,ev,room', 'key order: ' + Object.keys(a));
  assert(a.ts === '2026-10-02 09:05:07.042' && a.ev === 'room.create' && a.room === 'ABCD' && a.pid === 'x' && a.n === 1, JSON.stringify(a));
  assert(!('room' in b) && b.ev === 'server.start' && b.port === 1, JSON.stringify(b));
  log.close();
  log.write({ ev: 'after.close' });
  assert(readLines(file).length === 2, 'nothing written after close');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('GameLog：跨過午夜換新的檔（以本機日期為準）', () => {
  const dir = tmpDir();
  const log = new GameLog({ dir });
  log.write({ ev: 'a' }, new Date(2026, 9, 2, 23, 59, 59, 999));
  log.write({ ev: 'b' }, new Date(2026, 9, 3, 0, 0, 0, 0));
  log.close();
  const files = fs.readdirSync(dir).sort();
  assert(files.join() === 'game-2026-10-02.log,game-2026-10-03.log', files.join());
  assert(readLines(path.join(dir, files[0]))[0].ev === 'a' && readLines(path.join(dir, files[1]))[0].ev === 'b', 'each day its own file');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('GameLog：寫不進去（資料夾路徑是一個檔案）不會丟錯、只警告一次；序列化失敗也只記錯誤不當掉', () => {
  const dir = tmpDir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  try {
    const bad = new GameLog({ dir: path.join(blocker, 'logs') });
    bad.write({ ev: 'a' });
    bad.write({ ev: 'b' });
    assert(warned === 1, 'warn once: ' + warned);
  } finally {
    console.warn = warn;
  }
  const log = new GameLog({ dir });
  const loop = {};
  loop.self = loop;
  log.write({ ev: 'loop', data: loop });
  log.close();
  const [line] = readLines(log.file);
  assert(line.ev === 'loop' && typeof line.logError === 'string' && !('data' in line), JSON.stringify(line));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- 肉鴿流程 + 裁判 ----------

await test('一關的每一步都有紀錄：開始、回合、移動、換武器、開火與結果、不處理的訊息、超時、AI、過關、選牌（含系統代選）', () => {
  const io = new FakeIo();
  const run = new Run({ players: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }], seed: 7, io, cards: CARDS });
  run.start();
  beefUp(run);

  const st = io.last('stage.start');
  assert(st && st.stage === 1 && st.level === run.match.levelId && st.players.length === 2, 'stage.start: ' + JSON.stringify(st));
  assert(st.players.every(p => Array.isArray(p.weapons) && Array.isArray(p.cards) && p.hp > 0), 'stage.start carries weapons / cards / hp');
  const bs = io.last('battle.start');
  assert(bs && bs.stage === 1 && bs.round === 0 && bs.level === run.match.levelId && bs.entities.length === run.match.entities.length, 'battle.start');
  assert(bs.entities.some(e => e.team === 'enemies') && bs.entities.find(e => e.id === 'p1').name === '甲', 'battle.start lists everyone');

  io.advance(2000);
  const t1 = io.last('turn.start');
  assert(t1 && t1.actor === 'p1' && t1.name === '甲' && t1.ai === false && t1.round === 1 && t1.turnTime > 0, 'turn.start p1: ' + JSON.stringify(t1));

  // 不是他的回合 / 不認得的訊息 / 沒有的武器 → action.ignored
  run.handle('p2', { t: 'move', x: 1, y: 1 });
  assert(io.last('action.ignored').pid === 'p2' && io.last('action.ignored').reason === 'notYourTurn', 'not your turn');
  run.handle('p1', { t: 'dance' });
  assert(io.last('action.ignored').reason === 'unknown' && io.last('action.ignored').t === 'dance', 'unknown message');
  run.handle('p1', { t: 'weapon', weapon: 'nukes' });
  assert(io.last('action.ignored').reason === 'weaponNotOwned', 'weapon not owned');
  run.handle('p1', { t: 'fire', weapon: 'cannon', angle: NaN, power: 50 });
  assert(io.last('action.ignored').reason === 'badAim', 'bad aim');

  // 換武器
  const me = run.match.byId('p1');
  const other = me.weapons.find(w => w !== me.weapon);
  run.handle('p1', { t: 'weapon', weapon: other });
  assert(io.last('weapon') && io.last('weapon').weapon === other && io.last('weapon').pid === 'p1', 'weapon switch');
  run.handle('p1', { t: 'weapon', weapon: 'cannon' });

  // 移動（照當下的位置回報，體力往下報）與被擋下的瞬移
  run.handle('p1', { t: 'move', x: me.x, y: me.y, facing: -1, stamina: me.stamina - 5 });
  const mv = io.last('move');
  assert(mv && mv.pid === 'p1' && mv.name === '甲' && mv.facing === -1 && mv.stage === 1 && mv.round === 1, 'move: ' + JSON.stringify(mv));
  run.handle('p1', { t: 'move', x: me.x + 390, y: -50, facing: 1, stamina: 0 });
  assert(io.last('move.reject') && io.last('move.reject').pid === 'p1', 'teleport rejected');

  // 開火：先記操作，再記結果（往正上方低力量開，會打到自己附近 → 一定有血量變化）
  run.handle('p1', { t: 'fire', weapon: 'cannon', angle: 90, power: 20, x: me.x, y: me.y, facing: 1, stamina: me.stamina });
  const fire = io.last('fire');
  assert(fire && fire.pid === 'p1' && fire.weapon === 'cannon' && fire.angle === 90 && fire.power === 20, 'fire: ' + JSON.stringify(fire));
  const shot = io.last('shot');
  assert(shot && shot.kind === 'weapon' && shot.pid === 'p1' && shot.frames > 0 && Array.isArray(shot.kills), 'shot: ' + JSON.stringify(shot));
  assert(io.records.indexOf(fire) < io.records.indexOf(shot), 'fire is recorded before its result');
  assert(shot.changes.length > 0 && shot.changes.every(c => c.id && Array.isArray(c.hp) && c.hp[0] !== c.hp[1]), 'shot changes: ' + JSON.stringify(shot.changes));
  run.handle('p1', { t: 'move', x: me.x, y: me.y });
  assert(io.last('action.ignored').reason === 'phase:resolving', 'moves during resolving are ignored');

  // 乙的回合：什麼都不做 → 超時
  assert(advanceUntil(io, () => io.last('turn.start').actor === 'p2'), 'p2 turn');
  assert(io.evs('turn.end').some(r => r.actor === 'p1'), 'turn.end for p1');
  assert(advanceUntil(io, () => io.last('turn.skip')), 'p2 timeout');
  assert(io.last('turn.skip').actor === 'p2' && io.last('turn.skip').reason === 'timeout', 'skip reason');

  // 敵人的 AI 回合
  assert(advanceUntil(io, () => io.evs('ai.turn').length > 0), 'enemy ai turn');
  const ai = io.evs('ai.turn')[0];
  assert(ai.actor.startsWith('e') && !ai.takeover && Array.isArray(ai.changes) && (ai.noShot || ai.weapon), 'ai.turn: ' + JSON.stringify(ai));
  assert(io.evs('turn.start').some(r => r.actor === ai.actor && r.ai === true && r.team === 'enemies'), 'enemy turn.start');

  // 敵人全倒 → battle.over win → 發牌
  for (const e of run.match.enemies) e.die('hit');
  assert(advanceUntil(io, () => io.last('pick.offer')), 'pick offers');
  const over = io.last('battle.over');
  assert(over.result === 'win' && over.players.length === 2 && over.players.every(p => typeof p.kills === 'number'), 'battle.over: ' + JSON.stringify(over));
  const offer = io.last('pick.offer');
  assert(offer.stage === 1 && offer.players.every(p => p.offers.length === run.offers[p.pid].length), 'pick.offer: ' + JSON.stringify(offer));

  // 甲選一張不用丟武器、不用選連結對象的牌；選錯的牌記成不處理；乙不選 → 系統代選
  run.handle('p1', { t: 'pick', cardId: 'no-such-card' });
  assert(io.last('action.ignored').reason === 'cardNotOffered', 'bad card');
  const mine = run.offers.p1.find(c => !needsDiscard(run.players.get('p1').weapons, c) && !(c.effects.link > 0)) || run.offers.p1[0];
  run.handle('p1', { t: 'pick', cardId: mine.id, discard: run.players.get('p1').weapons[0], link: 'p2' });
  const picked = io.last('pick');
  assert(picked && picked.pid === 'p1' && picked.card === mine.id, 'pick: ' + JSON.stringify(picked));
  assert(advanceUntil(io, () => io.last('pick.done')), 'picks done');
  const done = io.last('pick.done');
  const d1 = done.players.find(p => p.pid === 'p1'), d2 = done.players.find(p => p.pid === 'p2');
  assert(d1.card === mine.id && !d1.auto && d2.auto === true && d2.card && d2.hp > 0, 'pick.done: ' + JSON.stringify(done));
  assert(advanceUntil(io, () => io.last('stage.start').stage === 2), 'stage 2 starts');
  assert(io.last('stage.start').players.find(p => p.pid === 'p1').cards.includes(mine.id), 'picked card carried into stage 2');
  return { records: io.records.length, kinds: new Set(io.records.map(r => r.ev)).size };
});

await test('輪到他時斷線 → turn.takeover + ai.turn（takeover）；全滅 → battle.over lose + run.over', () => {
  const io = new FakeIo();
  const run = new Run({ players: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }], seed: 9, io, cards: CARDS });
  run.start();
  beefUp(run);
  io.advance(2000);
  assert(io.last('turn.start').actor === 'p1', 'p1 first');
  run.setConnected('p1', false);
  const tk = io.last('turn.takeover');
  assert(tk && tk.pid === 'p1' && tk.alive === true, 'turn.takeover: ' + JSON.stringify(tk));
  const ai = io.last('ai.turn');
  assert(ai && ai.actor === 'p1' && ai.takeover === true, 'ai.turn takeover: ' + JSON.stringify(ai));
  // 之後他的回合一開始就是代打
  assert(advanceUntil(io, () => io.evs('turn.start').filter(r => r.actor === 'p1').length >= 2), 'p1 next turn');
  const t = io.evs('turn.start').filter(r => r.actor === 'p1').at(-1);
  assert(t.ai === true && t.takeover === true, 'turn.start marks takeover: ' + JSON.stringify(t));

  for (const e of run.match.players) e.die('hit');
  assert(advanceUntil(io, () => io.last('run.over')), 'run over');
  assert(io.last('battle.over').result === 'lose', 'battle lost');
  const ro = io.last('run.over');
  assert(ro.result === 'lose' && ro.stage === 1 && ro.players.length === 2 && ro.players.every(p => Array.isArray(p.cards)), 'run.over: ' + JSON.stringify(ro));
});

await test('CONFIG.LOG.moves = false：移動不逐筆記，其他照記；io 沒有 record（舊的 io / 其他測試）完全不受影響', () => {
  const saved = CONFIG.LOG.moves;
  CONFIG.LOG.moves = false;
  try {
    const io = new FakeIo();
    const run = new Run({ players: [{ id: 'p1', name: '甲' }], seed: 3, io, cards: CARDS });
    run.start();
    beefUp(run);
    io.advance(2000);
    const me = run.match.byId('p1');
    run.handle('p1', { t: 'move', x: me.x, y: me.y, facing: 1, stamina: me.stamina - 1 });
    assert(!io.evs('move').length && io.msgs.length > 0, 'no move records');
    run.handle('p1', { t: 'fire', weapon: 'cannon', angle: 60, power: 40, x: me.x, y: me.y, facing: 1, stamina: me.stamina });
    assert(io.last('fire') && io.last('shot'), 'fire still recorded');
  } finally {
    CONFIG.LOG.moves = saved;
  }
  const io2 = new FakeIo();
  io2.record = undefined;
  const run2 = new Run({ players: [{ id: 'p1', name: '甲' }], seed: 3, io: io2, cards: CARDS });
  run2.start();
  io2.advance(2000);
  const me2 = run2.match.byId('p1');
  run2.handle('p1', { t: 'move', x: me2.x, y: me2.y, facing: 1, stamina: me2.stamina - 1 });
  run2.handle('p1', { t: 'fire', weapon: 'cannon', angle: 60, power: 40, x: me2.x, y: me2.y, facing: 1, stamina: me2.stamina });
  assert(io2.msgs.some(m => m.t === 'shot'), 'game still runs without record');
});

// ---------- 伺服器：單人練習的紀錄 ----------

async function post(port, body, raw = false) {
  const res = await fetch(`http://127.0.0.1:${port}/log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ? body : JSON.stringify(body),
  });
  return res.status;
}

await test('POST /log：單人練習的紀錄寫進同一個檔，房號一律 SOLO-<sid>、帶 ip、用瀏覽器記的時間；壞掉 / 太大的拒收', async () => {
  const dir = tmpDir();
  const srv = await createServer({ port: 0, host: '127.0.0.1', logDir: dir });
  try {
    const at = Date.now() - 1500;
    const status = await post(srv.port, {
      sid: 'ab$c-12',
      entries: [
        { ev: 'move', at, room: 'HACK', ts: 'fake', pid: 'me', x: 1 },
        'junk', null, [1, 2], { ev: 5 },
        { ev: 'fire', at: 'not-a-time', pid: 'me', weapon: 'cannon' },
        { ev: 'x'.repeat(100), at },
      ],
    });
    assert(status === 204, 'status ' + status);
    const lines = readLines(srv.log.file).filter(l => l.room && l.room.startsWith('SOLO-'));
    assert(lines.length === 3, 'only well-formed entries: ' + JSON.stringify(lines));
    const [mv, fire, long] = lines;
    assert(mv.ev === 'move' && mv.room === 'SOLO-abc12' && mv.ip === '127.0.0.1' && mv.x === 1 && mv.ts !== 'fake', JSON.stringify(mv));
    const d = new Date(at);
    const hhmmss = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    assert(mv.ts.includes(hhmmss), `uses the browser's time: ${mv.ts} vs ${hhmmss}`);
    assert(fire.ev === 'fire' && fire.weapon === 'cannon', JSON.stringify(fire));
    assert(long.ev.length === 40, 'event name capped');

    assert(await post(srv.port, '{not json', true) === 400, 'bad json → 400');
    let refused = false;
    try {
      const s = await post(srv.port, 'x'.repeat(300 * 1024), true);
      refused = s === 413;
    } catch {
      refused = true;   // 伺服器提早關掉連線也算拒收
    }
    assert(refused, 'oversize body refused');
    const page = await fetch(`http://127.0.0.1:${srv.port}/`);
    assert(page.status === 200, 'static files still served');
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('logDir = null → 不記紀錄（POST /log 照樣回 204、什麼都不寫）', async () => {
  const srv = await createServer({ port: 0, host: '127.0.0.1', logDir: null });
  try {
    assert(srv.log.file === null, 'no log file');
    assert(await post(srv.port, { sid: 'a', entries: [{ ev: 'move' }] }) === 204, 'accepted and dropped');
  } finally {
    await srv.close();
  }
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
