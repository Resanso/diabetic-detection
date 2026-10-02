"""
Server inferensi Diabetic Retinopathy.

Endpoint:
  POST /api/predict        ESP32 mengirim JPEG mentah (Content-Type: image/jpeg)
  POST /api/upload         upload manual dari dashboard (multipart form)
  POST /api/login          dashboard menukar API key dengan cookie sesi
  GET  /api/results        riwayat hasil (JSON)
  GET  /api/stats          ringkasan untuk dashboard
  GET  /images/{nama}      foto yang tersimpan
  GET  /health             cek server hidup
  GET  /                   dashboard

Jika env API_KEY diisi, semua endpoint /api/* dan /images/* wajib menyertakan
header X-API-Key atau cookie sesi dari /api/login. /health dan / tetap terbuka.

Jalankan:
  uvicorn app:app --host 0.0.0.0 --port 8000
"""
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager

import numpy as np
import onnxruntime as ort
from fastapi import Cookie, Depends, FastAPI, File, Header, HTTPException, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel

from preprocess import ben_graham, decode_image, quality_check, to_model_input

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.getenv("MODEL_PATH", os.path.join(BASE, "model", "dr_model.onnx"))
META_PATH = os.getenv("META_PATH", os.path.join(BASE, "model", "metadata.json"))
DATA_DIR = os.getenv("DATA_DIR", os.path.join(BASE, "data"))
API_KEY = os.getenv("API_KEY", "")          # kosong = tanpa autentikasi (hanya untuk LAN/prototype)
MAX_BYTES = 5 * 1024 * 1024
COOKIE_NAME = "dr_session"

IMG_DIR = os.path.join(DATA_DIR, "images")
DB_PATH = os.path.join(DATA_DIR, "results.db")
os.makedirs(IMG_DIR, exist_ok=True)

with open(META_PATH) as f:
    META = json.load(f)
LABELS = META["labels"]
IMG_SIZE = META["img_size"]
REF_GRADE = META.get("referable_threshold_grade", 2)
# Rujukan diputuskan dari P(grade >= REF_GRADE), bukan dari argmax. Turunkan nilai ini
# untuk menaikkan sensitivitas (lebih sedikit kasus terlewat, lebih banyak rujukan palsu).
REF_PROB = float(os.getenv("REF_PROB", META.get("referable_prob_threshold", 0.5)))

session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
INPUT_NAME = session.get_inputs()[0].name


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


with db() as conn:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS results (
            id TEXT PRIMARY KEY, ts REAL, device TEXT, source TEXT, filename TEXT,
            grade INTEGER, label TEXT, confidence REAL, referable INTEGER,
            probs TEXT, quality TEXT, latency_ms REAL, p_referable REAL
        )""")
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(results)")}
    if "p_referable" not in cols:  # database lama sebelum kolom ini ada
        conn.execute("ALTER TABLE results ADD COLUMN p_referable REAL")

app = FastAPI(title="Retina DR Screening")


def require_key(x_api_key: str | None = Header(None),
                dr_session: str | None = Cookie(None)):
    if not API_KEY:
        return
    for key in (x_api_key, dr_session):
        if key and secrets.compare_digest(key.encode(), API_KEY.encode()):
            return
    raise HTTPException(401, "API key salah atau tidak dikirim (header X-API-Key).")


def softmax(x):
    e = np.exp(x - x.max())
    return e / e.sum()


def run_inference(data: bytes, device: str, source: str) -> dict:
    """Sinkron dan berat (OpenCV + ONNX). Panggil lewat run_in_threadpool dari endpoint async."""
    if not data:
        raise HTTPException(400, "Body kosong. Kirim gambar JPEG/PNG.")
    img = decode_image(data)
    if img is None:
        raise HTTPException(400, "File bukan gambar JPEG/PNG yang valid.")

    t0 = time.perf_counter()
    quality = quality_check(img)
    x = to_model_input(ben_graham(img, IMG_SIZE))
    probs = softmax(session.run(None, {INPUT_NAME: x})[0][0])
    latency = (time.perf_counter() - t0) * 1000

    grade = int(probs.argmax())
    p_ref = float(probs[REF_GRADE:].sum())
    rid = uuid.uuid4().hex[:12]
    ext = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpg"
    filename = f"{rid}.{ext}"
    with open(os.path.join(IMG_DIR, filename), "wb") as f:
        f.write(data)

    result = {
        "id": rid,
        "ts": time.time(),
        "device": device,
        "source": source,
        "image_url": f"/images/{filename}",
        "grade": grade,
        "label": LABELS[grade],
        "confidence": round(float(probs[grade]), 4),
        "referable": p_ref >= REF_PROB,
        "p_referable": round(p_ref, 4),
        "probs": [round(float(p), 4) for p in probs],
        "quality": quality,
        "latency_ms": round(latency, 1),
    }
    with db() as conn:
        conn.execute(
            "INSERT INTO results (id, ts, device, source, filename, grade, label, confidence,"
            " referable, probs, quality, latency_ms, p_referable) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, result["ts"], device, source, filename, grade, result["label"],
             result["confidence"], int(result["referable"]), json.dumps(result["probs"]),
             json.dumps(quality), result["latency_ms"], result["p_referable"]))
    return result


def row_to_dict(r):
    return {
        "id": r["id"], "ts": r["ts"], "device": r["device"], "source": r["source"],
        "image_url": f"/images/{r['filename']}", "grade": r["grade"], "label": r["label"],
        "confidence": r["confidence"], "referable": bool(r["referable"]),
        "p_referable": r["p_referable"],
        "probs": json.loads(r["probs"]), "quality": json.loads(r["quality"]),
        "latency_ms": r["latency_ms"],
    }


def too_large():
    return HTTPException(413, "Gambar lebih dari 5 MB.")


async def read_limited(request: Request) -> bytes:
    """Baca body mentah, hentikan begitu melewati MAX_BYTES (tanpa menampung semuanya dulu)."""
    if int(request.headers.get("content-length") or 0) > MAX_BYTES:
        raise too_large()
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > MAX_BYTES:
            raise too_large()
    return bytes(buf)


@app.post("/api/predict", dependencies=[Depends(require_key)])
async def predict_raw(request: Request, x_device_id: str = Header("unknown")):
    """Untuk ESP32: body = bytes JPEG mentah. Respons dibuat ringkas supaya mudah di-parse."""
    data = await read_limited(request)
    r = await run_in_threadpool(run_inference, data, x_device_id[:64], "esp32")
    return {
        "id": r["id"], "grade": r["grade"], "label": r["label"],
        "confidence": r["confidence"], "referable": r["referable"],
        "p_referable": r["p_referable"], "quality_ok": r["quality"]["ok"],
    }


@app.post("/api/upload", dependencies=[Depends(require_key)])
async def predict_upload(file: UploadFile = File(...)):
    """Untuk dashboard: upload manual foto fundus."""
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise too_large()
    return await run_in_threadpool(run_inference, data, "dashboard", "upload")


class Login(BaseModel):
    key: str


@app.post("/api/login")
def login(body: Login, response: Response):
    """Dashboard menukar API key dengan cookie HttpOnly, supaya <img> ikut terautentikasi."""
    require_key(body.key, None)
    response.set_cookie(COOKIE_NAME, body.key, httponly=True, samesite="strict",
                        max_age=7 * 24 * 3600)
    return {"ok": True}


@app.get("/api/results", dependencies=[Depends(require_key)])
def results(limit: int = Query(50, ge=1, le=500)):
    with db() as conn:
        rows = conn.execute("SELECT * FROM results ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return [row_to_dict(r) for r in rows]


@app.get("/api/stats", dependencies=[Depends(require_key)])
def stats():
    with db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]
        referable = conn.execute("SELECT COUNT(*) FROM results WHERE referable=1").fetchone()[0]
        per_grade = dict(conn.execute("SELECT grade, COUNT(*) FROM results GROUP BY grade").fetchall())
        devices = [r[0] for r in conn.execute(
            "SELECT device FROM results GROUP BY device ORDER BY MAX(ts) DESC").fetchall()]
    return {
        "total": total,
        "referable": referable,
        "per_grade": [per_grade.get(g, 0) for g in range(len(LABELS))],
        "devices": devices,
        "labels": LABELS,
        "model": META.get("model"),
        "val_kappa": (META.get("val_metrics") or {}).get("kappa"),
        "ref_prob_threshold": REF_PROB,
        "auth": bool(API_KEY),
    }


@app.get("/images/{name}", dependencies=[Depends(require_key)])
def image(name: str):
    if not re.fullmatch(r"[0-9a-f]{12}\.(jpg|png)", name):
        raise HTTPException(404)
    path = os.path.join(IMG_DIR, name)
    if not os.path.isfile(path):
        raise HTTPException(404)
    return FileResponse(path)


@app.get("/health")
def health():
    return {"status": "ok", "model": META.get("model")}


@app.get("/")
def dashboard():
    return FileResponse(os.path.join(BASE, "static", "dashboard.html"))
