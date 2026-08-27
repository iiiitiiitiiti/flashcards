import { useCallback, useEffect, useMemo, useState } from "react";
import { pruneReviewLog, readAllHiddenCards, readAllProgress, readCardNotes, readProgress, upsertDeckCacheEntry } from "./db";
import { requestPersistentStorage } from "./quota";
import type { Deck } from "./deck";
import { DeckDetailView } from "./DeckDetailView";
import { StatsView } from "./StatsView";
import { DECK_SORTS, filterDecks, sortDecks, type DeckListItem, type DeckSort } from "./decklist";
import { loadCachedSnapshot, refreshSnapshot } from "./snapshot";
import { buildStudyQueue, countIntroducedToday, formatPercent, retentionPercent } from "./srs";
import {
  loadDeckSort,
  loadMotionPreference,
  loadNewCardsPerDay,
  loadNewCardsScope,
  loadSessionSize,
  loadStudyOrder,
  loadStudyMode,
  loadStudyTag,
  loadToken,
  saveDeckSort,
  saveSessionSize,
  saveStudyMode,
  saveStudyOrder,
  saveStudyTag,
  SESSION_SIZES,
  type SessionSize,
} from "./storage";
import { SettingsView } from "./SettingsView";
import { StudyView } from "./StudyView";
import type { DeckCacheEntry, DeckSnapshot, ProgressRecord, StudyMode, StudyOrder } from "./types";

interface DeckStats {
  due: number;
  fresh: number;
  /** 定着率（リザルトのゲージと同じ計算） */
  retentionPercent: number;
  /** この端末で最後に学習した時刻。未学習なら null */
  lastStudiedAt: number | null;
}

function Donut({ percent }: { percent: number }) {
  return (
    <div
      className="donut"
      style={{ background: `conic-gradient(var(--color-primary) ${percent * 3.6}deg, var(--color-border) 0deg)` }}
      role="img"
      aria-label={`定着率 ${formatPercent(percent)}%`}
    >
      <span>{formatPercent(percent)}%</span>
    </div>
  );
}

type View =
  | { type: "home" }
  | { type: "study"; deckId: string; progress: ProgressRecord[]; mode: StudyMode; sessionSize: SessionSize; order: StudyOrder; tag: string | null; notes: Map<string, string>; sessionId: number }
  | { type: "deck"; deckId: string }
  | { type: "stats" }
  | { type: "settings" };

/** 下ナビのタブ。学習中とカード一覧では出さない（作業に集中させる） */
const NAV_TABS = [
  { type: "home", label: "デッキ" },
  { type: "stats", label: "統計" },
  { type: "settings", label: "各種設定" },
] as const;

type NavTab = (typeof NAV_TABS)[number]["type"];

function NavIcon({ tab }: { tab: NavTab }) {
  const common = { viewBox: "0 0 24 24", width: 22, height: 22, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  if (tab === "home") {
    return (
      <svg {...common} aria-hidden="true">
        <rect x="4" y="3" width="12" height="18" rx="2" />
        <path d="M18 5v14M8 7h4M8 11h4" />
      </svg>
    );
  }
  if (tab === "stats") {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M6 20v-6M12 20V6M18 20v-9" />
      </svg>
    );
  }
  return (
    <svg {...common} aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3.5 13H3a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 4.3 6.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V2a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.8 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z" />
    </svg>
  );
}

/** 非表示のカードを取り除いたデッキ。学習にも統計にも、これを使う */
function visibleDeck(deck: Deck, hiddenIds: Set<string> | undefined): Deck {
  if (!hiddenIds || hiddenIds.size === 0) return deck;
  return { ...deck, cards: deck.cards.filter((card) => !hiddenIds.has(card.id)) };
}

function formatTimestamp(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 更新のアイコン（円を描く2本の矢印）。取得中はゆっくり回す */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={spinning ? "icon-spin" : undefined}
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 0 0-13.7-5.3L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 13.7 5.3L20 16" />
      <path d="M20 20v-4h-4" />
    </svg>
  );
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
  // セッションごとに StudyView を作り直すための連番（key に使う）
  const [sessionId, setSessionId] = useState(0);
  const [deckSearch, setDeckSearch] = useState("");
  const [deckSort, setDeckSort] = useState<DeckSort>(loadDeckSort);
  const [startSize, setStartSize] = useState<SessionSize>(loadSessionSize);
  // 開始シートで選んでいるタグと、件数を出すための進捗（シートを開いたときに1回読む）
  const [startTag, setStartTag] = useState<string | null>(null);
  const [startProgress, setStartProgress] = useState<ProgressRecord[] | null>(null);
  /** 全デッキ合計で数えるときの、今日すでに使った新規枠。デッキごとの設定なら undefined */
  const [usedNewCardsToday, setUsedNewCardsToday] = useState<number | undefined>(undefined);
  /** 出題から外したカード（デッキ id → カード id）。学習にも統計にも出さない */
  const [hidden, setHidden] = useState<Map<string, Set<string>>>(new Map());

  const refreshHidden = useCallback(async () => {
    const rows = await readAllHiddenCards();
    const map = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = map.get(row.deckId) ?? new Set<string>();
      set.add(row.cardId);
      map.set(row.deckId, set);
    }
    setHidden(map);
    return map;
  }, []);

  const updateStats = useCallback(async (target: DeckSnapshot) => {
    const now = new Date();
    const next = new Map<string, DeckStats>();
    const hiddenByDeck = await refreshHidden();
    // 全デッキ合計で数えるときは、進捗を1回だけ読んでデッキへ配る
    const allRecords = loadNewCardsScope() === "all" ? await readAllProgress() : null;
    const usedNewCardsToday = allRecords === null ? undefined : countIntroducedToday(allRecords, now);
    setUsedNewCardsToday(usedNewCardsToday);
    for (const entry of target.decks) {
      const records = allRecords === null
        ? await readProgress(entry.deckId)
        : allRecords.filter((record) => record.deckId === entry.deckId);
      const deck = visibleDeck(entry.deck, hiddenByDeck.get(entry.deckId));
      const queue = buildStudyQueue(deck, records, now, loadNewCardsPerDay(), null, usedNewCardsToday);
      const cardIds = new Set(deck.cards.map((card) => card.id));
      // ホームのドーナツとリザルトのゲージで同じ数字を出す（進捗の無いカードは 0 として効くので records だけ渡せばよい）
      const touched = records.filter((record) => cardIds.has(record.cardId)).map((record) => record.progress);
      next.set(entry.deckId, {
        due: queue.due.length,
        fresh: queue.fresh.length,
        retentionPercent: retentionPercent(touched, deck.cards.length),
        // 進捗の更新時刻の最大値を「最後に学習した時刻」として扱う
        lastStudiedAt: records.length === 0 ? null : Math.max(...records.map((record) => record.updatedAt)),
      });
    }
    setStats(next);
  }, [refreshHidden]);

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
    void requestPersistentStorage();
    // 古い評価ログを間引く（失敗しても学習には影響しないので握りつぶす）
    void pruneReviewLog().catch(() => undefined);
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

  const startingDeck = useMemo(() => {
    if (startingDeckId === null) return null;
    const entry = snapshot?.decks.find((candidate) => candidate.deckId === startingDeckId);
    return entry ? visibleDeck(entry.deck, hidden.get(startingDeckId)) : null;
  }, [snapshot, startingDeckId, hidden]);

  /** 開始シートに出すタグ一覧。カード一覧の絞り込みと同じ並び（日本語順） */
  const startTags = useMemo(() => {
    if (!startingDeck) return [];
    const tags = new Set<string>();
    for (const card of startingDeck.cards) {
      for (const tag of card.tags ?? []) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right, "ja"));
  }, [startingDeck]);

  /** 選んでいるタグでいま学習できる枚数。進捗を読み終えるまでは null */
  const startCounts = useMemo(() => {
    if (!startingDeck || startProgress === null) return null;
    const queue = buildStudyQueue(startingDeck, startProgress, new Date(), loadNewCardsPerDay(), startTag, usedNewCardsToday);
    return { due: queue.due.length, fresh: queue.fresh.length };
  }, [startingDeck, startProgress, startTag, usedNewCardsToday]);

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
        retentionPercent: deckStats?.retentionPercent ?? 0,
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

  /**
   * セッションを組むのに要る進捗を読む。
   * 「全デッキ合計」のときは、今日すでに使った新規枠もそのとき数え直す
   * （ホームへ戻らずに「つづける」で再開する経路があるため、stats の値は当てにできない）
   */
  const readStudyContext = useCallback(async (deckId: string) => {
    if (loadNewCardsScope() === "deck") {
      return { progress: await readProgress(deckId), used: undefined };
    }
    const all = await readAllProgress();
    return {
      progress: all.filter((record) => record.deckId === deckId),
      used: countIntroducedToday(all, new Date()),
    };
  }, []);

  async function startStudy(deckId: string, mode: StudyMode, sessionSize: SessionSize, order: StudyOrder, tag: string | null) {
    // 次回の既定値として選択を覚えておく（タグだけはデッキごとに覚える）
    saveStudyMode(mode);
    saveSessionSize(sessionSize);
    saveStudyOrder(order);
    saveStudyTag(deckId, tag);
    setStartingDeckId(null);
    const { progress, used } = await readStudyContext(deckId);
    const notes = new Map((await readCardNotes(deckId)).map((note) => [note.cardId, note.text]));
    setUsedNewCardsToday(used);
    setSessionId((id) => id + 1);
    setView({ type: "study", deckId, progress, mode, sessionSize, order, tag, notes, sessionId: sessionId + 1 });
  }

  /** 学習開始シートを開く。タグの初期値は前回の選択（デッキに無いタグなら「全タグ」） */
  function openStartSheet(deckId: string, deckTags: string[]) {
    const remembered = loadStudyTag(deckId);
    setStartTag(remembered !== null && deckTags.includes(remembered) ? remembered : null);
    setStartProgress(null);
    setStartingDeckId(deckId);
    void readStudyContext(deckId).then(({ progress, used }) => {
      setUsedNewCardsToday(used);
      setStartProgress(progress);
    });
  }

  function closeStudy(restart: boolean) {
    if (restart && view.type === "study") {
      // 同じ設定のまま、最新の進捗でセッションを組み直す
      void startStudy(view.deckId, view.mode, view.sessionSize, view.order, view.tag);
      return;
    }
    setView({ type: "home" });
    if (snapshot) void updateStats(snapshot);
  }

  /** タブを切り替える。設定から離れるときは、変えた内容を反映するために取り直す */
  function goToTab(tab: NavTab) {
    const leavingSettings = view.type === "settings" && tab !== "settings";
    setView({ type: tab });
    if (leavingSettings) void refresh();
  }

  const bottomNav = (
    <nav className="bottom-nav" aria-label="画面の切り替え">
      {NAV_TABS.map((tab) => (
        <button
          key={tab.type}
          type="button"
          className={`nav-tab${view.type === tab.type ? " nav-tab-current" : ""}`}
          aria-current={view.type === tab.type ? "page" : undefined}
          onClick={() => goToTab(tab.type)}
        >
          <NavIcon tab={tab.type} />
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );

  if (view.type === "settings") {
    return (
      <main className="app app-with-nav">
        <SettingsView snapshot={snapshot} />
        {bottomNav}
      </main>
    );
  }

  if (view.type === "stats") {
    return (
      <main className="app app-with-nav">
        <StatsView snapshot={snapshot} />
        {bottomNav}
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
            key={view.sessionId}
            deck={visibleDeck(entry.deck, hidden.get(view.deckId))}
            initialProgress={view.progress}
            mode={view.mode}
            sessionSize={view.sessionSize}
            order={view.order}
            tag={view.tag}
            usedNewCardsToday={usedNewCardsToday}
            initialNotes={view.notes}
            onHide={(cardId) => {
              // 統計とホームの枚数を作り直す。学習中の表示はセッション側が更新済み
              setHidden((previous) => {
                const next = new Map(previous);
                next.set(view.deckId, new Set([...(previous.get(view.deckId) ?? []), cardId]));
                return next;
              });
            }}
            onClose={closeStudy}
          />
        </main>
      );
    }
  }

  return (
    <main className="app app-with-nav">
      <header className="app-header">
        <h1>暗記カード</h1>
        <div className="button-row">
          <button
            type="button"
            className="icon-button"
            aria-label={refreshing ? "デッキ一覧を更新中" : "デッキ一覧を更新"}
            aria-busy={refreshing}
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            <RefreshIcon spinning={refreshing} />
          </button>
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
                    {entry.deck.description && <span className="deck-card-description">{entry.deck.description}</span>}
                    <span className="deck-badges">
                      {deckStats && deckStats.due > 0 && <span className="chip chip-due">復習 {deckStats.due}</span>}
                      {deckStats && deckStats.fresh > 0 && <span className="chip chip-new">新規 {deckStats.fresh}</span>}
                      {deckStats && studyCount === 0 && <span className="chip chip-done">今日は完了</span>}
                      <span className="muted">全 {entry.deck.cards.length} 枚</span>
                      {lastStudiedAt !== null && <span className="deck-last-studied">最終学習 {formatTimestamp(lastStudiedAt)}</span>}
                    </span>
                  </button>
                  <div className="deck-card-side">
                    {deckStats && <Donut percent={deckStats.retentionPercent} />}
                    <button
                      type="button"
                      className="primary"
                      disabled={studyCount === 0}
                      onClick={() => openStartSheet(entry.deckId, [...new Set(entry.deck.cards.flatMap((card) => card.tags ?? []))])}
                    >
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
            {startTags.length > 0 && (
              <div className="sheet-field">
                <span className="sheet-label">タグ</span>
                <select value={startTag ?? ""} onChange={(event) => setStartTag(event.target.value === "" ? null : event.target.value)}>
                  <option value="">全タグ</option>
                  {startTags.map((tag) => (
                    <option key={tag} value={tag}>{tag}</option>
                  ))}
                </select>
              </div>
            )}
            {startCounts !== null && (
              <p className="muted sheet-counts">
                {startTag === null ? "このデッキで" : `「${startTag}」で`}いま学習できるのは
                <strong> 復習 {startCounts.due} 枚・新規 {startCounts.fresh} 枚 </strong>
                です。
              </p>
            )}
            <p className="muted">
              {startMode === "buzzer"
                ? "問題文が1文字ずつ表示されます。押した時点で止まり、答え合わせは自己申告です。"
                : "答えを表示したあと、左スワイプで「もう一度」、右スワイプは答えるまでの速さで自動評価します。"}
              {startOrder === "random"
                ? "出題順はデッキ全体からランダムに選びます。"
                : "出題順は復習（期限が近い順）→ 新規（デッキの上から順）です。"}
            </p>
            <div className="button-row">
              <button
                type="button"
                className="primary"
                disabled={startCounts !== null && startCounts.due + startCounts.fresh === 0}
                onClick={() => void startStudy(startingDeckId, startMode, startSize, startOrder, startTag)}
              >
                開始
              </button>
              <button type="button" onClick={() => setStartingDeckId(null)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}
      {bottomNav}
    </main>
  );
}
