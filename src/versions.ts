// Node software versions. /v1/info reports `version`; per network, the newest version among
// the reachable nodes that report one is "latest", and a node below it is "behind". There is
// no release feed to ask, so "latest" means "newest anyone on this network runs": a node on a
// nightly build makes everyone else read behind, which is the honest reading.
// Ryan, 2026-11-12: the Hypersnap fork that day stranded nodes one release behind; a card line
// and a bot message before the fork height are cheaper than the stall after it.
import type { InfoSnapshot, Side } from "./types.js";

/** Numeric dot-part order: "0.17.5" > "0.17.4" > "0.9.0". A missing part is 0; a non-numeric part compares as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export interface VersionView {
  /** What the node reports, null when unknown. */
  current: string | null;
  /** Newest version among this network's reachable nodes, null when none reports one. */
  latest: string | null;
  /** current is known and older than latest. */
  behind: boolean;
}

/** Newest version per network among reachable nodes that report one. */
export function latestVersions(networks: Record<string, Side[]>, infos: Record<Side, InfoSnapshot | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [network, labels] of Object.entries(networks)) {
    let best: string | null = null;
    for (const l of labels) {
      const i = infos[l];
      const v = i?.reachable ? (i.version ?? null) : null;
      if (v !== null && (best === null || compareVersions(v, best) > 0)) best = v;
    }
    out[network] = best;
  }
  return out;
}

export function versionView(current: string | null | undefined, latest: string | null): VersionView {
  const cur = current ?? null;
  return { current: cur, latest, behind: cur !== null && latest !== null && compareVersions(cur, latest) < 0 };
}
