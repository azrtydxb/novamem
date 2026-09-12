import { lazy, Suspense, useEffect, useState } from "react";
import { AppShell, NAV, Tab } from "./components/AppShell";
import { ToastProvider } from "./components/Toast";
import { AuthProvider, useAuth } from "./lib/auth-context";
import { ActiveProjectProvider } from "./lib/active-project";
import { SignIn } from "./pages/SignIn";
import { ChangePasswordPage } from "./pages/ChangePasswordPage";

// Lazy-load the heavy pages so the SignIn route doesn't pay for
// recharts (~40% of the bundle) before the user is even logged in.
const HealthPage = lazy(() =>
  import("./pages/HealthPage").then((m) => ({ default: m.HealthPage }))
);
const MetricsPage = lazy(() =>
  import("./pages/MetricsPage").then((m) => ({ default: m.MetricsPage }))
);
const UsersPage = lazy(() =>
  import("./pages/UsersPage").then((m) => ({ default: m.UsersPage }))
);
const MyTokensPage = lazy(() =>
  import("./pages/MyTokensPage").then((m) => ({ default: m.MyTokensPage }))
);
const ProjectsPage = lazy(() =>
  import("./pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage }))
);
const BrowsePage = lazy(() =>
  import("./pages/BrowsePage").then((m) => ({ default: m.BrowsePage }))
);
const TodayPage = lazy(() =>
  import("./pages/TodayPage").then((m) => ({ default: m.TodayPage }))
);
const GraphPage = lazy(() =>
  import("./pages/GraphPage").then((m) => ({ default: m.GraphPage }))
);
const OnboardingPage = lazy(() =>
  import("./pages/OnboardingPage").then((m) => ({ default: m.OnboardingPage }))
);
const AuditPage = lazy(() =>
  import("./pages/AuditPage").then((m) => ({ default: m.AuditPage }))
);
const HomePage = lazy(() =>
  import("./pages/HomePage").then((m) => ({ default: m.HomePage }))
);

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <ActiveProjectProvider>
          <Authed />
        </ActiveProjectProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

function Authed() {
  const { user, loading, needsPasswordChange } = useAuth();
  const isAdmin = user?.role === "admin";
  // Null means "wherever this role lands by default" — admins open on
  // Overview, users on Home. Storing null rather than a computed initial
  // value matters because `user` is still loading on the first render,
  // so any role-derived initial state would be the wrong one.
  const [chosenTab, setTab] = useState<Tab | null>(null);
  const tab: Tab = chosenTab ?? (isAdmin ? "overview" : "home");

  // Reset to a sensible default when auth state changes (login, or a
  // demotion that takes an admin-only tab away). The set of tabs a role
  // may see is the nav registry's answer, not a second list here — that
  // is what let `metrics` survive in one place and not the other. Must
  // come before any conditional return so hook order is stable.
  useEffect(() => {
    if (!user) return;
    const role = isAdmin ? "admin" : "user";
    const allowed = new Set<Tab>(
      NAV.filter((i) => i.roles.includes(role)).map((i) => i.id)
    );
    // Palette-only pages belong to every role, so they are not "not
    // allowed" — they simply have no nav row.
    for (const i of NAV) if (i.roles.length === 0) allowed.add(i.id);
    if (!allowed.has(tab)) setTab(null);
  }, [user, isAdmin, tab]);

  if (loading) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-2 border-faint border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!user) return <SignIn />;

  // Forced change short-circuits the shell: a user who must rotate a
  // temporary password should not be able to navigate away from the
  // screen that rotates it. Since 2b the server actually sets this.
  if (needsPasswordChange) {
    return <ChangePasswordPage forced onDone={() => setTab("onboarding")} />;
  }

  return (
    <AppShell active={tab} onChange={setTab}>
      <Suspense fallback={<PageSkeleton />}>
        {tab === "overview" && <MetricsPage />}
        {isAdmin && tab === "health" && <HealthPage />}
        {isAdmin && tab === "users" && <UsersPage />}
        {isAdmin && tab === "audit" && <AuditPage />}
        {!isAdmin && tab === "home" && (
          <HomePage onBrowse={() => setTab("browse")} />
        )}
        {!isAdmin && tab === "projects" && <ProjectsPage />}
        {!isAdmin && tab === "tokens" && <MyTokensPage />}
        {!isAdmin && tab === "browse" && <BrowsePage />}
        {!isAdmin && tab === "today" && <TodayPage />}
        {!isAdmin && tab === "graph" && <GraphPage />}
        {tab === "onboarding" && (
          <OnboardingPage
            onSkip={() => setTab(null)}
            onContinue={() => setTab("tokens")}
          />
        )}
        {tab === "password" && (
          <ChangePasswordPage onDone={() => setTab(null)} />
        )}
      </Suspense>
    </AppShell>
  );
}

function PageSkeleton() {
  return (
    <div className="flex items-center justify-center py-16 text-dim">
      <div className="h-5 w-5 rounded-full border-2 border-faint border-t-transparent animate-spin" />
    </div>
  );
}
