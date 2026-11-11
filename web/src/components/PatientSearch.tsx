import { useEffect, useState } from "react";
import { CaretRight, MagnifyingGlass, Sparkle, UserPlus } from "@phosphor-icons/react";
import { get, type Patient } from "../lib/api";
import { useAuth } from "../lib/auth";
import { localPatients, rememberPatients, searchOffline } from "../lib/offline/store";
import { isNetworkError } from "../lib/offline/sync";
import { DecisionChip, Empty, SkeletonRows, useAsync, Banner } from "./ui";
import { GRADE_LABELS, fmtDate, fmtPct, initials, patientMeta } from "../lib/format";

/** Kotak cari + daftar pasien. onPick dipanggil saat satu pasien diketuk. */
export function PatientSearch({ onPick, onNew }: { onPick: (p: Patient) => void; onNew: () => void }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const uid = useAuth().user!.id;
  const [offline, setOffline] = useState(false);
  const list = useAsync(async () => {
    try {
      const found = await get<Patient[]>(`/api/patients?q=${encodeURIComponent(debounced)}&limit=50`);
      setOffline(false);
      rememberPatients(found);
      // Pasien yang didaftarkan offline dan belum terkirim tampil paling atas
      const local = debounced ? [] : await localPatients(uid).catch(() => []);
      return [...local, ...found];
    } catch (e) {
      if (!isNetworkError(e)) throw e;
      setOffline(true);
      return searchOffline(debounced, uid);
    }
  }, [debounced, uid]);

  return (
    <div className="stack">
      <div className="input-wrap">
        <MagnifyingGlass size={20} style={{ position: "absolute", left: 14, top: 14, color: "var(--ink-3)" }} aria-hidden />
        <input
          className="input"
          style={{ paddingLeft: 44, paddingRight: 14 }}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          placeholder="Cari nama, NIK, atau no. rekam"
          aria-label="Cari pasien"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <button type="button" className="btn btn--secondary btn--block" onClick={onNew}>
        <UserPlus size={20} />
        Pasien baru
      </button>

      {offline && <p className="t-caption muted">Tidak ada sinyal. Mencari di data pasien yang tersimpan di HP.</p>}

      {list.loading && !list.data ? (
        <SkeletonRows rows={5} />
      ) : list.error ? (
        <Banner tone="danger">{list.error}</Banner>
      ) : list.data?.length ? (
        <div className="list">
          {list.data.map((p) => (
            <button key={p.id} type="button" className="row" onClick={() => onPick(p)}>
              {p.latest?.thumbnail_url ? (
                <img className="thumb" src={p.latest.thumbnail_url} alt="" loading="lazy" />
              ) : (
                <span className="avatar" aria-hidden>
                  {initials(p.full_name)}
                </span>
              )}
              <span className="row__body">
                <span className="row__title" style={{ display: "block" }}>
                  {p.full_name}
                </span>
                <span className="row__meta" style={{ display: "block" }}>
                  {patientMeta(p)}
                  {p.last_screening_at ? `. Terakhir diperiksa ${fmtDate(p.last_screening_at)}` : ""}
                </span>
                {p.latest?.ai_grade != null && <AiLine grade={p.latest.ai_grade} pRef={p.latest.ai_p_referable} referable={!!p.latest.ai_referable} />}
              </span>
              <span className="row__end">
                {p.last_decision && <DecisionChip decision={p.last_decision} />}
                <CaretRight size={16} />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Empty icon={UserPlus}>
          {debounced ? `Tidak ada pasien dengan kata "${debounced}". Daftarkan sebagai pasien baru.` : "Belum ada pasien terdaftar."}
        </Empty>
      )}
    </div>
  );
}

/** Ringkasan AI satu baris: derajat terburuk dari foto terakhir dan kemungkinan perlu rujukan. */
function AiLine({ grade, pRef, referable }: { grade: number; pRef: number | null; referable: boolean }) {
  return (
    <span className="ai-line">
      <span className={`chip chip--g${grade}`}>
        <Sparkle size={14} weight="fill" aria-hidden />
        AI: {GRADE_LABELS[grade]}
      </span>
      {pRef != null && (
        <span className="ai-line__p" data-high={referable}>
          Risiko rujuk {fmtPct(pRef)}
        </span>
      )}
    </span>
  );
}
