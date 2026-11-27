import { defineConfig } from "vite";

// Tauri expects a fixed dev port (devUrl in src-tauri/tauri.conf.json, and the daemon's CORS list).
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
});
