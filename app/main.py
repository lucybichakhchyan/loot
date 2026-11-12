"""LOOT web app: sign-in, the three screens, and the JSON API they use."""
import hmac
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, TimestampSigner

from engine.common import DATA, ID_RE, PROJECTS, REPORTS, read_json, set_status, write_json

HERE = Path(__file__).parent
PASSWORD = os.environ.get("LOOT_PASSWORD", "")
SIGNER = TimestampSigner(os.environ.get("LOOT_SECRET") or secrets.token_hex(32))
AUTOMATION = Path(os.environ.get("LOOT_AUTOMATION", "/data/automation"))
COOKIE, SESSION_DAYS = "loot_session", 30
MAX_UPLOAD = int(float(os.environ.get("LOOT_MAX_UPLOAD_GB", "4")) * 1e9)
UPLOAD_TYPES = {".mp4", ".webm", ".mov", ".mkv", ".m4v"}
MEDIA = {"screen_all.mp4", "cam_all.mp4", "audio_clean.m4a", "audio_raw.m4a", "thumb.jpg"}
KINDS = {"long", "short", "msg", "demo"}
STEPS = ("prepare", "assemble", "silences", "fillers", "cuts", "describe")
CID_RE = re.compile(r"^[a-z0-9]{8}$")

app = FastAPI(title="LOOT", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
jobs: "queue.Queue[tuple]" = queue.Queue()
login_attempts: dict[str, list[float]] = {}


# ---------- sign-in ----------

def signed_in(request: Request) -> bool:
    token = request.cookies.get(COOKIE)
    if not token:
        return False
    try:
        SIGNER.unsign(token, max_age=SESSION_DAYS * 86400)
        return True
    except BadSignature:
        return False


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if path in ("/login", "/healthz") or path.startswith("/static/") or signed_in(request):
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"detail": "Sign in first."}, status_code=401)
    return RedirectResponse("/login", status_code=303)


@app.get("/login")
def login_form(error: str = ""):
    note = ('<div class="notice err"><span class="dot"></span><span class="grow">That password was not right.</span></div>'
            if error else "")
    return HTMLResponse(f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · LOOT</title>
<link rel="stylesheet" href="/static/tokens.css"><link rel="stylesheet" href="/static/app.css">
<style>body{{min-height:100vh;display:grid;place-items:center}}
form{{width:min(340px,calc(100vw - 32px));display:flex;flex-direction:column;gap:16px}}
.wordmark{{font-size:15px}}.btn{{width:100%}}</style></head><body>
<form method="post" action="/login"><span class="wordmark">LOOT</span>{note}
<label class="field"><span class="label">Password</span>
<input class="input" type="password" name="password" autofocus required autocomplete="current-password"></label>
<button class="btn primary lg">Sign in</button></form></body></html>""")


@app.post("/login")
async def login(request: Request):
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0]
    recent = [t for t in login_attempts.get(ip, []) if time.time() - t < 300]
    if len(recent) >= 8:
        raise HTTPException(429, "Too many tries. Wait five minutes.")
    form = await request.form()
    if not PASSWORD or not hmac.compare_digest(str(form.get("password", "")).encode(), PASSWORD.encode()):
        login_attempts[ip] = recent + [time.time()]
        return RedirectResponse("/login?error=1", status_code=303)
    response = RedirectResponse("/", status_code=303)
    response.set_cookie(COOKIE, SIGNER.sign(secrets.token_hex(8)).decode(), max_age=SESSION_DAYS * 86400,
                        httponly=True, secure=True, samesite="lax")
    return response


@app.post("/logout")
def logout():
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(COOKIE)
    return response


@app.get("/healthz")
def healthz():
    return {"ok": True}


# ---------- screens ----------

def screen_page(name: str) -> HTMLResponse:
    return HTMLResponse((HERE / "pages" / name).read_text(), headers={"Cache-Control": "no-store"})


@app.get("/")
def home():
    return screen_page("home.html")


@app.get("/record")
def record():
    return screen_page("record.html")


@app.get("/edit/{pid}")
def edit(pid: str):
    pdir(pid)
    return screen_page("edit.html")


# ---------- projects ----------

def pdir(pid: str) -> Path:
    d = PROJECTS / pid
    if not ID_RE.match(pid) or not d.is_dir():
        raise HTTPException(404, "That video doesn't exist.")
    return d


def summary(d: Path) -> dict:
    s = read_json(d / "status.json", {}) or {}
    export = read_json(d / "exports" / "export.json", {}) or {}
    done = sum(1 for k in STEPS if k in (s.get("steps") or {}))
    busy = s.get("state") in ("queued", "processing")
    return {"id": d.name, "title": s.get("title") or "Untitled video", "description": s.get("description") or "",
            "kind": s.get("kind", "long"),
            "state": s.get("state"), "error": s.get("error"), "duration": s.get("duration"),
            "created_at": s.get("created_at"), "updated_at": s.get("updated_at"),
            "progress": round(100 * done / len(STEPS)) if busy else None,
            "clips": len(s.get("clips") or []), "thumb": (d / "thumb.jpg").exists(),
            "exported": export.get("state") == "done" and (d / "exports" / "export.mp4").exists(),
            "downloaded": bool(s.get("downloaded_at")) and (s.get("downloaded_at") or 0) >= (export.get("updated_at") or 0),
            "media_deleted": bool(s.get("media_deleted_at"))}


@app.get("/api/projects")
def list_projects():
    dirs = [d for d in PROJECTS.glob("*") if d.is_dir() and ID_RE.match(d.name) and (d / "status.json").exists()] if PROJECTS.exists() else []
    items = [summary(d) for d in dirs]
    items = [i for i in items if i["state"] != "recording" or i["clips"]]
    items.sort(key=lambda i: i.get("created_at") or 0, reverse=True)
    disk = shutil.disk_usage(DATA)
    return {"projects": items, "disk_full": disk.free < 3e9,
            "disk": {"used_gb": round(disk.used / 1e9, 1), "total_gb": round(disk.total / 1e9)}}


@app.post("/api/projects")
async def create_project(request: Request):
    body = await request.json()
    kind = body.get("kind") if body.get("kind") in KINDS else "long"
    pid = secrets.token_hex(6)
    (PROJECTS / pid / "clips").mkdir(parents=True)
    write_json(PROJECTS / pid / "status.json", {"title": str(body.get("title") or "Untitled video")[:200], "kind": kind,
                                                 "created_at": time.time(), "state": "recording", "steps": {}, "clips": []})
    return {"id": pid}


async def save_upload(file: UploadFile, target: Path) -> int:
    size = 0
    with target.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD:
                out.close()
                target.unlink()
                raise HTTPException(413, "That file is too big.")
            out.write(chunk)
    return size


def ext_of(file: UploadFile) -> str:
    ext = Path(file.filename or "").suffix.lower()
    if ext in UPLOAD_TYPES:
        return ext
    return ".mp4" if "mp4" in (file.content_type or "") else ".webm"


@app.post("/api/projects/upload")
async def upload_video(file: UploadFile = File(...)):
    """A finished video file, uploaded instead of recorded. It becomes a one-clip project."""
    if Path(file.filename or "").suffix.lower() not in UPLOAD_TYPES:
        raise HTTPException(400, "LOOT can't read that kind of file. Use MP4, WebM or MOV.")
    pid, cid = secrets.token_hex(6), secrets.token_hex(4)
    cd = PROJECTS / pid / "clips" / cid
    cd.mkdir(parents=True)
    await save_upload(file, cd / f"screen_upload{ext_of(file)}")
    write_json(PROJECTS / pid / "status.json", {"title": Path(file.filename or "Uploaded video").stem[:200], "kind": "long",
                                                 "created_at": time.time(), "state": "queued", "steps": {},
                                                 "clips": [{"id": cid}], "uploaded": True})
    jobs.put(("process", pid))
    return {"id": pid}


@app.post("/api/projects/{pid}/clips")
async def add_clip(pid: str, screen: UploadFile | None = File(None), cam: UploadFile | None = File(None),
                   replace: str = "", after: str = ""):
    d = pdir(pid)
    if not screen and not cam:
        raise HTTPException(400, "The clip has no screen or camera recording.")
    cid = secrets.token_hex(4)
    cd = d / "clips" / cid
    cd.mkdir(parents=True)
    try:
        for kind, f in (("screen", screen), ("cam", cam)):
            if f:
                await save_upload(f, cd / f"{kind}_upload{ext_of(f)}")
    except BaseException:
        shutil.rmtree(cd, ignore_errors=True)
        raise
    clips = (read_json(d / "status.json", {}) or {}).get("clips") or []
    if replace and CID_RE.match(replace) and any(c["id"] == replace for c in clips):
        clips = [{"id": cid} if c["id"] == replace else c for c in clips]
        shutil.rmtree(d / "clips" / replace, ignore_errors=True)
    elif after and CID_RE.match(after) and any(c["id"] == after for c in clips):
        at = next(n for n, c in enumerate(clips) if c["id"] == after)
        clips.insert(at + 1, {"id": cid})   # a retake sits next to the take it may replace
    else:
        clips.append({"id": cid})
    set_status(pid, clips=clips)
    jobs.put(("prep", pid, cid))  # start the heavy work now, while the next clip is being recorded
    return {"id": cid}


@app.delete("/api/projects/{pid}/clips/{cid}")
def delete_clip(pid: str, cid: str):
    d = pdir(pid)
    if not CID_RE.match(cid):
        raise HTTPException(404, "No such clip.")
    clips = (read_json(d / "status.json", {}) or {}).get("clips") or []
    set_status(pid, clips=[c for c in clips if c["id"] != cid])
    shutil.rmtree(d / "clips" / cid, ignore_errors=True)
    return {"ok": True}


@app.post("/api/projects/{pid}/process")
def process(pid: str):
    d = pdir(pid)
    if not (read_json(d / "status.json", {}) or {}).get("clips"):
        raise HTTPException(400, "Record a clip first.")
    set_status(pid, state="queued", error=None, steps={})
    jobs.put(("process", pid))
    return {"id": pid, "state": "queued"}


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    d = pdir(pid)
    transcript = read_json(d / "transcript.json", {}) or {}
    cuts = read_json(d / "cuts.json", {}) or {}
    return {**summary(d), "steps": (read_json(d / "status.json", {}) or {}).get("steps"),
            "timeline": read_json(d / "timeline.json"),
            "words": transcript.get("words", []),
            "silences": (read_json(d / "silences.json", {}) or {}).get("silences", []),
            "fillers": (read_json(d / "fillers.json", {}) or {}).get("fillers", []),
            "suggestions": cuts.get("cuts", []), "suggestions_note": cuts.get("note"),
            "audio": read_json(d / "audio.json"), "edit": read_json(d / "edit.json"),
            "export": read_json(d / "exports" / "export.json")}


@app.patch("/api/projects/{pid}")
async def rename(pid: str, request: Request):
    pdir(pid)
    body = await request.json()
    fields = {}
    if "title" in body:
        fields["title"] = str(body.get("title") or "").strip()[:200] or "Untitled video"
    if "description" in body:
        fields["description"] = str(body.get("description") or "").strip()[:2000]
    if body.get("kind") in KINDS:
        fields["kind"] = body["kind"]
    set_status(pid, **fields)
    return {"ok": True}


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    shutil.rmtree(pdir(pid))
    return {"ok": True}


@app.put("/api/projects/{pid}/edit")
async def save_edit(pid: str, request: Request):
    d = pdir(pid)
    body = await request.json()
    if not isinstance(body, dict) or len(str(body)) > 2_000_000:
        raise HTTPException(400, "That edit can't be saved.")
    removed = []
    for r in body.get("removed") or []:
        if isinstance(r, list) and len(r) == 2 and all(isinstance(x, (int, float)) for x in r) and r[1] > r[0] >= 0:
            removed.append([round(float(r[0]), 4), round(float(r[1]), 4)])
    body["removed"] = removed
    body["saved_at"] = time.time()
    write_json(d / "edit.json", body)
    return {"ok": True}


@app.post("/api/projects/{pid}/export")
async def start_export(pid: str, request: Request):
    d = pdir(pid)
    if not (d / "timeline.json").exists():
        raise HTTPException(400, "The video is still being processed.")
    body = await request.json()
    current = read_json(d / "exports" / "export.json", {}) or {}
    if current.get("state") in ("queued", "rendering") and time.time() - (current.get("updated_at") or 0) < 120:
        return current
    (d / "exports").mkdir(exist_ok=True)
    (d / "exports" / "cancel").unlink(missing_ok=True)
    req = {"state": "queued", "pct": 0, "quality": "720" if body.get("quality") == "720" else "1080",
           "captions": body.get("captions") if body.get("captions") in ("burn", "file", "none") else "burn",
           "updated_at": time.time()}
    write_json(d / "exports" / "export.json", req)
    jobs.put(("render", pid))
    return req


@app.post("/api/projects/{pid}/export/cancel")
def cancel_export(pid: str):
    ex = pdir(pid) / "exports"
    state = read_json(ex / "export.json", {}) or {}
    if state.get("state") in ("queued", "rendering"):
        (ex / "cancel").write_text("1")   # the export checks for this file and stops
    return {"ok": True}


@app.post("/api/projects/{pid}/describe")
async def describe_again(pid: str, request: Request):
    """Another title and description from Claude. Nothing is saved here; the editor keeps what she chooses."""
    d = pdir(pid)
    body = await request.json()
    avoid = body.get("avoid") if isinstance(body.get("avoid"), dict) else {}
    write_json(d / "details_avoid.json", {"title": str(avoid.get("title", ""))[:300], "description": str(avoid.get("description", ""))[:600]})
    ok, tail = await run_in_threadpool(run_engine, "describe-again", pid, timeout=90)
    try:
        answer = json.loads(tail.strip().splitlines()[-1]) if ok else None
    except (ValueError, IndexError):
        answer = None
    if not answer or "title" not in answer:
        raise HTTPException(502, "A new version couldn't be written. Try again in a moment.")
    return {"title": answer["title"], "description": answer.get("description", "")}


@app.get("/api/projects/{pid}/export")
def export_state(pid: str):
    return read_json(pdir(pid) / "exports" / "export.json") or {"state": "none"}


@app.get("/api/projects/{pid}/media/{name}")
def media(pid: str, name: str):
    d = pdir(pid)
    if name not in MEDIA or not (d / name).is_file():
        raise HTTPException(404, "No such file.")
    return FileResponse(d / name, headers={"Cache-Control": "private, max-age=0, must-revalidate"})


@app.get("/api/projects/{pid}/download/{what}")
def download(pid: str, what: str):
    d = pdir(pid)
    title = re.sub(r"[^\w\- ]+", "", (read_json(d / "status.json", {}) or {}).get("title") or "").strip() or "LOOT video"
    files = {"video": ("export.mp4", f"{title}.mp4"), "captions": ("captions.srt", f"{title}.srt")}
    if what not in files or not (d / "exports" / files[what][0]).is_file():
        raise HTTPException(404, "That file isn't ready.")
    if what == "video":
        set_status(pid, downloaded_at=time.time())
    return FileResponse(d / "exports" / files[what][0], filename=files[what][1])


@app.get("/api/reports")
def reports():
    return {"health": read_json(REPORTS / "health.json"), "cleanup": read_json(REPORTS / "cleanup.json")}


# ---------- background work ----------

def blocked_by_account(text: str) -> bool:
    return "auth_gate_blocked" in text or "swamp-club.com account" in text or "credentials have been revoked" in text


def run_workflow(name: str, *inputs: str, timeout: int = 3 * 3600) -> tuple[bool, str]:
    cmd = ["swamp", "workflow", "run", name, "--no-telemetry"]
    for i in inputs:
        cmd += ["--input", i]
    try:
        p = subprocess.run(cmd, cwd=AUTOMATION, capture_output=True, text=True, timeout=timeout)
        return p.returncode == 0, "\n".join((p.stdout + p.stderr).strip().splitlines()[-15:])
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def run_engine(*args: str, timeout: int = 3 * 3600) -> tuple[bool, str]:
    p = subprocess.run(["python", "-m", "engine", *args], cwd="/app", capture_output=True, text=True, timeout=timeout)
    return p.returncode == 0, "\n".join((p.stdout + p.stderr).strip().splitlines()[-15:])


def run_job(workflow: str, engine_args: tuple, *inputs: str) -> tuple[bool, str, str]:
    """Run through Swamp. If Swamp can't sign in on this server, run the same steps directly."""
    ok, tail = run_workflow(workflow, *inputs)
    if not ok and blocked_by_account(tail):
        ok, tail = run_engine(*engine_args)
        return ok, tail, "direct"
    return ok, tail, "swamp"


def worker() -> None:
    """One job at a time, so the server's two cores are never oversubscribed."""
    while True:
        what, pid, *rest = jobs.get()
        try:
            if what == "prep":
                if (PROJECTS / pid / "clips" / rest[0]).is_dir():
                    run_job("loot-prep", ("prep", pid, rest[0]), f"project={pid}", f"clip={rest[0]}")
            elif what == "process":
                set_status(pid, state="processing", error=None, started_at=time.time())
                ok, tail, runner = run_job("loot-process", ("process", pid), f"project={pid}")
                set_status(pid, state="ready" if ok else "failed", error=None if ok else tail[-1500:],
                           runner=runner, finished_at=time.time())
            elif what == "render":
                ok, tail, _ = run_job("loot-render", ("render", pid), f"project={pid}")
                state_file = PROJECTS / pid / "exports" / "export.json"
                state = read_json(state_file, {}) or {}
                if not ok and state.get("state") != "failed":
                    write_json(state_file, {**state, "state": "failed", "error": tail[-600:], "updated_at": time.time()})
        except BaseException as e:  # noqa: BLE001 - keep the worker alive
            try:
                set_status(pid, error=str(e)[:1500], **({"state": "failed"} if what == "process" else {}))
            except BaseException:  # noqa: BLE001
                pass


def scheduler() -> None:
    """Cleanup at 03:00 and the health check at 07:00, server time."""
    done: set[str] = set()
    while True:
        now = time.localtime()
        for hour, name in ((3, "loot-cleanup"), (7, "loot-health")):
            key = f"{name}-{now.tm_yday}"
            if now.tm_hour == hour and key not in done:
                done.add(key)
                ok, tail = run_workflow(name, timeout=1800)
                if not ok and blocked_by_account(tail):
                    run_engine(name.removeprefix("loot-"), timeout=1800)
        if len(done) > 20:
            done.clear()
        time.sleep(300)


@app.on_event("startup")
def start_background() -> None:
    PROJECTS.mkdir(parents=True, exist_ok=True)
    for d in PROJECTS.glob("*"):
        if not d.is_dir() or not ID_RE.match(d.name):
            continue  # anything that isn't a project folder is ignored, never fatal
        if (read_json(d / "status.json", {}) or {}).get("state") in ("queued", "processing"):
            jobs.put(("process", d.name))  # pick up anything interrupted by a restart
        if (read_json(d / "exports" / "export.json", {}) or {}).get("state") in ("queued", "rendering"):
            jobs.put(("render", d.name))
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=scheduler, daemon=True).start()
