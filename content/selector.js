// On-page selection overlay for: area, dual (two areas -> one image) and element capture.
// Injected on demand by the background worker after it sets window.__evkSelCfg = { mode, frozen }.
//  - frozen: data URL of a screenshot taken just before the overlay appeared. The user selects on
//    that still image, so dropdowns, tooltips and hover menus stay exactly as they were.
//  - Scrolling with the mouse wheel switches to "live" mode (frozen image removed, page scrolls);
//    the background then takes a fresh screenshot when the selection is finished.
(() => {
  if (window.__evkSelecting) return;
  window.__evkSelecting = true;
  const cfg = window.__evkSelCfg || { mode: 'area' };
  const mode = cfg.mode || 'area';
  let live = !cfg.frozen;

  const host = document.createElement('div');
  host.setAttribute('data-evk', 'selector');
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  *{box-sizing:border-box}
  .frz{position:fixed;left:0;top:0;user-select:none;-webkit-user-drag:none;pointer-events:none}
  .dim{position:fixed;inset:0;background:rgba(15,23,42,.35)}
  .box{position:fixed;border:2px solid #6366f1;box-shadow:0 0 0 99999px rgba(15,23,42,.45);display:none;pointer-events:none;border-radius:2px}
  .box.done{border-color:#22c55e;box-shadow:none;background:rgba(34,197,94,.10)}
  .box.el{border-color:#f59e0b;background:rgba(245,158,11,.10)}
  .tag{position:absolute;left:-2px;top:-26px;background:#111827;color:#fff;font:600 12px/1 system-ui,Arial,sans-serif;padding:5px 7px;border-radius:6px;white-space:nowrap}
  .num{position:absolute;left:6px;top:6px;width:24px;height:24px;border-radius:50%;background:#22c55e;color:#fff;font:700 13px/24px system-ui,Arial;text-align:center;border:2px solid #fff}
  .bar{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:10px;align-items:center;background:#111827;color:#f9fafb;
       font:13px/1.3 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;padding:8px 10px 8px 14px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:auto;cursor:default;max-width:92vw}
  .bar b{color:#a5b4fc;font-weight:600}
  .bar kbd{font:11px ui-monospace,Consolas,monospace;background:#374151;border-radius:4px;padding:1px 5px;color:#e5e7eb}
  .bar button{all:unset;white-space:nowrap;cursor:pointer;background:#374151;color:#fff;border-radius:8px;padding:5px 10px;font:600 12px system-ui,Arial}
  .bar button:hover{background:#4b5563}
  .bar .pill{white-space:nowrap;background:#4f46e5;border-radius:999px;padding:2px 8px;font-weight:600;font-size:12px}
</style>
<img class="frz" alt="">
<div class="dim"></div>
<div class="box" id="b1"><span class="tag"></span></div>
<div class="box done" id="b0"><span class="num">1</span></div>
<div class="bar"><svg width="22" height="22" viewBox="0 0 128 128" style="flex:none;display:block"><defs><linearGradient id="evkg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#e11d48"/></linearGradient></defs><rect x="4" y="4" width="120" height="120" rx="28" fill="url(#evkg)"/><path d="M44 38l6-10h28l6 10h12a10 10 0 0 1 10 10v40a10 10 0 0 1-10 10H32a10 10 0 0 1-10-10V48a10 10 0 0 1 10-10z" fill="#fff"/><circle cx="64" cy="68" r="19" fill="#e11d48"/><circle cx="64" cy="68" r="9" fill="#fff"/></svg><span class="pill"></span><span class="msg"></span><button id="cancel">Cancel (Esc)</button></div>`;
  const $ = (s) => root.querySelector(s);
  const frz = $('.frz'), dim = $('.dim'), box = $('#b1'), tag = $('.tag'), done = $('#b0');
  if (cfg.frozen) {
    frz.src = cfg.frozen;
    frz.style.width = innerWidth + 'px';
    frz.style.height = innerHeight + 'px';
    dim.style.background = 'rgba(15,23,42,.18)';
  } else frz.remove();

  const TITLES = { area: 'Select area', dual: 'Dual select', element: 'Capture element', scroll: 'Scroll box' };
  const PICK = mode === 'element' || mode === 'scroll'; // hover + click modes
  let step = 0; // dual: 0 = first area, 1 = second area
  function setBar() {
    $('.pill').textContent = TITLES[mode] + (mode === 'dual' ? ` · ${step + 1}/2` : '');
    const scroll = ' Mouse wheel scrolls the page.';
    $('.msg').innerHTML =
      mode === 'scroll'
        ? 'Hover a scrolling list, table, chat or frame and <b>click</b> it — it is scrolled and captured in full.'
        : mode === 'element'
        ? 'Hover an element and <b>click</b> it. <kbd>↑</kbd> parent <kbd>↓</kbd> child <kbd>Enter</kbd> capture.' + scroll
        : mode === 'dual'
          ? (step === 0 ? 'Drag to select the <b>first</b> area.' : 'Now drag the <b>second</b> area.') + scroll
          : 'Drag to select an area.' + scroll;
  }
  setBar();
  document.documentElement.append(host);

  const send = (m) => { try { return chrome.runtime.sendMessage({ mode, ...m }).catch(() => {}); } catch (e) { return Promise.resolve(); } };
  // Chrome stops an idle extension worker after ~30 s, and the frozen screenshot lives there:
  // a ping now and then keeps it awake while the user is still selecting.
  const ping = setInterval(() => send({ type: 'selPing' }), 20000);
  function cleanup() {
    clearInterval(ping);
    host.remove();
    window.removeEventListener('keydown', onKey, true);
    window.__evkSelecting = false;
    window.__evkSelCfg = null;
  }
  function cancel() { cleanup(); send({ type: 'selCancel' }); }
  $('#cancel').addEventListener('click', (e) => { e.stopPropagation(); cancel(); });
  $('.bar').addEventListener('mousedown', (e) => e.stopPropagation());

  // ---- live mode: frozen image goes away, wheel scrolls the real page ----
  function goLive() {
    if (live) return;
    live = true;
    if (mode === 'dual' && step === 1) done.style.display = 'none'; // area 1 was cropped from the frozen image already
    frz.remove();
    dim.style.background = 'rgba(15,23,42,.30)';
  }
  host.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (mode === 'dual' && step === 1 && !live && firstRect) send({ type: 'selPart', rect: firstRect, vw: innerWidth });
    goLive();
    scrollBy(e.deltaX, e.deltaY);
    if (PICK && hoverEl) drawEl();
  }, { passive: false });

  // ---- area / dual ----
  let sx = 0, sy = 0, drawing = false, firstRect = null;
  const rectOf = (e) => ({ x: Math.min(sx, e.clientX), y: Math.min(sy, e.clientY), w: Math.abs(e.clientX - sx), h: Math.abs(e.clientY - sy) });
  function showBox(r) {
    box.style.display = 'block';
    Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    tag.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    tag.style.top = r.y < 30 ? '4px' : '-26px';
    tag.style.left = r.y < 30 ? '4px' : '-2px';
  }

  function finishParts(parts) {
    cleanup();
    send({ type: 'selDone', mode, parts, live, vw: innerWidth, vh: innerHeight });
  }

  if (!PICK) {
    host.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drawing = true; sx = e.clientX; sy = e.clientY;
      showBox({ x: sx, y: sy, w: 0, h: 0 });
    });
    host.addEventListener('mousemove', (e) => { if (drawing) showBox(rectOf(e)); });
    host.addEventListener('mouseup', (e) => {
      if (!drawing) return;
      drawing = false;
      const r = rectOf(e);
      box.style.display = 'none';
      if (r.w < 6 || r.h < 6) return; // a click, not a drag: keep selecting
      if (mode === 'dual' && step === 0) {
        firstRect = r;
        step = 1;
        Object.assign(done.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
        if (live) { finishPartLive(r); return; }
        setBar();
        return;
      }
      if (mode === 'dual') {
        // if area 1 was already handed over (scroll happened), only area 2 is left
        const parts = live ? [r] : [firstRect, r];
        finishParts(parts);
        return;
      }
      finishParts([r]);
    });
  }

  // dual select without a frozen image: area 1 must be captured before the overlay can stay up
  function finishPartLive(r) {
    host.style.visibility = 'hidden';
    send({ type: 'selPartLive', rect: r, vw: innerWidth }).then(() => {
      host.style.visibility = '';
      done.style.display = 'none';
      setBar();
    });
  }

  // ---- element ----
  let hoverEl = null;
  function elAt(x, y) {
    host.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    host.style.pointerEvents = '';
    return el && el !== host ? el : null;
  }
  function scrollableOf(el) {
    for (let e = el; e && e !== document.documentElement && e !== document.body; e = e.parentElement) {
      if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') return e;
      const cs = getComputedStyle(e);
      const canY = /(auto|scroll|overlay)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 4;
      const canX = /(auto|scroll|overlay)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 4;
      if (canY || canX) return e; // scrolls up/down, sideways, or both
    }
    return null;
  }
  function drawEl() {
    if (!hoverEl) { box.style.display = 'none'; return; }
    const r = hoverEl.getBoundingClientRect();
    box.classList.add('el');
    showBox({ x: r.left, y: r.top, w: r.width, h: r.height });
    const name = hoverEl.tagName.toLowerCase() + (hoverEl.id ? '#' + hoverEl.id : '') + (typeof hoverEl.className === 'string' && hoverEl.className.trim() ? '.' + hoverEl.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    tag.textContent = mode === 'scroll' && hoverEl.tagName !== 'IFRAME' && hoverEl.tagName !== 'FRAME'
      ? `${name.slice(0, 50)} · ${Math.round(hoverEl.scrollWidth)} × ${Math.round(hoverEl.scrollHeight)} px`
      : `${name.slice(0, 60)}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
  }
  function pickScroll() {
    if (!hoverEl) return;
    const el = hoverEl;
    const isFrame = el.tagName === 'IFRAME' || el.tagName === 'FRAME';
    window.__evkScrollEl = el; // read back by the background worker
    cleanup();
    send({ type: 'selDone', mode, scroll: { kind: isFrame ? 'frame' : 'el', src: isFrame ? el.src : '', cw: el.clientWidth, ch: el.clientHeight }, vw: innerWidth, vh: innerHeight });
  }
  function pickEl() {
    if (!hoverEl) return;
    const r = hoverEl.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const inView = r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
    if (inView) return finishParts([{ x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(r.width, innerWidth), h: Math.min(r.height, innerHeight) }]);
    // bigger than the screen: background does a full-page capture and crops it
    cleanup();
    send({ type: 'selDone', mode, big: true, doc: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }, vw: innerWidth, vh: innerHeight });
  }
  if (PICK) {
    host.addEventListener('mousemove', (e) => {
      let el = elAt(e.clientX, e.clientY);
      if (mode === 'scroll') el = el && scrollableOf(el);
      if (el !== hoverEl) { hoverEl = el; drawEl(); }
    });
    host.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); } });
    host.addEventListener('click', (e) => { e.preventDefault(); if (mode === 'scroll') pickScroll(); else pickEl(); });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return; }
    if (mode !== 'element' || !hoverEl) return;
    if (e.key === 'ArrowUp' && hoverEl.parentElement && hoverEl.parentElement !== document.documentElement) {
      e.preventDefault(); hoverEl = hoverEl.parentElement; drawEl();
    } else if (e.key === 'ArrowDown' && hoverEl.firstElementChild) {
      e.preventDefault(); hoverEl = hoverEl.firstElementChild; drawEl();
    } else if (e.key === 'Enter') { e.preventDefault(); pickEl(); }
  }
  window.addEventListener('keydown', onKey, true);
})();
