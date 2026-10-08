// 飛行物。伺服器結算、客戶端重播、瞄準預覽與 AI 模擬都用同一個形狀。
// 單獨一個檔案、不 import 任何東西：效果（shared/effects/，例如無差別轟炸）也要建飛行物，
// 而 weapons.js 要問效果的登記表（彈射、穿透），放在 weapons.js 裡會變成循環 import。weapons.js 照樣匯出它
export function makeProjectile(owner, weapon, x, y, vx, vy) {
  return {
    owner, weapon, x, y, vx, vy,
    gravity: weapon.gravity, hitRadius: weapon.hitRadius, age: 0,
    // 不會再撞到的角色（已經穿透過的、轟炸的持有者；迴力鏢與 passOwner 的武器（獨眼巨人的巨石）一開始就有丟的人：打不到自己）
    ignore: new Set((weapon.boomerang || weapon.passOwner) && owner ? [owner] : []),
    bouncesLeft: 0,                 // 還能在地形上彈射幾次（哈哈子彈、蹦蹦炸彈）
    pierce: !!weapon.pierce,        // 穿透角色（高倍率望遠鏡、古樹的攻擊）
    passTerrain: !!weapon.passTerrain,  // 穿過地形（古樹的攻擊）
    passAllies: !!weapon.passAllies,    // 穿過射手的隊友（古樹與樹妖的攻擊不會打到自己人；迴力鏢）
    boomerang: !!weapon.boomerang,  // 飛到最長路徑（或撞到地形 / 落水 / 飛出場外）就沿原路飛回來
    range: weapon.range ?? Infinity,  // 最長飛多遠（路徑長度；看力量的由開火的地方照 shotRange 設），dist = 已經飛了多遠
    dist: 0,
    leftOwner: false,               // 已經離開過射手的身體（之後才打得到他）
  };
}
