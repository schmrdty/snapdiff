# The /v1/mesh endpoint

A Hypersnap node answers `GET /v1/mesh` with its own view of the gossip mesh: the peers it holds a live libp2p connection to at that moment, which of them it classifies as validators, what it knows about each one (topic subscriptions, mesh membership, inbound gossip volume, any contact advertisement it has collected), and whether the node itself is a validator (gossip.rs:1940-1964, view.rs:45-62). This page documents that response from the node's source so that operators and client builders can tell what each field means, when it is null, which values are free text, and what a value does not prove. Every statement carries a file and line reference to the upstream copy listed under Sources; short file names are expanded there.

`/v1/info` answers a different question. It reports whether a node's heights move (`maxHeight` and `blockDelay`, README.md:34) and which release it runs (`GetInfoResponse.version`, request_response.proto:55-56), and it is served through the ordinary request handler without the admin gate (http_server.rs:5512-5517, ui.html:296). `/v1/mesh` carries no peer heights, no block timing, and no release version (request_response.proto:731-742); it says who the node is connected to and how. The node's own dashboard uses both: `/v1/mesh` for the peer picture and each node's `/v1/info` for heights and versions (ui.html:400-403, 663).

## Access

### Routes

| Route | What it returns | Source |
|---|---|---|
| `GET /v1/mesh` | The local view (JSON by default, ASCII on request), or the crawled topology with `?crawl=true` | http_server.rs:5849, 5978-6006 |
| `GET /v1/mesh/ui` | A self-contained HTML dashboard shell, served without authentication, that fetches `/v1/mesh` itself | http_server.rs:5850, 6009-6023; ui.rs:1-9 |
| `OPTIONS` on any path | `204 No Content` with CORS headers | http_server.rs:5453-5483 |
| Other method or path | `404` with the plain body `Not Found`, unless the optional v2 API handler claims the request first; that handler's code is not in the copy, so what it claims cannot be stated here | http_server.rs:5486-5496, 5851-5854 |

Every response carries `Access-Control-Allow-Origin` taken from the `http_server.cors_origin` setting, whose default is `*` (http_server.rs:36-46, 5857-5861). The default HTTP port is 3381; gossip is 3382 and gRPC is 3383 (cfg.rs:20-22), and the HTTP listener defaults to all interfaces on that port (cfg.rs:139). The HTTP handler is a thin layer over two in-process gRPC methods, `GetMeshView` and `GetMeshTopology`, both admin-gated and both taking a `GetMeshViewRequest` (rpc.proto:27-31; http_server.rs:5979, 5993).

### Query parameters

The query string is split on `&`, each pair on the first `=`; four keys are recognised and every other pair is ignored. A key with no `=` at all (a bare `?crawl`) matches no arm and is ignored, and when a key repeats the last pair wins. No percent-decoding is applied (http_server.rs:5951-5968).

| Parameter | Default | Accepted values | Effect | Source |
|---|---|---|---|---|
| `format` | `json` | Exactly `ascii` switches to text; any other value leaves JSON | Output format only | http_server.rs:5947, 5953-5957 |
| `validators_only` | `true` | Exactly `false` or `0` turns it off; anything else keeps it on | Drops every peer not classified as a validator | http_server.rs:5948, 5958-5960; view.rs:81-86 |
| `crawl` | `false` | Anything other than `false` or `0` turns it on, including an empty value (`crawl=`) | Returns the network topology instead of the local view | http_server.rs:5949, 5961-5963, 5978 |
| `topics` | `consensus,mempool` plus their `hypersnap/` spellings | Comma list of known topic names, each trimmed of surrounding whitespace, case-sensitive; the word `all` (case-insensitive) selects every topic; unknown names are dropped and an empty result falls back to the default | ASCII columns and matrices only; JSON always carries every topic | http_server.rs:5964-5972; render.rs:18, 24-40 |

The gRPC request is built with `validators_only` from the query, `ttl` fixed at 0 and `visited_peer_ids` empty; those two fields are reserved for a future recursive crawl and are ignored today (http_server.rs:2456-2460; request_response.proto:696-702).

### Formats

| Format | Status and content type | Source |
|---|---|---|
| JSON (default) | `200`, `application/json` | http_server.rs:2480-2486 |
| `format=ascii` | `200`, `text/plain; charset=utf-8` | http_server.rs:2472-2478 |
| `/v1/mesh/ui` | `200`, `text/html; charset=utf-8`, `cache-control: no-store` | http_server.rs:2488-2497 |

The ASCII local view opens with `MESH VIEW  self=<last 7 characters of the peer id>  validator|non-validator  height N  net=X  consensus-mesh linked/validators`, then a peer table with one glyph column per selected topic, then a consensus-mesh graph when a consensus topic is selected (render.rs:48-74). The ASCII topology opens with `MESH TOPOLOGY  nodes=N  unreachable=M  net=X` and prints one adjacency matrix per selected topic, using `>` and `<` for links seen from one side only (render.rs:436-442, 469-497). None of the ASCII-only derived values (the linked count, the glyphs) exist as JSON keys.

### Authentication

The HTTP handler copies the caller's `authorization` header, when it is a valid ASCII header value, into the gRPC request's metadata; a header that does not convert is silently dropped (http_server.rs:2461-2466). The gRPC handlers authenticate before touching the cache (server.rs:4029-4032, 4088-4093).

| Situation | Result | Source |
|---|---|---|
| `admin_rpc_auth` empty (the default) | Every caller passes; the startup log says `Admin/diagnostic RPC auth disabled (mesh view is open)` | cfg.rs:103, 137; rpc_extensions.rs:161-163; server.rs:736-737 |
| `admin_rpc_auth` set, no header | `401`, body `{"error":"missing authorization header","error_detail":null}` | rpc_extensions.rs:198-199; http_server.rs:2504-2513 |
| Header present but not `Basic <base64 of user:password>` | `401` with `invalid authorization header` or a decode message | rpc_extensions.rs:170-188 |
| Unknown user or wrong password | `401`, `invalid username or password` | rpc_extensions.rs:189-197 |
| Gossip task did not answer within 100 ms (500 ms for the crawl's own local view), or the crawl failed | `500`, `Unable to retrieve mesh view.` or `Unable to crawl mesh topology.` | server.rs:87, 4049-4077, 4115-4118; crawl.rs:32; http_server.rs:2504-2508 |

`admin_rpc_auth` is a top-level config string parsed as comma-separated `user:password` pairs; an entry that does not split on `:` into exactly two parts is dropped, so a password containing `:` is dropped too (server.rs:718-729). It is separate from `rpc_auth`, which gates the ordinary RPC methods; credentials in `rpc_auth` do not open the mesh view (cfg.rs:102-103; server.rs:628-632, 728-729, 4032, 4092). Only HTTP Basic is accepted (rpc_extensions.rs:174-176). A `401` deliberately carries no `WWW-Authenticate` header, so a browser does not open a native login prompt (http_server.rs:2499-2503). The error body has exactly two keys, `error` and `error_detail`; the latter is always null on these routes, and there is no `status` key in the body (http_server.rs:2413-2427, 2509-2513).

Configuration layers are compiled defaults, then the TOML file named by `--config-path` (which must exist), then environment variables prefixed `SNAPCHAIN_` with `__` as the nesting separator (cfg.rs:170-171, 192-222). Mesh options live in a `[mesh]` section (cfg.rs:118; config.rs:6). Under that scheme `admin_rpc_auth` can also be set as `SNAPCHAIN_ADMIN_RPC_AUTH` and `mesh.cache_ttl_secs` as `SNAPCHAIN_MESH__CACHE_TTL_SECS`; the `[[mesh.nodes]]` table has no environment form (cfg.rs:222; config.rs:13-16).

### Caching

Responses are cached per `validators_only` key for `mesh.cache_ttl_secs` seconds, default 5; `0` disables caching (config.rs:9-11, 27; cache.rs:27-47). Two caches exist, one for views and one for topologies, each keyed only on that boolean (cache.rs:32-35), so `format` and `topics` share one cached proto and only the rendering differs (http_server.rs:5981-6002). Concurrent misses for the same key share a single computation and errors are not cached (cache.rs:8-13, 70-73, 91-94). The cache is consulted only after authentication (cache.rs:15-17). Two reads inside one TTL return the same `generated_at` and the same `current_height` (cache.rs:7-9; server.rs:4054-4066). The startup log reports the cache state (server.rs:756-764). No rate limiter, concurrency cap or `429` path applies to the route in the HTTP server file; the cache plus single-flight is the only collapsing (http_server.rs:5942-6006; cache.rs:1-13).

## Response shape

A trimmed example from the testnet validator fixture (`mesh-hst0-2026-11-19.json`). Peer ids and keys are shortened, addresses are replaced by placeholders, ports are kept as the fixture has them, keys are regrouped for reading, and ten all-zero `gossip_rates` entries are left out. Both fixtures carry three top-level keys, seventeen keys under `self` and seventeen per peer (render.rs:183-194, 206-231, 251-259).

```json
{
  "generated_at": 1795118974122,
  "self": {
    "peer_id": "12D3KooWAKzR...",
    "consensus_public_key": "0796d669...",
    "is_validator": true,
    "network": "TESTNET",
    "snapchain_version": "13",
    "current_height": 185236,
    "consensus_mesh_size": 2,
    "subscribed_topics": ["hypersnap/consensus", "hypersnap/mempool", "hypersnap/contact-info", "hypersnap/hyper"],
    "gossip_address": "/ip4/<ip>/udp/3382/quic-v1",
    "rpc_address": "http://<ip>:3383",
    "http_api_url": "http://<ip>:3381",
    "http_api_url_source": "observed",
    "name": null,
    "operator": null,
    "role": null,
    "note": null,
    "known_offline": false
  },
  "peers": [
    {
      "peer_id": "12D3KooWKgXE...",
      "node_type": "validator",
      "consensus_public_key": "92927a67...",
      "connected": true,
      "direct_peer": false,
      "contact_source": "collected",
      "observed_address": "/ip4/<ip>/udp/4382/quic-v1/p2p/12D3KooWKgXE...",
      "contact_info": {
        "gossip_address": "/ip4/<ip>/udp/4382/quic-v1",
        "announce_rpc_address": "http://<ip>:3383",
        "snapchain_version": "13",
        "network": "TESTNET",
        "timestamp": 1795118857030
      },
      "topics": [
        { "topic": "hypersnap/consensus", "subscribed": true, "in_mesh": true },
        { "topic": "hypersnap/mempool", "subscribed": true, "in_mesh": true },
        { "topic": "hypersnap/contact-info", "subscribed": true, "in_mesh": true },
        { "topic": "hypersnap/hyper", "subscribed": true, "in_mesh": true }
      ],
      "gossip_rates": [
        { "topic": "hypersnap/consensus", "msgs_per_sec": 11.733552650641585, "bytes_per_sec": 1897.0687923314297, "total_msgs": 2050654, "total_bytes": 330013313 },
        { "topic": "hypersnap/contact-info", "msgs_per_sec": 0.0, "bytes_per_sec": 0.0, "total_msgs": 571, "total_bytes": 72517 }
      ],
      "http_api_url": "http://<ip>:3381",
      "http_api_url_source": "observed",
      "name": null,
      "operator": null,
      "role": null,
      "note": null,
      "known_offline": false
    }
  ]
}
```

The peer in this example announces its gossip listener on UDP 4382, not the default 3382, and its `observed_address` carries that same port plus a trailing `/p2p/` component, while `self.gossip_address` uses 3382. The gossip port is whatever the operator announces (gossip.rs:761-764), so a client must not assume 3382 for peers.

With `?crawl=true` the top level is different: `nodes` (an array of objects in the shape above, the serving node first, then one per validator that answered), `unreachable` (validators that did not answer) and `generated_at` (render.rs:565-588; crawl.rs:99-141). Remote entries in `nodes` have `self.current_height` 0 because the diagnostics reply carries no height (crawl.rs:104-110). Each `unreachable` entry has `peer_id`, `consensus_public_key` (null when the peer id is not in the validator index), `reason` (`not_connected`, `timeout`, `error: response channel closed`, or `error: <message>` with free error text), and the seven registry annotation keys, where `http_api_url` can come only from the registry because no observed address is available (render.rs:571-585; crawl.rs:112-135, 161-165; request_response.proto:754-758). The topology `generated_at` is stamped by the RPC layer when the crawl starts (server.rs:4102-4105).

### Top-level fields

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `self` | object or null | The responding node's own block. The proto field is named `local` (request_response.proto:745-746). | Null only if the proto view has no `local`; the live builder always sets it (gossip.rs:2059-2063; render.rs:171, 236). Not free text. |
| `peers` | array of peer objects | Every peer with a live libp2p connection at snapshot time, after the `validators_only` filter (gossip.rs:1963-1969; view.rs:81-86). | Order is the swarm's iteration order (gossip.rs:1963-1968). Empty when no connected peer classifies as a validator under the default filter. Never null. |
| `generated_at` | integer, unix milliseconds | When the gossip task built the snapshot (gossip.rs:2054-2057). | May be up to `cache_ttl_secs` old (config.rs:9-11, 27; cache.rs:27-47). 0 only if the system clock is before the epoch (gossip.rs:2057). |

### Self fields

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `peer_id` | string, base58 libp2p PeerId | This node's libp2p identity (gossip.rs:2038; render.rs:172). For a validator it derives from the consensus Ed25519 key (view.rs:3-7, 27-31). | Hex of the raw bytes if they do not parse as a PeerId (render.rs:291-295). 52 characters in both fixtures. Not free text. |
| `consensus_public_key` | string of 64 lowercase hex characters, or null | The validator signing key when this node's PeerId is in the validator index (view.rs:56-60). | Null on read nodes: the gossip layer leaves it empty (gossip.rs:2039) and empty bytes render as null (render.rs:173, 297-303). The proto comment says always present (request_response.proto:720); the code and the mainnet read-node fixture say otherwise. |
| `is_validator` | boolean | True when this node's PeerId matches a key in the validator index built at startup (view.rs:54-61; server.rs:745-749). | A fixed startup map, not consensus state; the proto comment's "at current height" (request_response.proto:721) describes intent, the handler passes the static index (server.rs:4051-4064). |
| `gossip_address` | string, multiaddr | The gossip address this node announces (gossip.rs:2041): `gossip.announce_address` if set, else the detected public IP as `/ip4/<ip>/udp/3382/quic-v1` on mainnet and testnet, else the configured listen address (gossip.rs:761-785; cfg.rs:20). | Never null. Operator-controlled text. The default listen host is the loopback address (gossip.rs:50, 95-98), so a failed detection yields a non-routable value. |
| `rpc_address` | string, URL, may be empty | The announce RPC address (gossip.rs:2042): `gossip.announce_rpc_address` if set, else `http://<ip>:3383` from IP detection, empty on devnet or when detection fails (gossip.rs:741-759, 595-601; cfg.rs:21). | Operator-controlled text. The mainnet fixture carries an https host name with no port, the testnet fixture `http://<ip>:3383`; do not derive a scheme or port from it. The node itself refuses to (nodes.rs:439-443). |
| `snapchain_version` | string, decimal | The engine protocol version this node runs (gossip.rs:2036, 2043). | Not the binary release. Both fixtures show `13`. Not free text. |
| `network` | string: `MAINNET`, `TESTNET`, `DEVNET`, or `?` | The configured `fc_network` (gossip.rs:2044; cfg.rs:112, 146) mapped by name (render.rs:340-347). | `?` is the fallback for an unrecognised enum value. Not free text. |
| `subscribed_topics` | array of strings | Gossipsub topics this node is subscribed to now (gossip.rs:2045-2049). Startup set: read nodes `read-node-peers` plus `mempool` (gossip.rs:549-564), validators `consensus` plus `mempool` (gossip.rs:566-580), `contact-info` for all (gossip.rs:583-589), `hyper` when that capability is on (gossip.rs:610-617), each expanded through the topic schedule (gossip.rs:619-628). | A node can add `decided-values` at runtime (gossip.rs:1743-1746); the mainnet read-node fixture lists it. The set is re-derived by `refresh_topic_subscriptions` on that event and when the topic fork phase advances (gossip.rs:1438-1463, 1466-1470). Names equal the topic hashes because topics use identity hashing (gossip.rs:1212-1214). Not free text. |
| `consensus_mesh_size` | integer | Distinct peers in this node's emergent gossipsub mesh for the consensus topic, legacy and `hypersnap/` names combined (gossip.rs:2029-2035). | Explicit (direct) peers are kept out of `mesh_peers()` by design (render.rs:349-356). Counted before the `validators_only` filter, so it can differ from the length of `peers`; the testnet fixture reports 2 with one peer listed. A read node does not subscribe to the consensus topic (gossip.rs:549-564); the mainnet fixture reports 0. |
| `current_height` | integer | Highest block number in this node's block store when the cache entry was filled (server.rs:4054-4064; view.rs:55). | 0 from the gossip layer (gossip.rs:2051) and for crawled remote nodes (crawl.rs:104-110). Up to one cache TTL old. |
| `name` | string or null | Human-readable name from the known-node registry, looked up by consensus key first, then by peer id (render.rs:181, 249, 252; nodes.rs:362-373). | Null when the node is not in the compiled-in table or the serving node's `[[mesh.nodes]]` config (config.rs:13-21; nodes.rs:346-360). Null in both fixtures. Free text. |
| `operator` | string or null | Registry label for who runs the node: one of three fixed lowercase labels, or null (render.rs:253, 272-279; nodes.rs:20-27). | Null when not in the registry or when the entry's operator is unknown. Chosen by the registry entry, not by the live peer. Not free text. |
| `role` | string or null: `mainnet_validator`, `mainnet_reader`, `testnet_validator`, `testnet_reader` | Registry-declared role (render.rs:254, 281-289; nodes.rs:35-43). | Static metadata; use `is_validator` and `node_type` for the live answer. Null when not in the registry. Not free text. |
| `known_offline` | boolean | Registry flag that the node is known to be offline (render.rs:255; nodes.rs:72-74). | False when not in the registry. Hand-maintained; never flips at runtime. When true, `http_api_url` is suppressed (nodes.rs:448-451). |
| `note` | string or null | Free-form registry note (render.rs:256; nodes.rs:75-77). | Null when absent or not in the registry. Free text. |
| `http_api_url` | string, URL, or null | A browser-reachable HTTP base URL: the registry URL if non-empty, else `http://<host of gossip_address>:3381` when that host is public (render.rs:174-181; nodes.rs:444-466; cfg.rs:22). | Null when the registry marks the node offline, when the host is private, loopback, link-local, unspecified or broadcast, or when the multiaddr does not parse (nodes.rs:448-451, 472-517). The private test for IPv4 is exactly those five classes (nodes.rs:511-517), so a host in any other reserved range, such as shared address space, still yields an `observed` URL. DNS hosts count as public without resolution (nodes.rs:488-489, 506-507). `rpc_address` is never consulted (nodes.rs:439-443). Never probed. Free text only when it comes from the registry. |
| `http_api_url_source` | string or null: `known` or `observed` | Where `http_api_url` came from: the registry, or derived from the announced gossip address (render.rs:258; nodes.rs:80-96, 456, 464). | Null exactly when `http_api_url` is null (render.rs:257-258). Not free text. |

### Peer fields

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `peer_id` | string, base58 PeerId | The connected peer's libp2p identity (gossip.rs:2007; render.rs:202). | Hex fallback as for `self.peer_id` (render.rs:291-295). Not free text. |
| `node_type` | string: `validator`, `non-val`, or `unknown` | `validator` when the PeerId matches a validator-index key, `non-val` otherwise (view.rs:68-80; render.rs:320-328). | `unknown` is the proto default (gossip.rs:2008; request_response.proto:690-694) and never reaches the HTTP output because the handler always classifies (server.rs:4059-4064; crawl.rs:48, 110). With the default filter only `validator` appears. |
| `consensus_public_key` | string of 64 lowercase hex characters, or null | The key from the serving node's validator index when the peer matched (view.rs:72-78; render.rs:203). | Null for non-validator peers, visible only with `?validators_only=false`. The value comes from the index, not from the peer (request_response.proto:734). |
| `connected` | boolean | Always true in the live path: the list is built from connected peers and the field is a literal (gossip.rs:1963-1965, 2010). | A disconnected peer is absent, not false (gossip.rs:1151-1155). Carries no information in the local view. |
| `direct_peer` | boolean | True when the peer id is in this node's `gossip.direct_peers` config, parsed at startup (gossip.rs:2011, 629, 175-179, 84-85). | One-sided: says nothing about the peer's config. Direct peers are gossipsub explicit peers (gossip.rs:468-471) and are excluded from `mesh_peers()`, so `in_mesh` false is normal for them (render.rs:349-356). |
| `contact_source` | string: `collected`, `derived`, or `unknown` | `collected` when this node holds a validated contact advertisement from the peer, `derived` when it knows the peer only from the live connection (gossip.rs:2005, 2012-2016; render.rs:330-338). | `unknown` is the proto default (request_response.proto:677-681) and is never produced live. Both fixtures show `collected` for every peer. |
| `observed_address` | string, multiaddr, may be empty | The remote address of the most recent connection with this peer as the transport saw it; last connection wins (gossip.rs:371-376, 1085-1088). Not self-announced (request_response.proto:739). | Removed on full disconnect (gossip.rs:1151-1153); empty string when nothing is recorded (gossip.rs:2018-2022). Can be a private or overlay address: five of six peers in the mainnet fixture. The port is the remote end of the connection, not the peer's listen port: four of the six mainnet peers show a high port rather than 3382. One peer in each fixture carries a trailing `/p2p/<peer id>` component; in both fixtures those are the entries whose port equals the port in the peer's own `contact_info.gossip_address`, but the source does not say which connections carry it. Not free text. |
| `contact_info` | object or null | The peer's own contact advertisement as last accepted (gossip.rs:2017, 1534). Fields below. | Null whenever `contact_source` is `derived`. Accepted only after the checks listed under Semantics (gossip.rs:1510-1529). |
| `topics` | array of `{topic, subscribed, in_mesh}` | Per-topic state between this node and the peer, listing only topics where the peer is subscribed or is in this node's mesh (gossip.rs:1971-1992; request_response.proto:712-716). | Topics with neither are omitted, so the array can be empty, for example right after connection before SUBSCRIBE messages arrive (gossip.rs:353-359). Four entries per peer in both fixtures. |
| `gossip_rates` | array of `{topic, msgs_per_sec, bytes_per_sec, total_msgs, total_bytes}` | Per-topic inbound gossip volume from this peer (gossip.rs:1993-2004). Fields below. | Entries exist only after the sampler has run for this peer on the reconnect tick, default every 30 s (gossip.rs:858, 105, 900-909); one pass writes all 12 topics (metrics.rs:107-139), so a peer has either zero entries or all 12 (metrics.rs:143-152). Both fixtures show 12. |
| `name`, `operator`, `role`, `known_offline`, `note` | as for `self` | Registry annotations for the peer, same lookup (render.rs:204, 242-256). | Null (or false for `known_offline`) when the peer is not in the serving node's registry. Null for every peer in both fixtures. |
| `http_api_url` | string, URL, or null | Registry URL if known, else `http://<host of observed_address>:3381` when that host is public (render.rs:204, 250; nodes.rs:444-466). | Null when the observed host is private (five of six mainnet peers), when the registry marks the peer offline, or when there is no parseable address. The same narrow private test applies as for `self` (nodes.rs:511-517). The derived URL always uses 3381 even when the observed port is not 3382. `announce_rpc_address` and `contact_info.gossip_address` are not consulted (nodes.rs:439-443, 461). Never probed. |
| `http_api_url_source` | string or null: `known` or `observed` | Provenance of the peer's `http_api_url` (render.rs:258; nodes.rs:80-96). | Null when `http_api_url` is null. |

Entries of `topics`:

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `topic` | string | A name from the 12-entry `ALL_TOPICS` list (gossip.rs:61, 1984). | The list is a constant in a crate outside the copy; the fixtures show six `hypersnap/`-prefixed names and six legacy names. |
| `subscribed` | boolean | The peer has announced a subscription to this topic, as recorded by gossipsub (gossip.rs:1949-1952, 1975). | Reflects which SUBSCRIBE messages reached this node. |
| `in_mesh` | boolean | The peer is in this node's own gossipsub mesh for the topic (gossip.rs:1954-1961, 1976-1979; request_response.proto:715). | False for direct peers even when healthy (render.rs:349-356). Membership is one-directional. `subscribed` true with `in_mesh` false is the ordinary state for a topic the reporter does not subscribe to: in the mainnet read-node fixture every validator peer shows `hypersnap/consensus` that way, because a read node never joins the consensus topic (gossip.rs:549-564), and three of the six peers show it on all four of their topics. |

### contact_info fields

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `gossip_address` | string, multiaddr | The gossip address the peer announced; the sender fills it from its own announce address (gossip.rs:837). | Peer-controlled text, but the advertisement is dropped unless it parses and passes the discovery address check (gossip.rs:1522-1529). Treat as untrusted input. The port is whatever the peer announces; the testnet fixture's peer announces 4382. |
| `announce_rpc_address` | string, URL, may be empty | The RPC address the peer announced (gossip.rs:838). | Peer-controlled and not validated by the receiver; the acceptance checks cover author, network, version, timestamp and gossip address only (gossip.rs:1502-1539). Treat as untrusted input. May be empty if the sender's detection failed (gossip.rs:595-601). |
| `snapchain_version` | string | The peer's protocol version as advertised (gossip.rs:833, 840). | Equalled this node's protocol version when the advertisement was accepted (gossip.rs:1512-1515); stored entries live up to 30 minutes without re-checking (gossip.rs:1531-1535), so treat it as equal at acceptance time rather than as an invariant. Not free text. |
| `network` | string: `MAINNET`, `TESTNET`, `DEVNET`, or `?` | The peer's announced network (gossip.rs:839; render.rs:218, 340-347). | Always equals `self.network` because cross-network advertisements are rejected (gossip.rs:1511). |
| `timestamp` | integer, unix milliseconds | When the peer built the advertisement, by the peer's clock (gossip.rs:841-844). | Accepted only if not more than 5 minutes ahead or 30 minutes behind this node's clock (gossip.rs:1509, 1516-1517). Compare with `generated_at` yourself. |

On the wire the advertisement also carries `peer_id` and `capabilities` (request_response.proto:656, 661); neither is rendered into JSON (render.rs:214-220).

### gossip_rates fields

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `topic` | string | One of the 12 `ALL_TOPICS` names (gossip.rs:1995; metrics.rs:148-149). | Not free text. |
| `msgs_per_sec` | number | Accepted inbound messages from this peer on the topic per second, averaged between the last two sampler refreshes (metrics.rs:116-127). | 0.0 on the first sample after connect because no previous snapshot exists (metrics.rs:121). Interval defaults to 30 s (gossip.rs:105, 858, 900-909). |
| `bytes_per_sec` | number | Payload bytes per second over the same interval (metrics.rs:125). | Same first-sample behaviour. |
| `total_msgs` | integer | Cumulative messages received from this peer as propagation source on the topic that passed the inbound topic filter, since connection (gossip.rs:1194-1220; metrics.rs:98-102, 114, 117). | Reset when the peer fully disconnects (gossip.rs:1151-1152; metrics.rs:156-166). Counts relayed messages as well as authored ones (gossip.rs:1195, 1216-1217). |
| `total_bytes` | integer | Cumulative sum of the data length of the same messages (gossip.rs:1219; metrics.rs:101, 115, 118). | Same reset rule. |

## Semantics and caveats

- Two layers build the response. The gossip task emits raw peer facts and leaves `node_type` unknown, `consensus_public_key` empty, `is_validator` false and `current_height` 0 (gossip.rs:1940-1945, 2008-2009, 2039-2040, 2051). The RPC layer fills those four from its validator index and block store (view.rs:45-62; server.rs:4054-4064). Registry annotations are added at render time (render.rs:181, 204, 242-260).
- Validator identity is cryptographic: each configured validator Ed25519 public key is converted to a libp2p PeerId and connected peers are matched against that map, with no topic heuristic (view.rs:3-7, 19-31, 67-80). The index is built once when the service is constructed and the count is logged as `Mesh view: indexed N validator peer ids` (server.rs:698-701, 745-749). Malformed keys are skipped (view.rs:33-43). The code that supplies the key list is outside the copy.
- Everything is the reporting node's view. `node_type`, `consensus_public_key`, `is_validator`, `name`, `role` and `known_offline` come from that node's own index and registry (server.rs:745; view.rs:54-80; config.rs:13-21), so two nodes can label the same third node differently. `in_mesh` is membership in the reporter's own mesh, `subscribed` records the SUBSCRIBE messages that reached the reporter, and `direct_peer` reflects only the reporter's config (request_response.proto:715, 736; gossip.rs:1949-1951, 2011). The topology matrix encodes this with `>` and `<` (render.rs:487-497).
- A healthy direct peer shows `in_mesh` false. The ASCII renderer treats a subscribed direct peer as a first-class link (render.rs:349-388); a JSON consumer that wants the same answer must apply `in_mesh OR (direct_peer AND subscribed)` or it will report every direct peering as a partition.
- `consensus_mesh_size` is the emergent mesh only, excludes direct peers, and is counted before the `validators_only` filter (gossip.rs:2029-2035; view.rs:64-88). It and the length of `peers` are computed from different sets and may differ, as the testnet fixture shows (2 against 1). The gossipsub mesh target is `mesh_n` 10 and `mesh_n_high` 20 (gossip.rs:453-454).
- Contact advertisements are published on `contact_info_interval` (default 300 s) only by read nodes, or by any node when `gossip.discovery` is enabled (gossip.rs:860, 104, 1057-1061). A received advertisement is stored only if its `peer_id` equals the signature-checked gossip author, the network matches, the protocol version equals this node's, the timestamp is at most 5 minutes ahead and 30 minutes behind, and the gossip address parses and passes the discovery filter (gossip.rs:1501-1529; peer-discovery.md:45-48). Entries older than 30 minutes are pruned when the next advertisement passes those checks, and the map is capped at the discovery peer limit (gossip.rs:1531-1535); the discovery module that defines that limit and the address filter is not in the copy, and peer-discovery.md:41 states 512 candidates. Two code comments say validators never publish contact info (crawl.rs:7-10; gossip.rs:1908-1912); both fixtures from 2026-11-19 show every validator peer as `collected`, consistent with the discovery gate above.
- `gossip_rates` is refreshed on the bootstrap reconnect tick for all connected peers across all 12 topics (gossip.rs:900-909; metrics.rs:107-139), counts inbound traffic only (metrics.rs:84-92, 97-102), and is evicted on disconnect, so totals restart at zero after a reconnect (metrics.rs:154-166; gossip.rs:1151-1152). Zero rows for topics the peer does not carry are normal.
- gossipsub lists a peer the instant the connection is established, before SUBSCRIBE messages arrive, so a fresh peer can have an empty `topics` array; the node's own self-heal sweep allows 30 s for that handshake before treating a missing `contact-info` subscription as a fault (gossip.rs:353-359, 919-928).
- An empty `peers` array has several ordinary causes. The default filter drops every peer not in the validator index, so a read node fed by other read nodes returns `[]` while fully connected; the dashboard's main view and its topology request ask with `validators_only=false`, and only its fallback fetch of the local peer id uses the default (http_server.rs:5948; view.rs:81-86; ui.html:663, 706, 709). An index that does not match the live set (empty, old, or changed after startup) classifies nothing as a validator (server.rs:745-749; view.rs:35-43). The self-heal sweep disconnects direct, bootstrap and discovered peers that stay connected 30 s without a `contact-info` subscription, with a 60 s cooldown that doubles per repeat up to 32 times the base (gossip.rs:976-1001, 253-256), so a node mid-bounce can show a shrinking list.
- Two nodes read at different moments can disagree about a shared peer: each reports its own connected set at its own `generated_at` behind its own cache, and a QUIC reconnect or a sweep bounce between the two reads makes one side list the peer and the other not (gossip.rs:1963-1969, 2054-2057, 1157-1159, 997-1001; cache.rs:27-35). Because `connected` is never false, disagreement shows as presence against absence.
- The known-node registry is a static in-memory table: the compiled-in list plus `[[mesh.nodes]]` TOML entries merged at startup, matched by consensus key (preferred, case-insensitive) or peer id; a match replaces the whole builtin entry, an unmatched entry is appended, an entry with neither key is skipped with a warning, and the env-var form `SNAPCHAIN_MESH__NODES` is not supported (nodes.rs:343-373, 411-431; config.rs:13-21). Nothing writes to it at runtime and entries never expire. The compiled-in table covers mainnet and testnet nodes; testnet readers are keyed by peer id only because they carry a node-identity key rather than a validator key (nodes.rs:125-128). Neither fixture node matched the serving node's registry, so `name` is null throughout; a client that wants display names keeps its own table keyed the same way, consensus key first and peer id second (nodes.rs:362-373). The dashboard labels a node by `name` when present and otherwise by the last 7 characters of its peer id (ui.html:261-262).
- The registry is not the discovery cache. Discovery persists authenticated addresses once a minute to `<rocksdb_dir>/discovered-peers-<network>.json`, keeps up to 512 candidates, expires addresses after 24 hours and re-authenticates after restart (peer-discovery.md:41-54; gossip.rs:864, 893-897). That cache drives dialing and never feeds the JSON annotations.
- `self.network` and every `contact_info.network` carry the same label because the receiver stores advertisements only from its own network (gossip.rs:1511, 2044), so a client can key its environment (mainnet or testnet) on `self.network` from the response rather than on its own configuration.
- Free text a client must treat as untrusted: `contact_info.gossip_address` (parse-validated only, gossip.rs:1522-1529), `contact_info.announce_rpc_address` (not validated, gossip.rs:1502-1539), `self.gossip_address` and `self.rpc_address` (operator config, gossip.rs:741-785), and the registry fields `name`, `note` and `http_api_url` (nodes.rs:55-78, 346-360). Every other value is computed by the node.
- Three naming traps. The proto comment calls `MeshSelf.consensus_public_key` always present (request_response.proto:720) but the code returns null for read nodes (render.rs:297-303; view.rs:56-60). `self.rpc_address` is whatever the operator put in `announce_rpc_address`, an https host name without a port in the mainnet fixture; the node derives `http_api_url` from the gossip address host plus 3381 instead (nodes.rs:439-443, 461-466; cfg.rs:22). The mesh module's own doc comment calls the crawl recursive (mod.rs:1-2), but the implemented crawl is one hop and the recursion fields in the request are ignored (crawl.rs:5-16, 76-80; request_response.proto:698-701).
- The crawl (`?crawl=true`) fetches the local view (500 ms deadline), then sends one request over the libp2p protocol `/snapchain/diagnostics/mesh/1.0.0` on the gossip port to every connected peer classified as a validator, at most 256, waits up to 3 s per peer concurrently, and aggregates (crawl.rs:28-35, 47-121; diagnostics.rs:1-2, 20-21). Messages are prost-encoded blobs capped at 8 MiB (diagnostics.rs:7-9, 25). It is connected-only and one hop: it never dials, never queries read nodes, and lists validators without a live connection as `not_connected` (crawl.rs:5-16, 59-69, 124-135). A responder answers only requesters in its own validator set, which is set once at startup and is fail-closed (gossip.rs:384-389, 712-717, 1310-1332); a refusal reaches the requester as an outbound failure or an empty body treated as `request refused` (gossip.rs:1343-1346; diagnostics.rs:61-70), so a crawl started from a read node lists the validators it queried under `unreachable` with an `error:` or `timeout` reason (crawl.rs:112-120). Remote views are classified against the crawler's index, not the responder's (gossip.rs:1320-1321; crawl.rs:110).
- The node never fetches other nodes' `/v1/info` or `/v1/mesh` over HTTP; the diagnostics request is the only server-side cross-node query (crawl.rs:1-3). The dashboard performs the `/v1/info` fan-out from the browser, ungated, with a 4 s timeout, and flags `http://` nodes as blocked when the page itself is served over HTTPS (ui.html:296-298, 310-319). The dashboard keeps typed credentials in the tab's sessionStorage and sends them as a Basic header with `credentials: "omit"` (ui.html:147-149, 247-258).
- The README has no mention of `/v1/mesh`, `admin_rpc_auth` or the dashboard; its HTTP guidance is that ports 3381 to 3383 must be exposed (README.md:26), that `/v1/info` shows sync progress (README.md:34), and a backfill status route (README.md:163). The peer-discovery document mentions the consensus mesh only as a statsd metric (peer-discovery.md:65-68). No Markdown document in the copy describes the endpoint; the in-source descriptions are the handler doc comment (http_server.rs:5938-5941), the dashboard module doc (ui.rs:1-6), the dashboard route doc (http_server.rs:6009-6017), the gRPC method comments (rpc.proto:27-31), the mesh module doc (mod.rs:1-5) and the `[mesh]` config docs (config.rs:6-21).

## What it does not tell you

- Whether a validator signs, proposes or votes. `is_validator` is a key-list membership test and `consensus_mesh_size` is gossip topology (view.rs:54-62; gossip.rs:2029-2035); the only consensus-adjacent health signal in this path is a statsd gauge that is not part of the response (gossip.rs:1037-1044). No field in `MeshSelf` or `MeshPeer` reads consensus state (request_response.proto:718-742).
- Any peer's height or sync state. `MeshPeer` has no height, block time or shard field (request_response.proto:731-742), and in a crawl every remote `self.current_height` is 0 by design (crawl.rs:104-110). Per-node height and block delay come from `/v1/info` (README.md:34; ui.html:400-403).
- The release version. `snapchain_version` on `self` and in `contact_info` is the engine protocol version, 13 for every node in both fixtures (gossip.rs:833, 840, 2036, 2043). The application release is `GetInfoResponse.version` via `/v1/info` (request_response.proto:55-56; ui.html:400).
- Whether an HTTP API is reachable. `http_api_url` is a table value or a guess of host plus 3381 with an `http` scheme and is never probed (nodes.rs:434-437, 461-466); null means only that no public-looking address was available.
- A peer's listen port. `observed_address` carries the port the transport saw at the remote end, and `http_api_url` always appends 3381 (gossip.rs:1085-1088; nodes.rs:463); the announced gossip port is in `contact_info.gossip_address` only when an advertisement was collected (gossip.rs:837).
- What the peer sees. The local view is one-directional: for a `derived` peer the node exposes only the peer id and observed address (gossip.rs:2012-2022); announce addresses and the peer's protocol version appear only when an advertisement was collected; capabilities are never rendered (render.rs:214-220); nothing reports what the peer thinks of this node.
- Outbound traffic or authorship. `gossip_rates` counts messages received from the peer as propagation source, authored or relayed (gossip.rs:1195, 1216-1217; metrics.rs:84-92, 97-102); nothing records what this node sent or whether the peer accepted it.
- The whole network from one node. Without `?crawl=true` the response is one node's neighbourhood; with it the picture still covers only validators the serving node is connected to and that accept its request, never read nodes' views, and the crawl is not recursive (crawl.rs:5-16, 76-80; request_response.proto:698-701).
- A validator-set change since startup. The index is built once (server.rs:745-749) and is not rebuilt at runtime; a change that takes effect later is not reflected until restart.
- Names for nodes outside the serving node's registry. Both fixtures return `name` null for `self` and every peer, and `http_api_url_source` is `observed` wherever a URL is present.

## How snapdiff uses it

snapdiff read this endpoint for one day (2026-11-19) and moved to `/v1/currentPeers` on 2026-11-20, because `/v1/mesh` sits behind `admin_rpc_auth` and operators lock it (haatz did, and others may). `currentPeers` is the ordinary HubService route, open whenever the HTTP API is, and returns `contacts` (collected contact-info bodies) and `peers` (every live connection, source `collected` or `derived`, with `peer_id` and `observed_address`); it carries no validator classification. snapdiff derives each peer's consensus key from its peer id (identity multihash: `00 24 08 01 12 20` followed by the 32-byte ed25519 key, base58) and classifies it against the network's validators file, fetched from the snapdiff server on a timer (`src/validators.ts`); the node's own peer id comes from `/v1/info`. The same safety contract applies: peer ids matching the fixed pattern, derived key prefixes, counts, and fixed phrases only; addresses, versions and capabilities are never read. The page therefore shows, per node, the connected validators, the set members it is not connected to, and whether the node itself is in the current or a future set, which this endpoint's `is_validator` and `node_type` could only answer for nodes that leave it open. This document stays as the reference for the richer view an operator can read on their own node.

## Sources

Upstream node source: the Hypersnap node repository, `main` branch, fetched 2026-11-19. Short names used above expand as follows.

| Short name | Path |
|---|---|
| `render.rs` | `src/network/mesh/render.rs` |
| `view.rs` | `src/network/mesh/view.rs` |
| `nodes.rs` | `src/network/mesh/nodes.rs` |
| `cache.rs` | `src/network/mesh/cache.rs` |
| `config.rs` | `src/network/mesh/config.rs` |
| `crawl.rs` | `src/network/mesh/crawl.rs` |
| `diagnostics.rs` | `src/network/mesh/diagnostics.rs` |
| `metrics.rs` | `src/network/mesh/metrics.rs` |
| `mod.rs` | `src/network/mesh/mod.rs` |
| `ui.rs`, `ui.html` | `src/network/mesh/ui.rs`, `src/network/mesh/ui.html` |
| `http_server.rs` | `src/network/http_server.rs` |
| `server.rs` | `src/network/server.rs` |
| `rpc_extensions.rs` | `src/network/rpc_extensions.rs` |
| `gossip.rs` | `src/network/gossip.rs` |
| `cfg.rs` | `src/cfg.rs` |
| `rpc.proto`, `request_response.proto` | `proto/definitions/rpc.proto`, `proto/definitions/request_response.proto` |
| `README.md`, `peer-discovery.md` | `README.md`, `docs/peer-discovery.md` (upstream; the snapdiff README is always labelled as such) |

Two real responses saved on 2026-11-19 and kept as test fixtures in this repository: `test/fixtures/mesh-ohsnap-2026-11-19.json` (a mainnet read node, six validator peers) and `test/fixtures/mesh-hst0-2026-11-19.json` (a testnet validator, one validator peer). Addresses in the fixtures are replaced in this page by placeholders; in the fixture files themselves, hosts that were public lie in the documentation address ranges, so nothing about the node's public-host test can be read from them. The `ALL_TOPICS` constant (`gossip.rs:61`) aliases a list in a crate that was not part of the copy; the 12 names stated here are the ones the fixtures show. The discovery module (`discovery::MAX_PEERS`, `discovery::address`, referenced at `gossip.rs:1526, 1533`) is also outside the copy. snapdiff's own client is `src/mesh.ts` with tests in `test/mesh.test.ts`.
