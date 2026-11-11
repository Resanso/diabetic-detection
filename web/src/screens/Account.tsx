import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Cpu, Desktop, DownloadSimple, Flask, Moon, Receipt, SignOut, Sun, Trash } from "@phosphor-icons/react";
import { del, get, post, type SatusehatStatus } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ROLE_LABELS, initials } from "../lib/format";
import { Banner, ConfirmDelete, Field, Segmented, TopBar, useAsync, useToast } from "../components/ui";
import { getThemePref, setThemePref, type ThemePref } from "../lib/theme";
import { PatientProfile } from "../components/PatientProfile";
import { modelState, onModelState, prepareOffline, type ModelState } from "../lib/offline/ai";
import { useSync } from "../lib/offline/sync";

const MODEL_TEXT: Record<ModelState, string> = {
  siap: "AI siap dipakai tanpa sinyal.",
  mengunduh: "Mengunduh model AI (sekitar 16 MB)...",
  belum: "Model AI belum diunduh. Buka aplikasi saat ada sinyal.",
  gagal: "Model AI gagal diunduh. Coba lagi saat sinyal bagus.",
};

/** Kesiapan bekerja tanpa sinyal: model AI di HP dan data yang belum terkirim. */
function OfflineStatus() {
  const [model, setModel] = useState(modelState);
  useEffect(() => onModelState(() => setModel(modelState())), []);
  const sync = useSync();
  return (
    <section className="formgroup">
      <h2 className="formgroup__title">Mode offline</h2>
      <p className="muted">
        Tanpa sinyal Anda tetap bisa mendaftarkan pasien, mengisi data klinis, memotret retina, dan melihat hasil AI. Semua
        tersimpan di HP dan dikirim otomatis saat ada sinyal. Jadwal, booking, dan antrean tetap butuh sinyal.
      </p>
      <Banner tone={model === "siap" ? "ok" : model === "gagal" ? "danger" : "neutral"}>{MODEL_TEXT[model]}</Banner>
      <p className="t-caption muted">
        {sync.pending || sync.drafts
          ? `${sync.pending} data menunggu dikirim, ${sync.drafts} draf offline.`
          : "Tidak ada data yang menunggu dikirim."}
      </p>
      {(model === "gagal" || model === "belum") && sync.online && (
        <button className="btn btn--secondary btn--block" onClick={() => prepareOffline()}>
          <DownloadSimple size={20} />
          Unduh model AI sekarang
        </button>
      )}
    </section>
  );
}

/** Admin: status sambungan SATUSEHAT. Kredensial diatur di server/.env, bukan dari layar ini. */
function SatusehatSettings() {
  const st = useAsync(() => get<SatusehatStatus>("/api/satusehat/status"), []);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      const r = await post<{ organization: string | null; org_id: string }>("/api/satusehat/test");
      setResult({ ok: true, text: `Terhubung. Organisasi: ${r.organization ?? r.org_id}.` });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const d = st.data;
  return (
    <section className="formgroup">
      <h2 className="formgroup__title">SATUSEHAT</h2>
      {st.error && <Banner tone="danger">{st.error}</Banner>}
      {d && !d.configured && (
        <p className="muted">
          Belum diatur. Isi <span className="mono">SATUSEHAT_ORG_ID</span>, <span className="mono">SATUSEHAT_CLIENT_ID</span>, dan{" "}
          <span className="mono">SATUSEHAT_CLIENT_SECRET</span> dari menu Kode Akses API di SATUSEHAT Platform ke berkas{" "}
          <span className="mono">server/.env</span>, lalu jalankan ulang server.
        </p>
      )}
      {d?.configured && (
        <>
          <dl className="kv">
            <dt>Lingkungan</dt>
            <dd>{d.env === "sandbox" ? "Sandbox (uji coba)" : "Production"}</dd>
            <dt>Organization ID</dt>
            <dd className="mono">{d.org_id}</dd>
            <dt>Kirim otomatis</dt>
            <dd>{d.auto ? "Ya, setelah dokter menyimpan bacaan" : "Tidak, dokter menekan tombol kirim"}</dd>
          </dl>
          <p className="muted">Pasien dicari dari NIK. Dokter pembaca perlu NIK di menu Pengguna.</p>
          {result && <Banner tone={result.ok ? "ok" : "danger"}>{result.text}</Banner>}
          <button className="btn btn--secondary btn--block" disabled={busy} onClick={test}>
            {busy ? "Menghubungi SATUSEHAT..." : "Uji sambungan"}
          </button>
        </>
      )}
    </section>
  );
}

export default function Account() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const [wipe, setWipe] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const { pending, drafts } = useSync();

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
          <Link className="row card" to="/tarif" style={{ minHeight: 64 }}>
            <Receipt size={22} />
            <span className="row__body">
              <span className="row__title" style={{ display: "block" }}>
                Tarif layanan
              </span>
              <span className="row__meta" style={{ display: "block" }}>
                Biaya skrining, gratis atau berbayar
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

        {user.role === "admin" && <SatusehatSettings />}

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

        {user.role !== "pasien" && <OfflineStatus />}

        <button className="btn btn--danger btn--lg btn--block" onClick={() => (pending || drafts ? setConfirmLogout(true) : logout())}>
          <SignOut size={20} />
          Keluar
        </button>
      </main>
      {confirmLogout && (
        <ConfirmDelete title="Masih ada data di HP" label="Tetap keluar" onClose={() => setConfirmLogout(false)} onConfirm={logout}>
          <p>
            {pending + drafts} pemeriksaan atau pasien belum terkirim ke server. Datanya tetap tersimpan di HP ini dan baru dikirim
            setelah akun Anda masuk lagi di HP ini.
          </p>
        </ConfirmDelete>
      )}
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
