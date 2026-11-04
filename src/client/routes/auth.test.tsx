import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../i18n";
import { createAppRouter } from "../router";
import { generatePassword } from "./setup";

const mocks = vi.hoisted(() => ({
  session: { data: null as unknown, isPending: false, error: null as unknown, refetch: vi.fn() },
  signInEmail: vi.fn(),
  signInPasskey: vi.fn(),
  verifyTotp: vi.fn(),
  enableTwoFactor: vi.fn(),
  verifyBackupCode: vi.fn(),
  api: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: mocks.api }));

vi.mock("../lib/auth-client", () => ({
  authClient: {
    useSession: () => mocks.session,
    signIn: { email: mocks.signInEmail, passkey: mocks.signInPasskey },
    twoFactor: {
      enable: mocks.enableTwoFactor,
      verifyTotp: mocks.verifyTotp,
      verifyBackupCode: mocks.verifyBackupCode,
    },
  },
}));

const signedIn = { user: { id: "1", twoFactorEnabled: true } };

async function renderAt(path: string) {
  const i18n = await createI18n("en");
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return router;
}

beforeEach(() => {
  mocks.api.mockResolvedValue({ ownerExists: true });
  mocks.session.data = null;
  mocks.session.isPending = false;
  mocks.session.error = null;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("session gate", () => {
  it("sends an anonymous visitor to the login screen", async () => {
    const router = await renderAt("/invoices");
    await screen.findByRole("button", { name: "Sign in with passkey" });
    expect(router.state.location.pathname).toBe("/login");
  });

  it("sends an anonymous visitor to the setup screen while no owner exists", async () => {
    mocks.api.mockResolvedValue({ ownerExists: false });
    const router = await renderAt("/");
    await screen.findByRole("button", { name: /create owner account/i });
    expect(router.state.location.pathname).toBe("/setup");
    expect(mocks.api).toHaveBeenCalledWith("/api/setup/status");
  });

  it("falls back to the login screen when the setup status cannot be read", async () => {
    mocks.api.mockRejectedValue(new Error("offline"));
    const router = await renderAt("/invoices");
    await screen.findByRole("button", { name: "Sign in with passkey" });
    expect(router.state.location.pathname).toBe("/login");
  });

  it("shows the app for a signed-in user", async () => {
    mocks.session.data = signedIn;
    const router = await renderAt("/invoices");
    await screen.findByRole("heading", { name: "Invoices" });
    expect(router.state.location.pathname).toBe("/invoices");
  });
});

describe("setup screen", () => {
  it("continues with the authenticator step for a signed-in owner even if the cached status is stale", async () => {
    // Right after "Create owner account" the session exists while the status query still says
    // that no owner exists; the form must not come back.
    mocks.api.mockResolvedValue({ ownerExists: false });
    mocks.session.data = { user: { id: "1", twoFactorEnabled: false } };
    await renderAt("/setup");
    await screen.findByRole("heading", { name: "Authenticator app" });
    expect(screen.queryByRole("button", { name: "Create owner account" })).toBeNull();
  });

  it("marks the account fields for password managers and keeps the setup token out of them", async () => {
    mocks.api.mockResolvedValue({ ownerExists: false });
    await renderAt("/setup");
    const token = (await screen.findByLabelText("Setup token")) as HTMLInputElement;
    expect(token.type).toBe("text");
    expect(token.autocomplete).toBe("off");
    const email = screen.getByLabelText("Email") as HTMLInputElement;
    expect(email.autocomplete).toBe("username");
    expect(email.name).toBe("email");
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.autocomplete).toBe("new-password");
    expect(password.getAttribute("passwordrules")).toContain("minlength");
    expect(screen.getByLabelText("Setup token").closest("form")).toBe(password.closest("form"));
  });

  it("shows the otpauth URI as an SVG QR code on the authenticator step", async () => {
    mocks.api.mockResolvedValue({ ownerExists: false });
    mocks.session.data = { user: { id: "1", twoFactorEnabled: false } };
    mocks.enableTwoFactor.mockResolvedValue({
      data: {
        method: "totp",
        totpURI: "otpauth://totp/Invoicer:owner?secret=JBSWY3DPEHPK3PXP&issuer=Invoicer",
        backupCodes: ["a"],
      },
      error: null,
    });
    await renderAt("/setup");
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /start|set up|continue/i }));
    const qr = await screen.findByRole("img", { name: /QR code/i });
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(qr.querySelector("path")).not.toBeNull();
  });
});

describe("login screen", () => {
  it("signs in with a passkey and goes to the app", async () => {
    mocks.signInPasskey.mockImplementation(async () => {
      mocks.session.data = signedIn;
      return { data: {}, error: null };
    });
    const router = await renderAt("/login");
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with passkey" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("asks for a TOTP after the password and shows an error for a wrong code", async () => {
    mocks.signInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    mocks.verifyTotp.mockResolvedValue({ data: null, error: { status: 401 } });
    const router = await renderAt("/login");
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@b.it" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const code = await screen.findByLabelText("Authentication code");
    expect(mocks.signInEmail).toHaveBeenCalledWith({
      email: "a@b.it",
      password: "long-password-1",
    });
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not valid");
    expect(router.state.location.pathname).toBe("/login");

    mocks.verifyTotp.mockImplementation(async () => {
      mocks.session.data = signedIn;
      return { data: {}, error: null };
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("explains a rate limit", async () => {
    mocks.signInEmail.mockResolvedValue({ data: null, error: { status: 429 } });
    await renderAt("/login");
    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "a@b.it" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "long-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts");
  });
});

describe("generated password", () => {
  it("is long, random and URL-safe", () => {
    const a = generatePassword();
    expect(a).toHaveLength(24);
    expect(a).toMatch(/^[A-Za-z0-9]+$/);
    expect(generatePassword()).not.toBe(a);
  });
});
