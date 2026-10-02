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

// 伺服器邏輯（shared/、server/）只在啟動時載入一次：之後改了檔案，瀏覽器會拿到新版、伺服器卻還跑舊版，
// 兩邊的訊息格式 / 數值對不上（射擊事件解析失敗、血量吃到舊設定）。偵測到就提醒要重啟
const STARTED_AT = Date.now();
const LOGIC_DIRS = ['shared', 'server'];
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

// 單人練習的紀錄：瀏覽器在自己那邊跑裁判，攢一批就 POST 過來（見 client/net.js 的 SoloLog），照一樣的格式寫進同一個檔。
// 只收自己認得的形狀、限制大小，room 一律由伺服器蓋成 SOLO-<sid>（瀏覽器送什麼都蓋不掉）
const SOLO_LOG_MAX_BYTES = 256 * 1024;
const SOLO_LOG_MAX_ENTRIES = 2000;
function receiveSoloLog(req, res, log) {
  if (log === NO_LOG) { req.resume(); res.writeHead(204); res.end(); return; }
  const chunks = [];
  let size = 0;
  let tooBig = false;   // 已經回了 413：之後還在路上的資料塊、end 都不再處理（不能回第二次）
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size > SOLO_LOG_MAX_BYTES) { tooBig = true; res.writeHead(413); res.end(); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400); res.end(); return; }
    const sid = String((body && body.sid) || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'anon';
    const entries = Array.isArray(body && body.entries) ? body.entries.slice(0, SOLO_LOG_MAX_ENTRIES) : [];
    const ip = clientIp(req);
    const now = Date.now();
    for (const e of entries) {
      if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.ev !== 'string') continue;
      const { ev, at, room, ...data } = e;
      const when = Number.isFinite(at) && Math.abs(at - now) < 86_400_000 ? new Date(at) : new Date(now);
      log.write({ ev: ev.slice(0, 40), room: `SOLO-${sid}`, ...data, ip }, when);
    }
    res.writeHead(204);
    res.end();
  });
}

// logDir = 紀錄寫在哪個資料夾（預設 config 的 LOG.dir，相對於專案根目錄）；null 或 CONFIG.LOG.enabled = false 就不記
export function createServer({ port = 8123, host = '0.0.0.0', logDir = path.resolve(ROOT, CONFIG.LOG.dir) } = {}) {
  const log = CONFIG.LOG.enabled && logDir ? new GameLog({ dir: logDir }) : NO_LOG;
  const manager = new RoomManager({ isStale: codeIsStale, log });
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && new URL(req.url, 'http://x').pathname === '/log') return receiveSoloLog(req, res, log);
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
          cid: client.cid, pid: client.id || undefined, t: msg && msg.t, error: String((err && err.stack) || err),
        }, client.room);
      }
    });
    ws.on('close', (code) => manager.onClose(client, code));
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
      log.write({ ev: 'server.start', port: server.address().port, host, node: process.version, proc: process.pid });
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
