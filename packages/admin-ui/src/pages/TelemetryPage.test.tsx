import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryPage } from "./TelemetryPage";

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "admin-1", role: "admin" } }),
}));
vi.mock("../lib/api", () => ({
  api: vi.fn(async () => ({ body: {
    totalEntries: 0, embeddedEntries: 0, pendingEmbeddings: 0, pendingExtractions: 0, pendingColdOrphans: 0,
    byNamespace: [], byProject: [], bySensitivity: [], byTier: [], createdPerDay: [], topAgents: [], lastDecayAt: null,
    health: { ok: true, deps: { warm: "ok", cold: "ok", embedder: "ok" }, coldProvider: "none", pendingEmbeddings: 0 },
  } })),
}));

describe("TelemetryPage", () => {
  beforeEach(() => vi.clearAllMocks());
  it("renders aggregate totals and the empty-store state", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TelemetryPage /></QueryClientProvider>);
    expect(await screen.findByText("No memory entries yet")).toBeInTheDocument();
    expect(screen.getByText("entries")).toBeInTheDocument();
    expect(screen.getByText("entries by sensitivity · 30 days")).toBeInTheDocument();
  });
});
