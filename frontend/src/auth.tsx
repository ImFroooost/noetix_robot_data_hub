import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, setToken, getToken } from "./api";
import type { Role, User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  canEdit: boolean;
  isAdmin: boolean;
  hasPerm: (capability: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.me();
      setUser(me);
    } catch {
      setUser(null);
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = async (username: string, password: string) => {
    const res = await api.login(username, password);
    setToken(res.access_token);
    await refresh();
  };

  const logout = () => {
    setToken(null);
    setUser(null);
  };

  const role = user?.role as Role | undefined;
  const isAdmin = role === "admin" || !!user?.is_admin;
  const hasPerm = (capability: string) => {
    if (!user) return false;
    if (isAdmin) return true;
    if ((user.capabilities?.[capability] || []).length > 0) return true;
    return (user.permissions || []).some((p) => p.capability === capability);
  };
  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      canEdit: isAdmin || role === "editor" || hasPerm("edit") || hasPerm("upload"),
      isAdmin,
      hasPerm,
    }),
    [user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
