// Farcaster Mini App surface (https://miniapps.farcaster.xyz/docs/specification, read
// 2026-11-18). snapdiff does nothing special inside a client; it only has to be openable
// there, which takes three things:
//   1. /.well-known/farcaster.json: the manifest, with an accountAssociation the operator
//      signs once with the Farcaster manifest tool (three base64 strings, kept in .env), and
//      the app metadata (name, home, icon, splash). Served only when the association is set.
//   2. An fc:miniapp meta tag on every page: the embed card (3:2 image, launch button).
//      fc:frame carries the same JSON for older clients.
//   3. sdk.actions.ready() once the page is up (static/miniapp.mjs, vendored SDK bundle), or
//      the host keeps its splash screen forever.
// Images are static PNGs under /static, generated in-repo; nothing is fetched from outside.
// Field limits come from the manifest schema in farcasterxyz/miniapps (packages/miniapp-core/
// src/schemas): name 32, subtitle 30, description 170, ogTitle 30, ogDescription 100, five
// tags of 20 characters without spaces, no emoji; the manifest tool rejects anything longer.
import type { Config } from "./config.js";

export interface MiniAppAssociation {
  header: string;
  payload: string;
  signature: string;
}

export interface MiniAppConfig {
  /** App name shown by hosts, at most 32 characters. */
  name: string;
  /** Null until the operator signs the domain; the manifest route answers 404 until then. */
  association: MiniAppAssociation | null;
}

export const MINIAPP_NAME_MAX = 32;
const B64_RE = /^[A-Za-z0-9+/_=-]+$/;

export function loadMiniApp(env: NodeJS.ProcessEnv = process.env): MiniAppConfig {
  const name = (env["MINIAPP_NAME"] ?? "snapdiff").trim() || "snapdiff";
  if (name.length > MINIAPP_NAME_MAX) throw new Error(`MINIAPP_NAME must be at most ${MINIAPP_NAME_MAX} characters`);
  const parts = ["MINIAPP_ASSOCIATION_HEADER", "MINIAPP_ASSOCIATION_PAYLOAD", "MINIAPP_ASSOCIATION_SIGNATURE"].map((k) => (env[k] ?? "").trim());
  const set = parts.filter((p) => p !== "").length;
  if (set === 0) return { name, association: null };
  if (set !== 3) throw new Error("MINIAPP_ASSOCIATION_HEADER, _PAYLOAD and _SIGNATURE must be set together (all three come from the Farcaster manifest tool)");
  for (const p of parts) if (!B64_RE.test(p)) throw new Error("MINIAPP_ASSOCIATION_* values must be the base64 strings from the manifest tool, unquoted");
  return { name, association: { header: parts[0]!, payload: parts[1]!, signature: parts[2]! } };
}

/** The embed JSON for the fc:miniapp meta tag. `origin` is https://host, no trailing slash. */
export function embedJson(cfg: Pick<Config, "miniapp">, origin: string, path: string): string {
  return JSON.stringify({
    version: "1",
    imageUrl: `${origin}/static/embed.png`,
    button: {
      title: "Open snapdiff",
      action: { type: "launch_miniapp", name: cfg.miniapp.name, url: `${origin}${path}`, splashImageUrl: `${origin}/static/splash.png`, splashBackgroundColor: "#8a63d2" },
    },
  });
}

/** The manifest body, or null when the association is not configured. */
export function manifestJson(cfg: Pick<Config, "miniapp">, origin: string): Record<string, unknown> | null {
  if (cfg.miniapp.association === null) return null;
  return {
    accountAssociation: cfg.miniapp.association,
    miniapp: {
      version: "1",
      name: cfg.miniapp.name,
      iconUrl: `${origin}/static/icon.png`,
      homeUrl: `${origin}/`,
      splashImageUrl: `${origin}/static/splash.png`,
      splashBackgroundColor: "#8a63d2",
      subtitle: "Snapchain and Hypersnap nodes",
      description: "Read-only dashboard: node liveness, versions, shard stalls, cast relay comparison between the networks, and the testnet cast explorer.",
      primaryCategory: "developer-tools",
      tags: ["farcaster", "hypersnap", "snapchain", "nodes", "monitoring"],
      heroImageUrl: `${origin}/static/og.png`,
      ogTitle: cfg.miniapp.name,
      ogDescription: "Snapchain and Hypersnap node health",
      ogImageUrl: `${origin}/static/og.png`,
      noindex: false,
    },
  };
}
