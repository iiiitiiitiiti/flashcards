import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Deck, DeckCard } from "./deck";
import { saveCardNote, saveReview, setCardHidden, undoReview } from "./db";
import { describeStorageError } from "./quota";
import { buildStudyQueue, countIntroducedToday, dayKey, formatInterval, previewIntervals, rate, ratingFromElapsed, retentionPercent, shuffled } from "./srs";
import { loadBuzzerSpeed, loadNewCardsPerDay, loadRatingThresholds } from "./storage";
import { StudyResult, type SessionEntry } from "./StudyResult";
import { splitGraphemes } from "./text";
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
  /** このタグを持つカードだけを出す。null なら絞り込まない */
  tag: string | null;
  /** 全デッキ合計で数えるときの、開始時点で使った新規枠。デッキごとの設定なら undefined */
  usedNewCardsToday?: number;
  /** カードごとの自分のメモ（カード id → 本文）。開始時点のスナップショット */
  initialNotes: Map<string, string>;
  /** カードを非表示にしたときに親へ伝える（一覧と統計を作り直すため） */
  onHide: (cardId: string) => void;
  /** 学習を終える。restart が true なら同じ設定でもう一度始める */
  onClose: (restart: boolean) => void;
}

/** メモのアイコン（書類＋ペン）。色はボタンの文字色に従う */
function NoteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8" />
      <path d="M14 3v5h5" />
      <path d="M20.4 12.6a1.9 1.9 0 0 1 0 2.7l-4.6 4.6-2.8.6.6-2.8 4.6-4.6a1.9 1.9 0 0 1 2.2-.5z" />
    </svg>
  );
}

/** 1つ戻すアイコン（左向きの U ターン矢印） */
function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h11a5 5 0 0 1 0 10h-4" />
      <path d="M8 5L4 9l4 4" />
    </svg>
  );
}

/** 非表示のアイコン（目に斜線） */
function HideIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.6 6.2A9.7 9.7 0 0 1 12 6.1c5 0 9 4.4 9 5.9a10 10 0 0 1-2.5 3.2" />
      <path d="M6.3 7.9C4.2 9.2 3 10.9 3 12c0 1.5 4 5.9 9 5.9 1.6 0 3-.4 4.3-1.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3.5 3.5l17 17" />
    </svg>
  );
}

/** 1枚に費やした時間として数える上限（これを超える分は放置とみなす） */
const MAX_ELAPSED_MS = 5 * 60 * 1000;

/**
 * 早押しで、カードが出てから最初の1文字が出るまでの間。
 * 1文字ぶんの間隔（既定 120ms）だと、カードの入場アニメーション（`.flip-scene` の 0.28s）が
 * 終わる前に読み始めてしまい、構える時間が無い。
 * 800ms は長すぎたため、120ms との中間へ寄せた（2026-08-27 ユーザー指定）。
 */
const BUZZER_LEAD_IN_MS = 450;

interface QueueItem {
  card: DeckCard;
  isNew: boolean;
}

/** 評価を取り消すために控えておく1回ぶん。セッションを離れると消える */
interface UndoEntry {
  item: QueueItem;
  /** 評価する前の進捗。初回評価だったカードは undefined */
  previous: ProgressRecord | undefined;
  reviewId: string;
  rating: ReviewRating;
  /** 取り消したあとに計測を引き継ぐための経過時間 */
  elapsedMs: number;
}

/** キューの末尾に足した再出題を1つだけ取り除く */
function withoutLastAppearance(items: QueueItem[], cardId: string): QueueItem[] {
  const index = items.map((item) => item.card.id).lastIndexOf(cardId);
  return index === -1 ? items : [...items.slice(0, index), ...items.slice(index + 1)];
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

export function StudyView({ deck, initialProgress, mode, sessionSize, order, tag, usedNewCardsToday, initialNotes, onHide, onClose }: StudyViewProps) {
  const initialQueue = useMemo<QueueItem[]>(() => {
    const queue = buildStudyQueue(deck, initialProgress, new Date(), loadNewCardsPerDay(), tag, usedNewCardsToday);
    const items = [
      ...queue.due.map((card) => ({ card, isNew: false })),
      ...queue.fresh.map((card) => ({ card, isNew: true })),
    ];
    // ランダムはデッキ全体から無作為に選びたいので、枚数で切る前にシャッフルする
    // 選んだ枚数でセッションを打ち切る（「もう一度」の再出題はこの上限に含めない）
    return (order === "random" ? shuffled(items) : items).slice(0, sessionSize);
  }, [deck, initialProgress, sessionSize, order, tag, usedNewCardsToday]);

  /** 開始時点でこのデッキが使っていた新規枠。セッション中の増分を差し引くのに使う */
  const introducedAtStart = useMemo(() => countIntroducedToday(initialProgress, new Date()), [initialProgress]);

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
  /** カード id → 自分のメモ。書き換えたらこの Map を差し替える */
  const [notes, setNotes] = useState<Map<string, string>>(initialNotes);
  /** メモ入力を開いているカード。null なら閉じている */
  const [noteEditing, setNoteEditing] = useState<{ cardId: string; text: string } | null>(null);
  /** 非表示の確認を出しているカード */
  const [hideTarget, setHideTarget] = useState<string | null>(null);
  /** 取り消せる評価。新しいものが末尾（押すたびに1つずつ戻る） */
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  // セッション中の最新進捗（評価済みカードの再出題に使う）
  const progressRef = useRef(new Map(initialProgress.map((record) => [record.cardId, record])));
  // 評価の多重実行を止める。state の saving は再レンダーまで false のままなので排他にならない
  const ratingLockRef = useRef(false);
  // 設定はセッション開始時の値で固定する（学習中に変わらない）
  const thresholds = useRef(loadRatingThresholds()).current;
  const buzzerSpeed = useRef(loadBuzzerSpeed()).current;

  useEffect(() => {
    // 学習中はページ全体のスクロール（iOS のバウンス含む）を止める
    document.body.classList.add("study-lock");
    return () => document.body.classList.remove("study-lock");
  }, []);

  useEffect(
    () => () => {
      // 飛ばしている途中で画面を離れても、タイマーと後続の更新を残さない
      mountedRef.current = false;
      if (flyTimerRef.current !== undefined) window.clearTimeout(flyTimerRef.current);
    },
    [],
  );

  const current = queue[0];

  // 早押し: 問題文を1文字ずつ送り、押した時点で止める
  const buzzerChars = useMemo(() => (current ? splitGraphemes(current.card.front) : []), [current]);
  const [shownChars, setShownChars] = useState(0);
  const [buzzedAt, setBuzzedAt] = useState<number | null>(null);

  // 取り消しで戻したカードは計測をやり直さない（下の効果が上書きするのを防ぐ）
  const restoreElapsedRef = useRef<number | null>(null);

  useEffect(() => {
    // カードが変わったら計測を開始し、読み上げも最初から
    const restored = restoreElapsedRef.current;
    restoreElapsedRef.current = null;
    setShownAt(restored === null ? Date.now() : Date.now() - restored);
    setShownChars(0);
    setBuzzedAt(null);
  }, [current, reviewedCount]);

  useEffect(() => {
    // アプリを離れていた時間を秒数評価に含めない。早押しはまだ押していなければ読み直す
    function handleVisibility() {
      if (document.visibilityState !== "visible") return;
      setShownAt(Date.now());
      if (!revealed && buzzedAt === null) setShownChars(0);
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [revealed, buzzedAt]);

  useEffect(() => {
    // リザルトを表示している間は読み上げを止める（裏で問題が進んでしまわないように）
    if (mode !== "buzzer" || !current || revealed || buzzedAt !== null || result !== null) return;
    if (shownChars >= buzzerChars.length) return;
    // 1文字目だけ待ちを長くする（読み始めるまでの構える間）
    const delay = shownChars === 0 ? BUZZER_LEAD_IN_MS : buzzerSpeed;
    const timer = window.setTimeout(() => setShownChars((count) => count + 1), delay);
    return () => window.clearTimeout(timer);
  }, [mode, current, revealed, buzzedAt, result, shownChars, buzzerChars.length, buzzerSpeed]);

  // 左右スワイプ評価（答え表示中のみ）。左=もう一度、右=経過秒数で自動振り分け
  const SWIPE_THRESHOLD = 80;
  /** 確定後にカードが飛んでいく時間。CSS の .drag-fly と揃える */
  const FLY_OUT_MS = 260;
  const [dragX, setDragX] = useState(0);
  const [flying, setFlying] = useState(false);
  const flyTimerRef = useRef<number | undefined>(undefined);
  const mountedRef = useRef(true);
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
    const decided = !cancelled && drag.horizontal && Math.abs(dx) >= SWIPE_THRESHOLD;
    // 確定するときは指の位置から続けて飛ばすので、ここでは戻さない
    if (!decided) setDragX(0);
    if (cancelled || !drag.horizontal) return;
    if (dx <= -SWIPE_THRESHOLD) flyOut(-1, 1);
    else if (dx >= SWIPE_THRESHOLD) flyOut(1, mode === "buzzer" ? 3 : swipeRating());
  }

  /**
   * 指を離した位置からカードを画面外へ送り出す。
   * 保存は待たずにすぐ始め、アニメーションの完了と保存の完了が揃ってから次のカードへ進む
   * （保存を遅らせると、その間に画面を離れたときに評価が失われるため）。
   */
  function flyOut(direction: 1 | -1, rating: ReviewRating) {
    if (!current || ratingLockRef.current) return;
    ratingLockRef.current = true;
    if (document.documentElement.dataset.motion === "crossfade") {
      void handleRate(rating);
      return;
    }
    setFlying(true);
    setDragX(direction * (window.innerWidth + 200));
    const animation = new Promise<void>((resolve) => {
      flyTimerRef.current = window.setTimeout(resolve, FLY_OUT_MS);
    });
    void handleRate(rating, animation);
  }

  /** 右スワイプの評価。問題が表示されてからの経過時間で 簡単/普通/難しい/もう一度 を決める */
  function swipeRating(): ReviewRating {
    return ratingFromElapsed(Date.now() - shownAt, thresholds);
  }

  function reveal() {
    setRevealed(true);
  }

  /**
   * 中断から学習へ戻る。中断していた時間を持ち込まないよう、その問題を仕切り直す。
   * まだ押していない早押しは読み上げを最初からやり直し、押した後なら押した位置を保つ。
   */
  function resumeStudy() {
    setResult(null);
    setShownAt(Date.now());
    if (!revealed && buzzedAt === null) setShownChars(0);
  }

  /** 早押しのタップ: 1回目で読み上げを止め、2回目で答えを表示する */
  /** 押して止めた文字送りを再開する（答えるためではなく、考えるために止めたとき） */
  function resumeBuzzer() {
    if (buzzedAt === null) return;
    // 押した位置から続ける（止めたあとに送り過ぎないよう明示的に戻す）
    setShownChars(buzzedAt);
    setBuzzedAt(null);
  }

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

  /** メモを閉じるときに保存する。空にしたら削除される */
  async function closeNote() {
    const editing = noteEditing;
    setNoteEditing(null);
    if (!editing) return;
    const text = editing.text.trim();
    if ((notes.get(editing.cardId) ?? "") === text) return;
    try {
      await saveCardNote(deck.id, editing.cardId, text);
      setNotes((previous) => {
        const next = new Map(previous);
        if (text === "") next.delete(editing.cardId);
        else next.set(editing.cardId, text);
        return next;
      });
    } catch (error) {
      setError(describeStorageError(error, "メモを保存"));
    }
  }

  /**
   * 直前の評価を取り消して、そのカードへ戻る。
   * 逆向きにスワイプしてしまったときの復旧用。進捗もログも評価前へ戻す。
   */
  async function undoLast() {
    const entry = undoStack[undoStack.length - 1];
    if (!entry || ratingLockRef.current) return;
    ratingLockRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await undoReview(deck.id, entry.item.card.id, entry.previous, entry.reviewId);
    } catch (error) {
      setError(describeStorageError(error, "評価の取り消しを保存"));
      setSaving(false);
      ratingLockRef.current = false;
      return;
    }
    if (entry.previous) progressRef.current.set(entry.item.card.id, entry.previous);
    else progressRef.current.delete(entry.item.card.id);
    setQueue((items) => {
      // 「もう一度」で末尾へ足した再出題を先に取り除いてから、先頭へ戻す
      const rest = entry.rating === 1 ? withoutLastAppearance(items, entry.item.card.id) : items;
      return [entry.item, ...rest];
    });
    setSessionLog((log) => log.slice(1));
    setReviewedCount((count) => Math.max(0, count - 1));
    setUndoStack((stack) => stack.slice(0, -1));
    // 付け直しやすいよう答えを出したまま戻し、経過時間も引き継ぐ
    // （計測をやり直すと、そのままスワイプしたときに「簡単」へ倒れてしまう）
    restoreElapsedRef.current = entry.elapsedMs;
    // リザルトから取り消したときは、そのカードの画面へ戻す
    setResult(null);
    setRevealed(true);
    setFlying(false);
    setDragX(0);
    setSaving(false);
    ratingLockRef.current = false;
  }

  /** 出題から外す。評価はせず、そのカードをキューから抜くだけ（進捗は残す） */
  async function hideCard(cardId: string) {
    setHideTarget(null);
    try {
      await setCardHidden(deck.id, cardId, true);
    } catch (error) {
      setError(describeStorageError(error, "非表示に"));
      return;
    }
    onHide(cardId);
    setQueue((items) => items.filter((item) => item.card.id !== cardId));
    setRevealed(false);
    setShownAt(Date.now());
    setShownChars(0);
    setBuzzedAt(null);
  }

  /** 評価の入口。ここでだけロックを取り、以降は handleRate が解除まで持つ */
  function requestRate(rating: ReviewRating) {
    if (!current || ratingLockRef.current) return;
    ratingLockRef.current = true;
    void handleRate(rating);
  }

  /** ロックを保持した状態で呼ぶこと（requestRate / flyOut 経由） */
  async function handleRate(rating: ReviewRating, animation?: Promise<void>) {
    try {
      await rateCard(rating, animation);
    } finally {
      // rate() の例外など、想定外の失敗でもロックは必ず解除する
      ratingLockRef.current = false;
    }
  }

  async function rateCard(rating: ReviewRating, animation?: Promise<void>) {
    if (!current) return;
    // 対象カードをローカルに固定する（保存中に current が差し替わっても取り違えない）
    const target = current;
    setSaving(true);
    setError(null);
    const now = new Date();
    const existing = progressRef.current.get(target.card.id);
    const record: ProgressRecord = {
      deckId: deck.id,
      cardId: target.card.id,
      progress: rate(existing?.progress ?? null, rating, now),
      introducedDayKey: existing?.introducedDayKey ?? dayKey(now),
      updatedAt: now.getTime(),
    };
    // 席を外したぶんまで足すと「プレイ時間」が実態と合わなくなるので上限で切る
    const elapsedMs = Math.min(Math.max(0, now.getTime() - shownAt), MAX_ELAPSED_MS);
    const reviewId = crypto.randomUUID();
    try {
      // 評価の瞬間に進捗とログを保存する（画面遷移やアニメを待たない）
      await saveReview(record, {
        reviewId,
        deckId: deck.id,
        cardId: target.card.id,
        rating,
        reviewedAt: now.getTime(),
        elapsedMs,
      });
    } catch (error) {
      setError(describeStorageError(error, "進捗を保存"));
      // 飛ばしかけたカードは手元へ戻す
      setFlying(false);
      setDragX(0);
      setSaving(false);
      return;
    }
    // 飛び切る前にキューを進めると、カードが一瞬戻ってから消えてしまう
    if (animation) await animation;
    if (!mountedRef.current) return;
    progressRef.current.set(target.card.id, record);
    setSessionLog((log) => [
      {
        cardId: target.card.id,
        front: target.card.front,
        back: target.card.back,
        rating,
        fromPhase: existing?.progress.reps ?? 0,
        toPhase: record.progress.reps,
        interval: formatInterval(record.progress.due - now.getTime()),
      },
      ...log,
    ]);
    setReviewedCount((count) => count + 1);
    setUndoStack((stack) => [...stack, { item: target, previous: existing, reviewId, rating, elapsedMs }]);
    setQueue((items) => {
      const rest = items.slice(1);
      // 「もう一度」はセッション末尾に再出題する
      return rating === 1 ? [...rest, { card: target.card, isNew: false }] : rest;
    });
    setRevealed(false);
    setFlying(false);
    setDragX(0);
    setSaving(false);
  }

  useEffect(() => {
    // キューを最後までやり切ったらリザルトを出す
    if (!current && result === null) setResult("completed");
  }, [current, result]);

  const header = (
    <header className="study-header">
      <div className="study-header-row">
        {result === null && (
          <button
            type="button"
            className="icon-button"
            disabled={saving}
            aria-label="学習を中断して結果を見る"
            onClick={() => setResult("interrupted")}
          >
            ←
          </button>
        )}
        <h1>{deck.name}{mode === "buzzer" ? "（早押し）" : ""}</h1>
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
    // デッキ全体の定着率。セッション中の評価も progressRef に入っているので最新の値になる
    const phases = deck.cards.map((card) => {
      const progress = progressRef.current.get(card.id)?.progress;
      return { reps: progress?.reps ?? 0, state: progress?.state ?? 0 };
    });
    const phaseGain = sessionLog.reduce((total, entry) => total + (entry.toPhase - entry.fromPhase), 0);
    // 評価回数ではなく、いま出せるカードが残っているかで判定する
    const now = new Date();
    const current = [...progressRef.current.values()];
    // 外から来た値は「開始時点」のもの。このセッションで導入したぶんを足さないと枠を多く見積もる
    const used =
      usedNewCardsToday === undefined
        ? undefined
        : usedNewCardsToday + countIntroducedToday(current, now) - introducedAtStart;
    const rest = buildStudyQueue(deck, current, now, loadNewCardsPerDay(), tag, used);
    const remaining = rest.due.length + rest.fresh.length;
    return (
      <section className="study study-result">
        {header}
        {error && <p className="notice warning result-error">{error}</p>}
        <StudyResult
          mode={mode}
          percent={retentionPercent(phases, deck.cards.length)}
          phaseGain={phaseGain}
          entries={sessionLog}
          reason={result}
          canContinue={result === "interrupted" ? true : remaining > 0}
          canUndo={undoStack.length > 0}
          busy={saving}
          onUndo={() => void undoLast()}
          tag={tag}
          onContinue={() => (result === "interrupted" ? resumeStudy() : onClose(true))}
          onFinish={() => onClose(false)}
        />
      </section>
    );
  }

  if (!current) return null;

  /** カードへの操作（メモ・非表示）。ヘッダーではなくカードの上に置く */
  const cardActions = result === null && current && (
    <div className="card-actions">
      <button
        type="button"
        className="card-action"
        aria-label="1つ前のカードに戻る（直前の評価を取り消す）"
        disabled={undoStack.length === 0 || saving}
        onClick={() => void undoLast()}
      >
        <UndoIcon />
      </button>
      <span className="card-actions-right">
      <button
        type="button"
        className={`card-action${notes.has(current.card.id) ? " card-action-on" : ""}`}
        disabled={saving}
        aria-label={notes.has(current.card.id) ? "メモを編集" : "メモを書く"}
        onClick={() => setNoteEditing({ cardId: current.card.id, text: notes.get(current.card.id) ?? "" })}
      >
        <NoteIcon />
      </button>
      <button
        type="button"
        className="card-action"
        aria-label="このカードを非表示にする"
        disabled={saving}
        onClick={() => setHideTarget(current.card.id)}
      >
        <HideIcon />
      </button>
      </span>
    </div>
  );

  /** メモ入力と非表示の確認。どちらの学習画面でも同じものを重ねる */
  const dialogs = (
    <>
      {noteEditing !== null && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="メモ">
          <div className="sheet">
            <h2>メモ</h2>
            <textarea
              className="note-input"
              value={noteEditing.text}
              placeholder="メモを入力"
              autoFocus
              rows={5}
              onChange={(event) => setNoteEditing({ ...noteEditing, text: event.target.value })}
            />
            <button type="button" className="primary" onClick={() => void closeNote()}>
              とじる
            </button>
          </div>
        </div>
      )}
      {hideTarget !== null && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="このクイズを非表示にしますか？">
          <div className="sheet">
            <p className="hide-message">このクイズを非表示にしますか？</p>
            <p className="muted">出題されなくなります。カード一覧の「非表示のカード」からいつでも戻せます。</p>
            <div className="button-row">
              <button type="button" onClick={() => setHideTarget(null)}>キャンセル</button>
              <button type="button" className="primary" onClick={() => void hideCard(hideTarget)}>非表示にする</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (mode === "buzzer") {
    return (
      <section className="study study-buzzer">
        {dialogs}
        {header}
        {cardActions}
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
              className={`drag-layer${flying ? " drag-fly" : dragX === 0 ? " drag-settle" : ""}`}
              style={{
                transform:
                  dragX === 0 ? undefined : `translateX(${dragX}px) translateY(${Math.abs(dragX) * 0.06}px) rotate(${dragX * 0.06}deg)`,
              }}
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
                    {notes.has(current.card.id) && <div className="study-memo">{notes.get(current.card.id)}</div>}
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
          {/* 状態で中身が変わっても高さが動かないよう、共通の枠に入れる（押した瞬間に問題文が下がるのを防ぐ） */}
          <div className="buzzer-slot">
            {revealed ? (
              <div className="rating-buttons">
                {BUZZER_BUTTONS.map(({ rating, label, className }) => (
                  <button key={rating} type="button" className={className} disabled={saving} onClick={() => requestRate(rating)}>
                    <span className="rating-label">{label}</span>
                    <span className="rating-interval">{intervals?.[rating]}</span>
                  </button>
                ))}
              </div>
            ) : buzzedAt === null ? (
              // ラベルは置かない（実物の早押しボタンに文字が無いのと同じ）。読み上げは aria-label で補う
              <button type="button" className="buzz-button" aria-label="押す" onClick={handleBuzzerTap} />
            ) : (
              <div className="buzzer-actions">
                {buzzedAt < buzzerChars.length && (
                  <button type="button" className="buzz-resume" onClick={resumeBuzzer}>
                    つづきを読む
                  </button>
                )}
                <button type="button" className="primary reveal-button" onClick={reveal}>
                  答えを表示
                </button>
              </div>
            )}
          </div>
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
      {dialogs}
      {header}
      {cardActions}
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
            className={`drag-layer${flying ? " drag-fly" : dragX === 0 ? " drag-settle" : ""}`}
            style={{
              transform:
                dragX === 0 ? undefined : `translateX(${dragX}px) translateY(${Math.abs(dragX) * 0.06}px) rotate(${dragX * 0.06}deg)`,
            }}
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
                {notes.has(current.card.id) && <div className="study-memo">{notes.get(current.card.id)}</div>}
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
              <button key={rating} type="button" className={className} disabled={saving} onClick={() => requestRate(rating)}>
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
