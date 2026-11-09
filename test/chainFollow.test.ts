import { describe, expect, mock, test, beforeEach } from "bun:test";
import { MerkleTree } from "@solana/spl-account-compression";
import bs58 from "bs58";
import { createHash } from "crypto";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.chdir(mkdtempSync(join(tmpdir(), "monkeledger-chain-")));
const TREE = "2uH9TkmYkAKGrK7EPnd4Y7JVYswpQ2aED9deMn8QoYVy";
process.env.TREE_ADDRESS = TREE;
process.env.COLLECTION_ADDRESS = "11111111111111111111111111111111";
process.env.CHAIN_RPC_URLS = "https://rpc.test";
delete process.env.HELIUS_API_KEY;

const NOOP = "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV";
const BGUM = "BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY";
const DEPTH = 3;
const key = (n: number) => Buffer.alloc(32, n);
const b58 = (n: number) => bs58.encode(key(n));

const chain = await import("../src/chainFollow");

function schemaBytes(id: number, owner: number, delegate: number, nonce: number): Buffer {
  const nb = Buffer.alloc(8); nb.writeBigUInt64LE(BigInt(nonce));
  return Buffer.concat([key(id), key(owner), key(delegate), nb, key(200), key(201)]);
}
function appEvent(schema: Buffer): Buffer {
  const app = Buffer.concat([Buffer.from([1, 0, 0]), schema, chain.schemaLeafHash(schema)]);
  const len = Buffer.alloc(4); len.writeUInt32LE(app.length);
  return Buffer.concat([Buffer.from([1, 0]), len, app]);
}
function changelog(leaf: Buffer, root: Buffer, seq: number, index: number, tree = TREE): Buffer {
  const n = DEPTH + 1;
  const parts = [Buffer.from([0, 0]), Buffer.from(bs58.decode(tree)), Buffer.alloc(4)];
  parts[2].writeUInt32LE(n);
  for (let i = 0; i < n; i++) { const node = i === 0 ? leaf : i === n - 1 ? root : Buffer.alloc(32); const idx = Buffer.alloc(4); parts.push(node, idx); }
  const tail = Buffer.alloc(12); tail.writeBigUInt64LE(BigInt(seq)); tail.writeUInt32LE(index, 8);
  parts.push(tail);
  return Buffer.concat(parts);
}
function tx(datas: Buffer[], burn = false) {
  const keys = ["payer", NOOP, BGUM];
  const top = burn ? [{ programIdIndex: 2, data: bs58.encode(createHash("sha256").update("global:burn").digest().subarray(0, 8)) }] : [];
  return {
    transaction: { message: { accountKeys: keys, instructions: top } },
    meta: { err: null, innerInstructions: [{ instructions: datas.map((d) => ({ programIdIndex: 1, data: bs58.encode(d) })) }] },
  };
}

/** A tiny tree + a chain of real changes over it. */
function scenario() {
  const leaves = new Map<number, Buffer>();
  const owners: Record<number, number> = {};
  for (let i = 0; i < 4; i++) { const s = schemaBytes(10 + i, 50 + i, 50 + i, i); leaves.set(i, chain.schemaLeafHash(s)); owners[i] = 50 + i; }
  const slots = (m: Map<number, Buffer>) => Array.from({ length: 2 ** DEPTH }, (_, i) => m.get(i) ?? Buffer.alloc(32));
  const base = MerkleTree.sparseMerkleTreeFromLeaves(slots(leaves), DEPTH);
  const baseRoot = Buffer.from(base.root).toString("hex");
  const work = MerkleTree.sparseMerkleTreeFromLeaves(slots(leaves), DEPTH);
  const txs: { sig: string; tx: any; seq: number }[] = [];
  let seq = 100;
  const transfer = (i: number, newOwner: number) => {
    const s = schemaBytes(10 + i, newOwner, newOwner, i); const leaf = chain.schemaLeafHash(s);
    work.updateLeaf(i, leaf); seq++;
    txs.push({ sig: `sig${seq}`, seq, tx: tx([appEvent(s), changelog(leaf, Buffer.from(work.root), seq, i)]) });
  };
  const burn = (i: number) => {
    work.updateLeaf(i, Buffer.alloc(32)); seq++;
    txs.push({ sig: `sig${seq}`, seq, tx: tx([changelog(Buffer.alloc(32), Buffer.from(work.root), seq, i)], true) });
  };
  transfer(1, 77);
  burn(2);
  transfer(1, 78);
  return { leaves, baseRoot, baseSeq: 100, txs, live: { root: Buffer.from(work.root), seq: seq } };
}

function fakeRpc(txs: { sig: string; tx: any }[], drop = new Set<string>()) {
  const newest = [...txs].reverse();
  return async (method: string, params: any[]) => {
    if (method === "getSignaturesForAddress") {
      const before = params[1]?.before;
      const start = before ? newest.findIndex((t) => t.sig === before) + 1 : 0;
      return newest.slice(start, start + 100).map((t) => ({ signature: t.sig, err: null }));
    }
    if (method === "getTransaction") return drop.has(params[0]) ? null : txs.find((t) => t.sig === params[0])!.tx;
    throw new Error(method);
  };
}

describe("decodeTreeEvents", () => {
  test("pairs each change with its schema and checks the hash", () => {
    const sc = scenario();
    const [ev] = chain.decodeTreeEvents(sc.txs[0].tx, TREE);
    expect(ev.seq).toBe(101);
    expect(ev.index).toBe(1);
    expect(ev.schema?.owner).toBe(b58(77));
    expect(ev.schema?.id).toBe(b58(11));
  });
  test("a burn has no schema and is flagged", () => {
    const [ev] = chain.decodeTreeEvents(scenario().txs[1].tx, TREE);
    expect(ev.schema).toBeNull();
    expect(ev.burn).toBe(true);
  });
  test("a forged owner (schema hash ≠ leaf) is refused", () => {
    const s = schemaBytes(11, 99, 99, 1);
    const otherLeaf = chain.schemaLeafHash(schemaBytes(11, 77, 77, 1));
    expect(() => chain.decodeTreeEvents(tx([appEvent(s), changelog(otherLeaf, Buffer.alloc(32), 101, 1)]), TREE)).toThrow("no matching leaf schema");
  });
  test("other trees and failed txs are ignored", () => {
    const sc = scenario();
    expect(chain.decodeTreeEvents(sc.txs[0].tx, "11111111111111111111111111111111")).toEqual([]);
    expect(chain.decodeTreeEvents({ ...sc.txs[0].tx, meta: { ...sc.txs[0].tx.meta, err: { x: 1 } } }, TREE)).toEqual([]);
  });
});

describe("collectTreeEvents", () => {
  test("from a known seq", async () => {
    const sc = scenario();
    const r = await chain.collectTreeEvents(fakeRpc(sc.txs), TREE, { seq: 100, root: sc.baseRoot }, { seq: sc.live.seq });
    expect(r?.events.map((e) => e.seq)).toEqual([101, 102, 103]);
  });
  test("bootstraps an unknown seq from the root it produced", async () => {
    const sc = scenario();
    const midRoot = chain.decodeTreeEvents(sc.txs[0].tx, TREE)[0].root.toString("hex");
    const r = await chain.collectTreeEvents(fakeRpc(sc.txs), TREE, { seq: null, root: midRoot }, { seq: sc.live.seq });
    expect(r?.baseSeq).toBe(101);
    expect(r?.events.map((e) => e.seq)).toEqual([102, 103]);
  });
  test("a missing transaction means no result, never a guess", async () => {
    const sc = scenario();
    expect(await chain.collectTreeEvents(fakeRpc(sc.txs, new Set(["sig102"])), TREE, { seq: 100, root: sc.baseRoot }, { seq: sc.live.seq })).toBeNull();
    expect(await chain.collectTreeEvents(fakeRpc(sc.txs.filter((t) => t.seq !== 102)), TREE, { seq: 100, root: sc.baseRoot }, { seq: sc.live.seq })).toBeNull();
  });
});

let sc = scenario();
let live = sc.live;
const realCompression = await import("@solana/spl-account-compression");
mock.module("@solana/spl-account-compression", () => ({
  ...realCompression,
  ConcurrentMerkleTreeAccount: { fromAccountAddress: async () => ({ getCurrentRoot: () => live.root, getMaxDepth: () => DEPTH, getCurrentSeq: () => BigInt(live.seq) }) },
}));
let rpc = fakeRpc(sc.txs);
mock.module("../src/chainFollow", () => ({ ...chain, httpRpc: () => (m: string, p: any[]) => rpc(m, p) }));
const ix = await import("../src/indexer");

describe("syncFromChain", () => {

  function install() {
    const assets = new Map<string, any>();
    for (let i = 0; i < 4; i++) assets.set(b58(10 + i), { leafIndex: i, owner: b58(50 + i), delegate: null, dataHash: b58(200), creatorHash: b58(201), name: `MONKE #${i + 1}`, symbol: null, image: null, traits: null });
    const slots = Array.from({ length: 2 ** DEPTH }, (_, i) => sc.leaves.get(i) ?? Buffer.alloc(32));
    ix._setStateForTest({ builtAtMs: 0, onChainRoot: sc.baseRoot, seq: 100, depth: DEPTH, leaves: new Map(sc.leaves), assetsById: assets, byOwner: new Map(), tree: MerkleTree.sparseMerkleTreeFromLeaves(slots, DEPTH) } as any);
  }
  beforeEach(() => { sc = scenario(); live = sc.live; rpc = fakeRpc(sc.txs); install(); });

  test("applies transfers and burns, verified to the live root", async () => {
    expect(await ix.syncFromChain()).toBe("updated");
    expect(ix.getOwnerOfAsset(b58(11))).toEqual({ owner: b58(78), delegate: null });
    expect(ix.getOwnerOfAsset(b58(12))).toBeNull();
    expect(ix.getBurnt().some((b) => b.mint === b58(12) && b.number === 3)).toBe(true);
    expect(ix.getStatus().seq).toBe(103);
    expect(await ix.syncFromChain()).toBe("in-sync");
  });

  test("a wrong live root leaves the index untouched", async () => {
    live = { root: Buffer.alloc(32, 9), seq: sc.live.seq };
    expect(await ix.syncFromChain()).toBe("failed");
    expect(ix.getOwnerOfAsset(b58(11))?.owner).toBe(b58(51));
    expect(ix.getStatus().seq).toBe(100);
  });

  test("the sale ping uses the chain, not DAS", async () => {
    expect(await ix.refreshSingleAsset(b58(11))).toBe("updated");
    expect(ix.getOwnerOfAsset(b58(11))?.owner).toBe(b58(78));
  });
});
