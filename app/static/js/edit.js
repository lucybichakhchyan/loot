// LOOT editor: cut the video by editing its transcript, set how it looks, and export.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pid = location.pathname.split('/').pop();
const api = (path, opt) => fetch(`/api/projects/${pid}${path}`, opt);
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const preview = $('#preview'), audio = $('#master'), screenV = $('#screenV'), camV = $('#camV'), title = $('#docTitle');
const FPS = 30, PAUSE_MIN = 1.0, PAUSE_KEEP = 0.35, INTRO = 3, OUTRO = 5, TITLE_MAX = 60, DESC_MAX = 200;
const LAYOUT_NAMES = { bubble: 'Bubble', side: 'Side by side', cam: 'Camera only', screen: 'Screen only' };
const BG = {
  glow: 'radial-gradient(120% 90% at 80% 10%,#3a2a55 0%,#1d1626 45%,#141118 100%)',
  charcoal: '#1A1A1A', purple: '#2D253A', offwhite: '#F6F6F4', bright: '#8A2BE2',
};

let P = null;                 // the project as the server sent it
let E = null;                 // the edit: everything the user decided
let removed = [];             // merged [start, end] ranges cut from the video, in seconds
let wordCut = [];             // per word: false, or why it is cut
let chunks = [];              // caption lines, in exported-video time
let selected = null;          // {type:'clip'|'zoom'|'layout', ...} on the timeline
const uid = () => Math.random().toString(36).slice(2, 9);

// ---------- one undo history for every edit ----------
const past = [], future = [];
function toast(text, undoable) {
  const t = $('#toast'); $('#toastText').textContent = text; $('#toastUndo').hidden = !undoable;
  t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, undoable ? 7000 : 3500);
}
function syncHistory() { $('#undo').disabled = !past.length; $('#redo').disabled = !future.length; }
function act(label, doIt, undoIt, quiet) { doIt(); past.push({ label, doIt, undoIt }); future.length = 0; syncHistory(); if (!quiet) toast(label, true); }
function undo() { const a = past.pop(); if (!a) return; a.undoIt(); future.push(a); syncHistory(); toast('Undid: ' + a.label.replace(/\.$/, ''), false); }
function redo() { const a = future.pop(); if (!a) return; a.doIt(); past.push(a); syncHistory(); toast('Redid: ' + a.label.replace(/\.$/, ''), false); }
$('#undo').onclick = undo; $('#redo').onclick = redo; $('#toastUndo').onclick = () => { undo(); $('#toast').hidden = true; };
// An edit to the video: remembered as a before and an after, so it can be undone and redone exactly.
function change(fn, label, quiet) {
  const before = JSON.stringify(E); let after = null;
  act(label || 'Changed.', () => { if (after) E = JSON.parse(after); else { fn(); after = JSON.stringify(E); } refresh(); },
    () => { E = JSON.parse(before); refresh(); }, quiet || !label);
}
function refresh() { recompute(); renderAll(); save(); }

function freshEdit(titled) {
  return { layout: 'bubble', bg: 'glow', captions: { on: true, style: '' }, name: { on: true }, clean: true, mirror: true,
    fillersOn: true, pausesOn: true, wordCuts: [], restored: [], sug: {}, splits: [], segCuts: [], trims: {},
    layouts: [], zooms: [], fixes: {}, intro: { on: !!titled }, outro: { on: false, line: 'More at bichakhchyan.com' } };
}
const TIME_BOUND = ['wordCuts', 'restored', 'sug', 'splits', 'segCuts', 'trims', 'layouts', 'zooms', 'fixes'];

let saveTimer;
const payload = () => ({ ...E, removed, for_duration: P.timeline.duration });
function save() {
  $('#savedWords').textContent = 'Saving…'; clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try { const r = await api('/edit', json('PUT', payload())); $('#savedWords').textContent = r.ok ? 'All changes saved' : 'Not saved'; }
    catch (e) { $('#savedWords').textContent = 'Saved on this computer'; }
  }, 700);
}

// ---------- what is cut ----------
const longPauses = () => P.silences.filter(s => s.seconds >= PAUSE_MIN);
const wordText = i => (E.fixes[i] !== undefined ? E.fixes[i] : P.words[i].w);
function segments() {
  const D = P.timeline.duration, marks = new Set([0, D]);
  P.timeline.clips.forEach(c => { marks.add(c.start); marks.add(c.end); });
  E.splits.forEach(s => marks.add(s));
  const pts = [...marks].sort((a, b) => a - b), segs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (pts[i + 1] - pts[i] < 0.05) continue;
    const key = pts[i].toFixed(3), trim = E.trims[key] || [pts[i], pts[i + 1]];
    const clip = P.timeline.clips.findIndex(c => pts[i] >= c.start - 0.001 && pts[i] < c.end);
    segs.push({ key, start: pts[i], end: pts[i + 1], in: clamp(trim[0], pts[i], pts[i + 1]), out: clamp(trim[1], pts[i], pts[i + 1]), clip,
      removed: E.segCuts.some(r => r[0] <= pts[i] + 0.001 && r[1] >= pts[i + 1] - 0.001) });
  }
  segs.forEach((s, n) => { s.name = `Clip ${n + 1}`; });
  return segs;
}
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
  segments().forEach(s => { if (s.in > s.start + 0.01) ranges.push([s.start, s.in]); if (s.out < s.end - 0.01) ranges.push([s.out, s.end]); });
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
    const text = wordText(w.i).replace(/[,.;:]+$/, '');
    if (inRemoved((w.start + w.end) / 2) >= 0 || wordCut[w.i]) { if (cur.length) { chunks.push(cur); cur = []; } continue; }
    if (!text) continue;
    const s = outTime(w.start), e = outTime(w.end);
    if (cur.length) {
      const chars = cur.reduce((a, x) => a + x.w.length + 1, 0);
      if (cur.length >= 4 || chars + text.length > 28 || s - cur[cur.length - 1].end > 0.7 || cur[cur.length - 1].stop) { chunks.push(cur); cur = []; }
    }
    cur.push({ w: text, start: s, end: Math.max(e, s + 0.05), stop: /[.?!]$/.test(wordText(w.i)) });
  }
  if (cur.length) chunks.push(cur);
}
function inRemoved(t) { for (let i = 0; i < removed.length; i++) { if (t >= removed[i][0] && t < removed[i][1]) return i; if (t < removed[i][0]) break; } return -1; }
function outTime(t) { let cutLen = 0; for (const [a, b] of removed) { if (t <= a) break; cutLen += Math.min(t, b) - a; } return t - cutLen; }
function outTotal() { return P.timeline.duration - removed.reduce((a, r) => a + r[1] - r[0], 0); }
const cutSeconds = (a, b) => Math.max(0, b - a);

// ---------- transcript ----------
let wordEls = [], openSug = null;
const pendingSugs = () => Object.keys(P.suggestions).filter(k => !E.sug[k]);
function renderTranscript() {
  const box = $('#transcript'), W = P.words;
  if (!W.length) { box.innerHTML = '<p class="tip">No speech was found in this recording. You can still cut it with Split and Delete on the timeline.</p>'; $('#found').hidden = true; return; }
  const sugAt = {}, sugEnd = {}, sugStart = {};
  P.suggestions.forEach((s, k) => { if (!E.sug[k]) { for (let i = s.first_word; i <= s.last_word; i++) sugAt[i] = k; sugEnd[s.last_word] = k; sugStart[s.first_word] = k; } });
  const pauseAfter = {};
  longPauses().forEach(s => { const i = W.findIndex(w => w.start >= s.end - 0.05); const at = i < 0 ? W.length - 1 : i - 1; if (at >= 0) pauseAfter[at] = s; });
  const clipStart = new Set(P.timeline.clips.map(c => W.findIndex(w => w.start >= c.start - 0.01)).filter(i => i > 0));
  const pending = pendingSugs();
  let html = '', para = '', paraStart = 0, count = 0, sentenceStart = true;
  const flush = () => { if (para) html += `<div class="para"><time>${fmt(W[paraStart].start)}</time><p>${para}</p></div>`; para = ''; count = 0; };
  W.forEach((w, i) => {
    if (!para) paraStart = i;
    const isCut = !!wordCut[i], inSug = sugAt[i] !== undefined;
    const cls = ['w', isCut ? 'cutx' : inSug ? 'sug' : '', E.fixes[i] !== undefined ? 'fixed' : ''].filter(Boolean).join(' ');
    // Tab stops: the first word of each sentence, of each suggestion and of each cut run.
    const cutRunStart = isCut && (i === 0 || !wordCut[i - 1]);
    const stop = !isCut && !inSug ? sentenceStart : (isCut ? cutRunStart : sugStart[i] !== undefined);
    const label = isCut ? 'Cut. Press Enter to bring it back' : inSug ? 'Possible mistake. Press Enter to review it' : '';
    para += `<span class="${cls}" data-i="${i}"${inSug ? ` data-s="${sugAt[i]}"` : ''}${stop ? ' tabindex="0"' : ''}${label && stop ? ` role="button" aria-label="${label}"` : ''}${E.fixes[i] !== undefined ? ` title="Was: ${esc(w.w)}"` : ''}>${esc(wordText(i))} </span>`;
    sentenceStart = /[.?!]$/.test(w.w);
    if (sugEnd[i] !== undefined) {
      const k = sugEnd[i], s = P.suggestions[k];
      para += `<span class="sugcard" data-card="${k}" ${String(openSug) === String(k) ? '' : 'hidden'}><span class="why">${esc(s.reason)}</span><span class="acts"><button class="btn sm primary" data-cut="${k}">Cut it</button><button class="btn sm" data-keep="${k}">Keep it</button><button class="btn sm quiet" data-hear="${k}"><svg class="ic fill"><use href="/static/assets/icons.svg#play"/></svg>Hear it</button><span class="n">${pending.indexOf(String(k)) + 1} of ${pending.length}</span></span></span>`;
    }
    count++;
    const p = pauseAfter[i];
    if (p) {
      const cutNow = E.pausesOn && !E.restored.includes('p' + p.start);
      para += `<span class="pause${cutNow ? ' cutx' : ''}" tabindex="0" role="button" data-p="${p.start}" title="${cutNow ? 'Shortened. Click to keep the whole pause.' : 'Click to shorten this pause.'}">${p.seconds.toFixed(1)} second pause</span> `;
    }
    const next = W[i + 1];
    if (next && (clipStart.has(i + 1) || (p && p.seconds >= 1.5) || (count >= 45 && /[.?!]$/.test(w.w)))) flush();
  });
  flush();
  box.innerHTML = html; nowEl = null;
  wordEls = []; $$('.w', box).forEach(el => { wordEls[+el.dataset.i] = el; });
  if (openSug !== null) $$(`.w.sug[data-s="${openSug}"]`).forEach(el => el.classList.add('active'));
  // The banner: Review is the main action, Cut all is the quiet one.
  const n = pending.length, any = P.suggestions.length > 0;
  $('#found').hidden = !any; $('#found').classList.toggle('done', any && n === 0);
  $('#foundText').innerHTML = n ? `<b>${n}</b> possible ${n === 1 ? 'mistake' : 'mistakes'} found` : 'All suggestions reviewed';
  $('#review').hidden = !n; $('#cutAll').hidden = !n;
  $('#cleanSum').textContent = 'Automatic cleanup: ' + ([E.fillersOn ? '"um" and "uh"' : '', E.pausesOn ? 'long pauses' : ''].filter(Boolean).join(', ') || 'off');
  $('#chipFillers').setAttribute('aria-checked', E.fillersOn); $('#chipPauses').setAttribute('aria-checked', E.pausesOn);
  $('#tip').hidden = removed.length > 0 && past.length > 0;
  markNow();
}
function openCard(k) {
  openSug = k; const s = P.suggestions[k];
  $$('.sugcard').forEach(c => c.hidden = c.dataset.card !== String(k));
  $$('.w.sug').forEach(el => el.classList.toggle('active', el.dataset.s === String(k)));
  const first = $(`.w.sug[data-s="${k}"]`);
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (s) seek(Math.max(0, s.start - 2));   // start a little before, so she hears what leads into it
}
function resolve(k, cut) {
  const next = pendingSugs().find(x => x !== String(k));
  openSug = next !== undefined ? next : null;
  change(() => { E.sug[k] = cut ? 'cut' : 'keep'; }, cut ? 'Cut from the video.' : 'Kept as it is.');
  if (next !== undefined) openCard(next); else toast('All suggestions reviewed.', true);
}
$('#review').onclick = () => { const k = pendingSugs()[0]; if (k !== undefined) openCard(k); };
$('#cutAll').onclick = () => {
  const ks = pendingSugs(), secs = Math.round(ks.reduce((a, k) => a + P.suggestions[k].end - P.suggestions[k].start, 0));
  openSug = null;
  change(() => ks.forEach(k => E.sug[k] = 'cut'), `Cut ${ks.length} possible ${ks.length === 1 ? 'mistake' : 'mistakes'}, ${secs} seconds in all.`);
};
const sampler = new Audio(); let sampleTimer;
function playPart(src, from, to) {
  setPlaying(false); clearTimeout(sampleTimer); sampler.pause();
  sampler.src = `/api/projects/${pid}/media/${src}.m4a`;
  sampler.addEventListener('loadedmetadata', () => { sampler.currentTime = from; sampler.play().catch(() => {}); }, { once: true });
  sampleTimer = setTimeout(() => { sampler.pause(); $('#sampleText').textContent = 'Listen'; }, (to - from) * 1000);
}
function wordAt(el) { const w = el.closest('.w'); return w ? +w.dataset.i : -1; }
function sentenceOf(i) {
  let a = i, b = i; const W = P.words;
  while (a > 0 && !/[.?!]$/.test(W[a - 1].w)) a--;
  while (b < W.length - 1 && !/[.?!]$/.test(W[b].w)) b++;
  return [a, b];
}
function bringBack(i) {
  change(() => {
    if (wordCut[i] === 'manual') E.wordCuts = E.wordCuts.filter(([a, b]) => !(i >= a && i <= b));
    else if (wordCut[i] === 'filler') { const f = P.fillers.find(f => i >= f.first_word && i <= f.last_word); if (f) E.restored.push('f' + f.first_word); }
    else P.suggestions.forEach((s, k) => { if (i >= s.first_word && i <= s.last_word) E.sug[k] = 'keep'; });
  }, 'Brought back.');
}
function togglePause(el) {
  const key = 'p' + el.dataset.p;
  if (!E.pausesOn) return toast('Turn on "Shorten long pauses" in Automatic cleanup first.', false);
  const was = E.restored.includes(key);
  change(() => { E.restored = was ? E.restored.filter(x => x !== key) : [...E.restored, key]; }, was ? 'Pause shortened.' : 'Pause kept.');
}
function activate(target) {
  const pause = target.closest('.pause'); if (pause) return togglePause(pause);
  const i = wordAt(target); if (i < 0) return;
  const el = wordEls[i];
  if (el.classList.contains('sug')) return openCard(el.dataset.s);
  if (wordCut[i]) return bringBack(i);
  seek(P.words[i].start);
}
$('#transcript').addEventListener('click', e => {
  const c = e.target.closest('[data-cut]'), k = e.target.closest('[data-keep]'), h = e.target.closest('[data-hear]');
  if (c) return resolve(c.dataset.cut, true);
  if (k) return resolve(k.dataset.keep, false);
  if (h) { const s = P.suggestions[h.dataset.hear]; playPart('audio_clean', Math.max(0, s.start - 2), Math.min(P.timeline.duration, s.end + 1.5)); return toast('Playing the part around it, with the mistake still in.', false); }
  if (e.target.closest('.fix') || !window.getSelection().isCollapsed) return;
  activate(e.target);
});
$('#transcript').addEventListener('keydown', e => {
  if (e.target.closest('.fix')) return;
  if (e.key === 'Enter') { e.preventDefault(); activate(e.target); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && window.getSelection().isCollapsed) {
    const i = wordAt(e.target); if (i < 0 || wordCut[i]) return;
    e.preventDefault(); const [a, b] = sentenceOf(i);
    change(() => E.wordCuts.push([a, b]), 'Cut from the video.');
  }
});

// Select words, then choose Cut, Fix text or Layout
const selbar = $('#selcut');
function hideSel() { selbar.classList.remove('show'); }
function selectedWords() {
  const sel = window.getSelection(); if (sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0), box = $('#transcript');
  if (!box.contains(range.commonAncestorContainer)) return null;
  const hit = wordEls.filter(w => w && range.intersectsNode(w)).map(w => +w.dataset.i);
  if (!hit.length) return null;
  let a = Math.min(...hit), b = Math.max(...hit);
  // A selection that only brushes the space after the last word should not take the next word with it.
  if (b > a && range.endContainer === wordEls[b].firstChild && range.endOffset === 0) b--;
  return [a, b];
}
document.addEventListener('selectionchange', () => {
  if ($('.fix')) return hideSel();
  const words = selectedWords(); if (!words) return hideSel();
  const r = window.getSelection().getRangeAt(0).getBoundingClientRect(); if (!r.width) return hideSel();
  selbar.classList.add('show');
  selbar.style.left = clamp(r.left + r.width / 2 - selbar.offsetWidth / 2, 8, innerWidth - selbar.offsetWidth - 8) + 'px';
  selbar.style.top = Math.max(8, r.top - 46) + 'px';
});
selbar.addEventListener('mousedown', e => e.preventDefault());
function cutSelection() {
  const words = selectedWords(); if (!words) return false;
  window.getSelection().removeAllRanges(); hideSel();
  change(() => E.wordCuts.push(words), 'Cut from the video.'); return true;
}
$('#selCut').onclick = cutSelection;
$('#selLayout').onclick = () => {
  const words = selectedWords(); if (!words) return;
  const [a] = sentenceOf(words[0]), [, b] = sentenceOf(words[1]);
  window.getSelection().removeAllRanges(); hideSel();
  const start = P.words[a].start, len = Math.max(2, P.words[b].end - start), block = { id: uid(), start, len, layout: otherLayout() };
  change(() => E.layouts.push(block), `Layout changed for ${Math.round(len)} seconds.`);
  select({ type: 'layout', id: block.id });
};
// Fix text: correct the wording in the transcript and captions. It never cuts the video.
$('#selFix').onclick = () => {
  const words = selectedWords(); if (!words) return;
  const [a, b] = words; window.getSelection().removeAllRanges(); hideSel();
  const old = []; for (let i = a; i <= b; i++) old.push(wordText(i));
  const box = document.createElement('span'); box.className = 'fix'; box.contentEditable = 'true'; box.spellcheck = false; box.textContent = old.join(' ');
  wordEls[a].before(box); for (let i = a; i <= b; i++) wordEls[i].style.display = 'none';
  box.focus(); document.getSelection().selectAllChildren(box);
  let closed = false;
  const done = keep => {
    if (closed) return; closed = true;
    const text = box.textContent.replace(/\s+/g, ' ').trim();
    if (!keep || !text || text === old.join(' ')) return renderTranscript();
    const parts = text.split(' ');
    change(() => {
      for (let i = a; i <= b; i++) {
        // Same number of words: each keeps its own timing. Otherwise the new wording sits on the first word.
        const v = parts.length === b - a + 1 ? parts[i - a] : (i === a ? text : '');
        if (v === P.words[i].w) delete E.fixes[i]; else E.fixes[i] = v;
      }
    }, 'Text fixed. The captions use the new wording.');
  };
  box.onkeydown = ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); done(true); } if (ev.key === 'Escape') done(false); };
  box.onblur = () => done(true);
};
$('#chipFillers').onclick = () => change(() => E.fillersOn = !E.fillersOn, E.fillersOn ? '"Um" and "uh" are back in.' : '"Um" and "uh" removed.');
$('#chipPauses').onclick = () => change(() => E.pausesOn = !E.pausesOn, E.pausesOn ? 'Long pauses are back in.' : 'Long pauses shortened.');

// ---------- playback ----------
let playing = false, raf, rate = 1, lastUi = 0, nowEl = null;
const lastJump = new WeakMap();
// The sound is the clock. Each video follows it by nudging its speed, and only jumps when it is far off,
// because a jump makes the picture stall for a moment.
function follow(v, t, force) {
  if (!v.src) return;
  const drift = v.currentTime - t, now = performance.now();
  if (force || (Math.abs(drift) > 0.45 && !v.seeking && now - (lastJump.get(v) || 0) > 1500)) { lastJump.set(v, now); v.currentTime = t; v.playbackRate = rate; }
  else if (Math.abs(drift) > 0.05) v.playbackRate = rate * (drift > 0 ? 0.93 : 1.07);
  else v.playbackRate = rate;
  if (playing && v.paused && !v.seeking) v.play().catch(() => {});
}
function setPlaying(p) {
  playing = p;
  $('#play use').setAttribute('href', '/static/assets/icons.svg#' + (p ? 'pause' : 'play')); $('#play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  cancelAnimationFrame(raf);
  if (p) { sampler.pause(); audio.play().catch(() => setPlaying(false)); [screenV, camV].forEach(v => v.src && v.play().catch(() => {})); loop(); }
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
  t = clamp(t, 0, P.timeline.duration - 0.01);
  audio.currentTime = t; [screenV, camV].forEach(v => { if (v.src) v.currentTime = t; });
  showTime(t);
}
function markNow(t = audio.currentTime) {
  const W = P.words; let lo = 0, hi = W.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (W[m].start <= t) { at = m; lo = m + 1; } else hi = m - 1; }
  const el = at >= 0 && t <= W[at].end + 0.4 ? wordEls[at] : null;
  if (el !== nowEl) { if (nowEl) nowEl.classList.remove('now'); if (el) el.classList.add('now'); nowEl = el; }
}
const has = () => ({ screen: !!P.timeline.screen, cam: !!P.timeline.cam });
const usable = l => (!has().screen ? 'cam' : !has().cam ? 'screen' : l);
function layoutAt(t) { let l = E.layout; E.layouts.forEach(b => { if (t >= b.start && t < b.start + b.len) l = b.layout; }); return usable(l); }
function otherLayout() { return E.layout === 'cam' ? 'bubble' : 'cam'; }
function showTime(t) {
  const o = outTime(t), total = outTotal();
  $('#tc').textContent = fmt(o); $('#total').textContent = fmt(total);
  $('#playhead').style.left = (t / P.timeline.duration * 100) + '%'; $('#tracks').setAttribute('aria-valuenow', Math.round(t));
  markNow(t);
  const layout = layoutAt(t); if (preview.dataset.layout !== layout) preview.dataset.layout = layout;
  // Zoom: scale the screen around the chosen spot while the playhead is inside a zoom.
  const z = E.zooms.find(z => t >= z.start && t < z.start + z.len - 0.4);
  screenV.style.transformOrigin = z ? `${z.x * 100}% ${z.y * 100}%` : screenV.style.transformOrigin;
  screenV.style.transform = z ? `scale(${z.scale})` : '';
  // Cards cover the first 3 and the last 5 seconds of the finished video.
  const cut = inRemoved(t) >= 0;
  const intro = E.intro.on && !cut && o < INTRO, outro = E.outro.on && !cut && o > total - OUTRO && total > INTRO + OUTRO;
  $('#tcard').hidden = !intro; $('#ecard').hidden = !outro || intro;
  const cap = $('#cap');
  const c = E.captions.on && !cut && !intro && !outro ? chunks.find(c => o >= c[0].start && o <= c[c.length - 1].end + 0.15) : null;
  if (!c) { cap.style.display = 'none'; return; }
  let active = 0; c.forEach((w, i) => { if (o >= w.start) active = i; });
  const html = c.map((w, i) => i === active && E.captions.style !== 'plain' ? `<em>${esc(w.w)}</em>` : esc(w.w)).join(' ');
  cap.style.display = ''; if (cap.dataset.html !== html) { cap.dataset.html = html; cap.innerHTML = html; }
}
$('#play').onclick = () => setPlaying(!playing);
$('#speed').onchange = e => { rate = parseFloat(e.target.value); [audio, screenV, camV].forEach(m => m.playbackRate = rate); };

// ---------- timeline ----------
let peaks = null;
const pct = t => (t / P.timeline.duration * 100) + '%';
function renderTimeline() {
  const D = P.timeline.duration, track = $('#clipTrack');
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find(s => D / s <= 8) || 600;
  $('#ruler').innerHTML = Array.from({ length: Math.floor(D / step) + 1 }, (_, i) => `<span style="left:${pct(i * step)}">${fmt(i * step)}</span>`).join('');
  $('#tracks').setAttribute('aria-valuemax', Math.round(D));
  track.innerHTML = '';
  segments().forEach(s => {
    const b = document.createElement('button');
    b.className = 'blk clip' + (s.removed ? ' removed' : '') + (selected && selected.type === 'clip' && selected.key === s.key ? ' selected' : '');
    b.style.left = pct(s.in); b.style.width = `calc(${pct(s.out - s.in)} - 2px)`; b.dataset.key = s.key; b.title = s.name;
    let bars = '';
    if (peaks) { const n = Math.max(4, Math.round((s.out - s.in) / D * 220)); for (let i = 0; i < n; i++) { const t = s.in + (i + 0.5) / n * (s.out - s.in); bars += `<i style="height:${8 + peaks[Math.min(peaks.length - 1, Math.floor(t / D * peaks.length))] * 70}%"></i>`; } }
    b.innerHTML = `<b>${s.name}</b>${bars}<span class="grip l" data-grip="l"></span><span class="grip r" data-grip="r"></span>`; track.appendChild(b);
  });
  const trims = segments().flatMap(s => [[s.start, s.in], [s.out, s.end]]);
  removed.forEach(([a, b]) => {
    if (E.segCuts.some(r => r[0] <= a + 0.001 && r[1] >= b - 0.001) || trims.some(r => Math.abs(r[0] - a) < 0.01 && Math.abs(r[1] - b) < 0.01)) return;
    const m = document.createElement('div'); m.className = 'tmark cut'; m.style.left = pct(a); m.style.width = `max(2px, ${pct(b - a)})`; track.appendChild(m);
  });
  P.suggestions.forEach((s, k) => { if (E.sug[k]) return; const m = document.createElement('div'); m.className = 'tmark sugg'; m.style.left = pct(s.start); m.style.width = `max(3px, ${pct(s.end - s.start)})`; track.appendChild(m); });
  $('#layoutTrack').innerHTML = E.layouts.map(b => `<button class="blk layoutb${b.len / D < 0.06 ? ' tiny' : ''}${selected && selected.id === b.id ? ' selected' : ''}" style="left:${pct(b.start)};width:max(14px, ${pct(b.len)})" data-layout-id="${b.id}" title="${LAYOUT_NAMES[b.layout]} for ${Math.round(b.len)} seconds">${LAYOUT_NAMES[b.layout]}</button>`).join('');
  $('#zoomTrack').innerHTML = E.zooms.map(z => `<button class="blk zoom${selected && selected.id === z.id ? ' selected' : ''}" style="left:${pct(z.start)};width:max(44px, ${pct(z.len)})" data-zoom-id="${z.id}" title="Zoom ${z.scale}× for ${z.len} seconds">${z.scale}×</button>`).join('');
  $('#capchips').innerHTML = E.captions.on ? chunks.slice(0, 80).map(c => `<span>${esc(c.map(w => w.w).join(' '))}</span>`).join('') : '';
  const seg = selected && selected.type === 'clip' ? segments().find(s => s.key === selected.key) : null;
  $('#delBtn').disabled = !selected; $('#delBtn span').textContent = seg && seg.removed ? 'Bring back' : 'Delete';
  $('#addZoom').disabled = !has().screen; $('#addLayout').disabled = !(has().screen && has().cam);
  placePops();
}
function placePops() {
  const z = selected && selected.type === 'zoom' ? E.zooms.find(x => x.id === selected.id) : null;
  const l = selected && selected.type === 'layout' ? E.layouts.find(x => x.id === selected.id) : null;
  const zp = $('#zpop'), lp = $('#lpop');
  zp.hidden = !z; lp.hidden = !l;
  if (z) { zp.style.left = `clamp(0px, calc(${pct(z.start)} - 100px), calc(100% - 260px))`; $('#zRange').value = z.scale; $('#zVal').textContent = z.scale + '×'; $('#zLen').value = z.len; $('#zLenVal').textContent = z.len + (z.len === 1 ? ' second' : ' seconds'); }
  if (l) { lp.style.left = `clamp(0px, calc(${pct(l.start)} - 100px), calc(100% - 260px))`; $$('#lChoices button').forEach(b => b.setAttribute('aria-pressed', b.dataset.l === l.layout)); $('#lLen').value = Math.round(l.len); $('#lLenVal').textContent = Math.round(l.len) + ' seconds'; }
  if (!z) stopPicking();
}
function select(s) { selected = s; renderTimeline(); }
$('#tracks').addEventListener('click', e => {
  if (e.target.closest('.zpop') || dragged) { dragged = false; return; }
  const r = $('#tracks').getBoundingClientRect(); seek((e.clientX - r.left) / r.width * P.timeline.duration);
  const clip = e.target.closest('.blk.clip'), zoom = e.target.closest('[data-zoom-id]'), lay = e.target.closest('[data-layout-id]');
  select(clip ? { type: 'clip', key: clip.dataset.key } : zoom ? { type: 'zoom', id: zoom.dataset.zoomId } : lay ? { type: 'layout', id: lay.dataset.layoutId } : null);
});
$('#tracks').addEventListener('keydown', e => {
  if (e.target.closest('.zpop')) return;
  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowRight') { e.preventDefault(); seek(audio.currentTime + step); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); seek(audio.currentTime - step); }
});
// Split makes two real clips at the playhead. Each can be selected, trimmed or deleted.
function split() {
  const t = Math.round(audio.currentTime * FPS) / FPS, seg = segments().find(s => t > s.in + 0.1 && t < s.out - 0.1);
  if (!seg) return toast('Move the playhead inside a clip first, then Split.', false);
  change(() => {
    E.splits.push(t);
    if (E.trims[seg.key]) { const [a, b] = E.trims[seg.key]; E.trims[seg.key] = [a, t]; E.trims[t.toFixed(3)] = [t, b]; }
  }, 'Clip split at ' + fmt(t) + '.');
}
$('#splitBtn').onclick = split;
function deleteSelected() {
  const s = selected; if (!s) return;
  if (s.type === 'zoom') { selected = null; return change(() => E.zooms = E.zooms.filter(z => z.id !== s.id), 'Zoom removed.'); }
  if (s.type === 'layout') { selected = null; return change(() => E.layouts = E.layouts.filter(z => z.id !== s.id), 'Layout change removed.'); }
  const seg = segments().find(x => x.key === s.key); if (!seg) return;
  selected = null;
  if (seg.removed) change(() => E.segCuts = E.segCuts.filter(r => !(r[0] <= seg.start + 0.001 && r[1] >= seg.end - 0.001)), 'Brought back.');
  else change(() => E.segCuts.push([seg.start, seg.end]), `${seg.name} removed from the video.`);
}
$('#delBtn').onclick = deleteSelected;
// Drag a clip's edge to trim it. It can be dragged back out as far as the clip was recorded.
let dragged = false;
$('#clipTrack').addEventListener('pointerdown', e => {
  const grip = e.target.closest('.grip'); if (!grip) return;
  e.preventDefault(); e.stopPropagation();
  const blk = grip.closest('.blk'), seg = segments().find(s => s.key === blk.dataset.key), side = grip.dataset.grip;
  const rect = $('#tracks').getBoundingClientRect(), D = P.timeline.duration; let at = side === 'l' ? seg.in : seg.out;
  blk.classList.add('dragging'); grip.setPointerCapture(e.pointerId);
  const move = ev => {
    const t = Math.round(clamp((ev.clientX - rect.left) / rect.width * D, seg.start, seg.end) * FPS) / FPS;
    at = side === 'l' ? Math.min(t, seg.out - 0.3) : Math.max(t, seg.in + 0.3); dragged = true;
    const a = side === 'l' ? at : seg.in, b = side === 'l' ? seg.out : at;
    blk.style.left = pct(a); blk.style.width = `calc(${pct(b - a)} - 2px)`;
  };
  const up = () => {
    grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); blk.classList.remove('dragging');
    const before = side === 'l' ? seg.in : seg.out, secs = Math.round((side === 'l' ? at - before : before - at) * 10) / 10;
    if (Math.abs(secs) < 0.05) return renderTimeline();
    change(() => { E.trims[seg.key] = side === 'l' ? [at, seg.out] : [seg.in, at]; },
      (secs > 0 ? `Trimmed ${secs} ${secs === 1 ? 'second' : 'seconds'} from` : `Added ${-secs} ${secs === -1 ? 'second' : 'seconds'} back to`) + ` the ${side === 'l' ? 'start' : 'end'} of ${seg.name}.`);
    setTimeout(() => { dragged = false; }, 50);
  };
  grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
});
// Zoom: how far, how long, and the spot it points at.
$('#addZoom').onclick = () => {
  const t = audio.currentTime, z = { id: uid(), start: Math.round(t * 10) / 10, len: Math.min(4, Math.max(1, Math.floor(P.timeline.duration - t))), scale: 1.5, x: 0.5, y: 0.5 };
  change(() => E.zooms.push(z), 'Zoom added at ' + fmt(t) + '.'); select({ type: 'zoom', id: z.id });
};
const editZoom = (fn, label) => { const id = selected.id; change(() => fn(E.zooms.find(z => z.id === id)), label, true); };
$('#zRange').onchange = e => editZoom(z => z.scale = +(+e.target.value).toFixed(1), 'Zoom changed.');
$('#zRange').oninput = e => { $('#zVal').textContent = (+e.target.value).toFixed(1) + '×'; };
$('#zLen').onchange = e => editZoom(z => z.len = +e.target.value, 'Zoom length changed.');
$('#zLen').oninput = e => { $('#zLenVal').textContent = e.target.value + (e.target.value === '1' ? ' second' : ' seconds'); };
$('#zDel').onclick = deleteSelected; $('#zDone').onclick = () => select(null);
function stopPicking() { preview.classList.remove('picking'); $('#target').classList.remove('show'); $('#zPick').hidden = true; }
$('#zPickBtn').onclick = () => {
  const z = E.zooms.find(x => x.id === selected.id); if (!z) return;
  setPlaying(false); seek(z.start + Math.min(0.5, z.len / 2)); screenV.style.transform = '';
  preview.classList.add('picking'); $('#zPick').hidden = false; placeTarget(z);
};
function placeTarget(z) {
  const f = preview.getBoundingClientRect(), v = $('#zw').getBoundingClientRect(), tg = $('#target');
  tg.style.left = ((v.left - f.left + z.x * v.width) / f.width * 100) + '%'; tg.style.top = ((v.top - f.top + z.y * v.height) / f.height * 100) + '%'; tg.classList.add('show');
}
preview.addEventListener('click', e => {
  if (!preview.classList.contains('picking') || !selected) return;
  const v = $('#zw').getBoundingClientRect(), x = clamp((e.clientX - v.left) / v.width, 0, 1), y = clamp((e.clientY - v.top) / v.height, 0, 1);
  editZoom(z => { z.x = +x.toFixed(3); z.y = +y.toFixed(3); }, 'Zoom spot changed.');
  stopPicking(); toast('Zoom will point here.', false);
});
// Layout for part of the video
$('#addLayout').onclick = () => {
  const t = Math.round(audio.currentTime * 10) / 10, b = { id: uid(), start: t, len: Math.max(2, Math.min(10, P.timeline.duration - t)), layout: otherLayout() };
  change(() => E.layouts.push(b), 'Layout changed for 10 seconds.'); select({ type: 'layout', id: b.id });
};
const editLayout = (fn, label) => { const id = selected.id; change(() => fn(E.layouts.find(z => z.id === id)), label, true); };
$('#lChoices').addEventListener('click', e => { const b = e.target.closest('button'); if (b) editLayout(l => l.layout = b.dataset.l, 'Layout for this part changed.'); });
$('#lLen').onchange = e => editLayout(l => l.len = +e.target.value, 'Layout for this part changed.');
$('#lLen').oninput = e => { $('#lLenVal').textContent = e.target.value + ' seconds'; };
$('#lDel').onclick = deleteSelected; $('#lDone').onclick = () => select(null);

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
  const base = usable(E.layout);
  preview.style.background = BG[E.bg] || BG.glow;
  preview.classList.toggle('vertical', P.kind === 'short'); preview.classList.toggle('mirror', E.mirror !== false);
  $$('#layouts .tile').forEach(o => { o.setAttribute('aria-pressed', o.dataset.l === base); o.classList.toggle('dim', (!has().screen && o.dataset.l !== 'cam') || (!has().cam && o.dataset.l !== 'screen')); });
  $$('#bgs .sw').forEach(o => o.setAttribute('aria-pressed', o.dataset.bg === E.bg));
  $$('#capStyles .tile').forEach(o => o.setAttribute('aria-pressed', o.dataset.c === E.captions.style));
  $('#cap').className = 'cap ' + E.captions.style;
  $('#capSwitch').setAttribute('aria-checked', E.captions.on); $('#capStyles').classList.toggle('dim', !E.captions.on);
  $('#nameSwitch').setAttribute('aria-checked', E.name.on); $('#nameMark').style.display = E.name.on ? '' : 'none';
  $('#mirrorSwitch').setAttribute('aria-checked', E.mirror !== false);
  $('#soundSwitch').setAttribute('aria-checked', E.clean); $('#soundBox').classList.toggle('dim', !E.clean);
  $('#introSwitch').setAttribute('aria-checked', E.intro.on); $('#outroSwitch').setAttribute('aria-checked', E.outro.on);
  $('#outroField').hidden = !E.outro.on; if (document.activeElement !== $('#outroText')) $('#outroText').value = E.outro.line;
  $('#ecardLine').textContent = E.outro.line; $('#tcardTitle').textContent = title.textContent.trim() || 'Untitled video';
  const want = `/api/projects/${pid}/media/${E.clean ? 'audio_clean' : 'audio_raw'}.m4a`;
  if (!audio.src.endsWith(want)) { const t = audio.currentTime || 0, was = playing; setPlaying(false); audio.src = want; audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; if (was) setPlaying(true); }, { once: true }); }
}
function renderAll() { renderTranscript(); renderTimeline(); applyStyle(); showTime(audio.currentTime || 0); }
$$('.ptabs button').forEach(b => b.onclick = () => { $$('.ptabs button').forEach(x => x.setAttribute('aria-selected', x === b)); $('#tab-transcript').hidden = b.dataset.tab !== 'transcript'; $('#tab-style').hidden = b.dataset.tab !== 'style'; hideSel(); });
$$('#layouts .tile').forEach(o => o.onclick = () => change(() => E.layout = o.dataset.l, 'Layout changed.'));
$$('#capStyles .tile').forEach(o => o.onclick = () => change(() => E.captions.style = o.dataset.c, 'Caption style changed.'));
$$('#bgs .sw').forEach(o => o.onclick = () => change(() => E.bg = o.dataset.bg, 'Background changed.'));
$('#capSwitch').onclick = () => change(() => E.captions.on = !E.captions.on, E.captions.on ? 'Captions turned off.' : 'Captions turned on.');
$('#nameSwitch').onclick = () => change(() => E.name.on = !E.name.on, E.name.on ? 'Name hidden.' : 'Name shown.');
$('#soundSwitch').onclick = () => change(() => E.clean = !E.clean, E.clean ? 'Sound clean-up turned off.' : 'Sound clean-up turned on.');
$('#mirrorSwitch').onclick = () => { change(() => E.mirror = E.mirror === false, E.mirror !== false ? 'Camera no longer mirrored.' : 'Camera mirrored.'); try { localStorage.setItem('loot-mirror', E.mirror ? '1' : '0'); } catch (e) { /* private window */ } };
$('#introSwitch').onclick = () => {
  const turningOn = !E.intro.on; change(() => E.intro.on = turningOn, turningOn ? 'Title card added.' : 'Title card removed.', true);
  if (turningOn) { setPlaying(false); seek(firstKept()); toast('The title card shows for the first 3 seconds.', false); }
};
$('#outroSwitch').onclick = () => {
  const turningOn = !E.outro.on; change(() => E.outro.on = turningOn, turningOn ? 'Closing card added.' : 'Closing card removed.', true);
  if (turningOn) {
    setPlaying(false); let t = P.timeline.duration - 0.2; while (inRemoved(t) >= 0 && t > 0) t = removed[inRemoved(t)][0] - 0.1;
    seek(t); toast('The closing card shows for the last 5 seconds.', false);
  }
};
$('#outroText').onchange = e => change(() => E.outro.line = e.target.value.trim() || 'More at bichakhchyan.com', 'Closing line changed.', true);
$('#outroText').oninput = e => { $('#ecardLine').textContent = e.target.value; };
$('#ba').addEventListener('click', e => { const b = e.target.closest('button'); if (b) $$('#ba button').forEach(x => x.setAttribute('aria-pressed', x === b)); });
$('#sample').onclick = () => {
  if (!sampler.paused) { sampler.pause(); clearTimeout(sampleTimer); $('#sampleText').textContent = 'Listen'; return; }
  const before = $('#ba [aria-pressed="true"]').dataset.v === 'before', from = Math.min(audio.currentTime, Math.max(0, P.timeline.duration - 10));
  playPart(before ? 'audio_raw' : 'audio_clean', from, from + 10); $('#sampleText').textContent = 'Stop';
  toast(`Playing 10 seconds of the ${before ? 'original' : 'cleaned'} sound.`, false);
};

// ---------- title and description ----------
let details = { title: '', description: '' }, detailsTimer;
function showDetails() {
  $('#detT').value = details.title; $('#detD').value = details.description;
  $('#detTn').textContent = `${details.title.length} of ${TITLE_MAX}`; $('#detDn').textContent = `${details.description.length} of ${DESC_MAX}`;
  title.textContent = details.title; document.title = details.title + ' · LOOT'; $('#tcardTitle').textContent = details.title;
}
function saveDetails() { clearTimeout(detailsTimer); detailsTimer = setTimeout(() => api('', json('PATCH', { title: details.title, description: details.description })).catch(() => {}), 500); }
function setDetails(d) { details = { title: d.title || 'Untitled video', description: d.description || '' }; showDetails(); saveDetails(); }
title.addEventListener('input', () => { details.title = title.textContent.trim(); $('#detT').value = details.title; $('#detTn').textContent = `${details.title.length} of ${TITLE_MAX}`; $('#tcardTitle').textContent = details.title; saveDetails(); });
title.addEventListener('blur', () => { if (!title.textContent.trim()) setDetails({ title: 'Untitled video', description: details.description }); });
title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
$('#detT').oninput = e => { details.title = e.target.value; title.textContent = details.title; $('#tcardTitle').textContent = details.title; $('#detTn').textContent = `${details.title.length} of ${TITLE_MAX}`; saveDetails(); };
$('#detD').oninput = e => { details.description = e.target.value; $('#detDn').textContent = `${details.description.length} of ${DESC_MAX}`; saveDetails(); };
function openDetails(open) { $('#details').hidden = !open; $('#detailsBtn').setAttribute('aria-expanded', open); if (open) $('#detT').focus(); }
$('#detailsBtn').onclick = e => { e.stopPropagation(); openDetails($('#details').hidden); };
$('#detClose').onclick = () => openDetails(false);
document.addEventListener('click', e => { if (!$('#details').hidden && !e.target.closest('#details')) openDetails(false); });
$('#detAgain').onclick = async () => {
  const b = $('#detAgain'), old = { ...details }; b.disabled = true; $('#detFrom').textContent = 'Writing another version…';
  try {
    const r = await api('/describe', json('POST', { avoid: old }));
    if (!r.ok) throw new Error((await r.json()).detail || '');
    const fresh = await r.json();
    act('Wrote a new title and description.', () => setDetails(fresh), () => setDetails(old));
    $('#detFrom').textContent = 'LOOT wrote these from your transcript. Edit them, or ask for another version.';
  } catch (err) { $('#detFrom').textContent = err.message || 'A new version couldn\'t be written. Try again in a moment.'; }
  b.disabled = false;
};
async function copy(text, what, btn) {
  try { await navigator.clipboard.writeText(text); } catch (e) { return toast(`${what} couldn't be copied.`, false); }
  if (btn) { const was = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = was; }, 1500); }
  toast(what + ' copied.', false);
}
$('#detCopyT').onclick = e => copy(details.title, 'Title', e.currentTarget); $('#detCopyD').onclick = e => copy(details.description, 'Description', e.currentTarget);
$('#doneCopyT').onclick = e => copy(details.title, 'Title', e.currentTarget); $('#doneCopyD').onclick = e => copy(details.description, 'Description', e.currentTarget);

// ---------- export: set up, progress, finished ----------
let exportTimer, exporting = false;
function exView(name) { ['vSetup', 'vProgress', 'vDone'].forEach(v => $('#' + v).hidden = v !== name); $('#exTitle').textContent = name === 'vDone' ? 'Export finished' : 'Export video'; }
function openExport(open) {
  $('#export').hidden = !open;
  if (open) { select(null); ($('#export .view:not([hidden]) .btn.primary') || $('#exClose')).focus(); }
}
function setExporting(on, pctDone) {
  exporting = on; $('#exChip').classList.toggle('show', on); $('#exportBtn').classList.toggle('hidden', on);
  if (on) { $('#exChipText').textContent = `Preparing ${pctDone}%`; $('#exChipBar').style.width = pctDone + '%'; $('#pText').textContent = `Preparing your video, ${pctDone}%`; $('#progBar').style.width = pctDone + '%'; }
}
$('#exportBtn').onclick = () => {
  if (!navigator.onLine) return toast('You are offline. Export works again when you are back online.', false);
  $('#exFail').hidden = true; $('#dlText').textContent = 'Download video';
  $('#dlNote').textContent = `MP4, ${fmt(outTotal())} long. It saves to your Downloads folder.`;
  exView('vSetup'); openExport(true);
};
$('#exChip').onclick = () => { exView('vProgress'); openExport(true); };
$('#exClose').onclick = $('#exHide').onclick = $('#doneBtn').onclick = () => openExport(false);
$('#export').addEventListener('click', e => { if (e.target.id === 'export') openExport(false); });
$('#export').addEventListener('keydown', e => {   // Tab stays inside the dialog
  if (e.key !== 'Tab') return;
  const items = $$('#export button, #export select, #export a').filter(x => x.offsetParent && !x.disabled); if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});
function download(what) { const a = document.createElement('a'); a.href = `/api/projects/${pid}/download/${what}`; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
function watchExport(downloadWhenDone) {
  clearTimeout(exportTimer);
  exportTimer = setTimeout(async () => {
    let s; try { s = await (await api('/export')).json(); } catch (e) { return watchExport(downloadWhenDone); }
    if (s.state === 'done') {
      setExporting(false);
      if (downloadWhenDone) { download('video'); if (s.captions === 'file' && s.has_srt) setTimeout(() => download('captions'), 1200); }
      const name = (details.title.replace(/[^\w\- ]+/g, '').trim() || 'LOOT video') + '.mp4';
      $('#doneNote').textContent = `Saved to your Downloads folder as ${name}. LOOT keeps its copy for 3 days.` + (s.loudness_ok === false ? ' The volume came out a little off YouTube\'s level.' : '');
      exView('vDone'); if ($('#export').hidden) toast('Export finished. Saved to your Downloads folder.', false);
      return;
    }
    if (s.state === 'failed' || s.state === 'cancelled') {
      setExporting(false); exView('vSetup');
      if (s.state === 'failed') { $('#exFail').hidden = false; $('#dlText').textContent = 'Try the download again'; }
      return;
    }
    setExporting(true, s.pct || 0); watchExport(downloadWhenDone);
  }, 1500);
}
$('#dl').onclick = async () => {
  clearTimeout(saveTimer);
  try {
    await api('/edit', json('PUT', payload())); $('#savedWords').textContent = 'All changes saved';
    const r = await api('/export', json('POST', { quality: $('#exQ').value, captions: $('#exC').value }));
    if (!r.ok) throw new Error();
  } catch (e) { $('#exFail').hidden = false; return; }
  $('#exFail').hidden = true; setExporting(true, 0); exView('vProgress'); watchExport(true);
};
$('#exCancel').onclick = async () => {
  clearTimeout(exportTimer); await api('/export/cancel', { method: 'POST' }).catch(() => {});
  setExporting(false); exView('vSetup'); openExport(false); toast('Export cancelled.', false);
};
$('#dlAgain').onclick = () => download('video');

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  const typing = e.target.closest('input,select,textarea,[contenteditable="true"]');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (e.key === 'Escape') {
    if (!$('#export').hidden) return openExport(false);
    if (!$('#details').hidden) return openDetails(false);
    if (preview.classList.contains('picking')) return stopPicking();
    select(null); openSug = null; $$('.sugcard').forEach(c => c.hidden = true); $$('.w.sug.active').forEach(el => el.classList.remove('active'));
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || !$('#export').hidden) return;
  if (e.code === 'Space' && !e.target.closest('button,a,[role="button"]')) { e.preventDefault(); return setPlaying(!playing); }
  if (e.key.toLowerCase() === 's') return split();
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (cutSelection()) return e.preventDefault();
    if (selected && !e.target.closest('#transcript')) { e.preventDefault(); deleteSelected(); }
  }
});
$$('.switch').forEach(s => s.addEventListener('keydown', e => { if (e.key === ' ') e.stopPropagation(); }));

// ---------- start ----------
async function load() {
  let p;
  try { const r = await api(''); if (r.status === 401) return location.href = '/login'; if (r.status === 404) return location.href = '/'; p = await r.json(); }
  catch (e) { return setTimeout(load, 3000); }
  details = { title: p.title, description: p.description || '' }; showDetails();
  $('#recordMore').href = `/record?project=${pid}`;
  $('#tcardDate').textContent = new Date((p.created_at || Date.now() / 1000) * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  $('#detAgain').disabled = true;
  if (p.state === 'failed') { $('#transcriptReady').hidden = true; $('#making').hidden = true; $('#noTranscript').hidden = false; return; }
  const usableNow = p.timeline && (p.state === 'ready' || (p.steps || {}).assemble);
  if (!usableNow) {
    $('#transcriptReady').hidden = true; $('#noTranscript').hidden = true; $('#making').hidden = false;
    const names = { prepare: 'Preparing the video and transcript', assemble: 'Joining your clips', silences: 'Finding pauses', fillers: 'Finding filler words', cuts: 'Looking for mistakes' };
    const order = Object.keys(names), done = order.filter(k => (p.steps || {})[k]).length;
    $('#makingTitle').textContent = names[order[Math.min(done, order.length - 1)]];
    $('#makingBar').style.width = Math.max(4, Math.round(done / order.length * 100)) + '%';
    return setTimeout(load, 2500);
  }
  P = p; $('#making').hidden = true; $('#noTranscript').hidden = true; $('#transcriptReady').hidden = false;
  E = freshEdit(p.title && p.title !== 'Untitled video');
  if (p.edit) {
    const same = Math.abs((p.edit.for_duration || 0) - p.timeline.duration) < 0.05;
    for (const k of Object.keys(E)) if (p.edit[k] !== undefined && (same || !TIME_BOUND.includes(k))) E[k] = p.edit[k];
    if (p.edit.intro === undefined) E.intro.on = false;   // videos edited before cards existed stay as they were
  }
  if (p.timeline.screen) { screenV.src = `/api/projects/${pid}/media/screen_all.mp4`; $('#zw').style.setProperty('--ar', `${p.timeline.screen.w}/${p.timeline.screen.h}`); }
  if (p.timeline.cam) camV.src = `/api/projects/${pid}/media/cam_all.mp4`;
  $('#loudness').textContent = p.audio && p.audio.loudness_before != null ? `Volume before: ${p.audio.loudness_before} LUFS. After: ${p.audio.loudness_after} LUFS. YouTube's level is −14.` : '';
  if (p.audio && p.audio.quiet_microphone) $('#loudness').textContent = 'Your microphone was very quiet in this recording, so LOOT turned it up. Moving closer to the microphone will sound better.';
  if (p.audio && p.audio.note) $('#loudness').textContent = p.audio.note;
  $('#detAgain').disabled = !p.words.length;
  recompute(); renderAll(); syncHistory(); seek(firstKept()); loadPeaks(); $('#savedWords').textContent = 'All changes saved';
  if (p.export && (p.export.state === 'queued' || p.export.state === 'rendering')) { setExporting(true, p.export.pct || 0); watchExport(false); }
  if (p.state !== 'ready') { $('#tipExtra').textContent = ' LOOT is still looking for pauses and mistakes. They will appear here in a moment.'; setTimeout(loadRest, 2000); }
  else if (!p.suggestions.length && p.suggestions_note && /API key/.test(p.suggestions_note)) $('#tipExtra').textContent = ' Mistake suggestions are off because the server has no Claude key.';
}
async function loadRest() {
  let p; try { p = await (await api('')).json(); } catch (e) { return setTimeout(loadRest, 3000); }
  if (p.state !== 'ready' && p.state !== 'failed') return setTimeout(loadRest, 2000);
  P.silences = p.silences; P.fillers = p.fillers; P.suggestions = p.suggestions; P.state = p.state;
  $('#tipExtra').textContent = '';
  // A title and description written while the editor was open: use them unless she already typed her own.
  if (details.title === 'Untitled video' && p.title !== 'Untitled video') { details = { title: p.title, description: p.description || '' }; showDetails(); }
  recompute(); renderAll();
}
$('#retry').onclick = async () => { await api('/process', { method: 'POST' }); load(); };
window.addEventListener('offline', () => { $('#offline').hidden = false; $('#exportBtn').disabled = true; });
window.addEventListener('online', () => { $('#offline').hidden = true; $('#exportBtn').disabled = false; if (E) save(); });
$('#offClose').onclick = () => $('#offline').hidden = true;
window.addEventListener('resize', () => { const z = selected && selected.type === 'zoom' && preview.classList.contains('picking') ? E.zooms.find(x => x.id === selected.id) : null; if (z) placeTarget(z); });
load();
