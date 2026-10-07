import { CONFIG } from '../config.js';
import { maxHp } from './max-hp.js';
import { heal } from './heal.js';
import { healPct } from './heal-pct.js';
import { teamHeal } from './team-heal.js';
import { damage } from './damage.js';
import { cannonDamage } from './cannon-damage.js';
import { sniperDamage } from './sniper-damage.js';
import { bossDamage } from './boss-damage.js';
import { ramp } from './ramp.js';
import { soul } from './soul.js';
import { lifesteal } from './lifesteal.js';
import { radius } from './radius.js';
import { knockback } from './knockback.js';
import { sniperBounce } from './sniper-bounce.js';
import { sniperPierce } from './sniper-pierce.js';
import { cannonBounce } from './cannon-bounce.js';
import { burnHit } from './burn-hit.js';
import { cannonBurn } from './cannon-burn.js';
import { armor } from './armor.js';
import { friendlyArmor } from './friendly-armor.js';
import { regen } from './regen.js';
import { stamina } from './stamina.js';
import { moveSpeed } from './move-speed.js';
import { jumpSpeed } from './jump-speed.js';
import { size } from './size.js';
import { turnTime } from './turn-time.js';
import { bombard } from './bombard.js';
import { teamShield } from './team-shield.js';
import { extraJumps } from './extra-jumps.js';
import { extraTurn } from './extra-turn.js';
import { allyHeal } from './ally-heal.js';
import { adrenaline } from './adrenaline.js';
import { lone } from './lone.js';
import { unity } from './unity.js';
import { fever } from './fever.js';
import { fullArc } from './full-arc.js';
import { ready } from './ready.js';
import { hunt } from './hunt.js';
import { link } from './link.js';

// 效果（見 GLOSSARY.md）：一種規則連同它的說明與顯示，由 cards.json 裡的一個或幾個 key 帶數值啟用。
// 這個資料夾每個檔案是一個效果，這裡是登記表：新增「用現有效果的牌」只改 cards.json；改一個效果 = 改它自己的檔案。
// 效果檔案裡有它的一切：key 與說明、數值、選牌當下 / 下一關的行為、戰鬥規則、自己的角色狀態與同步欄位、開火紀錄的欄位，
// 以及畫面要的資料（狀態列、飄字、橫幅；畫法在 client/ 照資料畫）。
// 狀態（中毒、燃燒、無敵）不屬於效果：效果可以給角色狀態（火焰彈 → 燃燒、神佑之石 → 無敵），狀態本身照樣在 Entity / Match。
//
// 新增一個效果（不用改測試、match.js、畫面）：
//   1. 這個資料夾加一個檔案（例如 last-stand.js），export 一個物件：id、keys，加上它要的掛勾（見下面；只 import config、projectile、同資料夾）
//   2. 這個檔案最上面 import 它，名字加在下面 LIST 的「最後面」（為什麼見下一段）
//   3. README「effects 可用的鍵」那張表最後加一列 | `key` | 說明 | 備註 |：說明跟 keys 寫的一字不差（test/effects.js 會比對），備註可以空著
//   4. cards.json 加用它的牌
//   5. 玩家看得到的改動：shared/version.js 的 CHANGELOG[0] 記一行（新效果 / 新牌 → new，改數值或規則 → change）
//   掛勾裡常用的：角色 e.maxHp / e.hp / e.alive / e.team / e.mods（同步欄位叫 mhp，但程式裡用 e.maxHp）、
//   match.heal(e, 量)（回血，會累積小數、回傳實際回了多少）、match.players / match.enemies；不確定就照 regen.js、lifesteal.js、ready.js 寫
//   npm test 的 test/effects.js 會檢查：key / 效果 id / 狀態欄位 / 同步欄位沒重複、掛勾名字沒寫錯、README 的表，以及 effects/ 以外的程式碼
//   沒提到它的 key、狀態欄位、同步欄位（要用就寫成這個效果的掛勾，不要在 match.js / client/ 裡判斷）
//
// 組合的順序只在呼叫的那一邊：Match（武器傷害各槽相加的順序、爆炸裡首領 → 減傷 → 誤傷減傷 → 連結、回合開始 / 結束）、
// run.js（選牌的兩輪）、裁判、畫面。效果只往「槽」貢獻數字、在固定的時間點做事。
// LIST 的順序有意義，所以新的效果一律加在最後面、不要插在中間或調換：同一個槽照 LIST 的順序相加（小數相加的順序會影響最後一位；
// 例如武器傷害的 damage 槽 = damagePct + 大砲 / 狙擊槍那一個 + 狂戰之斧 + 噬魂者）、回合開始 / 結束照 LIST 的順序做（神佑之石 → 時間扭曲），
// 上網路的順序也照 LIST：DEFAULT_MODS 的 key（玩家的 mods；extraMods 排在所有牌的 key 之後）、立即效果（applyCard 回傳的 now）、
// 數值欄位、同一個 after 的同步欄位、同一個 chipOrder 的狀態列格子。加在最後面，以前的效果的數字、順序與同步格式都不變。
//
// 每個效果的欄位（id 與 keys 一定要有，其他不寫 = 下面的預設；寫錯名字直接丟錯，不會被默默忽略）：
// 定義
//   keys: { key: 說明 | { desc, instant, weapon, teamOnly } }   這個效果用的 cards.json key（不能跟別的效果重複；說明 = README 表的那一欄）
//       instant: true          拿到牌的當下生效、不累積到 stats（回血、下一關的加成、選連結對象），見 applyCard 回傳的 now
//       weapon: 'cannon' | …   只對這把武器有用：一張牌的效果全是這把武器的、玩家又沒有它，這張牌不出（card.requires）；
//                              效果的所有 key 都是同一把武器的話，下面戰鬥的槽也只在用這把武器時才算
//       teamOnly: true         要有隊友才有用：一張牌的效果全是這種時，單人冒險不出（card.teamOnly）
//       其他的 key（不是 instant、沒有 stat）是戰鬥的加成：進 DEFAULT_MODS，玩家的 mods 照牌加總，敵人全部是 0
//   extraMods: { 名字: 說明 }   不是牌的 key、由這個效果每關給值的 mods（腎上腺素的 stageDamagePct），排在 DEFAULT_MODS 最後
//   state: { 欄位: { wire, after, carry, shot } }   這個效果自己的角色狀態（掛在角色上、每關從 0 開始；entities.js 不寫這些欄位）：
//       wire = 同步（toState / applyState）的欄位名（短的英文，例如 rd、hu；effects/ 以外的程式碼不准寫 .wire、'wire'、wire:，
//       測試會掃，跟別的東西的屬性撞名就換一個）；after = toState 裡排在哪個欄位後面（同步格式的順序不變；不寫 = 最後）。
//       after 可以用的（entities.js baseState）：id x y hp mhp stamina alive cause facing weapon burn shield turns sx sy wf ps lk vn，
//       以及只有某些角色才有的 closed（嘴巴會閉的首領）、wt（蜜蜂）（沒有那個欄位的角色排最後）；同一個 after 照 LIST 的順序
//       （目前 shield 後面是 soul、turns 後面是 xcd、vn 後面是 rd、hu）；
//       carry: true = 整場冒險帶著走（肉鴿流程的玩家 → carry → Match 建角色 → 打完帶回）；shot: true = 開火結果的最上層另外再帶一份 wire 欄位
//       （results 的 toState 本來就帶，一般不用；噬魂的 soul 用它，是因為客戶端要拿「開火後的值」算飄字）
//       欄位不能是角色本來就有的（建角色時檢查）、wire 不能跟 toState 本來的欄位撞名、after 要是 toState 本來的欄位
//       （entities.js 載入時檢查，見 checkState）：寫錯就丟錯，不會默默蓋掉別的欄位或排到最後
//   target: 'teammate'         拿這張牌要指定一位隊友（攜手之伴）：抽牌（沒人可選就不出）、選牌、自動代選、選牌畫面都照這個；
//                              一定要有 pickText（選牌畫面的文字），選定的隊友由 picked 的 target 交給效果自己記
//   actions: { 名字(match, …) }  給測試 / 工具直接呼叫的動作（Match.resolveBombard）
// 數值（cards.js derivePlayerStats）
//   stat(stats, P) → [欄位, 值]   這一關的基礎數值（maxHp / maxStamina / moveSpeed / jumpSpeed / size，照 LIST 的順序）；
//                                 有 stat 的效果，它的 key 不是戰鬥的 mods
// 選牌（cards.js applyCard → run.js finishPicks，兩輪的順序在 run.js）
//   applied(now, v, key)       applyCard 把這個 key 加完之後（加上限的牌同時回等量的血：now.heal += v）
//   picked(p, now, pool, target)   第一輪、套完 p 的牌：記到 p 身上（下一關的加成）或這一輪選牌共用的 pool（各效果自己的欄位）；
//                              target = 這張牌指定的隊友 id（要指定隊友的牌才有、沒有人可選 = null；超時由 run.js 代選）
//   healNow(now, max) → n      第一輪：p 立刻回多少（max = 套完牌的新上限），依序加在現在的血上
//   healFromTeammates(pool, p) → n   第二輪（大家的牌都套完）：隊友的牌給 p 回多少
//   healForTeam(pool, p, max) → n    第二輪：全隊的牌給 p 回多少（max = p 自己的新上限），加在上一個之後
// 關卡（run.js）
//   runInit(p)                 冒險開始：肉鴿流程的玩家身上這個效果自己的欄位
//   stageStart(p)              一關開始：倒下的人復活之後、算 carry 之前
//   carry(p, d)                算這一關的 carry：改 derivePlayerStats 的結果 d（上限、mods）
//   stageOver(p)               一關打完：血量與帶走的狀態都收回之後
// 戰鬥的槽（(e, c) → 數字；c = { match, weaponId, allies }；從 0 開始依 LIST 的順序相加，Match 決定各槽怎麼組合）
//   damage / damageSituation / damageState   武器傷害 +%：Match.damageMult = 1 + (damage + damageSituation + damageState) / 100，轟炸不吃。
//                              三個槽算法一樣，分開只是為了保住以前小數相加的順序（各槽照 LIST 先加完，三個再相加）。現在的成員：
//                              damage = 一直有的加成：damage（damagePct）、cannonDamage、sniperDamage、ramp（每回合成長）、soul（擊殺累積）
//                              damageSituation = 這一關給的、或看隊友人數：adrenaline（stageDamagePct）、lone（孤狼）、unity（團結）
//                              damageState = 看某個條件現在成不成立：fever（狂熱開了沒；雖然是全場的條件也放這裡）、ready / hunt（自己的層數）
//                              新的效果放最像的那一槽；看自己的血量、層數這種條件 → damageState。沒有這張牌的人貢獻 0，不改別人的結果
//   damageBoss                 對首領傷害 +%（另外乘，轟炸也吃）
//   armor                      受到的傷害 -%（c.allies = 這一下之前活著的隊友數）
//   friendlyArmor              受到的隊友誤傷再 -%
//   lifesteal                  傷害吸血 %（c.allies = 打中之前活著的隊友數）
//   knockback                  擊退 +%
//   radius                     爆炸半徑 +%（weapons.js blastRadius：Match 與 AI 共用）
//   burnOnHit                  開火擊中的敵人附加幾層燃燒
//   bounces / pierce           飛行物在地形上彈射幾次 / 穿透角色（weapons.js shotTraits：伺服器、預覽、AI 共用；pierce 任一個 true 就是）
//   previewFull                瞄準預覽畫完整拋物線（任一個 true 就是）
//   turnSecs                   每回合秒數 +N（裁判）
// 戰鬥的時間點
//   turnBegin(match, e) → (() → shot) | null   輪到 e（beginTurn 之後、開始計時之前，裁判呼叫）：這個效果要出手的話，
//                              回傳結算那一波攻擊的函式（無差別轟炸；裁判先切換狀態、拍血量快照才呼叫它）
//   turnStart(match, e, fx)    自己的回合開始：中毒結算、地圖機制之後（恩賜之杖回血）
//   turnEnd(match, e, fx, isExtra)   自己的回合結束：燃燒、地圖機制之後（神佑之石 → 時間扭曲）
//   again(fx) → boolean        回合結束的這一筆 fx 代表同一位再來一回合（裁判）
//   afterShot(match, e, hit)   自己開的一槍結算完（轟炸、Boss 招式不算）：hit = 有沒有打中敵人（直擊或波及到敵方，傷害 0 也算）
//   onKill(match, e, killed, fx)     e 打倒了 killed（已經算進 kills）；fx = 燒死時回合結束的 fx 清單（開火結算時是 null）
//   share(match, hit, c)       爆炸算好 hit.e 要扣多少之後、還沒扣：分給別人（hit = { e, entry, own, shares, factor }，
//                              c = { alive0, shielded, block, friendly, damages }）
//   shotLog: { group, field, value(e), on(e) }   開火紀錄（LOG 的 shot）附的欄位：同一群組任一個 on 就整組記 { group: { field: value } }
// 畫面（客戶端；只給資料，畫法在 render.js / game-view.js / cards-ui.js）
//   chip(e, c) → [文字, 顏色] | null   自己的狀態列一格（c = { match }；第幾輪、狂熱看 match.round / match.fever）；chipOrder 決定位置（小的在前，一樣的照 LIST 的順序），
//                              狀態（無敵、燃燒、中毒、生命鎖）排在 STATUS_CHIP_ORDER = 150。目前用到的（最準的是 grep chipOrder shared/effects/）：
//                              ramp 10、soul 20、bossDamage 30、lifesteal 40、armor 50、regen 60、extraJumps 70、extraTurn 80、bombard 90、
//                              teamShield 100、〔狀態 150〕、fever 200、fullArc 210、ready 220、hunt 230、adrenaline 240、lone 250、unity 260、link 270
//   shotFloat(e, before) → [[文字, 顏色]]   自己開的一槍套上伺服器結果之後的飄字（before = 套之前這些效果狀態的值，見 stateOf）
//   killFloat(e, shot) → [[文字, 顏色]]     這一發有擊殺時的飄字（shotFloat 之後）
//   turnFx(fx, e) → 動作 | null  回合開始 / 結束的 fx 是這個效果的：['banner', 文字, 顏色] / ['float', id, 文字, 顏色, 大小?] /
//                              ['particles', id, 數量, 參數]（照順序做；橫幅跟同一次的其他橫幅合成一行）
//   volley: { kind, banner(name), color }   這個效果的一波攻擊（shot.kind）開始時的橫幅
//   pickText: { need, none, title(card), button(name), hint(others) }   target 的效果：選牌畫面要選對象時的文字

const LIST = [
  maxHp, heal, healPct, teamHeal, damage, cannonDamage, sniperDamage, bossDamage, ramp, soul, lifesteal, radius, knockback,
  sniperBounce, sniperPierce, cannonBounce, burnHit, cannonBurn, armor, friendlyArmor, regen, stamina, moveSpeed, jumpSpeed, size,
  turnTime, bombard, teamShield, extraJumps, extraTurn, allyHeal, adrenaline, lone, unity, fever, fullArc, ready, hunt, link,
];

const NOOP = () => {};
const ZERO = () => 0;
const NONE = () => [];
const HOOKS = {
  id: null, keys: null, extraMods: null, state: null, target: null, actions: null,
  stat: null, applied: NOOP, picked: NOOP, healNow: ZERO, healFromTeammates: ZERO, healForTeam: ZERO,
  runInit: NOOP, stageStart: NOOP, carry: NOOP, stageOver: NOOP,
  damage: ZERO, damageSituation: ZERO, damageState: ZERO, damageBoss: ZERO,
  armor: ZERO, friendlyArmor: ZERO, lifesteal: ZERO, knockback: ZERO, radius: ZERO, burnOnHit: ZERO,
  bounces: ZERO, pierce: () => false, previewFull: () => false, turnSecs: ZERO,
  turnBegin: () => null, turnStart: NOOP, turnEnd: NOOP, again: () => false, afterShot: NOOP, onKill: NOOP, share: NOOP, shotLog: null,
  chipOrder: 0, chip: () => null, shotFloat: NONE, killFloat: NONE, turnFx: () => null, volley: null, pickText: null,
};

// 效果沒寫的掛勾補上預設；寫錯名字的掛勾、壞掉的 key 直接丟錯。weapon = 所有 key 都是同一把武器時的那把（戰鬥的槽照它過濾）
function wrap(def) {
  if (!def || typeof def.id !== 'string') throw new Error('effect without an id');
  for (const k of Object.keys(def)) {
    if (!(k in HOOKS)) throw new Error(`effect "${def.id}": unknown hook "${k}"`);
  }
  // 要指定對象的效果：目前只有指定隊友，而且選牌畫面要它的文字（沒有 pickText 選牌畫面會壞掉）
  if (def.target != null && def.target !== 'teammate') throw new Error(`effect "${def.id}": unknown target "${def.target}"`);
  if (def.target != null && !def.pickText) throw new Error(`effect "${def.id}": target "${def.target}" needs pickText`);
  if (!def.keys || !Object.keys(def.keys).length) throw new Error(`effect "${def.id}": no keys`);
  const keys = {};
  for (const [k, spec] of Object.entries(def.keys)) {
    const s = typeof spec === 'string' ? { desc: spec } : { ...spec };
    for (const f of Object.keys(s)) {
      if (!['desc', 'instant', 'weapon', 'teamOnly'].includes(f)) throw new Error(`effect "${def.id}": key ${k} has unknown flag "${f}"`);
    }
    if (typeof s.desc !== 'string') throw new Error(`effect "${def.id}": key ${k} has no description`);
    if (s.weapon != null && !CONFIG.WEAPONS[s.weapon]) throw new Error(`effect "${def.id}": key ${k} is tied to unknown weapon "${s.weapon}"`);
    keys[k] = Object.freeze({ desc: s.desc, instant: !!s.instant, weapon: s.weapon || null, teamOnly: !!s.teamOnly });
  }
  const weapons = new Set(Object.values(keys).map(s => s.weapon));
  const m = { weapon: weapons.size === 1 ? [...weapons][0] : null };
  for (const [k, dflt] of Object.entries(HOOKS)) m[k] = def[k] ?? dflt;
  m.keys = Object.freeze(keys);
  return Object.freeze(m);
}

export const EFFECTS = Object.freeze(LIST.map(wrap));
/** 所有掛勾 / 欄位的名字（測試檢查上面的說明有沒有漏寫） */
export const HOOK_NAMES = Object.freeze(Object.keys(HOOKS));

// 每個掛勾有寫的效果（照 LIST 的順序；沒寫的不用呼叫）
const IMPL = Object.fromEntries(Object.keys(HOOKS).map(h => [h, EFFECTS.filter((m, i) => LIST[i][h] !== undefined)]));

// ---- 從登記表算出來的清單（不用另外維護）----

const OWNER = new Map();   // key → 效果
for (const m of EFFECTS) {
  for (const k of [...Object.keys(m.keys), ...Object.keys(m.extraMods || {})]) {
    if (OWNER.has(k)) throw new Error(`effect key "${k}" is defined by both "${OWNER.get(k).id}" and "${m.id}"`);
    OWNER.set(k, m);
  }
}
const KEYS = EFFECTS.flatMap(m => Object.entries(m.keys).map(([k, s]) => ({ k, s, m })));

/** 可用的效果 key → 說明（validateCards 認得的 key；README 的效果表要一字不差，test/effects.js 會比對） */
export const EFFECT_KEYS = Object.freeze(Object.fromEntries(KEYS.map(({ k, s }) => [k, s.desc])));
/** 拿到牌的當下生效、不會累積到數值上的 key（applyCard 回傳的 now 就是這些，照這個順序） */
export const INSTANT_KEYS = Object.freeze(KEYS.filter(({ s }) => s.instant).map(({ k }) => k));
/** 只對某把武器有用的 key → 武器 id */
export const WEAPON_ONLY_KEYS = Object.freeze(Object.fromEntries(KEYS.filter(({ s }) => s.weapon).map(({ k, s }) => [k, s.weapon])));
/** 要有隊友才有用的 key */
export const TEAM_ONLY_KEYS = Object.freeze(KEYS.filter(({ s }) => s.teamOnly).map(({ k }) => k));
/** 戰鬥中用到的牌加成（% 或次數）：不是立即效果、也不是基礎數值（stat）的 key，加上效果的 extraMods；全部從 0 開始 */
export const DEFAULT_MODS = Object.freeze(Object.fromEntries([
  ...KEYS.filter(({ s, m }) => !s.instant && !m.stat).map(({ k }) => [k, 0]),
  ...EFFECTS.flatMap(m => Object.keys(m.extraMods || {}).map(k => [k, 0])),
]));

/** 這個 key 屬於哪個效果（不認得 = null） */
export const effectOf = (key) => OWNER.get(key) || null;

// ---- 數值與選牌（cards.js、run.js）----

/** derivePlayerStats 的基礎數值（照 LIST 的順序：maxHp、maxStamina、moveSpeed、jumpSpeed、size） */
export function deriveStats(stats, P) {
  const out = {};
  for (const m of IMPL.stat) {
    const [field, value] = m.stat(stats, P);
    out[field] = value;
  }
  return out;
}

/** applyCard 把 key 加完之後，這個 key 的效果要另外做的事 */
export function applied(key, now, v) {
  const m = OWNER.get(key);
  if (m) m.applied(now, v, key);
}

/** 這張牌要指定一位隊友的話，是哪個效果（不用 = null） */
export function teammateEffect(card) {
  if (!card || !card.effects) return null;
  for (const [k, v] of Object.entries(card.effects)) {
    const m = OWNER.get(k);
    if (m && m.target === 'teammate' && v > 0) return m;
  }
  return null;
}
export const needsTeammate = (card) => !!teammateEffect(card);

/** 選牌第一輪套完 p 的牌：各效果記到 p 身上或這一輪共用的 pool；target = 這張牌指定的隊友 id（沒有 = null） */
export function picked(p, now, pool, target = null) {
  for (const m of IMPL.picked) m.picked(p, now, pool, target);
}

/** 選牌時的回血槽（healNow / healFromTeammates / healForTeam）：從 start（現在的血）開始依序加上每個效果的量 */
export function pickHeal(slot, start, ...args) {
  let hp = start;
  for (const m of IMPL[slot]) hp += m[slot](...args);
  return hp;
}

const STATE = EFFECTS.flatMap(m => Object.entries(m.state || {}).map(([field, s]) => {
  for (const f of Object.keys(s)) {
    if (!['wire', 'after', 'carry', 'shot'].includes(f)) throw new Error(`effect "${m.id}": state ${field} has unknown flag "${f}"`);
  }
  if (typeof s.wire !== 'string') throw new Error(`effect "${m.id}": state ${field} has no wire name`);
  return Object.freeze({ field, wire: s.wire, after: s.after || null, carry: !!s.carry, shot: !!s.shot });
}));
for (const [i, s] of STATE.entries()) {
  if (STATE.findIndex(t => t.field === s.field || t.wire === s.wire) !== i) throw new Error(`effect state ${s.field} / ${s.wire} is defined twice`);
}
const CARRIED = STATE.filter(s => s.carry);

/** 冒險開始：肉鴿流程的玩家身上各效果的欄位（帶著走的狀態從 0 開始） */
export function initRunPlayer(p) {
  for (const s of CARRIED) p[s.field] = 0;
  for (const m of IMPL.runInit) m.runInit(p);
}
export function startStage(p) {
  for (const m of IMPL.stageStart) m.stageStart(p);
}
export function adjustCarry(p, d) {
  for (const m of IMPL.carry) m.carry(p, d);
}
/** 整場冒險帶著走的狀態（肉鴿流程的玩家 → carry、carry → Match 建角色），欄位名照狀態的欄位 */
export function carriedState(src) {
  return Object.fromEntries(CARRIED.map(s => [s.field, src[s.field]]));
}
/** 一關打完：角色身上帶著走的狀態收回肉鴿流程的玩家 */
export function takeBack(p, e) {
  for (const s of CARRIED) p[s.field] = e[s.field];
}
export function endStage(p) {
  for (const m of IMPL.stageOver) m.stageOver(p);
}

// ---- 角色身上效果自己的狀態（entities.js 經這裡建立與同步，不寫死欄位）----

/** 建角色（Entity 的建構子最後）：各效果的狀態從 0 開始；帶著走的照 o 給的（肉鴿流程的 carry）。
 *  角色本來就有同名的欄位 / 方法就丟錯（不然會默默蓋掉；entities.js 載入時就建一個來檢查） */
export function initState(e, o) {
  for (const s of STATE) {
    if (s.field in e) throw new Error(`effect state ${s.field}: the character already has a field with that name`);
    e[s.field] = s.carry ? (o[s.field] || 0) : 0;
  }
}
/** entities.js 載入時呼叫一次：wire = toState 本來的欄位（效果的狀態插進去之前，欄位最多的那種角色）。
 *  效果狀態的同步欄位不能跟它們撞名（會默默蓋掉）、after 要是其中一個（寫錯的話會默默排到最後） */
export function checkState(wire) {
  for (const st of STATE) {
    if (wire.includes(st.wire)) throw new Error(`effect state ${st.field}: wire name "${st.wire}" is already a field of toState`);
    if (st.after !== null && !wire.includes(st.after)) throw new Error(`effect state ${st.field}: after "${st.after}" is not a field of toState`);
  }
}
/** toState：把效果的狀態插進 s（排在各自的 after 後面；沒寫 after、或這個角色沒有那個欄位的放最後），回傳新的物件 */
export function writeState(e, s) {
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    out[k] = v;
    for (const st of STATE) if (st.after === k) out[st.wire] = e[st.field];
  }
  for (const st of STATE) if (!(st.wire in out)) out[st.wire] = e[st.field];
  return out;
}
/** applyState：快照有帶的才套 */
export function readState(e, s) {
  for (const st of STATE) if (s[st.wire] !== undefined) e[st.field] = s[st.wire];
}
/** 開火結果要帶的狀態（{ wire: 值 }） */
export function shotState(e) {
  return Object.fromEntries(STATE.filter(s => s.shot).map(s => [s.wire, e[s.field]]));
}
/** 現在各效果狀態的值（{ 欄位: 值 }；畫面比對開火前後用） */
export function stateOf(e) {
  return Object.fromEntries(STATE.map(s => [s.field, e[s.field]]));
}

// ---- 戰鬥 ----

function slotList(slot) {
  const list = IMPL[slot];
  if (!list || !(slot in HOOKS) || typeof HOOKS[slot] !== 'function') throw new Error(`unknown effect slot "${slot}"`);
  return list;
}
const counts = (m, c) => !m.weapon || m.weapon === c.weaponId;

/** 一個槽的總和：從 start 開始，照 LIST 的順序加上每個效果的貢獻（只對某把武器有用的效果，c.weaponId 不是那把就不算）。e 沒有 mods = start */
export function effectSum(slot, e, c = {}, start = 0) {
  const list = slotList(slot);
  if (!e || !e.mods) return start;
  let s = start;
  for (const m of list) if (counts(m, c)) s += m[slot](e, c);
  return s;
}
/** 一個是非的槽：任一個效果說 true 就是 */
export function effectAny(slot, e, c = {}) {
  const list = slotList(slot);
  if (!e || !e.mods) return false;
  for (const m of list) if (counts(m, c) && m[slot](e, c)) return true;
  return false;
}

/** 輪到 e：第一個要出手的效果，回傳結算那一波攻擊的函式（沒有 = null） */
export function turnBegin(match, e) {
  for (const m of IMPL.turnBegin) {
    const volley = m.turnBegin(match, e);
    if (volley) return volley;
  }
  return null;
}
export function turnStart(match, e, fx) {
  for (const m of IMPL.turnStart) m.turnStart(match, e, fx);
}
export function turnEnd(match, e, fx, isExtra) {
  for (const m of IMPL.turnEnd) m.turnEnd(match, e, fx, isExtra);
}
/** 回合結束的 fx 裡有沒有「同一位再來一回合」 */
export const grantsAgain = (fx) => fx.some(f => IMPL.again.some(m => m.again(f)));
export function afterShot(match, e, hit) {
  for (const m of IMPL.afterShot) m.afterShot(match, e, hit);
}
export function onKill(match, e, killed, fx) {
  for (const m of IMPL.onKill) m.onKill(match, e, killed, fx);
}
export function share(match, hit, c) {
  for (const m of IMPL.share) m.share(match, hit, c);
}
/** 開火紀錄要附的欄位（e 不在了 = 不附） */
export function shotLogOf(e) {
  if (!e) return {};
  const groups = {};
  const on = new Set();
  for (const m of IMPL.shotLog) {
    const L = m.shotLog;
    (groups[L.group] ||= {})[L.field] = L.value(e);
    if (L.on(e)) on.add(L.group);
  }
  return Object.fromEntries(Object.entries(groups).filter(([g]) => on.has(g)));
}

/** 效果給測試 / 工具直接呼叫的動作（名字不能重複） */
export const ACTIONS = Object.freeze(EFFECTS.reduce((all, m) => {
  for (const [k, fn] of Object.entries(m.actions || {})) {
    if (k in all) throw new Error(`effect action "${k}" is defined twice`);
    all[k] = fn;
  }
  return all;
}, {}));

// ---- 畫面（客戶端）----

/** 狀態列上「狀態」（無敵、燃燒、中毒、生命鎖）那幾格的位置：chipOrder 比它小的排在前面 */
export const STATUS_CHIP_ORDER = 150;
const CHIPS = IMPL.chip.slice().sort((a, b) => a.chipOrder - b.chipOrder);

/** e 的效果在狀態列的格子（照 chipOrder 排好）：[{ order, label, color }] */
export function effectChips(e, c) {
  const out = [];
  for (const m of CHIPS) {
    const chip = m.chip(e, c);
    if (chip) out.push({ order: m.chipOrder, label: chip[0], color: chip[1] });
  }
  return out;
}
/** 自己開的一槍套上結果之後的飄字 [[文字, 顏色]]（before = stateOf 套之前） */
export const shotFloats = (e, before) => IMPL.shotFloat.flatMap(m => m.shotFloat(e, before));
/** 這一發有擊殺時的飄字 */
export const killFloats = (e, shot) => IMPL.killFloat.flatMap(m => m.killFloat(e, shot));
/** 回合開始 / 結束的 fx 是效果的：畫面動作（見上面 turnFx）；不是 = null */
export function turnFxOps(fx, e) {
  for (const m of IMPL.turnFx) {
    const ops = m.turnFx(fx, e);
    if (ops) return ops;
  }
  return null;
}
/** shot.kind 是哪個效果的一波攻擊（橫幅）；不是 = null */
export function volleyLook(kind) {
  const m = EFFECTS.find(x => x.volley && x.volley.kind === kind);
  return m ? m.volley : null;
}
