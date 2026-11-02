import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CalendarPlus, CaretLeft, CaretRight, PencilSimple } from "@phosphor-icons/react";
import { del, get, post, put, type Schedule as Sched, type Slot, type User } from "../lib/api";
import { useAuth } from "../lib/auth";
import { WEEKDAYS, addDays, fromIso, isoDate } from "../lib/format";
import { Banner, ConfirmDelete, Empty, Field, Segmented, Sheet, SkeletonRows, TopBar, useAsync, useToast } from "../components/ui";

const DM = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short" });

/** Senin minggu berjalan untuk tanggal ISO. */
function mondayOf(s: string) {
  const d = fromIso(s);
  return addDays(s, -((d.getDay() + 6) % 7));
}

function ScheduleSheet({ sched, doctorId, onClose, onSaved }: { sched: Sched | null; doctorId: number | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    weekday: sched?.weekday ?? 0,
    start_time: sched?.start_time ?? "08:00",
    end_time: sched?.end_time ?? "12:00",
    quota: String(sched?.quota ?? 20),
    location: sched?.location ?? "",
    active: sched?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const quota = Number(f.quota);
  const valid = f.end_time > f.start_time && quota >= 1 && quota <= 200;

  async function save() {
    setBusy(true);
    setError(null);
    const body = { ...f, quota, location: f.location.trim() || null, doctor_id: sched?.doctor_id ?? doctorId };
    try {
      if (sched) await put(`/api/schedules/${sched.id}`, body);
      else await post("/api/schedules", body);
      toast(sched ? "Jadwal disimpan" : "Jadwal ditambahkan");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (confirmDelete && sched)
    return (
      <ConfirmDelete
        title="Hapus jadwal ini?"
        label="Hapus jadwal"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          const r = await del<{ deactivated: boolean }>(`/api/schedules/${sched.id}`);
          toast(r.deactivated ? "Jadwal dinonaktifkan karena punya riwayat antrean" : "Jadwal dihapus");
          onSaved();
        }}
      >
        <p>
          Sesi {sched.weekday_name}, {sched.start_time} sampai {sched.end_time} tidak bisa dibooking lagi. Bila sudah pernah ada antrean, jadwal dinonaktifkan agar riwayatnya tetap tersimpan.
        </p>
      </ConfirmDelete>
    );

  return (
    <Sheet title={sched ? "Ubah jadwal" : "Jadwal praktik baru"} onClose={onClose}>
      <div className="stack">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Hari">
          {() => <Segmented label="Hari" value={f.weekday} onChange={(v) => set("weekday", v)} options={WEEKDAYS.map((w, i) => ({ value: i, label: w.slice(0, 3) }))} />}
        </Field>
        <div className="grid-2">
          <Field label="Mulai">{(p) => <input {...p} className="input num" type="time" value={f.start_time} onChange={(e) => set("start_time", e.target.value)} />}</Field>
          <Field label="Selesai" error={f.end_time <= f.start_time ? "Harus setelah jam mulai." : undefined}>
            {(p) => <input {...p} className="input num" type="time" value={f.end_time} onChange={(e) => set("end_time", e.target.value)} />}
          </Field>
        </div>
        <Field label="Kuota pasien" hint="Jumlah nomor antrean yang bisa dibooking. Petugas tetap bisa menambah pasien datang langsung.">
          {(p) => <input {...p} className="input num" inputMode="numeric" value={f.quota} onChange={(e) => set("quota", e.target.value.replace(/\D/g, ""))} />}
        </Field>
        <Field label="Lokasi" optional hint="Contoh: Poli Mata, ruang 2.">
          {(p) => <input {...p} className="input" value={f.location} onChange={(e) => set("location", e.target.value)} />}
        </Field>
        {sched && (
          <Field label="Status">
            {() => (
              <Segmented
                label="Status jadwal"
                value={f.active ? 1 : 0}
                onChange={(v) => set("active", v === 1)}
                options={[
                  { value: 1, label: "Aktif" },
                  { value: 0, label: "Libur sementara" },
                ]}
              />
            )}
          </Field>
        )}
        <button className="btn btn--primary btn--lg btn--block" disabled={busy || !valid} onClick={save}>
          {busy ? "Menyimpan..." : sched ? "Simpan" : "Tambah jadwal"}
        </button>
        {sched && (
          <button className="btn btn--danger btn--block" onClick={() => setConfirmDelete(true)}>
            Hapus jadwal
          </button>
        )}
      </div>
    </Sheet>
  );
}

export default function Schedule() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const isDoctor = user?.role === "dokter";
  const canEdit = isDoctor || user?.role === "admin";
  const today = isoDate(new Date());
  const week = mondayOf(params.get("minggu") ?? today);
  const doctorsAll = useAsync(() => (user?.role === "admin" ? get<User[]>("/api/users") : Promise.resolve([] as User[])), [user?.role]);
  const doctorOptions = (doctorsAll.data ?? []).filter((u) => u.role === "dokter" && u.active);
  const doctorParam = params.get("dokter");
  const doctorId = isDoctor ? user!.id : doctorParam ? Number(doctorParam) : null;

  const slots = useAsync(
    () => get<Slot[]>(`/api/slots?start=${week}&days=7${doctorId ? `&doctor_id=${doctorId}` : ""}`),
    [week, doctorId],
  );
  const scheds = useAsync(() => get<Sched[]>(`/api/schedules${doctorId ? `?doctor_id=${doctorId}` : ""}`), [doctorId]);
  const [editing, setEditing] = useState<Sched | "baru" | null>(null);

  const go = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v == null ? p.delete(k) : p.set(k, v);
    setParams(p, { replace: true });
  };
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const byDay = (d: string) => (slots.data ?? []).filter((s) => s.date === d);
  const reloadAll = () => {
    setEditing(null);
    scheds.reload();
    slots.reload();
  };

  return (
    <>
      <TopBar title="Jadwal praktik" />
      <main className="page page--wide stack-lg">
        {user?.role === "admin" && doctorOptions.length > 0 && (
          <Field label="Dokter">
            {(p) => (
              <select {...p} className="input" value={doctorId ?? ""} onChange={(e) => go({ dokter: e.target.value || null })}>
                <option value="">Semua dokter</option>
                {doctorOptions.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.full_name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}

        <section className="stack">
          <div className="daynav">
            <button className="btn btn--icon" aria-label="Minggu sebelumnya" onClick={() => go({ minggu: addDays(week, -7) })}>
              <CaretLeft size={20} />
            </button>
            <span className="t-heading num">
              {DM.format(fromIso(week))} sampai {DM.format(fromIso(addDays(week, 6)))}
            </span>
            <button className="btn btn--icon" aria-label="Minggu berikutnya" onClick={() => go({ minggu: addDays(week, 7) })}>
              <CaretRight size={20} />
            </button>
            {week !== mondayOf(today) && (
              <button className="btn btn--ghost" onClick={() => go({ minggu: null })}>
                Minggu ini
              </button>
            )}
          </div>

          {slots.error && <Banner tone="danger">{slots.error}</Banner>}
          {slots.loading && !slots.data ? (
            <SkeletonRows rows={3} />
          ) : (
            <div className="week">
              {days.map((d, i) => {
                const list = byDay(d);
                return (
                  <section key={d} className="week__day" data-today={d === today || undefined} data-past={d < today || undefined}>
                    <h3 className="week__label">
                      <span>{WEEKDAYS[i]}</span>
                      <span className="num">{d === today ? "Hari ini" : DM.format(fromIso(d))}</span>
                    </h3>
                    {list.length ? (
                      list.map((s) => {
                        const full = s.booked / s.quota;
                        return (
                          <Link key={s.schedule_id} to={`/antrean?tanggal=${d}${doctorId || !isDoctor ? `&dokter=${s.doctor_id}` : ""}`} className="week__slot">
                            <span className="num t-label" aria-label={`${s.start_time} sampai ${s.end_time}`}>
                              {s.start_time}–{s.end_time}
                            </span>
                            {!isDoctor && <span className="t-caption">{s.doctor_name}</span>}
                            <span className="week__meter" aria-hidden>
                              <span style={{ width: `${Math.min(100, full * 100)}%` }} data-full={full >= 1 || undefined} />
                            </span>
                            <span className="t-caption num">
                              {s.booked}/{s.quota} pasien{s.counts?.selesai ? `, ${s.counts.selesai} selesai` : ""}
                            </span>
                          </Link>
                        );
                      })
                    ) : (
                      <p className="t-caption week__empty">Tidak praktik</p>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </section>

        {canEdit && (doctorId != null || isDoctor) && (
          <section>
            <div className="section-head">
              <h2>Jadwal mingguan</h2>
              <button className="btn btn--ghost" onClick={() => setEditing("baru")}>
                <CalendarPlus size={20} />
                Tambah
              </button>
            </div>
            {scheds.data?.length ? (
              <div className="list">
                {scheds.data.map((s) => (
                  <button key={s.id} className="row" onClick={() => setEditing(s)} data-dim={!s.active || undefined}>
                    <span className="row__body">
                      <span className="row__title" style={{ display: "block" }}>
                        {s.weekday_name}, <span className="num">{s.start_time} sampai {s.end_time}</span>
                      </span>
                      <span className="row__meta" style={{ display: "block" }}>
                        Kuota {s.quota}
                        {s.location ? `, ${s.location}` : ""}
                        {s.active ? "" : ". Libur sementara"}
                      </span>
                    </span>
                    <span className="row__end">
                      <PencilSimple size={18} />
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              !scheds.loading && <Empty icon={CalendarPlus}>Belum ada jadwal. Tambahkan hari dan jam praktik agar pasien bisa booking.</Empty>
            )}
          </section>
        )}
        {user?.role === "admin" && doctorId == null && <p className="t-caption">Pilih dokter untuk mengatur jadwal mingguannya.</p>}
        {!canEdit && <p className="t-caption">Jadwal diatur oleh dokter atau admin.</p>}
      </main>

      {editing && <ScheduleSheet sched={editing === "baru" ? null : editing} doctorId={doctorId} onClose={() => setEditing(null)} onSaved={reloadAll} />}
    </>
  );
}
