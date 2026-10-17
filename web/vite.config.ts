import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the Go server runs on :8080. Same-origin proxying keeps the
// session cookie and WebSocket origin check identical to production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Reload a file only once its size has stopped changing: with several editors (people or
    // agents) writing at once, hot reload sometimes picked up a half-written file and kept it.
    watch: { awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 } },
    proxy: {
      "/api": "http://127.0.0.1:8080",
      // keep the browser's Host: the sign-in callback is built from it and must come back through Vite
      "/auth": { target: "http://127.0.0.1:8080", changeOrigin: false },
      "/link": "http://127.0.0.1:8080",
      "/privacy": "http://127.0.0.1:8080",
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
    },
  },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 900 },
});
