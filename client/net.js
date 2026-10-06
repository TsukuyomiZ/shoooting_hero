import { Run } from '../shared/run.js';
import { validateCards } from '../shared/cards.js';
import { SoloLog } from './solo-log.js';
import { VERSION, versionLabel } from '../shared/version.js';

// 兩種傳輸層，介面一樣：send(msg)、onMessage(cb)
// - WsTransport：連到 Node 伺服器（多人）
// - LocalTransport：在瀏覧器裡直接跑 Referee（單人練習），走一樣的訊息流程

export class WsTransport {
  constructor() {
    this.listeners = [];
    this.ws = null;
    this.name = '';
    this.connected = false;
    this.wantReconnect = false;
    this.reconnectTimer = null;
  }

  connect(name) {
    this.name = name;
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}`);
      this.ws = ws;
      let settled = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'hello', name, token: sessionStorage.getItem('sh_token') || undefined }));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === 'welcome') {
          if (msg.token) sessionStorage.setItem('sh_token', msg.token);
          this.id = msg.id;
          this.connected = true;
          this.wantReconnect = true;
          if (!settled) { settled = true; resolve(msg); }
        }
        this.emit(msg);
      };
      ws.onerror = () => {
        if (!settled) { settled = true; reject(new Error('無法連線到伺服器，請確認 node server/server.js 有在跑')); }
      };
      ws.onclose = (ev) => {
        this.connected = false;
        if (!settled) { settled = true; reject(new Error('連線被關閉')); return; }
        this.emit({ t: 'disconnected', code: ev.code });
        // 房間被關（4001）或被新連線取代（4000）就不重連
        if (this.wantReconnect && ev.code !== 4000 && ev.code !== 4001) this.scheduleReconnect();
      };
    });
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(this.name).catch(() => this.scheduleReconnect());
    }, 2000);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.wantReconnect = false;
    if (this.ws) this.ws.close();
  }

  onMessage(cb) { this.listeners.push(cb); }
  emit(msg) { for (const cb of this.listeners) cb(msg); }
}

export class LocalTransport {
  constructor() {
    this.listeners = [];
    this.id = 'me';
    this.connected = true;
    // 紀錄（玩家看不到，送回伺服器寫檔，見 solo-log.js）。單人沒有離開按鈕，關分頁 / 重新整理就是結束：記一筆 solo.end 再送最後一批
    this.log = new SoloLog();
    this.ended = false;
    addEventListener('pagehide', () => this.end('pagehide'));
  }

  // solo.end：在哪一關、哪個階段結束的（runPhase over = 冒險已經打完，result 是輸贏）
  end(reason) {
    if (this.run && !this.ended) {
      this.ended = true;
      const run = this.run;
      this.log.record('solo.end', {
        reason, stage: run.stage, runPhase: run.phase, round: run.referee ? run.referee.round : 0, ...(run.result ? { result: run.result } : {}),
      });
    }
    this.log.flushFinal();
  }

  // 單人也是一場完整冒險：讀牌庫 → 在瀏覽器裡跑 Run
  async start(name) {
    let cards = [];
    try {
      const res = await fetch('shared/cards.json', { cache: 'no-cache' });
      const { cards: ok, warnings } = validateCards(await res.json());
      for (const w of warnings) console.warn('[cards]', w);
      cards = ok;
    } catch (err) {
      console.error('讀不到牌庫 shared/cards.json', err);
    }
    const players = [{ id: 'me', name }];
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const io = {
      // 經過 JSON 一趟，確保跟真的網路一樣不共用物件
      broadcast: (msg) => setTimeout(() => this.emit(JSON.parse(JSON.stringify(msg))), 0),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (h) => clearTimeout(h),
      now: () => Date.now(),
      record: (ev, data) => this.log.record(ev, data),   // 紀錄（玩家看不到，送回伺服器寫檔）
    };
    this.log.record('solo.start', { version: versionLabel(VERSION), name, seed, cards: cards.length });
    this.run = new Run({ players, seed, io, cards });
    this.emit({ t: 'welcome', id: 'me', token: null });
    this.run.start();
  }

  send(msg) {
    if (msg.t === 'sticker') {   // 貼圖在畫面上已經先播了，單人沒有別人要轉
      this.log.record('sticker', { pid: 'me', sticker: msg.id });
      return;
    }
    if (this.run) this.run.handle('me', JSON.parse(JSON.stringify(msg)));
  }

  close() {
    this.end('close');
    if (this.run) this.run.stop();
  }
  onMessage(cb) { this.listeners.push(cb); }
  emit(msg) { for (const cb of this.listeners) cb(msg); }
}
