import { CONFIG } from '../shared/config.js';
import { needsDiscard } from '../shared/cards.js';
import { teammateEffect, appliesBurn } from '../shared/effects/index.js';
import { isBossStage } from '../shared/stage-rules.js';

// 過關選牌畫面（DOM）：三張牌選一張，顯示倒數與其他玩家是否已選。
// 武器牌：武器欄滿了（最多 EQUIP.maxWeapons 把）要先選一把丟掉才能拿，也可以取消改選別張
// 要指定隊友的牌（效果的 target，例如攜手之伴）：要先選一位隊友當對象（同一個面板），也可以取消改選別張；文字由效果給（pickText）
const isLinkCard = (card) => !!teammateEffect(card);
const textOf = (card) => teammateEffect(card).pickText;

export class CardsUi {
  constructor(root, onPick) {
    this.root = root;
    this.onPick = onPick;   // (cardId, discardWeaponId | null, 指定的隊友 id | null)
    this.$ = (sel) => root.querySelector(sel);
    this.timer = null;
    this.players = [];
    this.picked = new Set();
    this.myId = null;
    this.weapons = [];
    this.linkTargets = [];
    this.$('#discard-cancel').addEventListener('click', () => this.hideDiscard());
  }

  // offers: 我的三張牌；players: [{id,name}]；pickTime: 秒；weapons: 我目前的武器欄；
  // linkTargets: 攜手之伴能選的隊友 id；links: 每個人現在跟誰連結著（id → [id]）
  show({ stage, stageCount, offers, pickTime, players, myId, picked = null, weapons = [], linkTargets = [], links = {} }) {
    this.players = players;
    this.myId = myId;
    this.weapons = weapons;
    this.linkTargets = linkTargets;
    this.links = links;
    this.linkCard = null;   // 正在選連結對象的那張牌（名單變了要重畫）
    this.picked = new Set();
    this.root.hidden = false;
    this.$('#cards-title').textContent = `第 ${stage} 關通過！`;
    this.$('#cards-sub').textContent = isBossStage(stage + 1)
      ? `選一張牌，接下來是 Boss 關（第 ${stage + 1} / ${stageCount} 關）`
      : `選一張牌，接著進入第 ${stage + 1} / ${stageCount} 關`;
    const list = this.$('#cards-list');
    list.innerHTML = '';
    list.classList.remove('locked');
    for (const card of offers) {
      const r = CONFIG.RARITY[card.rarity] || CONFIG.RARITY.white;
      const el = document.createElement('button');
      el.className = `card rarity-${card.rarity}${card.weapon ? ' weapon' : ''}`;
      el.dataset.id = card.id;
      el.style.setProperty('--rc', r.color);
      el.innerHTML = `<div class="tags"><span class="rarity">${r.name}</span><span class="kind">${card.weapon ? '武器' : '裝備'}</span></div>`
        + '<div class="cname"></div><div class="cdesc"></div><div class="swap"></div>';
      el.querySelector('.cname').textContent = card.name;
      el.querySelector('.cdesc').textContent = card.desc;
      if (needsDiscard(this.weapons, card)) el.querySelector('.swap').textContent = '武器欄已滿，要換掉一把';
      el.addEventListener('click', () => this.choose(card));
      list.appendChild(el);
    }
    this.offers = offers;
    this.refreshLinkCards();
    this.renderLoadout();
    this.renderNotes(offers);
    this.hideDiscard();
    this.$('#cards-status').textContent = '';
    this.renderOthers();
    this.startCountdown(pickTime);
    if (picked) this.markPicked(picked);
  }

  choose(card) {
    if (needsDiscard(this.weapons, card)) this.showDiscard(card);
    else if (isLinkCard(card)) this.showLink(card);
    else this.pick(card.id, null);
  }

  // 要指定隊友的牌：還有沒有隊友可以選（這一輪別人先選了我，名單就會少一個；一個都不剩就不能拿）
  refreshLinkCards() {
    for (const el of this.$('#cards-list').querySelectorAll('.card')) {
      const card = (this.offers || []).find(c => c.id === el.dataset.id);
      if (!card || !isLinkCard(card)) continue;
      const none = !this.linkTargets.length;
      el.querySelector('.swap').textContent = none ? textOf(card).none : textOf(card).need;
      if (!this.$('#cards-list').classList.contains('locked')) el.disabled = none;
    }
  }

  nameOf(id) {
    const p = this.players.find(x => x.id === id);
    return p ? p.name : id;
  }

  // 要指定隊友的牌：列出還能選的隊友，點一位 = 選他（攜手之伴：跟他連結；對方已經跟別人連結的話，被打時是好幾個人一起平分）
  showLink(card) {
    const T = textOf(card);
    this.linkCard = card;
    this.$('#discard-title').textContent = T.title(card);
    const list = this.$('#discard-list');
    list.innerHTML = '';
    for (const id of this.linkTargets) {
      const others = (this.links[id] || []).filter(x => x !== this.myId);
      const btn = document.createElement('button');
      btn.className = 'discard-btn link-btn';
      btn.dataset.player = id;
      btn.innerHTML = '<b></b><span></span>';
      btn.querySelector('b').textContent = T.button(this.nameOf(id));
      btn.querySelector('span').textContent = T.hint(others.map(x => this.nameOf(x)));
      btn.addEventListener('click', () => { this.hideDiscard(); this.pick(card.id, null, id); });
      list.appendChild(btn);
    }
    this.$('#cards-discard').hidden = false;
  }

  // 武器欄已滿：列出目前的武器，點一把 = 丟掉它、換成新武器
  showDiscard(card) {
    const neu = CONFIG.WEAPONS[card.weapon];
    this.$('#discard-title').textContent = `武器欄已滿（最多 ${CONFIG.EQUIP.maxWeapons} 把）：選一把丟掉，換成「${neu ? neu.name : card.name}」`;
    const list = this.$('#discard-list');
    list.innerHTML = '';
    for (const id of this.weapons) {
      const w = CONFIG.WEAPONS[id];
      const btn = document.createElement('button');
      btn.className = 'discard-btn';
      btn.dataset.weapon = id;
      btn.innerHTML = '<b></b><span></span>';
      btn.querySelector('b').textContent = `丟掉 ${w ? w.name : id}`;
      btn.querySelector('span').textContent = w ? w.desc : '';
      btn.addEventListener('click', () => { this.hideDiscard(); this.pick(card.id, id); });
      list.appendChild(btn);
    }
    this.$('#cards-discard').hidden = false;
  }

  hideDiscard() {
    this.$('#cards-discard').hidden = true;
    this.linkCard = null;
  }

  pick(cardId, discard, teammate = null) {
    this.onPick(cardId, discard, teammate);
    this.markPicked(cardId);
  }

  markPicked(cardId) {
    const list = this.$('#cards-list');
    list.classList.add('locked');
    for (const el of list.querySelectorAll('.card')) {
      el.disabled = true;
      if (el.dataset.id === cardId) el.classList.add('chosen');
    }
    this.hideDiscard();
    this.$('#cards-status').textContent = '已選擇，等待其他玩家…';
    this.picked.add(this.myId);
    this.renderOthers();
  }

  // chosen = 他用要指定隊友的牌（攜手之伴）選了誰。選的是我：選完就會連上，我不用（也不能）再選他
  setPicked(playerId, chosen = null) {
    this.picked.add(playerId);
    this.renderOthers();
    if (chosen !== this.myId || !this.linkTargets.includes(playerId)) return;
    this.linkTargets = this.linkTargets.filter(id => id !== playerId);
    this.refreshLinkCards();
    if (this.linkCard) {
      if (this.linkTargets.length) this.showLink(this.linkCard);
      else this.hideDiscard();
    }
    if (!this.picked.has(this.myId)) this.$('#cards-status').textContent = `${this.nameOf(playerId)} 選了跟你連結`;
  }

  renderLoadout() {
    const names = this.weapons.map(id => (CONFIG.WEAPONS[id] ? CONFIG.WEAPONS[id].name : id));
    this.$('#cards-loadout').textContent = `你的武器欄（${this.weapons.length} / ${CONFIG.EQUIP.maxWeapons}）：${names.join('、')}`;
  }

  // 牌會給的特殊狀態，在下面補一行說明（看牌實際帶的效果，不看說明文字）
  renderNotes(offers) {
    const B = CONFIG.EQUIP.burn;
    const notes = [];
    if (offers.some(appliesBurn)) {
      notes.push(`＊燃燒：自己的回合結束時，每層扣最大血量 ${B.pctPerStack}%；在自己的回合移動可以甩掉層數（每 ${B.pxPerStack}px 一層，每回合最多 ${B.maxReducePerTurn} 層）`);
    }
    this.$('#cards-note').textContent = notes.join('\n');
  }

  renderOthers() {
    const others = this.players.filter(p => p.id !== this.myId);
    const el = this.$('#cards-others');
    if (!others.length) { el.textContent = ''; return; }
    el.textContent = others.map(p => `${p.name}：${this.picked.has(p.id) ? '已選' : '選牌中…'}`).join('　');
  }

  startCountdown(secs) {
    this.stopCountdown();
    let left = Math.ceil(secs);
    const tick = () => {
      this.$('#cards-timer').textContent = `${left} 秒`;
      if (left-- <= 0) this.stopCountdown();
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }

  stopCountdown() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  hide() {
    this.stopCountdown();
    this.hideDiscard();
    this.root.hidden = true;
  }
}
