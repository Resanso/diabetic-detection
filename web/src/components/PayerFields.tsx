import type { Payer } from "../lib/api";
import { Field, Segmented } from "./ui";

export interface PayerValue {
  payer: Payer | null;
  bpjs_no: string;
  insurer: string;
  policy_no: string;
}

export const payerFrom = (p?: { payer: Payer | null; bpjs_no: string | null; insurer: string | null; policy_no: string | null } | null): PayerValue => ({
  payer: p?.payer ?? null,
  bpjs_no: p?.bpjs_no ?? "",
  insurer: p?.insurer ?? "",
  policy_no: p?.policy_no ?? "",
});

/** Pesan galat per kolom; kosong berarti valid. `required` mewajibkan cara bayar dipilih. */
export function payerErrors(v: PayerValue, required: boolean): Partial<Record<keyof PayerValue, string>> {
  const e: Partial<Record<keyof PayerValue, string>> = {};
  if (required && !v.payer) e.payer = "Pilih cara bayar.";
  if (v.payer === "bpjs" && !/^\d{13}$/.test(v.bpjs_no)) e.bpjs_no = "Nomor kartu BPJS 13 digit angka, ada di kartu atau aplikasi Mobile JKN.";
  if (v.payer === "asuransi" && !v.insurer.trim()) e.insurer = "Isi nama asuransi.";
  return e;
}

/** Nilai untuk dikirim ke server: kolom yang tidak berlaku untuk cara bayar terpilih dikosongkan. */
export const payerBody = (v: PayerValue) => ({
  payer: v.payer,
  bpjs_no: v.payer === "bpjs" ? v.bpjs_no : null,
  insurer: v.payer === "asuransi" ? v.insurer.trim() : null,
  policy_no: v.payer === "asuransi" ? v.policy_no.trim() || null : null,
});

export function PayerFields({
  value,
  onChange,
  errors = {},
  optional,
}: {
  value: PayerValue;
  onChange: (v: PayerValue) => void;
  errors?: Partial<Record<keyof PayerValue, string>>;
  optional?: boolean;
}) {
  const set = <K extends keyof PayerValue>(k: K, v: PayerValue[K]) => onChange({ ...value, [k]: v });
  return (
    <>
      <Field label="Cara bayar" optional={optional} error={errors.payer}>
        {() => (
          <Segmented
            label="Cara bayar"
            value={value.payer}
            onChange={(v) => set("payer", optional && value.payer === v ? null : v)}
            options={[
              { value: "bpjs", label: "BPJS" },
              { value: "asuransi", label: "Asuransi" },
              { value: "umum", label: "Umum" },
            ]}
          />
        )}
      </Field>
      {value.payer === "bpjs" && (
        <Field label="Nomor kartu BPJS" error={errors.bpjs_no} hint="13 digit, ada di kartu JKN atau aplikasi Mobile JKN.">
          {(p) => (
            <input
              {...p}
              className="input num"
              inputMode="numeric"
              autoComplete="off"
              maxLength={13}
              value={value.bpjs_no}
              onChange={(e) => set("bpjs_no", e.target.value.replace(/\D/g, ""))}
            />
          )}
        </Field>
      )}
      {value.payer === "asuransi" && (
        <div className="grid-2">
          <Field label="Nama asuransi" error={errors.insurer}>
            {(p) => <input {...p} className="input" value={value.insurer} onChange={(e) => set("insurer", e.target.value)} />}
          </Field>
          <Field label="Nomor polis" optional>
            {(p) => <input {...p} className="input num" autoComplete="off" value={value.policy_no} onChange={(e) => set("policy_no", e.target.value)} />}
          </Field>
        </div>
      )}
    </>
  );
}
