import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the Go server runs on :8080. Same-origin proxying keeps the
// session cookie and WebSocket origin check identical to production.
// scripts/dev.sh --lan: https with its self-signed certificate (a microphone and a camera need https off localhost)
const key = process.env.HQ_DEV_HTTPS_KEY, cert = process.env.HQ_DEV_HTTPS_CERT;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    https: key && cert ? { key: readFileSync(key), cert: readFileSync(cert) } : undefined,
    // Reload a file only once its size has stopped changing: with several editors (people or
    // agents) writing at once, hot reload sometimes picked up a half-written file and kept it.
    watch: { awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 } },
    proxy: {
      "/api": "http://127.0.0.1:8080",
      // keep the browser's Host: the sign-in callback is built from it and must come back through Vite
      "/auth": { target: "http://127.0.0.1:8080", changeOrigin: false },
      "/link": "http://127.0.0.1:8080",
      "/about": "http://127.0.0.1:8080",
      "/privacy": "http://127.0.0.1:8080",
      "/plugins": "http://127.0.0.1:8080",
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
      // the dev LiveKit, for pages served over https (dev.sh --lan gives them wss://<address>:5173/livekit)
      "/livekit": { target: "http://127.0.0.1:7880", ws: true, rewrite: (p) => p.replace(/^\/livekit/, "") },
    },
  },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 900 },
});
