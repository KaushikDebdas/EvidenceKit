// Chrome's MediaRecorder writes WebM files without a Duration, so players show no length and
// cannot seek. This adds (or fixes) Segment > Info > Duration by patching the file header only.

function readId(b, p) {
  const x = b[p];
  const len = x & 0x80 ? 1 : x & 0x40 ? 2 : x & 0x20 ? 3 : x & 0x10 ? 4 : 0;
  if (!len || p + len > b.length) return null;
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
  return { v, len };
}

function readSize(b, p) {
  const x = b[p];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(x & mask)) { mask >>= 1; len++; }
  if (len > 8 || p + len > b.length) return null;
  let v = x & (mask - 1);
  let unknown = v === mask - 1;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[p + i];
    if (b[p + i] !== 0xff) unknown = false;
  }
  return { v, len, unknown };
}

function encodeSize(v, len) {
  if (v >= 2 ** (7 * len) - 1) len = 8;
  const out = new Uint8Array(len);
  let n = v;
  for (let i = len - 1; i >= 0; i--) { out[i] = n % 256; n = Math.floor(n / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}

function readUInt(b, p, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
  return v;
}

const cat = (...parts) => {
  const n = parts.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
};

/** @returns {Promise<Blob>} the same video with a proper duration (or the original blob if it cannot be patched) */
export async function fixWebmDuration(blob, durationMs) {
  try {
    if (!blob || !blob.size || !(durationMs > 0)) return blob;
    const headLen = Math.min(blob.size, 1 << 16);
    const b = new Uint8Array(await blob.slice(0, headLen).arrayBuffer());
    const rest = blob.slice(headLen);
    let p = 0;
    let id = readId(b, p);
    if (!id || id.v !== 0x1a45dfa3) return blob; // EBML header
    let sz = readSize(b, p + id.len);
    p += id.len + sz.len + sz.v;
    id = readId(b, p);
    if (!id || id.v !== 0x18538067) return blob; // Segment
    sz = readSize(b, p + id.len);
    p += id.len + sz.len;
    while (p < b.length - 12) {
      id = readId(b, p);
      if (!id) return blob;
      sz = readSize(b, p + id.len);
      if (!sz) return blob;
      if (id.v === 0x114d9b74) return blob; // SeekHead: inserting bytes would break its offsets
      if (id.v === 0x1549a966) { // Info
        const dataStart = p + id.len + sz.len;
        const dataEnd = dataStart + sz.v;
        if (dataEnd > b.length) return blob;
        let scale = 1e6;
        let q = dataStart;
        let durAt = -1, durLen = 0;
        while (q < dataEnd) {
          const cid = readId(b, q);
          const cs = cid && readSize(b, q + cid.len);
          if (!cid || !cs) return blob;
          const d = q + cid.len + cs.len;
          if (cid.v === 0x2ad7b1) scale = readUInt(b, d, cs.v) || 1e6; // TimecodeScale
          if (cid.v === 0x4489) { durAt = d; durLen = cs.v; } // Duration
          q = d + cs.v;
        }
        const dur = (durationMs * 1e6) / scale;
        if (durAt >= 0) {
          const dv = new DataView(b.buffer, b.byteOffset + durAt, durLen);
          if (durLen === 8) dv.setFloat64(0, dur); else if (durLen === 4) dv.setFloat32(0, dur); else return blob;
          return new Blob([b, rest], { type: blob.type });
        }
        const el = new Uint8Array(11);
        el[0] = 0x44; el[1] = 0x89; el[2] = 0x88;
        new DataView(el.buffer).setFloat64(3, dur);
        const head = cat(b.subarray(0, p + id.len), encodeSize(sz.v + el.length, sz.len), b.subarray(dataStart, dataEnd), el, b.subarray(dataEnd));
        return new Blob([head, rest], { type: blob.type });
      }
      if (sz.unknown) return blob;
      p += id.len + sz.len + sz.v;
    }
    return blob;
  } catch (e) {
    return blob;
  }
}
