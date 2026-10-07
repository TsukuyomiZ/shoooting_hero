// node test/effects.js
// 效果（shared/effects/，見 GLOSSARY.md）：一個效果一個檔案 + 登記表（index.js）。這裡檢查：
// 新增效果（effects/ 一個檔案 + LIST 最後一行 + README 表一列 + 牌）不用改這個檔案：以前的清單只檢查「還在、排在最前面」，
// 新的效果排在後面；要逐項檢查的清單（架構檢查的字、同步欄位）都從登記表現算。
// - 登記表涵蓋 cards.json 用到的每個 key；以前 EFFECT_KEYS 的每個 key 都在（說明一字不差）而且排在最前面；
//   key / 效果 id / 狀態欄位 / 同步欄位都不重複
// - 從登記表算出來的 DEFAULT_MODS / 立即效果 / 武器限定 / 多人限定以以前寫死的清單開頭（DEFAULT_MODS 連順序都一樣：會上網路）
// - 同步格式不變：toState 以前的欄位與順序（只多出效果狀態的同步欄位）、效果自己的狀態經登記表建立 / 同步、derivePlayerStats 的欄位順序
// - README 的效果表：登記表的每個 key 一列、說明一字不差，沒有多的列
// - 寫錯名字的掛勾、重複的 key 載入時就丟錯；說明裡每個掛勾都有寫到
// - 寫錯的效果狀態（跟角色的欄位 / 同步欄位撞名、after 寫錯）、要指定隊友卻沒有 pickText 的效果，載入時就丟錯
// - 在一份測試用的副本裡加一個假效果（一個新檔案 + 登記表一行）：選牌 → 戰鬥（傷害、自己的狀態、同步）→ 狀態列，全部接得起來
// - 架構檢查：shared/、client/、server/ 底下所有的程式碼（effects/、config.js 之外；註解除外）不提任何一個效果 key、
//   效果自己的狀態欄位與同步欄位（從登記表現算；跟 key 同名的通用欄位 / 同步訊息的欄位名只准照固定的寫法出現）、
//   不讀 mods.<key>（entities.js 的二段跳次數除外）、run.js 不讀選牌的 now.<key>；entities.js 不宣告這些欄位；效果不往上 import
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG } from '../shared/config.js';
import { Match } from '../shared/match.js';
import {
  EFFECTS, EFFECT_KEYS, INSTANT_KEYS, WEAPON_ONLY_KEYS, TEAM_ONLY_KEYS, DEFAULT_MODS, HOOK_NAMES, STATUS_CHIP_ORDER, effectOf,
} from '../shared/effects/index.js';
import { validateCards, baseStats, derivePlayerStats, applyCard } from '../shared/cards.js';
import { DEFAULT_MODS as ENTITY_DEFAULT_MODS } from '../shared/entities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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

// 效果模組化之前 cards.js / entities.js 寫死的清單（登記表算出來的要以它們開頭：以前的一個不少、順序不變，新的效果只排在後面）
const OLD_EFFECT_KEYS = {
  maxHp:            '血量上限 +N（同時回 N 血）',
  heal:             '立刻回血 N',
  healPct:          '立刻回血，上限的 N%',
  teamHealPct:      '全隊（含自己）立刻回復各自上限 N% 的血',
  damagePct:        '所有武器傷害 +N%',
  cannonDamagePct:  '大砲傷害 +N%',
  sniperDamagePct:  '狙擊槍傷害 +N%',
  bossDamagePct:    '對首領傷害 +N%',
  rampDamagePct:    '武器傷害每回合成長 N%（自己的第 1 回合 +N%、第 2 回合 +2N%…）',
  rampDamageMaxPct: '上面「每回合成長」的上限 %',
  killDamagePct:    '每擊殺一個敵人，武器傷害再 +N%（整場冒險累積）',
  lifestealPct:     '傷害吸血：對敵人造成傷害的 N% 回復自己',
  radiusPct:        '大砲爆炸半徑 +N%',
  knockbackPct:     '擊退力道 +N%',
  sniperBounce:     '狙擊槍子彈碰到地形可以彈射 N 次',
  sniperPierce:     '狙擊槍子彈穿透角色（填 1）',
  burnStacks:       '武器擊中的敵人附加 N 層燃燒',
  cannonBurnStacks: '大砲擊中的敵人附加 N 層燃燒',
  armorPct:         '受到的傷害 -N%',
  friendlyArmorPct: '受到的隊友誤傷再 -N%',
  regenPct:         '自己的回合開始時回復上限 N% 的血',
  staminaMax:       '體力上限 +N',
  moveSpeedPct:     '移動速度 +N%',
  jumpSpeedPct:     '跳躍力 +N%',
  extraJumps:       '在空中可以再跳 N 次（1 = 二段跳；每次一樣消耗跳躍體力，落地補滿）',
  sizePct:          '體型 +N%（越大越好被打中）',
  turnTime:         '每回合秒數 +N',
  extraTurn:        `自己的回合結束後再獲得一個額外回合（填 1；之後冷卻 ${CONFIG.EQUIP.extraTurnCooldown} 個回合）`,
  bombard:          '自己的回合開始時，自己以外的區域落下轟炸飛彈（填 1）',
  teamShield:       `每過 ${CONFIG.EQUIP.shieldEveryTurns} 個自己的回合，全隊獲得 N 次無敵（擋下一次傷害）`,
  allyHeal:         '隊友（不含自己）立刻各回血 N',
  nextDamagePct:    '下一關武器傷害 +N%（打完那一關就失效）',
  nextMaxHp:        '下一關血量上限 +N（開打時同時回 N 血；打完那一關就失效，超過原本上限的血會被扣掉）',
  cannonBounce:     '大砲砲彈碰到地形可以彈射 N 次',
  loneDamagePct:    '場上沒有活著的隊友時（單人一直算），武器傷害 +N%',
  loneLifestealPct: '場上沒有活著的隊友時（單人一直算），傷害吸血 +N%',
  allyDamagePct:    '場上每有一名活著的隊友，武器傷害 +N%',
  allyArmorPct:     '場上每有一名活著的隊友，受到的傷害 -N%（只算自己）',
  feverDamagePct:   '狂熱生效時（一般小關第 11 輪起；Boss 關沒有狂熱），武器傷害再 +N%',
  fullArc:          '拋射武器（大砲等）的瞄準預覽畫出完整拋物線直到落點（填 1）',
  missDamagePct:    '每次射擊沒打中敵人得到一層「準備」，每層武器傷害 +N%；打中敵人就歸零',
  missMaxStacks:    '上面「準備」最多幾層',
  hitDamagePct:     '每次射擊打中敵人得到一層「狂獵」，每層武器傷害 +N%；沒打中就歸零',
  hitMaxStacks:     '上面「狂獵」最多幾層',
  link:             `選牌時指定一名隊友「連結」（填 1）：兩人受到的傷害先 -${CONFIG.EQUIP.link.damageCutPct}%，再跟活著的連結對象平分`,
};
const OLD_INSTANT = ['heal', 'healPct', 'teamHealPct', 'allyHeal', 'nextDamagePct', 'nextMaxHp', 'link'];
const OLD_WEAPON_ONLY = {
  cannonDamagePct: 'cannon', radiusPct: 'cannon', cannonBurnStacks: 'cannon', cannonBounce: 'cannon',
  sniperDamagePct: 'sniper', sniperBounce: 'sniper', sniperPierce: 'sniper',
};
const OLD_TEAM_ONLY = ['allyHeal', 'allyDamagePct', 'allyArmorPct', 'link'];
const OLD_DEFAULT_MODS = {
  damagePct: 0, cannonDamagePct: 0, sniperDamagePct: 0, bossDamagePct: 0,
  rampDamagePct: 0, rampDamageMaxPct: 0, killDamagePct: 0, lifestealPct: 0,
  radiusPct: 0, knockbackPct: 0, sniperBounce: 0, sniperPierce: 0, cannonBounce: 0,
  burnStacks: 0, cannonBurnStacks: 0,
  armorPct: 0, friendlyArmorPct: 0, regenPct: 0, turnTime: 0,
  bombard: 0, teamShield: 0, extraJumps: 0, extraTurn: 0,
  loneDamagePct: 0, loneLifestealPct: 0, allyDamagePct: 0, allyArmorPct: 0,
  feverDamagePct: 0, fullArc: 0,
  missDamagePct: 0, missMaxStacks: 0, hitDamagePct: 0, hitMaxStacks: 0,
  stageDamagePct: 0,
};
// 效果自己的角色狀態（以前直接寫在 Entity 上）與同步欄位
const COUNTERS = { readyStacks: 'rd', huntStacks: 'hu', extraTurnCd: 'xcd', soulPct: 'soul' };
const OLD_TOSTATE = ['id', 'x', 'y', 'hp', 'mhp', 'stamina', 'alive', 'cause', 'facing', 'weapon',
  'burn', 'shield', 'soul', 'turns', 'xcd', 'sx', 'sy', 'wf', 'ps', 'lk', 'vn', 'rd', 'hu'];
const OLD_EXTRA_MODS = ['stageDamagePct'];
const OLD_STAT_FIELDS = ['maxHp', 'maxStamina', 'moveSpeed', 'jumpSpeed', 'size'];

// 現在的登記表（新的效果也在內）：效果自己的狀態、extraMods、基礎數值（stat）的 key
const STATES = EFFECTS.flatMap(m => Object.entries(m.state || {}).map(([field, s]) => ({ id: m.id, field, wire: s.wire, after: s.after || null })));
const EXTRA_MODS = EFFECTS.flatMap(m => Object.keys(m.extraMods || {}));
const STAT_KEYS = EFFECTS.filter(m => m.stat).flatMap(m => Object.keys(m.keys));
// list 以 head 開頭（照順序）/ list 開頭的那幾個就是 head（不管順序）
const prefix = (list, head) => J(list.slice(0, head.length)) === J(head);
const prefixSet = (list, head) => J(list.slice(0, head.length).sort()) === J([...head].sort());
const dupes = (list) => [...new Set(list.filter((x, i) => list.indexOf(x) !== i))];

// ---- 測試用的副本：shared/ 整個複製一份，加一個假效果（一個新檔案 + 登記表一行） ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-effects-'));
function makeCopy(name, effectSrc) {
  const dir = path.join(TMP, name, 'shared');
  fs.cpSync(path.join(ROOT, 'shared'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'effects', 'fake.js'), effectSrc);
  const idx = path.join(dir, 'effects', 'index.js');
  // 跟真的加效果一樣：import 一行、LIST 的最後面加一個（不管最後一個效果是誰、後面有沒有逗號）
  let src = "import { fake } from './fake.js';\n" + fs.readFileSync(idx, 'utf8');
  src = src.replace(/(const LIST = \[[\s\S]*?),?\s*\n\];/, '$1, fake,\n];');
  assert(/, fake,\n\];/.test(src), 'could not register the fake effect');
  fs.writeFileSync(idx, src);
  return { dir, url: (f) => pathToFileURL(path.join(dir, f)).href };
}

const sorted = (o) => J(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

await test('登記表涵蓋 cards.json 用到的每個 key；以前的 45 個 key 都在而且排在最前面（說明一字不差）；key / 效果 id / 狀態欄位 / 同步欄位不重複；validateCards 照樣警告不認得的 key', () => {
  const raw = JSON.parse(read('shared/cards.json'));
  const used = new Set((raw.cards || raw).flatMap(c => Object.keys(c.effects || {})));
  for (const k of used) assert(k in EFFECT_KEYS && effectOf(k), `cards.json uses ${k}, which no effect defines`);
  for (const [k, desc] of Object.entries(OLD_EFFECT_KEYS)) {
    assert(EFFECT_KEYS[k] === desc, `description of ${k} changed: ${EFFECT_KEYS[k]} vs ${desc}`);
  }
  assert(prefixSet(Object.keys(EFFECT_KEYS), Object.keys(OLD_EFFECT_KEYS)), 'the old keys come first (new effects go at the end of LIST): ' + Object.keys(EFFECT_KEYS));
  const all = EFFECTS.flatMap(m => [...Object.keys(m.keys), ...Object.keys(m.extraMods || {})]);
  const twice = {
    key: dupes(all), id: dupes(EFFECTS.map(m => m.id)),
    'state field': dupes(STATES.map(s => s.field)), 'state wire': dupes(STATES.map(s => s.wire)),
  };
  for (const [what, d] of Object.entries(twice)) assert(!d.length, `${what} used twice: ${d}`);
  assert(STATES.every(s => typeof s.wire === 'string' && s.wire), 'every state has a wire name');
  const { cards, warnings } = validateCards({ cards: [{ id: 'x', rarity: 'white', effects: { damagePct: 5, noSuchKey: 3, stageDamagePct: 4 } }] });
  assert(warnings.length === 2 && warnings.every(w => w.includes('不認得的效果')), 'warnings ' + warnings);
  assert(J(cards[0].effects) === J({ damagePct: 5 }), 'unknown keys dropped (stageDamagePct is not a card key)');
  return { keys: Object.keys(EFFECT_KEYS).length, effects: EFFECTS.length, states: STATES.length, cardKeys: used.size };
});

await test('從登記表算出來的清單以以前寫死的開頭：DEFAULT_MODS（含順序；牌的 key 在前、extraMods 在後）、立即效果（含順序）、武器限定、多人限定', () => {
  // DEFAULT_MODS = 牌的 key（照 LIST）再接效果的 extraMods：兩段各自以以前的開頭，所以以前的 mods 照原本的順序、新的只插在各段最後
  const mods = Object.keys(DEFAULT_MODS);
  const cardMods = mods.filter(k => k in EFFECT_KEYS);
  assert(J(mods) === J([...cardMods, ...EXTRA_MODS]), 'DEFAULT_MODS = card keys, then extraMods: ' + mods);
  const oldCardMods = Object.keys(OLD_DEFAULT_MODS).filter(k => !OLD_EXTRA_MODS.includes(k));
  assert(J(Object.keys(OLD_DEFAULT_MODS)) === J([...oldCardMods, ...OLD_EXTRA_MODS]), 'the old list had the same shape');
  assert(prefix(cardMods, oldCardMods) && prefix(EXTRA_MODS, OLD_EXTRA_MODS), 'DEFAULT_MODS ' + J(DEFAULT_MODS));
  assert(Object.values(DEFAULT_MODS).every(v => v === 0), 'every mod starts at 0');
  assert(ENTITY_DEFAULT_MODS === DEFAULT_MODS, 'entities.js re-exports the same DEFAULT_MODS');
  assert(prefix(INSTANT_KEYS, OLD_INSTANT), 'INSTANT ' + J(INSTANT_KEYS));
  const weaponOnly = Object.entries(WEAPON_ONLY_KEYS);
  assert(sorted(Object.fromEntries(weaponOnly.slice(0, Object.keys(OLD_WEAPON_ONLY).length))) === sorted(OLD_WEAPON_ONLY), 'WEAPON_ONLY ' + J(WEAPON_ONLY_KEYS));
  assert(prefixSet(TEAM_ONLY_KEYS, OLD_TEAM_ONLY), 'TEAM_ONLY ' + J(TEAM_ONLY_KEYS));
  // 數值與 mods：baseStats 是所有非立即的 key、derivePlayerStats 的欄位與順序、applyCard 的 now 照立即效果的順序
  const stats = baseStats();
  const notInstant = Object.keys(EFFECT_KEYS).filter(k => !INSTANT_KEYS.includes(k));
  assert(J(Object.keys(stats)) === J(notInstant) && prefixSet(notInstant, Object.keys(OLD_EFFECT_KEYS).filter(k => !OLD_INSTANT.includes(k))), 'baseStats keys');
  const d = derivePlayerStats(stats);
  const fields = Object.keys(d);
  assert(fields.at(-1) === 'mods' && prefix(fields, OLD_STAT_FIELDS) && fields.length === EFFECTS.filter(m => m.stat).length + 1,
    'derived fields ' + fields);
  assert(J(d.mods) === J(DEFAULT_MODS), 'derived mods');
  const now = applyCard(stats, { effects: { maxHp: 20, heal: 5, link: 1, damagePct: 3 } });
  assert(J(Object.keys(now)) === J(INSTANT_KEYS) && now.heal === 25 && now.link === 1 && stats.maxHp === 20 && stats.damagePct === 3,
    'applyCard ' + J(now));
  return { mods: mods.length };
});

await test('效果自己的狀態經登記表建立與同步：toState 以前的欄位與順序不變（soul / xcd / rd / hu 在原本的位置，只多出效果狀態的同步欄位），applyState 套得回去，carry 帶 soulPct', () => {
  const m = new Match({ players: [{ id: 'p1', name: 'P1' }], seed: 1, carry: { p1: { soulPct: 7 } } });
  const p = m.players[0];
  for (const f of [...Object.keys(COUNTERS), ...STATES.map(s => s.field)]) assert(f in p, `entity has no ${f}`);
  assert(p.soulPct === 7 && p.readyStacks === 0 && p.huntStacks === 0 && p.extraTurnCd === 0, 'initial state');
  // 新的效果狀態可以用 after 插在以前的欄位之間：拿掉它們之後要跟以前一模一樣，而且除了它們沒有別的新欄位
  const added = STATES.map(s => s.wire).filter(w => !OLD_TOSTATE.includes(w));
  const old = (keys) => keys.filter(k => !added.includes(k));
  const s = p.toState();
  const keys = Object.keys(s);
  assert(J(old(keys)) === J(OLD_TOSTATE) && added.every(w => keys.includes(w)), 'toState keys ' + keys);
  const e = m.enemies[0];
  assert(!('closed' in s) && J(Object.keys(e.toState())) === J(keys), 'enemies carry the same fields');
  p.applyState({ ...s, rd: 2, hu: 3, xcd: 1, soul: 9 });
  assert(p.readyStacks === 2 && p.huntStacks === 3 && p.extraTurnCd === 1 && p.soulPct === 9, 'applyState');
  p.applyState({ ...s, rd: undefined, hu: undefined, xcd: undefined, soul: undefined });
  assert(p.readyStacks === 2 && p.soulPct === 9, 'missing fields are left alone');
  return { toState: keys.length };
});

// README「effects 可用的鍵」那張表：| `key` | 說明 | 備註 |（備註可空；說明裡要寫 | 就寫 \|）
await test('README 的效果表跟登記表一致：每個 key 一列、說明跟效果檔案的 keys 一字不差，沒有多的或重複的列', () => {
  const lines = read('README.md').split(/\r?\n/);
  const at = lines.findIndex(l => /^\|\s*鍵\s*\|\s*效果\s*\|/.test(l));
  assert(at >= 0, 'README has no effect table (| 鍵 | 效果 | 備註 |)');
  const rows = {};
  const problems = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.slice(1).replace(/\|\s*$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
    const key = (/^`(\w+)`$/.exec(cells[0]) || [])[1];
    if (!key) problems.push('the first column should be one `key`: ' + line);
    else if (key in rows) problems.push(`${key} is listed twice`);
    else rows[key] = cells[1] ?? '';
  }
  for (const [k, desc] of Object.entries(EFFECT_KEYS)) {
    if (!(k in rows)) problems.push(`missing row: | \`${k}\` | ${desc} |  |`);
    else if (rows[k] !== desc) problems.push(`${k}: README says「${rows[k]}」, the effect says「${desc}」`);
  }
  for (const k of Object.keys(rows)) if (!(k in EFFECT_KEYS)) problems.push(`README lists ${k}, which no effect defines`);
  assert(!problems.length, '\n        ' + problems.join('\n        '));
  return { rows: Object.keys(rows).length };
});

await test('寫錯名字的掛勾、重複的 key 載入時就丟錯；index.js 的說明寫到了每一個掛勾', async () => {
  const head = read('shared/effects/index.js').split('\nconst LIST')[0];
  const missing = HOOK_NAMES.filter(h => !new RegExp(`\\b${h}\\b`).test(head));
  assert(!missing.length, 'hooks not documented in shared/effects/index.js: ' + missing.join(', '));
  const bad = makeCopy('bad-hook', `export const fake = { id: 'fake', keys: { fakePct: '測試' }, damagePCT: () => 1 };\n`);
  let err = null;
  try { await import(bad.url('effects/index.js')); } catch (x) { err = x; }
  assert(err && /unknown hook "damagePCT"/.test(err.message), 'unknown hook should throw: ' + (err && err.message));
  const dup = makeCopy('dup-key', `export const fake = { id: 'fake', keys: { damagePct: '重複' } };\n`);
  err = null;
  try { await import(dup.url('effects/index.js')); } catch (x) { err = x; }
  assert(err && /"damagePct" is defined by both/.test(err.message), 'duplicate key should throw: ' + (err && err.message));
  return { hooks: HOOK_NAMES.length };
});

// 假效果「試射」：testPct = 武器傷害 +N%，自己開的一槍打中敵人就記一次（自己的狀態 testHits，同步欄位 th），狀態列顯示次數
const FAKE = `
export const fake = {
  id: 'fake',
  keys: { testPct: '測試：武器傷害 +N%，打中敵人記一次' },
  state: { testHits: { wire: 'th', after: 'vn' } },
  damage: (e) => e.mods.testPct,
  afterShot(match, e, hit) { if (e.mods.testPct > 0 && hit) e.testHits++; },
  chipOrder: 300,
  chip: (e) => (e.mods.testPct > 0 ? ['試射 ' + e.testHits, '#123456'] : null),
};
`;

class FakeIo {
  constructor() { this.t = 0; this.timers = []; this.log = []; this.seq = 0; }
  broadcast(msg) { this.log.push(msg); }
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
function advanceUntil(io, pred, maxMs = 300_000) {
  const start = io.t;
  while (io.t - start < maxMs) {
    io.advance(100);
    if (pred()) return true;
  }
  return false;
}

await test('加一個假效果（一個新檔案 + 登記表一行）：牌庫認得、選牌 → 下一關的 mods、傷害 +N%、自己的狀態與同步欄位、狀態列，全部接得起來', async () => {
  const copy = makeCopy('fake', FAKE);
  const E = await import(copy.url('effects/index.js'));
  const C = await import(copy.url('cards.js'));
  const { Run } = await import(copy.url('run.js'));
  const { CONFIG: CC } = await import(copy.url('config.js'));
  // 加在 LIST 最後面：mods 排在所有牌的 key 之後、extraMods 之前，以前的 mods 順序不變
  const cardMods = Object.keys(DEFAULT_MODS).filter(k => k in EFFECT_KEYS);
  assert(E.EFFECT_KEYS.testPct && J(Object.keys(E.DEFAULT_MODS)) === J([...cardMods, 'testPct', ...EXTRA_MODS]),
    'registered as a battle mod: ' + Object.keys(E.DEFAULT_MODS));
  const { cards, warnings } = C.validateCards({ cards: [{ id: 'fake_card', name: '試射', rarity: 'white', effects: { testPct: 50 } }] });
  assert(!warnings.length && cards[0].effects.testPct === 50, 'card validated: ' + warnings);

  const io = new FakeIo();
  const run = new Run({ players: [{ id: 'p1', name: 'P1' }], seed: 3, io, cards });
  run.start();
  io.advance(2000);
  for (const e of run.match.enemies) e.die('hit');
  assert(advanceUntil(io, () => run.phase === 'pick'), 'reach the pick phase');
  run.handle('p1', { t: 'pick', cardId: 'fake_card' });
  assert(advanceUntil(io, () => run.phase === 'battle' && run.stage === 2), 'stage 2 starts');
  const start = io.log.filter(m => m.t === 'start').at(-1);
  assert(start.carry.p1.mods.testPct === 50, 'carry mods carry the new key: ' + J(start.carry.p1.mods));

  const m = run.match;
  const p1 = m.byId('p1');
  const W = CC.WEAPONS.cannon;
  m.fever = 0;
  assert(Math.abs(m.damageMult(p1, W) - 1.5) < 1e-12, 'damage +50%: ' + m.damageMult(p1, W));
  // 打中敵人：自己的狀態 +1，toState 帶 th（排在 vn 後面），applyState 套得回去
  const target = m.enemies.find(e => e.alive);
  for (const e of m.entities) if (e !== target && e !== p1) e.die('hit');
  target.hp = target.maxHp = 100000;
  target.x = p1.x + 60;
  target.y = p1.y;
  const before = p1.testHits;
  const shot = m.resolveShot(p1, 'sniper', 0, 100);
  assert(shot.hitEnemy === true && p1.testHits === before + 1, `hit counted (${before} → ${p1.testHits}, hitEnemy ${shot.hitEnemy})`);
  const s = shot.results.find(r => r.id === 'p1');
  const keys = Object.keys(s);
  // after: 'vn' 的同步欄位照 LIST 的順序排在 vn 後面：假效果在最後，所以排在登記表裡其他 after vn 的（rd / hu …）之後
  const afterVn = STATES.filter(x => x.after === 'vn').length;
  assert(s.th === p1.testHits && keys.indexOf('th') === keys.indexOf('vn') + afterVn + 1, 'th synced after vn (and rd / hu): ' + keys.join());
  const cm = new (await import(copy.url('match.js'))).Match({ levelId: m.levelId, players: [{ id: 'p1', name: 'P1' }], seed: m.seed, carry: m.carry, stage: m.stage });
  cm.applyEntities(shot.results);
  assert(cm.byId('p1').testHits === p1.testHits, 'client copy gets the state');
  // 狀態列：效果給的資料（客戶端照著畫），排在狀態之後
  const chips = E.effectChips(p1, { match: m, round: 1 });
  const mine = chips.find(c => c.label === `試射 ${p1.testHits}`);
  assert(mine && mine.color === '#123456' && mine.order > E.STATUS_CHIP_ORDER, 'chip ' + J(chips));
  return { testHits: p1.testHits, chips: chips.map(c => c.label) };
});

await test('寫錯的效果狀態（跟角色的欄位 / toState 的同步欄位撞名、after 寫錯）、要指定隊友卻沒有選牌畫面文字的效果，載入時就丟錯', async () => {
  const cases = [
    ['state-field', `state: { shield: { wire: 'fk', after: 'vn' } }`, /effect state shield: the character already has a field/],
    ['state-method', `state: { toState: { wire: 'fk', after: 'vn' } }`, /effect state toState: the character already has a field/],
    ['state-wire', `state: { fakeN: { wire: 'wt', after: 'vn' } }`, /wire name "wt" is already a field of toState/],
    ['state-after', `state: { fakeN: { wire: 'fk', after: 'vnn' } }`, /after "vnn" is not a field of toState/],
  ];
  for (const [name, state, re] of cases) {
    const copy = makeCopy(name, `export const fake = { id: 'fake', keys: { fakePct: '測試' }, ${state} };\n`);
    await import(copy.url('effects/index.js'));   // 登記表本身載得起來：要跟 Entity 比才知道
    let err = null;
    try { await import(copy.url('entities.js')); } catch (x) { err = x; }
    assert(err && re.test(err.message), `${name} should throw at load: ` + (err && err.message));
  }
  const ok = makeCopy('state-ok', `export const fake = { id: 'fake', keys: { fakePct: '測試' }, state: { fakeN: { wire: 'fk', after: 'closed' } } };\n`);
  await import(ok.url('entities.js'));
  const target = makeCopy('target', `export const fake = { id: 'fake', keys: { fakeTo: { desc: '測試', instant: true } }, target: 'teammate' };\n`);
  let err = null;
  try { await import(target.url('effects/index.js')); } catch (x) { err = x; }
  assert(err && /target "teammate" needs pickText/.test(err.message), 'target without pickText should throw: ' + (err && err.message));
  return { cases: cases.length + 2 };
});

// ---- 架構檢查 ----
// 註解拿掉（行號不變；網址裡的 // 不是註解）；CONFIG 的設定（例如 CONFIG.FEVER.damagePct、CONFIG.WEAPONS.bombard）不算
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, '')).replace(/(?<!:)\/\/.*$/gm, '')
  .replace(/CONFIG(\.\w+)+/g, 'CONFIG');
// 不准出現的字，從現在的登記表算（新的效果加進來就自動在內）：所有效果 key（含立即效果、基礎數值的 key）、效果的 extraMods、
// 效果自己的狀態欄位；以前寫死的清單也併進來（萬一登記表漏了什麼）
const WORDS = [...new Set([
  ...Object.keys(EFFECT_KEYS), ...INSTANT_KEYS, ...STAT_KEYS, ...Object.keys(DEFAULT_MODS), ...EXTRA_MODS, ...STATES.map(s => s.field),
  ...Object.keys(OLD_EFFECT_KEYS), ...Object.keys(OLD_DEFAULT_MODS), ...Object.keys(COUNTERS),
])];
// 效果狀態的同步欄位（rd、hu、xcd、soul…）：名字很短，可能剛好是別的區域變數，所以只抓「當成欄位用」的寫法：
// .rd（含 ?.rd）、'rd'（字串 / [] 取值）、物件的 rd:、解構的 { rd } =
const WIRES = [...new Set([...STATES.map(s => s.wire), ...Object.values(COUNTERS)])];
const wireUse = (w) => new RegExp(`\\.\\s*${w}(?![\\w$])|['"\`]${w}['"\`]|(?:^|[{,])\\s*${w}\\s*:|\\{[^{}]*(?<![\\w$.])${w}(?![\\w$])[^{}]*\\}\\s*=`);
// 跟效果 key 同名、但意思不一樣的字：只准照這些寫法出現（其他寫法 = 效果 key 漏出來，例如從選牌的 now、牌的 stats、
// 效果的 p.boost 讀，或拿 fx / shot 的種類字串比對）。每一條都要真的有用到（用不到了就刪掉，不留後門）
const NOT_KEY = '(?<![\\w.\'"`-])';   // 前面不是字、點、引號：區域變數 / 欄位名 / 方法定義，不是從別的東西讀、也不是字串
const SAME_NAME = {
  // 角色的血量上限（Entity.maxHp、derivePlayerStats 算出來的、訊息 / 紀錄 / carry 的欄位）：只准從角色 / 算好的數值讀
  maxHp: [/(?:\b(?:this|o|c|d|e|s|eye|snake|me|actor)|[)\]])\.maxHp\b/g, new RegExp(NOT_KEY + 'maxHp(?![\\w\'"`-])', 'g')],
  // 一般的回血：Match.heal、事件 / 訊息的 heal 欄位（吸血、蛇血、古樹回血）、回血 fx 的種類、區域變數
  heal: [/\b(?:this|match)\.heal\(/g, /\b(?:ev|fx|b|msg)\.heal\b/g, /\btype === 'heal'/g, new RegExp(NOT_KEY + 'heal(?![\\w\'"`-])', 'g')],
  // 選牌訊息 / 結果的 link 欄位（指定的隊友）
  link: [/\b(?:msg|entry|s)\.link\b/g, new RegExp(NOT_KEY + 'link\\s*:', 'g')],
  // 回合訊息的 turnTime 欄位（秒數由裁判的 turnTimeFor 算）
  turnTime: [/\bmsg\.turnTime\b/g, new RegExp(NOT_KEY + 'turnTime\\s*:', 'g')],
  // 裁判的「這回合是額外回合」與它在 statePayload 的欄位
  extraTurn: [/\bthis\.extraTurn\b/g, new RegExp(NOT_KEY + 'extraTurn\\s*:', 'g')],
  // 武器 id（轟炸飛彈的畫法、爆炸的顏色 / 震動）
  bombard: [/\b(?:weapon|w)\.id === 'bombard'/g],
};
// 只有這個檔案的這種寫法可以（Entity 的物理每一幀直接讀二段跳的次數，不經過效果的掛勾）
const EXCEPT = { 'shared/entities.js': [/\bthis\.mods\.extraJumps\b/g] };
// 掃 shared/、client/、server/ 底下所有的 .js：效果自己（shared/effects/）與設定（config.js）之外
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap(d => (d.isDirectory() ? walk(`${dir}/${d.name}`) : d.name.endsWith('.js') ? [`${dir}/${d.name}`] : []));
const SCANNED = ['shared', 'client', 'server'].flatMap(walk).filter(f => !f.startsWith('shared/effects/') && f !== 'shared/config.js');

await test('shared / client / server 所有的程式碼（effects/、config.js 之外）不提任何效果 key（同名的通用欄位只准固定寫法）、不讀 mods.<key>、run.js 不讀 now.<key>、不碰效果自己的狀態欄位與同步欄位（從登記表算）', () => {
  const problems = [];
  const used = new Set();
  const consume = (s, list, tag) => list.reduce((t, re, i) => t.replace(re, () => { used.add(`${tag}#${i}`); return '#'; }), s);
  for (const f of SCANNED) {
    codeOf(read(f)).split('\n').forEach((line, i) => {
      const at = `${f}:${i + 1}`;
      const rest = consume(line, EXCEPT[f] || [], f);
      for (const k of WORDS) {
        // 一整個字才算（CSS class 'link-btn' 這種連字號接起來的、turnTimeFor 這種更長的名字不算）
        const word = new RegExp(`(?<![\\w-])${k}(?![\\w-])`);
        if (word.test(rest) && word.test(consume(rest, SAME_NAME[k] || [], k))) problems.push(`${at} mentions ${k}: ${line.trim()}`);
      }
      for (const w of WIRES) {
        const st = STATES.find(s => s.wire === w);
        if (wireUse(w).test(rest)) problems.push(`${at} uses the sync field "${w}" of effect state ${st ? st.field : w} (draw it through the effect's hooks; if it is unrelated, pick another wire name): ${line.trim()}`);
      }
      // mods 只准整包傳（建角色、算 carry），不准讀某一個 key（含解構）
      if (/\bmods\s*(\.\s*\w|\[)|\}\s*=\s*[\w.]*\bmods\b/.test(rest)) problems.push(`${at} reads a mod: ${line.trim()}`);
      // 選牌的 now（applyCard 回傳的立即效果）只准整包交給效果（picked / pickHeal）
      if (f === 'shared/run.js' && /\bnow\s*[.[]|\}\s*=\s*now\b/.test(rest)) problems.push(`${at} reads the instant effects (now): ${line.trim()}`);
    });
  }
  const stale = [...Object.entries(SAME_NAME), ...Object.entries(EXCEPT)]
    .flatMap(([tag, list]) => list.map((re, i) => (used.has(`${tag}#${i}`) ? null : `${tag}: ${re}`))).filter(Boolean);
  if (stale.length) problems.push('allowances nobody uses any more (delete them): ' + stale.join(', '));
  assert(!problems.length, '\n        ' + problems.join('\n        '));
  return { files: SCANNED.length, words: WORDS.length, wires: WIRES.length };
});

await test('entities.js 不宣告效果自己的狀態（登記表裡的每個狀態欄位與同步欄位：readyStacks / huntStacks / extraTurnCd / soulPct…），經 effects/index.js 建立與同步', () => {
  const code = codeOf(read('shared/entities.js'));
  for (const f of new Set([...Object.keys(COUNTERS), ...STATES.map(s => s.field)])) {
    assert(!new RegExp(`\\b${f}\\b`).test(code), 'entities.js mentions ' + f);
  }
  for (const w of WIRES) {
    assert(!new RegExp(`\\b${w}\\s*:|\\bs\\.${w}\\b`).test(code), 'entities.js writes / reads the wire field ' + w + ' by hand');
  }
  assert(/from '\.\/effects\/index\.js'/.test(code) && /initState\(this, o\)/.test(code) && /writeState\(this/.test(code) && /readState\(this, s\)/.test(code),
    'entities.js goes through the effects registry');
  return { states: STATES.map(s => s.field) };
});

await test('效果只往下 import（config、projectile.js、同資料夾），不 import match / referee / run / volley / weapons / entities / cards（沒有循環）', () => {
  const dir = path.join(ROOT, 'shared', 'effects');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const imp = [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^\s*import\b[^;]*?from\s*'([^']+)'/gm)].map(x => x[1]);
    const bad = imp.filter(s => !/^\.\/[\w-]+\.js$/.test(s) && !['../config.js', '../projectile.js'].includes(s));
    assert(!bad.length, `effects/${f} imports ${bad}`);
  }
  // 登記表裡每個效果都有自己的檔案（index.js 之外的檔案都登記了）
  const registered = (read('shared/effects/index.js').match(/from '\.\/([\w-]+)\.js'/g) || []).length;
  assert(registered === files.length - 1 && registered === EFFECTS.length, `${registered} imports, ${files.length - 1} files, ${EFFECTS.length} effects`);
  return { files: files.length - 1 };
});

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
