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
                BETTER_AUTH_SECRET: "Zk3pQ9vL2mXr7TnB4wYc8HdF1sJg6UeA0oIqPz5Kx",
                SETUP_TOKEN: "test-setup-token",
                // Hermetic: a local .dev.vars must not change the origin the tests run on.
                APP_ORIGIN: "http://localhost",
                // Hermetic: a local .dev.vars with SEND_CHANNEL=mock must not change the channel.
                SEND_CHANNEL: "",
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
