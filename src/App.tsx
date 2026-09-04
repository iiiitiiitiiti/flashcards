import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shouldAutoBackup, uploadBackup } from "./cloudbackup";
import { pruneReviewLog, readAllCardNotes, readAllHiddenCards, readAllProgress, readCardNotes, readProgress, upsertDeckCacheEntry } from "./db";
import { requestPersistentStorage } from "./quota";
import { isValidId, visibleDeck, type Deck, type DeckCard } from "./deck";
import { CardEditor } from "./CardEditor";
import { saveCardEdit } from "./cardactions";
import { buildSearchIndex, isSearchable, searchCards, SEARCH_LIMIT, type SearchIndexEntry } from "./cardsearch";
import { createDeck } from "./github";
import { ModalSheet } from "./ModalSheet";
import { DeckDetailView } from "./DeckDetailView";
import { StatsView } from "./StatsView";
import { DECK_SORTS, filterDecks, sortDecks, type DeckListItem, type DeckSort } from "./decklist";
import { invalidateSnapshotFetches, loadCachedSnapshot, refreshSnapshot } from "./snapshot";
import { resumePendingDeckDeletions } from "./deckcleanup";
import { buildCard, moveTargets, type CardForm } from "./deckedit";
import { buildStudyItems, buildStudyQueue, countIntroducedToday, formatPercent, isWeakCard, progressKey, retentionPercent } from "./srs";
import {
  loadAutoCloudBackup,
  loadDeckSort,
  loadLastCloudBackupAt,
  loadLastCloudBackupAttemptAt,
  loadMotionPreference,
  loadNewCardsPerDay,
  loadNewCardsScope,
  loadSessionSize,
  loadStudyOrder,
  loadStudyMode,
  loadStudyTag,
  loadToken,
  saveCloudBackupError,
  saveDeckSort,
  saveLastCloudBackupAt,
  saveLastCloudBackupAttemptAt,
  saveSessionSize,
  saveStudyMode,
  saveStudyOrder,
  saveStudyTag,
  SESSION_SIZES,
  type SessionSize,
} from "./storage";
import { SettingsView } from "./SettingsView";
import { StudyView } from "./StudyView";
import type { DeckCacheEntry, DeckSnapshot, ProgressRecord, StudyFocus, StudyMode, StudyOrder } from "./types";

/** 学習終了からバックアップ開始までの待ち。統計の再計算（進捗の全件読み）と重ねない */
const AUTO_BACKUP_DELAY_MS = 2_000;

/** 「まとめて学習」（全デッキ）を表す開始シートの対象 id。デッキ id の規約（`isValidId`）を満たさないので実デッキと衝突しない */
const ALL_DECKS = "__all__";

interface DeckStats {
  due: number;
  fresh: number;
  /** 苦手カード（`isWeakCard`）。復習が 0 でも「まとめて学習」を苦手だけで始められるかの判定に使う */
  weak: number;
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
  | {
      type: "study";
      /** 学習するデッキ。2つ以上なら「まとめて学習」 */
      deckIds: string[];
      progress: ProgressRecord[];
      mode: StudyMode;
      sessionSize: SessionSize;
      order: StudyOrder;
      tag: string | null;
      focus: StudyFocus;
      /** 苦手ドリルを開いた時刻。「つづける」で引き継ぎ、それ以降に評価したカードを出さない */
      weakSince: number | null;
      notes: Map<string, string>;
      sessionId: number;
    }
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

/** デッキ追加のアイコン。更新アイコンと線の太さ・端の丸めを揃える */
function PlusIcon() {
  return (
    <svg
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
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** デッキ追加シートの入力内容 */
interface NewDeckForm {
  id: string;
  name: string;
  description: string;
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
  /** 出題の範囲。覚えない（前回「苦手だけ」で開いた別のデッキが 0 枚・開始不可で出るのを避ける） */
  const [startFocus, setStartFocus] = useState<StudyFocus>("all");
  // セッションごとに StudyView を作り直すための連番（key に使う）
  const [sessionId, setSessionId] = useState(0);
  const [deckSearch, setDeckSearch] = useState("");
  /** 実際にカード検索へ使う検索語。デッキ詳細と同じく 200ms 遅らせる（3 万枚の走査を1文字ごとに走らせない） */
  const [appliedSearch, setAppliedSearch] = useState("");
  /** カード検索の索引。最初に検索したときに作り、デッキが変わったら次の検索で作り直す（起動時には作らない） */
  const searchIndexRef = useRef<{ decks: Deck[]; index: SearchIndexEntry[] } | null>(null);
  /** 検索結果から開いている編集フォーム */
  const [editingHit, setEditingHit] = useState<{ deckId: string; card: DeckCard } | null>(null);
  /** 検索結果からの編集・移動で伝えること（端末側の進捗を移せなかった等） */
  const [cardMessage, setCardMessage] = useState<string | null>(null);
  const [deckSort, setDeckSort] = useState<DeckSort>(loadDeckSort);
  const [startSize, setStartSize] = useState<SessionSize>(loadSessionSize);
  // 開始シートで選んでいるタグと、件数を出すための進捗（シートを開いたときに1回読む）
  const [startTag, setStartTag] = useState<string | null>(null);
  const [startProgress, setStartProgress] = useState<ProgressRecord[] | null>(null);
  /** 全デッキ合計で数えるときの、今日すでに使った新規枠。デッキごとの設定なら undefined */
  const [usedNewCardsToday, setUsedNewCardsToday] = useState<number | undefined>(undefined);
  /** 出題から外したカード（デッキ id → カード id）。学習にも統計にも出さない */
  const [hidden, setHidden] = useState<Map<string, Set<string>>>(new Map());
  /** デッキ追加シート。null なら閉じている */
  const [newDeck, setNewDeck] = useState<NewDeckForm | null>(null);
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  /** 自動バックアップの失敗をホームに1行だけ出す（成功時は何も出さない） */
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const autoBackupAttemptRef = useRef<number | null>(null);
  const viewRef = useRef<View>(view);
  viewRef.current = view;

  // トークンを登録している間だけデッキの追加・削除ができる（設定画面から戻ると再評価される）
  const canEdit = loadToken() !== "";

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
        // touched は非表示・削除済みを除いたカードの進捗だけ（孤児の進捗を苦手に数えない）
        weak: touched.filter(isWeakCard).length,
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

  /**
   * アプリから GitHub へ保存した結果でスナップショットとキャッシュを即時更新する（API 側の反映遅延を待たない）。
   * カード一覧・学習画面の両方から呼ぶ。移動では移動先・元の2デッキが一度に来るので、まとめて1回で差し替える
   * （1デッキずつ古い snapshot を元に差し替えると、後の更新が前の更新を打ち消す）
   */
  const applyDeckUpdates = useCallback(
    (...nextDecks: Deck[]) => {
      setSnapshot((current) => {
        if (!current) return current;
        const byId = new Map(nextDecks.map((deck) => [deck.id, deck]));
        const fetchedAt = Date.now();
        const decks = current.decks.map((candidate) => {
          const nextDeck = byId.get(candidate.deckId);
          if (!nextDeck) return candidate;
          void upsertDeckCacheEntry({ ...candidate, deck: nextDeck, fetchedAt });
          return { ...candidate, deck: nextDeck, fetchedAt };
        });
        const updated = { ...current, decks };
        void updateStats(updated);
        return updated;
      });
    },
    [updateStats],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await refreshSnapshot(loadToken() || null);
      // null は「新しい取得や削除に追い越された」印。古い一覧で画面を戻さない
      if (next !== null) await applySnapshot(next);
    } finally {
      setRefreshing(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    // iOS のストレージ削除対策として永続化を一度だけ要求する（拒否されても続行）
    void requestPersistentStorage();
    // 古い評価ログを間引く（失敗しても学習には影響しないので握りつぶす）
    void pruneReviewLog().catch(() => undefined);
    // 前回の削除が後片付けの途中で終わっていたら、ここでやり直す
    void resumePendingDeckDeletions();
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

  /** 非表示のカードを除いた全デッキ。「まとめて学習」と学習画面で使う（参照を固定し、キューの作り直しを抑える） */
  const sessionDecks = useMemo(
    () => (snapshot ? snapshot.decks.map((entry) => visibleDeck(entry.deck, hidden.get(entry.deckId))) : []),
    [snapshot, hidden],
  );
  const allDecks = useMemo(() => snapshot?.decks.map((entry) => entry.deck) ?? [], [snapshot]);
  const startingAll = startingDeckId === ALL_DECKS;

  /** 開始シートが対象にするデッキ。「まとめて学習」なら全デッキ */
  const startingDecks = useMemo(() => {
    if (startingDeckId === null) return [];
    if (startingDeckId === ALL_DECKS) return sessionDecks;
    const deck = sessionDecks.find((candidate) => candidate.id === startingDeckId);
    return deck ? [deck] : [];
  }, [startingDeckId, sessionDecks]);

  /** 「まとめて学習」でいま復習できるカード（タグ絞り込み前）。タグ候補と枚数の両方に使う */
  const startingAllItems = useMemo(() => {
    if (!startingAll || startProgress === null) return null;
    return buildStudyItems(startingDecks, startProgress, new Date(), {
      newCardsPerDay: loadNewCardsPerDay(),
      tag: null,
      focus: startFocus,
      weakSince: null,
      includeFresh: false,
    }).items;
  }, [startingAll, startingDecks, startProgress, startFocus]);

  /**
   * 開始シートに出すタグ一覧。1デッキならそのデッキの全タグ（カード一覧の絞り込みと同じ並び）。
   * 「まとめて学習」では**いま復習できるカードに付いているタグ**だけ（185 種を全部並べない。選んで 0 枚になる候補も出ない）
   */
  const startTags = useMemo(() => {
    const tags = new Set<string>();
    if (startingAll) {
      for (const item of startingAllItems ?? []) for (const tag of item.card.tags ?? []) tags.add(tag);
    } else {
      for (const deck of startingDecks) for (const card of deck.cards) for (const tag of card.tags ?? []) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right, "ja"));
  }, [startingAll, startingAllItems, startingDecks]);

  useEffect(() => {
    // 範囲を切り替えて候補から消えたタグを選んだままにすると、表示は「全タグ」なのに枚数が 0 で止まる
    if (startTag !== null && !startTags.includes(startTag)) setStartTag(null);
  }, [startTags, startTag]);

  /** 選んでいるタグでいま学習できる枚数。進捗を読み終えるまでは null */
  const startCounts = useMemo(() => {
    if (startingDecks.length === 0 || startProgress === null) return null;
    if (startingAll) {
      const items = (startingAllItems ?? []).filter((item) => startTag === null || (item.card.tags ?? []).includes(startTag));
      return { due: items.length, fresh: 0 };
    }
    const queue = buildStudyQueue(startingDecks[0], startProgress, new Date(), loadNewCardsPerDay(), startTag, usedNewCardsToday, startFocus);
    return { due: queue.due.length, fresh: queue.fresh.length };
  }, [startingAll, startingAllItems, startingDecks, startProgress, startTag, startFocus, usedNewCardsToday]);

  /** 全デッキでいま復習できる枚数（ホームの「まとめて学習」に出す）。統計と同じ visibleDeck 基準 */
  const totalDue = useMemo(() => [...stats.values()].reduce((total, entry) => total + entry.due, 0), [stats]);
  /** 全デッキの苦手カード。復習が 0 でも苦手があれば「まとめて学習」を押せる */
  const totalWeak = useMemo(() => [...stats.values()].reduce((total, entry) => total + entry.weak, 0), [stats]);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedSearch(deckSearch), 200);
    return () => window.clearTimeout(timer);
  }, [deckSearch]);

  /** 検索欄が 2 文字以上のときだけ、全デッキのカードを探す。null なら節を出さない */
  const cardHits = useMemo(() => {
    if (!isSearchable(appliedSearch) || allDecks.length === 0) return null;
    let cached = searchIndexRef.current;
    if (!cached || cached.decks !== allDecks) {
      cached = { decks: allDecks, index: buildSearchIndex(allDecks) };
      searchIndexRef.current = cached;
    }
    return searchCards(cached.index, appliedSearch);
  }, [appliedSearch, allDecks]);

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
  const canEditCards = loadToken() !== "";

  function handleDeckSortChange(next: DeckSort) {
    setDeckSort(next);
    saveDeckSort(next);
  }

  /**
   * カードが 0 枚のデッキを GitHub に作る。手元で重複を弾き、すり抜けても
   * `createDeck` が sha なし PUT の 422 で止める。
   */
  async function handleCreateDeck() {
    if (!newDeck || creating) return;
    const id = newDeck.id.trim();
    const name = newDeck.name.trim();
    const description = newDeck.description.trim();
    if (!isValidId(id)) {
      setCreateMessage("id は半角英数字で始め、英数字・ハイフン・アンダースコアだけで書いてください。");
      return;
    }
    if (name === "") {
      setCreateMessage("デッキ名は必須です。");
      return;
    }
    if (snapshot?.decks.some((candidate) => candidate.deckId === id)) {
      setCreateMessage(`id「${id}」のデッキは既にあります。`);
      return;
    }
    setCreating(true);
    setCreateMessage(null);
    try {
      const created = await createDeck(loadToken(), {
        schemaVersion: 1,
        id,
        name,
        ...(description !== "" ? { description } : {}),
        cards: [],
      });
      // 作成前から走っている取得が後から着地して、作ったデッキをキャッシュから消さないようにする
      invalidateSnapshotFetches();
      // blobSha は分からないので入れない（次の更新で必ず取り直される）
      const entry: DeckCacheEntry = { deckId: id, deck: created, commitSha: "", fetchedAt: Date.now() };
      // キャッシュに入らなくても GitHub 側には作れているので、失敗しても続行する
      await upsertDeckCacheEntry(entry).catch(() => undefined);
      setNewDeck(null);
      if (snapshot) await applySnapshot({ ...snapshot, decks: [...snapshot.decks, entry] });
      // 作った直後はカードが 0 枚なので、そのままカード一覧へ送る
      setView({ type: "deck", deckId: id });
    } catch (error) {
      setCreateMessage(error instanceof Error ? error.message : "デッキを作成できませんでした。");
    } finally {
      setCreating(false);
    }
  }

  /**
   * セッションを組むのに要る進捗を読む。
   * 「全デッキ合計」のときは、今日すでに使った新規枠もそのとき数え直す
   * （ホームへ戻らずに「つづける」で再開する経路があるため、stats の値は当てにできない）
   */
  const readStudyContext = useCallback(async (deckId: string) => {
    // 「まとめて学習」は新規を出さないので、新規枠の数え方は関係ない
    if (deckId === ALL_DECKS) return { progress: await readAllProgress(), used: undefined };
    if (loadNewCardsScope() === "deck") {
      return { progress: await readProgress(deckId), used: undefined };
    }
    const all = await readAllProgress();
    return {
      progress: all.filter((record) => record.deckId === deckId),
      used: countIntroducedToday(all, new Date()),
    };
  }, []);

  async function startStudy(
    deckId: string,
    mode: StudyMode,
    sessionSize: SessionSize,
    order: StudyOrder,
    tag: string | null,
    focus: StudyFocus,
    weakSince: number | null,
    /** 開始シートで既に読んだ進捗。あれば読み直さない（全デッキぶんを2回読まない） */
    preloaded: ProgressRecord[] | null = null,
  ) {
    // 次回の既定値として選択を覚えておく（タグだけはデッキごとに覚える。まとめて学習では覚えない）
    saveStudyMode(mode);
    saveSessionSize(sessionSize);
    saveStudyOrder(order);
    if (deckId !== ALL_DECKS) saveStudyTag(deckId, tag);
    setStartingDeckId(null);
    const all = deckId === ALL_DECKS;
    const { progress, used } = preloaded !== null && all ? { progress: preloaded, used: undefined } : await readStudyContext(deckId);
    const noteRows = all ? await readAllCardNotes() : await readCardNotes(deckId);
    const notes = new Map(noteRows.map((note) => [progressKey(note.deckId, note.cardId), note.text]));
    const deckIds = all ? (snapshot?.decks.map((entry) => entry.deckId) ?? []) : [deckId];
    setUsedNewCardsToday(used);
    setSessionId((id) => id + 1);
    setView({ type: "study", deckIds, progress, mode, sessionSize, order, tag, focus, weakSince, notes, sessionId: sessionId + 1 });
  }

  /** 学習開始シートを開く。タグの初期値は前回の選択（デッキに無いタグなら「全タグ」）。まとめて学習は常に「全タグ」 */
  function openStartSheet(deckId: string, deckTags: string[]) {
    const remembered = deckId === ALL_DECKS ? null : loadStudyTag(deckId);
    setStartTag(remembered !== null && deckTags.includes(remembered) ? remembered : null);
    // 「まとめて学習」で復習が 0 のときは苦手だけで開く（押した直後に 0 枚を見せない）
    setStartFocus(deckId === ALL_DECKS && totalDue === 0 && totalWeak > 0 ? "weak" : "all");
    setStartProgress(null);
    setStartingDeckId(deckId);
    void readStudyContext(deckId).then(({ progress, used }) => {
      setUsedNewCardsToday(used);
      setStartProgress(progress);
    });
  }

  /** 検索結果の編集フォームの保存。移動なら移動先・元の両方を snapshot へ反映する */
  async function saveHitCard(form: CardForm, targetDeckId: string): Promise<{ ok: boolean; message?: string }> {
    const target = editingHit;
    if (!target) return { ok: false };
    try {
      const outcome = await saveCardEdit(target.deckId, buildCard(target.card.id, form), targetDeckId, loadToken());
      applyDeckUpdates(...outcome.decks);
      setEditingHit(null);
      setCardMessage(outcome.localMessage === null ? null : `カードは移動しましたが、${outcome.localMessage}`);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "保存に失敗しました。" };
    }
  }

  function closeStudy(restart: boolean) {
    if (restart && view.type === "study") {
      // 同じ設定のまま、最新の進捗でセッションを組み直す
      void startStudy(view.deckIds.length > 1 ? ALL_DECKS : view.deckIds[0], view.mode, view.sessionSize, view.order, view.tag, view.focus, view.weakSince);
      return;
    }
    setView({ type: "home" });
    if (snapshot) void updateStats(snapshot);
    scheduleAutoBackup();
  }

  /**
   * 学習を終えてホームへ戻ったあと、条件が揃えば GitHub へ進捗を送る（1日1回）。
   * 統計の再計算と IndexedDB を取り合わないよう少し遅らせ、その間に次の学習を始めていたら送らない。
   * localStorage が書けない環境でも同じセッションで繰り返さないよう、試行時刻はメモリにも持つ
   */
  function scheduleAutoBackup() {
    const token = loadToken();
    if (token === "") return;
    globalThis.setTimeout(() => {
      if (viewRef.current.type !== "home") return;
      const now = Date.now();
      const lastAttemptAt = Math.max(loadLastCloudBackupAttemptAt() ?? Number.NEGATIVE_INFINITY, autoBackupAttemptRef.current ?? Number.NEGATIVE_INFINITY);
      const state = {
        enabled: loadAutoCloudBackup(),
        lastSuccessAt: loadLastCloudBackupAt(),
        lastAttemptAt: Number.isFinite(lastAttemptAt) ? lastAttemptAt : null,
      };
      if (!shouldAutoBackup(now, state)) return;
      autoBackupAttemptRef.current = now;
      saveLastCloudBackupAttemptAt(now);
      setBackupNotice(null);
      uploadBackup(token)
        .then((result) => {
          saveLastCloudBackupAt(result.exportedAt);
          saveCloudBackupError(null);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "GitHub への保存に失敗しました。";
          saveCloudBackupError({ at: now, message });
          setBackupNotice(`GitHub への進捗バックアップに失敗しました: ${message}`);
        });
    }, AUTO_BACKUP_DELAY_MS);
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
            onDeckUpdated={applyDeckUpdates}
            moveTargets={moveTargets(entry.deck, snapshot.decks.map((candidate) => candidate.deck))}
            onDeckDeleted={() => {
              // 削除前から走っている取得を無効にする。これをしないと、古い一覧が後から着地して
              // 消したデッキをキャッシュごと復活させる（進捗だけ失った「新規デッキ」として出る）
              invalidateSnapshotFetches();
              void applySnapshot({
                ...snapshot,
                decks: snapshot.decks.filter((candidate) => candidate.deckId !== entry.deckId),
              });
              setView({ type: "home" });
              void refresh();
            }}
          />
        </main>
      );
    }
  }

  if (view.type === "study" && snapshot) {
    // 学習中に消えたデッキは外す。全部消えていたらホームへ落ちる
    const studyDecks = sessionDecks.filter((deck) => view.deckIds.includes(deck.id));
    if (studyDecks.length > 0) {
      return (
        <main className="app study-app">
          <StudyView
            key={view.sessionId}
            decks={studyDecks}
            title={studyDecks.length > 1 ? "まとめて学習" : studyDecks[0].name}
            initialProgress={view.progress}
            mode={view.mode}
            sessionSize={view.sessionSize}
            order={view.order}
            tag={view.tag}
            focus={view.focus}
            weakSince={view.weakSince}
            usedNewCardsToday={usedNewCardsToday}
            initialNotes={view.notes}
            canEditCards={loadToken() !== ""}
            onDeckUpdated={applyDeckUpdates}
            moveTargetsFor={(deckId) => {
              const deck = allDecks.find((candidate) => candidate.id === deckId);
              return deck ? moveTargets(deck, allDecks) : [];
            }}
            onHide={(deckId, cardId) => {
              // 統計とホームの枚数を作り直す。学習中の表示はセッション側が更新済み
              setHidden((previous) => {
                const next = new Map(previous);
                next.set(deckId, new Set([...(previous.get(deckId) ?? []), cardId]));
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
          {canEdit && (
            <button
              type="button"
              className="icon-button"
              aria-label="デッキを追加"
              onClick={() => {
                setCreateMessage(null);
                setNewDeck({ id: "", name: "", description: "" });
              }}
            >
              <PlusIcon />
            </button>
          )}
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
          {backupNotice && <p className="notice warning">{backupNotice} 設定画面で確認してください。</p>}
          {snapshot.decks.length === 0 && !snapshot.offline && <p className="muted">デッキがありません。decks/ に JSON を追加してください。</p>}
          {snapshot.decks.length > 0 && (
            <div className="study-all">
              <button type="button" className="primary" disabled={totalDue === 0 && totalWeak === 0} onClick={() => openStartSheet(ALL_DECKS, [])}>
                まとめて学習
              </button>
              <span className="muted">
                {totalDue > 0
                  ? `全デッキで復習できるのは ${totalDue} 枚`
                  : totalWeak > 0
                    ? `復習はありません。苦手カードが ${totalWeak} 枚あります`
                    : "いま復習できるカードはありません"}
              </span>
            </div>
          )}
          {snapshot.decks.length > 0 && <h2>マイデッキ</h2>}
          {snapshot.decks.length > 0 && (
            <div className="deck-toolbar">
              <input
                type="text"
                value={deckSearch}
                placeholder="デッキ・カードを検索"
                onChange={(event) => setDeckSearch(event.target.value)}
              />
              <select value={deckSort} onChange={(event) => handleDeckSortChange(event.target.value as DeckSort)}>
                {DECK_SORTS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
          )}
          {snapshot.decks.length > 0 && visibleDecks.length === 0 && (cardHits === null || cardHits.total === 0) && (
            <p className="muted">該当するデッキがありません。</p>
          )}
          {cardMessage && <p className="notice warning">{cardMessage}</p>}
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
          {cardHits !== null && (
            <>
              <h2>カード</h2>
              {cardHits.total === 0 ? (
                <p className="muted">該当するカードがありません。</p>
              ) : (
                <p className="muted card-hits-summary">
                  {cardHits.total.toLocaleString("ja-JP")} 枚が該当
                  {cardHits.total > SEARCH_LIMIT && `（最初の ${SEARCH_LIMIT} 枚を表示）`}
                </p>
              )}
              <ul className="card-hits">
                {cardHits.hits.map((hit) => {
                  const isHidden = hidden.get(hit.deckId)?.has(hit.card.id) ?? false;
                  const body = (
                    <>
                      <span className="card-hit-meta">
                        <span className="chip chip-deck">{hit.deckName}</span>
                        {isHidden && <span className="chip chip-hidden">非表示</span>}
                      </span>
                      <span className="card-hit-front">{hit.card.front}</span>
                      <span className="card-hit-back muted">{hit.card.back}</span>
                    </>
                  );
                  return (
                    <li key={`${hit.deckId}/${hit.card.id}`} className="card-hit">
                      {canEditCards ? (
                        <button type="button" className="card-hit-body" onClick={() => setEditingHit({ deckId: hit.deckId, card: hit.card })}>
                          {body}
                        </button>
                      ) : (
                        <div className="card-hit-body">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!canEditCards && cardHits.total > 0 && (
                <p className="muted">編集するには、設定で GitHub トークンを登録してください。</p>
              )}
            </>
          )}
        </>
      )}
      {editingHit !== null && (() => {
        // 生のデッキ（非表示を除かない）を渡す。タグ候補が非表示カードのぶん欠けないように
        const deck = allDecks.find((candidate) => candidate.id === editingHit.deckId);
        if (!deck) return null;
        return (
          <CardEditor
            deck={deck}
            card={editingHit.card}
            moveTargets={moveTargets(deck, allDecks)}
            onSave={saveHitCard}
            onCancel={() => setEditingHit(null)}
          />
        );
      })()}
      {startingDeckId !== null && (
        <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-label="学習を開始">
          <div className="sheet">
            <h2>{startingAll ? "まとめて学習" : "学習を開始"}</h2>
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
              <span className="sheet-label">範囲</span>
              <div className="segmented">
                <button type="button" aria-pressed={startFocus === "all"} onClick={() => setStartFocus("all")}>
                  すべて
                </button>
                <button type="button" aria-pressed={startFocus === "weak"} onClick={() => setStartFocus("weak")}>
                  苦手だけ
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
            {startCounts !== null && startingAll && startFocus === "all" && (
              <p className="muted sheet-counts">
                {startTag === null ? "全デッキで" : `「${startTag}」で`}いま復習できるのは
                <strong> {startCounts.due} 枚 </strong>
                です。新規カードは出しません。
              </p>
            )}
            {startCounts !== null && !startingAll && startFocus === "all" && (
              <p className="muted sheet-counts">
                {startTag === null ? "このデッキで" : `「${startTag}」で`}いま学習できるのは
                <strong> 復習 {startCounts.due} 枚・新規 {startCounts.fresh} 枚 </strong>
                です。
              </p>
            )}
            {startCounts !== null && startFocus === "weak" && (
              <p className="muted sheet-counts">
                {startTag === null ? (startingAll ? "全デッキの" : "このデッキの") : `「${startTag}」の`}苦手カードは
                <strong> {startCounts.due} 枚 </strong>
                です。
                {startCounts.due === 0 && "3回出しても定着しない・忘れたことがある・難しさが高いカードが対象で、間隔が3週間以上になったものは外れます。"}
              </p>
            )}
            <p className="muted">
              {startMode === "buzzer"
                ? "問題文が1文字ずつ表示されます。押した時点で止まり、答え合わせは自己申告です。"
                : "答えを表示したあと、左スワイプで「もう一度」、右スワイプは答えるまでの速さで自動評価します。"}
              {startingAll && startFocus === "weak"
                ? `全デッキの苦手カードを期限前でも${startOrder === "random" ? "ランダムに" : "忘れた回数が多い順に"}出します（次回の間隔は今日から数え直します）。カードにはデッキ名を添えます。`
                : startingAll
                ? `全デッキの復習カードを${startOrder === "random" ? "ランダムに" : "期限が近い順に"}出します。カードにはデッキ名を添えます。`
                : startFocus === "weak"
                ? `苦手カードを期限前でも出します（次回の間隔は今日から数え直します）。${startOrder === "random" ? "順番はランダムです。" : "忘れた回数が多い順です。"}`
                : startOrder === "random"
                  ? "出題順はデッキ全体からランダムに選びます。"
                  : "出題順は復習（期限が近い順）→ 新規（デッキの上から順）です。"}
            </p>
            <div className="sheet-actions">
              <button
                type="button"
                className="primary"
                disabled={startCounts !== null && startCounts.due + startCounts.fresh === 0}
                onClick={() =>
                  void startStudy(startingDeckId, startMode, startSize, startOrder, startTag, startFocus, startFocus === "weak" ? Date.now() : null, startProgress)
                }
              >
                開始
              </button>
              <button type="button" onClick={() => setStartingDeckId(null)}>キャンセル</button>
            </div>
          </div>
        </div>
      )}
      {newDeck !== null && (
        <ModalSheet label="デッキを追加" onCancel={() => (creating ? undefined : setNewDeck(null))}>
          <h2>デッキを追加</h2>
          <label>
            デッキ名
            <input
              type="text"
              value={newDeck.name}
              autoFocus
              onChange={(event) => setNewDeck({ ...newDeck, name: event.target.value })}
            />
          </label>
          <label>
            id（ファイル名になります。あとから変えられません）
            <input
              type="text"
              value={newDeck.id}
              placeholder="my-deck"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setNewDeck({ ...newDeck, id: event.target.value })}
            />
          </label>
          <label>
            説明（任意）
            <input
              type="text"
              value={newDeck.description}
              onChange={(event) => setNewDeck({ ...newDeck, description: event.target.value })}
            />
          </label>
          <p className="muted">id には半角の英数字・ハイフン・アンダースコアが使えます。カードは作成後に追加します。</p>
          {createMessage && <p className="notice warning">{createMessage}</p>}
          <div className="sheet-actions">
            <button type="button" className="primary" disabled={creating} onClick={() => void handleCreateDeck()}>
              {creating ? "作成中…" : "GitHubへ作成"}
            </button>
            <button type="button" disabled={creating} onClick={() => setNewDeck(null)}>キャンセル</button>
          </div>
        </ModalSheet>
      )}
      {bottomNav}
    </main>
  );
}
