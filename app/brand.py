"""Brand settings: the name, logo, colors and defaults that new videos and the share page start from."""
import copy
import os
import re
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse

from engine.common import DATA, read_json, write_json

router = APIRouter()

BRAND_FILE = DATA / "brand.json"
LOGO_DIR = DATA / "brand"
MAX_LOGO = 2 * 1024 * 1024
MAX_COLORS = 40                 # swatches in one row
LOGO_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "svg": "image/svg+xml"}
HEX_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")
SCHEME_RE = re.compile(r"^[a-z][a-z0-9+.-]*:(?!\d)", re.I)      # "javascript:" yes, "example.com:8080" no
SVG_CODE_RE = re.compile(rb"<\s*script|<\s*foreignobject|[\s\"']on[a-z]+\s*=|javascript:", re.I)

# The defaults are the choices the Brand settings mockup starts with.
DEFAULTS = {
    "name": os.environ.get("LOOT_OWNER_NAME", ""),                # set yours here, or with LOOT_OWNER_NAME in .env
    "background": "glow",                                         # "glow" = the violet glow, or a color from "colors"
    "colors": ["#1A1A1A", "#2D253A", "#F6F6F4", "#8A2BE2"],       # video background swatches, after the violet glow
    "highlight": "#AB8CF0",                                       # the highlighted word in captions and the rule on cards
    "highlight_colors": ["#AB8CF0", "#8A2BE2", "#E2C184", "#F6F6F4"],
    "accent": "#8A2BE2",                                          # the button and the player on the share page
    "accent_colors": ["#8A2BE2", "#AB8CF0", "#F6F6F4"],
    "headline_font": "serif",                                     # "serif" = Playfair Display italic, "sans" = Inter bold
    "caption_style": "",                                          # "" = Bold, "boxed", "plain"
    "highlight_word": True,                                       # highlight one word in each caption line
    "show_name": True,                                            # the name in the corner of videos
    "intro_on": True,                                             # title card at the start, default for new videos
    "outro_on": False,                                            # closing card at the end, default for new videos
    "closing_line": "Thanks for watching.",
    "cta_show": False,                                            # turns on once there is a link to send people to
    "cta_text": "Get in touch",
    "cta_link": "",               # always "" or a full http, https or mailto address
}
# Each chosen color and the row of swatches it is picked from.
ROWS = (("background", "colors"), ("highlight", "highlight_colors"), ("accent", "accent_colors"))


# ---------- checking values ----------

def _text(limit: int):
    def clean(v):
        if not isinstance(v, str):
            raise ValueError("has to be text")
        return " ".join(v.split())[:limit].strip()
    return clean


def _flag(v):
    if not isinstance(v, bool):
        raise ValueError("has to be true or false")
    return v


def _choice(*options: str):
    def clean(v):
        if not isinstance(v, str) or v not in options:
            raise ValueError("has to be one of: " + ", ".join(repr(o) for o in options))
        return v
    return clean


def _color(v):
    if not isinstance(v, str) or not HEX_RE.match(v):
        raise ValueError("has to be a color written like #8A2BE2")
    return v.upper()


def _background(v):
    return v if v == "glow" else _color(v)


def _colors(v):
    if not isinstance(v, list):
        raise ValueError("has to be a list of colors")
    out = []
    for c in map(_color, v):
        if c not in out:
            out.append(c)
    if len(out) > MAX_COLORS:
        raise ValueError(f"can hold up to {MAX_COLORS} colors")
    return out


def _link(v):
    """An address people can open. A bare "example.com/page" gets https:// in front, so it works as a link as saved."""
    v = _text(500)(v)
    if not v:
        return ""
    if " " in v:
        raise ValueError("The button link has to be a web address without spaces.")
    if v.lower().startswith(("http://", "https://", "mailto:")):
        return v
    if SCHEME_RE.match(v):
        raise ValueError("The button link has to be a web address or an email link.")
    return "https://" + v.lstrip("/")


FIELDS = {
    "name": _text(80), "background": _background, "colors": _colors, "highlight": _color, "highlight_colors": _colors,
    "accent": _color, "accent_colors": _colors, "headline_font": _choice("serif", "sans"),
    "caption_style": _choice("", "boxed", "plain"), "highlight_word": _flag, "show_name": _flag, "intro_on": _flag,
    "outro_on": _flag, "closing_line": _text(120), "cta_show": _flag, "cta_text": _text(40), "cta_link": _link,
}


def _merge(base: dict, changes: dict, strict: bool) -> dict:
    """Lay changes over base. Strict refuses anything wrong (a save); otherwise a wrong value keeps the one under it (a load)."""
    out = dict(base)
    for key, value in changes.items():
        if key == "has_logo":       # set by the server, never saved
            continue
        clean = FIELDS.get(key)
        if not clean:
            if strict:
                raise HTTPException(422, f'LOOT has no brand setting called "{key}".')
            continue
        try:
            out[key] = clean(value)
        except ValueError as e:
            if strict:
                problem = str(e)
                raise HTTPException(422, problem if problem.endswith(".") else f'The brand setting "{key}" {problem}.') from None
    for pick, row in ROWS:          # a chosen color always has its swatch
        if out[pick] != "glow" and out[pick] not in out[row]:
            out[row] = out[row] + [out[pick]]
    return out


# ---------- reading and saving ----------

def logo_path() -> Path | None:
    for ext in LOGO_TYPES:
        f = LOGO_DIR / f"logo.{ext}"
        if f.is_file():
            return f
    return None


def load_brand() -> dict:
    """The brand settings with every key present: what was saved, over the defaults."""
    saved = read_json(BRAND_FILE, {})
    brand = _merge(copy.deepcopy(DEFAULTS), saved if isinstance(saved, dict) else {}, strict=False)
    brand["has_logo"] = logo_path() is not None
    return brand


@router.get("/api/brand")
def get_brand():
    return load_brand()


@router.put("/api/brand")
async def save_brand(request: Request):
    """Save some or all settings. Keys that are left out keep their saved value."""
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise HTTPException(400, "Those settings can't be read.")
    brand = load_brand()
    brand.pop("has_logo")
    brand = _merge(brand, body, strict=True)
    write_json(BRAND_FILE, brand)
    return {**brand, "has_logo": logo_path() is not None}


# ---------- logo ----------

def _image_kind(data: bytes) -> str | None:
    """The kind of image, read from the file itself and not from its name."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    head = data[:4096].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if head.startswith((b"<svg", b"<?xml", b"<!--", b"<!doctype svg")) and b"<svg" in data[:65536].lower():
        return "svg"
    return None


@router.post("/api/brand/logo")
async def save_logo(file: UploadFile = File(...)):
    data = await file.read(MAX_LOGO + 1)
    if len(data) > MAX_LOGO:
        raise HTTPException(413, "That image is too big. Use one under 2 MB.")
    kind = _image_kind(data)
    if not kind:
        raise HTTPException(400, "LOOT can't read that kind of image. Use PNG, JPG, WebP or SVG.")
    if kind == "svg" and SVG_CODE_RE.search(data):
        raise HTTPException(400, "That SVG has code inside it, which LOOT doesn't accept. Use a plain SVG or a PNG.")
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    target, tmp = LOGO_DIR / f"logo.{kind}", LOGO_DIR / "upload.tmp"
    tmp.write_bytes(data)
    tmp.replace(target)
    for old in LOGO_DIR.glob("logo.*"):     # only one logo is kept
        if old != target:
            old.unlink(missing_ok=True)
    return load_brand()


@router.delete("/api/brand/logo")
def delete_logo():
    if LOGO_DIR.is_dir():
        for old in LOGO_DIR.glob("logo.*"):
            old.unlink(missing_ok=True)
    return load_brand()


@router.get("/api/brand/logo")
def get_logo():
    f = logo_path()
    if not f:
        raise HTTPException(404, "No logo.")
    # An SVG is a document, so it is served locked down: shown as a picture, never run as a page.
    return FileResponse(f, media_type=LOGO_TYPES[f.suffix[1:]], headers={
        "Cache-Control": "private, max-age=0, must-revalidate", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox"})
