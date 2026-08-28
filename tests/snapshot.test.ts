import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishDeckCache, readDeckCache, resetDbForTest } from "../src/db";
import { loadCachedSnapshot, refreshSnapshot } from "../src/snapshot";

/** テスト用: 追い越されていない前提で結果を取り出す（null は想定外なので落とす） */
async function refreshCurrentSnapshot(token: string | null) {
  const snapshot = await refreshSnapshot(token);
  if (snapshot === null) throw new Error("refreshSnapshot が追い越されました（テストでは起こらないはず）");
  return snapshot;
}


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
  /** true にすると decks の sha を欠落させる（壊れた一覧の再現） */
  dropShas?: boolean;
  /** デッキ id → blob SHA。省略時はデッキ id から決まる固定値 */
  blobShas?: Record<string, string>;
  rawBodies?: Record<string, string | Error>;
  listingError?: boolean;
}

function deckIdOf(path: string): string {
  return path.slice("decks/".length, -".json".length);
}

function rawFetchCount(): number {
  const mock = globalThis.fetch as unknown as { mock: { calls: [RequestInfo | URL][] } };
  return mock.mock.calls.filter(([input]) => String(input).includes("raw.githubusercontent.com")).length;
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
          JSON.stringify({
            tree: (plan.deckPaths ?? []).map((path) => ({
              path,
              type: "blob",
              ...(plan.dropShas ? {} : { sha: plan.blobShas?.[deckIdOf(path)] ?? `blob-${deckIdOf(path)}` }),
            })),
          }),
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
    const snapshot = await refreshCurrentSnapshot(null);
    expect(snapshot.offline).toBe(false);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.decks.map((entry) => entry.deckId).sort()).toEqual(["alpha", "beta"]);
    expect((await readDeckCache()).every((entry) => entry.commitSha === COMMIT_A)).toBe(true);
  });

  it("一覧取得に失敗したら既存キャッシュを offline で返す", async () => {
    installFetch({ deckPaths: ["decks/alpha.json"], rawBodies: { alpha: deckJson("alpha") } });
    await refreshCurrentSnapshot(null);

    installFetch({ listingError: true });
    const snapshot = await refreshCurrentSnapshot(null);
    expect(snapshot.offline).toBe(true);
    expect(snapshot.decks.map((entry) => entry.deckId)).toEqual(["alpha"]);
  });

  it("不正になったデッキは旧キャッシュを残し、警告を付ける", async () => {
    installFetch({ deckPaths: ["decks/alpha.json"], rawBodies: { alpha: deckJson("alpha", "旧") } });
    await refreshCurrentSnapshot(null);

    // 中身が変わった（＝取り直す）が、そのファイルが壊れている
    installFetch({
      commitSha: COMMIT_B,
      deckPaths: ["decks/alpha.json"],
      blobShas: { alpha: "blob-alpha-broken" },
      rawBodies: { alpha: "{ broken json" },
    });
    const snapshot = await refreshCurrentSnapshot(null);
    expect(snapshot.offline).toBe(false);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain("alpha");
    expect(snapshot.decks).toHaveLength(1);
    expect(snapshot.decks[0].deck.cards[0].front).toBe("旧");
    expect(snapshot.decks[0].commitSha).toBe(COMMIT_A);
  });

  it("キャッシュのない不正デッキは警告のみで除外する", async () => {
    installFetch({ deckPaths: ["decks/alpha.json"], rawBodies: { alpha: JSON.stringify({ schemaVersion: 1, id: "other", name: "x", cards: [] }) } });
    const snapshot = await refreshCurrentSnapshot(null);
    expect(snapshot.decks).toHaveLength(0);
    expect(snapshot.warnings[0]).toContain("alpha");
  });

  it("リポジトリから消えたデッキはキャッシュからも消す", async () => {
    installFetch({ deckPaths: ["decks/alpha.json", "decks/beta.json"], rawBodies: { alpha: deckJson("alpha"), beta: deckJson("beta") } });
    await refreshCurrentSnapshot(null);

    installFetch({ commitSha: COMMIT_B, deckPaths: ["decks/alpha.json"], rawBodies: { alpha: deckJson("alpha") } });
    const snapshot = await refreshCurrentSnapshot(null);
    expect(snapshot.decks.map((entry) => entry.deckId)).toEqual(["alpha"]);
    expect(await readDeckCache()).toHaveLength(1);
    // 中身が変わっていない alpha は取り直していない
    expect(rawFetchCount()).toBe(0);
  });

  it("一部デッキの通信失敗では更新全体を中止し、旧キャッシュを保つ", async () => {
    installFetch({ deckPaths: ["decks/alpha.json", "decks/beta.json"], rawBodies: { alpha: deckJson("alpha", "旧"), beta: deckJson("beta") } });
    await refreshCurrentSnapshot(null);

    installFetch({
      commitSha: COMMIT_B,
      deckPaths: ["decks/alpha.json", "decks/beta.json"],
      blobShas: { alpha: "blob-alpha-2", beta: "blob-beta-2" },
      rawBodies: { alpha: deckJson("alpha", "新"), beta: new TypeError("network down") },
    });
    const snapshot = await refreshCurrentSnapshot(null);
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

describe("refreshSnapshot のキャッシュ利用（blob SHA 判定）", () => {
  it("中身が変わらなければ、別コミットでも取り直さない", async () => {
    installFetch({ deckPaths: ["decks/a.json"], rawBodies: { a: deckJson("a") } });
    await refreshCurrentSnapshot(null);
    expect(rawFetchCount()).toBe(1);

    // コミットは進んだが decks/a.json は変わっていない
    installFetch({ commitSha: COMMIT_B, deckPaths: ["decks/a.json"], rawBodies: { a: deckJson("a") } });
    const snapshot = await refreshCurrentSnapshot(null);
    expect(rawFetchCount()).toBe(0);
    expect(snapshot.decks).toHaveLength(1);
    expect(snapshot.decks[0].deck.cards[0].front).toBe("問");
    // raw 取得に使うコミットは最新へ更新しておく
    expect(snapshot.decks[0].commitSha).toBe(COMMIT_B);
  });

  it("中身が変わったデッキだけ取り直す", async () => {
    installFetch({
      deckPaths: ["decks/a.json", "decks/b.json"],
      rawBodies: { a: deckJson("a"), b: deckJson("b") },
    });
    await refreshCurrentSnapshot(null);
    expect(rawFetchCount()).toBe(2);

    installFetch({
      commitSha: COMMIT_B,
      deckPaths: ["decks/a.json", "decks/b.json"],
      blobShas: { b: "blob-b-updated" },
      rawBodies: { a: deckJson("a"), b: deckJson("b", "新しい問") },
    });
    const snapshot = await refreshCurrentSnapshot(null);
    expect(rawFetchCount()).toBe(1);
    expect(snapshot.decks.find((entry) => entry.deckId === "a")?.deck.cards[0].front).toBe("問");
    expect(snapshot.decks.find((entry) => entry.deckId === "b")?.deck.cards[0].front).toBe("新しい問");
  });

  it("blob SHA を持たない旧キャッシュは一度だけ取り直す", async () => {
    installFetch({ deckPaths: ["decks/a.json"], rawBodies: { a: deckJson("a") } });
    await refreshCurrentSnapshot(null);
    // 旧バージョンが書いたキャッシュを再現する
    await publishDeckCache(
      (await readDeckCache()).map(({ blobSha: _blobSha, ...rest }) => rest),
      [],
    );
    expect((await readDeckCache())[0].blobSha).toBeUndefined();

    installFetch({ deckPaths: ["decks/a.json"], rawBodies: { a: deckJson("a") } });
    await refreshCurrentSnapshot(null);
    expect(rawFetchCount()).toBe(1);
    expect((await readDeckCache())[0].blobSha).toBe("blob-a");

    installFetch({ deckPaths: ["decks/a.json"], rawBodies: { a: deckJson("a") } });
    await refreshCurrentSnapshot(null);
    expect(rawFetchCount()).toBe(0);
  });

  it("一覧の sha が欠けていたら、キャッシュを消さずオフライン扱いにする", async () => {
    installFetch({ deckPaths: ["decks/a.json"], rawBodies: { a: deckJson("a") } });
    await refreshCurrentSnapshot(null);

    installFetch({ deckPaths: ["decks/a.json"], dropShas: true, rawBodies: { a: deckJson("a") } });
    const snapshot = await refreshCurrentSnapshot(null);
    expect(snapshot.offline).toBe(true);
    expect(snapshot.decks.map((entry) => entry.deckId)).toEqual(["a"]);
    expect(await readDeckCache()).toHaveLength(1);
  });

  it("デッキが増えたら新しいものだけ取得し、消えたらキャッシュから外す", async () => {
    installFetch({ deckPaths: ["decks/a.json"], rawBodies: { a: deckJson("a") } });
    await refreshCurrentSnapshot(null);

    installFetch({
      deckPaths: ["decks/a.json", "decks/c.json"],
      rawBodies: { a: deckJson("a"), c: deckJson("c") },
    });
    let snapshot = await refreshCurrentSnapshot(null);
    expect(rawFetchCount()).toBe(1);
    expect(snapshot.decks.map((entry) => entry.deckId)).toEqual(["a", "c"]);

    installFetch({ deckPaths: ["decks/c.json"], rawBodies: { c: deckJson("c") } });
    snapshot = await refreshCurrentSnapshot(null);
    expect(rawFetchCount()).toBe(0);
    expect(snapshot.decks.map((entry) => entry.deckId)).toEqual(["c"]);
  });
});
