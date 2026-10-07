import { CONFIG } from './config.js';
import { isEquippable } from './weapons.js';
import {
  EFFECT_KEYS, INSTANT_KEYS, WEAPON_ONLY_KEYS, TEAM_ONLY_KEYS, DEFAULT_MODS, deriveStats, applied, needsTeammate,
} from './effects/index.js';

// 牌庫引擎：驗證 cards.json、依稀有度抽牌、把牌的效果套到玩家數值上、武器欄的換裝規則。
// 牌的資料在 shared/cards.json，欄位說明見 README「牌庫」。每個效果 key 的說明與規則在 shared/effects/（這裡只照登記表算）

export const RARITIES = ['white', 'green', 'purple', 'gold'];

// 可用的效果鍵與說明（從效果的登記表來，見 shared/effects/index.js）
export { EFFECT_KEYS };

const INSTANT = new Set(INSTANT_KEYS);

export const equippableWeapons = () => Object.keys(CONFIG.WEAPONS).filter(isEquippable);

// 每位玩家帶著跑整場冒險的加成（全部從 0 開始）
export function baseStats() {
  return Object.fromEntries(Object.keys(EFFECT_KEYS).filter(k => !INSTANT.has(k)).map(k => [k, 0]));
}

// 只對某把武器有用的效果（見效果的 weapon）：一張牌的效果全是同一把武器的、而玩家沒有那把武器時，這張牌不會出現
function requiredWeapon(card) {
  if (card.weapon) return null;
  const keys = Object.keys(card.effects);
  const need = keys.length ? WEAPON_ONLY_KEYS[keys[0]] : null;
  return need && keys.every(k => WEAPON_ONLY_KEYS[k] === need) ? need : null;
}

// 只有多人才有用的效果（要有隊友，見效果的 teamOnly）。一張牌的效果全是這種時，單人冒險不會出現
const TEAM_ONLY = new Set(TEAM_ONLY_KEYS);

// 檢查牌庫，回傳 { cards, warnings }。有問題的牌會被略過，不讓伺服器炸掉。
export function validateCards(raw) {
  const warnings = [];
  const cards = [];
  const seen = new Set();
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.cards) ? raw.cards : []);
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (!c.id || typeof c.id !== 'string') { warnings.push(`有一張牌沒有 id：${JSON.stringify(c).slice(0, 60)}`); continue; }
    if (seen.has(c.id)) { warnings.push(`牌 id 重複：${c.id}`); continue; }
    if (!RARITIES.includes(c.rarity)) { warnings.push(`牌 ${c.id} 的稀有度「${c.rarity}」不認得（要是 white/green/purple/gold）`); continue; }
    if (c.weapon != null && !isEquippable(c.weapon)) {
      warnings.push(`牌 ${c.id} 的武器「${c.weapon}」不認得（可用：${equippableWeapons().join(' / ')}）`);
      continue;
    }
    const effects = c.effects && typeof c.effects === 'object' ? c.effects : {};
    for (const k of Object.keys(effects)) {
      if (!(k in EFFECT_KEYS)) warnings.push(`牌 ${c.id} 有不認得的效果「${k}」，會被忽略`);
      else if (!Number.isFinite(effects[k])) warnings.push(`牌 ${c.id} 的效果 ${k} 不是數字`);
    }
    seen.add(c.id);
    const card = {
      id: c.id,
      name: String(c.name || c.id),
      rarity: c.rarity,
      desc: String(c.desc || ''),
      unique: !!c.unique,
      minStage: Number.isFinite(c.minStage) ? c.minStage : 1,
      weapon: c.weapon || null,   // 武器牌：拿到後放進武器欄
      effects: Object.fromEntries(Object.entries(effects).filter(([k, v]) => k in EFFECT_KEYS && Number.isFinite(v))),
    };
    card.requires = requiredWeapon(card);
    const keys = Object.keys(card.effects);
    card.teamOnly = keys.length > 0 && keys.every(k => TEAM_ONLY.has(k));
    cards.push(card);
  }
  return { cards, warnings };
}

// 依關數算各稀有度的權重
export function rarityWeights(stage) {
  const R = CONFIG.RUN;
  const w = {};
  for (const r of RARITIES) {
    w[r] = Math.max(0, (R.rarityWeights[r] || 0) + (R.rarityWeightPerStage[r] || 0) * Math.max(0, stage - 1));
  }
  return w;
}

// 抽 count 張不重複的牌。owned = 這位玩家已有的牌 id（unique 的牌不再出現）；
// weapons = 他目前的武器欄：已經有的武器不會再出、只對他沒有的武器有用的牌也不會出（不給就不過濾）；
// solo = 單人冒險：只有多人才有用的牌（teamOnly）不出；linkTargets = 還能被他指定的隊友數，0 = 要指定隊友的牌（攜手之伴）不出（不給就不過濾）
export function drawOffers(cards, rng, stage, count, owned = [], weapons = null, { solo = false, linkTargets = null } = {}) {
  const weights = rarityWeights(stage);
  const pool = cards.filter(c => c.minStage <= stage
    && !(c.unique && owned.includes(c.id))
    && !(weapons && c.weapon && weapons.includes(c.weapon))
    && !(weapons && c.requires && !weapons.includes(c.requires))
    && !(solo && c.teamOnly)
    && !(linkTargets !== null && needsTeammate(c) && linkTargets <= 0));
  const offers = [];
  const used = new Set();
  for (let i = 0; i < count && used.size < pool.length; i++) {
    // 先抽稀有度（只算還有牌的稀有度），再從該稀有度隨機挑一張
    const avail = RARITIES.filter(r => pool.some(c => c.rarity === r && !used.has(c.id)));
    if (!avail.length) break;
    const total = avail.reduce((s, r) => s + weights[r], 0);
    let roll = rng.float() * total;
    let rarity = avail[avail.length - 1];
    for (const r of avail) { roll -= weights[r]; if (roll < 0) { rarity = r; break; } }
    const choices = pool.filter(c => c.rarity === rarity && !used.has(c.id));
    const card = rng.pick(choices);
    used.add(card.id);
    offers.push(card);
  }
  return offers;
}

// 選這張牌之前要不要先丟掉一把武器（武器欄已滿）
export function needsDiscard(weapons, card) {
  return !!card.weapon && !weapons.includes(card.weapon) && weapons.length >= CONFIG.EQUIP.maxWeapons;
}

// 把武器牌裝進武器欄：沒滿就放最後一格；滿了就換掉 discard 那一格（沒給或不合法 → 新武器不要）。
// 回傳 { weapons, discarded }
export function equipWeapon(weapons, card, discard) {
  if (!card.weapon || weapons.includes(card.weapon)) return { weapons, discarded: null };
  if (weapons.length < CONFIG.EQUIP.maxWeapons) return { weapons: [...weapons, card.weapon], discarded: null };
  const i = weapons.indexOf(discard);
  if (i < 0) return { weapons, discarded: null };
  const next = weapons.slice();
  next[i] = card.weapon;
  return { weapons: next, discarded: discard };
}

// 把牌的效果加到 stats 上。回傳立即效果（INSTANT_KEYS 各自的總和，例如 { heal, healPct, teamHealPct, allyHeal, nextDamagePct, nextMaxHp, link }），
// 由呼叫者（肉鴿流程）交給各效果：套到血量、存成下一關的暫時加成、處理連結對象
export function applyCard(stats, card) {
  const now = Object.fromEntries(INSTANT_KEYS.map(k => [k, 0]));
  for (const [k, v] of Object.entries(card.effects)) {
    if (k in now) now[k] += v;
    else if (k in stats) stats[k] += v;
    applied(k, now, v);   // 例如加上限的牌同時補等量的血
  }
  return now;
}

// 由基礎值與 stats 算出這一關的實際數值：各效果的基礎數值（maxHp、maxStamina、moveSpeed、jumpSpeed、size）+ 戰鬥的 mods
export function derivePlayerStats(stats) {
  return {
    ...deriveStats(stats, CONFIG.PLAYER),
    mods: Object.fromEntries(Object.keys(DEFAULT_MODS).map(k => [k, stats[k] || 0])),
  };
}
