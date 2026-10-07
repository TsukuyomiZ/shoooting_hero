import { CONFIG } from './config.js';
import { LEVELS, levelsInPool } from './level.js';
import { Rng } from './rng.js';
import { Match } from './match.js';
import { Referee } from './referee.js';
import { baseStats, drawOffers, applyCard, derivePlayerStats, needsDiscard, equipWeapon } from './cards.js';
import * as Effects from './effects/index.js';
import { logValue } from './utils.js';
import { isBossStage } from './stage-rules.js';

// 一場冒險（肉鴿流程）：
//   共 RUN.stageCount 關，關卡規則說是 Boss 關的那幾關（RUN.bossStages，見 shared/stage-rules.js）從 Boss 池抽地圖（同一場不重複同一隻王），
//   其他是小關（每關隨機一張地圖）；
//   每關勝利後（Boss 關也是）每人三選一張牌 → 下一關 … → 打贏最後一關 = 通關；任何一關全滅 = 結束
// 玩家的血量、牌、加成、武器欄在關與關之間帶著走。伺服器（Room）與單人模式（LocalTransport）都用這個。
// 牌的效果（shared/effects/）在這裡只經過固定的時間點：選牌兩輪（順序在 finishPicks）、一關開始 / 算 carry / 打完；
// 效果自己的欄位（例如腎上腺素的暫時加成、噬魂者帶著走的 %）由效果建在玩家身上。
// 要指定隊友的牌（效果的 target，例如攜手之伴）：選牌訊息的 link = 指定的隊友，定下來交給效果（picked）記；
// 攜手之伴的連結記在玩家的 links（雙向，見 linksOf）
// io 同 Referee：{ broadcast(msg, exceptId), schedule(fn, ms), cancel(h), now() }
// config = 關卡規則讀的設定（總關數、哪幾關是王關，再一路傳給每一關的 Match；測試換自己的數字用，其他設定還是全域 CONFIG）
export class Run {
  constructor({ players, seed, io, cards, config = CONFIG }) {
    this.io = io;
    this.config = config;
    this.cards = cards;
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.players = new Map(players.map(p => {
      const rp = {
        id: p.id, name: p.name, connected: p.connected !== false,
        hp: CONFIG.PLAYER.hp, stats: baseStats(), cards: [],
        weapons: CONFIG.EQUIP.startWeapons.slice(),   // 武器欄
        links: [],                                    // 攜手之伴：自己選的連結對象（對方也算連結著自己，見 linksOf）
        totals: { dealt: 0, taken: 0, shots: 0, hits: 0 },   // 結算畫面：整場冒險的造成 / 承受傷害、開槍 / 命中次數
      };
      Effects.initRunPlayer(rp);   // 效果自己的欄位（帶著走的狀態、腎上腺素的暫時加成…）
      return [p.id, rp];
    }));
    this.stage = 0;
    this.stageCount = config.RUN.stageCount;
    this.phase = 'idle';   // idle | battle | pick | over
    this.match = null;
    this.referee = null;
    this.lastLevelId = null;
    this.bossesUsed = [];  // 這場冒險已經打過的 Boss 關（同一隻王不會再出現）
    this.offers = null;    // pick 階段：playerId → [card...]
    this.picks = null;     // pick 階段：playerId → cardId
    this.discards = null;  // pick 階段：playerId → 武器欄滿了要丟掉的武器 id
    this.linkPicks = null; // pick 階段：playerId → 攜手之伴選的連結對象
    this.timer = null;
    this.result = null;
  }

  get isBoss() { return isBossStage(this.stage, this.config); }
  get isLastStage() { return this.stage >= this.stageCount; }

  // 寫一筆紀錄（玩家看不到）：io 有 record 才記（同 Referee.record）
  record(ev, data) {
    if (typeof this.io.record === 'function') this.io.record(ev, data);
  }

  start() { this.nextStage(); }

  stop() {
    this.cancelTimer();
    if (this.referee) this.referee.stop();
    this.phase = 'over';
  }

  // ---- 關卡 ----
  // 小關：不跟上一關同一張。Boss 關：先挑這場還沒打過的王，都打過了才重複（也避開上一隻）
  pickLevel() {
    const pool = levelsInPool(this.isBoss ? 'boss' : 'normal');
    const fresh = this.isBoss ? pool.filter(id => !this.bossesUsed.includes(id)) : [];
    const choices = fresh.length ? fresh : pool.length > 1 ? pool.filter(id => id !== this.lastLevelId) : pool;
    return this.rng.pick(choices);
  }

  // 依玩家目前的牌與血量，算出這一關要帶進 Match 的數值（含效果這一關的調整（例如腎上腺素的暫時加成）、帶著走的狀態與連結對象）
  carryFor(p) {
    const d = derivePlayerStats(p.stats);
    Effects.adjustCarry(p, d);
    return {
      hp: Math.min(p.hp, d.maxHp), maxHp: d.maxHp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed,
      size: d.size, mods: d.mods, weapons: p.weapons.slice(), ...Effects.carriedState(p),
      links: this.linksOf(p.id),
    };
  }

  // 攜手之伴：跟 id 連結著的隊友（他選的，加上選了他的；雙向、不重複）
  linksOf(id) {
    const out = [];
    for (const q of this.players.values()) {
      if (q.id === id) { for (const t of q.links) if (t !== id && this.players.has(t) && !out.includes(t)) out.push(t); }
      else if (q.links.includes(id) && !out.includes(q.id)) out.push(q.id);
    }
    return out;
  }

  // 攜手之伴：p 還能選誰當連結對象：還沒跟他連結、這一輪選牌也還沒選他當連結對象的隊友
  // （對方已經選了他，兩人選完就會連上，他再選對方等於白拿這張牌）
  linkTargets(p) {
    const linked = this.linksOf(p.id);
    const pending = this.linkPicks || {};
    return [...this.players.keys()].filter(id => id !== p.id && !linked.includes(id) && pending[id] !== p.id);
  }

  // 每個人現在跟誰連結著（選牌畫面提示「對方已經有連結，會多人平分」用）
  allLinks() {
    return Object.fromEntries([...this.players.keys()].map(id => [id, this.linksOf(id)]));
  }

  stageInfo() {
    return {
      stage: this.stage, stageCount: this.stageCount, isBoss: this.isBoss,
      levelId: this.match ? this.match.levelId : null,
      levelName: this.match ? LEVELS[this.match.levelId].name : null,
      cards: Object.fromEntries([...this.players.values()].map(p => [p.id, p.cards.map(c => c.id)])),
    };
  }

  nextStage() {
    this.timer = null;
    if (this.phase === 'over') return;
    this.stage++;
    const levelId = this.pickLevel();
    this.lastLevelId = levelId;
    if (this.isBoss) this.bossesUsed.push(levelId);
    const carry = {};
    const list = [...this.players.values()];
    for (const p of list) {
      // 上一關倒下的人以 reviveHpPct 復活
      if (p.hp <= 0) p.hp = Math.round(derivePlayerStats(p.stats).maxHp * CONFIG.RUN.reviveHpPct);
      // 效果的一關開始（腎上腺素：上一次選牌拿到的暫時加成在這一關生效，血量上限加多少就同時回多少）
      Effects.startStage(p);
      carry[p.id] = this.carryFor(p);
    }
    this.phase = 'battle';
    // 這一關每位玩家帶進來的血量、武器欄、手上的牌
    this.record('stage.start', {
      stage: this.stage, stageCount: this.stageCount, boss: this.isBoss, level: levelId,
      players: list.map(p => ({ pid: p.id, name: p.name, hp: carry[p.id].hp, maxHp: carry[p.id].maxHp, weapons: p.weapons.slice(), cards: p.cards.map(c => c.id) })),
    });
    this.match = new Match({ levelId, players: list, seed: this.rng.int(0, 0xffffffff), carry, stage: this.stage, config: this.config });
    this.referee = new Referee({
      match: this.match,
      humans: list.map(p => ({ id: p.id, name: p.name, connected: p.connected })),
      io: this.io,
      onGameOver: (result) => this.onBattleOver(result),
      stageInfo: this.stageInfo(),
    });
    this.referee.start();
  }

  onBattleOver(result) {
    // 把血量與效果帶著走的狀態（例如噬魂者的累積加成）帶回冒險狀態；血量不超過牌算出來的上限
    // （這一關的暫時加成（腎上腺素）加的上限失效，超過的血扣掉），再交給效果的一關打完
    for (const e of this.match.players) {
      const p = this.players.get(e.id);
      if (!p) continue;
      p.hp = e.alive ? Math.min(e.hp, derivePlayerStats(p.stats).maxHp) : 0;
      Effects.takeBack(p, e);
      for (const k of Object.keys(p.totals)) p.totals[k] += e[k] || 0;
    }
    for (const p of this.players.values()) Effects.endStage(p);
    if (result === 'lose') return this.runOver('lose');
    if (this.isLastStage) return this.runOver('win');   // 打贏最後一關（現在是第二隻王）= 通關；中間的 Boss 關打贏照樣選牌、往下打

    // 過關回血 + 發牌（先讓大家看 2.5 秒勝利畫面，廣播 stageClear 後才進入選牌階段）
    this.phase = 'clear';
    const offers = {};
    for (const p of this.players.values()) {
      const maxHp = derivePlayerStats(p.stats).maxHp;
      if (p.hp > 0) p.hp = Math.min(maxHp, Math.round(p.hp + maxHp * CONFIG.RUN.healPctOnClear));
      offers[p.id] = drawOffers(this.cards, this.rng, this.stage, CONFIG.RUN.offers, p.cards.map(c => c.id), p.weapons, {
        solo: this.players.size === 1, linkTargets: this.linkTargets(p).length,
      });
    }
    this.schedule(() => {
      this.phase = 'pick';
      this.offers = offers;
      this.picks = {};
      this.discards = {};
      this.linkPicks = {};
      this.pickDeadline = this.io.now() + CONFIG.RUN.pickTime * 1000;
      // 每個人拿到哪三張牌可以選（過關回血後的血量）
      this.record('pick.offer', {
        stage: this.stage, pickTime: CONFIG.RUN.pickTime,
        players: [...this.players.values()].map(p => ({ pid: p.id, name: p.name, hp: p.hp, offers: (offers[p.id] || []).map(c => c.id) })),
      });
      this.io.broadcast({
        t: 'stageClear', stage: this.stage, stageCount: this.stageCount,
        offers, pickTime: CONFIG.RUN.pickTime,
        hp: Object.fromEntries([...this.players.values()].map(p => [p.id, p.hp])),
        weapons: Object.fromEntries([...this.players.values()].map(p => [p.id, p.weapons])),
        linkTargets: Object.fromEntries([...this.players.values()].map(p => [p.id, this.linkTargets(p)])),   // 攜手之伴能選的隊友
        links: this.allLinks(),
      });
      this.schedule(() => this.finishPicks(), CONFIG.RUN.pickTime);
    }, 2.5);
  }

  handle(playerId, msg) {
    if (!msg || typeof msg !== 'object') return;
    // 收到但不處理的訊息也記一筆（同 Referee.ignored）；選牌被擋下的連他想選的牌、要丟的武器、連結對象一起記
    const ignored = (reason) => this.record('action.ignored', {
      stage: this.stage, pid: playerId, t: logValue(msg.t), reason,
      ...(msg.t === 'pick' ? { card: logValue(msg.cardId, 40), discard: logValue(msg.discard, 40), link: logValue(msg.link, 40) } : {}),
    });
    if (this.phase === 'pick') {
      if (msg.t !== 'pick') return ignored('phase:pick');
      if (this.picks[playerId] || !this.offers[playerId]) return ignored(this.picks[playerId] ? 'alreadyPicked' : 'noOffers');
      const card = this.offers[playerId].find(c => c.id === msg.cardId);
      if (!card) return ignored('cardNotOffered');
      // 武器欄滿了還選武器牌：一定要指定丟掉自己的哪一把
      const p = this.players.get(playerId);
      const weapons = p.weapons;
      if (needsDiscard(weapons, card)) {
        if (!weapons.includes(msg.discard)) return ignored('needDiscard');
        this.discards[playerId] = msg.discard;
      }
      // 要指定隊友的牌（攜手之伴）：一定要指定一位還沒跟他連結（這一輪也還沒選他）的隊友
      const teammate = Effects.needsTeammate(card);
      if (teammate) {
        if (!this.linkTargets(p).includes(msg.link)) return ignored('badLinkTarget');
        this.linkPicks[playerId] = msg.link;
      }
      this.picks[playerId] = card.id;
      this.record('pick', {
        stage: this.stage, pid: playerId, name: p.name, card: card.id,
        ...(needsDiscard(weapons, card) ? { discard: msg.discard } : {}), ...(teammate ? { link: msg.link } : {}),
      });
      // link：被選的人的選牌畫面要把他從可連結的名單拿掉（兩人互選會白拿一張牌）
      this.io.broadcast({ t: 'picked', playerId, cardId: card.id, ...(this.linkPicks[playerId] ? { link: this.linkPicks[playerId] } : {}) });
      const humansLeft = [...this.players.values()].filter(p => p.connected && !this.picks[p.id]);
      if (!humansLeft.length) this.finishPicks();
      return;
    }
    if (this.phase === 'battle' && this.referee) this.referee.handle(playerId, msg);
    else ignored('phase:' + this.phase);
  }

  finishPicks() {
    if (this.phase !== 'pick') return;
    this.cancelTimer();
    const summary = [];
    const list = [...this.players.values()];
    const pool = {};   // 這一輪選牌各效果共用的（例如全隊回血的 %、誰要給隊友回血），第二輪才用
    const auto = new Set();   // 紀錄用：超時 / 斷線、由系統隨機選的人
    for (const p of list) {
      const offers = this.offers[p.id] || [];
      let card = offers.find(c => c.id === this.picks[p.id]);
      if (!card && offers.length) {
        // 沒選 / 斷線 → 隨機，盡量不挑要丟武器才能拿的牌、沒有隊友可以指定的牌（攜手之伴）
        const safe = offers.filter(c => !needsDiscard(p.weapons, c) && !(Effects.needsTeammate(c) && !this.linkTargets(p).length));
        card = this.rng.pick(safe.length ? safe : offers);
        auto.add(p.id);
      }
      if (!card) continue;
      p.cards.push(card);
      const { weapons, discarded } = equipWeapon(p.weapons, card, this.discards[p.id]);
      p.weapons = weapons;
      const now = applyCard(p.stats, card);
      // 要指定隊友的牌：照他選的；超時 / 斷線就從還能選的隊友裡隨機挑一位（會避開這一輪已經選了他的人，攜手之伴的那兩人本來就會連上）
      let target = null;
      if (Effects.needsTeammate(card)) {
        target = this.linkPicks[p.id];
        const free = this.linkTargets(p);
        if (!free.includes(target)) target = free.length ? this.rng.pick(free) : null;
      }
      // 例如腎上腺素記下一關的加成、全隊 / 隊友回血先記著、攜手之伴把指定的隊友記進 links
      Effects.picked(p, now, pool, target);
      // 第一輪：自己立刻回的血（對著套完牌的新上限）
      const maxAfter = derivePlayerStats(p.stats).maxHp;
      if (p.hp > 0) p.hp = Math.min(maxAfter, Math.round(Effects.pickHeal('healNow', p.hp, now, maxAfter)));
      const entry = { playerId: p.id, cardId: card.id, weapons: p.weapons.slice(), discarded };
      if (target) entry.link = target;   // 選牌結果的 link = 指定的隊友（同步格式）
      summary.push(entry);
    }
    // 第二輪：隊友的牌給的回血（醫療包）、全隊回血（祈願之杖）等大家的牌都套完再算，用每個人自己新的上限；
    // 倒下的人下一關本來就會復活
    for (const p of list) {
      if (p.hp <= 0) continue;
      const maxHp = derivePlayerStats(p.stats).maxHp;
      const hp = Effects.pickHeal('healForTeam', Effects.pickHeal('healFromTeammates', p.hp, pool, p), pool, p, maxHp);
      p.hp = Math.min(maxHp, Math.round(hp));
    }
    for (const s of summary) {
      const p = this.players.get(s.playerId);
      s.hp = p.hp;
      s.maxHp = derivePlayerStats(p.stats).maxHp;
    }
    // 選牌結果：auto = 沒選（超時 / 斷線）由系統隨機挑；discarded = 武器欄滿了丟掉的那把；link = 攜手之伴連上的隊友
    this.record('pick.done', {
      stage: this.stage,
      players: summary.map(s => ({
        pid: s.playerId, name: this.players.get(s.playerId).name, card: s.cardId, ...(auto.has(s.playerId) ? { auto: true } : {}),
        ...(s.discarded ? { discarded: s.discarded } : {}), ...(s.link ? { link: s.link } : {}), hp: s.hp, maxHp: s.maxHp, weapons: s.weapons,
      })),
    });
    this.offers = null;
    this.picks = null;
    this.discards = null;
    this.linkPicks = null;
    this.io.broadcast({ t: 'picks', summary, nextStage: this.stage + 1, isBoss: isBossStage(this.stage + 1, this.config) });
    this.phase = 'between';
    this.schedule(() => this.nextStage(), 2.5);
  }

  runOver(result) {
    this.cancelTimer();
    this.phase = 'over';
    this.result = result;
    // 整場冒險結束（win = Boss 打倒、lose = 全滅）：打到第幾關、每個人最後的牌與結算統計
    this.record('run.over', {
      result, stage: this.stage, stageCount: this.stageCount,
      players: [...this.players.values()].map(p => ({ pid: p.id, name: p.name, hp: p.hp, cards: p.cards.map(c => c.id), weapons: p.weapons.slice(), ...p.totals })),
    });
    this.io.broadcast({ t: 'runOver', result, stage: this.stage, stageCount: this.stageCount, cards: this.stageInfo().cards, summary: this.summary() });
  }

  // 結算畫面：每個人整場的統計與拿到的牌（同一張拿好幾次合成一筆 count）
  summary() {
    return [...this.players.values()].map(p => {
      const cards = [];
      for (const c of p.cards) {
        const same = cards.find(x => x.id === c.id);
        if (same) same.count++;
        else cards.push({ id: c.id, name: c.name, rarity: c.rarity, desc: c.desc, weapon: !!c.weapon, count: 1 });
      }
      return { id: p.id, name: p.name, ...p.totals, cards };
    });
  }

  setConnected(id, connected) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    if (this.referee && this.phase === 'battle') this.referee.setConnected(id, connected);
    else this.io.broadcast({ t: 'playerStatus', id, connected });
    // 選牌階段：只剩他沒選而他斷線了 → 直接結束選牌
    if (this.phase === 'pick' && !connected) {
      const left = [...this.players.values()].filter(x => x.connected && !this.picks[x.id]);
      if (!left.length) this.finishPicks();
    }
  }

  // 重連用的完整狀態
  statePayload(forPlayerId) {
    const base = { run: this.stageInfo(), runPhase: this.phase, result: this.result };
    if (this.phase === 'battle' && this.referee) return { ...this.referee.statePayload(), ...base };
    if (this.phase === 'pick') {
      return {
        ...(this.referee ? this.referee.statePayload() : {}), ...base,
        offers: this.offers[forPlayerId] || [], picked: this.picks[forPlayerId] || null,
        weapons: this.players.has(forPlayerId) ? this.players.get(forPlayerId).weapons : [],
        linkTargets: this.players.has(forPlayerId) ? this.linkTargets(this.players.get(forPlayerId)) : [],
        links: this.allLinks(),
        pickTimeLeft: this.pickDeadline ? Math.max(0, (this.pickDeadline - this.io.now()) / 1000) : CONFIG.RUN.pickTime,
      };
    }
    return { ...(this.referee ? this.referee.statePayload() : {}), ...base };
  }

  schedule(fn, secs) {
    this.cancelTimer();
    this.timer = this.io.schedule(fn, Math.max(0, Math.round(secs * 1000)));
  }
  cancelTimer() {
    if (this.timer) { this.io.cancel(this.timer); this.timer = null; }
  }
}
