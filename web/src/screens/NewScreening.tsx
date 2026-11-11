import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { post, type Patient, type ScreeningDetail } from "../lib/api";
import { useAuth } from "../lib/auth";
import { createLocalScreening, findPatient } from "../lib/offline/store";
import { isNetworkError, serverPatientId } from "../lib/offline/sync";
import { Banner, TopBar } from "../components/ui";
import { PatientSearch } from "../components/PatientSearch";

/**
 * Langkah 0 pemeriksaan: pilih pasien. Pemeriksaan (draf) dibuat begitu pasien dipilih: di server bila ada sinyal,
 * atau di HP bila tidak ada sinyal (dikirim nanti).
 */
export function useStartScreening() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function startLocal(patient: Patient | string) {
    const p = typeof patient === "string" ? await findPatient(patient) : patient;
    if (!p) throw new Error("Tidak ada sinyal, dan data pasien ini belum tersimpan di HP. Cari pasien lewat daftar pasien.");
    const s = await createLocalScreening(p, user!.id);
    navigate(`/periksa/${s.id}`, { replace: true });
  }
  async function start(patient: Patient | string) {
    const id = typeof patient === "string" ? patient : patient.id;
    setBusy(true);
    setError(null);
    try {
      try {
        const s = await post<ScreeningDetail>("/api/screenings", { patient_id: await serverPatientId(id) });
        navigate(`/periksa/${s.id}`, { replace: true });
      } catch (e) {
        if (isNetworkError(e)) await startLocal(patient);
        else throw e;
      }
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
        <PatientSearch onPick={(p: Patient) => !busy && start(p)} onNew={() => navigate("/pasien/baru?lanjut=periksa")} />
      </main>
    </>
  );
}
