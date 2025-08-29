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
import { url } from 'inspector';

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

// server 主程式
const server = http.createServer((req, res) => {
  const rawUrl = decodeURIComponent(req.url || '/');
  const u = new URL(rawUrl, 'http://localhost');
  const urlPath = u.pathname;

  if (urlPath === '/__graph.json') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
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
      'cache-control': 'no-store'
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

      const code = fs.readFileSync(absPath, 'utf-8');
      const transformed = rewriteImports(code, {
        isModuleRequest: true,
        urlBase
      });

      moduleGraph.recordFromCode(urlPath, transformed);

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
    urlPath === '/' ? '/index.html' : urlPath
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
      const isRaw = u.searchParams.has('raw');
      if (isRaw) {
        res.writeHead(200, {
          'content-type': 'text/css; charset=utf-8',
          'cache-control': 'no-store'
        });
        res.end(data.toString('utf-8'));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(wrapCssAsJs(data.toString('utf-8'), urlPath));
      return;
    }

    const ct = getContentType(filePath);

    res.writeHead(200, {
      'Content-Type': ct,
      'cache-control': 'no-store'
    });

    if (ct === 'application/javascript; charset=utf-8') {
      const transformed = rewriteImports(data.toString('utf-8'));
      moduleGraph.recordFromCode(urlPath, transformed);
      res.end(transformed);
    } else {
      res.end(data);
    }
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

  // 目前不處理 client->server 訊息；忽略資料（可在 Day 11 擴充）
  socket.on('data', () => {});
});

server.listen(PORT, () => {
  console.log(
    `Mini Vite dev server with Live Reload at http://localhost:${PORT}`
  );
  console.log('Module graph endpoint: http://localhost:%d/__graph.json', PORT);
});
