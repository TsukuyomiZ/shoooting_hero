import { CHAT_MAX, cleanChat, allowChat } from '../shared/social/chat.js';

// 聊天：遊戲中按 Enter（或貼圖列最左邊的 💬）打開輸入框，Enter 送出、Esc 取消；
// 送出的字跟反應貼圖走同一條彈幕軌道（StickerUi.spawnText），所有人都看得到
// 輸入框只在打字時出現（左下角、底部狀態列上方），上面順便列出最近幾則，漏看的彈幕可以回頭看
const HISTORY_KEEP = 20;     // 留幾則
const HISTORY_SHOW = 6;      // 打開時列幾則

const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

export class ChatUi {
  // stickers：StickerUi（借它的圖層、彈幕軌道和 who）；send(msg)：送給伺服器；onOpen()：開始打字時叫（放掉按住的移動鍵）
  constructor(stickers, { send, onOpen }) {
    this.stickers = stickers;
    this.send = send;
    this.onOpen = onOpen;
    this.sent = [];              // 自己最近送出的時間（洗版限制，跟伺服器同一套）
    this.history = [];           // { name, color, text, mine }

    this.box = el('div', 'chat-box');
    this.box.hidden = true;
    this.list = el('div', 'chat-history');
    this.input = el('input', 'chat-input');
    this.input.type = 'text';
    this.input.maxLength = CHAT_MAX;
    this.input.placeholder = '說點什麼…（Enter 送出、Esc 取消）';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.box.append(this.list, this.input);
    stickers.layer.append(this.box);

    this.btn = el('button', 'sticker-btn chat-btn');
    this.btn.type = 'button';
    this.btn.title = '聊天（Enter）';
    this.btn.tabIndex = -1;
    this.btn.textContent = '💬';
    this.btn.addEventListener('mousedown', (ev) => ev.preventDefault());
    this.btn.addEventListener('click', () => this.open());
    stickers.bar.prepend(this.btn);

    this.input.addEventListener('keydown', (ev) => {
      if (ev.isComposing || ev.keyCode === 229) return;   // 注音 / 拼音選字中的 Enter 是選字，不是送出
      if (ev.key === 'Enter') { ev.preventDefault(); this.submit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); this.input.value = ''; this.close(); }
    });
    this.input.addEventListener('blur', () => this.close());   // 點回戰場就收起來（打到一半的字留著）

    window.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !this.box.hidden || this.stickers.bar.hidden) return;
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      ev.preventDefault();
      this.open();
    });
  }

  get isOpen() { return !this.box.hidden; }

  open() {
    if (this.stickers.bar.hidden) return;
    if (this.onOpen) this.onOpen();
    this.renderHistory();
    this.box.hidden = false;
    this.input.classList.remove('blocked');
    this.input.focus();
  }

  close() {
    if (this.box.hidden) return;
    this.box.hidden = true;
    this.input.blur();
  }

  submit() {
    const text = cleanChat(this.input.value);
    if (!text) { this.input.value = ''; this.close(); return; }
    if (!allowChat(this.sent, Date.now())) {   // 洗版：輸入框抖一下，字留著等一下再送
      this.input.classList.remove('blocked');
      void this.input.offsetWidth;
      this.input.classList.add('blocked');
      return;
    }
    this.input.value = '';
    this.close();
    this.receive(this.stickers.myId, text);   // 自己先播，不等來回
    this.send({ t: 'chat', text });
  }

  // 收到別人的訊息（或自己剛送的）：飄一則彈幕、記進最近的訊息
  receive(from, raw) {
    const text = cleanChat(raw);
    if (!text) return;
    const { name, color } = this.stickers.who(from);
    this.history.push({ name, color, text, mine: from === this.stickers.myId });
    if (this.history.length > HISTORY_KEEP) this.history.shift();
    this.stickers.spawnText(from, text);
    if (this.isOpen) this.renderHistory();
  }

  renderHistory() {
    this.list.replaceChildren(...this.history.slice(-HISTORY_SHOW).map(h => {
      const line = el('div', 'chat-line');
      if (h.mine) line.classList.add('mine');
      const who = el('span', 'chat-name');
      who.textContent = h.name;
      who.style.color = h.color;
      const words = el('span');
      words.textContent = h.text;
      line.append(who, words);
      return line;
    }));
    this.list.hidden = !this.history.length;
  }
}
