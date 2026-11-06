// scripts/probe-neynar.mjs
// Diagnostic for the reference node's auth: which header names are configured, how long the
// key is, and what /v1/info answers. Never prints the key. Run on the VPS from /srv/snapdiff:
//   node --env-file=/srv/snapdiff/.env scripts/probe-neynar.mjs
const raw = process.env.NODE_A_HEADERS ?? process.env.NODE_SNAPCHAIN_HEADERS ?? "";
const url = (process.env.NODE_A_URL ?? process.env.NODE_SNAPCHAIN_URL ?? "https://snapchain-api.neynar.com").replace(/\/$/, "");
let headers = {};
try { headers = JSON.parse(raw); } catch { console.log(`headers: NOT VALID JSON (${raw.length} chars; starts with ${JSON.stringify(raw.slice(0, 2))})`); process.exit(1); }
for (const [k, v] of Object.entries(headers)) console.log(`header ${k}: ${String(v).length} chars, looks like ${/^[0-9a-f-]{36}$/i.test(String(v)) ? "a UUID key" : "not a UUID"}`);
const r = await fetch(`${url}/v1/info`, { headers, signal: AbortSignal.timeout(10000) });
const body = await r.text();
console.log(`GET ${url}/v1/info -> HTTP ${r.status}`);
console.log(body.slice(0, 400));
