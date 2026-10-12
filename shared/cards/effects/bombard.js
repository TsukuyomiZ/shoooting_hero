import { CONFIG } from '../../core/config.js';
import { makeProjectile } from '../../physics/projectile.js';

// 無差別轟炸：持有者附近以外，整張地圖每隔 spacing 落下一發飛彈（由近到遠）。
// 會波及隊友（照一般誤傷規則），但炸不到持有者自己；飛彈數值在 CONFIG.WEAPONS.bombard、落點在 CONFIG.EQUIP.bombard。
// 傷害跟持有者自己的其他攻擊一樣吃他的加成（武器傷害、對首領、擊退、吸血；只限大砲 / 狙擊槍的加成不算，見 Match.damageMult）。
// 回傳跟一般開火同樣格式的結果（kind: 'bombard'，不帶 actor：射手不用擺位置）
function resolveBombard(match, owner) {
  const weapon = CONFIG.WEAPONS.bombard;
  const B = CONFIG.EQUIP.bombard;
  const xs = [];
  for (let x = B.spacing / 2; x < CONFIG.WORLD_W; x += B.spacing) {
    const jx = x + match.rng.range(-B.jitter, B.jitter);
    if (Math.abs(jx - owner.x) >= B.safeDist) xs.push(jx);
  }
  xs.sort((a, b) => Math.abs(a - owner.x) - Math.abs(b - owner.x));
  const projs = xs.map((x, k) => {
    // 洞穴這種有天花板的地圖：從天花板下面落下（不然全部炸在天花板上）
    const p = makeProjectile(owner, weapon, x, match.terrain.skyStart(x, B.startY), 0, weapon.speed);
    p.spawn = 1 + k * B.gapFrames;
    p.ignore.add(owner);
    return p;
  });
  return { kind: 'bombard', actorId: owner.id, weapon: weapon.id, ...match.resolveVolley(owner, weapon, projs, 0) };
}

// 自己的回合開始時（輪到他之後、開始計時之前）冷卻好了就轟炸一次（turnBegin 回傳結算的函式，裁判照時機呼叫），
// 之後冷卻 EQUIP.bombard.cooldown 個自己的回合（數法跟時間扭曲一樣：觸發時設成 N、沒觸發的回合減 1、0 = 就緒）：
// 冷卻中的回合開始不轟炸、冷卻減 1，所以 N = 3 是「轟炸 → 跳過 3 個回合 → 再轟炸」。時間扭曲的額外回合也算一個自己的回合
// （會轟炸、也會減冷卻；跟狂戰之斧、神佑之石數的 turnCount 一樣，額外回合本來就會觸發回合開始的效果）。
// 冷卻是這個效果自己的角色狀態 bombardCd（同步欄位 bcd；每關從 0 開始，所以每關第一個自己的回合一定轟炸）
const cooldown = () => CONFIG.EQUIP.bombard.cooldown;
export const bombard = {
  id: 'bombard',
  keys: { bombard: `自己的回合開始時，自己以外的區域落下轟炸飛彈（填 1；之後冷卻 ${CONFIG.EQUIP.bombard.cooldown} 個回合）` },
  state: { bombardCd: { wire: 'bcd' } },
  turnBegin(match, e) {
    if (!(e.mods.bombard > 0)) return null;
    if (e.bombardCd > 0) {
      e.bombardCd--;
      return null;
    }
    return () => {
      e.bombardCd = cooldown();
      return resolveBombard(match, e);
    };
  },
  // 冷卻中跳過的回合：回合開始的 fx 記一筆（LOG 的 turn.start 看得到為什麼沒轟炸、還剩幾回合；畫面不處理）。
  // 剛轟炸完的冷卻一定是 N，比 N 小 = 這回合的 turnBegin 是減冷卻、沒有轟炸
  turnStart(match, e, fx) {
    if (e.mods.bombard > 0 && e.bombardCd < cooldown()) fx.push({ type: 'bombardCd', id: e.id, cd: e.bombardCd });
  },
  actions: { resolveBombard },   // Match.resolveBombard：不看有沒有這張牌、不管冷卻，直接轟炸一次（測試與工具用）
  chipOrder: 90,
  chip: (e) => (e.mods.bombard > 0 ? [e.bombardCd > 0 ? `無差別轟炸 冷卻 ${e.bombardCd}` : '無差別轟炸 就緒', '#fb7185'] : null),
  volley: { kind: 'bombard', banner: (name) => `${name} 的無差別轟炸！`, color: '#fb7185' },
};
