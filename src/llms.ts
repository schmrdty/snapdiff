// GET /llms.txt: a plain-text description of this deployment for agents and crawlers,
// in the llms.txt layout (H1, one-line summary in a blockquote, H2 link lists; llmstxt.org).
// It is generated from the running config so the node list never drifts from reality.
// Served at the site root because that is where readers look; there is no separate API host.
import { networks, type Config } from "./config.js";

export const SOURCE_URL = "https://github.com/schmrdty/snapdiff";
export const TELEGRAM_URL = "https://t.me/snapdiff_bot";

export function llmsTxt(cfg: Config, origin: string): string {
  const nets = networks(cfg);
  const nodeLines = cfg.nodes.map((n) => {
    const netRef = Object.entries(cfg.references).find(([, l]) => l === n.label)?.[0];
    const tags =
      n.label === cfg.reference
        ? " (reference: anchors presentOn and the dashboard)"
        : netRef === undefined
          ? ""
          : ` (${netRef} reference: presentOn when the reference lacks the cast)`;
    const shown = n.name === undefined ? "" : ` (shown on the dashboard as "${n.name}")`;
    return `- ${n.label}: network ${n.network}${tags}${shown}`;
  });
  const netLine = nets.map((n) => `${n.network} (${n.labels.length} node${n.labels.length === 1 ? "" : "s"})`).join(" vs ");
  return [
    "# snapdiff",
    "",
    "> Read-only comparator for Farcaster-protocol nodes (Snapchain and Hypersnap). It asks every configured node for the same casts, records which nodes have each one, and tags every difference with a cause and a scope. It never writes to any network.",
    "",
    `This deployment compares ${netLine}. Every endpoint below is GET, needs no key, and returns JSON. Base URL: ${origin}`,
    "",
    "## Nodes",
    "",
    ...nodeLines,
    "",
    "## API",
    "",
    `- [Summary](${origin}/api/summary): nodes (labels, in order), networks (network to labels), reference, counts by cause, by missing node, by scope, per-network disagreements (networkSplit), the latest /v1/info per node (info[label], with version), versions[network] (newest version its reachable nodes report), and releases[network] (newest version the project has published, from its Docker Hub tag list, with publishedAt)`,
    `- [Open diffs](${origin}/api/diffs?cause=unexplained&limit=200): diff rows with the full message JSON, shard, presentOn, missingOn, presentNodes, scope, and cause. Query: cause (sync_lag, relay_filtered, version_rule, pending, unexplained), limit (max 5000)`,
    `- [Shard stalls](${origin}/api/stalls?limit=200): stall events, newest first, each with the node, shard, stuck height, scope (node: that node alone; network: every node of its network stopped, a quorum loss) and the peer it was measured against`,
    `- [One node](${origin}/api/node/${cfg.nodes[0]?.label ?? "LABEL"}?hours=24&limit=60): one node by label: latest state, version (current, latest on its network, behind), release (newest published on its network), up and down counts, worst delay and stalls in the window (1 to 168 hours), newest samples`,
    `- [Consensus view](${origin}/api/consensus): per network with a validators file, per shard, the validators whose node is at the tip and can vote against the quorum a block needs, plus who is behind, down or not monitored; lines holds the same as one sentence per shard`,
    `- [Peer view](${origin}/api/mesh): per node (networks enabled by MESH_NETWORKS) the /v1/mesh summary: state (open, closed, absent, unreachable), self (peer id, validator flag, key prefix, consensus mesh size, height, network), peer counts, validator rows (peer id, key prefix, connected, direct); plus names (peer id to node name) and networks`,
    `- [Client health](${origin}/api/clients): latest self-reported status per watched client app, or an empty list when the check is off`,
    `- [Dashboard](${origin}/): the same data as HTML, auto-refreshing every 30 s`,
    "",
    "## Reading the data",
    "",
    "- scope: node means another node on the same network has the cast (that node is behind or broken); network means every node of that network lacks it (the networks disagree).",
    "- cause: sync_lag, relay_filtered, and version_rule are expected and need no action; pending means wait; unexplained is the only cause worth investigating.",
    "- A missing cast is not censorship on its own. Check the stalls table, the node's blockDelay in info[label], and the cause before drawing a conclusion.",
    "- unexplained rows keep being rechecked, so a late arrival still flips to sync_lag.",
    "",
    "## Docs",
    "",
    `- [README](${SOURCE_URL}#readme): setup, loops, causes, the relay model, false positives`,
    `- [Comparing more than two nodes](${SOURCE_URL}/blob/main/docs/MULTI-NODE.md): the scope model and the API shape`,
    `- [Client health](${SOURCE_URL}/blob/main/docs/CLIENT-HEALTH.md): what /api/clients checks and its safety contract`,
    `- [The /v1/mesh endpoint](${SOURCE_URL}/blob/main/docs/mesh-endpoint.md): what a node's peer view carries, how its fields are computed, what snapdiff keeps`,
    `- [Telegram bot](${TELEGRAM_URL}): /snapdiff, /status, /consensus, /fid, /feedback`,
    "",
    "## Optional",
    "",
    `- [Source](${SOURCE_URL}): MIT licensed, Node 24, SQLite; run your own against your own nodes`,
    "",
  ].join("\n");
}
