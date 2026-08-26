/**
 * 統計画面の集計。IndexedDB から読んだ配列を受け取るだけの純関数に閉じ込める。
 * 日付の区切りは学習キューと同じ Asia/Tokyo（`dayKey`）に揃える。
 */
import { dayKey, FSRS_STATE_REVIEW } from "./srs";
import type { ProgressRecord, ReviewLogEntry } from "./types";

export interface DailyStats {
  /** プレイ時間（分）。elapsedMs を持たない古いログは 0 として扱う */
  playMinutes: number;
  /** めくったカード（評価した回数。同じカードを2回めくれば2） */
  reviewedCards: number;
  /** その日はじめて出したカード */
  newCards: number;
}

export interface TotalStats extends DailyStats {
  /** 定着（state=Review）したカード */
  memorizedCards: number;
  /** 一度でも学習したデッキ */
  playedDecks: number;
  /** 全カードが定着したデッキ */
  memorizedDecks: number;
}

/** 秒未満まで出しても読めないので分に丸める。1分未満でも学習していれば 1 にする */
function toMinutes(totalMs: number): number {
  if (totalMs <= 0) return 0;
  return Math.max(1, Math.round(totalMs / 60000));
}

export function summarizeDay(logs: ReviewLogEntry[], records: ProgressRecord[], day: string): DailyStats {
  let elapsed = 0;
  let reviewed = 0;
  for (const log of logs) {
    if (dayKey(new Date(log.reviewedAt)) !== day) continue;
    reviewed += 1;
    elapsed += log.elapsedMs ?? 0;
  }
  return {
    playMinutes: toMinutes(elapsed),
    reviewedCards: reviewed,
    newCards: records.filter((record) => record.introducedDayKey === day).length,
  };
}

/**
 * 全期間の集計。`deckCardCounts` はデッキ id → 枚数で、
 * 「暗記済みデッキ」の判定にだけ使う（非表示のカードを除いた枚数を渡すこと）。
 */
export function summarizeTotal(
  logs: ReviewLogEntry[],
  records: ProgressRecord[],
  deckCardCounts: Map<string, number>,
): TotalStats {
  let elapsed = 0;
  const playedDecks = new Set<string>();
  for (const log of logs) {
    elapsed += log.elapsedMs ?? 0;
    playedDecks.add(log.deckId);
  }

  const memorizedByDeck = new Map<string, number>();
  let memorizedCards = 0;
  for (const record of records) {
    playedDecks.add(record.deckId);
    if (record.progress.state !== FSRS_STATE_REVIEW) continue;
    memorizedCards += 1;
    memorizedByDeck.set(record.deckId, (memorizedByDeck.get(record.deckId) ?? 0) + 1);
  }

  let memorizedDecks = 0;
  for (const [deckId, total] of deckCardCounts) {
    // 0枚のデッキを「暗記済み」にはしない
    if (total > 0 && (memorizedByDeck.get(deckId) ?? 0) >= total) memorizedDecks += 1;
  }

  return {
    playMinutes: toMinutes(elapsed),
    reviewedCards: logs.length,
    newCards: records.length,
    memorizedCards,
    playedDecks: playedDecks.size,
    memorizedDecks,
  };
}

/** カレンダーに点を打つ日。ログのある日を集める */
export function studiedDays(logs: ReviewLogEntry[]): Set<string> {
  const days = new Set<string>();
  for (const log of logs) days.add(dayKey(new Date(log.reviewedAt)));
  return days;
}

export interface MonthCell {
  /** その月の日。前後の月を埋める空きマスは null */
  day: number | null;
  /** `dayKey` と同じ書式（YYYY-MM-DD）。空きマスは null */
  key: string | null;
}

/**
 * 月カレンダーのマス目。日曜始まりの7列で、前後は空きマスで埋める。
 * `month` は 1〜12（JS の 0 始まりではない）。
 */
export function buildMonthCells(year: number, month: number): MonthCell[] {
  // 端末のタイムゾーンで曜日がずれないよう UTC で数える（日付キーは Asia/Tokyo 固定のため）
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: MonthCell[] = [];
  for (let blank = 0; blank < firstWeekday; blank += 1) cells.push({ day: null, key: null });
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({ day, key: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` });
  }
  // 最終週を7マスで埋める（行の高さを揃えるため）
  while (cells.length % 7 !== 0) cells.push({ day: null, key: null });
  return cells;
}

/** 前後の月へ動かす。12月の次は翌年1月、1月の前は前年12月 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const zeroBased = month - 1 + delta;
  return { year: year + Math.floor(zeroBased / 12), month: ((zeroBased % 12) + 12) % 12 + 1 };
}

/** その月が今日より先か（先の月へは進ませない） */
export function isFutureMonth(year: number, month: number, now: Date): boolean {
  return year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
}
