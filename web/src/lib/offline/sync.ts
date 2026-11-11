/**
 * Kirim pekerjaan offline ke server saat ada sinyal.
 *
 * Urutan per pemeriksaan: pasien baru (jika didaftarkan offline) -> draf pemeriksaan -> tiap foto -> kirim ke dokter.
 * Setiap langkah idempoten di server (client_id), dan hasilnya langsung dicatat di HP, sehingga sinyal yang putus
 * di tengah jalan cukup diulang dari awal tanpa membuat data ganda.
 */
import { useEffect, useState } from "react";
import { ApiError, api, get, onNetwork, post, type Patient, type ScreeningDetail } from "../api";
import { idb } from "./idb";
import {
  getLocalScreening,
  isLocalId,
  localPatients,
  localScreenings,
  putLocalScreening,
  deleteLocalScreening,
  savePatient,
  type LocalPatient,
  type LocalScreening,
} from "./store";

const VITAL_KEYS = ["location", "glucose", "glucose_kind", "hba1c", "systolic", "diastolic", "va_right", "va_left", "complaints", "nurse_notes"] as const;

export interface SyncState {
  online: boolean;
  syncing: boolean;
  /** Pemeriksaan yang menunggu dikirim + pasien baru yang belum terkirim. */
  pending: number;
  drafts: number;
  /** Galat dari server (bukan karena sinyal) yang perlu diperbaiki petugas. */
  failed: number;
  lastSync: number | null;
}

let st: SyncState = { online: navigator.onLine, syncing: false, pending: 0, drafts: 0, failed: 0, lastSync: null };
const listeners = new Set<() => void>();
function set(patch: Partial<SyncState>) {
  st = { ...st, ...patch };
  listeners.forEach((fn) => fn());
}

export function useSync(): SyncState {
  const [s, setS] = useState(st);
  useEffect(() => {
    const fn = () => setS(st);
    listeners.add(fn);
    fn();
    return () => void listeners.delete(fn);
  }, []);
  return s;
}

/** Galat karena sinyal: coba lagi nanti. Galat lain berasal dari server dan disimpan untuk ditampilkan. */
export const isNetworkError = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 502);
/** Berhenti dan coba lagi nanti: sinyal hilang atau sesi habis (setelah masuk lagi, antrean dilanjutkan). */
const shouldStop = (e: unknown) => isNetworkError(e) || (e instanceof ApiError && e.status === 401);

let userId: number | null = null;

export async function refreshCounts() {
  if (userId == null) return set({ pending: 0, drafts: 0, failed: 0 });
  try {
    const [ss, ps] = await Promise.all([localScreenings(userId), localPatients(userId)]);
    const queued = ss.filter((s) => s.status === "antre");
    // Pasien baru yang belum diperiksa tetap dihitung; pasien yang ikut pemeriksaan antre sudah terhitung di sana
    const loose = ps.filter((p) => !ss.some((s) => s.patient_id === p.id));
    set({
      pending: queued.length + loose.length,
      drafts: ss.length - queued.length,
      failed: queued.filter((s) => s.error).length + loose.filter((p) => p.error).length,
    });
  } catch {
    /* IndexedDB tidak tersedia */
  }
}

async function syncPatient(p: LocalPatient): Promise<string> {
  if (p.server_id) return p.server_id;
  const { id: client_id, ...body } = p;
  const saved = await post<Patient & { merged: boolean }>("/api/sync/patient", { ...body, client_id });
  await savePatient({ ...p, server_id: saved.id, error: null });
  await idb.put("directory", saved);
  return saved.id;
}

/** Pasien offline -> id server. Dipakai juga saat memulai pemeriksaan online untuk pasien yang didaftarkan offline. */
export async function serverPatientId(id: string): Promise<string> {
  if (!isLocalId(id)) return id;
  const p = await idb.get<LocalPatient>("patients", id);
  if (!p) throw new Error("Data pasien offline tidak ditemukan di HP ini.");
  return syncPatient(p);
}

async function syncScreening(s: LocalScreening) {
  const patientId = await serverPatientId(s.patient_id);
  if (patientId !== s.patient_id) {
    s = { ...s, patient_id: patientId, patient: { ...s.patient, id: patientId } };
    await putLocalScreening(s);
  }

  const vitals = Object.fromEntries(VITAL_KEYS.map((k) => [k, s[k]]));
  const draft = await post<ScreeningDetail>("/api/sync/screening", {
    ...vitals,
    patient_id: patientId,
    client_id: s.id,
    created_at: s.created_at,
  });
  s = { ...s, server_id: draft.id };
  await putLocalScreening(s);

  if (draft.status === "draf") {
    for (const img of s.images) {
      if (img.server_id) continue;
      const form = new FormData();
      form.append("eye", img.eye);
      form.append("source", img.source);
      form.append("client_id", img.id);
      form.append("file", img.blob, "retina.jpg");
      const saved = await api<{ id: string }>(`/api/screenings/${draft.id}/images`, { method: "POST", body: form });
      img.server_id = saved.id;
      await putLocalScreening(s);
    }
    try {
      await post(`/api/screenings/${draft.id}/submit`);
    } catch (e) {
      // Sudah terkirim pada percobaan sebelumnya, tetapi jawabannya tidak sampai ke HP
      if (!(e instanceof ApiError && e.status === 409) || (await get<ScreeningDetail>(`/api/screenings/${draft.id}`)).status === "draf") throw e;
    }
  }
  await deleteLocalScreening(s.id);
}

let running: Promise<void> | null = null;

/** Kirim semua yang antre. Aman dipanggil berkali-kali; panggilan yang bersamaan memakai proses yang sama. */
export function syncNow(): Promise<void> {
  if (userId == null || !navigator.onLine) return refreshCounts();
  running ??= (async () => {
    set({ syncing: true });
    try {
      const uid = userId!;
      for (const s of await localScreenings(uid)) {
        if (s.status !== "antre") continue;
        try {
          await syncScreening(s);
        } catch (e) {
          if (shouldStop(e)) break;
          const cur = await getLocalScreening(s.id);
          if (cur) await putLocalScreening({ ...cur, error: (e as Error).message });
        }
      }
      // Pasien baru tanpa pemeriksaan (mis. hanya didaftarkan) juga dikirim
      const used = new Set((await localScreenings(uid)).map((s) => s.patient_id));
      for (const p of await localPatients(uid)) {
        if (used.has(p.id)) continue;
        try {
          await syncPatient(p);
        } catch (e) {
          if (shouldStop(e)) break;
          await savePatient({ ...p, error: (e as Error).message });
        }
      }
      set({ lastSync: Date.now() });
    } finally {
      running = null;
      set({ syncing: false });
      await refreshCounts();
    }
  })();
  return running;
}

let timer: number | undefined;

/** Mulai memantau sinyal untuk akun yang sedang masuk (null = keluar). */
export function startSync(uid: number | null) {
  userId = uid;
  window.clearInterval(timer);
  refreshCounts();
  if (uid == null) return;
  syncNow();
  // Sinyal lemah sering tidak memicu event "online"; coba juga berkala selama ada yang antre
  timer = window.setInterval(() => st.pending && syncNow(), 60_000);
}

window.addEventListener("online", () => {
  set({ online: true });
  syncNow();
});
window.addEventListener("offline", () => set({ online: false }));
// navigator.onLine bisa true padahal tidak ada internet (Wi-Fi tanpa kuota); percaya hasil permintaan sungguhan
onNetwork((ok) => {
  if (ok === st.online) return;
  set({ online: ok });
  if (ok) syncNow();
});
