// Draws the final evidence image: [stamp bar] + screenshot + [stamp bar] + [console panel] + [network panel].
// Works with HTMLCanvasElement (pages) and OffscreenCanvas (service worker) via the `mk` factory.

export const DEFAULT_SETTINGS = {
  // stamp
  url: true,
  time: true,
  stampPos: 'top', // top | bottom
  stampStyle: 'dark', // dark | light
  timeFormat: '12', // 12 (AM/PM) | 24
  dateMode: 'both', // both | date | time
  dateFormat: 'DD MMM YYYY', // one of DATE_FORMATS, or 'custom'
  dateCustom: 'DD/MM/YYYY', // used when dateFormat === 'custom'
  stampSize: 'm', // s | m | l | xl
  showTz: false, // time zone name after the time (off by default)
  // saving
  afterAction: 'edit', // edit | saveedit | save | copy | copysave | manual
  imageFormat: 'png', // png | jpg
  jpgQuality: 0.92,
  fileTemplate: '{host}_{date}_{time}',
  saveTarget: 'downloads', // downloads | folder (a folder picked in Settings)
  saveFolder: 'QA-Evidence',
  saveAs: false,
  notify: true, // small "Saved / Copied" toast on the page
  // capture modes
  freezeArea: true, // area / dual / element selection happens on a frozen screenshot (menus & tooltips stay open)
  captureDelay: 0, // seconds before visible / full-page capture
  dualLayout: 'auto', // auto | side | stack
  dualLabels: true,
  splitLayout: 'auto', // auto | side | stack | grid
  splitFull: false, // full page per pane
  // logs
  autoLogs: true,
  keepLogs: false,
  consoleInImg: false,
  networkInImg: false,
  logErrorsOnly: false,
  logLines: 20,
  // editor
  editColor: '#ef4444',
  editWidth: 4,
  editFont: 28,
  badgeSize: 18,
  theme: 'light', // light | dark  (editor, popup, recorder)
  // step guide (Scribe-style)
  guideColor: '#ef4444',
  guideTyping: true,
  guideValues: false,
  guideFirst: true,
  // recorder
  recCountdown: true,
  recSys: false,
  recMic: false,
  recAutoSave: true,
  recCountdownSec: 3,
  recQuality: '1080', // 720 | 1080 | 1440 | 2160
  recFps: 30,
  recCamera: false,
  recClicks: true,
  recFormat: 'mp4', // mp4 | webm
  recSteps: true, // repro steps while recording
  recStepShots: true,
  recStepValues: false,
  recStepCrop: true, // screen / window recordings: step pictures show only the web page
  // mobile view
  mobileDevice: 'iphone-14',
  mobileW: 390,
  mobileH: 844,
  mobileFull: false,
};

const p2 = (n) => String(n).padStart(2, '0');

// ---- date patterns ----
// Tokens: YYYY 2026 · YY 26 · MMMM November · MMM Nov · MM 11 · M 11 · DD 05 · D 5 · [text] = literal text
export const DATE_FORMATS = ['YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD MMM YYYY', 'MMM D, YYYY'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function formatDate(d, pattern) {
  const pat = String(pattern || 'YYYY-MM-DD').slice(0, 60);
  return pat.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D/g, (t, lit) => {
    if (lit !== undefined) return lit;
    switch (t) {
      case 'YYYY': return String(d.getFullYear());
      case 'YY': return String(d.getFullYear()).slice(-2);
      case 'MMMM': return MONTHS[d.getMonth()];
      case 'MMM': return MONTHS[d.getMonth()].slice(0, 3);
      case 'MM': return p2(d.getMonth() + 1);
      case 'M': return String(d.getMonth() + 1);
      case 'DD': return p2(d.getDate());
      default: return String(d.getDate());
    }
  });
}

export function fmtTime(ts, o = {}) {
  const d = new Date(ts);
  let tz = '';
  if (o.showTz !== false) {
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
  }
  let h = d.getHours();
  let suffix = '';
  if (o.timeFormat === '12') { suffix = h >= 12 ? ' PM' : ' AM'; h = h % 12 || 12; }
  const date = formatDate(d, o.dateFormat === 'custom' ? o.dateCustom : o.dateFormat);
  const time = `${p2(h)}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${suffix}${tz ? ' (' + tz + ')' : ''}`;
  if (o.dateMode === 'date') return date; // date only
  if (o.dateMode === 'time') return time; // time only
  return `${date} ${time}`;
}

// "Date" and "Time" chips <-> settings.time + settings.dateMode
export function dtChips(s) {
  return { date: !!s.time && s.dateMode !== 'time', time: !!s.time && s.dateMode !== 'date' };
}
export function dtFromChips(date, time) {
  return { time: !!(date || time), dateMode: date && time ? 'both' : date ? 'date' : time ? 'time' : 'both' };
}

// stamp bar text size: s | m | l | xl  (m = automatic size from the image width)
export const STAMP_SCALE = { s: 0.8, m: 1, l: 1.3, xl: 1.65 };

export function fileStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_') || 'page'; } catch (e) { return 'page'; }
}

const clean = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').replace(/\s+/g, ' ').trim();

export function fileName(meta, ext, tpl = '{host}_{date}_{time}') {
  const d = new Date(meta.ts);
  const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const time = `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  const name = clean(
    String(tpl || '{host}_{date}_{time}')
      .replace(/\{host\}/g, hostOf(meta.url))
      .replace(/\{title\}/g, clean(meta.title).slice(0, 40) || 'page')
      .replace(/\{date\}/g, date)
      .replace(/\{time\}/g, time)
  );
  return `${name || 'screenshot'}.${ext}`;
}

function wrap(ctx, text, maxW) {
  const lines = [];
  let cur = '';
  for (const ch of text) {
    if (cur && ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, Math.max(1, Math.floor(t.length * 0.92)));
  return t + '…';
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

const LEVEL_COLOR = { error: '#f87171', warn: '#fbbf24', info: '#60a5fa', log: '#e5e7eb', debug: '#9ca3af' };

export function filterConsole(list, opts) {
  let l = list || [];
  if (opts.logFilter === 'errors') l = l.filter((e) => e.level === 'error' || e.level === 'warn');
  return l.slice(-(opts.logLines || 20));
}

export function filterNetwork(list, opts) {
  let l = list || [];
  if (opts.logFilter === 'errors') l = l.filter((e) => e.failed || e.status >= 400);
  return l.slice(-(opts.logLines || 20));
}

export function netLine(e) {
  const st = e.failed ? 'ERR' : e.status || '-';
  const dur = e.duration != null && !isNaN(e.duration) ? ` ${Math.round(e.duration)}ms` : '';
  const err = e.failed && e.error ? ` [${e.error}]` : '';
  return `${st} ${e.method} ${e.url}${dur}${err}`;
}

export function consoleLine(e) {
  return `${fmtTime(e.ts, { showTz: false }).slice(11, 19)} ${e.level.toUpperCase().padEnd(5)} ${e.text}`.replace(/\s*\n\s*/g, ' ⏎ ');
}

// ---- the URL / time bar (looks like a browser address bar) ----
function layoutStamp(mk, W, meta, opts, fs) {
  if (!opts.url && !opts.time) return { h: 0, draw() {} };
  const probe = mk(10, 10).getContext('2d');
  const dark = opts.stampStyle !== 'light';
  const pad = Math.round(fs * 0.7);
  const lh = Math.round(fs * 1.45);
  const pin = Math.round(fs * 0.7);
  const icon = Math.round(fs * 1.05);
  probe.font = `${fs}px Arial, Helvetica, sans-serif`;
  const timeText = opts.time ? fmtTime(meta.ts, opts) : '';
  const timeW = timeText ? probe.measureText(timeText).width : 0;
  const inline = !!timeText && !!opts.url && W >= Math.max(760, timeW * 2.2);

  let urlLines = [];
  let pillW = 0;
  let pillH = 0;
  if (opts.url) {
    const raw = meta.url || '';
    const u = raw.length > 700 ? raw.slice(0, 700) + '…' : raw;
    pillW = W - pad * 2 - (inline ? timeW + pad * 1.5 : 0);
    urlLines = wrap(probe, u, pillW - pin * 2 - icon - pin * 0.7);
    pillH = Math.round(urlLines.length * lh + pin * 0.8);
  }
  const h = opts.url ? pad + pillH + pad + (timeText && !inline ? lh : 0) : pad + lh + pad;

  const c = {
    bg: dark ? '#202124' : '#f1f3f4',
    pill: dark ? '#3c4043' : '#ffffff',
    pillLine: dark ? '#3c4043' : '#dadce0',
    text: dark ? '#e8eaed' : '#202124',
    sub: dark ? '#bdc1c6' : '#5f6368',
    sep: dark ? '#000000' : '#dadce0',
  };

  return {
    h,
    draw(ctx, y) {
      ctx.fillStyle = c.bg;
      ctx.fillRect(0, y, W, h);
      ctx.textBaseline = 'middle';
      ctx.font = `${fs}px Arial, Helvetica, sans-serif`;
      if (opts.url) {
        rr(ctx, pad, y + pad, pillW, pillH, urlLines.length > 1 ? 10 : pillH / 2);
        ctx.fillStyle = c.pill; ctx.fill();
        ctx.strokeStyle = c.pillLine; ctx.lineWidth = 1; ctx.stroke();
        // globe icon
        const cx = pad + pin + icon / 2;
        const cy = y + pad + pin * 0.4 + lh / 2;
        ctx.strokeStyle = c.sub; ctx.lineWidth = Math.max(1, fs / 11);
        ctx.beginPath(); ctx.arc(cx, cy, icon / 2, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(cx, cy, icon / 5, icon / 2, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(cx - icon / 2, cy); ctx.lineTo(cx + icon / 2, cy); ctx.stroke();
        ctx.fillStyle = c.text;
        const tx = pad + pin + icon + pin * 0.7;
        urlLines.forEach((l, i) => ctx.fillText(l, tx, y + pad + pin * 0.4 + lh * i + lh / 2));
        if (timeText) {
          ctx.fillStyle = c.sub;
          if (inline) ctx.fillText(timeText, W - pad - timeW, y + pad + pillH / 2);
          else ctx.fillText(timeText, pad + pin, y + pad + pillH + pad * 0.3 + lh / 2);
        }
      } else {
        ctx.fillStyle = c.text;
        ctx.fillText(timeText, pad, y + pad + lh / 2);
      }
      ctx.fillStyle = c.sep;
      ctx.fillRect(0, y + (opts.stampPos === 'bottom' ? 0 : h - 1), W, 1);
    },
  };
}

/**
 * @param img  canvas | ImageBitmap (the raw screenshot)
 * @param meta {url, ts, logs}
 * @param opts {url,time,console,network,logFilter,logLines,stampPos,stampStyle,timeFormat,showTz}
 * @param mk   (w,h) => canvas
 * @returns {canvas, headerH}  headerH = height of the stamp bar ABOVE the screenshot (0 if bottom)
 */
export function compose(img, meta, opts, mk) {
  const W = img.width;
  const fs = Math.max(12, Math.min(22, Math.round(W / 80)));
  const lh = Math.round(fs * 1.45);
  const pad = Math.round(fs * 0.7);
  const mono = `${fs - 1}px ui-monospace, Menlo, Consolas, monospace`;

  const sfs = Math.max(10, Math.min(44, Math.round(fs * (STAMP_SCALE[opts.stampSize] || 1))));
  const stamp = layoutStamp(mk, W, meta, opts, sfs);
  const top = opts.stampPos === 'bottom' ? 0 : stamp.h;
  const bottom = opts.stampPos === 'bottom' ? stamp.h : 0;

  const panels = [];
  const logs = meta.logs;
  const mkPanel = (title, rows, emptyMsg) => {
    const body = rows.length ? rows : [{ t: emptyMsg, c: '#9ca3af' }];
    panels.push({ title, rows: body, h: lh + pad + body.length * lh + pad });
  };
  if (opts.console) {
    if (!logs) mkPanel('Console', [], 'No console log captured for this page (reload the tab once after installing, then try again).');
    else {
      const list = filterConsole(logs.console, opts);
      mkPanel(
        `Console (${list.length} of ${logs.console.length}${opts.logFilter === 'errors' ? ', errors/warnings only' : ''})`,
        list.map((e) => ({ t: consoleLine(e), c: LEVEL_COLOR[e.level] || LEVEL_COLOR.log })),
        'No console entries.'
      );
    }
  }
  if (opts.network) {
    if (!logs) mkPanel('Network', [], 'No network log captured for this page (reload the tab once after installing, then try again).');
    else {
      const list = filterNetwork(logs.network, opts);
      mkPanel(
        `Network (${list.length} of ${logs.network.length}${opts.logFilter === 'errors' ? ', failed only' : ''})`,
        list.map((e) => ({
          t: netLine(e),
          c: e.failed || e.status >= 400 ? '#f87171' : e.status >= 300 ? '#fbbf24' : '#e5e7eb',
        })),
        'No network requests.'
      );
    }
  }
  const panelsH = panels.reduce((a, p) => a + p.h, 0);
  const H = top + img.height + bottom + panelsH;

  const canvas = mk(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  if (top) stamp.draw(ctx, 0);
  ctx.drawImage(img, 0, top);
  let y = top + img.height;
  if (bottom) { stamp.draw(ctx, y); y += bottom; }

  for (const p of panels) {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, y, W, p.h);
    ctx.fillStyle = '#334155';
    ctx.fillRect(0, y, W, lh + pad / 2);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${fs}px Arial, Helvetica, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(p.title, pad, y + (lh + pad / 2) / 2);
    ctx.font = mono;
    let ry = y + lh + pad;
    for (const r of p.rows) {
      ctx.fillStyle = r.c || '#e5e7eb';
      ctx.fillText(fit(ctx, r.t, W - pad * 2), pad, ry + lh / 2);
      ry += lh;
    }
    y += p.h;
  }
  return { canvas, headerH: top };
}

export function composeOpts(s) {
  return {
    url: !!s.url,
    time: !!s.time,
    console: !!s.consoleInImg,
    network: !!s.networkInImg,
    logFilter: s.logErrorsOnly ? 'errors' : 'all',
    logLines: Math.max(3, Math.min(80, +s.logLines || 20)),
    stampPos: s.stampPos === 'bottom' ? 'bottom' : 'top',
    stampStyle: s.stampStyle === 'light' ? 'light' : 'dark',
    timeFormat: s.timeFormat === '24' ? '24' : '12',
    dateMode: ['date', 'time'].includes(s.dateMode) ? s.dateMode : 'both',
    dateFormat: s.dateFormat === 'custom' || DATE_FORMATS.includes(s.dateFormat) ? s.dateFormat : 'DD MMM YYYY',
    dateCustom: String(s.dateCustom || 'DD/MM/YYYY'),
    stampSize: STAMP_SCALE[s.stampSize] ? s.stampSize : 'm',
    showTz: s.showTz !== false,
  };
}

/**
 * Lays several images out on one canvas (Dual select, Split view).
 * @param imgs  array of canvas | ImageBitmap
 * @param o     {layout: auto|side|stack|grid, gap, bg, labels}
 */
export function combine(imgs, o, mk) {
  const n = imgs.length;
  const gap = o.gap != null ? o.gap : 16;
  const place = (layout) => {
    const cells = [];
    let W = 0, H = 0;
    if (layout === 'stack') {
      const mw = Math.max(...imgs.map((i) => i.width));
      let y = gap;
      for (const i of imgs) { cells.push({ x: gap, y }); y += i.height + gap; }
      W = mw + gap * 2; H = y;
    } else if (layout === 'grid') {
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cw = Math.max(...imgs.map((i) => i.width));
      const rh = [];
      imgs.forEach((i, k) => { const r = Math.floor(k / cols); rh[r] = Math.max(rh[r] || 0, i.height); });
      let y = gap;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols && r * cols + c < n; c++) cells.push({ x: gap + c * (cw + gap), y });
        y += rh[r] + gap;
      }
      W = gap + cols * (cw + gap); H = y;
    } else {
      let x = gap;
      for (const i of imgs) { cells.push({ x, y: gap }); x += i.width + gap; }
      W = x; H = Math.max(...imgs.map((i) => i.height)) + gap * 2;
    }
    return { cells, W, H };
  };
  let layout = o.layout || 'auto';
  if (layout === 'auto') {
    if (n === 1) layout = 'side';
    else if (n === 2) {
      const a = place('side'), b = place('stack');
      // pick the layout whose box is closest to a 16:10 landscape-ish shape
      const score = (p) => Math.abs(Math.log((p.W / p.H) / 1.6));
      layout = score(a) <= score(b) ? 'side' : 'stack';
    } else layout = n <= 3 ? 'side' : 'grid';
  }
  const p = place(layout);
  // keep inside safe canvas limits
  const k = Math.min(1, 16000 / p.W, 16000 / p.H, Math.sqrt(150e6 / (p.W * p.H)));
  const c = mk(Math.max(1, Math.round(p.W * k)), Math.max(1, Math.round(p.H * k)));
  const ctx = c.getContext('2d');
  ctx.fillStyle = o.bg || '#e5e7eb';
  ctx.fillRect(0, 0, c.width, c.height);
  imgs.forEach((img, i) => {
    const x = p.cells[i].x * k, y = p.cells[i].y * k, w = img.width * k, h = img.height * k;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 10 * k; ctx.shadowOffsetY = 2 * k;
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
    ctx.restore();
    ctx.drawImage(img, x, y, w, h);
    if (o.labels) {
      const r = Math.max(12, Math.round(Math.min(w, h) * 0.035));
      ctx.beginPath(); ctx.arc(x + r + 6 * k, y + r + 6 * k, r, 0, Math.PI * 2);
      ctx.fillStyle = '#4f46e5'; ctx.fill();
      ctx.lineWidth = Math.max(2, r / 7); ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 1.1)}px Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x + r + 6 * k, y + r + 6 * k + 1);
      ctx.textAlign = 'left';
    }
  });
  return { canvas: c, layout };
}

// ---- export helpers for logs ----
// the version written into exported files always matches manifest.json
const appVersion = () => { try { return chrome.runtime.getManifest().version; } catch (e) { return ''; } };
export function consoleToText(logs) {
  return (logs?.console || []).map((e) => `[${fmtTime(e.ts)}] ${e.level.toUpperCase()}: ${e.text}`).join('\n');
}
export function networkToText(logs) {
  return (logs?.network || []).map((e) => `[${fmtTime(e.ts)}] ${netLine(e)}`).join('\n');
}
export function toHar(logs) {
  const entries = (logs?.network || []).map((e) => ({
    startedDateTime: new Date(e.ts).toISOString(),
    time: e.duration || 0,
    request: {
      method: e.method,
      url: e.url,
      httpVersion: 'HTTP/1.1',
      headers: Object.entries(e.reqHeaders || {}).map(([name, value]) => ({ name, value })),
      queryString: [],
      cookies: [],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: e.failed ? 0 : e.status || 0,
      statusText: e.failed ? e.error || 'failed' : e.statusText || '',
      httpVersion: 'HTTP/1.1',
      headers: Object.entries(e.resHeaders || {}).map(([name, value]) => ({ name, value })),
      cookies: [],
      content: { size: e.size || 0, mimeType: e.mime || '' },
      redirectURL: '',
      headersSize: -1,
      bodySize: e.size || 0,
    },
    cache: {},
    timings: { send: 0, wait: e.duration || 0, receive: 0 },
  }));
  return { log: { version: '1.2', creator: { name: 'EvidenceKit', version: appVersion() }, entries } };
}

// ---- minimal single-image PDF (JPEG data inside) ----
export function jpegToPdf(jpegBytes, w, h) {
  const enc = new TextEncoder();
  const pw = Math.round(w * 0.75), ph = Math.round(h * 0.75);
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); push(body); push('\nendobj\n'); };
  push('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  offsets[4] = len;
  push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  push('\nendstream\nendobj\n');
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let i = 1; i <= 5; i++) push(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts, { type: 'application/pdf' });
}
