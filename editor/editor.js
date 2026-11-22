import { dbGet, dbPut, uid } from '../lib/db.js';
import { appendTo, DOC_NAMES } from '../lib/docs.js';
import { saveToChosenFolder } from '../lib/savedir.js';
import {
  compose, composeOpts, DEFAULT_SETTINGS, fileName, fmtTime, dtChips, dtFromChips,
  consoleLine, netLine, consoleToText, networkToText, toHar, jpegToPdf,
} from '../lib/compose.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const capId = params.get('id');
const stepId = params.get('step');
const isNew = params.get('new') === '1';
const embed = params.get('embed') === '1' && window.parent !== window; // opened inside the User Manual
const action = params.get('action') || 'edit';

const mkCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};

let meta = null;
let settings = { ...DEFAULT_SETTINGS };
const state = { raw: null, opts: {}, headerH: 0, baseCanvas: null };
let fcanvas = null;
let tool = 'select';
let loading = false;
let drag = null;
let cropRect = null;
let zoom = 1;
const hist = [];
let hi = -1;
const PROPS = ['autoNum', 'blurObj', 'badge', 'stamp', 'hl', 'magnify', 'tstyle', 'dim', 'stampText', 'stampColor', 'stampSize'];
const style = {
  color: '#ef4444', width: 4, fill: false, dash: false, opacity: 1,
  fontSize: 28, bold: false, textStyle: 'plain', badgeNext: 1, badgeSize: 18, stampIdx: 0, stampSize: 32, stampColor: null, stampText: 'RETEST', dim: 0.6, mag: 2,
};
const STAMPS = [
  { t: 'PASS', c: '#16a34a' }, { t: 'FAIL', c: '#dc2626' }, { t: 'BUG', c: '#dc2626' }, { t: 'BLOCKED', c: '#ea580c' },
  { t: 'FIXED', c: '#2563eb' }, { t: 'NOTE', c: '#7c3aed' }, { t: '✓', c: '#16a34a' }, { t: '✗', c: '#dc2626' }, { t: '?', c: '#d97706' }, { t: '!', c: '#d97706' },
  { t: '', c: '#0891b2', custom: true },
];
const BGS = [
  { css: 'repeating-conic-gradient(#9ca3af 0% 25%, #e5e7eb 0% 50%) 50% / 12px 12px', none: true, title: 'Transparent' },
  { c: ['#ffffff'] }, { c: ['#e5e7eb'] }, { c: ['#111827'] },
  { c: ['#667eea', '#764ba2'] }, { c: ['#f093fb', '#f5576c'] }, { c: ['#4facfe', '#00f2fe'] },
  { c: ['#43e97b', '#38f9d7'] }, { c: ['#fa709a', '#fee140'] }, { c: ['#0f172a', '#475569'] },
];
const frame = { on: false, bg: 4, pad: 64, rad: 12, shadow: true };

// ---------------- helpers ----------------
function toast(msg, ms = 1900) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
// Big, clear success message (saved / copied / added to the manual)
function success(title, detail, withManual) {
  const b = $('okbar');
  b.querySelector('.okt').textContent = title;
  b.querySelector('.okd').textContent = detail || '';
  b.querySelector('#okManual').style.display = withManual && !embed ? '' : 'none';
  b.classList.add('show');
  clearTimeout(success._t);
  success._t = setTimeout(() => b.classList.remove('show'), 3000);
}
function hexToRgba(hex, a) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function readableOn(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  const l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return l > 0.62 ? '#111827' : '#ffffff';
}
function toBlob(canvas, type = 'image/png', q = 0.92) {
  return new Promise((r) => canvas.toBlob(r, type, q));
}
const cleanName = (s) => String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim() || 'screenshot';
function outName(ext) { return `${cleanName($('fileName').value)}.${ext}`; }

// returns a short "where it went" text
async function download(blob, name) {
  if (settings.saveTarget === 'folder') {
    const r = await saveToChosenFolder(blob, name, settings, true); // a click is in progress, so Chrome may ask
    if (r.ok) return `${r.folder}/${r.name}`;
    toast('Could not use your save folder (' + r.reason + ') — saving to Downloads', 3500);
  }
  const url = URL.createObjectURL(blob);
  const folder = String(settings.saveFolder || '').replace(/[\\:*?"<>|]/g, '').replace(/^\/+|\/+$/g, '');
  try {
    await chrome.downloads.download({ url, filename: folder ? `${folder}/${name}` : name, conflictAction: 'uniquify', saveAs: !!settings.saveAs });
  } catch (e) {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return name;
}

// ---------------- custom fabric objects ----------------
// Spotlight: the rectangle stays clear, everything around it is dimmed.
function registerSpotlight() {
  fabric.Spotlight = fabric.util.createClass(fabric.Rect, {
    type: 'spotlight',
    initialize(o = {}) {
      this.callSuper('initialize', o);
      this.set({ objectCaching: false, dim: o.dim != null ? o.dim : 0.6 });
    },
    toObject(extra) {
      return fabric.util.object.extend(this.callSuper('toObject', extra), { dim: this.dim });
    },
    _render(ctx) {
      const w = this.width, h = this.height, B = 100000;
      ctx.save();
      ctx.beginPath();
      ctx.rect(-B, -B, 2 * B, 2 * B);
      ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(-w / 2, h / 2); ctx.lineTo(w / 2, h / 2); ctx.lineTo(w / 2, -h / 2); ctx.closePath();
      ctx.fillStyle = `rgba(0,0,0,${this.dim})`;
      ctx.fill('evenodd');
      ctx.restore();
    },
  });
  fabric.Spotlight.fromObject = (o, cb) => fabric.Object._fromObject('Spotlight', o, cb);
}

// ---------------- fabric setup ----------------
function initFabric() {
  registerSpotlight();
  fabric.Object.prototype.set({
    transparentCorners: false, cornerColor: '#6d6afe', cornerStrokeColor: '#fff', cornerStyle: 'circle',
    borderColor: '#6d6afe', cornerSize: 11, padding: 3, borderScaleFactor: 1.5,
  });
  fcanvas = new fabric.Canvas('c', { enableRetinaScaling: false, preserveObjectStacking: true, selection: true, fireRightClick: false });
  window.fcanvas = fcanvas; // handy for debugging in DevTools

  let erasing = false;
  fcanvas.on('mouse:down', (o) => {
    if (tool === 'eraser') {
      erasing = true;
      if (o.target) eraseObj(o.target);
      return;
    }
    if (tool === 'select' || fcanvas.isDrawingMode) return;
    const p = fcanvas.getPointer(o.e);
    if (tool === 'text') return addText(p);
    if (tool === 'badge') return addBadge(p);
    if (tool === 'stamp') return addStamp(p);
    drag = { x: p.x, y: p.y, obj: null };
    if (tool === 'crop' && cropRect) { fcanvas.remove(cropRect); cropRect = null; }
  });
  fcanvas.on('mouse:move', (o) => {
    if (tool === 'eraser') { if (erasing && o.target) eraseObj(o.target); return; }
    if (!drag) return;
    updateDrag(fcanvas.getPointer(o.e), o.e.shiftKey);
  });
  fcanvas.on('mouse:up', () => { erasing = false; if (drag) finishDrag(); });
  fcanvas.on('path:created', (e) => {
    e.path.set({ strokeLineCap: 'round', strokeLineJoin: 'round', opacity: tool === 'highlight' ? 1 : style.opacity });
    if (tool === 'highlight') e.path.set({ globalCompositeOperation: 'multiply' });
    commit();
  });
  fcanvas.on('object:modified', commit);
  fcanvas.on('text:editing:exited', commit);
  fcanvas.on('selection:created', () => { syncPropsFromSelection(); refreshProps(); });
  fcanvas.on('selection:updated', () => { syncPropsFromSelection(); refreshProps(); });
  fcanvas.on('selection:cleared', refreshProps);
}

function eraseObj(o) {
  fcanvas.remove(o);
  fcanvas.discardActiveObject();
  fcanvas.requestRenderAll();
  commit();
}

function applyZoom() {
  if (!state.baseCanvas) return;
  const w = Math.round(state.baseCanvas.width * zoom), h = Math.round(state.baseCanvas.height * zoom);
  fcanvas.setDimensions({ width: w + 'px', height: h + 'px' }, { cssOnly: true });
  $('zoomLabel').textContent = Math.round(zoom * 100) + '%';
  $('dims').textContent = `${state.baseCanvas.width} × ${state.baseCanvas.height}`;
  applyFramePreview();
}
function fitZoom() {
  if (!state.baseCanvas) return;
  const st = $('stage');
  const pad = frame.on ? frame.pad * 2 : 0;
  const availW = st.clientWidth - 60, availH = st.clientHeight - 60;
  const zw = availW / (state.baseCanvas.width + pad);
  // tall full-page shots: fit width only; normal shots: fit both
  const tall = state.baseCanvas.height > state.baseCanvas.width * 2.2;
  const zh = tall ? Infinity : availH / (state.baseCanvas.height + pad);
  zoom = Math.max(0.05, Math.min(1, zw, zh));
  applyZoom();
}
function zoomBy(f) { zoom = Math.max(0.05, Math.min(5, zoom * f)); applyZoom(); }

// Rebuild [header + raw screenshot + log panels] and set as canvas background.
function rebuildBase(shiftObjects) {
  const { canvas: c, headerH } = compose(state.raw, meta, state.opts, mkCanvas);
  const dy = headerH - state.headerH;
  state.headerH = headerH;
  state.baseCanvas = c;
  fcanvas.setDimensions({ width: c.width, height: c.height });
  fcanvas.setBackgroundImage(new fabric.Image(c, { left: 0, top: 0, selectable: false, evented: false }), () => fcanvas.requestRenderAll());
  if (shiftObjects && dy) {
    fcanvas.getObjects().forEach((o) => { o.top += dy; o.setCoords(); });
  }
  applyZoom();
}

// ---------------- history ----------------
let commitTimer = null;
// Debounced: Fabric fires several events for one edit (e.g. text exit + modified) -> one undo step.
function commit() {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(doCommit, 40);
}
function flushCommit() {
  if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; doCommit(); }
}
function doCommit() {
  commitTimer = null;
  if (loading || !fcanvas) return;
  const j = fcanvas.toJSON(PROPS);
  delete j.backgroundImage;
  hist.splice(hi + 1);
  hist.push({ json: j, raw: state.raw, opts: { ...state.opts } });
  if (hist.length > 60) hist.shift();
  hi = hist.length - 1;
  updateUndo();
  if (embed) window.parent.postMessage({ type: 'evkDirty', dirty: hist.length > 1 }, location.origin);
}
function undo() { flushCommit(); restore(hi - 1); }
function redo() { flushCommit(); restore(hi + 1); }
function restore(i) {
  if (i < 0 || i >= hist.length) return;
  hi = i;
  const h = hist[i];
  loading = true;
  fcanvas.discardActiveObject();
  state.raw = h.raw;
  state.opts = { ...h.opts };
  syncToggles();
  fcanvas.loadFromJSON(h.json, () => {
    rebuildBase(false);
    fcanvas.renderAll();
    loading = false;
    updateUndo();
  });
}
function updateUndo() {
  $('undo').disabled = hi <= 0;
  $('redo').disabled = hi >= hist.length - 1;
  $('histInfo').textContent = hist.length > 1 ? `Change ${hi} of ${hist.length - 1}` : 'No changes yet';
}

// ---------------- tools ----------------
// these tools stay on after each use, so you can draw many in a row
const STICKY = ['pen', 'highlight', 'badge', 'stamp', 'eraser', 'arrow', 'line', 'rect', 'ellipse', 'hlbox', 'text', 'redact', 'blur'];

function setTool(t) {
  if (!fcanvas) return;
  if (tool === 'crop' && t !== 'crop') cancelCrop();
  tool = t;
  fcanvas.isDrawingMode = t === 'pen' || t === 'highlight';
  if (fcanvas.isDrawingMode) {
    const b = new fabric.PencilBrush(fcanvas);
    b.color = t === 'pen' ? style.color : hexToRgba(style.color, 0.4);
    b.width = t === 'pen' ? style.width : Math.max(14, style.width * 4);
    b.decimate = 2;
    fcanvas.freeDrawingBrush = b;
  }
  fcanvas.selection = t === 'select';
  fcanvas.skipTargetFind = t !== 'select' && t !== 'eraser';
  fcanvas.defaultCursor = t === 'select' ? 'default' : t === 'eraser' ? 'cell' : 'crosshair';
  fcanvas.hoverCursor = t === 'eraser' ? 'pointer' : 'move';
  if (t !== 'select') fcanvas.discardActiveObject();
  fcanvas.requestRenderAll();
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  refreshProps();
}

const HINTS = {
  select: 'Click an item to move, resize or edit it. Double-click text to edit.',
  arrow: 'Drag to draw an arrow. Hold Shift for straight angles. The tool stays on — press V or Esc to select, move and resize.',
  line: 'Drag to draw a line. Hold Shift for straight angles. The tool stays on — press V or Esc to select, move and resize.',
  rect: 'Drag to draw a box around the problem. Shift = square. The tool stays on — press V or Esc to select, move and resize.',
  ellipse: 'Drag to draw an oval. Shift = circle. The tool stays on — press V or Esc to select, move and resize.',
  pen: 'Draw freehand.',
  highlight: 'Paint over text like a marker.',
  hlbox: 'Drag over text to highlight it. The tool stays on — press V or Esc to select, move and resize.',
  text: 'Click where the text should go, then type. The tool stays on — press V or Esc to select, move and resize.',
  badge: 'Click to place numbered markers 1, 2, 3 …',
  stamp: 'Pick a stamp, then click on the image.',
  spotlight: 'Drag around the important part — the rest gets dimmed.',
  magnify: 'Drag over a small detail to show it bigger.',
  blur: 'Drag over passwords, emails or tokens to pixelate them. The tool stays on — press V or Esc to select, move and resize.',
  redact: 'Drag to cover data with a solid black box. The tool stays on — press V or Esc to select, move and resize.',
  eraser: 'Click (or drag across) items to remove them.',
  crop: 'Drag the area to keep, then press “Apply crop”.',
};
function show(id, on) { $(id).classList.toggle('show', !!on); }
function refreshProps() {
  const o = fcanvas.getActiveObject();
  const sel = !!o && tool === 'select';
  const isText = !!o && o.type === 'i-text';
  const shapeSel = sel && ['rect', 'ellipse', 'line', 'group', 'path'].includes(o.type) && !o.blurObj && !o.hl && !o.stamp && !o.badge;
  const colorTools = ['arrow', 'line', 'rect', 'ellipse', 'pen', 'highlight', 'hlbox', 'text', 'badge', 'magnify', 'stamp'];
  show('gColor', colorTools.includes(tool) || (sel && !o.blurObj && o.type !== 'spotlight' && !o.magnify));
  show('gWidth', ['arrow', 'line', 'rect', 'ellipse', 'pen', 'highlight'].includes(tool) || shapeSel);
  show('gDash', ['arrow', 'line', 'rect', 'ellipse'].includes(tool) || (shapeSel && o.type !== 'path'));
  show('gFill', ['rect', 'ellipse'].includes(tool) || (sel && (o.type === 'rect' || o.type === 'ellipse') && !o.hl && o.fill !== '#000000'));
  show('gText', tool === 'text' || (sel && isText));
  show('gBadge', tool === 'badge');
  const stampSel = sel && !!o.stamp;
  show('gStamp', tool === 'stamp' || stampSel);
  $('stampTextLbl').hidden = !(stampSel || (tool === 'stamp' && (STAMPS[style.stampIdx] || {}).custom));
  if (stampSel) {
    if (document.activeElement !== $('pStampText')) $('pStampText').value = stampTextOf(o);
    const sz = Math.round((o.stampSize || 32) * (o.scaleY || 1));
    $('pStampSize').value = sz; $('pStampSizeV').textContent = sz;
  } else if (tool === 'stamp') {
    $('pStampText').value = style.stampText;
    $('pStampSize').value = style.stampSize; $('pStampSizeV').textContent = style.stampSize;
  }
  show('gSpot', tool === 'spotlight' || (sel && o.type === 'spotlight'));
  show('gMag', tool === 'magnify');
  show('gOpacity', ['arrow', 'line', 'rect', 'ellipse', 'pen', 'text', 'badge', 'stamp'].includes(tool) || (sel && o.type !== 'spotlight'));
  show('gSel', sel);
  show('gCrop', tool === 'crop');
  $('hint').textContent = sel ? (o.stamp ? 'Stamp selected — change its text, size or color above, or pick another stamp.' : 'Selected — change it above, drag to move, Delete to remove.') : HINTS[tool] || '';
  document.querySelectorAll('.sw').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === style.color.toLowerCase()));
}

const dashFor = (w) => (style.dash ? [Math.max(4, w * 2.5), Math.max(3, w * 1.8)] : null);

function makeArrow(x1, y1, x2, y2) {
  const w = style.width;
  const head = Math.max(14, w * 4);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const line = new fabric.Line(
    [x1, y1, x2 - Math.cos(ang) * head * 0.6, y2 - Math.sin(ang) * head * 0.6],
    { stroke: style.color, strokeWidth: w, strokeLineCap: 'round', strokeDashArray: dashFor(w) }
  );
  const tri = new fabric.Triangle({
    left: x2 - Math.cos(ang) * head * 0.5, top: y2 - Math.sin(ang) * head * 0.5,
    originX: 'center', originY: 'center', width: head, height: head * 1.1,
    fill: style.color, angle: (ang * 180) / Math.PI + 90,
  });
  return new fabric.Group([line, tri]);
}

function snapAngle(x1, y1, x2, y2) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const st = Math.PI / 4;
  const a = Math.round(ang / st) * st;
  const d = Math.hypot(x2 - x1, y2 - y1);
  return { x: x1 + Math.cos(a) * d, y: y1 + Math.sin(a) * d };
}

function makeShape(p, shift) {
  const { x: x1, y: y1 } = drag;
  let x2 = p.x, y2 = p.y;
  if (shift && (tool === 'line' || tool === 'arrow')) ({ x: x2, y: y2 } = snapAngle(x1, y1, x2, y2));
  if (shift && (tool === 'rect' || tool === 'ellipse')) {
    const d = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    x2 = x1 + Math.sign(x2 - x1 || 1) * d; y2 = y1 + Math.sign(y2 - y1 || 1) * d;
  }
  const l = Math.min(x1, x2), t = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  const common = {
    stroke: style.color, strokeWidth: style.width, strokeUniform: true, strokeDashArray: dashFor(style.width),
    fill: style.fill ? hexToRgba(style.color, 0.25) : 'transparent', opacity: style.opacity,
  };
  switch (tool) {
    case 'rect': return new fabric.Rect({ left: l, top: t, width: w, height: h, rx: 3, ry: 3, ...common });
    case 'ellipse': return new fabric.Ellipse({ left: l, top: t, rx: w / 2, ry: h / 2, ...common });
    case 'line': return new fabric.Line([x1, y1, x2, y2], { stroke: style.color, strokeWidth: style.width, strokeLineCap: 'round', strokeDashArray: dashFor(style.width), opacity: style.opacity });
    case 'arrow': { const a = makeArrow(x1, y1, x2, y2); a.set('opacity', style.opacity); return a; }
    case 'redact': return new fabric.Rect({ left: l, top: t, width: w, height: h, fill: '#000000', strokeWidth: 0 });
    case 'hlbox': {
      const r = new fabric.Rect({ left: l, top: t, width: w, height: h, fill: hexToRgba(style.color, 0.38), strokeWidth: 0, globalCompositeOperation: 'multiply' });
      r.set('hl', true);
      return r;
    }
    case 'spotlight': {
      const s = new fabric.Spotlight({ left: l, top: t, width: w, height: h, fill: 'transparent', strokeWidth: 0, dim: style.dim });
      return s;
    }
    case 'blur':
    case 'crop':
    case 'magnify':
      return new fabric.Rect({
        left: l, top: t, width: w, height: h,
        fill: tool === 'crop' ? 'rgba(16,185,129,.15)' : 'rgba(99,102,241,.18)',
        stroke: tool === 'crop' ? '#10b981' : '#6366f1', strokeDashArray: [6, 4], strokeWidth: 2,
        strokeUniform: true, excludeFromExport: true,
      });
  }
  return null;
}

function updateDrag(p, shift) {
  if (Math.hypot(p.x - drag.x, p.y - drag.y) < 3 && !drag.obj) return;
  if (drag.obj) fcanvas.remove(drag.obj);
  drag.obj = makeShape(p, shift);
  if (drag.obj) {
    drag.obj.set({ selectable: false, evented: false });
    fcanvas.add(drag.obj);
    fcanvas.requestRenderAll();
  }
}

function finishDrag() {
  const o = drag.obj;
  drag = null;
  if (!o) return;
  o.set({ selectable: true, evented: true });
  if (tool === 'blur' || tool === 'magnify') {
    const r = { x: o.left, y: o.top, w: o.width, h: o.height };
    fcanvas.remove(o);
    if (r.w > 4 && r.h > 4) (tool === 'blur' ? addPixelate : addMagnifier)(r);
    commit();
    return;
  }
  if (tool === 'crop') {
    cropRect = o;
    o.set({ selectable: false, evented: false });
    toast('Crop area set — press “Apply crop” (or drag again)');
    return;
  }
  const t = tool;
  if (!STICKY.includes(t)) { setTool('select'); fcanvas.setActiveObject(o); } // sticky tools: keep drawing
  refreshProps();
  commit();
}

function addPixelate(r) {
  const bw = state.baseCanvas.width, bh = state.baseCanvas.height;
  const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
  const w = Math.min(bw - x, Math.round(r.w)), h = Math.min(bh - y, Math.round(r.h));
  if (w < 2 || h < 2) return;
  const block = Math.max(8, Math.round(bw / 160));
  const sm = mkCanvas(Math.max(1, Math.round(w / block)), Math.max(1, Math.round(h / block)));
  sm.getContext('2d').drawImage(state.baseCanvas, x, y, w, h, 0, 0, sm.width, sm.height);
  const out = mkCanvas(w, h);
  const oc = out.getContext('2d');
  oc.imageSmoothingEnabled = false;
  oc.drawImage(sm, 0, 0, sm.width, sm.height, 0, 0, w, h);
  const img = new fabric.Image(out, { left: x, top: y });
  img.set('blurObj', true);
  fcanvas.add(img);
}

function addMagnifier(r) {
  const f = style.mag;
  const src = fcanvas.toCanvasElement(1);
  const side = Math.max(r.w, r.h);
  const D = Math.round(Math.min(Math.max(side * f, 80), 1000));
  const srcSide = D / f;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const bw = Math.max(4, Math.round(D / 55));
  const out = mkCanvas(D + bw * 2, D + bw * 2);
  const c = out.getContext('2d');
  c.save();
  c.beginPath(); c.arc(out.width / 2, out.height / 2, D / 2, 0, Math.PI * 2); c.clip();
  c.fillStyle = '#fff'; c.fillRect(0, 0, out.width, out.height);
  c.imageSmoothingQuality = 'high';
  c.drawImage(src, cx - srcSide / 2, cy - srcSide / 2, srcSide, srcSide, bw, bw, D, D);
  c.restore();
  c.beginPath(); c.arc(out.width / 2, out.height / 2, D / 2 + bw / 2, 0, Math.PI * 2);
  c.lineWidth = bw; c.strokeStyle = style.color; c.stroke();
  // place it beside the source area, inside the image when possible
  const W = state.baseCanvas.width, H = state.baseCanvas.height;
  let left = r.x + r.w + 24;
  if (left + out.width > W) left = r.x - out.width - 24;
  if (left < 0) left = Math.max(0, Math.min(W - out.width, cx - out.width / 2));
  const top = Math.max(0, Math.min(H - out.height, cy - out.height / 2));
  const img = new fabric.Image(out, { left, top, shadow: new fabric.Shadow({ color: 'rgba(0,0,0,.35)', blur: 18, offsetY: 4 }) });
  img.set('magnify', true);
  fcanvas.add(img);
  fcanvas.setActiveObject(img);
  setTool('select');
}

function textLook(color, ts, fontSize) {
  switch (ts) {
    case 'box': return { fill: color, backgroundColor: 'rgba(255,255,255,0.92)', stroke: null, strokeWidth: 0 };
    case 'label': return { fill: readableOn(color), backgroundColor: color, stroke: null, strokeWidth: 0 };
    case 'outline': return { fill: color, backgroundColor: '', stroke: '#ffffff', strokeWidth: Math.max(2, Math.round(fontSize / 8)), paintFirst: 'stroke' };
    default: return { fill: color, backgroundColor: '', stroke: null, strokeWidth: 0 };
  }
}

function addText(p) {
  const t = new fabric.IText('Text', {
    left: p.x, top: p.y, fontSize: style.fontSize, fontFamily: 'Segoe UI, Arial, sans-serif',
    fontWeight: style.bold ? 'bold' : 'normal', padding: 6, opacity: style.opacity,
    ...textLook(style.color, style.textStyle, style.fontSize),
  });
  t.set('tstyle', style.textStyle);
  fcanvas.add(t);
  // the Text tool stays on: type now, click somewhere else for the next text
  fcanvas.setActiveObject(t);
  t.enterEditing();
  t.selectAll();
  fcanvas.requestRenderAll();
}

function addBadge(p) {
  const r = style.badgeSize;
  const c = new fabric.Circle({ radius: r, fill: style.color, stroke: '#ffffff', strokeWidth: 2, originX: 'center', originY: 'center' });
  const t = new fabric.Text(String(style.badgeNext), {
    fontSize: Math.round(r * 1.15), fontWeight: 'bold', fill: readableOn(style.color), fontFamily: 'Arial', originX: 'center', originY: 'center',
  });
  const g = new fabric.Group([c, t], { left: p.x - r, top: p.y - r, opacity: style.opacity, shadow: new fabric.Shadow({ color: 'rgba(0,0,0,.3)', blur: 6, offsetY: 1 }) });
  g.set('badge', true);
  fcanvas.add(g);
  style.badgeNext++;
  $('pBadgeNext').value = style.badgeNext;
  commit();
}

// QA stamp = framed bold text (round frame for a single symbol). Text, color and size stay editable.
function buildStamp(text, color, size) {
  const fs = Math.max(10, Math.round(size));
  const one = [...text].length === 1;
  const txt = new fabric.Text(text, { fontSize: fs, fontWeight: '900', fill: color, fontFamily: 'Arial Black, Arial, sans-serif', originX: 'center', originY: 'center', charSpacing: one ? 0 : 80 });
  const sw = Math.max(3, Math.round(fs * 0.12));
  const frameObj = one
    ? new fabric.Circle({ radius: fs * 0.85, fill: 'rgba(255,255,255,.88)', stroke: color, strokeWidth: sw, originX: 'center', originY: 'center' })
    : new fabric.Rect({ width: txt.width + fs * 0.9, height: fs * 1.5, rx: fs * 0.18, ry: fs * 0.18, fill: 'rgba(255,255,255,.88)', stroke: color, strokeWidth: sw, originX: 'center', originY: 'center' });
  const g = new fabric.Group([frameObj, txt], { originX: 'center', originY: 'center', angle: one ? 0 : -8 });
  g.set({ stamp: true, stampText: text, stampColor: color, stampSize: fs });
  return g;
}
function currentStamp() {
  const s = STAMPS[style.stampIdx] || STAMPS[0];
  return { text: s.custom ? (style.stampText.trim().toUpperCase() || 'TEXT') : s.t, color: style.stampColor || s.c };
}
function addStamp(p) {
  const { text, color } = currentStamp();
  const g = buildStamp(text, color, style.stampSize);
  g.set({ left: p.x, top: p.y, opacity: style.opacity });
  fcanvas.add(g);
  commit();
}
const stampTextOf = (o) => o.stampText || ((o.getObjects().find((x) => x.type === 'text') || {}).text) || 'TEXT';
const stampColorOf = (o) => o.stampColor || ((o.getObjects().find((x) => x.type === 'text') || {}).fill) || '#dc2626';
// rebuild a placed stamp with new text / color, keeping place, angle, size and opacity
function replaceStamp(o, patch) {
  const text = patch.text != null ? patch.text : stampTextOf(o);
  const color = patch.color != null ? patch.color : stampColorOf(o);
  const n = buildStamp(text, color, o.stampSize || 32);
  n.set({ left: o.left, top: o.top, angle: o.angle, scaleX: o.scaleX, scaleY: o.scaleY, opacity: o.opacity, originX: o.originX, originY: o.originY });
  const idx = fcanvas.getObjects().indexOf(o);
  fcanvas.remove(o);
  fcanvas.insertAt(n, idx);
  fcanvas.setActiveObject(n);
  fcanvas.requestRenderAll();
  commit();
  return n;
}

function cancelCrop() {
  if (cropRect) { fcanvas.remove(cropRect); cropRect = null; fcanvas.requestRenderAll(); }
}

function applyCrop() {
  if (!cropRect) return toast('Drag on the image to choose the crop area first');
  const hh = state.headerH;
  const left = Math.max(0, Math.round(cropRect.left));
  const top = Math.max(hh, Math.round(cropRect.top));
  const right = Math.min(state.raw.width, Math.round(cropRect.left + cropRect.width));
  const bottom = Math.min(hh + state.raw.height, Math.round(cropRect.top + cropRect.height));
  const cw = right - left, ch = bottom - top;
  if (cw < 5 || ch < 5) return toast('Crop area must be inside the screenshot');
  const rx = left, ry = top - hh;
  const c = mkCanvas(cw, ch);
  c.getContext('2d').drawImage(state.raw, rx, ry, cw, ch, 0, 0, cw, ch);
  cancelCrop();
  fcanvas.getObjects().forEach((o) => { o.left -= rx; o.top -= ry; o.setCoords(); });
  state.raw = c;
  rebuildBase(true);
  setTool('select');
  commit();
  fitZoom();
}

// ---------------- properties ----------------
function applyToSelection(fn) {
  const objs = fcanvas.getActiveObjects();
  if (!objs.length) return;
  objs.forEach(fn);
  fcanvas.requestRenderAll();
  commit();
}
function recolor(o, v) {
  if (o.type === 'i-text' || o.type === 'text') { o.set(textLook(v, o.tstyle || 'plain', o.fontSize)); return; }
  if (o.type === 'group') {
    o.getObjects().forEach((c) => {
      if (o.stamp) { o.stampColor = v; if (c.type === 'text') c.set('fill', v); else c.set('stroke', v); return; }
      if (o.badge) { if (c.type === 'circle') c.set('fill', v); else if (c.type === 'text') c.set('fill', readableOn(v)); return; }
      if (c.type === 'line') c.set('stroke', v);
      else if (c.type === 'triangle' || c.type === 'circle') c.set('fill', v);
    });
    o.set('dirty', true);
    return;
  }
  if (o.blurObj || o.magnify || o.type === 'spotlight') return;
  if (o.hl) { o.set('fill', hexToRgba(v, 0.38)); return; }
  if (o.fill === '#000000' && !o.stroke) return; // redaction stays black
  if (typeof o.fill === 'string' && o.fill.startsWith('rgba')) o.set('fill', hexToRgba(v, 0.25));
  if (o.stroke) o.set('stroke', v);
}

function syncPropsFromSelection() {
  const o = fcanvas.getActiveObject();
  if (!o) return;
  if (o.type === 'i-text') {
    $('pFont').value = Math.round(o.fontSize * (o.scaleY || 1));
    $('pBold').checked = o.fontWeight === 'bold';
    $('pTextStyle').value = o.tstyle || 'plain';
  } else if (o.strokeWidth && o.type !== 'group') {
    $('pWidth').value = String(o.strokeWidth);
    $('pWidthV').textContent = o.strokeWidth;
    $('pDash').checked = !!(o.strokeDashArray && o.strokeDashArray.length);
  }
  if (o.type === 'spotlight') $('pDim').value = Math.round((o.dim || 0.6) * 100);
  $('pOpacity').value = Math.round((o.opacity == null ? 1 : o.opacity) * 100);
}

function setColor(v) {
  if (tool === 'stamp' && !fcanvas.getActiveObject()) { style.stampColor = v; renderStampBtns(); }
  style.color = v;
  $('pColor').value = v.length === 7 ? v : $('pColor').value;
  applyToSelection((o) => recolor(o, v));
  if (fcanvas.isDrawingMode) setTool(tool);
  refreshProps();
}

function bindProps() {
  $('pColor').addEventListener('input', (e) => setColor(e.target.value));
  document.querySelectorAll('.sw').forEach((s) => s.addEventListener('click', () => setColor(s.dataset.c)));
  $('pEye').addEventListener('click', async () => {
    if (!window.EyeDropper) return toast('Color picker needs Chrome 95 or newer');
    try { const r = await new window.EyeDropper().open(); setColor(r.sRGBHex); } catch (e) {}
  });
  $('pWidth').addEventListener('input', (e) => {
    style.width = +e.target.value;
    $('pWidthV').textContent = style.width;
    fcanvas.getActiveObjects().forEach((o) => {
      if (o.type === 'group' && !o.stamp && !o.badge) {
        o.getObjects().forEach((c) => { if (c.type === 'line') c.set({ strokeWidth: style.width, strokeDashArray: c.strokeDashArray && c.strokeDashArray.length ? dashFor(style.width) || c.strokeDashArray : null }); });
        o.set('dirty', true);
      } else if (o.stroke && o.strokeWidth !== undefined && o.type !== 'i-text' && o.type !== 'group') o.set('strokeWidth', style.width);
    });
    fcanvas.requestRenderAll();
    if (fcanvas.isDrawingMode) setTool(tool);
  });
  $('pWidth').addEventListener('change', () => { if (fcanvas.getActiveObjects().length) commit(); });
  $('pDash').addEventListener('change', (e) => {
    style.dash = e.target.checked;
    applyToSelection((o) => {
      if (o.type === 'group' && !o.stamp && !o.badge) { o.getObjects().forEach((c) => { if (c.type === 'line') c.set('strokeDashArray', dashFor(c.strokeWidth)); }); o.set('dirty', true); }
      else if (['rect', 'ellipse', 'line'].includes(o.type) && o.stroke) o.set('strokeDashArray', dashFor(o.strokeWidth));
    });
  });
  $('pFill').addEventListener('change', (e) => {
    style.fill = e.target.checked;
    applyToSelection((o) => {
      if ((o.type === 'rect' || o.type === 'ellipse') && !o.hl && o.fill !== '#000000') {
        o.set('fill', style.fill ? hexToRgba(typeof o.stroke === 'string' ? o.stroke : style.color, 0.25) : 'transparent');
      }
    });
  });
  $('pOpacity').addEventListener('input', (e) => {
    style.opacity = +e.target.value / 100;
    fcanvas.getActiveObjects().forEach((o) => o.set('opacity', style.opacity));
    fcanvas.requestRenderAll();
    if (fcanvas.isDrawingMode) setTool(tool);
  });
  $('pOpacity').addEventListener('change', () => { if (fcanvas.getActiveObjects().length) commit(); });
  $('pFont').addEventListener('change', (e) => {
    style.fontSize = +e.target.value;
    applyToSelection((o) => { if (o.type === 'i-text') { o.set({ fontSize: style.fontSize, scaleX: 1, scaleY: 1 }); if (o.tstyle === 'outline') o.set(textLook(o.fill, 'outline', style.fontSize)); } });
  });
  $('pBold').addEventListener('change', (e) => {
    style.bold = e.target.checked;
    applyToSelection((o) => { if (o.type === 'i-text') o.set('fontWeight', style.bold ? 'bold' : 'normal'); });
  });
  $('pTextStyle').addEventListener('change', (e) => {
    style.textStyle = e.target.value;
    applyToSelection((o) => {
      if (o.type !== 'i-text') return;
      const color = o.tstyle === 'label' ? o.backgroundColor : o.fill;
      o.set('tstyle', style.textStyle);
      o.set(textLook(color || style.color, style.textStyle, o.fontSize));
    });
  });
  $('okClose').addEventListener('click', () => $('okbar').classList.remove('show'));
  $('okManual').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openManual', doc: lastAddedTo }));
  $('pRenum').addEventListener('click', () => { renumberBadges(); commit(); toast('Badges renumbered 1…' + (style.badgeNext - 1)); });
  $('pBadgeNext').addEventListener('change', (e) => { style.badgeNext = +e.target.value; });
  $('pBadgeSize').addEventListener('change', (e) => { style.badgeSize = +e.target.value; });
  $('pDim').addEventListener('input', (e) => {
    style.dim = +e.target.value / 100;
    fcanvas.getActiveObjects().forEach((o) => { if (o.type === 'spotlight') o.set('dim', style.dim); });
    fcanvas.requestRenderAll();
  });
  $('pDim').addEventListener('change', () => { if (fcanvas.getActiveObjects().length) commit(); });
  $('pMag').addEventListener('change', (e) => { style.mag = +e.target.value; });

  // stamp picker
  renderStampBtns();
  let stTimer = null;
  $('pStampText').addEventListener('input', () => {
    const v = $('pStampText').value;
    const o = fcanvas.getActiveObject();
    if (o && o.stamp) {
      clearTimeout(stTimer);
      stTimer = setTimeout(() => { const cur = fcanvas.getActiveObject(); if (cur && cur.stamp && v.trim()) replaceStamp(cur, { text: v.trim().toUpperCase() }); }, 350);
    } else { style.stampText = v; renderStampBtns(); }
  });
  $('pStampSize').addEventListener('input', () => {
    const v = +$('pStampSize').value;
    $('pStampSizeV').textContent = v;
    const objs = fcanvas.getActiveObjects().filter((x) => x.stamp);
    if (objs.length) {
      objs.forEach((x) => { const k = v / (x.stampSize || 32); x.set({ scaleX: k, scaleY: k }); x.setCoords(); });
      fcanvas.requestRenderAll();
    } else style.stampSize = v;
  });
  $('pStampSize').addEventListener('change', () => { if (fcanvas.getActiveObjects().some((x) => x.stamp)) commit(); });
  $('pStampReset').addEventListener('click', () => {
    style.stampColor = null;
    renderStampBtns();
    const o = fcanvas.getActiveObject();
    if (o && o.stamp) {
      const t = stampTextOf(o);
      const preset = STAMPS.find((s) => s.t === t) || STAMPS[STAMPS.length - 1];
      replaceStamp(o, { color: preset.c });
    }
  });
  fcanvas.on('mouse:dblclick', (e) => {
    if (e.target && e.target.stamp) { $('pStampText').focus(); $('pStampText').select(); }
    else if (e.target && e.target.badge) {
      const t = e.target.getObjects().find((c) => c.type === 'text');
      const v = prompt('Badge number / text', t ? t.text : '');
      if (v !== null && v.trim()) { setBadgeNum(e.target, v.trim().slice(0, 3)); e.target.set('autoNum', false); fcanvas.requestRenderAll(); commit(); }
    }
  });

  $('pDel').addEventListener('click', deleteSelected);
  $('pDup').addEventListener('click', duplicate);
  $('pFront').addEventListener('click', () => { const o = fcanvas.getActiveObject(); if (o) { fcanvas.bringToFront(o); commit(); } });
  $('pBack').addEventListener('click', () => { const o = fcanvas.getActiveObject(); if (o) { fcanvas.sendToBack(o); commit(); } });
  $('cropApply').addEventListener('click', applyCrop);
  $('cropCancel').addEventListener('click', () => { cancelCrop(); setTool('select'); });
}

function renderStampBtns() {
  const box = $('stampBtns');
  box.textContent = '';
  STAMPS.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'stampbtn' + (i === style.stampIdx ? ' on' : '');
    b.textContent = s.custom ? (style.stampText.trim().toUpperCase() || 'CUSTOM') : s.t;
    b.style.color = style.stampColor || s.c;
    b.title = s.custom ? 'Your own text (type it in the box)' : `Place “${s.t}” (or click a placed stamp first to change it)`;
    b.addEventListener('click', () => {
      const o = fcanvas.getActiveObject();
      if (tool === 'select' && o && o.stamp) { // change the selected stamp
        replaceStamp(o, { text: s.custom ? (style.stampText.trim().toUpperCase() || 'TEXT') : s.t, color: style.stampColor || s.c });
        return;
      }
      style.stampIdx = i;
      box.querySelectorAll('.stampbtn').forEach((x, k) => x.classList.toggle('on', k === i));
      refreshProps();
    });
    box.append(b);
  });
}

function duplicate() {
  const o = fcanvas.getActiveObject();
  if (!o || o.isEditing) return;
  o.clone((c) => {
    c.set({ left: o.left + 20, top: o.top + 20 });
    if (c.type === 'activeSelection') {
      c.canvas = fcanvas;
      c.forEachObject((x) => fcanvas.add(x));
      c.setCoords();
    } else fcanvas.add(c);
    fcanvas.setActiveObject(c);
    fcanvas.requestRenderAll();
    commit();
  }, PROPS);
}

function deleteSelected() {
  const o = fcanvas.getActiveObject();
  if (!o || o.isEditing) return;
  const hadBadge = fcanvas.getActiveObjects().some((x) => x.badge && !x.autoNum);
  fcanvas.getActiveObjects().forEach((x) => fcanvas.remove(x));
  fcanvas.discardActiveObject();
  if (hadBadge) renumberBadges();
  fcanvas.requestRenderAll();
  commit();
}

// ---------------- stamp toggles + logs panel ----------------
const TOGGLES = ['tUrl', 'tDate', 'tTime', 'tConsole', 'tNetwork', 'tErrors', 'tLines', 'tPos', 'tStyle', 'tFmt', 'tSize', 'tDateFmt', 'tDateCustom'];
function syncToggles() {
  const o = state.opts;
  $('tUrl').checked = !!o.url;
  const dt = dtChips(o);
  $('tDate').checked = dt.date;
  $('tTime').checked = dt.time;
  $('tSize').value = o.stampSize || 'm';
  $('tDateFmt').value = o.dateFormat || 'DD MMM YYYY';
  $('tDateCustom').value = o.dateCustom || 'DD/MM/YYYY';
  $('tCustomRow').hidden = $('tDateFmt').value !== 'custom';
  $('tConsole').checked = !!o.console;
  $('tNetwork').checked = !!o.network;
  $('tErrors').checked = o.logFilter === 'errors';
  $('tLines').value = o.logLines || 20;
  $('tPos').value = o.stampPos || 'top';
  $('tStyle').value = o.stampStyle || 'dark';
  $('tFmt').value = o.timeFormat || '12';
}

function bindToggles() {
  const change = () => {
    state.opts = {
      ...state.opts,
      url: $('tUrl').checked,
      ...dtFromChips($('tDate').checked, $('tTime').checked),
      stampSize: $('tSize').value,
      dateFormat: $('tDateFmt').value,
      dateCustom: $('tDateCustom').value || 'DD/MM/YYYY',
      console: $('tConsole').checked,
      network: $('tNetwork').checked,
      logFilter: $('tErrors').checked ? 'errors' : 'all',
      logLines: Math.max(3, Math.min(80, +$('tLines').value || 20)),
      stampPos: $('tPos').value,
      stampStyle: $('tStyle').value,
      timeFormat: $('tFmt').value,
    };
    rebuildBase(true);
    fcanvas.requestRenderAll();
    commit();
  };
  TOGGLES.forEach((id) => $(id).addEventListener('change', change));
  $('tDateFmt').addEventListener('change', () => { $('tCustomRow').hidden = $('tDateFmt').value !== 'custom'; });
  let ct = null;
  $('tDateCustom').addEventListener('input', () => { clearTimeout(ct); ct = setTimeout(change, 350); });
}

let logTab = 'console';
function renderLogs() {
  const logs = meta.logs;
  if (!logs) {
    $('noLogs').textContent = stepId
      ? 'Logs are not stored with manual steps.'
      : meta.composite ? 'Split view images do not carry logs.'
        : isNew ? 'Opened images have no page logs.'
          : 'No logs were captured with this screenshot. Reload the tab once (after installing) and capture again.';
    $('logsBox').style.display = 'none';
    return;
  }
  $('noLogs').textContent = `Logging started ${fmtTime(logs.startedAt)}`;
  $('logsBox').style.display = 'block';
  const q = $('logFilter').value.toLowerCase();
  const list = $('logList');
  list.textContent = '';
  const rows = logTab === 'console' ? logs.console : logs.network;
  const shown = rows
    .filter((e) => !q || (logTab === 'console' ? e.text : netLine(e)).toLowerCase().includes(q))
    .slice(-500);
  for (const e of shown) {
    const d = document.createElement('div');
    if (logTab === 'console') {
      d.className = 'l-' + e.level;
      d.textContent = consoleLine(e);
    } else {
      d.className = e.failed || e.status >= 400 ? 'l-error' : e.status >= 300 ? 'l-warn' : '';
      d.textContent = netLine(e);
    }
    list.append(d);
  }
  if (!shown.length) list.textContent = 'No entries.';
}

function renderInfo() {
  const el = $('info');
  el.textContent = '';
  const add = (k, v) => {
    if (!v) return;
    const d = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = k;
    d.append(b, document.createTextNode(v));
    el.append(d);
  };
  const MODES = { visible: 'Visible area', full: 'Full page', area: 'Selected area', element: 'Element', dual: 'Dual select', split: 'Split view', screen: 'Screen / app window', file: 'Opened image' };
  add('Capture', MODES[meta.mode] || meta.mode);
  if (meta.panes) meta.panes.forEach((p, i) => add(`Pane ${i + 1}`, `${p.title ? p.title + ' — ' : ''}${p.url}`));
  else add('URL', meta.url);
  add('Title', meta.title);
  add('Time', fmtTime(meta.ts));
  if (meta.viewport && meta.viewport.w) add('Viewport', `${meta.viewport.w}×${meta.viewport.h} @${meta.viewport.dpr}x`);
  add('Image', `${state.raw.width} × ${state.raw.height} px`);
  add('Browser', meta.ua);
}

function bindLogUi() {
  $('tabConsole').addEventListener('click', () => { logTab = 'console'; $('tabConsole').classList.add('active'); $('tabNetwork').classList.remove('active'); renderLogs(); });
  $('tabNetwork').addEventListener('click', () => { logTab = 'network'; $('tabNetwork').classList.add('active'); $('tabConsole').classList.remove('active'); renderLogs(); });
  $('logFilter').addEventListener('input', renderLogs);
  const txt = (s) => new Blob([s], { type: 'text/plain' });
  $('expConsole').addEventListener('click', () => download(txt(consoleToText(meta.logs)), fileName(meta, 'console.txt')));
  $('expNet').addEventListener('click', () => download(txt(networkToText(meta.logs)), fileName(meta, 'network.txt')));
  $('expHar').addEventListener('click', () => download(new Blob([JSON.stringify(toHar(meta.logs), null, 2)], { type: 'application/json' }), fileName(meta, 'har')));
  $('expJson').addEventListener('click', () => download(new Blob([JSON.stringify(meta.logs, null, 2)], { type: 'application/json' }), fileName(meta, 'logs.json')));
}

// ---------------- frame / beautify ----------------
const bgCss = (b) => (b.none ? b.css : b.c.length > 1 ? `linear-gradient(135deg, ${b.c[0]}, ${b.c[1]})` : b.c[0]);
function applyFramePreview() {
  const wrap = $('frameWrap');
  const cc = wrap.querySelector('.canvas-container');
  wrap.classList.toggle('framed', frame.on);
  if (!frame.on) {
    wrap.style.padding = '0'; wrap.style.background = 'none';
    if (cc) { cc.style.borderRadius = '0'; cc.style.boxShadow = ''; }
    return;
  }
  const b = BGS[frame.bg] || BGS[0];
  wrap.style.padding = Math.round(frame.pad * zoom) + 'px';
  wrap.style.background = b.none ? 'transparent' : bgCss(b);
  if (cc) {
    cc.style.borderRadius = Math.round(frame.rad * zoom) + 'px';
    cc.style.boxShadow = frame.shadow ? `0 ${Math.round(12 * zoom)}px ${Math.round(40 * zoom)}px rgba(0,0,0,.38)` : 'none';
  }
}
function saveFrame() { try { localStorage.setItem('evkFrame', JSON.stringify(frame)); } catch (e) {} }
function bindFrame() {
  // 'qaepFrame' = the key used before the rename to EvidenceKit
  try { Object.assign(frame, JSON.parse(localStorage.getItem('evkFrame') || localStorage.getItem('qaepFrame') || '{}'), { on: false }); } catch (e) {}
  try { if (localStorage.getItem('qaepFrame') != null) { saveFrame(); localStorage.removeItem('qaepFrame'); } } catch (e) {}
  const box = $('fBgs');
  BGS.forEach((b, i) => {
    const btn = document.createElement('button');
    btn.style.background = bgCss(b);
    btn.title = b.title || (b.c || []).join(' → ');
    btn.addEventListener('click', () => {
      frame.bg = i; frame.on = true; $('fOn').checked = true;
      box.querySelectorAll('button').forEach((x, k) => x.classList.toggle('on', k === i));
      saveFrame(); applyFramePreview();
    });
    if (i === frame.bg) btn.classList.add('on');
    box.append(btn);
  });
  $('fOn').checked = frame.on;
  $('fPad').value = frame.pad; $('fPadV').textContent = frame.pad + 'px';
  $('fRad').value = frame.rad; $('fRadV').textContent = frame.rad + 'px';
  $('fShadow').checked = frame.shadow;
  $('fOn').addEventListener('change', (e) => { frame.on = e.target.checked; saveFrame(); applyFramePreview(); });
  $('fPad').addEventListener('input', (e) => { frame.pad = +e.target.value; $('fPadV').textContent = frame.pad + 'px'; saveFrame(); applyFramePreview(); });
  $('fRad').addEventListener('input', (e) => { frame.rad = +e.target.value; $('fRadV').textContent = frame.rad + 'px'; saveFrame(); applyFramePreview(); });
  $('fShadow').addEventListener('change', (e) => { frame.shadow = e.target.checked; saveFrame(); applyFramePreview(); });
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

// ---------------- output ----------------
function renderFinal(opaque) {
  fcanvas.discardActiveObject();
  fcanvas.renderAll();
  const img = fcanvas.toCanvasElement(1);
  if (!frame.on) return img;
  const pad = frame.pad, r = frame.rad;
  const out = mkCanvas(img.width + pad * 2, img.height + pad * 2);
  const ctx = out.getContext('2d');
  const b = BGS[frame.bg] || BGS[0];
  if (!b.none) {
    if (b.c.length > 1) {
      const g = ctx.createLinearGradient(0, 0, out.width, out.height);
      g.addColorStop(0, b.c[0]); g.addColorStop(1, b.c[1]);
      ctx.fillStyle = g;
    } else ctx.fillStyle = b.c[0];
    ctx.fillRect(0, 0, out.width, out.height);
  } else if (opaque) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, out.width, out.height); }
  if (frame.shadow) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.38)';
    ctx.shadowBlur = Math.max(16, Math.min(60, pad * 0.6));
    ctx.shadowOffsetY = Math.max(4, Math.min(20, pad * 0.18));
    roundRectPath(ctx, pad, pad, img.width, img.height, r);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.restore();
  }
  ctx.save();
  roundRectPath(ctx, pad, pad, img.width, img.height, r);
  ctx.clip();
  ctx.drawImage(img, pad, pad);
  ctx.restore();
  return out;
}

async function copyImage() {
  const blob = await toBlob(renderFinal(false));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  success('Copied to clipboard', 'Paste it anywhere with Ctrl+V.');
}

async function saveImage(type) {
  flushCommit();
  if (type === 'copysave') {
    await copyImage().catch(() => {});
    return saveImage(settings.imageFormat === 'jpg' ? 'jpg' : 'png');
  }
  if (type === 'pdf') {
    const c = renderFinal(true);
    const jpg = await toBlob(c, 'image/jpeg', 0.92);
    const pdf = jpegToPdf(new Uint8Array(await jpg.arrayBuffer()), c.width, c.height);
    success('Saved', await download(pdf, outName('pdf')));
  } else {
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[type] || 'image/png';
    const blob = await toBlob(renderFinal(type === 'jpg'), mime, +settings.jpgQuality || 0.92);
    success('Image saved', await download(blob, outName(type)));
  }
}

// "Add to Manual" / "Add to Test Evidence": each button adds this image to its own document (press both = both)
let lastAddedTo = 'manual';
async function addTo(doc) {
  const btn = $(doc === 'evidence' ? 'addEvidence' : 'addManual');
  btn.disabled = true;
  try {
    const blob = await toBlob(renderFinal(false));
    const r = await appendTo(doc, [{ blob, title: '', desc: '', url: meta.url, ts: meta.ts, pageTitle: meta.title || '', mode: meta.mode }]);
    lastAddedTo = doc;
    btn.classList.add('done');
    btn.querySelector('span').textContent = `✓ ${doc === 'evidence' ? 'Test Evidence' : 'Manual'} · step ${r.before + 1}`;
    success('Added to ' + DOC_NAMES[doc], `This image is now step ${r.before + 1} of your ${DOC_NAMES[doc]}.`, true);
    $('okManual').textContent = 'Open ' + DOC_NAMES[doc];
  } catch (e) {
    toast('Could not add: ' + e.message, 4000);
  } finally {
    btn.disabled = false;
  }
}

// ---- step pictures: editable layers + automatic click marker ----
async function applyStepInit(init) {
  if (init.json) {
    loading = true;
    await new Promise((res) => fcanvas.loadFromJSON(init.json, res));
    rebuildBase(false);
    loading = false;
    const nums = userBadges().length;
    style.badgeNext = nums + 1;
    $('pBadgeNext').value = style.badgeNext;
  } else if (init.mark) addAutoMarker(init.mark, init.n);
}
// The click outline + number of a step guide / repro step, as ordinary editable objects.
function addAutoMarker(mark, n) {
  const W = state.raw.width, sc = W / (mark.vw || W), color = mark.color || '#ef4444';
  const oy = mark.oy || 0; // the URL / time bar above the screenshot
  if (mark.rect) {
    const pad = 5 * sc;
    const x = mark.rect.x * sc - pad, y = mark.rect.y * sc - pad + oy, w = mark.rect.w * sc + pad * 2, h = mark.rect.h * sc + pad * 2;
    fcanvas.add(new fabric.Rect({ left: x, top: y, width: w, height: h, rx: 8 * sc, ry: 8 * sc, fill: color + '22', stroke: color, strokeWidth: Math.max(3, 3 * sc), strokeUniform: true }));
    const r = 13 * sc;
    const bx = Math.max(r + 2, x), by = Math.max(oy + r + 2, y);
    const c = new fabric.Circle({ radius: r, fill: color, stroke: '#ffffff', strokeWidth: 2 * sc, originX: 'center', originY: 'center' });
    const t = new fabric.Text(String(n), { fontSize: Math.round(r * 1.15), fontWeight: 'bold', fill: '#ffffff', fontFamily: 'Arial', originX: 'center', originY: 'center' });
    const g = new fabric.Group([c, t], { left: bx - r, top: by - r });
    g.set('badge', true);
    g.set('autoNum', true); // the manual keeps this number equal to the Step number
    fcanvas.add(g);
  } else if (mark.pt) {
    const r = 20 * sc;
    fcanvas.add(new fabric.Circle({ left: mark.pt.x * sc - r, top: mark.pt.y * sc - r + oy, radius: r, fill: color + '55', stroke: color, strokeWidth: Math.max(3, 3 * sc), strokeUniform: true }));
  }
}
const userBadges = () => fcanvas.getObjects().filter((o) => o.badge && !o.autoNum);
function setBadgeNum(g, n) {
  const t = g.getObjects().find((c) => c.type === 'text');
  if (!t) return;
  t.set('text', String(n));
  g.set('dirty', true);
}
// 1, 2, 3 … in the order they are now (so deleting badge 2 closes the gap)
function renumberBadges() {
  const list = userBadges().map((g, i) => ({ g, i, v: parseFloat((g.getObjects().find((c) => c.type === 'text') || {}).text) }))
    .sort((a, b) => (isNaN(a.v) ? 1e9 : a.v) - (isNaN(b.v) ? 1e9 : b.v) || a.i - b.i);
  list.forEach((x, k) => setBadgeNum(x.g, k + 1));
  style.badgeNext = list.length + 1;
  $('pBadgeNext').value = style.badgeNext;
  fcanvas.requestRenderAll();
}

async function saveToStep() {
  flushCommit();
  const blob = await toBlob(renderFinal(false));
  const st = await dbGet('steps', stepId);
  if (!st) return toast('This step was deleted meanwhile — use Save or Add to Manual instead.', 4500);
  const json = fcanvas.toJSON(PROPS);
  delete json.backgroundImage;
  st.blob = blob;
  // keep the clean picture + layers, so the step can be edited again and its number can follow the Step number
  st.edit = { raw: await toBlob(state.raw), json, frame: !!frame.on };
  if ((json.objects || []).some((o) => o.autoNum)) st.num = +params.get('n') || st.num;
  st.rev = Date.now();
  await dbPut('steps', st);
  success('Step image saved', 'Your changes are saved with this step.');
  if (embed) window.parent.postMessage({ type: 'evkStepSaved', id: stepId }, location.origin);
}

// ---------------- images: paste / drop ----------------
function fileFromItems(items) {
  for (const it of items || []) {
    if (it.kind === 'file' && it.type.startsWith('image/')) return it.getAsFile();
  }
  return null;
}
async function addImageObject(blob) {
  const bmp = await createImageBitmap(blob);
  const c = mkCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  const W = state.baseCanvas.width, H = state.baseCanvas.height;
  const k = Math.min(1, (W * 0.6) / c.width, (H * 0.6) / c.height);
  const img = new fabric.Image(c, { left: (W - c.width * k) / 2, top: (H - c.height * k) / 2, scaleX: k, scaleY: k, shadow: new fabric.Shadow({ color: 'rgba(0,0,0,.3)', blur: 12, offsetY: 3 }) });
  fcanvas.add(img);
  setTool('select');
  fcanvas.setActiveObject(img);
  fcanvas.requestRenderAll();
  commit();
  toast('Image pasted — drag to place it');
}

// ---------------- details drawer (Stamp / Frame / Info / Logs) ----------------
let openPaneName = null;
function openPane(name, toggle) {
  if (toggle && name === openPaneName) name = null;
  openPaneName = name;
  const wasHidden = document.body.classList.contains('side-hidden');
  document.body.classList.toggle('side-hidden', !name);
  document.querySelectorAll('#paneBtns button').forEach((b) => b.classList.toggle('on', b.dataset.pane === name));
  if (name) {
    document.querySelectorAll('#sideTabs button').forEach((x) => x.classList.toggle('active', x.dataset.pane === name));
    document.querySelectorAll('#side .pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  }
  if (wasHidden !== !name) setTimeout(fitZoom, 50);
}

// ---------------- theme (light by default) ----------------
function applyTheme() { document.body.classList.toggle('light', settings.theme !== 'dark'); }
async function toggleTheme() {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  const r = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(r.settings || {}), theme: settings.theme } });
}

// ---------------- boot ----------------
function bindUi() {
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  updateUndo();
  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('zoomIn').addEventListener('click', () => zoomBy(1.25));
  $('zoomOut').addEventListener('click', () => zoomBy(1 / 1.25));
  $('zoomFit').addEventListener('click', fitZoom);
  $('zoomLabel').addEventListener('click', () => { zoom = 1; applyZoom(); });
  $('copy').addEventListener('click', () => copyImage().catch((e) => toast('Copy failed: ' + e.message, 4000)));
  $('save').addEventListener('click', () => saveImage(settings.imageFormat === 'jpg' ? 'jpg' : 'png'));
  $('saveMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('saveMenu').classList.toggle('open'); });
  $('saveMenu').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { $('saveMenu').classList.remove('open'); saveImage(b.dataset.fmt); }));
  document.addEventListener('click', () => $('saveMenu').classList.remove('open'));
  $('closeSide').addEventListener('click', () => openPane(null));
  $('addManual').addEventListener('click', () => addTo('manual'));
  $('addEvidence').addEventListener('click', () => addTo('evidence'));
  $('saveStep').addEventListener('click', saveToStep);
  document.querySelectorAll('#paneBtns button').forEach((b) => b.addEventListener('click', () => openPane(b.dataset.pane, true)));
  $('themeBtn').addEventListener('click', toggleTheme);
  $('helpBtn').addEventListener('click', () => { $('help').hidden = false; });
  $('helpClose').addEventListener('click', () => { $('help').hidden = true; });
  $('help').addEventListener('click', (e) => { if (e.target === $('help')) $('help').hidden = true; });
  document.querySelectorAll('#sideTabs button').forEach((b) => b.addEventListener('click', () => openPane(b.dataset.pane)));

  // ctrl + wheel zoom
  $('stage').addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });

  // space + drag to pan
  let space = false, pan = null;
  const stage = $('stage');
  stage.addEventListener('mousedown', (e) => {
    if (!space) return;
    e.preventDefault(); e.stopPropagation();
    pan = { x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
    stage.classList.add('panning');
  }, true);
  window.addEventListener('mousemove', (e) => {
    if (!pan) return;
    stage.scrollLeft = pan.sl - (e.clientX - pan.x);
    stage.scrollTop = pan.st - (e.clientY - pan.y);
  });
  window.addEventListener('mouseup', () => { pan = null; stage.classList.remove('panning'); });

  const KEYS = {};
  document.querySelectorAll('.tool').forEach((b) => { KEYS[b.dataset.key.toLowerCase()] = b.dataset.tool; });

  document.addEventListener('keyup', (e) => { if (e.code === 'Space') { space = false; stage.classList.remove('pan'); } });
  document.addEventListener('keydown', (e) => {
    const active = fcanvas.getActiveObject();
    const typing = active && active.isEditing;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (typing || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.code === 'Space' && !mod) { e.preventDefault(); space = true; stage.classList.add('pan'); return; }
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 'c' && (e.shiftKey || !active)) { e.preventDefault(); copyImage().catch((er) => toast('Copy failed: ' + er.message, 4000)); }
    else if (mod && k === 's') { e.preventDefault(); saveImage(settings.imageFormat === 'jpg' ? 'jpg' : 'png'); }
    else if (mod && k === 'd') { e.preventDefault(); duplicate(); }
    else if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomBy(1.25); }
    else if (mod && k === '-') { e.preventDefault(); zoomBy(1 / 1.25); }
    else if (mod && k === '0') { e.preventDefault(); fitZoom(); }
    else if (mod && k === '1') { e.preventDefault(); zoom = 1; applyZoom(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.key === 'Escape') { if (!$('help').hidden) $('help').hidden = true; cancelCrop(); setTool('select'); }
    else if (e.key === '?') { $('help').hidden = !$('help').hidden; }
    else if (active && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
      const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      active.set({ left: active.left + dx, top: active.top + dy });
      active.setCoords();
      fcanvas.requestRenderAll();
      commit();
    } else if (!mod && !e.altKey && KEYS[k]) { setTool(KEYS[k]); }
  });

  document.addEventListener('paste', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const f = fileFromItems(e.clipboardData && e.clipboardData.items);
    if (f && state.baseCanvas) { e.preventDefault(); addImageObject(f); }
  });
  stage.addEventListener('dragover', (e) => { e.preventDefault(); });
  stage.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer.files || [])].find((x) => x.type.startsWith('image/'));
    if (f && state.baseCanvas) addImageObject(f);
  });
}

// "Open image" mode: wait for a dropped / pasted / chosen file
function waitForImage() {
  return new Promise((resolve) => {
    const drop = $('drop');
    const box = drop.querySelector('.dropbox');
    drop.hidden = false;
    const done = (f) => {
      if (!f) return;
      drop.hidden = true;
      document.removeEventListener('paste', onPaste);
      resolve(f);
    };
    const onPaste = (e) => done(fileFromItems(e.clipboardData && e.clipboardData.items));
    document.addEventListener('paste', onPaste);
    $('pickFile').addEventListener('change', (e) => done(e.target.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('over'); });
    drop.addEventListener('dragleave', () => box.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('over');
      done([...(e.dataTransfer.files || [])].find((x) => x.type.startsWith('image/')));
    });
  });
}

async function boot() {
  const stored = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  applyTheme();
  document.body.classList.toggle('embed', embed);
  style.color = settings.editColor || style.color;
  style.width = +settings.editWidth || style.width;
  style.fontSize = +settings.editFont || style.fontSize;
  style.badgeSize = +settings.badgeSize || style.badgeSize;

  let blob;
  let stepInit = null;
  const lock = (msg, disable) => {
    $('lockNote').textContent = msg;
    $('lockNote').style.display = 'block';
    if (disable) TOGGLES.forEach((id) => ($(id).disabled = true));
  };
  if (stepId) {
    const st = await dbGet('steps', stepId);
    if (!st) return (document.body.textContent = 'Step not found.');
    blob = st.blob;
    // keep layers editable: reopen the clean picture + the saved annotation objects (not the flattened image)
    if (st.edit && st.edit.raw) { blob = st.edit.raw; stepInit = { json: st.edit.json }; }
    else if (st.raw && st.mark) { blob = st.raw; stepInit = { mark: st.mark, n: +params.get('n') || 1 }; }
    meta = { ts: st.ts, url: st.url || '', title: '', logs: null, mode: 'step' };
    state.opts = { ...composeOpts(settings), url: false, time: false, console: false, network: false };
    $('saveStep').style.display = '';
    lock('This step image already contains its stamps.', true);
  } else if (isNew) {
    $('fileName').value = 'image';
    const f = await waitForImage();
    blob = f;
    meta = { ts: Date.now(), url: '', title: f.name || 'Pasted image', logs: null, mode: 'file' };
    state.opts = { ...composeOpts(settings), url: false, time: false, console: false, network: false };
  } else {
    const rec = await dbGet('captures', capId);
    if (!rec) return (document.body.textContent = 'This capture is no longer available (captures are kept for 24 hours). Take a new screenshot.');
    blob = rec.blob;
    meta = rec.meta;
    state.opts = composeOpts(settings);
    if (meta.mode === 'screen' && !meta.url) state.opts = { ...state.opts, url: false };
    if (meta.composite) {
      state.opts = { ...state.opts, url: false, time: false, console: false, network: false };
      lock('Every pane already has its own URL bar. Turning “Page URL” on adds one more bar for the first pane.', false);
    }
  }

  const bmp = await createImageBitmap(blob);
  const raw = mkCanvas(bmp.width, bmp.height);
  raw.getContext('2d').drawImage(bmp, 0, 0);
  state.raw = raw;

  initFabric();
  bindUi();
  bindProps();
  bindToggles();
  bindLogUi();
  bindFrame();
  syncToggles();
  rebuildBase(false);
  fitZoom();
  renderInfo();
  renderLogs();
  if (stepInit) await applyStepInit(stepInit);
  commit();
  setTool('rect'); // Box is the tool you start with
  window.addEventListener('resize', () => { clearTimeout(boot._r); boot._r = setTimeout(fitZoom, 120); });

  const ext = settings.imageFormat === 'jpg' ? 'jpg' : 'png';
  $('fileExt').textContent = '.' + ext;
  if (!isNew) $('fileName').value = fileName(meta, ext, settings.fileTemplate).replace(/\.[a-z]+$/, '');
  else $('fileName').value = cleanName((meta.title || 'image').replace(/\.[a-z0-9]+$/i, '')) + '-annotated';
  document.title = 'Editor — ' + (meta.title || meta.url || 'EvidenceKit');
  $('pColor').value = style.color;
  $('pWidth').value = String(style.width);
  $('pWidthV').textContent = style.width;
  $('pFont').value = style.fontSize;
  $('pBadgeSize').value = style.badgeSize;
  refreshProps();

  if (action === 'copy') {
    try {
      await copyImage();
      setTimeout(() => chrome.runtime.sendMessage({ type: 'closeTab' }), 700);
    } catch (e) { toast('Copy failed: ' + e.message, 4000); }
  }
}

boot().catch((e) => { document.body.textContent = 'Editor error: ' + e.message; console.error(e); });
