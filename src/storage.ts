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

export function tokenPersistence(): "local" | "session" | "none" {
  try {
    if (sessionStorage.getItem(TOKEN_KEY)) return "session";
    if (localStorage.getItem(TOKEN_KEY)) return "local";
  } catch {
    // fallthrough
  }
  return "none";
}
