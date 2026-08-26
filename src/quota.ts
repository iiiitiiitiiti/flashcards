/**
 * 端末の保存容量まわり。デッキだけで約10MB あるため、容量不足は「いつか起きること」として扱う。
 * ここには判定と文言だけを置き、実際の書き込みは db.ts が持つ。
 */

/** 容量不足の例外か。名前がブラウザごとに違うので name で判定する（DOMException 以外も来うる） */
export function isQuotaExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  // Firefox は独自の名前を返す。Safari は QuotaExceededError
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

/**
 * 保存の失敗をユーザー向けの文言にする。
 * 容量不足は「もう一度」では直らないので、他と混ぜずに対処を書く。
 */
export function describeStorageError(error: unknown, action: string): string {
  if (isQuotaExceeded(error)) {
    return `${action}できませんでした。端末の保存容量が足りません。設定の「保存容量」を確認し、使わないデッキの進捗を削除するか、端末の空きを増やしてからお試しください。`;
  }
  return `${action}できませんでした。もう一度お試しください。`;
}

/**
 * 保存領域を「永続」にするようブラウザへ申請する。
 * 申請していないと、端末の空きが減ったときにブラウザの判断でデータごと消される
 * （学習進捗はこの端末にしか無いので、消えると復旧できない）。
 * 非対応の環境では何もしない。
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number;
  /** ブラウザが「永続」として扱っているか（false だと空き容量次第で消されうる） */
  persisted: boolean;
}

export async function estimateStorage(): Promise<StorageUsage | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return {
      usedBytes: usage ?? 0,
      quotaBytes: quota ?? 0,
      persisted: navigator.storage.persisted ? await navigator.storage.persisted() : false,
    };
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
