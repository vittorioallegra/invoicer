/** Characters that are unsafe in file names on common platforms, plus whitespace. */
const UNSAFE_FILE_CHARS = /[/\\:*?"<>|\s]+/g;

const CLIENT_SLUG_MAX = 40;

/** A lowercase ASCII slug of a client name: accents stripped, other characters become `-`. */
export function clientSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CLIENT_SLUG_MAX)
    .replace(/-+$/g, "");
}

/**
 * The download name of an invoice PDF: `invoice-<number>-<client>.pdf`, e.g.
 * `invoice-CH-3-acme-srl.pdf`. The number is as printed with unsafe characters replaced by `-`.
 * The XML keeps its official SdI name (`IT<vat>_<progressive>.xml`) and never goes through this.
 */
export function invoicePdfFileName(number: string, clientName: string | null): string {
  const safeNumber = number.trim().replace(UNSAFE_FILE_CHARS, "-");
  const slug = clientName ? clientSlug(clientName) : "";
  return `invoice-${safeNumber}${slug ? `-${slug}` : ""}.pdf`;
}
