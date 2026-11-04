/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import shell from "./app-shell.tsx?raw";

const css = readFileSync(`${process.cwd()}/src/client/styles.css`, "utf8");

// iOS standalone PWA first paint: dvh sizing and each safe-area inset applied exactly once.
describe("app shell layout", () => {
  it("sizes with dvh, never vh", () => {
    expect(shell).toContain("min-h-dvh");
    expect(shell).not.toMatch(/h-screen|min-h-screen|\b\d*vh\b/);
    expect(css).toContain("100dvh");
  });

  it("applies the top inset once, in a single spacer", () => {
    expect(shell.match(/safe-area-inset-top/g)).toHaveLength(1);
  });

  it("applies the bottom inset once on the tab bar and once in the content padding", () => {
    expect(shell.match(/pb-\[env\(safe-area-inset-bottom\)\]/g)).toHaveLength(1);
    expect(shell.match(/safe-area-inset-bottom/g)).toHaveLength(2);
  });

  it("paints the page colour on the root element", () => {
    expect(css).toMatch(/html\s*{[^}]*background: var\(--background\)/);
  });
});
