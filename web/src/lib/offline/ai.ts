/** Antarmuka AI offline di thread utama. Pekerjaan berat berjalan di ai.worker.ts agar layar tidak macet. */
import { get, type Quality } from "../api";
import type { AiResult } from "./store";

export interface OfflineMeta {
  version: string;
  model_url: string;
  model_bytes: number;
  labels: string[];
  img_size: number;
  preprocess_mode: string;
  mean: number[];
  std: number[];
  ref_grade: number;
  ref_prob: number;
  quality_thresholds: Record<string, number>;
  can_see_ai: boolean;
}

export interface AnalyzeResult {
  quality: Quality;
  prep: Blob;
  ai: AiResult;
  latency_ms: number;
}

const META_KEY = "retinova.offlineMeta";

export function cachedMeta(): OfflineMeta | null {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) ?? "null");
  } catch {
    return null;
  }
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();

function call<T>(msg: Record<string, unknown>): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL("./ai.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (e.data.error) p?.fail(new Error(e.data.error));
      else p?.ok(e.data.result);
    };
  }
  const id = ++seq;
  return new Promise<T>((ok, fail) => {
    pending.set(id, { ok: ok as (v: unknown) => void, fail });
    worker!.postMessage({ id, ...msg });
  });
}

/* Status kesiapan AI offline, untuk ditampilkan di layar akun dan bilah offline. */
export type ModelState = "belum" | "mengunduh" | "siap" | "gagal";
let state: ModelState = cachedMeta() ? "siap" : "belum";
const listeners = new Set<() => void>();
const setState = (s: ModelState) => {
  state = s;
  listeners.forEach((fn) => fn());
};
export const modelState = () => state;
export function onModelState(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

let preparing: Promise<void> | null = null;

/** Saat online: ambil info model terbaru dan unduh modelnya ke HP (sekali per versi model). */
export function prepareOffline(): Promise<void> {
  preparing ??= (async () => {
    try {
      const meta = await get<OfflineMeta>("/api/offline/meta");
      const same = cachedMeta()?.version === meta.version;
      if (!same) setState("mengunduh");
      await call({ type: "warm", meta });
      localStorage.setItem(META_KEY, JSON.stringify(meta));
      setState("siap");
    } catch (e) {
      console.error("[offline-ai] model gagal disiapkan:", e);
      if (!cachedMeta()) setState("gagal");
    } finally {
      preparing = null;
    }
  })();
  return preparing;
}

/** Cek kualitas + AI di HP. Gagal (mis. model belum pernah diunduh) dilempar sebagai Error. */
export function analyzeOffline(blob: Blob): Promise<AnalyzeResult> {
  const meta = cachedMeta();
  if (!meta) return Promise.reject(new Error("AI offline belum siap. Buka aplikasi sekali saat ada sinyal agar model AI terunduh."));
  return call<AnalyzeResult>({ type: "analyze", blob, meta });
}

export function forgetModelMeta() {
  try {
    localStorage.removeItem(META_KEY);
  } catch {
    /* abaikan */
  }
}
