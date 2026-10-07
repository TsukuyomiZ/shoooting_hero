// node test/mechanics.js
// 地圖機制（shared/mechanics/）：每張地圖拿到對的機制、一般小關是 plain；不認得的 type / 舊格式（tree / snake / hive 直接掛在關卡上）會丟錯；
// plain 的掛勾什麼都不做；Match 呼叫掛勾的時間點與順序（掛勾的約定）；
// 機制的狀態只有一份（match.mechState，機制的 build 建的；場上的道具 = 巨蟒的狀態）；
// 架構檢查：match.js 不認得任何一張地圖（不 import tree-boss / snake-boss / hive、程式碼裡不提它們）、volley.js 不 import hive / snake-boss、
// 通用的檔案（match / referee / volley / run / ai / game-view / render）不直接碰機制的狀態與場上的道具（match.mechState 也不碰，match.js 只在建構時存起來）；
// 規則模組只認自己的狀態（別張地圖的 match.mechState 當作沒有，跟搬家前一樣什麼都不做）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../shared/config.js';
import { LEVELS } from '../shared/level.js';
import { Match } from '../shared/match.js';
import { planShot } from '../shared/ai.js';
import { mechanicFor, snapshotOf } from '../shared/mechanics/index.js';
import * as TreeBoss from '../shared/tree-boss.js';
import * as SnakeBoss from '../shared/snake-boss.js';
import * as Hive from '../shared/hive.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function test(name, fn) {
  try {
    const info = fn();
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
const HOOKS = ['build', 'ready', 'cascade', 'moved', 'turnStart', 'turnEnd', 'absorbHit', 'eventExtras', 'replayEvent', 'aiTurn', 'snapshot', 'restore'];
const WANT = { treeGarden: 'tree', jungleSerpent: 'snake', beehive: 'hive' };
// 每個機制的狀態（match.mechState）的欄位：跟搬進來之前的 match.tree / snake / hive 一樣，巨蟒多了場上的蛇血（items，原本的 match.items）
const STATE_KEYS = {
  tree: ['def', 'hpScale', 'minions', 'seq', 'next'],
  snake: ['def', 'next', 'dropped', 'itemSeq', 'items'],
  hive: ['def', 'hpScale', 'bees', 'seq', 'fresh'],
};

// 一個關卡暫時加進 LEVELS，建 Match 看會不會丟錯
function buildError(level) {
  LEVELS.__mech = level;
  try {
    new Match({ levelId: '__mech', players: mkPlayers(1), seed: 1 });
    return null;
  } catch (e) {
    return e;
  } finally {
    delete LEVELS.__mech;
  }
}

test('每張地圖拿到對的機制：古樹之庭 / 叢林巨蟒 / 小心擊發各自一個，其他都是 plain；狀態只有那一個機制建（match.mechState，一般小關 = null）', () => {
  const got = {};
  for (const [id, level] of Object.entries(LEVELS)) {
    const mech = mechanicFor(level, id);
    got[id] = mech.type;
    assert(mech.type === (WANT[id] || 'plain'), `${id} → ${mech.type}`);
    for (const h of HOOKS) assert(typeof mech[h] === 'function', `${id}: hook ${h} missing`);
    const m = new Match({ levelId: id, players: mkPlayers(2), seed: 3, stage: level.pool === 'boss' ? 5 : 1 });
    assert(m.mechanic === mech, `${id}: Match uses mechanicFor(level)`);
    const st = m.mechState;
    if (mech.type === 'plain') assert(st === null, `${id}: plain has no state: ${st && Object.keys(st)}`);
    else assert(st && J(Object.keys(st)) === J(STATE_KEYS[mech.type]) && st.def === level.mechanic, `${id}: mechState = ${st && Object.keys(st)}`);
    // 狀態不再掛在 Match 自己身上（一張地圖一個欄位、道具另外一個）
    for (const k of ['tree', 'snake', 'hive', 'items']) assert(!(k in m), `${id}: match.${k} is back`);
    for (const k of ['tree', 'snake', 'hive']) assert(!(k in level), `${id} still has the legacy "${k}" field`);
  }
  return got;
});

test('Boss / 蜂巢的角色排在關卡敵人後面；開場落地後才決定 Boss 的第一招（ready）', () => {
  const t = new Match({ levelId: 'treeGarden', players: mkPlayers(2), seed: 1, stage: 5 });
  assert(t.entities.slice(-2).map(e => e.id).join() === 'eye,mouth', 'tree parts last: ' + t.entities.map(e => e.id));
  assert(t.mechState.next && t.mechState.next.action, 'tree planned its first move');
  const s = new Match({ levelId: 'jungleSerpent', players: mkPlayers(2), seed: 1, stage: 5 });
  assert(s.entities[s.entities.length - 1].id === 'snake' && s.mechState.next && s.mechState.next.action, 'snake last + planned');
  const h = new Match({ levelId: 'beehive', players: mkPlayers(2), seed: 1 });
  assert(h.entities[h.entities.length - 1].id === 'hive', 'hive after the snipers: ' + h.entities.map(e => e.id));
  assert(h.byId('hive').noKill && !h.byId('e1').noKill, 'hive is the only noKill enemy');
});

test('不認得的 type 會直接報錯（不會默默變成一般小關）', () => {
  const err = buildError({ ...LEVELS.level1, mechanic: { type: 'volcano' } });
  assert(err && err.message === 'unknown mechanic type "volcano" in level __mech', 'unknown type throws: ' + (err && err.message));
  const err2 = buildError({ ...LEVELS.level1, mechanic: { type: 'plain' } });
  assert(err2 && /unknown mechanic type "plain"/.test(err2.message), 'plain is not a declarable type: ' + (err2 && err2.message));
  assert(/unknown mechanic type "x" in level lvX/.test(String((() => { try { mechanicFor({ mechanic: { type: 'x' } }, 'lvX'); } catch (e) { return e.message; } })())), 'mechanicFor names the level');
  return { message: err.message };
});

test('舊格式（tree / snake / hive 直接掛在關卡上）會報錯，告訴作者改成 mechanic: { type }', () => {
  const out = {};
  for (const [id, key] of [['treeGarden', 'tree'], ['jungleSerpent', 'snake'], ['beehive', 'hive']]) {
    const { mechanic, ...rest } = LEVELS[id];
    const { type, ...data } = mechanic;
    const err = buildError({ ...rest, [key]: data });
    assert(err && err.message.includes(`"${key}"`) && err.message.includes(`mechanic: { type: '${key}'`), `${key}: ` + (err && err.message));
    // 新舊並存也一樣報錯（不會兩個都建）
    const both = buildError({ ...LEVELS[id], [key]: data });
    assert(both && both.message === err.message, `${key} + mechanic: ` + (both && both.message));
    out[key] = err.message;
  }
  return out;
});

test('plain 的掛勾什麼都不做、回傳預設值', () => {
  const m = new Match({ levelId: 'level1', players: mkPlayers(2), seed: 1 });
  const P = m.mechanic;
  const before = J(m.snapshot());
  const p = m.players[0];
  const fx = [];
  const hit = { attacker: p, friendly: false, damages: [], later: [] };
  assert(P.type === 'plain', P.type);
  assert(P.build(m, { hpScale: 1, bossScale: 1 }) === null && P.ready(m) === undefined && P.cascade(m) === undefined, 'build → null (no state) / ready / cascade');
  assert(P.moved(m, p, 0, 0, 10, 10) === null, 'moved → null');
  P.turnStart(m, p, fx);
  P.turnEnd(m, p, fx);
  assert(fx.length === 0, 'turnStart / turnEnd push nothing');
  assert(P.absorbHit(m, m.byId('e1'), hit) === false && hit.damages.length === 0 && hit.later.length === 0, 'absorbHit → false, untouched');
  assert(J(P.eventExtras(m)) === '{}', 'eventExtras → {}');
  const r1 = P.replayEvent(m, { drops: [{ id: 'a1', type: 'snakeBlood', x: 1, y: 2 }], bees: [{ id: 'b1' }] });
  const r2 = P.replayEvent(m, {});
  assert(J(r1) === '{"items":[],"bees":[]}' && r1.items !== r2.items, 'replayEvent → fresh { items: [], bees: [] } (ignores fields it does not own)');
  assert(P.aiTurn(m, m.byId('e1')) === null, 'aiTurn → null');
  assert(J(P.snapshot(m)) === '{}', 'snapshot → {}');
  P.restore(m, { minions: [{ id: 'm1', x: 1, y: 1, hp: 1 }], bees: [{ id: 'b1', x: 1, y: 1, hp: 1 }], treeNext: { action: 'trunk' },
    snakeNext: { action: 'bite' }, items: [{ id: 'a1', type: 'snakeBlood', x: 1, y: 2 }] });
  assert(J(m.snapshot()) === before && m.mechState === null, 'nothing changed');
  assert(J(Object.keys(m.snapshot())) === J(['entities', 'holes', 'minions', 'treeNext', 'snakeNext', 'items', 'bees']), 'snapshot keys / order: ' + Object.keys(m.snapshot()));
  assert(J(snapshotOf(m)) === '{"minions":[],"treeNext":null,"snakeNext":null,"items":[],"bees":[]}', 'plain snapshot defaults: ' + J(snapshotOf(m)));
});

// 一般小關照裁判的流程打幾回合（玩家也用 AI 瞄準），回傳每回合的紀錄。spy = 拿一個轉手給 plain、記下呼叫的機制換掉
function playNormal(levelId, spy) {
  const m = new Match({ levelId, players: mkPlayers(2), seed: 5 });
  const calls = [];
  if (spy) {
    const real = m.mechanic;
    m.mechanic = Object.fromEntries(HOOKS.map(h => [h, (...a) => { calls.push(h); return real[h](...a); }]));
  }
  const log = [];
  let cur = null;
  for (let t = 0; t < 8; t++) {
    const a = m.nextActor(cur);
    if (!a) break;
    cur = a.id;
    m.beginTurn(a);
    const rec = { id: a.id, fx1: m.turnStartEffects(a) };
    if (a.team === 'players') {
      rec.pos = m.setPlayerPosition(a, a.x + 12, a.y, 1, a.stamina);
      rec.pickups = m.takePickups();
      const plan = planShot(m.world, a, m.rng);
      if (plan) rec.shot = m.resolveShot(a, plan.weapon, plan.angle, plan.power);
    } else {
      const r = m.planAiTurn(a);
      rec.walk = r.walk;
      if (r.plan) rec.shot = m.resolveShot(a, r.plan.weapon, r.plan.angle, r.plan.power);
    }
    rec.fx2 = m.endTurn(a);
    rec.result = m.result();
    rec.snap = m.snapshot();
    const c = new Match({ levelId, players: mkPlayers(2), seed: 5 });
    c.applySnapshot(JSON.parse(J(rec.snap)));
    rec.roundTrip = J(c.snapshot()) === J(rec.snap);
    log.push(rec);
    if (rec.result) break;
  }
  return { log: J(log), calls, rng: m.rng.float(), turns: log.length };
}

test('一般小關打幾回合：該呼叫的掛勾都有被呼叫（記錄版只轉手給 plain，不影響結果）、快照來回一致、事件裡沒有機制的欄位', () => {
  const out = {};
  for (const id of ['level1', 'grove', 'brawl']) {
    const a = playNormal(id, false);
    const b = playNormal(id, true);
    assert(a.log === b.log && a.rng === b.rng, `${id}: spying changed the game`);
    const L = JSON.parse(a.log);
    assert(L.every(r => r.roundTrip), `${id}: snapshot round trip`);
    assert(!/"(drops|bees|closed|hive)":/.test(a.log.replace(/"bees":\[\]/g, '')), `${id}: no mechanic fields in a plain game`);
    for (const h of ['cascade', 'moved', 'turnStart', 'turnEnd', 'absorbHit', 'aiTurn', 'snapshot']) assert(b.calls.includes(h), `${id}: ${h} never called`);
    out[id] = { turns: a.turns, calls: b.calls.length };
  }
  return out;
});

// 掛勾的約定：Match 在什麼時間點、什麼順序呼叫（用一個會留下記號的機制換掉 plain）
function spyMatch(over) {
  const m = new Match({ levelId: 'level1', players: mkPlayers(2), seed: 2 });
  const calls = [];
  const base = m.mechanic;
  m.mechanic = Object.fromEntries(HOOKS.map(h => [h, (...a) => { calls.push(h); return (over[h] || base[h])(...a); }]));
  return { m, calls };
}

test('掛勾的時間點：turnStart 在中毒之後、回血之前；turnEnd 在燃燒之後、神佑之石之前', () => {
  const { m } = spyMatch({
    turnStart: (match, e, fx) => fx.push({ type: 'spyStart', id: e.id }),
    turnEnd: (match, e, fx) => fx.push({ type: 'spyEnd', id: e.id }),
  });
  const p = m.players[0];
  p.poison = 1;
  p.mods.regenPct = 10;
  p.hp = 50;
  m.beginTurn(p);
  const fx1 = m.turnStartEffects(p).map(f => f.type);
  assert(fx1.join() === 'poison,spyStart,heal', 'turn start order: ' + fx1);
  p.burn = 30;   // 每層 0.1%：30 層才扣得到整數的血
  p.mods.teamShield = 1;
  p.turnCount = CONFIG.EQUIP.shieldEveryTurns;
  const fx2 = m.endTurn(p).map(f => f.type);
  assert(fx2.join() === 'burn,spyEnd,shield', 'turn end order: ' + fx2);
  return { fx1, fx2 };
});

test('掛勾的時間點：moved 在落水之前（回傳的進 pickups）', () => {
  let seen = null;
  const { m } = spyMatch({
    moved: (match, e, x0, y0, x, y) => { seen = { falls: e.waterFalls, args: [x0, y0, x, y].map(Math.round) }; return { type: 'spyPick', id: e.id }; },
  });
  const p = m.players[0];
  p.x = 380; p.y = 440;
  assert(m.setPlayerPosition(p, 440, 690, 1, p.stamina), 'report accepted');
  assert(seen && seen.falls === 0 && J(seen.args) === J([380, 440, 440, 690]), 'moved before the water check: ' + J(seen));
  assert(p.waterFalls === 1, 'then fell in the water');
  const got = m.takePickups();
  assert(got.length === 1 && got[0].type === 'spyPick' && m.takePickups().length === 0, 'pickups drained: ' + J(got));
});

test('掛勾的時間點：absorbHit 在無敵之前、接手的角色不扣血不擊退；later 在所有人扣完血之後照順序跑', () => {
  const order = [];
  const { m } = spyMatch({
    absorbHit: (match, e, hit) => {
      if (e.id !== 'e1') return false;
      const entry = { id: e.id, dmg: 0, friendly: hit.friendly, spy: true };
      hit.damages.push(entry);
      hit.later.push(() => { order.push(['a', match.byId('e2').hp]); entry.dmg = 7; });
      hit.later.push(() => order.push(['b']));
      return true;
    },
  });
  const [e1, e2] = [m.byId('e1'), m.byId('e2')];
  e2.x = e1.x + 12; e2.y = e1.y;
  e1.shield = 1;
  e1.vx = 0;
  const hp1 = e1.hp, hp2 = e2.hp;
  const p = m.players[0];
  const dmg = m.applyExplosion(e1.x, e1.y - 10, CONFIG.WEAPONS.cannon, p, e1);
  const d1 = dmg.find(d => d.id === 'e1'), d2 = dmg.find(d => d.id === 'e2');
  assert(d1 && d1.spy && d1.dmg === 7 && !d1.blocked, 'absorbed entry (before shields), later wrote its dmg: ' + J(d1));
  assert(e1.hp === hp1 && e1.shield === 1 && e1.vx === 0, 'absorbed target untouched (hp, shield, knockback)');
  assert(d2 && d2.dmg > 0 && e2.hp < hp2, 'the other target took damage: ' + J(d2));
  assert(J(order) === J([['a', e2.hp], ['b']]), 'later ran after all damage, in order: ' + J(order));
  assert(p.dealt === d2.dmg + 7, 'absorbed damage counts toward dealt');
});

test('掛勾的時間點：eventExtras 只在有傷害的事件、ents 之後；cascade 在算擊殺之前', () => {
  let tag = 0;
  const { m, calls } = spyMatch({
    eventExtras: () => ({ spy: ++tag }),
    cascade: (match) => { for (const e of match.enemies) if (e.alive && e.hp <= 40) e.die('spy'); },   // 「連帶倒下」的機制
  });
  const p = m.players[0];
  const e1 = m.byId('e1');
  e1.hp = 40;
  const mz = p.muzzle();
  const ang = Math.atan2(-(e1.cy - mz.y), e1.cx - mz.x) * 180 / Math.PI;
  calls.length = 0;
  const shot = m.resolveShot(p, 'sniper', ang, 100);
  const withDmg = shot.events.filter(ev => ev.damages);
  assert(withDmg.length > 0, 'the shot hit something: ' + J(shot.hit));
  for (const ev of shot.events) {
    const keys = Object.keys(ev);
    if (ev.damages) assert(keys[keys.length - 1] === 'spy' && keys[keys.length - 2] === 'ents', 'extras after ents: ' + keys);
    else assert(!('spy' in ev), 'no extras without damage');
  }
  assert(calls.filter(c => c === 'eventExtras').length === withDmg.length, 'eventExtras once per damaging event');
  assert(calls[calls.length - 1] === 'cascade', 'cascade after the flight: ' + calls.slice(-3));
  assert(!e1.alive && shot.kills.includes('e1'), 'cascade deaths count as kills: ' + J(shot.kills));
  calls.length = 0;
  m.result();
  assert(J(calls) === J(['cascade']), 'result() runs cascade first');
});

test('掛勾的時間點：aiTurn 接手的回合不抽亂數、不走路；snapshot / restore 的位置與順序', () => {
  const boss = { steps: [{ action: 'spy', still: { results: [], settleFrames: 0 } }], next: null };
  const { m } = spyMatch({
    aiTurn: (match, actor) => (actor.id === 'e1' ? boss : null),
    snapshot: () => ({ bees: ['spy'], minions: ['spy'] }),
    restore: (match, s) => { seen = { holes: match.terrain.holes.length, items: s.items, hp: match.byId('e1').hp, minions: s.minions }; },
  });
  let seen = null;
  const twin = new Match({ levelId: 'level1', players: mkPlayers(2), seed: 2 });
  const r = m.planAiTurn(m.byId('e1'));
  assert(r.boss === boss && r.walk === null && r.plan === null, 'mechanic turn: ' + J(r));
  assert(m.rng.float() === twin.rng.float(), 'no rng drawn');
  const r2 = m.planAiTurn(m.byId('e2'));
  assert(!r2.boss && r2.plan, 'other enemies: normal AI');
  const snap = m.snapshot();
  assert(J(Object.keys(snap)) === J(['entities', 'holes', 'minions', 'treeNext', 'snakeNext', 'items', 'bees']), 'key order kept: ' + Object.keys(snap));
  assert(J(snap.bees) === '["spy"]' && J(snap.minions) === '["spy"]', 'mechanic keys override the defaults');
  m.byId('e1').hp = 1;
  m.terrain.carve(500, 470, 30);
  const s = JSON.parse(J(m.snapshot()));
  s.items = [{ id: 'z', type: 'snakeBlood', x: 1, y: 2 }];
  const c = new Match({ levelId: 'level1', players: mkPlayers(2), seed: 2 });
  const cm = c.mechanic;
  c.mechanic = { ...cm, restore: m.mechanic.restore };
  c.applySnapshot(s);
  // 場上的道具也交給 restore（道具是機制的狀態）：Match 自己不收，這張地圖沒有道具的主人就沒有
  assert(seen && seen.holes === 1 && seen.hp !== 1 && J(seen.minions) === '["spy"]', 'restore after holes, before entity states: ' + J(seen));
  assert(J(seen.items) === J(s.items), 'restore gets the items too: ' + J(seen.items));
  assert(c.byId('e1').hp === 1 && c.mechState === null && J(c.snapshot().items) === '[]', 'then entities applied; Match keeps no items of its own');
});

test('場上的道具是巨蟒的狀態：快照照樣帶（複本）、套用快照與客戶端的 turn / turnFx（restore 只帶 { items }）經巨蟒的 restore 換成複本；別的機制不理 items', () => {
  const mk = (levelId) => new Match({ levelId, players: mkPlayers(2), seed: 2, stage: LEVELS[levelId].pool === 'boss' ? 5 : 1 });
  const m = mk('jungleSerpent');
  const it = { id: 'a1', type: 'snakeBlood', x: 300, y: 500 };
  m.mechState.items.push(it);
  const snap = m.snapshot();
  assert(J(snap.items) === J([it]) && snap.items[0] !== it, 'snapshot carries a copy: ' + J(snap.items));
  const c = mk('jungleSerpent');
  c.applySnapshot(JSON.parse(J(snap)));
  assert(J(c.mechState.items) === J([it]), 'applySnapshot restores the items: ' + J(c.mechState.items));
  // 只帶 items（客戶端的 GameView.setItems）：換掉道具（複本），預定的下一招不動
  const items = [{ id: 'a2', type: 'snakeBlood', x: 400, y: 500 }];
  const plan = c.mechState.next;
  c.mechanic.restore(c, { items });
  assert(J(c.mechState.items) === J(items) && c.mechState.items[0] !== items[0] && c.mechState.next === plan, 'partial restore: items copied, plan untouched');
  c.mechanic.restore(c, {});
  assert(J(c.mechState.items) === J(items), 'no items field: left alone');
  // 別張地圖：道具沒有主人，只帶 { items } 什麼都不變
  const out = {};
  for (const id of ['level1', 'treeGarden', 'beehive']) {
    const o = mk(id);
    const before = J(o.snapshot());
    o.mechanic.restore(o, { items });
    assert(J(o.snapshot()) === before && J(o.snapshot().items) === '[]', `${id}: { items } changes nothing`);
    out[id] = o.mechanic.type;
  }
  return out;
});

test('規則模組只認自己的狀態：一般小關（mechState = null）與別張地圖的狀態呼叫古樹 / 蜂巢 / 巨蟒的函式不會壞、狀態不變（跟搬家前的 match.tree / hive / snake 一樣當作沒有）', () => {
  const mk = (levelId) => new Match({ levelId, players: mkPlayers(2), seed: 2, stage: LEVELS[levelId].pool === 'boss' ? 5 : 1 });
  const spec = (id) => ({ id, name: id, x: 300, y: 400, hp: 10, wait: 1 });
  const out = {};
  for (const levelId of ['level1', 'treeGarden', 'jungleSerpent', 'beehive']) {
    const m = mk(levelId);
    const own = m.mechanic.type;
    const before = J(m.mechState);
    const called = [];
    if (own !== 'tree') {
      TreeBoss.spawnTreant(m, spec('m99'));
      assert(J(TreeBoss.witherTree(m)) === '[]', `${levelId}: witherTree`);
      called.push('spawnTreant', 'witherTree');
    }
    if (own !== 'hive') {
      Hive.spawnBee(m, spec('b99'));
      const n = m.entities.length;
      assert(Hive.hitHive(m, { takeDamage: (d) => d }) === 1 && m.entities.length === n, `${levelId}: hitHive releases no bee`);
      assert(J(Hive.takeFreshBees(m)) === '[]', `${levelId}: takeFreshBees`);
      called.push('spawnBee', 'hitHive', 'takeFreshBees');
    }
    if (own !== 'snake') {
      assert(J(SnakeBoss.snakeDrops(m)) === '[]', `${levelId}: snakeDrops`);
      called.push('snakeDrops');
    }
    assert(J(m.mechState) === before, `${levelId}: mechState changed: ${J(m.mechState)}`);
    out[levelId] = called.length;
  }
  return out;
});

test('客戶端用到的匯出都還在（client/ 沒改）', () => {
  const need = {
    'tree-boss': [TreeBoss, ['spawnTreant', 'leafOrigin', 'trunkLane', 'TREE_ACTION_NAMES']],
    'snake-boss': [SnakeBoss, ['SNAKE_ACTION_NAMES', 'chargeLane', 'takeDrops', 'pickupAlong']],
    hive: [Hive, ['BEE_ACTION_NAMES', 'hatchBees']],
  };
  for (const [file, [mod, names]] of Object.entries(need)) for (const n of names) assert(mod[n] !== undefined, `${file}.js lost export ${n}`);
  // 客戶端實際 import 的名字（直接讀 client/ 的原始碼，含子資料夾（例如 map-views/），不靠上面的清單）
  const importers = new Set();
  for (const f of fs.readdirSync(path.join(ROOT, 'client'), { recursive: true }).filter(f => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, 'client', f), 'utf8');
    for (const [, names, file] of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(?:\.\.\/)+shared\/(tree-boss|snake-boss|hive)\.js'/g)) {
      const mod = { 'tree-boss': TreeBoss, 'snake-boss': SnakeBoss, hive: Hive }[file];
      importers.add(`${f.replace(/\\/g, '/')}→${file}`);
      for (const n of names.split(',').map(s => s.trim()).filter(Boolean)) assert(mod[n] !== undefined, `client/${f} imports ${n} from ${file}.js, which is gone`);
    }
  }
  // 掃描真的有掃到地圖畫面（檔案搬家時不會默默變成什麼都沒檢查）
  for (const need of ['map-views/tree.js→tree-boss', 'map-views/snake.js→snake-boss', 'map-views/hive.js→hive']) {
    assert(importers.has(need), `scan did not see ${need}: ${[...importers]}`);
  }
});

// ---- 架構檢查（讀原始碼）----
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const importsOf = (src) => [...src.matchAll(/^\s*import\b[^;]*?from\s*'([^']+)'/gm)].map(m => m[1]);
// 拿掉註解（這裡掃的檔案的字串裡都沒有 //、/*）
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('match.js 不認得任何一張地圖：不 import tree-boss / snake-boss / hive，程式碼裡也不提它們（沒有例外：狀態在 match.mechState）', () => {
  const src = read('shared/match.js');
  const imports = importsOf(src);
  for (const f of ['./tree-boss.js', './snake-boss.js', './hive.js']) assert(!imports.includes(f), `match.js imports ${f}`);
  assert(imports.includes('./mechanics/index.js'), 'match.js goes through mechanics/index.js: ' + imports);
  const bad = codeOf(src).split('\n').map((l, i) => [i + 1, l])
    .filter(([, l]) => /tree|snake|hive|treant|mouth|\beye\b|\bbees?\b|\.part\b/i.test(l));
  assert(!bad.length, 'match.js mentions a map:\n' + bad.map(([n, l]) => `        ${n}: ${l.trim()}`).join('\n'));
  return { imports };
});

test('通用的檔案不直接碰機制的狀態與場上的道具：match / referee / volley / run / ai / game-view / render 的程式碼（註解除外）沒有 .tree / .snake / .hive / .items（[\'items\'] 也算），也不碰 match.mechState（match.js 只准建構時存起來）', () => {
  // 不管是誰的欄位都不行（訊息帶的 items 也用解構拿、整則交給機制）：狀態只經過 match.mechanic 的掛勾
  const ACCESS = /\.(tree|snake|hive|items)\b|\[\s*['"](tree|snake|hive|items)['"]\s*\]/;
  const caught = ['match.tree.next', 'this.items = []', 'if (msg.items) this.setItems(msg.items);', 'c.match.snake', 'm.hive.bees', "S['items'] = items", 'm[ "tree" ].next'];
  assert(caught.every(s => ACCESS.test(s)), 'the scan misses: ' + caught.filter(s => !ACCESS.test(s)));
  assert(!['this.mechState', 'treeNext', 'const { entities, items } = this.match.snapshot();', 'e.itemsLeft', 'snakeBlood', "m['itemsLeft']"].some(s => ACCESS.test(s)), 'the scan flags ordinary code');
  // match.mechState 本身也只給地圖機制、規則模組、地圖畫面讀寫：通用的檔案一律不碰，match.js 只准建構時的這兩行（先清空、存 build 回傳的狀態）
  const MECH = /\bmechState\b/;
  const MATCH_OK = [/^\s*this\.mechState = null;\s*$/, /^\s*this\.mechState = this\.mechanic\.build\([^;]*\)( \?\? null)?;\s*$/];
  const sneaky = ['const S = this.match.mechState;', 'const { items = [] } = this.match.mechState || {};', 'this.mechState = this.mechanic.build(this, {}); this.mechState.items = [];'];
  assert(sneaky.every(s => MECH.test(s)) && sneaky.every(s => !MATCH_OK.some(re => re.test(s))), 'the mechState scan misses: ' + sneaky.filter(s => !MECH.test(s) || MATCH_OK.some(re => re.test(s))));
  assert(!['this.mechanic.restore(this.match, { items });', 'mechanicFor(level)', 'this.mechanic'].some(s => MECH.test(s)), 'the mechState scan flags ordinary code');
  const out = {};
  for (const f of ['shared/match.js', 'shared/referee.js', 'shared/volley.js', 'shared/run.js', 'shared/ai.js', 'client/game-view.js', 'client/render.js']) {
    const lines = codeOf(read(f)).split('\n').map((l, i) => [i + 1, l]);
    const bad = lines.filter(([, l]) => ACCESS.test(l));
    assert(!bad.length, `${f} touches mechanic state / items directly:\n` + bad.map(([n, l]) => `        ${n}: ${l.trim()}`).join('\n'));
    const allowed = f === 'shared/match.js' ? MATCH_OK : [];
    const mech = lines.filter(([, l]) => MECH.test(l));
    const stray = mech.filter(([, l]) => !allowed.some(re => re.test(l)));
    assert(!stray.length, `${f} reads / writes match.mechState:\n` + stray.map(([n, l]) => `        ${n}: ${l.trim()}`).join('\n'));
    // match.js：那兩行各一次（不多寫一份）
    assert(allowed.every(re => mech.filter(([, l]) => re.test(l)).length === 1), `${f}: mechState lines ` + J(mech));
    out[f] = lines.length;
  }
  return out;
});

test('volley.js 不 import hive / snake-boss（重播透過 match.mechanic）；mechanics/ 不 import match.js / volley.js（沒有循環）', () => {
  const imports = importsOf(read('shared/volley.js'));
  for (const f of ['./hive.js', './snake-boss.js', './tree-boss.js']) assert(!imports.includes(f), `volley.js imports ${f}`);
  const dir = path.join(ROOT, 'shared', 'mechanics');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const imp = importsOf(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert(!imp.some(s => /\/(match|volley|referee)\.js$/.test(s)), `mechanics/${f} imports ${imp}`);
  }
  // 規則模組只往下 import 共用的小工具
  for (const f of ['tree-boss.js', 'snake-boss.js', 'hive.js']) {
    const imp = importsOf(read('shared/' + f));
    assert(!imp.some(s => /match\.js$|volley\.js$|mechanics\/(index|tree|snake|hive|plain)\.js$/.test(s)), `${f} imports ${imp}`);
  }
  return { volley: imports, mechanics: files };
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
