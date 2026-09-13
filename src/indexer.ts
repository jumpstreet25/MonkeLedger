/**
 * indexer.ts — self-hosted Merkle-proof-generating replica of a compressed-NFT tree.
 *
 * Removes a DAS provider (Helius, etc.) as a real-time single point of failure for building
 * Bubblegum transfer instructions — periodically rebuilds a local tree from a full
 * getAssetsByGroup snapshot and refuses to serve anything that doesn't independently verify
 * against the live on-chain root read directly from the tree account.
 *
 * Debugged live against real on-chain data (Saga Monkes, tree 2uH9Tk...) before trusting any of
 * this. Two load-bearing facts that are NOT obvious from the DAS docs:
 *
 * 1. `getAssetsByGroup`'s bulk `compression.asset_hash` field is stale forever for a burned
 *    leaf — it keeps the pre-burn hash while the true on-chain leaf is zeroed. The bulk item
 *    DOES carry `burnt: true` for burned assets (confirmed live) — skip those. No live
 *    decompressed example was available to confirm its exact bulk-response shape when this was
 *    built; `compression.compressed === false` is excluded defensively on the assumption a
 *    decompressed asset (which has left the tree entirely) behaves at least as safely-excludable
 *    as a burnt one. Re-verify against a real example if your collection ever has one.
 * 2. The proof/root pipeline (`getAssetProof`) and the bulk asset-table fields are
 *    independently-lagging DAS subsystems — being caught up on one doesn't imply the other is.
 *    Never trust a single root/seq stability check as proof the bulk snapshot itself is clean;
 *    verify the rebuilt root against the live on-chain root every single refresh, and refuse to
 *    serve a snapshot that doesn't match.
 *
 * Padding/hash convention (zero-fill for empty leaves, keccak256(left||right)) matches
 * @solana/spl-account-compression's own MerkleTree class exactly — confirmed by reading its
 * source, not assumed from docs.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Connection } from "@solana/web3.js";
import { ConcurrentMerkleTreeAccount, MerkleTree } from "@solana/spl-account-compression";
import bs58 from "bs58";
import { dasCallRetry } from "./dasClient";
import {
  POLL_RPC_URL,
  TREE_ADDRESS,
  COLLECTION_ADDRESS,
  STATE_FILE,
  GETASSETSBYGROUP_PAGE_LIMIT,
  BURNT_STATE_FILE,
  BURNT_SEED_FILE,
} from "./config";

export type NftTrait = { trait_type: string; value: string };

type IndexedAsset = {
  leafIndex: number;
  owner: string;
  delegate: string | null;
  dataHash: string; // base58
  creatorHash: string; // base58
  // Display metadata — Helius has already resolved and fetched this (the Arweave JSON behind
  // json_uri) as part of the SAME getAssetsByGroup call we make every refresh anyway. No extra
  // API cost to capture it; this is what lets MonkeLedger answer "what traits does this Monke
  // have" without a live per-request Helius getAsset call.
  name: string | null;
  symbol: string | null;
  image: string | null;
  traits: NftTrait[] | null;
};

type IndexState = {
  builtAtMs: number;
  onChainRoot: string; // hex
  depth: number;
  leaves: Map<number, Buffer>; // leafIndex -> asset_hash (raw 32 bytes)
  assetsById: Map<string, IndexedAsset>;
  byOwner: Map<string, string[]>; // owner wallet -> assetIds (reverse index, for "does wallet X own any")
  tree: MerkleTree;
};

export type BurntAsset = {
  number: number | null; // parsed from "MONKE #N"
  name: string | null;
  mint: string; // assetId
  image: string | null;
  traits: NftTrait[] | null;
  lastSeenLeafIndex: number | null;
  burnedAtMs: number | null; // when THIS indexer first observed the burn — null for seeded/backfilled entries with no known burn time
};

let _state: IndexState | null = null;
let _burnt: Map<string, BurntAsset> = new Map(); // assetId -> last-known metadata, grows monotonically
let _refreshing = false; // reentrancy guard — a setInterval-driven job must never overlap itself
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _refreshTimer: ReturnType<typeof setInterval> | null = null;

// Root reads are plain getAccountInfo, not a DAS call — no reason to spend the Helius-backed
// RPC_URL on them (that's reserved for getAssetsByGroup, via dasClient.ts). Both the frequent
// poll and refreshIndex()'s own before/after checks use this connection.
let _pollConnection: Connection | null = null;
function getPollConnection(): Connection {
  if (!_pollConnection) _pollConnection = new Connection(POLL_RPC_URL, "confirmed");
  return _pollConnection;
}

async function readOnChainRoot(connection: Connection): Promise<{ root: Buffer; depth: number; seq: string }> {
  const acct = await ConcurrentMerkleTreeAccount.fromAccountAddress(connection, TREE_ADDRESS);
  return {
    root: Buffer.from(acct.getCurrentRoot()),
    depth: acct.getMaxDepth(),
    seq: acct.getCurrentSeq().toString(),
  };
}

/**
 * Cheap change-detector: reads just the on-chain root (no DAS call, no full snapshot) and
 * compares it to what's currently indexed. Only triggers the expensive refreshIndex() when the
 * root has actually moved — with low transfer volume, this means most poll cycles cost nothing
 * beyond one plain RPC call, instead of a full ~13-request DAS scan regardless of whether
 * anything changed.
 */
export async function pollForChange(): Promise<void> {
  if (_refreshing) return;
  try {
    const live = await readOnChainRoot(getPollConnection());
    const liveHex = live.root.toString("hex");
    if (_state && liveHex === _state.onChainRoot) return; // no change — nothing to do
    console.log(`[indexer] root change detected (or no state yet) — running full refresh`);
    await refreshIndex();
  } catch (err) {
    console.warn("[indexer] poll failed:", err instanceof Error ? err.message : err);
  }
}

type DasAssetItem = {
  id: string;
  burnt?: boolean;
  ownership?: { owner?: string; delegate?: string | null };
  compression?: {
    compressed?: boolean;
    leaf_id?: number;
    asset_hash?: string;
    data_hash?: string;
    creator_hash?: string;
  };
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
      attributes?: NftTrait[];
    };
    files?: { uri?: string }[];
  };
};

async function fetchAllAssets(): Promise<DasAssetItem[]> {
  const items: DasAssetItem[] = [];
  let page = 1;
  for (;;) {
    const result = (await dasCallRetry("getAssetsByGroup", {
      groupKey: "collection",
      groupValue: COLLECTION_ADDRESS,
      page,
      limit: GETASSETSBYGROUP_PAGE_LIMIT,
    })) as { items?: DasAssetItem[] };
    const batch = result.items ?? [];
    items.push(...batch);
    if (batch.length < GETASSETSBYGROUP_PAGE_LIMIT) break;
    page += 1;
  }
  return items;
}

/**
 * Rebuilds the local tree from a fresh DAS snapshot and verifies it against the live on-chain
 * root before accepting it. Returns false (leaving any prior good state in place) if the
 * rebuild doesn't match — a stale/bad snapshot must never silently replace a known-good one.
 */
export async function refreshIndex(): Promise<boolean> {
  if (_refreshing) return false;
  _refreshing = true;
  try {
    // Root reads are plain getAccountInfo, not DAS — same reasoning as pollForChange() above,
    // no need to spend a Helius-backed request on these when the free RPC does the job.
    const before = await readOnChainRoot(getPollConnection());
    const items = await fetchAllAssets();
    const after = await readOnChainRoot(getPollConnection());

    if (!before.root.equals(after.root) || before.seq !== after.seq) {
      console.warn("[indexer] on-chain root/seq changed mid-scan — skipping this refresh, will retry next cycle");
      return false;
    }

    const leaves = new Map<number, Buffer>();
    const assetsById = new Map<string, IndexedAsset>();
    for (const item of items) {
      const leafIndex = item.compression?.leaf_id;
      const assetHash = item.compression?.asset_hash;
      const owner = item.ownership?.owner;
      const dataHash = item.compression?.data_hash;
      const creatorHash = item.compression?.creator_hash;
      if (leafIndex === undefined || leafIndex === null || !assetHash) continue;
      if (item.burnt) {
        // Capture the memorial record right here, from the SAME DAS page that told us it's
        // burnt — no extra call, and this is the last moment this data is available (the next
        // refresh's bulk response may drop content.metadata for a burnt leaf entirely). First
        // capture wins; never let a later, possibly-degraded page overwrite a good record.
        if (!_burnt.has(item.id)) {
          const previous = _state?.assetsById.get(item.id);
          const name = item.content?.metadata?.name ?? previous?.name ?? null;
          const match = name?.match(/#(\d+)/);
          _burnt.set(item.id, {
            number: match ? parseInt(match[1], 10) : null,
            name,
            mint: item.id,
            image: item.content?.files?.[0]?.uri ?? previous?.image ?? null,
            traits: item.content?.metadata?.attributes ?? previous?.traits ?? null,
            lastSeenLeafIndex: leafIndex,
            burnedAtMs: Date.now(),
          });
          persistBurnt();
          console.log(`[indexer] captured memorial record for newly-burnt asset ${item.id}`);
        }
        continue; // see file header note 1 — excluded from the live index either way
      }
      if (item.compression?.compressed === false) continue;
      leaves.set(leafIndex, Buffer.from(bs58.decode(assetHash)));
      if (owner && dataHash && creatorHash) {
        // A transfer/delegate change touches owner + hashes, never display metadata — but a
        // single flaky DAS response CAN come back with content.metadata missing/empty for
        // reasons that have nothing to do with the asset itself (Helius's own Arweave-fetch
        // hiccup, a slow page, etc.). Overlay onto whatever we already had rather than blanking
        // a previously-known name/image/traits just because one page didn't include them.
        const previous = _state?.assetsById.get(item.id);
        assetsById.set(item.id, {
          leafIndex,
          owner,
          delegate: item.ownership?.delegate ?? null,
          dataHash,
          creatorHash,
          name: item.content?.metadata?.name ?? previous?.name ?? null,
          symbol: item.content?.metadata?.symbol ?? previous?.symbol ?? null,
          image: item.content?.files?.[0]?.uri ?? previous?.image ?? null,
          traits: item.content?.metadata?.attributes ?? previous?.traits ?? null,
        });
      }
    }

    const depth = before.depth;
    const totalSlots = 2 ** depth;
    const leafBuffers: Buffer[] = new Array(totalSlots);
    for (let i = 0; i < totalSlots; i++) leafBuffers[i] = leaves.get(i) ?? Buffer.alloc(32, 0);

    const tree = MerkleTree.sparseMerkleTreeFromLeaves(leafBuffers, depth);
    const computedRoot = Buffer.from(tree.root);

    if (!computedRoot.equals(before.root)) {
      console.error(
        `[indexer] REBUILD ROOT MISMATCH — computed=${computedRoot.toString("hex")} onChain=${before.root.toString("hex")}. Refusing to replace current state.`,
      );
      return false;
    }

    _state = {
      builtAtMs: Date.now(),
      onChainRoot: before.root.toString("hex"),
      depth,
      leaves,
      assetsById,
      byOwner: buildOwnerIndex(assetsById),
      tree,
    };
    persistState(_state);
    console.log(`[indexer] refreshed OK — ${leaves.size} live leaves, root=${_state.onChainRoot}`);
    return true;
  } catch (err) {
    console.error("[indexer] refresh failed:", err instanceof Error ? err.message : err);
    return false;
  } finally {
    _refreshing = false;
  }
}

function buildOwnerIndex(assetsById: Map<string, IndexedAsset>): Map<string, string[]> {
  const byOwner = new Map<string, string[]>();
  for (const [assetId, asset] of assetsById) {
    const existing = byOwner.get(asset.owner);
    if (existing) existing.push(assetId);
    else byOwner.set(asset.owner, [assetId]);
  }
  return byOwner;
}

function persistState(state: IndexState): void {
  try {
    const serializable = {
      builtAtMs: state.builtAtMs,
      onChainRoot: state.onChainRoot,
      depth: state.depth,
      leaves: Array.from(state.leaves.entries()).map(([idx, buf]) => [idx, buf.toString("hex")]),
      assetsById: Array.from(state.assetsById.entries()),
    };
    writeFileSync(resolve(process.cwd(), STATE_FILE), JSON.stringify(serializable), "utf8");
  } catch (err) {
    // Warm-start optimization only — refreshIndex() always re-verifies against the live
    // on-chain root regardless, so a write failure here is non-fatal.
    console.warn("[indexer] failed to persist state:", err instanceof Error ? err.message : err);
  }
}

function persistBurnt(): void {
  try {
    const serializable = Array.from(_burnt.entries());
    writeFileSync(resolve(process.cwd(), BURNT_STATE_FILE), JSON.stringify(serializable), "utf8");
  } catch (err) {
    console.warn("[indexer] failed to persist burnt state:", err instanceof Error ? err.message : err);
  }
}

/** Loads the growing memorial log from disk, then merges in the checked-in seed file for burns
 *  that happened before this indexer existed. Disk-persisted entries always win over the seed —
 *  the seed is only a fallback for mints this indexer never itself observed being burnt. */
function loadBurntFromDisk(): void {
  const statePath = resolve(process.cwd(), BURNT_STATE_FILE);
  if (existsSync(statePath)) {
    try {
      const raw = JSON.parse(readFileSync(statePath, "utf8")) as [string, BurntAsset][];
      _burnt = new Map(raw);
    } catch (err) {
      console.warn("[indexer] failed to load burnt state:", err instanceof Error ? err.message : err);
    }
  }
  const seedPath = resolve(process.cwd(), BURNT_SEED_FILE);
  if (existsSync(seedPath)) {
    try {
      const seed = JSON.parse(readFileSync(seedPath, "utf8")) as BurntAsset[];
      let added = 0;
      for (const entry of seed) {
        if (!_burnt.has(entry.mint)) {
          _burnt.set(entry.mint, entry);
          added++;
        }
      }
      if (added > 0) {
        console.log(`[indexer] merged ${added} backfilled entries from burnt seed file`);
        persistBurnt();
      }
    } catch (err) {
      console.warn("[indexer] failed to load burnt seed:", err instanceof Error ? err.message : err);
    }
  }
}

/** The memorial list — every Monke ever observed (or backfilled) as burnt, with its last-known
 *  name/image/traits. Purely static/historical: never re-verified against chain, since a burnt
 *  leaf has no current on-chain state left to verify against. */
export type RarityTier = "Legendary" | "Rare" | "Uncommon" | "Common";
export type BurntAssetWithRarity = BurntAsset & {
  rarityRank: number | null; // 1 = rarest in the whole collection; null if traits are missing
  rarityTotal: number | null; // collection size rarity was computed against
  rarityTier: RarityTier | null;
};

/**
 * Statistical rarity ("sum of 1/trait-frequency", the standard scheme most NFT rarity tools use)
 * computed across the WHOLE collection — every currently-live asset plus every burnt one — since
 * rarity only means anything relative to the full set, not just the burnt subset. Live traits come
 * from the same in-memory index this whole file already maintains; no extra DAS/Helius call.
 * Recomputed on every call rather than cached: ~10k assets x 6 traits is microseconds, and the
 * Worker in front of this already caches /burnt for 300s, so this never runs more than once every
 * few minutes under real traffic regardless.
 */
function computeRarity(): Map<string, { rank: number; total: number; tier: RarityTier }> {
  const all: { mint: string; traits: NftTrait[] | null }[] = [];
  if (_state) for (const [mint, asset] of _state.assetsById) all.push({ mint, traits: asset.traits });
  for (const [mint, b] of _burnt) all.push({ mint, traits: b.traits });

  const freq = new Map<string, Map<string, number>>(); // trait_type -> value -> count
  for (const { traits } of all) {
    if (!traits) continue;
    for (const t of traits) {
      let byValue = freq.get(t.trait_type);
      if (!byValue) { byValue = new Map(); freq.set(t.trait_type, byValue); }
      byValue.set(t.value, (byValue.get(t.value) ?? 0) + 1);
    }
  }

  const total = all.length;
  const scored = all
    .filter((a) => a.traits && a.traits.length > 0)
    .map(({ mint, traits }) => {
      let score = 0;
      for (const t of traits!) {
        const count = freq.get(t.trait_type)?.get(t.value) ?? 1;
        score += total / count; // rarer trait value (lower count) contributes more
      }
      return { mint, score };
    });
  scored.sort((a, b) => b.score - a.score); // highest score = rarest, first

  const out = new Map<string, { rank: number; total: number; tier: RarityTier }>();
  scored.forEach((s, i) => {
    const rank = i + 1;
    const pct = rank / scored.length;
    const tier: RarityTier = pct <= 0.01 ? "Legendary" : pct <= 0.1 ? "Rare" : pct <= 0.5 ? "Uncommon" : "Common";
    out.set(s.mint, { rank, total, tier });
  });
  return out;
}

export function getBurnt(): BurntAssetWithRarity[] {
  const rarity = computeRarity();
  return Array.from(_burnt.values())
    .map((b) => {
      const r = rarity.get(b.mint);
      return { ...b, rarityRank: r?.rank ?? null, rarityTotal: r?.total ?? null, rarityTier: r?.tier ?? null };
    })
    .sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
}

/** Loads the last-known-good snapshot from disk on boot, WITHOUT trusting it until the next
 *  live refresh confirms it still matches on-chain — just avoids serving nothing immediately
 *  after a restart while the first refresh is in flight. */
export function loadStateFromDisk(): boolean {
  const path = resolve(process.cwd(), STATE_FILE);
  if (_state || !existsSync(path)) return false;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      builtAtMs: number;
      onChainRoot: string;
      depth: number;
      leaves: [number, string][];
      assetsById: [string, IndexedAsset][];
    };
    const leaves = new Map(raw.leaves.map(([idx, hex]) => [idx, Buffer.from(hex, "hex")]));
    const totalSlots = 2 ** raw.depth;
    const leafBuffers: Buffer[] = new Array(totalSlots);
    for (let i = 0; i < totalSlots; i++) leafBuffers[i] = leaves.get(i) ?? Buffer.alloc(32, 0);
    const tree = MerkleTree.sparseMerkleTreeFromLeaves(leafBuffers, raw.depth);
    const assetsById = new Map(raw.assetsById);
    _state = {
      builtAtMs: raw.builtAtMs,
      onChainRoot: raw.onChainRoot,
      depth: raw.depth,
      leaves,
      assetsById,
      byOwner: buildOwnerIndex(assetsById),
      tree,
    };
    console.log(`[indexer] loaded state from disk (built ${new Date(raw.builtAtMs).toISOString()}) — will re-verify on next refresh`);
    return true;
  } catch (err) {
    console.warn("[indexer] failed to load disk state:", err instanceof Error ? err.message : err);
    return false;
  }
}

export type CompressionDataResult = {
  assetId: string;
  tree: string;
  root: string; // base58
  dataHash: string; // base58
  creatorHash: string; // base58
  leafIndex: number;
  proof: string[]; // base58
  owner: string;
  delegate: string | null;
};

/**
 * One-shot replacement for a client's two-call DAS pattern (getAsset + getAssetProof) —
 * everything needed to construct or verify a Bubblegum transfer, from a single cached lookup.
 *
 * Deliberately does NOT make a live on-chain call per invocation — this is served straight from
 * the in-memory cache, refreshed only on the periodic cycle. A public HTTP-facing function must
 * not cost an external RPC call per request; that turns request volume directly into DAS-quota
 * consumption; see getStatus()'s staleness field for how a caller can judge freshness instead.
 * A stale/wrong proof still just fails atomically on-chain (Bubblegum itself rejects it) — no
 * funds move — so serving a cache that's up to REFRESH_INTERVAL_MS old is an acceptable
 * trade-off for keeping this endpoint cheap enough to expose publicly.
 */
export function getCompressionDataForAsset(assetId: string): CompressionDataResult | null {
  if (!_state) return null;
  const asset = _state.assetsById.get(assetId);
  if (!asset) return null;

  const proof = _state.tree.getProof(asset.leafIndex);
  return {
    assetId,
    tree: TREE_ADDRESS.toBase58(),
    root: bs58.encode(proof.root),
    dataHash: asset.dataHash,
    creatorHash: asset.creatorHash,
    leafIndex: asset.leafIndex,
    proof: proof.proof.map((p) => bs58.encode(p)),
    owner: asset.owner,
    delegate: asset.delegate,
  };
}

/** Ownership lookup from the same cache — the bonus "does wallet X own asset Y" use case. */
export function getOwnerOfAsset(assetId: string): { owner: string; delegate: string | null } | null {
  const asset = _state?.assetsById.get(assetId);
  return asset ? { owner: asset.owner, delegate: asset.delegate } : null;
}

export type AssetMetadata = {
  name: string | null;
  symbol: string | null;
  image: string | null;
  traits: NftTrait[] | null;
};

/** Display metadata (name/image/traits) — Helius already resolved this as part of the same
 *  getAssetsByGroup call refreshIndex() makes anyway, so this costs nothing beyond what
 *  MonkeLedger already spends. Returns null only if the asset isn't in the index at all. */
export function getMetadataForAsset(assetId: string): AssetMetadata | null {
  const asset = _state?.assetsById.get(assetId);
  if (!asset) return null;
  return { name: asset.name, symbol: asset.symbol, image: asset.image, traits: asset.traits };
}

export type ExportRow = {
  number: number | null; // parsed from "MONKE #N" — null if name doesn't match that pattern
  name: string | null;
  mint: string; // assetId
  image: string | null;
  traits: NftTrait[] | null;
};

/** Full static dump — number, mint, traits, and the current Arweave image URL for every live
 *  asset in the index. This is exactly "the helper file": a fixed mapping that's cheap to build
 *  once from data MonkeLedger already has, since none of it (traits, image, mint) changes for an
 *  existing asset except on the rare metadata-update event — ownership/ownership-adjacent data
 *  (who currently holds it) deliberately isn't part of this export; that's what /wallet and
 *  /owner are for, and it changes far too often to bake into a static file. */
export function exportAll(): ExportRow[] {
  if (!_state) return [];
  const rows: ExportRow[] = [];
  for (const [mint, asset] of _state.assetsById) {
    const match = asset.name?.match(/#(\d+)/);
    rows.push({
      number: match ? parseInt(match[1], 10) : null,
      name: asset.name,
      mint,
      image: asset.image,
      traits: asset.traits,
    });
  }
  rows.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
  return rows;
}

export type HolderRow = ExportRow & { owner: string; delegate: string | null };

/**
 * Same data as exportAll(), but WITH ownership — for consumers that specifically need
 * owner+metadata together (a holder census, rebuilding a wallet-keyed index) rather than a
 * static per-asset reference. Deliberately a separate endpoint from /export rather than a flag
 * on it: ownership changes far more often, so this should never be cached as long as /export is.
 */
export function getHolders(): HolderRow[] {
  if (!_state) return [];
  const rows: HolderRow[] = [];
  for (const [mint, asset] of _state.assetsById) {
    const match = asset.name?.match(/#(\d+)/);
    rows.push({
      number: match ? parseInt(match[1], 10) : null,
      name: asset.name,
      mint,
      image: asset.image,
      traits: asset.traits,
      owner: asset.owner,
      delegate: asset.delegate,
    });
  }
  rows.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
  return rows;
}

/** Reverse lookup — "does wallet W own any asset in this collection". Returns an empty array
 *  (not null) for a wallet that holds none; null only when the index itself isn't ready yet, so
 *  callers can distinguish "confirmed zero" from "couldn't check" the same way the existing
 *  Helius-chain callers already do (never treat an unready index as a confirmed non-holder). */
export function getAssetsOwnedByWallet(owner: string): string[] | null {
  if (!_state) return null;
  return _state.byOwner.get(owner) ?? [];
}

export function getStatus(): {
  ready: boolean;
  builtAtMs: number | null;
  ageMs: number | null;
  leafCount: number;
  uniqueOwners: number;
  root: string | null;
} {
  return {
    ready: _state !== null,
    builtAtMs: _state?.builtAtMs ?? null,
    ageMs: _state ? Date.now() - _state.builtAtMs : null,
    leafCount: _state?.leaves.size ?? 0,
    // Cheap — Map.size, not a per-asset walk. Deliberately NOT escrow-stripped: which programs
    // count as marketplace escrows is collection-specific knowledge that doesn't belong in a
    // generic indexer. A consumer that needs an escrow-excluded count should pull /holders and
    // filter client-side, same as the existing Saga Monkes consumers already do.
    uniqueOwners: _state?.byOwner.size ?? 0,
    root: _state?.onChainRoot ?? null,
  };
}

/** Call once at boot. Loads any disk state for a warm start, kicks off an immediate refresh,
 *  then keeps refreshing on the configured interval. */
/**
 * Call once at boot. Loads any disk state for a warm start, does an initial full refresh, then
 * runs two independent timers: a frequent cheap poll that only escalates to a full refresh when
 * the on-chain root has actually changed, and an infrequent full refresh as a safety net in case
 * polling ever misses something (wrong RPC, transient bug, etc.).
 */
export function startIndexer(pollIntervalMs: number, refreshIntervalMs: number): void {
  loadStateFromDisk();
  loadBurntFromDisk();
  void refreshIndex();
  if (_pollTimer) clearInterval(_pollTimer);
  if (_refreshTimer) clearInterval(_refreshTimer);
  _pollTimer = setInterval(() => void pollForChange(), pollIntervalMs);
  _refreshTimer = setInterval(() => void refreshIndex(), refreshIntervalMs);
}

export function stopIndexer(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}
