// 所有可調參數集中在這裡（伺服器與瀏覽器共用同一份）
export const CONFIG = {
  WORLD_W: 1024,
  WORLD_H: 768,
  WATER_LEVEL: 650,       // 腳底 y 超過此值 = 落水
  // 落水（玩家）：扣最大血量的 damagePct%（不吃狂熱、減傷、無敵），不夠扣就淹死；
  // 撐得住就回到最後站穩的地方（那裡被炸掉了就找最近站得住的地面）。自己的回合掉下去回合不會結束，還有體力就能接著動。
  // enemiesDrown = 敵人（含樹妖）落水一樣直接淹死；safeMargin = 重生點至少要在水面上方幾 px（不會一重生就站在水邊）
  WATER: { damagePct: 30, enemiesDrown: true, safeMargin: 10 },
  GRAVITY: 900,           // 角色重力 (px/s^2)
  FIXED_DT: 1 / 60,       // 固定物理步長（所有模擬都用這個）

  // ---- 肉鴿流程 ----
  RUN: {
    stageCount: 10,            // 一場冒險總共幾關（打贏最後一關 = 通關）
    // 第幾關是 Boss 關：從 Boss 池抽，同一場冒險不會抽到同一隻（Boss 池有幾隻就最多幾關不重複，再多才會重複）。
    // 其他關都是小關；Boss 關打贏後一樣回血、選牌，再接著打下去
    bossStages: [5, 10],
    // 第幾關是菁英關：從菁英池（level 的 pool: 'elite'）抽地圖，一隻強力的菁英怪鎮守（同一場冒險先挑還沒打過的，菁英池只有一張就重複）。
    // 跟 Boss 關重疊的關卡算 Boss 關。血量、傷害、狂熱照小關的規則（見 shared/game/stage-rules.js）；打贏後選牌的稀有度權重另外加 eliteRarityBonus
    eliteStages: [3, 8],
    // 小關抽地圖：每張小地圖一開始權重一樣，這場冒險每出現過一次，權重就 × 這個（1 → 0.25 → 0.0625…），
    // 出現越多次越難再抽到，才不會一場裡同一張重複三四次（也不會連續同一張）。1 = 不下調、0 = 小地圖輪完一遍才重複
    normalRepeatWeight: 0.25,
    // Boss 關的血量成長：從第一個 Boss 關開始算，之後每多一關 +N（跟小關的 enemyHpPerStage 一樣 15%）。
    // 第 5 關的王照原本的血量，第 10 關的王 ×1.75（後面幾關玩家的牌比較多，不加會太好打）。召喚的樹妖、閉目養神的回血也一起放大
    bossHpPerStage: 0.15,
    enemyHpPerStage: 0.15,     // 每過一關敵人血量 +15%
    healPctOnClear: 0.3,       // 過關後回血（血量上限的比例）
    reviveHpPct: 0.5,          // 倒下的隊友下一關復活時的血量比例
    pickTime: 30,              // 選牌秒數，超時或斷線者隨機選
    offers: 3,                 // 每次給幾張牌
    rarityWeights: { white: 55, green: 30, purple: 12, gold: 3 },   // 抽牌權重
    rarityWeightPerStage: { white: -5, green: 0, purple: 3, gold: 1 }, // 每過一關權重的變化
    // 打贏菁英關後的那次選牌：各稀有度的機率再加幾個百分點（使用者定的：綠 +10%、紫 +5%、金 +1%），加的部分從白卡扣（見 cards.js 的 rarityWeights）
    eliteRarityBonus: { white: 0, green: 10, purple: 5, gold: 1 },
  },
  RARITY: {
    white:  { name: '白', color: '#e5e7eb' },
    green:  { name: '綠', color: '#22c55e' },
    purple: { name: '紫', color: '#a855f7' },
    gold:   { name: '金', color: '#f59e0b' },
  },

  // ---- 多人規則 ----
  MAX_PLAYERS: 4,
  TURN_TIME: 30,                   // 每回合秒數
  FRIENDLY_FIRE: 0.6,              // 同隊（含自己）受到的傷害倍率
  ENEMY_HP_PER_EXTRA_PLAYER: 0.5,  // 每多一位玩家，敵人血量 +50%（加法：2 人 ×1.5、3 人 ×2、4 人 ×2.5）
  PLAYER_COLORS: ['#3b82f6', '#22c55e', '#a855f7', '#f97316'],

  // 狂熱：避免雙方血量太多、一關打太久。每過 everyRounds 輪（畫面左上的「第 N 輪」），
  // 所有角色（玩家與敵人）造成的傷害 +damagePct%，會疊加（每關重新算）。誤傷、燃燒也吃這個加成；回血不受影響。
  // everyRounds 照這一關的玩家人數 { 人數: 輪數 }：人越多一輪越久，就越早狂熱。
  //   4 人每 7 輪（第 8 輪起 +50%、第 15 輪起 +100%…）、2 ~ 3 人每 8 輪（第 9 輪起）、1 人每 9 輪（第 10 輪起）。
  //   表上沒有的人數照比它少、最接近的那一格；也可以直接填一個數字 = 不分人數；0 = 關掉
  // Boss 關有自己的機制，不套用狂熱（inBoss 改成 true 才會套用）
  FEVER: { everyRounds: { 1: 9, 2: 8, 3: 8, 4: 7 }, damagePct: 50, inBoss: false },

  PLAYER: {
    hp: 150,
    stamina: 200,         // 耐力上限，每回合開始回滿
    moveSpeed: 130,       // px/s
    jumpSpeed: 380,       // 起跳初速
    moveCost: 45,         // 移動每秒消耗耐力（爬藤蔓也是這個）
    jumpCost: 30,         // 每次跳躍消耗耐力
    vineSpeed: 100,       // 爬藤蔓的速度（px/s，見 Entity.updateVine）
    // 掛在藤蔓上不動時每秒消耗的耐力：只在自己的回合扣，扣到 0 就鬆手掉下去；
    // 回合結束（開火、超時）時還有體力、還掛著，就一直掛到下一個自己的回合（別人的回合不扣）
    vineHangCost: 20,
  },

  // 慢動作：自己的回合在空中（沒抓藤蔓）按住左鍵瞄準時，整個畫面放慢，方便抓角度。只放慢自己的畫面，回合倒數照真實時間走。
  // scale = 放慢後的速度倍率（0.2 = 慢 80%、只剩 20% 的速度；數字越小越慢）；cost = 每「真實」一秒消耗的體力，體力歸零就解除（落地、抓到藤蔓、放開左鍵開火也會解除）；
  // rampIn = 幾秒內從正常速度慢下來；musicRate = 慢動作時背景音樂的播放速度（音調會跟著變低，1 = 不變）。scale 設 1 = 關掉慢動作
  SLOWMO: { scale: 0.2, cost: 50, rampIn: 0.15, musicRate: 0.85 },

  // 「中毒」狀態（叢林巨蟒的攻擊）：在被毒的人自己的回合開始時結算——每層扣最大血量 pctPerStack%，
  // 同時把最大血量鎖住一樣多（100/100 → 99/99，被鎖住的部分血條畫成灰色）。
  // persist = 層數不會自己消失：每個自己的回合開始都再結算一次，再被打中還會疊上去，要喝蛇血才解除（false = 結算完就歸零）。
  // 鎖住的上限也只有蛇血解得開（喝了順便回 SNAKE_BOSS.bloodHeal 血）；不吃減傷、狂熱
  POISON: { pctPerStack: 1, persist: true },

  ENEMY: {
    hp: 45,              // 基礎血量（會依人數放大）
    damageMult: 0.7,     // 敵人（含 Boss）造成的傷害 = 武器傷害 × 這個倍率（再吃狂熱）。這是第一輪（第 1 ~ 5 關）的
    // 第二輪：從第 lateFromStage 關起（第 6 關 = 第一隻王之後），敵人傷害倍率改成 damageMultLate（1 = 不再抑制，等於 +0.3）。
    // lateFromStage 設 0 = 整場都用 damageMult
    lateFromStage: 6,
    damageMultLate: 1,
    stamina: 200,
    moveSpeed: 110,
    jumpSpeed: 380,
    moveCost: 45,
    jumpCost: 30,
    color: '#ef4444',
    aimError: { angle: 5, power: 10 },  // AI 瞄準誤差（越小越準、越難）
    sniperSpread: 1.2,                   // 用狙擊槍時的角度誤差（±度）
    sniperChance: 0.4,                   // 有直線視野時改用狙擊槍的機率
    moveChance: 1,                       // 回合開始時走動的機率（1 = 每回合都走，走法見 AI_MOVE）
  },

  // 敵人走動（2026-10-08 使用者：所有敵人都要會走動，不然玩家永遠瞄同一個地方就好；規則在 shared/ai/ai-move.js）。
  // 每種敵人走不走看自己的 moveChance；古樹、巨蟒、蜜蜂有自己的動法，不走。
  // dist = 每回合想走多遠（px，隨機；照自己的速度換成幾幀，最多 maxFrames 幀）；走不到 minDist 就換另一邊走（窄的樹枝 / 石柱上走得到多少算多少）。
  // keepDir = 沿著上一回合方向繼續走的機率（不然隨機），走到底才回頭。
  // 每一步都先看前面 edge px（從身體邊緣算）那一行：要有地面 / 平台、最多往下 maxDrop px、而且在水面上方，不然就停（不會走進水裡、走下懸崖、走出樹枝）。
  // allyGap = 跟同一層的同伴（中心）至少隔多遠（狙擊手靠太近，外側那隻的子彈會被內側那隻擋住）。
  // glideTries = 飄在空中的（蝙蝠）挑幾個方向找飄得到 minDist 的地方。
  // takeoverChance = 斷線玩家的 AI 代打走動的機率（玩家不是敵人，照以前的 0.6；走法一樣）
  AI_MOVE: { dist: [30, 80], minDist: 20, maxFrames: 90, keepDir: 0.65, edge: 8, maxDrop: 40, allyGap: 56, glideTries: 12, takeoverChance: 0.6 },

  // 狙擊手（地圖「樹影重重」）：只用狙擊槍，每回合在樹枝上走一段（走不出樹枝）。關卡的 enemySpawns 寫 type: 'sniper' 就是牠
  SNIPER: {
    hp: 30,              // 基礎血量（跟一般敵人一樣依人數、關數放大）
    stamina: 100,
    moveSpeed: 110,
    jumpSpeed: 380,
    moveCost: 45,
    jumpCost: 30,
    color: '#4d5f2a',
    aimError: { angle: 5, power: 10 },  // 拋射武器用的誤差（狙擊手沒有拋射武器，用不到）
    sniperSpread: 3,                     // 狙擊槍的角度誤差（±度）。好幾隻一起開火，太準單人撐不住；越小越準、越難
    sniperChance: 1,
    moveChance: 1,                       // 每回合都走（2026-10-08 使用者改，原本不走動）；只在樹枝上走，不會走下去
    weapons: ['sniper'],
  },

  // 砲兵（地圖「腹背受敵」，「大亂鬥」也會隨機抽到）：只用大砲，每回合在自己的台地上走一段。關卡的 enemySpawns 寫 type: 'artillery' 就是牠
  ARTILLERY: {
    hp: 45,              // 基礎血量（使用者沒指定，跟一般敵人一樣；依人數、關數放大）
    stamina: 100,
    moveSpeed: 110,
    jumpSpeed: 380,
    moveCost: 45,
    jumpCost: 30,
    color: '#7c2d12',
    aimError: { angle: 5, power: 10 },  // 大砲的瞄準誤差（越小越準、越難）
    sniperChance: 0,
    moveChance: 1,                       // 每回合都走（2026-10-08 使用者改，原本不走動）；不會走進水裡
    weapons: ['cannon'],
    // 砲彈的擊退 -50%：腹背受敵的石柱很窄、兩邊是水，原本的擊退幾乎每一發直擊都會把人打進水裡（-30% 最大血量）。
    // 設 0 = 跟一般大砲一樣（越接近 0 越容易被打下水）
    mods: { knockbackPct: -50 },
  },

  // 蝙蝠（地圖「岩穴」）：飄在空中（不受重力、不會被擊退、不會落水），只用聲波（打法跟狙擊槍一樣：直線、會被地形擋住）。
  // 每回合在出生點周圍（±roam.x、±roam.y px 的框框）直線飄一段（速度 roam.speed px/s；碰不到地形、岩台，見 shared/ai/ai-move.js）。
  // 關卡的 enemySpawns 寫 type: 'bat' 就是牠；血量跟一般敵人一樣依人數、關數放大
  BAT: {
    hp: 45,
    fixed: true,         // 飄在空中：不受重力（畫面上會上下晃，判定只看位置）
    roam: { x: 120, y: 40, speed: 60 },
    hw: 14,              // 判定的半寬（含翅膀的身體）
    h: 22,               // 判定的高度
    stamina: 100,
    moveSpeed: 0,
    jumpSpeed: 0,
    moveCost: 0,
    jumpCost: 0,
    color: '#4c1d95',
    aimError: { angle: 5, power: 10 },  // 拋射武器用的誤差（蝙蝠沒有拋射武器，用不到）
    sniperSpread: 3,                     // 聲波的角度誤差（±度；跟狙擊手一樣）
    sniperChance: 1,
    moveChance: 1,                       // 每回合都飄一段（2026-10-08 使用者改，原本不動）
    weapons: ['sonic'],
  },

  // ---- 洞穴地形（地圖「岩穴」，規則在 shared/maps/cave.js）----
  // 鐘乳石：天花板垂下來的，被打到（直擊或爆炸範圍碰到）就整根掉下來，砸到誰傷害照 WEAPONS.stalactite（算打下它的人的攻擊）。
  // 火把：一開始只有出生點那支亮著（光很微弱），其他的要點燃才看得到周圍；看不到也打得到敵人。
  // 玩家方的攻擊打在火把附近（落點離火把 torchReach px 內，爆炸的話再加上爆炸半徑）、從火把旁邊飛過去（離火把 torchPass px 內，
  // 再加上飛行物的判定半徑）、或玩家自己走過去碰到，就點燃（還亮著但變暗了的就補回最亮）。
  // 火把會燒完：點燃的那一輪最亮，之後每一輪開始暗一格，一直沒人去點就 torchRounds 輪後熄滅（3：3 → 2 → 1 → 熄），熄了可以再點。
  // 光圈半徑：最亮時 torchLight px（出生點那支微弱的 faintLight），最暗那一格乘 dimLight，中間照比例。
  // 陰影 = 不在任何一支亮著的火把的光圈裡：站在陰影裡的敵人造成的傷害 +shadowDamagePct%（跟敵人傷害倍率、狂熱相乘；掉下來的鐘乳石不算）
  CAVE: { torchReach: 24, torchPass: 10, torchRounds: 3, torchLight: 270, faintLight: 150, dimLight: 0.45, shadowDamagePct: 30 },

  // ---- 小關「小心擊發」：樹枝最左邊掛著的蜂巢，與它放出來的蜜蜂（規則在 shared/maps/hive.js）----
  // 蜂巢打不打都可以（不用打掉也能過關，狙擊手全倒就贏）；不管用什麼打、打多重都只扣 1，每被玩家打到一次就飛出一隻蜜蜂。
  // 直擊或爆炸波及都算一次；等離子三發都打到 = 三次。敵人自己的子彈會穿過蜂巢與蜜蜂，不算
  HIVE: { hp: 5 },
  // 蜜蜂：飛在空中（不受重力、不會被擊退），剛飛出來的第一個回合先待機（waitTurns），下一個回合衝向離牠最近的玩家：
  // 傷害照 WEAPONS.beeSting（再吃敵人傷害倍率與狂熱）+ 中毒（中毒規則見 POISON）。
  // diesOnSting = 螫一次就死掉（像真的蜜蜂）；改成 false 的話螫完停在那位玩家旁邊，之後每個回合再衝。
  // 血量跟一般敵人一樣依人數、關數放大
  BEE: {
    hp: 30,
    waitTurns: 1,
    diesOnSting: true,
    hw: 10,              // 判定的半寬（比人小）
    h: 18,               // 判定的高度
    stamina: 100,
    moveSpeed: 0,
    jumpSpeed: 0,
    moveCost: 0,
    jumpCost: 0,
    color: '#facc15',
    aimError: { angle: 0, power: 0 },   // 蜜蜂不瞄準（直接衝過去），用不到
    sniperChance: 0,
    moveChance: 0,
    weapons: ['beeSting'],
  },

  // ---- Boss 關：古樹之庭 ----
  // 古樹長在地圖最右邊，只有眼睛與嘴巴打得到。眼睛打倒 = 通關（剩下的樹妖跟著枯萎）。
  // 古樹之口打不壞：被攻擊到（直擊或爆炸波及）就閉上，閉著的時候古樹不能召喚，撐過幾個古樹回合後再張開（單人 / 多人不同）。
  // 眼睛與樹妖的血量跟一般敵人一樣「每多一位玩家 +50%」，但不吃小關的「每過一關 +15%」，改吃 RUN.bossHpPerStage（第二個王關以後才變多）。
  // 單人 / 多人以這一關的玩家人數判斷（1 人 = 單人）
  TREE_BOSS: {
    eyeHp: 300,           // 古樹之眼
    maxMinions: 4,        // 場上最多幾隻樹妖；滿了就改用其他招式（也是樹根前的出生點數）
    summonPerPlayer: 1,   // 一次召喚的樹妖數 = 玩家人數 × 這個（還是不會超過 maxMinions）
    mouthClosedTurnsSolo: 2,   // 單人：嘴巴被打閉上後，要撐過幾個古樹回合才張開（2 = 下一輪也還閉著，等於多一回合冷卻）
    mouthClosedTurnsMulti: 1,  // 多人：只擋下一個古樹回合
    attackOnSummonMulti: true, // 多人：召喚的那一回合，預定的下一招是撞擊 / 落葉的話就接著一起出（閉目養神 / 發呆留到之後）
    // 嘴巴張著（而且樹妖沒滿）時，每回合一定召喚樹妖（最優先，出招當下才判斷）。
    // 古樹的下一招是事先依下面的權重抽好的（開場一次、之後每次用掉就在古樹回合結束時再抽），
    // 撞擊在抽到的當下就選好平面，玩家回合會一直畫出警示帶讓人躲；不召喚的回合就出這一招。
    // 閉目養神只有抽的當下眼睛受過傷才會進抽籤；idle = 發呆（什麼都不做）
    weights: { trunk: 40, leaves: 40, meditate: 10, idle: 0 },
    meditateHeal: 50,    // 閉目養神回復眼睛的血量（跟血量一樣隨人數放大）
  },
  // ---- Boss 關：叢林巨蟒 ----
  // 一條長長的藤蔓橋（平台）+ 三條垂下來的藤蔓（按住 W / S 抓住、上下爬），巨蟒的頭在最右邊、橋的盡頭（那裡沒有橋，會掉進水裡）。
  // 巨蟒的頭整顆都打得到；血量跟一般敵人一樣「每多一位玩家 +50%」，不吃小關的「每過一關 +15%」，改吃 RUN.bossHpPerStage。
  // 每受到最大血量 bloodEveryPct% 的傷害，就掉一瓶蛇血到橋上（落點在 level 的 mechanic.bloodX 範圍內）。
  // 蛇血：自己的回合走過去就喝掉（有被中毒鎖住的上限、或血沒滿才會撿）：先把鎖住的上限全部解開，再回 bloodHeal 血（10/50(100) → 25/100）
  SNAKE_BOSS: {
    hp: 400,              // 巨蟒的血量（使用者沒指定，先抓 400；古樹之眼是 300 但很難打中，巨蟒整顆頭都打得到）
    bloodEveryPct: 20,    // 巨蟒每受到最大血量幾 % 的傷害掉一瓶蛇血
    bloodHeal: 15,        // 喝一瓶蛇血回多少血（先解開生命鎖再回，不超過上限）
    // 巨蟒的下一招是事先抽好的（開場一次、之後每次用掉就在巨蟒回合結束時再抽），
    // 抽到巨蟒衝撞時，玩家回合會一直畫出衝撞範圍的警示帶（爬上藤蔓躲開）；其他招式不預告
    weights: { charge: 45, spray: 25, quake: 10, bite: 20 },
    // 毒液噴灑：從嘴巴往左上方隨機散射 count 顆毒液（拋物線）。同一次噴灑每個人最多中一次（10 層）
    // 角度 92° 起（幾乎直直往上）：靠近巨蟒的那條藤蔓上段也噴得到，不會有完全安全的地方
    spray: { count: 6, minAngle: 92, maxAngle: 165, minSpeed: 320, maxSpeed: 780 },
  },

  // ---- 菁英關：地心探險的獨眼巨人（規則在 shared/maps/cyclops.js）----
  // 站在最右邊的岩柱上（不會被擊退、不會落水），每回合出招前沿著岩柱頂面走一段（walk：速度 speed px/s、離岩柱兩端至少 edge px；
  // null = 不走，規則見 shared/ai/ai-move.js）。血量跟一般敵人一樣依人數、關數放大（菁英關不是 Boss 關，弒神者不算）。
  // 下一招事先抽好（開場一次、之後每次用掉就再抽），玩家回合畫面上會標出來：
  //   pound = 猛捶：捶地震落天花板上「所有」還在的鐘乳石（砸到人照 WEAPONS.stalactite，不會砸到巨人自己），
  //           站最多人的那根岩柱（平台）上的玩家再多吃一次衝擊（WEAPONS.cyclopsShock）。鐘乳石都掉光了，猛捶的權重剩 poundBareFactor 倍
  //   throw = 巨石投擲：朝離巨人最近的玩家丟巨石（WEAPONS.cyclopsBoulder，拋物線），瞄準誤差 aimError（越小越準）
  CYCLOPS: {
    hp: 150,
    weights: { pound: 40, throw: 60 },
    poundBareFactor: 0.5,
    aimError: { angle: 3, power: 6 },
    walk: { speed: 50, edge: 4 },
  },

  // ---- 菁英關：大樹守衛（森林；規則在 shared/maps/guardian.js）----
  // 站在大樹前面的守衛，有重力、會被擊退（地面底下是炸不壞的樹根，坑挖不到水裡）。血量跟一般敵人一樣依人數、關數放大（不是 Boss）。
  // 下一招事先抽好（開場一次、之後每次用掉就再抽，權重 weights），玩家回合畫面上會標出來：
  //   charge = 衝鋒：衝向離他最近的玩家，撞到第一個人就停下（WEAPONS.guardianCharge），衝到樹根 / 地圖邊也停
  //   shield = 舉盾：一抽到就把盾舉起來（面向離他最近的玩家），舉著的時候受到的傷害 -shieldCut%；
  //            輪到他時（這一輪結束）盾牌前方 bashReach px 內的玩家吃盾擊（WEAPONS.guardianBash）
  //   leap   = 躍擊：一抽到就鎖定離他最遠的玩家「當下」站的地方，地上畫警示範圍；輪到他時跳過去刺下來，
  //            落地點兩邊各 leapZone px（再加上判定半徑）內的玩家受傷（WEAPONS.guardianLeap），提早走開就躲得掉
  // 衝鋒、躍擊的傷害看距離（出招當下他離目標 / 落地點多遠）：near px 以內是武器的 damage、far px 以上是 damageFar，中間照比例
  // cast = 每一招的預兆動畫秒數（躍擊含跳在空中的時間）
  GUARDIAN: {
    hp: 200,
    weights: { charge: 40, shield: 30, leap: 30 },
    near: 80,
    far: 560,
    shieldCut: 30,
    bashReach: 60,
    leapZone: 20,
    cast: { charge: 0.8, bash: 0.8, leap: 1.4 },
  },

  // ---- Boss 關：巨蠍巢穴的洞穴巨蠍（規則在 shared/maps/scorpion.js）----
  // 牆上三個洞，巨蠍躲在其中一個（只露出發紅的雙眼，打不到）。三個部位各有自己的血量（hp，再照 Boss 的倍率放大），
  // 打到哪個扣哪個；三個都擊破 = 打倒（沒有另外的本體血量）。
  // 點亮牠那個洞的火把 → 馬上被逼出洞外並暈眩一回合（打得到）；醒來的回合：震擊周圍（WEAPONS.scorpionBurst）+ 還沒擊破的部位各出一招
  // → 鑽地換到別的洞；躲著的回合只從洞裡射毒刺。擊破一個部位 = 之後每回合少動一次、那一招不會再出（2026-10-12 使用者：永久少一次）。
  //   巨鉗 → 巨鉗夾擊：夾 pinchReach px 內離鉗子最近的玩家（WEAPONS.scorpionPinch），範圍裡沒人就撲空
  //   背甲 → 甲殼地鳴：震波沿著地面往兩邊跑到地圖邊（WEAPONS.scorpionQuake），站在岩台上 / 半空中的人不會被打到
  //   毒針 → 毒刺：每位玩家各射一發（WEAPONS.scorpionSting，直線、穿過地形、上毒）
  // cast = 動畫秒數：emerge = 被逼出來時從地底升上來；attack = 每一招（震擊、部位出招、暈眩、躲著射毒刺）的預兆；burrow = 鑽地換洞
  SCORPION: {
    hp: { shell: 150, pincer: 110, stinger: 80 },
    pinchReach: 260,
    cast: { emerge: 0.9, attack: 0.75, burrow: 0.9 },
  },

  // 樹妖：古樹之口召喚出來，每回合慢慢走一段（2026-10-08 起，原本站著不動），投擲長矛
  TREANT: {
    hp: 15,              // 基礎血量（會依人數放大）
    stamina: 100,
    moveSpeed: 30,
    jumpSpeed: 0,
    moveCost: 45,
    jumpCost: 0,
    color: '#ef4444',
    aimError: { angle: 8, power: 10 },  // AI 瞄準誤差（越小越準、越難）
    sniperChance: 0,                   // 有直線視野時改用狙擊槍的機率
    moveChance: 1,                     // 回合開始時走動的機率（走得很慢：一回合最多走 AI_MOVE.maxFrames 幀）
    weapons: ['treeSpear'],
  },

  // 武器。radius = 爆炸 / 挖地半徑（0 = 只打直接命中的角色、不挖地）；noCarve = 照樣爆炸（範圍傷害、擊退）但不挖地形。
  // 有 speedPerPower 的武器用 minSpeed + 力量 × speedPerPower 當初速，沒有的用固定的 speed（例如飛鏢：有一點重力，但跟力量無關）。
  // range = 飛行路徑最長幾 px（超過就消散，例如高壓水炮）；rangeMin + 力量 × rangePerPower = 看力量的最長路徑（迴力鏢：到了就折返）。
  // recoil = 開火時射手被往反方向推的力道（跟被擊退同一套）；shotsPerTurn = 一回合可以分開射幾次（例如飛鏢，見 Referee）
  WEAPONS: {
    cannon: {
      id: 'cannon', name: '大砲',
      damage: 30,          // 直擊傷害（爆炸範圍內依距離遞減）
      radius: 42,           // 爆炸 / 挖地半徑
      gravity: 600,         // 砲彈重力 → 拋物線
      minSpeed: 250,        // 力量 0 時的初速
      speedPerPower: 6.5,   // 每 1 點力量增加的初速（力量 100 → 900 px/s）
      hitRadius: 6,         // 碰到角色的判定半徑
      knockback: 180,       // 擊退力道（直擊時會把敵人撞飛一小段）
      shellRadius: 6,
      color: '#2b2b2b',
      desc: '高傷害，彈道受重力影響',
    },
    sniper: {
      id: 'sniper', name: '狙擊槍',
      damage: 15,
      radius: 10,
      gravity: 0,           // 無重力 → 直線
      speed: 2400,
      hitRadius: 3,
      knockback: 90,
      shellRadius: 2.5,
      color: '#ffe066',
      desc: '指哪射哪，威力較低',
    },
    boomerang: {
      id: 'boomerang', name: '迴力鏢',
      damage: 25,
      radius: 0,            // 不爆炸、不挖地，只打直接命中的角色
      gravity: 400,
      minSpeed: 250,
      speedPerPower: 6.5,
      hitRadius: 7,
      knockback: 40,
      shellRadius: 8,
      boomerang: true,      // 飛到最長路徑（或先撞到地形 / 落水 / 飛出場外）就沿原路飛回角色身上；去程、回程都會打到路上的敵人
      rangeMin: 100,        // 最長路徑 = rangeMin + 力量 × rangePerPower（力量 100 → 600px）
      rangePerPower: 5,
      passAllies: true,     // 穿過隊友（自己也打不到）：只打敵人，同一個敵人去程、回程各打一次
      returnSpeed: 2,       // 回程速度是去程的幾倍
      homingSpeed: 24,      // 原路走完後飛向角色手上的速度（px/幀；空中丟出、角色已經移動時才用得到）
      color: '#f59e0b',
      desc: '飛到最遠處會沿原路飛回身上，去回都會打到路上的敵人',
      hud: '飛到最遠再飛回來',   // 武器按鈕上的短說明（desc 太長放不下）
    },
    plasma: {
      id: 'plasma', name: '等離子飛彈',
      damage: 30,           // 每一發的傷害
      radius: 30,
      gravity: 600,
      minSpeed: 250,
      speedPerPower: 6.5,
      hitRadius: 5,
      knockback: 20,
      shellRadius: 5,
      volley: 3,            // 一次射出幾發（同一條彈道）
      volleyGap: 10,        // 每發之間隔幾幀
      color: '#22d3ee',
      desc: '同一條彈道連射三發',
    },
    darts: {
      id: 'darts', name: '飛鏢',
      damage: 10,
      radius: 0,            // 不爆炸、不挖地，只打直接命中的角色
      gravity: 100,         // 有一點重力（飛遠會稍微往下掉），速度固定、跟力量無關
      speed: 2400,
      hitRadius: 3,
      knockback: 80,
      shotsPerTurn: 3,      // 一回合可以分開射三次（射第一支之後這回合只能用飛鏢；飛行時計時暫停）
      shellRadius: 2.5,
      color: '#ffe066',
      desc: '單次威力較低，但一回合有三次攻擊次數',
      hud: '一回合可以射三次',
    },
    waterCannon: {
      id: 'waterCannon', name: '高壓水炮',
      damage: 40,
      radius: 40,           // 範圍傷害與擊退的半徑（不挖地形，見 noCarve）
      noCarve: true,
      gravity: 0,           // 無重力 → 直線
      speed: 2400,
      range: 300,           // 攻擊距離短：飛 300px 還沒打到東西就消散（沒有傷害）
      hitRadius: 3,
      knockback: 200,
      recoil: 100,          // 開炮的同時自己被往後推（後座力）
      shellRadius: 5,
      color: '#7dd3fc',
      desc: '往前方開出一個高壓水炮，攻擊距離短，但擊退力強',
      hud: '射程短、擊退強',
    },
    // 裝備「無差別轟炸」落下的飛彈：不能被裝備；傷害跟持有者的其他攻擊一樣吃他的加成。不破壞地形（2026-10-08 使用者改）
    bombard: {
      id: 'bombard', name: '轟炸飛彈', fromEquip: true,
      damage: 50,
      radius: 30,
      noCarve: true,
      gravity: 0,
      speed: 1100,          // 垂直落下的速度
      hitRadius: 4,
      knockback: 0,
      shellRadius: 4,
      color: '#f43f5e',
    },

    // ---- 古樹之庭：Boss 與樹妖的攻擊（enemyOnly = 玩家不能裝備）----
    // pierce = 穿過角色繼續飛（每個角色只打一次）；passTerrain = 穿過地形；passAllies = 穿過自己人（打不到古樹與樹妖）
    treeTrunk: {          // 古樹撞擊：從樹幹橫掃預定的平面（預定的當下站最多玩家的那個）
      id: 'treeTrunk', name: '古樹撞擊', enemyOnly: true,
      damage: 30,
      knockback: 60,
      radius: 0,
      gravity: 0,
      speed: 900,           // 樹幹往左掃的速度
      hitRadius: 26,        // 樹幹的粗細（半徑）
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 26,
      color: '#6b4423',
    },
    treeLeaf: {           // 飛散落葉：直線飛向離古樹最近的玩家，穿過地形與角色
      id: 'treeLeaf', name: '飛散落葉', enemyOnly: true,
      damage: 20,
      knockback: 40,
      radius: 0,
      gravity: 0,
      speed: 650,
      hitRadius: 10,
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 10,
      color: '#84cc16',
    },
    treeSpear: {          // 樹妖投擲的長矛：拋物線，只打直接命中的角色、不挖地
      id: 'treeSpear', name: '長矛', enemyOnly: true,
      damage: 15,
      radius: 0,
      gravity: 600,
      minSpeed: 250,
      speedPerPower: 6.5,
      hitRadius: 5,
      knockback: 40,
      passAllies: true,     // 樹妖站成一排，長矛會從同伴身上飛過去
      shellRadius: 4,
      color: '#a16207',
      desc: '樹妖投擲的長矛',
    },

    // ---- 叢林巨蟒的招式（enemyOnly）。poison = 打中的玩家附加幾層中毒 ----
    // knockDir = 固定的擊退方向（不照爆炸點算）；shareHits = 同一招的好幾顆共用「打過誰」，每人最多中一次
    snakeCharge: {        // 巨蟒衝撞：整顆頭沿著藤蔓橋往左衝到底，打中範圍裡（橋上、藤蔓下段）的每位玩家
      id: 'snakeCharge', name: '巨蟒衝撞', enemyOnly: true,
      damage: 30,           // 再吃敵人傷害倍率（第一輪 ×0.7 = 21，第二輪 ×1 = 30）
      poison: 3,
      knockback: 120,       // 我加的：被撞到會往左彈一下（藤蔓上的人會被撞下來）
      radius: 0,
      gravity: 0,
      speed: 1100,
      hitRadius: 118,       // = 巨蟒頭的半高（範圍見 snake-boss.js 的 chargeLane）
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 118,
      color: '#4d7c0f',
    },
    snakeVenom: {         // 毒液噴灑：一顆毒液（拋物線，穿過藤蔓橋，掉進水裡就沒了）
      id: 'snakeVenom', name: '毒液噴灑', enemyOnly: true,
      damage: 0,            // 使用者只指定「10 層中毒」
      poison: 10,
      knockback: 0,
      radius: 0,
      gravity: 460,
      speed: 600,
      hitRadius: 8,
      passTerrain: true, passAllies: true, shareHits: true,
      shellRadius: 7,
      color: '#a855f7',
    },
    snakeQuake: {         // 大地震擊：震波沿著藤蔓橋表面往左跑，只打站在橋上的玩家（藤蔓上、半空中的不會被打到）
      id: 'snakeQuake', name: '大地震擊', enemyOnly: true,
      damage: 50,
      knockback: 500,
      knockDir: { x: 1, y: 0 },   // 往巨蟒的方向（右邊）擊退：離巨蟒近的人會被甩下橋
      radius: 0,
      gravity: 0,
      speed: 1500,
      hitRadius: 6,
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 6,
      color: '#a16207',
    },
    snakeBite: {          // 劇毒撕咬：頭直接咬向離嘴巴最近的玩家
      id: 'snakeBite', name: '劇毒撕咬', enemyOnly: true,
      damage: 15,
      poison: 10,
      knockback: 80,        // 我加的：被咬到會被甩開一點（藤蔓上的人會被咬下來）
      radius: 0,
      gravity: 0,
      speed: 1300,
      hitRadius: 14,
      passTerrain: true, passAllies: true,
      shellRadius: 14,
      color: '#7f1d1d',
    },

    // ---- 小心擊發：蜜蜂的衝刺螫擊（enemyOnly）。飛行物就是蜜蜂本身，直線衝向目標、穿過地形 ----
    beeSting: {
      id: 'beeSting', name: '衝刺螫擊', enemyOnly: true,
      damage: 15,           // 再吃敵人傷害倍率（第 1 ~ 5 關 ×0.7 = 11，第 6 關起 ×1 = 15）
      poison: 10,
      knockback: 40,        // 使用者沒指定，給一點點（被螫到會晃一下）
      radius: 0,
      gravity: 0,
      speed: 1000,
      hitRadius: 8,
      passTerrain: true, passAllies: true,
      shellRadius: 9,
      color: '#facc15',
    },

    // ---- 岩穴：蝙蝠的聲波（enemyOnly）。打法跟狙擊槍一樣（直線、會被地形擋住、炸一個小坑），擊退比較大 ----
    sonic: {
      id: 'sonic', name: '聲波', enemyOnly: true,
      damage: 15,           // 使用者只指定「類似狙擊槍」，傷害照狙擊槍（再吃敵人傷害倍率與狂熱）
      radius: 10,
      gravity: 0,
      speed: 1600,          // 比狙擊槍慢一點，看得到聲波飛過去
      hitRadius: 4,
      knockback: 120,
      shellRadius: 7,
      color: '#c4b5fd',
    },
    // ---- 洞穴：掉下來的鐘乳石（hazard = 地形掉下來的，不能裝備）。從尖端開始自由落下，砸到第一個角色或落地就碎掉 ----
    // 算打下它的人的攻擊：傷害吃他的加成與狂熱，砸到自己人一樣 ×FRIENDLY_FIRE
    stalactite: {
      id: 'stalactite', name: '鐘乳石', hazard: true,
      damage: 30,
      radius: 0,            // 不爆炸、不挖地，只砸到正下方的那個人
      gravity: 900,
      speed: 0,
      hitRadius: 14,        // 鐘乳石的粗細
      knockback: 60,
      shellRadius: 14,
      color: '#78716c',
    },

    // ---- 地心探險：獨眼巨人的招式（enemyOnly）----
    cyclopsShock: {       // 猛捶的衝擊：沿著站最多人的那根岩柱的頂面跑（他自己那根從腳下往兩邊），只打站在那根上的玩家
      id: 'cyclopsShock', name: '猛捶衝擊', enemyOnly: true,
      damage: 25,           // 使用者只說「多受一次衝擊攻擊」，傷害我先抓 25（再吃敵人傷害倍率：第 1 ~ 5 關 ×0.7 ≈ 18）
      knockback: 150,       // 往外推（離巨人越遠的方向），站在岩柱邊上的人可能被推下水
      radius: 0,
      gravity: 0,
      speed: 1400,
      hitRadius: 8,
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 8,
      color: '#a8a29e',
    },
    cyclopsBoulder: {     // 巨石投擲：拋物線，只打直接砸到的人、不挖地；砸不到巨人自己（passOwner）
      id: 'cyclopsBoulder', name: '巨石投擲', enemyOnly: true, passOwner: true,
      damage: 40,           // 使用者定的（再吃敵人傷害倍率：第 1 ~ 5 關 ×0.7 = 28）
      radius: 0,
      gravity: 600,
      minSpeed: 250,
      speedPerPower: 6.5,
      hitRadius: 12,        // 巨石比砲彈大
      knockback: 120,
      passAllies: true,
      shellRadius: 13,
      color: '#78716c',
    },

    // ---- 大樹守衛的招式（enemyOnly；規則見 shared/maps/guardian.js）。damage → damageFar = 離得越遠傷害越高（GUARDIAN.near ~ far），再吃敵人傷害倍率 ----
    guardianCharge: {     // 衝鋒：飛行物就是守衛自己，貼著地面直直衝過去，撞到第一個玩家就停（樹根、地圖邊也擋得住他）
      id: 'guardianCharge', name: '衝鋒', enemyOnly: true, passOwner: true,
      damage: 30,           // 使用者定的：離得越遠越痛 30 → 50、擊退 120
      damageFar: 50,
      knockback: 120,
      radius: 0,
      gravity: 0,
      speed: 760,
      hitRadius: 18,        // = 守衛的半寬（身體碰到身體就撞上）
      passTerrain: true, passAllies: true,
      shellRadius: 18,
      color: '#7c5a3a',
    },
    guardianBash: {       // 盾擊：從盾牌往前推一小段（GUARDIAN.bashReach），打盾牌前方的每個玩家
      id: 'guardianBash', name: '盾擊', enemyOnly: true,
      damage: 45,           // 使用者定的
      knockback: 200,       // 使用者沒給，我先抓 200（往盾牌前方推）
      radius: 0,
      gravity: 0,
      speed: 900,
      hitRadius: 16,
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 12,
      color: '#a16207',
    },
    guardianLeap: {       // 躍擊：落地那一下往兩邊震開（GUARDIAN.leapZone），打警示範圍裡的每個玩家
      id: 'guardianLeap', name: '躍擊', enemyOnly: true,
      damage: 50,           // 使用者定的：離得越遠越痛 50 → 70
      damageFar: 70,
      knockback: 160,       // 使用者沒給，我先抓 160（往落地點外面推）
      radius: 0,
      gravity: 0,
      speed: 900,
      hitRadius: 20,
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 12,
      color: '#65a30d',
    },

    // ---- 巨蠍巢穴：洞穴巨蠍的招式（enemyOnly；規則見 shared/maps/scorpion.js）。數字都是我先抓的（使用者沒指定），再吃敵人傷害倍率 ----
    scorpionBurst: {      // 震擊周圍（暈眩醒來）：從洞口中間往兩邊衝到洞口邊，打站在那個洞口前面地上的人（往外推）
      id: 'scorpionBurst', name: '震擊周圍', enemyOnly: true,
      damage: 20,
      knockback: 220,
      radius: 0,
      gravity: 0,
      speed: 900,
      hitRadius: 22,        // 地面上方一個人高（站在岩台上、半空中的打不到）
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 22,
      color: '#a16207',
    },
    scorpionPinch: {      // 巨鉗夾擊：鉗子直直夾向範圍內最近的玩家，甩得很遠
      id: 'scorpionPinch', name: '巨鉗夾擊', enemyOnly: true,
      damage: 24,
      knockback: 320,
      radius: 0,
      gravity: 0,
      speed: 1200,
      hitRadius: 14,
      passTerrain: true, passAllies: true,
      shellRadius: 14,
      color: '#7f1d1d',
    },
    scorpionQuake: {      // 甲殼地鳴：震波貼著地面往兩邊跑，只打腳踩在地上的人
      id: 'scorpionQuake', name: '甲殼地鳴', enemyOnly: true,
      damage: 18,
      knockback: 160,
      radius: 0,
      gravity: 0,
      speed: 1500,
      hitRadius: 6,
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 6,
      color: '#a8a29e',
    },
    scorpionSting: {      // 毒刺：每位玩家各一發，直線、穿過地形、上毒（中毒規則見 POISON，這張圖沒有蛇血）
      id: 'scorpionSting', name: '毒刺', enemyOnly: true,
      damage: 12,
      poison: 2,            // 這張圖沒有蛇血、毒解不掉（POISON.persist）：每回合都會疊，先給少一點
      knockback: 60,
      radius: 0,
      gravity: 0,
      speed: 1400,
      hitRadius: 8,
      passTerrain: true, passAllies: true,
      shellRadius: 6,
      color: '#84cc16',
    },
  },

  // ---- 武器欄與裝備效果 ----
  EQUIP: {
    maxWeapons: 3,                        // 一個角色最多裝備幾把武器（滿了還拿武器牌就要丟一把）
    startWeapons: ['cannon', 'sniper'],   // 冒險開始時的武器
    burn: {                               // 「燃燒」狀態
      pctPerStack: 0.1,                   // 自己的回合結束時，每層扣最大血量的 N%
      pxPerStack: 10,                     // 自己的回合每移動 N px 甩掉一層
      maxReducePerTurn: 10,               // 每回合最多甩掉幾層
    },
    shieldEveryTurns: 3,                  // 神佑之石：持有者每過 N 個回合，全隊無敵一次
    extraTurnCooldown: 3,                 // 時間扭曲：拿到額外回合後，要再過 N 個（普通）回合才會再給
    // 攜手之伴：被「連結」的人受到的傷害先 -damageCutPct%，再跟活著的連結對象平分（落水不算）。
    // 一個人可以被好幾位隊友連結，被打時跟所有活著的連結對象平分
    link: { damageCutPct: 30 },
    bombard: {                            // 無差別轟炸
      spacing: 64,                        // 飛彈之間的水平間距
      jitter: 8,                          // 落點隨機偏移
      safeDist: 60,                       // 持有者左右這個距離內不落彈（也炸不到他）
      startY: -40,                        // 從畫面上方多高落下
      gapFrames: 3,                       // 由近到遠，每發間隔幾幀
      cooldown: 3,                        // 轟炸之後要再過 N 個自己的回合（含額外回合）才會再轟炸（0 = 每回合都炸）
    },
  },

  // 滑鼠拖曳瞄準：方向 = 角度、距離 = 力量
  AIM: { minDist: 30, maxDist: 280, minPower: 10, maxPower: 100 },

  // 大砲彈道預覽：只給前 4 個點當方向提示，完整彈道要靠自己抓（狙擊槍才有優勢）
  PREVIEW: { dots: 4, framesPerDot: 3 },

  // 流程節奏（秒）。伺服器用它算「下一回合幾秒後開始」，客戶端用它播動畫，兩邊一致
  TIMING: {
    startDelay: 1.5,      // start → 第一回合
    aiThink: 0.7,         // AI 回合開始先停一下
    aiAim: 0.9,           // AI 砲管轉向目標的動畫時間
    bossCast: 1.1,        // 古樹出招前的預兆動畫（撞擊範圍快閃、張嘴、閉眼…）；撞擊的範圍在玩家回合就已經一直標著
    settleDelay: 0.8,     // 砲彈落地、所有人站穩後再等一下
    afterShotPad: 1.2,    // 一發打完到下一回合的緩衝
    againPad: 0.6,        // 一回合射好幾次的武器（飛鏢）：一支結算完到可以再射下一支的緩衝（客戶端播完結果的停頓是 0.4 秒）
    skipDelay: 1.0,       // 時間到 → 下一回合
    fxDelay: 0.9,         // 回合結束的效果（燃燒扣血、神佑之石）播完 → 下一回合
    moveSendHz: 10,       // 行動玩家回報位置的頻率
    maxShotSeconds: 8,    // 砲彈最長飛行時間（超過視為飛出去）
  },

  // 紀錄（LOG）：建房、加入、準備、開始、每一個動作（移動、換武器、開火、選牌…）與結果，寫在伺服器的 dir 資料夾，
  // 一天一個檔（game-YYYY-MM-DD.log，每行一筆 JSON），玩家看不到。單人練習也會送回伺服器記（room 是 SOLO-xxxx）。
  // enabled = 總開關；moves = 移動回報也逐筆記（每人每秒最多 moveSendHz 筆，量最大，嫌多可以關掉）。改完重啟伺服器
  LOG: { enabled: true, dir: 'logs', moves: true },
};
