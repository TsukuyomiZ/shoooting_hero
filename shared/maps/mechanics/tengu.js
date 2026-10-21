import { CONFIG } from '../../core/config.js';
import { buildTengu, planTenguNext, resolveTenguTurn, startHazards, stepHazards, finishHazards } from '../tengu.js';

// 天狗（山頂的菁英關）的地圖機制：天狗的規則在 tengu.js。
// 狀態在 match.mechState（buildTengu 建的：{ def, next, hover, flying, flyingTurn, seq, roam }，next = 預定的下一招、hover = 浮著幾根羽毛、
// flying = 這個玩家回合還在飛的羽毛、roam = 在天上飄的範圍（預定羽刃時不飄））
export const tengu = {
  type: 'tengu',

  // 天狗的血量照一般敵人的倍率（人數 × 關數）。回傳這一場的狀態。
  // 天狗每回合出招前在天上飄一段（level.mechanic.roam 的框框，Match.planAiTurn 的 planGlide；速度 / 邊距沒寫用預設）
  build(match, { hpScale }) {
    const state = buildTengu(match, hpScale);
    const g = match.byId('tengu');
    const R = match.level.mechanic.roam;
    if (g && R) g.roam = state.roam = { x0: R.x0, x1: R.x1, y0: R.y0, y1: R.y1, speed: R.speed ?? 90, pad: R.pad ?? 6, chance: R.chance ?? 1 };
    return state;
  },

  // 開場：羽毛先撒好一整輪（第一個玩家回合就會射），再抽第一招
  ready(match) {
    match.mechState.hover = CONFIG.TENGU.feathers;
    planTenguNext(match);
  },

  // 玩家的回合開始：浮著的羽毛射出幾根；回合中照時間推進、碰到人就打；回合收尾：還沒飛完的一口氣射完
  hazardStart(match, e, now) {
    return startHazards(match, e, now);
  },
  hazardStep(match, now) {
    return stepHazards(match, now);
  },
  hazardFinish(match) {
    return finishHazards(match);
  },

  // 輪到天狗：預定的那一招（羽刃 / 風彈），直接結算好
  aiTurn(match, actor) {
    return actor.part === 'tengu' ? resolveTenguTurn(match, actor) : null;
  },

  // 預定的下一招、浮著幾根羽毛、還在飛的羽毛（{ id, x, y, vx, vy }：伺服器上次判定到的地方，重連的畫面從那裡接著飛；
  // 還沒出發的多帶 wait = 還要等幾秒（照上次推進的裁判時鐘算，差不到 50 ms）；沒有 = []）
  snapshot(match) {
    const S = match.mechState;
    return {
      tenguNext: S.next ? { ...S.next } : null,
      tenguHover: S.hover,
      tenguFlying: S.flying.filter(f => !f.done).map(f => ({
        id: f.id, x: f.x, y: f.y, vx: f.vx, vy: f.vy, ...(f.t0 > S.clock ? { wait: (f.t0 - S.clock) / 1000 } : {}),
      })),
    };
  },

  // 客戶端（重連、開場）：還在飛的羽毛只留畫面要的（判定只在伺服器）
  restore(match, s) {
    const S = match.mechState;
    if (s.tenguNext !== undefined) S.next = s.tenguNext ? { ...s.tenguNext } : null;
    if (Number.isFinite(s.tenguHover)) S.hover = s.tenguHover;
    if (Array.isArray(s.tenguFlying)) S.flying = s.tenguFlying.map(f => ({ ...f, x0: f.x, y0: f.y }));   // 出發點 = 現在的地方（t0 等畫面第一次 update 再設）
  },
};
