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
SESSION_TTL = 14 * 24 * 3600
STAFF_ROLES = ("perawat", "dokter", "admin")
ROLES = (*STAFF_ROLES, "pasien")

# Kunci untuk perangkat ESP32 (header X-API-Key). Kosong = endpoint perangkat terbuka (hanya untuk prototipe).
DEVICE_KEY = os.getenv("DEVICE_KEY", os.getenv("API_KEY", ""))

# Pembatas percobaan login sederhana per username (di memori).
_FAILED: dict[str, list[float]] = {}
MAX_FAILS, FAIL_WINDOW = 5, 300


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


def check_login_allowed(username: str):
    now = time.time()
    fails = [t for t in _FAILED.get(username.lower(), []) if now - t < FAIL_WINDOW]
    _FAILED[username.lower()] = fails
    if len(fails) >= MAX_FAILS:
        raise HTTPException(429, "Terlalu banyak percobaan masuk. Coba lagi dalam 5 menit.")


def record_login_failure(username: str):
    _FAILED.setdefault(username.lower(), []).append(time.time())


def clear_login_failures(username: str):
    _FAILED.pop(username.lower(), None)


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with db() as conn:
        conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        conn.execute("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)",
                     (_token_hash(token), user_id, now, now + SESSION_TTL))
        conn.execute("UPDATE users SET last_login=? WHERE id=?", (now, user_id))
    return token


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
    }


def optional_user(retinova_session: str | None = Cookie(None)) -> dict | None:
    if not retinova_session:
        return None
    with db() as conn:
        row = conn.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.token_hash=? AND s.expires_at > ? AND u.active = 1",
            (_token_hash(retinova_session), time.time())).fetchone()
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
        return True
    return bool(x_api_key) and secrets.compare_digest(x_api_key.encode(), DEVICE_KEY.encode())


def device_or_staff(x_api_key: str | None = Header(None), user: dict | None = Depends(optional_user)):
    """Untuk endpoint yang dipanggil ESP32 (X-API-Key) atau staf yang sudah masuk."""
    if user is not None and user["role"] not in STAFF_ROLES:
        user = None
    if user is not None or (x_api_key is not None and device_key_ok(x_api_key)) or not DEVICE_KEY:
        return user
    raise HTTPException(401, "Kunci perangkat salah atau belum dikirim (header X-API-Key).")
