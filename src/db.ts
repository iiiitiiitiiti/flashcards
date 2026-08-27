import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { CardNote, DeckCacheEntry, HiddenCard, ImportDraft, ProgressRecord, ReviewLogEntry } from "./types";

interface FlashcardsDB extends DBSchema {
  cardProgress: {
    key: [string, string];
    value: ProgressRecord;
    indexes: { byDeck: string };
  };
  reviewLog: {
    key: string;
    value: ReviewLogEntry;
    indexes: { byReviewedAt: number };
  };
  deckCache: {
    key: string;
    value: DeckCacheEntry;
  };
  importDrafts: {
    key: string;
    value: ImportDraft;
  };
  cardNotes: {
    key: [string, string];
    value: CardNote;
    indexes: { byDeck: string };
  };
  hiddenCards: {
    key: [string, string];
    value: HiddenCard;
    indexes: { byDeck: string };
  };
}

const DB_NAME = "flashcards-db";
const DB_VERSION = 3;
const DAY_MS = 86_400_000;

/** 評価ログの保持期間（日）。学習の予定には使っていないので、古いものは消してよい */
export const REVIEW_LOG_RETENTION_DAYS = 400;
/** 保持期間内でも、これを超えるぶんは古い順に消す */
export const REVIEW_LOG_MAX_ENTRIES = 20_000;

let dbPromise: Promise<IDBPDatabase<FlashcardsDB>> | undefined;

export function getDb(): Promise<IDBPDatabase<FlashcardsDB>> {
  dbPromise ??= openDB<FlashcardsDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const progress = db.createObjectStore("cardProgress", { keyPath: ["deckId", "cardId"] });
        progress.createIndex("byDeck", "deckId");
        db.createObjectStore("reviewLog", { keyPath: "reviewId" });
        db.createObjectStore("deckCache", { keyPath: "deckId" });
        db.createObjectStore("importDrafts", { keyPath: "draftId" });
      }
      if (oldVersion < 2) {
        // 古いログを日時で引いて消せるようにする（v1 で作った DB にも後付けする）
        tx.objectStore("reviewLog").createIndex("byReviewedAt", "reviewedAt");
      }
      if (oldVersion < 3) {
        // 自分で書いたメモと、出題から外したカード。どちらもデッキ単位で引く
        db.createObjectStore("cardNotes", { keyPath: ["deckId", "cardId"] }).createIndex("byDeck", "deckId");
        db.createObjectStore("hiddenCards", { keyPath: ["deckId", "cardId"] }).createIndex("byDeck", "deckId");
      }
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

/** デッキの学習進捗をすべて削除する（reviewLog は残す）。削除件数を返す */
export async function deleteProgressByDeck(deckId: string): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("cardProgress", "readwrite");
  const keys = await tx.store.index("byDeck").getAllKeys(deckId);
  for (const key of keys) {
    await tx.store.delete(key);
  }
  await tx.done;
  return keys.length;
}

export async function deleteProgressByKeys(keys: [string, string][]): Promise<void> {
  const db = await getDb();
  const tx = db.transaction("cardProgress", "readwrite");
  for (const key of keys) {
    await tx.store.delete(key);
  }
  await tx.done;
}

/**
 * 古い評価ログを間引く。ログは出題の判断には使っておらず、バックアップに残す履歴なので消してよい。
 * 保持期間を過ぎたものと、それでも上限を超えるぶんを古い順に消し、削除件数を返す。
 */
export async function pruneReviewLog(
  now = Date.now(),
  retentionDays = REVIEW_LOG_RETENTION_DAYS,
  maxEntries = REVIEW_LOG_MAX_ENTRIES,
): Promise<number> {
  const db = await getDb();
  const tx = db.transaction("reviewLog", "readwrite");
  const cutoff = now - retentionDays * DAY_MS;
  let overflow = Math.max(0, (await tx.store.count()) - maxEntries);
  let deleted = 0;
  // 古い順に走査し、消す理由が無くなった時点で止める
  let cursor = await tx.store.index("byReviewedAt").openCursor();
  while (cursor) {
    if (overflow === 0 && cursor.value.reviewedAt >= cutoff) break;
    if (overflow > 0) overflow -= 1;
    await cursor.delete();
    deleted += 1;
    cursor = await cursor.continue();
  }
  await tx.done;
  return deleted;
}

export async function readCardNotes(deckId: string): Promise<CardNote[]> {
  const db = await getDb();
  return db.getAllFromIndex("cardNotes", "byDeck", deckId);
}

export async function readAllCardNotes(): Promise<CardNote[]> {
  const db = await getDb();
  return db.getAll("cardNotes");
}

/** メモを書き込む。空文字なら削除する（空のメモを持ち歩かない） */
export async function saveCardNote(deckId: string, cardId: string, text: string): Promise<void> {
  const db = await getDb();
  const trimmed = text.trim();
  if (trimmed === "") {
    await db.delete("cardNotes", [deckId, cardId]);
    return;
  }
  await db.put("cardNotes", { deckId, cardId, text: trimmed, updatedAt: Date.now() });
}

export async function readHiddenCards(deckId: string): Promise<HiddenCard[]> {
  const db = await getDb();
  return db.getAllFromIndex("hiddenCards", "byDeck", deckId);
}

export async function readAllHiddenCards(): Promise<HiddenCard[]> {
  const db = await getDb();
  return db.getAll("hiddenCards");
}

/** 出題対象から外す / 戻す。学習進捗は消さないので、戻せば続きから再開できる */
export async function setCardHidden(deckId: string, cardId: string, hidden: boolean): Promise<void> {
  const db = await getDb();
  if (hidden) await db.put("hiddenCards", { deckId, cardId, hiddenAt: Date.now() });
  else await db.delete("hiddenCards", [deckId, cardId]);
}

export async function readAllReviewLog(): Promise<ReviewLogEntry[]> {
  const db = await getDb();
  return db.getAll("reviewLog");
}

/**
 * 直前の評価を取り消す。進捗を評価前の状態へ戻し、その評価のログを消す。
 * `previous` が無いカード（その評価が初回だった）は進捗ごと削除する。
 * 進捗とログがちぐはぐにならないよう、同一トランザクションで行う。
 */
export async function undoReview(
  deckId: string,
  cardId: string,
  previous: ProgressRecord | undefined,
  reviewId: string,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(["cardProgress", "reviewLog"], "readwrite");
  const requests: Promise<unknown>[] = [];
  try {
    // 2つの要求を await を挟まずに出す。間で待つと、片方だけ済んだところで
    // トランザクションが確定してしまい、進捗だけ戻ってログが残る
    const progress = tx.objectStore("cardProgress");
    requests.push(previous ? progress.put(previous) : progress.delete([deckId, cardId]));
    requests.push(tx.objectStore("reviewLog").delete(reviewId));
    await Promise.all(requests);
    await tx.done;
  } catch (error) {
    // 片方だけ適用された状態を残さない
    try {
      tx.abort();
    } catch {
      // すでに中断・確定済みなら何もしない
    }
    // 中断で残りの要求が AbortError になっても、未処理の rejection にしない
    for (const request of requests) void request.catch(() => undefined);
    await tx.done.catch(() => undefined);
    throw error;
  }
}
