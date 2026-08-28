import os
import time
import sqlite3
import ipaddress
import urllib.parse
import threading
import numpy as np
from typing import List, Optional, Any, Dict

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, JSONResponse
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "arcextreme.db")
SOULS_DIR = os.path.join(BASE_DIR, "souls")
os.makedirs(SOULS_DIR, exist_ok=True)

app = FastAPI(title="ArcEXtreme Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

faiss_index = None
faiss_dim = None
faiss_ids: List[int] = []

BUCKETS = {
    "当天": 1,
    "3天内": 3,
    "7天内": 7,
    "31天内": 31,
    "3个月": 90,
    "6个月": 180,
    "1年内": 365,
    "1年以上": 1e9,
}
SOUL_EXTS = (".md", ".txt", ".json", ".yaml", ".yml")
ALLOWED_PRIVATE_HOSTS = {'127.0.0.1', 'localhost', '::1', 'host.docker.internal'}

soul_lock = threading.Lock()

def _is_private_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
        hostname = parsed.hostname
        if not hostname:
            return False
        if hostname in ALLOWED_PRIVATE_HOSTS:
            return False
        try:
            ip = ipaddress.ip_address(hostname)
            return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
        except ValueError:
            return False
    except Exception:
        return False

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def _column_exists(conn, table, col):
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r["name"] == col for r in rows)

def init_db():
    conn = get_db()
    conn.execute(
        """CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id TEXT NOT NULL,
            timestamp REAL NOT NULL,
            time_bucket TEXT NOT NULL,
            role1 TEXT,
            role2 TEXT,
            souls TEXT,
            event_text TEXT NOT NULL,
            vector BLOB,
            metadata TEXT
        )"""
    )
    # migrate: add new columns if missing
    for col, typ in [("created_at","REAL"),("last_active_at","REAL"),("counter","INTEGER")]:
        if not _column_exists(conn, "events", col):
            conn.execute(f"ALTER TABLE events ADD COLUMN {col} {typ}")
    # backfill
    try:
        conn.execute("UPDATE events SET created_at = timestamp WHERE created_at IS NULL")
        conn.execute("UPDATE events SET last_active_at = timestamp WHERE last_active_at IS NULL")
    except: pass
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_bucket ON events(time_bucket)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_events_last_active ON events(last_active_at)")
    # new tables
    conn.execute("""CREATE TABLE IF NOT EXISTS event_soul_state(
        event_id INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        soul TEXT NOT NULL,
        counter INTEGER NOT NULL CHECK(counter IN (0,1,2,3)),
        skip INTEGER NOT NULL DEFAULT 0,
        stuck INTEGER NOT NULL DEFAULT 0,
        birth_ts REAL NOT NULL,
        last_eval REAL,
        why_init TEXT,
        why_log TEXT,
        PRIMARY KEY(event_id, soul),
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )""")
    # migration for old db
    if not _column_exists(conn, "event_soul_state", "why_init"):
        try: conn.execute("ALTER TABLE event_soul_state ADD COLUMN why_init TEXT")
        except: pass
    if not _column_exists(conn, "event_soul_state", "why_log"):
        try: conn.execute("ALTER TABLE event_soul_state ADD COLUMN why_log TEXT")
        except: pass
    conn.execute("CREATE INDEX IF NOT EXISTS idx_state_chat_soul ON event_soul_state(chat_id, soul)")
    conn.execute("""CREATE TABLE IF NOT EXISTS short_pool(
        chat_id TEXT NOT NULL,
        soul TEXT NOT NULL,
        event_id INTEGER NOT NULL,
        PRIMARY KEY(chat_id, soul, event_id),
        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pool_chat_soul ON short_pool(chat_id, soul)")
    conn.execute("""CREATE TABLE IF NOT EXISTS sublimated(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        soul TEXT NOT NULL,
        event_id INTEGER,
        counter INTEGER,
        title TEXT,
        content TEXT NOT NULL,
        created_at REAL NOT NULL
    )""")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sublimated_chat_soul ON sublimated(chat_id, soul)")
    conn.commit()
    conn.close()

def get_bucket(ts_ms: float) -> str:
    days = (time.time() * 1000 - ts_ms) / 86400000.0
    if days < 1:
        return "当天"
    if days <= 3:
        return "3天内"
    if days <= 7:
        return "7天内"
    if days <= 31:
        return "31天内"
    if days <= 90:
        return "3个月"
    if days <= 180:
        return "6个月"
    if days <= 365:
        return "1年内"
    return "1年以上"

def vector_to_blob(v) -> bytes:
    return np.asarray(v, dtype=np.float32).tobytes()

def blob_to_vector(b) -> List[float]:
    return np.frombuffer(b, dtype=np.float32).tolist()

def normalize(v) -> np.ndarray:
    arr = np.asarray(v, dtype=np.float32)
    norm = np.linalg.norm(arr)
    if norm > 0:
        arr = arr / norm
    return arr

def _parse_souls_field(val):
    if val is None:
        return []
    if isinstance(val, list):
        return [str(x).strip() for x in val if str(x).strip()]
    s = str(val).strip()
    if not s:
        return []
    if s.startswith('['):
        try:
            import json as _j
            arr = _j.loads(s)
            if isinstance(arr, list):
                return [str(x).strip() for x in arr if str(x).strip()]
        except: pass
    if ',' in s:
        return [x.strip() for x in s.split(',') if x.strip()]
    return [s]

def _souls_to_store(val):
    arr = _parse_souls_field(val)
    import json as _j
    return _j.dumps(arr, ensure_ascii=False) if arr else None

def get_event(eid: int):
    conn = get_db()
    row = conn.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
    conn.close()
    if not row:
        return None
    return serialize_event(row)

def serialize_event(row) -> dict:
    raw = row["souls"]
    arr = _parse_souls_field(raw)
    souls_str = ", ".join(arr) if arr else None
    # new fields with fallback
    try:
        created_at = row["created_at"] if "created_at" in row.keys() else row["timestamp"]
    except: created_at = row["timestamp"]
    try:
        last_active_at = row["last_active_at"] if "last_active_at" in row.keys() else row["timestamp"]
    except: last_active_at = row["timestamp"]
    try:
        counter = row["counter"] if "counter" in row.keys() else None
    except: counter = None
    # fetch state if needed
    return {
        "id": row["id"],
        "chat_id": row["chat_id"],
        "timestamp": row["timestamp"],
        "created_at": created_at,
        "last_active_at": last_active_at,
        "counter": counter,
        "time_bucket": row["time_bucket"],
        "role1": row["role1"],
        "role2": row["role2"],
        "souls": arr,
        "souls_str": souls_str,
        "souls_raw": raw,
        "event_text": row["event_text"],
    }

def serialize_event_with_state(row, state=None):
    base = serialize_event(row)
    if state:
        # state may be Row with why fields
        try:
            why_init = state["why_init"] if "why_init" in state.keys() else None
        except: why_init=None
        try:
            why_log = state["why_log"] if "why_log" in state.keys() else None
        except: why_log=None
        # why_log is JSON string
        try:
            import json as _j
            why_arr = _j.loads(why_log) if why_log else []
            if not isinstance(why_arr, list): why_arr=[]
        except: why_arr=[]
        base.update({
            "counter": state["counter"],
            "skip": state["skip"],
            "stuck": state["stuck"],
            "birth_ts": state["birth_ts"],
            "last_eval": state["last_eval"],
            "why_init": why_init,
            "why_log": why_arr,
            "why_log_raw": why_log,
        })
    return base

def ensure_index(dim: int):
    global faiss_index, faiss_dim
    import faiss
    if faiss_index is None:
        faiss_index = faiss.IndexFlatL2(dim)
        faiss_dim = dim
    elif faiss_dim != dim:
        raise HTTPException(400, f"向量维度不匹配：索引为 {faiss_dim}，传入为 {dim}")

def load_index():
    global faiss_ids
    conn = get_db()
    rows = conn.execute("SELECT id, vector FROM events WHERE vector IS NOT NULL ORDER BY id").fetchall()
    conn.close()
    if not rows:
        return
    vecs = []
    faiss_ids = []
    for r in rows:
        v = blob_to_vector(r["vector"])
        vecs.append(v)
        faiss_ids.append(r["id"])
    if not vecs:
        return
    dim = len(vecs[0])
    ensure_index(dim)
    arr = np.asarray(vecs, dtype=np.float32)
    faiss_index.add(arr)

def age_days(ts_ms: float) -> float:
    return (time.time() * 1000 - ts_ms) / 86400000.0

def event_qualifies(ts_ms: float, event_bucket: str, selected: List[str]) -> bool:
    if not selected:
        return True
    days = age_days(ts_ms)
    for b in selected:
        if b == "1年以上":
            if days > 365:
                return True
        else:
            max_d = BUCKETS.get(b, 1e9)
            if days <= max_d:
                return True
    return False

# ---------------- ShortPool helpers ----------------
def _enforce_cap(chat_id: str, cap: int = 15):
    try:
        conn2 = get_db()
        souls_rows = conn2.execute("SELECT DISTINCT soul FROM short_pool WHERE chat_id=?", (chat_id,)).fetchall()
        for r in souls_rows:
            so = r["soul"]
            cnt = conn2.execute("SELECT COUNT(*) as c FROM short_pool WHERE chat_id=? AND soul=?", (chat_id, so)).fetchone()["c"]
            if cnt > cap:
                excess = cnt - cap
                # 优先按 skip>3 逐出
                rows = conn2.execute("""
                    SELECT sp.event_id FROM short_pool sp
                    JOIN event_soul_state s ON s.event_id=sp.event_id AND s.soul=sp.soul
                    WHERE sp.chat_id=? AND sp.soul=? AND s.skip > 3
                    ORDER BY s.skip DESC, s.birth_ts ASC LIMIT ?
                """, (chat_id, so, excess)).fetchall()
                to_del = [rr["event_id"] for rr in rows]
                need = excess - len(to_del)
                if need > 0:
                    all_rows = conn2.execute("""
                        SELECT sp.event_id FROM short_pool sp
                        JOIN event_soul_state s ON s.event_id=sp.event_id AND s.soul=sp.soul
                        WHERE sp.chat_id=? AND sp.soul=? ORDER BY s.birth_ts ASC
                    """, (chat_id, so)).fetchall()
                    candidates = [x["event_id"] for x in all_rows if x["event_id"] not in to_del]
                    for i in range(need):
                        if not candidates: break
                        mid = len(candidates)//2
                        to_del.append(candidates.pop(mid))
                for eid in to_del:
                    conn2.execute("DELETE FROM short_pool WHERE chat_id=? AND soul=? AND event_id=?", (chat_id, so, eid))
        conn2.commit()
        conn2.close()
    except Exception as e:
        print(f"[enforce_cap] {e}")

def get_short_pool(chat_id: str, soul: Optional[str]=None, cap: int = 15):
    try:
        cap = int(cap)
    except:
        cap = 15
    cap = max(1, min(50, cap))
    _enforce_cap(chat_id, cap)
    conn = get_db()
    if soul:
        rows = conn.execute("""
            SELECT e.*, s.counter, s.skip, s.stuck, s.birth_ts, s.last_eval, s.why_init, s.why_log, sp.soul as pool_soul
            FROM short_pool sp
            JOIN events e ON e.id = sp.event_id
            LEFT JOIN event_soul_state s ON s.event_id = e.id AND s.soul = sp.soul
            WHERE sp.chat_id=? AND sp.soul=?
            ORDER BY s.birth_ts ASC
        """, (chat_id, soul)).fetchall()
    else:
        rows = conn.execute("""
            SELECT e.*, s.counter, s.skip, s.stuck, s.birth_ts, s.last_eval, s.why_init, s.why_log, sp.soul as pool_soul
            FROM short_pool sp
            JOIN events e ON e.id = sp.event_id
            LEFT JOIN event_soul_state s ON s.event_id = e.id AND s.soul = sp.soul
            WHERE sp.chat_id=?
            ORDER BY sp.soul, s.birth_ts ASC
        """, (chat_id,)).fetchall()
    conn.close()
    out = []
    for r in rows:
        d = serialize_event_with_state(r, r)
        d["pool_soul"] = r["pool_soul"]
        out.append(d)
    return out

def apply_counter_action(counter:int, action:str)->int:
    if action == "+1":
        return min(3, counter+1)
    if action == "-1":
        return max(0, counter-1)
    return counter  # Skip

# --------------------------------------------------------------------------- #
# Request models
# --------------------------------------------------------------------------- #
class EventInsert(BaseModel):
    chat_id: str
    event_text: str
    role1: Optional[str] = None
    role2: Optional[str] = None
    souls: Optional[Any] = None
    soul: Optional[str] = None
    counter: Optional[int] = None
    why: Optional[str] = None
    timestamp: float
    vector: List[float]
    metadata: Optional[dict] = None
    perSoulCap: Optional[int] = 15

class EventInsertBatch(BaseModel):
    chat_id: str
    events: List[Dict[str, Any]]  # each {event_text, soul/souls, counter, vector, timestamp}
    perSoulCap: Optional[int] = 15

class EventQuery(BaseModel):
    chat_id: str
    vector: List[float]
    buckets: List[str] = []
    souls: List[str] = []
    k: int = 10
    weightMultipliers: Optional[Dict[str, float]] = None

class ShortPoolSync(BaseModel):
    chat_id: str
    evaluations: List[Dict[str, Any]]  # {event_id, soul, action: "+1"/"-1"/"Skip"}

class ShortPoolPrepare(BaseModel):
    chat_id: str
    perSoulCap: int = 15
    skipThreshold: int = 3
    needVacancies: Optional[Dict[str, int]] = None  # soul->need count, if None auto 1 per full pool

class ShortPoolFill(BaseModel):
    chat_id: str
    items: List[Dict[str, Any]]  # {event_id, soul}
    perSoulCap: Optional[int] = 15

class SoulAppend(BaseModel):
    filename: str
    content: str
    title: Optional[str] = None
    chat_id: Optional[str] = None
    soul: Optional[str] = None
    event_id: Optional[int] = None
    counter: Optional[int] = None

class RerankProxy(BaseModel):
    url: str
    api_key: Optional[str] = None
    payload: dict

class LLMProxy(BaseModel):
    url: str
    api_key: Optional[str] = None
    payload: Dict[str, Any]
    timeout: Optional[int] = 90
    verify_ssl: Optional[bool] = False

class EmbeddingProxy(BaseModel):
    url: str
    api_key: Optional[str] = None
    payload: Dict[str, Any]
    source: Optional[str] = 'openai'
    timeout: Optional[int] = 30
    verify_ssl: Optional[bool] = False

# --------------------------------------------------------------------------- #
# Souls
# --------------------------------------------------------------------------- #
def safe_soul_path(filename: str):
    base = os.path.basename(filename)
    full = os.path.join(SOULS_DIR, base)
    if not os.path.abspath(full).startswith(os.path.abspath(SOULS_DIR)):
        raise HTTPException(400, "非法文件名")
    return full

@app.get("/api/souls")
def list_souls():
    items = []
    for fn in sorted(os.listdir(SOULS_DIR)):
        if fn.lower().endswith(SOUL_EXTS):
            full = os.path.join(SOULS_DIR, fn)
            try:
                size = os.path.getsize(full)
                mtime = os.path.getmtime(full)
            except OSError:
                size = 0
                mtime = 0
            items.append({
                "name": os.path.splitext(fn)[0],
                "filename": fn,
                "format": os.path.splitext(fn)[1].lstrip("."),
                "size_bytes": size,
                "modified_at": mtime,
            })
    return {"souls": items}

@app.get("/api/souls/{filename}")
def read_soul(filename: str):
    full = safe_soul_path(filename)
    if not os.path.isfile(full):
        raise HTTPException(404, "souls 文件不存在")
    with open(full, "r", encoding="utf-8", errors="replace") as f:
        return PlainTextResponse(f.read())

@app.post("/api/souls/append")
def append_soul(payload: SoulAppend):
    full = safe_soul_path(payload.filename)
    # ensure file exists
    if not os.path.isfile(full):
        # create if not exists
        open(full, "a", encoding="utf-8").close()
    marker = f"\n\n<!-- ArcEXtreme Sublimated {time.strftime('%Y-%m-%d %H:%M:%S')} soul={payload.soul or ''} counter={payload.counter if payload.counter is not None else ''} event={payload.event_id or ''} -->\n"
    if payload.title:
        block = f"{marker}## {payload.title}\n{payload.content}\n"
    else:
        block = f"{marker}{payload.content}\n"
    with soul_lock:
        with open(full, "a", encoding="utf-8") as f:
            f.write(block)
        # also record in sublimated table if chat_id/soul provided
        if payload.chat_id and payload.soul:
            try:
                conn = get_db()
                conn.execute("INSERT INTO sublimated(chat_id,soul,event_id,counter,title,content,created_at) VALUES (?,?,?,?,?,?,?)",
                    (payload.chat_id, payload.soul, payload.event_id, payload.counter, payload.title, payload.content, time.time()*1000))
                conn.commit()
                conn.close()
            except Exception as e:
                print(f"[append_soul] sublimated insert failed: {e}")
    return {"ok": True, "path": full}

@app.get("/api/sublimated")
def list_sublimated(chat_id: str, soul: Optional[str]=None):
    conn = get_db()
    if soul:
        rows = conn.execute("SELECT * FROM sublimated WHERE chat_id=? AND soul=? ORDER BY created_at DESC", (chat_id, soul)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM sublimated WHERE chat_id=? ORDER BY created_at DESC", (chat_id,)).fetchall()
    conn.close()
    return {"items": [dict(r) for r in rows]}

# --------------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------------- #
@app.post("/api/events/insert")
def insert_event(payload: EventInsert):
    global faiss_ids
    vec = normalize(payload.vector)
    dim = len(vec)
    ensure_index(dim)
    if faiss_index is not None and faiss_index.ntotal > 0 and faiss_dim != dim:
        raise HTTPException(400, f"向量维度不匹配：索引为 {faiss_dim}，传入为 {dim}")
    ts = payload.timestamp
    now = ts
    # dual time: created_at = ts, last_active_at = ts (enters short pool => today)
    bucket = get_bucket(ts)  # still use ts for bucket initially, but will update last_active
    # resolve soul/counter
    # priority: soul field > souls field
    souls_arr = []
    counter = payload.counter
    if counter is not None:
        try: counter = int(counter)
        except: counter = 2
        counter = max(0, min(3, counter))
    else:
        counter = 2
    if payload.soul:
        souls_arr = [str(payload.soul).strip()]
        if not souls_arr[0]:
            souls_arr = []
    else:
        souls_arr = _parse_souls_field(payload.souls)
        # for legacy multi-soul event, we will keep as is but also create state for first soul only?
        # new 1:1 mode will use soul field
    souls_store = _souls_to_store(souls_arr if souls_arr else payload.souls)
    r1 = payload.role1 or (souls_arr[0] if souls_arr else None)
    r2 = payload.role2 or (souls_arr[1] if len(souls_arr) > 1 else None)
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO events
           (chat_id, timestamp, created_at, last_active_at, time_bucket, role1, role2, souls, event_text, vector, metadata, counter)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            payload.chat_id,
            ts,
            ts,
            ts,
            bucket,
            r1,
            r2,
            souls_store,
            payload.event_text,
            vector_to_blob(vec),
            __import__("json").dumps(payload.metadata or {}),
            counter,
        ),
    )
    eid = cur.lastrowid
    # create state per soul (1:1) with why_init (原事件500字空间)
    now_ms = time.time()*1000
    why_init = (payload.why or (payload.metadata or {}).get('why') or '')[:500] if payload.why or payload.metadata else ''
    # also try metadata why
    if not why_init and payload.metadata:
        why_init = str(payload.metadata.get('why') or '')[:500]
    for s in (souls_arr or [None]):
        if not s:
            continue
        try:
            conn.execute("INSERT INTO event_soul_state(event_id,chat_id,soul,counter,skip,stuck,birth_ts,last_eval,why_init,why_log) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (eid, payload.chat_id, s, counter, 0, 0, now_ms, now_ms, why_init, '[]'))
            conn.execute("INSERT OR IGNORE INTO short_pool(chat_id,soul,event_id) VALUES (?,?,?)",
                (payload.chat_id, s, eid))
        except Exception as e:
            print(f"[insert] state failed {e}")
    # handle long text without soul -> also store but no pool
    # 硬限：按 perSoulCap（默认15，来自前端配置，避免与后端墙不一致），越限立即按 skip>阈值 else 中位数 逐出
    try:
        for s in (souls_arr or []):
            if not s: continue
            cnt = conn.execute("SELECT COUNT(*) as c FROM short_pool WHERE chat_id=? AND soul=?", (payload.chat_id, s)).fetchone()["c"]
            try:
                cap = int(payload.perSoulCap) if payload.perSoulCap is not None else 15
                cap = max(1, min(50, cap))
            except:
                cap = 15
            while cnt > cap:
                # 优先 skip>3
                rows = conn.execute("""
                    SELECT sp.event_id, s2.skip, s2.birth_ts FROM short_pool sp
                    JOIN event_soul_state s2 ON s2.event_id=sp.event_id AND s2.soul=sp.soul
                    WHERE sp.chat_id=? AND sp.soul=? AND s2.skip > 3
                    ORDER BY s2.skip DESC, s2.birth_ts ASC LIMIT 1
                """, (payload.chat_id, s)).fetchall()
                victim = rows[0]["event_id"] if rows else None
                if victim is None:
                    # 中位数
                    all_rows = conn.execute("""
                        SELECT sp.event_id, s2.birth_ts FROM short_pool sp
                        JOIN event_soul_state s2 ON s2.event_id=sp.event_id AND s2.soul=sp.soul
                        WHERE sp.chat_id=? AND sp.soul=? ORDER BY s2.birth_ts ASC
                    """, (payload.chat_id, s)).fetchall()
                    if not all_rows: break
                    mid = len(all_rows)//2
                    victim = all_rows[mid]["event_id"]
                if victim is None: break
                conn.execute("DELETE FROM short_pool WHERE chat_id=? AND soul=? AND event_id=?", (payload.chat_id, s, victim))
                cnt -= 1
    except Exception as e:
        print(f"[insert] cap enforce failed {e}")
    conn.commit()
    conn.close()
    arr = np.asarray([vec], dtype=np.float32)
    faiss_index.add(arr)
    faiss_ids.append(eid)
    # enforce cap per soul immediately if needed (async clean)
    # we do not auto-evict here; frontend will call prepare
    return {"id": eid, "time_bucket": bucket, "counter": counter}

@app.post("/api/events/insert_batch")
def insert_batch(payload: EventInsertBatch):
    results = []
    # 兼容前端 perSoulCap（默认15），若批次未传则用15兜底
    try:
        batch_cap = int(payload.perSoulCap) if payload.perSoulCap is not None else 15
        batch_cap = max(1, min(50, batch_cap))
    except:
        batch_cap = 15
    for ev in payload.events:
        try:
            # merge why from top-level or metadata
            why_val = ev.get("why") or ev.get("reason") or (ev.get("metadata") or {}).get("why") or ""
            meta = ev.get("metadata") or {}
            if why_val and "why" not in meta:
                meta["why"] = why_val
            p = EventInsert(
                chat_id=payload.chat_id,
                event_text=ev.get("event_text") or ev.get("event") or "",
                soul=ev.get("soul"),
                souls=ev.get("souls"),
                counter=ev.get("counter"),
                why=why_val,
                timestamp=ev.get("timestamp") or time.time()*1000,
                vector=ev.get("vector"),
                metadata=meta,
                perSoulCap=batch_cap,
            )
            r = insert_event(p)
            results.append(r)
        except Exception as e:
            results.append({"error": str(e), "event": ev.get("event_text","")[:40]})
    return {"results": results}

@app.get("/api/events/recent")
def recent_events(chat_id: str, days: int = 3):
    cutoff = time.time() * 1000 - days * 86400000.0
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM events WHERE chat_id=? AND timestamp>=? ORDER BY timestamp DESC",
        (chat_id, cutoff),
    ).fetchall()
    conn.close()
    return {"events": [serialize_event(r) for r in rows]}

@app.post("/api/events/query")
def query_events(payload: EventQuery):
    if faiss_index is None or faiss_index.ntotal == 0:
        return {"results": []}
    q = normalize(payload.vector).reshape(1, -1).astype(np.float32)
    import faiss
    faiss.normalize_L2(q)
    k_search = max(payload.k * 6, 30)
    D, I = faiss_index.search(q, k_search)
    # weight multipliers
    wm = payload.weightMultipliers or {}
    # normalize keys to int
    wmap = {}
    for k,v in wm.items():
        try:
            iv = int(k)
            wmap[iv] = float(v)
        except: pass
    # if frontend sends m0..m3 style
    # also support {m0:1.2}?

    results = []
    for dist, pos in zip(D[0], I[0]):
        if pos == -1:
            continue
        eid = faiss_ids[pos]
        ev = get_event(eid)
        if ev is None or ev["chat_id"] != payload.chat_id:
            continue
        # use last_active_at for bucket check if available
        ts_for_bucket = ev.get("last_active_at") or ev["timestamp"]
        if not event_qualifies(ts_for_bucket, ev["time_bucket"], payload.buckets):
            continue
        if payload.souls:
            ev_souls = ev.get("souls") or []
            if isinstance(ev_souls, str):
                ev_souls = _parse_souls_field(ev_souls)
            if not ev_souls:
                continue
            if not any(s in ev_souls for s in payload.souls):
                continue
        sim = 1.0 - float(dist) / 2.0
        # apply weight if we have counter
        # need to fetch counter from state? use events.counter as fallback, else event_soul_state
        # try to get max counter among relevant souls for weighting
        # if ev has single soul, use that
        # otherwise, use generic counter field
        c = ev.get("counter")
        if c is None:
            # try state lookup for any of payload souls
            try:
                conn = get_db()
                prow = conn.execute("SELECT counter FROM event_soul_state WHERE event_id=? LIMIT 1", (eid,)).fetchone()
                conn.close()
                if prow:
                    c = prow["counter"]
            except: pass
        if c is not None and c in wmap:
            sim = sim * wmap[c]
        # support m0-m3 keys
        # fallback if wm has m0
        if payload.weightMultipliers and f"m{c}" in payload.weightMultipliers:
            try:
                sim = sim * float(payload.weightMultipliers[f"m{c}"])
            except: pass
        results.append({**ev, "score": sim, "weighted": bool(c in wmap)})
    results.sort(key=lambda x: -x["score"])
    return {"results": results[: payload.k]}

@app.get("/api/events")
def list_events(chat_id: str, with_counters: int = 0, soul: Optional[str]=None, counter: Optional[int]=None, limit: int = 100, offset: int = 0, bucket: Optional[str]=None, Bucket: Optional[str]=None):
    # 兼容大小写 bucket 参数
    bucket_val = bucket if bucket is not None else Bucket
    conn = get_db()
    # base query - 若需按 bucket 过滤，则先不加 LIMIT/OFFSET，过滤后再分页，以保证动态桶正确
    need_bucket_filter = bucket_val is not None and str(bucket_val).strip() != ""
    if with_counters:
        # join state with why
        q = "SELECT e.*, s.counter as scounter, s.skip, s.stuck, s.birth_ts, s.last_eval, s.why_init, s.why_log, s.soul as state_soul, e.last_active_at as e_last_active FROM events e LEFT JOIN event_soul_state s ON s.event_id=e.id WHERE e.chat_id=? "
        params = [chat_id]
        if soul:
            q += " AND s.soul=? "
            params.append(soul)
        if counter is not None:
            q += " AND s.counter=? "
            params.append(counter)
        q += " ORDER BY e.timestamp DESC"
        if not need_bucket_filter:
            q += " LIMIT ? OFFSET ?"
            params.extend([limit, offset])
        rows = conn.execute(q, params).fetchall()
        out = []
        for r in rows:
            d = serialize_event(r)
            # 动态桶：长期库按原始创建时间（timestamp/created_at）实时计算，避免 last_active 被短期池刷新而“永当天”；短期池的 last_active 刷新不影响长期库的桶老化
            try:
                ts_for_bucket = d.get("timestamp")
                # 若 timestamp 缺失则回退到 last_active
                if ts_for_bucket is None:
                    try:
                        ts_for_bucket = r["e_last_active"] if "e_last_active" in r.keys() and r["e_last_active"] is not None else None
                    except:
                        ts_for_bucket = None
                if ts_for_bucket is None:
                    ts_for_bucket = d.get("last_active_at")
                dyn_bucket = get_bucket(float(ts_for_bucket)) if ts_for_bucket is not None else d.get("time_bucket")
                d["time_bucket"] = dyn_bucket
            except:
                pass
            # enrich
            try:
                d["counter"] = r["scounter"] if r["scounter"] is not None else d.get("counter")
                d["skip"] = r["skip"]
                d["stuck"] = r["stuck"]
                d["birth_ts"] = r["birth_ts"]
                d["last_eval"] = r["last_eval"]
                d["state_soul"] = r["state_soul"]
                d["why_init"] = r["why_init"]
                try:
                    import json as _j2
                    d["why_log"] = _j2.loads(r["why_log"]) if r["why_log"] else []
                except:
                    d["why_log"] = []
            except: pass
            out.append(d)
        # 桶过滤（精确匹配动态桶）
        if need_bucket_filter:
            out = [d for d in out if (d.get("time_bucket") or "") == bucket_val]
            out = out[offset: offset+limit] if limit else out[offset:]
    else:
        if need_bucket_filter:
            rows = conn.execute(
                "SELECT * FROM events WHERE chat_id=? ORDER BY timestamp DESC", (chat_id,)
            ).fetchall()
            tmp = [serialize_event(r) for r in rows]
            # 动态桶：按 timestamp 老化
            for d in tmp:
                try:
                    tsb = d.get("timestamp")
                    if tsb is None:
                        tsb = d.get("last_active_at")
                    d["time_bucket"] = get_bucket(float(tsb)) if tsb is not None else d.get("time_bucket")
                except:
                    pass
            tmp = [d for d in tmp if (d.get("time_bucket") or "") == bucket_val]
            out = tmp[offset: offset+limit] if limit else tmp[offset:]
        else:
            rows = conn.execute(
                "SELECT * FROM events WHERE chat_id=? ORDER BY timestamp DESC LIMIT ? OFFSET ?", (chat_id, limit, offset)
            ).fetchall()
            out = [serialize_event(r) for r in rows]
            # 即使不过滤，也刷新为动态桶以正确显示（按原始创建时间）
            for d in out:
                try:
                    tsb = d.get("timestamp")
                    if tsb is None:
                        tsb = d.get("last_active_at")
                    d["time_bucket"] = get_bucket(float(tsb)) if tsb is not None else d.get("time_bucket")
                except:
                    pass
    conn.close()
    return {"events": out}

@app.delete("/api/events/{event_id}")
def delete_event(event_id: int):
    conn = get_db()
    conn.execute("DELETE FROM events WHERE id=?", (event_id,))
    conn.execute("DELETE FROM event_soul_state WHERE event_id=?", (event_id,))
    conn.execute("DELETE FROM short_pool WHERE event_id=?", (event_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.post("/api/events/clear")
def clear_events(chat_id: str):
    conn = get_db()
    conn.execute("DELETE FROM events WHERE chat_id=?", (chat_id,))
    conn.execute("DELETE FROM event_soul_state WHERE chat_id=?", (chat_id,))
    conn.execute("DELETE FROM short_pool WHERE chat_id=?", (chat_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.post("/api/reload")
def reload_index():
    global faiss_index
    faiss_index = None
    load_index()
    return {"ok": True, "faiss_count": faiss_index.ntotal if faiss_index else 0}

# --------------------------------------------------------------------------- #
# Short Pool
# --------------------------------------------------------------------------- #
@app.get("/api/short_pool")
def api_get_short_pool(chat_id: str, soul: Optional[str]=None, perSoulCap: Optional[int]=None):
    # 前端传入 perSoulCap 时按前端配置校正，否则默认 15 兜底（同时自愈历史超限）
    try:
        cap = int(perSoulCap) if perSoulCap is not None else 15
        cap = max(1, min(50, cap))
    except:
        cap = 15
    items = get_short_pool(chat_id, soul, cap)
    # group by soul if no filter
    if soul:
        return {"events": items, "soul": soul, "count": len(items)}
    # group
    grouped = {}
    for it in items:
        s = it.get("pool_soul") or "unknown"
        grouped.setdefault(s, []).append(it)
    return {"pools": grouped, "events": items, "count": len(items)}

@app.post("/api/short_pool/enforce")
def api_enforce_short_pool(payload: Dict[str, Any]):
    chat_id = payload.get("chat_id")
    if not chat_id:
        raise HTTPException(400, "missing chat_id")
    try:
        cap = int(payload.get("perSoulCap", 15))
        cap = max(1, min(50, cap))
    except:
        cap = 15
    # 先统计
    conn = get_db()
    before = {row["soul"]: row["c"] for row in conn.execute("SELECT soul, COUNT(*) as c FROM short_pool WHERE chat_id=? GROUP BY soul", (chat_id,)).fetchall()}
    conn.close()
    _enforce_cap(chat_id, cap)
    conn = get_db()
    after = {row["soul"]: row["c"] for row in conn.execute("SELECT soul, COUNT(*) as c FROM short_pool WHERE chat_id=? GROUP BY soul", (chat_id,)).fetchall()}
    conn.close()
    return {"ok": True, "perSoulCap": cap, "before": before, "after": after}

@app.post("/api/short_pool/sync")
def api_sync_short_pool(payload: ShortPoolSync):
    conn = get_db()
    updated = []
    now = time.time()*1000
    for ev in payload.evaluations:
        eid = ev.get("event_id") or ev.get("id")
        soul = ev.get("soul")
        action = ev.get("action")
        why = (ev.get("why") or ev.get("reason") or "")[:120]
        if not eid or not soul or action not in ("+1","-1","Skip"):
            continue
        row = conn.execute("SELECT * FROM event_soul_state WHERE event_id=? AND soul=?", (eid, soul)).fetchone()
        if not row:
            continue
        cur = row["counter"]
        new_counter = apply_counter_action(cur, action)
        # skip logic
        if action == "Skip":
            new_skip = (row["skip"] or 0) + 1
        else:
            new_skip = 0
        # stuck logic: if stays 0 or 3
        if new_counter in (0,3):
            if cur in (0,3) and new_counter == cur:
                new_stuck = (row["stuck"] or 0) + 1
            elif new_counter in (0,3):
                new_stuck = 1
            else:
                new_stuck = (row["stuck"] or 0) + 1 if new_counter in (0,3) else 0
            if action == "Skip" and cur in (0,3) and new_counter in (0,3):
                new_stuck = (row["stuck"] or 0) + 1
        else:
            new_stuck = 0
        if new_counter not in (0,3):
            new_stuck = 0
        # why_log: only +1/-1 appends
        try:
            old_why_log = row["why_log"] if "why_log" in row.keys() else None
            import json as _j
            why_log = _j.loads(old_why_log) if old_why_log else []
            if not isinstance(why_log, list): why_log=[]
        except:
            why_log=[]
        if action in ("+1","-1") and why:
            why_log.append({"ts": now, "action": action, "why": why, "old": cur, "new": new_counter})
            # keep last 20
            if len(why_log) > 20:
                why_log = why_log[-20:]
            why_log_str = __import__("json").dumps(why_log, ensure_ascii=False)
        else:
            # Skip不追加
            try:
                why_log_str = __import__("json").dumps(why_log, ensure_ascii=False) if why_log else '[]'
            except:
                why_log_str = '[]'
        # handle saturated +1/-1 with no counter change but action indicates attempt: still not append? spec says to顶不追加，所以若新旧相等且为饱和则不算更新，不追加
        # 上面已按 Skip 不追加，但饱和的 +1/-1 若 counter未变（已顶），也不追加why
        if action in ("+1","-1") and new_counter == cur and cur in (0,3):
            # 饱和不追加，移除刚加的
            if why_log and why_log[-1].get("why")==why:
                why_log.pop()
                why_log_str = __import__("json").dumps(why_log, ensure_ascii=False)
        conn.execute("UPDATE event_soul_state SET counter=?, skip=?, stuck=?, last_eval=?, why_log=? WHERE event_id=? AND soul=?",
            (new_counter, new_skip, new_stuck, now, why_log_str, eid, soul))
        conn.execute("UPDATE events SET last_active_at=?, counter=? WHERE id=?", (now, new_counter, eid))
        bucket = get_bucket(now)
        conn.execute("UPDATE events SET time_bucket=? WHERE id=?", (bucket, eid))
        updated.append({"event_id": eid, "soul": soul, "old": cur, "new": new_counter, "action": action, "why": why, "skip": new_skip, "stuck": new_stuck})
    conn.commit()
    conn.close()
    return {"updated": updated, "count": len(updated)}

@app.post("/api/short_pool/prepare")
def api_prepare_short_pool(payload: ShortPoolPrepare):
    conn = get_db()
    freed = []
    vacancies = {}
    # get distinct souls in this chat that have pools
    souls_rows = conn.execute("SELECT DISTINCT soul FROM short_pool WHERE chat_id=?", (payload.chat_id,)).fetchall()
    souls = [r["soul"] for r in souls_rows]
    # also consider souls that may need vacancies for upcoming insert? fallback to needVacancies
    if payload.needVacancies:
        for s in payload.needVacancies.keys():
            if s not in souls:
                souls.append(s)
    for soul in souls:
        # count current
        cnt_row = conn.execute("SELECT COUNT(*) as c FROM short_pool WHERE chat_id=? AND soul=?", (payload.chat_id, soul)).fetchone()
        cnt = cnt_row["c"] if cnt_row else 0
        need = 0
        if payload.needVacancies and soul in payload.needVacancies:
            need = int(payload.needVacancies[soul])
            # 越限自愈：若已超cap，至少释放 excess
            if cnt > payload.perSoulCap:
                need = max(need, cnt - payload.perSoulCap + (1 if need else 0))
        else:
            # 常规：满则腾1坑；超限则腾 excess+1
            if cnt >= payload.perSoulCap:
                need = cnt - payload.perSoulCap + 1
            else:
                need = 0
        if need <= 0:
            vacancies[soul] = 0
            continue
        # find evictable skip>threshold
        evict_rows = conn.execute("""
            SELECT sp.event_id, s.skip, s.birth_ts FROM short_pool sp
            JOIN event_soul_state s ON s.event_id=sp.event_id AND s.soul=sp.soul
            WHERE sp.chat_id=? AND sp.soul=? AND s.skip > ?
            ORDER BY s.skip DESC, s.birth_ts ASC
        """, (payload.chat_id, soul, payload.skipThreshold)).fetchall()
        to_free = []
        for r in evict_rows:
            if len(to_free) >= need:
                break
            to_free.append(r["event_id"])
        # if still need more, median eviction
        if len(to_free) < need:
            remaining = need - len(to_free)
            # get all pool events sorted by birth_ts
            all_rows = conn.execute("""
                SELECT sp.event_id, s.birth_ts FROM short_pool sp
                JOIN event_soul_state s ON s.event_id=sp.event_id AND s.soul=sp.soul
                WHERE sp.chat_id=? AND sp.soul=?
                ORDER BY s.birth_ts ASC
            """, (payload.chat_id, soul)).fetchall()
            # exclude already to_free
            candidates = [r for r in all_rows if r["event_id"] not in to_free]
            if candidates:
                # median: middle index
                for i in range(remaining):
                    if not candidates:
                        break
                    mid = len(candidates)//2
                    median_id = candidates.pop(mid)["event_id"]
                    to_free.append(median_id)
        # actually delete from pool (move to long pool = just remove from short_pool, keep state)
        for eid in to_free:
            conn.execute("DELETE FROM short_pool WHERE chat_id=? AND soul=? AND event_id=?", (payload.chat_id, soul, eid))
            freed.append({"soul": soul, "event_id": eid})
        vacancies[soul] = len(to_free)
    conn.commit()
    conn.close()
    return {"freed": freed, "vacancies": vacancies, "count": len(freed)}

@app.post("/api/short_pool/fill")
def api_fill_short_pool(payload: ShortPoolFill):
    conn = get_db()
    added = []
    now = time.time()*1000
    for it in payload.items:
        eid = it.get("event_id") or it.get("id")
        soul = it.get("soul")
        if not eid or not soul:
            continue
        # ensure state exists, if not create with counter from events
        row = conn.execute("SELECT * FROM event_soul_state WHERE event_id=? AND soul=?", (eid, soul)).fetchone()
        if not row:
            ev = conn.execute("SELECT * FROM events WHERE id=?", (eid,)).fetchone()
            if not ev:
                continue
            c = ev["counter"] if "counter" in ev.keys() and ev["counter"] is not None else 2
            conn.execute("INSERT INTO event_soul_state(event_id,chat_id,soul,counter,skip,stuck,birth_ts,last_eval) VALUES (?,?,?,?,?,?,?,?)",
                (eid, payload.chat_id, soul, c, 0, 0, now, now))
        # update last_active
        conn.execute("UPDATE events SET last_active_at=? WHERE id=?", (now, eid))
        bucket = get_bucket(now)
        conn.execute("UPDATE events SET time_bucket=? WHERE id=?", (bucket, eid))
        conn.execute("UPDATE event_soul_state SET last_eval=? WHERE event_id=? AND soul=?", (now, eid, soul))
        conn.execute("INSERT OR IGNORE INTO short_pool(chat_id,soul,event_id) VALUES (?,?,?)", (payload.chat_id, soul, eid))
        added.append({"event_id": eid, "soul": soul})
    conn.commit()
    conn.close()
    # 硬限兜底：填充后若仍超 cap，立即按 cap 截断（防前端 vacancies 计算偏差导致膨胀）
    try:
        cap = int(payload.perSoulCap) if payload.perSoulCap is not None else 15
        cap = max(1, min(50, cap))
        _enforce_cap(payload.chat_id, cap)
    except Exception as e:
        print(f"[fill enforce] {e}")
    return {"added": added, "count": len(added)}

@app.get("/api/short_pool/check_sublimation")
def api_check_sublimation(chat_id: str, stuckThreshold: int = 8):
    conn = get_db()
    rows = conn.execute("""
        SELECT s.*, e.event_text, e.chat_id as e_chat FROM event_soul_state s
        JOIN events e ON e.id=s.event_id
        JOIN short_pool sp ON sp.chat_id=s.chat_id AND sp.soul=s.soul AND sp.event_id=s.event_id
        WHERE s.chat_id=? AND s.stuck >= ? AND s.counter IN (0,3)
    """, (chat_id, stuckThreshold)).fetchall()
    conn.close()
    out = []
    for r in rows:
        out.append({
            "event_id": r["event_id"],
            "chat_id": r["chat_id"],
            "soul": r["soul"],
            "counter": r["counter"],
            "stuck": r["stuck"],
            "skip": r["skip"],
            "birth_ts": r["birth_ts"],
            "event_text": r["event_text"],
        })
    return {"candidates": out, "count": len(out)}

@app.post("/api/short_pool/mark_sublimated")
def api_mark_sublimated(payload: Dict[str, Any]):
    # payload {chat_id, soul, event_id}
    chat_id = payload.get("chat_id")
    soul = payload.get("soul")
    eid = payload.get("event_id")
    if not chat_id or not soul or not eid:
        raise HTTPException(400, "missing fields")
    conn = get_db()
    # remove from short_pool, reset stuck, keep in long pool
    conn.execute("DELETE FROM short_pool WHERE chat_id=? AND soul=? AND event_id=?", (chat_id, soul, eid))
    conn.execute("UPDATE event_soul_state SET stuck=0 WHERE event_id=? AND soul=?", (eid, soul))
    conn.commit()
    conn.close()
    return {"ok": True}

# --------------------------------------------------------------------------- #
# 代理转发区：LLM / Embedding / Rerank 统统走后端，根治 CORS
# --------------------------------------------------------------------------- #
@app.post("/api/llm_proxy")
async def llm_proxy(payload: LLMProxy):
    import httpx
    import logging
    logger = logging.getLogger("ArcEXtreme.llm_proxy")
    target = payload.url.strip()
    if not target.startswith(("http://", "https://")):
        raise HTTPException(400, "仅支持 http/https")
    base = target.rstrip("/")
    if not base.endswith("/chat/completions"):
        base = base + "/chat/completions"
    try:
        if _is_private_url(base):
            logger.warning(f"[llm_proxy] forwarding to private address: {base}")
    except: pass
    headers = {"Content-Type": "application/json"}
    if payload.api_key:
        headers["Authorization"] = f"Bearer {payload.api_key}"
    timeout = payload.timeout or 90
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=payload.verify_ssl) as client:
            r = await client.post(base, json=payload.payload, headers=headers)
            try:
                data = r.json()
            except Exception:
                data = {"raw": r.text}
            return JSONResponse(content=data, status_code=r.status_code)
    except Exception as e:
        logger.error(f"[llm_proxy] forward failed: {e}")
        raise HTTPException(502, f"LLM 代理转发失败: {e}")

@app.post("/api/embedding_proxy")
async def embedding_proxy(payload: EmbeddingProxy):
    import httpx
    import logging
    logger = logging.getLogger("ArcEXtreme.embedding_proxy")
    target = payload.url.strip()
    if not target.startswith(("http://", "https://")):
        raise HTTPException(400, "仅支持 http/https")
    base = target.rstrip("/")
    if payload.source == "ollama":
        if not base.endswith("/api/embeddings"):
            if base.endswith("/api"):
                base = base + "/embeddings"
            elif "/api/" not in base:
                base = base + "/api/embeddings"
    else:
        if not base.endswith("/embeddings"):
            base = base + "/embeddings"
    headers = {"Content-Type": "application/json"}
    if payload.api_key:
        headers["Authorization"] = f"Bearer {payload.api_key}"
    timeout = payload.timeout or 30
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=payload.verify_ssl) as client:
            r = await client.post(base, json=payload.payload, headers=headers)
            try:
                data = r.json()
            except Exception:
                data = {"raw": r.text}
            return JSONResponse(content=data, status_code=r.status_code)
    except Exception as e:
        logger.error(f"[embedding_proxy] forward failed: {e}")
        raise HTTPException(502, f"Embedding 代理转发失败: {e}")

@app.post("/api/rerank_proxy")
async def rerank_proxy(payload: RerankProxy):
    import httpx
    import logging
    logger = logging.getLogger("ArcEXtreme.rerank_proxy")
    url = payload.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "仅支持 http/https")
    try:
        if _is_private_url(url):
            logger.warning(f"[rerank_proxy] forwarding to private address: {url}")
    except: pass
    headers = {"Content-Type": "application/json"}
    if payload.api_key:
        headers["Authorization"] = f"Bearer {payload.api_key}"
    try:
        async with httpx.AsyncClient(timeout=40, verify=False) as client:
            r = await client.post(url, json=payload.payload, headers=headers)
            try:
                data = r.json()
            except Exception:
                data = {"raw": r.text}
            return JSONResponse(content=data, status_code=r.status_code)
    except Exception as e:
        logger.error(f"[rerank_proxy] forward failed: {e}")
        raise HTTPException(502, f"Rerank 代理转发失败: {e}")

@app.get("/api/status")
def status():
    conn = get_db()
    try:
        sp_cnt = conn.execute("SELECT COUNT(*) as c FROM short_pool").fetchone()["c"]
    except: sp_cnt = 0
    try:
        sub_cnt = conn.execute("SELECT COUNT(*) as c FROM sublimated").fetchone()["c"]
    except: sub_cnt = 0
    conn.close()
    return {
        "ok": True,
        "faiss_count": faiss_index.ntotal if faiss_index else 0,
        "buckets": list(BUCKETS.keys()),
        "short_pool_count": sp_cnt,
        "sublimated_count": sub_cnt,
    }

@app.on_event("startup")
def startup():
    init_db()
    load_index()

if __name__ == "__main__":
    import sys
    import uvicorn
    use_colors = os.environ.get("ARCEXTREME_COLOR", "0") == "1"
    if use_colors and sys.stdout.isatty():
        use_colors = True
    else:
        use_colors = False
    uvicorn.run(
        app,
        host=os.environ.get("ARCEXTREME_HOST", "0.0.0.0"),
        port=int(os.environ.get("ARCEXTREME_PORT", "9001")),
        log_level=os.environ.get("ARCEXTREME_LOG_LEVEL", "info"),
        access_log=True,
        use_colors=use_colors,
    )
