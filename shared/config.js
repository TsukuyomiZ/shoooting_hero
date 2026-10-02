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
    stagesBeforeBoss: 5,       // 打完幾個小關進 Boss 關
    enemyHpPerStage: 0.15,     // 每過一關敵人血量 +15%
    healPctOnClear: 0.3,       // 過關後回血（血量上限的比例）
    reviveHpPct: 0.5,          // 倒下的隊友下一關復活時的血量比例
    pickTime: 30,              // 選牌秒數，超時或斷線者隨機選
    offers: 3,                 // 每次給幾張牌
    rarityWeights: { white: 55, green: 30, purple: 12, gold: 3 },   // 抽牌權重
    rarityWeightPerStage: { white: -5, green: 0, purple: 3, gold: 1 }, // 每過一關權重的變化
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
  ENEMY_HP_PER_EXTRA_PLAYER: 0.7,  // 每多一位玩家，敵人血量 +70%
  PLAYER_COLORS: ['#3b82f6', '#22c55e', '#a855f7', '#f97316'],

  // 狂熱：避免雙方血量太多、一關打太久。每過 everyRounds 輪（畫面左上的「第 N 輪」），
  // 所有角色（玩家與敵人）造成的傷害 +damagePct%，會疊加：第 11 輪起 +50%、第 21 輪起 +100%…（每關重新算）。
  // 誤傷、燃燒也吃這個加成；回血不受影響。everyRounds 設 0 = 關掉
  // Boss 關有自己的機制，不套用狂熱（inBoss 改成 true 才會套用）
  FEVER: { everyRounds: 10, damagePct: 50, inBoss: false },

  PLAYER: {
    hp: 150,
    stamina: 200,         // 耐力上限，每回合開始回滿
    moveSpeed: 130,       // px/s
    jumpSpeed: 380,       // 起跳初速
    moveCost: 45,         // 移動每秒消耗耐力（爬藤蔓也是這個）
    jumpCost: 30,         // 每次跳躍消耗耐力
    vineSpeed: 100,       // 爬藤蔓的速度（px/s，見 Entity.updateVine）
  },

  // 「中毒」狀態（叢林巨蟒的攻擊）：在被毒的人自己的回合開始時結算——每層扣最大血量 pctPerStack%，
  // 同時把最大血量鎖住一樣多（100/100 → 99/99，被鎖住的部分血條畫成灰色）。
  // persist = 層數不會自己消失：每個自己的回合開始都再結算一次，再被打中還會疊上去，要喝蛇血才解除（false = 結算完就歸零）。
  // 鎖住的上限也只有蛇血解得開（喝了順便回 SNAKE_BOSS.bloodHeal 血）；不吃減傷、狂熱
  POISON: { pctPerStack: 1, persist: true },

  ENEMY: {
    hp: 45,              // 基礎血量（會依人數放大）
    damageMult: 0.7,     // 敵人（含 Boss）造成的傷害 = 武器傷害 × 這個倍率（再吃狂熱）
    stamina: 200,
    moveSpeed: 110,
    jumpSpeed: 380,
    moveCost: 45,
    jumpCost: 30,
    color: '#ef4444',
    aimError: { angle: 5, power: 10 },  // AI 瞄準誤差（越小越準、越難）
    sniperSpread: 1.2,                   // 用狙擊槍時的角度誤差（±度）
    sniperChance: 0.4,                   // 有直線視野時改用狙擊槍的機率
    moveChance: 0.6,                     // 回合開始時走動的機率
  },

  // 狙擊手（地圖「樹影重重」）：只用狙擊槍，站在原地不走動。關卡的 enemySpawns 寫 type: 'sniper' 就是牠
  SNIPER: {
    hp: 30,              // 基礎血量（跟一般敵人一樣依人數、關數放大）
    stamina: 100,
    moveSpeed: 110,
    jumpSpeed: 380,
    moveCost: 45,
    jumpCost: 30,
    color: '#4d5f2a',
    aimError: { angle: 5, power: 10 },  // 拋射武器用的誤差（狙擊手沒有拋射武器，用不到）
    sniperSpread: 3,                     // 狙擊槍的角度誤差（±度）。4 隻一起開火，太準單人撐不住；越小越準、越難
    sniperChance: 1,
    moveChance: 0,                       // 不走動（走下樹枝會掉進水裡）
    weapons: ['sniper'],
  },

  // ---- Boss 關：古樹之庭 ----
  // 古樹長在地圖最右邊，只有眼睛與嘴巴打得到。眼睛打倒 = 通關（剩下的樹妖跟著枯萎）。
  // 古樹之口打不壞：被攻擊到（直擊或爆炸波及）就閉上，閉著的時候古樹不能召喚，撐過幾個古樹回合後再張開（單人 / 多人不同）。
  // 眼睛與樹妖的血量跟一般敵人一樣「每多一位玩家 +70%」，但不吃「每過一關 +15%」。
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
  // 巨蟒的頭整顆都打得到；血量跟一般敵人一樣「每多一位玩家 +70%」，不吃「每過一關 +15%」。
  // 每受到最大血量 bloodEveryPct% 的傷害，就掉一瓶蛇血到橋上（落點在 level 的 snake.bloodX 範圍內）。
  // 蛇血：自己的回合走過去就喝掉（有被中毒鎖住的上限、或血沒滿才會撿）：先把鎖住的上限全部解開，再回 bloodHeal 血（10/50(100) → 25/100）
  SNAKE_BOSS: {
    hp: 400,              // 巨蟒的血量（使用者沒指定，先抓 400；古樹之眼是 300 但很難打中，巨蟒整顆頭都打得到）
    bloodEveryPct: 10,
    bloodHeal: 15,        // 喝一瓶蛇血回多少血（先解開生命鎖再回，不超過上限）
    // 巨蟒的下一招是事先抽好的（開場一次、之後每次用掉就在巨蟒回合結束時再抽），
    // 抽到巨蟒衝撞時，玩家回合會一直畫出衝撞範圍的警示帶（爬上藤蔓躲開）；其他招式不預告
    weights: { charge: 45, spray: 25, quake: 10, bite: 20 },
    // 毒液噴灑：從嘴巴往左上方隨機散射 count 顆毒液（拋物線）。同一次噴灑每個人最多中一次（10 層）
    // 角度 92° 起（幾乎直直往上）：靠近巨蟒的那條藤蔓上段也噴得到，不會有完全安全的地方
    spray: { count: 6, minAngle: 92, maxAngle: 165, minSpeed: 320, maxSpeed: 780 },
  },

  // 樹妖：古樹之口召喚出來，站著不動，投擲長矛
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
    moveChance: 0,                     // 回合開始時走動的機率
    weapons: ['treeSpear'],
  },

  // 武器。radius = 爆炸 / 挖地半徑（0 = 只打直接命中的角色、不挖地）；gravity > 0 的武器用 minSpeed + 力量 × speedPerPower 當初速
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
      boomerang: true,      // 撞到東西後沿原路飛回角色身上
      returnSpeed: 2,       // 回程速度是去程的幾倍
      homingSpeed: 24,      // 原路走完後飛向角色手上的速度（px/幀；空中丟出、角色已經移動時才用得到）
      color: '#f59e0b',
      desc: '打到東西會沿原路飛回來',
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
    // 裝備「無差別轟炸」落下的飛彈：不能被裝備，也不吃武器傷害加成
    bombard: {
      id: 'bombard', name: '轟炸飛彈', fromEquip: true,
      damage: 50,
      radius: 30,
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
      damage: 30,           // 再吃敵人傷害倍率（×0.7 = 21）
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
      knockback: 600,
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
