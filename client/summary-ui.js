import { CONFIG } from '../shared/config.js';

// 結算畫面（DOM）：整場冒險結束（通關或全滅）時顯示每位玩家的
// 總傷害、命中率、承受傷害，以及拿到的所有牌（能力）
export class SummaryUi {
  constructor(root) {
    this.root = root;
    this.$ = (sel) => root.querySelector(sel);
    this.$('#summary-back').addEventListener('click', () => location.reload());
  }

  // runOver 訊息：{ result, stage, stageCount, summary: [{ id, name, dealt, taken, shots, hits, cards: [...] }] }
  show(msg, { myId, isBoss }) {
    const win = msg.result === 'win';
    this.root.classList.toggle('win', win);
    this.$('#summary-title').textContent = win ? '通關！' : '冒險結束';
    this.$('#summary-sub').textContent = win
      ? `打倒了全部 ${msg.stageCount} 關`
      : `倒在第 ${msg.stage} / ${msg.stageCount} 關${isBoss ? '（Boss 關）' : ''}`;
    const list = this.$('#summary-list');
    list.innerHTML = '';
    const rows = msg.summary || [];
    list.classList.toggle('multi', rows.length > 1);
    for (const p of rows) list.appendChild(this.playerBlock(p, p.id === myId && rows.length > 1));
    this.root.hidden = false;
  }

  hide() { this.root.hidden = true; }

  playerBlock(p, isMe) {
    const el = document.createElement('div');
    el.className = 'sum-player' + (isMe ? ' me' : '');
    const name = document.createElement('div');
    name.className = 'sum-name';
    name.textContent = p.name + (isMe ? '（你）' : '');
    el.appendChild(name);

    const rate = p.shots > 0 ? `${Math.round(p.hits / p.shots * 100)}%` : '—';
    const stats = document.createElement('div');
    stats.className = 'sum-stats';
    for (const [label, value, sub, cls] of [
      ['總傷害', p.dealt, '', 'dealt'],
      ['命中率', rate, `${p.hits} / ${p.shots} 槍`, 'rate'],
      ['承受傷害', p.taken, '', 'taken'],
    ]) {
      const s = document.createElement('div');
      s.className = `sum-stat ${cls}`;
      s.innerHTML = '<div class="v"></div><div class="l"></div><div class="s"></div>';
      s.querySelector('.v').textContent = value;
      s.querySelector('.l').textContent = label;
      s.querySelector('.s').textContent = sub;
      stats.appendChild(s);
    }
    el.appendChild(stats);

    const head = document.createElement('div');
    head.className = 'sum-cards-head';
    head.textContent = `獲得的能力（${p.cards.reduce((n, c) => n + c.count, 0)}）`;
    el.appendChild(head);
    const cards = document.createElement('div');
    cards.className = 'sum-cards';
    if (!p.cards.length) {
      cards.innerHTML = '<span class="sum-none">沒有拿到任何牌</span>';
    }
    for (const c of p.cards) {
      const r = CONFIG.RARITY[c.rarity] || CONFIG.RARITY.white;
      const chip = document.createElement('span');
      chip.className = 'sum-card' + (c.weapon ? ' weapon' : '');
      chip.style.setProperty('--rc', r.color);
      chip.title = c.desc || '';
      chip.textContent = c.name + (c.count > 1 ? ` ×${c.count}` : '');
      cards.appendChild(chip);
    }
    el.appendChild(cards);
    return el;
  }
}
