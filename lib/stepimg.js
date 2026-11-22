// Step images that keep their own "recipe", so numbers and annotations stay editable.
//  step.raw   clean screenshot (no marker)
//  step.mark  { rect, pt, vw, color, oy }  where the click happened (oy: height of the URL / time bar above
//             the screenshot, in image pixels: the marker is drawn that much lower)
//  step.num   the number drawn on step.blob right now
//  step.edit  { raw, json, frame }     editor layers saved with "Save to step"

export function markOf(msg, color, oy = 0) {
  if (!msg || (!msg.rect && !msg.pt)) return null;
  return { rect: msg.rect || null, pt: msg.pt || null, vw: msg.vw || null, color: color || '#ef4444', oy: Math.round(oy) || 0 };
}

// Draw the click outline + numbered badge on a clean screenshot (plain canvas; works in the service worker too).
export async function bakeMarker(rawBlob, mark, n) {
  const bmp = await createImageBitmap(rawBlob);
  const sc = bmp.width / (mark.vw || bmp.width);
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = oc.getContext('2d');
  const color = mark.color || '#ef4444';
  const oy = mark.oy || 0;
  ctx.drawImage(bmp, 0, 0);
  if (mark.rect) {
    const pad = 5 * sc;
    const x = mark.rect.x * sc - pad, y = mark.rect.y * sc - pad + oy, w = mark.rect.w * sc + pad * 2, h = mark.rect.h * sc + pad * 2;
    ctx.lineWidth = Math.max(3, 3 * sc);
    ctx.strokeStyle = color;
    ctx.fillStyle = color + '22';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, 8 * sc); else ctx.rect(x, y, w, h);
    ctx.fill(); ctx.stroke();
    const r = 13 * sc;
    const bx = Math.max(r + 2, x), by = Math.max(oy + r + 2, y);
    ctx.beginPath(); ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 2 * sc; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = `bold ${Math.round(r * 1.1)}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(n), bx, by + 1);
  } else if (mark.pt) {
    const r = 20 * sc;
    ctx.lineWidth = Math.max(3, 3 * sc);
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.arc(mark.pt.x * sc, mark.pt.y * sc + oy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = color + '55'; ctx.fill();
  }
  return oc.convertToBlob({ type: 'image/png' });
}

// Does this step carry an auto number that is out of date?
export function numberIsStale(st, n) {
  if (st.edit) return !!(st.edit.json && hasAuto(st.edit.json)) && st.num !== n && !st.edit.frame;
  return !!(st.raw && st.mark && (st.mark.rect) && st.num !== n);
}
function hasAuto(json) { return (json.objects || []).some((o) => o.autoNum); }

// Rebuild the picture of an edited step with the current number (needs fabric on the page).
async function renderEdited(st, n) {
  const bmp = await createImageBitmap(st.edit.raw);
  const base = document.createElement('canvas');
  base.width = bmp.width; base.height = bmp.height;
  base.getContext('2d').drawImage(bmp, 0, 0);
  const json = JSON.parse(JSON.stringify(st.edit.json));
  json.objects.forEach((o) => {
    if (!o.autoNum) return;
    (o.objects || []).forEach((c) => { if (c.type === 'text') c.text = String(n); });
  });
  const sc = new fabric.StaticCanvas(null, { width: base.width, height: base.height, enableRetinaScaling: false });
  await new Promise((res) => sc.loadFromJSON(json, res));
  sc.setBackgroundImage(new fabric.Image(base, { left: 0, top: 0 }), () => {});
  sc.renderAll();
  const out = sc.toCanvasElement(1);
  const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
  st.edit.json = json;
  sc.dispose();
  return blob;
}

// Bring step.blob in line with the number the manual shows. Returns true if the step changed.
export async function syncNumber(st, n) {
  if (!numberIsStale(st, n)) return false;
  st.blob = st.edit ? await renderEdited(st, n) : await bakeMarker(st.raw, st.mark, n);
  st.num = n;
  return true;
}
