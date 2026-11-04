import { describe, expect, it } from "vitest";
import { addDays, recurringScheduleSchema, scheduleDates } from "./recurring";

const monthly = { intervalMonths: 1, dayOfMonth: 1, startDate: "2026-01-01" };

describe("recurring schedule dates", () => {
  it("lists a monthly schedule on day 1, one per month", () => {
    expect(scheduleDates(monthly, "2026-04-01")).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
    ]);
    expect(scheduleDates(monthly, "2026-03-31")).toHaveLength(3);
  });

  it("uses the last day of a shorter month and keeps the day for the next one", () => {
    const dates = scheduleDates(
      { intervalMonths: 1, dayOfMonth: 31, startDate: "2027-01-01" },
      "2027-05-31",
    );
    expect(dates).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]);
    expect(
      scheduleDates({ intervalMonths: 1, dayOfMonth: 30, startDate: "2028-02-01" }, "2028-02-29"),
    ).toEqual(["2028-02-29"]);
  });

  it("skips a first date before the start date and honours the interval across years", () => {
    expect(
      scheduleDates({ intervalMonths: 3, dayOfMonth: 15, startDate: "2026-11-20" }, "2027-12-31"),
    ).toEqual(["2027-02-15", "2027-05-15", "2027-08-15", "2027-11-15"]);
    expect(
      scheduleDates({ intervalMonths: 12, dayOfMonth: 5, startDate: "2026-03-05" }, "2028-12-31"),
    ).toEqual(["2026-03-05", "2027-03-05", "2028-03-05"]);
  });

  it("stops at the limit", () => {
    expect(scheduleDates(monthly, "2030-01-01", 2)).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("shifts calendar days without a time zone", () => {
    expect(addDays("2026-03-28", 3)).toBe("2026-03-31");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("recurring schedule input", () => {
  it("accepts a valid schedule and rejects bad intervals, days and ranges", () => {
    const ok = { ...monthly, endDate: null, maxCount: null };
    expect(recurringScheduleSchema.safeParse(ok).success).toBe(true);
    expect(recurringScheduleSchema.safeParse({ ...ok, intervalMonths: 5 }).success).toBe(false);
    expect(recurringScheduleSchema.safeParse({ ...ok, dayOfMonth: 32 }).success).toBe(false);
    expect(recurringScheduleSchema.safeParse({ ...ok, startDate: "2026-02-30" }).success).toBe(
      false,
    );
    expect(recurringScheduleSchema.safeParse({ ...ok, endDate: "2025-12-31" }).success).toBe(false);
    expect(recurringScheduleSchema.safeParse({ ...ok, maxCount: 0 }).success).toBe(false);
  });
});
