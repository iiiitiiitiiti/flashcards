import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDeck } from "../src/deck";

function baseDeck(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "test-deck",
    name: "テスト",
    cards: [
      { id: "001", front: "問1", back: "答1" },
      { id: "002", front: "問2", back: "答2", note: "メモ", tags: ["タグ"] },
    ],
  };
}

describe("validateDeck", () => {
  it("正常なデッキを受理する", () => {
    const deck = validateDeck(baseDeck(), "test-deck");
    expect(deck.cards).toHaveLength(2);
  });

  it("カード0件のデッキも受理する", () => {
    expect(validateDeck({ ...baseDeck(), cards: [] }).cards).toHaveLength(0);
  });

  it("オブジェクトでない値を拒否する", () => {
    expect(() => validateDeck(null)).toThrow("オブジェクトではありません");
    expect(() => validateDeck([])).toThrow("オブジェクトではありません");
    expect(() => validateDeck("deck")).toThrow("オブジェクトではありません");
  });

  it("schemaVersion が 1 以外なら拒否する", () => {
    expect(() => validateDeck({ ...baseDeck(), schemaVersion: 2 })).toThrow("schemaVersion");
    expect(() => validateDeck({ ...baseDeck(), schemaVersion: undefined })).toThrow("schemaVersion");
  });

  it("id がファイル名と一致しないと拒否する", () => {
    expect(() => validateDeck(baseDeck(), "other")).toThrow("一致しません");
  });

  it("id に使用不可の文字があれば拒否する", () => {
    expect(() => validateDeck({ ...baseDeck(), id: "日本語" })).toThrow("id は");
    expect(() => validateDeck({ ...baseDeck(), id: "a/b" })).toThrow("id は");
    expect(() => validateDeck({ ...baseDeck(), id: "" })).toThrow("id は");
  });

  it("name が空なら拒否する", () => {
    expect(() => validateDeck({ ...baseDeck(), name: " " })).toThrow("name");
    expect(() => validateDeck({ ...baseDeck(), name: 1 })).toThrow("name");
  });

  it("カード id の重複を拒否する", () => {
    const deck = baseDeck();
    (deck.cards as Record<string, unknown>[])[1].id = "001";
    expect(() => validateDeck(deck)).toThrow("重複");
  });

  it("front / back の欠落・空文字を拒否する", () => {
    const missingFront = baseDeck();
    delete (missingFront.cards as Record<string, unknown>[])[0].front;
    expect(() => validateDeck(missingFront)).toThrow("front");

    const emptyBack = baseDeck();
    (emptyBack.cards as Record<string, unknown>[])[0].back = "";
    expect(() => validateDeck(emptyBack)).toThrow("back");
  });

  it("tags に空文字があれば拒否する", () => {
    const deck = baseDeck();
    (deck.cards as Record<string, unknown>[])[0].tags = ["ok", ""];
    expect(() => validateDeck(deck)).toThrow("tags");
  });

  it("絵文字・全角を含む front/back を受理する", () => {
    const deck = baseDeck();
    (deck.cards as Record<string, unknown>[])[0].front = "🍣の漢字は？";
    (deck.cards as Record<string, unknown>[])[0].back = "鮨（鮓・寿司）";
    expect(() => validateDeck(deck)).not.toThrow();
  });
});

describe("decks/", () => {
  it("リポジトリ内の全デッキが規約に適合する", async () => {
    const decksDir = join(import.meta.dirname, "..", "decks");
    const files = (await readdir(decksDir)).filter((name) => name.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw = await readFile(join(decksDir, file), "utf8");
      expect(() => validateDeck(JSON.parse(raw), basename(file, ".json")), file).not.toThrow();
    }
  });
});
