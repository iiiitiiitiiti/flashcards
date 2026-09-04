import { beforeEach, describe, expect, it } from "vitest";

// vitest の既定環境（node）には localStorage が無いので最小限の実装を置く
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});
import { loadNewCardsPerDay, loadNewCardsScope, loadSessionSize, loadStudyOrder, loadStudyTag, saveNewCardsPerDay, saveNewCardsScope, saveStudyOrder, saveStudyTag } from "../src/storage";
import { NEW_CARDS_PER_DAY } from "../src/srs";

describe("loadNewCardsPerDay", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("未設定なら既定枚数を返す（0＝無制限に化けない）", () => {
    expect(loadNewCardsPerDay()).toBe(NEW_CARDS_PER_DAY);
  });

  it("保存した選択肢をそのまま返す。0（無制限）も保持する", () => {
    saveNewCardsPerDay(50);
    expect(loadNewCardsPerDay()).toBe(50);
    saveNewCardsPerDay(0);
    expect(loadNewCardsPerDay()).toBe(0);
  });

  it("選択肢にない値は既定へ落とす", () => {
    localStorage.setItem("flashcards:new-cards-per-day", "7");
    expect(loadNewCardsPerDay()).toBe(NEW_CARDS_PER_DAY);
    localStorage.setItem("flashcards:new-cards-per-day", "あ");
    expect(loadNewCardsPerDay()).toBe(NEW_CARDS_PER_DAY);
  });

  it("学習枚数も未設定なら既定（20枚）を返す", () => {
    expect(loadSessionSize()).toBe(20);
  });
});

describe("loadStudyOrder", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("未設定ならランダム", () => {
    expect(loadStudyOrder()).toBe("random");
  });

  it("保存した値を返す", () => {
    saveStudyOrder("sequential");
    expect(loadStudyOrder()).toBe("sequential");
    saveStudyOrder("random");
    expect(loadStudyOrder()).toBe("random");
  });

  it("壊れた値はランダムへ落とす", () => {
    localStorage.setItem("flashcards:study-order", "でたらめ");
    expect(loadStudyOrder()).toBe("random");
  });
});

describe("loadStudyTag / saveStudyTag", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("未設定なら null（全タグ）", () => {
    expect(loadStudyTag("quiz-sports")).toBeNull();
  });

  it("デッキごとに別々に覚える", () => {
    saveStudyTag("quiz-sports", "難易度A");
    saveStudyTag("quiz-rikei", "物理");
    expect(loadStudyTag("quiz-sports")).toBe("難易度A");
    expect(loadStudyTag("quiz-rikei")).toBe("物理");
    expect(loadStudyTag("quiz-chiri")).toBeNull();
  });

  it("null と空文字は保存せず消す（全タグへ戻す）", () => {
    saveStudyTag("quiz-sports", "難易度A");
    saveStudyTag("quiz-sports", null);
    expect(loadStudyTag("quiz-sports")).toBeNull();

    saveStudyTag("quiz-sports", "難易度A");
    saveStudyTag("quiz-sports", "");
    expect(loadStudyTag("quiz-sports")).toBeNull();
  });

  it("保存済みの空文字も null として読む", () => {
    localStorage.setItem("flashcards:study-tag:quiz-sports", "");
    expect(loadStudyTag("quiz-sports")).toBeNull();
  });
});

describe("loadNewCardsScope", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("未設定ならデッキごと（従来の挙動）", () => {
    expect(loadNewCardsScope()).toBe("deck");
  });

  it("保存した値を返す", () => {
    saveNewCardsScope("all");
    expect(loadNewCardsScope()).toBe("all");
    saveNewCardsScope("deck");
    expect(loadNewCardsScope()).toBe("deck");
  });

  it("壊れた値はデッキごとへ落とす", () => {
    localStorage.setItem("flashcards:new-cards-scope", "でたらめ");
    expect(loadNewCardsScope()).toBe("deck");
  });
});

describe("自動バックアップの設定", () => {
  beforeEach(() => {
    store.clear();
  });

  it("未設定なら有効。off を保存すると無効、それ以外の壊れた値は有効に戻る", async () => {
    const { loadAutoCloudBackup, saveAutoCloudBackup } = await import("../src/storage");
    expect(loadAutoCloudBackup()).toBe(true);
    saveAutoCloudBackup(false);
    expect(loadAutoCloudBackup()).toBe(false);
    saveAutoCloudBackup(true);
    expect(loadAutoCloudBackup()).toBe(true);
    store.set("flashcards:cloud-backup-auto", "garbage");
    expect(loadAutoCloudBackup()).toBe(true);
  });

  it("成功時刻・試行時刻・直近の失敗を別々に持つ。失敗は null で消える", async () => {
    const storage = await import("../src/storage");
    expect(storage.loadLastCloudBackupAt()).toBeNull();
    storage.saveLastCloudBackupAt(100);
    storage.saveLastCloudBackupAttemptAt(200);
    expect(storage.loadLastCloudBackupAt()).toBe(100);
    expect(storage.loadLastCloudBackupAttemptAt()).toBe(200);
    storage.saveCloudBackupError({ at: 300, message: "だめ" });
    expect(storage.loadCloudBackupError()).toEqual({ at: 300, message: "だめ" });
    storage.saveCloudBackupError(null);
    expect(storage.loadCloudBackupError()).toBeNull();
    store.set("flashcards:cloud-backup-last-error", "{broken");
    expect(storage.loadCloudBackupError()).toBeNull();
  });
});
