// The page a viewer opens from a shared link. It needs no sign-in and shows only what the owner shared.
const $ = s => document.querySelector(s);
const q = new URLSearchParams(location.search), R = document.documentElement.style;
const token = location.pathname.split('/')[2];
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const P = $('#player'), video = $('#video');

function brand(b) {
  if (b.accent) {
    R.setProperty('--acc', b.accent);
    // Dark text on a light button, white text on a dark one.
    const m = /^#([0-9a-f]{6})$/i.exec(b.accent);
    if (m) { const n = parseInt(m[1], 16), l = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255); R.setProperty('--on-acc', l > 150 ? '#1A1A1A' : '#fff'); }
  }
  if (b.headline_font === 'sans') { R.setProperty('--hf', '"Inter",sans-serif'); R.setProperty('--hstyle', 'normal'); R.setProperty('--hweight', '700'); }
  $('#who').textContent = b.name || '';
  if (b.has_logo) { $('#logo').src = '/w/brand/logo'; $('#still').src = '/w/brand/logo'; }
  const cta = $('#cta');
  cta.hidden = !(b.cta_show && b.cta_text && (b.cta_link || token === 'preview'));
  cta.textContent = b.cta_text || ''; if (b.cta_link) cta.href = b.cta_link;
}
function turnedOff() {
  $('main').innerHTML = '<section class="about" style="padding-top:96px"><p class="eyebrow">link turned off</p><h1>This video is no longer shared</h1><p class="note">The person who sent it turned the link off. Ask them to send you a new one.</p></section>';
  document.title = 'Link turned off';
}

let lines = [];   // captions: [{start, end, text}]
function show() {
  const t = video.currentTime || 0, d = video.duration || 0;
  $('#cur').textContent = fmt(t); $('#bar').style.width = (d ? t / d * 100 : 0) + '%';
  $('#scrub').setAttribute('aria-valuenow', Math.round(t));
  const line = lines.find(l => t >= l.start && t <= l.end);
  $('#caption').textContent = line ? line.text : '';
}
function setPlay(on) { if (on) video.play().catch(() => {}); else video.pause(); }
function wirePlayer() {
  video.addEventListener('play', () => { P.classList.add('playing'); $('#pp use').setAttribute('href', '/static/assets/icons.svg#pause'); $('#pp').setAttribute('aria-label', 'Pause'); });
  video.addEventListener('pause', () => { P.classList.remove('playing'); $('#pp use').setAttribute('href', '/static/assets/icons.svg#play'); $('#pp').setAttribute('aria-label', 'Play'); });
  video.addEventListener('timeupdate', show);
  video.addEventListener('loadedmetadata', () => { $('#dur').textContent = fmt(video.duration); $('#scrub').setAttribute('aria-valuemax', Math.round(video.duration)); show(); });
  video.addEventListener('ended', () => { video.currentTime = 0; });
  $('#big').onclick = () => setPlay(true);
  video.onclick = $('#pp').onclick = () => setPlay(video.paused);
  $('#fs').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else if (P.requestFullscreen) P.requestFullscreen(); };
  $('#vol').onclick = e => {
    video.muted = !video.muted; const b = e.currentTarget;
    b.querySelector('use').setAttribute('href', '/static/assets/icons.svg#' + (video.muted ? 'x' : 'volume-2')); b.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  };
  $('#speed').onclick = e => { const r = video.playbackRate === 1 ? 1.5 : video.playbackRate === 1.5 ? 2 : 1; video.playbackRate = r; e.currentTarget.textContent = r + '×'; };
  $('#cc').onclick = e => { const b = e.currentTarget, on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on); P.classList.toggle('cc', on); };
  $('#scrub').onclick = e => { const r = e.currentTarget.getBoundingClientRect(); if (video.duration) video.currentTime = (e.clientX - r.left) / r.width * video.duration; };
  $('#scrub').addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 5); }
  });
  document.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('button,a')) return;
    if (e.code === 'Space') { e.preventDefault(); setPlay(video.paused); }
    if (e.key.toLowerCase() === 'c' && !$('#cc').hidden) $('#cc').click();
  });
}

async function start() {
  if (token === 'preview') {
    // Brand settings shows this page with its choices in the address, so its preview is live.
    brand({ accent: q.get('acc'), headline_font: q.get('font'), name: q.get('name') || '',
      cta_show: q.get('showcta') !== '0', cta_text: q.get('cta') || 'Get in touch', has_logo: q.get('logo') === '1' });
    if (q.get('compact')) document.body.classList.add('compact');
    if (q.get('state') === 'off') return turnedOff();
    video.hidden = true; $('#still').hidden = false;
    $('#title').textContent = 'Thanks for the introduction'; $('#meta').textContent = '1 minute · 10 November 2026';
    $('#note').textContent = 'A short hello, and the two ideas I mentioned for the launch.'; $('#dur').textContent = '1:05';
    return;
  }
  let info;
  try { info = await getInfo(); } catch (e) { return turnedOff(); }
  brand(info.brand || {});
  if (!info.on) return turnedOff();
  if (info.ready === false) return wait(info);
  ready(info);
}
async function getInfo() { const r = await fetch(`/w/${token}/info`); if (!r.ok) throw new Error(); return r.json(); }

// A link made straight after recording can be opened before the video is finished.
// The page says so, asks again every 4 seconds, and shows the video as soon as it is there.
function wait(info) {
  document.body.classList.add('wait'); P.hidden = true; $('#cta').hidden = true; $('#meta').textContent = '';
  $('#eyebrow').textContent = info.failed ? 'something went wrong' : 'almost ready';
  $('#title').textContent = info.failed ? 'This video could not be prepared' : 'This video is still being prepared';
  $('#note').textContent = info.failed ? 'Ask the person who sent it to send you the link again.' : 'It will show here by itself in a moment.';
  document.title = info.failed ? 'Video not ready' : 'Video on its way';
  setTimeout(async () => {
    let next;
    try { next = await getInfo(); } catch (e) { return wait(info); }   // a dropped connection: keep waiting
    if (!next.on) return turnedOff();
    if (next.ready === false) return wait(next);
    document.body.classList.remove('wait'); P.hidden = false; brand(next.brand || {});
    ready(next); video.play().catch(() => {});   // browsers that don't allow this leave the play button showing
  }, 4000);
}
function ready(info) {
  document.title = `${info.title} · ${(info.brand || {}).name || 'LOOT'}`;
  $('#title').textContent = info.title; $('#note').textContent = info.description || '';
  const mins = Math.max(1, Math.round(info.seconds / 60));
  $('#meta').textContent = `${info.seconds < 50 ? Math.round(info.seconds) + ' seconds' : mins + (mins === 1 ? ' minute' : ' minutes')} · ${info.date}`;
  $('#eyebrow').textContent = info.tall ? 'short video' : 'video message';
  P.classList.toggle('tall', !!info.tall);
  lines = info.captions || [];
  // Captions that are already part of the picture can't be switched off, so the button is hidden.
  if (!lines.length) { $('#cc').hidden = true; P.classList.remove('cc'); }
  video.src = `/w/${token}/video`; wirePlayer();
}
start();
