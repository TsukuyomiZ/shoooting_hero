// 武器的畫法（不分地圖、不分誰拿）。Renderer.drawWeapon 沒有內建畫法的武器照 HELD_ART 畫：
// 在角色座標系裡、已經轉到瞄準角度（見 Renderer.drawWeapon）

// 長矛（樹妖投擲的那把；飛出去的長矛也用同一個畫法）
export function drawSpearHeld(ctx) {
  ctx.fillStyle = '#7c5a3a';
  ctx.fillRect(-10, -1.5, 34, 3);
  ctx.fillStyle = '#d6d3d1';
  ctx.beginPath(); ctx.moveTo(24, -4); ctx.lineTo(33, 0); ctx.lineTo(24, 4); ctx.closePath(); ctx.fill();
}

// 武器 id → 拿在手上的畫法（沒有 prototype：HELD_ART[id] 查不到 constructor 之類繼承來的東西）
export const HELD_ART = Object.freeze({
  __proto__: null,
  treeSpear: drawSpearHeld,
});
