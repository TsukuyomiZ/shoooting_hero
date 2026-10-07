import { CONFIG } from '../shared/config.js';
import { logWanted } from '../shared/utils.js';

// 單人練習的紀錄（LOG）：裁判在瀏覽器裡跑，紀錄攢一批（每 2 秒）送回伺服器寫檔（POST /log），玩家看不到。
// - 一次只送一批，回來了才送下一批；網路錯誤 / 429 / 5xx（例如伺服器正在重開）就放回最前面，晚點重送；
//   其他狀態碼（204 收到、400 / 404 / 413 / 415：伺服器不收或沒有這個功能）就算了，不影響遊戲
// - 伺服器一直收不到時最多攢 MAX_BUFFER 筆，再多就丟最舊的，並補一筆 log.dropped 說丟了幾筆
// - 每個請求都用 keepalive（頁面關掉後還能送完）：瀏覽器限制同時在路上的 keepalive 請求加起來 64KB，
//   所以一批最多 MAX_BATCH_BYTES（照 UTF-8 位元組算），在路上的一批 + 離開頁面時的最後一批也不會超過
const FLUSH_MS = 2000;
const MAX_BUFFER = 5000;
const MAX_BATCH_BYTES = 30 * 1024;
const encoder = new TextEncoder();
const bytesOf = (s) => encoder.encode(s).length;

const postLog = (body) => fetch('log', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
}).then(r => r.status);

export class SoloLog {
  // send(body) → Promise<HTTP 狀態碼>；now / schedule / cancel 是時鐘（測試換成假的）
  constructor({ send = postLog, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = (h) => clearTimeout(h) } = {}) {
    this.sid = Math.random().toString(36).slice(2, 8).toUpperCase();
    this.send = send;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.buf = [];
    this.dropped = 0;       // 攢太多丟掉、還沒補 log.dropped 的筆數
    this.timer = null;
    this.inflight = false;
  }

  // 要不要寫由這裡決定（同伺服器的 RoomManager.record）：關掉紀錄就不記；LOG.moves 關掉時不記移動（見 logWanted）
  record(ev, data) {
    if (!CONFIG.LOG.enabled || !logWanted(ev, CONFIG.LOG)) return;
    this.buf.push({ ev, at: this.now(), ...data });
    this.trim();
    this.later();
  }

  trim() {
    const over = this.buf.length - MAX_BUFFER;
    if (over > 0) { this.buf.splice(0, over); this.dropped += over; }
  }

  later() {
    if (!this.timer && !this.inflight && (this.buf.length || this.dropped)) this.timer = this.schedule(() => this.flush(), FLUSH_MS);
  }

  cancelTimer() {
    if (this.timer) { this.cancel(this.timer); this.timer = null; }
  }

  // 取出一批（一筆就超過上限的照樣單獨送）；之前丟掉的先補一筆 log.dropped
  take() {
    if (this.dropped) { this.buf.unshift({ ev: 'log.dropped', at: this.now(), count: this.dropped }); this.dropped = 0; }
    const batch = [];
    let size = 0;
    while (this.buf.length) {
      const n = bytesOf(JSON.stringify(this.buf[0])) + 1;
      if (batch.length && size + n > MAX_BATCH_BYTES) break;
      batch.push(this.buf.shift());
      size += n;
    }
    return batch;
  }

  body(batch) { return JSON.stringify({ sid: this.sid, entries: batch }); }

  requeue(batch) {
    this.buf.unshift(...batch);
    this.trim();
  }

  flush() {
    this.cancelTimer();
    if (this.inflight || (!this.buf.length && !this.dropped)) return;
    const batch = this.take();
    this.inflight = true;
    Promise.resolve()
      .then(() => this.send(this.body(batch)))
      .then((status) => { if (status === 429 || status >= 500) this.requeue(batch); }, () => this.requeue(batch))
      .finally(() => { this.inflight = false; this.later(); });
  }

  // 離開頁面：剩下的用最後一批送出去（不等前一批回來、不重送）；一批裝不下的記成 log.dropped
  flushFinal() {
    this.cancelTimer();
    if (!this.buf.length && !this.dropped) return;
    const batch = this.take();
    if (this.buf.length) batch.push({ ev: 'log.dropped', at: this.now(), count: this.buf.length, unload: true });
    this.buf = [];
    Promise.resolve().then(() => this.send(this.body(batch))).catch(() => {});
  }
}
