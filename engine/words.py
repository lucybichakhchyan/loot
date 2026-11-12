"""Transcript, filler words and Claude's suggested cuts.

Whisper and the filler list are plain code. Only `cuts` calls Claude, it sends
transcript text only, and code checks every answer against the word timings.
"""
import hashlib
import json
import os
import re

from .common import project_dir, read_json, set_status, write_json

WHISPER_MODEL = os.environ.get("LOOT_WHISPER_MODEL", "small.en")
WHISPER_DIR = os.environ.get("LOOT_WHISPER_DIR", "/opt/whisper")
CLAUDE_MODEL = os.environ.get("LOOT_CLAUDE_MODEL", "claude-opus-5-5")
PROMPT_VERSION = "cuts-v1"
BEAM = int(os.environ.get("LOOT_WHISPER_BEAM", "5"))

# Whisper tends to tidy speech; this nudges it to keep the fillers so they can be cut.
KEEP_FILLERS = "Umm, let me think, like, hmm. Okay, uh, here's what I'm, you know, thinking."

SURE_FILLERS = {"um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "hmm", "mm", "mhm"}
MAYBE_PHRASES = [("you", "know"), ("i", "mean"), ("sort", "of"), ("kind", "of")]


def _bare(word: str) -> str:
    return re.sub(r"[^a-z']", "", word.lower())


def load_16k(path):
    """Decode audio with FFmpeg to the 16 kHz mono samples Whisper expects."""
    import subprocess

    import numpy as np

    p = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
                       capture_output=True)
    if p.returncode != 0:
        raise SystemExit(f"transcribe: FFmpeg could not read the audio: {p.stderr.decode()[-300:]}")
    return np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768.0


_model = None


def transcribe_file(wav) -> list:
    """Whisper on one clip. Returns words with times measured from the start of that clip."""
    global _model
    from faster_whisper import WhisperModel

    if _model is None:
        _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root=WHISPER_DIR)
    segments, _ = _model.transcribe(load_16k(wav), word_timestamps=True, vad_filter=True, beam_size=BEAM,
                                    initial_prompt=KEEP_FILLERS, condition_on_previous_text=False)
    words = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if text:
                words.append({"w": text, "start": round(w.start, 3), "end": round(w.end, 3)})
    return words


def fillers(pid: str) -> None:
    d = project_dir(pid)
    src, out = d / "transcript.json", d / "fillers.json"
    words = (read_json(src, {}) or {}).get("words", [])
    found = []
    bare = [_bare(w["w"]) for w in words]
    for n, w in enumerate(words):
        if bare[n] in SURE_FILLERS:
            found.append({"first_word": n, "last_word": n, "text": w["w"], "start": w["start"],
                          "end": w["end"], "certain": True})
    for n in range(len(words) - 1):
        if (bare[n], bare[n + 1]) in MAYBE_PHRASES:
            found.append({"first_word": n, "last_word": n + 1, "text": f'{words[n]["w"]} {words[n + 1]["w"]}',
                          "start": words[n]["start"], "end": words[n + 1]["end"], "certain": False})
    found.sort(key=lambda f: f["start"])
    write_json(out, {"fillers": found, "certain": sum(f["certain"] for f in found)})
    set_status(pid, step={"fillers": "done"})
    print(f"fillers: {len(found)} marked")


CUTS_SCHEMA = {
    "type": "object",
    "properties": {
        "cuts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "first_word": {"type": "integer", "description": "Index of the first word to remove"},
                    "last_word": {"type": "integer", "description": "Index of the last word to remove"},
                    "kind": {"type": "string", "enum": ["retake", "false_start", "repeat", "aside"]},
                    "reason": {"type": "string", "description": "One short sentence for the editor"},
                },
                "required": ["first_word", "last_word", "kind", "reason"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["cuts"],
    "additionalProperties": False,
}

CUTS_PROMPT = """You are helping edit a spoken video recording. Below is its transcript. Every word is \
shown as index|word, so you can point at exact words.

Suggest cuts that remove mistakes the speaker would not want in the final video:
- retake: the speaker says something, stops, and says it again better. Remove the earlier attempt and keep the last complete one.
- false_start: a sentence that is begun and abandoned.
- repeat: a word or phrase said twice by accident.
- aside: talk that is not for the audience, such as "wait, let me start over" or "is this recording?".

Do not cut single filler words like "um" or pauses; other code handles those. Do not cut content just \
to shorten the video, and do not change what the speaker means. If the recording is clean, return an \
empty list. Each cut is a range of word indexes, first and last both included.

Transcript:
"""


def _check_cuts(raw_cuts: list, words: list) -> tuple[list, int]:
    """Keep only cuts that point at real words, in order, without overlaps. Times come from Whisper."""
    good, dropped, last_end = [], 0, -1
    for c in sorted(raw_cuts, key=lambda c: c.get("first_word", 0)):
        a, b = c.get("first_word"), c.get("last_word")
        if not (isinstance(a, int) and isinstance(b, int)) or not (0 <= a <= b < len(words)) or a <= last_end:
            dropped += 1
            continue
        if b - a + 1 > max(len(words) * 0.5, 1):  # never let one cut remove half the video
            dropped += 1
            continue
        good.append({"first_word": a, "last_word": b, "start": words[a]["start"], "end": words[b]["end"],
                     "text": " ".join(w["w"] for w in words[a:b + 1]),
                     "kind": c.get("kind"), "reason": str(c.get("reason", ""))[:300], "accepted": None})
        last_end = b
    return good, dropped


def cuts(pid: str) -> None:
    d = project_dir(pid)
    out = d / "cuts.json"
    words = (read_json(d / "transcript.json", {}) or {}).get("words", [])
    if not words:
        write_json(out, {"cuts": [], "note": "There is no speech to review."})
        return
    listing = " ".join(f'{w["i"]}|{w["w"]}' for w in words)
    fingerprint = hashlib.sha256(f"{PROMPT_VERSION}\n{CLAUDE_MODEL}\n{listing}".encode()).hexdigest()
    saved = read_json(out)
    if saved and saved.get("fingerprint") == fingerprint and "cuts" in saved:
        print("cuts: transcript unchanged, reusing the saved answer (no tokens)")
        return
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        write_json(out, {"cuts": [], "skipped": True,
                         "note": "No Claude API key is set on the server, so no cuts were suggested."})
        set_status(pid, step={"cuts": "skipped, no API key"})
        print("cuts: skipped, no API key")
        return

    import anthropic

    client = anthropic.Anthropic()
    try:
        response = client.beta.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": CUTS_SCHEMA}},
            messages=[{"role": "user", "content": CUTS_PROMPT + listing}],
        )
    except anthropic.RateLimitError as e:
        raise SystemExit(f"cuts: Claude is rate limited, try again later ({e})")
    except anthropic.APIStatusError as e:
        raise SystemExit(f"cuts: Claude returned an error {e.status_code}: {e.message}")
    except anthropic.APIConnectionError as e:
        raise SystemExit(f"cuts: could not reach Claude ({e})")
    if response.stop_reason == "refusal":
        raise SystemExit("cuts: Claude declined to review this transcript")
    if response.stop_reason == "max_tokens":
        raise SystemExit("cuts: Claude's answer was cut off")
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        answer = json.loads(text)
    except json.JSONDecodeError:
        raise SystemExit("cuts: Claude's answer was not valid JSON, nothing was changed")
    good, dropped = _check_cuts(answer.get("cuts", []), words)
    usage = response.usage
    write_json(out, {"fingerprint": fingerprint, "model": response.model, "cuts": good,
                     "dropped_by_check": dropped,
                     "tokens": {"input": usage.input_tokens, "output": usage.output_tokens}})
    set_status(pid, step={"cuts": "done"})
    print(f"cuts: {len(good)} suggested, {dropped} dropped by the check")
