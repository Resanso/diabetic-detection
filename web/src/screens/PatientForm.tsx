import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { get, post, put, type Patient } from "../lib/api";
import { useAuth } from "../lib/auth";
import { localId, savePatient, searchOffline } from "../lib/offline/store";
import { isNetworkError, refreshCounts } from "../lib/offline/sync";
import { ActionBar, Banner, Field, Segmented, TopBar, YesNo, useToast } from "../components/ui";
import { useStartScreening } from "./NewScreening";
import { PayerFields, payerBody, payerErrors, payerFrom, type PayerValue } from "../components/PayerFields";

type Form = {
  full_name: string;
  nik: string;
  sex: "L" | "P" | null;
  birth_date: string;
  phone: string;
  address: string;
  diabetes_type: Patient["diabetes_type"];
  diabetes_since: string;
  on_insulin: boolean | null;
  hypertension: boolean | null;
  notes: string;
};

const EMPTY: Form = {
  full_name: "",
  nik: "",
  sex: null,
  birth_date: "",
  phone: "",
  address: "",
  diabetes_type: null,
  diabetes_since: "",
  on_insulin: null,
  hypertension: null,
  notes: "",
};

function validate(f: Form): Partial<Record<keyof Form, string>> {
  const e: Partial<Record<keyof Form, string>> = {};
  if (f.full_name.trim().length < 2) e.full_name = "Isi nama lengkap pasien.";
  if (f.nik && !/^\d{16}$/.test(f.nik)) e.nik = "NIK terdiri dari 16 angka.";
  if (!f.sex) e.sex = "Pilih jenis kelamin.";
  if (!f.birth_date) e.birth_date = "Isi tanggal lahir. Jika tidak tahu pasti, isi perkiraan tahun lahir dengan tanggal 1 Januari.";
  const year = Number(f.diabetes_since);
  if (f.diabetes_since && (!Number.isInteger(year) || year < 1940 || year > new Date().getFullYear()))
    e.diabetes_since = "Isi tahun 4 angka, misalnya 2018.";
  return e;
}

export default function PatientForm() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const thenScreen = params.get("lanjut") === "periksa";
  const navigate = useNavigate();
  const toast = useToast();
  const { start } = useStartScreening();
  const { user } = useAuth();
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const [payer, setPayer] = useState<PayerValue>(payerFrom(null));
  const [payerErr, setPayerErr] = useState<Partial<Record<keyof PayerValue, string>>>({});
  const [consent, setConsent] = useState(false);
  const [consentErr, setConsentErr] = useState(false);

  useEffect(() => {
    if (!id) return;
    get<Patient>(`/api/patients/${id}`).then((p) => {
      setPayer(payerFrom(p));
      setF({
        full_name: p.full_name,
        nik: p.nik ?? "",
        sex: p.sex,
        birth_date: p.birth_date ?? "",
        phone: p.phone ?? "",
        address: p.address ?? "",
        diabetes_type: p.diabetes_type,
        diabetes_since: p.diabetes_since ? String(p.diabetes_since) : "",
        on_insulin: p.on_insulin,
        hypertension: p.hypertension,
        notes: p.notes ?? "",
      });
    });
  }, [id]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const v = validate(f);
    const pe = payerErrors(payer, false);
    setErrors(v);
    setPayerErr(pe);
    setConsentErr(!id && !consent);
    if (!id && !consent && !Object.keys(v).length) return;
    if (Object.keys(pe).length && !Object.keys(v).length) return;
    if (Object.keys(v).length) {
      document.getElementById(`f-${Object.keys(v)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setServerError(null);
    const body = { ...f, ...payerBody(payer), diabetes_since: f.diabetes_since ? Number(f.diabetes_since) : null, nik: f.nik || null, ...(consent ? { consent: true } : {}) };
    try {
      const saved = id ? await put<Patient>(`/api/patients/${id}`, body) : await post<Patient>("/api/patients", body);
      toast(id ? "Data pasien disimpan" : `Pasien terdaftar dengan nomor ${saved.mrn}`);
      if (thenScreen) await start(saved);
      else navigate(`/pasien/${saved.id}`, { replace: true });
    } catch (err) {
      if (!id && isNetworkError(err)) return await saveOffline(body);
      setServerError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** Tanpa sinyal: pasien disimpan di HP dan didaftarkan ke server saat ada sinyal (NIK yang sama tidak dobel). */
  async function saveOffline(body: Omit<Patient, "id" | "mrn" | "created_at" | "created_by" | "bpjs_status" | "bpjs_class" | "bpjs_checked_at">) {
    if (body.nik && (await searchOffline(body.nik, user!.id)).some((p) => p.nik === body.nik))
      return setServerError("Pasien dengan NIK ini sudah ada di HP. Cari namanya di daftar pasien.");
    const p = {
      ...body,
      id: localId(),
      mrn: "Belum terkirim",
      bpjs_status: null,
      bpjs_class: null,
      bpjs_checked_at: null,
      created_by: user!.id,
      created_at: Date.now() / 1000,
      user_id: user!.id,
    };
    await savePatient(p);
    refreshCounts();
    toast("Tidak ada sinyal. Pasien disimpan di HP dan didaftarkan saat ada sinyal");
    if (thenScreen) await start(p);
    else navigate("/pasien", { replace: true });
  }

  return (
    <>
      <TopBar title={id ? "Ubah data pasien" : "Pasien baru"} back={true} />
      <main className="page page--flow">
        <form className="stack-lg" onSubmit={submit} noValidate>
          {serverError && <Banner tone="danger">{serverError}</Banner>}

          <section className="formgroup">
            <h2 className="formgroup__title">Identitas</h2>
            <Field label="Nama lengkap" error={errors.full_name} id="f-full_name">
              {(p) => <input {...p} className="input" autoComplete="off" autoCapitalize="words" value={f.full_name} onChange={(e) => set("full_name", e.target.value)} />}
            </Field>
            <Field label="NIK" optional error={errors.nik} hint="16 angka di KTP atau KK. Membantu mencegah pasien terdaftar dua kali." id="f-nik">
              {(p) => (
                <input {...p} className="input num" inputMode="numeric" maxLength={16} autoComplete="off" value={f.nik} onChange={(e) => set("nik", e.target.value.replace(/\D/g, ""))} />
              )}
            </Field>
            <Field label="Jenis kelamin" error={errors.sex} id="f-sex">
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
            <Field label="Tanggal lahir" error={errors.birth_date} id="f-birth_date">
              {(p) => <input {...p} className="input" type="date" max={new Date().toISOString().slice(0, 10)} value={f.birth_date} onChange={(e) => set("birth_date", e.target.value)} />}
            </Field>
            <Field label="No. HP" optional hint="Untuk mengabari hasil dan jadwal rujukan.">
              {(p) => <input {...p} className="input num" type="tel" inputMode="tel" autoComplete="off" value={f.phone} onChange={(e) => set("phone", e.target.value)} />}
            </Field>
            <Field label="Alamat" optional hint="Desa/kelurahan dan RT/RW cukup.">
              {(p) => <input {...p} className="input" autoComplete="off" value={f.address} onChange={(e) => set("address", e.target.value)} />}
            </Field>
            <PayerFields value={payer} onChange={setPayer} errors={payerErr} optional />
          </section>

          <section className="formgroup">
            <h2 className="formgroup__title">Riwayat diabetes</h2>
            <Field label="Jenis diabetes" optional>
              {() => (
                <Segmented
                  label="Jenis diabetes"
                  value={f.diabetes_type}
                  onChange={(v) => set("diabetes_type", f.diabetes_type === v ? null : v)}
                  options={[
                    { value: "tipe2", label: "Tipe 2" },
                    { value: "tipe1", label: "Tipe 1" },
                    { value: "tidak_tahu", label: "Tidak tahu" },
                    { value: "tidak", label: "Tidak diabetes" },
                  ]}
                />
              )}
            </Field>
            <Field label="Terdiagnosis sejak tahun" optional error={errors.diabetes_since} id="f-diabetes_since">
              {(p) => (
                <input {...p} className="input num" inputMode="numeric" maxLength={4} placeholder="mis. 2018" value={f.diabetes_since} onChange={(e) => set("diabetes_since", e.target.value.replace(/\D/g, ""))} />
              )}
            </Field>
            <YesNo label="Memakai insulin" value={f.on_insulin} onChange={(v) => set("on_insulin", v)} />
            <YesNo label="Hipertensi" value={f.hypertension} onChange={(v) => set("hypertension", v)} />
            <Field label="Catatan" optional hint="Riwayat operasi mata, kacamata, alergi tetes mata, dll.">
              {(p) => <textarea {...p} className="input" value={f.notes} onChange={(e) => set("notes", e.target.value)} />}
            </Field>
          </section>

          {!id && (
            <section className="formgroup">
              <h2 className="formgroup__title">Persetujuan pasien</h2>
              <label className="consent">
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>
                  Pasien sudah dijelaskan dan setuju data pribadi serta foto retinanya diproses untuk skrining, dibaca
                  dokter dengan bantuan AI, dan dikirim ke SATUSEHAT Kemenkes.
                </span>
              </label>
              {consentErr && <p className="field__error t-caption" role="alert">Centang persetujuan pasien sebelum menyimpan.</p>}
            </section>
          )}
        </form>
      </main>
      <ActionBar>
        <button className="btn btn--primary btn--lg" disabled={busy} onClick={() => submit()}>
          {busy ? "Menyimpan..." : thenScreen ? "Simpan dan lanjut" : "Simpan"}
        </button>
      </ActionBar>
    </>
  );
}
