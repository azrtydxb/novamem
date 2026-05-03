import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./index.css";

// Single QueryClient for the whole SPA. Defaults tuned for an admin
// dashboard: short staleTime (most data is updated by the user), no
// retry on 4xx (auth errors shouldn't loop), refetch on window focus
// so sleeping the laptop doesn't show stale gauges.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 4_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, err) => {
        const msg = (err as Error).message ?? "";
        if (/\b(401|403|404)\b/.test(msg)) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
