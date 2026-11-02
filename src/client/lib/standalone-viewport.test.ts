import { describe, expect, it, vi } from "vitest";
import { fixStandaloneViewport } from "./standalone-viewport";

function fakeWindow(opts: { standalone: boolean; innerHeight: number; outerHeight: number }) {
  const style = { minHeight: "" };
  const scrolls: number[] = [];
  let frame: (() => void) | undefined;
  const win = {
    matchMedia: () => ({ matches: opts.standalone }),
    innerHeight: opts.innerHeight,
    outerHeight: opts.outerHeight,
    document: { documentElement: { style } },
    scrollTo: (_x: number, y: number) => scrolls.push(y),
    requestAnimationFrame: vi.fn((cb: () => void) => {
      frame = cb;
      return 1;
    }),
  } as unknown as Window;
  return { win, style, scrolls, runFrame: () => frame?.() };
}

describe("fixStandaloneViewport", () => {
  it("nudges the scroll when a standalone app starts with a short viewport", () => {
    const f = fakeWindow({ standalone: true, innerHeight: 812, outerHeight: 874 });
    fixStandaloneViewport(f.win);
    expect(f.style.minHeight).toBe("875px");
    expect(f.scrolls).toEqual([1]);
    f.runFrame();
    expect(f.scrolls).toEqual([1, 0]);
    expect(f.style.minHeight).toBe("");
  });

  it("does nothing when the viewport already fills the window", () => {
    const f = fakeWindow({ standalone: true, innerHeight: 874, outerHeight: 874 });
    fixStandaloneViewport(f.win);
    expect(f.scrolls).toEqual([]);
  });

  it("does nothing in a normal browser tab", () => {
    const f = fakeWindow({ standalone: false, innerHeight: 700, outerHeight: 874 });
    fixStandaloneViewport(f.win);
    expect(f.scrolls).toEqual([]);
  });
});
