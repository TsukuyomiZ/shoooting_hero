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

// 西洋刺劍：細長的劍身（尖端收細）、碗狀的護手、深色的握柄與柄頭
function drawRapierHeld(ctx) {
  ctx.fillStyle = '#3f2a14';
  ctx.fillRect(-5, -1.5, 8, 3);                       // 握柄
  ctx.fillStyle = '#a8a29e';
  ctx.beginPath(); ctx.arc(-6, 0, 2, 0, Math.PI * 2); ctx.fill();   // 柄頭
  ctx.fillStyle = '#e5e7eb';
  ctx.beginPath(); ctx.moveTo(5, -1.2); ctx.lineTo(36, -0.3); ctx.lineTo(38, 0); ctx.lineTo(36, 0.3); ctx.lineTo(5, 1.2); ctx.closePath(); ctx.fill();   // 劍身
  ctx.fillStyle = '#d4a017';
  ctx.beginPath(); ctx.ellipse(4, 0, 2.5, 5, 0, 0, Math.PI * 2); ctx.fill();   // 護手
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.moveTo(7, -0.4); ctx.lineTo(33, -0.1); ctx.stroke();   // 劍身的反光
}

// 急救槍：白色的槍身、綠色十字、細長的針頭（像一支注射槍）
function drawMedGunHeld(ctx) {
  ctx.fillStyle = '#7c5a3a';
  ctx.fillRect(-6, -1, 7, 6);                          // 握把
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(-4, -4.5, 22, 8);                       // 槍身
  ctx.fillStyle = 'rgba(74,222,128,0.85)';
  ctx.fillRect(6, -3.5, 10, 6);                        // 藥劑艙
  ctx.fillStyle = '#16a34a';
  ctx.fillRect(9.5, -3, 3, 5); ctx.fillRect(8, -1.5, 6, 2);   // 綠色十字
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(18, -1, 10, 2);                         // 針頭
}

// 武器 id → 拿在手上的畫法（沒有 prototype：HELD_ART[id] 查不到 constructor 之類繼承來的東西）
export const HELD_ART = Object.freeze({
  __proto__: null,
  treeSpear: drawSpearHeld,
  darts: drawDartsHeld,
  waterCannon: drawWaterCannonHeld,
  rapier: drawRapierHeld,
  medGun: drawMedGunHeld,
});
