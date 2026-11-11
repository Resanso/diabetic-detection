import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Banner, Field, Logo } from "../components/ui";

export default function Login() {
  const { needsSetup, refresh } = useAuth();
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (needsSetup) {
        await post("/api/auth/setup", { username, full_name: fullName, password });
      } else {
        await post("/api/auth/login", { username, password });
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth__brand">
        <Logo />
      </div>
      <h1 className="t-display" style={{ marginBottom: 8 }}>
        {needsSetup ? "Buat akun admin" : "Masuk"}
      </h1>
      <p className="muted" style={{ marginBottom: 32 }}>
        {needsSetup
          ? "Belum ada akun di server ini. Akun pertama menjadi admin yang membuat akun perawat dan dokter."
          : "Petugas masuk dengan username. Pasien masuk dengan NIK."}
      </p>

      <form className="stack" onSubmit={submit} noValidate>
        {error && <Banner tone="danger">{error}</Banner>}
        {needsSetup && (
          <Field label="Nama lengkap">
            {(p) => (
              <input {...p} className="input" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
            )}
          </Field>
        )}
        <Field label={needsSetup ? "Username" : "Username atau NIK"}>
          {(p) => (
            <input
              {...p}
              className="input"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          )}
        </Field>
        <Field label="Kata sandi" hint={needsSetup ? "Minimal 8 karakter." : undefined}>
          {(p) => (
            <div className="input-wrap">
              <input
                {...p}
                className="input"
                type={show ? "text" : "password"}
                autoComplete={needsSetup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                enterKeyHint="go"
                required
              />
              <button
                type="button"
                className="btn btn--icon"
                style={{ position: "absolute", right: 2, top: 2 }}
                aria-label={show ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"}
                onClick={() => setShow((s) => !s)}
              >
                {show ? <EyeSlash size={20} /> : <Eye size={20} />}
              </button>
            </div>
          )}
        </Field>
        <button className="btn btn--primary btn--lg btn--block" disabled={busy || !username || !password}>
          {busy ? "Memproses..." : needsSetup ? "Buat akun" : "Masuk"}
        </button>
      </form>

      {!needsSetup && (
        <Link to="/daftar" className="btn btn--secondary btn--lg btn--block" style={{ marginTop: 12 }}>
          Daftar akun pasien
        </Link>
      )}

      <p className="auth__foot t-caption">
        Lupa kata sandi? Minta admin klinik mengatur ulang dari menu Pengguna.
      </p>
    </main>
  );
}
