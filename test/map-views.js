// node test/map-views.js
// 地圖畫面（client/map-views/）：每張地圖拿到對的畫面、一般小關是 plain（掛勾什麼都不做、不畫）；寫錯名字的掛勾 / 沒有畫面的機制會丟錯；
// 架構檢查（讀原始碼）：render.js / game-view.js 不認得任何一張地圖、只透過 map-views/index.js；地圖畫面不碰 GameView 本身（特效走 c.fx、不 import 音效 / 畫面模組）；
// 只給畫面用的欄位不寫在 Entity / 道具上（shared/ 也不提）；
// 真的 GameView（Node 裡、假 canvas）把每種地圖從開場播一段（含 render、王 / 蜜蜂的回合），角色身上不會多出畫面用的欄位；
// 畫面跟著遊戲時間走（update 掛勾；同一串訊息每步之間畫 0 ~ 3 次結果一樣、畫圖不改狀態）、巨蟒的頭平順縮回、大地震擊的碎屑、
// 「閉上了！」照嘴巴的開闔判斷、腳本中斷（丟錯 / setup）清掉出招狀態（abortScript 掛勾）、復活後不再是「中毒倒下」；
// turn / turnFx 帶的場上道具經地圖機制換進 match.mechState（GameView 不認得主人）；
// 右上的名單框：地圖畫面給的幾行平常的字就放得下（Boss / 菁英的血量、下一招分兩行），太長的名字 / 一行由 render 縮小、截掉，不超出框；
// 血條旁的燃燒 / 中毒 / 流血標記不超出畫面（站在最右邊的角色整排改放到血條左邊）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/core/config.js';
import { LEVELS } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
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
const HOOKS = ['create', 'musicTrack', 'turnScript', 'abortScript', 'update', 'showEvent', 'showDamage', 'turnFx', 'statusFx', 'onPickup', 'predictMove', 'struggle', 'onStruggle', 'onDeath',
  'drawScene', 'shaded', 'drawShade', 'drawEntityFirst', 'drawEntityBare', 'drawEntity', 'drawFigure', 'hpBar', 'drawProjectile', 'hud'];
// 只給畫面用、不該出現在 Entity / 場上的道具（地圖機制的狀態 match.mechState.items）上的欄位（以前放在角色、道具身上的那些）
const VIEW_ONLY = ['viewOpen', 'viewDx', 'viewDy', 'viewT', 'windup', 'windDir', 'charging', 'floatedClosed', 'splashShown',
  'poisonDeath', 'deathHandled', 'netTarget', 'netVy', 'slowMo', 'stepDist', 'anim', 'bleedSeen', 'bleedLoss', 'bleedClock'];
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

await test('每張地圖拿到對的地圖畫面（照 match.mechanic.type）：古樹之庭 / 叢林巨蟒 / 小心擊發 / 岩穴 / 地心探險 / 大樹守衛 / 巨蠍巢穴各自一個，其他都是 plain；每個掛勾都在', () => {
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
  assert(Object.values(got).filter(t => t !== 'plain').sort().join() === 'cave,cyclops,fairy,gaia,guardian,hive,monkey,prison,ranger,scorpion,snake,spider,swordsman,tengu,tree', 'one map each: ' + J(got));
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
  const MAP_NAMES = /\b(tree|snake|hive|bees?|eye|mouth|treant|minion|cave|torch(?:es)?|stalactites?|cyclops|boulder|scorpion|prison|executioner|guillotine|chandeliers?|swordsman|tengu|ranger|fairy|fairies|clones?|monkeys?|peels?|coconuts?|bananas?|gaia)(?![a-z])|(Tree|Snake|Hive|Bees?|Eye|Mouth|Treant|Minion|Cave|Torch(?:es)?|Stalactites?|Cyclops|Boulder|Scorpion|Prison|Executioner|Guillotine|Chandeliers?|Swordsman|Tengu|Ranger|Fairy|Fairies|Clones?|Monkeys?|Peels?|Coconuts?|Bananas?|Gaia)(?![a-z])|\b(TREE|SNAKE|HIVE|BEES?|EYE|MOUTH|TREANT|MINION|CAVE|CYCLOPS|SCORPION|EXECUTIONER|SWORDSMAN|TENGU|RANGER|FAIRY|MONKEY|GAIA)(?![A-Z])|closeOnHit|\.part\b|古樹|巨蟒|蜂巢|蜜蜂|樹妖|蛇血|洞穴|岩穴|鐘乳石|火把|獨眼巨人|地心探險|巨蠍|處刑|囚籠|斷頭台|吊燈|監獄|流浪劍士|劍氣|天狗|羽刃|風彈|遊俠|貫穿箭|箭雨|藤蔓陷阱|妖精|分身|咬耳朵|星屑彈|調包|猴王|香蕉|椰子|丟回去|蓋亞|大地之母|祭壇|瘴氣|自然之花|最後之光|誅滅/;
  const caught = ['treeSpear', 'snakeBlood', 'drawTreeScene', 'beeTurnScript', 'CONFIG.SNAKE_BOSS', "e.kind === 'hive'", 'e.minion', 'drawEye(ctx)', 'drawTorches', "id === 'stalactite'"];
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
    assert(!imports.some(s => /shared\/maps\/(tree-boss|snake-boss|hive|cave|cyclops|guardian|scorpion|prison|swordsman|tengu)\.js$|-view\.js$/.test(s)), `${f} imports map code: ${imports}`);
    out[f] = views;
  }
  assert(out['client/game-view.js'].length === 1, 'game-view.js picks the map view through index.js');
  return out;
});

await test('地圖畫面不碰 GameView 本身：不 import 音效 / 畫面模組（只 import shared/ 與通用的繪圖小工具），不寫 view.particles / shake / treeFx…（特效走 c.fx）', () => {
  const dir = 'client/map-views/';
  const files = fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.js'));
  assert(['index.js', 'plain.js', 'tree.js', 'snake.js', 'hive.js', 'cave.js', 'cyclops.js', 'guardian.js', 'scorpion.js', 'prison.js', 'swordsman.js', 'tengu.js', 'spider.js', 'ranger.js', 'fairy.js', 'monkey.js', 'gaia.js'].every(f => files.includes(f)), 'map-views/: ' + files);
  const ALLOWED = /^(\.\.\/\.\.\/shared\/(?:[\w-]+\/)+[\w-]+\.js|\.\.\/(draw|weapon-art)\.js|\.\/(plain|tree|snake|hive|cave|cyclops|guardian|scorpion|prison|swordsman|tengu|spider|ranger|fairy|monkey|gaia|marks-draw)\.js)$/;   // marks-draw = 指名的通用畫面（古樹、巨蟒共用）
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
  for (const levelId of ['level1', 'treeGarden', 'jungleSerpent', 'beehive', 'depths', 'gaiaSanctum']) {
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
    // 場上的道具：巨蟒的狀態（別張地圖沒有道具）
    const items = mv.type === 'snake' ? view.match.mechState.items : [];
    for (const it of items) assert(!VIEW_ONLY.some(k => k in it), `${levelId}: item ${it.id} carries view fields: ${Object.keys(it)}`);
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
  m.mechState.items.push({ id: 'a99', type: 'snakeBlood', x: 300, y: 500 });
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
  // 打到嘴巴：事件的狀態（closed）先套上，再交給 showDamage（跟 shared/physics/volley.js → GameView.showShotEvent 的順序一樣）
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

await test('射擊重播飛到一半丟錯：畫面上的飛行物跟著清掉（巨蟒撕咬打中人的那一下丟錯，頭不會一直衝在外面）', () => {
  const { m, io } = refereeRun('jungleSerpent');
  const view = newView();
  for (const msg of io.log.splice(0)) view.onMessage(msg);
  drain(view);
  // 伺服器結算好的撕咬（打中人才有事件），客戶端照 aiTurn 播；打中的那個事件的畫面丟錯
  m.mechState.next = { action: 'bite' };
  const boss = JSON.parse(J(m.planAiTurn(m.byId('snake')).boss));   // 走過一趟 JSON，跟網路一樣
  assert(boss.steps[0].shot && boss.steps[0].shot.events.length, 'a real bite that hits');
  const show = view.showShotEvent;
  view.showShotEvent = () => { throw new Error('boom'); };
  const errors = [];
  const err = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let flew = 0;
  try {
    view.onMessage({ t: 'aiTurn', actorId: 'snake', boss });
    for (let f = 0; f < 900 && !errors.length; f++) { view.update(STEP); view.render(); if (view.projectiles.length) flew++; }
  } finally { console.error = err; view.showShotEvent = show; }
  assert(flew > 0 && errors.length === 1, `the bite flew, then the hit threw: flew ${flew}, errors ${errors.length}`);
  assert(view.projectiles.length === 0, 'no frozen projectile left after the error: ' + view.projectiles.map(p => p.weapon.id));
  for (let f = 0; f < 60; f++) { view.update(STEP); view.render(); }
  const head = view.mapCtx.state.head.get('snake');
  assert(!head || Math.abs(head.dx) < 4, 'the head eased back home: ' + J(head));
  return { flewFrames: flew };
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
    // seed：這一段（30 秒）裡古樹三招都出得到的（2026-10-08 敵人每回合都走動、代打的走法改了之後，seed 1 的嘴巴一直被打閉，沒召喚）
    for (const [levelId, seed] of [['treeGarden', 2], ['jungleSerpent', 3]]) {
      // 裁判先把整段跑出來（全員 AI 代打），記下每一批廣播。古樹的指名（2026-11-09）關掉：這一段要看到原本三招的預兆（指名會把時間拉長）
      const markW = CONFIG.TREE_BOSS.marks.weights, snakeW = CONFIG.SNAKE_BOSS.marks.weights;
      const savedMarks = { ...markW }, savedSnake = { ...snakeW };
      Object.assign(markW, { spike: 0, vine: 0 });
      Object.assign(snakeW, { strike: 0, coil: 0 });
      const batches = [];
      try {
        const { io, ref } = refereeRun(levelId, { seed });
        batches.push(io.log.splice(0));
        for (let k = 0; k < 120 && ref.phase !== 'over'; k++) { io.advance(250); batches.push(io.log.splice(0)); }
      } finally { Object.assign(markW, savedMarks); Object.assign(snakeW, savedSnake); }
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

await test('真的 GameView（古樹之庭 / 叢林巨蟒 / 大地祭壇 4 人，指名打開）：插話的 turn 飄「古樹之眼 / 叢林巨蟒 / 大地之母・蓋亞 的追加行動」；指名播完腳下有標記；輪到被指名的人那一招開始蓄力、發動（扣血 / 綁住走不動 / 被大地之手丟走）；整段沒有腳本錯誤；菁英之路不畫標記', () => {
  const all = {};
  for (const [levelId, seed, bossName] of [['treeGarden', 5, '古樹之眼'], ['jungleSerpent', 6, '叢林巨蟒'], ['gaiaSanctum', 7, '大地之母・蓋亞']]) {
  const binds = levelId !== 'gaiaSanctum';   // 蓋亞的兩招都不綁人（大地之手抓到是丟走：throws）
  const { io, ref } = refereeRun(levelId, { seed, n: 4 });
  const view = newView();
  const seen = { interject: false, marks: 0, zones: 0, fired: new Set(), held: 0, thrown: 0, steps: 0 };
  const errors = [];
  const err = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    for (let k = 0; k < 200 && ref.phase !== 'over' && !(seen.interject && seen.fired.size >= 2 && (binds ? seen.held : seen.thrown)); k++) {
      io.advance(250);
      for (const msg of io.log.splice(0)) view.onMessage(JSON.parse(J(msg)));
      for (let f = 0; f < 15; f++) {
        view.update(STEP);
        view.render();
        seen.steps++;
        if (view.banner && view.banner.text === `${bossName} 的追加行動`) seen.interject = true;
        const S = view.match.mechState;
        seen.marks = Math.max(seen.marks, Object.keys(S.marks).length);
        const zones = view.mapCtx.state.zones;
        if (zones.length) seen.zones++;
        for (const z of zones) if (z.fired) seen.fired.add(z.kind + (z.fired.hit ? '+' : '-'));
        if (view.match.players.some(p => p.held)) seen.held++;
        if ((view.mapCtx.state.throws || []).length) seen.thrown++;
      }
    }
  } finally { console.error = err; }
  assert(!errors.length, `${levelId}: script errors ` + errors[0]);
  assert(seen.interject && seen.marks >= 2 && seen.zones > 0 && seen.fired.size > 0, levelId + ' ' + J({ ...seen, fired: [...seen.fired] }));
  // 菁英之路（c.rangeHints false）：標記不畫，招式本身（腳下冒、預警線）照畫
  const m = matchOf(levelId);
  const tv = mapViewFor(m);
  m.mechState.marks = { p1: { treeGarden: 'spike', jungleSerpent: 'strike', gaiaSanctum: 'quake' }[levelId] };
  const { c } = sinkCtx(m, tv.create(m));
  const calls = (hints) => {
    let n = 0;
    const ctx = new Proxy({}, { get: (o, k) => (k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : typeof k === 'string' && /^(fill|stroke|ellipse|arc)$/.test(k) ? () => { n++; } : () => {}), set: () => true });
    c.rangeHints = hints;
    tv.drawScene(ctx, c);
    return n;
  };
  assert(calls(true) > calls(false), levelId + ': marks drawn only with range hints');
  all[levelId] = { ...seen, fired: [...seen.fired] };
  }
  return all;
});

await test('真的 GameView：turn / turnFx 帶的場上道具經地圖機制換成伺服器的版本（叢林巨蟒：複本進 match.mechState.items、預定的下一招不動、沒帶 items 就不動）；一般小關 / 古樹之庭照樣帶 items，機制的狀態不變', () => {
  const a = { id: 'a91', type: 'snakeBlood', x: 700, y: 480 }, b = { id: 'a92', type: 'snakeBlood', x: 740, y: 480 };
  const out = {};
  for (const levelId of ['jungleSerpent', 'level1', 'treeGarden']) {
    const { io } = refereeRun(levelId);
    const view = newView();
    for (const msg of io.log.splice(0)) view.onMessage(msg);
    drain(view);
    const S = view.match.mechState, before = J(S), next = S && S.next;
    const ents = () => view.match.entities.map(e => e.toState());
    view.onMessage({ t: 'turn', actorId: 'p2', round: 2, ai: true, entities: ents(), items: [a] });
    drain(view);
    const afterTurn = S && S.items;
    view.onMessage({ t: 'turnFx', actorId: 'p2', round: 2, fx: [], entities: ents(), items: [a, b] });
    drain(view);
    const afterFx = S && S.items;
    view.onMessage({ t: 'turn', actorId: 'p1', round: 3, ai: true, entities: ents() });   // 沒帶 items
    drain(view);
    assert(view.match.mechState === S, `${levelId}: the state object is kept`);
    if (levelId === 'jungleSerpent') {
      assert(J(afterTurn) === J([a]) && afterTurn[0] !== a, 'turn: items copied in: ' + J(afterTurn));
      assert(J(afterFx) === J([a, b]) && afterFx[0] !== a && afterFx[1] !== b, 'turnFx: items copied in: ' + J(afterFx));
      assert(S.items === afterFx, 'no items field: left alone');
      assert(next && S.next === next, 'the planned move is untouched');
    } else {
      assert(J(S) === before && !(S && 'items' in S), `${levelId}: { items } changes nothing: ${J(S)}`);
    }
    out[levelId] = S ? Object.keys(S).join(',') : null;
  }
  return out;
});

await test('背景音樂（GameView.musicTrack）：地圖畫面指定的曲子（洞穴地圖 = cave，狂熱換洞穴的狂熱版，地心探險沿用；Boss 關各自的曲子，狂熱也不換）、沒指定的小關放山谷曲 / 狂熱版', () => {
  const out = {};
  const cases = [
    ['level1', 'normal', 'fever'], ['cave', 'cave', 'caveFever'], ['depths', 'cave', 'caveFever'],
    ['treeGarden', 'tree', 'tree'], ['jungleSerpent', 'snake', 'snake'], ['scorpionDen', 'scorpion', 'scorpion'], ['gaiaSanctum', 'tree', 'tree'],
  ];
  for (const [levelId, calmWant, hotWant] of cases) {
    const players = mkPlayers(1);
    const m = new Match({ levelId, players, seed: 3, stage: LEVELS[levelId].pool === 'boss' ? 5 : 1 });
    const io = fakeIo();
    new Referee({ match: m, humans: players, io }).start();
    const view = new GameView(fakeCanvas());
    view.music = { play() {}, setRate() {} };
    view.myId = 'p1';
    view.transport = { send() {} };
    for (const msg of io.log.splice(0)) view.onMessage(msg);
    const calm = view.musicTrack();
    view.match.round = 60;   // 小關早就狂熱了；Boss 關沒有狂熱
    const hot = view.musicTrack();
    assert(calm === calmWant && hot === hotWant, `${levelId}: ${calm} → ${hot} (want ${calmWant} → ${hotWant})`);
    out[levelId] = `${calm}→${hot}`;
  }
  return out;
});

// ---- 右上的名單框（2026-10-14 的修正：大樹守衛 / 獨眼巨人的「下一招」那一行超出框、被畫面右邊切掉）----
// 估字寬的假 ctx：中文、全形、符號（U+2000 以上）一個字 = 字級，其他 0.6 倍字級（比真的字型寬一點，估出來放得下就一定放得下）。
// fillText 記下畫了什麼、在哪裡、當下的字型
const fontPx = (font) => +(/(\d+(?:\.\d+)?)px/.exec(font) || [0, 10])[1];
const textW = (s, font) => Array.from(String(s)).reduce((w, ch) => w + (ch.codePointAt(0) >= 0x2000 ? 1 : 0.6) * fontPx(font), 0);
function measuringCanvas(drawn) {
  const t = {
    font: '10px sans-serif',
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
    measureText: (s) => ({ width: textW(s, t.font) }),
    fillText: (s, x, y) => drawn.push({ s: String(s), x, y, font: t.font }),
  };
  const ctx = new Proxy(t, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  return { ...fakeCanvas(), getContext: () => ctx };
}
const ROSTER_LINE = 228;   // 名單框底下那幾行最多多寬（render.js：從 W-250 寫到跟血條的右端 W-22 對齊）

await test('右上名單：地圖畫面給的幾行（血量、下一招…）用平常的字（粗體 13 px）就放得進名單框——大樹守衛、獨眼巨人的血量與下一招分兩行（每一招、四位數的血量、預設的名字「玩家123」）', () => {
  const out = {};
  const players = [1, 2, 3, 4].map(i => ({ id: `p${i}`, name: `玩家${612 + i}` }));
  const byType = new Map();
  for (const [id, L] of Object.entries(LEVELS)) if (!byType.has((L.mechanic && L.mechanic.type) || 'plain')) byType.set((L.mechanic && L.mechanic.type) || 'plain', id);
  for (const [type, levelId] of byType) {
    const L = LEVELS[levelId];
    const m = new Match({ levelId, players, seed: 3, stage: L.pool === 'boss' ? 5 : L.pool === 'elite' ? 3 : 1 });
    for (const e of m.enemies) { e.hp = e.maxHp = 9999; }
    const mv = mapViewFor(m);
    // 每一種預定的下一招（大樹守衛：衝鋒（帶名字）/ 舉盾（帶減傷）/ 躍擊；獨眼巨人：巨石投擲（全員）/ 猛捶 / 一般招式 + 超巨石（再一行：封哪個平台）/ 震盪獅吼）
    const plans = type === 'guardian' ? [{ action: 'charge', targetId: 'p4' }, { action: 'shield', facing: -1 }, { action: 'leap', x: 300, y: 578, targetId: 'p2' }]
      : type === 'cyclops' ? [{ action: 'throw' }, { action: 'pound', ledge: 1 }, { action: 'throw', seal: 0 }, { action: 'pound', ledge: 2, seal: 1 }, { action: 'roar' }] : [null];
    let widest = 0;
    for (const plan of plans) {
      if (plan) m.mechState.next = plan;
      const { c } = fakeCtx(m, {});
      const lines = mv.hud(c, ['敵人剩餘 12 / 12', '#fca5a5']);
      for (const [s] of lines) {
        const w = textW(s, 'bold 13px');
        assert(w <= ROSTER_LINE, `${levelId} ${plan ? plan.action : ''}: "${s}" is ${w.toFixed(1)} px wide (box ${ROSTER_LINE})`);
        widest = Math.max(widest, w);
      }
      if (type === 'guardian' || type === 'cyclops') {
        const name = type === 'guardian' ? '大樹守衛' : '獨眼巨人';
        const extra = plan && Number.isInteger(plan.seal) ? 1 : 0;   // 投擲之後還要丟超巨石：再一行
        assert(lines.length === 3 + extra && lines[1][0] === `${name} 9999 / 9999` && lines[2][0].startsWith('下一招：') && lines[1][1] === lines[2][1], `${levelId}: hp and next on two lines ` + J(lines));
        if (extra) assert(lines[3][0].startsWith('＋超巨石：封住') && lines[3][1] === lines[1][1], `${levelId}: seal line ` + J(lines));
      }
    }
    out[levelId] = Math.round(widest);
  }
  assert(byType.has('guardian') && byType.has('cyclops') && byType.size >= 8, 'every kind of map: ' + [...byType.keys()]);
  return out;
});

await test('右上名單：太長的名字 / 太長的一行，render 縮小字（最小 10 px）、還放不下就截掉補「…」——不超出名單框、名字不蓋到血條', () => {
  const W = CONFIG.WORLD_W;
  // 名字最多 12 個字（大廳、伺服器都截到 12）
  const players = [
    { id: 'p1', name: '一二三四五六七八九十甲乙' }, { id: 'p2', name: 'WWWWWWWWWWWW' }, { id: 'p3', name: '超級無敵霹靂長的名字喔啦' }, { id: 'p4', name: '玩家616' },
  ];
  const out = {};
  for (const levelId of ['forestGuard', 'depths', 'level1']) {
    const m = new Match({ levelId, players, seed: 3, stage: LEVELS[levelId].pool === 'elite' ? 3 : 1 });
    if (levelId === 'forestGuard') m.mechState.next = { action: 'charge', targetId: 'p3' };   // 「下一招：衝鋒 → 很長的名字」
    const io = fakeIo();
    new Referee({ match: m, humans: players, io, stageInfo: { stage: 3, stageCount: 10, isBoss: false, type: 'normal', levelId, levelName: LEVELS[levelId].name, cards: { p1: ['a', 'b', 'c'], p3: Array(12).fill('a') } } }).start();
    const drawn = [];
    const view = new GameView(measuringCanvas(drawn));
    view.music = { play() {}, setRate() {} };
    view.myId = 'p1';
    view.transport = { send() {} };
    for (const msg of io.log.splice(0)) view.onMessage(msg);
    drawn.length = 0;
    view.render();
    const names = drawn.filter(d => d.x === W - 232);
    const lines = drawn.filter(d => d.x === W - 250 && d.s !== '隊伍');
    assert(names.length === players.length && lines.length >= 1, `${levelId}: roster drawn: ${names.length} names / ${lines.length} lines`);
    for (const d of names) assert(d.x + textW(d.s, d.font) <= W - 92 && fontPx(d.font) >= 10, `${levelId}: name "${d.s}" at ${d.font} runs into the hp bar`);
    for (const d of lines) assert(d.x + textW(d.s, d.font) <= W - 22 && fontPx(d.font) >= 10, `${levelId}: line "${d.s}" at ${d.font} runs out of the box`);
    assert(names.some(d => d.s.endsWith('…')) && names.some(d => fontPx(d.font) < 13), `${levelId}: long names were shrunk / cut: ` + J(names.map(d => [d.s, d.font])));
    if (levelId === 'forestGuard') {
      const next = lines.find(d => d.s.startsWith('下一招：衝鋒 → '));
      assert(next && fontPx(next.font) < 13, 'the long charge line was fitted: ' + J(next));
    }
    out[levelId] = names.map(d => d.s);
  }
  return out;
});

// ---- 血條旁的狀態標記（2026-10-14 的修正：出生在最右邊的大樹守衛、獨眼巨人，燃燒 / 中毒 / 流血的層數畫到畫面外面被切掉）----
await test('血條旁的燃燒 / 中毒 / 流血標記不超出畫面：大樹守衛、獨眼巨人站在最右邊的出生點、玩家走到最右邊（有連結標記）時，整排改放到血條左邊（順序不變、不蓋到血條和連結標記）；平常照樣排在血條右邊', () => {
  const W = CONFIG.WORLD_W;
  const STACKS = { burn: 7, poison: 23, bleed: 150 };   // 三種都有、最後一個是三位數（整排最寬）
  const kindOf = Object.fromEntries(Object.entries(STACKS).map(([k, v]) => [String(v), k]));
  const out = {};
  for (const [levelId, id, at] of [['forestGuard', 'guardian', null], ['depths', 'cyclops', null], ['level1', 'p1', W - 12], ['level1', 'p1', 500]]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId, players, seed: 3, stage: LEVELS[levelId].pool === 'elite' ? 3 : 1 });
    const io = fakeIo();
    new Referee({ match: m, humans: players, io }).start();
    const drawn = [];
    const view = new GameView(measuringCanvas(drawn));
    view.music = { play() {}, setRate() {} };
    view.myId = 'p2';
    view.transport = { send() {} };
    for (const msg of io.log.splice(0)) view.onMessage(msg);
    const e = view.match.byId(id);
    if (at !== null) e.x = at;
    const linked = e.isPlayer;
    if (linked) e.links = ['p2'];   // 攜手之伴的連結標記畫在血條左邊
    Object.assign(e, STACKS);
    drawn.length = 0;
    view.render();
    const bw = (view.mapView.hpBar(view.mapCtx, e) || {}).w || (e.boss ? 90 : 46);
    const ty = e.y - e.h - 16 + 8;   // 層數的字寫在血條的高度（render.js：by + 3 再往下 5）
    const nums = drawn.filter(d => Math.abs(d.y - ty) < 0.01 && kindOf[d.s]).sort((a, b) => a.x - b.x);
    const tag = `${levelId} ${id} at ${Math.round(e.x)}`;
    assert(nums.map(d => kindOf[d.s]).join() === 'burn,poison,bleed', `${tag}: marks drawn in order: ` + J(nums));
    // 圖示在層數左邊 6 px 的地方、左右各約 7 px 寬；層數照估的字寬
    const spans = nums.map(d => [d.x - 13, d.x + textW(d.s, d.font)]);
    for (const [l, r] of spans) assert(l >= 0 && r <= W, `${tag}: a mark runs off the canvas: ${J(spans)}`);
    const right = spans.every(([l]) => l >= e.x + bw / 2), left = spans.every(([, r]) => r <= e.x - bw / 2 - (linked ? 18 : 0));
    assert(right || left, `${tag}: marks overlap the hp bar (${e.x - bw / 2} ~ ${e.x + bw / 2}) or the link mark: ${J(spans)}`);
    if (at === 500) assert(right && nums[0].x === e.x + bw / 2 + 13, `${tag}: in the middle the row stays right of the bar as before`);
    else assert(left, `${tag}: at the right edge the row moves left of the bar`);
    out[tag] = `${right ? 'right' : 'left'} ${spans.map(([l, r]) => `${Math.round(l)}~${Math.round(r)}`).join(' ')}`;
  }
  return out;
});

// ---- 大地之母・蓋亞（主題王，2026-11-04）----
// 播一段腳本（generator）：{ frames } 照步數、{ until, max } 等到成立；每一步 update、時間往前，每 6 步畫一次（畫不出錯）
function runGaiaScript(v, c, gen, draw) {
  let n = 0;
  const step = () => { v.update(c, STEP); c.time += STEP; if (++n % 6 === 0) draw(); };
  for (let r = gen.next(); !r.done; r = gen.next()) {
    const y = r.value || {};
    if (y.until) { for (let k = 0; k < (y.max ?? 600) && !y.until(); k++) step(); } else for (let k = 0; k < (y.frames || 1); k++) step();
  }
  return n;
}
const gaiaPick = (m) => J({ ...m.mechState, def: undefined });

await test('大地之母・蓋亞：手的姿勢照預定的下一招（捏碎 = 兩手平舉到中間、天罰 = 那一邊的手舉高、同罰 = 目標那一邊的手握拳停在他頭上（跟著他走）、淨化 = 兩手捧在下巴底下）；一般難度畫警示帶（範圍 = zoneOf）/ 同罰的集合圈（半徑 stackRadius、寫圈裡幾個人），菁英之路（rangeHints false）只有手的姿勢（同罰的拳頭照樣畫）；畫圖不改狀態', async () => {
  const { gaiaState, gaiaOf, zoneOf, stackSharers } = await import('../shared/maps/gaia.js');
  const m = matchOf('gaiaSanctum', 4);
  const v = mapViewFor(m);
  assert(v.type === 'gaia' && v.musicTrack({}) === 'tree' && v.shaded({}) === true, 'gaia view');
  const S = gaiaState(m);
  const out = {};
  for (const plan of [{ action: 'crush' }, { action: 'smite', side: -1 }, { action: 'smite', side: 1 }, { action: 'stack', targetId: 'p3' }, { action: 'cleanse' }]) {
    for (const hints of [true, false]) {
      S.next = { ...plan };
      const { c } = sinkCtx(m, v.create(m));
      c.rangeHints = hints;
      for (let k = 0; k < 120; k++) v.update(c, STEP);
      const { L, R } = c.state.hands;
      const tag = `${plan.action}${plan.side ? plan.side : ''} hints=${hints}`;
      if (plan.action === 'crush') assert(L.x > 200 && R.x < CONFIG.WORLD_W - 200 && Math.abs(L.y - R.y) < 1 && L.curl > 0.4, `${tag}: both hands level at the centre ` + J({ L, R }));
      if (plan.action === 'smite') {
        const [up, down] = plan.side < 0 ? [L, R] : [R, L];
        assert(up.y < down.y - 30 && up.rot > 1.4, `${tag}: that side's palm is raised flat ` + J({ L, R }));
      }
      if (plan.action === 'cleanse') assert(L.x > 380 && R.x < CONFIG.WORLD_W - 380 && L.y > 360, `${tag}: hands cupped under the chin ` + J({ L, R }));
      let fist = null;
      if (plan.action === 'stack') {
        const t = m.byId('p3');
        const [mine, other] = t.cx < CONFIG.WORLD_W / 2 ? [L, R] : [R, L];
        assert(mine.fist && !other.fist && Math.abs(mine.x - t.cx) < 2 && mine.y < t.y - t.h - 30 && mine.y > t.y - t.h - 50, `${tag}: a fist over the target's head ` + J({ mine, t: [t.cx, t.y - t.h] }));
        fist = mine;
      }
      const before = J([...c.state.orbs, c.state.fog, c.state.dome, L, R]) + gaiaPick(m);
      const r = recordingCtx();
      v.drawScene(r.ctx, c);
      v.drawShade(r.ctx, c);
      const g = gaiaOf(m);
      assert(v.drawEntity(r.ctx, c, g, false) === 'body' && v.drawEntityFirst(c, g) && v.hpBar(c, g).w > 90, 'face drawn as the body, behind everyone');
      assert(J([...c.state.orbs, c.state.fog, c.state.dome, L, R]) + gaiaPick(m) === before, `${tag}: drawing does not change the state`);
      const z = zoneOf(S.def, plan);
      const band = r.calls.some(x => x.fn === 'fillRect' && z && x.args[0] === z.x0 && Math.abs(x.args[2] - (z.x1 - z.x0)) < 1e-9);
      const ring = r.calls.some(x => x.fn === 'setLineDash' && J(x.args[0]) === '[10,6]');
      const label = r.calls.find(x => x.fn === 'fillText' && /^集合分擔/.test(x.args[0]));
      assert(band === (hints && !!z), `${tag}: warning band ${band}`);
      assert(ring === (hints && plan.action === 'stack') && !!label === ring, `${tag}: stack gather ring ${ring}`);
      if (label) assert(label.args[0] === `集合分擔（${stackSharers(m, m.byId('p3')).length} 人）`, 'ring label counts who is inside ' + label.args[0]);
      // 拳頭畫在角色之後（drawShade）：四個指節（橢圓）——菁英之路也畫
      const knuckles = r.calls.filter(x => x.fn === 'ellipse' && x.args[2] === 11 && x.args[3] === 12).length;
      assert((knuckles >= 4) === !!fist, `${tag}: fist drawn ${knuckles}`);
      const hud = v.hud(c, ['敵人剩餘 1 / 1', '#fca5a5']).map(l => l[0]);
      const side = plan.side < 0 ? '左側' : '右側';
      assert(hud[1].startsWith('蓋亞 ') && hud[2].startsWith('下一招：') && (plan.action !== 'smite' || hud[2].includes(side) === hints), `${tag}: hud ` + J(hud));
      assert(plan.action !== 'stack' || hud[2].includes('巨拳・同罰 → P3') === hints, `${tag}: stack hud names the target ` + J(hud));
      assert(plan.action !== 'cleanse' || !hints || hud[2] === '下一招：自然・淨化', `${tag}: cleanse has no target ` + J(hud));
      // 菁英之路（U：只看得到手的姿勢）：HUD 不寫是哪一招
      assert(hints || hud[2] === '下一招：看她的手勢', `${tag}: elite hud names no move ` + J(hud));
      out[tag] = { band, ring, fist: !!fist };
    }
  }
  {
    S.next = { action: 'stack', targetId: 'p3' };
    const { c } = sinkCtx(m, v.create(m));
    for (let k = 0; k < 60; k++) v.update(c, STEP);
    const t = m.byId('p3');
    const key = () => (t.cx < CONFIG.WORLD_W / 2 ? 'L' : 'R');
    const x0 = t.x;
    for (let k = 0; k < 60; k++) { t.x = x0 + k; v.update(c, STEP); }
    const h = c.state.hands[key()];
    assert(h.fist && Math.abs(h.x - t.cx) < 6, 'the fist follows the target ' + J([h.x, t.cx]));
    t.x = x0;
    // 11-05：目標在玩家回合裡倒下了 → 拳頭、集合圈不畫，HUD 也不再寫他的名字（她的回合換人，見 moveStep）
    t.alive = false;
    for (let k = 0; k < 60; k++) v.update(c, STEP);
    const hud = v.hud(c, ['敵人剩餘 1 / 1', '#fca5a5']).map(l => l[0]);
    const r = recordingCtx();
    v.drawScene(r.ctx, c);
    v.drawShade(r.ctx, c);
    assert(!c.state.hands.L.fist && !c.state.hands.R.fist && !r.calls.some(x => x.fn === 'setLineDash' && J(x.args[0]) === '[10,6]'), 'no fist / ring for the fallen target');
    assert(hud[2] === '下一招：巨拳・同罰（目標倒下，換人）' && !hud[2].includes('P3'), 'hud drops the fallen target ' + J(hud));
    t.alive = true;
  }
  const g = gaiaOf(m);
  g.alive = false;
  const { c } = sinkCtx(m, v.create(m));
  const r = recordingCtx();
  assert(v.drawEntityBare(r.ctx, c, g) === true && r.calls.length > 0, 'the fallen face stays on screen');
  return out;
});

await test('大地之母・蓋亞：伺服器的每一種招式（瘴氣 / 暈眩 / 暴走 / 最後之光 / 枯萎 / 誅滅 / 捏碎 / 天罰 / 同罰 / 淨化 / 沉睡）客戶端的腳本都播得完（每幀 update、每幾幀畫一次），橫幅照招式（枯萎照抄使用者的那句），誅滅讓 killed 倒下；播完的狀態跟伺服器一樣', async () => {
  const { gaiaState, gaiaOf, gaiaSnapshot, restoreGaia, slopeY, judgeRound, WITHER_TEXT } = await import('../shared/maps/gaia.js');
  // 指名（2026-11-10）關掉：這一段看原本每一招是不是回合的最後一步（指名的畫面在「指名打開」那一段測）
  const gaiaW = CONFIG.GAIA.marks.weights, savedGaiaW = { ...gaiaW };
  Object.assign(gaiaW, { quake: 0, grab: 0 });
  try {
  const srv = matchOf('gaiaSanctum', 2), cli = matchOf('gaiaSanctum', 2);
  for (const m of [srv, cli]) for (const p of m.players) { p.hp = p.maxHp = 5000; }
  const g = gaiaOf(srv);
  const S = gaiaState(srv);
  const v = mapViewFor(cli);
  const { c, calls } = sinkCtx(cli, v.create(cli));
  const draw = () => { const r = recordingCtx(); v.drawScene(r.ctx, c); v.drawShade(r.ctx, c); for (const e of cli.entities) { if (!v.drawEntityBare(r.ctx, c, e)) v.drawEntity(r.ctx, c, e, false); } v.hud(c, ['x', '#fff']); };
  const seen = new Set();
  const banners = [];
  const turn = (round, setup) => {
    srv.round = round;
    if (setup) setup();
    cli.round = round;
    cli.applyEntities(srv.entities.map(e => e.toState()));
    restoreGaia(cli, gaiaSnapshot(srv));
    const msg = { actorId: 'gaia', boss: JSON.parse(J(srv.mechanic.aiTurn(srv, g))) };
    calls.length = 0;
    runGaiaScript(v, c, v.turnScript(c, msg), draw);
    for (const st of msg.boss.steps) seen.add(st.action);
    banners.push(...calls.filter(([k]) => k === 'banner').map(([, a]) => a[0]));
    assert(c.state.fx === null, `round ${round}: fx cleared`);
    assert(gaiaPick(cli) === gaiaPick(srv), `round ${round}: mechState synced\n${gaiaPick(cli)}\n${gaiaPick(srv)}`);
    return msg.boss.steps;
  };
  const [p1, p2] = srv.players;
  const onSlope = (p, k, x) => { const s = S.def.slopes[k]; Object.assign(p, { x, y: slopeY(s, x), vx: 0, vy: 0 }); };
  let st = turn(1, () => { S.next = { action: 'crush' }; });
  assert(st[0].action === 'fog' && st[1].action === 'crush' && cli.mechState.flowers.length === st[0].flowers.length, 'fog + crush');
  st = turn(2, () => { S.stunned = true; });
  assert(st.length === 1 && st[0].action === 'stunned', 'stunned');
  st = turn(3, () => { onSlope(p2, 1, 150); S.next = { action: 'smite', side: -1 }; });
  assert(st.at(-1).action === 'smite' && st.at(-1).targetIds.includes('p2'), 'smite hits the left side ' + J(st.at(-1).targetIds));
  st = turn(4, () => { g.poison = 3; g.burn = 2; g.hp -= 100; p1.poison = 3; S.next = { action: 'cleanse' }; });
  assert(st.at(-1).action === 'cleanse' && st.at(-1).cleared.length === 2 && st.at(-1).heal > 0, 'cleanse ' + J(st.at(-1)));
  assert(gaiaOf(cli).poison === 0 && gaiaOf(cli).burn === 0 && gaiaOf(cli).hp === g.hp && cli.byId('p1').poison === 3, 'client: she is cleansed and healed, players untouched');
  // 同罰：p2 站到 p1 旁邊一起分擔（同一輪再一次，瘴氣已經放過）
  st = turn(4, () => { Object.assign(p2, { x: p1.x + 30, y: p1.y, vx: 0, vy: 0 }); S.next = { action: 'stack', targetId: 'p1' }; });
  assert(st.length === 1 && st[0].action === 'stack' && J(st[0].targetIds) === '["p1","p2"]', 'stack shared ' + J(st.map(x => x.action)));
  st = turn(5, () => { g.hp = g.hpFloor; S.next = { action: 'smite', side: 1 }; });
  assert(st[0].action === 'rage' && cli.mechState.rage && gaiaOf(cli).hpFloor === 0, 'rage');
  st = turn(S.lightAt, () => { S.next = { action: 'smite', side: 1 }; });
  assert(st[0].action === 'light' && cli.mechState.light && cli.mechState.flowers.length === st[0].flowers.length, 'final light');
  for (const sp of st[0].spots) { const e = cli.byId(sp.id); assert(Math.abs(e.x - sp.x) < 1e-6, `${sp.id} teleported to the altar`); }
  st = turn(S.light.at + 2, () => { S.next = { action: 'smite', side: -1 }; });
  assert(st[0].action === 'wither' && cli.mechState.light.withered && !cli.mechState.flowers.length, 'wither');
  st = turn(judgeRound(S.light.at), () => { S.next = { action: 'smite', side: -1 }; });
  assert(st[0].action === 'judgement' && st[0].killed.length === 2 && cli.players.every(p => !p.alive && p.deathCause === 'judged'), 'judgement kills everyone without a shield');
  st = turn(srv.round + 1);
  assert(st.length === 1 && st[0].action === 'idle', 'idle when nobody is left ' + J(st.map(x => x.action)));
  for (const a of ['fog', 'stunned', 'rage', 'light', 'wither', 'judgement', 'crush', 'smite', 'stack', 'cleanse', 'idle']) assert(seen.has(a), 'played ' + a + ': ' + [...seen]);
  for (const want of ['瘴氣瀰漫！', '大地之母暈眩了！', '大地之母暴走！', '最後之光！', WITHER_TEXT, '誅滅！']) assert(banners.includes(want), `banner ${want}: ` + J(banners));
  assert(banners.some(b => b.startsWith('沒有護盾')), 'judgement result banner ' + J(banners));
  v.abortScript(c);
  return { seen: [...seen].sort(), banners: banners.length };
  } finally { Object.assign(gaiaW, savedGaiaW); }
});

await test('大地之母・蓋亞：撿花（別人的 pickup：花變成光球飛向祭壇、祭壇的光球數照伺服器）；自己先在本地撿（predictMove：花馬上不見、光球只飛一次）；收滿祭壇淨化（瘴氣淡出、大家中毒歸零、血量照 heals，自己的照本地加上回的血）；回合開始的瘴氣 fx 飄字', async () => {
  const { gaiaState, gaiaOf, gaiaSnapshot, restoreGaia, flowerCenter } = await import('../shared/maps/gaia.js');
  const srv = matchOf('gaiaSanctum', 2), cli = matchOf('gaiaSanctum', 2);
  for (const m of [srv, cli]) for (const p of m.players) { p.hp = 50; p.maxHp = 1000; p.poison = 4; }
  srv.round = 1;
  gaiaState(srv).next = { action: 'cleanse' };   // 這一招不碰玩家（血量才照得準）
  srv.mechanic.aiTurn(srv, gaiaOf(srv));   // 第 1 輪：瘴氣、開花
  cli.round = 1;
  cli.applyEntities(srv.entities.map(e => e.toState()));
  restoreGaia(cli, gaiaSnapshot(srv));
  const v = mapViewFor(cli);
  const { c, calls } = sinkCtx(cli, v.create(cli));
  c.myId = 'p1';
  for (let k = 0; k < 240; k++) { v.update(c, STEP); c.time += STEP; }
  assert(c.state.fog > 0.5, 'fog faded in ' + c.state.fog);
  const [f1, f2] = gaiaState(srv).flowers;
  assert(f1 && f2, 'two flowers');
  // 別人（p2）撿到第一朵：伺服器的 pickup
  const walk = (m, id, f) => { const p = m.byId(id), q = flowerCenter(f); const x0 = q.x - 40, y0 = q.y + 10; Object.assign(p, { x: q.x, y: q.y + 10 }); return m.mechanic.moved(m, p, x0, y0, p.x, p.y); };
  const fx1 = walk(srv, 'p2', f1);
  assert(fx1 && J(fx1.flowers) === J([f1.id]) && !fx1.purify, 'server picked one ' + J(fx1));
  const msg1 = { t: 'pickup', ...JSON.parse(J(fx1)), hp: srv.byId('p2').hp, mhp: srv.byId('p2').maxHp, lk: 0 };
  v.onPickup(c, cli.byId('p2'), msg1, false);
  assert(!gaiaState(cli).flowers.some(f => f.id === f1.id) && gaiaState(cli).orbs === 1 && c.state.orbs.length === 1, 'flower → orb, altar 1');
  // 自己（p1）在本地先碰到第二朵
  const me = cli.byId('p1'), q2 = flowerCenter(f2);
  Object.assign(me, { x: q2.x, y: q2.y + 10 });
  assert(v.predictMove(c, me, q2.x - 40, q2.y + 10) === true, 'predicted pickup → send the move now');
  assert(!gaiaState(cli).flowers.some(f => f.id === f2.id) && c.state.orbs.length === 2, 'picked locally, orb flying');
  assert(v.predictMove(c, me, me.x - 1, me.y) === false, 'nothing left to pick');
  const fx2 = walk(srv, 'p1', f2);
  assert(fx2 && fx2.purify && fx2.heals.length === 2, 'server purifies ' + J(fx2));
  const heal = fx2.heals.find(h => h.id === 'p1').heal, other = fx2.heals.find(h => h.id === 'p2');
  // 這一下收滿祭壇：自己先在本地淨化（中毒歸零、回血跟伺服器一樣）——之後在本地掉水照淨化之後的血量算
  assert(c.state.predictedPurify && me.poison === 0 && me.hp === 50 + heal && me.hp === fx2.heals.find(h => h.id === 'p1').hp, `predicted purify: me ${me.hp} (50 + ${heal}), poison ${me.poison}`);
  assert(cli.byId('p2').poison === 4, 'only my own purify is predicted');
  me.hp = 40;   // 本地之後掉過水之類：自己的血量照本地的（已經回過血了，伺服器的 pickup 不再加一次）
  calls.length = 0;
  v.onPickup(c, me, { t: 'pickup', ...JSON.parse(J(fx2)), hp: srv.byId('p1').hp, mhp: 1000, lk: 0 }, true);
  const S = gaiaState(cli);
  assert(c.state.orbs.length === 2, 'the predicted flower does not fly twice');
  assert(!S.fog && S.stunned && !S.flowers.length && cli.players.every(p => p.poison === 0), 'purified');
  assert(me.hp === 40 && !c.state.predictedPurify && cli.byId('p2').hp === other.hp, `heals: me ${me.hp} (40, healed locally already), p2 ${cli.byId('p2').hp} vs ${other.hp}`);
  // 沒預測到的（伺服器的直線判到、自己的路線沒碰到）：自己的血量照本地的加上回的血
  {
    const s2 = matchOf('gaiaSanctum', 2), c2m = matchOf('gaiaSanctum', 2);
    for (const m of [s2, c2m]) for (const p of m.players) { p.hp = 50; p.maxHp = 1000; p.poison = 4; }
    s2.round = 1;
    gaiaState(s2).next = { action: 'cleanse' };
    s2.mechanic.aiTurn(s2, gaiaOf(s2));
    c2m.round = 1;
    c2m.applyEntities(s2.entities.map(e => e.toState()));
    restoreGaia(c2m, gaiaSnapshot(s2));
    const { c: cc } = sinkCtx(c2m, v.create(c2m));
    cc.myId = 'p1';
    const [g1, g2] = gaiaState(s2).flowers;
    walk(s2, 'p1', g1);
    const fx = walk(s2, 'p1', g2);
    const mine = c2m.byId('p1');
    mine.hp = 40;
    v.onPickup(cc, mine, { t: 'pickup', ...JSON.parse(J(fx)), hp: s2.byId('p1').hp, mhp: 1000, lk: 0 }, true);
    const h = fx.heals.find(x => x.id === 'p1').heal;
    assert(fx.purify && mine.hp === 40 + h, `not predicted: me ${mine.hp} (40 + ${h})`);
  }
  assert(calls.some(([k, a]) => k === 'banner' && /祭壇淨化/.test(a[0])), 'purify banner');
  for (let k = 0; k < 240; k++) { v.update(c, STEP); c.time += STEP; }
  assert(c.state.fog < 0.05 && c.state.orbs.length === 0, 'fog faded out, orbs landed');
  // 回合開始的瘴氣
  calls.length = 0;
  v.statusFx(c, me, { type: 'gaiaFog', id: 'p1', stacks: 3, total: 3 });
  v.statusFx(c, me, { type: 'gaiaFog', id: 'p1', immune: true });
  const floats = calls.filter(([k]) => k === 'float').map(([, a]) => a[1]);
  assert(me.poison === 3 && floats.includes('瘴氣 中毒 +3') && floats.includes('瘴氣：免疫'), 'fog fx ' + J(floats));
  return { heal, floats };
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
