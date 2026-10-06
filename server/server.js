// 靜態檔 + WebSocket 伺服器。啟動：node server/server.js（預設 8123 埠）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';
import { GameLog, NO_LOG } from './logger.js';
import { CONFIG } from '../shared/config.js';
import { logValue } from '../shared/utils.js';
import { VERSION, versionLabel } from '../shared/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};
const SERVE_DIRS = ['client', 'shared', 'css', 'assets'];

// 伺服器邏輯（shared/、shared/mechanics/、server/）只在啟動時載入一次：之後改了檔案，瀏覽器會拿到新版、伺服器卻還跑舊版，
// 兩邊的訊息格式 / 數值對不上（射擊事件解析失敗、血量吃到舊設定）。偵測到就提醒要重啟
const STARTED_AT = Date.now();
const LOGIC_DIRS = ['shared', 'shared/mechanics', 'server'];   // 只看一層：子資料夾要自己列進來
let staleWarned = false;
function codeIsStale() {
  for (const dir of LOGIC_DIRS) {
    let names;
    try { names = fs.readdirSync(path.join(ROOT, dir)); } catch { continue; }
    for (const n of names) {
      if (!/\.(js|json)$/.test(n)) continue;
      let mtime;
      try { mtime = fs.statSync(path.join(ROOT, dir, n)).mtimeMs; } catch { continue; }
      if (mtime <= STARTED_AT) continue;
      if (!staleWarned) {
        staleWarned = true;
        console.warn(`\n⚠ ${dir}/${n} 在伺服器啟動後被修改過：伺服器還在跑舊版程式碼，請關掉重開（Ctrl+C 後再 npm start）\n`);
      }
      return true;
    }
  }
  return false;
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const rel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const first = rel.split(/[/\\]/).filter(Boolean)[0];
  if (rel !== 'index.html' && rel !== `${path.sep}index.html` && !SERVE_DIRS.includes(first)) {
    res.writeHead(404); res.end('not found'); return;
  }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const clientIp = (req) => String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// 單人練習的紀錄：瀏覽器在自己那邊跑裁判，攢一批就 POST 過來（見 client/solo-log.js），照一樣的格式寫進同一個檔。
// 只收 application/json（別的網頁不能不經 CORS 預檢就偷送）、自己認得的形狀、限制大小與每個 ip 的流量；
// room 一律由伺服器蓋成 SOLO-<sid>（瀏覽器送什麼都蓋不掉）。回 429 / 5xx 時瀏覽器會晚點重送，其他狀態碼就算了
const SOLO_LOG_MAX_BYTES = 256 * 1024;         // 一次請求最多多大
const SOLO_LOG_MAX_ENTRIES = 1000;             // 一次請求最多幾筆
const SOLO_LOG_MAX_ENTRY_CHARS = 4096;         // 一筆最多多長（超過只留事件名稱，標 truncated）
const SOLO_LOG_MAX_AGE_MS = 60 * 60 * 1000;    // 瀏覽器記的時間最多往前一小時（伺服器重開時攢著晚點重送的）；更舊或在未來就用收到的時間
const SOLO_LOG_BUDGET = { windowMs: 10_000, bytes: 1024 * 1024 };   // 每個 ip 每 10 秒最多收多少，超過回 429

function soloLogReceiver(log) {
  const budgets = new Map();   // ip → { start, bytes }
  const spend = (ip, bytes, now) => {
    for (const [k, b] of budgets) if (now - b.start >= SOLO_LOG_BUDGET.windowMs) budgets.delete(k);
    const b = budgets.get(ip) || { start: now, bytes: 0 };
    budgets.set(ip, b);
    if (b.bytes + bytes > SOLO_LOG_BUDGET.bytes) return false;
    b.bytes += bytes;
    return true;
  };
  const reply = (res, status) => { res.writeHead(status); res.end(); };

  return function receiveSoloLog(req, res) {
    if (log === NO_LOG) { req.resume(); return reply(res, 204); }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') { req.resume(); return reply(res, 415); }
    const chunks = [];
    let size = 0;
    let tooBig = false;   // 已經回了 413：之後還在路上的資料塊、end 都不再處理（不能回第二次）
    req.on('data', (c) => {
      if (tooBig) return;
      size += c.length;
      if (size > SOLO_LOG_MAX_BYTES) { tooBig = true; reply(res, 413); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      const ip = clientIp(req);
      const now = Date.now();
      if (!spend(ip, size, now)) return reply(res, 429);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400); }
      const sid = String((body && body.sid) || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'anon';
      const entries = Array.isArray(body && body.entries) ? body.entries.slice(0, SOLO_LOG_MAX_ENTRIES) : [];
      const items = [];
      for (const e of entries) {
        if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.ev !== 'string') continue;
        const { ev, at, room, ...data } = e;
        const fresh = Number.isFinite(at) && at <= now + 5000 && at >= now - SOLO_LOG_MAX_AGE_MS;
        let entry = { ev: ev.slice(0, 40), room: `SOLO-${sid}`, ...data, ip };
        if (JSON.stringify(entry).length > SOLO_LOG_MAX_ENTRY_CHARS) entry = { ev: entry.ev, room: entry.room, ip, truncated: true };
        items.push({ entry, at: new Date(fresh ? at : now) });
      }
      log.writeMany(items);
      reply(res, 204);
    });
  };
}

// logDir = 紀錄寫在哪個資料夾（預設 config 的 LOG.dir，相對於專案根目錄）；null 或 CONFIG.LOG.enabled = false 就不記
export function createServer({ port = 8123, host = '0.0.0.0', logDir = path.resolve(ROOT, CONFIG.LOG.dir) } = {}) {
  const log = CONFIG.LOG.enabled && logDir ? new GameLog({ dir: logDir }) : NO_LOG;
  const manager = new RoomManager({ isStale: codeIsStale, log });
  const receiveSoloLog = soloLogReceiver(log);
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === '/log') return receiveSoloLog(req, res);
    serveStatic(req, res);
  });
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const client = manager.onConnection(ws, { ip: clientIp(req) });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { manager.record('msg.bad', { cid: client.cid, pid: client.id || undefined, bytes: data.length }); return; }
      try {
        manager.onMessage(client, msg);
      } catch (err) {
        console.error('[room] error handling', msg && msg.t, err);
        manager.record('msg.error', {
          cid: client.cid, pid: client.id || undefined, t: logValue(msg && msg.t), msg: JSON.stringify(msg).slice(0, 500),
          error: String((err && err.stack) || err),
        }, client.room);
      }
    });
    // 斷線會一路走到 AI 代打 / 結束選牌：那裡出錯一樣會讓伺服器當掉，先記下來（同房間的計時器）
    ws.on('close', (code) => { const room = client.room; manager.guard('close', () => manager.onClose(client, code), room); });
    ws.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`埠 ${port} 已被占用：可能伺服器已經在跑了，直接開 http://localhost:${port} 試試；`);
        console.error(`或換一個埠：set PORT=8124 && npm start`);
      } else {
        console.error('伺服器啟動失敗：', err.message);
      }
      reject(err);
    });
    server.listen(port, host, () => {
      log.write({ ev: 'server.start', version: versionLabel(VERSION), port: server.address().port, host, node: process.version, proc: process.pid });
      resolve({
        server, wss, manager, log,
        port: server.address().port,
        close: () => new Promise((r) => {
          for (const room of [...manager.rooms.values()]) manager.destroyRoom(room, 'shutdown');   // 清掉房間計時器
          for (const c of wss.clients) c.terminate();
          wss.close();
          server.close(() => {
            log.write({ ev: 'server.stop' });
            log.close();
            r();
          });
        }),
      });
    });
  });
}

// 直接執行時啟動
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8123;
  createServer({ port }).then(({ port, log }) => {
    // 最後一道：任何沒接住的錯誤讓伺服器當掉之前，先在紀錄留一筆 crash（Monitor 只旁聽，當掉的行為照舊）
    process.on('uncaughtExceptionMonitor', (err, origin) => {
      log.write({ ev: 'crash', origin, error: String((err && err.stack) || err) });
    });
    console.log(`Shooting Hero 伺服器已啟動：`);
    console.log(`  本機   http://localhost:${port}`);
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const i of ifaces) if (i.family === 'IPv4' && !i.internal) console.log(`  區網   http://${i.address}:${port}`);
    }
    console.log(log.file ? `  紀錄   ${log.file}` : '  紀錄   關閉（config.js 的 LOG.enabled）');
    console.log('');
    console.log('同事用區網網址進不來？多半是 Windows 防火牆擋了 Node.js 的連入，處理方式見 README「同事連不進來」。');
  });
}
