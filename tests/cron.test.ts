import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CRON, jobForCron } from "../src/worker/jobs/scheduled";

describe("cron triggers", () => {
  it("wrangler.jsonc lists exactly the expressions the scheduled handler dispatches on", () => {
    const config = readFileSync("wrangler.jsonc", "utf8");
    const match = /"crons":\s*\[([^\]]*)\]/.exec(config);
    const configured = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(configured.sort()).toEqual(Object.values(CRON).sort());
    // Free plan: 5 triggers per account; we stay at 3.
    expect(configured.length).toBeLessThanOrEqual(3);
  });

  it("maps every expression to its job and ignores unknown ones", () => {
    expect(jobForCron("*/10 * * * *")).toBe("poll");
    expect(jobForCron("0 4 * * *")).toBe("daily");
    expect(jobForCron("0 3 * * SUN")).toBe("weekly");
    expect(jobForCron("0 3 * * 0")).toBeNull();
  });
});
