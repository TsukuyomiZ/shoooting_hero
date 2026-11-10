import { CONFIG } from '../shared/core/config.js';
import { Match } from '../shared/game/match.js';
import { replayVolley } from '../shared/physics/volley.js';
import { glideAt, glideDist } from '../shared/ai/ai-move.js';
import { stateOf, shotFloats, killFloats, turnFxOps, volleyLook, feverOps, readState } from '../shared/cards/effects/index.js';
import { clamp, lerpAngle } from '../shared/core/utils.js';
import { Renderer } from './render.js';
import { TerrainPainter } from './terrain-painter.js';
import { mapViewFor } from './map-views/index.js';
import { Music } from './music.js';
import { audio } from './audio.js';
import { sfx } from './sfx.js';
import { STAGE_LOOK, stageTypeOf, stageLook, difficultyName } from './stage-look.js';
import { difficultyOf, difficultyDesc, runConfig, showsRangeHints } from '../shared/game/stage-rules.js';

const FPS = 60;
const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const SLOT_KEYS = { Digit1: 0, Digit2: 1, Digit3: 2 };
const STEP_STRIDE = 34;   // 走多少 px 踩一步（移動速度 130 px/s ≈ 每秒 4 步）
const LAUNCH_SOUNDS = { sniper: 'sniper', sonic: 'sonic', darts: 'dart', waterCannon: 'waterJet', rapier: 'stab' };   // 開火的聲音（沒列的都是大砲聲）
const EMBER_COLORS = ['#fde047', '#fb923c', '#f97316', '#ef4444'];   // 著火的飛行物噴出來的火星

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
    this.feverShown = 0;               // 已經用橫幅提示過的狂熱層數
    this.deadline = null;              // 本地時間 (performance.now)
    this.canAct = false;               // 現在能不能操作自己
    this.waiting = false;              // 已送出 fire，等伺服器結果
    // 這回合射過一回合可以射好幾次的武器（飛鏢）：只能用它（lockWeapon）、還能射幾次（shotsLeft）。伺服器說了算（shot / resume / state），新的回合清掉
    this.lockWeapon = null;
    this.shotsLeft = null;
    this.queue = [];
    this.script = null;
    this.wait = null;
    this.aimAnim = null;               // AI 砲管轉向動畫 { id, angle, power }
    this.projectiles = [];
    this.particles = [];
    this.flashes = [];
    this.linkFlashes = [];             // 攜手之伴分擔傷害時，兩人之間閃一下的連線 { a, b, life }
    this.floatTexts = [];
    this.ambient = [];                 // 整個畫面的演出（效果給的，例如狂熱時的氣球；見 startAmbient）
    this.mapView = null;               // 這張地圖的地圖畫面（setup 時照地圖機制選，見 client/map-views/index.js）
    this.mapCtx = null;                // 給地圖畫面的掛勾用的 c（見 mapContext）
    this.scratch = null;               // 地圖畫面的暫存畫布（見 scratchLayer）
    this.looks = new WeakMap();        // 角色 → 只給畫面用的狀態（見 look）
    this.keys = {};
    this.mouse = { x: 0, y: 0, down: false };
    this.slowMo = false;               // 慢動作中（自己的回合在空中瞄準，見 frame）
    this.timeScale = 1;                // 畫面的速度倍率：main.js 每一步 update 的 dt = 固定步長 × 這個（慢動作時 < 1）
    this.time = 0;
    // 真實時間（秒）：要跟伺服器的時鐘一起動的東西用（例如回合裡飛的流浪劍士劍氣）——畫面時間（time）在卡頓、慢動作時會比真實時間慢。測試可以換掉
    this.clock = () => performance.now() / 1000;
    this.shake = 0;
    this.banner = null;
    this.nextBanner = null;    // 排著的橫幅（目前的那張是 hold，見 showBanner）
    this.hint = null;
    this.result = null;        // 本關戰鬥結果 'win' | 'lose' | null（勝者為王另外有 'draw'、觀戰的 'over'，見 setResult）
    this.winner = null;        // 勝者為王：贏的那一隊（'blue' | 'red'）或 'draw'
    this.runOver = null;       // 整場冒險結束 { result, stage }（勝者為王另外帶 versus、winner、round）
    this.stageInfo = null;     // { stage, stageCount, isBoss, type（'normal' | 'elite' | 'boss'）, levelName, cards }；勝者為王另外帶 mode 'versus'
    this.picking = null;       // 勝者為王：每一輪打完的選牌中（戰鬥暫停）{ round, until（本地時間）, offers（每個人的三張牌，飄字用） }
    this.bots = new Set();     // 勝者為王的電腦玩家 id（名單上的 bot）
    // 勝者為王的選牌（main.js 給）：佇列播到 roundPick 時呼叫（開選牌畫面）、播到 roundPicks 時呼叫（關掉）
    this.onRoundPick = null;
    this.onRoundPicks = null;
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
  // 勝者為王（3v3 對戰）：開場 / 重連的資訊帶 mode 'versus'（冒險沒有 mode）
  get versus() { return !!(this.stageInfo && this.stageInfo.mode === 'versus'); }
  // 自己的角色在哪一隊（冒險是 'players'）；沒有角色（觀戰、還沒建好）= null
  get myTeam() { const me = this.me; return me ? me.team : null; }

  // 角色跟自己的關係（畫面上分敵我的顏色都照這個）：'me' | 'ally'（同一隊）| 'foe'。
  // 勝者為王照隊伍分；冒險、或自己沒有角色的時候照原本的分法：玩家角色 = ally、其他 = foe
  relation(e) {
    if (e.id === this.myId) return 'me';
    const team = this.versus ? this.myTeam : null;
    if (team) return e.team === team ? 'ally' : 'foe';
    return e.isPlayer ? 'ally' : 'foe';
  }

  // 電腦玩家的標籤：名字本來就是伺服器取的「電腦 N」就不再加
  botTag(e) { return e.name.includes(CONFIG.VERSUS.botName) ? '' : '（電腦）'; }

  // 角色在這個畫面上的狀態（不是遊戲狀態，所以不放在 Entity 上；每次 setup 重來）：
  //   netTarget    遠端玩家插值的目標（他最後回報的位置）；netVy = 他回報的垂直速度（看他是不是剛起跳）
  //   slowMo       他開著慢動作（畫光環）
  //   splashShown  已經播過的那一次落水（Entity.splash）
  //   stepDist     走了多遠（踩腳步聲用）
  //   poisonDeath  是被毒倒的（換成「中毒倒下」的橫幅；又活過來就清掉）
  //   deathHandled 這次倒下已經播過死亡特效 / 橫幅（伺服器的狀態說他又活著 = 下次倒下再播）
  //   bleedSeen    已經算過的 e.bledThisTurn（本地物理 / 重播走路時流血扣的，見 bleedFx）
  //   bleedLoss    流血扣了、還沒飄字的血；bleedClock = 從第一點沒飄的開始過了幾秒（每 0.5 秒飄一次「-N」）
  look(e) {
    let v = this.looks.get(e);
    if (!v) {
      this.looks.set(e, v = {
        netTarget: null, netVy: 0, slowMo: false, splashShown: null, stepDist: 0, poisonDeath: false, deathHandled: false,
        bleedSeen: e.bledThisTurn, bleedLoss: 0, bleedClock: 0,
      });
    }
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
      // resume（飛鏢射完一發、回合接著繼續）一定要等那一發重播完才套：重播中能操作的話，按著的方向鍵會混進重播的物理
      // hazard（回合中的危險物打到人 / 飛完）也是：扣的血不能被之後才播的舊快照蓋回去
      // roundPick / roundPicks（勝者為王每一輪打完的選牌）：最後一發播完才停下來選；選完的新數值（refit）一定要照順序套——重播靠角色的大小算命中
      // struggle（被困住的人掙扎、掙脫）也是：不能比困住他的那則 pickup 先套
      case 'turn': case 'aiTurn': case 'shot': case 'skip': case 'turnFx': case 'gameOver': case 'water': case 'pickup': case 'slow': case 'resume': case 'hazard': case 'struggle':
      case 'roundPick': case 'roundPicks':
        if (msg.t === 'turn' && document.hidden) this.cueTurn(msg);   // 分頁在背景：輪到自己的提示音收到就響，不等前面的動畫播完
        if (msg.t === 'resume' || msg.t === 'roundPick') msg.at = performance.now();   // 伺服器收到這則就開始倒數：剩下的秒數從收到的時候算
        if (msg.t === 'turn' || msg.t === 'hazard') msg.recvAt = this.clock();   // 回合裡的危險物照收到的時刻算位置（佇列裡排隊的時間不算延遲）
        // 回合裡的危險物打到人 / 飛完：畫面收到就先演（佇列前面可能還在播這個回合的開火 / AI 代打），扣血照順序在佇列裡套。
        // 只有已經播到那個回合（seq 對得上）才先演，不然照順序來
        if (msg.t === 'hazard' && this.mapCtx && msg.seq !== undefined && msg.seq === this.hazardSeq) this.mapView.hazard(this.mapCtx, msg, true);
        this.queue.push(msg);
        this.pump();
        break;
      case 'picks':
        // 大家選完牌：更新手牌清單（下一關的 start 會帶完整資料）
        if (this.stageInfo) for (const s of msg.summary) (this.stageInfo.cards[s.playerId] ||= []).push(s.cardId);
        {
          const next = STAGE_LOOK[stageTypeOf({ type: msg.nextType, isBoss: msg.isBoss })];
          this.showBanner(next.name ? `${next.name}即將開始…` : `準備進入第 ${msg.nextStage} 關…`, next.banner);
        }
        break;
      case 'picked': {
        // 勝者為王：畫面還沒播到這一輪的 roundPick（佇列落後）就有人選好了：先記進那則的 picked，播到時選牌畫面才標得出誰選好了
        let pending = null;
        for (const m of this.queue) if (m.t === 'roundPick') pending = m;
        if (pending && Array.isArray(pending.picked) && !pending.picked.includes(msg.playerId)) pending.picked.push(msg.playerId);
        // 他用攜手之伴連了某個隊友：那個隊友的可連結名單拿掉他（同 CardsUi.setPicked；不然開出來的名單還有他，選了會被伺服器擋下）
        const targets = pending && msg.link && pending.linkTargets && pending.linkTargets[msg.link];
        if (Array.isArray(targets)) pending.linkTargets[msg.link] = targets.filter(id => id !== msg.playerId);
        break;
      }
      case 'runOver':
        this.runOver = { result: msg.result, stage: msg.stage, stageCount: msg.stageCount, type: msg.type || stageTypeOf(this.stageInfo) };
        // 勝者為王：result 是贏的那一隊（或 draw），winner = 贏的那一隊（平手是 null）、打到第幾輪
        if (msg.mode === 'versus') Object.assign(this.runOver, { versus: true, winner: msg.winner ?? null, round: msg.round });
        this.canAct = false;
        this.waiting = false;
        this.picking = null;
        break;
      case 'move':
        // 他在流血時帶的血量（netHp）也走佇列，位置照舊馬上套：畫面落後時（分頁在背景、很卡）先套上的話，之後才播的舊快照
        // （他的 turn、resume…）會把血量蓋回流血之前，下一筆再把同一段流血飄一次
        if (Number.isFinite(msg.hp)) {
          this.queue.push({ t: 'netHp', id: msg.id, hp: msg.hp });
          this.pump();
        }
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

  // 別人的 move 帶的血量（他在流血：血量只有他自己的畫面在扣，照伺服器轉來的顯示，少掉的照流血飄字、滴血）。
  // 從佇列照順序播（見 onMessage 的 'move'）：前面排著的快照都套過了才輪到它
  onNetHp(msg) {
    const e = this.match.byId(msg.id);
    if (!e || msg.id === this.myId) return;
    if (msg.hp < e.hp) this.noteBleed(e, e.hp - msg.hp);
    e.hp = msg.hp;
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
    // 關卡規則照這場的難度與主題算（跟伺服器的 Match 一樣，見 runConfig）
    const { difficulty, theme } = msg.stageInfo || msg.run || {};
    this.match = new Match({ levelId: msg.levelId, players: msg.players, seed: msg.seed, carry: msg.carry || {}, stage: msg.stage || 1, config: runConfig({ difficulty, theme }) });
    this.rangeHints = showsRangeHints(difficulty);   // 這場的難度畫不畫菁英怪招式的提示範圍（地圖畫面的 c.rangeHints）
    this.match.applySnapshot(msg.snapshot);
    this.looks = new WeakMap();
    this.mapView = mapViewFor(this.match);   // 一般小關 = plain（什麼都不演）
    this.mapCtx = this.mapContext(this.mapView.create(this.match));
    this.hazardSeq = null;   // 現在播到的回合的危險物是第幾個回合的（turn 的 hazard.seq；新的一關從頭算）
    this.stageInfo = msg.stageInfo || msg.run || null;
    this.runOver = null;
    this.banner = null;       // 上一關（或斷線前）還在播 / 排著的橫幅不帶過來
    this.nextBanner = null;
    if (this.versus) {
      // 勝者為王：對戰地圖的名字、自己在哪一隊（沒有角色 = 觀戰：寫兩隊）。剛開場時停滿時間，第一個回合的橫幅等它播完才出來
      const V = CONFIG.VERSUS, team = this.myTeam;
      const sub = team ? `你在${V.teamNames[team] || team}　打倒對方全隊就贏` : `${V.teams.map(t => V.teamNames[t] || t).join(' 對 ')}　打倒對方全隊就贏`;
      this.showBanner(`${V.name}：${this.stageInfo.levelName}`, '#fde047', sub, { hold: msg.t === 'start' });
    } else if (this.stageInfo) {
      const L = stageLook(this.stageInfo);
      // 菁英關多一行說明；不是一般難度的冒險，第 1 關多一行難度的說明（菁英之路：哪幾關是菁英關、敵人傷害不打折）；
      // 主題副本的第 1 關多一行主題的名字（加上難度的說明）。
      // 剛開場（start，不是重連的 state）時停滿時間（hold）：第一個回合的橫幅等它播完才出來
      const si = this.stageInfo;
      const hard = difficultyOf(si.difficulty) !== 'normal';
      const theme = CONFIG.THEMES[si.theme];
      const intro = [theme && theme.name, hard && difficultyName(si.difficulty), (hard || theme) && difficultyDesc(si.difficulty, CONFIG, si.theme)].filter(Boolean).join('　');
      const sub = stageTypeOf(si) === 'elite' ? '強力的菁英怪鎮守　打贏後選牌比較容易出稀有牌'
        : intro && si.stage === 1 ? intro : null;
      this.showBanner(L.name ? `${L.name}：${this.stageInfo.levelName}` : `第 ${this.stageInfo.stage} 關：${this.stageInfo.levelName}`, L.banner, sub, { hold: !!sub && msg.t === 'start' });
    }
    for (const e of this.match.entities) if (!e.alive) this.look(e).deathHandled = true;   // 重連時不要重播死亡特效
    this.players = msg.players;
    for (const p of msg.players) this.playerStatus.set(p.id, p.connected !== false);
    this.bots = new Set(msg.players.filter(p => p.bot).map(p => p.id));   // 電腦玩家一直是 AI 在打（連線狀態是 false），名單不寫「AI」
    const lvl = this.match.level;
    this.painter = new TerrainPainter(this.match.terrain, { platformStyle: lvl.platformStyle, style: lvl.terrainStyle, hardLook: lvl.hardLook });
    this.queue = [];
    this.script = null;
    this.wait = null;
    this.aimAnim = null;
    this.projectiles = [];
    this.particles = [];
    this.flashes = [];
    this.linkFlashes = [];
    this.floatTexts = [];
    this.ambient = [];
    this.result = null;
    this.winner = null;
    this.picking = null;
    this.canAct = false;
    this.waiting = false;
    this.currentId = null;
    this.deadline = null;
    this.lockWeapon = null;
    this.shotsLeft = null;
    this.match.round = msg.round || 0;   // 第幾輪記在 Match：新的一關從第 0 輪開始（重連的 state 會帶目前的輪數）
    this.feverShown = this.match.fever;
    this.started = true;
  }

  // 地圖畫面的掛勾拿到的 c：只開放這幾樣（說明見 client/map-views/index.js）。state = 地圖畫面自己這一場的狀態
  mapContext(state) {
    const view = this;
    return {
      get match() { return view.match; },
      get time() { return view.time; },
      get currentId() { return view.currentId; },
      get myId() { return view.myId; },
      get projectiles() { return view.projectiles; },
      get rangeHints() { return view.rangeHints !== false; },
      clock: () => view.clock(),
      shotScript: (shot, extra) => view.shotScript(shot, extra),
      layer: () => view.scratchLayer(),
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
        repaint: (rect) => { if (view.painter) view.painter.repaintRect(rect); },
      },
    };
  }

  // 跟畫面一樣大的暫存畫布（地圖畫面的 c.layer()：先在上面畫好再整張疊上去，例如洞穴的遮光），第一次用到才建，之後一直用同一張
  scratchLayer() {
    if (!this.scratch) {
      const canvas = document.createElement('canvas');
      canvas.width = CONFIG.WORLD_W;
      canvas.height = CONFIG.WORLD_H;
      this.scratch = { canvas, ctx: canvas.getContext('2d') };
    }
    return this.scratch;
  }

  // 重連：直接回到目前的回合
  restoreTurn(msg) {
    this.currentId = msg.currentId;
    this.match.round = msg.round;
    const mine = msg.currentId === this.myId && msg.phase === 'turn';
    this.currentIsAi = !mine;
    this.canAct = mine;
    this.deadline = mine && msg.timeLeft != null ? performance.now() + msg.timeLeft * 1000 : null;
    this.setShotLock(msg.lockWeapon || null, msg.shotsLeft ?? null);   // 這回合射過飛鏢：只能用它、還剩幾次
    if (msg.phase === 'over') this.setResult(this.match.result());
    // 勝者為王：一輪打完、下一輪還沒開始（裁判停在 'break'）：沒有人的回合。還在選牌（runPhase 'pick'）就是暫停中（選牌畫面由 main.js 照 state 開）；
    // 只知道自己的三張牌（state 只帶自己的）
    if (msg.phase === 'break') this.currentId = null;
    if (this.versus && msg.runPhase === 'pick') {   // 冒險的過關選牌不是這種暫停（HUD 照舊）
      this.picking = {
        round: msg.pickRound ?? msg.round, until: performance.now() + (msg.pickTimeLeft ?? CONFIG.VERSUS.pickTime) * 1000,
        offers: { [this.myId]: msg.offers || [] },
      };
    }
    // 伺服器記得行動玩家開著慢動作：是自己（重連前沒來得及送關，新的頁面沒開著）→ 送關（記一筆、別人的光環也會清掉）；
    // 是別人 → 在他身上畫光環
    if (msg.slowOn && msg.phase === 'turn') {
      if (mine) this.transport.send({ t: 'slow', on: false, why: 'reconnect' });
      else { const a = this.match.byId(msg.currentId); if (a) this.look(a).slowMo = true; }
    }
  }

  // 這回合的武器鎖定（一回合可以射好幾次的武器，例如飛鏢）：weapon = 只能用哪一把、left = 還能射幾次。
  // 沒有次數了（射完最後一支、被 AI 代打）就等於沒鎖：這回合不會再回到他手上，下一個回合（或回合開始的轟炸）也不該還鎖著。
  // 鎖著的時候行動的人手上的武器也換成它
  setShotLock(weapon, left) {
    const on = !!weapon && left > 0;
    this.lockWeapon = on ? weapon : null;
    this.shotsLeft = on ? left : null;
    const actor = on && this.currentId ? this.match.byId(this.currentId) : null;
    if (actor) actor.weapon = weapon;
  }

  // 飛鏢射完一發、還有次數：回合接著繼續（不是新的回合：沒有橫幅、沒有提示音），計時從伺服器給的剩餘秒數接著算
  onResume(msg) {
    if (msg.entities) this.match.applyEntities(msg.entities);
    this.currentId = msg.actorId;
    const mine = msg.actorId === this.myId;
    this.currentIsAi = false;
    this.canAct = mine;
    this.waiting = false;
    this.mouse.down = false;
    this.lastSent = null;
    this.deadline = mine ? (msg.at ?? performance.now()) + msg.timeLeft * 1000 : null;
    this.setShotLock(msg.weapon, msg.shotsLeft);
    const w = CONFIG.WEAPONS[msg.weapon];
    if (mine && w) this.showHint(`${w.name}還可以射 ${msg.shotsLeft} 次`);
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
      case 'netHp':
        this.onNetHp(msg);
        break;
      case 'pickup':
        this.onPickup(msg);
        break;
      case 'struggle':
        this.onStruggle(msg);
        break;
      case 'hazard':
        this.onHazard(msg);
        break;
      case 'slow':
        this.onSlow(msg);
        break;
      case 'turnFx':
        yield* this.turnFxScript(msg);
        break;
      case 'resume':
        this.onResume(msg);
        break;
      case 'roundPick':
        this.beginPick(msg);
        break;
      case 'roundPicks':
        this.applyRoundPicks(msg);
        break;
      case 'gameOver':
        if (msg.entities) this.match.applyEntities(msg.entities);
        yield { frames: 40 };
        this.setResult(msg.result);
        this.canAct = false;
        this.waiting = false;
        this.currentId = null;
        this.picking = null;
        this.setShotLock(null, null);
        break;
    }
  }

  // 這一場的勝負（gameOver 的 result、重連時的 Match.result()）。冒險照原樣（'win' / 'lose'）；
  // 勝者為王的是贏的那一隊或 'draw'：記在 winner，result 照自己的隊伍換成 'win' / 'lose' / 'draw'（自己沒有角色 = 'over'，只寫哪一隊贏）
  setResult(r) {
    if (!this.versus) { this.result = r; return; }
    this.winner = r || null;
    const team = this.myTeam;
    this.result = !r ? null : r === 'draw' ? 'draw' : !team ? 'over' : r === team ? 'win' : 'lose';
  }

  // 勝者為王：一輪打完、大家選牌（伺服器暫停戰鬥）：沒有人的回合、不能操作；選牌畫面由 main.js 開（onRoundPick）。
  // 選牌的秒數從收到這則的時候算（畫面落後的話，選牌畫面給的時間就少那一段，跟伺服器一起結束）
  beginPick(msg) {
    const until = (msg.at ?? performance.now()) + msg.pickTime * 1000;
    this.picking = { round: msg.round, until, offers: msg.offers || {} };
    this.canAct = false;
    this.waiting = false;
    this.mouse.down = false;
    this.currentId = null;
    this.deadline = null;
    this.setShotLock(null, null);
    this.showBanner(`第 ${msg.round} 輪結束　選牌中…`, '#fde047');
    if (this.onRoundPick) this.onRoundPick({ ...msg, pickTime: Math.max(0, (until - performance.now()) / 1000) });
  }

  // 勝者為王：選完牌（roundPicks）：每個人的新數值（上限、速度、體型、武器欄…）套到場上的角色（跟伺服器同一份 carry），再照套完、站好的狀態校正；
  // 名單上的「牌 ×N」照新的，選到的牌名飄在每個人頭上（照稀有度的顏色；重連回來的只知道自己的牌）。
  // 一定要從佇列套（不能收到就套）：之前還沒播完的重播照的是選牌前的大小
  applyRoundPicks(msg) {
    for (const [id, c] of Object.entries(msg.carry || {})) this.match.refit(this.match.byId(id), c);
    if (msg.entities) this.match.applyEntities(msg.entities);
    for (const e of this.match.entities) this.look(e).netTarget = null;   // 大家照新的狀態站好，不要滑回最後回報的位置
    if (this.stageInfo && msg.cards) this.stageInfo.cards = msg.cards;
    const offers = (this.picking && this.picking.offers) || {};
    for (const s of msg.summary || []) {
      const e = this.match.byId(s.playerId);
      const card = e && (offers[s.playerId] || []).find(c => c.id === s.cardId);
      if (!card) continue;
      const rarity = CONFIG.RARITY[card.rarity];
      this.floatText(e, card.name, rarity ? rarity.color : '#e5e7eb', 16);
    }
    this.picking = null;
    if (this.onRoundPicks) this.onRoundPicks(msg);
  }

  beginTurn(msg) {
    this.match.applyEntities(msg.entities);
    this.setItems(msg);
    this.setShotLock(null, null);   // 新的回合：飛鏢的鎖定與次數清掉
    for (const e of this.match.entities) {
      e.moveDir = 0; e.vineDir = 0; e.aiming = false;
      const v = this.look(e);
      v.netTarget = null; v.slowMo = false;
    }
    this.currentId = msg.actorId;
    this.match.round = msg.round;
    if (Number.isFinite(msg.wind)) this.match.wind = msg.wind;   // 有風的關卡：這個回合的風（預覽、HUD）
    this.currentIsAi = !!msg.ai;
    const actor = this.match.byId(msg.actorId);
    const mine = msg.actorId === this.myId && !msg.ai;
    this.canAct = mine;
    this.waiting = false;
    this.mouse.down = false;
    this.lastSent = null;
    this.deadline = mine && msg.turnTime ? performance.now() + msg.turnTime * 1000 : null;
    // 這回合出發的危險物（例如流浪劍士的劍氣）：地圖畫面開始畫它飛（at = 收到 turn 的時刻，照真實時間往前推）
    this.hazardSeq = msg.hazard ? msg.hazard.seq : null;
    if (msg.hazard) this.mapView.hazard(this.mapCtx, { start: msg.hazard, recvAt: msg.recvAt ?? this.clock() });
    if (!actor) return;
    for (const fx of msg.fx || []) {   // 回合開始的效果（中毒結算、站在蛇血上喝掉、恩賜之杖回血）
      const e = this.match.byId(fx.id);
      if (!e) continue;
      if (fx.type === 'heal') this.floatText(e, `+${fx.amount}`, '#4ade80');
      else this.statusFx(e, fx);
    }
    // 時間扭曲給的額外回合；王插進來的插話行動（不算他的回合，見 Referee.runInterject）
    const kind = msg.interject ? '追加行動' : msg.extra ? '額外回合' : '回合';
    const fever = this.feverNotice();
    if (mine) {
      this.cueTurn(msg);
      this.showBanner(`你的${kind}`, msg.extra ? '#c4b5fd' : '#7dd3fc', fever);
    } else {
      // 玩家角色由 AI 打：斷線代打寫「AI 代打」、勝者為王的電腦玩家寫「電腦」；顏色照敵我（勝者為王照隊伍）
      // 地圖機制接手的回合（msg.forced，例如被調皮妖精魅惑）寫它的說明；是自己的話橫幅寫給自己看
      const forced = msg.forced && msg.forced.label;
      if (forced && msg.actorId === this.myId) {
        this.showBanner(`你${forced}！這回合由遊戲接手`, '#f9a8d4', fever);
        return;
      }
      const tag = forced ? `（${forced}）`
        : msg.ai && actor.isPlayer ? (this.bots.has(actor.id) ? this.botTag(actor) : '（AI 代打）') : '';
      this.showBanner(`${actor.name} 的${kind}${tag}`, msg.extra ? '#c4b5fd' : (this.relation(actor) !== 'foe' ? '#86efac' : '#fca5a5'), fever);
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

  // 狂熱剛疊上新的一層（新的一輪跨過門檻）：回傳橫幅底下的提示字，每層只提示一次。Boss 關一直是 0 層，不會提示。
  // 效果要的狂熱演出（feverFx，例如狂歡派對）也在這時候播（每層一次；重連、新的一關不會重播：setup 記下了現在的層數）
  feverNotice() {
    const n = this.match.fever;
    if (n <= this.feverShown) return null;
    this.feverShown = n;
    const ops = feverOps(this.match);
    if (ops) this.playEffectOps(ops, []);
    return `狂熱！所有角色的傷害 +${n * this.match.rules.feverPct}%`;
  }

  // 背景音樂：地圖畫面指定的曲子（例如 Boss 關、洞穴地圖；狂熱版也由它照 match.fever 換）；
  // 沒指定的小關、菁英關放山谷曲，狂熱生效後換狂熱版（跟狂熱橫幅同一刻）。曲目表在 music.js 的 TRACKS
  musicTrack() {
    if (!this.started || !this.match) return null;
    const own = this.mapView.musicTrack(this.mapCtx);
    if (own || this.match.level.pool === 'boss') return own;
    return this.match.fever > 0 ? 'fever' : 'normal';
  }

  *aiTurnScript(msg) {
    const actor = this.match.byId(msg.actorId);
    if (!actor) return;
    const splashes = this.serverSplashes(msg.splashes);   // 斷線代打：伺服器先讓他落地，途中掉進水裡的那一次
    if (msg.entities) this.match.applyEntities(msg.entities);
    for (const s of splashes) this.onSplash(this.match.byId(s.id), s);
    if (msg.boss) {   // 由地圖機制出招（例如古樹、巨蟒、小心擊發的蜜蜂）：動畫由地圖畫面播
      if (msg.glide && actor.alive) yield* this.glideScript(actor, msg.glide);   // 獨眼巨人：先沿著岩柱走一段再出招
      yield* this.mapView.turnScript(this.mapCtx, msg);
      return;
    }
    const v = this.look(actor);
    v.netTarget = null;
    v.slowMo = false;   // 開著慢動作時斷線、AI 代打：光環清掉
    this.setShotLock(null, null);   // 射過飛鏢的回合被代打：AI 射一支就結束，不會再回到他手上
    yield { frames: CONFIG.TIMING.aiThink * FPS };
    if (msg.walk && actor.alive) yield* this.walkScript(actor, msg.walk, msg.pickups || []);
    if (msg.glide && actor.alive) yield* this.glideScript(actor, msg.glide);   // 蝙蝠：在空中直線飄一段
    if (msg.fx) this.effectFx(msg.fx);   // 走路 / 飄移途中流血倒下、算到流血來源的擊殺：擊殺的效果（例如噬魂者）走完才飄字
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

  // AI 走路（伺服器在 Match.simulateWalk 算好）：按著方向走 w.frames 幀，再放開方向鍵落 w.fall 幀（走完還在半空中時落到站穩），
  // 每一幀的物理跟伺服器一樣，走到的地方一模一樣、瞄準前已經站在地上。
  // pickups = 斷線代打的玩家路上撿到的道具（點燃火把、喝到蛇血；跟 pickup 訊息同樣的欄位）：播到伺服器撿到的那一幀（f）才套上
  *walkScript(e, w, pickups) {
    const total = w.frames + (w.fall || 0);
    let k = 0;
    e.moveDir = w.dir;
    for (let f = 1; f <= total; f++) {
      if (f > w.frames) e.moveDir = 0;
      yield { frames: 1 };
      while (k < pickups.length && pickups[k].f <= f) this.onPickup(pickups[k++]);
    }
    e.moveDir = 0;
    while (k < pickups.length) this.onPickup(pickups[k++]);
  }

  // 飄移（沒有物理的角色：蝙蝠、獨眼巨人；伺服器在 shared/ai/ai-move.js 算好）：照 glideAt 逐幀內插，最後一幀剛好停在伺服器放的地方。
  // 流血的話飄完照直線距離扣一次（跟伺服器的 planGlide 同一個算法；扣到倒下就在這裡倒下，伺服器也不讓他出招）
  *glideScript(e, g) {
    const x0 = e.x, y0 = e.y;
    if (g.dx) e.facing = Math.sign(g.dx);
    for (let i = 1; i <= g.frames; i++) {
      yield { frames: 1 };
      const p = glideAt(x0, y0, g, i);
      e.x = p.x;
      e.y = p.y;
    }
    e.bleedFor(glideDist(g));
  }

  // 重播一發（或一波轟炸）：shared/physics/volley.js 照伺服器的事件逐幀重播（跟伺服器同一個幀迴圈）。
  // 每一幀的角色物理在 update 原本的位置由 tick.step() 跑（見 update），飛行物與事件在下面的 tickScript 裡；
  // 這裡只管畫面（出發、事件的特效 / 飄字）與最後的校正。extra.frame = 每個飛行幀結束時呼叫（蜜蜂的衝刺用）
  *shotScript(shot, extra = {}) {
    const run = replayVolley(this.match, shot);   // 格式壞掉會在這裡丟錯（還在 advanceScript 的 try 裡）
    if (!run) return;
    const actor = this.match.byId(shot.actorId);
    const weapon = CONFIG.WEAPONS[shot.weapon];
    // 回合開始的一波攻擊：效果的（例如無差別轟炸）橫幅由效果給，地圖機制的（例如流浪劍士的劍氣）由地圖畫面給
    const look = volleyLook(shot.kind) || this.mapView.turnVolley(this.mapCtx, shot);
    if (look) {
      // 回合開始的攻擊：這時已經輪到他了（turn 訊息要等那一波播完才會來；地圖機制的那一波出手的是敵人，輪到的人是 turnId）；
      // 新的回合，上一回合的飛鏢鎖定不算
      this.currentId = shot.turnId ?? shot.actorId;
      if (shot.round) this.match.round = shot.round;
      this.canAct = false;
      this.waiting = false;
      this.setShotLock(null, null);
      this.showBanner(look.banner(actor ? actor.name : ''), look.color, this.feverNotice());
    } else if (actor) {
      // 射手的位置 / 血量 / 藤蔓由重播模組照 shot.actor 擺好（第一個 next()）；這裡只清客戶端自己的狀態
      const v = this.look(actor);
      v.netTarget = null;
      v.slowMo = false;
      if (actor.id === this.myId) this.waiting = false;   // 結果到了，射手接著照伺服器的狀態動
      // 一回合可以射好幾次的武器（飛鏢）：這一發之後還能射幾次（還有的話，重播完會再收到 resume）
      if (shot.shotsLeft !== undefined) this.setShotLock(shot.weapon, shot.shotsLeft);
    }

    // 重播中隊友的 move 先收著（見 onMessage 的 'move'）：他照物理跑、跟伺服器一致，播完才套最新的那筆
    this.holdMoves = true;
    this.heldMoves ||= new Map();
    this.projectiles = run.live;   // 同一個陣列：模組原地更新（render、地圖畫面的 c.projectiles 都讀它）
    let played = false;
    try {
      yield* run.frames({
        // 半路才出現的飛行物（例如被打下來的鐘乳石）不是開火：沒有砲聲，它的演出由地圖畫面的 showEvent 播
        spawn: (p) => { if (shot.kind === 'weapon' && !p.added) this.showLaunch(weapon, p); },
        event: (ev, p, made) => this.showShotEvent(shot, p.weapon, ev, made),   // 照這顆飛行物自己的武器（半路才出現的不是這一波的武器）
        frame: (live, f) => { this.fireEmbers(live); if (extra.frame) extra.frame(live, f); },
      });   // 剛好 flightFrames + settleFrames 幀（沉降也照伺服器的幀數）
      played = true;
    } finally {
      this.holdMoves = false;
      if (!played) this.flushMoves();   // 播到一半丟錯：收著的 move 不要卡到下一波
      this.projectiles = [];   // 飛到一半丟錯也清掉：不然凍住的飛行物會一直畫著（大地震擊還會一直噴碎石）
    }
    if (run.drift.length) console.warn('重播跟伺服器對不起來', run.drift);

    const before = actor ? stateOf(actor) : null;   // 效果自己的狀態（例如層數）在套結果之前的值
    this.match.applyEntities(shot.results);   // 校正成伺服器結果
    this.flushMoves();   // 重播中收到的 move（比 results 新）：現在才套上
    // 效果的飄字：自己開的一槍（例如磨刀霍霍 / 越戰越強的層數變化），再來是這一發的擊殺（例如噬魂者）
    if (actor && shot.hitEnemy !== undefined) {
      for (const [str, color] of shotFloats(actor, before)) this.floatText(actor, str, color);
    }
    if (actor && shot.kills && shot.kills.length) {
      for (const [str, color] of killFloats(actor, shot)) this.floatText(actor, str, color);
    }
    yield { frames: CONFIG.TIMING.settleDelay * FPS * 0.5 };
  }

  // 每個飛行幀：著火的飛行物（p.fire）往後噴火星（慢慢往上飄、很快熄掉）；火舌本身由 Renderer.drawFire 畫
  fireEmbers(live) {
    for (const p of live) {
      if (!p.fire) continue;
      for (let k = 0; k < 2; k++) {
        const life = 0.3 + Math.random() * 0.25;
        this.particles.push({
          x: p.x + (Math.random() - 0.5) * 6, y: p.y + (Math.random() - 0.5) * 6,
          vx: (Math.random() - 0.5) * 50, vy: -20 - Math.random() * 40, life, maxLife: life,
          size: 1.5 + Math.random() * 1.8, color: EMBER_COLORS[(Math.random() * EMBER_COLORS.length) | 0], gravity: -60,
        });
      }
    }
  }

  // 一顆飛行物出發（自己 / 隊友 / AI 開火）：砲聲、砲口的火花、震一下
  showLaunch(weapon, p) {
    sfx.play(LAUNCH_SOUNDS[weapon.id] || 'cannon', { x: p.x });
    const light = weapon.id === 'darts' || weapon.id === 'rapier';   // 飛鏢一甩、刺劍一刺：沒有砲口的火花，只有一點點
    const color = weapon.id === 'plasma' ? '#67e8f9' : weapon.id === 'waterCannon' ? '#bae6fd' : weapon.id === 'rapier' ? '#f1f5f9' : '#ffcc66';
    this.spawnParticles(p.x, p.y, light ? 3 : 8, { speed: 140, life: 0.25, size: 3, color, gravity: 0 });
    // 飛鏢、刺劍輕輕一下、高壓水炮有後座力（射手被推出去由重播的物理演），其他照拋射 / 直線
    this.shake = Math.max(this.shake, light ? 1 : weapon.recoil ? 6 : weapon.gravity > 0 ? 5 : 2);
  }

  // 一個飛行事件的畫面（狀態已經由 shared/physics/volley.js 套好：飛行物、挖坑、角色的事件狀態、地圖機制建的道具 / 角色）：
  // 特效、重畫挖掉的地形（made.rect）、地圖畫面的演出（例如蛇血 / 蜜蜂飛出來：made.items / made.bees）、傷害飄字
  showShotEvent(shot, weapon, ev, made) {
    switch (ev.type) {
      case 'bounce':
        this.spawnParticles(ev.x, ev.y, 6, { speed: 160, life: 0.3, size: 2, color: '#fef08a', gravity: 300 });
        break;
      case 'pierce':
        this.spawnParticles(ev.x, ev.y, 8, { speed: 150, life: 0.35, size: 3, color: '#fca5a5', gravity: 400 });
        break;
      case 'return':   // 迴力鏢折返：撞到地形噴火花、落水濺水花，飛到最遠處（半空中）只閃一下
        if (ev.on === 'water') {
          this.splash(ev.x);
          sfx.play('plop', { x: ev.x });
        } else {
          this.spawnParticles(ev.x, ev.y, ev.on ? 3 : 6, { speed: 120, life: 0.3, size: 3, color: '#fcd34d', gravity: 300 });
        }
        break;
      case 'range':   // 飛到最長路徑還沒打到東西（高壓水炮）：散成水霧。半路被設了路徑長度的招式（例如跑到岩柱盡頭的衝擊）由地圖畫面演
        if (weapon.range === undefined) break;
        if (weapon.id === 'rapier') {   // 西洋刺劍刺到底沒碰到東西：劍尖閃一下（不是水霧）
          this.spawnParticles(ev.x, ev.y, 5, { speed: 60, life: 0.25, size: 1.8, color: '#f8fafc', gravity: 0 });
          this.flashes.push({ x: ev.x, y: ev.y, r: 5, life: 0.16, maxLife: 0.16, tint: '241,245,249' });
          break;
        }
        sfx.play('fizzle', { x: ev.x });
        this.spawnParticles(ev.x, ev.y, 14, { speed: 110, life: 0.45, size: 3, color: '#bae6fd', gravity: 250 });
        break;
      case 'water':
        this.splash(ev.x);
        sfx.play('plop', { x: ev.x });
        break;
      case 'explode': {
        if (made.rect) this.painter.repaintRect(made.rect);
        const r = ev.carve ? ev.carve.r : ev.blast || 8;   // 不挖地形的爆炸（無差別轟炸、高壓水炮）照 blast 演
        const big = r >= 25;
        if (weapon.id === 'darts') {   // 飛鏢：插進去「咚」一聲，不爆炸
          sfx.play('thunk', { x: ev.x });
          this.spawnParticles(ev.x, ev.y, 4, { speed: 90, life: 0.3, size: 2, color: '#e7e5e4', gravity: 500 });
          break;
        }
        if (weapon.id === 'rapier') {   // 西洋刺劍：刺中「咚」一聲、劍尖迸出一點火花，不爆炸（刺中人的血由下面的流血飄字噴）
          sfx.play('thunk', { x: ev.x });
          this.spawnParticles(ev.x, ev.y, 5, { speed: 110, life: 0.25, size: 1.8, color: '#f1f5f9', gravity: 300 });
          break;
        }
        if (weapon.id === 'waterCannon') {   // 高壓水炮：水柱打散、水花四濺（不是爆炸）
          sfx.play('splash', { x: ev.x });
          this.spawnParticles(ev.x, ev.y, 22, { speed: 260, life: 0.6, size: 3, color: '#bae6fd', gravity: 600 });
          this.spawnParticles(ev.x, ev.y, 8, { speed: 90, life: 0.5, size: 7, color: 'rgba(125,211,252,0.8)', gravity: -40 });
          this.flashes.push({ x: ev.x, y: ev.y, r: r * 1.2, life: 0.2, maxLife: 0.2, tint: '186,230,253' });
          this.shake = Math.max(this.shake, 6);
          break;
        }
        sfx.play('explode', { x: ev.x, big });
        const tint = weapon.id === 'plasma' ? '165,243,252' : weapon.id === 'bombard' ? '251,113,133' : '255,220,120';
        // 挖到地形才噴土，沒挖的（無差別轟炸）噴灰煙
        this.spawnParticles(ev.x, ev.y, big ? 24 : 8, { speed: big ? 240 : 120, life: 0.7, size: 4, color: ev.carve || !ev.blast ? '#8b5a2b' : '#78716c', gravity: 700 });
        this.spawnParticles(ev.x, ev.y, big ? 12 : 4, { speed: 90, life: 0.5, size: big ? 8 : 5, color: `rgb(${tint})`, gravity: -60 });
        this.flashes.push({ x: ev.x, y: ev.y, r: r * 1.4, life: 0.25, maxLife: 0.25, tint });
        this.shake = Math.max(this.shake, big ? (weapon.id === 'bombard' ? 7 : 12) : 3);
        if (weapon.poison) this.spawnParticles(ev.x, ev.y, 10, { speed: 120, life: 0.5, size: 3, color: '#a855f7', gravity: 300 });   // 毒液濺開
        break;
      }
    }
    if (ev.ignite > 0) {   // 穿過場上的火源著火了（例如洞穴的火把，敵我都會；見 shared/physics/fire.js）：「呼」一聲、竄出一團火
      sfx.play('ignite', { x: ev.x });
      this.spawnParticles(ev.x, ev.y, 14, { speed: 130, life: 0.45, size: 3, color: '#fb923c', gravity: -90 });
      this.flashes.push({ x: ev.x, y: ev.y, r: 22, life: 0.22, maxLife: 0.22, tint: '251,146,60' });
    }
    this.mapView.showEvent(this.mapCtx, ev, made);   // 例如打到巨蟒跨過門檻掉蛇血、打到蜂巢飛出蜜蜂
    this.showDamages(ev.damages);
    const owner = ev.heal ? this.match.byId(shot.actorId) : null;
    if (owner) this.floatText(owner, `+${ev.heal} 吸血`, '#4ade80', 16);
  }

  // 傷害清單（Match.applyExplosion 的 damages：飛行事件的、回合中危險物的）的飄字與特效：無敵擋下、地圖畫面自己演的、分擔、扣血、上燃燒 / 中毒 / 流血、免疫
  showDamages(damages) {
    for (const d of damages || []) {
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
        const color = d.friendly ? '#f9a8d4' : (this.relation(e) !== 'foe' ? '#ff6b6b' : '#ffd166');   // 自己人被打紅色、打到敵人黃色
        this.floatText(e, `-${d.dmg}${d.friendly ? ' 誤傷' : ''}`, color);
      }
      if (d.burn) this.floatText(e, `燃燒 +${d.burn}`, '#fb923c', 15);
      if (d.poison) {   // 上毒（例如巨蟒、蜜蜂；傷害 0 的衝撞 / 噴灑也會有）
        e.hurtTimer = 0.35;
        this.floatText(e, `中毒 +${d.poison}`, '#c084fc', 16);
      }
      if (d.bleed) {   // 流血（會流血的攻擊；傷害 0 也會有）：噴一點血
        e.hurtTimer = 0.35;
        this.floatText(e, `流血 +${d.bleed}`, '#ef4444', 16);
        this.spawnParticles(e.cx, e.cy, 8, { speed: 110, life: 0.5, size: 2.5, color: '#dc2626', gravity: 500 });
      }
      if (d.immune) this.floatText(e, '免疫', '#9ca3af', 15);   // 免疫異常狀態（例如金剛不壞）：這一下該上的燃燒 / 中毒 / 流血沒上
    }
  }

  // 回合中的危險物（地圖機制的 hazard*，例如流浪劍士的劍氣）打到人 / 飛完（伺服器的 hazard）：被打到的人照伺服器的血量
  // （不動位置：行動玩家的位置在他自己的畫面上）、飄字，再交給地圖畫面演（例如劍氣的位置校正、飛完、再揮一輪）
  onHazard(msg) {
    for (const s of msg.hp || []) {
      const e = this.match.byId(s.id);
      if (!e) continue;
      e.hp = s.hp;
      if (s.shield !== undefined) e.shield = s.shield;   // 被無敵擋下也算用掉一次
      if (Number.isFinite(s.poison)) e.poison = s.poison;   // 中毒 / 流血層數（例如古樹的藤蔓、尖刺；流血馬上照新的層數算走路扣的血）
      if (Number.isFinite(s.bleed)) e.bleed = s.bleed;
      readState(e, s);   // 效果自己的狀態（例如被虐體質的層數）
      if (!s.alive && e.alive) e.die(s.cause || 'hit');
    }
    // 危險物把人移走了（Match.relocate，例如被抓起來丟到別的地方）：直接放過去、停下來（自己的話下一次位置回報就從那裡送；
    // 伺服器在那之前擋掉舊位置的回報），別人不要再滑回他最後回報的位置
    for (const m of msg.moved || []) {
      const e = this.match.byId(m.id);
      if (!e || !e.alive || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      Object.assign(e, { x: m.x, y: m.y, vx: 0, vy: 0, slide: 0, moveDir: 0, wantJump: false });
      e.letGoVine();
      e.safeX = m.x;
      e.safeY = m.y;
      this.look(e).netTarget = null;
    }
    this.showDamages(msg.damages);
    if (msg.recvAt === undefined) msg.recvAt = this.clock();
    this.mapView.hazard(this.mapCtx, msg, false);
  }

  // 回合結束的狀態與效果：燃燒扣血 / 甩掉層數、效果的（例如神佑之石、燒死敵人的噬魂加成、時間扭曲；畫面動作由效果給）、地圖畫面的
  *turnFxScript(msg) {
    if (msg.atStart) {   // 回合根本沒開始（回合開始就被毒倒）：現在是他的回合位置，HUD 不要還停在上一位
      this.currentId = msg.actorId;
      if (msg.round) this.match.round = msg.round;
      if (Number.isFinite(msg.wind)) this.match.wind = msg.wind;
      this.canAct = false;
      this.waiting = false;
      this.setShotLock(null, null);
    }
    const banners = [];   // 同一次回合結束可能同時有好幾個（例如神佑之石 + 時間扭曲），合成一行才不會互相蓋掉
    for (const fx of msg.fx) {
      const e = this.match.byId(fx.id);
      if (!e) continue;
      let ops;
      if (fx.type === 'burn') {
        if (fx.dmg > 0) {
          e.hurtTimer = 0.35;
          this.floatText(e, `-${fx.dmg} 燃燒`, '#fb923c');
          this.spawnParticles(e.cx, e.cy, 12, { speed: 70, life: 0.7, size: 4, color: '#f97316', gravity: -160 });
        }
        if (fx.shaken > 0) this.floatText(e, `甩掉 ${fx.shaken} 層燃燒`, '#fdba74', 14);
      } else if (fx.type === 'bleed') {   // 流血：自己的回合結束時止血（層數清掉，快照的 bl 也是 0）
        this.floatText(e, '止血', '#9ca3af', 14);
      } else if (fx.type === 'untangle') {   // 糾纏的回合數用完了（快照的 eg 也是 0）
        this.floatText(e, '糾纏解除', '#e5e7eb', 14);
      } else if ((ops = turnFxOps(fx, e))) {   // 效果的（例如神佑之石、噬魂、時間扭曲）
        this.playEffectOps(ops, banners);
      } else if (!this.mapView.turnFx(this.mapCtx, e, fx)) {   // 地圖畫面的（例如古樹之口又張開了、巨蟒被燒到掉出蛇血）
        this.statusFx(e, fx);   // 中毒結算把人毒倒了（回合開始時，這回合就不開始了）
      }
    }
    if (banners.length) this.showBanner(banners.map(b => b[0]).join('　·　'), banners[0][1]);
    if (msg.entities) this.match.applyEntities(msg.entities);
    this.setItems(msg);
    yield { frames: Math.round(CONFIG.TIMING.fxDelay * FPS * 0.6) };
  }

  // 流血扣到倒下、算到流血來源的擊殺時效果另外記的 fx（aiTurn / skip 帶的，例如噬魂者；同燒死時回合結束的 turnFx）：照效果給的畫面動作播
  effectFx(list) {
    const banners = [];
    for (const fx of list) {
      const e = this.match.byId(fx.id);
      const ops = e ? turnFxOps(fx, e) : null;
      if (ops) this.playEffectOps(ops, banners);
    }
    if (banners.length) this.showBanner(banners.map(b => b[0]).join('　·　'), banners[0][1]);
  }

  // 效果給的畫面動作（見 shared/cards/effects/index.js 的 turnFx）：照順序做；橫幅收進 banners（跟同一次的其他橫幅合成一行），
  // ambient 是整個畫面的演出（不在哪個角色身上，見 startAmbient），飄字與粒子在那個角色身上（角色不在了就跳過）
  playEffectOps(ops, banners) {
    for (const op of ops) {
      if (op[0] === 'banner') { banners.push([op[1], op[2]]); continue; }
      if (op[0] === 'ambient') { this.startAmbient(op[1], op[2]); continue; }
      const t = this.match.byId(op[1]);
      if (!t) continue;
      if (op[0] === 'float') this.floatText(t, op[2], op[3], op[4]);
      else if (op[0] === 'particles') this.spawnParticles(t.cx, t.cy, op[2], op[3]);
    }
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

  // 被困住的人掙扎了一下（伺服器的 struggle：連打數、掙脫了沒、伺服器算的體力）：怎麼套由地圖畫面決定。
  // 體力：別人的照伺服器的；自己的只往下修（自己的畫面一直在扣）。掙脫的是自己：放開按著的 A / D（不然一掙脫就直接走掉）
  onStruggle(msg) {
    const e = this.match.byId(msg.id);
    if (!e) return;
    const self = msg.id === this.myId;
    if (Number.isFinite(msg.stamina) && (!self || msg.stamina < e.stamina)) e.stamina = msg.stamina;
    this.mapView.onStruggle(this.mapCtx, e, msg, self);
    if (self && msg.freed) { this.keys.KeyA = false; this.keys.KeyD = false; }
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
    // 淹死（water）、流血倒下（bleed）的橫幅由 onDeath 播
    if (msg.reason === 'timeout') this.showBanner(msg.actorId === this.myId ? '時間到！' : `${name} 時間到`, '#fbbf24');
    else if (msg.reason !== 'water' && msg.reason !== 'bleed') this.showBanner(`${name} 跳過`, '#fbbf24');
    for (const s of splashes) this.onSplash(this.match.byId(s.id), s);
    if (msg.fx) this.effectFx(msg.fx);   // 流血倒下算到的擊殺（流血來源的效果，例如噬魂者）
    this.canAct = false;
    this.waiting = false;
    this.mouse.down = false;
    this.setShotLock(null, null);   // 飛鏢射到一半時間到：這回合結束了
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
      // 被困住（Entity.held）時的 A / D 是掙扎：每按一下，地圖畫面說算數（例如左右交替）就告訴伺服器
      const dir = code === 'KeyA' ? -1 : code === 'KeyD' ? 1 : 0;
      if (dir && this.canAct && !this.waiting && this.me && this.me.alive && this.me.held && this.mapView.struggle(this.mapCtx, this.me, dir)) {
        this.transport.send({ t: 'struggle', dir });
      }
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
    // 自己這回合已經射過飛鏢：只能繼續用它（伺服器也會擋；兩支之間還沒輪回自己操作時也不准換，下一發才不會送錯武器）
    if (this.lockWeapon && this.currentId === this.myId && id !== this.lockWeapon) {
      this.showHint(`這回合只能用${CONFIG.WEAPONS[this.lockWeapon].name}`);
      return;
    }
    me.weapon = id;
    // 還沒輪到自己也送：伺服器先記著，輪到自己時回合開始的快照才不會把它蓋回原本那把
    this.transport.send({ t: 'weapon', weapon: id });
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
    if (this.canAct && this.deadline !== null && performance.now() >= this.deadline) this.timeUp(me);
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

  // 自己的回合在這個畫面上時間到了（伺服器那邊超時的 skip 隨後就到）：不能再操作、停下來（不再走路流血），
  // 還沒回報的最後一段位置 / 血量馬上補送一次（不等節流）。之後照伺服器的 skip 套最後的狀態
  timeUp(me) {
    this.canAct = false;
    this.mouse.down = false;
    me.moveDir = 0;
    me.slide = 0;   // 還在被迫滑行（香蕉皮）也停在回報的地方
    me.vineDir = 0;
    const s = this.lastSent;
    if (me.alive && (!s || s.x !== me.x || s.y !== me.y || s.facing !== me.facing || s.vine !== me.onVine)) this.sendMove(me);
  }

  // hp = 自己畫面上的血量（流血：走路時本地已經扣了，伺服器在他流血時照收、只能減不能加，見 Match.applyPositionReport）
  sendMove(me) {
    this.lastMoveSent = this.time;
    this.lastSent = { x: me.x, y: me.y, facing: me.facing, vine: me.onVine };
    this.transport.send({ t: 'move', x: me.x, y: me.y, vy: me.vy, facing: me.facing, stamina: me.stamina, vine: me.onVine, hp: me.hp });
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
    if (this.lockWeapon) me.weapon = this.lockWeapon;   // 射過飛鏢的回合只能射飛鏢（送別的伺服器會擋掉，就卡在等結果）
    // 空中也能開火：連同當下的垂直速度一起送，伺服器從同一個狀態接著算落地；掛在藤蔓上開火就帶 vine；hp 同 sendMove（流血）
    this.transport.send({
      t: 'fire', weapon: me.weapon, angle: me.aimAngle, power: me.aimPower,
      x: me.x, y: me.y, vy: me.vy, facing: me.facing, stamina: me.stamina, vine: me.onVine, hp: me.hp,
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
    if (this.slowMo) me.stamina = Math.max(0, me.stamina - S.cost * me.staminaMult * realDt);   // 糾纏中消耗變多
    // 自己的回合裡體力持續流失（Entity.staminaDrain，由地圖機制設定；伺服器照它的規則自己算、照牆上的時鐘）：
    // 飛鏢射出去、等重播的時候（waiting）也扣，跟伺服器一樣
    const myTurn = !!(me && me.alive && this.currentId === this.myId && !this.currentIsAi && (this.canAct || this.waiting));
    if (myTurn && me.staminaDrain > 0) me.stamina = Math.max(0, me.stamina - me.staminaDrain * realDt);
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
    if (this.banner && (this.banner.timer -= dt) <= 0) {
      this.banner = this.nextBanner || null;   // 排著的橫幅（hold 的那張播完才輪到它）
      this.nextBanner = null;
    }
    if (this.hint && (this.hint.timer -= dt) <= 0) this.hint = null;
    this.music.play(this.musicTrack());
    if (!this.match) return;

    this.updateInput();

    const w = this.wait;
    if (w && w.step) {
      // 重播一波的幀（shared/physics/volley.js 的 tick）：這一幀的角色物理就是 tick.step() = match.step 剛好一次（不能再自己跑一次）；
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
      this.bleedFx(e, dt);
      if (e.alive) {   // 伺服器的狀態把他救回來了（applyState）：下次倒下再播，也不再是「中毒倒下」（除非又被毒倒）
        if (v.deathHandled) v.poisonDeath = false;
        v.deathHandled = false;
      } else if (!v.deathHandled) {
        v.deathHandled = true;
        if (e.id === this.myId && this.canAct && e.deathCause === 'bleed') this.reportBleedDeath(e);
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
        if (e.id === this.myId && this.canAct && e.alive && e.waterFalls === falls && this.mapView.predictMove(this.mapCtx, e, px, py)) this.sendMove(e);
      }
      this.moveSfx(e, px, py, wantedJump);
    }
  }

  // 自己操作時掉進水裡：本地已經先扣血、回到岸上（或淹死），把落水的那一點與最後站穩的地方回報給伺服器結算。
  // 撐住了回合繼續（還有體力就能接著動）；按著的方向鍵要放開重按才會再走，免得一回到崖邊又直接走下去。淹死就等伺服器的 skip。
  // hp = 落水扣血之前的血量（流血扣到那時候為止的；伺服器先照它對齊，再自己扣同樣的落水傷害）
  reportWater(me) {
    const s = me.splash;
    this.transport.send({ t: 'move', x: s.x, y: s.y, facing: me.facing, stamina: me.stamina, safe: { x: s.sx, y: s.sy }, hp: s.hp });
    this.keys.KeyA = this.keys.KeyD = false;   // 按住不放的 keydown 是 repeat，會被忽略，所以要重按
    if (s.died) {
      this.canAct = false;
      this.deadline = null;
      this.mouse.down = false;
    }
  }

  // 自己的回合走路流血扣到倒下（本地物理）：馬上回報倒下的位置（hp 0，伺服器照收、結束這回合），之後不能再操作；等伺服器的 skip
  reportBleedDeath(me) {
    this.sendMove(me);
    this.canAct = false;
    this.deadline = null;
    this.mouse.down = false;
  }

  // 流血的飄字與滴血：本地物理 / 重播走路扣的（e.bledThisTurn 變多了）先累積起來，每 0.5 秒（倒下時馬上）飄一次「-N」；
  // 扣血的那幾幀身上滴血。粒子都在這裡（update）生，畫的時候不改任何東西
  bleedFx(e, dt) {
    const v = this.look(e);
    const d = e.bledThisTurn - v.bleedSeen;
    v.bleedSeen = e.bledThisTurn;
    if (d > 0) this.noteBleed(e, d);
    if (!(v.bleedLoss > 0)) return;
    v.bleedClock += dt;
    if (v.bleedClock < 0.5 && e.alive) return;
    this.floatText(e, `-${v.bleedLoss}`, '#ef4444', 16);
    v.bleedLoss = 0;
    v.bleedClock = 0;
  }

  // 流血扣了 n 點（本地物理，或別人回報的 move 帶來的）：記下來等 bleedFx 飄字，身上滴幾滴血（不閃白：一直走一直扣，閃起來太吵）
  noteBleed(e, n) {
    const v = this.look(e);
    v.bleedLoss += n;
    this.spawnParticles(e.cx, e.y - e.h * 0.4, Math.min(3, n), { speed: 40, life: 0.6, size: 2.5, color: '#dc2626', gravity: 600 });
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
    this.floatText(e, `-${s.dmg} 落水`, this.relation(e) !== 'foe' ? '#ff6b6b' : '#ffd166');
    this.spawnParticles(e.cx, e.cy, 10, { speed: 90, life: 0.5, size: 3, color: this.splashColor(), gravity: 500 });
    this.showBanner(`${e.name} 掉進水裡了！`, '#93c5fd');
  }

  onDeath(e) {
    if (this.mapView.onDeath(this.mapCtx, e)) return;   // 地圖畫面自己的死亡特效（例如古樹倒下、巨蟒倒下、蜂巢被打掉）
    if (this.look(e).poisonDeath) { this.showBanner(`${e.name} 中毒倒下了！`, '#c084fc'); return; }
    if (e.deathCause === 'bleed') { this.showBanner(`${e.name} 失血倒下了！`, '#ef4444'); return; }
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
  // sub = 主標題底下的第二行（狂熱提示），有的話橫幅多停一下。
  // hold = 這張要停滿時間（例如菁英關的開場說明）：還沒播完時來的新橫幅先排著，等它播完才出來（只排最新的一張）
  showBanner(str, color, sub = null, { hold = false } = {}) {
    const t = sub ? 2.4 : 1.6;
    const banner = { text: str, color, sub, timer: t, total: t, hold };
    if (this.banner && this.banner.hold && this.banner.timer > 0) { this.nextBanner = banner; return; }
    this.banner = banner;
    this.nextBanner = null;
  }
  showHint(str) { this.hint = { text: str, timer: 1.5 }; }

  // 角色頭上的飄字；同一個角色短時間內的多行字往上疊，不會重在一起
  floatText(e, str, color, size = 20) {
    const stacked = this.floatTexts.filter(f => f.id === e.id && f.life > 0.8).length;
    this.floatTexts.push({ id: e.id, x: e.cx, y: e.y - e.h - 22 - stacked * 20, text: str, life: 1.1, color, size });
  }

  // 水花的顏色：關卡指定了水色（waterColors，例如泥水坑）就用它的第三個（水花色），不然一般的淺藍
  splashColor() {
    const t = this.match && this.match.level.waterColors;
    return t && t[2] ? t[2] : '#9ed0ff';
  }

  splash(x) {
    this.spawnParticles(x, CONFIG.WATER_LEVEL, 18, { speed: 180, life: 0.8, size: 3, color: this.splashColor(), gravity: 800 });
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
    for (const a of this.ambient) a.t += dt;
    this.ambient = this.ambient.filter(a => a.t < a.dur);
  }

  // 整個畫面的演出（效果的 ambient 動作，例如狂歡派對在狂熱疊上新的一層時）：一筆 { kind, t, dur, sprites }，
  // 開始的時候把要畫的東西都決定好（亂數只在這裡用），t 在 updateEffects 推進、播完就拿掉；Renderer.drawAmbient 只照 t 算位置、不改任何東西。
  // balloons = 一群半透明的氣球從戰場下面往上飄過整個畫面（每顆分一段寬度散開、晚一點點出發、左右晃）
  startAmbient(kind, secs) {
    if (kind !== 'balloons') return;   // 不認得的種類不播
    const W = CONFIG.WORLD_W, H = CONFIG.WORLD_H;
    const dur = secs > 0 ? secs : 3.5;
    const COLORS = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa', '#f472b6', '#fb923c'];
    const n = 14;
    const sprites = [];
    for (let i = 0; i < n; i++) {
      const r = 13 + Math.random() * 7;
      const delay = Math.random() * dur * 0.3;
      const y0 = H + r + Math.random() * 40;   // 從畫面下緣底下出發
      const y1 = -r - 3 * r;                   // 連繩子一起飄出畫面上緣
      sprites.push({
        x: W * (i + 0.15 + Math.random() * 0.7) / n, y0, delay, r, rise: (y0 - y1) / (dur - delay),
        color: COLORS[i % COLORS.length], phase: Math.random() * Math.PI * 2, sway: 6 + Math.random() * 10,
      });
    }
    this.ambient.push({ kind, t: 0, dur, sprites });
  }

  render() {
    this.renderer.draw();
  }
}
