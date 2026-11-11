"""Model ONNX dan inferensi satu foto (dipakai endpoint klinis, ESP32, dan lab)."""
import base64
import json
import os
import time
import uuid

import cv2
import numpy as np
import onnxruntime as ort
from fastapi import HTTPException

from database import BASE, IMG_DIR, db
from preprocess import (
    IMG_SIZE,
    ben_graham,
    crop_black_border,
    decode_image,
    generate_saliency_heatmap,
    quality_check,
    standard_preprocess,
    to_model_input,
)

MODEL_PATH = os.getenv("MODEL_PATH", os.path.join(BASE, "model", "dr_model.onnx"))
META_PATH = os.getenv("META_PATH", os.path.join(BASE, "model", "metadata.json"))

with open(META_PATH) as f:
    META = json.load(f)
LABELS = META["labels"]
MODEL_IMG_SIZE = META.get("img_size", IMG_SIZE)
PREPROCESS_MODE = META.get("preprocess_mode", "standard")
ENSEMBLE = PREPROCESS_MODE == "ensemble"   # dua masukan (x456, x384), praproses Ben Graham di dalam graf
REF_GRADE = META.get("referable_threshold_grade", 2)
REF_PROB = float(os.getenv("REF_PROB") or META.get("referable_prob_threshold", 0.40))

if ENSEMBLE:
    _so = ort.SessionOptions()
    _so.enable_cpu_mem_arena = False   # lepas memori aktivasi setelah tiap foto (VPS kecil dipakai bersama)
    session = ort.InferenceSession(MODEL_PATH, _so, providers=["CPUExecutionProvider"])
else:
    session = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
INPUT_NAME = session.get_inputs()[0].name


def softmax(x):
    e = np.exp(x - x.max())
    return e / e.sum()


def preprocess_for_model(img: np.ndarray) -> np.ndarray:
    if PREPROCESS_MODE == "ben_graham":
        return ben_graham(img, MODEL_IMG_SIZE)
    return standard_preprocess(img, MODEL_IMG_SIZE)


def crop_square(img: np.ndarray, tol: int = 7) -> np.ndarray:
    """Buang tepi hitam lalu tambal jadi persegi (identik dengan pelatihan ensemble)."""
    c = crop_black_border(img, tol)
    h, w = c.shape[:2]
    s = max(h, w)
    out = np.zeros((s, s, 3), np.uint8)
    out[(s - h) // 2:(s - h) // 2 + h, (s - w) // 2:(s - w) // 2 + w] = c
    return out


def infer(img: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Foto RGB -> (probabilitas 5 derajat, citra olahan yang dilihat model (RGB uint8))."""
    if ENSEMBLE:
        c = crop_square(img)
        feed = {i.name: cv2.resize(c, (i.shape[1], i.shape[1]), interpolation=cv2.INTER_AREA).astype(np.float32)[None]
                for i in session.get_inputs()}
        probs, prep = session.run(["probs", "prep"], feed)
        return probs[0], np.clip(prep[0], 0, 255).astype(np.uint8)
    prep_img = preprocess_for_model(img)
    return predict_probs(prep_img), prep_img


def predict_probs(prep_img: np.ndarray) -> np.ndarray:
    raw_logits = session.run(None, {INPUT_NAME: to_model_input(prep_img)})[0][0]
    return softmax(raw_logits)


def _write_jpeg(path: str, img_rgb: np.ndarray):
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 88])
    if ok:
        with open(path, "wb") as f:
            f.write(buf.tobytes())


def _write_data_url(path: str, data_url: str):
    with open(path, "wb") as f:
        f.write(base64.b64decode(data_url.split(",", 1)[1]))


def image_urls(filename: str) -> dict:
    stem = filename.rsplit(".", 1)[0]
    return {
        "image_url": f"/images/{filename}",
        "preprocessed_url": f"/images/{stem}_prep.jpg",
        "heatmap_url": f"/images/{stem}_heat.jpg",
    }


def run_inference(data: bytes, device: str, source: str, true_grade: int | None = None,
                  screening_id: str | None = None, eye: str | None = None,
                  user_id: int | None = None) -> dict:
    """Sinkron dan berat (OpenCV + ONNX). Panggil lewat run_in_threadpool."""
    if not data:
        raise HTTPException(400, "Body kosong. Kirim gambar JPEG/PNG.")
    img = decode_image(data)
    if img is None:
        raise HTTPException(400, "File bukan gambar JPEG/PNG yang valid.")

    t0 = time.perf_counter()
    quality = quality_check(img)
    probs, prep_img = infer(img)
    latency = (time.perf_counter() - t0) * 1000

    grade = int(probs.argmax())
    p_ref = float(probs[REF_GRADE:].sum())
    rid = uuid.uuid4().hex[:12]
    ext = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpg"
    filename = f"{rid}.{ext}"

    with open(os.path.join(IMG_DIR, filename), "wb") as f:
        f.write(data)
    # Versi olahan dan peta atensi disimpan sebagai file agar dokter bisa membukanya kapan saja.
    _write_jpeg(os.path.join(IMG_DIR, f"{rid}_prep.jpg"), prep_img)
    _write_data_url(os.path.join(IMG_DIR, f"{rid}_heat.jpg"), generate_saliency_heatmap(img, MODEL_IMG_SIZE))

    is_correct = (grade == true_grade) if true_grade is not None else None
    result = {
        "id": rid,
        "ts": time.time(),
        "device": device,
        "source": source,
        **image_urls(filename),
        "grade": grade,
        "label": LABELS[grade],
        "confidence": round(float(probs[grade]), 4),
        "referable": p_ref >= REF_PROB,
        "p_referable": round(p_ref, 4),
        "ref_threshold": REF_PROB,
        "probs": [round(float(p), 4) for p in probs],
        "quality": quality,
        "latency_ms": round(latency, 1),
        "true_grade": true_grade,
        "true_label": LABELS[true_grade] if true_grade is not None and 0 <= true_grade < 5 else None,
        "is_correct": is_correct,
        "referable_true": (true_grade >= REF_GRADE) if true_grade is not None else None,
        "screening_id": screening_id,
        "eye": eye,
    }

    with db() as conn:
        conn.execute(
            "INSERT INTO results (id, ts, device, source, filename, grade, label, confidence,"
            " referable, probs, quality, latency_ms, p_referable, true_grade, is_correct,"
            " screening_id, eye, user_id)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, result["ts"], device, source, filename, grade, result["label"],
             result["confidence"], int(result["referable"]), json.dumps(result["probs"]),
             json.dumps(quality), result["latency_ms"], result["p_referable"],
             true_grade, None if is_correct is None else int(is_correct),
             screening_id, eye, user_id))
    return result


def row_to_dict(r) -> dict:
    keys = r.keys()
    return {
        "id": r["id"], "ts": r["ts"], "device": r["device"], "source": r["source"],
        **image_urls(r["filename"]),
        "grade": r["grade"], "label": r["label"],
        "confidence": r["confidence"], "referable": bool(r["referable"]),
        "p_referable": r["p_referable"],
        "ref_threshold": REF_PROB,
        "probs": json.loads(r["probs"]), "quality": json.loads(r["quality"]),
        "latency_ms": r["latency_ms"],
        "true_grade": r["true_grade"] if "true_grade" in keys else None,
        "is_correct": bool(r["is_correct"]) if "is_correct" in keys and r["is_correct"] is not None else None,
        "screening_id": r["screening_id"] if "screening_id" in keys else None,
        "eye": r["eye"] if "eye" in keys else None,
    }
