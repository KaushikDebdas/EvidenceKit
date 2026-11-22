// "Save to a folder I choose": a directory picked in Settings (File System Access API).
// The folder handle lives in IndexedDB (kv: saveDir). Works in extension pages and the offscreen document,
// not in the service worker. When Chrome no longer remembers the permission, callers fall back to Downloads.
import { dbGet, dbPut, dbDel } from './db.js';

export const folderPickerSupported = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

export async function getSaveDir() {
  try { const r = await dbGet('kv', 'saveDir'); return (r && r.value) || null; } catch (e) { return null; }
}
export async function setSaveDir(handle) {
  if (handle) await dbPut('kv', { key: 'saveDir', value: handle });
  else await dbDel('kv', 'saveDir');
}

/** 'granted' | 'prompt' | 'denied' | 'none' — ask=true may show Chrome's prompt (needs a click) */
export async function dirPermission(handle, ask) {
  if (!handle) return 'none';
  const o = { mode: 'readwrite' };
  try {
    let p = await handle.queryPermission(o);
    if (p !== 'granted' && ask) p = await handle.requestPermission(o);
    return p;
  } catch (e) { return 'denied'; }
}

async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch (e) { return false; }
}

/** writes blob as name (adds " (1)", " (2)" … when the name is taken); returns the name used */
export async function writeToDir(dir, name, blob) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = name;
  for (let i = 1; i < 1000 && (await exists(dir, n)); i++) n = `${base} (${i})${ext}`;
  const fh = await dir.getFileHandle(n, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return n;
}

/**
 * Save into the chosen folder when the settings ask for it.
 * @returns {Promise<{ok:boolean, name?:string, folder?:string, reason?:string}>}
 */
export async function saveToChosenFolder(blob, name, settings, ask = false) {
  if (!settings || settings.saveTarget !== 'folder') return { ok: false, reason: 'off' };
  const dir = await getSaveDir();
  if (!dir) return { ok: false, reason: 'nofolder' };
  const p = await dirPermission(dir, ask);
  if (p !== 'granted') return { ok: false, reason: 'permission' };
  try {
    const used = await writeToDir(dir, name, blob);
    return { ok: true, name: used, folder: dir.name };
  } catch (e) {
    return { ok: false, reason: 'write: ' + e.message };
  }
}
