// 測試共用：照客戶端的方式重播一波（shared/volley.js 的 replayVolley，跟 GameView 播的是同一份程式），停在套伺服器 results 之前。
// 每個事件順便檢查「客戶端自己推進到的位置」（made.before）跟伺服器的撞擊點對得上：
//   飛行中的事件：離撞擊點不超過一幀的飛行距離 + 2px（出發點錯了就會差很多）
//   迴力鏢接住（catch）：位置完全一樣（回程沿原路 + 追到手上，兩邊算的路徑一致）
//   迴力鏢回程中的其他事件：
//     回程打到人（pierce）：伺服器在「這一幀從哪裡走到哪裡」那一段上掃到的點（weapons.js sweepReturn），客戶端不校正、照原路走；
//       所以那一點要落在客戶端自己這一幀走的那一段上：從上一幀結束的位置（trail 最後一點 = 這一幀出發的地方）到現在的位置。
//       比「離現在的位置一步以內」更嚴：回程速度、原路的點、追手的方向哪一個兩邊算得不一樣，點就不會剛好在線段上
//     其他（地圖機制的 pass、超時的 out）：伺服器寫的是這一幀結束的位置，重播會校正到那裡：位置要完全一樣（不然校正會把迴力鏢拉離原路）
// drift（結構上對不起來：跳過的事件、不認得的角色…）不是空的、或沉降不是剛好 S 幀（settle）就丟錯
import { CONFIG } from '../shared/config.js';
import { replayVolley } from '../shared/volley.js';

const SEG_EPS = 1e-6;   // 線段上的點：伺服器用 x0 + dx × k / n 算，只差浮點數的捨入

// 點 (x, y) 到線段 a → b 的距離
function segDist(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
  return Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
}

export function reachAndCatch(ev, p, { before: b }) {
  const same = Math.abs(b.x - ev.x) < 1e-9 && Math.abs(b.y - ev.y) < 1e-9;
  if (ev.type === 'catch') {
    if (!same) throw new Error(`client boomerang return path differs from the server at f${ev.f}`);
  } else if (b.state === 'flying') {
    const reach = Math.hypot(b.vx, b.vy) * CONFIG.FIXED_DT + 2;
    const off = Math.hypot(b.x - ev.x, b.y - ev.y);
    if (!(off <= reach)) throw new Error(`client projectile #${ev.p} is ${off.toFixed(1)}px from the server event at f${ev.f} (max ${reach.toFixed(1)})`);
  } else if (b.state === 'returning') {
    if (ev.type === 'pierce') {
      const start = p.trail[p.trail.length - 1];   // 上一幀結束的位置（尾跡在事件之後才記，這一幀的還沒記）
      const off = segDist(ev.x, ev.y, start, b);
      if (!(off <= SEG_EPS)) {
        throw new Error(`client boomerang #${ev.p} return-leg hit at f${ev.f} is ${off.toFixed(3)}px off the client's return step ` +
          `(${start.x.toFixed(1)},${start.y.toFixed(1)} → ${b.x.toFixed(1)},${b.y.toFixed(1)}; server ${ev.x.toFixed(1)},${ev.y.toFixed(1)})`);
      }
    } else if (!same) {
      throw new Error(`client boomerang #${ev.p} is ${Math.hypot(b.x - ev.x, b.y - ev.y).toFixed(3)}px from the server's ${ev.type} on the return leg at f${ev.f}`);
    }
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
