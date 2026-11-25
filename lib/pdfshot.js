// "Full page" of a PDF that is open in a tab. Chrome's PDF viewer cannot be scrolled or read by an extension,
// so the PDF file itself is loaded again and every page is drawn with pdf.js (lib/pdfjs, Apache-2.0),
// one below the other, like the viewer shows them. Runs in the offscreen document (it needs a DOM and a worker).

const GAP = 16; // grey space around and between the pages
const BG = '#e5e7eb';
const WIDE = 1240; // a page is drawn this wide when it fits (A4 at 150 dpi)
const NARROW = 800; // … and never narrower than this; pages that do not fit then are left out (and that is said)

let lib = null;
async function pdfjs() {
  if (!lib) {
    // the offscreen document is never painted, so requestAnimationFrame never fires there and pdf.js
    // (which draws in animation-frame chunks) would wait for ever: run those chunks on a timer instead
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
    window.cancelAnimationFrame = (id) => clearTimeout(id);
    lib = await import('./pdfjs/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/pdf.worker.min.mjs');
  }
  return lib;
}

// file:// needs XHR (fetch() refuses that scheme), and "Allow access to file URLs" switched on for the extension
function readFileUrl(url) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('GET', url);
    x.responseType = 'arraybuffer';
    x.onload = () => (x.response && x.response.byteLength ? res(x.response) : rej(new Error('empty file')));
    x.onerror = () => rej(new Error('cannot read the file'));
    x.send();
  });
}

// the PDF must really be one: a report address opened again may give a login page instead
function checkPdf(buf) {
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
  if (!head.includes('%PDF-')) throw new Error('the address does not give a PDF file when it is opened again (it may need a login form or a POST)');
  return new Uint8Array(buf);
}
async function load(url) {
  if (/^file:/i.test(url)) return checkPdf(await readFileUrl(url.replace(/#.*$/, '')));
  const r = await fetch(url.replace(/#.*$/, ''), { credentials: 'include' });
  if (!r.ok) throw new Error(`the PDF could not be downloaded again (HTTP ${r.status})`);
  return checkPdf(await r.arrayBuffer());
}

/**
 * src: the PDF's address, or its bytes (ArrayBuffer / Blob) when the tab already handed them over
 * @returns {Promise<{ blob: Blob, pages: number, shown: number }>}
 */
export async function renderPdf(src, maxH = 16000) {
  const pdf = await pdfjs();
  const task = pdf.getDocument({
    data: typeof src === 'string' ? await load(src) : checkPdf(src instanceof Blob ? await src.arrayBuffer() : src),
    isEvalSupported: false, // the extension's CSP does not allow eval
    useWasm: false, // nor WebAssembly: pdf.js uses its JavaScript decoders instead
    standardFontDataUrl: chrome.runtime.getURL('lib/pdfjs/standard_fonts/'),
  });
  task.onPassword = () => task.destroy();
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('the PDF is protected with a password');
    if (task.destroyed) throw new Error('the PDF is protected with a password');
    throw e;
  }
  try {
    const n = doc.numPages;
    const pages = [];
    let widest = 1;
    for (let i = 1; i <= n; i++) {
      const p = await doc.getPage(i);
      const v = p.getViewport({ scale: 1 });
      pages.push({ p, w: v.width, h: v.height });
      widest = Math.max(widest, v.width);
    }
    // the biggest size at which every page fits; if even NARROW is too tall, the first pages that fit
    const note = 28; // room for the "pages 1–N of M" line
    const heightAt = (s, k = n) => GAP + pages.slice(0, k).reduce((a, x) => a + Math.round(x.h * s) + GAP, 0);
    let scale = WIDE / widest;
    if (heightAt(scale) > maxH) scale = Math.max(NARROW / widest, scale * (maxH - GAP * (n + 1)) / (heightAt(scale) - GAP * (n + 1)));
    let shown = n;
    while (shown > 1 && heightAt(scale, shown) + (shown < n ? note : 0) > maxH) shown--;
    if (heightAt(scale, 1) > maxH) scale *= (maxH - 2 * GAP - note) / (heightAt(scale, 1) - 2 * GAP); // one very tall page

    const W = Math.round(widest * scale) + 2 * GAP;
    const H = heightAt(scale, shown) + (shown < n ? note : 0);
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const g = out.getContext('2d');
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    const tmp = document.createElement('canvas');
    let y = GAP;
    for (let i = 0; i < shown; i++) {
      const { p } = pages[i];
      const v = p.getViewport({ scale });
      tmp.width = Math.round(v.width);
      tmp.height = Math.round(v.height);
      const tg = tmp.getContext('2d');
      tg.fillStyle = '#fff';
      tg.fillRect(0, 0, tmp.width, tmp.height);
      await p.render({ canvas: tmp, canvasContext: tg, viewport: v, annotationMode: pdf.AnnotationMode.ENABLE }).promise;
      const x = Math.round((W - tmp.width) / 2);
      g.fillStyle = 'rgba(0,0,0,.18)'; // a thin edge, so white pages stand out from each other
      g.fillRect(x - 1, y - 1, tmp.width + 2, tmp.height + 2);
      g.drawImage(tmp, x, y);
      y += tmp.height + GAP;
      p.cleanup();
    }
    if (shown < n) {
      g.fillStyle = '#374151';
      g.font = '600 15px system-ui, Arial, sans-serif';
      g.textAlign = 'center';
      g.fillText(`Pages 1–${shown} of ${n} (the picture cannot be taller)`, W / 2, H - 12);
    }
    tmp.width = tmp.height = 0;
    const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
    out.width = out.height = 0;
    if (!blob) throw new Error('the picture is too big');
    return { blob, pages: n, shown };
  } finally {
    doc.destroy();
  }
}
