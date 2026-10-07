// node test/map-views.js
// 地圖畫面（client/map-views/）：每張地圖拿到對的畫面、一般小關是 plain（掛勾什麼都不做、不畫）；寫錯名字的掛勾 / 沒有畫面的機制會丟錯；
// 架構檢查（讀原始碼）：render.js / game-view.js 不認得任何一張地圖、只透過 map-views/index.js；地圖畫面不碰 GameView 本身（特效走 c.fx、不 import 音效 / 畫面模組）；
// 只給畫面用的欄位不寫在 Entity / 道具上（shared/ 也不提）；
// 真的 GameView（Node 裡、假 canvas）把每種地圖從開場播一段（含 render、王 / 蜜蜂的回合），角色身上不會多出畫面用的欄位
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
const HOOKS = ['create', 'musicTrack', 'turnScript', 'showEvent', 'showDamage', 'turnFx', 'statusFx', 'onPickup', 'predictMove', 'onDeath',
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

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
