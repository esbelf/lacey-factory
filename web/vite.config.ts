import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One .env at the repo root serves docker compose, the API and the web app.
  envDir: "..",
  server: {
    host: true,
    port: 5173,
    // Same-origin /api in dev, like CloudFront in production.
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://localhost:8787" },
  },
});
