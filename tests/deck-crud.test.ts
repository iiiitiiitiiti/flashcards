import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteDeckLocalData,
  getDb,
  readAllCardNotes,
  readAllHiddenCards,
  readAllProgress,
  readAllReviewLog,
  readDeckCache,
  resetDbForTest,
  saveCardNote,
  saveReview,
  setCardHidden,
  upsertDeckCacheEntry,
} from "../src/db";
import { createDeck, deleteDeck } from "../src/github";
import type { Deck } from "../src/deck";
import { dayKey, rate } from "../src/srs";
import type { ProgressRecord, ReviewLogEntry } from "../src/types";

const NOW = new Date("2026-08-28T03:00:00Z");

function record(deckId: string, cardId: string): ProgressRecord {
  return { deckId, cardId, progress: rate(null, 3, NOW), introducedDayKey: dayKey(NOW), updatedAt: NOW.getTime() };
}

function log(deckId: string, cardId: string, reviewId: string): ReviewLogEntry {
  return { reviewId, deckId, cardId, rating: 3, reviewedAt: NOW.getTime() };
}

function deck(id: string): Deck {
  return { schemaVersion: 1, id, name: `デッキ ${id}`, cards: [] };
}

/** 2デッキぶんの端末データを入れる。alpha は各2件、beta は各1件 */
async function seed(): Promise<void> {
  await saveReview(record("alpha", "001"), log("alpha", "001", "r1"));
  await saveReview(record("alpha", "002"), log("alpha", "002", "r2"));
  await saveReview(record("beta", "001"), log("beta", "001", "r3"));
  await saveCardNote("alpha", "001", "アルファのメモ");
  await saveCardNote("alpha", "002", "もう1件");
  await saveCardNote("beta", "001", "ベータのメモ");
  await setCardHidden("alpha", "002", true);
  await setCardHidden("beta", "001", true);
  await upsertDeckCacheEntry({ deckId: "alpha", deck: deck("alpha"), commitSha: "c1", fetchedAt: NOW.getTime() });
  await upsertDeckCacheEntry({ deckId: "beta", deck: deck("beta"), commitSha: "c1", fetchedAt: NOW.getTime() });
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("deleteDeckLocalData", () => {
  it("対象デッキの5種類を消し、他デッキのデータは残す", async () => {
    await seed();

    const removed = await deleteDeckLocalData("alpha");
    expect(removed).toEqual({ progress: 2, notes: 2, hidden: 1, reviews: 2 });

    expect((await readAllProgress()).map((row) => row.deckId)).toEqual(["beta"]);
    expect((await readAllCardNotes()).map((row) => row.deckId)).toEqual(["beta"]);
    expect((await readAllHiddenCards()).map((row) => row.deckId)).toEqual(["beta"]);
    expect((await readAllReviewLog()).map((row) => row.deckId)).toEqual(["beta"]);
    expect((await readDeckCache()).map((row) => row.deckId)).toEqual(["beta"]);
  });

  it("データが無いデッキでも例外にならない（何度でも呼べる）", async () => {
    await seed();
    await deleteDeckLocalData("alpha");
    // 2回目は消すものが無い。後片付けだけの再試行がここを通る
    expect(await deleteDeckLocalData("alpha")).toEqual({ progress: 0, notes: 0, hidden: 0, reviews: 0 });
    expect(await readAllProgress()).toHaveLength(1);
  });

  it("途中で失敗したら、先に成功した削除も残らない", async () => {
    await seed();
    // 3件目の delete で投げさせる（1・2件目は要求が通った状態にしてから失敗させる）
    const original = IDBObjectStore.prototype.delete;
    let calls = 0;
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      calls += 1;
      if (calls === 3) throw new Error("注入した失敗");
      return original.call(this, key);
    });

    await expect(deleteDeckLocalData("alpha")).rejects.toThrow("注入した失敗");

    vi.restoreAllMocks();
    // 中止されているので、alpha のデータは1件も欠けていない
    expect(await readAllProgress()).toHaveLength(3);
    expect(await readAllCardNotes()).toHaveLength(3);
    expect(await readAllReviewLog()).toHaveLength(3);
    expect(await readDeckCache()).toHaveLength(2);
  });

  it("reviewLog は byDeck が無いので走査で拾う（他デッキのログを巻き込まない）", async () => {
    await saveReview(record("alpha", "001"), log("alpha", "001", "r1"));
    await saveReview(record("beta", "001"), log("beta", "001", "r2"));
    const db = await getDb();
    // 進捗を持たないデッキのログも、走査で拾えていることを確かめる
    await db.put("reviewLog", log("alpha", "999", "r3"));

    expect((await deleteDeckLocalData("alpha")).reviews).toBe(2);
    expect((await readAllReviewLog()).map((row) => row.reviewId)).toEqual(["r2"]);
  });
});

describe("createDeck", () => {
  it("sha を渡さずに PUT し、作成したデッキを返す", async () => {
    const calls: { method: string; body: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", body: (init?.body as string) ?? null });
        return new Response(JSON.stringify({ content: {} }), { status: 201 });
      }),
    );

    const created = await createDeck("token", { schemaVersion: 1, id: "newdeck", name: "新しいデッキ", cards: [] });
    expect(created.id).toBe("newdeck");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    const body = JSON.parse(calls[0].body ?? "{}") as Record<string, unknown>;
    // sha を渡さないことが、既存ファイルを上書きしないための肝
    expect(body).not.toHaveProperty("sha");
    expect(body.message).toBe("deck(newdeck): create");
  });

  it("422（既にファイルがある）は重複として案内する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: '"sha" wasn\'t supplied.' }), { status: 422 })));
    await expect(createDeck("token", { schemaVersion: 1, id: "sample", name: "重複", cards: [] })).rejects.toThrow(
      "デッキ「sample」は既にあります",
    );
  });

  it("id が規約外なら通信せずに止まる", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createDeck("token", { schemaVersion: 1, id: "だめな id", name: "名前", cards: [] })).rejects.toThrow(/id は/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("deleteDeck", () => {
  it("最新の sha を取ってから DELETE する", async () => {
    const calls: { method: string; body: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, body: (init?.body as string) ?? null });
        if (method === "GET") return new Response(JSON.stringify({ sha: "sha-9", content: "", encoding: "base64" }), { status: 200 });
        return new Response(JSON.stringify({ commit: {} }), { status: 200 });
      }),
    );

    await deleteDeck("alpha", "token");
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(JSON.parse(calls[1].body ?? "{}")).toMatchObject({ sha: "sha-9", message: "deck(alpha): delete" });
  });

  it("すでに無い（404）なら成功として返し、DELETE は打たない", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    // ここで例外にすると、GitHub 側だけ消えたときに端末の後片付けへ辿り着けない
    await expect(deleteDeck("alpha", "token")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("権限が無ければ失敗として伝える", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ sha: "sha-9" }), { status: 200 });
        return new Response(JSON.stringify({ message: "denied" }), { status: 403 });
      }),
    );
    await expect(deleteDeck("alpha", "token")).rejects.toThrow("403");
  });
});
