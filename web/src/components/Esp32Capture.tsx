import { useEffect, useRef, useState } from "react";
import { Cpu, SlidersHorizontal, X } from "@phosphor-icons/react";
import { get, post, type CaptureStatus, type Device, type Eye, type RetinaImage } from "../lib/api";
import { fmtWhen } from "../lib/format";
import { Banner, Sheet } from "./ui";
import { DeviceSettings } from "./DeviceSettings";

const KEY = "retinova.esp32";
const readSaved = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/**
 * Kamera ESP32-CAM layar penuh, seperti kamera HP: tampilan langsung dari perangkat (stream MJPEG
 * dari server) dan tombol jepret. Foto resolusi penuh diambil perangkat lalu dianalisis server.
 * Perangkat hanya mengirim tampilan langsung selama layar ini terbuka.
 */
export function Esp32Capture({
  screeningId,
  eye,
  onClose,
  onDone,
}: {
  screeningId: string;
  eye: Eye;
  onClose: () => void;
  onDone: (img: RetinaImage) => void;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(readSaved());
  const [phase, setPhase] = useState<"siap" | "menunggu" | "memotret">("siap");
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [streamKey, setStreamKey] = useState(0);   // dinaikkan untuk menyambung ulang stream
  const [streaming, setStreaming] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    let timer: number;
    const load = () =>
      get<Device[]>("/api/devices")
        .then((d) => {
          setDevices(d);
          setDeviceId((cur) =>
            cur && d.some((x) => x.id === cur && x.online) ? cur : (d.find((x) => x.online)?.id ?? cur ?? null),
          );
        })
        .catch((e) => setError(e.message))
        .finally(() => (timer = window.setTimeout(load, 3000)));
    load();
    return () => {
      cancelled.current = true;
      clearTimeout(timer);
    };
  }, []);

  const selected = devices?.find((d) => d.id === deviceId);
  const online = !!selected?.online;

  // Stream baru setiap ganti perangkat atau perangkat kembali online
  useEffect(() => {
    setStreaming(false);
  }, [deviceId, online, streamKey]);

  async function capture() {
    if (!deviceId) return;
    try {
      localStorage.setItem(KEY, deviceId);
    } catch {
      /* penyimpanan lokal tidak tersedia */
    }
    setError(null);
    setPhase("menunggu");
    try {
      const { request_id } = await post<{ request_id: string }>(`/api/screenings/${screeningId}/esp32-capture`, { device_id: deviceId, eye });
      while (!cancelled.current) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await get<CaptureStatus>(`/api/captures/${request_id}`);
        if (st.status === "memotret") setPhase("memotret");
        if (st.status === "selesai" && st.result) return onDone(st.result);
        if (st.status === "gagal") throw new Error(st.error ?? "Foto gagal diambil.");
      }
    } catch (e) {
      setError((e as Error).message);
      setPhase("siap");
    }
  }

  const eyeLabel = eye === "kanan" ? "Mata kanan" : "Mata kiri";
  const status = !devices
    ? "Mencari perangkat..."
    : !selected
      ? "Belum ada ESP32 yang terhubung. Nyalakan perangkat dan pastikan tersambung ke WiFi yang terhubung ke internet."
      : !online
        ? `${selected.id} offline, terakhir terlihat ${fmtWhen(selected.last_seen)}. Pastikan ESP32 menyala dan tersambung WiFi.`
        : null;

  return (
    <div className="camera" role="dialog" aria-modal="true" aria-label={`Kamera ESP32 ${eyeLabel}`}>
      <div className="camera__top">
        <button className="btn btn--icon" aria-label="Tutup kamera" onClick={onClose}>
          <X size={24} />
        </button>
        <span className="t-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {eyeLabel}
          {selected && (
            <span className="camera__device">
              <span className={`pulse ${online ? "" : "pulse--off"}`} aria-hidden />
              <span className="mono">{selected.id}</span>
            </span>
          )}
        </span>
        <button className="btn btn--icon" aria-label="Perangkat, lampu, dan kecerahan" aria-pressed={showSettings} onClick={() => setShowSettings(true)}>
          <SlidersHorizontal size={22} />
        </button>
      </div>

      <div className="camera__stage">
        {online && selected ? (
          <>
            <img
              key={`${selected.id}-${streamKey}`}
              src={`/api/devices/${encodeURIComponent(selected.id)}/stream?k=${streamKey}`}
              alt={`Tampilan langsung ${selected.id}`}
              onLoad={() => setStreaming(true)}
              onError={() => window.setTimeout(() => setStreamKey((k) => k + 1), 3000)}
            />
            <div className="camera__guide" />
            {!streaming && (
              <div className="camera__overlay">
                <div className="waiting-ring" aria-hidden />
                <p>Membuka kamera ESP32...</p>
              </div>
            )}
            {phase !== "siap" && (
              <div className="camera__overlay">
                <div className="waiting-ring" aria-hidden />
                <p>{phase === "menunggu" ? "Mengirim perintah ke perangkat..." : "Memotret dan mengirim foto..."}</p>
                <p style={{ fontSize: 13, color: "#c5c7cb" }}>Tahan posisi lensa sampai foto muncul.</p>
              </div>
            )}
            {phase === "siap" && (
              <p className="camera__hint">
                Tempelkan lensa ke mata pasien. Geser pelan sampai pembuluh darah dan bintik terang (diskus optikus) terlihat jelas di dalam lingkaran.
              </p>
            )}
          </>
        ) : (
          <div className="camera__overlay" style={{ background: "transparent" }}>
            {!devices && <div className="waiting-ring" aria-hidden />}
            <Cpu size={32} />
            <p style={{ maxWidth: "34ch" }}>{status}</p>
          </div>
        )}
      </div>

      {error && (
        <div style={{ padding: "0 var(--s6) var(--s2)" }}>
          <Banner tone="danger">{error}</Banner>
        </div>
      )}

      <div className="camera__bottom">
        <span />
        <button className="shutter" aria-label={`Ambil foto ${eyeLabel.toLowerCase()}`} disabled={!online || phase !== "siap"} onClick={capture} />
        <span />
      </div>

      {showSettings && (
        <Sheet title="Kamera ESP32" onClose={() => setShowSettings(false)}>
          <div className="stack">
            {devices && devices.length > 1 && (
              <div className="radiocards" role="radiogroup" aria-label="Perangkat">
                {devices.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    role="radio"
                    className="radiocard"
                    aria-checked={d.id === deviceId}
                    disabled={!d.online}
                    style={!d.online ? { opacity: 0.6 } : undefined}
                    onClick={() => setDeviceId(d.id)}
                  >
                    <span className="radiocard__dot" />
                    <span style={{ flex: 1 }}>
                      <span className="radiocard__title devicecard" style={{ display: "flex" }}>
                        <Cpu size={18} /> <span className="mono">{d.id}</span>
                      </span>
                      <span className="radiocard__desc" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className={`pulse ${d.online ? "" : "pulse--off"}`} aria-hidden />
                        {d.online ? "Terhubung" : `Terakhir terlihat ${fmtWhen(d.last_seen)}`}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {selected ? <DeviceSettings deviceId={selected.id} compact /> : <p className="muted">Belum ada perangkat untuk diatur.</p>}
          </div>
        </Sheet>
      )}
    </div>
  );
}
