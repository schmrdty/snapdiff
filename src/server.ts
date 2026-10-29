import { Hono } from "hono";
import { CLIENT_STATUSES, type ClientHealth, type ClientStatus } from "./clients.js";
import type { Config } from "./config.js";
import type { Store } from "./store/store.js";
import { CAUSES, type Cause, type DiffRow, type InfoSnapshot, type Side, type StallRow } from "./types.js";

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const ago = (ms: number | null, now: number): string => {
  if (ms === null) return "never";
  const s = Math.round((now - ms) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/** Time until the next scan is due, from the last scan's start and the interval. */
const nextScanIn = (lastScanMs: number | null, intervalMs: number, now: number): string => {
  if (lastScanMs === null) return "a moment";
  const s = Math.max(0, Math.round((lastScanMs + intervalMs - now) / 1000));
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}m`;
};

const dur = (fromMs: number, toMs: number): string => {
  const s = Math.round((toMs - fromMs) / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
};

const CAUSE_HELP: Record<Cause, string> = {
  unexplained: "Valid under both rule sets, still missing. Investigate these.",
  pending: "Too new to judge, or the missing node is behind.",
  relay_filtered: "Filtered type, or a FID registered on one network only. Expected by design.",
  version_rule: "Uses V21/V22 rules only one side enforces. Expected.",
  sync_lag: "Arrived late on the missing side. Expected.",
};

const isCause = (v: string | undefined): v is Cause => v !== undefined && (CAUSES as readonly string[]).includes(v);

export function buildApp(cfg: Config, store: Store, clients?: () => ClientHealth[]): Hono {
  const app = new Hono();
  const label = (s: Side) => (s === "a" ? cfg.a.label : cfg.b.label);

  app.get("/api/summary", async (c) => {
    const [summary, a, b] = await Promise.all([store.summary(), store.latestInfo("a"), store.latestInfo("b")]);
    return c.json({ nodes: { a: cfg.a.label, b: cfg.b.label }, summary, info: { a, b } });
  });

  app.get("/api/diffs", async (c) => {
    const cause = c.req.query("cause");
    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 5000);
    if (cause !== undefined && !isCause(cause)) return c.json({ error: `cause must be one of ${CAUSES.join(", ")}` }, 400);
    const rows = await store.listDiffs({ ...(cause !== undefined ? { cause } : {}), limit });
    return c.json(rows.map(({ messageJson, ...r }) => ({ ...r, message: JSON.parse(messageJson) as unknown })));
  });

  // Client health (docs/CLIENT-HEALTH.md): latest status per configured client, or [] when off.
  app.get("/api/clients", (c) => c.json({ clients: clients?.() ?? [] }));

  app.get("/api/stalls", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 5000);
    return c.json(await store.listStalls({ limit }));
  });

  app.get("/", async (c) => {
    const now = Date.now();
    const [summary, ia, ib, unexplained, pending, stalls] = await Promise.all([
      store.summary(),
      store.latestInfo("a"),
      store.latestInfo("b"),
      store.listDiffs({ cause: "unexplained", limit: 100 }),
      store.listDiffs({ cause: "pending", limit: 25 }),
      store.listStalls({ limit: 50 }),
    ]);
    const openStall = (side: Side, shardId: number) => stalls.some((s) => s.side === side && s.shardId === shardId && s.endedAt === null);

    const nodeCard = (side: Side, i: InfoSnapshot | null) => {
      const status = i === null ? "no data" : i.reachable ? "up" : "down";
      const cls = i?.reachable ? "ok" : "bad";
      const shards =
        i?.shards
          .slice()
          .sort((x, y) => x.shardId - y.shardId)
          .map(
            (s) =>
              `<tr><td>${s.shardId}${openStall(side, s.shardId) ? ` <span class="pill bad">stalled</span>` : ""}</td><td>${s.maxHeight.toLocaleString()}</td><td>${s.blockDelay}</td></tr>`,
          )
          .join("") ?? "";
      return `<section class="card">
        <h2>${esc(label(side))} <span class="pill ${cls}">${status}</span></h2>
        <p class="muted">${esc(side === "a" ? cfg.a.url : cfg.b.url)} · checked ${ago(i?.at ?? null, now)}</p>
        ${i?.error ? `<p class="bad-text">${esc(i.error)}</p>` : ""}
        ${shards ? `<table><thead><tr><th>Shard</th><th>Height</th><th>Block delay</th></tr></thead><tbody>${shards}</tbody></table>` : ""}
      </section>`;
    };

    const counts = (["unexplained", "pending", "relay_filtered", "version_rule", "sync_lag"] as const)
      .map(
        (k) => `<div class="stat ${k}"><div class="n">${summary.byCause[k]}</div><div class="k">${k.replace("_", " ")}</div>
        <div class="help">${CAUSE_HELP[k]}</div></div>`,
      )
      .join("");

    // Cast text comes out of the stored message JSON; anything unparseable or
    // non-cast shows as empty rather than breaking the page.
    const castText = (messageJson: string): string => {
      try {
        const m = JSON.parse(messageJson) as { data?: { castAddBody?: { text?: unknown } } };
        const t = m.data?.castAddBody?.text;
        return typeof t === "string" ? t : "";
      } catch {
        return "";
      }
    };
    const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

    // Newest first (the store orders by first_seen DESC); each card scrolls on
    // its own, so new rows push older ones down instead of off the page.
    const rowsHtml = (rows: DiffRow[], total: number) =>
      rows.length === 0
        ? `<p class="muted">None.</p>`
        : `<p class="muted">Newest ${rows.length} of ${total}; older rows stay in the database and at /api/diffs.</p>
          <div class="scroll"><table><thead><tr><th>First seen</th><th>FID</th><th>Shard</th><th>Hash</th><th>On</th><th>Missing on</th><th>Cast</th><th>Note</th></tr></thead><tbody>
          ${rows
            .map(
              (r) => `<tr><td>${ago(r.firstSeen, now)}</td><td>${r.fid}</td><td>${r.shard ?? "?"}</td><td class="mono">${esc(r.hash.slice(0, 18))}…</td>
              <td>${esc(label(r.presentOn))}</td><td>${esc(label(r.missingOn))}</td><td class="text">${esc(clip(castText(r.messageJson), 140))}</td><td>${esc(r.note ?? "")}</td></tr>`,
            )
            .join("")}</tbody></table></div>`;

    // Client cards render only from fixed vocabularies: the status word comes
    // from CLIENT_STATUSES, the link from the operator's config, and every
    // string passes through esc(). Nothing from a health response is a link.
    const STATUS_CLASS: Record<ClientStatus, string> = { ok: "ok", degraded: "warn", down: "bad", unknown: "muted" };
    const clientsHtml = (list: ClientHealth[]) =>
      list.length === 0
        ? ""
        : `<section class="card" style="margin-bottom:12px"><h2>Clients</h2>
<p class="muted">Apps people use on each network, checked every ${Math.round(cfg.clientHealthIntervalMs / 1000)} s against the status endpoint each one publishes. Links go to the client's own site.</p>
<div class="scroll"><table><thead><tr><th>Client</th><th>Network</th><th>Status</th><th>Latency</th><th>Checked</th><th>Note</th></tr></thead><tbody>
${list
  .map((h) => {
    const status: ClientStatus = CLIENT_STATUSES.includes(h.status) ? h.status : "unknown";
    return `<tr><td><a href="${esc(h.siteUrl)}" rel="noopener noreferrer" target="_blank">${esc(h.label)}</a> <span class="muted">${esc(h.siteHost)}</span></td>
<td>${esc(h.network)}</td><td><span class="pill ${STATUS_CLASS[status]}">${status}</span></td>
<td>${h.latencyMs === null ? "" : `${h.latencyMs} ms`}</td><td>${ago(h.checkedAt, now)}</td><td>${esc(h.note)}</td></tr>`;
  })
  .join("")}</tbody></table></div></section>`;

    const stallsHtml = (rows: StallRow[]) =>
      rows.length === 0
        ? `<p class="muted">None recorded.</p>`
        : `<div class="scroll"><table><thead><tr><th>Node</th><th>Shard</th><th>Started</th><th>Duration</th><th>Stuck at</th><th>Peer reached</th><th>Worst delay</th></tr></thead><tbody>
          ${rows
            .map(
              (s) => `<tr><td>${esc(label(s.side))}</td><td>${s.shardId}</td><td>${new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 19)}Z</td>
              <td>${s.endedAt === null ? `<span class="pill bad">ongoing ${dur(s.startedAt, now)}</span>` : dur(s.startedAt, s.endedAt)}</td>
              <td>${s.stuckHeight.toLocaleString()}</td><td>${(s.peerHeightEnd ?? s.peerHeightStart).toLocaleString()}</td><td>${s.maxBlockDelay}s</td></tr>`,
            )
            .join("")}</tbody></table></div>`;

    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30">
<title>snapdiff</title>
<style>
:root{--bg:#f7f7f5;--fg:#1c1c1a;--muted:#6b6b66;--card:#fff;--line:#e3e2dd;--ok:#2f7d4f;--bad:#b3261e;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9c9b95;--card:#1d1d1b;--line:#33322f;--ok:#5cc58a;--bad:#f2867c;--warn:#e0b44c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:0 0 4px}
.muted{color:var(--muted);margin:0 0 8px}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));margin:16px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.stats{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.stat .n{font-size:28px;font-weight:650}
.stat .k{text-transform:uppercase;font-size:12px;letter-spacing:.05em;color:var(--muted)}.stat .help{font-size:13px;color:var(--muted);margin-top:4px}
.stat.unexplained .n{color:var(--bad)}.stat.pending .n{color:var(--warn)}
.pill{font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid currentColor}.ok{color:var(--ok)}.bad,.bad-text{color:var(--bad)}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-weight:600;color:var(--muted)}.mono{font-family:ui-monospace,monospace}.scroll{overflow:auto;max-height:420px}
td.text{white-space:normal;min-width:240px;max-width:460px}
</style></head><body><main>
<h1>snapdiff: ${esc(cfg.a.label)} vs ${esc(cfg.b.label)}</h1>
<p class="muted">Scans run every ${Math.round(cfg.scanIntervalMs / 60000)} min: ${summary.scans} so far, last ${ago(summary.lastScanAt, now)}, next in about ${nextScanIn(summary.lastScanAt, cfg.scanIntervalMs, now)}. This page reloads every 30 s. Read-only.</p>
<div class="stats">${counts}</div>
<div class="grid">${nodeCard("a", ia)}${nodeCard("b", ib)}</div>
${clientsHtml(clients?.() ?? [])}
<section class="card" style="margin-bottom:12px"><h2>Shard stalls${summary.openStalls > 0 ? ` <span class="pill bad">${summary.openStalls} ongoing</span>` : ""}</h2>
<p class="muted">A shard on one node stopped advancing while the same shard on the other node kept going. Diffs on a stalled shard stay pending until it recovers.</p>${stallsHtml(stalls)}</section>
<section class="card"><h2>Unexplained</h2><p class="muted">Missing on ${esc(cfg.a.label)}: ${summary.byMissingSide.a} · missing on ${esc(cfg.b.label)}: ${summary.byMissingSide.b}. Rows are rechecked for ${Math.round(cfg.recheckWindowMs / 3600000)} h; one that turns up on the missing side moves to sync lag and leaves this list.</p>${rowsHtml(unexplained, summary.byCause.unexplained)}</section>
<section class="card" style="margin-top:12px"><h2>Pending</h2><p class="muted">Seen on one side, not yet old enough or not yet rechecked. Most resolve on their own.</p>${rowsHtml(pending, summary.byCause.pending)}</section>
</main></body></html>`);
  });

  return app;
}
