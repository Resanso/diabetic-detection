import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowsClockwise, CaretRight, CloudArrowUp, CloudSlash, Eye, WarningCircle } from "@phosphor-icons/react";
import { useAuth } from "../lib/auth";
import { localPatients, localScreenings, putLocalScreening, type LocalPatient, type LocalScreening } from "../lib/offline/store";
import { refreshCounts, syncNow, useSync } from "../lib/offline/sync";
import { fmtWhen, initials, patientMeta } from "../lib/format";
import { Banner } from "./ui";

/** Bilah tipis di atas layar petugas: tanpa sinyal, sedang mengirim, atau ada data yang gagal dikirim. */
export function OfflineBar() {
  const { online, syncing, pending, failed } = useSync();
  if (online && !pending) return null;
  const tone = failed ? "danger" : online ? "info" : "neutral";
  const Icon = failed ? WarningCircle : online ? CloudArrowUp : CloudSlash;
  const text = failed
    ? `${failed} data gagal dikirim. Buka Beranda untuk memperbaikinya.`
    : !online
      ? `Tanpa sinyal. Pekerjaan disimpan di HP${pending ? ` (${pending} menunggu dikirim)` : ""}.`
      : syncing
        ? `Mengirim ${pending} data ke server...`
        : `${pending} data menunggu dikirim.`;
  return (
    <div className={`offline-bar offline-bar--${tone}`} role="status">
      <Icon size={18} weight="fill" aria-hidden />
      <span>{text}</span>
    </div>
  );
}

function useLocalWork() {
  const uid = useAuth().user!.id;
  const sync = useSync();
  const [items, setItems] = useState<{ screenings: LocalScreening[]; patients: LocalPatient[] } | null>(null);
  useEffect(() => {
    Promise.all([localScreenings(uid), localPatients(uid)])
      .then(([screenings, patients]) => setItems({ screenings, patients: patients.filter((p) => !screenings.some((s) => s.patient_id === p.id)) }))
      .catch(() => setItems({ screenings: [], patients: [] }));
    // Muat ulang setiap kali jumlah antrean berubah (selesai terkirim, gagal, atau draf baru)
  }, [uid, sync.pending, sync.drafts, sync.failed, sync.syncing]);
  return { items, sync };
}

/** Daftar pekerjaan yang tersimpan di HP: draf offline dan pemeriksaan yang menunggu sinyal. */
export function LocalWork() {
  const { items, sync } = useLocalWork();
  if (!items || (!items.screenings.length && !items.patients.length)) return null;

  async function reopen(s: LocalScreening) {
    await putLocalScreening({ ...s, status: "draf", error: null });
    await refreshCounts();
  }

  return (
    <section>
      <div className="section-head">
        <h2>Tersimpan di HP</h2>
        {sync.online && !!sync.pending && (
          <button className="btn btn--ghost" disabled={sync.syncing} onClick={() => syncNow()}>
            <ArrowsClockwise size={18} />
            {sync.syncing ? "Mengirim..." : "Kirim sekarang"}
          </button>
        )}
      </div>
      {!sync.online && <p className="t-caption muted" style={{ marginBottom: 8 }}>Data di bawah dikirim otomatis begitu HP mendapat sinyal.</p>}
      <div className="list">
        {items.screenings.map((s) => {
          const thumb = s.images[s.images.length - 1]?.blob;
          const meta =
            s.status === "draf"
              ? "Draf offline. Lanjutkan foto lalu simpan"
              : s.error
                ? `Gagal dikirim: ${s.error}`
                : `Menunggu sinyal, disimpan ${fmtWhen(s.submitted_at)}`;
          const body = (
            <>
              <LocalThumb blob={thumb} />
              <span className="row__body">
                <span className="row__title" style={{ display: "block" }}>
                  {s.patient.full_name}
                </span>
                <span className="row__meta" style={{ display: "block", color: s.error ? "var(--danger)" : undefined }}>
                  {meta}
                </span>
              </span>
              <span className="row__end">
                <span className={`chip ${s.error ? "chip--g3" : ""}`}>{s.status === "draf" ? "Draf" : s.error ? "Gagal" : "Antre kirim"}</span>
                {(s.status === "draf" || s.error) && <CaretRight size={16} />}
              </span>
            </>
          );
          if (s.status === "draf")
            return (
              <Link key={s.id} to={`/periksa/${s.id}`} className="row">
                {body}
              </Link>
            );
          if (s.error)
            return (
              <Link key={s.id} to={`/periksa/${s.id}`} className="row" onClick={() => reopen(s)}>
                {body}
              </Link>
            );
          return (
            <div key={s.id} className="row">
              {body}
            </div>
          );
        })}
        {items.patients.map((p) => (
          <Link key={p.id} to={`/pasien/${p.id}`} className="row">
            <span className="avatar" aria-hidden>
              {initials(p.full_name)}
            </span>
            <span className="row__body">
              <span className="row__title" style={{ display: "block" }}>
                {p.full_name}
              </span>
              <span className="row__meta" style={{ display: "block", color: p.error ? "var(--danger)" : undefined }}>
                {p.error ? `Gagal didaftarkan: ${p.error}` : `Pasien baru. ${patientMeta(p)}`}
              </span>
            </span>
            <span className="row__end">
              <span className={`chip ${p.error ? "chip--g3" : ""}`}>{p.error ? "Gagal" : "Antre kirim"}</span>
              <CaretRight size={16} />
            </span>
          </Link>
        ))}
      </div>
      {!!sync.failed && (
        <div style={{ marginTop: 8 }}>
          <Banner tone="danger">Ketuk data yang gagal untuk membukanya lagi, perbaiki, lalu simpan ulang.</Banner>
        </div>
      )}
    </section>
  );
}

function LocalThumb({ blob }: { blob: Blob | undefined }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url ? (
    <img className="thumb" src={url} alt="" />
  ) : (
    <span className="thumb thumb--empty">
      <Eye size={20} />
    </span>
  );
}
