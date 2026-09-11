import { PublicKey } from "@solana/web3.js";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const HELIUS_API_KEY = required("HELIUS_API_KEY");
export const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

export const TREE_ADDRESS = new PublicKey(process.env.TREE_ADDRESS ?? required("TREE_ADDRESS"));
export const COLLECTION_ADDRESS = process.env.COLLECTION_ADDRESS ?? required("COLLECTION_ADDRESS");

export const PORT = parseInt(process.env.PORT ?? "3002", 10);
export const BIND_HOST = process.env.BIND_HOST ?? "0.0.0.0";

export const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS ?? "600000", 10);

export const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "30", 10);
export const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10);

export const STATE_FILE = ".ledger_state.json";
export const GETASSETSBYGROUP_PAGE_LIMIT = 1000;
