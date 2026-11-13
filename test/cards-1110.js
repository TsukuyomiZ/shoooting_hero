// node test/cards-1110.js
// 2026-11-10 使用者給的：武器牌「急救槍」、牌「生命增幅器 / 知足 / 樂觀 / 人工心臟」，攜手之伴的減傷下修、巨人骨架體型 +30%。
// - 牌庫：每張牌的稀有度 / 效果 / 說明裡的數字跟效果的數值、武器的設定一致；急救槍是多人限定（單人冒險不出）；版本履歷有記
// - 急救槍：直線、穿過敵人、打到的隊友回 healHp × 射手的武器傷害加成 × 對方的治療效率；滿血回 0；打地形不挖坑；不算命中敵人；
//   客戶端重播一致（事件帶回完血的狀態）；瞄準預覽穿過敵人；AI 不會拿它開火
// - 治療效率：戰鬥中的回血（吸血、恩賜之杖、急救槍）都乘上；選牌時回血的牌照被回血的人自己的效率；過關回血、加上限同時補的血不算
// - 知足：受到治療（不含吸血、真的回到血）才疊層、上限、每關從 0 開始、同步到客戶端
// - 樂觀：血量在一定比例以上（含）才有武器傷害加成
// - 人工心臟：被打倒（含連結分到的那份）、淹死、毒倒、燒死、流血倒下都當場以一定比例的血復活、清掉負面狀態、不算擊殺、這一下的狀態不再上；
//   整場冒險只有一次（第二次就真的倒下；一關打完收回玩家身上，下一關還是用過了、客戶端照 start 的 carry 也知道；勝者為王選牌換裝之後也還是用過了）；
//   客戶端重播一致（同一波裡救回來又被打倒也一樣）；
//   真的 GameView：自己的回合走路流血倒下 → 自己的畫面先救、回報 hp 0 → 伺服器一樣救回來、回合繼續，兩邊的畫面都演復活
// 牌的數值、急救槍的設定使用者會自己調：預期的數字照 cards.json / config 現在的值算；血量一律自己設
import fs from 'node:fs';
import { CONFIG } from '../shared/core/config.js';
import { CHANGELOG } from '../shared/core/version.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { Run } from '../shared/game/run.js';
import { Versus } from '../shared/game/versus.js';
import { validateCards, baseStats, derivePlayerStats, drawOffers } from '../shared/cards/cards.js';
import { effectChips, watchFxOps, stateOf } from '../shared/cards/effects/index.js';
import { isEquippable, aimPreview } from '../shared/physics/weapons.js';
import { planShot, preferredWeapon } from '../shared/ai/ai.js';
import { planWalk } from '../shared/ai/ai-move.js';
import { Entity } from '../shared/physics/entities.js';
import { Rng } from '../shared/core/rng.js';
import { replayChecked } from './replay-check.js';

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
const STEP = CONFIG.FIXED_DT;

const CARDS = validateCards(JSON.parse(fs.readFileSync(new URL('../shared/cards/cards.json', import.meta.url), 'utf8')));
const cardById = (id) => { const c = CARDS.cards.find(x => x.id === id); assert(c, 'no card ' + id); return c; };
const cardFx = (id) => cardById(id).effects;
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const W = CONFIG.WEAPONS;
const P = CONFIG.PLAYER.hp;
// 測試自己的關卡規則設定：敵人傷害 ×1、狂熱照預設的格式
const CFG = { ...CONFIG, ENEMY: { ...CONFIG.ENEMY, damageMult: 1, damageMultLate: 1 } };

class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.records = []; this.seq = 0; }
  broadcast(msg, exceptId) { this.log.push({ ...JSON.parse(J(msg)), _except: exceptId }); }
  record(ev, data) { this.records.push({ ev, ...JSON.parse(J(data)) }); }
  schedule(fn, ms) { const h = { at: this.t + ms, fn, id: this.seq++ }; this.timers.push(h); return h; }
  cancel(h) { this.timers = this.timers.filter(x => x !== h); }
  now() { return this.t; }
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
  take(type) { return this.log.filter(m => m.t === type); }
  recs(ev) { return this.records.filter(r => r.ev === ev); }
}
const until = (io, pred, max = 120_000) => { const s = io.t; while (!pred() && io.t - s < max) io.advance(50); return pred(); };

// 帶著某些效果的玩家 carry（血量自己設）
function carryOf(effects = {}, { hp = 5000, weapons } = {}) {
  const stats = baseStats();
  for (const [k, v] of Object.entries(effects)) if (k in stats) stats[k] += v;
  const d = derivePlayerStats(stats);
  return { hp, maxHp: hp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed, size: d.size, mods: d.mods, ...(weapons ? { weapons } : {}) };
}
// 戰鬥：fx = { p1: 效果, p2: 效果… }；所有人血量 hp（敵人也是）
function matchWith(fx = {}, { players = 1, levelId = 'level1', seed = 1, hp = 5000, weapons } = {}) {
  const carry = {};
  for (let i = 1; i <= players; i++) carry['p' + i] = carryOf(fx['p' + i] || {}, { hp, weapons });
  const m = new Match({ levelId, players: mkPlayers(players), seed, carry, config: CFG });
  for (const e of m.entities) { e.maxHp = hp; e.hp = hp; }
  return m;
}
// 客戶端照 carry 與快照建的 Match（開火之前）
const clientOf = (m) => {
  const cm = new Match({ levelId: m.levelId, players: mkPlayers(m.players.length), seed: m.seed, carry: m.carry, stage: m.stage });
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  return cm;
};
const place = (e, ref, dx) => { e.x = ref.x + dx; e.y = ref.y; e.vx = 0; e.vy = 0; };
const aimAt = (shooter, target) => { const mz = shooter.muzzle(); return Math.atan2(-(target.cy - mz.y), target.cx - mz.x) * 180 / Math.PI; };
// 一下直擊（不波及別人）：傷害 dmg 的直線武器（id 照 sniper，不吃任何武器限定的加成）
const strike = (m, attacker, target, extra = {}, opts = {}) =>
  m.applyExplosion(target.cx, target.cy, { ...W.sniper, damage: 100, knockback: 0, ...extra }, attacker, target, { directOnly: true, ...opts });
const sameEntities = (a, b, label) => {
  for (const e of a.entities) {
    const c = b.byId(e.id);
    assert(J(c.toState()) === J(e.toState()), `${label}: ${e.id} differs\n        server ${J(e.toState())}\n        client ${J(c.toState())}`);
  }
};

// ---------------- 牌庫 ----------------

await test('牌庫：急救槍（綠、武器、多人限定）、生命增幅器（綠）、知足（綠）、樂觀（紫）、人工心臟（金、unique）；說明裡的數字跟效果 / 武器 / config 一致；攜手之伴、巨人骨架的說明跟著改；版本履歷有記', () => {
  assert(!CARDS.warnings.length, 'no warnings: ' + CARDS.warnings);
  const G = W.medGun;
  assert(isEquippable('medGun') && G.healHp > 0 && G.gravity === 0 && G.passEnemies && G.radius === 0 && G.damage === 0 && G.teamOnly, 'medGun config ' + J(G));
  const gun = cardById('med_gun');
  assert(gun.rarity === 'green' && gun.weapon === 'medGun' && !gun.unique && gun.teamOnly && gun.desc.includes(`${G.healHp} 血`), 'med_gun card ' + J(gun));
  const amp = cardById('life_amplifier'), con = cardById('contentment'), opt = cardById('optimism'), heart = cardById('artificial_heart');
  assert(amp.rarity === 'green' && J(Object.keys(amp.effects)) === J(['healRecvPct']) && amp.desc.includes(`+${amp.effects.healRecvPct}%`), 'life_amplifier ' + J(amp));
  assert(con.rarity === 'green' && con.desc.includes(`+${con.effects.healedDamagePct}%`) && con.desc.includes(`+${con.effects.healedDamageMaxPct}%`), 'contentment ' + J(con));
  assert(opt.rarity === 'purple' && opt.desc.includes(`+${opt.effects.healRecvPct}%`) && opt.desc.includes(`+${opt.effects.healthyDamagePct}%`) &&
    CONFIG.EQUIP.optimist.hpPct === 50 && opt.desc.includes('一半'), 'optimism ' + J(opt));
  assert(heart.rarity === 'gold' && heart.unique && heart.desc.includes(`${heart.effects.revivePct}%`), 'artificial_heart ' + J(heart));
  // 攜手之伴的減傷在 config（使用者 11-10 下修成 10%），牌面跟著；巨人骨架的體型照牌上的 sizePct
  const bond = cardById('bond'), titan = cardById('titan_frame');
  assert(CONFIG.EQUIP.link.damageCutPct === 10 && bond.desc.includes(`減 ${CONFIG.EQUIP.link.damageCutPct}%`), 'bond ' + bond.desc);
  assert(titan.effects.sizePct === 30 && titan.desc.includes(`+${titan.effects.sizePct}%`), 'titan ' + J(titan));
  // 抽牌：單人冒險不出急救槍（多人會出）
  const rng = new Rng(3);
  let solo = 0, team = 0;
  for (let k = 0; k < 600; k++) {
    solo += drawOffers(CARDS.cards, rng, 3, 3, [], ['cannon', 'sniper'], { solo: true }).some(c => c.id === 'med_gun');
    team += drawOffers(CARDS.cards, rng, 3, 3, [], ['cannon', 'sniper'], { solo: false }).some(c => c.id === 'med_gun');
  }
  assert(solo === 0 && team > 0, `solo ${solo}, team ${team}`);
  const top = CHANGELOG[0];
  assert(top.new.some(l => l.includes('急救槍')) && top.new.some(l => l.includes('人工心臟')) &&
    top.change.some(l => l.includes('攜手之伴')) && top.change.some(l => l.includes('巨人骨架')), 'CHANGELOG ' + J(top));
  return { team };
});

// ---------------- 急救槍 ----------------

await test('急救槍：穿過擋在中間的敵人、打到隊友回 healHp × 射手的武器傷害加成 × 對方的治療效率；敵人不扣也不回；不挖坑、不算命中；客戶端重播一致', () => {
  const G = W.medGun;
  const shooterFx = { damagePct: 50 }, targetFx = { healRecvPct: 40 };
  const m = matchWith({ p1: shooterFx, p2: targetFx }, { players: 2, weapons: ['medGun', 'sniper'] });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  place(e1, p1, 70);
  place(p2, p1, 140);
  p2.hp = 100;
  e1.hp = 400;
  const cm = clientOf(m);
  const holes = m.terrain.holes.length;
  const mult = m.damageMult(p1, G);
  assert(Math.abs(mult - (1 + shooterFx.damagePct / 100)) < 1e-12, 'shooter bonus ' + mult);
  const expect = Math.floor(G.healHp * mult * (1 + targetFx.healRecvPct / 100) + 1e-9);
  const shot = JSON.parse(J(m.resolveShot(p1, 'medGun', aimAt(p1, p2), 50)));
  const ev = shot.events.find(x => x.heals);
  assert(ev && ev.target === 'p2' && J(ev.heals) === J([{ id: 'p2', n: expect }]) && !ev.damages && !ev.carve, 'heal event ' + J(shot.events));
  assert(p2.hp === 100 + expect && e1.hp === 400 && m.terrain.holes.length === holes && shot.hitEnemy === false, `p2 ${p2.hp} e1 ${e1.hp}`);
  assert(!shot.events.some(x => x.target === 'e1'), 'passed through the enemy');
  const ents = ev.ents.find(s => s.id === 'p2');
  assert(ents && ents.hp === 100 + expect, 'event carries the healed state ' + J(ev.ents));
  replayChecked(cm, shot, 'med gun');
  assert(cm.byId('p2').hp === 100 + expect, 'client replay heals before the results');
  cm.applyEntities(shot.results);
  sameEntities(m, cm, 'med gun');
  // 滿血的隊友：回 0
  const full = JSON.parse(J(m.resolveShot(p1, 'medGun', aimAt(p1, p2), 50)));
  p2.hp = p2.maxHp;
  const again = JSON.parse(J(m.resolveShot(p1, 'medGun', aimAt(p1, p2), 50)));
  assert(full.events.find(x => x.heals) && again.events.find(x => x.heals).heals[0].n === 0 && p2.hp === p2.maxHp, 'full hp heals 0');
  // 打在地形上：沒有回血、不挖坑
  const down = JSON.parse(J(m.resolveShot(p1, 'medGun', -60, 50)));
  assert(!down.events.some(x => x.heals || x.damages || x.carve) && m.terrain.holes.length === holes, 'ground shot does nothing ' + J(down.events));
  return { healed: expect };
});

await test('急救槍：瞄準預覽是直線、穿過敵人停在隊友身上；AI（敵人、斷線代打）不會拿它開火', () => {
  const m = matchWith({}, { players: 2, weapons: ['medGun', 'sniper'] });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  place(e1, p1, 70);
  place(p2, p1, 140);
  const pre = aimPreview(m.world, p1, W.medGun, aimAt(p1, p2), 50);
  assert(pre.kind === 'line' && pre.hit.type === 'entity' && pre.hit.entity === p2 && !pre.pierced.length, 'preview stops at the teammate ' + J(pre.hit.type));
  assert(preferredWeapon(p1, ['medGun', 'sniper']) === 'sniper' && preferredWeapon(p1, ['medGun', 'cannon']) === 'cannon', 'preferred weapon skips the med gun');
  const rng = new Rng(9);
  for (let k = 0; k < 20; k++) {
    const plan = planShot(m.world, p1, rng, ['medGun', 'sniper']);
    assert(plan && plan.weapon === 'sniper', 'AI plan ' + J(plan));
  }
  return { preview: pre.hit.type };
});

await test('急救槍：關著人的東西（heldId：囚籠、抱著人的熊、黏著人的網）擋得住——外面的隊友治不到裡面的人、被關的人射出去打在它上面；沒關人就跟一般敵人一樣穿過', () => {
  const m = matchWith({}, { players: 2, weapons: ['medGun', 'sniper'] });
  const [p1, p2] = m.players;
  place(p2, p1, 160);
  p1.hp = 100; p2.hp = 100;
  const cage = new Entity({ id: 'cage', name: '囚籠', team: 'enemies', controller: 'ai', x: p2.x, y: p2.y, hw: 22, h: 52, hp: 50, stamina: 0, fixed: true, heldId: 'p2' });
  m.entities.push(cage);
  const into = m.resolveShot(p1, 'medGun', aimAt(p1, p2), 50);
  const ev = into.events.find(x => x.type === 'explode');
  assert(ev && ev.target === 'cage' && !ev.heals && p2.hp === 100 && cage.hp === 50, 'the cage blocks the heal ' + J(into.events));
  const out = m.resolveShot(p2, 'medGun', aimAt(p2, p1), 50);
  const ev2 = out.events.find(x => x.type === 'explode');
  assert(ev2 && ev2.target === 'cage' && !ev2.heals && p1.hp === 100, 'the prisoner hits his own cage ' + J(out.events));
  cage.heldId = null;
  const free = m.resolveShot(p1, 'medGun', aimAt(p1, p2), 50);
  assert(free.events.some(x => x.heals && x.target === 'p2') && p2.hp > 100, 'an empty holder is passed like any enemy ' + J(free.events));
  return { blocked: ev.target };
});

await test('急救槍：調皮妖精魅惑時手上是急救槍 → 換成一般 AI 會拿的武器打隊友（不會變成幫他回血）', () => {
  const m = new Match({ levelId: 'forestFairy', players: mkPlayers(2), seed: 1, stage: 3, carry: { p1: carryOf({}, { weapons: ['medGun', 'sniper'] }), p2: carryOf({}) } });
  const p1 = m.byId('p1');
  p1.weapon = 'medGun';
  m.mechState.charm.p1 = { armed: true, used: false };
  const t = m.planAiTurn(p1);
  assert(t.plan && t.plan.weapon === 'sniper' && t.forced && t.forced.charm && t.forced.targetId === 'p2', 'forced plan ' + J(t));
  return { weapon: t.plan.weapon };
});

await test('急救槍：勝者為王的電腦玩家不拿（AI 不會用它）；只剩它可以拿才照樣拿', () => {
  const V = CONFIG.VERSUS;
  const players = [];
  let n = 0;
  for (const team of V.teams) for (let i = 0; i < V.teamSize; i++) players.push(n++ ? { id: `bot${n}`, name: `B${n}`, team, bot: true, connected: false } : { id: 'h1', name: 'H1', team });
  const v = new Versus({ players, seed: 7, io: new FakeIo(), cards: CARDS.cards });
  v.start();
  const bot = v.players.get('bot2');
  for (let k = 0; k < 12; k++) {
    Object.assign(v, { offers: { bot2: [cardById('med_gun'), cardById('caliber_up')] }, picks: {}, discards: {}, linkPicks: {} });
    v.botPick(bot);
    assert(v.picks.bot2 === 'caliber_up', 'bot took ' + v.picks.bot2);
  }
  Object.assign(v, { offers: { bot2: [cardById('med_gun')] }, picks: {} });
  v.botPick(bot);
  assert(v.picks.bot2 === 'med_gun', 'only choice: ' + v.picks.bot2);
  return { picked: 'caliber_up' };
});

// ---------------- 治療效率 ----------------

await test('治療效率：吸血、恩賜之杖、急救槍都乘上（生命增幅器 + 樂觀相加）；沒有牌的不變；狀態列顯示「治療效率 +N%」', () => {
  const pct = cardFx('life_amplifier').healRecvPct + cardFx('optimism').healRecvPct;
  const m = matchWith({ p1: { healRecvPct: pct, lifestealPct: 10, regenPct: 1 }, p2: { lifestealPct: 10, regenPct: 1 } }, { players: 2 });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  const k = 1 + pct / 100;
  p1.hp = 1000; p2.hp = 1000;
  m.lifesteal(p1, strike(m, p1, e1));
  m.lifesteal(p2, strike(m, p2, e1));
  assert(p1.hp === 1000 + Math.floor(10 * k + 1e-9) && p2.hp === 1010, `lifesteal: p1 ${p1.hp} p2 ${p2.hp}`);
  p1.hp = 1000; p2.hp = 1000;
  m.turnStartEffects(p1);
  m.turnStartEffects(p2);
  assert(p1.hp === 1000 + Math.floor(50 * k + 1e-9) && p2.hp === 1050, `regen: p1 ${p1.hp} p2 ${p2.hp}`);
  const chips = effectChips(p1, { match: m }).map(c => c.label);
  assert(chips.includes(`治療效率 +${pct}%`) && !effectChips(p2, { match: m }).some(c => /治療效率/.test(c.label)), 'chips ' + chips);
  return { pct };
});

await test('治療效率（選牌）：回血的牌（醫療包自己的、隊友給的）照被回血的人自己的效率；過關回血、加上限同時補的血不吃', () => {
  const pct = cardFx('life_amplifier').healRecvPct + cardFx('optimism').healRecvPct;
  const k = 1 + pct / 100;
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(3), seed: 4, io, cards: CARDS.cards });
  run.start();
  io.advance(2000);
  for (const id of ['p1', 'p3']) run.players.get(id).stats.healRecvPct = pct;   // p1、p3 有治療效率
  for (const id of ['p1', 'p2', 'p3']) run.match.byId(id).hp = 20;
  for (const e of run.match.enemies) e.die('hit');
  assert(until(io, () => run.phase === 'pick'), 'pick phase');
  run.offers.p1 = [cardById('medkit')];
  run.offers.p2 = [cardById('medkit')];
  run.offers.p3 = [cardById('iron_body')];
  const clear = Math.round(P * CONFIG.RUN.healPctOnClear);
  for (const id of ['p1', 'p2', 'p3']) assert(run.players.get(id).hp === 20 + clear, `clear heal is not boosted: ${id} ${run.players.get(id).hp}`);
  for (const id of ['p1', 'p2', 'p3']) run.handle(id, { t: 'pick', cardId: run.offers[id][0].id });
  const { heal: self, allyHeal: ally } = cardFx('medkit');
  const up = cardFx('iron_body').maxHp;
  const sum = io.take('picks').at(-1).summary;
  const hp = (id) => sum.find(s => s.playerId === id).hp;
  const start = 20 + clear;
  const exp1 = Math.min(P, Math.round(Math.min(P, Math.round(start + self * k)) + ally * k));
  const exp2 = Math.min(P, Math.min(P, start + self) + ally);
  const exp3 = Math.min(P + up, Math.round(Math.min(P + up, start + up) + 2 * ally * k));
  assert(hp('p1') === exp1 && hp('p2') === exp2 && hp('p3') === exp3, `p1 ${hp('p1')} (${exp1}) p2 ${hp('p2')} (${exp2}) p3 ${hp('p3')} (${exp3})`);
  return { p1: exp1, p2: exp2, p3: exp3 };
});

// ---------------- 知足 / 樂觀 ----------------

await test('知足：受到治療（急救槍、恩賜之杖，真的回到血）疊一層，吸血、滿血回 0 不算；上限；武器傷害照層數；客戶端重播帶層數、畫面飄字；下一關從 0 開始', () => {
  const { healedDamagePct: per, healedDamageMaxPct: max } = cardFx('contentment');
  const m = matchWith({ p2: { ...cardFx('contentment'), lifestealPct: 50, regenPct: 1 } }, { players: 2, weapons: ['medGun', 'sniper'] });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  place(p2, p1, 140);
  p2.hp = 100;
  const cm = clientOf(m);
  const before = stateOf(cm.byId('p2'));
  const shot = JSON.parse(J(m.resolveShot(p1, 'medGun', aimAt(p1, p2), 50)));
  assert(p2.healedStacks === 1 && Math.abs(m.damageMult(p2, W.cannon) - (1 + per / 100)) < 1e-12, 'one stack after the med gun: ' + p2.healedStacks);
  replayChecked(cm, shot, 'contentment');
  assert(cm.byId('p2').healedStacks === 1, 'the event state carries the stacks');
  const ops = watchFxOps(cm.byId('p2'), before);
  assert(ops.some(o => o[0] === 'float' && o[2] === `知足 +${per}%`), 'float ' + J(ops));
  // 吸血不算
  m.lifesteal(p2, strike(m, p2, e1));
  assert(p2.healedStacks === 1, 'lifesteal does not count');
  // 滿血：恩賜之杖回 0 不算；沒滿血才算
  p2.hp = p2.maxHp;
  m.turnStartEffects(p2);
  assert(p2.healedStacks === 1, 'healing 0 at full hp does not count');
  for (let i = 0; i < 20; i++) { p2.hp = 100; m.turnStartEffects(p2); }
  assert(p2.healedStacks === Math.ceil(max / per) && Math.abs(m.damageMult(p2, W.cannon) - (1 + max / 100)) < 1e-12, 'capped: ' + p2.healedStacks);
  const next = new Match({ levelId: 'level1', players: mkPlayers(2), seed: 2, carry: m.carry, config: CFG });
  assert(next.byId('p2').healedStacks === 0, 'a new stage starts from 0');
  return { stacks: p2.healedStacks };
});

await test('樂觀：血量在上限的 EQUIP.optimist.hpPct% 以上（含）武器傷害 +N%，低於就沒有；狀態列照著變', () => {
  const { healthyDamagePct: pct } = cardFx('optimism');
  const m = matchWith({ p1: cardFx('optimism') });
  const p1 = m.players[0];
  const cut = CONFIG.EQUIP.optimist.hpPct;
  p1.hp = Math.ceil(p1.maxHp * cut / 100);
  assert(Math.abs(m.damageMult(p1, W.cannon) - (1 + pct / 100)) < 1e-12, 'at the threshold: on');
  assert(effectChips(p1, { match: m }).some(c => c.label === `樂觀 +${pct}%`), 'chip on');
  p1.hp -= 1;
  assert(m.damageMult(p1, W.cannon) === 1, 'below: off');
  assert(effectChips(p1, { match: m }).some(c => c.label.startsWith('樂觀（')), 'chip greyed');
  return { pct, cut };
});

// ---------------- 人工心臟 ----------------
const heartFx = () => cardFx('artificial_heart');
const reviveHp = (e) => Math.max(1, Math.round(e.maxHp * heartFx().revivePct / 100));

await test('人工心臟：被打倒當場以上限 N% 復活（不算擊殺、這一下的燃燒 / 中毒 / 流血不上、記 revived）；第二次就真的倒下；狀態列', () => {
  const m = matchWith({ p1: heartFx() }, { hp: 200 });
  const p1 = m.players[0], e1 = m.enemies[0];
  p1.hp = 10;
  p1.burn = 40; p1.poison = 3; p1.bleed = 7; p1.entangle = 2;
  const chip0 = effectChips(p1, { match: m }).map(c => c.label);
  const d1 = strike(m, e1, p1, { poison: 5, bleed: 5 }, { burn: 20 });
  const entry = d1.find(d => d.id === 'p1');
  assert(p1.alive && p1.hp === reviveHp(p1) && p1.heartUsed === 1 && entry.revived && entry.dmg === 10, `revived: ${J(entry)} hp ${p1.hp}`);
  assert(p1.burn === 0 && p1.poison === 0 && p1.bleed === 0 && p1.entangle === 0 && !entry.burn && !entry.poison && !entry.bleed, 'statuses cleared ' + J(p1.toState()));
  assert(m.creditKills(e1, [p1]).length === 0 && e1.kills === 0 && p1.revives === 1 && p1.revival.cause === 'hit', 'not a kill');
  assert(chip0.includes('人工心臟 待命') && effectChips(p1, { match: m }).some(c => c.label === '人工心臟 已用過'), 'chips ' + chip0);
  p1.hp = 10;
  strike(m, e1, p1);
  assert(!p1.alive && p1.deathCause === 'hit' && m.creditKills(e1, [p1]).length === 1, 'the second time is for real: ' + J(p1.toState()));
  return { revivedAt: reviveHp(p1) };
});

await test('人工心臟（肉鴿流程）：整場冒險只有一次——第 1 關用掉之後收回玩家身上，第 2 關開打就是「已用過」（start 的 carry 帶著，客戶端建的角色也是），再倒下就真的倒下；沒用過的人第 2 關還是待命', () => {
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(2), seed: 21, io, cards: CARDS.cards });
  for (const id of ['p1', 'p2']) run.players.get(id).stats.revivePct = heartFx().revivePct;
  run.start();
  io.advance(2000);
  const a1 = run.match.byId('p1'), b1 = run.match.byId('p2');
  assert(a1.mods.revivePct > 0 && a1.heartUsed === 0 && b1.heartUsed === 0, 'stage 1 starts unused');
  a1.hp = 5;
  strike(run.match, run.match.enemies[0], a1);
  assert(a1.alive && a1.heartUsed === 1 && a1.hp === reviveHp(a1), 'revived in stage 1 ' + J(a1.toState()));
  for (const e of run.match.enemies) e.die('hit');
  assert(until(io, () => run.phase === 'pick'), 'pick phase');
  assert(run.players.get('p1').heartUsed === 1 && run.players.get('p2').heartUsed === 0, 'taken back onto the run players');
  for (const id of ['p1', 'p2']) run.handle(id, { t: 'pick', cardId: run.offers[id][0].id });
  assert(until(io, () => run.phase === 'battle' && run.stage === 2), 'stage 2');
  const a2 = run.match.byId('p1'), b2 = run.match.byId('p2');
  assert(a2.heartUsed === 1 && b2.heartUsed === 0, `stage 2: p1 ${a2.heartUsed}, p2 ${b2.heartUsed}`);
  const start = io.take('start').at(-1);
  assert(start && start.carry.p1.heartUsed === 1 && start.carry.p2.heartUsed === 0, 'start carry ' + J(start && start.carry.p1));
  const cm = new Match({ levelId: start.levelId, players: start.players, seed: start.seed, carry: start.carry, stage: start.stage });
  assert(cm.byId('p1').heartUsed === 1 && effectChips(cm.byId('p1'), { match: cm }).some(c => c.label === '人工心臟 已用過'), 'the client builds it used');
  a2.hp = 5;
  strike(run.match, run.match.enemies[0], a2);
  assert(!a2.alive && a2.heartUsed === 1, 'no second revive in stage 2: ' + J(a2.toState()));
  b2.hp = 5;
  strike(run.match, run.match.enemies[0], b2);
  assert(b2.alive && b2.heartUsed === 1 && b2.hp === reviveHp(b2), 'p2 still had it in stage 2');
  return { stage: run.stage };
});

await test('人工心臟（勝者為王）：整場對戰一次——選牌換裝（Match.refit）之後還是用過了，客戶端照 roundPicks 的 carry 換裝也一樣', () => {
  const V = CONFIG.VERSUS;
  const players = [];
  let n = 0;
  for (const team of V.teams) for (let i = 0; i < V.teamSize; i++) players.push(n++ ? { id: `bot${n}`, name: `B${n}`, team, bot: true, connected: false } : { id: 'h1', name: 'H1', team });
  const io = new FakeIo();
  const v = new Versus({ players, seed: 7, io, cards: CARDS.cards });
  v.start();
  v.match.planAiTurn = () => ({ walk: null, plan: null });
  v.players.get('h1').stats.revivePct = heartFx().revivePct;
  const h = v.match.byId('h1');
  h.mods.revivePct = heartFx().revivePct;
  const foe = v.match.players.find(e => e.team !== h.team);
  h.hp = 5;
  strike(v.match, foe, h);
  assert(h.alive && h.heartUsed === 1, 'revived ' + J(h.toState()));
  const start = io.take('start').at(-1);
  const cm = new Match({ levelId: start.levelId, players: start.players, seed: start.seed, carry: start.carry || {}, stage: start.stage || 1 });
  cm.applySnapshot(JSON.parse(J(v.match.snapshot())));
  assert(cm.byId('h1').heartUsed === 1, 'client snapshot has it used');
  assert(until(io, () => v.phase === 'pick', 600_000), 'pick');
  v.handle('h1', { t: 'pick', cardId: v.offers.h1[0].id });
  assert(until(io, () => v.phase === 'battle', 600_000), 'back to battle');
  const picks = io.take('roundPicks').at(-1);
  assert(picks && picks.carry && picks.carry.h1 && picks.carry.h1.heartUsed === 1, 'roundPicks carry ' + J(picks && picks.carry && picks.carry.h1));
  assert(v.match.byId('h1').heartUsed === 1, 'still used after the refit');
  cm.refit(cm.byId('h1'), picks.carry.h1);
  assert(cm.byId('h1').heartUsed === 1, 'client refit keeps it used');
  const h2 = v.match.byId('h1');
  h2.hp = 5;
  strike(v.match, v.match.players.find(e => e.team !== h2.team && e.alive), h2);
  assert(!h2.alive, 'no second revive in the same versus game');
  return { round: v.match.round };
});

await test('人工心臟：連結分到的那份把人打倒也算；同一波（伺服器開火）裡救回來、客戶端重播一致（事件帶效果的狀態）；畫面演復活', () => {
  const m = matchWith({ p2: heartFx() }, { players: 2, hp: 40, weapons: ['sniper', 'cannon'] });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  place(p2, p1, 140);
  p2.hp = 1;
  const cm = clientOf(m);
  const before = stateOf(cm.byId('p2'));
  const shot = JSON.parse(J(m.resolveShot(p1, 'sniper', aimAt(p1, p2), 50)));   // 誤傷打倒 p2
  const ev = shot.events.find(x => x.damages && x.damages.some(d => d.id === 'p2'));
  assert(ev && ev.damages.find(d => d.id === 'p2').revived && p2.alive && p2.hp === reviveHp(p2), 'revived by friendly fire ' + J(ev));
  let aliveThroughout = true;
  replayChecked(cm, shot, 'heart replay', { event: () => { if (!cm.byId('p2').alive) aliveThroughout = false; } });
  assert(aliveThroughout && cm.byId('p2').heartUsed === 1, 'the client never sees p2 die, and knows the heart is used');
  cm.applyEntities(shot.results);
  sameEntities(m, cm, 'heart');
  const ops = watchFxOps(cm.byId('p2'), before);
  assert(ops.some(o => o[0] === 'banner' && o[1].includes('人工心臟')) && ops.some(o => o[0] === 'float' && o[2] === '復活！'), 'revive show ' + J(ops));
  // 連結：p1 被打、分到的那份把 p2 打倒
  const l = matchWith({ p2: heartFx() }, { players: 2, hp: 40 });
  const [q1, q2] = l.players;
  q1.links = ['p2']; q2.links = ['p1'];
  q2.hp = 1;
  const dl = strike(l, l.enemies[0], q1, { damage: 20 });
  const shared = dl.find(d => d.id === 'p2');
  assert(shared && shared.shared === 'p1' && shared.revived && q2.alive && q2.hp === reviveHp(q2), 'shared damage revive ' + J(dl));
  return { hp: p2.hp };
});

await test('人工心臟：淹死 → 回到最後站穩的地方（不再扣落水的血、splash 記 revived）；毒倒（回合開始）、燒死（回合結束）、流血倒下都救得回來，fx 記 revive、毒不再鎖上限', () => {
  const m = matchWith({ p1: heartFx() }, { hp: 100 });
  const p1 = m.players[0];
  const sx = p1.safeX, sy = p1.safeY;
  p1.hp = 1;
  p1.y = CONFIG.WATER_LEVEL + 5;
  p1.fallInWater(m.terrain);
  assert(p1.alive && p1.hp === reviveHp(p1) && p1.x === sx && p1.y === sy && p1.splash.revived && !p1.splash.died, 'water ' + J(p1.splash));
  // 毒倒
  const a = matchWith({ p1: heartFx() }, { hp: 100 });
  const q = a.players[0];
  q.hp = 1; q.poison = 50;
  const fx = a.turnStartEffects(q);
  assert(q.alive && q.hp === reviveHp(q) && q.poison === 0 && q.poisonLock === 0 && q.maxHp === 100, 'poison ' + J(q.toState()));
  assert(fx.some(f => f.type === 'poison' && !f.died) && fx.some(f => f.type === 'revive' && f.id === 'p1' && f.cause === 'hit'), 'fx ' + J(fx));
  // 燒死
  const b = matchWith({ p1: heartFx() }, { hp: 100 });
  const r = b.players[0];
  r.hp = 1; r.burn = 100;
  const fx2 = b.endTurn(r);
  assert(r.alive && r.hp === reviveHp(r) && r.burn === 0 && fx2.some(f => f.type === 'revive'), 'burn ' + J(fx2));
  // 流血（走路）
  const c = matchWith({ p1: heartFx() }, { hp: 100 });
  const s = c.players[0];
  s.hp = 3; s.bleed = 50;
  s.bleedFor(100);
  assert(s.alive && s.hp === reviveHp(s) && s.bleed === 0 && s.revival.cause === 'bleed', 'bleed ' + J(s.toState()));
  return { water: [sx, sy] };
});

await test('人工心臟（裁判）：行動玩家回報流血倒下（hp 0）→ 伺服器一樣救回來、回合繼續、紀錄 revived、轉給別人的 move 帶救回來的狀態', () => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'level1', players, seed: 1, carry: { p1: carryOf(heartFx(), { hp: 300 }), p2: carryOf({}, { hp: 300 }) } });
  for (const e of m.enemies) { e.hp = e.maxHp = 300; }
  m.planAiTurn = () => ({ walk: null, plan: null });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  const p1 = m.byId('p1');
  p1.bleed = 30;
  ref.handle('p1', { t: 'move', x: p1.x + 2, y: p1.y, facing: 1, stamina: p1.stamina, hp: 0 });
  assert(p1.alive && p1.hp === reviveHp(p1) && p1.bleed === 0 && ref.phase === 'turn' && ref.currentId === 'p1', `server: ${J(p1.toState())} phase ${ref.phase}`);
  const rec = io.recs('move').at(-1);
  assert(rec && rec.revived && rec.bled === 300, 'move record ' + J(rec));
  const relay = io.take('move').at(-1);
  assert(relay && relay._except === 'p1' && relay.hp === p1.hp && relay.revive && relay.revive.hp === p1.hp && relay.revive.ht === 1, 'relay ' + J(relay));
  assert(!io.recs('turn.skip').length, 'the turn goes on');
  return { hp: p1.hp };
});

await test('人工心臟：斷線代打 / 電腦玩家試走時，分身走到流血倒下又被救回來的路線不選（不替他把整場一次的復活用掉，跟沒有這張牌時一樣站著）', () => {
  const saved = CONFIG.AI_MOVE.takeoverChance;
  CONFIG.AI_MOVE.takeoverChance = 1;
  try {
    let walked = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const m = matchWith({ p1: heartFx() }, { players: 2, seed, hp: 150 });
      const p1 = m.players[0];
      p1.hp = 20;
      p1.bleed = 2000;
      const w = planWalk(m, p1);
      if (w) walked++;
      assert(p1.alive && p1.heartUsed === 0 && p1.hp === 20 && p1.revives === 0, `seed ${seed}: ${J(p1.toState())} walk ${J(w)}`);
    }
    return { walked };
  } finally {
    CONFIG.AI_MOVE.takeoverChance = saved;
  }
});

await test('人工心臟 + 攜手之伴：同一下自己被打到又分到隊友的份，先加起來一次扣——救回來的血量、狀態跟角色的排列順序無關', () => {
  const blast = (swap) => {
    const m = matchWith({ p2: heartFx() }, { players: 2, hp: 200 });
    const [p1, p2] = m.players, e1 = m.enemies[0];
    p1.links = ['p2']; p2.links = ['p1'];
    place(p2, p1, 40);
    if (swap) {
      const i = m.entities.indexOf(p1), j = m.entities.indexOf(p2);
      [m.entities[i], m.entities[j]] = [m.entities[j], m.entities[i]];
    }
    p2.hp = 10;
    const d = m.applyExplosion((p1.cx + p2.cx) / 2, p1.cy, { ...W.cannon, damage: 40, knockback: 0, radius: 120 }, e1, null, { burn: 10 });
    // 各筆實際扣到多少照原本的順序分（只保證總數跟順序無關，同沒有這張牌的時候），所以比總數與 revived
    const mine = d.filter(z => z.id === 'p2');
    return { p1: p1.hp, p2: p2.hp, alive: p2.alive, ht: p2.heartUsed, burn: p2.burn, total: mine.reduce((n, z) => n + z.dmg, 0), revived: mine.every(z => z.revived), pieces: mine.length };
  };
  const a = blast(false), b = blast(true);
  const want = Math.max(1, Math.round(200 * heartFx().revivePct / 100));
  assert(J(a) === J(b) && a.alive && a.ht === 1 && a.p2 === want && a.burn === 0, `order matters: ${J(a)} vs ${J(b)}`);
  assert(a.revived && a.pieces === 2 && a.total === 10, 'own hit + shared piece, both marked revived, the real damage is what he had ' + J(a));
  return a;
});

await test('人工心臟（裁判）：流血倒下的 hp 0 回報位置被擋下（瞬移）也照樣救回來、記在 move.reject、轉給別人', () => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'level1', players, seed: 1, carry: { p1: carryOf(heartFx(), { hp: 300 }), p2: carryOf({}, { hp: 300 }) } });
  for (const e of m.enemies) { e.hp = e.maxHp = 300; }
  m.planAiTurn = () => ({ walk: null, plan: null });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  ref.start();
  assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  const p1 = m.byId('p1');
  p1.bleed = 30;
  const x0 = p1.x;
  ref.handle('p1', { t: 'move', x: p1.x + 900, y: p1.y, facing: 1, stamina: p1.stamina, hp: 0 });
  assert(p1.alive && p1.hp === reviveHp(p1) && p1.x === x0 && ref.phase === 'turn', 'revived, position kept ' + J(p1.toState()));
  const rec = io.recs('move.reject').at(-1);
  assert(rec && rec.revived && rec.bled === 300, 'move.reject record ' + J(rec));
  const relay = io.take('move').at(-1);
  assert(relay && relay._except === 'p1' && relay.x === x0 && relay.revive && relay.revive.ht === 1 && relay.hp === p1.hp, 'relay ' + J(relay));
  return { hp: p1.hp };
});

// ---- 真的 GameView（Node 裡、假 canvas；同 test/bleed.js）----
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
function newView(myId) {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = myId;
  view.transport = { send() {} };
  view.banners = [];
  const show = view.showBanner.bind(view);
  view.showBanner = (str, ...rest) => { view.banners.push(str); show(str, ...rest); };
  return view;
}
const feed = (view, msgs) => { for (const { _except, ...msg } of msgs) if (_except !== view.myId) view.onMessage(JSON.parse(J(msg))); };
const idle = (view) => !view.script && !view.queue.length;
const drain = (view, n = 3000) => { for (let f = 0; f < n && !idle(view); f++) { view.update(STEP); view.render(); } };

await test('真的 GameView：自己的回合走路流血倒下 → 自己的畫面先用人工心臟救回來、回報一次 hp 0 → 伺服器一樣救回來，血量對得上、回合繼續；兩邊的畫面都演「人工心臟啟動」', () => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'level1', players, seed: 1, carry: { p1: { ...carryOf(heartFx(), { hp: 300 }), maxStamina: 5000 }, p2: carryOf({}, { hp: 300 }) } });
  for (const e of m.enemies) { e.hp = e.maxHp = 300; }
  m.byId('p1').bleed = 50;   // 300 血：每 px 1.5 點 → 走 200px 倒下（還沒走到崖邊）
  m.planAiTurn = () => ({ walk: null, plan: null });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  const me = newView('p1'), other = newView('p2');
  const sent = [];
  me.transport = { send: (msg) => { sent.push(JSON.parse(J(msg))); ref.handle('p1', JSON.parse(J(msg))); } };
  ref.start();
  const pump = () => { const msgs = io.log.splice(0); feed(me, msgs); feed(other, msgs); };
  assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  pump();
  drain(me); drain(other);
  const mine = me.me;
  assert(me.canAct && mine.bleed === 50 && mine.mods.revivePct > 0, 'my turn, bleeding, with the heart');
  me.keys.KeyD = true;
  let k = 0;
  for (; k < 400 && !mine.heartUsed; k++) { me.update(STEP); me.render(); other.update(STEP); other.render(); pump(); }
  me.keys.KeyD = false;
  for (let f = 0; f < 30; f++) { me.update(STEP); other.update(STEP); pump(); }
  const sp = m.byId('p1');
  assert(mine.heartUsed === 1 && mine.alive && mine.bleed === 0 && mine.revival.cause === 'bleed', `client revived at frame ${k}: ${J(mine.toState())}`);
  assert(sent.filter(s => s.hp === 0).length === 1, 'reported the fall once: ' + J(sent.filter(s => s.hp === 0)));
  assert(sp.alive && sp.heartUsed === 1 && sp.hp === mine.hp && sp.bleed === 0 && me.canAct && ref.phase === 'turn', `server ${J(sp.toState())} vs client hp ${mine.hp}`);
  assert(!io.recs('turn.skip').length && io.recs('move').some(r => r.revived), 'no skip, logged');
  const seen = other.match.byId('p1');
  assert(seen.alive && seen.hp === sp.hp && seen.heartUsed === 1, `other screen: ${J(seen.toState())}`);
  assert(me.banners.some(b => b.includes('人工心臟')) && other.banners.some(b => b.includes('人工心臟')), 'banners ' + J({ me: me.banners, other: other.banners }));
  assert(!me.banners.some(b => /失血倒下/.test(b)), 'no death banner');
  return { frame: k, hp: sp.hp };
});

await test('真的 GameView：流血倒下被救回來跟掉進水裡在同一幀——先送倒下的 hp 0、再送落水，伺服器跟自己的畫面血量一樣、回合繼續', () => {
  const players = mkPlayers(2);
  const m = new Match({ levelId: 'level1', players, seed: 1, carry: { p1: { ...carryOf(heartFx(), { hp: 150 }), maxStamina: 5000 }, p2: carryOf({}, { hp: 150 }) } });
  for (const e of m.enemies) { e.hp = e.maxHp = 300; }
  m.planAiTurn = () => ({ walk: null, plan: null });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io });
  const me = newView('p1'), other = newView('p2');
  const sent = [];
  me.transport = { send: (msg) => { sent.push(JSON.parse(J(msg))); ref.handle('p1', JSON.parse(J(msg))); } };
  ref.start();
  const pump = () => { const msgs = io.log.splice(0); feed(me, msgs); feed(other, msgs); };
  assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  pump();
  drain(me); drain(other);
  const mine = me.me, sp = m.byId('p1');
  // 兩邊擺成一樣：崖邊往下掉、只剩 1 血、流血的小數差一點就滿 1 點（下一步一走就流血倒下，同一幀接著掉進水裡）
  const safe = { safeX: mine.safeX, safeY: mine.safeY };
  for (const e of [mine, sp]) Object.assign(e, { x: 420, y: 649, vy: 400, vx: 0, hp: 1, bleed: 50, onGround: false, ...safe });
  mine.bleedFrac = 0.999;
  me.keys.KeyD = true;
  const falls = mine.waterFalls;
  me.update(STEP);
  me.keys.KeyD = false;
  assert(mine.waterFalls === falls + 1 && mine.revival && mine.revival.cause === 'bleed' && mine.alive, 'same frame: bled out, revived, fell in ' + J(mine.toState()));
  const order = sent.slice(-2).map(x => (x.hp === 0 ? 'fall' : x.safe ? 'water' : 'move'));
  assert(J(order) === J(['fall', 'water']), 'the hp-0 report goes first: ' + J(sent.slice(-2)));
  for (let k = 0; k < 20; k++) { me.update(STEP); other.update(STEP); pump(); }
  assert(sp.alive && sp.hp === mine.hp && sp.heartUsed === 1 && mine.hp === reviveHp(mine) - Math.round(mine.maxHp * CONFIG.WATER.damagePct / 100), `server ${sp.hp} vs client ${mine.hp}`);
  assert(ref.phase === 'turn' && me.canAct && !io.recs('turn.skip').length, 'the turn goes on');
  return { hp: sp.hp };
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
