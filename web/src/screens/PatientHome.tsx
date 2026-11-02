import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CalendarPlus, ClockCounterClockwise, MapPin, Storefront } from "@phosphor-icons/react";
import { get, post, type Appointment } from "../lib/api";
import { useAuth } from "../lib/auth";
import { APPT_STATUS, PAYER_LABELS, fmtDay, isoDate, queueLabel } from "../lib/format";
import { Banner, ConfirmDelete, Empty, Logo, SkeletonRows, useAsync, useToast } from "../components/ui";

const LIVE = ["terdaftar", "hadir", "dipanggil"];

function Ticket({ a, today, onChange }: { a: Appointment; today: string; onChange: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancel, setCancel] = useState(false);
  const isToday = a.date === today;
  const called = a.status === "dipanggil";

  async function checkIn() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/me/appointments/${a.id}/checkin`);
      toast("Kehadiran tercatat");
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ticket" data-called={called || undefined} aria-label={`Antrean nomor ${a.queue_no}`}>
      <div className="ticket__head">
        <div>
          <p className="t-heading">{a.doctor_name}</p>
          <p className="muted">
            {fmtDay(a.date, { today })}, {a.start_time} sampai {a.end_time}
          </p>
          {a.location && (
            <p className="muted" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <MapPin size={16} aria-hidden />
              {a.location}
            </p>
          )}
        </div>
        <span className={`chip ${called ? "chip--aktif" : a.status === "hadir" ? "chip--menunggu" : "chip--draf"}`}>{APPT_STATUS[a.status]}</span>
      </div>

      <div className="ticket__body">
        <div>
          <p className="t-caption">Nomor antrean</p>
          <p className="ticket__no num">{queueLabel(a.queue_no)}</p>
        </div>
        {isToday && (
          <div style={{ textAlign: "right" }}>
            <p className="t-caption">Sedang dilayani</p>
            <p className="ticket__serving num">{queueLabel(a.now_serving)}</p>
          </div>
        )}
      </div>

      {error && <Banner tone="danger">{error}</Banner>}
      {called ? (
        <Banner tone="ok">
          <strong>Giliran Anda.</strong> Silakan masuk ke ruang periksa.
        </Banner>
      ) : isToday ? (
        <p className="ticket__note">
          {a.ahead === 0 ? "Anda berikutnya setelah pasien yang sedang dilayani." : `${a.ahead} pasien sebelum Anda.`}
          {a.status === "terdaftar" && " Tandai hadir saat sudah di klinik, nomor dipanggil hanya untuk pasien yang hadir."}
        </p>
      ) : (
        <p className="ticket__note">Datang 15 menit sebelum jam praktik, lalu tandai hadir di aplikasi ini.</p>
      )}

      <div className="ticket__foot">
        <span className="t-caption">
          Kode <span className="mono">{a.code}</span>, {PAYER_LABELS[a.payer]}
        </span>
        {a.status !== "dipanggil" && (
          <button className="btn btn--ghost" style={{ color: "var(--danger)", marginRight: -12 }} onClick={() => setCancel(true)}>
            Batalkan
          </button>
        )}
      </div>
      {isToday && a.status === "terdaftar" && (
        <button className="btn btn--primary btn--lg btn--block" disabled={busy} onClick={checkIn}>
          {busy ? "Menyimpan..." : "Saya sudah tiba di klinik"}
        </button>
      )}

      {cancel && (
        <ConfirmDelete
          title="Batalkan antrean?"
          label="Batalkan antrean"
          onClose={() => setCancel(false)}
          onConfirm={async () => {
            await post(`/api/me/appointments/${a.id}/cancel`);
            toast("Antrean dibatalkan");
            setCancel(false);
            onChange();
          }}
        >
          <p>
            Nomor {queueLabel(a.queue_no)} untuk {a.doctor_name}, {fmtDay(a.date, { today }).toLowerCase()}, akan dilepas. Anda bisa booking lagi selama kuota masih ada.
          </p>
        </ConfirmDelete>
      )}
    </section>
  );
}

export default function PatientHome() {
  const { user } = useAuth();
  const list = useAsync(() => get<Appointment[]>("/api/me/appointments"), []);
  const today = isoDate(new Date());
  const items = list.data ?? [];
  const live = items.filter((a) => LIVE.includes(a.status) && a.date >= today).sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  const past = items.filter((a) => !live.includes(a));
  const liveToday = live.some((a) => a.date === today);

  // Nomor yang sedang dilayani diperbarui tiap 15 detik selama ada antrean hari ini
  useEffect(() => {
    if (!liveToday) return;
    const t = setInterval(() => document.visibilityState === "visible" && list.reload(), 15000);
    return () => clearInterval(t);
  }, [liveToday, list.reload]);

  return (
    <>
      <header className="topbar">
        <div className="topbar__inner">
          <Logo />
        </div>
      </header>
      <main className="page stack-lg">
        <div>
          <p className="muted">Halo,</p>
          <h1 className="t-display">{user?.full_name.split(" ")[0]}</h1>
        </div>

        {list.error && <Banner tone="danger">{list.error}</Banner>}
        {list.loading && !list.data ? (
          <SkeletonRows rows={2} />
        ) : (
          live.map((a) => <Ticket key={a.id} a={a} today={today} onChange={list.reload} />)
        )}

        <Link to="/booking" className="hero-cta">
          <span className="hero-cta__icon">
            <CalendarPlus size={26} />
          </span>
          <span>
            <span className="hero-cta__title" style={{ display: "block" }}>
              Booking jadwal dokter
            </span>
            <span className="hero-cta__desc">Pilih dokter dan sesi, nomor antrean langsung didapat</span>
          </span>
        </Link>
        <Link to="/booking?ditempat=1" className="btn btn--secondary btn--lg btn--block">
          <Storefront size={20} />
          Sudah di klinik? Ambil antrean
        </Link>

        <section>
          <div className="section-head">
            <h2>Riwayat kunjungan</h2>
          </div>
          {past.length ? (
            <div className="list">
              {past.map((a) => (
                <div key={a.id} className="row">
                  <span className="avatar num" aria-hidden style={{ fontSize: 13 }}>
                    {queueLabel(a.queue_no)}
                  </span>
                  <span className="row__body">
                    <span className="row__title" style={{ display: "block" }}>
                      {a.doctor_name}
                    </span>
                    <span className="row__meta" style={{ display: "block" }}>
                      {fmtDay(a.date, { today, short: true })}, {a.start_time}
                    </span>
                  </span>
                  <span className="row__end">
                    <span className={`chip ${a.status === "selesai" ? "chip--g0" : "chip--draf"}`}>{APPT_STATUS[a.status]}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            !list.loading && <Empty icon={ClockCounterClockwise}>Belum ada kunjungan sebelumnya.</Empty>
          )}
        </section>
      </main>
    </>
  );
}
