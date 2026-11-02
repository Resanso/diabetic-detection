"""Perangkat ESP32-CAM: status online, perintah ambil foto, pengaturan kamera, dan unggah foto.

Status perangkat dan permintaan foto disimpan di memori: cukup untuk satu proses server, hilang saat restart.
Pengaturan kamera disimpan di file agar tetap ada setelah restart.
"""
import json
import os
import time
import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from auth import current_user, device_or_staff, require_role
from database import DATA_DIR, db
from inference import row_to_dict, run_inference

router = APIRouter()

MAX_BYTES = 10 * 1024 * 1024
DEVICE_ONLINE_SEC = 10        # dianggap offline jika tidak polling selama ini
CAPTURE_TIMEOUT_SEC = 30      # perintah foto yang belum diambil perangkat dianggap kedaluwarsa
UPLOAD_TIMEOUT_SEC = 60       # foto yang tidak kunjung terkirim setelah perintah diambil dianggap gagal

DEVICES: dict[str, dict] = {}
# Permintaan foto dari layar pemeriksaan: {request_id: {status, device, screening_id, eye, user_id, ts, result_id}}
CAPTURES: dict[str, dict] = {}


def touch_device(device_id: str, ip: str | None) -> dict:
    dev = DEVICES.setdefault(device_id, {"capture_requested_at": None, "applied_version": None,
                                         "pending": None, "inflight": None})
    dev["last_seen"] = time.time()
    dev["ip"] = ip
    return dev


async def read_limited(request: Request) -> bytes:
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > MAX_BYTES:
            raise HTTPException(413, "Ukuran file melebihi batas maksimum 10 MB.")
    return bytes(buf)


# --- Pengaturan kamera ---

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


# --- Endpoint yang dipanggil ESP32 ---

@router.get("/api/device/poll", dependencies=[Depends(device_or_staff)])
def device_poll(request: Request, x_device_id: str = Header("unknown"),
                x_settings_version: int | None = Header(None)):
    """Dipanggil ESP32 tiap ~1,5 detik. Mengembalikan capture=true jika ada permintaan foto,
    beserta pengaturan kamera terbaru (ESP32 menerapkannya jika versinya berubah)."""
    dev = touch_device(x_device_id, request.client.host if request.client else None)
    dev["applied_version"] = x_settings_version
    req = dev["capture_requested_at"]
    capture = req is not None and time.time() - req < CAPTURE_TIMEOUT_SEC
    dev["capture_requested_at"] = None
    if capture and dev["pending"]:
        # Foto berikutnya dari perangkat ini milik permintaan tersebut.
        dev["inflight"] = {"request_id": dev["pending"], "ts": time.time()}
        CAPTURES[dev["pending"]]["status"] = "memotret"
    dev["pending"] = None
    return {"capture": capture, "settings": settings_for(x_device_id)}


@router.post("/api/predict", dependencies=[Depends(device_or_staff)])
async def predict_raw(request: Request, x_device_id: str = Header("unknown")):
    """Untuk ESP32: body = bytes JPEG mentah."""
    data = await read_limited(request)
    dev = touch_device(x_device_id, request.client.host if request.client else None)

    capture = None
    inflight = dev.get("inflight")
    dev["inflight"] = None
    if inflight and time.time() - inflight["ts"] < UPLOAD_TIMEOUT_SEC:
        capture = CAPTURES.get(inflight["request_id"])

    try:
        full = await run_in_threadpool(
            run_inference, data, x_device_id, "esp32", None,
            capture["screening_id"] if capture else None,
            capture["eye"] if capture else None,
            capture["user_id"] if capture else None)
    except HTTPException as e:
        if capture:
            capture.update(status="gagal", error=e.detail)
        raise
    if capture:
        capture.update(status="selesai", result_id=full["id"])
    return {
        "id": full["id"],
        "grade": full["grade"],
        "label": full["label"],
        "confidence": full["confidence"],
        "referable": full["referable"],
        "p_referable": full["p_referable"],
        "quality_ok": full["quality"]["ok"],
        "is_fundus": full["quality"].get("is_fundus", True),
        "quality_issues": full["quality"]["issues"],
    }


# --- Endpoint untuk staf ---

def device_summary(device_id: str, dev: dict, now: float) -> dict:
    req = dev["capture_requested_at"]
    return {
        "id": device_id,
        "ip": dev["ip"],
        "last_seen": dev["last_seen"],
        "online": now - dev["last_seen"] <= DEVICE_ONLINE_SEC,
        "capture_pending": req is not None and now - req < CAPTURE_TIMEOUT_SEC,
        "settings_version": settings_for(device_id)["version"],
        "applied_version": dev.get("applied_version"),
    }


@router.get("/api/devices")
def list_devices(user: dict = Depends(current_user)):
    now = time.time()
    out = []
    with db() as conn:
        for device_id, dev in DEVICES.items():
            item = device_summary(device_id, dev, now)
            if user["role"] == "admin":
                row = conn.execute("SELECT * FROM results WHERE device=? ORDER BY ts DESC LIMIT 1",
                                   (device_id,)).fetchone()
                item["latest"] = row_to_dict(row) if row else None
            out.append(item)
    return sorted(out, key=lambda d: d["last_seen"], reverse=True)


@router.get("/api/devices/{device_id}/settings", dependencies=[Depends(current_user)])
def get_device_settings(device_id: str):
    return settings_for(device_id)


@router.put("/api/devices/{device_id}/settings", dependencies=[Depends(require_role("admin", "perawat", "dokter"))])
def put_device_settings(device_id: str, body: CameraSettings):
    version = settings_for(device_id)["version"] + 1
    DEVICE_SETTINGS[device_id] = {"version": version, **body.model_dump()}
    tmp = SETTINGS_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(DEVICE_SETTINGS, f, indent=2)
    os.replace(tmp, SETTINGS_PATH)
    return DEVICE_SETTINGS[device_id]


def request_capture(device_id: str, screening_id: str | None = None, eye: str | None = None,
                    user_id: int | None = None) -> str:
    dev = DEVICES.get(device_id)
    if not dev or time.time() - dev["last_seen"] > DEVICE_ONLINE_SEC:
        raise HTTPException(409, f"Perangkat {device_id} sedang offline. Pastikan ESP32 menyala dan terhubung WiFi.")
    if dev["pending"] or (dev["inflight"] and time.time() - dev["inflight"]["ts"] < UPLOAD_TIMEOUT_SEC):
        raise HTTPException(409, "Perangkat sedang memproses foto lain. Tunggu sebentar.")
    request_id = uuid.uuid4().hex[:12]
    now = time.time()
    # Bersihkan permintaan lama agar memori tidak tumbuh terus.
    for k in [k for k, c in CAPTURES.items() if now - c["ts"] > 3600]:
        del CAPTURES[k]
    CAPTURES[request_id] = {"status": "menunggu", "device": device_id, "screening_id": screening_id,
                            "eye": eye, "user_id": user_id, "ts": now, "result_id": None, "error": None}
    dev["capture_requested_at"] = now
    dev["pending"] = request_id
    return request_id


@router.post("/api/devices/{device_id}/capture")
def capture_now(device_id: str, user: dict = Depends(require_role("admin", "perawat", "dokter"))):
    """Foto uji tanpa pemeriksaan (dari layar Perangkat)."""
    return {"ok": True, "request_id": request_capture(device_id, user_id=user["id"])}


@router.get("/api/captures/{request_id}", dependencies=[Depends(current_user)])
def capture_status(request_id: str):
    cap = CAPTURES.get(request_id)
    if cap is None:
        raise HTTPException(404, "Permintaan foto tidak ditemukan.")
    now = time.time()
    if cap["status"] == "menunggu" and now - cap["ts"] > CAPTURE_TIMEOUT_SEC:
        cap.update(status="gagal", error="Perangkat tidak merespons. Periksa koneksi ESP32 lalu coba lagi.")
    if cap["status"] == "memotret" and now - cap["ts"] > CAPTURE_TIMEOUT_SEC + UPLOAD_TIMEOUT_SEC:
        cap.update(status="gagal", error="Foto tidak sampai ke server. Coba lagi.")
    out = {"status": cap["status"], "error": cap["error"], "result": None}
    if cap["result_id"]:
        with db() as conn:
            row = conn.execute("SELECT * FROM results WHERE id=?", (cap["result_id"],)).fetchone()
        out["result"] = row_to_dict(row) if row else None
    return out
