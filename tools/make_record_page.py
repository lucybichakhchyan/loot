"""One-off: turn design/recorder.html into app/pages/record.html (real video elements, real script).

The page it writes is the source from then on. Run it again only after the recorder mockup changes,
and check the result by hand.
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
s = (root / "design/recorder.html").read_text()
s = s[: s.index("<script>")]  # drop the mock behaviour


def sub(old, new):
    global s
    assert old in s, old[:70]
    s = s.replace(old, new, 1)


def cut(start, end, replace=""):
    """Replace from `start` up to (not including) `end`."""
    global s
    a = s.index(start)
    b = s.index(end, a + len(start))
    s = s[:a] + replace + s[b:]


sub('href="tokens.css"', 'href="/static/tokens.css"')
sub('href="app.css"', 'href="/static/app.css"')
s = s.replace("assets/icons.svg", "/static/assets/icons.svg").replace('href="index.html"', 'href="/"')

# Live preview: real videos instead of the drawn stand-ins
cut('<div class="shot">', '<div class="badge">', '''<div class="shot" id="shot"><video id="screenV" muted playsinline autoplay></video><span class="wait">Your screen shows here once you press Record and choose what to share.</span></div>
        <div class="cam"><video id="camV" muted playsinline autoplay></video></div>
        ''')
sub("</style>", '''  .shot{background:#0d0b10;align-items:center;justify-content:center}
  .shot video{width:100%;height:100%;object-fit:contain;display:none}
  .shot.live video{display:block}
  .shot .wait{font-size:var(--fs-sm);color:var(--fg-faint);text-align:center;max-width:70%}
  .shot.live .wait{display:none}
  .cam video{width:100%;height:100%;object-fit:cover}
  body.mirror:not(.reviewing) .cam video{transform:scaleX(-1)}
  .clip .frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
  .recbtn[disabled]{opacity:.35;cursor:not-allowed}
  .script .text:empty::before{content:"Type or paste your script here.";color:var(--fg-faint)}
</style>''')
sub('<a class="btn primary lg" href="recorder.html">Reload the page</a>', '<a class="btn primary lg" href="/record">Reload the page</a>')
sub('<b>No sound is coming from Shure MV7.</b> Check that it is plugged in and not muted, or pick another microphone.',
    '<b id="noSoundTitle">No sound is coming from the microphone.</b> <span id="noSoundHelp">Check that it is plugged in and not muted, or pick another microphone.</span>')
# The script starts empty
cut('<p class="now">', "</div>\n    <div class=\"sf\">", "")
sub('<button class="switch" role="switch" aria-checked="true" aria-label="Scroll while I record"></button>',
    '<button class="switch" role="switch" aria-checked="true" id="scrollSwitch" aria-label="Scroll while I record"></button>')
sub('<input type="range" value="45" style="--val:45%" aria-label="Scroll speed">', '<input type="range" value="45" id="scrollSpeed" aria-label="Scroll speed">')
sub('<span class="grow">Clip 2 didn\'t upload.<span class="more">', '<span class="grow"><span id="upFailText">A clip didn\'t upload.</span><span class="more">')
sub('<a class="btn primary lg" id="editBtn" href="editor.html">Edit video</a>', '<button class="btn primary lg" id="editBtn" disabled>Edit video</button>')
# Camera and microphone lists are filled from the real devices
for name in ("Camera", "Microphone"):
    cut(f'<div class="menu" role="menu" hidden><div class="mh">{name}</div>', "</div>\n      </div>",
        f'<div class="menu" role="menu" hidden><div class="mh">{name}</div>')
for old in ("<small>FaceTime HD</small>", "<small>Shure MV7</small>"):
    sub(old, "<small>Starting…</small>")
sub('<i class="lvl" id="lvl"></i>', '<i class="lvl" id="lvl" style="width:0"></i>')
s += '<script src="/static/js/record.js"></script>\n</body>\n</html>\n'
(root / "app/pages/record.html").write_text(s)
print("record.html", len(s))
