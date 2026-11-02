import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Saat dev, API dan gambar diteruskan ke server FastAPI (uvicorn di port 8001).
const api = process.env.RETINOVA_API ?? "http://127.0.0.1:8001";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "../server/static/app", emptyOutDir: true },
  server: { proxy: { "/api": api, "/images": api } },
});
