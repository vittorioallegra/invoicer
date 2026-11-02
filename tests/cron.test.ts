import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CRON, jobForCron } from "../src/shared/cron";

describe("cron triggers", () => {
  it("wrangler.jsonc lists exactly the expressions the scheduled handler dispatches on", () => {
    const config = readFileSync("wrangler.jsonc", "utf8");
    const match = /"crons":\s*\[([^\]]*)\]/.exec(config);
    const configured = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(configured).toEqual(["*/10 * * * *"]);
    expect(configured.sort()).toEqual(Object.values(CRON).sort());
  });

  it("maps the polling expression to its job and ignores unknown ones", () => {
    expect(jobForCron("*/10 * * * *")).toBe("poll");
    expect(jobForCron("0 4 * * *")).toBeNull();
    expect(jobForCron("0 3 * * SUN")).toBeNull();
  });
});
