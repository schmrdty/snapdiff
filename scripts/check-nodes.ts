/**
 * Preflight: confirms both nodes answer the endpoints snapdiff depends on, with the same shape.
 * Run this before trusting any results, especially against Hypersnap.
 *   npm run check-nodes            (uses FID 3 for the casts check)
 *   npm run check-nodes -- 12345   (pick an active FID)
 */
import { loadConfig } from "../src/config.js";
import { HubClient } from "../src/hub.js";
import { shardForFid } from "../src/shard.js";

const cfg = loadConfig();
const fid = Number(process.argv[2] ?? 3);
const nowSec = Math.floor(Date.now() / 1000);
let failures = 0;

const check = async (name: string, fn: () => Promise<string>) => {
  try {
    console.log(`  ok    ${name}: ${await fn()}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

for (const side of ["a", "b"] as const) {
  const node = side === "a" ? cfg.a : cfg.b;
  const hub = new HubClient(side, node.url, cfg.requestTimeoutMs, node.headers);
  console.log(`\n${node.label} (${node.url})`);

  let numShards: number | null = null;
  await check("/v1/info", async () => {
    const i = await hub.info();
    if (!i.reachable) throw new Error(i.error ?? "unreachable");
    numShards = i.numShards;
    if (numShards === null) throw new Error("numShards missing; shard tagging would be disabled");
    return `${numShards} data shards, worst blockDelay ${i.maxBlockDelay ?? "?"}, fids ~${i.numFidRegistrations ?? "?"}`;
  });

  // Proves the transcribed routing function against what the node itself did: every merged
  // message on shard S must hash to S. A transcription error fails here, not silently in diffs.
  await check("shard routing vs /v1/events", async () => {
    if (numShards === null) return "skipped, numShards unknown";
    let checked = 0;
    const bad: string[] = [];
    for (let s = 1; s <= numShards; s++) {
      for (const e of await hub.recentMergeFids(s, 200)) {
        checked++;
        const want = shardForFid(e.fid, numShards);
        if (want !== e.shardIndex) bad.push(`fid ${e.fid} (${e.type}): computed ${want}, node says ${e.shardIndex}`);
      }
    }
    if (checked === 0) throw new Error("no merge events returned; cannot verify routing");
    if (bad.length > 0) throw new Error(`${bad.length}/${checked} mismatches, e.g. ${bad[0]}`);
    return `${checked} merge events, all on the computed shard`;
  });

  let sampleHash: string | undefined;
  await check(`/v1/castsByFid fid=${fid} (30 days)`, async () => {
    const msgs = await hub.castsByFid(fid, nowSec - 30 * 86400, nowSec, 5);
    sampleHash = msgs[0]?.hash;
    if (msgs.length > 0 && !/^0x[0-9a-f]+$/i.test(msgs[0]?.hash ?? "")) throw new Error("hash is not 0x hex");
    return `${msgs.length} casts`;
  });

  await check("/v1/castById (known hash)", async () => {
    if (sampleHash === undefined) return "skipped, no casts to test with";
    if (!(await hub.hasCast(fid, sampleHash))) throw new Error("returned not found for a hash it just listed");
    return "found";
  });

  await check("/v1/castById (bogus hash returns not-found)", async () => {
    const found = await hub.hasCast(fid, `0x${"0".repeat(40)}`);
    if (found) throw new Error("bogus hash reported as present");
    return "not found, as expected";
  });
}

console.log(failures === 0 ? "\nBoth nodes look compatible." : `\n${failures} check(s) failed. Fix before running snapdiff.`);
process.exit(failures === 0 ? 0 : 1);
