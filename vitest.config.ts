import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          environment: "node",
          include: ["src/shared/**/*.test.ts", "tests/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              bindings: {
                BETTER_AUTH_SECRET: "test-secret",
                SETUP_TOKEN: "test-setup-token",
                SPIKE_SECRET: "test-spike-secret",
              },
            },
          }),
        ],
        test: {
          name: "worker",
          include: ["src/worker/**/*.test.ts", "src/db/**/*.test.ts"],
        },
      },
      {
        esbuild: { jsx: "automatic" },
        test: {
          name: "client",
          environment: "jsdom",
          include: ["src/client/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});
