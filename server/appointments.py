"""Akun pasien, jadwal praktik dokter, booking, dan antrean.

Alur: dokter/admin membuat jadwal mingguan (hari, jam, kuota). Pasien mendaftar sendiri, lalu booking satu sesi
(jadwal + tanggal) dan langsung mendapat nomor antrean. Di klinik, pasien menandai "sudah tiba" (atau petugas
yang mendaftarkan), dan dokter memanggil nomor berikutnya dari layar antrean.
Semua tanggal dan jam memakai zona waktu klinik (CLINIC_TZ, bawaan Asia/Jakarta).
"""
import datetime as dt
import hashlib
import os
import secrets
import sqlite3
import time
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

import bpjs
from auth import any_user, create_session, current_user, hash_password, public_user, require_patient
from clinic import CONSENT_VERSION, PayerFields, clean, new_id, next_mrn, reset_bpjs_if_changed, set_session_cookie
from security import client_ip
from database import db

router = APIRouter()

TZ = ZoneInfo(os.getenv("CLINIC_TZ", "Asia/Jakarta"))
BOOK_DAYS = int(os.getenv("BOOK_DAYS", "14"))          # booking paling jauh N hari ke depan
ONSITE_EARLY_MIN = 60                                   # antrean di tempat dibuka 60 menit sebelum praktik
WEEKDAYS = ("Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu")
ACTIVE = ("terdaftar", "hadir", "dipanggil")
CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def now_local() -> dt.datetime:
    return dt.datetime.now(TZ)


def session_bounds(date: dt.date, sched) -> tuple[dt.datetime, dt.datetime]:
    start = dt.datetime.combine(date, dt.time.fromisoformat(sched["start_time"]), TZ)
    end = dt.datetime.combine(date, dt.time.fromisoformat(sched["end_time"]), TZ)
    return start, end


def parse_date(s: str) -> dt.date:
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        raise HTTPException(422, "Format tanggal harus YYYY-MM-DD.")


def load_schedule(conn, schedule_id: str):
    s = conn.execute("SELECT * FROM doctor_schedules WHERE id=?", (schedule_id,)).fetchone()
    if s is None:
        raise HTTPException(404, "Jadwal tidak ditemukan.")
    return s


def session_counts(conn, schedule_id: str, date: str) -> dict:
    rows = conn.execute("SELECT status, COUNT(*) n FROM appointments WHERE schedule_id=? AND date=? GROUP BY status",
                        (schedule_id, date)).fetchall()
    c = {r["status"]: r["n"] for r in rows}
    c["booked"] = sum(n for k, n in c.items() if k != "batal")
    return c


def payer_ref(p) -> str | None:
    if p["payer"] == "bpjs":
        return p["bpjs_no"]
    if p["payer"] == "asuransi":
        return " ".join(x for x in (p["insurer"], p["policy_no"]) if x) or None
    return None


def insert_appointment(conn, *, patient, sched, date: str, source: str, status: str, complaint: str | None,
                       created_by: int | None) -> str:
    """Nomor antrean = nomor terbesar sesi itu + 1. Batal tetap memakai nomornya agar nomor tidak berulang."""
    if not patient["payer"]:
        raise HTTPException(422, "Pilih cara bayar (umum, BPJS, atau asuransi) di profil pasien dulu.")
    if patient["payer"] == "bpjs" and not patient["bpjs_no"]:
        raise HTTPException(422, "Nomor kartu BPJS belum diisi.")
    if conn.execute("SELECT 1 FROM appointments WHERE patient_id=? AND doctor_id=? AND date=? AND status IN"
                    " ('terdaftar','hadir','dipanggil')", (patient["id"], sched["doctor_id"], date)).fetchone():
        raise HTTPException(409, "Pasien sudah punya antrean aktif ke dokter ini pada tanggal tersebut.")
    aid, now = new_id(), time.time()
    for _ in range(5):
        no = conn.execute("SELECT COALESCE(MAX(queue_no), 0) + 1 FROM appointments WHERE schedule_id=? AND date=?",
                          (sched["id"], date)).fetchone()[0]
        code = "".join(secrets.choice(CODE_CHARS) for _ in range(6))
        try:
            conn.execute(
                "INSERT INTO appointments (id, code, patient_id, schedule_id, doctor_id, date, queue_no, source,"
                " payer, payer_ref, complaint, status, created_by, created_at, checked_in_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (aid, code, patient["id"], sched["id"], sched["doctor_id"], date, no, source, patient["payer"],
                 payer_ref(patient), clean(complaint), status, created_by, now, now if status == "hadir" else None))
            return aid
        except sqlite3.IntegrityError:
            continue
    raise HTTPException(503, "Antrean sedang ramai. Coba lagi.")


def appointment_dict(conn, a, *, with_patient: bool = False) -> dict:
    d = dict(a)
    sched = conn.execute("SELECT * FROM doctor_schedules WHERE id=?", (a["schedule_id"],)).fetchone()
    doc = conn.execute("SELECT full_name FROM users WHERE id=?", (a["doctor_id"],)).fetchone()
    d["doctor_name"] = doc["full_name"] if doc else None
    d["start_time"], d["end_time"], d["location"] = sched["start_time"], sched["end_time"], sched["location"]
    serving = conn.execute("SELECT MAX(queue_no) FROM appointments WHERE schedule_id=? AND date=?"
                           " AND status IN ('dipanggil','selesai')", (a["schedule_id"], a["date"])).fetchone()[0]
    d["now_serving"] = serving
    d["ahead"] = conn.execute(
        "SELECT COUNT(*) FROM appointments WHERE schedule_id=? AND date=? AND queue_no<? AND status IN"
        " ('terdaftar','hadir','dipanggil')", (a["schedule_id"], a["date"], a["queue_no"])).fetchone()[0]
    if with_patient:
        p = conn.execute("SELECT id, mrn, full_name, sex, birth_date, phone, payer, bpjs_no, bpjs_status, insurer"
                         " FROM patients WHERE id=?", (a["patient_id"],)).fetchone()
        d["patient"] = dict(p) if p else None
    return d


# --- Pendaftaran & profil pasien ---

_REG: dict[str, list[float]] = {}


def limit_registrations(request: Request):
    """Maksimal 5 pendaftaran per alamat IP per jam (di memori). IP dari nginx hanya dipercaya dari TRUSTED_PROXIES."""
    ip = client_ip(request)
    now = time.time()
    hits = [t for t in _REG.get(ip, []) if now - t < 3600]
    if len(hits) >= 5:
        raise HTTPException(429, "Terlalu banyak pendaftaran dari jaringan ini. Coba lagi nanti.")
    _REG[ip] = [*hits, now]


class RegisterBody(PayerFields):
    nik: str
    full_name: str = Field(min_length=2, max_length=100)
    birth_date: str
    sex: str
    phone: str = Field(min_length=8, max_length=20)
    password: str = Field(min_length=10, max_length=200)
    activation_code: str | None = Field(None, max_length=20)
    consent: bool = False

    @field_validator("nik")
    @classmethod
    def _nik(cls, v):
        v = v.strip()
        if not v.isdigit() or len(v) != 16:
            raise ValueError("NIK harus 16 digit angka")
        return v

    @field_validator("sex")
    @classmethod
    def _sex(cls, v):
        if v not in ("L", "P"):
            raise ValueError("jenis kelamin harus L atau P")
        return v

    @field_validator("birth_date")
    @classmethod
    def _birth(cls, v):
        d = dt.date.fromisoformat(v)
        if d > dt.date.today() or d.year < 1900:
            raise ValueError("tanggal lahir tidak masuk akal")
        return v


@router.post("/api/auth/register")
def register_patient(body: RegisterBody, request: Request, response: Response):
    """Pendaftaran mandiri pasien. Masuk berikutnya memakai NIK sebagai nama pengguna.
    Bila NIK sudah tercatat oleh petugas, akun dihubungkan ke data itu asalkan tanggal lahirnya sama."""
    if not body.payer:
        raise HTTPException(422, "Pilih cara bayar.")
    if not body.consent:
        raise HTTPException(422, "Setujui pemrosesan data kesehatan Anda untuk mendaftar.")
    body.check_complete()
    limit_registrations(request)
    now = time.time()
    with db() as conn:
        if conn.execute("SELECT 1 FROM users WHERE username=?", (body.nik,)).fetchone():
            raise HTTPException(409, "NIK ini sudah punya akun. Silakan masuk, atau hubungi petugas bila lupa kata sandi.")
        p = conn.execute("SELECT * FROM patients WHERE nik=?", (body.nik,)).fetchone()
        if p is not None:
            # Data yang sudah dicatat petugas hanya bisa dihubungkan dengan kode aktivasi dari petugas.
            # Tanggal lahir saja tidak cukup: tanggal lahir terbaca dari digit NIK.
            code = (body.activation_code or "").strip().upper()
            ok = (code and p["activation_hash"] and (p["activation_expires"] or 0) > now
                  and secrets.compare_digest(hashlib.sha256(code.encode()).hexdigest(), p["activation_hash"]))
            if not ok:
                raise HTTPException(409, "NIK ini sudah tercatat di klinik. Minta kode aktivasi ke petugas, lalu isi"
                                         " kode itu saat mendaftar.")
            pid = p["id"]
            conn.execute("UPDATE patients SET activation_hash=NULL, activation_expires=NULL WHERE id=?", (pid,))
            # Lengkapi yang kosong saja; data dari petugas tidak ditimpa
            conn.execute(
                "UPDATE patients SET birth_date=COALESCE(birth_date, ?), sex=COALESCE(sex, ?), phone=COALESCE(phone, ?),"
                " payer=?, bpjs_no=?, insurer=?, policy_no=?, updated_at=? WHERE id=?",
                (body.birth_date, body.sex, body.phone, body.payer, body.bpjs_no, clean(body.insurer),
                 clean(body.policy_no), now, pid))
            reset_bpjs_if_changed(conn, pid, p["bpjs_no"], body.bpjs_no)
        else:
            pid = new_id()
            conn.execute(
                "INSERT INTO patients (id, mrn, nik, full_name, sex, birth_date, phone, payer, bpjs_no, insurer,"
                " policy_no, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (pid, next_mrn(conn), body.nik, body.full_name.strip(), body.sex, body.birth_date, body.phone.strip(),
                 body.payer, body.bpjs_no, clean(body.insurer), clean(body.policy_no), now, now))
        conn.execute("UPDATE patients SET consent_at=COALESCE(consent_at, ?), consent_version=COALESCE(consent_version, ?)"
                     " WHERE id=?", (now, CONSENT_VERSION, pid))
        cur = conn.execute(
            "INSERT INTO users (username, full_name, role, password_hash, created_at, patient_id) VALUES (?,?,?,?,?,?)",
            (body.nik, body.full_name.strip(), "pasien", hash_password(body.password), now, pid))
        row = conn.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    set_session_cookie(response, create_session(row["id"]))
    return public_user(row)


PROFILE_FIELDS = ("id", "mrn", "nik", "full_name", "sex", "birth_date", "phone", "payer", "bpjs_no", "bpjs_status",
                  "bpjs_class", "bpjs_checked_at", "insurer", "policy_no")


def own_patient(conn, user: dict):
    p = conn.execute("SELECT * FROM patients WHERE id=?", (user["patient_id"],)).fetchone()
    if p is None:
        raise HTTPException(404, "Data pasien tidak ditemukan. Hubungi petugas.")
    return p


@router.get("/api/me/profile")
def my_profile(user: dict = Depends(require_patient)):
    with db() as conn:
        p = own_patient(conn, user)
    return {k: p[k] for k in PROFILE_FIELDS} | {"bpjs_enabled": bpjs.configured()}


class MyProfileBody(PayerFields):
    phone: str | None = Field(None, min_length=8, max_length=20)


@router.put("/api/me/profile")
def update_my_profile(body: MyProfileBody, user: dict = Depends(require_patient)):
    if not body.payer:
        raise HTTPException(422, "Pilih cara bayar.")
    body.check_complete()
    with db() as conn:
        p = own_patient(conn, user)
        conn.execute("UPDATE patients SET phone=COALESCE(?, phone), payer=?, bpjs_no=?, insurer=?, policy_no=?,"
                     " updated_at=? WHERE id=?",
                     (clean(body.phone), body.payer, body.bpjs_no if body.payer == "bpjs" else p["bpjs_no"],
                      clean(body.insurer), clean(body.policy_no), time.time(), p["id"]))
        if body.payer == "bpjs":
            reset_bpjs_if_changed(conn, p["id"], p["bpjs_no"], body.bpjs_no)
    return my_profile(user)


def verify_bpjs(patient_id: str) -> dict:
    """Cek kepesertaan ke BPJS dan simpan hasilnya di data pasien."""
    with db() as conn:
        p = conn.execute("SELECT * FROM patients WHERE id=?", (patient_id,)).fetchone()
    if p is None:
        raise HTTPException(404, "Pasien tidak ditemukan.")
    if not bpjs.configured():
        raise HTTPException(503, "Koneksi BPJS belum diaktifkan klinik. Nomor kartu tetap tersimpan dan dicek petugas.")
    if not p["bpjs_no"] and not p["nik"]:
        raise HTTPException(422, "Isi nomor kartu BPJS dulu.")
    try:
        r = bpjs.check_participant(card_no=p["bpjs_no"], nik=None if p["bpjs_no"] else p["nik"])
    except bpjs.BpjsError as e:
        raise HTTPException(502, str(e))
    status = "aktif" if r["active"] else "tidak_aktif"
    with db() as conn:
        conn.execute("UPDATE patients SET bpjs_status=?, bpjs_class=?, bpjs_checked_at=?, bpjs_no=COALESCE(bpjs_no, ?)"
                     " WHERE id=?", (status, r["class"], time.time(), r["card_no"], patient_id))
    return {"status": status, **r}


_BPJS_CHECKS: dict[int, list[float]] = {}


@router.post("/api/me/bpjs-check")
async def check_my_bpjs(user: dict = Depends(require_patient)):
    """Pasien hanya mendapat status aktif/tidak, bukan nama atau faskes pemegang kartu (nomor kartu bisa diketik
    siapa saja), dan dibatasi 3 kali per jam."""
    now = time.time()
    hits = [t for t in _BPJS_CHECKS.get(user["id"], []) if now - t < 3600]
    if len(hits) >= 3:
        raise HTTPException(429, "Cek kepesertaan dibatasi 3 kali per jam.")
    _BPJS_CHECKS[user["id"]] = [*hits, now]
    r = await run_in_threadpool(verify_bpjs, user["patient_id"])
    return {"status": r["status"], "active": r["active"], "status_text": r.get("status_text")}


@router.post("/api/patients/{patient_id}/bpjs-check", dependencies=[Depends(current_user)])
async def check_patient_bpjs(patient_id: str):
    return await run_in_threadpool(verify_bpjs, patient_id)


@router.get("/api/bpjs/status", dependencies=[Depends(any_user)])
def bpjs_status():
    return {"enabled": bpjs.configured()}


# --- Jadwal dokter ---

class ScheduleBody(BaseModel):
    doctor_id: int | None = None
    weekday: int = Field(ge=0, le=6)
    start_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    quota: int = Field(ge=1, le=200)
    location: str | None = Field(None, max_length=120)
    active: bool = True


def schedule_dict(conn, s) -> dict:
    d = dict(s)
    d["active"] = bool(s["active"])
    doc = conn.execute("SELECT full_name FROM users WHERE id=?", (s["doctor_id"],)).fetchone()
    d["doctor_name"] = doc["full_name"] if doc else None
    d["weekday_name"] = WEEKDAYS[s["weekday"]]
    return d


def can_edit_schedule(user: dict, s):
    if user["role"] == "admin" or (user["role"] == "dokter" and s["doctor_id"] == user["id"]):
        return
    raise HTTPException(403, "Hanya dokter pemilik jadwal atau admin yang bisa mengubahnya.")


def schedule_owner(user: dict, body_doctor: int | None) -> int:
    if user["role"] == "dokter":
        if body_doctor not in (None, user["id"]):
            raise HTTPException(403, "Dokter hanya bisa mengatur jadwalnya sendiri.")
        return user["id"]
    if user["role"] == "admin":
        if body_doctor is None:
            raise HTTPException(422, "Pilih dokter.")
        return body_doctor
    raise HTTPException(403, "Hanya dokter atau admin yang bisa mengatur jadwal.")


def validate_schedule(conn, body: ScheduleBody, doctor_id: int, exclude: str | None = None):
    if body.end_time <= body.start_time:
        raise HTTPException(422, "Jam selesai harus setelah jam mulai.")
    doc = conn.execute("SELECT role FROM users WHERE id=?", (doctor_id,)).fetchone()
    if doc is None or doc["role"] != "dokter":
        raise HTTPException(422, "Pengguna yang dipilih bukan dokter.")
    clash = conn.execute(
        "SELECT 1 FROM doctor_schedules WHERE doctor_id=? AND weekday=? AND active=1 AND id<>COALESCE(?, '')"
        " AND start_time < ? AND end_time > ?", (doctor_id, body.weekday, exclude, body.end_time, body.start_time)
    ).fetchone()
    if clash and body.active:
        raise HTTPException(409, "Jadwal ini bentrok dengan jadwal lain dokter yang sama di hari itu.")


@router.get("/api/schedules")
def list_schedules(doctor_id: int | None = None, user: dict = Depends(current_user)):
    sql, args = "SELECT * FROM doctor_schedules WHERE 1=1", []
    if doctor_id is not None:
        sql += " AND doctor_id=?"
        args.append(doctor_id)
    sql += " ORDER BY doctor_id, weekday, start_time"
    with db() as conn:
        return [schedule_dict(conn, s) for s in conn.execute(sql, args).fetchall()]


@router.post("/api/schedules")
def create_schedule(body: ScheduleBody, user: dict = Depends(current_user)):
    doctor_id = schedule_owner(user, body.doctor_id)
    with db() as conn:
        validate_schedule(conn, body, doctor_id)
        sid = new_id()
        conn.execute("INSERT INTO doctor_schedules (id, doctor_id, weekday, start_time, end_time, quota, location,"
                     " active, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                     (sid, doctor_id, body.weekday, body.start_time, body.end_time, body.quota, clean(body.location),
                      int(body.active), time.time()))
        return schedule_dict(conn, load_schedule(conn, sid))


@router.put("/api/schedules/{schedule_id}")
def update_schedule(schedule_id: str, body: ScheduleBody, user: dict = Depends(current_user)):
    with db() as conn:
        s = load_schedule(conn, schedule_id)
        can_edit_schedule(user, s)
        doctor_id = s["doctor_id"]  # pemilik jadwal tidak dipindah; buat jadwal baru untuk dokter lain
        validate_schedule(conn, body, doctor_id, exclude=schedule_id)
        if (body.weekday != s["weekday"] or body.start_time != s["start_time"]) and conn.execute(
                "SELECT 1 FROM appointments WHERE schedule_id=? AND date>=? AND status IN ('terdaftar','hadir')",
                (schedule_id, now_local().date().isoformat())).fetchone():
            raise HTTPException(409, "Sudah ada pasien yang booking jadwal ini. Ubah kuota atau lokasi saja, "
                                     "atau buat jadwal baru dan nonaktifkan yang ini.")
        conn.execute("UPDATE doctor_schedules SET weekday=?, start_time=?, end_time=?, quota=?, location=?, active=?"
                     " WHERE id=?", (body.weekday, body.start_time, body.end_time, body.quota, clean(body.location),
                                     int(body.active), schedule_id))
        return schedule_dict(conn, load_schedule(conn, schedule_id))


@router.delete("/api/schedules/{schedule_id}")
def delete_schedule(schedule_id: str, user: dict = Depends(current_user)):
    with db() as conn:
        s = load_schedule(conn, schedule_id)
        can_edit_schedule(user, s)
        if conn.execute("SELECT 1 FROM appointments WHERE schedule_id=?", (schedule_id,)).fetchone():
            # Riwayat antrean tetap butuh jadwalnya; cukup dinonaktifkan
            if conn.execute("SELECT 1 FROM appointments WHERE schedule_id=? AND date>=? AND status IN"
                            " ('terdaftar','hadir')", (schedule_id, now_local().date().isoformat())).fetchone():
                raise HTTPException(409, "Masih ada pasien yang booking jadwal ini. Batalkan antreannya dulu.")
            conn.execute("UPDATE doctor_schedules SET active=0 WHERE id=?", (schedule_id,))
            return {"ok": True, "deactivated": True}
        conn.execute("DELETE FROM doctor_schedules WHERE id=?", (schedule_id,))
    return {"ok": True, "deactivated": False}


# --- Slot (sesi per tanggal) ---

def build_slots(conn, *, doctor_id: int | None, start: dt.date, days: int, for_staff: bool) -> list[dict]:
    sql, args = "SELECT * FROM doctor_schedules WHERE active=1", []
    if doctor_id is not None:
        sql += " AND doctor_id=?"
        args.append(doctor_id)
    scheds = conn.execute(sql + " ORDER BY start_time", args).fetchall()
    doctors = {r["id"]: r for r in conn.execute("SELECT id, full_name, active FROM users WHERE role='dokter'")}
    now = now_local()
    out = []
    for i in range(days):
        date = start + dt.timedelta(days=i)
        for s in scheds:
            doc = doctors.get(s["doctor_id"])
            if s["weekday"] != date.weekday() or doc is None or not doc["active"]:
                continue
            begin, end = session_bounds(date, s)
            c = session_counts(conn, s["id"], date.isoformat())
            remaining = max(0, s["quota"] - c["booked"])
            slot = {
                "schedule_id": s["id"], "doctor_id": s["doctor_id"], "doctor_name": doc["full_name"],
                "date": date.isoformat(), "start_time": s["start_time"], "end_time": s["end_time"],
                "location": s["location"], "quota": s["quota"], "booked": c["booked"], "remaining": remaining,
                "bookable": remaining > 0 and now < end,
                "onsite_open": remaining > 0 and begin - dt.timedelta(minutes=ONSITE_EARLY_MIN) <= now < end,
            }
            if for_staff:
                slot["counts"] = {k: c.get(k, 0) for k in ("terdaftar", "hadir", "dipanggil", "selesai", "batal",
                                                           "tidak_hadir")}
            out.append(slot)
    out.sort(key=lambda x: (x["date"], x["start_time"]))
    return out


@router.get("/api/doctors")
def list_doctors(user: dict = Depends(any_user)):
    """Dokter yang punya jadwal aktif, untuk dipilih pasien saat booking."""
    with db() as conn:
        rows = conn.execute("SELECT u.id, u.full_name FROM users u WHERE u.role='dokter' AND u.active=1 AND EXISTS"
                            " (SELECT 1 FROM doctor_schedules s WHERE s.doctor_id=u.id AND s.active=1)"
                            " ORDER BY u.full_name").fetchall()
        return [{**dict(r), "schedules": [schedule_dict(conn, s) for s in conn.execute(
            "SELECT * FROM doctor_schedules WHERE doctor_id=? AND active=1 ORDER BY weekday, start_time",
            (r["id"],))]} for r in rows]


@router.get("/api/slots")
def list_slots(doctor_id: int | None = None, start: str | None = None,
               days: int | None = Query(None, ge=1, le=31), user: dict = Depends(any_user)):
    today = now_local().date()
    days = days or BOOK_DAYS + 1  # hari ini + BOOK_DAYS hari ke depan
    first = parse_date(start) if start else today
    staff = user["role"] != "pasien"
    if not staff:
        # Pasien hanya melihat jendela booking
        first = max(first, today)
        days = min(days, (today + dt.timedelta(days=BOOK_DAYS) - first).days + 1)
        if days <= 0:
            return []
    with db() as conn:
        return build_slots(conn, doctor_id=doctor_id, start=first, days=days, for_staff=staff)


# --- Booking oleh pasien ---

class BookBody(BaseModel):
    schedule_id: str
    date: str
    complaint: str | None = Field(None, max_length=300)
    onsite: bool = False


@router.get("/api/me/appointments")
def my_appointments(user: dict = Depends(require_patient)):
    with db() as conn:
        rows = conn.execute("SELECT * FROM appointments WHERE patient_id=? ORDER BY date DESC, created_at DESC"
                            " LIMIT 50", (user["patient_id"],)).fetchall()
        return [appointment_dict(conn, a) for a in rows]


@router.post("/api/me/appointments")
def book(body: BookBody, user: dict = Depends(require_patient)):
    date = parse_date(body.date)
    now = now_local()
    with db() as conn:
        s = load_schedule(conn, body.schedule_id)
        if not s["active"] or s["weekday"] != date.weekday():
            raise HTTPException(409, "Dokter tidak praktik pada sesi ini.")
        if not (now.date() <= date <= now.date() + dt.timedelta(days=BOOK_DAYS)):
            raise HTTPException(409, f"Booking hanya untuk hari ini sampai {BOOK_DAYS} hari ke depan.")
        begin, end = session_bounds(date, s)
        if now >= end:
            raise HTTPException(409, "Sesi praktik ini sudah selesai.")
        if body.onsite and not (date == now.date() and begin - dt.timedelta(minutes=ONSITE_EARLY_MIN) <= now):
            raise HTTPException(409, "Antrean di tempat dibuka satu jam sebelum praktik dimulai.")
        if session_counts(conn, s["id"], date.isoformat())["booked"] >= s["quota"]:
            raise HTTPException(409, "Kuota sesi ini sudah penuh. Pilih sesi lain.")
        aid = insert_appointment(conn, patient=own_patient(conn, user), sched=s, date=date.isoformat(),
                                 source="onsite" if body.onsite else "online",
                                 status="hadir" if body.onsite else "terdaftar", complaint=body.complaint,
                                 created_by=user["id"])
        return appointment_dict(conn, conn.execute("SELECT * FROM appointments WHERE id=?", (aid,)).fetchone())


def own_appointment(conn, user: dict, appointment_id: str):
    a = conn.execute("SELECT * FROM appointments WHERE id=? AND patient_id=?",
                     (appointment_id, user["patient_id"])).fetchone()
    if a is None:
        raise HTTPException(404, "Antrean tidak ditemukan.")
    return a


@router.post("/api/me/appointments/{appointment_id}/checkin")
def check_in(appointment_id: str, user: dict = Depends(require_patient)):
    with db() as conn:
        a = own_appointment(conn, user, appointment_id)
        if a["status"] != "terdaftar":
            raise HTTPException(409, "Antrean ini tidak bisa ditandai hadir.")
        if a["date"] != now_local().date().isoformat():
            raise HTTPException(409, "Tandai hadir hanya pada hari kunjungan, saat sudah di klinik.")
        conn.execute("UPDATE appointments SET status='hadir', checked_in_at=? WHERE id=?", (time.time(), a["id"]))
        return appointment_dict(conn, conn.execute("SELECT * FROM appointments WHERE id=?", (a["id"],)).fetchone())


@router.post("/api/me/appointments/{appointment_id}/cancel")
def cancel_mine(appointment_id: str, user: dict = Depends(require_patient)):
    with db() as conn:
        a = own_appointment(conn, user, appointment_id)
        if a["status"] not in ("terdaftar", "hadir"):
            raise HTTPException(409, "Antrean ini tidak bisa dibatalkan.")
        conn.execute("UPDATE appointments SET status='batal' WHERE id=?", (a["id"],))
        return appointment_dict(conn, conn.execute("SELECT * FROM appointments WHERE id=?", (a["id"],)).fetchone())


# --- Antrean (petugas) ---

@router.get("/api/queue")
def queue(date: str | None = None, doctor_id: int | None = None, user: dict = Depends(current_user)):
    """Sesi pada satu tanggal beserta daftar antreannya. Dokter melihat sesinya sendiri secara bawaan."""
    day = parse_date(date) if date else now_local().date()
    if doctor_id is None and user["role"] == "dokter":
        doctor_id = user["id"]
    with db() as conn:
        sessions = build_slots(conn, doctor_id=doctor_id, start=day, days=1, for_staff=True)
        for s in sessions:
            rows = conn.execute("SELECT * FROM appointments WHERE schedule_id=? AND date=? ORDER BY queue_no",
                                (s["schedule_id"], s["date"])).fetchall()
            s["appointments"] = [appointment_dict(conn, a, with_patient=True) for a in rows]
            called = [a for a in s["appointments"] if a["status"] == "dipanggil"]
            s["now_serving"] = called[-1]["queue_no"] if called else None
    return {"date": day.isoformat(), "today": now_local().date().isoformat(), "sessions": sessions}


ACTIONS = {
    # aksi: (status asal yang diizinkan, status baru, kolom waktu)
    "hadir": (("terdaftar", "tidak_hadir"), "hadir", "checked_in_at"),
    "panggil": (("terdaftar", "hadir", "tidak_hadir"), "dipanggil", "called_at"),
    "selesai": (("dipanggil", "hadir"), "selesai", "done_at"),
    "tidak_hadir": (("terdaftar", "hadir", "dipanggil"), "tidak_hadir", None),
    "batal": (("terdaftar", "hadir"), "batal", None),
    "kembalikan": (("selesai", "tidak_hadir", "batal"), "hadir", None),
}


class QueueAction(BaseModel):
    action: str

    @field_validator("action")
    @classmethod
    def _a(cls, v):
        if v not in ACTIONS:
            raise ValueError("aksi tidak dikenal")
        return v


@router.post("/api/queue/{appointment_id}")
def queue_action(appointment_id: str, body: QueueAction, user: dict = Depends(current_user)):
    allowed, new_status, ts_col = ACTIONS[body.action]
    with db() as conn:
        a = conn.execute("SELECT * FROM appointments WHERE id=?", (appointment_id,)).fetchone()
        if a is None:
            raise HTTPException(404, "Antrean tidak ditemukan.")
        if a["status"] not in allowed:
            raise HTTPException(409, f"Antrean berstatus {a['status'].replace('_', ' ')} tidak bisa diubah begitu.")
        now = time.time()
        if new_status == "dipanggil":
            # Satu pasien dipanggil per sesi: yang sedang dipanggil dianggap selesai
            conn.execute("UPDATE appointments SET status='selesai', done_at=? WHERE schedule_id=? AND date=?"
                         " AND status='dipanggil' AND id<>?", (now, a["schedule_id"], a["date"], a["id"]))
        sets = "status=?" + (f", {ts_col}=?" if ts_col else "")
        conn.execute(f"UPDATE appointments SET {sets} WHERE id=?",
                     (new_status, now, a["id"]) if ts_col else (new_status, a["id"]))
        return appointment_dict(conn, conn.execute("SELECT * FROM appointments WHERE id=?", (a["id"],)).fetchone(),
                                with_patient=True)


class CallNextBody(BaseModel):
    schedule_id: str
    date: str


@router.post("/api/queue-next")
def call_next(body: CallNextBody, user: dict = Depends(current_user)):
    """Selesaikan pasien yang sedang dipanggil, lalu panggil nomor terkecil yang sudah hadir."""
    with db() as conn:
        load_schedule(conn, body.schedule_id)
        nxt = conn.execute("SELECT id FROM appointments WHERE schedule_id=? AND date=? AND status='hadir'"
                           " ORDER BY queue_no LIMIT 1", (body.schedule_id, body.date)).fetchone()
        now = time.time()
        conn.execute("UPDATE appointments SET status='selesai', done_at=? WHERE schedule_id=? AND date=?"
                     " AND status='dipanggil'", (now, body.schedule_id, body.date))
        if nxt is None:
            waiting = conn.execute("SELECT COUNT(*) FROM appointments WHERE schedule_id=? AND date=?"
                                   " AND status='terdaftar'", (body.schedule_id, body.date)).fetchone()[0]
            return {"called": None, "not_arrived": waiting}
        conn.execute("UPDATE appointments SET status='dipanggil', called_at=? WHERE id=?", (now, nxt["id"]))
        return {"called": appointment_dict(conn, conn.execute("SELECT * FROM appointments WHERE id=?",
                                                              (nxt["id"],)).fetchone(), with_patient=True)}


class WalkInBody(BaseModel):
    patient_id: str
    schedule_id: str
    date: str | None = None
    complaint: str | None = Field(None, max_length=300)


@router.post("/api/queue-walkin")
def walk_in(body: WalkInBody, user: dict = Depends(current_user)):
    """Petugas mendaftarkan pasien yang datang langsung. Boleh melebihi kuota; pasien langsung berstatus hadir."""
    date = parse_date(body.date) if body.date else now_local().date()
    with db() as conn:
        s = load_schedule(conn, body.schedule_id)
        if s["weekday"] != date.weekday():
            raise HTTPException(409, "Dokter tidak praktik pada sesi ini di tanggal tersebut.")
        p = conn.execute("SELECT * FROM patients WHERE id=?", (body.patient_id,)).fetchone()
        if p is None:
            raise HTTPException(404, "Pasien tidak ditemukan.")
        aid = insert_appointment(conn, patient=p, sched=s, date=date.isoformat(), source="onsite",
                                 status="hadir" if date == now_local().date() else "terdaftar",
                                 complaint=body.complaint, created_by=user["id"])
        return appointment_dict(conn, conn.execute("SELECT * FROM appointments WHERE id=?", (aid,)).fetchone(),
                                with_patient=True)
