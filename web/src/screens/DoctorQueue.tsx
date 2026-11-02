import { Link } from "react-router-dom";
import { Camera, CheckCircle, ClockCounterClockwise } from "@phosphor-icons/react";
import { get, type ScreeningSummary } from "../lib/api";
import { fmtWaiting, patientMeta } from "../lib/format";
import { Banner, Empty, Logo, SkeletonRows, useAsync } from "../components/ui";
import { ScreeningRow } from "../components/ScreeningRow";
import { useEffect } from "react";

interface Summary {
  waiting: number;
  waiting_priority: number;
  read_today: number;
}

export default function DoctorQueue() {
  const summary = useAsync(() => get<Summary>("/api/summary"), []);
  const queue = useAsync(() => get<ScreeningSummary[]>("/api/screenings?status=menunggu&limit=200"), []);
  // Draf yang dokter potret sendiri tapi belum selesai
  const drafts = useAsync(() => get<ScreeningSummary[]>("/api/screenings?status=draf&mine=true&limit=20"), []);

  // Antrean diperbarui otomatis tiap 30 detik selama layar terbuka
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        queue.reload();
        summary.reload();
      }
    }, 30000);
    return () => clearInterval(t);
  }, [queue.reload, summary.reload]);

  const items = queue.data ?? [];
  const priority = items.filter((s) => s.ai_referable);
  const rest = items.filter((s) => !s.ai_referable);

  const section = (title: string, list: ScreeningSummary[], note?: string) =>
    list.length > 0 && (
      <section>
        <div className="section-head">
          <h2>{title}</h2>
          <span className="t-caption">{list.length} pasien</span>
        </div>
        {note && <p className="t-caption" style={{ marginBottom: 8 }}>{note}</p>}
        <div className="list">
          {list.map((s) => (
            <ScreeningRow
              key={s.id}
              s={s}
              meta={`${s.patient ? patientMeta(s.patient) : ""}. Menunggu ${fmtWaiting(s.submitted_at)}`}
              end={<span className="t-caption num">{s.image_count} foto</span>}
            />
          ))}
        </div>
      </section>
    );

  return (
    <>
      <header className="topbar">
        <div className="topbar__inner">
          <Logo />
        </div>
      </header>
      <main className="page stack-lg">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <h1 className="t-display">Bacaan foto</h1>
          <Link to="/riwayat" className="btn btn--ghost">
            <ClockCounterClockwise size={20} />
            Sudah dibaca
          </Link>
        </div>
        <div className="stats">
          <div className="stat">
            <div className="stat__value">{summary.data?.waiting ?? "-"}</div>
            <div className="stat__label">Menunggu</div>
          </div>
          <div className={`stat ${summary.data?.waiting_priority ? "stat--alert" : ""}`}>
            <div className="stat__value">{summary.data?.waiting_priority ?? "-"}</div>
            <div className="stat__label">Prioritas</div>
          </div>
          <div className="stat">
            <div className="stat__value">{summary.data?.read_today ?? "-"}</div>
            <div className="stat__label">Dibaca hari ini</div>
          </div>
        </div>

        <Link to="/periksa" className="btn btn--secondary btn--block">
          <Camera size={20} />
          Periksa pasien sendiri
        </Link>

        {!!drafts.data?.length && (
          <section>
            <div className="section-head">
              <h2>Belum selesai</h2>
              <span className="t-caption">{drafts.data.length} draf</span>
            </div>
            <div className="list">
              {drafts.data.map((s) => (
                <ScreeningRow key={s.id} s={s} meta={`${s.image_count} foto. Ketuk untuk melanjutkan`} />
              ))}
            </div>
          </section>
        )}

        {queue.loading && !queue.data ? (
          <SkeletonRows rows={4} />
        ) : queue.error ? (
          <Banner tone="danger">{queue.error}</Banner>
        ) : items.length === 0 ? (
          <Empty icon={CheckCircle}>Semua pemeriksaan sudah dibaca. Kiriman baru dari perawat akan muncul di sini.</Empty>
        ) : (
          <>
            {section("Prioritas", priority, "Perkiraan AI menunjukkan kemungkinan perlu rujukan. Diurutkan dari risiko tertinggi.")}
            {section(priority.length ? "Lainnya" : "Menunggu dibaca", rest)}
          </>
        )}
      </main>
    </>
  );
}
