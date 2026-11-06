import { CONFIG } from '../core/config.js';
import { LEVELS } from '../maps/level.js';
import { Rng } from '../core/rng.js';
import { Terrain } from '../physics/terrain.js';
import { Entity, poisonTick } from '../physics/entities.js';
import { peekHit, launchVelocity, makeProjectile, hitAction, bounceProjectile, shotTraits, blastRadius, shotRange, applyRecoil, isEquippable } from '../physics/weapons.js';
import { runVolley } from '../physics/volley.js';
import { windMaxOf, rollWind, windAccel } from '../physics/wind.js';
import { catchFire, burnOf } from '../physics/fire.js';
import { planShot } from '../ai/ai.js';
import { canStep, planWalk, planGlide, roamAround, LAND_FRAMES, FALL_FRAMES } from '../ai/ai-move.js';
import { clamp } from '../core/utils.js';
import { mechanicFor, snapshotOf } from '../maps/mechanics/index.js';
import * as Effects from '../cards/effects/index.js';
import { stageRules } from './stage-rules.js';

// 關卡 enemySpawns 的 type → config 裡的數值區塊（沒寫 type = 一般敵人 CONFIG.ENEMY）
const ENEMY_TYPES = { sniper: 'SNIPER', artillery: 'ARTILLERY', bat: 'BAT' };
// 敵人種類的名字（type: 'random' 隨機抽到種類時，名字 = 這個 + 關卡給的 tag，例如「砲兵 B」）
export const ENEMY_LABELS = { normal: '敵人', sniper: '狙擊手', artillery: '砲兵', bat: '蝙蝠' };

// 一場戰鬥（一關）的狀態與規則：地形、角色、回合順序、開火結算、勝負。
// 牌的效果（shared/cards/effects/）只在這裡固定的槽與時間點貢獻數字 / 做事，怎麼組合、照什麼順序在這裡決定；Match 不認得任何一個效果。
// 不碰 DOM、不碰網路；伺服器拿它當唯一的真相，客戶端拿同一份程式播動畫。
// carry[playerId] = { hp, maxHp, maxStamina, moveSpeed, jumpSpeed, size, mods, weapons, …效果帶著走的狀態, links }：肉鴿流程中玩家帶著跑的數值
// config = 關卡規則讀的設定（見 shared/game/stage-rules.js；測試換自己的數字用，其他設定還是全域 CONFIG）
export class Match {
  constructor({ levelId = 'level1', players, seed, carry = {}, stage = 1, config = CONFIG }) {
    this.levelId = levelId;
    this.level = LEVELS[levelId];
    if (!this.level) throw new Error('unknown level: ' + levelId);
    // 這張地圖的地圖機制（見 shared/maps/mechanics/）：Match 只在固定的時間點呼叫它的掛勾，不知道有哪些地圖
    this.mechanic = mechanicFor(this.level, levelId);
    this.seed = seed >>> 0;
    this.stage = stage;
    this.carry = carry;
    this.rng = new Rng(this.seed);
    this.terrain = new Terrain(CONFIG.WORLD_W, CONFIG.WORLD_H, this.level.polygons, {
      hard: this.level.hardPolygons, platforms: this.level.platforms, maxX: this.level.maxX, vines: this.level.vines,
      platformCover: this.level.platformCover, stalactites: this.level.stalactites,
    });
    this.entities = [];
    // 地圖機制的狀態（每場一份，含場上的道具）：機制的 build 建好回傳（見下面），之後由機制讀寫；Match 只存著不碰。
    // 一般小關 = null（見 shared/maps/mechanics/index.js）
    this.mechState = null;
    this.round = 0;     // 第幾輪：裁判在新的一輪開始時加一，客戶端照伺服器的訊息設；狂熱層數照這個算（見 fever）
    // 風（共用機制，見 shared/physics/wind.js）：這一關最大幾級（關卡沒寫 wind = 0，沒有風）、現在的風（每個回合開始由裁判 rollWind 重抽，
    // 客戶端照 turn 訊息 / 快照設）。這個回合射出去的飛行物照它偏（resolveVolley 設在飛行物上；預覽、AI 試射照 world.wind）
    this.windMax = windMaxOf(this.level);
    this.wind = 0;

    // 勝者為王（3v3 對戰，關卡的 pool 'versus'）：玩家分兩隊（players[i].team，照 CONFIG.VERSUS.teams 的順序：第一隊在左邊、第二隊在右邊），
    // 從 teamSpawns 照隊裡的順序出生、面向場中央、顏色照隊伍（players[i].color）；沒有敵人。陣列順序（= 回合順序）照 players 給的
    this.versus = this.level.pool === 'versus';
    const teamSeen = {};
    players.forEach((p, i) => {
      const side = this.versus ? Math.max(0, CONFIG.VERSUS.teams.indexOf(p.team)) : 0;
      const k = teamSeen[side] = (teamSeen[side] ?? -1) + 1;
      const spots = this.versus && this.level.teamSpawns ? this.level.teamSpawns[side] : this.level.playerSpawns;
      const spawn = spots[(this.versus ? k : i) % spots.length];
      const c = carry[p.id] || {};
      this.entities.push(new Entity({
        ...CONFIG.PLAYER,
        id: p.id, name: p.name, team: this.versus ? CONFIG.VERSUS.teams[side] : 'players', controller: 'human', slot: i,
        color: (this.versus && p.color) || CONFIG.PLAYER_COLORS[i % CONFIG.PLAYER_COLORS.length],
        x: spawn.x, y: spawn.y, facing: side === 1 ? -1 : 1,
        hp: c.hp ?? CONFIG.PLAYER.hp, maxHp: c.maxHp ?? CONFIG.PLAYER.hp,
        stamina: c.maxStamina ?? CONFIG.PLAYER.stamina, maxStamina: c.maxStamina ?? CONFIG.PLAYER.stamina,
        moveSpeed: c.moveSpeed ?? CONFIG.PLAYER.moveSpeed, jumpSpeed: c.jumpSpeed ?? CONFIG.PLAYER.jumpSpeed,
        mods: c.mods || {}, weapons: c.weapons, size: c.size, ...Effects.carriedState(c), links: c.links,
      }));
    });
    // 攜手之伴的連結只認這一關真的有的隊友
    for (const e of this.entities) e.links = e.links.filter(id => id !== e.id && this.entities.some(f => f.id === id && f.team === e.team));

    // 關卡規則（見 shared/game/stage-rules.js）：這一關的血量倍率、敵人傷害倍率、狂熱。人數 = 開場的玩家人數（含之後倒下的隊友）；
    // feverFrom = 玩家的效果讓狂熱提早從第幾輪開始（例如狂歡派對；0 = 照原本的）。要在建好玩家之後（看他們的效果）、建敵人之前（敵人血量照這個）
    this.rules = stageRules({ stage, players: players.length, pool: this.level.pool, feverFrom: Effects.feverFrom(this.players) }, config);

    // 敵人血量照關卡規則放大：一般敵人 enemyHp（人數 × 關數）；王與地圖機制的角色 bossHp（人數 × 第幾個王關），交給機制的 build
    const { enemyHp: hpScale, bossHp: bossScale } = this.rules;
    this.level.enemySpawns.forEach((s, i) => {
      // type: 'random'（大亂鬥）：這一場隨機抽一種（用這一關的 seed，伺服器與客戶端抽到的一樣），名字照抽到的種類取，x 再隨機偏移
      let type = s.type || null, name = s.name, x = s.x;
      if (type === 'random') {
        const R = this.level.randomEnemies;
        const pick = this.rng.pick(R.types);
        type = pick === 'normal' ? null : pick;
        name = `${ENEMY_LABELS[pick] || pick} ${s.tag || i + 1}`;
        if (R.jitter > 0) x += this.rng.range(-R.jitter, R.jitter);
      }
      const def = type ? CONFIG[ENEMY_TYPES[type]] : CONFIG.ENEMY;
      if (!def) throw new Error(`unknown enemy type "${type}" in level ${levelId}`);
      const e = new Entity({
        ...def,
        id: `e${i + 1}`, name, team: 'enemies', controller: 'ai', slot: i, kind: type,
        x, y: s.y, facing: s.facing || -1, hp: Math.round(def.hp * hpScale), boss: !!s.boss,
      });
      e.roam = roamAround(def, x, s.y);   // 飄在空中的（蝙蝠）：在出生點周圍飄（見 ai-move.js）
      this.entities.push(e);
    });
    // 地圖機制的角色排在關卡的敵人後面（陣列順序 = 回合順序）；回傳的是這一場機制的狀態
    this.mechState = this.mechanic.build(this, { hpScale, bossScale }) ?? null;

    this.settle(600);   // 開場先讓大家落地
    // 大家站好之後（例如 Boss 先決定第一招）。客戶端用同一個 seed 也會算一次，之後被伺服器的快照蓋掉
    this.mechanic.ready(this);
  }

  get world() {
    return { terrain: this.terrain, entities: this.entities, w: CONFIG.WORLD_W, h: CONFIG.WORLD_H, wind: this.wind };
  }
  // 玩家角色（勝者為王是兩隊加起來）/ 敵人（勝者為王沒有）
  get players() { return this.entities.filter(e => e.isPlayer); }
  get enemies() { return this.entities.filter(e => !e.isPlayer); }
  byId(id) { return this.entities.find(e => e.id === id) || null; }

  // 勝負：冒險 'win' / 'lose' / null（還沒分出來）。
  // 勝者為王：只剩一隊有人活著 = 那一隊的 id（例如 'blue'）；同一下兩隊最後的人一起倒下 = 'draw'
  result() {
    this.mechanic.cascade(this);   // 地圖機制連帶的死亡（例如古樹之眼倒下、包括回合結束被燒死 → 整棵樹枯萎）
    if (this.versus) {
      const standing = CONFIG.VERSUS.teams.filter(t => this.players.some(e => e.team === t && e.alive));
      return standing.length === 1 ? standing[0] : standing.length ? null : 'draw';
    }
    if (!this.players.some(e => e.alive)) return 'lose';
    // 打不打都可以的敵人（蜂巢、蜜蜂）不算：小心擊發的狙擊手全倒就過關
    if (!this.enemies.some(e => e.alive && !e.optional)) return 'win';
    return null;
  }

  // 回合順序：玩家依加入順序 → 敵人依序（entities 陣列本身就是這個順序），跳過死亡者與不會行動的（古樹之口）。
  // 剛召喚的樹妖（dormant）這一輪先不動：繞回陣列開頭 = 新的一輪，才把它們叫醒
  nextActor(afterId) {
    const n = this.entities.length;
    const start = afterId ? this.entities.findIndex(e => e.id === afterId) : -1;
    for (let i = 1; i <= n; i++) {
      if (start + i === n) for (const e of this.entities) e.dormant = false;
      const e = this.entities[(start + i) % n];
      if (e.alive && !e.noTurn && !e.dormant) return e;
    }
    return null;
  }

  step(dt = CONFIG.FIXED_DT) {
    for (const e of this.entities) e.update(dt, this.world);
  }

  isSettled() {
    return this.entities.every(e => !e.alive || e.fixed || e.onVine >= 0 || (e.onGround && Math.abs(e.vx) < 2 && !(e.slide > 0)));   // 被迫滑行（香蕉皮）滑完才算
  }

  settle(maxFrames = 300) {
    let n = 0;
    while (n < maxFrames) {
      this.step();
      n++;
      if (this.isSettled()) break;
    }
    return n;
  }

  // AI 走路：最多 maxFrames 幀（走滿了還在半空中就多走幾幀到落地），前面不安全（ai-move.js 的 canStep：沒地面、會走進水裡 / 走下懸崖、
  // 撞到人）、沒體力、或掉進水裡（moveDir 被清掉）就停。停下來時還在半空中（不管是哪個原因停的）就放開方向鍵、接著落到站穩
  // （最多 FALL_FRAMES 幀）：開火與下一個回合都從地上開始，不會在客戶端瞄準時才落地、重播開火時又被拉回半空中。
  // 回傳 { frames, fall, pickups }：按著方向走了幾幀、放開之後又落了幾幀（客戶端照樣重播：aiTurn 的 walk）；
  // pickups = 斷線代打的玩家（players 那一隊）路上撿到的道具：每一幀照地圖機制的 moved 檢查這一幀走過的線段
  // （跟位置回報一樣，例如點燃火把、喝到蛇血），每個是 { f: 第幾幀撿到的（走路、落地的幀接著數，從 1 開始）, ...fx, hp, mhp, lk }。
  // dry = 試走：只推進 e 自己（AI 拿分身先試兩個方向走得多遠，見 ai-move.js 的 planWalk），不推進別人、不撿道具；allyGap = 離同伴至少多遠（不給 = 預設）
  simulateWalk(e, dir, maxFrames, dry = false, allyGap = undefined) {
    const pickups = [];
    let n = 0, fall = 0;
    const frame = () => {
      const px = e.x, py = e.y, falls = e.waterFalls;
      if (dry) e.update(CONFIG.FIXED_DT, this.world); else this.step();
      e.movedThisTurn += Math.hypot(e.x - px, e.y - py);
      if (dry || !e.isPlayer || !e.alive) return;   // 這一幀流血倒下的不撿（走路也就此停下：die 放開了方向鍵）
      const s = e.waterFalls !== falls ? e.splash : null;   // 這一幀掉進水裡（已經被放回岸上）：線段只算到落水的那一點
      const fx = this.mechanic.moved(this, e, px, py, s ? s.x : e.x, s ? s.y : e.y);
      if (fx) pickups.push({ f: n + fall, ...fx, hp: e.hp, mhp: e.maxHp, lk: e.poisonLock });
    };
    e.moveDir = dir;
    // 踩到香蕉皮（被迫滑行，e.slide）就放開方向鍵，剩下的在下面放開之後的幀裡滑完（客戶端照 fall 幀重播，滑進水坑也在這裡）
    while ((n < maxFrames || (!e.onGround && n < maxFrames + LAND_FRAMES)) && e.moveDir === dir && !(e.slide > 0) && e.stamina > 0 && canStep(this, e, dir, allyGap)) {
      n++;
      frame();
    }
    e.moveDir = 0;
    while (e.alive && (!e.onGround || e.slide > 0) && e.onVine < 0 && fall < FALL_FRAMES) {
      fall++;
      frame();
    }
    return { frames: n, fall, pickups };
  }

  // 位置回報（見 GLOSSARY.md）：行動玩家的客戶端說自己現在在哪（走路、跳、掉水、開火那一刻）。
  // 客戶端對自己的移動有主導權，伺服器只做合理性檢查，並結算路上撿到的道具與落水。
  // report = 客戶端送來的 { x, y, facing, stamina, vy, vine, safe, hp }：
  //   hp = 他畫面上的血量（流血：走路時他自己的畫面已經扣過了，見 Entity.bleedFor）：他在流血才收、只能減不能加（見 acceptBleed），
  //   在位置的檢查之前（位置被擋下也照收）、撿道具與落水之前（喝不喝蛇血、淹不淹死照跟他畫面上一樣的血量算；落水那次帶的是落水扣血之前的）；
  //   扣到倒下的話人就倒在回報的地方，不抓藤蔓、不撿道具、不落水；
  //   facing 1 / -1 才採用；stamina 只能減不能加；
  //   vine = 抓著第幾條藤蔓（-1 = 沒有）：位置真的掛得上去才算，不然當成在半空中（超時就會掉下去）；
  //   safe = 客戶端記的最後站穩的地方（落水那次回報才帶）：站得住、離得不遠就採用，重生點才會跟他畫面上的一樣；
  //   vy = 當下的垂直速度：收下而且沒掉水才接著用（掛在藤蔓上 = 0），超時 / 斷線時伺服器才接得上他原本的軌跡。
  // 站得住的位置記成「最後站穩的地方」；回報在水裡 = 自己走 / 跳進水裡 → 落水（扣血、回到岸上，或淹死）。
  // 回傳 { ok, water, pickup, bled, bledHp, kill }：ok = 收下了（false = 瞬移 / 出界 / 卡進地形，位置什麼都沒改）；
  // water = 這次掉進水裡的那一次（e.splash），沒掉是 null；pickup = 從上一個位置走到這裡的路上撿到的道具
  // （地圖機制的 moved 給的 fx，例如巨蟒關的蛇血），沒有是 null；bled = 照回報的血量流血扣了幾點（沒扣是 0；倒下了看 e.alive）；
  // bledHp = 扣完流血的血量（落水扣血之前，紀錄用）；kill = 流血扣到倒下算到的擊殺（見 creditBleed），沒有是 null
  applyPositionReport(e, report) {
    const { x, y, facing, stamina, vy, vine = -1, safe = null, hp } = report;
    const bleed = this.acceptBleed(e, hp);
    const rejected = { ok: false, water: null, pickup: null, ...bleed };
    if (!Number.isFinite(x) || !Number.isFinite(y)) return rejected;
    if (x < e.hw || x > this.terrain.maxX - e.hw || y < 0 || y > CONFIG.WORLD_H) return rejected;
    if (Math.hypot(x - e.x, y - e.y) > 400) return rejected;   // 不准瞬移
    let ny = y;
    // 在水裡的回報不檢查卡進地形：沿著斜的崖壁掉下去時身體會擦進牆裡一點（直落只檢查腳下），反正馬上就回到岸上
    if (ny <= CONFIG.WATER_LEVEL && e.collides(this.terrain, x, ny)) {
      let ok = false;
      for (let up = 1; up <= 8; up++) {
        if (!e.collides(this.terrain, x, ny - up)) { ny -= up; ok = true; break; }
      }
      if (!ok) return rejected;
    }
    e.movedThisTurn += Math.hypot(x - e.x, ny - e.y);   // 移動可以甩掉燃燒層數
    const x0 = e.x, y0 = e.y;
    e.x = x;
    e.y = ny;
    e.vx = 0;
    e.vy = 0;
    e.slide = 0;   // 被迫滑行（香蕉皮）由他自己的畫面跑；這一段路又踩到的話 moved 會再設
    if (facing === 1 || facing === -1) e.facing = facing;
    if (Number.isFinite(stamina)) e.stamina = clamp(stamina, 0, e.stamina);   // 只能減不能加
    if (!e.alive) return { ok: true, water: null, pickup: null, ...bleed };   // 流血倒下（上面）：倒在這裡，不抓藤蔓、不撿道具、不落水
    e.onVine = Number.isInteger(vine) && vine >= 0 && ny <= CONFIG.WATER_LEVEL && e.canHangAt(this.terrain, vine, x, ny) ? vine : -1;
    const pickup = this.mechanic.moved(this, e, x0, y0, x, ny) || null;   // 在落水檢查之前：走進水裡的那一段也撿得到
    if (ny > CONFIG.WATER_LEVEL) {
      if (safe && Number.isFinite(safe.x) && Number.isFinite(safe.y) && Math.hypot(safe.x - x, safe.y - ny) <= 400 &&
          e.canStandAt(this.terrain, safe.x, safe.y)) {
        e.safeX = safe.x;
        e.safeY = safe.y;
      }
      e.fallInWater(this.terrain);
      return { ok: true, water: e.splash, pickup, ...bleed };
    }
    if (e.canStandAt(this.terrain, x, ny)) {
      e.safeX = x;
      e.safeY = ny;
    }
    if (Number.isFinite(vy)) e.vy = e.onVine >= 0 ? 0 : clamp(vy, -e.jumpSpeed, 1400);
    return { ok: true, water: null, pickup, ...bleed };
  }

  // 行動玩家回報的血量（位置回報的 hp）：只有他在流血時才收（他畫面上走路扣的流血）、只能減不能加（跟體力一樣：伺服器擋得住加血，擋不住少扣）。
  // 扣的照流血算（Entity.loseBlood：死因 bleed，算流血來源造成的傷害 / 擊殺）。
  // 回傳 { bled: 扣了幾點, bledHp: 扣完的血量, kill: 扣到倒下算到的擊殺（見 creditBleed），沒有是 null }
  acceptBleed(e, hp) {
    if (!(e.bleed > 0) || !e.alive || !Number.isFinite(hp)) return { bled: 0, bledHp: e.hp, kill: null };
    const n = e.loseBlood(e.hp - clamp(Math.round(hp), 0, e.hp));
    return { bled: n, bledHp: e.hp, kill: this.creditBleed(e, n) };
  }

  // 流血扣的血（dmg 點）算流血來源造成的傷害（打敵方才算，同燃燒）；扣到倒下算他的擊殺（擊殺的效果照常，例如噬魂者）。
  // 回傳算到的擊殺 { by: 拿到擊殺的人, fx: 擊殺的效果另外記的（例如噬魂者，同燒死；給紀錄與客戶端飄字） }，沒有擊殺是 null
  creditBleed(e, dmg) {
    if (!(dmg > 0)) return null;
    const src = this.byId(e.bleedSource);
    if (!src) return null;
    if (src.team !== e.team) src.dealt += dmg;
    if (e.alive) return null;
    const fx = [];
    return this.creditKills(src, [e], fx).length ? { by: src.id, fx } : null;
  }

  // ---- 回合開始 / 結束（裁判呼叫） ----

  // 輪到 e：體力回滿、自己的回合數 +1
  beginTurn(e) {
    e.stamina = e.maxStamina;
    e.moveDir = 0;
    e.vineDir = 0;
    e.aiming = false;
    e.turnCount++;
    e.movedThisTurn = 0;
    e.bledThisTurn = 0;
  }

  // 輪到 e 之後、開始計時之前（裁判呼叫）：有效果要出手（例如無差別轟炸）就回傳一個函式，
  // 呼叫它才結算那一波、回傳跟開火同樣格式的結果；沒有 = null
  turnBeginVolley(e) {
    return Effects.turnBegin(this, e);
  }

  // 回合中即時移動 / 倒數、碰到人就打的東西（地圖機制的 hazard*，例如流浪劍士的劍氣在玩家回合裡慢慢飛過整排）。
  // 裁判呼叫，now = 裁判的時鐘（ms）：hazardStart = 玩家的回合開始時（回傳給客戶端的資料或 null）、
  // hazardStep = 回合中每隔一小段時間（推進、打碰到的人；flush = 回合要收尾了，還沒到時間的現在就結算）、
  // hazardFinish = 回合收尾時還在動的話，一口氣結算剩下那段的函式
  hazardStart(e, now) {
    return this.mechanic.hazardStart(this, e, now);
  }
  hazardStep(now, flush = false) {
    return this.mechanic.hazardStep(this, now, flush);
  }
  hazardFinish() {
    return this.mechanic.hazardFinish(this);
  }

  // 行動玩家被困住時掙扎一下（客戶端的 struggle：連打 A / D 的其中一下，dir = -1 左 / 1 右；例如大樹遊俠的藤蔓陷阱）。
  // 裁判呼叫，now = 裁判的時鐘（ms）。規則在地圖機制的 struggle：回傳 { ok, reason, count, need, freed } 或 null（沒被困住）
  struggle(e, dir, now) {
    return this.mechanic.struggle(this, e, dir, now);
  }

  // 玩家 e 這回合由遊戲接手（地圖機制的 takeover，例如調皮妖精的魅惑；裁判在回合開始時問）：{ reason, label } 或 null
  takeover(e) {
    return e && e.isPlayer ? this.mechanic.takeover(this, e) : null;
  }

  // 無差別轟炸一次（不看有沒有這張牌）：舊的進入點，留給測試與工具直接呼叫；規則在 shared/cards/effects/bombard.js
  resolveBombard(owner) {
    return Effects.ACTIONS.resolveBombard(this, owner);
  }

  // 自己的回合開始時（轟炸之後、開始計時之前）：中毒結算（可能被毒倒）→ 地圖機制（例如站在蛇血上就喝掉）→ 效果（例如恩賜之杖回血）。
  // 回傳 fx 清單給客戶端飄字
  turnStartEffects(e) {
    const fx = [];
    const poison = poisonTick(e);
    if (poison) fx.push(poison);
    this.mechanic.turnStart(this, e, fx);
    Effects.turnStart(this, e, fx);
    return fx;
  }

  // 自己的回合結束時：
  // - 燃燒：先用這回合移動的距離甩掉層數（每回合最多 maxReducePerTurn 層），剩下的每層扣最大血量 pctPerStack%
  // - 流血：止血（層數歸零）
  // - 糾纏：少一個回合（解開的那一回合記一筆 fx）
  // - 地圖機制的回合結束效果（例如巨蟒被燒到跨過門檻掉蛇血、古樹的嘴巴張開）
  // - 效果的回合結束（照 shared/cards/effects/ 登記的順序：神佑之石給全隊無敵 → 時間扭曲給額外回合）。
  //   isExtra = 這是時間扭曲給的額外回合
  // 在自己的回合倒下了（走路流血、淹死、被自己炸死…）：只跑地圖機制的回合結束（例如處刑監獄的罪人倒下 → 馬上換新的罪人）
  endTurn(e, isExtra = false) {
    const fx = [];
    if (!e.alive) {
      this.mechanic.turnEnd(this, e, fx);
      return fx;
    }
    this.burnTick(e, fx);
    this.stopBleeding(e, fx);
    this.untangle(e, fx);
    this.mechanic.turnEnd(this, e, fx);
    Effects.turnEnd(this, e, fx, isExtra);
    return fx;
  }

  // 燃燒結算（回合結束時）：先用這回合移動的距離甩掉層數，剩下的每層扣最大血量 pctPerStack%；燒死算點火的人的擊殺
  // （擊殺的效果另外記進 fx，例如噬魂者）
  burnTick(e, fx) {
    if (!(e.burn > 0)) return;
    const B = CONFIG.EQUIP.burn;
    const shaken = Math.min(e.burn, B.maxReducePerTurn, Math.floor(e.movedThisTurn / B.pxPerStack));
    e.burn -= shaken;
    e.burnFrac += e.burn * B.pctPerStack / 100 * e.maxHp * this.feverMult();
    const whole = Math.floor(e.burnFrac);
    e.burnFrac -= whole;
    const dmg = whole > 0 ? e.takeDamage(whole) : 0;
    if (dmg > 0 || shaken > 0) fx.push({ type: 'burn', id: e.id, dmg, shaken, stacks: e.burn });
    const igniter = this.byId(e.burnSource);
    if (igniter && igniter.team !== e.team) igniter.dealt += dmg;   // 燒掉的血算點火的人造成的傷害
    const src = !e.alive && igniter;
    if (src) this.creditKills(src, [e], fx);
  }

  // 流血在自己的回合結束時止血（層數全部清掉）：還活著才記一筆 fx 給客戶端飄字（stacks = 止住了幾層、dmg = 這回合流血扣了幾點）
  stopBleeding(e, fx) {
    if (!(e.bleed > 0)) return;
    if (e.alive) fx.push({ type: 'bleed', id: e.id, stacks: e.bleed, dmg: e.bledThisTurn });
    e.bleed = 0;
    e.bleedFrac = 0;
  }

  // 糾纏在自己的回合結束時少一個回合；解開了記一筆 fx 給客戶端飄字
  untangle(e, fx) {
    if (!(e.entangle > 0)) return;
    e.entangle--;
    if (e.entangle === 0) fx.push({ type: 'untangle', id: e.id });
  }

  // ---- 傷害規則 ----

  // 回血（吸血、恩賜之杖）：不足 1 點的小數先存著，長期下來剛好是設定的比例。回傳實際回了幾點
  heal(e, amount) {
    if (!e.alive || !(amount > 0)) return 0;
    e.healFrac += amount;
    const whole = Math.floor(e.healFrac);
    e.healFrac -= whole;
    const n = Math.max(0, Math.min(whole, e.maxHp - e.hp));
    e.hp += n;
    return n;
  }

  // 新的一輪開始（裁判在回合順序繞回前面時呼叫）：輪數 +1（狂熱跟著輪數走），再問地圖機制這一輪的變化（roundStart，
  // 例如岩穴的火把變暗 / 熄滅），回傳 fx 清單給紀錄。客戶端不呼叫這個（輪數照伺服器的訊息設）
  // 新的回合抽風（裁判的 nextTurn 呼叫；沒有風的關卡不抽亂數、一直是 0）。回傳現在的風
  rollWind() {
    if (this.windMax > 0) this.wind = rollWind(this.rng, this.windMax);
    return this.wind;
  }

  beginRound() {
    this.round++;
    const fx = [];
    this.mechanic.roundStart(this, fx);
    return fx;
  }

  // 狂熱層數：照關卡規則與現在第幾輪算（幾輪一層看這一關的玩家人數；Boss 關沒有，除非 FEVER.inBoss 打開）。
  // 伺服器、客戶端、效果都讀這個，沒有人另外寫
  get fever() {
    return this.rules.feverAt(this.round);
  }

  // 狂熱：所有傷害的倍率（不分敵我、不分攻擊來源）
  feverMult() {
    return 1 + this.fever * this.rules.feverPct / 100;
  }

  // 場上還活著的隊友有幾個（不含自己）：看隊友人數的效果（孤狼傳說、團結力量大）看這個
  alliesAlive(e) {
    return this.entities.reduce((n, f) => n + (f !== e && f.alive && f.team === e.team ? 1 : 0), 0);
  }

  // 一次射擊結算完：有沒有打中敵人（直擊或波及到敵方都算，傷害 0 也算，例如閉上的古樹之口）。
  // 效果的 afterShot（磨刀霍霍、越戰越強）與結算畫面的命中率都照這個
  hitEnemy(events) {
    return events.some(ev => ev.damages && ev.damages.some(d => !d.friendly && !d.noCredit));
  }

  // 受到的傷害 -N%（效果的 armor 槽，例如健壯藥丸類、團結力量大、威嚇）；allies = 活著的隊友數；
  // attacker = 這一下的攻擊者（看攻擊者的效果用，例如威嚇：離自己近的敵人打的才減）。狀態列的「減傷」不給 = null；
  // at = 用身體撞人的招式撞上那一下的位置（見 applyExplosion），其他 = null
  armorOf(e, allies = this.alliesAlive(e), attacker = null, at = null) {
    return Effects.effectSum('armor', e, { match: this, allies, attacker, at });
  }

  // 免疫異常狀態（效果的 immune 槽，例如金剛不壞）：被打中時不上燃燒、中毒、流血
  immuneTo(e) {
    return Effects.effectAny('immune', e, { match: this });
  }

  // 傷害吸血 %（效果的 lifesteal 槽，例如血之爪類、孤狼傳說）；allies = 活著的隊友數
  lifestealOf(e, allies = this.alliesAlive(e)) {
    return Effects.effectSum('lifesteal', e, { match: this, allies });
  }

  // 攜手之伴：e 現在跟哪些活著的隊友連結著（角色的 links；畫面的連結標記也照這個）
  linkPartners(e) {
    const out = [];
    for (const id of e.links) {
      const q = this.byId(id);
      if (q && q.alive && q !== e) out.push(q);
    }
    return out;
  }

  // 攻擊者對某武器的傷害倍率（效果的加成）。敵人（含 Boss、樹妖、蜜蜂）照關卡規則的 enemyDamage。
  // 裝備產生的攻擊（轟炸）跟持有者自己的其他攻擊一樣吃這些加成（只限某把武器的加成，武器 id 不是那把就不算）。
  // 效果的武器傷害 % 分三個槽、照這個順序相加：damage（自己的加成：所有武器 / 這把武器 → 每回合成長 → 擊殺累積）
  // → situation（看場上：這一關的暫時加成、隊友人數）→ state（看自己的狀態：狂熱、層數）。
  // 最後再乘上地圖機制給的倍率（attackMult，例如岩穴：站在陰影裡的敵人 +30%；看結算這一下攻擊者站在哪）
  damageMult(attacker, weapon) {
    if (!attacker) return 1;
    const map = this.mechanic.attackMult(this, attacker, weapon);
    if (!attacker.isPlayer) return this.rules.enemyDamage * map;
    const c = { match: this, weaponId: weapon.id, allies: this.alliesAlive(attacker) };
    const pct = (slot) => Effects.effectSum(slot, attacker, c);
    return Math.max(0, 1 + (pct('damage') + pct('damageSituation') + pct('damageState')) / 100) * map;
  }
  explosionRadius(attacker, weapon) {
    return blastRadius(attacker, weapon);
  }

  // 爆炸 / 命中：傷害（同隊含自己 ×FRIENDLY_FIRE，再吃雙方的效果加成與狂熱）、燃燒、擊退。回傳傷害清單。
  // radius 0 的武器（迴力鏢）與 opts.directOnly（穿透）只打 directHit；opts.exclude 裡的角色不受影響。
  // 一個人要扣的傷害：武器傷害 × 距離 × 攻擊者的倍率與狂熱（× 誤傷）→ × 對首領 → × 對這個目標（效果的 damageTarget，例如威嚇）
  // → × 減傷（含看攻擊者的，例如威嚇）→ × 地圖機制的受傷倍率 → × 誤傷減傷 → 效果的 share（攜手之伴：
  // 先減再跟活著的連結對象平分，清單裡多一筆 shared = 被打的人）。扣完血，真的扣到的人（含分到的）交給效果的 onHurt（例如被虐體質）。
  // 先照這一下之前的場面算好每個人要扣多少（誰活著、誰有無敵、隊友幾個），再一起扣：
  // 同一發炸到好幾個人時，結果不會因為角色的排列順序（誰先加入房間）而不同。
  // 用身體撞人的招式（武器的 bodyHit：飛行物就是攻擊者的身體）結算時攻擊者還在出發點（撞完才搬過去）：
  // 看距離的效果（damageTarget、armor 的 c.at，例如威嚇）改量撞上那一下的位置 at = 飛行物的中心 (x, y)、r = 它的判定半徑（= 身體的大小）
  applyExplosion(x, y, weapon, attacker, directHit, opts = {}) {
    const damages = [];
    const at = weapon.bodyHit ? { x, y, r: weapon.hitRadius || 0 } : null;
    const radius = this.explosionRadius(attacker, weapon);
    const R = radius + 6;
    const splash = radius > 0 && !opts.directOnly;
    const atk = this.damageMult(attacker, weapon) * this.feverMult();
    const kbMult = attacker ? Math.max(0, 1 + Effects.effectSum('knockback', attacker, { match: this, weaponId: weapon.id }) / 100) : 1;
    const burn = opts.burn || 0;
    const aliveBefore = this.entities.filter(e => e.alive);
    const alive0 = new Set(aliveBefore);
    const alliesBefore = (e) => aliveBefore.reduce((n, f) => n + (f !== e && f.team === e.team ? 1 : 0), 0);
    // 神佑之石：爆炸前有無敵的人，這一下（自己被打到、分到隊友的份）全部擋掉，無敵只用掉一次
    const shielded = new Set(aliveBefore.filter(e => e.shield > 0));
    const spent = new Set();
    const block = (e) => { if (!spent.has(e)) { spent.add(e); e.shield--; } };

    // 0. 這一下碰得到誰；opts.pick(清單) 可以再挑掉一些（例如無差別轟炸每一隻最多被炸幾次，見 resolveHit）
    let reach = [];
    for (const e of aliveBefore) {
      if (opts.exclude && opts.exclude.has(e)) continue;
      if (e.intangible) continue;   // 躲起來的（例如洞穴深處的巨蠍）：直擊、波及都碰不到
      const direct = e === directHit;
      const d = e.distanceTo(x, y);
      if (!direct && (!splash || d > R)) continue;
      reach.push({ e, direct, d });
    }
    if (opts.pick) reach = opts.pick(reach);

    // 1. 算好每個被打到的人要扣多少、要分多少給連結對象（還沒扣血）
    const hits = [];
    const later = [];   // 地圖機制要等大家都扣完血才做的事（例如蜂巢扣 1、放蜜蜂）
    for (const { e, direct, d } of reach) {
      const factor = direct ? 1 : Math.max(0.3, 1 - d / R);
      const friendly = !!attacker && e.team === attacker.team;
      // 地圖機制自己處理的角色（例如古樹之口、蜂巢、蛛卵）：在無敵之前，不進一般的傷害、燃燒、擊退（burn = 這一下會附加的燃燒層數，要燒的自己上）
      if (this.mechanic.absorbHit(this, e, { attacker, friendly, damages, later, burn })) continue;
      if (shielded.has(e)) {   // 這一下完全無效，也不會被擊退、不會分給連結對象
        block(e);
        damages.push({ id: e.id, dmg: 0, friendly, blocked: true });
        continue;
      }
      let dmg = weapon.damage * factor * atk * (friendly ? CONFIG.FRIENDLY_FIRE : 1);
      if (e.boss && attacker) dmg *= Math.max(0, 1 + Effects.effectSum('damageBoss', attacker, { match: this, weaponId: weapon.id }) / 100);
      if (attacker) dmg *= Math.max(0, 1 + Effects.effectSum('damageTarget', attacker, { match: this, weaponId: weapon.id, target: e, at }) / 100);
      dmg *= Math.max(0, 1 - this.armorOf(e, alliesBefore(e), attacker, at) / 100);
      dmg *= this.mechanic.defenseMult(this, e);   // 地圖機制的受傷倍率（例如大樹守衛舉盾）
      if (friendly) dmg *= Math.max(0, 1 - Effects.effectSum('friendlyArmor', e, { match: this }) / 100);
      const entry = { id: e.id, dmg: 0, friendly };
      damages.push(entry);
      const hit = { e, entry, own: dmg, shares: [], factor };
      // 效果分走這一下（攜手之伴：分給活著的連結對象；分到的那份一樣會被無敵擋下）
      Effects.share(this, hit, { alive0, shielded, block, friendly, damages });
      hits.push(hit);
    }
    // 2. 扣血（每個人最後扣的總數跟順序無關，扣到 0 就倒下）
    for (const h of hits) {
      h.entry.dmg = h.e.takeDamage(h.own);
      for (const s of h.shares) s.entry.dmg = s.q.takeDamage(s.amount);
    }
    // 真的扣到血的人（自己被打到、分到的那份各算一次）：效果的 onHurt（例如被虐體質疊層數）。大家都扣完才叫，跟角色順序無關。
    // 自己被打到的那份另外告訴地圖機制（hurt，例如流浪劍士的格擋架勢數被打中幾次）
    for (const h of hits) {
      if (h.entry.dmg > 0) {
        Effects.onHurt(this, h.e, h.entry.dmg);
        this.mechanic.hurt(this, h.e, h.entry.dmg, attacker);
      }
      for (const s of h.shares) if (s.entry.dmg > 0) Effects.onHurt(this, s.q, s.entry.dmg);
    }
    for (const f of later) f();   // 這時候才出現的角色（蜜蜂）不會被這一下打到
    // 結算統計：打在敵方身上的傷害（含分給連結對象的份、地圖機制寫的那幾筆）算攻擊者造成的；
    // 誤傷另外記成誤傷隊友（含分給連結對象的份），打到自己（含分回自己身上的份）不算
    // 地圖機制標了 noCredit 的那幾筆（例如調皮妖精的分身被打破、炸開來炸到的人）不算攻擊者的（命中、吸血也不算）
    if (attacker) {
      for (const d of damages) {
        if (d.noCredit) continue;
        if (!d.friendly) attacker.dealt += d.dmg;
        else if (d.id !== attacker.id) attacker.friendlyDealt += d.dmg;
      }
    }
    // 3. 燃燒、中毒、流血、擊退（分到的份不會擊退、不會中毒、不會流血）。
    // 免疫異常狀態的人（immuneTo，例如金剛不壞）這三種都不上：這一下本來會上的話記 immune（客戶端飄「免疫」）
    const poison = weapon.poison || 0;
    const bleed = weapon.bleed || 0;
    for (const { e, entry, factor } of hits) {
      const immune = (burn > 0 || poison > 0 || bleed > 0) && !!attacker && !entry.friendly && e.alive && this.immuneTo(e);
      if (immune) entry.immune = true;
      if (burn > 0 && attacker && !entry.friendly && e.alive && !immune) {
        e.burn += burn;
        e.burnSource = attacker.id;
        entry.burn = burn;
      }
      if (poison > 0 && attacker && !entry.friendly && e.alive && !immune) {   // 有毒的攻擊（巨蟒、蜜蜂）：傷害 0 也照樣上毒
        e.poison += poison;
        entry.poison = poison;
      }
      if (bleed > 0 && attacker && !entry.friendly && e.alive && !immune) {   // 會流血的攻擊（武器的 bleed）：同上，傷害 0 也照樣上；層數一直疊
        e.bleed += bleed;
        e.bleedSource = attacker.id;
        entry.bleed = bleed;
      }
      // 擊退：只用開根號，避免三角函數在不同引擎上有微小差異。knockDir = 固定方向（大地震擊往巨蟒那邊甩）
      const kb = weapon.knockback * factor * kbMult * (e.boss ? 0.3 : 1);
      if (kb <= 0 || e.fixed || e.held) continue;   // 古樹的部位長在樹上、巨蟒的頭不會動、關在囚籠裡的人，不會被擊退
      let ux, uy;
      if (weapon.knockDir) {
        ux = weapon.knockDir.x;
        uy = weapon.knockDir.y;
      } else {
        const dx = e.cx - x, dy = e.cy - y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        ux = dx / dist;
        uy = dy / dist;
      }
      e.knockBack(ux, uy, kb);   // 抓著藤蔓的人被打下來
    }
    return damages;
  }

  // 吸血：這一下對敵人造成的傷害 × 吸血 %（pct 預設照現在的場面算；開火結算傳入打中之前的，孤狼傳說才不會被這一下改變）
  lifesteal(attacker, damages, pct = attacker ? this.lifestealOf(attacker) : 0) {
    if (!attacker || !(pct > 0)) return 0;
    const dealt = damages.reduce((s, d) => s + (d.friendly || d.noCredit ? 0 : d.dmg), 0);
    return dealt > 0 ? this.heal(attacker, dealt * pct / 100) : 0;
  }

  // before 裡現在死掉的敵人算攻擊者的擊殺，再交給效果的 onKill（例如噬魂者每殺一個武器傷害 +N%，整場冒險累積）。
  // fx = 燒死時回合結束的 fx 清單（效果可以另外記一筆給客戶端飄字）；開火結算時不給
  creditKills(attacker, before, fx = null) {
    const killed = before.filter(e => !e.alive && e.team !== attacker.team && !e.noKill);   // noKill：打倒不算擊殺（蜂巢不是活的）
    attacker.kills += killed.length;
    Effects.onKill(this, attacker, killed, fx);
    return killed.map(e => e.id);
  }

  // ---- 開火結算 ----

  // 結算一發：飛行（可能好幾顆）→ 爆炸 → 所有人落地。回傳同步用的完整結果。
  resolveShot(actor, weaponId, angle, power) {
    const weapon = CONFIG.WEAPONS[weaponId];
    actor.weapon = weaponId;
    actor.aimAngle = angle;
    actor.aimPower = Math.round(power);
    actor.facing = Math.cos(angle * Math.PI / 180) >= 0 ? 1 : -1;
    actor.aiming = false;
    actor.moveDir = 0;
    actor.vineDir = 0;
    actor.vx = 0;   // 還在滑（被擊退、踩到香蕉皮）也停下來：客戶端重播擺射手時一律從站著不動開始（volley.js 的 place），兩邊才一樣
    actor.slide = 0;
    // 在空中開火時 vy ≠ 0，客戶端從同一個狀態接著播；sx / sy = 最後站穩的地方、hp = 現在的血量
    // （這回合掉過水的話客戶端手上的可能是舊的）：把自己摔進水裡時兩邊才會扣一樣的血、在同一個地方重生。
    // vn = 抓著第幾條藤蔓（掛在藤蔓上開火，重播時才不會掉下去）
    const actorPos = { x: actor.x, y: actor.y, vy: actor.vy, sx: actor.safeX, sy: actor.safeY, hp: actor.hp, vn: actor.onVine };
    const m = actor.muzzle();
    const v = launchVelocity(weapon, angle, power);
    const projs = [];
    for (let k = 0; k < (weapon.volley || 1); k++) {   // 等離子飛彈：同一條彈道隔幾幀再射
      const p = makeProjectile(actor, weapon, m.x, m.y, v.vx, v.vy);
      p.spawn = 1 + k * (weapon.volleyGap || 0);
      p.follow = k > 0;   // 後面幾發從射手「出發那一幀」的砲口射出（空中開火時射手會移動，不能從他腳下冒出來）
      const traits = shotTraits(actor, weapon.id);   // 效果給的特性：在地形上彈射幾次、穿透角色
      p.bouncesLeft = traits.bounces;
      if (traits.pierce) p.pierce = true;
      p.range = shotRange(weapon, power);   // 最長路徑（迴力鏢看力量、高壓水炮固定）
      projs.push(p);
    }
    // 後座力（高壓水炮）：開火的當下射手被往後推，飛行途中照物理飛出去（客戶端重播擺好射手之後也照同一組初速推一次）
    applyRecoil(actor, weapon, v.vx, v.vy);
    const burn = Effects.effectSum('burnOnHit', actor, { match: this, weaponId: weapon.id });   // 擊中的敵人附加幾層燃燒
    return {
      kind: 'weapon', actorId: actor.id, weapon: weaponId, angle, power, facing: actor.facing,
      actor: actorPos,
      ...this.resolveVolley(actor, weapon, projs, burn, true),
    };
  }

  // isShot = 自己開的一槍（效果的攻擊（轟炸）、Boss 招式不算）：結算完交給效果的 afterShot（例如磨刀霍霍 / 越戰越強的層數），
  // results 帶的是更新後的。結果另外帶效果要給客戶端的狀態（例如噬魂者的 soul）
  resolveVolley(owner, weapon, projs, burn, isShot = false) {
    // 風：這一波的飛行物照這個回合的風偏（吃不吃風看武器，見 physics/wind.js）；重播照 projectiles 帶的 wind 飛
    for (const p of projs) if (!p.wind) p.wind = windAccel(this.wind, p.weapon);
    // 每一隻最多被這一波打到幾次（武器的 maxHits，例如無差別轟炸）：這一波的飛行物共用一份 ignore（各自的併起來）與計數 hitCount，見 resolveHit
    if (weapon.maxHits) {
      const ignore = new Set(projs.flatMap(p => [...p.ignore]));
      const hitCount = new Map();
      for (const p of projs) Object.assign(p, { ignore, hitCount });
    }
    const specs = projs.map(p => ({ spawn: p.spawn, x: p.x, y: p.y, vx: p.vx, vy: p.vy, ...(p.follow ? { follow: true } : {}), ...(p.wind ? { wind: p.wind } : {}) }));
    const before = this.entities.filter(e => e.alive);
    const n0 = this.entities.length;
    // 飛行 → 沉降（shared/physics/volley.js：跟客戶端重播同一個幀迴圈；撞到東西時呼叫下面的 resolveHit）
    const { events, flightFrames, settleFrames } = runVolley(this, owner, weapon, projs, burn);
    // 地圖機制連帶的死亡（這一發打倒了古樹之眼 → 嘴巴與樹妖一起枯萎）：要在算擊殺之前，也算擊殺。
    // 回傳的欄位接在結果上（例如處刑官跳下處刑台的 descend；紀錄照它記）
    const cascaded = this.mechanic.cascade(this);
    // 這一發途中才出現的角色（打到蜂巢飛出來的蜜蜂）被同一發後面的砲彈打死，也算擊殺
    const kills = this.creditKills(owner, [...before, ...this.entities.slice(n0)]);
    const hitEnemy = isShot ? this.hitEnemy(events) : undefined;
    if (isShot) {   // 結算畫面的命中率：一槍（不管幾顆砲彈）算一次，命中的定義同 afterShot
      Effects.afterShot(this, owner, hitEnemy);
      owner.shots++;
      if (hitEnemy) owner.hits++;
    }
    return {
      projectiles: specs, events, hit: summarizeHit(events),
      kills, ...Effects.shotState(owner), ...(isShot ? { hitEnemy } : {}), ...(cascaded || {}),
      results: this.entities.map(e => e.toState()),
      flightFrames, settleFrames,
    };
  }

  // 一顆飛行物撞到東西（shared/physics/volley.js 的 runVolley 呼叫）：依規則爆炸 / 穿透 / 彈射 / 折返，結果寫成一個事件。
  // 飛行物的狀態（結束 / 回程、著火）不在這裡改：runVolley 拿事件套用同一個狀態機（transition），客戶端重播也是那一份。
  // from = 這一幀從哪裡飛過來 { x, y }（迴力鏢回程掃到的沒有）：撞到之前那一小段穿過場上的火源（例如洞穴的火把）就在結算傷害之前著火
  // （事件帶 ignite）。著火的飛行物打中的人，除了這一波的燃燒 burn 再附加它的火（著火是共同設定，見 shared/physics/fire.js）
  resolveHit(owner, weapon, p, i, hit, frame, burn, from = null) {
    const act = hitAction(p, hit);
    const ev = { f: frame, p: i, type: act === 'end' ? hit.type : act, x: hit.x, y: hit.y };
    const target = hit.type === 'entity' ? hit.entity : null;
    if (target) ev.target = target.id;
    const ignite = from ? catchFire(this, owner, weapon, p, { x0: from.x, y0: from.y, x1: hit.x, y1: hit.y, r: p.hitRadius }) : 0;
    if (ignite > 0) ev.ignite = ignite;
    burn = burnOf(burn, p, ignite);
    const stealPct = this.lifestealOf(owner);   // 打中之前的場面（看隊友人數的吸血：這一下炸死隊友不算）
    let damages = null;
    let blast = 0;   // 這一下的爆炸半徑（沒爆炸 = 0），給地圖機制的 struck
    const pick = p.hitCount ? capPick(p.hitCount, weapon.maxHits) : null;   // 每一隻最多被這一波打到幾次（見下面）
    // 穿透衰減（武器的 pierceFalloff，大樹遊俠的貫穿箭）：這顆已經穿過幾個角色（p.pierced），這一下的傷害就再 × falloff 幾次
    // （第一個 100%、第二個 50%…）。換一份改了 damage 的武器結算（id 不變，客戶端照事件的傷害播）
    if (target && weapon.pierceFalloff > 0) {
      weapon = { ...weapon, damage: weapon.damage * Math.pow(weapon.pierceFalloff, p.pierced || 0) };
      p.pierced = (p.pierced || 0) + 1;
    }
    switch (act) {
      case 'end':
        break;
      case 'bounce':
        bounceProjectile(this.terrain, p, hit);
        Object.assign(ev, { x: p.x, y: p.y, vx: p.vx, vy: p.vy });
        break;
      case 'pierce':
        p.ignore.add(target);
        damages = this.applyExplosion(hit.x, hit.y, weapon, owner, target, { directOnly: true, burn, pick });
        Object.assign(ev, { vx: p.vx, vy: p.vy });
        break;
      case 'return':   // 迴力鏢：飛到最長路徑（或撞到地形 / 落水 / 飛出場外）就沿原路飛回去。回程重新算一趟：去程打過的敵人回程還會再被打一次
        p.ignore.clear();
        p.ignore.add(owner);
        if (hit.type !== 'terrain') ev.on = hit.type;   // range / water / out：客戶端照這個演（落水的濺水花）
        break;
      default: {       // explode
        const r = this.explosionRadius(owner, weapon);
        blast = r;
        // noCarve（無差別轟炸、高壓水炮）：照樣有範圍傷害與擊退，只是不挖地形；爆炸多大照 blast 給客戶端演
        if (r > 0 && weapon.noCarve) ev.blast = r;
        else if (r > 0) {
          ev.carve = { x: hit.x, y: hit.y, r };
          this.terrain.carve(hit.x, hit.y, r);
        }
        damages = this.applyExplosion(hit.x, hit.y, weapon, owner, target, { burn, exclude: p.ignore, pick });
        // 毒液噴灑：同一次噴灑的毒液共用 ignore，打中過的人其他顆就穿過去（每人最多中一次）
        if (target && weapon.shareHits) p.ignore.add(target);
      }
    }
    // 每一隻被這一波打到幾次（武器的 maxHits，無差別轟炸：大體積的怪物一次被好幾發炸到）：被打到 = 傷害清單裡有他（被擋下、地圖機制處理的也算），
    // 攜手之伴分到的那份（shared）不算；好幾個部位的怪物（Entity.body，例如巨蠍）整隻合起來算。
    // 到了就整隻放進這一波共用的 ignore：之後的飛行物穿過他、爆炸也炸不到他（同一下就會超過的，由 pick 先挑掉）
    if (damages && p.hitCount) {
      for (const d of damages) {
        const e = d.shared ? null : this.byId(d.id);
        if (!e) continue;
        const k = hitKey(e);
        const n = (p.hitCount.get(k) || 0) + 1;
        p.hitCount.set(k, n);
        if (n >= weapon.maxHits) for (const f of this.entities) if (hitKey(f) === k) p.ignore.add(f);
      }
    }
    // 地圖機制對「這一下打在哪裡」的反應（例如洞穴：打到 / 炸到鐘乳石就掉下來、打在火把旁邊就點燃）：附在事件上，客戶端照著播（replayEvent）。
    // 半路才出現的飛行物（掉下來的鐘乳石，p.added）不算；落水、飛出場外不算（迴力鏢在水面、場外折返也一樣）。
    // 飛到最長路徑停下的那一點（range：高壓水炮散掉、迴力鏢在半空中折返）算：這一幀有事件就不做飛過去的判定（resolvePass），終點要照樣看
    if ((hit.type === 'terrain' || hit.type === 'entity' || hit.type === 'range') && !p.added) {
      const extra = this.mechanic.struck(this, owner, {
        type: hit.type, x: hit.x, y: hit.y, blast, weapon: weapon.id, ...(from ? { x0: from.x, y0: from.y, r: p.hitRadius } : {}),
      });
      if (extra) Object.assign(ev, extra);
    }
    if (damages && damages.length) {
      ev.damages = damages;
      const heal = this.lifesteal(owner, damages, stealPct);
      if (heal > 0) ev.heal = heal;
      const ids = new Set(damages.map(d => d.id));
      if (heal > 0) ids.add(owner.id);
      ev.ents = this.entities.filter(e => ids.has(e.id)).map(e => e.toEventState());
      // 地圖機制附在事件上的（例如巨蟒掉的蛇血 drops、蜂巢飛出來的蜜蜂 bees、處刑監獄的吊燈砸暈 stuns）：客戶端在這一幀照著播（重播見 replayEvent）。
      // 第二個參數 = 這一下是什麼武器（半路掉下來的吊燈是它自己的武器）、打到誰
      Object.assign(ev, this.mechanic.eventExtras(this, { weapon: weapon.id, damages }));
    }
    return ev;
  }

  // 一顆飛行物這一幀從 (x0, y0) 飛到現在的位置、沒撞到東西（shared/physics/volley.js 的 runVolley 呼叫）：地圖機制要它留下記號的話
  // （例如玩家的子彈從火把旁邊飛過去 → 點燃）、或它穿過場上的火源著火了（ignite，見 shared/physics/fire.js）寫成一個 pass 事件（飛行物照樣繼續飛），不然 null。
  // 地圖機制把它攔下來（回傳的欄位帶 stop，例如頑皮猴王接住砲彈）：寫成 snatch 事件，飛行物到此為止（不爆炸、不著火）。
  // seg.ahead() 給地圖機制問「照現在的樣子飛下去第一個撞到什麼」（peekHit：拿一份複本試飛，不動這顆）
  resolvePass(owner, p, i, frame, x0, y0) {
    const world = this.world;
    const seg = { x0, y0, x1: p.x, y1: p.y, r: p.hitRadius, weapon: p.weapon.id, ignore: p.ignore, ahead: () => peekHit(world, p) };
    const extra = this.mechanic.passed(this, owner, seg);
    if (extra && extra.stop) {
      const { stop, ...rest } = extra;
      return { f: frame, p: i, type: 'snatch', x: p.x, y: p.y, ...rest };
    }
    const ignite = catchFire(this, owner, p.weapon, p, seg);
    if (!extra && !(ignite > 0)) return null;
    return { f: frame, p: i, type: 'pass', x: p.x, y: p.y, ...extra, ...(ignite > 0 ? { ignite } : {}) };
  }

  // AI 回合：先走動（站在地上的走路 walk = { dir, frames, fall }，代打的玩家路上撿到道具再帶 pickups；
  // 有活動範圍 roam 的飄移 glide = { dx, dy, frames }，見 ai-move.js），再從走到（落地）的地方規劃一發。回傳 { walk, glide, plan }；
  // 由地圖機制出招的角色（Boss、蜜蜂）不走也不開火，而是出招並直接結算好：回傳 { boss: { steps, next } }（見 mechanics/ 的 aiTurn）；
  // 這一發由地圖機制決定的（aiShot，例如被魅惑的人）不走動，回傳 { plan, forced（紀錄要帶的）}；
  // 有活動範圍的（獨眼巨人）先飄移再出招。weapons = 這一發只能用哪些武器（射過飛鏢的回合被代打：只能用飛鏢）；不給 = 武器欄全部。
  // 流血的角色飄移 / 走路途中會扣血（見 Entity.bleedFor）：扣的算流血來源的，扣到倒下就不出招、不開火（plan、boss 都是 null；
  // 客戶端照樣播完走動，在同一幀倒下）。算到流血來源的擊殺時另外回傳 kill = { by, fx }（見 creditBleed；裁判記進 ai.turn、跟著 aiTurn 給客戶端飄字）
  planAiTurn(actor, weapons = null) {
    let bled = actor.bledThisTurn;
    const glide = planGlide(this, actor);
    let kill = this.creditBleed(actor, actor.bledThisTurn - bled);
    if (!actor.alive) return { walk: null, glide, plan: null, boss: null, kill };
    const boss = this.mechanic.aiTurn(this, actor);
    if (boss) return { walk: null, glide, plan: null, boss };
    // 這一發由地圖機制決定（例如調皮妖精魅惑的人打隊友、代打的玩家隨機挑一個妖精）：不走動，forced = 紀錄要帶的（有才帶）
    const forced = this.mechanic.aiShot(this, actor, weapons);
    if (forced) return { walk: null, glide, plan: forced.plan, ...(forced.info ? { forced: forced.info } : {}) };
    bled = actor.bledThisTurn;
    const walk = actor.roam ? null : planWalk(this, actor);
    kill = this.creditBleed(actor, actor.bledThisTurn - bled);
    if (!actor.alive) return { walk, glide, plan: null, boss: null, kill };
    const plan = planShot(this.world, actor, this.rng, weapons || actor.weapons);
    return { walk, glide, plan };
  }

  // ---- 同步 ----
  snapshot() {
    return {
      entities: this.entities.map(e => e.toState()),
      holes: this.terrain.holes.map(h => ({ x: h.x, y: h.y, r: h.r })),
      ...(this.windMax ? { wind: this.wind } : {}),   // 有風的關卡：現在的風（重連、開場）
      ...snapshotOf(this),   // 地圖機制的欄位（含場上的道具；每張地圖都帶、順序固定，見 mechanics/index.js）
    };
  }

  applyEntities(states) {
    for (const s of states) {
      const e = this.byId(s.id);
      if (e) e.applyState(s);
    }
  }

  applySnapshot(s) {
    if (s.holes) this.terrain.reset(s.holes);
    if (Number.isFinite(s.wind)) this.wind = s.wind;
    // 地圖機制的欄位（含場上的道具）：先建出快照裡有、這邊還沒有的角色（召喚 / 放出來的），角色狀態才套得上
    this.mechanic.restore(this, s);
    this.applyEntities(s.entities);
  }

  // 勝者為王：戰鬥中選完牌，把新算的 carry（跟建場時同一個格式）套到場上的玩家角色 e 身上——
  // 上限（最大血量、體力）、速度、體型、mods、武器欄、連結對象、效果帶著走的狀態；血量照 carry（選牌回的血、加上限補的血），倒下的人不復活。
  // 伺服器與客戶端各套一次同一份（roundPicks 帶的 carry），位置之後照快照；也記進 this.carry（重連的人照它建一樣的角色）
  refit(e, c) {
    if (!e || !e.isPlayer || !c) return;
    this.carry[e.id] = c;
    e.maxHp = Math.max(1, c.maxHp - e.poisonLock);
    if (e.alive) e.hp = clamp(c.hp, 1, e.maxHp);
    e.maxStamina = c.maxStamina;
    e.stamina = Math.min(e.stamina, e.maxStamina);
    e.moveSpeed = c.moveSpeed;
    e.jumpSpeed = c.jumpSpeed;
    const size = clamp(c.size ?? 1, 0.5, 2);   // 同 Entity 建構子（玩家沒有自己的 hw / h，用預設的 9 / 30）
    e.hw = (CONFIG.PLAYER.hw ?? 9) * size;
    e.h = (CONFIG.PLAYER.h ?? 30) * size;
    e.mods = Object.assign({ ...Effects.DEFAULT_MODS }, c.mods || {});
    const ws = (c.weapons || []).filter(isEquippable).slice(0, CONFIG.EQUIP.maxWeapons);
    if (ws.length) e.weapons = ws;
    if (!e.weapons.includes(e.weapon)) e.weapon = e.weapons[0];
    e.links = (c.links || []).filter(id => id !== e.id && this.entities.some(f => f.id === id && f.team === e.team));
    Object.assign(e, Effects.carriedState(c));
  }
}

// 武器的 maxHits（無差別轟炸）怎麼數「同一隻」：好幾個部位的怪物（Entity.body）整隻一個，其他每個角色各一個
const hitKey = (e) => (e.body ? 'body:' + e.body : e.id);

// applyExplosion 的 opts.pick：這一下碰得到的人裡，每一隻只留這一波還剩下的次數（hitCount = 已經被打到幾次、max = 上限）。
// 一下就會超過的（例如一發同時波及巨蠍的兩個部位、只剩一次）先留直擊的、再留離爆炸點近的（一樣近照角色順序），其他的這一下碰不到
function capPick(hitCount, max) {
  return (reach) => {
    const left = new Map();
    const keep = new Set();
    const order = reach.map((r, i) => ({ r, i })).sort((a, b) => (b.r.direct - a.r.direct) || (a.r.d - b.r.d) || (a.i - b.i));
    for (const { r } of order) {
      const k = hitKey(r.e);
      const n = left.has(k) ? left.get(k) : max - (hitCount.get(k) || 0);
      if (n > 0) keep.add(r);
      left.set(k, n - 1);
    }
    return reach.filter(r => keep.has(r));
  };
}

// 第一顆飛行物最後停在哪（terrain / entity / water / out / range = 飛到最長路徑），給記錄與相容用。
// 迴力鏢看折返的地方（路上穿過的敵人不算停下來）
function summarizeHit(events) {
  const ev = events.find(e => e.p === 0 && ['explode', 'return', 'water', 'out', 'range', 'snatch'].includes(e.type));
  if (!ev) return { type: 'out', x: 0, y: 0, entityId: null };
  const type = ev.type === 'return' ? ev.on || 'terrain'
    : ev.type === 'water' || ev.type === 'out' || ev.type === 'range' || ev.type === 'snatch' ? ev.type : (ev.target ? 'entity' : 'terrain');
  return { type, x: ev.x, y: ev.y, entityId: ev.target || null };
}
