import { describe, expect, it } from "vitest";
import { romeDateTime, shouldRunDaily } from "./cron";

const at = (iso: string) => new Date(iso);

describe("romeDateTime", () => {
  it("uses UTC+1 in winter and UTC+2 in summer", () => {
    expect(romeDateTime(at("2026-01-15T07:59:00Z"))).toEqual({ date: "2026-01-15", hour: 8 });
    expect(romeDateTime(at("2026-07-15T06:59:00Z"))).toEqual({ date: "2026-07-15", hour: 8 });
  });

  it("rolls the Rome date over at Rome midnight, not UTC midnight", () => {
    expect(romeDateTime(at("2026-01-15T22:59:00Z")).date).toBe("2026-01-15");
    expect(romeDateTime(at("2026-01-15T23:00:00Z"))).toEqual({ date: "2026-01-16", hour: 0 });
    expect(romeDateTime(at("2026-07-15T22:00:00Z"))).toEqual({ date: "2026-07-16", hour: 0 });
  });
});

describe("shouldRunDaily", () => {
  it("does not run before 09:00 Rome", () => {
    expect(shouldRunDaily(at("2026-01-15T07:50:00Z"), "2026-01-14")).toBe(false);
    expect(shouldRunDaily(at("2026-07-15T06:50:00Z"), "2026-07-14")).toBe(false);
  });

  it("runs from 09:00 Rome (winter 08:00Z, summer 07:00Z)", () => {
    expect(shouldRunDaily(at("2026-01-15T08:00:00Z"), "2026-01-14")).toBe(true);
    expect(shouldRunDaily(at("2026-07-15T07:00:00Z"), "2026-07-14")).toBe(true);
  });

  it("runs on a first ever tick after 09:00", () => {
    expect(shouldRunDaily(at("2026-01-15T10:00:00Z"), null)).toBe(true);
  });

  it("does not run again once today's Rome date has completed", () => {
    expect(shouldRunDaily(at("2026-01-15T08:10:00Z"), "2026-01-15")).toBe(false);
    expect(shouldRunDaily(at("2026-01-15T22:50:00Z"), "2026-01-15")).toBe(false);
  });

  it("catches up after missed ticks, later the same day or after several days", () => {
    expect(shouldRunDaily(at("2026-01-15T16:30:00Z"), "2026-01-14")).toBe(true);
    expect(shouldRunDaily(at("2026-01-15T08:00:00Z"), "2026-01-10")).toBe(true);
  });

  it("treats Rome midnight, not UTC midnight, as the day boundary", () => {
    // 23:30Z on the 15th is 00:30 Rome on the 16th: too early, and the 15th run does not count.
    expect(shouldRunDaily(at("2026-01-15T23:30:00Z"), "2026-01-15")).toBe(false);
    // 22:30Z on the 15th is 23:30 Rome on the 15th: the 15th is already done, no second run.
    expect(shouldRunDaily(at("2026-01-15T22:30:00Z"), "2026-01-15")).toBe(false);
    // Next Rome day 09:00 runs again.
    expect(shouldRunDaily(at("2026-01-16T08:00:00Z"), "2026-01-15")).toBe(true);
    // Summer: 22:30Z on the 15th is 00:30 Rome on the 16th (still before 09:00).
    expect(shouldRunDaily(at("2026-07-15T22:30:00Z"), "2026-07-15")).toBe(false);
  });

  it("follows the DST switch days", () => {
    // 2026-03-29: clocks go forward, 09:00 Rome is 07:00Z.
    expect(shouldRunDaily(at("2026-03-29T06:50:00Z"), "2026-03-28")).toBe(false);
    expect(shouldRunDaily(at("2026-03-29T07:00:00Z"), "2026-03-28")).toBe(true);
    // 2026-10-25: clocks go back, 09:00 Rome is 08:00Z.
    expect(shouldRunDaily(at("2026-10-25T07:50:00Z"), "2026-10-24")).toBe(false);
    expect(shouldRunDaily(at("2026-10-25T08:00:00Z"), "2026-10-24")).toBe(true);
  });
});
