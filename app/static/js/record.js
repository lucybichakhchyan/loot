// LOOT recorder: records the screen and the camera as two separate files per clip,
// so the layout can still be changed in the editor.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const B = document.body, frame = $('#frame'), shot = $('#shot');
const screenV = $('#screenV'), camV = $('#camV');
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const icon = n => `<svg class="ic"><use href="/static/assets/icons.svg#${n}"/></svg>`;
const params = new URLSearchParams(location.search);

const kinds = {
  long: 'Wide video, 16:9', short: 'Vertical video, 9:16, up to 60 seconds',
  msg: 'Camera only, for a quick message', demo: 'Screen and camera, for showing a product',
};
let kind = 'long';
const on = { screen: true, camera: true, mic: true };
const chosen = { camera: null, mic: null, surface: 'browser' };
let screenStream = null, camStream = null, micStream = null;
let project = params.get('project'), existingClips = 0;
let clips = [], retaking = null;

// ---------- layout of the live preview ----------
function layout() {
  frame.classList.toggle('vertical', kind === 'short');
  frame.classList.toggle('nocam', !on.camera);
  frame.dataset.layout = (!on.screen || kind === 'msg') ? 'cam' : (on.camera ? 'bubble' : 'screen');
  shot.classList.toggle('live', !!screenStream);
  const ready = (on.screen && kind !== 'msg') || on.camera;
  $('#rec').disabled = !ready;
  idleLabel();
}
$('#kind').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || B.classList.contains('recording')) return;
  $$('#kind button').forEach(x => x.setAttribute('aria-pressed', x === b));
  kind = b.dataset.k; $('#what').textContent = kinds[kind];
  if (kind === 'msg') setSource('screen', false);
  layout();
});

// ---------- sources ----------
function label(src, text) { $(`.src[data-src="${src}"] small`).textContent = text; }
function setSource(src, isOn) { on[src] = isOn; $(`.src[data-src="${src}"]`).dataset.on = isOn; if (!isOn) label(src, 'Off'); }
function closeMenus() { $$('.srcwrap .menu').forEach(m => m.hidden = true); }
document.addEventListener('click', closeMenus);
// The meter can only listen after a click, so wake it on the first interaction.
document.addEventListener('pointerdown', () => { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); }, true);

function stopStream(s) { if (s) s.getTracks().forEach(t => t.stop()); }

async function startCamera() {
  stopStream(camStream); camStream = null; camV.srcObject = null;
  if (!on.camera) return layout();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: chosen.camera ? { exact: chosen.camera } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    camV.srcObject = camStream;
    label('camera', camStream.getVideoTracks()[0].label.replace(/\s*\(.*\)$/, '') || 'Camera');
  } catch (e) { setSource('camera', false); label('camera', 'Not available'); }
  layout();
}

let audioCtx, analyser, levelTimer;
async function startMic() {
  stopStream(micStream); micStream = null; clearInterval(levelTimer); $('#noSound').hidden = true;
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
      $('#noSound').hidden = !(silent || quiet); $('.src[data-src="mic"]').classList.toggle('bad', silent);
      if (silent) { $('#noSoundTitle').textContent = `No sound is coming from ${name}.`; $('#noSoundHelp').textContent = 'Check that it is plugged in and not muted, or pick another microphone.'; }
      else if (quiet) { $('#noSoundTitle').textContent = `${name} is very quiet.`; $('#noSoundHelp').textContent = 'LOOT will turn it up, but it sounds better if you move closer or raise Input volume in System Settings, Sound.'; }
    }, 120);
  } catch (e) { setSource('mic', false); label('mic', 'Not available'); }
}

async function startScreen(surface) {
  chosen.surface = surface || chosen.surface;
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: chosen.surface, frameRate: { ideal: 30 }, width: { max: 1920 }, height: { max: 1080 } }, audio: false,
    });
    stopStream(screenStream); screenStream = s; screenV.srcObject = s; setSource('screen', true);
    const surf = s.getVideoTracks()[0].getSettings().displaySurface;
    label('screen', { browser: 'Chrome tab', window: 'A window', monitor: 'Entire screen' }[surf] || 'Sharing');
    $$('.src[data-src="screen"] + .menu button').forEach(b => b.setAttribute('aria-checked', b.dataset.v === surf));
    s.getVideoTracks()[0].addEventListener('ended', () => {
      if (B.classList.contains('recording')) stop(true);
      screenStream = null; screenV.srcObject = null; label('screen', 'Choose what to share'); layout();
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
    const list = devices.filter(d => d.kind === type && d.label);
    menu.innerHTML = `<div class="mh">${src === 'camera' ? 'Camera' : 'Microphone'}</div>` +
      list.map(d => `<button aria-checked="${on[src] && d.deviceId === current}" data-v="${d.deviceId}">${icon('check')}${d.label.replace(/\s*\(.*\)$/, '')}</button>`).join('') +
      `<hr><button aria-checked="${!on[src]}" data-v="off">${icon('check')}${offText}</button>`;
  }
}

$$('.src').forEach(btn => {
  const menu = btn.nextElementSibling, src = btn.dataset.src; btn.title = $('b', btn).textContent;
  btn.addEventListener('click', async e => {
    e.stopPropagation(); if (B.classList.contains('recording')) return;
    const open = menu.hidden; closeMenus();
    if (open && src !== 'screen') await fillDevices();
    menu.hidden = !open;
  });
  menu.addEventListener('click', async e => {
    const o = e.target.closest('button'); if (!o) return; closeMenus();
    const off = o.dataset.v === 'off';
    if (src === 'screen') {
      if (off) { stopStream(screenStream); screenStream = null; screenV.srcObject = null; setSource('screen', false); layout(); }
      else await startScreen(o.dataset.v);
    } else {
      setSource(src, !off); if (!off) chosen[src] = o.dataset.v;
      await (src === 'camera' ? startCamera() : startMic());
    }
  });
});
$('#pickScreen').onclick = e => { e.stopPropagation(); startScreen(); };
$('#pickMic').onclick = async e => { e.stopPropagation(); closeMenus(); await fillDevices(); $('.src[data-src="mic"] + .menu').hidden = false; };

// ---------- permission ----------
function noPerm(id) {
  B.classList.add('noperm'); frame.style.display = 'none'; $('#askPerm').hidden = id !== '#askPerm'; $('#blocked').hidden = id !== '#blocked';
  $$('.src small').forEach(x => x.textContent = 'Not allowed yet');
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
  B.classList.remove('noperm'); frame.style.display = ''; $('#askPerm').hidden = true; $('#blocked').hidden = true;
  label('screen', 'Choose what to share');
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
      if (p.id) { $('.doc-title').textContent = p.title; existingClips = p.clips || 0; kind = p.kind || 'long';
        $$('#kind button').forEach(x => x.setAttribute('aria-pressed', x.dataset.k === kind)); $('#what').textContent = kinds[kind]; }
      else project = null;
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
  scriptText.scrollTop = 0; let pos = 0;
  scrollTimer = setInterval(() => {
    if (B.classList.contains('paused') || $('#scrollSwitch').getAttribute('aria-checked') !== 'true') return;
    pos += (+$('#scrollSpeed').value / 100) * 3 + 0.3; scriptText.scrollTop = pos;
  }, 50);
}

// ---------- clips ----------
function renderClips(fresh) {
  B.classList.toggle('has-clips', clips.length > 0);
  const c = $('#clips'); c.innerHTML = '';
  clips.forEach((k, i) => {
    const n = i + 1, d = document.createElement('div');
    d.className = 'clip' + (n === retaking ? ' retaking' : '') + (n === fresh ? ' fresh' : '');
    d.innerHTML = `<div class="frame"><img src="${k.thumb}" alt=""></div>
      ${k.state === 'failed' ? '<span class="fail">Not uploaded</span>' : ''}
      <div class="acts"><button data-retake="${n}">Retake</button><button data-del="${n}">Delete</button></div>
      <div class="meta"><span>Clip ${existingClips + n}</span><span>${k.state === 'uploading' ? 'Uploading…' : fmt(k.len)}</span></div>`;
    c.appendChild(d);
  });
  const total = clips.reduce((a, k) => a + k.len, 0);
  $('#sum').textContent = clips.length ? `${clips.length} ${clips.length === 1 ? 'clip' : 'clips'}, ${fmt(total)}` + (existingClips ? `, added to ${existingClips} earlier` : '') : '';
  const failed = clips.findIndex(k => k.state === 'failed');
  $('#upFail').hidden = failed < 0;
  if (failed >= 0) $('#upFailText').textContent = `Clip ${existingClips + failed + 1} didn't upload.`;
  $('#editBtn').disabled = !clips.length || clips.some(k => k.state !== 'ok');
  idleLabel();
}
function idleLabel() {
  const ready = !$('#rec').disabled;
  $('#recTitle').textContent = !ready ? 'Turn on the screen or camera' : retaking ? `Retake clip ${existingClips + retaking}` : clips.length ? 'Record another clip' : 'Start recording';
  $('#recSub').textContent = !ready ? 'Nothing to record yet' : retaking ? 'Replaces the old take' : '3 second countdown';
  if (!B.classList.contains('recording')) $('#rec').setAttribute('aria-label', $('#recTitle').textContent);
}
$('#clips').addEventListener('click', e => {
  const r = e.target.closest('[data-retake]'), d = e.target.closest('[data-del]');
  if (r) { retaking = +r.dataset.retake; renderClips(); start(); }
  if (d) { const [gone] = clips.splice(+d.dataset.del - 1, 1); renderClips();
    if (gone.id) fetch(`/api/projects/${project}/clips/${gone.id}`, { method: 'DELETE' }); }
});

async function ensureProject() {
  if (project) return project;
  const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: $('.doc-title').textContent.trim() || 'Untitled video', kind }) });
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
    const r = await fetch(`/api/projects/${project}/clips` + (clip.replaces ? `?replace=${clip.replaces}` : ''), { method: 'POST', body: fd });
    if (!r.ok) throw new Error('upload failed');
    clip.id = (await r.json()).id; clip.replaces = null; clip.state = 'ok';
  } catch (e) { clip.state = 'failed'; }
  renderClips();
}
$('#retryUp').onclick = () => clips.filter(k => k.state === 'failed').forEach(upload);
$('.doc-title').addEventListener('blur', () => {
  if (project) fetch(`/api/projects/${project}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: $('.doc-title').textContent.trim() }) });
});
$('.doc-title').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
$('#editBtn').onclick = async () => {
  $('#editBtn').disabled = true; $('#editBtn').textContent = 'Opening the editor…';
  await fetch(`/api/projects/${project}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: $('.doc-title').textContent.trim(), kind }) });
  await fetch(`/api/projects/${project}/process`, { method: 'POST' });
  leaving = true; location.href = `/edit/${project}`;
};

// ---------- recording ----------
const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(m => MediaRecorder.isTypeSupported(m)) || '';
let recorders = [], cd, tick, secs = 0, startedAt = 0, pausedFor = 0, pausedAt = 0, leaving = false;
const show = () => { $('#timer').textContent = $('#badgeTime').textContent = fmt(secs); };

function snapshot() {
  const c = document.createElement('canvas'); c.width = 208; c.height = 117;
  const g = c.getContext('2d'); g.fillStyle = '#141118'; g.fillRect(0, 0, 208, 117);
  const v = (screenStream && on.screen && kind !== 'msg') ? screenV : camV;
  if (v.videoWidth) { const s = Math.min(208 / v.videoWidth, 117 / v.videoHeight), w = v.videoWidth * s, h = v.videoHeight * s; g.drawImage(v, (208 - w) / 2, (117 - h) / 2, w, h); }
  return c.toDataURL('image/jpeg', 0.7);
}
async function start() {
  closeMenus(); if ($('#rec').disabled) return;
  const wantScreen = on.screen && kind !== 'msg';
  if (wantScreen && !screenStream && !(await startScreen())) { if (!on.camera) return; }
  if (audioCtx?.state === 'suspended') audioCtx.resume();
  B.classList.remove('recording', 'paused'); B.classList.add('counting');
  let n = 3; $('#cdNum').textContent = n; clearInterval(cd); clearInterval(tick);
  cd = setInterval(() => { n--; if (n <= 0) go(); else $('#cdNum').textContent = n; }, 1000);
}
function go() {
  clearInterval(cd);
  const mic = on.mic && micStream ? micStream.getAudioTracks() : [];
  const useScreen = on.screen && kind !== 'msg' && screenStream, useCam = on.camera && camStream;
  if (!useScreen && !useCam) { B.classList.remove('counting'); return; }
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
  $('#rec').setAttribute('aria-label', 'Stop recording'); $('#pauseLbl').textContent = 'Pause';
  secs = 0; startedAt = performance.now(); pausedFor = 0; show(); autoScroll(true);
  clearInterval(tick);
  tick = setInterval(() => {
    if (B.classList.contains('paused')) return;
    secs = (performance.now() - startedAt - pausedFor) / 1000; show();
    if (kind === 'short' && secs >= 60) stop(true);
  }, 250);
}
function stop(save) {
  clearInterval(tick); clearInterval(cd); autoScroll(false);
  const was = B.classList.contains('recording');
  B.classList.remove('recording', 'counting', 'paused');
  if (!was) { retaking = null; return renderClips(); }
  const thumb = snapshot(), len = Math.max(1, secs), recs = recorders, slot = retaking;
  recorders = []; retaking = null;
  Promise.all(recs.map(r => new Promise(done => { r.onstop = done; if (r.state !== 'inactive') r.stop(); else done(); }))).then(() => {
    if (!save) return renderClips();
    const blobs = {}; recs.forEach(r => { blobs[r.name] = new Blob(r.chunks, { type: r.mimeType || mime }); });
    const clip = { blobs, len, thumb, ext: (mime.includes('mp4') ? 'mp4' : 'webm'), state: 'uploading' };
    let fresh;
    if (slot) { clip.replaces = clips[slot - 1].id; clips[slot - 1] = clip; fresh = slot; } else { clips.push(clip); fresh = clips.length; }
    renderClips(fresh); upload(clip);
  });
  renderClips();
}
$('#countdown').onclick = go;
$('#rec').onclick = () => B.classList.contains('recording') ? stop(true) : B.classList.contains('counting') ? stop(false) : start();
$('#discard').onclick = () => stop(false);
$('#restart').onclick = () => { const slot = retaking; stop(false); retaking = slot; start(); };
$('#pause').onclick = () => {
  const p = B.classList.toggle('paused'); $('#pauseLbl').textContent = p ? 'Resume' : 'Pause';
  if (p) { pausedAt = performance.now(); recorders.forEach(r => r.state === 'recording' && r.pause()); }
  else { pausedFor += performance.now() - pausedAt; recorders.forEach(r => r.state === 'paused' && r.resume()); }
};
window.addEventListener('beforeunload', e => {
  if (!leaving && (B.classList.contains('recording') || clips.some(k => k.state !== 'ok'))) { e.preventDefault(); e.returnValue = ''; }
});

renderClips(); layout(); init();
