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
  // 風向（共用機制，見 shared/physics/wind.js）：關卡寫 wind 才有。每個回合重抽 -max ~ +max 級（負的往左），
  // 每一級給吃風的飛行物 accel px/s² 的水平加速度（大砲飛 2 秒、10 級風大約偏 180 px）。數值我抓的（2026-10-20）
  WIND: { max: 10, accel: 9 },
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
  // 難度：開房 / 單人練習時選，一整場冒險都一樣（換算成那一場的設定見 shared/game/stage-rules.js 的 difficultyConfig）。
  // normal 照上面 RUN、下面 ENEMY 的數字；其他難度蓋掉其中幾項：
  //   eliteStages = 哪幾關是菁英關（取代 RUN.eliteStages；跟 Boss 關重疊的一樣算 Boss 關）
  //   enemyDamage = 敵人傷害倍率整場都是這個數（取代 ENEMY.damageMult 前幾關的打折，含菁英怪與 Boss）
  //   rangeHints  = false：菁英怪招式的提示範圍不畫（大樹守衛躍擊的警示光柱、衝鋒的路線與目標準星；只是畫面，見 showsRangeHints）
  // 菁英之路（2026-10-19 使用者定的）：菁英關改成第 2、3、4、7、8、9 關（只剩第 1、6 關是小關），敵人傷害整場不打折，
  // 躍擊、衝鋒不顯示提示範圍
  DIFFICULTY: {
    normal: { name: '一般' },
    elite: { name: '菁英之路', eliteStages: [2, 3, 4, 7, 8, 9], enemyDamage: 1, rangeHints: false },
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

  // 「流血」狀態（命中時附加層數的攻擊，武器的 bleed）：帶著流血「自己移動」時——走路的水平距離（含跳在空中按方向）、爬藤蔓的上下距離、
  // 蝙蝠 / 獨眼巨人飄 / 走的直線距離——每移動 1px、每層扣最大血量 pctPerPx%（照現在的上限算；5 層、150 血走 100px = 7.5 血，不足 1 點的先存著）。
  // 被擊退、跳起來 / 掉下去的上下、落水重生都不算。不吃減傷、狂熱、無敵（無敵擋的是上流血的那一下），會扣到倒下。
  // 被打中幾次就疊幾次（沒有上限），自己的回合結束時整個止血（層數歸零）
  BLEED: { pctPerPx: 0.01 },

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
  // 直擊或爆炸波及都算一次；等離子兩發都打到 = 兩次。敵人自己的子彈會穿過蜂巢與蜜蜂，不算
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
  // 招式（2026-10-19 使用者改版：加上超巨石、震盪獅吼）。下一招事先排好（開場一次、之後每次用掉就再排），玩家回合畫面上會標出來。
  // 每回合一個一般招式（猛捶 / 巨石投擲，照權重 weights 抽）：
  //   pound = 猛捶：捶地震落天花板上「所有」還在的鐘乳石（砸到人照 WEAPONS.stalactite，不會砸到巨人自己），
  //           站最多人的那個平台上的玩家再多吃一次衝擊（WEAPONS.cyclopsShock）。被超巨石封住的、這回合要被封住的平台不算，
  //           剩下的只有他自己那根就不放猛捶（2026-10-19 使用者）。鐘乳石都掉光了，猛捶的權重剩 poundBareFactor 倍
  //   throw = 巨石投擲：朝每一個活著的玩家各丟一顆巨石（WEAPONS.cyclopsBoulder，拋物線），一定砸中
  //           （瞄準沒有誤差、不用亂數），離他近的先丟，一顆接一顆每隔 throwGap 幀（1/60 秒）
  // 另外每 sealEvery 回合（他自己的回合）輪一次：
  //   seal  = 超巨石：一般招式之後「另外」再丟（不佔他這回合的招式），由左往右封住一個平台
  //           （左高台 → 中岩柱）：巨石從頂面一路頂到天花板，還站在那個平台上的玩家直接死亡
  //   roar  = 震盪獅吼：前面的平台都封住、大家都擠到他的岩柱上之後，下一次輪到超巨石時改放這招（佔掉那回合的一般招式）：
  //           擊碎所有超巨石（平台又通了），沒有傷害，把每個玩家往外震退（WEAPONS.cyclopsRoar）。之後從封左高台重新輪
  // sealCast = 超巨石的動畫秒數（舉起來、飛過去砸下），roarCast = 震盪獅吼的預兆秒數（吸氣）
  CYCLOPS: {
    hp: 150,
    weights: { pound: 40, throw: 60 },
    poundBareFactor: 0.5,
    throwGap: 6,
    sealEvery: 2,
    sealCast: 2.1,
    roarCast: 1.3,
    walk: { speed: 50, edge: 4 },
  },

  // ---- 菁英關：大樹守衛（森林；規則在 shared/maps/guardian.js）----
  // 從地圖最右邊出場的守衛（後面的大樹只是背景），有重力、會被擊退（整片地面炸不壞，不會有坑）。血量跟一般敵人一樣依人數、關數放大（不是 Boss）。
  // 下一招事先抽好（開場一次、之後每次用掉就再抽，權重 weights），玩家回合畫面上會標出來：
  //   charge = 衝鋒：一抽到就標記離他最遠的玩家（同時人立起來，整個玩家回合都維持著）；輪到他時衝向被標記的人（那人倒下了就改衝當下最遠的），
  //            路上的玩家一起撞開（每人一次），撞到被標記的人就停下（WEAPONS.guardianCharge），衝到坑壁 / 地圖邊也停
  //   shield = 舉盾：一抽到就把盾舉起來（面向離他最近的玩家），舉著的時候受到的傷害 -shieldCut%；
  //            輪到他時（這一輪結束）盾牌前方 bashReach px 內的玩家吃盾擊（WEAPONS.guardianBash）
  //   leap   = 躍擊：一抽到就隨機鎖定一個玩家「當下」站的地方（同時蹲下去，整個玩家回合都蹲著），地上畫警示範圍；輪到他時跳過去刺下來，
  //            落地點兩邊各 leapZone px（再加上判定半徑）內的玩家受傷（WEAPONS.guardianLeap），提早走開就躲得掉；
  //            落地後接著橫劈：往身體兩邊各掃 slashReach px（再加上判定半徑），掃到的玩家受傷並流血（WEAPONS.guardianSlash）
  // 躍擊的傷害看距離（出招當下他離落地點多遠）：near px 以內是武器的 damage、far px 以上是 damageFar，中間照比例（衝鋒、橫劈固定）
  // cast = 每一招的預兆動畫秒數（衝鋒：一抽到就已經人立著，這裡是踏地、刨地；躍擊：一抽到就已經蹲著，這裡是發抖蓄力與跳在空中的時間；橫劈是落地之後再揮的那一下）
  GUARDIAN: {
    hp: 200,
    weights: { charge: 40, shield: 30, leap: 30 },
    near: 80,
    far: 560,
    shieldCut: 30,
    bashReach: 60,
    leapZone: 20,
    slashReach: 70,       // 使用者說「附近」，我先抓 70
    // 2026-10-19 使用者：決定衝鋒時就人立起來（輪到他時踏地衝出去）、決定躍擊時就蹲著等（輪到他時發抖蓄力起跳）（原本 charge 0.8、leap 1.4）
    cast: { charge: 1.0, bash: 0.8, leap: 1.35, slash: 0.5 },
  },

  // ---- 菁英關：流浪劍士（黃昏的荒原；規則在 shared/maps/swordsman.js）----
  // 站在地面最右邊（不受重力、不會被擊退），每回合出招前沿著地面走一段（walk，同獨眼巨人；活動範圍是右下平台的右邊）。
  // 血量跟一般敵人一樣依人數、關數放大（菁英關不是 Boss 關）。下一招事先抽好（開場一次、之後每回合出完招再抽，權重 weights），HUD 會標出來：
  //   iai   = 一閃（2026-10-20 使用者第二次改版）：一抽到就擺出拔刀的架勢、站著不走，對每一位玩家各劃一道預警線（從刀口直直指向那個人、
  //           一路延伸到地圖邊 / 地面，斜的也可以；一般難度畫、菁英之路不畫）；輪到他時沿著這幾道線一起斬下去（WEAPONS.swordsmanIai），
  //           身體碰到線的玩家都會被打（每人最多一刀）；玩家在自己的回合離開那條線就躲得掉
  //   parry = 格擋架勢：擺出來之後維持到他下一回合開始，受到的傷害 -parryCut%；這段時間被玩家打中 ceil(玩家人數 × parryPerPlayer) 次
  //           → 他下一回合一開始先放一次一閃反擊（只對第一個打中他的玩家現在的位置、沒有預警、馬上斬；2026-10-20 使用者），再出預定的那一招
  //   draw  = 拔刀：原地拔刀，一道刀氣直線飛向一位玩家（站在平台上的優先、其中最近的；WEAPONS.swordsmanDraw），打第一個碰到的人、擊退得很遠
  //           （2026-10-20 使用者：暫時移除後又恢復，權重比一閃低）
  // 劍氣（不是他的招式，一直都有）：開場就揮出 qiCount 道半月形的劍氣（地面 / 低台 / 中台 / 頂台四排裡隨機挑幾排、隨機順序），浮在地圖右邊那一排的高度；
  //   每一位玩家的回合開始時，最前面那一道出發，在那個回合裡以 qiSpeed px/s 慢慢往左飛過整排（WEAPONS.swordsmanQi），碰到那一排的玩家就打，
  //   看到它飛過來就躲得掉（離開那一排、跳過去）；回合提早結束的話，剩下的一段在回合收尾時一口氣掃完。浮著的都飛完了就馬上再揮一輪
  // cast = 每一招的預兆動畫秒數（counter = 反擊的一閃，比較快）
  SWORDSMAN: {
    hp: 200,              // 使用者沒給，我先抓跟大樹守衛一樣
    weights: { iai: 50, parry: 25, draw: 25 },   // 2026-10-20 使用者：拔刀恢復、一閃比較重（數字我抓的；原本 45 / 30 / 25）
    qiCount: 3,
    qiSpeed: 200,         // 使用者定的（2026-10-19，原本我抓 140）：從右邊飛到左邊大約 5 秒（玩家走路 130 px/s）
    parryCut: 50,
    parryPerPlayer: 0.5,
    walk: { speed: 60, edge: 4 },
    cast: { iai: 1.1, counter: 0.5, parry: 0.6, draw: 0.8 },
  },

  // ---- 菁英關：天狗（山頂；規則在 shared/maps/tengu.js）。關卡有風（共用的風向，見 WIND）----
  // 一直飛在空中（不受重力、不會被擊退），每回合出招前在天上飄一段（活動範圍 = 關卡的 roam）。血量跟一般敵人一樣依人數、關數放大。
  // 下一招事先抽好（開場一次、之後每回合出完招再抽，weights；HUD 標出來）：
  //   feather = 羽刃：飛到畫面正中間的上方（center），把身邊浮著的羽毛補滿到 feathers 根（開場就先撒好一輪）
  //   gust    = 風彈：對隨機一位玩家射一顆比大砲大一點的砲彈（WEAPONS.tenguGust；會算風來瞄，有一點誤差 aimError 度）
  // 羽毛（不是他的招式，一直都有）：每一位玩家的回合開始時，浮著的羽毛射出 perTurn 根，各自射向地圖上隨機的一點（全場亂射），
  //   一根接一根（featherGap 秒）在這個回合裡以 featherSpeed px/s 直線飛，碰到第一個玩家就打（WEAPONS.tenguFeather）、碰到地形就插在地上
  // cast = 每一招的預兆動畫秒數
  TENGU: {
    hp: 200,              // 使用者沒給，跟其他菁英一樣
    weights: { feather: 50, gust: 50 },   // 使用者定的（2026-10-20）：隨機各半
    feathers: 16,         // 使用者定的：羽刃總共 16 根
    perTurn: 4,           // 使用者定的：每個玩家回合射 4 根
    featherSpeed: 280,    // 我抓的：從天上飛到地面大約 2 秒
    featherGap: 0.3,      // 我抓的
    center: { x: 512, y: 200 },   // 羽刃飛到的地方（腳底；畫面正中間的上方，浮著的羽毛在武器 / 風向列底下）
    aimError: 2.5,        // 我抓的（角度 ± 度）
    aimPowerError: 2,     // 我抓的（力量 ±）
    gustPerExtraPlayer: 0.5,   // 使用者定的（2026-10-21）：風彈傷害照開場人數放大，每多一人 +50%（1 ~ 4 人：20 / 30 / 40 / 50）
    cast: { feather: 1.4, gust: 1.0 },
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

  // ---- Boss 關：處刑監獄的處刑官（規則在 shared/maps/prison.js）----
  // 2026-10-19 使用者定的：hp 400 → 300（同日看了模擬的通關率選方案 A：血量 300 / 90 / 120 / 150、招式傷害打 6 折、流血 10 → 5 層）；
  // 菜刀丟擲 20 + 10 層流血（→ 12 + 5 層）、訓獸者皮鞭（打自己的召喚獸 20、牠的攻擊 +30%，不疊加、打不死）、
  // 處刑者囚籠（場上最多一個、血量 40 × 人數、3 回合後還關著就斷頭台處刑（原本 2）；被關的人開火一定打在籠子上）；血量到 80 / 60 / 40% 跳上處刑台（打不到）、依序打開三間牢房；
  // 召喚獸全倒 → 坐在地上哭兩回合（不行動、受到的傷害加成）→ 暴怒拿出流星錘（50、擊退 200）。
  // 我補的（使用者沒給）：權重、哭的時候受傷 ×1.5、暴怒後的招式（流星錘 / 菜刀 / 囚籠）、各招的預兆秒數
  EXECUTIONER: {
    hp: 300,
    hw: 34,
    h: 96,
    phases: [80, 60, 40],   // 血量剩幾 % 時跳上處刑台、打開下一間牢房（照順序：惡狼、棕熊、劍齒虎）
    whipDamage: 20,
    whipPct: 30,            // 被鞭過的召喚獸下一次攻擊的傷害 +30%（用掉就沒了）
    cageHpPerPlayer: 40,    // 囚籠的血量 = 這個 × 玩家人數（2026-10-19 使用者：原本 80 照人數放大，2 回合內打不破，改成 40 × 人數）
    cageRounds: 3,          // 關進去之後撐過幾輪還沒出來就處刑（2026-10-19 使用者從 2 改 3）
    cryTurns: 2,            // 召喚獸全倒之後哭幾個自己的回合
    cryDamagePct: 50,       // 哭的時候受到的傷害 +50%
    weights: { cleaver: 40, whip: 30, cage: 30 },
    rageWeights: { flail: 50, cleaver: 30, cage: 20 },
    cast: { release: 1.5, descend: 0.9, cleaver: 0.8, whip: 0.9, cage: 1.0, execute: 2.4, cry: 1.4, rage: 1.4, flail: 0.9, stunned: 0.8 },
  },
  // 處刑官的三隻猛獸（牢房 I / II / III）：血量照一般敵人的倍率放大。2026-10-19 使用者採用我建議的招式
  WOLF: { hp: 90, hw: 22, h: 40, cast: 0.8 },                          // 撕咬（使用者定的）：衝向一名玩家（有流血的優先）。血量 150 → 90（方案 A）
  BEAR: {                                                              // 熊掌拍擊（最近的人）/ 護主（擋在囚籠前面、受到的傷害 -30%）
    hp: 120, hw: 32, h: 54, guardCut: 30,   // 血量 200 → 120（方案 A）
    weights: { swipe: 65, guard: 35 }, cageWeights: { swipe: 45, guard: 55 },
    cast: 0.9,
  },
  TIGER: { hp: 150, hw: 30, h: 42, bleedBonus: 2, cast: 0.8 },         // 血量 250 → 150（方案 A）。標記血最少的人 → 飛撲（路上第一個人先被撲到）、吃掉流血層數每層 +2

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
      volley: 2,            // 一次射出幾發（同一條彈道；2026-10-14 使用者從三發改成兩發）
      volleyGap: 10,        // 每發之間隔幾幀
      color: '#22d3ee',
      desc: '同一條彈道連射兩發',
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
    rapier: {            // 2026-10-14 使用者給的：傷害 30、命中的敵人 10 層流血；射程、擊退、穿過隊友是我補的
      id: 'rapier', name: '西洋刺劍',
      damage: 30,
      bleed: 10,            // 命中的敵人附加幾層流血（流血規則見 BLEED）
      radius: 0,            // 不爆炸、不挖地，只刺直接碰到的角色
      gravity: 0,           // 無重力 → 直線
      speed: 2400,
      range: 160,           // 攻擊距離很短：刺出 160px 還沒碰到東西就收回（沒有傷害）
      hitRadius: 6,
      knockback: 60,
      passAllies: true,     // 穿過隊友（自己也刺不到）：只刺得到敵人
      shellRadius: 3,
      color: '#e5e7eb',
      desc: '往前方刺出一劍，攻擊距離短，命中的敵人會流血',
      hud: '近身刺擊、流血',
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
    // pierce = 穿過角色繼續飛（每個角色只打一次）；passTerrain = 穿過地形；passAllies = 穿過自己人（打不到古樹與樹妖）。
    // bodyHit = 飛行物就是出招者自己的身體（巨蟒衝撞、蜜蜂螫擊、大樹守衛衝鋒）：結算時出招的角色還在出發點，
    // 看距離的效果（威嚇）改量撞上那一下的位置（見 Match.applyExplosion 的 at）
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
      id: 'snakeCharge', name: '巨蟒衝撞', enemyOnly: true, bodyHit: true,
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
      id: 'beeSting', name: '衝刺螫擊', enemyOnly: true, bodyHit: true,
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
    cyclopsShock: {       // 猛捶的衝擊：沿著站最多人的那個平台的頂面跑（他自己那根從腳下往兩邊），只打站在那上面的玩家
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
    cyclopsRoar: {        // 震盪獅吼：每個玩家各一道震波，從巨人身體中心的 x、那個玩家身體中心的高度出發，水平衝向他（穿過地形、只撞得到他，
      id: 'cyclopsRoar', name: '震盪獅吼', enemyOnly: true,   // 見 shared/maps/cyclops.js 的 roarStep）：打在靠巨人那一側，水平往外推
      damage: 0,            // 使用者定的（2026-10-19）：沒有傷害
      knockback: 400,       // 使用者定的（2026-10-19）。水平 400、往上彈 140（Entity.knockBack），站在岩柱邊上的人會被震下水
      radius: 0,
      gravity: 0,
      speed: 1500,
      hitRadius: 6,
      passTerrain: true, passAllies: true,
      shellRadius: 0,
      color: '#fde68a',
    },
    cyclopsBoulder: {     // 巨石投擲：拋物線，每顆只砸它瞄的那個人（一定砸中，見 shared/maps/cyclops.js 的 aimBoulder）、不挖地；砸不到巨人自己（passOwner）
      id: 'cyclopsBoulder', name: '巨石投擲', enemyOnly: true, passOwner: true,
      windFactor: 0,        // 不吃風（共用的風向機制）：軌跡是先解好、一定砸中的，被風吹偏就不準了
      damage: 30,           // 使用者定的（2026-10-19 從 40 下調；再吃敵人傷害倍率：第 1 ~ 5 關 ×0.7 = 21）
      bleed: 5,             // 使用者定的（2026-10-14）：砸中的人流血 5 層
      radius: 0,            // 0 = 不挖地（一波裡後面的巨石照算好的軌跡飛，地形不能被前面的改掉）
      gravity: 600,
      minSpeed: 250,
      speedPerPower: 6.5,
      hitRadius: 12,        // 巨石比砲彈大
      knockback: 120,
      passAllies: true,
      shellRadius: 13,
      color: '#78716c',
    },

    // ---- 大樹守衛的招式（enemyOnly；規則見 shared/maps/guardian.js）。都再吃敵人傷害倍率；
    //      躍擊的 damage → damageFar = 離得越遠傷害越高（GUARDIAN.near ~ far） ----
    guardianCharge: {     // 衝鋒：飛行物就是守衛自己，貼著地面直直衝過去，路上的玩家一起撞開（穿透），撞到被標記的人就停（坑壁、地圖邊也擋得住他）
      id: 'guardianCharge', name: '衝鋒', enemyOnly: true, passOwner: true, bodyHit: true,
      damage: 40,           // 使用者定的（2026-10-14 改成固定 40，不看距離）；擊退 120（每個被撞到的人都一樣）
      knockback: 120,
      radius: 0,
      gravity: 0,
      speed: 760,
      hitRadius: 18,        // = 守衛的半寬（身體碰到身體就撞上）
      pierce: true, passTerrain: true, passAllies: true,
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
    guardianSlash: {      // 橫劈（躍擊落地之後）：從身體中間往兩邊各掃 GUARDIAN.slashReach，兩邊共用「打過誰」（每人最多挨一次）
      id: 'guardianSlash', name: '橫劈', enemyOnly: true,
      damage: 30,           // 使用者定的：30、5 層流血
      bleed: 5,
      knockback: 80,        // 使用者沒給，我先抓 80（往身體外面推）
      radius: 0,
      gravity: 0,
      speed: 900,
      hitRadius: 20,
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 14,
      color: '#d6d3d1',
    },

    // ---- 流浪劍士的招式（enemyOnly；規則見 shared/maps/swordsman.js）。都再吃敵人傷害倍率 ----
    swordsmanIai: {       // 一閃：沿著預警線（從刀口指向每一位玩家、延伸到地圖邊）一起斬下去，身體碰到線的玩家都會被打（幾道加起來每人最多一刀）
      id: 'swordsmanIai', name: '一閃', enemyOnly: true,   // 刀光沿線飛到地圖邊的速度
      damage: 50,           // 使用者定的
      knockback: 0,         // 使用者沒給擊退（拔刀才有）
      radius: 0,
      gravity: 0,
      speed: 2400,
      hitRadius: 14,        // 刀光的半寬：身體離那條線 14 px 以內就會被打到
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 10,
      color: '#e0f2fe',
    },
    swordsmanQi: {        // 劍氣：半月形的劍氣從地圖右邊往左直線飛過整排（那一排的頂面往上一個人高），穿過那一排的每個玩家（每人一次）。
      id: 'swordsmanQi', name: '劍氣', enemyOnly: true,   // 玩家回合中慢慢飛（SWORDSMAN.qiSpeed）；這裡的 speed 是回合收尾時一口氣掃完剩下那段的速度
      damage: 40,           // 使用者定的
      knockback: 0,         // 不擊退：回合中被打到時玩家正在自己操作（伺服器不跑他的物理），推他會跟他的畫面對不起來
      radius: 0,
      gravity: 0,
      speed: 1000,
      hitRadius: 18,
      pierce: true, passTerrain: true, passAllies: true,
      shellRadius: 10,
      color: '#7dd3fc',
    },
    swordsmanDraw: {      // 拔刀：一道刀氣從劍士身上直線飛向目標，打第一個碰到的人（不穿透）
      id: 'swordsmanDraw', name: '拔刀', enemyOnly: true,
      damage: 20,           // 使用者定的
      knockback: 200,       // 使用者定的（往刀氣飛的方向推，站在平台上的常常被打下去）
      radius: 0,
      gravity: 0,
      speed: 1500,
      hitRadius: 10,
      passTerrain: true, passAllies: true,
      shellRadius: 10,
      color: '#e0f2fe',
    },

    // ---- 天狗的招式（enemyOnly；規則見 shared/maps/tengu.js）。都再吃敵人傷害倍率 ----
    tenguFeather: {       // 羽毛：直線飛（不吃風），碰到第一個玩家就停（一根打一個人）、碰到地形就插在地上
      id: 'tenguFeather', name: '羽刃', enemyOnly: true,   // 玩家回合中慢慢飛（TENGU.featherSpeed）；這裡的 speed 是回合收尾時一口氣射完剩下那幾根的速度
      damage: 15,           // 使用者定的
      knockback: 0,         // 不擊退：回合中被打到時玩家正在自己操作（伺服器不跑他的物理）
      radius: 0,
      gravity: 0,
      speed: 900,
      hitRadius: 8,
      passAllies: true,
      shellRadius: 6,
      color: '#1f2937',
    },
    tenguGust: {          // 風彈：拋物線（吃風），爆炸半徑比大砲（42）大一點
      id: 'tenguGust', name: '風彈', enemyOnly: true,
      damage: 20,           // 使用者定的（2026-10-20 從 40 下調：單人打不過）；這是 1 人的，多人照 TENGU.gustPerExtraPlayer 放大（見 tengu.js 的 gustDamage）
      radius: 50,           // 使用者：比大砲半徑還大一點
      knockback: 180,       // 我抓的（同大砲）
      gravity: 600,         // 同大砲
      minSpeed: 250,        // 同大砲（力量 0 → 250、100 → 900 px/s）
      speedPerPower: 6.5,
      hitRadius: 8,
      passAllies: true,
      shellRadius: 9,
      color: '#a7f3d0',
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

    // ---- 處刑監獄：處刑官與猛獸的招式（enemyOnly；規則見 shared/maps/prison.js）。再吃敵人傷害倍率 ----
    execCleaver: {        // 菜刀丟擲：直直丟向預定的那個人（其他人不會擋到），使用者定的 20 + 10 層流血 → 方案 A 12 + 5 層
      id: 'execCleaver', name: '菜刀丟擲', enemyOnly: true,
      damage: 12,
      bleed: 5,
      knockback: 40,
      radius: 0,
      gravity: 0,
      speed: 760,
      hitRadius: 10,
      passTerrain: true, passAllies: true,
      shellRadius: 10,
      color: '#cbd5e1',
    },
    execFlail: {          // 流星錘（暴怒之後）：使用者定的 50、擊退 200
      id: 'execFlail', name: '流星錘', enemyOnly: true,
      damage: 50,
      knockback: 200,
      radius: 0,
      gravity: 0,
      speed: 820,
      hitRadius: 14,
      passTerrain: true, passAllies: true,
      shellRadius: 14,
      color: '#52525b',
    },
    execBlade: {          // 斷頭台的鍘刀：囚籠撐過 cageRounds 輪還關著 → 拖上斷頭台秒殺（神佑之石的無敵擋得住）
      id: 'execBlade', name: '斷頭台', enemyOnly: true,
      damage: 9999,
      knockback: 0,
      radius: 0,
      gravity: 0,
      speed: 900,
      hitRadius: 16,
      passTerrain: true, passAllies: true,
      shellRadius: 16,
      color: '#e2e8f0',
    },
    chandelier: {         // 天花板的吊燈（打斷鏈子掉下來，跟鐘乳石同一套地形）：砸到第一個角色，砸到敵人另外暈眩一回合（見 prison.js）
      id: 'chandelier', name: '吊燈', hazard: true,
      damage: 60,
      radius: 0,
      gravity: 900,
      speed: 0,
      hitRadius: 22,
      knockback: 80,
      shellRadius: 22,
      color: '#57534e',
    },
    wolfBite: {           // 惡狼撕咬：飛行物就是狼自己，撲向目標（路上的人撲過去不碰），使用者定的 30 + 10 層流血 → 方案 A 18 + 5 層
      id: 'wolfBite', name: '撕咬', enemyOnly: true, passOwner: true, bodyHit: true,
      damage: 18,
      bleed: 5,
      knockback: 60,
      radius: 0,
      gravity: 0,
      speed: 760,
      hitRadius: 22,        // = 狼的半寬
      passTerrain: true, passAllies: true,
      shellRadius: 22,
      color: '#6b7280',
    },
    bearSwipe: {          // 棕熊熊掌拍擊：撲向最近的人，一掌拍飛（35 → 方案 A 21）
      id: 'bearSwipe', name: '熊掌拍擊', enemyOnly: true, passOwner: true, bodyHit: true,
      damage: 21,
      knockback: 250,
      radius: 0,
      gravity: 0,
      speed: 560,
      hitRadius: 32,        // = 熊的半寬
      passTerrain: true, passAllies: true,
      shellRadius: 32,
      color: '#6f4326',
    },
    tigerPounce: {        // 劍齒虎飛撲：撲向標記的人，路上第一個人先被撲到；吃掉流血層數，每層再 +TIGER.bleedBonus（45 → 方案 A 27）
      id: 'tigerPounce', name: '飛撲', enemyOnly: true, passOwner: true, bodyHit: true,
      damage: 27,
      knockback: 100,
      radius: 0,
      gravity: 0,
      speed: 900,
      hitRadius: 30,        // = 虎的半寬
      passTerrain: true, passAllies: true,
      shellRadius: 30,
      color: '#e0812a',
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
    // 威嚇：離持有者多近的敵人算「在旁邊」（px，從持有者的身體中心量到對方身體最近的邊；看傷害結算那一下的位置）
    intimidate: { range: 250 },
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
