import io
import wave
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

MODELS_DIR = Path("/models")

# Piper voice model URLs (rhasspy/piper-voices on HuggingFace)
VOICE_URLS = {
    "en": {
        "onnx": "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx",
        "json": "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ryan/high/en_US-ryan-high.onnx.json",
    },
    "ru": {
        "onnx": "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/ruslan/medium/ru_RU-ruslan-medium.onnx",
        "json": "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/ru/ru_RU/ruslan/medium/ru_RU-ruslan-medium.onnx.json",
    },
}

voices: dict = {}

app = FastAPI()


async def _download(url: str, dest: Path):
    async with httpx.AsyncClient(follow_redirects=True, timeout=300) as client:
        async with client.stream("GET", url) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                async for chunk in r.aiter_bytes(65536):
                    f.write(chunk)


@app.on_event("startup")
async def startup():
    from piper import PiperVoice

    MODELS_DIR.mkdir(exist_ok=True)
    for lang, urls in VOICE_URLS.items():
        lang_dir = MODELS_DIR / lang
        lang_dir.mkdir(exist_ok=True)
        onnx = lang_dir / "model.onnx"
        cfg = lang_dir / "model.onnx.json"
        if not onnx.exists():
            await _download(urls["onnx"], onnx)
        if not cfg.exists():
            await _download(urls["json"], cfg)
        voices[lang] = PiperVoice.load(str(onnx), config_path=str(cfg), use_cuda=False)


class SynthRequest(BaseModel):
    text: str
    lang: str


@app.post("/synthesize")
async def synthesize(req: SynthRequest):
    voice = voices.get(req.lang)
    if not voice:
        raise HTTPException(400, f"Unsupported language: {req.lang}")

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        # length_scale > 1.0 = slightly slower, better for learning
        voice.synthesize(req.text, wav, length_scale=1.15, sentence_silence=0.3)
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")


@app.get("/health")
async def health():
    return {"loaded": list(voices.keys())}
