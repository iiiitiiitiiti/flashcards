import { useEffect, useMemo, useRef, useState } from "react";
import type { Deck, DeckCard } from "./deck";
import { saveReview } from "./db";
import { buildStudyQueue, dayKey, previewIntervals, rate } from "./srs";
import type { ProgressRecord, ReviewRating } from "./types";

interface StudyViewProps {
  deck: Deck;
  /** 学習開始時点の進捗。セッション中は外部更新を反映しない（スナップショット固定） */
  initialProgress: ProgressRecord[];
  onClose: () => void;
}

interface QueueItem {
  card: DeckCard;
  isNew: boolean;
}

const RATING_LABELS: { rating: ReviewRating; label: string; className: string }[] = [
  { rating: 1, label: "もう一度", className: "rate-again" },
  { rating: 2, label: "難しい", className: "rate-hard" },
  { rating: 3, label: "普通", className: "rate-good" },
  { rating: 4, label: "簡単", className: "rate-easy" },
];

export function StudyView({ deck, initialProgress, onClose }: StudyViewProps) {
  const initialQueue = useMemo<QueueItem[]>(() => {
    const queue = buildStudyQueue(deck, initialProgress, new Date());
    return [
      ...queue.due.map((card) => ({ card, isNew: false })),
      ...queue.fresh.map((card) => ({ card, isNew: true })),
    ];
  }, [deck, initialProgress]);

  const [queue, setQueue] = useState<QueueItem[]>(initialQueue);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);
  // セッション中の最新進捗（評価済みカードの再出題に使う）
  const progressRef = useRef(new Map(initialProgress.map((record) => [record.cardId, record])));

  useEffect(() => {
    // 学習中はページ全体のスクロール（iOS のバウンス含む）を止める
    document.body.classList.add("study-lock");
    return () => document.body.classList.remove("study-lock");
  }, []);

  const current = queue[0];
  const progressPercent = reviewedCount + queue.length === 0 ? 100 : Math.round((reviewedCount / (reviewedCount + queue.length)) * 100);

  const intervals = useMemo(
    () => (current && revealed ? previewIntervals(progressRef.current.get(current.card.id)?.progress ?? null, new Date()) : null),
    [current, revealed],
  );

  async function handleRate(rating: ReviewRating) {
    if (!current || saving) return;
    setSaving(true);
    setError(null);
    const now = new Date();
    const existing = progressRef.current.get(current.card.id);
    const record: ProgressRecord = {
      deckId: deck.id,
      cardId: current.card.id,
      progress: rate(existing?.progress ?? null, rating, now),
      introducedDayKey: existing?.introducedDayKey ?? dayKey(now),
      updatedAt: now.getTime(),
    };
    try {
      // 評価の瞬間に進捗とログを保存する（画面遷移やアニメを待たない）
      await saveReview(record, {
        reviewId: crypto.randomUUID(),
        deckId: deck.id,
        cardId: current.card.id,
        rating,
        reviewedAt: now.getTime(),
      });
    } catch {
      setError("進捗を保存できませんでした。もう一度お試しください。");
      setSaving(false);
      return;
    }
    progressRef.current.set(current.card.id, record);
    setReviewedCount((count) => count + 1);
    setQueue((items) => {
      const rest = items.slice(1);
      // 「もう一度」はセッション末尾に再出題する
      return rating === 1 ? [...rest, { card: current.card, isNew: false }] : rest;
    });
    setRevealed(false);
    setSaving(false);
  }

  const header = (
    <header className="study-header">
      <div className="study-header-row">
        <h1>{deck.name}</h1>
        <button type="button" onClick={onClose}>{current ? "中断" : "閉じる"}</button>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuenow={progressPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="このセッションの進み具合"
      >
        <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>
    </header>
  );

  if (!current) {
    return (
      <section className="study">
        {header}
        <div className="study-scroll">
          <div className="study-card study-summary-card">
            {initialQueue.length === 0 ? (
              <>
                <p className="summary-emoji" aria-hidden="true">🎉</p>
                <p className="summary-title">今日学習するカードはありません</p>
              </>
            ) : (
              <>
                <p className="summary-emoji" aria-hidden="true">🎉</p>
                <p className="summary-title">おつかれさまでした</p>
                <p className="muted">{reviewedCount} 回学習しました</p>
              </>
            )}
          </div>
        </div>
        <footer className="study-actions">
          <button type="button" className="primary reveal-button" onClick={onClose}>ホームへ戻る</button>
        </footer>
      </section>
    );
  }

  return (
    <section className="study">
      {header}
      <div className="study-scroll">
        <div
          className="study-card"
          onClick={() => setRevealed((value) => !value)}
          role="button"
          tabIndex={-1}
          aria-label={revealed ? "タップで問題面に戻る" : "タップで答えを表示"}
        >
          {current.isNew && <span className="chip chip-new study-card-chip">新規</span>}
          <div className="study-front">{current.card.front}</div>
          {revealed && (
            <>
              <hr />
              <div className="study-back">{current.card.back}</div>
              {current.card.note && <div className="study-note muted">{current.card.note}</div>}
            </>
          )}
        </div>
      </div>
      <footer className="study-actions">
        {error && <p className="notice warning">{error}</p>}
        {revealed ? (
          <div className="rating-buttons">
            {RATING_LABELS.map(({ rating, label, className }) => (
              <button key={rating} type="button" className={className} disabled={saving} onClick={() => void handleRate(rating)}>
                <span className="rating-label">{label}</span>
                <span className="rating-interval">{intervals?.[rating]}</span>
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="primary reveal-button" onClick={() => setRevealed(true)}>
            答えを表示
          </button>
        )}
        <p className="muted study-remaining">残り {queue.length} 枚</p>
      </footer>
    </section>
  );
}
