// Step guide recorder (Scribe-style): every click / typed field becomes a step with a screenshot.
// Also used by the screen recorder ("rec" mode: no floating panel, steps go to the recorder window).
(() => {
  const REC = window.__evkStepMode === 'rec';
  window.__evkStepMode = null;
  const FLAG = REC ? '__evkRec' : '__evkGuide';
  if (window[FLAG]) return;
  window[FLAG] = true;

  let paused = false;
  let count = 0;
  let typing = true;
  let values = false;
  let off = false;

  // ---------- floating panel (closed shadow DOM, hidden during every capture) ----------
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
  <style>
    .p{display:flex;align-items:center;gap:8px;background:#111827;color:#fff;border-radius:999px;padding:7px 8px 7px 12px;font:13px Arial,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35)}
    .dot{width:9px;height:9px;border-radius:50%;background:#ef4444;animation:b 1.2s infinite}
    .dot.paused{background:#9ca3af;animation:none}
    @keyframes b{50%{opacity:.25}}
    .n{background:#374151;border-radius:999px;padding:1px 8px;font-weight:700}
    button{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;background:#374151;font:12px Arial,sans-serif}
    button:hover{background:#4b5563}
    button.stop{background:#dc2626}
    button.stop:hover{background:#b91c1c}
  </style>
  <div class="p"><svg width="20" height="20" viewBox="0 0 128 128" style="flex:none;display:block"><defs><linearGradient id="evkg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#e11d48"/></linearGradient></defs><rect x="4" y="4" width="120" height="120" rx="28" fill="url(#evkg)"/><path d="M44 38l6-10h28l6 10h12a10 10 0 0 1 10 10v40a10 10 0 0 1-10 10H32a10 10 0 0 1-10-10V48a10 10 0 0 1 10-10z" fill="#fff"/><circle cx="64" cy="68" r="19" fill="#e11d48"/><circle cx="64" cy="68" r="9" fill="#fff"/></svg><span class="dot" id="dot"></span><span>Recording steps</span><span class="n" id="n">0</span>
  <button id="pause">Pause</button><button id="stop" class="stop">Finish</button></div>`;
  if (!REC) document.documentElement.append(host);
  const $ = (s) => root.querySelector(s);
  const setCount = (n) => { count = n; $('#n').textContent = String(n); };
  const setPaused = (p) => {
    paused = p;
    $('#pause').textContent = p ? 'Resume' : 'Pause';
    $('#dot').className = 'dot' + (p ? ' paused' : '');
  };

  $('#pause').addEventListener('click', () => {
    setPaused(!paused);
    chrome.runtime.sendMessage({ type: 'guidePause', paused });
  });
  $('#stop').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'guideStop' }));

  function teardown() {
    off = true;
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('focusin', onFocusIn, true);
    host.remove();
    window[FLAG] = false;
  }
  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === (REC ? 'recStepsOff' : 'guideOff')) teardown(); });

  // ---------- helpers ----------
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  function textOf(el) {
    return clean(el.getAttribute('aria-label') || el.innerText || el.value || el.title || el.alt || el.getAttribute('placeholder') || '');
  }
  function labelOf(el) {
    let t = '';
    try { if (el.labels && el.labels[0]) t = el.labels[0].innerText; } catch (e) {}
    return clean(t || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.title || el.name || el.id || el.type || 'field');
  }
  const TEXTY = /^(text|search|email|url|tel|password|number|date|time|datetime-local|month|week|)$/i;
  const isTextField = (el) => el && ((el.tagName === 'INPUT' && TEXTY.test(el.type || '')) || el.tagName === 'TEXTAREA' || el.isContentEditable);

  function pickTarget(t) {
    return (t.closest && t.closest('a,button,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],input,select,textarea,label,summary,li,td,th,img')) || t;
  }

  // where this page sits on the screen (for screen recordings, whose step pictures come from the whole screen)
  let offX = null, offY = null;
  function geo() {
    const bw = Math.max(0, (outerWidth - innerWidth) / 2);
    return {
      ox: offX != null ? offX : screenX + bw, // top-left of the web page on the screen
      oy: offY != null ? offY : screenY + Math.max(0, outerHeight - innerHeight - bw),
      iw: innerWidth, ih: innerHeight, // size of the web page
      wx: screenX, wy: screenY, ow: outerWidth, oh: outerHeight, // the browser window
      sl: screen.availLeft || 0, st: screen.availTop || 0, sw: screen.width, sh: screen.height, // this screen
    };
  }

  function send(payload) {
    payload.pageTitle = document.title || '';
    payload.ts = Date.now();
    payload.geo = geo();
    if (REC) payload.type = 'recStep';
    host.style.visibility = 'hidden';
    const restore = () => { host.style.visibility = 'visible'; };
    const timer = setTimeout(restore, 3000);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        try {
          chrome.runtime.sendMessage(payload).then((r) => {
            clearTimeout(timer);
            restore();
            if (r && r.count != null) setCount(r.count);
          }).catch(() => { clearTimeout(timer); restore(); });
        } catch (e) { restore(); }
      })
    );
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    // huge elements (page wrappers) -> highlight only the click point
    if (r.width * r.height > innerWidth * innerHeight * 0.55) return null;
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), w: r.width, h: r.height };
  }

  const lastTyped = new WeakMap();
  let focusEl = null;
  let focusVal = '';
  function onFocusIn(e) {
    if (isTextField(e.target)) { focusEl = e.target; focusVal = e.target.value || ''; }
  }

  function typedStep(el) {
    if (!typing || !isTextField(el)) return;
    const val = el.value != null ? el.value : el.innerText;
    if (lastTyped.get(el) === val || val === focusVal && focusEl === el && val === '') return;
    lastTyped.set(el, val);
    const label = labelOf(el);
    const secret = (el.type || '').toLowerCase() === 'password';
    const title = values && !secret && val ? `Type "${clean(val)}" in "${label}"` : `Type in "${label}"`;
    send({ type: 'guideClick', kind: 'type', title, rect: rectOf(el), pt: null, vw: innerWidth, url: location.href });
  }

  function onChange(e) {
    if (off || paused) return;
    const el = e.target;
    if (isTextField(el)) return typedStep(el);
    if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      send({ type: 'guideClick', kind: 'select', title: `Select "${clean(opt ? opt.text : el.value)}" in "${labelOf(el)}"`, rect: rectOf(el), pt: null, vw: innerWidth, url: location.href });
    } else if (el.tagName === 'INPUT' && el.type === 'file') {
      send({ type: 'guideClick', kind: 'upload', title: `Upload a file in "${labelOf(el)}"`, rect: rectOf(el), pt: null, vw: innerWidth, url: location.href });
    }
  }

  function onDown(e) {
    offX = e.screenX - e.clientX; // exact position of the page on the screen
    offY = e.screenY - e.clientY;
    if (off || paused || e.button !== 0) return;
    if (e.composedPath().includes(host)) return;
    // finish a field the user was typing in before this click moves focus away
    if (focusEl && document.activeElement === focusEl && (focusEl.value || '') !== focusVal) {
      typedStep(focusEl);
      focusVal = focusEl.value || '';
    }
    const el = pickTarget(e.target);
    const tag = el.tagName;
    // text fields / selects are described by their change event, not by the click that focuses them
    if (isTextField(el) || tag === 'SELECT' || (tag === 'INPUT' && el.type === 'file')) return;

    let title;
    const text = textOf(el);
    if (tag === 'INPUT' && el.type === 'checkbox') title = `${el.checked ? 'Uncheck' : 'Check'} "${labelOf(el)}"`;
    else if (tag === 'INPUT' && el.type === 'radio') title = `Select "${labelOf(el)}"`;
    else if (tag === 'A') title = text ? `Click the "${text}" link` : 'Click the link';
    else if (tag === 'BUTTON' || (tag === 'INPUT' && /button|submit|reset/.test(el.type)) || el.getAttribute('role') === 'button') title = text ? `Click "${text}"` : 'Click the button';
    else title = text ? `Click on "${text}"` : 'Click here';

    send({ type: 'guideClick', kind: 'click', title, rect: rectOf(el), pt: { x: e.clientX, y: e.clientY }, vw: innerWidth, url: location.href });
  }

  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('focusin', onFocusIn, true);

  // sync with background state (survives page navigations)
  chrome.runtime.sendMessage({ type: REC ? 'recStepsState' : 'guideState' }).then((s) => {
    if (!s || !s.active) return teardown();
    typing = s.typing !== false;
    values = !!s.values;
    setCount(s.count || 0);
    setPaused(!!s.paused);
  }).catch(() => {});
})();
