// Published releases. src/versions.ts answers "what is the newest version anyone on this
// network runs"; this file answers "what is the newest version the project has published",
// which is the earlier signal. Ryan, 2026-11-14: four Hypersnap patches shipped in one
// afternoon and the bot only spoke once another node had pulled each one.
//
// The feed is a Docker Hub tag list. Hypersnap has no GitHub releases or tags for 0.17.x
// (checked 2026-11-14: the tags page stops at v0.11.8), and every release is pushed to
// Docker Hub under its number, so the registry is the only machine-readable release list.
// Safety contract, same as src/clients.ts:
//   * every feed URL comes from the operator's config, never from a response;
//   * the only thing read out of a response is a tag name that matches RELEASE_TAG_RE and a
//     timestamp, so no response text can ever reach the page or the bot;
//   * one request per network per interval, body capped, redirects refused, timeout bounded.
import { compareVersions } from "./versions.js";

/** Known networks and their image's tag list. Overridable per network with RELEASE_FEED_<NETWORK>. */
export const DEFAULT_RELEASE_FEEDS: Record<string, string> = {
  hypersnap: "https://hub.docker.com/v2/repositories/farcasterorg/hypersnap/tags?page_size=100&ordering=last_updated",
  snapchain: "https://hub.docker.com/v2/repositories/farcasterxyz/snapchain/tags?page_size=100&ordering=last_updated",
};

/** A release tag: digits and dots only. "latest", "nightly-0.17.8-91f1bcf", and "pre-main-..." never count. */
export const RELEASE_TAG_RE = /^\d+\.\d+\.\d+$/;
export const RELEASE_TIMEOUT_MS = 10_000;
/** 100 tags from Docker Hub are about 115 KB; anything far above that is not the feed we asked for. */
export const RELEASE_MAX_BODY = 1_000_000;

export interface Release {
  version: string;
  /** Tag push time (Docker Hub last_updated), unix ms. Null when the feed gives none. */
  publishedAt: number | null;
}

export interface ReleaseState {
  network: string;
  /** Newest published version, null until the first successful fetch. */
  version: string | null;
  publishedAt: number | null;
  /** Last attempt, unix ms. */
  checkedAt: number | null;
  /** Fixed-phrase reason the last attempt gave nothing; null after a success. */
  error: string | null;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Newest release tag in a Docker Hub tag list body. Null when the body has no release tag. */
export function pickRelease(body: unknown): Release | null {
  if (typeof body !== "object" || body === null) return null;
  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  let best: Release | null = null;
  for (const r of results) {
    if (typeof r !== "object" || r === null) continue;
    const name = (r as { name?: unknown }).name;
    if (typeof name !== "string" || !RELEASE_TAG_RE.test(name)) continue;
    const raw = (r as { last_updated?: unknown }).last_updated;
    const t = typeof raw === "string" ? Date.parse(raw) : NaN;
    const rel: Release = { version: name, publishedAt: Number.isFinite(t) ? t : null };
    if (best === null || compareVersions(name, best.version) > 0) best = rel;
  }
  return best;
}

/** One fetch. Never throws; every failure is a fixed phrase in `error`. */
export async function fetchRelease(url: string, fetchFn: FetchLike = fetch): Promise<{ release: Release | null; error: string | null }> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(RELEASE_TIMEOUT_MS), headers: { accept: "application/json" } });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { release: null, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable" };
  }
  if (!res.ok) return { release: null, error: `HTTP ${res.status}` };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { release: null, error: "unreadable body" };
  }
  if (text.length > RELEASE_MAX_BODY) return { release: null, error: "body too large" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { release: null, error: "not JSON" };
  }
  const release = pickRelease(body);
  return release === null ? { release: null, error: "no release tag" } : { release, error: null };
}

/** Holds the newest published release per network; the dashboard, the API, and the bot read a snapshot. */
export class ReleaseMonitor {
  private latest = new Map<string, ReleaseState>();

  constructor(
    private readonly feeds: Record<string, string>,
    private readonly fetchFn: FetchLike = fetch,
    private readonly log: (m: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    for (const network of Object.keys(feeds)) this.latest.set(network, { network, version: null, publishedAt: null, checkedAt: null, error: null });
  }

  /** One round over every feed, sequentially (two feeds, ten minutes apart; no need for more). */
  async runAll(): Promise<void> {
    for (const [network, url] of Object.entries(this.feeds)) {
      const prev = this.latest.get(network);
      const { release, error } = await fetchRelease(url, this.fetchFn);
      const checkedAt = this.now();
      if (release === null) {
        // A failed fetch keeps the last known release; only the error and the time move.
        this.latest.set(network, { network, version: prev?.version ?? null, publishedAt: prev?.publishedAt ?? null, checkedAt, error });
        if (prev?.error !== error) this.log(`[releases] ${network}: ${error}`);
        continue;
      }
      if (prev?.version !== release.version) this.log(`[releases] ${network}: ${prev?.version ?? "none"} -> ${release.version}`);
      this.latest.set(network, { network, version: release.version, publishedAt: release.publishedAt, checkedAt, error: null });
    }
  }

  snapshot(): Record<string, ReleaseState> {
    return Object.fromEntries([...this.latest.entries()].map(([k, v]) => [k, { ...v }]));
  }
}
