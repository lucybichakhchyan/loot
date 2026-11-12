"""One-off: turn design/editor.html into app/pages/edit.html (real media, real data, real script)."""
import pathlib, re
root = pathlib.Path(__file__).resolve().parent.parent
s = (root / "design/editor.html").read_text()
s = s[: s.index("<script>")]
def sub(old, new):
    global s
    assert old in s, old[:70]
    s = s.replace(old, new, 1)
def cut(start, end, keep_end=True, replace=""):
    """Remove from `start` up to `end` (keeping `end` itself when keep_end)."""
    global s
    a = s.index(start); b = s.index(end, a + len(start))
    s = s[:a] + replace + s[b if keep_end else b + len(end):]
sub('href="tokens.css"', 'href="/static/tokens.css"'); sub('href="app.css"', 'href="/static/app.css"')
s = s.replace('assets/', '/static/assets/').replace('href="index.html"', 'href="/"')
# top bar
cut('<a class="btn outline" href="shorts.html">', '<button class="btn primary" id="exportBtn">')
sub('<button class="iconbtn" title="Redo" aria-label="Redo" disabled>', '<button class="iconbtn" id="redo" title="Redo" aria-label="Redo" disabled>')
sub('aria-label="Video title">How I plan a paid media test on a small budget</span>', 'aria-label="Video title"></span>')
# preview
cut('<div class="shot">', '<div class="mark-name mark"', replace='''<div class="shot"><video id="screenV" muted playsinline preload="auto"></video></div>
        <div class="cam"><video id="camV" muted playsinline preload="auto"></video></div>
        ''')
sub('<div class="cap" id="cap">write down <em>one</em> question</div>', '<div class="cap" id="cap" style="display:none"></div>\n        <audio id="master" preload="auto"></audio>')
sub('<b id="tc">0:14</b> / <span id="total">12:40</span>', '<b id="tc">0:00</b> / <span id="total">0:00</span>')
sub('<select class="select" aria-label="Playback speed"><option>1×</option><option>1.5×</option><option>2×</option></select>',
    '<select class="select" id="speed" aria-label="Playback speed"><option value="1">1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>')
# transcript tab
sub('<div class="empty" id="making" hidden>', '<div class="empty" id="making">')
sub('<h2>Writing the transcript</h2>', '<h2 id="makingTitle">Getting your video ready</h2>')
sub('<p>About 1 minute left. You can watch the video and set the style while you wait.</p>', '<p>This takes about a minute for every few minutes of video. You can leave this page and come back.</p>')
sub('<div class="meter-bar"><i style="width:62%"></i></div>', '<div class="meter-bar"><i id="makingBar" style="width:4%"></i></div>')
sub('<h2>The transcript couldn\'t be made</h2>', '<h2>This video couldn\'t be processed</h2>')
sub('<p>The sound may be too quiet, or the server stopped partway. Your recording is safe.</p>', '<p>The server stopped partway. Your recording is safe.</p>')
sub('<a class="btn primary lg" href="editor.html?state=processing">Try again</a>', '<button class="btn primary lg" id="retry">Try again</button>')
cut('<p class="xs">You can still cut the video', '</div>', replace='')
sub('<div id="transcriptReady">', '<div id="transcriptReady" hidden>')
sub('<span><b id="foundN">4</b> possible mistakes found</span>', '<span><b id="foundN">0</b> <span id="foundWord">possible mistakes</span> found</span>')
sub('<div class="found" id="found">', '<div class="found" id="found" hidden>')
sub('<button class="chip" aria-pressed="true"><svg class="ic"><use href="/static/assets/icons.svg#check"/></svg>Remove "um" and "uh"</button>', '<button class="chip" id="chipFillers" aria-pressed="true"><svg class="ic"><use href="/static/assets/icons.svg#check"/></svg>Remove "um" and "uh"</button>')
sub('<button class="chip" aria-pressed="true"><svg class="ic"><use href="/static/assets/icons.svg#check"/></svg>Shorten long pauses</button>', '<button class="chip" id="chipPauses" aria-pressed="true"><svg class="ic"><use href="/static/assets/icons.svg#check"/></svg>Shorten long pauses</button>')
sub('Click a crossed-out part to bring it back.</p>', 'Click a crossed-out part to bring it back.<span id="tipExtra"></span></p>')
cut('<div class="para"><time>0:00</time>', '<!-- STYLE -->', replace='</div>\n    </div>\n    </div>\n\n    ')
# style tab
for label, key in (("Violet glow", "glow"), ("Charcoal", "charcoal"), ("Deep purple", "purple"), ("Off-white", "offwhite"), ("Bright purple", "bright")):
    s = re.sub(r'(aria-label="%s" )data-bg="[^"]*"' % label, r'\1data-bg="%s"' % key, s)
cut('<div class="sec">\n        <div class="sech"><h3>Zoom in on my clicks</h3>', '<div class="sec">\n        <div class="sech"><h3>Clean up the sound</h3>')
sub('<svg class="ic fill"><use href="/static/assets/icons.svg#play"/></svg>Listen</button>', '<svg class="ic fill"><use href="/static/assets/icons.svg#play"/></svg><span id="sampleText">Listen</span></button>')
sub('<div class="wave" id="wave"></div>', '<p class="sub" id="loudness" style="margin:var(--space-3) 0 0"></p>')
sub('<div class="line"><span class="muted">Colors, fonts and logo</span><a href="brand.html">Brand settings</a></div>', '')
# timeline
cut('<button class="btn" id="addZoom"', '<a class="btn" href="recorder.html"')
sub('<a class="btn" href="recorder.html" title="Record another clip for this video">', '<a class="btn" id="recordMore" href="/record" title="Record another clip for this video">')
cut('<div class="zoomctl">', '</div>\n  <div class="tgrid">', replace='')
sub('<div class="h-thin" style="margin-bottom:4px">Zoom</div>\n', '')
cut('<button class="blk clip" style="left:0%;width:32.7%">', '</div>\n      <div class="track h-thin" id="zoomTrack">', replace='')
cut('<div class="track h-thin" id="zoomTrack">', '<div class="track h-thin"><div class="capchips"', replace='')
cut('<div class="zpop" id="zpop" hidden>', '<div class="playhead"', replace='')
sub('<div class="playhead" id="playhead" style="left:1.84%"></div>', '<div class="playhead" id="playhead" style="left:0"></div>')
# export dialog
sub('<select class="select"><option>HD (1080p)</option><option>4K</option><option>Small file (720p)</option></select>', '<select class="select" id="quality"><option value="1080">HD (1080p)</option><option value="720">Small file (720p)</option></select>')
sub('<select class="select"><option>On the video</option><option>As a separate file</option><option>No captions</option></select>', '<select class="select" id="capMode"><option value="burn">On the video</option><option value="file">As a separate file</option><option value="none">No captions</option></select>')
sub('<small id="dlNote">MP4, about 1.4 GB. It saves to your Downloads folder.</small>', '<small id="dlNote"></small>')
cut('<div class="or">or</div>', '</div>\n</div>\n\n<div class="notice warn floatnote"', replace='')
sub('</style>', '''  .pv .shot{background:transparent;border-radius:6px}
  .shot video{width:100%;height:100%;object-fit:contain}
  .cam video{width:100%;height:100%;object-fit:cover}
  #preview{container-type:inline-size}
  #preview .cap{font-size:max(11px,3.3cqw)}
  #preview .mark{font-size:max(8px,2cqw)}
  .pv .frame.vertical{aspect-ratio:9/16;width:min(100cqw,calc(100cqh * 9 / 16))}
  .frame.vertical .shot{inset:5% 5% 44% 5%}
  .frame.vertical .cam{width:62%;right:19%;bottom:5%}
  .frame.vertical[data-layout="cam"] .cam{width:100%;right:0;bottom:0}
  .frame.vertical .cap{bottom:42%;white-space:normal;width:86%}
  #preview.vertical .cap{font-size:max(11px,6cqw)}
  .w{cursor:pointer;border-radius:3px;padding:1px 0}
  .w:hover{background:rgba(246,246,244,.06)}
  .w.now{background:rgba(171,140,240,.22)}
  .w.cutx.now{background:transparent}
  .pause{cursor:pointer}
  .tile.dim{opacity:.35;cursor:not-allowed}
  .blk.clip.removed b{text-decoration:line-through}
</style>''')
s += '<script src="/static/js/edit.js"></script>\n</body>\n</html>\n'
(root / "app/pages/edit.html").write_text(s)
print("edit.html", len(s))
