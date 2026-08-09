const API_ROOT = "https://api.github.com";
const RAW_ROOT = "https://raw.githubusercontent.com";
export const OWNER = "iiiitiiitiiti";
export const REPOSITORY = "flashcards";
export const BRANCH = "main";
const REQUEST_TIMEOUT_MS = 15_000;

interface CommitResponse {
  sha?: string;
  commit?: { tree?: { sha?: string } };
}

interface TreeResponse {
  tree?: { path?: string; type?: string }[];
  truncated?: boolean;
}

export interface DeckListing {
  commitSha: string;
  deckIds: string[];
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

function apiHeaders(token: string | null, body = false): Headers {
  const headers = new Headers();
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body) headers.set("Content-Type", "application/json");
  return headers;
}

async function apiRequest<T>(endpoint: string, token: string | null, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  let response: Response;
  let raw: string;
  try {
    response = await fetchWithTimeout(`${API_ROOT}${endpoint}`, {
      ...init,
      headers: apiHeaders(token, Boolean(init.body)),
    });
    raw = await response.text();
  } catch {
    throw new Error("GitHub に接続できませんでした。通信環境を確認してください。");
  }
  let data: T;
  try {
    data = JSON.parse(raw) as T;
  } catch {
    throw new Error(`GitHub API が JSON を返しませんでした (${response.status})`);
  }
  return { status: response.status, data };
}

/** main の最新コミット SHA と decks/*.json の一覧を取得する（API 2リクエスト） */
export async function listDecks(token: string | null): Promise<DeckListing> {
  const commit = await apiRequest<CommitResponse>(`/repos/${OWNER}/${REPOSITORY}/commits/${BRANCH}`, token);
  const commitSha = commit.data.sha;
  const treeSha = commit.data.commit?.tree?.sha;
  if (commit.status !== 200 || !commitSha || !treeSha) {
    throw new Error(`最新コミットを取得できませんでした (${commit.status})`);
  }
  const tree = await apiRequest<TreeResponse>(`/repos/${OWNER}/${REPOSITORY}/git/trees/${treeSha}?recursive=1`, token);
  if (tree.status !== 200 || !tree.data.tree) {
    throw new Error(`デッキ一覧を取得できませんでした (${tree.status})`);
  }
  if (tree.data.truncated) {
    throw new Error("リポジトリのツリーが大きすぎるため、デッキ一覧を取得できませんでした");
  }
  const deckIds = tree.data.tree
    .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && /^decks\/[^/]+\.json$/.test(entry.path))
    .map((entry) => (entry.path as string).slice("decks/".length, -".json".length))
    .sort((left, right) => left.localeCompare(right, "ja"));
  return { commitSha, deckIds };
}

/** コミット固定 raw URL からデッキ JSON の生テキストを取得する（レート制限なし） */
export async function fetchDeckRaw(commitSha: string, deckId: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchWithTimeout(`${RAW_ROOT}/${OWNER}/${REPOSITORY}/${commitSha}/decks/${encodeURIComponent(deckId)}.json`);
  } catch {
    throw new Error(`デッキ「${deckId}」を取得できませんでした。通信環境を確認してください。`);
  }
  if (!response.ok) {
    throw new Error(`デッキ「${deckId}」を取得できませんでした (${response.status})`);
  }
  return response.text();
}
