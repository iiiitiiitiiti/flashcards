import { useEffect, useMemo, useState } from "react";
import { readAllHiddenCards, readAllProgress, readAllReviewLog } from "./db";
import { visibleDeck } from "./deck";
import { dayKey, formatPercent } from "./srs";
import {
  buildMonthCells,
  buildVisibleCardIndex,
  dueForecast,
  isCommonTag,
  isFutureMonth,
  monthlyTrend,
  shiftMonth,
  studiedDays,
  summarizeDay,
  summarizeDecks,
  summarizeTags,
  summarizeTotal,
  summarizeTrend,
  tallyByDay,
  type DailyStats,
  type ForecastDay,
  type TotalStats,
  type TrendDay,
} from "./stats";
import type { DeckSnapshot, ProgressRecord, ReviewLogEntry } from "./types";

interface StatsViewProps {
  snapshot: DeckSnapshot | null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

/** 復習予定はいつも 30 日ぶん数え、7 日表示は先頭を切り出す（切替のたびに進捗全件を走査しない） */
const FORECAST_DAYS = 30;
type ForecastSpan = 7 | 30;

/** 棒グラフの棒の最大高さ（px）。軸ラベルのぶんは別に取る */
const BAR_HEIGHT = 96;

/** 0 は棒を出さず、1 枚でも見えるよう 2px を下限にする */
function barHeight(value: number, max: number): number {
  if (value <= 0) return 0;
  return Math.max(2, Math.round((value / Math.max(1, max)) * BAR_HEIGHT));
}

/** 月の日別。棒は「正解」の上に「もう一度」を積む。カレンダーで選んだ日は縁取る */
function TrendChart({ days, selected, label }: { days: TrendDay[]; selected: string; label: string }) {
  const max = Math.max(...days.map((day) => day.reviewed));
  const last = days.length;
  return (
    <div className="bar-chart" role="img" aria-label={label}>
      {days.map((day) => {
        const height = barHeight(day.reviewed, max);
        const again = day.reviewed === 0 ? 0 : Math.round(((day.reviewed - day.correct) / day.reviewed) * height);
        // 1・10・20・末日。末日の直前の 30 は末日と重なるので出さない
        const axis = day.day === 1 || day.day === last || (day.day % 10 === 0 && last - day.day >= 3) ? String(day.day) : "";
        return (
          <span key={day.key} className={`bar-col${day.key === selected ? " bar-col-selected" : ""}`}>
            <span className="bar" style={{ height }}>
              <span className="bar-again" style={{ height: again }} />
            </span>
            <span className="bar-axis">{axis}</span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * 復習予定。今日の棒には期限切れも積まれて突出しやすいので、高さの基準は明日以降の最大値にし、
 * 今日がそれを超えるときは満杯（濃色）で止める。枚数は見出し下の1行で読む
 */
function ForecastChart({ days, span, label }: { days: ForecastDay[]; span: ForecastSpan; label: string }) {
  const max = Math.max(...days.slice(1).map((day) => day.count));
  const today = days[0];
  return (
    <div className="bar-chart" role="img" aria-label={label}>
      {days.map((day, offset) => {
        const over = offset === 0 && day.count > max;
        const height = over ? BAR_HEIGHT : barHeight(day.count, max);
        let axis = "";
        if (offset === 0) axis = "今日";
        else if (span === 7) axis = WEEKDAYS_JA[new Date(`${day.key}T00:00:00+09:00`).getDay()];
        else if ((offset + 1) % 10 === 0) axis = day.key.slice(5).replace(/^0/, "").replace("-", "/").replace("/0", "/");
        return (
          <span key={day.key} className="bar-col">
            <span className={`bar${offset === 0 ? " bar-today" : ""}${over ? " bar-over" : ""}`} style={{ height }} title={offset === 0 ? `今日 ${today.count} 枚` : undefined} />
            <span className="bar-axis">{axis}</span>
          </span>
        );
      })}
    </div>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

function CardsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="12" height="14" rx="2" />
      <path d="M8 3h9a2 2 0 0 1 2 2v11" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.7l5.4-.8z" />
    </svg>
  );
}

function DeckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="12" height="18" rx="2" />
      <path d="M18 5v14" />
    </svg>
  );
}

function DoneDeckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="3" width="12" height="18" rx="2" />
      <path d="M18 5v14M7 12l2.5 2.5L14 10" />
    </svg>
  );
}

function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        <span className="stat-icon" aria-hidden="true">{icon}</span>
        <strong>{value.toLocaleString("ja-JP")}</strong>
      </span>
    </div>
  );
}

export function StatsView({ snapshot }: StatsViewProps) {
  const [logs, setLogs] = useState<ReviewLogEntry[] | null>(null);
  const [records, setRecords] = useState<ProgressRecord[]>([]);
  const [hiddenByDeck, setHiddenByDeck] = useState<Map<string, Set<string>>>(new Map());
  /** 開いた時刻。集計の「今」と今日の判定に使う（描画ごとに作り直すと全集計が無効化される） */
  const now = useMemo(() => new Date(), []);
  const today = useMemo(() => dayKey(now), [now]);
  const [selected, setSelected] = useState(today);
  const [forecastSpan, setForecastSpan] = useState<ForecastSpan>(7);
  /** タグ別を全タグに広げているか。既定は ★ と「出題済み」だけ。覚えない */
  const [allTagsShown, setAllTagsShown] = useState(false);
  const [cursor, setCursor] = useState(() => {
    const [year, month] = today.split("-").map(Number);
    return { year, month };
  });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([readAllReviewLog(), readAllProgress(), readAllHiddenCards()]).then(([log, progress, hidden]) => {
      if (cancelled) return;
      const map = new Map<string, Set<string>>();
      for (const row of hidden) {
        const set = map.get(row.deckId) ?? new Set<string>();
        set.add(row.cardId);
        map.set(row.deckId, set);
      }
      setHiddenByDeck(map);
      setRecords(progress);
      setLogs(log);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const cells = useMemo(() => buildMonthCells(cursor.year, cursor.month), [cursor]);
  const marked = useMemo(() => studiedDays(logs ?? []), [logs]);
  const daily: DailyStats = useMemo(() => summarizeDay(logs ?? [], records, selected), [logs, records, selected]);

  /** 「暗記済みデッキ」の判定に使う枚数。非表示のカードは数えない（出題されないため） */
  const deckCardCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of snapshot?.decks ?? []) {
      const hidden = hiddenByDeck.get(entry.deckId);
      counts.set(entry.deckId, entry.deck.cards.filter((card) => !hidden?.has(card.id)).length);
    }
    return counts;
  }, [snapshot, hiddenByDeck]);

  const total: TotalStats = useMemo(
    () => summarizeTotal(logs ?? [], records, deckCardCounts),
    [logs, records, deckCardCounts],
  );

  const loading = logs === null;
  const tally = useMemo(() => tallyByDay(logs ?? []), [logs]);
  const trend = useMemo(() => monthlyTrend(tally, cursor.year, cursor.month), [tally, cursor]);
  const trendSummary = useMemo(() => summarizeTrend(trend), [trend]);
  /** 復習予定とデッキ別の対象。ホームと同じ visibleDeck（非表示を除く） */
  const decks = useMemo(
    () => (snapshot?.decks ?? []).map((entry) => visibleDeck(entry.deck, hiddenByDeck.get(entry.deckId))),
    [snapshot, hiddenByDeck],
  );
  const forecast = useMemo(() => dueForecast(records, buildVisibleCardIndex(decks), now, FORECAST_DAYS), [records, decks, now]);
  const forecastDays = useMemo(() => forecast.days.slice(0, forecastSpan), [forecast, forecastSpan]);
  const forecastTotal = forecastDays.reduce((sum, day) => sum + day.count, 0);
  const breakdown = useMemo(() => summarizeDecks(decks, records, now), [decks, records, now]);
  const tagRows = useMemo(() => summarizeTags(decks, records, now), [decks, records, now]);
  const commonTagRows = useMemo(() => tagRows.filter((row) => isCommonTag(row.tag)), [tagRows]);
  /** ★ も出題済みも無いデータ（手書きデッキだけ）なら、絞る意味が無いので最初から全タグ */
  const canNarrowTags = commonTagRows.length > 0 && commonTagRows.length < tagRows.length;
  const shownTagRows = allTagsShown || !canNarrowTags ? tagRows : commonTagRows;

  const nextMonth = shiftMonth(cursor.year, cursor.month, 1);
  const canGoNext = !isFutureMonth(nextMonth.year, nextMonth.month, new Date());
  const selectedLabel = selected.replace(/-/g, "/");
  const monthLabel = `${cursor.year}/${String(cursor.month).padStart(2, "0")}`;

  return (
    <section>
      <header className="app-header app-header-centered">
        <h1>統計</h1>
      </header>

      <div className="calendar">
        <div className="calendar-head">
          <button
            type="button"
            className="icon-button"
            aria-label="前の月"
            onClick={() => setCursor(shiftMonth(cursor.year, cursor.month, -1))}
          >
            ‹
          </button>
          <span className="calendar-title">
            {cursor.year}/{String(cursor.month).padStart(2, "0")}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="次の月"
            disabled={!canGoNext}
            onClick={() => setCursor(nextMonth)}
          >
            ›
          </button>
        </div>
        <div className="calendar-weekdays">
          {WEEKDAYS.map((name) => (
            <span key={name}>{name}</span>
          ))}
        </div>
        <div className="calendar-grid">
          {cells.map((cell, index) =>
            cell.key === null ? (
              <span key={`blank-${index}`} className="calendar-cell calendar-blank" />
            ) : (
              <button
                key={cell.key}
                type="button"
                className={`calendar-cell${cell.key === selected ? " calendar-cell-selected" : ""}${cell.key === today ? " calendar-cell-today" : ""}`}
                aria-current={cell.key === selected ? "date" : undefined}
                onClick={() => setSelected(cell.key as string)}
              >
                {cell.day}
                {marked.has(cell.key) && <span className="calendar-dot" aria-label="学習した日" />}
              </button>
            ),
          )}
        </div>
      </div>

      <h2>学習状況（{selectedLabel}）</h2>
      <div className="stat-grid">
        <StatCard label="プレイ時間(分)" value={daily.playMinutes} icon={<ClockIcon />} />
        <StatCard label="めくったカード(枚)" value={daily.reviewedCards} icon={<CardsIcon />} />
        <StatCard label="新規出題カード(枚)" value={daily.newCards} icon={<PlusIcon />} />
      </div>

      <h2>日別の推移（{monthLabel}）</h2>
      {trendSummary.percent === null ? (
        !loading && <p className="muted">この月はまだ学習していません。</p>
      ) : (
        <>
          <p className="stats-summary">
            めくったカード {trendSummary.reviewed.toLocaleString("ja-JP")} 枚・正答率 {trendSummary.percent}%
          </p>
          <TrendChart
            days={trend}
            selected={selected}
            label={`${monthLabel} の日別: めくったカード ${trendSummary.reviewed} 枚、正答率 ${trendSummary.percent}%`}
          />
          <p className="bar-legend">
            <span className="bar-legend-correct">正解</span>
            <span className="bar-legend-again">もう一度</span>
          </p>
        </>
      )}

      <div className="section-head">
        <h2>復習予定</h2>
        <div className="segment" role="group" aria-label="期間">
          {([7, 30] as ForecastSpan[]).map((span) => (
            <button key={span} type="button" aria-pressed={forecastSpan === span} onClick={() => setForecastSpan(span)}>
              {span}日
            </button>
          ))}
        </div>
      </div>
      {!loading && snapshot === null && <p className="muted">デッキを読み込むと出ます。</p>}
      {!loading && snapshot !== null && forecastTotal === 0 && (
        <p className="muted">今日から{forecastSpan}日のあいだに期限が来るカードはありません。</p>
      )}
      {!loading && snapshot !== null && forecastTotal > 0 && (
        <>
          <p className="stats-summary">
            期限が来るカード {forecastTotal.toLocaleString("ja-JP")} 枚・いま復習できるのは {forecast.dueNow.toLocaleString("ja-JP")} 枚
          </p>
          <ForecastChart
            days={forecastDays}
            span={forecastSpan}
            label={`今日から${forecastSpan}日の復習予定: 合計 ${forecastTotal} 枚、今日 ${forecastDays[0].count} 枚`}
          />
        </>
      )}

      <h2>デッキ別</h2>
      {!loading && snapshot === null && <p className="muted">デッキを読み込むと出ます。</p>}
      {!loading && snapshot !== null && breakdown.length === 0 && <p className="muted">デッキがありません。</p>}
      {!loading && breakdown.length > 0 && (
        <table className="deck-table">
          <caption className="visually-hidden">デッキごとの定着率・復習できる枚数・苦手カードの枚数</caption>
          <thead>
            <tr>
              <th scope="col">デッキ</th>
              <th scope="col">定着率</th>
              <th scope="col">復習</th>
              <th scope="col">苦手</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((row) => (
              <tr key={row.deckId}>
                <th scope="row">
                  <span className="deck-table-name">{row.name}</span>
                  <span className="deck-table-count">{row.cardCount.toLocaleString("ja-JP")}枚</span>
                </th>
                <td>
                  <span className="deck-bar" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, row.retentionPercent)}%` }} />
                  </span>
                  {formatPercent(row.retentionPercent)}%
                </td>
                <td className={row.due === 0 ? "deck-table-zero" : undefined}>{row.due.toLocaleString("ja-JP")}</td>
                <td className={row.weak === 0 ? "deck-table-zero" : undefined}>{row.weak.toLocaleString("ja-JP")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="section-head">
        <h2>タグ別</h2>
        {!loading && canNarrowTags && (
          <button
            type="button"
            className="link-button"
            aria-expanded={allTagsShown}
            aria-controls="tag-table"
            onClick={() => setAllTagsShown((shown) => !shown)}
          >
            {allTagsShown ? "★と出題済みだけにする" : `すべてのタグを表示（${tagRows.length.toLocaleString("ja-JP")} 種）`}
          </button>
        )}
      </div>
      {!loading && snapshot === null && <p className="muted">デッキを読み込むと出ます。</p>}
      {!loading && snapshot !== null && tagRows.length === 0 && <p className="muted">タグの付いたカードがありません。</p>}
      {!loading && snapshot !== null && shownTagRows.length > 0 && (
        <table className="deck-table" id="tag-table">
          <caption className="visually-hidden">タグごとの定着率・復習できる枚数・苦手カードの枚数</caption>
          <thead>
            <tr>
              <th scope="col">タグ</th>
              <th scope="col">定着率</th>
              <th scope="col">復習</th>
              <th scope="col">苦手</th>
            </tr>
          </thead>
          <tbody>
            {shownTagRows.map((row) => (
              <tr key={row.tag}>
                <th scope="row">
                  <span className="deck-table-name">{row.tag}</span>
                  <span className="deck-table-count">{row.cardCount.toLocaleString("ja-JP")}枚</span>
                </th>
                <td>
                  <span className="deck-bar" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, row.retentionPercent)}%` }} />
                  </span>
                  {formatPercent(row.retentionPercent)}%
                </td>
                <td className={row.due === 0 ? "deck-table-zero" : undefined}>{row.due.toLocaleString("ja-JP")}</td>
                <td className={row.weak === 0 ? "deck-table-zero" : undefined}>{row.weak.toLocaleString("ja-JP")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>学習状況（全期間）</h2>
      <div className="stat-grid">
        <StatCard label="プレイ時間(分)" value={total.playMinutes} icon={<ClockIcon />} />
        <StatCard label="めくったカード(枚)" value={total.reviewedCards} icon={<CardsIcon />} />
        <StatCard label="新規出題カード(枚)" value={total.newCards} icon={<PlusIcon />} />
        <StatCard label="暗記済みカード(枚)" value={total.memorizedCards} icon={<StarIcon />} />
        <StatCard label="プレイしたデッキ" value={total.playedDecks} icon={<DeckIcon />} />
        <StatCard label="暗記済みデッキ" value={total.memorizedDecks} icon={<DoneDeckIcon />} />
      </div>

      {logs !== null && logs.length === 0 && (
        <p className="muted">まだ学習の記録がありません。デッキを1枚めくると、ここに出ます。</p>
      )}
      <p className="muted stats-note">
        プレイ時間は2026年8月26日以降に学習したぶんだけ記録されます。1枚あたり5分を超えた時間は、席を外したものとして数えません。
        復習予定・デッキ別・タグ別は、非表示のカードと消えたデッキを数えません。タグ別は複数のタグを持つカードをそれぞれのタグに数えるので、行の合計は総枚数と一致しません。
        日別の推移は直近400日の記録から集計し、非表示のカードも含みます。
      </p>
    </section>
  );
}
