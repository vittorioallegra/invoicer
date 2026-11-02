import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createI18n, detectLocale } from "./i18n";
import { createAppRouter } from "./router";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Keep data around so lists stay readable from the cache while offline.
      gcTime: 24 * 60 * 60 * 1000,
      networkMode: "offlineFirst",
      retry: 1,
    },
  },
});

async function start() {
  const lng = detectLocale();
  document.documentElement.lang = lng;
  const i18n = await createI18n(lng);
  const router = createAppRouter();
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root element");
  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>,
  );

  // The service worker is registered in production builds only (never in `pnpm dev`).
  if (import.meta.env.PROD) {
    const { registerSW } = await import("virtual:pwa-register");
    registerSW({ immediate: true });
  }
}

void start();
