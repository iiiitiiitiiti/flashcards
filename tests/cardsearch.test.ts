import { describe, expect, it } from "vitest";
import { buildSearchIndex, isSearchable, normalizeSearchText, searchCards, SEARCH_LIMIT } from "../src/cardsearch";
import type { Deck } from "../src/deck";

function deck(id: string, cards: { id: string; front: string; back: string; note?: string }[], name = id): Deck {
  return { schemaVersion: 1, id, name, cards };
}

const DECKS = [
  deck("chiri", [
    { id: "001", front: "日本の首都はどこ？", back: "東京" },
    { id: "002", front: "フランスの首都は？", back: "パリ", note: "セーヌ川が流れる" },
  ], "地理"),
  deck("it", [
    { id: "001", front: "ＨＴＭＬの正式名称は？", back: "HyperText Markup Language" },
    { id: "002", front: "ｽﾏﾌｫの OS で Apple 製は？", back: "iOS" },
  ], "IT"),
  deck("sports", [{ id: "001", front: "すもうの最高位は？", back: "横綱" }], "スポーツ"),
];

describe("normalizeSearchText", () => {
  it("全角英数・半角カナを NFKC で揃え、小文字にする", () => {
    expect(normalizeSearchText("ＡＢＣ ｱｲｳ")).toBe("abc アイウ");
    expect(normalizeSearchText("  HyperText  ")).toBe("hypertext");
  });
});

describe("searchCards", () => {
  const index = buildSearchIndex(DECKS);

  it("問題・答え・補足のどれかに含まれるカードを、デッキ順 → カード順で返す", () => {
    const result = searchCards(index, "首都");
    expect(result.total).toBe(2);
    expect(result.hits.map((hit) => `${hit.deckId}/${hit.card.id}`)).toEqual(["chiri/001", "chiri/002"]);
    expect(result.hits[0].deckName).toBe("地理");
    expect(searchCards(index, "セーヌ").hits.map((hit) => hit.card.id)).toEqual(["002"]);
    expect(searchCards(index, "パリ").total).toBe(1);
  });

  it("全角・半角・大文字小文字の違いを越えて当たる。ひらがなとカタカナは別", () => {
    expect(searchCards(index, "html").total).toBe(1);
    expect(searchCards(index, "ｈｔｍｌ").total).toBe(1);
    expect(searchCards(index, "スマフォ").total).toBe(1);
    expect(searchCards(index, "hypertext").hits[0].card.id).toBe("001");
    expect(searchCards(index, "すもう").total).toBe(1);
    expect(searchCards(index, "スモウ").total).toBe(0);
  });

  it("空白で区切ると全部含むカードだけ（AND）。問題と答えをまたいでもよい", () => {
    expect(searchCards(index, "日本 首都").total).toBe(1);
    expect(searchCards(index, "首都 パリ").hits.map((hit) => hit.card.id)).toEqual(["002"]);
    expect(searchCards(index, "首都　東京").total).toBe(1);
    expect(searchCards(index, "首都 横綱").total).toBe(0);
  });

  it("2 文字未満・空白だけは検索しない", () => {
    expect(searchCards(index, "首")).toEqual({ hits: [], total: 0 });
    expect(searchCards(index, "   ")).toEqual({ hits: [], total: 0 });
    expect(searchCards(index, " 首都 ").total).toBe(2);
    expect(isSearchable("首")).toBe(false);
    expect(isSearchable("首 都")).toBe(true);
  });

  it("上限を超えたぶんは件数だけ数え、並びは崩れない", () => {
    const many = deck("many", Array.from({ length: SEARCH_LIMIT + 7 }, (_, i) => ({ id: String(i), front: `問題${i}`, back: "答え" })));
    const result = searchCards(buildSearchIndex([many]), "問題");
    expect(result.total).toBe(SEARCH_LIMIT + 7);
    expect(result.hits).toHaveLength(SEARCH_LIMIT);
    expect(searchCards(buildSearchIndex([many]), "問題", 3).hits.map((hit) => hit.card.id)).toEqual(["0", "1", "2"]);
  });

  it("該当なしは空。デッキが無ければ索引も空", () => {
    expect(searchCards(index, "存在しない語")).toEqual({ hits: [], total: 0 });
    expect(buildSearchIndex([])).toEqual([]);
  });
});
