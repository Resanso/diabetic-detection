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

CAM_SIZE = 640   # sisi peta Fokus AI yang disimpan


def _load_session():
    """Muat model. Bila paket onnx ada dan model berakhir GlobalAveragePool -> (Flatten) -> Gemm (EfficientNet,
    ResNet, dst.), keluaran fitur konvolusi terakhir ditambahkan supaya Fokus AI (CAM) bisa dihitung tanpa
    inferensi kedua. Logits tetap keluaran pertama, jadi pemanggil lama tidak berubah."""
    try:
        import onnx
        from onnx import TensorProto, helper, numpy_helper
        m = onnx.load(MODEL_PATH)
        g = m.graph
        gap = next(n for n in g.node if n.op_type == "GlobalAveragePool")
        gemm = next(n for n in g.node if n.op_type == "Gemm")
        feeds = {gap.output[0]}
        feeds |= {n.output[0] for n in g.node if n.op_type == "Flatten" and n.input[0] == gap.output[0]}
        if gemm.input[0] not in feeds or gemm.output[0] != g.output[0].name:
            raise ValueError("kepala model bukan GAP -> Gemm")
        w = {i.name: numpy_helper.to_array(i) for i in g.initializer}[gemm.input[1]].astype(np.float32)
        if not next((a.i for a in gemm.attribute if a.name == "transB"), 0):
            w = w.T
        if w.shape[0] != len(LABELS):
            raise ValueError(f"bobot klasifikasi {w.shape} tidak cocok dengan {len(LABELS)} kelas")
        g.output.append(helper.make_tensor_value_info(gap.input[0], TensorProto.FLOAT, None))
        sess = ort.InferenceSession(m.SerializeToString(), providers=["CPUExecutionProvider"])
        return sess, w
    except Exception as e:  # tanpa onnx atau arsitektur lain: tetap jalan, tanpa Fokus AI
        print(f"[inference] Fokus AI (CAM) tidak aktif: {e}")
        return ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"]), None


def _load_ensemble():
    """Ensemble EfficientNet-B5 + ConvNeXt-B: keluaran probs (sudah softmax), prep (citra Ben Graham 456 px) dan
    feats (fitur konvolusi terakhir B5). Bobot kelas B5 untuk Fokus AI ada di cam_weights.npy."""
    so = ort.SessionOptions()
    so.enable_cpu_mem_arena = False   # lepas memori aktivasi setelah tiap foto (VPS kecil dipakai bersama)
    sess = ort.InferenceSession(MODEL_PATH, so, providers=["CPUExecutionProvider"])
    path = os.path.join(os.path.dirname(MODEL_PATH), META.get("cam_weights", "cam_weights.npy"))
    if not os.path.isfile(path):
        print(f"[inference] Fokus AI (CAM) tidak aktif: {path} tidak ada")
        return sess, None
    return sess, np.load(path).astype(np.float32)


session, CLS_W = _load_ensemble() if ENSEMBLE else _load_session()
CAM_ENABLED = CLS_W is not None
INPUT_NAME = session.get_inputs()[0].name


def softmax(x):
    e = np.exp(x - x.max())
    return e / e.sum()


ENS_SIZES = [i.shape[1] for i in session.get_inputs()] if ENSEMBLE else []


def crop_square(img: np.ndarray, tol: int = 7) -> np.ndarray:
    """Buang tepi hitam lalu tambal jadi persegi (identik dengan pelatihan ensemble)."""
    c = crop_black_border(img, tol)
    h, w = c.shape[:2]
    s = max(h, w)
    out = np.zeros((s, s, 3), np.uint8)
    out[(s - h) // 2:(s - h) // 2 + h, (s - w) // 2:(s - w) // 2 + w] = c
    return out


def infer(img: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    """Foto RGB -> (probabilitas 5 derajat, citra olahan yang dilihat model (RGB uint8), fitur untuk Fokus AI)."""
    if ENSEMBLE:
        c = crop_square(img)
        feed = {i.name: cv2.resize(c, (i.shape[1], i.shape[1]), interpolation=cv2.INTER_AREA).astype(np.float32)[None]
                for i in session.get_inputs()}
        probs, prep, feats = session.run(["probs", "prep", "feats"], feed)
        return probs[0], np.clip(prep[0], 0, 255).astype(np.uint8), (feats[0] if CAM_ENABLED else None)
    prep_img = preprocess_for_model(img)
    probs, feats = predict(prep_img)
    return probs, prep_img, feats


def preprocess_for_model(img: np.ndarray) -> np.ndarray:
    if PREPROCESS_MODE == "ben_graham":
        return ben_graham(img, MODEL_IMG_SIZE)
    return standard_preprocess(img, MODEL_IMG_SIZE)


def predict_probs(prep_img: np.ndarray) -> np.ndarray:
    return predict(prep_img)[0]


def predict(prep_img: np.ndarray) -> tuple[np.ndarray, np.ndarray | None]:
    """Probabilitas per derajat dan peta fitur konvolusi terakhir (C, h, w), bila Fokus AI aktif."""
    out = session.run(None, {INPUT_NAME: to_model_input(prep_img)})
    return softmax(out[0][0]), (out[1][0] if CAM_ENABLED else None)


def cam_grade(probs) -> int:
    """Derajat yang dijelaskan peta Fokus AI: derajat perkiraan, atau derajat RD paling mungkin bila AI
    memperkirakan 0 (tidak ada 'penyakit' yang bisa dijelaskan dari kelas normal)."""
    probs = np.asarray(probs)
    g = int(probs.argmax())
    return g if g > 0 else int(probs[1:].argmax()) + 1


def make_cam(img: np.ndarray, feats: np.ndarray, probs) -> np.ndarray:
    """Fokus AI: Class Activation Map (Zhou dkk. 2016). Untuk kepala GAP -> linear, CAM sama dengan Grad-CAM pada
    lapisan konvolusi terakhir. Bobot dibuat kontrastif (bobot derajat dikurangi rata-rata semua derajat) supaya
    yang menyala adalah bukti yang membedakan derajat itu, bukan struktur yang dipakai semua kelas (diskus, pembuluh).
    Peta dibatasi ke lingkaran retina dan dinormalkan per foto: menunjukkan letak relatif, bukan besar bukti."""
    t = cam_grade(probs)
    s = CAM_SIZE
    if ENSEMBLE:
        # EfficientNet-B5: bukti derajat t dibanding derajat yang lebih ringan (lebih fokus ke lesi daripada
        # dibanding rata-rata semua derajat). 40% sel terlemah dibuang supaya hanya area kuat yang tampil.
        w = CLS_W[t] - CLS_W[:t].mean(0)
        cam = np.maximum(np.tensordot(w, feats, axes=1), 0).astype(np.float32)
        cam = np.maximum(cam - np.percentile(cam, 60), 0)
        cam = cv2.resize(cam, (s, s), interpolation=cv2.INTER_CUBIC)
        sq = cv2.resize(crop_square(img), (s, s), interpolation=cv2.INTER_AREA)
        mask = (cv2.cvtColor(sq, cv2.COLOR_RGB2GRAY) > 7).astype(np.float32)   # hanya piksel retina, bukan tambalan
        mask = cv2.GaussianBlur(cv2.erode(mask, np.ones((15, 15), np.uint8)), (0, 0), s / 60)
    else:
        w = CLS_W[t] - CLS_W.mean(0)
        cam = np.maximum(np.tensordot(w, feats, axes=1), 0).astype(np.float32)
        cam = cv2.resize(cam, (s, s), interpolation=cv2.INTER_CUBIC)
        mask = np.zeros((s, s), np.float32)
        cv2.circle(mask, (s // 2, s // 2), int(s * 0.46), 1.0, -1)
        mask = cv2.GaussianBlur(mask, (0, 0), s / 40)   # tepi lembut
    cam = np.clip(cam * mask, 0, None)
    cam = cam / (cam.max() + 1e-6)
    base = cv2.resize(crop_square(img) if ENSEMBLE else crop_black_border(img), (s, s),
                      interpolation=cv2.INTER_AREA).astype(np.float32)
    heat = cv2.applyColorMap((cam * 255).astype(np.uint8), cv2.COLORMAP_JET)[:, :, ::-1].astype(np.float32)
    # di bawah 25% puncak tidak diwarnai, supaya foto asli tetap terbaca dan hanya area kuat yang menonjol
    a = (np.clip((cam - 0.25) / 0.75, 0, 1) ** 0.8 * 0.65)[..., None]
    return (base * (1 - a) + heat * a).astype(np.uint8)


def ensure_cam(rid: str, filename: str, probs) -> bool:
    """Buat peta Fokus AI untuk foto lama yang belum punya. Mengembalikan True bila berkas tersedia."""
    path = os.path.join(IMG_DIR, f"{rid}_cam.jpg")
    if os.path.isfile(path):
        return True
    if not CAM_ENABLED:
        return False
    try:
        with open(os.path.join(IMG_DIR, os.path.basename(filename)), "rb") as f:
            img = decode_image(f.read())
    except FileNotFoundError:
        return False
    if img is None:
        return False
    p, _, feats = infer(img)
    _write_jpeg(path, make_cam(img, feats, p))
    return True


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
        "cam_url": f"/images/{stem}_cam.jpg" if CAM_ENABLED else None,
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
    probs, prep_img, feats = infer(img)
    latency = (time.perf_counter() - t0) * 1000

    grade = int(probs.argmax())
    p_ref = float(probs[REF_GRADE:].sum())
    rid = uuid.uuid4().hex[:12]
    ext = "png" if data[:8] == b"\x89PNG\r\n\x1a\n" else "jpg"
    filename = f"{rid}.{ext}"

    # Simpan ulang dari piksel hasil decode, bukan byte asli: metadata EXIF (lokasi GPS, merek HP, waktu)
    # ikut terbuang. Prinsip minimisasi data UU PDP.
    bgr = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    ok, buf = (cv2.imencode(".png", bgr) if ext == "png"
               else cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 95]))
    with open(os.path.join(IMG_DIR, filename), "wb") as f:
        f.write(buf.tobytes() if ok else data)
    # Versi olahan dan peta atensi disimpan sebagai file agar dokter bisa membukanya kapan saja.
    _write_jpeg(os.path.join(IMG_DIR, f"{rid}_prep.jpg"), prep_img)
    _write_data_url(os.path.join(IMG_DIR, f"{rid}_heat.jpg"), generate_saliency_heatmap(img, MODEL_IMG_SIZE))
    if feats is not None:
        _write_jpeg(os.path.join(IMG_DIR, f"{rid}_cam.jpg"), make_cam(img, feats, probs))

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
        "cam_grade": cam_grade(probs) if feats is not None else None,
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
        "cam_grade": cam_grade(json.loads(r["probs"])) if CAM_ENABLED else None,
        "latency_ms": r["latency_ms"],
        "true_grade": r["true_grade"] if "true_grade" in keys else None,
        "is_correct": bool(r["is_correct"]) if "is_correct" in keys and r["is_correct"] is not None else None,
        "screening_id": r["screening_id"] if "screening_id" in keys else None,
        "eye": r["eye"] if "eye" in keys else None,
    }
