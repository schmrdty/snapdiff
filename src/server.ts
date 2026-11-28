import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { embedJson, manifestJson } from "./miniapp.js";
import { meshLine, type MeshSummary } from "./mesh.js";
import { consensusLine, shardConsensus, type ConsensusNode, type ShardConsensus } from "./consensus.js";
import { keyFromPeerId, type ValidatorSet } from "./validators.js";
import { CLIENT_STATUSES, type ClientHealth, type ClientStatus } from "./clients.js";
import { networks, nodeOf, type Config, isTestnetNetwork } from "./config.js";
import { hostOf } from "./hub.js";
import { llmsTxt } from "./llms.js";
import type { ReleaseState } from "./releases.js";
import type { FeedSnapshot } from "./testnet-feed.js";
import type { Store } from "./store/store.js";
import { CAUSES, type Cause, type DiffRow, type InfoSnapshot, type Side, type StallRow } from "./types.js";
import { compareVersions, latestVersions, versionView } from "./versions.js";

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

// Collapsible sections (static/fold.js). Every section is one card whose heading line carries an
// arrow at its right edge; folded, the card is that one line and the cards below move up. The
// Nodes card also folds each network group inside it. The operator approved the testnet mockup for both
// tabs on 2026-11-24. The markup works without the script: every section renders open and the
// arrows stay hidden (`.fold-js` is set by the script), so a blocked script costs nothing. The
// script is a file under /static, which the Caddy CSP already allows ('self'); the hash-pinned
// inline pager script below is untouched.
const CHEV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 10.5 8 6l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const foldBtn = (id: string, name: string): string =>
  `<button class="fold" type="button" aria-expanded="true" aria-controls="${esc(id)}-body" aria-label="Collapse ${esc(name)}">${CHEV}</button>`;
/**
 * Button hues (operator, 2026-11-26: buttons colored, not all purple, gray, or black and white). Each
 * c-* class sets --c (text and border), --f (fill when active), and --o (text on the fill); the
 * values in the style block were checked at 4.5:1 or better in both themes. Hypersnap keeps the
 * purple it has everywhere else on the page.
 */
const netHue = (network: string): string => (/hypersnap/i.test(network) ? "c-purple" : /snapchain/i.test(network) ? "c-teal" : "c-blue");

/** Credit under the title: a native popover, so no script and no change to the CSP hash. */
const creditHtml = (c: Config["siteCredit"]): string =>
  c === null
    ? ""
    : `<button class="credit" type="button" popovertarget="credit-pop">${esc(c.text)}</button><div id="credit-pop" class="credit-pop" popover><a class="credit-btn hue c-pink" href="${esc(c.quilcastUrl)}" rel="noopener noreferrer" target="_blank">Quilcast</a><a class="credit-btn hue c-blue" href="${esc(c.xUrl)}" rel="noopener noreferrer" target="_blank">X</a></div>`;

/** One collapsible card. `h2Inner` is HTML the caller already escaped (it may carry pills). */
const sec = (id: string, name: string, h2Inner: string, body: string, headExtra = ""): string =>
  `<section class="card sec fold-box" id="${esc(id)}" data-name="${esc(name)}"><div class="sec-head"><h2>${h2Inner}</h2>${headExtra}${foldBtn(id, name)}</div><div class="sec-body" id="${esc(id)}-body"><div class="sec-in"><div class="sec-pad">
${body}</div></div></div></section>`;

/**
 * Overall state of one network's nodes for its letter badge in the Nodes card (operator,
 * 2026-11-24): green while fewer than 41% of its nodes are down, yellow at 41% or more, red
 * only when none of them answers. A node with no snapshot yet counts as not answering.
 */
export const networkState = (total: number, down: number): "ok" | "warn" | "bad" =>
  total > 0 && down >= total ? "bad" : total > 0 && down / total >= 0.41 ? "warn" : "ok";
/**
 * One node's pill (operator, 2026-11-25): "down" only when /v1/info gives no usable answer;
 * "degraded" when it answers but a shard is past BEHIND_BLOCK_DELAY or has an open stall
 * (catching up after a restart, or stopped while its peers go on); "up" otherwise. Before
 * this a node 12 h behind and catching up read "up", and the same node read "down" once it
 * was slow to answer, so a catching-up node never read as what it was. Degraded counts as
 * answering everywhere: the network badge, uptime, and the API window.
 */
export type NodeState = "no data" | "down" | "degraded" | "up";
export const nodeState = (i: InfoSnapshot | null, behindBlockDelay: number, stalled = false): NodeState =>
  i === null ? "no data" : !i.reachable ? "down" : stalled || (i.maxBlockDelay !== null && i.maxBlockDelay > behindBlockDelay) ? "degraded" : "up";
const STATE_CLASS: Record<NodeState, string> = { "no data": "bad", down: "bad", degraded: "warn", up: "ok" };
/** H for Hypersnap networks (testnet included), S for Snapchain. */
const netLetter = (network: string): string => (network.includes("snapchain") ? "S" : "H");

export function buildApp(cfg: Config, store: Store, clients?: () => ClientHealth[], releases?: () => Record<string, ReleaseState>, feed?: () => Record<string, FeedSnapshot>, mesh?: () => Record<Side, MeshSummary>, sets?: (network: string) => ReadonlyArray<ValidatorSet> | null): Hono {
  const app = new Hono();
  // Node ids in the database ARE the configured labels; NODE_<LABEL>_NAME only changes how a
  // label is printed on this page (cards, stall and split tables). The API keeps the ids.
  const label = (s: Side) => nodeOf(cfg, s)?.name ?? s;
  // Peer view (src/mesh.ts). A validator row names the snapdiff node behind it when that
  // node's own mesh view told us its peer id; otherwise the row shows the key prefix and a
  // shortened peer id. Only nodes on an enabled network kind have an entry (MESH_NETWORKS).
  const meshSnap = (): Record<Side, MeshSummary> => mesh?.() ?? {};
  // A plain object lookup: a label such as "constructor" must not read Object.prototype.
  const meshOf = (snap: Record<Side, MeshSummary>, side: Side): MeshSummary | undefined => (Object.hasOwn(snap, side) ? snap[side] : undefined);
  // Peer id to node name. A node keeps the id it last reported from an open view of its own
  // provider, so one missed poll does not strip its name from every other card; a fallback
  // provider's view is never used for naming (it may be another machine). Config order wins
  // when two labels report the same id (one node listed twice).
  const knownPeerIds = new Map<Side, string>();
  const peerNames = (snap: Record<Side, MeshSummary>): Map<string, string> => {
    for (const n of cfg.nodes) {
      const v = meshOf(snap, n.label);
      if (v !== undefined && !v.fallback && v.self?.peerId) knownPeerIds.set(n.label, v.self.peerId);
    }
    const m = new Map<string, string>();
    for (const n of cfg.nodes) {
      const id = knownPeerIds.get(n.label);
      if (id !== undefined && !m.has(id)) m.set(id, label(n.label));
    }
    return m;
  };
  const shortPeer = (id: string) => `${id.slice(0, 12)}…`;
  // Header tile above each node card: "<network> reference" on every network's reference
  // (REFERENCE_NODE and the per-network references), "<network> node" on the rest, and
  // "validator" in place of "node" (or after "reference") when NODE_<K>_VALIDATOR is set, so a
  // read-only node and a validator read apart. The title line keeps only the name and the
  // up/down pill. Colors come from data-net in the CSS.
  const headTile = (s: Side): string => {
    const n = nodeOf(cfg, s);
    const net = n?.network ?? "";
    const isRef = Object.values(cfg.references).includes(s);
    const role = isRef ? `reference${n?.validator ? " validator" : ""}` : n?.validator ? "validator" : "node";
    // Role only: every card sits under its network's group heading, and the head's color still marks
    // the network (data-net), so the name here repeated it (operator, 2026-11-26: no redundant information).
    return `<div class="head${isRef ? " ref" : ""}">${role}</div>`;
  };
  const nodeLabels = cfg.nodes.map((n) => n.label);
  const nets = networks(cfg);
  // A testnet network (src/config.ts isTestnetNetwork) belongs to the page's Testnet tab (see
  // GET /). The API routes below keep every network; only the page splits them.
  const isTestnet = isTestnetNetwork;
  const allNets = nets;
  const hasTestnet = allNets.some((n) => isTestnet(n.network));
  // Consensus view (src/consensus.ts): for a network with a validators file, each shard's
  // validators split into at tip, behind, down and not monitored, against the quorum. Keys
  // come from the peer ids the peer view already read; heights from the latest info rows.
  const consensusFor = (network: string, infos: Record<Side, InfoSnapshot | null>): ShardConsensus[] | null => {
    const vs = sets?.(network);
    if (!vs) return null;
    const snap = meshSnap();
    // A node that stops answering loses its peer view, and with it the key that ties it to
    // the set; it then read "not monitored" instead of "down" (seen 2026-11-22 with two
    // validators mid-upgrade). The peer id a node last reported is remembered for the life
    // of this process (knownPeerIds, refreshed by peerNames), so its key is derived from
    // that first. After a snapdiff restart a node that has been down the whole time is
    // still unknown, and says so.
    peerNames(snap);
    const keyOf = (l: Side): string | null => {
      const id = knownPeerIds.get(l);
      return (id !== undefined ? keyFromPeerId(id)?.slice(0, 8) : undefined) ?? meshOf(snap, l)?.self?.keyPrefix ?? null;
    };
    const labels = allNets.find((n) => n.network === network)?.labels ?? [];
    const nodes: ConsensusNode[] = labels.map((l) => {
      const i = infos[l];
      return { label: l, name: label(l), keyPrefix: keyOf(l), reachable: i?.reachable === true, shards: i?.shards.map((x) => ({ shardId: x.shardId, maxHeight: x.maxHeight })) ?? [] };
    });
    return shardConsensus(nodes, vs);
  };
  const consensusAll = (infos: Record<Side, InfoSnapshot | null>): Record<string, ShardConsensus[]> =>
    Object.fromEntries(allNets.map((n) => [n.network, consensusFor(n.network, infos)] as const).filter((e): e is readonly [string, ShardConsensus[]] => e[1] !== null));
  const networkMap = Object.fromEntries(nets.map((x) => [x.network, x.labels]));
  const latestInfos = async (): Promise<Record<Side, InfoSnapshot | null>> =>
    Object.fromEntries(await Promise.all(nodeLabels.map(async (l) => [l, await store.latestInfo(l)] as const)));

  app.get("/api/summary", async (c) => {
    const [summary, info, open] = await Promise.all([store.summary(), latestInfos(), store.openStalls()]);
    // meta[label]: what the page prints for each node, so the Telegram bot says the same thing
    // (operator, 2026-11-25): the display name (NODE_<K>_NAME), the role, and the pill state
    // (nodeState: up, degraded, down, or no data). Before this the bot called a node 16 h
    // behind "up" while the page said "degraded", and used labels where the page shows names.
    const meta = Object.fromEntries(
      cfg.nodes.map((n) => {
        const i = info[n.label] ?? null;
        const stalled = i?.shards.some((x) => open.some((o) => o.side === n.label && o.shardId === x.shardId)) ?? false;
        return [n.label, { name: label(n.label), validator: n.validator === true, reference: Object.values(cfg.references).includes(n.label), state: nodeState(i, cfg.behindBlockDelay, stalled) }] as const;
      }),
    );
    // versions[network]: newest version its reachable nodes report (src/versions.ts); the bot
    // compares info[label].version against it to say "behind". releases[network]: newest
    // version the project has published (src/releases.ts), the earlier signal; {} when off.
    return c.json({ nodes: nodeLabels, networks: networkMap, reference: cfg.reference, references: cfg.references, summary, info, meta, versions: latestVersions(networkMap, info), releases: releases?.() ?? {} });
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

  // Testnet cast explorer (src/testnet-feed.ts): newest casts per testnet network, {} when off.
  app.get("/api/testnet/casts", (c) => c.json({ feeds: feed?.() ?? {} }));

  // Peer view per node (src/mesh.ts) plus the peer id to node name map the page uses.
  app.get("/api/mesh", (c) => {
    const snap = meshSnap();
    return c.json({ source: "currentPeers", mesh: snap, names: Object.fromEntries(peerNames(snap)), networks: cfg.meshNetworks, validatorSets: Object.keys(cfg.validatorSetUrls) });
  });

  // Per network and shard: validators of the current set at the tip (able to vote), behind,
  // down, or not monitored, with the quorum. README "Consensus view" explains the limits.
  app.get("/api/consensus", async (c) => {
    const infos = await latestInfos();
    return c.json({ at: Date.now(), source: "info+validators", tolerance: 30, networks: consensusAll(infos), lines: Object.fromEntries(Object.entries(consensusAll(infos)).map(([n, rows]) => [n, rows.map(consensusLine)])) });
  });

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
    const [rows, stalls, latest, infos] = await Promise.all([
      store.recentInfo(label, hours * 60 + 120, fromMs),
      store.listStalls({ side: label, fromMs, limit: 200 }),
      store.latestInfo(label),
      latestInfos(),
    ]);
    const up = rows.filter((r) => r.reachable);
    const delays = up.map((r) => r.maxBlockDelay).filter((d): d is number => d !== null);
    const openShards = new Set(stalls.filter((s) => s.endedAt === null).map((s) => s.shardId));
    return c.json({
      label,
      name: node.name ?? label,
      network: node.network,
      reference: Object.values(cfg.references).includes(label),
      validator: node.validator === true,
      version: versionView(latest?.version, latestVersions(networkMap, infos)[node.network] ?? null),
      // Newest published version on this node's network (src/releases.ts), null when unknown or off.
      release: releases?.()[node.network] ?? null,
      mesh: meshOf(meshSnap(), label) ?? null,
      state: nodeState(latest, cfg.behindBlockDelay, latest?.shards.some((s) => openShards.has(s.shardId)) ?? false),
      latest,
      window: {
        hours,
        fromMs,
        toMs: now,
        samples: rows.length,
        up: up.length,
        // Of the samples that answered, those past BEHIND_BLOCK_DELAY (catching up or stalled).
        degraded: up.filter((r) => r.maxBlockDelay !== null && r.maxBlockDelay > cfg.behindBlockDelay).length,
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

  // Public origin from the proxy headers when behind Caddy, else from the request (same rule
  // as /llms.txt): the Mini App manifest and embed need absolute URLs on the real host name.
  const originOf = (c: { req: { url: string; header: (n: string) => string | undefined } }): string => {
    const url = new URL(c.req.url);
    const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
    const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
    return `${proto}://${host}`;
  };

  // Mini App files (src/miniapp.ts): the ready() module, the vendored SDK, the three images.
  // Only this directory is served; it holds nothing generated at runtime.
  app.use("/static/*", serveStatic({ root: "./", rewriteRequestPath: (p) => p }));

  // Mini App manifest: 404 with a plain reason until the operator sets the association.
  app.get("/.well-known/farcaster.json", (c) => {
    const m = manifestJson(cfg, originOf(c));
    if (m === null) return c.text("Mini App manifest is off: MINIAPP_ASSOCIATION_* not set", 404);
    return c.json(m);
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
    // Two views of one page. A network whose name contains "testnet" renders on the Testnet
    // tab (/?net=testnet) and nowhere else; everything else is the Mainnet tab (/). The
    // mainnet-only sections (relay counts, split, unexplained, pending) stay off the testnet
    // tab because the relay compares the two mainnets. Tabs are plain links, not script: the
    // Caddy CSP pins the page's single inline script by hash (test/csp.test.ts). Operator,
    // 2026-11-17: testnet cards inside the mainnet overview were confusing.
    // A third view, /?view=cards (operator, 2026-11-25): every mainnet node card on its own tab,
    // grouped by chain, filtered by ?chain=<network> (anything else shows every chain). The
    // filter is plain links like the tabs, so it survives the 30 s reload and can be shared.
    // The Mainnet tab keeps the index; its rows link here.
    const view: "mainnet" | "testnet" | "cards" =
      c.req.query("view") === "cards" ? "cards" : hasTestnet && c.req.query("net") === "testnet" ? "testnet" : "mainnet";
    const nets = allNets.filter((n) => isTestnet(n.network) === (view === "testnet"));
    const chain = view === "cards" && nets.some((n) => n.network === c.req.query("chain")) ? (c.req.query("chain") as string) : null;
    const nodeLabels = nets.flatMap((n) => n.labels);
    const inView = new Set<Side>(nodeLabels);
    const [summary, infos, unexplained, pending, recentStalls, openStalls] = await Promise.all([
      store.summary(),
      latestInfos(),
      store.listDiffs({ cause: "unexplained", limit: 100 }),
      store.listDiffs({ cause: "pending", limit: 25 }),
      store.listStalls({ limit: 2000 }),
      store.openStalls(),
    ]);
    // Newest 2000 plus anything still open beyond them, each once, newest first.
    const stalls = [...recentStalls, ...openStalls.filter((o) => !recentStalls.some((r) => r.id === o.id))].filter((s) => inView.has(s.side)).sort((a, b) => b.startedAt - a.startedAt);
    const openStall = (side: Side, shardId: number) => stalls.some((s) => s.side === side && s.shardId === shardId && s.endedAt === null);
    const stateOf = (side: Side, i: InfoSnapshot | null): NodeState => nodeState(i, cfg.behindBlockDelay, i?.shards.some((x) => openStall(side, x.shardId)) ?? false);
    const behindSec = cfg.behindBlockDelay;
    // The header pill counts the open stalls of this tab's nodes only. summary.openStalls is
    // database-wide, so the Testnet tab was showing mainnet stalls in red (operator's screenshot,
    // 2026-11-19).
    const openInView = stalls.filter((s) => s.endedAt === null).length;
    const latestByNet = latestVersions(networkMap, infos);

    // Peer view lines under the version: the one-line summary, then the validator rows for an
    // open view. Nothing is printed for a node outside MESH_NETWORKS.
    const meshAll = meshSnap();
    const names = peerNames(meshAll);
    const meshLines = (side: Side): string => {
      const m = meshOf(meshAll, side);
      if (m === undefined) return "";
      // Current-set validators only; next-set peers stay in the API (validator false, joinsAt)
      // and out of the row (operator, 2026-11-20: the "(joins at N)" suffixes were noise).
      const rows = m.validators.filter((p) => p.validator).map((p) => {
        const name = names.get(p.peerId);
        const text = name ?? `${p.keyPrefix} ${shortPeer(p.peerId)}`;
        return `<span class="peer" title="${esc(`${name ? `${name}, ` : ""}peer ${p.peerId}, key ${p.keyPrefix}…`)}">${esc(text)}</span>`;
      });
      const joins = m.self?.joinsAt ? ` Its own key enters the set at height ${m.self.joinsAt.toLocaleString("en-US")}.` : "";
      const meshTitle = `Peer list read ${ago(m.at, now)} from this node. Role: whether this node's own key is in the current validator set.${joins} Connected: validators of the current set among its peers, out of the set minus itself.`;
      return `<p class="muted mesh" title="${esc(meshTitle)}">peers: ${esc(meshLine(m).replace(/^peers: /, ""))}${m.fallback ? ", via fallback provider" : ""}</p>${rows.length > 0 ? `<p class="muted peers">validators: ${rows.join(", ")}</p>` : ""}`;
    };

    const nodeCard = (side: Side, i: InfoSnapshot | null, extra: boolean) => {
      const status = stateOf(side, i);
      const cls = STATE_CLASS[status];
      // Version line: "v0.17.4" plus a red "behind 0.17.5" pill when a reachable node on the
      // same network runs something newer (src/versions.ts). Omitted when the node reports none.
      const ver = versionView(i?.version, latestByNet[nodeOf(cfg, side)?.network ?? ""] ?? null);
      // Published pill (src/releases.ts): the project has shipped something newer than this node
      // runs and no node on the network runs it yet. Once a peer runs it the behind pill carries
      // the same number, so the published pill steps aside rather than repeat it.
      const rel = releases?.()[nodeOf(cfg, side)?.network ?? ""] ?? null;
      const published = rel?.version && ver.current && compareVersions(ver.current, rel.version) < 0 && !(ver.behind && ver.latest === rel.version) ? rel : null;
      const pubLine = published
        ? ` <span class="pill warn" title="published ${published.publishedAt === null ? "" : `${ago(published.publishedAt, now)}, `}no node on this network runs it yet">${esc(published.version ?? "")} published</span>`
        : "";
      const verLine = ver.current
        ? `<p class="muted">v${esc(ver.current)}${ver.behind ? ` <span class="pill bad" title="newest on this network: ${esc(ver.latest ?? "")}">behind ${esc(ver.latest ?? "")}</span>` : ""}${pubLine}</p>`
        : "";
      const shards =
        i?.shards
          .slice()
          .sort((x, y) => x.shardId - y.shardId)
          .map(
            (s) =>
              `<tr><td>${s.shardId}${openStall(side, s.shardId) ? ` <span class="pill bad">stalled</span>` : s.blockDelay > behindSec ? ` <span class="pill warn">behind</span>` : ""}</td><td>${s.maxHeight.toLocaleString()}</td><td title="${s.blockDelay} s">${fmtDelay(s.blockDelay)}</td></tr>`,
          )
          .join("") ?? "";
      // Host on its own line, never wrapped: a long host is cut with an ellipsis (full text in
      // the title) instead of breaking mid-word, and "checked" sits on the next line so every
      // card has the same shape. Operator, 2026-11-11: a wrapped host pushed the dot onto line two.
      const host = `${i?.provider ?? (nodeOf(cfg, side)?.private ? side : hostOf(nodeOf(cfg, side)?.url ?? ""))}${(nodeOf(cfg, side)?.providers.length ?? 1) > 1 ? ` (${nodeOf(cfg, side)?.providers.length} providers)` : ""}`;
      // A card does not fold on its own; only the chain group around it does (operator, 2026-11-25:
      // per-card arrows were not what was asked for and were removed the same day).
      // No "all nodes" link per card (operator, 2026-11-27): the same link repeated on every card;
      // the tabs and the browser's back button already return to the index.
      return `<div class="col" id="node-${esc(side)}" data-net="${esc(nodeOf(cfg, side)?.network ?? "")}"${extra ? " data-extra" : " data-pin"}>${headTile(side)}<section class="card">
        <h2>${esc(label(side))} <span class="pill ${cls}">${status}</span></h2>
        <p class="muted host" title="${esc(host)}">${esc(host)}</p>
        <p class="muted">checked ${ago(i?.at ?? null, now)}</p>
        ${verLine}
        ${meshLines(side)}
        ${i?.note ? `<p class="warn">${esc(i.note)}</p>` : ""}
        ${status === "degraded" && i ? `<p class="warn">${(i.maxBlockDelay ?? 0) > behindSec ? `${fmtDelay(i.maxBlockDelay ?? 0)} behind` : "Shard stalled"}</p>` : ""}
        ${i?.error ? `<p class="bad-text">${esc(i.error)}</p>` : ""}
        ${shards ? `<table><thead><tr><th>Shard</th><th>Height</th><th>Block delay</th></tr></thead><tbody>${shards}</tbody></table>` : ""}
      </section></div>`;
    };

    // Node index: every node of the view on one screen, one line each, linking to its card.
    // Two people reported in 2026-11 that a specific validator was hard to reach: the cards
    // were paged with arrows, and on a phone one node showed at a time. The index answers
    // "is my validator fine" without scrolling, and the cards below all render at once.
    // Within a network: the reference first, then validators, then read nodes, each in
    // config order. Links are plain anchors, so the page still has no script of its own here.
    const fmtDelay = (sec: number): string => (sec < 120 ? `${sec}s` : sec < 7200 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`);
    const indexRow = (side: Side): string => {
      const n = nodeOf(cfg, side);
      const i = infos[side] ?? null;
      const ver = versionView(i?.version, latestByNet[n?.network ?? ""] ?? null);
      const isRef = Object.values(cfg.references).includes(side);
      const role = `${n?.validator ? "validator" : "read node"}${isRef ? ", reference" : ""}`;
      const shardCells =
        i === null
          ? `<span class="muted">no data yet</span>`
          : !i.reachable
            ? `<span class="bad-text">not answering</span>`
            : i.shards
                .slice()
                .sort((x, y) => x.shardId - y.shardId)
                .map((x) => `<span class="sh${openStall(side, x.shardId) ? " bad" : x.blockDelay > behindSec ? " warn" : ""}" title="shard ${x.shardId}: height ${x.maxHeight.toLocaleString("en-US")}, block delay ${x.blockDelay} s${openStall(side, x.shardId) ? ", stalled" : x.blockDelay > behindSec ? ", behind" : ""}"><i>${x.shardId}</i>${fmtDelay(x.blockDelay)}</span>`)
                .join("");
      return `<a class="irow" href="${view === "mainnet" ? "/?view=cards" : ""}#node-${esc(encodeURIComponent(side))}"><span class="iname">${esc(label(side))}</span><span class="pill ${STATE_CLASS[stateOf(side, i)]}">${stateOf(side, i)}</span><span class="iver${ver.behind ? " bad" : ""}"${ver.behind ? ` title="behind ${esc(ver.latest ?? "")}"` : ""}>${ver.current ? `v${esc(ver.current)}` : ""}</span><span class="irole">${role}</span><span class="ish">${shardCells}</span></a>`;
    };
    // Each network is a group that folds on its own to one line: the letter badge (H or S,
    // colored by networkState) and the network name. Snapchain sorts below every other network
    // (operator, 2026-11-24); the rest keep config order.
    const indexNets = [...nets].sort((a, b) => Number(a.network.includes("snapchain")) - Number(b.network.includes("snapchain")));
    // One order for a network's nodes everywhere (index rows and cards): the reference first,
    // then validators, then read nodes, each in config order.
    const orderNet = (labels: Side[]): Side[] => {
      const refs = labels.filter((l) => Object.values(cfg.references).includes(l));
      const vals = labels.filter((l) => !refs.includes(l) && nodeOf(cfg, l)?.validator);
      const readers = labels.filter((l) => !refs.includes(l) && !nodeOf(cfg, l)?.validator);
      return [...refs, ...vals, ...readers];
    };
    const netBadge = (network: string, labels: Side[]): string => {
      const down = labels.filter((l) => infos[l]?.reachable !== true).length;
      const degraded = labels.filter((l) => stateOf(l, infos[l] ?? null) === "degraded").length;
      const stateText = `${network}: ${labels.length - down} of ${labels.length} node${labels.length === 1 ? "" : "s"} answering${degraded > 0 ? `, ${degraded} of them degraded (behind or stalled)` : ""}. Green while under 41% are down, yellow at 41% or more, red when none answer.`;
      return `<span class="nb ${networkState(labels.length, down)}" role="img" aria-label="${esc(stateText)}" title="${esc(stateText)}">${netLetter(network)}</span>`;
    };
    // Node cards grouped by chain in the same order as the index (Hypersnap above Snapchain),
    // each group folding on its own to its badge and name. Operator, 2026-11-25: the cards mixed
    // the two chains in config order.
    const cardGroups = (): string =>
      indexNets
        .filter((n) => chain === null || n.network === chain)
        .map(({ network, labels }) => {
          const gid = `cards-${network}`;
          return `<div class="grp fold-box cgrp" id="${esc(gid)}" data-name="${esc(network)} cards"><div class="grp-head">${netBadge(network, labels)}<h3>${esc(network)} <span class="muted">${labels.length} card${labels.length === 1 ? "" : "s"}</span></h3>${foldBtn(gid, `${network} cards`)}</div><div class="sec-body" id="${esc(gid)}-body"><div class="sec-in"><div class="grid nodes">${orderNet(labels).map((l) => nodeCard(l, infos[l] ?? null, extraSet.has(l))).join("")}</div></div></div></div>`;
        })
        .join("");
    const indexHtml = (): string =>
      sec(
        "index",
        "Nodes",
        "Nodes",
        `<p class="muted">Tap a node to view its card.</p>
${indexNets
  .map(({ network, labels }) => {
    const nVal = labels.filter((l) => nodeOf(cfg, l)?.validator).length;
    const gid = `grp-${network}`;
    return `<div class="grp fold-box" id="${esc(gid)}" data-name="${esc(network)}"><div class="grp-head">${netBadge(network, labels)}<h3>${esc(network)} <span class="muted">${nVal} validator${nVal === 1 ? "" : "s"}, ${labels.length - nVal} read node${labels.length - nVal === 1 ? "" : "s"}</span></h3>${foldBtn(gid, network)}</div><div class="sec-body" id="${esc(gid)}-body"><div class="sec-in">
<div class="irows">${orderNet(labels).map(indexRow).join("")}</div></div></div></div>`;
  })
  .join("")}`,
      );

    // Since 2026-11-22 every card renders and nothing is paged. The data-pin and data-extra
    // attributes and the inline pager script below are kept unchanged on purpose: the script's
    // hash is pinned in deploy/Caddyfile (test/csp.test.ts), and with no pager element it
    // returns at once. Removing it means changing the Caddy CSP in the same deploy.
    // Node cards: the first configured node of every network is pinned on the left
    // (with two networks that is the reference and its first peer); any further
    // nodes share the remaining slots and page with the arrows. Pure presentation.
    const chainFilter = (): string =>
      `<nav class="jump seg" aria-label="Chain">${indexNets
        .map(({ network }) => `<a class="hue ${netHue(network)}${chain === network ? ' on" aria-current="page' : ""}" href="/?view=cards&amp;chain=${esc(encodeURIComponent(network))}">${esc(network.charAt(0).toUpperCase() + network.slice(1))} only</a>`)
        .join("")}<a class="hue c-blue${chain === null ? ' on" aria-current="page' : ""}" href="/?view=cards">Both</a></nav>`;
    const pinnedLabels = nets.map((n) => n.labels[0]).filter((l): l is Side => l !== undefined);
    const extraLabels = nodeLabels.filter((l) => !pinnedLabels.includes(l));
    const extraSet = new Set(extraLabels);

    // Diffs by cause: five number tiles whose explanation shows on hover or focus only (operator,
    // 2026-11-24: the always-visible help text made the row tall), and a bar per cause as the
    // alternative view, switched by the Chart / Numbers button (static/fold.js remembers it).
    // Bars share one scale from zero; the colors repeat the tiles' (red unexplained, amber
    // pending, muted for the expected causes) and every bar carries its name and number, so
    // color is never the only label.
    const CAUSE_ORDER = ["unexplained", "pending", "relay_filtered", "version_rule", "sync_lag"] as const;
    const counts = CAUSE_ORDER.map(
      (k) => `<div class="stat ${k}" tabindex="0"><div class="n">${summary.byCause[k]}</div><div class="k">${k.replace("_", " ")}</div>
        <div class="help" role="tooltip">${CAUSE_HELP[k]}</div></div>`,
    ).join("");
    const causeMax = Math.max(1, ...CAUSE_ORDER.map((k) => summary.byCause[k]));
    const causeChart = `<div class="cchart" role="img" aria-label="${esc(`Diffs by cause: ${CAUSE_ORDER.map((k) => `${k.replace("_", " ")} ${summary.byCause[k]}`).join(", ")}`)}">${CAUSE_ORDER.map((k) => {
      const v = summary.byCause[k];
      const pct = v === 0 ? 0 : Math.max(0.4, (v / causeMax) * 100);
      return `<div class="crow" title="${esc(`${k.replace("_", " ")}: ${v}. ${CAUSE_HELP[k]}`)}"><span class="ck">${k.replace("_", " ")}</span><span class="ctrack"><i class="cbar ${k}" style="width:${pct.toFixed(1)}%"></i></span><span class="cn">${v}</span></div>`;
    }).join("")}</div>`;
    const causesHtml = () =>
      sec("causes", "Diffs by cause", "Diffs by cause", `<div class="stats">${counts}</div>${causeChart}`, `<button class="vt" type="button" aria-pressed="false">Chart</button>`);

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
    // Consensus card: one row per shard of each network in view that has a validators file.
    // Red when fewer validators can vote than a block needs, amber at exactly the quorum.
    const CONS_CLASS: Record<ShardConsensus["state"], string> = { ok: "ok", edge: "warn", short: "bad", unknown: "muted" };
    const consensusHtml = (networksInView: string[]): string => {
      const all = consensusAll(infos);
      const rows = networksInView.flatMap((n) => (all[n] ?? []).map((r) => [n, r] as const));
      if (rows.length === 0) return "";
      return sec("consensus", "Consensus", "Consensus", `<p class="muted">Per shard: validators of the set in force whose node is at the tip and can vote, against the signatures a block needs (more than two thirds of the set). Read from each node's own heights and the published validators file. Block signers are not on the HTTP API, so "can vote" is the nearest measurable thing to "signing"; a validator snapdiff does not monitor is counted as unknown, never as a vote.</p>
<div class="scroll"><table><thead><tr><th>Network</th><th>Shard</th><th>Can vote</th><th>Quorum</th><th>Behind</th><th>Down</th><th>Not monitored</th></tr></thead><tbody>
${rows
  .map(([n, r]) => `<tr><td>${esc(n)}</td><td>${r.shardId}</td><td><span class="pill ${CONS_CLASS[r.state]}">${r.state === "unknown" ? "set not loaded" : `${r.atTip.length} of ${r.setSize}`}</span>${r.atTip.length > 0 ? ` <span class="muted">${esc(r.atTip.join(", "))}</span>` : ""}</td><td>${r.state === "unknown" ? "" : r.quorum}</td><td>${esc(r.behind.map((b) => `${b.name} (${b.lag.toLocaleString("en-US")})`).join(", "))}</td><td>${esc(r.down.join(", "))}</td><td>${r.unmonitored.length > 0 ? `${r.unmonitored.length} <span class="muted">${esc(r.unmonitored.join(", "))}</span>` : ""}</td></tr>`)
  .join("")}</tbody></table></div>`);
    };
    const STATUS_CLASS: Record<ClientStatus, string> = { ok: "ok", degraded: "warn", down: "bad", unknown: "muted" };
    const clientsHtml = (list: ClientHealth[]) =>
      list.length === 0
        ? ""
        : sec("clients", "Clients", "Clients", `<p class="muted">Apps people use on each network, checked every ${Math.round(cfg.clientHealthIntervalMs / 1000)} s against the status endpoint each one publishes. Links go to the client's own site.</p>
<div class="scroll"><table><thead><tr><th>Client</th><th>Network</th><th>Status</th><th>Latency</th><th>Checked</th><th>Note</th></tr></thead><tbody>
${list
  .map((h) => {
    const status: ClientStatus = CLIENT_STATUSES.includes(h.status) ? h.status : "unknown";
    return `<tr><td><a href="${esc(h.siteUrl)}" rel="noopener noreferrer" target="_blank">${esc(h.label)}</a> <span class="muted">${esc(h.siteHost)}</span></td>
<td>${esc(h.network)}</td><td><span class="pill ${STATUS_CLASS[status]}">${status}</span></td>
<td>${h.latencyMs === null ? "" : `${h.latencyMs} ms`}</td><td>${ago(h.checkedAt, now)}</td><td>${esc(h.note)}</td></tr>`;
  })
  .join("")}</tbody></table></div>${cfg.clientHealthCredit ? `<p class="muted" style="margin:8px 0 0">List from <a href="${esc(cfg.clientHealthCredit.url)}" rel="noopener noreferrer" target="_blank">${esc(cfg.clientHealthCredit.text)}</a>.</p>` : ""}`);

    // A shard stalled on every node of one network is that network stalling, not a node:
    // either every label of the network has an open row, or the detector recorded the rows
    // with scope "network" (every reachable node over the threshold, a down node excluded).
    const networkWideStalls = (rows: StallRow[]): string[] => {
      const openOn = new Map<number, Set<Side>>();
      const flagged = new Set<string>();
      for (const s of rows) {
        if (s.endedAt !== null) continue;
        const set = openOn.get(s.shardId) ?? new Set<Side>();
        set.add(s.side);
        openOn.set(s.shardId, set);
        if (s.scope === "network") flagged.add(`${nodeOf(cfg, s.side)?.network ?? "?"} shard ${s.shardId}`);
      }
      const out: string[] = [];
      for (const { network, labels } of nets) {
        for (const [shardId, nodes] of openOn) if (labels.every((l) => nodes.has(l))) out.push(`${network} shard ${shardId}`);
      }
      for (const f of flagged) if (!out.includes(f)) out.push(f);
      return out;
    };

    // Testnet cast explorer: one card per testnet network under the node cards. Text and hash
    // are the only response strings shown; text is escaped, the hash was hex-checked by the
    // feed. Nothing here is a link.
    const feedHtml = () =>
      nets
        .map(({ network }) => {
          const f = feed?.()[network];
          if (f === undefined) return "";
          const rows = f.casts
            .map(
              (x) =>
                `<tr><td>${ago(x.at, now)}</td><td>${x.fid}</td><td class="text${x.text.includes("\n") ? " pre" : ""}">${esc(x.text)}${x.replyTo ? ` <span class="muted">reply to ${esc(x.replyTo)}</span>` : ""}${x.embeds > 0 ? ` <span class="muted">${x.embeds} embed${x.embeds === 1 ? "" : "s"}</span>` : ""}</td><td class="mono">${esc(x.hash.slice(0, 12))}…</td></tr>`,
            )
            .join("");
          return sec(`casts-${network}`, `Casts on ${network}`, `Casts on ${esc(network)}`, `<p class="muted">Newest ${f.casts.length} across ${f.fids} account${f.fids === 1 ? "" : "s"}, read from ${esc(label(f.source))} ${f.checkedAt === null ? "(not yet)" : ago(f.checkedAt, now)}${f.error ? `; last read failed: ${esc(f.error)}` : ""}. Also at /api/testnet/casts.</p>
${rows === "" ? `<p class="muted">No casts yet. Register an account and post one with tools/first-cast in the testnet repo.</p>` : `<div class="scroll"><table><thead><tr><th>When</th><th>FID</th><th>Text</th><th>Hash</th></tr></thead><tbody>${rows}</tbody></table></div>`}`);
        })
        .join("");

    // Page order below the jump links (operator, 2026-11-25): one "Node info" card (id nodeinfo) around
    // every node-health card (index, the testnet's cards, consensus, stalls), each still folding on
    // its own, so folding Node info leaves Clients as the next open card. The split table counts
    // diffs, so it sits with the diff sections after Clients.
    const splitHtml = () => sec("split", "Network split", "Network split", `<p class="muted">A cast missing on every node of a network is a disagreement between the networks (scope "network"). A cast missing on one node while another node on its network has it is that node's problem (scope "node"). Unexplained by scope: node ${summary.byScope.node}, network ${summary.byScope.network}. Judged when each row is first seen, from the nodes that answered.</p>
<div class="scroll"><table><thead><tr><th>Network</th><th>Nodes</th><th>Casts missing on all its nodes: unexplained</th><th>pending</th></tr></thead><tbody>
${nets
  .map(
    ({ network, labels }) =>
      `<tr><td>${esc(network)}</td><td>${labels.map((l) => esc(label(l))).join(", ")}</td><td>${(summary.networkSplit[network]?.unexplained ?? 0) > 0 ? `<span class="pill bad">${summary.networkSplit[network]?.unexplained}</span>` : "0"}</td><td>${summary.networkSplit[network]?.pending ?? 0}</td></tr>`,
  )
  .join("")}</tbody></table></div>`);

    // One line per node and shard, newest first: its latest stall (any age) plus how many and how
    // long in the last 7 days. A pair with more than one stall opens on click to list them all (<details>:
    // no script, because the page's only inline script is hash-pinned in the Caddy CSP).
    // Operator, 2026-11-10: one busy node was filling the whole table.
    // The first column is at least 210px and clips with an ellipsis: on a phone the 110px column let
    // "castrater (network-wide)" run under the shard digit (operator's screenshot, 2026-11-13).
    // A network-wide row's peer is a clock, not a peering: the healthiest node elsewhere, kept
    // as evidence that time passed (src/stall.ts). When that node sits on the other network
    // kind it is not named on this tab and its height is not shown: a mainnet node and height
    // on a testnet row read as a crossover (operator's screenshot, 2026-11-19). A peer on this
    // tab's own kind (hypersnap against snapchain on the Mainnet tab) is shown as before.
    const otherKind = (peer: Side | null): boolean => {
      const n = peer === null ? undefined : nodeOf(cfg, peer);
      return n !== undefined && isTestnet(n.network) !== (view === "testnet");
    };
    const peerCells = (s: StallRow) =>
      otherKind(s.peer)
        ? `<td><span class="muted" title="Every ${esc(nodeOf(cfg, s.side)?.network ?? "")} node was stopped on this shard. Its duration was measured against a node on another network, which this tab does not show.">whole network</span></td><td><span class="muted">n/a</span></td>`
        : `<td>${s.peer ? esc(label(s.peer)) : ""}</td><td>${(s.peerHeightEnd ?? s.peerHeightStart).toLocaleString()}</td>`;
    const stallCells = (s: StallRow) =>
      `<td>${new Date(s.startedAt).toISOString().replace("T", " ").slice(0, 19)}Z</td><td>${s.endedAt === null ? `<span class="pill bad">ongoing ${dur(s.startedAt, now)}</span>` : dur(s.startedAt, s.endedAt)}</td><td>${s.stuckHeight.toLocaleString()}</td>${peerCells(s)}<td>${s.maxBlockDelay}s</td>`;
    const stallsHtml = (rows: StallRow[]) => {
      if (rows.length === 0) return `<p class="muted">None recorded.</p>`;
      const groups = new Map<string, StallRow[]>();
      for (const s of rows) {
        const k = `${s.side}\u0000${s.shardId}`;
        groups.set(k, [...(groups.get(k) ?? []), s]);
      }
      const spans = (s: StallRow) => stallCells(s).replace(/<td>/g, "<span>").replace(/<\/td>/g, "</span>");
      const head = `<div class="hdr"><span>Node</span><span>Shard</span><span>Latest started</span><span>Duration</span><span>Stuck at</span><span>Compared with</span><span>Its height</span><span>Worst delay</span><span>Last 7 d</span></div>`;
      const body = [...groups.values()]
        .map((g) => {
          const latest = g[0]!;
          const recent = g.filter((s) => s.endedAt === null || s.startedAt >= now - STALL_WINDOW_MS);
          const total = recent.reduce((t, s) => t + ((s.endedAt ?? now) - s.startedAt), 0);
          const week = recent.length === 0 ? "none" : `${recent.length} stall${recent.length === 1 ? "" : "s"}, ${dur(0, total)}`;
          const line = `<span>${esc(label(latest.side))}${latest.scope === "network" ? " (network-wide)" : ""}</span><span>${latest.shardId}</span>${spans(latest)}<span>${week}</span>`;
          if (g.length === 1) return `<div class="row">${line}</div>`;
          return `<details class="group"><summary>${line}</summary><table><thead><tr><th>Started</th><th>Duration</th><th>Stuck at</th><th>Compared with</th><th>Its height</th><th>Worst delay</th></tr></thead><tbody>${g.slice(0, 100).map((s) => `<tr>${stallCells(s)}</tr>`).join("")}</tbody></table></details>`;
        })
        .join("");
      return `<div class="scroll"><div class="stalls">${head}${body}</div></div>`;
    };

    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30">
<title>snapdiff</title>
<meta name="fc:miniapp" content="${esc(embedJson(cfg, originOf(c), view === "testnet" ? "/?net=testnet" : view === "cards" ? "/?view=cards" : "/"))}">
<meta name="fc:frame" content="${esc(embedJson(cfg, originOf(c), view === "testnet" ? "/?net=testnet" : view === "cards" ? "/?view=cards" : "/"))}">
<meta property="og:title" content="${esc(cfg.miniapp.name)}"><meta property="og:description" content="Snapchain and Hypersnap node health"><meta property="og:image" content="${esc(originOf(c))}/static/embed.png">
<script type="module" src="/static/miniapp.mjs"></script>
<script src="/static/fold.js"></script>
<style>
:root{--bg:#f7f7f5;--fg:#1c1c1a;--muted:#6b6b66;--card:#fff;--line:#e3e2dd;--ok:#2f7d4f;--bad:#b3261e;--warn:#9a6700;--fc:#8a63d2;--fc-bg:#f6f2fc;--fc-line:#c9b6ea;--tn:#a855f7;--tn-bg:#f5ecff;--tn-line:#d8b4fe;--link:#1d4ed8;--brand:#008b8b}
@media (prefers-color-scheme:dark){:root{--brand:#00ffff;--bg:#141413;--fg:#ecebe6;--muted:#9c9b95;--card:#1d1d1b;--line:#33322f;--ok:#5cc58a;--bad:#f2867c;--warn:#e0b44c;--fc:#8a63d2;--fc-bg:#231c33;--fc-line:#5d4a85;--tn:#b975ff;--tn-bg:#2a1b47;--tn-line:#7a52c4;--link:#9db9ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
a,a:visited{color:var(--link);text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--link) 50%,transparent);text-underline-offset:2px}a:hover{text-decoration-color:var(--link)}
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
.stalls{min-width:1040px}.stalls .hdr,.stalls .row,.stalls summary{display:grid;grid-template-columns:minmax(210px,1.4fr) 44px 150px 118px 96px minmax(90px,1fr) 96px 80px 122px;gap:0 8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--line);font-size:14px;white-space:nowrap}
.stalls .hdr{font-weight:600;color:var(--muted)}.stalls .row>span:first-child,.stalls summary>span:first-child{padding-left:1.2em;position:relative;min-width:0;overflow:hidden;text-overflow:ellipsis}
.stalls summary{cursor:pointer;list-style:none}.stalls summary::-webkit-details-marker{display:none}.stalls summary>span:first-child::before{content:"\\25B8";position:absolute;left:0;color:var(--muted)}.stalls details[open]>summary>span:first-child::before{content:"\\25BE"}
.stalls details>table{width:auto;margin:4px 8px 10px 2.2em}.stalls details>table td,.stalls details>table th{border-bottom:1px solid var(--line)}
td.text{white-space:normal;min-width:240px;max-width:460px}
/* A cast with line breaks keeps them and is set in a fixed-width font: people post small ASCII pieces on the testnet, and collapsed into one line they are noise. */
td.text.pre{white-space:pre;font:12px/1.15 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-width:none}
.nodes{grid-template-columns:repeat(auto-fit,minmax(250px,1fr));margin-top:8px}[hidden]{display:none!important}
.col .head{font-size:12px;text-transform:uppercase;letter-spacing:.05em;padding:3px 12px;border:1px solid var(--line);border-bottom:0;border-radius:10px 10px 0 0;background:var(--line);color:var(--muted)}
.col{display:flex;flex-direction:column}.card .host{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;margin-bottom:2px}.col .head.ref{font-weight:700;color:var(--fg)}.col .card{border-radius:0 0 10px 10px;flex:1}
.col[data-net=hypersnap] .head{background:var(--fc);border-color:var(--fc);color:#fff}.col[data-net=hypersnap] .card{background:var(--fc-bg);border-color:var(--fc-line)}
.col[data-net*=testnet] .head{background:var(--tn);border-color:var(--tn);color:#fff}.col[data-net*=testnet] .card{background:var(--tn-bg);border-color:var(--tn-line)}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}.tab{text-decoration:none;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:2px 12px;font-size:13px}
.peers .peer.off{color:var(--bad)}.peers .peer.next{color:var(--warn)}.mesh{margin-bottom:4px}
.jump{position:sticky;top:0;z-index:5;display:flex;gap:6px;overflow-x:auto;padding:8px 0;margin:8px 0 4px;background:var(--bg);border-bottom:1px solid var(--line)}
.jump a{flex:none;text-decoration:none;color:var(--fg);border:1px solid var(--line);border-radius:99px;padding:3px 12px;font-size:13px;background:var(--card)}
[id]{scroll-margin-top:52px}.grp-head h3{font-size:13px;margin:0;flex:1;min-width:0;text-transform:uppercase;letter-spacing:.04em}.grp-head h3 .muted{text-transform:none;letter-spacing:0;font-weight:400}
.irows{display:grid}.irow,.irow:visited{display:grid;grid-template-columns:minmax(96px,1.3fr) 60px 82px minmax(120px,1fr) minmax(170px,1.5fr);gap:2px 10px;align-items:center;padding:7px 4px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--fg);font-size:14px}
.irow:hover{background:color-mix(in srgb,var(--line) 45%,transparent)}.iname{font-weight:600;color:var(--link);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.irow .pill{justify-self:start}
.iver,.irole{color:var(--muted);font-size:13px;white-space:nowrap}.iver.bad{color:var(--bad)}.ish{display:flex;gap:6px;justify-content:flex-end;font-variant-numeric:tabular-nums}
.sh{border:1px solid var(--line);border-radius:6px;padding:0 6px;font-size:13px;white-space:nowrap}.sh i{font-style:normal;color:var(--muted);margin-right:4px;font-size:11px}.sh.bad{border-color:var(--bad)}.sh.warn{border-color:var(--warn)}
/* Node card shard table: tighter cells so three columns fit the 225 px inside a card at the
   1100 px page width (operator, 2026-11-25: text ran past the card's right edge on desktop). */
.col .card th,.col .card td{padding:6px 4px;font-variant-numeric:tabular-nums}.col .card th:first-child,.col .card td:first-child{padding-left:0}.col .card th:last-child,.col .card td:last-child{padding-right:0;text-align:right}
/* Collapsible cards (static/fold.js). The arrow sits at the right edge of each heading line; a folded
   card is that line only, and the cards below move up. Nothing overflows a folded card: its body
   collapses to zero rows inside overflow:hidden. Without the script the arrows stay hidden and
   every card is open. */
.sec{margin:0 0 12px;padding:0}.sec-head{display:flex;align-items:center;gap:10px;min-height:44px;padding:4px 6px 4px 14px}
.sec-head h2{margin:0;flex:1;min-width:0}.sec-pad{padding:0 14px 14px}
.fold,.vt{display:none}.fold-js .fold{flex:none;width:36px;height:36px;display:grid;place-items:center;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);cursor:pointer;padding:0}
.fold:hover{border-color:var(--muted)}.fold:focus-visible,.vt:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.fold svg{width:16px;height:16px;transition:transform .2s ease}.fold-box.shut>div>.fold svg{transform:rotate(180deg)}
.sec-body{display:grid;grid-template-rows:1fr;transition:grid-template-rows .22s ease,visibility 0s}
.fold-box.shut>.sec-body{grid-template-rows:0fr;visibility:hidden;transition:grid-template-rows .22s ease,visibility 0s .22s}
.sec-in{overflow:hidden;min-height:0}
.sec .grid.nodes{margin:0}.sec .stats{margin:0}
.grp{border:1px solid var(--line);border-radius:8px;margin:10px 0 0}.grp-head{display:flex;align-items:center;gap:8px;min-height:40px;padding:3px 4px 3px 10px}
.fold-js .grp .fold{width:30px;height:30px}.grp .irows{padding:0 10px 6px}.grp.shut .grp-head h3 .muted{display:none}
.nb{flex:none;display:inline-grid;place-items:center;width:22px;height:22px;border-radius:6px;font:700 13px/1 system-ui,sans-serif}
#nodeinfo>.sec-body .sec{background:var(--bg)}#nodeinfo>.sec-body .sec:last-child{margin-bottom:0}.cgrp .grid.nodes{margin:0;padding:4px 10px 10px}.nb.ok{background:var(--ok);color:var(--card)}.nb.warn{background:var(--warn);color:var(--card)}.nb.bad{background:var(--bad);color:var(--card)}
/* Cause tiles: the explanation is a hover or focus tooltip. The open causes card lets it overflow
   its body; while the card moves, the body clips again (.moving, set by the script). */
.stat{position:relative}.stat:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.stat .help{display:none;position:absolute;left:-1px;right:-1px;top:calc(100% + 4px);z-index:6;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;box-shadow:0 4px 14px rgb(0 0 0/.2);margin:0;color:var(--fg)}
.stat:hover .help,.stat:focus .help{display:block}
#causes:not(.shut):not(.moving)>.sec-body>.sec-in{overflow:visible}
.fold-js .vt{display:inline-block;flex:none;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:99px;padding:2px 12px;font:inherit;font-size:13px;cursor:pointer}
.cchart{display:none}.fold-box.chart .stats{display:none}.fold-box.chart .cchart{display:grid;gap:8px}
.crow{display:grid;grid-template-columns:120px 1fr 56px;gap:10px;align-items:center;font-size:13px}.ck{color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-size:12px}
.ctrack{height:14px;display:flex;align-items:center}.cbar{display:block;height:10px;border-radius:0 4px 4px 0;background:var(--muted)}.cbar.unexplained{background:var(--bad)}.cbar.pending{background:var(--warn)}
.cn{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
/* Wordmark (operator's mockup, 2026-11-26): Ubuntu Medium, self-hosted as a glyph subset because the CSP
   allows fonts from this origin only (static/UBUNTU-FONT-LICENCE.txt). #00ffff is the mockup's color;
   on the light background it measures 1.17:1, so light mode uses #008b8b (3.86:1, passes the 3:1
   rule for text this large). */
@font-face{font-family:"Ubuntu Snapdiff";src:url(/static/ubuntu-m-snapdiff.woff) format("woff");font-weight:500;font-display:swap}
h1.brand{font:500 44px/1.05 "Ubuntu Snapdiff",Ubuntu,system-ui,sans-serif;color:var(--brand);margin:0;letter-spacing:-.01em}
.credit{display:block;background:none;border:0;padding:2px 0;margin:2px 0 12px;font:12px/1.4 system-ui,sans-serif;color:var(--muted);cursor:pointer}
.credit:hover{text-decoration:underline;text-underline-offset:2px}.credit:focus-visible,a.hue:focus-visible{outline:2px solid var(--link);outline-offset:2px}
.credit-pop{border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--fg);padding:14px;gap:8px;box-shadow:0 6px 24px rgb(0 0 0/.25)}
.credit-pop:popover-open{display:flex}.credit-pop::backdrop{background:rgb(0 0 0/.3)}
.credit-btn{text-decoration:none;border:1px solid;border-radius:99px;padding:6px 18px;font-size:14px;font-weight:600}
/* Button hues. Light values: text on the 10% tint 4.6:1 or more, text on the fill 5.2:1 or more.
   Dark values: 6.9:1 or more on both. No status colors (ok green, bad red, warn amber), so a button
   never reads as a health signal. */
.c-cyan{--c:#0e7490;--f:#00ffff;--o:#141413}.c-blue{--c:#1d4ed8;--f:#1d4ed8;--o:#fff}.c-purple{--c:#7e22ce;--f:#7e22ce;--o:#fff}
.c-teal{--c:#0f766e;--f:#0f766e;--o:#fff}.c-orange{--c:#9a3412;--f:#9a3412;--o:#fff}.c-pink{--c:#be185d;--f:#be185d;--o:#fff}
@media (prefers-color-scheme:dark){.c-cyan{--c:#67e8f9;--f:#00ffff;--o:#141413}.c-blue{--c:#93c5fd;--f:#93c5fd;--o:#141413}.c-purple{--c:#d8b4fe;--f:#d8b4fe;--o:#141413}
.c-teal{--c:#5eead4;--f:#5eead4;--o:#141413}.c-orange{--c:#fdba74;--f:#fdba74;--o:#141413}.c-pink{--c:#f9a8d4;--f:#f9a8d4;--o:#141413}}
a.hue,a.hue:visited{color:var(--c);border-color:var(--c);background:color-mix(in srgb,var(--c) 10%,var(--card));text-decoration:none}
a.hue:hover{text-decoration:underline;text-underline-offset:3px}
a.hue.on,a.hue.on:visited{color:var(--o);background:var(--f);border-color:var(--f);font-weight:600}
@media (prefers-reduced-motion:reduce){.sec-body,.fold svg{transition:none!important}}
@media (max-width:640px){main{padding:12px 10px}h1{font-size:17px}h1.brand{font-size:34px}
.stats{grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin:10px 0}.stat{padding:8px 4px;text-align:center}.stat .n{font-size:20px}.stat .k{font-size:9px;letter-spacing:0}.stat{position:static}.stats{position:relative}.crow{grid-template-columns:96px 1fr 44px}
.irow,.irow:visited{grid-template-columns:minmax(0,1fr) auto auto;grid-template-areas:"name pill ver" "role sh sh";padding:8px 2px}.iname{grid-area:name}.irow .pill{grid-area:pill}.iver{grid-area:ver;text-align:right}.irole{grid-area:role}.ish{grid-area:sh}
.nodes{grid-template-columns:1fr}}
.pager{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:16px 0 0}.pager .muted{margin:0}
.pager button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:2px 10px;font:inherit;cursor:pointer}
.pager button:disabled{opacity:.4;cursor:default}
</style></head><body><main>
<h1 class="brand">Snapdiff</h1>
${creditHtml(cfg.siteCredit)}
<nav class="tabs"><a class="tab hue c-cyan${view === "mainnet" ? " on" : ""}" href="/">Mainnet (${allNets.filter((n) => !isTestnet(n.network)).reduce((t, n) => t + n.labels.length, 0)} nodes)</a><a class="tab hue c-blue${view === "cards" ? " on" : ""}" href="/?view=cards">Node cards</a>${
  hasTestnet
    ? `<a class="tab hue c-purple${view === "testnet" ? " on" : ""}" href="/?net=testnet">Testnet (${allNets.filter((n) => isTestnet(n.network)).reduce((t, n) => t + n.labels.length, 0)} nodes)</a>`
    : ""
}</nav>
${
  view === "cards"
    ? `<p class="muted">Mainnet nodes only. This page reloads every 30 s. Read-only.</p>
${chainFilter()}
${cardGroups()}`
    : view === "mainnet"
    ? `<p class="muted">Scans run every ${Math.round(cfg.scanIntervalMs / 60000)} min: ${summary.scans} so far, last ${ago(summary.lastScanAt, now)}, next in about ${nextScanIn(summary.lastScanAt, cfg.scanIntervalMs, now)}. This page reloads every 30 s. Read-only.</p>
${causesHtml()}`
    : `<p class="muted">The cast relay comparison on the Mainnet tab does not apply here. This page reloads every 30 s. Read-only.</p>`
}
${view === "cards" ? "" : `<nav class="jump" aria-label="Sections">${view === "testnet" ? `<a class="hue c-blue" href="#nodes">Cards</a>` : ""}${(clients?.() ?? []).some((h) => isTestnet(h.network) === (view === "testnet")) ? `<a class="hue c-orange" href="#clients">Clients</a>` : ""}${consensusHtml(nets.map((n) => n.network)) ? `<a class="hue c-teal" href="#consensus">Consensus</a>` : ""}<a class="hue c-pink" href="#stalls">Stalls</a></nav>
`}
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
${view === "cards" ? "" : `${sec(
  "nodeinfo",
  "Node info",
  "Node info",
  `${indexHtml()}
${view === "testnet" ? sec("nodes", "Cards", "Cards", cardGroups()) : ""}
${consensusHtml(nets.map((n) => n.network))}
${sec("stalls", "Shard stalls", `Shard stalls${openInView > 0 ? ` <span class="pill bad">${openInView} ongoing</span>` : ""}${networkWideStalls(stalls).map((t) => ` <span class="pill bad">network-wide: ${esc(t)}</span>`).join("")}`, `<p class="muted">A shard on one node stopped advancing while the same shard on its healthiest peer on the same network kept going. When every reachable node of a network is stalled on a shard the rows are marked network-wide: that network stopped deciding blocks. Diffs on a stalled shard stay pending until it recovers. One line per node and shard with its latest stall; the last column counts the past 7 days; a line with several stalls opens on click.</p>${stallsHtml(stalls)}`)}`,
)}
${clientsHtml((clients?.() ?? []).filter((h) => isTestnet(h.network) === (view === "testnet")))}
${view === "testnet" ? feedHtml() : ""}
${view === "mainnet" ? splitHtml() : ""}
${
  view === "mainnet"
    ? `${sec("unexplained", "Unexplained", "Unexplained", `<p class="muted">${nodeLabels.map((l) => `Missing on ${esc(l)}: ${summary.byMissingNode[l] ?? 0}`).join(" · ")}. Rows are rechecked for ${Math.round(cfg.recheckWindowMs / 3600000)} h; one that turns up on the missing side moves to sync lag and leaves this list.</p>${rowsHtml(unexplained, summary.byCause.unexplained)}`)}
${sec("pending", "Pending", "Pending", `<p class="muted">Seen on one side, not yet old enough or not yet rechecked. Most resolve on their own.</p>${rowsHtml(pending, summary.byCause.pending)}`)}`
    : ""
}`}
</main></body></html>`);
  });

  return app;
}
