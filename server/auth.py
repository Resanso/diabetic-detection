"""Akun staf (perawat, dokter, admin) dan pasien, sesi cookie, dan kunci perangkat ESP32.

Aturan akses: `current_user` hanya menerima staf, sehingga semua endpoint klinis tertutup untuk akun pasien
kecuali yang secara eksplisit memakai `any_user` atau `require_patient`."""
import hashlib
import os
import secrets
import time

from fastapi import Cookie, Depends, Header, HTTPException

from database import db

SESSION_COOKIE = "retinova_session"
SESSION_TTL = 14 * 24 * 3600                                # batas mutlak
SESSION_IDLE = int(os.getenv("SESSION_IDLE_HOURS", "12")) * 3600   # keluar otomatis bila tidak aktif
STAFF_ROLES = ("perawat", "dokter", "admin")
ROLES = (*STAFF_ROLES, "pasien")

# Kunci untuk perangkat ESP32 (header X-API-Key). Kosong = endpoint perangkat TERTUTUP bagi perangkat (hanya staf
# yang sudah masuk), kecuali DEVICE_OPEN=1 untuk percobaan di jaringan lokal.
DEVICE_KEY = os.getenv("DEVICE_KEY", os.getenv("API_KEY", ""))
DEVICE_OPEN = os.getenv("DEVICE_OPEN", "0") == "1"

# Pembatas percobaan login (di memori): per pasangan akun+IP, sehingga penyerang dari satu IP tidak bisa mengunci
# akun orang lain dari IP lain, dan per IP untuk menahan tebakan satu kata sandi ke banyak akun.
_FAILED: dict[str, list[float]] = {}
MAX_FAILS, FAIL_WINDOW = 5, 300
MAX_FAILS_PER_IP = 20


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
    return secrets.compare_digest(digest.hex(), digest_hex)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _recent(key: str) -> list[float]:
    now = time.time()
    fails = [t for t in _FAILED.get(key, []) if now - t < FAIL_WINDOW]
    _FAILED[key] = fails
    return fails


def check_login_allowed(username: str, ip: str = "?"):
    if len(_recent(f"u:{username.lower()}|{ip}")) >= MAX_FAILS or len(_recent(f"ip:{ip}")) >= MAX_FAILS_PER_IP:
        raise HTTPException(429, "Terlalu banyak percobaan masuk. Coba lagi dalam 5 menit.")


def record_login_failure(username: str, ip: str = "?"):
    for key in (f"u:{username.lower()}|{ip}", f"ip:{ip}"):
        _FAILED.setdefault(key, []).append(time.time())


def clear_login_failures(username: str, ip: str = "?"):
    _FAILED.pop(f"u:{username.lower()}|{ip}", None)


# Hash pembanding untuk nama pengguna yang tidak ada, supaya waktu jawaban tidak membocorkan akun mana yang ada
_DUMMY_HASH = None


def verify_or_dummy(password: str, stored: str | None) -> bool:
    global _DUMMY_HASH
    if stored is None:
        _DUMMY_HASH = _DUMMY_HASH or hash_password(secrets.token_hex(8))
        verify_password(password, _DUMMY_HASH)
        return False
    return verify_password(password, stored)


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        conn.execute("DELETE FROM sessions WHERE last_seen IS NOT NULL AND last_seen < ?", (now - SESSION_IDLE,))
        conn.execute("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen) VALUES (?,?,?,?,?)",
                     (_token_hash(token), user_id, now, now + SESSION_TTL, now))
        conn.execute("UPDATE users SET last_login=? WHERE id=?", (now, user_id))
    return token


def delete_other_sessions(user_id: int, keep_token: str | None):
    """Setelah kata sandi diganti, semua sesi lain (perangkat lain) harus masuk ulang."""
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?",
                     (user_id, _token_hash(keep_token) if keep_token else ""))


def delete_session(token: str | None):
    if token:
        with db() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash=?", (_token_hash(token),))


def public_user(row) -> dict:
    return {
        "id": row["id"], "username": row["username"], "full_name": row["full_name"],
        "role": row["role"], "active": bool(row["active"]),
        "created_at": row["created_at"], "last_login": row["last_login"],
        "patient_id": row["patient_id"],
        "nik": row["nik"] if "nik" in row.keys() else None,
        "satusehat_linked": bool(row["ihs_number"]) if "ihs_number" in row.keys() else False,
    }


def optional_user(retinova_session: str | None = Cookie(None)) -> dict | None:
    if not retinova_session:
        return None
    now = time.time()
    th = _token_hash(retinova_session)
    with db() as conn:
        row = conn.execute(
            "SELECT u.*, s.last_seen AS s_last_seen FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token_hash=? AND s.expires_at > ? AND u.active = 1"
            " AND (s.last_seen IS NULL OR s.last_seen > ?)",
            (th, now, now - SESSION_IDLE)).fetchone()
        if row and (row["s_last_seen"] or 0) < now - 60:   # perbarui paling sering tiap menit
            conn.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (now, th))
    return public_user(row) if row else None


def any_user(user: dict | None = Depends(optional_user)) -> dict:
    """Staf atau pasien yang sudah masuk."""
    if user is None:
        raise HTTPException(401, "Sesi berakhir. Silakan masuk lagi.")
    return user


def current_user(user: dict = Depends(any_user)) -> dict:
    """Staf yang sudah masuk. Akun pasien ditolak."""
    if user["role"] not in STAFF_ROLES:
        raise HTTPException(403, "Halaman ini hanya untuk petugas klinik.")
    return user


def require_patient(user: dict = Depends(any_user)) -> dict:
    if user["role"] != "pasien" or not user["patient_id"]:
        raise HTTPException(403, "Fitur ini untuk akun pasien.")
    return user


def require_role(*roles: str):
    def dep(user: dict = Depends(current_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(403, "Peran Anda tidak memiliki akses ke fitur ini.")
        return user
    return dep


def device_key_ok(x_api_key: str | None) -> bool:
    if not DEVICE_KEY:
        return DEVICE_OPEN
    return bool(x_api_key) and secrets.compare_digest(x_api_key.encode(), DEVICE_KEY.encode())


def device_or_staff(x_api_key: str | None = Header(None), user: dict | None = Depends(optional_user)):
    """Untuk endpoint yang dipanggil ESP32 (X-API-Key) atau staf yang sudah masuk."""
    if user is not None and user["role"] not in STAFF_ROLES:
        user = None
    if user is not None or device_key_ok(x_api_key):
        return user
    raise HTTPException(401, "Kunci perangkat salah atau belum dikirim (header X-API-Key).")
