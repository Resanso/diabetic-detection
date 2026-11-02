import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { post, type Patient, type ScreeningDetail } from "../lib/api";
import { Banner, TopBar } from "../components/ui";
import { PatientSearch } from "../components/PatientSearch";

/** Langkah 0 pemeriksaan: pilih pasien. Pemeriksaan (draf) dibuat begitu pasien dipilih. */
export function useStartScreening() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function start(patientId: string) {
    setBusy(true);
    setError(null);
    try {
      const s = await post<ScreeningDetail>("/api/screenings", { patient_id: patientId });
      navigate(`/periksa/${s.id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { start, error, busy };
}

export default function NewScreening() {
  const navigate = useNavigate();
  const { start, error, busy } = useStartScreening();
  return (
    <>
      <TopBar title="Pilih pasien" sub="Pemeriksaan baru" back="/" />
      <main className="page page--flow stack" aria-busy={busy}>
        {error && <Banner tone="danger">{error}</Banner>}
        <PatientSearch
          onPick={(p: Patient) => !busy && start(p.id)}
          onNew={() => navigate("/pasien/baru?lanjut=periksa")}
        />
      </main>
    </>
  );
}
