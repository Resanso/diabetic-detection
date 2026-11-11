import type { Decision, Patient, ScreeningStatus } from "./api";

export const GRADE_LABELS = ["Tidak ada DR", "Ringan", "Sedang", "Berat", "Proliferatif"];
export const GRADE_SHORT = ["Normal", "Ringan", "Sedang", "Berat", "PDR"];

export const DECISIONS: Record<Decision, { title: string; desc: string; tone: "segera" | "rujuk" | "ok" | "ulang" }> = {
  rujuk_segera: { title: "Rujuk segera", desc: "Ke dokter mata dalam 1 minggu. Untuk DR berat, proliferatif, atau curiga edema makula.", tone: "segera" },
  rujuk: { title: "Rujuk terjadwal", desc: "Ke dokter mata dalam 1 sampai 3 bulan. Untuk DR sedang.", tone: "rujuk" },
  rujuk_lain: { title: "Rujuk: kelainan mata lain", desc: "Bukan retinopati diabetik, tetapi ada temuan lain (mis. curiga glaukoma, retinopati hipertensi). Ke dokter mata. Tulis temuannya di catatan.", tone: "rujuk" },
  ulang_6: { title: "Skrining ulang 6 bulan", desc: "DR ringan, kontrol gula darah dan tekanan darah.", tone: "ok" },
  ulang_12: { title: "Skrining ulang 12 bulan", desc: "Pasien diabetes tanpa tanda retinopati.", tone: "ok" },
  normal: { title: "Normal, tidak terdeteksi diabetes", desc: "Retina normal dan tidak ada tanda diabetes. Tidak perlu tindak lanjut khusus; anjurkan cek gula darah rutin.", tone: "ok" },
  foto_ulang: { title: "Perlu foto ulang", desc: "Foto tidak bisa dinilai. Perawat memotret ulang pada kunjungan berikutnya.", tone: "ulang" },
};

export const STATUS_LABELS: Record<ScreeningStatus, string> = {
  draf: "Draf",
  menunggu: "Menunggu dokter",
  dibaca: "Sudah dibaca",
};

export const DIABETES_LABELS: Record<string, string> = {
  tipe1: "Tipe 1",
  tipe2: "Tipe 2",
  gestasional: "Gestasional",
  tidak_tahu: "Belum diketahui",
  tidak: "Tidak diabetes",
};

export const GLUCOSE_KIND: Record<string, string> = { puasa: "puasa", sewaktu: "sewaktu", "2jpp": "2 jam setelah makan" };

const dateFmt = new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" });
const numFmt = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });

export const fmtNum = (n: number | null | undefined) => (n == null ? "-" : numFmt.format(n));
const rpFmt = new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 });
export const fmtRp = (n: number) => (n === 0 ? "Gratis" : rpFmt.format(n));
export const fmtPct = (p: number | null | undefined) => (p == null ? "-" : `${Math.round(p * 100)}%`);

export function fmtDate(ts: number | null | undefined) {
  return ts ? dateFmt.format(new Date(ts * 1000)) : "-";
}

export function fmtDateTime(ts: number | null | undefined) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  return `${dateFmt.format(d)}, ${timeFmt.format(d)}`;
}

/** "hari ini, 09.14", "kemarin, 16.02", atau tanggal. Pakai cap() jika di awal kalimat. */
export function fmtWhen(ts: number | null | undefined) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (d.getTime() >= startToday) return `hari ini, ${timeFmt.format(d)}`;
  if (d.getTime() >= startToday - 86400000) return `kemarin, ${timeFmt.format(d)}`;
  return fmtDateTime(ts);
}

/** "12 menit", "3 jam", "2 hari" sejak waktu tertentu. */
export function fmtWaiting(ts: number | null | undefined) {
  if (!ts) return "-";
  const min = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (min < 60) return `${min} menit`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} jam`;
  return `${Math.round(h / 24)} hari`;
}

export function ageOf(birth: string | null | undefined): number | null {
  if (!birth) return null;
  const b = new Date(birth);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age;
}

export function patientMeta(p: Pick<Patient, "sex" | "birth_date" | "mrn">) {
  const parts: string[] = [];
  const age = ageOf(p.birth_date);
  if (p.sex) parts.push(p.sex === "L" ? "Laki-laki" : "Perempuan");
  if (age != null) parts.push(`${age} th`);
  parts.push(p.mrn);
  return parts.join(", ");
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export const ROLE_LABELS = { perawat: "Perawat", dokter: "Dokter", admin: "Admin", pasien: "Pasien" } as const;

export const PAYER_LABELS = { umum: "Umum", bpjs: "BPJS", asuransi: "Asuransi" } as const;

export const APPT_STATUS: Record<import("./api").ApptStatus, string> = {
  terdaftar: "Belum datang",
  hadir: "Menunggu",
  dipanggil: "Dipanggil",
  selesai: "Selesai",
  batal: "Batal",
  tidak_hadir: "Tidak hadir",
};

export const WEEKDAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

/** Tanggal ISO (YYYY-MM-DD) tanpa geser zona waktu. */
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const fromIso = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (s: string, n: number) => {
  const d = fromIso(s);
  d.setDate(d.getDate() + n);
  return isoDate(d);
};
const longDay = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long" });
const shortDay = new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short" });
/** "Kamis, 30 Oktober", atau "Hari ini" / "Besok" relatif terhadap tanggal hari ini. */
export function fmtDay(s: string, opts: { short?: boolean; today?: string } = {}) {
  const today = opts.today ?? isoDate(new Date());
  if (s === today) return "Hari ini";
  if (s === addDays(today, 1)) return "Besok";
  return (opts.short ? shortDay : longDay).format(fromIso(s));
}
export const queueLabel = (n: number | null | undefined) => (n == null ? "-" : String(n).padStart(3, "0"));

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
