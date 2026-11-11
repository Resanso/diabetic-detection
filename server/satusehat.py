"""Kirim hasil skrining retina ke SATUSEHAT (Kemenkes) dalam format FHIR R4.

Kredensial dari SATUSEHAT Platform, menu Kode Akses API: SATUSEHAT_ORG_ID, SATUSEHAT_CLIENT_ID,
SATUSEHAT_CLIENT_SECRET. SATUSEHAT_ENV=sandbox (bawaan) atau production. Tanpa kredensial modul ini nonaktif.

Satu pemeriksaan yang sudah dibaca dokter dikirim sebagai satu kunjungan rawat jalan:
  1. Patient     cari nomor IHS pasien dari NIK          GET  Patient?identifier=.../nik|NIK
  2. Practitioner cari nomor IHS dokter pembaca dari NIK  GET  Practitioner?identifier=.../nik|NIK
  3. Location    ruang skrining milik organisasi          POST Location (sekali, lalu disimpan)
  4. Encounter   kunjungan, status in-progress            POST Encounter
  5. Observation tekanan darah, gula darah, HbA1c, hasil pemeriksaan mata (derajat DR per mata)
  6. Condition   diagnosis: E10.3/E11.3/E14.3 bila ada retinopati, Z13.5 (skrining mata) bila tidak
  7. Tagihan     bila pemeriksaan punya tarif (billing.py), modul Pembiayaan SATUSEHAT:
                 Account (akun pembiayaan; ditautkan ke Coverage BPJS/asuransi bila nomor kartunya cocok),
                 ChargeItem (layanan foto fundus + harga), Invoice (lunas/balanced bila gratis atau sudah dibayar),
                 PaymentReconciliation + PaymentNotice bila ditandai lunas
  8. Encounter   status finished + diagnosis + akun       PUT  Encounter/{id}

ID setiap resource disimpan di screenings.ss_refs, jadi kirim ulang memperbarui (PUT) resource yang sama,
tidak membuat data ganda. Waktu dikirim dalam UTC sesuai ketentuan SATUSEHAT.
"""
import datetime as dt
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool

from auth import current_user, require_role
from database import db

ENV = os.getenv("SATUSEHAT_ENV", "sandbox").strip().lower()
ORG_ID = os.getenv("SATUSEHAT_ORG_ID", "").strip()
CLIENT_ID = os.getenv("SATUSEHAT_CLIENT_ID", "").strip()
CLIENT_SECRET = os.getenv("SATUSEHAT_CLIENT_SECRET", "").strip()
LOCATION_ID = os.getenv("SATUSEHAT_LOCATION_ID", "").strip()
AUTO_SEND = os.getenv("SATUSEHAT_AUTO", "1") == "1"   # kirim otomatis setelah dokter menyimpan bacaan
_HOSTS = {
    "sandbox": "https://api-satusehat-stg.dto.kemkes.go.id",
    "production": "https://api-satusehat.kemkes.go.id",
}
BASE = os.getenv("SATUSEHAT_BASE_URL", _HOSTS.get(ENV, _HOSTS["sandbox"])).rstrip("/")
AUTH_URL = f"{BASE}/oauth2/v1"
FHIR_URL = f"{BASE}/fhir-r4/v1"
TIMEOUT = 20

NIK_SYSTEM = "https://fhir.kemkes.go.id/id/nik"
ICD10 = "http://hl7.org/fhir/sid/icd-10"
LOINC = "http://loinc.org"
UCUM = "http://unitsofmeasure.org"
OBS_CATEGORY = "http://terminology.hl7.org/CodeSystem/observation-category"

GRADE_TEXT = ["tidak ada retinopati", "NPDR ringan", "NPDR sedang", "NPDR berat", "PDR (proliferatif)"]
DECISION_TEXT = {
    "rujuk_segera": "Rujuk segera ke dokter spesialis mata",
    "rujuk": "Rujuk terjadwal ke dokter spesialis mata",
    "rujuk_lain": "Rujuk karena temuan mata lain",
    "ulang_6": "Skrining ulang 6 bulan",
    "ulang_12": "Skrining ulang 12 bulan",
    "normal": "Normal",
    "foto_ulang": "Foto retina perlu diulang",
}

router = APIRouter()


class SatusehatError(Exception):
    pass


def configured() -> bool:
    return bool(ORG_ID and CLIENT_ID and CLIENT_SECRET)


# ---------- HTTP ----------

_token: dict = {"value": None, "expires": 0.0}
_token_lock = threading.Lock()


def _read_error(e: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(e.read().decode() or "{}")
    except ValueError:
        return f"SATUSEHAT menolak permintaan (kode {e.code})."
    issues = body.get("issue") if isinstance(body, dict) else None
    if issues:
        msgs = []
        for i in issues[:3]:
            text = (i.get("details") or {}).get("text") or i.get("diagnostics") or i.get("code")
            if text:
                msgs.append(str(text))
        if msgs:
            return "; ".join(msgs)
    for k in ("error_description", "message", "error", "fault"):
        v = body.get(k) if isinstance(body, dict) else None
        if isinstance(v, str):
            return v
        if isinstance(v, dict) and isinstance(v.get("message"), str):
            return v["message"]
    return f"SATUSEHAT menolak permintaan (kode {e.code})."


def _open(req: urllib.request.Request) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            raw = r.read().decode()
    except urllib.error.HTTPError as e:
        raise SatusehatError(_read_error(e)) from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise SatusehatError(f"Server SATUSEHAT tidak bisa dihubungi ({getattr(e, 'reason', e)}).") from e
    try:
        return json.loads(raw) if raw else {}
    except ValueError as e:
        raise SatusehatError("Jawaban SATUSEHAT bukan JSON.") from e


def token() -> str:
    if not configured():
        raise SatusehatError("SATUSEHAT belum diatur. Isi SATUSEHAT_ORG_ID, SATUSEHAT_CLIENT_ID, SATUSEHAT_CLIENT_SECRET.")
    with _token_lock:
        if _token["value"] and time.time() < _token["expires"] - 60:
            return _token["value"]
        body = urllib.parse.urlencode({"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}).encode()
        req = urllib.request.Request(f"{AUTH_URL}/accesstoken?grant_type=client_credentials", data=body,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        d = _open(req)
        if not d.get("access_token"):
            raise SatusehatError("SATUSEHAT tidak memberi token akses. Periksa Client ID dan Client Secret.")
        _token["value"] = d["access_token"]
        _token["expires"] = time.time() + float(d.get("expires_in") or 3599)
        return _token["value"]


def fhir(method: str, path: str, body: dict | None = None, query: dict | None = None) -> dict:
    url = f"{FHIR_URL}/{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query, safe="|:/")
    headers = {"Authorization": f"Bearer {token()}", "Accept": "application/json"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    return _open(urllib.request.Request(url, data=data, headers=headers, method=method))


def _first(bundle: dict) -> dict | None:
    for e in bundle.get("entry") or []:
        if e.get("resource"):
            return e["resource"]
    return None


def find_by_nik(resource: str, nik: str) -> tuple[str, str] | None:
    """Patient atau Practitioner berdasarkan NIK. Mengembalikan (id IHS, nama) atau None."""
    r = _first(fhir("GET", resource, query={"identifier": f"{NIK_SYSTEM}|{nik}"}))
    if not r:
        return None
    names = r.get("name") or [{}]
    return r["id"], names[0].get("text") or " ".join(names[0].get("given", []) + [names[0].get("family", "")]).strip()


# ---------- Penyimpanan ----------

def setting(conn, key: str) -> str | None:
    r = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return r["value"] if r else None


def set_setting(conn, key: str, value: str):
    conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (key, value))


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).replace(microsecond=0).isoformat()


# ---------- Resource FHIR ----------

def _ref(kind: str, rid: str, display: str | None = None) -> dict:
    d = {"reference": f"{kind}/{rid}"}
    if display:
        d["display"] = display
    return d


def location_body() -> dict:
    return {
        "resourceType": "Location",
        "identifier": [{"system": f"http://sys-ids.kemkes.go.id/location/{ORG_ID}", "value": "RETINOVA-SKRINING"}],
        "status": "active",
        "name": "Ruang Skrining Retina Retinova",
        "description": "Skrining retinopati diabetik dengan foto fundus",
        "mode": "instance",
        "physicalType": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/location-physical-type",
                                     "code": "ro", "display": "Room"}]},
        "managingOrganization": {"reference": f"Organization/{ORG_ID}"},
    }


def ensure_location(conn) -> str:
    if LOCATION_ID:
        return LOCATION_ID
    saved = setting(conn, f"satusehat_location_{ENV}_{ORG_ID}")
    if saved:
        return saved
    # Cari dulu: Location dengan identifier yang sama mungkin sudah dibuat (basis data baru, server lain)
    ident = location_body()["identifier"][0]
    found = _first(fhir("GET", "Location", query={"identifier": f"{ident['system']}|{ident['value']}"}))
    rid = found["id"] if found else fhir("POST", "Location", location_body())["id"]
    set_setting(conn, f"satusehat_location_{ENV}_{ORG_ID}", rid)
    return rid


def diagnosis_code(s, patient) -> tuple[str, str]:
    grades = [g for g in (s["dr_grade_right"], s["dr_grade_left"]) if g is not None]
    if not grades or max(grades) == 0:
        return "Z13.5", "Special screening examination for eye and ear disorders"
    t = patient["diabetes_type"]
    if t == "tipe1":
        return "E10.3", "Insulin-dependent diabetes mellitus, with ophthalmic complications"
    if t == "tipe2":
        return "E11.3", "Non-insulin-dependent diabetes mellitus, with ophthalmic complications"
    if t == "tidak":
        return "H35.0", "Background retinopathy and retinal vascular changes"
    return "E14.3", "Unspecified diabetes mellitus, with ophthalmic complications"


def eye_narrative(s) -> str:
    def grade(g):
        return "tidak dinilai" if g is None else f"derajat {g}, {GRADE_TEXT[g]}"
    parts = [
        "Skrining retinopati diabetik dengan foto fundus (Retinova).",
        f"Mata kanan (OD): {grade(s['dr_grade_right'])}.",
        f"Mata kiri (OS): {grade(s['dr_grade_left'])}.",
    ]
    if s["dr_dme"] is not None:
        parts.append("Edema makula: dicurigai." if s["dr_dme"] else "Edema makula: tidak tampak.")
    if s["va_right"] or s["va_left"]:
        parts.append(f"Visus OD {s['va_right'] or '-'}, OS {s['va_left'] or '-'}.")
    if s["decision"]:
        parts.append(f"Tindak lanjut: {DECISION_TEXT.get(s['decision'], s['decision'])}.")
    if s["doctor_notes"]:
        parts.append(f"Catatan dokter: {s['doctor_notes']}")
    return " ".join(parts)


def observations(s, ctx: dict) -> dict[str, dict]:
    """Observation per kunci. Hanya data yang diisi yang dikirim."""
    def obs(category: str, code: str, display: str, **value) -> dict:
        return {
            "resourceType": "Observation",
            "status": "final",
            "category": [{"coding": [{"system": OBS_CATEGORY, "code": category,
                                      "display": {"vital-signs": "Vital Signs", "laboratory": "Laboratory",
                                                  "exam": "Exam"}[category]}]}],
            "code": {"coding": [{"system": LOINC, "code": code, "display": display}]},
            "subject": ctx["patient"],
            "performer": [ctx["practitioner"]],
            "encounter": ctx["encounter"],
            "effectiveDateTime": ctx["measured"],
            "issued": ctx["issued"],
            **value,
        }

    def qty(v, unit, code):
        return {"valueQuantity": {"value": v, "unit": unit, "system": UCUM, "code": code}}

    out = {}
    if s["systolic"] is not None:
        out["systolic"] = obs("vital-signs", "8480-6", "Systolic blood pressure", **qty(s["systolic"], "mm[Hg]", "mm[Hg]"))
    if s["diastolic"] is not None:
        out["diastolic"] = obs("vital-signs", "8462-4", "Diastolic blood pressure", **qty(s["diastolic"], "mm[Hg]", "mm[Hg]"))
    if s["glucose"] is not None:
        code, display = {
            "puasa": ("1558-6", "Fasting glucose [Mass/volume] in Serum or Plasma"),
            "2jpp": ("1521-4", "Glucose [Mass/volume] in Serum or Plasma --2 hours post meal"),
        }.get(s["glucose_kind"], ("2345-7", "Glucose [Mass/volume] in Serum or Plasma"))
        out["glucose"] = obs("laboratory", code, display, **qty(s["glucose"], "mg/dL", "mg/dL"))
    if s["hba1c"] is not None:
        out["hba1c"] = obs("laboratory", "4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood", **qty(s["hba1c"], "%", "%"))
    out["eye"] = obs("exam", "10197-2", "Physical findings of Eye Narrative", valueString=eye_narrative(s))
    return out


def encounter_body(s, ctx: dict, finished: bool, condition_id: str | None = None) -> dict:
    arrived, started, ended = ctx["arrived"], ctx["measured"], ctx["issued"]
    history = [
        {"status": "arrived", "period": {"start": arrived, "end": started}},
        {"status": "in-progress", "period": {"start": started, **({"end": ended} if finished else {})}},
    ]
    if finished:
        history.append({"status": "finished", "period": {"start": ended, "end": ended}})
    body = {
        "resourceType": "Encounter",
        "identifier": [{"system": f"http://sys-ids.kemkes.go.id/encounter/{ORG_ID}", "value": s["id"]}],
        "status": "finished" if finished else "in-progress",
        "class": {"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode", "code": "AMB", "display": "ambulatory"},
        "subject": ctx["patient"],
        "participant": [{
            "type": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v3-ParticipationType",
                                  "code": "ATND", "display": "attender"}]}],
            "individual": ctx["practitioner"],
        }],
        "period": {"start": arrived, **({"end": ended} if finished else {})},
        "location": [{"location": ctx["location"]}],
        "statusHistory": history,
        "serviceProvider": {"reference": f"Organization/{ORG_ID}"},
    }
    if finished and condition_id:
        body["diagnosis"] = [{
            "condition": _ref("Condition", condition_id, ctx["diagnosis_display"]),
            "use": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/diagnosis-role",
                                "code": "DD", "display": "Discharge diagnosis"}]},
            "rank": 1,
        }]
    return body


def condition_body(ctx: dict, code: str, display: str) -> dict:
    return {
        "resourceType": "Condition",
        "clinicalStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-clinical",
                                       "code": "active", "display": "Active"}]},
        "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/condition-category",
                                  "code": "encounter-diagnosis", "display": "Encounter Diagnosis"}]}],
        "code": {"coding": [{"system": ICD10, "code": code, "display": display}]},
        "subject": ctx["patient"],
        "encounter": ctx["encounter"],
        "recordedDate": ctx["issued"],
        "recorder": ctx["practitioner"],
    }


# ---------- Kirim satu pemeriksaan ----------

_send_lock = threading.Lock()


def _patient_ihs(conn, p) -> tuple[str, str]:
    if p["ihs_number"]:
        return p["ihs_number"], p["full_name"]
    if not p["nik"]:
        raise SatusehatError("Pasien belum punya NIK. Isi NIK di data pasien, SATUSEHAT mencari pasien dari NIK.")
    found = find_by_nik("Patient", p["nik"])
    if not found:
        raise SatusehatError(f"NIK pasien {p['nik'][:4]}********{p['nik'][-4:]} tidak ditemukan di SATUSEHAT"
                             + (" (sandbox hanya mengenal NIK pasien uji coba)." if ENV == "sandbox" else "."))
    conn.execute("UPDATE patients SET ihs_number=? WHERE id=?", (found[0], p["id"]))
    return found[0], p["full_name"]


def _practitioner_ihs(conn, user_id: int | None) -> tuple[str, str]:
    u = conn.execute("SELECT id, full_name, nik, ihs_number FROM users WHERE id=?", (user_id,)).fetchone() if user_id else None
    if u is None:
        raise SatusehatError("Dokter pembaca tidak tercatat.")
    if u["ihs_number"]:
        return u["ihs_number"], u["full_name"]
    if not u["nik"]:
        raise SatusehatError(f"Akun {u['full_name']} belum punya NIK. Admin mengisinya di menu Pengguna.")
    found = find_by_nik("Practitioner", u["nik"])
    if not found:
        raise SatusehatError(f"NIK {u['full_name']} tidak terdaftar sebagai tenaga kesehatan di SATUSEHAT.")
    conn.execute("UPDATE users SET ihs_number=? WHERE id=?", (found[0], u["id"]))
    return found[0], u["full_name"]


def find_coverage(patient_ihs: str, p) -> dict | None:
    """Coverage aktif milik pasien yang nomor kartunya sama dengan nomor BPJS/polis di data pasien.
    Data kepesertaan dikirim penjamin (BPJS/asuransi) ke SATUSEHAT; tanpa kecocokan nomor tidak ditautkan."""
    number = p["bpjs_no"] if p["payer"] == "bpjs" else p["policy_no"] if p["payer"] == "asuransi" else None
    if not number:
        return None
    for e in fhir("GET", "Coverage", query={"patient": patient_ihs}).get("entry") or []:
        r = e.get("resource") or {}
        ids = {r.get("subscriberId")} | {i.get("value") for i in r.get("identifier") or []}
        if r.get("status") == "active" and number in ids:
            return {"id": r["id"], "payor": ((r.get("payor") or [{}])[0]).get("display"), "period": r.get("period")}
    return None


def check_coverage(patient_id: str) -> dict:
    """Cek kepesertaan BPJS/asuransi pasien di SATUSEHAT dan simpan hasilnya di data pasien."""
    with db() as conn:
        p = conn.execute("SELECT * FROM patients WHERE id=?", (patient_id,)).fetchone()
        if p is None:
            raise SatusehatError("Pasien tidak ditemukan.")
        if p["payer"] not in ("bpjs", "asuransi"):
            raise SatusehatError("Cara bayar pasien bukan BPJS atau asuransi.")
        number = p["bpjs_no"] if p["payer"] == "bpjs" else p["policy_no"]
        if not number:
            raise SatusehatError("Isi nomor kartu BPJS atau nomor polis di data pasien dulu.")
        ihs, _ = _patient_ihs(conn, p)
    cov = find_coverage(ihs, p)
    with db() as conn:
        conn.execute("UPDATE patients SET ss_cov_status=?, ss_cov_id=?, ss_cov_payor=?, ss_cov_checked_at=? WHERE id=?",
                     ("aktif" if cov else "tidak_ditemukan", cov and cov["id"], cov and cov["payor"], time.time(), patient_id))
    return {"status": "aktif" if cov else "tidak_ditemukan", "payor": cov and cov["payor"],
            "period": cov and cov["period"], "checked_at": time.time()}


PAYER_TEXT = {"umum": "Bayar mandiri", "bpjs": "BPJS Kesehatan", "asuransi": "Asuransi"}


def billing_resources(s, p, ctx: dict, refs: dict, save) -> str:
    """Kirim tagihan satu pemeriksaan. Mengembalikan ID Account untuk ditautkan ke Encounter."""
    price = int(s["tariff_price"] or 0)
    money = {"value": price, "currency": "IDR"}
    paid = price == 0 or s["paid_at"] is not None
    org = {"reference": f"Organization/{ORG_ID}"}
    ident = lambda kind: [{"system": f"http://sys-ids.kemkes.go.id/{kind}/{ORG_ID}", "value": s["id"]}]  # noqa: E731

    found = find_coverage(ctx["patient"]["reference"].split("/")[1], p) if p["payer"] in ("bpjs", "asuransi") else None
    coverage = found and found["id"]
    account = {
        "resourceType": "Account",
        "identifier": ident("account"),
        "status": "active",
        "type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v3-ActCode",
                             "code": "PBILLACCT", "display": "patient billing account"}]},
        "name": f"Skrining retina {p['mrn']}, {PAYER_TEXT.get(p['payer'] or 'umum', 'Bayar mandiri')}",
        "subject": [ctx["patient"]],
        "servicePeriod": {"start": ctx["arrived"], "end": ctx["issued"]},
        "owner": org,
        **({"coverage": [{"coverage": {"reference": f"Coverage/{coverage}"}, "priority": 1}]} if coverage else {}),
    }
    account_id = _upsert(refs, "account", "Account", account)
    save()
    charge = {
        "resourceType": "ChargeItem",
        "identifier": ident("chargeitem"),
        "status": "billable",
        "code": {"coding": [{"system": "http://snomed.info/sct", "code": "20067007",
                             "display": "Ocular fundus photography"}], "text": s["tariff_name"]},
        "subject": ctx["patient"],
        "context": ctx["encounter"],
        "occurrencePeriod": {"start": ctx["measured"], "end": ctx["issued"]},
        "performer": [{"actor": ctx["practitioner"]}],
        "performingOrganization": org,
        "quantity": {"value": 1},
        "priceOverride": money,
        "enteredDate": ctx["issued"],
        "account": [{"reference": f"Account/{account_id}"}],
    }
    charge_id = _upsert(refs, "chargeitem", "ChargeItem", charge)
    save()
    invoice = {
        "resourceType": "Invoice",
        "identifier": ident("invoice"),
        "status": "balanced" if paid else "issued",
        "subject": ctx["patient"],
        "date": ctx["issued"],
        "issuer": org,
        "account": {"reference": f"Account/{account_id}"},
        "lineItem": [{"sequence": 1, "chargeItemReference": {"reference": f"ChargeItem/{charge_id}"},
                      "priceComponent": [{"type": "base", "amount": money}]}],
        "totalNet": money,
        "totalGross": money,
    }
    invoice_id = _upsert(refs, "invoice", "Invoice", invoice)
    save()

    if price > 0 and (s["paid_at"] is not None or refs.get("payment")):
        # Lunas: catat pembayaran. Tanda lunas dibatalkan: pembayaran yang sudah terkirim dibatalkan (cancelled).
        status = "active" if s["paid_at"] is not None else "cancelled"
        day = (_iso(s["paid_at"]) or ctx["issued"])[:10]
        recon = {
            "resourceType": "PaymentReconciliation",
            "identifier": ident("paymentreconciliation"),
            "status": status,
            "created": _iso(s["paid_at"]) or ctx["issued"],
            "paymentIssuer": org,
            "outcome": "complete",
            "disposition": f"Lunas, {PAYER_TEXT.get(p['payer'] or 'umum', 'Bayar mandiri').lower()}",
            "paymentDate": day,
            "paymentAmount": money,
            "detail": [{"type": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/payment-type",
                                             "code": "payment", "display": "Payment"}]},
                        "request": {"reference": f"Invoice/{invoice_id}"}, "date": day, "amount": money}],
        }
        recon_id = _upsert(refs, "payment", "PaymentReconciliation", recon)
        save()
        notice = {
            "resourceType": "PaymentNotice",
            "identifier": ident("paymentnotice"),
            "status": status,
            "request": {"reference": f"Invoice/{invoice_id}"},
            "created": _iso(s["paid_at"]) or ctx["issued"],
            "provider": org,
            "payment": {"reference": f"PaymentReconciliation/{recon_id}"},
            "paymentDate": day,
            "recipient": org,
            "amount": money,
            "paymentStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/payment-status",
                                          "code": "paid", "display": "Paid"}]},
        }
        _upsert(refs, "paymentnotice", "PaymentNotice", notice)
        save()
    return account_id


def _upsert(refs: dict, key: str, resource: str, body: dict) -> str:
    rid = refs.get(key)
    if rid:
        fhir("PUT", f"{resource}/{rid}", {**body, "id": rid})
        return rid
    rid = fhir("POST", resource, body)["id"]
    refs[key] = rid
    return rid


def _do_send(screening_id: str):
    with db() as conn:
        s = conn.execute("SELECT * FROM screenings WHERE id=?", (screening_id,)).fetchone()
        if s is None:
            raise SatusehatError("Pemeriksaan tidak ditemukan.")
        if s["status"] != "dibaca":
            raise SatusehatError("Pemeriksaan belum dibaca dokter.")
        p = conn.execute("SELECT * FROM patients WHERE id=?", (s["patient_id"],)).fetchone()
        patient_id, patient_name = _patient_ihs(conn, p)
        doc_id, doc_name = _practitioner_ihs(conn, s["doctor_id"])
        location_id = ensure_location(conn)
        refs = json.loads(s["ss_refs"] or "{}")

    code, display = diagnosis_code(s, p)
    arrived = _iso(s["created_at"])
    ctx = {
        "patient": _ref("Patient", patient_id, patient_name),
        "practitioner": _ref("Practitioner", doc_id, doc_name),
        "location": _ref("Location", location_id, "Ruang Skrining Retina Retinova"),
        "arrived": arrived,
        "measured": _iso(s["submitted_at"]) or arrived,
        "issued": _iso(s["reviewed_at"]),
        "diagnosis_display": display,
    }

    def save():
        with db() as conn:
            conn.execute("UPDATE screenings SET ss_refs=? WHERE id=?", (json.dumps(refs), screening_id))

    try:
        if not refs.get("encounter"):
            refs["encounter"] = fhir("POST", "Encounter", encounter_body(s, ctx, finished=False))["id"]
            save()
        ctx["encounter"] = _ref("Encounter", refs["encounter"])
        obs_refs = refs.setdefault("observation", {})
        for key, body in observations(s, ctx).items():
            _upsert(obs_refs, key, "Observation", body)
            save()
        condition_id = _upsert(refs, "condition", "Condition", condition_body(ctx, code, display))
        save()
        enc = encounter_body(s, ctx, True, condition_id)
        if s["tariff_id"]:
            enc["account"] = [{"reference": f"Account/{billing_resources(s, p, ctx, refs, save)}"}]
        fhir("PUT", f"Encounter/{refs['encounter']}", {**enc, "id": refs["encounter"]})
    finally:
        save()


def send_screening(screening_id: str) -> dict:
    """Kirim (atau kirim ulang) satu pemeriksaan. Status dan galat disimpan di tabel screenings."""
    with _send_lock:
        with db() as conn:
            conn.execute("UPDATE screenings SET ss_status='mengirim', ss_error=NULL WHERE id=?", (screening_id,))
        try:
            _do_send(screening_id)
            state = ("terkirim", None)
        except SatusehatError as e:
            state = ("gagal", str(e))
        except Exception as e:  # jangan biarkan status menggantung di 'mengirim'
            state = ("gagal", f"Galat tak terduga: {e}")
        with db() as conn:
            conn.execute("UPDATE screenings SET ss_status=?, ss_error=?, ss_sent_at=? WHERE id=?",
                         (state[0], state[1], time.time() if state[0] == "terkirim" else None, screening_id))
            return state_of(conn.execute("SELECT * FROM screenings WHERE id=?", (screening_id,)).fetchone())


def state_of(s) -> dict | None:
    """Ringkasan status SATUSEHAT untuk satu pemeriksaan (dipakai di detail pemeriksaan)."""
    if not configured() and not s["ss_status"]:
        return None
    refs = json.loads(s["ss_refs"] or "{}")
    return {"status": s["ss_status"], "error": s["ss_error"], "sent_at": s["ss_sent_at"],
            "encounter_id": refs.get("encounter"), "env": ENV}


def mark_queued(conn, screening_id: str):
    """Tandai 'mengirim' di transaksi bacaan dokter, supaya layar langsung menunjukkan status kirim."""
    if configured() and AUTO_SEND:
        conn.execute("UPDATE screenings SET ss_status='mengirim', ss_error=NULL WHERE id=?", (screening_id,))


def send_in_background(screening_id: str):
    if configured() and AUTO_SEND:
        threading.Thread(target=send_screening, args=(screening_id,), daemon=True).start()


# ---------- API ----------

@router.get("/api/satusehat/status", dependencies=[Depends(current_user)])
def status():
    return {"configured": configured(), "env": ENV, "org_id": ORG_ID or None, "auto": AUTO_SEND,
            "base_url": BASE}


@router.post("/api/satusehat/test", dependencies=[Depends(require_role("admin"))])
async def test_connection():
    """Coba ambil token dan baca data organisasi sendiri."""
    try:
        org = await run_in_threadpool(fhir, "GET", f"Organization/{ORG_ID}")
    except SatusehatError as e:
        raise HTTPException(502, str(e))
    return {"ok": True, "env": ENV, "organization": org.get("name"), "org_id": ORG_ID}


@router.post("/api/patients/{patient_id}/satusehat-coverage")
async def coverage_now(patient_id: str, user: dict = Depends(require_role("perawat", "dokter", "admin"))):
    if not configured():
        raise HTTPException(400, "SATUSEHAT belum diatur di server.")
    try:
        return await run_in_threadpool(check_coverage, patient_id)
    except SatusehatError as e:
        raise HTTPException(502 if "tidak bisa dihubungi" in str(e) else 400, str(e))


@router.post("/api/screenings/{screening_id}/satusehat")
async def send_now(screening_id: str, user: dict = Depends(require_role("dokter", "admin"))):
    if not configured():
        raise HTTPException(400, "SATUSEHAT belum diatur di server.")
    with db() as conn:
        s = conn.execute("SELECT status FROM screenings WHERE id=?", (screening_id,)).fetchone()
    if s is None:
        raise HTTPException(404, "Pemeriksaan tidak ditemukan.")
    if s["status"] != "dibaca":
        raise HTTPException(409, "Hanya pemeriksaan yang sudah dibaca dokter yang dikirim ke SATUSEHAT.")
    return await run_in_threadpool(send_screening, screening_id)
