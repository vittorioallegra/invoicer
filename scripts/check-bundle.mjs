// Bundle check: the Worker must stay under the free-plan size limit (3 MB compressed), and
// browser-only libraries must never end up in the Worker bundle.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const WORKER_DIR = "dist/invoicer";
const LIMIT_BYTES = 3 * 1024 * 1024;
// Markers of client-only libraries (the 3 MB limit is for the gzip-compressed Worker).
const CLIENT_ONLY = [
  "@react-pdf/renderer",
  "xmllint-wasm",
  "pkijs",
  "fflate",
  "papaparse",
  "XlsError",
];

function jsFiles(dir) {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && path.endsWith(".js"));
}

let failed = false;
let totalGzip = 0;
for (const file of jsFiles(WORKER_DIR)) {
  const source = readFileSync(file);
  totalGzip += gzipSync(source).length;
  const text = source.toString("utf8");
  for (const marker of CLIENT_ONLY) {
    if (text.includes(marker)) {
      console.error(`FAIL: ${file} contains client-only library "${marker}"`);
      failed = true;
    }
  }
}

const kb = (totalGzip / 1024).toFixed(1);
if (totalGzip > LIMIT_BYTES) {
  console.error(`FAIL: Worker bundle is ${kb} KiB gzip, limit is ${LIMIT_BYTES / 1024} KiB`);
  failed = true;
} else {
  console.log(`Worker bundle: ${kb} KiB gzip (limit ${LIMIT_BYTES / 1024} KiB)`);
}
process.exit(failed ? 1 : 0);
