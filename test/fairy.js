// node test/fairy.js
// 2026-11-03：菁英關「調皮妖精」（森林，莫利亞森林的菁英池）。
// 關卡（菁英池、蘑菇平台、本尊 + 兩個分身 fixed、血量照一般敵人放大、分身不擋過關）、閃現（三個落點彼此隔 150、在 roam 裡、哪個是本尊隨機、分身復活、燃燒熄掉）、
// 咬耳朵（多人才有、每次閃現重抽不連續同一人、生氣了就沒有）、打到分身（爆炸炸到附近的玩家含開槍的人、傷害不算開槍的人的、多人才魅惑）、
// 同一下打到本尊 + 分身只算本尊、本尊被打到分身消失、40% 以下生氣、魅惑（遊戲接手：用當下的武器打隊友、70% 瞄準、沒隊友不開火、回合結束解除）、
// 她的招式（星屑彈一定飛得到目標、調包互換位置 + 傷害、只剩一人只用星屑彈）、客戶端重播一致、快照 / 重連、
// 裁判（被魅惑的回合 turn.start / ai.turn 帶 forced、turn 帶說明）、全員 AI 代打、真的 GameView（沒有腳本錯誤、狀態跟伺服器一樣、HUD）
import { CONFIG } from '../shared/core/config.js';
import { LEVELS, levelsInPool } from '../shared/maps/level.js';
import { Match } from '../shared/game/match.js';
import { Referee } from '../shared/game/referee.js';
import { planShot, planShotAt } from '../shared/ai/ai.js';
import { FAIRY_ID, FAIRY_CLONE_IDS, fairyOf, clonesOf, blinkStep, fairyDamage } from '../shared/maps/fairy.js';
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

class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.records = []; this.seq = 0; }
  broadcast(msg) { this.log.push(JSON.parse(J(msg))); }
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
}
const mkPlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
const make = (n = 1, opts = {}) => new Match({ levelId: 'forestFairy', players: mkPlayers(n), seed: 1, stage: 3, ...opts });
// 測試不吃使用者在 config 調的數值：需要的值自己設，跑完還原
function withConfig(patch, fn) {
  const saved = Object.fromEntries(Object.keys(patch).map(k => [k, { ...CONFIG[k] }]));
  for (const [k, v] of Object.entries(patch)) Object.assign(CONFIG[k], v);
  const restore = () => { for (const [k, v] of Object.entries(saved)) { for (const key of Object.keys(CONFIG[k])) if (!(key in v)) delete CONFIG[k][key]; Object.assign(CONFIG[k], v); } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}
const FAIRY = {
  hp: 150, weights: { star: 60, swap: 40 }, clones: 2, blinkGap: 150, playerGap: 60, angryPct: 0.4, charmHit: 0.7, missOffset: 130,
  cast: { star: 1.0, swap: 1.1, blink: 0.9 },
};
const BASE = {
  ENEMY: { hp: 45, damageMult: 0.7, lateFromStage: 6, damageMultLate: 1 },
  RUN: { stageCount: 10, bossStages: [5, 10], eliteStages: [3, 8], enemyHpPerStage: 0.15 },
  FAIRY,
  PLAYER: { hp: 150, stamina: 200 }, FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },
  WEAPONS: {
    cannon: { ...CONFIG.WEAPONS.cannon, damage: 30, radius: 42, knockback: 180, gravity: 600 },
    sniper: { ...CONFIG.WEAPONS.sniper },
    fairyStar: { ...CONFIG.WEAPONS.fairyStar, damage: 10, radius: 26, knockback: 60, speed: 900, hitRadius: 7 },
    fairySwap: { ...CONFIG.WEAPONS.fairySwap, damage: 5, knockback: 0 },
    fairyBlast: { ...CONFIG.WEAPONS.fairyBlast, damage: 15, radius: 80, knockback: 160 },
  },
};
const base = (fn, extra = {}) => {
  const patch = { ...BASE };
  for (const [k, v] of Object.entries(extra)) patch[k] = { ...(BASE[k] || {}), ...v };
  return withConfig(patch, fn);
};
const only = (action) => ({ FAIRY: { ...FAIRY, weights: { star: 0, swap: 0, [action]: 1 } } });
// 把角色放到 (x, y) 正下方站好
function placeOn(m, e, x, y = 500) {
  e.x = x; e.y = y; e.vx = 0; e.vy = 0; e.onGround = false;
  for (let i = 0; i < 400 && !e.onGround; i++) e.update(CONFIG.FIXED_DT, m.world);
  e.safeX = e.x; e.safeY = e.y;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// 讓妖精出一回合（不經過裁判），客戶端從出招前的快照照事件一招一招重播、套結果，跟伺服器一樣
function fairyTurn(m) {
  const before = JSON.parse(J(m.snapshot()));
  const r = m.mechanic.aiTurn(m, fairyOf(m));
  const c = make(m.players.length, { seed: m.seed });
  c.applySnapshot(before);
  for (const st of r.steps) {
    if (st.shot) {
      const shot = JSON.parse(J(st.shot));
      replayChecked(c, shot, st.action);
      c.applyEntities(shot.results);
    } else c.applyEntities(JSON.parse(J(st.still.results)));
  }
  const label = r.steps.map(st => st.action).join('+');
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), `${label}: entities differ`);
  return { steps: r.steps, main: r.steps[0], blink: r.steps.find(st => st.action === 'blink') };
}
// 一名玩家開一槍（直接結算），客戶端重播一樣
function shoot(m, shooter, target, weapon = 'sniper') {
  const plan = planShotAt(m.world, shooter, m.rng, target, weapon);
  const before = JSON.parse(J(m.snapshot()));
  const shot = m.resolveShot(shooter, plan.weapon, plan.angle, plan.power);
  const c = make(m.players.length, { seed: m.seed });
  c.applySnapshot(before);
  const copy = JSON.parse(J(shot));
  replayChecked(c, copy, 'player shot');
  c.applyEntities(copy.results);
  assert(J(m.entities.map(e => e.toState())) === J(c.entities.map(e => e.toState())), 'shot replay differs');
  assert(J(c.mechState.charm) === J(m.mechState.charm) && c.mechState.revealed === m.mechState.revealed, 'client mech state ' + J([c.mechState.charm, m.mechState.charm]));
  return shot;
}
const fairyFx = (shot) => shot.events.filter(ev => ev.fairy).map(ev => ev.fairy);
const stageInfo = () => ({ stage: 3, stageCount: 10, isBoss: false, type: 'elite', difficulty: 'normal', levelId: 'forestFairy', levelName: '調皮妖精', cards: {} });

// ---------------- 關卡、妖精 ----------------

await test('關卡：菁英池（不在小關 / Boss 池、莫利亞森林的菁英清單裡）、地圖機制 fairy、蘑菇平台；本尊 + 兩個分身（fixed、分身 1 滴血、不會輪到、不擋過關、不算擊殺、AI 不打）；血量 150 × 一般敵人的倍率', () => base(() => {
  const L = LEVELS.forestFairy;
  assert(levelsInPool('elite').includes('forestFairy') && !levelsInPool('normal').includes('forestFairy') && L.name === '調皮妖精' && L.theme === 'forest', 'pool');
  assert(CONFIG.THEMES.moria.maps.elite.includes('forestFairy'), 'moria elites');
  assert(L.platformStyle === 'mushroom' && L.platforms.length === 3 && L.mechanic.type === 'fairy', 'level');
  const m = make(2);
  const g = fairyOf(m);
  const clones = clonesOf(m);
  assert(g && g.fixed && g.team === 'enemies' && !g.optional && clones.length === 2, 'built');
  assert(clones.every(c => c.hp === 1 && c.maxHp === 1 && c.fixed && c.noTurn && c.optional && c.noKill && c.decoy && c.allyPass && c.name === g.name), 'clones');
  const solo = make(1);
  assert(fairyOf(solo).maxHp >= 150 && fairyOf(solo).maxHp < g.maxHp && g.maxHp / fairyOf(solo).maxHp > 1.5, 'hp scales ' + [fairyOf(solo).maxHp, g.maxHp]);
  for (const c of clones) c.die('hit');
  m.byId(FAIRY_ID).die('hit');
  assert(m.result() === 'win', 'killing the real one wins');
}));

await test('閃現：開場就閃現一次；三個落點都在 roam 裡、彼此至少隔 150；哪一個是本尊隨機（各種都出現）；倒下的分身復活回 1 滴血；本尊的流血、糾纏清掉（燃燒留著）', () => base(() => {
  const m = make(3);
  const R = LEVELS.forestFairy.mechanic.roam;
  const realAt = new Set();
  for (let k = 0; k < 40; k++) {
    clonesOf(m)[0].die('hit');
    Object.assign(fairyOf(m), { burn: 3, bleed: 4, entangle: 2 });
    const st = blinkStep(m);
    const ents = [fairyOf(m), ...clonesOf(m)];
    assert(st.spots.length === 3 && ents.every(e => e.x >= R.x0 && e.x <= R.x1 && e.y >= R.y0 && e.y <= R.y1), 'in roam ' + J(st.spots));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert(dist(ents[i], ents[j]) >= 150, 'gap ' + J(st.spots));
    assert(clonesOf(m).every(c => c.alive && c.hp === 1) && fairyOf(m).burn === 3 && fairyOf(m).bleed === 0 && fairyOf(m).entangle === 0, 'revived + statuses');
    realAt.add(st.spots.slice().sort((a, b) => a.x - b.x).findIndex(s => s.id === FAIRY_ID));   // 本尊是三個裡面左 / 中 / 右的哪一個
  }
  assert(realAt.size === 3, 'real one in every slot ' + [...realAt]);
}));

await test('咬耳朵：多人每次閃現都挑一名活著的玩家、不連續同一人（只剩一人就還是他）；單人沒有；生氣了（40% 以下）就沒有', () => base(() => {
  const m = make(3);
  let prev = m.mechState.whisper;
  assert(typeof prev === 'string', 'opening whisper');
  const seen = new Set([prev]);
  for (let k = 0; k < 30; k++) {
    const st = blinkStep(m);
    assert(st.whisper && st.whisper !== prev && m.mechState.whisper === st.whisper, 'not twice in a row');
    seen.add(st.whisper);
    prev = st.whisper;
  }
  assert(seen.size === 3, 'everyone gets a turn');
  m.byId('p2').die('hit');
  m.byId('p3').die('hit');
  assert(blinkStep(m).whisper === 'p1' && blinkStep(m).whisper === 'p1', 'only one left');
  assert(make(1).mechState.whisper === null && blinkStep(make(1)).whisper === null, 'solo: nobody');
  const n = make(2);
  const g = fairyOf(n);
  placeOn(n, n.players[0], 300);
  n.applyExplosion(g.cx, g.cy, { ...CONFIG.WEAPONS.cannon, damage: g.hp * 0.7, radius: 0 }, n.players[0], g, { directOnly: true });
  assert(n.mechState.angry && n.mechState.whisper === null, 'angry');
  assert(J(n.mechanic.eventExtras(n, {})) === J({ fairy: { vanish: FAIRY_CLONE_IDS, angry: true, revealed: true } }), 'event says angry once');
  assert(J(n.mechanic.eventExtras(n, {})) === J({}), 'only once');
  assert(blinkStep(n).whisper === null && blinkStep(n).whisper === null, 'angry: no more whispers');
}));

await test('打到分身：分身倒下、在它的位置爆炸（炸到附近的玩家，含開槍的人；照距離遞減）、傷害不算開槍的人的（結算、命中都不算）；多人 → 開槍的人被魅惑（他自己的回合結束之後才生效）；單人只爆炸；爆炸的攻擊者是分身', () => base(() => {
  for (const n of [2, 1]) {
    const m = make(n);
    const p1 = m.players[0];
    placeOn(m, p1, 300);
    if (n > 1) placeOn(m, m.players[1], 120);
    const [c1] = clonesOf(m);
    c1.x = p1.x + 60; c1.y = p1.y - 20;   // 貼在開槍的人旁邊：炸得到他
    const g = fairyOf(m);
    g.x = 800; g.y = 320;
    clonesOf(m)[1].x = 600; clonesOf(m)[1].y = 320;
    const hp0 = p1.hp;
    const shot = shoot(m, p1, c1);
    const fx = fairyFx(shot);
    assert(!c1.alive && fx.length === 1 && fx[0].blasts && fx[0].blasts[0].id === c1.id && fx[0].blasts[0].by === 'p1', `${n}: blast ` + J(fx));
    const want = Math.round(fairyDamage(m, CONFIG.WEAPONS.fairyBlast) * 0.7 * 0.3);
    assert(p1.hp < hp0 && hp0 - p1.hp >= want, `${n}: the shooter is caught ${hp0 - p1.hp}`);
    assert(p1.dealt === 0 && shot.hitEnemy === false && p1.hits === 0, `${n}: not credited ` + J([p1.dealt, shot.hitEnemy]));
    assert(shot.events.flatMap(ev => ev.damages || []).filter(d => d.id === 'p1').every(d => d.noCredit), 'marked');
    if (n > 1) {
      assert(fx[0].blasts[0].charm === 'p1' && m.mechState.charm.p1 && m.takeover(p1) === null, 'charmed, but not this turn');
      const tfx = [];
      m.mechanic.turnEnd(m, p1, tfx);
      assert(m.takeover(p1).reason === 'charm' && !tfx.length, 'armed for his next turn');
    } else assert(!fx[0].blasts[0].charm && !m.mechState.charm.p1 && m.takeover(p1) === null, 'solo: no charm');
    assert(p1.dealt === 0 && clonesOf(m)[1].dealt === 0, 'the clone is the attacker');
    assert(g.alive && clonesOf(m)[1].alive, 'others untouched');
  }
}));

await test('同一下打到本尊 + 分身：只算本尊（分身消失、不爆炸、不魅惑）；本尊被打到 → 分身全部消失（revealed）；她自己的攻擊碰不到分身', () => base(() => {
  const m = make(2);
  const p1 = m.players[0];
  placeOn(m, p1, 300);
  const g = fairyOf(m);
  const [c1, c2] = clonesOf(m);
  g.x = 600; g.y = 400; c1.x = 630; c1.y = 400; c2.x = 850; c2.y = 330;
  const W = { ...CONFIG.WEAPONS.cannon, radius: 60 };
  const dm = m.applyExplosion(615, 385, W, p1, null);
  const fx = m.mechanic.eventExtras(m, { damages: dm });
  assert(!c1.alive && !c2.alive && c1.deathCause === 'vanish' && g.hp < g.maxHp, 'clones vanished ' + J(dm));
  assert(J(fx) === J({ fairy: { vanish: FAIRY_CLONE_IDS, revealed: true } }) && !m.mechState.charm.p1 && m.mechState.revealed, 'no blast, no charm ' + J(fx));
  blinkStep(m);
  assert(clonesOf(m).every(c => c.alive) && !m.mechState.revealed, 'back after the blink');
  const [d1] = clonesOf(m);
  const r = m.applyExplosion(d1.cx, d1.cy, { ...CONFIG.WEAPONS.fairyStar, damage: 50 }, g, d1);
  assert(d1.alive && d1.hp === 1 && !r.some(x => x.id === d1.id && x.dmg > 0), 'her own shot passes');
}));

await test('魅惑：輪到他時由遊戲接手（planAiTurn 不走動、forced 帶目標）；charmHit 1 → 用他當下的武器打中隊友（誤傷）、0 → 打偏不直接打中（拋射、直線都是）；沒有活著的隊友 → 不開火；回合結束解除（charmEnd）', () => base(() => {
  const out = {};
  for (const [hit, weapon] of [[1, 'cannon'], [0, 'cannon'], [1, 'sniper'], [0, 'sniper']]) {
    withConfig({ FAIRY: { ...FAIRY, charmHit: hit } }, () => {
      const m = make(2);
      const [p1, p2] = m.players;
      placeOn(m, p1, 200); placeOn(m, p2, 420);
      p1.weapon = weapon;
      m.mechState.charm.p1 = { armed: true, used: false };
      const t = m.planAiTurn(p1);
      assert(t.walk === null && t.plan && t.plan.weapon === weapon && t.forced.charm && t.forced.targetId === 'p2' && t.forced.aimed === !!hit, 'forced plan ' + J(t.forced));
      const shot = m.resolveShot(p1, t.plan.weapon, t.plan.angle, t.plan.power);
      const onP2 = shot.events.some(ev => ev.type !== 'pass' && ev.target === 'p2');
      if (hit) assert(onP2 && p2.hp < p2.maxHp && shot.events.flatMap(ev => ev.damages || []).some(d => d.id === 'p2' && d.friendly), 'hit the mate');
      else assert(!onP2, 'missed on purpose');
      out[`${weapon}:${hit ? 'aimed' : 'miss'}`] = [shot.hit.type, Math.round(shot.hit.x)];
      const tfx = [];
      m.mechanic.turnEnd(m, p1, tfx);
      assert(!m.mechState.charm.p1 && m.takeover(p1) === null && J(tfx) === J([{ type: 'charmEnd', id: 'p1' }]), 'cleared ' + J(tfx));
    });
  }
  const m = make(2);
  m.byId('p2').die('hit');
  m.mechState.charm.p1 = { armed: true, used: false };
  const t = m.planAiTurn(m.byId('p1'));
  assert(t.plan === null && t.forced.charm && !t.forced.targetId, 'no mate: no shot');
  m.mechState.charm.p1 = { armed: false, used: false };
  assert(m.takeover(m.byId('p1')) === null, 'not armed yet');
  m.mechanic.turnEnd(m, m.byId('p1'), []);
  assert(m.mechState.charm.p1 && m.mechState.charm.p1.armed, 'charmed during his own turn: armed for the next one');
  return out;
}));

await test('她的回合：星屑彈（穿過地形，一定飛得到目標）、調包（兩個人互換位置、各扣 5 × 人數 × 倍率）；出完招都會閃現；只剩一人活著只用星屑彈；客戶端照事件重播一樣', () => base(() => {
  const m = make(3);
  for (const p of m.players) p.hp = p.maxHp = 1000;
  placeOn(m, m.players[0], 100); placeOn(m, m.players[1], 300); placeOn(m, m.players[2], 860);
  const out = {};
  withConfig(only('star'), () => {
    for (let k = 0; k < 4; k++) {
      const hp = m.players.map(p => p.hp);
      const r = fairyTurn(m);
      const t = m.byId(r.main.targetId);
      assert(r.main.action === 'star' && r.blink && t.hp < hp[m.players.indexOf(t)], 'star hit ' + J(r.main.targetId));
    }
  });
  withConfig(only('swap'), () => {
    const pos = Object.fromEntries(m.players.map(p => [p.id, [p.x, p.y]]));
    const hp = Object.fromEntries(m.players.map(p => [p.id, p.hp]));
    const r = fairyTurn(m);
    const [a, b] = r.main.ids.map(id => m.byId(id));
    assert(r.main.action === 'swap' && Math.abs(a.x - pos[b.id][0]) < 2 && Math.abs(b.x - pos[a.id][0]) < 2, 'swapped ' + J([pos, a.x, b.x]));
    const want = Math.round(5 * 3 * 0.7);
    assert(hp[a.id] - a.hp === want && hp[b.id] - b.hp === want && r.main.damages.length === 2, 'swap damage ' + J(r.main.damages));
    out.swap = r.main.ids;
    m.players[1].die('hit'); m.players[2].die('hit');
    for (let k = 0; k < 3; k++) assert(fairyTurn(m).main.action === 'star', 'only one left: star');
  });
  return out;
}));

await test('快照 / 重連：咬耳朵的人、生氣、現形、被魅惑的人照快照；分身的位置、死活照角色狀態；只帶一部分欄位不動', () => base(() => {
  const m = make(3);
  m.mechState.charm.p2 = { armed: true, used: true };
  m.mechState.angry = true;
  clonesOf(m)[0].die('hit');
  const snap = JSON.parse(J(m.snapshot()));
  assert(J(snap.fairy) === J({ whisper: m.mechState.whisper, lastWhisper: m.mechState.lastWhisper, angry: true, revealed: false, charm: { p2: { armed: true, used: true } } }), 'snapshot ' + J(snap.fairy));
  const c = make(3, { seed: 9 });
  c.applySnapshot(snap);
  assert(c.mechState.whisper === m.mechState.whisper && c.mechState.angry && J(c.mechState.charm) === J(m.mechState.charm), 'restored');
  assert(J(c.entities.map(e => e.toState())) === J(m.entities.map(e => e.toState())), 'entities');
  c.mechanic.restore(c, { items: [] });
  assert(c.mechState.angry && c.mechState.charm.p2, 'partial: untouched');
}));

await test('燃燒：本尊的燃燒在閃現之前（舊的位置）結算一次（blink 帶 burn），回合結束的燃燒結算不再燒；之後層數放回去，下一回合照燒', () => base(() => {
  const m = make(2);
  for (const p of m.players) p.hp = p.maxHp = 1000;
  const g = fairyOf(m);
  g.burn = 4;
  g.burnSource = 'p1';
  const hp0 = g.hp;
  const r = fairyTurn(m);
  assert(r.blink && r.blink.burn && r.blink.burn.dmg > 0 && g.hp === hp0 - r.blink.burn.dmg && g.burn === 0, 'burnt before the blink ' + J(r.blink && r.blink.burn));
  const fx = m.endTurn(g);
  assert(!fx.some(f => f.type === 'burn') && g.burn === 4 && g.hp === hp0 - r.blink.burn.dmg, 'no second tick, stacks back ' + J(fx));
  assert(m.byId('p1').dealt === r.blink.burn.dmg, 'credited to the igniter');
  return { dmg: r.blink.burn.dmg };
}));

await test('代打的玩家：不知道哪個是本尊（沒被咬耳朵、本尊沒現形）就在三個裡隨機挑；被咬耳朵的、本尊現形了照一般 AI（打本尊）', () => base(() => {
  const m = make(2);
  const p1 = m.players[0];
  placeOn(m, p1, 200);
  m.mechState.whisper = 'p2';
  const picked = new Set();
  for (let k = 0; k < 40; k++) {
    const t = m.planAiTurn(p1);
    assert(t.walk === null && t.plan && !t.forced, 'picked by the mechanic');
    picked.add(t.plan.targetId);
  }
  assert(picked.size === 3, 'any of the three ' + [...picked]);
  m.mechState.whisper = 'p1';
  for (let k = 0; k < 10; k++) { const t = m.planAiTurn(p1); assert(!t.plan || t.plan.targetId === FAIRY_ID, 'knows'); }
  m.mechState.whisper = 'p2';
  m.mechState.revealed = true;
  for (let k = 0; k < 10; k++) { const t = m.planAiTurn(p1); assert(!t.plan || t.plan.targetId === FAIRY_ID, 'revealed'); }
  return { picked: [...picked] };
}));

// ---------------- 裁判 ----------------

function rig(n = 2, setup = () => {}) {
  const players = mkPlayers(n);
  const m = new Match({ levelId: 'forestFairy', players, seed: 2, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 2000; }
  setup(m);
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  return { m, io, ref };
}

await test('裁判：被魅惑的人（回合開始前才被魅惑的：先打完自己這一回合）下一回合由遊戲接手（他送 fire 不收）：turn 帶 ai + forced（說明「被魅惑了」）、turn.start 記 forced charm（不是 takeover）、ai.turn 記 forced（目標、有沒有瞄準）；回合結束解除', () => base(() => {
  const { m, io, ref } = rig(2, (m) => { m.mechState.charm.p1 = { armed: false, used: false }; });
  ref.start();
  io.advance(CONFIG.TIMING.startDelay * 1000 + 10);
  const first = io.log.find(x => x.t === 'turn' && x.actorId === 'p1');
  assert(first && first.ai === false && !first.forced, 'his own turn first ' + J(first && first.forced));
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 80, power: 10 });
  for (let k = 0; k < 400 && io.log.filter(x => x.t === 'turn' && x.actorId === 'p1').length < 2; k++) io.advance(250);
  const turn = io.log.filter(x => x.t === 'turn' && x.actorId === 'p1')[1];
  assert(turn && turn.ai === true && turn.forced && turn.forced.reason === 'charm' && turn.forced.label === '被魅惑了', 'turn ' + J(turn && turn.forced));
  const ts = io.records.filter(r => r.ev === 'turn.start' && r.pid === 'p1')[1];
  assert(ts.forced === 'charm' && ts.ai === true && !ts.takeover, 'turn.start ' + J(ts));
  ref.handle('p1', { t: 'fire', weapon: 'cannon', angle: 45, power: 50 });
  assert(io.records.at(-1).ev === 'action.ignored', 'his own fire is ignored');
  const at = io.records.find(r => r.ev === 'ai.turn' && r.pid === 'p1');
  assert(at && at.forced && at.forced.charm && at.forced.targetId === 'p2' && typeof at.forced.aimed === 'boolean' && !at.takeover, 'ai.turn ' + J(at));
  for (let k = 0; k < 40 && ref.currentId === 'p1'; k++) io.advance(250);
  assert(!m.mechState.charm.p1 && io.log.some(x => x.t === 'turnFx' && x.fx.some(f => f.type === 'charmEnd' && f.id === 'p1')), 'cleared after his turn (charmEnd)');
  ref.stop();
}));

await test('裁判：全員 AI 代打打幾輪（2 人）；星屑彈 + 調包都出現、每回合兩招（招式 + 閃現）；沒有丟錯；AI 挑目標不挑分身', () => base(() => {
  const seen = new Set();
  let cloneHits = 0;
  for (const seed of [1, 2, 3]) {
    const players = mkPlayers(2);
    const m = new Match({ levelId: 'forestFairy', players, seed, stage: 3 });
    for (const p of m.players) { p.hp = p.maxHp = 4000; }
    const io = new FakeIo();
    const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
    ref.start();
    for (const p of players) ref.setConnected(p.id, false);
    for (let k = 0; k < 300 && ref.phase !== 'over'; k++) io.advance(500);
    const turns = io.log.filter(x => x.t === 'aiTurn' && x.actorId === FAIRY_ID);
    assert(turns.length >= 5, `seed ${seed}: turns ${turns.length}`);
    for (const t of turns) {
      const st = t.boss.steps;
      assert(st.length === 2 && st[1].action === 'blink' && st.every(s => s.cast > 0 && (s.shot || s.still)), 'move + blink ' + J(st.map(s => s.action)));
      seen.add(st[0].action);
    }
    ref.stop();
  }
  assert(seen.has('star') && seen.has('swap'), 'both moves ' + [...seen]);
  // AI（斷線代打）挑目標不挑分身（打歪了還是可能碰到，那是運氣）
  const m = make(2);
  placeOn(m, m.players[0], 200);
  for (let k = 0; k < 60; k++) {
    const plan = planShot(m.world, m.players[0], m.rng);
    if (plan) assert(plan.targetId === FAIRY_ID, 'targets the real one ' + plan.targetId);
    else cloneHits++;
  }
  return { noPlan: cloneHits };
}));

// ---------------- 真的 GameView ----------------
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
function mkView(myId = 'p1') {
  const view = new GameView(fakeCanvas());
  view.music = { play() {}, setRate() {} };
  view.myId = myId;
  view.transport = { send() {} };
  return view;
}

await test('真的 GameView：妖精從開場播幾輪（全員 AI 代打，中途魅惑一人；每幀 update + render）：沒有腳本錯誤；本尊與分身的位置、死活，咬耳朵的人、被魅惑的人跟伺服器一樣；菁英關橫幅；HUD', () => base(() => {
  const players = mkPlayers(3);
  const m = new Match({ levelId: 'forestFairy', players, seed: 3, stage: 3 });
  for (const p of m.players) { p.hp = p.maxHp = 5000; }
  const io = new FakeIo();
  const ref = new Referee({ match: m, humans: players, io, stageInfo: stageInfo() });
  ref.start();
  const view = mkView();
  const feed = () => { for (const msg of io.log.splice(0)) view.onMessage(msg); };
  feed();
  assert(view.mapView.type === 'fairy' && view.banner && view.banner.text === '菁英關：調皮妖精', 'elite banner: ' + J(view.banner && view.banner.text));
  for (const p of players) ref.setConnected(p.id, false);
  m.mechState.charm.p2 = { armed: true, used: false };
  view.match.mechState.charm.p2 = { armed: false, used: false };   // 客戶端照事件拿到的（不知道 armed）
  const err = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(' '));
  const seen = new Set();
  try {
    for (let k = 0; k < 400 && ref.phase !== 'over'; k++) {
      io.advance(250);
      for (const t of io.log.filter(x => x.t === 'aiTurn' && x.actorId === FAIRY_ID)) t.boss.steps.forEach(st => seen.add(st.action));
      feed();
      for (let f = 0; f < 15; f++) { view.update(CONFIG.FIXED_DT); view.render(); }
      if (seen.has('star') && seen.has('swap') && k > 80) break;
    }
    feed();
    for (let f = 0; f < 1800; f++) view.update(CONFIG.FIXED_DT);
    view.render();
  } finally { console.error = err; }
  assert(!errors.length, 'script errors ' + errors[0]);
  assert(seen.has('blink') && (seen.has('star') || seen.has('swap')), 'played: ' + [...seen]);
  const S = view.match.mechState, T = m.mechState;
  assert(S.whisper === T.whisper && J(Object.keys(S.charm)) === J(Object.keys(T.charm)), 'mech state synced ' + J([S.whisper, T.whisper, S.charm, T.charm]));
  const ents = (mm) => [FAIRY_ID, ...FAIRY_CLONE_IDS].map(id => mm.byId(id)).map(e => [e.id, e.x, e.y, e.hp, e.alive]);
  assert(J(ents(view.match)) === J(ents(m)), 'fairies synced ' + J([ents(view.match), ents(m)]));
  assert(view.match.players.every(p => p.hp === m.byId(p.id).hp), 'players synced');
  const hud = view.mapView.hud(view.mapCtx, ['x', '#fff']);
  if (fairyOf(m).alive) assert(/^調皮妖精 \d+ \/ \d+$/.test(hud[1][0]) && (T.angry || /^咬耳朵：P\d/.test(hud[2][0])), 'hud ' + J(hud));
  return { moves: [...seen], charmTurns: io.records.filter(r => r.ev === 'turn.start' && r.forced === 'charm').length };
}));

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
