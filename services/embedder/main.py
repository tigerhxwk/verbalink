"""Tiny CPU embedding service for Verbalink RAG.

Serves multilingual-e5-small (384-dim). The model needs an instruction prefix:
"query: " for search queries, "passage: " for indexed text — applied per request `type`.
"""
import os
from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.environ.get("EMBED_MODEL", "intfloat/multilingual-e5-small")

app = FastAPI()
_model = None


def model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL_NAME, device="cpu")
    return _model


class EmbedRequest(BaseModel):
    texts: list[str]
    type: str = "passage"   # "passage" | "query"


@app.on_event("startup")
def _warm():
    model()  # load weights once at boot so the first request isn't slow


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "dim": model().get_sentence_embedding_dimension()}


@app.post("/embed")
def embed(req: EmbedRequest):
    prefix = "query: " if req.type == "query" else "passage: "
    inputs = [prefix + (t or "") for t in req.texts]
    vecs = model().encode(inputs, normalize_embeddings=True, batch_size=32)
    return {"vectors": [v.tolist() for v in vecs]}
