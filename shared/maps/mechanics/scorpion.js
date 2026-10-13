import { cave } from './cave.js';
import { caveSnapshot, restoreCave } from '../cave.js';
import { buildScorpion, syncLead, isScorpionPart, resolveScorpionTurn, revealIfLit, scorpionAttackMult, scorpionSnapshot, restoreScorpion } from '../scorpion.js';

// 巨蠍巢穴（Boss 關）的地圖機制：洞穴（鐘乳石、火把、陰影，沿用 mechanics/cave.js 的掛勾）+ 洞穴巨蠍（規則在 scorpion.js）。
// 狀態在 match.mechState（buildScorpion 建的：洞穴的狀態 + 在哪個洞 hole、面向 facing、出洞了沒 out、暈眩中 stunned）。
// 火把點燃的每個時間點（打到 / 飛過 / 走過）之後都看一下：巨蠍躲的那個洞亮了就被逼出來、暈眩（revealIfLit）
export const scorpion = {
  ...cave,
  type: 'scorpion',

  // 三個部位：血量照 Boss 的倍率。回傳這一場的狀態
  build(match, { bossScale }) {
    return buildScorpion(match, bossScale);
  },

  // 部位被擊破之後換下一個還在的部位代表巨蠍輪回合（勝負判定前、一波結算完都會叫，可以重複呼叫）
  cascade(match) {
    syncLead(match);
  },

  struck(match, owner, at) {
    const r = cave.struck(match, owner, at);
    if (r && r.lights) revealIfLit(match);
    return r;
  },

  passed(match, owner, seg) {
    const r = cave.passed(match, owner, seg);
    if (r && r.lights) revealIfLit(match);
    return r;
  },

  moved(match, e, x0, y0, x, y) {
    const fx = cave.moved(match, e, x0, y0, x, y);
    if (fx) revealIfLit(match);
    return fx;
  },

  // 陰影加成照洞穴的規則，但巨蠍出洞的攻擊（暈眩醒來的那一回合）不吃（見 scorpion.js 的 scorpionAttackMult）
  attackMult(match, attacker, weapon) {
    return scorpionAttackMult(match, attacker, weapon);
  },

  // 新的一輪：多人時一陣強風把火把全部吹熄（亮度照輪數推，見 cave.js 的 levelOf），紀錄記一筆 wind 再記哪幾支熄了；
  // 火把照這一輪算好之後，巨蠍躲的那個洞還亮著就被逼出來、暈眩（上一輪鑽進火把亮著的洞；紀錄記一筆 reveal）。
  // 客戶端不會呼叫這個：畫面看到輪數變了自己照同一個條件推（client/map-views/scorpion.js 的 update）
  roundStart(match, fx) {
    if (match.mechState.windy) fx.push({ type: 'wind' });
    cave.roundStart(match, fx);
    if (revealIfLit(match)) fx.push({ type: 'reveal', hole: match.mechState.hole });
  },

  // 客戶端照事件點燃火把之後，照同一個條件推巨蠍有沒有被逼出來
  replayEvent(match, ev) {
    const r = cave.replayEvent(match, ev);
    if (ev.lights) revealIfLit(match);
    return r;
  },

  // 輪到巨蠍（代表輪回合的那個部位）：暈眩 / 醒來出招後換洞 / 躲著射毒刺，直接結算好
  aiTurn(match, actor) {
    return isScorpionPart(actor) ? resolveScorpionTurn(match, actor) : null;
  },

  // 洞穴的欄位（火把、掉下來的鐘乳石）+ 在哪個洞、面向、出洞了沒、暈眩中
  snapshot(match) {
    return { ...caveSnapshot(match), ...scorpionSnapshot(match) };
  },

  restore(match, s) {
    restoreCave(match, s);
    restoreScorpion(match, s);
  },
};
