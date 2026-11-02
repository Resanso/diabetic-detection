import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { get, onUnauthorized, post, type User } from "./api";

interface AuthState {
  user: User | null;
  needsSetup: boolean;
  ready: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>(null!);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setUser(await get<User>("/api/auth/me"));
      setNeedsSetup(false);
    } catch {
      setUser(null);
      try {
        setNeedsSetup((await get<{ needs_setup: boolean }>("/api/auth/status")).needs_setup);
      } catch {
        setNeedsSetup(false);
      }
    } finally {
      setReady(true);
    }
  }, []);

  const logout = useCallback(async () => {
    await post("/api/auth/logout").catch(() => {});
    setUser(null);
  }, []);

  useEffect(() => {
    refresh();
    return onUnauthorized(() => setUser(null));
  }, [refresh]);

  return <Ctx.Provider value={{ user, needsSetup, ready, refresh, logout }}>{children}</Ctx.Provider>;
}
