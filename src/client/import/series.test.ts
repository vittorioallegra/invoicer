import { describe, expect, it } from "vitest";
import { missingSeries } from "./series";

describe("missingSeries", () => {
  const existing = [
    { id: "default", name: "Default", prefix: null, suffix: null, isDefault: true },
    { id: "s1", name: "FA", prefix: "FA-", suffix: null, isDefault: false },
  ];

  it("lists the series the numbers need, once, and leaves existing ones alone", () => {
    const series = missingSeries(
      ["1", "2", "3/CH", "9/CH", "A-12", "FA-3", "7 bis", "5/CH/X"],
      existing,
    );
    expect(series).toEqual([
      { name: "CH", prefix: null, suffix: "/CH" },
      { name: "A", prefix: "A-", suffix: null },
      { name: "CH X", prefix: null, suffix: "/CH/X" },
    ]);
  });

  it("does not reuse the name of an existing series", () => {
    const named = [
      ...existing,
      { id: "s2", name: "CH", prefix: "X", suffix: null, isDefault: false },
    ];
    expect(missingSeries(["3/CH"], named)).toEqual([{ name: "CH 2", prefix: null, suffix: "/CH" }]);
  });
});
