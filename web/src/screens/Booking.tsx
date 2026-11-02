import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CalendarX } from "@phosphor-icons/react";
import { get, post, type Appointment, type MyProfile, type Slot } from "../lib/api";
import { PAYER_LABELS, fmtDay, fromIso, isoDate, queueLabel } from "../lib/format";

const WD = new Intl.DateTimeFormat("id-ID", { weekday: "short" });
const DM = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" });
import { ActionBar, Banner, Empty, Field, SkeletonRows, TopBar, useAsync, useToast } from "../components/ui";

/** Booking sesi dokter. Mode `?ditempat=1`: hanya sesi hari ini yang sedang buka, pasien langsung tercatat hadir. */
export default function Booking() {
  const [params] = useSearchParams();
  const onsite = params.get("ditempat") === "1";
  const navigate = useNavigate();
  const toast = useToast();
  const today = isoDate(new Date());
  const slots = useAsync(() => get<Slot[]>(onsite ? "/api/slots?days=1" : "/api/slots"), [onsite]);
  const profile = useAsync(() => get<MyProfile>("/api/me/profile"), []);
  const [doctorId, setDoctorId] = useState<number | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [slotKey, setSlotKey] = useState<string | null>(null);
  const [complaint, setComplaint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usable = useMemo(() => (slots.data ?? []).filter((s) => (onsite ? s.onsite_open : s.bookable)), [slots.data, onsite]);
  const doctors = useMemo(() => {
    const m = new Map<number, { id: number; name: string; next: Slot }>();
    for (const s of usable) if (!m.has(s.doctor_id)) m.set(s.doctor_id, { id: s.doctor_id, name: s.doctor_name, next: s });
    return [...m.values()];
  }, [usable]);
  const forDoctor = usable.filter((s) => s.doctor_id === doctorId);
  const dates = [...new Set(forDoctor.map((s) => s.date))];
  const sessions = forDoctor.filter((s) => s.date === date);
  const key = (s: Slot) => `${s.schedule_id}|${s.date}`;
  const chosen = usable.find((s) => key(s) === slotKey) ?? null;

  // Pilihan pertama terisi otomatis agar pasien cukup mengetuk sekali bila hanya ada satu pilihan
  useEffect(() => {
    if (doctorId == null && doctors.length === 1) setDoctorId(doctors[0].id);
  }, [doctors, doctorId]);
  useEffect(() => {
    if (doctorId != null && (!date || !dates.includes(date))) setDate(dates[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doctorId, dates.join()]);
  useEffect(() => {
    if (sessions.length === 1) setSlotKey(key(sessions[0]));
    else if (chosen && !sessions.includes(chosen)) setSlotKey(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, doctorId, sessions.length]);

  const p = profile.data;
  const payerMissing = p && (!p.payer || (p.payer === "bpjs" && !p.bpjs_no));

  async function submit() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const a = await post<Appointment>("/api/me/appointments", { schedule_id: chosen.schedule_id, date: chosen.date, complaint: complaint.trim() || null, onsite });
      toast(`Nomor antrean Anda ${queueLabel(a.queue_no)}`);
      navigate("/kunjungan", { replace: true });
    } catch (e) {
      setError((e as Error).message);
      slots.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title={onsite ? "Ambil antrean di klinik" : "Booking jadwal dokter"} back="/kunjungan" />
      <main className="page page--flow stack-lg">
        {error && <Banner tone="danger">{error}</Banner>}
        {payerMissing && (
          <Banner tone="warn">
            Lengkapi cara bayar dulu di <Link to="/akun">Akun</Link>.
          </Banner>
        )}

        {slots.loading && !slots.data ? (
          <SkeletonRows rows={3} />
        ) : slots.error ? (
          <Banner tone="danger">{slots.error}</Banner>
        ) : !doctors.length ? (
          <Empty icon={CalendarX}>
            {onsite
              ? "Belum ada sesi praktik yang buka saat ini. Antrean di klinik dibuka satu jam sebelum praktik dimulai."
              : "Belum ada jadwal dokter yang bisa dibooking dalam dua minggu ke depan."}
          </Empty>
        ) : (
          <>
            <Field label="Dokter">
              {() => (
                <div className="radiocards" role="radiogroup" aria-label="Dokter">
                  {doctors.map((d) => (
                    <button key={d.id} type="button" role="radio" className="radiocard" aria-checked={doctorId === d.id} onClick={() => setDoctorId(d.id)}>
                      <span className="radiocard__dot" />
                      <span>
                        <span className="radiocard__title" style={{ display: "block" }}>
                          {d.name}
                        </span>
                        <span className="radiocard__desc">
                          {onsite ? `Praktik ${d.next.start_time} sampai ${d.next.end_time}` : `Terdekat: ${fmtDay(d.next.date, { today }).toLowerCase()}, ${d.next.start_time}`}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Field>

            {doctorId != null && !onsite && (
              <Field label="Tanggal">
                {() => (
                  <div className="daystrip" role="radiogroup" aria-label="Tanggal">
                    {dates.map((d) => (
                      <button key={d} type="button" role="radio" aria-checked={date === d} aria-label={fmtDay(d, { today })} onClick={() => setDate(d)}>
                        <span>{d === today ? "Hari ini" : WD.format(fromIso(d))}</span>
                        <b className="num">{DM.format(fromIso(d))}</b>
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            )}

            {date && sessions.length > 0 && (
              <Field label="Sesi">
                {() => (
                  <div className="radiocards" role="radiogroup" aria-label="Sesi">
                    {sessions.map((s) => (
                      <button key={key(s)} type="button" role="radio" className="radiocard" aria-checked={slotKey === key(s)} onClick={() => setSlotKey(key(s))}>
                        <span className="radiocard__dot" />
                        <span style={{ flex: 1 }}>
                          <span className="radiocard__title num" style={{ display: "block" }}>
                            {s.start_time} sampai {s.end_time}
                          </span>
                          <span className="radiocard__desc">
                            {s.location ? `${s.location}. ` : ""}Sisa {s.remaining} dari {s.quota} nomor
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </Field>
            )}

            {chosen && (
              <>
                <Field label="Keluhan" optional hint="Membantu dokter bersiap.">
                  {(fp) => <textarea {...fp} className="input" rows={3} maxLength={300} value={complaint} onChange={(e) => setComplaint(e.target.value)} />}
                </Field>
                {p && !payerMissing && (
                  <section className="card">
                    <dl className="kv">
                      <dt>Cara bayar</dt>
                      <dd>
                        {PAYER_LABELS[p.payer!]}
                        {p.payer === "bpjs" && <span className="mono">, {p.bpjs_no}</span>}
                        {p.payer === "asuransi" && `, ${p.insurer}`}
                      </dd>
                      <dt>Nomor antrean</dt>
                      <dd>Sekitar nomor {queueLabel(chosen.booked + 1)}</dd>
                    </dl>
                    <Link to="/akun" className="btn btn--ghost" style={{ marginTop: 8, marginLeft: -12 }}>
                      Ubah cara bayar
                    </Link>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </main>
      <ActionBar>
        <button className="btn btn--primary btn--lg" disabled={!chosen || busy || !!payerMissing} onClick={submit}>
          {busy ? "Memproses..." : chosen ? "Ambil nomor antrean" : "Pilih dokter dan sesi"}
        </button>
      </ActionBar>
    </>
  );
}
