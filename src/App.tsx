import { useCallback, useEffect, useMemo, useState } from "react";
import { readProgress, upsertDeckCacheEntry } from "./db";
import { DeckDetailView } from "./DeckDetailView";
import { DECK_SORTS, filterDecks, sortDecks, type DeckListItem, type DeckSort } from "./decklist";
import { loadCachedSnapshot, refreshSnapshot } from "./snapshot";
import { buildStudyQueue } from "./srs";
import {
  loadDeckSort,
  loadMotionPreference,
  loadNewCardsPerDay,
  loadSessionSize,
  loadStudyOrder,
  loadStudyMode,
  loadToken,
  saveDeckSort,
  saveSessionSize,
  saveStudyMode,
  saveStudyOrder,
  SESSION_SIZES,
  type SessionSize,
} from "./storage";
import { SettingsView } from "./SettingsView";
import { StudyView } from "./StudyView";
import type { DeckCacheEntry, DeckSnapshot, ProgressRecord, StudyMode, StudyOrder } from "./types";

interface DeckStats {
  due: number;
  fresh: number;
  /** FSRS の Review 状態（定着）に達したカードの割合 */
  learnedPercent: number;
  /** この端末で最後に学習した時刻。未学習なら null */
  lastStudiedAt: number | null;
}

const FSRS_STATE_REVIEW = 2;

function Donut({ percent }: { percent: number }) {
  return (
    <div
      className="donut"
      style={{ background: `conic-gradient(var(--color-primary) ${percent * 3.6}deg, var(--color-border) 0deg)` }}
      role="img"
      aria-label={`定着率 ${percent}%`}
    >
      <span>{percent}%</span>
    </div>
  );
}

type View =
  | { type: "home" }
  | { type: "study"; deckId: string; progress: ProgressRecord[]; mode: StudyMode; sessionSize: SessionSize; order: StudyOrder }
  | { type: "deck"; deckId: string }
  | { type: "settings" };

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
  // 学習開始シート（モードと枚数を選んでから始める）
  const [startingDeckId, setStartingDeckId] = useState<string | null>(null);
  const [startMode, setStartMode] = useState<StudyMode>(loadStudyMode);
  const [startOrder, setStartOrder] = useState<StudyOrder>(loadStudyOrder);
  const [deckSearch, setDeckSearch] = useState("");
  const [deckSort, setDeckSort] = useState<DeckSort>(loadDeckSort);
  const [startSize, setStartSize] = useState<SessionSize>(loadSessionSize);

  const updateStats = useCallback(async (target: DeckSnapshot) => {
    const now = new Date();
    const next = new Map<string, DeckStats>();
    for (const entry of target.decks) {
      const records = await readProgress(entry.deckId);
      const queue = buildStudyQueue(entry.deck, records, now, loadNewCardsPerDay());
      const cardIds = new Set(entry.deck.cards.map((card) => card.id));
      const learned = records.filter((record) => cardIds.has(record.cardId) && record.progress.state === FSRS_STATE_REVIEW).length;
      next.set(entry.deckId, {
        due: queue.due.length,
        fresh: queue.fresh.length,
        learnedPercent: entry.deck.cards.length === 0 ? 0 : Math.round((learned / entry.deck.cards.length) * 100),
        // 進捗の更新時刻の最大値を「最後に学習した時刻」として扱う
        lastStudiedAt: records.length === 0 ? null : Math.max(...records.map((record) => record.updatedAt)),
      });
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
    // iOS のストレージ削除対策として永続化を一度だけ要求する（拒否されても続行）
    void navigator.storage?.persist?.().catch(() => undefined);
    // アニメーション設定を反映（OS の視差効果設定は参照しない）
    document.documentElement.dataset.motion = loadMotionPreference();
  }, []);

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

  const deckItems = useMemo<(DeckListItem & { entry: DeckCacheEntry })[]>(() => {
    if (!snapshot) return [];
    return snapshot.decks.map((entry) => {
      const deckStats = stats.get(entry.deckId);
      return {
        entry,
        deckId: entry.deckId,
        name: entry.deck.name,
        description: entry.deck.description,
        cardCount: entry.deck.cards.length,
        todo: (deckStats?.due ?? 0) + (deckStats?.fresh ?? 0),
        learnedPercent: deckStats?.learnedPercent ?? 0,
        lastStudiedAt: deckStats?.lastStudiedAt ?? null,
      };
    });
  }, [snapshot, stats]);

  const visibleDecks = useMemo(
    () => sortDecks(filterDecks(deckItems, deckSearch), deckSort),
    [deckItems, deckSearch, deckSort],
  );

  function handleDeckSortChange(next: DeckSort) {
    setDeckSort(next);
    saveDeckSort(next);
  }

  async function startStudy(deckId: string, mode: StudyMode, sessionSize: SessionSize, order: StudyOrder) {
    // 次回の既定値として選択を覚えておく
    saveStudyMode(mode);
    saveSessionSize(sessionSize);
    saveStudyOrder(order);
    setStartingDeckId(null);
    setView({ type: "study", deckId, progress: await readProgress(deckId), mode, sessionSize, order });
  }

  function closeStudy() {
    setView({ type: "home" });
    if (snapshot) void updateStats(snapshot);
  }

  if (view.type === "settings") {
    return (
      <main className="app">
        <SettingsView
          snapshot={snapshot}
          onClose={() => {
            setView({ type: "home" });
            void refresh();
          }}
        />
      </main>
    );
  }

  if (view.type === "deck" && snapshot) {
    const entry = snapshot.decks.find((candidate) => candidate.deckId === view.deckId);
    if (entry) {
      return (
        <main className="app">
          <DeckDetailView
            deck={entry.deck}
            onClose={() => {
              setView({ type: "home" });
              // デッキ詳細での進捗リセットをホームの件数・ゲージへ反映する
              void updateStats(snapshot);
            }}
            onDeckUpdated={(nextDeck) => {
              // GitHub API 側の反映遅延を待たず、保存結果でスナップショットとキャッシュを即時更新する
              const updated: DeckSnapshot = {
                ...snapshot,
                decks: snapshot.decks.map((candidate) =>
                  candidate.deckId === entry.deckId ? { ...candidate, deck: nextDeck, fetchedAt: Date.now() } : candidate,
                ),
              };
              void upsertDeckCacheEntry({ ...entry, deck: nextDeck, fetchedAt: Date.now() });
              void applySnapshot(updated);
            }}
          />
        </main>
      );
    }
  }

  if (view.type === "study" && snapshot) {
    const entry = snapshot.decks.find((candidate) => candidate.deckId === view.deckId);
    if (entry) {
      return (
        <main className="app study-app">
          <StudyView
            deck={entry.deck}
            initialProgress={view.progress}
            mode={view.mode}
            sessionSize={view.sessionSize}
            order={view.order}
            onClose={closeStudy}
          />
        </main>
      );
    }
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1>暗記カード</h1>
        <div className="button-row">
          <button type="button" onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "更新中…" : "更新"}
          </button>
          <button type="button" onClick={() => setView({ type: "settings" })}>設定</button>
        </div>
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
          {snapshot.decks.length > 0 && <h2>マイデッキ</h2>}
          {snapshot.decks.length > 0 && (
            <div className="deck-toolbar">
              <input
                type="text"
                value={deckSearch}
                placeholder="デッキを検索"
                onChange={(event) => setDeckSearch(event.target.value)}
              />
              <select value={deckSort} onChange={(event) => handleDeckSortChange(event.target.value as DeckSort)}>
                {DECK_SORTS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          )}
          {snapshot.decks.length > 0 && visibleDecks.length === 0 && (
            <p className="muted">該当するデッキがありません。</p>
          )}
          <ul className="deck-list">
            {visibleDecks.map(({ entry, todo: studyCount, lastStudiedAt }) => {
              const deckStats = stats.get(entry.deckId);
              return (
                <li key={entry.deckId} className="deck-card">
                  <button type="button" className="deck-card-body" onClick={() => setView({ type: "deck", deckId: entry.deckId })}>
                    <strong>{entry.deck.name}</strong>
                    {entry.deck.description && <span className="muted">{entry.deck.description}</span>}
                    <span className="deck-badges">
                      {deckStats && deckStats.due > 0 && <span className="chip chip-due">復習 {deckStats.due}</span>}
                      {deckStats && deckStats.fresh > 0 && <span className="chip chip-new">新規 {deckStats.fresh}</span>}
                      {deckStats && studyCount === 0 && <span className="chip chip-done">今日は完了</span>}
                      <span className="muted">全 {entry.deck.cards.length} 枚</span>
                      {lastStudiedAt !== null && <span className="muted">最終学習 {formatTimestamp(lastStudiedAt)}</span>}
                    </span>
                  </button>
                  <div className="deck-card-side">
                    {deckStats && <Donut percent={deckStats.learnedPercent} />}
                    <button type="button" className="primary" disabled={studyCount === 0} onClick={() => setStartingDeckId(entry.deckId)}>
                      {studyCount === 0 ? "完了" : "学習する"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {startingDeckId !== null && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="学習を開始">
          <div className="sheet">
            <h2>学習を開始</h2>
            <div className="sheet-field">
              <span className="sheet-label">モード</span>
              <div className="segmented">
                <button type="button" aria-pressed={startMode === "normal"} onClick={() => setStartMode("normal")}>
                  通常
                </button>
                <button type="button" aria-pressed={startMode === "buzzer"} onClick={() => setStartMode("buzzer")}>
                  早押し
                </button>
              </div>
            </div>
            <div className="sheet-field">
              <span className="sheet-label">出題順</span>
              <div className="segmented">
                <button type="button" aria-pressed={startOrder === "sequential"} onClick={() => setStartOrder("sequential")}>
                  順番どおり
                </button>
                <button type="button" aria-pressed={startOrder === "random"} onClick={() => setStartOrder("random")}>
                  ランダム
                </button>
              </div>
            </div>
            <div className="sheet-field">
              <span className="sheet-label">枚数</span>
              <div className="segmented">
                {SESSION_SIZES.map((size) => (
                  <button key={size} type="button" aria-pressed={startSize === size} onClick={() => setStartSize(size)}>
                    {size}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted">
              {startMode === "buzzer"
                ? "問題文が1文字ずつ表示されます。押した時点で止まり、答え合わせは自己申告です。"
                : "答えを表示したあと、左スワイプで「もう一度」、右スワイプは答えるまでの速さで自動評価します。"}
              {startOrder === "random"
                ? "出題順はデッキ全体からランダムに選びます。"
                : "出題順は復習（期限が近い順）→ 新規（デッキの上から順）です。"}
            </p>
            <div className="button-row">
              <button type="button" className="primary" onClick={() => void startStudy(startingDeckId, startMode, startSize, startOrder)}>
                開始
              </button>
              <button type="button" onClick={() => setStartingDeckId(null)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
