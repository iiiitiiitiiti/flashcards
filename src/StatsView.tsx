import { useEffect, useMemo, useState } from "react";
import { readAllHiddenCards, readAllProgress, readAllReviewLog } from "./db";
import { dayKey } from "./srs";
import {
  buildMonthCells,
  isFutureMonth,
  shiftMonth,
  studiedDays,
  summarizeDay,
  summarizeTotal,
  type DailyStats,
  type TotalStats,
} from "./stats";
import type { DeckSnapshot, ProgressRecord, ReviewLogEntry } from "./types";

interface StatsViewProps {
  snapshot: DeckSnapshot | null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  const today = useMemo(() => dayKey(new Date()), []);
  const [selected, setSelected] = useState(today);
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

  const nextMonth = shiftMonth(cursor.year, cursor.month, 1);
  const canGoNext = !isFutureMonth(nextMonth.year, nextMonth.month, new Date());
  const selectedLabel = selected.replace(/-/g, "/");

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
      </p>
    </section>
  );
}
