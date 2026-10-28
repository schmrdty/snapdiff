// scripts/probe-window.mjs
// Diagnostic: how many casts do castsByFid calls return for known FIDs on each
// node, using the scan loop's exact 24h window (loops.ts: now-24h .. now-grace)
// versus the preflight's 30-day window? Counts only; prints no headers, no key.
//
// Run on the VPS from /srv/snapdiff (prod build, env loaded by Node):
//   node --env-file=/srv/snapdiff/.env --disable-warning=ExperimentalWarning scripts/probe-window.mjs 3 2 5650 239
import { loadConfig } from "../dist/src/config.js";
import { HubClient } from "../dist/src/hub.js";

const cfg = loadConfig();
const fids = process.argv.slice(2).map(Number).filter((n) => Number.isInteger(n) && n > 0);
if (!fids.length) { console.error("usage: probe-window.mjs <fid> [fid...]"); process.exit(1); }
const hubs = {
  a: new HubClient("a", cfg.a.url, cfg.requestTimeoutMs, cfg.a.headers),
  b: new HubClient("b", cfg.b.url, cfg.requestTimeoutMs, cfg.b.headers),
};
const nowSec = Math.floor(Date.now() / 1000);
const windows = {
  "scan 24h": [nowSec - cfg.lookbackHours * 3600, nowSec - cfg.graceSeconds],
  "preflight 30d": [nowSec - 30 * 86400, nowSec],
};
for (const fid of fids) {
  for (const [name, [start, stop]] of Object.entries(windows)) {
    const row = [];
    for (const side of ["a", "b"]) {
      try {
        const msgs = await hubs[side].castsByFid(fid, start, stop, cfg.maxPagesPerFid);
        const newest = msgs.map((m) => m.data?.timestamp ?? 0).sort((x, y) => y - x)[0];
        row.push(`${cfg[side].label}=${msgs.length}${newest ? ` (newest fc-ts ${newest})` : ""}`);
      } catch (e) {
        row.push(`${cfg[side].label}=ERR ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(`fid ${fid} ${name.padEnd(13)} ${row.join("  ")}`);
  }
}
console.log(`window check: scan start fc-ts ${nowSec - cfg.lookbackHours * 3600 - 1609459200}, stop fc-ts ${nowSec - cfg.graceSeconds - 1609459200}, now fc-ts ${nowSec - 1609459200}`);
