import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
TRANSCRIPTS_DIR = DATA_DIR / "transcripts"
MODELS_DIR = Path("/models")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "medium")

model = None
model_ready = threading.Event()
executor = ThreadPoolExecutor(max_workers=1)

# Progress tracking: book_id -> {processed_sec, total_sec, started_at, pct}
_progress: dict = {}

app = FastAPI()


def _load_model():
    global model
    from faster_whisper import WhisperModel
    MODELS_DIR.mkdir(exist_ok=True)
    model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root=str(MODELS_DIR))
    model_ready.set()


@app.on_event("startup")
async def startup():
    t = threading.Thread(target=_load_model, daemon=True)
    t.start()


class TranscribeRequest(BaseModel):
    file_path: str
    book_id: str


_SENTENCE_TERMINATORS = ".!?…"

# Words that end in "." but are not sentence ends (lowercased, period stripped)
_ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "st", "vs", "etc", "jr", "sr", "prof", "inc", "ltd",
    "co", "no", "vol", "pp", "fig", "approx", "dept", "gen", "rev", "hon", "capt",
    "sgt", "col", "lt", "cmdr", "e.g", "i.e", "a.m", "p.m",
    # Russian abbreviations
    "г", "гр", "ул", "д", "т", "др", "пр", "см", "стр", "рис", "им", "обл", "руб",
}


def _is_real_period_break(period_word: str, next_word: str) -> bool:
    """Given a word ending in '.' and the following word, decide if it's a sentence end.
    Filters out abbreviations, single-letter initials, and continuations (lowercase next)."""
    core = period_word[:-1].strip().lower().strip('"\'(»“')
    if core in _ABBREVIATIONS:
        return False
    if len(core) == 1 and core.isalpha():        # initial like "J."
        return False
    nw = (next_word or "").strip().strip('"\'(«“')
    if nw and nw[0].islower():                    # sentence clearly continues
        return False
    return True


def _split_keeping_terminators(text):
    out, buf, i, n = [], "", 0, len(text)
    while i < n:
        ch = text[i]
        buf += ch
        if ch in _SENTENCE_TERMINATORS:
            j = i + 1
            while j < n and text[j] in _SENTENCE_TERMINATORS:
                buf += text[j]; j += 1
            while j < n and text[j] in '"\'»”)]':
                buf += text[j]; j += 1
            out.append(buf)
            buf = ""
            i = j
            while i < n and text[i] == ' ':
                i += 1
        else:
            i += 1
    if buf.strip():
        out.append(buf)
    return out


def _segment_sentences(segments):
    """Re-segment whisper output into complete sentences: merge fragments forward,
    split on . ! ? … with interpolated timestamps."""
    if not segments:
        return segments
    sentences = []
    cur_text = ""
    cur_start = None
    for seg in segments:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        seg_start, seg_end = seg["start"], seg["end"]
        L = len(text)
        if cur_start is None:
            cur_start = seg_start
        pos = 0
        for piece in _split_keeping_terminators(text):
            piece_str = piece.strip()
            pos += len(piece)
            piece_end = seg_start + (seg_end - seg_start) * (pos / L) if L else seg_end
            cur_text = (cur_text + " " + piece_str).strip() if cur_text else piece_str
            if piece_str and piece_str[-1] in _SENTENCE_TERMINATORS:
                sentences.append({"start": round(cur_start, 3), "end": round(piece_end, 3), "text": cur_text})
                cur_text = ""
                cur_start = piece_end
        if not cur_text:
            cur_start = None
    if cur_text.strip():
        sentences.append({"start": round(cur_start or 0, 3),
                          "end": round(segments[-1]["end"], 3), "text": cur_text.strip()})
    for i, s in enumerate(sentences):
        s["id"] = i
    return sentences


def _do_transcribe(file_path: str, book_id: str) -> dict:
    started_at = time.monotonic()
    _progress[book_id] = {"processed_sec": 0.0, "total_sec": None, "pct": 0, "eta_sec": None}

    # word_timestamps=True gives an exact start/end for every word, so sentence
    # boundaries land on real word edges instead of being interpolated.
    segments, info = model.transcribe(
        file_path,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
        word_timestamps=True,
    )
    total = info.duration or 1.0
    _progress[book_id]["total_sec"] = total
    detected_language = info.language

    # Build complete sentences from words with EXACT timestamps.
    # A word ending in ! ? … always ends a sentence. A word ending in "." defers
    # the decision one word (lookahead) so abbreviations/initials don't false-split.
    tmp_path = TRANSCRIPTS_DIR / f"{book_id}.tmp.jsonl"
    sentence_count = 0
    cur_words: list[str] = []
    cur_start = None
    pending = None  # {"word": <text ending in '.'>, "end": <time>} awaiting lookahead
    processed = 0.0

    with open(tmp_path, "w", encoding="utf-8") as tmp:
        def _flush(end_t):
            nonlocal cur_words, cur_start, sentence_count
            text = "".join(cur_words).strip()
            if text:
                tmp.write(json.dumps({"start": round(cur_start, 3), "end": round(end_t, 3),
                                      "text": text}, ensure_ascii=False) + "\n")
                tmp.flush()
                sentence_count += 1
            cur_words = []
            cur_start = None

        def _add_word(wtext, wstart, wend):
            nonlocal cur_words, cur_start, pending
            # Resolve a deferred "." boundary using this word as lookahead
            if pending is not None:
                if _is_real_period_break(pending["word"], wtext):
                    _flush(pending["end"])
                pending = None
            if cur_start is None:
                cur_start = wstart
            cur_words.append(wtext)
            wt = wtext.rstrip()
            if wt:
                if wt[-1] in "!?…":
                    _flush(wend)
                elif wt[-1] == ".":
                    pending = {"word": wt, "end": wend}

        for seg in segments:
            words = list(getattr(seg, "words", None) or [])
            if not words:
                _add_word(seg.text, seg.start, seg.end)
            else:
                for w in words:
                    _add_word(w.word, w.start, w.end)

            elapsed = time.monotonic() - started_at
            processed = seg.end
            pct = min(99, round(processed / total * 100))
            speed = processed / elapsed if elapsed > 0 else 0.5
            eta = (total - processed) / speed if speed > 0 else None
            _progress[book_id] = {"processed_sec": processed, "total_sec": total,
                                   "pct": pct, "eta_sec": round(eta) if eta else None}

        # Resolve a trailing pending period, then flush remaining words
        if pending is not None:
            _flush(pending["end"])
        if cur_words:
            _flush(processed)

    # Read back into final JSON, assign ids, delete temp
    segments_out = []
    with open(tmp_path, encoding="utf-8") as tmp:
        for line in tmp:
            if line.strip():
                segments_out.append(json.loads(line))
    tmp_path.unlink()
    for i, s in enumerate(segments_out):
        s["id"] = i

    _progress.pop(book_id, None)

    out_path = TRANSCRIPTS_DIR / f"{book_id}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"segments": segments_out, "language": detected_language}, f, ensure_ascii=False)

    return {"status": "done", "segment_count": len(segments_out), "language": detected_language}


@app.post("/transcribe")
async def transcribe(req: TranscribeRequest):
    if not model_ready.wait(timeout=600):
        raise HTTPException(503, "Model not ready")

    import asyncio
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(executor, _do_transcribe, req.file_path, req.book_id)
    return result


@app.get("/progress/{book_id}")
async def get_progress(book_id: str):
    p = _progress.get(book_id)
    if not p:
        return {"active": False}
    return {"active": True, **p}


@app.get("/health")
async def health():
    return {"ready": model_ready.is_set(), "model": WHISPER_MODEL}
