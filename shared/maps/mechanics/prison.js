import {
  buildPrison, planExecNext, shieldsPrisoner, resolveExecTurn, resolveBeastTurn, isBeast, syncHolds, syncPerch, syncRelease, prisonAttackMult, prisonDefense,
  struckPrison, pickSinner, releaseHug, prisonState, prisonEventExtras, replayPrison, prisonSnapshot, restorePrison,
} from '../prison.js';

// 處刑監獄（Boss 關）的地圖機制：處刑官、三隻猛獸、囚籠、天花板的吊燈（規則在 prison.js）。
// 狀態在 match.mechState（buildPrison 建的，欄位見 prison.js 開頭）
export const prison = {
  type: 'prison',

  // 處刑官的血量照 Boss 的倍率；之後放出來的猛獸、囚籠照一般敵人的倍率（記在狀態的 hpScale）。回傳這一場的狀態
  build(match, scales) {
    return buildPrison(match, scales);
  },

  // 先挑罪人（2026-10-28 使用者：開場隨機挑一個，所有攻擊都先打他）、抽王的第一招（要丟菜刀 / 關誰，第一個玩家回合就標出來）
  ready(match) {
    pickSinner(match);
    planExecNext(match);
  },

  // 一波結算完：囚籠被打破、被關的人倒下 → 放出來；熊 / 被抱的人倒下了 → 放開；放出來的猛獸倒下了 → 處刑官馬上跳下處刑台（都可以重複呼叫）。
  // 平常打倒猛獸的那一下就跳了（eventExtras），這裡是保險（沒有事件就倒下的）：跳下來的話這一波的結果帶 descend（紀錄照它記；客戶端照同一個條件自己推）。
  // 跳上去放猛獸不在這裡做：Match.result() 也會叫 cascade，那時候跳上去客戶端不會知道（放出來的猛獸要照伺服器的出生資料建）；
  // 打到門檻的那一下（eventExtras）、回合結束被燒到門檻（turnEnd）都當下就跳了，其他沒想到的情況留到他的回合補一招（客戶端看得到）
  cascade(match) {
    syncHolds(match);
    const descend = syncPerch(match);
    return descend ? { descend } : null;
  },

  // 回合結束（燃燒之後）：熊 / 被熊抱住的人被燒死 → 放開；猛獸在自己的回合結束被燒死 → 處刑官馬上跳下處刑台；
  // 處刑官在自己的回合結束被燒到門檻 → 馬上跳上去放出下一隻；罪人倒下了 → 隨機挑新的罪人
  // （記進 turn.end 的 fx；客戶端的 turnFx 照它放開、畫弧線、照出生資料放出猛獸、換罪人）
  turnEnd(match, e, fx) {
    const S = prisonState(match);
    if (S && S.hug && [S.hug.bearId, S.hug.victimId].some(id => { const x = match.byId(id); return !x || !x.alive; })) {
      const gone = releaseHug(match, 'dead');
      fx.push({ type: 'unhug', ...gone, id: gone.targetId, bearId: gone.id });
    }
    const jump = syncPerch(match);
    if (jump) fx.push({ type: 'descend', id: 'executioner', ...jump });
    const release = syncRelease(match);
    if (release) fx.push({ type: 'release', id: 'executioner', ...release });
    const mark = pickSinner(match);
    if (mark) fx.push({ type: 'sinner', ...mark });
  },

  // 被關在籠子裡（被熊抱住）的人開火一定打在籠子（熊）上：那一下的爆炸傷不到他自己（不扣血、不擊退）
  absorbHit(match, e, { attacker }) {
    return shieldsPrisoner(e, attacker);
  },

  // 處刑官被打越多下武器傷害越高；被皮鞭鞭過的猛獸下一次攻擊加成
  attackMult(match, attacker) {
    return prisonAttackMult(match, attacker);
  },

  // 哭的處刑官受到的傷害變多
  defenseMult(match, e) {
    return prisonDefense(match, e);
  },

  // 打到 / 炸到天花板的吊燈就掉下來（接著飛的 adds）
  struck(match, owner, at) {
    return struckPrison(match, owner, at);
  },

  // 掉下來的吊燈砸到的敵人暈眩一回合（事件的 stuns）；熊被打夠了 / 被砸暈 → 放開抱住的人（事件的 hugDmg、unhug）；
  // 這一下打倒了放出來的猛獸 → 處刑官馬上跳下處刑台（事件的 descend，
  // 同一波後面的砲彈就打得到他；客戶端重播到這一下照同一個條件推）
  eventExtras(match, info) {
    return prisonEventExtras(match, info);
  },

  replayEvent(match, ev) {
    replayPrison(match, ev);
    return null;
  },

  // 輪到處刑官 / 猛獸：出招並直接結算好（囚籠不會輪到）
  aiTurn(match, actor) {
    if (actor.kind === 'executioner') return resolveExecTurn(match, actor);
    if (isBeast(actor)) return resolveBeastTurn(match, actor);
    return null;
  },

  // 牢房開了幾間、王在不在台上、心情、預定的下一招、放出來的角色、囚籠、暈眩、掉下來的吊燈…（全部包在 prison 一個欄位裡）
  snapshot(match) {
    return prisonSnapshot(match);
  },

  restore(match, s) {
    restorePrison(match, s);
  },
};
