import { DEFAULT_RATING_THRESHOLDS, NEW_CARDS_PER_DAY, NEW_CARDS_PER_DAY_OPTIONS, normalizeRatingThresholds } from "./srs";
import type { RatingThresholds, StudyMode } from "./types";

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
    const value = Number(localStorage.getItem(NEW_CARDS_PER_DAY_KEY));
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
