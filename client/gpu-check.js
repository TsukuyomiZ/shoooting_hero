// 偵測瀏覽器有沒有開硬體加速（用顯示卡畫畫面）：沒開的話整個畫面都靠 CPU 畫，選牌畫面的模糊遮罩、打中敵人時的特效會很卡。
// 頁面讀不到「硬體加速」這個設定，只能拿 WebGL 間接看（2026-10 查過 Chromium 原始碼、在 Chrome 155 / Edge 156 實測）：
// - Windows 的 Chrome / Edge 關掉之後 WebGL 退到 WARP（軟體繪圖）：「不准掉到軟體」（failIfMajorPerformanceCaveat）的要不到、不限的要得到，
//   顯示卡名稱是 Microsoft Basic Render Driver
// - Mac / Linux 的 Chrome 關掉之後完全不碰顯示卡：兩種都要不到，錯誤訊息寫 GL_RENDERER = Disabled
// - 兩種都要不到、訊息又不是 Disabled 的（公司政策關掉 WebGL、擋 WebGL 的擴充、Safari 鎖定模式…）看不出來，不提醒
// - Safari / iPhone / iPad / 手機沒有這個開關，不偵測；Firefox 關掉之後 WebGL 還是用顯示卡，偵測不到（只抓得到驅動沒裝好之類的軟體繪圖）
// 結果只用來在大廳提醒（Lobby.showGpuHint），不影響遊戲。純計算 + 可以換掉的畫布 / UA，測試不用瀏覽器（test/gpu-check.js）

// 軟體繪圖的「顯示卡」名稱：Chrome / Edge 的 SwiftShader、Windows 的 Microsoft Basic Render Driver（WARP；遠端桌面、沒裝驅動也是它）、
// Linux 的 llvmpipe / softpipe / lavapipe、macOS 的 Apple Software Renderer、GDI Generic / Mesa OffScreen（舊的軟體 OpenGL）
export const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|basic render driver|software (?:renderer|rasterizer)|gdi generic|mesa offscreen/i;
// Chrome 完全不碰顯示卡時，要 WebGL 失敗的訊息裡會有這段
const GPU_DISABLED = /GL_RENDERER = Disabled\b/;

// 不偵測的平台（沒有硬體加速的開關）：iPhone / iPad（含偽裝成 Mac 的 iPad）、手機、桌機的 Safari。回傳原因，要偵測回傳 null
// （不用 navigator.userAgentData：區網的 http 網址拿不到）
export function skipReason({ userAgent: ua = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (/iP(?:hone|ad|od)/.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1)) return 'ios';
  if (/Android|Mobile/.test(ua)) return 'mobile';
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Firefox\//.test(ua)) return 'safari';
  return null;
}

// probe = probeGpu() 的結果：
//   fast = 「不准掉到軟體」的 WebGL 有沒有要到、any = 隨便哪種 WebGL 有沒有要到、renderer = 顯示卡名稱（拿不到是 ''）、
//   message = 要不到時瀏覽器給的錯誤訊息；skip = skipReason 給的不偵測原因
// → 'hardware'（有開）/ 'software'（沒開，要提醒）/ 'unknown'（看不出來，不提醒）
export function classifyGpu({ skip = null, fast = false, any = false, renderer = '', message = '' }) {
  if (skip) return 'unknown';
  if (renderer && SOFTWARE_RENDERER.test(renderer)) return 'software';
  if (fast) return 'hardware';
  if (SOFTWARE_RENDERER.test(message)) return 'software';   // Chrome 的錯誤訊息裡就寫著軟體繪圖的名稱
  if (any) return 'software';                               // 只要得到軟體繪圖的 WebGL
  if (GPU_DISABLED.test(message)) return 'software';        // 完全不碰顯示卡（Mac / Linux 的 Chrome 關掉加速、顯示卡被封鎖）
  return 'unknown';                                         // 兩種都要不到、原因看不出來：可能只是 WebGL 被關掉，不亂提醒
}

// 真的去要 WebGL 看看（makeCanvas 測試換成假的）：每次用一張新的畫布、先掛好錯誤事件（Chrome 在 getContext 裡面就送出來），要完馬上放掉
export function probeGpu(makeCanvas = () => document.createElement('canvas')) {
  const out = { fast: false, any: false, renderer: '', message: '' };
  const open = (opts) => {
    try {
      const canvas = makeCanvas();
      canvas.width = canvas.height = 1;
      canvas.addEventListener('webglcontextcreationerror', (ev) => {
        if (ev.statusMessage) out.message = out.message ? `${out.message} | ${ev.statusMessage}` : ev.statusMessage;
      });
      return canvas.getContext('webgl', { antialias: false, depth: false, ...opts }) || null;
    } catch {
      return null;
    }
  };
  let gl = open({ failIfMajorPerformanceCaveat: true });
  out.fast = !!gl;
  if (!gl) gl = open({});
  out.any = !!gl;
  if (gl) {
    out.renderer = rendererOf(gl);
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }
  return out;
}

// 顯示卡名稱：Chrome 的 RENDERER 固定寫 WebKit WebGL，真正的名稱要從 WEBGL_debug_renderer_info 拿；
// Firefox 的 RENDERER 直接就是（再叫那個擴充會在 console 跳「即將移除」的警告）
function rendererOf(gl) {
  try {
    const plain = String(gl.getParameter(gl.RENDERER) || '');
    if (plain !== 'WebKit WebGL') return plain;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || plain) : plain;
  } catch {
    return '';
  }
}

// 照瀏覽器給「怎麼打開」：steps = 一句說明、url = 設定頁的網址（網頁不能直接連過去，給玩家複製；沒有就是 null）
export function accelGuide(ua = '') {
  if (/Edg\//.test(ua)) {
    return { browser: 'Edge', url: 'edge://settings/system', steps: '在網址列貼上下面的網址，打開「可用時使用圖形加速」，再按「重新啟動」。' };
  }
  if (/Firefox\//.test(ua)) {
    return {
      browser: 'Firefox', url: 'about:preferences',
      steps: '在網址列貼上下面的網址，到「一般 → 效能」，取消勾選「使用建議的效能設定」，再勾「可用時使用硬體加速」，然後重新開啟 Firefox。',
    };
  }
  if (/Chrome\//.test(ua) && !/OPR\//.test(ua)) {   // Chrome 和吃 chrome:// 網址的 Chromium 瀏覽器（Brave 之類的）；Opera 不確定，給通用說明
    return { browser: 'Chrome', url: 'chrome://settings/system', steps: '在網址列貼上下面的網址，打開「可用時使用圖形加速功能」，再按「重新啟動」。' };
  }
  return { browser: null, url: null, steps: '到瀏覽器的設定搜尋「硬體加速」或「圖形加速」，打開之後重新啟動瀏覽器。' };
}
