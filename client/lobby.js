import { CONFIG } from '../shared/core/config.js';
import { difficultyOf, difficultyDesc, themeDesc } from '../shared/game/stage-rules.js';
import { openThemes } from '../shared/game/themes.js';
import { difficultyName } from './stage-look.js';

const DIFFICULTY_KEY = 'sh_difficulty';   // 上次選的難度（只是方便，讀不到就用一般）
const MODE_KEY = 'sh_mode';               // 上次選的模式（同上，讀不到就用冒險）
// 硬體加速的提醒按過「知道了」：存在 sessionStorage，這個分頁不再出現、開新分頁會再提醒
// （瀏覽器「重新啟動」還原的分頁會帶著這個值，所以那一頁不一定會再提醒）
const GPU_HINT_KEY = 'sh_gpu_hint_closed';

// 模式：coop = 冒險（PVE 共鬥）、theme = 主題副本、versus = 勝者為王（兩隊對戰）；不認得的都當冒險（同伺服器的 modeOf）。
// 主題副本要有開放中的主題才出現（shared/game/themes.js 的 openThemes）；現在只有一個主題，選了就是它（主題多了再加一排選主題）
const V = CONFIG.VERSUS;
const THEME = openThemes()[0] || null;
const MODES = { coop: '冒險', ...(THEME ? { theme: '主題副本' } : {}), versus: `${V.name} ${V.teamSize}v${V.teamSize}` };
const modeOf = (id) => (id === 'versus' ? 'versus' : id === 'theme' && THEME ? 'theme' : 'coop');
const THEMES = CONFIG.THEMES;
// 勝者為王的一行說明（選單上、房間裡模式標籤的提示）：數字照 CONFIG.VERSUS
const VERSUS_DESC = `${V.teamSize} 對 ${V.teamSize} 對戰：每人 ${V.hp} 血，${V.pickEvery > 1 ? `每 ${V.pickEvery} 輪` : '每輪'}結束選一張牌，`
  + `第 ${V.feverEvery + 1} 輪起狂熱；人不夠可以加電腦玩家`;

// 難度 / 模式切換鈕（radiogroup 裡的一顆）
function radioButton(id, text) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.id = id;
  btn.setAttribute('role', 'radio');
  btn.textContent = text;
  return btn;
}

// 勝者為王房間裡的小按鈕：data 寫進 dataset（act = team / addBot / removeBot，點了由 Lobby 統一處理）
function slotButton(text, data, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'slot-btn';
  Object.assign(btn.dataset, data);
  btn.textContent = text;
  if (title) btn.title = title;
  return btn;
}

// 大廳畫面（DOM）：暱稱、模式、難度、建房（公開 / 私人）/ 公開房間列表 / 輸入房號加入 / 單人、房間內的準備與開始（勝者為王另有分隊）
export class Lobby {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.$ = (sel) => root.querySelector(sel);
    this.nameInput = this.$('#name');
    this.codeInput = this.$('#code');
    this.menu = this.$('#menu');
    this.room = this.$('#room');
    this.status = this.$('#status');
    this.error = this.$('#error');
    this.ready = false;

    this.nameInput.value = localStorage.getItem('sh_name') || `玩家${Math.floor(Math.random() * 900 + 100)}`;
    this.nameInput.addEventListener('change', () => localStorage.setItem('sh_name', this.name()));
    this.codeInput.addEventListener('input', () => { this.codeInput.value = this.codeInput.value.toUpperCase(); });
    this.codeInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') this.$('#btn-join').click(); });

    // 難度：單人練習、建立房間都照這裡選的
    this.difficultyPick = this.$('#difficulty');
    this.difficultyPick.replaceChildren(...Object.entries(CONFIG.DIFFICULTY).map(([id, d]) => radioButton(id, d.name)));
    this.difficultyPick.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-id]');
      if (btn) this.setDifficulty(btn.dataset.id, true);
    });
    let saved = null;
    try { saved = localStorage.getItem(DIFFICULTY_KEY); } catch { /* 無痕視窗之類：用一般 */ }
    this.setDifficulty(saved, false);

    // 模式：冒險 / 勝者為王，單人練習、建立房間也照這裡選的（勝者為王的單人練習 = 跟電腦玩家打）
    this.modePick = this.$('#mode');
    this.modePick.replaceChildren(...Object.entries(MODES).map(([id, name]) => radioButton(id, name)));
    this.modePick.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-id]');
      if (btn) this.setMode(btn.dataset.id, true);
    });
    let savedMode = null;
    try { savedMode = localStorage.getItem(MODE_KEY); } catch { /* 讀不到：用冒險 */ }
    this.setMode(savedMode, false);

    // 對戰沒有難度：一律送一般（伺服器也只認一般），冒險、主題副本照選的
    const difficulty = () => (this.mode === 'versus' ? 'normal' : this.difficulty);
    const theme = () => (this.mode === 'theme' ? THEME : null);
    this.$('#btn-solo').addEventListener('click', () => this.guard(() => this.h.onSolo(this.name(), difficulty(), this.mode, theme())));
    this.$('#btn-create').addEventListener('click', () => this.guard(() => this.h.onCreate(this.name(), this.$('#create-private').checked, difficulty(), this.mode, theme())));
    this.$('#btn-join').addEventListener('click', () => {
      const code = this.codeInput.value.trim().toUpperCase();
      if (code.length < 4) return this.showError('請輸入 4 碼房號');
      this.guard(() => this.h.onJoin(this.name(), code, 'code'));
    });
    // 大廳列表：點一列就用那個房號加入
    this.roomList = this.$('#room-list');
    this.roomList.addEventListener('click', (ev) => {
      const row = ev.target.closest('button[data-code]');
      if (row) return this.guard(() => this.h.onJoin(this.name(), row.dataset.code, 'list'));
      if (ev.target.closest('button[data-retry]')) this.h.onRetryBrowse();
    });
    this.setBrowseState('connecting');
    this.$('#room-private').addEventListener('change', (ev) => this.h.onPrivacy(ev.target.checked));
    this.$('#btn-ready').addEventListener('click', () => { this.ready = !this.ready; this.h.onReady(this.ready); });
    this.$('#btn-start').addEventListener('click', () => this.h.onStart());
    this.$('#btn-leave').addEventListener('click', () => this.h.onLeave());
    // 勝者為王的房間：換隊、房主加 / 移除電腦玩家（按鈕在 showTeams 畫，伺服器檢查有沒有空位、是不是房主）
    this.teamsBox = this.$('#teams');
    this.teamsBox.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const { act, team, id } = btn.dataset;
      if (act === 'team') this.h.onTeam(team);
      else if (act === 'addBot') this.h.onAddBot(team);
      else if (act === 'removeBot') this.h.onRemoveBot(id);
    });

    this.$('#gpu-hint-close').addEventListener('click', () => {
      this.$('#gpu-hint').hidden = true;
      try { sessionStorage.setItem(GPU_HINT_KEY, '1'); } catch { /* 存不了：重新整理會再出現，沒關係 */ }
    });
    this.$('#gpu-hint-copy').addEventListener('click', () => this.copyGpuUrl());
  }

  // 瀏覽器好像沒開硬體加速（client/gpu-check.js）：在標題下面提醒怎麼打開。guide = accelGuide() 給的 { steps, url }
  showGpuHint(guide) {
    try { if (sessionStorage.getItem(GPU_HINT_KEY)) return; } catch { /* 讀不到就照樣提醒 */ }
    this.$('#gpu-hint-steps').textContent = guide.steps;
    this.$('#gpu-hint-url').textContent = guide.url || '';
    this.$('#gpu-hint-link').hidden = !guide.url;
    this.$('#gpu-hint').hidden = false;
  }

  // 複製設定頁網址：區網的 http 網址沒有 navigator.clipboard，改成把網址選起來用舊的 execCommand 複製；都不行就留著選取讓玩家自己複製
  async copyGpuUrl() {
    const code = this.$('#gpu-hint-url');
    const btn = this.$('#gpu-hint-copy');
    let ok = false;
    try {
      await navigator.clipboard.writeText(code.textContent);
      ok = true;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(code);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try { ok = document.execCommand('copy'); } catch { ok = false; }
    }
    btn.textContent = ok ? '已複製' : '已選取，請手動複製';   // Mac 是 ⌘C，不寫死按鍵
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => { btn.textContent = '複製網址'; }, 2000);
  }

  name() {
    return this.nameInput.value.trim().slice(0, 12) || '玩家';
  }

  // 選難度：按鈕亮起來、底下的說明換成那個難度的（哪幾關是菁英關、敵人傷害打不打折）；remember = 記住下次打開還是這個
  setDifficulty(id, remember) {
    this.difficulty = difficultyOf(id);
    for (const btn of this.difficultyPick.querySelectorAll('button[data-id]')) btn.setAttribute('aria-checked', String(btn.dataset.id === this.difficulty));
    // 主題副本：菁英關的位置照主題的
    this.$('#difficulty-desc').textContent = difficultyDesc(this.difficulty, CONFIG, this.mode === 'theme' ? THEME : null);
    if (remember) try { localStorage.setItem(DIFFICULTY_KEY, this.difficulty); } catch { /* 存不了就算了 */ }
  }

  // 選模式：勝者為王沒有難度，藏起難度那排與說明、換上模式說明，單人練習改叫「對電腦」；
  // 主題副本有難度，模式說明（主題）與難度說明（照主題的菁英關）都顯示；remember 同 setDifficulty
  setMode(id, remember) {
    this.mode = modeOf(id);
    const versus = this.mode === 'versus';
    for (const btn of this.modePick.querySelectorAll('button[data-id]')) btn.setAttribute('aria-checked', String(btn.dataset.id === this.mode));
    this.$('.difficulty-row').hidden = versus;
    this.$('#difficulty-desc').hidden = versus;
    this.$('#mode-desc').hidden = this.mode === 'coop';
    this.$('#mode-desc').textContent = versus ? VERSUS_DESC : this.mode === 'theme' ? themeDesc(THEME) : '';
    this.setDifficulty(this.difficulty, false);
    this.$('#btn-solo').textContent = versus ? '單人練習（對電腦）' : '單人練習';
    if (remember) try { localStorage.setItem(MODE_KEY, this.mode); } catch { /* 存不了就算了 */ }
  }

  async guard(fn) {
    this.showError('');
    this.setBusy(true);
    try { await fn(); } catch (err) { this.showError(err.message || String(err)); }
    finally { this.setBusy(false); }
  }

  setBusy(b) {
    this.busy = b;
    for (const btn of this.menu.querySelectorAll('button')) {
      // 列表裡本來就不能加入的（遊戲中 / 已滿）不要被解開
      if (btn.classList.contains('room-row') && !btn.dataset.code) continue;
      btn.disabled = b;
    }
    this.setStatus(b ? '連線中…' : '');
  }

  setStatus(s) { this.status.textContent = s; }
  showError(s) { this.error.textContent = s; }

  // 列表還沒拿到時的狀態：connecting = 連線中、offline = 連不上伺服器（可以重試，單人練習照樣能玩）
  setBrowseState(state) {
    this.$('#room-count').textContent = '';
    const li = document.createElement('li');
    li.className = 'room-empty';
    if (state === 'offline') {
      li.textContent = '連不上伺服器，看不到房間列表（單人練習還是能玩）';
      const retry = document.createElement('button');
      retry.dataset.retry = '1';
      retry.textContent = '重試';
      li.appendChild(retry);
    } else {
      li.textContent = '正在連線到大廳…';
    }
    this.roomList.replaceChildren(li);
  }

  // 收到 rooms 訊息：更新公開房間列表（私人房間伺服器不會送）
  showRooms(rooms) {
    const open = rooms.filter(r => !r.started && r.players < r.max).length;
    this.$('#room-count').textContent = rooms.length ? `${rooms.length} 間 · ${open} 間可加入` : '';
    if (!rooms.length) {
      const li = document.createElement('li');
      li.className = 'room-empty';
      li.textContent = '目前沒有公開房間，建立一個吧！';
      this.roomList.replaceChildren(li);
      return;
    }
    this.roomList.replaceChildren(...rooms.map((r) => {
      const li = document.createElement('li');
      li.className = 'room-item';
      const btn = document.createElement('button');
      btn.className = 'room-row';
      btn.type = 'button';
      const full = r.players >= r.max;
      const state = r.started ? '遊戲中' : full ? '已滿' : '加入';
      btn.disabled = r.started || full || this.busy;
      if (!btn.disabled) btn.dataset.code = r.code;
      btn.title = btn.disabled ? `房間${state}` : `加入房號 ${r.code}`;
      // 勝者為王的房間標模式（沒有難度）、主題副本的房間標主題；冒險（含主題副本）的房間不是一般難度才標難度
      const versus = r.mode === 'versus';
      const theme = r.mode === 'theme' && THEMES[r.theme];
      const hard = !versus && difficultyOf(r.difficulty) !== 'normal';
      btn.innerHTML = `<span class="rcode"></span><span class="rhost"></span>${versus || theme ? `<span class="rmode${theme ? ' theme' : ''}"></span>` : ''}${hard ? '<span class="rdiff"></span>' : ''}<span class="rcount"></span><span class="rstate${btn.disabled ? ' busy' : ''}"></span>`;
      btn.querySelector('.rcode').textContent = r.code;
      btn.querySelector('.rhost').textContent = `${r.host} 的房間`;
      if (versus || theme) btn.querySelector('.rmode').textContent = versus ? V.name : theme.name;
      if (hard) btn.querySelector('.rdiff').textContent = difficultyName(r.difficulty);
      btn.querySelector('.rcount').textContent = `${r.players} / ${r.max}`;
      btn.querySelector('.rstate').textContent = state;
      li.appendChild(btn);
      return li;
    }));
  }

  // 收到 lobby 訊息：切到房間畫面並更新名單
  showRoom(msg, myId) {
    this.root.hidden = false;
    this.menu.hidden = true;
    this.room.hidden = false;
    this.inRoom = true;
    this.$('#room-code').textContent = msg.code;
    const isHostNow = msg.hostId === myId;
    const versus = msg.mode === 'versus';
    const theme = msg.mode === 'theme' && THEMES[msg.theme] ? msg.theme : null;
    // 勝者為王沒有難度：標籤改寫模式；主題副本前面加主題的名字
    const diff = this.$('#difficulty-label');
    diff.textContent = versus ? `模式：${V.name}` : `${theme ? `${THEMES[theme].name}　` : ''}難度：${difficultyName(msg.difficulty)}`;
    diff.classList.toggle('elite', !versus && difficultyOf(msg.difficulty) === 'elite');
    diff.classList.toggle('versus', versus);
    diff.classList.toggle('theme', !!theme);
    diff.title = versus ? VERSUS_DESC : `${theme ? `${themeDesc(theme)}\n` : ''}${difficultyDesc(msg.difficulty, CONFIG, theme)}`;
    const label = this.$('#privacy-label');
    label.textContent = msg.private ? '私人房間' : '公開房間';
    label.classList.toggle('private', !!msg.private);
    this.$('#room-hint').textContent = msg.private ? '只能輸入房號加入，把房號告訴朋友' : '大廳看得到，也能輸入房號加入';
    this.$('#privacy-toggle').hidden = !isHostNow;
    this.$('#room-private').checked = !!msg.private;
    const me = msg.players.find(p => p.id === myId);
    this.ready = !!(me && me.ready);
    // 冒險：一排名單（#players）；勝者為王：藍隊 / 紅隊兩欄（#teams）
    this.$('#players').hidden = versus;
    this.teamsBox.hidden = !versus;
    if (versus) this.showTeams(msg, myId);
    else this.showPlayers(msg, myId);
    this.$('#btn-ready').textContent = this.ready ? '取消準備' : '準備';
    const isHost = msg.hostId === myId;
    const startBtn = this.$('#btn-start');
    startBtn.hidden = !isHost;
    // 電腦玩家一直算準備好；勝者為王另外要兩隊都有人（真人或電腦玩家）
    const allReady = msg.players.every(p => p.bot || p.ready);
    const emptyTeam = versus && V.teams.some(t => !msg.players.some(p => p.team === t));
    startBtn.disabled = !allReady || emptyTeam;
    this.setStatus(!isHost ? '等房主開始遊戲'
      : emptyTeam ? '兩隊都要有人才能開始（可以加電腦玩家）'
        : allReady ? '大家都準備好了，可以開始' : '等所有人按準備後就能開始');
  }

  // 冒險房間的名單：房主 / 你、準備了沒，後面補空位到 max
  showPlayers(msg, myId) {
    const list = this.$('#players');
    list.innerHTML = '';
    for (const p of msg.players) {
      const li = document.createElement('li');
      li.className = p.ready ? 'ready' : '';
      const tags = [];
      if (p.id === msg.hostId) tags.push('房主');
      if (p.id === myId) tags.push('你');
      li.innerHTML = `<span class="pname"></span><span class="tags">${tags.join(' · ')}</span><span class="state">${p.ready ? '已準備' : '未準備'}</span>`;
      li.querySelector('.pname').textContent = p.name;
      list.appendChild(li);
    }
    for (let i = msg.players.length; i < msg.max; i++) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '（空位）';
      list.appendChild(li);
    }
  }

  // 勝者為王房間：藍隊 / 紅隊兩欄、每隊 teamSize 個位子（真人在前、電腦玩家在後，照伺服器給的順序）。
  // 每隊第一個空位放按鈕：我在另一隊 →「加入這一隊」、房主 →「＋ 電腦」；其他空位只寫（空位）。電腦玩家房主可以移除
  showTeams(msg, myId) {
    const size = msg.teamSize || V.teamSize;
    const isHost = msg.hostId === myId;
    const me = msg.players.find(p => p.id === myId);
    this.teamsBox.replaceChildren(...V.teams.map((team) => {
      const name = V.teamNames[team] || team;
      const members = msg.players.filter(p => p.team === team);
      const col = document.createElement('section');
      col.className = `team team-${team}${me && me.team === team ? ' mine' : ''}`;
      const head = document.createElement('div');
      head.className = 'team-head';
      head.innerHTML = '<span class="team-name"></span><span class="team-count"></span>';
      head.querySelector('.team-name').textContent = name;
      head.querySelector('.team-count').textContent = `${members.length} / ${size}`;
      const list = document.createElement('ul');
      list.className = 'team-list';
      for (const p of members) {
        const li = document.createElement('li');
        li.className = `slot${p.ready || p.bot ? ' ready' : ''}${p.id === myId ? ' me' : ''}${p.bot ? ' bot' : ''}`;
        const tags = [];
        if (p.id === msg.hostId) tags.push('房主');
        if (p.id === myId) tags.push('你');
        if (p.bot) tags.push('電腦');
        li.innerHTML = `<div class="slot-top"><span class="pname"></span><span class="state">${p.ready || p.bot ? '已準備' : '未準備'}</span></div>`
          + `<div class="slot-sub"><span class="tags">${tags.join(' · ')}</span></div>`;
        const pname = li.querySelector('.pname');
        pname.textContent = p.name;
        pname.title = p.name;   // 欄位窄，名字長會被截掉
        if (p.bot && isHost) li.querySelector('.slot-sub').appendChild(slotButton('移除', { act: 'removeBot', id: p.id }, `移除${p.name}`));
        list.appendChild(li);
      }
      for (let i = members.length; i < size; i++) {
        const li = document.createElement('li');
        li.className = 'slot empty';
        const btns = [];
        if (i === members.length) {
          if (me && me.team && me.team !== team) btns.push(slotButton('加入這一隊', { act: 'team', team }, `換到${name}`));
          if (isHost) btns.push(slotButton('＋ 電腦', { act: 'addBot', team }, `在${name}加一個電腦玩家`));
        }
        if (btns.length) li.append(...btns);
        else li.textContent = '（空位）';
        list.appendChild(li);
      }
      col.append(head, list);
      return col;
    }));
  }

  showMenu() {
    this.root.hidden = false;
    this.menu.hidden = false;
    this.room.hidden = true;
    this.inRoom = false;
    this.setStatus('');
  }

  hide() { this.root.hidden = true; }
}
