"""SQLite: koneksi dan skema. Skema dibuat/dimigrasi otomatis saat server mulai."""
import os
import sqlite3
from contextlib import contextmanager

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.getenv("DATA_DIR", os.path.join(BASE, "data"))
IMG_DIR = os.path.join(DATA_DIR, "images")
DB_PATH = os.path.join(DATA_DIR, "results.db")
os.makedirs(IMG_DIR, exist_ok=True)


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        with conn:
            yield conn
    finally:
        conn.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY, ts REAL, device TEXT, source TEXT, filename TEXT,
    grade INTEGER, label TEXT, confidence REAL, referable INTEGER,
    probs TEXT, quality TEXT, latency_ms REAL, p_referable REAL,
    true_grade INTEGER, is_correct INTEGER
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('perawat', 'dokter', 'admin', 'pasien')),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL,
    last_login REAL,
    patient_id TEXT                        -- hanya untuk akun pasien
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
    id TEXT PRIMARY KEY,
    mrn TEXT NOT NULL UNIQUE,              -- nomor rekam Retinova, mis. RNV-000123
    nik TEXT,
    full_name TEXT NOT NULL,
    sex TEXT CHECK (sex IN ('L', 'P')),
    birth_date TEXT,                       -- YYYY-MM-DD
    phone TEXT,
    address TEXT,
    diabetes_type TEXT,                    -- tipe1 | tipe2 | gestasional | tidak_tahu | tidak (bukan diabetes)
    diabetes_since INTEGER,                -- tahun terdiagnosis
    on_insulin INTEGER,
    hypertension INTEGER,
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(full_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_patients_nik ON patients(nik);

CREATE TABLE IF NOT EXISTS screenings (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(id),
    nurse_id INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'draf' CHECK (status IN ('draf', 'menunggu', 'dibaca')),
    created_at REAL NOT NULL,
    submitted_at REAL,
    location TEXT,
    glucose REAL,                          -- mg/dL
    glucose_kind TEXT,                     -- puasa | sewaktu | 2jpp
    hba1c REAL,                            -- %
    systolic INTEGER,
    diastolic INTEGER,
    va_right TEXT,                         -- visus, mis. 6/9
    va_left TEXT,
    complaints TEXT,
    nurse_notes TEXT,
    ai_grade INTEGER,                      -- derajat terburuk dari semua foto
    ai_p_referable REAL,
    ai_referable INTEGER,
    doctor_id INTEGER REFERENCES users(id),
    reviewed_at REAL,
    dr_grade_right INTEGER,
    dr_grade_left INTEGER,
    dr_dme INTEGER,                        -- curiga edema makula
    decision TEXT,                         -- rujuk_segera | rujuk | rujuk_lain | ulang_6 | ulang_12 | normal | foto_ulang
    doctor_notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_screenings_status ON screenings(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_screenings_patient ON screenings(patient_id, created_at);

-- Jadwal praktik mingguan dokter
CREATE TABLE IF NOT EXISTS doctor_schedules (
    id TEXT PRIMARY KEY,
    doctor_id INTEGER NOT NULL REFERENCES users(id),
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Senin
    start_time TEXT NOT NULL,              -- HH:MM waktu klinik
    end_time TEXT NOT NULL,
    quota INTEGER NOT NULL,
    location TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_doctor ON doctor_schedules(doctor_id, weekday);

-- Booking dan antrean. Nomor antrean urut per sesi (jadwal + tanggal).
CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,             -- kode booking pendek, mis. RV7K2Q
    patient_id TEXT NOT NULL REFERENCES patients(id),
    schedule_id TEXT NOT NULL REFERENCES doctor_schedules(id),
    doctor_id INTEGER NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,                    -- YYYY-MM-DD
    queue_no INTEGER NOT NULL,
    source TEXT NOT NULL,                  -- online | onsite
    payer TEXT NOT NULL,                   -- umum | bpjs | asuransi
    payer_ref TEXT,                        -- no. kartu BPJS atau nama asuransi + no. polis
    complaint TEXT,
    status TEXT NOT NULL DEFAULT 'terdaftar'
        CHECK (status IN ('terdaftar', 'hadir', 'dipanggil', 'selesai', 'batal', 'tidak_hadir')),
    created_by INTEGER REFERENCES users(id),
    created_at REAL NOT NULL,
    checked_in_at REAL,
    called_at REAL,
    done_at REAL,
    screening_id TEXT,
    UNIQUE (schedule_id, date, queue_no)
);
CREATE INDEX IF NOT EXISTS idx_appointments_session ON appointments(schedule_id, date, queue_no);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id, date);
"""


def _migrate_users(conn):
    """Basis data lama: CHECK peran belum mengenal 'pasien' dan kolom patient_id belum ada.
    SQLite tidak bisa mengubah CHECK, jadi tabel dibuat ulang (langkah resmi 12 langkah SQLite)."""
    sql = conn.execute("SELECT sql FROM sqlite_master WHERE name='users'").fetchone()
    if sql is None or "'pasien'" in sql[0]:
        return
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("PRAGMA legacy_alter_table = ON")
    with conn:
        conn.execute("""CREATE TABLE users_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            full_name TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('perawat', 'dokter', 'admin', 'pasien')),
            password_hash TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at REAL NOT NULL,
            last_login REAL,
            patient_id TEXT)""")
        conn.execute("INSERT INTO users_new (id, username, full_name, role, password_hash, active, created_at, last_login)"
                     " SELECT id, username, full_name, role, password_hash, active, created_at, last_login FROM users")
        conn.execute("DROP TABLE users")
        conn.execute("ALTER TABLE users_new RENAME TO users")
        problems = conn.execute("PRAGMA foreign_key_check").fetchall()
        if problems:
            raise RuntimeError(f"Migrasi users gagal: {problems[:3]}")
    conn.execute("PRAGMA legacy_alter_table = OFF")
    conn.execute("PRAGMA foreign_keys = ON")


def init_db():
    with db() as conn:
        _migrate_users(conn)
        conn.executescript(SCHEMA)
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_patient ON users(patient_id) WHERE patient_id IS NOT NULL")
        pcols = {r["name"] for r in conn.execute("PRAGMA table_info(patients)")}
        for name, kind in [("payer", "TEXT"), ("bpjs_no", "TEXT"), ("bpjs_status", "TEXT"), ("bpjs_class", "TEXT"),
                           ("bpjs_checked_at", "REAL"), ("insurer", "TEXT"), ("policy_no", "TEXT")]:
            if name not in pcols:
                conn.execute(f"ALTER TABLE patients ADD COLUMN {name} {kind}")
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(results)")}
        for name, kind in [("p_referable", "REAL"), ("true_grade", "INTEGER"), ("is_correct", "INTEGER"),
                           ("screening_id", "TEXT"), ("eye", "TEXT"), ("user_id", "INTEGER")]:
            if name not in cols:
                conn.execute(f"ALTER TABLE results ADD COLUMN {name} {kind}")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_results_screening ON results(screening_id)")


def purge_results(conn, where: str, args: tuple = ()) -> int:
    """Hapus baris foto beserta berkasnya (asli, kontras, peta lesi) dari disk. Mengembalikan jumlah foto."""
    rows = conn.execute(f"SELECT id, filename FROM results WHERE {where}", args).fetchall()
    for r in rows:
        for name in (r["filename"], f"{r['id']}_prep.jpg", f"{r['id']}_heat.jpg"):
            if name:
                try:
                    os.remove(os.path.join(IMG_DIR, os.path.basename(name)))
                except FileNotFoundError:
                    pass
    conn.execute(f"DELETE FROM results WHERE {where}", args)
    return len(rows)
