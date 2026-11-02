import { Link } from "react-router-dom";
import { Camera, Eye, FolderOpen } from "@phosphor-icons/react";
import { get, type ScreeningSummary } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Banner, Empty, Logo, SkeletonRows, useAsync } from "../components/ui";
import { ScreeningRow } from "../components/ScreeningRow";

interface Summary {
  drafts: number;
  waiting: number;
  done_today: number;
  referred_unseen: number;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 11) return "Selamat pagi";
  if (h < 15) return "Selamat siang";
  if (h < 18) return "Selamat sore";
  return "Selamat malam";
}

export default function NurseHome() {
  const { user } = useAuth();
  const summary = useAsync(() => get<Summary>("/api/summary"), []);
  const drafts = useAsync(() => get<ScreeningSummary[]>("/api/screenings?status=draf&mine=true&limit=10"), []);
  const recent = useAsync(() => get<ScreeningSummary[]>("/api/screenings?mine=true&limit=30"), []);
  const sent = (recent.data ?? []).filter((s) => s.status !== "draf").slice(0, 12);
  const firstName = user?.full_name.split(" ")[0];

  return (
    <>
      <header className="topbar">
        <div className="topbar__inner">
          <Logo />
        </div>
      </header>
      <main className="page stack-lg">
        <div>
          <p className="muted">{greeting()},</p>
          <h1 className="t-display">{firstName}</h1>
        </div>

        <Link to="/periksa" className="hero-cta">
          <span className="hero-cta__icon">
            <Camera size={26} />
          </span>
          <span>
            <span className="hero-cta__title" style={{ display: "block" }}>
              Mulai pemeriksaan
            </span>
            <span className="hero-cta__desc">Pilih pasien, isi data klinis, lalu foto retina</span>
          </span>
        </Link>

        <div className="stats">
          <div className="stat">
            <div className="stat__value">{summary.data?.done_today ?? "-"}</div>
            <div className="stat__label">Diperiksa hari ini</div>
          </div>
          <div className="stat">
            <div className="stat__value">{summary.data?.waiting ?? "-"}</div>
            <div className="stat__label">Menunggu dokter</div>
          </div>
          <div className={`stat ${summary.data?.referred_unseen ? "stat--alert" : ""}`}>
            <div className="stat__value">{summary.data?.referred_unseen ?? "-"}</div>
            <div className="stat__label">Perlu tindak lanjut (7 hari)</div>
          </div>
        </div>

        {!!summary.data?.referred_unseen && (
          <Banner tone="danger">
            <strong>{summary.data.referred_unseen} pasien</strong> perlu dirujuk atau difoto ulang. Lihat daftar di bawah
            dan beri tahu pasien.
          </Banner>
        )}

        {!!drafts.data?.length && (
          <section>
            <div className="section-head">
              <h2>Belum selesai</h2>
            </div>
            <div className="list">
              {drafts.data.map((s) => (
                <ScreeningRow key={s.id} s={s} meta="Lanjutkan foto dan kirim ke dokter" />
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="section-head">
            <h2>Pemeriksaan terakhir</h2>
          </div>
          {recent.loading && !recent.data ? (
            <SkeletonRows />
          ) : recent.error ? (
            <Banner tone="danger">{recent.error}</Banner>
          ) : sent.length ? (
            <div className="list">
              {sent.map((s) => (
                <ScreeningRow key={s.id} s={s} />
              ))}
            </div>
          ) : (
            <Empty icon={drafts.data?.length ? FolderOpen : Eye}>
              Pemeriksaan yang sudah dikirim ke dokter akan muncul di sini beserta hasil bacaannya.
            </Empty>
          )}
        </section>
      </main>
    </>
  );
}
