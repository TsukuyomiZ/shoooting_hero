import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CONFIG } from '../shared/config.js';
import { Run } from '../shared/run.js';
import { validateCards } from '../shared/cards.js';
import { isSticker, allowSticker } from '../shared/stickers.js';
import { logValue } from '../shared/utils.js';
import { NO_LOG } from './logger.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 去掉容易看錯的 I O 0 1
const ROOM_IDLE_MS = 60_000;                              // 全員斷線多久後回收房間
// 雜訊類紀錄（亂送 / 被擋下的訊息）：正常玩不太會有，限制額度免得被亂送的客戶端灌爆（見 RoomManager.record）
const NOISE_EVENTS = new Set(['msg.bad', 'msg.ignored', 'action.ignored', 'move.reject', 'sticker.drop']);
const NOISE_LIMIT = { windowMs: 10_000, count: 30 };
const CARDS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../shared/cards.json');

const makeId = () => randomBytes(9).toString('base64url');
const sanitizeName = (s) => String(s ?? '').replace(/[\r\n\t]/g, '').trim().slice(0, 12) || '玩家';

function send(client, msg) {
  if (client && client.ws && client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
}

// 每次開局重新讀牌庫，改 JSON 不用重啟伺服器
export function loadCards() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CARDS_PATH, 'utf8'));
  } catch (err) {
    console.error('[cards] 讀不到或解析失敗 shared/cards.json：', err.message);
    return [];
  }
  const { cards, warnings } = validateCards(raw);
  for (const w of warnings) console.warn('[cards] ' + w);
  console.log(`[cards] 載入 ${cards.length} 張牌`);
  return cards;
}

// 管所有房間與「token → 房間/玩家」的重連對照
export class RoomManager {
  // isStale()：伺服器啟動後 shared/ 或 server/ 的程式碼被改過（還跑著舊版）→ 在 welcome 裡提醒客戶端
  // log：遊戲紀錄（server/logger.js 的 GameLog；不給就不記）
  constructor({ isStale = () => false, log = NO_LOG } = {}) {
    this.isStale = isStale;
    this.log = log;
    this.rooms = new Map();    // code → Room
    this.tokens = new Map();   // token → { roomCode, playerId }
    this.connSeq = 0;          // 連線流水號（紀錄裡的 cid：同一條連線先 hello 才有玩家 id）
    this.noise = new Map();    // 雜訊類紀錄的額度：'c<cid>' / 'p<pid>' → { start, count, dropped }
  }

  // 寫一筆紀錄（玩家看不到）；room 給了就標上房號。
  // 雜訊類（亂送 / 被擋下的訊息）每條連線（或每位玩家）每 10 秒最多記 NOISE_LIMIT.count 筆，超過的只計數，
  // 下一個時段開頭（或斷線時）補一筆 log.suppressed 說少記了幾筆——亂送的客戶端塞不爆紀錄檔
  record(ev, data, room = null) {
    if (NOISE_EVENTS.has(ev) && !this.allowNoise(data.cid !== undefined ? `c${data.cid}` : `p${data.pid}`, room)) return;
    this.log.write({ ev, room: room ? room.code : undefined, ...data });
  }

  allowNoise(key, room) {
    const now = Date.now();
    let b = this.noise.get(key);
    if (!b || now - b.start >= NOISE_LIMIT.windowMs) {
      if (b) this.flushNoise(key, room);
      b = { start: now, count: 0, dropped: 0 };
      this.noise.set(key, b);
    }
    if (b.count < NOISE_LIMIT.count) { b.count++; return true; }
    b.dropped++;
    return false;
  }

  flushNoise(key, room) {
    const b = this.noise.get(key);
    if (b && b.dropped) this.log.write({ ev: 'log.suppressed', room: room ? room.code : undefined, key, count: b.dropped });
    this.noise.delete(key);
  }

  // 計時器 / 事件裡丟出的錯誤會讓伺服器當掉：先記一筆 error 再照樣丟出去（當掉的行為不變）
  guard(where, fn, room = null) {
    try {
      return fn();
    } catch (err) {
      this.record('error', { where, error: String((err && err.stack) || err) }, room);
      throw err;
    }
  }

  makeCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  onConnection(ws, { ip = '' } = {}) {
    const client = { ws, id: null, token: null, name: '玩家', room: null, cid: ++this.connSeq, ip };
    this.record('conn.open', { cid: client.cid, ip });
    return client;
  }

  onMessage(client, msg) {
    if (!msg || typeof msg !== 'object') return this.record('msg.bad', { cid: client.cid, pid: client.id || undefined, notObject: logValue(msg) });
    const ignored = (reason) => this.record('msg.ignored', { cid: client.cid, pid: client.id || undefined, t: logValue(msg.t), reason }, client.room);
    switch (msg.t) {
      case 'hello': {
        if (client.id) return ignored('alreadyHello');
        client.name = sanitizeName(msg.name);
        const prev = typeof msg.token === 'string' ? this.tokens.get(msg.token) : null;
        const room = prev && this.rooms.get(prev.roomCode);
        if (room && room.reattach(prev.playerId, client, msg.token)) return;
        client.id = makeId();
        client.token = makeId() + makeId();
        // oldToken = 帶了 token 卻接不回去（房間已經回收 / 已經離開）
        this.record('player.hello', { cid: client.cid, pid: client.id, name: client.name, ip: client.ip, ...(typeof msg.token === 'string' ? { oldToken: true } : {}) });
        send(client, { t: 'welcome', id: client.id, token: client.token, stale: this.isStale() });
        break;
      }
      case 'create': {
        if (!client.id) return ignored('noHello');
        if (client.room) return ignored('alreadyInRoom');
        const room = new Room(this, this.makeCode());
        this.rooms.set(room.code, room);
        this.record('room.create', { pid: client.id, name: client.name }, room);
        room.add(client);
        break;
      }
      case 'join': {
        if (!client.id) return ignored('noHello');
        if (client.room) return ignored('alreadyInRoom');
        const code = String(msg.code || '').trim().toUpperCase();
        const room = this.rooms.get(code);
        const fail = (reason, text) => {
          this.record('room.join.fail', { pid: client.id, name: client.name, code: code.slice(0, 12), reason });
          send(client, { t: 'error', msg: text });
        };
        if (!room) return fail('notFound', '找不到這個房號');
        if (room.started) return fail('started', '這個房間已經開始遊戲了');
        if (room.members.size >= CONFIG.MAX_PLAYERS) return fail('full', `房間已滿（最多 ${CONFIG.MAX_PLAYERS} 人）`);
        room.add(client);
        this.record('room.join', { pid: client.id, name: client.name, players: room.members.size }, room);
        break;
      }
      default:
        if (client.room) client.room.handle(client, msg);
        else ignored('noRoom');
    }
  }

  onClose(client, code) {
    this.record('conn.close', { cid: client.cid, pid: client.id || undefined, name: client.id ? client.name : undefined, code }, client.room);
    this.flushNoise(`c${client.cid}`, client.room);
    if (client.id) this.flushNoise(`p${client.id}`, client.room);
    if (client.room) client.room.onDisconnect(client);
  }

  // reason：empty（大家都離開了）/ idle（全員斷線太久）/ shutdown（伺服器關掉）
  destroyRoom(room, reason) {
    this.record('room.destroy', { reason }, room);
    room.stop();
    this.rooms.delete(room.code);
    for (const [token, ref] of this.tokens) if (ref.roomCode === room.code) this.tokens.delete(token);
  }
}

class Room {
  constructor(manager, code) {
    this.manager = manager;
    this.code = code;
    this.members = new Map();   // playerId → { id, name, ready, client|null }
    this.hostId = null;
    this.started = false;
    this.run = null;
    this.idleTimer = null;
  }

  record(ev, data) { this.manager.record(ev, data, this); }

  // ---- 大廳 ----
  add(client) {
    client.room = this;
    this.members.set(client.id, { id: client.id, name: client.name, ready: false, client });
    if (!this.hostId) this.hostId = client.id;
    this.manager.tokens.set(client.token, { roomCode: this.code, playerId: client.id });
    this.clearIdle();
    this.sendLobby();
  }

  reattach(playerId, client, token) {
    const m = this.members.get(playerId);
    if (!m) return false;
    // replaced = 舊的連線還在（例如同一個分頁重新整理太快、或開了第二個分頁），被這條取代
    this.record('player.reconnect', {
      cid: client.cid, pid: playerId, name: m.name, ip: client.ip, inGame: this.started,
      ...(m.client && m.client.ws.readyState === 1 ? { replaced: true } : {}),
    });
    if (m.client && m.client.ws.readyState === 1) m.client.ws.close(4000, 'replaced');
    m.client = client;
    client.id = playerId;
    client.token = token;
    client.name = m.name;
    client.room = this;
    this.clearIdle();
    send(client, { t: 'welcome', id: playerId, token, stale: this.manager.isStale() });
    if (this.started && this.run) {
      send(client, { t: 'state', ...this.run.statePayload(playerId) });
      this.run.setConnected(playerId, true);
    } else {
      this.sendLobby();
    }
    return true;
  }

  lobbyPayload() {
    return {
      t: 'lobby', code: this.code, hostId: this.hostId, max: CONFIG.MAX_PLAYERS,
      players: [...this.members.values()].map(m => ({ id: m.id, name: m.name, ready: m.ready, connected: !!m.client })),
    };
  }

  sendLobby() { this.broadcast(this.lobbyPayload()); }

  handle(client, msg) {
    const m = this.members.get(client.id);
    if (!m) return;
    // 反應貼圖：大廳、戰鬥、選牌都能丟；送的人自己已經先播了，只轉給其他人
    if (msg.t === 'sticker') {
      const why = !isSticker(msg.id) ? 'unknown' : !allowSticker(m.stickerTimes ||= [], Date.now()) ? 'spam' : null;
      if (why) return this.record('sticker.drop', { pid: client.id, name: m.name, sticker: logValue(msg.id), reason: why });
      this.record('sticker', { pid: client.id, name: m.name, sticker: msg.id });
      this.broadcast({ t: 'sticker', from: client.id, id: msg.id }, client.id);
      return;
    }
    if (this.started) {
      if (msg.t === 'leave') return this.onDisconnect(client, true);
      if (this.run) this.run.handle(client.id, msg);
      return;
    }
    switch (msg.t) {
      case 'ready':
        m.ready = !!msg.ready;
        this.record('lobby.ready', { pid: client.id, name: m.name, ready: m.ready });
        this.sendLobby();
        break;
      case 'start': {
        const notReady = [...this.members.values()].filter(x => !x.ready).map(x => x.name);
        if (client.id !== this.hostId) {
          this.record('room.start.fail', { pid: client.id, name: m.name, reason: 'notHost' });
          return send(client, { t: 'error', msg: '只有房主可以開始' });
        }
        if (notReady.length) {
          this.record('room.start.fail', { pid: client.id, name: m.name, reason: 'notReady', notReady });
          return send(client, { t: 'error', msg: '還有人沒按準備' });
        }
        this.startGame();
        break;
      }
      case 'leave':
        this.record('lobby.leave', { pid: client.id, name: m.name });
        this.remove(client.id);
        client.room = null;
        client.id = null;
        break;
      default:
        this.record('msg.ignored', { cid: client.cid, pid: client.id, t: logValue(msg.t), reason: 'lobby' });
    }
  }

  remove(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    for (const [token, ref] of this.manager.tokens) if (ref.playerId === id) this.manager.tokens.delete(token);
    if (this.hostId === id) {
      this.hostId = this.members.size ? this.members.keys().next().value : null;
      if (this.hostId) this.record('room.host', { pid: this.hostId, name: this.members.get(this.hostId).name });
    }
    if (!this.members.size) return this.manager.destroyRoom(this, 'empty');
    this.sendLobby();
  }

  // ---- 遊戲（一場冒險） ----
  startGame() {
    this.started = true;
    const players = [...this.members.values()].map(m => ({ id: m.id, name: m.name, connected: !!m.client }));
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const io = {
      broadcast: (msg, exceptId) => this.broadcast(msg, exceptId),
      // 計時器裡（下一回合、AI 回合…）丟出的錯誤會讓伺服器當掉：先記下來再照樣丟出去
      schedule: (fn, ms) => setTimeout(() => this.manager.guard('timer', fn, this), ms),
      cancel: (h) => clearTimeout(h),
      now: () => Date.now(),
      record: (ev, data) => this.record(ev, data),   // 裁判 / 肉鴿流程寫紀錄（玩家看不到）
    };
    const cards = loadCards();
    this.record('room.start', {
      pid: this.hostId, name: this.members.get(this.hostId).name, seed, cards: cards.length,
      players: players.map(p => ({ pid: p.id, name: p.name })),
    });
    this.run = new Run({ players, seed, io, cards });
    this.run.start();
  }

  broadcast(msg, exceptId) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) {
      if (m.client && m.id !== exceptId && m.client.ws.readyState === 1) m.client.ws.send(data);
    }
  }

  onDisconnect(client, voluntary = false) {
    const m = this.members.get(client.id);
    if (!m || m.client !== client) return;
    // voluntary = 遊戲中自己按離開（之後不能用 token 接回來）；否則是斷線（遊戲中由 AI 代打、可以重連）
    this.record('player.disconnect', { pid: client.id, name: m.name, inGame: this.started, ...(voluntary ? { voluntary: true } : {}) });
    m.client = null;
    client.room = null;
    if (!this.started) {
      this.remove(client.id);
      return;
    }
    if (this.run) this.run.setConnected(client.id, false);   // 遊戲中斷線 → AI 代打
    if (voluntary) {
      for (const [token, ref] of this.manager.tokens) if (ref.playerId === client.id) this.manager.tokens.delete(token);
    }
    if (![...this.members.values()].some(x => x.client)) {
      this.record('room.idle', { closeInSecs: ROOM_IDLE_MS / 1000 });
      this.idleTimer = setTimeout(() => this.manager.guard('idle', () => this.manager.destroyRoom(this, 'idle'), this), ROOM_IDLE_MS);
    }
  }

  clearIdle() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  stop() {
    this.clearIdle();
    if (this.run) this.run.stop();
    for (const m of this.members.values()) {
      if (m.client && m.client.ws.readyState === 1) m.client.ws.close(4001, 'room closed');
    }
  }
}
