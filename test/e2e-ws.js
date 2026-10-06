// node test/e2e-ws.js
// 真的開伺服器，用兩個 WebSocket 客戶端跑一場開頭：
// 看大廳列表、私人房間 → 建房 → 加入 → 準備 → 開始 → 甲移動、丟貼圖、開火 → 兩邊收到同一份 shot → 乙的回合 → 乙斷線被 AI 代打 → 乙用 token 重連拿到 state
// 最後檢查紀錄（LOG）檔把這些都記下來了（寫在暫存資料夾，不會弄髒專案的 logs/）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.js';
import { STICKER_LIMIT } from '../shared/stickers.js';
import { VERSION, versionLabel } from '../shared/version.js';

const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-e2e-log-'));
const srv = await createServer({ port: 0, host: '127.0.0.1', logDir });
const url = `ws://127.0.0.1:${srv.port}`;
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const overall = setTimeout(() => { console.error('E2E timeout'); process.exit(1); }, 60_000);

class Client {
  constructor(name) { this.name = name; this.log = []; this.waiters = []; }
  connect(token) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => this.ws.send(JSON.stringify({ t: 'hello', name: this.name, token }));
      this.ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        this.log.push(m);
        if (m.t === 'welcome') { this.id = m.id; this.token = m.token; resolve(m); }
        for (const w of this.waiters.slice()) {
          if (w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(m); }
        }
      };
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  mark() { return this.log.length; }
  // 從 log 第 from 筆開始找符合的訊息，沒有就等
  waitFrom(from, pred, label, ms = 20_000) {
    const hit = this.log.slice(from).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), ms);
      this.waiters.push({ pred, res: (m) => { clearTimeout(timer); res(m); } });
    });
  }
  close() { this.ws.close(); }
}

try {
  const a = new Client('甲');
  const b = new Client('乙');
  await a.connect();
  await b.connect();
  assert(a.id && a.token && b.id !== a.id, 'welcome ids');

  // 大廳列表：w 一直開著列表看
  const w = new Client('看');
  await w.connect();
  w.send({ t: 'browse', on: true });
  await w.waitFrom(0, m => m.t === 'rooms' && m.rooms.length === 0, 'empty room list');

  a.send({ t: 'create' });
  const lobbyA = await a.waitFrom(0, m => m.t === 'lobby', 'lobby after create');
  assert(/^[A-Z2-9]{4}$/.test(lobbyA.code) && lobbyA.hostId === a.id && lobbyA.private === false, 'room code / host / public');
  const listed = await w.waitFrom(0, m => m.t === 'rooms' && m.rooms.some(r => r.code === lobbyA.code), 'public room listed');
  assert(listed.rooms[0].host === '甲' && listed.rooms[0].players === 1 && !listed.rooms[0].started, 'room list entry');

  b.send({ t: 'join', code: lobbyA.code.toLowerCase(), via: 'list' });
  await b.waitFrom(0, m => m.t === 'lobby' && m.players.length === 2, 'lobby with 2 players');
  await w.waitFrom(0, m => m.t === 'rooms' && m.rooms.some(r => r.code === lobbyA.code && r.players === 2), 'list shows 2 players');

  // 私人房間：列表上看不到，輸入房號照樣能進；房主可以切換公開 / 私人，別人不行
  const p = new Client('私');
  const q = new Client('友');
  await p.connect();
  await q.connect();
  p.send({ t: 'create', private: true, name: '私房主' });
  const lobbyP = await p.waitFrom(0, m => m.t === 'lobby', 'private lobby');
  assert(lobbyP.private === true && lobbyP.players[0].name === '私房主', 'private room + renamed host');
  q.send({ t: 'join', code: lobbyP.code });
  await q.waitFrom(0, m => m.t === 'lobby' && m.players.length === 2, 'join private room by code');
  q.send({ t: 'privacy', private: false });
  const errQ = await q.waitFrom(0, m => m.t === 'error', 'non-host privacy refused');
  assert(/房主/.test(errQ.msg), 'only host can change privacy');
  let mkW = w.mark();
  assert(!w.log.some(m => m.t === 'rooms' && m.rooms.some(r => r.code === lobbyP.code)), 'private room never listed');
  p.send({ t: 'privacy', private: false });
  await w.waitFrom(mkW, m => m.t === 'rooms' && m.rooms.some(r => r.code === lobbyP.code), 'room listed after going public');
  mkW = w.mark();
  p.send({ t: 'privacy', private: true });
  await w.waitFrom(mkW, m => m.t === 'rooms' && !m.rooms.some(r => r.code === lobbyP.code), 'room hidden after going private');
  p.close(); q.close();

  let mk = a.mark();
  a.send({ t: 'start' });
  const err = await a.waitFrom(mk, m => m.t === 'error', 'error: not ready');
  assert(/準備/.test(err.msg), 'start refused until everyone is ready');

  mk = a.mark();
  a.send({ t: 'ready', ready: true });
  b.send({ t: 'ready', ready: true });
  await a.waitFrom(mk, m => m.t === 'lobby' && m.players.every(p => p.ready), 'all ready');
  a.send({ t: 'start' });
  const start = await b.waitFrom(0, m => m.t === 'start', 'start');
  assert(start.players.length === 2 && start.snapshot.entities.length >= 4 && Number.isInteger(start.seed), 'start payload');
  assert(start.stageInfo && start.stageInfo.stage === 1 && start.stageInfo.isBoss === false && start.carry, 'stage info in start payload');
  await w.waitFrom(0, m => m.t === 'rooms' && m.rooms.some(r => r.code === lobbyA.code && r.started), 'list marks room as started');

  const turn1 = await a.waitFrom(0, m => m.t === 'turn', 'first turn');
  assert(turn1.actorId === a.id && turn1.ai === false, 'first turn belongs to host (甲)');

  // 甲移動一步，乙應收到轉發的 move
  const meA = start.snapshot.entities.find(e => e.id === a.id);
  const stamina = turn1.entities.find(e => e.id === a.id).stamina - 10;   // 體力只能減不能加，用當回合的值往下報
  a.send({ t: 'move', x: meA.x + 8, y: meA.y, facing: 1, stamina });
  const mv = await b.waitFrom(0, m => m.t === 'move' && m.id === a.id, 'relayed move');
  assert(Math.abs(mv.x - (meA.x + 8)) < 1e-9 && mv.stamina === stamina, 'move relayed with values');
  assert(!a.log.some(m => m.t === 'move'), 'sender should not get its own move echoed');

  // 反應貼圖：轉給其他人、不回給自己；不認得的 id 丟掉；洗版超過上限的丟掉
  const mkS = b.mark();
  a.send({ t: 'sticker', id: 'nope' });
  for (let i = 0; i < STICKER_LIMIT.count + 2; i++) a.send({ t: 'sticker', id: 'lol' });
  b.send({ t: 'sticker', id: 'dog' });   // 乙的貼圖當「前面的都處理完了」的記號
  await a.waitFrom(0, m => m.t === 'sticker' && m.from === b.id, 'sticker from 乙');
  await new Promise(r => setTimeout(r, 100));
  const gotB = b.log.slice(mkS).filter(m => m.t === 'sticker');
  assert(gotB.length === STICKER_LIMIT.count && gotB.every(m => m.from === a.id && m.id === 'lol'), `sticker relay / limit: ${JSON.stringify(gotB)}`);
  assert(!a.log.some(m => m.t === 'sticker' && m.from === a.id), 'sender should not get its own sticker echoed');

  // 甲開火，兩邊收到一模一樣的 shot
  a.send({ t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: meA.x + 8, y: meA.y, facing: 1, stamina: 190 });
  const shotA = await a.waitFrom(0, m => m.t === 'shot', 'shot (甲)');
  const shotB = await b.waitFrom(0, m => m.t === 'shot', 'shot (乙)');
  assert(JSON.stringify(shotA) === JSON.stringify(shotB), 'both clients get identical shot');
  assert(shotA.actorId === a.id && shotA.results.length === start.snapshot.entities.length && shotA.flightFrames > 0, 'shot payload');

  // 接著是乙的回合（人類）
  const turn2 = await b.waitFrom(0, m => m.t === 'turn' && m.actorId === b.id, 'turn 乙');
  assert(turn2.ai === false && turn2.turnTime === 30, '乙 human turn');

  // 乙斷線 → 甲收到狀態，且乙的這回合立刻由 AI 代打
  const mkA = a.mark();
  b.close();
  await a.waitFrom(mkA, m => m.t === 'playerStatus' && m.id === b.id && m.connected === false, 'playerStatus disconnected');
  const aiB = await a.waitFrom(mkA, m => m.t === 'aiTurn' && m.actorId === b.id, 'AI takeover for 乙');
  assert(Array.isArray(aiB.entities), 'aiTurn carries entities');

  // 乙用 token 重連 → 拿到 state，且大家收到他回線
  const b2 = new Client('乙');
  await b2.connect(b.token);
  assert(b2.id === b.id, 'reconnect keeps the same player id');
  const state = await b2.waitFrom(0, m => m.t === 'state', 'state after reconnect');
  assert(state.players.length === 2 && state.snapshot.entities.length >= 4 && Array.isArray(state.snapshot.holes) && state.run && state.run.stage === 1, 'state payload');
  await a.waitFrom(mkA, m => m.t === 'playerStatus' && m.id === b.id && m.connected === true, 'playerStatus reconnected');

  // 加入已開始的房間會被拒絕
  const c = new Client('丙');
  await c.connect();
  c.send({ t: 'join', code: lobbyA.code });
  const errC = await c.waitFrom(0, m => m.t === 'error', 'join started room error');
  assert(/開始/.test(errC.msg), 'joining a started room is refused');

  // 紀錄檔：上面每一步都有記到（同步寫入，收到訊息時那一筆已經在檔案裡）
  const logs = fs.readFileSync(srv.log.file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const find = (ev, pred = () => true) => logs.find(l => l.ev === ev && pred(l));
  const code = lobbyA.code;
  assert(logs.every(l => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}$/.test(l.ts)), 'every line has a timestamp');
  assert(find('server.start', l => l.version === versionLabel(VERSION)) && find('conn.open') && find('player.hello', l => l.pid === a.id && l.name === '甲'), 'connection / hello logged');
  assert(find('room.create', l => l.room === code && l.pid === a.id), 'room.create logged');
  assert(find('room.join', l => l.room === code && l.pid === b.id && l.players === 2 && l.via === 'list'), 'room.join logged');
  assert(find('lobby.browse', l => l.pid === w.id && l.on), 'browse logged');
  assert(find('room.create', l => l.room === lobbyP.code && l.private === true) && find('room.join', l => l.room === lobbyP.code && l.via === 'code' && l.private), 'private room create / join logged');
  assert(find('room.privacy', l => l.room === lobbyP.code && l.private === false) && find('room.privacy.fail', l => l.room === lobbyP.code && l.reason === 'notHost'), 'privacy change logged');
  assert(find('room.start.fail', l => l.room === code && l.reason === 'notReady'), 'refused start logged');
  assert(find('lobby.ready', l => l.pid === a.id && l.ready) && find('lobby.ready', l => l.pid === b.id && l.ready), 'ready logged');
  assert(find('room.start', l => l.room === code && l.players.length === 2 && Number.isInteger(l.seed)), 'room.start logged');
  assert(find('stage.start', l => l.room === code) && find('battle.start', l => l.room === code), 'stage / battle start logged');
  assert(find('turn.start', l => l.room === code && l.actor === a.id && l.ai === false), 'turn.start logged');
  assert(find('move', l => l.room === code && l.pid === a.id), 'move logged');
  assert(find('sticker', l => l.pid === a.id && l.sticker === 'lol') && find('sticker.drop', l => l.reason === 'unknown') && find('sticker.drop', l => l.reason === 'spam'), 'stickers logged');
  assert(find('fire', l => l.room === code && l.pid === a.id && l.weapon === 'cannon' && l.angle === 45) && find('shot', l => l.room === code && l.pid === a.id), 'fire + result logged');
  assert(find('player.disconnect', l => l.room === code && l.pid === b.id && l.inGame), 'disconnect logged');
  assert(find('turn.takeover', l => l.pid === b.id) && find('ai.turn', l => l.actor === b.id && l.takeover), 'AI takeover logged');
  assert(find('player.reconnect', l => l.room === code && l.pid === b.id && l.inGame), 'reconnect logged');
  assert(find('room.join.fail', l => l.code === code && l.reason === 'started'), 'refused join logged');
  const iFire = logs.indexOf(find('fire')), iShot = logs.indexOf(find('shot')), iTurn = logs.indexOf(find('turn.start'));
  assert(iTurn < iFire && iFire < iShot, 'log lines are in order');

  console.log('E2E OK', { code: lobbyA.code, shotHit: shotA.hit.type, flightFrames: shotA.flightFrames, holes: state.snapshot.holes.length, logLines: logs.length });
  a.close(); b2.close(); c.close(); w.close();
  await srv.close();
  fs.rmSync(logDir, { recursive: true, force: true });
  clearTimeout(overall);
  // 不用 process.exit：所有 socket / 計時器都關了，程序會自己結束（Windows 上硬退出會撞到 libuv 的 assert）
} catch (err) {
  console.error('E2E FAIL', err);
  await srv.close();
  fs.rmSync(logDir, { recursive: true, force: true });
  process.exitCode = 1;
  clearTimeout(overall);
}
