import { Link } from "react-router-dom";
import { CaretRight, Eye } from "@phosphor-icons/react";
import type { ScreeningSummary } from "../lib/api";
import { fmtWaiting, fmtWhen, patientMeta } from "../lib/format";
import { StatusChip } from "./ui";

/** Satu baris pemeriksaan. Draf membuka alur foto, sisanya membuka hasil. */
export function ScreeningRow({ s, title, meta, end }: { s: ScreeningSummary; title?: string; meta?: string; end?: React.ReactNode }) {
  const to = s.status === "draf" ? `/periksa/${s.id}` : `/pemeriksaan/${s.id}`;
  return (
    <Link to={to} className="row">
      {s.thumbnail_url ? (
        <img className="thumb" src={s.thumbnail_url} alt="" loading="lazy" />
      ) : (
        <span className="thumb thumb--empty">
          <Eye size={20} />
        </span>
      )}
      <span className="row__body">
        <span className="row__title" style={{ display: "block" }}>
          {title ?? s.patient?.full_name ?? "Pasien"}
        </span>
        <span className="row__meta" style={{ display: "block" }}>
          {meta ??
            (s.status === "menunggu"
              ? `Menunggu ${fmtWaiting(s.submitted_at)}`
              : s.status === "dibaca"
                ? `Dibaca ${fmtWhen(s.reviewed_at)}`
                : `${s.patient ? patientMeta(s.patient) : ""}`)}
        </span>
      </span>
      <span className="row__end">
        {end ?? <StatusChip status={s.status} decision={s.decision} />}
        <CaretRight size={16} />
      </span>
    </Link>
  );
}
