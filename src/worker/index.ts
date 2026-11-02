import { app } from "./app";
import type { Bindings } from "./env";
import { lastCompletedDailyDate } from "./jobs/job-runs";
import { runScheduled } from "./jobs/scheduled";

export default {
  fetch: app.fetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env, lastCompletedDailyDate));
  },
} satisfies ExportedHandler<Bindings>;
