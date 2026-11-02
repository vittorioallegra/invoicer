import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChecklistItemId, OnboardingStatus } from "../../shared/onboarding";
import { createI18n } from "../i18n";
import { createAppRouter } from "../router";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

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
vi.mock("../lib/api", () => ({ api: mocks.api }));

const ITEMS: ChecklistItemId[] = [
  "passkey",
  "fallback_login",
  "profile",
  "pec",
  "ade_guide",
  "email",
];

function status(doneIds: ChecklistItemId[], reasons: string[] = []): OnboardingStatus {
  return {
    checklist: ITEMS.map((id) => ({ id, done: doneIds.includes(id) })),
    complete: doneIds.length === ITEMS.length,
    send: { ready: reasons.length === 0, reasons: reasons as never },
    pecTest: null,
  };
}

const settings = {
  email: {
    senderName: null,
    senderAddress: null,
    replyTo: null,
    bcc: null,
    mode: "ask",
    defaultSenderName: null,
    configured: false,
  },
  invoiceNumber: { year: 2026, next: 1, minimum: 5 },
  pec: { imap: "imaps.pec.aruba.it:993", smtp: "smtps.pec.aruba.it:465", test: null },
  adeGuideDone: false,
};

/** Home also loads the invoice lists; they are empty unless a test says otherwise. */
const EMPTY_LISTS = {
  "/api/invoices?scope=to_issue": { invoices: [] },
  "/api/invoices?scope=issued": { invoices: [] },
  "/api/invoices?scope=reserved": { invoices: [] },
};

function respond(overrides: Record<string, unknown>) {
  const routes = { ...EMPTY_LISTS, ...overrides };
  mocks.api.mockImplementation(async (path: string) => {
    if (!(path in routes)) throw new Error(`unexpected ${path}`);
    const value = routes[path as keyof typeof routes];
    if (value instanceof Error) throw value;
    return value;
  });
}

async function renderAt(path: string) {
  const i18n = await createI18n("en");
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

beforeEach(() => {
  mocks.api.mockReset();
});
afterEach(cleanup);

describe("Home", () => {
  it("shows the checklist with each item done or pending, and why sending is blocked", async () => {
    respond({
      "/api/onboarding": status(
        ["passkey", "fallback_login"],
        ["profile_incomplete", "pec_credentials_missing"],
      ),
    });
    await renderAt("/");
    const list = await screen.findByRole("region", { name: "Finish setting up" });
    expect(within(list).getByText("2 of 6 done")).toBeTruthy();
    const rows = within(list).getAllByRole("link");
    expect(rows).toHaveLength(6);
    expect(within(rows[0] as HTMLElement).getByText("Done")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("To do")).toBeTruthy();
    expect(rows[2]?.getAttribute("href")).toBe("/settings/profile");
    expect(screen.getByText("You cannot send invoices yet:")).toBeTruthy();
    expect(screen.getByText("The issuer profile is not complete.")).toBeTruthy();
    expect(
      screen.getByText("The PEC username and password are not set on the server."),
    ).toBeTruthy();
  });

  it("leads a first-run owner with no profile to the profile form", async () => {
    respond({ "/api/onboarding": status([], ["profile_incomplete"]) });
    await renderAt("/");
    const action = await screen.findByRole("link", { name: "Complete your profile" });
    expect(action.getAttribute("href")).toBe("/settings/profile");
  });

  it("hides the checklist and offers a new invoice once everything is done", async () => {
    respond({ "/api/onboarding": status(ITEMS) });
    await renderAt("/");
    const action = await screen.findAllByRole("link", { name: "New invoice" });
    expect(action.length).toBeGreaterThan(0);
    expect(screen.queryByRole("region", { name: "Finish setting up" })).toBeNull();
    expect(screen.queryByText("You cannot send invoices yet:")).toBeNull();
  });
});

describe("Profile form", () => {
  it("shows field errors and does not call the server until the form is valid", async () => {
    respond({ "/api/profile": { profile: null } });
    await renderAt("/settings/profile");
    fireEvent.change(await screen.findByLabelText("Name or company name"), {
      target: { value: "Mario Rossi" },
    });
    fireEvent.change(screen.getByLabelText("Partita IVA"), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText(/11-digit partita IVA/)).toBeTruthy();
    expect(screen.getAllByText("This field is required.").length).toBeGreaterThan(0);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});

describe("Settings", () => {
  const features = { email: true, push: true, pec: { username: true, password: true } };

  it("runs the PEC connection test through the API", async () => {
    respond({ "/api/features": features, "/api/settings": settings });
    mocks.api.mockImplementation(async (path: string) => {
      if (path === "/api/features") return features;
      if (path === "/api/settings") return settings;
      if (path === "/api/settings/pec-test") return { ok: false, error: "login_failed", at: 1 };
      throw new Error(`unexpected ${path}`);
    });
    await renderAt("/settings");
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith("/api/settings/pec-test", { method: "POST" }),
    );
  });

  it("shows the stored result of the last connection test", async () => {
    respond({
      "/api/features": features,
      "/api/settings": {
        ...settings,
        pec: { ...settings.pec, test: { ok: false, at: 1, error: "login_failed" } },
      },
    });
    await renderAt("/settings");
    expect(await screen.findByText(/rejected the username or password/)).toBeTruthy();
  });

  it("refuses a next number below the ones already used, before calling the server", async () => {
    respond({ "/api/features": features, "/api/settings": settings });
    await renderAt("/settings");
    const input = await screen.findByLabelText("Next invoice number");
    fireEvent.change(input, { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save number" }));
    expect(await screen.findByText(/lowest allowed number is 5/)).toBeTruthy();
    expect(mocks.api).not.toHaveBeenCalledWith("/api/settings/invoice-number", expect.anything());
  });

  it("disables the connection test while the credentials are not set", async () => {
    respond({
      "/api/features": { ...features, pec: { username: true, password: false } },
      "/api/settings": settings,
    });
    await renderAt("/settings");
    const button = await screen.findByRole("button", { name: "Test connection" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Set PEC_USERNAME and PEC_PASSWORD/)).toBeTruthy();
  });
});
