"""Klien BPJS Kesehatan VClaim untuk cek kepesertaan (nomor kartu atau NIK).

Butuh kredensial faskes dari BPJS (cons-id, secret key, user key). Tanpa kredensial, `configured()` bernilai
False dan aplikasi hanya menyimpan nomor kartu dengan status "belum_dicek".

Protokol VClaim v2:
  - Header X-cons-id, X-timestamp (detik UTC), X-signature = base64(HMAC-SHA256(f"{cons_id}&{ts}", secret)),
    user_key.
  - Isi `response` terenkripsi AES-256-CBC. Kunci = SHA-256(cons_id + secret + ts), IV = 16 byte pertama kunci.
    Hasil dekripsi dikompres LZString (decompressFromEncodedURIComponent), isinya JSON.
"""
import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request

CONS_ID = os.getenv("BPJS_CONS_ID", "")
SECRET = os.getenv("BPJS_SECRET", "")
USER_KEY = os.getenv("BPJS_USER_KEY", "")
# Bawaan ke server pengembangan BPJS. Produksi: https://apijkn.bpjs-kesehatan.go.id/vclaim-rest
BASE_URL = os.getenv("BPJS_BASE_URL", "https://apijkn-dev.bpjs-kesehatan.go.id/vclaim-rest-dev").rstrip("/")
TIMEOUT = 10


class BpjsError(Exception):
    pass


def configured() -> bool:
    return bool(CONS_ID and SECRET and USER_KEY)


def _headers(ts: str) -> dict:
    sig = hmac.new(SECRET.encode(), f"{CONS_ID}&{ts}".encode(), hashlib.sha256).digest()
    return {
        "X-cons-id": CONS_ID,
        "X-timestamp": ts,
        "X-signature": base64.b64encode(sig).decode(),
        "user_key": USER_KEY,
        "Accept": "application/json",
    }


def _decrypt(payload: str, ts: str):
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    import lzstring

    key = hashlib.sha256(f"{CONS_ID}{SECRET}{ts}".encode()).digest()
    decryptor = Cipher(algorithms.AES(key), modes.CBC(key[:16])).decryptor()
    raw = decryptor.update(base64.b64decode(payload)) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    raw = unpadder.update(raw) + unpadder.finalize()
    text = lzstring.LZString().decompressFromEncodedURIComponent(raw.decode())
    return json.loads(text)


def _get(path: str):
    ts = str(int(time.time()))
    req = urllib.request.Request(f"{BASE_URL}{path}", headers=_headers(ts))
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = json.loads(r.read().decode())
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise BpjsError(f"Server BPJS tidak bisa dihubungi ({e}).") from e
    meta = body.get("metaData") or body.get("metadata") or {}
    if str(meta.get("code")) != "200":
        raise BpjsError(meta.get("message") or "BPJS menolak permintaan.")
    resp = body.get("response")
    return _decrypt(resp, ts) if isinstance(resp, str) else resp


def check_participant(*, card_no: str | None = None, nik: str | None = None) -> dict:
    """Cek status peserta hari ini. Mengembalikan ringkasan yang aman disimpan."""
    today = dt.date.today().isoformat()
    if card_no:
        data = _get(f"/Peserta/nokartu/{card_no}/tglSEP/{today}")
    elif nik:
        data = _get(f"/Peserta/nik/{nik}/tglSEP/{today}")
    else:
        raise BpjsError("Isi nomor kartu BPJS atau NIK.")
    p = (data or {}).get("peserta") or {}
    status = (p.get("statusPeserta") or {})
    return {
        "card_no": p.get("noKartu"),
        "name": p.get("nama"),
        "active": str(status.get("kode")) == "0",
        "status_text": status.get("keterangan"),
        "class": (p.get("hakKelas") or {}).get("keterangan"),
        "faskes": (p.get("provUmum") or {}).get("nmProvider"),
    }
