// node test/cards-1014.js
// 2026-10-14 新增的牌：狂歡派對、西洋刺劍、被虐體質、威嚇、長跑選手、全力一擊、金剛不壞、石假面，加上等離子飛彈從三發改兩發（見 test/headless.js）。
// - 牌庫：每張牌的 id / 名字 / 稀有度 / unique / 效果的 key 照使用者給的，說明裡的數字跟效果的數值、武器的設定一致；
//   玩家看得到的文字（牌、效果說明、武器說明、版本履歷）不提氣球
// - 狂歡派對：關卡規則的 feverFrom（第一層提早、之後照樣每隔幾輪、不會比原本晚、Boss 關沒有）、Match 開場從玩家的牌算；
//   伺服器與客戶端（真的 GameView 照 start 的 carry 建的 Match）每一輪的層數一樣；狂熱疊上新的一層時飄氣球（每層一次、畫面不改狀態、播完清掉）
// - 西洋刺劍：直擊（武器的傷害）+ 流血（武器的層數）、射程外刺不到（range、不挖地）、穿過隊友、瞄準預覽停在射程、重播一致、AI 代打只刺射程內的、畫面（劍尖閃光不是水霧）
// - 被虐體質：真的扣到血的攻擊（含誤傷、連結分到的）才疊層、上限、無敵 / 傷害 0 / 中毒 / 流血 / 燃燒 / 落水 / 石假面不算、同步 hs、每關從 0 開始
// - 威嚇：範圍內的敵人受到自己的傷害 +N%、打自己 -N%（邊界、隊友不算、狀態列的減傷不含）；用身體撞人的招式（大樹守衛衝鋒、蜜蜂螫擊、
//   巨蟒衝撞）量撞上那一下的位置、遠處丟過來的巨石不算；範圍圈只在自己的回合畫、有遮光的地圖畫在遮光上面
// - 長跑選手：體力上限、移動速度照牌上的數值加；全力一擊：照體力比例（含裁判照開火回報的體力結算）
// - 金剛不壞：燃燒 / 中毒 / 流血都不上（傷害照扣、記 immune、畫面飄「免疫」）；石假面：回合結束扣目前血量的 N%（四捨五入）、不會倒下、紀錄與飄字
// - 同 seed 帶著這些牌的整場 AI 對戰兩次結果一模一樣
// 血量與關卡規則的設定一律自己設（不受使用者調 config 影響）。牌的數值、西洋刺劍 / 等離子飛彈的設定、威嚇的距離使用者會自己調：
// 預期的數字照 cards.json / config 現在的值算（cardFx、W.rapier、CONFIG.EQUIP.intimidate.range）；
// 要看層數上限、四捨五入這種邊界的（被虐體質、石假面的邊界、撞人的威嚇）用測試自己的數值
import fs from 'node:fs';
import { CONFIG } from '../shared/core/config.js';
import { CHANGELOG } from '../shared/core/version.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { Run } from '../shared/game/run.js';
import { stageRules } from '../shared/game/stage-rules.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { spawnBee } from '../shared/maps/hive.js';
import { validateCards, baseStats, derivePlayerStats } from '../shared/cards/cards.js';
import { EFFECT_KEYS, effectChips, feverFrom, feverOps, auraOf, turnFxOps } from '../shared/cards/effects/index.js';
import { isEquippable, aimPreview } from '../shared/physics/weapons.js';
import { poisonTick } from '../shared/physics/entities.js';
import { planShot } from '../shared/ai/ai.js';
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
const near = (a, b) => Math.abs(a - b) < 1e-9;

const CARDS = validateCards(JSON.parse(fs.readFileSync(new URL('../shared/cards/cards.json', import.meta.url), 'utf8')));
const cardById = (id) => CARDS.cards.find(c => c.id === id);
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const W = CONFIG.WEAPONS;
// 測試自己的關卡規則設定：敵人傷害 ×1、狂熱 1 人每 9 輪 / 2 ~ 3 人 8 輪 / 4 人 7 輪、每層 +50%
const FEVER = { everyRounds: { 1: 9, 2: 8, 3: 8, 4: 7 }, damagePct: 50, inBoss: false };
const CFG = { ...CONFIG, ENEMY: { ...CONFIG.ENEMY, damageMult: 1, damageMultLate: 1 }, FEVER };

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
// 全域 CONFIG 的某幾個區塊暫時換成測試的值（客戶端的 Match 只讀全域 CONFIG），跑完還原
async function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, CONFIG[k]]));
  Object.assign(CONFIG, patch);
  try { return await fn(); } finally { Object.assign(CONFIG, saved); }
}

// 帶著某些牌的效果的玩家 carry（血量自己設）
function carryOf(effects = {}, { hp = 5000, weapons } = {}) {
  const stats = baseStats();
  for (const [k, v] of Object.entries(effects)) if (k in stats) stats[k] += v;
  const d = derivePlayerStats(stats);
  return { hp, maxHp: hp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed, size: d.size, mods: d.mods, ...(weapons ? { weapons } : {}) };
}
// 戰鬥：fx = { p1: 效果, p2: 效果… }；所有人血量 hp（敵人也是）
function matchWith(fx = {}, { players = 1, levelId = 'level1', seed = 1, hp = 5000, config = CFG, weapons } = {}) {
  const carry = {};
  for (let i = 1; i <= players; i++) carry['p' + i] = carryOf(fx['p' + i] || {}, { hp, weapons });
  const m = new Match({ levelId, players: mkPlayers(players), seed, carry, config });
  for (const e of m.entities) { e.maxHp = hp; e.hp = hp; }
  return m;
}
const cardFx = (id) => cardById(id).effects;
// 客戶端照 carry 與快照建的 Match（開火之前）
const clientOf = (m) => {
  const cm = new Match({ levelId: m.levelId, players: mkPlayers(m.players.length), seed: m.seed, carry: m.carry, stage: m.stage });
  cm.applySnapshot(JSON.parse(J(m.snapshot())));
  return cm;
};
// 把 e 放在 ref 正右邊 dx（腳底同一高度、靜止）
const place = (e, ref, dx) => { e.x = ref.x + dx; e.y = ref.y; e.vx = 0; e.vy = 0; };
// 從 shooter 的砲口瞄準 target 的身體中心的角度
const aimAt = (shooter, target) => { const mz = shooter.muzzle(); return Math.atan2(-(target.cy - mz.y), target.cx - mz.x) * 180 / Math.PI; };
// 一下直擊（不波及別人）：傷害 dmg 的直線武器（id 照 sniper，不吃任何武器限定的加成）
const strike = (m, attacker, target, extra = {}) => m.applyExplosion(target.cx, target.cy, { ...W.sniper, damage: 100, knockback: 0, ...extra }, attacker, target, { directOnly: true });
const hpLoss = (e, fn) => { const h0 = e.hp; fn(); return h0 - e.hp; };

// ---- 真的 GameView（Node 裡、假 canvas；同 test/bleed.js）----
// rec = { arcs: [], ellipses: 0 }：記下畫了哪些圓（半徑）、幾個橢圓（看畫面有沒有畫出某樣東西）；
// 再給 rec.seq = [] 就照順序記下畫圓、貼圖（['arc', 半徑] / ['drawImage', 圖]，看誰畫在誰上面）
const fakeCtx2d = (rec = null) => new Proxy({
  createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
  measureText: () => ({ width: 10 }),
  createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}),
  arc: (x, y, r) => { if (rec) { rec.arcs.push({ x, y, r }); if (rec.seq) rec.seq.push(['arc', r]); } },
  ellipse: () => { if (rec) rec.ellipses++; },
  drawImage: (img) => { if (rec && rec.seq) rec.seq.push(['drawImage', img]); },
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
const fakeCanvas = (rec = null) => ({
  width: 1024, height: 768, style: {}, getContext: () => fakeCtx2d(rec), addEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1024, height: 768 }),
});
globalThis.window ??= { addEventListener() {}, devicePixelRatio: 1 };
globalThis.document ??= { addEventListener() {}, hidden: false, createElement: () => fakeCanvas() };
globalThis.localStorage ??= { getItem: () => null, setItem() {} };
const { GameView } = await import('../client/game-view.js');
function newView(myId, rec = null) {
  const view = new GameView(fakeCanvas(rec));
  view.music = { play() {}, setRate() {} };
  view.myId = myId;
  view.transport = { send() {} };
  return view;
}
const idle = (view) => !view.script && !view.queue.length;
const drain = (view, n = 3000) => { for (let f = 0; f < n && !idle(view); f++) { view.update(STEP); view.render(); } };
const feed = (view, msgs) => { for (const { _except, ...msg } of msgs) if (_except !== view.myId) view.onMessage(JSON.parse(J(msg))); };

// ---------------- 牌庫 ----------------

await test('牌庫：八張新牌通過驗證，id / 名字 / 稀有度 / unique / 效果的 key 照使用者給的，說明裡的數字跟效果的數值、武器的設定一致（數值照 cards.json / config 現在的）；玩家看得到的文字不提氣球', () => {
  const R = W.rapier, P = W.plasma, range = CONFIG.EQUIP.intimidate.range;
  // text(f) = 說明裡一定要有的幾段字，照這張牌現在的數值（f = 效果）組出來：使用者調了數值、說明跟著改，這裡就照樣過
  const want = {
    party_time: { name: '狂歡派對', rarity: 'green', unique: true, keys: ['feverStartRound'], text: (f) => [`第 ${f.feverStartRound} 輪`] },
    rapier: { name: '西洋刺劍', rarity: 'green', unique: false, weapon: 'rapier', text: () => [`（${R.range}）`, `傷害 ${R.damage}`, ` ${R.bleed} 層流血`] },
    masochist: { name: '被虐體質', rarity: 'green', unique: true, keys: ['hurtDamagePct', 'hurtDamageMaxPct'], text: (f) => [`武器傷害 +${f.hurtDamagePct}%`, `最多 +${f.hurtDamageMaxPct}%`] },
    intimidate: { name: '威嚇', rarity: 'green', unique: false, keys: ['nearDamagePct', 'nearArmorPct'], text: (f) => [`離你 ${range} 以內`, `受到你的傷害 +${f.nearDamagePct}%`, `對你造成的傷害 -${f.nearArmorPct}%`] },
    marathon_runner: { name: '長跑選手', rarity: 'purple', unique: false, keys: ['staminaMax', 'moveSpeedPct'], text: (f) => [`體力上限 +${f.staminaMax}`, `移動速度 +${f.moveSpeedPct}%`] },
    all_out: { name: '全力一擊', rarity: 'purple', unique: true, keys: ['exertMinPct', 'exertMaxPct'], text: (f) => [`體力全滿 +${f.exertMinPct}%`, `體力用完 +${f.exertMaxPct}%`] },
    vajra_body: { name: '金剛不壞', rarity: 'gold', unique: true, keys: ['staminaMax', 'statusImmune'], text: (f) => [`體力上限 +${f.staminaMax}`, '免疫所有異常狀態（燃燒、中毒、流血）'] },
    stone_mask: { name: '石假面', rarity: 'gold', unique: true, keys: ['lifestealPct', 'maskDrainPct'], text: (f) => [`傷害吸血 +${f.lifestealPct}%`, `扣目前血量的 ${f.maskDrainPct}%`] },
  };
  // 說明裡有這段字，而且數字沒有接著別的數字（「+10%」不能算到「+100%」裡面）
  const has = (desc, s) => desc.split(s).slice(1).some(rest => !/^[\d.]/.test(rest));
  for (const [id, w] of Object.entries(want)) {
    const c = cardById(id);
    assert(c, 'missing card ' + id);
    assert(c.name === w.name && c.rarity === w.rarity && !!c.unique === w.unique, `${id}: ${J(c)}`);
    if (w.weapon) assert(c.weapon === w.weapon && isEquippable(w.weapon) && !Object.keys(c.effects).length, `${id} is a weapon card`);
    else {
      assert(J(Object.keys(c.effects).sort()) === J([...w.keys].sort()), `${id} effects ${J(c.effects)}`);
      assert(w.keys.every(k => Number.isFinite(c.effects[k]) && c.effects[k] >= 0) && w.keys.some(k => c.effects[k] > 0), `${id}: values are numbers and the card does something ${J(c.effects)}`);
    }
    const missing = w.text(c.effects).filter(s => !has(c.desc, s));
    assert(!missing.length, `${id}: the text "${c.desc}" does not say ${J(missing)}`);
  }
  const bad = CARDS.warnings.filter(x => Object.keys(want).some(id => x.includes(id)));
  assert(!bad.length, bad.join('; '));
  // 西洋刺劍：近身刺（直線、不挖地、穿過隊友）、會流血
  assert(R.radius === 0 && R.gravity === 0 && R.passAllies && R.damage > 0 && R.bleed > 0 && R.range > 0, 'rapier config ' + J(R));
  // 等離子飛彈：牌與武器的說明照 volley 幾發寫（2026-10-14 使用者從三發改兩發；之後再調，說明跟著改就過）
  const CN = ['零', '一', '兩', '三', '四', '五', '六', '七', '八', '九', '十'];
  const pc = cardById('plasma');
  assert(P.volley >= 2 && P.desc.includes(`連射${CN[P.volley]}發`) && pc.desc.includes(`再射出${CN[P.volley - 1]}發`) &&
    has(pc.desc, `每發傷害 ${P.damage}`) && has(pc.desc, `爆炸半徑 ${P.radius}`), `plasma text vs config: ${P.desc} / ${pc.desc} / ${J({ volley: P.volley, damage: P.damage, radius: P.radius })}`);
  // 氣球只是演出：牌、效果說明、武器說明、版本履歷都不寫
  const texts = [
    ...CARDS.cards.flatMap(c => [c.name, c.desc]), ...Object.values(EFFECT_KEYS),
    ...Object.values(W).flatMap(w => [w.desc || '', w.hud || '']), ...CHANGELOG.flatMap(c => [c.title, ...(c.new || []), ...(c.change || []), ...(c.fix || [])]),
  ];
  assert(!texts.some(t => /氣球/.test(t)), 'balloons mentioned: ' + texts.filter(t => /氣球/.test(t)));
  // 版本履歷（不改版號，記在最上面那一筆）
  const top = CHANGELOG[0];
  assert(top.new.some(l => ['狂歡派對', '被虐體質', '威嚇', '長跑選手', '全力一擊', '金剛不壞', '石假面'].every(n => l.includes(n))), 'CHANGELOG new: equipment cards');
  assert(top.new.some(l => l.includes('西洋刺劍')) && top.change.some(l => l.includes('等離子飛彈')), 'CHANGELOG rapier / plasma');
  return { cards: Object.keys(want).length };
});

// ---------------- 狂歡派對 ----------------

await test('關卡規則的 feverFrom：第一層從第 min(feverFrom, 原本) 輪開始、之後照樣每隔幾輪再疊；0 / 1 / 比原本晚 = 照原本（跟改之前的算法一模一樣）；Boss 關沒有', () => {
  const T = { ...CONFIG, FEVER };
  const out = {};
  for (const n of [1, 2, 3, 4]) {
    const every = { 1: 9, 2: 8, 3: 8, 4: 7 }[n];
    const old = (r) => Math.max(0, Math.floor((r - 1) / every));   // 改之前的算法
    for (const from of [0, 1, -3, NaN, every + 1, every + 5]) {
      const R = stageRules({ players: n, feverFrom: from }, T);
      assert(R.feverEvery === every && R.feverFirst === every + 1, `${n}p from ${from}: ${J(R)}`);
      for (let r = 0; r <= 40; r++) assert(R.feverAt(r) === old(r), `${n}p from ${from}: round ${r} → ${R.feverAt(r)} vs ${old(r)}`);
    }
    const P = stageRules({ players: n, feverFrom: 2 }, T);
    const got = [0, 1, 2, 3, 1 + every, 2 + every, 1 + 2 * every, 2 + 2 * every].map(P.feverAt);
    assert(P.feverFirst === 2 && got.join() === '0,0,1,1,1,2,2,3', `${n}p party: ${got}`);
    const P5 = stageRules({ players: n, feverFrom: 5 }, T);
    assert([4, 5, 4 + every, 5 + every].map(P5.feverAt).join() === '0,1,1,2', `${n}p from 5`);
    out[n] = got.join('');
  }
  const boss = stageRules({ players: 2, pool: 'boss', feverFrom: 2 }, T);
  assert(boss.feverEvery === 0 && boss.feverFirst === 0 && [2, 10, 50].every(r => boss.feverAt(r) === 0), 'boss: no fever');
  const inBoss = stageRules({ players: 2, pool: 'boss', feverFrom: 2 }, { ...T, FEVER: { ...FEVER, inBoss: true } });
  assert(inBoss.feverAt(2) === 1, 'inBoss: the party works there too');
  return out;
});

await test('狂歡派對：Match 開場照玩家的牌算（場上任一個人有就算、好幾個人照最早的）；沒有這張牌照原本；Boss 關沒有；狀態列「狂歡 第N輪」（Boss 關灰色）', () => {
  const party = cardFx('party_time');
  const from = party.feverStartRound;   // 牌上寫的第幾輪（使用者會調）
  const m = matchWith({ p1: party }, { players: 2 });
  const every = m.rules.feverEvery;
  const first = from > 1 ? Math.min(from, every + 1) : every + 1;   // 不會比原本（每隔 every 輪的第一層）晚
  assert(every === 8 && m.rules.feverFirst === first, J(m.rules));
  const at = (mm, r) => { mm.round = r; return mm.fever; };
  assert([at(m, first - 1), at(m, first), at(m, first - 1 + every), at(m, first + every)].join() === '0,1,1,2', 'fever by round');
  const p2only = matchWith({ p2: party }, { players: 3 });
  assert(p2only.rules.feverFirst === first, 'a teammate holding the card counts');
  // 下面用測試自己的輪數：第 2 輪就有狂熱、好幾個人照最早的
  const early = matchWith({ p1: { feverStartRound: 2 } }, { players: 2 });
  assert(early.rules.feverFirst === 2 && at(early, 1) === 0 && at(early, 2) === 1 && at(early, 1 + every) === 1 && at(early, 2 + every) === 2, 'from round 2');
  assert(feverFrom(matchWith({ p1: { feverStartRound: 4 }, p2: { feverStartRound: 3 } }, { players: 2 }).players) === 3, 'the earliest one wins');
  assert(feverFrom([]) === 0 && feverFrom(matchWith({}, { players: 2 }).players) === 0, 'nobody → 0');
  const plain = matchWith({}, { players: 2 });
  assert(plain.rules.feverFirst === every + 1 && at(plain, 2) === 0 && at(plain, every + 1) === 1, 'no card → as before');
  // 狀態列
  const chip = (mm) => effectChips(mm.players[0], { match: mm }).find(c => /狂歡/.test(c.label));
  assert(chip(m).label === `狂歡 第${from}輪` && chip(m).color !== '#64748b', 'chip ' + J(chip(m)));
  const bossId = levelsInPool('boss')[0];
  const b = matchWith({ p1: party }, { players: 2, levelId: bossId });
  assert(b.rules.feverEvery === 0 && at(b, 2) === 0 && at(b, 30) === 0, 'boss: no fever even with the party');
  assert(chip(b).color === '#64748b', 'boss: grey chip');
  assert(!chip(plain), 'no chip without the card');
  return { first: m.rules.feverFirst, every };
});

await test('狂歡派對：一路從選牌打到下一關——start 的 carry 帶著它，真的 GameView 照 start 建的 Match 每一輪的狂熱層數都跟伺服器一樣（照牌上的輪數提早）；疊上新的一層時飄一群氣球（每層一次），沒有這張牌的照原本、沒有氣球', async () => {
  const out = {};
  const from = cardFx('party_time').feverStartRound;   // 牌上寫的第幾輪（使用者會調）
  // 1 人每 4 輪一層（客戶端的 Match 只讀全域 CONFIG：暫時換成測試的值）
  await withConfig({ FEVER: { everyRounds: { 1: 4 }, damagePct: 50, inBoss: false } }, async () => {
    for (const card of ['party_time', 'iron_body']) {
      const party = card === 'party_time';
      const first = party && from > 1 ? Math.min(from, 5) : 5;   // 沒有這張牌：第 4 + 1 輪
      const io = new FakeIo();
      const run = new Run({ players: mkPlayers(1), seed: 3, io, cards: [cardById(card)] });
      run.start();
      io.advance(2000);
      for (const e of run.match.enemies) e.die('hit');
      assert(until(io, () => run.phase === 'pick'), 'reach the pick phase');
      run.handle('p1', { t: 'pick', cardId: card });
      assert(until(io, () => run.phase === 'battle' && run.stage === 2), 'stage 2 starts');
      const startAt = io.log.map(x => x.t).lastIndexOf('start');
      const start = io.log[startAt];
      assert((start.carry.p1.mods.feverStartRound || 0) === (party ? from : 0), 'carry mods: ' + J(start.carry.p1.mods));
      const server = run.match;
      assert(server.level.pool === 'normal' && server.rules.feverFirst === first, 'server rules ' + J(server.rules));
      server.planAiTurn = () => ({ walk: null, plan: null });   // 大家都只發呆：輪數一直往上加
      run.setConnected('p1', false);
      assert(until(io, () => server.round >= 11, 900_000), 'reach round 11: ' + server.round);
      // 伺服器的紀錄：turn.start 的 fever 照這一關的規則
      for (const r of io.recs('turn.start').filter(x => x.stage === 2)) {
        assert((r.fever || 0) === server.rules.feverAt(r.round), `turn.start round ${r.round}: fever ${r.fever}`);
      }
      // 客戶端：照 start 之後的每一則訊息播
      const view = newView('p1');
      const balloons = [];
      const startAmbient = view.startAmbient.bind(view);
      view.startAmbient = (kind, secs) => { balloons.push([view.match.round, kind, secs]); startAmbient(kind, secs); };
      const turns = [];
      for (const { _except, ...msg } of io.log.slice(startAt)) {
        view.onMessage(JSON.parse(J(msg)));
        drain(view);
        if (msg.t !== 'turn') continue;
        assert(view.match.round === msg.round && view.match.fever === server.rules.feverAt(msg.round),
          `${card} round ${msg.round}: client fever ${view.match.fever} vs server ${server.rules.feverAt(msg.round)}`);
        turns.push(msg.round);
      }
      assert(view.match.rules.feverFirst === server.rules.feverFirst && turns.includes(first) && turns.includes(10), 'played rounds ' + turns);
      // 疊上新的一層的那幾輪（這一輪的層數比上一輪多）：有這張牌的每一層飄一次氣球
      const layers = [...new Set(turns)].filter(r => server.rules.feverAt(r) > server.rules.feverAt(r - 1));
      assert(layers.length >= 2 && layers[0] === first, 'new layers played: ' + layers);
      const want = party ? layers.map(r => [r, 'balloons', 3.5]) : [];
      assert(J(balloons) === J(want), `${card}: balloons ${J(balloons)}`);
      out[card] = { first: server.rules.feverFirst, balloons: balloons.map(b => b[0]) };
    }
  });
  return out;
});

await test('狂歡派對的氣球（真的 GameView）：一次 14 顆、從畫面下面出發；畫的時候不改狀態（畫 0 ~ 3 次都一樣）；照遊戲時間往上飄、3.5 秒播完清掉；新的一關清掉', () => {
  const m = matchWith({ p1: cardFx('party_time') }, { players: 1 });
  const ref = new Referee({ match: m, humans: mkPlayers(1), io: new FakeIo() });
  const view = newView('p1');
  view.onMessage({ t: 'start', ...JSON.parse(J(ref.startPayload())) });
  assert(J(feverOps(view.match)) === J([['ambient', 'balloons', 3.5]]), 'the party gives the balloons: ' + J(feverOps(view.match)));
  assert(feverOps(matchWith({}, { players: 2 })) === null, 'nobody has it → null');
  const first = view.match.rules.feverFirst;   // 第一層（照牌上的輪數）
  view.match.round = first;
  assert(view.feverNotice() && view.ambient.length === 1, 'a new layer starts the balloons');
  assert(view.feverNotice() === null && view.ambient.length === 1, 'once per layer');
  const a = view.ambient[0];
  assert(a.kind === 'balloons' && a.sprites.length === 14 && a.sprites.every(b => b.y0 > CONFIG.WORLD_H && b.x > 0 && b.x < CONFIG.WORLD_W), 'balloons ' + J(a).slice(0, 200));
  const snap = () => J(view.ambient);
  for (let f = 0; f < 60; f++) {
    const s0 = snap();
    for (let k = 0; k < f % 4; k++) view.render();
    assert(snap() === s0, 'render changed the balloons');
    view.update(STEP);
  }
  assert(near(view.ambient[0].t, 60 * STEP), 'advanced with game time');
  for (let f = 0; f < 3.5 * 60; f++) view.update(STEP);
  assert(view.ambient.length === 0, 'gone after 3.5 s');
  view.match.round = first + view.match.rules.feverEvery;
  view.feverNotice();
  assert(view.ambient.length === 1, 'the next layer: balloons again');
  view.onMessage({ t: 'start', ...JSON.parse(J(ref.startPayload())) });
  assert(view.ambient.length === 0, 'a new stage clears them');
  return { balloons: a.sprites.length };
});

await test('狂歡派對的氣球真的畫出來（一般地圖、有遮光的洞穴地圖都畫：每顆一個氣球身體加一個反光）', () => {
  const out = {};
  for (const levelId of ['level1', 'cave']) {
    const m = matchWith({ p1: cardFx('party_time') }, { players: 1, levelId });
    const ref = new Referee({ match: m, humans: mkPlayers(1), io: new FakeIo() });
    const rec = { arcs: [], ellipses: 0 };
    const view = newView('p1', rec);
    view.onMessage({ t: 'start', ...JSON.parse(J(ref.startPayload())) });
    const ellipses = () => { rec.ellipses = 0; view.render(); return rec.ellipses; };
    const base = ellipses();
    view.match.round = view.match.rules.feverFirst;
    view.feverNotice();
    for (let f = 0; f < 80; f++) view.update(STEP);   // 1.33 秒：最晚出發的（3.5 × 0.3 = 1.05 秒）也出發了
    const n = view.ambient[0].sprites.length;
    assert(ellipses() - base === 2 * n, `${levelId}: ${ellipses() - base} ellipses for ${n} balloons`);
    out[levelId] = n;
  }
  return out;
});

// ---------------- 西洋刺劍 ----------------
// 傷害、流血層數、射程使用者會調：照 W.rapier 現在的值算。刺得到的敵人照射程放（中心離自己的中心 0.6 倍射程）；
// 刺不到的就用站在自己出生點的敵人（斷崖的第二個平台，離 P1 的出生點 470 多 px，腳下有地、不會掉進水裡）：射程要比這短才測得到，先檢查
const stabIn = () => Math.round(W.rapier.range * 0.6);
const outOfReach = (e, p) => e.distanceTo(p.cx, p.cy) > W.rapier.range + 60;

await test('西洋刺劍：直擊（武器的傷害，只吃自己的加成）+ 武器的流血層數；射程外刺不到（range 事件、沒傷害、不挖地）；穿過隊友；瞄準預覽是直線、停在射程；客戶端重播一致', () => {
  const R = W.rapier;
  assert(R.radius === 0 && R.gravity === 0 && R.passAllies && R.damage > 0 && R.bleed > 0 && isEquippable('rapier'), 'rapier config ' + J(R));
  // 刺中：敵人在正前方、射程內
  const m = matchWith({}, { players: 2, weapons: ['rapier'] });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  place(p2, p1, Math.round(stabIn() / 2));   // 隊友擋在中間：刺劍穿過去
  place(e1, p1, stabIn());
  const cm = clientOf(m);
  const holes = m.terrain.holes.length;
  const shot = JSON.parse(J(m.resolveShot(p1, 'rapier', aimAt(p1, e1), 50)));
  const ev = shot.events.find(x => x.type === 'explode');
  assert(ev && ev.target === 'e1' && !ev.carve && m.terrain.holes.length === holes, 'stabbed e1, no crater: ' + J(shot.events));
  assert(m.byId('e1').hp === 5000 - Math.round(R.damage) && e1.bleed === R.bleed && e1.bleedSource === 'p1' && ev.damages.find(d => d.id === 'e1').bleed === R.bleed, `e1 ${e1.hp} bleed ${e1.bleed}`);
  assert(p2.hp === 5000 && p2.bleed === 0, 'the teammate in the way is untouched');
  replayChecked(cm, shot, 'rapier hit');
  cm.applyEntities(shot.results);
  assert(cm.byId('e1').bleed === R.bleed && cm.byId('e1').hp === e1.hp, 'client gets the bleed');
  // 刺不到：敵人在射程外
  const f = matchWith({}, { players: 1, weapons: ['rapier'] });
  const q = f.players[0], far = f.enemies[0];
  assert(outOfReach(far, q), `the enemy at its spawn is out of reach: ${Math.round(far.distanceTo(q.cx, q.cy))} vs range ${R.range}`);
  const fc = clientOf(f);
  const mz = q.muzzle();
  const miss = JSON.parse(J(f.resolveShot(q, 'rapier', aimAt(q, far), 100)));
  const end = miss.events.find(x => x.type === 'range');
  assert(end && miss.events.length === 1 && !end.damages && far.hp === 5000 && far.bleed === 0, 'out of reach: ' + J(miss.events));
  const reach = Math.hypot(end.x - mz.x, end.y - mz.y);
  assert(Math.abs(reach - R.range) < 3 && miss.hit.type === 'range', 'stops at the range: ' + reach);
  replayChecked(fc, miss, 'rapier miss');
  // 瞄準預覽：直線、停在射程（前面沒東西）
  const pre = aimPreview(f.world, q, R, 90, 50);
  const last = pre.points.at(-1);
  assert(pre.kind === 'line' && pre.hit.type === 'range' && Math.abs(Math.hypot(last.x - mz.x, last.y - mz.y) - R.range) < 3, 'preview ' + J(pre.hit));
  return { reach: Math.round(reach) };
});

await test('西洋刺劍：AI 代打只刺射程內的敵人（只有刺劍時射程外不出手）；射程內刺得中', () => {
  const m = matchWith({}, { players: 1, weapons: ['rapier'] });
  const p = m.players[0];
  assert(m.enemies.every(e => outOfReach(e, p)), 'every enemy at its spawn is out of reach');
  const e1 = m.enemies[0];
  assert(planShot(m.world, p, m.rng, p.weapons) === null, 'everyone out of reach → no shot');
  place(e1, p, stabIn());
  const plan = planShot(m.world, p, m.rng, p.weapons);
  assert(plan && plan.weapon === 'rapier' && plan.targetId === 'e1', 'stab the one in reach: ' + J(plan));
  m.resolveShot(p, plan.weapon, plan.angle, plan.power);
  assert(e1.hp < 5000 && e1.bleed === W.rapier.bleed, 'the AI stab lands');
  return { angle: Math.round(plan.angle * 10) / 10 };
});

await test('西洋刺劍的畫面（真的 GameView）：刺到底沒碰到東西是劍尖一閃（不是高壓水炮的水霧），刺中不爆炸、只有一點火花，敵人飄「流血 +N」', () => {
  const out = {};
  for (const dx of [null, stabIn()]) {   // null = 敵人留在自己的出生點（射程外）
    const m = matchWith({}, { players: 1, weapons: ['rapier'] });
    const p1 = m.players[0], e1 = m.enemies[0];
    if (dx === null) assert(outOfReach(e1, p1), 'out of reach at its spawn');
    else place(e1, p1, dx);
    m.planAiTurn = () => ({ walk: null, plan: null });
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: mkPlayers(1), io });
    const view = newView('p1');
    const seen = [];
    const show = view.showShotEvent.bind(view);
    view.showShotEvent = (shot, w, ev, made) => {
      const p0 = view.particles.length, f0 = view.flashes.length;
      show(shot, w, ev, made);
      seen.push({ type: ev.type, colors: [...new Set(view.particles.slice(p0).map(x => x.color))], tints: view.flashes.slice(f0).map(x => x.tint) });
    };
    ref.start();
    assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
    feed(view, io.log.splice(0));
    drain(view);
    ref.handle('p1', { t: 'fire', weapon: 'rapier', angle: aimAt(p1, e1), power: 50, x: p1.x, y: p1.y, facing: 1, stamina: p1.stamina });
    feed(view, io.log.splice(0));
    drain(view);
    const ev = seen[0];
    if (dx === null) {
      assert(seen.length === 1 && ev.type === 'range' && ev.colors.join() === '#f8fafc' && ev.tints.join() === '241,245,249', 'glint, no mist: ' + J(seen));
    } else {
      assert(seen.length === 1 && ev.type === 'explode' && !ev.tints.length && ev.colors.includes('#f1f5f9') && ev.colors.includes('#dc2626'), 'spark, no blast: ' + J(seen));
      assert(view.floatTexts.some(f => f.id === 'e1' && f.text === `流血 +${W.rapier.bleed}`), 'bleed float: ' + J(view.floatTexts.map(f => f.text)));
    }
    out[dx === null ? 'out' : 'in'] = ev.type;
  }
  return out;
});

// ---------------- 被虐體質 ----------------
// 層數怎麼疊、停在哪裡用測試自己的數值（牌上的數值使用者會調；牌上的說明跟數值一致在牌庫那個測試看）：每層 +10%、最多 +40%（4 層）
const MASO = { hurtDamagePct: 10, hurtDamageMaxPct: 40 };

await test('被虐體質：每受到一次真的扣到血的攻擊（敵人、誤傷、開火打中、連結分到的）+1 層，每層武器傷害 +N%、最多 +M%（層數停在剛好到上限）；無敵擋下、傷害 0、中毒 / 流血 / 燃燒 / 落水 / 石假面都不算；牌上的數值照樣算', () => {
  const card = cardFx('masochist');
  const c = matchWith({ p1: card });
  strike(c, c.enemies[0], c.players[0]);
  assert(c.players[0].hurtStacks === 1 && near(c.damageMult(c.players[0], W.cannon), 1 + Math.min(card.hurtDamageMaxPct, card.hurtDamagePct) / 100), 'the card: one hit ' + J(card));
  const maso = MASO;
  const m = matchWith({ p1: maso, p2: { ...maso, link: 0 } }, { players: 2 });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  const mult = () => m.damageMult(p1, W.cannon);
  assert(p1.hurtStacks === 0 && near(mult(), 1), 'starts at 0');
  strike(m, e1, p1);
  assert(p1.hurtStacks === 1 && near(mult(), 1.1), 'enemy hit: +10%');
  strike(m, p2, p1);
  assert(p1.hurtStacks === 2 && near(mult(), 1.2), 'friendly fire counts');
  // 開火打中（resolveShot → resolveHit → applyExplosion 同一條路）
  place(e1, p1, 60);
  m.resolveShot(e1, 'sniper', aimAt(e1, p1), 100);
  assert(p1.hurtStacks === 3, 'a real shot counts: ' + p1.hurtStacks);
  for (let i = 0; i < 4; i++) strike(m, e1, p1);
  assert(p1.hurtStacks === 4 && near(mult(), 1.4), `capped at +40% (stacks ${p1.hurtStacks})`);
  // 不算的
  const n = matchWith({ p1: maso }, { players: 1 });
  const q = n.players[0], foe = n.enemies[0];
  q.shield = 1;
  strike(n, foe, q);
  assert(q.hurtStacks === 0 && q.hp === 5000, 'blocked by the shield');
  strike(n, foe, q, { damage: 0, poison: 3 });
  assert(q.hurtStacks === 0 && q.poison === 3, 'damage 0 (poison only)');
  poisonTick(q);
  q.bleed = 50; q.bleedFor(100);
  q.burn = 100; n.burnTick(q, []);
  assert(q.hp < 5000 && q.hurtStacks === 0, 'poison / bleed / burn ticks do not count');
  const hp0 = q.hp;
  place(q, q, 0); q.y = CONFIG.WATER_LEVEL + 20; q.fallInWater(n.terrain);
  assert(q.hp < hp0 && q.hurtStacks === 0, 'water does not count');
  const s = matchWith({ p1: { ...maso, ...cardFx('stone_mask') } }, { players: 1 });
  const sp = s.players[0];
  s.endTurn(sp);
  assert(sp.hp < 5000 && sp.hurtStacks === 0, 'the stone mask does not count');
  return { stacks: p1.hurtStacks };
});

await test('被虐體質：攜手之伴分到的那份也算一次（扣到才算）；層數同步（toState 的 hs 排在 vn、rd、hu 後面，客戶端套得回去），每關從 0 開始', () => {
  const maso = MASO;
  const m = matchWith({ p1: maso, p2: maso }, { players: 2 });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  p1.links = ['p2']; p2.links = ['p1'];
  strike(m, e1, p1);
  assert(p1.hurtStacks === 1 && p2.hurtStacks === 1 && p2.hp < 5000, 'the link partner got a share and a stack');
  p2.shield = 1;
  strike(m, e1, p1);
  assert(p1.hurtStacks === 2 && p2.hurtStacks === 1 && p2.shield === 0, 'a share blocked by the shield does not count');
  // 同一發炸到兩個人：p1 被自己那份打倒，p2 分給他的那份已經扣不到血 → 不算
  const d = matchWith({ p1: maso, p2: maso }, { players: 2 });
  const [d1, d2] = d.players;
  d1.links = ['p2']; d2.links = ['p1'];
  place(d2, d1, 10);
  d1.hp = 5;
  d.applyExplosion((d1.cx + d2.cx) / 2, d1.cy, { ...W.cannon, damage: 200, knockback: 0 }, d.enemies[0], null);
  assert(!d1.alive && d2.alive && d1.hurtStacks === 1 && d2.hurtStacks === 2, `share to a fallen partner: ${d1.hurtStacks} / ${d2.hurtStacks}`);
  const s = p1.toState();
  const keys = Object.keys(s);
  assert(s.hs === 2 && keys.indexOf('hs') === keys.indexOf('hu') + 1 && keys.indexOf('hu') === keys.indexOf('rd') + 1 && keys.indexOf('rd') === keys.indexOf('vn') + 1, 'hs after vn / rd / hu: ' + keys);
  const cm = clientOf(m);
  assert(cm.byId('p1').hurtStacks === 2 && cm.byId('p2').hurtStacks === 1, 'client gets the stacks');
  // 下一關：carry 不帶層數
  const next = new Match({ levelId: 'level1', players: mkPlayers(2), seed: 2, carry: { p1: { ...m.carry.p1, hurtStacks: 3 } }, config: CFG });
  assert(next.byId('p1').hurtStacks === 0, 'resets every stage');
  const chip = effectChips(p1, { match: m }).find(c => /受虐/.test(c.label));
  assert(chip && chip.label === '受虐 +20%', 'chip ' + J(chip));
  return { keys: keys.slice(keys.indexOf('vn')).join() };
});

// ---------------- 威嚇 ----------------

await test('威嚇：離自己 range 以內（自己的身體中心到對方身體最近的邊，剛好 range 算）的敵人受到自己的傷害 +N%、打自己 -N%（照牌上的數值）；多 1 px 不算；隊友不算；轟炸也吃；狀態列的「減傷」不含', () => {
  const range = CONFIG.EQUIP.intimidate.range;
  const fx = cardFx('intimidate');
  assert(EFFECT_KEYS.nearDamagePct === '離自己一定距離以內的敵人受到自己的傷害 +N%' && EFFECT_KEYS.nearArmorPct === '離自己一定距離以內的敵人對自己造成的傷害 -N%', 'key texts (the range lives in config, not in the key text)');
  const dealt = Math.round(100 * (1 + fx.nearDamagePct / 100)), taken = Math.round(100 * (1 - fx.nearArmorPct / 100));   // 一下 100 的傷害
  const m = matchWith({ p1: fx }, { players: 2 });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  const at = (gap) => place(e1, p1, gap + e1.hw);   // 身體最近的邊離 p1 的中心 gap px
  at(range);
  assert(near(e1.distanceTo(p1.cx, p1.cy), range), 'distance ' + e1.distanceTo(p1.cx, p1.cy));
  assert(hpLoss(e1, () => strike(m, p1, e1)) === dealt, `in range: dealt +${fx.nearDamagePct}%`);
  assert(hpLoss(p1, () => strike(m, e1, p1)) === taken, `in range: taken -${fx.nearArmorPct}%`);
  assert(hpLoss(e1, () => strike(m, p1, e1, { id: 'bombard' })) === dealt, 'bombard missiles too');
  at(range + 1);
  assert(hpLoss(e1, () => strike(m, p1, e1)) === 100 && hpLoss(p1, () => strike(m, e1, p1)) === 100, 'out of range: nothing');
  // 隊友（誤傷）不吃：打隊友、被隊友打都照平常
  place(p2, p1, 30);
  const ff = Math.round(100 * CONFIG.FRIENDLY_FIRE);
  assert(hpLoss(p2, () => strike(m, p1, p2)) === ff && hpLoss(p1, () => strike(m, p2, p1)) === ff, 'friendly fire unchanged');
  // 沒有這張牌的隊友打近的敵人：照平常
  at(10);
  assert(hpLoss(e1, () => strike(m, p2, e1)) === 100, 'only the holder');
  assert(m.armorOf(p1) === 0 && m.armorOf(p1, 1, e1) === fx.nearArmorPct && m.armorOf(p1, 1, p2) === 0 && !effectChips(p1, { match: m }).some(c => /減傷/.test(c.label)), 'armor chip excludes it');
  assert(effectChips(p1, { match: m }).some(c => c.label === `威嚇 ${range}`), 'chip');
  return { range, dealt, taken };
});

// 用身體撞人的招式（武器的 bodyHit：飛行物就是攻擊者自己）結算時攻擊者的角色還在出發點：威嚇要量撞上那一下的位置。
// 測試自己的數值：距離 250、威嚇的減傷 50%，跟一樣 50% 的一般減傷（armorPct）比；招式的傷害照使用者的設定
const withRange250 = (fn) => withConfig({ EQUIP: { ...CONFIG.EQUIP, intimidate: { ...CONFIG.EQUIP.intimidate, range: 250 } } }, fn);
// levelId 這張地圖上 p1 帶著 effects 挨 foe 一招：setup(m, p1) 擺好、回傳出招的角色。回傳扣了多少血、出招前 / 後攻擊者的身體離 p1 的中心多遠
function bodyHit(levelId, effects, setup) {
  const m = matchWith({ p1: effects }, { players: 1, levelId });
  const p = m.players[0];
  const foe = setup(m, p);
  const start = foe.distanceTo(p.cx, p.cy);
  const hp0 = p.hp;
  const r = m.planAiTurn(foe);
  return { action: r.boss && r.boss.steps[0].action, dmg: hp0 - p.hp, start: Math.round(start), end: Math.round(foe.distanceTo(p.cx, p.cy)) };
}
const BODY_CASES = {
  // 大樹守衛衝鋒：從最右邊衝向 500 px 外被標記的人，撞到他就停在他旁邊
  guardian: ['forestGuard', 'charge', (m, p) => {
    const g = m.byId('guardian');
    p.x = g.x - 500; p.y = g.y; p.vx = 0; p.vy = 0;
    m.settle(200);
    m.mechState.next = { action: 'charge', targetId: p.id };
    return g;
  }],
  // 蜜蜂從蜂巢底下（剛飛出來停的第一個位置）衝過來螫站在出生點的人
  bee: ['beehive', 'sting', (m) => {
    const spot = LEVELS.beehive.mechanic.beeSpots[0];
    return spawnBee(m, { id: 'bee9', name: '蜜蜂', x: spot.x, y: spot.y, hp: 10, wait: 0 });
  }],
  // 巨蟒衝撞：頭沿著藤蔓橋衝過來，撞到站在橋最左邊的人
  snake: ['jungleSerpent', 'charge', (m) => {
    m.mechState.next = { action: 'charge' };
    return m.byId('snake');
  }],
};

await test('威嚇 × 用身體撞人的招式：大樹守衛從 250 以外衝過來撞到持有者、蜜蜂從蜂巢衝過來螫、巨蟒的頭衝過來撞，都算「離自己近的敵人打自己」（跟一樣 % 的一般減傷一樣扣）', () => withRange250(() => {
  const out = {};
  for (const [name, [levelId, action, setup]] of Object.entries(BODY_CASES)) {
    assert(CONFIG.WEAPONS[{ guardian: 'guardianCharge', bee: 'beeSting', snake: 'snakeCharge' }[name]].bodyHit === true, `${name}: bodyHit`);
    const none = bodyHit(levelId, {}, setup);
    const intim = bodyHit(levelId, { nearArmorPct: 50 }, setup);
    const armor = bodyHit(levelId, { armorPct: 50 }, setup);
    assert(none.action === action && none.start > 250 && none.dmg > 0, `${name}: the move starts far away and hits: ${J(none)}`);
    if (name !== 'snake') assert(none.end <= 250, `${name}: ends next to the holder: ${J(none)}`);
    assert(intim.dmg === armor.dmg && intim.dmg < none.dmg, `${name}: intimidate ${intim.dmg} vs armor ${armor.dmg} vs none ${none.dmg}`);
    out[name] = [none.dmg, intim.dmg, none.start];
  }
  return out;
}));

await test('威嚇 × 用身體撞人的量法：攻擊者的身體 = 撞上那一下的飛行物（中心、半徑 = 判定半徑），量到它最近的邊；持有者自己撞人時從撞上的位置量到對方；角色本身在哪不算', () => withRange250(() => {
  const m = matchWith({ p1: { nearDamagePct: 50, nearArmorPct: 50 } }, { players: 1 });
  const p1 = m.players[0], e1 = m.enemies[0];
  place(e1, p1, 600);   // 角色本身離得很遠
  const ram = (r) => ({ ...W.sniper, id: 'ram', damage: 100, knockback: 0, bodyHit: true, hitRadius: r });
  // 撞上那一下飛行物的中心在 p1 右邊 300：半徑 60 → 最近的邊離 p1 的中心 240（算近）；半徑 40 → 260（不算）
  const takenAt = (w) => hpLoss(p1, () => m.applyExplosion(p1.cx + 300, p1.cy, w, e1, p1, { directOnly: true }));
  assert(takenAt(ram(60)) === 50 && takenAt(ram(40)) === 100, `rammed: ${takenAt(ram(60))} / ${takenAt(ram(40))}`);
  assert(takenAt({ ...ram(60), bodyHit: false }) === 100, 'not a body hit: measured from the attacker (600 away)');
  // p1 自己撞 e1：從撞上的位置（e1 旁邊）量到 e1 的身體
  const dealtAt = (w, x) => hpLoss(e1, () => m.applyExplosion(x, e1.cy, w, p1, e1, { directOnly: true }));
  assert(dealtAt(ram(10), e1.cx - 30) === 150 && dealtAt({ ...ram(10), bodyHit: false }, e1.cx - 30) === 100, 'ramming an enemy: measured from the impact');
  return { rammed: takenAt(ram(60)) };
}));

await test('威嚇 × 遠處丟過來的巨石（不是用身體撞人）：獨眼巨人從 250 以外丟過來，不減傷（一般減傷照扣）', () => withRange250(() => {
  const setup = (m) => {
    m.mechState.next = { action: 'throw' };
    return m.byId('cyclops');
  };
  assert(!CONFIG.WEAPONS.cyclopsBoulder.bodyHit, 'the boulder is not a body hit');
  const none = bodyHit('depths', {}, setup);
  const intim = bodyHit('depths', { nearArmorPct: 50 }, setup);
  const armor = bodyHit('depths', { armorPct: 50 }, setup);
  assert(none.action === 'throw' && none.start > 250 && none.end > 250 && none.dmg > 0, 'thrown from far away: ' + J(none));
  assert(intim.dmg === none.dmg && armor.dmg < none.dmg, `intimidate ${intim.dmg} vs none ${none.dmg} vs armor ${armor.dmg}`);
  return { none: none.dmg, intimidate: intim.dmg, start: none.start };
}));

await test('威嚇的範圍圈（真的 GameView 的 render）：只在輪到持有者的回合、在他身上畫一圈半徑 = 威嚇距離的線；別人的回合、沒有這張牌的人、倒下了都不畫', () => {
  const range = CONFIG.EQUIP.intimidate.range;
  const m = matchWith({ p1: cardFx('intimidate') }, { players: 2 });
  assert(J(auraOf(m.players[0], { match: m })) === J({ r: range, color: '#fca5a5' }) && auraOf(m.players[1], { match: m }) === null, 'aura hook');
  const ref = new Referee({ match: m, humans: mkPlayers(2), io: new FakeIo() });
  const rec = { arcs: [], ellipses: 0 };
  const arcs = rec.arcs;
  const view = newView('p2', rec);
  view.onMessage({ t: 'start', ...JSON.parse(J(ref.startPayload())) });
  const p1 = view.match.byId('p1');
  const rings = (id) => { view.currentId = id; arcs.length = 0; view.render(); return arcs.filter(a => a.r === range); };
  const mine = rings('p1');
  assert(mine.length === 1 && near(mine[0].x, p1.cx) && near(mine[0].y, p1.cy), 'drawn around p1 on his turn: ' + J(mine));
  assert(!rings('p2').length && !rings('e1').length && !rings(null).length, 'not on other turns');
  p1.die('hit');
  assert(!rings('p1').length, 'not when he is down');
  return { rings: mine.length };
});

await test('威嚇的範圍圈畫在遮光上面：有遮光的洞穴地圖（岩穴、地心探險、巨蠍巢穴）角色、遮光都畫完才畫，不會被蓋暗；一般地圖照樣畫一圈', () => {
  const range = CONFIG.EQUIP.intimidate.range;
  const out = {};
  for (const levelId of ['cave', 'depths', 'scorpionDen', 'level1']) {
    const m = matchWith({ p1: cardFx('intimidate') }, { players: 1, levelId });
    const ref = new Referee({ match: m, humans: mkPlayers(1), io: new FakeIo() });
    const rec = { arcs: [], ellipses: 0, seq: [] };
    const view = newView('p1', rec);
    view.onMessage({ t: 'start', ...JSON.parse(J(ref.startPayload())) });
    view.currentId = 'p1';
    const shaded = view.mapView.shaded(view.mapCtx);
    rec.seq.length = 0;
    view.render();
    const rings = rec.seq.map((s, i) => [s, i]).filter(([s]) => s[0] === 'arc' && s[1] === range).map(([, i]) => i);
    // 遮光：整片暗的暫存畫布（GameView.scratchLayer）貼上主畫面的那一下
    const shade = rec.seq.findIndex(s => s[0] === 'drawImage' && s[1] === view.scratchLayer().canvas);
    assert(shaded === (levelId !== 'level1'), `${levelId}: shaded ${shaded}`);
    assert(rings.length === 1, `${levelId}: one ring: ${rings.length}`);
    if (shaded) assert(shade >= 0 && rings[0] > shade, `${levelId}: the ring (#${rings[0]}) is drawn after the shade (#${shade})`);
    out[levelId] = shaded ? `shade #${shade} → ring #${rings[0]}` : `ring #${rings[0]}`;
  }
  return out;
});

// ---------------- 長跑選手、全力一擊 ----------------

await test('長跑選手：體力上限 +N、移動速度 +N%（照牌上的數值、現在的基礎數值算）', () => {
  const fx = cardFx('marathon_runner');
  const d = derivePlayerStats(Object.assign(baseStats(), fx));
  const base = derivePlayerStats(baseStats());
  const stamina = Math.round(base.maxStamina + fx.staminaMax);
  assert(fx.staminaMax > 0 && fx.moveSpeedPct > 0 && d.maxStamina === stamina && near(d.moveSpeed, base.moveSpeed * (1 + fx.moveSpeedPct / 100)), `${d.maxStamina} / ${d.moveSpeed} (${J(fx)})`);
  const m = matchWith({ p1: fx });
  assert(m.players[0].maxStamina === stamina, 'in battle');
  return { maxStamina: d.maxStamina };
});

await test('全力一擊：體力全滿 +最低%、用完 +最高%、一半在中間（照牌上的數值）；體力上限 0 不加；裁判照開火回報的體力結算（只減不加）；狀態列即時顯示', () => {
  const { exertMinPct: lo, exertMaxPct: hi } = cardFx('all_out');
  assert(hi > lo, 'the less stamina, the more damage: ' + J({ lo, hi }));
  const m = matchWith({ p1: cardFx('all_out') });
  const p = m.players[0];
  const mult = () => m.damageMult(p, W.cannon);
  p.stamina = p.maxStamina;
  assert(near(mult(), 1 + lo / 100), 'full ' + mult());
  p.stamina = 0;
  assert(near(mult(), 1 + hi / 100), 'empty ' + mult());
  p.stamina = p.maxStamina / 2;
  assert(near(mult(), 1 + (lo + hi) / 2 / 100), 'half ' + mult());
  const chip = effectChips(p, { match: m }).find(c => /全力/.test(c.label));
  assert(chip.label === `全力 +${Math.round((lo + hi) / 2)}%`, 'chip ' + chip.label);
  p.maxStamina = 0;
  assert(near(mult(), 1), 'no stamina bar → no bonus');
  assert(near(matchWith({}).damageMult(matchWith({}).players[0], W.cannon), 1), 'without the card');
  // 裁判：開火帶的體力（回報 0 → 最高；滿的 → 最低；先回報走到 0、開火時又說滿的 → 照伺服器的 0）
  const out = {};
  for (const [label, moved, report, pct] of [['empty', null, 0, hi], ['full', null, 'max', lo], ['raised', 0, 99999, hi]]) {
    const want = 1 + pct / 100;
    const r = matchWith({ p1: cardFx('all_out') });
    const q = r.players[0], e1 = r.enemies[0];
    place(e1, q, 60);
    r.planAiTurn = () => ({ walk: null, plan: null });
    const io = new FakeIo();
    const ref = new Referee({ match: r, humans: mkPlayers(1), io });
    ref.start();
    assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
    const hp0 = e1.hp;
    if (moved !== null) ref.handle('p1', { t: 'move', x: q.x, y: q.y, facing: 1, stamina: moved });
    ref.handle('p1', { t: 'fire', weapon: 'sniper', angle: aimAt(q, e1), power: 100, x: q.x, y: q.y, facing: 1, stamina: report === 'max' ? q.maxStamina : report });
    const shot = io.recs('shot').at(-1);
    assert(hp0 - e1.hp === Math.round(W.sniper.damage * want) && shot.exert && shot.exert.pct === Math.round(pct * 10) / 10,
      `${label}: dealt ${hp0 - e1.hp}, want ${Math.round(W.sniper.damage * want)}; log ${J(shot.exert)}`);
    out[label] = hp0 - e1.hp;
  }
  return out;
});

// ---------------- 金剛不壞 ----------------

await test('金剛不壞：燃燒、中毒、流血都不上（記 immune）、傷害與擊退照常；沒有這張牌的照上；沒有要上的狀態、誤傷、被無敵擋下的不記；體力上限照牌上的數值加', () => {
  const vajra = cardFx('vajra_body');
  const m = matchWith({ p1: vajra }, { players: 2 });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  assert(p1.maxStamina === Math.round(derivePlayerStats(baseStats()).maxStamina + vajra.staminaMax), `stamina +${vajra.staminaMax}`);
  const hitBoth = (weapon, opts = {}) => {
    place(p2, p1, 200);
    return [p1, p2].map(t => {
      const hp0 = t.hp;
      const d = m.applyExplosion(t.cx, t.cy, weapon, e1, t, { directOnly: true, ...opts }).find(x => x.id === t.id);
      return { dmg: hp0 - t.hp, d };
    });
  };
  // 中毒（劇毒撕咬）
  let [a, b] = hitBoth(W.snakeBite);
  assert(p1.poison === 0 && a.d.immune === true && !a.d.poison && a.dmg > 0, 'p1 no poison: ' + J(a));
  assert(p2.poison === W.snakeBite.poison && !b.d.immune, 'p2 poisoned');
  // 流血（大樹守衛的橫劈、獨眼巨人的巨石）
  for (const w of [W.guardianSlash, W.cyclopsBoulder]) {
    [a, b] = hitBoth(w);
    assert(p1.bleed === 0 && a.d.immune === true && !a.d.bleed && a.dmg > 0 && b.d.bleed === w.bleed, `${w.id}: p1 bleed ${p1.bleed}`);
  }
  // 燃燒（爆炸帶的燃燒層數）
  [a, b] = hitBoth(W.sniper, { burn: 30 });
  assert(p1.burn === 0 && a.d.immune === true && p2.burn === 30, 'burn');
  // 傷害 0 的毒液也照樣擋下來
  [a] = hitBoth(W.snakeVenom);
  assert(p1.poison === 0 && a.d.immune === true && a.dmg === 0, 'venom');
  // 不記的：沒有要上的狀態、誤傷、被無敵擋下
  [a] = hitBoth(W.cannon);
  assert(!('immune' in a.d), 'nothing to block');
  const ff = m.applyExplosion(p1.cx, p1.cy, W.snakeBite, p2, p1, { directOnly: true }).find(x => x.id === 'p1');
  assert(!('immune' in ff) && p1.poison === 0, 'friendly hits never poison anyway');
  p1.shield = 1;
  const blocked = m.applyExplosion(p1.cx, p1.cy, W.snakeBite, e1, p1, { directOnly: true }).find(x => x.id === 'p1');
  assert(blocked.blocked && !('immune' in blocked), 'blocked by the shield');
  // 擊退照常
  const k = matchWith({ p1: vajra });
  const kp = k.players[0];
  k.applyExplosion(kp.cx, kp.cy, W.snakeBite, k.enemies[0], kp, { directOnly: true });
  assert(kp.vx !== 0 || kp.vy !== 0, 'still knocked back');
  assert(effectChips(p1, { match: m }).some(c => c.label === '免疫異常'), 'chip');
  return { immune: true };
});

await test('金剛不壞的畫面（真的 GameView）：伺服器記了 immune 的那一下飄「免疫」，沒擋的照樣飄「中毒 +N」', () => {
  const m = matchWith({ p1: cardFx('vajra_body') }, { players: 2 });
  const [p1, p2] = m.players, e1 = m.enemies[0];
  place(p2, p1, 200);
  const ref = new Referee({ match: m, humans: mkPlayers(2), io: new FakeIo() });
  const view = newView('p1');
  view.onMessage({ t: 'start', ...JSON.parse(J(ref.startPayload())) });
  const damages = [p1, p2].flatMap(t => m.applyExplosion(t.cx, t.cy, W.snakeBite, e1, t, { directOnly: true }));
  view.showShotEvent({ actorId: 'e1' }, W.snakeBite, JSON.parse(J({ type: 'pierce', x: p1.cx, y: p1.cy, damages })), {});
  const floats = (id) => view.floatTexts.filter(f => f.id === id).map(f => f.text);
  assert(floats('p1').includes('免疫') && !floats('p1').some(t => /中毒/.test(t)), 'p1 floats ' + floats('p1'));
  assert(floats('p2').includes(`中毒 +${W.snakeBite.poison}`) && !floats('p2').includes('免疫'), 'p2 floats ' + floats('p2'));
  return { p1: floats('p1') };
});

// ---------------- 石假面 ----------------

await test('石假面：自己的回合結束時（額外回合也算）扣目前血量的 N%（四捨五入，照牌上的數值），最多扣到剩 1、不會倒下；不吃無敵、算承受傷害；牌上的傷害吸血', () => {
  const fx = cardFx('stone_mask');
  const m = matchWith({ p1: fx });
  const p = m.players[0];
  assert(fx.lifestealPct > 0 && m.lifestealOf(p) === fx.lifestealPct, `lifesteal ${fx.lifestealPct}%`);
  const drain = (hp, isExtra = false) => { p.hp = hp; const fx = m.endTurn(p, isExtra); return { hp: p.hp, fx: fx.filter(f => f.type === 'stoneMask') }; };
  const n = Math.round(1000 * fx.maskDrainPct / 100);   // 牌上的 % 扣 1000 血
  let r = drain(1000);
  assert(n > 0 && r.hp === 1000 - n && J(r.fx) === J([{ type: 'stoneMask', id: 'p1', dmg: n }]), `${fx.maskDrainPct}% of 1000: ` + J(r));
  r = drain(1000, true);
  assert(r.hp === 1000 - n && r.fx.length === 1, 'extra turns too');
  // 下面的邊界用測試自己的 5%
  p.mods.maskDrainPct = 5;
  assert(drain(10).hp === 9 && drain(21).hp === 20 && drain(30).hp === 28, 'rounded: 0.5 → 1, 1.05 → 1, 1.5 → 2');
  r = drain(2);
  assert(r.hp === 2 && !r.fx.length, '0.1 rounds to 0: nothing (no fx)');
  r = drain(1);
  assert(r.hp === 1 && !r.fx.length && p.alive, 'never below 1');
  p.mods.maskDrainPct = 100;   // 扣得再多也留 1 血
  r = drain(50);
  assert(r.hp === 1 && p.alive && r.fx[0].dmg === 49, '100% leaves 1 hp: ' + J(r));
  p.mods.maskDrainPct = 5;
  p.shield = 2;
  const taken = p.taken;
  r = drain(1000);
  assert(r.hp === 950 && p.shield === 2 && p.taken === taken + 50, 'not blocked by the shield, counts as taken');
  const plain = matchWith({});
  plain.players[0].hp = 1000;
  assert(!plain.endTurn(plain.players[0]).length && plain.players[0].hp === 1000, 'without the card');
  return { drained: n };
});

await test('石假面：裁判的 turn.end 紀錄、turnFx 廣播帶 stoneMask fx；真的 GameView 飄「-N 石假面」、血量照伺服器', () => {
  const n = Math.round(1000 * cardFx('stone_mask').maskDrainPct / 100);   // 牌上的 % 扣 1000 血
  const m = matchWith({ p1: cardFx('stone_mask') }, { hp: 1000 });
  m.planAiTurn = () => ({ walk: null, plan: null });
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: mkPlayers(1), io });
  const view = newView('p1');
  ref.start();
  assert(until(io, () => ref.phase === 'turn' && ref.currentId === 'p1'), 'p1 turn');
  ref.skipTurn('timeout');
  assert(until(io, () => io.recs('turn.end').length > 0), 'turn ended');
  const end = io.recs('turn.end')[0];
  assert(end.fx && end.fx.some(f => f.type === 'stoneMask' && f.id === 'p1' && f.dmg === n) && end.hp === 1000 - n, 'turn.end ' + J(end));
  const fxMsg = io.take('turnFx')[0];
  assert(fxMsg && fxMsg.fx.some(f => f.type === 'stoneMask'), 'turnFx broadcast');
  assert(J(turnFxOps(fxMsg.fx.find(f => f.type === 'stoneMask'), m.byId('p1'))[0]) === J(['float', 'p1', `-${n} 石假面`, '#a8a29e']), 'ops');
  const floats = [];
  const float = view.floatText.bind(view);
  view.floatText = (e, str, ...rest) => { floats.push([e.id, str]); float(e, str, ...rest); };
  feed(view, io.log);
  drain(view);
  assert(J(floats.filter(f => /石假面/.test(f[1]))) === J([['p1', `-${n} 石假面`]]), 'float shown: ' + J(floats));
  assert(view.match.byId('p1').hp === 1000 - n && m.byId('p1').hp === 1000 - n, 'client hp follows the server');
  return { hp: end.hp };
});

// ---------------- 確定性 ----------------

await test('確定性：同一個 seed、帶著這些新牌（含西洋刺劍）的整場 AI 對戰跑兩次，廣播與紀錄一模一樣；牌真的有作用（石假面扣血、受虐疊層）', () => {
  const play = () => {
    const carry = {
      p1: carryOf({ ...cardFx('party_time'), ...cardFx('masochist'), ...cardFx('stone_mask') }, { hp: 400, weapons: ['rapier', 'cannon'] }),
      p2: carryOf({ ...cardFx('intimidate'), ...cardFx('all_out'), ...cardFx('vajra_body'), ...cardFx('marathon_runner') }, { hp: 400, weapons: ['plasma', 'rapier'] }),
    };
    const m = new Match({ levelId: 'level2', players: mkPlayers(2), seed: 17, carry, config: CFG });
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: mkPlayers(2), io });
    ref.start();
    for (const p of mkPlayers(2)) ref.setConnected(p.id, false);
    for (let k = 0; k < 600 && ref.phase !== 'over'; k++) io.advance(250);
    return { log: J(io.log), recs: J(io.records), io, m };
  };
  const a = play(), b = play();
  assert(a.log === b.log && a.recs === b.recs, 'two runs differ');
  const ends = a.io.recs('turn.end').flatMap(r => r.fx || []);
  assert(ends.some(f => f.type === 'stoneMask'), 'the stone mask drained');
  const hs = a.io.log.flatMap(x => x.results || x.entities || []).filter(s => s.id === 'p1').map(s => s.hs || 0);
  assert(Math.max(...hs) > 0, 'masochist stacks went up');
  return { messages: a.io.log.length, rounds: a.m.round, result: a.m.result() };
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
