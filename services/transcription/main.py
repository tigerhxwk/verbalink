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


def _merge_comma_segments(segments):
    if not segments:
        return segments
    merged = []
    cur = dict(segments[0])
    for seg in segments[1:]:
        txt = cur["text"].strip()
        if txt and txt[-1] in (",", ";"):
            cur["text"] = txt + " " + seg["text"].strip()
            cur["end"] = seg["end"]
        else:
            merged.append(cur)
            cur = dict(seg)
    merged.append(cur)
    return merged


def _do_transcribe(file_path: str, book_id: str) -> dict:
    started_at = time.monotonic()
    _progress[book_id] = {"processed_sec": 0.0, "total_sec": None, "pct": 0, "eta_sec": None}

    segments, info = model.transcribe(
        file_path,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
    )
    total = info.duration or 1.0
    _progress[book_id]["total_sec"] = total

    # Stream segments into a temp file — safe against mid-job crashes
    tmp_path = TRANSCRIPTS_DIR / f"{book_id}.tmp.jsonl"
    segment_count = 0
    detected_language = info.language

    with open(tmp_path, "w", encoding="utf-8") as tmp:
        for seg in segments:
            row = {"id": seg.id, "start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text}
            tmp.write(json.dumps(row, ensure_ascii=False) + "\n")
            tmp.flush()
            segment_count += 1

            elapsed = time.monotonic() - started_at
            processed = seg.end
            pct = min(99, round(processed / total * 100))
            speed = processed / elapsed if elapsed > 0 else 0.5
            eta = (total - processed) / speed if speed > 0 else None
            _progress[book_id] = {"processed_sec": processed, "total_sec": total,
                                   "pct": pct, "eta_sec": round(eta) if eta else None}

    # Read back, merge comma segments, write final JSON, delete temp
    segments_out = []
    with open(tmp_path, encoding="utf-8") as tmp:
        for line in tmp:
            if line.strip():
                segments_out.append(json.loads(line))
    tmp_path.unlink()

    segments_out = _merge_comma_segments(segments_out)
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
