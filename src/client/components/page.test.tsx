import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Page } from "./page";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: unknown }) => <a href="/x">{children as never}</a>,
}));
vi.mock("./notifications-link", () => ({ NotificationsLink: () => null }));

afterEach(cleanup);

describe("Page", () => {
  it("puts actions in the title row and chips under the subtitle", () => {
    render(
      <Page
        title="Acme Srl"
        subtitle="No. 1/2026 · 1 Jan 2026"
        chips={<span>Unpaid</span>}
        actions={<button type="button">More actions</button>}
        aside={<button type="button">Finalize</button>}
        bell={false}
      >
        <p>body</p>
      </Page>,
    );
    const title = screen.getByRole("heading", { level: 1 });
    const column = title.parentElement as HTMLElement;
    const row = column.parentElement as HTMLElement;
    expect(row.contains(screen.getByRole("button", { name: "More actions" }))).toBe(true);
    expect(column.contains(screen.getByRole("button", { name: "More actions" }))).toBe(false);
    expect(column.contains(screen.getByText("Unpaid"))).toBe(true);
    const subtitle = screen.getByText("No. 1/2026 · 1 Jan 2026");
    expect(subtitle.compareDocumentPosition(screen.getByText("Unpaid"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // The actions never wrap under the title; the aside does on phones.
    expect(screen.getByRole("button", { name: "More actions" }).parentElement?.className).toContain(
      "shrink-0",
    );
    expect(screen.getByRole("button", { name: "Finalize" }).parentElement?.className).toContain(
      "w-full",
    );
  });
});
