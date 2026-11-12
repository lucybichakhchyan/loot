// LOOT editor: cut the video by editing its transcript, set how it looks, and export.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pid = location.pathname.split('/').pop();
const api = (path, opt) => fetch(`/api/projects/${pid}${path}`, opt);
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const preview = $('#preview'), audio = $('#master'), screenV = $('#screenV'), camV = $('#camV'), title = $('#docTitle'), zin = $('#zin'), olayer = $('#olayer');
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
let selected = null;          // {type:'clip'|'zoom'|'layout'|'blur'|'over', ...} on the timeline
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
// A change that is already on screen: remembered for undo, but nothing is redrawn now (a redraw would swallow the click that ended it).
function noted(before, label) {
  const after = JSON.stringify(E);
  past.push({ label, doIt: () => { E = JSON.parse(after); refresh(); }, undoIt: () => { E = JSON.parse(before); refresh(); } });
  future.length = 0; syncHistory(); save();
}

function freshEdit(titled, b = {}) {
  return { layout: 'bubble', bg: b.background || 'glow', captions: { on: true, style: b.caption_style || '' }, name: { on: b.show_name !== false }, clean: true, mirror: true,
    fillersOn: true, pausesOn: true, wordCuts: [], restored: [], sug: {}, splits: [], segCuts: [], trims: {},
    layouts: [], zooms: [], blurs: [], overlays: [], crop: null, transition: 'smooth', chapters: null, chInDesc: true, fixes: {}, intro: { on: !!titled && b.intro_on !== false }, outro: { on: !!b.outro_on, line: b.closing_line || 'Thanks for watching.' } };
}
// The look that comes from Brand settings: name, highlight color, headline font, logo and background colors.
const OLD_BG = { charcoal: '#1A1A1A', purple: '#2D253A', offwhite: '#F6F6F4', bright: '#8A2BE2' };
const bgCss = k => (!k || k === 'glow') ? BG.glow : (OLD_BG[k] || k);
function applyBrand(b) {
  $('#nameMark').textContent = b.name || ''; $$('.vcard span').forEach(x => { x.textContent = b.name || ''; });
  preview.style.setProperty('--hi', b.highlight || '#AB8CF0');
  preview.classList.toggle('sans', b.headline_font === 'sans'); preview.classList.toggle('nohi', b.highlight_word === false);
  if (b.has_logo) $$('#ecard img, .tile .cam img').forEach(i => { i.src = '/api/brand/logo'; });
  const colors = ['glow', ...(b.colors || Object.values(OLD_BG))];
  $('#bgs').innerHTML = colors.map(c => `<button class="sw" aria-pressed="false" aria-label="${c === 'glow' ? 'Violet glow' : c}" data-bg="${c}" style="background:${c === 'glow' ? 'radial-gradient(120% 90% at 80% 10%,#3a2a55,#141118)' : c}"></button>`).join('');
  // The swatches are rebuilt from Brand settings, so their clicks are wired here, after they exist.
  $$('#bgs .sw').forEach(o => { o.onclick = () => change(() => { E.bg = o.dataset.bg; }, 'Background changed.'); });
}
const TIME_BOUND = ['wordCuts', 'restored', 'sug', 'splits', 'segCuts', 'trims', 'layouts', 'zooms', 'blurs', 'overlays', 'chapters', 'fixes'];

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
// Smooth fades out, switches, and fades in, in 0.2 seconds as the export does. Cut switches at once.
let fadeTo = null, fadeTimer = null;
function setLayout(v) {
  if (preview.dataset.layout === v && !fadeTo) return;
  if (preview.classList.contains('cut') || !playing) { clearTimeout(fadeTimer); fadeTimer = fadeTo = null; preview.classList.remove('fadeout'); preview.dataset.layout = v; return; }
  fadeTo = v; if (fadeTimer) return;
  preview.classList.add('fadeout');
  fadeTimer = setTimeout(() => { preview.dataset.layout = fadeTo; fadeTo = fadeTimer = null; preview.classList.remove('fadeout'); }, 100);
}
function showTime(t) {
  const o = outTime(t), total = outTotal();
  $('#tc').textContent = fmt(o); $('#total').textContent = fmt(total);
  $('#playhead').style.left = (t / P.timeline.duration * 100) + '%'; $('#tracks').setAttribute('aria-valuenow', Math.round(t));
  if (playing) keepPlayheadInView();
  markNow(t);
  const layout = layoutAt(t); if (!preview.classList.contains('cropping')) setLayout(layout);
  // Zoom: scale the screen around the chosen spot while the playhead is inside a zoom.
  // While she is choosing the spot or cropping, the screen is shown without the zoom.
  const still = preview.classList.contains('picking') || preview.classList.contains('cropping');
  const z = still ? null : E.zooms.find(z => t >= z.start && t < z.start + z.len - 0.4);
  if (z) { const c = cropNow(); zin.style.transformOrigin = `${(c.l + z.x * (1 - c.l - c.r)) * 100}% ${(c.t + z.y * (1 - c.t - c.b)) * 100}%`; }
  zin.style.transform = z ? `scale(${z.scale})` : '';
  showExtras(t);
  // Cards cover the first 3 and the last 5 seconds of the finished video.
  const cut = inRemoved(t) >= 0;
  const intro = E.intro.on && !cut && o < INTRO, outro = E.outro.on && !cut && o > total - OUTRO && total > INTRO + OUTRO;
  $('#tcard').hidden = !intro; $('#ecard').hidden = !outro || intro;
  const cap = $('#cap');
  const c = E.captions.on && !cut && !intro && !outro ? chunks.find(c => o >= c[0].start && o <= c[c.length - 1].end + 0.15) : null;
  if (!c) { cap.style.display = 'none'; return; }
  let active = 0; c.forEach((w, i) => { if (o >= w.start) active = i; });
  const html = c.map((w, i) => i === active && E.captions.style !== 'plain' && (P.brand || {}).highlight_word !== false ? `<em>${esc(w.w)}</em>` : esc(w.w)).join(' ');
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
  const tiny = len => (len / D < 0.06 ? ' tiny' : ''), isSel = id => (selected && selected.id === id ? ' selected' : '');
  $('#blurTrack').innerHTML = E.blurs.map(b => `<button class="blk blurb${tiny(b.len)}${isSel(b.id)}" style="left:${pct(b.start)};width:max(14px, ${pct(b.len)})" data-blur-id="${b.id}" title="Blur for ${Math.round(b.len)} seconds">Blur</button>`).join('');
  $('#overTrack').innerHTML = E.overlays.map(o => { const label = o.kind === 'text' ? (o.text || 'Text') : 'Image'; return `<button class="blk overb${tiny(o.len)}${isSel(o.id)}" style="left:${pct(o.start)};width:max(14px, ${pct(o.len)})" data-over-id="${o.id}" title="${esc(label)}">${esc(label)}</button>`; }).join('');
  // The Blur and Overlays rows only show once they hold something.
  [['#blurTrack', 'blur', E.blurs], ['#overTrack', 'over', E.overlays]].forEach(([id, k, list]) => { $(id).hidden = !list.length; $(`.tlabels [data-for="${k}"]`).hidden = !list.length; });
  $('#capchips').innerHTML = E.captions.on ? chunks.slice(0, 80).map(c => `<span>${esc(c.map(w => w.w).join(' '))}</span>`).join('') : '';
  const seg = selected && selected.type === 'clip' ? segments().find(s => s.key === selected.key) : null;
  $('#delBtn').disabled = !selected; $('#delBtn span').textContent = seg && seg.removed ? 'Bring back' : 'Delete';
  $('#addZoom').disabled = !has().screen; $('#addLayout').disabled = !(has().screen && has().cam);
  $('#addBlur').disabled = !has().screen; $('#cropBtn').disabled = !has().screen;
  placePops();
}
// A settings pop-over sits just above the timeline, over the block it belongs to. It is placed on the window,
// because the timeline scrolls sideways and would cut it off.
function popAt(pop, x) {
  const tr = $('#tracks').getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.left = clamp(tr.left + x.start / P.timeline.duration * tr.width - 100, 8, Math.max(8, innerWidth - 268)) + 'px';
  pop.style.bottom = (innerHeight - tr.top - 12) + 'px';
}
function placePops() {
  const z = selected && selected.type === 'zoom' ? E.zooms.find(x => x.id === selected.id) : null;
  const l = selected && selected.type === 'layout' ? E.layouts.find(x => x.id === selected.id) : null;
  const zp = $('#zpop'), lp = $('#lpop');
  zp.hidden = !z; lp.hidden = !l;
  if (z) { popAt(zp, z); $('#zRange').value = z.scale; $('#zVal').textContent = z.scale + '×'; $('#zLen').value = z.len; $('#zLenVal').textContent = z.len + (z.len === 1 ? ' second' : ' seconds'); }
  if (l) { popAt(lp, l); $$('#lChoices button').forEach(b => b.setAttribute('aria-pressed', b.dataset.l === l.layout)); $('#lLen').value = Math.round(l.len); $('#lLenVal').textContent = Math.round(l.len) + ' seconds'; }
  const b = selected && selected.type === 'blur' ? E.blurs.find(x => x.id === selected.id) : null;
  const o = selected && selected.type === 'over' ? E.overlays.find(x => x.id === selected.id) : null;
  const bp = $('#bpop'), op = $('#opop');
  bp.hidden = !b; op.hidden = !o;
  if (b) { popAt(bp, b); $('#bLen').max = Math.max(300, Math.ceil(P.timeline.duration)); $('#bLen').value = Math.round(b.len); $('#bLenVal').textContent = Math.round(b.len) + ' seconds'; }
  if (o) {
    popAt(op, o); const isT = o.kind === 'text';
    $('#oTitle').textContent = isT ? 'Text on the video' : 'Image on the video';
    $('#oHelp').textContent = isT ? 'Type on the video to change the words. Drag to move it.' : 'Drag the image to move it.';
    $('#oLookRow').hidden = !isT; $('#oReplace').hidden = isT;
    $$('#oSize button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === o.size)); $$('#oLook button').forEach(x => x.setAttribute('aria-pressed', x.dataset.v === o.look));
    $('#oLen').value = Math.round(o.len); $('#oLenVal').textContent = Math.round(o.len) + ' seconds';
  }
  // A selected zoom is ready for its spot: click the video to choose where it points.
  if (z) { preview.classList.add('picking'); zin.style.transform = ''; placeTarget(z); } else stopPicking();
  $$('.zpop input[type=range]').forEach(fillRange);
  showExtras(audio.currentTime || 0);
}
// Sliders show how far they are filled.
function fillRange(r) { r.style.setProperty('--val', ((r.value - r.min) / (r.max - r.min) * 100) + '%'); }
document.addEventListener('input', e => { if (e.target.type === 'range') fillRange(e.target); });
fillRange($('#tzoom'));
function select(s) { selected = s; renderTimeline(); }
$('#tracks').addEventListener('click', e => {
  if (e.target.closest('.zpop') || dragged) { dragged = false; return; }
  const r = $('#tracks').getBoundingClientRect(); seek((e.clientX - r.left) / r.width * P.timeline.duration);
  const clip = e.target.closest('.blk.clip'), zoom = e.target.closest('[data-zoom-id]'), lay = e.target.closest('[data-layout-id]'), blur = e.target.closest('[data-blur-id]'), over = e.target.closest('[data-over-id]');
  select(clip ? { type: 'clip', key: clip.dataset.key } : zoom ? { type: 'zoom', id: zoom.dataset.zoomId } : lay ? { type: 'layout', id: lay.dataset.layoutId }
    : blur ? { type: 'blur', id: blur.dataset.blurId } : over ? { type: 'over', id: over.dataset.overId } : null);
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
  if (s.type === 'blur') { selected = null; return change(() => E.blurs = E.blurs.filter(z => z.id !== s.id), 'Blur removed.'); }
  if (s.type === 'over') { const o = E.overlays.find(z => z.id === s.id); selected = null; return change(() => E.overlays = E.overlays.filter(z => z.id !== s.id), o && o.kind === 'image' ? 'Image removed.' : 'Text removed.'); }
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
function stopPicking() { preview.classList.remove('picking'); $('#target').classList.remove('show'); }
function placeTarget(z) {
  const f = preview.getBoundingClientRect(), v = $('#zw').getBoundingClientRect(), tg = $('#target');
  tg.style.left = ((v.left - f.left + z.x * v.width) / f.width * 100) + '%'; tg.style.top = ((v.top - f.top + z.y * v.height) / f.height * 100) + '%'; tg.classList.add('show');
}
preview.addEventListener('click', e => {
  if (!preview.classList.contains('picking') || !selected) return;
  const v = $('#zw').getBoundingClientRect(), x = clamp((e.clientX - v.left) / v.width, 0, 1), y = clamp((e.clientY - v.top) / v.height, 0, 1);
  editZoom(z => { z.x = +x.toFixed(3); z.y = +y.toFixed(3); }, 'Zoom spot changed.');
  toast('The zoom will point here.', false);
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

// The Add menu: everything is added at the playhead.
function closeAdd() { $('#addMenu').hidden = true; $('#addBtn').setAttribute('aria-expanded', 'false'); }
$('#addBtn').onclick = e => {
  e.stopPropagation(); const open = $('#addMenu').hidden; $('#addMenu').hidden = !open; $('#addBtn').setAttribute('aria-expanded', open);
  if (open) ($('#addMenu button:not([disabled])') || $('#addBtn')).focus();
};
$('#addMenu').addEventListener('click', closeAdd);
$('#addMenu').addEventListener('keydown', e => {
  const it = $$('#addMenu button:not([disabled])'), i = it.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); it[(i + 1) % it.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); it[(i - 1 + it.length) % it.length].focus(); }
  if (e.key === 'Escape') { e.stopPropagation(); closeAdd(); $('#addBtn').focus(); }
});
document.addEventListener('click', e => { if (!$('#addMenu').hidden && !e.target.closest('#addMenu')) closeAdd(); });

// ---------- blur, text and images on the video ----------
// A blur belongs to the screen recording, so it stays on the same detail in every layout and under a zoom.
// Text and images belong to the whole picture.
const cropNow = () => (preview.classList.contains('cropping') || !E || !E.crop ? { t: 0, r: 0, b: 0, l: 0 } : E.crop);
function renderExtras() {
  $$('.bbox', zin).forEach(x => x.remove()); olayer.innerHTML = '';
  E.blurs.forEach(b => {
    const el = document.createElement('div'); el.className = 'bbox'; el.dataset.id = b.id;
    Object.assign(el.style, { left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%' }); zin.appendChild(el);
  });
  E.overlays.forEach(o => {
    const el = document.createElement(o.kind === 'text' ? 'div' : 'img');
    if (o.kind === 'text') { el.className = `otext ${o.size} ${o.look}`; el.contentEditable = 'plaintext-only'; el.spellcheck = false; el.textContent = o.text; wireText(el); }
    else { el.className = `oimg ${o.size}`; el.src = `/api/projects/${pid}/overlay/${o.file}`; el.alt = ''; el.draggable = false; }
    el.dataset.id = o.id; el.style.left = o.x * 100 + '%'; el.style.top = o.y * 100 + '%'; olayer.appendChild(el);
  });
  showExtras(audio.currentTime || 0);
}
// Each one shows while the playhead is inside it, or while it is selected.
function showExtras(t) {
  if (!E) return;
  const sel = selected && (selected.type === 'blur' || selected.type === 'over') ? selected.id : null, cut = inRemoved(t) >= 0;
  $$('.bbox[data-id]', zin).concat($$('[data-id]', olayer)).forEach(el => {
    const x = E.blurs.find(b => b.id === el.dataset.id) || E.overlays.find(o => o.id === el.dataset.id);
    const on = !!x && ((t >= x.start && t < x.start + x.len && !cut) || sel === x.id);
    if (el.hidden === on) el.hidden = !on;
    el.classList.toggle('sel', sel === el.dataset.id);
  });
}
// Text is typed straight onto the video. The words are saved as she types, and remembered for undo when she leaves the box.
function wireText(el) {
  let before = null, orig = '';
  const cur = () => E.overlays.find(x => x.id === el.dataset.id);
  el.addEventListener('focus', () => { const it = cur(); if (it) { before = JSON.stringify(E); orig = it.text; } });
  el.addEventListener('input', () => {
    const it = cur(); if (!it) return;
    it.text = el.textContent.replace(/\s+/g, ' ').slice(0, 120);
    const blk = $(`[data-over-id="${it.id}"]`); if (blk) { blk.textContent = it.text || 'Text'; blk.title = it.text; }
    save();
  });
  el.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); el.blur(); } });
  el.addEventListener('blur', () => {
    const it = cur(); if (!it || before === null) return;
    if (!it.text.trim()) { it.text = orig; el.textContent = orig; const blk = $(`[data-over-id="${it.id}"]`); if (blk) blk.textContent = orig; save(); }
    else if (it.text !== orig) noted(before, 'Text changed.');
    before = null;
  });
}
const startAt = () => Math.round(audio.currentTime * 10) / 10;
const lenFrom = (t, want) => Math.max(2, Math.min(want, Math.round(P.timeline.duration - t)));
$('#addText').onclick = () => {
  const t = startAt(), o = { id: uid(), kind: 'text', start: t, len: lenFrom(t, 6), x: 0.5, y: 0.28, size: 'm', look: 'plain', text: 'Type here' };
  setPlaying(false); change(() => E.overlays.push(o), 'Text added at ' + fmt(t) + '.'); select({ type: 'over', id: o.id });
  const el = $(`.otext[data-id="${o.id}"]`, olayer); if (el) { el.focus(); document.getSelection().selectAllChildren(el); }
};
// Image: pick a file. It lands in the top right corner and can be dragged from there.
let imgReplace = null;
$('#addImage').onclick = () => { imgReplace = null; $('#imgFile').click(); };
$('#oReplace').onclick = () => { imgReplace = selected ? selected.id : null; $('#imgFile').click(); };
$('#imgFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const body = new FormData(); body.append('file', f);
  let r; try { r = await api('/overlay', { method: 'POST', body }); } catch (err) { return toast("The image couldn't be added. Try again.", false); }
  if (!r.ok) { let why = ''; try { why = (await r.json()).detail; } catch (err) { /* no reason given */ } return toast(typeof why === 'string' && why ? why : "The image couldn't be added. Try again.", false); }
  const file = (await r.json()).file;
  if (imgReplace) { const id = imgReplace; imgReplace = null; return change(() => { const o = E.overlays.find(x => x.id === id); if (o) o.file = file; }, 'Image replaced.'); }
  const t = startAt(), o = { id: uid(), kind: 'image', start: t, len: lenFrom(t, 6), x: 0.8, y: 0.24, size: 'm', file };
  setPlaying(false); change(() => E.overlays.push(o), 'Image added at ' + fmt(t) + '.'); select({ type: 'over', id: o.id });
};
const editOver = (fn, label) => { const id = selected.id; change(() => fn(E.overlays.find(o => o.id === id)), label, true); };
const editBlur = (fn, label) => { const id = selected.id; change(() => fn(E.blurs.find(o => o.id === id)), label, true); };
$('#oSize').addEventListener('click', e => { const b = e.target.closest('button'); if (b && selected) editOver(o => o.size = b.dataset.v, 'Size changed.'); });
$('#oLook').addEventListener('click', e => { const b = e.target.closest('button'); if (b && selected) editOver(o => o.look = b.dataset.v, 'Look changed.'); });
$('#oLen').onchange = e => editOver(o => o.len = +e.target.value, 'Length changed.');
$('#oLen').oninput = e => { $('#oLenVal').textContent = e.target.value + ' seconds'; };
$('#bLen').onchange = e => editBlur(b => b.len = +e.target.value, 'Blur length changed.');
$('#bLen').oninput = e => { $('#bLenVal').textContent = e.target.value + ' seconds'; };
$('#oDel').onclick = $('#bDel').onclick = deleteSelected; $('#oDone').onclick = $('#bDone').onclick = () => select(null);

// Blur: choose Add, then Blur, then drag across the part of the screen recording to hide.
let draw = null;
function startDraw(redoId) {
  if (layoutAt(audio.currentTime) === 'cam') return toast('The screen recording is not showing at this point. Move the playhead to a part that shows it, then add the blur.', false);
  setPlaying(false); if (!redoId) select(null);
  preview.classList.add('drawing'); draw = { redoId };
}
function stopDraw() { preview.classList.remove('drawing'); if (draw && draw.box) draw.box.remove(); draw = null; }
$('#addBlur').onclick = () => startDraw(null);
$('#drawCancel').onclick = e => { e.stopPropagation(); stopDraw(); };
$('#bRedo').onclick = () => { if (selected && selected.type === 'blur') startDraw(selected.id); };
preview.addEventListener('pointerdown', e => {
  if (!draw || e.target.closest('.modehint')) return;
  e.preventDefault(); const box = document.createElement('div'); box.className = 'bbox draft'; olayer.appendChild(box);
  Object.assign(draw, { box, r: preview.getBoundingClientRect(), x: e.clientX, y: e.clientY, x2: e.clientX, y2: e.clientY }); preview.setPointerCapture(e.pointerId);
});
preview.addEventListener('pointermove', e => {
  if (!draw || !draw.box) return;
  const r = draw.r; draw.x2 = clamp(e.clientX, r.left, r.right); draw.y2 = clamp(e.clientY, r.top, r.bottom);
  Object.assign(draw.box.style, { left: (Math.min(draw.x, draw.x2) - r.left) / r.width * 100 + '%', top: (Math.min(draw.y, draw.y2) - r.top) / r.height * 100 + '%',
    width: Math.abs(draw.x2 - draw.x) / r.width * 100 + '%', height: Math.abs(draw.y2 - draw.y) / r.height * 100 + '%' });
});
preview.addEventListener('pointerup', () => {
  if (!draw || !draw.box) return;
  const { redoId, x, y, x2, y2 } = draw; stopDraw();
  // Keep the part of the drag that lies on the screen recording, as fractions of the whole recording.
  const v = $('#zw').getBoundingClientRect(), z = zin.getBoundingClientRect();
  const l = Math.max(Math.min(x, x2), v.left), r = Math.min(Math.max(x, x2), v.right), top = Math.max(Math.min(y, y2), v.top), bot = Math.min(Math.max(y, y2), v.bottom);
  if (r - l < 8 || bot - top < 8) return toast('Drag across the part of the screen recording you want to hide.', false);
  const area = { x: +((l - z.left) / z.width).toFixed(4), y: +((top - z.top) / z.height).toFixed(4), w: +((r - l) / z.width).toFixed(4), h: +((bot - top) / z.height).toFixed(4) };
  if (redoId) return change(() => { const b = E.blurs.find(i => i.id === redoId); if (b) Object.assign(b, area); }, 'Blur area changed.');
  const t = startAt(), seg = segments().find(c => t >= c.start && t < c.end);
  const b = { id: uid(), start: t, len: Math.max(2, Math.round(((seg ? seg.end : P.timeline.duration) - t) * 10) / 10), ...area };
  change(() => E.blurs.push(b), 'Blur added from ' + fmt(t) + ' to the end of this clip.'); select({ type: 'blur', id: b.id });
});
// Drag a blur, a text or an image to move it.
let mv = null;
function grab(e) {
  const el = e.target.closest('.bbox[data-id],.otext,.oimg'); if (!el || draw) return;
  e.stopPropagation(); const id = el.dataset.id, isBlur = el.classList.contains('bbox');
  if (!selected || selected.id !== id) select({ type: isBlur ? 'blur' : 'over', id });
  mv = { el, id, isBlur, r: (isBlur ? zin : preview).getBoundingClientRect(), x: e.clientX, y: e.clientY, l: parseFloat(el.style.left), t: parseFloat(el.style.top), moved: false };
  el.setPointerCapture(e.pointerId);
}
function drag(e) {
  if (!mv) return;
  const dx = (e.clientX - mv.x) / mv.r.width * 100, dy = (e.clientY - mv.y) / mv.r.height * 100;
  if (Math.abs(dx) + Math.abs(dy) > 0.8) mv.moved = true;
  if (!mv.moved) return;
  const maxX = mv.isBlur ? 100 - parseFloat(mv.el.style.width) : 100, maxY = mv.isBlur ? 100 - parseFloat(mv.el.style.height) : 100;
  mv.el.style.left = clamp(mv.l + dx, 0, maxX) + '%'; mv.el.style.top = clamp(mv.t + dy, 0, maxY) + '%';
}
function drop() {
  if (!mv) return; const m = mv; mv = null; if (!m.moved) return;
  const x = +(parseFloat(m.el.style.left) / 100).toFixed(4), y = +(parseFloat(m.el.style.top) / 100).toFixed(4);
  change(() => { const it = (m.isBlur ? E.blurs : E.overlays).find(i => i.id === m.id); if (it) { it.x = x; it.y = y; } }, m.isBlur ? 'Blur moved.' : 'Moved.', true);
}
[zin, olayer].forEach(n => {
  n.addEventListener('pointerdown', grab); n.addEventListener('pointermove', drag); n.addEventListener('pointerup', drop);
  n.addEventListener('click', e => { if (e.target.closest('.bbox,.otext,.oimg')) e.stopPropagation(); });
});

// ---------- crop the screen recording ----------
// The crop is kept as the share cut from each side. It applies to every clip, and the rest fills the screen's frame.
let cropWork = null, cdrag = null;
const anyCrop = c => !!c && c.t + c.r + c.b + c.l > 0.001;
function applyCrop() {
  const c = cropNow(), cw = 1 - c.l - c.r, ch = 1 - c.t - c.b, sc = P.timeline.screen;
  if (sc) $('#zw').style.setProperty('--ar', `${sc.w * cw}/${sc.h * ch}`);
  Object.assign(zin.style, { width: 100 / cw + '%', height: 100 / ch + '%', left: -c.l / cw * 100 + '%', top: -c.t / ch * 100 + '%' });
  $('#cropState').textContent = anyCrop(E.crop) ? 'The screen recording is cropped' : 'The screen recording is not cropped';
  $('#cropBtn span').textContent = anyCrop(E.crop) ? 'Change crop' : 'Crop';
}
function drawCrop(c) { Object.assign($('#cropBox').style, { top: c.t * 100 + '%', right: c.r * 100 + '%', bottom: c.b * 100 + '%', left: c.l * 100 + '%' }); }
function placeCropArea() {
  const f = preview.getBoundingClientRect(), v = $('#zw').getBoundingClientRect();
  Object.assign($('#cropArea').style, { inset: 'auto', left: (v.left - f.left) / f.width * 100 + '%', top: (v.top - f.top) / f.height * 100 + '%', width: v.width / f.width * 100 + '%', height: v.height / f.height * 100 + '%' });
}
$('#cropBtn').onclick = () => {
  setPlaying(false); select(null); cropWork = { ...(E.crop || { t: 0, r: 0, b: 0, l: 0 }) };
  preview.classList.add('cropping'); preview.dataset.layout = 'screen'; zin.style.transform = '';
  applyCrop(); placeCropArea(); drawCrop(cropWork);
};
function endCrop(keep) {
  if (!cropWork) return;
  const to = keep && anyCrop(cropWork) ? cropWork : null, was = anyCrop(E.crop) ? E.crop : null; cropWork = null; cdrag = null;
  preview.classList.remove('cropping');
  if (keep && JSON.stringify(to) !== JSON.stringify(was)) change(() => { E.crop = to; }, to ? 'Screen recording cropped, on every clip.' : 'Crop removed.');
  else { applyCrop(); showTime(audio.currentTime || 0); }
}
$('#cropDone').onclick = e => { e.stopPropagation(); endCrop(true); };
$('#cropReset').onclick = e => { e.stopPropagation(); cropWork = { t: 0, r: 0, b: 0, l: 0 }; drawCrop(cropWork); };
$('#cropBox').addEventListener('pointerdown', e => { const h = e.target.closest('i'); if (!h || !cropWork) return; e.preventDefault(); cdrag = { c: h.dataset.c, r: $('#cropArea').getBoundingClientRect() }; h.setPointerCapture(e.pointerId); });
$('#cropBox').addEventListener('pointermove', e => {
  if (!cdrag || !cropWork) return;
  const r = cdrag.r, x = clamp((e.clientX - r.left) / r.width, 0, 1), y = clamp((e.clientY - r.top) / r.height, 0, 1), w = cropWork, min = 0.2;
  if (cdrag.c[1] === 'l') w.l = +Math.min(x, 1 - w.r - min).toFixed(4); else w.r = +Math.min(1 - x, 1 - w.l - min).toFixed(4);
  if (cdrag.c[0] === 't') w.t = +Math.min(y, 1 - w.b - min).toFixed(4); else w.b = +Math.min(1 - y, 1 - w.t - min).toFixed(4);
  drawCrop(w);
});
$('#cropBox').addEventListener('pointerup', () => { cdrag = null; });
window.addEventListener('resize', () => { if (cropWork) placeCropArea(); if (selected) placePops(); });
$('.tgrid').addEventListener('scroll', () => { if (selected) placePops(); });
// How the picture gets from one layout to the next: at once, or moving over a fifth of a second.
$('#trans').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.dataset.v === (E.transition || 'smooth')) return;
  change(() => { E.transition = b.dataset.v; }, b.dataset.v === 'cut' ? 'Layout changes now cut.' : 'Layout changes are now smooth.');
});

// Timeline zoom: the tracks get wider than the window and scroll sideways. The playhead stays in view.
$('#tzoom').oninput = e => {
  const tr = $('#tracks'), grid = $('.tgrid'), at = audio.currentTime / P.timeline.duration;
  tr.style.width = (100 + +e.target.value * 7) + '%';
  grid.scrollLeft = Math.max(0, tr.offsetWidth * at - grid.clientWidth / 2);
};
function keepPlayheadInView() {
  const grid = $('.tgrid'), tr = $('#tracks'); if (tr.offsetWidth <= grid.clientWidth) return;
  const x = tr.offsetLeft + tr.offsetWidth * audio.currentTime / P.timeline.duration;
  if (x < grid.scrollLeft + 90 || x > grid.scrollLeft + grid.clientWidth - 30) grid.scrollLeft = Math.max(0, x - grid.clientWidth / 2);
}
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
  preview.style.background = bgCss(E.bg);
  preview.classList.toggle('vertical', P.kind === 'short'); preview.classList.toggle('mirror', E.mirror !== false);
  $$('#layouts .tile').forEach(o => { o.setAttribute('aria-pressed', o.dataset.l === base); o.classList.toggle('dim', (!has().screen && o.dataset.l !== 'cam') || (!has().cam && o.dataset.l !== 'screen')); });
  $$('#bgs .sw').forEach(o => o.setAttribute('aria-pressed', o.dataset.bg === (OLD_BG[E.bg] || E.bg)));
  $$('#capStyles .tile').forEach(o => o.setAttribute('aria-pressed', o.dataset.c === E.captions.style));
  $('#cap').className = 'cap ' + E.captions.style;
  $('#capSwitch').setAttribute('aria-checked', E.captions.on); $('#capStyles').classList.toggle('dim', !E.captions.on);
  $('#nameSwitch').setAttribute('aria-checked', E.name.on); $('#nameMark').style.display = E.name.on ? '' : 'none';
  $('#mirrorSwitch').setAttribute('aria-checked', E.mirror !== false);
  preview.classList.toggle('cut', E.transition === 'cut'); $$('#trans button').forEach(o => o.setAttribute('aria-pressed', o.dataset.v === (E.transition || 'smooth')));
  applyCrop();
  $('#soundSwitch').setAttribute('aria-checked', E.clean); $('#soundBox').classList.toggle('dim', !E.clean);
  $('#introSwitch').setAttribute('aria-checked', E.intro.on); $('#outroSwitch').setAttribute('aria-checked', E.outro.on);
  $('#outroField').hidden = !E.outro.on; if (document.activeElement !== $('#outroText')) $('#outroText').value = E.outro.line;
  $('#ecardLine').textContent = E.outro.line; $('#tcardTitle').textContent = title.textContent.trim() || 'Untitled video';
  const want = `/api/projects/${pid}/media/${E.clean ? 'audio_clean' : 'audio_raw'}.m4a`;
  if (!audio.src.endsWith(want)) { const t = audio.currentTime || 0, was = playing; setPlaying(false); audio.src = want; audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; if (was) setPlaying(true); }, { once: true }); }
}
function renderAll() { renderTranscript(); renderTimeline(); applyStyle(); renderExtras(); renderCh(); showTime(audio.currentTime || 0); }
$$('.ptabs button').forEach(b => b.onclick = () => { $$('.ptabs button').forEach(x => x.setAttribute('aria-selected', x === b)); $('#tab-transcript').hidden = b.dataset.tab !== 'transcript'; $('#tab-style').hidden = b.dataset.tab !== 'style'; hideSel(); });
$$('#layouts .tile').forEach(o => o.onclick = () => change(() => E.layout = o.dataset.l, 'Layout changed.'));
$$('#capStyles .tile').forEach(o => o.onclick = () => change(() => E.captions.style = o.dataset.c, 'Caption style changed.'));
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
$('#outroText').onchange = e => change(() => E.outro.line = e.target.value.trim() || ((P && P.brand && P.brand.closing_line) || 'Thanks for watching.'), 'Closing line changed.', true);
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
document.addEventListener('click', e => { if (!$('#details').hidden && !e.composedPath().includes($('#details'))) openDetails(false); });
$('#detAgain').onclick = async () => {
  const b = $('#detAgain'), old = { ...details }; b.disabled = true; $('#detFrom').textContent = 'Writing another version…';
  try {
    const r = await api('/describe', json('POST', { avoid: old }));
    if (!r.ok) throw new Error((await r.json()).detail || '');
    const fresh = await r.json(), oldCh = E.chapters, newCh = fresh.chapters && fresh.chapters.length ? fresh.chapters : oldCh;
    act('Wrote a new title, description and chapters.', () => { setDetails(fresh); E.chapters = newCh; renderCh(); save(); }, () => { setDetails(old); E.chapters = oldCh; renderCh(); save(); });
    $('#detFrom').textContent = 'LOOT wrote these from your transcript. Edit anything, or ask for another version.';
  } catch (err) { $('#detFrom').textContent = err.message || 'A new version couldn\'t be written. Try again in a moment.'; }
  b.disabled = false;
};
function copy(text, what, btn) {
  copyLater(text).then(ok => {
    if (!ok) return toast(`${what} couldn't be copied here. Open the panel, select the text and press Cmd+C.`, false);
    if (btn) { const was = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = was; }, 1500); }
    toast(what + ' copied.', false);
  });
}
// Chapters for YouTube. Claude writes them with the title and description; her own changes are kept with the edit.
// A chapter remembers its place in the recording, and is shown at the time it has in the finished video.
const chList = () => ((E && E.chapters) || (P && P.chapters) || []).slice().sort((a, b) => a.t - b.t);
const chText = () => chList().map(c => `${fmt(outTime(c.t))} ${c.n}`).join('\n');
const withChapters = () => !!E && E.chInDesc !== false && chList().length > 0;
function renderCh() {
  const list = chList();
  $('#chapters').innerHTML = list.map((c, i) => {
    const at = fmt(outTime(c.t));
    return `<div class="ch"><button class="chtime" data-i="${i}" title="Go to ${at}">${at}</button><input class="input" data-i="${i}" maxlength="60" value="${esc(c.n)}" aria-label="Name of the chapter at ${at}"><button class="iconbtn" data-rm="${i}" aria-label="Remove the chapter at ${at}"><svg class="ic"><use href="/static/assets/icons.svg#x"/></svg></button></div>`;
  }).join('');
  $('#chNote').textContent = !list.length || (list.length >= 3 && outTime(list[0].t) < 0.5) ? '' : 'YouTube needs one at 0:00 and at least three';
  $('#chInDesc').setAttribute('aria-checked', E.chInDesc !== false); $('#chCopy').disabled = !list.length;
}
$('#chapters').addEventListener('click', e => {
  const tm = e.target.closest('.chtime'), rm = e.target.closest('[data-rm]'), list = chList();
  if (tm) seek(list[+tm.dataset.i].t);
  if (rm) { const i = +rm.dataset.rm; change(() => { E.chapters = list.filter((_, n) => n !== i); }, 'Chapter removed.'); }
});
$('#chapters').addEventListener('change', e => {
  const inp = e.target.closest('input'); if (!inp) return;
  const list = chList(), i = +inp.dataset.i, n = inp.value.trim() || 'Chapter', before = JSON.stringify(E);
  if (!list[i] || list[i].n === n) return;
  E.chapters = list.map((c, k) => (k === i ? { ...c, n } : c)); noted(before, 'Chapter renamed.');
});
$('#chAdd').onclick = () => {
  const t = Math.round(audio.currentTime * 10) / 10, list = chList();
  if (list.some(c => Math.abs(c.t - t) < 1)) return toast('There is already a chapter at ' + fmt(outTime(t)) + '.', false);
  change(() => { E.chapters = [...list, { t, n: 'New chapter' }]; }, 'Chapter added at ' + fmt(outTime(t)) + '.', true);
  const inp = $(`#chapters input[data-i="${chList().findIndex(c => c.t === t)}"]`); if (inp) { inp.focus(); inp.select(); }
};
$('#chCopy').onclick = e => copy(chText(), 'Chapters', e.currentTarget);
$('#chInDesc').onclick = () => change(() => { E.chInDesc = E.chInDesc === false; }, '', true);
const descText = () => details.description + (withChapters() ? '\n\n' + chText() : '');
const descWhat = () => (withChapters() ? 'Description with chapters' : 'Description');
$('#detCopyT').onclick = e => copy(details.title, 'Title', e.currentTarget); $('#detCopyD').onclick = e => copy(descText(), descWhat(), e.currentTarget);
$('#doneCopyT').onclick = e => copy(details.title, 'Title', e.currentTarget); $('#doneCopyD').onclick = e => copy(descText(), descWhat(), e.currentTarget);

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
  exView('vSetup'); fillLink(); openExport(true);
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
      setExporting(false); P.exported = true; P.export = s; linkWords(false);
      if (downloadWhenDone) { download('video'); if (s.captions === 'file' && s.has_srt) setTimeout(() => download('captions'), 1200); }
      const name = (details.title.replace(/[^\w\- ]+/g, '').trim() || 'LOOT video') + '.mp4';
      $('#doneNote').textContent = `Saved to your Downloads folder as ${name}. LOOT keeps its own copy for 3 more days, then deletes it.` + (s.loudness_ok === false ? ' The volume came out a little off YouTube\'s level.' : '');
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

// ---------- share link and GIF for email ----------
// A share link plays the exported video, so there has to be an export first. She picks how long the link works.
let share = { on: false };
const lifeDays = () => +$('#linkLife').value;
function linkWords(copied) {
  const d = lifeDays(); let when;
  if (share.on) when = share.until ? `It works until ${share.until}.` : 'It works until you turn it off.';
  else if (!d) when = 'It will work until you turn it off.';
  else { const end = new Date(Date.now() + d * 864e5); when = `It will work for ${d === 1 ? '1 day' : d + ' days'}, until ${end.getDate()} ${end.toLocaleString('en-GB', { month: 'short' })}.`; }
  $('#linkWords').textContent = (copied ? 'Link copied. ' : 'Anyone with the link can watch. ') + when;
  $('#linkPage').href = share.on && share.path ? share.path : '/w/preview';
  // The link plays the exported video, so both buttons wait for the first export.
  const ready = !!(P && P.exported);
  $('#copyLink').disabled = $('#copyGif').disabled = !ready;
  if (!ready) $('#linkWords').textContent = 'Export the video once first. The link plays that export.';
}
// After a click the link itself is always shown, ready to copy again.
// state: 'copied', 'ready' (made, but this browser needs a second click to copy it) or 'refused'.
const LINK_NOTES = { ready: 'The link is ready. Press Copy.', refused: 'Your browser did not allow the copy. The link is selected, so press Cmd+C.' };
function showLink(url, state) {
  $('#linkField').value = url; $('#linkRow').hidden = false;
  $('#linkRefused').hidden = state === 'copied'; $('#linkRefused').textContent = LINK_NOTES[state] || '';
  $('#linkText').textContent = state === 'copied' ? 'Link copied' : 'Copy link';
  if (state === 'ready') $('#linkAgain').focus();
  if (state === 'refused') { $('#linkField').focus(); $('#linkField').select(); }
  linkWords(state === 'copied');
}
// A link that already works is in its field as soon as the dialog opens, so the first click can copy it.
function fillLink() {
  if (share.on && share.path) { $('#linkField').value = location.origin + share.path; $('#linkRow').hidden = false; $('#linkRefused').hidden = true; }
}
async function loadShare() {
  try { const r = await api('/share'); if (r.ok) { share = await r.json(); if (share.on && [0, 1, 7, 30].includes(share.days)) $('#linkLife').value = String(share.days); } } catch (e) { /* the dialog still works */ }
  linkWords(false);
}
// Creates the link, or changes how long it works. Gives back its address, or nothing if it couldn't be made.
async function makeLink() {
  const fail = text => { toast(text, false); return null; };
  if (!navigator.onLine) return fail('You are offline. Sharing works again when you are back online.');
  let r; try { r = await api('/share', json('POST', { days: lifeDays() })); } catch (e) { return fail("The link couldn't be created. Try again."); }
  if (r.status === 409) return fail('Download the video once first. The link plays that export.');
  if (!r.ok) return fail("The link couldn't be created. Try again.");
  share = { ...(await r.json()), on: true };
  return location.origin + share.path;
}
const staleNote = () => ((P.edit && P.export && (P.edit.saved_at || 0) > (P.export.updated_at || 0)) || past.length > 0 ? ' It plays your last export, so export again to share newer edits.' : '');
$('#copyLink').onclick = async () => {
  // A link that already works for the chosen time is copied at once; otherwise the server makes it first.
  const known = share.on && share.path && share.days === lifeDays() ? location.origin + share.path : null;
  const link = known ? Promise.resolve(known) : makeLink();
  const copied = await copyLater(known || link), url = await link; if (!url) return;
  showLink(url, copied ? 'copied' : known ? 'refused' : 'ready');
  if (copied) toast('Link copied.' + staleNote(), false);
};
$('#linkAgain').onclick = async () => { const url = $('#linkField').value, ok = await copyLater(url); showLink(url, ok ? 'copied' : 'refused'); if (ok) toast('Link copied.', false); };
$('#linkField').onfocus = e => e.target.select();
$('#linkLife').onchange = async () => { if (share.on) await makeLink(); linkWords(false); };
// The GIF goes into an email as a picture that opens the share page when clicked.
const gifHtml = u => { const named = details.title && details.title !== 'Untitled video', width = P.kind === 'short' ? 270 : 480;
  return `<a href="${u}"><img src="${u}/gif" alt="${esc(named ? 'Watch the video: ' + details.title : 'Watch the video')}" width="${width}"></a>`; };
let gifReady = null;   // the link whose GIF is made, so a second click can copy it at once
$('#copyGif').onclick = async () => {
  const known = share.on && share.path && share.days === lifeDays() ? location.origin + share.path : null;
  if (known && gifReady === known && copyNow(known, gifHtml(known))) return toast('GIF copied. Paste it into your email.', false);
  const link = known ? Promise.resolve(known) : makeLink();
  const gifMade = link.then(u => { if (!u) throw new Error('no link'); return fetch(`/api/projects/${pid}/gif`).then(r => { if (!r.ok) throw new Error('gif'); return r.blob(); }); });
  gifMade.catch(() => {});
  let copied = true;
  try { await navigator.clipboard.write([new ClipboardItem({
    'text/html': Promise.all([link, gifMade]).then(([u]) => new Blob([gifHtml(u)], { type: 'text/html' })),
    'text/plain': Promise.all([link, gifMade]).then(([u]) => new Blob([u], { type: 'text/plain' })) })]); }
  catch (e) { copied = false; }
  const url = await link; if (!url) return;
  let blob = null; $('#gifText').textContent = 'Making the GIF…';
  try { blob = await gifMade; } catch (e) { /* said below */ }
  $('#gifText').textContent = 'Copy GIF for email';
  if (!blob) return toast("The GIF couldn't be made. Try again in a moment.", false);
  gifReady = url; $('#linkField').value = url; $('#linkRow').hidden = false; $('#linkRefused').hidden = true; linkWords(false);
  if ($('#gifImg').src.startsWith('blob:')) URL.revokeObjectURL($('#gifImg').src);
  $('#gifImg').src = URL.createObjectURL(blob); $('#gifBox').hidden = false;
  if (copied) return toast('GIF copied. Paste it into your email.', false);
  $('#copyGif').focus();
  toast('The GIF is ready. Press Copy GIF for email again to copy it.', false);
};
$('#gifDl').onclick = () => { const a = document.createElement('a'); a.href = `/api/projects/${pid}/gif`; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); toast('GIF saved to your Downloads folder.', false); };

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  const typing = e.target.closest('input,select,textarea,[contenteditable="true"]');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (e.key === 'Escape') {
    if (!$('#export').hidden) return openExport(false);
    if (!$('#details').hidden) return openDetails(false);
    if (preview.classList.contains('cropping')) return endCrop(false);
    if (draw) return stopDraw();
    if (!$('#addMenu').hidden) return closeAdd();
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
  // Shorts are made from wide videos. A video recorded tall is already a short.
  $$('#shortsLink, #shortsLink2').forEach(a => { a.href = `/shorts/${pid}`; a.hidden = p.kind === 'short'; });
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
  applyBrand(p.brand || {});
  E = freshEdit(p.title && p.title !== 'Untitled video', p.brand || {});
  if (p.edit) {
    const same = Math.abs((p.edit.for_duration || 0) - p.timeline.duration) < 0.05;
    for (const k of Object.keys(E)) if (p.edit[k] !== undefined && (same || !TIME_BOUND.includes(k))) E[k] = p.edit[k];
    if (p.edit.intro === undefined) E.intro.on = false;   // videos edited before cards existed stay as they were
  }
  if (p.timeline.screen) { screenV.src = `/api/projects/${pid}/media/screen_all.mp4`; $('#zw').style.setProperty('--ar', `${p.timeline.screen.w}/${p.timeline.screen.h}`); }
  if (p.timeline.cam) camV.src = `/api/projects/${pid}/media/cam_all.mp4`;
  // One plain line that says what was done to the sound.
  const snd = p.audio || {};
  $('#loudness').textContent = snd.note ? snd.note : snd.loudness_before == null ? '' : (snd.quiet_microphone ? 'Your voice was quiet, so LOOT raised it.' : 'The volume was evened out.') + ' Background noise was removed.';
  $('#detAgain').disabled = !p.words.length;
  recompute(); renderAll(); syncHistory(); seek(firstKept()); loadPeaks(); loadShare(); $('#savedWords').textContent = 'All changes saved';
  if (p.export && (p.export.state === 'queued' || p.export.state === 'rendering')) { setExporting(true, p.export.pct || 0); watchExport(false); }
  if (p.state !== 'ready') { $('#tipExtra').textContent = ' LOOT is still looking for pauses and mistakes. They will appear here in a moment.'; setTimeout(loadRest, 2000); }
  else if (!p.suggestions.length && p.suggestions_note && /API key/.test(p.suggestions_note)) $('#tipExtra').textContent = ' Mistake suggestions are off because the server has no Claude key.';
}
async function loadRest() {
  let p; try { p = await (await api('')).json(); } catch (e) { return setTimeout(loadRest, 3000); }
  if (p.state !== 'ready' && p.state !== 'failed') return setTimeout(loadRest, 2000);
  P.silences = p.silences; P.fillers = p.fillers; P.suggestions = p.suggestions; P.state = p.state; P.chapters = p.chapters || [];
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
