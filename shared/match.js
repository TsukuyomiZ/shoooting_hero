import { CONFIG } from './config.js';
import { LEVELS } from './level.js';
import { Rng } from './rng.js';
import { Terrain } from './terrain.js';
import { Entity } from './entities.js';
import { launchVelocity, advanceProjectile, makeProjectile, hitAction, bounceProjectile, stepReturn, shotTraits } from './weapons.js';
import { planShot } from './ai.js';
import { clamp } from './utils.js';
import { buildTree, spawnTreant, witherTree, resolveTreeTurn, reopenMouth, planTreeNext } from './tree-boss.js';
import { buildSnake, planSnakeNext, resolveSnakeTurn, poisonTick, snakeDrops, pickupAt, pickupAlong } from './snake-boss.js';
import { buildHive, hitHive, takeFreshBees, spawnBee, resolveBeeTurn } from './hive.js';

// 關卡 enemySpawns 的 type → config 裡的數值區塊（沒寫 type = 一般敵人 CONFIG.ENEMY）
const ENEMY_TYPES = { sniper: 'SNIPER', artillery: 'ARTILLERY' };
// 敵人種類的名字（type: 'random' 隨機抽到種類時，名字 = 這個 + 關卡給的 tag，例如「砲兵 B」）
export const ENEMY_LABELS = { normal: '敵人', sniper: '狙擊手', artillery: '砲兵' };

// 一場戰鬥（一關）的狀態與規則：地形、角色、回合順序、開火結算、裝備效果、勝負。
// 不碰 DOM、不碰網路；伺服器拿它當唯一的真相，客戶端拿同一份程式播動畫。
// carry[playerId] = { hp, maxHp, maxStamina, moveSpeed, jumpSpeed, size, mods, weapons, soulPct }：肉鴿流程中玩家帶著跑的數值
export class Match {
  constructor({ levelId = 'level1', players, seed, carry = {}, stage = 1 }) {
    this.levelId = levelId;
    this.level = LEVELS[levelId];
    if (!this.level) throw new Error('unknown level: ' + levelId);
    this.seed = seed >>> 0;
    this.stage = stage;
    this.carry = carry;
    this.rng = new Rng(this.seed);
    this.terrain = new Terrain(CONFIG.WORLD_W, CONFIG.WORLD_H, this.level.polygons, {
      hard: this.level.hardPolygons, platforms: this.level.platforms, maxX: this.level.maxX, vines: this.level.vines,
    });
    this.entities = [];
    this.tree = null;   // 古樹之庭的狀態（見 tree-boss.js）
    this.snake = null;  // 叢林巨蟒的狀態（見 snake-boss.js）
    this.hive = null;   // 小心擊發的蜂巢（見 hive.js）
    this.items = [];    // 場上的道具（巨蟒掉的蛇血）{ id, type, x, y }，y = 落在的地面
    this.pickups = [];  // 位置回報途中撿到的道具（fx），裁判拿去廣播（見 takePickups）
    this.fever = 0;     // 狂熱層數：裁判每輪開始時照輪數更新（見 feverStacks）
    this.playerCount = players.length;   // 這一關的玩家人數（含倒下的隊友）：狂熱幾輪一層照這個（敵人血量也照開場人數）

    players.forEach((p, i) => {
      const spawn = this.level.playerSpawns[i % this.level.playerSpawns.length];
      const c = carry[p.id] || {};
      this.entities.push(new Entity({
        ...CONFIG.PLAYER,
        id: p.id, name: p.name, team: 'players', controller: 'human', slot: i,
        color: CONFIG.PLAYER_COLORS[i % CONFIG.PLAYER_COLORS.length],
        x: spawn.x, y: spawn.y, facing: 1,
        hp: c.hp ?? CONFIG.PLAYER.hp, maxHp: c.maxHp ?? CONFIG.PLAYER.hp,
        stamina: c.maxStamina ?? CONFIG.PLAYER.stamina, maxStamina: c.maxStamina ?? CONFIG.PLAYER.stamina,
        moveSpeed: c.moveSpeed ?? CONFIG.PLAYER.moveSpeed, jumpSpeed: c.jumpSpeed ?? CONFIG.PLAYER.jumpSpeed,
        mods: c.mods || {}, weapons: c.weapons, size: c.size, soulPct: c.soulPct, links: c.links,
      }));
    });
    // 攜手之伴的連結只認這一關真的有的隊友
    for (const e of this.entities) e.links = e.links.filter(id => id !== e.id && this.entities.some(f => f.id === id && f.team === e.team));

    // 敵人血量：每多一位玩家 +50%，一般關卡每過一關再 +15%。Boss 關的血量照 TREE_BOSS / SNAKE_BOSS，吃人數放大與 bossStageScale
    const playerScale = 1 + CONFIG.ENEMY_HP_PER_EXTRA_PLAYER * Math.max(0, players.length - 1);
    const hpScale = playerScale * (1 + CONFIG.RUN.enemyHpPerStage * Math.max(0, stage - 1));
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
      this.entities.push(new Entity({
        ...def,
        id: `e${i + 1}`, name, team: 'enemies', controller: 'ai', slot: i, kind: type,
        x, y: s.y, facing: s.facing || -1, hp: Math.round(def.hp * hpScale), boss: !!s.boss,
      }));
    });
    const bossScale = playerScale * bossStageScale(this.level, stage);   // 第二個王關以後血量變多
    if (this.level.tree) buildTree(this, bossScale);
    if (this.level.snake) buildSnake(this, bossScale);
    if (this.level.hive) buildHive(this, hpScale);   // 蜂巢固定血量；放出來的蜜蜂跟一般敵人一樣放大

    this.settle(600);   // 開場先讓大家落地
    // 古樹之庭：大家站好之後先決定古樹的第一招（撞擊要照站位選平面）。客戶端用同一個 seed 也會算一次，之後被伺服器的快照蓋掉
    if (this.tree) planTreeNext(this, this.byId('eye'));
    if (this.snake) planSnakeNext(this);   // 叢林巨蟒：先抽第一招（抽到衝撞，第一個玩家回合就有警示帶）
  }

  get world() {
    return { terrain: this.terrain, entities: this.entities, w: CONFIG.WORLD_W, h: CONFIG.WORLD_H };
  }
  get players() { return this.entities.filter(e => e.team === 'players'); }
  get enemies() { return this.entities.filter(e => e.team === 'enemies'); }
  byId(id) { return this.entities.find(e => e.id === id) || null; }

  result() {
    witherTree(this);   // 古樹之眼倒下（包括回合結束被燒死）→ 整棵樹枯萎
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
    return this.entities.every(e => !e.alive || e.fixed || e.onVine >= 0 || (e.onGround && Math.abs(e.vx) < 2));
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

  // AI 走路：最多 maxFrames 幀，前方沒地面、沒體力、或掉進水裡（moveDir 被清掉）就停。回傳實際走了幾幀（客戶端照樣重播）。
  simulateWalk(e, dir, maxFrames) {
    let n = 0;
    e.moveDir = dir;
    while (n < maxFrames && e.moveDir === dir && e.stamina > 0 && e.canWalk(this.terrain, dir)) {
      const px = e.x, py = e.y;
      this.step();
      e.movedThisTurn += Math.hypot(e.x - px, e.y - py);
      n++;
    }
    e.moveDir = 0;
    return n;
  }

  // 玩家回報位置（客戶端對自己的移動有主導權，伺服器只做合理性檢查）。
  // 站得住的位置記成「最後站穩的地方」；回報在水裡 = 自己走 / 跳進水裡 → 落水（扣血、回到岸上，或淹死）。
  // safe = 客戶端記的最後站穩的地方（落水那次回報才帶）：站得住、離得不遠就採用，重生點才會跟他畫面上的一樣。
  // vine = 回報說抓著第幾條藤蔓（-1 = 沒有）：位置真的掛得上去才算，不然當成在半空中（超時就會掉下去）。
  // 從上一個位置走到這裡的路上碰到蛇血（有被中毒鎖住的上限、或血沒滿才會撿）就喝掉，記在 this.pickups 給裁判廣播
  setPlayerPosition(e, x, y, facing, stamina, safe = null, vine = -1) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < e.hw || x > this.terrain.maxX - e.hw || y < 0 || y > CONFIG.WORLD_H) return false;
    if (Math.hypot(x - e.x, y - e.y) > 400) return false;   // 不准瞬移
    let ny = y;
    // 在水裡的回報不檢查卡進地形：沿著斜的崖壁掉下去時身體會擦進牆裡一點（直落只檢查腳下），反正馬上就回到岸上
    if (ny <= CONFIG.WATER_LEVEL && e.collides(this.terrain, x, ny)) {
      let ok = false;
      for (let up = 1; up <= 8; up++) {
        if (!e.collides(this.terrain, x, ny - up)) { ny -= up; ok = true; break; }
      }
      if (!ok) return false;
    }
    e.movedThisTurn += Math.hypot(x - e.x, ny - e.y);   // 移動可以甩掉燃燒層數
    const x0 = e.x, y0 = e.y;
    e.x = x;
    e.y = ny;
    e.vx = 0;
    e.vy = 0;
    if (facing === 1 || facing === -1) e.facing = facing;
    if (Number.isFinite(stamina)) e.stamina = clamp(stamina, 0, e.stamina);   // 只能減不能加
    e.onVine = Number.isInteger(vine) && vine >= 0 && ny <= CONFIG.WATER_LEVEL && e.canHangAt(this.terrain, vine, x, ny) ? vine : -1;
    const got = pickupAlong(this, e, x0, y0, x, ny);
    if (got) this.pickups.push(got);
    if (ny > CONFIG.WATER_LEVEL) {
      if (safe && Number.isFinite(safe.x) && Number.isFinite(safe.y) && Math.hypot(safe.x - x, safe.y - ny) <= 400 &&
          e.canStandAt(this.terrain, safe.x, safe.y)) {
        e.safeX = safe.x;
        e.safeY = safe.y;
      }
      e.fallInWater(this.terrain);
    } else if (e.canStandAt(this.terrain, x, ny)) {
      e.safeX = x;
      e.safeY = ny;
    }
    return true;
  }

  // 位置回報途中撿到的道具（fx），拿出來就清掉
  takePickups() {
    const out = this.pickups;
    this.pickups = [];
    return out;
  }

  // ---- 回合開始 / 結束的裝備效果（裁判呼叫） ----

  // 輪到 e：體力回滿、自己的回合數 +1
  beginTurn(e) {
    e.stamina = e.maxStamina;
    e.moveDir = 0;
    e.vineDir = 0;
    e.aiming = false;
    e.turnCount++;
    e.movedThisTurn = 0;
  }

  // 自己的回合開始時（轟炸之後、開始計時之前）：中毒結算（可能被毒倒）→ 站在蛇血上就喝掉 → 恩賜之杖回血。
  // 回傳 fx 清單給客戶端飄字
  turnStartEffects(e) {
    const fx = [];
    const poison = poisonTick(e);
    if (poison) fx.push(poison);
    const drink = pickupAt(this, e);
    if (drink) fx.push(drink);
    if (e.alive && e.mods.regenPct > 0) {
      const n = this.heal(e, e.maxHp * e.mods.regenPct / 100);
      if (n > 0) fx.push({ type: 'heal', id: e.id, amount: n });
    }
    return fx;
  }

  // 自己的回合結束時：
  // - 燃燒：先用這回合移動的距離甩掉層數（每回合最多 maxReducePerTurn 層），剩下的每層扣最大血量 pctPerStack%
  // - 神佑之石：每過 shieldEveryTurns 個自己的回合，全隊獲得無敵
  // - 時間扭曲：普通回合結束時冷卻好了就給一個額外回合（fx 裡的 extraTurn），之後冷卻 extraTurnCooldown 個普通回合。
  //   額外回合（isExtra）本身不算冷卻、也不能再接額外回合
  endTurn(e, isExtra = false) {
    const fx = [];
    if (!e.alive) return fx;
    this.burnTick(e, fx);
    const drops = snakeDrops(this);   // 巨蟒被燒到跨過門檻也會掉蛇血
    if (drops.length) fx.push({ type: 'drops', id: e.id, items: drops });
    // 古樹（眼睛）的回合結束：被打到閉上的嘴巴撐過了這個回合，再張開（已經分出勝負就不播）
    if (e.part === 'eye' && e.alive && !this.result()) reopenMouth(this, fx);
    if (e.mods.teamShield > 0 && e.turnCount % CONFIG.EQUIP.shieldEveryTurns === 0) {
      const ids = [];
      for (const f of this.entities) {
        if (f.alive && f.team === e.team) { f.shield = Math.max(f.shield, e.mods.teamShield); ids.push(f.id); }
      }
      fx.push({ type: 'shield', id: e.id, ids });
    }
    if (e.mods.extraTurn > 0 && e.alive && !isExtra && !this.result()) {   // 這一發已經分出勝負就不給（不會有下一回合）
      if (e.extraTurnCd > 0) {
        e.extraTurnCd--;
      } else {
        e.extraTurnCd = CONFIG.EQUIP.extraTurnCooldown;
        fx.push({ type: 'extraTurn', id: e.id });
      }
    }
    return fx;
  }

  // 燃燒結算（回合結束時）：先用這回合移動的距離甩掉層數，剩下的每層扣最大血量 pctPerStack%；燒死算點火的人的擊殺
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
    if (src && this.creditKills(src, [e]).length && src.mods.killDamagePct > 0) {
      fx.push({ type: 'soul', id: src.id, soul: src.soulPct });
    }
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

  // 狂戰之斧：自己的第 N 回合 +rampDamagePct × N %，最多 rampDamageMaxPct
  rampBonus(e) {
    const m = e.mods;
    if (!(m.rampDamagePct > 0)) return 0;
    const v = m.rampDamagePct * e.turnCount;
    return m.rampDamageMaxPct > 0 ? Math.min(m.rampDamageMaxPct, v) : v;
  }

  // 狂熱：所有傷害的倍率（不分敵我、不分攻擊來源）
  feverMult() {
    return 1 + this.fever * CONFIG.FEVER.damagePct / 100;
  }

  // 這一關第 round 輪的狂熱層數（幾輪一層看這一關的玩家人數）。Boss 關有自己的機制，不套用狂熱（除非 FEVER.inBoss 打開）
  feverAt(round) {
    if (this.level.pool === 'boss' && !CONFIG.FEVER.inBoss) return 0;
    return feverStacks(round, this.playerCount);
  }

  // 場上還活著的隊友有幾個（不含自己）：孤狼傳說、團結力量大看這個
  alliesAlive(e) {
    return this.entities.reduce((n, f) => n + (f !== e && f.alive && f.team === e.team ? 1 : 0), 0);
  }

  // 看場上情況的武器傷害加成 %：腎上腺素（只在這一關）、孤狼傳說（沒有活著的隊友）、團結力量大（每個活著的隊友）
  situationalDamagePct(e, allies = this.alliesAlive(e)) {
    const m = e.mods;
    return m.stageDamagePct + (allies === 0 ? m.loneDamagePct : 0) + allies * m.allyDamagePct;
  }

  // 看自己狀態的武器傷害加成 %：嗨到最高點（狂熱生效中）、磨刀霍霍（準備層數）、越戰越強（狂獵層數）
  stateDamagePct(e) {
    const m = e.mods;
    return (this.fever > 0 ? m.feverDamagePct : 0) + e.readyStacks * m.missDamagePct + e.huntStacks * m.hitDamagePct;
  }

  // 一次射擊結算完：有沒有打中敵人（直擊或波及到敵方都算，傷害 0 也算，例如閉上的古樹之口）。
  // 磨刀霍霍：沒打中 +1 層準備（最多 missMaxStacks）、打中歸零；越戰越強：打中 +1 層狂獵（最多 hitMaxStacks）、沒打中歸零
  updateShotStacks(e, events) {
    const hit = events.some(ev => ev.damages && ev.damages.some(d => !d.friendly));
    const m = e.mods;
    if (m.missDamagePct > 0) e.readyStacks = hit ? 0 : Math.min(m.missMaxStacks, e.readyStacks + 1);
    if (m.hitDamagePct > 0) e.huntStacks = hit ? Math.min(m.hitMaxStacks, e.huntStacks + 1) : 0;
    return hit;
  }

  // 受到的傷害 -N%：健壯藥丸類 + 團結力量大（每個活著的隊友，只算自己）
  armorPct(e, allies = this.alliesAlive(e)) {
    return e.mods.armorPct + allies * e.mods.allyArmorPct;
  }

  // 傷害吸血 %：血之爪類 + 孤狼傳說（沒有活著的隊友時）
  lifestealPct(e, allies = this.alliesAlive(e)) {
    return e.mods.lifestealPct + (allies === 0 ? e.mods.loneLifestealPct : 0);
  }

  // 攜手之伴：e 現在跟哪些活著的隊友連結著
  linkPartners(e) {
    const out = [];
    for (const id of e.links) {
      const q = this.byId(id);
      if (q && q.alive && q !== e) out.push(q);
    }
    return out;
  }

  // 敵人（含 Boss、樹妖、蜜蜂）的傷害倍率：第一輪 ENEMY.damageMult（0.7），第二輪（第 ENEMY.lateFromStage 關起）ENEMY.damageMultLate（1）
  enemyDamageMult() {
    const E = CONFIG.ENEMY;
    return E.lateFromStage > 0 && this.stage >= E.lateFromStage ? (E.damageMultLate ?? E.damageMult) : E.damageMult;
  }

  // 攻擊者對某武器的傷害倍率（牌的加成）。裝備產生的攻擊（轟炸）不吃武器傷害加成
  damageMult(attacker, weapon) {
    if (!attacker || weapon.fromEquip) return 1;
    if (attacker.team === 'enemies') return this.enemyDamageMult();
    const m = attacker.mods;
    const per = weapon.id === 'cannon' ? m.cannonDamagePct : weapon.id === 'sniper' ? m.sniperDamagePct : 0;
    return Math.max(0, 1 + (m.damagePct + per + this.rampBonus(attacker) + attacker.soulPct
      + this.situationalDamagePct(attacker) + this.stateDamagePct(attacker)) / 100);
  }
  explosionRadius(attacker, weapon) {
    const pct = attacker && weapon.id === 'cannon' ? attacker.mods.radiusPct : 0;
    return weapon.radius * Math.max(0.2, 1 + pct / 100);
  }

  // 爆炸 / 命中：傷害（同隊含自己 ×FRIENDLY_FIRE，再吃雙方的牌加成與狂熱）、燃燒、擊退。回傳傷害清單。
  // radius 0 的武器（迴力鏢）與 opts.directOnly（穿透）只打 directHit；opts.exclude 裡的角色不受影響。
  // 有「連結」（攜手之伴）的人：傷害先減 link.damageCutPct%，再跟活著的連結對象平分（清單裡多一筆 shared = 被打的人）。
  // 先照這一下之前的場面算好每個人要扣多少（誰活著、誰有無敵、隊友幾個），再一起扣：
  // 同一發炸到好幾個人時，結果不會因為角色的排列順序（誰先加入房間）而不同
  applyExplosion(x, y, weapon, attacker, directHit, opts = {}) {
    const damages = [];
    const radius = this.explosionRadius(attacker, weapon);
    const R = radius + 6;
    const splash = radius > 0 && !opts.directOnly;
    const atk = this.damageMult(attacker, weapon) * this.feverMult();
    const kbMult = attacker ? Math.max(0, 1 + attacker.mods.knockbackPct / 100) : 1;
    const burn = opts.burn || 0;
    const cut = Math.max(0, 1 - CONFIG.EQUIP.link.damageCutPct / 100);
    const aliveBefore = this.entities.filter(e => e.alive);
    const alive0 = new Set(aliveBefore);
    const alliesBefore = (e) => aliveBefore.reduce((n, f) => n + (f !== e && f.team === e.team ? 1 : 0), 0);
    // 神佑之石：爆炸前有無敵的人，這一下（自己被打到、分到隊友的份）全部擋掉，無敵只用掉一次
    const shielded = new Set(aliveBefore.filter(e => e.shield > 0));
    const spent = new Set();
    const block = (e) => { if (!spent.has(e)) { spent.add(e); e.shield--; } };

    // 1. 算好每個被打到的人要扣多少、要分多少給連結對象（還沒扣血）
    const hits = [];
    const hiveHits = [];   // 蜂巢：先記下來，等大家都扣完血才扣 1、放蜜蜂
    for (const e of aliveBefore) {
      if (opts.exclude && opts.exclude.has(e)) continue;
      const direct = e === directHit;
      const d = e.distanceTo(x, y);
      if (!direct && (!splash || d > R)) continue;
      const factor = direct ? 1 : Math.max(0.3, 1 - d / R);
      const friendly = !!attacker && e.team === attacker.team;
      if (e.closeOnHit) {   // 古樹之口：打不壞、不會燒，被敵方打到（直擊或波及）就閉上，撐過 closeOnHit 個古樹回合才張開
        if (!friendly) {
          e.closedTurns = e.closeOnHit;
          e.hurtTimer = 0.35;
          damages.push({ id: e.id, dmg: 0, friendly, closed: true });
        }
        continue;
      }
      if (e.kind === 'hive') {   // 蜂巢：只有玩家方打得到；不管什麼武器、直擊或波及都只扣 1，每次放出一隻蜜蜂（見 hive.js）
        if (attacker && !friendly) {
          const entry = { id: e.id, dmg: 0, friendly, hive: true };
          damages.push(entry);
          hiveHits.push({ e, entry });
        }
        continue;
      }
      if (shielded.has(e)) {   // 這一下完全無效，也不會被擊退、不會分給連結對象
        block(e);
        damages.push({ id: e.id, dmg: 0, friendly, blocked: true });
        continue;
      }
      let dmg = weapon.damage * factor * atk * (friendly ? CONFIG.FRIENDLY_FIRE : 1);
      if (e.boss && attacker) dmg *= Math.max(0, 1 + attacker.mods.bossDamagePct / 100);
      dmg *= Math.max(0, 1 - this.armorPct(e, alliesBefore(e)) / 100);
      if (friendly) dmg *= Math.max(0, 1 - e.mods.friendlyArmorPct / 100);
      const entry = { id: e.id, dmg: 0, friendly };
      damages.push(entry);
      const hit = { e, entry, own: dmg, shares: [], factor };
      const partners = this.linkPartners(e).filter(q => alive0.has(q));
      if (partners.length) {
        // 攜手之伴：減傷後取整，每個連結對象分到一樣多，除不盡的餘數算被打的人的；分到 0 就不用分
        const total = Math.round(dmg * cut);
        const each = Math.floor(total / (partners.length + 1));
        hit.own = total - each * partners.length;
        if (each > 0) {
          for (const q of partners) {
            const s = { id: q.id, dmg: 0, friendly, shared: e.id };
            damages.push(s);
            if (shielded.has(q)) { block(q); s.blocked = true; }   // 分到的那份一樣會被神佑之石擋下
            else hit.shares.push({ q, entry: s, amount: each });
          }
        }
      }
      hits.push(hit);
    }
    // 2. 扣血（每個人最後扣的總數跟順序無關，扣到 0 就倒下）
    for (const h of hits) {
      h.entry.dmg = h.e.takeDamage(h.own);
      for (const s of h.shares) s.entry.dmg = s.q.takeDamage(s.amount);
    }
    for (const h of hiveHits) h.entry.dmg = hitHive(this, h.e);   // 新的蜜蜂在這一下之後才出現，不會被這一下打到
    // 結算統計：打在敵方身上的傷害（含分給連結對象的份、蜂巢）算攻擊者造成的；誤傷不算
    if (attacker) for (const d of damages) if (!d.friendly) attacker.dealt += d.dmg;
    // 3. 燃燒、中毒、擊退（分到的份不會擊退、不會中毒）
    const poison = weapon.poison || 0;
    for (const { e, entry, factor } of hits) {
      if (burn > 0 && attacker && !entry.friendly && e.alive) {
        e.burn += burn;
        e.burnSource = attacker.id;
        entry.burn = burn;
      }
      if (poison > 0 && attacker && !entry.friendly && e.alive) {   // 叢林巨蟒的攻擊：傷害 0 也照樣上毒
        e.poison += poison;
        entry.poison = poison;
      }
      // 擊退：只用開根號，避免三角函數在不同引擎上有微小差異。knockDir = 固定方向（大地震擊往巨蟒那邊甩）
      const kb = weapon.knockback * factor * kbMult * (e.boss ? 0.3 : 1);
      if (kb <= 0 || e.fixed) continue;   // 古樹的部位長在樹上、巨蟒的頭不會動，不會被擊退
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
      e.vx += ux * kb;
      e.vy = Math.min(e.vy, 0) - Math.abs(uy) * kb * 0.6 - kb * 0.35;
      e.onGround = false;
      e.letGoVine();   // 抓著藤蔓的人被打下來
    }
    return damages;
  }

  // 吸血：這一下對敵人造成的傷害 × 吸血 %（pct 預設照現在的場面算；開火結算傳入打中之前的，孤狼傳說才不會被這一下改變）
  lifesteal(attacker, damages, pct = attacker ? this.lifestealPct(attacker) : 0) {
    if (!attacker || !(pct > 0)) return 0;
    const dealt = damages.reduce((s, d) => s + (d.friendly ? 0 : d.dmg), 0);
    return dealt > 0 ? this.heal(attacker, dealt * pct / 100) : 0;
  }

  // before 裡現在死掉的敵人算攻擊者的擊殺；噬魂者每殺一個武器傷害 +killDamagePct%（整場冒險累積）
  creditKills(attacker, before) {
    const killed = before.filter(e => !e.alive && e.team !== attacker.team && e.kind !== 'hive');   // 打掉蜂巢不算擊殺（不是活的）
    attacker.kills += killed.length;
    if (killed.length && attacker.mods.killDamagePct > 0) attacker.soulPct += killed.length * attacker.mods.killDamagePct;
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
      const traits = shotTraits(actor, weapon.id);   // 哈哈子彈 / 蹦蹦炸彈的彈射、高倍率望遠鏡的穿透
      p.bouncesLeft = traits.bounces;
      if (traits.pierce) p.pierce = true;
      projs.push(p);
    }
    const burn = actor.mods.burnStacks + (weapon.id === 'cannon' ? actor.mods.cannonBurnStacks : 0);
    return {
      kind: 'weapon', actorId: actor.id, weapon: weaponId, angle, power, facing: actor.facing,
      actor: actorPos,
      ...this.resolveVolley(actor, weapon, projs, burn, true),
    };
  }

  // 無差別轟炸：持有者附近以外，整張地圖每隔 spacing 落下一發飛彈（由近到遠）。
  // 會波及隊友（照一般誤傷規則），但炸不到持有者自己
  resolveBombard(owner) {
    const weapon = CONFIG.WEAPONS.bombard;
    const B = CONFIG.EQUIP.bombard;
    const xs = [];
    for (let x = B.spacing / 2; x < CONFIG.WORLD_W; x += B.spacing) {
      const jx = x + this.rng.range(-B.jitter, B.jitter);
      if (Math.abs(jx - owner.x) >= B.safeDist) xs.push(jx);
    }
    xs.sort((a, b) => Math.abs(a - owner.x) - Math.abs(b - owner.x));
    const projs = xs.map((x, k) => {
      const p = makeProjectile(owner, weapon, x, B.startY, 0, weapon.speed);
      p.spawn = 1 + k * B.gapFrames;
      p.ignore.add(owner);
      return p;
    });
    return { kind: 'bombard', actorId: owner.id, weapon: weapon.id, ...this.resolveVolley(owner, weapon, projs, 0) };
  }

  // isShot = 自己開的一槍（轟炸、Boss 招式不算）：結算完更新磨刀霍霍 / 越戰越強的層數，results 帶的是更新後的
  resolveVolley(owner, weapon, projs, burn, isShot = false) {
    const specs = projs.map(p => ({ spawn: p.spawn, x: p.x, y: p.y, vx: p.vx, vy: p.vy, ...(p.follow ? { follow: true } : {}) }));
    const before = this.entities.filter(e => e.alive);
    const n0 = this.entities.length;
    const { events, frames } = this.runVolley(owner, weapon, projs, burn);
    const settleFrames = this.settle(360);
    witherTree(this);   // 這一發打倒了古樹之眼 → 嘴巴與樹妖一起枯萎（也算擊殺）
    // 這一發途中才出現的角色（打到蜂巢飛出來的蜜蜂）被同一發後面的砲彈打死，也算擊殺
    const kills = this.creditKills(owner, [...before, ...this.entities.slice(n0)]);
    const hitEnemy = isShot ? this.updateShotStacks(owner, events) : undefined;
    if (isShot) {   // 結算畫面的命中率：一槍（不管幾顆砲彈）算一次，命中的定義同越戰越強
      owner.shots++;
      if (hitEnemy) owner.hits++;
    }
    return {
      projectiles: specs, events, hit: summarizeHit(events),
      kills, soul: owner.soulPct, ...(isShot ? { hitEnemy } : {}),
      results: this.entities.map(e => e.toState()),
      flightFrames: frames, settleFrames,
    };
  }

  // 一波飛行物（可能好幾顆、各自在不同幀出發）逐幀模擬到全部結束。
  // 每一幀先跑角色物理（被前一發炸飛的人會繼續飛），再依序推進每顆飛行物，撞到東西照 hitAction 處理並記成事件。
  // 客戶端用一樣的順序重播：飛行只跑運動學，撞擊的結果全部照事件套用，所以不會跟伺服器分歧。
  runVolley(owner, weapon, projs, burn) {
    const dt = CONFIG.FIXED_DT;
    const maxFrames = Math.round(CONFIG.TIMING.maxShotSeconds * 60);
    const events = [];
    for (const p of projs) p.state = 'pending';
    let frame = 0;
    while (frame < maxFrames && projs.some(p => p.state !== 'done')) {
      frame++;
      this.step(dt);
      for (let i = 0; i < projs.length; i++) {
        const p = projs[i];
        if (p.state === 'pending' && p.spawn === frame) {
          p.state = 'flying';
          if (p.follow && owner.alive) { const mz = owner.muzzle(); p.x = mz.x; p.y = mz.y; }
          if (p.boomerang) p.path = [{ x: p.x, y: p.y }];
        }
        if (p.state === 'returning') {
          if (stepReturn(p, weapon.returnSpeed || 1, owner.alive ? owner.muzzle() : null, weapon.homingSpeed)) {
            p.state = 'done';
            events.push({ f: frame, p: i, type: 'catch', x: p.x, y: p.y });
          }
          continue;
        }
        if (p.state !== 'flying') continue;
        const hit = advanceProjectile(this.world, p, dt);
        if (!hit) {
          if (p.path) p.path.push({ x: p.x, y: p.y });
          continue;
        }
        events.push(this.resolveHit(owner, weapon, p, i, hit, frame, burn));
      }
    }
    // 超時還沒結束的視為飛出場外
    projs.forEach((p, i) => {
      if (p.state === 'flying' || p.state === 'returning') events.push({ f: frame, p: i, type: 'out', x: p.x, y: p.y });
      p.state = 'done';
    });
    return { events, frames: frame };
  }

  // 一顆飛行物撞到東西：依規則爆炸 / 穿透 / 彈射 / 折返，結果寫成一個事件
  resolveHit(owner, weapon, p, i, hit, frame, burn) {
    const act = hitAction(p, hit);
    const ev = { f: frame, p: i, type: act === 'end' ? hit.type : act, x: hit.x, y: hit.y };
    const target = hit.type === 'entity' ? hit.entity : null;
    if (target) ev.target = target.id;
    const lifestealPct = this.lifestealPct(owner);   // 打中之前的場面（孤狼傳說：這一下炸死隊友不算）
    let damages = null;
    switch (act) {
      case 'end':
        p.state = 'done';
        break;
      case 'bounce':
        bounceProjectile(this.terrain, p, hit);
        Object.assign(ev, { x: p.x, y: p.y, vx: p.vx, vy: p.vy });
        break;
      case 'pierce':
        p.ignore.add(target);
        damages = this.applyExplosion(hit.x, hit.y, weapon, owner, target, { directOnly: true, burn });
        Object.assign(ev, { vx: p.vx, vy: p.vy });
        break;
      case 'return':   // 迴力鏢：打到角色就結算傷害，打到地形沒事，接著沿原路飛回去
        if (target) damages = this.applyExplosion(hit.x, hit.y, weapon, owner, target, { directOnly: true, burn });
        p.state = 'returning';
        p.retIdx = p.path.length;
        break;
      default: {       // explode
        const r = this.explosionRadius(owner, weapon);
        if (r > 0) {
          ev.carve = { x: hit.x, y: hit.y, r };
          this.terrain.carve(hit.x, hit.y, r);
        }
        damages = this.applyExplosion(hit.x, hit.y, weapon, owner, target, { burn, exclude: p.ignore });
        // 毒液噴灑：同一次噴灑的毒液共用 ignore，打中過的人其他顆就穿過去（每人最多中一次）
        if (target && weapon.shareHits) p.ignore.add(target);
        p.state = 'done';
      }
    }
    if (damages && damages.length) {
      ev.damages = damages;
      const heal = this.lifesteal(owner, damages, lifestealPct);
      if (heal > 0) ev.heal = heal;
      const ids = new Set(damages.map(d => d.id));
      if (heal > 0) ids.add(owner.id);
      ev.ents = this.entities.filter(e => ids.has(e.id)).map(e => e.toEventState());
      const drops = snakeDrops(this);   // 打到巨蟒跨過門檻：掉蛇血（客戶端在這一幀播出來）
      if (drops.length) ev.drops = drops;
      const bees = takeFreshBees(this);   // 打到蜂巢：飛出來的蜜蜂（客戶端在這一幀照出生資料建出來）
      if (bees.length) ev.bees = bees;
    }
    return ev;
  }

  // AI 回合：先決定要不要走、走多久，再規劃一發。回傳 { walk, plan }；
  // 古樹之眼不走也不開火，而是出預定的招式並直接結算好：回傳 { boss: { steps, next } }（見 tree-boss.js 的 resolveTreeTurn）；
  // 叢林巨蟒、蜜蜂也一樣（見 snake-boss.js 的 resolveSnakeTurn、hive.js 的 resolveBeeTurn）
  planAiTurn(actor) {
    if (actor.part === 'eye') return { walk: null, plan: null, boss: resolveTreeTurn(this, actor) };
    if (actor.part === 'snake') return { walk: null, plan: null, boss: resolveSnakeTurn(this, actor) };
    if (actor.kind === 'bee') return { walk: null, plan: null, boss: resolveBeeTurn(this, actor) };
    let walk = null;
    if (this.rng.chance((actor.ai || CONFIG.ENEMY).moveChance)) {
      const dir = this.rng.chance(0.5) ? -1 : 1;
      const d = actor.canWalk(this.terrain, dir) ? dir : (actor.canWalk(this.terrain, -dir) ? -dir : 0);
      if (d !== 0) {
        const frames = this.simulateWalk(actor, d, this.rng.int(18, 60));
        if (frames > 0) walk = { dir: d, frames };
      }
    }
    const plan = planShot(this.world, actor, this.rng);
    return { walk, plan };
  }

  // ---- 同步 ----
  snapshot() {
    return {
      entities: this.entities.map(e => e.toState()),
      holes: this.terrain.holes.map(h => ({ x: h.x, y: h.y, r: h.r })),
      minions: this.tree ? this.tree.minions.slice() : [],   // 召喚出來的樹妖（重連時先照這個重建，再套狀態）
      treeNext: this.tree && this.tree.next ? { ...this.tree.next } : null,   // 古樹預定的下一招（客戶端照這個畫撞擊的預告）
      snakeNext: this.snake && this.snake.next ? { ...this.snake.next } : null,   // 巨蟒預定的下一招（衝撞要畫警示帶）
      items: this.items.map(it => ({ ...it })),   // 場上的蛇血
      bees: this.hive ? this.hive.bees.map(b => ({ ...b })) : [],   // 蜂巢放出來過的蜜蜂（重連時先照這個重建，再套狀態）
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
    for (const spec of s.minions || []) if (!this.byId(spec.id)) spawnTreant(this, spec);
    for (const spec of s.bees || []) if (!this.byId(spec.id)) spawnBee(this, spec);
    if (this.tree && s.treeNext !== undefined) this.tree.next = s.treeNext ? { ...s.treeNext } : null;
    if (this.snake && s.snakeNext !== undefined) this.snake.next = s.snakeNext ? { ...s.snakeNext } : null;
    if (s.items) this.items = s.items.map(it => ({ ...it }));
    this.applyEntities(s.entities);
  }
}

// Boss 關的血量倍率（不含人數）：從第一個 Boss 關開始算，之後每多一關 +RUN.bossHpPerStage
// （bossStages [5, 10]、15%：第 5 關 ×1、第 10 關 ×1.75）。不是排定的 Boss 關（測試直接建的 Boss 地圖）就照原本的血量
export function bossStageScale(level, stage) {
  const B = CONFIG.RUN.bossStages || [];
  if (level.pool !== 'boss' || !B.includes(stage)) return 1;
  return 1 + (CONFIG.RUN.bossHpPerStage || 0) * Math.max(0, stage - Math.min(...B));
}

// 狂熱：players 人的關卡每幾輪疊一層。FEVER.everyRounds 是一個數字（不分人數），或 { 人數: 輪數 }
// （表上沒有的人數照比它少、最接近的那一格；比表上都少就用最少人數那格）。0 = 關掉
export function feverEvery(players = 1) {
  const e = CONFIG.FEVER.everyRounds;
  if (typeof e === 'number') return e;
  const keys = Object.keys(e || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!keys.length) return 0;
  const k = keys.filter(n => n <= players).pop() ?? keys[0];
  return Number(e[k]) || 0;
}

// 狂熱：players 人的關卡第 round 輪時疊了幾層（每過 n = feverEvery(players) 輪 +1 層，第 1 ~ n 輪是 0 層）
export function feverStacks(round, players = 1) {
  const n = feverEvery(players);
  return n > 0 ? Math.max(0, Math.floor((round - 1) / n)) : 0;
}

// 第一顆飛行物最後停在哪（terrain / entity / water / out），給記錄與相容用
function summarizeHit(events) {
  const ev = events.find(e => e.p === 0 && ['explode', 'return', 'water', 'out'].includes(e.type));
  if (!ev) return { type: 'out', x: 0, y: 0, entityId: null };
  const type = ev.type === 'water' || ev.type === 'out' ? ev.type : (ev.target ? 'entity' : 'terrain');
  return { type, x: ev.x, y: ev.y, entityId: ev.target || null };
}
