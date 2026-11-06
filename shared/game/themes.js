import { CONFIG } from '../core/config.js';
import { LEVELS } from '../maps/level.js';
import { themeOf, runConfig, stageType } from './stage-rules.js';

// 主題副本的地圖（主題的設定在 config.THEMES，哪幾關是菁英 / Boss 關照 stage-rules.js 的 runConfig 算）：
// 每一關可以抽哪幾張地圖、這個主題做好了沒（每一關都排得到地圖才開放）。
// config 可以換一份（測試用自己的），沒給就是全域 CONFIG

// 第 stage 關可以抽的地圖（Boss 關只有固定的那一張；還沒做的是空的）。不認得的主題是空的
export function themeLevels(id, stage, config = CONFIG) {
  const key = themeOf(id, config);
  if (!key) return [];
  const t = config.THEMES[key];
  const type = stageType(stage, runConfig({ theme: key }, config));
  if (type === 'boss') return t.bosses[stage] ? [t.bosses[stage]] : [];
  return t.maps[type].slice();
}

// 這個主題每一關都排得到地圖（地圖都存在）：做好了才開放
export function themeReady(id, config = CONFIG) {
  const key = themeOf(id, config);
  if (!key) return false;
  for (let s = 1; s <= config.THEMES[key].stageCount; s++) {
    const list = themeLevels(key, s, config);
    if (!list.length || !list.every(l => Object.hasOwn(LEVELS, l))) return false;
  }
  return true;
}

// 開放的主題 id；不認得、還沒做好的都是 null（伺服器、大廳收到這種就當一般冒險）
export function openTheme(id, config = CONFIG) {
  return themeReady(id, config) ? themeOf(id, config) : null;
}

// 開放中的主題（大廳列出來給選）
export function openThemes(config = CONFIG) {
  return Object.keys(config.THEMES || {}).filter(id => themeReady(id, config));
}
