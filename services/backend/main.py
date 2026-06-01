import asyncio
import base64
import hashlib
import json
import logging
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import aiofiles
import httpx
import jwt
from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from ldap3 import Connection as LdapConn, NONE as LDAP_NONE, Server as LdapServer, SUBTREE
from passlib.context import CryptContext
from pydantic import BaseModel, field_validator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
logger = logging.getLogger("reader")

# ── Config ────────────────────────────────────────────────────────────────────

DATA_DIR        = Path(os.environ.get("DATA_DIR", "/data"))
BOOKS_DIR       = DATA_DIR / "books"
TRANSCRIPTS_DIR = DATA_DIR / "transcripts"
DB_PATH         = DATA_DIR / "reader.db"

LLM_BASE_URL       = os.environ.get("LLM_BASE_URL", "http://llama-server:8080/v1")
LLM_MODEL          = os.environ.get("LLM_MODEL", "qwen3.6-35b")
TTS_URL            = os.environ.get("TTS_URL", "http://tts:8001")
TRANSCRIPTION_URL  = os.environ.get("TRANSCRIPTION_URL", "http://transcription:8002")

LDAP_SERVER     = os.environ.get("LDAP_SERVER", "")
LDAP_BASE_DN    = os.environ.get("LDAP_BASE_DN", "dc=lab,dc=local")
LDAP_ADMIN_DN   = os.environ.get("LDAP_ADMIN_DN", f"uid=admin,ou=people,{os.environ.get('LDAP_BASE_DN','dc=lab,dc=local')}")
LDAP_ADMIN_PASS = os.environ.get("LDAP_ADMIN_PASSWORD", "")

SECRET_KEY = os.environ.get("SECRET_KEY", "change-me-in-production-please")
JWT_ALGO   = "HS256"
TOKEN_TTL  = 7 * 24 * 60  # minutes

LANG_NAMES = {
    "en": "English",
    "ru": "Russian",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "pl": "Polish",
    "uk": "Ukrainian",
    "sv": "Swedish",
    "tr": "Turkish",
    "ar": "Arabic",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
}

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# In-memory chat history per (user_id, book_id) — resets on server restart
# Each value: list of {"role": "user"|"assistant", "content": str}
_chat_history: dict[str, list] = {}
CHAT_HISTORY_MAX = 20  # messages to keep

# Brute-force protection (in-memory)
_bf_attempts: dict = {}
_bf_lock = threading.Lock()
BF_MAX_ATTEMPTS   = 5
BF_LOCKOUT_MINUTES = 15

# ── Database ──────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    BOOKS_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    conn = get_db()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            hashed_password TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            title TEXT NOT NULL,
            filename TEXT NOT NULL,
            duration_sec REAL,
            source_lang TEXT DEFAULT 'ru',
            target_lang TEXT DEFAULT 'en',
            transcription_status TEXT DEFAULT 'pending',
            error TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            name TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS collection_books (
            collection_id TEXT NOT NULL,
            book_id TEXT NOT NULL,
            added_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (collection_id, book_id),
            FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        )
    """)
    conn.commit()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT PRIMARY KEY,
            essay_enabled INTEGER DEFAULT 1,
            essay_interval_min INTEGER DEFAULT 30,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS book_essays (
            id TEXT PRIMARY KEY,
            book_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            position_sec REAL NOT NULL,
            prompt TEXT NOT NULL,
            essay_text TEXT,
            review TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    """)
    conn.commit()

    # Migrations for existing databases that predate user columns
    for migration in [
        "ALTER TABLE books ADD COLUMN user_id TEXT",
        "ALTER TABLE collections ADD COLUMN user_id TEXT",
        "ALTER TABLE books ADD COLUMN translation_status TEXT DEFAULT 'none'",
        "ALTER TABLE books ADD COLUMN progress_sec REAL DEFAULT 0",
        "ALTER TABLE books ADD COLUMN playback_speed REAL DEFAULT 1.0",
        "ALTER TABLE books ADD COLUMN volume REAL DEFAULT 1.0",
        "ALTER TABLE books ADD COLUMN clarify_mode TEXT DEFAULT 'advanced'",
    ]:
        try:
            conn.execute(migration)
            conn.commit()
        except sqlite3.OperationalError:
            pass  # column already exists

    # Add any books not in any collection into the owner's My Books
    try:
        conn.execute("""
            INSERT OR IGNORE INTO collection_books (collection_id, book_id)
            SELECT c.id, b.id
            FROM books b
            JOIN collections c ON c.user_id = b.user_id AND c.name = 'My Books'
            WHERE NOT EXISTS (
                SELECT 1 FROM collection_books cb WHERE cb.book_id = b.id
            )
        """)
        conn.commit()
    except Exception:
        pass

    conn.execute("UPDATE books SET transcription_status='pending' WHERE transcription_status='processing'")
    conn.commit()
    conn.close()


# ── Auth helpers ──────────────────────────────────────────────────────────────

def hash_pw(password: str) -> str:
    return pwd_ctx.hash(password)

def verify_pw(plain: str, hashed: str) -> bool:
    return pwd_ctx.verify(plain, hashed)

def make_token(user_id: str) -> str:
    exp = datetime.utcnow() + timedelta(minutes=TOKEN_TTL)
    return jwt.encode({"sub": user_id, "exp": exp}, SECRET_KEY, algorithm=JWT_ALGO)

def decode_token(token: str) -> str:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGO])
        uid = payload.get("sub")
        if not uid:
            raise HTTPException(401, "Invalid token")
        return uid
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Session expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()

def set_cookie(response: Response, token: str):
    response.set_cookie(
        key="reader_session",
        value=token,
        httponly=True,
        secure=False,     # set True when serving over HTTPS
        samesite="lax",
        max_age=TOKEN_TTL * 60,
    )

def clear_cookie(response: Response):
    response.delete_cookie("reader_session", samesite="lax")


# ── LDAP (same pattern as biolab_eap) ────────────────────────────────────────

def ldap_authenticate(username: str, password: str) -> Optional[str]:
    """Authenticate via lldap. Returns role string or None if LDAP not configured.
    Raises HTTPException on auth failure."""
    if not LDAP_SERVER:
        return None
    try:
        server = LdapServer(LDAP_SERVER, get_info=LDAP_NONE, connect_timeout=5)
        with LdapConn(server, user=LDAP_ADMIN_DN, password=LDAP_ADMIN_PASS, auto_bind=True) as conn:
            conn.search(f"ou=people,{LDAP_BASE_DN}", f"(uid={username})",
                        search_scope=SUBTREE, attributes=["uid"])
            if not conn.entries:
                raise HTTPException(401, "Invalid credentials")
            user_dn = conn.entries[0].entry_dn

        try:
            LdapConn(server, user=user_dn, password=password, auto_bind=True).unbind()
        except Exception:
            raise HTTPException(401, "Invalid credentials")

        logger.info(f"LDAP login: {username}")
        return "user"

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"LDAP error: {e}")
        raise HTTPException(503, "Authentication service unavailable")


def provision_user(conn, username: str) -> dict:
    """Get or create a user record. Creates 'My Books' collection for new users."""
    user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if user:
        return dict(user)

    user_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO users (id, username, hashed_password) VALUES (?,?,?)",
        (user_id, username, hash_pw(secrets.token_hex(32))),
    )
    coll_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO collections (id, user_id, name) VALUES (?,?,?)",
        (coll_id, user_id, "My Books"),
    )
    conn.commit()
    logger.info(f"Provisioned new user: {username}")
    return dict(conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())


# ── FastAPI app ───────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"], allow_credentials=True)


# ── Auth dependency ───────────────────────────────────────────────────────────

async def current_user(request: Request) -> dict:
    token = request.cookies.get("reader_session")
    if not token:
        raise HTTPException(401, "Not authenticated")
    user_id = decode_token(token)
    conn = get_db()
    th = token_hash(token)
    session = conn.execute("SELECT user_id FROM sessions WHERE token_hash=?", (th,)).fetchone()
    if not session:
        conn.close()
        raise HTTPException(401, "Session expired or logged out")
    user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    conn.close()
    if not user:
        raise HTTPException(401, "User not found")
    return dict(user)


# ── Auth endpoints ─────────────────────────────────────────────────────────────

class LoginBody(BaseModel):
    username: str
    password: str

    @field_validator("username", "password")
    @classmethod
    def no_control_chars(cls, v: str) -> str:
        if any(ord(c) < 32 for c in v):
            raise ValueError("invalid characters")
        return v.strip()


@app.get("/api/auth/config")
async def auth_config():
    return {"ldap_enabled": bool(LDAP_SERVER)}


@app.get("/api/auth/me")
async def auth_me(user: dict = Depends(current_user)):
    return {"user_id": user["id"], "username": user["username"]}


@app.post("/api/auth/login")
async def auth_login(body: LoginBody, request: Request, response: Response):
    ip = request.client.host if request.client else "unknown"
    bf_key = f"{body.username.lower()}:{ip}"

    with _bf_lock:
        rec = _bf_attempts.get(bf_key)
        if rec and rec.get("locked_until") and datetime.utcnow() < rec["locked_until"]:
            mins = max(1, int((rec["locked_until"] - datetime.utcnow()).total_seconds() / 60) + 1)
            raise HTTPException(429, f"Too many attempts. Try again in {mins} minute(s).")

    auth_failed = False
    conn = get_db()

    if LDAP_SERVER:
        try:
            ldap_authenticate(body.username, body.password)
        except HTTPException as e:
            if e.status_code in (401, 403):
                auth_failed = True
                conn.close()
                _bump_bf(bf_key)
                raise
            conn.close()
            raise
        user = provision_user(conn, body.username)
    else:
        # Local auth fallback (dev/test without LDAP)
        user = conn.execute("SELECT * FROM users WHERE username=?", (body.username,)).fetchone()
        if not user or not verify_pw(body.password, user["hashed_password"]):
            auth_failed = True

    if auth_failed:
        conn.close()
        _bump_bf(bf_key)
        raise HTTPException(401, "Invalid credentials")

    with _bf_lock:
        _bf_attempts.pop(bf_key, None)

    user_dict = dict(user)
    token = make_token(user_dict["id"])
    conn.execute("INSERT INTO sessions (token_hash, user_id) VALUES (?,?)",
                 (token_hash(token), user_dict["id"]))
    conn.commit()
    conn.close()

    set_cookie(response, token)
    return {"user_id": user_dict["id"], "username": user_dict["username"]}


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    token = request.cookies.get("reader_session")
    if token:
        conn = get_db()
        conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash(token),))
        conn.commit()
        conn.close()
    clear_cookie(response)
    return {"status": "logged out"}


@app.post("/api/auth/register")
async def auth_register(body: LoginBody, response: Response):
    """Local account creation — disabled when LDAP is configured."""
    if LDAP_SERVER:
        raise HTTPException(403, "Registration disabled — accounts managed via LDAP")
    conn = get_db()
    if conn.execute("SELECT id FROM users WHERE username=?", (body.username,)).fetchone():
        conn.close()
        raise HTTPException(400, "Username already taken")
    user = provision_user_with_password(conn, body.username, body.password)
    conn.close()
    token = make_token(user["id"])
    conn2 = get_db()
    conn2.execute("INSERT INTO sessions (token_hash, user_id) VALUES (?,?)",
                  (token_hash(token), user["id"]))
    conn2.commit()
    conn2.close()
    set_cookie(response, token)
    return {"user_id": user["id"], "username": user["username"]}


def provision_user_with_password(conn, username: str, password: str) -> dict:
    user_id = str(uuid.uuid4())
    conn.execute("INSERT INTO users (id, username, hashed_password) VALUES (?,?,?)",
                 (user_id, username, hash_pw(password)))
    coll_id = str(uuid.uuid4())
    conn.execute("INSERT INTO collections (id, user_id, name) VALUES (?,?,?)",
                 (coll_id, user_id, "My Books"))
    conn.commit()
    return dict(conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone())


def _bump_bf(key: str):
    with _bf_lock:
        rec = _bf_attempts.setdefault(key, {"count": 0, "locked_until": None})
        rec["count"] += 1
        if rec["count"] >= BF_MAX_ATTEMPTS:
            rec["locked_until"] = datetime.utcnow() + timedelta(minutes=BF_LOCKOUT_MINUTES)
            logger.warning(f"Brute-force lockout: {key}")


# ── Transcription background task ─────────────────────────────────────────────

async def run_transcription(book_id: str, file_path: str):
    conn = get_db()
    conn.execute("UPDATE books SET transcription_status='processing' WHERE id=?", (book_id,))
    conn.commit()
    conn.close()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(7200.0)) as client:
            resp = await client.post(
                f"{TRANSCRIPTION_URL}/transcribe",
                json={"file_path": file_path, "book_id": book_id},
            )
            resp.raise_for_status()
        conn = get_db()
        conn.execute("UPDATE books SET transcription_status='done' WHERE id=?", (book_id,))
        conn.commit()
        conn.close()
        # Backfill source_lang from Whisper's detected language if present in transcript
        try:
            transcript_path = TRANSCRIPTS_DIR / f"{book_id}.json"
            if transcript_path.exists():
                async with aiofiles.open(transcript_path) as f:
                    td = json.loads(await f.read())
                detected = td.get("language", "").lower().strip()
                if detected in LANG_NAMES:
                    conn = get_db()
                    conn.execute("UPDATE books SET source_lang=? WHERE id=?", (detected, book_id))
                    conn.commit()
                    conn.close()
                    logger.info(f"Auto-detected language for {book_id}: {detected}")
        except Exception as e:
            logger.warning(f"Language backfill failed ({book_id}): {e}")
        # No batch translation — Clarify translates each sentence live on demand.
    except Exception as e:
        conn = get_db()
        conn.execute("UPDATE books SET transcription_status='error', error=? WHERE id=?", (str(e), book_id))
        conn.commit()
        conn.close()


# ── LLM helpers ───────────────────────────────────────────────────────────────

async def _llm_call(prompt: str, max_tokens: int = 2000, no_think: bool = False) -> str:
    extra = {"chat_template_kwargs": {"enable_thinking": False}} if no_think else {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0)) as client:
        resp = await client.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers={"Authorization": "Bearer none"},
            json={
                "model": LLM_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
                "max_tokens": max_tokens,
                **extra,
            },
        )
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"].strip()
        think_end = text.find("</think>")
        if think_end != -1:
            text = text[think_end + 8:].lstrip()
        return text


async def _llm_stream(messages: list, max_tokens: int = 1200, no_think: bool = False):
    """Async generator yielding clean text tokens (thinking stripped) from streaming LLM.

    Handles three cases robustly:
      - no thinking block at all (no_think=True or model just answers) → stream everything
      - <think>...</think> block present → skip it, stream what follows
    """
    extra = {"chat_template_kwargs": {"enable_thinking": False}} if no_think else {}
    token_count = 0
    raw_accum = []
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0)) as client:
        async with client.stream(
            "POST", f"{LLM_BASE_URL}/chat/completions",
            headers={"Authorization": "Bearer none"},
            json={"model": LLM_MODEL, "messages": messages, "temperature": 0.3,
                  "max_tokens": max_tokens, "stream": True, **extra},
        ) as resp:
            resp.raise_for_status()
            buf = ""
            phase = "detect"   # detect → (skip_think | passthrough)
            async for line in resp.aiter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                try:
                    token = json.loads(line[6:])["choices"][0]["delta"].get("content") or ""
                except Exception:
                    continue
                if not token:
                    continue
                token_count += 1
                raw_accum.append(token)

                if phase == "passthrough":
                    yield token
                    continue
                if phase == "skip_think":
                    buf += token
                    if "</think>" in buf:
                        after = buf.split("</think>", 1)[1].lstrip("\n")
                        phase = "passthrough"
                        if after:
                            yield after
                    continue
                # phase == "detect": decide whether a <think> block is starting
                buf += token
                stripped = buf.lstrip()
                if stripped.startswith("<think>"):
                    phase = "skip_think"
                elif stripped and not "<think>".startswith(stripped):
                    # Definitely not a thinking block — flush and stream from here
                    phase = "passthrough"
                    yield buf
            # Stream ended mid-detect (only a partial "<think>" prefix arrived): flush it
            if phase == "detect" and buf:
                yield buf
    logger.info("_llm_stream: %d tokens, raw[:200]=%r", token_count, "".join(raw_accum)[:200])


_SENTENCE_TERMINATORS = ".!?…"


def _split_keeping_terminators(text: str) -> list[str]:
    """Split text into sentence pieces, keeping terminal punctuation with each piece.
    Consecutive terminators ('...', '?!') and trailing quotes/brackets stay attached."""
    out, buf, i, n = [], "", 0, len(text)
    while i < n:
        ch = text[i]
        buf += ch
        if ch in _SENTENCE_TERMINATORS:
            j = i + 1
            while j < n and text[j] in _SENTENCE_TERMINATORS:  # "...", "?!"
                buf += text[j]; j += 1
            while j < n and text[j] in '"\'»”)]':              # closing quotes/brackets
                buf += text[j]; j += 1
            out.append(buf)
            buf = ""
            i = j
            while i < n and text[i] == ' ':                    # skip the space between sentences
                i += 1
        else:
            i += 1
    if buf.strip():
        out.append(buf)
    return out


def _segment_sentences(segments: list) -> list:
    """Re-segment raw whisper output into complete sentences.

    - Fragments (ending in comma/semicolon or no terminal punctuation) merge forward.
    - Segments containing multiple sentences are split on . ! ? …
    - Timestamps for mid-segment splits are interpolated by character position.
    Idempotent: running it on already-sentence-level data returns the same sentences.
    """
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
            cur_start = None  # next segment starts a fresh sentence

    if cur_text.strip():
        sentences.append({"start": round(cur_start or 0, 3),
                          "end": round(segments[-1]["end"], 3), "text": cur_text.strip()})

    for i, s in enumerate(sentences):
        s["id"] = i
    return sentences


async def _analyze_sentence(text: str, source_lang: str, target_lang: str, mode: str = "advanced") -> dict:
    src = LANG_NAMES.get(source_lang, source_lang)
    tgt = LANG_NAMES.get(target_lang, target_lang)
    if mode == "beginner":
        expl_instr = (
            f"<2-3 sentence {tgt} explanation for a complete language beginner: "
            f"break down the grammar structure, explain each key word's meaning, "
            f"describe the sentence construction, and note any cultural context>"
        )
    else:
        expl_instr = f"<1–2 sentence {tgt} explanation of meaning and any cultural context>"
    prompt = (
        f'You are a language tutor. Analyze this {src} sentence:\n\n"{text}"\n\n'
        f"Return ONLY valid JSON, no markdown, no other text:\n"
        f'{{"translation":"<full {tgt} translation>","explanation":"{expl_instr}",'
        f'"terms":[{{"term":"<original term>","meaning":"<{tgt} explanation>","is_slang":false}}]}}\n'
        f"Include in \"terms\" only idioms, slang, phraseological units, or culturally-specific expressions. "
        f"Empty array if none."
    )
    raw = await _llm_call(prompt, no_think=True)
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass
    translation = await _translate(text, source_lang, target_lang)
    return {"translation": translation, "explanation": "", "terms": []}


async def _urban_dict(term: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(6.0)) as client:
            resp = await client.get(
                "https://api.urbandictionary.com/v0/define",
                params={"term": term},
                headers={"User-Agent": "Verbalink/1.0"},
            )
            entries = sorted(
                resp.json().get("list", []),
                key=lambda x: x.get("thumbs_up", 0),
                reverse=True,
            )
            if entries:
                return entries[0]["definition"][:400].replace("[", "").replace("]", "")
    except Exception:
        pass
    return None


# ── Language detection ────────────────────────────────────────────────────────

class DetectLangBody(BaseModel):
    filename: str

@app.post("/api/detect_language")
async def detect_language(body: DetectLangBody, user: dict = Depends(current_user)):
    supported = list(LANG_NAMES.keys())
    prompt = (
        f'Audiobook filename: "{Path(body.filename).stem}"\n'
        f"What is the spoken language? Use character sets, names, and words as clues.\n"
        f"Reply with ONLY one ISO 639-1 code from: {', '.join(supported)}\n"
        f"Just the code, nothing else."
    )
    try:
        raw = await _llm_call(prompt, max_tokens=10, no_think=True)
        lang = raw.strip().lower().split()[0].rstrip('.,;:')
        if lang in LANG_NAMES:
            return {"lang": lang}
    except Exception as e:
        logger.warning(f"Language detection failed: {e}")
    return {"lang": "en"}


# ── Books ──────────────────────────────────────────────────────────────────────

@app.post("/api/books")
async def upload_book(
    file: UploadFile,
    background_tasks: BackgroundTasks,
    source_lang: str = "ru",
    target_lang: str = "en",
    collection_id: Optional[str] = None,
    user: dict = Depends(current_user),
):
    book_id  = str(uuid.uuid4())
    safe_name = Path(file.filename).name
    filename  = f"{book_id}_{safe_name}"
    file_path = BOOKS_DIR / filename

    async with aiofiles.open(file_path, "wb") as f:
        while chunk := await file.read(1024 * 1024):
            await f.write(chunk)

    duration = None
    try:
        from tinytag import TinyTag
        duration = TinyTag.get(str(file_path)).duration
    except Exception:
        pass

    title = Path(safe_name).stem
    conn = get_db()
    conn.execute(
        "INSERT INTO books (id, user_id, title, filename, duration_sec, source_lang, target_lang) VALUES (?,?,?,?,?,?,?)",
        (book_id, user["id"], title, filename, duration, source_lang, target_lang),
    )
    if collection_id:
        col = conn.execute("SELECT id FROM collections WHERE id=? AND user_id=?",
                           (collection_id, user["id"])).fetchone()
        if col:
            conn.execute("INSERT OR IGNORE INTO collection_books (collection_id, book_id) VALUES (?,?)",
                         (collection_id, book_id))
    else:
        my_books = conn.execute(
            "SELECT id FROM collections WHERE user_id=? AND name='My Books' LIMIT 1",
            (user["id"],)
        ).fetchone()
        if my_books:
            conn.execute("INSERT OR IGNORE INTO collection_books (collection_id, book_id) VALUES (?,?)",
                         (my_books["id"], book_id))
    conn.commit()
    conn.close()

    background_tasks.add_task(run_transcription, book_id, str(file_path))
    return {"id": book_id, "title": title, "status": "pending"}


@app.get("/api/books")
async def list_books(user: dict = Depends(current_user)):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, duration_sec, source_lang, target_lang, transcription_status, translation_status, error, created_at, progress_sec, playback_speed, volume, clarify_mode FROM books WHERE user_id=? ORDER BY created_at DESC",
        (user["id"],),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/books/{book_id}")
async def get_book(book_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute("SELECT * FROM books WHERE id=? AND user_id=?", (book_id, user["id"])).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)
    return dict(row)


class BookPatch(BaseModel):
    target_lang: Optional[str] = None
    title: Optional[str] = None


@app.patch("/api/books/{book_id}")
async def patch_book(book_id: str, body: BookPatch, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute("SELECT id FROM books WHERE id=? AND user_id=?", (book_id, user["id"])).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404)
    if body.target_lang is not None:
        if body.target_lang not in LANG_NAMES:
            raise HTTPException(400, f"Unsupported language: {body.target_lang}")
        conn.execute("UPDATE books SET target_lang=? WHERE id=?", (body.target_lang, book_id))
    if body.title is not None:
        conn.execute("UPDATE books SET title=? WHERE id=?", (body.title.strip(), book_id))
    conn.commit()
    result = dict(conn.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone())
    conn.close()
    return result


class BookSettings(BaseModel):
    progress_sec:   Optional[float] = None
    playback_speed: Optional[float] = None
    volume:         Optional[float] = None
    clarify_mode:   Optional[str]   = None
    source_lang:    Optional[str]   = None
    target_lang:    Optional[str]   = None


@app.get("/api/books/{book_id}/settings")
async def get_book_settings(book_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute(
        "SELECT source_lang, target_lang, progress_sec, playback_speed, volume, clarify_mode "
        "FROM books WHERE id=? AND user_id=?", (book_id, user["id"])
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)
    return dict(row)


@app.put("/api/books/{book_id}/settings")
async def save_book_settings(book_id: str, body: BookSettings, user: dict = Depends(current_user)):
    conn = get_db()
    if not conn.execute("SELECT id FROM books WHERE id=? AND user_id=?", (book_id, user["id"])).fetchone():
        conn.close()
        raise HTTPException(404)
    fields = []
    values = []
    for col, val in [
        ("progress_sec",   body.progress_sec),
        ("playback_speed", body.playback_speed),
        ("volume",         body.volume),
        ("clarify_mode",   body.clarify_mode),
        ("source_lang",    body.source_lang),
        ("target_lang",    body.target_lang),
    ]:
        if val is not None:
            fields.append(f"{col}=?")
            values.append(val)
    if fields:
        values.append(book_id)
        conn.execute(f"UPDATE books SET {', '.join(fields)} WHERE id=?", values)
        conn.commit()
    conn.close()
    return {"status": "saved"}


@app.get("/api/books/{book_id}/transcription-progress")
async def transcription_progress(book_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute("SELECT transcription_status FROM books WHERE id=? AND user_id=?",
                       (book_id, user["id"])).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)
    if row["transcription_status"] != "processing":
        return {"active": False, "status": row["transcription_status"]}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{TRANSCRIPTION_URL}/progress/{book_id}")
            r.raise_for_status()
            return r.json()
    except Exception:
        return {"active": True, "pct": 0, "eta_sec": None}


@app.post("/api/books/{book_id}/retranscribe")
async def retranscribe(book_id: str, background_tasks: BackgroundTasks, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute("SELECT filename FROM books WHERE id=? AND user_id=?", (book_id, user["id"])).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404)
    conn.execute("UPDATE books SET transcription_status='pending', error=NULL WHERE id=?", (book_id,))
    conn.commit()
    conn.close()
    background_tasks.add_task(run_transcription, book_id, str(BOOKS_DIR / row["filename"]))
    return {"status": "queued"}


@app.delete("/api/books/{book_id}")
async def delete_book(book_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute("SELECT filename FROM books WHERE id=? AND user_id=?", (book_id, user["id"])).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404)
    conn.execute("DELETE FROM books WHERE id=?", (book_id,))
    conn.commit()
    conn.close()
    for path in [BOOKS_DIR / row["filename"], TRANSCRIPTS_DIR / f"{book_id}.json"]:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
    return {"status": "deleted"}


@app.get("/api/books/{book_id}/audio")
async def get_audio(book_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute("SELECT filename FROM books WHERE id=? AND user_id=?", (book_id, user["id"])).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)
    path = BOOKS_DIR / row["filename"]
    mime = mimetypes.guess_type(str(path))[0] or "audio/mpeg"
    return FileResponse(path, media_type=mime)


@app.get("/api/books/{book_id}/transcript")
async def get_transcript(book_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute("SELECT id FROM books WHERE id=? AND user_id=?", (book_id, user["id"])).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)
    path = TRANSCRIPTS_DIR / f"{book_id}.json"
    if not path.exists():
        raise HTTPException(404, "Transcript not ready")
    async with aiofiles.open(path) as f:
        return json.loads(await f.read())


# ── Collections ────────────────────────────────────────────────────────────────

@app.get("/api/collections")
async def list_collections(user: dict = Depends(current_user)):
    conn = get_db()
    rows = conn.execute("SELECT * FROM collections WHERE user_id=? ORDER BY created_at ASC",
                        (user["id"],)).fetchall()
    result = []
    for r in rows:
        count = conn.execute("SELECT COUNT(*) FROM collection_books WHERE collection_id=?",
                             (r["id"],)).fetchone()[0]
        result.append({**dict(r), "book_count": count})
    conn.close()
    return result


class CollectionCreate(BaseModel):
    name: str


@app.post("/api/collections")
async def create_collection(body: CollectionCreate, user: dict = Depends(current_user)):
    coll_id = str(uuid.uuid4())
    conn = get_db()
    conn.execute("INSERT INTO collections (id, user_id, name) VALUES (?,?,?)",
                 (coll_id, user["id"], body.name.strip()))
    conn.commit()
    conn.close()
    return {"id": coll_id, "name": body.name.strip(), "user_id": user["id"], "book_count": 0}


@app.delete("/api/collections/{coll_id}")
async def delete_collection(coll_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    conn.execute("DELETE FROM collections WHERE id=? AND user_id=?", (coll_id, user["id"]))
    conn.commit()
    conn.close()
    return {"status": "deleted"}


@app.get("/api/collections/{coll_id}/books")
async def list_collection_books(coll_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute("SELECT id FROM collections WHERE id=? AND user_id=?",
                       (coll_id, user["id"])).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404)
    rows = conn.execute("""
        SELECT b.id, b.title, b.duration_sec, b.source_lang, b.target_lang,
               b.transcription_status, b.translation_status, b.error, b.created_at, cb.added_at
        FROM books b
        JOIN collection_books cb ON b.id = cb.book_id
        WHERE cb.collection_id = ? AND b.user_id = ?
        ORDER BY cb.added_at DESC
    """, (coll_id, user["id"])).fetchall()
    conn.close()
    return [dict(r) for r in rows]


class CollectionAddBook(BaseModel):
    book_id: str


@app.post("/api/collections/{coll_id}/books")
async def add_book_to_collection(coll_id: str, body: CollectionAddBook, user: dict = Depends(current_user)):
    conn = get_db()
    if not conn.execute("SELECT id FROM collections WHERE id=? AND user_id=?", (coll_id, user["id"])).fetchone():
        conn.close()
        raise HTTPException(404, "Collection not found")
    if not conn.execute("SELECT id FROM books WHERE id=? AND user_id=?", (body.book_id, user["id"])).fetchone():
        conn.close()
        raise HTTPException(404, "Book not found")
    conn.execute("INSERT OR IGNORE INTO collection_books (collection_id, book_id) VALUES (?,?)",
                 (coll_id, body.book_id))
    conn.commit()
    conn.close()
    return {"status": "added"}


@app.delete("/api/collections/{coll_id}/books/{book_id}")
async def remove_book_from_collection(coll_id: str, book_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    if not conn.execute("SELECT id FROM collections WHERE id=? AND user_id=?", (coll_id, user["id"])).fetchone():
        conn.close()
        raise HTTPException(404)
    conn.execute("DELETE FROM collection_books WHERE collection_id=? AND book_id=?", (coll_id, book_id))
    conn.commit()
    conn.close()
    return {"status": "removed"}


# ── Clarify ────────────────────────────────────────────────────────────────────

class ClarifyRequest(BaseModel):
    book_id: str
    position_sec: float
    mode: str = "advanced"  # "advanced" | "beginner"


async def _load_segment(book_id: str, user_id: str, position_sec: float):
    """Load book + transcript, merge comma segments, return (segment, source_lang, target_lang)."""
    conn = get_db()
    row = conn.execute(
        "SELECT source_lang, target_lang, transcription_status FROM books WHERE id=? AND user_id=?",
        (book_id, user_id),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)
    if row["transcription_status"] != "done":
        raise HTTPException(400, "Transcript not ready yet")
    path = TRANSCRIPTS_DIR / f"{book_id}.json"
    async with aiofiles.open(path) as f:
        transcript = json.loads(await f.read())
    segments = transcript["segments"]  # already sentence-level from transcription service
    # Prefer the segment currently playing (contains position_sec)
    current = next((s for s in segments if s["start"] <= position_sec <= s["end"]), None)
    if current:
        return current, row["source_lang"], row["target_lang"]
    # Fall back to last completed segment
    done = [s for s in segments if s["end"] <= position_sec]
    if not done:
        raise HTTPException(400, "No sentence found at this position")
    return done[-1], row["source_lang"], row["target_lang"]


@app.post("/api/clarify")
async def clarify(req: ClarifyRequest, user: dict = Depends(current_user)):
    segment, source_lang, target_lang = await _load_segment(req.book_id, user["id"], req.position_sec)
    original = segment["text"].strip()

    analysis = await _analyze_sentence(original, source_lang, target_lang, mode=req.mode)

    terms = analysis.get("terms", [])
    if terms:
        ud_tasks = [
            _urban_dict(t["term"]) if t.get("is_slang") else asyncio.sleep(0, result=None)
            for t in terms
        ]
        ud_results = await asyncio.gather(*ud_tasks, return_exceptions=True)
        for t, ud in zip(terms, ud_results):
            if isinstance(ud, str) and ud:
                t["urban"] = ud

    # TTS for translated text
    audio_translated = None
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            tts = await client.post(f"{TTS_URL}/synthesize",
                                    json={"text": analysis["translation"], "lang": target_lang})
            tts.raise_for_status()
            audio_translated = base64.b64encode(tts.content).decode()
    except Exception:
        pass

    # TTS for original text
    audio_original = None
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            tts = await client.post(f"{TTS_URL}/synthesize",
                                    json={"text": original, "lang": source_lang})
            tts.raise_for_status()
            audio_original = base64.b64encode(tts.content).decode()
    except Exception:
        pass

    return {
        "original_text":    original,
        "translated_text":  analysis["translation"],
        "explanation":      analysis.get("explanation", ""),
        "terms":            terms,
        "source_lang":      source_lang,
        "target_lang":      target_lang,
        "sentence_start":   segment["start"],
        "sentence_end":     segment["end"],
        "audio_translated": audio_translated,
        "audio_original":   audio_original,
    }


class ClarifyStreamRequest(BaseModel):
    book_id: str
    position_sec: float
    mode: str = "advanced"


async def _synthesize_tts(text: str, lang: str) -> Optional[str]:
    """Return base64 WAV for text in lang, or None on failure (logs reason)."""
    if not text:
        return None
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            r = await client.post(f"{TTS_URL}/synthesize", json={"text": text, "lang": lang})
            r.raise_for_status()
            return base64.b64encode(r.content).decode()
    except Exception as e:
        logger.warning("TTS failed (lang=%s): %s", lang, e)
        return None


@app.post("/api/clarify/stream")
async def clarify_stream(req: ClarifyStreamRequest, user: dict = Depends(current_user)):
    """SSE clarify: 'meta' event (translation+terms+TTS) first, then explanation 'token' events.

    Two LLM calls: (1) fast structured translation+terms, (2) streamed prose explanation.
    Keeping them separate makes the explanation stream reliably and lets beginner/advanced differ.
    """
    segment, source_lang, target_lang = await _load_segment(req.book_id, user["id"], req.position_sec)
    original = segment["text"].strip()
    src = LANG_NAMES.get(source_lang, source_lang)
    tgt = LANG_NAMES.get(target_lang, target_lang)

    # 1. Structured translation + terms (reliable JSON, no_think)
    tr_prompt = (
        f'Translate this {src} sentence to {tgt} and identify any idioms/slang.\n'
        f'Sentence: "{original}"\n\n'
        f"Return ONLY valid JSON, no other text:\n"
        f'{{"translation":"<full {tgt} translation>","terms":[{{"term":"<original term>","meaning":"<{tgt} meaning>","is_slang":false}}]}}\n'
        f"Include in terms ONLY idioms, slang, phraseological units, or culturally-specific expressions. "
        f"Empty array if none."
    )
    tr_raw = await _llm_call(tr_prompt, max_tokens=800, no_think=True)
    try:
        m = re.search(r'\{.*\}', tr_raw, re.DOTALL)
        parsed = json.loads(m.group()) if m else {}
    except Exception:
        parsed = {}
    translation = parsed.get("translation") or await _translate(original, source_lang, target_lang)
    terms = parsed.get("terms", []) if isinstance(parsed.get("terms"), list) else []

    # UrbanDictionary enrichment for slang
    if terms:
        ud_tasks = [_urban_dict(t["term"]) if t.get("is_slang") else asyncio.sleep(0, result=None) for t in terms]
        for t, ud in zip(terms, await asyncio.gather(*ud_tasks, return_exceptions=True)):
            if isinstance(ud, str) and ud:
                t["urban"] = ud

    # TTS for both original and translation
    audio_original   = await _synthesize_tts(original, source_lang)
    audio_translated = await _synthesize_tts(translation, target_lang)

    meta_event = {
        "original_text":    original,
        "translated_text":  translation,
        "terms":            terms,
        "source_lang":      source_lang,
        "target_lang":      target_lang,
        "sentence_start":   segment["start"],
        "sentence_end":     segment["end"],
        "audio_original":   audio_original,
        "audio_translated": audio_translated,
    }

    # 2. Explanation prompt — beginner vs advanced genuinely differ
    if req.mode == "beginner":
        expl_prompt = (
            f'{src} sentence: "{original}"\n'
            f'{tgt} translation: "{translation}"\n\n'
            f"You are teaching a complete beginner in {src}. Explain in {tgt}, covering:\n"
            f"1. Word-by-word: identify each key word's part of speech (noun, verb, adjective, article, preposition) and its meaning.\n"
            f"2. Grammar: explain tense, case, word order, and any constructions used.\n"
            f"3. The overall meaning in plain language.\n"
            f"Write clearly for a learner. Plain text, no markdown headers."
        )
    else:
        expl_prompt = (
            f'{src} sentence: "{original}"\n'
            f'{tgt} translation: "{translation}"\n\n'
            f"In {tgt}, write a concise explanation (2-3 sentences): meaning, nuance, "
            f"and cultural context if relevant. Plain text, no markdown."
        )

    async def generate():
        yield f"data: {json.dumps({'type': 'meta', **meta_event})}\n\n"
        async for token in _llm_stream([{"role": "user", "content": expl_prompt}],
                                       max_tokens=900, no_think=True):
            yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"
        yield "data: {\"type\":\"done\"}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class ChatRequest(BaseModel):
    book_id: str
    message: str
    position_sec: float = 0.0


@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest, user: dict = Depends(current_user)):
    """Stream a dialogue response about the current book passage. Maintains per-session history."""
    conn = get_db()
    row = conn.execute("SELECT source_lang, target_lang, title FROM books WHERE id=? AND user_id=?",
                       (req.book_id, user["id"])).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)

    tgt = LANG_NAMES.get(row["target_lang"], row["target_lang"])
    src = LANG_NAMES.get(row["source_lang"], row["source_lang"])
    hist_key = f"{user['id']}:{req.book_id}"
    history = _chat_history.setdefault(hist_key, [])

    # Try to get context segment
    context_text = ""
    try:
        path = TRANSCRIPTS_DIR / f"{req.book_id}.json"
        async with aiofiles.open(path) as f:
            transcript = json.loads(await f.read())
        segments = transcript["segments"]  # already sentence-level from transcription service
        done = [s for s in segments if s["end"] <= req.position_sec]
        if done:
            # Include last 3 sentences as context
            context_segs = done[-3:]
            context_text = " ".join(s["text"].strip() for s in context_segs)
    except Exception:
        pass

    system_msg = (
        f'You are a language tutor helping a student learn {src} through the audiobook "{row["title"]}".\n'
        f"Answer in {tgt}. Be concise and educational.\n"
        + (f'Current passage: "{context_text}"\n' if context_text else "")
    )

    messages = [{"role": "system", "content": system_msg}] + history + [{"role": "user", "content": req.message}]

    async def generate():
        full_response = []
        async for token in _llm_stream(messages, max_tokens=600, no_think=True):
            full_response.append(token)
            yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"
        yield "data: {\"type\":\"done\"}\n\n"
        # Save to history
        history.append({"role": "user", "content": req.message})
        history.append({"role": "assistant", "content": "".join(full_response)})
        # Keep last N messages
        if len(history) > CHAT_HISTORY_MAX:
            _chat_history[hist_key] = history[-CHAT_HISTORY_MAX:]

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.delete("/api/chat/{book_id}")
async def clear_chat(book_id: str, user: dict = Depends(current_user)):
    """Clear chat history for a book."""
    _chat_history.pop(f"{user['id']}:{book_id}", None)
    return {"status": "cleared"}


# ── User settings ──────────────────────────────────────────────────────────────

class UserSettingsBody(BaseModel):
    essay_enabled:      Optional[bool] = None
    essay_interval_min: Optional[int]  = None


@app.get("/api/settings")
async def get_settings(user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute("SELECT * FROM user_settings WHERE user_id=?", (user["id"],)).fetchone()
    conn.close()
    if not row:
        return {"essay_enabled": True, "essay_interval_min": 30}
    return dict(row)


@app.put("/api/settings")
async def save_settings(body: UserSettingsBody, user: dict = Depends(current_user)):
    conn = get_db()
    existing = conn.execute("SELECT user_id FROM user_settings WHERE user_id=?", (user["id"],)).fetchone()
    if not existing:
        conn.execute("INSERT INTO user_settings (user_id) VALUES (?)", (user["id"],))
    fields, values = [], []
    if body.essay_enabled is not None:
        fields.append("essay_enabled=?"); values.append(int(body.essay_enabled))
    if body.essay_interval_min is not None:
        fields.append("essay_interval_min=?"); values.append(max(5, body.essay_interval_min))
    if fields:
        values.append(user["id"])
        conn.execute(f"UPDATE user_settings SET {', '.join(fields)} WHERE user_id=?", values)
    conn.commit()
    conn.close()
    return {"status": "saved"}


# ── Essays ─────────────────────────────────────────────────────────────────────

@app.get("/api/books/{book_id}/essays")
async def list_essays(book_id: str, user: dict = Depends(current_user)):
    conn = get_db()
    rows = conn.execute(
        "SELECT id, position_sec, prompt, essay_text, review, created_at "
        "FROM book_essays WHERE book_id=? AND user_id=? ORDER BY created_at DESC",
        (book_id, user["id"])
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/books/{book_id}/essays/last-position")
async def last_essay_position(book_id: str, user: dict = Depends(current_user)):
    """Return position_sec of the most recent essay for trigger calculation."""
    conn = get_db()
    row = conn.execute(
        "SELECT position_sec FROM book_essays WHERE book_id=? AND user_id=? ORDER BY created_at DESC LIMIT 1",
        (book_id, user["id"])
    ).fetchone()
    conn.close()
    return {"position_sec": row["position_sec"] if row else 0.0}


class EssayPromptRequest(BaseModel):
    book_id:      str
    position_sec: float


@app.post("/api/essay/prompt")
async def generate_essay_prompt(req: EssayPromptRequest, user: dict = Depends(current_user)):
    """Generate an essay prompt based on the passage up to position_sec."""
    conn = get_db()
    row = conn.execute(
        "SELECT source_lang, target_lang, title FROM books WHERE id=? AND user_id=?",
        (req.book_id, user["id"])
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)

    # Get last ~30 minutes of segments as context
    path = TRANSCRIPTS_DIR / f"{req.book_id}.json"
    if not path.exists():
        raise HTTPException(400, "Transcript not ready")
    async with aiofiles.open(path) as f:
        transcript = json.loads(await f.read())
    segments = transcript["segments"]  # already sentence-level from transcription service
    window_start = max(0, req.position_sec - 1800)  # last 30 min
    passage_segs = [s for s in segments if window_start <= s["end"] <= req.position_sec]
    if not passage_segs:
        raise HTTPException(400, "No passage found at this position")
    passage = " ".join(s["text"].strip() for s in passage_segs[-80:])  # last 80 segments

    src = LANG_NAMES.get(row["source_lang"], row["source_lang"])
    tgt = LANG_NAMES.get(row["target_lang"], row["target_lang"])
    prompt = (
        f'Audiobook: "{row["title"]}" ({src})\n\nPassage:\n{passage[:3000]}\n\n'
        f"Write a short essay task in {tgt} for a language student who just listened to this passage. "
        f"The task should test comprehension and encourage using vocabulary from the passage. "
        f"Target length: 300-500 characters. "
        f"Output ONLY the task text, nothing else."
    )
    essay_prompt_text = await _llm_call(prompt, max_tokens=300, no_think=True)

    # Save essay record (no essay yet)
    essay_id = str(uuid.uuid4())
    conn = get_db()
    conn.execute(
        "INSERT INTO book_essays (id, book_id, user_id, position_sec, prompt) VALUES (?,?,?,?,?)",
        (essay_id, req.book_id, user["id"], req.position_sec, essay_prompt_text)
    )
    conn.commit()
    conn.close()
    return {"essay_id": essay_id, "prompt": essay_prompt_text,
            "source_lang": row["source_lang"], "target_lang": row["target_lang"]}


class EssaySubmitRequest(BaseModel):
    essay_id:   str
    book_id:    str
    essay_text: str


@app.post("/api/essay/submit/stream")
async def submit_essay_stream(req: EssaySubmitRequest, user: dict = Depends(current_user)):
    """Stream essay review. Non-blocking — user can keep listening while review generates."""
    conn = get_db()
    essay_row = conn.execute(
        "SELECT prompt, position_sec FROM book_essays WHERE id=? AND user_id=?",
        (req.essay_id, user["id"])
    ).fetchone()
    book_row = conn.execute(
        "SELECT source_lang, target_lang, title FROM books WHERE id=? AND user_id=?",
        (req.book_id, user["id"])
    ).fetchone()
    conn.close()
    if not essay_row or not book_row:
        raise HTTPException(404)

    src = LANG_NAMES.get(book_row["source_lang"], book_row["source_lang"])
    tgt = LANG_NAMES.get(book_row["target_lang"], book_row["target_lang"])

    # Detect essay language (heuristic: if it contains Cyrillic → Russian)
    has_cyrillic = any('Ѐ' <= c <= 'ӿ' for c in req.essay_text)
    essay_lang = book_row["source_lang"] if has_cyrillic else book_row["target_lang"]
    essay_lang_name = LANG_NAMES.get(essay_lang, essay_lang)

    review_prompt = (
        f'Book: "{book_row["title"]}" ({src})\n'
        f'Essay task: {essay_row["prompt"]}\n\n'
        f'Student essay ({essay_lang_name}):\n{req.essay_text}\n\n'
        f"Review this essay in {tgt}:\n"
        f"1. Did the student understand the passage? (2-3 sentences)\n"
        f"2. {'Grammar and language quality: note 2-3 specific points.' if essay_lang == book_row['source_lang'] else 'Content quality and how well they engaged with the material.'}\n"
        f"3. One encouraging suggestion for improvement.\n"
        f"Be warm and constructive. No markdown."
    )

    async def generate():
        full_review = []
        async for token in _llm_stream([{"role": "user", "content": review_prompt}], max_tokens=600, no_think=True):
            full_review.append(token)
            yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"
        review_text = "".join(full_review)
        yield "data: {\"type\":\"done\"}\n\n"
        # Save essay + review
        conn = get_db()
        conn.execute(
            "UPDATE book_essays SET essay_text=?, review=? WHERE id=?",
            (req.essay_text, review_text, req.essay_id)
        )
        conn.commit()
        conn.close()

    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Voice input ────────────────────────────────────────────────────────────────

@app.post("/api/voice-input")
async def voice_input(file: UploadFile, user: dict = Depends(current_user)):
    """Transcribe a recorded audio blob for voice input (essay, chat, etc.)."""
    voice_id  = f"voice_{uuid.uuid4().hex[:12]}"
    tmp_audio = BOOKS_DIR / f"{voice_id}.webm"
    tmp_json  = TRANSCRIPTS_DIR / f"{voice_id}.json"
    try:
        async with aiofiles.open(tmp_audio, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                await f.write(chunk)
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
            resp = await client.post(
                f"{TRANSCRIPTION_URL}/transcribe",
                json={"file_path": str(tmp_audio), "book_id": voice_id},
            )
            resp.raise_for_status()
        text = ""
        if tmp_json.exists():
            async with aiofiles.open(tmp_json) as tf:
                td = json.loads(await tf.read())
                text = " ".join(s["text"].strip() for s in td.get("segments", []))
        return {"text": text}
    finally:
        for p in [tmp_audio, tmp_json]:
            try: p.unlink()
            except Exception: pass


async def _translate(text: str, source_lang: str, target_lang: str) -> str:
    src = LANG_NAMES.get(source_lang, source_lang)
    tgt = LANG_NAMES.get(target_lang, target_lang)
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers={"Authorization": "Bearer none"},
            json={
                "model": LLM_MODEL,
                "messages": [
                    {"role": "system", "content": f"Translate from {src} to {tgt}. Return only the translation, nothing else."},
                    {"role": "user",   "content": text},
                ],
                "temperature": 0.1,
                "max_tokens": 500,
            },
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()
