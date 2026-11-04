import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4173);

// E2E runs against the production build served by `vite preview` (service worker enabled).
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "dot" : "list",
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [
    // The smoke checks need the empty first-run database, so the flows (which create the owner)
    // run only after both smoke projects are done.
    { name: "desktop", testIgnore: /flows\.spec/, use: { ...devices["Desktop Chrome"] } },
    { name: "iphone", testIgnore: /flows\.spec/, use: { ...devices["iPhone 14"] } },
    {
      // Chromium only: the flows need a virtual passkey authenticator (CDP).
      name: "flows",
      testMatch: /flows\.spec/,
      dependencies: ["desktop", "iphone"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // E2E_WORKER=1 builds with the E2E Worker entry (tests/e2e/worker/entry.ts) and a fresh
    // throwaway database in .wrangler/e2e-state; it overwrites dist/, so rebuild before a deploy.
    command: `rm -rf .wrangler/e2e-state && (test -f .dev.vars || cp .dev.vars.example .dev.vars) && pnpm exec wrangler d1 migrations apply DB --local --persist-to .wrangler/e2e-state && E2E_WORKER=1 pnpm build && E2E_WORKER=1 pnpm preview --port ${port} --strictPort`,
    url: `http://localhost:${port}/api/health`,
    // Never reuse a server: the flows need an empty database.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
