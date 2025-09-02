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
