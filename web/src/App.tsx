import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import {
  CalendarBlank,
  CalendarPlus,
  Eye,
  House,
  ListChecks,
  User as UserIcon,
  UserList,
  UsersThree,
} from "@phosphor-icons/react";
import { useAuth } from "./lib/auth";
import type { Role } from "./lib/api";
import { BottomNav, Mark, useAsync, type NavItem } from "./components/ui";
import { get } from "./lib/api";
import Login from "./screens/Login";
import NurseHome from "./screens/NurseHome";
import Patients from "./screens/Patients";
import PatientForm from "./screens/PatientForm";
import PatientDetail from "./screens/PatientDetail";
import NewScreening from "./screens/NewScreening";
import ScreeningFlow from "./screens/ScreeningFlow";
import ScreeningView from "./screens/ScreeningView";
import DoctorQueue from "./screens/DoctorQueue";
import ReadHistory from "./screens/ReadHistory";
import Users from "./screens/Users";
import Devices from "./screens/Devices";
import Tariffs from "./screens/Tariffs";
import Account from "./screens/Account";
import Register from "./screens/Register";
import PatientHome from "./screens/PatientHome";
import Booking from "./screens/Booking";
import QueueBoard from "./screens/QueueBoard";
import Schedule from "./screens/Schedule";

const HOME: Record<Role, string> = { perawat: "/beranda", dokter: "/antrean", admin: "/pengguna", pasien: "/kunjungan" };

function Shell({ role }: { role: Role }) {
  // Lencana di navigasi: jumlah antrean untuk dokter
  const { data } = useAsync(
    () => (role === "dokter" ? get<{ waiting: number }>("/api/summary") : Promise.resolve(null)),
    [role],
  );
  const items: Record<Role, NavItem[]> = {
    perawat: [
      { to: "/beranda", label: "Beranda", icon: House },
      { to: "/antrean", label: "Antrean", icon: ListChecks },
      { to: "/pasien", label: "Pasien", icon: UserList },
      { to: "/akun", label: "Akun", icon: UserIcon },
    ],
    dokter: [
      { to: "/antrean", label: "Antrean", icon: ListChecks },
      { to: "/bacaan", label: "Bacaan", icon: Eye, badge: data?.waiting },
      { to: "/jadwal", label: "Jadwal", icon: CalendarBlank },
      { to: "/pasien", label: "Pasien", icon: UserList },
      { to: "/akun", label: "Akun", icon: UserIcon },
    ],
    admin: [
      { to: "/pengguna", label: "Pengguna", icon: UsersThree },
      { to: "/jadwal", label: "Jadwal", icon: CalendarBlank },
      { to: "/antrean", label: "Antrean", icon: ListChecks },
      { to: "/pasien", label: "Pasien", icon: UserList },
      { to: "/akun", label: "Akun", icon: UserIcon },
    ],
    pasien: [
      { to: "/kunjungan", label: "Kunjungan", icon: House },
      { to: "/booking", label: "Booking", icon: CalendarPlus },
      { to: "/akun", label: "Akun", icon: UserIcon },
    ],
  };
  return (
    <div className="app has-sidenav">
      <div className="app-main">
        <Outlet />
      </div>
      <BottomNav items={items[role]} />
    </div>
  );
}

function Bare() {
  return (
    <div className="app">
      <Outlet />
    </div>
  );
}

function Only({ roles }: { roles: Role[] }) {
  const { user } = useAuth();
  return user && roles.includes(user.role) ? <Outlet /> : <Navigate to="/" replace />;
}

export default function App() {
  const { user, ready } = useAuth();

  if (!ready) {
    return (
      <div className="auth" style={{ alignItems: "center", justifyContent: "center", color: "var(--ink-3)" }}>
        <Mark size={40} />
      </div>
    );
  }
  if (!user)
    return (
      <Routes>
        <Route path="/daftar" element={<Register />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );

  if (user.role === "pasien")
    return (
      <Routes>
        <Route element={<Shell role="pasien" />}>
          <Route path="/kunjungan" element={<PatientHome />} />
          <Route path="/akun" element={<Account />} />
        </Route>
        <Route element={<Bare />}>
          <Route path="/booking" element={<Booking />} />
        </Route>
        <Route path="*" element={<Navigate to={HOME.pasien} replace />} />
      </Routes>
    );

  return (
    <Routes>
      <Route element={<Shell role={user.role} />}>
        <Route element={<Only roles={["perawat"]} />}>
          <Route path="/beranda" element={<NurseHome />} />
        </Route>
        <Route element={<Only roles={["dokter"]} />}>
          <Route path="/bacaan" element={<DoctorQueue />} />
          <Route path="/riwayat" element={<ReadHistory />} />
        </Route>
        <Route element={<Only roles={["admin"]} />}>
          <Route path="/pengguna" element={<Users />} />
          <Route path="/perangkat" element={<Devices />} />
          <Route path="/tarif" element={<Tariffs />} />
        </Route>
        <Route path="/antrean" element={<QueueBoard />} />
        <Route path="/jadwal" element={<Schedule />} />
        <Route path="/pasien" element={<Patients />} />
        <Route path="/akun" element={<Account />} />
      </Route>
      <Route element={<Bare />}>
        <Route path="/pasien/baru" element={<PatientForm />} />
        <Route path="/pasien/:id" element={<PatientDetail />} />
        <Route path="/pasien/:id/ubah" element={<PatientForm />} />
        <Route path="/pemeriksaan/:id" element={<ScreeningView />} />
        <Route element={<Only roles={["perawat", "dokter", "admin"]} />}>
          <Route path="/periksa" element={<NewScreening />} />
          <Route path="/periksa/:id" element={<ScreeningFlow />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to={HOME[user.role]} replace />} />
    </Routes>
  );
}
