import { CONFIG } from '../shared/core/config.js';
import { STAGE_LOOK, difficultyName } from './stage-look.js';
import { difficultyOf } from '../shared/game/stage-rules.js';

// 結算畫面（DOM）：整場冒險結束（通關或全滅）時顯示每位玩家的
// 總傷害、命中率、承受傷害、誤傷隊友，以及拿到的所有牌（能力）
// 勝者為王（runOver 的 mode === 'versus'）：照隊伍分兩欄（贏的那隊標「勝」），多一格擊殺，電腦玩家 / 倒下的人加標籤
export class SummaryUi {
  constructor(root) {
    this.root = root;
    this.$ = (sel) => root.querySelector(sel);
    this.$('#summary-back').addEventListener('click', () => location.reload());
  }

  // runOver 訊息：{ result, stage, stageCount, type, difficulty, summary: [{ id, name, dealt, friendlyDealt, taken, shots, hits, cards: [...] }] }；
  // type = 倒在哪一種關卡（'normal' | 'elite' | 'boss'）；difficulty = 這場的難度（一般的不特別寫）；theme = 主題副本的主題（有才寫）
  show(msg, { myId, type = 'normal' }) {
    this.root.classList.toggle('versus', msg.mode === 'versus');
    if (msg.mode === 'versus') { this.showVersus(msg, myId); return; }
    const where = STAGE_LOOK[type] && STAGE_LOOK[type].name;
    const win = msg.result === 'win';
    this.root.classList.toggle('win', win);
    this.$('#summary-title').textContent = win ? '通關！' : '冒險結束';
    const hard = (CONFIG.THEMES[msg.theme] ? `　·　${CONFIG.THEMES[msg.theme].name}` : '')
      + (difficultyOf(msg.difficulty) !== 'normal' ? `　·　${difficultyName(msg.difficulty)}` : '');
    this.$('#summary-sub').textContent = (win
      ? `打倒了全部 ${msg.stageCount} 關`
      : `倒在第 ${msg.stage} / ${msg.stageCount} 關${where ? `（${where}）` : ''}`) + hard;
    const list = this.$('#summary-list');
    list.innerHTML = '';
    const rows = msg.summary || [];
    list.classList.toggle('multi', rows.length > 1);
    for (const p of rows) list.appendChild(this.playerBlock(p, p.id === myId && rows.length > 1));
    this.root.hidden = false;
  }

  hide() { this.root.hidden = true; }

  // 勝者為王：runOver = { mode: 'versus', result, winner（'blue' | 'red'，平手 null）, round, summary: [{ ..., team, bot?, alive, kills }] }
  // 標題看我在哪一隊（找不到 = 觀戰，不分輸贏）；兩隊照 VERSUS.teams 的順序分兩欄
  showVersus(msg, myId) {
    const V = CONFIG.VERSUS;
    const rows = msg.summary || [];
    const winner = msg.winner || null;
    const me = rows.find(p => p.id === myId);
    const myTeam = me ? me.team : null;
    const title = !winner ? '平手' : !myTeam ? '對戰結束' : winner === myTeam ? '勝利！' : '落敗';
    this.root.classList.toggle('win', !!winner && winner === myTeam);
    this.root.classList.toggle('draw', !winner || !myTeam);   // 平手 / 觀戰：標題用不分輸贏的顏色
    this.$('#summary-title').textContent = title;
    this.$('#summary-sub').textContent = [V.name, winner ? `${V.teamNames[winner] || winner}獲勝` : '平手', msg.round ? `共 ${msg.round} 輪` : '']
      .filter(Boolean).join('　·　');
    const list = this.$('#summary-list');
    list.innerHTML = '';
    list.classList.remove('multi');
    list.classList.add('teams');
    for (const team of V.teams) {
      const col = document.createElement('div');
      col.className = `sum-team ${team}` + (winner === team ? ' won' : '');
      const head = document.createElement('div');
      head.className = 'sum-team-head';
      head.innerHTML = '<span class="tname"></span>';
      head.querySelector('.tname').textContent = V.teamNames[team] || team;
      if (winner === team) head.insertAdjacentHTML('beforeend', '<span class="won-tag">勝</span>');
      col.appendChild(head);
      for (const p of rows.filter(x => x.team === team)) col.appendChild(this.playerBlock(p, p.id === myId, true));
      list.appendChild(col);
    }
    this.root.hidden = false;
  }

  // versus = 勝者為王：多一格擊殺、名字後面加「電腦」/「倒下」標籤
  playerBlock(p, isMe, versus = false) {
    const el = document.createElement('div');
    el.className = 'sum-player' + (isMe ? ' me' : '');
    const name = document.createElement('div');
    name.className = 'sum-name';
    name.textContent = p.name + (isMe ? '（你）' : '');
    if (versus) {
      for (const [show, text, cls] of [[p.bot, '電腦', 'bot'], [p.alive === false, '倒下', 'down']]) {
        if (!show) continue;
        const tag = document.createElement('span');
        tag.className = `sum-tag ${cls}`;
        tag.textContent = text;
        name.appendChild(tag);
      }
      if (p.alive === false) el.classList.add('down');
    }
    el.appendChild(name);

    const rate = p.shots > 0 ? `${Math.round(p.hits / p.shots * 100)}%` : '—';
    const stats = document.createElement('div');
    stats.className = 'sum-stats';
    const cells = [
      ['總傷害', p.dealt, '', 'dealt'],
      ['命中率', rate, `${p.hits} / ${p.shots} 槍`, 'rate'],
      ['承受傷害', p.taken, '', 'taken'],
    ];
    if (versus) cells.push(['擊殺', p.kills || 0, '', 'kills']);
    cells.push(['誤傷隊友', p.friendlyDealt || 0, '', 'friendly']);   // 一律顯示：沒有隊友（單人、1 對 1）就是 0
    for (const [label, value, sub, cls] of cells) {
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
