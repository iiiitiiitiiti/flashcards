import { getDb } from "./db";
import { validateProgressDTO } from "./srs";
import type { ProgressRecord, ReviewLogEntry, ReviewRating } from "./types";

export interface BackupDocument {
  schemaVersion: 1;
  exportedAt: number;
  cardProgress: ProgressRecord[];
  reviewLog: ReviewLogEntry[];
}

export interface ImportResult {
  progressImported: number;
  progressSkipped: number;
  logsImported: number;
}

export async function exportBackup(): Promise<BackupDocument> {
  const db = await getDb();
  return {
    schemaVersion: 1,
    exportedAt: Date.now(),
    cardProgress: await db.getAll("cardProgress"),
    reviewLog: await db.getAll("reviewLog"),
  };
}

/** バックアップ全体を検証する。1件でも不正があれば例外（何も書き込まない） */
export function validateBackup(value: unknown): BackupDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("バックアップがオブジェクトではありません");
  }
  const document = value as Record<string, unknown>;
  if (document.schemaVersion !== 1) {
    throw new Error(`未対応のバックアップ schemaVersion です: ${String(document.schemaVersion)}`);
  }
  if (!Array.isArray(document.cardProgress) || !Array.isArray(document.reviewLog)) {
    throw new Error("cardProgress / reviewLog が配列ではありません");
  }
  document.cardProgress.forEach((entry, index) => validateProgressRecord(entry, index));
  document.reviewLog.forEach((entry, index) => validateReviewLogEntry(entry, index));
  return document as unknown as BackupDocument;
}

function validateProgressRecord(value: unknown, index: number): asserts value is ProgressRecord {
  const label = `cardProgress[${index}]`;
  if (!value || typeof value !== "object") throw new Error(`${label} がオブジェクトではありません`);
  const record = value as Record<string, unknown>;
  if (typeof record.deckId !== "string" || record.deckId === "") throw new Error(`${label}: deckId が不正です`);
  if (typeof record.cardId !== "string" || record.cardId === "") throw new Error(`${label}: cardId が不正です`);
  if (typeof record.introducedDayKey !== "string") throw new Error(`${label}: introducedDayKey が不正です`);
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)) throw new Error(`${label}: updatedAt が不正です`);
  try {
    validateProgressDTO(record.progress);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : "進捗が不正です"}`);
  }
}

function validateReviewLogEntry(value: unknown, index: number): asserts value is ReviewLogEntry {
  const label = `reviewLog[${index}]`;
  if (!value || typeof value !== "object") throw new Error(`${label} がオブジェクトではありません`);
  const entry = value as Record<string, unknown>;
  if (typeof entry.reviewId !== "string" || entry.reviewId === "") throw new Error(`${label}: reviewId が不正です`);
  if (typeof entry.deckId !== "string" || typeof entry.cardId !== "string") throw new Error(`${label}: deckId / cardId が不正です`);
  if (![1, 2, 3, 4].includes(entry.rating as ReviewRating)) throw new Error(`${label}: rating が不正です`);
  if (typeof entry.reviewedAt !== "number" || !Number.isFinite(entry.reviewedAt)) throw new Error(`${label}: reviewedAt が不正です`);
}

/**
 * バックアップをマージ取り込みする。
 * - 進捗はカード単位で updatedAt が新しい方を採用（同時刻は既存を維持）
 * - reviewLog は reviewId で重複を除いて追記
 */
export async function importBackup(value: unknown): Promise<ImportResult> {
  const backup = validateBackup(value);
  const db = await getDb();
  const tx = db.transaction(["cardProgress", "reviewLog"], "readwrite");
  const progressStore = tx.objectStore("cardProgress");
  const logStore = tx.objectStore("reviewLog");

  let progressImported = 0;
  let progressSkipped = 0;
  for (const record of backup.cardProgress) {
    const existing = await progressStore.get([record.deckId, record.cardId]);
    if (existing && existing.updatedAt >= record.updatedAt) {
      progressSkipped += 1;
      continue;
    }
    await progressStore.put(record);
    progressImported += 1;
  }

  let logsImported = 0;
  for (const entry of backup.reviewLog) {
    const existingKey = await logStore.getKey(entry.reviewId);
    if (existingKey !== undefined) continue;
    await logStore.put(entry);
    logsImported += 1;
  }

  await tx.done;
  return { progressImported, progressSkipped, logsImported };
}
