import type { Natura } from "./types";

export interface NaturaText {
  /** Italian legal reference (FatturaPA `RiferimentoNormativo`, printed on the PDF). */
  text: string;
  /** `mandatory`: the legal reference must appear; `suggested`: a standard text to prefill. */
  requirement: "mandatory" | "suggested";
}

/**
 * Fixed Italian legal reference texts per natura code. They are data (not i18n): the same
 * wording goes into the XML and onto the PDF. Codes with several possible provisions carry the
 * commonly used one, to be edited by the owner when another applies.
 */
export const NATURA_TEXTS: Readonly<Record<Natura, NaturaText>> = {
  N1: {
    text: "Operazione esclusa ai sensi dell'art. 15 del DPR 633/72",
    requirement: "suggested",
  },
  "N2.1": {
    text: "Operazione non soggetta a IVA ai sensi dell'art. 7-ter del DPR 633/72",
    requirement: "suggested",
  },
  "N2.2": {
    text: "Operazione effettuata ai sensi dell'art. 1, commi 54-89, L. 190/2014",
    requirement: "mandatory",
  },
  "N3.1": {
    text: "Operazione non imponibile ai sensi dell'art. 8, comma 1, lett. a) del DPR 633/72",
    requirement: "suggested",
  },
  "N3.2": {
    text: "Cessione intracomunitaria non imponibile ai sensi dell'art. 41 del DL 331/93",
    requirement: "suggested",
  },
  "N3.3": {
    text: "Operazione non imponibile ai sensi dell'art. 71 del DPR 633/72",
    requirement: "suggested",
  },
  "N3.4": {
    text: "Operazione assimilata alle cessioni all'esportazione ai sensi dell'art. 8-bis del DPR 633/72",
    requirement: "suggested",
  },
  "N3.5": {
    text: "Operazione non imponibile a seguito di dichiarazione d'intento ai sensi dell'art. 8, comma 1, lett. c) del DPR 633/72",
    requirement: "mandatory",
  },
  "N3.6": {
    text: "Operazione non imponibile ai sensi dell'art. 9 del DPR 633/72",
    requirement: "suggested",
  },
  N4: {
    text: "Operazione esente da IVA ai sensi dell'art. 10 del DPR 633/72",
    requirement: "mandatory",
  },
  N5: {
    text: "Operazione soggetta al regime del margine ai sensi dell'art. 36 del DL 41/95",
    requirement: "suggested",
  },
  "N6.1": {
    text: "Inversione contabile - cessione di rottami e materiali di recupero ai sensi dell'art. 74, commi 7 e 8, del DPR 633/72",
    requirement: "suggested",
  },
  "N6.2": {
    text: "Inversione contabile - cessione di oro e argento ai sensi dell'art. 17, comma 5, del DPR 633/72",
    requirement: "suggested",
  },
  "N6.3": {
    text: "Inversione contabile - subappalto nel settore edile ai sensi dell'art. 17, comma 6, lett. a) del DPR 633/72",
    requirement: "suggested",
  },
  "N6.4": {
    text: "Inversione contabile - cessione di fabbricati ai sensi dell'art. 17, comma 6, lett. a-bis) del DPR 633/72",
    requirement: "suggested",
  },
  "N6.5": {
    text: "Inversione contabile - cessione di telefoni cellulari ai sensi dell'art. 17, comma 6, lett. b) del DPR 633/72",
    requirement: "suggested",
  },
  "N6.6": {
    text: "Inversione contabile - cessione di prodotti elettronici ai sensi dell'art. 17, comma 6, lett. c) del DPR 633/72",
    requirement: "suggested",
  },
  "N6.7": {
    text: "Inversione contabile - prestazioni del comparto edile e settori connessi ai sensi dell'art. 17, comma 6, lett. a-ter) del DPR 633/72",
    requirement: "suggested",
  },
  "N6.8": {
    text: "Inversione contabile - operazioni del settore energetico ai sensi dell'art. 17, comma 6, lett. d-bis), d-ter) e d-quater) del DPR 633/72",
    requirement: "suggested",
  },
  "N6.9": {
    text: "Inversione contabile - altri casi ai sensi dell'art. 17 del DPR 633/72",
    requirement: "suggested",
  },
  N7: {
    text: "IVA assolta in altro Stato UE ai sensi dell'art. 7-octies e dell'art. 74-sexies del DPR 633/72",
    requirement: "suggested",
  },
};
