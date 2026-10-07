import { plain } from './plain.js';
import { tree } from './tree.js';
import { snake } from './snake.js';
import { hive } from './hive.js';

// 地圖畫面（見 GLOSSARY.md）：某一張地圖特有的畫面與演出——Boss 出招的動畫、王與招式的畫法、場景、HUD 上的提示、選曲、死亡特效。
// 跟地圖機制（shared/mechanics/）成對：機制決定發生什麼，畫面決定怎麼演出來。照 match.mechanic.type 選（一般小關 = plain，什麼都沒有）。
// render.js / game-view.js 只在下面這些位置呼叫掛勾，不知道有哪些地圖；這裡的檔案也不碰 GameView 本身（不 import 音效 / 畫面模組），
// 所以測試可以直接在 Node 裡載入。不分地圖的東西不放這裡：主題背景（backgrounds.js）、藤蔓、中毒、狙擊手 / 砲兵、武器的畫法。
//
// 掛勾拿到的 c（GameView.mapContext，每次 setup 換一個）就只有這些：
//   c.match         這場的 Match（腳本照伺服器的結果套用：applyEntities、預定的下一招、召喚的角色、掉出來的道具…）
//   c.time          畫面時間（秒，固定步長推進）
//   c.currentId     現在輪到誰（眼睛看著他）
//   c.projectiles   正在重播的飛行物（shotScript 期間 = 重播模組原地更新的那個陣列，其他時候是空的）
//   c.shotScript(shot, extra)   重播一波（yield*）；extra.frame(live) = 每個飛行幀結束時呼叫
//   c.state         這個地圖畫面自己的狀態（create(match) 建的，每次 setup 重建）：出招的預兆、王的畫面位移、
//                   還在飛的道具等只給畫面用的東西放這裡，不放在 Entity / match.items 上
//   c.fx            特效出口（sink）——地圖畫面不直接動 GameView 的粒子 / 震動 / 橫幅，也不直接出聲：
//     particles(x, y, n, opts)  噴一團粒子（GameView.spawnParticles）
//     particle(p)               放一顆自己算好的粒子 { x, y, vx, vy, life, maxLife, size, color, gravity }
//     sound(name, opts)         音效（sfx.play）
//     banner(text, color)       畫面中間的橫幅
//     float(e, text, color, size)  角色頭上的飄字
//     shake(n)                  畫面至少震這麼大（跟現在的取大的）
//     splash(x)                 水面的水花
//     wither()                  地形的樹皮變成枯灰色（古樹倒下）※ 原本直接叫 GameView 的 painter（地形畫布），所以也走出口
//
// 每個掛勾都可以不寫（不寫 = 下面的預設）。ctx2d = canvas 的 2D context；e = 角色；hurt = 剛被打到（畫成白色）。
// 標 ※ 的是當初規劃之外、為了畫面一模一樣（畫圖、飄字、粒子的順序跟改之前相同，見 golden 比對）才多拆出來的：
//   create(match) → state                 每次 setup：這一場的畫面狀態（c.state）
//   musicTrack(c) → 曲目 | null           Boss 關的背景音樂（music.js 的 TRACKS；小關的曲目由 GameView 決定）
//   turnScript(c, msg)                    （generator）aiTurn 帶 boss.steps 的回合：出招的動畫，照伺服器的結果套用
//   showEvent(c, ev, made)                重播一個飛行事件、一般特效之後：這張地圖的東西冒出來（made = 重播模組建出來的道具 / 角色）
//   showDamage(c, e, d) → boolean         ※ 事件裡的一筆傷害（無敵之後、分擔之前）：true = 處理過了，不播一般的扣血
//                                         （古樹之口被打到閉上原本就在這個迴圈的這個位置，跟其他人的飄字照順序排）
//   turnFx(c, e, fx) → boolean            回合結束的效果（燃燒、神佑、噬魂、額外回合以外的）：true = 處理過了；
//                                         false = 交給 GameView.statusFx（中毒結算；不是中毒的再交給下面的 statusFx）
//   statusFx(c, e, fx)                    中毒以外的狀態效果（回合開始的 fx、turnFx 沒處理的）的飄字與特效：GameView.statusFx 處理完中毒才交過來。
//                                         撿到道具不經過這裡（見 onPickup / predictMove，要的話自己呼叫）
//   onPickup(c, e, msg, self)             伺服器的 pickup（走路途中撿到道具）；self = 是自己
//   predictMove(c, me, px, py) → boolean  自己的回合本地走了一幀（從 px, py）：先在本地撿；true = GameView 馬上回報位置
//   onDeath(c, e) → boolean               角色倒下：true = 處理過了，不播一般的「被擊倒」橫幅
//   drawScene(ctx2d, c)                   地形（與它前面的裝飾）之後、瞄準線與角色之前：場景
//   drawEntityFirst(c, e) → boolean       true = 這個角色比其他角色先畫（被蓋在下面）
//   drawEntityBare(ctx2d, c, e) → boolean ※ 一般的畫法（淡出、身體、血條、名字…）之前：true = 自己處理完了（自己畫、或不畫）
//                                         （倒下的古樹之眼 / 沉下去的巨蟒 / 衝出去的蜜蜂原本在 ctx.save() 與淡出之前就畫完返回）
//   drawEntity(ctx2d, c, e, hurt) → false | 'body' | 'whole'
//                                         身體：'body' = 畫好了身體（不畫影子、武器、一般的身體，血條、名字照畫）；
//                                         ※ 'whole' = 連血條、名字都自己畫了（蜂巢原本畫完就 restore 返回，不畫一般的血條、名字、標記）；
//                                         false = 照一般的畫
//   drawFigure(ctx2d, c, e, hurt) → boolean  ※ 影子、武器之後：true = 身體自己畫了（不畫一般的人形）
//                                         （樹妖照一般的畫影子、武器，只換身體；'body' 會連影子、武器一起跳過，所以另外一個掛勾）
//   hpBar(c, e) → { w, h, hidden, ticks } | null   血條：寬、高、不畫、每 ticks% 一道刻度（null = 一般的）
//   drawProjectile(ctx2d, c, p) → boolean 一般的武器之前：true = 畫好了這顆飛行物
//   hud(c, line) → [[text, color], …]    右上隊伍名單底下的幾行（line = 一般的「敵人剩餘」那一行）

const NOOP = () => {};
const HOOKS = {
  create: () => ({}),
  musicTrack: () => null,
  turnScript: function* () {},
  showEvent: NOOP,
  showDamage: () => false,
  turnFx: () => false,
  statusFx: NOOP,
  onPickup: NOOP,
  predictMove: () => false,
  onDeath: () => false,
  drawScene: NOOP,
  drawEntityFirst: () => false,
  drawEntityBare: () => false,
  drawEntity: () => false,
  drawFigure: () => false,
  hpBar: () => null,
  drawProjectile: () => false,
  hud: (c, line) => [line],
};

/** 地圖畫面沒寫的掛勾補上預設；寫錯名字的掛勾直接丟錯（不然會被默默忽略） */
export function defineMapView(adapter) {
  for (const k of Object.keys(adapter)) {
    if (k !== 'type' && !(k in HOOKS)) throw new Error(`map view "${adapter.type}": unknown hook "${k}"`);
  }
  const v = { type: adapter.type };
  for (const [k, dflt] of Object.entries(HOOKS)) v[k] = adapter[k] || dflt;
  return Object.freeze(v);
}

const VIEWS = Object.fromEntries([plain, tree, snake, hive].map(a => [a.type, defineMapView(a)]));

/** 這場（match.mechanic.type）的地圖畫面。沒有對應的畫面 → 丟錯（新的地圖機制要配一個，沒有演出就寫一個空的） */
export function mapViewFor(match) {
  const type = match.mechanic.type;
  if (!Object.prototype.hasOwnProperty.call(VIEWS, type)) throw new Error(`no map view for mechanic "${type}"`);
  return VIEWS[type];
}
