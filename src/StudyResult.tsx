import { useEffect, useState } from "react";
import { formatPercent } from "./srs";
import type { ReviewRating, StudyFocus, StudyMode } from "./types";

/** このセッションで評価した1枚ぶんの記録 */
export interface SessionEntry {
  cardId: string;
  /** デッキをまたぐ学習のときだけ入る（一覧でどのデッキの問題か分かるように） */
  deckName?: string;
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
  /** デッキ全体の定着率（定着したカードのフェーズ合計 ÷ 満点）。デッキをまたぐ学習では null（分母が全カードになり意味を失う） */
  percent: number | null;
  /** このセッションで進んだフェーズの合計 */
  phaseGain: number;
  /** セッションを途中で止めたのか、キューを最後までやり切ったのか */
  reason: "interrupted" | "completed";
  /** まだ学習できるカードが残っているか */
  canContinue: boolean;
  /** 直前の評価を取り消せるか（最後の1枚を誤ってスワイプした場合の戻り道） */
  canUndo: boolean;
  /** 保存中。取り消しの書き込みが終わる前に画面を離させない */
  busy: boolean;
  onUndo: () => void;
  /** 絞り込んで学習していたタグ。残り0枚の案内を「デッキ」ではなくタグで書くのに使う */
  tag: string | null;
  /** 苦手だけの学習だったか。残り0枚の案内を分ける */
  focus?: StudyFocus;
  /** 残り0枚の案内の主語。1デッキなら「このデッキ」、またぐときは「全デッキ」 */
  scopeLabel?: string;
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

/**
 * 定着率に応じた一言。デッキ全体の進み具合を見た文言にする
 * （セッション単体の出来ではないので「今回よくできた」とは書かない）
 */
function comment(percent: number | null, phaseGain: number): string[] {
  const gained = phaseGain > 0 ? `今回のぶんで ${phaseGain} フェーズ進みました` : "";
  // デッキをまたぐ学習では定着率を出さないので、進んだフェーズだけを言う
  if (percent === null) return [gained || "評価が進捗に反映されました", "デッキごとの定着率はホームで確認できます"];
  if (percent >= 90) return ["このデッキはほぼ完成です！", gained || "仕上げの復習を続けましょう"];
  if (percent >= 60) return ["大半が身についてきました", gained || "この調子で続けましょう"];
  if (percent >= 30) return ["着実に積み上がっています", gained || "くり返すほど間隔が延びます"];
  if (percent >= 5) return ["少しずつ定着してきました", gained || "毎日の積み重ねが効きます"];
  return ["まだ始まったばかりです", gained || "くり返すほど伸びます"];
}

/** 0 から目標値へ数字を動かす。アプリの「動きを減らす」設定では即座に確定する */
function useCountUp(target: number, durationMs = 900): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (document.documentElement.dataset.motion === "crossfade") {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const ratio = Math.min(1, (now - start) / durationMs);
      // easeOutCubic。最後にゆっくり止まるほうが数字を読み取りやすい
      setValue(target * (1 - Math.pow(1 - ratio, 3)));
      if (ratio < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);
  return value;
}

/** 半円ゲージ。0〜100% を左から右へ塗る。表示時に 0 から目標値まで動く */
function Gauge({ percent }: { percent: number }) {
  const radius = 90;
  const length = Math.PI * radius;
  const shown = useCountUp(percent);
  return (
    <div className="gauge" role="img" aria-label={`定着率 ${formatPercent(percent)}%`}>
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
          strokeDasharray={`${(length * shown) / 100} ${length}`}
        />
      </svg>
      <div className="gauge-value">
        <span className="gauge-caption">定着率</span>
        <strong>{formatPercent(shown)}%</strong>
      </div>
    </div>
  );
}

export function StudyResult({ mode, entries, percent, phaseGain, reason, canContinue, canUndo, busy, tag, focus = "all", scopeLabel = "このデッキ", onUndo, onContinue, onFinish }: StudyResultProps) {
  const labels = mode === "buzzer" ? BUZZER_RATING_LABELS : RATING_LABELS;

  return (
    <div className="result-scroll">
      <div className="result-head">
        {percent !== null && <Gauge percent={percent} />}
        {entries.length === 0 ? (
          <p className="result-comment">まだ1枚も評価していません</p>
        ) : (
          <p className="result-comment">
            {comment(percent, phaseGain).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </p>
        )}
        <div className="result-actions">
          {canContinue && (
            <button type="button" className="primary result-continue" disabled={busy} onClick={onContinue}>
              つづける
            </button>
          )}
          <button type="button" className="result-finish" disabled={busy} onClick={onFinish}>
            終了する
          </button>
          {canUndo && (
            <button type="button" className="result-undo" disabled={busy} onClick={onUndo}>
              直前の評価を取り消す
            </button>
          )}
        </div>
        {reason === "completed" && !canContinue && (
          <p className="muted">
            {focus === "weak"
              ? `${tag === null ? scopeLabel : `「${tag}」`}の苦手カードは一通り復習しました。もう一度やるなら、ホームから開き直してください。`
              : `${tag === null ? scopeLabel : `「${tag}」`}で今日出せるカードは終わりました。`}
          </p>
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
              {entry.deckName && <span className="muted result-deck">{entry.deckName}</span>}
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
