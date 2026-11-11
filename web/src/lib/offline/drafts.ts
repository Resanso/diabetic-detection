/**
 * Operasi draf pemeriksaan dengan dua penyimpanan: server (online) atau HP (id "lokal-...", dibuat saat offline).
 * Layar ScreeningFlow memakai antarmuka yang sama untuk keduanya.
 */
import { del, get, patch, post, uploadImage, type Eye, type RetinaImage, type ScreeningDetail } from "../api";
import { analyzeOffline, cachedMeta } from "./ai";
import {
  deleteLocalScreening,
  getLocalScreening,
  isLocalId,
  localId,
  putLocalScreening,
  toDetail,
  toRetinaImage,
  type LocalImage,
  type LocalScreening,
  type Vitals,
} from "./store";
import { refreshCounts, syncNow } from "./sync";

const LABELS = ["Tidak ada DR", "Ringan", "Sedang", "Berat", "Proliferatif"];

export interface DraftOps {
  local: boolean;
  load(): Promise<ScreeningDetail>;
  saveVitals(v: Partial<Vitals>): Promise<ScreeningDetail>;
  addImage(eye: Eye, blob: Blob, source: "hp" | "galeri"): Promise<RetinaImage>;
  removeImage(imageId: string): Promise<void>;
  /** HP: nilai ulang foto yang belum dinilai AI (mis. model baru terunduh). null bila tidak ada yang berubah. */
  retryAi?(): Promise<ScreeningDetail | null>;
  /** Server: kirim ke dokter. HP: masukkan antrean kirim, lalu coba kirim bila ada sinyal. */
  submit(notes: string | null): Promise<void>;
  remove(): Promise<void>;
}

function remoteOps(id: string): DraftOps {
  return {
    local: false,
    load: () => get<ScreeningDetail>(`/api/screenings/${id}`),
    saveVitals: (v) => patch<ScreeningDetail>(`/api/screenings/${id}`, v),
    addImage: (eye, blob, source) => uploadImage(id, eye, blob, source),
    removeImage: (imageId) => del(`/api/screenings/${id}/images/${imageId}`).then(() => {}),
    submit: async (notes) => {
      if (notes != null) await patch(`/api/screenings/${id}`, { nurse_notes: notes });
      await post(`/api/screenings/${id}/submit`);
    },
    remove: () => del(`/api/screenings/${id}`).then(() => {}),
  };
}

/** Cek kualitas + AI di HP. Gagal tidak menghalangi penyimpanan foto; alasannya disimpan untuk ditampilkan. */
async function analyze(img: LocalImage) {
  try {
    const r = await analyzeOffline(img.blob);
    Object.assign(img, { quality: r.quality, prep: r.prep, ai: r.ai, ai_error: undefined });
  } catch (e) {
    img.ai_error = (e as Error).message || String(e);
    console.warn("[Retinova] AI offline tidak berjalan:", e);
  }
}

function localOps(id: string): DraftOps {
  const showAi = () => cachedMeta()?.can_see_ai ?? false;
  const detail = (s: LocalScreening) => toDetail(s, showAi(), cachedMeta()?.labels ?? LABELS, cachedMeta()?.ref_prob ?? null);
  async function load(): Promise<LocalScreening> {
    const s = await getLocalScreening(id);
    if (!s) throw new Error("Pemeriksaan ini tidak ada di HP. Mungkin sudah terkirim ke server.");
    return s;
  }
  async function update(fn: (s: LocalScreening) => LocalScreening) {
    const s = fn(await load());
    await putLocalScreening(s);
    return s;
  }
  return {
    local: true,
    load: async () => detail(await load()),
    saveVitals: async (v) => detail(await update((s) => ({ ...s, ...v }))),
    addImage: async (eye, blob, source) => {
      const img: LocalImage = {
        id: localId(),
        ts: Date.now() / 1000,
        eye,
        source,
        blob,
        prep: null,
        // Tanpa model di HP foto tetap disimpan; kualitasnya dicek server saat sinkron
        quality: { ok: true, issues: [], brightness: 0, sharpness: 0 },
        ai: null,
      };
      await analyze(img);
      await update((s) => ({ ...s, images: [...s.images, img] }));
      return toRetinaImage(img, showAi());
    },
    retryAi: async () => {
      const s = await load();
      const todo = s.images.filter((i) => !i.ai);
      if (!todo.length || !cachedMeta()) return null;
      for (const img of todo) await analyze(img);
      if (!todo.some((i) => i.ai)) return null;
      // Simpan hanya hasil AI, agar perubahan lain yang terjadi selama menilai tidak tertimpa
      return detail(
        await update((cur) => ({ ...cur, images: cur.images.map((i) => todo.find((t) => t.id === i.id) ?? i) })),
      );
    },
    removeImage: async (imageId) => {
      await update((s) => ({ ...s, images: s.images.filter((i) => i.id !== imageId) }));
    },
    submit: async (notes) => {
      await update((s) => ({ ...s, nurse_notes: notes ?? s.nurse_notes, status: "antre", submitted_at: Date.now() / 1000, error: null }));
      syncNow();
    },
    remove: () => deleteLocalScreening(id).then(refreshCounts),
  };
}

export const draftOps = (id: string): DraftOps => (isLocalId(id) ? localOps(id) : remoteOps(id));
