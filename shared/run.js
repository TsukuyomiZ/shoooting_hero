import { CONFIG } from './config.js';
import { LEVELS, levelsInPool } from './level.js';
import { Rng } from './rng.js';
import { Match } from './match.js';
import { Referee } from './referee.js';
import { baseStats, drawOffers, applyCard, derivePlayerStats, needsDiscard, equipWeapon } from './cards.js';
import { logValue } from './utils.js';

// 一場冒險（肉鴿流程）：
//   小關 ×N（每關隨機一張地圖）→ 每關勝利後每人三選一張牌 → 打完 N 關進 Boss 關 → 通關 / 全滅
// 玩家的血量、牌、加成、武器欄在關與關之間帶著走。伺服器（Room）與單人模式（LocalTransport）都用這個。
// io 同 Referee：{ broadcast(msg, exceptId), schedule(fn, ms), cancel(h), now() }
export class Run {
  constructor({ players, seed, io, cards }) {
    this.io = io;
    this.cards = cards;
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.players = new Map(players.map(p => [p.id, {
      id: p.id, name: p.name, connected: p.connected !== false,
      hp: CONFIG.PLAYER.hp, stats: baseStats(), cards: [],
      weapons: CONFIG.EQUIP.startWeapons.slice(),   // 武器欄
      soulPct: 0,                                   // 噬魂者累積的武器傷害加成
      links: [],                                    // 攜手之伴：自己選的連結對象（對方也算連結著自己，見 linksOf）
      next: { damagePct: 0, maxHp: 0 },             // 腎上腺素：下一關才生效的暫時加成
      boost: { damagePct: 0, maxHp: 0 },            // 這一關正在生效的暫時加成（打完就失效）
    }]));
    this.stage = 0;
    this.stageCount = CONFIG.RUN.stagesBeforeBoss + 1;
    this.phase = 'idle';   // idle | battle | pick | over
    this.match = null;
    this.referee = null;
    this.lastLevelId = null;
    this.offers = null;    // pick 階段：playerId → [card...]
    this.picks = null;     // pick 階段：playerId → cardId
    this.discards = null;  // pick 階段：playerId → 武器欄滿了要丟掉的武器 id
    this.linkPicks = null; // pick 階段：playerId → 攜手之伴選的連結對象
    this.timer = null;
    this.result = null;
  }

  get isBoss() { return this.stage > CONFIG.RUN.stagesBeforeBoss; }

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
  pickLevel() {
    const pool = levelsInPool(this.isBoss ? 'boss' : 'normal');
    const choices = pool.length > 1 ? pool.filter(id => id !== this.lastLevelId) : pool;
    return this.rng.pick(choices);
  }

  // 依玩家目前的牌與血量，算出這一關要帶進 Match 的數值（含這一關的暫時加成與連結對象）
  carryFor(p) {
    const d = derivePlayerStats(p.stats);
    const maxHp = d.maxHp + p.boost.maxHp;
    return {
      hp: Math.min(p.hp, maxHp), maxHp, maxStamina: d.maxStamina, moveSpeed: d.moveSpeed, jumpSpeed: d.jumpSpeed,
      size: d.size, mods: { ...d.mods, stageDamagePct: p.boost.damagePct }, weapons: p.weapons.slice(), soulPct: p.soulPct,
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
    const carry = {};
    const list = [...this.players.values()];
    for (const p of list) {
      // 上一關倒下的人以 reviveHpPct 復活
      if (p.hp <= 0) p.hp = Math.round(derivePlayerStats(p.stats).maxHp * CONFIG.RUN.reviveHpPct);
      // 腎上腺素：上一次選牌拿到的暫時加成在這一關生效，血量上限加多少就同時回多少
      p.boost = p.next;
      p.next = { damagePct: 0, maxHp: 0 };
      if (p.boost.maxHp > 0) p.hp += p.boost.maxHp;
      carry[p.id] = this.carryFor(p);
    }
    this.phase = 'battle';
    // 這一關每位玩家帶進來的血量、武器欄、手上的牌
    this.record('stage.start', {
      stage: this.stage, stageCount: this.stageCount, boss: this.isBoss, level: levelId,
      players: list.map(p => ({ pid: p.id, name: p.name, hp: carry[p.id].hp, maxHp: carry[p.id].maxHp, weapons: p.weapons.slice(), cards: p.cards.map(c => c.id) })),
    });
    this.match = new Match({ levelId, players: list, seed: this.rng.int(0, 0xffffffff), carry, stage: this.stage });
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
    // 把血量與噬魂者的累積加成帶回冒險狀態；這一關的暫時加成（腎上腺素）失效，超過原本上限的血扣掉
    for (const e of this.match.players) {
      const p = this.players.get(e.id);
      if (!p) continue;
      p.hp = e.alive ? Math.min(e.hp, derivePlayerStats(p.stats).maxHp) : 0;
      p.soulPct = e.soulPct;
    }
    for (const p of this.players.values()) p.boost = { damagePct: 0, maxHp: 0 };
    if (result === 'lose') return this.runOver('lose');
    if (this.isBoss) return this.runOver('win');

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
      // 攜手之伴：一定要指定一位還沒跟他連結（這一輪也還沒選他）的隊友
      if (card.effects.link > 0) {
        if (!this.linkTargets(p).includes(msg.link)) return ignored('badLinkTarget');
        this.linkPicks[playerId] = msg.link;
      }
      this.picks[playerId] = card.id;
      this.record('pick', {
        stage: this.stage, pid: playerId, name: p.name, card: card.id,
        ...(needsDiscard(weapons, card) ? { discard: msg.discard } : {}), ...(card.effects.link > 0 ? { link: msg.link } : {}),
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
    let teamHealPct = 0;
    const allyHeals = [];   // [回血的人, 每位隊友回多少]（醫療包）
    const auto = new Set();   // 紀錄用：超時 / 斷線、由系統隨機選的人
    for (const p of list) {
      const offers = this.offers[p.id] || [];
      let card = offers.find(c => c.id === this.picks[p.id]);
      if (!card && offers.length) {
        // 沒選 / 斷線 → 隨機，盡量不挑要丟武器才能拿的牌、沒有隊友可以連結的攜手之伴
        const safe = offers.filter(c => !needsDiscard(p.weapons, c) && !(c.effects.link > 0 && !this.linkTargets(p).length));
        card = this.rng.pick(safe.length ? safe : offers);
        auto.add(p.id);
      }
      if (!card) continue;
      p.cards.push(card);
      const { weapons, discarded } = equipWeapon(p.weapons, card, this.discards[p.id]);
      p.weapons = weapons;
      const now = applyCard(p.stats, card);
      teamHealPct += now.teamHealPct;
      if (now.allyHeal > 0) allyHeals.push([p.id, now.allyHeal]);
      p.next.damagePct += now.nextDamagePct;   // 腎上腺素：下一關才生效
      p.next.maxHp += now.nextMaxHp;
      const maxAfter = derivePlayerStats(p.stats).maxHp;
      if (p.hp > 0) p.hp = Math.min(maxAfter, Math.round(p.hp + now.heal + maxAfter * now.healPct / 100));
      const entry = { playerId: p.id, cardId: card.id, weapons: p.weapons.slice(), discarded };
      if (now.link > 0) {
        // 攜手之伴：照他選的；超時 / 斷線就從還能連的隊友裡隨機挑一位（會避開這一輪已經選了他的人，那兩人本來就會連上）
        let to = this.linkPicks[p.id];
        const free = this.linkTargets(p);
        if (!free.includes(to)) to = free.length ? this.rng.pick(free) : null;
        if (to) { p.links.push(to); entry.link = to; }
      }
      summary.push(entry);
    }
    // 全隊回血（祈願之杖）與隊友回血（醫療包）等大家的牌都套完再算，用每個人自己新的上限；倒下的人下一關本來就會復活
    for (const p of list) {
      if (p.hp <= 0) continue;
      const maxHp = derivePlayerStats(p.stats).maxHp;
      const ally = allyHeals.reduce((s, [from, n]) => s + (from === p.id ? 0 : n), 0);
      p.hp = Math.min(maxHp, Math.round(p.hp + ally + maxHp * teamHealPct / 100));
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
    this.io.broadcast({ t: 'picks', summary, nextStage: this.stage + 1, isBoss: this.stage + 1 > CONFIG.RUN.stagesBeforeBoss });
    this.phase = 'between';
    this.schedule(() => this.nextStage(), 2.5);
  }

  runOver(result) {
    this.cancelTimer();
    this.phase = 'over';
    this.result = result;
    // 整場冒險結束（win = Boss 打倒、lose = 全滅）：打到第幾關、每個人最後的牌
    this.record('run.over', {
      result, stage: this.stage, stageCount: this.stageCount,
      players: [...this.players.values()].map(p => ({ pid: p.id, name: p.name, hp: p.hp, cards: p.cards.map(c => c.id), weapons: p.weapons.slice() })),
    });
    this.io.broadcast({ t: 'runOver', result, stage: this.stage, stageCount: this.stageCount, cards: this.stageInfo().cards });
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
