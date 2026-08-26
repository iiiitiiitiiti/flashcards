import type { ReviewRating, StudyMode } from "./types";

/** このセッションで評価した1枚ぶんの記録 */
export interface SessionEntry {
  cardId: string;
  front: string;
  back: string;
  rating: ReviewRating;
  /** 評価前のフェーズ（FSRS の reps） */
  fromPhase: number;
  /** 評価後のフェーズ */
  toPhase: number;
  /** 次回出題までの目安 */
  interval: string;
}

interface StudyResultProps {
  mode: StudyMode;
  entries: SessionEntry[];
  /** セッションを途中で止めたのか、キューを最後までやり切ったのか */
  reason: "interrupted" | "completed";
  /** まだ学習できるカードが残っているか */
  canContinue: boolean;
  onContinue: () => void;
  onFinish: () => void;
}

const RATING_LABELS: Record<ReviewRating, string> = {
  1: "もう一度",
  2: "難しい",
  3: "わかった",
  4: "かんたん",
};

const BUZZER_RATING_LABELS: Record<ReviewRating, string> = {
  1: "不正解",
  2: "難しい",
  3: "正解",
  4: "かんたん",
};

const RATING_CLASSES: Record<ReviewRating, string> = {
  1: "result-chip-again",
  2: "result-chip-hard",
  3: "result-chip-good",
  4: "result-chip-easy",
};

/** 達成率に応じた一言。数字だけだと続けるかどうかの判断材料にならないため */
function comment(percent: number, mode: StudyMode): string[] {
  if (percent >= 90) {
    return mode === "buzzer"
      ? ["ほとんど正解できていますね！", "この問題集はもう自分のものです！"]
      : ["すぐにわかった問題が多いですね！", "暗記は順調に進んでいます！"];
  }
  if (percent >= 70) return ["いい調子です！", "あと少しで全部が身につきます"];
  if (percent >= 40) return ["半分は思い出せています", "くり返すほど間隔が延びていきます"];
  return ["ここからが伸びどころです", "間をあけて何度も出てくるので大丈夫"];
}

/** 半円ゲージ。0〜100% を左から右へ塗る */
function Gauge({ percent }: { percent: number }) {
  const radius = 90;
  const length = Math.PI * radius;
  return (
    <div className="gauge" role="img" aria-label={`達成率 ${percent}%`}>
      <svg viewBox="0 0 220 130" className="gauge-svg" aria-hidden="true">
        <defs>
          <linearGradient id="gauge-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--color-gauge-start)" />
            <stop offset="100%" stopColor="var(--color-primary)" />
          </linearGradient>
        </defs>
        <path
          d="M 20 115 A 90 90 0 0 1 200 115"
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="18"
          strokeLinecap="round"
        />
        <path
          d="M 20 115 A 90 90 0 0 1 200 115"
          fill="none"
          stroke="url(#gauge-stroke)"
          strokeWidth="18"
          strokeLinecap="round"
          strokeDasharray={`${(length * percent) / 100} ${length}`}
        />
      </svg>
      <div className="gauge-value">
        <span className="gauge-caption">達成率</span>
        <strong>{percent}%</strong>
      </div>
    </div>
  );
}

export function StudyResult({ mode, entries, reason, canContinue, onContinue, onFinish }: StudyResultProps) {
  const labels = mode === "buzzer" ? BUZZER_RATING_LABELS : RATING_LABELS;
  const cleared = entries.filter((entry) => entry.rating >= 3).length;
  const percent = entries.length === 0 ? 0 : Math.round((cleared / entries.length) * 100);

  return (
    <div className="result-scroll">
      <div className="result-head">
        <Gauge percent={percent} />
        {entries.length === 0 ? (
          <p className="result-comment">まだ1枚も評価していません</p>
        ) : (
          <p className="result-comment">
            {comment(percent, mode).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </p>
        )}
        <div className="result-actions">
          {canContinue && (
            <button type="button" className="primary result-continue" onClick={onContinue}>
              つづける
            </button>
          )}
          <button type="button" className="result-finish" onClick={onFinish}>
            終了する
          </button>
        </div>
        {reason === "completed" && !canContinue && (
          <p className="muted">このデッキで今日出せるカードは終わりました。</p>
        )}
      </div>

      <div className="result-list-head">
        <span>今回めくったカード</span>
        <span className="result-count">{entries.length}枚</span>
      </div>
      <ul className="result-list">
        {entries.map((entry, index) => (
          <li key={`${entry.cardId}-${index}`} className="result-card">
            <div className="result-card-head">
              <span className={`result-chip ${RATING_CLASSES[entry.rating]}`}>{labels[entry.rating]}</span>
              <span className="muted result-next">再出題 {entry.interval}</span>
            </div>
            <p className="result-front">{entry.front}</p>
            <p className="result-back">{entry.back}</p>
            <div className="result-phase">
              <span className="muted">フェーズ</span>
              <span className="result-phase-bar">
                <span
                  className="result-phase-fill"
                  style={{ width: `${Math.min(100, entry.toPhase * 10)}%` }}
                />
              </span>
              <span className="muted">{entry.fromPhase} ›</span>
              <strong>{entry.toPhase}</strong>
            </div>
          </li>
        ))}
        {entries.length === 0 && <li className="muted">評価したカードはありません。</li>}
      </ul>
    </div>
  );
}
