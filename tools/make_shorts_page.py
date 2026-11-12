"""One-off: turn design/shorts.html into app/pages/shorts.html (real videos, real data, real script).

The page it writes is the source from then on. Run it again only after the Shorts mockup changes.

NOTE: the page this wrote has since been edited by hand. Running this again would overwrite those edits
and pull in mockup changes that may not be approved yet. Edit the page in app/pages/ directly instead.
"""
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
s = (root / "design/shorts.html").read_text()
s = s[: s.index("<script>")]


def sub(old, new):
    global s
    assert old in s, old[:70]
    s = s.replace(old, new, 1)


sub('href="tokens.css"', 'href="/static/tokens.css"')
sub('href="app.css"', 'href="/static/app.css"')
s = s.replace("assets/icons.svg", "/static/assets/icons.svg")
sub('<a class="back" href="editor.html">', '<a class="back" data-back href="/">')
sub("<p>LOOT found 4 parts of your video that work on their own. Press Keep on the ones you want, adjust the start and end if you like, then download them.</p>",
    '<p id="intro"></p>')
sub('<a class="from" href="editor.html"><svg class="ic"><use href="/static/assets/icons.svg#video"/></svg>How I plan a paid media test on a small budget, 12:40</a>',
    '<a class="from" data-back href="/"><svg class="ic"><use href="/static/assets/icons.svg#video"/></svg><span id="fromText"></span></a>')
# While Claude reads the transcript, the page shows the same waiting pattern the editor uses.
sub('<div class="grid" id="grid"></div>',
    '<div class="empty" id="finding" hidden><span class="spin" style="width:28px;height:28px"></span><h2>Looking for parts that work on their own</h2><p>This takes a few seconds.</p></div>\n  <div class="grid" id="grid"></div>')
sub("</style>", """  .phone .shot{background:#0d0b10}
  .phone video{width:100%;height:100%;object-fit:contain;display:block}
  .phone .cam video{object-fit:cover}
  .phone.mirror .cam video{transform:scaleX(-1)}
  .phone.camonly .cam{width:100%;right:0;bottom:0;height:100%;border-radius:0;box-shadow:none;aspect-ratio:auto}
  .phone.screenonly .shot{inset:24% 7% 24% 7%}
  .short.playing .po{display:none}
</style>""")
s += '<script src="/static/js/shorts.js"></script>\n</body>\n</html>\n'
(root / "app/pages/shorts.html").write_text(s)
print("shorts.html", len(s))
