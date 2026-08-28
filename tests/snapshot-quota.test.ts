import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// キャッシュへの書き込みだけを失敗させる（容量不足の再現）
const publishDeckCache = vi.fn(async () => {
  throw Object.assign(new Error("no space"), { name: "QuotaExceededError" });
});
vi.mock("../src/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db")>()),
  publishDeckCache,
}));

const { resetDbForTest } = await import("../src/db");
const { refreshSnapshot } = await import("../src/snapshot");

/** テスト用: 追い越されていない前提で結果を取り出す（null は想定外なので落とす） */
async function refreshCurrentSnapshot(token: string | null) {
  const snapshot = await refreshSnapshot(token);
  if (snapshot === null) throw new Error("refreshSnapshot が追い越されました（テストでは起こらないはず）");
  return snapshot;
}

const COMMIT = "a".repeat(40);

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTest();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/commits/")) {
        return new Response(JSON.stringify({ sha: COMMIT, commit: { tree: { sha: "t".repeat(40) } } }), { status: 200 });
      }
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree: [{ path: "decks/alpha.json", type: "blob", sha: "blob-alpha" }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ schemaVersion: 1, id: "alpha", name: "デッキalpha", cards: [{ id: "001", front: "問", back: "答" }] }),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("キャッシュを保存できなくても、取得したデッキはそのセッションで使える", async () => {
  const snapshot = await refreshCurrentSnapshot(null);
  expect(publishDeckCache).toHaveBeenCalled();
  expect(snapshot.decks.map((entry) => entry.deckId)).toEqual(["alpha"]);
  expect(snapshot.warnings[0]).toContain("保存容量が足りません");
  // 取得自体は成功しているので「オフライン」とは言わない
  expect(snapshot.offline).toBe(false);
});
