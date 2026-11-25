// Chrome's MediaRecorder writes WebM files without a Duration and without Cues (the seek index),
// so players show no length and cannot seek (Windows Media Player cannot seek even with a Duration).
// fixWebmDuration() rebuilds the file layout: Segment with a real size, SeekHead, Info + Duration,
// Tracks, Clusters with real sizes, and Cues at the end. Audio/video data is not copied or re-encoded.

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

// fallback: only add the Duration (Chrome can then seek, Windows players still cannot)
async function patchDuration(blob, durationMs) {
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

// ---------------- full rebuild with Cues ----------------
const LEVEL1 = new Set([0x1f43b675, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469, 0x114d9b74, 0x1549a966, 0x1654ae6b]);
const CLUSTER = 0x1f43b675, INFO = 0x1549a966, TRACKS = 0x1654ae6b;

// reads a big blob through a 4 MB window, so walking thousands of small elements stays fast
class Reader {
  constructor(blob) { this.blob = blob; this.start = 0; this.buf = new Uint8Array(0); }
  async bytes(pos, len) {
    const end = Math.min(this.blob.size, pos + len);
    if (pos < this.start || end > this.start + this.buf.length) {
      this.start = pos;
      this.buf = new Uint8Array(await this.blob.slice(pos, Math.min(this.blob.size, pos + Math.max(len, 4 << 20))).arrayBuffer());
    }
    return this.buf.subarray(pos - this.start, end - this.start);
  }
  /** element header at pos: { id, data (payload start), size (null when unknown) } */
  async head(pos) {
    const b = await this.bytes(pos, 12);
    const id = readId(b, 0);
    const sz = id && readSize(b, id.len);
    if (!sz) return null;
    return { id: id.v, data: pos + id.len + sz.len, size: sz.unknown ? null : sz.v };
  }
}

function children(b) {
  const out = [];
  for (let p = 0; p < b.length;) {
    const id = readId(b, p);
    const sz = id && readSize(b, p + id.len);
    if (!sz || sz.unknown) break;
    const d = p + id.len + sz.len;
    out.push({ id: id.v, start: p, data: d, end: d + sz.v });
    p = d + sz.v;
  }
  return out;
}
const idBytes = (v) => { const n = v > 0xffffff ? 4 : v > 0xffff ? 3 : v > 0xff ? 2 : 1; const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = v % 256; v = Math.floor(v / 256); } return o; };
const uintB = (v, n = 8) => { const o = new Uint8Array(n); for (let i = n - 1; i >= 0; i--) { o[i] = v % 256; v = Math.floor(v / 256); } return o; };
const el = (id, ...parts) => { const body = cat(...parts); return cat(idBytes(id), encodeSize(body.length, 8), body); };

async function rebuild(blob, durationMs) {
  const r = new Reader(blob);
  const ebml = await r.head(0);
  if (!ebml || ebml.id !== 0x1a45dfa3 || ebml.size == null) return null;
  const segPos = ebml.data + ebml.size;
  const seg = await r.head(segPos);
  if (!seg || seg.id !== 0x18538067) return null;
  const segEnd = seg.size == null ? blob.size : Math.min(blob.size, seg.data + seg.size);

  let info = null, tracks = null, scale = 1e6, cueTrack = 0, videoTrack = 0;
  let maxT = 0, lastV = -1, gap = 0;
  const clusters = [];
  for (let p = seg.data; p < segEnd;) {
    const h = await r.head(p);
    if (!h) break;
    if (h.id === CLUSTER) {
      const c = { start: h.data, end: 0, tc: 0, key: -1 };
      const limit = h.size == null ? segEnd : Math.min(segEnd, h.data + h.size);
      let q = h.data;
      while (q < limit) {
        const k = await r.head(q);
        if (!k || (h.size == null && LEVEL1.has(k.id))) break;
        if (k.size == null) return null;
        if (k.id === 0xe7) c.tc = readUInt(await r.bytes(k.data, k.size), 0, k.size); // Timecode
        else if (k.id === 0xa3 || k.id === 0xa0) { // SimpleBlock / BlockGroup
          let blk = null, key = false;
          if (k.id === 0xa3) {
            blk = await r.bytes(k.data, Math.min(k.size, 12));
          } else {
            const g = children(await r.bytes(k.data, k.size));
            const b = g.find((x) => x.id === 0xa1);
            if (b) blk = (await r.bytes(k.data, k.size)).subarray(b.data, b.end);
            key = !g.some((x) => x.id === 0xfb); // no ReferenceBlock: a key frame
          }
          const tn = blk && readSize(blk, 0);
          if (tn && blk.length >= tn.len + 3) {
            const t = c.tc + ((((blk[tn.len] << 8) | blk[tn.len + 1]) << 16) >> 16);
            if (k.id === 0xa3) key = !!(blk[tn.len + 2] & 0x80);
            maxT = Math.max(maxT, t);
            if (tn.v === videoTrack) { if (lastV >= 0 && t > lastV) gap = t - lastV; lastV = Math.max(lastV, t); }
            if (key && tn.v === cueTrack && c.key < 0) c.key = t;
          }
        }
        q = k.data + k.size;
      }
      c.end = Math.min(q, segEnd);
      clusters.push(c);
      p = c.end;
      continue;
    }
    if (h.size == null) return null;
    if (h.id === INFO) {
      info = await r.bytes(h.data, h.size);
      info = info.slice();
      const ts = children(info).find((x) => x.id === 0x2ad7b1);
      if (ts) scale = readUInt(info, ts.data, ts.end - ts.data) || 1e6;
    } else if (h.id === TRACKS) {
      tracks = (await r.bytes(p, h.data + h.size - p)).slice();
      for (const te of children(tracks.subarray(h.data - p))) {
        if (te.id !== 0xae) continue;
        const kids = children(tracks.subarray(h.data - p + te.data, h.data - p + te.end));
        const get = (id) => { const x = kids.find((z) => z.id === id); return x ? readUInt(tracks, h.data - p + te.data + x.data, x.end - x.data) : 0; };
        const num = get(0xd7), type = get(0x83);
        if (type === 1 && !videoTrack) videoTrack = num;
        if (!cueTrack) cueTrack = num;
      }
      if (videoTrack) cueTrack = videoTrack;
    }
    p = h.data + h.size;
  }
  if (!info || !tracks || !clusters.length) return null;

  // Duration (in TimecodeScale units): the last frame's time + one frame, or the measured time as a fallback
  const fromData = maxT > 0 ? maxT + (gap || Math.round(33e6 / scale)) : 0;
  const dur = fromData || (durationMs * 1e6) / scale;
  const durB = new Uint8Array(8);
  new DataView(durB.buffer).setFloat64(0, dur);
  const infoKids = children(info).filter((x) => x.id !== 0x4489).map((x) => info.subarray(x.start, x.end));
  const infoEl = el(INFO, ...infoKids, el(0x4489, durB));

  // layout inside the Segment: SeekHead, Info, Tracks, Clusters..., Cues
  const seek = (id, pos) => el(0x4dbb, el(0x53ab, idBytes(id)), el(0x53ac, uintB(pos)));
  const seekLen = el(0x114d9b74, seek(INFO, 0), seek(TRACKS, 0), seek(0x1c53bb6b, 0)).length;
  const infoPos = seekLen, tracksPos = infoPos + infoEl.length;
  let pos = tracksPos + tracks.length;
  const parts = [];
  const cues = [];
  for (const c of clusters) {
    const head = cat(idBytes(CLUSTER), encodeSize(c.end - c.start, 8));
    if (c.key >= 0) cues.push(el(0xbb, el(0xb3, uintB(c.key)), el(0xb7, el(0xf7, uintB(cueTrack, 1)), el(0xf1, uintB(pos)))));
    parts.push(head, blob.slice(c.start, c.end));
    pos += head.length + (c.end - c.start);
  }
  if (!cues.length) return null;
  const cuesEl = el(0x1c53bb6b, ...cues);
  const seekHead = el(0x114d9b74, seek(INFO, infoPos), seek(TRACKS, tracksPos), seek(0x1c53bb6b, pos));
  const segSize = pos + cuesEl.length;
  const ebmlBytes = (await r.bytes(0, segPos)).slice();
  return new Blob([ebmlBytes, idBytes(0x18538067), encodeSize(segSize, 8), seekHead, infoEl, tracks, ...parts, cuesEl], { type: blob.type || 'video/webm' });
}

/** @returns {Promise<Blob>} the same video with a Duration and a seek index (or the original blob if it cannot be fixed) */
export async function fixWebmDuration(blob, durationMs) {
  try {
    const out = blob && blob.size ? await rebuild(blob, durationMs) : null;
    if (out) return out;
  } catch (e) {
    console.warn('WebM rebuild failed, adding only the duration', e);
  }
  return patchDuration(blob, durationMs);
}
