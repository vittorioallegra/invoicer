import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_INVOICE_DATA, type InvoiceRecord } from "../../shared/invoice";
import { createI18n } from "../i18n";
import { CourtesyEmail, canSendCourtesyEmail } from "./courtesy-email";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", () => ({ api: mocks.api }));

const record: InvoiceRecord = {
  id: "i1",
  source: "app",
  documentType: "TD01",
  state: "delivered",
  paymentFlag: "unpaid",
  paidDate: null,
  clientId: "c1",
  clientName: "Acme",
  number: "7",
  seriesId: "default",
  requestedNumber: null,
  year: 2026,
  issueDate: "2026-03-01",
  invoiceDate: null,
  dueDate: null,
  currency: "EUR",
  totalCents: 12200,
  linkedInvoiceId: null,
  linked: null,
  reissuesInvoiceId: null,
  lines: [],
  data: EMPTY_INVOICE_DATA,
  editorForm: null,
  numberReserved: false,
  releasable: false,
  rejection: null,
  reissuedById: null,
};

const draft = {
  to: "billing@acme.test",
  subject: "Invoice 7 from Mario",
  body: "Hello Acme",
  from: '"Mario" <no-reply@example.test>',
  replyTo: "mario@example.test",
  bcc: null,
  attachments: [{ filename: "invoice-7-acme.pdf", size: 10 }],
};

function Host({ initialOpen }: { initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open-sheet
      </button>
      <CourtesyEmail record={record} open={open} onOpenChange={setOpen} />
    </>
  );
}

async function show(overview: object, initialOpen = false) {
  mocks.api.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (init?.method === "POST")
      return path.endsWith("/skip") ? null : { id: "l1", messageId: "m1" };
    return overview;
  });
  const i18n = await createI18n("en");
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Host initialOpen={initialOpen} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const posts = () =>
  mocks.api.mock.calls.filter(
    ([, init]) => (init as { method?: string } | undefined)?.method === "POST",
  );

describe("Courtesy email", () => {
  it("is offered only for issued app invoices", () => {
    expect(canSendCourtesyEmail(record)).toBe(true);
    expect(canSendCourtesyEmail({ ...record, state: "draft" })).toBe(false);
    expect(canSendCourtesyEmail({ ...record, source: "imported" })).toBe(false);
    expect(canSendCourtesyEmail({ ...record, number: null })).toBe(false);
  });

  it("shows the history timeline with the way each email was sent", async () => {
    await show({
      draft,
      ask: null,
      ready: true,
      log: [
        {
          id: "l2",
          attempt: 1,
          trigger: "manual",
          recipient: "a@acme.test",
          subject: "s",
          messageId: null,
          status: "failed",
          error: "resend_422_validation_error",
          at: 2000,
        },
        {
          id: "l1",
          attempt: 1,
          trigger: "automatic",
          recipient: "b@acme.test",
          subject: "s",
          messageId: "m",
          status: "sent",
          error: null,
          at: 1000,
        },
      ],
    });
    expect(await screen.findByText("Sent to b@acme.test")).toBeTruthy();
    expect(
      screen.getByText(/Not sent to a@acme.test \(resend_422_validation_error\)/),
    ).toBeTruthy();
    expect(screen.getByText(/Automatic/)).toBeTruthy();
    expect(screen.getByText(/Sent by hand/)).toBeTruthy();
  });

  it("answers an offer: Review opens the editable preview and Send posts the edited text", async () => {
    await show({ draft, ask: { id: "ob1", attempt: 1 }, ready: true, log: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Review and send" }));
    const subject = (await screen.findByLabelText("Subject")) as HTMLInputElement;
    expect(subject.value).toBe("Invoice 7 from Mario");
    expect(screen.getByText("invoice-7-acme.pdf")).toBeTruthy();
    fireEvent.change(subject, { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [path, init] = posts()[0] as [string, { body: string }];
    expect(path).toBe("/api/invoices/i1/courtesy-email");
    expect(JSON.parse(init.body)).toMatchObject({
      to: "billing@acme.test",
      subject: "Edited",
      body: "Hello Acme",
      outboxId: "ob1",
    });
  });

  it("Skip answers the offer without sending", async () => {
    await show({ draft, ask: { id: "ob1", attempt: 1 }, ready: true, log: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [path, init] = posts()[0] as [string, { body: string }];
    expect(path).toBe("/api/invoices/i1/courtesy-email/skip");
    expect(JSON.parse(init.body)).toEqual({ outboxId: "ob1" });
  });

  it("sends by hand without an outbox id and blocks Send while the recipient is not an address", async () => {
    await show({ draft: { ...draft, to: "" }, ask: null, ready: true, log: [] }, true);
    const send = await screen.findByRole("button", { name: "Send email" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "new@acme.test" } });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const body = JSON.parse((posts()[0] as [string, { body: string }])[1].body);
    expect(body.to).toBe("new@acme.test");
    expect(body.outboxId).toBeUndefined();
    expect(typeof body.requestId).toBe("string");
  });

  it("warns when sending is not set up and keeps Send disabled", async () => {
    await show({ draft, ask: null, ready: false, log: [] }, true);
    expect(await screen.findByText(/Courtesy email is not set up/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send email" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
