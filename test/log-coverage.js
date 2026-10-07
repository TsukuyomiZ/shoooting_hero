// node test/log-coverage.js
// 「每個動作都要記 LOG」的結構保證（收訊息的入口：伺服器 RoomManager.onMessage、單人 LocalTransport.send）：
// - 客戶端會送的訊息種類從 client/ 的原始碼抓（新加一種訊息自動被測到，不用改這個檔）；
//   每一種在每個階段（還沒 hello、大廳、房間裡（房主 / 成員 / 都準備好了）、遊戲中；戰鬥輪到自己 / 別人、結算中、選牌、選完、結束）
//   都送一次：一定留下至少一筆紀錄，而且不是入口補的 msg.unlogged（處理的程式自己記了）；
// - 入口的保底：處理途中一筆都沒記 → 補一筆 msg.unlogged（算雜訊類，有上限）；
// - 模糊測試：同樣的訊息、一次把一個欄位換成亂送的值（超長字串、toString 壞掉的物件、陣列、NaN），
//   照樣有處理的程式自己記的紀錄，寫出來的每筆紀錄都不會原封不動帶著那個值（客戶端送來的值都要經過 logValue），處理的程式也不會丟錯
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/config.js';
import { Run } from '../shared/run.js';
import { validateCards } from '../shared/cards.js';
import { STICKERS } from '../shared/stickers.js';
import { RoomManager } from '../server/rooms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const CARDS = validateCards(JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/cards.json'), 'utf8'))).cards;

// ---- 客戶端會送的訊息種類：client/ 裡 send({ t: '…' }) / ws.send(JSON.stringify({ t: '…' })) ----
const jsFiles = (dir) => fs.readdirSync(path.join(ROOT, dir), { recursive: true })
  .filter(f => f.endsWith('.js')).map(f => path.join(ROOT, dir, f));
const TYPES = [...new Set(jsFiles('client').flatMap(f => [...fs.readFileSync(f, 'utf8')
  .matchAll(/\bsend\(\s*(?:JSON\.stringify\(\s*)?\{\s*t:\s*'(\w+)'/g)].map(m => m[1])))].sort();

// 每種訊息一份合理的內容（c = 目前的狀態）；沒有範本的新訊息只帶 t（照樣檢查有沒有記）
const TEMPLATE = {
  hello: () => ({ name: '甲', token: 'x' }),
  browse: () => ({ on: true }),
  create: () => ({ private: true, name: '乙' }),
  join: (c) => ({ code: c.code || 'ZZZZ', via: 'list', name: '丙' }),
  ready: () => ({ ready: true }),
  privacy: () => ({ private: true }),
  start: () => ({}),
  leave: () => ({}),
  sticker: () => ({ id: STICKERS[0].id }),
  pick: (c) => ({ cardId: c.offer ? c.offer.id : 'nope', discard: 'cannon', link: 'p2' }),
  move: (c) => ({ x: c.me ? c.me.x + 3 : 1, y: c.me ? c.me.y : 1, vy: 0, facing: 1, stamina: c.me ? c.me.stamina - 1 : 0, vine: -1, safe: { x: 1, y: 1 } }),
  slow: () => ({ on: true, why: 'land' }),
  weapon: () => ({ weapon: 'sniper' }),
  fire: (c) => ({ weapon: 'cannon', angle: 45, power: 50, x: c.me ? c.me.x : 1, y: c.me ? c.me.y : 1, vy: 0, facing: 1, stamina: 0, vine: -1 }),
};
const messageOf = (t, c) => ({ t, ...(TEMPLATE[t] ? TEMPLATE[t](c) : {}) });

// ---- 伺服器：RoomManager 的各個階段（每次都是新的一個，寫出來的紀錄收在 lines）----
function manager() {
  const lines = [];
  const mgr = new RoomManager({ log: { write: (e) => lines.push(e) } });
  const conn = () => mgr.onConnection({ readyState: 1, send() {}, close() {} }, { ip: '1.2.3.4' });
  return { mgr, lines, conn };
}
const ROOM_PHASES = {
  fresh: () => { const m = manager(); return { ...m, who: m.conn(), ctx: {} }; },
  hello: () => { const m = manager(); const a = m.conn(); m.mgr.onMessage(a, { t: 'hello', name: '甲' }); return { ...m, who: a, ctx: {} }; },
  browsing: () => {
    const m = manager(); const a = m.conn();
    m.mgr.onMessage(a, { t: 'hello', name: '甲' }); m.mgr.onMessage(a, { t: 'browse', on: true });
    return { ...m, who: a, ctx: {} };
  },
  host: () => {
    const m = manager(); const a = m.conn();
    m.mgr.onMessage(a, { t: 'hello', name: '甲' }); m.mgr.onMessage(a, { t: 'create' });
    return { ...m, who: a, ctx: { code: a.room.code } };
  },
  member: () => {
    const m = manager(); const a = m.conn(); const b = m.conn();
    m.mgr.onMessage(a, { t: 'hello', name: '甲' }); m.mgr.onMessage(a, { t: 'create' });
    m.mgr.onMessage(b, { t: 'hello', name: '乙' }); m.mgr.onMessage(b, { t: 'join', code: a.room.code });
    return { ...m, who: b, ctx: { code: a.room.code } };
  },
  allReady: () => {
    const m = manager(); const a = m.conn(); const b = m.conn();
    m.mgr.onMessage(a, { t: 'hello', name: '甲' }); m.mgr.onMessage(a, { t: 'create' }); m.mgr.onMessage(a, { t: 'ready', ready: true });
    m.mgr.onMessage(b, { t: 'hello', name: '乙' }); m.mgr.onMessage(b, { t: 'join', code: a.room.code }); m.mgr.onMessage(b, { t: 'ready', ready: true });
    return { ...m, who: a, ctx: { code: a.room.code } };
  },
  inGame: () => {
    const m = manager(); const a = m.conn();
    m.mgr.onMessage(a, { t: 'hello', name: '甲' }); m.mgr.onMessage(a, { t: 'create' });
    m.mgr.onMessage(a, { t: 'ready', ready: true }); m.mgr.onMessage(a, { t: 'start' });
    return { ...m, who: a, ctx: { code: a.room.code } };
  },
};
// 在某個階段送一則訊息，回傳這則訊息寫出的紀錄（遊戲中的房間送完就停掉，計時器不會留著）
function sendToRoom(phase, make) {
  const s = ROOM_PHASES[phase]();
  const room = s.who.room;
  s.lines.length = 0;
  const msg = make(s.ctx);
  s.mgr.onMessage(s.who, msg);
  const out = s.lines.slice();
  for (const r of new Set([room, s.who.room])) if (r && r.started) r.stop();
  return out;
}

// ---- 肉鴿流程 + 裁判（假時鐘）：戰鬥中的各個階段 ----
class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.records = []; this.seq = 0; }
  broadcast() {}
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
const until = (io, pred, max = 600_000) => { const s = io.t; while (!pred() && io.t - s < max) io.advance(100); return pred(); };
const RUN_PHASES = ['ownTurn', 'otherTurn', 'resolving', 'pick', 'picked', 'over'];
function runAt(phase) {
  const io = new FakeIo();
  const run = new Run({ players: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }], seed: 3, io, cards: CARDS });
  run.start();
  assert(until(io, () => run.referee && run.referee.phase === 'turn' && run.referee.currentId === 'p1'), 'p1 turn');
  for (const e of run.match.entities) e.hp = e.maxHp = 5000;
  const me = run.match.byId('p1');
  if (phase === 'resolving') run.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50, x: me.x, y: me.y, facing: 1, stamina: 0 });
  if (phase === 'pick' || phase === 'picked' || phase === 'over') {
    for (const e of (phase === 'over' ? run.match.players : run.match.enemies)) e.die('hit');
    io.advance(31_000);
    assert(until(io, () => run.phase === (phase === 'over' ? 'over' : 'pick')), 'reach ' + phase);
    if (phase === 'picked') run.handle('p1', { t: 'pick', cardId: run.offers.p1[0].id });
  }
  const who = phase === 'otherTurn' ? 'p2' : 'p1';
  io.records.length = 0;
  return { io, run, who, ctx: { me: run.match && run.match.byId(who), offer: run.offers && run.offers[who] && run.offers[who][0] } };
}
function sendToRun(phase, make) {
  const s = runAt(phase);
  s.run.handle(s.who, make(s.ctx));
  return s.io.records.slice();
}

await test('客戶端會送的訊息種類從原始碼抓得到（含已知的 14 種），每一種都有範本或只帶 t', () => {
  const KNOWN = ['hello', 'browse', 'create', 'join', 'ready', 'privacy', 'start', 'leave', 'sticker', 'pick', 'move', 'slow', 'weapon', 'fire'];
  assert(KNOWN.every(t => TYPES.includes(t)), 'missing from the scan: ' + KNOWN.filter(t => !TYPES.includes(t)));
  return { types: TYPES };
});

await test('伺服器：每種訊息在每個階段都留下自己的紀錄（不是入口補的 msg.unlogged）', () => {
  const bad = [];
  for (const phase of Object.keys(ROOM_PHASES)) for (const t of [...TYPES, 'zzz']) {
    const lines = sendToRoom(phase, (c) => messageOf(t, c));
    if (!lines.length || lines.some(l => l.ev === 'msg.unlogged')) bad.push(`${phase}/${t}: ${J(lines.map(l => l.ev))}`);
  }
  assert(!bad.length, 'not logged by the handler:\n        ' + bad.join('\n        '));
  return { phases: Object.keys(ROOM_PHASES).length, types: TYPES.length + 1 };
});

await test('戰鬥 / 選牌（肉鴿流程 + 裁判）：每種訊息在每個階段都有紀錄', () => {
  const bad = [];
  for (const phase of RUN_PHASES) for (const t of [...TYPES, 'zzz']) {
    const recs = sendToRun(phase, (c) => messageOf(t, c));
    if (!recs.length) bad.push(`${phase}/${t}`);
  }
  assert(!bad.length, 'no record:\n        ' + bad.join('\n        '));
  return { phases: RUN_PHASES.length };
});

await test('入口的保底：處理途中一筆都沒記 → 補一筆 msg.unlogged（算雜訊類：每 10 秒最多 30 筆，斷線時補 log.suppressed）', () => {
  const s = ROOM_PHASES.host();
  s.who.room.handle = () => {};   // 假裝某條路徑漏記
  s.lines.length = 0;
  s.mgr.onMessage(s.who, { t: 'ready', ready: { big: 1 } });
  const u = s.lines.at(-1);
  assert(s.lines.length === 1 && u.ev === 'msg.unlogged' && u.t === 'ready' && u.pid === s.who.id && u.room === s.who.room.code, 'msg.unlogged: ' + J(s.lines));
  for (let i = 0; i < 40; i++) s.mgr.onMessage(s.who, { t: 'ready' });
  assert(s.lines.filter(l => l.ev === 'msg.unlogged').length === 30, 'capped like other noise');
  s.mgr.onClose(s.who, 1000);
  assert(s.lines.some(l => l.ev === 'log.suppressed' && l.count === 11), 'suppressed count: ' + J(s.lines.filter(l => l.ev === 'log.suppressed')));
  // 被雜訊上限、LOG.moves 擋掉的也算記過（不會再補 msg.unlogged）
  const saved = CONFIG.LOG.moves;
  CONFIG.LOG.moves = false;
  try {
    const g = ROOM_PHASES.host();
    g.lines.length = 0;
    g.mgr.record('move', { pid: g.who.id });
    assert(!g.lines.length && g.mgr.recorded > 0, 'a skipped move still counts as recorded');
  } finally { CONFIG.LOG.moves = saved; }
});

await test('單人（LocalTransport.send）：貼圖、還沒有 run、run 沒記都有紀錄', async () => {
  globalThis.addEventListener ||= () => {};   // 瀏覽器才有（離開頁面時送最後一批）
  const { LocalTransport } = await import('../client/net.js');
  const lt = new LocalTransport();
  lt.log.send = async () => 204;
  lt.log.schedule = () => null;
  const evs = () => lt.log.buf.map(e => e.ev);
  lt.send({ t: 'sticker', id: 'Z'.repeat(500) });
  assert(lt.log.buf.at(-1).ev === 'sticker' && lt.log.buf.at(-1).sticker.length <= 20, 'sticker id cut short: ' + J(lt.log.buf.at(-1)));
  lt.send({ t: 'move', x: 1 });
  assert(lt.log.buf.at(-1).ev === 'action.ignored' && lt.log.buf.at(-1).reason === 'noRun', 'no run yet: ' + evs());
  lt.run = { handle() {} };   // 假裝某條路徑漏記
  lt.send({ t: 'fire' });
  assert(lt.log.buf.at(-1).ev === 'msg.unlogged' && lt.log.buf.at(-1).t === 'fire', 'msg.unlogged: ' + evs());
  lt.run = { handle: (id, m) => lt.record('weapon', { pid: id, weapon: m.weapon }) };
  const n = lt.log.buf.length;
  lt.send({ t: 'weapon', weapon: 'sniper' });
  assert(lt.log.buf.length === n + 1 && lt.log.buf.at(-1).ev === 'weapon', 'a recorded message gets no msg.unlogged');
});

// ---- 模糊測試：一次換一個欄位成亂送的值 ----
const LONG = 'Z'.repeat(5000);
const HOSTILE = [LONG, { big: LONG, toString: 0 }, [LONG], NaN];
// 紀錄裡有沒有帶著亂送的值：超長的 Z、或物件的 big 欄位
const leaks = (rec) => { const s = J(rec); return /Z{60}/.test(s) || s.includes('"big"'); };
function fuzz(send, phases) {
  const bad = [];
  let cases = 0;
  for (const phase of phases) for (const t of TYPES) {
    const fields = ['t', ...Object.keys(TEMPLATE[t] ? TEMPLATE[t]({}) : {})];
    for (const f of fields) for (const v of HOSTILE) {
      cases++;
      let recs;
      try {
        recs = send(phase, (c) => ({ ...messageOf(t, c), [f]: v }));
      } catch (err) {
        bad.push(`${phase}/${t}.${f}=${typeof v}: threw ${String(err.message || err).slice(0, 80)}`);
        continue;
      }
      if (!recs.length || recs.some(r => r.ev === 'msg.unlogged')) bad.push(`${phase}/${t}.${f}=${typeof v}: not logged by the handler ${J(recs.map(r => r.ev))}`);
      const leaked = recs.filter(leaks);
      if (leaked.length) bad.push(`${phase}/${t}.${f}=${typeof v}: ${leaked.map(r => J(r).slice(0, 160)).join(' | ')}`);
    }
  }
  return { bad, cases };
}

await test('模糊測試（伺服器的大廳 / 房間）：照樣有紀錄、亂送的值不會原封不動寫進紀錄，處理的程式也不會丟錯', () => {
  const { bad, cases } = fuzz(sendToRoom, Object.keys(ROOM_PHASES));
  assert(!bad.length, `${bad.length} problems:\n        ` + bad.slice(0, 40).join('\n        '));
  return { cases };
});

await test('模糊測試（戰鬥 / 選牌）：照樣有紀錄、亂送的值不會原封不動寫進紀錄，處理的程式也不會丟錯', () => {
  const { bad, cases } = fuzz(sendToRun, ['ownTurn', 'pick']);
  assert(!bad.length, `${bad.length} problems:\n        ` + bad.slice(0, 40).join('\n        '));
  return { cases };
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);   // 單人的 SoloLog 會排計時器送紀錄：不等它
