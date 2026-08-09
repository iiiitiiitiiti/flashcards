import { useCallback, useEffect, useState } from "react";
import { loadCachedSnapshot, refreshSnapshot } from "./snapshot";
import { loadToken } from "./storage";
import type { DeckSnapshot } from "./types";

function formatTimestamp(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function App() {
  const [snapshot, setSnapshot] = useState<DeckSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setSnapshot(await refreshSnapshot(loadToken() || null));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    // まずキャッシュを即表示し、裏で最新化する
    let cancelled = false;
    void loadCachedSnapshot().then((cached) => {
      if (!cancelled && cached.decks.length > 0) setSnapshot((current) => current ?? cached);
    });
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

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
            {snapshot.decks.map((entry) => (
              <li key={entry.deckId} className="deck-card">
                <div className="deck-card-body">
                  <strong>{entry.deck.name}</strong>
                  {entry.deck.description && <span className="muted">{entry.deck.description}</span>}
                  <span className="muted">{entry.deck.cards.length} 枚</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
