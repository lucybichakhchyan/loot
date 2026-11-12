"""One-off: turn design/recorder.html into app/pages/record.html (real video elements, real script)."""
import pathlib, re
root = pathlib.Path(__file__).resolve().parent.parent
s = (root / "design/recorder.html").read_text()
s = s[: s.index("<script>")]  # drop the mock behaviour
def sub(old, new, count=1):
    global s
    assert old in s, old[:60]
    s = s.replace(old, new, count)
sub('href="tokens.css"', 'href="/static/tokens.css"'); sub('href="app.css"', 'href="/static/app.css"')
s = s.replace('assets/icons.svg', '/static/assets/icons.svg').replace('href="index.html"', 'href="/"')
# live preview: real videos instead of the drawn stand-ins
a = s.index('<div class="shot">', s.index('id="frame"')); b = s.index('<div class="recbadge">')
s = s[:a] + '''<div class="shot" id="shot"><video id="screenV" muted playsinline autoplay></video><button class="btn" id="pickScreen">Choose what to share</button></div>
        <div class="cam"><video id="camV" muted playsinline autoplay></video></div>
        ''' + s[b:]
sub('</style>', '''  .shot{background:#0d0b10;align-items:center;justify-content:center}
  .shot video{width:100%;height:100%;object-fit:contain;display:none}
  .shot.live video{display:block}
  .shot.live #pickScreen{display:none}
  .cam video{width:100%;height:100%;object-fit:cover}
  .clip .frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  .recbtn[disabled]{opacity:.35;cursor:not-allowed}
  .script .text:empty::before{content:"Type or paste your script here.";color:var(--fg-faint)}
</style>''')
sub('<a class="btn primary lg" href="recorder.html">Reload the page</a>', '<a class="btn primary lg" href="/record">Reload the page</a>')
sub('<b>No sound is coming from Shure MV7.</b>', '<b>No sound is coming from <span id="noSoundName">the microphone</span>.</b>')
# script text starts empty
a = s.index('<p class="now">'); b = s.index('</div>', a)
s = s[:a].rstrip() + s[b:]
sub('<button class="switch" role="switch" aria-checked="true" aria-label="Scroll while I record"></button>', '<button class="switch" role="switch" aria-checked="true" id="scrollSwitch" aria-label="Scroll while I record"></button>')
sub('<input type="range" value="45" style="--val:45%" aria-label="Scroll speed">', '<input type="range" value="45" id="scrollSpeed" aria-label="Scroll speed">')
sub('Clip 2 didn\'t upload.<span class="more">', '<span id="upFailText">A clip didn\'t upload.</span><span class="more">')
sub('<a class="btn primary lg" href="editor.html">Edit video</a>', '<button class="btn primary lg" id="editBtn" disabled>Edit video</button>')
# source menus: the screen keeps its three choices, camera and microphone are filled from the real devices
s = s.replace('data-v="Chrome tab"', 'data-v="browser"').replace('data-v="A window"', 'data-v="window"').replace('data-v="Entire screen"', 'data-v="monitor"')
s = s.replace('<button aria-checked="true" data-v="browser">', '<button aria-checked="false" data-v="browser">')
for name in ("Camera", "Microphone"):
    a = s.index(f'<div class="menu" hidden><div class="mh">{name}</div>'); b = s.index('</div>\n      </div>', a)
    s = s[:a] + f'<div class="menu" hidden><div class="mh">{name}</div>' + s[b:]
for old in ("<small>Chrome tab</small>", "<small>FaceTime HD</small>", "<small>Shure MV7</small>"):
    sub(old, "<small>Starting…</small>")
sub('<i class="lvl" id="lvl"></i>', '<i class="lvl" id="lvl" style="width:0"></i>')
s += '<script src="/static/js/record.js"></script>\n</body>\n</html>\n'
(root / "app/pages/record.html").write_text(s)
print("record.html", len(s))
