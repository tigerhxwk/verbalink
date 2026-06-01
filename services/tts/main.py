import io
import logging
import wave
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s tts: %(message)s")
logger = logging.getLogger("tts")

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


def _synthesize_to_wav(voice, text: str, wav) -> None:
    """Synthesize across piper-tts API versions (1.x changed the signature)."""
    # piper-tts >= 1.0: synthesize_wav(text, wav, syn_config=SynthesisConfig(...))
    if hasattr(voice, "synthesize_wav"):
        try:
            from piper import SynthesisConfig
            voice.synthesize_wav(text, wav, syn_config=SynthesisConfig(length_scale=1.15))
            return
        except (ImportError, TypeError):
            voice.synthesize_wav(text, wav)
            return
    # piper-tts < 1.0: synthesize(text, wav, length_scale=..., sentence_silence=...)
    voice.synthesize(text, wav, length_scale=1.15, sentence_silence=0.3)


@app.post("/synthesize")
async def synthesize(req: SynthRequest):
    voice = voices.get(req.lang)
    if not voice:
        raise HTTPException(400, f"Unsupported language: {req.lang}")
    try:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            _synthesize_to_wav(voice, req.text, wav)
        buf.seek(0)
        return Response(content=buf.read(), media_type="audio/wav")
    except Exception as e:
        logger.exception("Synthesis failed (lang=%s)", req.lang)
        raise HTTPException(500, f"Synthesis failed: {e}")


@app.get("/health")
async def health():
    return {"loaded": list(voices.keys())}
