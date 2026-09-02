import os
import time
import sqlite3
import ipaddress
import urllib.parse
import threading
import json as _json
import base64
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
SOULS_ENABLED_PATH = os.path.join(SOULS_DIR, ".souls_enabled.json")
migrate_lock = threading.Lock()

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
        try:
            v = blob_to_vector(r["vector"])
            if not v or not isinstance(v, list) or len(v)==0:
                continue
            vecs.append(v)
            faiss_ids.append(r["id"])
        except: pass
    if not vecs:
        return
    # handle mixed dims: group by dim, pick majority
    from collections import Counter
    dims = Counter(len(v) for v in vecs)
    dim_major, _ = dims.most_common(1)[0]
    if len(dims) > 1:
        print(f"[load_index] mixed dims detected {dict(dims)}, using majority {dim_major}, skipping {len(vecs)-dims[dim_major]} vectors")
        filtered = []
        fids = []
        for v, fid in zip(vecs, faiss_ids):
            if len(v)==dim_major:
                filtered.append(v)
                fids.append(fid)
        vecs, faiss_ids = filtered, fids
        if not vecs:
            return
    dim = len(vecs[0])
    try:
        ensure_index(dim)
    except Exception as e:
        print(f"[load_index] ensure_index failed dim {dim}: {e}")
        return
    try:
        arr = np.asarray(vecs, dtype=np.float32)
        faiss_index.add(arr)
    except Exception as e:
        print(f"[load_index] add failed: {e}")

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

def _load_enabled_map():
    try:
        if os.path.isfile(SOULS_ENABLED_PATH):
            with open(SOULS_ENABLED_PATH, "r", encoding="utf-8") as f:
                data = _json.load(f)
                if isinstance(data, dict):
                    return {str(k): bool(v) for k, v in data.items()}
    except Exception as e:
        print(f"[souls_enabled] load failed: {e}")
    return {}

def _save_enabled_map(m):
    try:
        with soul_lock:
            tmp = SOULS_ENABLED_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                _json.dump(m, f, ensure_ascii=False, indent=2)
            os.replace(tmp, SOULS_ENABLED_PATH)
    except Exception as e:
        print(f"[souls_enabled] save failed: {e}")
        raise

@app.get("/api/souls")
def list_souls():
    enabled_map = _load_enabled_map()
    items = []
    for fn in sorted(os.listdir(SOULS_DIR)):
        if fn.startswith("."):
            continue
        if fn.lower().endswith(SOUL_EXTS):
            full = os.path.join(SOULS_DIR, fn)
            try:
                size = os.path.getsize(full)
                mtime = os.path.getmtime(full)
            except OSError:
                size = 0
                mtime = 0
            name = os.path.splitext(fn)[0]
            enabled = enabled_map.get(name, True) if enabled_map else True
            # if map empty, all enabled; otherwise missing key defaults to True
            if name not in enabled_map and enabled_map:
                enabled = True
            items.append({
                "name": name,
                "filename": fn,
                "format": os.path.splitext(fn)[1].lstrip("."),
                "size_bytes": size,
                "modified_at": mtime,
                "enabled": enabled,
            })
    return {"souls": items, "enabled_map": enabled_map}

@app.get("/api/souls/enabled")
def get_souls_enabled():
    return {"enabled": _load_enabled_map()}

@app.post("/api/souls/enabled")
def set_souls_enabled(payload: Dict[str, Any]):
    # payload {enabled: {name: bool}} or direct map
    m = None
    if isinstance(payload.get("enabled"), dict):
        m = payload["enabled"]
    elif isinstance(payload, dict) and all(isinstance(v, bool) for v in payload.values()):
        m = payload
    else:
        # try to find any dict
        for v in payload.values():
            if isinstance(v, dict):
                m = v
                break
    if m is None:
        raise HTTPException(400, "missing enabled map")
    # normalize and validate names exist (allow any, but clean)
    norm = {}
    for k, v in m.items():
        nk = str(k).strip()
        if not nk:
            continue
        norm[nk] = bool(v)
    _save_enabled_map(norm)
    return {"ok": True, "enabled": norm}

@app.get("/api/souls/{filename}")
def read_soul(filename: str):
    full = safe_soul_path(filename)
    if not os.path.isfile(full):
        raise HTTPException(404, "souls 文件不存在")
    with open(full, "r", encoding="utf-8", errors="replace") as f:
        return PlainTextResponse(f.read())

@app.post("/api/souls/append")
def append_soul(payload: SoulAppend):
    # 解析文件名并做 .txt→.json 自动迁移兼容
    requested = safe_soul_path(payload.filename)
    # 若请求的是 .txt 但同名 .json 已存在（纯JSON迁移后），自动落到 .json
    full = requested
    try:
        base_name = os.path.basename(requested)
        if base_name.lower().endswith('.txt'):
            alt = base_name[:-4] + '.json'
            alt_full = os.path.join(SOULS_DIR, alt)
            if os.path.isfile(alt_full):
                full = alt_full
            elif os.path.isfile(requested):
                full = requested
            else:
                # 两者都不存在，优先落 .json
                full = alt_full
        elif base_name.lower().endswith('.json'):
            full = requested
    except:
        full = requested
    # ensure file exists
    if not os.path.isfile(full):
        # create if not exists
        open(full, "a", encoding="utf-8").close()
    # JSON 优先：若是 .json 且内容为合法 JSON，则以纯 JSON 追加 sublimated 数组
    is_json = str(full).lower().endswith('.json')
    if is_json:
        try:
            with open(full, "r", encoding="utf-8") as f:
                raw = f.read().strip()
                data = _json.loads(raw) if raw else {}
            if not isinstance(data, dict):
                data = {"character": data}
            if "sublimated" not in data or not isinstance(data["sublimated"], list):
                data["sublimated"] = []
            # 去重：同 title+content 已存在则跳过
            exists = any((x.get("title")==payload.title and x.get("content")==payload.content) for x in data["sublimated"])
            if not exists:
                entry = {
                    "title": payload.title or "",
                    "content": payload.content or "",
                    "counter": payload.counter,
                    "event_id": payload.event_id,
                    "soul": payload.soul,
                    "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
                    "ts": time.time()*1000,
                }
                data["sublimated"].append(entry)
                # 写回
                with soul_lock:
                    with open(full, "w", encoding="utf-8") as f:
                        _json.dump(data, f, ensure_ascii=False, indent=2)
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
                    return {"ok": True, "path": full, "mode": "json"}
            else:
                return {"ok": True, "path": full, "mode": "json", "note": "duplicate skipped"}
        except Exception as e:
            # JSON 解析失败则回退到旧的 marker 追加
            print(f"[append_soul] json append failed, fallback to text: {e}")
            pass
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
# Chats — 枚举、统计、迁移、备份
# --------------------------------------------------------------------------- #
def _list_all_chat_ids(conn):
    chat_ids = set()
    for tbl, col in [("events","chat_id"), ("event_soul_state","chat_id"), ("short_pool","chat_id"), ("sublimated","chat_id")]:
        try:
            rows = conn.execute(f"SELECT DISTINCT {col} FROM {tbl} WHERE {col} IS NOT NULL").fetchall()
            for r in rows:
                v = r[col]
                if v and str(v).strip():
                    chat_ids.add(str(v))
        except Exception:
            pass
    return chat_ids

@app.get("/api/chats")
def list_chats():
    conn = get_db()
    chat_ids = _list_all_chat_ids(conn)
    out = []
    for cid in sorted(chat_ids):
        try:
            ev_cnt = conn.execute("SELECT COUNT(*) as c FROM events WHERE chat_id=?", (cid,)).fetchone()["c"]
        except: ev_cnt = 0
        try:
            pool_cnt = conn.execute("SELECT COUNT(*) as c FROM short_pool WHERE chat_id=?", (cid,)).fetchone()["c"]
        except: pool_cnt = 0
        try:
            sub_cnt = conn.execute("SELECT COUNT(*) as c FROM sublimated WHERE chat_id=?", (cid,)).fetchone()["c"]
        except: sub_cnt = 0
        try:
            state_cnt = conn.execute("SELECT COUNT(*) as c FROM event_soul_state WHERE chat_id=?", (cid,)).fetchone()["c"]
        except: state_cnt = 0
        try:
            row = conn.execute("SELECT MIN(timestamp) as mn, MAX(timestamp) as mx FROM events WHERE chat_id=?", (cid,)).fetchone()
            mn = row["mn"] if row else None
            mx = row["mx"] if row else None
        except: mn, mx = None, None
        try:
            souls_rows = conn.execute("SELECT DISTINCT soul FROM event_soul_state WHERE chat_id=?", (cid,)).fetchall()
            souls = [r["soul"] for r in souls_rows if r["soul"]]
        except: souls = []
        out.append({
            "chat_id": cid,
            "events": ev_cnt,
            "state": state_cnt,
            "short_pool": pool_cnt,
            "sublimated": sub_cnt,
            "souls": souls,
            "min_ts": mn,
            "max_ts": mx,
        })
    conn.close()
    out.sort(key=lambda x: (x["max_ts"] or 0), reverse=True)
    return {"chats": out, "count": len(out)}

@app.get("/api/chats/{chat_id}/stats")
def chat_stats(chat_id: str):
    conn = get_db()
    try:
        ev_cnt = conn.execute("SELECT COUNT(*) as c FROM events WHERE chat_id=?", (chat_id,)).fetchone()["c"]
    except: ev_cnt = 0
    try:
        pool_cnt = conn.execute("SELECT COUNT(*) as c FROM short_pool WHERE chat_id=?", (chat_id,)).fetchone()["c"]
    except: pool_cnt = 0
    try:
        sub_cnt = conn.execute("SELECT COUNT(*) as c FROM sublimated WHERE chat_id=?", (chat_id,)).fetchone()["c"]
    except: sub_cnt = 0
    try:
        state_cnt = conn.execute("SELECT COUNT(*) as c FROM event_soul_state WHERE chat_id=?", (chat_id,)).fetchone()["c"]
    except: state_cnt = 0
    try:
        rows = conn.execute("SELECT time_bucket, COUNT(*) as c FROM events WHERE chat_id=? GROUP BY time_bucket", (chat_id,)).fetchall()
        buckets = {r["time_bucket"]: r["c"] for r in rows}
    except: buckets = {}
    try:
        rows2 = conn.execute("SELECT soul, COUNT(*) as c FROM event_soul_state WHERE chat_id=? GROUP BY soul", (chat_id,)).fetchall()
        per_soul = {r["soul"]: r["c"] for r in rows2}
    except: per_soul = {}
    try:
        latest = conn.execute("SELECT event_text, timestamp, souls FROM events WHERE chat_id=? ORDER BY timestamp DESC LIMIT 5", (chat_id,)).fetchall()
        latest = [dict(r) for r in latest]
    except: latest = []
    conn.close()
    return {"chat_id": chat_id, "events": ev_cnt, "state": state_cnt, "short_pool": pool_cnt, "sublimated": sub_cnt, "buckets": buckets, "per_soul": per_soul, "latest": latest}

class ChatMigratePayload(BaseModel):
    source_chat_id: str
    target_chat_id: str
    mode: str = "copy"  # copy | move | merge (merge == copy append)
    overwrite: bool = False
    include_events: bool = True
    include_state: bool = True
    include_pool: bool = True
    include_sublimated: bool = True

@app.post("/api/chats/migrate")
def migrate_chat(payload: ChatMigratePayload):
    global faiss_index, faiss_dim, faiss_ids
    src = str(payload.source_chat_id or "").strip()
    dst = str(payload.target_chat_id or "").strip()
    if not src or not dst:
        raise HTTPException(400, "source_chat_id 与 target_chat_id 均必填")
    if src == dst:
        raise HTTPException(400, "源与目标不能相同")
    mode = str(payload.mode or "copy").lower()
    if mode not in ("copy","move","merge"):
        mode = "copy"
    # merge is alias of copy append
    with migrate_lock:
        conn = get_db()
        # verify source exists
        src_exists = False
        try:
            for tbl in ["events","event_soul_state","short_pool","sublimated"]:
                cnt = conn.execute(f"SELECT COUNT(*) as c FROM {tbl} WHERE chat_id=?", (src,)).fetchone()["c"]
                if cnt and cnt>0:
                    src_exists = True
                    break
        except Exception as e:
            conn.close()
            raise HTTPException(500, f"源检测失败: {e}")
        if not src_exists:
            conn.close()
            raise HTTPException(404, f"源 chat_id 无数据: {src}")
        # if overwrite and dst exists, clear dst first
        if payload.overwrite:
            try:
                conn.execute("DELETE FROM short_pool WHERE chat_id=?", (dst,))
                conn.execute("DELETE FROM event_soul_state WHERE chat_id=?", (dst,))
                conn.execute("DELETE FROM sublimated WHERE chat_id=?", (dst,))
                conn.execute("DELETE FROM events WHERE chat_id=?", (dst,))
                conn.commit()
            except Exception as e:
                conn.rollback()
                conn.close()
                raise HTTPException(500, f"覆盖清空失败: {e}")
        # counters
        stats = {"events":0, "state":0, "pool":0, "sublimated":0, "faiss_added":0}
        id_map = {}  # old_event_id -> new_event_id
        try:
            # ---- events ----
            if payload.include_events:
                old_events = conn.execute("SELECT * FROM events WHERE chat_id=? ORDER BY id", (src,)).fetchall()
                for r in old_events:
                    d = dict(r)
                    old_id = d["id"]
                    # build insert; keep vector blob verbatim
                    cols = ["chat_id","timestamp","time_bucket","role1","role2","souls","event_text","vector","metadata","created_at","last_active_at","counter"]
                    vals = []
                    for c in cols:
                        if c == "chat_id":
                            vals.append(dst)
                        else:
                            vals.append(d.get(c))
                    placeholders = ",".join(["?"]*len(cols))
                    cur = conn.execute(f"INSERT INTO events ({','.join(cols)}) VALUES ({placeholders})", tuple(vals))
                    new_id = cur.lastrowid
                    id_map[old_id] = new_id
                    stats["events"] += 1
                conn.commit()
                # add to faiss after commit
                if id_map:
                    try:
                        # batch add vectors for new ids
                        vec_rows = conn.execute(f"SELECT id, vector FROM events WHERE chat_id=? AND vector IS NOT NULL", (dst,)).fetchall()
                        # but we only want newly inserted; use id_map values
                        new_ids_set = set(id_map.values())
                        vecs = []
                        ids_added = []
                        for vr in vec_rows:
                            if vr["id"] in new_ids_set and vr["vector"] is not None:
                                try:
                                    v = blob_to_vector(vr["vector"])
                                    if v and len(v)>0:
                                        vecs.append(v)
                                        ids_added.append(vr["id"])
                                except: pass
                        if vecs:
                            # ensure dim matches or init
                            dim = len(vecs[0])
                            try:
                                ensure_index(dim)
                            except Exception as e:
                                print(f"[migrate] ensure_index dim {dim} failed: {e}")
                            # add directly
                            if faiss_index is not None:
                                try:
                                    arr = np.asarray(vecs, dtype=np.float32)
                                    faiss_index.add(arr)
                                    faiss_ids.extend(ids_added)
                                    stats["faiss_added"] = len(ids_added)
                                except Exception as e:
                                    print(f"[migrate] faiss add failed: {e}")
                                    # fallback reload
                                    try:
                                        load_index()
                                    except: pass
                    except Exception as e:
                        print(f"[migrate] faiss batch failed: {e}")
            # ---- event_soul_state ----
            if payload.include_state:
                # if we copied events, map old->new; else keep old ids but change chat_id (for pool-only migrate)
                if id_map:
                    old_states = conn.execute("SELECT * FROM event_soul_state WHERE chat_id=?", (src,)).fetchall()
                    for rs in old_states:
                        ds = dict(rs)
                        old_eid = ds["event_id"]
                        new_eid = id_map.get(old_eid)
                        if new_eid is None:
                            # event not copied? skip or still copy with old id? we skip
                            continue
                        # insert copy with dst chat_id and new event_id
                        conn.execute("INSERT OR REPLACE INTO event_soul_state(event_id,chat_id,soul,counter,skip,stuck,birth_ts,last_eval,why_init,why_log) VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (new_eid, dst, ds["soul"], ds["counter"], ds["skip"], ds["stuck"], ds["birth_ts"], ds["last_eval"], ds.get("why_init"), ds.get("why_log")))
                        stats["state"] += 1
                else:
                    # no event copy, duplicating state referencing existing events? then just copy rows changing chat_id keeping same event_id
                    old_states = conn.execute("SELECT * FROM event_soul_state WHERE chat_id=?", (src,)).fetchall()
                    for rs in old_states:
                        ds = dict(rs)
                        conn.execute("INSERT OR REPLACE INTO event_soul_state(event_id,chat_id,soul,counter,skip,stuck,birth_ts,last_eval,why_init,why_log) VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (ds["event_id"], dst, ds["soul"], ds["counter"], ds["skip"], ds["stuck"], ds["birth_ts"], ds["last_eval"], ds.get("why_init"), ds.get("why_log")))
                        stats["state"] += 1
                conn.commit()
            # ---- short_pool ----
            if payload.include_pool:
                if id_map:
                    old_pools = conn.execute("SELECT * FROM short_pool WHERE chat_id=?", (src,)).fetchall()
                    for rp in old_pools:
                        dp = dict(rp)
                        old_eid = dp["event_id"]
                        new_eid = id_map.get(old_eid)
                        if new_eid is None:
                            continue
                        conn.execute("INSERT OR IGNORE INTO short_pool(chat_id,soul,event_id) VALUES (?,?,?)", (dst, dp["soul"], new_eid))
                        stats["pool"] += 1
                else:
                    old_pools = conn.execute("SELECT * FROM short_pool WHERE chat_id=?", (src,)).fetchall()
                    for rp in old_pools:
                        dp = dict(rp)
                        conn.execute("INSERT OR IGNORE INTO short_pool(chat_id,soul,event_id) VALUES (?,?,?)", (dst, dp["soul"], dp["event_id"]))
                        stats["pool"] += 1
                conn.commit()
                # enforce cap for dst
                try:
                    # use default 15 or max existing? just 15
                    _enforce_cap(dst, 15)
                except: pass
            # ---- sublimated ----
            if payload.include_sublimated:
                old_subs = conn.execute("SELECT * FROM sublimated WHERE chat_id=?", (src,)).fetchall()
                for rs in old_subs:
                    ds = dict(rs)
                    # map event_id if possible
                    old_eid = ds.get("event_id")
                    new_eid = id_map.get(old_eid) if old_eid else None
                    conn.execute("INSERT INTO sublimated(chat_id,soul,event_id,counter,title,content,created_at) VALUES (?,?,?,?,?,?,?)",
                        (dst, ds["soul"], new_eid if new_eid is not None else old_eid, ds["counter"], ds["title"], ds["content"], ds["created_at"]))
                    stats["sublimated"] += 1
                conn.commit()
            # ---- move mode: delete source ----
            if mode == "move":
                conn.execute("DELETE FROM short_pool WHERE chat_id=?", (src,))
                conn.execute("DELETE FROM event_soul_state WHERE chat_id=?", (src,))
                conn.execute("DELETE FROM sublimated WHERE chat_id=?", (src,))
                conn.execute("DELETE FROM events WHERE chat_id=?", (src,))
                conn.commit()
                # FAISS rebuild needed after delete to remove stale vectors
                try:
                    faiss_index = None
                    faiss_dim = None
                    faiss_ids = []
                    load_index()
                except Exception as e:
                    print(f"[migrate move] reload faiss failed: {e}")
            conn.close()
        except HTTPException:
            raise
        except Exception as e:
            try: conn.rollback(); conn.close()
            except: pass
            # attempt faiss reload on error
            try:
                faiss_index = None
                faiss_dim = None
                faiss_ids = []
                load_index()
            except: pass
            raise HTTPException(500, f"迁移失败: {e}")
        return {"ok": True, "mode": mode, "source": src, "target": dst, "stats": stats, "id_map_size": len(id_map)}

@app.post("/api/chats/rename")
def rename_chat(payload: Dict[str, Any]):
    src = str(payload.get("source_chat_id") or payload.get("source") or payload.get("from") or "").strip()
    dst = str(payload.get("target_chat_id") or payload.get("target") or payload.get("to") or "").strip()
    if not src or not dst:
        raise HTTPException(400, "source 与 target 必填")
    if src == dst:
        raise HTTPException(400, "源与目标相同")
    with migrate_lock:
        conn = get_db()
        cnt = conn.execute("SELECT COUNT(*) as c FROM events WHERE chat_id=?", (src,)).fetchone()["c"]
        if not cnt:
            # also check other tables
            cnt2 = conn.execute("SELECT COUNT(*) as c FROM sublimated WHERE chat_id=?", (src,)).fetchone()["c"]
            if not cnt2:
                conn.close()
                raise HTTPException(404, "源无数据")
        # if target exists and not allowed, error
        tc = conn.execute("SELECT COUNT(*) as c FROM events WHERE chat_id=?", (dst,)).fetchone()["c"]
        if tc and tc>0:
            conn.close()
            raise HTTPException(409, "目标已存在，请用 migrate+overwrite 或先清理")
        try:
            conn.execute("UPDATE events SET chat_id=? WHERE chat_id=?", (dst, src))
            conn.execute("UPDATE event_soul_state SET chat_id=? WHERE chat_id=?", (dst, src))
            conn.execute("UPDATE short_pool SET chat_id=? WHERE chat_id=?", (dst, src))
            conn.execute("UPDATE sublimated SET chat_id=? WHERE chat_id=?", (dst, src))
            conn.commit()
            conn.close()
            # FAISS ids don't change, but chat_id filter will, so no rebuild needed; but reload to be safe
            try:
                global faiss_index, faiss_ids, faiss_dim
                # we keep index, just ids unchanged
                pass
            except: pass
            return {"ok": True, "from": src, "to": dst}
        except Exception as e:
            try: conn.rollback(); conn.close()
            except: pass
            raise HTTPException(500, f"重命名失败: {e}")

@app.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str):
    global faiss_index, faiss_dim, faiss_ids
    with migrate_lock:
        conn = get_db()
        conn.execute("DELETE FROM short_pool WHERE chat_id=?", (chat_id,))
        conn.execute("DELETE FROM event_soul_state WHERE chat_id=?", (chat_id,))
        conn.execute("DELETE FROM sublimated WHERE chat_id=?", (chat_id,))
        conn.execute("DELETE FROM events WHERE chat_id=?", (chat_id,))
        conn.commit()
        conn.close()
        # rebuild FAISS
        try:
            faiss_index = None
            faiss_dim = None
            faiss_ids = []
            load_index()
        except Exception as e:
            print(f"[delete_chat] faiss reload failed: {e}")
        return {"ok": True, "deleted": chat_id}

@app.get("/api/export")
def export_chat(chat_id: str):
    conn = get_db()
    events = [dict(r) for r in conn.execute("SELECT * FROM events WHERE chat_id=? ORDER BY id", (chat_id,)).fetchall()]
    states = [dict(r) for r in conn.execute("SELECT * FROM event_soul_state WHERE chat_id=?", (chat_id,)).fetchall()]
    pools = [dict(r) for r in conn.execute("SELECT * FROM short_pool WHERE chat_id=?", (chat_id,)).fetchall()]
    subs = [dict(r) for r in conn.execute("SELECT * FROM sublimated WHERE chat_id=?", (chat_id,)).fetchall()]
    conn.close()
    # encode vectors as list for portability; also keep base64
    for ev in events:
        blob = ev.get("vector")
        if blob is not None:
            try:
                v = blob_to_vector(blob)
                ev["vector"] = v
                ev["vector_b64"] = base64.b64encode(blob).decode("ascii")
            except:
                ev["vector"] = None
                ev["vector_b64"] = None
        # remove blob bytes
        if isinstance(ev.get("vector"), bytes):
            ev["vector"] = None
    return {"chat_id": chat_id, "exported_at": time.time()*1000, "counts": {"events": len(events), "state": len(states), "pool": len(pools), "sublimated": len(subs)}, "events": events, "states": states, "pools": pools, "sublimated": subs}

@app.post("/api/import")
def import_chat(payload: Dict[str, Any]):
    global faiss_index, faiss_dim, faiss_ids
    chat_id = str(payload.get("chat_id") or payload.get("target_chat_id") or "").strip()
    if not chat_id:
        raise HTTPException(400, "chat_id 必填")
    overwrite = bool(payload.get("overwrite"))
    events = payload.get("events") or []
    states = payload.get("states") or []
    pools = payload.get("pools") or []
    subs = payload.get("sublimated") or payload.get("sub") or []
    with migrate_lock:
        conn = get_db()
        if overwrite:
            conn.execute("DELETE FROM short_pool WHERE chat_id=?", (chat_id,))
            conn.execute("DELETE FROM event_soul_state WHERE chat_id=?", (chat_id,))
            conn.execute("DELETE FROM sublimated WHERE chat_id=?", (chat_id,))
            conn.execute("DELETE FROM events WHERE chat_id=?", (chat_id,))
            conn.commit()
        id_map = {}
        stats = {"events":0, "state":0, "pool":0, "sublimated":0}
        try:
            for ev in events:
                # vector may be list or b64
                vec = ev.get("vector")
                if vec is None and ev.get("vector_b64"):
                    try:
                        blob = base64.b64decode(ev["vector_b64"])
                        vec = blob_to_vector(blob)
                    except: vec = None
                if isinstance(vec, list) and len(vec)>0:
                    blob = vector_to_blob(vec)
                else:
                    blob = ev.get("vector")
                    if isinstance(blob, list):
                        blob = vector_to_blob(blob)
                    elif isinstance(blob, str):
                        try: blob = base64.b64decode(blob)
                        except: blob = None
                    elif not isinstance(blob, (bytes, bytearray)):
                        blob = None
                # insert
                old_id = ev.get("id")
                cols = ["chat_id","timestamp","time_bucket","role1","role2","souls","event_text","vector","metadata","created_at","last_active_at","counter"]
                vals = [chat_id, ev.get("timestamp"), ev.get("time_bucket") or get_bucket(ev.get("timestamp") or time.time()*1000), ev.get("role1"), ev.get("role2"), ev.get("souls"), ev.get("event_text"), blob, _json.dumps(ev.get("metadata") or {}), ev.get("created_at") or ev.get("timestamp"), ev.get("last_active_at") or ev.get("timestamp"), ev.get("counter")]
                cur = conn.execute(f"INSERT INTO events ({','.join(cols)}) VALUES ({','.join(['?']*len(cols))})", tuple(vals))
                new_id = cur.lastrowid
                if old_id is not None:
                    id_map[int(old_id)] = new_id
                stats["events"] += 1
            conn.commit()
            # FAISS add
            if stats["events"]:
                try:
                    new_ids = list(id_map.values()) if id_map else []
                    if new_ids:
                        vec_rows = conn.execute("SELECT id, vector FROM events WHERE chat_id=?", (chat_id,)).fetchall()
                        vecs = []
                        ids_added = []
                        for vr in vec_rows:
                            if vr["vector"] is not None and (not new_ids or vr["id"] in new_ids):
                                try:
                                    v = blob_to_vector(vr["vector"])
                                    if v and len(v)>0:
                                        vecs.append(v)
                                        ids_added.append(vr["id"])
                                except: pass
                        if vecs:
                            dim = len(vecs[0])
                            ensure_index(dim)
                            if faiss_index is not None:
                                arr = np.asarray(vecs, dtype=np.float32)
                                faiss_index.add(arr)
                                faiss_ids.extend(ids_added)
                except Exception as e:
                    print(f"[import] faiss add failed: {e}")
            for st in states:
                old_eid = st.get("event_id")
                new_eid = id_map.get(int(old_eid)) if old_eid is not None and int(old_eid) in id_map else old_eid
                try:
                    conn.execute("INSERT OR REPLACE INTO event_soul_state(event_id,chat_id,soul,counter,skip,stuck,birth_ts,last_eval,why_init,why_log) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (new_eid, chat_id, st.get("soul"), st.get("counter",2), st.get("skip",0), st.get("stuck",0), st.get("birth_ts") or time.time()*1000, st.get("last_eval") or time.time()*1000, st.get("why_init"), st.get("why_log") or '[]'))
                    stats["state"] += 1
                except Exception as e:
                    print(f"[import] state insert failed: {e}")
            for p in pools:
                old_eid = p.get("event_id")
                new_eid = id_map.get(int(old_eid)) if old_eid is not None and int(old_eid) in id_map else old_eid
                try:
                    conn.execute("INSERT OR IGNORE INTO short_pool(chat_id,soul,event_id) VALUES (?,?,?)", (chat_id, p.get("soul"), new_eid))
                    stats["pool"] += 1
                except: pass
            for s in subs:
                old_eid = s.get("event_id")
                new_eid = id_map.get(int(old_eid)) if old_eid is not None and int(old_eid) in id_map else old_eid
                try:
                    conn.execute("INSERT INTO sublimated(chat_id,soul,event_id,counter,title,content,created_at) VALUES (?,?,?,?,?,?,?)",
                        (chat_id, s.get("soul"), new_eid, s.get("counter"), s.get("title"), s.get("content"), s.get("created_at") or time.time()*1000))
                    stats["sublimated"] += 1
                except: pass
            conn.commit()
            conn.close()
            return {"ok": True, "chat_id": chat_id, "stats": stats}
        except Exception as e:
            try: conn.rollback(); conn.close()
            except: pass
            raise HTTPException(500, f"导入失败: {e}")

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
        why = (ev.get("why") or ev.get("reason") or "")[:300]
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
