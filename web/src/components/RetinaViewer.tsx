import { useEffect, useRef, useState } from "react";
import { ArrowsIn } from "@phosphor-icons/react";
import type { RetinaImage } from "../lib/api";
import { Segmented } from "./ui";

type Mode = "asli" | "kontras" | "atensi";

/**
 * Penampil foto fundus: cubit/roda untuk memperbesar, geser saat diperbesar, ketuk dua kali untuk 2x.
 * Transformasi ditulis langsung ke style agar tidak me-render ulang React di setiap gerakan jari.
 */
export function RetinaViewer({ image, label, modes = true }: { image: RetinaImage; label?: string; modes?: boolean }) {
  const [mode, setMode] = useState<Mode>("asli");
  const [missing, setMissing] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const t = useRef({ s: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; s: number; cx: number; cy: number; x: number; y: number } | null>(null);
  const lastTap = useRef(0);

  const src = mode === "asli" ? image.image_url : mode === "kontras" ? image.preprocessed_url : image.heatmap_url;

  function apply() {
    const el = img.current;
    const st = stage.current;
    if (!el || !st) return;
    const { width: w, height: h } = st.getBoundingClientRect();
    const s = Math.min(6, Math.max(1, t.current.s));
    // Batasi geser agar gambar tidak keluar dari bingkai
    t.current.s = s;
    t.current.x = Math.min(0, Math.max(w - w * s, t.current.x));
    t.current.y = Math.min(0, Math.max(h - h * s, t.current.y));
    el.style.transform = `translate(${t.current.x}px, ${t.current.y}px) scale(${s})`;
    setZoomed(s > 1.01);
  }

  function zoomAt(cx: number, cy: number, next: number) {
    const { s, x, y } = t.current;
    const k = next / s;
    t.current = { s: next, x: cx - (cx - x) * k, y: cy - (cy - y) * k };
    apply();
  }

  function reset() {
    t.current = { s: 1, x: 0, y: 0 };
    apply();
  }

  useEffect(() => {
    reset();
    setMissing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, t.current.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const local = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function onDown(e: React.PointerEvent) {
    stage.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        d: Math.hypot(a.x - b.x, a.y - b.y),
        s: t.current.s,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
        x: t.current.x,
        y: t.current.y,
      };
    } else if (pointers.current.size === 1) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        const p = local(e);
        t.current.s > 1.01 ? reset() : zoomAt(p.x, p.y, 2.5);
        lastTap.current = 0;
      } else lastTap.current = now;
    }
  }

  function onMove(e: React.PointerEvent) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const pc = pinch.current;
      const next = Math.min(6, Math.max(1, (pc.s * d) / pc.d));
      const k = next / pc.s;
      t.current = { s: next, x: pc.cx - (pc.cx - pc.x) * k, y: pc.cy - (pc.cy - pc.y) * k };
      apply();
    } else if (pointers.current.size === 1 && t.current.s > 1) {
      t.current.x += p.x - prev.x;
      t.current.y += p.y - prev.y;
      apply();
    }
  }

  function onUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }

  return (
    <div className="viewer">
      <div
        className="viewer__stage"
        ref={stage}
        data-zoomed={zoomed}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        aria-label={`Foto retina${label ? ` ${label}` : ""}. Cubit atau ketuk dua kali untuk memperbesar.`}
        role="img"
      >
        {missing ? (
          <p className="viewer__missing">Versi gambar ini tidak tersedia untuk foto lama.</p>
        ) : (
          <img ref={img} src={src} alt="" draggable={false} onError={() => setMissing(true)} />
        )}
        {label && <span className="viewer__label">{label}</span>}
      </div>
      <div className="viewer__bar">
        {modes ? (
          <Segmented
            label="Tampilan foto"
            value={mode}
            onChange={setMode}
            options={[
              { value: "asli", label: "Asli" },
              { value: "kontras", label: "Kontras" },
              { value: "atensi", label: "Peta lesi" },
            ]}
          />
        ) : (
          <span style={{ flex: 1 }} />
        )}
        <button className="btn btn--icon" style={{ color: "#eff0f2" }} aria-label="Kembalikan ukuran" disabled={!zoomed} onClick={reset}>
          <ArrowsIn size={20} />
        </button>
      </div>
    </div>
  );
}
