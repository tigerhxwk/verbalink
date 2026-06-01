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
from fastapi.responses import FileResponse
from ldap3 import Connection as LdapConn, NONE as LDAP_NONE, Server as LdapServer, SUBTREE
from passlib.context import CryptContext
from pydantic import BaseModel, field_validator

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

    # Migrations for existing databases that predate user columns
    for migration in [
        "ALTER TABLE books ADD COLUMN user_id TEXT",
        "ALTER TABLE collections ADD COLUMN user_id TEXT",
        "ALTER TABLE books ADD COLUMN translation_status TEXT DEFAULT 'none'",
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
        await run_translation(book_id)
    except Exception as e:
        conn = get_db()
        conn.execute("UPDATE books SET transcription_status='error', error=? WHERE id=?", (str(e), book_id))
        conn.commit()
        conn.close()


# ── LLM helpers ───────────────────────────────────────────────────────────────

async def _llm_call(prompt: str, max_tokens: int = 2000) -> str:
    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0)) as client:
        resp = await client.post(
            f"{LLM_BASE_URL}/chat/completions",
            headers={"Authorization": "Bearer none"},
            json={
                "model": LLM_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.2,
                "max_tokens": max_tokens,
            },
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()


async def _analyze_sentence(text: str, source_lang: str, target_lang: str) -> dict:
    src = LANG_NAMES.get(source_lang, source_lang)
    tgt = LANG_NAMES.get(target_lang, target_lang)
    prompt = (
        f'You are a language tutor. Analyze this {src} sentence:\n\n"{text}"\n\n'
        f"Return ONLY valid JSON, no markdown, no other text:\n"
        f'{{"translation":"<full {tgt} translation>","explanation":"<1–2 sentence {tgt} explanation of '
        f'meaning and any cultural context>","terms":[{{"term":"<original term>","meaning":"<{tgt} '
        f'explanation>","is_slang":false}}]}}\n'
        f"Include in \"terms\" only idioms, slang, phraseological units, or culturally-specific expressions. "
        f"Empty array if none."
    )
    raw = await _llm_call(prompt)
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


# ── Translation background task ───────────────────────────────────────────────

async def run_translation(book_id: str):
    conn = get_db()
    row = conn.execute(
        "SELECT source_lang, target_lang, title FROM books WHERE id=?", (book_id,)
    ).fetchone()
    conn.close()
    if not row:
        return

    path = TRANSCRIPTS_DIR / f"{book_id}.json"
    if not path.exists():
        return

    conn = get_db()
    conn.execute("UPDATE books SET translation_status='processing' WHERE id=?", (book_id,))
    conn.commit()
    conn.close()

    try:
        async with aiofiles.open(path) as f:
            data = json.loads(await f.read())

        segments = data.get("segments", [])
        if not segments:
            conn = get_db()
            conn.execute("UPDATE books SET translation_status='done' WHERE id=?", (book_id,))
            conn.commit()
            conn.close()
            return

        src_name = LANG_NAMES.get(row["source_lang"], row["source_lang"])
        tgt_name = LANG_NAMES.get(row["target_lang"], row["target_lang"])
        title = row["title"]
        BATCH = 40

        for i in range(0, len(segments), BATCH):
            batch = segments[i: i + BATCH]
            texts = [s["text"].strip() for s in batch]
            prompt = (
                f"Translate these {len(texts)} {src_name} sentences to {tgt_name}.\n"
                f'Book: "{title}"\n'
                f"Return ONLY a JSON array of {len(texts)} translated strings in the same order. "
                f"No markdown, no explanation.\n\n"
                + json.dumps(texts, ensure_ascii=False)
            )
            raw = await _llm_call(prompt, max_tokens=3000)
            m = re.search(r"\[.*\]", raw, re.DOTALL)
            if not m:
                raise ValueError(f"No JSON array in LLM response (batch {i}): {raw[:200]}")
            translations = json.loads(m.group())
            for j, seg in enumerate(batch):
                seg["translated_text"] = translations[j] if j < len(translations) else ""

        async with aiofiles.open(path, "w") as f:
            await f.write(json.dumps(data, ensure_ascii=False, indent=2))

        conn = get_db()
        conn.execute("UPDATE books SET translation_status='done' WHERE id=?", (book_id,))
        conn.commit()
        conn.close()
        logger.info(f"Translation complete: {book_id}")

    except Exception as e:
        logger.error(f"Translation failed ({book_id}): {e}")
        conn = get_db()
        conn.execute("UPDATE books SET translation_status='error' WHERE id=?", (book_id,))
        conn.commit()
        conn.close()


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
        raw = await _llm_call(prompt, max_tokens=10)
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
        "SELECT id, title, duration_sec, source_lang, target_lang, transcription_status, translation_status, error, created_at FROM books WHERE user_id=? ORDER BY created_at DESC",
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


@app.post("/api/books/{book_id}/translate")
async def trigger_translation(book_id: str, background_tasks: BackgroundTasks, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute(
        "SELECT transcription_status FROM books WHERE id=? AND user_id=?", (book_id, user["id"])
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)
    if row["transcription_status"] != "done":
        raise HTTPException(400, "Transcription not complete")
    background_tasks.add_task(run_translation, book_id)
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


@app.post("/api/clarify")
async def clarify(req: ClarifyRequest, user: dict = Depends(current_user)):
    conn = get_db()
    row = conn.execute(
        "SELECT source_lang, target_lang, transcription_status FROM books WHERE id=? AND user_id=?",
        (req.book_id, user["id"]),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404)
    if row["transcription_status"] != "done":
        raise HTTPException(400, "Transcript not ready yet")

    path = TRANSCRIPTS_DIR / f"{req.book_id}.json"
    async with aiofiles.open(path) as f:
        transcript = json.loads(await f.read())

    segments = transcript["segments"]
    done = [s for s in segments if s["end"] <= req.position_sec]
    if not done:
        raise HTTPException(400, "No complete sentence before this position")

    segment     = done[-1]
    original    = segment["text"].strip()
    source_lang = row["source_lang"]
    target_lang = row["target_lang"]

    # Rich analysis: translation + explanation + phraseological terms
    analysis = await _analyze_sentence(original, source_lang, target_lang)

    # UrbanDictionary lookup for slang terms (best-effort, parallel)
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

    # TTS for the translation (best-effort — no TTS service in dev)
    audio_b64 = None
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            tts = await client.post(
                f"{TTS_URL}/synthesize",
                json={"text": analysis["translation"], "lang": target_lang},
            )
            tts.raise_for_status()
            audio_b64 = base64.b64encode(tts.content).decode()
    except Exception:
        pass

    return {
        "original_text":   original,
        "translated_text": analysis["translation"],
        "explanation":     analysis.get("explanation", ""),
        "terms":           terms,
        "source_lang":     source_lang,
        "target_lang":     target_lang,
        "sentence_start":  segment["start"],
        "sentence_end":    segment["end"],
        "audio_translated": audio_b64,
    }


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
