import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// During dev (`bun run dev`), the daemon's API + WS lives on a separate port.
// We proxy /api, /ws, /pty, /pair, /health to it so the dev server "looks
// like" the daemon to the browser.
const DAEMON = process.env.AGENTD_DEV_DAEMON ?? "http://127.0.0.1:3773";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: DAEMON, changeOrigin: true },
      "/pair": { target: DAEMON, changeOrigin: true },
      "/health": { target: DAEMON, changeOrigin: true },
      "/ws": { target: DAEMON, ws: true, changeOrigin: true },
      "/pty": { target: DAEMON, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});
