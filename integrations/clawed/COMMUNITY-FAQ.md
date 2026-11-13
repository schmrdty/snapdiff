# Community FAQ, with paste-ready answers

Each entry: the question as people ask it, what is true, and a short reply Ryan can paste. Replies carry no markdown so they survive Telegram. Check the live API before pasting a number.

## "Where does the block delay come from? Is snapdiff comparing Hypersnap against Snapchain?"

True: blockDelay is each node's own field from `/v1/info`, now minus the newest block timestamp per shard. snapdiff reads it and compares nodes of the same network to each other for stalls. Cross-network comparison is used only when a whole network stops.

```
blockDelay is the node's own number from /v1/info (now minus its newest block per shard). snapdiff just reads it. Stalls are judged against the healthiest node on the same network. The other network only comes in when every Hypersnap node stops at once, and then the row says scope network.
```

## "snapdiff says Hypersnap stalled. Is it down?"

True: a scope `network` stall means every reachable Hypersnap node stopped on that shard at the same height, which is a consensus pause, not a node fault. On 2026-11-13 these were proposer slots of validators nobody could reach. They end on their own.

```
Every Hypersnap node stopped on the same shard at the same height, so it is a consensus pause, not a broken node. snapdiff marks those scope network. They end when the round moves past the unreachable proposer, and they keep happening until every validator is reachable.
```

## "Why does it say my node is behind on version?"

True: the rule compares each node to the newest version any reachable node on its network reports. One early upgrader makes everyone else "behind". It is a notice.

```
Behind means another Hypersnap node already reports a newer version. It is a heads-up, not an alarm. It clears on its own once you pull the new image.
```

## "Why is a cast missing on Snapchain? Is this censorship?"

True: check the cause first. Since the fork the shuttle takes 30 to 45 minutes; rows sit at pending then flip to sync_lag. relay_filtered means the shuttle never carries it by design (native FID, filtered type). Only unexplained is worth a look, and even then deletes and pruning come first.

```
Not from that alone. Look at the cause on the row: pending or sync_lag is the shuttle's 30 to 45 minute lag, relay_filtered is by design (native accounts and some types never cross), version_rule is a rule difference. Only unexplained is worth investigating, and deletes and storage pruning explain most of those.
```

## "Why does the bot not answer me in the group?"

True: Group Privacy is on. Telegram delivers only commands with the bot's name, bare commands when the bot posted last, and replies to the bot.

```
Group privacy keeps the bot blind to normal chat. Address it directly: /status@snapdiff_bot, /snapdiff@snapdiff_bot is <node> down, /node@snapdiff_bot <label>, /fid@snapdiff_bot 123, or reply to one of its messages.
```

## "/fid says no open diffs. So my account is fine?"

True: it means snapdiff has no rows for that FID. Watchlisted FIDs are scanned every time; others only when the random sample picks them.

```
No open diffs means snapdiff has not recorded a difference for that FID. Watchlisted FIDs are checked every scan; others only when the random sample lands on them. If you want yours checked every time, send it to Ryan for the watchlist.
```

## "Will Hypersnap native FIDs collide with Snapchain FIDs?"

True: no. Legacy FIDs come from the same Optimism IdRegistry on both networks and count up from about 3.4 million. Native FIDs start at 2^32 and exist only on Hypersnap. The shuttle never relays native accounts or their messages.

```
No collision: old FIDs still come from the same Optimism registry on both networks, and Hypersnap native FIDs start at 4,294,967,296, a range the registry will never reach. Native accounts exist only on Hypersnap by design, so a Snapchain client will not see them.
```

## "Can one client work on both networks?"

True: yes for legacy accounts. Sign once, submit to both hubs. Expect Snapchain to reject messages from accounts with no storage (Hypersnap no longer checks storage), and expect native accounts to be Hypersnap only.

```
Yes for existing accounts: sign once and submit to both hubs. Differences to plan for: Snapchain still enforces storage units, Hypersnap does not; gasless signers and native accounts are Hypersnap only; carry FIDs as strings or BigInt because native ones pass 2^53.
```

## "Should peers in validators.toml or bootstrap_peers be DNS names?"

True: the Hypersnap swarm has no DNS transport, so a `/dns4/` entry is never dialed. Use `/ip4/` with `/udp/3382/quic-v1`.

```
Use /ip4/ entries. The node's libp2p swarm is built with TCP and QUIC only, no DNS transport, so a /dns4/ address is silently never dialed. That matches the mesh views where the DNS-listed validators never show up as peers.
```

## "My fresh Hypersnap node is stuck at the fork block."

True: the upstream mainnet compose still ships Snapchain's bootstrap list. Snapchain nodes do not relay the new topics. Replace the list with Hypersnap peers as `/ip4/` entries and restart.

```
If it stopped at the last pre-fork height with InsufficientPeers, your bootstrap_peers are probably still the Snapchain list from the upstream compose file. Those nodes do not relay the new topics. Put Hypersnap validator addresses in as /ip4/.../udp/3382/quic-v1 and restart; blocks resume within a couple of minutes.
```

## "Is ohsnap a validator?"

True: no. It is a read node. It is not in the proposer rotation and cannot cause pauses.

```
ohsnap is a read node, not a validator. It follows the chain and serves the API; it is not in the proposer rotation, so it cannot cause or fix a pause.
```

## "Does adding more validators make Hypersnap faster or safer?"

True: throughput is unchanged (one proposer per block). Fault tolerance rises only in steps of three (8 tolerate 2, 10 tolerate 3, 13 tolerate 4). Every validator adds proposer slots, so an unreachable one adds pauses.

```
More validators does not make blocks faster. Safety rises in steps of three (8 nodes tolerate 2 faults, 10 tolerate 3). Each validator also owns proposer slots, so an unreachable one adds pauses for everyone. Reachability matters more than count.
```
