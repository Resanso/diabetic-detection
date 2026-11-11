"""Alur klinis: akun, pasien, pemeriksaan (data klinis + foto retina), dan bacaan dokter."""
import datetime as dt
import json
import os
import time
import uuid

import hashlib
import ipaddress
import secrets

from fastapi import APIRouter, Cookie, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from auth import (
    STAFF_ROLES,
    any_user,
    SESSION_COOKIE,
    SESSION_TTL,
    check_login_allowed,
    clear_login_failures,
    create_session,
    current_user,
    delete_other_sessions,
    delete_session,
    hash_password,
    public_user,
    record_login_failure,
    require_role,
    verify_or_dummy,
    verify_password,
)
from database import db, purge_results
from security import audit, client_ip
from devices import MAX_BYTES, request_capture
from inference import LABELS, REF_PROB, row_to_dict, run_inference
import billing
import llm
import satusehat

router = APIRouter()

# Perawat melihat kualitas foto dan keputusan dokter. Perkiraan AI hanya untuk dokter, kecuali diaktifkan.
SHOW_AI_TO_NURSE = os.getenv("SHOW_AI_TO_NURSE", "0") == "1"
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "0") == "1"
SETUP_TOKEN = os.getenv("SETUP_TOKEN", "")      # wajib untuk membuat admin pertama dari luar jaringan lokal
CONSENT_VERSION = "2026-11"                     # versi naskah persetujuan yang dibacakan ke pasien
EYES = ("kanan", "kiri")
DECISIONS = ("rujuk_segera", "rujuk", "rujuk_lain", "ulang_6", "ulang_12", "normal", "foto_ulang")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def clean(s: str | None) -> str | None:
    s = (s or "").strip()
    return s or None


# --- Akun & sesi ---

class LoginBody(BaseModel):
    username: str
    password: str


class SetupBody(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    full_name: str = Field(min_length=2, max_length=80)
    password: str = Field(min_length=10, max_length=200)
    setup_token: str | None = None


def set_session_cookie(response: Response, token: str):
    response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", secure=COOKIE_SECURE,
                        max_age=SESSION_TTL)


@router.get("/api/auth/status")
def auth_status():
    with db() as conn:
        has_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0
    return {"needs_setup": not has_users}


@router.post("/api/auth/setup")
def setup_first_admin(body: SetupBody, request: Request, response: Response):
    """Membuat akun admin pertama. Hanya bisa dipakai saat belum ada akun sama sekali, dari jaringan lokal
    atau dengan SETUP_TOKEN, supaya orang lain tidak bisa mengambil alih server baru yang terbuka di internet."""
    ip = client_ip(request)
    try:
        local = ipaddress.ip_address(ip).is_loopback or ipaddress.ip_address(ip).is_private
    except ValueError:
        local = False
    if SETUP_TOKEN:
        if not (body.setup_token and secrets.compare_digest(body.setup_token, SETUP_TOKEN)):
            raise HTTPException(403, "Kode penyiapan salah. Lihat variabel SETUP_TOKEN di server.")
    elif not local:
        raise HTTPException(403, "Admin pertama hanya bisa dibuat dari jaringan lokal server, atau setel SETUP_TOKEN.")
    with db() as conn:
        conn.execute("BEGIN IMMEDIATE")   # dua permintaan bersamaan tidak boleh sama-sama membuat admin
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0:
            raise HTTPException(409, "Akun admin sudah dibuat. Silakan masuk.")
        cur = conn.execute(
            "INSERT INTO users (username, full_name, role, password_hash, created_at) VALUES (?,?,?,?,?)",
            (body.username.strip(), body.full_name.strip(), "admin", hash_password(body.password), time.time()))
        user_id = cur.lastrowid
    set_session_cookie(response, create_session(user_id))
    return {"ok": True}


@router.post("/api/auth/login")
def login(body: LoginBody, request: Request, response: Response):
    username = body.username.strip()
    ip = client_ip(request)
    check_login_allowed(username, ip)
    with db() as conn:
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not verify_or_dummy(body.password, row["password_hash"] if row else None):
        record_login_failure(username, ip)
        audit("login_gagal", row["id"] if row else None, detail={"akun_ada": row is not None}, status=401)
        raise HTTPException(401, "Nama pengguna atau kata sandi salah.")
    if not row["active"]:
        raise HTTPException(403, "Akun ini dinonaktifkan. Hubungi admin.")
    clear_login_failures(username, ip)
    set_session_cookie(response, create_session(row["id"]))
    return public_user(row)


@router.post("/api/auth/logout")
def logout(response: Response, retinova_session: str | None = Cookie(None)):
    delete_session(retinova_session)
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@router.get("/api/auth/me")
def me(user: dict = Depends(any_user)):
    return user


class PasswordBody(BaseModel):
    current: str
    new: str = Field(min_length=10, max_length=200)


@router.post("/api/auth/password")
def change_password(body: PasswordBody, user: dict = Depends(any_user),
                    retinova_session: str | None = Cookie(None)):
    with db() as conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id=?", (user["id"],)).fetchone()
        if not verify_password(body.current, row["password_hash"]):
            raise HTTPException(400, "Kata sandi saat ini salah.")
        conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(body.new), user["id"]))
    delete_other_sessions(user["id"], retinova_session)   # perangkat lain harus masuk ulang
    return {"ok": True}


# --- Pengguna (admin) ---

def staff_nik(v: str | None) -> str | None:
    """NIK tenaga kesehatan, dipakai mencari nomor IHS Practitioner di SATUSEHAT."""
    v = (v or "").strip()
    if not v:
        return None
    if not (len(v) == 16 and v.isdigit()):
        raise ValueError("NIK harus 16 digit angka")
    return v


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z0-9._-]+$")
    full_name: str = Field(min_length=2, max_length=80)
    role: str
    password: str = Field(min_length=8, max_length=200)
    nik: str | None = None

    @field_validator("nik")
    @classmethod
    def _nik(cls, v):
        return staff_nik(v)

    @field_validator("role")
    @classmethod
    def _role(cls, v):
        if v not in STAFF_ROLES:
            raise ValueError("peran harus perawat, dokter, atau admin")
        return v


class UserUpdate(BaseModel):
    full_name: str | None = Field(None, min_length=2, max_length=80)
    role: str | None = None
    active: bool | None = None
    password: str | None = Field(None, min_length=8, max_length=200)
    nik: str | None = None   # "" = hapus NIK

    @field_validator("nik")
    @classmethod
    def _nik(cls, v):
        return v if v == "" else staff_nik(v)

    @field_validator("role")
    @classmethod
    def _role(cls, v):
        if v is not None and v not in STAFF_ROLES:
            raise ValueError("peran harus perawat, dokter, atau admin")
        return v


@router.get("/api/users", dependencies=[Depends(require_role("admin"))])
def list_users():
    with db() as conn:
        rows = conn.execute("SELECT * FROM users ORDER BY active DESC, role, full_name").fetchall()
    return [public_user(r) for r in rows]


@router.post("/api/users", dependencies=[Depends(require_role("admin"))])
def create_user(body: UserCreate):
    with db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username=?", (body.username,)).fetchone():
            raise HTTPException(409, "Nama pengguna sudah dipakai.")
        cur = conn.execute(
            "INSERT INTO users (username, full_name, role, password_hash, created_at, nik) VALUES (?,?,?,?,?,?)",
            (body.username, body.full_name.strip(), body.role, hash_password(body.password), time.time(), body.nik))
        row = conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    return public_user(row)


@router.delete("/api/users/{user_id}")
def delete_user(user_id: int, admin: dict = Depends(require_role("admin"))):
    """Hapus akun. Pemeriksaan yang pernah dibuat atau dibaca tetap ada, tanpa nama petugas."""
    if user_id == admin["id"]:
        raise HTTPException(400, "Anda tidak bisa menghapus akun sendiri.")
    with db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone() is None:
            raise HTTPException(404, "Pengguna tidak ditemukan.")
        if conn.execute("SELECT 1 FROM appointments WHERE doctor_id=?", (user_id,)).fetchone():
            raise HTTPException(409, "Dokter ini punya riwayat antrean pasien. Nonaktifkan akunnya saja.")
        conn.execute("DELETE FROM doctor_schedules WHERE doctor_id=?", (user_id,))
        conn.execute("UPDATE appointments SET created_by=NULL WHERE created_by=?", (user_id,))
        conn.execute("UPDATE patients SET created_by=NULL WHERE created_by=?", (user_id,))
        conn.execute("UPDATE screenings SET nurse_id=NULL WHERE nurse_id=?", (user_id,))
        conn.execute("UPDATE screenings SET doctor_id=NULL WHERE doctor_id=?", (user_id,))
        conn.execute("UPDATE results SET user_id=NULL WHERE user_id=?", (user_id,))
        conn.execute("DELETE FROM users WHERE id=?", (user_id,))
    return {"ok": True}


@router.patch("/api/users/{user_id}")
def update_user(user_id: int, body: UserUpdate, admin: dict = Depends(require_role("admin"))):
    if user_id == admin["id"] and (body.active is False or (body.role and body.role != "admin")):
        raise HTTPException(400, "Anda tidak bisa menonaktifkan atau menurunkan peran akun sendiri.")
    with db() as conn:
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Pengguna tidak ditemukan.")
        if row["role"] == "pasien" and body.role and body.role != "pasien":
            raise HTTPException(400, "Akun pasien tidak bisa diubah menjadi akun petugas.")
        if body.full_name is not None:
            conn.execute("UPDATE users SET full_name=? WHERE id=?", (body.full_name.strip(), user_id))
        if body.role is not None:
            conn.execute("UPDATE users SET role=? WHERE id=?", (body.role, user_id))
        if body.active is not None:
            conn.execute("UPDATE users SET active=? WHERE id=?", (int(body.active), user_id))
            if not body.active:
                conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        if body.nik is not None and (body.nik or None) != row["nik"]:
            conn.execute("UPDATE users SET nik=?, ihs_number=NULL WHERE id=?", (body.nik or None, user_id))
        if body.password:
            conn.execute("UPDATE users SET password_hash=? WHERE id=?", (hash_password(body.password), user_id))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return public_user(row)


# --- Pasien ---

PAYERS = ("umum", "bpjs", "asuransi")


class PayerFields(BaseModel):
    """Cara bayar pasien. Dipakai formulir petugas, pendaftaran pasien, dan profil pasien."""
    payer: str | None = None
    bpjs_no: str | None = Field(None, max_length=13)
    insurer: str | None = Field(None, max_length=80)
    policy_no: str | None = Field(None, max_length=40)

    @field_validator("payer")
    @classmethod
    def _payer(cls, v):
        if v not in (None, *PAYERS):
            raise ValueError("cara bayar harus umum, bpjs, atau asuransi")
        return v

    @field_validator("bpjs_no")
    @classmethod
    def _bpjs(cls, v):
        v = clean(v)
        if v is not None and (not v.isdigit() or len(v) != 13):
            raise ValueError("nomor kartu BPJS harus 13 digit angka")
        return v

    def check_complete(self):
        if self.payer == "bpjs" and not self.bpjs_no:
            raise HTTPException(422, "Isi nomor kartu BPJS (13 digit).")
        if self.payer == "asuransi" and not clean(self.insurer):
            raise HTTPException(422, "Isi nama asuransi.")


class PatientBody(PayerFields):
    full_name: str = Field(min_length=2, max_length=100)
    nik: str | None = Field(None, max_length=16)
    sex: str | None = None
    birth_date: str | None = None
    phone: str | None = Field(None, max_length=20)
    address: str | None = Field(None, max_length=300)
    diabetes_type: str | None = None
    diabetes_since: int | None = Field(None, ge=1940, le=2100)
    on_insulin: bool | None = None
    hypertension: bool | None = None
    notes: str | None = Field(None, max_length=1000)
    # Persetujuan pasien atas pemrosesan data kesehatannya. None = klien lama yang belum mengirim (dicatat kosong).
    consent: bool | None = None

    @field_validator("nik")
    @classmethod
    def _nik(cls, v):
        v = clean(v)
        if v is not None and (not v.isdigit() or len(v) != 16):
            raise ValueError("NIK harus 16 digit angka")
        return v

    @field_validator("sex")
    @classmethod
    def _sex(cls, v):
        if v not in (None, "L", "P"):
            raise ValueError("jenis kelamin harus L atau P")
        return v

    @field_validator("birth_date")
    @classmethod
    def _birth(cls, v):
        v = clean(v)
        if v is not None:
            d = dt.date.fromisoformat(v)
            if d > dt.date.today() or d.year < 1900:
                raise ValueError("tanggal lahir tidak masuk akal")
        return v

    @field_validator("diabetes_type")
    @classmethod
    def _dm(cls, v):
        if v not in (None, "tipe1", "tipe2", "gestasional", "tidak_tahu", "tidak"):
            raise ValueError("jenis diabetes tidak dikenal")
        return v


def patient_dict(r) -> dict:
    d = dict(r)
    for k in ("activation_hash", "activation_expires"):
        d.pop(k, None)
    d["on_insulin"] = None if r["on_insulin"] is None else bool(r["on_insulin"])
    d["hypertension"] = None if r["hypertension"] is None else bool(r["hypertension"])
    return d


PATIENT_FIELDS = ("nik", "full_name", "sex", "birth_date", "phone", "address", "diabetes_type",
                  "diabetes_since", "on_insulin", "hypertension", "notes", "payer", "bpjs_no", "insurer", "policy_no")


def next_mrn(conn) -> str:
    seq = conn.execute("SELECT COUNT(*) FROM patients").fetchone()[0] + 1
    while conn.execute("SELECT 1 FROM patients WHERE mrn=?", (f"RNV-{seq:06d}",)).fetchone():
        seq += 1
    return f"RNV-{seq:06d}"


def reset_bpjs_if_changed(conn, patient_id: str, old_no: str | None, new_no: str | None):
    """Nomor kartu berubah: status verifikasi lama tidak berlaku lagi."""
    if old_no != new_no:
        conn.execute("UPDATE patients SET bpjs_status=NULL, bpjs_class=NULL, bpjs_checked_at=NULL WHERE id=?",
                     (patient_id,))


def patient_values(body: PatientBody) -> list:
    vals = []
    for k in PATIENT_FIELDS:
        v = getattr(body, k)
        if isinstance(v, str):
            v = clean(v)
        if isinstance(v, bool):
            v = int(v)
        vals.append(v)
    return vals


@router.get("/api/patients")
def list_patients(q: str = Query("", max_length=100), limit: int = Query(50, ge=1, le=200),
                  user: dict = Depends(current_user)):
    q = q.strip()
    sql = ("SELECT p.*, (SELECT MAX(created_at) FROM screenings s WHERE s.patient_id = p.id) AS last_screening_at,"
           " (SELECT decision FROM screenings s WHERE s.patient_id = p.id AND s.status='dibaca'"
           "  ORDER BY reviewed_at DESC LIMIT 1) AS last_decision"
           " FROM patients p")
    args: list = []
    if q:
        sql += " WHERE p.full_name LIKE ? OR p.nik LIKE ? OR p.mrn LIKE ? OR p.phone LIKE ?"
        like = f"%{q}%"
        args += [like, f"{q}%", f"%{q}%", f"%{q}%"]
    sql += " ORDER BY COALESCE(last_screening_at, p.created_at) DESC LIMIT ?"
    args.append(limit)
    with db() as conn:
        rows = conn.execute(sql, args).fetchall()
        return [{**patient_dict(r), "latest": latest_photo_screening(conn, r["id"], user)} for r in rows]


def latest_photo_screening(conn, patient_id: str, user: dict) -> dict | None:
    """Pemeriksaan terbaru yang sudah ada fotonya, untuk ringkasan di daftar pasien (foto + perkiraan AI)."""
    s = conn.execute(
        "SELECT s.* FROM screenings s WHERE s.patient_id=?"
        " AND EXISTS (SELECT 1 FROM results r WHERE r.screening_id=s.id)"
        " ORDER BY s.created_at DESC LIMIT 1", (patient_id,)).fetchone()
    if s is None:
        return None
    d = screening_summary(conn, s, user)
    return {k: d[k] for k in ("id", "status", "created_at", "decision", "ai_grade", "ai_p_referable",
                              "ai_referable", "image_count", "thumbnail_url")}


@router.post("/api/patients")
def create_patient(body: PatientBody, user: dict = Depends(require_role("perawat", "dokter", "admin"))):
    body.check_complete()
    if body.consent is False:
        raise HTTPException(422, "Data pasien hanya boleh disimpan setelah pasien menyetujui pemrosesan datanya.")
    with db() as conn:
        if body.nik and conn.execute("SELECT 1 FROM patients WHERE nik=?", (body.nik,)).fetchone():
            raise HTTPException(409, "Pasien dengan NIK ini sudah terdaftar. Cari namanya di daftar pasien.")
        pid = insert_patient(conn, body, user)
        row = conn.execute("SELECT * FROM patients WHERE id=?", (pid,)).fetchone()
    return patient_dict(row)


def insert_patient(conn, body: PatientBody, user: dict) -> str:
    now = time.time()
    pid = new_id()
    conn.execute(
        f"INSERT INTO patients (id, mrn, {', '.join(PATIENT_FIELDS)}, created_by, created_at, updated_at)"
        f" VALUES (?, ?, {', '.join('?' * len(PATIENT_FIELDS))}, ?, ?, ?)",
        [pid, next_mrn(conn), *patient_values(body), user["id"], now, now])
    if body.consent:
        conn.execute("UPDATE patients SET consent_at=?, consent_by=?, consent_version=? WHERE id=?",
                     (now, user["id"], CONSENT_VERSION, pid))
    return pid


@router.get("/api/patients/{patient_id}")
def get_patient(patient_id: str, user: dict = Depends(current_user)):
    with db() as conn:
        row = conn.execute("SELECT * FROM patients WHERE id=?", (patient_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Pasien tidak ditemukan.")
        screenings = [screening_summary(conn, s, user) for s in conn.execute(
            "SELECT * FROM screenings WHERE patient_id=? ORDER BY created_at DESC", (patient_id,)).fetchall()]
    return {**patient_dict(row), "screenings": screenings}


@router.delete("/api/patients/{patient_id}")
def delete_patient(patient_id: str, user: dict = Depends(current_user)):
    """Hapus pasien beserta semua pemeriksaan dan fotonya. Admin selalu boleh; pendaftar boleh
    selama pasien belum punya pemeriksaan yang dikirim ke dokter (mis. salah daftar)."""
    with db() as conn:
        row = conn.execute("SELECT * FROM patients WHERE id=?", (patient_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Pasien tidak ditemukan.")
        if user["role"] != "admin":
            if row["created_by"] != user["id"]:
                raise HTTPException(403, "Hanya admin atau petugas yang mendaftarkan pasien ini yang bisa menghapusnya.")
            if conn.execute("SELECT 1 FROM screenings WHERE patient_id=? AND status<>'draf'", (patient_id,)).fetchone():
                raise HTTPException(409, "Pasien ini sudah punya pemeriksaan yang dikirim ke dokter. Minta admin untuk menghapusnya.")
        n = purge_results(conn, "screening_id IN (SELECT id FROM screenings WHERE patient_id=?)", (patient_id,))
        conn.execute("DELETE FROM screenings WHERE patient_id=?", (patient_id,))
        conn.execute("DELETE FROM appointments WHERE patient_id=?", (patient_id,))
        conn.execute("DELETE FROM users WHERE role='pasien' AND patient_id=?", (patient_id,))
        conn.execute("DELETE FROM patients WHERE id=?", (patient_id,))
    return {"ok": True, "images": n}


@router.delete("/api/data", dependencies=[Depends(require_role("admin"))])
def wipe_data(confirm: str = Query(...)):
    """Bersihkan semua data pasien, akun pasien, antrean, pemeriksaan, dan foto (mis. data uji coba sebelum
    dipakai sungguhan). Akun petugas, jadwal dokter, dan pengaturan perangkat tetap ada."""
    if confirm != "HAPUS":
        raise HTTPException(400, "Ketik HAPUS untuk mengonfirmasi.")
    with db() as conn:
        counts = {
            "patients": conn.execute("SELECT COUNT(*) FROM patients").fetchone()[0],
            "screenings": conn.execute("SELECT COUNT(*) FROM screenings").fetchone()[0],
        }
        counts["images"] = purge_results(conn, "1=1")
        counts["appointments"] = conn.execute("DELETE FROM appointments").rowcount
        counts["accounts"] = conn.execute("DELETE FROM users WHERE role='pasien'").rowcount
        conn.execute("DELETE FROM screenings")
        conn.execute("DELETE FROM patients")
    return {"ok": True, **counts}


@router.put("/api/patients/{patient_id}")
def update_patient(patient_id: str, body: PatientBody, user: dict = Depends(current_user)):
    body.check_complete()
    with db() as conn:
        old = conn.execute("SELECT bpjs_no, nik, payer, policy_no FROM patients WHERE id=?", (patient_id,)).fetchone()
        if old is None:
            raise HTTPException(404, "Pasien tidak ditemukan.")
        if body.nik and conn.execute("SELECT 1 FROM patients WHERE nik=? AND id<>?",
                                     (body.nik, patient_id)).fetchone():
            raise HTTPException(409, "NIK ini sudah dipakai pasien lain.")
        conn.execute(
            f"UPDATE patients SET {', '.join(f'{k}=?' for k in PATIENT_FIELDS)}, updated_at=? WHERE id=?",
            [*patient_values(body), time.time(), patient_id])
        reset_bpjs_if_changed(conn, patient_id, old["bpjs_no"], body.bpjs_no)
        if body.consent:
            conn.execute("UPDATE patients SET consent_at=?, consent_by=?, consent_version=? WHERE id=? AND consent_at IS NULL",
                         (time.time(), user["id"], CONSENT_VERSION, patient_id))
        if old["nik"] != body.nik:   # nomor IHS SATUSEHAT dicari ulang dari NIK baru
            conn.execute("UPDATE patients SET ihs_number=NULL WHERE id=?", (patient_id,))
        # cara bayar atau nomor kartu berubah: hasil cek kepesertaan SATUSEHAT lama tidak berlaku
        conn.execute("UPDATE patients SET ss_cov_status=NULL, ss_cov_id=NULL, ss_cov_payor=NULL, ss_cov_checked_at=NULL"
                     " WHERE id=? AND NOT (payer IS ? AND bpjs_no IS ? AND policy_no IS ?)",
                     (patient_id, old["payer"], old["bpjs_no"], old["policy_no"]))
        row = conn.execute("SELECT * FROM patients WHERE id=?", (patient_id,)).fetchone()
    return patient_dict(row)


@router.post("/api/patients/{patient_id}/activation-code")
def activation_code(patient_id: str, user: dict = Depends(require_role("perawat", "admin"))):
    """Kode sekali pakai (berlaku 72 jam) yang diberikan petugas kepada pasien, supaya pasien bisa membuat akun
    untuk data yang sudah dicatat klinik. Tanpa kode ini, orang yang hanya tahu NIK tidak bisa mengambil alih data."""
    code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8))
    with db() as conn:
        if not conn.execute("SELECT 1 FROM patients WHERE id=?", (patient_id,)).fetchone():
            raise HTTPException(404, "Pasien tidak ditemukan.")
        if conn.execute("SELECT 1 FROM users WHERE patient_id=?", (patient_id,)).fetchone():
            raise HTTPException(409, "Pasien ini sudah punya akun.")
        conn.execute("UPDATE patients SET activation_hash=?, activation_expires=? WHERE id=?",
                     (hashlib.sha256(code.encode()).hexdigest(), time.time() + 72 * 3600, patient_id))
    return {"code": code, "expires_in_hours": 72}


# --- Pemeriksaan ---

class ScreeningBody(BaseModel):
    location: str | None = Field(None, max_length=120)
    glucose: float | None = Field(None, ge=20, le=1000)
    glucose_kind: str | None = None
    hba1c: float | None = Field(None, ge=3, le=20)
    systolic: int | None = Field(None, ge=50, le=300)
    diastolic: int | None = Field(None, ge=30, le=200)
    va_right: str | None = Field(None, max_length=12)
    va_left: str | None = Field(None, max_length=12)
    complaints: str | None = Field(None, max_length=1000)
    nurse_notes: str | None = Field(None, max_length=1000)

    @field_validator("glucose_kind")
    @classmethod
    def _gk(cls, v):
        if v not in (None, "puasa", "sewaktu", "2jpp"):
            raise ValueError("jenis gula darah harus puasa, sewaktu, atau 2jpp")
        return v


class ScreeningCreate(ScreeningBody):
    patient_id: str
    tariff_id: str | None = None   # kosong = tarif bawaan


SCREENING_FIELDS = tuple(ScreeningBody.model_fields)


class ReviewBody(BaseModel):
    grade_right: int | None = Field(None, ge=0, le=4)
    grade_left: int | None = Field(None, ge=0, le=4)
    dme: bool | None = None
    decision: str
    notes: str | None = Field(None, max_length=2000)

    @field_validator("decision")
    @classmethod
    def _decision(cls, v):
        if v not in DECISIONS:
            raise ValueError("keputusan tidak dikenal")
        return v


def can_see_ai(user: dict) -> bool:
    return user["role"] in ("dokter", "admin") or SHOW_AI_TO_NURSE


def image_for(user: dict, r) -> dict:
    d = row_to_dict(r)
    out = {k: d[k] for k in ("id", "ts", "device", "source", "image_url", "preprocessed_url",
                             "heatmap_url", "quality", "eye")}
    if can_see_ai(user) and d["quality"].get("is_fundus", True) is not False:
        out.update({k: d[k] for k in ("grade", "label", "confidence", "referable", "p_referable", "probs",
                                      "cam_url", "cam_grade")})
    return out


def user_name(conn, user_id) -> str | None:
    if user_id is None:
        return None
    r = conn.execute("SELECT full_name FROM users WHERE id=?", (user_id,)).fetchone()
    return r["full_name"] if r else None


def screening_summary(conn, s, user: dict) -> dict:
    d = {k: v for k, v in dict(s).items() if not k.startswith(("ss_", "llm_"))}
    d["dr_dme"] = None if s["dr_dme"] is None else bool(s["dr_dme"])
    d["ai_referable"] = None if s["ai_referable"] is None else bool(s["ai_referable"])
    if not can_see_ai(user):
        for k in ("ai_grade", "ai_p_referable", "ai_referable"):
            d[k] = None
    d["nurse_name"] = user_name(conn, s["nurse_id"])
    d["doctor_name"] = user_name(conn, s["doctor_id"])
    thumbs = conn.execute("SELECT id, filename, eye FROM results WHERE screening_id=? ORDER BY ts",
                          (s["id"],)).fetchall()
    d["image_count"] = len(thumbs)
    d["thumbnail_url"] = f"/images/{thumbs[-1]['filename']}" if thumbs else None
    for k in ("tariff_id", "tariff_name", "tariff_price", "paid_at", "paid_by"):
        d.pop(k, None)
    d["billing"] = billing.billing_for(conn, s)
    return d


def load_screening(conn, screening_id: str):
    s = conn.execute("SELECT * FROM screenings WHERE id=?", (screening_id,)).fetchone()
    if s is None:
        raise HTTPException(404, "Pemeriksaan tidak ditemukan.")
    return s


def screening_detail(conn, s, user: dict) -> dict:
    d = screening_summary(conn, s, user)
    p = conn.execute("SELECT * FROM patients WHERE id=?", (s["patient_id"],)).fetchone()
    d["patient"] = patient_dict(p)
    d["images"] = [image_for(user, r) for r in conn.execute(
        "SELECT * FROM results WHERE screening_id=? ORDER BY ts", (s["id"],)).fetchall()]
    d["previous"] = [screening_summary(conn, r, user) for r in conn.execute(
        "SELECT * FROM screenings WHERE patient_id=? AND id<>? AND status='dibaca'"
        " ORDER BY reviewed_at DESC LIMIT 5", (s["patient_id"], s["id"])).fetchall()]
    d["ref_threshold"] = REF_PROB if can_see_ai(user) else None
    d["satusehat"] = satusehat.state_of(s)   # semua peran melihat status; hanya dokter/admin yang bisa mengirim
    d["llm"] = llm.state_for(s, user, can_see_ai(user))
    d["labels"] = LABELS
    return d


def ai_valid(quality_json: str | None) -> bool:
    """Foto yang dikenali bukan fundus (atau sudah diolah) tidak dinilai AI. Data lama tanpa is_fundus dianggap sah."""
    try:
        return json.loads(quality_json or "{}").get("is_fundus", True) is not False
    except ValueError:
        return True


def refresh_ai_summary(conn, screening_id: str):
    rows = [r for r in conn.execute("SELECT grade, p_referable, quality FROM results WHERE screening_id=?",
                                    (screening_id,)).fetchall() if ai_valid(r["quality"])]
    if rows:
        grade = max(r["grade"] for r in rows)
        p_ref = max(r["p_referable"] or 0 for r in rows)
        conn.execute("UPDATE screenings SET ai_grade=?, ai_p_referable=?, ai_referable=? WHERE id=?",
                     (grade, p_ref, int(p_ref >= REF_PROB), screening_id))
    else:
        conn.execute("UPDATE screenings SET ai_grade=NULL, ai_p_referable=NULL, ai_referable=NULL WHERE id=?",
                     (screening_id,))


def ensure_editable(s, user: dict):
    if s["status"] != "draf":
        raise HTTPException(409, "Pemeriksaan sudah dikirim ke dokter dan tidak bisa diubah.")
    if user["role"] != "admin" and s["nurse_id"] != user["id"]:
        raise HTTPException(403, "Pemeriksaan ini dibuat oleh petugas lain.")


@router.get("/api/screenings")
def list_screenings(status: str | None = Query(None, pattern="^(draf|menunggu|dibaca)$"),
                    mine: bool = False, limit: int = Query(50, ge=1, le=200),
                    since: float | None = None, user: dict = Depends(current_user)):
    sql, args = "SELECT * FROM screenings WHERE 1=1", []
    if status:
        sql += " AND status=?"
        args.append(status)
    if mine:
        sql += " AND (nurse_id=? OR doctor_id=?)"
        args += [user["id"], user["id"]]
    if since is not None:
        sql += " AND created_at >= ?"
        args.append(since)
    if status == "menunggu":
        # Antrean dokter: perkiraan risiko tertinggi dulu, lalu yang paling lama menunggu.
        sql += " ORDER BY COALESCE(ai_p_referable, 0) DESC, submitted_at ASC"
    elif status == "dibaca":
        sql += " ORDER BY reviewed_at DESC"
    else:
        sql += " ORDER BY created_at DESC"
    sql += " LIMIT ?"
    args.append(limit)
    with db() as conn:
        out = []
        for s in conn.execute(sql, args).fetchall():
            d = screening_summary(conn, s, user)
            p = conn.execute("SELECT id, mrn, full_name, sex, birth_date FROM patients WHERE id=?",
                             (s["patient_id"],)).fetchone()
            d["patient"] = dict(p) if p else None
            out.append(d)
    return out


@router.post("/api/screenings")
def create_screening(body: ScreeningCreate, user: dict = Depends(require_role("perawat", "dokter", "admin"))):
    with db() as conn:
        sid = insert_screening(conn, body, user, time.time())
        return screening_detail(conn, load_screening(conn, sid), user)


def insert_screening(conn, body: ScreeningCreate, user: dict, created_at: float) -> str:
    if not conn.execute("SELECT 1 FROM patients WHERE id=?", (body.patient_id,)).fetchone():
        raise HTTPException(404, "Pasien tidak ditemukan.")
    sid = new_id()
    conn.execute(
        f"INSERT INTO screenings (id, patient_id, nurse_id, status, created_at, {', '.join(SCREENING_FIELDS)})"
        f" VALUES (?, ?, ?, 'draf', ?, {', '.join('?' * len(SCREENING_FIELDS))})",
        [sid, body.patient_id, user["id"], created_at,
         *[clean(v) if isinstance(v, str) else v for v in (getattr(body, k) for k in SCREENING_FIELDS)]])
    billing.apply_tariff(conn, sid, getattr(body, "tariff_id", None))
    return sid


@router.get("/api/screenings/{screening_id}")
def get_screening(screening_id: str, user: dict = Depends(current_user)):
    with db() as conn:
        return screening_detail(conn, load_screening(conn, screening_id), user)


@router.patch("/api/screenings/{screening_id}")
def update_screening(screening_id: str, body: ScreeningBody, user: dict = Depends(current_user)):
    with db() as conn:
        s = load_screening(conn, screening_id)
        ensure_editable(s, user)
        sent = body.model_fields_set
        if sent:
            conn.execute(
                f"UPDATE screenings SET {', '.join(f'{k}=?' for k in sent)} WHERE id=?",
                [*[clean(v) if isinstance(v, str) else v for v in (getattr(body, k) for k in sent)], screening_id])
        return screening_detail(conn, load_screening(conn, screening_id), user)


@router.delete("/api/screenings/{screening_id}")
def delete_screening(screening_id: str, user: dict = Depends(current_user)):
    """Draf boleh dihapus pembuatnya. Pemeriksaan yang sudah dikirim atau dibaca hanya oleh admin."""
    with db() as conn:
        s = load_screening(conn, screening_id)
        if user["role"] != "admin":
            ensure_editable(s, user)
        purge_results(conn, "screening_id=?", (screening_id,))
        conn.execute("DELETE FROM screenings WHERE id=?", (screening_id,))
    return {"ok": True}


@router.post("/api/screenings/{screening_id}/images")
async def add_image(screening_id: str, eye: str = Form(...), source: str = Form("hp"),
                    file: UploadFile = File(...), client_id: str | None = Form(None, max_length=64),
                    user: dict = Depends(current_user)):
    """client_id dikirim foto yang diambil offline; foto yang sama tidak tersimpan dua kali saat dikirim ulang."""
    if eye not in EYES:
        raise HTTPException(400, "Mata harus 'kanan' atau 'kiri'.")
    if source not in ("hp", "galeri"):
        source = "hp"
    with db() as conn:
        if client_id:
            done = synced_id(conn, client_id, "image", user)
            row = done and conn.execute("SELECT * FROM results WHERE id=?", (done,)).fetchone()
            if row:
                return image_for(user, row)
        ensure_editable(load_screening(conn, screening_id), user)
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Ukuran foto lebih dari 10 MB.")
    result = await run_in_threadpool(run_inference, data, f"{source}:{user['username']}", source, None,
                                     screening_id, eye, user["id"])
    with db() as conn:
        if client_id:
            log_sync(conn, client_id, "image", result["id"], user)
        refresh_ai_summary(conn, screening_id)
        row = conn.execute("SELECT * FROM results WHERE id=?", (result["id"],)).fetchone()
        return image_for(user, row)


@router.delete("/api/screenings/{screening_id}/images/{image_id}")
def remove_image(screening_id: str, image_id: str, user: dict = Depends(current_user)):
    with db() as conn:
        ensure_editable(load_screening(conn, screening_id), user)
        if purge_results(conn, "id=? AND screening_id=?", (image_id, screening_id)) == 0:
            raise HTTPException(404, "Foto tidak ditemukan pada pemeriksaan ini.")
        refresh_ai_summary(conn, screening_id)
    return {"ok": True}


class EspCaptureBody(BaseModel):
    device_id: str
    eye: str

    @field_validator("eye")
    @classmethod
    def _eye(cls, v):
        if v not in EYES:
            raise ValueError("mata harus kanan atau kiri")
        return v


@router.post("/api/screenings/{screening_id}/esp32-capture")
def esp32_capture(screening_id: str, body: EspCaptureBody, user: dict = Depends(current_user)):
    with db() as conn:
        ensure_editable(load_screening(conn, screening_id), user)
    return {"request_id": request_capture(body.device_id, screening_id, body.eye, user["id"])}


@router.post("/api/screenings/{screening_id}/submit")
def submit_screening(screening_id: str, user: dict = Depends(current_user)):
    with db() as conn:
        s = load_screening(conn, screening_id)
        ensure_editable(s, user)
        if not conn.execute("SELECT 1 FROM results WHERE screening_id=?", (screening_id,)).fetchone():
            raise HTTPException(400, "Ambil minimal satu foto retina sebelum mengirim ke dokter.")
        refresh_ai_summary(conn, screening_id)
        conn.execute("UPDATE screenings SET status='menunggu', submitted_at=? WHERE id=?",
                     (time.time(), screening_id))
        describe = llm.queue(conn, screening_id)
        detail = screening_detail(conn, load_screening(conn, screening_id), user)
    if describe:
        llm.start(screening_id)   # deskripsi untuk dokter dibuat sambil menunggu dibaca
    return detail


@router.post("/api/screenings/{screening_id}/review")
def review_screening(screening_id: str, body: ReviewBody, user: dict = Depends(require_role("dokter"))):
    with db() as conn:
        s = load_screening(conn, screening_id)
        if s["status"] == "draf":
            raise HTTPException(409, "Pemeriksaan ini belum dikirim untuk dibaca.")
        if s["status"] == "dibaca":
            # Bacaan lama tidak hilang: disimpan di jejak audit sebelum diganti (riwayat versi rekam medis)
            audit("bacaan_diganti", user["id"], user["role"], target=f"screening:{screening_id}",
                  detail={k: s[k] for k in ("doctor_id", "reviewed_at", "dr_grade_right", "dr_grade_left", "dr_dme",
                                            "decision", "doctor_notes")})
        conn.execute(
            "UPDATE screenings SET status='dibaca', doctor_id=?, reviewed_at=?, dr_grade_right=?, dr_grade_left=?,"
            " dr_dme=?, decision=?, doctor_notes=? WHERE id=?",
            (user["id"], time.time(), body.grade_right, body.grade_left,
             None if body.dme is None else int(body.dme), body.decision, clean(body.notes), screening_id))
        satusehat.mark_queued(conn, screening_id)
        describe = llm.queue(conn, screening_id)   # perbarui dengan penjelasan untuk pasien
        detail = screening_detail(conn, load_screening(conn, screening_id), user)
    if describe:
        llm.start(screening_id)
    satusehat.send_in_background(screening_id)   # setelah commit, supaya pengirim membaca bacaan terbaru
    return detail


# --- Sinkronisasi data offline ---
# HP menyimpan pasien baru dan pemeriksaan di IndexedDB saat tidak ada sinyal, lalu mengirimnya ke sini.
# Foto diunggah lewat endpoint foto biasa (dengan client_id) dan pemeriksaan dikirim lewat endpoint submit.

def synced_id(conn, client_id: str, kind: str, user: dict) -> str | None:
    r = conn.execute("SELECT kind, server_id, user_id FROM sync_log WHERE client_id=?", (client_id,)).fetchone()
    if r is None:
        return None
    if r["kind"] != kind or r["user_id"] != user["id"]:
        raise HTTPException(409, "Kode data offline ini sudah dipakai data lain.")
    return r["server_id"]


def log_sync(conn, client_id: str, kind: str, server_id: str, user: dict):
    conn.execute("INSERT OR IGNORE INTO sync_log (client_id, kind, server_id, user_id, created_at) VALUES (?,?,?,?,?)",
                 (client_id, kind, server_id, user["id"], time.time()))


class SyncPatientBody(PatientBody):
    client_id: str = Field(min_length=8, max_length=64)


@router.post("/api/sync/patient")
def sync_patient(body: SyncPatientBody, user: dict = Depends(require_role("perawat", "dokter", "admin"))):
    """Pasien yang didaftarkan offline. NIK yang sudah terdaftar dipakai pasien lama (data lama tidak ditimpa)."""
    body.check_complete()
    with db() as conn:
        pid = synced_id(conn, body.client_id, "patient", user)
        merged = False
        if pid is None:
            old = body.nik and conn.execute("SELECT id FROM patients WHERE nik=?", (body.nik,)).fetchone()
            merged = bool(old)
            pid = old["id"] if old else insert_patient(conn, body, user)
            log_sync(conn, body.client_id, "patient", pid, user)
        row = conn.execute("SELECT * FROM patients WHERE id=?", (pid,)).fetchone()
        if row is None:
            raise HTTPException(410, "Pasien ini sudah dihapus dari server.")
    return {**patient_dict(row), "merged": merged}


class SyncScreeningBody(ScreeningCreate):
    client_id: str = Field(min_length=8, max_length=64)
    created_at: float


@router.post("/api/sync/screening")
def sync_screening(body: SyncScreeningBody, user: dict = Depends(require_role("perawat", "dokter", "admin"))):
    """Membuat draf pemeriksaan offline di server dengan waktu periksa aslinya. Kiriman ulang mengembalikan draf yang sama."""
    now = time.time()
    with db() as conn:
        sid = synced_id(conn, body.client_id, "screening", user)
        if sid is None:
            # Jam HP bisa salah; batasi ke 60 hari terakhir dan tidak di masa depan
            sid = insert_screening(conn, body, user, min(now, max(body.created_at, now - 60 * 86400)))
            log_sync(conn, body.client_id, "screening", sid, user)
        s = conn.execute("SELECT * FROM screenings WHERE id=?", (sid,)).fetchone()
        if s is None:
            raise HTTPException(410, "Pemeriksaan ini sudah dihapus dari server.")
        return screening_detail(conn, s, user)


@router.get("/api/summary")
def summary(user: dict = Depends(current_user)):
    """Angka ringkas untuk layar beranda masing-masing peran."""
    today = dt.datetime.combine(dt.date.today(), dt.time()).timestamp()
    with db() as conn:
        one = lambda sql, *a: conn.execute(sql, a).fetchone()[0]  # noqa: E731
        if user["role"] == "dokter":
            return {
                "waiting": one("SELECT COUNT(*) FROM screenings WHERE status='menunggu'"),
                "waiting_priority": one("SELECT COUNT(*) FROM screenings WHERE status='menunggu' AND ai_referable=1"),
                "read_today": one("SELECT COUNT(*) FROM screenings WHERE doctor_id=? AND reviewed_at>=?",
                                  user["id"], today),
            }
        return {
            "drafts": one("SELECT COUNT(*) FROM screenings WHERE status='draf' AND nurse_id=?", user["id"]),
            "waiting": one("SELECT COUNT(*) FROM screenings WHERE status='menunggu' AND nurse_id=?", user["id"]),
            "done_today": one("SELECT COUNT(*) FROM screenings WHERE nurse_id=? AND created_at>=?",
                              user["id"], today),
            "referred_unseen": one(
                "SELECT COUNT(*) FROM screenings WHERE nurse_id=? AND status='dibaca'"
                " AND decision IN ('rujuk_segera','rujuk','rujuk_lain','foto_ulang') AND reviewed_at>=?",
                user["id"], today - 6 * 86400),
            "patients": one("SELECT COUNT(*) FROM patients"),
        }
