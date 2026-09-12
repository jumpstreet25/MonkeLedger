export interface Env {
  BACKEND_ORIGIN: string;
  PROXY_SECRET: string;
}

const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MonkeLedger</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6; }
  h1 { margin-bottom: 0.25rem; }
  .sub { color: #888; margin-top: 0; }
  code { background: rgba(127,127,127,0.15); padding: 0.15em 0.4em; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
  td, th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid rgba(127,127,127,0.25); vertical-align: top; }
  a { color: inherit; }
  footer { margin-top: 3rem; color: #888; font-size: 0.9em; }
</style>
</head>
<body>
  <h1>🐒 MonkeLedger</h1>
  <p class="sub">A self-hosted Merkle-proof-serving replica for the Saga Monkes compressed-NFT tree.</p>
  <p>Watches for on-chain changes continuously (cheap root polling, ~2 min) and only re-scans the full collection when something actually moved, independently verifies the rebuild against the live on-chain root, and serves proofs/ownership/metadata from that verified cache — no live third-party API call per request. Source: <a href="https://github.com/jumpstreet25/MonkeLedger">github.com/jumpstreet25/MonkeLedger</a>.</p>
  <table>
    <tr><th>Endpoint</th><th>What it does</th></tr>
    <tr><td><a href="/status"><code>GET /status</code></a></td><td>Index health: ready, age, leaf count, current root.</td></tr>
    <tr><td><a href="/export"><code>GET /export</code></a></td><td>Every live Monke as one array: number, mint, traits, current Arweave image URL.</td></tr>
    <tr><td><code>GET /compression/:assetId</code></td><td>Everything needed to build or verify a Bubblegum transfer for one asset.</td></tr>
    <tr><td><code>GET /owner/:assetId</code></td><td>Current owner + delegate for one asset.</td></tr>
    <tr><td><code>GET /wallet/:address</code></td><td>Does this wallet hold any Saga Monke, and which ones.</td></tr>
    <tr><td><code>GET /metadata/:assetId</code></td><td>Name, image, and traits for one asset.</td></tr>
    <tr><td><a href="/holders"><code>GET /holders</code></a></td><td>Same as /export, but with current owner+delegate included — for a holder census or rebuilding a wallet-keyed index in one pull.</td></tr>
    <tr><td><a href="/burnt"><code>GET /burnt</code></a></td><td>The memorial list — every Monke ever burnt, with its last-known number/name/traits (image where known).</td></tr>
  </table>
  <p>All endpoints are read-only, public, and rate-limited. This is the same public, on-chain-derivable data any DAS provider already serves — nothing here is private.</p>
  <footer>Fronted by Cloudflare in front of an isolated, resource-capped backend process.</footer>
</body>
</html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(LANDING_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    const origin = new URL(env.BACKEND_ORIGIN);
    const target = new URL(url.pathname + url.search, origin);

    // X-Proxy-Secret lets the backend trust X-Forwarded-For as the REAL client IP only when it
    // came through this Worker — the backend's port is still directly reachable (see README),
    // so without this a direct caller could spoof X-Forwarded-For to dodge rate limiting.
    const clientIp = request.headers.get("CF-Connecting-IP");
    const requestHeaders = new Headers({ "X-Proxy-Secret": env.PROXY_SECRET });
    if (clientIp) requestHeaders.set("X-Forwarded-For", clientIp);

    const proxied = await fetch(target.toString(), {
      method: request.method,
      headers: requestHeaders,
    });

    // Re-wrap the response so we control caching/CORS headers rather than passing the backend's
    // through verbatim — this is public read-only data, safe to allow browser fetches from
    // anywhere. Cache TTL varies by how volatile the endpoint actually is:
    //   - /export, /metadata, /burnt: display data that only changes on a rare on-chain metadata
    //     update (or, for /burnt, an even rarer new burn) — safe to cache generously.
    //   - /wallet, /owner, /compression: ownership/proof data — short cache only, enough to
    //     absorb a burst of identical requests without meaningfully risking staleness beyond
    //     what the backend's own freshness check already tolerates.
    //   - /status, /health: exist specifically to report LIVE state — never cache.
    const responseHeaders = new Headers(proxied.headers);
    responseHeaders.set("access-control-allow-origin", "*");
    if (url.pathname.startsWith("/export") || url.pathname.startsWith("/metadata/") || url.pathname === "/burnt") {
      responseHeaders.set("cache-control", "public, max-age=300");
    } else if (url.pathname === "/status" || url.pathname === "/health") {
      responseHeaders.set("cache-control", "no-store");
    } else {
      responseHeaders.set("cache-control", "public, max-age=10");
    }

    return new Response(proxied.body, { status: proxied.status, headers: responseHeaders });
  },
};
