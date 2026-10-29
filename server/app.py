"""
Server skrining Diabetic Retinopathy (DR) terintegrasi sistem pengujian akurasi:
1. Endpoint ESP32-CAM (/api/predict - JPEG raw)
2. Endpoint Single Test dengan Ground Truth (/api/evaluate/single)
3. Endpoint Benchmark Otomatis (/api/benchmark/evaluate)
4. Endpoint Batch Upload Dataset Kustom (/api/evaluate/batch)
5. Endpoint Penyetelan Ambang Batas Sensitivitas Real-Time (/api/benchmark/tune-threshold)
6. Riwayat, Statistik, dan Dashboard Web interaktif (/ & /api/results)
"""
import io
import json
import os
import re
import secrets
import shutil
import sqlite3
import tempfile
import time
import uuid
import zipfile
from contextlib import contextmanager

import cv2
import numpy as np
import onnxruntime as ort
from fastapi import Cookie, Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator

from preprocess import (
    IMG_SIZE,
    ben_graham,
    decode_image,
    generate_saliency_heatmap,
    img_to_base64,
    quality_check,
    standard_preprocess,
    to_model_input,
)

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.getenv("MODEL_PATH", os.path.join(BASE, "model", "dr_model.onnx"))
META_PATH = os.getenv("META_PATH", os.path.join(BASE, "model", "metadata.json"))
DATA_DIR = os.getenv("DATA_DIR", os.path.join(BASE, "data"))
API_KEY = os.getenv("API_KEY", "")          # kosong = tanpa autentikasi
MAX_BYTES = 10 * 1024 * 1024                # 10 MB limit untuk batch/upload
COOKIE_NAME = "dr_session"

IMG_DIR = os.path.join(DATA_DIR, "images")
BENCHMARK_DIR = os.path.join(DATA_DIR, "benchmark")
BENCHMARK_MANIFEST = os.path.join(BENCHMARK_DIR, "manifest.json")
DB_PATH = os.path.join(DATA_DIR, "results.db")
os.makedirs(IMG_DIR, exist_ok=True)
os.makedirs(BENCHMARK_DIR, exist_ok=True)

with open(META_PATH) as f:
    META = json.load(f)
LABELS = META["labels"]
MODEL_IMG_SIZE = META.get("img_size", IMG_SIZE)
PREPROCESS_MODE = META.get("preprocess_mode", "standard")
REF_GRADE = META.get("referable_threshold_grade", 2)
REF_PROB = float(os.getenv("REF_PROB", META.get("referable_prob_threshold", 0.40)))

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
            probs TEXT, quality TEXT, latency_ms REAL, p_referable REAL,
            true_grade INTEGER, is_correct INTEGER
        )""")
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(results)")}
    if "p_referable" not in cols:
        conn.execute("ALTER TABLE results ADD COLUMN p_referable REAL")
    if "true_grade" not in cols:
        conn.execute("ALTER TABLE results ADD COLUMN true_grade INTEGER")
    if "is_correct" not in cols:
        conn.execute("ALTER TABLE results ADD COLUMN is_correct INTEGER")

app = FastAPI(title="Diabetic Retinopathy Screening & Accuracy Evaluation Web")


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


def calculate_evaluation_metrics(records: list[dict], ref_prob: float = REF_PROB) -> dict:
    """Menghitung metrik evaluasi lengkap: Akurasi, QWK, Sensitivitas, Spesifisitas, CM 5x5, CM 2x2."""
    total = len(records)
    if total == 0:
        return {}

    y_true = np.array([r["true_grade"] for r in records], dtype=int)
    y_pred = np.array([r["pred_grade"] for r in records], dtype=int)
    probs_matrix = np.array([r["probs"] for r in records], dtype=float)

    acc = float((y_true == y_pred).mean())

    cm_5x5 = np.zeros((5, 5), dtype=int)
    for t, p in zip(y_true, y_pred):
        if 0 <= t < 5 and 0 <= p < 5:
            cm_5x5[t, p] += 1

    # Quadratic Weighted Kappa
    i_idx, j_idx = np.indices((5, 5))
    W = ((i_idx - j_idx) ** 2) / 16.0
    hist_t = cm_5x5.sum(axis=1)
    hist_p = cm_5x5.sum(axis=0)
    E = np.outer(hist_t, hist_p) / total
    num = (W * cm_5x5).sum()
    den = (W * E).sum()
    qwk = float(1.0 - (num / den)) if den > 0 else 1.0

    # Binary Referable screening
    p_ref = probs_matrix[:, REF_GRADE:].sum(axis=1)
    is_ref_true = (y_true >= REF_GRADE)
    is_ref_pred = (p_ref >= ref_prob)

    tp = int((is_ref_true & is_ref_pred).sum())
    fn = int((is_ref_true & (~is_ref_pred)).sum())
    tn = int(((~is_ref_true) & (~is_ref_pred)).sum())
    fp = int(((~is_ref_true) & is_ref_pred).sum())

    sens = float(tp / (tp + fn)) if (tp + fn) > 0 else 0.0
    spec = float(tn / (tn + fp)) if (tn + fp) > 0 else 0.0
    binary_acc = float((tp + tn) / total)
    prec_ref = float(tp / (tp + fp)) if (tp + fp) > 0 else 0.0
    f1_ref = float(2 * tp / (2 * tp + fp + fn)) if (2 * tp + fp + fn) > 0 else 0.0

    class_metrics = []
    precisions, recalls, f1s = [], [], []
    for g in range(5):
        c_tp = int(cm_5x5[g, g])
        c_fp = int(cm_5x5[:, g].sum() - c_tp)
        c_fn = int(cm_5x5[g, :].sum() - c_tp)
        support = int(cm_5x5[g, :].sum())

        c_prec = float(c_tp / (c_tp + c_fp)) if (c_tp + c_fp) > 0 else 0.0
        c_rec = float(c_tp / (c_tp + c_fn)) if (c_tp + c_fn) > 0 else 0.0
        c_f1 = float(2 * c_tp / (2 * c_tp + c_fp + c_fn)) if (2 * c_tp + c_fp + c_fn) > 0 else 0.0

        precisions.append(c_prec)
        recalls.append(c_rec)
        f1s.append(c_f1)

        class_metrics.append({
            "grade": g,
            "label": LABELS[g],
            "support": support,
            "precision": round(c_prec, 4),
            "recall": round(c_rec, 4),
            "f1": round(c_f1, 4),
            "correct": c_tp,
        })

    return {
        "total_samples": total,
        "accuracy": round(acc, 4),
        "kappa": round(qwk, 4),
        "referable_sensitivity": round(sens, 4),
        "referable_specificity": round(spec, 4),
        "referable_accuracy": round(binary_acc, 4),
        "referable_precision": round(prec_ref, 4),
        "referable_f1": round(f1_ref, 4),
        "macro_precision": round(float(np.mean(precisions)), 4),
        "macro_recall": round(float(np.mean(recalls)), 4),
        "macro_f1": round(float(np.mean(f1s)), 4),
        "confusion_matrix_5x5": cm_5x5.tolist(),
        "confusion_matrix_2x2": {
            "tp": tp, "fn": fn, "tn": tn, "fp": fp
        },
        "class_metrics": class_metrics,
        "labels": LABELS,
        "ref_threshold": ref_prob,
    }


def run_inference(data: bytes, device: str, source: str, true_grade: int | None = None) -> dict:
    """Sinkron dan berat (OpenCV + ONNX). Panggil lewat run_in_threadpool."""
    if not data:
        raise HTTPException(400, "Body kosong. Kirim gambar JPEG/PNG.")
    img = decode_image(data)
    if img is None:
        raise HTTPException(400, "File bukan gambar JPEG/PNG yang valid.")

    t0 = time.perf_counter()
    quality = quality_check(img)

    # Preprocessing sesuai model
    if PREPROCESS_MODE == "ben_graham":
        prep_img = ben_graham(img, MODEL_IMG_SIZE)
    else:
        prep_img = standard_preprocess(img, MODEL_IMG_SIZE)

    x = to_model_input(prep_img)
    raw_logits = session.run(None, {INPUT_NAME: x})[0][0]
    probs = softmax(raw_logits)
    latency = (time.perf_counter() - t0) * 1000

    grade = int(probs.argmax())
    p_ref = float(probs[REF_GRADE:].sum())
    rid = uuid.uuid4().hex[:12]
    ext = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpg"
    filename = f"{rid}.{ext}"

    with open(os.path.join(IMG_DIR, filename), "wb") as f:
        f.write(data)

    is_correct = (grade == true_grade) if true_grade is not None else None
    referable_true = (true_grade >= REF_GRADE) if true_grade is not None else None

    # Visualisasi tambahan
    prep_b64 = img_to_base64(prep_img)
    heatmap_b64 = generate_saliency_heatmap(img, MODEL_IMG_SIZE)

    result = {
        "id": rid,
        "ts": time.time(),
        "device": device,
        "source": source,
        "image_url": f"/images/{filename}",
        "preprocessed_url": prep_b64,
        "heatmap_url": heatmap_b64,
        "grade": grade,
        "label": LABELS[grade],
        "confidence": round(float(probs[grade]), 4),
        "referable": p_ref >= REF_PROB,
        "p_referable": round(p_ref, 4),
        "probs": [round(float(p), 4) for p in probs],
        "quality": quality,
        "latency_ms": round(latency, 1),
        "true_grade": true_grade,
        "true_label": LABELS[true_grade] if true_grade is not None and 0 <= true_grade < 5 else None,
        "is_correct": is_correct,
        "referable_true": referable_true,
    }

    with db() as conn:
        conn.execute(
            "INSERT INTO results (id, ts, device, source, filename, grade, label, confidence,"
            " referable, probs, quality, latency_ms, p_referable, true_grade, is_correct)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, result["ts"], device, source, filename, grade, result["label"],
             result["confidence"], int(result["referable"]), json.dumps(result["probs"]),
             json.dumps(quality), result["latency_ms"], result["p_referable"],
             true_grade, 1 if is_correct else (0 if is_correct is not None else None)))
    return result


def row_to_dict(r):
    return {
        "id": r["id"], "ts": r["ts"], "device": r["device"], "source": r["source"],
        "image_url": f"/images/{r['filename']}", "grade": r["grade"], "label": r["label"],
        "confidence": r["confidence"], "referable": bool(r["referable"]),
        "p_referable": r["p_referable"],
        "probs": json.loads(r["probs"]), "quality": json.loads(r["quality"]),
        "latency_ms": r["latency_ms"],
        "true_grade": r["true_grade"] if "true_grade" in r.keys() else None,
        "is_correct": bool(r["is_correct"]) if "is_correct" in r.keys() and r["is_correct"] is not None else None,
    }


async def read_limited(request: Request) -> bytes:
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > MAX_BYTES:
            raise HTTPException(413, "Ukuran file melebihi batas maksimum 10 MB.")
    return bytes(buf)


# --- Endpoints ---

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": META.get("model"),
        "img_size": MODEL_IMG_SIZE,
        "labels": LABELS,
        "referable_threshold": REF_PROB,
    }


@app.get("/api/model/info")
def model_info():
    return {
        "model": META.get("model", "ResNet-50 APTOS"),
        "architecture": META.get("architecture", "resnet50"),
        "img_size": MODEL_IMG_SIZE,
        "labels": LABELS,
        "descriptions": META.get("descriptions", [
            "Normal / Tidak ada DR",
            "DR Ringan (Mild)",
            "DR Sedang (Moderate)",
            "DR Berat (Severe)",
            "DR Proliferatif (PDR)",
        ]),
        "mean": META.get("mean"),
        "std": META.get("std"),
        "referable_threshold_grade": REF_GRADE,
        "referable_prob_threshold": REF_PROB,
        "val_metrics": META.get("val_metrics"),
        "test_metrics": META.get("test_metrics"),
    }


@app.get("/api/benchmark/samples")
def get_benchmark_samples():
    """Mengembalikan daftar 50 sampel citra benchmark untuk uji cepat per grade."""
    if not os.path.exists(BENCHMARK_MANIFEST):
        return []
    with open(BENCHMARK_MANIFEST) as f:
        samples = json.load(f)
    return samples


@app.get("/api/benchmark/image/{grade}/{filename}")
def get_benchmark_image(grade: int, filename: str):
    if not re.fullmatch(r"grade_\d+_sample_\d+\.(jpg|png)", filename):
        raise HTTPException(404, "Nama file tidak valid.")
    filepath = os.path.join(BENCHMARK_DIR, str(grade), filename)
    if not os.path.isfile(filepath):
        raise HTTPException(404, "File citra sampel tidak ditemukan.")
    return FileResponse(filepath, media_type="image/jpeg")


@app.post("/api/benchmark/evaluate")
async def evaluate_benchmark(threshold: float = Query(None)):
    """Menjalankan evaluasi akurasi menyeluruh pada dataset benchmark bawaan."""
    if not os.path.exists(BENCHMARK_MANIFEST):
        raise HTTPException(404, "Dataset benchmark belum disiapkan di server.")

    with open(BENCHMARK_MANIFEST) as f:
        samples = json.load(f)

    active_thresh = float(threshold) if isinstance(threshold, (int, float, str)) and str(threshold).strip() != "" else REF_PROB

    def _run_eval():
        records = []
        eval_samples = []
        latencies = []

        for item in samples:
            filepath = os.path.join(BENCHMARK_DIR, str(item["grade"]), item["filename"])
            if not os.path.isfile(filepath):
                filepath = item.get("local_path")
                if not filepath or not os.path.isfile(filepath):
                    continue
            with open(filepath, "rb") as f:
                data = f.read()

            img = decode_image(data)
            if img is None:
                continue

            t0 = time.perf_counter()
            if PREPROCESS_MODE == "ben_graham":
                prep = ben_graham(img, MODEL_IMG_SIZE)
            else:
                prep = standard_preprocess(img, MODEL_IMG_SIZE)

            x = to_model_input(prep)
            raw_logits = session.run(None, {INPUT_NAME: x})[0][0]
            probs = softmax(raw_logits)
            lat = (time.perf_counter() - t0) * 1000
            latencies.append(lat)

            pred_grade = int(probs.argmax())
            true_grade = int(item["grade"])
            p_ref = float(probs[REF_GRADE:].sum())

            is_correct = (pred_grade == true_grade)
            ref_true = (true_grade >= REF_GRADE)
            ref_pred = (p_ref >= active_thresh)

            rec = {
                "id": item["id"],
                "filename": item["filename"],
                "image_url": item["url"],
                "true_grade": true_grade,
                "true_label": LABELS[true_grade],
                "pred_grade": pred_grade,
                "pred_label": LABELS[pred_grade],
                "confidence": round(float(probs[pred_grade]), 4),
                "referable_true": ref_true,
                "referable_pred": ref_pred,
                "p_referable": round(p_ref, 4),
                "probs": [round(float(p), 4) for p in probs],
                "is_correct": is_correct,
                "latency_ms": round(lat, 1),
            }
            records.append(rec)
            eval_samples.append(rec)

        metrics = calculate_evaluation_metrics(records, ref_prob=active_thresh)
        metrics["avg_latency_ms"] = round(float(np.mean(latencies)), 1) if latencies else 0.0
        metrics["min_latency_ms"] = round(float(np.min(latencies)), 1) if latencies else 0.0
        metrics["max_latency_ms"] = round(float(np.max(latencies)), 1) if latencies else 0.0
        metrics["samples"] = eval_samples
        return metrics

    return await run_in_threadpool(_run_eval)


class TuneRequest(BaseModel):
    threshold: float
    items: list[dict]


@app.post("/api/benchmark/tune-threshold")
def tune_threshold(body: TuneRequest):
    """Menghitung ulang sensitivitas & spesifisitas secara instan dari probabilitas yang tersimpan."""
    thresh = float(body.threshold)
    records = []
    for it in body.items:
        records.append({
            "true_grade": int(it["true_grade"]),
            "pred_grade": int(it["pred_grade"]),
            "probs": it["probs"],
        })
    metrics = calculate_evaluation_metrics(records, ref_prob=thresh)
    return metrics


@app.post("/api/evaluate/single")
async def evaluate_single(
    file: UploadFile = File(...),
    true_grade: int | None = Form(None),
    device: str = Form("web-tester")
):
    """Uji satu citra dengan opsional label Ground Truth untuk cek akurasi langsung."""
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Ukuran file melebihi 10 MB.")
    t_grade = int(true_grade) if true_grade is not None and str(true_grade).strip() != "" else None
    return await run_in_threadpool(run_inference, data, device, "single_test", t_grade)


@app.post("/api/evaluate/batch")
async def evaluate_batch(file: UploadFile = File(...), threshold: float = Form(None)):
    """
    Unggah file ZIP berisi dataset kustom untuk pengujian akurasi massal.
    Struktur folder ZIP yang didukung:
      - Folder berangka: 0/, 1/, 2/, 3/, 4/
      - Folder nama: normal/, mild/, moderate/, severe/, proliferative/
      - Nama file yang memuat grade, misal: grade0_xxx.jpg, g2_test.png
    """
    content = await file.read()
    if len(content) > MAX_BYTES * 5:  # 50 MB zip limit
        raise HTTPException(413, "File ZIP terlalu besar (maksimal 50 MB).")

    active_thresh = float(threshold) if threshold is not None else REF_PROB

    def _process_zip():
        records = []
        eval_samples = []
        latencies = []

        folder_map = {
            "0": 0, "normal": 0, "healthy": 0, "no_dr": 0, "nodr": 0,
            "1": 1, "mild": 1, "ringan": 1,
            "2": 2, "moderate": 2, "sedang": 2,
            "3": 3, "severe": 3, "berat": 3,
            "4": 4, "proliferate": 4, "proliferative": 4, "pdr": 4, "proliferatif": 4
        }

        try:
            with zipfile.ZipFile(io.BytesIO(content)) as z:
                for entry in z.namelist():
                    if entry.startswith("__MACOSX") or entry.endswith("/"):
                        continue
                    ext = entry.lower().split(".")[-1]
                    if ext not in ["jpg", "jpeg", "png", "webp"]:
                        continue

                    # Ekstrak true_grade dari path atau nama file
                    parts = entry.replace("\\", "/").split("/")
                    detected_grade = None
                    if len(parts) > 1:
                        parent = parts[-2].lower().strip()
                        if parent in folder_map:
                            detected_grade = folder_map[parent]
                    if detected_grade is None:
                        fname = parts[-1].lower()
                        m = re.search(r"(?:grade|class|g)[_-]?([0-4])", fname)
                        if m:
                            detected_grade = int(m.group(1))

                    if detected_grade is None:
                        continue

                    img_bytes = z.read(entry)
                    img = decode_image(img_bytes)
                    if img is None:
                        continue

                    t0 = time.perf_counter()
                    if PREPROCESS_MODE == "ben_graham":
                        prep = ben_graham(img, MODEL_IMG_SIZE)
                    else:
                        prep = standard_preprocess(img, MODEL_IMG_SIZE)

                    x = to_model_input(prep)
                    raw_logits = session.run(None, {INPUT_NAME: x})[0][0]
                    probs = softmax(raw_logits)
                    lat = (time.perf_counter() - t0) * 1000
                    latencies.append(lat)

                    pred_grade = int(probs.argmax())
                    p_ref = float(probs[REF_GRADE:].sum())

                    # Simpan citra ke images/ agar bisa ditampilkan di browser
                    rid = uuid.uuid4().hex[:12]
                    out_filename = f"{rid}.jpg"
                    with open(os.path.join(IMG_DIR, out_filename), "wb") as f_out:
                        f_out.write(img_bytes)

                    is_correct = (pred_grade == detected_grade)
                    ref_true = (detected_grade >= REF_GRADE)
                    ref_pred = (p_ref >= active_thresh)

                    rec = {
                        "id": rid,
                        "filename": os.path.basename(entry),
                        "image_url": f"/images/{out_filename}",
                        "true_grade": detected_grade,
                        "true_label": LABELS[detected_grade],
                        "pred_grade": pred_grade,
                        "pred_label": LABELS[pred_grade],
                        "confidence": round(float(probs[pred_grade]), 4),
                        "referable_true": ref_true,
                        "referable_pred": ref_pred,
                        "p_referable": round(p_ref, 4),
                        "probs": [round(float(p), 4) for p in probs],
                        "is_correct": is_correct,
                        "latency_ms": round(lat, 1),
                    }
                    records.append(rec)
                    eval_samples.append(rec)

        except zipfile.BadZipFile:
            raise HTTPException(400, "File yang diunggah bukan arsip ZIP yang valid.")

        if not records:
            raise HTTPException(400, "Tidak ada gambar dengan label grade (0-4) yang ditemukan dalam ZIP. Pastikan nama folder adalah 0, 1, 2, 3, 4 atau nama file mengandung grade_X.")

        metrics = calculate_evaluation_metrics(records, ref_prob=active_thresh)
        metrics["avg_latency_ms"] = round(float(np.mean(latencies)), 1) if latencies else 0.0
        metrics["samples"] = eval_samples
        return metrics

    return await run_in_threadpool(_process_zip)


# --- Endpoint Asli (Kompatibilitas ESP32 & Dashboard) ---

# --- Perangkat ESP32: status online & perintah ambil foto dari dashboard ---
# Disimpan di memori: cukup untuk prototype satu server; hilang saat server restart.
DEVICES: dict[str, dict] = {}
DEVICE_ONLINE_SEC = 10        # dianggap offline jika tidak polling selama ini
CAPTURE_TIMEOUT_SEC = 30      # perintah foto yang tidak diambil dianggap kedaluwarsa


def touch_device(device_id: str, ip: str | None) -> dict:
    dev = DEVICES.setdefault(device_id, {"capture_requested_at": None, "applied_version": None})
    dev["last_seen"] = time.time()
    dev["ip"] = ip
    return dev


# Pengaturan kamera per perangkat. Disimpan di file agar tetap ada setelah server restart.
SETTINGS_PATH = os.path.join(DATA_DIR, "device_settings.json")
RESOLUTIONS = ["VGA", "SVGA", "XGA", "HD", "SXGA", "UXGA"]   # 640x480 ... 1600x1200


class CameraSettings(BaseModel):
    resolution: str = "SVGA"
    jpeg_quality: int = Field(10, ge=8, le=40)        # makin kecil makin bagus (dan makin besar file)
    brightness: int = Field(0, ge=-2, le=2)
    contrast: int = Field(0, ge=-2, le=2)
    saturation: int = Field(0, ge=-2, le=2)
    ae_level: int = Field(0, ge=-2, le=2)             # koreksi eksposur otomatis
    awb: bool = True                                  # white balance otomatis
    hmirror: bool = False
    vflip: bool = False
    flash_mode: str = "capture"                       # off | capture (menyala saat memotret) | on (selalu)
    flash_intensity: int = Field(128, ge=0, le=255)   # PWM GPIO4

    @field_validator("resolution")
    @classmethod
    def _res(cls, v):
        if v not in RESOLUTIONS:
            raise ValueError(f"resolusi harus salah satu dari {RESOLUTIONS}")
        return v

    @field_validator("flash_mode")
    @classmethod
    def _flash(cls, v):
        if v not in ("off", "capture", "on"):
            raise ValueError("flash_mode harus off, capture, atau on")
        return v


def load_settings() -> dict[str, dict]:
    try:
        with open(SETTINGS_PATH) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


DEVICE_SETTINGS: dict[str, dict] = load_settings()   # {device_id: {"version": n, ...CameraSettings}}


def settings_for(device_id: str) -> dict:
    s = DEVICE_SETTINGS.get(device_id)
    if s is None:
        s = {"version": 1, **CameraSettings().model_dump()}
    return s


@app.get("/api/device/poll", dependencies=[Depends(require_key)])
def device_poll(request: Request, x_device_id: str = Header("unknown"),
                x_settings_version: int | None = Header(None)):
    """Dipanggil ESP32 tiap ~1,5 detik. Mengembalikan capture=true jika dashboard meminta foto,
    beserta pengaturan kamera terbaru (ESP32 menerapkannya jika versinya berubah)."""
    dev = touch_device(x_device_id, request.client.host if request.client else None)
    dev["applied_version"] = x_settings_version
    req = dev["capture_requested_at"]
    capture = req is not None and time.time() - req < CAPTURE_TIMEOUT_SEC
    dev["capture_requested_at"] = None
    return {"capture": capture, "settings": settings_for(x_device_id)}


@app.get("/api/devices/{device_id}/settings", dependencies=[Depends(require_key)])
def get_device_settings(device_id: str):
    return settings_for(device_id)


@app.put("/api/devices/{device_id}/settings", dependencies=[Depends(require_key)])
def put_device_settings(device_id: str, body: CameraSettings):
    version = settings_for(device_id)["version"] + 1
    DEVICE_SETTINGS[device_id] = {"version": version, **body.model_dump()}
    tmp = SETTINGS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(DEVICE_SETTINGS, f, indent=2)
    os.replace(tmp, SETTINGS_PATH)
    return DEVICE_SETTINGS[device_id]


@app.post("/api/devices/{device_id}/capture", dependencies=[Depends(require_key)])
def request_capture(device_id: str):
    dev = DEVICES.get(device_id)
    if not dev or time.time() - dev["last_seen"] > DEVICE_ONLINE_SEC:
        raise HTTPException(409, f"Perangkat {device_id} sedang offline.")
    dev["capture_requested_at"] = time.time()
    return {"ok": True}


@app.get("/api/devices", dependencies=[Depends(require_key)])
def list_devices():
    now = time.time()
    with db() as conn:
        out = []
        for device_id, dev in DEVICES.items():
            row = conn.execute("SELECT * FROM results WHERE device=? ORDER BY ts DESC LIMIT 1",
                               (device_id,)).fetchone()
            req = dev["capture_requested_at"]
            out.append({
                "id": device_id,
                "ip": dev["ip"],
                "last_seen": dev["last_seen"],
                "online": now - dev["last_seen"] <= DEVICE_ONLINE_SEC,
                "capture_pending": req is not None and now - req < CAPTURE_TIMEOUT_SEC,
                "settings_version": settings_for(device_id)["version"],
                "applied_version": dev.get("applied_version"),
                "latest": row_to_dict(row) if row else None,
            })
    return sorted(out, key=lambda d: d["last_seen"], reverse=True)


@app.post("/api/predict", dependencies=[Depends(require_key)])
async def predict_raw(request: Request, x_device_id: str = Header("unknown")):
    """Untuk ESP32: body = bytes JPEG mentah."""
    data = await read_limited(request)
    touch_device(x_device_id, request.client.host if request.client else None)
    full = await run_in_threadpool(run_inference, data, x_device_id, "esp32")
    return {
        "id": full["id"],
        "grade": full["grade"],
        "label": full["label"],
        "confidence": full["confidence"],
        "referable": full["referable"],
        "p_referable": full["p_referable"],
        "quality_ok": full["quality"]["ok"],
    }


@app.post("/api/upload", dependencies=[Depends(require_key)])
async def predict_upload(file: UploadFile = File(...)):
    """Untuk dashboard: upload manual foto fundus."""
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Ukuran file lebih dari 10 MB.")
    return await run_in_threadpool(run_inference, data, "dashboard", "upload")


class Login(BaseModel):
    key: str


@app.post("/api/login")
def login(body: Login, response: Response):
    require_key(body.key, None)
    response.set_cookie(COOKIE_NAME, body.key, httponly=True, samesite="strict",
                        max_age=7 * 24 * 3600)
    return {"ok": True}


@app.get("/api/results", dependencies=[Depends(require_key)])
def results(limit: int = Query(100, ge=1, le=500)):
    with db() as conn:
        rows = conn.execute("SELECT * FROM results ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return [row_to_dict(r) for r in rows]


@app.delete("/api/results")
def clear_results(dependencies=[Depends(require_key)]):
    with db() as conn:
        conn.execute("DELETE FROM results")
    return {"ok": True, "message": "Riwayat pengujian berhasil dibersihkan."}


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
        "test_kappa": (META.get("test_metrics") or {}).get("kappa"),
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


@app.get("/")
def dashboard():
    return FileResponse(os.path.join(BASE, "static", "dashboard.html"))
