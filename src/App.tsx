import { useCallback, useEffect, useState } from "react";
import { readProgress } from "./db";
import { loadCachedSnapshot, refreshSnapshot } from "./snapshot";
import { buildStudyQueue } from "./srs";
import { loadToken } from "./storage";
import { StudyView } from "./StudyView";
import type { DeckSnapshot, ProgressRecord } from "./types";

interface DeckStats {
  due: number;
  fresh: number;
}

type View = { type: "home" } | { type: "study"; deckId: string; progress: ProgressRecord[] };

function formatTimestamp(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function App() {
  const [snapshot, setSnapshot] = useState<DeckSnapshot | null>(null);
  const [stats, setStats] = useState<Map<string, DeckStats>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<View>({ type: "home" });

  const updateStats = useCallback(async (target: DeckSnapshot) => {
    const now = new Date();
    const next = new Map<string, DeckStats>();
    for (const entry of target.decks) {
      const queue = buildStudyQueue(entry.deck, await readProgress(entry.deckId), now);
      next.set(entry.deckId, { due: queue.due.length, fresh: queue.fresh.length });
    }
    setStats(next);
  }, []);

  const applySnapshot = useCallback(
    async (target: DeckSnapshot) => {
      setSnapshot(target);
      await updateStats(target);
    },
    [updateStats],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await applySnapshot(await refreshSnapshot(loadToken() || null));
    } finally {
      setRefreshing(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    // まずキャッシュを即表示し、裏で最新化する
    let cancelled = false;
    void loadCachedSnapshot().then((cached) => {
      if (!cancelled && cached.decks.length > 0) {
        setSnapshot((current) => current ?? cached);
        void updateStats(cached);
      }
    });
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [refresh, updateStats]);

  async function startStudy(deckId: string) {
    setView({ type: "study", deckId, progress: await readProgress(deckId) });
  }

  function closeStudy() {
    setView({ type: "home" });
    if (snapshot) void updateStats(snapshot);
  }

  if (view.type === "study" && snapshot) {
    const entry = snapshot.decks.find((candidate) => candidate.deckId === view.deckId);
    if (entry) {
      return (
        <main className="app">
          <StudyView deck={entry.deck} initialProgress={view.progress} onClose={closeStudy} />
        </main>
      );
    }
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1>暗記カード</h1>
        <button type="button" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "更新中…" : "更新"}
        </button>
      </header>
      {snapshot === null ? (
        <p className="muted">読み込み中…</p>
      ) : (
        <>
          {snapshot.offline && (
            <p className="notice">
              オフライン
              {snapshot.fetchedAt !== null ? `: ${formatTimestamp(snapshot.fetchedAt)} 時点のデータ` : "（取得済みデータがありません）"}
            </p>
          )}
          {snapshot.warnings.map((warning) => (
            <p key={warning} className="notice warning">{warning}</p>
          ))}
          {snapshot.decks.length === 0 && !snapshot.offline && <p className="muted">デッキがありません。decks/ に JSON を追加してください。</p>}
          <ul className="deck-list">
            {snapshot.decks.map((entry) => {
              const deckStats = stats.get(entry.deckId);
              const studyCount = (deckStats?.due ?? 0) + (deckStats?.fresh ?? 0);
              return (
                <li key={entry.deckId} className="deck-card">
                  <div className="deck-card-body">
                    <strong>{entry.deck.name}</strong>
                    {entry.deck.description && <span className="muted">{entry.deck.description}</span>}
                    <span className="muted">
                      全 {entry.deck.cards.length} 枚
                      {deckStats && ` ・ 期限切れ ${deckStats.due} / 新規 ${deckStats.fresh}`}
                    </span>
                  </div>
                  <button type="button" className="primary" disabled={studyCount === 0} onClick={() => void startStudy(entry.deckId)}>
                    {studyCount === 0 ? "完了" : "学習する"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
