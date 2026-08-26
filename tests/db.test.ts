import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteProgressByDeck, getDb, pruneReviewLog, readAllProgress, resetDbForTest, saveReview } from "../src/db";
import { dayKey, rate } from "../src/srs";
import type { ProgressRecord, ReviewLogEntry } from "../src/types";

const NOW = new Date("2026-08-10T03:00:00Z");

function record(deckId: string, cardId: string): ProgressRecord {
  return { deckId, cardId, progress: rate(null, 3, NOW), introducedDayKey: dayKey(NOW), updatedAt: NOW.getTime() };
}

function log(deckId: string, cardId: string, reviewId: string): ReviewLogEntry {
  return { reviewId, deckId, cardId, rating: 3, reviewedAt: NOW.getTime() };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTest();
});

describe("deleteProgressByDeck", () => {
  it("対象デッキの進捗だけを消し、他デッキと reviewLog は残す", async () => {
    await saveReview(record("alpha", "001"), log("alpha", "001", "r1"));
    await saveReview(record("alpha", "002"), log("alpha", "002", "r2"));
    await saveReview(record("beta", "001"), log("beta", "001", "r3"));

    const deleted = await deleteProgressByDeck("alpha");
    expect(deleted).toBe(2);

    const remaining = await readAllProgress();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].deckId).toBe("beta");

    const db = await getDb();
    expect(await db.getAll("reviewLog")).toHaveLength(3);
  });

  it("進捗のないデッキでは0件で成功する", async () => {
    expect(await deleteProgressByDeck("nothing")).toBe(0);
  });
});

describe("pruneReviewLog", () => {
  const DAY = 86_400_000;

  async function putLogs(times: number[]): Promise<void> {
    const db = await getDb();
    for (const [index, reviewedAt] of times.entries()) {
      await db.put("reviewLog", { reviewId: `r${index}`, deckId: "deck", cardId: "001", rating: 3, reviewedAt });
    }
  }

  it("保持期間を過ぎたログだけを消す", async () => {
    const now = NOW.getTime();
    await putLogs([now - 401 * DAY, now - 399 * DAY, now]);
    expect(await pruneReviewLog(now, 400, 1000)).toBe(1);
    const db = await getDb();
    const rest = await db.getAll("reviewLog");
    expect(rest.map((entry) => entry.reviewId)).toEqual(["r1", "r2"]);
  });

  it("期間内でも上限を超えたぶんは古い順に消す", async () => {
    const now = NOW.getTime();
    await putLogs([now - 3 * DAY, now - 2 * DAY, now - DAY, now]);
    expect(await pruneReviewLog(now, 400, 2)).toBe(2);
    const db = await getDb();
    expect((await db.getAll("reviewLog")).map((entry) => entry.reviewId)).toEqual(["r2", "r3"]);
  });

  it("消すものが無ければ何もしない", async () => {
    const now = NOW.getTime();
    await putLogs([now - DAY, now]);
    expect(await pruneReviewLog(now, 400, 1000)).toBe(0);
    expect(await (await getDb()).getAll("reviewLog")).toHaveLength(2);
  });

  it("進捗（cardProgress）には触らない", async () => {
    const now = NOW.getTime();
    await saveReview(record("alpha", "001"), log("alpha", "001", "old"));
    await pruneReviewLog(now, 0, 0);
    expect(await readAllProgress()).toHaveLength(1);
    expect(await (await getDb()).getAll("reviewLog")).toHaveLength(0);
  });
});

describe("v1 からのスキーマ更新", () => {
  /** 旧バージョンが作った DB を再現する（reviewLog に byReviewedAt インデックスが無い状態） */
  function openV1(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("flashcards-db", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("cardProgress", { keyPath: ["deckId", "cardId"] }).createIndex("byDeck", "deckId");
        db.createObjectStore("reviewLog", { keyPath: "reviewId" });
        db.createObjectStore("deckCache", { keyPath: "deckId" });
        db.createObjectStore("importDrafts", { keyPath: "draftId" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  it("v3 で足したストアが使える（v1 から2段引き上げ）", async () => {
    const legacy = await openV1();
    legacy.close();
    const db = await getDb();
    expect(db.version).toBe(3);
    expect([...db.objectStoreNames].sort()).toContain("cardNotes");
    expect([...db.objectStoreNames].sort()).toContain("hiddenCards");
  });

  it("既存データを消さずにインデックスを足し、間引きできるようになる", async () => {
    const legacy = await openV1();
    await new Promise<void>((resolve, reject) => {
      const tx = legacy.transaction(["reviewLog", "cardProgress"], "readwrite");
      tx.objectStore("reviewLog").put({ reviewId: "old", deckId: "deck", cardId: "001", rating: 3, reviewedAt: 0 });
      tx.objectStore("reviewLog").put({ reviewId: "new", deckId: "deck", cardId: "001", rating: 3, reviewedAt: NOW.getTime() });
      tx.objectStore("cardProgress").put(record("alpha", "001"));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    legacy.close();

    // 引き上げ後も進捗とログは残っている
    const db = await getDb();
    expect(await db.getAll("reviewLog")).toHaveLength(2);
    expect(await readAllProgress()).toHaveLength(1);

    // 後付けしたインデックスで間引きが動く
    expect(await pruneReviewLog(NOW.getTime(), 400, 1000)).toBe(1);
    expect((await db.getAll("reviewLog")).map((entry) => entry.reviewId)).toEqual(["new"]);
  });
});
