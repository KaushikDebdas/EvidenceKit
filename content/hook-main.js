// Runs inside the page (MAIN world) at document_start: records console output, errors and network calls.
// No debugging banner, no extra permission. Messages are handed to hook-relay.js via window.postMessage.
(() => {
  if (window.__evkHooked) return;
  window.__evkHooked = true;

  const MAXLEN = 1500;
  let seq = 0;
  const nid = () => 'h' + ++seq;
  const post = (kind, data) => {
    try { window.postMessage({ __evk: 1, kind, data }, '*'); } catch (e) {}
  };
  const abs = (u) => {
    try { return new URL(String(u), location.href).href; } catch (e) { return String(u); }
  };

  function fmt(v) {
    try {
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.stack || v.name + ': ' + v.message;
      if (v === null || v === undefined) return String(v);
      if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
      if (typeof v !== 'object') return String(v);
      if (typeof Node !== 'undefined' && v instanceof Node) return '<' + String(v.nodeName).toLowerCase() + '>';
      const s = JSON.stringify(v, (k, val) => (typeof val === 'function' ? '[Function]' : typeof Node !== 'undefined' && val instanceof Node ? '<node>' : val));
      return s === undefined ? String(v) : s;
    } catch (e) {
      try { return Object.prototype.toString.call(v); } catch (e2) { return '[unprintable]'; }
    }
  }

  // ---- console ----
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const orig = console[level];
    if (typeof orig !== 'function') return;
    console[level] = function (...args) {
      try {
        post('console', { level, text: args.map(fmt).join(' ').slice(0, MAXLEN), ts: Date.now() });
      } catch (e) {}
      return orig.apply(this, args);
    };
  });

  window.addEventListener(
    'error',
    (e) => {
      try {
        const t = e.target;
        if (t && t !== window && (t.src || t.href)) {
          post('console', { level: 'error', text: 'Failed to load resource: ' + (t.src || t.href), ts: Date.now() });
        } else {
          post('console', {
            level: 'error',
            text: 'Uncaught ' + (e.message || 'error') + (e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''),
            ts: Date.now(),
          });
        }
      } catch (err) {}
    },
    true
  );
  window.addEventListener('unhandledrejection', (e) => {
    try { post('console', { level: 'error', text: 'Unhandled promise rejection: ' + fmt(e.reason).slice(0, MAXLEN), ts: Date.now() }); } catch (err) {}
  });

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let id, t0;
      try {
        id = nid(); t0 = performance.now();
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const url = abs(typeof input === 'string' ? input : (input && input.url) || input);
        post('net', { phase: 'start', id, method, url, ts: Date.now(), type: 'fetch' });
      } catch (e) {}
      const p = origFetch.apply(this, arguments);
      try {
        p.then(
          (res) => post('net', { phase: 'end', id, status: res.status, statusText: res.statusText, duration: performance.now() - t0, mime: (res.headers && res.headers.get('content-type')) || '' }),
          (err) => post('net', { phase: 'end', id, failed: true, error: String((err && err.message) || err), duration: performance.now() - t0 })
        );
      } catch (e) {}
      return p;
    };
  }

  // ---- XMLHttpRequest ----
  try {
    const XO = XMLHttpRequest.prototype.open;
    const XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { this.__evk = { method: String(m).toUpperCase(), url: abs(u) }; } catch (e) {}
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        const q = this.__evk;
        if (q) {
          q.id = nid(); q.t0 = performance.now();
          post('net', { phase: 'start', id: q.id, method: q.method, url: q.url, ts: Date.now(), type: 'xhr' });
          this.addEventListener('loadend', () => {
            const bad = this.status === 0;
            post('net', {
              phase: 'end', id: q.id, status: this.status, statusText: this.statusText, duration: performance.now() - q.t0,
              failed: bad, error: bad ? 'network error / aborted' : undefined,
              mime: (this.getResponseHeader && this.getResponseHeader('content-type')) || '',
            });
          }, { once: true });
        }
      } catch (e) {}
      return XS.apply(this, arguments);
    };
  } catch (e) {}

  // ---- other resources (scripts, css, images ...) ----
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') continue;
        post('net', {
          phase: 'resource', id: nid(), method: 'GET', url: e.name,
          ts: Math.round(performance.timeOrigin + e.startTime), type: e.initiatorType || 'resource',
          status: e.responseStatus || 0, duration: e.duration, size: e.transferSize || 0,
        });
      }
    }).observe({ type: 'resource', buffered: true });
  } catch (e) {}
})();
