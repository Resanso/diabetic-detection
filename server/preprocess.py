"""
Preprocessing gambar fundus retina.

PENTING: file ini dipakai SAMA PERSIS saat training dan saat inferensi di server.
Kalau preprocessing berbeda antara training dan deploy, akurasi model akan turun drastis.
Salin file ini ke folder server/ setiap kali Anda mengubahnya.
"""
import cv2
import numpy as np

IMG_SIZE = 320
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


def to_model_input(img: np.ndarray) -> np.ndarray:
    """RGB uint8 HWC -> float32 NCHW ternormalisasi (untuk ONNX Runtime)."""
    x = img.astype(np.float32) / 255.0
    x = (x - MEAN) / STD
    return x.transpose(2, 0, 1)[None].astype(np.float32)


def decode_image(data: bytes) -> np.ndarray | None:
    """Bytes JPEG/PNG -> RGB uint8, atau None jika gagal."""
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return None
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def quality_check(img: np.ndarray) -> dict:
    """
    Cek kualitas sederhana. Kamera ESP32 sering menghasilkan gambar gelap/blur,
    dan model akan tetap memberi prediksi walau gambarnya tidak layak.
    """
    gray = cv2.cvtColor(crop_black_border(img), cv2.COLOR_RGB2GRAY)
    # Statistik dihitung hanya di area retina; latar hitam di sekeliling bola mata
    # akan menurunkan rata-rata kecerahan dan tepi lingkarannya menaikkan nilai Laplacian.
    mask = cv2.erode((gray > 7).astype(np.uint8), np.ones((15, 15), np.uint8)).astype(bool)
    if mask.sum() < 0.05 * mask.size:
        mask = np.ones_like(mask)
    brightness = float(gray[mask].mean())
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F)[mask].var())
    issues = []
    if brightness < 25:
        issues.append("terlalu gelap")
    if brightness > 220:
        issues.append("terlalu terang")
    if sharpness < 15:
        issues.append("buram")
    return {
        "ok": not issues,
        "issues": issues,
        "brightness": round(brightness, 1),
        "sharpness": round(sharpness, 1),
    }
