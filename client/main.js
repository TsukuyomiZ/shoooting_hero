import { CONFIG } from '../shared/config.js';
import { GameView } from './game-view.js';
import { Lobby } from './lobby.js';
import { WsTransport, LocalTransport } from './net.js';
import { CardsUi } from './cards-ui.js';
import { StickerUi } from './stickers.js';
import { SettingsUi } from './settings-ui.js';
import { SummaryUi } from './summary-ui.js';
import { ChangelogUi } from './changelog-ui.js';

const canvas = document.getElementById('game');
const view = new GameView(canvas);
window.view = view;   // 方便在 console 調試

let transport = null;
let myId = null;
const cardsUi = new CardsUi(document.getElementById('cards'), (cardId, discard, teammate) => transport && transport.send({ t: 'pick', cardId, discard, link: teammate }));
const stickers = new StickerUi(canvas, {
  send: (msg) => transport && transport.send(msg),
  who: (id) => {
    const p = view.players.find(x => x.id === id);
    const e = view.match && view.match.byId(id);
    return { name: p ? p.name : '?', color: (e && e.color) || '#fff' };
  },
});

const settings = new SettingsUi(canvas);   // 右上角的音量設定
const summaryUi = new SummaryUi(document.getElementById('summary'));   // 冒險結束的結算畫面
new ChangelogUi(document.getElementById('lobby'));   // 大廳下方的版本號與版本履歷

const lobby = new Lobby(document.getElementById('lobby'), {
  onSolo(name) {
    if (transport) transport.close();   // 看大廳列表用的連線用不到了
    transport = new LocalTransport();
    attach(transport);
    transport.start(name);
    lobby.hide();
  },
  // 暱稱跟著送：連上大廳之後才改的名字也要算數
  async onCreate(name, isPrivate) {
    await connect(name);
    transport.send({ t: 'create', name, private: isPrivate });
  },
  // via：code = 輸入房號、list = 從大廳列表點的（只用來記錄）
  async onJoin(name, code, via) {
    await connect(name);
    transport.send({ t: 'join', code, name, via });
  },
  onRetryBrowse() { browse(); },
  onPrivacy(isPrivate) { if (transport) transport.send({ t: 'privacy', private: isPrivate }); },
  onReady(ready) { if (transport) transport.send({ t: 'ready', ready }); },
  onStart() { if (transport) transport.send({ t: 'start' }); },
  onLeave() {
    if (transport) transport.send({ t: 'leave' });
    sessionStorage.removeItem('sh_token');
    location.reload();
  },
});

// 連線中再呼叫（例如大廳正在連、玩家就按了建立房間）共用同一個連線，不會開第二條
let connecting = null;
function connect(name) {
  if (transport instanceof WsTransport && transport.connected) return Promise.resolve();
  if (connecting) return connecting;
  if (transport) transport.close();
  transport = new WsTransport();
  attach(transport);
  connecting = transport.connect(name).then((welcome) => {
    myId = welcome.id;
    view.myId = myId;
  }).finally(() => { connecting = null; });
  return connecting;
}

// 打開大廳列表：連上伺服器後由 welcome 送 browse（斷線重連回來也會再送）；連不上就顯示重試
function browse() {
  lobby.setBrowseState('connecting');
  connect(lobby.name()).catch(() => { if (!lobby.inRoom) lobby.setBrowseState('offline'); });
}

let staleAlerted = false;

function attach(t) {
  t.onMessage((msg) => {
    switch (msg.t) {
      case 'welcome':
        myId = msg.id;
        view.myId = msg.id;
        stickers.myId = msg.id;
        if (msg.stale && !staleAlerted) {   // 伺服器還跑著舊版程式碼：兩邊對不上，一定要重啟
          staleAlerted = true;
          alert('伺服器啟動後程式碼有更新，但伺服器還在跑舊版——射擊和血量都會對不上。\n請把伺服器關掉重開，再重新整理頁面。');
        }
        // 還在大廳選單（不是接回原本的房間 / 遊戲）→ 看公開房間列表
        if (!msg.rejoined && t instanceof WsTransport && !lobby.inRoom && !view.started) {
          lobby.showError('');
          t.send({ t: 'browse', on: true });
        }
        break;
      case 'rooms':
        lobby.showRooms(msg.rooms);
        break;
      case 'lobby':
        lobby.showRoom(msg, myId);
        break;
      case 'error':
        lobby.showError(msg.msg);
        break;
      case 'start':
        lobby.hide();
        cardsUi.hide();
        stickers.show();
        settings.show();
        break;
      case 'state':
        // 重連回一場已經結束的冒險：清掉 token，回大廳
        // （先離開那個房間，伺服器才會給大廳列表）
        if (msg.runPhase === 'over') {
          sessionStorage.removeItem('sh_token');
          lobby.showMenu();
          t.send({ t: 'leave' });
          t.send({ t: 'browse', on: true });
          break;
        }
        lobby.hide();
        stickers.show();
        settings.show();
        if (msg.runPhase === 'pick' && msg.offers && msg.offers.length) {
          cardsUi.show({
            stage: msg.run.stage, stageCount: msg.run.stageCount, offers: msg.offers, pickTime: msg.pickTimeLeft, players: msg.players, myId, picked: msg.picked,
            weapons: msg.weapons || [], linkTargets: msg.linkTargets || [], links: msg.links || {},
          });
        }
        break;
      case 'stageClear':
        cardsUi.show({
          stage: msg.stage, stageCount: msg.stageCount, offers: msg.offers[myId] || [], pickTime: msg.pickTime, players: view.players, myId,
          weapons: (msg.weapons && msg.weapons[myId]) || [], linkTargets: (msg.linkTargets && msg.linkTargets[myId]) || [], links: msg.links || {},
        });
        break;
      case 'picked':
        cardsUi.setPicked(msg.playerId, msg.link || null);
        break;
      case 'sticker':
        stickers.spawn(msg.from, msg.id);
        break;
      case 'picks':
        cardsUi.hide();
        break;
      case 'runOver':
        cardsUi.hide();
        summaryUi.show(msg, { myId: view.myId, isBoss: !!(view.stageInfo && view.stageInfo.isBoss) });
        sessionStorage.removeItem('sh_token');   // 之後按 R 重新整理會回到大廳，而不是重連進已結束的冒險
        break;
      case 'disconnected':
        if (view.started) view.showBanner('與伺服器斷線，重連中…', '#f87171');
        else if (lobby.inRoom) lobby.showError('與伺服器斷線');
        else lobby.setBrowseState('connecting');   // 大廳選單：會自己重連，回來再拿列表
        break;
    }
  });
  view.attach(t);
}

// 重新整理後如果還有 token，先試著回到原本的房間 / 遊戲
// 沒有 token 就直接連上大廳看公開房間列表
if (sessionStorage.getItem('sh_token')) {
  connect(lobby.name()).catch(() => { sessionStorage.removeItem('sh_token'); lobby.showMenu(); lobby.setBrowseState('offline'); });
} else {
  browse();
}

// 固定步長主迴圈；rAF 在背景分頁 / 內嵌視窗可能不觸發，用計時器當備援
const STEP = CONFIG.FIXED_DT;
let last = performance.now();
let lastTick = last;
let acc = 0;
function tick(now) {
  lastTick = now;
  acc += Math.min(0.1, (now - last) / 1000);
  last = now;
  while (acc >= STEP) {
    // 每一步 = 真實時間 STEP 秒：先照真實時間開關慢動作、扣體力（決定 timeScale），
    // 慢動作時這一步的 dt 跟著縮小（一樣每秒 60 步，畫面才順）；平常、播事件腳本時 timeScale 一定是 1
    view.frame(STEP);
    view.update(STEP * view.timeScale);
    acc -= STEP;
  }
  view.render();
}
function loop(now) { tick(now); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
setInterval(() => { const now = performance.now(); if (now - lastTick > 100) tick(now); }, 33);
