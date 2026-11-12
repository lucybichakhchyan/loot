"""Shared helpers for the LOOT engine: where files live and how status is saved."""
import json
import os
import re
import subprocess
import time
from pathlib import Path

DATA = Path(os.environ.get("LOOT_DATA", "/data"))
PROJECTS = DATA / "projects"
REPORTS = DATA / "reports"
BACKUPS = DATA / "backups"
ID_RE = re.compile(r"^[a-z0-9]{12}$")


def project_dir(pid: str) -> Path:
    if not ID_RE.match(pid):
        raise SystemExit(f"bad project id: {pid!r}")
    d = PROJECTS / pid
    if not d.is_dir():
        raise SystemExit(f"no such project: {pid}")
    return d


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return default


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    tmp.replace(path)


def set_status(pid: str, **fields) -> dict:
    """Merge fields into the project's status.json and stamp the time."""
    path = PROJECTS / pid / "status.json"
    status = read_json(path, {}) or {}
    steps = fields.pop("step", None)
    if steps:
        status.setdefault("steps", {}).update(steps)
    status.update(fields)
    status["updated_at"] = time.time()
    write_json(path, status)
    return status


def run(cmd: list, **kw) -> subprocess.CompletedProcess:
    """Run a command and fail loudly with its last lines of output."""
    p = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if p.returncode != 0:
        tail = "\n".join((p.stderr or p.stdout or "").strip().splitlines()[-12:])
        raise SystemExit(f"command failed ({p.returncode}): {' '.join(map(str, cmd[:4]))} ...\n{tail}")
    return p


def fresh(output: Path, *inputs: Path) -> bool:
    """True when output exists and is newer than every input, so the step can be skipped."""
    if not output.exists() or output.stat().st_size == 0:
        return False
    return all(i.exists() and output.stat().st_mtime >= i.stat().st_mtime for i in inputs)


def source_file(d: Path) -> Path:
    for f in sorted(d.glob("source.*")):
        return f
    raise SystemExit("the project has no uploaded source file")
