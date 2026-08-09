import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import { getDb, readAllProgress, resetDbForTest, saveReview } from "../src/db";
import { dayKey, rate } from "../src/srs";
import type { ProgressRecord, ReviewLogEntry } from "../src/types";

const NOW = new Date("2026-08-09T03:00:00Z");

function makeRecord(cardId: string, updatedAt: number): ProgressRecord {
  return {
    deckId: "deck",
    cardId,
    progress: rate(null, 3, NOW),
    introducedDayKey: dayKey(NOW),
    updatedAt,
  };
}

function makeLog(reviewId: string): ReviewLogEntry {
  return { reviewId, deckId: "deck", cardId: "001", rating: 3, reviewedAt: NOW.getTime() };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTest();
});

describe("exportBackup / importBackup", () => {
  it("エクスポート→空DBへインポートで進捗とログが復元される（roundtrip）", async () => {
    await saveReview(makeRecord("001", 100), makeLog("r1"));
    await saveReview(makeRecord("002", 200), makeLog("r2"));
    const backup = JSON.parse(JSON.stringify(await exportBackup()));

    globalThis.indexedDB = new IDBFactory();
    resetDbForTest();
    const result = await importBackup(backup);
    expect(result).toEqual({ progressImported: 2, progressSkipped: 0, logsImported: 2 });
    expect(await readAllProgress()).toHaveLength(2);
  });

  it("updatedAt が新しい方を採用し、同時刻・古い方はスキップする", async () => {
    await saveReview(makeRecord("001", 200), makeLog("r1"));
    const older = { ...makeRecord("001", 100), introducedDayKey: "2020-01-01" };
    const same = makeRecord("001", 200);
    const newer = { ...makeRecord("001", 300), introducedDayKey: "2030-01-01" };

    expect((await importBackup({ schemaVersion: 1, exportedAt: 0, cardProgress: [older], reviewLog: [] })).progressSkipped).toBe(1);
    expect((await importBackup({ schemaVersion: 1, exportedAt: 0, cardProgress: [same], reviewLog: [] })).progressSkipped).toBe(1);
    expect((await importBackup({ schemaVersion: 1, exportedAt: 0, cardProgress: [newer], reviewLog: [] })).progressImported).toBe(1);
    expect((await readAllProgress())[0].introducedDayKey).toBe("2030-01-01");
  });

  it("reviewLog は reviewId で重複排除して追記する", async () => {
    await saveReview(makeRecord("001", 100), makeLog("r1"));
    const result = await importBackup({
      schemaVersion: 1,
      exportedAt: 0,
      cardProgress: [],
      reviewLog: [makeLog("r1"), makeLog("r2")],
    });
    expect(result.logsImported).toBe(1);
    const db = await getDb();
    expect(await db.getAll("reviewLog")).toHaveLength(2);
  });

  it("不正なバックアップは全体を拒否し、何も書き込まない", async () => {
    const broken = {
      schemaVersion: 1,
      exportedAt: 0,
      cardProgress: [makeRecord("001", 100), { ...makeRecord("002", 100), progress: { formatVersion: 99 } }],
      reviewLog: [],
    };
    await expect(importBackup(broken)).rejects.toThrow("formatVersion");
    expect(await readAllProgress()).toHaveLength(0);
  });

  it("validateBackup が構造不正を拒否する", () => {
    expect(() => validateBackup(null)).toThrow("オブジェクト");
    expect(() => validateBackup({ schemaVersion: 2, cardProgress: [], reviewLog: [] })).toThrow("schemaVersion");
    expect(() => validateBackup({ schemaVersion: 1, cardProgress: {}, reviewLog: [] })).toThrow("配列");
    expect(() => validateBackup({ schemaVersion: 1, cardProgress: [], reviewLog: [{ reviewId: "", deckId: "d", cardId: "c", rating: 3, reviewedAt: 0 }] })).toThrow("reviewId");
  });
});
