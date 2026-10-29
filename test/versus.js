// node test/versus.js
// 勝者為王（3v3 對戰）：對戰地圖、Match 的兩隊（出生點、勝負、誤傷）、關卡規則的狂熱、Versus 的流程（電腦玩家、每一輪打完的選牌、
// 牌當場套到角色身上、客戶端照 roundPicks / 重連的 carry 建出一樣的角色、同一隊才算的牌）、結束與結算、伺服器的房間（模式、換隊、電腦玩家）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Versus } from '../shared/game/versus.js';
import { stageRules } from '../shared/game/stage-rules.js';
import { validateCards } from '../shared/cards/cards.js';
import { planShot } from '../shared/ai/ai.js';
import { Rng } from '../shared/core/rng.js';
import { RoomManager } from '../server/rooms.js';
import { replayChecked } from './replay-check.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
async function test(name, fn) {
  try {
    const info = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${info ? '  ' + JSON.stringify(info) : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(err.stack || err).split('\n').slice(0, 5).join('\n      ')}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const J = JSON.stringify;
const V = CONFIG.VERSUS;
const CARDS = validateCards(JSON.parse(fs.readFileSync(path.join(ROOT, 'shared/cards/cards.json'), 'utf8'))).cards;
const card = (id) => { const c = CARDS.find(x => x.id === id); assert(c, 'no card ' + id); return c; };

// 假的 io：虛擬時鐘；廣播與紀錄都經過 JSON 一趟（跟真的網路一樣，也證明送得出去）
class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.records = []; this.seq = 0; this.endedWith = undefined; }
  broadcast(msg, exceptId) { this.log.push({ ...JSON.parse(J(msg)), _except: exceptId }); }
  record(ev, data) { this.records.push({ ev, ...JSON.parse(J(data)) }); }
  schedule(fn, ms) { const h = { at: this.t + ms, fn, id: this.seq++ }; this.timers.push(h); return h; }
  cancel(h) { this.timers = this.timers.filter(x => x !== h); }
  now() { return this.t; }
  ended(result) { this.endedWith = result; }
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
  take(t) { return this.log.filter(m => m.t === t); }
  evs(ev) { return this.records.filter(r => r.ev === ev); }
}
const until = (io, pred, max = 600_000) => { const s = io.t; while (!pred() && io.t - s < max) io.advance(100); return pred(); };

// 一個真人（藍隊 h1）+ 五個電腦玩家；humans = 另外幾個真人 id（照順序放在藍、紅隊）
function lineup({ humans = ['h1'] } = {}) {
  const out = [];
  let n = 0;
  for (const team of V.teams) {
    for (let i = 0; i < V.teamSize; i++) {
      const h = humans[out.length];
      out.push(h ? { id: h, name: h.toUpperCase(), team } : { id: `bot${++n}`, name: `${V.botName} ${n}`, team, bot: true, connected: false });
    }
  }
  return out;
}
// 開一場對戰。freeze = 電腦玩家不走也不開火（快轉輪數用）；cards = 牌庫（預設整副）
function game({ players = lineup(), seed = 7, cards = CARDS, freeze = false } = {}) {
  const io = new FakeIo();
  const v = new Versus({ players, seed, io, cards });
  v.start();
  if (freeze) v.match.planAiTurn = () => ({ walk: null, plan: null });
  return { io, v };
}
// 推進到某位真人的回合（他的 turn 訊息出現）
const toTurn = (io, v, id) => until(io, () => v.referee.phase === 'turn' && v.referee.currentId === id);
// 推進到選牌（第一輪打完）：真人的回合都等到超時
function toPick(io, v) {
  return until(io, () => v.phase === 'pick');
}
// 客戶端照 start（或重連 state）建的 Match：跟 GameView.setup 一樣
const clientMatch = (msg) => {
  const m = new Match({ levelId: msg.levelId, players: msg.players, seed: msg.seed, carry: msg.carry || {}, stage: msg.stage || 1 });
  m.applySnapshot(msg.snapshot);
  return m;
};
// 比對兩邊角色的戰鬥數值（不同步、只能從 carry 建出來的那些也要一樣）
const FIELDS = ['team', 'color', 'facing', 'maxHp', 'hp', 'maxStamina', 'moveSpeed', 'jumpSpeed', 'hw', 'h', 'weapon', 'alive'];
function sameEntities(a, b, label) {
  for (const e of a.entities) {
    const f = b.byId(e.id);
    assert(f, `${label}: client has no ${e.id}`);
    for (const k of FIELDS) assert(J(e[k]) === J(f[k]), `${label}: ${e.id}.${k} server ${J(e[k])} client ${J(f[k])}`);
    assert(J(e.mods) === J(f.mods) && J(e.weapons) === J(f.weapons) && J(e.links) === J(f.links), `${label}: ${e.id} mods / weapons / links differ`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------

await test('對戰地圖（pool versus）：冒險不會抽到；左右兩隊各 teamSize 個出生點、沒有敵人、沒有地圖機制；六個人開場都站在水面上、不會掉水', () => {
  const ids = levelsInPool('versus');
  assert(ids.length >= 1, 'no versus maps');
  for (const pool of ['normal', 'elite', 'boss']) assert(!levelsInPool(pool).some(id => ids.includes(id)), 'versus map in pool ' + pool);
  const out = {};
  for (const id of ids) {
    const L = LEVELS[id];
    assert(!L.mechanic && Array.isArray(L.enemySpawns) && !L.enemySpawns.length, id + ': has enemies / mechanic');
    assert(L.teamSpawns && L.teamSpawns.length === V.teams.length && L.teamSpawns.every(s => s.length >= V.teamSize), id + ': teamSpawns');
    // 左右對稱：右隊的出生點是左隊的鏡像
    L.teamSpawns[0].forEach((s, i) => assert(Math.abs(L.teamSpawns[1][i].x - (CONFIG.WORLD_W - s.x)) < 1 && L.teamSpawns[1][i].y === s.y, id + ': spawns not mirrored'));
    const m = new Match({ levelId: id, players: lineup({ humans: ['a', 'b', 'c', 'd', 'e', 'f'] }), seed: 1 });
    assert(m.versus && m.players.length === 6 && !m.enemies.length, id + ': versus match');
    for (const e of m.entities) {
      assert(e.alive && e.onGround && e.y < CONFIG.WATER_LEVEL - 20 && e.waterFalls === 0, `${id}: ${e.id} spawns badly at ${e.x},${e.y}`);
      assert(e.team === 'blue' ? e.x < 512 : e.x > 512, `${id}: ${e.id} on the wrong side`);
    }
    out[id] = m.entities.map(e => Math.round(e.y)).join('/');
  }
  return out;
});

await test('Match（對戰）：兩隊照 players 的順序與隊伍建（藍隊左、面向右；紅隊右、面向左；顏色照給的），都是玩家角色；勝負 = 只剩一隊活著的那一隊，一起倒下 = 平手', () => {
  const players = [
    { id: 'a', name: 'A', team: 'blue', color: '#111111' }, { id: 'x', name: 'X', team: 'red', color: '#222222' },
    { id: 'b', name: 'B', team: 'blue', color: '#333333' }, { id: 'y', name: 'Y', team: 'red', color: '#444444' },
  ];
  const m = new Match({ levelId: 'arena', players, seed: 2 });
  assert(m.entities.map(e => e.id).join() === 'a,x,b,y', 'order = turn order');
  assert(m.entities.every(e => e.isPlayer && e.controller === 'human'), 'all player characters');
  assert(m.byId('a').team === 'blue' && m.byId('a').facing === 1 && m.byId('x').team === 'red' && m.byId('x').facing === -1, 'teams / facing');
  assert(m.byId('a').x === LEVELS.arena.teamSpawns[0][0].x && m.byId('b').x === LEVELS.arena.teamSpawns[0][1].x && m.byId('y').x === LEVELS.arena.teamSpawns[1][1].x, 'spawn per team slot');
  assert(m.byId('y').color === '#444444', 'color from players');
  assert(m.result() === null, 'not over at start');
  m.byId('x').die('hit');
  assert(m.result() === null, 'one red left');
  m.byId('y').die('hit');
  assert(m.result() === 'blue', 'blue wins: ' + m.result());
  const d = new Match({ levelId: 'arena', players, seed: 2 });
  for (const e of d.entities) e.die('hit');
  assert(d.result() === 'draw', 'draw');
  // 冒險照舊：玩家都是 players 那一隊，打倒敵人 = win
  const pve = new Match({ levelId: 'level1', players: [{ id: 'p1', name: 'P' }], seed: 2 });
  assert(!pve.versus && pve.players[0].team === 'players' && pve.enemies.length === 2 && pve.result() === null, 'pve unchanged');
  for (const e of pve.enemies) e.die('hit');
  assert(pve.result() === 'win', 'pve win');
});

await test('誤傷：同一隊（含自己）×FRIENDLY_FIRE、另一隊全額；對戰的玩家不吃敵人傷害倍率；結算統計：打對手算造成傷害、打隊友算誤傷隊友、打自己都不算', () => {
  const players = [{ id: 'a', name: 'A', team: 'blue' }, { id: 'x', name: 'X', team: 'red' }, { id: 'b', name: 'B', team: 'blue' }];
  const m = new Match({ levelId: 'twinPeaks', players, seed: 4 });
  const a = m.byId('a'), b = m.byId('b'), x = m.byId('x');
  for (const e of [a, b, x]) { e.hp = e.maxHp = 1000; e.x = 500; e.y = 470; }
  const w = CONFIG.WEAPONS.cannon;
  const dmg = m.applyExplosion(500, 460, w, a, null);
  const of = (id) => dmg.find(d => d.id === id);
  assert(of('x') && !of('x').friendly && of('b') && of('b').friendly, 'friendly flags: ' + J(dmg));
  assert(Math.abs(of('b').dmg - of('x').dmg * CONFIG.FRIENDLY_FIRE) <= 1, `friendly ${of('b').dmg} vs enemy ${of('x').dmg}`);
  assert(m.damageMult(a, w) === 1 && m.damageMult(x, w) === 1, 'no enemy damage multiplier for versus players');
  assert(of('a') && of('a').dmg > 0, 'hit himself too: ' + J(dmg));
  assert(a.dealt === of('x').dmg && a.friendlyDealt === of('b').dmg, `stats: dealt ${a.dealt}, friendly ${a.friendlyDealt}`);
  return { enemy: of('x').dmg, friendly: of('b').dmg };
});

await test('關卡規則：對戰（pool versus）的狂熱不看人數，每 VERSUS.feverEvery（10）輪疊一層：第 11 輪起 1 層、第 21 輪起 2 層', () => {
  for (const players of [2, 4, 6]) {
    const r = stageRules({ stage: 1, players, pool: 'versus' });
    assert(r.feverEvery === V.feverEvery && r.feverFirst === V.feverEvery + 1, `${players}: ${r.feverEvery}/${r.feverFirst}`);
    assert(r.feverAt(10) === 0 && r.feverAt(11) === 1 && r.feverAt(20) === 1 && r.feverAt(21) === 2, `${players}: feverAt`);
  }
});

await test('開場：start 帶 mode versus、每個人的隊伍與電腦玩家標記（順序 = 兩隊輪流）、血量 300；記 versus.start', () => {
  const { io, v } = game();
  const start = io.take('start')[0];
  assert(start && start.stageInfo.mode === 'versus' && start.stageInfo.levelName, 'stageInfo: ' + J(start && start.stageInfo));
  const teams = start.players.map(p => p.team);
  assert(teams.every((t, i) => i === 0 || t !== teams[i - 1]), 'teams alternate: ' + teams);
  assert(start.players.filter(p => p.bot).length === 5 && !start.players.find(p => p.id === 'h1').bot, 'bot flags');
  assert(Object.values(start.carry).every(c => c.hp === V.hp && c.maxHp === V.hp), 'carry hp 300');
  assert(v.match.players.every(e => e.hp === V.hp && e.maxHp === V.hp), 'entities hp 300');
  const rec = io.evs('versus.start')[0];
  assert(rec && rec.players.length === 6 && rec.players.every(p => p.team && p.hp === V.hp), 'versus.start: ' + J(rec));
  // 每一隊的顏色照 teamColors 的順序
  for (const t of V.teams) {
    const mine = v.match.players.filter(e => e.team === t);
    mine.forEach((e, k) => assert(e.color === V.teamColors[t][k], `${e.id} color`));
  }
  v.stop();
  return { order: start.players.map(p => p.id).join() };
});

await test('回合：真人的回合等他操作（ai false、30 秒）、電腦玩家由 AI 打（ai true，紀錄 bot、不是代打）；真人斷線才是代打', () => {
  const { io, v } = game({ freeze: true });
  assert(toTurn(io, v, 'h1'), 'h1 turn');
  const t = io.take('turn').find(m => m.actorId === 'h1');
  assert(t.ai === false && t.turnTime === CONFIG.TURN_TIME, 'human turn: ' + J({ ai: t.ai, turnTime: t.turnTime }));
  assert(io.take('turn').filter(m => m.actorId.startsWith('bot')).every(m => m.ai === true), 'bot turns are ai');
  const botStarts = io.evs('turn.start').filter(r => r.actor.startsWith('bot'));
  assert(botStarts.every(r => r.bot === true && !r.takeover), 'bot records: ' + J(botStarts.slice(0, 2)));
  v.setConnected('h1', false);
  assert(io.evs('turn.takeover').some(r => r.pid === 'h1'), 'takeover when the human drops');
  assert(io.take('playerStatus').some(m => m.id === 'h1' && m.connected === false), 'playerStatus');
  // 電腦玩家沒有連線狀態：setConnected 不理它
  const n = io.log.length;
  v.setConnected('bot1', true);
  assert(io.log.length === n, 'bots ignore setConnected');
  v.stop();
});

await test('每一輪打完選牌：裁判停在 break、每個活著的人都有牌（電腦玩家馬上選好）；選牌中的其他操作記 phase:pick；真人選完就套用、隔 resumeDelay 秒開始下一輪', () => {
  const { io, v } = game({ freeze: true });
  assert(toPick(io, v), 'pick after round 1');
  assert(v.referee.phase === 'break' && v.pickRound === 1, 'referee paused: ' + v.referee.phase);
  const rp = io.take('roundPick')[0];
  assert(rp && rp.round === 1 && Object.keys(rp.offers).length === 6 && rp.offers.h1.length === V.offers, 'offers: ' + J(rp && Object.keys(rp.offers)));
  assert(rp.picked.length === 5 && !rp.picked.includes('h1') && rp.pickTime === V.pickTime, 'bots picked up front: ' + J(rp.picked));
  assert(io.evs('pick').filter(r => r.bot).length === 5, 'bot picks logged');
  // 選牌中送別的：記一筆、不處理
  const me = v.match.byId('h1');
  v.handle('h1', { t: 'move', x: me.x + 3, y: me.y, facing: 1, stamina: 1 });
  assert(io.records.at(-1).ev === 'action.ignored' && io.records.at(-1).reason === 'phase:pick', 'move during pick');
  v.handle('h1', { t: 'pick', cardId: 'nope' });
  assert(io.records.at(-1).reason === 'cardNotOffered', 'bad card');
  const pickId = rp.offers.h1.find(c => !c.weapon).id;
  v.handle('h1', { t: 'pick', cardId: pickId });
  const done = io.take('roundPicks')[0];
  assert(done && done.round === 1 && done.summary.length === 6 && done.summary.find(s => s.playerId === 'h1').cardId === pickId, 'roundPicks');
  assert(Object.keys(done.carry).length === 6 && done.cards.h1[0] === pickId, 'carry + cards');
  assert(v.phase === 'battle' && v.referee.phase === 'break', 'waits resumeDelay');
  io.advance(V.resumeDelay * 1000 + 10);
  const t2 = io.take('turn').at(-1);
  assert(t2 && t2.round === 2 && v.referee.phase !== 'break', 'round 2 starts: ' + J(t2 && t2.round));
  assert(io.evs('pick.done')[0].players.length === 6, 'pick.done');
  v.stop();
});

await test('選牌超時 / 斷線：沒選的隨機選；只剩他沒選而他斷線了就馬上結束選牌', () => {
  const a = game({ freeze: true });
  assert(toPick(a.io, a.v), 'pick');
  a.io.advance(V.pickTime * 1000 + 10);
  const done = a.io.take('roundPicks')[0];
  assert(done && a.io.evs('pick.done')[0].players.find(p => p.pid === 'h1').auto === true, 'timeout auto pick');
  a.v.stop();
  const b = game({ freeze: true });
  assert(toPick(b.io, b.v), 'pick');
  b.v.setConnected('h1', false);
  assert(b.io.take('roundPicks').length === 1, 'finishes on disconnect');
  b.v.stop();
});

await test('牌當場套到角色身上：上限加多少就回多少、體型 / 速度 / 武器欄 / 加成都換上；客戶端照 start + roundPicks 的 carry（Match.refit）建出一樣的角色，重連的 state 也一樣', () => {
  const deck = ['titan_frame', 'spring_boots', 'water_cannon'].map(card);
  const { io, v } = game({ freeze: true, cards: deck });
  const cm = clientMatch(io.take('start')[0]);
  sameEntities(v.match, cm, 'start');
  const me = v.match.byId('h1');
  me.hp = 200;   // 打過一輪，掉了一點血
  assert(toPick(io, v), 'pick');
  v.handle('h1', { t: 'pick', cardId: 'titan_frame' });   // 血量上限 +100（同時回 100）、受傷 -5%、體型 +10%
  const done = io.take('roundPicks')[0];
  assert(me.maxHp === V.hp + 100 && me.hp === 300, `maxHp ${me.maxHp} hp ${me.hp}`);
  assert(Math.abs(me.h - 30 * 1.1) < 1e-9 && Math.abs(me.hw - 9 * 1.1) < 1e-9, 'size');
  // 電腦玩家：稀有度最高的（巨人骨架 紫）
  assert(done.summary.filter(s => s.playerId !== 'h1').every(s => s.cardId === 'titan_frame'), 'bots take the rarest');
  for (const [id, c] of Object.entries(done.carry)) cm.refit(cm.byId(id), c);
  cm.applyEntities(done.entities);
  sameEntities(v.match, cm, 'after roundPicks');
  // 重連：照 statePayload 建
  io.advance(V.resumeDelay * 1000 + 10);
  const re = clientMatch(v.statePayload('h1'));
  sameEntities(v.match, re, 'reconnect');
  // 第二輪：武器牌進武器欄、速度的牌
  v.cards = deck.slice(1);
  me.hp = 100;
  assert(until(io, () => v.phase === 'pick' && v.pickRound === 2), 'pick 2');
  v.handle('h1', { t: 'pick', cardId: 'water_cannon' });
  assert(me.weapons.includes('waterCannon') && me.weapons.length === 3, 'weapon bar: ' + me.weapons);
  const bot = v.match.byId('bot1');
  assert(bot.moveSpeed > CONFIG.PLAYER.moveSpeed || bot.weapons.includes('waterCannon'), 'bot picked something that changes it');
  const done2 = io.take('roundPicks')[1];
  for (const [id, c] of Object.entries(done2.carry)) cm.refit(cm.byId(id), c);
  cm.applyEntities(done2.entities);
  sameEntities(v.match, cm, 'after round 2');
  v.stop();
  return { maxHp: me.maxHp, weapons: me.weapons };
});

await test('同一隊才算：祈願之杖只回自己那一隊；攜手之伴只能連活著的隊友（指定對手被擋下）、連上的兩人兩邊的 links 都有', () => {
  const { io, v } = game({ freeze: true, players: lineup({ humans: ['h1', 'h2', 'h3', 'h4'] }) });
  assert(toTurn(io, v, 'h1'), 'turn');
  for (const e of v.match.players) e.hp = 100;
  // 第一輪打完：真人的回合都等超時
  assert(toPick(io, v), 'pick');
  // 換掉每個人能選的牌：h1（藍）祈願之杖，其他人鐵壁之身（上限 +20、回 20）
  for (const id of Object.keys(v.offers)) { v.offers[id] = [card(id === 'h1' ? 'wish_staff' : 'iron_body')]; delete v.picks[id]; }
  for (const id of Object.keys(v.offers)) if (id.startsWith('bot')) v.picks[id] = 'iron_body';
  v.handle('h2', { t: 'pick', cardId: 'iron_body' });
  v.handle('h3', { t: 'pick', cardId: 'iron_body' });
  v.handle('h4', { t: 'pick', cardId: 'iron_body' });
  v.handle('h1', { t: 'pick', cardId: 'wish_staff' });
  const hp = Object.fromEntries(v.match.players.map(e => [e.id, e.hp]));
  for (const e of v.match.players) {
    const want = e.team === 'blue' ? (e.id === 'h1' ? 100 + 150 : Math.min(320, 120 + 160)) : 120;
    assert(e.hp === want, `${e.id} (${e.team}) hp ${e.hp}, want ${want}`);
  }
  io.advance(V.resumeDelay * 1000 + 10);
  // 攜手之伴
  assert(until(io, () => v.phase === 'pick' && v.pickRound === 2), 'pick 2');
  for (const id of Object.keys(v.offers)) { v.offers[id] = [card('bond')]; delete v.picks[id]; }
  const p = v.players.get('h1');
  const blueMates = v.match.players.filter(e => e.team === 'blue' && e.id !== 'h1').map(e => e.id).sort();
  assert(J(v.linkTargets(p).slice().sort()) === J(blueMates), 'link targets = blue mates: ' + J(v.linkTargets(p)));
  const red = v.match.players.find(e => e.team === 'red').id;
  v.handle('h1', { t: 'pick', cardId: 'bond', link: red });
  assert(io.records.at(-1).reason === 'badLinkTarget', 'cannot link an opponent');
  v.handle('h1', { t: 'pick', cardId: 'bond', link: 'h2' });
  assert(io.take('picked').some(m => m.playerId === 'h1' && m.link === 'h2'), 'picked with link');
  v.finishPicks();
  const h1 = v.match.byId('h1'), h2 = v.match.byId('h2');
  assert(h1.links.includes('h2') && h2.links.includes('h1'), 'linked both ways: ' + J([h1.links, h2.links]));
  assert(v.match.players.every(e => e.links.every(id => v.match.byId(id).team === e.team)), 'links stay within a team');
  v.stop();
  return hp;
});

await test('對戰不出的牌（VERSUS.excludeKeys：弒神者、腎上腺素、狂歡派對）；抽牌的稀有度照輪數', () => {
  const { v } = game();
  const ids = v.cards.map(c => c.id);
  for (const id of ['godslayer', 'adrenaline', 'party_time']) assert(!ids.includes(id), id + ' offered in versus');
  assert(ids.includes('war_drum') && ids.includes('wish_staff') && ids.includes('bond'), 'normal cards stay');
  v.stop();
  return { cards: ids.length, excluded: CARDS.length - ids.length };
});

await test('狂熱：第 1 ~ 10 輪 0 層、第 11 輪起 1 層（每一輪打完都選牌，輪數照常往上）', () => {
  const { io, v } = game({ freeze: true, players: lineup({ humans: [] }) });
  assert(until(io, () => v.match.round >= 12, 3_000_000), 'reach round 12, at ' + v.match.round);
  const seen = {};
  for (const m of io.take('turn')) seen[m.round] = v.match.rules.feverAt(m.round);
  for (let r = 1; r <= 12; r++) assert(seen[r] === (r >= 11 ? 1 : 0), `round ${r} fever ${seen[r]}`);
  const picks = io.take('roundPick').map(m => m.round);
  assert(J(picks.slice(0, 11)) === J([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 'a pick after every round: ' + picks);
  assert(v.players.get('bot1').cards.length === picks.length, 'bots got a card every round');
  v.stop();
  return { rounds: v.match.round, picks: picks.length };
});

await test('真人開火：伺服器結算、客戶端照 start 建的 Match 重播一樣（打到另一隊全額、同隊誤傷）', () => {
  const { io, v } = game({ freeze: true });
  const cm = clientMatch(io.take('start')[0]);
  assert(toTurn(io, v, 'h1'), 'turn');
  cm.applyEntities(io.take('turn').at(-1).entities);
  const me = v.match.byId('h1');
  const plan = planShot(v.match.world, me, new Rng(3));
  assert(plan, 'a plan');
  io.log.length = 0;
  v.handle('h1', { t: 'fire', weapon: plan.weapon, angle: plan.angle, power: plan.power, x: me.x, y: me.y, facing: plan.facing, stamina: me.stamina });
  const shot = io.take('shot')[0];
  assert(shot && shot.actorId === 'h1', 'shot');
  replayChecked(cm, shot, 'versus shot');
  cm.applyEntities(shot.results);
  sameEntities(v.match, cm, 'after shot');
  v.stop();
  return { hit: shot.hit.type, frames: shot.flightFrames };
});

await test('一隊全倒 → gameOver（贏的那一隊）→ 2.5 秒後 runOver（mode versus、winner、每個人的隊伍 / 擊殺 / 牌）、io.ended；記 battle.over / versus.over', () => {
  const { io, v } = game({ freeze: true });
  assert(toTurn(io, v, 'h1'), 'turn');
  for (const e of v.match.players) if (e.team === 'red') e.die('hit');
  v.match.byId('h1').kills = 3;
  assert(until(io, () => io.take('gameOver').length, CONFIG.TURN_TIME * 1000 + 5000), 'gameOver after the timeout');   // 超時 → 下一位之前判勝負
  const over = io.take('gameOver')[0];
  assert(over && over.result === 'blue', 'gameOver: ' + J(over && over.result));
  assert(!io.take('runOver').length && v.phase === 'ending', 'waits before runOver');
  io.advance(2600);
  const ro = io.take('runOver')[0];
  assert(ro && ro.mode === 'versus' && ro.winner === 'blue' && ro.result === 'blue' && ro.summary.length === 6, 'runOver: ' + J(ro && { ...ro, summary: undefined }));
  const s = ro.summary.find(x => x.id === 'h1');
  assert(s.team === 'blue' && s.kills === 3 && s.alive && ro.summary.filter(x => x.bot).length === 5, 'summary: ' + J(s));
  assert(io.endedWith === 'blue' && v.phase === 'over' && v.result === 'blue', 'ended');
  const bo = io.evs('battle.over')[0];
  assert(bo.result === 'blue' && bo.players.length === 6 && bo.players.every(p => p.team), 'battle.over: ' + J(bo));
  assert(io.evs('versus.over')[0].result === 'blue', 'versus.over');
  // 平手
  const d = game({ freeze: true });
  assert(toTurn(d.io, d.v, 'h1'), 'turn');
  for (const e of d.v.match.players) e.die('hit');
  assert(until(d.io, () => d.io.take('runOver').length, CONFIG.TURN_TIME * 1000 + 10_000), 'draw runOver');
  assert(d.io.take('runOver')[0].winner === null && d.io.take('runOver')[0].result === 'draw', 'draw');
  d.v.stop();
});

await test('重連（選牌中）：state 帶 runPhase pick、這一輪、他的牌、誰已經選了、剩幾秒；裁判停在 break', () => {
  const { io, v } = game({ freeze: true });
  assert(toPick(io, v), 'pick');
  io.advance(5000);
  const s = v.statePayload('h1');
  assert(s.runPhase === 'pick' && s.phase === 'break' && s.run.mode === 'versus' && s.pickRound === 1, 'phases: ' + J({ runPhase: s.runPhase, phase: s.phase }));
  assert(s.offers.length === V.offers && s.picked === null && s.pickedIds.length === 5 && Math.abs(s.pickTimeLeft - (V.pickTime - 5)) < 0.2, 'pick fields');
  assert(s.players.every(p => p.team) && s.players.filter(p => p.bot).length === 5, 'players with teams');
  v.stop();
});

await test('選牌開始時真人斷線（沒人在選：1 秒後就結束）、那一秒裡重連：state 給的秒數跟伺服器一樣，至少還有 10 秒可以選、選得到', () => {
  const { io, v } = game({ freeze: true });
  assert(toTurn(io, v, 'h1'), 'turn');
  v.setConnected('h1', false);
  assert(until(io, () => v.phase === 'pick'), 'pick while h1 is away');
  io.advance(300);
  const s = v.statePayload('h1');
  assert(s.runPhase === 'pick' && s.offers.length && s.pickTimeLeft >= 9.9, 'state pickTimeLeft ' + s.pickTimeLeft);
  v.setConnected('h1', true);
  io.advance(5000);
  assert(v.phase === 'pick' && Math.abs(v.statePayload('h1').pickTimeLeft - (s.pickTimeLeft - 5)) < 0.05, 'same deadline as the state said');
  v.handle('h1', { t: 'pick', cardId: s.offers.find(c => !c.weapon).id });
  const me = io.evs('pick.done')[0].players.find(p => p.pid === 'h1');
  assert(me && !me.auto, 'his own pick: ' + J(me));
  v.stop();
});

await test('電腦玩家不往自己人身上打：整場的誤傷遠小於打到對手的（每一發都會炸到自己人時改用直線武器或不開火）', () => {
  let friendly = 0, enemy = 0;
  for (const seed of [2, 6]) {
    const { io, v } = game({ players: lineup({ humans: [] }), seed });
    assert(until(io, () => v.phase === 'over', 20_000_000), 'over');
    for (const m of io.log) {
      const shot = m.t === 'aiTurn' ? m.shot : m.t === 'shot' ? m : null;
      for (const ev of (shot && shot.events) || []) for (const d of ev.damages || []) d.friendly ? (friendly += d.dmg) : (enemy += d.dmg);
    }
  }
  assert(enemy > 0 && friendly < enemy * 0.25, `friendly ${friendly} vs enemy ${enemy}`);
  return { friendly, enemy };
});

await test('電腦玩家打完整場（AI 真的開火、每一輪選牌）：一定分出勝負，結算的統計對得上', () => {
  const saved = V.hp;
  V.hp = 60;   // 快一點打完
  try {
    const { io, v } = game({ players: lineup({ humans: [] }), seed: 11 });
    const ok = until(io, () => v.phase === 'over', 20_000_000);
    assert(ok, `not over after ${v.match.round} rounds`);
    const ro = io.take('runOver')[0];
    assert(['blue', 'red', 'draw'].includes(ro.result), 'result ' + ro.result);
    const shots = io.take('aiTurn').filter(m => m.shot).length;
    assert(shots > 0, 'bots fired');
    const dealt = ro.summary.reduce((s, p) => s + p.dealt, 0);
    assert(dealt > 0 && ro.summary.some(p => p.kills > 0), 'stats');
    return { result: ro.result, rounds: ro.round, shots, picks: io.take('roundPick').length };
  } finally { V.hp = saved; }
});

// ---- 伺服器的房間 ----
function roomServer() {
  const lines = [];
  const mgr = new RoomManager({ log: { write: (e) => lines.push(e) } });
  const conn = (name) => {
    const inbox = [];
    const c = mgr.onConnection({ readyState: 1, send: (s) => inbox.push(JSON.parse(s)), close() {} }, { ip: '1.2.3.4' });
    c.inbox = inbox;
    mgr.onMessage(c, { t: 'hello', name });
    return c;
  };
  const lobbyOf = (c) => c.inbox.filter(m => m.t === 'lobby').at(-1);
  return { mgr, lines, conn, lobbyOf, evs: (ev) => lines.filter(l => l.ev === ev) };
}

await test('房間（勝者為王）：建房帶 mode、新來的人分到人少的那一隊、換隊、房主加 / 移除電腦玩家（滿了、不是房主、亂送的都記一筆）、最多 6 人', () => {
  const S = roomServer();
  const a = S.conn('甲');
  S.mgr.onMessage(a, { t: 'create', mode: 'versus', difficulty: 'elite' });
  let L = S.lobbyOf(a);
  assert(L.mode === 'versus' && L.max === 6 && L.teamSize === V.teamSize && L.difficulty === 'normal' && L.players[0].team === 'blue', 'lobby: ' + J(L));
  assert(S.evs('room.create')[0].mode === 'versus', 'room.create mode');
  const b = S.conn('乙');
  S.mgr.onMessage(b, { t: 'join', code: a.room.code });
  assert(S.lobbyOf(b).players.find(p => p.id === b.id).team === 'red' && S.evs('room.join')[0].team === 'red', 'joins the smaller team');
  S.mgr.onMessage(b, { t: 'team', team: 'blue' });
  assert(S.lobbyOf(a).players.find(p => p.id === b.id).team === 'blue' && S.evs('room.team').length === 1, 'switched');
  S.mgr.onMessage(b, { t: 'team', team: 'blue' });
  S.mgr.onMessage(b, { t: 'team', team: 'green' });
  S.mgr.onMessage(b, { t: 'addBot', team: 'red' });
  assert(J(S.evs('room.team.fail').map(l => l.reason)) === J(['sameTeam', 'badTeam']) && S.evs('room.bot.fail')[0].reason === 'notHost', 'fails logged');
  for (let i = 0; i < 4; i++) S.mgr.onMessage(a, { t: 'addBot', team: 'red' });
  assert(S.evs('room.bot.add').length === 3 && S.evs('room.bot.fail').at(-1).reason === 'teamFull', 'red full at 3');
  S.mgr.onMessage(a, { t: 'addBot', team: 'blue' });
  L = S.lobbyOf(a);
  assert(L.players.length === 6 && L.players.filter(p => p.bot).every(p => p.ready && p.team), 'six with bots: ' + J(L.players));
  // 滿了（含電腦玩家）：第三個真人進不來；大廳列表算進電腦玩家
  const c = S.conn('丙');
  S.mgr.onMessage(c, { t: 'join', code: a.room.code });
  assert(S.evs('room.join.fail').at(-1).reason === 'full', 'full');
  const d = S.conn('丁');
  S.mgr.onMessage(d, { t: 'browse', on: true });
  const listed = d.inbox.find(m => m.t === 'rooms').rooms.find(r => r.code === a.room.code);
  assert(listed && listed.mode === 'versus' && listed.players === 6 && listed.max === 6, 'rooms list: ' + J(listed));
  // 移除電腦玩家
  const bot = L.players.find(p => p.bot);
  S.mgr.onMessage(b, { t: 'removeBot', id: bot.id });
  S.mgr.onMessage(a, { t: 'removeBot', id: 'nope' });
  S.mgr.onMessage(a, { t: 'removeBot', id: bot.id });
  assert(J(S.evs('room.bot.fail').slice(-2).map(l => l.reason)) === J(['notHost', 'noBot']) && S.evs('room.bot.remove').length === 1, 'remove');
  assert(S.lobbyOf(a).players.length === 5, 'five left');
  a.room.stop();
});

await test('房間（勝者為王）：都準備好、兩隊都有人才能開始；開始後交給 Versus（電腦玩家一起），start 給每個人六個角色與隊伍；最後一個真人走了房間就回收', () => {
  const S = roomServer();
  const a = S.conn('甲');
  S.mgr.onMessage(a, { t: 'create', mode: 'versus' });
  S.mgr.onMessage(a, { t: 'ready', ready: true });
  S.mgr.onMessage(a, { t: 'start' });
  assert(S.evs('room.start.fail').at(-1).reason === 'emptyTeam', 'red is empty');
  S.mgr.onMessage(a, { t: 'addBot', team: 'red' });
  S.mgr.onMessage(a, { t: 'addBot', team: 'blue' });
  const b = S.conn('乙');
  S.mgr.onMessage(b, { t: 'join', code: a.room.code });
  S.mgr.onMessage(a, { t: 'start' });
  assert(S.evs('room.start.fail').at(-1).reason === 'notReady', 'b not ready');
  S.mgr.onMessage(b, { t: 'ready', ready: true });
  S.mgr.onMessage(a, { t: 'start' });
  const room = a.room;
  assert(room.started && room.run instanceof Versus, 'versus run');
  const st = S.evs('room.start').at(-1);
  assert(st.mode === 'versus' && st.players.length === 4 && st.players.filter(p => p.bot).length === 2, 'room.start: ' + J(st));
  const start = a.inbox.find(m => m.t === 'start');
  assert(start && start.players.length === 4 && start.players.every(p => p.team) && start.stageInfo.mode === 'versus', 'start payload');
  assert(J(b.inbox.find(m => m.t === 'start').players) === J(start.players), 'same for everyone');
  // 遊戲中斷線、回來
  S.mgr.onClose(b, 1006);
  assert(room.run.players.get(b.id).connected === false, 'b offline');
  // 真人都走了：房間回收（電腦玩家不算）
  S.mgr.onMessage(a, { t: 'leave' });
  S.mgr.onClose(a, 1000);
  room.stop();
  assert([...room.members.values()].every(m => !m.client), 'no humans connected');
  // 大廳裡：最後一個真人離開 → 回收（電腦玩家還在也一樣）
  const S2 = roomServer();
  const h = S2.conn('甲');
  S2.mgr.onMessage(h, { t: 'create', mode: 'versus' });
  S2.mgr.onMessage(h, { t: 'addBot', team: 'red' });
  const code = h.room.code;
  S2.mgr.onMessage(h, { t: 'leave' });
  assert(!S2.mgr.rooms.has(code) && S2.evs('room.destroy')[0].reason === 'empty', 'destroyed with only bots left');
});

await test('房間（冒險）不受影響：lobby / rooms 沒有 mode、最多 MAX_PLAYERS 人；換隊 / 加電腦玩家記 notVersus', () => {
  const S = roomServer();
  const a = S.conn('甲');
  S.mgr.onMessage(a, { t: 'create' });
  const L = S.lobbyOf(a);
  assert(!('mode' in L) && !('teamSize' in L) && L.max === CONFIG.MAX_PLAYERS && !('team' in L.players[0]), 'coop lobby: ' + J(L));
  S.mgr.onMessage(a, { t: 'team', team: 'red' });
  S.mgr.onMessage(a, { t: 'addBot', team: 'red' });
  S.mgr.onMessage(a, { t: 'removeBot', id: 'bot1' });
  assert(S.evs('room.team.fail')[0].reason === 'notVersus' && S.evs('room.bot.fail').every(l => l.reason === 'notVersus'), 'notVersus');
  assert(!('mode' in S.evs('room.create')[0]), 'room.create has no mode');
  a.room.stop();
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
