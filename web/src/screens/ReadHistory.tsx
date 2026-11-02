import { ClockCounterClockwise } from "@phosphor-icons/react";
import { get, type ScreeningSummary } from "../lib/api";
import { fmtWhen } from "../lib/format";
import { Banner, Empty, SkeletonRows, TopBar, useAsync } from "../components/ui";
import { ScreeningRow } from "../components/ScreeningRow";

export default function ReadHistory() {
  const list = useAsync(() => get<ScreeningSummary[]>("/api/screenings?status=dibaca&limit=200"), []);
  return (
    <>
      <TopBar title="Sudah dibaca" back="/bacaan" />
      <main className="page">
        {list.loading && !list.data ? (
          <SkeletonRows rows={5} />
        ) : list.error ? (
          <Banner tone="danger">{list.error}</Banner>
        ) : list.data?.length ? (
          <div className="list">
            {list.data.map((s) => (
              <ScreeningRow key={s.id} s={s} meta={`Dibaca ${fmtWhen(s.reviewed_at)}${s.doctor_name ? ` oleh ${s.doctor_name}` : ""}`} />
            ))}
          </div>
        ) : (
          <Empty icon={ClockCounterClockwise}>Pemeriksaan yang sudah Anda baca akan tercatat di sini.</Empty>
        )}
      </main>
    </>
  );
}
