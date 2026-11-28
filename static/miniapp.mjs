// Mini App bootstrap. Inside a Farcaster or Hypersnap client the host shows a splash screen
// until the page calls ready(); outside one this does nothing. The SDK is the vendored
// @farcaster/miniapp-sdk 0.4.0 bundle served from this origin, so the CSP stays 'self'.
import { sdk } from "./miniapp-sdk-0.4.0.mjs";
let inApp = false;
try {
  inApp = await sdk.isInMiniApp();
  if (inApp) await sdk.actions.ready();
} catch {
  // Not in a Mini App host, or the host did not answer: the page is already visible.
}

// External links inside a Mini App host (operator, 2026-11-27): the app runs in the client's
// webview, where a target="_blank" link can open nothing or replace the app itself. The host's
// openUrl opens the page in the client's own browser instead. Same-origin links (tabs, jump
// links, the chain filter) keep their normal behavior. Outside a host nothing changes.
if (inApp) {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    if (!a) return;
    let url;
    try {
      url = new URL(a.getAttribute("href") ?? "", location.href);
    } catch {
      return;
    }
    if (url.origin === location.origin || (url.protocol !== "https:" && url.protocol !== "http:")) return;
    e.preventDefault();
    Promise.resolve()
      .then(() => sdk.actions.openUrl(url.href))
      .catch(() => window.open(url.href, "_blank", "noopener"));
  });
}
