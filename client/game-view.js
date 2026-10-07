import { CONFIG } from '../shared/config.js';
import { Match } from '../shared/match.js';
import { replayVolley } from '../shared/volley.js';
import { clamp, lerpAngle } from '../shared/utils.js';
import { Renderer } from './render.js';
import { TerrainPainter } from './terrain-painter.js';
import { mapViewFor } from './map-views/index.js';
import { Music } from './music.js';
import { audio } from './audio.js';
import { sfx } from './sfx.js';

const FPS = 60;
const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const SLOT_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2 };
const STEP_STRIDE = 34;   // 走多少 px 踩一步（移動速度 130 px/s ≈ 每秒 4 步）

// 客戶端的遊戲畫面：
// - 自己的回合：本地物理即時操作，定時把位置回報給裁判，放開滑鼠送 fire
// - 其他事件（turn / aiTurn / shot / skip / turnFx / gameOver）排隊依序播放；
//   砲彈照伺服器給的出發點與事件逐幀重播（撞到什麼、傷害多少全聽伺服器的）
// - 每次 turn / shot 結果都會把角色狀態校正成伺服器的版本
// - 某一張地圖特有的演出（Boss 出招的動畫、死亡特效、選曲…）交給地圖畫面（this.mapView，見 client/map-views/index.js）
export class GameView {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new Renderer(this, canvas);
    this.transport = null;
    this.myId = null;
    this.match = null;
    this.painter = null;
    this.players = [];
    this.playerStatus = new Map();     // id → connected
    this.currentId = null;
    this.currentIsAi = false;
    this.round = 0;
    this.feverShown = 0;               // 已經用橫幅提示過的狂熱層數
    this.deadline = null;              // 本地時間 (performance.now)
    this.canAct = false;               // 現在能不能操作自己
    this.waiting = false;              // 已送出 fire，等伺服器結果
    this.queue = [];
    this.script = null;
    this.wait = null;
    this.aimAnim = null;               // AI 砲管轉向動畫 { id, angle, power }
    this.projectiles = [];
    this.particles = [];
    this.flashes = [];
    this.linkFlashes = [];             // 攜手之伴分擔傷害時，兩人之間閃一下的連線 { a, b, life }
    this.floatTexts = [];
    this.mapView = null;               // 這張地圖的地圖畫面（setup 時照地圖機制選，見 client/map-views/index.js）
    this.mapCtx = null;                // 給地圖畫面的掛勾用的 c（見 mapContext）
    this.looks = new WeakMap();        // 角色 → 只給畫面用的狀態（見 look）
    this.keys = {};
    this.mouse = { x: 0, y: 0, down: false };
    this.slowMo = false;               // 慢動作中（自己的回合在空中瞄準，見 frame）
    this.timeScale = 1;                // 畫面的速度倍率：main.js 每一步 update 的 dt = 固定步長 × 這個（慢動作時 < 1）
    this.time = 0;
    this.shake = 0;
    this.banner = null;
    this.hint = null;
    this.result = null;        // 本關戰鬥結果 'win' | 'lose' | null
    this.runOver = null;       // 整場冒險結束 { result, stage }
    this.stageInfo = null;     // { stage, stageCount, isBoss, levelName, cards }
    this.started = false;
    this.lastMoveSent = 0;
    this.lastSent = null;
    this.music = new Music();
    this.bindInput();
  }

  attach(transport) {
    this.transport = transport;
    transport.onMessage((m) => this.onMessage(m));
  }

  get me() { return this.match ? this.match.byId(this.myId) : null; }

  // 角色在這個畫面上的狀態（不是遊戲狀態，所以不放在 Entity 上；每次 setup 重來）：
  //   netTarget    遠端玩家插值的目標（他最後回報的位置）；netVy = 他回報的垂直速度（看他是不是剛起跳）
  //   slowMo       他開著慢動作（畫光環）
  //   splashShown  已經播過的那一次落水（Entity.splash）
  //   stepDist     走了多遠（踩腳步聲用）
  //   poisonDeath  是被毒倒的（換成「中毒倒下」的橫幅；又活過來就清掉）
  //   deathHandled 這次倒下已經播過死亡特效 / 橫幅（伺服器的狀態說他又活著 = 下次倒下再播）
  look(e) {
    let v = this.looks.get(e);
    if (!v) this.looks.set(e, v = { netTarget: null, netVy: 0, slowMo: false, splashShown: null, stepDist: 0, poisonDeath: false, deathHandled: false });
    return v;
  }

  // 上方的武器按鈕：照自己的武器欄排，第 N 格對應快捷鍵 N
  weaponButtons() {
    const ids = this.me ? this.me.weapons : CONFIG.EQUIP.startWeapons;
    const w = 140, gap = 14;
    const x0 = Math.round(CONFIG.WORLD_W / 2 - (ids.length * w + (ids.length - 1) * gap) / 2);
    return ids.map((id, i) => ({ id, slot: i + 1, x: x0 + i * (w + gap), y: 12, w, h: 44 }));
  }

  // ---------- 網路訊息 ----------
  onMessage(msg) {
    switch (msg.t) {
      case 'start':
        this.setup(msg);
        break;
      case 'state':
        this.setup(msg);
        this.restoreTurn(msg);
        break;
      // water 也走佇列：畫面還在播前面的事件時（分頁在背景、很卡），才不會先套上、又被之後才播的舊快照（他的 turn）蓋回掉水前的血量
      // pickup（喝到蛇血）也一樣：會改上限，不能被之後才播的舊快照蓋回去
      // slow（別人開 / 關慢動作）也是：畫面落後時，之後才播的他的 turn 會把光環清掉
      case 'turn': case 'aiTurn': case 'shot': case 'skip': case 'turnFx': case 'gameOver': case 'water': case 'pickup': case 'slow':
        if (msg.t === 'turn' && document.hidden) this.cueTurn(msg);   // 分頁在背景：輪到自己的提示音收到就響，不等前面的動畫播完
        this.queue.push(msg);
        this.pump();
        break;
      case 'picks':
        // 大家選完牌：更新手牌清單（下一關的 start 會帶完整資料）
        if (this.stageInfo) for (const s of msg.summary) (this.stageInfo.cards[s.playerId] ||= []).push(s.cardId);
        this.showBanner(msg.isBoss ? 'Boss 關即將開始…' : `準備進入第 ${msg.nextStage} 關…`, msg.isBoss ? '#f87171' : '#fde047');
        break;
      case 'runOver':
        this.runOver = { result: msg.result, stage: msg.stage, stageCount: msg.stageCount, isBoss: !!(this.stageInfo && this.stageInfo.isBoss) };
        this.canAct = false;
        this.waiting = false;
        break;
      case 'move':
        if (this.holdMoves) this.heldMoves.set(msg.id, msg);   // 重播一波時先收著（重播的物理不受影響），播完再套最新的
        else this.applyMove(msg);
        break;
      case 'weapon': {
        const e = this.match && this.match.byId(msg.id);
        if (e) e.weapon = msg.weapon;
        break;
      }
      case 'playerStatus':
        this.playerStatus.set(msg.id, msg.connected);
        break;
    }
  }

  applyMove(msg) {
    const e = this.match && this.match.byId(msg.id);
    if (e && msg.id !== this.myId) {
      const v = this.look(e);
      v.netTarget = { x: msg.x, y: msg.y };
      e.onVine = Number.isInteger(msg.vine) ? msg.vine : -1;   // 抓著藤蔓的姿勢
      if (msg.facing) e.facing = msg.facing;
      if (Number.isFinite(msg.stamina)) e.stamina = msg.stamina;
      if (Number.isFinite(msg.vy)) {   // 往上的速度突然變大 = 他剛起跳（含空中再跳一次）
        if (msg.vy < -200 && msg.vy < (v.netVy || 0) - 150) sfx.play('jump', { x: msg.x, vol: 0.7 });
        v.netVy = msg.vy;
      }
    }
  }

  flushMoves() {
    const held = [...this.heldMoves.values()];
    this.heldMoves.clear();
    for (const msg of held) this.applyMove(msg);
  }

  setup(msg) {
    if (this.script && this.mapView) this.mapView.abortScript(this.mapCtx);   // 還在播的事件腳本整個丟掉（下面清掉）
    this.holdMoves = false;
    this.heldMoves = new Map();
    if (this.slowMo) this.setSlowMo(false);
    this.match = new Match({ levelId: msg.levelId, players: msg.players, seed: msg.seed, carry: msg.carry || {}, stage: msg.stage || 1 });
    this.match.applySnapshot(msg.snapshot);
    this.looks = new WeakMap();
    this.mapView = mapViewFor(this.match);   // 一般小關 = plain（什麼都不演）
    this.mapCtx = this.mapContext(this.mapView.create(this.match));
    this.stageInfo = msg.stageInfo || msg.run || null;
    this.runOver = null;
    if (this.stageInfo) {
      this.showBanner(this.stageInfo.isBoss ? `Boss 關：${this.stageInfo.levelName}` : `第 ${this.stageInfo.stage} 關：${this.stageInfo.levelName}`, this.stageInfo.isBoss ? '#f87171' : '#fde047');
    }
    for (const e of this.match.entities) if (!e.alive) this.look(e).deathHandled = true;   // 重連時不要重播死亡特效
    this.players = msg.players;
    for (const p of msg.players) this.playerStatus.set(p.id, p.connected !== false);
    this.painter = new TerrainPainter(this.match.terrain, { platformStyle: this.match.level.platformStyle });
    this.queue = [];
    this.script = null;
    this.wait = null;
    this.aimAnim = null;
    this.projectiles = [];
    this.particles = [];
    this.flashes = [];
    this.linkFlashes = [];
    this.floatTexts = [];
    this.result = null;
    this.canAct = false;
    this.waiting = false;
    this.currentId = null;
    this.deadline = null;
    this.round = msg.round || 0;   // 新的一關從第 0 輪開始（重連的 state 會帶目前的輪數）
    this.feverShown = this.match.feverAt(this.round);
    this.started = true;
  }

  // 地圖畫面的掛勾拿到的 c：只開放這幾樣（說明見 client/map-views/index.js）。state = 地圖畫面自己這一場的狀態
  mapContext(state) {
    const view = this;
    return {
      get match() { return view.match; },
      get time() { return view.time; },
      get currentId() { return view.currentId; },
      get projectiles() { return view.projectiles; },
      shotScript: (shot, extra) => view.shotScript(shot, extra),
      state,
      // 特效出口：地圖畫面不直接動粒子、震動、橫幅、音效
      fx: {
        particles: (x, y, n, o) => view.spawnParticles(x, y, n, o),
        particle: (p) => { view.particles.push(p); },
        sound: (name, o) => sfx.play(name, o),
        banner: (str, color) => view.showBanner(str, color),
        float: (e, str, color, size) => view.floatText(e, str, color, size),
        shake: (n) => { view.shake = Math.max(view.shake, n); },
        splash: (x) => view.splash(x),
        wither: () => { if (view.painter) view.painter.setWithered(true); },
      },
    };
  }

  // 重連：直接回到目前的回合
  restoreTurn(msg) {
    this.currentId = msg.currentId;
    this.round = msg.round;
    const mine = msg.currentId === this.myId && msg.phase === 'turn';
    this.currentIsAi = !mine;
    this.canAct = mine;
    this.deadline = mine && msg.timeLeft != null ? performance.now() + msg.timeLeft * 1000 : null;
    if (msg.phase === 'over') this.result = this.match.result();
    // 伺服器記得行動玩家開著慢動作：是自己（重連前沒來得及送關，新的頁面沒開著）→ 送關（記一筆、別人的光環也會清掉）；
    // 是別人 → 在他身上畫光環
    if (msg.slowOn && msg.phase === 'turn') {
      if (mine) this.transport.send({ t: 'slow', on: false, why: 'reconnect' });
      else { const a = this.match.byId(msg.currentId); if (a) this.look(a).slowMo = true; }
    }
  }

  // 行動中的玩家開 / 關慢動作（只放慢他自己的畫面，他的動作會看起來變慢）：在他身上畫光環
  onSlow(msg) {
    const e = this.match.byId(msg.id);
    if (!e || msg.id === this.myId) return;
    this.look(e).slowMo = !!msg.on;
    if (msg.on) sfx.play('slowIn', { x: e.x, vol: 0.5 });
  }

  // ---------- 事件腳本（用 generator 逐幀推進，跟固定步長完全對齊） ----------
  pump() {
    if (this.script || !this.queue.length || !this.match) return;
    this.script = this.playScript(this.queue.shift());
    this.wait = null;
    this.advanceScript();
  }

  advanceScript() {
    try {
      const r = this.script.next();
      if (r.done) {
        this.script = null;
        this.wait = null;
        this.pump();
        return;
      }
      this.wait = r.value;
    } catch (err) {
      console.error('播放事件時出錯', err);
      this.script = null;
      this.wait = null;
      this.mapView.abortScript(this.mapCtx);   // 地圖畫面播到一半的出招（預兆、蓄力、閉眼…）不要留在畫面上
      this.pump();
    }
  }

  tickScript() {
    if (!this.script || !this.wait) return;
    const w = this.wait;
    if (w.frames !== undefined) {
      w.frames -= 1;
      if (w.frames > 0) return;
    } else if (w.until) {
      w.max -= 1;
      if (!w.until() && w.max > 0) return;
    }
    this.advanceScript();
  }

  *playScript(msg) {
    switch (msg.t) {
      case 'turn':
        this.beginTurn(msg);
        break;
      case 'aiTurn':
        yield* this.aiTurnScript(msg);
        break;
      case 'shot':
        yield* this.shotScript(msg);
        break;
      case 'skip':
        this.onSkip(msg);
        break;
      case 'water':
        this.onWater(msg);
        break;
      case 'pickup':
        this.onPickup(msg);
        break;
      case 'slow':
        this.onSlow(msg);
        break;
      case 'turnFx':
        yield* this.turnFxScript(msg);
        break;
      case 'gameOver':
        if (msg.entities) this.match.applyEntities(msg.entities);
        yield { frames: 40 };
        this.result = msg.result;
        this.canAct = false;
        this.waiting = false;
        this.currentId = null;
        break;
    }
  }

  beginTurn(msg) {
    this.match.applyEntities(msg.entities);
    this.setItems(msg);
    for (const e of this.match.entities) {
      e.moveDir = 0; e.vineDir = 0; e.aiming = false;
      const v = this.look(e);
      v.netTarget = null; v.slowMo = false;
    }
    this.currentId = msg.actorId;
    this.round = msg.round;
    this.currentIsAi = !!msg.ai;
    const actor = this.match.byId(msg.actorId);
    const mine = msg.actorId === this.myId && !msg.ai;
    this.canAct = mine;
    this.waiting = false;
    this.mouse.down = false;
    this.lastSent = null;
    this.deadline = mine && msg.turnTime ? performance.now() + msg.turnTime * 1000 : null;
    if (!actor) return;
    for (const fx of msg.fx || []) {   // 回合開始的效果（中毒結算、站在蛇血上喝掉、恩賜之杖回血）
      const e = this.match.byId(fx.id);
      if (!e) continue;
      if (fx.type === 'heal') this.floatText(e, `+${fx.amount}`, '#4ade80');
      else this.statusFx(e, fx);
    }
    const kind = msg.extra ? '額外回合' : '回合';   // 時間扭曲給的額外回合
    const fever = this.feverNotice();
    if (mine) {
      this.cueTurn(msg);
      this.showBanner(`你的${kind}`, msg.extra ? '#c4b5fd' : '#7dd3fc', fever);
    } else {
      const tag = msg.ai && actor.team === 'players' ? '（AI 代打）' : '';
      this.showBanner(`${actor.name} 的${kind}${tag}`, msg.extra ? '#c4b5fd' : (actor.team === 'players' ? '#86efac' : '#fca5a5'), fever);
    }
  }

  // 輪到自己的回合（單人、多人都一樣；含時間扭曲的額外回合，不含斷線時的 AI 代打）：響一聲提示音。
  // 平常跟「你的回合」橫幅一起響；分頁在背景時瀏覽器會放慢計時器、畫面落後，伺服器的回合倒數卻已經開始了，
  // 所以收到 turn 訊息（或切走時佇列裡已經排著）就先響。同一個回合只響一次（msg.cued）。重連回到自己的回合不響
  cueTurn(msg) {
    if (msg.cued || msg.ai || msg.actorId !== this.myId) return;
    msg.cued = true;
    sfx.play('yourTurn');
  }

  // 狂熱剛疊上新的一層（新的一輪跨過門檻）：回傳橫幅底下的提示字，每層只提示一次。Boss 關一直是 0 層，不會提示
  feverNotice() {
    const n = this.match.feverAt(this.round);
    if (n <= this.feverShown) return null;
    this.feverShown = n;
    return `狂熱！所有角色的傷害 +${n * CONFIG.FEVER.damagePct}%`;
  }

  // 背景音樂：小關放山谷曲，狂熱生效後換狂熱版（跟狂熱橫幅同一刻）；Boss 關由地圖畫面決定（例如古樹之庭、叢林巨蟒）。
  // 曲目表在 music.js 的 TRACKS
  musicTrack() {
    if (!this.started || !this.match) return null;
    if (this.match.level.pool === 'normal') return this.match.feverAt(this.round) > 0 ? 'fever' : 'normal';
    return this.mapView.musicTrack(this.mapCtx);
  }

  *aiTurnScript(msg) {
    const actor = this.match.byId(msg.actorId);
    if (!actor) return;
    const splashes = this.serverSplashes(msg.splashes);   // 斷線代打：伺服器先讓他落地，途中掉進水裡的那一次
    if (msg.entities) this.match.applyEntities(msg.entities);
    for (const s of splashes) this.onSplash(this.match.byId(s.id), s);
    if (msg.boss) {   // 由地圖機制出招（例如古樹、巨蟒、小心擊發的蜜蜂）：動畫由地圖畫面播
      yield* this.mapView.turnScript(this.mapCtx, msg);
      return;
    }
    const v = this.look(actor);
    v.netTarget = null;
    v.slowMo = false;   // 開著慢動作時斷線、AI 代打：光環清掉
    yield { frames: CONFIG.TIMING.aiThink * FPS };
    if (msg.walk && actor.alive) {
      actor.moveDir = msg.walk.dir;
      yield { frames: msg.walk.frames };
      actor.moveDir = 0;
    }
    if (msg.shot) {
      actor.aiming = true;
      actor.facing = msg.shot.facing;
      actor.weapon = msg.shot.weapon;
      this.aimAnim = { id: actor.id, angle: msg.shot.angle, power: msg.shot.power };
      yield { frames: CONFIG.TIMING.aiAim * FPS };
      this.aimAnim = null;
      actor.aiming = false;
      yield* this.shotScript(msg.shot);
    }
  }

  // 重播一發（或一波轟炸）：shared/volley.js 照伺服器的事件逐幀重播（跟伺服器同一個幀迴圈）。
  // 每一幀的角色物理在 update 原本的位置由 tick.step() 跑（見 update），飛行物與事件在下面的 tickScript 裡；
  // 這裡只管畫面（出發、事件的特效 / 飄字）與最後的校正。extra.frame = 每個飛行幀結束時呼叫（蜜蜂的衝刺用）
  *shotScript(shot, extra = {}) {
    const run = replayVolley(this.match, shot);   // 格式壞掉會在這裡丟錯（還在 advanceScript 的 try 裡）
    if (!run) return;
    const actor = this.match.byId(shot.actorId);
    const weapon = CONFIG.WEAPONS[shot.weapon];
    if (shot.kind === 'bombard') {
      // 回合開始的轟炸：這時已經輪到持有者了（turn 訊息要等轟炸播完才會來）
      this.currentId = shot.actorId;
      if (shot.round) this.round = shot.round;
      this.canAct = false;
      this.waiting = false;
      this.showBanner(`${actor ? actor.name : ''} 的無差別轟炸！`, '#fb7185', this.feverNotice());
    } else if (actor) {
      // 射手的位置 / 血量 / 藤蔓由重播模組照 shot.actor 擺好（第一個 next()）；這裡只清客戶端自己的狀態
      const v = this.look(actor);
      v.netTarget = null;
      v.slowMo = false;
      if (actor.id === this.myId) this.waiting = false;   // 結果到了，射手接著照伺服器的狀態動
    }

    // 重播中隊友的 move 先收著（見 onMessage 的 'move'）：他照物理跑、跟伺服器一致，播完才套最新的那筆
    this.holdMoves = true;
    this.heldMoves ||= new Map();
    this.projectiles = run.live;   // 同一個陣列：模組原地更新（render、地圖畫面的 c.projectiles 都讀它）
    let played = false;
    try {
      yield* run.frames({
        spawn: (p) => { if (shot.kind === 'weapon') this.showLaunch(weapon, p); },
        event: (ev, p, made) => this.showShotEvent(shot, weapon, ev, made),
        frame: extra.frame,
      });   // 剛好 flightFrames + settleFrames 幀（沉降也照伺服器的幀數）
      played = true;
    } finally {
      this.holdMoves = false;
      if (!played) this.flushMoves();   // 播到一半丟錯：收著的 move 不要卡到下一波
      this.projectiles = [];   // 飛到一半丟錯也清掉：不然凍住的飛行物會一直畫著（大地震擊還會一直噴碎石）
    }
    if (run.drift.length) console.warn('重播跟伺服器對不起來', run.drift);

    const stacksBefore = actor ? [actor.readyStacks, actor.huntStacks] : null;
    this.match.applyEntities(shot.results);   // 校正成伺服器結果
    this.flushMoves();   // 重播中收到的 move（比 results 新）：現在才套上
    if (actor && shot.hitEnemy !== undefined) {   // 磨刀霍霍 / 越戰越強的層數變化
      const m = actor.mods;
      if (m.missDamagePct > 0 && actor.readyStacks !== stacksBefore[0]) {
        this.floatText(actor, actor.readyStacks ? `準備 ×${actor.readyStacks}` : '準備 歸零', '#fcd34d');
      }
      if (m.hitDamagePct > 0 && actor.huntStacks !== stacksBefore[1]) {
        this.floatText(actor, actor.huntStacks ? `狂獵 ×${actor.huntStacks}` : '狂獵 歸零', '#f87171');
      }
    }
    if (actor && shot.kills && shot.kills.length && actor.mods.killDamagePct > 0) {
      this.floatText(actor, `噬魂 +${shot.kills.length * actor.mods.killDamagePct}%`, '#c084fc');
    }
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }

  // 一顆飛行物出發（自己 / 隊友 / AI 開火）：砲聲、砲口的火花、震一下
  showLaunch(weapon, p) {
    sfx.play(weapon.id === 'sniper' ? 'sniper' : 'cannon', { x: p.x });
    this.spawnParticles(p.x, p.y, 8, { speed: 140, life: 0.25, size: 3, color: weapon.id === 'plasma' ? '#67e8f9' : '#ffcc66', gravity: 0 });
    this.shake = Math.max(this.shake, weapon.gravity > 0 ? 5 : 2);
  }

  // 一個飛行事件的畫面（狀態已經由 shared/volley.js 套好：飛行物、挖坑、角色的事件狀態、地圖機制建的道具 / 角色）：
  // 特效、重畫挖掉的地形（made.rect）、地圖畫面的演出（例如蛇血 / 蜜蜂飛出來：made.items / made.bees）、傷害飄字
  showShotEvent(shot, weapon, ev, made) {
    switch (ev.type) {
      case 'bounce':
        this.spawnParticles(ev.x, ev.y, 6, { speed: 160, life: 0.3, size: 2, color: '#fef08a', gravity: 300 });
        break;
      case 'pierce':
        this.spawnParticles(ev.x, ev.y, 8, { speed: 150, life: 0.35, size: 3, color: '#fca5a5', gravity: 400 });
        break;
      case 'return':
        this.spawnParticles(ev.x, ev.y, 6, { speed: 120, life: 0.3, size: 3, color: '#fcd34d', gravity: 300 });
        break;
      case 'water':
        this.splash(ev.x);
        sfx.play('plop', { x: ev.x });
        break;
      case 'explode': {
        if (made.rect) this.painter.repaintRect(made.rect);
        const r = ev.carve ? ev.carve.r : 8;
        const big = r >= 25;
        sfx.play('explode', { x: ev.x, big });
        const tint = weapon.id === 'plasma' ? '165,243,252' : weapon.id === 'bombard' ? '251,113,133' : '255,220,120';
        this.spawnParticles(ev.x, ev.y, big ? 24 : 8, { speed: big ? 240 : 120, life: 0.7, size: 4, color: '#8b5a2b', gravity: 700 });
        this.spawnParticles(ev.x, ev.y, big ? 12 : 4, { speed: 90, life: 0.5, size: big ? 8 : 5, color: `rgb(${tint})`, gravity: -60 });
        this.flashes.push({ x: ev.x, y: ev.y, r: r * 1.4, life: 0.25, maxLife: 0.25, tint });
        this.shake = Math.max(this.shake, big ? (weapon.id === 'bombard' ? 7 : 12) : 3);
        if (weapon.poison) this.spawnParticles(ev.x, ev.y, 10, { speed: 120, life: 0.5, size: 3, color: '#a855f7', gravity: 300 });   // 毒液濺開
        break;
      }
    }
    this.mapView.showEvent(this.mapCtx, ev, made);   // 例如打到巨蟒跨過門檻掉蛇血、打到蜂巢飛出蜜蜂
    for (const d of ev.damages || []) {
      const e = this.match.byId(d.id);
      if (!e) continue;
      if (d.blocked) {
        this.floatText(e, '無敵', '#fde68a');
        this.spawnParticles(e.cx, e.cy, 12, { speed: 140, life: 0.5, size: 3, color: '#fde68a', gravity: 0 });
        continue;
      }
      if (this.mapView.showDamage(this.mapCtx, e, d)) continue;   // 地圖畫面自己演的（例如古樹之口被打到閉上，不扣血）
      if (d.shared) {   // 攜手之伴：連結的隊友被打，分到的那一份
        if (d.dmg > 0) {
          e.hurtTimer = 0.35;
          this.floatText(e, `-${d.dmg} 分擔`, '#f0abfc', 16);
          const from = this.match.byId(d.shared);
          if (from) this.linkFlashes.push({ a: from.id, b: e.id, life: 0.45 });
        }
        continue;
      }
      if (d.dmg > 0) {
        e.hurtTimer = 0.35;
        sfx.play('hurt', { x: e.cx });
        const color = d.friendly ? '#f9a8d4' : (e.team === 'players' ? '#ff6b6b' : '#ffd166');
        this.floatText(e, `-${d.dmg}${d.friendly ? ' 誤傷' : ''}`, color);
      }
      if (d.burn) this.floatText(e, `燃燒 +${d.burn}`, '#fb923c', 15);
      if (d.poison) {   // 上毒（例如巨蟒、蜜蜂；傷害 0 的衝撞 / 噴灑也會有）
        e.hurtTimer = 0.35;
        this.floatText(e, `中毒 +${d.poison}`, '#c084fc', 16);
      }
    }
    const owner = ev.heal ? this.match.byId(shot.actorId) : null;
    if (owner) this.floatText(owner, `+${ev.heal} 吸血`, '#4ade80', 16);
  }

  // 回合結束的裝備效果：燃燒扣血 / 甩掉層數、神佑之石、燒死敵人的噬魂加成
  *turnFxScript(msg) {
    if (msg.atStart) {   // 回合根本沒開始（回合開始就被毒倒）：現在是他的回合位置，HUD 不要還停在上一位
      this.currentId = msg.actorId;
      if (msg.round) this.round = msg.round;
      this.canAct = false;
      this.waiting = false;
    }
    const banners = [];   // 同一次回合結束可能同時有好幾個（神佑之石 + 時間扭曲），合成一行才不會互相蓋掉
    for (const fx of msg.fx) {
      const e = this.match.byId(fx.id);
      if (!e) continue;
      if (fx.type === 'burn') {
        if (fx.dmg > 0) {
          e.hurtTimer = 0.35;
          this.floatText(e, `-${fx.dmg} 燃燒`, '#fb923c');
          this.spawnParticles(e.cx, e.cy, 12, { speed: 70, life: 0.7, size: 4, color: '#f97316', gravity: -160 });
        }
        if (fx.shaken > 0) this.floatText(e, `甩掉 ${fx.shaken} 層燃燒`, '#fdba74', 14);
      } else if (fx.type === 'shield') {
        banners.push([`${e.name} 的神佑之石：全隊無敵一次`, '#fde68a']);
        for (const id of fx.ids) {
          const t = this.match.byId(id);
          if (!t) continue;
          this.floatText(t, '神佑！', '#fde68a');
          this.spawnParticles(t.cx, t.cy, 14, { speed: 110, life: 0.6, size: 3, color: '#fde68a', gravity: -40 });
        }
      } else if (fx.type === 'soul') {
        this.floatText(e, `噬魂 ${fx.soul}%`, '#c084fc');
      } else if (fx.type === 'extraTurn') {
        banners.push([`${e.name} 的時間扭曲：再來一回合！`, '#c4b5fd']);
        this.floatText(e, '額外回合', '#c4b5fd');
        this.spawnParticles(e.cx, e.cy, 16, { speed: 120, life: 0.7, size: 3, color: '#c4b5fd', gravity: -30 });
      } else if (!this.mapView.turnFx(this.mapCtx, e, fx)) {   // 地圖畫面的（例如古樹之口又張開了、巨蟒被燒到掉出蛇血）
        this.statusFx(e, fx);   // 中毒結算把人毒倒了（回合開始時，這回合就不開始了）
      }
    }
    if (banners.length) this.showBanner(banners.map(b => b[0]).join('　·　'), banners[0][1]);
    if (msg.entities) this.match.applyEntities(msg.entities);
    this.setItems(msg);
    yield { frames: Math.round(CONFIG.TIMING.fxDelay * FPS * 0.6) };
  }

  // 中毒結算的飄字與特效（回合開始的 fx、回合沒開始就被毒倒的 turnFx 都用這個）；其他狀態效果（例如喝到蛇血）交給地圖畫面
  statusFx(e, fx) {
    if (fx.type === 'poison') {
      e.hurtTimer = 0.35;
      if (fx.died) this.look(e).poisonDeath = true;   // onDeath 換成「中毒倒下」的橫幅
      this.floatText(e, fx.dmg > 0 ? `-${fx.dmg} 中毒` : '中毒', '#c084fc');
      if (fx.lock > 0) this.floatText(e, `上限 -${fx.lock}`, '#9ca3af', 15);
      this.spawnParticles(e.cx, e.cy, 14, { speed: 80, life: 0.7, size: 4, color: '#a855f7', gravity: -120 });
    } else {
      this.mapView.statusFx(this.mapCtx, e, fx);
    }
  }

  // turn / turnFx 帶的場上道具：換成伺服器的版本（還在飛的道具動畫在地圖畫面裡照 id 對，不用搬）。
  // 道具是地圖機制的狀態（目前只有巨蟒的蛇血）：交給機制的 restore，只帶 items 這一欄；沒帶就不動
  setItems({ items }) {
    if (items) this.match.mechanic.restore(this.match, { items });
  }

  // 行動玩家走路途中撿到道具（伺服器廣播給所有人，包括他自己）：怎麼套由地圖畫面決定（例如喝到蛇血）
  onPickup(msg) {
    const e = this.match.byId(msg.id);
    if (!e) return;
    this.mapView.onPickup(this.mapCtx, e, msg, msg.id === this.myId);
  }

  // skip / aiTurn 帶來的水花：伺服器自己讓大家落地、客戶端沒有重播的那段，照伺服器給的播。淹死的由 onDeath 播；
  // 自己的角色在本地物理裡已經掉過那一次（例如超時那一刻正往水裡掉）就不再播——要在套用狀態之前比落水次數
  serverSplashes(list) {
    return (list || []).filter(s => {
      const e = this.match.byId(s.id);
      return e && !s.died && !(s.id === this.myId && e.waterFalls >= s.n);
    });
  }

  // 輪到的那位玩家自己掉進水裡、撐住了：直接放到重生點（不要從水裡滑過去）、播水花；他的回合繼續。
  // 放掉 netTarget：他接著走的位置由下一個 move 帶來（還沒來之前就站在重生點）
  onWater(msg) {
    const e = this.match.byId(msg.id);
    if (!e || msg.id === this.myId) return;   // 自己的畫面早就先算好了
    e.applyState(msg.state);
    this.look(e).netTarget = null;
    this.onSplash(e, msg.splash);
  }

  onSkip(msg) {
    const splashes = this.serverSplashes(msg.splashes);
    if (msg.entities) this.match.applyEntities(msg.entities);
    const a = this.match.byId(msg.actorId);
    if (a) { const v = this.look(a); v.netTarget = null; v.slowMo = false; }   // 不要再滑回他最後回報的位置（例如掉進水裡的那一點）
    const name = a ? a.name : '';
    // 淹死（water）的橫幅由 onDeath 播
    if (msg.reason === 'timeout') this.showBanner(msg.actorId === this.myId ? '時間到！' : `${name} 時間到`, '#fbbf24');
    else if (msg.reason !== 'water') this.showBanner(`${name} 跳過`, '#fbbf24');
    for (const s of splashes) this.onSplash(this.match.byId(s.id), s);
    this.canAct = false;
    this.waiting = false;
    this.mouse.down = false;
  }

  // ---------- 輸入 ----------
  bindInput() {
    window.addEventListener('keydown', (ev) => {
      if (!this.started) return;
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const code = ev.code;
      if (['KeyA', 'KeyD', 'Space'].includes(code)) ev.preventDefault();   // 空白鍵不捲動頁面、也不觸發剛點過的按鈕
      if (ev.repeat) return;
      this.keys[code] = true;
      if (code === 'Space' && this.canAct && this.me && this.me.alive) this.me.wantJump = true;   // 空白鍵跳躍
      if (code in SLOT_KEYS && this.me) this.selectWeapon(this.me.weapons[SLOT_KEYS[code]]);
      if (code === 'KeyR' && this.runOver) location.reload();
      if (code === 'KeyM') this.showBanner(audio.toggleMusic() ? '音樂：關（M 開啟）' : `音樂：開 ${audio.volume('music')}%（M 關閉）`, '#e5e7eb');
    });
    window.addEventListener('keyup', (ev) => { this.keys[ev.code] = false; });
    window.addEventListener('blur', () => { this.keys = {}; });
    // 切到別的分頁時，自己的回合已經排在佇列裡（畫面還在播前面的動畫）：提示音現在就響，見 cueTurn
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) for (const m of this.queue) if (m.t === 'turn') this.cueTurn(m);
    });

    const toWorld = (ev) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: (ev.clientX - r.left) * CONFIG.WORLD_W / r.width, y: (ev.clientY - r.top) * CONFIG.WORLD_H / r.height };
    };
    window.addEventListener('mousemove', (ev) => Object.assign(this.mouse, toWorld(ev)));
    this.canvas.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0 || !this.started) return;
      Object.assign(this.mouse, toWorld(ev));
      if (this.runOver) { location.reload(); return; }
      const btn = this.weaponButtons().find(b => inRect(this.mouse, b));
      if (btn) { this.selectWeapon(btn.id); return; }
      if (this.canAct) this.mouse.down = true;
    });
    window.addEventListener('mouseup', (ev) => {
      if (ev.button !== 0 || !this.mouse.down) return;
      this.mouse.down = false;
      Object.assign(this.mouse, toWorld(ev));
      if (this.canAct && this.me && this.me.aiming) {
        this.updateAim();   // 用放開瞬間的位置再算一次
        this.fire();
      }
    });
    this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  }

  selectWeapon(id) {
    const me = this.me;
    if (!me || !me.weapons.includes(id)) return;
    me.weapon = id;
    if (this.canAct) this.transport.send({ t: 'weapon', weapon: id });
  }

  // 依滑鼠位置算角度（方向）與力量（距離）
  updateAim() {
    const me = this.me;
    const m = me.muzzle();
    const dx = this.mouse.x - m.x, dy = this.mouse.y - m.y;
    const dist = Math.hypot(dx, dy);
    me.aimAngle = Math.atan2(-dy, dx) * 180 / Math.PI;
    const A = CONFIG.AIM;
    const t = clamp((dist - A.minDist) / (A.maxDist - A.minDist), 0, 1);
    me.aimPower = Math.round(A.minPower + t * (A.maxPower - A.minPower));
    me.facing = dx >= 0 ? 1 : -1;
  }

  updateInput() {
    const me = this.me;
    if (!me) return;
    if (!this.canAct || !me.alive) { me.moveDir = 0; me.vineDir = 0; me.aiming = false; me.hangDrain = false; return; }
    me.hangDrain = true;   // 自己的回合：掛在藤蔓上也耗體力，用完就鬆手（Entity.updateVine）；回合一結束就關掉，一直掛著
    me.moveDir = (this.keys.KeyA ? -1 : 0) + (this.keys.KeyD ? 1 : 0);
    me.vineDir = (this.keys.KeyW ? -1 : 0) + (this.keys.KeyS ? 1 : 0);   // 藤蔓：按住 W / S 抓住、上下爬
    if (this.mouse.down) {
      me.aiming = true;
      this.updateAim();
    }
    // 位置有變才回報，最多每 1/moveSendHz 秒（真實時間；慢動作時 this.time 走得比較慢）一次（vine = 抓著第幾條藤蔓，伺服器才知道他是掛著）
    if (this.time - this.lastMoveSent >= this.timeScale / CONFIG.TIMING.moveSendHz) {
      const s = this.lastSent;
      if (!s || s.x !== me.x || s.y !== me.y || s.facing !== me.facing || s.vine !== me.onVine) this.sendMove(me);
    }
  }

  sendMove(me) {
    this.lastMoveSent = this.time;
    this.lastSent = { x: me.x, y: me.y, facing: me.facing, vine: me.onVine };
    this.transport.send({ t: 'move', x: me.x, y: me.y, vy: me.vy, facing: me.facing, stamina: me.stamina, vine: me.onVine });
  }

  fire() {
    const me = this.me;
    if (!this.canAct || !me || !me.alive) return;
    if (this.slowMo) this.setSlowMo(false, 'fire');   // 先關慢動作（伺服器照順序記），這一發照正常速度結算、重播
    me.aiming = false;
    me.hangDrain = false;
    me.wantJump = false;   // 跟開火同一幀按的 W 沒有送出去，伺服器是照沒跳的狀態結算
    this.canAct = false;
    this.waiting = true;
    me.moveDir = 0;
    me.vineDir = 0;
    // 空中也能開火：連同當下的垂直速度一起送，伺服器從同一個狀態接著算落地；掛在藤蔓上開火就帶 vine
    this.transport.send({
      t: 'fire', weapon: me.weapon, angle: me.aimAngle, power: me.aimPower,
      x: me.x, y: me.y, vy: me.vy, facing: me.facing, stamina: me.stamina, vine: me.onVine,
    });
  }

  // ---------- 慢動作 ----------
  // main.js 每一步 update 之前呼叫（realDt = 這一步代表的真實時間）：自己的回合「跳起來」之後（Entity.midJump：真的按了跳、還沒落地、沒抓藤蔓；
  // 走下坡 / 走下台階的那種離地不算）按住左鍵瞄準就開慢動作，每真實秒扣 SLOWMO.cost 體力；
  // 體力扣光、落地 / 抓到藤蔓 / 掉進水裡就解除（放開左鍵開火在 fire 裡解除）。timeScale 決定接下來每一步 update 的 dt：
  // 只有自己操作的那段會放慢——播事件腳本、別人的回合一定是 1，重播才會跟伺服器的固定步長一樣
  frame(realDt) {
    const S = CONFIG.SLOWMO;
    const me = this.me;
    const acting = !!(me && me.alive && this.canAct && !this.waiting);
    const want = acting && !!S && S.scale < 1 && !this.script && this.mouse.down && me.midJump && me.stamina > 0;
    if (want !== this.slowMo) {
      // 回合還在才告訴伺服器為什麼關掉（回合結束 / 倒下的話伺服器那邊已經換人了，只在自己的畫面關掉）
      const why = want || !acting ? null : me.stamina <= 0 ? 'stamina' : this.mouse.down ? 'land' : 'release';
      this.setSlowMo(want, why);
    }
    if (this.slowMo) me.stamina = Math.max(0, me.stamina - S.cost * realDt);
    this.timeScale = this.slowMo ? Math.max(S.scale, this.timeScale - (1 - S.scale) * realDt / Math.max(0.001, S.rampIn)) : 1;
  }

  // 開 / 關慢動作：背景音樂跟著放慢、音效、自己身上的光環。why = 回合中關掉的原因，開的時候或有 why 才告訴伺服器（記紀錄、讓別人畫光環）
  setSlowMo(on, why = null) {
    this.slowMo = on;
    if (!on) this.timeScale = 1;
    const me = this.me;
    if (me) this.look(me).slowMo = on;
    this.music.setRate(on ? CONFIG.SLOWMO.musicRate : 1);
    if (on) sfx.play('slowIn', { x: me.x });
    else if (why && why !== 'fire') sfx.play('slowOut', { x: me.x });   // 開火的那次有砲聲
    if (on || why) {
      // 先回報現在的位置 / 體力（不等節流）：伺服器記 slowmo 時才是跳起來之後的位置，不是起跳前站著的地方
      this.sendMove(me);
      this.transport.send({ t: 'slow', on, ...(why ? { why } : {}) });
    }
  }

  // ---------- 更新 ----------
  update(dt) {
    this.time += dt;
    this.shake = Math.max(0, this.shake - 24 * dt);
    if (this.banner && (this.banner.timer -= dt) <= 0) this.banner = null;
    if (this.hint && (this.hint.timer -= dt) <= 0) this.hint = null;
    this.music.play(this.musicTrack());
    if (!this.match) return;

    this.updateInput();

    const w = this.wait;
    if (w && w.step) {
      // 重播一波的幀（shared/volley.js 的 tick）：這一幀的角色物理就是 tick.step() = match.step 剛好一次（不能再自己跑一次）；
      // 飛行物與事件在下面的 tickScript 裡
      const pre = this.match.entities.map(e => [e, e.x, e.y, e.wantJump]);
      w.step();
      for (const [e, px, py, wantedJump] of pre) this.moveSfx(e, px, py, wantedJump);
    } else this.stepEntities(dt);

    if (this.aimAnim) {
      const e = this.match.byId(this.aimAnim.id);
      if (e) {
        e.aimAngle = lerpAngle(e.aimAngle, this.aimAnim.angle, Math.min(1, 6 * dt));
        e.aimPower = Math.round(this.aimAnim.power);
      }
    }
    // 飛行物由 shotScript 逐幀推進（在下面的 tickScript 裡）

    for (const e of this.match.entities) {
      const v = this.look(e);
      if (e.splash && e.splash !== v.splashShown) {   // 本地物理裡掉進水裡（自己操作、重播開火 / AI 走路）
        v.splashShown = e.splash;
        if (e.id === this.myId && this.canAct) this.reportWater(e);
        if (!e.splash.died) this.onSplash(e, e.splash);   // 淹死的由 onDeath 播
      }
      if (e.alive) {   // 伺服器的狀態把他救回來了（applyState）：下次倒下再播，也不再是「中毒倒下」（除非又被毒倒）
        if (v.deathHandled) v.poisonDeath = false;
        v.deathHandled = false;
      } else if (!v.deathHandled) {
        v.deathHandled = true;
        this.onDeath(e);
      }
    }
    this.updateEffects(dt);
    this.tickScript();
    this.mapView.update(this.mapCtx, dt);   // 地圖畫面的動畫 / 特效照遊戲時間推進（不照畫了幾次）
  }

  // 遠端玩家：平滑插值到他回報的位置（不跑物理）
  followNet(e, dt) {
    const t = this.look(e).netTarget;
    e.x += (t.x - e.x) * 0.35;
    e.y += (t.y - e.y) * 0.35;
    if (Math.abs(t.x - e.x) < 0.3 && Math.abs(t.y - e.y) < 0.3) { e.x = t.x; e.y = t.y; }
    e.hurtTimer = Math.max(0, e.hurtTimer - dt);
  }

  // 不是重播的幀：每個角色自己跑物理（自己操作、AI 走路、等待…）
  stepEntities(dt) {
    const world = this.match.world;
    for (const e of this.match.entities) {
      const px = e.x, py = e.y, wantedJump = e.wantJump;   // 給 moveSfx 比這一幀前後的差別
      if (this.look(e).netTarget && e.id !== this.myId) {
        this.followNet(e, dt);
      } else if (this.waiting && e.id === this.myId) {
        // 開火後等伺服器的結果：先停在出手的位置。空中開火時才不會自己先掉下去（甚至先淹死）再被拉回出手點
      } else {
        const falls = e.waterFalls;
        e.update(dt, world);
        // 自己的回合走過道具（例如蛇血），先在本地撿（跟伺服器同一套判斷）——之後在本地掉水才會照撿了之後的狀態算，跟伺服器一樣。
        // 撿到了就馬上回報位置：伺服器檢查的線段就停在道具上，一定也會判到（之後的 pickup 只是確認）
        if (e.id === this.myId && this.canAct && e.waterFalls === falls && this.mapView.predictMove(this.mapCtx, e, px, py)) this.sendMove(e);
      }
      this.moveSfx(e, px, py, wantedJump);
    }
  }

  // 自己操作時掉進水裡：本地已經先扣血、回到岸上（或淹死），把落水的那一點與最後站穩的地方回報給伺服器結算。
  // 撐住了回合繼續（還有體力就能接著動）；按著的方向鍵要放開重按才會再走，免得一回到崖邊又直接走下去。淹死就等伺服器的 skip
  reportWater(me) {
    const s = me.splash;
    this.transport.send({ t: 'move', x: s.x, y: s.y, facing: me.facing, stamina: me.stamina, safe: { x: s.sx, y: s.sy } });
    this.keys.KeyA = this.keys.KeyD = false;   // 按住不放的 keydown 是 repeat，會被忽略，所以要重按
    if (s.died) {
      this.canAct = false;
      this.deadline = null;
      this.mouse.down = false;
    }
  }

  // 腳步聲、起跳聲：比這一幀前後的差別（自己 / AI 跑本地物理；遠端玩家是插值到他回報的位置，他的起跳看 move 帶的 vy）
  moveSfx(e, px, py, wantedJump) {
    if (!e.alive) return;
    if (wantedJump && !e.wantJump && e.vy < -e.jumpSpeed * 0.8) sfx.play('jump', { x: e.x });   // 真的跳起來了（體力不夠就沒跳）
    const dx = Math.abs(e.x - px);
    const v = this.look(e);
    // 太大的位移是校正 / 重生瞬移，不算走路
    const walking = dx > 0.2 && dx < 12 && (v.netTarget ? Math.abs(e.y - py) < 1.5 : e.moveDir !== 0 && e.onGround);
    if (!walking) { v.stepDist = STEP_STRIDE * 0.7; return; }   // 停下來再起步時，很快就踩第一步
    v.stepDist = (v.stepDist || 0) + dx;
    if (v.stepDist < STEP_STRIDE) return;
    v.stepDist -= STEP_STRIDE;
    sfx.play('step', { x: e.x, vol: e.id === this.myId ? 1 : 0.6 });
  }

  // 掉進水裡、撐住了：水花、扣血飄字（人已經回到岸上）
  onSplash(e, s) {
    this.splash(s.x);
    this.splash(s.x);
    sfx.play('splash', { x: s.x });
    e.hurtTimer = 0.35;
    this.floatText(e, `-${s.dmg} 落水`, e.team === 'players' ? '#ff6b6b' : '#ffd166');
    this.spawnParticles(e.cx, e.cy, 10, { speed: 90, life: 0.5, size: 3, color: '#9ed0ff', gravity: 500 });
    this.showBanner(`${e.name} 掉進水裡了！`, '#93c5fd');
  }

  onDeath(e) {
    if (this.mapView.onDeath(this.mapCtx, e)) return;   // 地圖畫面自己的死亡特效（例如古樹倒下、巨蟒倒下、蜂巢被打掉）
    if (this.look(e).poisonDeath) { this.showBanner(`${e.name} 中毒倒下了！`, '#c084fc'); return; }
    if (e.deathCause === 'water') {
      this.splash(e.x);
      this.splash(e.x);
      sfx.play('splash', { x: e.x });
      this.showBanner(`${e.name} 掉進水裡了！`, '#93c5fd');
    } else {
      this.showBanner(`${e.name} 被擊倒！`, '#fde047');
    }
  }

  // ---------- 特效 ----------
  // sub = 主標題底下的第二行（狂熱提示），有的話橫幅多停一下
  showBanner(str, color, sub = null) {
    const t = sub ? 2.4 : 1.6;
    this.banner = { text: str, color, sub, timer: t, total: t };
  }
  showHint(str) { this.hint = { text: str, timer: 1.5 }; }

  // 角色頭上的飄字；同一個角色短時間內的多行字往上疊，不會重在一起
  floatText(e, str, color, size = 20) {
    const stacked = this.floatTexts.filter(f => f.id === e.id && f.life > 0.8).length;
    this.floatTexts.push({ id: e.id, x: e.cx, y: e.y - e.h - 22 - stacked * 20, text: str, life: 1.1, color, size });
  }

  splash(x) {
    this.spawnParticles(x, CONFIG.WATER_LEVEL, 18, { speed: 180, life: 0.8, size: 3, color: '#9ed0ff', gravity: 800 });
  }

  spawnParticles(x, y, n, o) {
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = o.speed * (0.3 + Math.random() * 0.7);
      const life = o.life * (0.5 + Math.random() * 0.5);
      this.particles.push({
        x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - o.speed * 0.3,
        life, maxLife: life, size: o.size * (0.5 + Math.random()), color: o.color, gravity: o.gravity,
      });
    }
  }

  updateEffects(dt) {
    for (const p of this.particles) {
      p.life -= dt;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const f of this.flashes) f.life -= dt;
    this.flashes = this.flashes.filter(f => f.life > 0);
    for (const f of this.linkFlashes) f.life -= dt;
    this.linkFlashes = this.linkFlashes.filter(f => f.life > 0);
    for (const f of this.floatTexts) { f.life -= dt; f.y -= 30 * dt; }
    this.floatTexts = this.floatTexts.filter(f => f.life > 0);
  }

  render() {
    this.renderer.draw();
  }
}
