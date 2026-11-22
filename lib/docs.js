// User Manual and Test Evidence are two separate documents in the same "steps" store.
// Every step / section has doc: 'manual' | 'evidence' | 'pending' (no doc = 'manual': made before the split).
// You choose where something goes at the moment you add it ("Add to Manual" / "Add to Test Evidence";
// both = it is added to both). A Step guide recording waits as doc 'pending' (one batch id per recording)
// until you choose on the manual page. kv manualMode only remembers which document the manual page shows.
import { dbGet, dbPut, dbAll, dbPutMany, dbDelMany, uid } from './db.js';

export const DOC_NAMES = { manual: 'User Manual', evidence: 'Test Evidence' };
export const docOf = (s) => (s && (s.doc === 'evidence' || s.doc === 'pending') ? s.doc : 'manual');
const isSection = (s) => s && s.type === 'section';
const byOrder = (a, b) => a.order - b.order;

/** the document the manual page shows (the one looked at last) */
export async function activeDoc() {
  try {
    const r = await dbGet('kv', 'manualMode');
    return r && r.value === 'evidence' ? 'evidence' : 'manual';
  } catch (e) {
    return 'manual';
  }
}
export const setActiveDoc = (d) => dbPut('kv', { key: 'manualMode', value: d === 'evidence' ? 'evidence' : 'manual' });

/** order for a new item at the end + how many steps (not sections) the document has already */
export async function nextSlot(doc) {
  const all = await dbAll('steps');
  return {
    order: all.reduce((m, s) => Math.max(m, s.order), 0) + 1,
    steps: all.filter((s) => !isSection(s) && docOf(s) === doc).length,
  };
}

/**
 * add items (sections and steps, in this order, without id / order / doc) at the end of a document
 * @returns {{ before: number, added: number }} steps the document had before, steps added
 */
export async function appendTo(doc, items) {
  const slot = await nextSlot(doc);
  let order = slot.order - 1;
  const rows = items.map((it) => ({ ...it, id: uid(), doc, order: ++order }));
  await dbPutMany('steps', rows);
  return { before: slot.steps, added: rows.filter((s) => !isSection(s)).length };
}

/** Step guide recordings that are waiting for "Add to Manual / Test Evidence" */
export async function pendingBatches() {
  const groups = new Map();
  for (const s of (await dbAll('steps')).filter((x) => x.doc === 'pending').sort(byOrder)) {
    const k = s.batch || 'none';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  return [...groups.entries()].map(([batch, items]) => ({
    batch, items,
    steps: items.filter((s) => !isSection(s)).length,
    title: (items.find(isSection) || {}).title || 'Step guide',
    ts: items[0].ts || 0,
  }));
}

/** put a waiting recording into the chosen document(s) — a copy in each — or throw it away (targets = []) */
export async function resolveBatch(batch, targets) {
  const items = (await dbAll('steps')).filter((s) => s.doc === 'pending' && (s.batch || 'none') === batch).sort(byOrder);
  const out = {};
  for (const doc of targets) {
    const copies = items.map(({ id, doc: d, batch: b, order, ...rest }) => (
      // in the Test Evidence a recording is a test case
      doc === 'evidence' && isSection(rest) && /^Step guide\b/.test(rest.title || '') ? { ...rest, title: rest.title.replace(/^Step guide/, 'Test case') } : rest));
    out[doc] = await appendTo(doc, copies);
  }
  await dbDelMany('steps', items.map((s) => s.id));
  return out;
}
