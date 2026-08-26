import { describe, expect, it } from "vitest";
import { splitGraphemes } from "../src/text";

describe("splitGraphemes", () => {
  it("日本語と英数字を1文字ずつに切る", () => {
    expect(splitGraphemes("日本一長い川は？")).toHaveLength(8);
    expect(splitGraphemes("PB")).toEqual(["P", "B"]);
  });

  it("空文字は空配列", () => {
    expect(splitGraphemes("")).toEqual([]);
  });

  it("サロゲートペアの絵文字を割らない", () => {
    expect(splitGraphemes("🎌🎌")).toEqual(["🎌", "🎌"]);
  });

  it("ZWJ で結合した絵文字を1文字として扱う", () => {
    expect(splitGraphemes("👨‍👩‍👧‍👦")).toHaveLength(1);
    expect(splitGraphemes("あ👨‍👩‍👧‍👦い")).toEqual(["あ", "👨‍👩‍👧‍👦", "い"]);
  });

  it("結合文字（濁点）を分けない", () => {
    expect(splitGraphemes("が")).toHaveLength(1);
  });
});
