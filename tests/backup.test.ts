import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";
import { exportBackup, importBackup, validateBackup } from "../src/backup";
import { getDb, readAllProgress, readCardNotes, readHiddenCards, resetDbForTest, saveCardNote, saveReview, setCardHidden } from "../src/db";
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

describe("exportBackup", () => {
  it("件数と Blob を返し、中身は validateBackup を通る JSON になる", async () => {
    await saveReview(makeRecord("001", 100), makeLog("r1"));
    await saveReview(makeRecord("002", 200), makeLog("r2"));
    const exported = await exportBackup(1234);
    expect(exported.progressCount).toBe(2);
    expect(exported.logCount).toBe(2);
    const parsed = JSON.parse(await exported.blob.text());
    expect(parsed.exportedAt).toBe(1234);
    expect(() => validateBackup(parsed)).not.toThrow();
  });

  it("空の DB でも壊れた JSON にならない", async () => {
    const exported = await exportBackup(0);
    const parsed = JSON.parse(await exported.blob.text());
    expect(parsed).toEqual({ schemaVersion: 1, exportedAt: 0, cardProgress: [], reviewLog: [], cardNotes: [], hiddenCards: [] });
  });
});

describe("exportBackup / importBackup", () => {
  it("エクスポート→空DBへインポートで進捗とログが復元される（roundtrip）", async () => {
    await saveReview(makeRecord("001", 100), makeLog("r1"));
    await saveReview(makeRecord("002", 200), makeLog("r2"));
    const backup = JSON.parse(await (await exportBackup()).blob.text());

    globalThis.indexedDB = new IDBFactory();
    resetDbForTest();
    const result = await importBackup(backup);
    expect(result).toEqual({ progressImported: 2, progressSkipped: 0, logsImported: 2, notesImported: 0, hiddenImported: 0 });
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

describe("メモと非表示のバックアップ", () => {
  it("書き出して取り込むと、メモと非表示が復元される", async () => {
    await saveReview(makeRecord("001", 100), makeLog("r1"));
    await saveCardNote("deck", "001", "  語呂合わせ: いい国つくろう  ");
    await setCardHidden("deck", "002", true);

    const backup = JSON.parse(await (await exportBackup()).blob.text());
    expect(backup.cardNotes).toHaveLength(1);
    expect(backup.cardNotes[0].text).toBe("語呂合わせ: いい国つくろう");
    expect(backup.hiddenCards).toEqual([{ deckId: "deck", cardId: "002", hiddenAt: expect.any(Number) }]);

    globalThis.indexedDB = new IDBFactory();
    resetDbForTest();
    const result = await importBackup(backup);
    expect(result.notesImported).toBe(1);
    expect(result.hiddenImported).toBe(1);
    expect((await readCardNotes("deck"))[0].text).toBe("語呂合わせ: いい国つくろう");
    expect((await readHiddenCards("deck")).map((row) => row.cardId)).toEqual(["002"]);
  });

  it("メモは updatedAt が新しい方を残す", async () => {
    await saveCardNote("deck", "001", "こちらが新しい");
    const current = (await readCardNotes("deck"))[0];
    const older = { deckId: "deck", cardId: "001", text: "古いメモ", updatedAt: current.updatedAt - 1000 };
    const newer = { deckId: "deck", cardId: "001", text: "もっと新しい", updatedAt: current.updatedAt + 1000 };

    await importBackup({ schemaVersion: 1, exportedAt: 0, cardProgress: [], reviewLog: [], cardNotes: [older] });
    expect((await readCardNotes("deck"))[0].text).toBe("こちらが新しい");

    await importBackup({ schemaVersion: 1, exportedAt: 0, cardProgress: [], reviewLog: [], cardNotes: [newer] });
    expect((await readCardNotes("deck"))[0].text).toBe("もっと新しい");
  });

  it("cardNotes / hiddenCards が無い古いバックアップも読める", async () => {
    const result = await importBackup({ schemaVersion: 1, exportedAt: 0, cardProgress: [makeRecord("001", 100)], reviewLog: [] });
    expect(result).toEqual({ progressImported: 1, progressSkipped: 0, logsImported: 0, notesImported: 0, hiddenImported: 0 });
  });

  it("壊れた cardNotes / hiddenCards は取り込まない", () => {
    expect(() =>
      validateBackup({ schemaVersion: 1, cardProgress: [], reviewLog: [], cardNotes: [{ deckId: "d", cardId: "c", text: 1 }] }),
    ).toThrow("text");
    expect(() =>
      validateBackup({ schemaVersion: 1, cardProgress: [], reviewLog: [], hiddenCards: [{ deckId: "", cardId: "c", hiddenAt: 1 }] }),
    ).toThrow("deckId");
    expect(() => validateBackup({ schemaVersion: 1, cardProgress: [], reviewLog: [], cardNotes: {} })).toThrow("配列");
  });
});

describe("saveCardNote / setCardHidden", () => {
  it("空のメモは保存せず削除する", async () => {
    await saveCardNote("deck", "001", "書いた");
    expect(await readCardNotes("deck")).toHaveLength(1);
    await saveCardNote("deck", "001", "   ");
    expect(await readCardNotes("deck")).toHaveLength(0);
  });

  it("非表示は戻せる", async () => {
    await setCardHidden("deck", "001", true);
    expect(await readHiddenCards("deck")).toHaveLength(1);
    await setCardHidden("deck", "001", false);
    expect(await readHiddenCards("deck")).toHaveLength(0);
  });
});
