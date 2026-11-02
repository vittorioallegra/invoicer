import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare(),
    VitePWA({
      registerType: "autoUpdate",
      // Registered from src/client/main.tsx in production builds only (no inline script).
      injectRegister: false,
      // Service worker disabled in `pnpm dev`; tested through `pnpm preview` and E2E.
      devOptions: { enabled: false },
      manifest: {
        id: "/",
        name: "Invoicer",
        short_name: "Invoicer",
        description: "Self-hosted e-invoicing for Italian sole proprietors",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#fafafa",
        theme_color: "#2f4fb5",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Shell only: the API is never served from the service worker cache.
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        // Push and notification-click handlers live in public/push-sw.js.
        importScripts: ["/push-sw.js"],
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
      },
    }),
  ],
});
