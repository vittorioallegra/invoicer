/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import shell from "./app-shell.tsx?raw";

const router = readFileSync(`${process.cwd()}/src/client/router.tsx`, "utf8");
const css = readFileSync(`${process.cwd()}/src/client/styles.css`, "utf8");

// iOS standalone PWA first paint: dvh sizing and each safe-area inset applied exactly once.
describe("app shell layout", () => {
  it("sizes with dvh, never vh", () => {
    expect(shell).toContain("h-dvh");
    expect(shell).not.toMatch(/h-screen|min-h-screen|\b\d*vh\b/);
    expect(css).toContain("100dvh");
  });

  it("pins the shell root to the layout viewport with fixed inset-0", () => {
    expect(shell).toMatch(/data-testid="app-shell-root"[\s\S]*?fixed inset-0/);
  });

  it("scrolls in an inner container, not the document", () => {
    expect(shell).toMatch(
      /id={SCROLL_CONTAINER_ID}[\s\S]*?overflow-y-auto[\s\S]*?overscroll-contain/,
    );
    expect(shell).toContain("-webkit-overflow-scrolling:touch");
    expect(css).toMatch(/html\s*{[^}]*overflow: hidden/);
    expect(css).toMatch(/body\s*{[^}]*overflow: hidden/);
  });

  it("resets the inner scroll container on navigation", () => {
    expect(router).toContain("scrollRestoration: true");
    expect(router).toContain('"#app-scroll"');
    expect(shell).toContain('SCROLL_CONTAINER_ID = "app-scroll"');
  });

  it("applies the top inset once, in a single spacer", () => {
    expect(shell.match(/safe-area-inset-top/g)).toHaveLength(1);
  });

  it("applies the bottom inset once on the tab bar and once in the content padding", () => {
    expect(shell.match(/pb-\[env\(safe-area-inset-bottom\)\]/g)).toHaveLength(1);
    expect(shell.match(/safe-area-inset-bottom/g)).toHaveLength(3);
  });

  it("paints the page colour on the root element", () => {
    expect(css).toMatch(/html\s*{[^}]*background: var\(--background\)/);
  });
});
