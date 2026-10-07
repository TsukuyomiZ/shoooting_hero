import { CONFIG } from '../config.js';
import { makeProjectile } from '../projectile.js';

// 無差別轟炸：持有者附近以外，整張地圖每隔 spacing 落下一發飛彈（由近到遠）。
// 會波及隊友（照一般誤傷規則），但炸不到持有者自己；飛彈數值在 CONFIG.WEAPONS.bombard（fromEquip：不吃武器傷害加成）、
// 落點在 CONFIG.EQUIP.bombard。回傳跟一般開火同樣格式的結果（kind: 'bombard'，不帶 actor：射手不用擺位置）
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
    const p = makeProjectile(owner, weapon, x, B.startY, 0, weapon.speed);
    p.spawn = 1 + k * B.gapFrames;
    p.ignore.add(owner);
    return p;
  });
  return { kind: 'bombard', actorId: owner.id, weapon: weapon.id, ...match.resolveVolley(owner, weapon, projs, 0) };
}

// 自己的回合開始時（輪到他之後、開始計時之前）轟炸一次（turnBegin 回傳結算的函式，裁判照時機呼叫）
export const bombard = {
  id: 'bombard',
  keys: { bombard: '自己的回合開始時，自己以外的區域落下轟炸飛彈（填 1）' },
  turnBegin: (match, e) => (e.mods.bombard > 0 ? () => resolveBombard(match, e) : null),
  actions: { resolveBombard },   // Match.resolveBombard：不看有沒有這張牌、直接轟炸一次（測試與工具用）
  chipOrder: 90,
  chip: (e) => (e.mods.bombard > 0 ? ['無差別轟炸', '#fb7185'] : null),
  volley: { kind: 'bombard', banner: (name) => `${name} 的無差別轟炸！`, color: '#fb7185' },
};
