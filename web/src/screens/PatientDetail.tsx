import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Camera, PencilSimple, ClockCounterClockwise, Key, Trash } from "@phosphor-icons/react";
import { del, get, post, type Patient, type ScreeningSummary } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ageOf, cap, DIABETES_LABELS, PAYER_LABELS, fmtDate, fmtWhen } from "../lib/format";
import { ActionBar, Banner, ConfirmDelete, Empty, SkeletonRows, TopBar, useAsync, useToast } from "../components/ui";
import { ScreeningRow } from "../components/ScreeningRow";
import { useStartScreening } from "./NewScreening";
import { findPatient, isLocalId } from "../lib/offline/store";
import { isNetworkError } from "../lib/offline/sync";

type Detail = Patient & { screenings: ScreeningSummary[] };

/** Dari server; tanpa sinyal (atau pasien yang didaftarkan offline) dari salinan di HP, tanpa riwayat pemeriksaan. */
async function loadPatient(id: string): Promise<Detail> {
  if (!isLocalId(id)) {
    try {
      return await get<Detail>(`/api/patients/${id}`);
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  const p = await findPatient(id);
  if (!p) throw new Error("Tidak ada sinyal, dan data pasien ini belum tersimpan di HP.");
  return { ...p, screenings: [] };
}

const yn = (v: boolean | null) => (v == null ? "-" : v ? "Ya" : "Tidak");

export default function PatientDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const { start, busy, error: startError } = useStartScreening();
  const { data: p, error, loading } = useAsync(() => loadPatient(id!), [id]);
  const offlineCopy = isLocalId(p?.id);
  const navigate = useNavigate();
  const toast = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [code, setCode] = useState<{ code: string; expires_in_hours: number } | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const canIssueCode = user?.role === "admin" || user?.role === "perawat";
  async function issueCode() {
    setCodeError(null);
    try {
      setCode(await post<{ code: string; expires_in_hours: number }>(`/api/patients/${id}/activation-code`));
    } catch (err) {
      setCodeError((err as Error).message);
    }
  }
  const canScreen = !!user;
  // Admin selalu boleh; pendaftar hanya selama belum ada pemeriksaan yang dikirim (server memeriksa ulang)
  const canDelete = !!p && !offlineCopy && (user?.role === "admin" || (p.created_by === user?.id && p.screenings.every((s) => s.status === "draf")));
  const age = ageOf(p?.birth_date);

  return (
    <>
      <TopBar
        title={p?.full_name ?? "Pasien"}
        sub={p ? <span className="mono">{p.mrn}</span> : undefined}
        back={true}
        action={
          p && !offlineCopy && (
            <Link to={`/pasien/${p.id}/ubah`} className="btn btn--ghost">
              <PencilSimple size={18} />
              Ubah
            </Link>
          )
        }
      />
      <main className={`page ${canScreen ? "page--flow" : ""} stack-lg`}>
        {error && <Banner tone="danger">{error}</Banner>}
        {startError && <Banner tone="danger">{startError}</Banner>}
        {loading && !p && <SkeletonRows rows={2} />}
        {offlineCopy && (
          <Banner tone="info">Pasien ini didaftarkan tanpa sinyal dan belum terkirim ke server. Data dikirim otomatis saat ada sinyal.</Banner>
        )}
        {p && (
          <>
            <section className="card">
              <dl className="kv">
                <dt>Jenis kelamin</dt>
                <dd>{p.sex === "L" ? "Laki-laki" : p.sex === "P" ? "Perempuan" : "-"}</dd>
                <dt>Umur</dt>
                <dd>{age != null ? `${age} tahun (${fmtDate(new Date(p.birth_date!).getTime() / 1000)})` : "-"}</dd>
                <dt>NIK</dt>
                <dd className="num">{p.nik ?? "-"}</dd>
                <dt>No. HP</dt>
                <dd className="num">{p.phone ? <a href={`tel:${p.phone}`}>{p.phone}</a> : "-"}</dd>
                <dt>Alamat</dt>
                <dd>{p.address ?? "-"}</dd>
                <dt>Cara bayar</dt>
                <dd>
                  {p.payer ? PAYER_LABELS[p.payer] : "-"}
                  {p.payer === "bpjs" && p.bpjs_no && (
                    <>
                      , <span className="mono">{p.bpjs_no}</span>
                      {p.bpjs_status && <span className={`chip ${p.bpjs_status === "aktif" ? "chip--g0" : "chip--g3"}`} style={{ marginLeft: 8 }}>{p.bpjs_status === "aktif" ? "Aktif" : "Tidak aktif"}</span>}
                    </>
                  )}
                  {p.payer === "asuransi" && `, ${p.insurer ?? ""}${p.policy_no ? ` ${p.policy_no}` : ""}`}
                </dd>
              </dl>
            </section>
            <section className="card">
              <h2 className="t-label muted" style={{ marginBottom: 8 }}>
                Riwayat diabetes
              </h2>
              <dl className="kv">
                <dt>Jenis</dt>
                <dd>{p.diabetes_type ? DIABETES_LABELS[p.diabetes_type] : "-"}</dd>
                <dt>Sejak</dt>
                <dd>{p.diabetes_since ? `${p.diabetes_since} (${new Date().getFullYear() - p.diabetes_since} tahun)` : "-"}</dd>
                <dt>Insulin</dt>
                <dd>{yn(p.on_insulin)}</dd>
                <dt>Hipertensi</dt>
                <dd>{yn(p.hypertension)}</dd>
                {p.notes && (
                  <>
                    <dt>Catatan</dt>
                    <dd style={{ fontWeight: 400 }}>{p.notes}</dd>
                  </>
                )}
              </dl>
            </section>

            <section>
              <div className="section-head">
                <h2>Riwayat pemeriksaan</h2>
                <span className="t-caption">{p.screenings.length} kali</span>
              </div>
              {p.screenings.length ? (
                <div className="list">
                  {p.screenings.map((s) => (
                    <ScreeningRow key={s.id} s={s} title={cap(fmtWhen(s.created_at))} meta={s.nurse_name ? `Oleh ${s.nurse_name}${s.location ? `, ${s.location}` : ""}` : (s.location ?? "")} />
                  ))}
                </div>
              ) : (
                <Empty icon={ClockCounterClockwise}>Pasien ini belum pernah diperiksa.</Empty>
              )}
            </section>

            {canIssueCode && (
              <section className="formgroup">
                <h2 className="formgroup__title">Akun pasien</h2>
                <p className="t-caption">
                  Pasien yang ingin melihat hasil di aplikasi butuh kode aktivasi dari petugas. Berikan kode secara
                  langsung, bukan lewat pesan grup.
                </p>
                {codeError && <Banner tone="danger">{codeError}</Banner>}
                {code ? (
                  <p>
                    Kode: <b className="mono" style={{ fontSize: 22, letterSpacing: 2 }}>{code.code}</b>{" "}
                    <span className="t-caption">berlaku {code.expires_in_hours} jam, sekali pakai</span>
                  </p>
                ) : (
                  <button className="btn btn--ghost" onClick={issueCode}>
                    <Key size={18} />
                    Buat kode aktivasi
                  </button>
                )}
              </section>
            )}

            {canDelete && (
              <button className="btn btn--danger btn--block" onClick={() => setConfirmDelete(true)}>
                <Trash size={20} />
                Hapus pasien
              </button>
            )}
          </>
        )}
      </main>
      {confirmDelete && p && (
        <ConfirmDelete
          title={`Hapus ${p.full_name}?`}
          label="Hapus pasien"
          typeToConfirm={p.screenings.length ? "HAPUS" : undefined}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await del(`/api/patients/${p.id}`);
            toast("Pasien dihapus");
            navigate("/pasien", { replace: true });
          }}
        >
          <p>
            Data pasien <span className="mono">{p.mrn}</span>
            {p.screenings.length ? `, ${p.screenings.length} pemeriksaan, dan semua foto retinanya` : ""} dihapus permanen dan tidak bisa dikembalikan.
          </p>
        </ConfirmDelete>
      )}
      {canScreen && p && (
        <ActionBar>
          <button className="btn btn--primary btn--lg" disabled={busy} onClick={() => start(p)}>
            <Camera size={22} />
            {busy ? "Menyiapkan..." : "Periksa sekarang"}
          </button>
        </ActionBar>
      )}
    </>
  );
}
