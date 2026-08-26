import type { Deck } from "./deck";

/** ts-fsrs の Card をシリアライズ安全にした独自 DTO。日時は epoch ミリ秒 */
export interface ProgressDTO {
  formatVersion: 1;
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview: number | null;
}

export interface ProgressRecord {
  deckId: string;
  cardId: string;
  progress: ProgressDTO;
  /** このカードを新規として初めて出題した日（Asia/Tokyo の YYYY-MM-DD） */
  introducedDayKey: string;
  updatedAt: number;
}

export type ReviewRating = 1 | 2 | 3 | 4;

/** 答えを表示してからスワイプするまでの秒数を4評価へ振り分ける境界（秒・昇順） */
export interface RatingThresholds {
  /** これ未満なら「簡単」 */
  easy: number;
  /** これ未満なら「普通」 */
  good: number;
  /** これ未満なら「難しい」。以上は「もう一度」 */
  hard: number;
}

export type StudyMode = "normal" | "buzzer";

/** 出題順。sequential は復習（期限順）→新規（デッキ順）、random はセッション全体をシャッフル */
export type StudyOrder = "sequential" | "random";

export interface ReviewLogEntry {
  reviewId: string;
  deckId: string;
  cardId: string;
  rating: ReviewRating;
  reviewedAt: number;
}

export interface DeckCacheEntry {
  deckId: string;
  deck: Deck;
  commitSha: string;
  fetchedAt: number;
}

export interface DeckSnapshot {
  decks: DeckCacheEntry[];
  /** 検証に失敗して旧キャッシュへフォールバックしたデッキ等の警告 */
  warnings: string[];
  /** ネットワーク取得に成功した時刻。キャッシュ表示時は最古の fetchedAt */
  fetchedAt: number | null;
  offline: boolean;
}

export interface ImportDraft {
  draftId: string;
  deckId: string;
  cards: { id: string; front: string; back: string; note?: string; tags?: string[] }[];
  createdAt: number;
}
