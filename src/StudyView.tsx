import { useMemo, useRef, useState } from "react";
import type { Deck, DeckCard } from "./deck";
import { saveReview } from "./db";
import { buildStudyQueue, dayKey, rate } from "./srs";
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

  const current = queue[0];

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

  if (!current) {
    return (
      <section className="study">
        <header className="app-header">
          <h1>{deck.name}</h1>
        </header>
        <div className="study-summary">
          {initialQueue.length === 0 ? (
            <p>今日学習するカードはありません。</p>
          ) : (
            <p>おつかれさまでした。{reviewedCount} 回学習しました。</p>
          )}
          <button type="button" onClick={onClose}>ホームへ戻る</button>
        </div>
      </section>
    );
  }

  return (
    <section className="study">
      <header className="app-header">
        <h1>{deck.name}</h1>
        <button type="button" onClick={onClose}>中断</button>
      </header>
      <p className="muted">残り {queue.length} 枚{current.isNew ? "・新規カード" : ""}</p>
      {error && <p className="notice warning">{error}</p>}
      <div
        className={`study-card${revealed ? " revealed" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => setRevealed(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") setRevealed(true);
        }}
      >
        <div className="study-front">{current.card.front}</div>
        {revealed ? (
          <>
            <hr />
            <div className="study-back">{current.card.back}</div>
            {current.card.note && <div className="study-note muted">{current.card.note}</div>}
          </>
        ) : (
          <div className="muted study-hint">タップで答えを表示</div>
        )}
      </div>
      {revealed && (
        <div className="rating-buttons">
          {RATING_LABELS.map(({ rating, label, className }) => (
            <button key={rating} type="button" className={className} disabled={saving} onClick={() => void handleRate(rating)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
