"""Baca server/.env (KUNCI=nilai per baris) ke variabel lingkungan sebelum modul lain dimuat.
Variabel yang sudah diatur di shell atau docker-compose tidak ditimpa. Berkas .env tidak wajib ada."""
import os

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")

if os.path.exists(_PATH):
    with open(_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            os.environ.setdefault(key.strip(), value)
