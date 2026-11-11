import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/app.css";
import App from "./App";
import { AuthProvider } from "./lib/auth";
import { ToastProvider } from "./components/ui";
import { initTheme } from "./lib/theme";
import { registerSW } from "virtual:pwa-register";

initTheme();
// Service worker: aplikasi tetap terbuka tanpa sinyal. Versi baru aktif setelah aplikasi ditutup lalu dibuka lagi.
registerSW({ immediate: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
