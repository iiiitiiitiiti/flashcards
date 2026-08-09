import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDeckCache, resetDbForTest } from "../src/db";
import { loadCachedSnapshot, refreshSnapshot } from "../src/snapshot";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const TREE_SHA = "t".repeat(40);

function deckJson(id: string, front = "問"): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    name: `デッキ${id}`,
    cards: [{ id: "001", front, back: "答" }],
  });
}

interface FetchPlan {
  commitSha?: string;
  deckPaths?: string[];
  rawBodies?: Record<string, string | Error>;
  listingError?: boolean;
}

function installFetch(plan: FetchPlan): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (plan.listingError) throw new TypeError("network down");
      if (url.includes("/commits/")) {
        return new Response(
          JSON.stringify({ sha: plan.commitSha ?? COMMIT_A, commit: { tree: { sha: TREE_SHA } } }),
          { status: 200 },
        );
      }
      if (url.includes("/git/trees/")) {
        return new Response(
          JSON.stringify({ tree: (plan.deckPaths ?? []).map((path) => ({ path, type: "blob" })) }),
          { status: 200 },
        );
      }
      if (url.includes("raw.githubusercontent.com")) {
        const deckId = url.split("/decks/")[1]?.replace(".json", "") ?? "";
        const body = plan.rawBodies?.[decodeURIComponent(deckId)];
        if (body === undefined) return new Response("not found", { status: 404 });
        if (body instanceof Error) throw body;
        return new Response(body, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("refreshSnapshot", () => {
  it("全デッキを取得・検証してキャッシュへ公開する", async () => {
    installFetch({ deckPaths: ["decks/alpha.json", "decks/beta.json"], rawBodies: { alpha: deckJson("alpha"), beta: deckJson("beta") } });
    const snapshot = await refreshSnapshot(null);
    expect(snapshot.offline).toBe(false);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.decks.map((entry) => entry.deckId).sort()).toEqual(["alpha", "beta"]);
    expect((await readDeckCache()).every((entry) => entry.commitSha === COMMIT_A)).toBe(true);
  });

  it("一覧取得に失敗したら既存キャッシュを offline で返す", async () => {
    installFetch({ deckPaths: ["decks/alpha.json"], rawBodies: { alpha: deckJson("alpha") } });
    await refreshSnapshot(null);

    installFetch({ listingError: true });
    const snapshot = await refreshSnapshot(null);
    expect(snapshot.offline).toBe(true);
    expect(snapshot.decks.map((entry) => entry.deckId)).toEqual(["alpha"]);
  });

  it("不正になったデッキは旧キャッシュを残し、警告を付ける", async () => {
    installFetch({ deckPaths: ["decks/alpha.json"], rawBodies: { alpha: deckJson("alpha", "旧") } });
    await refreshSnapshot(null);

    installFetch({ commitSha: COMMIT_B, deckPaths: ["decks/alpha.json"], rawBodies: { alpha: "{ broken json" } });
    const snapshot = await refreshSnapshot(null);
    expect(snapshot.offline).toBe(false);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain("alpha");
    expect(snapshot.decks).toHaveLength(1);
    expect(snapshot.decks[0].deck.cards[0].front).toBe("旧");
    expect(snapshot.decks[0].commitSha).toBe(COMMIT_A);
  });

  it("キャッシュのない不正デッキは警告のみで除外する", async () => {
    installFetch({ deckPaths: ["decks/alpha.json"], rawBodies: { alpha: JSON.stringify({ schemaVersion: 1, id: "other", name: "x", cards: [] }) } });
    const snapshot = await refreshSnapshot(null);
    expect(snapshot.decks).toHaveLength(0);
    expect(snapshot.warnings[0]).toContain("alpha");
  });

  it("リポジトリから消えたデッキはキャッシュからも消す", async () => {
    installFetch({ deckPaths: ["decks/alpha.json", "decks/beta.json"], rawBodies: { alpha: deckJson("alpha"), beta: deckJson("beta") } });
    await refreshSnapshot(null);

    installFetch({ commitSha: COMMIT_B, deckPaths: ["decks/alpha.json"], rawBodies: { alpha: deckJson("alpha") } });
    const snapshot = await refreshSnapshot(null);
    expect(snapshot.decks.map((entry) => entry.deckId)).toEqual(["alpha"]);
    expect(await readDeckCache()).toHaveLength(1);
  });

  it("一部デッキの通信失敗では更新全体を中止し、旧キャッシュを保つ", async () => {
    installFetch({ deckPaths: ["decks/alpha.json", "decks/beta.json"], rawBodies: { alpha: deckJson("alpha", "旧"), beta: deckJson("beta") } });
    await refreshSnapshot(null);

    installFetch({
      commitSha: COMMIT_B,
      deckPaths: ["decks/alpha.json", "decks/beta.json"],
      rawBodies: { alpha: deckJson("alpha", "新"), beta: new TypeError("network down") },
    });
    const snapshot = await refreshSnapshot(null);
    expect(snapshot.offline).toBe(true);
    const cache = await readDeckCache();
    expect(cache).toHaveLength(2);
    expect(cache.find((entry) => entry.deckId === "alpha")?.deck.cards[0].front).toBe("旧");
  });
});

describe("loadCachedSnapshot", () => {
  it("キャッシュが空なら空スナップショットを返す", async () => {
    const snapshot = await loadCachedSnapshot();
    expect(snapshot.decks).toHaveLength(0);
    expect(snapshot.fetchedAt).toBeNull();
  });
});
