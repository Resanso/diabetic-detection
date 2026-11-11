"""Tarif layanan dan pembayaran pemeriksaan.

Admin mengatur daftar tarif (Rp0 = gratis). Setiap pemeriksaan memakai satu tarif; nama dan harga disalin ke
pemeriksaan saat dipilih supaya perubahan tarif tidak mengubah tagihan lama. Pemeriksaan berbayar ditandai lunas
oleh perawat atau admin. Tagihan ikut dikirim ke SATUSEHAT bersama bacaan dokter (lihat satusehat.py).
"""
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth import current_user, require_role
from database import db

router = APIRouter()


def tariff_dict(r) -> dict:
    return {"id": r["id"], "name": r["name"], "price": r["price"], "description": r["description"],
            "active": bool(r["active"]), "is_default": bool(r["is_default"])}


def default_tariff(conn):
    return conn.execute("SELECT * FROM tariffs WHERE active=1 ORDER BY is_default DESC, price, created_at LIMIT 1").fetchone()


def apply_tariff(conn, screening_id: str, tariff_id: str | None):
    """Pasang tarif ke pemeriksaan. Tanpa tariff_id dipakai tarif bawaan."""
    t = (conn.execute("SELECT * FROM tariffs WHERE id=? AND active=1", (tariff_id,)).fetchone()
         if tariff_id else default_tariff(conn))
    if tariff_id and t is None:
        raise HTTPException(404, "Tarif tidak ditemukan atau sudah nonaktif.")
    if t is None:
        return
    conn.execute("UPDATE screenings SET tariff_id=?, tariff_name=?, tariff_price=?, paid_at=NULL, paid_by=NULL WHERE id=?",
                 (t["id"], t["name"], t["price"], screening_id))


def billing_of(s, p=None) -> dict | None:
    """Ringkasan biaya. p = baris pasien (cara bayar dan hasil cek kepesertaan SATUSEHAT)."""
    if s["tariff_id"] is None:
        return None
    price = s["tariff_price"] or 0
    payer = (p["payer"] if p else None) or "umum"
    covered = payer == "bpjs" and price > 0   # ditanggung BPJS: pasien tidak membayar, klinik menagih lewat klaim
    out = {"tariff_id": s["tariff_id"], "name": s["tariff_name"], "price": price, "free": price == 0,
           "paid": price == 0 or s["paid_at"] is not None, "paid_at": s["paid_at"],
           "payer": payer, "covered": covered, "coverage": None}
    if p and payer in ("bpjs", "asuransi"):
        out["payer_ref"] = p["bpjs_no"] if payer == "bpjs" else " ".join(x for x in (p["insurer"], p["policy_no"]) if x) or None
        out["patient_id"] = p["id"]
        if p["ss_cov_status"]:
            out["coverage"] = {"status": p["ss_cov_status"], "payor": p["ss_cov_payor"], "checked_at": p["ss_cov_checked_at"]}
    return out


def billing_for(conn, s) -> dict | None:
    p = conn.execute("SELECT * FROM patients WHERE id=?", (s["patient_id"],)).fetchone()
    return billing_of(s, p)


class TariffBody(BaseModel):
    name: str = Field(min_length=2, max_length=80)
    price: int = Field(ge=0, le=100_000_000)
    description: str | None = Field(None, max_length=200)
    active: bool = True
    is_default: bool = False


@router.get("/api/tariffs")
def list_tariffs(all: bool = False, user: dict = Depends(current_user)):
    with db() as conn:
        sql = "SELECT * FROM tariffs" + ("" if all and user["role"] == "admin" else " WHERE active=1")
        rows = conn.execute(sql + " ORDER BY active DESC, is_default DESC, price, name").fetchall()
    return [tariff_dict(r) for r in rows]


def _save(conn, tid: str, body: TariffBody):
    if body.is_default and not body.active:
        raise HTTPException(400, "Tarif bawaan harus aktif.")
    if body.is_default:
        conn.execute("UPDATE tariffs SET is_default=0 WHERE id<>?", (tid,))
    conn.execute("UPDATE tariffs SET name=?, price=?, description=?, active=?, is_default=? WHERE id=?",
                 (body.name.strip(), body.price, (body.description or "").strip() or None, int(body.active),
                  int(body.is_default), tid))
    if not conn.execute("SELECT 1 FROM tariffs WHERE is_default=1 AND active=1").fetchone():
        # selalu ada satu tarif bawaan untuk pemeriksaan dari aplikasi HP
        first = default_tariff(conn)
        if first:
            conn.execute("UPDATE tariffs SET is_default=1 WHERE id=?", (first["id"],))
    return tariff_dict(conn.execute("SELECT * FROM tariffs WHERE id=?", (tid,)).fetchone())


@router.post("/api/tariffs", dependencies=[Depends(require_role("admin"))])
def create_tariff(body: TariffBody):
    tid = uuid.uuid4().hex[:12]
    with db() as conn:
        conn.execute("INSERT INTO tariffs (id, name, price, created_at) VALUES (?,?,?,?)",
                     (tid, body.name.strip(), body.price, time.time()))
        return _save(conn, tid, body)


@router.put("/api/tariffs/{tariff_id}", dependencies=[Depends(require_role("admin"))])
def update_tariff(tariff_id: str, body: TariffBody):
    with db() as conn:
        if not conn.execute("SELECT 1 FROM tariffs WHERE id=?", (tariff_id,)).fetchone():
            raise HTTPException(404, "Tarif tidak ditemukan.")
        return _save(conn, tariff_id, body)


class ScreeningTariffBody(BaseModel):
    tariff_id: str


class PaymentBody(BaseModel):
    paid: bool


def _load(conn, screening_id: str):
    s = conn.execute("SELECT * FROM screenings WHERE id=?", (screening_id,)).fetchone()
    if s is None:
        raise HTTPException(404, "Pemeriksaan tidak ditemukan.")
    return s


@router.put("/api/screenings/{screening_id}/tariff")
def set_screening_tariff(screening_id: str, body: ScreeningTariffBody,
                         user: dict = Depends(require_role("perawat", "admin"))):
    with db() as conn:
        s = _load(conn, screening_id)
        if s["paid_at"]:
            raise HTTPException(409, "Pemeriksaan sudah lunas. Batalkan tanda lunas dulu untuk mengganti tarif.")
        apply_tariff(conn, screening_id, body.tariff_id)
        out = billing_for(conn, _load(conn, screening_id))
    _resend_if_sent(screening_id)
    return out


@router.post("/api/screenings/{screening_id}/payment")
def set_payment(screening_id: str, body: PaymentBody, user: dict = Depends(require_role("perawat", "admin"))):
    with db() as conn:
        s = _load(conn, screening_id)
        if s["tariff_id"] is None:
            raise HTTPException(400, "Pemeriksaan ini belum memakai tarif.")
        if (s["tariff_price"] or 0) == 0:
            raise HTTPException(400, "Tarif gratis tidak perlu ditandai lunas.")
        payer = conn.execute("SELECT payer FROM patients WHERE id=?", (s["patient_id"],)).fetchone()["payer"]
        if payer == "bpjs":
            raise HTTPException(400, "Pasien BPJS tidak membayar di klinik; biaya ditagihkan lewat klaim BPJS.")
        conn.execute("UPDATE screenings SET paid_at=?, paid_by=? WHERE id=?",
                     (time.time() if body.paid else None, user["id"] if body.paid else None, screening_id))
        out = billing_for(conn, _load(conn, screening_id))
    _resend_if_sent(screening_id)
    return out


def _resend_if_sent(screening_id: str):
    """Tagihan berubah setelah terkirim ke SATUSEHAT: kirim ulang supaya tagihan di sana ikut diperbarui."""
    import satusehat
    with db() as conn:
        s = _load(conn, screening_id)
        if s["status"] != "dibaca" or not s["ss_status"]:
            return
        satusehat.mark_queued(conn, screening_id)
    satusehat.send_in_background(screening_id)
