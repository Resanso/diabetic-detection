import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, get, onUnauthorized, post, type User } from "./api";
import { prepareOffline } from "./offline/ai";
import { forgetServerCopies } from "./offline/store";
import { startSync } from "./offline/sync";

interface AuthState {
  user: User | null;
  needsSetup: boolean;
  ready: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null!);
export const useAuth = () => useContext(Ctx);

// Akun terakhir yang masuk, agar aplikasi tetap bisa dipakai saat dibuka tanpa sinyal
const USER_KEY = "retinova.user";
const saved = {
  get: (): User | null => {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) ?? "null");
    } catch {
      return null;
    }
  },
  set: (u: User | null) => {
    try {
      if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
      else localStorage.removeItem(USER_KEY);
    } catch {
      /* penyimpanan lokal tidak tersedia */
    }
  },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const u = await get<User>("/api/auth/me");
      saved.set(u);
      setUser(u);
      setNeedsSetup(false);
    } catch (e) {
      const offline = e instanceof ApiError && e.status === 0 ? saved.get() : null;
      setUser(offline);
      if (!offline) saved.set(null);
      if (!offline) {
        try {
          setNeedsSetup((await get<{ needs_setup: boolean }>("/api/auth/status")).needs_setup);
        } catch {
          setNeedsSetup(false);
        }
      }
    } finally {
      setReady(true);
    }
  }, []);

  const logout = useCallback(async () => {
    await post("/api/auth/logout").catch(() => {});
    saved.set(null);
    await forgetServerCopies();
    setUser(null);
  }, []);

  useEffect(() => {
    refresh();
    return onUnauthorized(() => {
      saved.set(null);
      setUser(null);
    });
  }, [refresh]);

  // Petugas: kirim pekerjaan offline yang tertunda dan siapkan model AI untuk dipakai tanpa sinyal
  const staffId = user && user.role !== "pasien" ? user.id : null;
  useEffect(() => {
    startSync(staffId);
    if (staffId != null && navigator.onLine) prepareOffline();
  }, [staffId]);

  return <Ctx.Provider value={{ user, needsSetup, ready, refresh, logout }}>{children}</Ctx.Provider>;
}
