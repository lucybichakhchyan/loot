// LOOT recorder: records the screen and the camera as two separate files per clip,
// so the layout can still be changed in the editor.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const B = document.body, frame = $('#frame'), shot = $('#shot');
const screenV = $('#screenV'), camV = $('#camV');
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const icon = n => `<svg class="ic"><use href="/static/assets/icons.svg#${n}"/></svg>`;
const params = new URLSearchParams(location.search);
const busy = () => B.classList.contains('recording') || B.classList.contains('counting');
function toast(text, undo) {
  const t = $('#toast'); $('#toastText').textContent = text; $('#toastUndo').hidden = !undo;
  $('#toastUndo').onclick = () => { undo(); t.hidden = true; };
  t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, undo ? 7000 : 3500);
}

const shapes = { wide: '16:9, for YouTube, messages and demos', tall: '9:16, for shorts, up to 60 seconds' };
let shape = 'wide';
const on = { screen: true, camera: true, mic: true };
const chosen = { camera: null, mic: null };
let screenStream = null, camStream = null, micStream = null;
let project = params.get('project'), existingClips = 0;
let clips = [], retaking = null, playing = null;

let mirrorOn = true; try { mirrorOn = localStorage.getItem('loot-mirror') !== '0'; } catch (e) { /* private window */ }
B.classList.toggle('mirror', mirrorOn);

// ---------- layout of the live preview ----------
function layout() {
  frame.classList.toggle('vertical', shape === 'tall');
  frame.classList.toggle('nocam', !on.camera);
  frame.dataset.layout = !on.screen ? 'cam' : (on.camera ? 'bubble' : 'screen');
  shot.classList.toggle('live', !!screenStream);
  $('#hint').textContent = on.screen
    ? 'With Screen on, your browser asks which tab or window to share when you press Record. LOOT then shows a small controller on top of it, so you can pause or stop without coming back here.'
    : 'Screen is off, so only your camera is recorded. Good for a quick video message.';
  $('#rec').disabled = !(on.screen || on.camera);
  idleLabel();
}
$('#shape').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || busy()) return;
  $$('#shape button').forEach(x => x.setAttribute('aria-pressed', x === b));
  shape = b.dataset.k; $('#what').textContent = shapes[shape]; layout();
});

// ---------- sources ----------
function label(src, text) { $(`.src[data-src="${src}"] small`).textContent = text; }
function setSource(src, isOn) {
  on[src] = isOn; const b = $(`.src[data-src="${src}"]`); b.dataset.on = isOn;
  if (src === 'screen') { b.setAttribute('aria-pressed', isOn); label('screen', isOn ? 'On' : 'Off'); } else if (!isOn) label(src, 'Off');
}
function closeMenus() { $$('.srcwrap .menu').forEach(m => m.hidden = true); $$('.src[aria-haspopup]').forEach(b => b.setAttribute('aria-expanded', 'false')); }
document.addEventListener('click', closeMenus);
function stopStream(s) { if (s) s.getTracks().forEach(t => t.stop()); }
function dropScreen() { stopStream(screenStream); screenStream = null; screenV.srcObject = null; }

// Screen is a plain on/off switch. The browser asks what to share when Record is pressed.
$('.src.toggle').onclick = () => { if (busy()) return; const isOn = !on.screen; if (!isOn) dropScreen(); setSource('screen', isOn); layout(); };

async function startCamera() {
  stopStream(camStream); camStream = null; if (!playing) camV.srcObject = null;
  if (!on.camera) return layout();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: chosen.camera ? { exact: chosen.camera } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    if (!playing) camV.srcObject = camStream;
    label('camera', camStream.getVideoTracks()[0].label.replace(/\s*\(.*\)$/, '') || 'Camera');
  } catch (e) { setSource('camera', false); label('camera', 'Not available'); }
  layout();
}

let audioCtx, analyser, levelTimer;
// The meter can only listen after a click, so wake it on the first interaction.
document.addEventListener('pointerdown', () => { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); }, true);
async function startMic() {
  stopStream(micStream); micStream = null; clearInterval(levelTimer); $('#noSound').hidden = true;
  $('.src[data-src="mic"]').classList.remove('bad', 'quiet');
  if (!on.mic) { $('#lvl').style.width = '0'; return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: chosen.mic ? { exact: chosen.mic } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
    const name = micStream.getAudioTracks()[0].label.replace(/\s*\(.*\)$/, '') || 'Microphone';
    label('mic', name);
    audioCtx = audioCtx || new AudioContext();
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(micStream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let lastSound = performance.now(), lastLoud = performance.now(), heardAt = 0;
    levelTimer = setInterval(() => {
      if (audioCtx.state !== 'running') { lastSound = lastLoud = performance.now(); return; }
      analyser.getFloatTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
      const db = peak > 0 ? 20 * Math.log10(peak) : -100, now = performance.now();
      // The bar covers -60 dB (empty) to 0 dB (full), so a quiet microphone still shows movement.
      $('#lvl').style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%';
      if (db > -75) lastSound = now;          // anything at all is coming in
      if (db > -42) heardAt = now;            // a voice, even a quiet one
      if (db > -18) lastLoud = now;           // a voice at a healthy level
      const silent = now - lastSound > 4000;
      const quiet = !silent && now - heardAt < 3000 && now - lastLoud > 12000;
      $('#noSound').hidden = !(silent || quiet) || busy(); $('.src[data-src="mic"]').classList.toggle('bad', silent);
      $('.src[data-src="mic"]').classList.toggle('quiet', quiet);
      if (silent) { $('#noSoundTitle').textContent = `No sound is coming from ${name}.`; $('#noSoundHelp').textContent = 'Check that it is plugged in and not muted, or pick another microphone.'; }
      else if (quiet) { $('#noSoundTitle').textContent = 'Your microphone is very quiet.'; $('#noSoundHelp').textContent = 'LOOT will raise the volume afterwards, but it sounds better if you move closer or pick another microphone.'; }
    }, 120);
  } catch (e) { setSource('mic', false); label('mic', 'Not available'); }
}

async function startScreen() {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false,
    });
    dropScreen(); screenStream = s; if (!playing) screenV.srcObject = s;
    s.getVideoTracks()[0].addEventListener('ended', () => {
      if (B.classList.contains('recording')) stop(true);
      if (screenStream === s) { screenStream = null; if (!playing) screenV.srcObject = null; }
      layout();
    });
  } catch (e) { /* the picker was closed without choosing */ }
  layout();
  return !!screenStream;
}

async function fillDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [src, type, offText] of [['camera', 'videoinput', 'Turn the camera off'], ['mic', 'audioinput', 'Mute the microphone']]) {
    const menu = $(`.src[data-src="${src}"] + .menu`);
    const current = (src === 'camera' ? camStream?.getVideoTracks()[0] : micStream?.getAudioTracks()[0])?.getSettings().deviceId;
    const list = devices.filter(d => d.kind === type && d.label && d.deviceId !== 'communications');
    menu.innerHTML = `<div class="mh">${src === 'camera' ? 'Camera' : 'Microphone'}</div>` +
      list.map(d => `<button role="menuitemradio" aria-checked="${on[src] && d.deviceId === current}" data-v="${d.deviceId}">${icon('check')}${d.label.replace(/\s*\(.*\)$/, '')}</button>`).join('') +
      (src === 'camera' ? `<hr><button role="menuitemcheckbox" aria-checked="${mirrorOn}" data-mirror>${icon('check')}Mirror my camera</button>` : '') +
      `<hr><button role="menuitemradio" aria-checked="${!on[src]}" data-v="off">${icon('check')}${offText}</button>`;
  }
}
async function openMenu(btn) {
  const menu = btn.nextElementSibling; closeMenus(); await fillDevices();
  menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
  ($('[aria-checked="true"]', menu) || $('button', menu)).focus();
}
$$('.src[aria-haspopup]').forEach(btn => {
  const menu = btn.nextElementSibling, src = btn.dataset.src; btn.title = $('b', btn).textContent;
  btn.addEventListener('click', e => { e.stopPropagation(); if (busy()) return; if (menu.hidden) openMenu(btn); else closeMenus(); });
  menu.addEventListener('click', async e => {
    const o = e.target.closest('button'); if (!o) return;
    if (o.hasAttribute('data-mirror')) {
      // The same setting as the editor's Mirror my camera switch. The preview flips at once and the menu stays open.
      e.stopPropagation(); mirrorOn = !mirrorOn; o.setAttribute('aria-checked', mirrorOn); B.classList.toggle('mirror', mirrorOn);
      try { localStorage.setItem('loot-mirror', mirrorOn ? '1' : '0'); } catch (err) { /* private window */ }
      return;
    }
    closeMenus(); btn.focus();
    const off = o.dataset.v === 'off';
    setSource(src, !off); if (!off) chosen[src] = o.dataset.v;
    await (src === 'camera' ? startCamera() : startMic());
  });
  menu.addEventListener('keydown', e => {
    const items = $$('button', menu), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Escape') { e.stopPropagation(); closeMenus(); btn.focus(); }
  });
});
$('#pickMic').onclick = e => { e.stopPropagation(); openMenu($('.src[data-src="mic"]')); };

// ---------- permission ----------
function noPerm(id) {
  B.classList.add('noperm'); frame.style.display = 'none'; $('.shape').style.display = 'none'; $('#hint').style.display = 'none';
  $('#askPerm').hidden = id !== '#askPerm'; $('#blocked').hidden = id !== '#blocked';
  $$('.src small').forEach(x => x.textContent = id === '#blocked' ? 'Blocked' : 'Not allowed yet');
  $('#recTitle').textContent = 'Recording is off'; $('#recSub').textContent = 'Allow access first';
}
async function begin() {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    stopStream(probe);
  } catch (e) {
    if (e.name === 'NotAllowedError') return noPerm('#blocked');
    // No camera or no microphone on this computer: carry on with what exists.
  }
  B.classList.remove('noperm'); frame.style.display = ''; $('.shape').style.display = ''; $('#hint').style.display = '';
  $('#askPerm').hidden = true; $('#blocked').hidden = true;
  setSource('screen', on.screen);
  await startCamera(); await startMic(); layout();
}
async function init() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    noPerm('#blocked'); $('#blocked h2').textContent = 'This browser can\'t record';
    $('#blocked ol').outerHTML = '<p>Open LOOT in a current version of Chrome, Edge or Firefox on a computer.</p>'; return;
  }
  if (project) {
    try {
      const p = await (await fetch(`/api/projects/${project}`)).json();
      if (p.id) {
        $('.doc-title').textContent = p.title; existingClips = p.clips || 0; shape = p.kind === 'short' ? 'tall' : 'wide';
        $$('#shape button').forEach(x => x.setAttribute('aria-pressed', x.dataset.k === shape)); $('#what').textContent = shapes[shape];
        if (existingClips) $('#shape').dataset.locked = true;   // a video keeps one shape
      } else project = null;
    } catch (e) { project = null; }
  }
  let state = 'prompt';
  try { state = (await navigator.permissions.query({ name: 'camera' })).state; } catch (e) { /* not supported: ask */ }
  if (state === 'granted') return begin();
  if (state === 'denied') return noPerm('#blocked');
  noPerm('#askPerm'); $('#allow').onclick = begin;
}

// ---------- script panel ----------
const scriptText = $('#scriptText');
function setScript(open) { B.classList.toggle('script-open', open); $('#scriptBtn').setAttribute('aria-pressed', open); }
$('#scriptBtn').onclick = () => setScript(!B.classList.contains('script-open'));
$('#scriptClose').onclick = () => setScript(false);
$$('.switch').forEach(s => s.addEventListener('click', () => s.setAttribute('aria-checked', s.getAttribute('aria-checked') !== 'true')));
try { const saved = localStorage.getItem('loot-script'); if (saved) scriptText.innerText = saved; } catch (e) { /* private window */ }
scriptText.addEventListener('input', () => { try { localStorage.setItem('loot-script', scriptText.innerText); } catch (e) { /* ignore */ } });
let scrollTimer;
function autoScroll(run) {
  clearInterval(scrollTimer); if (!run) return;
  // The script becomes plain paragraphs for the take, so the one being read can be marked.
  const lines = scriptText.innerText.split(/\n+/).map(l => l.trim()).filter(Boolean);
  scriptText.innerHTML = ''; lines.forEach(l => { const p = document.createElement('p'); p.textContent = l; scriptText.appendChild(p); });
  scriptText.style.scrollBehavior = 'auto'; scriptText.scrollTop = 0; let pos = 0; scriptLine();
  scrollTimer = setInterval(() => {
    if (B.classList.contains('paused')) return;
    if ($('#scrollSwitch').getAttribute('aria-checked') === 'true') { pos += (+$('#scrollSpeed').value / 100) * 3 + 0.3; scriptText.scrollTop = pos; }
    else pos = scriptText.scrollTop;
    scriptLine();
  }, 50);
}

// ---------- clips: each one can be watched, retaken or deleted, and those can be undone ----------
const shown = () => clips.filter(k => !k.gone);
function renderClips(fresh) {
  const list = shown();
  B.classList.toggle('has-clips', list.length > 0);
  const c = $('#clips'); c.innerHTML = '';
  list.forEach((k, i) => {
    const n = i + 1, d = document.createElement('div');
    d.className = 'clip' + (k === fresh ? ' fresh' : '') + (k === playing ? ' playing' : '');
    d.innerHTML = `<button class="thumbbtn" data-play="${n}" aria-label="Watch clip ${existingClips + n}"><div class="frame"><img src="${k.thumb}" alt=""></div><span class="pl"><span>${icon('play')}</span></span>${k.state === 'failed' ? '<span class="fail">Not uploaded</span>' : ''}</button>
      <div class="meta"><span>Clip ${existingClips + n} · ${k.state === 'uploading' ? 'Uploading…' : fmt(k.len)}</span><span style="display:flex"><button class="iconbtn" data-retake="${n}" title="Record this clip again" aria-label="Retake clip ${existingClips + n}">${icon('rotate-ccw')}</button><button class="iconbtn" data-del="${n}" title="Delete this clip" aria-label="Delete clip ${existingClips + n}">${icon('trash-2')}</button></span></div>`;
    c.appendChild(d);
  });
  const total = list.reduce((a, k) => a + k.len, 0);
  $('#sum').textContent = list.length ? `${list.length} ${list.length === 1 ? 'clip' : 'clips'}, ${fmt(total)}` + (existingClips ? `, added to ${existingClips} earlier` : '') : '';
  const failed = list.findIndex(k => k.state === 'failed');
  $('#upFail').hidden = failed < 0;
  if (failed >= 0) $('#upFailText').textContent = `Clip ${existingClips + failed + 1} didn't upload.`;
  $('#editBtn').disabled = !(list.length || existingClips) || list.some(k => k.state !== 'ok') || busy();
  $('#shareNow').disabled = $('#editBtn').disabled || sharing;
  idleLabel();
}
function clipNumber() { return existingClips + (retaking ? shown().indexOf(retaking) + 1 : shown().length + 1); }
function idleLabel() {
  const ready = !$('#rec').disabled;
  $('#recTitle').textContent = !ready ? 'Turn on the screen or camera' : retaking ? `Retake clip ${clipNumber()}` : shown().length ? 'Record another clip' : 'Start recording';
  $('#recSub').textContent = !ready ? 'Nothing to record yet' : retaking ? 'Keeps the old take until you stop' : '3 second countdown';
  if (!B.classList.contains('recording')) $('#rec').setAttribute('aria-label', $('#recTitle').textContent);
  if (!playing) $('#badgeText').textContent = B.classList.contains('paused') ? 'Paused' : (retaking ? `Retaking clip ${clipNumber()}` : `Recording clip ${clipNumber()}`);
}

// Watching a clip plays its own recording in the preview. "Back to the camera" returns to the live view.
let reviewUrls = [];
function review(k) {
  live(true); playing = k; B.classList.add('reviewing');
  frame.dataset.layout = k.blobs.screen && k.blobs.cam ? 'bubble' : k.blobs.cam ? 'cam' : 'screen';
  frame.classList.toggle('vertical', shape === 'tall'); frame.classList.toggle('nocam', !k.blobs.cam); shot.classList.toggle('live', !!k.blobs.screen);
  for (const [v, blob, sound] of [[screenV, k.blobs.screen, !k.blobs.cam], [camV, k.blobs.cam, true]]) {
    v.srcObject = null; if (!blob) continue;
    const url = URL.createObjectURL(blob); reviewUrls.push(url);
    v.src = url; v.muted = !sound; v.currentTime = 0; v.play().catch(() => {});
  }
  $('#badgeText').textContent = `Watching clip ${existingClips + shown().indexOf(k) + 1}`;
  renderClips();
}
function live(quiet) {
  playing = null; B.classList.remove('reviewing');
  reviewUrls.forEach(u => URL.revokeObjectURL(u)); reviewUrls = [];
  for (const [v, stream] of [[screenV, screenStream], [camV, camStream]]) { v.pause(); v.removeAttribute('src'); v.load(); v.muted = true; v.srcObject = stream; if (stream) v.play().catch(() => {}); }
  if (!quiet) { layout(); renderClips(); }
}
$('#backLive').onclick = () => live();

// Deleting a clip, or replacing it with a retake, only reaches the server once the Undo window has passed.
const later = new Map();   // clip -> timer
function removeOnServer(k) {
  clearTimeout(later.get(k)); later.delete(k);
  clips = clips.filter(x => x !== k);
  if (k.id) return fetch(`/api/projects/${project}/clips/${k.id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}
function removeSoon(k) { k.gone = true; later.set(k, setTimeout(() => removeOnServer(k), 7000)); }
function bringBack(k) { clearTimeout(later.get(k)); later.delete(k); k.gone = false; }
const flushRemovals = () => Promise.all([...later.keys()].map(removeOnServer));
window.addEventListener('pagehide', flushRemovals);

$('#clips').addEventListener('click', e => {
  if (busy()) return;
  const p = e.target.closest('[data-play]'), r = e.target.closest('[data-retake]'), d = e.target.closest('[data-del]');
  const k = shown()[+(p || r || d)?.dataset[p ? 'play' : r ? 'retake' : 'del'] - 1]; if (!k) return;
  if (p) return review(k);
  if (r) { if (playing) live(); retaking = k; renderClips(); start(); }
  if (d) {
    if (playing) live();
    const n = existingClips + shown().indexOf(k) + 1; removeSoon(k); renderClips();
    toast(`Clip ${n} deleted.`, () => { bringBack(k); renderClips(); });
  }
});

async function ensureProject() {
  if (project) return project;
  const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: $('.doc-title').textContent.trim() || 'Untitled video', kind: shape === 'tall' ? 'short' : 'long' }) });
  if (!r.ok) throw new Error('create failed');
  project = (await r.json()).id;
  history.replaceState(null, '', `/record?project=${project}`);
  return project;
}
async function upload(clip) {
  clip.state = 'uploading'; renderClips();
  try {
    await ensureProject();
    const fd = new FormData();
    if (clip.blobs.screen) fd.append('screen', clip.blobs.screen, 'screen.' + clip.ext);
    if (clip.blobs.cam) fd.append('cam', clip.blobs.cam, 'cam.' + clip.ext);
    const after = clip.after && clip.after.id ? `?after=${clip.after.id}` : '';
    const r = await fetch(`/api/projects/${project}/clips${after}`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error('upload failed');
    clip.id = (await r.json()).id; clip.state = 'ok';
  } catch (e) { clip.state = 'failed'; }
  renderClips();
}
$('#retryUp').onclick = () => clips.filter(k => k.state === 'failed' && !k.gone).forEach(upload);
function saveTitle() {
  if (project) return fetch(`/api/projects/${project}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: $('.doc-title').textContent.trim(), kind: shape === 'tall' ? 'short' : 'long' }) });
}
$('.doc-title').addEventListener('blur', saveTitle);
$('.doc-title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
let leaving = false, sharing = false;
$('#editBtn').onclick = async () => {
  $('#editBtn').disabled = true; $('#editBtn').textContent = 'Opening the editor…';
  await flushRemovals(); await saveTitle();
  await fetch(`/api/projects/${project}/process`, { method: 'POST' });
  leaving = true; location.href = `/edit/${project}`;
};

// ---------- recording ----------
const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
let recorders = [], cd, tick, secs = 0, startedAt = 0, pausedFor = 0, pausedAt = 0;
const show = () => { $('#timer').textContent = fmt(secs); if (pip) pip.document.getElementById('t').textContent = fmt(secs); };

function snapshot() {
  const c = document.createElement('canvas'); c.width = 296; c.height = 166;
  const g = c.getContext('2d'); g.fillStyle = '#141118'; g.fillRect(0, 0, c.width, c.height);
  const v = (screenStream && on.screen) ? screenV : camV;
  if (v.videoWidth) {
    const s = Math.min(c.width / v.videoWidth, c.height / v.videoHeight), w = v.videoWidth * s, h = v.videoHeight * s;
    // A camera-only clip's picture is turned like a mirror too, to match the preview.
    if (v === camV && mirrorOn) { g.translate(c.width, 0); g.scale(-1, 1); }
    g.drawImage(v, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }
  return c.toDataURL('image/jpeg', 0.7);
}

// A small always-on-top controller, so a take can be paused or stopped from the tab being recorded.
// Its Script button shows the paragraph being read, so the script can be followed without coming back here.
let pip = null;
const pipIcon = n => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><use href="${location.origin}/static/assets/icons.svg#${n}"/></svg>`;
async function openController() {
  if (!on.screen || !window.documentPictureInPicture || pip) return;
  try {
    pip = await documentPictureInPicture.requestWindow({ width: 380, height: 64 });
    pip.document.body.innerHTML = `<style>
      body{margin:0;background:#1E1A27;color:#F6F6F4;font:13px/1.3 Inter,system-ui,-apple-system,sans-serif;display:flex;flex-direction:column;height:100vh}
      .tele{flex:1;min-height:0;overflow:auto;padding:12px 16px;font-size:18px;line-height:27px;border-bottom:1px solid rgba(246,246,244,.14)}
      .tele[hidden]{display:none}.tele small{display:block;font-size:12px;color:#BEADD6;margin-bottom:4px}
      .ctl{display:flex;align-items:center;gap:4px;padding:6px 8px;flex:none}
      .t{display:flex;align-items:center;gap:8px;padding:0 10px;font-variant-numeric:tabular-nums;font-weight:500;font-size:15px}
      .dot{width:8px;height:8px;border-radius:50%;background:#E66A63;animation:blink 1.2s infinite}@keyframes blink{50%{opacity:.25}}
      .paused .dot{animation:none;opacity:.4}
      button{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:#F6F6F4;height:40px;padding:0 12px;border-radius:10px;cursor:pointer;font:inherit}
      button:hover{background:#2D253A}button[aria-pressed="true"]{background:#2D253A}
      .stop{background:#E66A63;color:#1A1620;font-weight:600;margin-left:auto}.stop:hover{background:#EF7B74}
      .sep{width:1px;height:22px;background:rgba(246,246,244,.18);margin:0 4px}</style>
      <div class="tele" id="tele" hidden><small>Script</small><span id="line"></span></div>
      <div class="ctl" id="ctl" role="toolbar" aria-label="LOOT recording controls">
        <span class="t"><span class="dot"></span><span id="t">0:00</span></span>
        <button id="p" aria-label="Pause">${pipIcon('pause')}<span id="pl">Pause</span></button>
        <button id="sc" aria-pressed="false">${pipIcon('scroll-text')}Script</button>
        <span class="sep"></span>
        <button class="stop" id="s">${pipIcon('square')}Stop</button>
      </div>`;
    const doc = pip.document;
    doc.getElementById('p').onclick = () => $('#pause').click();
    doc.getElementById('s').onclick = () => stop(B.classList.contains('recording'));
    doc.getElementById('sc').onclick = e => {
      const show = doc.getElementById('tele').hidden; doc.getElementById('tele').hidden = !show; e.currentTarget.setAttribute('aria-pressed', show);
      try { pip.resizeTo(show ? 520 : 380, show ? 230 : 64 + (pip.outerHeight - pip.innerHeight)); } catch (err) { /* the window keeps its size */ }
      scriptLine();
    };
    doc.addEventListener('keydown', e => { if (e.key.toLowerCase() === 'p') $('#pause').click(); });
    pip.addEventListener('pagehide', () => { pip = null; });
  } catch (e) { pip = null; }
}
// The paragraph being read: shown brighter in the script panel, and in the controller when its Script is open.
function scriptLine() {
  const ps = $$('p', scriptText); if (!ps.length) return;
  const top = scriptText.scrollTop + 24;
  let now = ps.find(p => p.offsetTop + p.offsetHeight > top) || ps[ps.length - 1];
  ps.forEach(p => p.classList.toggle('now', p === now));
  if (pip) { const line = pip.document.getElementById('line'); if (line) line.textContent = now.textContent; }
}
function closeController() { if (pip) { try { pip.close(); } catch (e) { /* already closed */ } pip = null; } }

async function start() {
  closeMenus(); if ($('#rec').disabled || busy()) return;
  if (playing) live();
  if (on.screen) {
    openController();   // must be asked for during the click, before the share picker opens
    if (!screenStream && !(await startScreen())) {
      closeController();
      if (!on.camera) return;
      setSource('screen', false); layout(); toast('Nothing was shared, so Screen is off for this take.');
    }
    // A whole-screen recording would show the controller in the video, so it is only used for tabs and windows.
    if (screenStream && screenStream.getVideoTracks()[0].getSettings().displaySurface === 'monitor') closeController();
  }
  if (audioCtx?.state === 'suspended') audioCtx.resume();
  B.classList.remove('recording', 'paused'); B.classList.add('counting'); $('#noSound').hidden = true; idleLabel();
  let n = 3; $('#cdNum').textContent = n; clearInterval(cd); clearInterval(tick);
  cd = setInterval(() => { n--; if (n <= 0) go(); else $('#cdNum').textContent = n; }, 1000);
}
function go() {
  clearInterval(cd);
  const mic = on.mic && micStream ? micStream.getAudioTracks() : [];
  const useScreen = on.screen && screenStream, useCam = on.camera && camStream;
  if (!useScreen && !useCam) { B.classList.remove('counting'); closeController(); return; }
  recorders = [];
  const make = (name, tracks, bits) => {
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime || undefined, videoBitsPerSecond: bits, audioBitsPerSecond: 160000 });
    rec.chunks = []; rec.name = name; rec.ondataavailable = e => { if (e.data.size) rec.chunks.push(e.data); };
    recorders.push(rec);
  };
  // The microphone goes with the camera file, or with the screen file when the camera is off.
  if (useCam) make('cam', [...camStream.getVideoTracks(), ...mic], 2500000);
  if (useScreen) make('screen', [...screenStream.getVideoTracks(), ...(useCam ? [] : mic)], 5000000);
  recorders.forEach(r => r.start(1000));
  B.classList.remove('counting', 'paused'); B.classList.add('recording');
  $('#rec').setAttribute('aria-label', 'Stop recording'); $('#rec').title = 'Stop (R)'; $('#pauseLbl').textContent = 'Pause';
  $('#shape').dataset.locked = true;
  secs = 0; startedAt = performance.now(); pausedFor = 0; show(); autoScroll(true); idleLabel();
  clearInterval(tick);
  tick = setInterval(() => {
    if (B.classList.contains('paused')) return;
    secs = (performance.now() - startedAt - pausedFor) / 1000; show();
    if (shape === 'tall' && secs >= 60) stop(true);
  }, 250);
}
function stop(save) {
  clearInterval(tick); clearInterval(cd); autoScroll(false); disarm(); closeController();
  const was = B.classList.contains('recording');
  B.classList.remove('recording', 'counting', 'paused'); $('#rec').title = 'Record (R)';
  $('#shape').dataset.locked = !!(existingClips || shown().length || (was && save));
  const slot = retaking; retaking = null;
  if (!was) return renderClips();
  const thumb = snapshot(), len = Math.max(1, secs), recs = recorders; recorders = [];
  Promise.all(recs.map(r => new Promise(done => { r.onstop = done; if (r.state !== 'inactive') r.stop(); else done(); }))).then(() => {
    if (!save) return renderClips();
    const blobs = {}; recs.forEach(r => { blobs[r.name] = new Blob(r.chunks, { type: r.mimeType || mime }); });
    const clip = { blobs, len, thumb, ext: (mime.includes('mp4') ? 'mp4' : 'webm'), state: 'uploading' };
    if (slot) {
      // The new take goes in right after the old one. The old one is only removed when the Undo window has passed.
      const n = existingClips + shown().indexOf(slot) + 1;
      clip.after = slot; clips.splice(clips.indexOf(slot) + 1, 0, clip); removeSoon(slot);
      toast(`Clip ${n} replaced with the new take.`, () => { bringBack(slot); removeOnServer(clip); renderClips(); });
    } else clips.push(clip);
    renderClips(clip); upload(clip);
  });
  renderClips();
}
$('#countdown').onclick = go;
$('#rec').onclick = () => B.classList.contains('recording') ? stop(true) : B.classList.contains('counting') ? stop(false) : start();
$('#restart').onclick = () => { const slot = retaking; stop(false); retaking = slot; start(); };
$('#pause').onclick = () => {
  if (!B.classList.contains('recording')) return;
  const p = B.classList.toggle('paused'); $('#pauseLbl').textContent = p ? 'Resume' : 'Pause';
  if (pip) { pip.document.getElementById('pl').textContent = p ? 'Resume' : 'Pause'; pip.document.getElementById('ctl').classList.toggle('paused', p); }
  if (p) { pausedAt = performance.now(); recorders.forEach(r => r.state === 'recording' && r.pause()); }
  else { pausedFor += performance.now() - pausedAt; recorders.forEach(r => r.state === 'paused' && r.resume()); }
  idleLabel();
};
// Discard needs a second click, so it can't be hit by accident.
let armT;
function disarm() { clearTimeout(armT); $('#discard').classList.remove('arm'); $('#discardLbl').textContent = 'Discard'; }
$('#discard').onclick = () => {
  if ($('#discard').classList.contains('arm')) { disarm(); stop(false); toast('Take discarded.'); return; }
  $('#discard').classList.add('arm'); $('#discardLbl').textContent = 'Sure?'; armT = setTimeout(disarm, 3000);
};
document.addEventListener('keydown', e => {
  if (e.target.closest('textarea,input,select,[contenteditable="true"]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (!$('#shareDlg').hidden) return;
  if (k === 'r' && !B.classList.contains('noperm')) $('#rec').click();
  if (k === 'p' && B.classList.contains('recording')) $('#pause').click();
  if (k === 'escape' && B.classList.contains('counting')) stop(false);
});
// ---------- Share now: skip the editor and get a link straight away ----------
// LOOT makes the link at once, then processes and exports the video by itself. The page behind the link waits for it.
let share = null, shareTimer = null;
const until = u => u ? `until ${u}` : 'until you turn it off';
const shareUrl = () => location.origin + share.path;
// Copying. The Claude app's browser pane refuses the Clipboard API, and Safari refuses a copy that starts after
// the click. So text that is already known is copied at once, inside the click, with the browser's own copy command.
function copyNow(text, html) {
  if (!text) return false;
  const back = document.activeElement, ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); Object.assign(ta.style, { position: 'fixed', top: '0', left: '-9999px', opacity: '0' });
  (document.querySelector('.scrim:not([hidden]) .dialog') || document.body).appendChild(ta);
  const put = e => { e.clipboardData.setData('text/plain', text); if (html) e.clipboardData.setData('text/html', html); e.preventDefault(); };
  document.addEventListener('copy', put);
  ta.focus(); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.removeEventListener('copy', put); ta.remove();
  if (back && back.focus) back.focus({ preventScroll: true });
  return ok;
}
// Copy text that is known now, or that the server is still making (the clipboard is then handed a promise).
// Gives back true when it was copied.
function copyLater(text, html) {
  if (typeof text === 'string') {
    if (copyNow(text, html)) return Promise.resolve(true);
    if (!navigator.clipboard) return Promise.resolve(false);
    if (html && window.ClipboardItem) return navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]).then(() => true, () => false);
    return navigator.clipboard.writeText(text).then(() => true, () => false);
  }
  const blob = Promise.resolve(text).then(t => { if (!t) throw new Error('nothing to copy'); return new Blob([t], { type: 'text/plain' }); });
  blob.catch(() => {});
  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]).then(() => true, () => false);
  } catch (e) { /* nothing more can be done in this click */ }
  return Promise.resolve(false);
}
const copyText = text => copyLater(text);
function showShare() {
  $('#shLink').value = shareUrl(); $('#shOpen').href = share.path; $('#shEdit').href = `/edit/${project}`;
  $('#shNote').textContent = share.ready ? 'You can send it now. The video, its title and its captions are ready.'
    : share.failed ? 'LOOT could not prepare this video, so the link does not play yet. Open the video in the editor and export it there.'
    : 'You can send it now. LOOT is still writing the title and the captions, and the page fills them in by itself when they are ready.';
  $('#shGif').disabled = !share.ready; $('#shGifNote').hidden = !!share.ready;
}
function watchShare() {
  clearTimeout(shareTimer); if ($('#shareDlg').hidden || !share || share.ready) return;
  shareTimer = setTimeout(async () => {
    try { const r = await fetch(`/api/projects/${project}/share`); if (r.ok) { share = await r.json(); showShare(); } } catch (e) { /* asks again in a moment */ }
    watchShare();
  }, 4000);
}
function closeShare() { $('#shareDlg').hidden = true; clearTimeout(shareTimer); $('#shareNow').focus(); }
$('#shareNow').onclick = async () => {
  if (busy() || $('#shareNow').disabled) return;
  sharing = true; renderClips(); $('#shareNow span').textContent = 'Creating the link…';
  let why = '', made = null;
  // The copy starts inside the click and gets the link when the server has made it. Safari refuses a later copy.
  const link = (async () => {
    try {
      await flushRemovals(); await saveTitle();
      const r = await fetch(`/api/projects/${project}/share-now`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json(); if (r.ok) made = j; else why = typeof j.detail === 'string' ? j.detail : '';
    } catch (e) { /* no connection */ }
    return made ? location.origin + made.path : null;
  })();
  const copied = await copyLater(link); await link;
  sharing = false; $('#shareNow span').textContent = 'Share now'; renderClips();
  if (!made) return toast(why || "The link couldn't be created. Check your connection and try again.");
  share = made;
  $('#shTitle').textContent = copied ? 'Link copied' : 'Your link is ready';
  $('#shCopy').textContent = copied ? 'Copy again' : 'Copy the link';
  $('#shLife').value = String(share.days); $('#shGifBox').hidden = true;
  showShare(); $('#shareDlg').hidden = false; watchShare();
  // In a browser that only copies inside a click, the link is shown ready and the Copy button copies it.
  $('#shRefused').hidden = copied; $('#shRefused').textContent = 'The link is ready. Press Copy.';
  if (!copied) { $('#shTitle').textContent = 'Your link is ready'; $('#shCopy').textContent = 'Copy'; }
  $('#shCopy').focus();
};
$('#shClose').onclick = closeShare;
$('#shareDlg').addEventListener('click', e => { if (e.target.id === 'shareDlg') closeShare(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#shareDlg').hidden) closeShare(); });
$('#shCopy').onclick = async () => {
  const ok = await copyText(shareUrl());
  $('#shRefused').hidden = ok; $('#shRefused').textContent = 'Your browser did not allow the copy. The link is selected, so press Cmd+C.';
  if (!ok) { $('#shLink').focus(); $('#shLink').select(); return; }
  $('#shTitle').textContent = 'Link copied';
  $('#shCopy').textContent = 'Copied'; setTimeout(() => { $('#shCopy').textContent = 'Copy again'; }, 2000);
};
$('#shLink').onfocus = e => e.target.select();
$('#shLife').onchange = async e => {
  let next = null;
  try { const r = await fetch(`/api/projects/${project}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: +e.target.value }) }); if (r.ok) next = await r.json(); } catch (err) { /* no connection */ }
  if (!next) { e.target.value = String(share.days); return toast("That couldn't be changed. Try again."); }
  share = next; showShare(); toast(`The link now works ${until(share.until)}.`);
};
// Copy GIF for email: the GIF goes on the clipboard with the link attached, and a small preview shows what was copied.
let shGifReady = false;   // the GIF is made, so the next click can copy it at once
function shGifHtml() {
  const link = shareUrl(), title = $('.doc-title').textContent.trim();
  const alt = (title && title !== 'Untitled video' ? `Watch the video: ${title}` : 'Watch the video').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<a href="${link}"><img src="${link}/gif" alt="${alt}" width="${shape === 'tall' ? 270 : 480}"></a>`;
}
$('#shGif').onclick = async () => {
  const link = shareUrl(), html = shGifHtml();
  if (shGifReady && copyNow(link, html)) return toast('GIF copied. Paste it into your email.');
  $('#shGif').disabled = true; $('#shGifText').textContent = 'Making the GIF…';
  // LOOT makes the GIF the first time it is asked for. The copy waits for it, so a GIF that failed is never pasted.
  const gif = fetch(`/api/projects/${project}/gif`).then(r => { if (!r.ok) throw new Error('gif'); return r.blob(); });
  gif.catch(() => {});
  let copied = false;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': gif.then(() => new Blob([html], { type: 'text/html' })),
      'text/plain': gif.then(() => new Blob([link], { type: 'text/plain' })) })]);
    copied = true;
  } catch (e) { /* this browser needs a second click: see below */ }
  let blob = null; try { blob = await gif; } catch (e) { /* said below */ }
  $('#shGif').disabled = false; $('#shGifText').textContent = 'Copy GIF for email';
  if (!blob) return toast("The GIF couldn't be made. Try again in a moment.");
  shGifReady = true;
  if ($('#shGifImg').src.startsWith('blob:')) URL.revokeObjectURL($('#shGifImg').src);
  $('#shGifImg').src = URL.createObjectURL(blob); $('#shGifDl').href = `/api/projects/${project}/gif`; $('#shGifBox').hidden = false;
  if (copied) return toast('GIF copied. Paste it into your email.');
  $('#shGif').focus(); toast('The GIF is ready. Press Copy GIF for email again to copy it.');
};

window.addEventListener('beforeunload', e => {
  if (!leaving && (B.classList.contains('recording') || clips.some(k => !k.gone && k.state !== 'ok'))) { e.preventDefault(); e.returnValue = ''; }
});

renderClips(); layout(); init();
