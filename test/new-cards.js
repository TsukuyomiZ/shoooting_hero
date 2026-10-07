// node test/new-cards.js
// 2026-10-01 新增的牌：醫療包、腎上腺素、蹦蹦炸彈、口徑強化、孤狼傳說、團結力量大、攜手之伴，以及等離子飛彈改成每發 30。
// 血量一律自己設（不受 config 影響），數值照 cards.json / config 現在的設定算
import fs from 'node:fs';
import { CONFIG } from '../shared/config.js';
import { Match } from '../shared/match.js';
import { Run } from '../shared/run.js';
import { Rng } from '../shared/rng.js';
import { planShot } from '../shared/ai.js';
import { replayChecked } from './replay-check.js';
import { validateCards, drawOffers, baseStats, derivePlayerStats } from '../shared/cards.js';
import { makeProjectile, simulateShot, shotTraits, aimPreview } from '../shared/weapons.js';

// 這裡的測試照武器原本傷害算敵人的攻擊；敵人傷害倍率（ENEMY.damageMult / damageMultLate）在 headless.js 另有專門測試
CONFIG.ENEMY.damageMult = 1;
CONFIG.ENEMY.damageMultLate = 1;

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

class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.seq = 0; }
  broadcast(msg, exceptId) { this.log.push({ ...msg, _except: exceptId }); }
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
}
function advanceUntil(io, pred, maxMs = 300_000) {
  const start = io.t;
  while (io.t - start < maxMs) {
    io.advance(100);
    if (pred()) return true;
  }
  return false;
}

const CARDS = validateCards(JSON.parse(fs.readFileSync(new URL('../shared/cards.json', import.meta.url), 'utf8')));
const cardById = (id) => CARDS.cards.find(c => c.id === id);
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const P = CONFIG.PLAYER.hp;
const W = CONFIG.WEAPONS;

// p1 帶指定效果的測試戰鬥；所有人血量拉到 hp
function matchWith(effects = {}, { players = 1, levelId = 'level1', seed = 1, weapons, hp = 5000 } = {}) {
  const stats = baseStats();
  for (const [k, v] of Object.entries(effects)) stats[k] += v;
  const d = derivePlayerStats(stats);
  const carry = { p1: { hp, maxHp: hp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed, size: d.size, mods: d.mods, weapons } };
  const m = new Match({ levelId, players: mkPlayers(players), seed, carry });
  for (const e of m.entities) { e.maxHp = hp; e.hp = hp; }
  return m;
}
// 兩兩互相連結（跟肉鴿流程帶進來的一樣是雙向的）
function link(m, a, b) {
  const A = m.byId(a), B = m.byId(b);
  if (!A.links.includes(b)) A.links.push(b);
  if (!B.links.includes(a)) B.links.push(a);
}
// 讓 Run 進入選牌階段並換成指定的牌（跳過戰鬥）
function toPickPhase(io, run, offersById) {
  for (const e of run.match.enemies) e.die('hit');
  assert(advanceUntil(io, () => run.phase === 'pick'), 'should reach pick phase');
  for (const [pid, ids] of Object.entries(offersById)) run.offers[pid] = ids.map(cardById);
}
const toBattle = (io, run, stage) => assert(advanceUntil(io, () => run.phase === 'battle' && run.stage === stage), 'stage ' + stage + ' should start');

// 伺服器結算一發、客戶端照事件重播，所有角色的結果要一樣
function assertReplayMatches(m, players, fire, label) {
  const cm = new Match({ levelId: m.levelId, players: mkPlayers(players), seed: m.seed, carry: m.carry });
  cm.applySnapshot(m.snapshot());
  for (const e of m.entities) { const c = cm.byId(e.id); c.maxHp = e.maxHp; c.links = e.links.slice(); }
  const shot = JSON.parse(JSON.stringify(fire(m)));
  replayChecked(cm, shot, label);
  for (const s of shot.results) {
    const e = cm.byId(s.id);
    assert(e.x === s.x && e.y === s.y && e.hp === s.hp && e.alive === s.alive, `${label}: ${s.id} client ${e.x},${e.y},${e.hp},${e.alive} vs server ${s.x},${s.y},${s.hp},${s.alive}`);
  }
  assert(Buffer.compare(Buffer.from(cm.terrain.mask), Buffer.from(m.terrain.mask)) === 0, label + ': terrain differs');
  return shot;
}

// ---------- 牌庫 ----------

test('新牌都載入了、沒有警告；蹦蹦炸彈只對大砲有用；團結力量大 / 攜手之伴是多人限定，醫療包 / 孤狼傳說不是；等離子飛彈的說明跟 config 的傷害一致', () => {
  assert(CARDS.warnings.length === 0, 'warnings: ' + CARDS.warnings.join('; '));
  const ids = ['medkit', 'adrenaline', 'bouncy_bomb', 'caliber_up', 'lone_wolf', 'unity', 'bond'];
  for (const id of ids) assert(cardById(id), 'missing card ' + id);
  const rarity = Object.fromEntries(ids.map(id => [id, cardById(id).rarity]));
  assert(JSON.stringify(rarity) === JSON.stringify({ medkit: 'white', adrenaline: 'white', bouncy_bomb: 'green', caliber_up: 'green', lone_wolf: 'purple', unity: 'purple', bond: 'gold' }), 'rarities ' + JSON.stringify(rarity));
  assert(cardById('bouncy_bomb').requires === 'cannon' && cardById('caliber_up').requires === null, 'bouncy bomb needs a cannon');
  assert(cardById('unity').teamOnly && cardById('bond').teamOnly, 'unity / bond are team-only');
  assert(!cardById('medkit').teamOnly && !cardById('lone_wolf').teamOnly && !cardById('adrenaline').teamOnly, 'medkit / lone wolf / adrenaline also work solo');
  assert(cardById('bond').unique, 'bond is unique');
  assert(cardById('plasma').desc.includes(`每發傷害 ${W.plasma.damage}`), `plasma card text says ${W.plasma.damage} per missile: ${cardById('plasma').desc}`);
  // 攜手之伴的減傷在 config，牌面的字要跟著改
  assert(cardById('bond').desc.includes(`${CONFIG.EQUIP.link.damageCutPct}%`), `bond card text matches EQUIP.link.damageCutPct: ${cardById('bond').desc}`);
  return { plasmaDamage: W.plasma.damage, linkCut: CONFIG.EQUIP.link.damageCutPct };
});

test('抽牌：單人不出多人限定的牌；沒有能連結的隊友就不出攜手之伴；多人、有隊友可連時才會出', () => {
  const rng = new Rng(7);
  let bondSeen = 0, unitySeen = 0;
  for (let i = 0; i < 3000; i++) {
    const solo = drawOffers(CARDS.cards, rng, 9, 3, [], ['cannon', 'sniper'], { solo: true, linkTargets: 0 });
    assert(!solo.some(c => c.teamOnly), 'team-only card offered solo: ' + solo.map(c => c.id));
    const noTarget = drawOffers(CARDS.cards, rng, 9, 3, [], ['cannon', 'sniper'], { solo: false, linkTargets: 0 });
    assert(!noTarget.some(c => c.id === 'bond'), 'bond offered with nobody left to link');
    const team = drawOffers(CARDS.cards, rng, 9, 3, [], ['cannon', 'sniper'], { solo: false, linkTargets: 2 });
    bondSeen += team.some(c => c.id === 'bond');
    unitySeen += team.some(c => c.id === 'unity') + noTarget.some(c => c.id === 'unity');
  }
  assert(bondSeen > 0 && unitySeen > 0, `team cards do show up in multiplayer (bond ${bondSeen}, unity ${unitySeen})`);
  const noCannon = drawOffers(CARDS.cards, rng, 9, 40, [], ['sniper', 'plasma']);
  assert(!noCannon.some(c => c.id === 'bouncy_bomb'), 'bouncy bomb offered without a cannon');
  return { bondSeen, unitySeen };
});

// ---------- 白 ----------

test('醫療包：自己回 15、每位活著的隊友回 10（等大家的牌都套完才算、不超過上限、倒下的不回）；兩個人都拿會互相加', () => {
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(3), seed: 4, io, cards: CARDS.cards });
  run.start();
  io.advance(2000);
  run.match.byId('p1').hp = 20;
  run.match.byId('p2').hp = 30;
  run.match.byId('p3').die('hit');
  toPickPhase(io, run, { p1: ['medkit'], p2: ['medkit'], p3: ['caliber_up'] });
  for (const id of ['p1', 'p2', 'p3']) run.handle(id, { t: 'pick', cardId: run.offers[id][0].id });
  const { heal: self, allyHeal: ally } = cardById('medkit').effects;
  const clear = Math.round(P * CONFIG.RUN.healPctOnClear);
  const sum = io.take('picks').at(-1).summary;
  const hp = (id) => sum.find(s => s.playerId === id).hp;
  const exp1 = Math.min(P, 20 + clear + self + ally), exp2 = Math.min(P, 30 + clear + self + ally);
  assert(hp('p1') === exp1 && hp('p2') === exp2, `medkit: p1 ${hp('p1')} (exp ${exp1}), p2 ${hp('p2')} (exp ${exp2})`);
  assert(hp('p3') === 0, 'a fallen teammate is not healed (revives next stage anyway)');

  // 單人：只回自己
  const io2 = new FakeIo();
  const solo = new Run({ players: mkPlayers(1), seed: 5, io: io2, cards: CARDS.cards });
  solo.start();
  io2.advance(2000);
  solo.match.byId('p1').hp = 10;
  toPickPhase(io2, solo, { p1: ['medkit'] });
  solo.handle('p1', { t: 'pick', cardId: 'medkit' });
  const soloHp = io2.take('picks').at(-1).summary[0].hp;
  assert(soloHp === Math.min(P, 10 + clear + self), 'solo medkit heals only yourself: ' + soloHp);

  // 回到滿血就停：隊友快滿血時不會超過上限
  const io3 = new FakeIo();
  const full = new Run({ players: mkPlayers(2), seed: 6, io: io3, cards: CARDS.cards });
  full.start();
  io3.advance(2000);
  full.match.byId('p1').hp = 20;
  full.match.byId('p2').hp = P - 1;
  toPickPhase(io3, full, { p1: ['medkit'], p2: ['caliber_up'] });
  full.handle('p1', { t: 'pick', cardId: 'medkit' });
  full.handle('p2', { t: 'pick', cardId: 'caliber_up' });
  const s2 = io3.take('picks').at(-1).summary.find(s => s.playerId === 'p2');
  assert(s2.hp === P && s2.maxHp === P, `ally heal capped at max: ${s2.hp}/${s2.maxHp}`);
  return { p1: exp1, p2: exp2, solo: soloHp };
});

test('腎上腺素：只在下一關生效（武器傷害 +50%、血量上限 +100 並回 100），那一關打完就失效（超過上限的血扣掉），再下一關沒有', () => {
  const { nextDamagePct: dmgPct, nextMaxHp: up } = cardById('adrenaline').effects;
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(1), seed: 11, io, cards: CARDS.cards });
  run.start();
  io.advance(2000);
  const e1 = run.match.byId('p1');
  assert(e1.mods.stageDamagePct === 0 && e1.maxHp === P, 'no boost before picking it');
  toPickPhase(io, run, { p1: ['adrenaline'] });
  run.handle('p1', { t: 'pick', cardId: 'adrenaline' });
  toBattle(io, run, 2);
  const e2 = run.match.byId('p1');
  assert(e2.maxHp === P + up && e2.hp === P + up, `stage 2: max ${e2.maxHp} hp ${e2.hp}, expected ${P + up} / ${P + up}`);
  assert(e2.mods.stageDamagePct === dmgPct && Math.abs(run.match.damageMult(e2, W.cannon) - (1 + dmgPct / 100)) < 1e-12, 'stage 2 weapon damage +' + dmgPct + '%');
  assert(run.match.damageMult(e2, W.bombard) === 1, 'equipment attacks (bombard) do not get weapon bonuses');
  // 開局帶進來的 carry 也有（客戶端用它建 Match，HUD 才看得到）
  const start = io.take('start').at(-1);
  assert(start.carry.p1.maxHp === P + up && start.carry.p1.mods.stageDamagePct === dmgPct, 'start payload carries the boost');
  // 打完第 2 關：血滿的話扣回原本的上限（過關回血也是照原本的上限）
  e2.hp = e2.maxHp;
  toPickPhase(io, run, { p1: ['caliber_up'] });
  assert(run.players.get('p1').hp === P, 'boost expired: hp clamped back to ' + P + ', got ' + run.players.get('p1').hp);
  run.handle('p1', { t: 'pick', cardId: 'caliber_up' });
  toBattle(io, run, 3);
  const e3 = run.match.byId('p1');
  assert(e3.maxHp === P && e3.mods.stageDamagePct === 0, `stage 3: no boost (max ${e3.maxHp}, stage dmg ${e3.mods.stageDamagePct})`);
  return { stage2: { maxHp: e2.maxHp, dmg: dmgPct }, stage3MaxHp: e3.maxHp };
});

test('腎上腺素：倒下的人拿了，下一關先照原本的上限復活，再加上限、回血；沒滿血的人失效時血量不變', () => {
  const { nextMaxHp: up } = cardById('adrenaline').effects;
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(2), seed: 12, io, cards: CARDS.cards });
  run.start();
  io.advance(2000);
  run.match.byId('p2').die('hit');
  toPickPhase(io, run, { p1: ['adrenaline'], p2: ['adrenaline'] });
  run.handle('p1', { t: 'pick', cardId: 'adrenaline' });
  run.handle('p2', { t: 'pick', cardId: 'adrenaline' });
  toBattle(io, run, 2);
  const p2 = run.match.byId('p2');
  const revive = Math.round(P * CONFIG.RUN.reviveHpPct);
  assert(p2.alive && p2.maxHp === P + up && p2.hp === revive + up, `revived p2: ${p2.hp}/${p2.maxHp}, expected ${revive + up}/${P + up}`);
  const p1 = run.match.byId('p1');
  p1.hp = 40;   // 沒超過原本上限：失效時不扣
  toPickPhase(io, run, { p1: ['caliber_up'], p2: ['caliber_up'] });
  const clear = Math.round(P * CONFIG.RUN.healPctOnClear);
  assert(run.players.get('p1').hp === Math.min(P, 40 + clear), 'hp below the old cap is kept: ' + run.players.get('p1').hp);
  return { p2: `${p2.hp}/${p2.maxHp}` };
});

// ---------- 綠 ----------

test('蹦蹦炸彈：大砲砲彈打到地形彈射一次再爆炸（沒有這張牌直接爆炸）；只有大砲會彈；預覽 / AI 試射照彈射後的落點；客戶端重播一致', () => {
  const plain = matchWith({});
  const p0 = plain.resolveShot(plain.players[0], 'cannon', 70, 30).events;
  assert(p0.length === 1 && p0[0].type === 'explode' && !p0[0].target, 'plain cannon explodes on the ground: ' + p0.map(e => e.type));

  const m = matchWith({ cannonBounce: 1 });
  const ev = m.resolveShot(m.players[0], 'cannon', 70, 30).events;
  assert(ev[0].type === 'bounce' && !ev[0].carve && !ev[0].damages, 'first contact bounces without blowing up: ' + JSON.stringify(ev[0]));
  assert(ev.filter(e => e.type === 'bounce').length === 1 && ['explode', 'water', 'out'].includes(ev.at(-1).type), 'only one bounce: ' + ev.map(e => e.type));
  assert(Math.abs(ev[0].x - p0[0].x) < 3, `bounces where the plain shell would have exploded (${ev[0].x.toFixed(1)} vs ${p0[0].x.toFixed(1)})`);

  // 彈射後還是會打到人：45° / 40 彈了一下之後炸在 e1 身上
  const hitM = matchWith({ cannonBounce: 1 });
  const hitEv = hitM.resolveShot(hitM.players[0], 'cannon', 45, 40).events;
  assert(hitEv[0].type === 'bounce' && hitEv.at(-1).type === 'explode' && hitEv.at(-1).target === 'e1', 'bounce then hits e1: ' + hitEv.map(e => e.type + ':' + (e.target || '')));

  // 其他武器不受影響
  const pl = matchWith({ cannonBounce: 1 }, { weapons: ['plasma'] });
  assert(!pl.resolveShot(pl.players[0], 'plasma', 70, 30).events.some(e => e.type === 'bounce'), 'plasma does not bounce');
  const sn = matchWith({ cannonBounce: 1 });
  assert(sn.resolveShot(sn.players[0], 'sniper', -15, 100).events[0].type === 'explode', 'sniper does not bounce');
  assert(shotTraits(m.players[0], 'cannon').bounces === 1 && shotTraits(m.players[0], 'plasma').bounces === 0 && shotTraits(m.players[0], 'sniper').bounces === 0, 'shotTraits');

  // 預覽 / AI 用的試射跟實際結算的落點一樣
  for (const [a, pw] of [[70, 30], [40, 55], [45, 40]]) {
    const s = matchWith({ cannonBounce: 1 });
    const sim = simulateShot(s.world, s.players[0], W.cannon, a, pw, 6, 0, shotTraits(s.players[0], 'cannon'));
    const last = s.resolveShot(s.players[0], 'cannon', a, pw).events.at(-1);
    assert(Math.abs(sim.hit.x - last.x) < 1e-6 && Math.abs(sim.hit.y - last.y) < 1e-6, `${a}/${pw}: simulateShot ends at ${sim.hit.x.toFixed(1)},${sim.hit.y.toFixed(1)} vs server ${last.x.toFixed(1)},${last.y.toFixed(1)}`);
  }
  // 代打的 AI：試射要照彈射後的落點算。目標躲在炸不壞的碉堡裡（打不到本人，只能靠落點炸）：
  // 沒有瞄準誤差時，AI 挑的那一發「照彈射算」的落點，一定是整個掃描範圍裡最好的那一發
  {
    const ai = matchWith({ cannonBounce: 1 }, { weapons: ['cannon'] });
    const shooter = ai.players[0];
    const target = ai.enemies[0];
    ai.enemies[1].die('hit');
    const { x, y } = target;
    for (const poly of [
      [[x - 46, y - 80], [x + 46, y - 80], [x + 46, y - 70], [x - 46, y - 70]],   // 屋頂
      [[x - 46, y - 80], [x - 36, y - 80], [x - 36, y + 4], [x - 46, y + 4]],     // 左牆
      [[x + 36, y - 80], [x + 46, y - 80], [x + 46, y + 4], [x + 36, y + 4]],     // 右牆
    ]) ai.terrain.fillPolygon(poly, 2);
    shooter.ai = { aimError: { angle: 0, power: 0 }, sniperChance: 0, moveChance: 0 };
    const traits = shotTraits(shooter, 'cannon');
    const score = (a, pw) => {
      const r = simulateShot(ai.world, shooter, W.cannon, a, pw, 6, 0, traits).hit;
      if (r.type === 'entity' && r.entity === target) return 0;
      return Math.hypot(r.x - target.cx, r.y - target.cy) + (r.type !== 'terrain' && r.type !== 'entity' ? 400 : 0);
    };
    let best = Infinity;
    for (let a = 15; a <= 85; a += 5) for (let pw = 15; pw <= 100; pw += 5) best = Math.min(best, score(a, pw));
    const plan = planShot(ai.world, shooter, new Rng(3));
    assert(plan && plan.weapon === 'cannon' && plan.targetId === target.id, 'AI plans a cannon shot at the bunker');
    const got = score(plan.angle, plan.power);
    assert(Math.abs(got - best) < 1e-9, `AI picked ${plan.angle}°/${plan.power} landing ${got.toFixed(1)}px away, but ${best.toFixed(1)}px was possible — it ignored the bounce`);
  }

  const rep = assertReplayMatches(matchWith({ cannonBounce: 1 }, { hp: 60 }), 1, (mm) => mm.resolveShot(mm.players[0], 'cannon', 45, 40), 'bouncy-bomb');
  assert(rep.events[0].type === 'bounce', 'replay case actually bounced');
  // 彈開之後還要飛很長一段（客戶端照事件裡的反射速度接著飛，落點要跟伺服器一樣）
  const arc = assertReplayMatches(matchWith({ cannonBounce: 1 }, { hp: 60 }), 1, (mm) => mm.resolveShot(mm.players[0], 'cannon', 70, 30), 'bouncy-bomb-arc');
  const b0 = arc.events[0];
  assert(b0.type === 'bounce' && Number.isFinite(b0.vx) && Number.isFinite(b0.vy) && arc.events.at(-1).f - b0.f > 30, `long flight after the bounce, carrying the reflected velocity (${b0.f} → ${arc.events.at(-1).f})`);

  // 瞄準預覽（client/render.js 用 aimPreview）：往腳下開砲，前幾個點之內就碰到地面——有蹦蹦炸彈時預覽照彈開後的路線畫
  const pv = matchWith({ cannonBounce: 1 });
  const pre = aimPreview(pv.world, pv.players[0], W.cannon, -60, 30);
  const want = simulateShot(pv.world, pv.players[0], W.cannon, -60, 30, CONFIG.PREVIEW.dots * CONFIG.PREVIEW.framesPerDot / 60, CONFIG.PREVIEW.framesPerDot, { bounces: 1 });
  const plainPre = aimPreview(plain.world, plain.players[0], W.cannon, -60, 30);
  assert(pre.kind === 'arc' && pre.points.length === CONFIG.PREVIEW.dots && JSON.stringify(pre.points) === JSON.stringify(want.points), 'preview follows the bounce: ' + JSON.stringify(pre.points));
  assert(plainPre.points.length < pre.points.length, `without the card the preview stops at the ground (${plainPre.points.length} dots)`);
  return { bounce: { x: Math.round(ev[0].x), y: Math.round(ev[0].y) }, end: ev.at(-1).type };
});

test('口徑強化：武器傷害 +20%（跟其他武器傷害加成相加）', () => {
  const pct = cardById('caliber_up').effects.damagePct;
  const m = matchWith({ damagePct: pct });
  const e1 = m.enemies[0];
  const hp0 = e1.hp;
  m.applyExplosion(e1.cx, e1.cy, W.cannon, m.players[0], e1);
  assert(hp0 - e1.hp === Math.round(W.cannon.damage * (1 + pct / 100)), 'caliber dmg ' + (hp0 - e1.hp));
  const both = matchWith({ damagePct: pct, cannonDamagePct: 20 });
  assert(Math.abs(both.damageMult(both.players[0], W.cannon) - (1 + (pct + 20) / 100)) < 1e-12, 'additive with cannon bonus');
  return { pct };
});

test('等離子飛彈：每發傷害照 config.WEAPONS.plasma.damage', () => {
  const m = matchWith({}, { weapons: ['plasma'] });
  const e1 = m.enemies[0];
  const hp0 = e1.hp;
  m.applyExplosion(e1.cx, e1.cy, W.plasma, m.players[0], e1);
  assert(hp0 - e1.hp === W.plasma.damage, 'one plasma missile = ' + W.plasma.damage + ', got ' + (hp0 - e1.hp));
  return { perMissile: W.plasma.damage };
});

// ---------- 紫 ----------

test('孤狼傳說：沒有活著的隊友（含單人）才生效：武器傷害 +50%、吸血 +5%；隊友還活著時沒有', () => {
  const { loneDamagePct: dmg, loneLifestealPct: ls } = cardById('lone_wolf').effects;
  const m = matchWith({ loneDamagePct: dmg, loneLifestealPct: ls }, { players: 2 });
  const [p1, p2] = m.players;
  const e1 = m.enemies[0];
  assert(m.damageMult(p1, W.cannon) === 1 && m.lifestealOf(p1) === 0, 'teammate alive → no bonus');
  const before = e1.hp;
  p1.hp = 1000;
  assert(m.lifesteal(p1, m.applyExplosion(e1.cx, e1.cy, W.cannon, p1, e1)) === 0 && before - e1.hp === W.cannon.damage, 'no bonus damage / lifesteal with a teammate');
  p2.die('hit');
  assert(Math.abs(m.damageMult(p1, W.cannon) - (1 + dmg / 100)) < 1e-12 && m.lifestealOf(p1) === ls, 'alone → +' + dmg + '% / ' + ls + '%');
  const hp1 = e1.hp;
  const hit = m.applyExplosion(e1.cx, e1.cy, W.cannon, p1, e1);
  const dealt = hp1 - e1.hp;
  assert(dealt === Math.round(W.cannon.damage * (1 + dmg / 100)), 'alone damage ' + dealt);
  const healed = m.lifesteal(p1, hit);
  assert(healed === Math.floor(dealt * ls / 100), `alone lifesteal ${healed} (from ${dealt})`);
  const solo = matchWith({ loneDamagePct: dmg });
  assert(Math.abs(solo.damageMult(solo.players[0], W.cannon) - (1 + dmg / 100)) < 1e-12, 'solo counts as alone');
  assert(m.damageMult(p1, W.bombard) === 1, 'not on equipment attacks');
  return { dealt, healed };
});

test('孤狼傳說 / 團結力量大：傷害與吸血照打中之前的場面算——自己這一發把最後一個隊友炸死，這一下不算孤狼、也還算一個隊友', () => {
  const m = matchWith({ loneDamagePct: 50, loneLifestealPct: 50 }, { players: 2 });
  const [p1, p2] = m.players;
  const e1 = m.enemies[0];
  p1.hp = 1000;
  p2.hp = 1;
  p2.x = e1.x + 20; p2.y = e1.y;   // 隊友站在敵人旁邊，會被爆炸波及（p2 排在 e1 前面，會先被算到）
  const h0 = e1.hp;
  const p = makeProjectile(p1, W.cannon, e1.cx, e1.cy, 0, 0);
  const ev = m.resolveHit(p1, W.cannon, p, 0, { type: 'entity', x: e1.cx, y: e1.cy, px: e1.cx, py: e1.cy, entity: e1 }, 1, 0);
  assert(!p2.alive && ev.damages.some(d => d.id === 'e1' && d.dmg > 0), 'the shot hit e1 and killed p2');
  assert(h0 - e1.hp === W.cannon.damage, 'no lone-wolf damage bonus on the shot that made him alone: e1 took ' + (h0 - e1.hp));
  assert(!ev.heal && p1.hp === 1000, 'no lone-wolf lifesteal on the shot that made him alone, healed ' + ev.heal);
  // 團結力量大：同一發炸死唯一的隊友，打到敵人的那一下還是 +10%
  const u = matchWith({ allyDamagePct: 10 }, { players: 2 });
  const [u1, u2] = u.players;
  const ue = u.enemies[0];
  u2.hp = 1;
  u2.x = ue.x + 20; u2.y = ue.y;
  const uh = ue.hp;
  u.applyExplosion(ue.cx, ue.cy, W.cannon, u1, ue);
  assert(!u2.alive && uh - ue.hp === Math.round(W.cannon.damage * 1.1), 'unity still counts the ally that this blast killed: e1 took ' + (uh - ue.hp));
  // 下一發就算了
  const p2nd = makeProjectile(p1, W.cannon, e1.cx, e1.cy, 0, 0);
  const ev2 = m.resolveHit(p1, W.cannon, p2nd, 0, { type: 'entity', x: e1.cx, y: e1.cy, px: e1.cx, py: e1.cy, entity: e1 }, 1, 0);
  assert(ev2.heal > 0, 'next shot gets the lone-wolf lifesteal');
  return { nextHeal: ev2.heal };
});

test('團結力量大：每個活著的隊友武器傷害 +10%、受到的傷害 -5%（只算自己，隊友沒有）；隊友倒下就少算', () => {
  const { allyDamagePct: dmg, allyArmorPct: arm } = cardById('unity').effects;
  const m = matchWith({ allyDamagePct: dmg, allyArmorPct: arm }, { players: 4 });
  const [p1, p2, p3, p4] = m.players;
  const e1 = m.enemies[0];
  assert(Math.abs(m.damageMult(p1, W.cannon) - (1 + 3 * dmg / 100)) < 1e-12, '3 allies → +' + 3 * dmg + '%');
  const took = (t) => { const h = t.hp; m.applyExplosion(t.cx, t.cy, W.cannon, e1, t, { directOnly: true }); return h - t.hp; };
  const t1 = took(p1);
  assert(t1 === Math.round(W.cannon.damage * (1 - 3 * arm / 100)), 'holder armor with 3 allies: took ' + t1);
  assert(took(p2) === W.cannon.damage, 'teammates do not get the armor');
  assert(m.damageMult(p2, W.cannon) === 1, 'teammates do not get the damage bonus');
  p3.die('hit'); p4.die('hit');
  assert(Math.abs(m.damageMult(p1, W.cannon) - (1 + dmg / 100)) < 1e-12, '1 ally left → +' + dmg + '%');
  assert(took(p1) === Math.round(W.cannon.damage * (1 - arm / 100)), 'armor with 1 ally');
  p2.die('hit');
  assert(m.damageMult(p1, W.cannon) === 1 && took(p1) === W.cannon.damage, 'alone → nothing');
  return { dmgPerAlly: dmg, armorPerAlly: arm };
});

test('團結力量大：同一發炸死隊友時，減傷照爆炸之前的人數算（跟角色的排列順序無關）', () => {
  // 持有者是 p2（排在 p1 後面）：沒有照爆炸前的人數算的話，p1 先被炸死，輪到 p2 就少了一個隊友
  const m = matchWith({}, { players: 2 });
  const [p1, p2] = m.players;
  p2.mods.allyArmorPct = 50;
  p1.hp = 1;
  p1.x = p2.x + 20; p1.y = p2.y;
  const e1 = m.enemies[0];
  const hp0 = p2.hp;
  const d = m.applyExplosion(p2.cx, p2.cy, W.cannon, e1, p2);
  assert(!p1.alive && d.some(x => x.id === 'p1'), 'p1 died in the same blast');
  assert(hp0 - p2.hp === Math.round(W.cannon.damage * 0.5), 'p2 still had 1 ally when the blast hit: took ' + (hp0 - p2.hp));
});

// ---------- 金 ----------

test('攜手之伴：連結的兩人受到的傷害先 -30% 再平分（除不盡的算被打的人）；沒連結的照常；對象倒下就不分也不減', () => {
  const cut = CONFIG.EQUIP.link.damageCutPct / 100;
  const m = matchWith({}, { players: 3 });
  const [p1, p2, p3] = m.players;
  const e1 = m.enemies[0];
  link(m, 'p1', 'p2');
  const total = Math.round(W.cannon.damage * (1 - cut));
  const each = Math.floor(total / 2);
  let h1 = p1.hp, h2 = p2.hp;
  const mv2 = JSON.stringify([p2.x, p2.y, p2.vx, p2.vy, p2.onGround]);
  const d = m.applyExplosion(p1.cx, p1.cy, W.cannon, e1, p1, { directOnly: true });
  assert(h1 - p1.hp === total - each && h2 - p2.hp === each, `p1 took ${h1 - p1.hp}, p2 took ${h2 - p2.hp}, expected ${total - each}/${each}`);
  assert(d.length === 2 && d[1].id === 'p2' && d[1].shared === 'p1' && d[1].dmg === each && !d[0].shared, 'damage list has the shared part: ' + JSON.stringify(d));
  assert(JSON.stringify([p2.x, p2.y, p2.vx, p2.vy, p2.onGround]) === mv2 && (p1.vx !== 0 || p1.vy !== 0), 'only the hit player is knocked back, the partner is not');
  // 反過來打 p2 也一樣（連結是雙向的）
  h1 = p1.hp; h2 = p2.hp;
  m.applyExplosion(p2.cx, p2.cy, W.cannon, e1, p2, { directOnly: true });
  assert(h2 - p2.hp === total - each && h1 - p1.hp === each, 'link works both ways');
  // 沒連結的 p3 照常
  const h3 = p3.hp;
  m.applyExplosion(p3.cx, p3.cy, W.cannon, e1, p3, { directOnly: true });
  assert(h3 - p3.hp === W.cannon.damage, 'unlinked teammate takes full damage');
  // 減傷、狂熱照常先算（減傷用被打的人的），再 -30%、平分
  p1.mods.armorPct = 50;
  h1 = p1.hp; h2 = p2.hp;
  m.applyExplosion(p1.cx, p1.cy, W.cannon, e1, p1, { directOnly: true });
  const t2 = Math.round(W.cannon.damage * 0.5 * (1 - cut));
  assert(h1 - p1.hp + h2 - p2.hp === t2, 'armor applies before the link cut: total ' + (h1 - p1.hp + h2 - p2.hp));
  p1.mods.armorPct = 0;
  // p2 倒下：不分、不減
  p2.die('hit');
  h1 = p1.hp;
  const d2 = m.applyExplosion(p1.cx, p1.cy, W.cannon, e1, p1, { directOnly: true });
  assert(h1 - p1.hp === W.cannon.damage && d2.length === 1, 'partner down → full damage, nothing shared');
  return { total, each };
});

test('攜手之伴：分到的份也會被神佑之石擋下；被打的人有無敵就整下擋掉、不分；誤傷也會分；落水不分', () => {
  const m = matchWith({}, { players: 2 });
  const [p1, p2] = m.players;
  const e1 = m.enemies[0];
  link(m, 'p1', 'p2');
  p2.shield = 1;
  let h1 = p1.hp, h2 = p2.hp;
  const d = m.applyExplosion(p1.cx, p1.cy, W.cannon, e1, p1, { directOnly: true });
  const total = Math.round(W.cannon.damage * (1 - CONFIG.EQUIP.link.damageCutPct / 100));
  assert(h2 === p2.hp && p2.shield === 0 && d.some(x => x.id === 'p2' && x.blocked && x.shared === 'p1'), 'partner shield blocks the shared part');
  assert(h1 - p1.hp === total - Math.floor(total / 2), 'p1 still only takes his half');
  p1.shield = 1;
  h1 = p1.hp; h2 = p2.hp;
  const d2 = m.applyExplosion(p1.cx, p1.cy, W.cannon, e1, p1, { directOnly: true });
  assert(h1 === p1.hp && h2 === p2.hp && d2.length === 1 && d2[0].blocked, 'blocked hit is not shared');
  // 誤傷（p1 打到自己）一樣分，分到的份也算誤傷（不會被吸血）
  p1.mods.lifestealPct = 100;
  h1 = p1.hp; h2 = p2.hp;
  const dff = m.applyExplosion(p1.cx, p1.cy, W.cannon, p1, p1, { directOnly: true });
  const ff = Math.round(W.cannon.damage * CONFIG.FRIENDLY_FIRE * (1 - CONFIG.EQUIP.link.damageCutPct / 100));
  assert(h1 - p1.hp + h2 - p2.hp === ff && h2 > p2.hp, 'friendly fire is shared too');
  assert(dff.some(x => x.shared) && dff.every(x => x.friendly), 'shared part of friendly fire is flagged friendly');
  assert(m.lifesteal(p1, dff) === 0, 'no lifesteal from hurting yourself and your partner');
  p1.mods.lifestealPct = 0;
  // 落水是另外的規則，不分（走伺服器收到位置回報的那條路）
  h2 = p2.hp;
  const falls = p1.waterFalls;
  assert(m.applyPositionReport(p1, { x: p1.x, y: CONFIG.WATER_LEVEL + 5, facing: 1, stamina: p1.stamina }).water && p1.waterFalls === falls + 1, 'p1 fell in the water');
  assert(p2.hp === h2, 'water damage is not shared');
});

test('攜手之伴：分到的份是 0 就不分（不會用掉對象的無敵）；被打的人自己有無敵時，連分到別人的份也一起擋、無敵只用一次', () => {
  const m = matchWith({}, { players: 3 });
  const [p1, p2, p3] = m.players;
  const e1 = m.enemies[0];
  link(m, 'p1', 'p2');
  link(m, 'p1', 'p3');
  p2.shield = 1; p3.shield = 1;
  const tiny = { ...W.cannon, damage: 2, radius: 0 };   // -30% 後 1 點，三人分每人 0
  const h1 = p1.hp;
  const d = m.applyExplosion(p1.cx, p1.cy, tiny, e1, p1, { directOnly: true });
  assert(p2.shield === 1 && p3.shield === 1 && !d.some(x => x.shared), 'zero shares are not handed out: ' + JSON.stringify(d));
  assert(h1 - p1.hp === Math.round(2 * (1 - CONFIG.EQUIP.link.damageCutPct / 100)), 'the hit player keeps the whole (cut) damage');
  // p2 有無敵：被直接打到 + 分到 p1 的份，同一下全部擋掉，只用掉一次
  p2.shield = 1;
  const h2 = p2.hp;
  m.applyExplosion((p1.cx + p2.cx) / 2, p1.cy, { ...W.cannon, radius: 200 }, e1, null);
  assert(p2.hp === h2 && p2.shield === 0, `one shield blocks everything p2 takes from this blast (hp ${h2} → ${p2.hp}, shield ${p2.shield})`);
});

test('攜手之伴：同一發同時打到連結的兩人時，結果跟角色的排列順序無關（誰快沒血、誰有無敵都一樣）', () => {
  // 兩人站在爆炸點左右對稱的位置；其中一人只剩 1 血或只有他有無敵。把角色順序反過來再算一次，兩人扣的血要一樣
  const run = (low, shieldOn, reversed) => {
    const m = matchWith({}, { players: 2, hp: 1000 });
    const [p1, p2] = m.players;
    link(m, 'p1', 'p2');
    const x0 = 300;
    p1.x = x0 - 15; p2.x = x0 + 15; p1.y = p2.y = 430;
    if (low) m.byId(low).hp = 1;
    if (shieldOn) m.byId(shieldOn).shield = 1;
    if (reversed) m.entities.reverse();
    const before = { p1: p1.hp, p2: p2.hp };
    m.applyExplosion(x0, 420, W.cannon, m.enemies.find(e => e.id === 'e1'), null);
    return { p1: before.p1 - p1.hp, p2: before.p2 - p2.hp, alive: [p1.alive, p2.alive].join() };
  };
  const out = {};
  for (const [low, sh] of [['p1', null], ['p2', null], [null, 'p1'], [null, 'p2']]) {
    const a = run(low, sh, false), b = run(low, sh, true);
    assert(JSON.stringify(a) === JSON.stringify(b), `low=${low} shield=${sh}: order changes the result ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    out[`${low || '-'}/${sh || '-'}`] = a;
  }
  // 對稱的兩種情況（p1 快沒血 vs p2 快沒血）活下來的人扣的一樣多
  assert(out['p1/-'].p2 === out['p2/-'].p1, 'the survivor loses the same no matter which slot is low: ' + JSON.stringify(out));
  assert(out['-/p1'].p2 === out['-/p2'].p1 && out['-/p1'].p1 === out['-/p2'].p2, 'shield on either side gives mirrored results: ' + JSON.stringify(out));
  return out;
});

test('攜手之伴：一個人被兩位隊友連結時三人平分；分到的那份把對象打死也照算；客戶端照事件重播一樣', () => {
  const m = matchWith({}, { players: 3 });
  const [p1, p2, p3] = m.players;
  const e1 = m.enemies[0];
  link(m, 'p1', 'p2');
  link(m, 'p3', 'p1');
  const total = Math.round(W.cannon.damage * (1 - CONFIG.EQUIP.link.damageCutPct / 100));
  const each = Math.floor(total / 3);
  const hs = [p1.hp, p2.hp, p3.hp];
  m.applyExplosion(p1.cx, p1.cy, W.cannon, e1, p1, { directOnly: true });
  assert(hs[0] - p1.hp === total - 2 * each && hs[1] - p2.hp === each && hs[2] - p3.hp === each, `three-way split ${hs[0] - p1.hp}/${hs[1] - p2.hp}/${hs[2] - p3.hp}`);
  // p2 只連著 p1：打 p2 只跟 p1 分
  const h3 = p3.hp;
  m.applyExplosion(p2.cx, p2.cy, W.cannon, e1, p2, { directOnly: true });
  assert(p3.hp === h3, 'p3 is not linked to p2');
  // 分到的傷害打死對象
  p2.hp = 1;
  m.applyExplosion(p1.cx, p1.cy, W.cannon, e1, p1, { directOnly: true });
  assert(!p2.alive, 'shared damage can knock the partner out');

  // 重播：p1 往正上方開砲炸到自己（誤傷），p2 分擔
  const r = matchWith({}, { players: 2, hp: 80 });
  link(r, 'p1', 'p2');
  const shot = assertReplayMatches(r, 2, (mm) => mm.resolveShot(mm.players[0], 'cannon', 90, 20), 'link-replay');
  const shared = shot.events.flatMap(e => e.damages || []).filter(d => d.shared);
  assert(shared.length > 0 && shared.every(d => d.id === 'p2'), 'the replayed shot shared damage with p2: ' + JSON.stringify(shot.events.map(e => e.damages)));
  return { each, sharedHits: shared.length };
});

test('攜手之伴（肉鴿流程）：選牌時一定要指定一位還沒連結的隊友；連結帶進下一關、雙向；超時隨機挑一位；沒人可連就不再出這張', () => {
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(2), seed: 21, io, cards: CARDS.cards });
  run.start();
  io.advance(2000);
  toPickPhase(io, run, { p1: ['bond'], p2: ['caliber_up'] });
  const clear = io.take('stageClear').at(-1);
  assert(clear.linkTargets && clear.linkTargets.p1.join() === 'p2' && clear.linkTargets.p2.join() === 'p1', 'stageClear tells who can be linked: ' + JSON.stringify(clear.linkTargets));
  run.handle('p1', { t: 'pick', cardId: 'bond' });                 // 沒指定
  run.handle('p1', { t: 'pick', cardId: 'bond', link: 'p1' });     // 指定自己
  run.handle('p1', { t: 'pick', cardId: 'bond', link: 'nobody' }); // 不存在
  assert(!run.picks.p1, 'pick without a valid teammate is rejected');
  run.handle('p1', { t: 'pick', cardId: 'bond', link: 'p2' });
  assert(run.picks.p1 === 'bond', 'valid link pick accepted');
  run.handle('p2', { t: 'pick', cardId: 'caliber_up' });
  const sum = io.take('picks').at(-1).summary;
  assert(sum.find(s => s.playerId === 'p1').link === 'p2', 'summary says who got linked');
  toBattle(io, run, 2);
  assert(run.match.byId('p1').links.join() === 'p2' && run.match.byId('p2').links.join() === 'p1', 'link carried into the next stage, both ways');
  assert(io.take('start').at(-1).carry.p2.links.join() === 'p1', 'start payload carries links (client builds the same Match)');
  // p2 已經跟唯一的隊友連結了：他抽不到攜手之伴
  for (let i = 0; i < 200; i++) {
    const offers = drawOffers(CARDS.cards, new Rng(i), 9, 3, [], run.players.get('p2').weapons, { solo: false, linkTargets: run.linkTargets(run.players.get('p2')).length });
    assert(!offers.some(c => c.id === 'bond'), 'bond offered to p2 with nobody left to link');
  }
  // 超時：隨機挑一位能連的隊友
  const io2 = new FakeIo();
  const run2 = new Run({ players: mkPlayers(3), seed: 22, io: io2, cards: CARDS.cards });
  run2.start();
  io2.advance(2000);
  toPickPhase(io2, run2, { p1: ['bond'], p2: ['caliber_up'], p3: ['caliber_up'] });
  io2.advance(CONFIG.RUN.pickTime * 1000 + 100);
  const to = run2.players.get('p1').links[0];
  assert(['p2', 'p3'].includes(to), 'timeout picks a random teammate: ' + to);
  toBattle(io2, run2, 2);
  assert(run2.match.byId(to).links.includes('p1'), 'and the link is live in the next stage');
  return { timeoutLinked: to };
});

// 3 人冒險推到第一次選牌（p1 / p2 / p3 的牌照 offers 換掉）
function threeAtPick(seed, offers, cards = CARDS.cards) {
  const io = new FakeIo();
  const run = new Run({ players: mkPlayers(3), seed, io, cards });
  run.start();
  io.advance(2000);
  toPickPhase(io, run, offers);
  return { io, run };
}

test('攜手之伴（3 人）：連的是自己選的那位；已經連結的、這一輪已經選了自己的隊友不能選（兩人互選不會白拿牌）；被選的人收到通知', () => {
  // 選 p3 就連 p3（不是隨便一位）
  {
    const { io, run } = threeAtPick(31, { p1: ['bond'], p2: ['caliber_up'], p3: ['caliber_up'] });
    run.handle('p1', { t: 'pick', cardId: 'bond', link: 'p3' });
    run.handle('p2', { t: 'pick', cardId: 'caliber_up' });
    run.handle('p3', { t: 'pick', cardId: 'caliber_up' });
    assert(run.players.get('p1').links.join() === 'p3' && io.take('picks').at(-1).summary.find(s => s.playerId === 'p1').link === 'p3', 'p1 linked the teammate he chose');
    toBattle(io, run, 2);
    assert(run.match.byId('p3').links.includes('p1') && !run.match.byId('p2').links.length, 'p3 (not p2) is linked to p1');
  }
  // 同一輪：p1 選了 p2 → p2 不能再選 p1（兩人本來就會連上），但可以選 p3；picked 廣播帶著 link
  {
    const { io, run } = threeAtPick(32, { p1: ['bond'], p2: ['bond'], p3: ['caliber_up'] });
    run.handle('p1', { t: 'pick', cardId: 'bond', link: 'p2' });
    const picked = io.take('picked').at(-1);
    assert(picked.playerId === 'p1' && picked.link === 'p2', 'picked broadcast tells p2 that p1 linked him: ' + JSON.stringify(picked));
    assert(run.linkTargets(run.players.get('p2')).join() === 'p3', 'p1 is no longer a target for p2 this round');
    run.handle('p2', { t: 'pick', cardId: 'bond', link: 'p1' });
    assert(!run.picks.p2, 'mutual pick rejected');
    run.handle('p2', { t: 'pick', cardId: 'bond', link: 'p3' });
    run.handle('p3', { t: 'pick', cardId: 'caliber_up' });
    assert(run.linksOf('p2').sort().join() === 'p1,p3', 'p2 ends up linked to both p1 and p3: ' + run.linksOf('p2'));
  }
  // 之前的關已經連結：不能再選他
  {
    const { run } = threeAtPick(33, { p1: ['caliber_up'], p2: ['bond'], p3: ['caliber_up'] });
    run.players.get('p1').links.push('p2');
    run.handle('p2', { t: 'pick', cardId: 'bond', link: 'p1' });
    assert(!run.picks.p2, 'already-linked teammate rejected');
    run.handle('p2', { t: 'pick', cardId: 'bond', link: 'p3' });
    assert(run.picks.p2 === 'bond', 'a free teammate is accepted');
  }
});

test('攜手之伴（超時隨機）：隨機挑還能連的隊友（兩位都有機會）；會避開這一輪已經選了他的人；2 人時對方已經選他，隨機就不會挑到這張牌', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const { io, run } = threeAtPick(100 + seed, { p1: ['bond'], p2: ['caliber_up'], p3: ['caliber_up'] });
    io.advance(CONFIG.RUN.pickTime * 1000 + 100);
    const to = run.players.get('p1').links[0];
    assert(['p2', 'p3'].includes(to), 'timeout links a teammate: ' + to);
    seen.add(to);
  }
  assert(seen.size === 2, 'the random link is not always the same teammate: ' + [...seen]);
  // p2 這一輪已經選了 p1：超時的 p1 隨機只會挑 p3
  for (let seed = 1; seed <= 8; seed++) {
    const { io, run } = threeAtPick(200 + seed, { p1: ['bond'], p2: ['bond'], p3: ['caliber_up'] });
    run.handle('p2', { t: 'pick', cardId: 'bond', link: 'p1' });
    run.handle('p3', { t: 'pick', cardId: 'caliber_up' });
    io.advance(CONFIG.RUN.pickTime * 1000 + 100);
    assert(run.players.get('p1').links.join() === 'p3' && run.players.get('p2').links.join() === 'p1', `seed ${seed}: p1 → ${run.players.get('p1').links}, p2 → ${run.players.get('p2').links}`);
  }
  // 2 人：p1 選了 p2，p2 超時 → 隨機不挑攜手之伴（沒人可連了）
  for (let seed = 1; seed <= 8; seed++) {
    const io = new FakeIo();
    const run = new Run({ players: mkPlayers(2), seed: 300 + seed, io, cards: CARDS.cards });
    run.start();
    io.advance(2000);
    toPickPhase(io, run, { p1: ['bond'], p2: ['bond', 'caliber_up'] });
    run.handle('p1', { t: 'pick', cardId: 'bond', link: 'p2' });
    io.advance(CONFIG.RUN.pickTime * 1000 + 100);
    assert(run.players.get('p2').cards.at(-1).id === 'caliber_up', `seed ${seed}: p2 random-picked ${run.players.get('p2').cards.at(-1).id}`);
  }
});

test('抽牌（肉鴿流程裡）：單人冒險不會發多人限定的牌；已經跟所有隊友連結的人不會再發攜手之伴', () => {
  const pool = ['unity', 'bond', 'caliber_up', 'medkit'].map(cardById);
  for (let seed = 1; seed <= 10; seed++) {
    const io = new FakeIo();
    const run = new Run({ players: mkPlayers(1), seed, io, cards: pool });
    run.start();
    io.advance(2000);
    for (const e of run.match.enemies) e.die('hit');
    assert(advanceUntil(io, () => run.phase === 'pick'), 'pick phase');
    assert(!run.offers.p1.some(c => c.teamOnly), `seed ${seed}: solo offered ${run.offers.p1.map(c => c.id)}`);
  }
  for (let seed = 1; seed <= 10; seed++) {
    const io = new FakeIo();
    const run = new Run({ players: mkPlayers(2), seed, io, cards: pool });
    run.start();
    io.advance(2000);
    run.players.get('p1').links.push('p2');
    for (const e of run.match.enemies) e.die('hit');
    assert(advanceUntil(io, () => run.phase === 'pick'), 'pick phase');
    assert(!run.offers.p2.some(c => c.id === 'bond') && !run.offers.p1.some(c => c.id === 'bond'), `seed ${seed}: bond offered with nobody to link`);
    assert(run.offers.p2.some(c => c.id === 'unity'), `seed ${seed}: team cards still show up in multiplayer`);
  }
});

test('新牌也維持確定性：同 seed 同輸入兩次結果完全一樣', () => {
  const once = () => {
    const m = matchWith({ cannonBounce: 1, loneDamagePct: 50, loneLifestealPct: 5, allyDamagePct: 10, allyArmorPct: 5 }, { players: 3, hp: 200 });
    m.players[0].mods.stageDamagePct = 50;
    link(m, 'p1', 'p2');
    const log = [];
    log.push(m.resolveShot(m.players[0], 'cannon', 70, 30));
    log.push(m.resolveShot(m.players[0], 'cannon', 90, 20));
    for (const e of m.enemies) if (e.alive) log.push(m.planAiTurn(e));
    return JSON.stringify({ log, snap: m.snapshot() });
  };
  assert(once() === once(), 'two runs differ');
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
