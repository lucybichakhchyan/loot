"""Export: apply the cuts, lay out camera and screen, add zooms, cards and captions, and write an MP4.

Everything here is FFmpeg and plain code. No Claude and no tokens.
"""
import json
import os
import re
import subprocess
import time
from pathlib import Path

from .common import DATA, project_dir, read_json, run, set_status, write_json
from .media import FPS, LOUDNESS_TARGET, _loudness

FONTS = os.environ.get("LOOT_FONTS", "/app/app/static/fonts")
AVATAR = os.environ.get("LOOT_AVATAR", "/app/app/static/assets/avatar-256.png")
BACKGROUNDS = {"glow": None, "charcoal": "1A1A1A", "purple": "2D253A", "offwhite": "F6F6F4", "bright": "8A2BE2"}
OWNER_NAME = os.environ.get("LOOT_OWNER_NAME", "")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def brand() -> dict:
    """Brand settings as saved on the Brand settings page, with safe values for anything missing."""
    saved = read_json(DATA / "brand.json", {}) or {}
    b = {"name": OWNER_NAME, "highlight": "#AB8CF0", "headline_font": "serif", "highlight_word": True, **saved}
    if not HEX.match(str(b.get("highlight") or "")):
        b["highlight"] = "#AB8CF0"
    logos = sorted((DATA / "brand").glob("logo.*")) if (DATA / "brand").is_dir() else []
    b["logo_file"] = str(logos[0]) if logos else None
    return b


def _ass_color(hex_color: str) -> str:
    """#RRGGBB as subtitles want it: blue, green, red."""
    h = hex_color.lstrip("#")
    return f"&H{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


INTRO, OUTRO = 3.0, 5.0     # seconds the title card and the closing card stay up
ZOOM_RAMP = 12              # frames a zoom takes to ease in and out (0.4 seconds)
SWITCH_FRAMES = 6           # frames a smooth layout change takes (0.2 seconds)
TEXT_SIZES = {"s": 0.034, "m": 0.052, "l": 0.076}     # text on the video, as a share of the frame's height
IMAGE_SIZES = {"s": 0.12, "m": 0.22, "l": 0.36}       # an image on the video, as a share of the frame's width
OVERLAY_NAME = re.compile(r"^[a-z0-9]{8}\.(png|jpg|jpeg|webp|gif)$")


def _even(x: float) -> int:
    return max(2, int(round(x)) // 2 * 2)


def _unit(v, default: float = 0.5) -> float:
    try:
        return min(1.0, max(0.0, float(v)))
    except (TypeError, ValueError):
        return default


# ---------- cuts ----------

def kept_frames(removed: list, total_frames: int) -> list:
    """Turn removed [start, end] second ranges into kept [first, last] frame ranges."""
    cuts = sorted((max(0, round(a * FPS)), min(total_frames, round(b * FPS))) for a, b in removed if b > a)
    kept, pos = [], 0
    for a, b in cuts:
        if a > pos:
            kept.append((pos, a - 1))
        pos = max(pos, b)
    if pos < total_frames:
        kept.append((pos, total_frames - 1))
    return kept


def out_time(t: float, kept: list) -> float | None:
    """Where a source time lands in the exported video, or None if it was cut."""
    f, done = t * FPS, 0
    for a, b in kept:
        if f < a:
            return None
        if f <= b + 1:
            return (done + f - a) / FPS
        done += b - a + 1
    return None


def out_frame(t: float, kept: list) -> int:
    """How many exported frames come before a source time. Defined even when that moment was cut."""
    f, done = t * FPS, 0
    for a, b in kept:
        if f <= a:
            break
        done += min(f, b + 1) - a
    return int(round(done))


# ---------- captions ----------

def caption_chunks(words: list, kept: list) -> list:
    """Group the words that survive the cuts into short caption lines. The editor preview uses the same rules."""
    chunks, cur = [], []
    for w in words:
        s, e = out_time(w["start"], kept), out_time(w["end"], kept)
        if s is None or e is None:
            if cur:
                chunks.append(cur)
                cur = []
            continue
        text = re.sub(r"[,.;:]+$", "", w["w"])
        if not text:      # a word folded into its neighbour by "Fix text"
            continue
        if cur:
            chars = sum(len(x["w"]) + 1 for x in cur)
            if len(cur) >= 4 or chars + len(text) > 28 or s - cur[-1]["end"] > 0.7 or cur[-1]["stop"]:
                chunks.append(cur)
                cur = []
        cur.append({"w": text, "start": s, "end": max(e, s + 0.05), "stop": bool(re.search(r"[.?!]$", w["w"]))})
    if cur:
        chunks.append(cur)
    return chunks


def _ass_time(t: float) -> str:
    cs = max(0, round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _srt_time(t: float) -> str:
    ms = max(0, round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def _ass_text(s: str) -> str:
    return s.replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ")


def write_srt(chunks: list, path: Path) -> None:
    lines = []
    for n, c in enumerate(chunks, 1):
        end = c[-1]["end"] + 0.15
        if n < len(chunks):
            end = min(end, chunks[n][0]["start"])
        lines.append(f"{n}\n{_srt_time(c[0]['start'])} --> {_srt_time(end)}\n{' '.join(w['w'] for w in c)}\n")
    path.write_text("\n".join(lines))


def write_ass(path: Path, w: int, h: int, total: float, *, chunks: list, style: str, low: bool,
              show_name: bool, intro: dict | None, outro: dict | None, hook: str | None = None,
              texts: list | None = None) -> None:
    """Captions, the name in the corner, words typed on the video, and the words on the title and closing cards."""
    vertical = h > w
    size = round(h * (0.04 if vertical else 0.058))
    margin = round(h * (0.03 if low else 0.09))
    if vertical:
        margin = round(h * 0.42)
    if hook is not None:   # a short: captions sit at the bottom, a little smaller, as on the Shorts page
        size, margin = round(w * 0.055), round(h * 0.05)
    b = brand()
    serif = b.get("headline_font") != "sans"
    hi_color = _ass_color(b["highlight"])
    headline = r"\fnPlayfair Display\i1\b1" if serif else r"\fnInter\i0\b1"   # card titles and the name
    base = f"Style: Cap,Inter,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,1,0,3,2,40,40,{margin},1"
    em = r"{\fnPlayfair Display\i1}" if serif else r"{\c%s}" % hi_color
    if style == "boxed":
        base = f"Style: Cap,Inter,{size},&H00FFFFFF,&H00FFFFFF,&H001A1A1A,&H001A1A1A,-1,0,0,0,100,100,0,0,3,{round(size * .22)},0,2,40,40,{margin},1"
        em = (r"{\fnPlayfair Display\i1\c%s}" if serif else r"{\c%s}") % hi_color
    if not b.get("highlight_word", True):
        em = ""
    if style == "plain":
        base = f"Style: Cap,Inter,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,0,0,0,0,100,100,0,0,1,1,2,2,40,40,{margin},1"
        em = ""
    name_size = round(w * (0.034 if vertical else 0.02))
    pad = round(w * .09)
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{base}
Style: Name,{"Playfair Display" if serif else "Inter"},{name_size},&H1AFFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,{-1 if serif else 0},0,0,100,100,0,0,1,0,1,7,{round(w * .03)},40,{round(h * .02)},1
Style: Card,Inter,{round(h * .024)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,4,{pad},{pad},0,1
Style: Ov,Inter,{round(h * .052)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,1,0,2,5,0,0,0,1
Style: OvBox,Inter,{round(h * .052)},&H00FFFFFF,&H00FFFFFF,&H001A1A1A,&H001A1A1A,-1,0,0,0,100,100,0,0,3,8,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lo = INTRO if intro else 0.0             # captions and the name stay off the cards
    hi = total - OUTRO if outro else total
    events = []
    if show_name and b.get("name") and hi > lo:
        events.append(f"Dialogue: 0,{_ass_time(lo)},{_ass_time(hi)},Name,,0,0,0,,{_ass_text(b['name'])}")
    for n, c in enumerate(chunks):
        chunk_end = c[-1]["end"] + 0.15
        if n + 1 < len(chunks):
            chunk_end = min(chunk_end, chunks[n + 1][0]["start"])
        for i, word in enumerate(c):
            start = max(lo, word["start"] if i else c[0]["start"])
            end = min(hi, c[i + 1]["start"] if i + 1 < len(c) else chunk_end)
            if end <= start:
                continue
            parts = [(em + _ass_text(x["w"]) + r"{\r}") if (j == i and em) else _ass_text(x["w"]) for j, x in enumerate(c)]
            events.append(f"Dialogue: 1,{_ass_time(start)},{_ass_time(end)},Cap,,0,0,0,,{' '.join(parts)}")
    for t in texts or []:   # words she typed on the video: plain, boxed, or in the brand's headline font
        start, end = max(lo, t["start"]), min(hi, t["end"])
        if end - start < 0.05:
            continue
        # Subtitle sizes measure the full line height, so they are raised to match the letter size the editor shows.
        tall = 1.33 if t.get("look") == "headline" and serif else 1.21
        fs = round(h * TEXT_SIZES.get(t.get("size"), TEXT_SIZES["m"]) * tall)
        where = r"\an5\q2\pos(%d,%d)\fs%d" % (round(w * t["x"]), round(h * t["y"]), fs)
        if t.get("look") == "boxed":
            line, look = "OvBox", r"\bord%d" % max(2, round(fs * .2))
        elif t.get("look") == "headline":
            line, look = "Ov", headline + r"\shad%d" % max(1, round(fs * .06))
        else:
            line, look = "Ov", r"\shad%d" % max(1, round(fs * .06))
        events.append(f"Dialogue: 10,{_ass_time(start)},{_ass_time(end)},{line},,0,0,0,,{{{where}{look}}}{_ass_text(t['text'])}")
    # The accent line is drawn as a small shape that sits in the text like a word.
    accent = lambda width: r"{\p1\c%s\bord0\shad0}m 0 0 l %d 0 %d %d 0 %d{\p0}" % (hi_color, width, width, max(2, round(h * .004)), max(2, round(h * .004)))  # noqa: E731
    gap = r"{\fs%d}\N" % round(h * .03)
    if hook:   # the first line on the video: bold, top left, for the whole short
        text = r"{\an7\q0\pos(%d,%d)\b1\fs%d\shad2\4a&H66&}%s" % (round(w * .07), round(h * .06), round(w * .085), _ass_text(hook))
        events.append(f"Dialogue: 5,{_ass_time(0)},{_ass_time(total)},Card,,{round(w * .07)},{round(w * .20)},0,,{text}")
    if intro:
        big = round(h * (0.045 if vertical else 0.08))
        text = (r"{\an4\q0\fs%d\alpha&H40&}%s\N" % (round(h * .022), _ass_text(intro["date"])) + gap
                + r"{\alpha&H00&%s\fs%d}%s\N" % (headline, big, _ass_text(intro["title"])) + gap
                + accent(round(w * .12)) + r"\N" + gap + r"{\r\q0\fs%d}%s" % (round(h * .024), _ass_text(b["name"])))
        events.append(f"Dialogue: 20,{_ass_time(0)},{_ass_time(INTRO)},Card,,0,0,0,,{text}")
    if outro:
        big = round(h * (0.04 if vertical else 0.065))
        text = (r"{\an5\q0\pos(%d,%d)%s\fs%d}%s\N" % (w // 2, round(h * .62), headline, big, _ass_text(outro["line"])) + gap
                + accent(round(w * .12)) + r"\N" + gap + r"{\r\q0\an5\fs%d}%s" % (round(h * .024), _ass_text(b["name"])))
        events.append(f"Dialogue: 20,{_ass_time(total - OUTRO)},{_ass_time(total)},Card,,0,0,0,,{text}")
    path.write_text(head + "\n".join(events) + "\n")


# ---------- layout ----------

def geometry(layout: str, w: int, h: int) -> dict:
    """Boxes for the screen and the camera, matching the editor preview (design/app.css)."""
    def box(left, top, right, bottom):
        return {"x": round(w * left), "y": round(h * top), "w": round(w * (1 - left - right)) // 2 * 2,
                "h": round(h * (1 - top - bottom)) // 2 * 2}
    if layout == "short":  # as the Shorts page draws it: first line on top, screen in the middle, camera below
        d = round(w * 0.50) // 2 * 2
        return {"screen": box(.07, .24, .07, .40), "cam": {"x": round(w * .25), "y": h - round(h * .13) - d, "w": d, "h": d, "round": True}}
    if h > w and layout in ("bubble", "side"):  # vertical short: screen on top, camera circle below
        d = round(w * 0.62) // 2 * 2
        return {"screen": box(.05, .06, .05, .44), "cam": {"x": round(w * .19), "y": h - round(h * .05) - d, "w": d, "h": d, "round": True}}
    if layout == "bubble":
        d = round(w * 0.18) // 2 * 2
        return {"screen": box(.06, .10, .06, .07),
                "cam": {"x": w - round(w * .04) - d, "y": h - round(h * .06) - d, "w": d, "h": d, "round": True}}
    if layout == "side":
        return {"screen": box(.04, .12, .40, .12), "cam": box(.63, .12, .04, .12)}
    if layout == "cam":
        return {"cam": {"x": 0, "y": 0, "w": w, "h": h}}
    return {"screen": box(.03, .04, .03, .04)}


def _still(source: str, out: Path, *extra: str) -> None:
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", source, "-frames:v", "1", *extra, str(out)])


CIRCLE = "if(lte(hypot(X-(W-1)/2,Y-(H-1)/2),W/2),255,0)"


def render_short(pid: str, sid: str) -> None:
    """Export one short: a part of the video, upright, with its first line and boxed captions."""
    d = project_dir(pid)
    short = next((s for s in (read_json(d / "shorts.json", {}) or {}).get("shorts", []) if s.get("id") == sid), None)
    if not short or not re.match(r"^[a-z0-9]{6,12}$", sid):
        raise SystemExit(f"render: no such short: {sid}")
    render(pid, short)


def render(pid: str, short: dict | None = None) -> None:
    d = project_dir(pid)
    ex = d / "exports"
    ex.mkdir(exist_ok=True)
    stem = f"short_{short['id']}" if short else "export"
    state_file = ex / f"{stem}.json"
    request = read_json(state_file, {}) or {}
    started = time.time()

    def progress(**fields):
        write_json(state_file, {**request, "started_at": started, "updated_at": time.time(), **fields})

    if not short and (ex / "cancel").exists():      # cancelled while it was still waiting its turn
        (ex / "cancel").unlink()
        progress(state="cancelled")
        return
    try:
        _render(d, ex, request, progress, short)
    except Cancelled:
        (ex / "cancel").unlink(missing_ok=True)
        (ex / "export.tmp.mp4").unlink(missing_ok=True)
        progress(state="cancelled")
        print("render: cancelled")
        return
    except BaseException as e:  # noqa: BLE001 - record every failure for the editor
        progress(state="failed", error=str(e)[-600:])
        raise
    if not short:
        set_status(pid, exported_at=time.time(), media_deleted_at=None)


class Cancelled(Exception):
    pass


def _render(d: Path, ex: Path, request: dict, progress, short: dict | None = None) -> None:
    timeline = read_json(d / "timeline.json")
    if not timeline:
        raise SystemExit("render: the recording has not been processed yet")
    edit = read_json(d / "edit.json", {}) or {}
    status = read_json(d / "status.json", {}) or {}
    fixes = edit.get("fixes") or {}
    words = [dict(w, w=fixes.get(str(w["i"]), w["w"])) for w in (read_json(d / "transcript.json", {}) or {}).get("words", [])]

    vertical = status.get("kind") == "short" or bool(short)
    stem = f"short_{short['id']}" if short else "export"
    long_side = 1280 if request.get("quality") == "720" else 1920
    w, h = (long_side * 9 // 16, long_side) if vertical else (long_side, long_side * 9 // 16)
    total_frames = round(timeline["duration"] * FPS)
    removed = list(edit.get("removed") or [])
    if short:   # everything outside the short's start and end is left out, on top of the cuts already made
        removed += [[0, float(short["a"])], [float(short["b"]), timeline["duration"] + 1]]
    kept = kept_frames(removed, total_frames)
    if not kept:
        raise SystemExit("render: every part of the video is cut, so there is nothing to export")
    out_frames = sum(b - a + 1 for a, b in kept)
    out_seconds = out_frames / FPS

    has_screen, has_cam = bool(timeline.get("screen")), bool(timeline.get("cam"))
    usable = lambda name: "cam" if not has_screen else "screen" if not has_cam else (name or "bubble")  # noqa: E731
    base = usable("short" if short else edit.get("layout"))
    # Layout changes for part of the video, as exported frame ranges per layout
    switches: dict[str, list] = {}
    for b in ([] if short else edit.get("layouts") or []):
        name = usable(b.get("layout"))
        a, z = out_frame(float(b["start"]), kept), out_frame(float(b["start"]) + float(b["len"]), kept)
        if name != base and z - a >= 1:
            switches.setdefault(name, []).append((a, z - 1))
    layouts = [base] + list(switches)
    geos = {name: geometry(name, w, h) for name in layouts}
    need_screen = sum(1 for g in geos.values() if "screen" in g)
    need_cam = sum(1 for g in geos.values() if "cam" in g)
    need_bg = sum(1 for name in layouts if name != "cam")

    smooth = (edit.get("transition") or "smooth") != "cut" and not short

    # Crop of the screen recording, as fractions cut from each side. It applies to every clip.
    crop = None
    c = edit.get("crop") if isinstance(edit.get("crop"), dict) else None
    if c and has_screen:
        left, top, right, bottom = (_unit(c.get(k), 0) for k in ("l", "t", "r", "b"))
        if left + right <= 0.8 and top + bottom <= 0.8 and left + right + top + bottom > 0.001:
            sw0, sh0 = timeline["screen"]["w"], timeline["screen"]["h"]
            crop = {"w": _even(sw0 * (1 - left - right)), "h": _even(sh0 * (1 - top - bottom)),
                    "x": int(sw0 * left) // 2 * 2, "y": int(sh0 * top) // 2 * 2}

    # Blurred areas of the screen recording: (first frame, last frame, x, y, width, height) in its own pixels
    blurs = []
    for bl in ([] if not has_screen else edit.get("blurs") or []):
        try:
            a, z = out_frame(float(bl["start"]), kept), out_frame(float(bl["start"]) + float(bl["len"]), kept)
        except (KeyError, TypeError, ValueError):
            continue
        sw0, sh0 = timeline["screen"]["w"], timeline["screen"]["h"]
        x, y = int(sw0 * _unit(bl.get("x"), 0)) // 2 * 2, int(sh0 * _unit(bl.get("y"), 0)) // 2 * 2
        bw, bh = min(_even(sw0 * _unit(bl.get("w"), .2)), (sw0 - x) // 2 * 2), min(_even(sh0 * _unit(bl.get("h"), .2)), (sh0 - y) // 2 * 2)
        if z - a >= 1 and bw >= 8 and bh >= 8:
            blurs.append((a, z - 1, x, y, bw, bh))

    # Text and images placed on the video
    texts, images = [], []
    for o in ([] if short else edit.get("overlays") or []):
        try:
            a, z = out_frame(float(o["start"]), kept), out_frame(float(o["start"]) + float(o["len"]), kept)
        except (KeyError, TypeError, ValueError):
            continue
        if z - a < 1:
            continue
        place = {"x": _unit(o.get("x")), "y": _unit(o.get("y")), "size": o.get("size") if o.get("size") in TEXT_SIZES else "m"}
        if o.get("kind") == "image" and OVERLAY_NAME.match(str(o.get("file") or "")) and (d / "overlays" / o["file"]).is_file():
            images.append({**place, "a": a, "b": z - 1, "file": o["file"]})
        elif o.get("kind") == "text" and str(o.get("text") or "").strip():
            texts.append({**place, "start": a / FPS, "end": z / FPS, "look": o.get("look"), "text": " ".join(str(o["text"]).split())[:120]})

    # Cards
    intro = {"title": status.get("title") or "Untitled video",
             "date": time.strftime("%-d %B %Y", time.localtime(status.get("created_at") or time.time()))} if (edit.get("intro") or {}).get("on") and not short else None
    outro = {"line": (edit.get("outro") or {}).get("line") or brand().get("closing_line") or "Thanks for watching."} \
        if (edit.get("outro") or {}).get("on") and out_seconds > INTRO + OUTRO and not short else None

    # Captions and other words drawn on the video
    captions = request.get("captions", "burn") if (edit.get("captions", {}).get("on", True) and words) else "none"
    if short:   # a short always carries its captions, boxed, as the Shorts page shows them
        captions = "burn" if words else "none"
    chunks = caption_chunks(words, kept) if words else []
    if chunks and not short:
        write_srt(chunks, ex / "captions.srt")
    show_name = bool(edit.get("name", {}).get("on", False)) and not short
    burn = captions == "burn" and bool(chunks)
    hook = (short or {}).get("hook") or None
    drawn = burn or show_name or intro or outro or hook or texts
    if drawn:
        low = base in ("side", "screen") and not vertical
        write_ass(ex / "captions.ass", w, h, out_seconds, chunks=chunks if burn else [],
                  style="boxed" if short else edit.get("captions", {}).get("style", ""),
                  low=low, show_name=show_name, intro=intro, outro=outro, hook=hook, texts=texts)

    glow = f"gradients=s={w}x{h}:c0=0x3a2a55:c1=0x141118:x0={w * .8:.0f}:y0={h * .1:.0f}:x1=0:y1={h}:type=radial:n=2"
    bg = edit.get("bg") or brand().get("background") or "glow"
    solid = bg.lstrip("#") if HEX.match(bg) else BACKGROUNDS.get(bg)
    _still(f"color=c=0x{solid}:s={w}x{h}" if solid else glow, ex / "bg.png")

    inputs, graph, junk = [], [], ["bg.png", "graph.txt"]

    def add(*args) -> int:
        inputs.extend(args)
        return sum(1 for a in inputs if a == "-i") - 1

    def still(name: str) -> int:
        """A still image as a single frame. Overlays keep showing the last frame they were given,
        so nothing has to loop forever (endless inputs can stall FFmpeg when long stretches are cut)."""
        junk.append(name)
        return add("-i", name)

    def fan(label: str, count: int) -> list:
        """Give `count` copies of a stream, since each can only be used once."""
        if count <= 1:
            return [label]
        names = [f"{label}_{i}" for i in range(count)]
        graph.append(f"[{label}]split={count}" + "".join(f"[{x}]" for x in names))
        return names

    select = "+".join(f"between(n,{a},{b})" for a, b in kept)
    cut = f"select='{select}',setpts=N/({FPS}*TB)"

    bgs = []
    if need_bg:
        graph.append(f"color=c=black:s={w}x{h}:r={FPS}:d={out_seconds + 1:.3f}[canvas]")
        graph.append(f"[canvas][{still('bg.png')}:v]overlay[bg]")
        bgs = fan("bg", need_bg)
    screens = []
    if need_screen:
        i = add("-i", str(d / "screen_all.mp4"))
        zoom = ""
        zooms = []
        for z in edit.get("zooms") or []:
            a, b = out_frame(float(z["start"]), kept), out_frame(float(z["start"]) + float(z["len"]), kept)
            if b - a >= ZOOM_RAMP:
                zooms.append((a, b, max(1.05, min(3.0, float(z.get("scale", 1.5)))), min(1, max(0, float(z.get("x", .5)))), min(1, max(0, float(z.get("y", .5))))))
        if zooms:
            sw, sh = (crop["w"], crop["h"]) if crop else (timeline["screen"]["w"], timeline["screen"]["h"])
            ze = "1" + "".join(f"+{s - 1:.3f}*min(clip((on-{a})/{ZOOM_RAMP},0,1),clip(({b}-on)/{ZOOM_RAMP},0,1))" for a, b, s, _, _ in zooms)
            xe = "+".join(f"between(on,{a},{b})*{x:.4f}*(iw-iw/zoom)" for a, b, _, x, _ in zooms)
            ye = "+".join(f"between(on,{a},{b})*{y:.4f}*(ih-ih/zoom)" for a, b, _, _, y in zooms)
            zoom = f",zoompan=z='{ze}':x='{xe}':y='{ye}':d=1:s={sw}x{sh}:fps={FPS},setsar=1"
        graph.append(f"[{i}:v]{cut}[scr0]")
        cur = "scr0"
        for j, (a, b, x, y, bw, bh) in enumerate(blurs):
            # A blur is the same area shrunk and stretched back, laid over the picture while it lasts.
            graph.append(f"[{cur}]split[bs{j}][bb{j}]")
            graph.append(f"[bb{j}]crop={bw}:{bh}:{x}:{y},scale={max(2, bw // 16)}:{max(2, bh // 16)}:flags=area,scale={bw}:{bh}:flags=bicubic[bl{j}]")
            graph.append(f"[bs{j}][bl{j}]overlay=x={x}:y={y}:enable='between(n,{a},{b})'[scrb{j}]")
            cur = f"scrb{j}"
        cropf = f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}" if crop else ""
        graph.append(f"[{cur}]{(cropf + zoom).lstrip(',') or 'null'}[scr]")
        screens = fan("scr", need_screen)
    cams = []
    if need_cam:
        i = add("-i", str(d / "cam_all.mp4"))
        flip = ",hflip" if edit.get("mirror", True) else ""
        graph.append(f"[{i}:v]{cut}{flip}[cam]")
        cams = fan("cam", need_cam)

    for k, name in enumerate(layouts):
        g, last = geos[name], None
        if name != "cam":
            last = bgs.pop()
        if "screen" in g:
            s = g["screen"]
            graph.append(f"[{screens.pop()}]scale={s['w']}:{s['h']}:force_original_aspect_ratio=decrease:flags=lanczos[s{k}]")
            graph.append(f"[{last}][s{k}]overlay=x={s['x']}+({s['w']}-w)/2:y={s['y']}+({s['h']}-h)/2[a{k}]")
            last = f"a{k}"
        if "cam" in g:
            c, src = g["cam"], cams.pop()
            fill = f"scale={c['w']}:{c['h']}:force_original_aspect_ratio=increase,crop={c['w']}:{c['h']}"
            if c.get("round"):
                ring = max(4, round(w * 0.002) * 2)
                size = c["w"] + ring * 2
                _still(f"color=black:s={c['w']}x{c['h']},format=gray,geq=lum='{CIRCLE}'", ex / f"mask{k}.png")
                _still(f"color=white:s={size}x{size},format=rgba,geq=r=246:g=246:b=244:a='{CIRCLE}'", ex / f"ring{k}.png")
                m, r = still(f"mask{k}.png"), still(f"ring{k}.png")
                graph.append(f"[{src}]crop=ih:ih,scale={c['w']}:{c['h']},format=rgba[q{k}]")
                graph.append(f"[{m}:v]format=gray[m{k}]")
                graph.append(f"[q{k}][m{k}]alphamerge[c{k}]")
                graph.append(f"[{last}][{r}:v]overlay=x={c['x'] - ring}:y={c['y'] - ring}[r{k}]")
                graph.append(f"[r{k}][c{k}]overlay=x={c['x']}:y={c['y']}[L{k}]")
            elif name == "cam":
                graph.append(f"[{src}]{fill}[L{k}]")
            else:
                graph.append(f"[{src}]{fill}[b{k}]")
                graph.append(f"[{last}][b{k}]overlay=x={c['x']}:y={c['y']}[L{k}]")
        else:
            graph.append(f"[{last}]null[L{k}]")

    # Switch to another layout for the parts that asked for one
    last = "L0"
    for k, name in enumerate(layouts[1:], 1):
        when = "+".join(f"between(n,{a},{b})" for a, b in switches[name])
        src, fades, n = f"L{k}", "", SWITCH_FRAMES
        for a, b in (switches[name] if smooth else []):
            if b - a + 1 < 2 * n:
                continue
            if a > 0:
                fades += f",fade=t=in:s={a}:n={n}:alpha=1:enable='between(n,{a},{a + n - 1})'"
            if b < out_frames - 1:
                fades += f",fade=t=out:s={b - n + 1}:n={n}:alpha=1:enable='between(n,{b - n + 1},{b})'"
        if fades:
            graph.append(f"[L{k}]format=yuva420p{fades}[F{k}]")
            src = f"F{k}"
        graph.append(f"[{last}][{src}]overlay=enable='{when}'[v{k}]")
        last = f"v{k}"

    # Images she placed on the video. The cards, added next, cover them.
    for j, o in enumerate(images):
        width = _even(w * IMAGE_SIZES[o["size"]])
        run(["ffmpeg", "-y", "-v", "error", "-i", str(d / "overlays" / o["file"]), "-frames:v", "1",
             "-vf", f"scale={width}:-2:flags=lanczos,format=rgba", str(ex / f"ov{j}.png")])
        graph.append(f"[{last}][{still(f'ov{j}.png')}:v]overlay=x={round(w * o['x'])}-w/2:y={round(h * o['y'])}-h/2:enable='between(n,{o['a']},{o['b']})'[ov{j}]")
        last = f"ov{j}"

    if intro or outro:
        _still(glow, ex / "card.png")
        when = "+".join(x for x in (f"lt(t,{INTRO})" if intro else "", f"gte(t,{out_seconds - OUTRO:.3f})" if outro else "") if x)
        graph.append(f"[{last}][{still('card.png')}:v]overlay=enable='{when}'[cards]")
        last = "cards"
        picture = brand()["logo_file"] or AVATAR
        if outro and Path(picture).exists():
            size = round(h * (0.12 if vertical else 0.16)) // 2 * 2
            run(["ffmpeg", "-y", "-v", "error", "-i", picture, "-vf",
                 f"scale={size}:{size}:force_original_aspect_ratio=increase,crop={size}:{size},format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{CIRCLE}'", "-frames:v", "1", str(ex / "avatar.png")])
            graph.append(f"[{last}][{still('avatar.png')}:v]overlay=x=(W-w)/2:y={round(h * .40) - size // 2}:enable='gte(t,{out_seconds - OUTRO:.3f})'[av]")
            last = "av"
    if drawn:
        graph.append(f"[{last}]subtitles=captions.ass:fontsdir={FONTS}[vs]")
        last = "vs"
    graph.append(f"[{last}]format=yuv420p[vout]")

    # Sound: the same kept ranges, with 5 ms fades so cuts don't click
    sound = d / ("audio_clean.wav" if edit.get("clean", True) and (d / "audio_clean.wav").exists() else "audio_raw.wav")
    n = add("-i", str(sound))
    parts = []
    for i, (a, b) in enumerate(kept):
        length = (b - a + 1) / FPS
        fade = f",afade=t=in:d=0.005,afade=t=out:st={max(0, length - 0.005):.4f}:d=0.005" if length > 0.02 else ""
        graph.append(f"[{n}:a]atrim={a / FPS:.5f}:{(b + 1) / FPS:.5f},asetpts=PTS-STARTPTS{fade}[au{i}]")
        parts.append(f"[au{i}]")
    graph.append(f"{''.join(parts)}concat=n={len(parts)}:v=0:a=1[aout]")
    (ex / "graph.txt").write_text(";\n".join(graph))

    target = ex / f"{stem}.tmp.mp4"
    cmd = ["ffmpeg", "-y", "-v", "error", "-nostats", "-progress", "pipe:1", *inputs,
           "-filter_complex_script", "graph.txt", "-map", "[vout]", "-map", "[aout]",
           "-t", f"{out_seconds:.5f}", "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(target)]
    progress(state="rendering", pct=0, seconds=round(out_seconds, 1))
    # FFmpeg's messages go to a file. Left in a pipe that nobody reads, they fill it up and FFmpeg stops dead.
    log = open(ex / "ffmpeg.log", "w")
    proc = subprocess.Popen(cmd, cwd=ex, stdout=subprocess.PIPE, stderr=log, text=True)
    last_write, reached, moved_at = 0.0, -1, time.time()
    for line in proc.stdout:
        m = re.match(r"out_time_us=(\d+)", line)
        if m and int(m.group(1)) != reached:
            reached, moved_at = int(m.group(1)), time.time()
        elif m and time.time() - moved_at > 90:
            # FFmpeg is alive but not getting anywhere. Stop it, so one stuck export can't block the queue.
            proc.kill()
            proc.wait()
            log.close()
            raise SystemExit("render: the export stopped making progress and was stopped")
        if m and time.time() - last_write > 1.5:
            last_write = time.time()
            if not short and (ex / "cancel").exists():
                proc.kill()
                proc.wait()
                log.close()
                raise Cancelled()
            progress(state="rendering", pct=min(99, round(100 * int(m.group(1)) / 1e6 / out_seconds)),
                     seconds=round(out_seconds, 1))
    code = proc.wait()
    log.close()
    if code != 0:
        err = (ex / "ffmpeg.log").read_text(errors="replace")
        raise SystemExit("render: FFmpeg stopped: " + "\n".join(err.strip().splitlines()[-6:]))
    final = ex / f"{stem}.mp4"
    target.replace(final)
    for name in junk + ["card.png", "ffmpeg.log"]:
        (ex / name).unlink(missing_ok=True)
    loud = _loudness(final)
    progress(state="done", pct=100, seconds=round(out_seconds, 1), bytes=final.stat().st_size,
             width=w, height=h, layout=base, loudness=loud,
             loudness_ok=loud is not None and abs(loud - LOUDNESS_TARGET) <= 2.5,
             captions=captions, has_srt=bool(chunks))
    print(json.dumps({"export": final.name, "seconds": round(out_seconds, 1), "bytes": final.stat().st_size, "loudness": loud}))
