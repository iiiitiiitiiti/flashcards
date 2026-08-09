import { createEmptyCard, fsrs, type Card, type Grade } from "ts-fsrs";
import type { Deck, DeckCard } from "./deck";
import type { ProgressDTO, ProgressRecord, ReviewRating } from "./types";

// ts-fsrs の型・オブジェクトはこのファイルの外へ出さない。
// 永続化は ProgressDTO（epoch ミリ秒・formatVersion 付き）のみを使う。

const scheduler = fsrs();

export const NEW_CARDS_PER_DAY = 10;

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
export function buildStudyQueue(deck: Deck, progressRecords: ProgressRecord[], now: Date): StudyQueue {
  const progressByCard = new Map(progressRecords.map((record) => [record.cardId, record]));
  const today = dayKey(now);
  const introducedToday = progressRecords.filter((record) => record.introducedDayKey === today).length;
  const freshBudget = Math.max(0, NEW_CARDS_PER_DAY - introducedToday);

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
