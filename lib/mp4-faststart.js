// Chrome's MediaRecorder writes *fragmented* MP4: an empty index (moov) followed by many small
// moof + mdat pieces. Players then show no length and the seek bar cannot be dragged.
// This rebuilds a normal ("progressive", fast-start) MP4: one full moov index at the front with
// every sample's time, size, position and key-frame flag, followed by one mdat with the media data.
// The media bytes are not copied or re-encoded: the new file references slices of the original blob.

const U32 = 2 ** 32;

async function readBytes(blob, start, len) {
  return new Uint8Array(await blob.slice(start, Math.min(blob.size, start + len)).arrayBuffer());
}
const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
const i32 = (b, p) => (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
const u64 = (b, p) => u32(b, p) * U32 + u32(b, p + 4);
const type4 = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** child boxes of b[start..end): [{ type, start, end, body }] where body is where the payload starts */
function boxes(b, start = 0, end = b.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = type4(b, p + 4);
    let hdr = 8;
    if (size === 1) { size = u64(b, p + 8); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, end: p + size, body: p + hdr });
    p += size;
  }
  return out;
}
const child = (b, box, type) => box && boxes(b, box.body, box.end).find((x) => x.type === type);
const path = (b, box, ...types) => types.reduce((x, t) => child(b, x, t), box);

// ---------------- writing ----------------
function cat(parts) {
  const n = parts.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}
function box(type, ...parts) {
  const body = cat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}
function fullBox(type, version, flags, ...parts) {
  return box(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
}
function u32s(arr) {
  const out = new Uint8Array(arr.length * 4);
  const dv = new DataView(out.buffer);
  arr.forEach((v, i) => dv.setUint32(i * 4, v >>> 0));
  return out;
}
function i32s(arr) {
  const out = new Uint8Array(arr.length * 4);
  const dv = new DataView(out.buffer);
  arr.forEach((v, i) => dv.setInt32(i * 4, v));
  return out;
}
function u64s(arr) {
  const out = new Uint8Array(arr.length * 8);
  const dv = new DataView(out.buffer);
  arr.forEach((v, i) => { dv.setUint32(i * 8, Math.floor(v / U32)); dv.setUint32(i * 8 + 4, v % U32); });
  return out;
}
/** copy of a box with the version-dependent duration field replaced (mvhd / tkhd / mdhd) */
function withDuration(b, bx, at0, at1, dur) {
  const out = b.slice(bx.start, bx.end);
  const v = out[bx.body - bx.start];
  const dv = new DataView(out.buffer);
  const p = bx.body - bx.start + (v === 1 ? at1 : at0);
  if (v === 1) { dv.setUint32(p, Math.floor(dur / U32)); dv.setUint32(p + 4, dur % U32); } else dv.setUint32(p, Math.min(U32 - 1, dur));
  return out;
}
/** copy of a box, with some children dropped / replaced / added (only for plain container boxes) */
function rebuild(b, bx, fn, extra = []) {
  const kids = boxes(b, bx.body, bx.end).map((c) => fn(c)).filter(Boolean);
  return box(bx.type, ...kids, ...extra);
}

// ---------------- main ----------------
/**
 * @param {Blob} blob a fragmented MP4 from MediaRecorder
 * @returns {Promise<Blob>} a seekable MP4 (or the original blob when it is not fragmented / cannot be converted)
 */
export async function fixMp4(blob) {
  try {
    if (!blob || blob.size < 16) return blob;
    // top-level boxes: read only their headers (mdat can be hundreds of MB)
    const top = [];
    for (let p = 0; p + 8 <= blob.size;) {
      const h = await readBytes(blob, p, 16);
      let size = u32(h, 0), hdr = 8;
      const type = type4(h, 4);
      if (size === 1) { size = u64(h, 8); hdr = 16; } else if (size === 0) size = blob.size - p;
      if (size < hdr) break;
      top.push({ type, start: p, end: Math.min(blob.size, p + size), body: p + hdr });
      p += size;
    }
    const ftypBox = top.find((x) => x.type === 'ftyp');
    const moovBox = top.find((x) => x.type === 'moov');
    if (!ftypBox || !moovBox || !top.some((x) => x.type === 'moof')) return blob; // already a normal MP4

    const ftyp = await readBytes(blob, ftypBox.start, ftypBox.end - ftypBox.start);
    const mb = await readBytes(blob, moovBox.start, moovBox.end - moovBox.start);
    const moov = boxes(mb)[0];
    const mvhd = child(mb, moov, 'mvhd');
    const movieScale = u32(mb, mvhd.body + (mb[mvhd.body] === 1 ? 20 : 12));

    // per-track defaults from mvex/trex
    const trex = {};
    for (const t of boxes(mb, (child(mb, moov, 'mvex') || { body: 0, end: 0 }).body, (child(mb, moov, 'mvex') || { end: 0 }).end)) {
      if (t.type !== 'trex') continue;
      const p = t.body + 4;
      trex[u32(mb, p)] = { sdi: u32(mb, p + 4), dur: u32(mb, p + 8), size: u32(mb, p + 12), flags: u32(mb, p + 16) };
    }
    const tracks = {};
    for (const t of boxes(mb, moov.body, moov.end)) {
      if (t.type !== 'trak') continue;
      const tkhd = child(mb, t, 'tkhd');
      const id = u32(mb, tkhd.body + (mb[tkhd.body] === 1 ? 20 : 12));
      const mdhd = path(mb, t, 'mdia', 'mdhd');
      const scale = u32(mb, mdhd.body + (mb[mdhd.body] === 1 ? 20 : 12));
      tracks[id] = { id, trak: t, scale, samples: [], chunks: [], dts: null, firstDts: null };
    }

    // walk every moof: collect samples (decode time, duration, size, flags, cto) and where their bytes are
    const mdats = []; // { start (payload start in original), end, at (offset inside the new mdat payload) }
    let payload = 0;
    for (const x of top) {
      if (x.type === 'mdat') { mdats.push({ start: x.body, end: x.end, at: payload }); payload += x.end - x.body; }
    }
    for (const x of top) {
      if (x.type !== 'moof') continue;
      const fb = await readBytes(blob, x.start, x.end - x.start);
      const moof = boxes(fb)[0];
      let prevEnd = x.start; // implicit base for a traf without base-data-offset / default-base-is-moof
      let firstTraf = true;
      for (const traf of boxes(fb, moof.body, moof.end)) {
        if (traf.type !== 'traf') continue;
        const tfhd = child(fb, traf, 'tfhd');
        if (!tfhd) continue;
        const tf = (fb[tfhd.body + 1] << 16) | (fb[tfhd.body + 2] << 8) | fb[tfhd.body + 3];
        const id = u32(fb, tfhd.body + 4);
        const tr = tracks[id];
        if (!tr) continue;
        const d = trex[id] || { sdi: 1, dur: 0, size: 0, flags: 0 };
        let q = tfhd.body + 8;
        let base = tf & 0x20000 || firstTraf ? x.start : prevEnd;
        if (tf & 0x1) { base = u64(fb, q); q += 8; }
        let sdi = d.sdi, defDur = d.dur, defSize = d.size, defFlags = d.flags;
        if (tf & 0x2) { sdi = u32(fb, q); q += 4; }
        if (tf & 0x8) { defDur = u32(fb, q); q += 4; }
        if (tf & 0x10) { defSize = u32(fb, q); q += 4; }
        if (tf & 0x20) { defFlags = u32(fb, q); q += 4; }
        firstTraf = false;

        const tfdt = child(fb, traf, 'tfdt');
        if (tfdt) {
          const t = fb[tfdt.body] === 1 ? u64(fb, tfdt.body + 4) : u32(fb, tfdt.body + 4);
          if (tr.dts == null) { tr.dts = t; tr.firstDts = t; } else if (t > tr.dts && tr.samples.length) {
            tr.samples[tr.samples.length - 1].dur += t - tr.dts; // a gap: stretch the previous sample over it
            tr.dts = t;
          }
        }
        if (tr.dts == null) { tr.dts = 0; tr.firstDts = 0; }

        let pos = base;
        for (const trun of boxes(fb, traf.body, traf.end)) {
          if (trun.type !== 'trun') continue;
          const ver = fb[trun.body];
          const fl = (fb[trun.body + 1] << 16) | (fb[trun.body + 2] << 8) | fb[trun.body + 3];
          const n = u32(fb, trun.body + 4);
          let r = trun.body + 8;
          if (fl & 0x1) { pos = base + i32(fb, r); r += 4; }
          let firstFlags = null;
          if (fl & 0x4) { firstFlags = u32(fb, r); r += 4; }
          const chunkStart = pos;
          let count = 0;
          for (let i = 0; i < n; i++) {
            let dur = defDur, size = defSize, flags = i === 0 && firstFlags != null ? firstFlags : defFlags, cto = 0;
            if (fl & 0x100) { dur = u32(fb, r); r += 4; }
            if (fl & 0x200) { size = u32(fb, r); r += 4; }
            if (fl & 0x400) { flags = u32(fb, r); r += 4; if (i === 0 && firstFlags != null) flags = firstFlags; }
            if (fl & 0x800) { cto = ver ? i32(fb, r) : u32(fb, r); r += 4; }
            tr.samples.push({ dur, size, sync: !(flags & 0x10000), cto });
            tr.dts += dur;
            pos += size;
            count++;
          }
          if (count) tr.chunks.push({ src: chunkStart, n: count, sdi });
        }
        prevEnd = pos;
      }
    }
    const list = Object.values(tracks).filter((t) => t.samples.length);
    if (!list.length) return blob;

    // where each chunk's bytes land inside the new mdat payload (original mdat payloads, back to back)
    for (const t of list) {
      for (const c of t.chunks) {
        const m = mdats.find((z) => c.src >= z.start && c.src < z.end);
        if (!m) return blob;
        c.at = m.at + (c.src - m.start);
      }
    }

    const mdatHdr = payload + 8 < U32 ? 8 : 16;
    const build = (dataStart, big) => {
      let movieDur = 0;
      const traks = list.map((t) => {
        const mediaDur = t.samples.reduce((a, s) => a + s.dur, 0);
        const toMovie = (v) => Math.round((v * movieScale) / t.scale);
        // edit list: keep the original one (shifted, since the new sample table starts at time 0)
        const shift = t.firstDts || 0;
        let entries = [];
        const elst = path(mb, t.trak, 'edts', 'elst');
        if (elst) {
          const v = mb[elst.body];
          const n = u32(mb, elst.body + 4);
          let p = elst.body + 8;
          for (let i = 0; i < n; i++) {
            let seg, mt;
            if (v === 1) { seg = u64(mb, p); mt = u32(mb, p + 8) * U32 + u32(mb, p + 12); if (mb[p + 8] & 0x80) mt = -1; p += 16; }
            else { seg = u32(mb, p); mt = i32(mb, p + 4); p += 8; }
            const rate = u32(mb, p); p += 4;
            if (mt >= 0) mt = Math.max(0, mt - shift);
            if (!seg) seg = mt >= 0 ? toMovie(Math.max(0, mediaDur - mt)) : 0;
            if (seg || mt >= 0) entries.push([seg, mt, rate]);
          }
        } else if (shift > 0) {
          entries = [[toMovie(shift), -1, 0x10000], [toMovie(mediaDur), 0, 0x10000]];
        }
        const trackDur = entries.length ? entries.reduce((a, e) => a + e[0], 0) : toMovie(mediaDur);
        movieDur = Math.max(movieDur, trackDur);
        const edts = entries.length ? box('edts', fullBox('elst', 1, 0, u32s([entries.length]),
          ...entries.map(([seg, mt, rate]) => cat([u64s([seg]), mt < 0 ? u32s([0xffffffff, 0xffffffff]) : u64s([mt]), u32s([rate])])))) : null;

        // sample tables
        const S = t.samples;
        const stts = [];
        for (const s of S) {
          const last = stts[stts.length - 1];
          if (last && last[1] === s.dur) last[0]++; else stts.push([1, s.dur]);
        }
        const anyCto = S.some((s) => s.cto);
        const negCto = S.some((s) => s.cto < 0);
        const ctts = [];
        if (anyCto) for (const s of S) {
          const last = ctts[ctts.length - 1];
          if (last && last[1] === s.cto) last[0]++; else ctts.push([1, s.cto]);
        }
        const syncs = [];
        S.forEach((s, i) => { if (s.sync) syncs.push(i + 1); });
        const stsc = [];
        t.chunks.forEach((c, i) => {
          const last = stsc[stsc.length - 1];
          if (!last || last[1] !== c.n || last[2] !== c.sdi) stsc.push([i + 1, c.n, c.sdi]);
        });
        const offs = t.chunks.map((c) => dataStart + c.at);
        const stblOld = path(mb, t.trak, 'mdia', 'minf', 'stbl');
        const newTables = [
          fullBox('stts', 0, 0, u32s([stts.length, ...stts.flat()])),
          anyCto ? fullBox('ctts', negCto ? 1 : 0, 0, u32s([ctts.length]), ...ctts.map(([n, o]) => cat([u32s([n]), negCto ? i32s([o]) : u32s([o])]))) : null,
          syncs.length < S.length ? fullBox('stss', 0, 0, u32s([syncs.length, ...syncs])) : null,
          fullBox('stsc', 0, 0, u32s([stsc.length, ...stsc.flat()])),
          fullBox('stsz', 0, 0, u32s([0, S.length, ...S.map((s) => s.size)])),
          big ? fullBox('co64', 0, 0, u32s([offs.length]), u64s(offs)) : fullBox('stco', 0, 0, u32s([offs.length, ...offs])),
        ].filter(Boolean);
        const TABLES = ['stts', 'ctts', 'stss', 'stsc', 'stsz', 'stz2', 'stco', 'co64', 'sdtp', 'sbgp', 'sgpd', 'cslg'];
        const stbl = rebuild(mb, stblOld, (c) => (TABLES.includes(c.type) ? null : mb.slice(c.start, c.end)), newTables);
        const minfOld = path(mb, t.trak, 'mdia', 'minf');
        const minf = rebuild(mb, minfOld, (c) => (c.type === 'stbl' ? stbl : mb.slice(c.start, c.end)));
        const mdiaOld = child(mb, t.trak, 'mdia');
        const mdia = rebuild(mb, mdiaOld, (c) => {
          if (c.type === 'mdhd') return withDuration(mb, c, 16, 24, mediaDur);
          if (c.type === 'minf') return minf;
          return mb.slice(c.start, c.end);
        });
        let hadEdts = false;
        const trak = rebuild(mb, t.trak, (c) => {
          if (c.type === 'tkhd') return withDuration(mb, c, 20, 28, trackDur);
          if (c.type === 'mdia') return mdia;
          if (c.type === 'edts') { hadEdts = true; return edts; }
          return mb.slice(c.start, c.end);
        });
        if (hadEdts || !edts) return trak;
        // no edts before: put the new one right after tkhd
        const kids = boxes(trak, 8, trak.length).map((c) => trak.slice(c.start, c.end));
        return box('trak', kids[0], edts, ...kids.slice(1));
      });
      let ti = 0;
      return rebuild(mb, moov, (c) => {
        if (c.type === 'mvhd') return withDuration(mb, c, 16, 24, movieDur);
        if (c.type === 'mvex') return null;
        if (c.type === 'trak') {
          const id = u32(mb, child(mb, c, 'tkhd').body + (mb[child(mb, c, 'tkhd').body] === 1 ? 20 : 12));
          return list.some((t) => t.id === id) ? traks[ti++] : null;
        }
        return mb.slice(c.start, c.end);
      });
    };
    // build once to learn the index size, then again with the real data positions
    let newMoov = build(0, false);
    let dataStart = ftyp.length + newMoov.length + mdatHdr;
    const big = dataStart + payload >= U32;
    newMoov = build(dataStart, big);
    if (big) { dataStart = ftyp.length + newMoov.length + mdatHdr; newMoov = build(dataStart, true); }

    const hdr = new Uint8Array(mdatHdr);
    const dv = new DataView(hdr.buffer);
    if (mdatHdr === 8) dv.setUint32(0, payload + 8);
    else { dv.setUint32(0, 1); dv.setUint32(8, Math.floor((payload + 16) / U32)); dv.setUint32(12, (payload + 16) % U32); }
    hdr.set([0x6d, 0x64, 0x61, 0x74], 4); // 'mdat'
    return new Blob([ftyp, newMoov, hdr, ...mdats.map((m) => blob.slice(m.start, m.end))], { type: blob.type || 'video/mp4' });
  } catch (e) {
    console.warn('MP4 fix failed, keeping the original file', e);
    return blob;
  }
}
