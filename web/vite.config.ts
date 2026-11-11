import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Saat dev, API dan gambar diteruskan ke server FastAPI (uvicorn di port 8001).
const api = process.env.RETINOVA_API ?? "http://127.0.0.1:8001";

export default defineConfig({
  plugins: [
    react(),
    // PWA: aplikasi bisa dipasang di HP dan terbuka tanpa sinyal. Service worker ada di src/sw.ts.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // Versi baru menunggu sampai aplikasi ditutup, agar formulir yang sedang diisi tidak ter-reload
      registerType: "prompt",
      injectRegister: false,
      manifest: false, // memakai public/manifest.webmanifest
      injectManifest: {
        globPatterns: ["**/*.{html,js,mjs,css,svg,png,woff2,wasm,webmanifest}"],
        // ONNX Runtime (.wasm) sekitar 11 MB; harus ikut tersimpan agar AI jalan offline
        maximumFileSizeToCacheInBytes: 16 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  build: { outDir: "../server/static/app", emptyOutDir: true },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  server: { proxy: { "/api": api, "/images": api } },
});
