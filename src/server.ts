import express from "express";
import { PublicKey } from "@solana/web3.js";
import { getCompressionDataForAsset, getOwnerOfAsset, getAssetsOwnedByWallet, getMetadataForAsset, exportAll, getHolders, getStatus, getBurnt } from "./indexer";
import { rateLimit } from "./rateLimit";
import { PORT, BIND_HOST, REFRESH_INTERVAL_MS } from "./config";

// Staleness threshold for refusing to serve — 2x the refresh interval means at least one full
// cycle was missed, which is worth surfacing as "don't trust this" rather than silently serving
// arbitrarily old data if the refresh loop is stuck/erroring.
const MAX_ACCEPTABLE_AGE_MS = REFRESH_INTERVAL_MS * 2;

export function startServer(): void {
  const app = express();
  app.disable("x-powered-by");
  app.use(rateLimit);

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/status", (_req, res) => {
    res.json(getStatus());
  });

  // "The helper file" — a full static dump (number, mint, traits, current Arweave image URL) for
  // every live asset. Ownership deliberately isn't included here; it changes too often for a
  // static file and is what /wallet and /owner are for.
  app.get("/export", (_req, res) => {
    const status = getStatus();
    if (!status.ready) {
      res.status(503).json({ error: "index not ready — try again shortly" });
      return;
    }
    res.json(exportAll());
  });

  // Same shape as /export, but with current owner+delegate included — for a holder census or
  // rebuilding a wallet-keyed index, where you need ownership and metadata together in one pull
  // instead of stitching /export + N /wallet calls yourself. Ownership changes far more often
  // than /export's fields, so don't cache this as long as /export.
  app.get("/holders", (_req, res) => {
    const status = getStatus();
    if (!status.ready) {
      res.status(503).json({ error: "index not ready — try again shortly" });
      return;
    }
    res.json(getHolders());
  });

  // The memorial list — every Monke ever burnt (backfilled + live-captured), with its last-known
  // name/image/traits. Always available once the process has booted (loaded synchronously before
  // the server starts listening) — no readiness gate needed like the live-index endpoints.
  app.get("/burnt", (_req, res) => {
    res.json(getBurnt());
  });

  app.get("/compression/:assetId", (req, res) => {
    const { assetId } = req.params;
    try {
      new PublicKey(assetId);
    } catch {
      res.status(400).json({ error: "invalid assetId" });
      return;
    }
    const status = getStatus();
    if (!status.ready || status.ageMs === null || status.ageMs > MAX_ACCEPTABLE_AGE_MS) {
      res.status(503).json({ error: "index not ready or too stale — try again shortly" });
      return;
    }
    const data = getCompressionDataForAsset(assetId);
    if (!data) {
      res.status(404).json({ error: "asset not found in index (wrong tree, burned, or never minted)" });
      return;
    }
    res.json(data);
  });

  app.get("/owner/:assetId", (req, res) => {
    const { assetId } = req.params;
    try {
      new PublicKey(assetId);
    } catch {
      res.status(400).json({ error: "invalid assetId" });
      return;
    }
    const result = getOwnerOfAsset(assetId);
    if (!result) {
      res.status(404).json({ error: "asset not found in index" });
      return;
    }
    res.json(result);
  });

  app.get("/metadata/:assetId", (req, res) => {
    const { assetId } = req.params;
    try {
      new PublicKey(assetId);
    } catch {
      res.status(400).json({ error: "invalid assetId" });
      return;
    }
    const result = getMetadataForAsset(assetId);
    if (!result) {
      res.status(404).json({ error: "asset not found in index" });
      return;
    }
    res.json(result);
  });

  app.get("/wallet/:address", (req, res) => {
    const { address } = req.params;
    try {
      new PublicKey(address);
    } catch {
      res.status(400).json({ error: "invalid wallet address" });
      return;
    }
    const status = getStatus();
    if (!status.ready || status.ageMs === null || status.ageMs > MAX_ACCEPTABLE_AGE_MS) {
      res.status(503).json({ error: "index not ready or too stale — try again shortly" });
      return;
    }
    const assets = getAssetsOwnedByWallet(address);
    // assets is only null when the index itself isn't ready, already handled by the status
    // check above — this branch is unreachable in practice but keeps the type honest.
    if (assets === null) {
      res.status(503).json({ error: "index not ready" });
      return;
    }
    res.json({ owns: assets.length > 0, count: assets.length, assets });
  });

  const server = app.listen(PORT, BIND_HOST, () => {
    console.log(`[server] MonkeLedger listening on ${BIND_HOST}:${PORT}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[server] port ${PORT} already in use — exiting`);
      process.exit(1);
    }
    throw err;
  });
}
