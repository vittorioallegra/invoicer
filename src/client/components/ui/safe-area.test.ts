import { describe, expect, it } from "vitest";
import sheet from "./sheet.tsx?raw";
import toast from "./toast.tsx?raw";

// Playwright cannot emulate iOS safe-area insets, so keep the CSS that respects them pinned.
describe("safe areas on phones", () => {
  it("keeps sheets below the status bar: capped height, top inset on the side sheet", () => {
    expect(sheet).toContain("calc(100dvh-env(safe-area-inset-top)-1rem)");
    expect(sheet).toContain("pt-[calc(1rem+env(safe-area-inset-top))]");
    expect(sheet.match(/safe-area-inset-bottom/g)?.length).toBeGreaterThanOrEqual(3);
    expect(sheet).not.toContain("max-h-[90dvh]");
  });

  it("offsets the toast viewport by the top inset", () => {
    expect(toast).toContain("top-[calc(1rem+env(safe-area-inset-top))]");
  });
});
