import { useEffect, useState } from "react";
import { ShieldCheck } from "@phosphor-icons/react";
import { get, post, put, type MyProfile } from "../lib/api";
import { fmtWhen } from "../lib/format";
import { Banner, Field, SkeletonRows, useToast } from "./ui";
import { PayerFields, payerBody, payerErrors, payerFrom, type PayerValue } from "./PayerFields";

/** Data diri dan cara bayar untuk akun pasien, termasuk cek status BPJS bila klinik sudah terhubung. */
export function PatientProfile() {
  const toast = useToast();
  const [p, setP] = useState<MyProfile | null>(null);
  const [payer, setPayer] = useState<PayerValue>(payerFrom(null));
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<Partial<Record<keyof PayerValue, string>>>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load(d: MyProfile) {
    setP(d);
    setPayer(payerFrom(d));
    setPhone(d.phone ?? "");
  }
  useEffect(() => {
    get<MyProfile>("/api/me/profile").then(load, (e) => setError(e.message));
  }, []);

  const dirty = p && (JSON.stringify(payerBody(payer)) !== JSON.stringify(payerBody(payerFrom(p))) || phone !== (p.phone ?? ""));

  async function save() {
    const e = payerErrors(payer, true);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      load(await put<MyProfile>("/api/me/profile", { ...payerBody(payer), phone: phone.trim() || null }));
      toast("Data disimpan");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function checkBpjs() {
    setChecking(true);
    setError(null);
    try {
      const r = await post<{ active: boolean; status_text: string | null }>("/api/me/bpjs-check");
      toast(r.active ? "Kartu BPJS aktif" : `Kartu BPJS tidak aktif${r.status_text ? `: ${r.status_text}` : ""}`);
      load(await get<MyProfile>("/api/me/profile"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  }

  if (!p) return error ? <Banner tone="danger">{error}</Banner> : <SkeletonRows rows={2} />;
  const savedBpjs = p.payer === "bpjs" && payer.payer === "bpjs" && payer.bpjs_no === (p.bpjs_no ?? "");

  return (
    <section className="formgroup">
      <h2 className="formgroup__title">Data pasien</h2>
      {error && <Banner tone="danger">{error}</Banner>}
      <dl className="kv">
        <dt>No. rekam medis</dt>
        <dd className="mono">{p.mrn}</dd>
        <dt>NIK</dt>
        <dd className="num">{p.nik}</dd>
      </dl>
      <Field label="Nomor HP">
        {(fp) => <input {...fp} className="input num" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
      </Field>
      <PayerFields value={payer} onChange={setPayer} errors={errors} />
      {savedBpjs && (
        <div className="bpjs-status">
          <ShieldCheck size={20} weight={p.bpjs_status === "aktif" ? "fill" : "regular"} aria-hidden />
          <span style={{ flex: 1 }}>
            {p.bpjs_status === "aktif"
              ? `Aktif${p.bpjs_class ? `, ${p.bpjs_class}` : ""}. Dicek ${fmtWhen(p.bpjs_checked_at)}.`
              : p.bpjs_status === "tidak_aktif"
                ? "Tidak aktif saat terakhir dicek. Hubungi BPJS atau pilih cara bayar lain."
                : p.bpjs_enabled
                  ? "Status kartu belum dicek."
                  : "Status kartu dicek petugas saat Anda datang ke klinik."}
          </span>
          {p.bpjs_enabled && (
            <button className="btn btn--secondary" disabled={checking} onClick={checkBpjs}>
              {checking ? "Mengecek..." : "Cek status"}
            </button>
          )}
        </div>
      )}
      <button className="btn btn--secondary btn--block" disabled={busy || !dirty} onClick={save}>
        {busy ? "Menyimpan..." : "Simpan data"}
      </button>
    </section>
  );
}
