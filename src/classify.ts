import type { Cause, HubMessage, NewDiff, Side } from "./types.js";

export interface RuleConfig {
  v21TextBytes: number;
}

/**
 * Returns a reason string if the message depends on rules only one side may enforce
 * (Snapchain V21/V22 as of v0.15.0), otherwise null.
 */
export function versionRuleReason(msg: HubMessage, rules: RuleConfig): string | null {
  const body = msg.data.castAddBody;
  if (body === undefined) return null;
  if (body.chain !== undefined && body.chain !== null) return "V22: uses CastAddBody.chain";
  if (body.formatVersion !== undefined && body.formatVersion !== null && body.formatVersion !== 0) {
    return `V22: CastAddBody.formatVersion=${String(body.formatVersion)}`;
  }
  const bytes = Buffer.byteLength(body.text ?? "", "utf8");
  if (bytes > rules.v21TextBytes) return `V21: ${bytes}-byte cast exceeds ${rules.v21TextBytes}`;
  return null;
}

/** Hash-level diff. Messages are self-signed, so the same message has the same hash on both networks. */
export function diffByHash(
  a: readonly HubMessage[],
  b: readonly HubMessage[],
): { onlyA: HubMessage[]; onlyB: HubMessage[] } {
  const norm = (h: string) => h.toLowerCase();
  const aSet = new Set(a.map((m) => norm(m.hash)));
  const bSet = new Set(b.map((m) => norm(m.hash)));
  return {
    onlyA: a.filter((m) => !bSet.has(norm(m.hash))),
    onlyB: b.filter((m) => !aSet.has(norm(m.hash))),
  };
}

export interface RecheckInput {
  /** Result of asking the missing side directly. null = request failed. */
  foundOnMissingSide: boolean | null;
  /** The missing side's worst blockDelay is above the threshold, or it is unreachable. */
  missingSideBehind: boolean;
  /** The message type is on the relay's filtered list. */
  filteredType?: boolean;
  /**
   * Whether the missing side has an ID registration for the FID.
   * false = relay cannot carry it; null = request failed; undefined = check disabled.
   */
  fidKnownOnMissingSide?: boolean | null;
  message: HubMessage;
  ageMs: number;
  unexplainedAfterMs: number;
  rules: RuleConfig;
}

export interface Verdict {
  cause: Cause;
  note: string | null;
  /** Final verdicts stop being rechecked. */
  final: boolean;
}

/**
 * Order matters: arrival beats everything, then "can't judge yet", then the relay's own
 * filters, then rule differences, and only then unexplained.
 */
export function classify(i: RecheckInput): Verdict {
  if (i.foundOnMissingSide === true) return { cause: "sync_lag", note: "arrived on the missing side", final: true };
  if (i.foundOnMissingSide === null) return { cause: "pending", note: "recheck request failed", final: false };
  if (i.filteredType === true) {
    return { cause: "relay_filtered", note: `type ${i.message.data.type} is not relayed`, final: true };
  }
  if (i.fidKnownOnMissingSide === false) {
    return { cause: "relay_filtered", note: `fid ${i.message.data.fid} is not registered on the missing side`, final: true };
  }
  if (i.fidKnownOnMissingSide === null) return { cause: "pending", note: "fid origin check failed", final: false };
  const rule = versionRuleReason(i.message, i.rules);
  if (rule !== null) return { cause: "version_rule", note: rule, final: true };
  if (i.missingSideBehind) return { cause: "pending", note: "missing side is behind on this shard; waiting", final: false };
  if (i.ageMs < i.unexplainedAfterMs) return { cause: "pending", note: null, final: false };
  // Not final: a late arrival can still flip this to sync_lag inside the recheck window.
  return { cause: "unexplained", note: "valid under both rule sets, still missing", final: false };
}

export function toNewDiff(msg: HubMessage, presentOn: Side, now: number, shard: number | null): NewDiff {
  return {
    hash: msg.hash.toLowerCase(),
    fid: msg.data.fid,
    shard,
    msgTimestamp: msg.data.timestamp + 1_609_459_200,
    presentOn,
    missingOn: presentOn === "a" ? "b" : "a",
    messageJson: JSON.stringify(msg),
    firstSeen: now,
  };
}
