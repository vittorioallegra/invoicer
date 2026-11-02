import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import enCommon from "../../../locales/en/common.json";
import itCommon from "../../../locales/it/common.json";
import { INVOICE_STATES, PAYMENT_STATES } from "../../shared/invoice-state";
import { StatusBadge } from "../components/ui/status-badge";
import { STATUS_MAP } from "../lib/status";
import { createI18n } from "./index";

afterEach(cleanup);

describe("i18n render", () => {
  it("renders the English base labels", async () => {
    const i18n = await createI18n("en");
    render(
      <I18nextProvider i18n={i18n}>
        <StatusBadge status="rejected_expired" />
      </I18nextProvider>,
    );
    expect(screen.getByText("Rejected, expired")).toBeTruthy();
  });

  it("renders the Italian labels", async () => {
    const i18n = await createI18n("it");
    render(
      <I18nextProvider i18n={i18n}>
        <StatusBadge status="delivered" />
      </I18nextProvider>,
    );
    expect(screen.getByText("Consegnata")).toBeTruthy();
  });
});

describe("locale files and status map", () => {
  it("has the same keys in en and it", () => {
    const keys = (value: object, prefix = ""): string[] =>
      Object.entries(value).flatMap(([key, child]) =>
        typeof child === "object" && child !== null
          ? keys(child, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      );
    expect(keys(itCommon).sort()).toEqual(keys(enCommon).sort());
  });

  it("maps every invoice and payment state to a label, tone and icon", () => {
    for (const state of [...INVOICE_STATES, ...PAYMENT_STATES]) {
      expect(STATUS_MAP[state].icon).toBeDefined();
      expect(enCommon.status[state]).toBeTruthy();
    }
  });
});
