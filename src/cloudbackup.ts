import { exportBackup, gzipBlob, importBackup, parseBackupBytes, type ImportResult } from "./backup";
import { BRANCH, listFileCommits, OWNER, putRepoFile, readRepoFile, statRepoFile, type FileCommit } from "./github";

/**
 * 学習進捗を GitHub の private リポへ保存する（2026-09-04、`docs/decisions/010`）。
 * デッキ用の PAT に、このリポも追加してもらう（Contents: Read and write）。
 */
export const BACKUP_REPOSITORY = "flashcards-progress";
export const BACKUP_PATH = "backups/latest.json.gz";
/** 学習を終えたあと、前回の成功からこれだけ経っていれば自動で送る */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 失敗したあと、次に試すまでの最短間隔（PAT 未設定のまま毎回失敗し続けるのを抑える） */
export const AUTO_BACKUP_RETRY_MS = 6 * 60 * 60 * 1000;
/** 数MB を携帯回線で送ることがあるので、通常の 15 秒より長く待つ */
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_UPLOAD_ATTEMPTS = 3;

export interface AutoBackupState {
  enabled: boolean;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
}

/**
 * いま自動バックアップを走らせるべきか。
 * 記録された時刻が未来（端末の時計を戻した）なら未実施として扱い、永久に止まらないようにする
 */
export function shouldAutoBackup(now: number, state: AutoBackupState): boolean {
  if (!state.enabled) return false;
  const elapsed = (at: number | null) => (at === null || at > now ? Number.POSITIVE_INFINITY : now - at);
  if (elapsed(state.lastSuccessAt) < AUTO_BACKUP_INTERVAL_MS) return false;
  if (elapsed(state.lastAttemptAt) < AUTO_BACKUP_RETRY_MS) return false;
  return true;
}

export interface CloudBackupResult {
  exportedAt: number;
  progressCount: number;
  logCount: number;
  noteCount: number;
  /** 送った gzip のバイト数 */
  bytes: number;
}

// 自動と手動が同時に走ると同じファイルへ二重に PUT する。writeDeck と同じく直列化する
let uploadQueue: Promise<unknown> = Promise.resolve();

/** 進捗を書き出して gzip し、GitHub のバックアップファイルを上書きする */
export function uploadBackup(token: string): Promise<CloudBackupResult> {
  const operation = uploadQueue.then(() => uploadOnce(token));
  uploadQueue = operation.catch(() => undefined);
  return operation;
}

async function uploadOnce(token: string): Promise<CloudBackupResult> {
  const exported = await exportBackup();
  const bytes = await gzipBlob(exported.blob);
  const message = `backup: ${new Date(exported.exportedAt).toISOString()} (進捗 ${exported.progressCount} 件・ログ ${exported.logCount} 件)`;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    // sha が無い（初回）なら新規作成の PUT。リポ自体に届かない場合も null になるが、その場合は PUT が 404 を返す
    const sha = await statRepoFile(BACKUP_REPOSITORY, BACKUP_PATH, token);
    const put = await putRepoFile(BACKUP_REPOSITORY, BACKUP_PATH, token, {
      message,
      bytes,
      ...(sha ? { sha } : {}),
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (put.status === 200 || put.status === 201) {
      return {
        exportedAt: exported.exportedAt,
        progressCount: exported.progressCount,
        logCount: exported.logCount,
        noteCount: exported.noteCount,
        bytes: bytes.length,
      };
    }
    // 409: 他の書き込みと競合。422: sha が古い（無いはずのファイルが出来ていた）。どちらも sha を取り直す
    if (put.status === 409 || put.status === 422) continue;
    throw new Error(describeBackupFailure(put.status, put.message));
  }
  throw new Error("他の更新と競合し続けたため保存を中止しました。時間をおいて再試行してください。");
}

/** バックアップ用リポへの書き込み失敗を、PAT の直し方が分かる文言にする */
export function describeBackupFailure(status: number, message?: string): string {
  if (status === 401) return "トークンが無効です (401)。設定画面で確認してください。";
  if (status === 403) {
    return `書き込みが拒否されました (403)。PAT の ${BACKUP_REPOSITORY} に対する Contents 権限を Read and write にしてください。`;
  }
  if (status === 404) {
    return `バックアップ用リポジトリ ${OWNER}/${BACKUP_REPOSITORY} にアクセスできません (404)。PAT のリポジトリ一覧に追加してください。`;
  }
  return `バックアップの保存に失敗しました (${status}): ${message ?? "不明なエラー"}`;
}

/** 復元できる版の一覧（新しい順）。ファイルがまだ無ければ空 */
export function listCloudBackups(token: string, limit = 10): Promise<FileCommit[]> {
  return listFileCommits(BACKUP_REPOSITORY, BACKUP_PATH, token, limit);
}

export interface CloudRestoreResult {
  result: ImportResult;
  /** 復元したバックアップが書き出された時刻 */
  exportedAt: number;
  bytes: number;
}

/**
 * GitHub のバックアップを取り込む（マージ。端末側が新しい進捗は残る）。
 * `ref` にコミット sha を渡すと、その時点の版を取る（最新が壊れていたときの逃げ道）
 */
export async function restoreFromCloud(token: string, ref = BRANCH): Promise<CloudRestoreResult> {
  const file = await readRepoFile(BACKUP_REPOSITORY, BACKUP_PATH, token, ref);
  if (file === null) {
    throw new Error(`GitHub にバックアップがまだありません（${OWNER}/${BACKUP_REPOSITORY} の ${BACKUP_PATH}）。PAT にリポジトリを追加しているかも確認してください。`);
  }
  const document = await parseBackupBytes(file.bytes);
  const result = await importBackup(document);
  return { result, exportedAt: document.exportedAt, bytes: file.bytes.length };
}
