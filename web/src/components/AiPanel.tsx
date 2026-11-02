import { Sparkle } from "@phosphor-icons/react";
import type { RetinaImage } from "../lib/api";
import { GRADE_LABELS, fmtPct } from "../lib/format";
import { GradeChip } from "./ui";

/** Perkiraan AI untuk satu foto. Ditampilkan sebagai pendapat kedua, bukan diagnosis. */
export function AiPanel({ image, threshold }: { image: RetinaImage; threshold: number | null }) {
  if (image.quality.is_fundus === false)
    return (
      <section className="ai" aria-label="Perkiraan AI">
        <h3 className="t-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Sparkle size={18} />
          AI tidak menilai foto ini
        </h3>
        <p className="t-caption" style={{ marginTop: 8 }}>
          Foto tidak dikenali sebagai foto fundus retina ({image.quality.issues.join(", ")}). Foto ini tidak ikut kesimpulan AI pemeriksaan.
        </p>
      </section>
    );
  if (image.grade == null || !image.probs) return null;
  const pRef = image.p_referable ?? 0;
  const high = threshold != null && pRef >= threshold;
  const top = image.grade;
  return (
    <section className="ai" aria-label="Perkiraan AI">
      <div className="ai__head">
        <h3 className="t-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Sparkle size={18} />
          Perkiraan AI
        </h3>
        <GradeChip grade={image.grade} />
      </div>
      <p className="t-caption">Kemungkinan perlu rujukan (derajat sedang ke atas)</p>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="t-title num" style={{ color: high ? "var(--danger)" : undefined }}>
          {fmtPct(pRef)}
        </span>
        <span className="t-caption">{high ? "di atas ambang rujukan" : "di bawah ambang rujukan"}{threshold != null ? ` ${fmtPct(threshold)}` : ""}</span>
      </div>
      <div className="meter" aria-hidden>
        <div className="meter__fill" data-high={high} style={{ width: `${pRef * 100}%` }} />
        {threshold != null && <div className="meter__mark" style={{ left: `${threshold * 100}%` }} />}
      </div>
      <div className="probs">
        {image.probs.map((p, g) => (
          <div key={g} className="probs__row" data-top={g === top}>
            <span>{GRADE_LABELS[g]}</span>
            <span className="probs__bar" style={{ width: `${Math.max(2, p * 100)}%` }} />
            <span className="num" style={{ textAlign: "right" }}>
              {fmtPct(p)}
            </span>
          </div>
        ))}
      </div>
      {!image.quality.ok && (
        <p className="t-caption" style={{ marginTop: 12, color: "var(--g1)" }}>
          Kualitas foto kurang ({image.quality.issues.join(", ")}). Perkiraan AI kurang dapat diandalkan.
        </p>
      )}
      <p className="t-caption" style={{ marginTop: 12 }}>
        Bandingkan dengan foto sebelum memutuskan. Keputusan klinis tetap pada dokter.
      </p>
    </section>
  );
}
