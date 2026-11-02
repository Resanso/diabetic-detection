import { useEffect, useRef, useState } from "react";
import { CaretDown, Cpu, WifiSlash } from "@phosphor-icons/react";
import { get, post, type CaptureStatus, type Device, type Eye, type RetinaImage } from "../lib/api";
import { fmtWhen } from "../lib/format";
import { Banner, Empty, Sheet } from "./ui";
import { DeviceSettings } from "./DeviceSettings";

const KEY = "retinova.esp32";
const readSaved = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** Lembar untuk memotret lewat ESP32-CAM: pilih perangkat, kirim perintah, tunggu foto masuk. */
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
  const [phase, setPhase] = useState<"pilih" | "menunggu" | "memotret">("pilih");
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    let timer: number;
    const load = () =>
      get<Device[]>("/api/devices")
        .then((d) => {
          setDevices(d);
          setDeviceId((cur) => (cur && d.some((x) => x.id === cur) ? cur : (d.find((x) => x.online)?.id ?? null)));
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
      setPhase("pilih");
    }
  }

  const eyeLabel = eye === "kanan" ? "mata kanan" : "mata kiri";

  return (
    <Sheet title={`Foto ${eyeLabel} dengan ESP32`} onClose={onClose}>
      {phase !== "pilih" ? (
        <div className="stack" style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "24px 0" }}>
          <div className="waiting-ring" aria-hidden />
          <p className="t-heading">{phase === "menunggu" ? "Mengirim perintah ke perangkat..." : "Memotret dan mengirim foto..."}</p>
          <p className="muted" style={{ maxWidth: "34ch" }}>
            Tahan posisi lensa sampai foto muncul. Biasanya 3 sampai 8 detik.
          </p>
        </div>
      ) : (
        <div className="stack">
          {error && <Banner tone="danger">{error}</Banner>}
          {devices === null ? (
            <div className="skeleton" style={{ height: 64 }} />
          ) : devices.length === 0 ? (
            <Empty icon={WifiSlash}>
              Belum ada ESP32 yang terhubung. Nyalakan perangkat dan pastikan tersambung ke WiFi yang sama dengan internet.
            </Empty>
          ) : (
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

          {selected?.online && (
            <>
              <button type="button" className="btn btn--ghost" style={{ alignSelf: "flex-start" }} aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>
                Atur lampu dan kecerahan
                <CaretDown size={16} style={{ transform: showSettings ? "rotate(180deg)" : undefined }} />
              </button>
              {showSettings && <DeviceSettings deviceId={selected.id} compact />}
            </>
          )}

          <button className="btn btn--primary btn--lg btn--block" disabled={!selected?.online} onClick={capture}>
            Ambil foto {eyeLabel}
          </button>
        </div>
      )}
    </Sheet>
  );
}
