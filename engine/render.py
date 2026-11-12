"""Export: apply the cuts, lay out camera and screen, burn in captions, and write an MP4.

Everything here is FFmpeg and plain code. No Claude and no tokens.
"""
import json
import os
import re
import subprocess
import time
from pathlib import Path

from .common import project_dir, read_json, run, set_status, write_json
from .media import FPS, LOUDNESS_TARGET, _loudness

FONTS = os.environ.get("LOOT_FONTS", "/app/app/static/fonts")
BACKGROUNDS = {"glow": None, "charcoal": "1A1A1A", "purple": "2D253A", "offwhite": "F6F6F4", "bright": "8A2BE2"}
OWNER_NAME = os.environ.get("LOOT_OWNER_NAME", "Lucy Bichakhchyan")


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


def write_srt(chunks: list, path: Path) -> None:
    lines = []
    for n, c in enumerate(chunks, 1):
        end = c[-1]["end"] + 0.15
        if n < len(chunks):
            end = min(end, chunks[n][0]["start"])
        lines.append(f"{n}\n{_srt_time(c[0]['start'])} --> {_srt_time(end)}\n{' '.join(w['w'] for w in c)}\n")
    path.write_text("\n".join(lines))


def write_ass(chunks: list, path: Path, w: int, h: int, style: str, low: bool, show_name: bool, total: float) -> None:
    vertical = h > w
    size = round(h * (0.04 if vertical else 0.058))
    margin = round(h * (0.03 if low else 0.09))
    if vertical:
        margin = round(h * 0.42)
    base = f"Style: Cap,Inter,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,-1,0,0,0,100,100,0,0,1,0,3,2,40,40,{margin},1"
    em = r"{\fnPlayfair Display\i1}"
    if style == "boxed":
        base = f"Style: Cap,Inter,{size},&H00FFFFFF,&H00FFFFFF,&H001A1A1A,&H001A1A1A,-1,0,0,0,100,100,0,0,3,{round(size * .22)},0,2,40,40,{margin},1"
        em = r"{\fnPlayfair Display\i1\c&HF08CAB&}"
    elif style == "plain":
        base = f"Style: Cap,Inter,{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&HB4000000,0,0,0,0,100,100,0,0,1,1,2,2,40,40,{margin},1"
        em = ""
    name_size = round(w * (0.034 if vertical else 0.02))
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {w}
PlayResY: {h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{base}
Style: Name,Playfair Display,{name_size},&H1AFFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,-1,0,0,100,100,0,0,1,0,1,7,{round(w * .03)},40,{round(h * .04)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    if show_name and OWNER_NAME:
        events.append(f"Dialogue: 0,{_ass_time(0)},{_ass_time(total)},Name,,0,0,0,,{OWNER_NAME}")
    for n, c in enumerate(chunks):
        chunk_end = c[-1]["end"] + 0.15
        if n + 1 < len(chunks):
            chunk_end = min(chunk_end, chunks[n + 1][0]["start"])
        for i, word in enumerate(c):
            start = word["start"] if i else c[0]["start"]
            end = c[i + 1]["start"] if i + 1 < len(c) else chunk_end
            if end <= start:
                continue
            parts = [(em + x["w"] + r"{\r}") if (j == i and em) else x["w"] for j, x in enumerate(c)]
            events.append(f"Dialogue: 1,{_ass_time(start)},{_ass_time(end)},Cap,,0,0,0,,{' '.join(parts)}")
    path.write_text(head + "\n".join(events) + "\n")


# ---------- layout ----------

def geometry(layout: str, w: int, h: int) -> dict:
    """Boxes for the screen and the camera, matching the editor preview (design/app.css)."""
    def box(left, top, right, bottom):
        return {"x": round(w * left), "y": round(h * top), "w": round(w * (1 - left - right)) // 2 * 2,
                "h": round(h * (1 - top - bottom)) // 2 * 2}
    if h > w:  # vertical short: screen on top, camera circle below
        d = round(w * 0.62) // 2 * 2
        if layout in ("bubble", "side"):
            return {"screen": box(.05, .05, .05, .44), "cam": {"x": round(w * .19), "y": h - round(h * .05) - d, "w": d, "h": d, "round": True}}
    if layout == "bubble":
        d = round(w * 0.18) // 2 * 2
        return {"screen": box(.06, .07, .06, .07),
                "cam": {"x": w - round(w * .04) - d, "y": h - round(h * .06) - d, "w": d, "h": d, "round": True}}
    if layout == "side":
        return {"screen": box(.04, .12, .40, .12), "cam": box(.63, .12, .04, .12)}
    if layout == "cam":
        return {"cam": {"x": 0, "y": 0, "w": w, "h": h}}
    return {"screen": box(.03, .04, .03, .04)}


def _still(args: list, out: Path) -> None:
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", args[0], "-frames:v", "1", *args[1:], str(out)])


def render(pid: str) -> None:
    d = project_dir(pid)
    ex = d / "exports"
    ex.mkdir(exist_ok=True)
    state_file = ex / "export.json"
    request = read_json(state_file, {}) or {}
    started = time.time()

    def progress(**fields):
        write_json(state_file, {**request, "started_at": started, "updated_at": time.time(), **fields})

    try:
        _render(d, ex, request, progress)
    except BaseException as e:  # noqa: BLE001 - record every failure for the editor
        progress(state="failed", error=str(e)[-600:])
        raise
    set_status(pid, exported_at=time.time(), media_deleted_at=None)


def _render(d: Path, ex: Path, request: dict, progress) -> None:
    timeline = read_json(d / "timeline.json")
    if not timeline:
        raise SystemExit("render: the recording has not been processed yet")
    edit = read_json(d / "edit.json", {}) or {}
    status = read_json(d / "status.json", {}) or {}
    words = (read_json(d / "transcript.json", {}) or {}).get("words", [])

    vertical = status.get("kind") == "short"
    long_side = 1280 if request.get("quality") == "720" else 1920
    w, h = (long_side * 9 // 16, long_side) if vertical else (long_side, long_side * 9 // 16)
    total_frames = round(timeline["duration"] * FPS)
    kept = kept_frames(edit.get("removed") or [], total_frames)
    if not kept:
        raise SystemExit("render: every part of the video is cut, so there is nothing to export")
    out_frames = sum(b - a + 1 for a, b in kept)
    out_seconds = out_frames / FPS

    has_screen, has_cam = bool(timeline.get("screen")), bool(timeline.get("cam"))
    layout = edit.get("layout") or "bubble"
    if not has_screen:
        layout = "cam"
    elif not has_cam:
        layout = "screen"
    geo = geometry(layout, w, h)

    # Captions
    captions = request.get("captions", "burn") if (edit.get("captions", {}).get("on", True) and words) else "none"
    chunks = caption_chunks(words, kept) if words else []
    if chunks:
        write_srt(chunks, ex / "captions.srt")
    show_name = bool(edit.get("name", {}).get("on", False))
    burn = captions == "burn" and chunks
    if burn or show_name:
        write_ass(chunks if burn else [], ex / "captions.ass", w, h, edit.get("captions", {}).get("style", ""),
                  low=layout in ("side", "screen") and not vertical, show_name=show_name, total=out_seconds)

    # Still images: background, and the round camera mask with its ring
    bg = edit.get("bg") or "glow"
    if BACKGROUNDS.get(bg):
        _still([f"color=c=0x{BACKGROUNDS[bg]}:s={w}x{h}"], ex / "bg.png")
    else:
        _still([f"gradients=s={w}x{h}:c0=0x3a2a55:c1=0x141118:x0={w * .8:.0f}:y0={h * .1:.0f}:x1=0:y1={h}:type=radial:n=2"], ex / "bg.png")
    inputs = ["-loop", "1", "-framerate", str(FPS), "-i", "bg.png"]
    select = "+".join(f"between(n,{a},{b})" for a, b in kept)
    cut = f"select='{select}',setpts=N/({FPS}*TB)"
    graph, last, n = [], "0:v", 1

    if "screen" in geo:
        g = geo["screen"]
        inputs += ["-i", str(d / "screen_all.mp4")]
        graph.append(f"[{n}:v]{cut},scale={g['w']}:{g['h']}:force_original_aspect_ratio=decrease:flags=lanczos[scr]")
        graph.append(f"[{last}][scr]overlay=x={g['x']}+({g['w']}-w)/2:y={g['y']}+({g['h']}-h)/2[v{n}]")
        last, n = f"v{n}", n + 1
    if "cam" in geo:
        g = geo["cam"]
        inputs += ["-i", str(d / "cam_all.mp4")]
        cam_in = n
        n += 1
        fill = f"scale={g['w']}:{g['h']}:force_original_aspect_ratio=increase,crop={g['w']}:{g['h']}"
        if g.get("round"):
            ring = max(4, round(w * 0.002) * 2)
            size = g["w"] + ring * 2
            circle = "if(lte(hypot(X-(W-1)/2,Y-(H-1)/2),W/2),255,0)"
            _still([f"color=black:s={g['w']}x{g['h']},format=gray,geq=lum='{circle}'"], ex / "mask.png")
            _still([f"color=white:s={size}x{size},format=rgba,geq=r=246:g=246:b=244:a='{circle}'"], ex / "ring.png")
            inputs += ["-loop", "1", "-framerate", str(FPS), "-i", "mask.png", "-loop", "1", "-framerate", str(FPS), "-i", "ring.png"]
            graph.append(f"[{cam_in}:v]{cut},crop=ih:ih,scale={g['w']}:{g['h']},format=rgba[camsq]")
            graph.append(f"[{n}:v]format=gray[mask]")
            graph.append("[camsq][mask]alphamerge[camc]")
            graph.append(f"[{last}][{n + 1}:v]overlay=x={g['x'] - ring}:y={g['y'] - ring}[vr]")
            graph.append(f"[vr][camc]overlay=x={g['x']}:y={g['y']}[vc]")
            n += 2
        elif layout == "cam":
            graph.append(f"[{cam_in}:v]{cut},{fill}[vc]")
        else:
            graph.append(f"[{cam_in}:v]{cut},{fill}[camb]")
            graph.append(f"[{last}][camb]overlay=x={g['x']}:y={g['y']}[vc]")
        last = "vc"
    if burn or show_name:
        graph.append(f"[{last}]subtitles=captions.ass:fontsdir={FONTS}[vs]")
        last = "vs"
    graph.append(f"[{last}]format=yuv420p[vout]")

    # Sound: the same kept ranges, with 5 ms fades so cuts don't click
    sound = d / ("audio_clean.wav" if edit.get("clean", True) and (d / "audio_clean.wav").exists() else "audio_raw.wav")
    inputs += ["-i", str(sound)]
    parts = []
    for i, (a, b) in enumerate(kept):
        length = (b - a + 1) / FPS
        fade = f",afade=t=in:d=0.005,afade=t=out:st={max(0, length - 0.005):.4f}:d=0.005" if length > 0.02 else ""
        graph.append(f"[{n}:a]atrim={a / FPS:.5f}:{(b + 1) / FPS:.5f},asetpts=PTS-STARTPTS{fade}[a{i}]")
        parts.append(f"[a{i}]")
    graph.append(f"{''.join(parts)}concat=n={len(parts)}:v=0:a=1[aout]")
    (ex / "graph.txt").write_text(";\n".join(graph))

    target = ex / "export.tmp.mp4"
    cmd = ["ffmpeg", "-y", "-v", "error", "-nostats", "-progress", "pipe:1", *inputs,
           "-filter_complex_script", "graph.txt", "-map", "[vout]", "-map", "[aout]",
           "-t", f"{out_seconds:.5f}", "-r", str(FPS), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(target)]
    progress(state="rendering", pct=0, seconds=round(out_seconds, 1))
    proc = subprocess.Popen(cmd, cwd=ex, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    last_write = 0.0
    for line in proc.stdout:
        m = re.match(r"out_time_us=(\d+)", line)
        if m and time.time() - last_write > 1.5:
            last_write = time.time()
            progress(state="rendering", pct=min(99, round(100 * int(m.group(1)) / 1e6 / out_seconds)),
                     seconds=round(out_seconds, 1))
    err = proc.stderr.read()
    if proc.wait() != 0:
        raise SystemExit("render: FFmpeg stopped: " + "\n".join(err.strip().splitlines()[-6:]))
    final = ex / "export.mp4"
    target.replace(final)
    for junk in ("bg.png", "mask.png", "ring.png", "graph.txt"):
        (ex / junk).unlink(missing_ok=True)
    loud = _loudness(final)
    progress(state="done", pct=100, seconds=round(out_seconds, 1), bytes=final.stat().st_size,
             width=w, height=h, layout=layout, loudness=loud,
             loudness_ok=loud is not None and abs(loud - LOUDNESS_TARGET) <= 2.5,
             captions=captions, has_srt=bool(chunks))
    print(json.dumps({"export": final.name, "seconds": round(out_seconds, 1), "bytes": final.stat().st_size, "loudness": loud}))
