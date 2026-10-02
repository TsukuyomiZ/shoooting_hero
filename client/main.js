import { CONFIG } from '../shared/config.js';
import { GameView } from './game-view.js';
import { Lobby } from './lobby.js';
import { WsTransport, LocalTransport } from './net.js';
import { CardsUi } from './cards-ui.js';
import { StickerUi } from './stickers.js';
import { SettingsUi } from './settings-ui.js';

const canvas = document.getElementById('game');
const view = new GameView(canvas);
window.view = view;   // 方便在 console 調試

let transport = null;
let myId = null;
const cardsUi = new CardsUi(document.getElementById('cards'), (cardId, discard, link) => transport && transport.send({ t: 'pick', cardId, discard, link }));
const stickers = new StickerUi(canvas, {
  send: (msg) => transport && transport.send(msg),
  who: (id) => {
    const p = view.players.find(x => x.id === id);
    const e = view.match && view.match.byId(id);
    return { name: p ? p.name : '?', color: (e && e.color) || '#fff' };
  },
});

const settings = new SettingsUi(canvas);   // 右上角的音量設定

const lobby = new Lobby(document.getElementById('lobby'), {
  onSolo(name) {
    transport = new LocalTransport();
    attach(transport);
    transport.start(name);
    lobby.hide();
  },
  async onCreate(name) {
    await connect(name);
    transport.send({ t: 'create' });
  },
  async onJoin(name, code) {
    await connect(name);
    transport.send({ t: 'join', code });
  },
  onReady(ready) { if (transport) transport.send({ t: 'ready', ready }); },
  onStart() { if (transport) transport.send({ t: 'start' }); },
  onLeave() {
    if (transport) transport.send({ t: 'leave' });
    sessionStorage.removeItem('sh_token');
    location.reload();
  },
});

async function connect(name) {
  if (transport instanceof WsTransport && transport.connected) return;
  if (transport) transport.close();
  transport = new WsTransport();
  attach(transport);
  const welcome = await transport.connect(name);
  myId = welcome.id;
  view.myId = myId;
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
        if (msg.runPhase === 'over') { sessionStorage.removeItem('sh_token'); lobby.showMenu(); break; }
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
        sessionStorage.removeItem('sh_token');   // 之後按 R 重新整理會回到大廳，而不是重連進已結束的冒險
        break;
      case 'disconnected':
        if (view.started) view.showBanner('與伺服器斷線，重連中…', '#f87171');
        else lobby.showError('與伺服器斷線');
        break;
    }
  });
  view.attach(t);
}

// 重新整理後如果還有 token，先試著回到原本的房間 / 遊戲
if (sessionStorage.getItem('sh_token')) {
  connect(lobby.name()).catch(() => { sessionStorage.removeItem('sh_token'); lobby.showMenu(); });
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
    view.update(STEP);
    acc -= STEP;
  }
  view.render();
}
function loop(now) { tick(now); requestAnimationFrame(loop); }
requestAnimationFrame(loop);
setInterval(() => { const now = performance.now(); if (now - lastTick > 100) tick(now); }, 33);
