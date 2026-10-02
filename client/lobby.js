// 大廳畫面（DOM）：暱稱、建房 / 加入 / 單人、房間內的準備與開始
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
    this.$('#btn-create').addEventListener('click', () => this.guard(() => this.h.onCreate(this.name())));
    this.$('#btn-join').addEventListener('click', () => {
      const code = this.codeInput.value.trim().toUpperCase();
      if (code.length < 4) return this.showError('請輸入 4 碼房號');
      this.guard(() => this.h.onJoin(this.name(), code));
    });
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
    for (const btn of this.menu.querySelectorAll('button')) btn.disabled = b;
    this.setStatus(b ? '連線中…' : '');
  }

  setStatus(s) { this.status.textContent = s; }
  showError(s) { this.error.textContent = s; }

  // 收到 lobby 訊息：切到房間畫面並更新名單
  showRoom(msg, myId) {
    this.root.hidden = false;
    this.menu.hidden = true;
    this.room.hidden = false;
    this.$('#room-code').textContent = msg.code;
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
    this.setStatus('');
  }

  hide() { this.root.hidden = true; }
}
