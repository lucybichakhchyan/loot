"""One-off: turn design/editor.html into app/pages/edit.html (real media, real data, real script).

The page it writes is the source from then on. Run it again only after the editor mockup changes,
and check the result by hand.
"""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
s = (root / "design/editor.html").read_text()
s = s[: s.index("<script>")]  # drop the mock behaviour


def sub(old, new):
    global s
    assert old in s, old[:80]
    s = s.replace(old, new, 1)


def cut(start, end, replace=""):
    """Replace from `start` up to (not including) `end`."""
    global s
    a = s.index(start)
    b = s.index(end, a + len(start))
    s = s[:a] + replace + s[b:]


sub('href="tokens.css"', 'href="/static/tokens.css"')
sub('href="app.css"', 'href="/static/app.css"')
s = s.replace("assets/", "/static/assets/").replace('href="index.html"', 'href="/"')

# ---- top bar ----
sub('aria-label="Video title">How I plan a paid media test on a small budget</span>', 'aria-label="Video title"></span>')
cut('<a class="btn outline" href="shorts.html">', '<button class="exchip" id="exChip"')

# ---- preview: real videos, cards filled from the project ----
cut('<div class="shot">', '<div class="mark" id="nameMark">', '''<div class="shot"><span class="zw" id="zw"><video id="screenV" muted playsinline preload="auto"></video></span></div>
        <div class="cam"><video id="camV" muted playsinline preload="auto"></video></div>
        ''')
sub('<div class="cap" id="cap">write down <em>one</em> question</div>', '<div class="cap" id="cap" style="display:none"></div>\n        <audio id="master" preload="auto"></audio>')
sub('<div class="vcard" id="tcard" hidden><small>12 November 2026</small><b id="tcardTitle">How I plan a paid media test on a small budget</b>',
    '<div class="vcard" id="tcard" hidden><small id="tcardDate"></small><b id="tcardTitle"></b>')
sub('<b id="tcTitle">', '<b id="tcTitle">') if '<b id="tcTitle">' in s else None
sub('<b id="tc">0:14</b> / <span id="total">12:40</span>', '<b id="tc">0:00</b> / <span id="total">0:00</span>')
sub('<select class="select" aria-label="Playback speed"><option>1×</option><option>1.5×</option><option>2×</option></select>',
    '<select class="select" id="speed" aria-label="Playback speed"><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>')

# ---- transcript tab ----
sub('<div class="empty" id="making" hidden>', '<div class="empty" id="making">')
sub("<h2>Writing the transcript</h2>", '<h2 id="makingTitle">Getting your video ready</h2>')
sub("<p>About 1 minute left. You can watch the video and set the style while you wait.</p>",
    "<p>This takes about as long as the video itself. You can leave this page and come back.</p>")
sub('<div class="meter-bar"><i style="width:62%"></i></div>', '<div class="meter-bar"><i id="makingBar" style="width:4%"></i></div>')
sub("<h2>The transcript couldn't be made</h2>", "<h2>This video couldn't be processed</h2>")
sub("<p>The sound may be too quiet, or the server stopped partway. Your recording is safe.</p>", "<p>The server stopped partway. Your recording is safe.</p>")
sub('<a class="btn primary lg" href="editor.html?state=processing">Try again</a>', '<button class="btn primary lg" id="retry">Try again</button>')
cut('<p class="xs">You can still cut the video with Split and Delete on the timeline.</p>', "</div>")
sub('<div id="transcriptReady">', '<div id="transcriptReady" hidden>')
sub('<div class="found" id="found" role="status">', '<div class="found" id="found" role="status" hidden>')
sub('<span class="t" id="foundText"><b id="foundN">4</b> possible mistakes found</span>', '<span class="t" id="foundText"></span>')
sub('<button class="switch" role="switch" aria-checked="true" aria-label="Remove um and uh"></button>', '<button class="switch" role="switch" aria-checked="true" id="chipFillers" aria-label="Remove um and uh"></button>')
sub('<button class="switch" role="switch" aria-checked="true" aria-label="Shorten long pauses"></button>', '<button class="switch" role="switch" aria-checked="true" id="chipPauses" aria-label="Shorten long pauses"></button>')
sub("Click a crossed-out part to bring it back.</p>", 'Click a crossed-out part to bring it back.<span id="tipExtra"></span></p>')
cut('<div class="para"><time>0:00</time>', "<!-- STYLE -->", "</div>\n      </div>\n    </div>\n\n    ")

# ---- style tab ----
for label, key in (("Violet glow", "glow"), ("Charcoal", "charcoal"), ("Deep purple", "purple"), ("Off-white", "offwhite"), ("Bright purple", "bright")):
    s = re.sub(r'(aria-label="%s" )data-bg="[^"]*"' % label, r'\1data-bg="%s"' % key, s)
# Zooming on clicks needs click positions, which LOOT does not record yet. Zooms are added by hand on the timeline.
cut('<div class="sec">\n        <div class="sech"><h3>Zoom in on my clicks</h3>', '<div class="sec">\n        <div class="sech"><h3>Clean up the sound</h3>')
sub("Removes background noise and evens out the volume. Your original recording is kept.",
    "Turns down background noise. The volume is evened out either way, and your original recording is kept.")
sub('<svg class="ic fill"><use href="/static/assets/icons.svg#play"/></svg>Listen</button>', '<svg class="ic fill"><use href="/static/assets/icons.svg#play"/></svg><span id="sampleText">Listen</span></button>')
sub('<div class="wave" id="wave"></div>', '<p class="sub" id="loudness" style="margin:var(--space-3) 0 0"></p>')
sub('<input class="input" id="outroText" value="More at bichakhchyan.com">', '<input class="input" id="outroText" maxlength="60">')
sub('<p class="sub" style="margin:var(--space-3) 0 0">These start from your <a href="brand.html">Brand settings</a>. Changes here only affect this video.</p>',
    '<div class="line"><span>Mirror my camera<br><span class="muted xs">Shows you the way a mirror does. Turn off if text behind you reads backwards.</span></span><button class="switch" role="switch" aria-checked="true" id="mirrorSwitch" aria-label="Mirror my camera"></button></div>\n'
    '        <p class="sub" style="margin:var(--space-3) 0 0">Changes here only affect this video.</p>')

# ---- timeline ----
sub('<a class="btn" href="recorder.html" title="Record another clip for this video">', '<a class="btn" id="recordMore" href="/record" title="Record another clip for this video">')
cut('<div class="zoomctl">', "</div>\n  <div class=\"tgrid\">")
sub('aria-valuemax="760" aria-valuenow="14"', 'aria-valuemax="0" aria-valuenow="0"')
cut('<button class="blk clip" style="left:0%;width:32.7%">', '</div>\n      <div class="track h-thin" id="layoutTrack">')
cut('<button class="blk layoutb"', '</div>\n      <div class="track h-thin" id="zoomTrack">')
cut('<button class="blk zoom" style="left:14.2%', '</div>\n      <div class="track h-thin caps">')
sub('<div class="seg" id="zWhere"><button aria-pressed="true" data-w="follow">Follow my mouse</button><button aria-pressed="false" data-w="fixed">Fixed spot</button></div>',
    '<button class="btn" id="zPickBtn"><svg class="ic"><use href="/static/assets/icons.svg#search"/></svg>Choose where it points</button>')
sub('<div class="playhead" id="playhead" style="left:1.84%"></div>', '<div class="playhead" id="playhead" style="left:0"></div>')

# ---- export dialog: no 4K and no share link yet ----
sub("<option>HD (1080p)</option><option>4K</option><option>Small file (720p)</option>", '<option value="1080">HD (1080p)</option><option value="720">Small file (720p)</option>')
sub("<option>On the video</option><option>As a separate file</option><option>No captions</option>",
    '<option value="burn">On the video</option><option value="file">As a separate file</option><option value="none">No captions</option>')
sub('<small id="dlNote">MP4, about 1.4 GB. It saves to your Downloads folder.</small>', '<small id="dlNote"></small>')
cut('<div class="or" style="margin:var(--space-4) 0">or</div>', '</div>\n\n    <div class="view" id="vProgress" hidden>')
sub('<small id="pNote">About 3 minutes left. You can close this and keep editing. The Export button shows the progress.</small>',
    '<small id="pNote">You can close this and keep editing. The Export button shows the progress.</small>')
sub('<p class="xs" style="margin:0;text-align:center;color:var(--fg-muted)">Saved to your Downloads folder as how-i-plan-a-paid-media-test.mp4. LOOT removed its server copy.</p>',
    '<p class="xs" id="doneNote" style="margin:0;text-align:center;color:var(--fg-muted)"></p>')
cut('<div class="two"><a class="btn outline" href="shorts.html"', '<button class="btn primary lg" id="doneBtn">',
    '<button class="btn outline" id="dlAgain" style="height:40px"><svg class="ic"><use href="/static/assets/icons.svg#download"/></svg>Download again</button>\n        ')

sub("</style>", '''  .pv .shot{background:transparent;border-radius:6px;container-type:size;align-items:center;justify-content:center}
  .zw{display:block;overflow:hidden;border-radius:4px;aspect-ratio:var(--ar,16/9);width:min(100cqw,calc(100cqh * var(--ar,16/9)));flex:none}
  .zw video{display:block;width:100%;height:100%;transition:transform .4s var(--ease)}
  .cam video{width:100%;height:100%;object-fit:cover}
  #preview.mirror .cam video{transform:scaleX(-1)}
  #preview{container-type:size}
  #preview .cap{font-size:max(11px,3.3cqw)}
  #preview .mark{font-size:max(8px,2cqw)}
  .pv .frame.vertical{aspect-ratio:9/16;width:min(100cqw,calc(100cqh * 9 / 16))}
  .frame.vertical .shot{inset:6% 5% 44% 5%}
  .frame.vertical .cam{width:62%;right:19%;bottom:5%}
  .frame.vertical[data-layout="cam"] .cam{width:100%;right:0;bottom:0}
  .frame.vertical .cap{bottom:42%;white-space:normal;width:86%}
  #preview.vertical .cap{font-size:max(11px,6cqw)}
  .w{cursor:pointer;border-radius:3px;padding:1px 0}
  .w:hover{background:rgba(246,246,244,.06)}
  .w.now{background:rgba(171,140,240,.22)}
  .w.cutx.now{background:transparent}
  .pause{cursor:pointer}
  .tile.dim,.dim{opacity:.4;pointer-events:none}
  .blk.clip.removed b{text-decoration:line-through}
  .tbar .btn[disabled]{opacity:.4;cursor:not-allowed}
</style>''')
s += '<script src="/static/js/edit.js"></script>\n</body>\n</html>\n'
(root / "app/pages/edit.html").write_text(s)
print("edit.html", len(s))
