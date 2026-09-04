import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { moveCardLocalData, readAllCardNotes, readAllProgress, readAllReviewLog, readHiddenCards, resetDbForTest, saveCardNote, saveReview, setCardHidden } from "../src/db";
import { dayKey, rate } from "../src/srs";
import type { ProgressRecord, ReviewLogEntry } from "../src/types";

const NOW = new Date("2026-09-04T03:00:00Z");

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

describe("moveCardLocalData", () => {
  it("進捗・ログ・メモ・非表示を移動先デッキへ移し、他のカードは触らない", async () => {
    await saveReview(record("quiz-a", "001"), log("quiz-a", "001", "r1"));
    await saveReview(record("quiz-a", "001"), log("quiz-a", "001", "r2"));
    await saveReview(record("quiz-a", "002"), log("quiz-a", "002", "r3"));
    await saveCardNote("quiz-a", "001", "メモ");
    await setCardHidden("quiz-a", "001", true);

    const moved = await moveCardLocalData("quiz-a", "quiz-b", "001");
    expect(moved).toEqual({ progress: true, notes: true, hidden: true, reviews: 2 });

    const progress = await readAllProgress();
    expect(progress.map((row) => `${row.deckId}/${row.cardId}`).sort()).toEqual(["quiz-a/002", "quiz-b/001"]);
    const logs = await readAllReviewLog();
    expect(logs.filter((row) => row.deckId === "quiz-b")).toHaveLength(2);
    expect(logs.find((row) => row.reviewId === "r3")?.deckId).toBe("quiz-a");
    expect((await readAllCardNotes()).map((row) => row.deckId)).toEqual(["quiz-b"]);
    expect(await readHiddenCards("quiz-b")).toHaveLength(1);
    expect(await readHiddenCards("quiz-a")).toHaveLength(0);
  });

  it("移動先に同じ鍵の進捗があれば失敗し、何も変えない", async () => {
    await saveReview(record("quiz-a", "001"), log("quiz-a", "001", "r1"));
    await saveReview(record("quiz-b", "001"), log("quiz-b", "001", "r2"));
    await expect(moveCardLocalData("quiz-a", "quiz-b", "001")).rejects.toThrow(/既にあります/);
    const progress = await readAllProgress();
    expect(progress).toHaveLength(2);
    expect((await readAllReviewLog()).find((row) => row.reviewId === "r1")?.deckId).toBe("quiz-a");
  });

  it("端末側データが無いカードでも成功する（何も移さない）", async () => {
    expect(await moveCardLocalData("quiz-a", "quiz-b", "999")).toEqual({ progress: false, notes: false, hidden: false, reviews: 0 });
  });
});
