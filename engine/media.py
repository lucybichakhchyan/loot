"""Steps that use FFmpeg, DeepFilterNet and Whisper. No Claude and no tokens.

A project is a list of clips. Each clip has a screen recording, a camera
recording, or both. The heavy work happens once per clip, right after it
uploads (`prep`), so that opening the editor only has to join the clips:

  per clip   screen.mp4, cam.mp4, audio.wav, audio_clean.wav, words.json
  project    screen_all.mp4, cam_all.mp4, audio_raw/clean (.wav and .m4a),
             transcript.json, timeline.json
"""
import json
import re
import shutil
import tempfile
import threading
from pathlib import Path

from .common import project_dir, read_json, run, set_status, write_json

LOUDNESS_TARGET = -14.0  # LUFS, YouTube's reference level
FPS = 30
CAM_W, CAM_H = 1280, 720
PREP_VERSION = 3  # raise this to make every clip prepare again after the settings below change


def _encode(crf: int) -> list:
    """Quick to encode, light enough to stream two at once, and a keyframe every second so seeking is instant."""
    return ["-an", "-c:v", "libx264", "-preset", "superfast", "-crf", str(crf), "-g", "30",
            "-pix_fmt", "yuv420p", "-video_track_timescale", "15360"]


SCREEN_ENCODE, CAM_ENCODE = _encode(20), _encode(22)


def _probe_file(path: Path) -> dict:
    out = run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)])
    info = json.loads(out.stdout)
    video = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in info.get("streams", []) if s.get("codec_type") == "audio"), None)
    duration = float(info.get("format", {}).get("duration") or 0)
    if not duration:
        # Browser recordings (WebM) carry no length, so read through the file once without decoding.
        p = run(["ffmpeg", "-v", "error", "-stats", "-i", str(path), "-c", "copy", "-f", "null", "-"])
        times = re.findall(r"time=(\d+):(\d+):([\d.]+)", p.stderr)
        if times:
            h, m, s = times[-1]
            duration = int(h) * 3600 + int(m) * 60 + float(s)
    return {"file": path.name, "bytes": path.stat().st_size, "duration": round(duration, 3),
            "has_video": bool(video), "has_audio": bool(audio),
            "width": video.get("width") if video else None, "height": video.get("height") if video else None}


def _uploads(cd: Path) -> dict:
    found = {}
    for kind in ("screen", "cam"):
        files = sorted(cd.glob(f"{kind}_upload.*"))
        if files:
            found[kind] = files[0]
    return found


def _even(n: float) -> int:
    return max(2, int(n) // 2 * 2)


def _loudness(path: Path) -> float | None:
    p = run(["ffmpeg", "-v", "info", "-nostats", "-i", str(path), "-af", "ebur128=framelog=quiet", "-f", "null", "-"])
    m = re.findall(r"I:\s*(-?[\d.]+) LUFS", p.stderr)
    return float(m[-1]) if m and float(m[-1]) > -69 else None


NOISE_LIMIT_DB = 14  # how much background noise may be removed; higher sounds cleaner but less natural


def _level(src: Path, dst: Path, extra: str = "") -> float | None:
    """Plain volume change to YouTube's loudness, with a limiter for the peaks. It does not reshape the voice."""
    now = _loudness(src)
    gain = 0.0 if now is None else max(-20.0, min(45.0, LOUDNESS_TARGET - now))
    run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-af",
         f"{extra}volume={gain:.1f}dB,alimiter=limit=0.84:level=0:attack=5:release=80",
         "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", str(dst)])
    return now


def clean_audio(source: Path, original: Path, clean: Path) -> dict:
    """Write two versions of the sound, both at YouTube's loudness.

    `original` is the microphone as recorded, only made louder or quieter.
    `clean` also has background noise turned down, gently, so the voice stays natural.
    If noise removal fails, `clean` is a copy of `original` and the note says so.
    """
    before = _level(source, original)
    cleaner, note = "deepfilternet", None
    with tempfile.TemporaryDirectory() as tmp:
        try:
            if not shutil.which("deep-filter"):
                raise RuntimeError("deep-filter is not installed")
            run(["deep-filter", "-D", "-a", str(NOISE_LIMIT_DB), "-o", tmp, str(original)], timeout=1500)
            denoised = Path(tmp) / original.name
            if not denoised.exists() or denoised.stat().st_size < 1000:
                raise RuntimeError("deep-filter wrote no audio")
            kept = _loudness(denoised)
            if kept is None or kept < LOUDNESS_TARGET - 8:
                # The noise remover took the voice along with the noise. Never ship that.
                raise RuntimeError("noise removal took too much of the voice")
            _level(denoised, clean, extra="highpass=f=70,")
        except (SystemExit, Exception) as e:  # noqa: BLE001 - any failure falls back
            cleaner = "none"
            note = f"Noise removal failed, so the cleaned sound is the same as the original. ({str(e).splitlines()[0][:160]})"
            shutil.copy(original, clean)
    return {"cleaner": cleaner, "note": note, "loudness_before": before, "loudness_after": _loudness(clean),
            "loudness_target": LOUDNESS_TARGET, "noise_limit_db": NOISE_LIMIT_DB,
            "quiet_microphone": before is not None and before < -35}


def _signature(files: dict) -> dict:
    return {k: [f.name, f.stat().st_size, int(f.stat().st_mtime)] for k, f in files.items()}


def _canvas(d: Path, first_screen: dict | None) -> list | None:
    """The size every screen recording of this project is fitted to. Set by the first screen clip."""
    saved = read_json(d / "canvas.json")
    if saved or not first_screen:
        return saved
    scale = min(1.0, 1920 / first_screen["width"], 1080 / first_screen["height"])
    size = [_even(first_screen["width"] * scale), _even(first_screen["height"] * scale)]
    write_json(d / "canvas.json", size)
    return size


def prep_clip(d: Path, cid: str, force: bool = False) -> dict:
    """All the heavy work for one clip: steady 30 fps video, clean sound and a word-timed transcript."""
    cd = d / "clips" / cid
    files = _uploads(cd)
    if not files:
        raise SystemExit(f"clip {cid} has no uploaded file")
    done = read_json(cd / "prep.json")
    if done and not force and done.get("v") == PREP_VERSION and done.get("inputs") == _signature(files) and (cd / "audio_clean.wav").exists() \
            and (cd / "words.json").exists() and (not done["screen"] or done.get("canvas") == read_json(d / "canvas.json")):
        return done
    pr = {k: _probe_file(f) for k, f in files.items()}
    if not any(v["has_video"] or v["has_audio"] for v in pr.values()):
        raise SystemExit(f"clip {cid} has no video or audio that FFmpeg can read")
    has_screen = "screen" in pr and pr["screen"]["has_video"]
    has_cam = "cam" in pr and pr["cam"]["has_video"]
    sound = next((k for k in ("cam", "screen") if k in pr and pr[k]["has_audio"]), None)
    length = pr[sound]["duration"] if sound else max(v["duration"] for v in pr.values())
    frames = max(1, round(length * FPS))
    length = frames / FPS
    canvas = _canvas(d, pr["screen"] if has_screen else None)

    def encode_video():
        if has_screen:
            w, h = canvas
            vf = (f"fps={FPS},scale={w}:{h}:force_original_aspect_ratio=decrease,"
                  f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,tpad=stop_mode=clone:stop_duration=3600")
            run(["ffmpeg", "-y", "-v", "error", "-i", str(files["screen"]), "-vf", vf, "-frames:v", str(frames), *SCREEN_ENCODE, str(cd / "screen.mp4")])
        if has_cam:
            vf = (f"fps={FPS},scale={CAM_W}:{CAM_H}:force_original_aspect_ratio=increase,crop={CAM_W}:{CAM_H},"
                  f"setsar=1,tpad=stop_mode=clone:stop_duration=3600")
            run(["ffmpeg", "-y", "-v", "error", "-i", str(files["cam"]), "-vf", vf, "-frames:v", str(frames), *CAM_ENCODE, str(cd / "cam.mp4")])

    # The video encodes on one core while the sound and transcript use the other.
    failure = []
    worker = threading.Thread(target=lambda: _guard(encode_video, failure))
    worker.start()
    raw, clean = cd / "audio.wav", cd / "audio_clean.wav"
    exact = ["-t", f"{length:.6f}", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le"]
    audio_info, words = {"cleaner": None, "note": "This clip has no sound."}, []
    if sound:
        tmp = {n: cd / f"{n}.tmp.wav" for n in ("source", "original", "clean")}
        run(["ffmpeg", "-y", "-v", "error", "-i", str(files[sound]), "-vn", "-ac", "1", "-ar", "48000",
             "-c:a", "pcm_s16le", str(tmp["source"])])
        audio_info = clean_audio(tmp["source"], tmp["original"], tmp["clean"])
        # Keep both versions exactly as long as the video, so clips join without drift.
        for name, target in (("original", raw), ("clean", clean)):
            run(["ffmpeg", "-y", "-v", "error", "-i", str(tmp[name]), "-af", "apad", *exact, str(target)])
        for f in tmp.values():
            f.unlink(missing_ok=True)
        from .words import transcribe_file
        words = transcribe_file(clean)
    else:
        for target in (raw, clean):
            run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", *exact, str(target)])
    write_json(cd / "words.json", words)
    worker.join()
    if failure:
        raise failure[0]
    done = {"v": PREP_VERSION, "inputs": _signature(files), "canvas": canvas if has_screen else None, "frames": frames, "duration": length,
            "screen": has_screen, "cam": has_cam, "sound": bool(sound), "audio": audio_info, "words": len(words)}
    write_json(cd / "prep.json", done)
    return done


def _guard(fn, failure: list) -> None:
    try:
        fn()
    except BaseException as e:  # noqa: BLE001 - re-raised on the main thread
        failure.append(e)


def prep(pid: str, cid: str) -> None:
    """Prepare one clip. Runs in the background as soon as the clip uploads."""
    d = project_dir(pid)
    if not re.match(r"^[a-z0-9]{8}$", cid) or not (d / "clips" / cid).is_dir():
        print(f"prep: clip {cid} is gone, nothing to do")
        return
    done = prep_clip(d, cid)
    print(json.dumps({"clip": cid, "seconds": round(done["duration"], 1), "words": done["words"]}))


def prepare(pid: str) -> None:
    """Prepare every clip that isn't prepared yet. Clips prepared at upload time are skipped."""
    d = project_dir(pid)
    clips = (read_json(d / "status.json", {}) or {}).get("clips") or []
    if not clips:
        raise SystemExit("the project has no clips yet")
    for c in clips:
        prep_clip(d, c["id"])
    set_status(pid, step={"prepare": "done"})
    print(f"prepare: {len(clips)} clips ready")


def assemble(pid: str) -> None:
    """Join the prepared clips into one timeline. Nothing is re-encoded, so this takes seconds."""
    d = project_dir(pid)
    clips = (read_json(d / "status.json", {}) or {}).get("clips") or []
    for stale in ("silences.json", "fillers.json"):  # rebuilt by the next steps for the new timeline
        (d / stale).unlink(missing_ok=True)
    preps = {c["id"]: prep_clip(d, c["id"]) for c in clips}
    any_screen = any(p["screen"] for p in preps.values())
    any_cam = any(p["cam"] for p in preps.values())
    canvas = read_json(d / "canvas.json") if any_screen else None

    timeline, words, t = [], [], 0.0
    lists = {"screen": [], "cam": [], "raw": [], "clean": []}
    notes, before, after, quiet = [], [], [], False
    for c in clips:
        cd, p = d / "clips" / c["id"], preps[c["id"]]
        for kind, wanted, size in (("screen", any_screen, canvas), ("cam", any_cam, [CAM_W, CAM_H])):
            if not wanted:
                continue
            if p[kind]:
                lists[kind].append(cd / f"{kind}.mp4")
            else:  # this clip has no such recording: fill its place with black so the timeline stays in step
                blank = cd / f"{kind}_blank.mp4"
                run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=black:s={size[0]}x{size[1]}:r={FPS}",
                     "-frames:v", str(p["frames"]), *(SCREEN_ENCODE if kind == "screen" else CAM_ENCODE), str(blank)])
                lists[kind].append(blank)
        lists["raw"].append(cd / "audio.wav")
        lists["clean"].append(cd / "audio_clean.wav")
        for w in read_json(cd / "words.json", []) or []:
            if w["start"] < p["duration"]:
                words.append({"i": len(words), "w": w["w"], "start": round(w["start"] + t, 3),
                              "end": round(min(w["end"], p["duration"]) + t, 3)})
        a = p.get("audio") or {}
        if a.get("note") and a["note"] not in notes:
            notes.append(a["note"])
        if a.get("loudness_before") is not None:
            before.append(a["loudness_before"])
            after.append(a.get("loudness_after"))
            quiet = quiet or bool(a.get("quiet_microphone"))
        timeline.append({"id": c["id"], "start": round(t, 4), "end": round(t + p["duration"], 4),
                         "screen": p["screen"], "cam": p["cam"], "sound": p["sound"]})
        t += p["duration"]

    for kind, name in (("screen", "screen_all.mp4"), ("cam", "cam_all.mp4"), ("raw", "audio_raw.wav"), ("clean", "audio_clean.wav")):
        target = d / name
        if not lists[kind]:
            target.unlink(missing_ok=True)
            continue
        listing = d / f"{kind}.concat.txt"
        listing.write_text("".join(f"file '{p}'\n" for p in lists[kind]))
        extra = ["-movflags", "+faststart"] if name.endswith(".mp4") else []
        run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", *extra, str(target)])
        listing.unlink()
    for wav in (d / "audio_raw.wav", d / "audio_clean.wav"):  # small copies for listening in the browser
        run(["ffmpeg", "-y", "-v", "error", "-i", str(wav), "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
             str(wav.with_suffix(".m4a"))])
    source = d / ("screen_all.mp4" if any_screen else "cam_all.mp4")
    if source.exists():
        run(["ffmpeg", "-y", "-v", "error", "-ss", f"{min(1.0, t / 2):.2f}", "-i", str(source), "-frames:v", "1",
             "-vf", "scale=640:-2", "-q:v", "4", str(d / "thumb.jpg")])

    write_json(d / "transcript.json", {"words": words, "text": " ".join(w["w"] for w in words)})
    write_json(d / "timeline.json", {"duration": round(t, 4), "fps": FPS, "clips": timeline,
                                     "screen": {"w": canvas[0], "h": canvas[1]} if canvas else None,
                                     "cam": {"w": CAM_W, "h": CAM_H} if any_cam else None})
    clean_after = [x for x in after if x is not None]
    write_json(d / "audio.json", {"note": " ".join(notes) or None,
                                  "loudness_before": round(sum(before) / len(before), 1) if before else None,
                                  "loudness_after": round(sum(clean_after) / len(clean_after), 1) if clean_after else None,
                                  "loudness_target": LOUDNESS_TARGET, "quiet_microphone": quiet})
    set_status(pid, duration=round(t, 3), word_count=len(words), step={"assemble": "done"})
    print(f"assemble: {len(timeline)} clips, {t:.1f} seconds, {len(words)} words")


def silences(pid: str, min_len: float = 0.6) -> None:
    """Pauses are the gaps between spoken words. This stays right even when the room is noisy or the microphone is quiet."""
    d = project_dir(pid)
    words = (read_json(d / "transcript.json", {}) or {}).get("words", [])
    total = (read_json(d / "timeline.json", {}) or {}).get("duration", 0)
    edges = [0.0] + [t for w in words for t in (w["start"], w["end"])] + [total]
    found = []
    for i in range(0, len(edges) - 1, 2):
        start, end = edges[i], edges[i + 1]
        if words and end - start >= min_len:
            found.append({"start": round(start, 3), "end": round(end, 3), "seconds": round(end - start, 3)})
    write_json(d / "silences.json", {"min_seconds": min_len, "silences": found,
                                     "total_seconds": round(sum(x["seconds"] for x in found), 2)})
    set_status(pid, step={"silences": "done"})
    print(f"silences: {len(found)} found")
