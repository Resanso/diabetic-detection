import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowsClockwise, Camera, CaretRight, ChatText, Clock, PencilSimple, Trash } from "@phosphor-icons/react";
import { del, get, post, type Billing, type Decision, type Eye, type LlmState, type SatusehatState, type ScreeningDetail } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  DECISIONS,
  DIABETES_LABELS,
  GLUCOSE_KIND,
  GRADE_SHORT,
  ageOf,
  cap,
  fmtDate,
  fmtDateTime,
  fmtNum,
  fmtRp,
  fmtWaiting,
} from "../lib/format";
import { ActionBar, Banner, ConfirmDelete, DecisionChip, Field, GradeChip, Segmented, StatusChip, TopBar, useToast } from "../components/ui";
import { RetinaViewer } from "../components/RetinaViewer";
import { AiPanel } from "../components/AiPanel";
import { useStartScreening } from "./NewScreening";

const EYES: Eye[] = ["kanan", "kiri"];

function suggestDecision(right: number | null, left: number | null, dme: boolean | null, s: ScreeningDetail | null): Decision | null {
  const g = Math.max(right ?? -1, left ?? -1);
  if (g < 0) return null;
  if (dme || g >= 3) return "rujuk_segera";
  if (g === 2) return "rujuk";
  if (g === 1) return "ulang_6";
  return s && noDiabetes(s) ? "normal" : "ulang_12";
}

/** Tidak ada tanda diabetes: ditandai bukan diabetes di data pasien, atau belum ada diagnosis dan hasil lab
 *  hari ini di bawah ambang diagnosis (puasa < 126, sewaktu/2 jam PP < 200 mg/dL, HbA1c < 6,5%). Hanya saran. */
function noDiabetes(s: ScreeningDetail) {
  const t = s.patient.diabetes_type;
  if (t === "tidak") return true;
  if (t && t !== "tidak_tahu") return false;
  const lab: boolean[] = [];
  if (s.glucose != null) lab.push(s.glucose < (s.glucose_kind === "puasa" ? 126 : 200));
  if (s.hba1c != null) lab.push(s.hba1c < 6.5);
  return lab.length > 0 && lab.every(Boolean);
}

function GradePick({ value, onChange, label }: { value: number | null; onChange: (g: number | null) => void; label: string }) {
  return (
    <div className="gradepick" role="group" aria-label={label}>
      {GRADE_SHORT.map((name, g) => (
        <button
          key={g}
          type="button"
          aria-pressed={value === g}
          style={{ color: `var(--g${g})`, background: value === g ? `var(--g${g}-bg)` : undefined }}
          onClick={() => onChange(value === g ? null : g)}
        >
          <b>{g}</b>
          <span>{name}</span>
        </button>
      ))}
    </div>
  );
}

function ClinicalSummary({ s }: { s: ScreeningDetail }) {
  const p = s.patient;
  const age = ageOf(p.birth_date);
  const dmYears = p.diabetes_since ? new Date().getFullYear() - p.diabetes_since : null;
  return (
    <section className="card">
      <dl className="kv">
        <dt>Pasien</dt>
        <dd>
          <Link to={`/pasien/${p.id}`}>{p.full_name}</Link>
          <span className="muted" style={{ fontWeight: 400 }}>
            {", "}
            {p.sex === "L" ? "L" : p.sex === "P" ? "P" : ""}
            {age != null ? ` ${age} th` : ""}
          </span>
        </dd>
        <dt>Diabetes</dt>
        <dd>
          {p.diabetes_type ? DIABETES_LABELS[p.diabetes_type] : "-"}
          {dmYears != null ? `, ${dmYears} tahun` : ""}
          {p.on_insulin ? ", insulin" : ""}
        </dd>
        <dt>Hipertensi</dt>
        <dd>{p.hypertension == null ? "-" : p.hypertension ? "Ya" : "Tidak"}</dd>
        <dt>Gula darah</dt>
        <dd>{s.glucose != null ? `${fmtNum(s.glucose)} mg/dL (${GLUCOSE_KIND[s.glucose_kind ?? ""] ?? "-"})` : "-"}</dd>
        <dt>HbA1c</dt>
        <dd>{s.hba1c != null ? `${fmtNum(s.hba1c)} %` : "-"}</dd>
        <dt>Tekanan darah</dt>
        <dd>{s.systolic ? `${s.systolic}/${s.diastolic} mmHg` : "-"}</dd>
        <dt>Visus</dt>
        <dd>{s.va_right || s.va_left ? `OD ${s.va_right || "-"}, OS ${s.va_left || "-"}` : "-"}</dd>
        <dt>Keluhan</dt>
        <dd style={{ fontWeight: 400 }}>{s.complaints || "-"}</dd>
        {s.nurse_notes && (
          <>
            <dt>Catatan perawat</dt>
            <dd style={{ fontWeight: 400 }}>{s.nurse_notes}</dd>
          </>
        )}
        <dt>Diperiksa</dt>
        <dd style={{ fontWeight: 400 }}>
          {fmtDateTime(s.created_at)}
          {s.nurse_name ? ` oleh ${s.nurse_name}` : ""}
          {s.location ? `, ${s.location}` : ""}
        </dd>
      </dl>
    </section>
  );
}

function DoctorResult({ s }: { s: ScreeningDetail }) {
  if (!s.decision) return null;
  const d = DECISIONS[s.decision];
  const tone = d.tone === "segera" || d.tone === "rujuk" ? "danger" : d.tone === "ulang" ? "warn" : "ok";
  return (
    <section className="stack-sm">
      <Banner tone={tone}>
        <strong>{d.title}.</strong> {d.desc}
      </Banner>
      <div className="card">
        <dl className="kv">
          <dt>Mata kanan</dt>
          <dd>{s.dr_grade_right != null ? <GradeChip grade={s.dr_grade_right} /> : "Tidak dinilai"}</dd>
          <dt>Mata kiri</dt>
          <dd>{s.dr_grade_left != null ? <GradeChip grade={s.dr_grade_left} /> : "Tidak dinilai"}</dd>
          <dt>Edema makula</dt>
          <dd>{s.dr_dme == null ? "-" : s.dr_dme ? "Dicurigai" : "Tidak tampak"}</dd>
          {s.doctor_notes && (
            <>
              <dt>Catatan dokter</dt>
              <dd style={{ fontWeight: 400 }}>{s.doctor_notes}</dd>
            </>
          )}
          <dt>Dibaca</dt>
          <dd style={{ fontWeight: 400 }}>
            {fmtDateTime(s.reviewed_at)}
            {s.doctor_name ? ` oleh ${s.doctor_name}` : ""}
          </dd>
        </dl>
      </div>
    </section>
  );
}

/** Deskripsi dari model bahasa lokal: temuan visual dan ringkasan untuk dokter, penjelasan awam setelah dibaca. */
function LlmCard({ s, forDoctor, onChange }: { s: ScreeningDetail; forDoctor: boolean; onChange: (l: LlmState) => void }) {
  const l = s.llm;
  const [error, setError] = useState<string | null>(null);
  const making = l?.status === "membuat";

  useEffect(() => {
    if (!making) return;
    const t = setInterval(() => {
      get<ScreeningDetail>(`/api/screenings/${s.id}`)
        .then((d) => d.llm && d.llm.status !== "membuat" && onChange(d.llm))
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [making, s.id, onChange]);

  if (!l || s.status === "draf") return null;
  const hasDoctor = forDoctor && (l.ringkasan_dokter || l.mata_kanan || l.mata_kiri);
  const canMake = l.available && (forDoctor || s.status === "dibaca");
  if (!hasDoctor && !l.penjelasan_pasien && !making && !canMake && !l.error) return null;

  async function make() {
    setError(null);
    try {
      await post(`/api/screenings/${s.id}/llm`);
      onChange({ ...l!, status: "membuat", error: null });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="card stack-sm" aria-label="Deskripsi">
      <div className="section-head" style={{ margin: 0 }}>
        <h2 style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ChatText size={18} />
          Deskripsi
        </h2>
        {making && <span className="chip chip--menunggu">Sedang ditulis</span>}
      </div>
      {l.penjelasan_pasien && (
        <div className="stack-sm">
          <p className="t-label">Untuk pasien</p>
          <p>{l.penjelasan_pasien}</p>
        </div>
      )}
      {hasDoctor && (
        <dl className="kv">
          {l.ringkasan_dokter && (
            <>
              <dt>Ringkasan</dt>
              <dd style={{ fontWeight: 400 }}>{l.ringkasan_dokter}</dd>
            </>
          )}
          {l.vision && l.mata_kanan && (
            <>
              <dt>Foto mata kanan</dt>
              <dd style={{ fontWeight: 400 }}>{l.mata_kanan}</dd>
            </>
          )}
          {l.vision && l.mata_kiri && (
            <>
              <dt>Foto mata kiri</dt>
              <dd style={{ fontWeight: 400 }}>{l.mata_kiri}</dd>
            </>
          )}
        </dl>
      )}
      {!making && !hasDoctor && !l.penjelasan_pasien && !l.error && (
        <p className="muted">{s.status === "dibaca" || forDoctor ? "Belum ada deskripsi untuk pemeriksaan ini." : "Penjelasan untuk pasien dibuat setelah dokter membaca."}</p>
      )}
      {making && <p className="muted">Model bahasa di server sedang membaca foto dan data. Biasanya kurang dari 1 menit.</p>}
      {l.status === "gagal" && l.error && <Banner tone="danger">{l.error}</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}
      {(hasDoctor || l.penjelasan_pasien) && (
        <p className="t-caption">
          Ditulis model bahasa{l.model ? ` (${l.model.replace(/\.gguf$/, "")})` : ""} di server klinik. Bisa keliru, terutama membaca lesi kecil dari foto. Derajat dan keputusan resmi tetap dari dokter.
        </p>
      )}
      {canMake && !making && (
        <button className="btn btn--ghost btn--block" onClick={make}>
          <ArrowsClockwise size={18} />
          {hasDoctor || l.penjelasan_pasien ? "Tulis ulang" : "Buat deskripsi"}
        </button>
      )}
    </section>
  );
}

/** Biaya pemeriksaan dan tanda lunas. Perawat atau admin menandai lunas setelah pasien membayar. */
function BillingCard({ s, canPay, onChange }: { s: ScreeningDetail; canPay: boolean; onChange: (b: Billing) => void }) {
  const b = s.billing;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!b) return null;
  const insured = b.payer === "bpjs" || b.payer === "asuransi";
  const notFound = b.coverage?.status === "tidak_ditemukan";
  const payerName = b.payer === "bpjs" ? "BPJS Kesehatan" : b.payer === "asuransi" ? "Asuransi" : "Bayar sendiri";

  async function checkCoverage() {
    setChecking(true);
    setError(null);
    try {
      const c = await post<{ status: "aktif" | "tidak_ditemukan"; payor: string | null; checked_at: number }>(`/api/patients/${b!.patient_id}/satusehat-coverage`);
      onChange({ ...b!, coverage: c });
      toast(c.status === "aktif" ? "Kepesertaan ditemukan di SATUSEHAT" : "Kepesertaan tidak ditemukan di SATUSEHAT");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function setPaid(paid: boolean) {
    setBusy(true);
    setError(null);
    try {
      onChange(await post<Billing>(`/api/screenings/${s.id}/payment`, { paid }));
      toast(paid ? "Ditandai lunas" : "Tanda lunas dibatalkan");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack-sm" aria-label="Biaya">
      <div className="section-head" style={{ margin: 0 }}>
        <h2>Biaya</h2>
        <span className={`chip ${b.free ? "chip--draf" : notFound ? "chip--g2" : b.covered ? "chip--menunggu" : b.paid ? "chip--g0" : "chip--g2"}`}>
          {b.free ? "Gratis" : b.covered ? (notFound ? "Kepesertaan bermasalah" : "Ditanggung BPJS") : b.paid ? (b.payer === "asuransi" ? "Dibayar asuransi" : "Lunas") : "Belum dibayar"}
        </span>
      </div>
      <dl className="kv">
        <dt>Tarif</dt>
        <dd>{b.name}</dd>
        <dt>Jumlah</dt>
        <dd className="num">{fmtRp(b.price)}</dd>
        <dt>Cara bayar</dt>
        <dd>
          {payerName}
          {b.payer_ref && <span className="mono">, {b.payer_ref}</span>}
        </dd>
        {insured && (
          <>
            <dt>Kepesertaan</dt>
            <dd style={{ fontWeight: 400 }}>
              {!b.coverage
                ? "Belum dicek di SATUSEHAT"
                : b.coverage.status === "aktif"
                  ? `Aktif di SATUSEHAT${b.coverage.payor ? ` (${b.coverage.payor})` : ""}, dicek ${fmtDateTime(b.coverage.checked_at)}`
                  : `Tidak ditemukan di SATUSEHAT, dicek ${fmtDateTime(b.coverage.checked_at)}`}
            </dd>
          </>
        )}
        {b.paid_at && (
          <>
            <dt>Dibayar</dt>
            <dd style={{ fontWeight: 400 }}>{fmtDateTime(b.paid_at)}</dd>
          </>
        )}
      </dl>
      {b.coverage?.status === "tidak_ditemukan" && (
        <Banner tone="warn">
          Nomor {b.payer === "bpjs" ? "kartu BPJS" : "polis"} ini tidak terdaftar di SATUSEHAT. Periksa nomornya di data pasien, atau ganti cara bayar menjadi bayar sendiri.
        </Banner>
      )}
      {b.covered && !notFound && (
        <p className="t-caption">
          Pasien tidak membayar di klinik. {s.status === "dibaca" ? "Tagihan dikirim" : "Setelah dokter membaca, tagihan dikirim"} ke SATUSEHAT berstatus menunggu klaim.
        </p>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
      {insured && b.patient_id && (
        <button className="btn btn--ghost btn--block" disabled={checking} onClick={checkCoverage}>
          <ArrowsClockwise size={18} />
          {checking ? "Mengecek ke SATUSEHAT..." : "Cek kepesertaan di SATUSEHAT"}
        </button>
      )}
      {canPay && !b.free && !b.covered && (
        <button className={`btn btn--block ${b.paid ? "btn--ghost" : "btn--secondary"}`} disabled={busy} onClick={() => setPaid(!b.paid)}>
          {busy ? "Menyimpan..." : b.paid ? (b.payer === "asuransi" ? "Batalkan tanda dibayar" : "Batalkan tanda lunas") : b.payer === "asuransi" ? "Tandai dibayar asuransi" : "Tandai lunas"}
        </button>
      )}
    </section>
  );
}

/** Status kirim ke SATUSEHAT (Kemenkes). Bacaan dokter dikirim otomatis; tombol untuk kirim ulang bila gagal. */
function SatusehatCard({ s, canSend, onChange }: { s: ScreeningDetail; canSend: boolean; onChange: (st: SatusehatState) => void }) {
  const st = s.satusehat;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = busy || st?.status === "mengirim";

  useEffect(() => {
    if (st?.status !== "mengirim") return;
    const t = setInterval(() => {
      get<ScreeningDetail>(`/api/screenings/${s.id}`)
        .then((d) => d.satusehat && d.satusehat.status !== "mengirim" && onChange(d.satusehat))
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(t);
  }, [st?.status, s.id, onChange]);

  if (!st) return null;
  const env0 = st.env === "sandbox" ? " (sandbox)" : "";
  if (s.status !== "dibaca") {
    return (
      <section className="card stack-sm" aria-label="SATUSEHAT">
        <div className="section-head" style={{ margin: 0 }}>
          <h2>SATUSEHAT{env0}</h2>
          <span className="chip chip--draf">Menunggu bacaan dokter</span>
        </div>
        <p className="muted">
          Data dikirim ke SATUSEHAT setelah dokter menyimpan bacaan: kunjungan, tanda vital, gula darah, hasil pemeriksaan mata, diagnosis
          {s.billing ? ", dan tagihan" : ""}. Pasien harus punya NIK.
        </p>
      </section>
    );
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      onChange(await post<SatusehatState>(`/api/screenings/${s.id}/satusehat`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const env = st.env === "sandbox" ? " (sandbox)" : "";
  return (
    <section className="card stack-sm" aria-label="SATUSEHAT">
      <div className="section-head" style={{ margin: 0 }}>
        <h2>SATUSEHAT{env}</h2>
        <span className={`chip ${st.status === "terkirim" ? "chip--g0" : st.status === "gagal" ? "chip--g3" : "chip--menunggu"}`}>
          {sending ? "Mengirim" : st.status === "terkirim" ? "Terkirim" : st.status === "gagal" ? "Gagal" : "Belum dikirim"}
        </span>
      </div>
      {st.status === "terkirim" && (
        <p className="muted">
          Kunjungan, tanda vital, gula darah, hasil pemeriksaan mata, diagnosis{s.billing ? ", dan tagihan" : ""} tercatat {fmtDateTime(st.sent_at)}.
          {st.encounter_id && (
            <>
              {" "}
              ID kunjungan <span className="mono">{st.encounter_id}</span>.
            </>
          )}
        </p>
      )}
      {st.status === "gagal" && st.error && <Banner tone="danger">{st.error}</Banner>}
      {error && <Banner tone="danger">{error}</Banner>}
      {!sending && st.status !== "terkirim" && !st.error && <p className="muted">Bacaan ini belum dikirim ke SATUSEHAT.</p>}
      {!sending && !canSend && st.status !== "terkirim" && <p className="t-caption">Pengiriman dilakukan oleh dokter atau admin.</p>}
      {!sending && canSend && (
        <button className="btn btn--secondary btn--block" onClick={send}>
          <ArrowsClockwise size={18} />
          {st.status === "terkirim" ? "Kirim ulang" : st.status === "gagal" ? "Coba kirim lagi" : "Kirim ke SATUSEHAT"}
        </button>
      )}
    </section>
  );
}

export default function ScreeningView() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { start, busy: starting } = useStartScreening();
  const [s, setS] = useState<ScreeningDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eye, setEye] = useState<Eye>("kanan");
  const [imgId, setImgId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [gR, setGR] = useState<number | null>(null);
  const [gL, setGL] = useState<number | null>(null);
  const [dme, setDme] = useState<boolean | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [decisionTouched, setDecisionTouched] = useState(false);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setS(null);
    get<ScreeningDetail>(`/api/screenings/${id}`)
      .then((d) => {
        if (d.status === "draf" && (user?.role !== "dokter" || d.nurse_id === user.id)) return navigate(`/periksa/${d.id}`, { replace: true });
        setS(d);
        setEye(d.images.some((i) => i.eye === "kanan") ? "kanan" : "kiri");
        setGR(d.dr_grade_right);
        setGL(d.dr_grade_left);
        setDme(d.dr_dme);
        setDecision(d.decision);
        setDecisionTouched(!!d.decision);
        setNotes(d.doctor_notes ?? "");
        setEditing(false);
      })
      .catch((e) => setError(e.message));
  }, [id, navigate, user?.role]);

  useEffect(() => {
    if (!decisionTouched) setDecision(suggestDecision(gR, gL, dme, s));
  }, [gR, gL, dme, decisionTouched, s]);

  const images = useMemo(() => (s ? s.images.filter((i) => i.eye === eye) : []), [s, eye]);
  const image = images.find((i) => i.id === imgId) ?? images[images.length - 1];
  const onLlm = useCallback((l: LlmState) => setS((cur) => (cur ? { ...cur, llm: l } : cur)), []);
  const onBilling = useCallback((b: Billing) => setS((cur) => (cur ? { ...cur, billing: b } : cur)), []);
  const onSatusehat = useCallback((st: SatusehatState) => setS((cur) => (cur ? { ...cur, satusehat: st } : cur)), []);
  const isDoctor = user?.role === "dokter";
  const reviewing = isDoctor && s && (s.status === "menunggu" || editing);

  async function save() {
    if (!decision) return;
    setSaving(true);
    setError(null);
    try {
      const d = await post<ScreeningDetail>(`/api/screenings/${id}/review`, {
        grade_right: gR,
        grade_left: gL,
        dme,
        decision,
        notes,
      });
      toast("Bacaan tersimpan");
      setS(d);
      setEditing(false);
      if (s?.status === "menunggu") {
        // Lanjut ke kasus berikutnya di antrean agar dokter tidak perlu kembali ke daftar
        const next = await get<{ id: string }[]>("/api/screenings?status=menunggu&limit=1").catch(() => []);
        navigate(next[0] ? `/pemeriksaan/${next[0].id}` : "/bacaan", { replace: true });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!s)
    return (
      <>
        <TopBar title="Pemeriksaan" back={true} />
        <main className="page page--wide">{error ? <Banner tone="danger">{error}</Banner> : <div className="skeleton" style={{ height: 360 }} />}</main>
      </>
    );

  const age = ageOf(s.patient.birth_date);
  const title = s.patient.full_name;
  const who = [s.patient.sex, age != null ? `${age} th` : null].filter(Boolean).join(" ");
  const when = s.status === "menunggu" ? `menunggu ${fmtWaiting(s.submitted_at)}` : fmtDate(s.created_at);
  const sub = who ? `${who}, ${when}` : cap(when);

  return (
    <>
      <TopBar
        title={title}
        sub={sub}
        back={true}
        action={
          isDoctor && s.status === "dibaca" && !editing ? (
            <button className="btn btn--ghost" onClick={() => setEditing(true)}>
              <PencilSimple size={18} />
              Ubah bacaan
            </button>
          ) : user?.role === "admin" ? (
            <button className="btn btn--icon" aria-label="Hapus pemeriksaan" onClick={() => setConfirmDelete(true)}>
              <Trash size={20} />
            </button>
          ) : (
            <span style={{ paddingRight: 8 }}>
              <StatusChip status={s.status} decision={s.decision} />
            </span>
          )
        }
      />
      <main className={`page page--wide ${reviewing || (!isDoctor && s.decision) ? "page--flow" : ""}`}>
        {error && (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="danger">{error}</Banner>
          </div>
        )}
        <div className="review">
          <div className="stack">
            {!isDoctor && s.status === "menunggu" && (
              <Banner tone="info">
                <strong>Sudah terkirim.</strong> Hasil bacaan dokter akan muncul di sini dan di beranda. Pasien boleh pulang.
              </Banner>
            )}
            {!isDoctor && <DoctorResult s={s} />}

            <div className="tabs" role="tablist" aria-label="Pilih mata">
              {EYES.map((e) => {
                const n = s.images.filter((i) => i.eye === e).length;
                return (
                  <button
                    key={e}
                    role="tab"
                    className="tab"
                    aria-selected={eye === e}
                    onClick={() => {
                      setEye(e);
                      setImgId(null);
                    }}
                  >
                    Mata {e} <span className="muted">({e === "kanan" ? "OD" : "OS"}{n > 1 ? `, ${n} foto` : ""})</span>
                  </button>
                );
              })}
            </div>

            {image ? (
              <>
                <RetinaViewer image={image} label={eye === "kanan" ? "OD" : "OS"} modes={isDoctor || user?.role === "admin"} />
                {images.length > 1 && (
                  <div className="eye__more" role="group" aria-label="Foto lain">
                    {images.map((i, n) => (
                      <button key={i.id} aria-pressed={i.id === image.id} aria-label={`Foto ${n + 1}`} onClick={() => setImgId(i.id)}>
                        <img src={i.image_url} alt="" style={{ width: 48, height: 48 }} />
                      </button>
                    ))}
                  </div>
                )}
                {!image.quality.ok && !isDoctor && <Banner tone="warn">Kualitas foto kurang: {image.quality.issues.join(", ")}.</Banner>}
                <AiPanel image={image} threshold={s.ref_threshold} />
              </>
            ) : (
              <div className="viewer">
                <p className="viewer__missing">Mata {eye} tidak difoto pada pemeriksaan ini.</p>
              </div>
            )}
          </div>

          <div className="review__side stack">
            <ClinicalSummary s={s} />
            <LlmCard s={s} forDoctor={isDoctor || user?.role === "admin"} onChange={onLlm} />
            {!reviewing && <BillingCard s={s} canPay={user?.role === "perawat" || user?.role === "admin"} onChange={onBilling} />}

            {isDoctor && !reviewing && <DoctorResult s={s} />}
            {!reviewing && <SatusehatCard s={s} canSend={isDoctor || user?.role === "admin"} onChange={onSatusehat} />}

            {reviewing && (
              <section className="formgroup" aria-label="Bacaan dokter">
                <h2 className="formgroup__title">Bacaan dokter</h2>
                <Field label="Derajat mata kanan (OD)">{() => <GradePick label="Derajat mata kanan" value={gR} onChange={setGR} />}</Field>
                <Field label="Derajat mata kiri (OS)">{() => <GradePick label="Derajat mata kiri" value={gL} onChange={setGL} />}</Field>
                <Field label="Curiga edema makula">
                  {() => (
                    <Segmented
                      label="Curiga edema makula"
                      value={dme == null ? null : dme ? 1 : 0}
                      onChange={(v) => setDme(dme === (v === 1) ? null : v === 1)}
                      options={[
                        { value: 0, label: "Tidak" },
                        { value: 1, label: "Ya" },
                      ]}
                    />
                  )}
                </Field>
                <Field label="Keputusan" hint={!decisionTouched && decision ? "Disarankan dari derajat yang dipilih. Ketuk pilihan lain jika perlu." : undefined}>
                  {() => (
                    <div className="radiocards" role="radiogroup" aria-label="Keputusan">
                      {(Object.keys(DECISIONS) as Decision[]).map((k) => (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          className="radiocard"
                          aria-checked={decision === k}
                          onClick={() => {
                            setDecision(k);
                            setDecisionTouched(true);
                          }}
                        >
                          <span className="radiocard__dot" />
                          <span>
                            <span className="radiocard__title" style={{ display: "block" }}>
                              {DECISIONS[k].title}
                            </span>
                            <span className="radiocard__desc">{DECISIONS[k].desc}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </Field>
                <Field label="Catatan untuk perawat dan pasien" optional>
                  {(p) => <textarea {...p} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />}
                </Field>
              </section>
            )}

            {s.previous.length > 0 && (
              <section>
                <div className="section-head">
                  <h2>Pemeriksaan sebelumnya</h2>
                </div>
                <div className="list">
                  {s.previous.map((p) => (
                    <Link key={p.id} to={`/pemeriksaan/${p.id}`} className="row">
                      <Clock size={20} className="muted" />
                      <span className="row__body">
                        <span className="row__title" style={{ display: "block" }}>
                          {fmtDate(p.created_at)}
                        </span>
                        <span className="row__meta" style={{ display: "block" }}>
                          OD {p.dr_grade_right ?? "-"}, OS {p.dr_grade_left ?? "-"}
                        </span>
                      </span>
                      <span className="row__end">
                        {p.decision && <DecisionChip decision={p.decision} />}
                        <CaretRight size={16} />
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </main>

      {reviewing && (
        <ActionBar wide>
          {editing && (
            <button className="btn btn--secondary btn--lg" onClick={() => setEditing(false)}>
              Batal
            </button>
          )}
          <button className="btn btn--primary btn--lg" disabled={!decision || saving} onClick={save}>
            {saving ? "Menyimpan..." : !decision ? "Pilih derajat atau keputusan" : s.status === "menunggu" ? "Simpan dan lanjut" : "Simpan bacaan"}
          </button>
        </ActionBar>
      )}
      {confirmDelete && (
        <ConfirmDelete
          title="Hapus pemeriksaan ini?"
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await del(`/api/screenings/${s.id}`);
            toast("Pemeriksaan dihapus");
            navigate(`/pasien/${s.patient.id}`, { replace: true });
          }}
        >
          <p>
            Data klinis, {s.images.length} foto retina, perkiraan AI{s.status === "dibaca" ? ", dan bacaan dokter" : ""} untuk {s.patient.full_name} dihapus permanen. Data pasien tetap tersimpan.
          </p>
        </ConfirmDelete>
      )}
      {!isDoctor && s.status === "dibaca" && (user?.role === "perawat" || user?.role === "admin") && (
        <ActionBar>
          <button className="btn btn--primary btn--lg" disabled={starting} onClick={() => start(s.patient.id)}>
            <Camera size={22} />
            {s.decision === "foto_ulang" ? "Foto ulang sekarang" : "Pemeriksaan baru"}
          </button>
        </ActionBar>
      )}
    </>
  );
}
