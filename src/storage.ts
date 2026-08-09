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
