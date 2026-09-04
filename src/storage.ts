import { DEFAULT_RATING_THRESHOLDS, NEW_CARDS_PER_DAY, NEW_CARDS_PER_DAY_OPTIONS, normalizeRatingThresholds } from "./srs";
import { DECK_SORTS, type DeckSort } from "./decklist";
import type { NewCardsScope, RatingThresholds, StudyMode, StudyOrder } from "./types";

const TOKEN_KEY = "flashcards:github-pat";

/** PAT を localStorage（永続）または sessionStorage（セッション限定）から読む */
export function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveToken(token: string, persist: boolean): void {
  const value = token.trim();
  try {
    if (persist) {
      localStorage.setItem(TOKEN_KEY, value);
      sessionStorage.removeItem(TOKEN_KEY);
    } else {
      sessionStorage.setItem(TOKEN_KEY, value);
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // ストレージが使えない環境ではトークンを保持しない
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // 何もしない
  }
}

const MOTION_KEY = "flashcards:motion";

export type MotionPreference = "full" | "crossfade";

/** アニメーション設定。OS の視差効果設定は参照せず、アプリ内設定のみで制御する */
export function loadMotionPreference(): MotionPreference {
  try {
    return localStorage.getItem(MOTION_KEY) === "crossfade" ? "crossfade" : "full";
  } catch {
    return "full";
  }
}

export function saveMotionPreference(value: MotionPreference): void {
  try {
    localStorage.setItem(MOTION_KEY, value);
  } catch {
    // 保存できなくても既定（full）で動く
  }
}

const LAST_BACKUP_KEY = "flashcards:last-backup-at";

export function loadLastBackupAt(): number | null {
  try {
    const value = localStorage.getItem(LAST_BACKUP_KEY);
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLastBackupAt(value: number): void {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, String(value));
  } catch {
    // 記録できなくても致命的ではない
  }
}

const AUTO_CLOUD_BACKUP_KEY = "flashcards:cloud-backup-auto";
const LAST_CLOUD_BACKUP_KEY = "flashcards:last-cloud-backup-at";
const LAST_CLOUD_BACKUP_ATTEMPT_KEY = "flashcards:last-cloud-backup-attempt-at";
const CLOUD_BACKUP_ERROR_KEY = "flashcards:cloud-backup-last-error";

/** 学習を終えたとき GitHub へ自動で保存するか。既定は有効（トークンが無ければ何もしない） */
export function loadAutoCloudBackup(): boolean {
  try {
    return localStorage.getItem(AUTO_CLOUD_BACKUP_KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveAutoCloudBackup(enabled: boolean): void {
  try {
    localStorage.setItem(AUTO_CLOUD_BACKUP_KEY, enabled ? "on" : "off");
  } catch {
    // 保存できなくても既定（有効）で動く
  }
}

/** GitHub へ最後に保存できた時刻（成功時のみ更新） */
export function loadLastCloudBackupAt(): number | null {
  return loadTimestamp(LAST_CLOUD_BACKUP_KEY);
}

export function saveLastCloudBackupAt(value: number): void {
  saveTimestamp(LAST_CLOUD_BACKUP_KEY, value);
}

/** GitHub へ最後に保存を試みた時刻（失敗でも更新。失敗の連打を抑える） */
export function loadLastCloudBackupAttemptAt(): number | null {
  return loadTimestamp(LAST_CLOUD_BACKUP_ATTEMPT_KEY);
}

export function saveLastCloudBackupAttemptAt(value: number): void {
  saveTimestamp(LAST_CLOUD_BACKUP_ATTEMPT_KEY, value);
}

export interface CloudBackupError {
  at: number;
  message: string;
}

/** 直近の自動バックアップの失敗。成功したら消す */
export function loadCloudBackupError(): CloudBackupError | null {
  try {
    const raw = localStorage.getItem(CLOUD_BACKUP_ERROR_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { at, message } = parsed as Partial<CloudBackupError>;
    return typeof at === "number" && Number.isFinite(at) && typeof message === "string" ? { at, message } : null;
  } catch {
    return null;
  }
}

export function saveCloudBackupError(value: CloudBackupError | null): void {
  try {
    if (value === null) localStorage.removeItem(CLOUD_BACKUP_ERROR_KEY);
    else localStorage.setItem(CLOUD_BACKUP_ERROR_KEY, JSON.stringify(value));
  } catch {
    // 記録できなくても致命的ではない
  }
}

function loadTimestamp(key: string): number | null {
  try {
    const value = localStorage.getItem(key);
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveTimestamp(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // 記録できなくても致命的ではない
  }
}

export function tokenPersistence(): "local" | "session" | "none" {
  try {
    if (sessionStorage.getItem(TOKEN_KEY)) return "session";
    if (localStorage.getItem(TOKEN_KEY)) return "local";
  } catch {
    // fallthrough
  }
  return "none";
}

const SESSION_SIZE_KEY = "flashcards:session-size";

/** 1回の学習で出題する枚数の選択肢 */
export const SESSION_SIZES = [5, 10, 20, 30] as const;
export type SessionSize = (typeof SESSION_SIZES)[number];

const DEFAULT_SESSION_SIZE: SessionSize = 20;

export function loadSessionSize(): SessionSize {
  try {
    const value = Number(localStorage.getItem(SESSION_SIZE_KEY));
    return (SESSION_SIZES as readonly number[]).includes(value) ? (value as SessionSize) : DEFAULT_SESSION_SIZE;
  } catch {
    return DEFAULT_SESSION_SIZE;
  }
}

export function saveSessionSize(value: SessionSize): void {
  try {
    localStorage.setItem(SESSION_SIZE_KEY, String(value));
  } catch {
    // 保存できなくても既定枚数で動く
  }
}

const STUDY_MODE_KEY = "flashcards:study-mode";

export function loadStudyMode(): StudyMode {
  try {
    return localStorage.getItem(STUDY_MODE_KEY) === "buzzer" ? "buzzer" : "normal";
  } catch {
    return "normal";
  }
}

export function saveStudyMode(value: StudyMode): void {
  try {
    localStorage.setItem(STUDY_MODE_KEY, value);
  } catch {
    // 保存できなくても既定（通常）で動く
  }
}

const BUZZER_SPEED_KEY = "flashcards:buzzer-speed";

/** 早押しの読み上げ速度（1文字あたりのミリ秒） */
export const BUZZER_SPEEDS = [
  { ms: 70, label: "速い" },
  { ms: 120, label: "普通" },
  { ms: 180, label: "ゆっくり" },
] as const;

const DEFAULT_BUZZER_SPEED = 120;

export function loadBuzzerSpeed(): number {
  try {
    const value = Number(localStorage.getItem(BUZZER_SPEED_KEY));
    return BUZZER_SPEEDS.some((speed) => speed.ms === value) ? value : DEFAULT_BUZZER_SPEED;
  } catch {
    return DEFAULT_BUZZER_SPEED;
  }
}

export function saveBuzzerSpeed(value: number): void {
  try {
    localStorage.setItem(BUZZER_SPEED_KEY, String(value));
  } catch {
    // 保存できなくても既定速度で動く
  }
}

const RATING_THRESHOLDS_KEY = "flashcards:rating-thresholds";

export function loadRatingThresholds(): RatingThresholds {
  try {
    const raw = localStorage.getItem(RATING_THRESHOLDS_KEY);
    return normalizeRatingThresholds(raw ? (JSON.parse(raw) as Partial<RatingThresholds>) : null);
  } catch {
    return DEFAULT_RATING_THRESHOLDS;
  }
}

export function saveRatingThresholds(value: RatingThresholds): void {
  try {
    localStorage.setItem(RATING_THRESHOLDS_KEY, JSON.stringify(normalizeRatingThresholds(value)));
  } catch {
    // 保存できなくても既定の境界で動く
  }
}

const NEW_CARDS_PER_DAY_KEY = "flashcards:new-cards-per-day";

/** 1日に出す新規カードの上限（0 は無制限） */
export function loadNewCardsPerDay(): number {
  try {
    // 未設定（null）を Number() に通すと 0 =「無制限」になってしまうので先に弾く
    const stored = localStorage.getItem(NEW_CARDS_PER_DAY_KEY);
    if (stored === null) return NEW_CARDS_PER_DAY;
    const value = Number(stored);
    return (NEW_CARDS_PER_DAY_OPTIONS as readonly number[]).includes(value) ? value : NEW_CARDS_PER_DAY;
  } catch {
    return NEW_CARDS_PER_DAY;
  }
}

export function saveNewCardsPerDay(value: number): void {
  try {
    localStorage.setItem(NEW_CARDS_PER_DAY_KEY, String(value));
  } catch {
    // 保存できなくても既定枚数で動く
  }
}

const NEW_CARDS_SCOPE_KEY = "flashcards:new-cards-scope";

/**
 * 新規カードの上限をどの単位で数えるか。既定は「デッキごと」（従来の挙動）。
 * 「全デッキ合計」にすると、先に開いたデッキから枠を使う。
 */
export function loadNewCardsScope(): NewCardsScope {
  try {
    return localStorage.getItem(NEW_CARDS_SCOPE_KEY) === "all" ? "all" : "deck";
  } catch {
    return "deck";
  }
}

export function saveNewCardsScope(value: NewCardsScope): void {
  try {
    localStorage.setItem(NEW_CARDS_SCOPE_KEY, value);
  } catch {
    // 保存できなくてもデッキごとの上限で動く
  }
}

const DECK_SORT_KEY = "flashcards:deck-sort";

/** ホームのデッキ並び替え。既定は最近学習した順 */
export function loadDeckSort(): DeckSort {
  try {
    const stored = localStorage.getItem(DECK_SORT_KEY);
    return DECK_SORTS.some((option) => option.value === stored) ? (stored as DeckSort) : "recent";
  } catch {
    return "recent";
  }
}

export function saveDeckSort(value: DeckSort): void {
  try {
    localStorage.setItem(DECK_SORT_KEY, value);
  } catch {
    // 保存できなくても既定（最近学習した順）で動く
  }
}

const STUDY_ORDER_KEY = "flashcards:study-order";

/** 出題順。既定はランダム（数千問のデッキで先頭ばかり出るのを避けるため） */
export function loadStudyOrder(): StudyOrder {
  try {
    return localStorage.getItem(STUDY_ORDER_KEY) === "sequential" ? "sequential" : "random";
  } catch {
    return "random";
  }
}

export function saveStudyOrder(value: StudyOrder): void {
  try {
    localStorage.setItem(STUDY_ORDER_KEY, value);
  } catch {
    // 保存できなくても既定（ランダム）で動く
  }
}

const STUDY_TAG_PREFIX = "flashcards:study-tag:";

/**
 * 学習で絞り込むタグ。**デッキごとに**覚える
 * （デッキによってタグの体系が違うので、1つを共有すると別デッキで0枚になる）。
 * 空文字・未保存は「全タグ」を意味する null を返す。
 */
export function loadStudyTag(deckId: string): string | null {
  try {
    const stored = localStorage.getItem(STUDY_TAG_PREFIX + deckId);
    return stored === null || stored === "" ? null : stored;
  } catch {
    return null;
  }
}

export function saveStudyTag(deckId: string, tag: string | null): void {
  try {
    if (tag === null || tag === "") localStorage.removeItem(STUDY_TAG_PREFIX + deckId);
    else localStorage.setItem(STUDY_TAG_PREFIX + deckId, tag);
  } catch {
    // 保存できなくても、そのセッションの絞り込みは効く
  }
}

const PENDING_DECK_DELETIONS_KEY = "flashcards:pending-deck-deletions";

/**
 * GitHub からは消したが、端末の後片付けが済んでいないデッキ id。
 *
 * 途中でアプリが落ちると孤児レコードが残り、同じ id で作り直したときに
 * 古い進捗が新しいデッキへ再接続されてしまう（2026-08-28 Codex 指摘）。起動時にやり直すための印。
 */
export function loadPendingDeckDeletions(): string[] {
  try {
    const raw = localStorage.getItem(PENDING_DECK_DELETIONS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function savePendingDeckDeletions(deckIds: string[]): void {
  try {
    if (deckIds.length === 0) localStorage.removeItem(PENDING_DECK_DELETIONS_KEY);
    else localStorage.setItem(PENDING_DECK_DELETIONS_KEY, JSON.stringify(deckIds));
  } catch {
    // 保存できなくても削除自体は続行する（次回の再開ができなくなるだけ）
  }
}

export function addPendingDeckDeletion(deckId: string): void {
  const current = loadPendingDeckDeletions();
  if (!current.includes(deckId)) savePendingDeckDeletions([...current, deckId]);
}

export function removePendingDeckDeletion(deckId: string): void {
  savePendingDeckDeletions(loadPendingDeckDeletions().filter((id) => id !== deckId));
}
