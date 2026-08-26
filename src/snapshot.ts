import { validateDeck } from "./deck";
import { publishDeckCache, readDeckCache } from "./db";
import { fetchDeckRaw, listDecks } from "./github";
import type { DeckCacheEntry, DeckSnapshot } from "./types";

function toSnapshot(entries: DeckCacheEntry[], warnings: string[], offline: boolean): DeckSnapshot {
  const sorted = [...entries].sort((left, right) => left.deck.name.localeCompare(right.deck.name, "ja"));
  const fetchedAt = sorted.length > 0 ? Math.min(...sorted.map((entry) => entry.fetchedAt)) : null;
  return { decks: sorted, warnings, fetchedAt, offline };
}

/**
 * デッキスナップショットを更新する。
 * - コミット SHA を1つに固定して全デッキを取得し、全件検証後に一括でキャッシュへ公開する
 * - キャッシュ済みで blob SHA が同じデッキは再取得しない（中身が変わったものだけ取る）
 * - ネットワーク不通・一覧取得失敗時は既存キャッシュを返す（offline: true）
 * - 個別デッキが不正だった場合はそのデッキだけ旧キャッシュを残し、警告を付ける
 */
export async function refreshSnapshot(token: string | null): Promise<DeckSnapshot> {
  const cached = await readDeckCache();
  let listing;
  try {
    listing = await listDecks(token);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "不明なエラー";
    return toSnapshot(cached, cached.length > 0 ? [] : [reason], true);
  }

  const cachedById = new Map(cached.map((entry) => [entry.deckId, entry]));
  const fetchedAt = Date.now();
  const entries: DeckCacheEntry[] = [];
  const retainDeckIds: string[] = [];
  const warnings: string[] = [];

  let results: PromiseSettledResult<DeckCacheEntry>[];
  try {
    results = await Promise.allSettled(
      listing.decks.map(async ({ deckId, blobSha }): Promise<DeckCacheEntry> => {
        // 中身が変わっていないデッキは取得しない（数MBのデッキで効く）。
        // blobSha を持たない旧キャッシュは一度だけ取り直す
        const known = cachedById.get(deckId);
        if (known?.blobSha !== undefined && known.blobSha === blobSha) {
          return { ...known, commitSha: listing.commitSha, fetchedAt };
        }
        const raw = await fetchDeckRaw(listing.commitSha, deckId);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new DeckInvalidError(deckId, "JSON として解釈できません");
        }
        let deck;
        try {
          deck = validateDeck(parsed, deckId);
        } catch (error) {
          throw new DeckInvalidError(deckId, error instanceof Error ? error.message : "不明なエラー");
        }
        return { deckId, deck, commitSha: listing.commitSha, blobSha, fetchedAt };
      }),
    );
  } catch {
    return toSnapshot(cached, [], true);
  }

  for (const [index, result] of results.entries()) {
    const deckId = listing.decks[index].deckId;
    if (result.status === "fulfilled") {
      entries.push(result.value);
      continue;
    }
    if (result.reason instanceof DeckInvalidError) {
      // 不正なデッキは旧キャッシュを保持して警告表示。他デッキの更新は続行する
      const fallback = cachedById.get(deckId);
      if (fallback) {
        retainDeckIds.push(deckId);
        warnings.push(`デッキ「${deckId}」は不正なため、前回取得分を表示しています: ${result.reason.reason}`);
      } else {
        warnings.push(`デッキ「${deckId}」を読み込めません: ${result.reason.reason}`);
      }
    } else {
      // ネットワーク起因の失敗が1件でもあれば、混在を避けて更新全体を中止する
      return toSnapshot(cached, [], true);
    }
  }

  await publishDeckCache(entries, retainDeckIds);
  const published = await readDeckCache();
  return toSnapshot(published, warnings, false);
}

/** キャッシュのみから読み込む（オフライン起動用） */
export async function loadCachedSnapshot(): Promise<DeckSnapshot> {
  const cached = await readDeckCache();
  return toSnapshot(cached, [], true);
}

class DeckInvalidError extends Error {
  public readonly deckId: string;
  public readonly reason: string;

  public constructor(deckId: string, reason: string) {
    super(`invalid deck ${deckId}: ${reason}`);
    this.deckId = deckId;
    this.reason = reason;
  }
}
