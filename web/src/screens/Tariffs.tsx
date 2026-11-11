import { useState } from "react";
import { CaretRight, Plus } from "@phosphor-icons/react";
import { get, post, put, type Tariff } from "../lib/api";
import { fmtRp } from "../lib/format";
import { Banner, Field, Segmented, Sheet, SkeletonRows, TopBar, useAsync, useToast } from "../components/ui";

function TariffSheet({ tariff, onClose, onSaved }: { tariff: Tariff | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(tariff?.name ?? "");
  const [free, setFree] = useState(tariff ? tariff.price === 0 : false);
  const [price, setPrice] = useState(tariff && tariff.price > 0 ? String(tariff.price) : "");
  const [description, setDescription] = useState(tariff?.description ?? "");
  const [active, setActive] = useState(tariff?.active ?? true);
  const [isDefault, setIsDefault] = useState(tariff?.is_default ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = free ? 0 : Number(price);
  const priceError = !free && price !== "" && !(Number.isInteger(amount) && amount > 0) ? "Isi harga dalam rupiah, angka saja." : undefined;
  const valid = name.trim().length >= 2 && (free || (price !== "" && !priceError));

  async function save() {
    setBusy(true);
    setError(null);
    const body = { name, price: amount, description, active: active || isDefault, is_default: isDefault };
    try {
      if (tariff) await put(`/api/tariffs/${tariff.id}`, body);
      else await post("/api/tariffs", body);
      toast("Tarif disimpan");
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={tariff ? tariff.name : "Tarif baru"} onClose={onClose}>
      <div className="stack">
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Nama layanan" hint="Contoh: Skrining retina, Skrining retina program Puskesmas.">
          {(p) => <input {...p} className="input" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Biaya">
          {() => (
            <Segmented
              label="Biaya"
              value={free ? "gratis" : "bayar"}
              onChange={(v) => setFree(v === "gratis")}
              options={[
                { value: "gratis", label: "Gratis (Rp0)" },
                { value: "bayar", label: "Berbayar" },
              ]}
            />
          )}
        </Field>
        {!free && (
          <Field label="Harga" error={priceError}>
            {(p) => (
              <div className="input-wrap">
                <span className="input-wrap__unit" style={{ left: 14, right: "auto" }}>
                  Rp
                </span>
                <input {...p} className="input num" inputMode="numeric" style={{ paddingLeft: 44 }} value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))} />
              </div>
            )}
          </Field>
        )}
        <Field label="Keterangan" optional>
          {(p) => <input {...p} className="input" value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label="Tarif bawaan" hint="Dipakai otomatis bila tarif tidak dipilih, termasuk pemeriksaan yang dikirim dari aplikasi HP.">
          {() => (
            <Segmented
              label="Tarif bawaan"
              value={isDefault ? 1 : 0}
              onChange={(v) => setIsDefault(v === 1)}
              options={[
                { value: 1, label: "Ya" },
                { value: 0, label: "Tidak" },
              ]}
            />
          )}
        </Field>
        {tariff && !isDefault && (
          <Field label="Status" hint="Tarif nonaktif tidak bisa dipilih lagi. Pemeriksaan lama tetap memakai tarifnya.">
            {() => (
              <Segmented
                label="Status tarif"
                value={active ? 1 : 0}
                onChange={(v) => setActive(v === 1)}
                options={[
                  { value: 1, label: "Aktif" },
                  { value: 0, label: "Nonaktif" },
                ]}
              />
            )}
          </Field>
        )}
        <button className="btn btn--primary btn--lg btn--block" disabled={busy || !valid} onClick={save}>
          {busy ? "Menyimpan..." : tariff ? "Simpan" : "Buat tarif"}
        </button>
      </div>
    </Sheet>
  );
}

export default function Tariffs() {
  const list = useAsync(() => get<Tariff[]>("/api/tariffs?all=true"), []);
  const [editing, setEditing] = useState<Tariff | "baru" | null>(null);

  return (
    <>
      <TopBar
        title="Tarif layanan"
        back={true}
        action={
          <button className="btn btn--ghost" onClick={() => setEditing("baru")}>
            <Plus size={20} />
            Tambah
          </button>
        }
      />
      <main className="page stack-lg">
        <p className="muted">Setiap pemeriksaan memakai satu tarif. Tagihan ikut terkirim ke SATUSEHAT bersama bacaan dokter.</p>
        {list.error && <Banner tone="danger">{list.error}</Banner>}
        {list.loading && !list.data ? (
          <SkeletonRows rows={3} />
        ) : (
          <div className="list">
            {(list.data ?? []).map((t) => (
              <button key={t.id} className="row" onClick={() => setEditing(t)} style={!t.active ? { opacity: 0.6 } : undefined}>
                <span className="row__body">
                  <span className="row__title" style={{ display: "block" }}>
                    {t.name}
                  </span>
                  <span className="row__meta" style={{ display: "block" }}>
                    {[t.is_default ? "Bawaan" : null, t.active ? null : "Nonaktif", t.description].filter(Boolean).join(". ") || " "}
                  </span>
                </span>
                <span className="row__end">
                  <span className={`chip ${t.price === 0 ? "chip--draf" : "chip--menunggu"}`}>{fmtRp(t.price)}</span>
                  <CaretRight size={16} />
                </span>
              </button>
            ))}
          </div>
        )}
      </main>
      {editing && (
        <TariffSheet
          tariff={editing === "baru" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}
