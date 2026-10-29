import { CONFIG } from '../core/config.js';

// 關卡規則：一關之內、不分地圖的數字——敵人血量倍率、敵人傷害倍率、狂熱，加上一場冒險哪幾關是王關、哪幾關是菁英關，
// 以及難度（菁英之路…）換算成的那一場的設定（difficultyConfig：哪幾關是菁英關、敵人傷害倍率換掉）。
// 從「第幾關、幾個人、哪一種地圖（pool：normal / elite / boss）」算出來；數值在 config.js 原本的位置
// （RUN.enemyHpPerStage / bossStages / eliteStages / bossHpPerStage、ENEMY_HP_PER_EXTRA_PLAYER、ENEMY.damageMult / lateFromStage / damageMultLate、FEVER）。
// 菁英關（pool: 'elite'）的數字跟小關一樣：血量照 enemyHp、有狂熱；只有地圖池與打贏後的抽牌獎勵不同（抽牌在 cards.js）。
// config 可以換一份（測試用自己的數字，不改全域 CONFIG）；Match 建場時算一次（match.rules），狂熱層數 = rules.feverAt(match.round)。
// 不在這裡：王自己的參數（嘴巴閉幾回合、每人召喚幾隻樹妖）屬於地圖機制；過關回血、復活血量屬於冒險流程；抽牌權重屬於抽牌。
//
// stageRules({ stage, players, pool, feverFrom }, config) → {
//   enemyHp       一般敵人（含蜜蜂）的血量倍率：每多一位玩家 +ENEMY_HP_PER_EXTRA_PLAYER，每過一關再 +RUN.enemyHpPerStage
//   bossHp        王（含樹妖、閉目養神的回血）的血量倍率：一樣吃人數，不吃每過一關，改吃 bossStageScale（第二個王關以後才變多）
//   enemyDamage   敵人（含王、樹妖、蜜蜂）造成的傷害倍率：第 ENEMY.lateFromStage 關起換成 damageMultLate
//   feverEvery    幾輪疊一層狂熱（照人數查 FEVER.everyRounds）；0 = 這一關沒有狂熱（Boss 關除非 FEVER.inBoss）
//   feverFirst    第一層狂熱從第幾輪開始：平常是第 feverEvery + 1 輪；feverFrom > 1（效果給的，例如狂歡派對）就提早到
//                 min(feverFrom, feverEvery + 1)（不會比原本晚）；沒有狂熱的關卡是 0
//   feverPct      每層狂熱所有傷害 +N%
//   feverAt(round) 第 round 輪疊了幾層（第 feverFirst 輪起 1 層，之後每過 feverEvery 輪再加一層；之前是 0 層）
// }
export function stageRules({ stage = 1, players = 1, pool = 'normal', feverFrom = 0 } = {}, config = CONFIG) {
  const playerScale = 1 + config.ENEMY_HP_PER_EXTRA_PLAYER * Math.max(0, players - 1);
  const E = config.ENEMY;
  // 勝者為王（pool 'versus'）不分人數：每 VERSUS.feverEvery 輪疊一層（10 = 第 11 輪起）
  const every = pool === 'versus' ? (config.VERSUS ? config.VERSUS.feverEvery : 0)
    : pool === 'boss' && !config.FEVER.inBoss ? 0 : feverEvery(players, config);
  const first = every > 0 ? (feverFrom > 1 ? Math.min(feverFrom, every + 1) : every + 1) : 0;
  return {
    stage, players, pool,
    enemyHp: playerScale * (1 + config.RUN.enemyHpPerStage * Math.max(0, stage - 1)),
    bossHp: playerScale * bossStageScale(pool, stage, config),
    enemyDamage: E.lateFromStage > 0 && stage >= E.lateFromStage ? (E.damageMultLate ?? E.damageMult) : E.damageMult,
    feverEvery: every,
    feverFirst: first,
    feverPct: config.FEVER.damagePct,
    feverAt: (round) => (every > 0 && round >= first ? 1 + Math.floor((round - first) / every) : 0),
  };
}

// 第 stage 關是不是 Boss 關（一場冒險從 Boss 池抽地圖的那幾關）
export function isBossStage(stage, config = CONFIG) {
  return config.RUN.bossStages.includes(stage);
}

// 第 stage 關是不是菁英關（從菁英池抽地圖的那幾關；跟 Boss 關重疊的算 Boss 關）
export function isEliteStage(stage, config = CONFIG) {
  return !isBossStage(stage, config) && (config.RUN.eliteStages || []).includes(stage);
}

// 第 stage 關是哪一種關卡：'boss' | 'elite' | 'normal'（= 從哪個地圖池抽，level 的 pool）
export function stageType(stage, config = CONFIG) {
  return isBossStage(stage, config) ? 'boss' : isEliteStage(stage, config) ? 'elite' : 'normal';
}

// ---- 難度（一場冒險開場選的，見 config.DIFFICULTY）----

// 認得的難度（config.DIFFICULTY 的 key）；沒給、不認得、亂送的（不是字串）都當 'normal'
export function difficultyOf(id, config = CONFIG) {
  return typeof id === 'string' && Object.hasOwn(config.DIFFICULTY || {}, id) ? id : 'normal';
}

// 這個難度的一份設定（Run 收下來，一路傳給每一關的 Match，關卡規則就照它算）：normal 原封不動；
// 其他難度蓋掉哪幾關是菁英關（RUN.eliteStages）、敵人傷害倍率（整場都是 enemyDamage：換掉 ENEMY.damageMult、不再分前後兩段）
export function difficultyConfig(id, config = CONFIG) {
  const key = difficultyOf(id, config);
  const d = config.DIFFICULTY && config.DIFFICULTY[key];
  if (key === 'normal' || !d) return config;
  return {
    ...config,
    RUN: Array.isArray(d.eliteStages) ? { ...config.RUN, eliteStages: d.eliteStages.slice() } : config.RUN,
    ENEMY: Number.isFinite(d.enemyDamage) ? { ...config.ENEMY, damageMult: d.enemyDamage, lateFromStage: 0 } : config.ENEMY,
  };
}

// 這個難度畫不畫菁英怪招式的提示範圍（DIFFICULTY 的 rangeHints: false = 不畫，例如菁英之路：大樹守衛的躍擊、衝鋒）。
// 只影響畫面（客戶端的地圖畫面 c.rangeHints），招式本身不變
export function showsRangeHints(id, config = CONFIG) {
  const d = config.DIFFICULTY && config.DIFFICULTY[difficultyOf(id, config)];
  return !(d && d.rangeHints === false);
}

// 大廳的難度說明，照這個難度實際的設定寫：「菁英關：第 3、8 關　敵人傷害：第 1 ~ 5 關打 7 折」
export function difficultyDesc(id, config = CONFIG) {
  const c = difficultyConfig(id, config);
  const stages = Array.from({ length: c.RUN.stageCount }, (_, i) => i + 1);
  const elite = stages.filter(s => isEliteStage(s, c));
  const mult = (s) => stageRules({ stage: s }, c).enemyDamage;
  const cut = stages.filter(s => mult(s) < 1);
  const fold = cut.length ? `打 ${Math.round(mult(cut[0]) * 100) / 10} 折` : '';
  const dmg = !cut.length ? '整場不打折' : cut.length === stages.length ? `整場${fold}` : `第 ${stageList(cut)} 關${fold}`;
  return `菁英關：${elite.length ? `第 ${stageList(elite)} 關` : '沒有'}　敵人傷害：${dmg}`;
}

// [2, 3, 4, 7, 8, 9] → '2 ~ 4、7 ~ 9'；[3, 8] → '3、8'（連續三關以上才寫成範圍）
function stageList(list) {
  const runs = [];
  for (const s of list) {
    const last = runs[runs.length - 1];
    if (last && s === last[1] + 1) last[1] = s;
    else runs.push([s, s]);
  }
  return runs.flatMap(([a, b]) => (b - a >= 2 ? [`${a} ~ ${b}`] : Array.from({ length: b - a + 1 }, (_, i) => String(a + i)))).join('、');
}

// Boss 關的血量倍率（不含人數）：從第一個 Boss 關開始算，之後每多一關 +RUN.bossHpPerStage
// （bossStages [5, 10]、15%：第 5 關 ×1、第 10 關 ×1.75）。不是排定的 Boss 關（測試直接建的 Boss 地圖）就照原本的血量
function bossStageScale(pool, stage, config) {
  const B = config.RUN.bossStages || [];
  if (pool !== 'boss' || !B.includes(stage)) return 1;
  return 1 + (config.RUN.bossHpPerStage || 0) * Math.max(0, stage - Math.min(...B));
}

// 狂熱：players 人的關卡每幾輪疊一層。FEVER.everyRounds 是一個數字（不分人數），或 { 人數: 輪數 }
// （表上沒有的人數照比它少、最接近的那一格；比表上都少就用最少人數那格）。0 = 關掉
function feverEvery(players, config) {
  const e = config.FEVER.everyRounds;
  if (typeof e === 'number') return e;
  const keys = Object.keys(e || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!keys.length) return 0;
  const k = keys.filter(n => n <= players).pop() ?? keys[0];
  return Number(e[k]) || 0;
}
