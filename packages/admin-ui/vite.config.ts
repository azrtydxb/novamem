import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The admin UI is served by the novamem server under /admin/, so all asset
// URLs must be absolute under that prefix. Build output goes to dist/ and
// the server's build script copies it into packages/server/dist/admin/ui/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/admin/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Stable filenames are easier to set CSP headers against and produce
        // smaller diffs in the docker image layer.
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    proxy: {
      // Local dev: proxy API + admin endpoints to the running novamem server
      // so the SPA can be developed with `pnpm dev` without rebuilding the
      // image. Set NOVAMEM_DEV_TARGET to override the default 7778.
      "/v1": process.env.NOVAMEM_DEV_TARGET ?? "http://localhost:7778",
      "/health": process.env.NOVAMEM_DEV_TARGET ?? "http://localhost:7778",
    },
  },
});
