# MonkeLedger

A self-hosted Merkle-proof-serving replica for a compressed-NFT (cNFT) tree on Solana.

## Why this exists

Every Bubblegum (cNFT) transfer needs a live Merkle inclusion proof. Normally that means calling
a DAS provider (Helius, etc.) at the exact moment of every transfer — which makes that provider's
uptime a real-time single point of failure for anything that builds cNFT transactions (a
marketplace, a wallet, a game).

MonkeLedger removes that dependency by periodically rebuilding its own local copy of the tree
from a full DAS snapshot, independently verifying the rebuild against the tree's live on-chain
root (read directly from the account, not trusted from any provider), and refusing to serve
anything that doesn't match. It still uses a DAS provider — just once every refresh cycle instead
of once per request.

**No funds are ever at risk if this is wrong or out of date.** A stale or bad proof gets rejected
atomically on-chain by the Bubblegum program itself; the worst case is a failed transaction, not
a wrong one.

## How it works

1. On a timer (default 10 min), fetch every asset in the configured collection via DAS
   `getAssetsByGroup`, and read the tree's current root twice (before and after the fetch) to
   confirm nothing changed on-chain mid-scan.
2. Rebuild a local Merkle tree from that snapshot (same padding/hashing convention as
   `@solana/spl-account-compression`'s own tree implementation — burned leaves are excluded, since
   DAS keeps a stale hash for them forever even after the true on-chain leaf is zeroed).
3. Compare the rebuilt root to the live on-chain root. If they don't match, the refresh is
   discarded and the previous known-good state stays in place.
4. Serve proofs from the verified in-memory cache — no live RPC call per request, so request
   volume never translates into DAS-provider cost. A `/status` age check refuses to serve if the
   cache is stale beyond a safety threshold.

## Running it

```bash
cp .env.example .env   # fill in your own Helius API key (see note below), tree/collection
bun install
bun start
```

## Endpoints

- `GET /health` — liveness check.
- `GET /status` — `{ ready, builtAtMs, ageMs, leafCount, root }`.
- `GET /compression/:assetId` — everything needed to build or verify a Bubblegum transfer for one
  asset: `{ assetId, tree, root, dataHash, creatorHash, leafIndex, proof, owner, delegate }`
  (all hashes base58-encoded). 503 if the index isn't ready/is too stale, 404 if the asset isn't
  in this tree.
- `GET /owner/:assetId` — `{ owner, delegate }` for a quick ownership check.
- `GET /wallet/:address` — `{ owns, count, assets }` — does this wallet hold any asset in the collection, and which ones.
- `GET /metadata/:assetId` — `{ name, symbol, image, traits }` — display metadata, captured for free from the same DAS snapshot used to build the tree (Helius resolves the Arweave JSON on its end; we just save what it already hands us instead of re-fetching per request).
- `GET /export` — the full collection as one static array: `[{ number, name, mint, image, traits }, ...]`, sorted by number. Ownership isn't included — it changes far too often for a static file; use `/wallet`/`/owner` for that. Everything else here (traits, image, mint) is effectively fixed for an existing asset.

All read-only, no auth, rate-limited per IP (see `.env.example`) — this is the same public,
on-chain-derivable data any DAS provider already serves to anyone with an API key.

## Running your own instance

This is meant to be forked. If you're pointing your own app at Saga Monkes' hosted instance
instead of running your own, please don't — run your own with your own Helius key. **Use a
dedicated API key, never one shared with anything else you operate** — if this service's traffic
ever spikes (legitimate load, abuse, or someone hot-linking your instance instead of running
their own), a dedicated key means the worst case is this service degrading, never anything else
you run.

To point this at a different collection, change `TREE_ADDRESS`/`COLLECTION_ADDRESS` in `.env` —
nothing else is Saga-Monkes-specific.

## Deploying

Runs as a single always-on process (systemd, pm2, a container — whatever you already use). It
should run as its OWN process, separate from anything latency- or uptime-sensitive you operate —
the whole point is that nothing which happens to this service (a traffic spike, a crash, a stuck
refresh) can ever affect anything else.

## Public URL (optional Cloudflare Worker front)

`worker/` is a small Cloudflare Worker that reverse-proxies to the backend above, giving it a real
HTTPS URL (a raw `http://ip:port` looks bad and is one more thing to keep secret/stable) plus
Cloudflare's edge as a shock absorber in front of a deliberately resource-capped VPS process.
Entirely optional — the backend works fine addressed directly.

```bash
cd worker
npm install
npx wrangler secret put PROXY_SECRET   # generate with e.g. `openssl rand -hex 32`
npx wrangler deploy
```

Then set the same value as `PROXY_SECRET` in the backend's `.env` and restart it — this lets the
backend trust the real client IP the Worker forwards for rate-limiting purposes, without letting
a direct caller (the backend's port is still openly reachable) spoof one to dodge its own limit.
