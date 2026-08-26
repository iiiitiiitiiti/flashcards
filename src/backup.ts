import { getDb } from "./db";
import { validateProgressDTO } from "./srs";
import type { CardNote, HiddenCard, ProgressRecord, ReviewLogEntry, ReviewRating } from "./types";

export interface BackupDocument {
  schemaVersion: 1;
  exportedAt: number;
  cardProgress: ProgressRecord[];
  reviewLog: ReviewLogEntry[];
  /** 2026-08-26 以降に書き出したファイルにだけ入る（古いバックアップも読めるよう省略可） */
  cardNotes?: CardNote[];
  hiddenCards?: HiddenCard[];
}

export interface ImportResult {
  progressImported: number;
  progressSkipped: number;
  logsImported: number;
  notesImported: number;
  hiddenImported: number;
}

export interface BackupExport {
  blob: Blob;
  exportedAt: number;
  progressCount: number;
  logCount: number;
  noteCount: number;
}

/**
 * バックアップ JSON を組み立てる。全件を配列に読み出してから stringify すると、
 * 進捗3万件規模で「オブジェクト配列」と「その JSON 文字列」を同時に抱えることになる。
 * カーソルで1件ずつ書き出し、Blob の断片として渡してピークを下げる。
 */
export async function exportBackup(exportedAt = Date.now()): Promise<BackupExport> {
  const parts: string[] = [`{\n  "schemaVersion": 1,\n  "exportedAt": ${exportedAt},\n  "cardProgress": [`];
  const progressCount = await appendAll("cardProgress", parts);
  parts.push('],\n  "reviewLog": [');
  const logCount = await appendAll("reviewLog", parts);
  parts.push('],\n  "cardNotes": [');
  const noteCount = await appendAll("cardNotes", parts);
  parts.push('],\n  "hiddenCards": [');
  await appendAll("hiddenCards", parts);
  parts.push("]\n}\n");
  return { blob: new Blob(parts, { type: "application/json" }), exportedAt, progressCount, logCount, noteCount };
}

async function appendAll(storeName: "cardProgress" | "reviewLog" | "cardNotes" | "hiddenCards", parts: string[]): Promise<number> {
  const db = await getDb();
  let count = 0;
  let cursor = await db.transaction(storeName).store.openCursor();
  while (cursor) {
    parts.push(count === 0 ? "\n    " : ",\n    ");
    parts.push(JSON.stringify(cursor.value));
    count += 1;
    cursor = await cursor.continue();
  }
  if (count > 0) parts.push("\n  ");
  return count;
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
  // 古いバックアップには無い。あるなら中身も見る
  validateOptionalRows(document.cardNotes, "cardNotes", (row, label) => {
    if (typeof row.text !== "string") throw new Error(`${label}: text が不正です`);
  });
  validateOptionalRows(document.hiddenCards, "hiddenCards", (row, label) => {
    if (typeof row.hiddenAt !== "number" || !Number.isFinite(row.hiddenAt)) throw new Error(`${label}: hiddenAt が不正です`);
  });
  return document as unknown as BackupDocument;
}

/** cardNotes / hiddenCards の共通チェック。未指定（古いバックアップ）は素通りさせる */
function validateOptionalRows(
  value: unknown,
  field: string,
  check: (row: Record<string, unknown>, label: string) => void,
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${field} が配列ではありません`);
  value.forEach((entry, index) => {
    const label = `${field}[${index}]`;
    if (!entry || typeof entry !== "object") throw new Error(`${label} がオブジェクトではありません`);
    const row = entry as Record<string, unknown>;
    if (typeof row.deckId !== "string" || row.deckId === "") throw new Error(`${label}: deckId が不正です`);
    if (typeof row.cardId !== "string" || row.cardId === "") throw new Error(`${label}: cardId が不正です`);
    check(row, label);
  });
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
 * - メモは updatedAt が新しい方を採用、非表示は追記のみ（別端末での解除は持ち込まない）
 */
export async function importBackup(value: unknown): Promise<ImportResult> {
  const backup = validateBackup(value);
  const db = await getDb();
  const tx = db.transaction(["cardProgress", "reviewLog", "cardNotes", "hiddenCards"], "readwrite");
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

  // メモは updatedAt が新しい方を残す。非表示は「取り込んだ側も非表示にする」だけ（解除は持ち込まない）
  let notesImported = 0;
  const noteStore = tx.objectStore("cardNotes");
  for (const note of backup.cardNotes ?? []) {
    const existing = await noteStore.get([note.deckId, note.cardId]);
    if (existing && existing.updatedAt >= note.updatedAt) continue;
    await noteStore.put(note);
    notesImported += 1;
  }

  let hiddenImported = 0;
  const hiddenStore = tx.objectStore("hiddenCards");
  for (const row of backup.hiddenCards ?? []) {
    if ((await hiddenStore.getKey([row.deckId, row.cardId])) !== undefined) continue;
    await hiddenStore.put(row);
    hiddenImported += 1;
  }

  await tx.done;
  return { progressImported, progressSkipped, logsImported, notesImported, hiddenImported };
}
