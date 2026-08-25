import { describe, expect, it } from "vitest";
import { buildPageItems, clampPage } from "../src/pagination";

describe("buildPageItems", () => {
  it("7ページ以下は全ページを並べる", () => {
    expect(buildPageItems(1, 1)).toEqual([1]);
    expect(buildPageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("0ページ（該当なし）では空になる", () => {
    expect(buildPageItems(1, 0)).toEqual([]);
  });

  it("先頭付近では末尾だけを省略する", () => {
    expect(buildPageItems(1, 12)).toEqual([1, 2, 3, 4, null, 12]);
  });

  it("中ほどでは両側を省略する", () => {
    expect(buildPageItems(6, 12)).toEqual([1, null, 5, 6, 7, null, 12]);
  });

  it("末尾付近では先頭だけを省略する", () => {
    expect(buildPageItems(12, 12)).toEqual([1, null, 9, 10, 11, 12]);
  });
});

describe("clampPage", () => {
  it("範囲外のページを 1..count へ収める", () => {
    expect(clampPage(5, 3)).toBe(3);
    expect(clampPage(0, 3)).toBe(1);
    expect(clampPage(2, 3)).toBe(2);
    expect(clampPage(3, 0)).toBe(1);
  });
});
