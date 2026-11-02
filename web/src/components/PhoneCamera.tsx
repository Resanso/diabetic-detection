import { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, Flashlight, Image as ImageIcon, X } from "@phosphor-icons/react";
import type { Eye } from "../lib/api";

type TorchCaps = MediaTrackCapabilities & { torch?: boolean; zoom?: { min: number; max: number; step: number } };

/**
 * Kamera HP layar penuh untuk lensa fundus (adaptor lensa 20D atau lensa klip).
 * Lampu senter HP dipakai sebagai sumber cahaya lensa bila perangkat mendukung.
 * Foto dipotong persegi di tengah, sesuai lingkaran panduan.
 */
export function PhoneCamera({
  eye,
  onClose,
  onConfirm,
}: {
  eye: Eye;
  onClose: () => void;
  onConfirm: (blob: Blob, source: "hp" | "galeri") => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState(false);
  const [caps, setCaps] = useState<TorchCaps | null>(null);
  const [zoom, setZoom] = useState(1);
  const [shot, setShot] = useState<{ blob: Blob; url: string; source: "hp" | "galeri" } | null>(null);

  useEffect(() => {
    let active: MediaStream | null = null;
    let cancelled = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(
        window.isSecureContext
          ? "Browser ini tidak mendukung kamera langsung. Gunakan tombol Kamera bawaan di bawah."
          : "Kamera langsung butuh koneksi aman (https). Gunakan tombol Kamera bawaan di bawah.",
      );
      return;
    }
    navigator.mediaDevices
      .getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        active = s;
        setStream(s);
        const track = s.getVideoTracks()[0];
        const c = (track.getCapabilities?.() ?? {}) as TorchCaps;
        setCaps(c);
        if (c.zoom) setZoom(c.zoom.min);
      })
      .catch((e: DOMException) =>
        setError(
          e.name === "NotAllowedError"
            ? "Izin kamera ditolak. Izinkan kamera untuk situs ini di pengaturan browser, atau gunakan Kamera bawaan."
            : "Kamera tidak bisa dibuka. Tutup aplikasi lain yang memakai kamera, atau gunakan Kamera bawaan.",
        ),
      );
    return () => {
      cancelled = true;
      active?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream, shot]);

  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url);
  }, [shot]);

  const track = () => stream?.getVideoTracks()[0];

  async function toggleTorch() {
    const next = !torch;
    try {
      await track()?.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorch(next);
    } catch {
      setCaps((c) => (c ? { ...c, torch: false } : c));
    }
  }

  async function changeZoom(v: number) {
    setZoom(v);
    await track()?.applyConstraints({ advanced: [{ zoom: v } as MediaTrackConstraintSet] }).catch(() => {});
  }

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const side = Math.min(v.videoWidth, v.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = side;
    canvas.getContext("2d")!.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, side, side);
    canvas.toBlob((b) => b && setShot({ blob: b, url: URL.createObjectURL(b), source: "hp" }), "image/jpeg", 0.92);
  }

  function fromFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) setShot({ blob: f, url: URL.createObjectURL(f), source: "galeri" });
  }

  const eyeLabel = eye === "kanan" ? "Mata kanan" : "Mata kiri";

  return (
    <div className="camera" role="dialog" aria-modal="true" aria-label={`Kamera ${eyeLabel}`}>
      <div className="camera__top">
        <button className="btn btn--icon" aria-label="Tutup kamera" onClick={onClose}>
          <X size={24} />
        </button>
        <span className="t-label">{eyeLabel}</span>
        {caps?.torch && !shot ? (
          <button className="btn btn--icon" aria-label="Lampu" aria-pressed={torch} onClick={toggleTorch}>
            <Flashlight size={22} weight={torch ? "fill" : "regular"} />
          </button>
        ) : (
          <span style={{ width: 44 }} />
        )}
      </div>

      <div className="camera__stage">
        {shot ? (
          <img src={shot.url} alt={`Hasil foto ${eyeLabel}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }} />
        ) : error ? (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 32, textAlign: "center", color: "#c5c7cb" }}>
            <p style={{ maxWidth: "34ch" }}>{error}</p>
          </div>
        ) : (
          <>
            <video ref={video} autoPlay playsInline muted />
            <div className="camera__guide" />
            <p className="camera__hint">
              Tempelkan lensa ke mata pasien. Geser pelan sampai pembuluh darah dan bintik terang (diskus optikus) terlihat jelas di dalam lingkaran.
            </p>
          </>
        )}
      </div>

      {!shot && caps?.zoom && caps.zoom.max > caps.zoom.min && (
        <label className="camera__zoom">
          <span>Zoom</span>
          <input type="range" min={caps.zoom.min} max={caps.zoom.max} step={caps.zoom.step || 0.1} value={zoom} onChange={(e) => changeZoom(Number(e.target.value))} />
          <span className="num">{zoom.toFixed(1)}x</span>
        </label>
      )}

      <div className="camera__bottom">
        {shot ? (
          <>
            <div className="camera__tools">
              <button className="btn btn--secondary" onClick={() => setShot(null)}>
                <ArrowCounterClockwise size={20} />
                Ulangi
              </button>
            </div>
            <span />
            <div className="camera__tools camera__tools--end">
              <button className="btn btn--primary" style={{ background: "#fff", color: "#0e0e0f" }} onClick={() => onConfirm(shot.blob, shot.source)}>
                <Check size={20} weight="bold" />
                Pakai foto
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="camera__tools">
              <button className="btn btn--icon" aria-label="Pilih dari galeri" onClick={() => fileInput.current?.click()}>
                <ImageIcon size={26} />
              </button>
            </div>
            {error ? (
              <label className="btn btn--primary" style={{ background: "#fff", color: "#0e0e0f" }}>
                Kamera bawaan
                <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={fromFile} />
              </label>
            ) : (
              <button className="shutter" aria-label="Ambil foto" disabled={!stream} onClick={capture} />
            )}
            <span />
          </>
        )}
      </div>
      <input ref={fileInput} type="file" accept="image/*" className="sr-only" onChange={fromFile} />
    </div>
  );
}
