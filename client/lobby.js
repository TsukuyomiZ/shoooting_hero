// 大廳畫面（DOM）：暱稱、建房（公開 / 私人）/ 公開房間列表 / 輸入房號加入 / 單人、房間內的準備與開始
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

    this.$('#btn-solo').addEventListener('click', () => this.guard(() => this.h.onSolo(this.name())));
    this.$('#btn-create').addEventListener('click', () => this.guard(() => this.h.onCreate(this.name(), this.$('#create-private').checked)));
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
  }

  name() {
    return this.nameInput.value.trim().slice(0, 12) || '玩家';
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
      btn.innerHTML = `<span class="rcode"></span><span class="rhost"></span><span class="rcount"></span><span class="rstate${btn.disabled ? ' busy' : ''}"></span>`;
      btn.querySelector('.rcode').textContent = r.code;
      btn.querySelector('.rhost').textContent = `${r.host} 的房間`;
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
    const label = this.$('#privacy-label');
    label.textContent = msg.private ? '私人房間' : '公開房間';
    label.classList.toggle('private', !!msg.private);
    this.$('#room-hint').textContent = msg.private ? '只能輸入房號加入，把房號告訴朋友' : '大廳看得到，也能輸入房號加入';
    this.$('#privacy-toggle').hidden = !isHostNow;
    this.$('#room-private').checked = !!msg.private;
    const me = msg.players.find(p => p.id === myId);
    this.ready = !!(me && me.ready);
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
    this.$('#btn-ready').textContent = this.ready ? '取消準備' : '準備';
    const isHost = msg.hostId === myId;
    const startBtn = this.$('#btn-start');
    startBtn.hidden = !isHost;
    startBtn.disabled = !msg.players.every(p => p.ready);
    this.setStatus(isHost ? (msg.players.every(p => p.ready) ? '大家都準備好了，可以開始' : '等所有人按準備後就能開始') : '等房主開始遊戲');
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
