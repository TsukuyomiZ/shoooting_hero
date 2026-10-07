// node test/map-views.js
// 地圖畫面（client/map-views/）：每張地圖拿到對的畫面、一般小關是 plain（掛勾什麼都不做、不畫）；寫錯名字的掛勾 / 沒有畫面的機制會丟錯；
// 架構檢查（讀原始碼）：render.js / game-view.js 不認得任何一張地圖、只透過 map-views/index.js；地圖畫面不碰 GameView 本身（特效走 c.fx、不 import 音效 / 畫面模組）；
// 只給畫面用的欄位不寫在 Entity / 道具上（shared/ 也不提）；
// 真的 GameView（Node 裡、假 canvas）把每種地圖從開場播一段（含 render、王 / 蜜蜂的回合），角色身上不會多出畫面用的欄位；
// 畫面跟著遊戲時間走（update 掛勾；同一串訊息每步之間畫 0 ~ 3 次結果一樣、畫圖不改狀態）、巨蟒的頭平順縮回、大地震擊的碎屑、
// 「閉上了！」照嘴巴的開闔判斷、腳本中斷（丟錯 / setup）清掉出招狀態（abortScript 掛勾）、復活後不再是「中毒倒下」
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/config.js';
import { LEVELS } from '../shared/level.js';
import { Match } from '../shared/match.js';
import { Referee } from '../shared/referee.js';
// 先載入（還沒有假的 window / document）：地圖畫面不碰瀏覽器，在 Node 裡直接載得進來
import { mapViewFor, defineMapView } from '../client/map-views/index.js';

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
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const HOOKS = ['create', 'musicTrack', 'turnScript', 'abortScript', 'update', 'showEvent', 'showDamage', 'turnFx', 'statusFx', 'onPickup', 'predictMove', 'onDeath',
  'drawScene', 'drawEntityFirst', 'drawEntityBare', 'drawEntity', 'drawFigure', 'hpBar', 'drawProjectile', 'hud'];
// 只給畫面用、不該出現在 Entity / match.items 上的欄位（以前放在角色、道具身上的那些）
const VIEW_ONLY = ['viewOpen', 'viewDx', 'viewDy', 'viewT', 'windup', 'windDir', 'charging', 'floatedClosed', 'splashShown',
  'poisonDeath', 'deathHandled', 'netTarget', 'netVy', 'slowMo', 'stepDist', 'anim'];
const matchOf = (id, n = 2) => new Match({ levelId: id, players: mkPlayers(n), seed: 3, stage: LEVELS[id].pool === 'boss' ? 5 : 1 });

// 錄下 canvas 呼叫的假 ctx
function recordingCtx() {
  const calls = [];
  const grad = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : (k === 'createLinearGradient' || k === 'createRadialGradient') ? () => grad
      : (...args) => { calls.push({ fn: k, args }); }),
    set: (o, k, v) => { calls.push({ fn: '=' + String(k), args: [v] }); o[k] = v; return true; },
  });
  return { ctx, calls };
}
// 什麼都不做的特效出口（記下呼叫）
function fakeCtx(match, state) {
  const fx = [];
  const sink = new Proxy({}, { get: (o, k) => (...args) => { fx.push(k); } });
  return { c: { match, time: 1, currentId: null, projectiles: [], state, fx: sink, *shotScript() {} }, fx };
}

await test('每張地圖拿到對的地圖畫面（照 match.mechanic.type）：古樹之庭 / 叢林巨蟒 / 小心擊發各自一個，其他都是 plain；每個掛勾都在', () => {
  const got = {};
  for (const id of Object.keys(LEVELS)) {
    const m = matchOf(id);
    const v = mapViewFor(m);
    got[id] = v.type;
    assert(v.type === m.mechanic.type, `${id}: map view ${v.type} vs mechanic ${m.mechanic.type}`);
    assert(v.type === (LEVELS[id].mechanic ? LEVELS[id].mechanic.type : 'plain'), `${id} → ${v.type}`);
    for (const h of HOOKS) assert(typeof v[h] === 'function', `${id}: hook ${h} missing`);
    assert(Object.isFrozen(v) && mapViewFor(matchOf(id, 1)) === v, `${id}: one shared, frozen map view per type`);
    const s1 = v.create(m), s2 = v.create(m);
    assert(s1 && typeof s1 === 'object' && s1 !== s2, `${id}: create builds a fresh state every time`);
  }
  assert(Object.values(got).filter(t => t !== 'plain').sort().join() === 'hive,snake,tree', 'one map each: ' + J(got));
  return got;
});

await test('plain（一般小關）：每個掛勾都是預設——不畫、不演、不出聲、hud 照一般的那一行', () => {
  const m = matchOf('level1');
  const v = mapViewFor(m);
  assert(v.type === 'plain', 'level1 is plain');
  const { c, fx } = fakeCtx(m, v.create(m));
  const e = m.enemies[0], p = m.players[0];
  const r = recordingCtx();
  v.drawScene(r.ctx, c);
  assert(v.drawEntityBare(r.ctx, c, e) === false && v.drawEntity(r.ctx, c, e, false) === false && v.drawFigure(r.ctx, c, e, false) === false, 'entity hooks fall through');
  assert(v.drawProjectile(r.ctx, c, { weapon: CONFIG.WEAPONS.cannon, x: 1, y: 1, vx: 1, vy: 0, trail: [] }) === false, 'projectile falls through');
  assert(!r.calls.length, 'plain draws nothing: ' + r.calls.map(x => x.fn));
  assert(v.drawEntityFirst(c, e) === false && v.hpBar(c, e) === null, 'no draw-order / hp bar changes');
  assert(v.musicTrack(c) === null, 'no boss music');
  assert([...v.turnScript(c, { actorId: e.id, boss: { steps: [] } })].length === 0, 'empty turn script');
  const line = ['敵人剩餘 1 / 1', '#fca5a5'];
  assert(J(v.hud(c, line)) === J([line]), 'hud = the normal line');
  assert(v.onDeath(c, e) === false && v.showDamage(c, e, { id: e.id, dmg: 5 }) === false && v.turnFx(c, e, { type: 'burn' }) === false, 'falls through to the normal effects');
  assert(v.predictMove(c, p, p.x - 10, p.y) === false, 'nothing to pick up');
  v.showEvent(c, { type: 'explode' }, { items: [], bees: [] });
  v.statusFx(c, p, { type: 'x' });
  v.onPickup(c, p, { id: p.id }, true);
  v.update(c, CONFIG.FIXED_DT);
  v.abortScript(c);
  assert(!fx.length, 'plain uses no effects: ' + fx);
});

await test('寫錯名字的掛勾直接丟錯；沒有地圖畫面的機制也丟錯', () => {
  let msg = null;
  try { defineMapView({ type: 'oops', drawScen() {} }); } catch (e) { msg = e.message; }
  assert(msg && /unknown hook "drawScen"/.test(msg), 'unknown hook throws: ' + msg);
  const ok = defineMapView({ type: 'ok', drawScene() {} });
  assert(ok.hud(null, ['a', 'b'])[0][0] === 'a' && ok.onDeath() === false, 'missing hooks get the defaults');
  msg = null;
  try { mapViewFor({ mechanic: { type: 'nope' } }); } catch (e) { msg = e.message; }
  assert(msg && /no map view for mechanic "nope"/.test(msg), 'unknown mechanic throws: ' + msg);
});

// ---- 架構檢查（讀原始碼）----
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const importsOf = (src) => [...src.matchAll(/^\s*import\b[^;]*?from\s*'([^']+)'/gm)].map(m => m[1]);
// 拿掉註解（這幾個檔案的字串裡沒有 //、/*）
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const linesMatching = (src, re) => codeOf(src).split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => re.test(l));
const show = (bad) => bad.map(([n, l]) => `        ${n}: ${l.trim()}`).join('\n');
const clientFiles = () => fs.readdirSync(path.join(ROOT, 'client'), { recursive: true }).filter(f => f.endsWith('.js')).map(f => 'client/' + f.replace(/\\/g, '/'));

await test('render.js / game-view.js 不認得任何一張地圖：程式碼（註解除外）不提地圖的名字，只透過 map-views/index.js', () => {
  // 地圖的名字：英文的（camelCase 的開頭或中間，例如 treeSpear、snakeBlood、drawTreeScene；全大寫的，例如 SNAKE_BOSS）與畫面上的中文。
  // 不能用 /i：(?![a-z]) 會連大寫字母一起擋掉，treeSpear 就漏掉了
  const MAP_NAMES = /\b(tree|snake|hive|bees?|eye|mouth|treant|minion)(?![a-z])|(Tree|Snake|Hive|Bees?|Eye|Mouth|Treant|Minion)(?![a-z])|\b(TREE|SNAKE|HIVE|BEES?|EYE|MOUTH|TREANT|MINION)(?![A-Z])|closeOnHit|\.part\b|古樹|巨蟒|蜂巢|蜜蜂|樹妖|蛇血/;
  const caught = ['treeSpear', 'snakeBlood', 'drawTreeScene', 'beeTurnScript', 'CONFIG.SNAKE_BOSS', "e.kind === 'hive'", 'e.minion', 'drawEye(ctx)'];
  assert(caught.every(s => MAP_NAMES.test(s)), 'the scan misses: ' + caught.filter(s => !MAP_NAMES.test(s)));
  assert(!['street', 'eyes', 'keyEvent', 'archive'].some(s => MAP_NAMES.test(s)), 'the scan flags ordinary words');
  const out = {};
  for (const f of ['client/render.js', 'client/game-view.js']) {
    const src = read(f);
    const bad = linesMatching(src, MAP_NAMES);
    assert(!bad.length, `${f} mentions a map:\n` + show(bad));
    const imports = importsOf(src);
    const views = imports.filter(s => /map-views\//.test(s));
    assert(views.every(s => s === './map-views/index.js'), `${f} imports a map view directly: ${views}`);
    assert(!imports.some(s => /shared\/(tree-boss|snake-boss|hive)\.js$|-view\.js$/.test(s)), `${f} imports map code: ${imports}`);
    out[f] = views;
  }
  assert(out['client/game-view.js'].length === 1, 'game-view.js picks the map view through index.js');
  return out;
});

await test('地圖畫面不碰 GameView 本身：不 import 音效 / 畫面模組（只 import shared/ 與通用的繪圖小工具），不寫 view.particles / shake / treeFx…（特效走 c.fx）', () => {
  const dir = 'client/map-views/';
  const files = fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.js'));
  assert(['index.js', 'plain.js', 'tree.js', 'snake.js', 'hive.js'].every(f => files.includes(f)), 'map-views/: ' + files);
  const ALLOWED = /^(\.\.\/\.\.\/shared\/[\w-]+\.js|\.\.\/(draw|weapon-art)\.js|\.\/(plain|tree|snake|hive)\.js)$/;
  const GAMEVIEW = /\bview\s*\.|\bsfx\b|\baudio\b|\bdocument\b|\bwindow\b|\.(particles|flashes|linkFlashes|floatTexts|treeFx|snakeFx|painter|banner|shake)\s*(=(?!=)|\.push\b|\[)/;
  for (const f of files) {
    const src = read(dir + f);
    const bad = importsOf(src).filter(s => !ALLOWED.test(s));
    assert(!bad.length, `${dir}${f} imports ${bad}`);
    const touch = linesMatching(src, GAMEVIEW);
    assert(!touch.length, `${dir}${f} touches GameView internals:\n` + show(touch));
  }
  return { files };
});

// 一個檔案裡「一定是畫面記錄」的變數名：每一次 = 都來自 GameView 的 look(e)（this.looks.get）、地圖畫面的 c.state，
// 或同一個檔案裡回傳 c.state 裡一筆的小函式（例如 beeView）；三元式的另一邊只能是 null；而且從來不當參數、for…of 的變數（那可能是 Entity）
function recordNames(code) {
  const helpers = [...code.matchAll(/^function\s+([\w$]+)\s*\(c\b[^)]*\)\s*\{\n([\s\S]*?)\n\}/gm)]
    .filter(m => /\bc\.state\./.test(m[2]) && /\breturn\b/.test(m[2])).map(m => m[1]);
  const SRC = new RegExp(`^(?:(?:this\\.)?look\\(|this\\.looks\\.get\\(|c\\.state\\.${helpers.map(h => `|${h}\\(`).join('')})`);
  const fromRecord = (rhs) => (rhs.includes('?') ? rhs.slice(rhs.indexOf('?') + 1).split(':') : [rhs])
    .map(s => s.trim()).every(s => s === 'null' || s.startsWith('{') || SRC.test(s));
  const binds = new Map();   // 名字 → 每一次 = 的右邊
  for (const m of code.matchAll(/(?<![\w$.])([\w$]+)\s*=(?![=>])\s*([^;\n]+)/g)) binds.set(m[1], [...(binds.get(m[1]) || []), m[2]]);
  const PARAMS = /\(([^()]*)\)\s*=>|([\w$]+)\s*=>|\bfunction\b[\s*]*[\w$]*\s*\(([^()]*)\)|^\s*\*?\s*(?!(?:if|for|while|switch|catch|return)\b)[\w$]+\s*\(([^()]*)\)\s*\{|\bfor\s*\(\s*(?:const|let|var)\s+([\w$]+)\s+(?:of|in)\b/gm;
  const params = new Set([...code.matchAll(PARAMS)]
    .flatMap(m => (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]).split(',').map(s => s.trim().replace(/^\.\.\./, '').replace(/\s*=.*$/, ''))));
  return new Set([...binds].filter(([name, rhs]) => !params.has(name) && rhs.every(fromRecord)).map(([name]) => name));
}

await test('只給畫面用的欄位不寫在角色 / 道具身上：client/ 裡沒有 e.viewOpen = …、delete it.anim 之類（只能寫在畫面自己的記錄上：GameView 的 look(e)、地圖畫面的 c.state），shared/ 也不提', () => {
  // 先確定認得出記錄：從 look / c.state 來的才算，同名的參數（例如 Entity）就不算
  assert(recordNames('const v = this.look(e);\nv.slowMo = true;').has('v'), 'look(e) record');
  assert(recordNames('function rv(c, b) {\n  return c.state.bees.get(b.id);\n}\nconst rec = b ? rv(c, b) : null;').has('rec'), 'c.state helper record');
  assert(!recordNames('const v = this.match.byId(id);\nv.slowMo = true;').has('v'), 'an Entity is not a record');
  assert(!recordNames('const v = this.look(e);\nents.forEach((v) => { v.slowMo = true; });').has('v'), 'a parameter with the same name is not a record');
  assert(!recordNames('const v = this.look(e);\nfor (const v of ents) v.slowMo = true;').has('v'), 'a loop variable with the same name is not a record');
  const names = VIEW_ONLY.join('|');
  // X.欄位 = / += / ||= …（不是 == / ===）、delete X.欄位；X 可以是 look(e) 這種呼叫
  const write = new RegExp(`([\\w$]+(?:\\([^()]*\\))?)\\.(${names})\\s*(?:[-+*/%|&?]{1,2})?=(?!=)|\\bdelete\\s+[\\w$.]+\\.(${names})\\b`, 'g');
  const bad = [], receivers = new Set();
  let scanned = 0;
  for (const f of clientFiles()) {
    const code = codeOf(read(f));
    const records = recordNames(code);
    code.split('\n').forEach((l, i) => {
      for (const m of l.matchAll(write)) {
        scanned++;
        const recv = m[1];
        if (recv && (/^look\(/.test(recv) || records.has(recv))) { receivers.add(`${f}:${recv}`); continue; }
        if (recv === 'this' && m[2] === 'slowMo') continue;   // GameView 自己的 this.slowMo（慢動作開著）
        bad.push(`${f}:${i + 1}: ${l.trim()}`);
      }
    });
  }
  assert(!bad.length, 'view-only fields written on shared objects:\n        ' + bad.join('\n        '));
  assert(scanned > 0 && receivers.size > 0, 'the scan saw the view records');
  const shared = fs.readdirSync(path.join(ROOT, 'shared'), { recursive: true }).filter(f => f.endsWith('.js'));
  const word = new RegExp(`\\b(${names})\\b`);
  for (const f of shared) {
    const hits = linesMatching(read('shared/' + f.replace(/\\/g, '/')), word);
    assert(!hits.length, `shared/${f} mentions a view-only field:\n` + show(hits));
  }
  return { writesChecked: scanned, receivers: [...receivers] };
});

// ---- 真的 GameView ----
// 客戶端模組一載入就碰 window / document / localStorage（音效）；GameView 建構時要 canvas：給最小的假物件（同 volley.js）
const fakeCtx2d = () => new Proxy({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const fakeCanvas = () => ({ width: 1024, height: 768, style: {}, getContext: fakeCtx2d, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }) });
globalThis.window ??= { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document ??= { addEventListener() {}, hidden: false, createElement: fakeCanvas };
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { GameView } = await import('../client/game-view.js');

const fakeIo = () => ({ t: 0, timers: [], log: [], seq: 0,
  broadcast(msg) { this.log.push(JSON.parse(J(msg))); }, schedule(fn, ms) { const h = { at: this.t + ms, fn, id: this.seq++ }; this.timers.push(h); return h; },
  cancel(h) { this.timers = this.timers.filter(x => x !== h); }, now() { return this.t; },
  advance(ms) { const end = this.t + ms; for (;;) { this.timers.sort((a, b) => a.at - b.at || a.id - b.id); const n = this.timers[0]; if (!n || n.at > end) break; this.timers.shift(); this.t = n.at; n.fn(); } this.t = end; } });

await test('真的 GameView：每種地圖（一般 / 古樹之庭 / 叢林巨蟒 / 小心擊發）從開場播一段（全員 AI 代打、小心擊發先打蜂巢一槍；每幀 update + render），有地圖畫面的都播到王 / 蜜蜂的回合：setup 換成那張地圖的畫面與新的狀態，角色 / 道具身上沒有畫面用的欄位', () => {
  const out = {};
  for (const levelId of ['level1', 'treeGarden', 'jungleSerpent', 'beehive']) {
    const players = mkPlayers(2);
    const m = new Match({ levelId, players, seed: 7, stage: LEVELS[levelId].pool === 'boss' ? 5 : 1 });
    for (const p of m.players) { p.hp = p.maxHp = 2000; }
    const io = fakeIo();
    // 小心擊發：AI 不會去打蜂巢，P1 自己先開一槍打蜂巢（狙擊、直線瞄正中），放出蜜蜂才有蜜蜂的回合（出招、衝出去不畫）可以播
    let hiveShot = levelId === 'beehive';
    if (hiveShot && !m.byId('p1').weapons.includes('sniper')) m.byId('p1').weapons.push('sniper');
    const ref = new Referee({ match: m, humans: players, io });
    ref.start();
    for (const p of players) if (!(hiveShot && p.id === 'p1')) ref.setConnected(p.id, false);   // 全員 AI 代打：不用等人操作
    const view = new GameView(fakeCanvas());
    view.music = { play() {}, setRate() {} };
    view.myId = 'p1';
    view.transport = { send() {} };
    const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
    const start = io.log.find(x => x.t === 'start');
    assert(start, `${levelId}: start broadcast`);
    feed();
    const mv = view.mapView, state = view.mapCtx.state;
    assert(mv === mapViewFor(view.match) && mv.type === m.mechanic.type, `${levelId}: GameView uses ${mv && mv.type}`);
    const err = console.error;
    const errors = [];
    console.error = (...a) => errors.push(a.join(' '));
    let boss = 0, stings = 0, charging = 0;
    try {
      for (let k = 0; k < 160 && ref.phase !== 'over'; k++) {
        io.advance(250);
        if (hiveShot && ref.phase === 'turn' && ref.currentId === 'p1') {   // 輪到 P1：打蜂巢一槍，之後交給 AI
          const p1 = m.byId('p1'), hv = m.byId('hive'), mz = p1.muzzle();
          const angle = Math.atan2(-(hv.cy - mz.y), hv.cx - mz.x) * 180 / Math.PI;
          ref.handle('p1', { t: 'fire', weapon: 'sniper', angle, power: 100, x: p1.x, y: p1.y, facing: p1.facing, stamina: p1.stamina });
          ref.setConnected('p1', false);
          hiveShot = false;
        }
        const turns = io.log.filter(x => x.t === 'aiTurn' && x.boss);
        boss += turns.length;
        stings += turns.filter(x => x.boss.steps.some(s => s.action === 'sting')).length;
        feed();
        for (let f = 0; f < 15; f++) {
          view.update(CONFIG.FIXED_DT);
          view.render();
          if (state.bees && [...state.bees.values()].some(r => r.charging)) charging++;   // 蜜蜂衝出去（角色本身不畫）
        }
      }
    } finally { console.error = err; }
    assert(!errors.length, `${levelId}: script errors ${errors[0]}`);
    // 每張有地圖畫面的地圖都真的播到王 / 蜜蜂的回合（不然上面只播到一般的回合，地圖畫面的腳本根本沒跑）
    assert(mv.type === 'plain' ? boss === 0 : boss > 0, `${levelId}: boss turns played: ${boss}`);
    if (levelId === 'beehive') {
      assert(!hiveShot && view.match.entities.some(e => e.kind === 'bee'), `${levelId}: the hive shot released a bee on the client`);
      assert(stings > 0 && charging > 0, `${levelId}: a bee stung and was drawn as the projectile: ${J({ stings, charging })}`);
    }
    for (const e of view.match.entities) {
      const extra = VIEW_ONLY.filter(k => k in e);
      assert(!extra.length, `${levelId}: ${e.id} carries ${extra}`);
    }
    for (const it of view.match.items) assert(!VIEW_ONLY.some(k => k in it), `${levelId}: item ${it.id} carries view fields: ${Object.keys(it)}`);
    // 再來一次 setup（例如重連）：新的狀態
    view.onMessage(JSON.parse(J(start)));
    assert(view.mapCtx.state !== state && view.mapView === mv, `${levelId}: setup builds a fresh map view state`);
    out[levelId] = { type: mv.type, bossTurns: boss, ...(stings ? { stings, charging } : {}), time: Math.round(view.time) };
  }
  return out;
});

// ---- 畫面跟著遊戲時間走、畫圖不改狀態、腳本中斷不留殘影（2026-10-07 的修正）----
const STEP = CONFIG.FIXED_DT;
// 記下每一次呼叫（名字 + 參數）的特效出口
function sinkCtx(match, state) {
  const calls = [];
  const fx = new Proxy({}, { get: (o, k) => (...args) => { calls.push([k, args]); } });
  return { c: { match, time: 1, currentId: null, projectiles: [], state, fx, *shotScript() {} }, calls };
}
// 一場從 start 開始的裁判（全員 AI 代打）：start = 開場的廣播；之後的廣播照 io.advance 一批一批出來
function refereeRun(levelId, { seed = 7, n = 2 } = {}) {
  const players = mkPlayers(n);
  const m = new Match({ levelId, players, seed, stage: LEVELS[levelId].pool === 'boss' ? 5 : 1 });
  for (const p of m.players) { p.hp = p.maxHp = 2000; }
  const io = fakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  for (const p of players) ref.setConnected(p.id, false);
  return { m, io, ref, start: io.log.find(x => x.t === 'start') };
}
// 真的 GameView（假 canvas、音樂不出聲），自己是 p1
function newView() {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = 'p1';
  view.transport = { send() {} };
  return view;
}
// 播完佇列裡的事件（最多 n 步）
const drain = (view, n = 1200) => { for (let f = 0; f < n && (view.script || view.queue.length); f++) view.update(STEP); };
// 固定 seed 的亂數（mulberry32）
const seeded = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

await test('叢林巨蟒：衝撞 / 撕咬的飛行物一消失，頭從衝出去的地方照遊戲時間慢慢縮回原位（不是一幀就彈回去）；同一刻畫兩次頭不會多動', () => {
  const m = matchOf('jungleSerpent');
  const sv = mapViewFor(m);
  const { c } = sinkCtx(m, sv.create(m));
  const s = m.byId('snake');
  const head = () => { sv.drawEntity(recordingCtx().ctx, c, s, false); return c.state.head.get(s.id).dx; };
  const out = {};
  for (const id of ['snakeCharge', 'snakeBite']) {
    c.state.head.clear();
    c.projectiles = [];
    head();   // 平常的位置
    const p = { weapon: CONFIG.WEAPONS[id], x0: s.x - s.hw, y0: s.cy, x: s.x - s.hw, y: s.cy };
    c.projectiles = [p];
    for (let i = 0; i < 40; i++) { c.time += STEP; p.x -= 15; head(); }   // 衝出去 600px（0.67 秒）
    const lunge = head();
    assert(Math.abs(lunge + 600) < 1e-6, `${id}: the head follows the projectile: ${lunge}`);
    c.projectiles = [];   // 撞完 / 咬到：飛行物不見了
    const dx = [];
    for (let i = 0; i < 30; i++) {
      c.time += STEP;
      const a = head(), b = head();
      assert(a === b, `${id}: drawing twice at the same time moved the head: ${a} → ${b}`);
      dx.push(a);
    }
    assert(Math.abs(dx[0] - lunge * 0.84) < 1, `${id}: the first frame back eases 16% (not a snap): ${dx[0].toFixed(1)} from ${lunge}`);
    assert(dx.every((v, i) => v < 0 && (i === 0 || v > dx[i - 1])), `${id}: moves back steadily: ${dx.map(Math.round)}`);
    assert(Math.abs(dx[14]) < 60 && Math.abs(dx[29]) < 4, `${id}: 90% back within 0.25 s, home (no neck) within 0.5 s: ${dx[14].toFixed(1)} / ${dx[29].toFixed(1)}`);
    out[id] = dx.filter((v, i) => i % 5 === 0).map(Math.round);
  }
  return out;
});

await test('古樹之庭：出招預兆的計時（fx.t）與嘴巴開闔照固定步長（update 掛勾）推進；畫圖不改狀態，同一刻畫幾次畫出來都一樣', () => {
  const m = matchOf('treeGarden');
  const tv = mapViewFor(m);
  const { c } = sinkCtx(m, tv.create(m));
  const parts = m.entities.filter(e => e.part);
  const drawAll = () => { const r = recordingCtx(); tv.drawScene(r.ctx, c); for (const e of parts) tv.drawEntity(r.ctx, c, e, false); return J(r.calls); };
  const snap = () => J({ fx: c.state.fx, open: [...c.state.mouthOpen], shut: [...c.state.shut] });
  c.state.fx = { action: 'meditate', t: 0, plane: null, targetId: null, seeds: [] };
  tv.update(c, STEP);
  const s0 = snap(), d0 = drawAll();
  for (let k = 0; k < 3; k++) assert(drawAll() === d0 && snap() === s0, 'drawing again at the same time changes something');
  for (let i = 2; i <= 30; i++) { c.time += STEP; tv.update(c, STEP); }
  assert(Math.abs(c.state.fx.t - 30 * STEP) < 1e-9, 'fx.t = steps × dt: ' + c.state.fx.t);
  // 嘴巴被打閉上：每 1/60 秒往 0 靠近 20%（照 dt 換算：兩個半步 = 一步）
  const mouth = m.byId('mouth');
  const before = c.state.mouthOpen.get(mouth.id);
  mouth.closedTurns = 2;
  c.time += STEP; tv.update(c, STEP);
  const after = c.state.mouthOpen.get(mouth.id);
  assert(before > 0.7 && Math.abs(after - before * 0.8) < 1e-9, `the mouth eases 20% per step: ${before} → ${after}`);
  for (let k = 0; k < 2; k++) { c.time += STEP / 2; tv.update(c, STEP / 2); }
  assert(Math.abs(c.state.mouthOpen.get(mouth.id) - after * 0.8) < 1e-9, 'two half steps = one step');
  return { t: +c.state.fx.t.toFixed(4), mouth: [before, after].map(v => +v.toFixed(3)) };
});

await test('叢林巨蟒：大地震擊的碎屑由 update 每一步放（每秒 36 顆，照遊戲時間；粒子的樣子照舊）、畫飛行物不放；飛完的蛇血記錄由 update 刪、畫圖不刪', () => {
  const m = matchOf('jungleSerpent');
  const sv = mapViewFor(m);
  const { c, calls } = sinkCtx(m, sv.create(m));
  const p = { weapon: CONFIG.WEAPONS.snakeQuake, x: 900, y: 500, vx: -300, vy: 0, trail: [{ x: 900, y: 500 }] };
  c.projectiles = [p];
  c.time = 2;
  const drawP = () => assert(sv.drawProjectile(recordingCtx().ctx, c, p) === true, 'the snake view draws the quake');
  for (let k = 0; k < 5; k++) drawP();
  assert(!calls.length, 'drawing the quake spawns nothing: ' + calls.map(x => x[0]));
  let expect = 0, last;
  const at = [];
  for (let i = 0; i < 60; i++) {
    c.time += STEP;
    p.x -= 5;
    sv.update(c, STEP);
    const tick = Math.floor(c.time * 36);
    if (tick !== last) { expect++; last = tick; at.push(p.x); }
    drawP(); drawP();
  }
  const debris = calls.filter(x => x[0] === 'particle').map(x => x[1][0]);
  assert(calls.every(x => x[0] === 'particle'), 'only debris: ' + calls.map(x => x[0]));
  assert(debris.length === expect && expect >= 35 && expect <= 37, `36 per second of game time: ${debris.length} (expected ${expect})`);
  assert(J(debris.map(d => d.x)) === J(at) && debris.every(d => d.y === 500), 'spawned where the wave is at that step');
  assert(debris.every(d => d.size === 3 && d.life === 0.5 && d.maxLife === 0.5 && d.gravity === 600 && d.vy <= -120 && ['#65a30d', '#a16207'].includes(d.color)), 'same particle shape: ' + J(debris[0]));
  // 蛇血：飛完了畫圖也不刪記錄（畫圖不改狀態），update 才刪
  c.projectiles = [];
  m.items.push({ id: 'a99', type: 'snakeBlood', x: 300, y: 500 });
  c.state.anims.set('a99', { x: 600, y: 480, t0: c.time });
  const drawScene = () => sv.drawScene(recordingCtx().ctx, c);
  c.time += 0.3;
  sv.update(c, STEP);
  assert(c.state.anims.has('a99'), 'still flying after 0.3 s');
  c.time += 0.5;
  for (let k = 0; k < 3; k++) drawScene();
  assert(c.state.anims.has('a99'), 'drawing does not delete the finished animation');
  sv.update(c, STEP);
  assert(!c.state.anims.has('a99'), 'update deletes the finished animation');
  return { debris: debris.length };
});

await test('古樹之口：把張開的嘴打閉上才飄「閉上了！」（閉著再被打不飄）；又張開了——古樹回合結束的 mouthOpen、或沒有 mouthOpen 直接由伺服器的狀態（applyState）——下次打閉上一定飄；重連時已經閉著的不飄', () => {
  const m = matchOf('treeGarden');
  const tv = mapViewFor(m);
  const { c, calls } = sinkCtx(m, tv.create(m));
  const mouth = m.byId('mouth');
  const floats = () => calls.filter(x => x[0] === 'float' && x[1][1] === '閉上了！').length;
  const step = () => { c.time += STEP; tv.update(c, STEP); };
  // 打到嘴巴：事件的狀態（closed）先套上，再交給 showDamage（跟 shared/volley.js → GameView.showShotEvent 的順序一樣）
  const hit = () => {
    mouth.applyEventState({ ...mouth.toEventState(), closed: 2 });
    assert(tv.showDamage(c, mouth, { id: mouth.id, dmg: 0, closed: true }) === true, 'the tree view handles the closed hit');
  };
  const reopen = () => { mouth.applyState({ ...mouth.toState(), closed: 0 }); step(); };
  step();
  hit();
  assert(floats() === 1, 'closing an open mouth floats');
  hit(); step(); hit(); step();
  assert(floats() === 1, 'hitting an already closed mouth does not float again');
  assert(tv.turnFx(c, mouth, { type: 'mouthOpen', id: mouth.id }) === true, 'mouthOpen handled');
  reopen();
  hit();
  assert(floats() === 2, 'reopened by mouthOpen → the next close floats');
  reopen();   // 沒有 mouthOpen：伺服器的狀態直接讓它張開
  hit(); step(); hit();
  assert(floats() === 3, 'reopened by a server state without mouthOpen → the next close still floats (once)');
  const again = sinkCtx(m, tv.create(m));   // 重連：新的畫面狀態，嘴巴本來就閉著
  tv.showDamage(again.c, mouth, { id: mouth.id, dmg: 0, closed: true });
  assert(!again.calls.some(x => x[0] === 'float'), 'already closed at reconnect: no float');
  return { floats: floats() };
});

await test('事件腳本播到一半丟錯、或被 setup（重連的 state、新的一關）丟掉：地圖畫面的出招狀態跟著清掉（古樹 / 巨蟒的預兆、蜜蜂的蓄力與衝出去），不會一直畫著', () => {
  const out = {};
  // 格式壞掉的招式：預兆照播，接著重播（replayVolley）丟 TypeError（在 GameView.advanceScript 的 try 裡）
  const bad = (weapon) => ({ weapon, actorId: 'x', events: 'oops', projectiles: [], flightFrames: 1, settleFrames: 0, results: [] });
  for (const [levelId, actorId, step] of [
    ['treeGarden', 'eye', { action: 'meditate', heal: 0, shot: bad('cannon') }],   // 閉目養神：眼皮閉著
    ['jungleSerpent', 'snake', { action: 'bite', targetId: 'p1', shot: bad('snakeBite') }],   // 撕咬：往後縮、張嘴、眼睛發光
  ]) {
    const { io, start } = refereeRun(levelId);
    const view = newView();
    for (const msg of io.log.splice(0)) view.onMessage(msg);
    const state = view.mapCtx.state;
    const casting = () => !!(state.fx && state.fx.action === step.action);
    const errors = [];
    const err = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    let cast = 0;
    try {
      view.onMessage({ t: 'aiTurn', actorId, boss: { steps: [step] } });
      for (let f = 0; f < 600 && !errors.length; f++) { view.update(STEP); view.render(); if (casting()) cast++; }
    } finally { console.error = err; }
    assert(cast > 0, `${levelId}: the cast played first`);
    assert(errors.length === 1 && /播放事件時出錯/.test(errors[0]), `${levelId}: the bad shot throws inside the script: ${errors}`);
    assert(state.fx === null && !view.script, `${levelId}: the cast state is cleared after the error: ${J(state.fx)}`);
    // 播到一半被 setup 丟掉：舊的那一場的出招狀態也清掉
    view.onMessage({ t: 'aiTurn', actorId, boss: { steps: [step] } });
    for (let f = 0; f < 300 && !casting(); f++) { view.update(STEP); view.render(); }
    assert(casting() && view.script, `${levelId}: mid-cast again`);
    view.onMessage(JSON.parse(J(start)));
    assert(state.fx === null && !view.script && view.mapCtx.state !== state, `${levelId}: setup dropped the script and cleared its cast state: ${J(state.fx)}`);
    out[levelId] = { castFrames: cast };
  }
  // 蜜蜂（直接叫掛勾）：蓄力的抖動、衝出去（角色不畫）
  const hm = matchOf('beehive');
  const hv = mapViewFor(hm);
  const { c, calls } = sinkCtx(hm, hv.create(hm));
  c.state.bees.set('b1', { dir: { x: 1, y: 0 }, windup: 0.6, charging: true });
  hv.abortScript(c);
  const r = c.state.bees.get('b1');
  assert(r.windup === 0 && r.charging === false && !calls.length, 'bee windup / charging cleared: ' + J(r));
  return out;
});

await test('真的 GameView：被毒倒的角色又被伺服器的狀態救回來之後，再被打倒播「被擊倒」，不是「中毒倒下」', () => {
  const { io } = refereeRun('level1');
  const view = newView();
  for (const msg of io.log.splice(0)) view.onMessage(msg);
  const banners = [];
  const show = view.showBanner.bind(view);
  view.showBanner = (str, ...rest) => { banners.push(str); show(str, ...rest); };
  const p2 = view.match.byId('p2');
  const st = (o) => ({ ...p2.toState(), ...o });
  // 回合開始被毒倒（伺服器的 turnFx，atStart）
  view.onMessage({ t: 'turnFx', actorId: 'p2', atStart: true, round: 1, fx: [{ type: 'poison', id: 'p2', dmg: 30, died: true }], entities: [st({ hp: 0, alive: false, cause: 'poison' })] });
  drain(view);
  view.update(STEP);
  assert(!p2.alive && banners.includes('P2 中毒倒下了！'), 'poison death banner: ' + banners);
  // 伺服器的狀態說他活著（applyState 的復活），之後被打倒
  view.onMessage({ t: 'turn', actorId: 'p1', round: 2, ai: true, entities: [st({ hp: 50, alive: true, cause: null })] });
  drain(view);
  view.update(STEP);
  assert(p2.alive, 'revived by the server state');
  banners.length = 0;
  view.onMessage({ t: 'skip', actorId: 'p1', reason: 'timeout', entities: [st({ hp: 0, alive: false, cause: 'hit' })] });
  drain(view);
  view.update(STEP);
  assert(!p2.alive && banners.includes('P2 被擊倒！') && !banners.some(b => /中毒/.test(b)), 'the later death is not a poison death: ' + banners);
  return { banners };
});

await test('真的 GameView：同一串伺服器訊息，每一步 update 之間畫 0 / 1 / 2 / 3 次（背景分頁 / 60 / 120 / 180Hz），每一步之後的遊戲畫面狀態都一樣（古樹的預兆計時、嘴巴開闔、粒子含碎屑、角色、飄字）', () => {
  const RATES = [0, 1, 2, 3];
  const real = Math.random;
  const out = {};
  try {
    for (const [levelId, seed] of [['treeGarden', 1], ['jungleSerpent', 3]]) {
      // 裁判先把整段跑出來（全員 AI 代打），記下每一批廣播
      const { io, ref } = refereeRun(levelId, { seed });
      const batches = [io.log.splice(0)];
      for (let k = 0; k < 120 && ref.phase !== 'over'; k++) { io.advance(250); batches.push(io.log.splice(0)); }
      // 每個畫面各自一樣的亂數：update 一條、render 一條（畫面震動的抖動這種只給畫面用的亂數，不能影響遊戲狀態）
      const runs = RATES.map(rate => {
        const r = { rate, upd: seeded(11), ren: seeded(22) };
        Math.random = r.ren;
        r.view = newView();
        return r;
      });
      const snapOf = (view) => {
        const s = view.mapCtx.state;
        return J({
          time: view.time, q: view.queue.length, script: !!view.script, shake: view.shake, banner: view.banner && view.banner.text,
          fx: s.fx ? [s.fx.action, s.fx.t, s.fx.phase ?? null] : null,
          open: s.mouthOpen ? [...s.mouthOpen] : null, shut: s.shut ? [...s.shut] : null, anims: s.anims ? [...s.anims.keys()] : null,
          parts: view.particles.map(p => [p.x, p.y, p.vx, p.vy, p.life, p.size, p.color]),
          ents: view.match.entities.map(e => [e.id, e.x, e.y, e.hp, e.alive, e.closedTurns]),
          floats: view.floatTexts.map(f => [f.text, f.life]),
        });
      };
      const seen = { actions: new Set(), quakeSteps: 0, debris: 0, mouth: [Infinity, -Infinity], steps: 0 };
      const stepAll = () => {
        const snaps = runs.map(r => {
          Math.random = r.upd;
          r.view.update(STEP);
          Math.random = r.ren;
          for (let k = 0; k < r.rate; k++) r.view.render();
          Math.random = r.upd;
          return snapOf(r.view);
        });
        seen.steps++;
        for (let i = 1; i < snaps.length; i++) {
          if (snaps[i] === snaps[0]) continue;
          const a = JSON.parse(snaps[0]), b = JSON.parse(snaps[i]);
          const keys = Object.keys(a).filter(k => J(a[k]) !== J(b[k]));
          throw new Error(`${levelId} step ${seen.steps}: ${RATES[i]} renders per update ≠ ${RATES[0]}: ${keys.map(k => `${k} ${J(a[k]).slice(0, 120)} vs ${J(b[k]).slice(0, 120)}`).join('; ')}`);
        }
        const v = runs[1].view, s = v.mapCtx.state;
        if (s.fx) seen.actions.add(s.fx.action);
        if (s.mouthOpen) for (const o of s.mouthOpen.values()) { seen.mouth[0] = Math.min(seen.mouth[0], o); seen.mouth[1] = Math.max(seen.mouth[1], o); }
        if (v.projectiles.some(p => p.weapon.id === 'snakeQuake')) seen.quakeSteps++;
        seen.debris = Math.max(seen.debris, v.particles.filter(p => p.gravity === 600 && p.maxLife === 0.5 && p.size === 3).length);
      };
      const errors = [];
      const err = console.error;
      console.error = (...a) => errors.push(a.join(' '));
      try {
        for (const batch of batches) {
          for (const r of runs) { Math.random = r.upd; for (const msg of batch) r.view.onMessage(JSON.parse(J(msg))); }
          for (let f = 0; f < 15; f++) stepAll();
        }
        for (let f = 0; f < 3000 && runs.some(r => r.view.script || r.view.queue.length); f++) stepAll();
      } finally { console.error = err; }
      assert(!errors.length, `${levelId}: script errors ${errors[0]}`);
      const acts = [...seen.actions].sort().join();
      if (levelId === 'treeGarden') {
        assert(['leaves', 'summon', 'trunk'].every(a => seen.actions.has(a)), 'tree casts played: ' + acts);
        assert(seen.mouth[0] < 0.12 && seen.mouth[1] > 1, 'the mouth closed and opened wide: ' + seen.mouth);
      } else {
        assert(seen.actions.has('quake') && seen.quakeSteps > 0 && seen.debris > 0, `a quake raised debris: ${acts} ${J({ q: seen.quakeSteps, d: seen.debris })}`);
      }
      out[levelId] = { steps: seen.steps, casts: acts, ...(seen.quakeSteps ? { quakeSteps: seen.quakeSteps, debrisMax: seen.debris } : { mouth: seen.mouth.map(v => +v.toFixed(2)) }) };
    }
  } finally { Math.random = real; }
  return out;
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
