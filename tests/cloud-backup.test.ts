import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipBlob, isGzip, parseBackupBytes } from "../src/backup";
import {
  AUTO_BACKUP_INTERVAL_MS,
  AUTO_BACKUP_RETRY_MS,
  BACKUP_PATH,
  BACKUP_REPOSITORY,
  describeBackupFailure,
  listCloudBackups,
  restoreFromCloud,
  shouldAutoBackup,
  uploadBackup,
} from "../src/cloudbackup";
import { readAllProgress, resetDbForTest, saveReview } from "../src/db";
import { encodeBase64Bytes } from "../src/github";
import { dayKey, rate } from "../src/srs";
import type { ProgressRecord, ReviewLogEntry } from "../src/types";

const NOW = new Date("2026-09-04T03:00:00Z");
const HOUR = 60 * 60 * 1000;

function makeRecord(cardId: string, updatedAt: number): ProgressRecord {
  return { deckId: "deck", cardId, progress: rate(null, 3, NOW), introducedDayKey: dayKey(NOW), updatedAt };
}

function makeLog(reviewId: string, cardId = "001"): ReviewLogEntry {
  return { reviewId, deckId: "deck", cardId, rating: 3, reviewedAt: NOW.getTime() };
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** GitHub API のスタブ。ハンドラが Response を返す。呼び出しは calls に残す */
function stubGitHub(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status });
}

async function gzipJson(value: unknown): Promise<Uint8Array> {
  return gzipBlob(new Blob([JSON.stringify(value)]));
}

const contentsUrl = `/repos/iiiitiiitiiti/${BACKUP_REPOSITORY}/contents/${BACKUP_PATH}`;

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldAutoBackup", () => {
  const now = NOW.getTime();

  it("無効なら常に false", () => {
    expect(shouldAutoBackup(now, { enabled: false, lastSuccessAt: null, lastAttemptAt: null })).toBe(false);
  });

  it("未実施なら true", () => {
    expect(shouldAutoBackup(now, { enabled: true, lastSuccessAt: null, lastAttemptAt: null })).toBe(true);
  });

  it("前回の成功から 24 時間未満なら false、24 時間で true", () => {
    expect(shouldAutoBackup(now, { enabled: true, lastSuccessAt: now - AUTO_BACKUP_INTERVAL_MS + 1, lastAttemptAt: null })).toBe(false);
    expect(shouldAutoBackup(now, { enabled: true, lastSuccessAt: now - AUTO_BACKUP_INTERVAL_MS, lastAttemptAt: null })).toBe(true);
  });

  it("失敗した直後は再試行間隔（6 時間）を空ける", () => {
    const failedRecently = { enabled: true, lastSuccessAt: null, lastAttemptAt: now - HOUR };
    expect(shouldAutoBackup(now, failedRecently)).toBe(false);
    expect(shouldAutoBackup(now, { ...failedRecently, lastAttemptAt: now - AUTO_BACKUP_RETRY_MS })).toBe(true);
  });

  it("記録が未来（時計を戻した）なら未実施として扱い、止まらない", () => {
    expect(shouldAutoBackup(now, { enabled: true, lastSuccessAt: now + HOUR, lastAttemptAt: now + HOUR })).toBe(true);
  });
});

describe("gzipBlob / parseBackupBytes", () => {
  it("gzip したバイト列を魔法数で見分けて復元し、検証を通す", async () => {
    const document = { schemaVersion: 1, exportedAt: 5, cardProgress: [makeRecord("001", 10)], reviewLog: [makeLog("r1")] };
    const bytes = await gzipJson(document);
    expect(isGzip(bytes)).toBe(true);
    const parsed = await parseBackupBytes(bytes);
    expect(parsed.exportedAt).toBe(5);
    expect(parsed.cardProgress).toHaveLength(1);
  });

  it("素の JSON（手動書き出し）も同じ関数で読める", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, exportedAt: 1, cardProgress: [], reviewLog: [] }));
    expect(isGzip(bytes)).toBe(false);
    await expect(parseBackupBytes(bytes)).resolves.toMatchObject({ exportedAt: 1 });
  });

  it("壊れた JSON は検証前に分かる文言で失敗する", async () => {
    await expect(parseBackupBytes(new TextEncoder().encode("{oops"))).rejects.toThrow("JSON を読み取れません");
  });
});

describe("uploadBackup", () => {
  it("初回はファイルが無いので sha を付けずに PUT し、gzip した本文を送る", async () => {
    await saveReview(makeRecord("001", 100), makeLog("r1"));
    const calls = stubGitHub((call) => {
      if (call.method === "GET") return json(404, { message: "Not Found" });
      return json(201, { content: { sha: "new" } });
    });
    const result = await uploadBackup("token");
    expect(result.progressCount).toBe(1);
    expect(result.logCount).toBe(1);

    const put = calls.find((call) => call.method === "PUT");
    expect(put?.url).toContain(contentsUrl);
    expect(put?.body).not.toHaveProperty("sha");
    expect(put?.body?.branch).toBe("main");
    expect(String(put?.body?.message)).toMatch(/^backup: 20\d\d-.*進捗 1 件・ログ 1 件/);
    const sent = Uint8Array.from(atob(String(put?.body?.content)), (character) => character.charCodeAt(0));
    expect(isGzip(sent)).toBe(true);
    expect(result.bytes).toBe(sent.length);
    const roundTrip = await parseBackupBytes(sent);
    expect(roundTrip.cardProgress[0]?.cardId).toBe("001");
  });

  it("2回目以降は GET で得た sha を付けて上書きする", async () => {
    const calls = stubGitHub((call) => {
      if (call.method === "GET") return json(200, { sha: "old-sha", encoding: "none", content: "", size: 2_000_000 });
      return json(200, { content: { sha: "new" } });
    });
    await uploadBackup("token");
    const put = calls.find((call) => call.method === "PUT");
    expect(put?.body?.sha).toBe("old-sha");
    // 1MB 超でも sha だけ欲しいので Blob API は呼ばない
    expect(calls.some((call) => call.url.includes("/git/blobs/"))).toBe(false);
  });

  it("409 / 422 なら sha を取り直して再試行する", async () => {
    let generation = 0;
    const shas: (unknown | undefined)[] = [];
    stubGitHub((call) => {
      if (call.method === "GET") {
        generation += 1;
        return json(200, { sha: `sha-${generation}`, encoding: "base64", content: "" });
      }
      shas.push(call.body?.sha);
      if (shas.length === 1) return json(409, { message: "conflict" });
      if (shas.length === 2) return json(422, { message: "sha mismatch" });
      return json(200, { content: {} });
    });
    await uploadBackup("token");
    expect(shas).toEqual(["sha-1", "sha-2", "sha-3"]);
  });

  it("PAT にリポが無い（404）ときは追加を促す文言で失敗する", async () => {
    stubGitHub((call) => json(404, { message: "Not Found" }));
    await expect(uploadBackup("token")).rejects.toThrow(/flashcards-progress にアクセスできません \(404\)。PAT のリポジトリ一覧に追加/);
  });

  it("Contents 権限が無い（403）ときは権限の直し方を書く", async () => {
    stubGitHub((call) => (call.method === "GET" ? json(404, {}) : json(403, { message: "Resource not accessible" })));
    await expect(uploadBackup("token")).rejects.toThrow(/Contents 権限を Read and write/);
  });

  it("手動と自動が同時に走っても PUT は直列になる", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    stubGitHub(async (call) => {
      if (call.method === "GET") return json(404, {});
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return json(201, { content: {} });
    });
    await Promise.all([uploadBackup("token"), uploadBackup("token")]);
    expect(maxInFlight).toBe(1);
  });
});

describe("describeBackupFailure", () => {
  it("401 / 403 / 404 / その他で文言が分かれる", () => {
    expect(describeBackupFailure(401)).toMatch(/401/);
    expect(describeBackupFailure(403)).toMatch(/Read and write/);
    expect(describeBackupFailure(404)).toMatch(/リポジトリ一覧に追加/);
    expect(describeBackupFailure(500, "boom")).toBe("バックアップの保存に失敗しました (500): boom");
  });
});

describe("restoreFromCloud", () => {
  it("gzip のバックアップを取り込み、端末側が新しい進捗は残す", async () => {
    await saveReview(makeRecord("001", 500), makeLog("local-1"));
    const remote = {
      schemaVersion: 1,
      exportedAt: 777,
      cardProgress: [makeRecord("001", 100), makeRecord("002", 100)],
      reviewLog: [makeLog("local-1"), makeLog("remote-1", "002")],
    };
    const bytes = await gzipJson(remote);
    stubGitHub((call) => {
      expect(call.url).toContain(`${contentsUrl}?ref=main`);
      return json(200, { sha: "s", encoding: "base64", content: encodeBase64Bytes(bytes) });
    });
    const restored = await restoreFromCloud("token");
    expect(restored.exportedAt).toBe(777);
    expect(restored.result).toMatchObject({ progressImported: 1, progressSkipped: 1, logsImported: 1 });
    const progress = await readAllProgress();
    expect(progress.find((record) => record.cardId === "001")?.updatedAt).toBe(500);
  });

  it("1MB 超（encoding none）は Blob API で本文を取る。ref を渡すと過去の版を取る", async () => {
    const bytes = await gzipJson({ schemaVersion: 1, exportedAt: 9, cardProgress: [], reviewLog: [] });
    const calls = stubGitHub((call) => {
      if (call.url.includes("/git/blobs/big-sha")) {
        // Blob API の base64 は改行入り
        const wrapped = encodeBase64Bytes(bytes).replace(/(.{60})/g, "$1\n");
        return json(200, { sha: "big-sha", encoding: "base64", content: wrapped });
      }
      return json(200, { sha: "big-sha", encoding: "none", content: "" });
    });
    const restored = await restoreFromCloud("token", "abc123");
    expect(restored.exportedAt).toBe(9);
    expect(calls[0]?.url).toContain("?ref=abc123");
    expect(calls[1]?.url).toContain("/git/blobs/big-sha");
  });

  it("ファイルが無ければ、まだバックアップが無い旨で失敗し、何も書かない", async () => {
    stubGitHub(() => json(404, {}));
    await expect(restoreFromCloud("token")).rejects.toThrow("GitHub にバックアップがまだありません");
    expect(await readAllProgress()).toHaveLength(0);
  });

  it("壊れたバックアップは取り込まない", async () => {
    const bytes = await gzipJson({ schemaVersion: 2 });
    stubGitHub(() => json(200, { sha: "s", encoding: "base64", content: encodeBase64Bytes(bytes) }));
    await expect(restoreFromCloud("token")).rejects.toThrow("schemaVersion");
  });
});

describe("listCloudBackups", () => {
  it("ファイルの履歴を新しい順に返す", async () => {
    const calls = stubGitHub(() =>
      json(200, [
        { sha: "c2", commit: { message: "backup: 2", committer: { date: "2026-09-04T00:00:00Z" } } },
        { sha: "c1", commit: { message: "backup: 1", committer: { date: "2026-09-03T00:00:00Z" } } },
      ]),
    );
    const commits = await listCloudBackups("token", 5);
    expect(commits.map((commit) => commit.sha)).toEqual(["c2", "c1"]);
    expect(commits[0]?.date).toBe("2026-09-04T00:00:00Z");
    expect(calls[0]?.url).toContain(`/commits?path=${encodeURIComponent(BACKUP_PATH)}&sha=main&per_page=5`);
  });

  it("リポにアクセスできない（404）なら例外", async () => {
    stubGitHub(() => json(404, { message: "Not Found" }));
    await expect(listCloudBackups("token")).rejects.toThrow(/404/);
  });
});
