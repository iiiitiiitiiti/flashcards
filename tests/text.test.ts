import { describe, expect, it } from "vitest";
import { browserUrl, googleSearchUrl, isIosStandalone, splitGraphemes } from "../src/text";

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

describe("googleSearchUrl", () => {
  it("答えをそのまま検索語にし、URL エンコードする", () => {
    expect(googleSearchUrl("東京")).toBe("https://www.google.com/search?q=%E6%9D%B1%E4%BA%AC&noiga=1");
    expect(googleSearchUrl("HyperText Markup Language")).toBe("https://www.google.com/search?q=HyperText%20Markup%20Language&noiga=1");
  });

  it("改行と連続する空白は 1 つに畳み、前後の空白は落とす", () => {
    expect(googleSearchUrl("  ラファエロ\n（ラファエッロ）  ")).toBe(`https://www.google.com/search?q=${encodeURIComponent("ラファエロ （ラファエッロ）")}&noiga=1`);
  });
});

describe("ブラウザのアプリで開く", () => {
  it("選んだブラウザのスキームに差し替える。アプリ内はそのまま", () => {
    const url = "https://www.google.com/search?q=a&noiga=1";
    expect(browserUrl(url, "safari")).toBe("x-safari-https://www.google.com/search?q=a&noiga=1");
    expect(browserUrl(url, "vivaldi")).toBe("vivaldi://www.google.com/search?q=a&noiga=1");
    expect(browserUrl(url, "chrome")).toBe("googlechromes://www.google.com/search?q=a&noiga=1");
    expect(browserUrl(url, "inapp")).toBe(url);
  });

  it("navigator.standalone が true のときだけホーム画面版とみなす", () => {
    expect(isIosStandalone()).toBe(false);
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    try {
      expect(isIosStandalone()).toBe(true);
    } finally {
      delete (navigator as { standalone?: boolean }).standalone;
    }
  });
});
