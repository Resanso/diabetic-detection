import { useEffect, useState } from "react";
import { get, put, type CameraSettings } from "../lib/api";
import { Banner, Field, Segmented, useToast } from "./ui";

const RESOLUTIONS = [
  { value: "VGA", label: "640" },
  { value: "SVGA", label: "800" },
  { value: "XGA", label: "1024" },
  { value: "SXGA", label: "1280" },
  { value: "UXGA", label: "1600" },
];

const LIVE_RESOLUTIONS = [
  { value: "QVGA" as const, label: "320" },
  { value: "HVGA" as const, label: "480" },
  { value: "VGA" as const, label: "640" },
];

function Slider({ label, value, min, max, onChange, hint }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <Field label={`${label}: ${value}`} hint={hint}>
      {(p) => <input {...p} type="range" min={min} max={max} step={1} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: "100%", accentColor: "var(--accent)", height: 32 }} />}
    </Field>
  );
}

/** Pengaturan kamera & lampu ESP32. Perangkat menerapkannya pada polling berikutnya (sekitar 2 detik). */
export function DeviceSettings({ deviceId, compact }: { deviceId: string; compact?: boolean }) {
  const toast = useToast();
  const [s, setS] = useState<CameraSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setS(null);
    get<CameraSettings>(`/api/devices/${encodeURIComponent(deviceId)}/settings`).then(setS, (e) => setError(e.message));
  }, [deviceId]);

  if (!s) return error ? <Banner tone="danger">{error}</Banner> : <div className="skeleton" style={{ height: 160 }} />;
  const set = <K extends keyof CameraSettings>(k: K, v: CameraSettings[K]) => setS({ ...s, [k]: v });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const { version: _v, ...body } = s!;
      setS(await put<CameraSettings>(`/api/devices/${encodeURIComponent(deviceId)}/settings`, body));
      toast("Pengaturan dikirim ke perangkat");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error && <Banner tone="danger">{error}</Banner>}
      <Field label="Lampu (flash)">
        {() => (
          <Segmented
            label="Mode lampu"
            value={s.flash_mode}
            onChange={(v) => set("flash_mode", v)}
            options={[
              { value: "off", label: "Mati" },
              { value: "capture", label: "Saat foto" },
              { value: "on", label: "Selalu" },
            ]}
          />
        )}
      </Field>
      <Slider label="Kekuatan lampu" value={s.flash_intensity} min={0} max={255} onChange={(v) => set("flash_intensity", v)} hint="Turunkan jika foto terlalu terang atau ada pantulan putih." />
      <Slider label="Kecerahan" value={s.brightness} min={-2} max={2} onChange={(v) => set("brightness", v)} />
      {!compact && (
        <>
          <Field label="Resolusi (lebar piksel)" hint="Makin besar makin detail, tetapi pengiriman lebih lambat.">
            {() => <Segmented label="Resolusi" value={s.resolution} onChange={(v) => set("resolution", v)} options={RESOLUTIONS} />}
          </Field>
          <Field label="Resolusi tampilan langsung" hint="Hanya untuk membidik. Makin kecil makin lancar dan hemat kuota.">
            {() => <Segmented label="Resolusi tampilan langsung" value={s.live_resolution} onChange={(v) => set("live_resolution", v)} options={LIVE_RESOLUTIONS} />}
          </Field>
          <Slider label="Kontras" value={s.contrast} min={-2} max={2} onChange={(v) => set("contrast", v)} />
          <Slider label="Saturasi" value={s.saturation} min={-2} max={2} onChange={(v) => set("saturation", v)} />
          <Slider label="Koreksi eksposur" value={s.ae_level} min={-2} max={2} onChange={(v) => set("ae_level", v)} />
          <Slider label="Kompresi JPEG" value={s.jpeg_quality} min={8} max={40} onChange={(v) => set("jpeg_quality", v)} hint="Angka kecil = kualitas lebih baik, file lebih besar." />
          <div className="grid-2">
            <Field label="Cermin horizontal">
              {() => <Segmented label="Cermin horizontal" value={s.hmirror ? 1 : 0} onChange={(v) => set("hmirror", v === 1)} options={[{ value: 0, label: "Tidak" }, { value: 1, label: "Ya" }]} />}
            </Field>
            <Field label="Balik vertikal">
              {() => <Segmented label="Balik vertikal" value={s.vflip ? 1 : 0} onChange={(v) => set("vflip", v === 1)} options={[{ value: 0, label: "Tidak" }, { value: 1, label: "Ya" }]} />}
            </Field>
          </div>
        </>
      )}
      <button className="btn btn--secondary btn--block" disabled={busy} onClick={save}>
        {busy ? "Mengirim..." : "Terapkan ke perangkat"}
      </button>
    </div>
  );
}
