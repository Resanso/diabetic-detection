"""Deskripsi pemeriksaan dengan model bahasa multimodal lokal (llama.cpp llama-server, mis. Qwen + mmproj).

Model klasifikasi (EfficientNet-B0) tetap penentu perkiraan derajat; model bahasa hanya menulis:
  - temuan visual per mata dari foto (mikroaneurisma, perdarahan, eksudat, dll.), untuk dokter
  - ringkasan kasus untuk dokter: hasil AI, kualitas foto, data klinis
  - penjelasan bahasa awam untuk pasien/perawat, hanya setelah dokter membaca (berdasarkan keputusan dokter)
Semua data tetap di laptop/server ini; tidak ada yang dikirim ke layanan luar.

LLM_URL (bawaan http://127.0.0.1:8081), LLM_AUTO=1 membuat deskripsi otomatis saat pemeriksaan dikirim ke dokter
dan diperbarui setelah dokter menyimpan bacaan.
"""
import base64
import json
import os
import threading
import time
import urllib.error
import urllib.request

import cv2
from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import current_user
from database import IMG_DIR, db

LLM_URL = os.getenv("LLM_URL", "http://127.0.0.1:8081").rstrip("/")
AUTO = os.getenv("LLM_AUTO", "1") == "1"
TIMEOUT = int(os.getenv("LLM_TIMEOUT", "300"))
IMG_MAX = 896   # sisi terpanjang foto yang dikirim ke model; cukup untuk lesi besar, hemat token

GRADE = ["tidak ada retinopati diabetik", "NPDR ringan", "NPDR sedang", "NPDR berat", "retinopati diabetik proliferatif"]
DECISION = {
    "rujuk_segera": "rujuk segera ke dokter spesialis mata (dalam 1 minggu)",
    "rujuk": "rujuk terjadwal ke dokter spesialis mata (1 sampai 3 bulan)",
    "rujuk_lain": "rujuk ke dokter mata karena kelainan mata lain",
    "ulang_6": "skrining ulang 6 bulan lagi",
    "ulang_12": "skrining ulang 12 bulan lagi",
    "normal": "normal, tidak perlu tindak lanjut khusus",
    "foto_ulang": "foto retina perlu diulang",
}
GLUCOSE_KIND = {"puasa": "puasa", "sewaktu": "sewaktu", "2jpp": "2 jam setelah makan"}

router = APIRouter()
_lock = threading.Lock()   # satu model di satu laptop: kerjakan satu per satu
_info: dict = {"checked": 0.0, "ok": False, "vision": False, "model": None}


class LlmError(Exception):
    pass


def status(force: bool = False) -> dict:
    """Cek llama-server (di-cache 30 detik)."""
    if force or time.time() - _info["checked"] > 30:
        try:
            with urllib.request.urlopen(f"{LLM_URL}/props", timeout=3) as r:
                d = json.loads(r.read().decode(), strict=False)
            _info.update(ok=True, vision=bool((d.get("modalities") or {}).get("vision")),
                         model=os.path.basename(d.get("model_path") or "") or None)
        except (urllib.error.URLError, OSError, ValueError):
            _info.update(ok=False, vision=False, model=None)
        _info["checked"] = time.time()
    return {"available": _info["ok"], "vision": _info["vision"], "model": _info["model"], "auto": AUTO}


def _image_part(filename: str) -> dict | None:
    img = cv2.imread(os.path.join(IMG_DIR, os.path.basename(filename)))
    if img is None:
        return None
    h, w = img.shape[:2]
    scale = IMG_MAX / max(h, w)
    if scale < 1:
        img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(buf).decode()}} if ok else None


def _facts(s, p, images) -> str:
    lines = []
    sex = {"L": "laki-laki", "P": "perempuan"}.get(p["sex"] or "", "")
    dm = {"tipe1": "diabetes tipe 1", "tipe2": "diabetes tipe 2", "gestasional": "diabetes gestasional",
          "tidak": "bukan penyandang diabetes", "tidak_tahu": "status diabetes belum diketahui"}.get(p["diabetes_type"] or "", "")
    lines.append("Pasien: " + ", ".join(x for x in (sex, p["birth_date"] and f"lahir {p['birth_date']}", dm,
                                                       p["diabetes_since"] and f"diabetes sejak {p['diabetes_since']}") if x))
    if s["glucose"] is not None:
        lines.append(f"Gula darah {GLUCOSE_KIND.get(s['glucose_kind'], '')}: {s['glucose']:g} mg/dL")
    if s["hba1c"] is not None:
        lines.append(f"HbA1c: {s['hba1c']:g}%")
    if s["systolic"]:
        lines.append(f"Tekanan darah: {s['systolic']}/{s['diastolic']} mmHg")
    if s["va_right"] or s["va_left"]:
        lines.append(f"Visus kanan {s['va_right'] or '-'}, kiri {s['va_left'] or '-'}")
    if s["complaints"]:
        lines.append(f"Keluhan: {s['complaints']}")
    for eye in ("kanan", "kiri"):
        r = images.get(eye)
        if r is None:
            lines.append(f"Mata {eye}: tidak difoto")
            continue
        q = json.loads(r["quality"] or "{}")
        if q.get("is_fundus") is False:
            lines.append(f"Mata {eye}: foto tidak dikenali sebagai fundus, AI tidak menilai")
            continue
        qual = "baik" if q.get("ok", True) else "kurang (" + ", ".join(q.get("issues") or []) + ")"
        lines.append(f"Mata {eye}: model klasifikasi AI memperkirakan derajat {r['grade']} ({GRADE[r['grade']]}), "
                     f"peluang perlu rujukan {round((r['p_referable'] or 0) * 100)}%, kualitas foto {qual}")
    if s["status"] == "dibaca":
        def g(v):
            return "tidak dinilai" if v is None else f"derajat {v} ({GRADE[v]})"
        lines.append(f"BACAAN DOKTER (keputusan resmi): mata kanan {g(s['dr_grade_right'])}, mata kiri {g(s['dr_grade_left'])}, "
                     f"edema makula {'dicurigai' if s['dr_dme'] else 'tidak tampak' if s['dr_dme'] is not None else 'tidak dinilai'}, "
                     f"tindak lanjut: {DECISION.get(s['decision'], s['decision'])}"
                     + (f", catatan dokter: {s['doctor_notes']}" if s["doctor_notes"] else ""))
    return "\n".join(lines)


SYSTEM = (
    "Anda asisten skrining retinopati diabetik di klinik Indonesia. Tulis dalam bahasa Indonesia yang jelas dan singkat. "
    "Jangan mengubah derajat dari model AI atau dokter, jangan membuat diagnosis baru, jangan menyebut obat atau dosis. "
    "Jika foto kurang jelas, katakan apa adanya. Bila ada bacaan dokter, itulah keputusan resmi."
)


def _schema(with_patient: bool) -> dict:
    props = {
        "mata_kanan": {"type": "string"},
        "mata_kiri": {"type": "string"},
        "ringkasan_dokter": {"type": "string"},
    }
    if with_patient:
        props["penjelasan_pasien"] = {"type": "string"}
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def _ask(content: list, with_patient: bool) -> dict:
    body = {
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": content}],
        "temperature": 0.2,
        "max_tokens": 900,
        "chat_template_kwargs": {"enable_thinking": False},
        "response_format": {"type": "json_schema", "json_schema": {"name": "deskripsi", "schema": _schema(with_patient)}},
    }
    req = urllib.request.Request(f"{LLM_URL}/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            d = json.loads(r.read().decode(), strict=False)
    except urllib.error.HTTPError as e:
        raise LlmError(f"llama-server menolak permintaan (kode {e.code}): {e.read().decode()[:200]}") from e
    except (urllib.error.URLError, OSError) as e:
        raise LlmError(f"llama-server tidak bisa dihubungi di {LLM_URL} ({getattr(e, 'reason', e)}).") from e
    text = d["choices"][0]["message"].get("content") or ""
    try:
        return json.loads(text, strict=False)
    except ValueError as e:
        raise LlmError("Jawaban model bukan JSON yang valid.") from e


def describe(screening_id: str) -> dict:
    with db() as conn:
        s = conn.execute("SELECT * FROM screenings WHERE id=?", (screening_id,)).fetchone()
        if s is None:
            raise LlmError("Pemeriksaan tidak ditemukan.")
        p = conn.execute("SELECT * FROM patients WHERE id=?", (s["patient_id"],)).fetchone()
        images = {}
        for r in conn.execute("SELECT * FROM results WHERE screening_id=? ORDER BY ts", (screening_id,)).fetchall():
            images[r["eye"]] = r   # foto terakhir per mata
    st = status(force=True)
    if not st["available"]:
        raise LlmError(f"llama-server tidak berjalan di {LLM_URL}.")
    read = s["status"] == "dibaca"
    content: list = []
    if st["vision"]:
        for eye in ("kanan", "kiri"):
            part = images.get(eye) and _image_part(images[eye]["filename"])
            if part:
                content += [{"type": "text", "text": f"Foto fundus mata {eye}:"}, part]
    content.append({"type": "text", "text": (
        "Data pemeriksaan:\n" + _facts(s, p, images) + "\n\nIsi JSON:\n"
        + ("- mata_kanan dan mata_kiri: temuan visual pada foto mata itu (mikroaneurisma, perdarahan, eksudat keras, "
           "cotton wool spot, neovaskularisasi, kondisi makula dan diskus optik). Sebutkan yang terlihat dan yang tidak "
           "terlihat, maksimal 3 kalimat. Tulis 'Tidak difoto.' bila tidak ada fotonya.\n" if st["vision"] else
           "- mata_kanan dan mata_kiri: tulis 'Foto tidak dibaca model bahasa.'\n")
        + "- ringkasan_dokter: 2 sampai 4 kalimat untuk dokter: hasil AI per mata, kualitas foto, faktor risiko dari data "
          "klinis (gula darah, HbA1c, tekanan darah, visus), dan apakah temuan visual sejalan dengan perkiraan AI.\n"
        + ("- penjelasan_pasien: 3 sampai 5 kalimat bahasa awam untuk pasien, berdasarkan BACAAN DOKTER: apa artinya bagi "
           "matanya, apa yang perlu dilakukan berikutnya, dan pesan menjaga gula darah serta tekanan darah. Tanpa istilah "
           "Latin, sapa dengan 'Anda'.\n" if read else ""))})
    t0 = time.time()
    out = _ask(content, read)
    return {"text": out, "vision": st["vision"], "model": st["model"], "seconds": round(time.time() - t0, 1),
            "with_patient": read}


def run(screening_id: str):
    with _lock:
        try:
            res = describe(screening_id)
            state = ("selesai", json.dumps(res, ensure_ascii=False), None)
        except LlmError as e:
            state = ("gagal", None, str(e))
        except Exception as e:  # jangan biarkan status menggantung
            state = ("gagal", None, f"Galat tak terduga: {e}")
        with db() as conn:
            if state[1] is None:
                conn.execute("UPDATE screenings SET llm_status=?, llm_error=? WHERE id=?", (state[0], state[2], screening_id))
            else:
                conn.execute("UPDATE screenings SET llm_status=?, llm_result=?, llm_error=NULL, llm_at=? WHERE id=?",
                             (state[0], state[1], time.time(), screening_id))


def queue(conn, screening_id: str, auto: bool = True) -> bool:
    """Tandai antre di transaksi pemanggil; jalankan dengan start() setelah commit."""
    if auto and not AUTO:
        return False
    if not status()["available"]:
        return False
    conn.execute("UPDATE screenings SET llm_status='membuat', llm_error=NULL WHERE id=?", (screening_id,))
    return True


def start(screening_id: str):
    threading.Thread(target=run, args=(screening_id,), daemon=True).start()


def state_for(s, user: dict, can_see_ai: bool) -> dict | None:
    """Deskripsi yang boleh dilihat peran ini. Perawat/pasien hanya melihat penjelasan setelah dokter membaca."""
    if not s["llm_status"]:
        return {"status": None, "available": status()["available"]} if user["role"] in ("dokter", "admin") else None
    res = json.loads(s["llm_result"]) if s["llm_result"] else None
    text = (res or {}).get("text") or {}
    out = {"status": s["llm_status"], "error": s["llm_error"], "at": s["llm_at"],
           "model": (res or {}).get("model"), "vision": (res or {}).get("vision"), "available": True}
    if can_see_ai:
        out.update(mata_kanan=text.get("mata_kanan"), mata_kiri=text.get("mata_kiri"),
                   ringkasan_dokter=text.get("ringkasan_dokter"))
    out["penjelasan_pasien"] = text.get("penjelasan_pasien") if s["status"] == "dibaca" else None
    if not can_see_ai and not out["penjelasan_pasien"] and s["llm_status"] == "selesai":
        return None
    return out


@router.get("/api/llm/status", dependencies=[Depends(current_user)])
def llm_status():
    return {**status(force=True), "url": LLM_URL}


@router.post("/api/screenings/{screening_id}/llm")
async def regenerate(screening_id: str, user: dict = Depends(current_user)):
    if user["role"] not in ("dokter", "admin", "perawat"):
        raise HTTPException(403, "Peran Anda tidak memiliki akses ke fitur ini.")
    with db() as conn:
        s = conn.execute("SELECT status FROM screenings WHERE id=?", (screening_id,)).fetchone()
        if s is None:
            raise HTTPException(404, "Pemeriksaan tidak ditemukan.")
        if s["status"] == "draf":
            raise HTTPException(409, "Kirim pemeriksaan ke dokter dulu.")
        if user["role"] == "perawat" and s["status"] != "dibaca":
            raise HTTPException(409, "Penjelasan untuk pasien dibuat setelah dokter membaca.")
        if not queue(conn, screening_id, auto=False):
            raise HTTPException(503, f"llama-server tidak berjalan di {LLM_URL}.")
    start(screening_id)
    return {"status": "membuat"}
