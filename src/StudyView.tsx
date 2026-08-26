import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Deck, DeckCard } from "./deck";
import { saveReview } from "./db";
import { achievementPercent, buildStudyQueue, dayKey, formatInterval, previewIntervals, rate, ratingFromElapsed, shuffled } from "./srs";
import { loadBuzzerSpeed, loadNewCardsPerDay, loadRatingThresholds } from "./storage";
import { StudyResult, type SessionEntry } from "./StudyResult";
import type { ProgressRecord, ReviewRating, StudyMode, StudyOrder } from "./types";

interface StudyViewProps {
  deck: Deck;
  /** 学習開始時点の進捗。セッション中は外部更新を反映しない（スナップショット固定） */
  initialProgress: ProgressRecord[];
  /** 通常学習か早押しクイズか */
  mode: StudyMode;
  /** このセッションで出題する上限枚数 */
  sessionSize: number;
  /** 出題順 */
  order: StudyOrder;
  /** 学習を終える。restart が true なら同じ設定でもう一度始める */
  onClose: (restart: boolean) => void;
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

export function StudyView({ deck, initialProgress, mode, sessionSize, order, onClose }: StudyViewProps) {
  const availableCount = useMemo(() => {
    const queue = buildStudyQueue(deck, initialProgress, new Date(), loadNewCardsPerDay());
    return queue.due.length + queue.fresh.length;
  }, [deck, initialProgress]);

  const initialQueue = useMemo<QueueItem[]>(() => {
    const queue = buildStudyQueue(deck, initialProgress, new Date(), loadNewCardsPerDay());
    const items = [
      ...queue.due.map((card) => ({ card, isNew: false })),
      ...queue.fresh.map((card) => ({ card, isNew: true })),
    ];
    // ランダムはデッキ全体から無作為に選びたいので、枚数で切る前にシャッフルする
    // 選んだ枚数でセッションを打ち切る（「もう一度」の再出題はこの上限に含めない）
    return (order === "random" ? shuffled(items) : items).slice(0, sessionSize);
  }, [deck, initialProgress, sessionSize, order]);

  const [queue, setQueue] = useState<QueueItem[]>(initialQueue);
  const [revealed, setRevealed] = useState(false);
  /** 問題を表示した時刻。スワイプまでの経過時間で評価を振り分けるのに使う */
  const [shownAt, setShownAt] = useState(() => Date.now());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);
  /** リザルトに出す、このセッションで評価したカードの記録 */
  const [sessionLog, setSessionLog] = useState<SessionEntry[]>([]);
  const [result, setResult] = useState<"interrupted" | "completed" | null>(null);
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
    // カードが変わったら計測を開始し、読み上げも最初から
    setShownAt(Date.now());
    setShownChars(0);
    setBuzzedAt(null);
  }, [current, reviewedCount]);

  useEffect(() => {
    if (mode !== "buzzer" || !current || revealed || buzzedAt !== null) return;
    if (shownChars >= buzzerChars.length) return;
    const timer = window.setTimeout(() => setShownChars((count) => count + 1), buzzerSpeed);
    return () => window.clearTimeout(timer);
  }, [mode, current, revealed, buzzedAt, shownChars, buzzerChars.length, buzzerSpeed]);

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
    else if (dx >= SWIPE_THRESHOLD) void handleRate(mode === "buzzer" ? 3 : swipeRating());
  }

  /** 右スワイプの評価。問題が表示されてからの経過時間で 簡単/普通/難しい/もう一度 を決める */
  function swipeRating(): ReviewRating {
    return ratingFromElapsed(Date.now() - shownAt, thresholds);
  }

  function reveal() {
    setRevealed(true);
  }

  /** 早押しのタップ: 1回目で読み上げを止め、2回目で答えを表示する */
  function handleBuzzerTap() {
    if (revealed) return;
    if (buzzedAt === null) setBuzzedAt(shownChars);
    else reveal();
  }

  // 右上に出す現在のフェーズ（FSRS の reps）
  const currentPhase = current ? (progressRef.current.get(current.card.id)?.progress.reps ?? 0) : 0;

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
    setSessionLog((log) => [
      {
        cardId: current.card.id,
        front: current.card.front,
        back: current.card.back,
        rating,
        fromPhase: existing?.progress.reps ?? 0,
        toPhase: record.progress.reps,
        interval: formatInterval(record.progress.due - now.getTime()),
      },
      ...log,
    ]);
    setReviewedCount((count) => count + 1);
    setQueue((items) => {
      const rest = items.slice(1);
      // 「もう一度」はセッション末尾に再出題する
      return rating === 1 ? [...rest, { card: current.card, isNew: false }] : rest;
    });
    setRevealed(false);
    setSaving(false);
  }

  useEffect(() => {
    // キューを最後までやり切ったらリザルトを出す
    if (!current && result === null) setResult("completed");
  }, [current, result]);

  const header = (
    <header className="study-header">
      <div className="study-header-row">
        <h1>{deck.name}{mode === "buzzer" ? "（早押し）" : ""}</h1>
        {result === null && <button type="button" onClick={() => setResult("interrupted")}>中断</button>}
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

  if (initialQueue.length === 0) {
    return (
      <section className="study">
        {header}
        <div className="study-scroll">
          <div className="study-card study-summary-card">
            <p className="summary-emoji" aria-hidden="true">🎉</p>
            <p className="summary-title">今日学習するカードはありません</p>
          </div>
        </div>
        <footer className="study-actions">
          <button type="button" className="primary reveal-button" onClick={() => onClose(false)}>ホームへ戻る</button>
        </footer>
      </section>
    );
  }

  if (result !== null) {
    // デッキ全体の達成率。セッション中の評価も progressRef に入っているので最新の値になる
    const phases = deck.cards.map((card) => progressRef.current.get(card.id)?.progress.reps ?? 0);
    const phaseGain = sessionLog.reduce((total, entry) => total + (entry.toPhase - entry.fromPhase), 0);
    return (
      <section className="study study-result">
        {header}
        <StudyResult
          mode={mode}
          percent={achievementPercent(phases, deck.cards.length)}
          phaseGain={phaseGain}
          entries={sessionLog}
          reason={result}
          canContinue={result === "interrupted" ? true : availableCount > reviewedCount}
          onContinue={() => (result === "interrupted" ? setResult(null) : onClose(true))}
          onFinish={() => onClose(false)}
        />
      </section>
    );
  }

  if (!current) return null;

  if (mode === "buzzer") {
    return (
      <section className="study">
        {header}
        <div className="study-scroll">
          <div
            key={`${reviewedCount}-${current.card.id}`}
            className="flip-scene"
            onClick={() => {
              if (dragRef.current.suppressClick) {
                dragRef.current.suppressClick = false;
                return;
              }
              handleBuzzerTap();
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => endDrag(event, false)}
            onPointerCancel={(event) => endDrag(event, true)}
            role="button"
            tabIndex={-1}
            aria-label={
              revealed
                ? "左スワイプで不正解、右スワイプで正解"
                : buzzedAt === null
                  ? "タップで押す"
                  : "タップで答えを表示"
            }
          >
            <div
              className={`drag-layer${dragX === 0 ? " drag-settle" : ""}`}
              style={{ transform: dragX === 0 ? undefined : `translateX(${dragX}px) rotate(${dragX * 0.04}deg)` }}
            >
              <div className="study-card buzzer-card">
                <span className="study-card-chip">
                  <span className="phase-chip">フェーズ {currentPhase}</span>
                </span>
                {revealed ? (
                  <>
                    <div className="study-front">{current.card.front}</div>
                    <hr />
                    <div className="study-back">{current.card.back}</div>
                    {current.card.note && <div className="study-note muted">{current.card.note}</div>}
                  </>
                ) : (
                  <div className="study-front buzzer-text">
                    {buzzerChars.slice(0, buzzedAt ?? shownChars).join("")}
                    {buzzedAt === null && <span className="buzzer-cursor" aria-hidden="true" />}
                  </div>
                )}
              </div>
            </div>
            {dragX < -12 && (
              <div className="swipe-badge swipe-badge-left" style={{ opacity: Math.min(1, -dragX / SWIPE_THRESHOLD) }}>
                不正解{intervals ? `・${intervals[1]}` : ""}
              </div>
            )}
            {dragX > 12 && (
              <div className="swipe-badge swipe-badge-right" style={{ opacity: Math.min(1, dragX / SWIPE_THRESHOLD) }}>
                正解{intervals ? `・${intervals[3]}` : ""}
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
          ) : buzzedAt === null ? (
            <button type="button" className="primary reveal-button buzz-button" onClick={handleBuzzerTap}>
              押す
            </button>
          ) : (
            <button type="button" className="primary reveal-button" onClick={reveal}>
              答えを表示
            </button>
          )}
          <p className="muted study-remaining">
            残り {queue.length} 枚
            {buzzedAt !== null ? `・${buzzedAt}/${buzzerChars.length} 文字で押した` : `・${shownChars}/${buzzerChars.length} 文字`}
            {revealed ? "・スワイプ: ← 不正解 / 正解 →" : ""}
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
          aria-label={revealed ? "タップで問題面に戻る。左スワイプでもう一度、右スワイプは問題が出てから答えるまでの速さで評価" : "タップで答えを表示"}
        >
          <div
            className={`drag-layer${dragX === 0 ? " drag-settle" : ""}`}
            style={{ transform: dragX === 0 ? undefined : `translateX(${dragX}px) rotate(${dragX * 0.04}deg)` }}
          >
            <div className={`flip-inner${revealed ? " flipped" : ""}`}>
              <div className="study-card flip-face flip-front" aria-hidden={revealed}>
                <span className="study-card-chip">
                  {current.isNew && <span className="chip chip-new">新規</span>}
                  <span className="phase-chip">フェーズ {currentPhase}</span>
                </span>
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
