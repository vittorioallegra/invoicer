import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { makeError } from "../problem";
import { safeEqual } from "./gate";
import { readJson, writeJson } from "./util";

export const SANDBOX_BASE = "https://test.sdi.openapi.it";

const MAX_BODY_CHARS = 3000;

/** Minimal FatturaPA 1.2 sample (TD01, one 22 % line), modelled on the SDI OAS example. */
export function sampleInvoiceXml(opts: {
  fiscalId: string;
  recipientCode: string;
  progressive: string;
  number: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>${opts.fiscalId}</IdCodice></IdTrasmittente>
      <ProgressivoInvio>${opts.progressive}</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>${opts.recipientCode}</CodiceDestinatario>
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>${opts.fiscalId}</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Spike Test Srl</Denominazione></Anagrafica>
        <RegimeFiscale>RF01</RegimeFiscale>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via di Qua, 1</Indirizzo><CAP>20145</CAP><Comune>Milano</Comune><Provincia>MI</Provincia><Nazione>IT</Nazione></Sede>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>09876543211</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Customer Spa</Denominazione></Anagrafica>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via di La, 2</Indirizzo><CAP>20145</CAP><Comune>Milano</Comune><Provincia>MI</Provincia><Nazione>IT</Nazione></Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-11-02</Data><Numero>${opts.number}</Numero></DatiGeneraliDocumento></DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Spike service</Descrizione><PrezzoUnitario>10.00</PrezzoUnitario><PrezzoTotale>10.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>
      <DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>10.00</ImponibileImporto><Imposta>2.20</Imposta><EsigibilitaIVA>I</EsigibilitaIVA></DatiRiepilogo>
    </DatiBeniServizi>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`;
}

/** Body for `POST /simulate/supplier-invoice` (shape from the SDI OAS example). */
export function sampleSupplierInvoice(fiscalId: string) {
  return {
    fattura_elettronica_header: {
      dati_trasmissione: { codice_destinatario: "1234567" },
      cedente_prestatore: {
        dati_anagrafici: {
          id_fiscale_iva: { id_paese: "IT", id_codice: "12345678901" },
          anagrafica: { denominazione: "Spike Supplier Srl" },
          regime_fiscale: "RF01",
        },
        sede: {
          indirizzo: "Via di Qua, 1",
          cap: "20145",
          comune: "Milano",
          provincia: "MI",
          nazione: "IT",
        },
      },
      cessionario_committente: {
        dati_anagrafici: {
          id_fiscale_iva: { id_paese: "IT", id_codice: fiscalId },
          anagrafica: { denominazione: "Spike Owner" },
        },
        sede: {
          indirizzo: "Via di La, 2",
          cap: "20145",
          comune: "Milano",
          provincia: "MI",
          nazione: "IT",
        },
      },
    },
    fattura_elettronica_body: [
      {
        dati_generali: {
          dati_generali_documento: {
            tipo_documento: "TD01",
            divisa: "EUR",
            data: "2026-11-02",
            numero: "S1",
          },
        },
        dati_beni_servizi: {
          dettaglio_linee: [
            {
              numero_linea: 1,
              descrizione: "Supplied item",
              prezzo_unitario: "10.00",
              prezzo_totale: "10.00",
              aliquota_iva: "22.00",
            },
          ],
          dati_riepilogo: [{ aliquota_iva: "22.00", imponibile_importo: "10.00", imposta: "2.20" }],
        },
      },
    ],
  };
}

export interface StepResult {
  step: string;
  status: number | string;
  body: string;
}

async function call(
  token: string,
  step: string,
  path: string,
  init: { method?: string; contentType?: string; body?: string } = {},
  doFetch: typeof fetch = fetch,
): Promise<StepResult> {
  try {
    const response = await doFetch(`${SANDBOX_BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.contentType ? { "Content-Type": init.contentType } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
    return {
      step,
      status: response.status,
      body: (await response.text()).slice(0, MAX_BODY_CHARS),
    };
  } catch (error) {
    return { step, status: "network error", body: error instanceof Error ? error.name : "error" };
  }
}

function requireSandboxToken(env: Bindings): string {
  if (!env.OPENAPI_SANDBOX_TOKEN) {
    throw makeError(
      "missing_secret",
      "Skipped: OPENAPI_SANDBOX_TOKEN is not set (wrangler secret put OPENAPI_SANDBOX_TOKEN).",
    );
  }
  return env.OPENAPI_SANDBOX_TOKEN;
}

/**
 * CPU probe for an Openapi POST: a deliberately invalid invoice (blank CodiceDestinatario) is
 * posted to the sandbox, which answers 400 without creating an invoice or consuming credit.
 */
export async function openapiDryRun(env: Bindings, doFetch: typeof fetch = fetch) {
  const token = requireSandboxToken(env);
  const xml = sampleInvoiceXml({
    fiscalId: "12345678901",
    recipientCode: "",
    progressive: "DRY01",
    number: "1",
  });
  return call(
    token,
    "dry-run POST /invoices (invalid on purpose)",
    "/invoices",
    {
      method: "POST",
      contentType: "application/xml",
      body: xml,
    },
    doFetch,
  );
}

const flowInput = z.object({
  fiscalId: z.string().regex(/^\d{11}$/),
  recipientCode: z
    .string()
    .regex(/^[A-Za-z0-9]{6,7}$/)
    .default("0000000"),
});

export const openapi = new Hono<{ Bindings: Bindings }>();

/** Send + simulated receipt + simulated supplier invoice on the sandbox; each step is reported raw. */
openapi.post("/sandbox-flow", async (c) => {
  const token = requireSandboxToken(c.env);
  const input = flowInput.safeParse(await c.req.json().catch(() => ({})));
  if (!input.success) throw makeError("bad_request", "fiscalId must be 11 digits.");
  const { fiscalId, recipientCode } = input.data;
  const stamp = String(Date.now()).slice(-5);
  const steps: StepResult[] = [];

  const sent = await call(token, "POST /invoices", "/invoices", {
    method: "POST",
    contentType: "application/xml",
    body: sampleInvoiceXml({ fiscalId, recipientCode, progressive: `S${stamp}`, number: stamp }),
  });
  steps.push(sent);
  let uuid: string | undefined;
  try {
    uuid = (JSON.parse(sent.body) as { data?: { uuid?: string } }).data?.uuid;
  } catch {
    uuid = undefined;
  }
  if (uuid) {
    steps.push(
      await call(
        token,
        "POST /simulate/customer-notification (RC)",
        "/simulate/customer-notification",
        {
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify({ uuid, notification: "RC" }),
        },
      ),
      await call(token, "GET /invoices/{uuid}", `/invoices/${uuid}`),
      await call(token, "GET /invoices_notifications/{uuid}", `/invoices_notifications/${uuid}`),
    );
  }
  steps.push(
    await call(token, "POST /simulate/supplier-invoice", "/simulate/supplier-invoice", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify(sampleSupplierInvoice(fiscalId)),
    }),
    await call(token, "GET /invoices (list, newest first)", "/invoices?page=1"),
  );
  return c.json({ uuid: uuid ?? null, steps });
});

// --- Callback receiver: records what Openapi really sends (headers, retries, payload shape). ---

interface CallbackRecord {
  at: string;
  headerNames: string[];
  authOk: boolean;
  bodyBytes: number;
  body: string;
  respondedWith: number;
}

const CALLBACK_KEY = "callbacks";
const MODE_KEY = "callback-mode";

export const callbackReceiver = new Hono<{ Bindings: Bindings }>();

/**
 * Unauthenticated entry for Openapi (it cannot send X-Spike-Secret). Accepts the secret as
 * `Authorization: Bearer <SPIKE_SECRET>` or `X-Spike-Secret`; wrong callers get a bare 404 and
 * are counted by header names only. Mode "fail" answers 500 to observe Openapi's retry schedule.
 */
callbackReceiver.post("/", async (c) => {
  const secret = c.env.SPIKE_SECRET;
  if (!secret) throw makeError("not_found");
  const bearer = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const authOk =
    (await safeEqual(bearer, secret)) ||
    (await safeEqual(c.req.header("X-Spike-Secret") ?? "", secret));
  const state = await readJson<{ records: CallbackRecord[]; rejected: number }>(
    c.env,
    CALLBACK_KEY,
    {
      records: [],
      rejected: 0,
    },
  );
  const headerNames = [...c.req.raw.headers.keys()].sort();
  if (!authOk) {
    await writeJson(c.env, CALLBACK_KEY, {
      ...state,
      rejected: state.rejected + 1,
      lastRejectedHeaderNames: headerNames,
    });
    throw makeError("not_found");
  }
  const mode = await readJson<{ mode: "ok" | "fail" }>(c.env, MODE_KEY, { mode: "ok" });
  const text = await c.req.text();
  const respondedWith = mode.mode === "fail" ? 500 : 200;
  const record: CallbackRecord = {
    at: new Date().toISOString(),
    headerNames,
    authOk,
    bodyBytes: text.length,
    body: text.slice(0, MAX_BODY_CHARS),
    respondedWith,
  };
  await writeJson(c.env, CALLBACK_KEY, {
    ...state,
    records: [...state.records, record].slice(-20),
  });
  return c.json({ received: true }, respondedWith);
});

openapi.get("/callbacks", async (c) =>
  c.json({
    mode: (await readJson<{ mode: string }>(c.env, MODE_KEY, { mode: "ok" })).mode,
    ...(await readJson<object>(c.env, CALLBACK_KEY, { records: [], rejected: 0 })),
  }),
);

openapi.post("/callback-mode", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { mode?: string };
  if (body.mode !== "ok" && body.mode !== "fail") throw makeError("bad_request");
  await writeJson(c.env, MODE_KEY, { mode: body.mode });
  return c.json({ mode: body.mode });
});

openapi.delete("/callbacks", async (c) => {
  await writeJson(c.env, CALLBACK_KEY, { records: [], rejected: 0 });
  return c.json({ ok: true });
});
