import { lazy, Suspense, useEffect, useState } from "react";
import { AppShell, Tab } from "./components/AppShell";
import { ToastProvider } from "./components/Toast";
import { AuthProvider, useAuth } from "./lib/auth-context";
import { SignIn } from "./pages/SignIn";

// P2-3: lazy-load the heavy pages so the SignIn route doesn't pay for
// recharts (~40% of the bundle) before the user is even logged in.
const HealthPage = lazy(() => import("./pages/HealthPage").then((m) => ({ default: m.HealthPage })));
const MetricsPage = lazy(() => import("./pages/MetricsPage").then((m) => ({ default: m.MetricsPage })));
const TenantsPage = lazy(() => import("./pages/TenantsPage").then((m) => ({ default: m.TenantsPage })));
const UsersPage = lazy(() => import("./pages/UsersPage").then((m) => ({ default: m.UsersPage })));
const MyTokensPage = lazy(() => import("./pages/MyTokensPage").then((m) => ({ default: m.MyTokensPage })));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Authed />
      </ToastProvider>
    </AuthProvider>
  );
}

function Authed() {
  const { user, loading } = useAuth();
  const isAdmin = user?.role === "admin";
  const defaultTab: Tab = isAdmin ? "metrics" : "metrics";
  const [tab, setTab] = useState<Tab>(defaultTab);

  // Reset to a sensible default when auth state changes (login → switch to
  // metrics; demote → don't show admin-only tabs).
  useEffect(() => {
    if (!user) return;
    if (!isAdmin && (tab === "tenants" || tab === "users" || tab === "health")) setTab("metrics");
  }, [user, isAdmin, tab]);

  if (loading) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-2 border-text-subtle border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!user) return <SignIn />;

  return (
    <AppShell active={tab} onChange={setTab}>
      <Suspense fallback={<PageSkeleton />}>
        {tab === "metrics" && <MetricsPage />}
        {isAdmin && tab === "health" && <HealthPage />}
        {isAdmin && tab === "tenants" && <TenantsPage />}
        {isAdmin && tab === "users" && <UsersPage />}
        {tab === "projects" && <ProjectsPage />}
        {tab === "tokens" && <MyTokensPage />}
      </Suspense>
    </AppShell>
  );
}

function PageSkeleton() {
  return (
    <div className="flex items-center justify-center py-16 text-text-muted">
      <div className="h-5 w-5 rounded-full border-2 border-text-subtle border-t-transparent animate-spin" />
    </div>
  );
}
