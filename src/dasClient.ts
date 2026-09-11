/**
 * Minimal DAS RPC client with retry + backoff. Deliberately self-contained (no shared
 * cross-service backoff map) — this repo is meant to run as its own isolated process, so it
 * only ever needs to protect ITS OWN Helius key from itself, not coordinate with anything else.
 */
import { RPC_URL } from "./config";

const PROVIDER_BACKOFF_MS = 20 * 60 * 1000; // matches the convention used elsewhere in this project
let backoffUntil = 0;

function providerAvailable(): boolean {
  return backoffUntil < Date.now();
}

function noteProviderDown(): void {
  backoffUntil = Date.now() + PROVIDER_BACKOFF_MS;
}

async function rawCall(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "monke-ledger", method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) noteProviderDown();
    throw new Error(`DAS ${method} HTTP ${res.status}`);
  }
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) throw new Error(`DAS ${method}: ${json.error.message ?? "RPC error"}`);
  return json.result;
}

/** Retries transient failures (429/5xx/timeout) with backoff; a definitively-down provider
 *  (recent 429/5xx) is skipped immediately rather than retried every call. */
export async function dasCallRetry(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 20_000,
  maxAttempts = 5,
): Promise<unknown> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!providerAvailable()) throw new Error("Helius DAS in backoff — quota/error recently observed");
    try {
      return await rawCall(method, params, timeoutMs);
    } catch (err) {
      last = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/429|5\d\d|timeout|abort/i.test(msg) || attempt === maxAttempts) throw err;
      const wait = Math.min(15_000, 800 * 2 ** (attempt - 1));
      console.warn(`[dasClient] ${method} attempt ${attempt}/${maxAttempts} failed (${msg.slice(0, 80)}) — retry in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}
