/**
 * AI offline di HP: cek kualitas foto, preprocessing, dan model ONNX yang sama dengan server.
 *
 * Langkah-langkahnya meniru server/preprocess.py (crop_black_border, ben_graham, _fundus_features,
 * quality_check). Hasilnya mendekati server, tidak identik bit demi bit (resize dan pembulatan sedikit
 * berbeda dari OpenCV). Karena itu foto tetap dinilai ulang oleh server saat sinkron, dan nilai server
 * yang dipakai dokter.
 */
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url";
import mjsUrl from "../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url";
import type { OfflineMeta, AnalyzeResult } from "./ai";

ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };
// Multithread butuh cross-origin isolation (header COOP/COEP) yang tidak dipasang server; satu thread cukup.
ort.env.wasm.numThreads = 1;

export const MODEL_CACHE = "retinova-model";

/** Citra RGB 8-bit, tiga byte per piksel. */
interface Img {
  w: number;
  h: number;
  d: Uint8Array;
}

/* ---------- operasi citra dasar ---------- */

async function decode(blob: Blob): Promise<Img> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const d = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    d[j] = rgba[i];
    d[j + 1] = rgba[i + 1];
    d[j + 2] = rgba[i + 2];
  }
  return { w: canvas.width, h: canvas.height, d };
}

function toGray({ w, h, d }: Img): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 3) g[i] = Math.round(0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]);
  return g;
}

function cropBlackBorder(img: Img, tol = 7): Img {
  const g = toGray(img);
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++)
      if (g[y * img.w + x] > tol) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return img;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const d = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) d.set(img.d.subarray(((y + y0) * img.w + x0) * 3, ((y + y0) * img.w + x1 + 1) * 3), y * w * 3);
  return { w, h, d };
}

/** Bobot resize "area" (rata-rata piksel yang tertutup), seperti cv2.INTER_AREA saat memperkecil. */
function areaWeights(src: number, dst: number) {
  const scale = src / dst;
  const out: { i: number; w: number }[][] = [];
  for (let x = 0; x < dst; x++) {
    const a = x * scale, b = Math.min(src, (x + 1) * scale);
    const taps: { i: number; w: number }[] = [];
    for (let i = Math.floor(a); i < Math.ceil(b); i++) taps.push({ i, w: (Math.min(b, i + 1) - Math.max(a, i)) / (b - a) });
    out.push(taps);
  }
  return out;
}

function resizeArea(img: Img, dw: number, dh: number): Img {
  const wx = areaWeights(img.w, dw), wy = areaWeights(img.h, dh);
  const tmp = new Float32Array(dw * img.h * 3);
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < dw; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (const t of wx[x]) s += img.d[(y * img.w + t.i) * 3 + c] * t.w;
        tmp[(y * dw + x) * 3 + c] = s;
      }
  const d = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++)
    for (let x = 0; x < dw; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (const t of wy[y]) s += tmp[(t.i * dw + x) * 3 + c] * t.w;
        d[(y * dw + x) * 3 + c] = Math.round(s);
      }
  return { w: dw, h: dh, d };
}

/** Indeks tepi gaya BORDER_REFLECT_101 (bawaan OpenCV): ...2 1 | 0 1 2 ... */
function reflect(i: number, n: number) {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
  return i;
}

function gaussKernel(ksize: number, sigma: number) {
  const k = new Float64Array(ksize);
  const c = (ksize - 1) / 2;
  let sum = 0;
  for (let i = 0; i < ksize; i++) sum += k[i] = Math.exp(-((i - c) ** 2) / (2 * sigma * sigma));
  return k.map((v) => v / sum);
}

/** cv2.GaussianBlur untuk citra ch kanal 8-bit (dipisah horizontal lalu vertikal). */
function gaussianBlur(d: Uint8Array, w: number, h: number, ch: number, ksize: number, sigma: number): Uint8Array {
  const k = gaussKernel(ksize, sigma);
  const r = (ksize - 1) / 2;
  const tmp = new Float32Array(d.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < ch; c++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += d[(y * w + reflect(x + i, w)) * ch + c] * k[i + r];
        tmp[(y * w + x) * ch + c] = s;
      }
  const out = new Uint8Array(d.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < ch; c++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += tmp[(reflect(y + i, h) * w + x) * ch + c] * k[i + r];
        out[(y * w + x) * ch + c] = Math.min(255, Math.max(0, Math.round(s)));
      }
  return out;
}

function circleMask(size: number) {
  const m = new Uint8Array(size * size);
  const c = Math.floor(size / 2), r = Math.floor(size * 0.48);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) m[y * size + x] = (x - c) ** 2 + (y - c) ** 2 <= r * r ? 1 : 0;
  return m;
}

/* ---------- preprocessing model ---------- */

function preprocess(img: Img, size: number, mode: string): Img {
  const out = resizeArea(cropBlackBorder(img), size, size);
  const mask = circleMask(size);
  if (mode === "ben_graham") {
    const sigma = size / 30;
    const blur = gaussianBlur(out.d, size, size, 3, Math.round(sigma * 3 * 2 + 1) | 1, sigma);
    for (let i = 0; i < out.d.length; i++) out.d[i] = Math.min(255, Math.max(0, Math.round(4 * out.d[i] - 4 * blur[i] + 128)));
  }
  for (let p = 0; p < mask.length; p++) if (!mask[p]) out.d[p * 3] = out.d[p * 3 + 1] = out.d[p * 3 + 2] = 0;
  return out;
}

function toTensor(img: Img, mean: number[], std: number[]) {
  const n = img.w * img.h;
  const t = new Float32Array(3 * n);
  for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) t[c * n + p] = (img.d[p * 3 + c] / 255 - mean[c]) / std[c];
  return new ort.Tensor("float32", t, [1, 3, img.h, img.w]);
}

async function toJpeg(img: Img): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.w, img.h);
  const ctx = canvas.getContext("2d")!;
  const data = ctx.createImageData(img.w, img.h);
  for (let p = 0; p < img.w * img.h; p++) {
    data.data.set(img.d.subarray(p * 3, p * 3 + 3), p * 4);
    data.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
}

/* ---------- cek kualitas (server/preprocess.py quality_check) ---------- */

/** Erosi atau dilatasi kotak k×k pada masker biner. Piksel di luar bingkai tidak ikut dihitung, seperti OpenCV. */
function morph(m: Uint8Array, w: number, h: number, k: number, erode: boolean) {
  const r = Math.floor(k / 2);
  const pass = (src: Uint8Array, horiz: boolean) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = erode ? 1 : 0;
        for (let i = -r; i <= r && v === (erode ? 1 : 0); i++) {
          const xx = horiz ? x + i : x, yy = horiz ? y : y + i;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          if (src[yy * w + xx] !== v) v = src[yy * w + xx];
        }
        out[y * w + x] = v;
      }
    return out;
  };
  return pass(pass(m, true), false);
}

/** Komponen terang terbesar (8-tetangga) beserta lubang di dalamnya, setara drawContours(-1, filled). */
function largestFilled(m: Uint8Array, w: number, h: number): { fov: Uint8Array; boundary: [number, number][] } | null {
  const label = new Int32Array(m.length);
  const stack: number[] = [];
  let best = 0, bestSize = 0, next = 0;
  for (let p = 0; p < m.length; p++) {
    if (!m[p] || label[p]) continue;
    label[p] = ++next;
    stack.push(p);
    let size = 0;
    while (stack.length) {
      const q = stack.pop()!;
      size++;
      const x = q % w, y = (q - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const n = yy * w + xx;
          if (m[n] && !label[n]) {
            label[n] = next;
            stack.push(n);
          }
        }
    }
    if (size > bestSize) (bestSize = size), (best = next);
  }
  if (!best) return null;
  // Isi lubang: yang bukan komponen dan tidak tersambung ke tepi bingkai berarti di dalam retina
  const outside = new Uint8Array(m.length);
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) if (label[y * w + x] !== best && !outside[y * w + x]) (outside[y * w + x] = 1), stack.push(y * w + x);
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) if (label[y * w + x] !== best && !outside[y * w + x]) (outside[y * w + x] = 1), stack.push(y * w + x);
  while (stack.length) {
    const q = stack.pop()!;
    const x = q % w, y = (q - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const n = yy * w + xx;
      if (!outside[n] && label[n] !== best) (outside[n] = 1), stack.push(n);
    }
  }
  const fov = new Uint8Array(m.length);
  const boundary: [number, number][] = [];
  for (let p = 0; p < m.length; p++) {
    if (label[p] !== best) continue;
    const x = p % w, y = (p - x) / w;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || label[p - 1] !== best || label[p + 1] !== best || label[p - w] !== best || label[p + w] !== best)
      boundary.push([x, y]);
  }
  for (let p = 0; p < m.length; p++) fov[p] = outside[p] ? 0 : 1;
  return { fov, boundary };
}

/** Jari-jari lingkaran terkecil yang memuat semua titik (algoritme Welzl iteratif). */
function enclosingRadius(pts: [number, number][]) {
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }
  type C = { x: number; y: number; r: number };
  const inside = (c: C, p: [number, number]) => Math.hypot(p[0] - c.x, p[1] - c.y) <= c.r + 1e-7;
  const two = (a: [number, number], b: [number, number]): C => ({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, r: Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 });
  const three = (a: [number, number], b: [number, number], c: [number, number]): C => {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) {
      const cs = [two(a, b), two(a, c), two(b, c)];
      return cs.reduce((m, x) => (x.r > m.r ? x : m));
    }
    const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
    const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
    const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    return { x, y, r: Math.hypot(a[0] - x, a[1] - y) };
  };
  let c: C = { x: pts[0][0], y: pts[0][1], r: 0 };
  for (let i = 1; i < pts.length; i++) {
    if (inside(c, pts[i])) continue;
    c = { x: pts[i][0], y: pts[i][1], r: 0 };
    for (let j = 0; j < i; j++) {
      if (inside(c, pts[j])) continue;
      c = two(pts[i], pts[j]);
      for (let k = 0; k < j; k++) if (!inside(c, pts[k])) c = three(pts[i], pts[j], pts[k]);
    }
  }
  return c.r;
}

function fundusFeatures(src: Img) {
  const s = 512 / Math.max(src.w, src.h);
  const img = resizeArea(src, Math.max(1, Math.round(src.w * s)), Math.max(1, Math.round(src.h * s)));
  const { w, h, d } = img;
  const n = w * h;
  const gray = toGray(img);

  const blurred = gaussianBlur(gray, w, h, 1, 9, 0.3 * ((9 - 1) * 0.5 - 1) + 0.8);
  let mask = new Uint8Array(n);
  for (let p = 0; p < n; p++) mask[p] = blurred[p] > 20 ? 1 : 0;
  mask = morph(morph(mask, w, h, 7, true), w, h, 7, false);

  const comp = largestFilled(mask, w, h);
  let fov: Uint8Array = comp?.fov ?? new Uint8Array(n);
  let circularity = 0;
  if (comp) {
    const r = enclosingRadius(comp.boundary);
    let area = 0;
    for (let p = 0; p < n; p++) area += fov[p];
    circularity = area / Math.max(Math.PI * r * r, 1);
  }
  let fovCount = 0;
  for (let p = 0; p < n; p++) fovCount += fov[p];
  if (fovCount < 0.02 * n) (fov = new Uint8Array(n).fill(1)), (fovCount = n);
  let inner: Uint8Array = morph(fov, w, h, 15, true);
  let innerCount = 0;
  for (let p = 0; p < n; p++) innerCount += inner[p];
  if (!innerCount) (inner = fov), (innerCount = fovCount);

  let r = 0, g = 0, b = 0, bright = 0, over = 0;
  for (let p = 0; p < n; p++)
    if (fov[p]) {
      r += d[p * 3];
      g += d[p * 3 + 1];
      b += d[p * 3 + 2];
      bright += gray[p];
      if (gray[p] > 245) over++;
    }
  r /= fovCount;
  g /= fovCount;
  b /= fovCount;
  const total = r + g + b + 1e-6;

  const k = Math.max(4, Math.floor(0.06 * Math.min(w, h)));
  let dark = 0;
  for (const [y0, x0] of [[0, 0], [0, w - k], [h - k, 0], [h - k, w - k]])
    for (let y = y0; y < y0 + k; y++) for (let x = x0; x < x0 + k; x++) if (gray[y * w + x] < 25) dark++;

  // Varians Laplacian (kernel 3×3, cv2.Laplacian ksize=1) dan simpangan baku kanal hijau di bagian dalam retina
  const green = (x: number, y: number) => d[(reflect(y, h) * w + reflect(x, w)) * 3 + 1];
  let ls = 0, ls2 = 0, gs = 0, gs2 = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!inner[y * w + x]) continue;
      const c = green(x, y);
      const lap = green(x - 1, y) + green(x + 1, y) + green(x, y - 1) + green(x, y + 1) - 4 * c;
      ls += lap;
      ls2 += lap * lap;
      gs += c;
      gs2 += c * c;
    }
  const variance = (s1: number, s2: number) => Math.max(0, s2 / innerCount - (s1 / innerCount) ** 2);

  return {
    red_ratio: r / total,
    rg_ratio: r / (g + 1e-6),
    blue_ratio: b / total,
    chroma: (Math.max(r, g, b) - Math.min(r, g, b)) / (total / 3),
    fov_ratio: fovCount / n,
    circularity,
    dark_corners: dark / (4 * k * k),
    brightness: bright / fovCount,
    overexposed: over / fovCount,
    sharpness: variance(ls, ls2),
    contrast: Math.sqrt(variance(gs, gs2)),
  };
}

function qualityCheck(img: Img, QC: Record<string, number>) {
  const f = fundusFeatures(img);
  const gray = f.chroma < QC.min_chroma;
  const strong = !gray && f.red_ratio >= QC.min_red_ratio && f.rg_ratio >= QC.min_rg_ratio && f.blue_ratio <= QC.max_blue_ratio;
  const shape =
    f.dark_corners >= QC.min_dark_corners && f.circularity >= QC.min_circularity && f.red_ratio >= QC.loose_min_red_ratio &&
    f.rg_ratio >= QC.loose_min_rg_ratio && f.blue_ratio <= QC.loose_max_blue_ratio;
  const isFundus = strong || shape;
  const issues: string[] = [];
  if (!isFundus) issues.push(gray ? "foto abu-abu: sudah diolah atau bukan foto fundus, unggah foto asli" : "bukan foto fundus retina");
  else if (gray) issues.push("foto monokrom, warna retina tidak terbaca");
  if (f.fov_ratio < QC.min_fov) issues.push("retina terlalu kecil di bingkai");
  if (f.brightness < QC.min_brightness) issues.push("terlalu gelap");
  if (f.brightness > QC.max_brightness || f.overexposed > QC.max_overexposed) issues.push("terlalu terang atau silau");
  if (f.sharpness < QC.min_sharpness) issues.push("buram");
  if (f.contrast < QC.min_contrast) issues.push("kontras rendah");
  const rounded = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(v * (v < 10 ? 1000 : 10)) / (v < 10 ? 1000 : 10)]));
  return { ok: !issues.length, is_fundus: isFundus, issues, ...rounded } as AnalyzeResult["quality"];
}

/* ---------- model ---------- */

let session: { version: string; s: Promise<ort.InferenceSession> } | null = null;

async function modelBytes(meta: OfflineMeta): Promise<ArrayBuffer> {
  const cache = await caches.open(MODEL_CACHE);
  let res = await cache.match(meta.model_url);
  if (!res) {
    const fresh = await fetch(meta.model_url, { credentials: "same-origin" });
    if (!fresh.ok) throw new Error(`Model AI gagal diunduh (${fresh.status}).`);
    // Hapus model versi lama agar tidak memenuhi penyimpanan HP
    for (const k of await cache.keys()) await cache.delete(k);
    await cache.put(meta.model_url, fresh.clone());
    res = fresh;
  }
  return res.arrayBuffer();
}

function getSession(meta: OfflineMeta) {
  if (session?.version !== meta.version) {
    const s = modelBytes(meta).then((buf) => ort.InferenceSession.create(buf, { executionProviders: ["wasm"] }));
    session = { version: meta.version, s };
    s.catch(() => (session = null));
  }
  return session.s;
}

async function analyze(blob: Blob, meta: OfflineMeta): Promise<AnalyzeResult> {
  const t0 = performance.now();
  const img = await decode(blob);
  const quality = qualityCheck(img, meta.quality_thresholds);
  const prep = preprocess(img, meta.img_size, meta.preprocess_mode);
  const sess = await getSession(meta);
  const out = await sess.run({ [sess.inputNames[0]]: toTensor(prep, meta.mean, meta.std) });
  const logits = Array.from(out[sess.outputNames[0]].data as Float32Array);
  const max = Math.max(...logits);
  const e = logits.map((v) => Math.exp(v - max));
  const sum = e.reduce((a, b) => a + b, 0);
  const probs = e.map((v) => v / sum);
  const grade = probs.indexOf(Math.max(...probs));
  const pRef = probs.slice(meta.ref_grade).reduce((a, b) => a + b, 0);
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    quality,
    prep: await toJpeg(prep),
    ai: {
      grade,
      label: meta.labels[grade],
      confidence: r4(probs[grade]),
      referable: pRef >= meta.ref_prob,
      p_referable: r4(pRef),
      probs: probs.map(r4),
    },
    latency_ms: Math.round(performance.now() - t0),
  };
}

type Msg = { id: number; type: "analyze"; blob: Blob; meta: OfflineMeta } | { id: number; type: "warm"; meta: OfflineMeta };

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  try {
    const result = m.type === "warm" ? (await getSession(m.meta), null) : await analyze(m.blob, m.meta);
    self.postMessage({ id: m.id, result });
  } catch (err) {
    self.postMessage({ id: m.id, error: (err as Error).message || String(err) });
  }
};
