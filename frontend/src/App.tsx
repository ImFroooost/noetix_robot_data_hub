import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { ClipDetailPage } from "./pages/ClipDetailPage";
import { HubRepoPage } from "./pages/HubRepoPage";
import { LoginPage } from "./pages/LoginPage";
import { RobotModelsPage } from "./pages/RobotModelsPage";
import { SearchPage } from "./pages/SearchPage";
import { TaxonomyManagePage } from "./pages/TaxonomyManagePage";
import { UploadPage } from "./pages/UploadPage";
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
        <Route index element={<SearchPage />} />
        <Route path="clips/:id" element={<ClipDetailPage />} />
        <Route path="upload" element={<UploadPage />} />
        <Route path="hub" element={<HubRepoPage />} />
        <Route path="taxonomies" element={<TaxonomyManagePage />} />
        <Route path="robots" element={<RobotModelsPage />} />
        <Route path="users" element={<UsersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
