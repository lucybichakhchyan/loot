// LOOT editor: cut the video by editing its transcript, pick a layout, and export.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pid = location.pathname.split('/').pop();
const api = (path, opt) => fetch(`/api/projects/${pid}${path}`, opt);
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const preview = $('#preview'), audio = $('#master'), screenV = $('#screenV'), camV = $('#camV');
const FPS = 30, PAUSE_MIN = 1.0, PAUSE_KEEP = 0.35;

let P = null;                 // the project as the server sent it
let E = null;                 // the edit: everything the user decided
let removed = [];             // merged [start, end] ranges cut from the video, in seconds
let wordCut = [];             // per word: false, or why it is cut
let chunks = [];              // caption lines, in exported-video time
const undoStack = [], redoStack = [];

function toast(text, withUndo) {
  const t = $('#toast'); $('#toastText').textContent = text; $('#toastUndo').style.display = withUndo ? '' : 'none';
  t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 4000);
}

// ---------- the edit ----------
const BG = {
  glow: 'radial-gradient(120% 90% at 80% 10%,#3a2a55 0%,#1d1626 45%,#141118 100%)',
  charcoal: '#1A1A1A', purple: '#2D253A', offwhite: '#F6F6F4', bright: '#8A2BE2',
};
function freshEdit() {
  return { layout: 'bubble', bg: 'glow', captions: { on: true, style: '' }, name: { on: true }, clean: true,
    fillersOn: true, pausesOn: true, wordCuts: [], restored: [], sug: {}, splits: [], segCuts: [] };
}
function change(fn, message) {
  undoStack.push(JSON.stringify(E)); redoStack.length = 0;
  fn(); recompute(); renderAll(); save();
  if (message) toast(message, true);
}
function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(E)); E = JSON.parse(undoStack.pop()); recompute(); renderAll(); applyStyle(); save(); $('#toast').hidden = true; }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(E)); E = JSON.parse(redoStack.pop()); recompute(); renderAll(); applyStyle(); save(); }

let saveTimer;
function save() {
  $('.saved').textContent = 'Saving…'; clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const r = await api('/edit', json('PUT', { ...E, removed, for_duration: P.timeline.duration }));
      $('.saved').textContent = r.ok ? 'Saved' : 'Not saved';
    } catch (e) { $('.saved').textContent = 'Not saved, you are offline'; }
  }, 700);
}

function longPauses() { return P.silences.filter(s => s.seconds >= PAUSE_MIN); }
function recompute() {
  const W = P.words, n = W.length;
  wordCut = new Array(n).fill(false);
  E.wordCuts.forEach(([a, b]) => { for (let i = a; i <= b && i < n; i++) wordCut[i] = 'manual'; });
  if (E.fillersOn) P.fillers.forEach(f => { if (f.certain && !E.restored.includes('f' + f.first_word)) for (let i = f.first_word; i <= f.last_word; i++) wordCut[i] = wordCut[i] || 'filler'; });
  P.suggestions.forEach((s, k) => { if (E.sug[k] === 'cut') for (let i = s.first_word; i <= s.last_word; i++) wordCut[i] = wordCut[i] || 'sug'; });
  const ranges = [];
  for (let i = 0; i < n; i++) {
    if (!wordCut[i]) continue;
    let j = i; while (j + 1 < n && wordCut[j + 1]) j++;
    ranges.push([W[i].start, j + 1 < n ? W[j + 1].start : W[j].end]); i = j;
  }
  if (E.pausesOn) longPauses().forEach(s => { if (!E.restored.includes('p' + s.start)) ranges.push([s.start + PAUSE_KEEP, s.end - PAUSE_KEEP]); });
  E.segCuts.forEach(r => ranges.push(r));
  ranges.sort((a, b) => a[0] - b[0]);
  removed = [];
  for (const [a, b] of ranges) {
    if (b <= a) continue;
    const last = removed[removed.length - 1];
    if (last && a <= last[1] + 0.001) last[1] = Math.max(last[1], b); else removed.push([a, b]);
  }
  // Caption lines, with the same rules the export uses
  chunks = []; let cur = [];
  for (const w of W) {
    const s = outTime(w.start), e = outTime(w.end);
    if (inRemoved((w.start + w.end) / 2) >= 0 || wordCut[w.i]) { if (cur.length) { chunks.push(cur); cur = []; } continue; }
    const text = w.w.replace(/[,.;:]+$/, '');
    if (cur.length) {
      const chars = cur.reduce((a, x) => a + x.w.length + 1, 0);
      if (cur.length >= 4 || chars + text.length > 28 || s - cur[cur.length - 1].end > 0.7 || cur[cur.length - 1].stop) { chunks.push(cur); cur = []; }
    }
    cur.push({ w: text, start: s, end: Math.max(e, s + 0.05), stop: /[.?!]$/.test(w.w) });
  }
  if (cur.length) chunks.push(cur);
}
function inRemoved(t) { for (let i = 0; i < removed.length; i++) { if (t >= removed[i][0] && t < removed[i][1]) return i; if (t < removed[i][0]) break; } return -1; }
function outTime(t) { let cut = 0; for (const [a, b] of removed) { if (t <= a) break; cut += Math.min(t, b) - a; } return t - cut; }
function outTotal() { return P.timeline.duration - removed.reduce((a, r) => a + r[1] - r[0], 0); }

// ---------- transcript ----------
function renderTranscript() {
  const box = $('#transcript'), W = P.words;
  if (!W.length) { box.innerHTML = '<p class="tip">No speech was found in this recording. You can still cut it with Split and Delete on the timeline.</p>'; return; }
  const sugAt = {}, sugEnd = {};
  P.suggestions.forEach((s, k) => { if (!E.sug[k]) { for (let i = s.first_word; i <= s.last_word; i++) sugAt[i] = k; sugEnd[s.last_word] = k; } });
  const pauseAfter = {};
  longPauses().forEach(s => { const i = W.findIndex(w => w.start >= s.end - 0.05); const at = i < 0 ? W.length - 1 : i - 1; if (at >= 0) pauseAfter[at] = s; });
  const clipStart = new Set(P.timeline.clips.map(c => W.findIndex(w => w.start >= c.start - 0.01)).filter(i => i > 0));
  const pending = Object.keys(P.suggestions).filter(k => !E.sug[k]);
  let html = '', para = '', paraStart = 0, count = 0;
  const flush = () => { if (para) html += `<div class="para"><time>${fmt(W[paraStart].start)}</time><p>${para}</p></div>`; para = ''; count = 0; };
  W.forEach((w, i) => {
    if (!para) paraStart = i;
    const cls = wordCut[i] ? 'w cutx' : sugAt[i] !== undefined ? 'w sug' : 'w';
    para += `<span class="${cls}" data-i="${i}"${sugAt[i] !== undefined ? ` data-s="${sugAt[i]}"` : ''}>${esc(w.w)} </span>`;
    if (sugEnd[i] !== undefined) {
      const k = sugEnd[i], s = P.suggestions[k];
      para += `<span class="sugcard" data-card="${k}" hidden><span class="why">${esc(s.reason)}</span><span class="acts"><button class="btn sm primary" data-cut="${k}">Cut it</button><button class="btn sm" data-keep="${k}">Keep it</button><span class="n">${pending.indexOf(String(k)) + 1} of ${pending.length}</span></span></span>`;
    }
    count++;
    const p = pauseAfter[i];
    if (p) {
      const cutNow = E.pausesOn && !E.restored.includes('p' + p.start);
      para += `<span class="pause${cutNow ? ' cutx' : ''}" data-p="${p.start}" title="${cutNow ? 'Shortened. Click to keep the whole pause.' : 'Click to shorten this pause.'}">${p.seconds.toFixed(1)} second pause</span> `;
    }
    const next = W[i + 1];
    if (next && (clipStart.has(i + 1) || (p && p.seconds >= 1.5) || (count >= 45 && /[.?!]$/.test(w.w)))) flush();
  });
  flush();
  box.innerHTML = html; nowEl = null;
  wordEls = []; $$('.w', box).forEach(el => { wordEls[+el.dataset.i] = el; });
  $('#foundN').textContent = pending.length; $('#found').hidden = pending.length === 0;
  $('#foundWord').textContent = pending.length === 1 ? 'possible mistake' : 'possible mistakes';
  markNow();
}
function openCard(k) {
  $$('.sugcard').forEach(c => c.hidden = c.dataset.card !== String(k));
  $$('.w.sug').forEach(s => s.classList.toggle('active', s.dataset.s === String(k)));
  const first = $(`.w.sug[data-s="${k}"]`);
  if (first) { first.scrollIntoView({ block: 'center', behavior: 'smooth' }); seek(P.words[+first.dataset.i].start); }
}
function resolve(k, cut) {
  change(() => { E.sug[k] = cut ? 'cut' : 'keep'; }, cut ? 'Cut from the video.' : null);
  const next = Object.keys(P.suggestions).find(x => !E.sug[x]);
  if (next !== undefined) openCard(next);
}
$('#review').onclick = () => { const k = Object.keys(P.suggestions).find(x => !E.sug[x]); if (k !== undefined) openCard(k); };
$('#cutAll').onclick = () => { const ks = Object.keys(P.suggestions).filter(x => !E.sug[x]); change(() => ks.forEach(k => E.sug[k] = 'cut'), `${ks.length} ${ks.length === 1 ? 'mistake' : 'mistakes'} cut from the video.`); };
$('#transcript').addEventListener('click', e => {
  const c = e.target.closest('[data-cut]'), k = e.target.closest('[data-keep]');
  if (c) return resolve(c.dataset.cut, true);
  if (k) return resolve(k.dataset.keep, false);
  if (!window.getSelection().isCollapsed) return;
  const pause = e.target.closest('.pause');
  if (pause) {
    const key = 'p' + pause.dataset.p;
    if (!E.pausesOn) return toast('Turn on "Shorten long pauses" above to shorten pauses.');
    return change(() => { E.restored = E.restored.includes(key) ? E.restored.filter(x => x !== key) : [...E.restored, key]; });
  }
  const w = e.target.closest('.w'); if (!w) return;
  const i = +w.dataset.i;
  if (w.classList.contains('sug')) return openCard(w.dataset.s);
  if (wordCut[i]) {
    return change(() => {
      if (wordCut[i] === 'manual') E.wordCuts = E.wordCuts.filter(([a, b]) => !(i >= a && i <= b));
      else if (wordCut[i] === 'filler') { const f = P.fillers.find(f => i >= f.first_word && i <= f.last_word); if (f) E.restored.push('f' + f.first_word); }
      else P.suggestions.forEach((s, k2) => { if (i >= s.first_word && i <= s.last_word) E.sug[k2] = 'keep'; });
    }, 'Brought back.');
  }
  seek(P.words[i].start);
});
// Select words, then Cut
const selcut = $('#selcut');
function hideSel() { selcut.classList.remove('show'); }
function selectedWords() {
  const sel = window.getSelection(); if (sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0), box = $('#transcript');
  if (!box.contains(range.commonAncestorContainer)) return null;
  const hit = wordEls.filter(w => w && range.intersectsNode(w) && !wordCut[+w.dataset.i]).map(w => +w.dataset.i);
  if (!hit.length) return null;
  // Ignore a word that the selection only brushes at its trailing space.
  return [Math.min(...hit), Math.max(...hit)];
}
document.addEventListener('selectionchange', () => {
  const words = selectedWords(); if (!words) return hideSel();
  const r = window.getSelection().getRangeAt(0).getBoundingClientRect(); if (!r.width) return hideSel();
  selcut.style.left = Math.max(8, Math.min(innerWidth - 90, r.left + r.width / 2 - 36)) + 'px';
  selcut.style.top = Math.max(8, r.top - 40) + 'px'; selcut.classList.add('show');
});
selcut.addEventListener('mousedown', e => e.preventDefault());
selcut.onclick = () => {
  const words = selectedWords(); if (!words) return;
  window.getSelection().removeAllRanges(); hideSel();
  change(() => E.wordCuts.push(words), 'Cut from the video.');
};
$('#chipFillers').onclick = () => change(() => E.fillersOn = !E.fillersOn);
$('#chipPauses').onclick = () => change(() => E.pausesOn = !E.pausesOn);

// ---------- playback ----------
let playing = false, raf, rate = 1, lastUi = 0;
const lastJump = new WeakMap();
// The sound is the clock. Each video follows it by nudging its speed, and only jumps when it is far off,
// because a jump makes the picture stall for a moment.
function follow(v, t, force) {
  if (!v.src) return;
  const drift = v.currentTime - t, now = performance.now();
  if (force || (Math.abs(drift) > 0.45 && !v.seeking && now - (lastJump.get(v) || 0) > 1500)) {
    lastJump.set(v, now); v.currentTime = t; v.playbackRate = rate;
  } else if (Math.abs(drift) > 0.05) v.playbackRate = rate * (drift > 0 ? 0.93 : 1.07);
  else v.playbackRate = rate;
  if (playing && v.paused && !v.seeking) v.play().catch(() => {});
}
function setPlaying(p) {
  playing = p;
  $('#play use').setAttribute('href', '/static/assets/icons.svg#' + (p ? 'pause' : 'play')); $('#play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  cancelAnimationFrame(raf);
  if (p) { audio.play().catch(() => setPlaying(false)); [screenV, camV].forEach(v => v.src && v.play().catch(() => {})); loop(); }
  else { audio.pause(); [screenV, camV].forEach(v => { v.pause(); follow(v, audio.currentTime, true); }); showTime(audio.currentTime); }
}
function loop() {
  let t = audio.currentTime; const r = inRemoved(t);
  if (r >= 0) {
    if (removed[r][1] >= P.timeline.duration - 0.05) { setPlaying(false); return seek(firstKept()); }
    t = removed[r][1]; audio.currentTime = t; [screenV, camV].forEach(v => follow(v, t, true));
  } else [screenV, camV].forEach(v => follow(v, t));
  const now = performance.now();
  if (now - lastUi > 66) { lastUi = now; showTime(t); }
  if (audio.ended || t >= P.timeline.duration - 0.03) { setPlaying(false); return seek(firstKept()); }
  if (playing) raf = requestAnimationFrame(loop);
}
function firstKept() { return removed.length && removed[0][0] <= 0.01 ? removed[0][1] : 0; }
function seek(t) {
  t = Math.max(0, Math.min(P.timeline.duration - 0.01, t));
  audio.currentTime = t; [screenV, camV].forEach(v => { if (v.src) v.currentTime = t; });
  showTime(t);
}
let nowEl = null, wordEls = [];
function markNow(t = audio.currentTime) {
  const W = P.words; let lo = 0, hi = W.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (W[m].start <= t) { at = m; lo = m + 1; } else hi = m - 1; }
  const el = at >= 0 && t <= W[at].end + 0.4 ? wordEls[at] : null;
  if (el !== nowEl) { if (nowEl) nowEl.classList.remove('now'); if (el) el.classList.add('now'); nowEl = el; }
}
function showTime(t) {
  $('#tc').textContent = fmt(outTime(t)); $('#total').textContent = fmt(outTotal());
  $('#playhead').style.left = (t / P.timeline.duration * 100) + '%';
  markNow(t);
  const cap = $('#cap'), o = outTime(t);
  const c = E.captions.on && inRemoved(t) < 0 ? chunks.find(c => o >= c[0].start && o <= c[c.length - 1].end + 0.15) : null;
  if (!c) { cap.style.display = 'none'; return; }
  let active = 0; c.forEach((w, i) => { if (o >= w.start) active = i; });
  const html = c.map((w, i) => i === active && E.captions.style !== 'plain' ? `<em>${esc(w.w)}</em>` : esc(w.w)).join(' ');
  cap.style.display = ''; if (cap.dataset.html !== html) { cap.dataset.html = html; cap.innerHTML = html; }
}
$('#play').onclick = () => setPlaying(!playing);
$('#speed').onchange = e => { rate = parseFloat(e.target.value); [audio, screenV, camV].forEach(m => m.playbackRate = rate); };
document.addEventListener('keydown', e => {
  if (e.target.closest('input,select,textarea,[contenteditable]')) return;
  if (e.code === 'Space' && !e.target.closest('button')) { e.preventDefault(); setPlaying(!playing); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if (e.key === 'Escape') { $('#export').hidden = true; selectSeg(null); $$('.sugcard').forEach(c => c.hidden = true); }
});

// ---------- timeline ----------
let selectedSeg = null, peaks = null;
function segments() {
  const D = P.timeline.duration, marks = new Set([0, D]);
  P.timeline.clips.forEach(c => { marks.add(c.start); marks.add(c.end); });
  E.splits.forEach(s => marks.add(s));
  const pts = [...marks].sort((a, b) => a - b), segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (pts[i + 1] - pts[i] < 0.02) continue;
    const clip = P.timeline.clips.findIndex(c => pts[i] >= c.start - 0.001 && pts[i] < c.end);
    segs.push({ start: pts[i], end: pts[i + 1], clip, removed: E.segCuts.some(r => r[0] <= pts[i] + 0.001 && r[1] >= pts[i + 1] - 0.001) });
  }
  return segs;
}
function renderTimeline() {
  const D = P.timeline.duration, pct = t => (t / D * 100) + '%', track = $('#clipTrack');
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => D / s <= 8) || 600;
  $('#ruler').innerHTML = Array.from({ length: Math.floor(D / step) + 1 }, (_, i) => `<span style="left:${pct(i * step)}">${fmt(i * step)}</span>`).join('');
  track.innerHTML = '';
  segments().forEach(s => {
    const b = document.createElement('button');
    b.className = 'blk clip' + (s.removed ? ' removed' : '') + (selectedSeg && Math.abs(selectedSeg.start - s.start) < 0.001 && Math.abs(selectedSeg.end - s.end) < 0.001 ? ' selected' : '');
    b.style.left = pct(s.start); b.style.width = `calc(${pct(s.end - s.start)} - 2px)`; b.dataset.start = s.start; b.dataset.end = s.end;
    let bars = '';
    if (peaks) { const n = Math.max(4, Math.round((s.end - s.start) / D * 220)); for (let i = 0; i < n; i++) { const t = s.start + (i + 0.5) / n * (s.end - s.start); bars += `<i style="height:${8 + peaks[Math.min(peaks.length - 1, Math.floor(t / D * peaks.length))] * 70}%"></i>`; } }
    b.innerHTML = `<b>Clip ${s.clip + 1}</b>${bars}`; track.appendChild(b);
  });
  removed.forEach(([a, b]) => { if (E.segCuts.some(r => r[0] <= a + 0.001 && r[1] >= b - 0.001)) return; const m = document.createElement('div'); m.className = 'mark cut'; m.style.left = pct(a); m.style.width = `max(2px, ${pct(b - a)})`; track.appendChild(m); });
  P.suggestions.forEach((s, k) => { if (E.sug[k]) return; const m = document.createElement('div'); m.className = 'mark sugg'; m.style.left = pct(s.start); m.style.width = `max(3px, ${pct(s.end - s.start)})`; track.appendChild(m); });
  $('#capchips').innerHTML = E.captions.on ? chunks.slice(0, 80).map(c => `<span>${esc(c.map(w => w.w).join(' '))}</span>`).join('') : '';
  $('#delBtn span').textContent = selectedSeg && selectedSeg.removed ? 'Bring back' : 'Delete';
}
function selectSeg(s) { selectedSeg = s; renderTimeline(); }
$('#tracks').addEventListener('click', e => {
  const r = $('#tracks').getBoundingClientRect(); seek((e.clientX - r.left) / r.width * P.timeline.duration);
  const b = e.target.closest('.blk.clip');
  selectSeg(b ? segments().find(s => Math.abs(s.start - +b.dataset.start) < 0.001) : null);
});
$('#splitBtn').onclick = () => {
  const t = Math.round(audio.currentTime * FPS) / FPS;
  if (t < 0.1 || t > P.timeline.duration - 0.1) return toast('Move the playhead to where you want to split, then press Split.');
  change(() => E.splits.push(t), 'Clip split at ' + fmt(t) + '.');
};
$('#delBtn').onclick = () => {
  const s = selectedSeg; if (!s) return toast('Click a clip in the timeline first, then Delete.');
  selectedSeg = null;
  if (s.removed) change(() => E.segCuts = E.segCuts.filter(r => !(r[0] <= s.start + 0.001 && r[1] >= s.end - 0.001)), 'Brought back.');
  else change(() => E.segCuts.push([s.start, s.end]), 'Removed from the video.');
};
async function loadPeaks() {
  try {
    const buf = await (await fetch(`/api/projects/${pid}/media/audio_clean.m4a`)).arrayBuffer();
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 2, 44100);
    const data = (await ctx.decodeAudioData(buf)).getChannelData(0), n = 600, size = Math.floor(data.length / n), out = [];
    for (let i = 0; i < n; i++) { let m = 0; for (let j = i * size; j < (i + 1) * size; j += 64) m = Math.max(m, Math.abs(data[j])); out.push(m); }
    const top = Math.max(...out, 0.01); peaks = out.map(v => v / top); renderTimeline();
  } catch (e) { /* the timeline works without the waveform */ }
}

// ---------- style ----------
function applyStyle() {
  const tl = P.timeline, hasScreen = !!tl.screen, hasCam = !!tl.cam;
  const layout = !hasScreen ? 'cam' : !hasCam ? 'screen' : E.layout;
  preview.dataset.layout = layout; preview.style.background = BG[E.bg] || BG.glow;
  preview.classList.toggle('vertical', P.kind === 'short');
  $$('#layouts .tile').forEach(o => { o.setAttribute('aria-pressed', o.dataset.l === layout); o.disabled = (!hasScreen && o.dataset.l !== 'cam') || (!hasCam && o.dataset.l !== 'screen'); o.classList.toggle('dim', o.disabled); });
  $$('#bgs .sw').forEach(o => o.setAttribute('aria-pressed', o.dataset.bg === E.bg));
  $$('#capStyles .tile').forEach(o => o.setAttribute('aria-pressed', o.dataset.c === E.captions.style));
  $('#cap').className = 'cap ' + E.captions.style;
  $('#capSwitch').setAttribute('aria-checked', E.captions.on); $('#capStyles').classList.toggle('dim', !E.captions.on);
  $('#nameSwitch').setAttribute('aria-checked', E.name.on); $('#nameMark').style.display = E.name.on ? '' : 'none';
  $('#soundSwitch').setAttribute('aria-checked', E.clean); $('#soundBox').classList.toggle('dim', !E.clean);
  $('#chipFillers').setAttribute('aria-pressed', E.fillersOn); $('#chipPauses').setAttribute('aria-pressed', E.pausesOn);
  const want = `/api/projects/${pid}/media/${E.clean ? 'audio_clean' : 'audio_raw'}.m4a`;
  if (!audio.src.endsWith(want)) { const t = audio.currentTime || 0, was = playing; setPlaying(false); audio.src = want; audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; if (was) setPlaying(true); }, { once: true }); }
  $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length;
}
function renderAll() { renderTranscript(); renderTimeline(); applyStyle(); showTime(audio.currentTime || 0); }
$$('.ptabs button').forEach(b => b.onclick = () => { $$('.ptabs button').forEach(x => x.setAttribute('aria-selected', x === b)); $('#tab-transcript').hidden = b.dataset.tab !== 'transcript'; $('#tab-style').hidden = b.dataset.tab !== 'style'; hideSel(); });
$$('#layouts .tile').forEach(o => o.onclick = () => change(() => E.layout = o.dataset.l));
$$('#capStyles .tile').forEach(o => o.onclick = () => change(() => E.captions.style = o.dataset.c));
$$('#bgs .sw').forEach(o => o.onclick = () => change(() => E.bg = o.dataset.bg));
$('#capSwitch').onclick = () => change(() => E.captions.on = !E.captions.on);
$('#nameSwitch').onclick = () => change(() => E.name.on = !E.name.on);
$('#soundSwitch').onclick = () => change(() => E.clean = !E.clean);
$('#ba').addEventListener('click', e => { const b = e.target.closest('button'); if (b) $$('#ba button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
const sampler = new Audio(); let sampleTimer;
$('#sample').onclick = () => {
  if (!sampler.paused) { sampler.pause(); clearTimeout(sampleTimer); $('#sampleText').textContent = 'Listen'; return; }
  setPlaying(false);
  const which = $('#ba [aria-pressed="true"]').dataset.v === 'before' ? 'audio_raw' : 'audio_clean';
  sampler.src = `/api/projects/${pid}/media/${which}.m4a`;
  sampler.addEventListener('loadedmetadata', () => { sampler.currentTime = Math.min(audio.currentTime, Math.max(0, P.timeline.duration - 10)); sampler.play(); }, { once: true });
  $('#sampleText').textContent = 'Stop'; sampleTimer = setTimeout(() => { sampler.pause(); $('#sampleText').textContent = 'Listen'; }, 10000);
};
$('#undo').onclick = undo; $('#redo').onclick = redo; $('#toastUndo').onclick = undo;
const title = $('.doc-title');
title.addEventListener('blur', () => api('', json('PATCH', { title: title.textContent.trim() })));
title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });

// ---------- export ----------
let exportTimer;
$('#exportBtn').onclick = () => { selectSeg(null); $('#export').hidden = false; $('#exFail').hidden = true; resetDl(); };
$('#exClose').onclick = () => $('#export').hidden = true;
$('#export').addEventListener('click', e => { if (e.target.id === 'export') $('#export').hidden = true; });
function resetDl() {
  if ($('#dl').disabled) return;
  $('#dlText').textContent = 'Download video'; $('#prog').hidden = true;
  $('#dlNote').textContent = `MP4, about ${fmt(outTotal())} long. It saves to your Downloads folder.`;
}
function watchExport() {
  clearTimeout(exportTimer);
  exportTimer = setTimeout(async () => {
    let s; try { s = await (await api('/export')).json(); } catch (e) { return watchExport(); }
    if (s.state === 'done') {
      $('#dl').disabled = false; $('#progBar').style.width = '100%'; $('#dlText').textContent = 'Downloaded';
      $('#dlNote').textContent = 'Saved to your Downloads folder.' + (s.loudness_ok === false ? ' The volume came out a little off YouTube\'s level.' : '');
      const a = document.createElement('a'); a.href = `/api/projects/${pid}/download/video`; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
      if (s.captions === 'file' && s.has_srt) setTimeout(() => { const c = document.createElement('a'); c.href = `/api/projects/${pid}/download/captions`; c.download = ''; document.body.appendChild(c); c.click(); c.remove(); }, 1200);
      return;
    }
    if (s.state === 'failed') { $('#dl').disabled = false; $('#prog').hidden = true; $('#exFail').hidden = false; $('#dlText').textContent = 'Try the download again'; $('#dlNote').textContent = ''; return; }
    $('#dlText').textContent = s.state === 'queued' ? 'Waiting to start' : `Preparing your video, ${s.pct || 0}%`;
    $('#progBar').style.width = (s.pct || 0) + '%'; watchExport();
  }, 1500);
}
$('#dl').onclick = async () => {
  clearTimeout(saveTimer);
  await api('/edit', json('PUT', { ...E, removed, for_duration: P.timeline.duration })); $('.saved').textContent = 'Saved';
  $('#dl').disabled = true; $('#exFail').hidden = true; $('#dlText').textContent = 'Preparing your video'; $('#prog').hidden = false; $('#progBar').style.width = '0';
  $('#dlNote').textContent = 'This takes a few minutes. You can close this window and keep working.';
  const r = await api('/export', json('POST', { quality: $('#quality').value, captions: $('#capMode').value }));
  if (!r.ok) { $('#dl').disabled = false; $('#exFail').hidden = false; return; }
  watchExport();
};

// ---------- start ----------
async function load() {
  let p;
  try { const r = await api(''); if (r.status === 401) return location.href = '/login'; if (r.status === 404) return location.href = '/'; p = await r.json(); }
  catch (e) { return setTimeout(load, 3000); }
  title.textContent = p.title; document.title = p.title + ' · LOOT';
  $('#recordMore').href = `/record?project=${pid}`;
  if (p.state === 'failed') { $('#transcriptReady').hidden = true; $('#making').hidden = true; $('#noTranscript').hidden = false; return; }
  const usable = p.timeline && (p.state === 'ready' || (p.steps || {}).assemble);
  if (!usable) {
    $('#transcriptReady').hidden = true; $('#noTranscript').hidden = true; $('#making').hidden = false;
    const names = { prepare: 'Preparing the video and transcript', assemble: 'Joining your clips', silences: 'Finding pauses', fillers: 'Finding filler words', cuts: 'Looking for mistakes' };
    const order = Object.keys(names), done = order.filter(k => (p.steps || {})[k]).length;
    $('#makingTitle').textContent = names[order[Math.min(done, order.length - 1)]];
    $('#makingBar').style.width = Math.max(4, Math.round(done / order.length * 100)) + '%';
    return setTimeout(load, 2500);
  }
  P = p; $('#making').hidden = true; $('#noTranscript').hidden = true; $('#transcriptReady').hidden = false;
  E = freshEdit();
  if (p.edit) {
    const same = Math.abs((p.edit.for_duration || 0) - p.timeline.duration) < 0.05;
    for (const k of Object.keys(E)) if (p.edit[k] !== undefined && (same || !['wordCuts', 'restored', 'sug', 'splits', 'segCuts'].includes(k))) E[k] = p.edit[k];
  }
  if (p.timeline.screen) screenV.src = `/api/projects/${pid}/media/screen_all.mp4`;
  if (p.timeline.cam) camV.src = `/api/projects/${pid}/media/cam_all.mp4`;
  $('#loudness').textContent = p.audio && p.audio.loudness_before != null ? `Volume before: ${p.audio.loudness_before} LUFS. After: ${p.audio.loudness_after} LUFS. YouTube's level is −14.` : '';
  if (p.audio && p.audio.quiet_microphone) $('#loudness').textContent = 'Your microphone was very quiet in this recording, so LOOT turned it up. Moving closer to the microphone will sound better.';
  if (p.audio && p.audio.note) $('#loudness').textContent = p.audio.note;
  recompute(); renderAll(); seek(firstKept()); loadPeaks();
  if (p.export && (p.export.state === 'queued' || p.export.state === 'rendering')) { $('#export').hidden = false; $('#dl').disabled = true; $('#prog').hidden = false; watchExport(); }
  if (p.state !== 'ready') { $('#tipExtra').textContent = ' LOOT is still looking for pauses and mistakes. They will appear here in a moment.'; setTimeout(loadRest, 2000); }
  else if (!p.suggestions.length && p.suggestions_note && /API key/.test(p.suggestions_note)) $('#tipExtra').textContent = ' Mistake suggestions are off because the server has no Claude key.';
}
async function loadRest() {
  let p; try { p = await (await api('')).json(); } catch (e) { return setTimeout(loadRest, 3000); }
  if (p.state !== 'ready' && p.state !== 'failed') return setTimeout(loadRest, 2000);
  P.silences = p.silences; P.fillers = p.fillers; P.suggestions = p.suggestions; P.state = p.state;
  $('#tipExtra').textContent = '';
  recompute(); renderAll();
}
window.addEventListener('offline', () => $('#offline').hidden = false);
window.addEventListener('online', () => { $('#offline').hidden = true; if (E) save(); });
load();

$("#retry").onclick = async () => { await api("/process", { method: "POST" }); load(); };
