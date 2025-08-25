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

  ws.addEventListener('message', (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg && msg.type === 'full-reload') {
        console.log('[mini-vite] HMR full-reload');
        location.reload();
        return;
      }

      if (msg && msg.type === 'update') {
        // 先占位：Day 9/11 逐步支援 CSS/JS HMR
        console.log('[mini-vite] HMR update', msg);
        // 目前不處理，保留為後續擴充點
      }
    } catch (err) {
      console.warn('[mini-vite] HMR invalid message', e.data);
    }
  });

  // 暴露 debug 入口
  window.__mini_vite_hmr = { ws };
})();
