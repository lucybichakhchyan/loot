"""LOOT web app: sign-in, the three screens, and the JSON API they use."""
import hmac
import asyncio
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
try:   # Brand settings: /api/brand and the logo
    from app.brand import router as brand_router
    app.include_router(brand_router)
except ImportError:   # the app still runs without it
    pass
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
    # /w/ is the page a viewer opens from a shared link. It needs no sign-in and serves only what was shared.
    if path in ("/login", "/healthz") or path.startswith(("/static/", "/w/")) or signed_in(request):
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
    if not (HERE / "pages" / name).is_file():
        raise HTTPException(404, "That page isn't here yet.")
    return HTMLResponse((HERE / "pages" / name).read_text(), headers={"Cache-Control": "no-store"})


@app.get("/")
def home():
    return screen_page("home.html")


@app.get("/record")
def record():
    return screen_page("record.html")


@app.get("/shorts/{pid}")
def shorts_page(pid: str):
    pdir(pid)
    return screen_page("shorts.html")


@app.get("/brand")
def brand_page():
    return screen_page("brand.html")


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
    exported = export.get("state") == "done" and (d / "exports" / "export.mp4").exists()
    share = s.get("share") or {}
    shared = share_live(share)   # a link past its last day counts as off
    # Whole days until the nightly cleanup deletes the server's copy (see engine/upkeep.py).
    left = (s.get("exported_at") or export.get("updated_at") or time.time()) + KEEP_DAYS * 86400 - time.time()
    return {"id": d.name, "title": s.get("title") or "Untitled video", "description": s.get("description") or "",
            "kind": s.get("kind", "long"),
            "state": s.get("state"), "error": s.get("error"), "duration": s.get("duration"),
            "created_at": s.get("created_at"), "updated_at": s.get("updated_at"),
            "progress": round(100 * done / len(STEPS)) if busy else None,
            "clips": len(s.get("clips") or []), "thumb": (d / "thumb.jpg").exists(),
            "exported": exported,
            "days_left": max(0, -int(-left // 86400)) if exported and not s.get("media_deleted_at") else None,
            "keep_days": int(KEEP_DAYS) if KEEP_DAYS == int(KEEP_DAYS) else KEEP_DAYS,
            "downloaded": bool(s.get("downloaded_at")) and (s.get("downloaded_at") or 0) >= (export.get("updated_at") or 0),
            "media_deleted": bool(s.get("media_deleted_at")),
            "shared": shared,
            "share_path": f"/w/{share['token']}" if share.get("token") else None,
            "share_days": share.get("days", 0) if shared else None,
            "share_until": share_until(share.get("expires_at")) if shared else None,   # "19 Nov"; None means until she turns it off
            "share_waiting": shared and bool(share.get("auto"))}   # made with Share now, video not ready yet


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
            "audio": read_json(d / "audio.json"), "edit": read_json(d / "edit.json"), "brand": brand_settings(),
            "chapters": (read_json(d / "status.json", {}) or {}).get("chapters") or [],
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
    d = pdir(pid)
    token = ((read_json(d / "status.json", {}) or {}).get("share") or {}).get("token")
    if token:
        index = read_json(SHARES, {}) or {}
        index.pop(token, None)
        write_json(SHARES, index)
    shutil.rmtree(d)
    return {"ok": True}


# ---------- shorts ----------

SID_RE = re.compile(r"^[a-z0-9]{6,12}$")


def shorts_state(d: Path) -> dict:
    saved = read_json(d / "shorts.json") or {}
    items = []
    for s in saved.get("shorts", []):
        items.append({**s, "export": read_json(d / "exports" / f"short_{s['id']}.json")})
    return {"ready": "shorts" in saved, "shorts": items, "note": saved.get("note")}


@app.get("/api/projects/{pid}/shorts")
def get_shorts(pid: str):
    return shorts_state(pdir(pid))


shorts_running: set[str] = set()


@app.post("/api/projects/{pid}/shorts/suggest")
async def suggest_shorts(pid: str):
    """Claude picks the parts that work on their own; code checks them. A saved answer is reused."""
    d = pdir(pid)
    if not (d / "transcript.json").is_file():
        raise HTTPException(400, "The video is still being processed.")
    if pid in shorts_running:           # she came back while the first search is still going: wait for it, don't start another
        while pid in shorts_running:
            await asyncio.sleep(2)
        return shorts_state(d)
    shorts_running.add(pid)
    try:
        await run_in_threadpool(run_job, "loot-shorts", ("shorts", pid), f"project={pid}")
    finally:
        shorts_running.discard(pid)
    return shorts_state(d)


@app.put("/api/projects/{pid}/shorts")
async def save_shorts(pid: str, request: Request):
    d = pdir(pid)
    saved = read_json(d / "shorts.json") or {}
    incoming = {s.get("id"): s for s in (await request.json()).get("shorts", []) if isinstance(s, dict)}
    length = (read_json(d / "timeline.json", {}) or {}).get("duration", 0)
    for s in saved.get("shorts", []):
        new = incoming.get(s["id"])
        if not new:
            continue
        s["title"] = str(new.get("title") or s["title"]).strip()[:60] or s["title"]
        s["hook"] = str(new.get("hook") or "").strip()[:60]
        s["kept"], s["gone"] = bool(new.get("kept")), bool(new.get("gone"))
        try:
            a, b = float(new.get("a")), float(new.get("b"))
            if 0 <= a < b - 4.9 and b <= length + 1:
                s["a"], s["b"] = round(a, 2), round(b, 2)
        except (TypeError, ValueError):
            pass
    write_json(d / "shorts.json", saved)
    return {"ok": True}


@app.post("/api/projects/{pid}/shorts/render")
async def render_shorts(pid: str, request: Request):
    d = pdir(pid)
    known = {s["id"] for s in (read_json(d / "shorts.json") or {}).get("shorts", [])}
    ids = [i for i in (await request.json()).get("ids", []) if isinstance(i, str) and SID_RE.match(i) and i in known]
    if not ids:
        raise HTTPException(400, "Keep at least one short first.")
    (d / "exports").mkdir(exist_ok=True)
    for sid in ids:
        write_json(d / "exports" / f"short_{sid}.json", {"state": "queued", "pct": 0, "quality": "1080", "updated_at": time.time()})
        jobs.put(("short", pid, sid))
    return {"queued": ids}


@app.get("/api/projects/{pid}/download/short/{sid}")
def download_short(pid: str, sid: str):
    d = pdir(pid)
    if not SID_RE.match(sid) or not (d / "exports" / f"short_{sid}.mp4").is_file():
        raise HTTPException(404, "That short isn't ready.")
    short = next((s for s in (read_json(d / "shorts.json") or {}).get("shorts", []) if s["id"] == sid), {})
    name = re.sub(r"[^\w\- ]+", "", short.get("title") or "").strip() or "LOOT short"
    return FileResponse(d / "exports" / f"short_{sid}.mp4", filename=f"{name}.mp4")


# ---------- share links ----------

from engine.share import live as share_live, until as share_until  # noqa: E402

SHARES = DATA / "shares.json"   # token -> project id
SHARE_DAYS = (1, 7, 30, 0)      # how long a link can work; 0 means until she turns it off
KEEP_DAYS = float(os.environ.get("LOOT_KEEP_DAYS", "3"))   # days an exported video stays on the server


def share_state(d: Path, share: dict | None = None) -> dict:
    """What the screens need to know about a video's link. A link past its last day reads as off."""
    status = read_json(d / "status.json", {}) or {}
    if share is None:
        share = status.get("share") or {}
    on = share_live(share)
    stuck = status.get("state") == "failed" or (read_json(d / "exports" / "export.json", {}) or {}).get("state") == "failed"
    return {"on": on, "path": f"/w/{share['token']}" if share.get("token") else None,
            "failed": bool(share.get("auto")) and stuck,   # a link from Share now whose video could not be prepared
            "days": share.get("days", 0) if on else None,           # links made before lifetimes existed have no last day
            "expires_at": share.get("expires_at") if on else None,
            "until": share_until(share.get("expires_at")) if on else None,
            # False while a link made with Share now is still waiting for its video.
            "ready": (d / "exports" / "export.mp4").is_file() and not share.get("auto")}


async def wanted_days(request: Request) -> int | None:
    """The lifetime asked for in the request, or None when it did not name one."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - no body at all is fine
        body = None
    if not isinstance(body, dict) or body.get("days") is None:
        return None
    try:
        days = int(body["days"])
    except (TypeError, ValueError):
        days = -1
    if days not in SHARE_DAYS:
        raise HTTPException(400, "A link can work for 1, 7 or 30 days, or until you turn it off.")
    return days


def save_share(pid: str, share: dict, days: int | None, **more) -> dict:
    """Turn the link on with the lifetime asked for, counted from now."""
    now = time.time()
    if days is None:
        # No lifetime named: a link that still has time left keeps what it has, a new or run-out one gets 7 days.
        if share.get("token") and not (share.get("expires_at") and share["expires_at"] <= now):
            days, expires = share.get("days", 0), share.get("expires_at")
        else:
            days, expires = 7, now + 7 * 86400
    else:
        expires = now + days * 86400 if days else None
    token = share.get("token") or secrets.token_urlsafe(9)
    index = read_json(SHARES, {}) or {}
    index[token] = pid
    write_json(SHARES, index)
    share = {**share, "token": token, "on": True, "created_at": share.get("created_at") or now,
             "days": days, "expires_at": expires, **more}
    set_status(pid, share=share)
    return share


@app.post("/api/projects/{pid}/share")
async def share_on(pid: str, request: Request):
    """Create the link, turn it back on, or change how long it works. The link plays the exported video."""
    d = pdir(pid)
    share = (read_json(d / "status.json", {}) or {}).get("share") or {}
    if not (d / "exports" / "export.mp4").is_file() and not share.get("auto"):
        raise HTTPException(409, "Export this video first. The link plays the exported video.")
    return share_state(d, save_share(pid, share, await wanted_days(request)))


@app.get("/api/projects/{pid}/share")
def share_get(pid: str):
    return share_state(pdir(pid))


@app.delete("/api/projects/{pid}/share")
def share_off(pid: str):
    """Turn the link off. The address stays reserved, so people who open it see that it was turned off."""
    d = pdir(pid)
    share = (read_json(d / "status.json", {}) or {}).get("share") or {}
    if share.get("token"):
        set_status(pid, share={**share, "on": False})
    return {"ok": True}


def processed(d: Path, status: dict) -> bool:
    """True when the video was processed from the clips it has now."""
    made_from = [c.get("id") for c in (read_json(d / "timeline.json", {}) or {}).get("clips", [])]
    return status.get("state") == "ready" and bool(made_from) and made_from == [c["id"] for c in status.get("clips") or []]


def auto_export(pid: str) -> None:
    """Export with the usual settings, for a link made with Share now. An export that is waiting or running is left alone."""
    ex = PROJECTS / pid / "exports"
    current = read_json(ex / "export.json", {}) or {}
    if current.get("state") == "queued" or (current.get("state") == "rendering" and time.time() - (current.get("updated_at") or 0) < 120):
        return
    ex.mkdir(exist_ok=True)
    (ex / "cancel").unlink(missing_ok=True)
    write_json(ex / "export.json", {"state": "queued", "pct": 0, "quality": "1080", "captions": "burn", "updated_at": time.time()})
    jobs.put(("render", pid))


@app.post("/api/projects/{pid}/share-now")
async def share_now(pid: str, request: Request):
    """A link straight after recording. LOOT processes and exports the video by itself, and the page waits for it."""
    d = pdir(pid)
    status = read_json(d / "status.json", {}) or {}
    if not status.get("clips"):
        raise HTTPException(400, "Record a clip first.")
    days = await wanted_days(request)
    export = read_json(d / "exports" / "export.json", {}) or {}
    has_video = (d / "exports" / "export.mp4").is_file()
    done = processed(d, status)
    # The exported video can be used as it is when it was made after the video was last processed.
    current = has_video and export.get("state") == "done" and (status.get("media_deleted_at") or (
        done and (export.get("updated_at") or 0) >= (status.get("finished_at") or 0)))
    if not current and status.get("media_deleted_at"):
        raise HTTPException(409, "This video's files are no longer on the server, so it can't be shared.")
    share = save_share(pid, status.get("share") or {}, days, auto=not current)
    if not current and done:
        auto_export(pid)
    elif not current:
        ids = [c["id"] for c in status["clips"]]
        waiting = status.get("state") == "queued" or (status.get("state") == "processing" and status.get("processing_clips") == ids)
        if not waiting:   # the same steps as the Edit video button; the export follows by itself when they finish
            set_status(pid, state="queued", error=None, steps={})
            jobs.put(("process", pid))
    return share_state(d, share)


async def share_gif(d: Path) -> Path:
    """The small GIF for an email. It is made again whenever the exported video is newer than it."""
    video, gif = d / "exports" / "export.mp4", d / "exports" / "share.gif"
    if not video.is_file():
        raise HTTPException(404, "Export this video first. The GIF is made from the exported video.")
    if not gif.is_file() or gif.stat().st_mtime < video.stat().st_mtime:
        try:
            ok, _ = await run_in_threadpool(run_engine, "gif", d.name, timeout=120)
        except Exception:  # noqa: BLE001 - too slow, or the engine could not start
            ok = False
        if not ok or not gif.is_file():
            raise HTTPException(502, "The GIF couldn't be made. Try again in a moment.")
    return gif


@app.get("/api/projects/{pid}/gif")
async def download_gif(pid: str):
    d = pdir(pid)
    title = re.sub(r"[^\w\- ]+", "", (read_json(d / "status.json", {}) or {}).get("title") or "").strip() or "LOOT video"
    return FileResponse(await share_gif(d), filename=f"{title}.gif", media_type="image/gif")


def brand_settings() -> dict:
    try:
        from app.brand import load_brand
        return load_brand()
    except Exception:  # noqa: BLE001 - the share page must work even if Brand settings can't be read
        return {"name": os.environ.get("LOOT_OWNER_NAME", ""), "accent": "#8A2BE2", "headline_font": "serif",
                "cta_show": False, "cta_text": "", "cta_link": "", "has_logo": False}


def shared_project(token: str) -> Path | None:
    pid = (read_json(SHARES, {}) or {}).get(token)
    d = PROJECTS / pid if pid and ID_RE.match(pid) else None
    return d if d and d.is_dir() else None


def srt_lines(path: Path) -> list:
    """Caption lines from the export's SRT file, for the viewer's caption switch."""
    lines = []
    for block in (path.read_text(errors="replace") if path.is_file() else "").split("\n\n"):
        m = re.search(r"(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)\n(.+)", block, re.S)
        if m:
            g = [int(x) for x in m.groups()[:8]]
            lines.append({"start": g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000,
                          "end": g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000, "text": m.group(9).strip()})
    return lines


@app.get("/w/brand/logo")
def shared_logo():
    files = sorted((DATA / "brand").glob("logo.*")) if (DATA / "brand").is_dir() else []
    if not files:
        raise HTTPException(404, "No logo.")
    return FileResponse(files[0])


@app.get("/w/{token}")
def watch(token: str):
    return screen_page("watch.html")


@app.get("/w/{token}/info")
def watch_info(token: str):
    brand = brand_settings()
    public = {k: brand.get(k) for k in ("name", "accent", "headline_font", "cta_show", "cta_text", "cta_link", "has_logo")}
    d = shared_project(token)
    if not d:
        raise HTTPException(404, "No such link.")
    s = read_json(d / "status.json", {}) or {}
    export = read_json(d / "exports" / "export.json", {}) or {}
    share = s.get("share") or {}
    # A link past its last day behaves exactly like one that was turned off.
    if not share_live(share) or not (share.get("auto") or (d / "exports" / "export.mp4").is_file()):
        return {"on": False, "brand": public}
    if share.get("auto"):
        # Made with Share now: the video is still being processed or exported, and the page waits for it.
        return {"on": True, "ready": False, "failed": s.get("state") == "failed" or export.get("state") == "failed",
                "brand": public, "title": s.get("title") or "Untitled video"}
    return {"on": True, "ready": True, "brand": public, "title": s.get("title") or "Untitled video", "description": s.get("description") or "",
            "seconds": export.get("seconds") or s.get("duration") or 0, "tall": s.get("kind") == "short",
            "date": time.strftime("%-d %B %Y", time.localtime(s.get("created_at") or time.time())),
            # Captions burned into the picture can't be switched off, so only loose captions are sent.
            "captions": [] if export.get("captions") == "burn" else srt_lines(d / "exports" / "captions.srt")}


@app.get("/w/{token}/video")
def watch_video(token: str):
    d = shared_project(token)
    if not d or not share_live((read_json(d / "status.json", {}) or {}).get("share")) or not (d / "exports" / "export.mp4").is_file():
        raise HTTPException(404, "This video is no longer shared.")
    return FileResponse(d / "exports" / "export.mp4", media_type="video/mp4")


@app.get("/w/{token}/gif")
async def watch_gif(token: str):
    """The GIF an email shows in place of the video. It works only while the link does."""
    d = shared_project(token)
    if not d or not share_live((read_json(d / "status.json", {}) or {}).get("share")):
        raise HTTPException(404, "This video is no longer shared.")
    return FileResponse(await share_gif(d), media_type="image/gif")


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


OVERLAY_TYPES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
OVERLAY_RE = re.compile(r"^[a-z0-9]{8}\.(png|jpg|jpeg|webp|gif)$")


@app.post("/api/projects/{pid}/overlay")
async def add_overlay_image(pid: str, file: UploadFile = File(...)):
    """An image she places on the video. It is kept with the project and drawn at export."""
    d = pdir(pid)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in OVERLAY_TYPES:
        raise HTTPException(400, "LOOT can't use that kind of image. Use a PNG, JPG, WebP or GIF file.")
    (d / "overlays").mkdir(exist_ok=True)
    name = secrets.token_hex(4) + ext
    if await save_upload(file, d / "overlays" / name) > 20_000_000:
        (d / "overlays" / name).unlink(missing_ok=True)
        raise HTTPException(413, "That image is too big. Use one under 20 MB.")
    return {"file": name}


@app.get("/api/projects/{pid}/overlay/{name}")
def overlay_image(pid: str, name: str):
    d = pdir(pid)
    if not OVERLAY_RE.match(name) or not (d / "overlays" / name).is_file():
        raise HTTPException(404, "No such image.")
    return FileResponse(d / "overlays" / name, headers={"Cache-Control": "private, max-age=3600"})


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
    """Another title, description and chapters from Claude. Nothing is saved here; the editor keeps what she chooses."""
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
    return {"title": answer["title"], "description": answer.get("description", ""), "chapters": answer.get("chapters") or []}


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
                clips = [c["id"] for c in (read_json(PROJECTS / pid / "status.json", {}) or {}).get("clips") or []]
                set_status(pid, state="processing", error=None, started_at=time.time(), processing_clips=clips)
                ok, tail, runner = run_job("loot-process", ("process", pid), f"project={pid}")
                status = set_status(pid, state="ready" if ok else "failed", error=None if ok else tail[-1500:],
                                    runner=runner, finished_at=time.time())
                if ok and (status.get("share") or {}).get("auto"):
                    auto_export(pid)   # a link made with Share now is waiting for this video
            elif what == "short":
                ok, tail, _ = run_job("loot-short-render", ("short", pid, rest[0]), f"project={pid}", f"short={rest[0]}")
                state_file = PROJECTS / pid / "exports" / f"short_{rest[0]}.json"
                state = read_json(state_file, {}) or {}
                if not ok and state.get("state") != "failed":
                    write_json(state_file, {**state, "state": "failed", "error": tail[-600:], "updated_at": time.time()})
            elif what == "render":
                ok, tail, _ = run_job("loot-render", ("render", pid), f"project={pid}")
                state_file = PROJECTS / pid / "exports" / "export.json"
                state = read_json(state_file, {}) or {}
                if not ok and state.get("state") != "failed":
                    write_json(state_file, {**state, "state": "failed", "error": tail[-600:], "updated_at": time.time()})
                status = read_json(PROJECTS / pid / "status.json", {}) or {}
                share = status.get("share") or {}
                # A link made with Share now stops waiting once the export holds every clip the video has.
                if ok and state.get("state") == "done" and share.get("auto") and processed(PROJECTS / pid, status):
                    set_status(pid, share={**share, "auto": False})
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
        status = read_json(d / "status.json", {}) or {}
        export = (read_json(d / "exports" / "export.json", {}) or {}).get("state")
        if status.get("state") in ("queued", "processing"):
            jobs.put(("process", d.name))  # pick up anything interrupted by a restart
        if export in ("queued", "rendering"):
            jobs.put(("render", d.name))
        elif (status.get("share") or {}).get("auto") and processed(d, status) and export is None:
            auto_export(d.name)   # a link made with Share now was still waiting for its export to be started
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=scheduler, daemon=True).start()
