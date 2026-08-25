import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Deck, DeckCard } from "./deck";
import { saveReview } from "./db";
import { buildStudyQueue, dayKey, previewIntervals, rate, ratingFromElapsed } from "./srs";
import { loadBuzzerSpeed, loadRatingThresholds } from "./storage";
import type { ProgressRecord, ReviewRating, StudyMode } from "./types";

interface StudyViewProps {
  deck: Deck;
  /** 学習開始時点の進捗。セッション中は外部更新を反映しない（スナップショット固定） */
  initialProgress: ProgressRecord[];
  /** 通常学習か早押しクイズか */
  mode: StudyMode;
  /** このセッションで出題する上限枚数 */
  sessionSize: number;
  onClose: () => void;
}

interface QueueItem {
  card: DeckCard;
  isNew: boolean;
}

const RATING_LABELS: Record<ReviewRating, string> = {
  1: "もう一度",
  2: "難しい",
  3: "普通",
  4: "簡単",
};

// 明示操作は2択。細かい4段階はスワイプの経過秒数で自動的に振り分ける
const ANSWER_BUTTONS: { rating: ReviewRating; label: string; className: string }[] = [
  { rating: 2, label: "難しい", className: "rate-hard" },
  { rating: 3, label: "わかった", className: "rate-good" },
];

const BUZZER_BUTTONS: { rating: ReviewRating; label: string; className: string }[] = [
  { rating: 1, label: "不正解", className: "rate-again" },
  { rating: 3, label: "正解", className: "rate-good" },
];

export function StudyView({ deck, initialProgress, mode, sessionSize, onClose }: StudyViewProps) {
  const initialQueue = useMemo<QueueItem[]>(() => {
    const queue = buildStudyQueue(deck, initialProgress, new Date());
    return [
      ...queue.due.map((card) => ({ card, isNew: false })),
      ...queue.fresh.map((card) => ({ card, isNew: true })),
      // 選んだ枚数でセッションを打ち切る（「もう一度」の再出題はこの上限に含めない）
    ].slice(0, sessionSize);
  }, [deck, initialProgress, sessionSize]);

  const [queue, setQueue] = useState<QueueItem[]>(initialQueue);
  const [revealed, setRevealed] = useState(false);
  /** 答えを表示した時刻。スワイプまでの経過時間で評価を振り分けるのに使う */
  const [revealedAt, setRevealedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);
  // セッション中の最新進捗（評価済みカードの再出題に使う）
  const progressRef = useRef(new Map(initialProgress.map((record) => [record.cardId, record])));
  // 設定はセッション開始時の値で固定する（学習中に変わらない）
  const thresholds = useRef(loadRatingThresholds()).current;
  const buzzerSpeed = useRef(loadBuzzerSpeed()).current;

  useEffect(() => {
    // 学習中はページ全体のスクロール（iOS のバウンス含む）を止める
    document.body.classList.add("study-lock");
    return () => document.body.classList.remove("study-lock");
  }, []);

  const current = queue[0];

  // 早押し: 問題文を1文字ずつ送り、押した時点で止める
  const buzzerChars = useMemo(() => (current ? Array.from(current.card.front) : []), [current]);
  const [shownChars, setShownChars] = useState(0);
  const [buzzedAt, setBuzzedAt] = useState<number | null>(null);

  useEffect(() => {
    // カードが変わったら読み上げを最初から
    setShownChars(0);
    setBuzzedAt(null);
  }, [current, reviewedCount]);

  useEffect(() => {
    if (mode !== "buzzer" || !current || revealed) return;
    if (shownChars >= buzzerChars.length) return;
    const timer = window.setTimeout(() => setShownChars((count) => count + 1), buzzerSpeed);
    return () => window.clearTimeout(timer);
  }, [mode, current, revealed, shownChars, buzzerChars.length, buzzerSpeed]);

  // 左右スワイプ評価（答え表示中のみ）。左=もう一度、右=経過秒数で自動振り分け
  const SWIPE_THRESHOLD = 80;
  const [dragX, setDragX] = useState(0);
  const dragRef = useRef({ pointerId: -1, startX: 0, startY: 0, horizontal: false, suppressClick: false });

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (saving) return;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, horizontal: false, suppressClick: false };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    // 一定以上動いたらタップ（めくり）とは扱わない
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) drag.suppressClick = true;
    if (!revealed) return;
    if (!drag.horizontal) {
      // 縦方向優勢ならカード内スクロールに譲る
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy)) return;
      drag.horizontal = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDragX(dx);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) {
    const drag = dragRef.current;
    if (drag.pointerId !== event.pointerId) return;
    drag.pointerId = -1;
    const dx = event.clientX - drag.startX;
    setDragX(0);
    if (cancelled || !drag.horizontal) return;
    if (dx <= -SWIPE_THRESHOLD) void handleRate(1);
    else if (dx >= SWIPE_THRESHOLD) void handleRate(swipeRating());
  }

  /** 右スワイプの評価。答えを表示してからの経過時間で 簡単/普通/難しい/もう一度 を決める */
  function swipeRating(): ReviewRating {
    if (revealedAt === null) return 3;
    return ratingFromElapsed(Date.now() - revealedAt, thresholds);
  }

  function reveal() {
    setRevealed(true);
    setRevealedAt(Date.now());
  }

  /** 早押し: 読み上げを止めて答えを表示する */
  function buzz() {
    if (revealed) return;
    setBuzzedAt(shownChars);
    reveal();
  }

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
    setRevealedAt(null);
    setSaving(false);
  }

  const header = (
    <header className="study-header">
      <div className="study-header-row">
        <h1>{deck.name}{mode === "buzzer" ? "（早押し）" : ""}</h1>
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

  if (mode === "buzzer") {
    return (
      <section className="study">
        {header}
        <div className="study-scroll">
          <div
            key={`${reviewedCount}-${current.card.id}`}
            className="study-card buzzer-card"
            onClick={buzz}
            role="button"
            tabIndex={-1}
            aria-label={revealed ? "答えを表示中" : "タップで押す"}
          >
            {revealed ? (
              <>
                <div className="study-front">{current.card.front}</div>
                <hr />
                <div className="study-back">{current.card.back}</div>
                {current.card.note && <div className="study-note muted">{current.card.note}</div>}
              </>
            ) : (
              <div className="study-front buzzer-text">
                {buzzerChars.slice(0, shownChars).join("")}
                <span className="buzzer-cursor" aria-hidden="true" />
              </div>
            )}
          </div>
        </div>
        <footer className="study-actions">
          {error && <p className="notice warning">{error}</p>}
          {revealed ? (
            <div className="rating-buttons">
              {BUZZER_BUTTONS.map(({ rating, label, className }) => (
                <button key={rating} type="button" className={className} disabled={saving} onClick={() => void handleRate(rating)}>
                  <span className="rating-label">{label}</span>
                  <span className="rating-interval">{intervals?.[rating]}</span>
                </button>
              ))}
            </div>
          ) : (
            <button type="button" className="primary reveal-button buzz-button" onClick={buzz}>
              押す
            </button>
          )}
          <p className="muted study-remaining">
            残り {queue.length} 枚
            {buzzedAt !== null ? `・${buzzedAt}/${buzzerChars.length} 文字で押した` : `・${shownChars}/${buzzerChars.length} 文字`}
          </p>
        </footer>
      </section>
    );
  }

  return (
    <section className="study">
      {header}
      <div className="study-scroll">
        {/* key でカードごとに再マウントし、入場アニメーションを発火させる（ロジックはアニメに依存しない） */}
        <div
          key={`${reviewedCount}-${current.card.id}`}
          className="flip-scene"
          onClick={() => {
            if (dragRef.current.suppressClick) {
              dragRef.current.suppressClick = false;
              return;
            }
            if (revealed) setRevealed(false);
            else reveal();
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => endDrag(event, false)}
          onPointerCancel={(event) => endDrag(event, true)}
          role="button"
          tabIndex={-1}
          aria-label={revealed ? "タップで問題面に戻る。左スワイプでもう一度、右スワイプで答えるまでの速さに応じた評価" : "タップで答えを表示"}
        >
          <div
            className={`drag-layer${dragX === 0 ? " drag-settle" : ""}`}
            style={{ transform: dragX === 0 ? undefined : `translateX(${dragX}px) rotate(${dragX * 0.04}deg)` }}
          >
            <div className={`flip-inner${revealed ? " flipped" : ""}`}>
              <div className="study-card flip-face flip-front" aria-hidden={revealed}>
                {current.isNew && <span className="chip chip-new study-card-chip">新規</span>}
                <div className="study-front">{current.card.front}</div>
              </div>
              <div className="study-card flip-face flip-back" aria-hidden={!revealed}>
                <div className="study-front">{current.card.front}</div>
                <hr />
                <div className="study-back">{current.card.back}</div>
                {current.card.note && <div className="study-note muted">{current.card.note}</div>}
              </div>
            </div>
          </div>
          {dragX < -12 && (
            <div className="swipe-badge swipe-badge-left" style={{ opacity: Math.min(1, -dragX / SWIPE_THRESHOLD) }}>
              もう一度{intervals ? `・${intervals[1]}` : ""}
            </div>
          )}
          {dragX > 12 && (
            <div className="swipe-badge swipe-badge-right" style={{ opacity: Math.min(1, dragX / SWIPE_THRESHOLD) }}>
              {RATING_LABELS[swipeRating()]}
              {intervals ? `・${intervals[swipeRating()]}` : ""}
            </div>
          )}
        </div>
      </div>
      <footer className="study-actions">
        {error && <p className="notice warning">{error}</p>}
        {revealed ? (
          <div className="rating-buttons">
            {ANSWER_BUTTONS.map(({ rating, label, className }) => (
              <button key={rating} type="button" className={className} disabled={saving} onClick={() => void handleRate(rating)}>
                <span className="rating-label">{label}</span>
                <span className="rating-interval">{intervals?.[rating]}</span>
              </button>
            ))}
          </div>
        ) : (
          <button type="button" className="primary reveal-button" onClick={reveal}>
            答えを表示
          </button>
        )}
        <p className="muted study-remaining">
          残り {queue.length} 枚{revealed ? "・スワイプ: ← もう一度 / 速さで評価 →" : ""}
        </p>
      </footer>
    </section>
  );
}
