import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";

const RELOADED_KEY = "hub_chunk_reloaded";

// Each page is its own chunk, so the login page and the shell do not wait for
// three.js and the preview code. After a new release the old chunk names are
// gone; a tab opened before it reloads once to pick up the new ones.
function lazyPage<T extends React.ComponentType<any>>(load: () => Promise<T>) {
  return lazy(async () => {
    try {
      const component = await load();
      sessionStorage.removeItem(RELOADED_KEY);
      return { default: component };
    } catch (error) {
      if (!sessionStorage.getItem(RELOADED_KEY)) {
        sessionStorage.setItem(RELOADED_KEY, "1");
        window.location.reload();
        return new Promise<{ default: T }>(() => undefined);
      }
      throw error;
    }
  });
}

const RetargetManagePage = lazyPage(() => import("./pages/RetargetManagePage").then((m) => m.RetargetManagePage));
const TaxonomyManagePage = lazyPage(() => import("./pages/TaxonomyManagePage").then((m) => m.TaxonomyManagePage));
const UsersPage = lazyPage(() => import("./pages/UsersPage").then((m) => m.UsersPage));
const AuditPage = lazyPage(() => import("./pages/AuditPage").then((m) => m.AuditPage));
const TrashPage = lazyPage(() => import("./pages/TrashPage").then((m) => m.TrashPage));
const RepositoryModelsPage = lazyPage(() => import("./pages/RepositoryModelsPage").then((m) => m.RepositoryModelsPage));
const VisualizePage = lazyPage(() => import("./pages/VisualizePage").then((m) => m.VisualizePage));
const StorageWorkspace = lazyPage(() => import("./components/StorageWorkspace").then((m) => m.StorageWorkspace));

function Page({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className="page muted">正在加载…</div>}>{children}</Suspense>;
}

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
        <Route index element={<Page><StorageRoute /></Page>} />
        <Route path="taxonomies" element={<Page><TaxonomyManagePage /></Page>} />
        <Route path="retarget" element={<Page><RetargetManagePage /></Page>} />
        <Route path="robots" element={<Page><RepositoryModelsPage /></Page>} />
        <Route path="visualize" element={<Page><VisualizePage /></Page>} />
        <Route path="users" element={<Page><UsersPage /></Page>} />
        <Route path="audit" element={<Page><AuditPage /></Page>} />
        <Route path="trash" element={<Page><TrashPage /></Page>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
