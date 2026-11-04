import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * yoga-layout (the layout engine of @react-pdf/renderer) inlines its WebAssembly as a base64
 * `data:` URL that Emscripten then fetches, which `connect-src 'self'` blocks (CSP console error).
 * Hand Emscripten the decoded bytes (`wasmBinary`) so it never fetches the data URL: no network
 * request, nothing new to precache, and the CSP stays strict.
 */
function yogaWasmFromBytes(): Plugin {
  const dataUrl = /H="data:application\/octet-stream;base64,[A-Za-z0-9+/=]+";/;
  return {
    name: "yoga-wasm-from-bytes",
    transform(code, id) {
      if (!id.includes("yoga-wasm-base64-esm")) return null;
      const match = dataUrl.exec(code);
      if (!match) this.error("yoga-layout no longer inlines its WebAssembly as a data: URL");
      const decode =
        "w||(w=Uint8Array.from(atob(H.slice(37)),function(c){return c.charCodeAt(0)}));";
      return { code: code.replace(match[0], match[0] + decode), map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    yogaWasmFromBytes(),
    // E2E builds swap in tests/e2e/worker/entry.ts (the app plus fake mailbox and Resend routes).
    cloudflare(
      process.env.E2E_WORKER
        ? {
            config: { main: "tests/e2e/worker/entry.ts" },
            // A throwaway database for every E2E run (playwright.config.ts empties it).
            persistState: { path: ".wrangler/e2e-state" },
          }
        : undefined,
    ),
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
        // vite-plugin-pwa 2 no longer implies these for autoUpdate: without them a new worker
        // waited for every tab to close, so a refresh kept serving the old precached shell.
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
      },
    }),
  ],
});
