import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { RepositoryAnnotatePage } from "./pages/RepositoryAnnotatePage";
import { RepositoryBrowsePage } from "./pages/RepositoryBrowsePage";
import { RepositoryManagePage } from "./pages/RepositoryManagePage";
import { RepositoryModelsPage } from "./pages/RepositoryModelsPage";
import { RepositoryUploadPage } from "./pages/RepositoryUploadPage";
import { TaxonomyManagePage } from "./pages/TaxonomyManagePage";
import { UsersPage } from "./pages/UsersPage";

function Private({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="page muted">正在加载…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
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
        <Route index element={<RepositoryBrowsePage />} />
        <Route path="annotate" element={<RepositoryAnnotatePage />} />
        <Route path="manage" element={<RepositoryManagePage />} />
        <Route path="upload" element={<RepositoryUploadPage />} />
        <Route path="taxonomies" element={<TaxonomyManagePage />} />
        <Route path="robots" element={<RepositoryModelsPage />} />
        <Route path="users" element={<UsersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
