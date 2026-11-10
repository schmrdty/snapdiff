import { Hono } from "hono";
import { CLIENT_STATUSES, type ClientHealth, type ClientStatus } from "./clients.js";
import { networks, nodeOf, type Config } from "./config.js";
import { hostOf } from "./hub.js";
import { llmsTxt } from "./llms.js";
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

/** Window for the stall list's count column. Every node and shard keeps its latest stall regardless of age. */
const STALL_WINDOW_MS = 7 * 24 * 3_600_000;
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
  // Node ids in the database ARE the configured labels; NODE_<LABEL>_NAME only changes how a
  // label is printed on this page (cards, stall and split tables). The API keeps the ids.
  const label = (s: Side) => nodeOf(cfg, s)?.name ?? s;
  // Header tile above each node card: "<network> reference" on every network's reference
  // (REFERENCE_NODE and the per-network references), "<network> node" on the rest. The title
  // line keeps only the name and the up/down pill. Colors come from data-net in the CSS.
  const headTile = (s: Side): string => {
    const net = nodeOf(cfg, s)?.network ?? "";
    const isRef = Object.values(cfg.references).includes(s);
    return `<div class="head${isRef ? " ref" : ""}">${esc(net)} ${isRef ? "reference" : "node"}</div>`;
  };
  const nodeLabels = cfg.nodes.map((n) => n.label);
  const nets = networks(cfg);
  const networkMap = Object.fromEntries(nets.map((x) => [x.network, x.labels]));
  const latestInfos = async (): Promise<Record<Side, InfoSnapshot | null>> =>
    Object.fromEntries(await Promise.all(nodeLabels.map(async (l) => [l, await store.latestInfo(l)] as const)));

  app.get("/api/summary", async (c) => {
    const [summary, info] = await Promise.all([store.summary(), latestInfos()]);
    return c.json({ nodes: nodeLabels, networks: networkMap, reference: cfg.reference, references: cfg.references, summary, info });
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

  // One node by label (README "API"): latest state, a window of up/down counts and worst
  // delay (default 24 h, max 7 days), its stalls in that window, and the newest samples.
  // Operators asked for this to follow their own node without a login. Private nodes are
  // safe here because src/hub.ts already stores the label as provider and in error texts.
  app.get("/api/node/:label", async (c) => {
    const label = c.req.param("label");
    const node = nodeOf(cfg, label);
    if (node === undefined) return c.json({ error: "unknown node" }, 404);
    const hours = Math.min(Math.max(Number(c.req.query("hours") ?? 24) || 24, 1), 168);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 60) || 60, 1), 1500);
    const now = Date.now();
    const fromMs = now - hours * 3_600_000;
    const [rows, stalls, latest] = await Promise.all([
      store.recentInfo(label, hours * 60 + 120, fromMs),
      store.listStalls({ side: label, fromMs, limit: 200 }),
      store.latestInfo(label),
    ]);
    const up = rows.filter((r) => r.reachable);
    const delays = up.map((r) => r.maxBlockDelay).filter((d): d is number => d !== null);
    return c.json({
      label,
      name: node.name ?? label,
      network: node.network,
      reference: Object.values(cfg.references).includes(label),
      latest,
      window: {
        hours,
        fromMs,
        toMs: now,
        samples: rows.length,
        up: up.length,
        down: rows.length - up.length,
        uptimePct: rows.length > 0 ? Math.round((up.length / rows.length) * 1000) / 10 : null,
        worstDelay: delays.length > 0 ? Math.max(...delays) : null,
        stalls: stalls.length,
      },
      stalls,
      history: rows.slice(0, limit).map((r) => ({
        at: r.at,
        reachable: r.reachable,
        maxBlockDelay: r.maxBlockDelay,
        shards: r.shards.map((s) => ({ shardId: s.shardId, maxHeight: s.maxHeight, blockDelay: s.blockDelay })),
      })),
    });
  });

  // Plain-text description for agents (src/llms.ts). Origin from the proxy headers when
  // behind Caddy, else from the request, so the links are absolute and correct in both setups.
  app.get("/llms.txt", (c) => {
    const url = new URL(c.req.url);
    const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
    return c.text(llmsTxt(cfg, `${proto}://${host}`), 200, { "content-type": "text/plain; charset=utf-8" });
  });

  app.get("/", async (c) => {
    const now = Date.now();
    const [summary, infos, unexplained, pending, recentStalls, openStalls] = await Promise.all([
      store.summary(),
      latestInfos(),
      store.listDiffs({ cause: "unexplained", limit: 100 }),
      store.listDiffs({ cause: "pending", limit: 25 }),
      store.listStalls({ limit: 2000 }),
      store.openStalls(),
    ]);
    // Newest 2000 plus anything still open beyond them, each once, newest first.
    const stalls = [...recentStalls, ...openStalls.filter((o) => !recentStalls.some((r) => r.id === o.id))].sort((a, b) => b.startedAt - a.startedAt);
    const openStall = (side: Side, shardId: number) => stalls.some((s) => s.side === side && s.shardId === shardId && s.endedAt === null);

    const nodeCard = (side: Side, i: InfoSnapshot | null, extra: boolean) => {
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
      return `<div class="col" data-net="${esc(nodeOf(cfg, side)?.network ?? "")}"${extra ? " data-extra" : " data-pin"}>${headTile(side)}<section class="card">
        <h2>${esc(label(side))} <span class="pill ${cls}">${status}</span></h2>
        <p class="muted">${esc(i?.provider ?? (nodeOf(cfg, side)?.private ? side : hostOf(nodeOf(cfg, side)?.url ?? "")))}${(nodeOf(cfg, side)?.providers.length ?? 1) > 1 ? ` (${nodeOf(cfg, side)?.providers.length} providers)` : ""} · checked ${ago(i?.at ?? null, now)}</p>
        ${i?.note ? `<p class="warn">${esc(i.note)}</p>` : ""}
        ${i?.error ? `<p class="bad-text">Not answering: ${esc(i.error)}. Other nodes still are; nothing is lost, this one just cannot be compared until it is back.</p>` : ""}
        ${shards ? `<table><thead><tr><th>Shard</th><th>Height</th><th>Block delay</th></tr></thead><tbody>${shards}</tbody></table>` : ""}
      </section></div>`;
    };

    // Node cards: the first configured node of every network is pinned on the left
    // (with two networks that is the reference and its first peer); any further
    // nodes share the remaining slots and page with the arrows. Pure presentation.
    const pinnedLabels = nets.map((n) => n.labels[0]).filter((l): l is Side => l !== undefined);
    const extraLabels = nodeLabels.filter((l) => !pinnedLabels.includes(l));
    const extraSet = new Set(extraLabels);

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
          <div class="scroll"><table><thead><tr><th>First seen</th><th>FID</th><th>Shard</th><th>Hash</th><th>On</th><th>Missing on</th><th>Scope</th><th>Cast</th><th>Note</th></tr></thead><tbody>
          ${rows
            .map(
              (r) => `<tr><td>${ago(r.firstSeen, now)}</td><td>${r.fid}</td><td>${r.shard ?? "?"}</td><td class="mono">${esc(r.hash.slice(0, 18))}…</td>
              <td>${esc(r.presentNodes.length > 0 ? r.presentNodes.map(label).join(", ") : label(r.presentOn))}</td><td>${esc(label(r.missingOn))}</td><td>${r.scope === null ? "" : `<span class="pill ${r.scope === "network" ? "bad" : "warn"}">${r.scope}</span>`}</td><td class="text">${esc(clip(castText(r.messageJson), 140))}</td><td>${esc(r.note ?? "")}</td></tr>`,
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

    // A shard stalled on every node of one network is that network stalling, not a node.
    const networkWideStalls = (rows: StallRow[]): string[] => {
      const openOn = new Map<number, Set<Side>>();
      for (const s of rows) {
        if (s.endedAt !== null) continue;
        const set = openOn.get(s.shardId) ?? new Set<Side>();
        set.add(s.side);
        openOn.set(s.shardId, set);
      }
      const out: string[] = [];
      for (const { network, labels } of nets) {
        for (const [shardId, nodes] of openOn) if (labels.every((l) => nodes.has(l))) out.push(`${network} shard ${shardId}`);
      }
      return out;
    };

    const splitHtml = () => `<section class="card" style="margin-bottom:12px"><h2>Network split</h2>
<p class="muted">A cast missing on every node of a network is a disagreement between the networks (scope "network"). A cast missing on one node while another node on its network has it is that node's problem (scope "node"). Unexplained by scope: node ${summary.byScope.node}, network ${summary.byScope.network}. Judged when each row is first seen, from the nodes that answered.</p>
<table><thead><tr><th>Network</th><th>Nodes</th><th>Casts missing on all its nodes: unexplained</th><th>pending</th></tr></thead><tbody>
${nets
  .map(
    ({ network, labels }) =>
      `<tr><td>${esc(network)}</td><td>${labels.map((l) => esc(label(l))).join(", ")}</td><td>${(summary.networkSplit[network]?.unexplained ?? 0) > 0 ? `<span class="pill bad">${summary.networkSplit[network]?.unexplained}</span>` : "0"}</td><td>${summary.networkSplit[network]?.pending ?? 0}</td></tr>`,
  )
  .join("")}</tbody></table></section>`;

    // One line per node and shard, newest first: its latest stall (any age) plus how many and how
    // long in the last 7 days. A pair with more than one stall opens on click to list them all (<details>:
    // no script, because the page's only inline script is hash-pinned in the Caddy CSP).
    // Ryan, 2026-11-10: one busy node was filling the whole table.
    const stallCells = (s: StallRow) =>
      `<td>${new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 19)}Z</td><td>${s.endedAt === null ? `<span class="pill bad">ongoing ${dur(s.startedAt, now)}</span>` : dur(s.startedAt, s.endedAt)}</td><td>${s.stuckHeight.toLocaleString()}</td><td>${s.peer ? esc(label(s.peer)) : ""}</td><td>${(s.peerHeightEnd ?? s.peerHeightStart).toLocaleString()}</td><td>${s.maxBlockDelay}s</td>`;
    const stallsHtml = (rows: StallRow[]) => {
      if (rows.length === 0) return `<p class="muted">None recorded.</p>`;
      const groups = new Map<string, StallRow[]>();
      for (const s of rows) {
        const k = `${s.side}\u0000${s.shardId}`;
        groups.set(k, [...(groups.get(k) ?? []), s]);
      }
      const spans = (s: StallRow) => stallCells(s).replace(/<td>/g, "<span>").replace(/<\/td>/g, "</span>");
      const head = `<div class="hdr"><span>Node</span><span>Shard</span><span>Latest started</span><span>Duration</span><span>Stuck at</span><span>Peer</span><span>Peer reached</span><span>Worst delay</span><span>Last 7 d</span></div>`;
      const body = [...groups.values()]
        .map((g) => {
          const latest = g[0]!;
          const recent = g.filter((s) => s.endedAt === null || s.startedAt >= now - STALL_WINDOW_MS);
          const total = recent.reduce((t, s) => t + ((s.endedAt ?? now) - s.startedAt), 0);
          const week = recent.length === 0 ? "none" : `${recent.length} stall${recent.length === 1 ? "" : "s"}, ${dur(0, total)}`;
          const line = `<span>${esc(label(latest.side))}</span><span>${latest.shardId}</span>${spans(latest)}<span>${week}</span>`;
          if (g.length === 1) return `<div class="row">${line}</div>`;
          return `<details class="group"><summary>${line}</summary><table><thead><tr><th>Started</th><th>Duration</th><th>Stuck at</th><th>Peer</th><th>Peer reached</th><th>Worst delay</th></tr></thead><tbody>${g.slice(0, 100).map((s) => `<tr>${stallCells(s)}</tr>`).join("")}</tbody></table></details>`;
        })
        .join("");
      return `<div class="scroll"><div class="stalls">${head}${body}</div></div>`;
    };

    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30">
<title>snapdiff</title>
<style>
:root{--bg:#f7f7f5;--fg:#1c1c1a;--muted:#6b6b66;--card:#fff;--line:#e3e2dd;--ok:#2f7d4f;--bad:#b3261e;--warn:#9a6700;--fc:#8a63d2;--fc-bg:#f6f2fc;--fc-line:#c9b6ea}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9c9b95;--card:#1d1d1b;--line:#33322f;--ok:#5cc58a;--bad:#f2867c;--warn:#e0b44c;--fc:#8a63d2;--fc-bg:#231c33;--fc-line:#5d4a85}}
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
.stalls{min-width:940px}.stalls .hdr,.stalls .row,.stalls summary{display:grid;grid-template-columns:minmax(110px,1.4fr) 44px 150px 118px 96px minmax(90px,1fr) 96px 80px 122px;gap:0 8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--line);font-size:14px;white-space:nowrap}
.stalls .hdr{font-weight:600;color:var(--muted)}.stalls .row>span:first-child,.stalls summary>span:first-child{padding-left:1.2em;position:relative}
.stalls summary{cursor:pointer;list-style:none}.stalls summary::-webkit-details-marker{display:none}.stalls summary>span:first-child::before{content:"\\25B8";position:absolute;left:0;color:var(--muted)}.stalls details[open]>summary>span:first-child::before{content:"\\25BE"}
.stalls details>table{width:auto;margin:4px 8px 10px 2.2em}.stalls details>table td,.stalls details>table th{border-bottom:1px solid var(--line)}
td.text{white-space:normal;min-width:240px;max-width:460px}
.nodes{grid-template-columns:repeat(auto-fit,minmax(250px,1fr));margin-top:8px}[hidden]{display:none!important}
.col .head{font-size:12px;text-transform:uppercase;letter-spacing:.05em;padding:3px 12px;border:1px solid var(--line);border-bottom:0;border-radius:10px 10px 0 0;background:var(--line);color:var(--muted)}
.col{display:flex;flex-direction:column}.col .head.ref{font-weight:700;color:var(--fg)}.col .card{border-radius:0 0 10px 10px;flex:1}
.col[data-net=hypersnap] .head{background:var(--fc);border-color:var(--fc);color:#fff}.col[data-net=hypersnap] .card{background:var(--fc-bg);border-color:var(--fc-line)}
.pager{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:16px 0 0}.pager .muted{margin:0}
.pager button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:2px 10px;font:inherit;cursor:pointer}
.pager button:disabled{opacity:.4;cursor:default}
</style></head><body><main>
<h1>snapdiff: ${nets.map(({ network, labels }) => `${esc(network)} (${labels.length} node${labels.length === 1 ? "" : "s"})`).join(" vs ")}</h1>
<p class="muted">Scans run every ${Math.round(cfg.scanIntervalMs / 60000)} min: ${summary.scans} so far, last ${ago(summary.lastScanAt, now)}, next in about ${nextScanIn(summary.lastScanAt, cfg.scanIntervalMs, now)}. This page reloads every 30 s. Read-only.</p>
<div class="stats">${counts}</div>
${extraLabels.length > 0 ? `<div class="pager" id="pager" hidden><span class="muted">More ${esc(nets.find((n) => n.labels.length > 1)?.network ?? "")} nodes</span><button type="button" id="prev" aria-label="Earlier nodes">&larr;</button><span id="pagei" class="muted"></span><button type="button" id="next" aria-label="Later nodes">&rarr;</button></div>` : ""}
<div class="grid nodes" id="nodes">${[...pinnedLabels, ...extraLabels].map((l) => nodeCard(l, infos[l] ?? null, extraSet.has(l))).join("")}</div>
<script>
(function(){
  var g=document.getElementById('nodes'),pager=document.getElementById('pager');if(!g||!pager)return;
  var extra=[].slice.call(g.querySelectorAll('[data-extra]')),pinned=g.querySelectorAll('[data-pin]').length;
  var prev=document.getElementById('prev'),next=document.getElementById('next'),lab=document.getElementById('pagei');
  var key='snapdiff.nodeOffset',off=0;try{off=parseInt(localStorage.getItem(key)||'0',10)||0}catch(e){}
  function perRow(){return Math.max(1,Math.floor((g.clientWidth+12)/262));}
  function render(){
    var slots=Math.max(1,perRow()-pinned);
    if(extra.length<=slots){extra.forEach(function(c){c.hidden=false});pager.hidden=true;return;}
    off=Math.min(Math.max(off,0),extra.length-slots);
    extra.forEach(function(c,i){c.hidden=i<off||i>=off+slots});
    pager.hidden=false;prev.disabled=off===0;next.disabled=off+slots>=extra.length;
    lab.textContent=(off+1)+'-'+(off+slots)+' of '+extra.length;
    try{localStorage.setItem(key,String(off))}catch(e){}
  }
  prev.onclick=function(){off--;render()};next.onclick=function(){off++;render()};
  addEventListener('resize',render);render();
})();
</script>
${splitHtml()}
${clientsHtml(clients?.() ?? [])}
<section class="card" style="margin-bottom:12px"><h2>Shard stalls${summary.openStalls > 0 ? ` <span class="pill bad">${summary.openStalls} ongoing</span>` : ""}${networkWideStalls(stalls).map((t) => ` <span class="pill bad">network-wide: ${esc(t)}</span>`).join("")}</h2>
<p class="muted">A shard on one node stopped advancing while the same shard on its healthiest peer kept going. When every node of a network is stalled on a shard it is marked network-wide. Diffs on a stalled shard stay pending until it recovers. One line per node and shard with its latest stall; the last column counts the past 7 days; a line with several stalls opens on click.</p>${stallsHtml(stalls)}</section>
<section class="card"><h2>Unexplained</h2><p class="muted">${nodeLabels.map((l) => `Missing on ${esc(l)}: ${summary.byMissingNode[l] ?? 0}`).join(" · ")}. Rows are rechecked for ${Math.round(cfg.recheckWindowMs / 3600000)} h; one that turns up on the missing side moves to sync lag and leaves this list.</p>${rowsHtml(unexplained, summary.byCause.unexplained)}</section>
<section class="card" style="margin-top:12px"><h2>Pending</h2><p class="muted">Seen on one side, not yet old enough or not yet rechecked. Most resolve on their own.</p>${rowsHtml(pending, summary.byCause.pending)}</section>
</main></body></html>`);
  });

  return app;
}
