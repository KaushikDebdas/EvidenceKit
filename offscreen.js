// Offscreen document: turns big blobs (stored in IndexedDB) into blob: URLs so chrome.downloads can save them.
import { dbGet, dbDel } from './lib/db.js';
import { saveToChosenFolder } from './lib/savedir.js';

const urls = new Map();

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.type === 'blobUrl') {
        const rec = await dbGet('captures', msg.key);
        const url = URL.createObjectURL(rec.blob);
        urls.set(msg.key, url);
        send({ url });
      } else if (msg.type === 'saveToDir') {
        const rec = await dbGet('captures', msg.key);
        if (!rec) return send({ ok: false, reason: 'missing file' });
        send(await saveToChosenFolder(rec.blob, msg.name, { saveTarget: 'folder' }, false));
      } else if (msg.type === 'release') {
        const u = urls.get(msg.key);
        if (u) URL.revokeObjectURL(u);
        urls.delete(msg.key);
        await dbDel('captures', msg.key);
        send({ ok: true });
      }
    } catch (e) {
      send({ error: String(e) });
    }
  })();
  return true;
});
