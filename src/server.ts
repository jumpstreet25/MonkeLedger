import express from "express";
import { PublicKey } from "@solana/web3.js";
import { getCompressionDataForAsset, getOwnerOfAsset, getStatus } from "./indexer";
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
