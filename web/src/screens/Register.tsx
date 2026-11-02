import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Eye, EyeSlash } from "@phosphor-icons/react";
import { post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { isoDate } from "../lib/format";
import { Banner, Field, Logo, Segmented } from "../components/ui";
import { PayerFields, payerBody, payerErrors, type PayerValue } from "../components/PayerFields";

type Errors = Partial<Record<"nik" | "full_name" | "birth_date" | "sex" | "phone" | "password" | keyof PayerValue, string>>;

/** Pendaftaran akun pasien. NIK menjadi nama pengguna untuk masuk berikutnya. */
export default function Register() {
  const { refresh } = useAuth();
  const [f, setF] = useState({ nik: "", full_name: "", birth_date: "", sex: null as "L" | "P" | null, phone: "", password: "" });
  const [payer, setPayer] = useState<PayerValue>({ payer: null, bpjs_no: "", insurer: "", policy_no: "" });
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  function validate(): Errors {
    const e: Errors = { ...payerErrors(payer, true) };
    if (!/^\d{16}$/.test(f.nik)) e.nik = "NIK 16 digit angka, sesuai KTP atau KK.";
    if (f.full_name.trim().length < 2) e.full_name = "Isi nama sesuai KTP.";
    if (!f.birth_date) e.birth_date = "Isi tanggal lahir.";
    if (!f.sex) e.sex = "Pilih jenis kelamin.";
    if (f.phone.replace(/\D/g, "").length < 8) e.phone = "Isi nomor HP aktif.";
    if (f.password.length < 8) e.password = "Minimal 8 karakter.";
    return e;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      document.getElementById(`r-${Object.keys(e)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/register", { ...f, full_name: f.full_name.trim(), ...payerBody(payer) });
      await refresh();
    } catch (err) {
      setError((err as Error).message);
      window.scrollTo({ top: 0, behavior: "smooth" });
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
        Daftar sebagai pasien
      </h1>
      <p className="muted" style={{ marginBottom: 32 }}>
        Untuk booking jadwal dokter dan mengambil nomor antrean dari HP.
      </p>

      <form className="stack" onSubmit={submit} noValidate>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="NIK" id="r-nik" error={errors.nik} hint="Dipakai untuk masuk ke akun ini.">
          {(p) => <input {...p} className="input num" inputMode="numeric" autoComplete="username" maxLength={16} value={f.nik} onChange={(e) => set("nik", e.target.value.replace(/\D/g, ""))} />}
        </Field>
        <Field label="Nama lengkap" id="r-full_name" error={errors.full_name}>
          {(p) => <input {...p} className="input" autoComplete="name" value={f.full_name} onChange={(e) => set("full_name", e.target.value)} />}
        </Field>
        <div className="grid-2">
          <Field label="Tanggal lahir" id="r-birth_date" error={errors.birth_date}>
            {(p) => <input {...p} className="input" type="date" autoComplete="bday" max={isoDate(new Date())} value={f.birth_date} onChange={(e) => set("birth_date", e.target.value)} />}
          </Field>
          <Field label="Jenis kelamin" error={errors.sex}>
            {() => (
              <Segmented
                label="Jenis kelamin"
                value={f.sex}
                onChange={(v) => set("sex", v)}
                options={[
                  { value: "L", label: "Laki-laki" },
                  { value: "P", label: "Perempuan" },
                ]}
              />
            )}
          </Field>
        </div>
        <Field label="Nomor HP" id="r-phone" error={errors.phone} hint="Untuk dihubungi bila jadwal dokter berubah.">
          {(p) => <input {...p} className="input num" type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} />}
        </Field>
        <PayerFields value={payer} onChange={setPayer} errors={errors} />
        <Field label="Kata sandi" id="r-password" error={errors.password} hint="Minimal 8 karakter.">
          {(p) => (
            <div className="input-wrap">
              <input {...p} className="input" type={show ? "text" : "password"} autoComplete="new-password" value={f.password} onChange={(e) => set("password", e.target.value)} />
              <button type="button" className="btn btn--icon" style={{ position: "absolute", right: 2, top: 2 }} aria-label={show ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"} onClick={() => setShow((s) => !s)}>
                {show ? <EyeSlash size={20} /> : <Eye size={20} />}
              </button>
            </div>
          )}
        </Field>
        <button className="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy ? "Mendaftarkan..." : "Daftar"}
        </button>
      </form>

      <p className="auth__foot t-caption">
        Sudah punya akun? <Link to="/">Masuk</Link>
      </p>
    </main>
  );
}
