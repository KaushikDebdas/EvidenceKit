// Backup / restore of the User Manual and Test Evidence: every step and section (with all their pictures),
// the title, logo, brand colour, document type, evidence details and the extension settings, in one .zip.
//   evidencekit-backup.json   the data; every picture is replaced by { "__evkBlob": "files/12.png", "type": "image/png" }
//   files/…                   the pictures
// Screenshots that are only kept for 24 h ("Last capture") are not part of it.
/* global JSZip */

export const BACKUP_FORMAT = 'evidencekit-backup';
const BACKUP_VERSION = 1;
const JSON_NAME = 'evidencekit-backup.json';
export const KV_KEYS = ['manualTitle', 'evidenceTitle', 'manualBrand', 'manualMode', 'evidenceInfo'];

const extOf = (type) => (/jpe?g/.test(type) ? 'jpg' : /webp/.test(type) ? 'webp' : /gif/.test(type) ? 'gif' : /svg/.test(type) ? 'svg' : /png/.test(type) ? 'png' : 'bin');

// Blobs -> files in the zip (recursively, anywhere in the data)
function pack(value, zip, counter) {
  if (value instanceof Blob) {
    const path = `files/${++counter.n}.${extOf(value.type)}`;
    zip.file(path, value);
    return { __evkBlob: path, type: value.type || '' };
  }
  if (Array.isArray(value)) return value.map((v) => pack(v, zip, counter));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = pack(v, zip, counter);
    return out;
  }
  return value;
}

async function unpack(value, zip) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.__evkBlob === 'string') {
    const f = zip.file(value.__evkBlob);
    if (!f) return null; // picture missing from the zip: keep the step, without that picture
    return new Blob([await f.async('arraybuffer')], { type: typeof value.type === 'string' ? value.type : '' });
  }
  if (Array.isArray(value)) return Promise.all(value.map((v) => unpack(v, zip)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await unpack(v, zip);
    return out;
  }
  return value;
}

/** @returns {Promise<Blob>} the .zip */
export async function makeBackup({ items, kv, settings, appVersion }) {
  const zip = new JSZip();
  const counter = { n: 0 };
  const data = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    app: 'EvidenceKit',
    appVersion: appVersion || '',
    exportedAt: new Date().toISOString(),
    items: pack(items, zip, counter),
    kv: pack(kv, zip, counter),
    settings: settings || null,
  };
  zip.file(JSON_NAME, JSON.stringify(data));
  return zip.generateAsync({ type: 'blob', compression: 'STORE' }); // pictures are PNG/JPG already: no point compressing
}

/** reads and checks a backup .zip; throws a readable Error when it is not one */
export async function readBackup(file) {
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch (e) { throw new Error('This file is not a .zip backup.'); }
  const jf = zip.file(JSON_NAME);
  if (!jf) throw new Error('This .zip is not an EvidenceKit backup (no ' + JSON_NAME + ' inside).');
  let data;
  try { data = JSON.parse(await jf.async('string')); } catch (e) { throw new Error('The backup file is damaged (its data cannot be read).'); }
  if (!data || data.format !== BACKUP_FORMAT) throw new Error('This .zip is not an EvidenceKit backup.');
  if (data.version > BACKUP_VERSION) throw new Error('This backup was made by a newer version of EvidenceKit. Update the extension first.');
  if (!Array.isArray(data.items)) throw new Error('The backup file is damaged (no steps list).');
  // keep only well-formed steps / sections
  const items = (await unpack(data.items, zip)).filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id && Number.isFinite(+s.order))
    .map((s) => ({ ...s, order: +s.order, type: s.type === 'section' ? 'section' : undefined }));
  const kvIn = data.kv && typeof data.kv === 'object' ? await unpack(data.kv, zip) : {};
  const kv = {};
  for (const k of KV_KEYS) if (kvIn[k] !== undefined) kv[k] = kvIn[k];
  const settings = data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? data.settings : null;
  return {
    items, kv, settings,
    exportedAt: data.exportedAt || '',
    steps: items.filter((s) => s.type !== 'section').length,
    sections: items.filter((s) => s.type === 'section').length,
  };
}
