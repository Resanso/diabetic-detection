import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarBlank, Camera, CaretLeft, CaretRight, MegaphoneSimple, UserPlus } from "@phosphor-icons/react";
import { get, post, type Appointment, type ApptStatus, type DoctorWithSchedules, type Patient, type QueueSession } from "../lib/api";
import { useAuth } from "../lib/auth";
import { APPT_STATUS, PAYER_LABELS, addDays, ageOf, fmtDay, queueLabel } from "../lib/format";
import { Banner, Empty, Segmented, Sheet, SkeletonRows, TopBar, useAsync, useToast } from "../components/ui";
import { PatientSearch } from "../components/PatientSearch";
import { useStartScreening } from "./NewScreening";

const STATUS_CHIP: Record<ApptStatus, string> = {
  terdaftar: "chip--draf",
  hadir: "chip--menunggu",
  dipanggil: "chip--aktif",
  selesai: "chip--g0",
  batal: "chip--draf",
  tidak_hadir: "chip--g1",
};

const ACTIONS: { action: string; label: string; from: ApptStatus[]; tone?: "danger" }[] = [
  { action: "panggil", label: "Panggil sekarang", from: ["terdaftar", "hadir", "tidak_hadir"] },
  { action: "hadir", label: "Tandai hadir", from: ["terdaftar", "tidak_hadir"] },
  { action: "selesai", label: "Selesai dilayani", from: ["dipanggil", "hadir"] },
  { action: "tidak_hadir", label: "Tidak hadir saat dipanggil", from: ["terdaftar", "hadir", "dipanggil"], tone: "danger" },
  { action: "batal", label: "Batalkan antrean", from: ["terdaftar", "hadir"], tone: "danger" },
  { action: "kembalikan", label: "Kembalikan ke antrean", from: ["selesai", "tidak_hadir", "batal"] },
];

function payerText(a: Appointment) {
  return a.payer === "bpjs" ? `BPJS${a.patient?.bpjs_status === "aktif" ? " aktif" : ""}` : PAYER_LABELS[a.payer];
}

function ApptSheet({ a, onClose, onDone }: { a: Appointment; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { start, busy: starting } = useStartScreening();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const age = ageOf(a.patient?.birth_date);

  async function act(action: string, label: string) {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/queue/${a.id}`, { action });
      toast(`${queueLabel(a.queue_no)}: ${label.toLowerCase()}`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet title={`${queueLabel(a.queue_no)} ${a.patient?.full_name ?? ""}`} onClose={onClose}>
      <div className="stack">
        {error && <Banner tone="danger">{error}</Banner>}
        <dl className="kv">
          <dt>Pasien</dt>
          <dd>
            {[a.patient?.sex, age != null ? `${age} th` : null].filter(Boolean).join(", ") || "-"}, <span className="mono">{a.patient?.mrn}</span>
          </dd>
          <dt>Cara bayar</dt>
          <dd>
            {payerText(a)}
            {a.payer_ref && <span className="mono">, {a.payer_ref}</span>}
          </dd>
          <dt>Daftar</dt>
          <dd>{a.source === "onsite" ? "Di klinik" : "Booking online"}</dd>
          <dt>Keluhan</dt>
          <dd style={{ fontWeight: 400 }}>{a.complaint || "-"}</dd>
          {a.patient?.phone && (
            <>
              <dt>No. HP</dt>
              <dd className="num">
                <a href={`tel:${a.patient.phone}`}>{a.patient.phone}</a>
              </dd>
            </>
          )}
        </dl>
        <div className="stack-sm">
          {ACTIONS.filter((x) => x.from.includes(a.status)).map((x) => (
            <button key={x.action} className={`btn btn--block ${x.tone ? "btn--danger" : "btn--secondary"}`} disabled={busy} onClick={() => act(x.action, x.label)}>
              {x.label}
            </button>
          ))}
          <button className="btn btn--primary btn--block" disabled={starting} onClick={() => start(a.patient_id)}>
            <Camera size={20} />
            {starting ? "Menyiapkan..." : "Mulai pemeriksaan retina"}
          </button>
          <Link to={`/pasien/${a.patient_id}`} className="btn btn--ghost btn--block">
            Buka data pasien
          </Link>
        </div>
      </div>
    </Sheet>
  );
}

function WalkInSheet({ sessions, onClose, onDone }: { sessions: QueueSession[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [sessionKey, setSessionKey] = useState(sessions.length === 1 ? sessions[0].schedule_id : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!patient || !sessionKey) return;
    setBusy(true);
    setError(null);
    try {
      const s = sessions.find((x) => x.schedule_id === sessionKey)!;
      const a = await post<Appointment>("/api/queue-walkin", { patient_id: patient.id, schedule_id: s.schedule_id, date: s.date });
      toast(`${patient.full_name} mendapat nomor ${queueLabel(a.queue_no)}`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Sheet title="Pasien datang langsung" onClose={onClose}>
      <div className="stack">
        {error && <Banner tone="danger">{error}</Banner>}
        {patient ? (
          <>
            <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <span>
                <span className="t-label" style={{ display: "block" }}>
                  {patient.full_name}
                </span>
                <span className="t-caption">
                  <span className="mono">{patient.mrn}</span>, {patient.payer ? PAYER_LABELS[patient.payer] : "cara bayar belum diisi"}
                </span>
              </span>
              <button className="btn btn--ghost" onClick={() => setPatient(null)}>
                Ganti
              </button>
            </div>
            {!patient.payer && (
              <Banner tone="warn">
                Isi cara bayar pasien dulu di <Link to={`/pasien/${patient.id}/ubah`}>data pasien</Link>.
              </Banner>
            )}
            {sessions.length > 1 && (
              <Segmented
                label="Sesi"
                value={sessionKey}
                onChange={setSessionKey}
                options={sessions.map((s) => ({ value: s.schedule_id, label: `${s.doctor_name.replace(/^dr\.?\s*/i, "dr. ")} ${s.start_time}` }))}
              />
            )}
            <button className="btn btn--primary btn--lg btn--block" disabled={busy || !sessionKey || !patient.payer} onClick={add}>
              {busy ? "Menambahkan..." : "Beri nomor antrean"}
            </button>
            <p className="t-caption">Pasien langsung tercatat hadir. Boleh melebihi kuota sesi.</p>
          </>
        ) : (
          <PatientSearch onPick={setPatient} onNew={() => navigate("/pasien/baru")} />
        )}
      </div>
    </Sheet>
  );
}

function SessionCard({ s, isToday, onChange, onOpen }: { s: QueueSession; isToday: boolean; onChange: () => void; onOpen: (a: Appointment) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = s.appointments.find((a) => a.status === "dipanggil");
  const waiting = s.appointments.filter((a) => a.status === "hadir");
  const notYet = s.appointments.filter((a) => a.status === "terdaftar");
  const c = s.counts!;

  async function next() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ called: Appointment | null; not_arrived?: number }>("/api/queue-next", { schedule_id: s.schedule_id, date: s.date });
      if (r.called) toast(`Memanggil ${queueLabel(r.called.queue_no)} ${r.called.patient?.full_name ?? ""}`);
      else toast(r.not_arrived ? `Belum ada yang hadir. ${r.not_arrived} pasien belum datang.` : "Antrean sesi ini sudah habis");
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="qsession" aria-label={`Sesi ${s.start_time} ${s.doctor_name}`}>
      <div className="qsession__head">
        <div>
          <h2 className="t-heading num">
            {s.start_time} sampai {s.end_time}
          </h2>
          <p className="t-caption">
            {s.doctor_name}
            {s.location ? `, ${s.location}` : ""}
          </p>
        </div>
        <p className="t-caption num" style={{ textAlign: "right" }}>
          {s.booked}/{s.quota} nomor
          <br />
          {c.selesai} selesai
        </p>
      </div>

      {isToday && (
        <div className="qnow">
          <button className="qnow__who" disabled={!current} onClick={() => current && onOpen(current)} aria-label={current ? `Detail ${current.patient?.full_name ?? ""}` : undefined}>
            <span className="t-caption">Sedang dilayani</span>
            <span className="qnow__no num">{current ? queueLabel(current.queue_no) : "-"}</span>
            <span className="qnow__name">
              {current ? current.patient?.full_name : waiting.length ? `${waiting.length} pasien menunggu` : "Belum ada pasien hadir"}
              {current && <CaretRight size={14} aria-hidden />}
            </span>
          </button>
          <div className="qnow__actions">
            <button className="btn btn--primary btn--lg" disabled={busy || (!current && !waiting.length)} onClick={next}>
              <MegaphoneSimple size={20} />
              {current ? (waiting.length ? "Selesai, panggil berikutnya" : "Selesai") : "Panggil berikutnya"}
            </button>
          </div>
        </div>
      )}
      {error && <Banner tone="danger">{error}</Banner>}

      {s.appointments.length ? (
        <div className="list">
          {s.appointments.map((a) => (
            <button key={a.id} className="row" onClick={() => onOpen(a)} data-dim={["selesai", "batal", "tidak_hadir"].includes(a.status) || undefined}>
              <span className="qno num" data-status={a.status}>
                {queueLabel(a.queue_no)}
              </span>
              <span className="row__body">
                <span className="row__title" style={{ display: "block" }}>
                  {a.patient?.full_name ?? "Pasien"}
                </span>
                <span className="row__meta" style={{ display: "block" }}>
                  {payerText(a)}
                  {a.source === "onsite" ? ", di klinik" : ""}
                  {a.complaint ? `. ${a.complaint}` : ""}
                </span>
              </span>
              <span className="row__end">
                <span className={`chip ${STATUS_CHIP[a.status]}`}>{APPT_STATUS[a.status]}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">Belum ada pasien di sesi ini.</p>
      )}
      {isToday && notYet.length > 0 && <p className="t-caption">Nomor yang belum datang dilewati saat memanggil. Ketuk nomornya untuk menandai hadir.</p>}
    </section>
  );
}

export default function QueueBoard() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const isDoctor = user?.role === "dokter";
  const doctors = useAsync(() => (isDoctor ? Promise.resolve([] as DoctorWithSchedules[]) : get<DoctorWithSchedules[]>("/api/doctors")), [isDoctor]);
  const doctorParam = params.get("dokter");
  const doctorId = isDoctor ? user!.id : doctorParam ? Number(doctorParam) : null;
  const date = params.get("tanggal");
  const q = useAsync(
    () => get<{ date: string; today: string; sessions: QueueSession[] }>(`/api/queue?${new URLSearchParams({ ...(date ? { date } : {}), ...(doctorId ? { doctor_id: String(doctorId) } : {}) })}`),
    [date, doctorId],
  );
  const [open, setOpen] = useState<Appointment | null>(null);
  const [walkIn, setWalkIn] = useState(false);
  const day = q.data?.date ?? date;
  const isToday = !!q.data && q.data.date === q.data.today;

  useEffect(() => {
    if (!isToday) return;
    const t = setInterval(() => document.visibilityState === "visible" && q.reload(), 10000);
    return () => clearInterval(t);
  }, [isToday, q.reload]);

  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v == null ? p.delete(k) : p.set(k, v);
    setParams(p, { replace: true });
  };
  const sessions = q.data?.sessions ?? [];

  return (
    <>
      <TopBar
        title="Antrean pasien"
        action={
          <Link to="/jadwal" className="btn btn--ghost">
            <CalendarBlank size={20} />
            Jadwal
          </Link>
        }
      />
      <main className="page stack-lg">
        <div className="daynav">
          <button className="btn btn--icon" aria-label="Hari sebelumnya" disabled={!day} onClick={() => day && go({ tanggal: addDays(day, -1) })}>
            <CaretLeft size={20} />
          </button>
          <span className="t-heading">{day ? fmtDay(day, { today: q.data?.today }) : "Hari ini"}</span>
          <button className="btn btn--icon" aria-label="Hari berikutnya" disabled={!day} onClick={() => day && go({ tanggal: addDays(day, 1) })}>
            <CaretRight size={20} />
          </button>
          {!isToday && q.data && (
            <button className="btn btn--ghost" onClick={() => go({ tanggal: null })}>
              Hari ini
            </button>
          )}
        </div>

        {!isDoctor && (doctors.data?.length ?? 0) > 1 && (
          <Segmented
            label="Dokter"
            value={doctorId ?? 0}
            onChange={(v) => go({ dokter: v ? String(v) : null })}
            options={[{ value: 0, label: "Semua" }, ...doctors.data!.map((d) => ({ value: d.id, label: d.full_name }))]}
          />
        )}

        {q.error && <Banner tone="danger">{q.error}</Banner>}
        {q.loading && !q.data ? (
          <SkeletonRows rows={4} />
        ) : sessions.length === 0 ? (
          <Empty icon={CalendarBlank} action={<Link to="/jadwal" className="btn btn--secondary">Atur jadwal praktik</Link>}>
            Tidak ada sesi praktik {day ? fmtDay(day, { today: q.data?.today }).toLowerCase() : "hari ini"}.
          </Empty>
        ) : (
          <>
            {sessions.map((s) => (
              <SessionCard key={s.schedule_id} s={s} isToday={isToday} onChange={q.reload} onOpen={setOpen} />
            ))}
            {(isToday || (day && q.data && day > q.data.today)) && (
              <button className="btn btn--secondary btn--block" onClick={() => setWalkIn(true)}>
                <UserPlus size={20} />
                Tambah pasien datang langsung
              </button>
            )}
          </>
        )}
      </main>

      {open && (
        <ApptSheet
          a={sessions.flatMap((s) => s.appointments).find((x) => x.id === open.id) ?? open}
          onClose={() => setOpen(null)}
          onDone={() => {
            setOpen(null);
            q.reload();
          }}
        />
      )}
      {walkIn && (
        <WalkInSheet
          sessions={sessions}
          onClose={() => setWalkIn(false)}
          onDone={() => {
            setWalkIn(false);
            q.reload();
          }}
        />
      )}
    </>
  );
}
