// Isolated-world relay: forwards what hook-main.js saw to the extension (batched).
(() => {
  if (window.__evkRelay) return;
  window.__evkRelay = true;
  const isTop = window === window.top;
  let buf = [];
  let timer = null;

  function send(msg) {
    try {
      const r = chrome.runtime.sendMessage(msg);
      if (r && r.catch) r.catch(() => {});
    } catch (e) {} // extension was reloaded: ignore
  }
  function take() {
    clearTimeout(timer);
    timer = null;
    const batch = buf;
    buf = [];
    return batch;
  }
  function flush() {
    const batch = take();
    if (batch.length) send({ type: 'hookLog', batch });
  }
  // read by the background right before a capture, so entries from the last second are not missed
  window.__evkTake = take;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__evk !== 1) return;
    buf.push({ kind: d.kind, data: d.data });
    // one message per second at most (every frame of every tab reports here, so keep the traffic low)
    if (buf.length >= 200) flush();
    else if (!timer) timer = setTimeout(flush, 1000);
  });
  window.addEventListener('pagehide', flush);
  // flush before the user captures from a hidden/background state, too
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  if (isTop) send({ type: 'hookPage', url: location.href });
})();
