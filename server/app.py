"""
Server Retinova: skrining retinopati diabetik.

Modul:
- clinic.py   akun staf, pasien, pemeriksaan, bacaan dokter (dipakai aplikasi web)
- devices.py  ESP32-CAM: polling, perintah foto, pengaturan kamera, unggah JPEG (/api/predict)
- app.py      endpoint lab untuk admin (benchmark, uji batch, penyetelan ambang), file gambar, dan aplikasi web
"""
import envfile  # noqa: F401  (muat server/.env sebelum modul lain membaca variabel lingkungan)
import io
import json
import os
import re
import time
import uuid
import zipfile

import numpy as np
from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import appointments
import billing
import llm
import clinic
import devices
import security
import satusehat
from auth import current_user, require_role
from database import BASE, DATA_DIR, IMG_DIR, db, init_db, purge_results
from inference import (
    INPUT_NAME,
    LABELS,
    META,
    MODEL_IMG_SIZE,
    PREPROCESS_MODE,
    REF_GRADE,
    REF_PROB,
    ensure_cam,
    infer,
    row_to_dict,
    run_inference,
    session,
    softmax,
)
from preprocess import QC, ben_graham, decode_image, quality_check, standard_preprocess, to_model_input

MAX_BYTES = devices.MAX_BYTES
BENCHMARK_DIR = os.path.join(DATA_DIR, "benchmark")
BENCHMARK_MANIFEST = os.path.join(BENCHMARK_DIR, "manifest.json")
os.makedirs(BENCHMARK_DIR, exist_ok=True)
init_db()

# Dokumentasi API (/docs, /openapi.json) mati di produksi; nyalakan dengan ENABLE_DOCS=1 saat pengembangan.
_DOCS = os.getenv("ENABLE_DOCS", "0") == "1"
app = FastAPI(title="Retinova: Skrining Retinopati Diabetik", docs_url="/docs" if _DOCS else None,
              redoc_url=None, openapi_url="/openapi.json" if _DOCS else None)
app.include_router(clinic.router)
app.include_router(devices.router)
app.include_router(appointments.router)
app.include_router(satusehat.router)
app.include_router(billing.router)
app.include_router(llm.router)

ADMIN = Depends(require_role("admin"))


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


@app.get("/api/model/info", dependencies=[ADMIN])
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
        "tuned_ref_threshold": META.get("referable_prob_threshold"),
        "preprocess_mode": META.get("preprocess_mode", "standard"),
        "selection_metric": META.get("selection_metric"),
        "val_metrics": META.get("val_metrics"),
        "test_metrics": META.get("test_metrics"),
        "onnx_test_metrics": META.get("onnx_test_metrics"),
        "onnx_test_pred_agreement": META.get("onnx_test_pred_agreement"),
        "quality_thresholds": QC,
    }


@app.get("/api/benchmark/samples", dependencies=[ADMIN])
def get_benchmark_samples():
    """Mengembalikan daftar 50 sampel citra benchmark untuk uji cepat per grade."""
    if not os.path.exists(BENCHMARK_MANIFEST):
        return []
    with open(BENCHMARK_MANIFEST) as f:
        samples = json.load(f)
    return samples


@app.get("/api/benchmark/image/{grade}/{filename}", dependencies=[ADMIN])
def get_benchmark_image(grade: int, filename: str):
    if not re.fullmatch(r"grade_\d+_sample_\d+\.(jpg|png)", filename):
        raise HTTPException(404, "Nama file tidak valid.")
    filepath = os.path.join(BENCHMARK_DIR, str(grade), filename)
    if not os.path.isfile(filepath):
        raise HTTPException(404, "File citra sampel tidak ditemukan.")
    return FileResponse(filepath, media_type="image/jpeg")


@app.post("/api/benchmark/evaluate", dependencies=[ADMIN])
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
            probs, _, _ = infer(img)
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
                "quality": quality_check(img),
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


@app.post("/api/benchmark/tune-threshold", dependencies=[ADMIN])
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


@app.post("/api/evaluate/single", dependencies=[ADMIN])
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


@app.post("/api/evaluate/batch", dependencies=[ADMIN])
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
                    probs, _, _ = infer(img)
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
                        "quality": quality_check(img),
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


# --- Lab: riwayat semua inferensi (termasuk uji), hanya admin ---

@app.post("/api/upload", dependencies=[ADMIN])
async def predict_upload(file: UploadFile = File(...)):
    """Uji cepat satu foto tanpa pemeriksaan."""
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Ukuran file lebih dari 10 MB.")
    return await run_in_threadpool(run_inference, data, "dashboard", "upload")


@app.get("/api/results", dependencies=[ADMIN])
def results(limit: int = Query(100, ge=1, le=500)):
    with db() as conn:
        rows = conn.execute("SELECT * FROM results ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return [row_to_dict(r) for r in rows]


@app.delete("/api/results", dependencies=[ADMIN])
def clear_results():
    """Hapus riwayat uji lab. Foto yang menjadi bagian pemeriksaan pasien tidak ikut terhapus."""
    with db() as conn:
        purge_results(conn, "screening_id IS NULL")
    return {"ok": True, "message": "Riwayat pengujian berhasil dibersihkan."}


@app.get("/api/stats", dependencies=[ADMIN])
def stats():
    with db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]
        referable = conn.execute("SELECT COUNT(*) FROM results WHERE referable=1").fetchone()[0]
        per_grade = dict(conn.execute("SELECT grade, COUNT(*) FROM results GROUP BY grade").fetchall())
        device_ids = [r[0] for r in conn.execute(
            "SELECT device FROM results GROUP BY device ORDER BY MAX(ts) DESC").fetchall()]
    return {
        "total": total,
        "referable": referable,
        "per_grade": [per_grade.get(g, 0) for g in range(len(LABELS))],
        "devices": device_ids,
        "labels": LABELS,
        "model": META.get("model"),
        "val_kappa": (META.get("val_metrics") or {}).get("kappa"),
        "test_kappa": (META.get("test_metrics") or {}).get("kappa"),
        "ref_prob_threshold": REF_PROB,
        "auth": True,
    }


# --- File gambar & aplikasi web ---

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": META.get("model"),
        "img_size": MODEL_IMG_SIZE,
        "labels": LABELS,
        "referable_threshold": REF_PROB,
    }


@app.get("/images/{name}")
def image(name: str, user: dict = Depends(current_user)):
    m = re.fullmatch(r"([0-9a-f]{12})(_prep|_heat|_cam)?\.(jpg|png)", name)
    if not m:
        raise HTTPException(404)
    if m.group(2) == "_cam":
        # Fokus AI membuka perkiraan AI: hanya untuk peran yang boleh melihat hasil AI
        if not clinic.can_see_ai(user):
            raise HTTPException(404)
        with db() as conn:
            r = conn.execute("SELECT filename, probs FROM results WHERE id=?", (m.group(1),)).fetchone()
        if r is None or not ensure_cam(m.group(1), r["filename"], json.loads(r["probs"])):
            raise HTTPException(404)
    path = os.path.join(IMG_DIR, name)
    if not os.path.isfile(path):
        raise HTTPException(404)
    # Foto retina adalah data kesehatan: jangan disimpan di cache browser/proksi.
    return FileResponse(path, headers={"Cache-Control": "no-store"})


@app.get("/lab", dependencies=[ADMIN])
def lab_dashboard():
    """Dasbor lama untuk pengujian model (benchmark, batch ZIP, ambang). Hanya admin."""
    return FileResponse(os.path.join(BASE, "static", "lab.html"))


WEB_DIST = os.getenv("WEB_DIST", os.path.join(BASE, "static", "app"))
security.install(app, os.path.join(WEB_DIST, "index.html"))
if os.path.isdir(os.path.join(WEB_DIST, "assets")):
    app.mount("/assets", StaticFiles(directory=os.path.join(WEB_DIST, "assets")), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def web_app(path: str):
    """Aplikasi web (SPA). File statis di root build dilayani langsung, sisanya ke index.html."""
    if path.startswith(("api/", "images/")):
        raise HTTPException(404)
    candidate = os.path.normpath(os.path.join(WEB_DIST, path))
    if path and candidate.startswith(WEB_DIST + os.sep) and os.path.isfile(candidate):
        return FileResponse(candidate)
    index = os.path.join(WEB_DIST, "index.html")
    if not os.path.isfile(index):
        raise HTTPException(503, "Aplikasi web belum di-build. Jalankan: cd web && npm install && npm run build")
    return FileResponse(index, headers={"Cache-Control": "no-cache"})
