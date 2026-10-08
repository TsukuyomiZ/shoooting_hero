// 武器的畫法（不分地圖、不分誰拿）。Renderer.drawWeapon 沒有內建畫法的武器照 HELD_ART 畫：
// 在角色座標系裡、已經轉到瞄準角度（見 Renderer.drawWeapon）

// 長矛（樹妖投擲的那把；飛出去的長矛也用同一個畫法）
export function drawSpearHeld(ctx) {
  ctx.fillStyle = '#7c5a3a';
  ctx.fillRect(-10, -1.5, 34, 3);
  ctx.fillStyle = '#d6d3d1';
  ctx.beginPath(); ctx.moveTo(24, -4); ctx.lineTo(33, 0); ctx.lineTo(24, 4); ctx.closePath(); ctx.fill();
}

// 飛鏢：手上捏著一支（鏢身、金色鏢頭、綠色尾羽）
function drawDartsHeld(ctx) {
  ctx.strokeStyle = '#d6d3d1';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(4, 0); ctx.lineTo(18, 0); ctx.stroke();
  ctx.fillStyle = '#ffe066';
  ctx.beginPath(); ctx.moveTo(18, -2.5); ctx.lineTo(25, 0); ctx.lineTo(18, 2.5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#4ade80';
  ctx.beginPath(); ctx.moveTo(7, 0); ctx.lineTo(1, -5); ctx.lineTo(3, 0); ctx.lineTo(1, 5); ctx.closePath(); ctx.fill();
}

// 高壓水炮：背在手上的水槽＋粗短的噴嘴
function drawWaterCannonHeld(ctx) {
  ctx.fillStyle = '#0369a1';
  ctx.beginPath(); ctx.arc(-2, 0, 7, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#7dd3fc';
  ctx.beginPath(); ctx.arc(-2, -1.5, 3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#475569';
  ctx.fillRect(3, -4, 18, 8);
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(20, -5.5, 5, 11);
}

// 武器 id → 拿在手上的畫法（沒有 prototype：HELD_ART[id] 查不到 constructor 之類繼承來的東西）
export const HELD_ART = Object.freeze({
  __proto__: null,
  treeSpear: drawSpearHeld,
  darts: drawDartsHeld,
  waterCannon: drawWaterCannonHeld,
});
