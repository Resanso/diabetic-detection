import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Camera, Cpu, DeviceMobileCamera, Trash, UploadSimple, WarningCircle, CheckCircle } from "@phosphor-icons/react";
import { type Eye, type RetinaImage, type ScreeningDetail } from "../lib/api";
import { draftOps } from "../lib/offline/drafts";
import { modelState } from "../lib/offline/ai";
import { useAuth } from "../lib/auth";
import { GLUCOSE_KIND, fmtPct, patientMeta } from "../lib/format";
import { ActionBar, Banner, ConfirmDelete, Field, GradeChip, Segmented, Sheet, TopBar, useToast } from "../components/ui";
import { PhoneCamera } from "../components/PhoneCamera";
import { Esp32Capture } from "../components/Esp32Capture";
import { RetinaViewer } from "../components/RetinaViewer";
import { AiPanel } from "../components/AiPanel";

type Source = "hp" | "esp32";
const SOURCE_KEY = "retinova.source";
const LOCATION_KEY = "retinova.location";
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* penyimpanan lokal tidak tersedia */
    }
  },
};

const COMPLAINTS = ["Tidak ada keluhan", "Pandangan kabur", "Melihat bintik atau bayangan", "Penglihatan turun mendadak"];
const STEPS = ["Data klinis", "Foto retina", "Periksa ulang"];

type Vitals = {
  location: string;
  glucose: string;
  glucose_kind: "puasa" | "sewaktu" | "2jpp" | null;
  hba1c: string;
  systolic: string;
  diastolic: string;
  va_right: string;
  va_left: string;
  complaints: string;
  nurse_notes: string;
};

const toNum = (s: string) => (s.trim() === "" ? null : Number(s.replace(",", ".")));
const str = (v: number | string | null | undefined) => (v == null ? "" : String(v).replace(".", ","));

function validate(v: Vitals) {
  const e: Partial<Record<keyof Vitals, string>> = {};
  const g = toNum(v.glucose);
  if (g != null && (isNaN(g) || g < 20 || g > 1000)) e.glucose = "Isi gula darah antara 20 dan 1000 mg/dL.";
  if (g != null && !v.glucose_kind) e.glucose_kind = "Pilih jenis pemeriksaan gula darah.";
  const h = toNum(v.hba1c);
  if (h != null && (isNaN(h) || h < 3 || h > 20)) e.hba1c = "HbA1c biasanya antara 3 dan 20 %.";
  const s = toNum(v.systolic);
  const d = toNum(v.diastolic);
  if ((s == null) !== (d == null)) e.systolic = "Isi sistolik dan diastolik, atau kosongkan keduanya.";
  else if (s != null && d != null && (isNaN(s) || isNaN(d) || s < 50 || s > 300 || d < 30 || d > 200 || d >= s))
    e.systolic = "Periksa lagi angka tekanan darah.";
  return e;
}

export default function ScreeningFlow() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const step = Math.min(3, Math.max(1, Number(params.get("langkah") ?? 1)));
  const goStep = (n: number) => {
    setParams({ langkah: String(n) });
    window.scrollTo({ top: 0 });
  };
  const navigate = useNavigate();
  const toast = useToast();
  // Dokter yang memotret sendiri langsung lanjut membaca; tidak ada "kirim ke dokter"
  const isDoctor = useAuth().user?.role === "dokter";
  // Draf yang dibuat tanpa sinyal tersimpan di HP dan dikirim saat ada sinyal
  const ops = useMemo(() => draftOps(id!), [id]);

  const [s, setS] = useState<ScreeningDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [v, setV] = useState<Vitals | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Vitals, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourcePref, setSource] = useState<Source>((store.get(SOURCE_KEY) as Source) || "hp");
  // ESP32-CAM dikendalikan lewat server, jadi tidak tersedia untuk draf offline
  const source: Source = ops.local ? "hp" : sourcePref;
  const [camera, setCamera] = useState<Eye | null>(null);
  const [esp, setEsp] = useState<Eye | null>(null);
  const [uploading, setUploading] = useState<Eye | null>(null);
  const [selected, setSelected] = useState<Partial<Record<Eye, string>>>({});
  const [viewing, setViewing] = useState<RetinaImage | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [dropEye, setDropEye] = useState<Eye | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileEye = useRef<Eye>("kanan");

  useEffect(() => {
    ops
      .load()
      .then((d) => {
        if (d.status !== "draf") return navigate(`/pemeriksaan/${d.id}`, { replace: true });
        setS(d);
        // Foto yang belum dinilai AI (model belum ada saat difoto) dinilai ulang di latar
        ops.retryAi?.().then((n) => n && setS((p) => (p ? { ...p, images: n.images, ai_grade: n.ai_grade, ai_p_referable: n.ai_p_referable } : p)));
        setV({
          location: d.location ?? store.get(LOCATION_KEY) ?? "",
          glucose: str(d.glucose),
          glucose_kind: d.glucose_kind,
          hba1c: str(d.hba1c),
          systolic: str(d.systolic),
          diastolic: str(d.diastolic),
          va_right: d.va_right ?? "",
          va_left: d.va_left ?? "",
          complaints: d.complaints ?? "",
          nurse_notes: d.nurse_notes ?? "",
        });
      })
      .catch((e) => setLoadError(e.message));
  }, [ops, navigate]);

  const set = <K extends keyof Vitals>(k: K, val: Vitals[K]) => setV((p) => (p ? { ...p, [k]: val } : p));

  async function saveVitals(next: number) {
    if (!v) return;
    const e = validate(v);
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    setError(null);
    try {
      if (v.location) store.set(LOCATION_KEY, v.location);
      const d = await ops.saveVitals({
        location: v.location,
        glucose: toNum(v.glucose),
        glucose_kind: v.glucose_kind,
        hba1c: toNum(v.hba1c),
        systolic: toNum(v.systolic),
        diastolic: toNum(v.diastolic),
        va_right: v.va_right,
        va_left: v.va_left,
        complaints: v.complaints,
        nurse_notes: v.nurse_notes,
      });
      setS(d);
      goStep(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function chooseSource(src: Source) {
    setSource(src);
    store.set(SOURCE_KEY, src);
  }

  function addImage(img: RetinaImage) {
    setS((p) => (p ? { ...p, images: [...p.images, img] } : p));
    if (img.eye) setSelected((p) => ({ ...p, [img.eye!]: img.id }));
    toast(img.quality.is_fundus === false ? "Foto tersimpan, tetapi tidak dikenali sebagai foto retina" : img.quality.ok ? "Foto tersimpan" : "Foto tersimpan, tetapi kualitasnya kurang");
  }

  async function send(eye: Eye, blob: Blob, src: "hp" | "galeri") {
    setUploading(eye);
    setError(null);
    try {
      addImage(await ops.addImage(eye, await shrinkImage(blob), src));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(null);
    }
  }

  function onPhone(blob: Blob, src: "hp" | "galeri") {
    const eye = camera!;
    setCamera(null);
    send(eye, blob, src);
  }

  function pickFile(eye: Eye) {
    fileEye.current = eye;
    fileInput.current?.click();
  }

  function onFile(eye: Eye, f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith("image/")) return setError("File harus berupa gambar (JPG atau PNG).");
    send(eye, f, "galeri");
  }

  async function removeImage(img: RetinaImage) {
    try {
      await ops.removeImage(img.id);
      setS((p) => (p ? { ...p, images: p.images.filter((x) => x.id !== img.id) } : p));
      setViewing(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await ops.submit(v && v.nurse_notes !== (s?.nurse_notes ?? "") ? v.nurse_notes : null);
      if (ops.local) {
        toast("Tersimpan di HP. Dikirim otomatis saat ada sinyal");
        navigate("/", { replace: true });
        return;
      }
      toast(isDoctor ? "Siap dibaca" : "Terkirim ke dokter");
      navigate(`/pemeriksaan/${id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  async function deleteDraft() {
    await ops.remove();
    toast("Draf pemeriksaan dihapus");
    navigate("/", { replace: true });
  }

  if (loadError)
    return (
      <>
        <TopBar title="Pemeriksaan" back="/" />
        <main className="page">
          <Banner tone="danger">{loadError}</Banner>
        </main>
      </>
    );
  if (!s || !v)
    return (
      <>
        <TopBar title="Pemeriksaan" back="/" />
        <main className="page stack">
          <div className="skeleton" style={{ height: 40 }} />
          <div className="skeleton" style={{ height: 320 }} />
        </main>
      </>
    );

  const byEye = (eye: Eye) => s.images.filter((i) => i.eye === eye);
  const current = (eye: Eye) => {
    const list = byEye(eye);
    return list.find((i) => i.id === selected[eye]) ?? list[list.length - 1];
  };
  const missingEyes = (["kanan", "kiri"] as Eye[]).filter((e) => !byEye(e).length);
  const poorEyes = (["kanan", "kiri"] as Eye[]).filter((e) => current(e) && !current(e)!.quality.ok);

  const openCapture = (eye: Eye) => (source === "hp" ? setCamera(eye) : setEsp(eye));

  return (
    <>
      <TopBar
        title={s.patient.full_name}
        sub={patientMeta(s.patient)}
        back={step > 1 ? true : "/"}
        action={
          <button className="btn btn--icon" aria-label="Hapus draf" onClick={() => setConfirmDelete(true)}>
            <Trash size={20} />
          </button>
        }
      />
      <main className="page page--flow stack-lg">
        <ol className="steps" aria-label="Langkah pemeriksaan" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {STEPS.map((label, i) => (
            <li key={label} className="steps__item" data-state={i + 1 < step ? "done" : i + 1 === step ? "current" : "todo"} aria-current={i + 1 === step ? "step" : undefined}>
              <span className="steps__bar" />
              {label}
            </li>
          ))}
        </ol>

        {ops.local && (
          <Banner tone="info">
            <strong>Mode offline.</strong> Pemeriksaan ini disimpan di HP dan dinilai AI di HP. Setelah dikirim, data masuk ke
            server otomatis begitu ada sinyal, lalu foto dinilai ulang oleh server untuk dokter.
          </Banner>
        )}
        {ops.local && modelState() !== "siap" && (
          <Banner tone="warn">
            Model AI belum ada di HP ini, jadi foto belum bisa dinilai AI. Foto tetap tersimpan. Buka aplikasi sekali saat ada
            sinyal (tunggu sampai Akun menampilkan "AI siap dipakai tanpa sinyal"); foto akan dinilai saat draf dibuka lagi.
          </Banner>
        )}
        {error && <Banner tone="danger">{error}</Banner>}

        {step === 1 && (
          <form className="stack-lg" onSubmit={(e) => (e.preventDefault(), saveVitals(2))} noValidate>
            <section className="formgroup">
              <h2 className="formgroup__title">Gula darah</h2>
              <Field label="Hasil" optional error={errors.glucose}>
                {(p) => (
                  <div className="input-wrap">
                    <input {...p} className="input num" inputMode="decimal" value={v.glucose} onChange={(e) => set("glucose", e.target.value)} />
                    <span className="input-wrap__unit">mg/dL</span>
                  </div>
                )}
              </Field>
              <Field label="Jenis pemeriksaan" error={errors.glucose_kind}>
                {() => (
                  <Segmented
                    label="Jenis pemeriksaan gula darah"
                    value={v.glucose_kind}
                    onChange={(k) => set("glucose_kind", k)}
                    options={[
                      { value: "sewaktu", label: "Sewaktu" },
                      { value: "puasa", label: "Puasa" },
                      { value: "2jpp", label: "2 jam PP" },
                    ]}
                  />
                )}
              </Field>
              <Field label="HbA1c" optional error={errors.hba1c} hint="Jika ada hasil lab dalam 3 bulan terakhir.">
                {(p) => (
                  <div className="input-wrap">
                    <input {...p} className="input num" inputMode="decimal" value={v.hba1c} onChange={(e) => set("hba1c", e.target.value)} />
                    <span className="input-wrap__unit">%</span>
                  </div>
                )}
              </Field>
            </section>

            <section className="formgroup">
              <h2 className="formgroup__title">Tekanan darah</h2>
              <div className="grid-2">
                <Field label="Sistolik" error={errors.systolic}>
                  {(p) => <input {...p} className="input num" inputMode="numeric" value={v.systolic} onChange={(e) => set("systolic", e.target.value.replace(/\D/g, ""))} />}
                </Field>
                <Field label="Diastolik">
                  {(p) => <input {...p} className="input num" inputMode="numeric" value={v.diastolic} onChange={(e) => set("diastolic", e.target.value.replace(/\D/g, ""))} />}
                </Field>
              </div>
              <p className="field__hint" style={{ marginTop: 8 }}>
                Dalam mmHg. Kosongkan jika tidak diukur.
              </p>
            </section>

            <section className="formgroup">
              <h2 className="formgroup__title">Penglihatan</h2>
              <div className="grid-2">
                <Field label="Visus kanan" optional hint="Contoh: 6/9">
                  {(p) => <input {...p} className="input num" value={v.va_right} onChange={(e) => set("va_right", e.target.value)} />}
                </Field>
                <Field label="Visus kiri" optional>
                  {(p) => <input {...p} className="input num" value={v.va_left} onChange={(e) => set("va_left", e.target.value)} />}
                </Field>
              </div>
              <Field label="Keluhan" optional>
                {(p) => (
                  <>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {COMPLAINTS.map((c) => {
                        const on = v.complaints.split(", ").includes(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            className="seg__opt"
                            aria-pressed={on}
                            style={{ background: on ? "var(--accent-soft)" : "var(--surface-2)", color: on ? "var(--accent-text)" : undefined, padding: "0 12px" }}
                            onClick={() => {
                              const list = v.complaints ? v.complaints.split(", ") : [];
                              set("complaints", (on ? list.filter((x) => x !== c) : [...list.filter((x) => (c === COMPLAINTS[0] ? false : x !== COMPLAINTS[0])), c]).join(", "));
                            }}
                          >
                            {c}
                          </button>
                        );
                      })}
                    </div>
                    <input {...p} className="input" placeholder="Atau tulis keluhan lain" value={v.complaints} onChange={(e) => set("complaints", e.target.value)} />
                  </>
                )}
              </Field>
            </section>

            <section className="formgroup">
              <Field label="Lokasi pemeriksaan" optional hint="Contoh: Posyandu Melati, Desa Sukamaju. Diingat untuk pemeriksaan berikutnya.">
                {(p) => <input {...p} className="input" value={v.location} onChange={(e) => set("location", e.target.value)} />}
              </Field>
            </section>
          </form>
        )}

        {step === 2 && (
          <>
            {!ops.local && <section className="stack-sm">
              <h2 className="t-label muted">Kamera yang dipakai</h2>
              <Segmented
                label="Sumber kamera"
                value={source}
                onChange={chooseSource}
                options={[
                  { value: "hp", label: <><DeviceMobileCamera size={18} /> HP + lensa fundus</> },
                  { value: "esp32", label: <><Cpu size={18} /> ESP32-CAM</> },
                ]}
              />
            </section>}
            <Banner tone="info">
              {source === "hp"
                ? "Pasang lensa fundus di kamera belakang HP. Redupkan ruangan beberapa menit agar pupil melebar, lalu foto satu per satu mata. Foto yang sudah ada di HP atau kamera fundus lain bisa diunggah lewat Unggah file."
                : "Pegang ESP32-CAM di depan mata pasien, lalu ketuk Ambil foto. Lampu perangkat menyala otomatis saat memotret."}
            </Banner>

            <div className="eyes">
              {(["kanan", "kiri"] as Eye[]).map((eye) => {
                const img = current(eye);
                const list = byEye(eye);
                return (
                  <section
                    key={eye}
                    className="eye"
                    aria-label={`Mata ${eye}`}
                    data-drop={dropEye === eye || undefined}
                    onDragOver={(e) => {
                      if (uploading || !e.dataTransfer.types.includes("Files")) return;
                      e.preventDefault();
                      setDropEye(eye);
                    }}
                    onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropEye(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDropEye(null);
                      onFile(eye, e.dataTransfer.files[0]);
                    }}
                  >
                    <div className="eye__head">
                      <h3 className="eye__title">Mata {eye}</h3>
                      {img && (img.quality.ok ? <CheckCircle size={20} weight="fill" color="var(--g0)" aria-label="Kualitas baik" /> : <WarningCircle size={20} weight="fill" color="var(--g1)" aria-label="Kualitas kurang" />)}
                    </div>
                    {uploading === eye ? (
                      <div className="eye__empty" aria-busy="true">
                        <div className="waiting-ring" />
                      </div>
                    ) : img ? (
                      <button className="eye__photo" onClick={() => setViewing(img)} aria-label={`Lihat foto mata ${eye}`}>
                        <img src={img.image_url} alt="" />
                      </button>
                    ) : (
                      <div className="eye__empty">Belum ada foto</div>
                    )}
                    {ops.local && img && <OfflineAi img={img} threshold={s.ref_threshold} />}
                    {list.length > 1 && (
                      <div className="eye__more" role="group" aria-label={`Foto mata ${eye} lainnya`}>
                        {list.map((i, n) => (
                          <button key={i.id} aria-pressed={i.id === img?.id} aria-label={`Foto ${n + 1}`} onClick={() => setSelected((p) => ({ ...p, [eye]: i.id }))}>
                            <img src={i.image_url} alt="" />
                          </button>
                        ))}
                      </div>
                    )}
                    <button className={`btn btn--block ${img ? "btn--secondary" : "btn--primary"}`} disabled={!!uploading} onClick={() => openCapture(eye)}>
                      <Camera size={20} />
                      {img ? "Foto ulang" : "Ambil foto"}
                    </button>
                    <button className="btn btn--ghost btn--block" disabled={!!uploading} onClick={() => pickFile(eye)}>
                      <UploadSimple size={20} />
                      Unggah file
                    </button>
                  </section>
                );
              })}
            </div>

            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/*"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                onFile(fileEye.current, f);
              }}
            />

            {poorEyes.map((eye) => (
              <Banner key={eye} tone="warn">
                <strong>{current(eye)!.quality.is_fundus === false ? `Foto mata ${eye} tidak dikenali sebagai foto retina` : `Foto mata ${eye} kurang jelas`}</strong> (
                {current(eye)!.quality.issues.join(", ")}). Dokter mungkin tidak bisa menilainya. Sebaiknya foto ulang.
              </Banner>
            ))}
          </>
        )}

        {step === 3 && (
          <>
            <section className="card">
              <dl className="kv">
                <dt>Gula darah</dt>
                <dd>{s.glucose != null ? `${str(s.glucose)} mg/dL (${GLUCOSE_KIND[s.glucose_kind ?? ""] ?? "-"})` : "-"}</dd>
                <dt>HbA1c</dt>
                <dd>{s.hba1c != null ? `${str(s.hba1c)} %` : "-"}</dd>
                <dt>Tekanan darah</dt>
                <dd>{s.systolic ? `${s.systolic}/${s.diastolic} mmHg` : "-"}</dd>
                <dt>Visus</dt>
                <dd>{s.va_right || s.va_left ? `Kanan ${s.va_right || "-"}, kiri ${s.va_left || "-"}` : "-"}</dd>
                <dt>Keluhan</dt>
                <dd style={{ fontWeight: 400 }}>{s.complaints || "-"}</dd>
              </dl>
              <button className="btn btn--ghost" style={{ marginTop: 8, marginLeft: -12 }} onClick={() => goStep(1)}>
                Ubah data klinis
              </button>
            </section>

            <div className="eyes">
              {(["kanan", "kiri"] as Eye[]).map((eye) => {
                const img = current(eye);
                return (
                  <div key={eye} className="eye">
                    <h3 className="eye__title">Mata {eye}</h3>
                    {img ? (
                      <button className="eye__photo" onClick={() => setViewing(img)} aria-label={`Lihat foto mata ${eye}`}>
                        <img src={img.image_url} alt="" />
                      </button>
                    ) : (
                      <div className="eye__empty">Tidak difoto</div>
                    )}
                    {ops.local && img && <OfflineAi img={img} threshold={s.ref_threshold} />}
                    <span className="t-caption">{byEye(eye).length} foto{img && !img.quality.ok ? ", kualitas kurang" : ""}</span>
                  </div>
                );
              })}
            </div>

            {missingEyes.length === 1 && (
              <Banner tone="warn">
                Mata {missingEyes[0]} belum difoto. Tetap bisa dilanjutkan, tetapi tulis alasannya di catatan (misalnya katarak tebal atau mata palsu).
              </Banner>
            )}

            <Field label={isDoctor ? "Catatan pemeriksaan" : "Catatan untuk dokter"} optional>
              {(p) => <textarea {...p} className="input" value={v.nurse_notes} onChange={(e) => set("nurse_notes", e.target.value)} />}
            </Field>
          </>
        )}
      </main>

      <ActionBar>
        {step === 1 && (
          <button className="btn btn--primary btn--lg" disabled={busy} onClick={() => saveVitals(2)}>
            {busy ? "Menyimpan..." : "Lanjut ke foto"}
          </button>
        )}
        {step === 2 && (
          <button className="btn btn--primary btn--lg" disabled={!s.images.length || !!uploading} onClick={() => goStep(3)}>
            {s.images.length ? "Lanjut periksa ulang" : "Ambil minimal satu foto"}
          </button>
        )}
        {step === 3 && (
          <button className="btn btn--primary btn--lg" disabled={busy || !s.images.length} onClick={submit}>
            {busy ? "Menyimpan..." : ops.local ? "Simpan dan kirim saat ada sinyal" : isDoctor ? "Lanjut ke pembacaan" : "Kirim ke dokter"}
          </button>
        )}
      </ActionBar>

      {camera && <PhoneCamera eye={camera} onClose={() => setCamera(null)} onConfirm={onPhone} />}
      {esp && (
        <Esp32Capture
          screeningId={s.id}
          eye={esp}
          onClose={() => setEsp(null)}
          onDone={(img) => {
            setEsp(null);
            addImage(img);
          }}
        />
      )}
      {viewing && (
        <Sheet title={`Mata ${viewing.eye}`} onClose={() => setViewing(null)}>
          <div className="stack">
            <RetinaViewer image={viewing} modes={false} />
            {ops.local && (viewing.ai_error ? <Banner tone="warn">AI belum menilai foto ini: {viewing.ai_error}</Banner> : <AiPanel image={viewing} threshold={s.ref_threshold} />)}
            {!viewing.quality.ok && <Banner tone="warn">Kualitas kurang: {viewing.quality.issues.join(", ")}.</Banner>}
            <button className="btn btn--danger btn--block" onClick={() => removeImage(viewing)}>
              <Trash size={20} />
              Hapus foto ini
            </button>
          </div>
        </Sheet>
      )}
      {confirmDelete && (
        <ConfirmDelete title="Hapus draf pemeriksaan?" onClose={() => setConfirmDelete(false)} onConfirm={deleteDraft}>
          <p>Data klinis dan foto pada draf ini dihapus permanen. Data pasien tetap tersimpan.</p>
        </ConfirmDelete>
      )}
    </>
  );
}

/** Ringkasan AI di kartu mata untuk draf offline (dinilai di HP). Kosong bila peran ini tidak boleh melihat AI. */
function OfflineAi({ img, threshold }: { img: RetinaImage; threshold: number | null }) {
  if (img.ai_error) return <p className="t-caption" style={{ color: "var(--g1)" }}>AI belum menilai foto ini: {img.ai_error}</p>;
  if (img.grade == null) return null;
  const high = threshold != null && (img.p_referable ?? 0) >= threshold;
  return (
    <div className="ai-line">
      <GradeChip grade={img.grade} prefix="AI: " />
      <span className="ai-line__p" data-high={high}>
        Risiko rujuk {fmtPct(img.p_referable)}
      </span>
    </div>
  );
}

/** Perkecil foto besar (kamera fundus atau HP resolusi tinggi) agar di bawah batas 10 MB server dan cepat terkirim di sinyal lemah. */
async function shrinkImage(blob: Blob, max = 2048): Promise<Blob> {
  if (blob.size < 3 * 1024 * 1024) return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * k);
    canvas.height = Math.round(bmp.height * k);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b ?? blob), "image/jpeg", 0.92));
  } catch {
    return blob;
  }
}
