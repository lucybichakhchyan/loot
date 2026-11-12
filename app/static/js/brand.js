// LOOT Brand settings: loads the saved brand, shows every change in the preview at once,
// and saves on its own a moment after the last change.
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pv = $('#pv'), frame = $('#frame');
const GLOW = 'radial-gradient(120% 90% at 80% 10%,#3a2a55 0%,#1d1626 45%,#141118 100%)';
const AVATAR = '/static/assets/avatar-256.png';
const MAX_LOGO = 2 * 1024 * 1024;
const names = { '#1A1A1A': 'Charcoal', '#2D253A': 'Deep purple', '#F6F6F4': 'Off-white', '#8A2BE2': 'Bright purple', '#AB8CF0': 'Soft purple', '#E2C184': 'Warm gold' };
const notes = { video: 'How a wide video looks with your brand', short: 'How a vertical short looks', card: 'The card a video can start with', end: 'The card a video can end with', page: 'What people see when you share a link' };
// Each row of swatches: the setting that holds its colors and the setting that holds the chosen one.
const rows = { bgs: { list: 'colors', pick: 'background' }, accs: { list: 'highlight_colors', pick: 'highlight' }, btns: { list: 'accent_colors', pick: 'accent' } };
const switches = { nameSwitch: 'show_name', wordSwitch: 'highlight_word', introSwitch: 'intro_on', endSwitch: 'outro_on', ctaSwitch: 'cta_show' };
const texts = { name: 'name', endText: 'closing_line', ctaText: 'cta_text', ctaLink: 'cta_link' };

let S = null;          // the settings, in the shape GET /api/brand returns
let mode = 'video';    // which view the preview shows
let logoV = 0;         // bumped when the logo changes, so the browser fetches the new picture

function toast(text, undo, stay) {
  const t = $('#toast'); $('#toastText').textContent = text; $('#toastUndo').hidden = !undo;
  $('#toastUndo').onclick = () => { undo(); t.hidden = true; };
  t.hidden = false; clearTimeout(toast.t); if (!stay) toast.t = setTimeout(() => t.hidden = true, undo ? 6000 : 3000);
}
// Dark text on a light background, the same rule the share page uses for its button.
function isLight(hex) { const n = parseInt(hex.slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150; }

// ---------- the preview ----------
function pageUrl() {
  const p = new URLSearchParams({ acc: S.accent, font: S.headline_font, cta: S.cta_text, showcta: S.cta_show ? '1' : '0', name: S.name, compact: '1' });
  if (S.has_logo) p.set('logo', '1');
  return '/w/preview?' + p;
}
function fitPage() { const w = $('#pagewrap').clientWidth; if (w) $('#page').style.transform = 'scale(' + (w / 1100) + ')'; }
let pageTimer, pageShown = '';
function refreshPage(again) {
  clearTimeout(pageTimer);
  pageTimer = setTimeout(() => {
    if (mode !== 'page' || !S) return;
    const url = pageUrl(); if (url !== pageShown || again) { pageShown = url; $('#page').src = url; }
    fitPage();
  }, 250);
}
function apply() {
  if (!S) return;
  const isCard = mode === 'card' || mode === 'end', isPage = mode === 'page', sans = S.headline_font === 'sans';
  pv.style.setProperty('--bgc', S.background === 'glow' ? GLOW : S.background);
  frame.classList.toggle('light', S.background !== 'glow' && isLight(S.background));
  pv.style.setProperty('--acc', S.highlight);
  pv.style.setProperty('--hf', sans ? '"Inter",sans-serif' : '"Playfair Display",serif');
  pv.style.setProperty('--hstyle', sans ? 'normal' : 'italic'); pv.style.setProperty('--hweight', sans ? '700' : '600');
  frame.hidden = isPage; $('#pagewrap').hidden = !isPage;
  frame.classList.toggle('vertical', mode === 'short');
  $('#shot').hidden = $('#cam').hidden = $('#cap').hidden = isCard; $('#card').hidden = mode !== 'card'; $('#endcard').hidden = mode !== 'end';
  $('#endLine').textContent = S.closing_line || ' ';
  $('#mark').hidden = isCard || !S.show_name;
  $('#mark').textContent = $('#cardName').textContent = $('#endName').textContent = S.name;
  $('#cap').className = 'cap ' + S.caption_style + (S.highlight_word ? '' : ' noword');
  $('#modeNote').textContent = notes[mode];
  refreshPage();
}
function showLogo() { $$('.logo img, #endcard img').forEach(i => i.src = S.has_logo ? '/api/brand/logo?v=' + logoV : AVATAR); }

// ---------- the controls ----------
function drawRow(id) {
  const row = $('#' + id), add = $('.add', row), { list, pick } = rows[id];
  const focused = row.contains(document.activeElement) ? document.activeElement.dataset.v : null;   // keep the keyboard's place
  $$('.sw:not(.add)', row).forEach(s => s.remove());
  (id === 'bgs' ? ['glow', ...S[list]] : S[list]).forEach(c => {
    const sw = document.createElement('button'); sw.className = 'sw'; sw.dataset.v = c;
    sw.setAttribute('aria-pressed', c === S[pick]);
    sw.setAttribute('aria-label', c === 'glow' ? 'Violet glow' : names[c] || 'Your color ' + c);
    sw.style.background = c === 'glow' ? 'radial-gradient(120% 90% at 80% 10%,#3a2a55,#141118)' : c;
    row.insertBefore(sw, add); if (c === focused) sw.focus();
  });
}
// Everything that is not a text box follows the settings, so it is also right after an Undo.
function sync() {
  Object.keys(rows).forEach(drawRow);
  $('#hfont').value = S.headline_font;
  Object.entries(switches).forEach(([id, key]) => $('#' + id).setAttribute('aria-checked', !!S[key]));
  $$('#capStyles .tile').forEach(t => t.setAttribute('aria-pressed', t.dataset.c === S.caption_style));
  $('#endField').classList.toggle('dim', !S.outro_on); $('#ctaFields').classList.toggle('dim', !S.cta_show);
}
function fill() {
  // The link is saved as a full address. The box shows it the short way people type it.
  Object.entries(texts).forEach(([id, key]) => $('#' + id).value = key === 'cta_link' ? S[key].replace(/^https:\/\//, '') : S[key]);
  $('#cardDate').textContent = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  sync(); showLogo();
}
function changed() { sync(); apply(); save(); }

$('#modes').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#modes button').forEach(x => x.setAttribute('aria-pressed', x === b)); mode = b.dataset.m; apply();
});
Object.keys(rows).forEach(id => $('#' + id).addEventListener('click', e => {
  const s = e.target.closest('[data-v]'); if (!s || !S) return;
  S[rows[id].pick] = s.dataset.v; changed();
}));
$('#hfont').onchange = e => { if (!S) return; S.headline_font = e.target.value; changed(); };
$$('#capStyles .tile').forEach(o => o.onclick = () => { if (!S) return; S.caption_style = o.dataset.c; changed(); });
Object.entries(switches).forEach(([id, key]) => $('#' + id).addEventListener('click', () => { if (!S) return; S[key] = !S[key]; changed(); }));
Object.entries(texts).forEach(([id, key]) => $('#' + id).addEventListener('input', e => { if (!S) return; S[key] = e.target.value.trim(); apply(); save(); }));

// The preview follows the section you are editing
$$('.sec[data-pv]').forEach(sec => {
  // A swatch that was just redrawn is no longer on the page, so its section answers for it.
  const go = e => { const m = (e.target.closest('[data-pv]') || sec).dataset.pv, b = $('#modes [data-m="' + m + '"]'); if (b && mode !== m) b.click(); };
  sec.addEventListener('focusin', go); sec.addEventListener('click', go);
});

// "+" opens the color picker and adds that color to its row
const picker = document.createElement('input'); picker.type = 'color'; picker.tabIndex = -1; picker.setAttribute('aria-hidden', 'true');
picker.style.cssText = 'position:fixed;opacity:0;pointer-events:none'; document.body.appendChild(picker);
$$('[data-add]').forEach(b => b.addEventListener('click', () => {
  if (!S) return;
  const { list, pick } = rows[b.dataset.add];
  if (S[pick] !== 'glow') picker.value = S[pick];
  picker.onchange = () => {
    const color = picker.value.toUpperCase(), before = { colors: [...S[list]], chosen: S[pick] };
    const isNew = !S[list].includes(color); if (isNew) S[list].push(color);
    S[pick] = color; changed();
    if (isNew) toast('Color added.', () => { S[list] = before.colors; S[pick] = before.chosen; changed(); });
  };
  picker.click();
}));

// ---------- the logo ----------
async function sendLogo(file) {
  const fd = new FormData(); fd.append('file', file, file.name || 'logo');
  let why = '';
  try {
    const r = await fetch('/api/brand/logo', { method: 'POST', body: fd });
    if (r.status === 401) { location.href = '/login'; return false; }
    if (!r.ok) { why = (await r.json().catch(() => ({}))).detail || ''; throw new Error(); }
    S.has_logo = true; logoV++; showLogo(); refreshPage(true); return true;
  } catch (e) { toast(why || "The logo couldn't be saved. Check your connection and try again."); return false; }
}
async function removeLogo() {
  try {
    const r = await fetch('/api/brand/logo', { method: 'DELETE' }); if (!r.ok) throw new Error();
    S.has_logo = false; logoV++; showLogo(); refreshPage(true);
  } catch (e) { toast("The logo couldn't be changed back. Check your connection and try again."); }
}
$('#replaceLogo').onclick = () => $('#logoFile').click();
$('#logoFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !S) return;
  if (f.size > MAX_LOGO) return toast('That image is too big. Use one under 2 MB.');
  // Keep the logo that is being replaced, so Undo can put it back.
  let before = null, canUndo = !S.has_logo;
  if (S.has_logo) try { const r = await fetch('/api/brand/logo'); if (r.ok) { before = await r.blob(); canUndo = true; } } catch (err) { /* no Undo this time */ }
  if (await sendLogo(f)) toast('Logo replaced.', canUndo ? () => (before ? sendLogo(before) : removeLogo()) : null);
};

// ---------- saving ----------
let saveTimer, saving = false, dirty = false;
function saved(state) {
  $('#savedShort').textContent = state === 'saving' ? 'Saving…' : state === 'failed' ? 'Not saved' : 'Saved';
  $('#savedLong').textContent = state === 'failed' ? 'Not saved' : 'Changes save on their own and apply to new videos';
}
function request(keepalive) {
  const body = { ...S }; delete body.has_logo;   // set by the server
  return fetch('/api/brand', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive });
}
function save() { dirty = true; saved('saving'); clearTimeout(saveTimer); saveTimer = setTimeout(push, 500); }
async function push() {
  if (!S || !dirty) return;
  if (saving) return save();      // one save at a time, so an older one never lands on top of a newer one
  saving = true; dirty = false;
  let why = '';
  try {
    const r = await request(false);
    if (r.status === 401) return location.href = '/login';
    if (!r.ok) { why = (await r.json().catch(() => ({}))).detail || ''; throw new Error(); }
    if (!dirty) saved('saved');
  } catch (e) { dirty = true; saved('failed'); toast(why || "Your changes couldn't be saved. Check your connection and try again."); }
  finally { saving = false; }
}
window.addEventListener('online', () => { if (dirty) save(); });
// Leaving the page inside the short wait still saves the last change.
window.addEventListener('pagehide', () => { if (S && dirty) { clearTimeout(saveTimer); dirty = false; request(true).catch(() => {}); } });

async function load() {
  try {
    const r = await fetch('/api/brand'); if (r.status === 401) return location.href = '/login';
    if (!r.ok) throw new Error();
    S = await r.json(); fill(); apply();
  } catch (e) {
    // Without the saved settings, editing would save the starting values on top of them.
    $('.panel').classList.add('dim');
    toast("Your brand settings couldn't be loaded. Check your connection and reload the page.", null, true);
  }
}
new ResizeObserver(fitPage).observe(pv);
load();
