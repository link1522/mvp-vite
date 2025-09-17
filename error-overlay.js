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
