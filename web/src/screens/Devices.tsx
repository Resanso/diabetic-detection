import { useEffect, useState } from "react";
import { Cpu, WifiSlash } from "@phosphor-icons/react";
import { get, type Device } from "../lib/api";
import { fmtWhen } from "../lib/format";
import { Banner, Empty, SkeletonRows, TopBar, useAsync } from "../components/ui";
import { DeviceSettings } from "../components/DeviceSettings";

export default function Devices() {
  const list = useAsync(() => get<Device[]>("/api/devices"), []);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && list.reload(), 5000);
    return () => clearInterval(t);
  }, [list.reload]);

  return (
    <>
      <TopBar title="Perangkat ESP32" />
      <main className="page stack-lg">
        <Banner tone="neutral">
          Perangkat muncul di sini setelah menyala dan menghubungi server. Pengaturan diterapkan pada polling berikutnya (sekitar 2 detik).
        </Banner>
        {list.error && <Banner tone="danger">{list.error}</Banner>}
        {list.loading && !list.data ? (
          <SkeletonRows rows={2} />
        ) : list.data?.length ? (
          list.data.map((d) => (
            <section key={d.id} className="card stack">
              <button className="row" style={{ padding: 0, minHeight: 48 }} aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? null : d.id)}>
                <Cpu size={24} />
                <span className="row__body">
                  <span className="row__title mono" style={{ display: "block", fontSize: 15 }}>
                    {d.id}
                  </span>
                  <span className="row__meta" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className={`pulse ${d.online ? "" : "pulse--off"}`} aria-hidden />
                    {d.online ? "Terhubung" : `Terakhir terlihat ${fmtWhen(d.last_seen)}`}
                    {d.ip ? `, ${d.ip}` : ""}
                  </span>
                </span>
                <span className="row__end t-caption">
                  {d.applied_version === d.settings_version ? "Pengaturan terbaru" : "Menunggu diterapkan"}
                </span>
              </button>
              {open === d.id && <DeviceSettings deviceId={d.id} />}
            </section>
          ))
        ) : (
          <Empty icon={WifiSlash}>
            Belum ada perangkat. Isi alamat server dan kunci perangkat di <span className="mono">secrets.h</span>, lalu unggah firmware ke ESP32-CAM.
          </Empty>
        )}
      </main>
    </>
  );
}
