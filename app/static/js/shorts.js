// LOOT Shorts: parts of a video that work on their own, to keep, adjust and download.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pid = location.pathname.split('/').pop();
const api = (path, opt) => fetch(`/api/projects/${pid}${path}`, opt);
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ic = n => `<svg class="ic"><use href="/static/assets/icons.svg#${n}"/></svg>`;
const f = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const grid = $('#grid');
let P = null, shorts = [], removed = [], rendering = null;

function toast(text, undo) {
  const t = $('#toast'); $('#toastText').textContent = text; $('#toastUndo').hidden = !undo;
  $('#toastUndo').onclick = () => { undo(); t.hidden = true; };
  t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, undo ? 7000 : 3500);
}
let saveTimer;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => api('/shorts', json('PUT', { shorts })).catch(() => {}), 400); }

// Length on the finished short: the part between start and end, minus anything already cut in the editor.
function cutInside(a, b) { return removed.reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0); }
const lengthOf = s => Math.max(0, Math.round(s.b - s.a - cutInside(s.a, s.b)));
function lenInfo(s) {
  const L = lengthOf(s);
  if (L > 60) return { warn: true, msg: `${L} seconds. Most platforms cap shorts at 60 seconds.` };
  if (L < 30) return { warn: true, msg: `${L} seconds. Shorts under 30 seconds can feel too brief.` };
  return { warn: false, msg: `${L} seconds. A good length.` };
}
function counts() {
  const n = shorts.filter(s => !s.gone && s.kept).length;
  if (!rendering) { $('#dlText').textContent = n ? `Download ${n} ${n === 1 ? 'short' : 'shorts'}` : 'Download shorts'; $('#dl').disabled = !n; }
  $('#none').hidden = !shorts.length || shorts.some(s => !s.gone);
}
function render() {
  stop(); grid.innerHTML = '';
  const D = P.timeline.duration, hasScreen = !!P.timeline.screen, hasCam = !!P.timeline.cam;
  shorts.forEach((s, i) => {
    if (s.gone) return;
    const li = lenInfo(s), d = document.createElement('article'); d.className = 'short' + (s.kept ? ' kept' : ''); d.dataset.i = i;
    const t = (s.a + 0.5).toFixed(2);
    d.innerHTML = `<button class="phone${(P.edit || {}).mirror === false ? '' : ' mirror'}${hasScreen ? '' : ' camonly'}${hasCam ? '' : ' screenonly'}" data-play aria-label="Watch ${esc(s.title)}"><span class="hook">${esc(s.hook)}</span><span class="len ${li.warn ? 'warn' : ''}">${f(lengthOf(s))}</span>
      ${hasScreen ? `<div class="shot"><video muted playsinline preload="metadata" data-v="screen" src="/api/projects/${pid}/media/screen_all.mp4#t=${t}"></video></div>` : ''}
      ${hasCam ? `<div class="cam"><video muted playsinline preload="metadata" data-v="cam" src="/api/projects/${pid}/media/cam_all.mp4#t=${t}"></video></div>` : ''}
      <span class="sub" hidden></span><span class="po"><span>${ic('play').replace('class="ic"', 'class="ic fill"')}</span></span></button>
     <div class="fld"><label for="t${i}">Title</label><input class="input" id="t${i}" data-f="title" maxlength="60" value="${esc(s.title)}"></div>
     <div class="fld"><label for="h${i}">First line on the video</label><input class="input" id="h${i}" data-f="hook" maxlength="60" value="${esc(s.hook)}"></div>
     <p class="why">${esc(s.why || '')}</p>
     <div class="trim">
       <div class="strip"><div class="range" style="left:${s.a / D * 100}%;width:${(s.b - s.a) / D * 100}%"></div></div>
       <div class="tt">
         <div class="nudge"><span>Starts at</span><div class="row"><button data-n="a-" aria-label="Start one second earlier">−</button><output>${f(s.a)}</output><button data-n="a+" aria-label="Start one second later">+</button></div></div>
         <div class="nudge"><span>Ends at</span><div class="row"><button data-n="b-" aria-label="End one second earlier">−</button><output>${f(s.b)}</output><button data-n="b+" aria-label="End one second later">+</button></div></div>
       </div>
       <p class="lenmsg ${li.warn ? 'warn' : ''}">${li.msg}</p>
     </div>
     <div class="acts"><button class="btn keep" data-keep aria-pressed="${!!s.kept}">${s.kept ? ic('check') + 'Kept' : 'Keep'}</button><button class="btn quiet" data-skip>Skip</button></div>`;
    grid.appendChild(d);
  });
  counts();
}

// ---------- watching a short: its part of the video, with its first line and captions ----------
const audio = new Audio(); let playing = null, raf;
function stop() {
  cancelAnimationFrame(raf); audio.pause();
  if (playing) { $$('video', playing.card).forEach(v => v.pause()); const sub = $('.sub', playing.card); if (sub) sub.hidden = true; playing.card.classList.remove('playing'); }
  playing = null;
}
function captionAt(t) {
  const W = P.words; let i = W.findIndex(w => t >= w.start && t <= w.end + 0.25); if (i < 0) return '';
  const from = Math.max(0, i - (i % 3)); return W.slice(from, from + 3).map(w => w.w.replace(/[,.;:]+$/, '')).join(' ');
}
function tick() {
  if (!playing) return;
  let t = audio.currentTime; const s = playing.s;
  const r = removed.find(([x, y]) => t >= x && t < y);
  if (r) { t = r[1]; audio.currentTime = t; $$('video', playing.card).forEach(v => { v.currentTime = t; }); }
  if (t >= s.b || audio.ended) return stop();
  $$('video', playing.card).forEach(v => { if (Math.abs(v.currentTime - t) > 0.3) v.currentTime = t; if (v.paused) v.play().catch(() => {}); });
  const sub = $('.sub', playing.card), text = captionAt(t); sub.hidden = !text; sub.textContent = text;
  raf = requestAnimationFrame(tick);
}
function play(card, s) {
  if (playing && playing.card === card) return stop();
  stop(); playing = { card, s }; card.classList.add('playing');
  const want = `/api/projects/${pid}/media/audio_clean.m4a`;
  const go = () => { audio.currentTime = s.a; $$('video', card).forEach(v => { v.currentTime = s.a; }); audio.play().catch(() => stop()); tick(); };
  if (!audio.src.endsWith(want)) { audio.src = want; audio.addEventListener('loadedmetadata', go, { once: true }); } else go();
}

grid.addEventListener('click', e => {
  const c = e.target.closest('.short'); if (!c) return; const s = shorts[+c.dataset.i];
  if (e.target.closest('[data-keep]')) { s.kept = !s.kept; save(); render(); }
  if (e.target.closest('[data-skip]')) {
    s.gone = true; const was = s.kept; s.kept = false; save(); render();
    toast(`Skipped "${s.title}".`, () => { s.gone = false; s.kept = was; save(); render(); });
  }
  if (e.target.closest('[data-play]')) play(c, s);
  const n = e.target.closest('[data-n]');
  if (n) {
    const k = n.dataset.n, step = k.endsWith('+') ? 1 : -1, key = k[0], v = Math.round((s[key] + step) * 100) / 100;
    if (key === 'a' && v >= s.b - 5) return; if (key === 'b' && v <= s.a + 5) return; if (v < 0 || v > P.timeline.duration) return;
    s[key] = v; save(); render();
    const focus = grid.querySelector(`.short[data-i="${c.dataset.i}"] [data-n="${k}"]`); if (focus) focus.focus();
  }
});
grid.addEventListener('change', e => {
  const inp = e.target.closest('input[data-f]'); if (!inp) return;
  const s = shorts[+inp.closest('.short').dataset.i]; s[inp.dataset.f] = inp.value.trim(); save();
  if (inp.dataset.f === 'hook') inp.closest('.short').querySelector('.phone .hook').textContent = s.hook;
});
$('#bring').onclick = () => { shorts.forEach(s => s.gone = false); save(); render(); };

// ---------- download: each kept short is exported in turn, then saved ----------
function download(s) { const a = document.createElement('a'); a.href = `/api/projects/${pid}/download/short/${s.id}`; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }
$('#dl').onclick = async () => {
  const kept = shorts.filter(s => !s.gone && s.kept); if (!kept.length) return;
  clearTimeout(saveTimer); await api('/shorts', json('PUT', { shorts }));
  const r = await api('/shorts/render', json('POST', { ids: kept.map(s => s.id) }));
  if (!r.ok) return toast("The shorts couldn't be prepared. Try again.", false);
  rendering = { ids: kept.map(s => s.id), done: new Set(), failed: new Set() }; $('#dl').disabled = true;
  toast('Preparing your shorts. They save to your Downloads folder, and LOOT keeps its copies for 3 days.', false);
  watch();
};
function watch() {
  setTimeout(async () => {
    let j; try { j = await (await api('/shorts')).json(); } catch (e) { return watch(); }
    for (const id of rendering.ids) {
      const st = (j.shorts.find(s => s.id === id) || {}).export || {};
      if (st.state === 'done' && !rendering.done.has(id)) { rendering.done.add(id); download(shorts.find(s => s.id === id)); await new Promise(r => setTimeout(r, 900)); }
      if (st.state === 'failed') rendering.failed.add(id);
    }
    const n = rendering.done.size + rendering.failed.size, total = rendering.ids.length;
    if (n < total) { $('#dlText').textContent = `Preparing ${Math.min(n + 1, total)} of ${total}`; return watch(); }
    const failed = rendering.failed.size, ok = rendering.done.size; rendering = null; counts();
    toast(failed ? `${ok} saved. ${failed} couldn't be prepared, so try those again.` : (ok === 1 ? 'Saved 1 short to your Downloads folder.' : `Saved ${ok} shorts to your Downloads folder.`), false);
  }, 2000);
}

async function start() {
  let p;
  try { const r = await api(''); if (r.status === 401) return location.href = '/login'; if (!r.ok) return location.href = '/'; p = await r.json(); }
  catch (e) { return setTimeout(start, 3000); }
  if (!p.timeline) return location.href = `/edit/${pid}`;
  P = p; removed = ((p.edit || {}).removed || []).slice().sort((a, b) => a[0] - b[0]);
  $$('[data-back]').forEach(a => { a.href = `/edit/${pid}`; });
  $('#fromText').textContent = `${p.title}, ${f(p.duration || p.timeline.duration)}`;
  document.title = `Shorts · ${p.title} · LOOT`;
  let j = await (await api('/shorts')).json();
  if (!j.ready) {
    $('#finding').hidden = false; $('#grid').hidden = true; $('#intro').textContent = 'LOOT is looking through your video for parts that work on their own.';
    try { const r = await api('/shorts/suggest', { method: 'POST' }); j = r.ok ? await r.json() : { shorts: [], note: "The shorts couldn't be suggested. Reload the page to try again." }; }
    catch (e) { j = { shorts: [], note: "The shorts couldn't be suggested. Reload the page to try again." }; }
    if (!j.ready && !j.note) j.note = "The shorts couldn't be suggested. Reload the page to try again.";
    $('#finding').hidden = true; $('#grid').hidden = false;
  }
  shorts = j.shorts || [];
  const n = shorts.length;
  $('#intro').textContent = n ? `LOOT found ${n} ${n === 1 ? 'part' : 'parts'} of your video that ${n === 1 ? 'works' : 'work'} on ${n === 1 ? 'its' : 'their'} own. Press Keep on the ones you want, adjust the start and end if you like, then download them.` : (j.note || 'LOOT found no part of this video that works on its own.');
  if (!n) {
    // Nothing to show: either no part stood out, or the search could not run (the note says why).
    const plain = !j.note || /no part of this video/.test(j.note);
    $('#intro').textContent = 'LOOT looked through your video for parts that work on their own.';
    $('#nothingTitle').textContent = plain ? 'No part stood out as a short' : 'No shorts were suggested';
    if (!plain) $('#nothingText').textContent = j.note;
    $('#grid').hidden = true; $('#nothing').hidden = false;
  }
  render();
}
start();
