import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatDiagnostics, ROWS, takeSnapshot, ViewportDiagnostics } from "./viewport-diagnostics";

afterEach(cleanup);

describe("ViewportDiagnostics", () => {
  it("renders the expected rows and the copy button", () => {
    render(<ViewportDiagnostics />);
    for (const label of [
      "navigator.standalone",
      "probe height 100dvh",
      "safe-area-inset-bottom",
      "tab-bar rect (top/bottom/height)",
      "html background-color",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Copy diagnostics" })).toBeTruthy();
    expect(screen.getByText(/updates: \d+/)).toBeTruthy();
  });

  it("formats every row as text", () => {
    const snap = takeSnapshot();
    const text = formatDiagnostics(snap, snap, "meta");
    for (const { label } of ROWS) expect(text).toContain(label);
  });
});
