你現在要扮演我的教練，帶我完成「30 天打造迷你 Vite」計畫。
請嚴格遵守輸出格式：先給完整檔案 → 再給測試步驟 → 再給驗收標準 → 最後 3–5 句原理說明。
全程以 JavaScript（非 TypeScript） 實作；不引入不必要套件
有修改的部分要用註解標示，例如:
// ===================== 修改開始 ======================
// ===================== 修改結束 ======================
我會用「開始 Day X」來指定天數；若我沒指定，預設從 Day 13 開始。

專案狀態（請記住）

專案根：mini-vite/

package.json（已設為 ESM）：

```JSON
{
  "type": "module",
  "scripts": {
    "dev": "nodemon server.js"
  }
}

目前目錄（簡化）：

```

mini-vite/
├─ package.json
├─ server.js
├─ error-overlay.js
├─ hmr.js
├─ core/
│ ├─ graph.js
│ ├─ rewriter.js
│ ├─ resolver.js
│ └─ static.js
├─ index.html
└─ src/
├─ main.js
├─ style.css
└─ data.json

```

現有檔案內容（以此為準）

### mini-vite/server.js

import http from 'http';
import fs from 'fs';
import path, { posix } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { rewriteImports, wrapCssAsJs, wrapJsonAsJs } from './core/rewriter.js';
import {
  parseModuleRequest,
  resolveModuleEntry,
  safeJoin
} from './core/resolver.js';
import { getContentType } from './core/static.js';
import { ModuleGraph } from './core/graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const moduleGraph = new ModuleGraph();

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

// ========== HMR (WebSocket) ==========

const wsClients = new Set();

function createWsAccept(key) {
  const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const sha1 = crypto.createHash('sha1');
  sha1.update(key + GUID);
  return sha1.digest('base64');
}

function encodeWsTextFrame(str) {
  const payload = Buffer.from(str);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  const frame = encodeWsTextFrame(msg);
  for (const sock of wsClients) {
    try {
      sock.write(frame);
    } catch {}
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
  wsBroadcast({ type: 'full-reload' });
}, 60);

const updatesQueue = new Map(); // Map<path, {type, path, timestamp}>
const flushUpdates = debounce(() => {
  const updates = Array.from(updatesQueue.values());
  updatesQueue.clear();
  wsBroadcast({ type: 'update', updates });
}, 60);

function enqueueCssUpdate(cssPath) {
  updatesQueue.set(cssPath, {
    type: 'css',
    path: cssPath,
    timestamp: Date.now()
  });
  flushUpdates();
}

function enqueueJsUpdate(jsPath) {
  const affected = moduleGraph.collectAffected(jsPath);
  updatesQueue.set(jsPath, {
    type: 'js',
    path: jsPath,
    timestamp: Date.now(),
    affected
  });
  flushUpdates();
}

function isJsExt(p) {
  const ext = path.extname(p).toLowerCase();
  return ext === '.js' || ext === '.mjs' || ext === '.cjs';
}

// 將 import.meta.hot 注入每個 JS 模組
function injectImportMetaHot(code, urlPath) {
  const header =
    `import { createHotContext as __mv_createHotContext } from "/hmr.js";\n` +
    `import.meta.hot = __mv_createHotContext(${JSON.stringify(urlPath)});\n`;
  return header + code;
}

function toUrlPath(absPath) {
  const rel = path.relative(__dirname, absPath);
  if (!rel || rel.startsWith('..')) return null;
  return '/' + rel.split(path.sep).join(posix.sep);
}

function notifyFileChanged(absFullPath) {
  const urlPath = toUrlPath(absFullPath);
  if (!urlPath) return debouncedReload();

  const ext = path.extname(urlPath).toLowerCase();
  if (ext === '.css') {
    console.log('[mini-vite] css update →', urlPath);
    enqueueCssUpdate(urlPath);
    return;
  }

  if (isJsExt(urlPath)) {
    console.log('[mini-vite] js update →', urlPath);
    enqueueJsUpdate(urlPath);
    return;
  }

  debouncedReload();
}

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
        notifyFileChanged(full);
      } else {
        debouncedReload();
      }
    });

    for (const entry of fs.readdirSync(real)) {
      const sub = path.join(real, entry);
      try {
        const st = fs.statSync(sub);
        if (st.isDirectory()) watchDirRecursive(sub);
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
    wsBroadcast({ type: 'full-reload', path: '/index.html' });
  }
});

// 監聽 src/**
const SRC_DIR = path.join(__dirname, 'src');
watchDirRecursive(SRC_DIR);

fs.watch(__dirname);

function createEtagFromStat(st) {
  if (!st) return null;
  const mtime = Math.floor(st.mtimeMs || (st.mtime ? st.mtime.getTime() : 0));
  return `W/"${st.size}-${mtime}"`;
}

function setCacheHeaders(res, stat) {
  const etag = createEtagFromStat(stat);
  if (etag) res.setHeader('Etag', etag);
  if (stat && stat.mtime)
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('Cache-Control', 'no-cache');
  return etag;
}

function isFreshByEtag(req, etag) {
  const inm = req.headers['if-none-match'];
  if (inm && etag && inm === etag) return true;
  return false;
}

// server 主程式
const server = http.createServer((req, res) => {
  const rawUrl = decodeURIComponent(req.url || '/');
  const u = new URL(rawUrl, 'http://localhost');
  const urlPath = u.pathname;

  if (urlPath === '/__graph.json') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-cache'
    });
    res.end(JSON.stringify(moduleGraph.toJSON(), null, 2));
    return;
  }

  // sse 端點
  if (urlPath === '/__livereload') {
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

  if (urlPath === '/livereload.js') {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-cache'
    });
    res.end(livereloadClientJs);
    return;
  }

  if (urlPath.startsWith('/@modules/')) {
    try {
      const { moduleName, subPath } = parseModuleRequest(urlPath);
      const absPath = resolveModuleEntry(moduleName, subPath);

      let baseFromSub = '';
      if (subPath) {
        const dir = posix.dirname('/' + subPath);
        baseFromSub = dir === '/' ? '' : dir;
      }
      const urlBase = `/@modules/${moduleName}${baseFromSub}`;

      const st = fs.statSync(absPath);
      const etag = setCacheHeaders(res, st);
      if (isFreshByEtag(req, etag)) {
        res.writeHead(304);
        res.end();
        return;
      }

      const code = fs.readFileSync(absPath, 'utf-8');
      const transformed = rewriteImports(code, {
        isModuleRequest: true,
        urlBase
      });

      const withHmr = injectImportMetaHot(transformed, urlPath);
      moduleGraph.recordFromCode(urlPath, withHmr);

      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(withHmr);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`[mini-vite] Failed to resolve module: ${err.message}`);
    }
    return;
  }

  const filePath = safeJoin(
    __dirname,
    urlPath === '/' ? '/index.html' : urlPath
  );

  fs.stat(filePath, (statErr, st) => {
    const hasStat = !statErr && st && st.isFile();

    fs.readFile(filePath, (err, data) => {
      if (err) {
        const isNotFound = err.code === 'ENOENT';
        const status = isNotFound ? 404 : 500;
        const message = isNotFound
          ? 'Not Found'
          : `Server error: ${err.message}`;
        res.writeHead(status, {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-cache'
        });
        res.end(message);
        return;
      }

      const etag = setCacheHeaders(res, hasStat ? st : null);
      if (isFreshByEtag(req, etag)) {
        res.writeHead(304);
        res.end();
        return;
      }

      const lower = filePath.toLowerCase();

      if (lower.endsWith('.json')) {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8'
        });
        res.end(wrapJsonAsJs(data.toString('utf-8')));
        return;
      }

      if (lower.endsWith('.css')) {
        const isRaw = u.searchParams.has('raw');
        if (isRaw) {
          res.writeHead(200, {
            'content-type': 'text/css; charset=utf-8'
          });
          res.end(data.toString('utf-8'));
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8'
        });
        res.end(wrapCssAsJs(data.toString('utf-8'), urlPath));
        return;
      }

      const ct = getContentType(filePath);

      res.writeHead(200, {
        'Content-Type': ct
      });

      if (ct === 'application/javascript; charset=utf-8') {
        const transformed = rewriteImports(data.toString('utf-8'));
        const withHmr = injectImportMetaHot(transformed, urlPath);
        moduleGraph.recordFromCode(urlPath, withHmr);
        res.end(withHmr);
      } else {
        res.end(data);
      }
    });
  });
});

// WebSocket 升級握手: /__hmr
server.on('upgrade', (req, socket) => {
  if (!req.url || !req.url.startsWith('/__hmr')) {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (!key || version !== '13') {
    socket.destroy();
    return;
  }

  const accept = createWsAccept(String(key));
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`
  ];
  socket.write(headers.join('\r\n') + '\r\n\r\n');

  wsClients.add(socket);
  socket.on('close', () => wsClients.delete(socket));
  socket.on('end', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));

  socket.on('data', () => {});
});

server.listen(PORT, () => {
  console.log(
    `Mini Vite dev server with Live Reload at http://localhost:${PORT}`
  );
  console.log('Module graph endpoint: http://localhost:%d/__graph.json', PORT);
});

### mini-vite/hmr.js

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const url = proto + '//' + location.host + '/__hmr';
const ws = new WebSocket(url);

ws.addEventListener('open', () => {
  console.log('[mini-vite] HMR connected');
});

ws.addEventListener('close', () => {
  console.log('[mini-vite] HMR disconnected');
});

const hotModules = new Map(); // Map<urlPath, acceptCallback>

export function createHotContext(urlPath) {
  return {
    accept(cb) {
      if (typeof cb !== 'function') {
        console.warn('[mini-vite] hot.accept expects a callback');
        return;
      }
      hotModules.set(urlPath, cb);
    },
    dispose() {},
    invalidate() {
      location.reload();
    }
  };
}

async function updateCss(path) {
  try {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(path + sep + 'raw=1&t=' + Date.now(), {
      cache: 'no-cache'
    });
    const css = await res.text();
    const style = document.querySelectorAll(`style[data-mv-href="${path}"]`);
    if (style.length) {
      style.forEach(el => (el.textContent = css));
    } else {
      const el = document.createElement('style');
      el.setAttribute('type', 'text/css');
      el.setAttribute('data-mv-href', path);
      el.textContent = css;
      document.head.appendChild(el);
    }
    console.log('[mini-vite] HMR(css): updated', path);
  } catch (e) {
    console.warn('[mini-vite] HMR(css) failed, fallback to reload', e);
    location.reload();
  }
}

async function updateJsSelf(path, timestamp) {
  const cb = hotModules.get(path);
  if (!cb) {
    console.log('[mini-vite] No hot.accept for', path, '→ full reload');
    location.reload();
    return;
  }

  try {
    const sep = path.includes('?') ? '&' : '?';
    const mod = await import(path + sep + 't=' + (timestamp || Date.now()));
    await cb(mod);
    console.log('[mini-vite] HMR(js): accepted', path);
  } catch (e) {
    console.log('[mini-vite] HMR(js) failed, fallback to reload', e);
    location.reload();
  }
}

ws.addEventListener('message', e => {
  try {
    const msg = JSON.parse(e.data);
    if (msg && msg.type === 'full-reload') {
      console.log('[mini-vite] HMR full-reload');
      location.reload();
      return;
    }

    if (msg && msg.type === 'update' && Array.isArray(msg.updates)) {
      for (const u of msg.updates) {
        if (u.type === 'css' && u.path) {
          updateCss(u.path);
        } else if (u.type === 'js' && u.path) {
          updateJsSelf(u.path, u.timestamp);
        } else {
          console.log('[mini-vite] HMR update (ignored)', u);
        }
      }
    }
  } catch (err) {
    console.warn('[mini-vite] HMR invalid message', e.data);
  }
});

// 暴露 debug 入口
window.__mini_vite_hmr = { ws, hotModules, createHotContext };


### mini-vite/core/graph.js

import { posix } from 'path';

export function scanImports(code) {
  const specs = new Set();

  const reFrom = /(?:import|export)\s+[^'";]*?\bfrom\s*(['"])([^'"]+)\1/g;
  const reBare = /\bimport\s*(['"])([^'"]+)\1/g;
  const reDyn = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

  let m;
  while ((m = reFrom.exec(code))) specs.add(m[2]);
  while ((m = reBare.exec(code))) specs.add(m[2]);
  while ((m = reDyn.exec(code))) specs.add(m[2]);

  return Array.from(specs);
}

function isAbs(u) {
  return u.startsWith('/');
}

function isRel(u) {
  return u.startsWith('./') || u.startsWith('../');
}

function isHttp(u) {
  return u.startsWith('http://') || u.startsWith('https://');
}

export function normalizeImport(spec, importerUrlPath) {
  if (isHttp(spec)) return null;
  if (isAbs(spec)) return spec;
  if (isRel(spec)) {
    const base = posix.dirname(importerUrlPath);
    const joined = posix.normalize(posix.join(base, spec));
    return joined.startsWith('/') ? joined : '/' + joined;
  }
  return '/@modules/' + spec;
}

class ModuleNode {
  constructor(url) {
    this.url = url;
    // 這個模組 import 了那些模組
    this.deps = new Set();
    // 哪寫模組 import 了這個模組
    this.importers = new Set();
  }
}

export class ModuleGraph {
  constructor() {
    this.nodes = new Map();
  }

  ensure(url) {
    let n = this.nodes.get(url);
    if (!n) {
      n = new ModuleNode(url);
      this.nodes.set(url, n);
    }
    return n;
  }

  setDeps(url, depList) {
    const node = this.ensure(url);
    const next = new Set(depList);

    for (const d of node.deps) {
      if (!next.has(d)) {
        const depNode = this.nodes.get(d);
        if (depNode) depNode.importers.delete(url);
        node.deps.delete(d);
      }
    }

    for (const d of next) {
      node.deps.add(d);
      this.ensure(d).importers.add(url);
    }
  }

  recordFromCode(url, transformedCode) {
    const specs = scanImports(transformedCode);
    const deps = specs
      .map(s => normalizeImport(s, url))
      .filter(s => Boolean(s));

    this.setDeps(url, deps);
  }

  toJSON() {
    return {
      nodes: Array.from(this.nodes.values()).map(n => ({
        url: n.url,
        deps: Array.from(n.deps),
        importers: Array.from(n.importers)
      }))
    };
  }

  collectAffected(url) {
    const res = new Set();
    const visit = u => {
      if (res.has(u)) return;
      res.add(u);
      const node = this.nodes.get(u);
      if (!node) return;
      for (const p of node.importers) visit(p);
    };
    visit(url);
    return Array.from(res);
  }
}

### mini-vite/core/rewriter.js

import path, { posix } from 'path';

export function isBareImport(spec) {
return (
!spec.startsWith('/') &&
!spec.startsWith('./') &&
!spec.startsWith('../') &&
!spec.startsWith('http://') &&
!spec.startsWith('https://')
);
}
export function isRelativeImport(spec) {
return spec.startsWith('./') || spec.startsWith('../');
}

// ctx: { isModuleRequest?: boolean, urlBase?: string }
export function rewriteSpecifier(spec, ctx = {}) {
if (ctx.isModuleRequest && isRelativeImport(spec)) {
const base = ctx.urlBase || '/';
const absUrl = posix.normalize(posix.join(base, spec));
return absUrl;
}
if (isBareImport(spec)) return `/@modules/${spec}`;
return spec;
}

export function rewriteImports(code, ctx) {
const R = (s) => rewriteSpecifier(s, ctx);
code = code.replace(/from\s+(['"])([^'"]+)\1/g, (m, q, s) => `from ${q}${R(s)}${q}`);
code = code.replace(/import\s+(['"])([^'"]+)\1/g, (m, q, s) => `import ${q}${R(s)}${q}`);
code = code.replace(/export\s+[^;]_\s+from\s+(['"])([^'"]+)\1/g, (m, q, s) => m.replace(s, R(s)));
code = code.replace(/import\(\s_(['"])([^'"]+)\1\s\*\)/g, (m, q, s) => `import(${q}${R(s)}${q})`);
return code;
}

export function wrapJsonAsJs(jsonText) {
return `export default ${jsonText};\n`;
}

// 會在首載時建立/重用 <style data-mv-href="id">
export function wrapCssAsJs(cssText, id = '') {
const cssStr = JSON.stringify(cssText);
const idStr = JSON.stringify(id);
return (
`    const css = ${cssStr};
    const id = ${idStr};
    let style = document.querySelector('style[data-mv-href=' + JSON.stringify(id) + ']');
    if (!style) {
      style = document.createElement('style');
      style.setAttribute('type', 'text/css');
      if (id) style.setAttribute('data-mv-href', id);
      document.head.appendChild(style);
    }
    style.innerHTML = css;
    export default css;
 `.trim() + '\n'
);
}

### mini-vite/core/resolver.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const **filename = fileURLToPath(import.meta.url);
const **dirname = path.dirname(\_\_filename);

export function parseModuleRequest(urlPath) {
const after = urlPath.slice('/@modules/'.length);
const segs = after.split('/').filter(Boolean);
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

export function ensureJsLike(p) {
if (path.extname(p)) return p;
if (fs.existsSync(p + '.js')) return p + '.js';
else if (fs.existsSync(p + '.mjs')) return p + '.mjs';
else if (fs.existsSync(p + '.ts')) return p + '.ts';
}

export function resolveModuleEntry(moduleName, subPath) {
// **dirname 指向 mini-vite/core
const projectRoot = path.resolve(**dirname, '..'); // mini-vite/
const pkgDir = path.join(projectRoot, 'node_modules', moduleName);
const pkgJsonPath = path.join(pkgDir, 'package.json');
if (!fs.existsSync(pkgJsonPath)) {
throw new Error(`Cannot find package.json for ${moduleName}`);
}
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

if (subPath) {
return ensureJsLike(path.join(pkgDir, subPath));
}

let candidate = null;
if (typeof pkg.exports === 'string') candidate = pkg.exports;
else if (pkg.exports && typeof pkg.exports === 'object' && typeof pkg.exports['.'] === 'string')
candidate = pkg.exports['.'];
else if (pkg.module) candidate = pkg.module;
else if (typeof pkg.browser === 'string') candidate = pkg.browser;
else if (typeof pkg.main === 'string') candidate = pkg.main;
else candidate = 'index.js';

return path.join(pkgDir, candidate);
}

export function safeJoin(root, urlPath) {
const normalized = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/g, '');
return path.join(root, normalized);
}

### mini-vite/core/static.js

export function getContentType(filePath) {
if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
if (filePath.endsWith('.svg')) return 'image/svg+xml';
return 'text/plain; charset=utf-8';
}

### mini-vite/index.html

<!DOCTYPE html>
<html>
  <head>
    <title>Mini Vite</title>
  </head>
  <body>
    <h1>Hello Mini Vite</h1>
    <div id="app"></div>
    <script type="module" src="/error-overlay.js"></script>
    <script type="module" src="/src/main.js"></script>
    <script type="module" src="/livereload.js"></script>
  </body>
</html>

### mini-vite/src/main.js

import './style.css';
import data from './data.json';

document.querySelector('#app').innerHTML = `

  <pre>data.json = ${JSON.stringify(data, null, 2)}</pre>

`;

// 可選：測試裸模組（若已安裝 lodash-es）
// import { shuffle } from 'lodash-es';
// console.log('shuffle test', shuffle([1,2,3,4]));

### mini-vite/src/style.css

body { font-family: system-ui, sans-serif; }
h1 { margin: 16px 0; }
#app { padding: 12px; border: 1px dashed #888; }

### mini-vite/src/data.json

{ "hello": "world" }

### error-overlay.js

const ID = '__mini_vite_error_overlay';

function ensureOverlay() {
  let el = document.getElementById(ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = ID;
  el.style.position = 'fixed';
  el.style.inset = '0';
  el.style.background = 'rgba(0,0,0,0.66)';
  el.style.color = '#fff';
  el.style.fontFamily =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  el.style.zIndex = '2147483647';
  el.style.display = 'none';
  el.style.overflow = 'auto';

  const inner = document.createElement('div');
  inner.style.maxWidth = '960px';
  inner.style.margin = '40px auto';
  inner.style.padding = '16px 20px';
  inner.style.background = '#111';
  inner.style.border = '1px solid #444';
  inner.style.borderRadius = '8px';
  inner.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <h2 style="margin:0;font-size:20px;">⚠️ Runtime Error</h2>
      <button id="__mv_close" style="font-size:14px;background:#333;color:#fff;border:1px solid #555;border-radius:6px;padding:6px 10px;cursor:pointer;">Dismiss</button>
    </div>
    <pre id="__mv_msg" style="white-space:pre-wrap;line-height:1.4;font-size:13px;"></pre>
  `;

  el.appendChild(inner);
  document.body.appendChild(el);

  inner.querySelector('#__mv_close').addEventListener('click', () => {
    el.style.display = 'none';
  });

  return el;
}

function formatError(errLike) {
  if (!errLike) return 'Unknown error';
  if (typeof errLike === 'string') return errLike;
  const name = errLike.name || 'Error';
  const msg = errLike.message || String(errLike);
  const stack = errLike.stack || '';
  return `${name}: ${msg}\n\n${stack}`;
}

function showErrorOverlay(err) {
  const el = ensureOverlay();
  const msgEl = el.querySelector('#__mv_msg');
  msgEl.textContent = formatError(err);
  el.style.display = 'block';
}

function clearOverlay() {
  const el = document.getElementById(ID);
  if (el) el.style.display = 'none';
}

window.addEventListener('error', e => {
  showErrorOverlay(
    e.error || {
      name: 'Error',
      message: e.message,
      stack: e?.error?.stack || ''
    }
  );
});

window.addEventListener('unhandledrejection', e => {
  const reason =
    e.reason instanceof Error ? e.reason : new Error(String(e.reason));
  showErrorOverlay(reason);
});

if (window.__mini_vite_hmr?.ws) {
  window.__mini_vite_hmr.ws.addEventListener('message', e => {
    try {
      const msg = JSON.parse(e.data);
      if (msg?.type === 'full-reload') clearOverlay();
    } catch {}
  });
}

export { showErrorOverlay, clearOverlay };

已完成能力（Day 1–10）

靜態資源服務（含 JSON/CSS → ESM 包裝）
SSE Live Reload
裸模組解析（/@modules/pkg → node_modules/pkg/...）
CSS HMR（使用 ?raw 請求並替換 <style>）
debounce 穩定化 reload / CSS 更新聚合
三層結構：rewriter / resolver / static 拆分
HMR 通道（WebSocket 原生握手與訊息推送）
新增 core/graph.js
建立 Module Graph（url → deps[] / importers[]）
每次傳送 JS 模組時記錄其依賴關係
提供 /__graph.json 端點檢視當前模組圖
import.meta.hot.accept() 最小實作
錯誤覆蓋層 & 快取控制 — 顯示 runtime 錯誤 overlay；簡單 ETag 或時間戳避免快取干擾。

後續天數規劃（Day 13–30）

Day 13：依賴預編譯（概念版） — 把常用依賴預打包到 /deps/\*，回應時優先改寫，並加強快取標頭。

Day 14：週小結 — 鞏固 CSS/JS HMR 與 pre-bundle 穩定性。

Day 15：最小 Build（Rollup 單入口） — 整合 Rollup 實作生產輸出（ESM）。

Day 16：多入口 / Code Splitting — 輸出拆分、動態 import。

Day 17：輸出格式 — 支援 ESM / CJS 輸出。

Day 18：CSS 抽離與生產注入 — 開發注入、產出抽離，link 標籤策略。

Day 19：資產處理 — 圖片/字型/JSON，附檔名 hash。

Day 20：環境變數 — .env 與 import.meta.env 替換。

Day 21：週小結 — 完成可發佈的 build pipeline。

Day 22：Plugin 介面 — resolveId / load / transform。

Day 23：示範插件 — e.g. 字串替換或 Banner 注入。

Day 24：框架插件 — React 或 Vue 最小可行（選一）。

Day 25：別名與自訂解析 — alias、打通 resolveId。

Day 26：模式切換 — dev / build 與 --mode。

Day 27：快取策略 — in-memory + 檔案快取。

Day 28：CLI — mini-vite dev/build/preview。

Day 29：測試與範例驗收 — e2e/手動腳本。

Day 30：文件與最終整理 — README、架構圖、限制與未來工作。
```
