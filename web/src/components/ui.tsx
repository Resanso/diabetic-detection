import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { ArrowLeft, CheckCircle, Info, Warning, WarningCircle, type Icon } from "@phosphor-icons/react";
import type { Decision, ScreeningStatus } from "../lib/api";
import { DECISIONS, GRADE_LABELS, STATUS_LABELS } from "../lib/format";

/* ---------- Logo ---------- */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="15" cy="12" r="3" fill="var(--accent)" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <Mark size={28} />
      <span className="logo__word">retinova</span>
    </span>
  );
}

/* ---------- Bilah atas & navigasi ---------- */
export function TopBar({
  title,
  sub,
  back,
  action,
}: {
  title: ReactNode;
  sub?: ReactNode;
  back?: string | true;
  action?: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <header className="topbar">
      <div className={`topbar__inner ${back ? "topbar__inner--back" : ""}`}>
        {back && (
          <button
            className="btn btn--icon"
            aria-label="Kembali"
            onClick={() => (back === true ? navigate(-1) : navigate(back))}
          >
            <ArrowLeft size={22} />
          </button>
        )}
        <h1 className="topbar__title">
          {title}
          {sub && <span className="topbar__sub">{sub}</span>}
        </h1>
        {action}
      </div>
    </header>
  );
}

export interface NavItem {
  to: string;
  label: string;
  icon: Icon;
  badge?: number;
  end?: boolean;
}

export function BottomNav({ items }: { items: NavItem[] }) {
  return (
    <nav className="bottomnav" aria-label="Navigasi utama">
      <div className="bottomnav__inner">
        {items.map(({ to, label, icon: I, badge, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? "active" : "")}>
            {({ isActive }) => (
              <>
                <I size={24} weight={isActive ? "fill" : "regular"} />
                <span>{label}</span>
                {!!badge && <span className="bottomnav__badge">{badge > 99 ? "99+" : badge}</span>}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

export function ActionBar({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className={`actionbar ${wide ? "actionbar--wide" : ""}`}>
      <div className="actionbar__inner">{children}</div>
    </div>
  );
}

/* ---------- Formulir ---------- */
export function Field({
  label,
  optional,
  hint,
  error,
  children,
  id,
}: {
  label: ReactNode;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  id?: string;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
}) {
  const auto = useId();
  const fieldId = id ?? auto;
  const hintId = `${fieldId}-hint`;
  const errId = `${fieldId}-err`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={fieldId}>
        {label} {optional && <span className="field__opt">(opsional)</span>}
      </label>
      {children({ id: fieldId, "aria-invalid": error ? true : undefined, "aria-describedby": describedBy })}
      {hint && !error && (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field__error" id={errId}>
          <WarningCircle size={16} weight="fill" />
          {error}
        </p>
      )}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T | null | undefined;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={String(o.value)}
          className="seg__opt"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function YesNo({ value, onChange, label }: { value: boolean | null; onChange: (v: boolean | null) => void; label: string }) {
  return (
    <div className="toggle-row">
      <span className="t-label">{label}</span>
      <div style={{ width: 168 }}>
        <Segmented
          label={label}
          value={value === null ? null : value ? "ya" : "tidak"}
          options={[
            { value: "ya", label: "Ya" },
            { value: "tidak", label: "Tidak" },
          ]}
          onChange={(v) => {
            const next = v === "ya";
            onChange(value === next ? null : next);
          }}
        />
      </div>
    </div>
  );
}

/* ---------- Chip ---------- */
export function StatusChip({ status, decision }: { status: ScreeningStatus; decision?: Decision | null }) {
  if (status === "dibaca" && decision) return <DecisionChip decision={decision} />;
  return <span className={`chip chip--${status === "draf" ? "draf" : status === "menunggu" ? "menunggu" : "g0"}`}>{STATUS_LABELS[status]}</span>;
}

export function DecisionChip({ decision }: { decision: Decision }) {
  const d = DECISIONS[decision];
  const cls = { segera: "chip--segera", rujuk: "chip--g3", ok: "chip--g0", ulang: "chip--g1" }[d.tone];
  return <span className={`chip ${cls}`}>{d.title}</span>;
}

export function GradeChip({ grade, prefix }: { grade: number; prefix?: string }) {
  return (
    <span className={`chip chip--g${grade}`}>
      {prefix}
      {GRADE_LABELS[grade]}
    </span>
  );
}

/* ---------- Pemberitahuan ---------- */
export function Banner({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "info" | "warn" | "danger" | "ok";
  children: ReactNode;
}) {
  const I = { neutral: Info, info: Info, warn: Warning, danger: WarningCircle, ok: CheckCircle }[tone];
  return (
    <div className={`banner banner--${tone}`} role={tone === "danger" ? "alert" : undefined}>
      <I size={20} weight="fill" />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ icon: I, children, action }: { icon: Icon; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <I size={32} />
      <p>{children}</p>
      {action}
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="list" aria-busy="true" aria-label="Memuat">
      {Array.from({ length: rows }, (_, i) => (
        <div className="row" key={i}>
          <div className="skeleton" style={{ width: 44, height: 44, borderRadius: "50%" }} />
          <div className="row__body">
            <div className="skeleton" style={{ height: 16, width: "55%", marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 12, width: "35%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- Lembar bawah ---------- */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <>
      <div className="backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="sheet__grip" />
        <h2 className="sheet__title">{title}</h2>
        {children}
      </div>
    </>
  );
}

/** Konfirmasi hapus permanen. Bila `typeToConfirm` diisi, tombol Hapus baru aktif setelah kata itu diketik. */
export function ConfirmDelete({
  title,
  children,
  onClose,
  onConfirm,
  typeToConfirm,
  label = "Hapus",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onConfirm: () => Promise<unknown>;
  typeToConfirm?: string;
  label?: string;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const ready = !typeToConfirm || typed.trim().toUpperCase() === typeToConfirm;
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack">
        {error && <Banner tone="danger">{error}</Banner>}
        <div className="muted stack-sm">{children}</div>
        {typeToConfirm && (
          <Field label={`Ketik ${typeToConfirm} untuk melanjutkan`}>
            {(p) => <input {...p} className="input" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />}
          </Field>
        )}
        <div className="grid-2">
          <button className="btn btn--secondary btn--lg" onClick={onClose}>
            Batal
          </button>
          <button className="btn btn--lg btn--danger-solid" disabled={!ready || busy} onClick={go}>
            {busy ? "Menghapus..." : label}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/* ---------- Toast ---------- */
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>();
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div aria-live="polite">
        {msg && (
          <div className="toast" role="status">
            <CheckCircle size={20} weight="fill" />
            {msg}
          </div>
        )}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- Data async ---------- */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(() => {
    const n = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => n === seq.current && (setData(d), setError(null)))
      .catch((e: Error) => n === seq.current && setError(e.message))
      .finally(() => n === seq.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { data, error, loading, reload: run, setData };
}
