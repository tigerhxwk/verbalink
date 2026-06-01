import json
import os
import threading
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
    segments_out = []
    segments, info = model.transcribe(
        file_path,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
    )
    for seg in segments:
        segments_out.append({"id": seg.id, "start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text})
    segments_out = _merge_comma_segments(segments_out)

    out_path = TRANSCRIPTS_DIR / f"{book_id}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"segments": segments_out, "language": info.language}, f, ensure_ascii=False)

    return {"status": "done", "segment_count": len(segments_out), "language": info.language}


@app.post("/transcribe")
async def transcribe(req: TranscribeRequest):
    if not model_ready.wait(timeout=600):
        raise HTTPException(503, "Model not ready")

    import asyncio
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(executor, _do_transcribe, req.file_path, req.book_id)
    return result


@app.get("/health")
async def health():
    return {"ready": model_ready.is_set(), "model": WHISPER_MODEL}
