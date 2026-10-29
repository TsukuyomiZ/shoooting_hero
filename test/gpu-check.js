// node test/gpu-check.js
// 硬體加速偵測（client/gpu-check.js）：顯示卡名稱是軟體的（SwiftShader、WARP 的 Microsoft Basic Render Driver、llvmpipe…）、
// 要不到「不准掉到軟體」的 WebGL、或錯誤訊息寫 GL_RENDERER = Disabled = 沒開；真的顯示卡不能被當成軟體；
// 兩種 WebGL 都要不到、原因看不出來（公司政策、擋 WebGL 的擴充…）不提醒；Safari / iPhone / iPad / 手機不偵測；
// 要 WebGL 的流程（每次新畫布、先掛錯誤事件、Chrome 從 WEBGL_debug_renderer_info 拿名稱、Firefox 不碰它、要完放掉、丟錯不會壞）；
// 各瀏覽器的打開說明；大廳的提示框跟程式碼用同一組 id
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyGpu, probeGpu, accelGuide, skipReason, SOFTWARE_RENDERER } from '../client/gpu-check.js';

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
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const J = JSON.stringify;

// 各平台真的會看到的名稱（Chrome 的 UNMASKED_RENDERER_WEBGL、Firefox 的 RENDERER）
const HARDWARE = [
  'ANGLE (NVIDIA, NVIDIA Quadro RTX 4000 (0x00001EB1) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
  'Apple GPU',
  'NVIDIA GeForce GTX 980, or similar',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 980 Direct3D11 vs_5_0 ps_5_0)',
  'Intel(R) HD Graphics, or similar',
  'Adreno (TM) 740',
  'Mali-G78 MC14',
  'PowerVR Rogue GE8320',
  'Mesa Intel(R) Xe Graphics (TGL GT2)',
  'AMD Radeon Pro 5500M OpenGL Engine',
  'Mozilla',   // Firefox 的防指紋模式：一律寫 Mozilla，看不出來就當有開，不亂提醒
];
const SOFTWARE = [
  'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',   // Chrome 155 / Edge 156 關掉加速（實測）
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
  'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)',
  'Google SwiftShader',
  'llvmpipe (LLVM 15.0.7, 256 bits)',
  'Microsoft Basic Render Driver, or similar',
  'softpipe',
  'lavapipe (LLVM 17.0.6, 256 bits)',
  'Apple Software Renderer',
  'GDI Generic',
];
// Chrome 完全不碰顯示卡時（--disable-gpu --disable-software-rasterizer，Mac / Linux 關掉加速同一條路）實測的錯誤訊息
const DISABLED_MSG = 'Could not create a WebGL context, VENDOR = 0xffff, DEVICE = 0xffff, GL_VENDOR = Disabled, GL_RENDERER = Disabled, GL_VERSION = Disabled, Sandboxed = no, Optimus = no, AMD switchable = no, Reset notification strategy = 0x0000, ErrorMessage = BindToCurrentSequence failed: .';
const WARP_MSG = 'Could not create a WebGL context, VENDOR = 0x1414, DEVICE = 0x008c, GL_VENDOR = Google Inc. (Microsoft), GL_RENDERER = ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11), GL_VERSION = OpenGL ES 2.0.0';

test('真的顯示卡的名稱不會被當成軟體繪圖', () => {
  for (const r of HARDWARE) {
    assert(!SOFTWARE_RENDERER.test(r), `${r} 被當成軟體`);
    assert(classifyGpu({ fast: true, any: true, renderer: r }) === 'hardware', `${r} 不是 hardware`);
  }
  return { checked: HARDWARE.length };
});

test('軟體繪圖的名稱一律算沒開（就算「不准掉到軟體」的 WebGL 要到了也一樣）', () => {
  for (const r of SOFTWARE) {
    assert(SOFTWARE_RENDERER.test(r), `${r} 沒被認出來`);
    assert(classifyGpu({ fast: true, any: true, renderer: r }) === 'software', `${r} 不是 software`);
  }
  return { checked: SOFTWARE.length };
});

test('只要得到軟體的 WebGL、錯誤訊息寫著軟體繪圖或 GL_RENDERER = Disabled = 沒開', () => {
  assert(classifyGpu({ fast: false, any: true }) === 'software', '只有軟體 WebGL 沒算沒開');
  assert(classifyGpu({ fast: false, any: false, message: WARP_MSG }) === 'software', 'WARP 的錯誤訊息沒算沒開');
  assert(classifyGpu({ fast: false, any: false, message: DISABLED_MSG }) === 'software', 'GL_RENDERER = Disabled 沒算沒開');
  assert(classifyGpu({ fast: true, any: true, renderer: '' }) === 'hardware', '拿不到名稱但要到了不算有開');
  // Chrome 只有在軟體繪圖時「不准掉到軟體」的才會要不到：名稱讀不到（WebKit WebGL）或看起來像真的顯示卡，照樣算沒開
  assert(classifyGpu({ fast: false, any: true, renderer: 'WebKit WebGL' }) === 'software', '名稱讀不到的軟體 WebGL 沒算沒開');
  assert(classifyGpu({ fast: false, any: true, renderer: HARDWARE[0] }) === 'software', '只有軟體 WebGL 卻因為名稱算成有開');
});

test('兩種都要不到、原因看不出來（公司政策、被封鎖、擴充、沒訊息）→ 看不出來，不提醒', () => {
  for (const message of [
    '',
    'Web page caused context loss and was blocked',
    'WebGL is disabled by enterprise policy or commandline switch.',
    'WebGL is currently disabled.',
    'Failed to create WebGL context: WebGL creation failed: * Refused to create native OpenGL context because of blocklist entry: see about:support',
  ]) {
    assert(classifyGpu({ fast: false, any: false, message }) === 'unknown', `「${message}」不是 unknown`);
  }
});

test('不偵測的平台（iPhone / iPad / 手機 / Safari）一律看不出來', () => {
  assert(classifyGpu({ skip: 'safari', fast: false, any: false, message: DISABLED_MSG }) === 'unknown');
  assert(classifyGpu({ skip: 'mobile', fast: true, any: true, renderer: 'Google SwiftShader' }) === 'unknown');
  const UA = {
    iphone: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' },
    iphoneChrome: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1' },
    ipadDesktop: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 },
    android: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' },
    macSafari: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 },
  };
  const DESKTOP = {
    winChrome: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'Win32' },
    winEdge: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', platform: 'Win32' },
    winFirefox: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0', platform: 'Win32' },
    macChrome: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', platform: 'MacIntel', maxTouchPoints: 0 },
    claudeApp: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claude/4.29.0 Chrome/152.0.7977.167 Safari/537.36', platform: 'Win32' },
  };
  const skipped = Object.fromEntries(Object.entries(UA).map(([k, nav]) => [k, skipReason(nav)]));
  for (const [k, why] of Object.entries(skipped)) assert(why, `${k} 沒有跳過`);
  for (const [k, nav] of Object.entries(DESKTOP)) assert(skipReason(nav) === null, `${k} 被跳過了：${skipReason(nav)}`);
  assert(skipReason() === null && skipReason({}) === null, '沒給 navigator 的欄位就要照樣偵測');
  return skipped;
});

// 假的畫布：fast / any = 有沒有要到 WebGL；plain = RENDERER；unmasked = WEBGL_debug_renderer_info 給的（null = 沒有這個擴充）；
// messages = 要不到時 webglcontextcreationerror 帶的訊息（caveat = 不准掉到軟體那次、plain = 不限那次）
// paramThrows = 讀名稱時丟錯
function fakeBrowser({ fast, any, plain = 'WebKit WebGL', unmasked = null, throws = false, paramThrows = false, messages = {} }) {
  const log = { asked: [], canvases: 0, debugExt: 0, lost: 0 };
  const gl = {
    RENDERER: 0x1F01,
    getParameter(p) {
      if (paramThrows) throw new Error('context lost');
      if (p === 0x1F01) return plain;
      if (p === 0x9246) return unmasked;
      return null;
    },
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') { log.debugExt++; return unmasked === null ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 }; }
      if (name === 'WEBGL_lose_context') return { loseContext() { log.lost++; } };
      return null;
    },
  };
  const makeCanvas = () => {
    log.canvases++;
    const listeners = [];
    return {
      addEventListener(type, fn) { if (type === 'webglcontextcreationerror') listeners.push(fn); },
      getContext(type, opts) {
        const caveat = !!(opts && opts.failIfMajorPerformanceCaveat);
        log.asked.push({ type, caveat, antialias: opts && opts.antialias, depth: opts && opts.depth });
        if (throws) throw new Error('boom');
        const ok = caveat ? fast : any;
        if (ok) return gl;
        const statusMessage = caveat ? messages.caveat : messages.plain;
        for (const fn of listeners) fn({ statusMessage });   // Chrome 在 getContext 裡面就送出錯誤事件
        return null;
      },
    };
  };
  return { makeCanvas, log };
}

test('Chrome：RENDERER 只寫 WebKit WebGL，真正的名稱從 WEBGL_debug_renderer_info 拿；要完放掉', () => {
  const real = HARDWARE[0];
  const b = fakeBrowser({ fast: true, any: true, unmasked: real });
  const probe = probeGpu(b.makeCanvas);
  assert(J(probe) === J({ fast: true, any: true, renderer: real, message: '' }), J(probe));
  assert(b.log.asked.length === 1 && b.log.asked[0].type === 'webgl' && b.log.asked[0].caveat, `先要的不是不准掉到軟體的 webgl：${J(b.log.asked)}`);
  assert(b.log.asked[0].antialias === false && b.log.asked[0].depth === false, '試探用的 WebGL 沒關掉反鋸齒 / 深度緩衝');
  assert(b.log.lost === 1, '沒放掉 WebGL');
  assert(classifyGpu(probe) === 'hardware');
});

test('Firefox：RENDERER 就是名稱（防指紋的 Mozilla 也是），不去碰 WEBGL_debug_renderer_info（會跳即將移除的警告）', () => {
  for (const plain of ['NVIDIA GeForce GTX 980, or similar', 'Mozilla']) {
    const b = fakeBrowser({ fast: true, any: true, plain, unmasked: 'x' });
    const probe = probeGpu(b.makeCanvas);
    assert(probe.renderer === plain, probe.renderer);
    assert(b.log.debugExt === 0, '還是叫了 WEBGL_debug_renderer_info');
    assert(classifyGpu(probe) === 'hardware');
  }
});

test('Windows 的 Chrome / Edge 關掉加速（WARP）：不准掉到軟體的要不到、換一張新畫布再要不限的，記下名稱與訊息，算沒開', () => {
  const b = fakeBrowser({ fast: false, any: true, unmasked: SOFTWARE[0], messages: { caveat: WARP_MSG } });
  const probe = probeGpu(b.makeCanvas);
  assert(!probe.fast && probe.any && probe.renderer === SOFTWARE[0] && probe.message === WARP_MSG, J(probe));
  assert(J(b.log.asked.map(a => a.caveat)) === J([true, false]), J(b.log.asked));
  assert(b.log.canvases === 2, `同一張畫布要了兩次：${b.log.canvases}`);
  assert(b.log.lost === 1, '沒放掉 WebGL');
  assert(classifyGpu(probe) === 'software');
});

test('Mac / Linux 的 Chrome 關掉加速：兩種都要不到，訊息寫 GL_RENDERER = Disabled，算沒開；其他原因要不到不提醒', () => {
  const off = probeGpu(fakeBrowser({ fast: false, any: false, messages: { caveat: DISABLED_MSG, plain: DISABLED_MSG } }).makeCanvas);
  assert(!off.fast && !off.any && off.message.includes('GL_RENDERER = Disabled'), J(off));
  assert(classifyGpu(off) === 'software', J(off));
  const policy = probeGpu(fakeBrowser({ fast: false, any: false, messages: { caveat: 'WebGL is disabled by enterprise policy or commandline switch.', plain: 'WebGL is disabled by enterprise policy or commandline switch.' } }).makeCanvas);
  assert(classifyGpu(policy) === 'unknown', J(policy));
  const silent = probeGpu(fakeBrowser({ fast: false, any: false }).makeCanvas);
  assert(J(silent) === J({ fast: false, any: false, renderer: '', message: '' }) && classifyGpu(silent) === 'unknown', J(silent));
  // 兩次的訊息不一樣：兩次都要留著（Disabled 只出現在第二次也要認得）
  const mixed = probeGpu(fakeBrowser({ fast: false, any: false, messages: { caveat: 'first try failed', plain: DISABLED_MSG } }).makeCanvas);
  assert(mixed.message.includes('first try failed') && mixed.message.includes('GL_RENDERER = Disabled'), mixed.message);
  assert(classifyGpu(mixed) === 'software', J(mixed));
});

test('getContext 丟錯、讀名稱丟錯：不會壞（偵測在計時器裡跑，丟出去就沒人接）', () => {
  const b = fakeBrowser({ fast: true, any: true, throws: true });
  const probe = probeGpu(b.makeCanvas);
  assert(J(probe) === J({ fast: false, any: false, renderer: '', message: '' }), J(probe));
  assert(classifyGpu(probe) === 'unknown');
  const p = fakeBrowser({ fast: true, any: true, paramThrows: true });
  const lost = probeGpu(p.makeCanvas);
  assert(J(lost) === J({ fast: true, any: true, renderer: '', message: '' }), J(lost));
  assert(p.log.lost === 1, '讀名稱丟錯就沒放掉 WebGL');
});

test('各瀏覽器的打開說明：Edge / Opera 不會被當成 Chrome，Safari 之類的給通用說明', () => {
  const UA = {
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0',
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  };
  const got = Object.fromEntries(Object.entries(UA).map(([k, ua]) => [k, accelGuide(ua)]));
  assert(got.edge.url === 'edge://settings/system', J(got.edge));
  assert(got.chrome.url === 'chrome://settings/system', J(got.chrome));
  assert(got.opera.url === null && /硬體加速/.test(got.opera.steps), J(got.opera));
  assert(got.firefox.url === 'about:preferences' && /硬體加速/.test(got.firefox.steps), J(got.firefox));
  assert(got.safari.url === null && /硬體加速/.test(got.safari.steps), J(got.safari));
  assert(accelGuide('').url === null, '沒有 UA 也要給通用說明');
  for (const g of Object.values(got)) assert(g.steps && g.steps.length <= 80, `說明太長：${g.steps}`);
});

test('大廳的提示框：index.html 有 lobby.js 用到的每個 id；main.js 先看平台、只在算出沒開時才提醒', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const lobby = fs.readFileSync(path.join(ROOT, 'client/lobby.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'client/main.js'), 'utf8');
  const ids = [...new Set([...lobby.matchAll(/'#(gpu-hint[\w-]*)'/g)].map(m => m[1]))];
  assert(ids.length >= 5, `lobby.js 用到的 id 太少：${J(ids)}`);
  for (const id of ids) assert(html.includes(`id="${id}"`), `index.html 沒有 #${id}`);
  assert(/id="gpu-hint"[^>]*\bhidden\b/.test(html), '提示框一開始沒有藏起來');
  assert(/skipReason\(navigator\)/.test(main) && /skip \? \{ skip \} : probeGpu\(\)/.test(main), 'main.js 沒先看平台就去要 WebGL');
  assert(/state === 'software'\) lobby\.showGpuHint\(/.test(main), 'main.js 沒照偵測結果決定要不要提醒');
  return { ids };
});

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
