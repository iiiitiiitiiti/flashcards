import { describe, expect, it } from "vitest";
import { describeStorageError, formatBytes, isQuotaExceeded } from "../src/quota";

describe("isQuotaExceeded", () => {
  it("ブラウザごとの容量不足エラーを見分ける", () => {
    expect(isQuotaExceeded(Object.assign(new Error("full"), { name: "QuotaExceededError" }))).toBe(true);
    expect(isQuotaExceeded(Object.assign(new Error("full"), { name: "NS_ERROR_DOM_QUOTA_REACHED" }))).toBe(true);
  });

  it("それ以外の失敗は容量不足とみなさない", () => {
    expect(isQuotaExceeded(new TypeError("network"))).toBe(false);
    expect(isQuotaExceeded("QuotaExceededError")).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
    expect(isQuotaExceeded(undefined)).toBe(false);
  });
});

describe("describeStorageError", () => {
  it("容量不足のときだけ対処を案内する", () => {
    const quota = describeStorageError(Object.assign(new Error(""), { name: "QuotaExceededError" }), "進捗を保存");
    expect(quota).toContain("進捗を保存できませんでした");
    expect(quota).toContain("保存容量が足りません");

    const other = describeStorageError(new Error("boom"), "進捗を保存");
    expect(other).toBe("進捗を保存できませんでした。もう一度お試しください。");
  });
});

describe("formatBytes", () => {
  it("単位を繰り上げて読みやすくする", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});
