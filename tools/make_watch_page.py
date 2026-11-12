"""One-off: turn design/watch.html into app/pages/watch.html (a real player fed by /w/<token>/info).

The page it writes is the source from then on. Run it again only after the share-page mockup changes.

NOTE: the page this wrote has since been edited by hand. Running this again would overwrite those edits
and pull in mockup changes that may not be approved yet. Edit the page in app/pages/ directly instead.
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
s = (root / "design/watch.html").read_text()
s = s[: s.index("<script>")]


def sub(old, new):
    global s
    assert old in s, old[:70]
    s = s.replace(old, new, 1)


sub('href="tokens.css"', 'href="/static/tokens.css"')
s = s.replace("assets/icons.svg", "/static/assets/icons.svg").replace("assets/avatar-256.png", "/static/assets/avatar-256.png")
sub("<title>Thanks for the introduction · Lucy Bichakhchyan</title>", '<title>Video</title>\n<meta name="robots" content="noindex, nofollow">')
sub('<img src="/static/assets/avatar-256.png" alt="">\n  <b id="who">Lucy Bichakhchyan</b>', '<img id="logo" src="/static/assets/avatar-256.png" alt="">\n  <b id="who"></b>')
sub('<div class="cam"><img src="/static/assets/avatar-256.png" alt=""></div>',
    '<div class="cam" id="stage"><img id="still" src="/static/assets/avatar-256.png" alt="" hidden><video id="video" playsinline preload="metadata"></video></div>')
sub('<div class="caption" id="caption">Thank you for the introduction</div>', '<div class="caption" id="caption"></div>')
sub('aria-valuemax="65" aria-valuenow="0"', 'aria-valuemax="0" aria-valuenow="0"')
sub('<span class="tm"><span id="cur">0:00</span> / 1:05</span>', '<span class="tm"><span id="cur">0:00</span> / <span id="dur">0:00</span></span>')
sub('<p class="eyebrow">video message</p>\n    <h1>Thanks for the introduction</h1>\n    <p class="meta">1 minute · 10 November 2026</p>\n    <p class="note">A short hello, and the two ideas I mentioned for the launch.</p>\n    <a class="cta" id="cta" href="#">Book a call</a>',
    '<p class="eyebrow" id="eyebrow">video message</p>\n    <h1 id="title"></h1>\n    <p class="meta" id="meta"></p>\n    <p class="note" id="note"></p>\n    <a class="cta" id="cta" href="#" target="_blank" rel="noopener" hidden></a>')
sub("</style>", '''  .player video{width:100%;height:100%;object-fit:contain;display:block;cursor:pointer}
  .player.tall{aspect-ratio:9/16;max-height:78vh;margin:0 auto}
  .player .cam img[hidden]{display:none}
  .note:empty{display:none}
</style>''')
s += '<script src="/static/js/watch.js"></script>\n</body>\n</html>\n'
(root / "app/pages/watch.html").write_text(s)
print("watch.html", len(s))
