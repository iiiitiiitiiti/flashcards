import { validateDeck, type Deck } from "./deck";

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

interface RepositoryMetadata {
  full_name?: string;
  permissions?: { push?: boolean };
}

export interface ConnectionTestResult {
  repository: string;
  writeAccess: "available" | "unavailable" | "unconfirmed";
}

/** PAT の読み取り・書き込み権限を確認する */
export async function testConnection(token: string): Promise<ConnectionTestResult> {
  const response = await apiRequest<RepositoryMetadata>(`/repos/${OWNER}/${REPOSITORY}`, token);
  if (response.status === 401) throw new Error("トークンが無効です (401)。有効期限と値を確認してください。");
  if (response.status === 403) throw new Error("アクセスが拒否されました (403)。トークンの権限を確認してください。");
  if (response.status !== 200) throw new Error(`リポジトリ情報を取得できませんでした (${response.status})`);
  const push = response.data.permissions?.push;
  return {
    repository: response.data.full_name ?? `${OWNER}/${REPOSITORY}`,
    writeAccess: push === true ? "available" : push === false ? "unavailable" : "unconfirmed",
  };
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

interface ContentsResponse {
  content?: string;
  encoding?: string;
  sha?: string;
  message?: string;
}

const MAX_WRITE_ATTEMPTS = 3;

// 書き込みは直列化して自分自身との競合を避ける
let writeQueue: Promise<unknown> = Promise.resolve();

/** Contents API から最新のデッキ本文と blob SHA を取得する（書き込み用） */
async function getDeckContents(deckId: string, token: string): Promise<{ raw: string; sha: string }> {
  const response = await apiRequest<ContentsResponse>(
    `/repos/${OWNER}/${REPOSITORY}/contents/decks/${encodeURIComponent(deckId)}.json?ref=${BRANCH}`,
    token,
  );
  if (response.status !== 200 || !response.data.content || response.data.encoding !== "base64" || !response.data.sha) {
    throw new Error(`デッキ「${deckId}」の最新版を取得できませんでした (${response.status})`);
  }
  return { raw: decodeBase64Utf8(response.data.content), sha: response.data.sha };
}

/**
 * デッキを更新する。最新版へ mutate を適用して PUT し、409 競合時は
 * 再取得 → 再適用 → 再 PUT を最大 3 回まで繰り返す。
 * mutate は「1 操作分の変更」を最新デッキへ適用する冪等な純関数であること。
 */
export function writeDeck(deckId: string, token: string, message: string, mutate: (deck: Deck) => Deck): Promise<Deck> {
  const operation = writeQueue.then(() => writeDeckWithRetry(deckId, token, message, mutate));
  writeQueue = operation.catch(() => undefined);
  return operation;
}

async function writeDeckWithRetry(deckId: string, token: string, message: string, mutate: (deck: Deck) => Deck): Promise<Deck> {
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const latest = await getDeckContents(deckId, token);
    let parsed: Deck;
    try {
      parsed = validateDeck(JSON.parse(latest.raw), deckId);
    } catch {
      throw new Error(`デッキ「${deckId}」の最新版が壊れています。リポジトリ側を先に修正してください。`);
    }
    // 変更後も規約に適合していることを保証してから書き込む
    const next = validateDeck(mutate(parsed), deckId);
    const response = await apiRequest<ContentsResponse>(
      `/repos/${OWNER}/${REPOSITORY}/contents/decks/${encodeURIComponent(deckId)}.json`,
      token,
      {
        method: "PUT",
        body: JSON.stringify({
          message,
          content: encodeBase64Utf8(`${JSON.stringify(next, null, 2)}\n`),
          sha: latest.sha,
          branch: BRANCH,
        }),
      },
    );
    if (response.status === 200 || response.status === 201) return next;
    if (response.status === 401) throw new Error("トークンが無効です (401)。設定画面で確認してください。");
    if (response.status === 403) throw new Error("書き込みが拒否されました (403)。トークンの権限を確認してください。");
    if (response.status !== 409) {
      throw new Error(`デッキの保存に失敗しました (${response.status}): ${response.data.message ?? "不明なエラー"}`);
    }
  }
  throw new Error("他の更新と競合し続けたため保存を中止しました。時間をおいて再試行してください。");
}

export function decodeBase64Utf8(value: string): string {
  const normalized = value.replace(/\s/g, "");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
