import { PublicKey } from "@solana/web3.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const HELIUS_API_KEY = required("HELIUS_API_KEY");
export const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Cheap root-only polling doesn't need DAS at all — getAccountInfo is a plain RPC method, not a
// billed Helius DAS call — so it defaults to a free public RPC, keeping the frequent poll leg
// completely off the Helius key. PublicNode rather than api.mainnet-beta.solana.com — generally
// more reliable/less aggressively rate-limited for production use. Override if needed.
export const POLL_RPC_URL = process.env.POLL_RPC_URL ?? "https://solana-rpc.publicnode.com";

export const TREE_ADDRESS = new PublicKey(process.env.TREE_ADDRESS ?? required("TREE_ADDRESS"));
export const COLLECTION_ADDRESS = process.env.COLLECTION_ADDRESS ?? required("COLLECTION_ADDRESS");

export const PORT = parseInt(process.env.PORT ?? "3002", 10);
export const BIND_HOST = process.env.BIND_HOST ?? "0.0.0.0";

// How often to cheaply check whether the on-chain root even changed (no DAS call — see
// POLL_RPC_URL above). A full getAssetsByGroup snapshot only runs when this detects a real
// change, so this can be frequent without meaningfully costing anything.
export const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "120000", 10);

// Safety-net full refresh even if polling somehow misses a change (wrong RPC, a transient bug,
// etc.) — the poll loop is a comprehensive change-detector on its own (ANY leaf mutation —
// transfer, metadata update, burn, delegate — changes that leaf's hash and therefore the root,
// so polling the root catches all of them, not just transfers), so this is a rare backstop, not
// a routine sync. Default 24h; tighten if you ever have reason to distrust the poll loop.
export const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS ?? "86400000", 10);

export const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "30", 10);
export const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10);

// Optional — only needed if running the Cloudflare Worker (see worker/) in front of this
// service. Leave unset to run standalone; rate limiting then just uses the direct socket IP.
export const PROXY_SECRET = process.env.PROXY_SECRET ?? "";

export const STATE_FILE = ".ledger_state.json";
export const GETASSETSBYGROUP_PAGE_LIMIT = 1000;

// Persists the memorial list (last-known name/image/traits for every leaf ever seen burnt) across
// restarts. Separate file from STATE_FILE because it's a one-way-growing historical log, not a
// point-in-time snapshot that gets wholesale replaced every refresh.
export const BURNT_STATE_FILE = ".ledger_burnt.json";

// Checked into the repo — the 15 Saga Monkes burnt before this indexer existed, backfilled from a
// collaborator's own historical records (MonkeLedger has no way to recover metadata for a leaf
// that was already burnt before it started watching). Every burn from here on is captured live by
// refreshIndex() itself and needs no seed. Merged into _burnt on boot, never overwriting a
// disk-persisted entry.
export const BURNT_SEED_FILE = "data/burnt-seed.json";
