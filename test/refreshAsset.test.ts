import { describe, expect, mock, test, beforeEach } from "bun:test";
import { MerkleTree } from "@solana/spl-account-compression";
import bs58 from "bs58";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// persistState writes ./.ledger_state.json — never this checkout's real one.
process.chdir(mkdtempSync(join(tmpdir(), "monkeledger-test-")));

process.env.TREE_ADDRESS = "11111111111111111111111111111111";
process.env.COLLECTION_ADDRESS = "11111111111111111111111111111111";
process.env.SINGLE_REFRESH_DAILY_MAX = "3";
process.env.HELIUS_API_KEY = "test";

const realCompression = await import("@solana/spl-account-compression");
mock.module("@solana/spl-account-compression", () => ({
  ...realCompression,
  ConcurrentMerkleTreeAccount: { fromAccountAddress: async () => { throw new Error("offline"); } },
}));

let dasReply: unknown = null;
let dasCalls = 0;
mock.module("../src/dasClient", () => ({
  dasCallRetry: async () => { dasCalls++; return dasReply; },
  takeDasBudget: () => true,
}));

const { refreshSingleAsset, getOwnerOfAsset, getAssetsOwnedByWallet, _setStateForTest } = await import("../src/indexer");

const leaf = (n: number) => Buffer.alloc(32, n);
const SELLER = "Se11er1111111111111111111111111111111111111";
const BUYER = "Buyer11111111111111111111111111111111111111";
const ASSET = "Asset111111111111111111111111111111111111111";

function freshState() {
  const leaves = new Map<number, Buffer>([[0, leaf(1)], [1, leaf(2)]]);
  const slots = Array.from({ length: 8 }, (_, i) => leaves.get(i) ?? Buffer.alloc(32, 0));
  const asset = { leafIndex: 1, owner: SELLER, delegate: null, dataHash: "d", creatorHash: "c", name: "MONKE #1", symbol: "MONKE", image: null, traits: null };
  const assetsById = new Map([[ASSET, asset]]);
  return {
    builtAtMs: 1, onChainRoot: "old", depth: 3, leaves, assetsById,
    byOwner: new Map([[SELLER, [ASSET]]]), tree: MerkleTree.sparseMerkleTreeFromLeaves(slots, 3),
  };
}

const sold = (over: Record<string, unknown> = {}) => ({
  id: ASSET, ownership: { owner: BUYER, delegate: null },
  compression: { compressed: true, leaf_id: 1, asset_hash: bs58.encode(leaf(9)), data_hash: "d", creator_hash: "c" }, ...over,
});

describe("refreshSingleAsset (sale → MonkeLedger)", () => {
  beforeEach(() => { dasCalls = 0; });

  test("a sale moves the asset to the buyer and patches its leaf", async () => {
    const state = freshState();
    _setStateForTest(state as any);
    dasReply = sold();
    const before = Buffer.from(state.tree.root).toString("hex");
    expect(await refreshSingleAsset(ASSET)).toBe("updated");
    expect(getOwnerOfAsset(ASSET)?.owner).toBe(BUYER);
    expect(getAssetsOwnedByWallet(BUYER)).toEqual([ASSET]);
    expect(getAssetsOwnedByWallet(SELLER) ?? []).toEqual([]);
    expect(state.leaves.get(1)?.equals(leaf(9))).toBe(true);
    expect(Buffer.from(state.tree.root).toString("hex")).not.toBe(before);
    expect(state.onChainRoot).toBe("old"); // chain root unknown → left for the full refresh
  });

  test("calling again is a no-op", async () => {
    expect(await refreshSingleAsset(ASSET)).toBe("unchanged");
  });

  test("never touches an asset that isn't in the index, and spends nothing on it", async () => {
    expect(await refreshSingleAsset("Unknown1111111111111111111111111111111111111")).toBe("skipped");
    expect(dasCalls).toBe(0);
  });

  test("a burnt or moved leaf is left to the full refresh", async () => {
    _setStateForTest(freshState() as any);
    dasReply = sold({ burnt: true });
    expect(await refreshSingleAsset(ASSET)).toBe("skipped");
    expect(getOwnerOfAsset(ASSET)?.owner).toBe(SELLER);
  });

  test("daily cap", async () => {
    _setStateForTest(freshState() as any);
    dasReply = sold();
    expect(await refreshSingleAsset(ASSET)).toBe("skipped"); // 3 already used today
    expect(dasCalls).toBe(0);
  });
});
