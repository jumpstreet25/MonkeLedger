/**
 * chainFollow.ts — keep the index current from the tree's own transactions, no DAS.
 *
 * Every change to a compressed-NFT tree logs two events through the noop program in the
 * same transaction:
 *   - account-compression's ChangeLogEvent: the leaf's new hash, the whole path up to the
 *     new root, the leaf index and the tree's sequence number after the change;
 *   - Bubblegum's LeafSchemaEvent: asset id, owner, delegate, nonce, data/creator hash.
 * keccak256(0x01 || schema) must equal the changelog leaf (checked for every event), and
 * applying the leaves in sequence order must reproduce each event's root and finally the
 * live on-chain root. So the owners we serve are proven against the chain, not trusted
 * from any provider. Plain RPC only (getSignaturesForAddress + getTransaction).
 *
 * Layouts confirmed against live Saga Monkes transactions (2026-11-09).
 */

import { createHash } from "crypto";
import bs58 from "bs58";
import sha3 from "js-sha3";

export const NOOP_PROGRAMS = new Set([
  "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",
  "mnoopTCrg4p8ry25e4bcWA9XZjbNjMTfgYVGGEdRsf3",
]);
export const BUBBLEGUM = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
const BURN_DISC = createHash("sha256").update("global:burn").digest().subarray(0, 8);
const SCHEMA_LEN = 32 * 3 + 8 + 32 * 2;

export type LeafSchema = {
  id: string;
  owner: string;
  delegate: string;
  nonce: number;
  dataHash: string; // base58
  creatorHash: string; // base58
};

export type TreeEvent = {
  seq: number;
  index: number;
  leaf: Buffer; // new leaf hash (all zero = removed)
  root: Buffer; // tree root right after this change
  schema: LeafSchema | null; // null only when the leaf was removed
  burn: boolean; // removed by a Bubblegum burn (vs. redeem/decompress)
  signature: string;
};

export const isZero = (b: Buffer) => b.every((x) => x === 0);

export function schemaLeafHash(schema: Buffer): Buffer {
  return Buffer.from(sha3.keccak256.arrayBuffer(Buffer.concat([Buffer.from([1]), schema])));
}

function parseSchema(raw: Buffer): LeafSchema {
  return {
    id: bs58.encode(raw.subarray(0, 32)),
    owner: bs58.encode(raw.subarray(32, 64)),
    delegate: bs58.encode(raw.subarray(64, 96)),
    nonce: Number(raw.readBigUInt64LE(96)),
    dataHash: bs58.encode(raw.subarray(104, 136)),
    creatorHash: bs58.encode(raw.subarray(136, 168)),
  };
}

type RpcTx = {
  transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; data: string }[] } };
  meta: {
    err: unknown;
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
    innerInstructions?: { instructions: { programIdIndex: number; data: string }[] }[] | null;
  } | null;
};

/**
 * This tree's events in one transaction (json encoding). Throws when an event for our tree
 * can't be decoded or a non-empty leaf has no matching schema — the caller then gives up
 * on this sync instead of guessing.
 */
export function decodeTreeEvents(tx: RpcTx, tree: string, signature = ""): TreeEvent[] {
  if (!tx.meta || tx.meta.err) return [];
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((g) => g.instructions)];
  const burn = all.some((ix) => {
    if (keys[ix.programIdIndex] !== BUBBLEGUM) return false;
    const d = Buffer.from(bs58.decode(ix.data));
    return d.length >= 8 && d.subarray(0, 8).equals(BURN_DISC);
  });

  const out: TreeEvent[] = [];
  const schemas: Buffer[] = [];
  for (const g of tx.meta.innerInstructions ?? []) {
    for (const ix of g.instructions) {
      if (!NOOP_PROGRAMS.has(keys[ix.programIdIndex])) continue;
      const b = Buffer.from(bs58.decode(ix.data));
      if (b.length < 2) continue;
      if (b[0] === 1 && b[1] === 0) {
        // ApplicationData V1 → Vec<u8>: [event_type=1 LeafSchemaEvent][version][LeafSchema::V1=0][schema][leaf_hash]
        const len = b.readUInt32LE(2);
        const app = b.subarray(6, 6 + len);
        if (app.length >= 3 + SCHEMA_LEN && app[0] === 1 && app[2] === 0) schemas.push(Buffer.from(app.subarray(3, 3 + SCHEMA_LEN)));
        continue;
      }
      if (b[0] !== 0 || b[1] !== 0) continue; // ChangeLog V1 only
      if (bs58.encode(b.subarray(2, 34)) !== tree) continue;
      const n = b.readUInt32LE(34);
      const end = 38 + n * 36;
      if (n < 1 || b.length < end + 12) throw new Error(`short changelog in ${signature}`);
      const leaf = Buffer.from(b.subarray(38, 70));
      const root = Buffer.from(b.subarray(38 + (n - 1) * 36, 38 + (n - 1) * 36 + 32));
      const seq = Number(b.readBigUInt64LE(end));
      const index = b.readUInt32LE(end + 8);
      let schema: LeafSchema | null = null;
      if (!isZero(leaf)) {
        const at = schemas.findIndex((s) => schemaLeafHash(s).equals(leaf));
        if (at < 0) throw new Error(`no matching leaf schema for seq ${seq} in ${signature}`);
        schema = parseSchema(schemas.splice(at, 1)[0]);
      }
      out.push({ seq, index, leaf, root, schema, burn: isZero(leaf) && burn, signature });
    }
  }
  return out;
}

type Rpc = (method: string, params: unknown[]) => Promise<any>;

/** JSON-RPC over HTTP; a 429 waits and retries (2, 4, 8, 16 s) before giving up. */
export function httpRpc(url: string, timeoutMs = 15_000): Rpc {
  return async (method, params) => {
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 429 || attempt >= 4) break;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
    if (!res.ok) throw new Error(`${method} HTTP ${res.status}`);
    const d = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (d.error) throw new Error(`${method}: ${d.error.message ?? "rpc error"}`);
    return d.result;
  };
}

/**
 * Events (base, target] in sequence order, walking the tree's history newest first.
 * `base.seq` may be unknown (an index saved before this existed): then the event whose
 * resulting root equals `base.root` marks it. Returns null when the history this RPC keeps
 * doesn't reach back far enough, a sequence number is missing, or `maxTx` is exceeded.
 */
export async function collectTreeEvents(
  rpc: Rpc,
  tree: string,
  base: { seq: number | null; root: string },
  target: { seq: number },
  opts: { maxTx?: number; pauseMs?: number } = {},
): Promise<{ events: TreeEvent[]; baseSeq: number } | null> {
  const maxTx = opts.maxTx ?? 1500;
  const events = new Map<number, TreeEvent>();
  let baseSeq = base.seq;
  let before: string | undefined;
  let fetched = 0;
  const complete = () => {
    if (baseSeq === null) return false;
    for (let s = baseSeq + 1; s <= target.seq; s++) if (!events.has(s)) return false;
    return true;
  };
  for (;;) {
    const page = (await rpc("getSignaturesForAddress", [tree, { limit: 100, ...(before ? { before } : {}) }])) as
      { signature: string; err: unknown }[] | null;
    if (!page?.length) return null; // history ends here
    for (const s of page) {
      before = s.signature;
      if (s.err) continue;
      if (++fetched > maxTx) return null;
      const tx = (await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }])) as RpcTx | null;
      if (!tx) return null; // pruned or not yet available: don't guess
      for (const ev of decodeTreeEvents(tx, tree, s.signature)) {
        if (ev.seq > target.seq) continue;
        events.set(ev.seq, ev);
        if (baseSeq === null && ev.root.toString("hex") === base.root) baseSeq = ev.seq;
      }
      if (complete()) {
        const list = [...events.values()].filter((e) => e.seq > baseSeq!).sort((a, b) => a.seq - b.seq);
        return { events: list, baseSeq: baseSeq! };
      }
      if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
    }
    // Past the base and still incomplete: a sequence number is missing. Checked per page,
    // since transactions in one slot can come back in either order.
    if (baseSeq !== null && events.size && Math.min(...events.keys()) <= baseSeq) return null;
    if (page.length < 100) return null;
  }
}
