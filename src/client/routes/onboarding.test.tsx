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
  pec: {
    servers: {
      imapHost: "imaps.pec.aruba.it",
      imapPort: 993,
      smtpHost: "smtps.pec.aruba.it",
      smtpPort: 465,
    },
    preset: {
      imapHost: "imaps.pec.aruba.it",
      imapPort: 993,
      smtpHost: "smtps.pec.aruba.it",
      smtpPort: 465,
    },
    test: null,
  },
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
    expect(rows[2]?.getAttribute("href")).toBe("/settings/company");
    expect(screen.getByText("You cannot send invoices yet:")).toBeTruthy();
    expect(screen.getByText("The company details are not complete.")).toBeTruthy();
    expect(
      screen.getByText("The PEC username and password are not set on the server."),
    ).toBeTruthy();
  });

  it("leads a first-run owner with no profile to the profile form", async () => {
    respond({ "/api/onboarding": status([], ["profile_incomplete"]) });
    await renderAt("/");
    const action = await screen.findByRole("link", { name: "Complete your company details" });
    expect(action.getAttribute("href")).toBe("/settings/company");
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
  it("redirects the old /settings/profile path to the Company page", async () => {
    respond({ "/api/profile": { profile: null } });
    await renderAt("/settings/profile");
    expect(await screen.findByRole("heading", { name: "Company" })).toBeTruthy();
  });

  it("shows field errors and does not call the server until the form is valid", async () => {
    respond({ "/api/profile": { profile: null } });
    await renderAt("/settings/company");
    fireEvent.change(await screen.findByLabelText("Name or company name"), {
      target: { value: "Mario Rossi" },
    });
    fireEvent.change(screen.getByLabelText("Partita IVA"), { target: { value: "123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/11-digit partita IVA/)).toBeTruthy();
    expect(screen.getAllByText("This field is required.").length).toBeGreaterThan(0);
    // The shell's notification bell polls on its own; only the page's calls count.
    expect(mocks.api.mock.calls.filter(([path]) => path !== "/api/notifications")).toHaveLength(1);
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
    await renderAt("/settings/pec");
    const run = await screen.findByRole("button", { name: "Test connection" });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);
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
    await renderAt("/settings/pec");
    expect(await screen.findByText(/rejected the username or password/)).toBeTruthy();
    // The stored code is enough to show which stage failed.
    expect(screen.getByText("IMAP login", { exact: false }).parentElement?.textContent).toContain(
      "failed",
    );
  });

  it("links back to Settings from the sub-pages", async () => {
    respond({ "/api/features": features, "/api/settings": settings });
    await renderAt("/settings/pec");
    const heading = await screen.findByRole("heading", { level: 1 });
    const back = heading.previousElementSibling;
    expect(back?.textContent).toBe("Settings");
    expect(back?.getAttribute("href")).toBe("/settings");
  });

  it("has no invoice numbering section: the number is set on the invoice", async () => {
    respond({ "/api/features": features, "/api/settings": settings });
    await renderAt("/settings");
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    expect(screen.queryByLabelText("Next invoice number")).toBeNull();
    expect(screen.queryByText(/Invoice numbering/)).toBeNull();
    expect(mocks.api).not.toHaveBeenCalledWith("/api/settings", expect.anything());
  });

  it("disables the connection test while the credentials are not set", async () => {
    respond({
      "/api/features": { ...features, pec: { username: true, password: false } },
      "/api/settings": settings,
    });
    await renderAt("/settings/pec");
    const button = await screen.findByRole("button", { name: "Test connection" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      await screen.findByText(/Set PEC_USERNAME and PEC_PASSWORD as Worker secrets/),
    ).toBeTruthy();
  });
});
