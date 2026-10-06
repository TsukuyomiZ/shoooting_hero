// node test/version.js
// 版本號設定與版本履歷（shared/version.js）：版本號格式、版本履歷最上面一筆 = 目前版本、新的在上面且不重複、
// 日期合法且不倒退、每筆都有內容；package.json 的 version 對得上；大廳需要的 DOM（index.html）都在
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, CHANGELOG, CHANGE_TYPES, versionLabel, semverOf } from '../shared/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function test(name, fn) {
  try {
    const info = fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${info ? '  ' + JSON.stringify(info) : ''}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const CHANNELS = ['ALPHA', 'BETA', 'RC', ''];   // 由舊到新；'' = 正式版
const NUMBER = /^\d+\.\d+(\.\d+)?$/;
const TYPE_KEYS = CHANGE_TYPES.map(t => t.key);
const nums = (v) => v.split('.').map(Number);
// 比版本：先比號碼，同號碼再比階段（1.2 BETA < 1.2 正式版）
function compare(a, b) {
  const x = nums(a.version), y = nums(b.version);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel);
}
const validDate = (s) => /^\d{4}-\d\d-\d\d$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

test('版本號設定：階段與號碼格式', () => {
  assert(CHANNELS.includes(VERSION.channel), `channel ${JSON.stringify(VERSION.channel)} 要是 ${CHANNELS.join(' / ')}`);
  assert(NUMBER.test(VERSION.number), `number ${VERSION.number} 要像 1.2 或 1.2.3`);
  return { label: versionLabel(VERSION) };
});

test('versionLabel / semverOf', () => {
  assert(versionLabel({ channel: 'BETA', number: '1.2' }) === 'BETA v1.2', versionLabel({ channel: 'BETA', number: '1.2' }));
  assert(versionLabel({ channel: '', number: '2.0' }) === 'v2.0', 'official release has no channel prefix');
  assert(semverOf({ channel: 'BETA', number: '1.2' }) === '1.2.0-beta', semverOf({ channel: 'BETA', number: '1.2' }));
  assert(semverOf({ channel: 'BETA', number: '1.2.3' }) === '1.2.3-beta', 'three-part number kept');
  assert(semverOf({ channel: '', number: '2.0' }) === '2.0.0', 'official release has no prerelease tag');
});

test('版本履歷最上面一筆 = 目前版本', () => {
  assert(CHANGELOG.length > 0, 'changelog is empty');
  const top = CHANGELOG[0];
  assert(top.version === VERSION.number && top.channel === VERSION.channel,
    `最上面是 ${versionLabel({ channel: top.channel, number: top.version })}，目前版本是 ${versionLabel(VERSION)}：改版時要在 CHANGELOG 最上面加一筆`);
});

test('每一筆：欄位、日期、內容', () => {
  for (const v of CHANGELOG) {
    const name = versionLabel({ channel: v.channel, number: v.version });
    assert(NUMBER.test(v.version) && CHANNELS.includes(v.channel), `${name}: bad version / channel`);
    assert(validDate(v.date), `${name}: date ${v.date} 要是 YYYY-MM-DD`);
    assert(typeof v.title === 'string', `${name}: title 要是字串`);
    for (const k of Object.keys(v)) {
      assert(['version', 'channel', 'date', 'title', ...TYPE_KEYS].includes(k), `${name}: 不認得的欄位 ${k}（種類只有 ${TYPE_KEYS.join(' / ')}）`);
    }
    let count = 0;
    for (const k of TYPE_KEYS) {
      if (v[k] === undefined) continue;
      assert(Array.isArray(v[k]), `${name}: ${k} 要是陣列`);
      for (const text of v[k]) assert(typeof text === 'string' && text.trim() === text && text.length > 0, `${name}: ${k} 有空白或前後有空格的項目 ${JSON.stringify(text)}`);
      assert(new Set(v[k]).size === v[k].length, `${name}: ${k} 有重複的項目`);
      count += v[k].length;
    }
    assert(count > 0, `${name}: 沒有任何改動`);
  }
  return { versions: CHANGELOG.length, items: CHANGELOG.reduce((n, v) => n + TYPE_KEYS.reduce((m, k) => m + (v[k] || []).length, 0), 0) };
});

test('新的在上面：版本號遞減、不重複，日期不倒退', () => {
  for (let i = 1; i < CHANGELOG.length; i++) {
    const a = CHANGELOG[i - 1], b = CHANGELOG[i];
    const an = versionLabel({ channel: a.channel, number: a.version }), bn = versionLabel({ channel: b.channel, number: b.version });
    assert(compare(a, b) > 0, `${an} 要比下面的 ${bn} 新`);
    assert(a.date >= b.date, `${an}（${a.date}）的日期比下面的 ${bn}（${b.date}）早`);
  }
});

test('package.json 的 version 對得上', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert(pkg.version === semverOf(VERSION), `package.json 是 ${pkg.version}，應該是 ${semverOf(VERSION)}`);
});

test('大廳需要的 DOM 都在（index.html）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const id of ['version-badge', 'version-label', 'btn-changelog', 'changelog', 'changelog-list']) {
    assert(html.includes(`id="${id}"`), `index.html 少了 #${id}`);
  }
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
