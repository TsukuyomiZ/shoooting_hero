import { CONFIG } from './config.js';
import { clamp } from './utils.js';
import { isEquippable } from './weapons.js';

// 戰鬥中用到的牌加成（% 或次數）。玩家的值由牌算出來（見 cards.js），敵人全部是 0
export const DEFAULT_MODS = {
  damagePct: 0, cannonDamagePct: 0, sniperDamagePct: 0, bossDamagePct: 0,
  rampDamagePct: 0, rampDamageMaxPct: 0, killDamagePct: 0, lifestealPct: 0,
  radiusPct: 0, knockbackPct: 0, sniperBounce: 0, sniperPierce: 0, cannonBounce: 0,
  burnStacks: 0, cannonBurnStacks: 0,
  armorPct: 0, friendlyArmorPct: 0, regenPct: 0, turnTime: 0,
  bombard: 0, teamShield: 0, extraJumps: 0, extraTurn: 0,
  loneDamagePct: 0, loneLifestealPct: 0, allyDamagePct: 0, allyArmorPct: 0,
  feverDamagePct: 0, fullArc: 0,
  missDamagePct: 0, missMaxStacks: 0, hitDamagePct: 0, hitMaxStacks: 0,
  stageDamagePct: 0,   // 只在這一關有效的武器傷害加成（腎上腺素），由肉鴿流程每關重新給
};

// 藤蔓：抓著的時候「手」在身體最上面往下 VINE_HAND px 的地方，手要在藤蔓的 top ~ bottom 之間
export const VINE_HAND = 4;
const VINE_REACH = 4;      // 身體邊緣離藤蔓多近就抓得到
const VINE_REGRAB = 15;    // 放手 / 從藤蔓上跳開後，幾幀內不會再抓（不然按著 W 一跳開又馬上抓回去）

// 玩家與敵人共用的角色類別。(x, y) 是腳底中心點。
// 物理只用加減乘除與比較，所以伺服器與所有客戶端跑出來的結果一致。
export class Entity {
  constructor(o) {
    this.id = o.id;
    this.name = o.name;
    this.team = o.team;                     // 'players' | 'enemies'
    this.controller = o.controller || 'ai'; // 'human' | 'ai'
    this.slot = o.slot ?? 0;
    this.color = o.color || CONFIG.ENEMY.color;

    this.boss = !!o.boss;        // 首領（弒神者的加成對它有效）
    this.part = o.part || null;  // 古樹之庭：'eye' | 'mouth'（古樹身上可以打的部位）
    this.fixed = !!o.fixed;      // 固定在原地：不受重力、不會被擊退（古樹的部位）
    this.noTurn = !!o.noTurn;    // 不會輪到它行動（古樹之口）
    this.minion = !!o.minion;    // Boss 召喚出來的小怪（樹妖）
    this.kind = o.kind || null;  // 敵人種類（關卡 enemySpawns 的 type，例如 'sniper'），畫面照它換造型
    // 判定形狀：預設是矩形；'ellipse' = 內切在矩形裡的橢圓（叢林巨蟒的頭），子彈命中與爆炸距離都照橢圓算
    this.shape = o.shape || null;
    this.dormant = false;        // 剛被召喚：這一輪還不會行動（伺服器排回合用）
    // 打不壞，被打到就閉上（古樹之口）：值 = 閉上後要撐過幾個古樹回合才張開（0 = 不是這種角色）
    this.closeOnHit = o.closeOnHit ? Math.max(1, o.closeOnHit | 0) : 0;
    this.closedTurns = 0;        // 古樹之口：還要閉著撐過幾個古樹的回合（0 = 張開）
    // AI 參數：敵人各自設定（見 config 的 ENEMY / SNIPER / TREANT）；玩家斷線代打時用 CONFIG.ENEMY
    this.ai = o.aimError ? {
      aimError: o.aimError, sniperSpread: o.sniperSpread, sniperChance: o.sniperChance ?? 0, moveChance: o.moveChance ?? 0,
    } : null;
    this.x = o.x;
    this.y = o.y;
    const size = clamp(o.size ?? 1, 0.5, 2);          // 體型倍率（牌的 sizePct）
    this.hw = (o.hw ?? 9) * size;    // 半寬
    this.h = (o.h ?? 30) * size;     // 身高
    this.maxHp = o.maxHp ?? o.hp;
    this.hp = Math.min(o.hp, this.maxHp);
    this.maxStamina = o.maxStamina ?? o.stamina;
    this.stamina = Math.min(o.stamina, this.maxStamina);
    // 牌帶來的加成，玩家才會有；敵人用預設 0
    this.mods = Object.assign({ ...DEFAULT_MODS }, o.mods || {});
    // 攜手之伴：跟誰「連結」（隊友 id，雙向；受到的傷害跟活著的連結對象平分，見 Match.applyExplosion）
    this.links = Array.isArray(o.links) ? o.links.slice() : [];
    this.moveSpeed = o.moveSpeed;
    this.jumpSpeed = o.jumpSpeed;
    this.moveCost = o.moveCost;
    this.jumpCost = o.jumpCost;

    this.vx = 0;                 // 只用於擊退
    this.vy = 0;
    this.onGround = false;
    this.facing = o.facing || 1;
    this.moveDir = 0;            // -1 / 0 / 1
    this.wantJump = false;
    this.airJumpsLeft = this.mods.extraJumps;   // 雲霧之瓶：離地後還能再跳幾次，落地就補滿
    // 這次離地是自己跳起來的（jump 成功才設，落地 / 抓藤蔓 / 落水 / 校正狀態就清掉）：慢動作只認這個。
    // 走下坡、走下小台階、被擊退飛起來都不算（那些時候 onGround 也是 false）
    this.jumped = false;
    this.climbMax = 5;           // 每 1px 水平移動最多能爬的高度
    // 藤蔓（叢林巨蟒）：vineSpeed > 0 才爬得了（玩家）。onVine = 抓著第幾條藤蔓（-1 = 沒有），vineDir = 按著 W(-1) / S(1)
    this.vineSpeed = o.vineSpeed || 0;
    this.vineHangCost = o.vineHangCost || 0;   // 掛著不動每秒耗多少體力（hangDrain 開著才扣）
    this.onVine = -1;
    this.vineDir = 0;
    this.vineRegrab = 0;
    // 正在自己的回合操作（客戶端操作自己時才開，不同步）：掛在藤蔓上才會耗體力、體力用完會鬆手。
    // 回合結束、別人的回合、伺服器的結算都是關著的 → 掛著的人一直掛著
    this.hangDrain = false;

    // 武器欄（最多 EQUIP.maxWeapons 把），weapon 是目前拿在手上的那把
    // 玩家只能拿可裝備的武器；敵人可以用專屬武器（樹妖的長矛）
    const ws = (o.weapons || []).filter(o.team === 'players' ? isEquippable : (id => !!CONFIG.WEAPONS[id]));
    this.weapons = (ws.length ? ws : CONFIG.EQUIP.startWeapons).slice(0, CONFIG.EQUIP.maxWeapons);
    this.weapon = this.weapons[0];
    this.aimAngle = this.facing < 0 ? 135 : 45;   // 數學角度：0=右, 90=上
    this.aimPower = 50;
    this.aiming = false;

    this.alive = true;
    this.deathTimer = 0;
    this.deathCause = null;
    this.deathHandled = false;   // 客戶端是否已播過死亡特效 / 橫幅
    this.hurtTimer = 0;
    // 落水重生：最後站穩的地方（腳底），掉進水裡就回到這裡（見 fallInWater）
    this.safeX = o.x;
    this.safeY = o.y;
    this.waterFalls = 0;         // 這一關掉進水裡幾次
    this.splash = null;          // 最近一次落水 { n, x, y, dmg, died, sx, sy }：給畫面播水花 / 飄字，玩家回報給伺服器

    // 裝備效果的戰鬥狀態（每關重新開始；soulPct 是噬魂者累積的傷害加成，整場冒險帶著走）
    this.burn = 0;               // 燃燒層數
    this.burnSource = null;      // 最後一個讓他燃燒的人（燒死算他的擊殺）
    this.poison = 0;             // 中毒層數（還沒結算的，自己的回合開始時結算，見 Match.poisonTick）
    this.poisonLock = 0;         // 被中毒鎖住的最大血量（maxHp 已經扣掉了；原本的上限 = maxHp + poisonLock）
    this.shield = 0;             // 神佑之石給的無敵次數
    this.extraTurnCd = 0;        // 時間扭曲：還要再過幾個回合才會再給額外回合（0 = 這回合結束就會給）
    this.turnCount = 0;          // 這一關輪到自己幾次了（狂戰之斧、神佑之石用）
    this.movedThisTurn = 0;      // 這回合移動的距離（甩掉燃燒層數用）
    this.readyStacks = 0;        // 磨刀霍霍的「準備」層數（射擊沒打中敵人 +1，打中歸零）
    this.huntStacks = 0;         // 越戰越強的「狂獵」層數（射擊打中敵人 +1，沒打中歸零）
    this.kills = 0;
    this.soulPct = o.soulPct || 0;
    this.healFrac = 0;           // 吸血 / 回血不足 1 點的小數先存著
    this.burnFrac = 0;           // 燃燒傷害不足 1 點的小數先存著
  }

  get isPlayer() { return this.team === 'players'; }
  get cx() { return this.x; }
  get cy() { return this.y - this.h / 2; }

  muzzle() {
    return { x: this.x, y: this.y - this.h * 0.62 };
  }

  containsPoint(px, py, pad = 0) {
    if (this.shape === 'ellipse') {
      const dx = (px - this.x) / (this.hw + pad), dy = (py - this.cy) / (this.h / 2 + pad);
      return dx * dx + dy * dy <= 1;
    }
    return px >= this.x - this.hw - pad && px <= this.x + this.hw + pad &&
           py >= this.y - this.h - pad && py <= this.y + pad;
  }

  // 點到身體矩形（或橢圓）的最短距離。橢圓用「沿著往中心的方向，到橢圓邊緣還有多遠」近似（只用開根號）
  distanceTo(px, py) {
    if (this.shape === 'ellipse') {
      const dx = px - this.x, dy = py - this.cy;
      const nx = dx / this.hw, ny = dy / (this.h / 2);
      const k = Math.sqrt(nx * nx + ny * ny);
      return k <= 1 ? 0 : Math.sqrt(dx * dx + dy * dy) * (1 - 1 / k);
    }
    const dx = Math.max(this.x - this.hw - px, 0, px - (this.x + this.hw));
    const dy = Math.max(this.y - this.h - py, 0, py - this.y);
    return Math.hypot(dx, dy);
  }

  // 身體矩形是否與地形重疊
  collides(terrain, x, y) {
    const xs = [x - this.hw + 1, x, x + this.hw - 1];
    for (let yy = y; yy > y - this.h; yy -= 4) {
      for (const xx of xs) if (terrain.isSolid(xx, yy)) return true;
    }
    for (const xx of xs) if (terrain.isSolid(xx, y - this.h + 1)) return true;
    return false;
  }

  // 腳下有沒有東西撐著（平台只有從上面踩下來才撐得住，見 Terrain.supports）
  groundBelow(terrain, x, y) {
    return terrain.supports(x - this.hw + 3, y) ||
           terrain.supports(x, y) ||
           terrain.supports(x + this.hw - 3, y);
  }

  headBlocked(terrain, x, y) {
    return terrain.isSolid(x - this.hw + 2, y - this.h) ||
           terrain.isSolid(x, y - this.h) ||
           terrain.isSolid(x + this.hw - 2, y - this.h);
  }

  // 水平移動 dist 像素（含爬坡）。回傳 false 表示被牆擋住。
  tryMove(terrain, dir, dist) {
    let moved = 0;
    while (moved < dist) {
      const s = Math.min(1, dist - moved);
      const nx = this.x + dir * s;
      if (nx < this.hw || nx > terrain.maxX - this.hw) return false;
      if (!this.collides(terrain, nx, this.y)) {
        this.x = nx;
        moved += s;
        continue;
      }
      let climbed = false;
      for (let up = 1; up <= this.climbMax; up++) {
        if (!this.collides(terrain, nx, this.y - up)) {
          this.x = nx;
          this.y -= up;
          climbed = true;
          break;
        }
      }
      if (!climbed) return false;
      moved += s;
    }
    return true;
  }

  // AI 用：往 dir 方向再走一步是否還有地面（避免自己走進水裡）
  canWalk(terrain, dir) {
    const px = this.x + dir * 24;
    if (px < this.hw || px > terrain.maxX - this.hw) return false;
    for (let k = -this.climbMax; k <= 50; k++) {
      if (terrain.isSolid(px, this.y + k) || terrain.isPlatform(px, this.y + k)) return true;
    }
    return false;
  }

  // 算不算站在地上（跳躍用）。走下坡、站在斜坡的像素階梯上時 onGround 會閃掉幾幀，
  // 所以沒有在往上飛、腳下 3px 內有地面也算站著
  nearGround(terrain) {
    if (this.onGround) return true;
    if (this.vy < 0) return false;
    for (let k = 0; k < 3; k++) if (this.groundBelow(terrain, this.x, this.y + k)) return true;
    return false;
  }

  // 站在地上（或抓著藤蔓）跳；在空中的話，有雲霧之瓶（extraJumps）的次數就能再跳一次。每次都一樣消耗跳躍體力
  jump(terrain) {
    if (this.stamina < this.jumpCost) return false;
    if (this.onVine >= 0 || (terrain ? this.nearGround(terrain) : this.onGround)) {
      this.airJumpsLeft = this.mods.extraJumps;   // 從地面 / 藤蔓起跳：空中的次數一定是滿的（落地前一幀起跳也一樣）
      this.letGoVine();
    } else {
      if (this.airJumpsLeft <= 0) return false;
      this.airJumpsLeft--;
    }
    this.vy = -this.jumpSpeed;
    this.stamina -= this.jumpCost;
    this.onGround = false;
    this.jumped = true;
    return true;
  }

  // 正在「自己跳起來」的空中（慢動作的條件）：跳了、還沒落地、沒抓著藤蔓
  get midJump() {
    return this.alive && this.jumped && !this.onGround && this.onVine < 0;
  }

  update(dt, world) {
    if (!this.alive) {
      this.deathTimer += dt;
      return;
    }
    const terrain = world.terrain;
    this.hurtTimer = Math.max(0, this.hurtTimer - dt);
    if (this.fixed) return;   // 古樹的部位長在樹上、巨蟒的頭不會動，不受重力

    // 藤蔓：按住 W / S、身體碰到藤蔓就抓住；抓著的時候不受重力（見 updateVine）
    // 冷卻照「固定步長的幀數」算：平常 dt = FIXED_DT 每次剛好減 1；慢動作時 dt 比較小、減得比較少，冷卻在遊戲時間裡一樣長
    if (this.vineRegrab > 0) this.vineRegrab = Math.max(0, this.vineRegrab - dt / CONFIG.FIXED_DT);
    if (this.onVine < 0 && this.vineDir !== 0) this.grabVine(terrain);
    if (this.onVine >= 0 && this.updateVine(dt, terrain)) return;

    // 主動移動（消耗耐力；耐力歸零就動不了）
    if (this.moveDir !== 0 && this.stamina > 0) {
      this.stamina = Math.max(0, this.stamina - this.moveCost * dt);
      this.tryMove(terrain, this.moveDir, this.moveSpeed * dt);
      if (!this.aiming) this.facing = this.moveDir;
    }
    if (this.wantJump) {
      this.jump(terrain);
      this.wantJump = false;
    }

    // 擊退產生的水平速度
    if (Math.abs(this.vx) > 2) {
      if (!this.tryMove(terrain, Math.sign(this.vx), Math.abs(this.vx) * dt)) this.vx = 0;
      if (this.onGround) this.vx *= Math.max(0, 1 - 8 * dt);
    } else {
      this.vx = 0;
    }

    // 垂直：逐像素移動避免穿透
    this.vy = Math.min(this.vy + CONFIG.GRAVITY * dt, 1400);
    const dy = this.vy * dt;
    if (dy > 0) {
      let rem = dy;
      while (rem > 0) {
        if (this.groundBelow(terrain, this.x, this.y)) { this.vy = 0; break; }
        const s = Math.min(1, rem);
        this.y += s;
        rem -= s;
      }
    } else if (dy < 0) {
      let rem = -dy;
      while (rem > 0) {
        const s = Math.min(1, rem);
        // 撞到頭頂的地形，或頭已經頂到畫面最上面（疊很多段跳時）就停
        if (this.headBlocked(terrain, this.x, this.y - s) || this.y - s - this.h < 0) { this.vy = 0; break; }
        this.y -= s;
        rem -= s;
      }
    }
    this.onGround = this.vy >= 0 && this.groundBelow(terrain, this.x, this.y);
    if (this.onGround) { this.airJumpsLeft = this.mods.extraJumps; this.jumped = false; }

    // 萬一卡進地形，往上推出
    if (this.collides(terrain, this.x, this.y)) {
      for (let up = 1; up <= 12; up++) {
        if (!this.collides(terrain, this.x, this.y - up)) { this.y -= up; break; }
      }
    }

    this.x = clamp(this.x, this.hw, terrain.maxX - this.hw);

    // 站穩的地方記下來（落水重生用；水邊不算）
    if (this.onGround && this.y <= CONFIG.WATER_LEVEL - CONFIG.WATER.safeMargin) { this.safeX = this.x; this.safeY = this.y; }
    // 落水：扣血後回到最後站穩的地方，扣不起就淹死
    if (this.y > CONFIG.WATER_LEVEL) this.fallInWater(terrain);
  }

  // ---- 藤蔓 ----

  // 按住 W / S 時身體碰到藤蔓（手在藤蔓的範圍裡）就抓住：x 對齊藤蔓、停在半空，空中的跳躍次數補滿。
  // 站在橋上搆不到藤蔓的下端，要先跳起來。自己的回合沒體力就抓不住（抓了也馬上會鬆手）
  grabVine(terrain) {
    if (!(this.vineSpeed > 0) || this.vineRegrab > 0 || (this.hangDrain && this.stamina <= 0)) return false;
    const vines = terrain.vines;
    for (let i = 0; i < vines.length; i++) {
      const v = vines[i];
      if (Math.abs(this.x - v.x) > this.hw + VINE_REACH) continue;
      if (this.y - this.h + VINE_HAND > v.bottom || this.y < v.top) continue;   // 手還在藤蔓下端下面 / 整個人在藤蔓上端上面
      const y = clamp(this.y, v.top + this.h - VINE_HAND, v.bottom + this.h - VINE_HAND);
      if (this.collides(terrain, v.x, y)) continue;
      this.onVine = i;
      this.x = v.x;
      this.y = y;
      this.vx = 0;
      this.vy = 0;
      this.onGround = false;
      this.airJumpsLeft = this.mods.extraJumps;
      this.jumped = false;
      return true;
    }
    return false;
  }

  // 抓著藤蔓的這一幀：空白鍵跳開（同一幀按著 A / D 就往那邊跳）；沒按著 W / S 時按 A / D 放手（這一幀接著照一般物理走）——
  // 按著 W / S 就是「抓緊」，邊走邊跳過來按著 W 也抓得住；W / S 上下爬（跟走路一樣耗體力）。
  // 自己的回合（hangDrain）掛著不動也耗體力（vineHangCost），體力用完就鬆手掉下去；不是自己在操作時免費掛著、沒體力也掛得住。
  // 往上爬到手碰到藤蔓上端就停；往下爬時腳踩到地就站上去，手滑過藤蔓下端就掉下去。回傳 true = 還掛著
  updateVine(dt, terrain) {
    const v = terrain.vines[this.onVine];
    if (!v) { this.letGoVine(); return false; }
    if (this.wantJump) {
      this.wantJump = false;
      if (this.jump(terrain)) return false;   // 跳開了，這一幀接著照一般物理飛
    }
    if (this.moveDir !== 0 && this.vineDir === 0) { this.letGoVine(); return false; }
    if (this.hangDrain && this.stamina <= 0) { this.letGoVine(); return false; }   // 體力用完：手一鬆，這一幀接著往下掉
    this.x = v.x;
    this.vx = 0;
    this.vy = 0;
    this.onGround = false;
    if (this.vineDir === 0 || this.stamina <= 0) {
      if (this.hangDrain) this.stamina = Math.max(0, this.stamina - this.vineHangCost * dt);
      return true;
    }
    this.stamina = Math.max(0, this.stamina - this.moveCost * dt);
    let rem = this.vineSpeed * dt;
    if (this.vineDir < 0) {
      const top = Math.max(v.top + this.h - VINE_HAND, this.h);
      while (rem > 0 && this.y > top) {
        const s = Math.min(1, rem, this.y - top);
        if (this.headBlocked(terrain, this.x, this.y - s)) break;
        this.y -= s;
        rem -= s;
      }
      return true;
    }
    const bottom = v.bottom + this.h - VINE_HAND;
    while (rem > 0) {
      if (this.groundBelow(terrain, this.x, this.y)) { this.letGoVine(); return false; }   // 腳踩到地：站上去
      const s = Math.min(1, rem);
      if (this.y + s > bottom) { this.letGoVine(); return false; }   // 手滑過藤蔓下端：掉下去
      this.y += s;
      rem -= s;
    }
    return true;
  }

  letGoVine() {
    if (this.onVine < 0) return;
    this.onVine = -1;
    this.vineRegrab = VINE_REGRAB;
  }

  // 腳底在 (x, y) 的人能不能掛在第 i 條藤蔓上（伺服器檢查玩家回報的位置用）
  canHangAt(terrain, i, x, y) {
    const v = terrain.vines[i];
    return !!v && this.vineSpeed > 0 && Math.abs(x - v.x) < 0.5 &&
      y >= v.top + this.h - VINE_HAND - 0.5 && y <= v.bottom + this.h - VINE_HAND + 0.5 && y - this.h >= 0 &&
      !this.collides(terrain, x, y);
  }

  // 腳底放在 (x, y) 站不站得住：身體不卡進地形、腳下 2px 內有東西撐著、離水面夠遠、頭不超出畫面（落水重生用）。
  // 「2px 內」是因為站在斜坡上的人會在 1px 之間上下抖（撐住的那一格剛好卡進坡、被推出來又往下掉），不會剛好貼著
  canStandAt(terrain, x, y) {
    if (x < this.hw || x > terrain.maxX - this.hw || y - this.h < 0 || y > CONFIG.WATER_LEVEL - CONFIG.WATER.safeMargin) return false;
    let ground = false;
    for (let k = 0; k <= 2 && !ground; k++) ground = this.groundBelow(terrain, x, y + k);
    return ground && !this.collides(terrain, x, y);
  }

  // 落水後的重生點：最後站穩的地方（safeX, safeY）還站得住就回那裡；被炸掉了就找直線距離最近的站得住點
  // （例如腳下被挖空時，旁邊 35px 的地面會贏過正上方 200px 的平台）。從那一行往左右擴大找，
  // 每一行只要離那裡最近的高度，行距本身已經比目前最好的還遠就停。只用整數運算與遮罩查詢，
  // 伺服器與每個客戶端找到的點一樣（一樣遠時先找到的贏：左邊、上面先）。整張圖都沒地方站回傳 null
  respawnSpot(terrain) {
    if (this.canStandAt(terrain, this.safeX, this.safeY)) return { x: this.safeX, y: this.safeY };
    const x0 = Math.round(this.safeX), y0 = Math.round(this.safeY);
    const lo = Math.ceil(this.hw), hi = Math.floor(terrain.maxX - this.hw);
    const top = Math.ceil(this.h), bottom = CONFIG.WATER_LEVEL - CONFIG.WATER.safeMargin;
    let best = null, bestD2 = Infinity;
    for (let d = 0; d * d < bestD2 && (x0 - d >= lo || x0 + d <= hi); d++) {
      for (const x of d ? [x0 - d, x0 + d] : [x0]) {
        if (x < lo || x > hi) continue;
        for (let k = 0; d * d + k * k < bestD2 && (y0 - k >= top || y0 + k <= bottom); k++) {
          const y = (k ? [y0 - k, y0 + k] : [y0]).find(yy => yy >= top && yy <= bottom && this.canStandAt(terrain, x, yy));
          if (y !== undefined) { best = { x, y }; bestD2 = d * d + k * k; break; }
        }
      }
    }
    return best;
  }

  // 落水：敵人（WATER.enemiesDrown）直接淹死；玩家扣最大血量的 WATER.damagePct%（不吃狂熱、減傷、無敵），
  // 扣完沒血（或整張圖都沒地方站）就淹死，撐得住就回到 respawnSpot 站好。
  // splash 記下這一次（畫面播水花 / 飄字，玩家自己掉下去時回報給伺服器）
  fallInWater(terrain) {
    const drown = this.team === 'enemies' && CONFIG.WATER.enemiesDrown;
    const dmg = drown ? this.hp : Math.min(this.hp, Math.round(this.maxHp * CONFIG.WATER.damagePct / 100));
    const spot = this.hp > dmg ? this.respawnSpot(terrain) : null;
    this.waterFalls++;
    this.splash = { n: this.waterFalls, x: this.x, y: this.y, dmg, died: !spot, sx: this.safeX, sy: this.safeY };
    if (!spot) { this.die('water'); return; }
    this.hp -= dmg;
    this.hurtTimer = 0.35;
    this.x = spot.x;
    this.y = spot.y;
    this.vx = 0;
    this.vy = 0;
    this.onGround = this.groundBelow(terrain, spot.x, spot.y);   // 斜坡上可能還差 1~2px，下一幀自己落地
    this.airJumpsLeft = this.mods.extraJumps;
    this.jumped = false;
    this.moveDir = 0;      // 走路 / 跳躍被打斷（AI 走路也就此停下）
    this.wantJump = false;
    this.aiming = false;
    this.onVine = -1;
  }

  takeDamage(dmg) {
    if (!this.alive) return 0;
    const real = Math.min(this.hp, Math.round(dmg));
    this.hp -= real;
    this.hurtTimer = 0.35;
    if (this.hp <= 0) this.die('hit');
    return real;
  }

  die(cause) {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    this.deathCause = cause;
    this.deathTimer = 0;
    this.moveDir = 0;
    this.aiming = false;
    this.onVine = -1;
  }

  // ---- 同步用 ----
  // ps = 中毒層數、lk = 被中毒鎖住的上限、vn = 抓著第幾條藤蔓（-1 = 沒有；不帶的話客戶端會以為他在半空中、自己掉下去）
  toState() {
    const s = {
      id: this.id, x: this.x, y: this.y, hp: this.hp, mhp: this.maxHp, stamina: this.stamina,
      alive: this.alive, cause: this.deathCause, facing: this.facing, weapon: this.weapon,
      burn: this.burn, shield: this.shield, soul: this.soulPct, turns: this.turnCount, xcd: this.extraTurnCd,
      sx: this.safeX, sy: this.safeY, wf: this.waterFalls, ps: this.poison, lk: this.poisonLock, vn: this.onVine,
      rd: this.readyStacks, hu: this.huntStacks,
    };
    if (this.closeOnHit) s.closed = this.closedTurns;
    return s;
  }

  // 飛行途中的事件（爆炸、穿透…）之後這個角色的狀態：客戶端在同一幀套上，跟伺服器對齊
  toEventState() {
    const s = {
      id: this.id, x: this.x, y: this.y, vx: this.vx, vy: this.vy, og: this.onGround,
      hp: this.hp, alive: this.alive, cause: this.deathCause, burn: this.burn, shield: this.shield,
      sx: this.safeX, sy: this.safeY, ps: this.poison, vn: this.onVine, rg: this.vineRegrab,
    };
    if (this.closeOnHit) s.closed = this.closedTurns;
    return s;
  }

  applyEventState(s) {
    this.x = s.x;
    this.y = s.y;
    this.vx = s.vx;
    this.vy = s.vy;
    this.onGround = s.og;
    this.jumped = false;   // 被打飛不算自己跳的
    this.hp = s.hp;
    this.burn = s.burn;
    this.shield = s.shield;
    if (s.sx !== undefined) { this.safeX = s.sx; this.safeY = s.sy; }
    if (s.ps !== undefined) this.poison = s.ps;
    if (s.vn !== undefined) { this.onVine = s.vn; this.vineRegrab = s.rg || 0; }   // 被打下藤蔓
    if (s.closed !== undefined) this.closedTurns = s.closed;
    if (this.alive && !s.alive) this.die(s.cause || 'hit');
  }

  applyState(s) {
    this.x = s.x;
    this.y = s.y;
    if (s.mhp !== undefined) this.maxHp = s.mhp;   // 落水扣的是最大血量的 %，客戶端重播時要跟伺服器用同一個數
    this.hp = s.hp;
    this.stamina = s.stamina;
    this.facing = s.facing || this.facing;
    if (s.weapon) this.weapon = s.weapon;
    if (s.burn !== undefined) this.burn = s.burn;
    if (s.shield !== undefined) this.shield = s.shield;
    if (s.soul !== undefined) this.soulPct = s.soul;
    if (s.turns !== undefined) this.turnCount = s.turns;
    if (s.xcd !== undefined) this.extraTurnCd = s.xcd;
    if (s.closed !== undefined) this.closedTurns = s.closed;
    if (s.sx !== undefined) { this.safeX = s.sx; this.safeY = s.sy; }
    if (s.wf !== undefined) this.waterFalls = s.wf;   // 落水次數跟伺服器對齊（客戶端用它判斷 skip 帶來的水花自己播過了沒）
    if (s.ps !== undefined) this.poison = s.ps;
    if (s.lk !== undefined) this.poisonLock = s.lk;
    if (s.vn !== undefined) this.onVine = s.vn;
    if (s.rd !== undefined) this.readyStacks = s.rd;
    if (s.hu !== undefined) this.huntStacks = s.hu;
    this.vineRegrab = 0;
    this.vx = 0;
    this.vy = 0;
    this.jumped = false;
    this.moveDir = 0;
    this.vineDir = 0;
    if (this.alive && !s.alive) {
      this.die(s.cause || 'hit');
    } else if (!this.alive && s.alive) {
      this.alive = true;
      this.deathTimer = 0;
      this.deathCause = null;
      this.deathHandled = false;
    }
  }
}
