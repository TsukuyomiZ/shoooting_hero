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
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
import { validateCards, needsDiscard } from '../shared/cards.js';
import { logValue } from '../shared/utils.js';
import { GameLog } from '../server/logger.js';
import { RoomManager } from '../server/rooms.js';
import { createServer } from '../server/server.js';
import { SoloLog } from '../client/solo-log.js';

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
  const log = new GameLog({ dir, now: () => new Date(2026, 9, 2, 9, 5, 8, 0) });
  log.write({ ev: 'room.create', room: 'ABCD', pid: 'x', ts: 'bogus', n: 1 }, new Date(2026, 9, 2, 9, 5, 7, 42));
  log.write({ ev: 'server.start', port: 1 });
  const file = path.join(dir, 'game-2026-10-02.log');
  assert(log.file === file, 'current file: ' + log.file);
  const [a, b] = readLines(file);
  assert(Object.keys(a).slice(0, 3).join() === 'ts,ev,room', 'key order: ' + Object.keys(a));
  assert(a.ts === '2026-10-02 09:05:07.042' && a.ev === 'room.create' && a.room === 'ABCD' && a.pid === 'x' && a.n === 1, JSON.stringify(a));
  assert(!('room' in b) && b.ev === 'server.start' && b.port === 1 && b.ts === '2026-10-02 09:05:08.000', JSON.stringify(b));
  log.close();
  log.write({ ev: 'after.close' });
  assert(readLines(file).length === 2, 'nothing written after close');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('GameLog：跨過午夜換新的檔（看伺服器的時鐘）；送來的時間只影響 ts，亂跳也不會換檔；writeMany 一次寫完', () => {
  const dir = tmpDir();
  let clock = new Date(2026, 9, 2, 23, 59, 59, 999);
  const log = new GameLog({ dir, now: () => clock });
  log.write({ ev: 'a' });
  log.write({ ev: 'yesterday' }, new Date(2026, 9, 1, 12, 0, 0, 0));
  clock = new Date(2026, 9, 3, 0, 0, 0, 0);
  log.write({ ev: 'b' });
  const opens = [];
  const open = log.open.bind(log);
  log.open = (day) => { opens.push(day); open(day); };
  log.writeMany(Array.from({ length: 50 }, (_, i) => ({ entry: { ev: 'm', i }, at: new Date(2026, 9, i % 2 ? 2 : 3, 1, 0, 0, i) })));
  log.close();
  assert(opens.length === 0, 'alternating client times must not reopen the file: ' + opens.join());
  const files = fs.readdirSync(dir).sort();
  assert(files.join() === 'game-2026-10-02.log,game-2026-10-03.log', files.join());
  const day1 = readLines(path.join(dir, files[0])), day2 = readLines(path.join(dir, files[1]));
  assert(day1.map(l => l.ev).join() === 'a,yesterday' && day1[1].ts === '2026-10-01 12:00:00.000', 'ts from at, file from clock: ' + JSON.stringify(day1));
  assert(day2[0].ev === 'b' && day2.length === 51 && day2.at(-1).i === 49 && day2[2].ts.startsWith('2026-10-02 01:00'), 'batch in today\'s file');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('GameLog：伺服器跑著的時候檔案被刪掉 → 一秒內重建，後面的紀錄不會消失', () => {
  const dir = tmpDir();
  let clock = new Date(2026, 9, 2, 10, 0, 0, 0);
  const log = new GameLog({ dir, now: () => clock });
  log.write({ ev: 'a' });
  fs.rmSync(dir, { recursive: true, force: true });
  clock = new Date(2026, 9, 2, 10, 0, 2, 0);
  log.write({ ev: 'b' });
  log.close();
  assert(fs.existsSync(log.file) && readLines(log.file).map(l => l.ev).join() === 'b', 'recreated with the new line');
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('logValue：客戶端送來的值截短 / 取一位小數，物件只記型別（亂送 {"toString":0} 也不會丟錯）', () => {
  const evil = JSON.parse('{"toString":0}');
  assert(logValue('x'.repeat(50)).length === 20 && logValue('abc', 2) === 'ab', 'strings clipped');
  assert(logValue(1.234) === 1.2 && logValue(NaN) === 'NaN' && logValue(Infinity) === 'Infinity', 'numbers');
  assert(logValue(evil) === 'object' && logValue([1]) === 'array' && logValue(null) === null && logValue(true) === true && logValue(undefined) === undefined, 'others');
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
  assert(t1 && t1.actor === 'p1' && t1.pid === 'p1' && t1.name === '甲' && t1.ai === false && t1.round === 1 && t1.turnTime > 0, 'turn.start p1: ' + JSON.stringify(t1));

  // 不是他的回合 / 不認得的訊息 / 沒有的武器 → action.ignored
  run.handle('p2', { t: 'move', x: 1, y: 1 });
  assert(io.last('action.ignored').pid === 'p2' && io.last('action.ignored').reason === 'notYourTurn', 'not your turn');
  run.handle('p1', { t: 'dance' });
  assert(io.last('action.ignored').reason === 'unknown' && io.last('action.ignored').t === 'dance', 'unknown message');
  run.handle('p1', { t: 'weapon', weapon: 'nukes' });
  assert(io.last('action.ignored').reason === 'weaponNotOwned', 'weapon not owned');
  run.handle('p1', { t: 'fire', weapon: 'cannon', angle: NaN, power: 50 });
  const bad = io.last('action.ignored');
  assert(bad.reason === 'badAim' && bad.weapon === 'cannon' && bad.angle === 'NaN' && bad.power === 50, 'bad aim keeps what was sent: ' + JSON.stringify(bad));
  run.handle('p1', JSON.parse('{"t":{"toString":0}}'));   // 亂送的物件：String() 會丟錯的那種
  assert(io.last('action.ignored').t === 'object' && io.last('action.ignored').reason === 'unknown', 'crafted t logged safely');

  // 換武器
  const me = run.match.byId('p1');
  const other = me.weapons.find(w => w !== me.weapon);
  run.handle('p1', { t: 'weapon', weapon: other });
  assert(io.last('weapon') && io.last('weapon').weapon === other && io.last('weapon').pid === 'p1', 'weapon switch');
  run.handle('p1', { t: 'weapon', weapon: 'cannon' });

  // 慢動作（空中瞄準）：開 / 關各記一筆（關掉的原因認得才記）、轉給其他人畫光環；狀態沒變的重複訊息不處理
  run.handle('p1', { t: 'slow', on: true });
  const s1 = io.last('slowmo');
  assert(s1 && s1.pid === 'p1' && s1.name === '甲' && s1.on === true && typeof s1.stamina === 'number' && !('why' in s1) && s1.round === 1, 'slowmo on: ' + JSON.stringify(s1));
  const relay = io.msgs.filter(x => x.t === 'slow').at(-1);
  assert(relay && relay.id === 'p1' && relay.on === true && relay._except === 'p1', 'slow relayed to the others: ' + JSON.stringify(relay));
  run.handle('p1', { t: 'slow', on: true });
  assert(io.last('action.ignored').reason === 'slowUnchanged' && io.evs('slowmo').length === 1, 'duplicate slow ignored');
  run.handle('p1', { t: 'slow', on: false, why: 'stamina' });
  assert(io.last('slowmo').on === false && io.last('slowmo').why === 'stamina', 'slowmo off + reason: ' + JSON.stringify(io.last('slowmo')));
  run.handle('p1', { t: 'slow', on: true });
  run.handle('p1', { t: 'slow', on: false, why: { toString: 0 } });
  assert(io.last('slowmo').on === false && !('why' in io.last('slowmo')), 'unknown reason not recorded');
  run.handle('p2', { t: 'slow', on: true });
  assert(io.last('action.ignored').pid === 'p2' && io.last('action.ignored').reason === 'notYourTurn' && io.evs('slowmo').length === 4, 'slow from someone else ignored');
  run.handle('p1', { t: 'slow', on: true });   // 開著慢動作就開火（沒送關）：裁判補記關掉，下一位的回合重新算
  assert(run.referee.statePayload().slowOn === true, 'reconnect state carries slowOn');

  // 移動（照當下的位置回報，體力往下報）與被擋下的瞬移
  run.handle('p1', { t: 'move', x: me.x, y: me.y, facing: -1, stamina: me.stamina - 5 });
  const mv = io.last('move');
  assert(mv && mv.pid === 'p1' && mv.name === '甲' && mv.facing === -1 && mv.stage === 1 && mv.round === 1, 'move: ' + JSON.stringify(mv));
  run.handle('p1', { t: 'move', x: me.x + 390, y: -50, facing: 1, stamina: 0 });
  assert(io.last('move.reject') && io.last('move.reject').pid === 'p1', 'teleport rejected');
  run.handle('p1', { t: 'move', x: { huge: 'x'.repeat(5000) }, y: 'y'.repeat(5000) });
  const rej = io.last('move.reject');
  assert(rej.x === 'object' && rej.y.length === 20, 'raw client values are clipped: ' + JSON.stringify(rej));

  // 開火：先記操作，再記結果（往正上方低力量開，會打到自己附近 → 一定有血量變化）
  run.handle('p1', { t: 'fire', weapon: 'cannon', angle: 90, power: 20, x: me.x, y: me.y, facing: 1, stamina: me.stamina });
  const fire = io.last('fire');
  assert(fire && fire.pid === 'p1' && fire.weapon === 'cannon' && fire.angle === 90 && fire.power === 20, 'fire: ' + JSON.stringify(fire));
  const shot = io.last('shot');
  assert(shot && shot.kind === 'weapon' && shot.pid === 'p1' && shot.frames > 0 && Array.isArray(shot.kills), 'shot: ' + JSON.stringify(shot));
  assert(io.records.indexOf(fire) < io.records.indexOf(shot), 'fire is recorded before its result');
  const autoOff = io.evs('slowmo').at(-1);
  assert(autoOff.pid === 'p1' && autoOff.on === false && autoOff.why === 'fire' && autoOff.auto === true && io.records.indexOf(autoOff) < io.records.indexOf(fire),
    'slow-mo still on at fire: closed by the referee before the fire record: ' + JSON.stringify(autoOff));
  assert(run.referee.statePayload().slowOn === false, 'slowOn off after fire');
  assert(shot.changes.length > 0 && shot.changes.every(c => c.id && Array.isArray(c.hp) && c.hp[0] !== c.hp[1]), 'shot changes: ' + JSON.stringify(shot.changes));
  run.handle('p1', { t: 'move', x: me.x, y: me.y });
  assert(io.last('action.ignored').reason === 'phase:resolving', 'moves during resolving are ignored');

  // 乙的回合：開一下慢動作（甲最後開著也不影響）→ 什麼都不做 → 超時
  assert(advanceUntil(io, () => io.last('turn.start').actor === 'p2'), 'p2 turn');
  run.handle('p2', { t: 'slow', on: true });
  assert(io.last('slowmo').pid === 'p2' && io.last('slowmo').on === true, 'slow state resets every turn: ' + JSON.stringify(io.last('slowmo')));
  assert(io.evs('turn.end').some(r => r.actor === 'p1'), 'turn.end for p1');
  assert(advanceUntil(io, () => io.last('turn.skip')), 'p2 timeout');
  assert(io.last('turn.skip').actor === 'p2' && io.last('turn.skip').pid === 'p2' && io.last('turn.skip').reason === 'timeout', 'skip reason');
  const toOff = io.evs('slowmo').at(-1);
  assert(toOff.pid === 'p2' && toOff.on === false && toOff.why === 'timeout' && toOff.auto === true, 'timeout closes slow-mo: ' + JSON.stringify(toOff));

  // 敵人的 AI 回合
  assert(advanceUntil(io, () => io.evs('ai.turn').length > 0), 'enemy ai turn');
  const ai = io.evs('ai.turn')[0];
  assert(ai.actor.startsWith('e') && !ai.takeover && !('pid' in ai) && Array.isArray(ai.changes) && (ai.noShot || ai.weapon), 'ai.turn: ' + JSON.stringify(ai));
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
  run.handle('p1', { t: 'slow', on: true });   // 開著慢動作時斷線
  run.setConnected('p1', false);
  const tk = io.last('turn.takeover');
  assert(tk && tk.pid === 'p1' && tk.alive === true, 'turn.takeover: ' + JSON.stringify(tk));
  const tkOff = io.last('slowmo');
  assert(tkOff.pid === 'p1' && tkOff.on === false && tkOff.why === 'takeover' && tkOff.auto === true, 'takeover closes slow-mo: ' + JSON.stringify(tkOff));
  // 回線（回合中重新連線，新的頁面送 reconnect 關）：認得這個原因
  run.referee.slowOn = true;
  run.referee.phase = 'turn';
  run.referee.handle('p1', { t: 'slow', on: false, why: 'reconnect' });
  assert(io.last('slowmo').why === 'reconnect' && !io.last('slowmo').auto && run.referee.slowOn === false, 'reconnect off recorded: ' + JSON.stringify(io.last('slowmo')));
  run.referee.phase = 'resolving';
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

await test('CONFIG.LOG.moves = false：移動不逐筆寫進檔案（裁判照樣記，由寫檔的地方 RoomManager / SoloLog 不寫），其他照寫；io 沒有 record（舊的 io / 其他測試）完全不受影響', () => {
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
    assert(io.evs('move').length === 1, 'the referee still records the move (so every message leaves a record)');
    run.handle('p1', { t: 'fire', weapon: 'cannon', angle: 60, power: 40, x: me.x, y: me.y, facing: 1, stamina: me.stamina });
    assert(io.last('fire') && io.last('shot'), 'fire still recorded');
    // 寫檔的地方：伺服器的 RoomManager.record、單人的 SoloLog.record
    const lines = [];
    const mgr = new RoomManager({ log: { write: (e) => lines.push(e) } });
    for (const r of io.records) mgr.record(r.ev, r);
    assert(!lines.some(l => l.ev === 'move') && lines.some(l => l.ev === 'fire') && lines.some(l => l.ev === 'shot'), 'server writes everything but moves');
    const sl = new SoloLog({ send: async () => 204, schedule: () => null, cancel: () => {} });
    for (const r of io.records) sl.record(r.ev, r);
    assert(!sl.buf.some(e => e.ev === 'move') && sl.buf.some(e => e.ev === 'fire'), 'solo log keeps everything but moves');
    CONFIG.LOG.moves = true;
    mgr.record('move', { pid: 'p1' });
    sl.record('move', { pid: 'p1' });
    assert(lines.at(-1).ev === 'move' && sl.buf.at(-1).ev === 'move', 'moves written again when LOG.moves is on');
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

await test('代打前先落地就淹死：turn.skip 的 changes 從落地之前算起（看得到他從幾滴血掉到 0）', () => {
  const io = new FakeIo();
  const humans = [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }];
  const match = new Match({ levelId: 'level1', players: humans, seed: 1 });
  const ref = new Referee({ match, humans, io });
  ref.start();
  io.advance(2000);
  assert(ref.currentId === 'p1' && ref.phase === 'turn', 'p1 turn');
  // 找一條上下都沒有地形的 x（水面上空）
  let x = null;
  for (let cx = 40; cx < CONFIG.WORLD_W - 40 && x === null; cx += 4) {
    let open = true;
    for (let y = 0; y <= CONFIG.WATER_LEVEL + 4 && open; y += 2) {
      for (let dx = -24; dx <= 24; dx += 4) if (match.terrain.isSolid(cx + dx, y)) { open = false; break; }
    }
    if (open) x = cx;
  }
  assert(x !== null, 'level1 has open water');
  const p1 = match.byId('p1');
  Object.assign(p1, { x, y: CONFIG.WATER_LEVEL - 60, vx: 0, vy: 0, onGround: false, hp: 1 });
  ref.setConnected('p1', false);
  const skip = io.last('turn.skip');
  assert(skip && skip.reason === 'water' && skip.pid === 'p1', 'drowned during takeover: ' + JSON.stringify(skip));
  const c = skip.changes.find(ch => ch.id === 'p1');
  assert(c && c.hp[0] === 1 && c.hp[1] === 0 && c.died, 'changes counted from before the settle: ' + JSON.stringify(skip.changes));
});

// ---------- 單人練習：瀏覽器那邊攢紀錄、送回伺服器 ----------

function fakeTimers() {
  const timers = [];
  return {
    timers,
    schedule: (fn) => { const h = { fn }; timers.push(h); return h; },
    cancel: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    async tick() { for (const h of timers.splice(0)) h.fn(); await new Promise(r => setTimeout(r, 0)); },
  };
}

await test('SoloLog：每 2 秒送一批；網路錯誤 / 5xx / 429 放回去重送（順序不變），404 之類的就算了', async () => {
  const sent = [];
  let reply = 503;
  const t = fakeTimers();
  const sl = new SoloLog({
    send: async (body) => { sent.push(JSON.parse(body)); if (reply === 'throw') throw new Error('offline'); return reply; },
    schedule: t.schedule, cancel: t.cancel,
  });
  sl.record('a', { n: 1 });
  sl.record('b', { n: 2 });
  assert(t.timers.length === 1 && sent.length === 0, 'waits for the timer');
  await t.tick();
  assert(sent.length === 1 && sl.buf.map(e => e.ev).join() === 'a,b' && t.timers.length === 1, 'requeued after 503, retry scheduled');
  reply = 429;
  await t.tick();
  assert(sl.buf.map(e => e.ev).join() === 'a,b', 'requeued after 429');
  reply = 'throw';
  sl.record('c', {});
  await t.tick();
  assert(sl.buf.map(e => e.ev).join() === 'a,b,c', 'requeued after a network error');
  reply = 204;
  await t.tick();
  const last = sent.at(-1);
  assert(last.sid === sl.sid && last.entries.map(e => e.ev).join() === 'a,b,c' && sl.buf.length === 0 && t.timers.length === 0, 'delivered in order');
  assert(last.entries.every(e => Number.isFinite(e.at)), 'entries carry the browser time');
  reply = 404;
  sl.record('d', {});
  await t.tick();
  assert(sl.buf.length === 0 && t.timers.length === 0, '404 is final (old server without /log)');
});

await test('SoloLog：最多攢 5000 筆，丟掉的補一筆 log.dropped；一批照 UTF-8 位元組不超過 30KB；離開頁面送最後一批；關掉紀錄就不記', async () => {
  const sent = [];
  const t = fakeTimers();
  const sl = new SoloLog({ send: async (body) => { sent.push(body); return 204; }, schedule: t.schedule, cancel: t.cancel });
  for (let i = 0; i < 5010; i++) sl.record('move', { i, name: '中文名字的玩家' });
  assert(sl.buf.length === 5000 && sl.dropped === 10 && sl.buf[0].i === 10, 'oldest entries dropped');
  sl.flush();
  await new Promise(r => setTimeout(r, 0));
  const first = JSON.parse(sent[0]);
  assert(first.entries[0].ev === 'log.dropped' && first.entries[0].count === 10, 'dropped marker goes first');
  assert(Buffer.byteLength(sent[0]) <= 30 * 1024 + 100 && Buffer.byteLength(sent[0]) > 20 * 1024, 'batch measured in bytes: ' + Buffer.byteLength(sent[0]));
  const left = sl.buf.length;
  sl.flushFinal();
  await new Promise(r => setTimeout(r, 0));
  assert(sent.length === 2 && sl.buf.length === 0 && t.timers.length === 0, 'one final request, nothing left');
  const fin = JSON.parse(sent[1]);
  const marker = fin.entries.at(-1);
  assert(marker.ev === 'log.dropped' && marker.unload === true && marker.count === left - (fin.entries.length - 1), 'leftovers counted: ' + JSON.stringify(marker));
  assert(Buffer.byteLength(sent[1]) <= 30 * 1024 + 200, 'final batch fits the keepalive budget');

  const saved = CONFIG.LOG.enabled;
  CONFIG.LOG.enabled = false;
  try {
    const off = new SoloLog({ send: async () => 204, schedule: t.schedule, cancel: t.cancel });
    off.record('move', {});
    assert(off.buf.length === 0 && t.timers.length === 0, 'disabled → nothing buffered');
  } finally {
    CONFIG.LOG.enabled = saved;
  }
});

// ---------- 伺服器：房間管理 ----------

await test('RoomManager：亂送的訊息照樣記成 msg.ignored / msg.bad 不丟錯；雜訊類每條連線 10 秒最多 30 筆，斷線時補 log.suppressed；guard 記下錯誤再丟出去', () => {
  const lines = [];
  const mgr = new RoomManager({ log: { write: (e) => lines.push(e) } });
  const client = mgr.onConnection(null, { ip: '10.0.0.9' });
  assert(lines[0].ev === 'conn.open' && lines[0].cid === client.cid && lines[0].ip === '10.0.0.9', 'conn.open');
  mgr.onMessage(client, JSON.parse('{"t":{"toString":0}}'));
  const ig = lines.at(-1);
  assert(ig.ev === 'msg.ignored' && ig.t === 'object' && ig.reason === 'noRoom', 'crafted t: ' + JSON.stringify(ig));
  mgr.onMessage(client, 5);
  assert(lines.at(-1).ev === 'msg.bad' && lines.at(-1).notObject === 5, 'non-object message');
  for (let i = 0; i < 40; i++) mgr.onMessage(client, { t: 'zzz' });
  assert(lines.filter(l => l.ev === 'msg.ignored').length === 29, 'noise capped at 30 per window');
  mgr.onClose(client, 1006);
  const sup = lines.find(l => l.ev === 'log.suppressed');
  assert(lines.some(l => l.ev === 'conn.close' && l.code === 1006) && sup && sup.count === 12 && sup.key === `c${client.cid}`, 'suppressed count: ' + JSON.stringify(sup));

  let threw = false;
  try { mgr.guard('timer', () => { throw new Error('boom'); }); } catch (err) { threw = err.message === 'boom'; }
  assert(threw && lines.at(-1).ev === 'error' && lines.at(-1).where === 'timer' && lines.at(-1).error.includes('boom'), 'guard logs then rethrows');
});

// ---------- 伺服器：單人練習的紀錄 ----------

async function post(port, body, raw = false, type = 'application/json') {
  const res = await fetch(`http://127.0.0.1:${port}/log`, {
    method: 'POST', headers: { 'Content-Type': type }, body: raw ? body : JSON.stringify(body),
  });
  return res.status;
}
const pad2 = (n) => String(n).padStart(2, '0');
const localStamp = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

await test('POST /log：單人練習的紀錄寫進同一個檔，房號一律 SOLO-<sid>、帶 ip、用瀏覽器記的時間；壞掉 / 太大的拒收', async () => {
  const dir = tmpDir();
  const srv = await createServer({ port: 0, host: '127.0.0.1', logDir: dir });
  try {
    const at = Date.now() - 1500;
    const oldAt = Date.now() - 2 * 3600 * 1000;
    const status = await post(srv.port, {
      sid: 'ab$c-12',
      entries: [
        { ev: 'move', at, room: 'HACK', ts: 'fake', pid: 'me', x: 1, ip: '6.6.6.6' },
        'junk', null, [1, 2], { ev: 5 },
        { ev: 'fire', at: 'not-a-time', pid: 'me', weapon: 'cannon' },
        { ev: 'x'.repeat(100), at },
        { ev: 'old', at: oldAt },
        { ev: 'big', at, blob: 'x'.repeat(5000) },
      ],
    });
    assert(status === 204, 'status ' + status);
    const lines = readLines(srv.log.file).filter(l => l.room && l.room.startsWith('SOLO-'));
    assert(lines.length === 5, 'only well-formed entries: ' + JSON.stringify(lines));
    const [mv, fire, long, old, big] = lines;
    assert(mv.ev === 'move' && mv.room === 'SOLO-abc12' && mv.ip === '127.0.0.1' && mv.x === 1 && mv.ts !== 'fake', JSON.stringify(mv));
    assert(mv.ts.startsWith(localStamp(new Date(at))), `uses the browser's time: ${mv.ts} vs ${localStamp(new Date(at))}`);
    assert(fire.ev === 'fire' && fire.weapon === 'cannon', JSON.stringify(fire));
    assert(long.ev.length === 40, 'event name capped');
    assert(old.ev === 'old' && !old.ts.startsWith(localStamp(new Date(oldAt))), 'times older than an hour use the server time: ' + old.ts);
    assert(big.ev === 'big' && big.truncated === true && !('blob' in big), 'oversized entry truncated');

    assert(await post(srv.port, '{not json', true) === 400, 'bad json → 400');
    assert(await post(srv.port, JSON.stringify({ sid: 'a', entries: [{ ev: 'x' }] }), true, 'text/plain') === 415, 'non-JSON content type → 415');
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

await test('POST /log：每個 ip 每 10 秒最多收 1MB，超過回 429（瀏覽器會晚點重送）', async () => {
  const dir = tmpDir();
  const srv = await createServer({ port: 0, host: '127.0.0.1', logDir: dir });
  try {
    const junk = 'x'.repeat(200 * 1024);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push(await post(srv.port, junk, true));
    assert(statuses.slice(0, 5).every(s => s === 400) && statuses[5] === 429, 'statuses: ' + statuses.join());
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
