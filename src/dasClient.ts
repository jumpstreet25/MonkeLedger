/**
 * Minimal DAS RPC client with retry + backoff. Deliberately self-contained (no shared
 * cross-service backoff map) — this repo is meant to run as its own isolated process, so it
 * only ever needs to protect ITS OWN Helius key from itself, not coordinate with anything else.
 */
import { RPC_URL } from "./config";

const PROVIDER_BACKOFF_MS = 20 * 60 * 1000; // matches the convention used elsewhere in this project
let backoffUntil = 0;

// Hard ceiling on Helius calls per UTC day. A healthy full refresh is ~10 getAssetsByGroup
// pages, so 300 leaves lots of headroom for retries — but caps a retry storm (2026-10-02: ~350
// attempts in 2h against a drained key) so it can never burn a key shared with other services.
// 2026-10-02 this key IS shared: MonkeLedger runs on the bot's swap-confirm Helius key until a
// dedicated one exists, so this cap is what keeps MonkeLedger from eating real-money credits.
const DAILY_MAX_CALLS = Math.max(1, parseInt(process.env.DAS_DAILY_MAX_CALLS ?? "300", 10) || 300);
let budgetDay = "";
let budgetUsed = 0;
let budgetWarned = false;

/** Counts one call against today's budget; false once today's budget is spent. */
export function takeDasBudget(now = new Date()): boolean {
  const day = now.toISOString().slice(0, 10);
  if (day !== budgetDay) {
    budgetDay = day;
    budgetUsed = 0;
    budgetWarned = false;
  }
  if (budgetUsed >= DAILY_MAX_CALLS) {
    if (!budgetWarned) {
      budgetWarned = true;
      console.warn(`[dasClient] daily DAS budget of ${DAILY_MAX_CALLS} calls reached — no more Helius calls until 00:00 UTC`);
    }
    return false;
  }
  budgetUsed++;
  return true;
}

function providerAvailable(): boolean {
  return backoffUntil < Date.now();
}

function noteProviderDown(): void {
  backoffUntil = Date.now() + PROVIDER_BACKOFF_MS;
}

async function rawCall(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  if (!takeDasBudget()) throw new Error("daily DAS budget reached");
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
