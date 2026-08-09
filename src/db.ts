import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { DeckCacheEntry, ImportDraft, ProgressRecord, ReviewLogEntry } from "./types";

interface FlashcardsDB extends DBSchema {
  cardProgress: {
    key: [string, string];
    value: ProgressRecord;
    indexes: { byDeck: string };
  };
  reviewLog: {
    key: string;
    value: ReviewLogEntry;
  };
  deckCache: {
    key: string;
    value: DeckCacheEntry;
  };
  importDrafts: {
    key: string;
    value: ImportDraft;
  };
}

const DB_NAME = "flashcards-db";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<FlashcardsDB>> | undefined;

export function getDb(): Promise<IDBPDatabase<FlashcardsDB>> {
  dbPromise ??= openDB<FlashcardsDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const progress = db.createObjectStore("cardProgress", { keyPath: ["deckId", "cardId"] });
      progress.createIndex("byDeck", "deckId");
      db.createObjectStore("reviewLog", { keyPath: "reviewId" });
      db.createObjectStore("deckCache", { keyPath: "deckId" });
      db.createObjectStore("importDrafts", { keyPath: "draftId" });
    },
  });
  return dbPromise;
}

/** テスト用: 接続を閉じて次回 getDb で開き直す */
export function resetDbForTest(): void {
  dbPromise = undefined;
}

export async function readDeckCache(): Promise<DeckCacheEntry[]> {
  const db = await getDb();
  return db.getAll("deckCache");
}

/**
 * 新スナップショットを1トランザクションで公開する。
 * retainDeckIds のデッキは新データが不正だったため、既存キャッシュを残す。
 */
export async function publishDeckCache(entries: DeckCacheEntry[], retainDeckIds: string[]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("deckCache", "readwrite");
  const keep = new Set([...entries.map((entry) => entry.deckId), ...retainDeckIds]);
  for (const existingKey of await tx.store.getAllKeys()) {
    if (!keep.has(existingKey)) await tx.store.delete(existingKey);
  }
  for (const entry of entries) {
    await tx.store.put(entry);
  }
  await tx.done;
}

export async function readProgress(deckId: string): Promise<ProgressRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex("cardProgress", "byDeck", deckId);
}

export async function readAllProgress(): Promise<ProgressRecord[]> {
  const db = await getDb();
  return db.getAll("cardProgress");
}

/** 評価の保存。進捗とログを同一トランザクションで書き込む */
export async function saveReview(record: ProgressRecord, log: ReviewLogEntry): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["cardProgress", "reviewLog"], "readwrite");
  await tx.objectStore("cardProgress").put(record);
  await tx.objectStore("reviewLog").put(log);
  await tx.done;
}

export async function deleteProgress(deckId: string, cardId: string): Promise<void> {
  const db = await getDb();
  await db.delete("cardProgress", [deckId, cardId]);
}

/** 書き戻し成功直後に、返ってきた最新デッキでキャッシュを即時更新する */
export async function upsertDeckCacheEntry(entry: DeckCacheEntry): Promise<void> {
  const db = await getDb();
  await db.put("deckCache", entry);
}

export async function saveImportDraft(draft: ImportDraft): Promise<void> {
  const db = await getDb();
  await db.put("importDrafts", draft);
}

export async function readImportDraft(deckId: string): Promise<ImportDraft | undefined> {
  const db = await getDb();
  const drafts = await db.getAll("importDrafts");
  return drafts.find((draft) => draft.deckId === deckId);
}

export async function deleteImportDraft(draftId: string): Promise<void> {
  const db = await getDb();
  await db.delete("importDrafts", draftId);
}

export async function deleteProgressByKeys(keys: [string, string][]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("cardProgress", "readwrite");
  for (const key of keys) {
    await tx.store.delete(key);
  }
  await tx.done;
}
