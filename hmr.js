(function () {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = proto + '//' + location.host + '/__hmr';
  const ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    console.log('[mini-vite] HMR connected');
  });

  ws.addEventListener('close', () => {
    console.log('[mini-vite] HMR disconnected');
  });

  async function updateCss(path) {
    try {
      const sep = path.includes('?') ? '&' : '?';
      const res = await fetch(path + sep + 'raw=1&t=' + Date.now(), {
        cache: 'no-cache'
      });
      const css = await res.text();
      const style = document.querySelectorAll(`style[data-mv-href="${path}"]`);
      if (style.length) {
        style.forEach((el) => (el.textContent = css));
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

  ws.addEventListener('message', (e) => {
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
          } else {
            // 其他型別（將在 Day 11 之後支援）
            console.log('[mini-vite] HMR update (ignored)', u);
          }
        }
        return;
      }
    } catch (err) {
      console.warn('[mini-vite] HMR invalid message', e.data);
    }
  });

  // 暴露 debug 入口
  window.__mini_vite_hmr = { ws };
})();
