你現在要扮演我的教練，帶我完成「30 天打造迷你 Vite」計畫。
我們已完成 Day 1–7，接下來請從我指定的 Day（預設 Day 7）繼續，一天一小步：先給最小可行的改動完整檔案、再給測試步驟與驗收標準，最後給 1 段簡短原理說明。全程以 JavaScript（非 TypeScript）實作，不引入不必要的套件。

我目前的專案狀態

目標：做一個「迷你 Vite」開發伺服器（Dev-only 為主，之後再加 Build 與 Plugin）。

專案結構（簡化）：

mini-vite/
├─ package.json // { "type": "module" }, scripts: { "dev": "nodemon server.js" }
├─ server.js // 最新版（見下方能力清單）
├─ index.html // 已載入 /livereload.js 與 /src/main.js
└─ src/
├─ main.js
├─ style.css // Day 5 測試用
└─ data.json // Day 5 測試用

目前的 server.js:

```javascript
import http from 'http';
import fs from 'fs';
import path, { posix } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

const livereloadClientJs = `
// live reload
const src = location.origin + '/__livereload';
const es = new EventSource(src);
es.addEventListener('message', e => {
  if (e.data === 'reload') {
    console.log('[mini-vite] Reloading...');
    window.location.reload();
  }
});
es.addEventListener('open', () =>
  console.log('[mini-vite] Live reload connected')
);
es.addEventListener('error', () =>
  console.log('[mini-vite] Live reload disconnected')
);
`;

// 儲存所有連線中 SSE 回應 (多分頁也能一起刷新)
const sseClients = new Set();

// 廣播 reload
function boroadcastReload() {
  const payload = 'data: reload\n\n';
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (_) {}
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const debouncedReload = debounce(() => {
  console.log('[mini-vite] change detected → reload');
  boroadcastReload();
}, 60);

const watchedDirs = new Set();
function watchDirRecursive(dir) {
  if (!fs.existsSync(dir)) return;
  const real = fs.realpathSync(dir);
  if (watchedDirs.has(real)) return;
  watchedDirs.add(real);

  try {
    fs.watch(real, { persistent: true }, (eventType, filename) => {
      if (filename) {
        const full = path.join(real, filename);
        fs.promises
          .stat(full)
          .then(st => {
            if (st.isDirectory()) watchDirRecursive(full);
          })
          .catch(() => {});
        debouncedReload();
      } else {
        debouncedReload();
      }
    });

    for (const entry of fs.readdirSync(real)) {
      const sub = path.join(real, entry);
      try {
        const st = fs.statSync(sub);
        if (st.isDirectory()) watchDirRecursive();
      } catch {}
    }
  } catch (e) {}
}

// 監聽 index.html
const INDEX_PATH = path.join(__dirname, 'index.html');
fs.watch(INDEX_PATH, { persistent: true }, eventType => {
  if (eventType === 'change') {
    console.log('[mini-vite] index.html changed → reload');
    boroadcastReload();
  }
});

// 監聽 src/**
const SRC_DIR = path.join(__dirname, 'src');
watchDirRecursive(SRC_DIR);

fs.watch(__dirname);

// 改寫 import 成 /@modules/...

// 判斷是不是從包中引入的
function isBareImport(spec) {
  return (
    !spec.startsWith('/') &&
    !spec.startsWith('./') &&
    !spec.startsWith('../') &&
    !spec.startsWith('http://') &&
    !spec.startsWith('https://')
  );
}

function isRelativeImport(spec) {
  return spec.startsWith('./') || spec.startsWith('../');
}

// ctx: { isModuleRequest?: boolean, urlBase?: string }
function rewriteSpecifier(spec, ctx = {}) {
  if (ctx.isModuleRequest && isRelativeImport(spec)) {
    const base = ctx.urlBase || '/';
    const absUrl = posix.normalize(posix.join(base, spec));
    return absUrl;
  }

  if (isBareImport(spec)) {
    return `/@modules/${spec}`;
  }

  return spec;
}

function rewriteImports(code, ctx) {
  const R = s => rewriteSpecifier(s, ctx);

  code = code.replace(
    /from\s+(['"])([^'"]+)\1/g,
    (m, q, s) => `from ${q}${R(s)}${q}`
  );
  // import "x"
  code = code.replace(
    /import\s+(['"])([^'"]+)\1/g,
    (m, q, s) => `import ${q}${R(s)}${q}`
  );
  // export ... from "x"
  code = code.replace(/export\s+[^;]*\s+from\s+(['"])([^'"]+)\1/g, (m, q, s) =>
    m.replace(s, R(s))
  );
  // dynamic import
  code = code.replace(
    /import\(\s*(['"])([^'"]+)\1\s*\)/g,
    (m, q, s) => `import(${q}${R(s)}${q})`
  );
  return code;
}

// JSON 包裝
function wrapJsonAsJs(jsonText) {
  return `export default ${jsonText};\n`;
}

// CSS 包裝
function wrapCssAsJs(cssText) {
  // 用 JSON.stringify() 安全的轉成字串
  const cssStr = JSON.stringify(cssText);
  return (
    `
    const css = ${cssStr};
    const style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.innerHTML = css;
    document.head.appendChild(style);
    export default css;
  `.trim() + '\n'
  );
}

// 解析 /@modules/<包>
function parseModuleRequest(urlPath) {
  const after = urlPath.slice('/@modules/'.length);
  const segs = after.split('/').filter(s => Boolean(s));
  if (segs.length === 0) throw new Error('Invalid /@modules request');

  let moduleName, subPath;

  if (segs[0].startsWith('@')) {
    moduleName = segs.slice(0, 2).join('/');
    subPath = segs.slice(2).join('/');
  } else {
    moduleName = segs[0];
    subPath = segs.slice(1).join('/');
  }

  return { moduleName, subPath };
}

function ensureJsLike(p) {
  if (path.extname(p)) return p;
  if (fs.existsSync(p + '.js')) return p + '.js';
  else if (fs.existsSync(p + '.mjs')) return p + '.mjs';
  else if (fs.existsSync(p + '.ts')) return p + '.ts';
}

function resolveModuleEntry(moduleName, subPath) {
  const pkgDir = path.join(__dirname, 'node_modules', moduleName);
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`Cannot find package.json for ${moduleName}`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  // 如果有子路徑，加上副檔名直接指向檔案
  if (subPath) {
    return ensureJsLike(path.join(pkgDir, subPath));
  }

  // 無子路徑，挑 ESM 友善的欄位
  let candidate = null;
  if (typeof pkg.exports === 'string') candidate = pkg.exports;
  else if (
    pkg.exports &&
    typeof pkg.exports === 'object' &&
    typeof pkg.exports['.'] === 'string'
  )
    candidate = pkg.exports['.'];
  else if (pkg.module) candidate = pkg.module;
  else if (typeof pkg.browser === 'string') candidate = pkg.browser;
  else if (typeof pkg.main === 'string') candidate = pkg.main;
  else candidate = 'index.js';

  return path.join(pkgDir, candidate);
}

// 防止跳脫到專案外
function safeJoin(root, urlPath) {
  const normalized = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/g, '');
  return path.join(root, normalized);
}

// server 主程式
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url || '/');

  // sse 端點
  if (url === '/__livereload') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*'
    });
    res.write('retry: 1000\n\n'); // 斷線後 1s 嘗試重連
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url === '/livereload.js') {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(livereloadClientJs);
    return;
  }

  if (url.startsWith('/@modules/')) {
    try {
      const { moduleName, subPath } = parseModuleRequest(url);
      const absPath = resolveModuleEntry(moduleName, subPath);

      let baseFromSub = '';
      if (subPath) {
        const dir = posix.dirname('/' + subPath);
        baseFromSub = dir === '/' ? '' : dir;
      }
      const urlBase = `/@modules/${moduleName}${baseFromSub}`;

      const code = fs.readFileSync(absPath, 'utf-8');
      const transformed = rewriteImports(code, {
        isModuleRequest: true,
        urlBase
      });

      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(transformed);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`[mini-vite] Failed to resolve module: ${err.message}`);
    }
    return;
  }

  const filePath = safeJoin(
    __dirname,
    req.url === '/' ? '/index.html' : req.url
  );

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const isNotFound = err.code === 'ENOENT';
      const status = isNotFound ? 404 : 500;
      const message = isNotFound ? 'Not Found' : `Server error: ${err.message}`;
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8'
      });
      res.end(message);
      return;
    }

    const lower = filePath.toLowerCase();

    if (lower.endsWith('.json')) {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(wrapJsonAsJs(data.toString('utf-8')));
      return;
    }

    if (lower.endsWith('.css')) {
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(wrapCssAsJs(data.toString('utf-8')));
      return;
    }

    const ct = getContentType(filePath);

    res.writeHead(200, {
      'Content-Type': ct,
      'cache-control': 'no-store'
    });

    if (ct === 'application/javascript; charset=utf-8') {
      const transformed = rewriteImports(data.toString('utf-8'));
      res.end(transformed);
    } else {
      res.end(data);
    }
  });
});

function getContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'text/plain; charset=utf-8';
}

server.listen(PORT, () => {
  console.log(
    `Mini Vite dev server with Live Reload at http://localhost:${PORT}`
  );
});
```

已安裝：nodemon（dev）、可能有 lodash-es（測試裸模組用，可視需要保留）。

server.js 已具備能力（不使用 302 轉址）：

靜態服務：回應 index.html 與一般資源。

Live Reload（SSE）：GET /\_\_livereload + /livereload.js；目前必定監看 index.html 變動並整頁重整。

裸模組支援：把程式碼中的裸模組 import "pkg" 改寫為 "/@modules/pkg"，並從 node_modules/<pkg> 解析入口（優先 exports/module/browser/main）。

相對匯入改寫為絕對 URL（僅在回應 /@modules/\* 檔案時）：例如套件內 ./add.js 會被改成 "/@modules/lodash-es/add.js"，全程不使用 302。

Day 5：支援 JSON 與 CSS 作為 ESM 回應：

\*.json → 包裝為 JS：export default <json>

\*.css → 包裝為 JS：動態建立 <style> 注入，export default cssString

已完成的天數

Day 1：專案初始化、理解 Vite 核心與原生 ESM。

Day 2：最小靜態伺服器（JS 版）。

Day 3：Live Reload（SSE，監看 index.html）。

Day 4：裸模組改寫與 node_modules 解析；在模組檔內把相對路徑改為絕對 URL（不走 302）。

Day 5：JSON/CSS ESM 包裝（應用端與 /@modules/\* 皆支援）。

Day 6：擴大檔案監聽範圍（src/\*_, _.css, \*.json）→ 變更時自動整頁重載。

待完成的清單（供你依序帶我做）

Day 7：小結與重構：抽出「靜態回應 / 改寫器 / 模組解析」三層。

Day 8：建立 HMR 通道（WebSocket）與 update/full-reload 基本協議。

Day 9：CSS HMR（更新樣式而非整頁）。

Day 10：Module Graph 雛形（追蹤依賴/反向依賴）。

Day 11：JS HMR：import.meta.hot.accept()。

Day 12：錯誤覆蓋層（Error Overlay）與快取失效策略（ETag/時間戳）。

Day 13：依賴預編譯（pre-bundling 概念版）→ 改寫至 /deps/\*，並加強快取。

Day 14：週小結：穩定 HMR（CSS/JS）＋ 預編譯基本可用。

Day 15：整合 Rollup 做最小生產建置（單入口）。

Day 16：多入口 / Code Splitting。

Day 17：輸出格式：ESM / CJS。

Day 18：CSS 抽離與生產注入策略。

Day 19：資產（圖/字型/JSON）與 hash 命名。

Day 20：環境變數（.env）與 import.meta.env 替換。

Day 21：週小結：完成可發佈的 build pipeline。

Day 22：Plugin 介面：resolveId、load、transform。

Day 23：示範插件（字串替換或 Banner 注入）。

Day 24：框架插件（React 或 Vue 最小可行）。

Day 25：別名（alias）與自訂解析（打通 resolveId）。

Day 26：模式切換（dev / build；--mode）。

Day 27：快取（in-memory + 檔案快取）。

Day 28：CLI：mini-vite dev/build/preview。

Day 29：測試與範例專案驗收。

Day 30：文件與最終整理（README、架構圖、限制與未來工作）。

互動規則（請嚴格遵守）

先給完整檔案 → 再給測試步驟 → 再給驗收條件 → 最後 3–5 句原理說明。

保持 JS 版本；不升級 TypeScript，也不要引入不必要的第三方依賴。

持續沿用「不使用 302」的策略；對 /@modules/\* 的回應中，將相對 import 改為絕對 URL。

若需新增檔案/端點，務必標示完整路徑與用途；對現有檔案，盡量提供最小 diff。

若功能可分步落地，優先讓第一步先可用，再漸進擴充。

現在請從 Day 7 開始帶我做；若我輸入「開始 Day X」，你就跳到指定天數，按照上面格式輸出。
