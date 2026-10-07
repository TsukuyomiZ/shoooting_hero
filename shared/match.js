import { CONFIG } from './config.js';
import { LEVELS } from './level.js';
import { Rng } from './rng.js';
import { Terrain } from './terrain.js';
import { Entity, poisonTick } from './entities.js';
import { launchVelocity, makeProjectile, hitAction, bounceProjectile, shotTraits, blastRadius } from './weapons.js';
import { runVolley } from './volley.js';
import { planShot } from './ai.js';
import { clamp } from './utils.js';
import { mechanicFor, snapshotOf } from './mechanics/index.js';
import * as Effects from './effects/index.js';
import { stageRules } from './stage-rules.js';

// 關卡 enemySpawns 的 type → config 裡的數值區塊（沒寫 type = 一般敵人 CONFIG.ENEMY）
const ENEMY_TYPES = { sniper: 'SNIPER', artillery: 'ARTILLERY' };
// 敵人種類的名字（type: 'random' 隨機抽到種類時，名字 = 這個 + 關卡給的 tag，例如「砲兵 B」）
export const ENEMY_LABELS = { normal: '敵人', sniper: '狙擊手', artillery: '砲兵' };

// 一場戰鬥（一關）的狀態與規則：地形、角色、回合順序、開火結算、勝負。
// 牌的效果（shared/effects/）只在這裡固定的槽與時間點貢獻數字 / 做事，怎麼組合、照什麼順序在這裡決定；Match 不認得任何一個效果。
// 不碰 DOM、不碰網路；伺服器拿它當唯一的真相，客戶端拿同一份程式播動畫。
// carry[playerId] = { hp, maxHp, maxStamina, moveSpeed, jumpSpeed, size, mods, weapons, …效果帶著走的狀態, links }：肉鴿流程中玩家帶著跑的數值
// config = 關卡規則讀的設定（見 shared/stage-rules.js；測試換自己的數字用，其他設定還是全域 CONFIG）
export class Match {
  constructor({ levelId = 'level1', players, seed, carry = {}, stage = 1, config = CONFIG }) {
    this.levelId = levelId;
    this.level = LEVELS[levelId];
    if (!this.level) throw new Error('unknown level: ' + levelId);
    // 這張地圖的地圖機制（見 shared/mechanics/）：Match 只在固定的時間點呼叫它的掛勾，不知道有哪些地圖
    this.mechanic = mechanicFor(this.level, levelId);
    this.seed = seed >>> 0;
    this.stage = stage;
    this.carry = carry;
    this.rng = new Rng(this.seed);
    this.terrain = new Terrain(CONFIG.WORLD_W, CONFIG.WORLD_H, this.level.polygons, {
      hard: this.level.hardPolygons, platforms: this.level.platforms, maxX: this.level.maxX, vines: this.level.vines,
    });
    this.entities = [];
    // 地圖機制的狀態（每場一份，含場上的道具）：機制的 build 建好回傳（見下面），之後由機制讀寫；Match 只存著不碰。
    // 一般小關 = null（見 shared/mechanics/index.js）
    this.mechState = null;
    this.pickups = [];  // 位置回報途中撿到的道具（fx），裁判拿去廣播（見 takePickups）
    // 關卡規則（見 shared/stage-rules.js）：這一關的血量倍率、敵人傷害倍率、狂熱。人數 = 開場的玩家人數（含之後倒下的隊友）
    this.rules = stageRules({ stage, players: players.length, pool: this.level.pool }, config);
    this.round = 0;     // 第幾輪：裁判在新的一輪開始時加一，客戶端照伺服器的訊息設；狂熱層數照這個算（見 fever）

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
        mods: c.mods || {}, weapons: c.weapons, size: c.size, ...Effects.carriedState(c), links: c.links,
      }));
    });
    // 攜手之伴的連結只認這一關真的有的隊友
    for (const e of this.entities) e.links = e.links.filter(id => id !== e.id && this.entities.some(f => f.id === id && f.team === e.team));

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
      this.entities.push(new Entity({
        ...def,
        id: `e${i + 1}`, name, team: 'enemies', controller: 'ai', slot: i, kind: type,
        x, y: s.y, facing: s.facing || -1, hp: Math.round(def.hp * hpScale), boss: !!s.boss,
      }));
    });
    // 地圖機制的角色排在關卡的敵人後面（陣列順序 = 回合順序）；回傳的是這一場機制的狀態
    this.mechState = this.mechanic.build(this, { hpScale, bossScale }) ?? null;

    this.settle(600);   // 開場先讓大家落地
    // 大家站好之後（例如 Boss 先決定第一招）。客戶端用同一個 seed 也會算一次，之後被伺服器的快照蓋掉
    this.mechanic.ready(this);
  }

  get world() {
    return { terrain: this.terrain, entities: this.entities, w: CONFIG.WORLD_W, h: CONFIG.WORLD_H };
  }
  get players() { return this.entities.filter(e => e.team === 'players'); }
  get enemies() { return this.entities.filter(e => e.team === 'enemies'); }
  byId(id) { return this.entities.find(e => e.id === id) || null; }

  result() {
    this.mechanic.cascade(this);   // 地圖機制連帶的死亡（例如古樹之眼倒下、包括回合結束被燒死 → 整棵樹枯萎）
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
  // 從上一個位置走到這裡的路上撿到的道具（地圖機制的 moved，例如巨蟒關的蛇血）記在 this.pickups 給裁判廣播
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
    const got = this.mechanic.moved(this, e, x0, y0, x, ny);   // 在落水檢查之前：走進水裡的那一段也撿得到
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

  // ---- 回合開始 / 結束（裁判呼叫） ----

  // 輪到 e：體力回滿、自己的回合數 +1
  beginTurn(e) {
    e.stamina = e.maxStamina;
    e.moveDir = 0;
    e.vineDir = 0;
    e.aiming = false;
    e.turnCount++;
    e.movedThisTurn = 0;
  }

  // 輪到 e 之後、開始計時之前（裁判呼叫）：有效果要出手（例如無差別轟炸）就回傳一個函式，
  // 呼叫它才結算那一波、回傳跟開火同樣格式的結果；沒有 = null
  turnBeginVolley(e) {
    return Effects.turnBegin(this, e);
  }

  // 無差別轟炸一次（不看有沒有這張牌）：舊的進入點，留給測試與工具直接呼叫；規則在 shared/effects/bombard.js
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
  // - 地圖機制的回合結束效果（例如巨蟒被燒到跨過門檻掉蛇血、古樹的嘴巴張開）
  // - 效果的回合結束（照 shared/effects/ 登記的順序：神佑之石給全隊無敵 → 時間扭曲給額外回合）。
  //   isExtra = 這是時間扭曲給的額外回合
  endTurn(e, isExtra = false) {
    const fx = [];
    if (!e.alive) return fx;
    this.burnTick(e, fx);
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
    return events.some(ev => ev.damages && ev.damages.some(d => !d.friendly));
  }

  // 受到的傷害 -N%（效果的 armor 槽，例如健壯藥丸類、團結力量大）；allies = 活著的隊友數
  armorOf(e, allies = this.alliesAlive(e)) {
    return Effects.effectSum('armor', e, { match: this, allies });
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

  // 攻擊者對某武器的傷害倍率（效果的加成）。敵人（含 Boss、樹妖、蜜蜂）照關卡規則的 enemyDamage。裝備產生的攻擊（轟炸）不吃武器傷害加成。
  // 效果的武器傷害 % 分三個槽、照這個順序相加：damage（自己的加成：所有武器 / 這把武器 → 每回合成長 → 擊殺累積）
  // → situation（看場上：這一關的暫時加成、隊友人數）→ state（看自己的狀態：狂熱、層數）
  damageMult(attacker, weapon) {
    if (!attacker || weapon.fromEquip) return 1;
    if (attacker.team === 'enemies') return this.rules.enemyDamage;
    const c = { match: this, weaponId: weapon.id, allies: this.alliesAlive(attacker) };
    const pct = (slot) => Effects.effectSum(slot, attacker, c);
    return Math.max(0, 1 + (pct('damage') + pct('damageSituation') + pct('damageState')) / 100);
  }
  explosionRadius(attacker, weapon) {
    return blastRadius(attacker, weapon);
  }

  // 爆炸 / 命中：傷害（同隊含自己 ×FRIENDLY_FIRE，再吃雙方的效果加成與狂熱）、燃燒、擊退。回傳傷害清單。
  // radius 0 的武器（迴力鏢）與 opts.directOnly（穿透）只打 directHit；opts.exclude 裡的角色不受影響。
  // 一個人要扣的傷害：武器傷害 × 距離 × 攻擊者的倍率與狂熱（× 誤傷）→ × 對首領 → × 減傷 → × 誤傷減傷 → 效果的 share（攜手之伴：
  // 先減再跟活著的連結對象平分，清單裡多一筆 shared = 被打的人）。
  // 先照這一下之前的場面算好每個人要扣多少（誰活著、誰有無敵、隊友幾個），再一起扣：
  // 同一發炸到好幾個人時，結果不會因為角色的排列順序（誰先加入房間）而不同
  applyExplosion(x, y, weapon, attacker, directHit, opts = {}) {
    const damages = [];
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

    // 1. 算好每個被打到的人要扣多少、要分多少給連結對象（還沒扣血）
    const hits = [];
    const later = [];   // 地圖機制要等大家都扣完血才做的事（例如蜂巢扣 1、放蜜蜂）
    for (const e of aliveBefore) {
      if (opts.exclude && opts.exclude.has(e)) continue;
      const direct = e === directHit;
      const d = e.distanceTo(x, y);
      if (!direct && (!splash || d > R)) continue;
      const factor = direct ? 1 : Math.max(0.3, 1 - d / R);
      const friendly = !!attacker && e.team === attacker.team;
      // 地圖機制自己處理的角色（例如古樹之口、蜂巢）：在無敵之前，不進一般的傷害、燃燒、擊退
      if (this.mechanic.absorbHit(this, e, { attacker, friendly, damages, later })) continue;
      if (shielded.has(e)) {   // 這一下完全無效，也不會被擊退、不會分給連結對象
        block(e);
        damages.push({ id: e.id, dmg: 0, friendly, blocked: true });
        continue;
      }
      let dmg = weapon.damage * factor * atk * (friendly ? CONFIG.FRIENDLY_FIRE : 1);
      if (e.boss && attacker) dmg *= Math.max(0, 1 + Effects.effectSum('damageBoss', attacker, { match: this, weaponId: weapon.id }) / 100);
      dmg *= Math.max(0, 1 - this.armorOf(e, alliesBefore(e)) / 100);
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
    for (const f of later) f();   // 這時候才出現的角色（蜜蜂）不會被這一下打到
    // 結算統計：打在敵方身上的傷害（含分給連結對象的份、地圖機制寫的那幾筆）算攻擊者造成的；誤傷不算
    if (attacker) for (const d of damages) if (!d.friendly) attacker.dealt += d.dmg;
    // 3. 燃燒、中毒、擊退（分到的份不會擊退、不會中毒）
    const poison = weapon.poison || 0;
    for (const { e, entry, factor } of hits) {
      if (burn > 0 && attacker && !entry.friendly && e.alive) {
        e.burn += burn;
        e.burnSource = attacker.id;
        entry.burn = burn;
      }
      if (poison > 0 && attacker && !entry.friendly && e.alive) {   // 有毒的攻擊（巨蟒、蜜蜂）：傷害 0 也照樣上毒
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
  lifesteal(attacker, damages, pct = attacker ? this.lifestealOf(attacker) : 0) {
    if (!attacker || !(pct > 0)) return 0;
    const dealt = damages.reduce((s, d) => s + (d.friendly ? 0 : d.dmg), 0);
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
      projs.push(p);
    }
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
    const specs = projs.map(p => ({ spawn: p.spawn, x: p.x, y: p.y, vx: p.vx, vy: p.vy, ...(p.follow ? { follow: true } : {}) }));
    const before = this.entities.filter(e => e.alive);
    const n0 = this.entities.length;
    // 飛行 → 沉降（shared/volley.js：跟客戶端重播同一個幀迴圈；撞到東西時呼叫下面的 resolveHit）
    const { events, flightFrames, settleFrames } = runVolley(this, owner, weapon, projs, burn);
    this.mechanic.cascade(this);   // 地圖機制連帶的死亡（這一發打倒了古樹之眼 → 嘴巴與樹妖一起枯萎）：要在算擊殺之前，也算擊殺
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
      kills, ...Effects.shotState(owner), ...(isShot ? { hitEnemy } : {}),
      results: this.entities.map(e => e.toState()),
      flightFrames, settleFrames,
    };
  }

  // 一顆飛行物撞到東西（shared/volley.js 的 runVolley 呼叫）：依規則爆炸 / 穿透 / 彈射 / 折返，結果寫成一個事件。
  // 飛行物的狀態（結束 / 回程）不在這裡改：runVolley 拿事件套用同一個狀態機（transition），客戶端重播也是那一份
  resolveHit(owner, weapon, p, i, hit, frame, burn) {
    const act = hitAction(p, hit);
    const ev = { f: frame, p: i, type: act === 'end' ? hit.type : act, x: hit.x, y: hit.y };
    const target = hit.type === 'entity' ? hit.entity : null;
    if (target) ev.target = target.id;
    const stealPct = this.lifestealOf(owner);   // 打中之前的場面（看隊友人數的吸血：這一下炸死隊友不算）
    let damages = null;
    switch (act) {
      case 'end':
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
      }
    }
    if (damages && damages.length) {
      ev.damages = damages;
      const heal = this.lifesteal(owner, damages, stealPct);
      if (heal > 0) ev.heal = heal;
      const ids = new Set(damages.map(d => d.id));
      if (heal > 0) ids.add(owner.id);
      ev.ents = this.entities.filter(e => ids.has(e.id)).map(e => e.toEventState());
      // 地圖機制附在事件上的（例如巨蟒掉的蛇血 drops、蜂巢飛出來的蜜蜂 bees）：客戶端在這一幀照著播（重播見 replayEvent）
      Object.assign(ev, this.mechanic.eventExtras(this));
    }
    return ev;
  }

  // AI 回合：先決定要不要走、走多久，再規劃一發。回傳 { walk, plan }；
  // 由地圖機制出招的角色（Boss、蜜蜂）不走也不開火，而是出招並直接結算好：回傳 { boss: { steps, next } }（見 mechanics/ 的 aiTurn）
  planAiTurn(actor) {
    const boss = this.mechanic.aiTurn(this, actor);
    if (boss) return { walk: null, plan: null, boss };
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
    // 地圖機制的欄位（含場上的道具）：先建出快照裡有、這邊還沒有的角色（召喚 / 放出來的），角色狀態才套得上
    this.mechanic.restore(this, s);
    this.applyEntities(s.entities);
  }
}

// 第一顆飛行物最後停在哪（terrain / entity / water / out），給記錄與相容用
function summarizeHit(events) {
  const ev = events.find(e => e.p === 0 && ['explode', 'return', 'water', 'out'].includes(e.type));
  if (!ev) return { type: 'out', x: 0, y: 0, entityId: null };
  const type = ev.type === 'water' || ev.type === 'out' ? ev.type : (ev.target ? 'entity' : 'terrain');
  return { type, x: ev.x, y: ev.y, entityId: ev.target || null };
}
