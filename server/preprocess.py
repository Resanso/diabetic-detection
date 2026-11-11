"""
Preprocessing gambar fundus retina.

PENTING: file ini dipakai SAMA PERSIS saat training dan saat inferensi di server.
Kalau preprocessing berbeda antara training dan deploy, akurasi model akan turun drastis.
Salin file ini ke folder server/ setiap kali Anda mengubahnya.
"""
import os

# Batas piksel dibaca OpenCV dari header sebelum memori dialokasikan (pertahanan "bom gambar").
os.environ.setdefault("OPENCV_IO_MAX_IMAGE_PIXELS", str(40_000_000))
import cv2
import numpy as np

IMG_SIZE = 224
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def crop_black_border(img: np.ndarray, tol: int = 7) -> np.ndarray:
    """Buang area hitam di sekeliling bola mata."""
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
    mask = gray > tol
    if not mask.any():
        return img
    ys, xs = np.where(mask)
    return img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def ben_graham(img: np.ndarray, size: int = IMG_SIZE) -> np.ndarray:
    """
    Preprocessing ala Ben Graham (juara Kaggle DR 2015):
    crop -> resize -> kurangi blur lokal (menonjolkan pembuluh darah & lesi) -> masker lingkaran.
    Input/Output: RGB uint8.
    """
    img = crop_black_border(img)
    img = cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA)
    blur = cv2.GaussianBlur(img, (0, 0), size / 30)
    img = cv2.addWeighted(img, 4, blur, -4, 128)
    mask = np.zeros((size, size), np.uint8)
    cv2.circle(mask, (size // 2, size // 2), int(size * 0.48), 255, -1)
    return cv2.bitwise_and(img, img, mask=mask)


def standard_preprocess(img: np.ndarray, size: int = IMG_SIZE) -> np.ndarray:
    """
    Standar preprocessing untuk arsitektur ResNet / EfficientNet yang dilatih tanpa Ben Graham:
    crop border hitam -> resize -> masker lingkaran retina.
    """
    img = crop_black_border(img)
    img = cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA)
    mask = np.zeros((size, size), np.uint8)
    cv2.circle(mask, (size // 2, size // 2), int(size * 0.48), 255, -1)
    return cv2.bitwise_and(img, img, mask=mask)


def generate_saliency_heatmap(img_rgb: np.ndarray, size: int = IMG_SIZE) -> str:
    """
    Peta atensi / saliensi visual lesi retina (mikroaneurisma, pendarahan, eksudat).
    Menggunakan CLAHE saluran hijau (green channel) dan perbedaan filter lokal.
    Mengembalikan Data URL base64 JPEG.
    """
    import base64
    img_clean = crop_black_border(img_rgb)
    img_resized = cv2.resize(img_clean, (size, size), interpolation=cv2.INTER_AREA)
    green = img_resized[:, :, 1]
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    cl = clahe.apply(green)
    blur = cv2.GaussianBlur(cl, (15, 15), 0)
    diff = cv2.subtract(blur, cl)
    diff_norm = cv2.normalize(diff, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX)
    heatmap = cv2.applyColorMap(diff_norm, cv2.COLORMAP_JET)
    heatmap_rgb = cv2.cvtColor(heatmap, cv2.COLOR_BGR2RGB)
    overlay = cv2.addWeighted(img_resized, 0.65, heatmap_rgb, 0.35, 0)
    mask = np.zeros((size, size), dtype=np.uint8)
    cv2.circle(mask, (size // 2, size // 2), int(size * 0.48), 255, -1)
    overlay = cv2.bitwise_and(overlay, overlay, mask=mask)
    bgr = cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR)
    _, buf = cv2.imencode('.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return 'data:image/jpeg;base64,' + base64.b64encode(buf).decode('utf-8')


def img_to_base64(img_rgb: np.ndarray) -> str:
    """Konversi citra RGB uint8 ke string Data URL base64 JPEG."""
    import base64
    bgr = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR)
    _, buf = cv2.imencode('.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return 'data:image/jpeg;base64,' + base64.b64encode(buf).decode('utf-8')

def to_model_input(img: np.ndarray) -> np.ndarray:
    """RGB uint8 HWC -> float32 NCHW ternormalisasi (untuk ONNX Runtime)."""
    x = img.astype(np.float32) / 255.0
    x = (x - MEAN) / STD
    return x.transpose(2, 0, 1)[None].astype(np.float32)


MAX_PIXELS = 40_000_000  # 40 MP, di atas kamera HP mana pun untuk foto fundus


def decode_image(data: bytes) -> np.ndarray | None:
    """Bytes JPEG/PNG -> RGB uint8, atau None jika gagal."""
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is not None and img.shape[0] * img.shape[1] > MAX_PIXELS:
        return None
    if img is None:
        return None
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


# Ambang cek kualitas, dikalibrasi pada 3.662 foto APTOS asli (training/quality_calibration.py).
# Hasil kalibrasi: 100% foto APTOS dikenali sebagai fundus, sedangkan 21 foto ESP32 non-fundus
# dan 69 foto yang sudah diolah Ben Graham tidak. Foto fundus dikenali lewat salah satu jalur:
#   1. warna kuat: merah-oranye jelas, atau
#   2. bentuk fundus (lingkaran retina dengan sudut gelap) + warna longgar,
#      untuk foto fundus pucat/kebiruan/monokrom yang jumlahnya ~8% di APTOS.
QC = {
    "min_red_ratio": 0.42,      # R/(R+G+B) jalur warna kuat
    "min_rg_ratio": 1.35,       # R/G jalur warna kuat
    "max_blue_ratio": 0.27,     # B/(R+G+B) jalur warna kuat
    "loose_min_red_ratio": 0.32,  # jalur bentuk: warna longgar
    "loose_min_rg_ratio": 0.95,
    "loose_max_blue_ratio": 0.34,
    "min_dark_corners": 0.6,    # porsi sudut bingkai yang gelap (latar di luar lingkaran retina)
    "min_circularity": 0.65,    # luas area retina / luas lingkaran pembungkusnya
    "min_chroma": 0.12,         # (maks-min kanal)/rata-rata; di bawah ini foto abu-abu
    "min_fov": 0.15,            # porsi bingkai yang terisi retina
    "min_brightness": 35,
    "max_brightness": 200,
    "max_overexposed": 0.08,    # porsi piksel retina yang nyaris putih (silau / pantulan flash)
    "min_sharpness": 6,         # varians Laplacian kanal hijau pada ukuran 512 px (persentil 0,5 APTOS: 6,6)
    "min_contrast": 6,          # simpangan baku kanal hijau (persentil 0,5 APTOS: 6,1)
}


def _fundus_features(img: np.ndarray) -> dict:
    """Ciri sederhana citra, dihitung pada ukuran tetap (sisi terpanjang 512 px) agar tidak bergantung resolusi kamera."""
    h, w = img.shape[:2]
    s = 512 / max(h, w)
    img = cv2.resize(img, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)

    # Area retina = komponen terang terbesar; foto fundus punya latar gelap di luar lingkaran retina
    mask = (cv2.GaussianBlur(gray, (9, 9), 0) > 20).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    fov = np.zeros_like(mask)
    circularity = 0.0
    if contours:
        c = max(contours, key=cv2.contourArea)
        cv2.drawContours(fov, [c], -1, 1, -1)
        _, r = cv2.minEnclosingCircle(c)
        circularity = cv2.contourArea(c) / max(np.pi * r * r, 1.0)
    fov = fov.astype(bool)
    if fov.sum() < 0.02 * fov.size:  # hampir seluruhnya gelap
        fov = np.ones_like(fov)
    inner = cv2.erode(fov.astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
    if not inner.any():
        inner = fov

    r_, g_, b_ = img[fov].reshape(-1, 3).astype(np.float32).mean(0)
    total = r_ + g_ + b_ + 1e-6
    k = max(4, int(0.06 * min(img.shape[:2])))
    corners = np.concatenate([gray[:k, :k].ravel(), gray[:k, -k:].ravel(),
                              gray[-k:, :k].ravel(), gray[-k:, -k:].ravel()])
    green = img[:, :, 1]
    return {
        "red_ratio": float(r_ / total),
        "rg_ratio": float(r_ / (g_ + 1e-6)),
        "blue_ratio": float(b_ / total),
        "chroma": float((max(r_, g_, b_) - min(r_, g_, b_)) / (total / 3)),
        "fov_ratio": float(fov.mean()),
        "circularity": float(circularity),
        "dark_corners": float((corners < 25).mean()),
        "brightness": float(gray[fov].mean()),
        "overexposed": float((gray[fov] > 245).mean()),
        "sharpness": float(cv2.Laplacian(green, cv2.CV_64F)[inner].var()),
        "contrast": float(green[inner].std()),
    }


def quality_check(img: np.ndarray) -> dict:
    """
    Cek apakah foto layak dinilai AI. Kamera ESP32 dan HP sering menghasilkan foto gelap, buram,
    silau, atau bahkan bukan foto retina, dan model tetap memberi prediksi walau fotonya tidak layak.

    is_fundus False berarti AI tidak menilai foto ini (bukan foto retina, atau foto yang sudah diolah).
    ok False berarti foto sebaiknya diulang; hasil AI kurang dapat diandalkan.
    """
    f = _fundus_features(img)
    gray = f["chroma"] < QC["min_chroma"]
    strong_color = (not gray and f["red_ratio"] >= QC["min_red_ratio"]
                    and f["rg_ratio"] >= QC["min_rg_ratio"] and f["blue_ratio"] <= QC["max_blue_ratio"])
    fundus_shape = (f["dark_corners"] >= QC["min_dark_corners"] and f["circularity"] >= QC["min_circularity"]
                    and f["red_ratio"] >= QC["loose_min_red_ratio"] and f["rg_ratio"] >= QC["loose_min_rg_ratio"]
                    and f["blue_ratio"] <= QC["loose_max_blue_ratio"])
    is_fundus = strong_color or fundus_shape
    issues = []
    if not is_fundus:
        issues.append("foto abu-abu: sudah diolah atau bukan foto fundus, unggah foto asli" if gray
                      else "bukan foto fundus retina")
    elif gray:
        issues.append("foto monokrom, warna retina tidak terbaca")
    if f["fov_ratio"] < QC["min_fov"]:
        issues.append("retina terlalu kecil di bingkai")
    if f["brightness"] < QC["min_brightness"]:
        issues.append("terlalu gelap")
    if f["brightness"] > QC["max_brightness"] or f["overexposed"] > QC["max_overexposed"]:
        issues.append("terlalu terang atau silau")
    if f["sharpness"] < QC["min_sharpness"]:
        issues.append("buram")
    if f["contrast"] < QC["min_contrast"]:
        issues.append("kontras rendah")
    return {
        "ok": not issues,
        "is_fundus": is_fundus,
        "issues": issues,
        **{k: round(v, 3 if v < 10 else 1) for k, v in f.items()},
    }
