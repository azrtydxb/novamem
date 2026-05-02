import { useEffect, useState } from "react";
import { AppShell, Tab } from "./components/AppShell";
import { ToastProvider } from "./components/Toast";
import { AuthProvider, useAuth } from "./lib/auth-context";
import { SignIn } from "./pages/SignIn";
import { HealthPage } from "./pages/HealthPage";
import { MetricsPage } from "./pages/MetricsPage";
import { TenantsPage } from "./pages/TenantsPage";
import { UsersPage } from "./pages/UsersPage";
import { MyTokensPage } from "./pages/MyTokensPage";
import { ProjectsPage } from "./pages/ProjectsPage";

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
    if (isAdmin && (tab === "tokens" || tab === "projects")) setTab("metrics");
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
      {tab === "metrics" && <MetricsPage />}
      {isAdmin && tab === "health" && <HealthPage />}
      {isAdmin && tab === "tenants" && <TenantsPage />}
      {isAdmin && tab === "users" && <UsersPage />}
      {!isAdmin && tab === "projects" && <ProjectsPage />}
      {!isAdmin && tab === "tokens" && <MyTokensPage />}
    </AppShell>
  );
}
