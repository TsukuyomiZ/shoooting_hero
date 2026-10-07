import { CONFIG } from './config.js';
import { Entity } from './entities.js';
import { weightedPick, nearestPlayerAt, bossProjectile, bossShot, stillResult } from './mechanics/common.js';

// Boss 關「叢林巨蟒」的規則（伺服器與客戶端共用；出招只在伺服器算，客戶端照廣播播動畫）。
// Match 什麼時候呼叫這些，見地圖機制 shared/mechanics/snake.js。這一場的狀態（含場上的蛇血）在 match.mechState（buildSnake 建的那一份）。
//
// - 地圖：一條藤蔓橋（平台，炸不壞、子彈穿得過）從左邊接到巨蟒嘴前，上面垂下三條藤蔓（按住 W / S 抓住、上下爬，見 Entity.updateVine）。
//   巨蟒的頭在最右邊，那裡沒有橋：走過頭、被甩過去都會掉進水裡。
// - 巨蟒的頭（固定不動的角色，判定是橢圓）整顆都打得到，打倒 = 過關。輪到巨蟒時出一招：
//     巨蟒衝撞（45%）：整顆頭沿著橋往左衝到底，範圍裡（橋上、藤蔓下段）的玩家 3 層中毒。
//                     下一招是事先抽好的（match.mechState.next），抽到衝撞時玩家回合會一直畫出衝撞範圍（chargeLane），爬上藤蔓就躲得掉
//     毒液噴灑（25%）：從嘴巴往左上方隨機散射幾顆毒液，打中的玩家 10 層中毒（同一次噴灑每人最多中一次）
//     大地震擊（10%）：震波沿著橋面跑，站在橋上的玩家 50 傷害、往巨蟒的方向擊退（藤蔓上 / 半空中的不會被打到）
//     劇毒撕咬（20%）：咬向離嘴巴最近的玩家，15 傷害 + 10 層中毒
// - 中毒（任何角色都可能有，巨蟒與蜜蜂會上毒）：在被毒的人自己的回合開始時結算（見 entities.js 的 poisonTick）——
//     每層扣最大血量 POISON.pctPerStack%，同時把最大血量鎖住一樣多（100/100 → 99/99）。層數不會自己消失（POISON.persist），
//     每個自己的回合開始都再結算一次，要喝蛇血才解除
// - 蛇血：巨蟒每受到最大血量 bloodEveryPct% 的傷害就掉一瓶到橋上（巨蟒的狀態 match.mechState.items）。
//     自己的回合走過去（或回合開始時就站在上面）就喝掉（中毒了、有被鎖住的上限、或血沒滿才撿）：解除中毒、把上限全部解開，再回 bloodHeal 血
//     （10/50(100) → 25/100）

export const SNAKE_ACTION_NAMES = {
  charge: '巨蟒衝撞',
  spray: '毒液噴灑',
  quake: '大地震擊',
  bite: '劇毒撕咬',
  idle: '巨蟒盯著你們',
};

// 建立巨蟒，回傳這一場巨蟒的狀態（地圖機制的 build 回傳給 Match，存成 match.mechState）。
// hpScale = 血量倍率（每多一位玩家 +50%，第二個王關以後再乘 bossStageScale，見 match.js）
export function buildSnake(match, hpScale) {
  const def = match.level.mechanic;
  const h = def.head;
  // next：預定的下一招（Match 開場落地後才決定）；dropped：已經掉了幾瓶蛇血；itemSeq：蛇血的流水號；
  // items：場上的蛇血 { id, type, x, y }，y = 落在的地面（快照照樣帶，見 mechanics/snake.js）
  const state = { def, next: null, dropped: 0, itemSeq: 0, items: [] };
  match.entities.push(new Entity({
    ...CONFIG.ENEMY, id: 'snake', name: '叢林巨蟒', team: 'enemies', controller: 'ai', slot: 0, facing: -1,
    x: h.x, y: h.y, hw: h.hw, h: h.hh * 2, shape: 'ellipse', boss: true, fixed: true, part: 'snake',
    hp: Math.round(CONFIG.SNAKE_BOSS.hp * hpScale),
  }));
  return state;
}

// 依權重抽一招（權重全是 0 就發呆）
export function rollSnakeAction(match) {
  const W = CONFIG.SNAKE_BOSS.weights;
  return weightedPick(match.rng, [['charge', W.charge], ['spray', W.spray], ['quake', W.quake], ['bite', W.bite]]) || 'idle';
}

// 預先決定巨蟒的下一招，存在 match.mechState.next = { action }（抽到衝撞，客戶端在玩家回合就畫出警示帶）
export function planSnakeNext(match) {
  match.mechState.next = { action: rollSnakeAction(match) };
  return match.mechState.next;
}

// 巨蟒的回合：出預定的那一招並結算，回傳 { steps: [招式], next }（格式跟古樹一樣，裁判與客戶端共用一套流程）。
// 每一招帶 shot（跟一般開火一樣的格式，kind: 'boss'）；沒有目標的招式（發呆）帶 still
export function resolveSnakeTurn(match, snake) {
  const plan = match.mechState.next || planSnakeNext(match);
  const step = resolveSnakeAction(match, snake, plan.action);
  planSnakeNext(match);
  return { steps: [step], next: { ...match.mechState.next } };
}

// 巨蟒衝撞的範圍：頭的上緣 top 到下緣 bottom（= 頭的高度），從嘴前 x1 一路衝到 x0 = 0。
// 伺服器的衝撞（chargeShot）與客戶端的警示帶都用這個；腳底在 top 以下（數值比 top 大）的人會被撞到
export function chargeLane(match) {
  const snake = match.byId('snake');
  const half = CONFIG.WEAPONS.snakeCharge.hitRadius;
  const y = snake.cy;
  return { y, half, top: y - half, bottom: y + half, x0: 0, x1: snake.x - snake.hw };
}

// 離巨蟒嘴巴最近的活著的玩家（劇毒撕咬的目標）
export function nearestPlayer(match) {
  const { x, y } = match.mechState.def.mouth;
  return nearestPlayerAt(match, x, y);
}

function resolveSnakeAction(match, snake, action) {
  switch (action) {
    case 'charge':
      return { action, shot: chargeShot(match, snake) };
    case 'spray':
      return { action, shot: sprayShot(match, snake) };
    case 'quake':
      return { action, shot: quakeShot(match, snake) };
    case 'bite': {
      const target = nearestPlayer(match);
      if (!target) break;
      return { action, targetId: target.id, shot: biteShot(match, snake, target) };
    }
  }
  return { action: 'idle', still: stillResult(match) };
}

// 巨蟒衝撞：飛行物是頭的中心高度、半徑 = 頭的半高；從嘴前多一個半徑的地方出發，前緣（嘴）碰到人就算撞到
function chargeShot(match, snake) {
  const weapon = CONFIG.WEAPONS.snakeCharge;
  const lane = chargeLane(match);
  return bossShot(match, snake, weapon, [bossProjectile(snake, weapon, lane.x1 + weapon.hitRadius, lane.y, -weapon.speed, 0)]);
}

// 毒液噴灑：從嘴巴往左上方隨機散射（角度、速度都是亂數），所有毒液共用「打過誰」，同一次噴灑每人最多中一次
function sprayShot(match, snake) {
  const weapon = CONFIG.WEAPONS.snakeVenom;
  const S = CONFIG.SNAKE_BOSS.spray;
  const { x, y } = match.mechState.def.mouth;
  const hitOnce = new Set();
  const projs = [];
  for (let k = 0; k < S.count; k++) {
    const a = match.rng.range(S.minAngle, S.maxAngle) * Math.PI / 180;
    const sp = match.rng.range(S.minSpeed, S.maxSpeed);
    const p = bossProjectile(snake, weapon, x, y, Math.cos(a) * sp, -Math.sin(a) * sp);
    p.spawn = 1 + k * 3;   // 一顆接一顆噴出來
    p.ignore = hitOnce;
    projs.push(p);
  }
  return bossShot(match, snake, weapon, projs);
}

// 大地震擊：震波貼著橋面從巨蟒那頭往左跑，半徑很小，只碰得到腳踩在橋面上的人
function quakeShot(match, snake) {
  const weapon = CONFIG.WEAPONS.snakeQuake;
  const b = match.mechState.def.bridge;
  return bossShot(match, snake, weapon, [bossProjectile(snake, weapon, b.x1 + 8, b.y - 4, -weapon.speed, 0)]);
}

// 劇毒撕咬：從嘴巴直線咬向目標（目標站著不動，一定咬得到；中間剛好有別人的話先咬到那個人）
function biteShot(match, snake, target) {
  const weapon = CONFIG.WEAPONS.snakeBite;
  const o = match.mechState.def.mouth;
  const dx = target.cx - o.x, dy = target.cy - o.y;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  return bossShot(match, snake, weapon, [bossProjectile(snake, weapon, o.x, o.y, dx / d * weapon.speed, dy / d * weapon.speed)]);
}

// ---- 蛇血 ----

// 把掉出來的蛇血（事件 / 回合結束效果帶來的 drops）加進場上：已經有同 id 的就跳過。回傳這次新加的
// （複製出來的物件，不會改到 drops 本身）。
// 客戶端重播（shared/volley.js 經地圖機制的 replayEvent）與 client/map-views/snake.js 的回合結束掉蛇血都用這個
export function takeDrops(match, drops) {
  const made = [];
  for (const d of drops || []) {
    if (match.mechState.items.some(it => it.id === d.id)) continue;
    const it = { ...d };
    match.mechState.items.push(it);
    made.push(it);
  }
  return made;
}

// 巨蟒受到的傷害每跨過一個 bloodEveryPct% 的門檻就掉一瓶蛇血（一下打很多可能一次掉好幾瓶）。
// 巨蟒倒下就不掉了（已經過關）。新掉的蛇血加進場上（match.mechState.items）並回傳（給事件 / fx 帶給客戶端）
export function snakeDrops(match) {
  const S = match.mechState;
  if (!S || !S.items) return [];   // 一般小關（null）、別張地圖的狀態（沒有 items）：沒有巨蟒
  const snake = match.byId('snake');
  if (!snake || !snake.alive) return [];
  const every = CONFIG.SNAKE_BOSS.bloodEveryPct;
  if (!(every > 0)) return [];
  const due = Math.floor((snake.maxHp - snake.hp) * 100 / (every * snake.maxHp) + 1e-9);
  const out = [];
  const [x0, x1] = S.def.bloodX;
  while (S.dropped < due) {
    S.dropped++;
    const item = { id: `a${++S.itemSeq}`, type: 'snakeBlood', x: Math.round(match.rng.range(x0, x1)), y: S.def.bridge.y };
    S.items.push(item);
    out.push({ ...item });
  }
  return out;
}

// 蛇血瓶的判定點（瓶身中間）與半徑
const ITEM_R = 9;
const itemCenter = (it) => ({ x: it.x, y: it.y - 10 });

// 喝了有用才撿：中毒了、有被中毒鎖住的上限，或血沒滿
const wants = (e) => e.alive && (e.poison > 0 || e.poisonLock > 0 || e.hp < e.maxHp);

// 喝蛇血：解除中毒（層數歸零）、把被鎖住的上限全部解開，再回 bloodHeal 血（不超過上限），蛇血從場上消失。回傳 fx
function drink(match, e, item) {
  const cured = e.poison;
  e.poison = 0;
  const unlocked = e.poisonLock;
  e.maxHp += unlocked;
  e.poisonLock = 0;
  const heal = Math.max(0, Math.min(CONFIG.SNAKE_BOSS.bloodHeal, e.maxHp - e.hp));
  e.hp += heal;
  match.mechState.items = match.mechState.items.filter(it => it !== item);
  return { type: 'snakeBlood', id: e.id, item: item.id, cured, unlocked, heal };
}

// 回合開始時（中毒結算之後）：人就站在蛇血上
export function pickupAt(match, e) {
  if (!wants(e)) return null;
  const item = match.mechState.items.find(it => { const c = itemCenter(it); return e.containsPoint(c.x, c.y, ITEM_R); });
  return item ? drink(match, e, item) : null;
}

// 行動玩家從 (x0, y0) 移動到 (x1, y1)（位置回報之間走的路線，每 4px 檢查一次）：路上碰到蛇血就喝掉
export function pickupAlong(match, e, x0, y0, x1, y1) {
  if (!wants(e) || !match.mechState.items.length) return null;
  const n = Math.max(1, Math.ceil(Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0)) / 4));
  for (let i = 0; i <= n; i++) {
    const px = x0 + (x1 - x0) * i / n, py = y0 + (y1 - y0) * i / n;
    const item = match.mechState.items.find(it => {
      const c = itemCenter(it);
      return c.x >= px - e.hw - ITEM_R && c.x <= px + e.hw + ITEM_R && c.y >= py - e.h - ITEM_R && c.y <= py + ITEM_R;
    });
    if (item) return drink(match, e, item);
  }
  return null;
}
