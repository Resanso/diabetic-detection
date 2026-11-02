import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Cpu, Desktop, Flask, Moon, SignOut, Sun, Trash } from "@phosphor-icons/react";
import { del, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ROLE_LABELS, initials } from "../lib/format";
import { Banner, ConfirmDelete, Field, Segmented, TopBar, useToast } from "../components/ui";
import { getThemePref, setThemePref, type ThemePref } from "../lib/theme";
import { PatientProfile } from "../components/PatientProfile";

export default function Account() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [wipe, setWipe] = useState(false);

  async function change(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/password", { current, new: next });
      setCurrent("");
      setNext("");
      toast("Kata sandi diganti");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;
  return (
    <>
      <TopBar title="Akun" />
      <main className="page stack-lg">
        <section className="card" style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span className="avatar" style={{ width: 56, height: 56, fontSize: 18 }}>
            {initials(user.full_name)}
          </span>
          <div>
            <p className="t-heading">{user.full_name}</p>
            <p className="muted">
              {ROLE_LABELS[user.role]}, <span className="mono">{user.username}</span>
            </p>
          </div>
        </section>

        {user.role === "pasien" && <PatientProfile />}

        <section className="formgroup">
          <h2 className="formgroup__title">Tampilan</h2>
          <Field label="Tema" hint="Terang paling mudah dibaca di luar ruangan. Gelap nyaman untuk membaca foto di ruangan redup.">
            {() => (
              <Segmented
                label="Tema"
                value={theme}
                onChange={(v) => {
                  setTheme(v);
                  setThemePref(v);
                }}
                options={[
                  { value: "terang", label: <><Sun size={18} /> Terang</> },
                  { value: "gelap", label: <><Moon size={18} /> Gelap</> },
                  { value: "sistem", label: <><Desktop size={18} /> Sistem</> },
                ]}
              />
            )}
          </Field>
        </section>

        {user.role === "admin" && (
          <Link className="row card" to="/perangkat" style={{ minHeight: 64 }}>
            <Cpu size={22} />
            <span className="row__body">
              <span className="row__title" style={{ display: "block" }}>
                Perangkat kamera
              </span>
              <span className="row__meta" style={{ display: "block" }}>
                ESP32-CAM yang terhubung dan pengaturannya
              </span>
            </span>
          </Link>
        )}
        {user.role === "admin" && (
          <a className="row card" href="/lab" style={{ minHeight: 64 }}>
            <Flask size={22} />
            <span className="row__body">
              <span className="row__title" style={{ display: "block" }}>
                Lab model
              </span>
              <span className="row__meta" style={{ display: "block" }}>
                Uji akurasi, benchmark, dan ambang rujukan
              </span>
            </span>
          </a>
        )}

        <form className="formgroup" onSubmit={change} noValidate>
          <h2 className="formgroup__title">Ganti kata sandi</h2>
          {error && <Banner tone="danger">{error}</Banner>}
          <Field label="Kata sandi saat ini">
            {(p) => <input {...p} className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
          </Field>
          <Field label="Kata sandi baru" hint="Minimal 8 karakter.">
            {(p) => <input {...p} className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
          </Field>
          <button className="btn btn--secondary btn--block" disabled={busy || !current || next.length < 8}>
            {busy ? "Menyimpan..." : "Simpan kata sandi"}
          </button>
        </form>

        {user.role === "admin" && (
          <section className="formgroup">
            <h2 className="formgroup__title">Bersihkan data</h2>
            <p className="muted">
              Hapus semua pasien, pemeriksaan, dan foto retina, misalnya data uji coba sebelum dipakai di lapangan. Akun pengguna dan pengaturan perangkat tetap ada.
            </p>
            <button className="btn btn--danger btn--block" onClick={() => setWipe(true)}>
              <Trash size={20} />
              Hapus semua data pasien
            </button>
          </section>
        )}

        <button className="btn btn--danger btn--lg btn--block" onClick={logout}>
          <SignOut size={20} />
          Keluar
        </button>
      </main>
      {wipe && (
        <ConfirmDelete
          title="Hapus semua data pasien?"
          label="Hapus semua"
          typeToConfirm="HAPUS"
          onClose={() => setWipe(false)}
          onConfirm={async () => {
            const r = await del<{ patients: number; screenings: number; images: number }>("/api/data?confirm=HAPUS");
            toast(`${r.patients} pasien, ${r.screenings} pemeriksaan, dan ${r.images} foto dihapus`);
            setWipe(false);
          }}
        >
          <p>Semua pasien, pemeriksaan, foto retina, perkiraan AI, dan bacaan dokter dihapus permanen dari server. Tindakan ini tidak bisa dibatalkan.</p>
        </ConfirmDelete>
      )}
    </>
  );
}
