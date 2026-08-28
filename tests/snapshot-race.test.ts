/**
 * 削除・作成に「追い越された取得」がキャッシュを書き戻す競合。
 *
 * デッキを消した直後に、消す前から走っていた `refreshSnapshot` が後から着地すると、
 * 古い一覧で `publishDeckCache` してしまい、**消したはずのデッキが復活する**
 * （進捗は消えているので「新規デッキ」として出る）。2026-08-28 Codex 指摘。
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDeckCache, resetDbForTest } from "../src/db";
import { invalidateSnapshotFetches, refreshSnapshot } from "../src/snapshot";

const COMMIT = "a".repeat(40);

/** decks/alpha.json だけがある一覧を返す fetch。デッキ本文の取得は `gate` が解けるまで待たせる */
function stubGitHub(gate: Promise<void>) {
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
      // デッキ本文。ここで足止めして「削除より前に始まり、削除より後に終わる取得」を作る
      await gate;
      return new Response(
        JSON.stringify({ schemaVersion: 1, id: "alpha", name: "デッキalpha", cards: [{ id: "001", front: "問", back: "答" }] }),
        { status: 200 },
      );
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

it("削除に追い越された取得は、キャッシュも画面も書き戻さない", async () => {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  stubGitHub(gate);

  // 取得を始める（デッキ本文の手前で止まる）
  const inFlight = refreshSnapshot(null);
  await Promise.resolve();

  // その間にデッキを削除した、という状況を作る
  invalidateSnapshotFetches();

  // 足止めを解いて、古い取得を着地させる
  open();
  const result = await inFlight;

  // 追い越されたので結果は捨てられ、キャッシュにも書かれない
  expect(result).toBeNull();
  expect(await readDeckCache()).toEqual([]);
});

it("追い越されていない取得は、これまでどおりキャッシュへ書く", async () => {
  stubGitHub(Promise.resolve());
  const result = await refreshSnapshot(null);
  expect(result?.decks.map((entry) => entry.deckId)).toEqual(["alpha"]);
  expect((await readDeckCache()).map((entry) => entry.deckId)).toEqual(["alpha"]);
});
