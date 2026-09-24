import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { TaxonomyManagePage } from "./pages/TaxonomyManagePage";
import { UsersPage } from "./pages/UsersPage";
import { RepositoryModelsPage } from "./pages/RepositoryModelsPage";
import { StorageWorkspace } from "./components/StorageWorkspace";

function Private({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page muted">正在加载…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

const STORAGE_MODES = ["browse", "upload", "annotate", "manage"];

function StorageRoute() {
  const [params] = useSearchParams();
  const mode = params.get("mode") || "browse";
  const variant = STORAGE_MODES.includes(mode) ? mode : "browse";
  return <StorageWorkspace variant={variant as "browse" | "upload" | "annotate" | "manage"} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <Private>
            <Layout />
          </Private>
        }
      >
        <Route index element={<StorageRoute />} />
        <Route path="taxonomies" element={<TaxonomyManagePage />} />
        <Route path="robots" element={<RepositoryModelsPage />} />
        <Route path="users" element={<UsersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
