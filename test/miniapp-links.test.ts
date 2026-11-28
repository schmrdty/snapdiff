// static/miniapp.mjs inside a Mini App host (operator, 2026-11-27): external links go through the
// host's openUrl; same-origin links and non-web schemes are left alone; outside a host nothing is
// intercepted. The real file runs against a stub SDK and fake page globals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../static/miniapp.mjs", import.meta.url), "utf8");

class FakeElement {
  constructor(private href: string | null) {}
  closest(sel: string) {
    return sel === "a[href]" && this.href !== null ? this : null;
  }
  getAttribute(name: string) {
    return name === "href" ? this.href : null;
  }
}

async function load(inApp: boolean, openFails = false) {
  const opened: string[] = [];
  const fallback: string[] = [];
  let handler: ((e: unknown) => void) | null = null;
  const g = globalThis as Record<string, unknown>;
  g["Element"] = FakeElement;
  g["location"] = { href: "https://snapdiff.test/?view=cards", origin: "https://snapdiff.test" };
  g["document"] = { addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === "click") handler = fn; } };
  g["window"] = { open: (u: string) => fallback.push(u) };
  g["__sdk"] = {
    isInMiniApp: async () => inApp,
    actions: {
      ready: async () => {},
      openUrl: async (u: string) => {
        if (openFails) throw new Error("host refused");
        opened.push(u);
      },
    },
  };
  const src = SRC.replace(/^import \{ sdk \} from "\.\/miniapp-sdk-0\.4\.0\.mjs";$/m, "const sdk = globalThis.__sdk;");
  assert.notEqual(src, SRC, "the SDK import line is where the test expects it");
  await import(`data:text/javascript,${encodeURIComponent(src)}#${Math.random()}`);
  const click = async (href: string | null, extra: Record<string, unknown> = {}) => {
    let prevented = false;
    handler?.({ target: new FakeElement(href), button: 0, defaultPrevented: false, preventDefault: () => { prevented = true; }, ...extra });
    await new Promise((r) => setTimeout(r, 0));
    return prevented;
  };
  return { opened, fallback, click, hasHandler: () => handler !== null };
}

test("miniapp links: inside a host, external links open through openUrl", async () => {
  const m = await load(true);
  assert.equal(await m.click("https://x.com/me"), true);
  assert.equal(await m.click("https://q.test/me?a=1"), true);
  assert.deepEqual(m.opened, ["https://x.com/me", "https://q.test/me?a=1"]);
});

test("miniapp links: same-origin, hash, and non-web links keep their normal behavior", async () => {
  const m = await load(true);
  for (const href of ["/?net=testnet", "#stalls", "https://snapdiff.test/?view=cards", "mailto:a@b.test", null]) {
    assert.equal(await m.click(href), false, `left alone: ${href}`);
  }
  assert.equal(await m.click("https://x.com/me", { metaKey: true }), false, "a modified click is the reader's choice");
  assert.deepEqual(m.opened, []);
});

test("miniapp links: if the host refuses, the link still opens in a new window", async () => {
  const m = await load(true, true);
  assert.equal(await m.click("https://x.com/me"), true);
  assert.deepEqual(m.fallback, ["https://x.com/me"]);
});

test("miniapp links: outside a host nothing is intercepted", async () => {
  const m = await load(false);
  assert.equal(m.hasHandler(), false);
});
