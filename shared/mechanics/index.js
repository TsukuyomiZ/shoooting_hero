import { plain } from './plain.js';
import { tree } from './tree.js';
import { snake } from './snake.js';
import { hive } from './hive.js';

// 地圖機制（見 GLOSSARY.md）：某一張地圖特有的規則（Boss 的招式與受擊反應、只在這張圖發生的回合效果與場上道具）。
// 關卡用 mechanic: { type, ...這個機制的資料 } 宣告（見 level.js），沒寫就是一般小關（plain）。
// Match 只在下面這些時間點呼叫掛勾，不知道有哪些地圖；規則本身在 tree-boss.js / snake-boss.js / hive.js，
// mechanics/ 底下每個檔案只決定「什麼時候、照什麼順序」呼叫它們（common.js 例外：規則模組共用的出招小工具）。
// 機制本身沒有狀態（同一個物件給所有對戰共用）。每一場的狀態（Boss 預定的下一招、召喚 / 放出來的角色、流水號、場上的道具…）
// 是一個物件 match.mechState：由機制的 build 建好回傳、Match 存著不碰，之後的掛勾與規則模組都讀寫它（客戶端的地圖畫面直接讀寫）。
// 一般小關沒有狀態 = null。哪張地圖有哪些欄位，見各規則模組的 buildTree / buildSnake / buildHive
//
// 每個掛勾都可以不寫（不寫 = 下面的預設：什麼都不做）：
//   build(match, { hpScale, bossScale }) → state  建構：關卡的敵人之後，加上這個機制的角色（開場落地之前）；
//                                         回傳這一場的狀態，Match 存成 match.mechState（不寫 / 回傳 null = 沒有狀態）
//   ready(match)                          建構：開場落地之後（決定 Boss 的第一招；會抽亂數，順序不能動）
//   cascade(match)                        勝負判定前、一波結算完算擊殺前：這個機制連帶造成的死亡（古樹之眼倒下 → 整棵樹枯萎）。要能重複呼叫
//   moved(match, e, x0, y0, x, y) → fx|null   玩家回報位置（落水檢查之前）：路上撿到的道具，Match 收進 pickups
//   turnStart(match, e, fx)               自己的回合開始：中毒結算之後、回血之前，要飄字的推進 fx
//   turnEnd(match, e, fx)                 每個角色的回合結束：燃燒之後、神佑之石之前
//   absorbHit(match, e, hit) → boolean    爆炸 / 命中結算的第一步（無敵之前），hit = { attacker, friendly, damages, later }：
//                                         回傳 true = 這個角色由機制處理（自己把傷害那一筆推進 damages），不進一般的傷害、燃燒、擊退。
//                                         later = 所有人扣完血之後才照順序執行的函式
//   eventExtras(match) → object           一個 Volley 事件有傷害時（ents 之後）：要附在事件上的欄位（例如 drops、bees）
//   replayEvent(match, ev) → { items, bees }  客戶端重播套用一個事件時：照 eventExtras 帶來的欄位建出道具 / 角色（ShotMade 用）
//   aiTurn(match, actor) → boss|null      AI 回合：這個角色由機制出招就回傳 { steps, next }，null = 照一般 AI
//   snapshot(match) → object              同步快照裡這個機制的欄位（預設值與順序見 snapshotOf）
//   restore(match, s)                     套用快照：地形之後、角色狀態之前（先把快照裡有、這邊還沒有的角色建出來；場上的道具也在這裡換）。
//                                         s 可能只帶一部分欄位（客戶端收到 turn / turnFx 時只帶 { items }）：沒帶的欄位不要動

const NOOP = () => {};
const HOOKS = {
  build: () => null,
  ready: NOOP,
  cascade: NOOP,
  moved: () => null,
  turnStart: NOOP,
  turnEnd: NOOP,
  absorbHit: () => false,
  eventExtras: () => ({}),
  replayEvent: null,   // 一定包一層（補上沒給的 items / bees），見 wrap
  aiTurn: () => null,
  snapshot: () => ({}),
  restore: NOOP,
};

// 機制沒寫的掛勾補上預設；寫錯名字的掛勾直接丟錯（不然會被默默忽略）
function wrap(adapter) {
  for (const k of Object.keys(adapter)) {
    if (k !== 'type' && !(k in HOOKS)) throw new Error(`mechanic "${adapter.type}": unknown hook "${k}"`);
  }
  const m = { type: adapter.type };
  for (const [k, dflt] of Object.entries(HOOKS)) m[k] = adapter[k] || dflt;
  const replay = adapter.replayEvent;
  m.replayEvent = (match, ev) => {
    const r = replay ? replay(match, ev) : null;
    return { items: (r && r.items) || [], bees: (r && r.bees) || [] };
  };
  return Object.freeze(m);
}

const PLAIN = wrap(plain);
const TYPES = { tree: wrap(tree), snake: wrap(snake), hive: wrap(hive) };
// 舊格式：機制的資料直接掛在關卡上（tree: {...} / snake: {...} / hive: {...}）
const LEGACY_KEYS = ['tree', 'snake', 'hive'];

/** 這張地圖的機制（沒有 mechanic 欄位 = 一般小關 plain）。type 不認得 / 還在用舊的 tree/snake/hive 欄位 → 丟錯 */
export function mechanicFor(level, levelId = '?') {
  for (const k of LEGACY_KEYS) {
    if (k in level) throw new Error(`level ${levelId} uses the old "${k}" field: write mechanic: { type: '${k}', ... } instead`);
  }
  const def = level.mechanic;
  if (!def) return PLAIN;
  const m = Object.prototype.hasOwnProperty.call(TYPES, def.type) ? TYPES[def.type] : null;
  if (!m) throw new Error(`unknown mechanic type "${def.type}" in level ${levelId}`);
  return m;
}

// Match.snapshot 裡跟地圖機制有關的欄位：沒有這個機制的地圖也照樣帶（預設值），欄位順序固定
// （minions、treeNext、snakeNext、items、bees；客戶端與重連都照這個格式）。場上的道具（items，目前只有巨蟒的蛇血）每張地圖都帶，沒有就是空的
export function snapshotOf(match) {
  return {
    minions: [],
    treeNext: null,
    snakeNext: null,
    items: [],
    bees: [],
    ...match.mechanic.snapshot(match),
  };
}
