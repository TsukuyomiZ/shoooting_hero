import { cave } from './cave.js';
import { caveSnapshot, restoreCave } from '../cave.js';
import {
  QUEEN_ID, buildSpider, planQueenNext, resolveQueenTurn, resolveSpiderlingTurn, isSpiderling, syncQueen, syncWebs, witherNest,
  touchWeb, shieldsStuck, hitEgg, hitWeb, spiderEventExtras, spiderSnapshot, restoreSpider,
} from '../spider.js';

// 蜘蛛巢穴（Boss 關）的地圖機制：洞穴（鐘乳石、火把、陰影、火把是火源，沿用 mechanics/cave.js 的掛勾）+ 蜘蛛女王、蛛卵、小蜘蛛、蜘蛛網（規則在 spider.js）。
// 狀態在 match.mechState（buildSpider 建的：洞穴的狀態 + 女王的，欄位見 spider.js 開頭）
export const spider = {
  ...cave,
  type: 'spider',

  // 女王的血量照 Boss 的倍率（之後孵出來的小蜘蛛也是，記在狀態的 hpScale）。回傳這一場的狀態
  build(match, scales) {
    return buildSpider(match, scales);
  },

  // 先抽女王的第一招（毒液要打誰，第一個玩家回合就標出來）
  ready(match) {
    planQueenNext(match);
  },

  // 一波結算完：女王倒下 → 蛛卵、小蜘蛛、網全部消失；女王的狀態（掉下來 / 退到背景 / 回來）、被黏住的人跟場面對齊（都可以重複呼叫）。
  // 平常在打中的那一下就換了（eventExtras），這裡是保險：換了的話這一波的結果帶 queen（紀錄照它記；客戶端照同一個條件自己推）
  cascade(match) {
    witherNest(match);
    const queen = syncQueen(match);
    syncWebs(match);
    return queen ? { queen } : null;
  },

  // 玩家走路：踩進蜘蛛網就黏住、碰到火把就點燃（裁判廣播成 pickup；同一段路兩個都碰到就一起帶）
  moved(match, e, x0, y0, x, y) {
    const web = touchWeb(match, e, x0, y0, x, y);
    const torch = cave.moved(match, e, x0, y0, x, y);
    if (web && torch) return { ...web, torch: torch.torch };
    return web || torch;
  },

  // 回合結束（燃燒結算之後）：女王身上的燃燒沒了 → 爬回天上（記進 turn.end 的 fx，客戶端的 turnFx 照它畫爬上去）
  turnEnd(match, e, fx) {
    const change = syncQueen(match);
    if (change) fx.push({ type: 'queen', id: QUEEN_ID, ...change });
  },

  // 被蜘蛛網黏住的人開火一定打在網上：那一下的爆炸傷不到他自己（不扣血、不擊退）；
  // 蛛卵不管被什麼打到都只扣 1（這一下的燃燒照樣上）；蜘蛛網被打到一下就破
  absorbHit(match, e, hit) {
    return shieldsStuck(match, e, hit.attacker) || hitEgg(match, e, hit) || hitWeb(match, e, hit);
  },

  // 這一下打到女王讓她燒起來（掉到地上）/ 打破最後一顆蛋（女王從背景回來）/ 打破網（放開人）：事件帶 queen（同一波後面的砲彈照新的位置算；
  // 客戶端重播到這一下照同一個條件推）
  eventExtras(match) {
    return spiderEventExtras(match);
  },

  // 客戶端照事件播：洞穴的（鐘乳石、火把）+ 女王、網跟這一下之後的場面對齊
  replayEvent(match, ev) {
    const r = cave.replayEvent(match, ev);
    syncQueen(match);
    syncWebs(match);
    return r;
  },

  // 輪到女王 / 小蜘蛛：出招並直接結算好（蛛卵、網不會輪到）
  aiTurn(match, actor) {
    if (actor.id === QUEEN_ID) return resolveQueenTurn(match, actor);
    if (isSpiderling(actor)) return resolveSpiderlingTurn(match, actor);
    return null;
  },

  // 洞穴的欄位（火把、掉下來的鐘乳石）+ 女王的狀態、蛛卵、被黏住的人、下的蛋 / 放的網 / 孵出來的小蜘蛛（包在 spider 一個欄位裡）
  snapshot(match) {
    return { ...caveSnapshot(match), ...spiderSnapshot(match) };
  },

  restore(match, s) {
    restoreCave(match, s);
    restoreSpider(match, s);
  },
};
