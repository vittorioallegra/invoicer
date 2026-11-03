import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n";
import { finalizeProblems, focusField } from "./finalize-checks";

async function translator() {
  const i18n = await createI18n("en");
  return i18n.t.bind(i18n);
}

describe("finalizeProblems", () => {
  it("lists the form problems top to bottom with the field to focus", async () => {
    const t = await translator();
    const problems = finalizeProblems(t, {
      errors: {
        "lines.1.vat": "vat_required",
        "client.vatNumber": "invalid_vat_number",
        requestedNumber: "number_too_low",
        "lines.0.description": "required",
        clientId: "required",
      },
      nextNumber: 9,
      online: true,
      profileIncomplete: false,
    });
    expect(problems.map((p) => p.field)).toEqual([
      "clientId",
      "clientId",
      "requestedNumber",
      "lines.0.description",
      "lines.1.vat",
    ]);
    expect(problems[2]?.message).toContain("9 or higher");
    expect(problems[4]).toMatchObject({ label: "Line 2: VAT" });
  });

  it("adds the conditions outside the form and nothing when all is well", async () => {
    const t = await translator();
    const none = { errors: {}, nextNumber: null, online: true, profileIncomplete: false };
    expect(finalizeProblems(t, none)).toEqual([]);
    const outside = finalizeProblems(t, { ...none, online: false, profileIncomplete: true });
    expect(outside.map((p) => p.key)).toEqual(["offline", "profile"]);
    expect(outside[1]?.to).toBe("/settings/profile");
  });

  it("asks for a date not before the last issued number of the series", async () => {
    const t = await translator();
    const [problem] = finalizeProblems(t, {
      errors: {},
      nextNumber: 2,
      online: true,
      profileIncomplete: false,
      dateBeforeLast: "3 Nov 2026",
    });
    expect(problem).toMatchObject({ key: "invoiceDate", field: "invoiceDate" });
    expect(problem?.message).toContain("already issued on 3 Nov 2026");
  });
});

describe("focusField", () => {
  it("focuses the control of the marked field, else the first invalid one", () => {
    document.body.innerHTML =
      '<div data-field="lines.0.vat"><select id="a"></select></div><input id="b" aria-invalid="true">';
    focusField(document.body, "lines.0.vat");
    expect(document.activeElement?.id).toBe("a");
    focusField(document.body, "unknown.path");
    expect(document.activeElement?.id).toBe("b");
  });
});
