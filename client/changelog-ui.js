import { VERSION, CHANGELOG, CHANGE_TYPES, versionLabel } from '../shared/version.js';

// 大廳下方的版本號與版本履歷（DOM）：直接條列每一版改了什麼，按「收合」把整塊收起來。內容在 shared/version.js。
// 每個版本也能各自點開 / 收起（最新的預設展開）。記在 localStorage（per 瀏覽器）：
// - sh_changelog_collapsed = 收合時的版本：出了新版本會自動再展開
// - sh_seen_version = 看過的版本：沒看過的新版本標 NEW（看到這一次後就不再標）
const COLLAPSED_KEY = 'sh_changelog_collapsed';
const SEEN_KEY = 'sh_seen_version';
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class ChangelogUi {
  // lobby = 大廳的 overlay
  constructor(lobby) {
    this.label = versionLabel(VERSION);
    this.box = lobby.querySelector('#changelog');
    this.list = lobby.querySelector('#changelog-list');
    this.btn = lobby.querySelector('#btn-changelog');

    const badge = lobby.querySelector('#version-badge');
    badge.textContent = VERSION.channel;
    badge.hidden = !VERSION.channel;
    lobby.querySelector('#version-label').textContent = this.label;

    const isNew = load(SEEN_KEY) !== this.label;
    save(SEEN_KEY, this.label);
    this.render(isNew);
    this.setCollapsed(load(COLLAPSED_KEY) === this.label);
    this.btn.addEventListener('click', () => {
      const collapsed = !this.collapsed;
      this.setCollapsed(collapsed);
      save(COLLAPSED_KEY, collapsed ? this.label : '');
    });
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.box.classList.toggle('collapsed', collapsed);
    this.list.hidden = collapsed;
    this.btn.textContent = collapsed ? '展開' : '收合';
    this.btn.setAttribute('aria-expanded', String(!collapsed));
  }

  // 每個版本一個可各自收合的區塊（最新的預設展開），裡面照 新增 / 調整 / 修正 條列
  render(isNew) {
    this.list.textContent = '';
    CHANGELOG.forEach((v, i) => {
      const entry = el('details', 'cl-entry');
      entry.open = i === 0;
      const head = el('summary', 'cl-head');
      head.append(el('span', 'cl-ver', versionLabel({ channel: v.channel, number: v.version })));
      if (i === 0) head.append(el('span', isNew ? 'cl-tag new' : 'cl-tag', isNew ? 'NEW' : '目前版本'));
      head.append(el('span', 'cl-date', v.date));
      if (v.title) head.append(el('span', 'cl-title', v.title));
      entry.append(head);
      for (const t of CHANGE_TYPES) {
        const items = v[t.key];
        if (!items || !items.length) continue;
        const group = el('div', `cl-group ${t.key}`);
        group.append(el('span', 'cl-type', t.label));
        const ul = el('ul');
        for (const text of items) ul.append(el('li', '', text));
        group.append(ul);
        entry.append(group);
      }
      this.list.append(entry);
    });
  }
}

// localStorage 可能被擋（無痕、封鎖網站資料）：讀不到就當第一次來，寫不進去就算了
function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
