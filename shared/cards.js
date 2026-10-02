import { CONFIG } from './config.js';
import { DEFAULT_MODS } from './entities.js';
import { isEquippable } from './weapons.js';

// 牌庫引擎：驗證 cards.json、依稀有度抽牌、把牌的效果套到玩家數值上、武器欄的換裝規則。
// 牌的資料在 shared/cards.json，欄位說明見 README「牌庫」。

export const RARITIES = ['white', 'green', 'purple', 'gold'];

// 可用的效果鍵與說明（也給 README 用）
export const EFFECT_KEYS = {
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
  link:             `選牌時指定一名隊友「連結」（填 1）：兩人受到的傷害先 -${CONFIG.EQUIP.link.damageCutPct}%，再跟活著的連結對象平分`,
};

// 拿到牌的當下生效、不會累積到數值上的效果（由肉鴿流程處理：回血、下一關的暫時加成、選連結對象）
const INSTANT_KEYS = new Set(['heal', 'healPct', 'teamHealPct', 'allyHeal', 'nextDamagePct', 'nextMaxHp', 'link']);

// 只對某把武器有用的效果。一張牌的效果全是同一把武器的、而玩家沒有那把武器時，這張牌不會出現
const WEAPON_ONLY_KEYS = {
  cannonDamagePct: 'cannon', radiusPct: 'cannon', cannonBurnStacks: 'cannon', cannonBounce: 'cannon',
  sniperDamagePct: 'sniper', sniperBounce: 'sniper', sniperPierce: 'sniper',
};

// 只有多人才有用的效果（要有隊友）。一張牌的效果全是這種時，單人冒險不會出現
const TEAM_ONLY_KEYS = new Set(['allyHeal', 'allyDamagePct', 'allyArmorPct', 'link']);

export const equippableWeapons = () => Object.keys(CONFIG.WEAPONS).filter(isEquippable);

// 每位玩家帶著跑整場冒險的加成（全部從 0 開始）
export function baseStats() {
  return Object.fromEntries(Object.keys(EFFECT_KEYS).filter(k => !INSTANT_KEYS.has(k)).map(k => [k, 0]));
}

function requiredWeapon(card) {
  if (card.weapon) return null;
  const keys = Object.keys(card.effects);
  const need = keys.length ? WEAPON_ONLY_KEYS[keys[0]] : null;
  return need && keys.every(k => WEAPON_ONLY_KEYS[k] === need) ? need : null;
}

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
    card.teamOnly = keys.length > 0 && keys.every(k => TEAM_ONLY_KEYS.has(k));
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
// solo = 單人冒險：只有多人才有用的牌（teamOnly）不出；linkTargets = 還能被他連結的隊友數，0 = 攜手之伴不出（不給就不過濾）
export function drawOffers(cards, rng, stage, count, owned = [], weapons = null, { solo = false, linkTargets = null } = {}) {
  const weights = rarityWeights(stage);
  const pool = cards.filter(c => c.minStage <= stage
    && !(c.unique && owned.includes(c.id))
    && !(weapons && c.weapon && weapons.includes(c.weapon))
    && !(weapons && c.requires && !weapons.includes(c.requires))
    && !(solo && c.teamOnly)
    && !(linkTargets !== null && c.effects.link > 0 && linkTargets <= 0));
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

// 把牌的效果加到 stats 上。回傳立即效果 { heal, healPct, teamHealPct, allyHeal, nextDamagePct, nextMaxHp, link }，
// 由呼叫者（肉鴿流程）套到血量、存成下一關的暫時加成、處理連結對象
export function applyCard(stats, card) {
  const now = Object.fromEntries([...INSTANT_KEYS].map(k => [k, 0]));
  for (const [k, v] of Object.entries(card.effects)) {
    if (k in now) now[k] += v;
    else if (k in stats) stats[k] += v;
    if (k === 'maxHp') now.heal += v;   // 加上限的牌同時補等量的血
  }
  return now;
}

// 由基礎值與 stats 算出這一關的實際數值
export function derivePlayerStats(stats) {
  const P = CONFIG.PLAYER;
  return {
    maxHp: Math.max(1, Math.round(P.hp + stats.maxHp)),
    maxStamina: Math.round(P.stamina + stats.staminaMax),
    moveSpeed: P.moveSpeed * Math.max(0.2, 1 + stats.moveSpeedPct / 100),
    jumpSpeed: P.jumpSpeed * Math.max(0.2, 1 + stats.jumpSpeedPct / 100),
    size: 1 + stats.sizePct / 100,
    mods: Object.fromEntries(Object.keys(DEFAULT_MODS).map(k => [k, stats[k] || 0])),
  };
}
