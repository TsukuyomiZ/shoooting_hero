import { CONFIG } from '../core/config.js';
import { clamp, logValue } from '../core/utils.js';
import { effectSum, grantsAgain, shotLogOf, writeState } from '../cards/effects/index.js';

// 一發（或一波轟炸）結算完要等多久：飛行 + 落地 + 緩衝。客戶端的播放時間比這短，不會被下一個事件追上
const shotSeconds = (shot) => (shot.flightFrames + shot.settleFrames) / 60 + CONFIG.TIMING.afterShotPad;
// 一次落水給客戶端播的資料（水花在哪、扣了多少、有沒有淹死；n = 這一關第幾次落水，客戶端用來判斷自己是不是已經播過）
const splashOf = (e) => ({ id: e.id, n: e.splash.n, x: e.splash.x, dmg: e.splash.dmg, died: e.splash.died });
// 回合中的危險物（地圖機制的 hazard*）多久推進、判定一次（ms）
const HAZARD_TICK = 50;
// 地圖機制給的資料只記純量欄位、純量的陣列與（一層一層往下的）物件（數字取到小數一位），給紀錄用
// 陣列裡的物件也照樣轉（例如天狗這回合射出去的每一根羽毛 feathers: [{ id, x0, y0, … }]）
function plainFields(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = plainValue(v);
  return out;
}
function plainValue(v) {
  if (v === null || typeof v !== 'object') return typeof v === 'number' ? r1(v) : v;
  if (Array.isArray(v)) return v.map(plainValue);
  return plainFields(v);
}

// ---- 紀錄（LOG）用的小工具：結算前後各拍一張血量快照，一比就知道誰扣 / 回了多少血、誰倒下、誰是新召喚的 ----
const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : n);
// 一發改到的地形與場景（地圖機制附在事件上的）：掉下來的鐘乳石 falls、點燃的火把 lights（第幾根 / 第幾支），沒有就不帶；
// 穿過地圖上的火著火的飛行物 ignited（第幾顆，例如穿過洞穴的火把）；
// 處刑官跳下處刑台 descend（[{ x0, y0, x, y, cry? }]：從哪裡跳到哪裡）、跳上處刑台放出下一隻 release（[{ cell, beast, x0, y0, x, y, plan, cleared? }]：
// 第幾間牢房、哪種猛獸、牠的第一招、跳上去前清掉的負面狀態）：打倒猛獸 / 打到門檻的那一下的事件帶的，再接這一波結算完地圖機制連帶的
// （接在結果上，見 mechanics/index.js 的 cascade），照順序（同一波可能跳下來又跳上去）；處刑官被打了幾下 fury（這一發之後的總數，武器傷害 +N%）；
// 熊抱著人被打了多少 hugDmg（這一發之後的總數，打夠了就放開）、熊放開 unhug（[{ id: 熊, targetId: 被抱的人, why: free / stun / dead }]）；
// 蜘蛛女王換了狀態 queen（[{ from, to, x0, y0, x, y }]：被燒到掉下來、最後一顆蛋破了從背景回來…；事件帶的與這一波結算完連帶的，照順序）
function sceneChanges(shot) {
  const out = {};
  for (const key of ['falls', 'lights', 'stuns']) {   // stuns = 掉下來的吊燈砸暈的敵人（處刑監獄）
    const list = shot ? shot.events.flatMap(ev => ev[key] || []) : [];
    if (list.length) out[key] = list;
  }
  const ignited = shot ? shot.events.filter(ev => ev.ignite > 0).map(ev => ev.p) : [];
  if (ignited.length) out.ignited = ignited;
  const descend = shot ? [...shot.events.filter(ev => ev.descend).map(ev => ev.descend), ...(shot.descend ? [shot.descend] : [])] : [];
  if (descend.length) out.descend = descend;
  const release = shot ? [...shot.events.filter(ev => ev.release).map(ev => ev.release), ...(shot.release ? [shot.release] : [])] : [];
  if (release.length) out.release = release.map(({ spec, plan, ...r }) => ({ ...r, plan: plan && plan.action }));
  const fury = shot ? shot.events.filter(ev => Number.isFinite(ev.fury)).map(ev => ev.fury) : [];
  if (fury.length) out.fury = fury[fury.length - 1];
  const hugDmg = shot ? shot.events.filter(ev => Number.isFinite(ev.hugDmg)).map(ev => ev.hugDmg) : [];
  if (hugDmg.length) out.hugDmg = hugDmg[hugDmg.length - 1];
  const unhug = shot ? shot.events.filter(ev => ev.unhug).map(ev => ev.unhug) : [];
  if (unhug.length) out.unhug = unhug;
  const queen = shot ? [...shot.events.filter(ev => ev.queen).map(ev => ev.queen), ...(shot.queen ? [shot.queen] : [])] : [];
  if (queen.length) out.queen = queen;
  // 調皮妖精：這一發打到本尊 → 消失的分身（vanish）、打破的分身（blasts：在哪炸開、誰打的、魅惑了誰）、剛生氣（angry）
  const fairy = shot ? shot.events.filter(ev => ev.fairy).map(ev => ev.fairy) : [];
  if (fairy.length) out.fairy = fairy;
  return out;
}
const hpOf = (match) => new Map(match.entities.map(e => [e.id, { hp: e.hp, alive: e.alive }]));
function hpChanges(match, before) {
  const out = [];
  for (const e of match.entities) {
    const b = before.get(e.id);
    // 新出現的（召喚的樹妖、飛出來的蜜蜂）；同一個動作裡就被打死的也標 died
    if (!b) { out.push({ id: e.id, name: e.name, hp: [null, r1(e.hp)], spawned: true, ...(e.alive ? {} : { died: e.deathCause || true }) }); continue; }
    if (b.hp === e.hp && b.alive === e.alive) continue;
    out.push({ id: e.id, name: e.name, hp: [r1(b.hp), r1(e.hp)], ...(b.alive && !e.alive ? { died: e.deathCause || true } : {}) });
  }
  return out;
}
// 回合類紀錄的主角：actor = 誰的回合（玩家或敵人的 id）；是玩家的話再帶 pid，用 pid 找一個人的紀錄才找得到他的回合
const actorOf = (e) => ({ actor: e.id, ...(e.isPlayer ? { pid: e.id } : {}), name: e.name });
// 流血扣到倒下算到的擊殺（Match.creditBleed 的 kill：AI 走路 / 飄移途中、行動玩家回報的血量）：killedBy = 拿到擊殺的人（流血來源）、
// fx = 擊殺的效果另外記的（例如噬魂者，同燒死的 turn.end）。ai.turn / turn.skip 照這個記；fx 也跟著 aiTurn / skip 給客戶端飄字
const killOf = (kill) => (kill ? { killedBy: kill.by, ...(kill.fx.length ? { fx: kill.fx } : {}) } : {});
const killFxOf = (kill) => (kill && kill.fx.length ? { fx: kill.fx } : {});
// 預定的下一招（Boss / 菁英的 next；只記純量）：next = 招式；nextLedge = 預定打哪個平台（獨眼巨人的猛捶，玩家回合的警示帶畫在那根上）；
// nextSeal = 一般招式之後還要丟超巨石、封哪個平台（獨眼巨人，玩家回合的警示畫在那裡）；
// nextTarget = 鎖定了某個人（例如大樹守衛的衝鋒標記、躍擊鎖定）的 id；nextSide = 預定打哪一邊（-1 左 / 1 右，例如蓋亞的神掌・天罰）。
// ai.turn（出完招再排的）與 battle.start（開場就排好的第一招）都照這個記
const nextOf = (next) => ({
  next: next && next.action,
  ...(next && Number.isInteger(next.ledge) ? { nextLedge: next.ledge } : {}),
  ...(next && Number.isInteger(next.side) ? { nextSide: next.side } : {}),
  ...(next && Number.isInteger(next.seal) ? { nextSeal: next.seal } : {}),
  ...(next && typeof next.targetId === 'string' ? { nextTarget: next.targetId } : {}),
  ...(next && Array.isArray(next.targetIds) ? { nextTargets: next.targetIds.slice() } : {}),
});
// 開場就抽好的第一招：地圖機制的快照裡預定的下一招（名字以 Next 結尾、帶 action 的欄位，例如 guardianNext、cyclopsNext）；沒有 = null
function openingPlan(snapshot) {
  for (const [k, v] of Object.entries(snapshot)) if (/Next$/.test(k) && v && typeof v.action === 'string') return v;
  // 機制的狀態整包放在一個欄位的（處刑監獄的 prison、蜘蛛巢穴的 spider）：看它的 next
  for (const v of Object.values(snapshot)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && v.next && typeof v.next.action === 'string') return v.next;
  }
  return null;
}
// 開場就挑好的「罪人」（處刑監獄：所有攻擊都先打他）：機制的狀態整包放在一個欄位、裡面帶 sinner（玩家 id）的；沒有 = null
function openingSinner(snapshot) {
  for (const v of Object.values(snapshot)) if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.sinner === 'string') return v.sinner;
  return null;
}
// 慢動作關掉的原因（客戶端送的，認得的才記）：fire 放開左鍵開火、land 落地 / 抓到藤蔓 / 掉進水裡、stamina 體力用完、release 沒開火就放開、
// reconnect 回合中重新連線（新的頁面沒有開著慢動作）。回合結束時還開著的，裁判自己補記（closeSlow：fire / timeout / water / bleed / disconnected / takeover）
const SLOW_WHY = ['fire', 'land', 'stamina', 'release', 'reconnect'];

// 裁判：一場遊戲的流程（誰的回合、計時、AI 回合、開火結算、裝備的回合效果、勝負）。
// 同一份程式在 Node 房間裡跑（多人），也在瀏覽器裡跑（單人練習）。
// io = { broadcast(msg, exceptId), schedule(fn, ms) → handle, cancel(handle), now() → ms }
//
// 一個回合：nextTurn（回合開始：效果的一波攻擊，例如無差別轟炸）→ startTurn（中毒結算、站在蛇血上就喝、效果（恩賜之杖回血）、
//          開始計時 / AI 行動；被毒倒就直接換人）→ 開火 / 超時 / AI 播完 → finishTurn（回合結束：燃燒、地圖機制、效果（神佑之石、時間扭曲））
//          → 下一位的 nextTurn（效果給了額外回合的話，nextTurn 會讓同一位再來一次，不算新的一輪）。
// 牌的效果（shared/cards/effects/）裁判一個都不認得：回合秒數、回合開始的攻擊、額外回合、開火紀錄的欄位都問效果的登記表
export class Referee {
  // humans[i].connected 可省略（預設 true）；humans[i].bot = 電腦玩家（勝者為王：一直由 AI 操作，跟斷線代打一樣，只是不算斷線）；
  // onGameOver(result) 讓肉鴿流程接手下一步；
  // onRoundEnd(round, resume) = 一輪打完、下一輪開始之前要先做的事（勝者為王的選牌）：裁判停在 'break'，做完呼叫 resume() 才接著開始下一輪
  constructor({ match, humans, io, onGameOver = null, stageInfo = null, onRoundEnd = null }) {
    this.match = match;
    this.io = io;
    this.onGameOver = onGameOver;
    this.onRoundEnd = onRoundEnd;
    this.roundBreak = false;   // 這一次的「一輪打完」已經交給 onRoundEnd 了（resume 回來時不再問一次）
    this.stageInfo = stageInfo;
    this.humans = new Map(humans.map(h => [h.id, { id: h.id, name: h.name, connected: h.connected !== false && !h.bot, bot: !!h.bot }]));
    this.currentId = null;
    this.extraTurn = false;   // 目前這個回合是不是時間扭曲給的額外回合
    this.slowOn = false;      // 行動玩家現在是不是開著慢動作（他回報的；每個回合開始重設）
    // 一回合可以分開射好幾次的武器（武器的 shotsPerTurn，例如飛鏢）：射出第一發之後這回合只能用它（lockWeapon），
    // shotsLeft = 這回合還能射幾次。還沒用這種武器是 null；每個回合開始重設
    this.lockWeapon = null;
    this.shotsLeft = null;
    this.phase = 'idle';   // idle | starting | turn | resolving | over
    this.timer = null;
    this.deadline = null;
    this.hazardTimer = null;   // 回合中的危險物下一次推進的計時（見 hazardTick）
    this.turnSeq = 0;          // 第幾個回合（回合開始就加一；危險物的 turn / hazard 訊息帶著，客戶端用來對上是哪一個回合的）
  }

  // ---- 對外 ----
  start() {
    this.phase = 'starting';
    // 開場就抽好的第一招（Boss / 菁英；玩家第一個回合就看得到標記）照 ai.turn 的 next / nextLedge / nextSeal / nextTarget 記；處刑監獄的罪人記 sinner
    const snap = this.match.snapshot();
    const plan = openingPlan(snap);
    const sinner = openingSinner(snap);
    this.record('battle.start', {
      level: this.match.levelId, seed: this.match.seed,
      entities: this.match.entities.map(e => ({
        id: e.id, name: e.name, team: e.team, ...(e.kind ? { kind: e.kind } : {}), ...(e.part ? { part: e.part } : {}),
        hp: r1(e.hp), maxHp: r1(e.maxHp), x: r1(e.x), y: r1(e.y),
      })),
      ...(plan ? nextOf(plan) : {}),
      ...(sinner ? { sinner } : {}),
    });
    this.io.broadcast({ t: 'start', ...this.startPayload() });
    this.schedule(() => this.nextTurn(), CONFIG.TIMING.startDelay);
  }

  stop() {
    this.cancelTimer();
    this.stopHazard();
    this.phase = 'over';
  }

  // 第幾輪（記在 Match，裁判在 nextTurn 加一）
  get round() { return this.match.round; }

  // 新的一輪（nextTurn 判斷的）：輪數 +1（Match.beginRound），記一筆 round.start（記錄本身就帶新的輪數；
  // fx = 地圖機制每一輪的變化，例如岩穴的火把變暗 torchDim / 熄滅 torchOut，沒有就不帶）。客戶端照 turn 等訊息帶的輪數跟上
  newRound() {
    const fx = this.match.beginRound();
    this.record('round.start', fx.length ? { fx } : {});
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

  // 換武器：輪到他的回合裡、或還沒輪到他（別人的回合、子彈還在飛、兩回合之間）都收。
  // 這回合射過飛鏢、還有次數（兩支之間）：只能用它，換不了別把；最後一支射出去之後就可以先換好下回合要用的
  chooseWeapon(playerId, msg) {
    const actor = this.match.byId(playerId);
    if (!actor || !actor.weapons) return this.ignored(playerId, msg, 'notPlayer');
    if (playerId === this.currentId && this.lockWeapon && this.shotsLeft > 0 && msg.weapon !== this.lockWeapon) {
      return this.ignored(playerId, msg, 'weaponLocked');
    }
    if (!actor.weapons.includes(msg.weapon)) return this.ignored(playerId, msg, 'weaponNotOwned');   // 只能切換自己武器欄裡的武器
    actor.weapon = msg.weapon;
    this.record('weapon', { pid: actor.id, name: actor.name, weapon: msg.weapon });
    this.io.broadcast({ t: 'weapon', id: actor.id, weapon: msg.weapon }, playerId);
  }

  // 來自行動玩家的訊息（其他人的訊息一律忽略；換武器例外，見 chooseWeapon）
  handle(playerId, msg) {
    if (!msg || typeof msg !== 'object') return;
    // 換武器不用等輪到自己：還沒輪到 / 子彈還在飛的時候先選好，輪到他時伺服器的狀態就是這把（不然回合開始的快照會把他畫面上換好的武器蓋回去）
    if (msg.t === 'weapon' && !(this.phase === 'turn' && playerId === this.currentId)) return this.chooseWeapon(playerId, msg);
    if (this.phase !== 'turn') return this.ignored(playerId, msg, 'phase:' + this.phase);
    if (playerId !== this.currentId) return this.ignored(playerId, msg, 'notYourTurn');
    const actor = this.match.byId(playerId);
    if (!actor || !actor.alive) return this.ignored(playerId, msg, 'dead');

    switch (msg.t) {
      case 'move': {
        // 位置回報（Match 收下、檢查、結算撿道具與落水；vine = 抓著第幾條藤蔓，超時 / 斷線時伺服器才知道他是掛著；
        // hp = 他畫面上的血量：流血時走路扣的，伺服器照收，見 Match.applyPositionReport）
        const before = hpOf(this.match);   // 流血倒下時 turn.skip 的血量變化從這次回報之前算起
        const report = this.match.applyPositionReport(actor, msg);
        // 這次回報流血扣了幾點、扣完剩多少（同一次回報又掉進水裡的話，是落水扣血之前的：落水的另外記在 water）
        const bled = report.bled ? { hp: r1(report.bledHp), bled: report.bled } : {};
        const bledOut = !actor.alive && !report.water;   // 流血扣到倒下（淹死的另外走 actorFellInWater）
        if (!report.ok) {
          // 位置不合理（瞬移、出界、卡進地形）被擋下（血量照收：流血扣到倒下一樣結束這回合）
          this.record('move.reject', { pid: actor.id, name: actor.name, x: logValue(msg.x), y: logValue(msg.y), from: [r1(actor.x), r1(actor.y)], ...bled });
          if (bledOut) this.skipTurn('bleed', [], before, report.kill);
          break;
        }
        // 每一次都記（LOG.moves 關掉時由寫檔的地方不寫，見 logWanted）
        this.record('move', {
          pid: actor.id, name: actor.name, x: r1(msg.x), y: r1(msg.y), facing: actor.facing, stamina: r1(actor.stamina),
          ...(actor.onVine >= 0 ? { vine: actor.onVine } : {}), ...bled,
        });
        if (bledOut) { this.skipTurn('bleed', [], before, report.kill); break; }   // 走路流血扣到倒下：這回合結束（跟淹死一樣）
        this.announcePickup(report.pickup);
        if (report.water) { this.actorFellInWater(actor); break; }   // 自己走 / 跳進水裡
        // 轉給其他人；他在流血的話帶 hp（他的血量只有他自己的畫面在扣，別人照這個顯示）
        this.io.broadcast({
          t: 'move', id: actor.id, x: actor.x, y: actor.y, facing: actor.facing, stamina: actor.stamina, vine: actor.onVine,
          ...(actor.bleed > 0 ? { hp: actor.hp } : {}),
        }, playerId);
        break;
      }
      case 'slow': {
        // 慢動作（空中瞄準；只放慢他自己的畫面，體力在他那邊扣、照 move / fire 回報）：開 / 關各記一筆，
        // 告訴其他人在他身上畫光環。狀態沒變的重複訊息不處理；why = 關掉的原因（見 SLOW_WHY）
        const on = msg.on === true;
        if (on === this.slowOn) return this.ignored(playerId, msg, 'slowUnchanged');
        this.slowOn = on;
        const why = !on && SLOW_WHY.includes(msg.why) ? msg.why : null;
        this.record('slowmo', {
          pid: actor.id, name: actor.name, on, stamina: r1(actor.stamina), x: r1(actor.x), y: r1(actor.y), ...(why ? { why } : {}),
        });
        this.io.broadcast({ t: 'slow', id: actor.id, on }, playerId);
        break;
      }
      case 'weapon':
        this.chooseWeapon(playerId, msg);
        break;
      case 'fire': {
        if (!actor.weapons.includes(msg.weapon) || !Number.isFinite(msg.angle) || !Number.isFinite(msg.power)) {
          return this.ignored(playerId, msg, actor.weapons.includes(msg.weapon) ? 'badAim' : 'weaponNotOwned');
        }
        // 位置回報之前就擋掉：被擋下的開火不能移動他
        if (this.lockWeapon && msg.weapon !== this.lockWeapon) return this.ignored(playerId, msg, 'weaponLocked');
        // 空中也能開火：就在回報的位置出手，並接著他當下的垂直速度往下飛 / 落地（開火的回報不收 safe：重生點只認走路掉水那次回報的）
        const pre = hpOf(this.match);   // 流血倒下時 turn.skip 的血量變化從這次回報之前算起
        const report = this.match.applyPositionReport(actor, { ...msg, safe: null });
        this.announcePickup(report.pickup);
        const power = clamp(msg.power, 0, 100);
        const bledOut = !actor.alive && !report.water;   // 走到出手的地方就流血倒下了（淹死的照舊，後面的 actorFellInWater）
        if (!bledOut) this.closeSlow(actor, 'fire');   // 客戶端開火前沒送關的話，這裡補記（流血倒下的由 skipTurn 補記 bleed）
        // 先記開火（玩家的操作：他回報的出手位置），結算的結果另記一筆 shot：結算途中出錯的話，至少知道他是怎麼開的。
        // 出手的位置在水裡的話，後面接著是 water（與淹死的 turn.skip）；posRejected = 回報的位置不合理，從伺服器記得的位置出手；
        // hp / bled = 回報的血量流血扣了幾點（同 move：落水扣血之前的；扣到倒下的話後面接著 turn.skip bleed）
        this.record('fire', {
          pid: actor.id, name: actor.name, weapon: msg.weapon, angle: r1(msg.angle), power: r1(power),
          x: logValue(msg.x), y: logValue(msg.y), ...(Number.isFinite(msg.vy) && msg.vy ? { vy: r1(msg.vy) } : {}),
          ...(actor.onVine >= 0 ? { vine: actor.onVine } : {}), ...(report.ok ? {} : { posRejected: true }),
          ...(report.bled ? { hp: r1(report.bledHp), bled: report.bled } : {}),
        });
        if (bledOut) return this.skipTurn('bleed', [], pre, report.kill);   // 這一發沒射出去
        // 出手的位置已經在水裡：淹死就結束，撐住了就從重生點出手
        if (report.water && this.actorFellInWater(actor)) return;
        // 一回合可以射好幾次的武器（飛鏢）：第一發起鎖定這把、扣次數；計時暫停（飛行與結算不算），還有次數就照開火這一刻剩下的秒數接著算
        const per = CONFIG.WEAPONS[msg.weapon].shotsPerTurn || 1;
        const timeLeft = this.deadline ? Math.max(0, (this.deadline - this.io.now()) / 1000) : 0;
        if (per > 1) {
          if (this.shotsLeft === null) { this.lockWeapon = msg.weapon; this.shotsLeft = per; }
          this.shotsLeft--;
        }
        const again = per > 1 && this.shotsLeft > 0;
        this.phase = 'resolving';
        this.deadline = null;
        const before = hpOf(this.match);
        const shot = this.match.resolveShot(actor, msg.weapon, msg.angle, power);
        const left = per > 1 ? { shotsLeft: this.shotsLeft } : {};   // 這一發之後還能射幾次（客戶端顯示、紀錄用）
        this.recordShot(shot, before, left);
        this.io.broadcast({ t: 'shot', ...shot, ...left });
        if (again) this.schedule(() => this.resumeTurn(actor, timeLeft), (shot.flightFrames + shot.settleFrames) / 60 + CONFIG.TIMING.againPad);
        else this.schedule(() => this.finishTurn(), shotSeconds(shot));
        break;
      }
      case 'struggle': {
        // 被困住時掙扎一下（連打 A / D 的其中一下，例如大樹遊俠的藤蔓陷阱；規則在地圖機制的 struggle）：
        // 沒被困住、同一邊連按、體力流光了都擋下來記 action.ignored；算數的每一下都記、告訴所有人（掙脫了帶 freed）
        const dir = msg.dir === -1 || msg.dir === 1 ? msg.dir : 0;
        if (!dir) return this.ignored(playerId, msg, 'badDir');
        const r = this.match.struggle(actor, dir, this.io.now());
        if (!r) return this.ignored(playerId, msg, 'notTrapped');
        if (!r.ok) {
          // 體力流光了：告訴他（他的畫面卡頓、飛鏢的重播時扣得比較慢的話，體力條才對得上）
          if (r.reason === 'noStamina') this.io.broadcast({ t: 'struggle', id: actor.id, count: r.count, need: r.need, freed: false, stamina: actor.stamina });
          return this.ignored(playerId, msg, r.reason || 'struggleRejected');
        }
        this.record('struggle', {
          pid: actor.id, name: actor.name, dir, count: r.count, need: r.need, stamina: r1(actor.stamina), ...(r.freed ? { freed: true } : {}),
        });
        this.io.broadcast({ t: 'struggle', id: actor.id, count: r.count, need: r.need, freed: !!r.freed, stamina: actor.stamina });
        break;
      }
      default:
        this.ignored(playerId, msg, 'unknown');
    }
  }

  // 回合結束時慢動作還開著（客戶端沒送關：開火前沒關、超時、淹死、斷線代打）：裁判自己補一筆關掉，紀錄的開 / 關才成對
  // （auto = 裁判補的）。客戶端在 shot / skip / aiTurn 都會清掉他身上的光環，不用另外廣播
  closeSlow(actor, why) {
    if (!this.slowOn) return;
    this.slowOn = false;
    this.record('slowmo', {
      pid: actor.id, name: actor.name, on: false, stamina: r1(actor.stamina), x: r1(actor.x), y: r1(actor.y), why, auto: true,
    });
  }

  // 一發（或一波轟炸）的結果：打到什麼、誰扣了多少血、誰倒下；效果要記的欄位（例如磨刀霍霍 / 越戰越強的層數 stacks）。
  // extra = 另外要記的（一回合射好幾次的武器：這一發之後還能射幾次 shotsLeft）。
  // 地圖機制在玩家回合開始出的一波（例如流浪劍士的劍氣）：出手的是敵人，記 actor（不是 pid）、turn = 輪到的玩家、row = 打哪一排
  recordShot(shot, before, extra = {}) {
    const a = this.match.byId(shot.actorId);
    const who = a && !a.isPlayer ? { actor: shot.actorId } : { pid: shot.actorId };
    this.record('shot', {
      ...(shot.hitEnemy !== undefined ? { hitEnemy: shot.hitEnemy } : {}), ...shotLogOf(a),
      kind: shot.kind, ...who, name: (this.match.byId(shot.actorId) || {}).name, weapon: shot.weapon,
      ...(shot.turnId ? { turn: shot.turnId } : {}), ...(Number.isInteger(shot.row) ? { row: shot.row } : {}),
      hit: shot.hit && shot.hit.type, frames: shot.flightFrames, kills: shot.kills, changes: hpChanges(this.match, before),
      ...sceneChanges(shot), ...extra,
    });
  }

  // 一回合可以射好幾次的武器（飛鏢）射完一發、還有次數：回合接著繼續，計時從開火那一刻剩下的秒數接著算，可以再移動、瞄準
  // （不是新的回合：不重算體力、回合數、回合開始 / 結束的效果）。這一發已經分出勝負、或他被連帶打倒，就照平常結束這回合；
  // 飛行途中斷線的（setConnected 只在 turn 階段接手）在這裡交給 AI 代打（只能用鎖定的這把，射一次就結束）
  resumeTurn(actor, timeLeft) {
    this.timer = null;
    if (this.phase === 'over') return;
    if (this.match.result() || !actor.alive) return this.finishTurn();
    const human = this.humans.get(actor.id);
    if (!human || !human.connected) {
      this.record('turn.takeover', { pid: actor.id, name: actor.name, alive: true, shotsLeft: this.shotsLeft });
      return this.runAiTurn(actor);
    }
    this.phase = 'turn';
    this.slowOn = false;
    this.deadline = this.io.now() + timeLeft * 1000;
    this.record('turn.resume', { ...actorOf(actor), weapon: this.lockWeapon, shotsLeft: this.shotsLeft, timeLeft: r1(timeLeft) });
    this.io.broadcast({
      t: 'resume', actorId: actor.id, weapon: this.lockWeapon, shotsLeft: this.shotsLeft, timeLeft,
      entities: this.match.snapshot().entities,
    });
    this.schedule(() => this.skipTurn('timeout'), timeLeft);
  }

  // 行動玩家回報自己掉進水裡（位置回報已經扣完血、把他放回岸上，見 Match.applyPositionReport）。
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

  // 位置回報途中撿到道具（例如叢林巨蟒的蛇血；fx = 地圖機制給的，沒撿到是 null）：告訴所有人（包括他自己——客戶端不自己判斷撿到沒），
  // 只帶上限相關的數值，不帶位置（他自己的畫面已經走到更前面了）
  announcePickup(fx) {
    if (!fx) return;
    const e = this.match.byId(fx.id);
    const { id, ...info } = fx;
    this.record('pickup', { pid: id, name: e.name, ...info, hp: r1(e.hp), maxHp: r1(e.maxHp) });
    this.io.broadcast({ t: 'pickup', ...fx, hp: e.hp, mhp: e.maxHp, lk: e.poisonLock });
  }

  // 玩家連線狀態改變。輪到他卻斷線 → 立刻由 AI 代打
  setConnected(id, connected) {
    const h = this.humans.get(id);
    if (!h || h.bot || h.connected === connected) return;
    h.connected = connected;
    this.io.broadcast({ t: 'playerStatus', id, connected });
    if (!connected && this.phase === 'turn' && this.currentId === id) {
      const actor = this.match.byId(id);
      // 輪到他時斷線：AI 接手這回合（已經射過飛鏢的話 shotsLeft = 還剩幾次，AI 只能用鎖定的那把再射一次）
      this.record('turn.takeover', { pid: id, name: h.name, alive: !!(actor && actor.alive), ...(this.shotsLeft !== null ? { shotsLeft: this.shotsLeft } : {}) });
      if (actor) this.closeSlow(actor, 'takeover');
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
      slowOn: this.slowOn,   // 行動玩家開著慢動作（重連的是他自己：客戶端送關；別人：在他身上畫光環）
      lockWeapon: this.lockWeapon,   // 這回合射過飛鏢：只能用它、還能射幾次（沒有是 null）
      shotsLeft: this.shotsLeft,
      players: this.match.players.map(p => ({
        ...this.playerInfo(p),
        connected: this.humans.has(p.id) ? this.humans.get(p.id).connected : false,
      })),
    };
  }

  // 開場 / 重連給客戶端的玩家名單一筆：客戶端照這份名單建一樣的 Match。勝者為王另外帶隊伍 team，電腦玩家帶 bot
  playerInfo(p) {
    const h = this.humans.get(p.id);
    return {
      id: p.id, name: p.name, slot: p.slot, color: p.color,
      ...(this.match.versus ? { team: p.team } : {}), ...(h && h.bot ? { bot: true } : {}),
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
      players: this.match.players.map(p => this.playerInfo(p)),
      snapshot: this.match.snapshot(),
    };
  }

  // 這一位的回合秒數：基本秒數 + 效果的 turnSecs 槽
  turnTimeFor(actor) {
    return CONFIG.TURN_TIME + effectSum('turnSecs', actor, { match: this.match });
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

  // 輪到下一位：回合開始的效果攻擊（例如無差別轟炸）先播完，再由 startTurn 開始計時。
  // again = 效果（時間扭曲）給了額外回合的角色：讓他再來一個完整的回合，不換人、不算新的一輪
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
    // 他在自己的回合開始被毒倒、或在自己的回合掉水淹死時，下一位不該又算成新的一輪。
    // 輪數記在 Match，狂熱層數跟著輪數走（match.fever，見 shared/game/stage-rules.js）。
    // 一輪打完（不是第一輪）、有 onRoundEnd 的話先停在 'break' 交給它（勝者為王的選牌），它呼叫 resume 才回到這裡開始新的一輪
    if (!extra && (prev < 0 || this.match.entities.indexOf(actor) <= prev)) {
      if (prev >= 0 && this.onRoundEnd && !this.roundBreak) {
        this.roundBreak = true;
        this.phase = 'break';
        this.deadline = null;
        this.onRoundEnd(this.round, () => { if (this.phase === 'break') this.nextTurn(again); });
        return;
      }
      this.roundBreak = false;
      this.newRound();
    }
    this.currentId = actor.id;
    this.extraTurn = extra;
    this.lockWeapon = null;   // 新的回合（含額外回合）：飛鏢的次數重算
    this.shotsLeft = null;
    this.match.beginTurn(actor);
    this.match.rollWind();   // 有風的關卡：每個回合重抽（玩家、敵人的回合都抽；回合開始的轟炸直直落下、不吃風；見 shared/physics/wind.js）

    const volley = this.match.turnBeginVolley(actor);
    if (volley) {
      this.phase = 'resolving';
      this.deadline = null;
      const before = hpOf(this.match);
      const shot = volley();
      this.recordShot(shot, before);
      this.io.broadcast({ t: 'shot', ...shot, round: this.round });
      this.schedule(() => this.startTurn(actor), shotSeconds(shot));
      return;
    }
    this.startTurn(actor);
  }

  // ---- 回合中即時移動 / 倒數的危險物（地圖機制的 hazard*，例如流浪劍士的劍氣在玩家回合裡慢慢飛過整排）----
  // 玩家的回合開始時出發（startTurn），之後每 HAZARD_TICK ms 推進一次、打碰到的人（照伺服器知道的位置：行動玩家照他的位置回報，
  // 開火結算 / AI 代打之後照結算完的位置）；打到人、有事要演（notify）或全部結束才廣播 hazard、記一筆。
  // flush = 回合要收尾了（finishTurn）：還沒到時間的現在就結算、不再排下一次；還在動的剩下那段由 finishTurn 一口氣結算。
  // 打到行動玩家把他打倒 → 這回合結束（skip 'hazard'）；勝負（全隊倒下、劍士倒下）交給回合收尾（finishTurn → closeTurn → nextTurn）
  hazardTick(flush = false) {
    this.hazardTimer = null;
    if (this.phase === 'over') return;
    const before = hpOf(this.match);
    const step = this.match.hazardStep(this.io.now(), flush);
    if (!step) return;
    const { damages = [], done = false, notify = false, ...info } = step;
    if (damages.length || done || notify) {
      const ids = new Set(damages.map(d => d.id));
      this.record('hazard', {
        ...plainFields(info), turn: this.currentId, ...(done ? { done: true } : {}),
        ...(damages.length ? { changes: hpChanges(this.match, before) } : {}),
      });
      // hp = 被打到的人（含分到傷害的連結對象）扣完的狀態：血量、無敵、效果自己的狀態（例如被虐體質的層數）；
      // 不帶位置（行動玩家的位置在他自己的畫面上）。seq = 這是第幾個回合的危險物（客戶端判斷能不能收到就先演）
      const hp = this.match.entities.filter(e => ids.has(e.id)).map(e => ({ id: e.id, hp: e.hp, alive: e.alive, cause: e.deathCause, shield: e.shield, ...writeState(e, {}) }));
      this.io.broadcast({ t: 'hazard', ...info, seq: this.turnSeq, damages, done, hp });
    }
    // 勝負不在這裡判：開火結算、AI 代打播放的時候也在推進，分出勝負交給已經排好的 finishTurn → closeTurn → nextTurn（跟其他地圖一樣等動畫播完）。
    // 行動玩家在自己操作的時候被打倒：這回合結束
    const actor = this.match.byId(this.currentId);
    if (this.phase === 'turn' && actor && !actor.alive) this.skipTurn('hazard');
    if (!done && !flush) this.hazardTimer = this.io.schedule(() => this.hazardTick(), HAZARD_TICK);
  }

  stopHazard() {
    if (!this.hazardTimer) return;
    this.io.cancel(this.hazardTimer);
    this.hazardTimer = null;
  }

  startTurn(actor) {
    this.timer = null;
    if (this.phase === 'over') return;
    const result = this.match.result();   // 轟炸可能直接把敵人清光
    if (result) return this.gameOver(result);
    if (!actor.alive) return this.finishTurn();

    const fx = this.match.turnStartEffects(actor);
    const human = this.humans.get(actor.id);
    // 這回合由遊戲接手（地圖機制的 takeover，例如調皮妖精的魅惑）：照 AI 回合跑（他自己的畫面不能操作），turn 帶 forced 給畫面說明
    const forced = actor.alive ? this.match.takeover(actor) : null;
    const isHuman = actor.isPlayer && !!human && human.connected && !forced;
    const { entities, items } = this.match.snapshot();
    // 這個回合裡即時移動的危險物（例如流浪劍士的劍氣）：現在出發，跟著 turn 的 hazard 給客戶端畫
    this.turnSeq++;
    const started = actor.alive ? this.match.hazardStart(actor, this.io.now()) : null;
    const hazard = started ? { ...started, seq: this.turnSeq } : null;
    const withHazard = hazard ? { hazard } : {};
    const windy = this.match.windMax ? { wind: this.match.wind } : {};   // 有風的關卡：這個回合的風（客戶端的預覽、HUD 照它）
    // ai = 敵人、斷線玩家的代打（takeover）、電腦玩家（bot）或地圖機制接手（forced = 原因，例如 'charm'）；
    // fx = 回合開始的效果（中毒、喝蛇血、回血）；diedAtStart = 被毒倒，這回合不開始；hazard = 這回合出發的危險物
    this.record('turn.start', {
      ...actorOf(actor), team: actor.team, ai: !isHuman,
      ...(actor.isPlayer && !isHuman ? (human && human.bot ? { bot: true } : forced && human && human.connected ? {} : { takeover: true }) : {}),
      ...(forced ? { forced: forced.reason } : {}),
      ...(this.extraTurn ? { extra: true } : {}),
      hp: r1(actor.hp), maxHp: r1(actor.maxHp), ...(this.match.fever ? { fever: this.match.fever } : {}),
      ...(isHuman ? { turnTime: this.turnTimeFor(actor) } : {}),
      ...(fx.length ? { fx } : {}), ...(actor.alive ? {} : { diedAtStart: true }),
      ...(hazard ? { hazard: plainFields(hazard) } : {}), ...windy,
    });
    if (hazard) {
      this.stopHazard();
      this.hazardTimer = this.io.schedule(() => this.hazardTick(), HAZARD_TICK);
    }
    if (!actor.alive) {   // 回合開始的中毒結算把他毒倒了：這回合不開始，播完效果就換下一位（全隊倒下就在 nextTurn 判輸）
      this.phase = 'resolving';
      this.deadline = null;
      // atStart：客戶端把「現在輪到誰」換成他（像轟炸那樣），HUD 才不會還停在上一位
      this.io.broadcast({ t: 'turnFx', actorId: actor.id, atStart: true, round: this.round, fx, entities, items, ...windy });
      this.schedule(() => this.finishTurn(), CONFIG.TIMING.fxDelay);
      return;
    }
    if (isHuman) {
      const secs = this.turnTimeFor(actor);
      this.phase = 'turn';
      this.slowOn = false;
      this.deadline = this.io.now() + secs * 1000;
      this.io.broadcast({ t: 'turn', actorId: actor.id, round: this.round, ai: false, turnTime: secs, entities, items, fx, extra: this.extraTurn, ...withHazard, ...windy });
      this.schedule(() => this.skipTurn('timeout'), secs);
    } else {
      this.io.broadcast({
        t: 'turn', actorId: actor.id, round: this.round, ai: true, turnTime: null, entities, items, fx, extra: this.extraTurn,
        ...(forced ? { forced } : {}), ...withHazard, ...windy,
      });
      this.runAiTurn(actor);
    }
  }

  // 目前這位的回合做完了（開火結算完 / 時間到 / AI 播完）：回合中的危險物還沒到時間的現在就結算（hazardTick(true)），
  // 還在動的剩下那段一口氣結算完（例如流浪劍士的劍氣，照現在大家的位置），再收尾（closeTurn）
  finishTurn() {
    this.timer = null;
    if (this.phase === 'over') return;
    this.stopHazard();
    this.hazardTick(true);
    if (this.phase === 'over') return;
    const rest = this.match.hazardFinish();
    if (!rest) return this.closeTurn();
    this.phase = 'resolving';
    this.deadline = null;
    const before = hpOf(this.match);
    const shot = rest();
    this.recordShot(shot, before);
    this.io.broadcast({ t: 'shot', ...shot, round: this.round });
    this.schedule(() => this.closeTurn(), shotSeconds(shot));
  }

  // 回合收尾：結算回合結束的裝備效果，再輪下一位
  closeTurn() {
    this.timer = null;
    if (this.phase === 'over') return;
    const actor = this.match.byId(this.currentId);
    const before = hpOf(this.match);
    const fx = actor ? this.match.endTurn(actor, this.extraTurn) : [];
    // fx = 回合結束的狀態 / 地圖機制 / 效果（燃燒、神佑之石、時間扭曲、古樹嘴巴張開…）；changes = 這些造成的血量變化
    this.record('turn.end', {
      ...(actor ? { ...actorOf(actor), hp: r1(actor.hp), alive: actor.alive } : { actor: this.currentId }),
      ...(fx.length ? { fx, changes: hpChanges(this.match, before) } : {}),
    });
    if (!fx.length) return this.nextTurn();
    const again = grantsAgain(fx) ? actor : null;   // 效果給了額外回合（時間扭曲）：同一位再來一回合
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
    const splashes = actor.isPlayer ? this.settleWithSplashes() : [];
    if (!actor.alive) { this.skipTurn('water', splashes, before); return; }   // 掉下去淹死了（紀錄的血量變化從落地前算起）
    const entities = this.match.snapshot().entities;   // 走路前的狀態，客戶端從這裡開始重播
    // 伺服器也套一次同一份狀態（跟客戶端收到 aiTurn 時一樣：速度歸零、放開方向鍵）：落地那一幀停下的 settle
    // 會留下落地前的 vy，不歸零的話走路 / 落地的模擬跟客戶端差一點，瞄準完重播開火時又被拉回去
    this.match.applyEntities(entities);
    // 已經射過飛鏢的回合被接手：AI 只能用鎖定的那把，射這一支就結束（不會再回到他手上：剩下的次數歸零，重連的狀態也照這個）
    // forced = 這一發由地圖機制決定（例如被魅惑的人打隊友：targetId、aimed = 有沒有瞄準），紀錄帶著
    const { walk, glide, plan, boss, kill = null, forced = null } = this.match.planAiTurn(actor, this.lockWeapon ? [this.lockWeapon] : null);
    if (this.shotsLeft !== null) this.shotsLeft = 0;
    const T = CONFIG.TIMING;
    const h = this.humans.get(actor.id);
    const who = { ...actorOf(actor), ...(actor.isPlayer ? (h && h.bot ? { bot: true } : forced && h && h.connected ? {} : { takeover: true }) : {}), ...(forced ? { forced } : {}) };
    // 飄移（蝙蝠、獨眼巨人，見 ai-move.js）：客戶端照 { dx, dy, frames } 重播，紀錄也帶著
    const moved = glide ? { glide: { dx: glide.dx, dy: glide.dy, frames: glide.frames } } : {};
    const glideSecs = glide ? glide.frames / 60 : 0;
    let secs;
    if (boss) {
      // Boss 的招式：每一招只記純量欄位（招式、平面、目標、回血…）與純量的陣列（例如獨眼巨人巨石投擲的 targetIds = 每個人各一顆、照出手的順序；
      // 超巨石壓死的 killed、壓碎的鐘乳石 rocks；震盪獅吼擊碎的 shattered），召喚的樹妖記 id；next = 預定的下一招
      const steps = boss.steps.map(st => {
        const o = {};
        for (const [k, v] of Object.entries(st)) {
          if (v === null || typeof v !== 'object') o[k] = v;
          else if (Array.isArray(v) && v.every(x => x === null || typeof x !== 'object')) o[k] = v.slice();
        }
        if (Array.isArray(st.spawns)) o.spawns = st.spawns.map(s => s.id);
        if (st.shot) Object.assign(o, sceneChanges(st.shot));   // 這一招改到的場景（例如獨眼巨人猛捶震下來的鐘乳石 falls、點燃的火把 lights）
        return o;
      });
      // 預定的下一招（nextOf）：獨眼巨人的猛捶帶 nextLedge（預定打哪個平台）、下一回合要丟超巨石的帶 nextSeal（要封哪個平台）、鎖定了某個人的（大樹守衛的衝鋒標記、躍擊鎖定）帶 nextTarget、
      // 鎖定了好幾個人的（流浪劍士一閃的預警線，每一道對準誰）帶 nextTargets
      this.record('ai.turn', { ...who, ...moved, boss: steps, ...nextOf(boss.next), changes: hpChanges(this.match, before) });
      this.io.broadcast({ t: 'aiTurn', actorId: actor.id, entities, walk: null, ...moved, shot: null, boss });
      // 每一招的預兆動畫：招式自己帶 cast（秒，例如洞穴巨蠍一回合好幾招、每招短一點）就照它，不然 bossCast
      const stepSecs = boss.steps.reduce((s, st) => s + (st.cast ?? T.bossCast)
        + (st.shot ? st.shot.flightFrames + st.shot.settleFrames : st.still.settleFrames) / 60, 0);
      secs = T.aiThink + glideSecs + stepSecs + T.afterShotPad;
    } else {
      // 走路（見 ai-move.js）：客戶端照 { dir, frames, fall } 重播（fall = 走完還在半空中、放開方向鍵落到站穩的幀數）。
      // 斷線代打的玩家路上撿到的道具（點燃火把、喝到蛇血）跟著 aiTurn 的 pickups（f = 走到第幾幀撿到的，客戶端播到那一幀才套），
      // 也跟自己走過去一樣各記一筆 pickup（takeover；hp = 撿到那一刻的血量，在開火之前）。
      // 走路 / 飄移途中流血倒下（Match.planAiTurn 不給 plan）：照樣廣播走動、不開火（shot: null），紀錄帶 died（changes 裡也有）；
      // 算到流血來源的擊殺另外帶 killedBy / fx（見 killOf），fx 跟著 aiTurn 給客戶端走完再飄字（例如噬魂者，同燒死）
      const pickups = (walk && walk.pickups) || [];
      const walked = walk ? { dir: walk.dir, frames: walk.frames, fall: walk.fall } : null;
      for (const { id, f, hp, mhp, lk, ...info } of pickups) this.record('pickup', { pid: id, name: actor.name, ...info, hp: r1(hp), maxHp: r1(mhp), takeover: true, f });
      const shot = plan ? this.match.resolveShot(actor, plan.weapon, plan.angle, plan.power) : null;
      this.record('ai.turn', {
        ...who, walk: walked, ...moved,
        ...(plan ? { weapon: plan.weapon, angle: r1(plan.angle), power: r1(plan.power), hit: shot.hit && shot.hit.type, kills: shot.kills } : { noShot: true }),
        ...(!plan && !actor.alive ? { died: actor.deathCause, ...killOf(kill) } : {}),
        changes: hpChanges(this.match, before), ...sceneChanges(shot),
      });
      this.io.broadcast({ t: 'aiTurn', actorId: actor.id, entities, walk: walked, ...moved, ...(pickups.length ? { pickups } : {}), shot, splashes, ...killFxOf(kill) });
      secs = T.aiThink
        + (walk ? (walk.frames + walk.fall) / 60 : 0) + glideSecs
        + (shot ? T.aiAim + (shot.flightFrames + shot.settleFrames) / 60 : 0)
        + T.afterShotPad;
    }
    this.schedule(() => this.finishTurn(), secs);
  }

  // 跳過這回合（timeout / disconnected / water = 自己掉進水裡淹死 / bleed = 自己走路流血扣到倒下）。客戶端只套最後的狀態、不重播落地過程，
  // 所以落水的水花要寫進訊息：splashes = 已經發生的那一次，加上落地途中（例如超時那一刻人在水面上空）掉下去的。
  // before = 紀錄用的血量快照（代打前先落地就淹死的，從那次落地之前算起；平常就是現在）；
  // kill = 流血倒下算到的擊殺（Match.applyPositionReport 的 kill，見 killOf；紀錄帶 killedBy / fx，fx 也跟著 skip 給客戶端飄字）
  skipTurn(reason, splashes = [], before = hpOf(this.match), kill = null) {
    this.phase = 'resolving';
    this.deadline = null;
    const actor = this.match.byId(this.currentId);
    if (actor) { actor.moveDir = 0; actor.aiming = false; this.closeSlow(actor, reason); }
    splashes.push(...this.settleWithSplashes());
    // changes = 跳過時大家落地途中的血量變化（例如超時那一刻人在水面上空、掉下去）
    this.record('turn.skip', {
      ...(actor ? actorOf(actor) : { actor: this.currentId }), reason,
      ...(splashes.length ? { splashes } : {}), changes: hpChanges(this.match, before), ...killOf(kill),
    });
    this.io.broadcast({ t: 'skip', actorId: this.currentId, reason, entities: this.match.snapshot().entities, splashes, ...killFxOf(kill) });
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
    this.stopHazard();
    this.phase = 'over';
    this.deadline = null;
    // players = 這一關打完每位玩家的血量與擊殺數（勝者為王另外帶隊伍；result = 贏的那一隊或 draw）
    this.record('battle.over', {
      result, level: this.match.levelId,
      players: this.match.players.map(e => ({
        pid: e.id, name: e.name, ...(this.match.versus ? { team: e.team } : {}), hp: r1(e.hp), alive: e.alive, kills: e.kills,
      })),
    });
    this.io.broadcast({ t: 'gameOver', result, entities: this.match.snapshot().entities });
    if (this.onGameOver) this.onGameOver(result);
  }
}
