import { describe, expect, it } from "vitest";
import { type CourtesyEmailParams, renderCourtesyEmail } from "./courtesy-email";

const base: CourtesyEmailParams = {
  client: "Acme S.r.l.",
  sender: "Mario Rossi",
  number: "CH-3",
  date: "2026-03-10",
  dueDate: "2026-04-09",
  totalCents: 122000,
  currency: "EUR",
  creditNote: false,
  notDelivered: false,
};

describe("renderCourtesyEmail", () => {
  it("renders an English invoice with the due date", () => {
    const { subject, body } = renderCourtesyEmail("en", base);
    expect(subject).toBe("Invoice CH-3 from Mario Rossi");
    expect(body).toContain("Hello Acme S.r.l.,");
    expect(body).toContain("invoice CH-3 dated");
    expect(body).toContain("Payment is due by");
    expect(body).not.toContain("{{");
  });

  it("renders Italian and leaves out the due line when there is no due date", () => {
    const { subject, body } = renderCourtesyEmail("it", { ...base, dueDate: null });
    expect(subject).toBe("Fattura CH-3 di Mario Rossi");
    expect(body).toContain("Buongiorno Acme S.r.l.,");
    expect(body).not.toContain("pagamento");
    expect(body).not.toContain("{{");
  });

  it("uses the credit note wording and no due line", () => {
    const { subject, body } = renderCourtesyEmail("en", { ...base, creditNote: true });
    expect(subject).toBe("Credit note CH-3 from Mario Rossi");
    expect(body).toContain("credit note CH-3");
    expect(body).not.toContain("Payment is due");
  });

  it("points the client to the AdE area when the SdI could not deliver", () => {
    expect(renderCourtesyEmail("en", { ...base, notDelivered: true }).body).toContain(
      "Fatture e Corrispettivi",
    );
    expect(renderCourtesyEmail("en", base).body).not.toContain("Fatture e Corrispettivi");
  });
});
