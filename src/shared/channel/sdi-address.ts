/** First transmission goes here; the SdI's first reply names the address for later ones. */
export const SDI_FIRST_ADDRESS = "sdi01@pec.fatturapa.it";

/** The PEC address to send to: the one assigned by the SdI once known, else the first address. */
export function sdiAddressFor(assigned: string | null | undefined): string {
  const value = assigned?.trim();
  return value ? value : SDI_FIRST_ADDRESS;
}
