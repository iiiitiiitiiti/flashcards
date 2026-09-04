/**
 * 統計画面の集計。IndexedDB から読んだ配列を受け取るだけの純関数に閉じ込める。
 * 日付の区切りは学習キューと同じ Asia/Tokyo（`dayKey`）に揃える。
 */
import type { Deck } from "./deck";
import { dayKey, FSRS_STATE_REVIEW, isWeakCard, retentionPercent } from "./srs";
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

// ---- 日別の推移 ----

export interface DayTally {
  /** めくった枚数（評価した回数） */
  reviewed: number;
  /** 「もう一度」以外を押した回数 */
  correct: number;
}

/**
 * ログを日付キーごとに1回だけ数える。`dayKey`（Intl）は1件ごとに重いので、
 * 月を送るたびにログ全件を走査せず、この索引から O(日数) で組む。
 */
export function tallyByDay(logs: ReviewLogEntry[]): Map<string, DayTally> {
  const tally = new Map<string, DayTally>();
  for (const log of logs) {
    const key = dayKey(new Date(log.reviewedAt));
    const entry = tally.get(key) ?? { reviewed: 0, correct: 0 };
    entry.reviewed += 1;
    if (log.rating !== 1) entry.correct += 1;
    tally.set(key, entry);
  }
  return tally;
}

export interface TrendDay extends DayTally {
  key: string;
  day: number;
}

/** その月の日ごとのめくった枚数と正解数。日数ぶん（0 の日も）返す */
export function monthlyTrend(tally: Map<string, DayTally>, year: number, month: number): TrendDay[] {
  const days: TrendDay[] = [];
  for (const cell of buildMonthCells(year, month)) {
    if (cell.key === null || cell.day === null) continue;
    const entry = tally.get(cell.key);
    days.push({ key: cell.key, day: cell.day, reviewed: entry?.reviewed ?? 0, correct: entry?.correct ?? 0 });
  }
  return days;
}

export interface TrendSummary {
  reviewed: number;
  correct: number;
  /** 正答率（%、四捨五入）。1枚もめくっていなければ null */
  percent: number | null;
}

export function summarizeTrend(days: DayTally[]): TrendSummary {
  let reviewed = 0;
  let correct = 0;
  for (const day of days) {
    reviewed += day.reviewed;
    correct += day.correct;
  }
  return { reviewed, correct, percent: reviewed === 0 ? null : Math.round((correct / reviewed) * 100) };
}

// ---- 復習予定 ----

/** デッキ id → 出題対象のカード id（非表示を除く）。消えたデッキ・消えたカード・非表示カードの進捗を数えないための索引 */
export type VisibleCardIndex = Map<string, Set<string>>;

export function buildVisibleCardIndex(decks: Deck[]): VisibleCardIndex {
  return new Map(decks.map((deck) => [deck.id, new Set(deck.cards.map((card) => card.id))]));
}

export interface ForecastDay {
  key: string;
  /** その日に期限が来る枚数。先頭（今日）には期限切れも積む */
  count: number;
}

export interface Forecast {
  /** 今日を含めた `days` 日ぶん */
  days: ForecastDay[];
  /** いま復習できる枚数（`due <= now`）。ホームの「復習」と同じ判定 */
  dueNow: number;
}

/** `Date` が扱える範囲（±8.64e15 ms）。壊れた due で Intl が例外を投げないよう外す */
const MAX_TIME = 8.64e15;
const DAY_MS = 86_400_000;

/**
 * 今日から `days` 日ぶんの復習予定。日付は Asia/Tokyo（`dayKey`）で区切り、
 * 期限切れ（今日より前）は今日に積む。`days` 日より先と、索引に無いカードは数えない。
 * 今日の棒は「今日中に期限が来るぶん」で、いま復習できる枚数（`dueNow`）とは別に返す
 */
export function dueForecast(records: ProgressRecord[], index: VisibleCardIndex, now: Date, days: number): Forecast {
  const keys: string[] = [];
  for (let offset = 0; offset < days; offset += 1) keys.push(dayKey(new Date(now.getTime() + offset * DAY_MS)));
  const position = new Map(keys.map((key, offset) => [key, offset]));
  const counts = new Array<number>(days).fill(0);
  let dueNow = 0;
  const today = keys[0];
  for (const record of records) {
    if (!index.get(record.deckId)?.has(record.cardId)) continue;
    const due = record.progress.due;
    if (!Number.isFinite(due) || Math.abs(due) > MAX_TIME) continue;
    if (due <= now.getTime()) dueNow += 1;
    const key = dayKey(new Date(due));
    if (key < today) {
      counts[0] += 1;
      continue;
    }
    const offset = position.get(key);
    if (offset !== undefined) counts[offset] += 1;
  }
  return { days: keys.map((key, offset) => ({ key, count: counts[offset] })), dueNow };
}

// ---- デッキ別 ----

export interface DeckBreakdown {
  deckId: string;
  name: string;
  /** 出題対象の枚数（非表示を除く。ホームのデッキ一覧の枚数とは違うことがある） */
  cardCount: number;
  /** 定着率（ホームのドーナツと同じ計算） */
  retentionPercent: number;
  /** いま復習できる枚数（`due <= now`） */
  due: number;
  /** 苦手カード（`isWeakCard`） */
  weak: number;
}

/**
 * デッキごとの内訳。`decks` は非表示を除いたもの（`visibleDeck`）を渡す。
 * 並びは復習の多い順 → 苦手の多い順 → 名前順（やるべき所が上に来る）
 */
export function summarizeDecks(decks: Deck[], records: ProgressRecord[], now: Date): DeckBreakdown[] {
  // デッキごとに filter すると デッキ数 × 進捗数 になるので、1回で配る
  const byDeck = new Map<string, ProgressRecord[]>();
  for (const record of records) {
    const list = byDeck.get(record.deckId);
    if (list) list.push(record);
    else byDeck.set(record.deckId, [record]);
  }
  const rows = decks.map((deck) => {
    const cardIds = new Set(deck.cards.map((card) => card.id));
    let due = 0;
    let weak = 0;
    const touched: { reps: number; state: number }[] = [];
    for (const record of byDeck.get(deck.id) ?? []) {
      if (!cardIds.has(record.cardId)) continue;
      touched.push(record.progress);
      if (record.progress.due <= now.getTime()) due += 1;
      if (isWeakCard(record.progress)) weak += 1;
    }
    return {
      deckId: deck.id,
      name: deck.name,
      cardCount: deck.cards.length,
      retentionPercent: retentionPercent(touched, deck.cards.length),
      due,
      weak,
    };
  });
  rows.sort((left, right) => right.due - left.due || right.weak - left.weak || left.name.localeCompare(right.name, "ja"));
  return rows;
}
