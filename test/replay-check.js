// 測試共用：照客戶端的方式重播一波（shared/volley.js 的 replayVolley，跟 GameView 播的是同一份程式），停在套伺服器 results 之前。
// 每個事件順便檢查「客戶端自己推進到的位置」（made.before）跟伺服器的撞擊點對得上：
//   飛行中的事件：離撞擊點不超過一幀的飛行距離 + 2px（出發點錯了就會差很多）
//   迴力鏢接住（catch）：位置完全一樣（回程沿原路 + 追到手上，兩邊算的路徑一致）
// drift（結構上對不起來：跳過的事件、不認得的角色…）不是空的、或沉降不是剛好 S 幀（settle）就丟錯
import { CONFIG } from '../shared/config.js';
import { replayVolley } from '../shared/volley.js';

export function reachAndCatch(ev, p, { before: b }) {
  if (ev.type === 'catch') {
    if (!(Math.abs(b.x - ev.x) < 1e-9 && Math.abs(b.y - ev.y) < 1e-9)) throw new Error(`client boomerang return path differs from the server at f${ev.f}`);
  } else if (b.state === 'flying') {
    const reach = Math.hypot(b.vx, b.vy) * CONFIG.FIXED_DT + 2;
    const off = Math.hypot(b.x - ev.x, b.y - ev.y);
    if (!(off <= reach)) throw new Error(`client projectile #${ev.p} is ${off.toFixed(1)}px from the server event at f${ev.f} (max ${reach.toFixed(1)})`);
  }
}

// 重播並檢查；回傳 replay 物件（live / drift）。look 可以再加別的掛勾（event 會在檢查之後呼叫）
export function replayChecked(cm, shot, label = 'replay', look = {}) {
  const run = replayVolley(cm, shot);
  if (!run) throw new Error(`${label}: unknown weapon ${shot.weapon}`);
  const event = look.event;
  const drift = run.run({ ...look, event: (ev, p, made) => { reachAndCatch(ev, p, made); if (event) event(ev, p, made); } });
  if (drift.length) throw new Error(`${label}: replay drift: ${drift.join('; ')}`);
  if (run.settle) throw new Error(`${label}: ${run.settle}`);
  return run;
}
