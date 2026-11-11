export type Role = "perawat" | "dokter" | "admin" | "pasien";
export type StaffRole = Exclude<Role, "pasien">;
export type Payer = "umum" | "bpjs" | "asuransi";

export interface User {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  active: boolean;
  created_at: number;
  last_login: number | null;
  patient_id: string | null;
  /** NIK tenaga kesehatan, untuk mencari nomor IHS Practitioner di SATUSEHAT */
  nik: string | null;
  satusehat_linked: boolean;
}

export interface SatusehatState {
  status: "mengirim" | "terkirim" | "gagal" | null;
  error: string | null;
  sent_at: number | null;
  encounter_id: string | null;
  env: "sandbox" | "production";
}

/** Deskripsi model bahasa lokal (llama.cpp). Bagian dokter hanya untuk peran yang boleh melihat AI. */
export interface LlmState {
  status: "membuat" | "selesai" | "gagal" | null;
  available: boolean;
  error?: string | null;
  at?: number | null;
  model?: string | null;
  vision?: boolean | null;
  mata_kanan?: string | null;
  mata_kiri?: string | null;
  ringkasan_dokter?: string | null;
  penjelasan_pasien?: string | null;
}

export interface SatusehatStatus {
  configured: boolean;
  env: "sandbox" | "production";
  org_id: string | null;
  auto: boolean;
  base_url: string;
}

export interface Patient {
  id: string;
  mrn: string;
  nik: string | null;
  full_name: string;
  sex: "L" | "P" | null;
  birth_date: string | null;
  phone: string | null;
  address: string | null;
  diabetes_type: "tipe1" | "tipe2" | "gestasional" | "tidak_tahu" | "tidak" | null;
  diabetes_since: number | null;
  on_insulin: boolean | null;
  hypertension: boolean | null;
  notes: string | null;
  payer: Payer | null;
  bpjs_no: string | null;
  bpjs_status: "aktif" | "tidak_aktif" | null;
  bpjs_class: string | null;
  bpjs_checked_at: number | null;
  insurer: string | null;
  policy_no: string | null;
  created_by: number | null;
  created_at: number;
  last_screening_at?: number | null;
  last_decision?: Decision | null;
  /** Pemeriksaan terbaru yang ada fotonya. Kolom ai_* kosong bila peran ini tidak boleh melihat AI. */
  latest?: Pick<ScreeningSummary, "id" | "status" | "created_at" | "decision" | "ai_grade" | "ai_p_referable" | "ai_referable" | "image_count" | "thumbnail_url"> | null;
}

export type ScreeningStatus = "draf" | "menunggu" | "dibaca";
export type Decision = "rujuk_segera" | "rujuk" | "rujuk_lain" | "ulang_6" | "ulang_12" | "normal" | "foto_ulang";
export type Eye = "kanan" | "kiri";

export interface Quality {
  ok: boolean;
  /** false = bukan foto fundus (atau sudah diolah); AI tidak menilai foto ini. Tidak ada pada foto lama. */
  is_fundus?: boolean;
  issues: string[];
  brightness: number;
  sharpness: number;
}

export interface RetinaImage {
  id: string;
  ts: number;
  device: string;
  source: string;
  image_url: string;
  preprocessed_url: string;
  heatmap_url: string;
  quality: Quality;
  /** Fokus AI (CAM): hanya untuk peran yang boleh melihat hasil AI */
  cam_url?: string | null;
  /** Derajat yang dijelaskan peta Fokus AI */
  cam_grade?: number | null;
  eye: Eye | null;
  // Hanya untuk dokter/admin
  grade?: number;
  label?: string;
  confidence?: number;
  referable?: boolean;
  p_referable?: number;
  probs?: number[];
}

export interface Tariff {
  id: string;
  name: string;
  /** Rupiah. 0 = gratis */
  price: number;
  description: string | null;
  active: boolean;
  is_default: boolean;
}

export interface Billing {
  tariff_id: string;
  name: string;
  price: number;
  free: boolean;
  /** Gratis dianggap lunas */
  paid: boolean;
  paid_at: number | null;
  payer: Payer;
  /** BPJS: pasien tidak membayar, ditagihkan lewat klaim */
  covered: boolean;
  payer_ref?: string | null;
  patient_id?: string;
  /** Hasil cek kepesertaan terakhir di SATUSEHAT */
  coverage: { status: "aktif" | "tidak_ditemukan"; payor: string | null; checked_at: number } | null;
}

export interface ScreeningSummary {
  id: string;
  patient_id: string;
  nurse_id: number | null;
  status: ScreeningStatus;
  created_at: number;
  submitted_at: number | null;
  location: string | null;
  glucose: number | null;
  glucose_kind: "puasa" | "sewaktu" | "2jpp" | null;
  hba1c: number | null;
  systolic: number | null;
  diastolic: number | null;
  va_right: string | null;
  va_left: string | null;
  complaints: string | null;
  nurse_notes: string | null;
  ai_grade: number | null;
  ai_p_referable: number | null;
  ai_referable: boolean | null;
  doctor_id: number | null;
  reviewed_at: number | null;
  dr_grade_right: number | null;
  dr_grade_left: number | null;
  dr_dme: boolean | null;
  decision: Decision | null;
  doctor_notes: string | null;
  nurse_name: string | null;
  doctor_name: string | null;
  image_count: number;
  thumbnail_url: string | null;
  billing: Billing | null;
  patient?: Pick<Patient, "id" | "mrn" | "full_name" | "sex" | "birth_date"> | null;
}

export interface ScreeningDetail extends ScreeningSummary {
  patient: Patient;
  images: RetinaImage[];
  previous: ScreeningSummary[];
  ref_threshold: number | null;
  labels: string[];
  /** Hanya untuk dokter/admin bila SATUSEHAT diatur di server */
  satusehat: SatusehatState | null;
  llm: LlmState | null;
}

export interface Device {
  id: string;
  ip: string | null;
  last_seen: number;
  online: boolean;
  capture_pending: boolean;
  settings_version: number;
  applied_version: number | null;
  live: boolean;
  frame_ts: number | null;
}

export interface CameraSettings {
  version?: number;
  resolution: string;
  jpeg_quality: number;
  brightness: number;
  contrast: number;
  saturation: number;
  ae_level: number;
  awb: boolean;
  hmirror: boolean;
  vflip: boolean;
  flash_mode: "off" | "capture" | "on";
  flash_intensity: number;
  live_resolution: "QVGA" | "HVGA" | "VGA";
}

export interface CaptureStatus {
  status: "menunggu" | "memotret" | "selesai" | "gagal";
  error: string | null;
  result: RetinaImage | null;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

function errorMessage(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    // Galat validasi Pydantic: ambil pesan pertama yang terbaca manusia
    const first = detail[0] as { msg?: string };
    return (first.msg ?? "Data tidak valid.").replace(/^Value error, /, "");
  }
  if (status === 0) return "Tidak terhubung ke server. Periksa sinyal internet lalu coba lagi.";
  return `Terjadi kesalahan di server (${status}). Coba lagi.`;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers,
      credentials: "same-origin",
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError(0, errorMessage(null, 0));
  }
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/api/auth/")) unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError(res.status, errorMessage(body, res.status));
  }
  return body as T;
}

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, json?: unknown) => api<T>(path, { method: "POST", json: json ?? {} });
export const put = <T,>(path: string, json: unknown) => api<T>(path, { method: "PUT", json });
export const patch = <T,>(path: string, json: unknown) => api<T>(path, { method: "PATCH", json });
export const del = <T,>(path: string) => api<T>(path, { method: "DELETE" });

export function uploadImage(screeningId: string, eye: Eye, file: Blob, source: "hp" | "galeri") {
  const form = new FormData();
  form.append("eye", eye);
  form.append("source", source);
  form.append("file", file, "retina.jpg");
  return api<RetinaImage>(`/api/screenings/${screeningId}/images`, { method: "POST", body: form });
}

/* ---------- Jadwal, booking, antrean ---------- */
export type ApptStatus = "terdaftar" | "hadir" | "dipanggil" | "selesai" | "batal" | "tidak_hadir";

export interface Schedule {
  id: string;
  doctor_id: number;
  doctor_name: string | null;
  weekday: number;
  weekday_name: string;
  start_time: string;
  end_time: string;
  quota: number;
  location: string | null;
  active: boolean;
}

export interface Slot {
  schedule_id: string;
  doctor_id: number;
  doctor_name: string;
  date: string;
  start_time: string;
  end_time: string;
  location: string | null;
  quota: number;
  booked: number;
  remaining: number;
  bookable: boolean;
  onsite_open: boolean;
  counts?: Record<ApptStatus, number>;
}

export interface Appointment {
  id: string;
  code: string;
  patient_id: string;
  schedule_id: string;
  doctor_id: number;
  doctor_name: string | null;
  date: string;
  start_time: string;
  end_time: string;
  location: string | null;
  queue_no: number;
  source: "online" | "onsite";
  payer: Payer;
  payer_ref: string | null;
  complaint: string | null;
  status: ApptStatus;
  created_at: number;
  checked_in_at: number | null;
  called_at: number | null;
  done_at: number | null;
  now_serving: number | null;
  ahead: number;
  patient?: Pick<Patient, "id" | "mrn" | "full_name" | "sex" | "birth_date" | "phone" | "payer" | "bpjs_no" | "bpjs_status" | "insurer"> | null;
}

export interface QueueSession extends Slot {
  appointments: Appointment[];
  now_serving: number | null;
}

export interface MyProfile {
  id: string;
  mrn: string;
  nik: string | null;
  full_name: string;
  sex: "L" | "P" | null;
  birth_date: string | null;
  phone: string | null;
  payer: Payer | null;
  bpjs_no: string | null;
  bpjs_status: "aktif" | "tidak_aktif" | null;
  bpjs_class: string | null;
  bpjs_checked_at: number | null;
  insurer: string | null;
  policy_no: string | null;
  bpjs_enabled: boolean;
}

export interface DoctorWithSchedules {
  id: number;
  full_name: string;
  schedules: Schedule[];
}
