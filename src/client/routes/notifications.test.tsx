import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_TYPES } from "../../shared/notifications";
import { createI18n } from "../i18n";
import type { NotificationItem, PushState } from "../lib/notifications-api";
import { createAppRouter } from "../router";

const mocks = vi.hoisted(() => ({ api: vi.fn(), apiFile: vi.fn() }));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "1", twoFactorEnabled: true } },
      isPending: false,
      error: null,
      refetch: vi.fn(),
    }),
  },
}));
vi.mock("../lib/api", () => ({ api: mocks.api, apiFile: mocks.apiFile }));

const PARAMS: Record<string, Record<string, string | number>> = {
  invoice_delivered: { number: "5/2026" },
  invoice_not_delivered: { number: "5/2026" },
  invoice_rejected: { number: "5/2026" },
  pec_send_error: { number: "5/2026" },
  received_invoice: { file: "IT1_00001.xml" },
  invoice_due: { client: "Acme", date: "2026-06-10", day: "2026-06-10" },
  invoice_overdue: { number: "5/2026", client: "Acme", dueDate: "2026-06-09" },
  mailbox_login_failed: {},
  courtesy_email_ask: { number: "5/2026", client: "Acme S.r.l." },
  courtesy_email_failed: { number: "5/2026", recipient: "billing@acme.test" },
  poll_failed: { code: "login_failed" },
  message_oversize: { size: 3000000 },
  message_unreadable: {},
};

const item = (type: string, over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: `n-${type}`,
  type,
  params: PARAMS[type] ?? {},
  invoiceId: null,
  readAt: null,
  createdAt: 1_762_000_000_000,
  ...over,
});

let list: NotificationItem[] = [];
let push: PushState = { configured: true, publicKey: "key", disabledTypes: [], devices: 0 };

beforeEach(() => {
  list = [];
  push = { configured: true, publicKey: "key", disabledTypes: [], devices: 0 };
  mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/api/notifications") {
      return { unread: list.filter((n) => n.readAt === null).length, notifications: list };
    }
    if (path === "/api/push" && !init) return push;
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  mocks.api.mockReset();
});

async function renderAt(path: string, lng: "en" | "it" = "en") {
  const i18n = await createI18n(lng);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("notification bell on phones", () => {
  it("ends the page title row with the unread count in its name", async () => {
    list = [item("poll_failed"), item("received_invoice")];
    await renderAt("/clients");
    const title = await screen.findByRole("heading", { level: 1, name: "Clients" });
    const row = title.parentElement?.parentElement as HTMLElement;
    await waitFor(() =>
      expect(row.querySelector('a[href="/notifications"]')?.getAttribute("aria-label")).toContain(
        "2",
      ),
    );
    const bell = row.querySelector('a[href="/notifications"]') as HTMLElement;
    expect(bell.className).toContain("md:hidden");
    expect(row.lastElementChild).toBe(bell);
  });
});

describe("notification bell placement", () => {
  it.each(["/notifications", "/settings/company", "/settings/notifications"])(
    "is not shown on %s",
    async (path) => {
      await renderAt(path);
      await screen.findByRole("heading", { level: 1 });
      expect(document.querySelector('main a[href="/notifications"]')).toBeNull();
    },
  );

  it("keeps the settings icon at the end of the notifications title row", async () => {
    await renderAt("/notifications");
    const title = await screen.findByRole("heading", { level: 1, name: "Notifications" });
    const row = title.parentElement?.parentElement as HTMLElement;
    const settings = row.querySelector('a[href="/settings/notifications"]') as HTMLElement;
    expect(settings).toBeTruthy();
    expect(row.contains(settings) && row.lastElementChild?.contains(settings)).toBe(true);
  });
});

describe("notification list", () => {
  it("shows an empty state", async () => {
    await renderAt("/notifications");
    expect(await screen.findByText("No notifications yet")).toBeTruthy();
  });

  it.each(["en", "it"] as const)("renders every notification type in %s", async (lng) => {
    list = NOTIFICATION_TYPES.map((type) =>
      item(type, type === "courtesy_email_ask" ? { invoiceId: "inv-1" } : {}),
    );
    await renderAt("/notifications", lng);
    await screen.findAllByText("5/2026", { exact: false });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/notifications\.[a-z_]+\.(title|body)/);
    expect(text).not.toContain("{{");
    expect(screen.getAllByRole("listitem")).toHaveLength(NOTIFICATION_TYPES.length);
    expect(text).toContain("5/2026");
    expect(text).toContain("Acme S.r.l.");
    expect(text).toContain("billing@acme.test");
  });

  // Regression: dates in a notification were shown as stored (2026-06-09), unlike every other date.
  it.each([
    ["en", "9 Jun 2026"],
    ["it", "9 giu 2026"],
  ] as const)(
    "writes the dates of a notification like the rest of the app in %s",
    async (lng, shown) => {
      list = [item("invoice_overdue")];
      await renderAt("/notifications", lng);
      await screen.findAllByText("5/2026", { exact: false });
      const text = document.body.textContent ?? "";
      expect(text).toContain(shown);
      expect(text).not.toContain("2026-06-09");
    },
  );

  it("links the courtesy email offer to its invoice, where the Review and send card is", async () => {
    list = [
      item("courtesy_email_ask", { invoiceId: "inv-7" }),
      item("courtesy_email_failed", { invoiceId: "inv-8" }),
      item("received_invoice"),
      item("poll_failed"),
    ];
    await renderAt("/notifications");
    await screen.findByText(/Send the courtesy copy of invoice/);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/invoices/inv-7");
    expect(hrefs).toContain("/invoices/inv-8");
    expect(hrefs).toContain("/received");
    // The mailbox problem has no page of its own to open.
    expect(screen.getByText(/The PEC mailbox could not be read/).closest("a")).toBeNull();
  });

  it("marks one notification read when opened and all with the button", async () => {
    list = [item("courtesy_email_ask", { invoiceId: "inv-7" }), item("poll_failed")];
    await renderAt("/notifications");
    fireEvent.click(await screen.findByRole("button", { name: "Mark all as read" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/notifications/read",
        expect.objectContaining({ method: "POST", body: "{}" }),
      ),
    );
  });
});

describe("notification settings", () => {
  it("lists every type with its push switch, on unless turned off", async () => {
    push.disabledTypes = ["invoice_due"];
    await renderAt("/settings/notifications");
    expect(await screen.findAllByRole("checkbox")).toHaveLength(NOTIFICATION_TYPES.length);
    const due = screen.getByRole("checkbox", { name: "Invoice to send" }) as HTMLInputElement;
    await waitFor(() => expect(due.checked).toBe(false));
    expect(
      (screen.getByRole("checkbox", { name: "Invoice delivered" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("saves the switched-off types", async () => {
    await renderAt("/settings/notifications");
    const box = await screen.findByRole("checkbox", { name: "Mailbox check failed" });
    await waitFor(() => expect((box as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(box);
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/push/types",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ disabled: ["poll_failed"] }),
        }),
      ),
    );
  });

  it("explains that push needs the Home Screen app where the browser has no push", async () => {
    await renderAt("/settings/notifications");
    expect(await screen.findByText(/cannot receive push notifications/)).toBeTruthy();
  });

  it("says push is off while the VAPID keys are missing", async () => {
    push = { configured: false, publicKey: null, disabledTypes: [], devices: 0 };
    await renderAt("/settings/notifications");
    expect(await screen.findByText(/Push notifications are off: set the VAPID keys/)).toBeTruthy();
  });
});
