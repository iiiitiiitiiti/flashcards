import { validateDeck, type Deck, type DeckCard } from "./deck";
import { removeCard, upsertCard } from "./deckedit";

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
  tree?: { path?: string; type?: string; sha?: string }[];
  truncated?: boolean;
}

export interface DeckListingEntry {
  deckId: string;
  /** そのファイル自身のハッシュ。中身が変わらなければ別コミットでも同じ値 */
  blobSha: string;
}

export interface DeckListing {
  commitSha: string;
  decks: DeckListingEntry[];
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
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

async function apiRequest<T>(
  endpoint: string,
  token: string | null,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; data: T }> {
  let response: Response;
  let raw: string;
  try {
    response = await fetchWithTimeout(
      `${API_ROOT}${endpoint}`,
      {
        ...init,
        headers: apiHeaders(token, Boolean(init.body)),
      },
      timeoutMs,
    );
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

/**
 * main の最新コミット SHA と decks/*.json の一覧を取得する（API 2リクエスト）。
 * 一覧にはファイルごとの blob SHA を含めるので、中身が変わったデッキだけ取り直せる。
 */
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
  const deckEntries = tree.data.tree.filter(
    (entry) => entry.type === "blob" && typeof entry.path === "string" && /^decks\/[^/]+\.json$/.test(entry.path),
  );
  // sha が欠けたエントリを黙って捨てると、そのデッキが「消えた」と誤判定されてキャッシュからも消える
  if (deckEntries.some((entry) => typeof entry.sha !== "string" || entry.sha === "")) {
    throw new Error("デッキ一覧に不完全な項目が含まれていました");
  }
  const decks = deckEntries
    .map((entry) => ({
      deckId: (entry.path as string).slice("decks/".length, -".json".length),
      blobSha: entry.sha as string,
    }))
    .sort((left, right) => left.deckId.localeCompare(right.deckId, "ja"));
  return { commitSha, decks };
}

interface RepositoryMetadata {
  full_name?: string;
  permissions?: { push?: boolean };
}

export interface ConnectionTestResult {
  repository: string;
  writeAccess: "available" | "unavailable" | "unconfirmed";
}

/**
 * PAT の読み取り・書き込み権限を確認する。`repository` を渡せば別リポ（バックアップ用）も見られる。
 * fine-grained PAT は一覧に無いリポを 404 で返すので、404 は「PAT に追加されていない」として扱う
 */
export async function testConnection(token: string, repository = REPOSITORY): Promise<ConnectionTestResult> {
  const response = await apiRequest<RepositoryMetadata>(`/repos/${OWNER}/${repository}`, token);
  if (response.status === 401) throw new Error("トークンが無効です (401)。有効期限と値を確認してください。");
  if (response.status === 403) throw new Error("アクセスが拒否されました (403)。トークンの権限を確認してください。");
  if (response.status === 404) throw new Error(`リポジトリ ${OWNER}/${repository} にアクセスできません (404)。PAT のリポジトリ一覧に追加してください。`);
  if (response.status !== 200) throw new Error(`リポジトリ情報を取得できませんでした (${response.status})`);
  const push = response.data.permissions?.push;
  return {
    repository: response.data.full_name ?? `${OWNER}/${repository}`,
    writeAccess: push === true ? "available" : push === false ? "unavailable" : "unconfirmed",
  };
}

export interface RepoFile {
  /** base64 を復号した生バイト列（テキストなら `decodeUtf8Bytes` で文字列にする） */
  bytes: Uint8Array;
  sha: string;
}

export interface FileCommit {
  sha: string;
  /** コミット日時（ISO 8601） */
  date: string;
  message: string;
}

async function fetchContents(repository: string, path: string, token: string, ref: string): Promise<{ status: number; data: ContentsResponse } | null> {
  const response = await apiRequest<ContentsResponse>(
    `/repos/${OWNER}/${repository}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`,
    token,
  );
  if (response.status === 404) return null;
  if (response.status !== 200 || !response.data.sha) {
    throw new Error(describeAuthFailure(response.status) ?? `${repository}/${path} を取得できませんでした (${response.status})`);
  }
  return response;
}

/**
 * ファイルの blob sha だけを取る（上書き PUT に付けるため）。無ければ null。
 * 1MB 超のファイルは Contents API が本文を返さないので、本文を落とさずに済む
 */
export async function statRepoFile(repository: string, path: string, token: string, ref = BRANCH): Promise<string | null> {
  const response = await fetchContents(repository, path, token, ref);
  return response?.data.sha ?? null;
}

/** 任意のリポ・パスのファイルを読む（バックアップ用）。無ければ null。1MB 超は Blob API へ迂回する */
export async function readRepoFile(repository: string, path: string, token: string, ref = BRANCH): Promise<RepoFile | null> {
  const response = await fetchContents(repository, path, token, ref);
  if (response === null || !response.data.sha) return null;
  if (response.data.content && response.data.encoding === "base64") {
    return { bytes: decodeBase64Bytes(response.data.content), sha: response.data.sha };
  }
  const blob = await apiRequest<ContentsResponse>(`/repos/${OWNER}/${repository}/git/blobs/${response.data.sha}`, token);
  if (blob.status !== 200 || !blob.data.content || blob.data.encoding !== "base64") {
    throw new Error(`${repository}/${path} の本文を取得できませんでした (${blob.status})`);
  }
  return { bytes: decodeBase64Bytes(blob.data.content), sha: response.data.sha };
}

export interface PutRepoFileOptions {
  message: string;
  bytes: Uint8Array;
  /** 上書きなら現在の blob sha。新規作成なら省略 */
  sha?: string;
  timeoutMs?: number;
}

/**
 * 任意のリポ・パスへファイルを書く（バックアップ用）。status と本文をそのまま返し、
 * 409（競合）・422（sha の食い違い）の再試行は呼び出し側が行う
 */
export async function putRepoFile(
  repository: string,
  path: string,
  token: string,
  options: PutRepoFileOptions,
): Promise<{ status: number; message?: string }> {
  const response = await apiRequest<ContentsResponse>(
    `/repos/${OWNER}/${repository}/contents/${encodeRepoPath(path)}`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({
        message: options.message,
        content: encodeBase64Bytes(options.bytes),
        ...(options.sha ? { sha: options.sha } : {}),
        branch: BRANCH,
      }),
    },
    options.timeoutMs,
  );
  return { status: response.status, message: response.data.message };
}

interface CommitListEntry {
  sha?: string;
  commit?: { message?: string; committer?: { date?: string }; author?: { date?: string } };
}

/** あるファイルを変更したコミットを新しい順に返す（復元する版の一覧に使う） */
export async function listFileCommits(repository: string, path: string, token: string, limit = 10): Promise<FileCommit[]> {
  const response = await apiRequest<CommitListEntry[] | ContentsResponse>(
    `/repos/${OWNER}/${repository}/commits?path=${encodeURIComponent(path)}&sha=${BRANCH}&per_page=${limit}`,
    token,
  );
  if (response.status !== 200 || !Array.isArray(response.data)) {
    throw new Error(describeAuthFailure(response.status) ?? `${repository}/${path} の履歴を取得できませんでした (${response.status})`);
  }
  return response.data
    .filter((entry): entry is CommitListEntry & { sha: string } => typeof entry.sha === "string")
    .map((entry) => ({
      sha: entry.sha,
      date: entry.commit?.committer?.date ?? entry.commit?.author?.date ?? "",
      message: entry.commit?.message ?? "",
    }));
}

/** パスの各セグメントだけをエンコードする（`/` は残す） */
function encodeRepoPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
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
/**
 * Contents API から最新のデッキ本文と blob SHA を取得する（書き込み用）。
 *
 * Contents API は **1MB を超えるファイルの本文を返さない**（`encoding: "none"`・`content: ""`。sha は返す）。
 * その場合は Blob API（`/git/blobs/{sha}`、100MB まで）で本文を取る。PUT 側には 1MB の壁は無く、
 * 2026-09-04 に一時ブランチ `api-probe` で 1.15MB の PUT が成功することを実 API で確認した（`docs/decisions/009`）。
 */
async function getDeckContents(deckId: string, token: string): Promise<{ raw: string; sha: string }> {
  const response = await apiRequest<ContentsResponse>(
    `/repos/${OWNER}/${REPOSITORY}/contents/decks/${encodeURIComponent(deckId)}.json?ref=${BRANCH}`,
    token,
  );
  if (response.status !== 200 || !response.data.sha) {
    throw new Error(`デッキ「${deckId}」の最新版を取得できませんでした (${response.status})`);
  }
  if (response.data.content && response.data.encoding === "base64") {
    return { raw: decodeBase64Utf8(response.data.content), sha: response.data.sha };
  }
  return { raw: await fetchBlob(deckId, response.data.sha, token), sha: response.data.sha };
}

/** Blob API で本文を取る（1MB 超のデッキ用）。base64 は改行入りで返るが decodeBase64Utf8 が空白を落とす */
async function fetchBlob(deckId: string, sha: string, token: string): Promise<string> {
  const response = await apiRequest<ContentsResponse>(`/repos/${OWNER}/${REPOSITORY}/git/blobs/${sha}`, token);
  if (response.status !== 200 || !response.data.content || response.data.encoding !== "base64") {
    throw new Error(`デッキ「${deckId}」の本文を取得できませんでした (${response.status})`);
  }
  return decodeBase64Utf8(response.data.content);
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

/**
 * カードを別デッキへ移す。**先に移動先へ追加し、次に元から削除する。**
 * 途中で落ちても「両方にある」状態で止まり、次の decks:sync が add として拾う（データは失われない）。
 * 逆順だと「どこにも無い」状態が生まれる。id は変えない（進捗の鍵）。
 * 端末側の進捗の移送は呼び出し側が `moveCardLocalData` で行う
 */
export async function moveCardBetweenDecks(fromDeckId: string, toDeckId: string, token: string, card: DeckCard): Promise<{ from: Deck; to: Deck }> {
  if (fromDeckId === toDeckId) throw new Error("同じデッキへは移動できません。");
  const to = await writeDeck(toDeckId, token, `deck(${toDeckId}): move card ${card.id} from ${fromDeckId}`, (latest) => upsertCard(latest, card));
  const from = await writeDeck(fromDeckId, token, `deck(${fromDeckId}): move card ${card.id} to ${toDeckId}`, (latest) => removeCard(latest, card.id));
  return { from, to };
}

/** 書き込み用のパス。デッキ id はそのままファイル名になる */
function deckContentsPath(deckId: string): string {
  return `/repos/${OWNER}/${REPOSITORY}/contents/decks/${encodeURIComponent(deckId)}.json`;
}

/** 認証・権限の失敗を共通の文言にする。該当しなければ null（呼び出し側で扱う） */
function describeAuthFailure(status: number): string | null {
  if (status === 401) return "トークンが無効です (401)。設定画面で確認してください。";
  if (status === 403) return "書き込みが拒否されました (403)。トークンの権限を確認してください。";
  return null;
}

/**
 * デッキを新規作成する。`sha` を渡さない PUT なので、同じファイルが既にあると
 * GitHub が 422 を返す（2026-08-28 に実 API で確認）。画面側の重複チェックを
 * すり抜けた場合の最後の砦になる。
 */
export function createDeck(token: string, deck: Deck): Promise<Deck> {
  const operation = writeQueue.then(() => createDeckOnce(token, deck));
  writeQueue = operation.catch(() => undefined);
  return operation;
}

async function createDeckOnce(token: string, deck: Deck): Promise<Deck> {
  // id・name の形式チェックはここで一度だけ行う（画面側の検証とは独立させる）
  const next = validateDeck(deck, deck.id);
  const response = await apiRequest<ContentsResponse>(deckContentsPath(next.id), token, {
    method: "PUT",
    body: JSON.stringify({
      message: `deck(${next.id}): create`,
      content: encodeBase64Utf8(`${JSON.stringify(next, null, 2)}\n`),
      branch: BRANCH,
    }),
  });
  if (response.status === 201 || response.status === 200) return next;
  if (response.status === 422) throw new Error(`デッキ「${next.id}」は既にあります。別の id にしてください。`);
  const auth = describeAuthFailure(response.status);
  if (auth) throw new Error(auth);
  throw new Error(`デッキの作成に失敗しました (${response.status}): ${response.data.message ?? "不明なエラー"}`);
}

/**
 * デッキのファイルを削除する。**すでに無い（404）ときは成功として扱う。**
 * GitHub 側だけ消えて端末の後片付けが失敗したとき、もう一度削除を押せば
 * 後片付けだけをやり直せるようにするため（`docs/decisions/006` 参照）。
 */
export function deleteDeck(deckId: string, token: string): Promise<void> {
  const operation = writeQueue.then(() => deleteDeckOnce(deckId, token));
  writeQueue = operation.catch(() => undefined);
  return operation;
}

/**
 * 404 を「すでに消えている」と断じてよいか確かめる。
 *
 * GitHub は**権限が足りないときも 404 を返す**（存在を漏らさないため）。確かめずに削除済みと
 * 決めつけると、GitHub にデッキが残ったまま端末の進捗だけ消えて戻せなくなる。
 * リポジトリ自体が見えて書き込めるなら、無いのはファイルの方だと言える。
 */
async function assertDeckReallyMissing(deckId: string, token: string): Promise<void> {
  let access: ConnectionTestResult;
  try {
    access = await testConnection(token);
  } catch (error) {
    throw new Error(
      `デッキ「${deckId}」が見つかりませんでしたが、すでに削除済みかを確認できませんでした: ${error instanceof Error ? error.message : "不明なエラー"}`,
    );
  }
  if (access.writeAccess === "unavailable") {
    throw new Error(`デッキ「${deckId}」が見つかりませんでした。トークンに書き込み権限がないため、削除済みかを判断できません。`);
  }
}

async function deleteDeckOnce(deckId: string, token: string): Promise<void> {
  const found = await apiRequest<ContentsResponse>(`${deckContentsPath(deckId)}?ref=${BRANCH}`, token);
  if (found.status === 404) {
    await assertDeckReallyMissing(deckId, token);
    return;
  }
  if (found.status !== 200 || !found.data.sha) {
    throw new Error(describeAuthFailure(found.status) ?? `デッキ「${deckId}」の最新版を取得できませんでした (${found.status})`);
  }
  const response = await apiRequest<ContentsResponse>(deckContentsPath(deckId), token, {
    method: "DELETE",
    body: JSON.stringify({ message: `deck(${deckId}): delete`, sha: found.data.sha, branch: BRANCH }),
  });
  if (response.status === 200) return;
  // 取得と削除の間に他から消されていても結果は同じだが、権限起因の 404 と区別してから返す
  if (response.status === 404) {
    await assertDeckReallyMissing(deckId, token);
    return;
  }
  const auth = describeAuthFailure(response.status);
  if (auth) throw new Error(auth);
  throw new Error(`デッキの削除に失敗しました (${response.status}): ${response.data.message ?? "不明なエラー"}`);
}

export function decodeBase64Utf8(value: string): string {
  return decodeUtf8Bytes(decodeBase64Bytes(value));
}

export function encodeBase64Utf8(value: string): string {
  return encodeBase64Bytes(new TextEncoder().encode(value));
}

/** base64（改行入りでも可）をバイト列にする */
export function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** バイト列を base64 にする。数MB でも呼び出しスタックを溢れさせないよう分割して文字列化する */
export function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function decodeUtf8Bytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
