import { createEmptyCard, fsrs, type Card, type Grade } from "ts-fsrs";
import type { Deck, DeckCard } from "./deck";
import type { ProgressDTO, ProgressRecord, RatingThresholds, ReviewRating } from "./types";

// ts-fsrs の型・オブジェクトはこのファイルの外へ出さない。
// 永続化は ProgressDTO（epoch ミリ秒・formatVersion 付き）のみを使う。

const scheduler = fsrs();

/** 1日に出す新規カードの既定枚数。設定画面で変更できる */
export const NEW_CARDS_PER_DAY = 10;

/** 設定で選べる1日の新規枚数（0 は無制限） */
export const NEW_CARDS_PER_DAY_OPTIONS = [10, 20, 50, 100, 0] as const;

const TOKYO_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 「今日」の判定に使う日付キー（Asia/Tokyo 固定の YYYY-MM-DD） */
export function dayKey(date: Date): string {
  return TOKYO_DAY_FORMATTER.format(date);
}

function toDTO(card: Card): ProgressDTO {
  return {
    formatVersion: 1,
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    lastReview: card.last_review ? card.last_review.getTime() : null,
  };
}

function fromDTO(dto: ProgressDTO): Card {
  return {
    due: new Date(dto.due),
    stability: dto.stability,
    difficulty: dto.difficulty,
    elapsed_days: dto.elapsedDays,
    scheduled_days: dto.scheduledDays,
    learning_steps: dto.learningSteps,
    reps: dto.reps,
    lapses: dto.lapses,
    state: dto.state,
    last_review: dto.lastReview === null ? undefined : new Date(dto.lastReview),
  };
}

/** 評価を適用して次の進捗を返す。progress が null なら新規カードとして扱う */
export function rate(progress: ProgressDTO | null, rating: ReviewRating, now: Date): ProgressDTO {
  const card = progress ? fromDTO(progress) : createEmptyCard(now);
  const next = scheduler.next(card, now, rating as Grade);
  return toDTO(next.card);
}

/** 評価ボタンに表示する「次回出題までの目安」を4評価ぶん返す */
export function previewIntervals(progress: ProgressDTO | null, now: Date): Record<ReviewRating, string> {
  const card = progress ? fromDTO(progress) : createEmptyCard(now);
  const preview = scheduler.repeat(card, now);
  const result = {} as Record<ReviewRating, string>;
  for (const rating of [1, 2, 3, 4] as const) {
    result[rating] = formatInterval(preview[rating].card.due.getTime() - now.getTime());
  }
  return result;
}

/**
 * 既定の振り分け境界（秒）。実際に使って調整する前提の仮置きで、設定画面から変更できる。
 * 問題が出てから答えを表示してスワイプするまでを測るので、答え表示起点より長めに取る。
 */
export const DEFAULT_RATING_THRESHOLDS: RatingThresholds = { easy: 5, good: 10, hard: 20 };

/**
 * 問題が表示されてからスワイプするまでの経過時間を4評価へ振り分ける。
 * 即答＝簡単、迷うほど評価が下がり、hard 以上かかったら「もう一度」。
 */
export function ratingFromElapsed(elapsedMs: number, thresholds: RatingThresholds): ReviewRating {
  const seconds = Math.max(0, elapsedMs) / 1000;
  if (seconds < thresholds.easy) return 4;
  if (seconds < thresholds.good) return 3;
  if (seconds < thresholds.hard) return 2;
  return 1;
}

/** 境界が空・0以下・逆順でも破綻しないように整える（設定画面の入力を通す用） */
export function normalizeRatingThresholds(value: Partial<RatingThresholds> | null | undefined): RatingThresholds {
  const pick = (input: unknown, fallback: number) =>
    typeof input === "number" && Number.isFinite(input) && input > 0 ? Math.min(600, input) : fallback;
  const easy = pick(value?.easy, DEFAULT_RATING_THRESHOLDS.easy);
  const good = Math.max(pick(value?.good, DEFAULT_RATING_THRESHOLDS.good), easy);
  const hard = Math.max(pick(value?.hard, DEFAULT_RATING_THRESHOLDS.hard), good);
  return { easy, good, hard };
}

/** ミリ秒を「7日」「3か月」のような目安表記にする */
export function formatInterval(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}分`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}時間`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}日`;
  const months = days / 30.44;
  if (months < 12) return `${Math.round(months)}か月`;
  return `${(days / 365.25).toFixed(1)}年`;
}

/** インポートした進捗データの構造検証。破損データは例外にする */
export function validateProgressDTO(value: unknown): ProgressDTO {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("進捗がオブジェクトではありません");
  }
  const dto = value as Record<string, unknown>;
  if (dto.formatVersion !== 1) {
    throw new Error(`未対応の進捗 formatVersion です: ${String(dto.formatVersion)}`);
  }
  const numberFields = ["due", "stability", "difficulty", "elapsedDays", "scheduledDays", "learningSteps", "reps", "lapses", "state"] as const;
  for (const field of numberFields) {
    if (typeof dto[field] !== "number" || !Number.isFinite(dto[field])) {
      throw new Error(`進捗の ${field} が数値ではありません`);
    }
  }
  if (dto.lastReview !== null && (typeof dto.lastReview !== "number" || !Number.isFinite(dto.lastReview))) {
    throw new Error("進捗の lastReview が不正です");
  }
  if (typeof dto.state !== "number" || dto.state < 0 || dto.state > 3) {
    throw new Error("進捗の state が不正です");
  }
  return dto as unknown as ProgressDTO;
}

/** フェーズ（FSRS の reps）は10を満点として扱う */
export const PHASE_FULL = 10;

/**
 * デッキ全体の達成率（%）。全カードのフェーズ合計 ÷ (枚数 × 10)。
 * 1セッションの出来ではなく、そのデッキがどこまで積み上がったかを表す。
 */
export function achievementPercent(phases: number[], cardCount: number): number {
  if (cardCount <= 0) return 0;
  const sum = phases.reduce((total, phase) => total + Math.min(Math.max(0, phase), PHASE_FULL), 0);
  return Math.min(100, (sum / (cardCount * PHASE_FULL)) * 100);
}

/** Fisher-Yates で並びを崩した新しい配列を返す（元の配列は変更しない） */
export function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

export interface StudyQueue {
  /** 期限切れカード（due 昇順） */
  due: DeckCard[];
  /** 今日出題できる新規カード（デッキ順） */
  fresh: DeckCard[];
  /** 上限で今日は出せない新規カードの残数 */
  freshHeldBack: number;
}

/**
 * 出題キューを組み立てる。
 * デッキのカードを走査して進捗をルックアップする方向で構築するため、
 * 削除済みカードの孤児進捗は自然に無視される。
 */
export function buildStudyQueue(
  deck: Deck,
  progressRecords: ProgressRecord[],
  now: Date,
  newCardsPerDay: number = NEW_CARDS_PER_DAY,
): StudyQueue {
  const progressByCard = new Map(progressRecords.map((record) => [record.cardId, record]));
  const today = dayKey(now);
  const introducedToday = progressRecords.filter((record) => record.introducedDayKey === today).length;
  // 0 は無制限。数万問のデッキを早押しで回すときに使う
  const freshBudget = newCardsPerDay === 0 ? Number.POSITIVE_INFINITY : Math.max(0, newCardsPerDay - introducedToday);

  const due: { card: DeckCard; dueAt: number }[] = [];
  const fresh: DeckCard[] = [];
  let freshTotal = 0;
  for (const card of deck.cards) {
    const record = progressByCard.get(card.id);
    if (!record) {
      freshTotal += 1;
      if (fresh.length < freshBudget) fresh.push(card);
      continue;
    }
    if (record.progress.due <= now.getTime()) {
      due.push({ card, dueAt: record.progress.due });
    }
  }
  due.sort((left, right) => left.dueAt - right.dueAt);
  return {
    due: due.map((entry) => entry.card),
    fresh,
    freshHeldBack: freshTotal - fresh.length,
  };
}
