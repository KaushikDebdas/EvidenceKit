import { DEFAULT_SETTINGS, fileStamp, compose, composeOpts } from '../lib/compose.js';
import { markOf, bakeMarker } from '../lib/stepimg.js';
import { fixWebmDuration } from '../lib/webm-duration.js';
import { fixMp4 } from '../lib/mp4-faststart.js';
import { dbPut, uid } from '../lib/db.js';
import { saveToChosenFolder } from '../lib/savedir.js';

// save to the chosen folder (Settings) or to Downloads/<folder>; returns a "where" text
async function saveOut(blob, name) {
  if (settings.saveTarget === 'folder') {
    const r = await saveToChosenFolder(blob, name, settings, true);
    if (r.ok) return `${r.folder}/${r.name}`;
  }
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename: saveFolder ? `${saveFolder}/${name}` : name, conflictAction: 'uniquify', saveAs: !!settings.saveAs });
  } catch (e) {
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return `Downloads${saveFolder ? '/' + saveFolder : ''}/${name}`;
}

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const srcTabId = qs.get('tab') ? +qs.get('tab') : null;
const shotMode = qs.get('mode') === 'shot';

let settings = { ...DEFAULT_SETTINGS };
let saveFolder = 'QA-Evidence';
let source = 'browser';
let recorder = null;
let displayStream = null;
let micStream = null;
let camStream = null;
let audioCtx = null;
let meterCtx = null;
let chunks = [];
let fmt = null;
let startedAt = 0, pausedMs = 0, pauseStart = 0;
let tick = null;
let lastBlob = null;
let durationMs = 0;
let stopping = false;
let pipWin = null;
let trimIn = 0, trimOut = null;
let steps = []; // repro steps: { n, ts, at (ms into the video), kind, title, url, pageTitle, img }
let stepsOn = false;

const QUALITY = { 720: [1280, 720, 4], 1080: [1920, 1080, 8], 1440: [2560, 1440, 12], 2160: [3840, 2160, 20] };
const FORMATS = {
  mp4: [
    { type: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
    { type: 'video/mp4;codecs=avc1,opus', ext: 'mp4' },
    { type: 'video/mp4;codecs=avc1', ext: 'mp4' },
    { type: 'video/mp4', ext: 'mp4' },
  ],
  webm: [
    { type: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { type: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { type: 'video/webm', ext: 'webm' },
  ],
};
const supported = (fam) => FORMATS[fam].find((f) => window.MediaRecorder && MediaRecorder.isTypeSupported(f.type));
function pickFormat(fam) { return supported(fam) || supported(fam === 'mp4' ? 'webm' : 'mp4'); }

const pad = (n) => String(n).padStart(2, '0');
const fmtSec = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
function elapsedMs() { return Math.max(0, Date.now() - startedAt - pausedMs - (pauseStart ? Date.now() - pauseStart : 0)); }
function show(view) { ['vSetup', 'vRec', 'vDone', 'vShot'].forEach((v) => { $(v).hidden = v !== view; }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const badge = (t, c = '#dc2626') => { try { chrome.action.setBadgeBackgroundColor({ color: c }); chrome.action.setBadgeText({ text: t }); } catch (e) {} };

async function saveSettings(patch) {
  Object.assign(settings, patch);
  const r = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...DEFAULT_SETTINGS, ...(r.settings || {}), ...patch } });
}

function cards(id, value, onPick) {
  const box = $(id);
  const mark = (v) => box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.src === v));
  mark(value);
  box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { mark(b.dataset.src); onPick(b.dataset.src); }));
}

// ---------------- devices: mic meter + camera preview ----------------
async function fillDevices(kind, selId) {
  const sel = $(selId);
  const cur = sel.value;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind);
  sel.textContent = '';
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || (kind === 'audioinput' ? `Microphone ${i + 1}` : `Camera ${i + 1}`);
    sel.append(o);
  });
  if (cur && devs.some((d) => d.deviceId === cur)) sel.value = cur;
}

async function startMic() {
  stopMic();
  try {
    const id = $('micDev').value;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
    await fillDevices('audioinput', 'micDev');
    meterCtx = new AudioContext();
    const an = meterCtx.createAnalyser();
    an.fftSize = 512;
    meterCtx.createMediaStreamSource(micStream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      if (!meterCtx) return;
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      $('micLevel').style.width = Math.min(100, (peak / 90) * 100) + '%';
      requestAnimationFrame(loop);
    };
    loop();
    $('micBox').hidden = false;
  } catch (e) {
    $('mic').checked = false;
    $('micBox').hidden = true;
    alert('Microphone is blocked or not available: ' + (e.message || e.name));
  }
}
function stopMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null;
  if (meterCtx) { meterCtx.close().catch(() => {}); meterCtx = null; }
}

async function startCam() {
  stopCam();
  try {
    const id = $('camDev').value;
    camStream = await navigator.mediaDevices.getUserMedia({ video: { ...(id ? { deviceId: { exact: id } } : {}), width: { ideal: 640 }, height: { ideal: 640 } } });
    await fillDevices('videoinput', 'camDev');
    $('camPrev').srcObject = camStream;
    $('camBox').hidden = false;
  } catch (e) {
    $('cam').checked = false;
    $('camBox').hidden = true;
    alert('Camera is blocked or not available: ' + (e.message || e.name));
  }
}
function stopCam() {
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  $('camPrev').srcObject = null;
}

// ---------------- recording ----------------
async function start() {
  $('start').disabled = true;
  try {
    const [w, h] = QUALITY[$('quality').value] || QUALITY[1080];
    const fps = +$('fps').value || 30;
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: source, width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps, max: fps } },
      audio: $('sysAudio').checked,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      systemAudio: 'include',
    });
    const vTrack = displayStream.getVideoTracks()[0];
    const tracks = [vTrack];
    const sysTracks = displayStream.getAudioTracks();
    if ($('mic').checked && !micStream) await startMic();
    if (micStream && sysTracks.length) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaStreamSource(new MediaStream(sysTracks)).connect(dest);
      audioCtx.createMediaStreamSource(micStream).connect(dest);
      tracks.push(...dest.stream.getAudioTracks());
    } else if (micStream) tracks.push(...micStream.getAudioTracks());
    else tracks.push(...sysTracks);

    const cd = +$('countdown').value || 0;
    if (cd) {
      $('cd').hidden = false;
      for (let i = cd; i > 0; i--) {
        $('cdN').textContent = i;
        badge(String(i), '#f59e0b');
        await sleep(1000);
        if (vTrack.readyState === 'ended') throw new Error('Sharing was cancelled');
      }
      $('cd').hidden = true;
    }

    fmt = pickFormat($('fmt').value || 'mp4');
    if (!fmt) throw new Error('This browser cannot record video (MediaRecorder not supported).');
    const q = QUALITY[$('quality').value] || QUALITY[1080];
    chunks = [];
    recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: fmt.type, videoBitsPerSecond: Math.round(q[2] * 1e6 * (fps / 30)) });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = finish;
    vTrack.addEventListener('ended', stop);

    startedAt = Date.now(); pausedMs = 0; pauseStart = 0; stopping = false;
    recorder.start(1000);
    tick = setInterval(renderTimer, 250);
    renderTimer();
    show('vRec');
    $('muteMic').hidden = !micStream;
    $('popout').querySelector('span').textContent = camStream ? 'Show camera bubble + controls (on top)' : 'Floating controls (always on top)';
    $('popNote').textContent = camStream ? 'Click it to show the camera bubble. It appears in window and screen recordings.' : '';
    $('recInfo').dataset.base = `${vTrack.getSettings().width || '?'}×${vTrack.getSettings().height || '?'} · ${fmt.ext.toUpperCase()}${tracks.length > 1 ? ' · audio' : ' · no audio'}`;
    badge('REC');
    if ($('clicks').checked && srcTabId != null) chrome.runtime.sendMessage({ type: 'recClicks', tabId: srcTabId, on: true }).catch(() => {});
    steps = [];
    pics = [];
    // entire screen / window: steps come from every Chrome tab, from switching programs, and their pictures
    // are taken from this video (so they show whatever is on the screen, Excel or a PDF included)
    surface = vTrack.getSettings().displaySurface || source;
    screenMode = surface === 'monitor' || surface === 'window';
    stepsOn = $('recSteps').checked && (srcTabId != null || screenMode);
    startGrabber(displayStream);
    $('addStep').hidden = !stepsOn;
    $('screenNote').hidden = !(stepsOn && screenMode);
    $('liveSteps').textContent = stepsOn ? 'Repro steps: 0' : '';
    if (stepsOn) chrome.runtime.sendMessage({ type: 'recStepsStart', tabId: srcTabId, screen: screenMode, shots: $('recStepShots').checked, values: $('recStepValues').checked }).catch(() => {});
    if (stepsOn && screenMode) startWatch();
  } catch (e) {
    $('cd').hidden = true;
    badge('');
    cleanupStreams(true);
    $('start').disabled = false;
    if (!(e && e.name === 'NotAllowedError')) alert('Could not start recording: ' + (e.message || e));
  }
}

function renderTimer() {
  const s = Math.floor(elapsedMs() / 1000);
  const t = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  $('timer').textContent = t;
  const paused = recorder && recorder.state === 'paused';
  document.title = `${paused ? '⏸' : '●'} ${t} — Recording`;
  const size = chunks.reduce((a, c) => a + c.size, 0);
  const info = $('recInfo');
  info.textContent = (info.dataset.base || '') + (size ? ` · ${(size / 1048576).toFixed(1)} MB` : '');
  if (pipWin) {
    const d = pipWin.document;
    const tt = d.getElementById('t');
    if (tt) tt.textContent = t;
    const pb = d.getElementById('p');
    if (pb) pb.textContent = paused ? '▶' : '⏸';
  }
}

function togglePause() {
  if (!recorder) return;
  if (recorder.state === 'recording') {
    recorder.pause(); pauseStart = Date.now();
    if (stepsOn) chrome.runtime.sendMessage({ type: 'recStepsPause', paused: true }).catch(() => {});
    $('pause').querySelector('span').textContent = 'Resume';
    $('pause').querySelector('use').setAttribute('href', '#i-play');
    $('recState').textContent = 'Paused';
    $('recState').parentElement.classList.add('paused');
    badge('❚❚', '#d97706');
  } else if (recorder.state === 'paused') {
    recorder.resume(); pausedMs += Date.now() - pauseStart; pauseStart = 0;
    if (stepsOn) chrome.runtime.sendMessage({ type: 'recStepsPause', paused: false }).catch(() => {});
    $('pause').querySelector('span').textContent = 'Pause';
    $('pause').querySelector('use').setAttribute('href', '#i-pause');
    $('recState').textContent = 'Recording';
    $('recState').parentElement.classList.remove('paused');
    badge('REC');
  }
  renderTimer();
}

function toggleMute() {
  if (!micStream) return;
  const t = micStream.getAudioTracks()[0];
  t.enabled = !t.enabled;
  $('muteMic').classList.toggle('on', !t.enabled);
  $('muteMic').querySelector('span').textContent = t.enabled ? 'Mute mic' : 'Mic muted';
}

function stop() {
  if (!recorder || stopping) return;
  stopping = true;
  if (pauseStart) { pausedMs += Date.now() - pauseStart; pauseStart = 0; }
  durationMs = elapsedMs();
  if (recorder.state !== 'inactive') recorder.stop();
}

function cleanupStreams(keepPreview) {
  if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
  displayStream = null;
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  if (!keepPreview) { stopMic(); stopCam(); }
}

async function finish() {
  clearInterval(tick);
  badge('');
  if (srcTabId != null) chrome.runtime.sendMessage({ type: 'recClicks', tabId: srcTabId, on: false }).catch(() => {});
  stopWatch();
  if (stepsOn) await chrome.runtime.sendMessage({ type: 'recStepsStop' }).catch(() => {});
  await Promise.all(pics); // step pictures still being made
  if (grabVid) { grabVid.srcObject = null; grabVid = null; }
  if (pipWin) { try { pipWin.close(); } catch (e) {} pipWin = null; }
  cleanupStreams(false);
  $('micBox').hidden = true;
  $('camBox').hidden = true;
  let blob = new Blob(chunks, { type: fmt.type.split(';')[0] });
  blob = fmt.ext === 'webm' ? await fixWebmDuration(blob, durationMs) : await fixMp4(blob);
  recorder = null;
  showResult(blob, `QA-recording-${fileStamp(Date.now())}`);
  if ($('autoSave').checked) download();
}

function showResult(blob, name) {
  lastBlob = blob;
  trimIn = 0; trimOut = null;
  $('inT').textContent = '0:00';
  $('outT').textContent = 'end';
  $('trimProg').textContent = '';
  $('doneMsg').textContent = '';
  const v = $('preview');
  if (v.src) URL.revokeObjectURL(v.src);
  v.src = URL.createObjectURL(blob);
  $('outName').value = name;
  $('outExt').textContent = '.' + fmt.ext;
  document.title = 'Recording ready — EvidenceKit';
  $('hTitle').textContent = 'Recording ready';
  $('hSub').textContent = `${fmtSec(durationMs / 1000)} · ${(blob.size / 1048576).toFixed(1)} MB`;
  $('gifProg').textContent = '';
  $('stManual').textContent = 'Add to Manual'; // a new recording: nothing added yet
  $('stEvidence').textContent = 'Add to Test Evidence';
  renderSteps();
  show('vDone');
  checkPlayable(v);
}

// Some MP4 files from Chrome's recorder cannot be decoded by Chrome itself (only the header loads).
// Download still works; Trim / GIF / Frame need decoded frames, so explain instead of failing later.
let playableCheck = 0;
async function checkPlayable(v) {
  const id = ++playableCheck;
  ['doTrim', 'gifBtn', 'frameShot'].forEach((b) => { $(b).disabled = false; });
  $('noEdit').hidden = true;
  let ok = v.readyState >= 2 || await new Promise((r) => {
    const to = setTimeout(() => r(false), 5000);
    v.addEventListener('loadeddata', () => { clearTimeout(to); r(true); }, { once: true });
  });
  // Trim / GIF jump around in the video: check once that a jump still gives a picture, then go back to the start
  if (ok && isFinite(v.duration) && v.duration > 0.6) {
    $('gifProg').textContent = 'Checking the video…';
    ok = await seekReady(v, Math.min(1, v.duration / 2));
    if (ok) await seekReady(v, 0);
    if (id === playableCheck) $('gifProg').textContent = '';
  }
  if (ok || id !== playableCheck) return;
  ['doTrim', 'gifBtn', 'frameShot'].forEach((b) => { $(b).disabled = true; });
  $('noEdit').hidden = false;
}

async function download() {
  if (!lastBlob) return;
  const name = `${String($('outName').value || 'QA-recording').replace(/[\\/:*?"<>|]+/g, '_')}.${fmt.ext}`;
  success('Video saved', await saveOut(lastBlob, name));
}

// ---------------- frame -> editor ----------------
async function openInEditor(canvas, title, mode) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const id = uid();
  let url = '';
  if (srcTabId != null && mode !== 'screen') {
    try { url = (await chrome.tabs.get(srcTabId)).url || ''; } catch (e) {}
  }
  const meta = { id, ts: Date.now(), url, title, mode: 'screen', logs: null, viewport: { w: canvas.width, h: canvas.height, dpr: 1 } };
  await dbPut('captures', { id, blob, meta, ts: meta.ts });
  await chrome.storage.local.set({ lastCapture: id });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?id=${id}&action=edit`) });
}
function frameCanvas(video) {
  const c = document.createElement('canvas');
  c.width = video.videoWidth; c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  return c;
}

// ---------------- trim (re-records the chosen part in real time) ----------------
// play(), but give up (with the reason) if the browser never starts it
function playOrFail(el, ms = 8000) {
  return Promise.race([
    el.play(),
    new Promise((_, j) => setTimeout(() => j(new Error(`Playback did not start (readyState ${el.readyState}, network ${el.networkState}, visible ${document.visibilityState})`)), ms)),
  ]);
}
// seek and wait until a decoded frame is really there; false when the file cannot do that
async function seekReady(el, t) {
  const seeked = await new Promise((r) => {
    const to = setTimeout(() => r(false), 3000);
    el.addEventListener('seeked', () => { clearTimeout(to); r(true); }, { once: true });
    el.currentTime = t;
  });
  if (!seeked || Math.abs(el.currentTime - t) > 0.5) return false;
  if (el.readyState >= 2) return true;
  return new Promise((r) => {
    const to = setTimeout(() => r(el.readyState >= 2), 1500);
    el.addEventListener('loadeddata', () => { clearTimeout(to); r(true); }, { once: true });
    el.addEventListener('canplay', () => { clearTimeout(to); r(true); }, { once: true });
  });
}
// wait for a media event, but never forever
function waitEv(el, ev, ms, what) {
  return new Promise((res, rej) => {
    const to = setTimeout(() => { el.removeEventListener(ev, ok); rej(new Error(what + ' timed out')); }, ms);
    const ok = () => { clearTimeout(to); res(); };
    el.addEventListener(ev, ok, { once: true });
  });
}
async function trim() {
  const v = $('preview');
  const end = trimOut != null ? trimOut : v.duration;
  if (!(end > trimIn + 0.3)) { $('trimProg').textContent = 'Set an end point after the start point.'; return; }
  $('doTrim').disabled = true;
  $('trimProg').textContent = 'Preparing…';
  const src = v; // the preview player itself: it is already decoding this file
  src.pause();
  let rec = null;
  try {
    if (src.readyState < 1) await waitEv(src, 'loadedmetadata', 10000, 'Loading the video');
    // jump to the start point; some files (Chrome MP4) cannot seek, then we play from 0 and start recording at the start point
    let seekOk = await seekReady(src, trimIn);
    const fromStart = async () => {
      seekOk = false;
      await seekReady(src, 0);
      $('trimProg').textContent = 'Playing up to the start point…';
    };
    if (!seekOk) await fromStart();
    const st = src.captureStream();
    const out = [];
    rec = new MediaRecorder(st, { mimeType: fmt.type, videoBitsPerSecond: 8e6 });
    rec.ondataavailable = (e) => { if (e.data.size) out.push(e.data); };
    const done = new Promise((r) => { rec.onstop = r; });
    const startPlay = async () => {
      try { await playOrFail(src); } catch (e) { if (e.name !== 'NotAllowedError') throw e; src.muted = true; await playOrFail(src); } // autoplay rules
    };
    try {
      await startPlay();
    } catch (e) {
      if (!seekOk) throw e;
      await fromStart(); // decoding stalled after the jump: start over from frame 0
      await startPlay();
    }
    if (seekOk) rec.start(500);
    await new Promise((r, j) => {
      let last = -1, still = 0;
      const t = setInterval(() => {
        still = src.currentTime === last ? still + 1 : 0;
        last = src.currentTime;
        if (still > 60) { clearInterval(t); return j(new Error('Playback stopped')); } // 6 s without progress
        if (rec.state === 'inactive' && src.currentTime >= trimIn) rec.start(500); // played up to the start point
        if (rec.state === 'inactive') return;
        $('trimProg').textContent = `Saving trimmed copy… ${Math.max(0, Math.min(100, Math.round(((src.currentTime - trimIn) / (end - trimIn)) * 100)))}%`;
        if (src.currentTime >= end || src.ended) { clearInterval(t); return r(); }
      }, 100);
    });
    src.pause();
    rec.stop();
    await done;
    durationMs = Math.round((end - trimIn) * 1000);
    const t0 = trimIn * 1000, t1 = end * 1000;
    steps = steps.filter((x) => x.at >= t0 && x.at <= t1).map((x) => ({ ...x, at: x.at - t0 }));
    let blob = new Blob(out, { type: fmt.type.split(';')[0] });
    blob = fmt.ext === 'webm' ? await fixWebmDuration(blob, durationMs) : await fixMp4(blob);
    showResult(blob, $('outName').value.replace(/-trimmed$/, '') + '-trimmed');
    $('trimProg').textContent = 'Trimmed copy ready — press Download.';
  } catch (e) {
    try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (er) {}
    src.pause();
    $('trimProg').textContent = 'Trim failed: ' + e.message;
  } finally {
    $('doTrim').disabled = false;
  }
}

// ---------------- repro steps ----------------
const tcode = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.target !== 'recorder' || !recorder) return;
  if (m.type === 'recOutside') { outside = !!m.outside; return; }
  if (m.type === 'addStepNow') { manualStep(); return; }
  if (m.type === 'recStepAdded') addStep(m.step);
});
function addStep(st) {
  st.at = Math.max(0, elapsedMs() - Math.max(0, Date.now() - st.ts));
  lastStepAt = Date.now();
  steps.push(st);
  steps.sort((x, y) => x.at - y.at || x.n - y.n);
  $('liveSteps').textContent = `Repro steps: ${steps.length}`;
  if (st.frame && $('recStepShots').checked) pics.push(framePicture(st).then((id) => { st.img = id; }).catch((e) => console.error(e)));
}

// ---------------- step pictures from the screen video ----------------
let surface = 'browser';
let screenMode = false;
let grabVid = null;
let pics = []; // pictures still being made (stop waits for them)
let outside = false; // another program is in front (from the background: Chrome lost the focus)
let lastStepAt = 0;
let localN = 1000; // numbers for steps made here (screen changed / added by hand)
let watchTimer = null;

function startGrabber(stream) {
  grabVid = document.createElement('video');
  grabVid.muted = true;
  grabVid.playsInline = true;
  grabVid.srcObject = stream;
  grabVid.play().catch(() => {});
}
function grabFrame(maxW = 1920) {
  if (!grabVid || !grabVid.videoWidth) return null;
  const k = Math.min(1, maxW / grabVid.videoWidth);
  const c = document.createElement('canvas');
  c.width = Math.round(grabVid.videoWidth * k);
  c.height = Math.round(grabVid.videoHeight * k);
  c.getContext('2d').drawImage(grabVid, 0, 0, c.width, c.height);
  return c;
}
const canvasBlob = (c) => new Promise((r) => c.toBlob(r, 'image/png'));
const mkCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

// Where the step's web page is inside this frame (in frame pixels), or null when that is not known.
// g = the page's position and size on the screen, sent by the page (content/guide.js) or the background.
// g.winOnly: only the browser window is known (a page the extension may not enter, e.g. the PDF viewer):
// the picture is cut to that window, with Chrome's own address bar in it.
function pageRect(c, g) {
  if (!g) return null;
  const win = !!g.winOnly;
  if (win ? !g.ow || !g.oh : !g.iw || !g.ih) return null;
  const px = win ? g.wx : g.ox, py = win ? g.wy : g.oy, pw = win ? g.ow : g.iw, ph = win ? g.oh : g.ih;
  let sc, x, y;
  if (surface === 'monitor' && g.sw && Math.abs(c.width / c.height - g.sw / g.sh) < 0.02) {
    sc = c.width / g.sw; x = (px - g.sl) * sc; y = (py - g.st) * sc; // whole screen: the screen this page is on
  } else if (surface === 'window' && g.ow && Math.abs(c.width / c.height - g.ow / g.oh) < 0.03) {
    if (win) return null; // the recording is that window already
    sc = c.width / g.ow; x = (px - g.wx) * sc; y = (py - g.wy) * sc; // one window: the browser window of this page
  } else return null; // another screen or another program's window
  const r = { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), winOnly: win };
  r.w = Math.min(c.width - r.x, Math.round(pw * sc + Math.min(0, x)));
  r.h = Math.min(c.height - r.y, Math.round(ph * sc + Math.min(0, y)));
  return r.w > 80 && r.h > 60 ? r : null;
}
function scaled(c, rect, maxW = 1920) {
  const r = rect || { x: 0, y: 0, w: c.width, h: c.height };
  const k = Math.min(1, maxW / r.w);
  const out = mkCanvas(Math.round(r.w * k), Math.round(r.h * k));
  out.getContext('2d').drawImage(c, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
  return out;
}

// Picture of this moment, from the screen video.
// "Only the web page" (default): a step in a Chrome tab is cut to that page, so the taskbar, other windows and
// Chrome's own address bar are left out, and it gets the URL / date / time bar like a screenshot.
// Otherwise (or for another program) the whole frame is kept, with the date / time only: the browser's own
// address bar is already in the picture.
async function framePicture(st) {
  const full = grabFrame(Infinity);
  if (!full) return null;
  const rect = $('recStepCrop').checked ? pageRect(full, st.geo) : null;
  const c = scaled(full, rect);
  let base = await canvasBlob(c);
  let headerH = 0;
  const o = { ...composeOpts(settings), console: false, network: false };
  if (!st.url || !rect || rect.winOnly) o.url = false; // the browser's own address bar is in the picture
  if (o.url || o.time) {
    const bmp = await createImageBitmap(base);
    const r = compose(bmp, { url: st.url || '', ts: st.ts, title: st.pageTitle || '' }, o, mkCanvas);
    headerH = r.headerH;
    base = await canvasBlob(r.canvas);
  }
  // the click / field outline
  let mark = null;
  const g = st.geo;
  const color = settings.guideColor || '#ef4444';
  if (rect && !rect.winOnly && g && (st.rect || st.pt)) {
    mark = markOf({ rect: st.rect, pt: st.pt, vw: g.iw }, color, headerH); // page coordinates, like a tab screenshot
  } else if (!rect && surface === 'monitor' && g && g.sw && (st.rect || st.pt) && Math.abs(full.width / full.height - g.sw / g.sh) < 0.02) {
    const mx = g.ox - g.sl, my = g.oy - g.st; // where the page is on this screen (CSS pixels)
    mark = markOf({
      rect: st.rect ? { x: st.rect.x + mx, y: st.rect.y + my, w: st.rect.w, h: st.rect.h } : null,
      pt: st.pt ? { x: st.pt.x + mx, y: st.pt.y + my } : null,
      vw: g.sw,
    }, color, headerH);
  }
  const blob = mark ? await bakeMarker(base, mark, st.n) : base;
  const id = 'rs-' + uid();
  await dbPut('captures', { id, blob, ts: Date.now(), raw: mark ? base : null, mark, num: st.n });
  return id;
}

// "📸 Add step": a step right now, from the video (works whatever program is in front)
function manualStep() {
  if (!recorder || recorder.state !== 'recording' || !stepsOn) return;
  addStep({ n: ++localN, ts: Date.now(), kind: 'manual', title: 'Step (added by hand)', url: '', pageTitle: '', img: null, frame: true });
  const b = $('addStep');
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 400);
}

// While another program is in front, a big change of the screen that then stays still becomes a step
// (an extension cannot see clicks in other programs).
function startWatch() {
  stopWatch();
  const W = 64, H = 36;
  const sm = mkCanvas(W, H);
  const sx = sm.getContext('2d', { willReadFrequently: true });
  let stable = null, prev = null, changing = false, calm = 0;
  const gray = () => {
    sx.drawImage(grabVid, 0, 0, W, H);
    const d = sx.getImageData(0, 0, W, H).data;
    const g = new Uint8Array(W * H);
    for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
    return g;
  };
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  watchTimer = setInterval(() => {
    if (!grabVid || !grabVid.videoWidth || !recorder || recorder.state !== 'recording') return;
    const g = gray();
    if (!stable) { stable = g; prev = g; return; }
    const moving = diff(g, prev) > 1.5;
    prev = g;
    if (moving) { changing = true; calm = 0; return; }
    if (!changing || ++calm < 2) return; // wait until the screen has settled
    changing = false;
    const big = diff(g, stable);
    stable = g;
    if (!outside || big < 6 || Date.now() - lastStepAt < 2500) return; // small change, or a step was just made
    addStep({ n: ++localN, ts: Date.now(), kind: 'screen', title: 'The screen changed (in another program)', url: '', pageTitle: '', img: null, frame: true });
  }, 700);
}
function stopWatch() { clearInterval(watchTimer); watchTimer = null; }

const imgUrls = [];
async function stepImage(id) {
  if (!id) return null;
  const { dbGet } = await import('../lib/db.js');
  const r = await dbGet('captures', id);
  return r ? r.blob : null;
}
async function stepRecord(id) {
  if (!id) return null;
  const { dbGet } = await import('../lib/db.js');
  return (await dbGet('captures', id)) || null;
}
async function renderSteps() {
  imgUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const sec = $('stepsSec');
  sec.hidden = !steps.length;
  $('stepsN').textContent = steps.length ? `(${steps.length})` : '';
  const ol = $('stepList');
  ol.textContent = '';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const li = document.createElement('li');
    const n = Object.assign(document.createElement('span'), { className: 'n', textContent: i + 1 + '.' });
    const t = Object.assign(document.createElement('button'), { className: 't', textContent: tcode(s.at), title: 'Jump to this moment' });
    t.addEventListener('click', () => { const v = $('preview'); v.currentTime = s.at / 1000; v.play().catch(() => {}); });
    li.append(n, t);
    const blob = await stepImage(s.img);
    if (blob) {
      const u = URL.createObjectURL(blob);
      imgUrls.push(u);
      const im = Object.assign(document.createElement('img'), { src: u, alt: '', title: 'Open in the editor' });
      im.addEventListener('click', async () => {
        const c = document.createElement('canvas');
        const bmp = await createImageBitmap(blob);
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        openInEditor(c, s.title, 'frame');
      });
      li.append(im);
    }
    const tt = Object.assign(document.createElement('span'), { className: 'tt', textContent: s.title || '(step)', title: s.title });
    const x = Object.assign(document.createElement('button'), { className: 'x', textContent: '✕', title: 'Remove this step' });
    x.addEventListener('click', () => { steps.splice(i, 1); renderSteps(); });
    li.append(tt, x);
    ol.append(li);
  }
}
const stepsText = () => steps.map((s, i) => `${i + 1}. [${tcode(s.at)}] ${s.title}`).join('\n');
function videoName() { return `${$('outName').value || 'recording'}.${fmt ? fmt.ext : 'webm'}`; }
async function exportSteps() {
  const name = String($('outName').value || 'recording').replace(/[\\/:*?"<>|]+/g, '_');
  const first = steps.find((s) => s.url);
  let md = `# Repro steps\n\n- Video: ${videoName()}\n- Recorded: ${new Date(startedAt).toLocaleString()}\n${first ? '- Page: ' + first.url + '\n' : ''}\n`;
  const zip = window.JSZip ? new window.JSZip() : null;
  let images = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    md += `${i + 1}. **[${tcode(s.at)}]** ${s.title}\n`;
    const blob = await stepImage(s.img);
    if (blob && zip) {
      const f = `images/step-${String(i + 1).padStart(2, '0')}.png`;
      zip.file(f, blob);
      md += `\n   ![Step ${i + 1}](${f})\n\n`;
      images++;
    }
  }
  let out, fname;
  if (images) { zip.file('steps.md', md); out = await zip.generateAsync({ type: 'blob' }); fname = `${name}-steps.zip`; }
  else { out = new Blob([md], { type: 'text/markdown' }); fname = `${name}-steps.md`; }
  success('Steps saved', await saveOut(out, fname));
}
// Big, clear success message (closes by itself after 3 s, or with the cross)
function success(title, detail, withManual) {
  const b = $('okbar');
  b.querySelector('.okt').textContent = title;
  b.querySelector('.okd').textContent = detail || '';
  b.querySelector('#okManual').style.display = withManual ? '' : 'none';
  b.classList.add('show');
  clearTimeout(success._t);
  success._t = setTimeout(() => b.classList.remove('show'), 3000);
}
// "Add to Manual" / "Add to Test Evidence": each button adds the steps to its own document (press both = both)
let lastAddedTo = 'manual';
async function stepsTo(doc) {
  const { appendTo, DOC_NAMES } = await import('../lib/docs.js');
  const btn = $(doc === 'evidence' ? 'stEvidence' : 'stManual');
  btn.disabled = true;
  try {
    // the recording becomes its own section (a test case in the Test Evidence); rename it there or split it
    const items = [{ type: 'section', title: `${doc === 'evidence' ? 'Test case' : 'Recording'} — ${$('outName').value || 'video'}`, ts: Date.now() }];
    for (const s of steps) {
      const rec = await stepRecord(s.img);
      items.push({
        blob: rec ? rec.blob : null, title: s.title, desc: `At ${tcode(s.at)} in ${videoName()}`,
        url: s.url, ts: s.ts, auto: true, kind: s.kind, pageTitle: s.pageTitle,
        raw: rec ? rec.raw || null : null, mark: rec ? rec.mark || null : null, num: rec ? rec.num : undefined,
      });
    }
    await appendTo(doc, items);
    lastAddedTo = doc;
    btn.textContent = `✓ Added to ${doc === 'evidence' ? 'Test Evidence' : 'Manual'}`;
    $('okManual').textContent = 'Open ' + DOC_NAMES[doc];
    success('Added to ' + DOC_NAMES[doc], `${steps.length} step${steps.length === 1 ? '' : 's'} added as a new ${doc === 'evidence' ? 'test case' : 'section'} — rename it there.`, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------- GIF export (max 30 s, 800 px, 10 fps) ----------------
let gifRestore = null;
async function makeGif() {
  $('gifBtn').disabled = true;
  const prog = $('gifProg');
  try {
    const v = $('preview'); // read frames from the preview player
    gifRestore = { v, muted: v.muted };
    v.pause();
    v.muted = true;
    if (v.readyState < 1) await waitEv(v, 'loadedmetadata', 10000, 'Loading the video');
    const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : durationMs / 1000;
    const start = Math.max(0, trimIn || 0);
    let end = trimOut != null && trimOut > start ? trimOut : dur;
    const clipped = end - start > 30;
    end = Math.min(end, start + 30);
    const k = Math.min(1, 800 / v.videoWidth);
    const w = Math.max(2, Math.round(v.videoWidth * k)), h = Math.max(2, Math.round(v.videoHeight * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const worker = new Worker('../lib/gif-worker.js');
    let done = 0;
    const result = new Promise((res, rej) => {
      worker.onmessage = (e) => {
        if (e.data.type === 'progress') done = e.data.frames;
        else if (e.data.type === 'done') res(e.data.blob);
        else if (e.data.type === 'error') rej(new Error(e.data.message));
      };
      worker.onerror = (e) => rej(new Error(e.message || 'GIF worker failed'));
    });
    worker.postMessage({ type: 'start', w, h, delay: 10 });
    const total = Math.max(1, Math.round((end - start) * 10));
    const seekTo = (t) => seekReady(v, t);
    const grab = async (i) => {
      ctx.drawImage(v, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data.buffer;
      worker.postMessage({ type: 'frame', data }, [data]);
      while (i + 1 - done > 6) await sleep(15); // let the encoder keep up
      prog.textContent = `Making GIF… ${Math.round(((i + 1) / total) * 100)}%`;
    };
    // seek frame by frame when the file allows it, otherwise play it and take a frame every 0.1 s
    let from = 0; // first frame still to grab
    if (await seekTo(Math.min(end - 0.01, start + 0.05))) {
      for (; from < total; from++) {
        if (!(await seekTo(Math.min(end - 0.01, start + from / 10)))) break; // decoding stalled: finish by playing
        await grab(from);
      }
    }
    if (from < total) {
      prog.textContent = 'Making GIF (playing the video)…';
      await seekReady(v, 0);
      await playOrFail(v);
      let i = from;
      await new Promise((res) => {
        const tick = async () => {
          if (v.ended || v.currentTime >= end || i >= total) { v.pause(); return res(); }
          if (v.currentTime >= start + i / 10) { await grab(i); i++; }
          v.requestVideoFrameCallback ? v.requestVideoFrameCallback(tick) : setTimeout(tick, 30);
        };
        tick();
      });
    }
    worker.postMessage({ type: 'finish' });
    const gif = await result;
    worker.terminate();
    const name = `${String($('outName').value || 'recording').replace(/[\\/:*?"<>|]+/g, '_')}.gif`;
    const where = await saveOut(gif, name);
    prog.textContent = `✓ GIF saved to ${where} (${(gif.size / 1048576).toFixed(1)} MB, ${total} frames${clipped ? ', first 30 s' : ''})`;
    window.__lastGif = gif; // used by the smoke test
  } catch (e) {
    prog.textContent = 'GIF failed: ' + e.message;
  } finally {
    if (gifRestore) { gifRestore.v.pause(); gifRestore.v.onseeked = null; gifRestore.v.muted = gifRestore.muted; gifRestore = null; }
    $('gifBtn').disabled = false;
  }
}

// ---------------- floating controls (Document Picture-in-Picture) ----------------
async function popOut() {
  if (pipWin) { pipWin.focus(); return; }
  if (window.documentPictureInPicture) {
    const cam = !!camStream;
    pipWin = await window.documentPictureInPicture.requestWindow({ width: cam ? 260 : (stepsOn ? 340 : 300), height: cam ? 290 : 64 });
    const d = pipWin.document;
    d.body.innerHTML = `
<style>
  body{margin:0;background:${cam ? 'transparent' : '#111827'};font:600 14px system-ui,Arial;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;overflow:hidden}
  video{width:200px;height:200px;border-radius:50%;object-fit:cover;transform:scaleX(-1);border:4px solid #fff;box-shadow:0 6px 24px rgba(0,0,0,.4);background:#000}
  .bar{display:flex;align-items:center;gap:8px;background:#111827;border-radius:999px;padding:6px 8px 6px 14px}
  .dot{width:9px;height:9px;border-radius:50%;background:#ef4444;animation:b 1.2s infinite}@keyframes b{50%{opacity:.3}}
  #t{font:700 15px ui-monospace,Consolas,monospace;min-width:52px}
  button{all:unset;cursor:pointer;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#374151;font-size:13px}
  button:hover{background:#4b5563} #s{background:#dc2626}
</style>
${cam ? '<video id="v" autoplay muted playsinline></video>' : ''}
<div class="bar"><span class="dot"></span><span id="t">00:00</span>${stepsOn ? '<button id="a" title="Add a step now (picture of the screen)">📸</button>' : ''}<button id="p" title="Pause / resume">⏸</button><button id="s" title="Stop">■</button></div>`;
    if (cam) d.getElementById('v').srcObject = camStream;
    d.getElementById('p').addEventListener('click', togglePause);
    if (d.getElementById('a')) d.getElementById('a').addEventListener('click', manualStep);
    d.getElementById('s').addEventListener('click', stop);
    pipWin.addEventListener('pagehide', () => { pipWin = null; });
    renderTimer();
    return;
  }
  if (camStream) {
    const v = $('camPrev');
    try { await v.requestPictureInPicture(); } catch (e) { alert('Floating window is not available: ' + e.message); }
  } else alert('Floating controls need Chrome 116 or newer.');
}

// ---------------- screenshot of a screen / app window ----------------
async function shot() {
  $('shotGo').disabled = true;
  $('shotMsg').textContent = '';
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: shotSrc }, audio: false, selfBrowserSurface: 'exclude' });
    const track = stream.getVideoTracks()[0];
    const label = track.label || 'Screen';
    const delay = +$('shotDelay').value || 0;
    const me = await chrome.windows.getCurrent();
    // get this little window out of the picture
    await chrome.windows.update(me.id, { state: 'minimized' }).catch(() => {});
    if (delay) { for (let i = delay; i > 0; i--) { badge(String(i), '#f59e0b'); await sleep(1000); } badge(''); }
    await sleep(500);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await v.play();
    await sleep(250);
    const c = frameCanvas(v);
    stream.getTracks().forEach((t) => t.stop());
    await openInEditor(c, label, 'screen');
    window.close();
  } catch (e) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    $('shotGo').disabled = false;
    if (!(e && e.name === 'NotAllowedError')) $('shotMsg').textContent = 'Could not capture: ' + (e.message || e);
    try { const me = await chrome.windows.getCurrent(); chrome.windows.update(me.id, { state: 'normal', focused: true }); } catch (er) {}
  }
}
let shotSrc = 'monitor';

// ---------------- init ----------------
async function init() {
  const r = await chrome.storage.local.get('settings');
  settings = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
  document.body.classList.toggle('dark', settings.theme === 'dark');
  saveFolder = String(settings.saveFolder || '').replace(/[\\:*?"<>|]/g, '').replace(/^\/+|\/+$/g, '');

  if (shotMode) {
    $('hTitle').textContent = 'Screenshot of screen / app';
    $('hSub').textContent = 'Capture your desktop or any program window';
    document.title = 'Screen screenshot — EvidenceKit';
    cards('shotCards', shotSrc, (v) => { shotSrc = v; });
    $('shotGo').addEventListener('click', shot);
    show('vShot');
    return;
  }

  // formats actually supported by this Chrome
  const fsel = $('fmt');
  [['mp4', 'MP4 — plays everywhere'], ['webm', 'WebM — smaller']].forEach(([k, label]) => {
    if (!supported(k)) return;
    const o = document.createElement('option');
    o.value = k; o.textContent = label;
    fsel.append(o);
  });
  fsel.value = supported(settings.recFormat) ? settings.recFormat : fsel.options[0] ? fsel.options[0].value : '';

  $('quality').value = String(settings.recQuality || '1080');
  $('fps').value = String(settings.recFps || 30);
  $('countdown').value = String(settings.recCountdown === false ? 0 : settings.recCountdownSec || 3);
  $('sysAudio').checked = !!settings.recSys;
  $('clicks').checked = settings.recClicks !== false;
  $('autoSave').checked = settings.recAutoSave !== false;
  $('clicks').disabled = srcTabId == null;
  const srcNote = () => {
    const n = $('srcNote');
    n.hidden = source === 'browser';
    n.innerHTML = source === 'monitor'
      ? '<b>Everything on this screen is recorded</b> — other windows, notifications, the taskbar and the floating controls too. '
        + 'Only need the browser? Choose <b>Browser tab</b>, or <b>App window</b> and pick the Chrome window. '
        + 'Chrome also shows a small “sharing this screen” bar: press <b>Hide</b> on it.'
      : 'Only the window you pick is recorded. Pick the <b>Chrome window</b> to get steps from all its tabs.';
  };
  cards('srcCards', source, (v) => { source = v; srcNote(); });
  srcNote();
  $('recSteps').checked = settings.recSteps !== false;
  $('recStepShots').checked = settings.recStepShots !== false;
  $('recStepValues').checked = !!settings.recStepValues;
  $('recStepCrop').checked = settings.recStepCrop !== false;
  const stepsAvail = srcTabId != null;
  $('recSteps').disabled = !stepsAvail;
  $('stepsOpt').classList.toggle('off', !stepsAvail);
  const syncStepsBox = () => { $('stepsBox').hidden = !$('recSteps').checked || !stepsAvail; };
  syncStepsBox();
  $('recSteps').addEventListener('change', syncStepsBox);
  $('stCopy').addEventListener('click', async () => { await navigator.clipboard.writeText(stepsText()); success('Copied to clipboard', 'Paste the steps anywhere with Ctrl+V.'); });
  $('stDl').addEventListener('click', () => exportSteps().catch((e) => alert('Export failed: ' + e.message)));
  $('okClose').addEventListener('click', () => $('okbar').classList.remove('show'));
  $('okManual').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openManual', doc: lastAddedTo }));
  $('stManual').addEventListener('click', () => stepsTo('manual').catch((e) => alert('Could not add: ' + e.message)));
  $('stEvidence').addEventListener('click', () => stepsTo('evidence').catch((e) => alert('Could not add: ' + e.message)));
  $('gifBtn').addEventListener('click', makeGif);

  const persist = () => saveSettings({
    recQuality: $('quality').value, recFps: +$('fps').value, recFormat: $('fmt').value,
    recCountdownSec: +$('countdown').value, recCountdown: +$('countdown').value > 0,
    recSys: $('sysAudio').checked, recMic: $('mic').checked, recCamera: $('cam').checked,
    recClicks: $('clicks').checked, recAutoSave: $('autoSave').checked,
    recSteps: $('recSteps').checked, recStepShots: $('recStepShots').checked, recStepValues: $('recStepValues').checked, recStepCrop: $('recStepCrop').checked,
  });
  ['quality', 'fps', 'fmt', 'countdown', 'sysAudio', 'clicks', 'autoSave', 'recSteps', 'recStepShots', 'recStepValues', 'recStepCrop'].forEach((id) => $(id).addEventListener('change', persist));
  $('mic').addEventListener('change', () => { persist(); if ($('mic').checked) startMic(); else { stopMic(); $('micBox').hidden = true; } });
  $('cam').addEventListener('change', () => { persist(); if ($('cam').checked) startCam(); else { stopCam(); $('camBox').hidden = true; } });
  $('micDev').addEventListener('change', startMic);
  $('camDev').addEventListener('change', startCam);
  if (settings.recMic) { $('mic').checked = true; startMic(); }
  if (settings.recCamera) { $('cam').checked = true; startCam(); }

  $('start').addEventListener('click', start);
  $('pause').addEventListener('click', togglePause);
  $('stop').addEventListener('click', stop);
  $('addStep').addEventListener('click', manualStep);
  $('muteMic').addEventListener('click', toggleMute);
  $('popout').addEventListener('click', () => popOut().catch((e) => alert('Floating window failed: ' + e.message)));
  $('dl').addEventListener('click', download);
  $('frameShot').addEventListener('click', async () => {
    const v = $('preview');
    if (!v.videoWidth) return;
    v.pause();
    await openInEditor(frameCanvas(v), `Frame at ${fmtSec(v.currentTime)} of ${$('outName').value}`, 'frame');
  });
  $('setIn').addEventListener('click', () => { trimIn = $('preview').currentTime; $('inT').textContent = fmtSec(trimIn); });
  $('setOut').addEventListener('click', () => { trimOut = $('preview').currentTime; $('outT').textContent = fmtSec(trimOut); });
  $('doTrim').addEventListener('click', () => trim());
  $('again').addEventListener('click', () => {
    $('hTitle').textContent = 'Screen recorder';
    $('hSub').textContent = 'Record a tab, window or your whole screen';
    document.title = 'Screen Recorder — EvidenceKit';
    $('start').disabled = false;
    if ($('mic').checked) startMic();
    if ($('cam').checked) startCam();
    show('vSetup');
  });

  window.addEventListener('beforeunload', (e) => {
    if (recorder && recorder.state !== 'inactive') { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('keydown', (e) => {
    if ($('vRec').hidden) return;
    if (e.key === ' ') { e.preventDefault(); togglePause(); }
    if (e.key === 'Escape') stop();
  });
  show('vSetup');
}

init();
