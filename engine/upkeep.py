"""Nightly cleanup and the morning health check. No Claude and no tokens."""
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

from .common import BACKUPS, DATA, PROJECTS, REPORTS, read_json, write_json

KEEP_DAYS = float(os.environ.get("LOOT_KEEP_DAYS", "3"))
MEDIA = ("clips", "exports", "canvas.json", "screen_all.mp4", "cam_all.mp4", "audio_raw.wav", "audio_clean.wav", "audio_raw.m4a", "audio_clean.m4a")


def cleanup() -> None:
    """Delete video files of projects exported more than KEEP_DAYS ago. Records stay."""
    now, removed, freed, waiting = time.time(), [], 0, 0
    for d in sorted(PROJECTS.glob("*")) if PROJECTS.exists() else []:
        status = read_json(d / "status.json", {}) or {}
        exported = status.get("exported_at")
        if not exported:
            waiting += 1
            continue
        if now - exported < KEEP_DAYS * 86400 or status.get("media_deleted_at"):
            continue
        for name in MEDIA:
            f = d / name
            if f.is_dir():
                freed += sum(x.stat().st_size for x in f.rglob("*") if x.is_file())
                shutil.rmtree(f)
            elif f.exists():
                freed += f.stat().st_size
                f.unlink()
        status["media_deleted_at"] = now
        write_json(d / "status.json", status)
        removed.append(d.name)
    disk = shutil.disk_usage(DATA)
    used_pct = round(100 * disk.used / disk.total, 1)
    report = {"ran_at": now, "keep_days": KEEP_DAYS, "projects_cleaned": removed,
              "bytes_freed": freed, "not_exported_yet": waiting,
              "disk_used_pct": used_pct, "disk_free_gb": round(disk.free / 1e9, 1),
              "warning": "The disk is over 80% full." if used_pct > 80 else None}
    write_json(REPORTS / "cleanup.json", report)
    print(json.dumps(report))


def _ok(cmd: list, timeout: int = 120) -> tuple[bool, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode == 0, (p.stderr or p.stdout).strip().splitlines()[-1][:200] if (p.stderr or p.stdout).strip() else ""
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:200]


def health() -> None:
    """Run a 3 second test clip through each tool, and back up the project records."""
    checks = {}
    with tempfile.TemporaryDirectory() as tmp:
        clip, wav = Path(tmp) / "t.mp4", Path(tmp) / "t.wav"
        checks["ffmpeg"] = _ok(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=d=3:s=640x360:r=30",
                                "-f", "lavfi", "-i", "sine=f=220:d=3", "-shortest", "-c:v", "libx264",
                                "-preset", "ultrafast", "-c:a", "aac", str(clip)])
        checks["extract_audio"] = _ok(["ffmpeg", "-y", "-v", "error", "-i", str(clip), "-vn", "-ac", "1",
                                       "-ar", "48000", str(wav)])
        checks["noise_removal"] = _ok(["deep-filter", "-o", tmp + "/out", str(wav)], timeout=300)
        try:
            from faster_whisper import WhisperModel
            from .words import WHISPER_DIR, WHISPER_MODEL, load_16k
            model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root=WHISPER_DIR)
            list(model.transcribe(load_16k(wav))[0])
            checks["whisper"] = (True, WHISPER_MODEL)
        except Exception as e:  # noqa: BLE001
            checks["whisper"] = (False, str(e)[:200])

    BACKUPS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d")
    backup = BACKUPS / f"records-{stamp}.tar.gz"
    with tarfile.open(backup, "w:gz") as tar:
        for f in PROJECTS.glob("*/*.json") if PROJECTS.exists() else []:
            tar.add(f, arcname=str(f.relative_to(DATA)))
    for old in sorted(BACKUPS.glob("records-*.tar.gz"))[:-14]:
        old.unlink()

    disk = shutil.disk_usage(DATA)
    report = {"ran_at": time.time(),
              "checks": {k: {"ok": ok, "detail": detail} for k, (ok, detail) in checks.items()},
              "claude_key_set": bool(os.environ.get("ANTHROPIC_API_KEY")),
              "backup": backup.name, "disk_free_gb": round(disk.free / 1e9, 1)}
    report["healthy"] = all(c["ok"] for c in report["checks"].values())
    write_json(REPORTS / "health.json", report)
    print(json.dumps(report))
    if not report["healthy"]:
        raise SystemExit("health: at least one check failed")
