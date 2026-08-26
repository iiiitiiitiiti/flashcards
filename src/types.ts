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

/** 1日の新規カード上限をどの単位で数えるか。deck はデッキごと、all は全デッキ合計 */
export type NewCardsScope = "deck" | "all";

export interface ReviewLogEntry {
  reviewId: string;
  deckId: string;
  cardId: string;
  rating: ReviewRating;
  reviewedAt: number;
  /**
   * 問題が出てから評価するまでの時間。統計の「プレイ時間」に使う。
   * 2026-08-26 より前のログには無い（省略可）。放置ぶんを含めないよう上限で切ってある
   */
  elapsedMs?: number;
}

/** カードに自分で書いたメモ。デッキ JSON の note（出典側の補足）とは別物 */
export interface CardNote {
  deckId: string;
  cardId: string;
  text: string;
  updatedAt: number;
}

/** 出題から外したカード。時事ネタが古くなったときなどに使う */
export interface HiddenCard {
  deckId: string;
  cardId: string;
  hiddenAt: number;
}

export interface DeckCacheEntry {
  deckId: string;
  deck: Deck;
  commitSha: string;
  /** 取得元ファイルの blob SHA。旧キャッシュには無いので省略可 */
  blobSha?: string;
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
