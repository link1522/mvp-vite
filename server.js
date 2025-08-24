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
