// Fills the placeholders in wrangler.jsonc from environment variables (CI: repository
// secrets/vars) so that no owner-specific value is ever tracked. Run before `vite build`.
//
//   D1_DATABASE_ID   (required) id of the D1 database
//   R2_BUCKET_NAME   (optional) R2 bucket name; defaults to the name in wrangler.jsonc
//   APP_DOMAIN       (optional) custom domain, e.g. invoices.example.com
//   APP_ORIGIN, MAIL_FROM_ADDRESS, VAPID_PUBLIC_KEY, VAPID_SUBJECT (optional) plain vars
import { readFileSync, writeFileSync } from "node:fs";

const path = "wrangler.jsonc";
let text = readFileSync(path, "utf8");

const databaseId = process.env.D1_DATABASE_ID;
if (!databaseId) {
  console.error("D1_DATABASE_ID is not set (repository variable). Aborting.");
  process.exit(1);
}
text = text.replace("__D1_DATABASE_ID__", databaseId);

if (process.env.R2_BUCKET_NAME) {
  text = text.replace(
    '"bucket_name": "invoicer-files"',
    `"bucket_name": "${process.env.R2_BUCKET_NAME}"`,
  );
}

const extra = {};
if (process.env.APP_DOMAIN) {
  extra.routes = [{ pattern: process.env.APP_DOMAIN, custom_domain: true }];
}
const vars = {};
for (const name of ["APP_ORIGIN", "MAIL_FROM_ADDRESS", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"]) {
  if (process.env[name]) vars[name] = process.env[name];
}
if (Object.keys(vars).length > 0) extra.vars = vars;

if (Object.keys(extra).length > 0) {
  const additions = JSON.stringify(extra, null, 2).slice(1, -1).trimEnd();
  text = text.replace(/\n}\s*$/, `,${additions}\n}\n`);
}

writeFileSync(path, text);
console.log("wrangler.jsonc rendered (values not printed).");
