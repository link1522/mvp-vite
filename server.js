import http from 'http';
import fs from 'fs';
import path from 'path';
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

// 監聽 index.html
const INDEX_PATH = path.join(__dirname, 'index.html');
fs.watch(INDEX_PATH, { persistent: true }, eventType => {
  if (eventType === 'change') {
    console.log('[mini-vite] index.html changed → reload');
    boroadcastReload();
  }
});

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

  const filePath = path.join(
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

    res.writeHead(200, {
      'Content-Type': getContentType(filePath),
      'cache-control': 'no-store'
    });
    res.end(data);
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
