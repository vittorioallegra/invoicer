import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { sameForm, useDirty } from "./use-dirty";

describe("sameForm", () => {
  it("ignores whitespace around text, key order and list keys", () => {
    expect(sameForm({ a: " x ", b: 1 }, { b: 1, a: "x" })).toBe(true);
    expect(
      sameForm({ lines: [{ key: "line-1", d: "a" }] }, { lines: [{ key: "line-9", d: "a" }] }),
    ).toBe(true);
  });

  it("sees a real change", () => {
    expect(sameForm({ a: "x" }, { a: "y" })).toBe(false);
    expect(sameForm({ lines: [{ d: "a" }] }, { lines: [{ d: "a" }, { d: "" }] })).toBe(false);
    expect(sameForm({ on: false }, { on: true })).toBe(false);
  });
});

describe("useDirty", () => {
  it("is clean until the form differs from the baseline", () => {
    const { result, rerender } = renderHook(({ current }) => useDirty({ name: "" }, current), {
      initialProps: { current: { name: "" } },
    });
    expect(result.current.dirty).toBe(false);
    rerender({ current: { name: "Acme" } });
    expect(result.current.dirty).toBe(true);
    rerender({ current: { name: "  " } });
    expect(result.current.dirty).toBe(false);
  });

  it("becomes clean again after markSaved", () => {
    const { result, rerender } = renderHook(({ current }) => useDirty({ name: "" }, current), {
      initialProps: { current: { name: "Acme" } },
    });
    expect(result.current.dirty).toBe(true);
    act(() => result.current.markSaved({ name: "Acme" }));
    expect(result.current.dirty).toBe(false);
    rerender({ current: { name: "Acme 2" } });
    expect(result.current.dirty).toBe(true);
  });
});
