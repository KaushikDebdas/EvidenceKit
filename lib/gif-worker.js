// Animated GIF encoder (Web Worker).
// Messages in:  {type:'start', w, h, delay}  delay in 1/100 s
//               {type:'frame', data}         RGBA ArrayBuffer of w*h*4 (transferred)
//               {type:'finish'}
// Message out:  {type:'done', blob}  or  {type:'error', message}
// Each frame gets its own 255-colour palette (popularity of 15-bit colours). Pixels that did not change
// since the previous frame become transparent, which keeps screen recordings small.

let W = 0, H = 0, delay = 10;
let parts = [];
let prevKeys = null;
let frameNo = 0;

const u16 = (n) => [n & 255, (n >> 8) & 255];

function header() {
  const b = [];
  for (const c of 'GIF89a') b.push(c.charCodeAt(0));
  b.push(...u16(W), ...u16(H), 0x00, 0, 0); // no global colour table
  // loop forever (NETSCAPE2.0)
  b.push(0x21, 0xff, 0x0b);
  for (const c of 'NETSCAPE2.0') b.push(c.charCodeAt(0));
  b.push(0x03, 0x01, 0, 0, 0x00);
  parts.push(new Uint8Array(b));
}

function lzw(indices, minCodeSize) {
  const out = [];
  let cur = 0, curBits = 0;
  let codeSize = minCodeSize + 1;
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let next = eoi + 1;
  let table = new Map();
  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) { out.push(cur & 255); cur >>>= 8; curBits -= 8; }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = table.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1;
      codeSize = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (curBits > 0) out.push(cur & 255);
  // sub-blocks of at most 255 bytes
  const data = new Uint8Array(out.length + Math.ceil(out.length / 255) + 2);
  let o = 0;
  data[o++] = minCodeSize;
  for (let i = 0; i < out.length; i += 255) {
    const n = Math.min(255, out.length - i);
    data[o++] = n;
    for (let j = 0; j < n; j++) data[o++] = out[i + j];
  }
  data[o++] = 0;
  return data.subarray(0, o);
}

function addFrame(buf) {
  const px = new Uint8Array(buf);
  const n = W * H;
  const keys = new Uint16Array(n);
  const count = new Uint32Array(32768);
  const sr = new Uint32Array(32768), sg = new Uint32Array(32768), sb = new Uint32Array(32768);
  const useTrans = !!prevKeys;
  const same = useTrans ? new Uint8Array(n) : null;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = px[p], g = px[p + 1], b = px[p + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    keys[i] = key;
    if (useTrans && prevKeys[i] === key) { same[i] = 1; continue; }
    count[key]++; sr[key] += r; sg[key] += g; sb[key] += b;
  }
  // most used colours -> palette (index 255 is reserved for "unchanged")
  const used = [];
  for (let k = 0; k < 32768; k++) if (count[k]) used.push(k);
  used.sort((a, b) => count[b] - count[a]);
  const pal = used.slice(0, 255);
  const palR = new Uint8Array(256), palG = new Uint8Array(256), palB = new Uint8Array(256);
  pal.forEach((k, i) => { palR[i] = Math.round(sr[k] / count[k]); palG[i] = Math.round(sg[k] / count[k]); palB[i] = Math.round(sb[k] / count[k]); });
  const map = new Int16Array(32768).fill(-1);
  pal.forEach((k, i) => { map[k] = i; });
  const nearest = (k) => {
    const r = ((k >> 10) & 31) * 8 + 4, g = ((k >> 5) & 31) * 8 + 4, b = (k & 31) * 8 + 4;
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const dr = palR[i] - r, dg = palG[i] - g, db = palB[i] - b;
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < bd) { bd = d; best = i; }
    }
    map[k] = best;
    return best;
  };
  const idx = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (useTrans && same[i]) { idx[i] = 255; continue; }
    const k = keys[i];
    const m = map[k];
    idx[i] = m >= 0 ? m : nearest(k);
  }
  prevKeys = keys;

  const ct = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) { ct[i * 3] = palR[i]; ct[i * 3 + 1] = palG[i]; ct[i * 3 + 2] = palB[i]; }
  const gce = new Uint8Array([0x21, 0xf9, 0x04, 0x04 | (useTrans ? 1 : 0), ...u16(delay), useTrans ? 255 : 0, 0x00]);
  const desc = new Uint8Array([0x2c, 0, 0, 0, 0, ...u16(W), ...u16(H), 0x87]);
  parts.push(gce, desc, ct, lzw(idx, 8));
  frameNo++;
}

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    if (m.type === 'start') {
      W = m.w; H = m.h; delay = Math.max(2, Math.round(m.delay || 10));
      parts = []; prevKeys = null; frameNo = 0;
      header();
    } else if (m.type === 'frame') {
      addFrame(m.data);
      self.postMessage({ type: 'progress', frames: frameNo });
    } else if (m.type === 'finish') {
      parts.push(new Uint8Array([0x3b]));
      self.postMessage({ type: 'done', blob: new Blob(parts, { type: 'image/gif' }), frames: frameNo });
      parts = []; prevKeys = null;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
