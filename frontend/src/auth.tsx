import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, getActorToken, getToken, setActorToken, setToken } from "./api";
import { requestOpenRoleHelp } from "./help/roleHelp";
import type { Role, User } from "./types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  impersonate: (userId: number) => Promise<void>;
  stopImpersonate: () => Promise<void>;
  impersonating: boolean;
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
      if (!me.impersonated_by) {
        setActorToken(null);
      }
    } catch {
      setUser(null);
      setToken(null);
      setActorToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = async (username: string, password: string) => {
    const res = await api.login(username, password);
    setActorToken(null);
    setToken(res.access_token);
    requestOpenRoleHelp();
    await refresh();
  };

  const logout = () => {
    setToken(null);
    setActorToken(null);
    setUser(null);
  };

  const impersonate = async (userId: number) => {
    if (!getActorToken() && getToken()) {
      setActorToken(getToken());
    }
    const res = await api.impersonate(userId);
    setToken(res.access_token);
    requestOpenRoleHelp();
    await refresh();
  };

  const stopImpersonate = async () => {
    try {
      const res = await api.stopImpersonate();
      setToken(res.access_token);
    } catch {
      const actor = getActorToken();
      if (actor) setToken(actor);
      else throw new Error("无法退出视角");
    }
    setActorToken(null);
    await refresh();
  };

  const role = user?.role as Role | undefined;
  const impersonating = !!user?.impersonated_by;
  const isAdmin =
    !impersonating &&
    (role === "super_manager" || role === "admin" || !!user?.is_admin);
  const hasPerm = (capability: string) => {
    if (!user) return false;
    if (isAdmin) return true;
    const aliases =
      capability === "edit" ||
      capability === "browse" ||
      capability === "download" ||
      capability === "annotate" ||
      capability === "upload"
        ? [capability, "manage_data", "edit"]
        : capability === "manage_data"
          ? ["manage_data", "edit"]
          : [capability];
    return aliases.some((cap) => {
      if ((user.capabilities?.[cap] || []).length > 0) return true;
      return (user.permissions || []).some((p) => p.capability === cap);
    });
  };
  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      impersonate,
      stopImpersonate,
      impersonating,
      canEdit: hasPerm("upload"),
      isAdmin,
      hasPerm,
    }),
    [user, loading, impersonating]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside provider");
  return ctx;
}
