"""Share links: how long a link works, and the small GIF that stands in for the video in an email.

Everything here is FFmpeg and plain code. No Claude and no tokens.
"""
import os
import time

from .common import project_dir, read_json, run

FONTS = os.environ.get("LOOT_FONTS", "/app/app/static/fonts")
GIF_SECONDS, GIF_FPS = 3, 12
GIF_WIDE, GIF_TALL = 480, 270      # width in pixels for a wide video and for a tall one


def live(share: dict | None) -> bool:
    """True while a link is on and not past its last day. A link past its time counts as turned off."""
    share = share or {}
    if not share.get("token") or not share.get("on"):
        return False
    return not share.get("expires_at") or share["expires_at"] > time.time()


def until(expires_at: float | None) -> str | None:
    """The last day a link works, the way the screens print it: "19 Nov". None means until it is turned off."""
    return time.strftime("%-d %b", time.localtime(expires_at)) if expires_at else None


def _size(src, saved: dict) -> tuple[int, int]:
    """Width and height of the exported video."""
    try:
        w, h = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                    "-of", "csv=p=0:s=x", str(src)]).stdout.strip().split("x")[:2]
        return int(w), int(h)
    except (SystemExit, ValueError):
        return int(saved.get("width") or 1920), int(saved.get("height") or 1080)


def _button(w: int, h: int) -> str:
    """A play button as subtitles: a dark see-through circle with a white triangle, in the middle of the picture."""
    r = round(min(w, h) * 0.11)
    k = round(r * 0.5523)            # how far a curve's handles sit from its ends to make a circle
    d = 2 * r
    circle = (f"m {r} 0 b {r + k} 0 {d} {r - k} {d} {r} b {d} {r + k} {r + k} {d} {r} {d} "
              f"b {r - k} {d} 0 {r + k} 0 {r} b 0 {r - k} {r - k} 0 {r} 0")
    tw, th = round(r * 0.78), round(r * 0.9)
    triangle = f"m 0 0 l {tw} {round(th / 2)} 0 {th}"
    shape = r"{\an7\pos(%d,%d)\bord0\shad0\1c&H%s&\1a&H%s&\p1}%s{\p0}"
    return f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Btn,Inter,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:10.00,Btn,,0,0,0,,{shape % (w // 2 - r, h // 2 - r, "181114", "40", circle)}
Dialogue: 1,0:00:00.00,0:00:10.00,Btn,,0,0,0,,{shape % (w // 2 - round(tw / 3), h // 2 - round(th / 2), "FFFFFF", "00", triangle)}
"""


def gif(pid: str) -> None:
    """exports/share.gif: the first 3 seconds of the exported video on a loop, without sound, with a play button on top."""
    ex = project_dir(pid) / "exports"
    src = ex / "export.mp4"
    if not src.is_file():
        raise SystemExit("gif: export the video first")
    w, h = _size(src, read_json(ex / "export.json", {}) or {})
    out_w = GIF_TALL if h > w else GIF_WIDE
    out_h = max(2, round(h * out_w / w / 2) * 2)
    (ex / "share.ass").write_text(_button(out_w, out_h))
    graph = (f"[0:v]fps={GIF_FPS},scale={out_w}:{out_h}:flags=lanczos,subtitles=share.ass:fontsdir={FONTS},split[a][b];"
             "[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle")
    try:
        # Written under another name first, so a half-made GIF is never sent to anyone.
        run(["ffmpeg", "-y", "-v", "error", "-t", str(GIF_SECONDS), "-i", "export.mp4", "-an",
             "-filter_complex", graph, "-loop", "0", "share.tmp.gif"], cwd=ex, timeout=100)
        (ex / "share.tmp.gif").replace(ex / "share.gif")
    finally:
        (ex / "share.ass").unlink(missing_ok=True)
        (ex / "share.tmp.gif").unlink(missing_ok=True)
    print(f"gif: {out_w}x{out_h}, {(ex / 'share.gif').stat().st_size} bytes")
