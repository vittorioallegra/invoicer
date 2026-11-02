import { app } from "./app";
import type { Bindings } from "./env";
import { runScheduled } from "./jobs/scheduled";

export default {
  fetch: app.fetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env));
  },
} satisfies ExportedHandler<Bindings>;
