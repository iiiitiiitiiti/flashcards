import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteProgressByDeck, getDb, readAllProgress, resetDbForTest, saveReview } from "../src/db";
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
