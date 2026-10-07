import { CONFIG } from './config.js';

// 關卡規則：一關之內、不分地圖的數字——敵人血量倍率、敵人傷害倍率、狂熱，加上一場冒險哪幾關是王關。
// 從「第幾關、幾個人、哪一種地圖（pool：normal / boss）」算出來；數值在 config.js 原本的位置
// （RUN.enemyHpPerStage / bossStages / bossHpPerStage、ENEMY_HP_PER_EXTRA_PLAYER、ENEMY.damageMult / lateFromStage / damageMultLate、FEVER）。
// config 可以換一份（測試用自己的數字，不改全域 CONFIG）；Match 建場時算一次（match.rules），狂熱層數 = rules.feverAt(match.round)。
// 不在這裡：王自己的參數（嘴巴閉幾回合、每人召喚幾隻樹妖）屬於地圖機制；過關回血、復活血量屬於冒險流程；抽牌權重屬於抽牌。
//
// stageRules({ stage, players, pool }, config) → {
//   enemyHp       一般敵人（含蜜蜂）的血量倍率：每多一位玩家 +ENEMY_HP_PER_EXTRA_PLAYER，每過一關再 +RUN.enemyHpPerStage
//   bossHp        王（含樹妖、閉目養神的回血）的血量倍率：一樣吃人數，不吃每過一關，改吃 bossStageScale（第二個王關以後才變多）
//   enemyDamage   敵人（含王、樹妖、蜜蜂）造成的傷害倍率：第 ENEMY.lateFromStage 關起換成 damageMultLate
//   feverEvery    幾輪疊一層狂熱（照人數查 FEVER.everyRounds）；0 = 這一關沒有狂熱（Boss 關除非 FEVER.inBoss）
//   feverPct      每層狂熱所有傷害 +N%
//   feverAt(round) 第 round 輪疊了幾層（第 1 ~ feverEvery 輪是 0 層）
// }
export function stageRules({ stage = 1, players = 1, pool = 'normal' } = {}, config = CONFIG) {
  const playerScale = 1 + config.ENEMY_HP_PER_EXTRA_PLAYER * Math.max(0, players - 1);
  const E = config.ENEMY;
  const every = pool === 'boss' && !config.FEVER.inBoss ? 0 : feverEvery(players, config);
  return {
    stage, players, pool,
    enemyHp: playerScale * (1 + config.RUN.enemyHpPerStage * Math.max(0, stage - 1)),
    bossHp: playerScale * bossStageScale(pool, stage, config),
    enemyDamage: E.lateFromStage > 0 && stage >= E.lateFromStage ? (E.damageMultLate ?? E.damageMult) : E.damageMult,
    feverEvery: every,
    feverPct: config.FEVER.damagePct,
    feverAt: (round) => (every > 0 ? Math.max(0, Math.floor((round - 1) / every)) : 0),
  };
}

// 第 stage 關是不是 Boss 關（一場冒險從 Boss 池抽地圖的那幾關）
export function isBossStage(stage, config = CONFIG) {
  return config.RUN.bossStages.includes(stage);
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
