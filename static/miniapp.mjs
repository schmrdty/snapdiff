// Mini App bootstrap. Inside a Farcaster or Hypersnap client the host shows a splash screen
// until the page calls ready(); outside one this does nothing. The SDK is the vendored
// @farcaster/miniapp-sdk 0.4.0 bundle served from this origin, so the CSP stays 'self'.
import { sdk } from "./miniapp-sdk-0.4.0.mjs";
try {
  if (await sdk.isInMiniApp()) await sdk.actions.ready();
} catch {
  // Not in a Mini App host, or the host did not answer: the page is already visible.
}
