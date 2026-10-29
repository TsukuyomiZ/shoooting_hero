import { CONFIG } from '../core/config.js';
import { LEVELS, levelsInPool } from '../maps/level.js';
import { Rng } from '../core/rng.js';
import { Match } from './match.js';
import { Referee } from './referee.js';
import { RARITIES, baseStats, drawOffers, applyCard, derivePlayerStats, needsDiscard, equipWeapon } from '../cards/cards.js';
import * as Effects from '../cards/effects/index.js';
import { logValue } from '../core/utils.js';

// 選牌中斷線又重連回來、還沒選的人，至少還有幾秒可以選（斷線那時候可能只剩不到 1 秒：沒有人在選就 1 秒後結束）
const RECONNECT_PICK_SECS = 10;

// 勝者為王（3v3 對戰）：兩隊玩家（真人 + 電腦玩家）在一張對戰地圖（level 的 pool 'versus'）上打一場，沒有關卡、沒有敵人。
//   - 每位玩家血量 VERSUS.hp（牌的血量加成照這個算），開局武器同冒險；回合順序兩隊輪流（先攻的隊伍隨機，見 turnOrder）
//   - 每 VERSUS.pickEvery 輪打完（場上所有人各行動一次），裁判停在 'break'（Referee 的 onRoundEnd），每個活著的人三選一張牌
//     （電腦玩家馬上選），牌當場套到角色身上（Match.refit），隔 VERSUS.resumeDelay 秒再開始下一輪
//   - 狂熱照關卡規則（pool 'versus'：每 VERSUS.feverEvery 輪疊一層）；一隊全倒 = 另一隊贏，同一下兩隊一起倒下 = 平手（'draw'）
//   - 要指定隊友的牌（攜手之伴）、給隊友回血的牌（醫療包、祈願之杖）只算同一隊；VERSUS.excludeKeys 的牌不出
// 跟 Run（冒險）同一套對外介面：start / stop / handle / setConnected / statePayload，欄位 phase / result / stage / referee，
// 伺服器的房間（server/rooms.js）與單人練習（client/net.js）照樣用；io 同 Run（ended(result) = 整場打完、送出 runOver 之後）。
// players = [{ id, name, team: VERSUS.teams 其中一個, bot: 電腦玩家（一直由 AI 操作、選牌馬上選）, connected }]
export class Versus {
  constructor({ players, seed, io, cards, config = CONFIG }) {
    const V = CONFIG.VERSUS;
    this.mode = 'versus';
    this.io = io;
    this.config = config;
    this.cards = cards.filter(c => !Object.keys(c.effects).some(k => V.excludeKeys.includes(k)));
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.base = { ...CONFIG.PLAYER, hp: V.hp };   // 牌的數值照這個算（血量上限 = VERSUS.hp + 牌加的）
    this.players = new Map(players.map(p => {
      const rp = {
        id: p.id, name: p.name, team: V.teams.includes(p.team) ? p.team : V.teams[0], bot: !!p.bot,
        connected: !p.bot && p.connected !== false,
        hp: V.hp, stats: baseStats(), cards: [],
        weapons: CONFIG.EQUIP.startWeapons.slice(),
        links: [],
        totals: { dealt: 0, friendlyDealt: 0, taken: 0, shots: 0, hits: 0, kills: 0 },   // 結算畫面：造成 / 誤傷隊友 / 承受傷害、開槍 / 命中次數、擊殺
      };
      Effects.initRunPlayer(rp);
      return [p.id, rp];
    }));
    // 給共用的程式看（紀錄、單人練習的結束紀錄）：對戰只有一場
    this.stage = 1;
    this.stageCount = 1;
    this.phase = 'idle';   // idle | battle | pick | ending | over
    this.match = null;
    this.referee = null;
    this.offers = null;    // pick 階段：playerId → [card...]（活著的人才有）
    this.picks = null;     // pick 階段：playerId → cardId
    this.discards = null;  // pick 階段：playerId → 武器欄滿了要丟掉的武器 id
    this.linkPicks = null; // pick 階段：playerId → 攜手之伴選的連結對象
    this.pickRound = 0;    // 這次選牌是第幾輪打完的
    this.pickDeadline = null;
    this.resume = null;    // 選完牌要呼叫的（裁判的 onRoundEnd 給的：開始下一輪）
    this.timer = null;
    this.result = null;
  }

  // 寫一筆紀錄（玩家看不到）：io 有 record 才記（同 Run）
  record(ev, data) {
    if (typeof this.io.record === 'function') this.io.record(ev, data);
  }

  start() {
    const V = CONFIG.VERSUS;
    const levelId = this.rng.pick(levelsInPool('versus'));
    const order = this.turnOrder();
    const carry = {};
    for (const p of order) carry[p.id] = this.carryFor(p);
    this.phase = 'battle';
    // 這一場：地圖、回合順序（= 名單順序）、每個人在哪一隊
    this.record('versus.start', {
      level: levelId,
      players: order.map(p => ({ pid: p.id, name: p.name, team: p.team, ...(p.bot ? { bot: true } : {}), hp: carry[p.id].hp })),
    });
    const seen = {};
    this.match = new Match({
      levelId, seed: this.rng.int(0, 0xffffffff), carry, stage: 1, config: this.config,
      players: order.map(p => {
        const k = seen[p.team] = (seen[p.team] ?? -1) + 1;
        const colors = V.teamColors[p.team] || CONFIG.PLAYER_COLORS;
        return { id: p.id, name: p.name, team: p.team, color: colors[k % colors.length] };
      }),
    });
    this.referee = new Referee({
      match: this.match,
      humans: order.map(p => ({ id: p.id, name: p.name, connected: p.connected, bot: p.bot })),
      io: this.io,
      onGameOver: (result) => this.onBattleOver(result),
      onRoundEnd: (round, resume) => this.roundOver(round, resume),
      stageInfo: this.stageInfo(),
    });
    this.referee.start();
  }

  stop() {
    this.cancelTimer();
    if (this.referee) this.referee.stop();
    this.resume = null;
    this.phase = 'over';
  }

  // 回合順序：兩隊輪流（藍 1 → 紅 1 → 藍 2 → …），先攻的隊伍隨機；人數不一樣的話，多出來的排在最後面
  turnOrder() {
    const teams = CONFIG.VERSUS.teams.map(t => [...this.players.values()].filter(p => p.team === t));
    if (this.rng.chance(0.5)) teams.reverse();
    const out = [];
    const n = Math.max(0, ...teams.map(t => t.length));
    for (let i = 0; i < n; i++) for (const t of teams) if (t[i]) out.push(t[i]);
    return out;
  }

  // 依玩家目前的牌與血量算出要套到角色身上的數值（格式同 Run.carryFor：建場時交給 Match、選完牌交給 Match.refit）
  carryFor(p) {
    const d = derivePlayerStats(p.stats, this.base);
    Effects.adjustCarry(p, d);
    return {
      hp: Math.min(p.hp, d.maxHp), maxHp: d.maxHp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed,
      size: d.size, mods: d.mods, weapons: p.weapons.slice(), ...Effects.carriedState(p),
      links: this.linksOf(p.id),
    };
  }

  // 場上的角色還活著嗎（還沒開打 = 活著）
  isAlive(id) {
    if (!this.match) return true;
    const e = this.match.byId(id);
    return !!(e && e.alive);
  }

  // p 的隊友（不含自己）
  teammates(p) {
    return [...this.players.values()].filter(q => q.id !== p.id && q.team === p.team);
  }

  // 攜手之伴：跟 id 連結著的隊友（他選的，加上選了他的；雙向、不重複，只算同一隊）
  linksOf(id) {
    const me = this.players.get(id);
    if (!me) return [];
    const out = [];
    for (const q of this.teammates(me)) {
      if (me.links.includes(q.id) || q.links.includes(id)) out.push(q.id);
    }
    return out;
  }

  // 攜手之伴：p 還能選誰當連結對象：活著、還沒跟他連結、這一輪選牌也還沒選他當連結對象的隊友
  linkTargets(p) {
    const linked = this.linksOf(p.id);
    const pending = this.linkPicks || {};
    return this.teammates(p).filter(q => this.isAlive(q.id) && !linked.includes(q.id) && pending[q.id] !== p.id).map(q => q.id);
  }

  allLinks() {
    return Object.fromEntries([...this.players.keys()].map(id => [id, this.linksOf(id)]));
  }

  // 給客戶端與紀錄的這一場的資訊（客戶端照 mode 'versus' 換成對戰的畫面）：cards = 每個人目前拿到的牌
  stageInfo() {
    return {
      mode: 'versus', stage: 1, stageCount: 1, isBoss: false, type: 'versus', difficulty: 'normal',
      levelId: this.match ? this.match.levelId : null,
      levelName: this.match ? LEVELS[this.match.levelId].name : null,
      cards: Object.fromEntries([...this.players.values()].map(p => [p.id, p.cards.map(c => c.id)])),
    };
  }

  // 場上的血量與效果帶著走的狀態抄回對戰的玩家（選牌前：牌的回血、算 carry 都從現在的血量開始）
  syncFromMatch() {
    for (const e of this.match.players) {
      const p = this.players.get(e.id);
      if (!p) continue;
      p.hp = e.alive ? e.hp : 0;
      Effects.takeBack(p, e);
    }
  }

  // ---- 每一輪打完的選牌 ----
  // 裁判的 onRoundEnd：第 round 輪打完、下一輪開始之前。這一輪要選牌就停下來發牌，不然直接 resume
  roundOver(round, resume) {
    const V = CONFIG.VERSUS;
    if (this.phase !== 'battle' || !(V.pickEvery > 0) || round % V.pickEvery !== 0 || !this.cards.length) return resume();
    this.syncFromMatch();
    const alive = [...this.players.values()].filter(p => this.isAlive(p.id));
    if (!alive.length) return resume();
    this.resume = resume;
    this.pickRound = round;
    this.offers = {};
    this.picks = {};
    this.discards = {};
    this.linkPicks = {};
    // 稀有度照輪數算（同冒險的第幾關：越後面越容易出好牌，最多算到最後一關）
    const stage = Math.min(round, CONFIG.RUN.stageCount);
    for (const p of alive) {
      this.offers[p.id] = drawOffers(this.cards, this.rng, stage, V.offers, p.cards.map(c => c.id), p.weapons, {
        solo: !this.teammates(p).some(q => this.isAlive(q.id)), linkTargets: this.linkTargets(p).length,
      });
    }
    this.phase = 'pick';
    this.pickDeadline = this.io.now() + V.pickTime * 1000;
    // 每個人拿到哪三張牌可以選（電腦玩家的照樣記）
    this.record('pick.offer', {
      round, pickTime: V.pickTime,
      players: alive.map(p => ({ pid: p.id, name: p.name, team: p.team, ...(p.bot ? { bot: true } : {}), hp: p.hp, offers: this.offers[p.id].map(c => c.id) })),
    });
    // 電腦玩家馬上選（記 pick、不另外廣播：選牌畫面照 roundPick 的 picked 標成已選）
    for (const p of alive) if (p.bot) this.botPick(p);
    this.io.broadcast({
      t: 'roundPick', round, offers: this.offers, pickTime: V.pickTime,
      picked: Object.keys(this.picks),
      hp: Object.fromEntries(alive.map(p => [p.id, p.hp])),
      weapons: Object.fromEntries(alive.map(p => [p.id, p.weapons])),
      linkTargets: Object.fromEntries(alive.map(p => [p.id, this.linkTargets(p)])),   // 攜手之伴能選的隊友（同一隊、活著的）
      links: this.allLinks(),
    });
    // 沒有真人要選（全是電腦玩家、真人都倒下或斷線了）：停一下讓大家看到，就結束選牌（截止時間跟著記，重連的人看到的秒數才對）
    this.setPickDeadline(this.pickersLeft() ? V.pickTime : 1);
  }

  // 選牌的截止時間：secs 秒後結束選牌（沒選的隨機選）
  setPickDeadline(secs) {
    this.pickDeadline = this.io.now() + secs * 1000;
    this.schedule(() => this.finishPicks(), secs);
  }

  // id 現在重連回來的話，選牌要到什麼時候截止：他有牌、還沒選，就至少再給 RECONNECT_PICK_SECS 秒（斷線時可能只剩不到 1 秒）；
  // 不然照原本的。statePayload（重連的 state 在 setConnected 之前送）與 setConnected 照同一個算，畫面上的倒數才跟伺服器一樣
  reconnectDeadline(id) {
    const p = this.players.get(id);
    const waiting = this.phase === 'pick' && p && !p.bot && !p.connected && this.offers[id] && !this.picks[id];
    return waiting ? Math.max(this.pickDeadline, this.io.now() + RECONNECT_PICK_SECS * 1000) : this.pickDeadline;
  }

  // 還在選牌的真人（連線中、有牌可選、還沒選）
  pickersLeft() {
    return [...this.players.values()].filter(p => !p.bot && p.connected && this.offers[p.id] && !this.picks[p.id]).length;
  }

  // 自動代選（電腦玩家、超時 / 斷線的人）能拿的牌：盡量不挑要丟武器才能拿的、沒有隊友可以指定的
  safeOffers(p) {
    const offers = this.offers[p.id] || [];
    const safe = offers.filter(c => !needsDiscard(p.weapons, c) && !(Effects.needsTeammate(c) && !this.linkTargets(p).length));
    return safe.length ? safe : offers;
  }

  // 電腦玩家選牌：能拿的牌裡挑稀有度最高的（一樣高就隨機）；武器欄滿了的武器牌丟最後一把，要指定隊友的隨機挑一位
  botPick(p) {
    const pool = this.safeOffers(p);
    if (!pool.length) return;
    const rank = (c) => RARITIES.indexOf(c.rarity);
    const top = Math.max(...pool.map(rank));
    const card = this.rng.pick(pool.filter(c => rank(c) === top));
    if (needsDiscard(p.weapons, card)) this.discards[p.id] = p.weapons[p.weapons.length - 1];
    if (Effects.needsTeammate(card)) {
      const free = this.linkTargets(p);
      if (free.length) this.linkPicks[p.id] = this.rng.pick(free);
    }
    this.picks[p.id] = card.id;
    this.record('pick', {
      round: this.pickRound, pid: p.id, name: p.name, bot: true, card: card.id,
      ...(this.discards[p.id] ? { discard: this.discards[p.id] } : {}), ...(this.linkPicks[p.id] ? { link: this.linkPicks[p.id] } : {}),
    });
  }

  handle(playerId, msg) {
    if (!msg || typeof msg !== 'object') return;
    // 收到但不處理的訊息也記一筆（同 Run）；選牌被擋下的連他想選的牌、要丟的武器、連結對象一起記
    const ignored = (reason) => this.record('action.ignored', {
      round: this.match ? this.match.round : 0, pid: playerId, t: logValue(msg.t), reason,
      ...(msg.t === 'pick' ? { card: logValue(msg.cardId, 40), discard: logValue(msg.discard, 40), link: logValue(msg.link, 40) } : {}),
    });
    if (this.phase === 'pick') {
      if (msg.t !== 'pick') return ignored('phase:pick');
      const p = this.players.get(playerId);
      if (!p || p.bot || this.picks[playerId] || !this.offers[playerId]) return ignored(this.picks[playerId] ? 'alreadyPicked' : 'noOffers');
      const card = this.offers[playerId].find(c => c.id === msg.cardId);
      if (!card) return ignored('cardNotOffered');
      // 武器欄滿了還選武器牌：一定要指定丟掉自己的哪一把
      if (needsDiscard(p.weapons, card)) {
        if (!p.weapons.includes(msg.discard)) return ignored('needDiscard');
        this.discards[playerId] = msg.discard;
      }
      // 要指定隊友的牌（攜手之伴）：一定要指定一位同一隊、活著、還沒跟他連結的隊友
      const teammate = Effects.needsTeammate(card);
      if (teammate) {
        if (!this.linkTargets(p).includes(msg.link)) return ignored('badLinkTarget');
        this.linkPicks[playerId] = msg.link;
      }
      this.picks[playerId] = card.id;
      this.record('pick', {
        round: this.pickRound, pid: playerId, name: p.name, card: card.id,
        ...(needsDiscard(p.weapons, card) ? { discard: msg.discard } : {}), ...(teammate ? { link: msg.link } : {}),
      });
      this.io.broadcast({ t: 'picked', playerId, cardId: card.id, ...(this.linkPicks[playerId] ? { link: this.linkPicks[playerId] } : {}) });
      if (!this.pickersLeft()) this.finishPicks();
      return;
    }
    if (this.phase === 'battle' && this.referee) this.referee.handle(playerId, msg);
    else ignored('phase:' + this.phase);
  }

  // 選牌結束（大家都選了 / 時間到）：沒選的隨機選，牌套到對戰的玩家身上（同 Run.finishPicks 的兩輪，回血只算同一隊），
  // 再把新的 carry 套到場上的角色（Match.refit），廣播 roundPicks，隔 resumeDelay 秒開始下一輪
  finishPicks() {
    if (this.phase !== 'pick') return;
    this.cancelTimer();
    const summary = [];
    const pools = {};          // 每一隊這一輪選牌各效果共用的（全隊回血的 %、誰要給隊友回血），第二輪才用
    const auto = new Set();    // 紀錄用：超時 / 斷線、由系統隨機選的人
    const list = [...this.players.values()].filter(p => this.offers[p.id]);
    for (const p of list) {
      const offers = this.offers[p.id];
      let card = offers.find(c => c.id === this.picks[p.id]);
      if (!card && offers.length) {
        card = this.rng.pick(this.safeOffers(p));
        auto.add(p.id);
      }
      if (!card) continue;
      p.cards.push(card);
      const { weapons, discarded } = equipWeapon(p.weapons, card, this.discards[p.id]);
      p.weapons = weapons;
      const now = applyCard(p.stats, card);
      let target = null;
      if (Effects.needsTeammate(card)) {
        target = this.linkPicks[p.id];
        const free = this.linkTargets(p);
        if (!free.includes(target)) target = free.length ? this.rng.pick(free) : null;
      }
      Effects.picked(p, now, pools[p.team] ||= {}, target);
      const maxAfter = derivePlayerStats(p.stats, this.base).maxHp;
      if (p.hp > 0) p.hp = Math.min(maxAfter, Math.round(Effects.pickHeal('healNow', p.hp, now, maxAfter)));
      const entry = { playerId: p.id, cardId: card.id, weapons: p.weapons.slice(), discarded };
      if (target) entry.link = target;
      summary.push(entry);
    }
    // 第二輪：隊友的牌給的回血（醫療包）、全隊回血（祈願之杖）：只給同一隊活著的人，用每個人自己新的上限
    for (const p of this.players.values()) {
      const pool = pools[p.team];
      if (!pool || p.hp <= 0) continue;
      const maxHp = derivePlayerStats(p.stats, this.base).maxHp;
      const hp = Effects.pickHeal('healForTeam', Effects.pickHeal('healFromTeammates', p.hp, pool, p), pool, p, maxHp);
      p.hp = Math.min(maxHp, Math.round(hp));
    }
    // 套到場上活著的角色身上（上限、速度、體型、mods、武器欄、連結、血量），體型變了大家重新站好
    const carry = {};
    for (const p of this.players.values()) {
      const e = this.match.byId(p.id);
      if (!e || !e.alive) continue;
      carry[p.id] = this.carryFor(p);
      this.match.refit(e, carry[p.id]);
    }
    this.match.settle();
    for (const s of summary) {
      const p = this.players.get(s.playerId);
      const e = this.match.byId(s.playerId);
      s.hp = e ? e.hp : p.hp;
      s.maxHp = e ? e.maxHp : derivePlayerStats(p.stats, this.base).maxHp;
    }
    // 選牌結果：auto = 沒選（超時 / 斷線）由系統隨機挑；bot = 電腦玩家；discarded = 武器欄滿了丟掉的那把；link = 攜手之伴連上的隊友
    this.record('pick.done', {
      round: this.pickRound,
      players: summary.map(s => {
        const p = this.players.get(s.playerId);
        return {
          pid: s.playerId, name: p.name, team: p.team, card: s.cardId, ...(p.bot ? { bot: true } : auto.has(s.playerId) ? { auto: true } : {}),
          ...(s.discarded ? { discarded: s.discarded } : {}), ...(s.link ? { link: s.link } : {}), hp: s.hp, maxHp: s.maxHp, weapons: s.weapons,
        };
      }),
    });
    this.offers = null;
    this.picks = null;
    this.discards = null;
    this.linkPicks = null;
    this.phase = 'battle';
    this.referee.stageInfo = this.stageInfo();   // 開場 / 重連的資訊（名單上的「牌 ×N」）照新的
    // carry = 每個角色新的數值（客戶端照樣 Match.refit），entities = 套完、站好之後的狀態
    this.io.broadcast({
      t: 'roundPicks', round: this.pickRound, summary, carry, entities: this.match.snapshot().entities,
      cards: this.stageInfo().cards, resumeIn: CONFIG.VERSUS.resumeDelay,
    });
    this.schedule(() => {
      const resume = this.resume;
      this.resume = null;
      if (resume) resume();
    }, CONFIG.VERSUS.resumeDelay);
  }

  // ---- 結束 ----
  onBattleOver(result) {
    this.cancelTimer();
    for (const e of this.match.players) {
      const p = this.players.get(e.id);
      if (!p) continue;
      p.hp = e.alive ? e.hp : 0;
      Effects.takeBack(p, e);
      for (const k of Object.keys(p.totals)) p.totals[k] += e[k] || 0;
    }
    // 先讓大家看完最後一下（同冒險過關後的 2.5 秒），再送結算
    this.phase = 'ending';
    this.schedule(() => this.runOver(result), 2.5);
  }

  runOver(result) {
    this.cancelTimer();
    this.phase = 'over';
    this.result = result;
    const winner = result === 'draw' ? null : result;
    const round = this.match ? this.match.round : 0;
    // 整場打完：哪一隊贏（draw = 平手）、打到第幾輪、每個人最後的牌與結算統計
    this.record('versus.over', {
      result, round,
      players: [...this.players.values()].map(p => ({
        pid: p.id, name: p.name, team: p.team, ...(p.bot ? { bot: true } : {}), hp: p.hp, cards: p.cards.map(c => c.id), weapons: p.weapons.slice(), ...p.totals,
      })),
    });
    this.io.broadcast({
      t: 'runOver', mode: 'versus', result, winner, round, stage: 1, stageCount: 1, type: 'versus', difficulty: 'normal',
      cards: this.stageInfo().cards, summary: this.summary(),
    });
    if (typeof this.io.ended === 'function') this.io.ended(result);
  }

  // 結算畫面：每個人整場的統計與拿到的牌（同一張拿好幾次合成一筆 count），帶隊伍、是不是電腦玩家、最後還站著沒有
  summary() {
    return [...this.players.values()].map(p => {
      const cards = [];
      for (const c of p.cards) {
        const same = cards.find(x => x.id === c.id);
        if (same) same.count++;
        else cards.push({ id: c.id, name: c.name, rarity: c.rarity, desc: c.desc, weapon: !!c.weapon, count: 1 });
      }
      return { id: p.id, name: p.name, team: p.team, ...(p.bot ? { bot: true } : {}), alive: p.hp > 0, ...p.totals, cards };
    });
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p || p.bot) return;
    // 選牌中重連回來、還沒選：截止時間至少再給一段（同 reconnectDeadline，他剛收到的 state 就是照這個算的）
    const deadline = connected ? this.reconnectDeadline(id) : this.pickDeadline;
    p.connected = connected;
    if (this.phase === 'pick' && deadline > this.pickDeadline) this.setPickDeadline((deadline - this.io.now()) / 1000);
    // 選牌時裁判停在 'break'：照樣交給它記連線狀態（廣播 playerStatus；輪到他才會代打）
    if (this.referee && this.phase !== 'over') this.referee.setConnected(id, connected);
    else this.io.broadcast({ t: 'playerStatus', id, connected });
    // 選牌階段：只剩他沒選而他斷線了 → 直接結束選牌
    if (this.phase === 'pick' && !connected && !this.pickersLeft()) this.finishPicks();
  }

  // 重連用的完整狀態（同 Run：run = 這一場的資訊、runPhase = 對戰的階段）；選牌中另外帶他的牌、選了沒、還剩幾秒
  statePayload(forPlayerId) {
    const base = { run: this.stageInfo(), runPhase: this.phase, result: this.result };
    const ref = this.referee ? this.referee.statePayload() : {};
    if (this.phase === 'pick') {
      const p = this.players.get(forPlayerId);
      return {
        ...ref, ...base,
        pickRound: this.pickRound, offers: this.offers[forPlayerId] || [], picked: this.picks[forPlayerId] || null,
        pickedIds: Object.keys(this.picks),
        weapons: p ? p.weapons : [], linkTargets: p ? this.linkTargets(p) : [], links: this.allLinks(),
        pickTimeLeft: this.pickDeadline ? Math.max(0, (this.reconnectDeadline(forPlayerId) - this.io.now()) / 1000) : CONFIG.VERSUS.pickTime,
      };
    }
    return { ...ref, ...base };
  }

  schedule(fn, secs) {
    this.cancelTimer();
    this.timer = this.io.schedule(() => { this.timer = null; fn(); }, Math.max(0, Math.round(secs * 1000)));
  }
  cancelTimer() {
    if (this.timer) { this.io.cancel(this.timer); this.timer = null; }
  }
}
