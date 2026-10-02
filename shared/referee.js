import { CONFIG } from './config.js';
import { clamp, logValue } from './utils.js';

// 一發（或一波轟炸）結算完要等多久：飛行 + 落地 + 緩衝。客戶端的播放時間比這短，不會被下一個事件追上
const shotSeconds = (shot) => (shot.flightFrames + shot.settleFrames) / 60 + CONFIG.TIMING.afterShotPad;
// 一次落水給客戶端播的資料（水花在哪、扣了多少、有沒有淹死；n = 這一關第幾次落水，客戶端用來判斷自己是不是已經播過）
const splashOf = (e) => ({ id: e.id, n: e.splash.n, x: e.splash.x, dmg: e.splash.dmg, died: e.splash.died });

// ---- 紀錄（LOG）用的小工具：結算前後各拍一張血量快照，一比就知道誰扣 / 回了多少血、誰倒下、誰是新召喚的 ----
const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
const hpOf = (match) => new Map(match.entities.map(e => [e.id, { hp: e.hp, alive: e.alive }]));
function hpChanges(match, before) {
  const out = [];
  for (const e of match.entities) {
    const b = before.get(e.id);
    if (!b) { out.push({ id: e.id, name: e.name, hp: [null, r1(e.hp)], spawned: true }); continue; }
    if (b.hp === e.hp && b.alive === e.alive) continue;
    out.push({ id: e.id, name: e.name, hp: [r1(b.hp), r1(e.hp)], ...(b.alive && !e.alive ? { died: e.deathCause || true } : {}) });
  }
  return out;
}
// 回合類紀錄的主角：actor = 誰的回合（玩家或敵人的 id）；是玩家的話再帶 pid，用 pid 找一個人的紀錄才找得到他的回合
const actorOf = (e) => ({ actor: e.id, ...(e.team === 'players' ? { pid: e.id } : {}), name: e.name });

// 裁判：一場遊戲的流程（誰的回合、計時、AI 回合、開火結算、裝備的回合效果、勝負）。
// 同一份程式在 Node 房間裡跑（多人），也在瀏覽器裡跑（單人練習）。
// io = { broadcast(msg, exceptId), schedule(fn, ms) → handle, cancel(handle), now() → ms }
//
// 一個回合：nextTurn（回合開始：無差別轟炸）→ startTurn（中毒結算、站在蛇血上就喝、恩賜之杖回血、開始計時 / AI 行動；被毒倒就直接換人）
//          → 開火 / 超時 / AI 播完 → finishTurn（回合結束：燃燒、神佑之石、時間扭曲）→ 下一位的 nextTurn
//          （時間扭曲給了額外回合的話，nextTurn 會讓同一位再來一次，不算新的一輪）
export class Referee {
  // humans[i].connected 可省略（預設 true）；onGameOver(result) 讓肉鴿流程接手下一步
  constructor({ match, humans, io, onGameOver = null, stageInfo = null }) {
    this.match = match;
    this.io = io;
    this.onGameOver = onGameOver;
    this.stageInfo = stageInfo;
    this.humans = new Map(humans.map(h => [h.id, { id: h.id, name: h.name, connected: h.connected !== false }]));
    this.currentId = null;
    this.extraTurn = false;   // 目前這個回合是不是時間扭曲給的額外回合
    this.round = 0;
    this.phase = 'idle';   // idle | starting | turn | resolving | over
    this.timer = null;
    this.deadline = null;
  }

  // ---- 對外 ----
  start() {
    this.phase = 'starting';
    this.record('battle.start', {
      level: this.match.levelId, seed: this.match.seed,
      entities: this.match.entities.map(e => ({
        id: e.id, name: e.name, team: e.team, ...(e.kind ? { kind: e.kind } : {}), ...(e.part ? { part: e.part } : {}),
        hp: r1(e.hp), maxHp: r1(e.maxHp), x: r1(e.x), y: r1(e.y),
      })),
    });
    this.io.broadcast({ t: 'start', ...this.startPayload() });
    this.schedule(() => this.nextTurn(), CONFIG.TIMING.startDelay);
  }

  stop() {
    this.cancelTimer();
    this.phase = 'over';
  }

  // 寫一筆紀錄（玩家看不到）：io 有 record 才記（伺服器的房間、單人練習；測試的假 io 沒有就不記）。
  // 每筆都帶第幾關、第幾輪
  record(ev, data) {
    if (typeof this.io.record === 'function') this.io.record(ev, { stage: this.match.stage, round: this.round, ...data });
  }

  // 收到但不處理的訊息也記一筆（不是他的回合、已經倒下、資料不對…），查「我明明有按卻沒反應」用。
  // 換武器 / 開火連他送來的武器、角度、力量一起記（截短過，亂送的值不會讓紀錄變超長）
  ignored(playerId, msg, reason) {
    const sent = msg.t === 'weapon' || msg.t === 'fire'
      ? { weapon: logValue(msg.weapon), ...(msg.t === 'fire' ? { angle: logValue(msg.angle), power: logValue(msg.power) } : {}) }
      : {};
    this.record('action.ignored', { pid: playerId, t: logValue(msg.t), reason, ...sent });
  }

  // 來自行動玩家的訊息（其他人的訊息一律忽略）
  handle(playerId, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (this.phase !== 'turn') return this.ignored(playerId, msg, 'phase:' + this.phase);
    if (playerId !== this.currentId) return this.ignored(playerId, msg, 'notYourTurn');
    const actor = this.match.byId(playerId);
    if (!actor || !actor.alive) return this.ignored(playerId, msg, 'dead');

    switch (msg.t) {
      case 'move': {
        const falls = actor.waterFalls;
        // vine = 抓著第幾條藤蔓（叢林巨蟒）：掛得上去才算，超時 / 斷線時伺服器才知道他是掛著、不是在半空中
        if (this.match.setPlayerPosition(actor, msg.x, msg.y, msg.facing, msg.stamina, msg.safe, msg.vine)) {
          if (CONFIG.LOG && CONFIG.LOG.moves) {
            this.record('move', {
              pid: actor.id, name: actor.name, x: r1(msg.x), y: r1(msg.y), facing: actor.facing, stamina: r1(actor.stamina),
              ...(actor.onVine >= 0 ? { vine: actor.onVine } : {}),
            });
          }
          this.flushPickups();
          if (actor.waterFalls !== falls) { this.actorFellInWater(actor); break; }   // 自己走 / 跳進水裡
          // 記住當下的垂直速度：回報時人可能正在空中（例如往上跳穿平台），超時 / 斷線時伺服器才接得上他原本的軌跡
          if (Number.isFinite(msg.vy)) actor.vy = actor.onVine >= 0 ? 0 : clamp(msg.vy, -actor.jumpSpeed, 1400);
          this.io.broadcast({ t: 'move', id: actor.id, x: actor.x, y: actor.y, facing: actor.facing, stamina: actor.stamina, vine: actor.onVine }, playerId);
        } else {
          // 位置不合理（瞬移、出界、卡進地形）被擋下
          this.record('move.reject', { pid: actor.id, name: actor.name, x: logValue(msg.x), y: logValue(msg.y), from: [r1(actor.x), r1(actor.y)] });
        }
        break;
      }
      case 'weapon': {
        if (actor.weapons.includes(msg.weapon)) {   // 只能切換自己武器欄裡的武器
          actor.weapon = msg.weapon;
          this.record('weapon', { pid: actor.id, name: actor.name, weapon: msg.weapon });
          this.io.broadcast({ t: 'weapon', id: actor.id, weapon: msg.weapon }, playerId);
        } else {
          this.ignored(playerId, msg, 'weaponNotOwned');
        }
        break;
      }
      case 'fire': {
        if (!actor.weapons.includes(msg.weapon) || !Number.isFinite(msg.angle) || !Number.isFinite(msg.power)) {
          return this.ignored(playerId, msg, actor.weapons.includes(msg.weapon) ? 'badAim' : 'weaponNotOwned');
        }
        // 空中也能開火：就在回報的位置出手，並接著他當下的垂直速度往下飛 / 落地
        const falls = actor.waterFalls;
        const moved = this.match.setPlayerPosition(actor, msg.x, msg.y, msg.facing, msg.stamina, null, msg.vine);
        this.flushPickups();
        const power = clamp(msg.power, 0, 100);
        // 先記開火（玩家的操作：他回報的出手位置），結算的結果另記一筆 shot：結算途中出錯的話，至少知道他是怎麼開的。
        // 出手的位置在水裡的話，後面接著是 water（與淹死的 turn.skip）；posRejected = 回報的位置不合理，從伺服器記得的位置出手
        this.record('fire', {
          pid: actor.id, name: actor.name, weapon: msg.weapon, angle: r1(msg.angle), power: r1(power),
          x: logValue(msg.x), y: logValue(msg.y), ...(Number.isFinite(msg.vy) && msg.vy ? { vy: r1(msg.vy) } : {}),
          ...(actor.onVine >= 0 ? { vine: actor.onVine } : {}), ...(moved ? {} : { posRejected: true }),
        });
        if (actor.waterFalls !== falls) {   // 出手的位置已經在水裡：淹死就結束，撐住了就從重生點出手
          if (this.actorFellInWater(actor)) return;
        } else if (moved && Number.isFinite(msg.vy)) {
          actor.vy = actor.onVine >= 0 ? 0 : clamp(msg.vy, -actor.jumpSpeed, 1400);
        }
        this.phase = 'resolving';
        this.deadline = null;
        const before = hpOf(this.match);
        const shot = this.match.resolveShot(actor, msg.weapon, msg.angle, power);
        this.recordShot(shot, before);
        this.io.broadcast({ t: 'shot', ...shot });
        this.schedule(() => this.finishTurn(), shotSeconds(shot));
        break;
      }
      default:
        this.ignored(playerId, msg, 'unknown');
    }
  }

  // 一發（或一波轟炸）的結果：打到什麼、誰扣了多少血、誰倒下
  recordShot(shot, before) {
    this.record('shot', {
      kind: shot.kind, pid: shot.actorId, name: (this.match.byId(shot.actorId) || {}).name, weapon: shot.weapon,
      hit: shot.hit && shot.hit.type, frames: shot.flightFrames, kills: shot.kills, changes: hpChanges(this.match, before),
    });
  }

  // 行動玩家回報自己掉進水裡（setPlayerPosition 已經扣完血、把他放回岸上）。
  // 淹死 → 這回合結束；撐住了 → 回合繼續（還有體力就能接著動），告訴其他人播水花、把他放到重生點。
  // 他自己的畫面已經先算好了，不再送給他（送了反而會把他已經走開的位置拉回來）。回傳回合是不是結束了
  actorFellInWater(actor) {
    this.record('water', {
      pid: actor.id, name: actor.name, x: r1(actor.splash.x), dmg: r1(actor.splash.dmg), died: !!actor.splash.died,
      hp: r1(actor.hp), respawn: actor.alive ? [r1(actor.x), r1(actor.y)] : null,
    });
    if (!actor.alive) { this.skipTurn('water', [splashOf(actor)]); return true; }
    this.io.broadcast({ t: 'water', id: actor.id, splash: splashOf(actor), state: actor.toState() }, actor.id);
    return false;
  }

  // 行動玩家走路途中喝到蛇血（叢林巨蟒）：告訴所有人（包括他自己——客戶端不自己判斷撿到沒），
  // 只帶上限相關的數值，不帶位置（他自己的畫面已經走到更前面了）
  flushPickups() {
    for (const fx of this.match.takePickups()) {
      const e = this.match.byId(fx.id);
      const { id, ...info } = fx;
      this.record('pickup', { pid: id, name: e.name, ...info, hp: r1(e.hp), maxHp: r1(e.maxHp) });
      this.io.broadcast({ t: 'pickup', ...fx, hp: e.hp, mhp: e.maxHp, lk: e.poisonLock });
    }
  }

  // 玩家連線狀態改變。輪到他卻斷線 → 立刻由 AI 代打
  setConnected(id, connected) {
    const h = this.humans.get(id);
    if (!h || h.connected === connected) return;
    h.connected = connected;
    this.io.broadcast({ t: 'playerStatus', id, connected });
    if (!connected && this.phase === 'turn' && this.currentId === id) {
      const actor = this.match.byId(id);
      this.record('turn.takeover', { pid: id, name: h.name, alive: !!(actor && actor.alive) });   // 輪到他時斷線：AI 接手這回合
      if (actor && actor.alive) this.runAiTurn(actor);
      else this.skipTurn('disconnected');
    }
  }

  // 重連 / 中途進來的人需要的完整狀態
  statePayload() {
    return {
      ...this.startPayload(),
      currentId: this.currentId,
      extraTurn: this.extraTurn,
      round: this.round,
      phase: this.phase,
      timeLeft: this.deadline ? Math.max(0, (this.deadline - this.io.now()) / 1000) : null,
      players: this.match.players.map(p => ({
        id: p.id, name: p.name, slot: p.slot, color: p.color,
        connected: this.humans.has(p.id) ? this.humans.get(p.id).connected : false,
      })),
    };
  }

  // ---- 內部流程 ----
  startPayload() {
    return {
      seed: this.match.seed,
      levelId: this.match.levelId,
      stage: this.match.stage,
      carry: this.match.carry,
      stageInfo: this.stageInfo,
      players: this.match.players.map(p => ({ id: p.id, name: p.name, slot: p.slot, color: p.color })),
      snapshot: this.match.snapshot(),
    };
  }

  turnTimeFor(actor) {
    return CONFIG.TURN_TIME + (actor.mods ? actor.mods.turnTime : 0);
  }

  schedule(fn, secs) {
    this.cancelTimer();
    this.timer = this.io.schedule(fn, Math.max(0, Math.round(secs * 1000)));
  }

  cancelTimer() {
    if (this.timer) {
      this.io.cancel(this.timer);
      this.timer = null;
    }
  }

  // 輪到下一位：回合開始的裝備效果（無差別轟炸）先播完，再由 startTurn 開始計時。
  // again = 時間扭曲給了額外回合的角色：讓他再來一個完整的回合，不換人、不算新的一輪
  nextTurn(again = null) {
    this.timer = null;
    if (this.phase === 'over') return;
    const result = this.match.result();
    if (result) return this.gameOver(result);
    const extra = !!(again && again.alive);
    const prev = this.match.entities.findIndex(e => e.id === this.currentId);
    const actor = extra ? again : this.match.nextActor(this.currentId);
    if (!actor) return this.gameOver('lose');

    // 回合順序繞回陣列前面（或第一個回合）= 新的一輪。不用「輪到第一位活著的玩家」判斷：
    // 他在自己的回合開始被毒倒、或在自己的回合掉水淹死時，下一位不該又算成新的一輪
    if (!extra && (prev < 0 || this.match.entities.indexOf(actor) <= prev)) this.round++;
    this.match.fever = this.match.feverAt(this.round);   // 狂熱：每過 N 輪全體傷害再加成一次（Boss 關不套用）
    this.currentId = actor.id;
    this.extraTurn = extra;
    this.match.beginTurn(actor);

    if (actor.mods.bombard > 0) {
      this.phase = 'resolving';
      this.deadline = null;
      const before = hpOf(this.match);
      const shot = this.match.resolveBombard(actor);
      this.recordShot(shot, before);
      this.io.broadcast({ t: 'shot', ...shot, round: this.round });
      this.schedule(() => this.startTurn(actor), shotSeconds(shot));
      return;
    }
    this.startTurn(actor);
  }

  startTurn(actor) {
    this.timer = null;
    if (this.phase === 'over') return;
    const result = this.match.result();   // 轟炸可能直接把敵人清光
    if (result) return this.gameOver(result);
    if (!actor.alive) return this.finishTurn();

    const fx = this.match.turnStartEffects(actor);
    const human = this.humans.get(actor.id);
    const isHuman = actor.team === 'players' && !!human && human.connected;
    const { entities, items } = this.match.snapshot();
    // ai = 敵人或斷線玩家的代打（takeover）；fx = 回合開始的效果（中毒、喝蛇血、回血）；diedAtStart = 被毒倒，這回合不開始
    this.record('turn.start', {
      ...actorOf(actor), team: actor.team, ai: !isHuman,
      ...(actor.team === 'players' && !isHuman ? { takeover: true } : {}),
      ...(this.extraTurn ? { extra: true } : {}),
      hp: r1(actor.hp), maxHp: r1(actor.maxHp), ...(this.match.fever ? { fever: this.match.fever } : {}),
      ...(isHuman ? { turnTime: this.turnTimeFor(actor) } : {}),
      ...(fx.length ? { fx } : {}), ...(actor.alive ? {} : { diedAtStart: true }),
    });
    if (!actor.alive) {   // 回合開始的中毒結算把他毒倒了：這回合不開始，播完效果就換下一位（全隊倒下就在 nextTurn 判輸）
      this.phase = 'resolving';
      this.deadline = null;
      // atStart：客戶端把「現在輪到誰」換成他（像轟炸那樣），HUD 才不會還停在上一位
      this.io.broadcast({ t: 'turnFx', actorId: actor.id, atStart: true, round: this.round, fx, entities, items });
      this.schedule(() => this.finishTurn(), CONFIG.TIMING.fxDelay);
      return;
    }
    if (isHuman) {
      const turnTime = this.turnTimeFor(actor);
      this.phase = 'turn';
      this.deadline = this.io.now() + turnTime * 1000;
      this.io.broadcast({ t: 'turn', actorId: actor.id, round: this.round, ai: false, turnTime, entities, items, fx, extra: this.extraTurn });
      this.schedule(() => this.skipTurn('timeout'), turnTime);
    } else {
      this.io.broadcast({ t: 'turn', actorId: actor.id, round: this.round, ai: true, turnTime: null, entities, items, fx, extra: this.extraTurn });
      this.runAiTurn(actor);
    }
  }

  // 目前這位的回合做完了（開火結算完 / 時間到 / AI 播完）：結算回合結束的裝備效果，再輪下一位
  finishTurn() {
    this.timer = null;
    if (this.phase === 'over') return;
    const actor = this.match.byId(this.currentId);
    const before = hpOf(this.match);
    const fx = actor ? this.match.endTurn(actor, this.extraTurn) : [];
    // fx = 回合結束的效果（燃燒、神佑之石、時間扭曲、古樹嘴巴張開…）；changes = 這些效果造成的血量變化
    this.record('turn.end', {
      ...(actor ? { ...actorOf(actor), hp: r1(actor.hp), alive: actor.alive } : { actor: this.currentId }),
      ...(fx.length ? { fx, changes: hpChanges(this.match, before) } : {}),
    });
    if (!fx.length) return this.nextTurn();
    const again = fx.some(f => f.type === 'extraTurn') ? actor : null;   // 時間扭曲：同一位再來一回合
    this.phase = 'resolving';
    this.deadline = null;
    this.io.broadcast({ t: 'turnFx', actorId: this.currentId, fx, entities: this.match.snapshot().entities });
    this.schedule(() => this.nextTurn(again), CONFIG.TIMING.fxDelay);
  }

  // AI 回合（敵人，或斷線玩家的代打）：整回合的腳本一次算完並廣播，客戶端照著播。
  // 古樹之眼的回合是出一招或一串招式（boss = { steps: [{ action, …, shot 或 still }], next }，見 tree-boss.js），
  // 每一招都有 bossCast 的預兆動畫；next 是這回合之後預定的下一招，客戶端播完才換上（畫撞擊的預告）
  runAiTurn(actor) {
    this.phase = 'resolving';
    this.deadline = null;
    const before = hpOf(this.match);
    // 斷線代打的玩家可能停在半空中（跳到一半斷線）：先讓大家落地，客戶端才是從靜止的狀態開始播
    // （客戶端在 aiThink 那段也會跑物理，不先落地的話會在客戶端多掉一次水）。落地途中掉進水裡的水花跟著 aiTurn 帶過去
    const splashes = actor.team === 'players' ? this.settleWithSplashes() : [];
    if (!actor.alive) { this.skipTurn('water', splashes, before); return; }   // 掉下去淹死了（紀錄的血量變化從落地前算起）
    const entities = this.match.snapshot().entities;   // 走路前的狀態，客戶端從這裡開始重播
    const { walk, plan, boss } = this.match.planAiTurn(actor);
    const T = CONFIG.TIMING;
    const who = { ...actorOf(actor), ...(actor.team === 'players' ? { takeover: true } : {}) };
    let secs;
    if (boss) {
      // Boss 的招式：每一招只記純量欄位（招式、平面、目標、回血…），召喚的樹妖記 id；next = 預定的下一招
      const steps = boss.steps.map(st => {
        const o = {};
        for (const [k, v] of Object.entries(st)) if (v === null || typeof v !== 'object') o[k] = v;
        if (Array.isArray(st.spawns)) o.spawns = st.spawns.map(s => s.id);
        return o;
      });
      this.record('ai.turn', { ...who, boss: steps, next: boss.next && boss.next.action, changes: hpChanges(this.match, before) });
      this.io.broadcast({ t: 'aiTurn', actorId: actor.id, entities, walk: null, shot: null, boss });
      const stepSecs = boss.steps.reduce((s, st) => s + T.bossCast
        + (st.shot ? st.shot.flightFrames + st.shot.settleFrames : st.still.settleFrames) / 60, 0);
      secs = T.aiThink + stepSecs + T.afterShotPad;
    } else {
      const shot = plan ? this.match.resolveShot(actor, plan.weapon, plan.angle, plan.power) : null;
      this.record('ai.turn', {
        ...who, walk: walk ? { dir: walk.dir, frames: walk.frames } : null,
        ...(plan ? { weapon: plan.weapon, angle: r1(plan.angle), power: r1(plan.power), hit: shot.hit && shot.hit.type, kills: shot.kills } : { noShot: true }),
        changes: hpChanges(this.match, before),
      });
      this.io.broadcast({ t: 'aiTurn', actorId: actor.id, entities, walk, shot, splashes });
      secs = T.aiThink
        + (walk ? walk.frames / 60 : 0)
        + (shot ? T.aiAim + (shot.flightFrames + shot.settleFrames) / 60 : 0)
        + T.afterShotPad;
    }
    this.schedule(() => this.finishTurn(), secs);
  }

  // 跳過這回合（timeout / disconnected / water = 自己掉進水裡淹死）。客戶端只套最後的狀態、不重播落地過程，
  // 所以落水的水花要寫進訊息：splashes = 已經發生的那一次，加上落地途中（例如超時那一刻人在水面上空）掉下去的。
  // before = 紀錄用的血量快照（代打前先落地就淹死的，從那次落地之前算起；平常就是現在）
  skipTurn(reason, splashes = [], before = hpOf(this.match)) {
    this.phase = 'resolving';
    this.deadline = null;
    const actor = this.match.byId(this.currentId);
    if (actor) { actor.moveDir = 0; actor.aiming = false; }
    splashes.push(...this.settleWithSplashes());
    // changes = 跳過時大家落地途中的血量變化（例如超時那一刻人在水面上空、掉下去）
    this.record('turn.skip', {
      ...(actor ? actorOf(actor) : { actor: this.currentId }), reason,
      ...(splashes.length ? { splashes } : {}), changes: hpChanges(this.match, before),
    });
    this.io.broadcast({ t: 'skip', actorId: this.currentId, reason, entities: this.match.snapshot().entities, splashes });
    this.schedule(() => this.finishTurn(), CONFIG.TIMING.skipDelay);
  }

  // 讓所有人落地（伺服器自己跑、客戶端不重播的那種），回傳途中掉進水裡的水花
  settleWithSplashes(maxFrames = 300) {
    const falls = this.match.entities.map(e => e.waterFalls);
    this.match.settle(maxFrames);
    return this.match.entities.filter((e, i) => e.waterFalls !== falls[i]).map(splashOf);
  }

  gameOver(result) {
    this.cancelTimer();
    this.phase = 'over';
    this.deadline = null;
    // players = 這一關打完每位玩家的血量與擊殺數
    this.record('battle.over', {
      result, level: this.match.levelId,
      players: this.match.players.map(e => ({ pid: e.id, name: e.name, hp: r1(e.hp), alive: e.alive, kills: e.kills })),
    });
    this.io.broadcast({ t: 'gameOver', result, entities: this.match.snapshot().entities });
    if (this.onGameOver) this.onGameOver(result);
  }
}
