/**
 * Data yang disimpan di HP (IndexedDB):
 * - patients:   pasien yang didaftarkan offline, belum ada di server (id diawali "lokal-")
 * - screenings: pemeriksaan offline beserta foto (Blob) dan hasil AI di HP
 * - directory:  salinan daftar pasien dari server, untuk mencari pasien saat offline
 */
import type { Eye, Patient, Quality, ScreeningDetail, RetinaImage } from "../api";
import { idb } from "./idb";

export const LOCAL_PREFIX = "lokal-";
export const isLocalId = (id: string | undefined | null) => !!id?.startsWith(LOCAL_PREFIX);
export const localId = () => LOCAL_PREFIX + crypto.randomUUID().replace(/-/g, "");

export interface AiResult {
  grade: number;
  label: string;
  confidence: number;
  referable: boolean;
  p_referable: number;
  probs: number[];
}

export interface LocalImage {
  id: string;
  ts: number;
  eye: Eye;
  source: "hp" | "galeri";
  blob: Blob;
  /** Foto olahan model (kontras), dibuat di HP. */
  prep: Blob | null;
  quality: Quality;
  ai: AiResult | null;
  /** Alasan AI di HP gagal (mis. model belum terunduh); dicoba lagi saat draf dibuka. */
  ai_error?: string;
  /** id foto di server setelah terunggah; foto tidak diunggah dua kali. */
  server_id?: string;
}

export type Vitals = Pick<
  ScreeningDetail,
  "location" | "glucose" | "glucose_kind" | "hba1c" | "systolic" | "diastolic" | "va_right" | "va_left" | "complaints" | "nurse_notes"
>;

export interface LocalScreening extends Vitals {
  id: string;
  user_id: number;
  patient_id: string;
  patient: Patient;
  created_at: number;
  /** draf = masih dikerjakan; antre = menunggu sinyal untuk dikirim ke dokter. */
  status: "draf" | "antre";
  submitted_at: number | null;
  images: LocalImage[];
  /** id pemeriksaan di server setelah draf dibuat di sana. */
  server_id?: string;
  /** Galat terakhir dari server yang perlu diperbaiki perawat (bukan karena sinyal). */
  error?: string | null;
}

export interface LocalPatient extends Patient {
  user_id: number;
  server_id?: string;
  error?: string | null;
}

const EMPTY_VITALS: Vitals = {
  location: null,
  glucose: null,
  glucose_kind: null,
  hba1c: null,
  systolic: null,
  diastolic: null,
  va_right: null,
  va_left: null,
  complaints: null,
  nurse_notes: null,
};

/* ---------- pasien ---------- */

export function savePatient(p: LocalPatient) {
  return idb.put("patients", p);
}

export async function localPatients(userId: number) {
  return (await idb.all<LocalPatient>("patients")).filter((p) => p.user_id === userId && !p.server_id);
}

export async function findPatient(id: string): Promise<Patient | undefined> {
  if (isLocalId(id)) {
    const p = await idb.get<LocalPatient>("patients", id);
    return p?.server_id ? (await idb.get<Patient>("directory", p.server_id)) ?? { ...p, id: p.server_id } : p;
  }
  return idb.get<Patient>("directory", id);
}

/** Simpan hasil daftar pasien dari server agar bisa dicari saat offline. */
export async function rememberPatients(list: Patient[]) {
  try {
    await Promise.all(list.map((p) => idb.put("directory", p)));
  } catch {
    /* penyimpanan HP tidak tersedia; pencarian offline saja yang terdampak */
  }
}

export async function searchOffline(q: string, userId: number): Promise<Patient[]> {
  const needle = q.trim().toLowerCase();
  const match = (p: Patient) =>
    !needle || [p.full_name, p.nik, p.mrn, p.phone].some((v) => v?.toLowerCase().includes(needle));
  const [local, dir] = await Promise.all([localPatients(userId), idb.all<Patient>("directory")]);
  const byRecent = (a: Patient, b: Patient) => (b.last_screening_at ?? b.created_at) - (a.last_screening_at ?? a.created_at);
  return [...local.filter(match), ...dir.filter(match).sort(byRecent)].slice(0, 50);
}

/* ---------- pemeriksaan ---------- */

export async function createLocalScreening(patient: Patient, userId: number): Promise<LocalScreening> {
  const s: LocalScreening = {
    ...EMPTY_VITALS,
    id: localId(),
    user_id: userId,
    patient_id: patient.id,
    patient,
    created_at: Date.now() / 1000,
    status: "draf",
    submitted_at: null,
    images: [],
  };
  await idb.put("screenings", s);
  return s;
}

export const getLocalScreening = (id: string) => idb.get<LocalScreening>("screenings", id);
export const putLocalScreening = (s: LocalScreening) => idb.put("screenings", s);
export const deleteLocalScreening = (id: string) => idb.del("screenings", id);

export async function localScreenings(userId: number) {
  return (await idb.all<LocalScreening>("screenings"))
    .filter((s) => s.user_id === userId)
    .sort((a, b) => b.created_at - a.created_at);
}

/* ---------- tampilan ---------- */

const urls = new Map<Blob, string>();
function blobUrl(b: Blob) {
  let u = urls.get(b);
  if (!u) urls.set(b, (u = URL.createObjectURL(b)));
  return u;
}

/** Foto offline dalam bentuk yang sama dengan foto dari server, agar bisa memakai komponen yang sama. */
export function toRetinaImage(img: LocalImage, showAi: boolean): RetinaImage {
  const src = blobUrl(img.blob);
  return {
    id: img.id,
    ts: img.ts,
    device: "hp",
    source: img.source,
    image_url: src,
    preprocessed_url: img.prep ? blobUrl(img.prep) : src,
    heatmap_url: "",
    quality: img.quality,
    eye: img.eye,
    ai_error: img.ai ? undefined : img.ai_error,
    ...(showAi && img.ai && img.quality.is_fundus !== false ? img.ai : {}),
  };
}

export function toDetail(s: LocalScreening, showAi: boolean, labels: string[], refProb: number | null): ScreeningDetail {
  const images = s.images.map((i) => toRetinaImage(i, showAi));
  const scored = s.images.filter((i) => i.ai && i.quality.is_fundus !== false);
  const worst = scored.length ? Math.max(...scored.map((i) => i.ai!.grade)) : null;
  const pRef = scored.length ? Math.max(...scored.map((i) => i.ai!.p_referable)) : null;
  return {
    ...s,
    status: "draf",
    nurse_id: s.user_id,
    ai_grade: showAi ? worst : null,
    ai_p_referable: showAi ? pRef : null,
    ai_referable: showAi && scored.length ? scored.some((i) => i.ai!.referable) : null,
    doctor_id: null,
    reviewed_at: null,
    dr_grade_right: null,
    dr_grade_left: null,
    dr_dme: null,
    decision: null,
    doctor_notes: null,
    nurse_name: null,
    doctor_name: null,
    image_count: images.length,
    thumbnail_url: images[images.length - 1]?.image_url ?? null,
    images,
    previous: [],
    ref_threshold: showAi ? refProb : null,
    labels,
  };
}

/** Hapus semua salinan data server di HP (saat keluar akun). Pekerjaan offline yang belum terkirim tidak dihapus. */
export async function forgetServerCopies() {
  await idb.clear("directory").catch(() => {});
  if ("caches" in window) await Promise.all(["api", "images"].map((c) => caches.delete(c))).catch(() => {});
}
