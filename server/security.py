"""Keamanan lintas modul: alamat IP klien, jejak audit, header keamanan, dan pemeriksaan Origin.

Jejak audit (tabel audit_log) mencatat siapa mengakses atau mengubah data pasien, kapan, dari mana, dan hasilnya.
Dicatat otomatis oleh middleware untuk semua permintaan ke jalur data pasien, ditambah catatan khusus dari kode
(misalnya bacaan dokter lama sebelum ditimpa). Tabel ini hanya ditambah, tidak pernah diubah lewat API.
UU PDP No. 27/2022 Pasal 31 dan Permenkes 24/2022 tentang rekam medis meminta jejak seperti ini.
"""
import base64
import contextvars
import hashlib
import ipaddress
import json
import os
import re
import time

from fastapi import Request
from starlette.responses import JSONResponse

from database import db

# Proksi tepercaya (nginx). Hanya dari alamat ini header X-Real-IP / X-Forwarded-For dipercaya.
TRUSTED_PROXIES = {p.strip() for p in os.getenv("TRUSTED_PROXIES", "127.0.0.1,::1").split(",") if p.strip()}
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "0") == "1"

_ID_RE = re.compile(r"/[0-9a-f]{12}(?=/|_|\.|$)")

_ip: contextvars.ContextVar[str | None] = contextvars.ContextVar("client_ip", default=None)


def client_ip(request: Request | None = None) -> str:
    if request is None:
        return _ip.get() or "?"
    peer = request.client.host if request.client else "?"
    if peer in TRUSTED_PROXIES:
        fwd = request.headers.get("x-real-ip") or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        try:
            ipaddress.ip_address(fwd)
            return fwd
        except ValueError:
            pass
    return peer


def audit(action: str, user_id: int | None = None, role: str | None = None, target: str | None = None,
          status: int | None = None, detail: dict | None = None, ip: str | None = None):
    """Tambah satu baris jejak audit. Jangan pernah menulis kata sandi, token, atau isi foto ke `detail`."""
    try:
        with db() as conn:
            conn.execute("INSERT INTO audit_log (ts, user_id, role, ip, action, target, status, detail)"
                         " VALUES (?,?,?,?,?,?,?,?)",
                         (time.time(), user_id, role, ip or _ip.get(), action, target, status,
                          json.dumps(detail, ensure_ascii=False) if detail else None))
    except Exception as e:  # audit tidak boleh menggagalkan permintaan, tapi kegagalannya harus terlihat di log
        print(f"[audit] gagal mencatat {action}: {e}")


# Jalur yang menyentuh data pribadi atau akun. GET status/ringkasan yang sering di-poll tidak dicatat.
_AUDITED = re.compile(r"^/(images/|api/(patients|screenings|users|data|me/|results|upload|auth/(login|logout|setup|"
                      r"password|register)|satusehat|tariffs|evaluate|benchmark/evaluate))")


def _session_user(request: Request) -> tuple[int | None, str | None]:
    token = request.cookies.get("retinova_session")
    if not token:
        return None, None
    th = hashlib.sha256(token.encode()).hexdigest()
    with db() as conn:
        r = conn.execute("SELECT u.id, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
                         (th,)).fetchone()
    return (r["id"], r["role"]) if r else (None, None)


def _same_origin(request: Request) -> bool:
    """Permintaan yang mengubah data dari browser harus berasal dari situs ini sendiri (pertahanan CSRF lapis kedua
    di atas SameSite=Lax). Klien non-browser (aplikasi HP, ESP32, curl) tidak mengirim Origin dan tetap diizinkan;
    mereka tidak membawa cookie korban."""
    origin = request.headers.get("origin")
    if not origin:
        return True
    host = request.headers.get("x-forwarded-host") if (request.client and request.client.host in TRUSTED_PROXIES) else None
    host = host or request.headers.get("host", "")
    return re.sub(r"^https?://", "", origin).rstrip("/") == host


_CSP_BASE = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline';"
             " font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';"
             " frame-ancestors 'none'")


def csp_for(index_html: str | None) -> str:
    """Izinkan hanya skrip dari situs ini, ditambah skrip sebaris di index.html (pemilih tema) lewat hash-nya."""
    hashes = []
    if index_html:
        for body in re.findall(r"<script>(.*?)</script>", index_html, flags=re.S):
            hashes.append("'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'")
    return f"script-src 'self' {' '.join(hashes)}; " + _CSP_BASE


def install(app, index_html_path: str):
    try:
        with open(index_html_path, encoding="utf-8") as f:
            csp = csp_for(f.read())
    except FileNotFoundError:
        csp = csp_for(None)

    @app.middleware("http")
    async def security_middleware(request: Request, call_next):
        ip = client_ip(request)
        _ip.set(ip)
        path = request.url.path
        if request.method not in ("GET", "HEAD", "OPTIONS") and not _same_origin(request):
            audit("csrf_blocked", target=path, status=403, ip=ip)
            return JSONResponse({"detail": "Permintaan ditolak: asal halaman tidak dikenal."}, status_code=403)
        response = await call_next(request)
        h = response.headers
        h["X-Content-Type-Options"] = "nosniff"
        h["X-Frame-Options"] = "DENY"
        h["Referrer-Policy"] = "no-referrer"
        h["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
        h["Content-Security-Policy"] = csp
        if COOKIE_SECURE:
            h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        if path.startswith("/api/") and "cache-control" not in h:
            h["Cache-Control"] = "no-store"
        if _AUDITED.match(path) and not (request.method == "GET" and path.startswith("/api/screenings")
                                         and response.status_code == 304):
            uid, role = _session_user(request)
            norm = _ID_RE.sub("/{id}", path)
            audit(f"{request.method} {norm}", uid, role,
                  target=_target(path), status=response.status_code, ip=ip)
        return response


def _target(path: str) -> str | None:
    m = re.search(r"/(patients|screenings|users)/([0-9a-f]{12}|\d+)", path)
    if m:
        return f"{m.group(1)[:-1]}:{m.group(2)}"
    m = re.search(r"/images/([0-9a-f]{12})", path)
    return f"image:{m.group(1)}" if m else None
