import { useState } from "react";
import { CaretRight, Trash, UserPlus } from "@phosphor-icons/react";
import { del, get, patch, post, type StaffRole, type Role, type User } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ROLE_LABELS, fmtWhen, initials } from "../lib/format";
import { Banner, ConfirmDelete, Field, Segmented, Sheet, SkeletonRows, TopBar, useAsync, useToast } from "../components/ui";

const ROLE_OPTIONS = (["perawat", "dokter", "admin"] as StaffRole[]).map((r) => ({ value: r, label: ROLE_LABELS[r] }));

function UserSheet({ user, onClose, onSaved }: { user: User | null; onClose: () => void; onSaved: () => void }) {
  const me = useAuth().user;
  const toast = useToast();
  const [username, setUsername] = useState(user?.username ?? "");
  const [fullName, setFullName] = useState(user?.full_name ?? "");
  const isPatient = user?.role === "pasien";
  const [role, setRole] = useState<Role>(user?.role ?? "perawat");
  const [password, setPassword] = useState("");
  const [nik, setNik] = useState(user?.nik ?? "");
  const [active, setActive] = useState(user?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const self = user?.id === me?.id;
  const nikOk = nik === "" || /^\d{16}$/.test(nik);

  if (confirmDelete && user)
    return (
      <ConfirmDelete
        title={`Hapus akun ${user.full_name}?`}
        label="Hapus akun"
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await del(`/api/users/${user.id}`);
          toast(`Akun ${user.username} dihapus`);
          onSaved();
        }}
      >
        <p>
          Akun <span className="mono">{user.username}</span> tidak bisa dipakai masuk lagi. Pemeriksaan yang pernah ia buat atau baca tetap tersimpan, tanpa nama petugas.
        </p>
        <p>Jika hanya ingin menghentikan sementara, pilih Nonaktif saja.</p>
      </ConfirmDelete>
    );

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (user) {
        await patch(`/api/users/${user.id}`, { full_name: fullName, ...(isPatient ? {} : { role, nik }), active, ...(password ? { password } : {}) });
        toast(password ? "Akun disimpan, kata sandi diatur ulang" : "Akun disimpan");
      } else {
        await post("/api/users", { username, full_name: fullName, role, password, nik });
        toast(`Akun ${username} dibuat`);
      }
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={user ? user.full_name : "Akun baru"} onClose={onClose}>
      <div className="stack">
        {error && <Banner tone="danger">{error}</Banner>}
        {!user && (
          <Field label="Nama pengguna" hint="Huruf kecil tanpa spasi, mis. sari.perawat. Dipakai untuk masuk.">
            {(p) => <input {...p} className="input" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value.trim())} />}
          </Field>
        )}
        <Field label="Nama lengkap">{(p) => <input {...p} className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />}</Field>
        {isPatient ? (
          <p className="muted">
            Akun pasien, masuk dengan NIK <span className="mono">{user!.username}</span>. Data medis dikelola dari menu Pasien.
          </p>
        ) : (
          <Field label="Peran">{() => <Segmented label="Peran" value={role} onChange={(v) => !self && setRole(v)} options={ROLE_OPTIONS} />}</Field>
        )}
        {!isPatient && role !== "admin" && (
          <Field
            label="NIK"
            optional
            error={nik && !nikOk ? "NIK 16 digit angka." : undefined}
            hint={
              user?.satusehat_linked && nik === user.nik
                ? "Terhubung ke SATUSEHAT sebagai tenaga kesehatan."
                : "Untuk mengirim bacaan dokter ke SATUSEHAT. Nomor IHS dicari otomatis dari NIK."
            }
          >
            {(p) => <input {...p} className="input mono" inputMode="numeric" maxLength={16} value={nik} onChange={(e) => setNik(e.target.value.replace(/\D/g, ""))} />}
          </Field>
        )}
        <Field
          label={user ? "Atur ulang kata sandi" : "Kata sandi awal"}
          optional={!!user}
          hint={user ? "Isi hanya jika pengguna lupa kata sandi. Semua sesi masuknya akan berakhir." : "Minimal 8 karakter. Minta pengguna menggantinya di menu Akun."}
        >
          {(p) => <input {...p} className="input" type="text" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
        </Field>
        {user && !self && (
          <Field label="Status">
            {() => (
              <Segmented
                label="Status akun"
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
        <button className="btn btn--primary btn--lg btn--block" disabled={busy || !fullName || !nikOk || (!user && (!username || password.length < 8))} onClick={save}>
          {busy ? "Menyimpan..." : user ? "Simpan" : "Buat akun"}
        </button>
        {user && !self && (
          <button className="btn btn--danger btn--block" onClick={() => setConfirmDelete(true)}>
            <Trash size={20} />
            Hapus akun
          </button>
        )}
      </div>
    </Sheet>
  );
}

export default function Users() {
  const list = useAsync(() => get<User[]>("/api/users"), []);
  const [editing, setEditing] = useState<User | "baru" | null>(null);
  const groups = (["perawat", "dokter", "admin", "pasien"] as Role[]).map((r) => ({ role: r, users: (list.data ?? []).filter((u) => u.role === r) }));

  return (
    <>
      <TopBar
        title="Pengguna"
        action={
          <button className="btn btn--ghost" onClick={() => setEditing("baru")}>
            <UserPlus size={20} />
            Tambah
          </button>
        }
      />
      <main className="page stack-lg">
        {list.error && <Banner tone="danger">{list.error}</Banner>}
        {list.loading && !list.data ? (
          <SkeletonRows rows={4} />
        ) : (
          groups.map(
            (g) =>
              g.users.length > 0 && (
                <section key={g.role}>
                  <div className="section-head">
                    <h2>{ROLE_LABELS[g.role]}</h2>
                    <span className="t-caption">{g.users.length} akun</span>
                  </div>
                  <div className="list">
                    {g.users.map((u) => (
                      <button key={u.id} className="row" onClick={() => setEditing(u)} style={!u.active ? { opacity: 0.6 } : undefined}>
                        <span className="avatar" aria-hidden>
                          {initials(u.full_name)}
                        </span>
                        <span className="row__body">
                          <span className="row__title" style={{ display: "block" }}>
                            {u.full_name}
                          </span>
                          <span className="row__meta" style={{ display: "block" }}>
                            <span className="mono">{u.username}</span>
                            {u.active ? (u.last_login ? `. Terakhir masuk ${fmtWhen(u.last_login)}` : ". Belum pernah masuk") : ". Nonaktif"}
                          </span>
                        </span>
                        <span className="row__end">
                          <CaretRight size={16} />
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              ),
          )
        )}
        {list.data && list.data.length === 1 && (
          <Banner tone="info">Buat akun untuk perawat dan dokter dengan tombol Tambah. Setiap orang sebaiknya punya akun sendiri.</Banner>
        )}
      </main>
      {editing && (
        <UserSheet
          user={editing === "baru" ? null : editing}
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
