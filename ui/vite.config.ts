import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development Vite serves the UI and forwards the API, the event stream and /mcp to the app.
const app = process.env.CISTERN_APP ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: app, changeOrigin: false }, "/mcp": { target: app, changeOrigin: false } },
  },
  build: { outDir: "dist", chunkSizeWarningLimit: 1500 },
});
