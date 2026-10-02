import fs from 'node:fs';
import path from 'node:path';

// 遊戲紀錄（LOG）：每行一筆 JSON，一天一個檔 dir/game-YYYY-MM-DD.log（本機時間），玩家看不到、只給開伺服器的人查。
// 每筆 = { ts, ev, room, ...資料 }；ev 是事件名稱（room.create、move、fire…，完整清單見 README「紀錄（LOG）」）。
// 用同步寫入：伺服器真的當掉時，當掉前的最後幾筆也已經在檔案裡（量不大：移動回報每人每秒最多 moveSendHz 筆）
const pad = (n, w = 2) => String(n).padStart(w, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stampOf = (d) => `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
const EXIST_CHECK_MS = 1000;   // 檔案 / 資料夾在伺服器跑著的時候被刪掉：最多每秒檢查一次，不見了就重建

export class GameLog {
  // now = 伺服器的時鐘（決定寫進哪一天的檔；測試用來模擬跨午夜）
  constructor({ dir, now = () => new Date() }) {
    this.dir = dir;
    this.now = now;
    this.fd = null;
    this.day = null;
    this.checkedAt = 0;
    this.failing = false;   // 寫不進去時只警告一次，之後每筆照樣重試（例如資料夾被鎖住一下）
    this.closed = false;
  }

  // 現在寫的是哪個檔（還沒寫過就是 null）
  get file() { return this.day ? path.join(this.dir, `game-${this.day}.log`) : null; }

  // at = 這筆發生的時間，只影響 ts（單人練習的紀錄是瀏覽器攢一批才送過來，用它自己記的時間）；
  // 寫進哪個檔一律看伺服器現在的日期，送來的時間亂跳也不會讓檔案一直換來換去
  write(entry, at) {
    this.append(this.format(entry, at));
  }

  // 一次寫好幾筆（[{ entry, at }]）：只檢查一次檔案、一次寫進去
  writeMany(items) {
    if (items.length) this.append(items.map(({ entry, at }) => this.format(entry, at)).join(''));
  }

  format(entry, at = this.now()) {
    const { ev, room, ...rest } = entry;
    delete rest.ts;
    try {
      return JSON.stringify({ ts: stampOf(at), ev, room, ...rest }) + '\n';
    } catch (err) {
      return JSON.stringify({ ts: stampOf(at), ev, room, logError: String((err && err.message) || err) }) + '\n';
    }
  }

  append(text) {
    if (this.closed) return;
    try {
      const now = this.now();
      const day = dayOf(now);
      if (day !== this.day || this.fd === null || this.missing(now)) this.open(day);
      fs.writeSync(this.fd, text);
      this.failing = false;
    } catch (err) {
      this.closeFd();
      if (!this.failing) {
        this.failing = true;
        console.warn(`[log] 紀錄寫不進 ${this.dir}：${err.message}`);
      }
    }
  }

  // 開著的檔被刪掉了（Windows 上也刪得掉，之後寫進去的東西就不見了）
  missing(now) {
    const t = now.getTime();
    if (t - this.checkedAt < EXIST_CHECK_MS) return false;
    this.checkedAt = t;
    return !fs.existsSync(this.file);
  }

  open(day) {
    this.closeFd();
    fs.mkdirSync(this.dir, { recursive: true });
    this.fd = fs.openSync(path.join(this.dir, `game-${day}.log`), 'a');
    this.day = day;
  }

  closeFd() {
    if (this.fd === null) return;
    try { fs.closeSync(this.fd); } catch {}
    this.fd = null;
  }

  close() {
    this.closeFd();
    this.closed = true;
  }
}

// 不記紀錄時用的替身（CONFIG.LOG.enabled = false）
export const NO_LOG = { write() {}, writeMany() {}, close() {}, file: null };
